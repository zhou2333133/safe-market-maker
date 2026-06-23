import type { AppConfig } from '../config/schema.js';
import type { Market, OpenOrder, OrderIntent, Orderbook, VenueName } from '../domain/types.js';
import { evaluateMarketGuard } from '../risk/market-guard.js';
import type { StateStore } from '../store/sqlite.js';
import type { MarketRouteCandidate } from '../strategy/market-router.js';
import { isPairedEntryMode, marketGroupKey } from '../strategy/paired-inventory.js';
import { frontProtectionDepthUsd } from '../strategy/rewards/common.js';
import { StrategyEngine } from '../strategy/strategy-engine.js';
import type { VenueAdapter } from '../venues/types.js';
import { cancelSemantics } from './cancel-semantics.js';

export interface CancelReplaceableOrdersResult {
  openOrders: OpenOrder[];
  canceledIds: string[];
  /** Token ids whose orders were cancelled this cycle — used to defer the replace-race re-place on small wallets. */
  canceledTokenIds?: string[];
}

export interface CancelReplaceableOrdersOptions {
  requireFreshReplacementForObsoleteCashOrders?: boolean;
  /**
   * Fast quote-refresh ticks set this: keep replace/re-pin cancels (a desired intent exists) but DEFER the
   * "market no longer matches filters / no target quote" exit-cancels to the next full cycle. At fast cadence a
   * one-tick filter flicker (e.g. spread momentarily widening) would otherwise cancel a healthy resting order and
   * lose its queue position; the full cycle re-evaluates the same condition at the original, slower cadence.
   */
  deferObsoleteCancels?: boolean;
}

const CASH_EMPTY_ROUTE_PRESERVE_MIN_MARKETS = 2;
const CASH_PROTECTED_ORDER_STALE_STRIKES_TO_CANCEL = 2;
const CASH_PROTECTED_ORDER_STALE_GRACE_MS = 15_000;
// Fast-tick replace debounce: a 1-tick target drift must be re-proposed (same target price) on a second tick inside
// this window before the resting order is cancel/replaced — one-tick book flicker at the fast cadence would otherwise
// churn the order and forfeit its queue position. Drifts of >= 2 ticks are treated as real moves and replace at once.
const FAST_REPLACE_CONFIRM_WINDOW_MS = 5_000;
const FAST_REPLACE_URGENT_DRIFT_TICKS = 2;
// GTD dead-man switch: refresh (re-place with a fresh expiry) an order once it is within this many seconds of its
// expiry, so resting orders never lapse during normal operation while still auto-cancelling if the bot/network dies.
const GTD_REFRESH_BUFFER_SEC = 25;

interface CashMaintenanceStaleEntry {
  orderId: string;
  tokenId: string;
  strikes: number;
  firstSeenAt: string;
  lastSeenAt: string;
  reason: 'stale-book' | 'missing-book';
  ageMs?: number;
}

export class CancelService {
  private readonly strategy: StrategyEngine;

  constructor(
    private readonly config: AppConfig,
    private readonly adapter: VenueAdapter,
    private readonly store: StateStore
  ) {
    this.strategy = new StrategyEngine(config);
  }

  async cancelGuardedOrders(
    venue: VenueName,
    openOrders: OpenOrder[],
    candidates: MarketRouteCandidate[],
    markets: Market[]
  ): Promise<OpenOrder[]> {
    const managedOpenOrders = this.managedOpenOrders(venue, openOrders);
    const marketByToken = new Map(markets.map((market) => [market.tokenId, market] as const));
    const guardByToken = new Map(candidates.map((candidate) => [
      candidate.market.tokenId,
      evaluateMarketGuard(this.config, candidate.market, undefined)
    ] as const));
    const ids: string[] = [];
    const reasons: Array<{ orderId: string; tokenId: string; reason: string }> = [];
    for (const order of managedOpenOrders) {
      const market = marketByToken.get(order.tokenId);
      const guard = guardByToken.get(order.tokenId) ?? (market ? evaluateMarketGuard(this.config, market, undefined) : undefined);
      if (!guard?.cancelOpenOrders) continue;
      ids.push(order.externalId);
      reasons.push({ orderId: order.externalId, tokenId: order.tokenId, reason: guard.message });
    }
    const uniqueIds = [...new Set(ids.filter(Boolean))];
    if (uniqueIds.length === 0) return openOrders;
    await this.adapter.cancelOrders(uniqueIds);
    this.store.markOrdersCanceled(venue, uniqueIds);
    this.store.recordEvent({
      venue,
      severity: 'warn',
      type: 'risk.market-guard.cancel',
      message: `临近结算/结束风险触发撤单：${uniqueIds.length} 个订单`,
      details: { ids: uniqueIds, reasons, semantics: cancelSemantics(venue) }
    });
    return openOrders.filter((order) => !uniqueIds.includes(order.externalId));
  }

