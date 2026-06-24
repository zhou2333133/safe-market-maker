import type { AppConfig } from '../config/schema.js';
import type { Market, OpenOrder, Orderbook, Position, VenueName } from '../domain/types.js';
import { logger } from '../observability/logger.js';
import { rejectReason } from '../risk/reject-reasons.js';
import type { StateStore } from '../store/sqlite.js';
import { discoverRoutableMarkets, planMarketOrderbookScan, publicMarketScanPlan } from '../strategy/market-discovery.js';
import type { VenueAdapter } from '../venues/types.js';
import { evaluateMarketGuard, marketTimeDecision } from '../risk/market-guard.js';
import { buildRouteAuditFromSnapshot, mergeRouteAuditCheckpoint } from './route-audit.js';
import { buildCashFillCooldown } from './cash-fill-cooldown.js';
import { mergeMarkets, uniqueMarkets } from './market-merge.js';

export interface MarketDataSnapshot {
  markets: Market[];
  books: Map<string, Orderbook>;
}

export interface MarketDataSyncContext {
  openOrders?: OpenOrder[];
  positions?: Position[];
}

const marketCache = new Map<string, { ts: number; markets: Market[] }>();
const marketInflight = new Map<string, Promise<Market[]>>();
const orderbookCache = new Map<string, Map<string, Orderbook>>();
const ORDERBOOK_SYNC_CONCURRENCY = 8;
const MARKET_REFRESH_TIMEOUT_MS = 12000;
const ORDERBOOK_SYNC_TIMEOUT_MS = 8000;
const MIN_ROUTE_ORDERBOOK_CACHE_TTL_MS = 15000;
const MAX_ROUTE_ORDERBOOK_CACHE_TTL_MS = 10 * 60 * 1000;
const FULL_ROUTE_ORDERBOOK_SCAN_INTERVAL_MS = 5 * 60 * 1000;
const PERSISTED_MARKET_CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const ORDERBOOK_UNAVAILABLE_COOLDOWN_MS = 2 * 60 * 1000;

export class MarketDataSyncService {
  constructor(
    private readonly config: AppConfig,
    private readonly adapter: VenueAdapter,
    private readonly store: StateStore
  ) {
  }

  async sync(venue: VenueName, context: MarketDataSyncContext = {}): Promise<MarketDataSnapshot> {
    const all = await this.getCachedMarkets(venue);
    const markets = this.selectMarkets(venue, all);
    const activeMarkets = this.activeMarkets(venue, all, context);
    const orderbookMarkets = this.planOrderbookMarkets(venue, markets, all, activeMarkets);

    // Resolve open-order markets so they stay subscribed on the persistent WS (keeps ws-report fresh).
    const openOrderTokenIds = [...new Set((context.openOrders ?? [])
      .filter((order) => order.venue === venue && ['OPEN', 'PENDING_OPEN', 'PLANNED', 'UNKNOWN'].includes(order.status))
      .map((order) => order.tokenId).filter(Boolean))];
    const openOrderMarkets = openOrderTokenIds.length > 0
      ? all.filter((market) => openOrderTokenIds.includes(market.tokenId))
      : undefined;
    const synced = await this.syncOrderbooks(venue, orderbookMarkets, openOrderMarkets);
    const books = this.withCachedRouteOrderbooks(venue, markets, synced.books, synced.failedTokenIds);
    this.recordOrderbookCacheCoverage(venue, synced.books, books);
    this.recordRollingRouteAudit(venue, all, books, synced.failedTokenIds);
    return { markets, books };
  }

  /**
   * Whether to read this venue's orderbooks WS-cache-first. On for any venue unless its own wsWatchAll is set
   * false, and only when the adapter exposes the WS watch methods. This changes ONLY the data source (WS push
   * cache vs REST, with REST fallback when no fresh WS book) — the market scan plan, route audit, switching,
   * depth and placement are untouched. config is already venue-resolved, so config.strategy is this venue's own.
   */
  private wsWatchEnabled(_venue: VenueName): boolean {
    return this.config.strategy.wsWatchAll !== false
      && typeof this.adapter.watchMarkets === 'function'
      && typeof this.adapter.getCachedOrderbook === 'function';
  }

  async resolveMarkets(venue: VenueName): Promise<Market[]> {
    return this.selectMarkets(venue, await this.getCachedMarkets(venue));
  }

  private selectMarkets(venue: VenueName, all: Market[]): Market[] {
    const selected = this.config.selectedMarkets[venue];
    if (selected.length > 0 && !this.config.strategy.autoSelectMarkets) {
      const wanted = new Set(selected);
      return discoverRoutableMarkets(this.config, venue, all.filter((market) => wanted.has(market.tokenId)))
        .slice(0, Math.max(this.config.risk.maxMarkets * 2, this.config.risk.maxMarkets));
    }
    return discoverRoutableMarkets(this.config, venue, all);
  }

