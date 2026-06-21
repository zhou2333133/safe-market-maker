import type { AppConfig } from '../config/schema.js';
import type { Balance, Market, OpenOrder, Orderbook, Position, VenueName } from '../domain/types.js';
import { capitalUsage } from '../risk/capital-risk.js';
import { evaluateMarketGuard } from '../risk/market-guard.js';
import { rejectReason } from '../risk/reject-reasons.js';
import type { SignerProvider } from '../secrets/signer.js';
import type { StateStore } from '../store/sqlite.js';
import { expectedOutcomeCount, hasCompleteOutcomeSet, isPairedEntryMode, marketGroupKey, pairedPositionGroups } from '../strategy/paired-inventory.js';
import { discoverRoutableMarkets } from '../strategy/market-discovery.js';
import { rankMarketRoutes, selectMarketRoutes } from '../strategy/market-router.js';
import { StrategyEngine } from '../strategy/strategy-engine.js';
import type { VenueAdapter } from '../venues/types.js';
import { ExecutionRecorder } from './event-recorder.js';

export interface SplitEntryInput {
  venue: VenueName;
  signer: SignerProvider;
  signerAddress: string;
  markets: Market[];
  books: Map<string, Orderbook>;
  balances: Balance[];
  positions: Position[];
  openOrders: OpenOrder[];
}

export interface SplitEntryResult {
  attempted: boolean;
  submitted: boolean;
  positions: Position[];
}

export class SplitEntryService {
  private readonly recorder: ExecutionRecorder;
  private readonly splitSizingStrategy: StrategyEngine;

  constructor(
    private readonly config: AppConfig,
    private readonly adapter: VenueAdapter,
    private readonly store: StateStore
  ) {
    this.recorder = new ExecutionRecorder(store);
    this.splitSizingStrategy = new StrategyEngine({
      ...config,
      strategy: {
        ...config.strategy,
        entryMode: 'cash',
        quoteSide: 'sell',
        pointsOnly: false,
        inventorySkewEnabled: false
      }
    });
  }

  async ensurePairedInventory(input: SplitEntryInput): Promise<SplitEntryResult> {
    if (!isPairedEntryMode(this.config)) return { attempted: false, submitted: false, positions: input.positions };
    if (pairedPositionGroups(this.config, input.markets, input.positions).size > 0) {
      return { attempted: false, submitted: false, positions: input.positions };
    }
    if (!this.adapter.splitPositions) {
      this.recordBlocked(input.venue, '平台适配器没有安全拆分完整套仓能力', 'SPLIT_ENTRY_UNSUPPORTED');
      return { attempted: true, submitted: false, positions: input.positions };
    }
    const plan = this.plan(input);
    if (!plan.ok) {
      this.recordBlocked(input.venue, plan.message, plan.reasonCode);
      return { attempted: true, submitted: false, positions: input.positions };
    }
    if (this.adapter.estimateSplitMergeGas || this.adapter.getNativeGasBalance) {
      const gas = await this.checkSplitGas(input, plan);
      if (!gas) return { attempted: true, submitted: false, positions: input.positions };
      if (!gas.ok) {
        this.store.recordEvent({
          venue: input.venue,
          severity: 'error',
          type: 'split.entry.blocked',
          message: gas.message,
          details: { gas, reject: rejectReason('PREDICT_GAS_BALANCE_LOW', 'split-entry', 'splitting-inventory') }
        });
        return { attempted: true, submitted: false, positions: input.positions };
      }
    }

    this.recorder.stage(input.venue, 'splitting-inventory', '拆分 USDT 为同一市场 YES/NO 完整套仓');
    this.store.recordEvent({
      venue: input.venue,
      severity: 'warn',
      type: 'split.entry.started',
      message: `${plan.market.outcome ?? plan.market.question} · ${plan.amountUsd.toFixed(4)} USD`,
      details: {
        market: publicMarket(plan.market),
        amountUsd: plan.amountUsd,
        targetOrderUsd: this.config.risk.orderSizeUsd,
        fullOrderSharesEstimate: plan.fullOrderSharesEstimate
      }
    });

    const result = await this.adapter.splitPositions({
      market: plan.market,
      conditionId: plan.market.conditionId!,
      amountUsd: plan.amountUsd
    }, input.signer);
    this.store.recordEvent({
      venue: input.venue,
      severity: 'warn',
      type: 'split.entry.submitted',
      message: result.txHash ? `完整套仓拆分交易已提交：${result.txHash}` : '完整套仓拆分交易已提交',
      details: {
        venue: result.venue,
        conditionId: result.conditionId,
        amountUsd: result.amountUsd,
        txHash: result.txHash,
        market: publicMarket(plan.market)
      }
    });

    const positions = await this.adapter.getPositions(input.signerAddress);
    const pairedGroups = pairedPositionGroups(this.config, input.markets, positions);
    const groupKey = marketGroupKey(this.config, plan.market);
    if (!pairedGroups.has(groupKey)) {
      this.store.recordEvent({
        venue: input.venue,
        severity: 'error',
        type: 'split.entry.verify-failed',
        message: '拆分交易后没有同步到完整 YES/NO 套仓，本轮不挂单',
        details: { groupKey, positions }
      });
      return { attempted: true, submitted: true, positions };
    }

    this.store.recordEvent({
      venue: input.venue,
      severity: 'warn',
      type: 'split.entry.verified',
      message: '已确认同一市场两边库存，本轮可进入双边 SELL 挂单',
      details: { groupKey }
    });
    return { attempted: true, submitted: true, positions };
  }

