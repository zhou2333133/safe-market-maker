import type { AppConfig } from '../config/schema.js';
import type { Market, NativeGasBalance, OpenOrder, Position, VenueName } from '../domain/types.js';
import { rejectReason } from '../risk/reject-reasons.js';
import type { SignerProvider } from '../secrets/signer.js';
import type { StateStore } from '../store/sqlite.js';
import { completeSetInventoryGroups } from '../strategy/paired-inventory.js';
import type { VenueAdapter } from '../venues/types.js';
import { cancelSemantics } from './cancel-semantics.js';

const EPSILON = 1e-9;

export interface LiquidationResult {
  attempted: boolean;
  submitted: number;
  failed?: number;
}

export interface LiquidationInput {
  venue: VenueName;
  signer: SignerProvider;
  positions: Position[];
  openOrders: OpenOrder[];
  markets: Market[];
  refreshMarkets?: () => Promise<Market[]>;
  forceMergeCompleteSets?: boolean;
  keepGroupKeys?: string[];
  reason?: 'fill-exit' | 'route-switch';
}

export class LiquidationService {
  constructor(
    private readonly config: AppConfig,
    private readonly adapter: VenueAdapter,
    private readonly store: StateStore
  ) {}

  async process(input: LiquidationInput): Promise<LiquidationResult> {
    const heldPositions = input.positions.filter((position) => (
      position.size >= (this.config.strategy.minPositionSizeToLiquidate ?? 0.0001)
    ));
    if (heldPositions.length === 0) return { attempted: false, submitted: 0 };

    const forced = input.forceMergeCompleteSets === true;
    const reason = input.reason ?? (forced ? 'route-switch' : 'fill-exit');
    if (!forced && this.config.strategy.onFillAction !== 'sellAllAtMarket') {
      return { attempted: false, submitted: 0 };
    }

    if (input.venue !== 'predict' || !this.adapter.mergePositions) {
      this.store.recordEvent({
        venue: input.venue,
        severity: 'error',
        type: 'fill.merge-unsupported',
        message: '当前平台没有完整套仓合并退出能力；不会用市价卖出替代',
        details: {
          onFillAction: this.config.strategy.onFillAction,
          reject: rejectReason('MERGE_EXIT_UNSUPPORTED', 'liquidation', 'liquidation')
        }
      });
      return { attempted: true, submitted: 0 };
    }

    let markets = input.markets;
    const marketsByToken = new Map(markets.map((market) => [market.tokenId, market] as const));
    const missingMarket = heldPositions.some((position) => !marketsByToken.has(position.tokenId));
    if (missingMarket) markets = input.refreshMarkets ? await input.refreshMarkets() : await this.adapter.getMarkets();

    const keepGroupKeys = new Set(input.keepGroupKeys ?? []);
    const groups = completeSetInventoryGroups(this.config, markets, heldPositions)
      .filter((group) => !keepGroupKeys.has(group.key));
    if (groups.length === 0) {
      if (forced) return { attempted: false, submitted: 0 };
      this.store.recordEvent({
        venue: input.venue,
        severity: 'warn',
        type: 'fill.merge-not-ready',
        message: '检测到持仓，但没有等量完整 YES/NO 套仓；不会市价卖出，等待人工处理或下一轮同步',
        details: {
          positions: heldPositions,
          reject: rejectReason('MERGE_EXIT_INCOMPLETE_SET', 'liquidation', 'liquidation')
        }
      });
      return { attempted: true, submitted: 0 };
    }

    let submitted = 0;
    let failed = 0;
    for (const group of groups) {
      const conditionId = completeGroupConditionId(group.markets);
      const market = group.markets[0];
      if (!market || !conditionId) {
        this.store.recordEvent({
          venue: input.venue,
          severity: 'error',
          type: 'fill.merge-condition-missing',
          message: group.key,
          details: {
            markets: group.markets.map(publicMarket),
            reject: rejectReason('MERGE_EXIT_CONDITION_MISSING', 'liquidation', 'liquidation')
          }
        });
        continue;
      }
      const amountUsd = Number(group.mergeableShares.toFixed(6));
      if (!Number.isFinite(amountUsd) || amountUsd <= EPSILON) continue;
      const gas = await this.checkMergeGas(input, market, conditionId, amountUsd, group.key);
      if (gas === 'unavailable') {
        failed += 1;
        continue;
      }
      if (gas && !gas.ok) {
        failed += 1;
        this.store.recordEvent({
          venue: input.venue,
          severity: 'error',
          type: 'fill.merge-blocked',
          message: gas.message,
          details: {
            reason,
            gas,
            groupKey: group.key,
            markets: group.markets.map(publicMarket),
            reject: rejectReason('PREDICT_GAS_BALANCE_LOW', 'liquidation', 'merge-exit')
          }
        });
        continue;
      }
      await this.cancelGroupOpenOrders(input.venue, input.openOrders, group.markets);
      try {
        const result = await this.adapter.mergePositions({
          market: { ...market, conditionId },
          conditionId,
          amountUsd
        }, input.signer);
        submitted += 1;
        this.store.recordEvent({
          venue: input.venue,
          severity: 'warn',
          type: 'fill.merge-submitted',
          message: result.txHash ? `完整套仓合并交易已提交：${result.txHash}` : '完整套仓合并交易已提交',
          details: {
            reason,
            venue: result.venue,
            conditionId: result.conditionId,
            amountUsd: result.amountUsd,
            txHash: result.txHash,
            groupKey: group.key,
            markets: group.markets.map(publicMarket)
          }
        });
      } catch (error) {
        failed += 1;
        const message = error instanceof Error ? error.message : String(error);
        this.store.recordEvent({
          venue: input.venue,
          severity: 'error',
          type: 'fill.merge-failed',
          message,
          details: {
            reason,
            conditionId,
            amountUsd,
            groupKey: group.key,
            markets: group.markets.map(publicMarket),
            reject: rejectReason('MERGE_EXIT_FAILED', 'liquidation', 'merge-exit')
          }
        });
      }
    }

    return failed > 0 ? { attempted: true, submitted, failed } : { attempted: true, submitted };
  }