  async resolveMarketsForOpenOrders(venue: VenueName, tokenIds: string[]): Promise<Market[]> {
    const wanted = new Set(tokenIds.filter(Boolean));
    if (wanted.size === 0) return [];
    const all = await this.getCachedMarkets(venue);
    return all.filter((market) => wanted.has(market.tokenId));
  }

  async resolveMarketsForPositions(venue: VenueName, positions: Position[]): Promise<Market[]> {
    const held = positions.filter((position) => position.venue === venue && (position.size > 1e-9 || Math.abs(position.notionalUsd) > 0.01));
    if (held.length === 0) return [];
    const all = await this.getCachedMarkets(venue);
    return enrichMarketsWithPositionMarkets(all, held)
      .filter((market) => held.some((position) => position.tokenId === market.tokenId));
  }

  async fillMissingOrderbooks(venue: VenueName, markets: Market[], books: Map<string, Orderbook>): Promise<Map<string, Orderbook>> {
    const missingMarkets = markets.filter((market) => !books.has(market.tokenId));
    if (missingMarkets.length === 0) return books;
    const { books: missingBooks } = await this.syncOrderbooks(venue, missingMarkets);
    for (const [tokenId, book] of missingBooks) books.set(tokenId, book);
    return books;
  }

  async refreshOrderbooks(
    venue: VenueName,
    markets: Market[],
    books: Map<string, Orderbook>,
    options: { reuseFresh?: boolean } = {}
  ): Promise<Map<string, Orderbook>> {
    const unique = [...new Map(markets.map((market) => [market.tokenId, market] as const)).values()];
    if (unique.length === 0) return books;
    const targets = options.reuseFresh ? staleOrMissingMarkets(this.config, unique, books) : unique;
    if (targets.length === 0) return books;
    const { books: fresh } = await this.syncOrderbooks(venue, targets);
    for (const [tokenId, book] of fresh) books.set(tokenId, book);
    return books;
  }

  async getCachedMarkets(venue: VenueName): Promise<Market[]> {
    return getSharedCachedMarkets(this.config, venue, this.adapter, this.store);
  }