  async cancelReplaceableOrders(
    venue: VenueName,
    openOrders: OpenOrder[],
    intents: OrderIntent[],
    markets: Market[],
    books: Map<string, Orderbook>,
    extraManagedTokens: string[] = [],
    options: CancelReplaceableOrdersOptions = {}
  ): Promise<CancelReplaceableOrdersResult> {
    const managedOpenOrders = this.managedOpenOrders(venue, openOrders);
    const desiredByTokenSide = new Map(intents.map((intent) => [`${intent.tokenId}:${intent.side}`, intent] as const));
    const marketByToken = new Map(markets.map((market) => [market.tokenId, market] as const));
    const preserveEmptyCashRoute = shouldPreserveManagedOrdersOnEmptyCashRoute(this.config, markets, intents, managedOpenOrders);
    if (preserveEmptyCashRoute) {
      const reasons = managedOpenOrders.map((order) => ({
        orderId: order.externalId,
        tokenId: order.tokenId,
        side: order.side,
        reason: '本轮自动路由快照为空，保留现有现金单边订单等待下一轮复检'
      }));
      this.store.recordEvent({
        venue,
        severity: 'warn',
        type: 'quote.replace-deferred',
        message: `自动路由快照为空，保留 ${managedOpenOrders.length} 个现有订单等待下一轮复检`,
        details: { reasons }
      });
      return { openOrders, canceledIds: [] };
    }
    const managedTokens = new Set([
      ...this.config.selectedMarkets[venue],
      ...extraManagedTokens,
      ...markets.map((market) => market.tokenId),
      ...intents.map((intent) => intent.tokenId)
    ]);
    const cancelIds = new Set<string>();
    const cancelReasons: Array<{ orderId: string; tokenId: string; side: string; reason: string }> = [];
    const deferredReasons: Array<{ orderId: string; tokenId: string; side: string; reason: string }> = [];
    const cancelGroups = new Set<string>();
    const marketTokensByGroup = groupTokensByMarket(this.config, markets);
    const maintenanceStaleState = readCashMaintenanceStaleState(this.store.getCheckpoint(cashMaintenanceStaleCheckpointKey(venue))?.value);
    const nextMaintenanceStaleState = new Map<string, CashMaintenanceStaleEntry>();
    const replaceConfirmState = readFastReplaceConfirmState(this.store.getCheckpoint(fastReplaceConfirmCheckpointKey(venue))?.value);
    const nextReplaceConfirmState = new Map<string, FastReplaceConfirmEntry>();
    const now = Date.now();

    for (const order of managedOpenOrders) {
      if (!managedTokens.has(order.tokenId)) continue;
      const desired = desiredByTokenSide.get(`${order.tokenId}:${order.side}`);
      const market = marketByToken.get(order.tokenId);
      const book = books.get(order.tokenId);
      // Fast retreat: re-validate the front cushion on the live (fresh) book; if it eroded below the retreat floor the
      // placement protection has been pulled/swept and we're about to be filled — cancel immediately (fast ticks too).
      const retreat = shouldRetreatThinFront(this.config, venue, order, market, book);
      if (retreat) {
        cancelIds.add(order.externalId);
        // Reason text reflects WHICH protection eroded — front cushion, rear support, or both — so post-hoc forensic
        // review can tell whether the eat-vector was "front pulled" vs "support yanked behind me".
        const reasons: string[] = [];
        if (retreat.floorUsd > 0 && retreat.frontDepthUsd + 1e-9 < retreat.floorUsd) {
          reasons.push(`前方保护深度跌至 $${retreat.frontDepthUsd.toFixed(0)} < 撤退线 $${retreat.floorUsd.toFixed(0)}`);
        }
        if (retreat.supportShortfall) {
          const s = retreat.supportShortfall;
          reasons.push(`后方退出流动性 $${s.exitDepthUsd.toFixed(0)}(${s.windowCents}¢ 窗口内)< $${s.requiredUsd}`);
        }
        cancelReasons.push({
          orderId: order.externalId,
          tokenId: order.tokenId,
          side: order.side,
          reason: `${reasons.join(' + ')}，快撤避免被吃`
        });
        continue;
      }
     if (desired && market && book) {
        // Predict venue: stale books are NOT a cancel trigger. Quiet Predict markets receive no WS push
        // for minutes (no trades = no snapshot), but the last-known book is still valid for checking
        // protection depth. Only treat stale books as a problem on Polymarket (where stale data likely
        // means the order is at risk). Predict cash-protected orders skip the stale-book cancel path
        // and fall through to shouldReplaceOrder which uses whatever book data we have for protection checks.
        const isPredictSkipStaleBook = venue === 'predict' && isCashProtectedBuyOrder(this.config, order, market);
        if (!isPredictSkipStaleBook && isCashProtectedBuyOrder(this.config, order, market) && isStaleBook(this.config, book)) {
         const decision = cashMaintenanceBookUnavailableDecision(
            this.config,
            order,
            { reason: 'stale-book', ageMs: now - book.receivedAt },
            maintenanceStaleState.get(order.externalId),
            now
          );
          if (decision.entry) nextMaintenanceStaleState.set(order.externalId, decision.entry);
          if (decision.cancel) {
            cancelIds.add(order.externalId);
            cancelReasons.push({ orderId: order.externalId, tokenId: order.tokenId, side: order.side, reason: decision.reason });
          } else {
            deferredReasons.push({ orderId: order.externalId, tokenId: order.tokenId, side: order.side, reason: decision.reason });
          }
          continue;
        }
        const decision = this.strategy.shouldReplaceOrder(venue, order, desired, market, book);
       // GTD dead-man refresh: if the order is within GTD_REFRESH_BUFFER_SEC of its expiry, re-place it (fresh expiry)
       // even if it hasn't drifted, so it never lapses during normal operation. order.placedAt comes from the store
       // cache (fast ticks); the refresh bypasses the drift debounce since it's about expiry, not chasing the book.
        // Predict uses predictOrderTtlSec (default 0 = disabled) because Predict REST API has no server-side GTD;
        // Polymarket uses polymarketOrderTtlSec for server-side GTD auto-expiry. 0 means no virtual GTD refresh.
        const gtdTtlSec = Math.trunc(
          venue === 'predict'
            ? this.config.strategy.predictOrderTtlSec ?? 0
            : this.config.strategy.polymarketOrderTtlSec ?? 0
        );
       const effectiveTtlSec = gtdTtlSec > 0 ? Math.max(60, gtdTtlSec) : 0;
       const needsGtdRefresh = effectiveTtlSec > 0
         && order.placedAt !== undefined
          && now - order.placedAt > Math.max(20, effectiveTtlSec - GTD_REFRESH_BUFFER_SEC) * 1000;
        if (decision.replace || needsGtdRefresh) {
          if (!isPairedEntryMode(this.config) && isStaleBook(this.config, book)) {
            deferredReasons.push({
              orderId: order.externalId,
              tokenId: order.tokenId,
              side: order.side,
              reason: `${needsGtdRefresh && !decision.replace ? 'GTD 临近到期需刷新' : decision.reason}，但替代盘口已过期，保留现有订单等待下一轮 fresh book`
            });
            continue;
          }
          if (decision.replace && !needsGtdRefresh && options.deferObsoleteCancels && !isPairedEntryMode(this.config)) {
            // Fast-tick debounce: small (sub-2-tick) drifts must repeat with the SAME target price on a second tick
            // before we churn the order; bigger drifts replace immediately (see FAST_REPLACE_* constants). A GTD
            // refresh skips this — it must extend the expiry promptly.
            const tick = market.tickSize > 0 ? market.tickSize : 0.01;
            const drift = Math.abs(order.price - desired.price);
            const urgent = drift >= tick * FAST_REPLACE_URGENT_DRIFT_TICKS - 1e-9;
            const previousProposal = replaceConfirmState.get(order.externalId);
            const confirmed = previousProposal !== undefined
              && Math.abs(previousProposal.price - desired.price) < 1e-9
              && now - previousProposal.at <= FAST_REPLACE_CONFIRM_WINDOW_MS;
            if (!urgent && !confirmed) {
              nextReplaceConfirmState.set(order.externalId, { price: desired.price, at: now });
              deferredReasons.push({
                orderId: order.externalId,
                tokenId: order.tokenId,
                side: order.side,
                reason: `${decision.reason}，快速轮防抖：等待下一轮确认同一目标价后再撤换`
              });
              continue;
            }
          }
          cancelIds.add(order.externalId);
          cancelReasons.push({ orderId: order.externalId, tokenId: order.tokenId, side: order.side, reason: needsGtdRefresh && !decision.replace ? 'GTD 临近到期，刷新挂单延长有效期' : decision.reason });
          if (isPairedEntryMode(this.config) && order.side === 'SELL') cancelGroups.add(marketGroupKey(this.config, market));
        }
      } else if (this.config.strategy.cancelOutsideReward) {
        if (market && !book) {
          if (isCashProtectedBuyOrder(this.config, order, market)) {
            const decision = cashMaintenanceBookUnavailableDecision(
              this.config,
              order,
              { reason: 'missing-book' },
              maintenanceStaleState.get(order.externalId),
              now
            );
            if (decision.entry) nextMaintenanceStaleState.set(order.externalId, decision.entry);
            if (decision.cancel) {
              cancelIds.add(order.externalId);
              cancelReasons.push({ orderId: order.externalId, tokenId: order.tokenId, side: order.side, reason: decision.reason });
            } else {
              deferredReasons.push({ orderId: order.externalId, tokenId: order.tokenId, side: order.side, reason: decision.reason });
            }
            continue;
          }
          deferredReasons.push({ orderId: order.externalId, tokenId: order.tokenId, side: order.side, reason: '盘口暂时不可用，保留现有订单等待下一轮复检' });
          continue;
        }
        if (
          options.requireFreshReplacementForObsoleteCashOrders
          && !isPairedEntryMode(this.config)
          && !hasFreshReplacementIntent(this.config, order, intents, books)
        ) {
          deferredReasons.push({ orderId: order.externalId, tokenId: order.tokenId, side: order.side, reason: '新目标盘口尚未通过新鲜度检查，保留现有订单等待下一轮复检' });
          continue;
        }
        if (options.deferObsoleteCancels && !isPairedEntryMode(this.config)) {
          deferredReasons.push({ orderId: order.externalId, tokenId: order.tokenId, side: order.side, reason: '快速重报价轮不做筛选退出撤单，保留订单等待全量周期复核' });
          continue;
        }
        cancelIds.add(order.externalId);
        cancelReasons.push({ orderId: order.externalId, tokenId: order.tokenId, side: order.side, reason: '市场不再符合当前积分筛选或未生成目标报价' });
        if (isPairedEntryMode(this.config) && market && order.side === 'SELL') cancelGroups.add(marketGroupKey(this.config, market));
      }
    }

    this.store.checkpoint(cashMaintenanceStaleCheckpointKey(venue), {
      updatedAt: new Date(now).toISOString(),
      strictMs: this.config.risk.staleBookMs,
      strikesToCancel: CASH_PROTECTED_ORDER_STALE_STRIKES_TO_CANCEL,
      entries: Object.fromEntries(nextMaintenanceStaleState.entries())
    });
    // Pending fast-tick replace proposals: entries persist ONLY while re-proposed each call (confirmed or abandoned
    // targets drop out), and full cycles (which never defer) clear the map so stale proposals cannot linger.
    this.store.checkpoint(fastReplaceConfirmCheckpointKey(venue), {
      updatedAt: new Date(now).toISOString(),
      windowMs: FAST_REPLACE_CONFIRM_WINDOW_MS,
      entries: Object.fromEntries(nextReplaceConfirmState.entries())
    });

    if (isPairedEntryMode(this.config) && cancelGroups.size > 0) {
      for (const order of managedOpenOrders) {
        const market = marketByToken.get(order.tokenId);
        const orderGroup = market ? marketGroupKey(this.config, market) : groupByKnownToken(marketTokensByGroup, order.tokenId);
        if (!orderGroup || !cancelGroups.has(orderGroup)) continue;
        if (order.side !== 'SELL') continue;
        cancelIds.add(order.externalId);
        if (!cancelReasons.some((reason) => reason.orderId === order.externalId)) {
          cancelReasons.push({
            orderId: order.externalId,
            tokenId: order.tokenId,
            side: order.side,
            reason: '同组双边 SELL 有一边不安全，按成组规则一起撤单'
          });
        }
      }
    }

    const ids = [...cancelIds].filter(Boolean);
    if (deferredReasons.length > 0) {
      this.store.recordEvent({
        venue,
        severity: 'warn',
        type: 'quote.replace-deferred',
        message: `盘口暂时不可用，保留 ${deferredReasons.length} 个现有订单等待下一轮复检`,
        details: { reasons: deferredReasons }
      });
    }
    if (ids.length === 0) {
      return { openOrders, canceledIds: [] };
    }
    await this.adapter.cancelOrders(ids);
    this.store.markOrdersCanceled(venue, ids);
    this.store.recordEvent({
      venue,
      severity: 'warn',
      type: 'quote.replace-cancel',
      message: `${ids.length} orders`,
      details: { ids, reasons: cancelReasons, semantics: cancelSemantics(venue) }
    });
    // Exit-liquidity cooldown: track consecutive cancels per token. When a token hits
    // exitLiquidityCooldownStrikes within exitLiquidityCooldownWindowMs, enter cooldown for exitLiquidityCooldownMs.
    this.updateExitLiquidityCooldown(venue, cancelReasons, managedOpenOrders.filter((order) => cancelIds.has(order.externalId)));

    const canceledTokenIds = [...new Set(managedOpenOrders.filter((order) => cancelIds.has(order.externalId)).map((order) => order.tokenId))];
    return { openOrders: openOrders.filter((order) => !ids.includes(order.externalId)), canceledIds: ids, canceledTokenIds };
  }