  private plan(input: SplitEntryInput): SplitPlan {
    if (input.venue !== 'predict') return { ok: false, reasonCode: 'SPLIT_ENTRY_UNSUPPORTED', message: '当前只支持 Predict.fun 自动拆分完整套仓；其他平台禁止自动进场。' };
    const candidates = discoverRoutableMarkets(this.config, input.venue, input.markets);
    const routeSelection = selectMarketRoutes(
      this.config,
      input.venue,
      rankMarketRoutes(this.config, input.venue, candidates, input.books, {
        positions: input.positions,
        openOrders: input.openOrders
      })
    );
    const rankedGroupScores = new Map<string, number>();
    routeSelection.candidates.forEach((candidate, index) => {
      if (!candidate.groupKey) return;
      const selectedBonus = routeSelection.selected.some((item) => item.groupKey === candidate.groupKey) ? 1_000_000 : 0;
      const score = selectedBonus + candidate.score - index * 0.0001;
      rankedGroupScores.set(candidate.groupKey, Math.max(rankedGroupScores.get(candidate.groupKey) ?? 0, score));
    });
    const groups = new Map<string, Market[]>();
    for (const market of candidates) {
      const key = splitCandidateGroupKey(market);
      const list = groups.get(key) ?? [];
      list.push(market);
      groups.set(key, list);
    }
    const orderedGroups = [...groups.values()].sort((a, b) => {
      const aKey = a[0] ? marketGroupKey(this.config, a[0]) : '';
      const bKey = b[0] ? marketGroupKey(this.config, b[0]) : '';
      return (rankedGroupScores.get(bKey) ?? 0) - (rankedGroupScores.get(aKey) ?? 0);
    });
    for (const group of orderedGroups) {
      const uniqueTokens = [...new Map(group.map((market) => [market.tokenId, market] as const)).values()];
      if (uniqueTokens.length < 2) continue;
      const priced = uniqueTokens
        .map((market) => {
          const book = input.books.get(market.tokenId);
          const guard = evaluateMarketGuard(this.config, market, book);
          const quote = book ? this.splitSizingStrategy.buildIntents(input.venue, [market], new Map([[market.tokenId, book]]), {
            positions: [{ venue: input.venue, tokenId: market.tokenId, size: Number.MAX_SAFE_INTEGER, notionalUsd: Number.MAX_SAFE_INTEGER }]
          }).find((intent) => intent.side === 'SELL') : undefined;
          return { market, book, guard, quote };
        })
        .filter((item) => item.book && item.guard.ok && item.quote);
      const expectedOutcomes = expectedOutcomeCount(uniqueTokens);
      if (expectedOutcomes === undefined || expectedOutcomes > (this.config.strategy.maxTokensPerMarket ?? 2)) continue;
      if (!hasCompleteOutcomeSet(priced.map((item) => item.market))) continue;
      const fullOrderSharesEstimate = Math.max(...priced.map((item) => item.quote!.size));
      if (!Number.isFinite(fullOrderSharesEstimate) || fullOrderSharesEstimate <= 0) continue;
      const conditionId = completeGroupConditionId(priced.map((item) => item.market));
      const firstPriced = priced[0];
      if (!firstPriced) continue;
      if (!conditionId) {
        return { ok: false, reasonCode: 'SPLIT_ENTRY_CONDITION_MISSING', message: '目标市场两边 conditionId 缺失或不一致，无法安全拆分完整套仓。' };
      }
      const usage = capitalUsage(this.config, input.balances, input.openOrders);
      if (!usage.driftOk) return { ok: false, reasonCode: 'RESERVE_DRIFT_TOO_LARGE', message: usage.driftMessage };
      const platformMinimumSplitUsd = 1;
      const requestedSplitUsd = Math.max(this.config.risk.orderSizeUsd, platformMinimumSplitUsd);
      const amountUsd = roundUsd(Math.min(requestedSplitUsd, usage.spendableUsd, this.config.risk.maxPositionUsd));
      if (!Number.isFinite(amountUsd) || amountUsd < 1) {
        return { ok: false, reasonCode: 'SPLIT_ENTRY_BALANCE_INSUFFICIENT', message: `Predict 官方拆分最低按 $1.00 处理，当前可用资金 $${usage.spendableUsd.toFixed(2)} 或持仓上限不足。` };
      }
      return { ok: true, market: { ...firstPriced.market, conditionId }, amountUsd, fullOrderSharesEstimate };
    }
    return { ok: false, reasonCode: 'SPLIT_ENTRY_NO_SAFE_PAIR', message: '没有找到同时具备两个 outcome、盘口安全且可拆分的目标市场。' };
  }