  private async syncOrderbooks(venue: VenueName, markets: Market[], openOrderMarkets?: Market[]): Promise<{ books: Map<string, Orderbook>; failedTokenIds: Set<string> }> {
    const books = new Map<string, Orderbook>();
    const failedTokenIds = new Set<string>();
    const safeMarkets = markets.filter((market) => marketTimeDecision(this.config, market).ok);
    const cachedBooks = sharedOrderbookCache(this.config, venue);
    // Predict only: subscribe these markets to the persistent WS (add-only) so their books arrive via push and
    // can be read from cache for free on later cycles. The scan plan, audit and routing below are unchanged —
    // this only swaps the per-book data source (WS push cache first, REST on miss), so the same active set
    // costs far less REST and more markets stay affordable.
    const wsWatch = this.wsWatchEnabled(venue);
    // Watch ONLY the bot's resting-order markets via WS — scan/discovery uses REST per cycle (existing path).
    // Subscribing the full scan plan was the root cause of POLY's "watched=140 cached=4" dead-subscription
    // cascade: most scan candidates are cold and never receive a WS snapshot, so they sit forever as dead
    // entries. Now WS scope tracks the bot's actual stake. New tokens enter watch only when the bot places
    // (see submit-service post-submit prime). Predict has always used this scope (watched=2 cached=2).
    const watchMarketsSet = openOrderMarkets && openOrderMarkets.length > 0
      ? openOrderMarkets.filter((market) => market.venue === venue)
      : [];
    if (wsWatch) this.adapter.watchMarkets?.(watchMarketsSet);
    let restReads = 0;
    let wsServed = 0;
    // Phase 4 cold-token prime: open-order markets that aren't covered by the scan plan (safeMarkets) get a
    // dedicated REST fetch each cycle to guarantee fast-tick has a fresh book to verify protections against.
    // Without this, a cold market gets a one-time prime at submit (Phase 3) but the cache slowly goes stale if
    // Polymarket never pushes — and once stale the fast-retreat silently skips. Cheap: ~1 REST per active order
    // per cycle, only for tokens the scan didn't already include.
    const safeMarketTokenIds = new Set(safeMarkets.map((m) => m.tokenId));
    const coldOpenOrderMarkets = (openOrderMarkets ?? []).filter((m) => m.venue === venue && !safeMarketTokenIds.has(m.tokenId));
    const allMarketsToFetch = [...safeMarkets, ...coldOpenOrderMarkets];
    // Try one bulk POST /books call up front for the markets the WS cache doesn't cover. Single-fetch fallback in
    // the per-market loop handles whatever the bulk call didn't return (network error, partial response, unknown
    // tokens). Only the venue that exposes getOrderbooksBatch (currently Polymarket) takes this path; Predict's
    // adapter leaves it undefined and the loop runs exactly as before, single-fetch per market.
    const bulkBooks = new Map<string, Orderbook>();
    if (typeof this.adapter.getOrderbooksBatch === 'function' && allMarketsToFetch.length > 0) {
      const tokensNeedingFetch = allMarketsToFetch
        .filter((market) => !(wsWatch ? this.adapter.getCachedOrderbook?.(market.tokenId) : undefined))
        .map((market) => market.tokenId);
      if (tokensNeedingFetch.length > 0) {
        try {
          const batch = await withTimeout(
            this.adapter.getOrderbooksBatch(tokensNeedingFetch),
            ORDERBOOK_SYNC_TIMEOUT_MS,
            `bulk orderbooks (${tokensNeedingFetch.length} tokens)`
          );
          for (const [id, book] of batch) bulkBooks.set(id, book);
        } catch (error) {
          // Bulk failure is non-fatal: the loop below falls back to single-fetch per market. Record once so an
          // operator notices if the batch endpoint keeps failing (and gets to flip useWsOrderbook / debug).
          this.store.recordEvent({
            venue,
            severity: 'info',
            type: 'orderbook.bulk-fallback',
            message: `批量盘口接口失败，本轮回退到单本拉取 (${tokensNeedingFetch.length} markets)`,
            details: { error: error instanceof Error ? error.message : String(error), tokenCount: tokensNeedingFetch.length }
          });
        }
      }
    }
    await mapWithConcurrency(allMarketsToFetch, ORDERBOOK_SYNC_CONCURRENCY, async (market) => {
      try {
        const previousBook = cachedBooks.get(market.tokenId);
        let book = wsWatch ? this.adapter.getCachedOrderbook?.(market.tokenId) : undefined;
        let restFetched = false;
        if (book) {
          wsServed += 1;
        } else if (bulkBooks.has(market.tokenId)) {
          // Bulk /books already fetched this one — counts as a REST read (it WAS a REST round-trip, just shared)
          // and primes the WS cache identically to a single-fetch result.
          book = bulkBooks.get(market.tokenId)!;
          restReads += 1;
          restFetched = true;
        } else {
          restReads += 1;
          restFetched = true;
          // Under watch-all a cache miss goes STRAIGHT to REST (skip the blocking WS wait) so heavy ticks stay
          // fast; the subscription still warms the cache for the next cycle. Non-watch path keeps WS-then-REST.
          const fetchBook = wsWatch && this.adapter.getOrderbookRest
            ? this.adapter.getOrderbookRest.bind(this.adapter)
            : this.adapter.getOrderbook.bind(this.adapter);
          book = await withTimeout(
            fetchBook(market.tokenId),
            ORDERBOOK_SYNC_TIMEOUT_MS,
            `orderbook ${market.tokenId}`
          );
        }
        const guard = evaluateMarketGuard(this.config, market, book, { previousBook });
        if (!guard.ok) {
          this.store.recordEvent({
            venue,
            severity: guard.cancelOpenOrders ? 'warn' : 'info',
            type: 'orderbook.guard-skip',
            message: market.tokenId,
            details: { market, guard, reject: rejectReason('MARKET_' + guard.reason.replace(/-/g, '_').toUpperCase(), 'market', 'syncing-markets') }
          });
        }
        books.set(market.tokenId, book);
        cachedBooks.set(market.tokenId, book);
        // Phase 4: when REST fetched the book (not WS-served), prime the WS cache so the next fast-tick
        // (which reads getCachedOrderbook only) finds it. WS push updates take over for subsequent ticks.
        if (restFetched && book && this.adapter.primeBook) {
          try { this.adapter.primeBook(market.tokenId, book); } catch { /* best effort */ }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failedTokenIds.add(market.tokenId);
        this.recordOrderbookUnavailableCooldown(venue, market.tokenId, message);
        this.store.recordEvent({
          venue,
          severity: 'warn',
          type: 'orderbook.unavailable',
          message: market.tokenId,
          details: { market, error: message, reject: rejectReason('ORDERBOOK_UNAVAILABLE', 'orderbook', 'syncing-markets') }
        });
        logger.warn('Skipped market because orderbook is unavailable', { venue, tokenId: market.tokenId, marketId: market.marketId, error: message });
      }
    });
    if (wsWatch) {
      const stats = this.adapter.wsWatchStats?.();
      this.store.recordMetric('orderbook.ws_served', wsServed, { venue, restReads, total: safeMarkets.length, wsConnected: stats?.connected ?? false, wsCached: stats?.cachedOrderbooks ?? 0 });
      // Surface WS / orderbook real-time health for the UI: connection status + how many books were served fresh from
      // the WS push cache vs fetched over REST this cycle. Written every full cycle so the UI badge reflects live state.
      this.store.checkpoint(`ws-health.${venue}`, {
        connected: stats?.connected ?? false,
        watchedMarkets: stats?.watchedMarkets ?? 0,
        cachedOrderbooks: stats?.cachedOrderbooks ?? 0,
        wsServed,
        restReads,
        total: safeMarkets.length,
        checkedAt: new Date().toISOString()
      });
    }
    return { books, failedTokenIds };
  }

  private withCachedRouteOrderbooks(
    venue: VenueName,
    markets: Market[],
    freshBooks: Map<string, Orderbook>,
    failedTokenIds: Set<string>
  ): Map<string, Orderbook> {
    if (!this.config.strategy.autoSelectMarkets) return freshBooks;
    const now = Date.now();
    const ttlMs = routeOrderbookCacheTtlMs(this.config);
    const cachedBooks = sharedOrderbookCache(this.config, venue);
    const wsCacheEnabled = this.wsWatchEnabled(venue);
    const books = new Map(freshBooks);
    for (const market of markets) {
      if (market.venue !== venue) continue;
      if (books.has(market.tokenId) || failedTokenIds.has(market.tokenId)) continue;
      if (!marketTimeDecision(this.config, market, now).ok) continue;
      // Try the persistent WS cache first — these books are kept live by the WS subscription, so they're as
      // fresh as the most recent push from the venue. Without this the route only sees the per-cycle scan-budget
      // sample (≈4 books) even when WS has hundreds cached; the bot rejects 95% of high-reward candidates with
      // "盘口不可用" purely because the route never gets the live WS book.
      const wsBook = wsCacheEnabled ? this.adapter.getCachedOrderbook?.(market.tokenId) : undefined;
      if (wsBook) {
        books.set(market.tokenId, wsBook);
        cachedBooks.set(market.tokenId, wsBook);
        continue;
      }
      const cached = cachedBooks.get(market.tokenId);
      if (!cached || now - cached.receivedAt > ttlMs) continue;
      books.set(market.tokenId, cached);
    }
    return books;
  }

  private recordOrderbookCacheCoverage(
    venue: VenueName,
    freshBooks: Map<string, Orderbook>,
    routeBooks: Map<string, Orderbook>
  ): void {
    if (!this.config.strategy.autoSelectMarkets) return;
    const key = `market-scan.${venue}`;
    const checkpoint = this.store.getCheckpoint(key)?.value;
    if (!checkpoint || typeof checkpoint !== 'object') return;
    this.store.checkpoint(key, {
      ...(checkpoint as Record<string, unknown>),
      routeUsableOrderbooks: routeBooks.size,
      cachedOrderbooks: Math.max(0, routeBooks.size - freshBooks.size),
      routeOrderbookCacheTtlMs: routeOrderbookCacheTtlMs(this.config)
    });
  }

  private recordRollingRouteAudit(
    venue: VenueName,
    allMarkets: Market[],
    routeBooks: Map<string, Orderbook>,
    failedTokenIds: Set<string>
  ): void {
    if (!this.config.strategy.autoSelectMarkets) return;
    if (this.config.strategy.entryMode !== 'cash') return;
    const routeBooksForVenue = new Map(
      [...routeBooks.entries()].filter(([, book]) => book.venue === venue)
    );
    const audit = buildRouteAuditFromSnapshot(this.config, venue, allMarkets, routeBooksForVenue, {
      // Consider a broad slice of the universe (not just maxMarkets*3) so the rolling route-audit coverage can reach the
      // cash execution gate's ≥60% threshold; the full scan fetches enough orderbooks for those considered to be scored.
      top: Math.max(120, this.config.risk.maxMarkets * 3),
      cashFillCooldown: buildCashFillCooldown(this.config, venue, this.store)
    });
    const checkpoint = mergeRouteAuditCheckpoint(this.config, audit, this.store.getCheckpoint(`route-audit.${venue}`)?.value, {
      cashFillCooldown: buildCashFillCooldown(this.config, venue, this.store)
    });
    this.store.checkpoint(`route-audit.${venue}`, {
      ...checkpoint,
      failedTokenIds: [...failedTokenIds].slice(0, 50)
    });
    this.store.recordMetric('route.audit_tradable', audit.totals.tradable, { venue, complete: checkpoint.complete, coveragePct: checkpoint.coveragePct });
  }

  private planOrderbookMarkets(venue: VenueName, markets: Market[], allMarkets: Market[], activeMarkets: Market[] = []): Market[] {
    if (!this.config.strategy.autoSelectMarkets) return markets;
    const forceFullScan = this.shouldRunFullRouteScan(venue);
    const plan = planMarketOrderbookScan(this.config, venue, mergeMarkets(allMarkets, activeMarkets), {
      activeTokenIds: activeMarkets.map((market) => market.tokenId),
      forceFullScan,
      suppressedTokenIds: this.unavailableCooldownTokenIds(venue)
    });
    this.store.recordMetric('api.orderbook_scan_planned', plan.markets.length, { venue, active: plan.active.length, hot: plan.hot.length, explore: plan.explore.length, fullScan: plan.fullScan });
    if (plan.fullScan) {
      this.store.checkpoint(`market-scan-full.${venue}`, {
        startedAt: new Date().toISOString(),
        eligibleMetadata: plan.eligibleMetadata,
        scannedOrderbooks: plan.markets.length
      });
    }
    this.store.checkpoint(`market-scan.${venue}`, publicMarketScanPlan(plan));
    return plan.markets;
  }

  private shouldRunFullRouteScan(venue: VenueName): boolean {
    if (!this.config.strategy.autoSelectMarkets) return false;
    const checkpoint = this.store.getCheckpoint(`market-scan-full.${venue}`);
    const lastStartedAt = checkpoint?.ts ? Date.parse(checkpoint.ts) : Number.NaN;
    return !Number.isFinite(lastStartedAt) || Date.now() - lastStartedAt >= FULL_ROUTE_ORDERBOOK_SCAN_INTERVAL_MS;
  }

  private activeMarkets(venue: VenueName, allMarkets: Market[], context: MarketDataSyncContext): Market[] {
    const activeTokenIds = new Set([
      ...this.previousRouteTokenIds(venue),
      ...(context.openOrders ?? [])
        .filter((order) => order.venue === venue && ['OPEN', 'PENDING_OPEN', 'PLANNED', 'UNKNOWN'].includes(order.status))
        .map((order) => order.tokenId),
      ...(context.positions ?? [])
        .filter((position) => position.venue === venue && (position.size > 1e-9 || Math.abs(position.notionalUsd) > 0.01))
        .map((position) => position.tokenId)
    ].filter(Boolean));
    if (activeTokenIds.size === 0) return [];
    const direct = allMarkets.filter((market) => activeTokenIds.has(market.tokenId));
    const enriched = enrichMarketsWithPositionMarkets(direct.length > 0 ? allMarkets : direct, context.positions ?? []);
    return uniqueMarkets(enriched.filter((market) => activeTokenIds.has(market.tokenId)));
  }

  private previousRouteTokenIds(venue: VenueName): string[] {
    const checkpoint = this.store.getCheckpoint(`route.${venue}`)?.value;
    if (!checkpoint || typeof checkpoint !== 'object') return [];
    const selected = (checkpoint as { selected?: unknown }).selected;
    if (!Array.isArray(selected)) return [];
    return selected
      .map((item) => (item && typeof item === 'object' ? (item as { tokenId?: unknown }).tokenId : undefined))
      .filter((tokenId): tokenId is string => typeof tokenId === 'string' && tokenId.length > 0);
  }

  private unavailableCooldownTokenIds(venue: VenueName): string[] {
    const checkpoint = this.store.getCheckpoint(`orderbook-unavailable.${venue}`)?.value;
    if (!checkpoint || typeof checkpoint !== 'object') return [];
    const entries = (checkpoint as { tokens?: unknown }).tokens;
    if (!Array.isArray(entries)) return [];
    const now = Date.now();
    return entries.flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const tokenId = (item as { tokenId?: unknown }).tokenId;
      const lastFailedAt = (item as { lastFailedAt?: unknown }).lastFailedAt;
      if (typeof tokenId !== 'string' || typeof lastFailedAt !== 'string') return [];
      const ts = Date.parse(lastFailedAt);
      if (!Number.isFinite(ts) || now - ts > ORDERBOOK_UNAVAILABLE_COOLDOWN_MS) return [];
      return [tokenId];
    });
  }

  private recordOrderbookUnavailableCooldown(venue: VenueName, tokenId: string, error: string): void {
    const key = `orderbook-unavailable.${venue}`;
    const checkpoint = this.store.getCheckpoint(key)?.value;
    const previous = checkpoint && typeof checkpoint === 'object' && Array.isArray((checkpoint as { tokens?: unknown }).tokens)
      ? (checkpoint as { tokens: Array<Record<string, unknown>> }).tokens
      : [];
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const byToken = new Map<string, Record<string, unknown>>();
    for (const entry of previous) {
      const previousTokenId = typeof entry.tokenId === 'string' ? entry.tokenId : undefined;
      const lastFailedAt = typeof entry.lastFailedAt === 'string' ? Date.parse(entry.lastFailedAt) : Number.NaN;
      if (!previousTokenId || !Number.isFinite(lastFailedAt) || nowMs - lastFailedAt > ORDERBOOK_UNAVAILABLE_COOLDOWN_MS) continue;
      byToken.set(previousTokenId, entry);
    }
    const existing = byToken.get(tokenId);
    byToken.set(tokenId, {
      tokenId,
      lastFailedAt: nowIso,
      count: Number(existing?.count ?? 0) + 1,
      error: error.slice(0, 240)
    });
    this.store.checkpoint(key, {
      cooldownMs: ORDERBOOK_UNAVAILABLE_COOLDOWN_MS,
      tokens: [...byToken.values()].slice(-80)
    });
  }

}