  private updateExitLiquidityCooldown(
    venue: string,
    cancelReasons: Array<{ tokenId: string; reason: string }>,
    canceledOrders: Array<{ tokenId: string }>
  ): void {
    updateExitLiquidityCooldown(this.config, venue, cancelReasons, canceledOrders, this.store);
  }


  async cancelManagedOrders(
    venue: VenueName,
    openOrders: OpenOrder[],
    reason: string,
    eventType = 'risk.managed-cancel'
  ): Promise<CancelReplaceableOrdersResult> {
    const managedOpenOrders = this.managedOpenOrders(venue, openOrders);
    const ids = [...new Set(managedOpenOrders.map((order) => order.externalId).filter(Boolean))];
    if (ids.length === 0) return { openOrders, canceledIds: [] };
    await this.adapter.cancelOrders(ids);
    this.store.markOrdersCanceled(venue, ids);
    this.store.recordEvent({
      venue,
      severity: 'warn',
      type: eventType,
      message: `${reason}：已撤 ${ids.length} 个机器人受管订单`,
      details: {
        ids,
        reason,
        semantics: cancelSemantics(venue)
      }
    });
    return { openOrders: openOrders.filter((order) => !ids.includes(order.externalId)), canceledIds: ids };
  }

  private managedOpenOrders(venue: VenueName, openOrders: OpenOrder[]): OpenOrder[] {
    const managed = new Set(this.store.listManagedOpenOrders(venue).map((order) => order.externalId).filter(Boolean));
    return openOrders.filter((order) => managed.has(order.externalId));
  }
}

