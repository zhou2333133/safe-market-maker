import type { AppConfig } from '../config/schema.js';
import type { Market, OpenOrder, OrderIntent, Orderbook, Position, VenueName } from '../domain/types.js';
import { rejectReason } from '../risk/reject-reasons.js';
import { httpErrorDetails } from '../observability/http-error.js';
import type { SignerProvider } from '../secrets/signer.js';
import type { StateStore } from '../store/sqlite.js';
import { effectiveOrderbookTick } from '../strategy/rewards/common.js';
import { bestBidAsk } from '../venues/normalize.js';
import type { VenueAdapter } from '../venues/types.js';

const EPSILON = 1e-9;
const CASH_DUST_NOTIONAL_USD = 0.01;
/**
 * After a successful exit submit for a given (venue, tokenId), suppress further exit attempts for this window.
 * This is what prevents the "balance: 0" log noise: when the venue's position API takes ~5-15s to reflect that
 * the exit cleared the position, the next cycle's fill-circuit-breaker would otherwise re-fire and submit a
 * duplicate SELL that the venue rightly rejects (no shares to sell). 30s is long enough to bridge data-api lag,
 * short enough that a real new fill on the same token gets exited promptly.
 */
const RECENT_EXIT_SUPPRESS_MS = 30_000;

export interface CashFillExitResult {
  attempted: boolean;
  submitted: number;
  blocked: number;
  failed: number;
}

export interface CashFillExitInput {
  venue: VenueName;
  signer: SignerProvider;
  positions: Position[];
  openOrders: OpenOrder[];
  markets: Market[];
  /** Force a reduce-only exit regardless of cashOnFillAction (used by the principal-loss kill switch). */
  force?: boolean;
}

export class CashFillExitService {
  /**
   * In-process idempotency cache: maps `${venue}:${tokenId}` to the timestamp of the most recent successful
   * exit submission. Read at the top of `process()` to suppress duplicate exits within RECENT_EXIT_SUPPRESS_MS.
   * Restart loses the cache, which is fine — a fresh process will see fresh positions from REST and the brief
   * window for a true duplicate is essentially nil right after startup.
   */
  private readonly recentExitSubmittedAt = new Map<string, number>();

  constructor(
    private readonly config: AppConfig,
    private readonly adapter: VenueAdapter,
    private readonly store: StateStore
  ) {}

  private exitCacheKey(venue: VenueName, tokenId: string): string {
    return `${venue}:${tokenId}`;
  }

  private isExitRecentlySubmitted(venue: VenueName, tokenId: string): boolean {
    const ts = this.recentExitSubmittedAt.get(this.exitCacheKey(venue, tokenId));
    if (!ts) return false;
    return Date.now() - ts < RECENT_EXIT_SUPPRESS_MS;
  }

  private markExitSubmitted(venue: VenueName, tokenId: string): void {
    this.recentExitSubmittedAt.set(this.exitCacheKey(venue, tokenId), Date.now());
  }