function staleOrMissingMarkets(config: AppConfig, markets: Market[], books: Map<string, Orderbook>): Market[] {
  const now = Date.now();
  return markets.filter((market) => {
    const current = books.get(market.tokenId);
    return !current || now - current.receivedAt > config.risk.staleBookMs;
  });
}

export function enrichMarketsWithPositionMarkets(markets: Market[], positions: Position[]): Market[] {
  const allByToken = new Map(markets.map((market) => [market.tokenId, market] as const));
  const positionGroups = new Map<string, Position[]>();
  for (const position of positions) {
    const key = position.conditionId || position.marketId;
    if (!key) continue;
    const group = positionGroups.get(key) ?? [];
    group.push(position);
    positionGroups.set(key, group);
  }
  const resolved = [...markets];
  for (const position of positions) {
    if (allByToken.has(position.tokenId)) continue;
    const synthetic = marketFromPosition(position, positionGroups.get(position.conditionId || position.marketId || ''));
    if (synthetic) resolved.push(synthetic);
  }
  return [...new Map(resolved.map((market) => [market.tokenId, market] as const)).values()];
}

function marketFromPosition(position: Position, group: Position[] = []): Market | undefined {
  if (position.market) return position.market;
  const key = position.conditionId || position.marketId;
  if (!key) return undefined;
  const outcomeCount = position.outcomeCount ?? (new Set(group.map((item) => item.tokenId)).size === 2 ? 2 : undefined);
  return {
    venue: position.venue,
    tokenId: position.tokenId,
    ...(position.marketId ? { marketId: position.marketId } : {}),
    ...(position.conditionId ? { conditionId: position.conditionId } : {}),
    question: position.marketId ? `Position market ${position.marketId}` : `Position group ${key}`,
    ...(position.outcome ? { outcome: position.outcome } : {}),
    ...(outcomeCount !== undefined ? { outcomeCount } : {}),
    volume24hUsd: 0,
    liquidityUsd: 0,
    acceptingOrders: true,
    negRisk: false,
    feeRateBps: 0,
    tickSize: 0.01,
    rewards: { enabled: false }
  };
}