function hasFreshReplacementIntent(
  config: AppConfig,
  order: OpenOrder,
  intents: OrderIntent[],
  books: Map<string, Orderbook>
): boolean {
  const now = Date.now();
  return intents.some((intent) => {
    if (intent.tokenId === order.tokenId) return false;
    const book = books.get(intent.tokenId);
    return Boolean(book && now - book.receivedAt <= config.risk.staleBookMs);
  });
}

function isStaleBook(config: AppConfig, book: Orderbook): boolean {
  return Date.now() - book.receivedAt > config.risk.staleBookMs;
}

/**
 * Fast-retreat decision: re-validate the LIVE protections of a resting cash BUY on a FRESH book — currently checks
 * BOTH (a) front cushion eroded below polymarketRetreatFrontDepthUsd AND (b) the rear-support 1¢ window can no longer
 * absorb the order size. Either trigger means the placement protections have been undermined and a taker is about to
 * reach us OR an eaten fill could not be exited at ≤1¢ slippage. Stale books are never trusted to retreat.
 *
 * Both checks are venue-independent (POLY uses polymarketRetreatFrontDepthUsd + cashSupportWindowCents in its
 * strategy block; Predict uses its OWN values in predictParams.strategy — modules stay fully independent).
 */
export function shouldRetreatThinFront(
  config: AppConfig,
  venue: VenueName,
  order: OpenOrder,
  market: Market | undefined,
  book: Orderbook | undefined
): { frontDepthUsd: number; floorUsd: number; supportShortfall?: { exitDepthUsd: number; requiredUsd: number; windowCents: number } } | null {
  if (config.strategy.entryMode !== 'cash' || isPairedEntryMode(config)) return null;
  if (order.side !== 'BUY' || !market || !book || market.venue !== venue) return null;
  if (isStaleBook(config, book)) return null;
  // (a) Front-cushion retreat. Per-venue knob (modules independent): POLY uses polymarketRetreatFrontDepthUsd,
  // Predict uses predictFrontDepthUsd (no separate retreat knob — match placement floor = no hysteresis).
  const floorUsd = venue === 'polymarket'
    ? (config.strategy.polymarketRetreatFrontDepthUsd ?? 0)
    : venue === 'predict'
      ? (config.strategy.predictFrontDepthUsd ?? 0)
      : 0;
  const frontDepthUsd = floorUsd > 0 ? frontProtectionDepthUsd(book, order.side, order.price) : Number.POSITIVE_INFINITY;
  const frontFailed = floorUsd > 0 && frontDepthUsd + 1e-9 < floorUsd;
  // (b) Rear-support window retreat (new). Cent-based window directly below the resting BUY must still absorb the
  // order size; if the support was pulled while we rested, the next fill becomes a stuck single-leg position. This
  // closes the gap the user observed: cent-based support was only checked at placement, so when level-2 support got
  // pulled mid-rest the bot got eaten anyway. Predict uses the SAME knob but in its own strategy block — independent.
  const windowCents = Math.max(0, config.strategy.cashSupportWindowCents ?? 0);
  const requiredUsd = Math.max(0, config.risk.orderSizeUsd);
  let supportShortfall: { exitDepthUsd: number; requiredUsd: number; windowCents: number } | undefined;
  if (windowCents > 0 && requiredUsd > 0) {
    const floor = order.price - windowCents / 100;
    const exitDepthUsd = (book.bids ?? [])
      .filter((level) => level.price < order.price - 1e-9 && level.price >= floor - 1e-9)
      .reduce((sum, level) => sum + level.price * level.size, 0);
    if (exitDepthUsd + 1e-9 < requiredUsd) {
      supportShortfall = { exitDepthUsd: Number(exitDepthUsd.toFixed(4)), requiredUsd, windowCents };
    }
  }
  if (!frontFailed && !supportShortfall) return null;
  return { frontDepthUsd, floorUsd, ...(supportShortfall ? { supportShortfall } : {}) };
}