  async process(input: CashFillExitInput): Promise<CashFillExitResult> {
    if (!input.force && !shouldCashExit(this.config, input.venue)) return { attempted: false, submitted: 0, blocked: 0, failed: 0 };
    const positions = cashExitPositions(this.config, input.positions, input.venue);
    if (positions.length === 0) return { attempted: false, submitted: 0, blocked: 0, failed: 0 };
    if (!this.adapter.createMarketableOrder) {
      this.store.recordEvent({
        venue: input.venue,
        severity: 'error',
        type: 'cash-fill.exit-unsupported',
        message: '当前平台没有现金单边 taker 退出能力，已撤受管挂单并保持持仓保护',
        details: { reject: rejectReason('CASH_EXIT_UNSUPPORTED', 'liquidation', 'cash-fill-exit') }
      });
      return { attempted: true, submitted: 0, blocked: positions.length, failed: 0 };
    }

    const marketByToken = new Map(input.markets.map((market) => [market.tokenId, market] as const));
    let submitted = 0;
    let blocked = 0;
    let failed = 0;
    for (const position of positions) {
      // Idempotency guard: if we successfully submitted an exit for this token within the last
      // RECENT_EXIT_SUPPRESS_MS, the venue's position API is just slow to reflect that the position cleared.
      // Skipping the second submit prevents the "balance: 0" failure log noise and avoids accidentally
      // double-trading should the venue's pre-validation lag mistakenly accept the duplicate.
      if (this.isExitRecentlySubmitted(input.venue, position.tokenId)) {
        blocked += 1;
        this.store.recordEvent({
          venue: input.venue,
          severity: 'info',
          type: 'cash-fill.exit-skipped-duplicate',
          message: `现金单边平仓已在 ${Math.round(RECENT_EXIT_SUPPRESS_MS / 1000)}s 内提交过(等 venue 同步持仓),跳过重复提交`,
          details: { position: publicPosition(position), suppressWindowMs: RECENT_EXIT_SUPPRESS_MS }
        });
        continue;
      }
      const market = position.market ?? marketByToken.get(position.tokenId);
      if (!market) {
        blocked += 1;
        this.store.recordEvent({
          venue: input.venue,
          severity: 'warn',
          type: 'cash-fill.exit-blocked',
          message: '现金单边持仓缺少市场元数据，暂不退出',
          details: { position: publicPosition(position), reject: rejectReason('CASH_EXIT_MARKET_MISSING', 'liquidation', 'cash-fill-exit') }
        });
        continue;
      }

      let book: Orderbook;
      try {
        book = await this.adapter.getOrderbook(position.tokenId);
      } catch (error) {
        failed += 1;
        const message = error instanceof Error ? error.message : String(error);
        this.store.recordEvent({
          venue: input.venue,
          severity: 'warn',
          type: 'cash-fill.exit-blocked',
          message: `现金单边退出读取盘口失败：${message}`,
          details: { position: publicPosition(position), error: message, reject: rejectReason('ORDERBOOK_UNAVAILABLE', 'orderbook', 'cash-fill-exit') }
        });
        continue;
      }

      const plan = cashExitPlan(this.config, position, market, book, input.force === true);
      if (!plan.ok) {
        blocked += 1;
        this.store.recordEvent({
          venue: input.venue,
          severity: 'warn',
          type: 'cash-fill.exit-blocked',
          message: plan.reason,
          details: { position: publicPosition(position), market: publicMarket(market), book: publicBookTop(book), reject: plan.reject }
        });
        continue;
      }

      try {
        const result = await this.adapter.createMarketableOrder(plan.intent, input.signer);
        submitted += 1;
        this.markExitSubmitted(input.venue, position.tokenId);
        this.store.recordOrderResult(result);
        this.store.recordEvent({
          venue: input.venue,
          severity: 'warn',
          type: 'cash-fill.exit-submitted',
          message: `现金单边止损退出已提交：${result.externalId ?? result.clientOrderId}`,
          details: {
            result,
            intent: publicIntent(plan.intent),
            position: publicPosition(position),
            averagePrice: plan.averagePrice,
            limitPrice: plan.limitPrice,
            maxLossPct: this.config.strategy.cashMaxExitLossPct
          }
        });
      } catch (error) {
        failed += 1;
        const message = error instanceof Error ? error.message : String(error);
        this.store.recordEvent({
          venue: input.venue,
          severity: 'error',
          type: 'cash-fill.exit-failed',
          message,
          details: {
            position: publicPosition(position),
            intent: publicIntent(plan.intent),
            ...httpErrorDetails(error),
            reject: rejectReason('CASH_EXIT_FAILED', 'platform', 'cash-fill-exit')
          }
        });
      }
    }

    return { attempted: true, submitted, blocked, failed };
  }
}

type CashExitPlan =
  | {
      ok: true;
      intent: OrderIntent;
      averagePrice: number;
      limitPrice: number;
    }
  | {
      ok: false;
      reason: string;
      reject: ReturnType<typeof rejectReason>;
    };