  private recordBlocked(venue: VenueName, message: string, reasonCode: string): void {
    this.store.recordEvent({
      venue,
      severity: 'warn',
      type: 'split.entry.blocked',
      message,
      details: { reject: rejectReason(reasonCode, 'split-entry', 'splitting-inventory') }
    });
  }

  private async checkSplitGas(input: SplitEntryInput, plan: Extract<SplitPlan, { ok: true }>) {
    try {
      return this.adapter.estimateSplitMergeGas
        ? await this.adapter.estimateSplitMergeGas(input.signer, {
          action: 'split',
          market: plan.market,
          conditionId: plan.market.conditionId!,
          amountUsd: plan.amountUsd
        })
        : await this.adapter.getNativeGasBalance!(input.signer);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.recordEvent({
        venue: input.venue,
        severity: 'warn',
        type: 'split.entry.blocked',
        message: `split/merge gas 检查暂不可用，本轮不发起 split：${message}`,
        details: {
          market: publicMarket(plan.market),
          amountUsd: plan.amountUsd,
          error: message,
          reject: rejectReason('PREDICT_GAS_CHECK_UNAVAILABLE', 'split-entry', 'splitting-inventory')
        }
      });
      return undefined;
    }
  }
}

type SplitPlan =
  | { ok: true; market: Market; amountUsd: number; fullOrderSharesEstimate: number }
  | { ok: false; reasonCode: string; message: string };

function publicMarket(market: Market): Record<string, unknown> {
  return {
    tokenId: market.tokenId,
    marketId: market.marketId,
    conditionId: market.conditionId,
    question: market.question,
    outcome: market.outcome
  };
}

function roundUsd(value: number): number {
  return Number((Number.isFinite(value) ? value : 0).toFixed(6));
}

function completeGroupConditionId(markets: Market[]): string | undefined {
  const ids = markets
    .map((market) => market.conditionId?.trim())
    .filter((value): value is string => Boolean(value));
  if (ids.length !== markets.length) return undefined;
  const unique = new Set(ids);
  return unique.size === 1 ? ids[0] : undefined;
}

function splitCandidateGroupKey(market: Market): string {
  return market.marketId || market.eventId || market.conditionId || market.tokenId;
}