function cashMaintenanceBookUnavailableDecision(
  config: AppConfig,
  order: OpenOrder,
  stale: { reason: 'stale-book'; ageMs: number } | { reason: 'missing-book' },
  previous: CashMaintenanceStaleEntry | undefined,
  now: number
): {
  cancel: boolean;
  reason: string;
  entry?: CashMaintenanceStaleEntry;
} {
  const strictMs = config.risk.staleBookMs;
  const staleAgeMs = stale.reason === 'stale-book' ? Math.max(0, stale.ageMs) : undefined;
  const maintenanceGraceMs = cashMaintenanceStaleGraceMs(config);
  if (stale.reason === 'stale-book' && (staleAgeMs ?? 0) < maintenanceGraceMs) {
    return {
      cancel: false,
      reason: `现金单边保护盘口已过期 ${Math.round(staleAgeMs ?? 0)}ms，但仍在维护容忍 ${maintenanceGraceMs}ms 内，保留现有订单等待下一轮 fresh book`
    };
  }
  const previousMatches = previous?.tokenId === order.tokenId && previous.reason === stale.reason;
  const strikes = previousMatches ? previous.strikes + 1 : 1;
  const firstSeenAt = previousMatches ? previous.firstSeenAt : new Date(now).toISOString();
  const entry: CashMaintenanceStaleEntry = {
    orderId: order.externalId,
    tokenId: order.tokenId,
    strikes,
    firstSeenAt,
    lastSeenAt: new Date(now).toISOString(),
    reason: stale.reason,
    ...(staleAgeMs !== undefined ? { ageMs: Math.round(staleAgeMs) } : {})
  };
  if (strikes < CASH_PROTECTED_ORDER_STALE_STRIKES_TO_CANCEL) {
    return {
      cancel: false,
      entry,
      reason: stale.reason === 'missing-book'
        ? `现金单边保护盘口暂不可用，第 ${strikes}/${CASH_PROTECTED_ORDER_STALE_STRIKES_TO_CANCEL} 次确认，保留现有订单等待下一轮 fresh book`
        : `现金单边保护盘口已过期 ${Math.round(staleAgeMs ?? 0)}ms，超过维护容忍 ${maintenanceGraceMs}ms（严格阈值 ${strictMs}ms），第 ${strikes}/${CASH_PROTECTED_ORDER_STALE_STRIKES_TO_CANCEL} 次确认，保留现有订单等待下一轮 fresh book`
    };
  }
  return {
    cancel: true,
    reason: stale.reason === 'missing-book'
      ? `现金单边保护盘口连续 ${strikes} 轮不可用，撤单等待新鲜盘口`
      : `现金单边保护盘口连续 ${strikes} 轮过期 ${Math.round(staleAgeMs ?? 0)}ms，撤单等待新鲜盘口`
  };
}