export function cashExitPlan(
  config: AppConfig,
  position: Position,
  market: Market,
  book: Orderbook,
  force = false
): CashExitPlan {
  const best = bestBidAsk(book);
  if (best.bestBid === undefined) {
    return {
      ok: false,
      reason: '现金单边退出缺少买盘，暂不扫单',
      reject: rejectReason('MARKET_MISSING_BBO', 'market', 'cash-fill-exit')
    };
  }
  const averagePrice = cashExitAveragePrice(position);
  if (force) {
    const limitPrice = forcedExitLimitPrice(config, market, best.bestBid);
    const sellableSize = depthAtOrAbove(book, limitPrice);
    const size = Number(Math.min(position.size, sellableSize).toFixed(4));
    if (!Number.isFinite(size) || size <= EPSILON) {
      return {
        ok: false,
        reason: `账户总止损强制退出在 ${limitPrice.toFixed(4)} 以上没有足够买盘`,
        reject: rejectReason('CASH_EXIT_DEPTH_UNAVAILABLE', 'liquidation', 'cash-fill-exit')
      };
    }
    const effectiveAveragePrice = Number.isFinite(averagePrice) && averagePrice > EPSILON ? averagePrice : best.bestBid;
    return {
      ok: true,
      intent: {
        venue: market.venue,
        market,
        tokenId: position.tokenId,
        side: 'SELL',
        price: limitPrice,
        size,
        notionalUsd: Number((size * limitPrice).toFixed(4)),
        postOnly: false,
        liquidity: 'taker',
        reduceOnly: true,
        reason: 'account-hard-stop-force-exit',
        clientOrderId: `${market.venue}-${position.tokenId}-hard-stop-exit-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
      },
      averagePrice: effectiveAveragePrice,
      limitPrice
    };
  }
  if (!Number.isFinite(averagePrice) || averagePrice <= EPSILON) {
    return {
      ok: false,
      reason: '现金单边持仓缺少有效成交均价，不能计算 30% 止损底线',
      reject: rejectReason('CASH_EXIT_AVERAGE_PRICE_MISSING', 'liquidation', 'cash-fill-exit')
    };
  }
  const maxLossPct = Math.max(0, Math.min(100, config.strategy.cashMaxExitLossPct ?? 30));
  const limitPrice = clampLossFloorToTick(averagePrice * (1 - maxLossPct / 100), effectiveOrderbookTick(market, book));
  if (best.bestBid + EPSILON < limitPrice) {
    return {
      ok: false,
      reason: `现金单边退出被止损线拦截：买一 ${best.bestBid.toFixed(4)} 低于最低可接受 ${limitPrice.toFixed(4)}`,
      reject: rejectReason('CASH_EXIT_LOSS_CAP_BLOCKED', 'liquidation', 'cash-fill-exit')
    };
  }
  const sellableSize = depthAtOrAbove(book, limitPrice);
  const size = Number(Math.min(position.size, sellableSize).toFixed(4));
  if (!Number.isFinite(size) || size <= EPSILON) {
    return {
      ok: false,
      reason: `现金单边退出在 ${limitPrice.toFixed(4)} 以上没有足够买盘`,
      reject: rejectReason('CASH_EXIT_DEPTH_UNAVAILABLE', 'liquidation', 'cash-fill-exit')
    };
  }
  const intent: OrderIntent = {
    venue: market.venue,
    market,
    tokenId: position.tokenId,
    side: 'SELL',
    price: limitPrice,
    size,
    notionalUsd: Number((size * limitPrice).toFixed(4)),
    postOnly: false,
    liquidity: 'taker',
    reduceOnly: true,
    reason: `cash-fill-exit-loss-cap-${maxLossPct}pct`,
    clientOrderId: `${market.venue}-${position.tokenId}-cash-exit-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
  };
  return { ok: true, intent, averagePrice, limitPrice };
}

function shouldCashExit(config: AppConfig, _venue: VenueName): boolean {
  // Venue-agnostic: any cash venue whose adapter can post a reduce-only taker
  // exit (Predict and Polymarket both implement createMarketableOrder). The
  // adapter-capability check in `process` fails closed if it is missing.
  return config.strategy.entryMode === 'cash'
    && config.strategy.cashOnFillAction === 'sellWithinLossCap';
}

function cashExitPositions(config: AppConfig, positions: Position[], venue: VenueName): Position[] {
  return positions
    .filter((position) => position.venue === venue)
    .filter((position) => isMaterialCashPosition(config, position));
}

export function isMaterialCashPosition(config: AppConfig, position: Position): boolean {
  const minSize = Math.max(0, config.strategy.minPositionSizeToLiquidate ?? 0.0001);
  const size = Math.abs(position.size);
  const notional = cashPositionNotionalUsd(position);
  if (notional > CASH_DUST_NOTIONAL_USD) return true;
  if (notional > EPSILON || hasKnownPositionPrice(position)) return false;
  return size > minSize;
}

function cashPositionNotionalUsd(position: Position): number {
  const explicit = Math.abs(Number(position.notionalUsd));
  const averagePrice = cashExitAveragePrice(position);
  const estimated = Number.isFinite(averagePrice) && averagePrice > EPSILON
    ? Math.abs(position.size) * averagePrice
    : 0;
  return Math.max(Number.isFinite(explicit) ? explicit : 0, estimated);
}

function hasKnownPositionPrice(position: Position): boolean {
  return Math.abs(Number(position.notionalUsd)) > EPSILON
    || (Number.isFinite(position.averagePrice) && position.averagePrice !== undefined && position.averagePrice > EPSILON);
}

function cashExitAveragePrice(position: Position): number {
  if (Number.isFinite(position.averagePrice) && position.averagePrice !== undefined && position.averagePrice > 0) return position.averagePrice;
  if (position.size > EPSILON && position.notionalUsd > EPSILON) return position.notionalUsd / position.size;
  return Number.NaN;
}

function depthAtOrAbove(book: Orderbook, limitPrice: number): number {
  return book.bids
    .filter((level) => level.price + EPSILON >= limitPrice)
    .reduce((sum, level) => sum + Math.max(0, level.size), 0);
}

function clampLossFloorToTick(price: number, tickSize: number): number {
  const tick = Number.isFinite(tickSize) && tickSize > 0 ? tickSize : 0.01;
  const ticks = Math.ceil((price - EPSILON) / tick);
  return Number(Math.max(tick, Math.min(1 - tick, ticks * tick)).toFixed(6));
}

function forcedExitLimitPrice(config: AppConfig, market: Market, bestBid: number): number {
  const tick = Number.isFinite(market.tickSize) && market.tickSize > 0 ? market.tickSize : 0.01;
  const tickSlippage = Math.max(0, config.strategy.liquidationSlippageTicks ?? 2) * tick;
  const maxSlippage = Math.max(0, config.strategy.liquidationMaxSlippageCents ?? 10) / 100;
  const slippage = Math.min(tickSlippage, maxSlippage);
  const ticks = Math.floor((bestBid - slippage + EPSILON) / tick);
  return Number(Math.max(tick, Math.min(1 - tick, ticks * tick)).toFixed(6));
}

function publicPosition(position: Position): Record<string, unknown> {
  return {
    tokenId: position.tokenId,
    size: position.size,
    notionalUsd: position.notionalUsd,
    averagePrice: position.averagePrice,
    marketId: position.marketId,
    outcome: position.outcome
  };
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

function publicBookTop(book: Orderbook): Record<string, unknown> {
  const best = bestBidAsk(book);
  return {
    tokenId: book.tokenId,
    bestBid: best.bestBid,
    bestAsk: best.bestAsk,
    receivedAt: book.receivedAt
  };
}

function publicIntent(intent: OrderIntent): Record<string, unknown> {
  return {
    tokenId: intent.tokenId,
    side: intent.side,
    price: intent.price,
    size: intent.size,
    notionalUsd: intent.notionalUsd,
    postOnly: intent.postOnly,
    liquidity: intent.liquidity,
    reduceOnly: intent.reduceOnly,
    reason: intent.reason,
    clientOrderId: intent.clientOrderId
  };
}