export async function getSharedCachedMarkets(
  config: AppConfig,
  venue: VenueName,
  adapter: VenueAdapter | undefined,
  store?: Pick<StateStore, 'checkpoint' | 'getCheckpoint' | 'recordEvent' | 'recordMetric'>,
  options: { timeoutMs?: number } = {}
): Promise<Market[]> {
  const ttl = config.strategy.marketRefreshMs ?? 60000;
  if (ttl <= 0) {
    if (!adapter) return [];
    const markets = await withTimeout(
      adapter.getMarkets(),
      options.timeoutMs ?? MARKET_REFRESH_TIMEOUT_MS,
      `market list ${venue}`
    );
    store?.recordMetric('api.market_refresh', 1, { venue, ttlMs: ttl });
    return markets;
  }
  const key = `${venue}:${adapter?.constructor?.name ?? "readonly"}:${marketCacheFingerprint(config)}`;
  const fingerprint = marketCacheFingerprint(config);

  // When adapter is unavailable (read-only report mode), fall back to persisted snapshot only.
  if (!adapter) {
    const persistent = readPersistedMarketSnapshot(store, venue, marketCacheFingerprint(config));
    if (persistent && persistent.length > 0) return persistent;
    const cachedEntry = marketCache.get(`${venue}:readonly:${marketCacheFingerprint(config)}`);
    if (cachedEntry && Date.now() - cachedEntry.ts < ttl) return cachedEntry.markets;
    return [];
  }  
  const cached = marketCache.get(key);
  if (cached && Date.now() - cached.ts < ttl) {
    // Cached market lists still need to hydrate adapter-internal maps.
    adapter.hydrateFromMarkets?.(cached.markets);
    return cached.markets;
  }
  const existing = marketInflight.get(key);
  if (existing) {
    const markets = await existing;
    adapter.hydrateFromMarkets?.(markets);
    return markets;
  }
  const request = withTimeout(
    adapter.getMarkets(),
    options.timeoutMs ?? MARKET_REFRESH_TIMEOUT_MS,
    `market list ${venue}`
  )
    .then((markets) => {
      if (markets.length === 0) {
        const persistent = readPersistedMarketSnapshot(store, venue, fingerprint);
        if (persistent) {
          adapter.hydrateFromMarkets?.(persistent);
          store?.recordMetric('api.market_refresh_empty_fallback', 1, { venue, ttlMs: ttl });
          store?.recordEvent({
            venue,
            severity: 'warn',
            type: 'market-list.empty-fallback',
            message: '市场列表刷新返回空结果，使用最近公开 metadata 快照继续维护现有路由',
            details: { source: 'persisted', markets: persistent.length, maxAgeMs: PERSISTED_MARKET_CACHE_MAX_AGE_MS }
          });
          return persistent;
        }
      }
      marketCache.set(key, { ts: Date.now(), markets });
      persistMarketSnapshot(store, venue, fingerprint, markets);
      store?.recordMetric('api.market_refresh', 1, { venue, ttlMs: ttl });
      return markets;
    })
    .catch((error) => {
      const persistent = readPersistedMarketSnapshot(store, venue, fingerprint);
      const fallbackMarkets = cached?.markets ?? persistent;
      if (!fallbackMarkets) throw error;
      adapter.hydrateFromMarkets?.(fallbackMarkets);
      store?.recordMetric('api.market_refresh_stale_fallback', 1, { venue, ttlMs: ttl });
      store?.recordEvent({
        venue,
        severity: 'warn',
        type: 'market-list.stale-fallback',
        message: '市场列表刷新失败，使用最近公开 metadata 快照继续维护现有路由',
        details: {
          error: error instanceof Error ? error.message : String(error),
          source: cached ? 'memory' : 'persisted',
          markets: fallbackMarkets.length,
          maxAgeMs: PERSISTED_MARKET_CACHE_MAX_AGE_MS
        }
      });
      return fallbackMarkets;
    })
    .finally(() => {
      marketInflight.delete(key);
    });
  marketInflight.set(key, request);
  return request;
}