function cashMaintenanceStaleGraceMs(config: AppConfig): number {
  const base = Math.max(CASH_PROTECTED_ORDER_STALE_GRACE_MS, config.risk.staleBookMs * 5);
  const predictOverride = config.strategy.predictCashBuyStaleGraceMs ?? 0;
  return predictOverride > 0 ? Math.max(base, predictOverride) : base;
}

function cashMaintenanceStaleCheckpointKey(venue: VenueName): string {
  return `cash-maintenance-stale.${venue}`;
}

interface FastReplaceConfirmEntry {
  price: number;
  at: number;
}

function fastReplaceConfirmCheckpointKey(venue: VenueName): string {
  return `cash-replace-confirm.${venue}`;
}

function readFastReplaceConfirmState(value: unknown): Map<string, FastReplaceConfirmEntry> {
  const entries = value && typeof value === 'object' ? (value as { entries?: unknown }).entries : undefined;
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return new Map();
  const result = new Map<string, FastReplaceConfirmEntry>();
  for (const [orderId, raw] of Object.entries(entries)) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Partial<FastReplaceConfirmEntry>;
    const price = Number(entry.price);
    const at = Number(entry.at);
    if (!Number.isFinite(price) || !Number.isFinite(at)) continue;
    result.set(orderId, { price, at });
  }
  return result;
}