  private async checkMergeGas(
    input: LiquidationInput,
    market: Market,
    conditionId: string,
    amountUsd: number,
    groupKey: string
  ): Promise<NativeGasBalance | 'unavailable' | undefined> {
    try {
      if (this.adapter.estimateSplitMergeGas) {
        return await this.adapter.estimateSplitMergeGas(input.signer, {
          action: 'merge',
          market,
          conditionId,
          amountUsd
        });
      }
      if (this.adapter.getNativeGasBalance) return await this.adapter.getNativeGasBalance(input.signer);
      return undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.recordEvent({
        venue: input.venue,
        severity: 'warn',
        type: 'fill.merge-blocked',
        message: `split/merge gas 检查暂不可用，本轮不发起 merge：${message}`,
        details: {
          reason: input.reason ?? (input.forceMergeCompleteSets ? 'route-switch' : 'fill-exit'),
          error: message,
          conditionId,
          amountUsd,
          groupKey,
          market: publicMarket(market),
          reject: rejectReason('PREDICT_GAS_CHECK_UNAVAILABLE', 'liquidation', 'merge-exit')
        }
      });
      return 'unavailable';
    }
  }

  private async cancelGroupOpenOrders(venue: VenueName, openOrders: OpenOrder[], markets: Market[]): Promise<void> {
    const tokenIds = new Set(markets.map((market) => market.tokenId));
    const cancelIds = [...new Set(openOrders
      .filter((order) => tokenIds.has(order.tokenId))
      .map((order) => order.externalId)
      .filter(Boolean))];
    if (cancelIds.length === 0) return;

    await this.adapter.cancelOrders(cancelIds);
    this.store.markOrdersCanceled(venue, cancelIds);
    this.store.recordEvent({
      venue,
      severity: 'warn',
      type: 'fill.cancel-before-merge',
      message: `${cancelIds.length} orders`,
      details: { cancelIds, semantics: cancelSemantics(venue) }
    });
  }
}

function completeGroupConditionId(markets: Market[]): string | undefined {
  const ids = markets
    .map((market) => market.conditionId?.trim())
    .filter((value): value is string => Boolean(value));
  if (ids.length !== markets.length) return undefined;
  const unique = new Set(ids);
  return unique.size === 1 ? ids[0] : undefined;
}

function publicMarket(market: Market): Record<string, unknown> {
  return {
    tokenId: market.tokenId,
    marketId: market.marketId,
    conditionId: market.conditionId,
    question: market.question,
    outcome: market.outcome
  };
}