function marketCacheFingerprint(config: AppConfig): string {
  return [
    config.venues.predict.apiBaseUrl,
    config.venues.polymarket.gammaUrl,
    config.strategy.autoSelectMarkets,
    config.strategy.candidateLimit,
    config.strategy.pointsOnly,
    config.strategy.acceptingOnly,
    config.strategy.minMarketLiquidityUsd,
    config.strategy.minRewardLevel,
    config.strategy.marketRefreshMs,
    config.risk.settlementNoNewOrdersMs,
    config.risk.settlementCancelOpenOrdersMs,
    config.risk.shortEventMaxDurationMs,
    config.risk.eventStartNoNewOrdersMs,
    config.risk.eventStartCancelOpenOrdersMs,
    config.risk.blockUnknownEndTime,
    config.selectedMarkets.predict.join(','),
    config.selectedMarkets.polymarket.join(',')
  ].join('|');
}

function marketSnapshotCheckpointName(venue: VenueName): string {
  return `market-list-cache.${venue}`;
}

function persistMarketSnapshot(
  store: Pick<StateStore, 'checkpoint'> | undefined,
  venue: VenueName,
  fingerprint: string,
  markets: Market[]
): void {
  if (!store || markets.length === 0) return;
  store.checkpoint(marketSnapshotCheckpointName(venue), {
    venue,
    fingerprint,
    capturedAt: new Date().toISOString(),
    markets: markets.map(publicMarketSnapshot)
  });
}