function readCashMaintenanceStaleState(value: unknown): Map<string, CashMaintenanceStaleEntry> {
  const entries = value && typeof value === 'object' ? (value as { entries?: unknown }).entries : undefined;
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return new Map();
  const result = new Map<string, CashMaintenanceStaleEntry>();
  for (const [orderId, raw] of Object.entries(entries)) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Partial<CashMaintenanceStaleEntry>;
    if (
      typeof orderId !== 'string'
      || typeof entry.tokenId !== 'string'
      || typeof entry.firstSeenAt !== 'string'
      || typeof entry.lastSeenAt !== 'string'
      || (entry.reason !== 'stale-book' && entry.reason !== 'missing-book')
    ) continue;
    const strikes = Number(entry.strikes);
    result.set(orderId, {
      orderId,
      tokenId: entry.tokenId,
      strikes: Number.isFinite(strikes) && strikes > 0 ? Math.floor(strikes) : 1,
      firstSeenAt: entry.firstSeenAt,
      lastSeenAt: entry.lastSeenAt,
      reason: entry.reason,
      ...(Number.isFinite(entry.ageMs) ? { ageMs: Number(entry.ageMs) } : {})
    });
  }
  return result;
}

function isCashProtectedBuyOrder(config: AppConfig, order: OpenOrder, market: Market): boolean {
  return config.strategy.entryMode === 'cash'
    && !isPairedEntryMode(config)
    && order.side === 'BUY'
    && market.venue === 'predict'
    && Number.isFinite(market.rewards?.minShares)
    && (market.rewards?.minShares ?? 0) > 0
    && Number.isFinite(market.rewards?.maxSpreadCents)
    && (market.rewards?.maxSpreadCents ?? 0) > 0;
}


function shouldPreserveManagedOrdersOnEmptyCashRoute(
  config: AppConfig,
  markets: Market[],
  intents: OrderIntent[],
  managedOpenOrders: OpenOrder[]
): boolean {
  return config.strategy.entryMode === 'cash'
    && !isPairedEntryMode(config)
    && config.strategy.autoSelectMarkets
    && Math.max(1, config.risk.maxMarkets) >= CASH_EMPTY_ROUTE_PRESERVE_MIN_MARKETS
    && markets.length === 0
    && intents.length === 0
    && managedOpenOrders.length > 0;
}

function groupTokensByMarket(config: AppConfig, markets: Market[]): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (const market of markets) {
    const key = marketGroupKey(config, market);
    const tokens = result.get(key) ?? new Set<string>();
    tokens.add(market.tokenId);
    result.set(key, tokens);
  }
  return result;
}

function groupByKnownToken(groups: Map<string, Set<string>>, tokenId: string): string | undefined {
  for (const [key, tokens] of groups) {
    if (tokens.has(tokenId)) return key;
  }
  return undefined;
}

function exitLiquidityCooldownCheckpointKey(venue: string): string {
  return 'exit-liquidity-cooldown.' + venue;
}

interface ExitLiquidityCooldownEntry {
  tokenId: string;
  strikes: number;
  firstSeenAt: number;
  lastSeenAt: number;
  cooldownUntil?: number;
}