function readPersistedMarketSnapshot(
  store: Pick<StateStore, 'getCheckpoint'> | undefined,
  venue: VenueName,
  fingerprint: string
): Market[] | undefined {
  const checkpoint = store?.getCheckpoint(marketSnapshotCheckpointName(venue));
  if (!checkpoint?.value || typeof checkpoint.value !== 'object') return undefined;
  const value = checkpoint.value as { fingerprint?: unknown; capturedAt?: unknown; markets?: unknown };
  if (value.fingerprint !== fingerprint) return undefined;
  if (typeof value.capturedAt !== 'string') return undefined;
  const capturedAt = Date.parse(value.capturedAt);
  if (!Number.isFinite(capturedAt) || Date.now() - capturedAt > PERSISTED_MARKET_CACHE_MAX_AGE_MS) return undefined;
  if (!Array.isArray(value.markets)) return undefined;
  const markets = value.markets
    .map((item) => parsePublicMarketSnapshot(item, venue))
    .filter((item): item is Market => item !== undefined);
  return markets.length > 0 ? markets : undefined;
}

function publicMarketSnapshot(market: Market): Record<string, unknown> {
  return {
    venue: market.venue,
    tokenId: market.tokenId,
    ...(market.marketId ? { marketId: market.marketId } : {}),
    ...(market.eventId ? { eventId: market.eventId } : {}),
    question: market.question,
    ...(market.outcome ? { outcome: market.outcome } : {}),
    ...(market.outcomeIndex !== undefined ? { outcomeIndex: market.outcomeIndex } : {}),
    ...(market.outcomeCount !== undefined ? { outcomeCount: market.outcomeCount } : {}),
    ...(market.url ? { url: market.url } : {}),
    ...(market.slug ? { slug: market.slug } : {}),
    volume24hUsd: market.volume24hUsd,
    liquidityUsd: market.liquidityUsd,
    acceptingOrders: market.acceptingOrders,
    ...(market.startTime ? { startTime: market.startTime } : {}),
    ...(market.startTimeSource ? { startTimeSource: market.startTimeSource } : {}),
    ...(market.endTime ? { endTime: market.endTime } : {}),
    ...(market.endTimeSource ? { endTimeSource: market.endTimeSource } : {}),
    negRisk: market.negRisk,
    ...(market.yieldBearing !== undefined ? { yieldBearing: market.yieldBearing } : {}),
    feeRateBps: market.feeRateBps,
    tickSize: market.tickSize,
    ...(market.boosted !== undefined ? { boosted: market.boosted } : {}),
    ...(market.boostStartsAt ? { boostStartsAt: market.boostStartsAt } : {}),
    ...(market.boostEndsAt ? { boostEndsAt: market.boostEndsAt } : {}),
    ...(market.rewards ? { rewards: market.rewards } : {})
  };
}

function parsePublicMarketSnapshot(value: unknown, venue: VenueName): Market | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const row = value as Record<string, unknown>;
  if (row.venue !== venue) return undefined;
  if (typeof row.tokenId !== 'string' || row.tokenId.length === 0) return undefined;
  if (typeof row.question !== 'string') return undefined;
  const volume24hUsd = numberOrUndefined(row.volume24hUsd);
  const liquidityUsd = numberOrUndefined(row.liquidityUsd);
  const feeRateBps = numberOrUndefined(row.feeRateBps);
  const tickSize = numberOrUndefined(row.tickSize);
  if (volume24hUsd === undefined || liquidityUsd === undefined || feeRateBps === undefined || tickSize === undefined) return undefined;
  return {
    venue,
    tokenId: row.tokenId,
    ...(typeof row.marketId === 'string' ? { marketId: row.marketId } : {}),
    ...(typeof row.eventId === 'string' ? { eventId: row.eventId } : {}),
    question: row.question,
    ...(typeof row.outcome === 'string' ? { outcome: row.outcome } : {}),
    ...(numberOrUndefined(row.outcomeIndex) !== undefined ? { outcomeIndex: numberOrUndefined(row.outcomeIndex) } : {}),
    ...(numberOrUndefined(row.outcomeCount) !== undefined ? { outcomeCount: numberOrUndefined(row.outcomeCount) } : {}),
    ...(typeof row.url === 'string' ? { url: row.url } : {}),
    ...(typeof row.slug === 'string' ? { slug: row.slug } : {}),
    volume24hUsd,
    liquidityUsd,
    acceptingOrders: row.acceptingOrders === true,
    ...(typeof row.startTime === 'string' ? { startTime: row.startTime } : {}),
    ...(isStartTimeSource(row.startTimeSource) ? { startTimeSource: row.startTimeSource } : {}),
    ...(typeof row.endTime === 'string' ? { endTime: row.endTime } : {}),
    ...(isEndTimeSource(row.endTimeSource) ? { endTimeSource: row.endTimeSource } : {}),
    negRisk: row.negRisk === true,
    ...(typeof row.yieldBearing === 'boolean' ? { yieldBearing: row.yieldBearing } : {}),
    feeRateBps,
    tickSize,
    ...(typeof row.boosted === 'boolean' ? { boosted: row.boosted } : {}),
    ...(typeof row.boostStartsAt === 'string' ? { boostStartsAt: row.boostStartsAt } : {}),
    ...(typeof row.boostEndsAt === 'string' ? { boostEndsAt: row.boostEndsAt } : {}),
    ...(isRewardRules(row.rewards) ? { rewards: row.rewards } : {})
  };
}

function numberOrUndefined(value: unknown): number | undefined {
  return Number.isFinite(value) ? Number(value) : undefined;
}

function isStartTimeSource(value: unknown): value is Market['startTimeSource'] {
  return value === 'category-start' || value === 'market-start' || value === 'unknown';
}

function isEndTimeSource(value: unknown): value is Market['endTimeSource'] {
  return value === 'order-deadline'
    || value === 'market-end'
    || value === 'category-end'
    || value === 'resolution'
    || value === 'reward-end'
    || value === 'unknown';
}

function isRewardRules(value: unknown): value is Market['rewards'] {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  if (typeof row.enabled !== 'boolean') return false;
  return ['level', 'minShares', 'maxSpreadCents', 'ppPerHour', 'dailyRate', 'efficiency']
    .every((key) => row[key] === undefined || Number.isFinite(row[key]));
}

export function clearSharedMarketCache(): void {
  marketCache.clear();
  marketInflight.clear();
  orderbookCache.clear();
}

function sharedOrderbookCache(config: AppConfig, venue: VenueName): Map<string, Orderbook> {
  const key = `${venue}:${marketCacheFingerprint(config)}`;
  const cached = orderbookCache.get(key);
  if (cached) return cached;
  const created = new Map<string, Orderbook>();
  orderbookCache.set(key, created);
  return created;
}

function routeOrderbookCacheTtlMs(config: AppConfig): number {
  if (config.strategy.entryMode === 'cash' && Math.max(1, config.risk.maxMarkets) > 1) {
    return Math.max(
      MIN_ROUTE_ORDERBOOK_CACHE_TTL_MS,
      Math.min(MAX_ROUTE_ORDERBOOK_CACHE_TTL_MS, (config.strategy.marketRefreshMs ?? 60000) * 10)
    );
  }
  return Math.max(
    MIN_ROUTE_ORDERBOOK_CACHE_TTL_MS,
    Math.min(60000, config.strategy.marketRefreshMs ?? 60000)
  );
}

async function mapWithConcurrency<T>(
  items: T[],
  concurrency: number,
  task: (item: T) => Promise<void>
): Promise<void> {
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const item = items[nextIndex];
      nextIndex += 1;
      if (item !== undefined) await task(item);
    }
  }));
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