function readExitLiquidityCooldownState(value: unknown): Map<string, ExitLiquidityCooldownEntry> {
  const result = new Map<string, ExitLiquidityCooldownEntry>();
  if (!value || typeof value !== 'object') return result;
  const entries = (value as { entries?: unknown }).entries;
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return result;
  for (const [tokenId, raw] of Object.entries(entries)) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Partial<ExitLiquidityCooldownEntry>;
    if (typeof entry.strikes !== 'number' || typeof entry.firstSeenAt !== 'number' || typeof entry.lastSeenAt !== 'number') continue;
    const item: ExitLiquidityCooldownEntry = {
      tokenId,
      strikes: entry.strikes,
      firstSeenAt: entry.firstSeenAt,
      lastSeenAt: entry.lastSeenAt,
    };
    if (typeof entry.cooldownUntil === 'number') item.cooldownUntil = entry.cooldownUntil;
    result.set(tokenId, item);
  }
  return result;
}

export function isTokenInExitLiquidityCooldown(
  config: { strategy: { exitLiquidityCooldownMs?: number } },
  venue: string,
  tokenId: string,
  store: { getCheckpoint(name: string): { value: unknown } | undefined },
  now = Date.now()
): boolean {
  const cooldownMs = config.strategy.exitLiquidityCooldownMs ?? 0;
  if (cooldownMs <= 0) return false;
  const checkpoint = store.getCheckpoint(exitLiquidityCooldownCheckpointKey(venue));
  const state = readExitLiquidityCooldownState(checkpoint?.value);
  const entry = state.get(tokenId);
  if (!entry || entry.cooldownUntil === undefined) return false;
  return now < entry.cooldownUntil;
}

export function updateExitLiquidityCooldown(
  config: { strategy: { exitLiquidityCooldownStrikes?: number; exitLiquidityCooldownWindowMs?: number; exitLiquidityCooldownMs?: number } },
  venue: string,
  cancelReasons: Array<{ tokenId: string; reason: string }>,
  canceledOrders: Array<{ tokenId: string }>,
  store: { getCheckpoint(name: string): { value: unknown } | undefined; checkpoint(name: string, value: unknown): void },
  now = Date.now()
): void {
  const strikesToTrigger = config.strategy.exitLiquidityCooldownStrikes ?? 0;
  const windowMs = config.strategy.exitLiquidityCooldownWindowMs ?? 0;
  const cooldownMs = config.strategy.exitLiquidityCooldownMs ?? 0;
  if (strikesToTrigger <= 0 || cooldownMs <= 0) return;
  const checkpoint = store.getCheckpoint(exitLiquidityCooldownCheckpointKey(venue));
  const state = readExitLiquidityCooldownState(checkpoint?.value);
  const affectedTokenIds = new Set<string>();
  for (const reason of cancelReasons) {
    if (reason.reason.includes('后方退出流动性')) {
      affectedTokenIds.add(reason.tokenId);
    }
  }
  for (const tokenId of affectedTokenIds) {
    const previous = state.get(tokenId);
    const windowStart = now - windowMs;
    // "N strikes within windowMs" measures the window from the FIRST strike of the current burst (not the previous
    // strike) — otherwise slow-but-steady strikes (each < window apart) could span far longer than windowMs and still
    // trigger. A burst whose first strike has aged past the window resets and starts counting fresh.
    if (previous && previous.firstSeenAt >= windowStart) {
      const strikes = previous.strikes + 1;
      const cooldownUntil = strikes >= strikesToTrigger ? now + cooldownMs : undefined;
      const entry: ExitLiquidityCooldownEntry = {
        tokenId,
        strikes,
        firstSeenAt: previous.firstSeenAt,
        lastSeenAt: now,
      };
      if (cooldownUntil !== undefined) entry.cooldownUntil = cooldownUntil;
      state.set(tokenId, entry);
    } else {
      state.set(tokenId, {
        tokenId,
        strikes: 1,
        firstSeenAt: now,
        lastSeenAt: now,
      });
    }
  }
  // Prune entries that are neither in active cooldown nor recently struck, so the checkpoint stays bounded.
  for (const [staleToken, staleEntry] of state) {
    const cooldownActive = staleEntry.cooldownUntil !== undefined && now < staleEntry.cooldownUntil;
    const recentStrike = staleEntry.lastSeenAt >= now - windowMs;
    if (!cooldownActive && !recentStrike) state.delete(staleToken);
  }
  const entries: Record<string, ExitLiquidityCooldownEntry> = {};
  for (const [key, val] of state) entries[key] = val;
  store.checkpoint(exitLiquidityCooldownCheckpointKey(venue), {
    updatedAt: now,
    strikesToTrigger,
    windowMs,
    cooldownMs,
    entries,
  });
}
