import { ClobClient, OrderType, Side, SignatureTypeV2, type Chain } from '@polymarket/clob-client-v2';
import { Contract, FallbackProvider, JsonRpcProvider, MaxUint256, formatEther, formatUnits, parseUnits } from 'ethers';
import type { AppConfig } from '../config/schema.js';
import type { AccountRiskSnapshot, Balance, Market, OpenOrder, OrderIntent, OrderResult, Orderbook, Position, PreflightResult } from '../domain/types.js';
import type { SignerProvider } from '../secrets/signer.js';
import { LocalWalletSigner } from '../secrets/signer.js';
import { normalizePolymarketFill, normalizePolymarketOpenOrder, normalizePolymarketPosition } from './account-normalize.js';
import { extractList, httpJson } from './http.js';
import { buildOrderbook, inferRewardLevel, normalizePolymarketMarket, toFiniteNumber, toOptionalFiniteNumber, normalizeRewardSpread, toOptionalBoolean } from './normalize.js';
import { PolymarketWsClient } from './polymarket-ws.js';
import type { AuthResult, ApprovalGrantRequest, VenueAdapter } from './types.js';
import { accountEquityUsd } from '../risk/account-risk.js';

const POLY_WS_ORDERBOOK_MAX_AGE_MS = 1500;
const POLY_WS_ORDERBOOK_WAIT_MS = 1500;
// Watch-all cache read tolerance: WS pushes deliver every change, so a quiet market's last book stays valid
// well beyond the blocking window. Generous; a missing/stale book just falls back to REST.
const POLY_WS_WATCH_CACHE_MAX_AGE_MS = 60_000;
const POLYMARKET_CLOB_VERSION = 2;
const POLYMARKET_GAS_MIN_POL = 0.01;
// Reward-market universe: take the top-N CLOB sampling markets ranked by daily reward rate as the candidate pool,
// then enrich with gamma metadata. Bounds the gamma metadata fetch; the downstream book-scan/candidate cap is
// separate (maxMarkets*2 / candidateLimit), so a larger pool here adds no orderbook cost.
// Sized so the universe reaches past the crowded top-rate pools into low-competition ones — a small single-sided
// order only clears the $1/day per-market payout floor where its share of the reward pool is meaningful.
// Universe size: cover every market with a meaningful reward rate, not just the top ~240.
// At 800 we comfortably include everything down to ~$10/day, which is well past the long tail
// of markets a single-order bot can realistically earn in (~375 markets pay ≥$100/day total).
const POLYMARKET_REWARD_UNIVERSE_MAX = 800;
// Larger gamma batch = fewer round-trips when fetching the expanded universe.
// 60 condition_ids ≈ 4 KB URL, well under nginx's 8 KB default.
const POLYMARKET_GAMMA_CONDITION_BATCH = 60;
const POLYMARKET_REWARDS_TTL_MS = 10 * 60 * 1000;
// Safety cap on /sampling-simplified-markets pagination. ~7 pages cover the entire reward universe (~7000 markets);
// keeping a headroom of 12 protects against runaway looping if the API ever stops returning next_cursor=LTE=.
const POLYMARKET_SAMPLING_MAX_PAGES = 12;
// Bulk orderbook fetch batch size (POST /books). Empirically reliable up to ~20-30; 20 keeps a comfortable margin
// against per-request body limits and 403 spikes seen with larger payloads.
const POLYMARKET_BOOKS_BATCH_SIZE = 20;
// How many /books batches we send in parallel. Each batch is one POST; 5 parallel × ~250ms = ~1.3s per "round"
// of 100 tokens, so a full 941-market sweep (~47 batches) completes in ~12s — well inside the 45s cycle guard
// and the 8s per-call timeout. Higher concurrency risks tripping Polymarket's per-IP throttle.
const POLYMARKET_BOOKS_BATCH_CONCURRENCY = 5;
export const POLYMARKET_PUSD = '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB';
export const POLYMARKET_EXCHANGE_V2 = '0xE111180000d2663C0091e4f400237545B87B996B';
export const POLYMARKET_NEG_RISK_EXCHANGE_V2 = '0xe2222d279d744050d28e00520010520000310F59';
export const POLYMARKET_CONDITIONAL_TOKENS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
// Polygon RPC fallbacks (verified free, no API key). provider() builds a FallbackProvider over
// [config.rpcUrl, ...these] so one slow/down endpoint fails over instead of stalling balance/approval reads.
const POLYMARKET_RPC_FALLBACKS: Record<number, string[]> = {
  137: ['https://polygon.drpc.org', 'https://1rpc.io/matic']
};
const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)'
];
const ERC1155_ABI = [
  'function isApprovedForAll(address,address) view returns (bool)',
  'function setApprovalForAll(address,bool)',
  'function balanceOf(address,uint256) view returns (uint256)',
  'function balanceOfBatch(address[],uint256[]) view returns (uint256[])'
];
// Polymarket tick size can change as price reaches the extremes (price < 0.04 or > 0.96),
// so the authoritative CLOB tick is only cached briefly, not for the token's whole lifetime.
const POLY_TICK_CACHE_TTL_MS = 120000;
// Account-state (open orders / positions) REST responses are cached briefly and served while the authenticated user
// WS channel is healthy AND no order/trade event has arrived since the snapshot. WS events are an INVALIDATION
// SIGNAL only — REST stays the only state source, so a mis-mapped WS payload can never corrupt order state. The TTL
// bounds staleness if the channel looks healthy but silently dropped an event: worst-case detection delay = TTL.
const POLY_ACCOUNT_WS_CACHE_TTL_MS = 5000;
// When the data-api positions endpoint is unreachable (e.g. a proxy/DNS sinkhole), getPositions falls back to reading
// on-chain CTF balances for the bot's OWN tokens. A token stays eligible for that read for this long after it was last
// seen as an open order, so a maker fill (the order vanishes, a position appears) is still caught for several cycles.
const POLY_POSITION_FALLBACK_TOKEN_TTL_MS = 10 * 60_000;

export interface PolymarketAccountCache<T> {
  owner: string;
  value: T;
  at: number;
  seq: number;
}

/** Pure cache-serve decision for WS-invalidated account state (exported for tests). */
export function shouldServeWsAccountCache<T>(
  cache: PolymarketAccountCache<T> | undefined,
  owner: string,
  ws: { healthy: boolean; seq: number } | undefined,
  now: number,
  ttlMs = POLY_ACCOUNT_WS_CACHE_TTL_MS
): cache is PolymarketAccountCache<T> {
  if (!cache || !ws?.healthy) return false;
  return cache.owner === owner && cache.seq === ws.seq && now - cache.at <= ttlMs;
}

/**
 * Build positions from on-chain CTF (ERC1155) balances — the authoritative source for a wallet's holdings, used as a
 * fallback when the data-api positions endpoint is down. `rawBalances[i]` is the 6-decimal share balance of
 * `tokenIds[i]`. Zero/missing balances are dropped. averagePrice comes from the caller's best estimate (the resting
 * BUY price for a maker fill, or the last-known position avg); notionalUsd uses a neutral 0.5 mid when price unknown.
 */
export function positionsFromCtfBalances(
  tokenIds: string[],
  rawBalances: Array<bigint | number>,
  priceByToken: Map<string, number>
): Position[] {
  const positions: Position[] = [];
  for (let i = 0; i < tokenIds.length; i += 1) {
    const tokenId = tokenIds[i];
    const raw = rawBalances[i];
    if (tokenId === undefined || raw === undefined || raw === null) continue;
    const size = Number(raw) / 1e6;
    if (!(size > 0)) continue;
    const price = priceByToken.get(tokenId);
    const averagePrice = price !== undefined && Number.isFinite(price) && price > 0 ? price : undefined;
    positions.push({
      venue: 'polymarket',
      tokenId,
      size,
      notionalUsd: Number((size * (averagePrice ?? 0.5)).toFixed(6)),
      ...(averagePrice !== undefined ? { averagePrice } : {})
    });
  }
  return positions;
}

export class PolymarketVenue implements VenueAdapter {
  readonly name = 'polymarket' as const;
  private static readonly wsClients = new Map<string, PolymarketWsClient>();
  private rewardByToken = new Map<string, Market['rewards']>();
  /** CLOB sampling-set condition ids ranked by daily reward rate (desc) — the reward-market universe. */
  private rewardConditionIds: string[] = [];
  private rewardsLoadedAt = 0;
  private readonly tickByToken = new Map<string, { tick: number; ts: number }>();
  private credential?: { key: string; secret: string; passphrase: string };
  private lastL2Address?: string;
  private runtimeSigner?: LocalWalletSigner;
  // WS-invalidated REST caches (see POLY_ACCOUNT_WS_CACHE_TTL_MS): fast quote ticks read these instead of paying
  // ~1.2s + ~0.7s REST per tick; any user-channel order/trade event or own order action invalidates them instantly.
  private ordersCache?: PolymarketAccountCache<OpenOrder[]>;
  private positionsCache?: PolymarketAccountCache<Position[]>;
  private balancesCache?: PolymarketAccountCache<Balance[]>;
  // tokenId -> last time it was seen as an open order (ms). Feeds the on-chain positions fallback so a just-filled
  // order's token (which vanishes from open orders the instant it fills) is still probed on-chain for a position.
  private readonly recentOrderTokens = new Map<string, number>();

  /** Retain the signer so signer-less L2 calls still authenticate as the signer (needed for deposit-wallet flow). */
  setRuntimeSigner(signer: SignerProvider): void {
    if (signer instanceof LocalWalletSigner) this.runtimeSigner = signer;
  }

  constructor(
    private readonly config: AppConfig,
    credential?: { key: string; secret: string; passphrase: string }
  ) {
    this.credential = credential;
  }

  async testConnection(): Promise<boolean> {
    try {
      const [version] = await Promise.all([
        this.client().getVersion(),
        httpJson<any>(`${this.config.venues.polymarket.gammaUrl.replace(/\/+$/, '')}/markets?active=true&closed=false&limit=1`, { timeoutMs: 5000 })
      ]);
      return version === POLYMARKET_CLOB_VERSION;
    } catch {
      return false;
    }
  }

  async getMarkets(): Promise<Market[]> {
    await this.loadRewards();
    // Universe = Polymarket's AUTHORITATIVE reward sampling set (top-N by daily rate), enriched with gamma metadata.
    // A gamma-only scan picks big-volume NON-reward markets (gamma's reward tags are ~78% false positives), so the
    // router could never rank by real reward efficiency. Fall back to a plain gamma active scan if CLOB is down.
    const rewardCids = this.rewardConditionIds.slice(0, POLYMARKET_REWARD_UNIVERSE_MAX);
    if (rewardCids.length > 0) {
      try {
        const raws = (await this.fetchGammaMarketsByConditionIds(rewardCids))
          .filter((raw) => raw?.active !== false && raw?.closed !== true && raw?.archived !== true);
        // Affordability-aware ordering: a market only pays you if your order can meet its reward min-size (the soft
        // rule, ~20–100 shares). Rank markets the configured single order CAN afford first (preserving the daily-rate
        // order within each group), so the bounded scan + selection land on a market the order size can actually earn
        // in — instead of the biggest pools that need far more capital. The precise per-market checks still apply.
        const orderUsd = Math.max(0, this.config.risk.orderSizeUsd);
        const markets = raws
          .map((raw, index) => ({ raw, index, affordable: orderUsd <= 0 || this.rewardMinSizeUsd(raw) <= orderUsd + 1e-9 }))
          .sort((a, b) => (a.affordable === b.affordable ? a.index - b.index : a.affordable ? -1 : 1))
          .flatMap((entry) => normalizePolymarketMarket(entry.raw, this.rewardByToken))
          .filter((market) => market.tokenId);
        if (markets.length > 0) return markets;
      } catch {
        // fall through to the gamma active scan below
      }
    }
    return this.fetchGammaActiveMarkets();
  }

  /**
   * Estimate the USD a single order must reach to earn rewards in a market (the soft min-size rule): reward target
   * shares × the cheapest EARNING outcome price (clamped to the single-sided earn floor 0.10, below which a lone leg
   * scores ~0). Returns 0 when min-size is unknown (treated as affordable). Used only to rank the candidate universe.
   */
  private rewardMinSizeUsd(raw: any): number {
    let tokenIds: string[] = [];
    try { tokenIds = (Array.isArray(raw?.clobTokenIds) ? raw.clobTokenIds : JSON.parse(raw?.clobTokenIds ?? '[]')).map(String); } catch { tokenIds = []; }
    let minShares = 0;
    for (const tokenId of tokenIds) {
      const rule = this.rewardByToken.get(tokenId);
      if (rule?.minShares && rule.minShares > minShares) minShares = rule.minShares;
    }
    if (minShares <= 0) return 0;
    const multiplier = Math.max(1, this.config.strategy.minRewardSizeMultiplier ?? 1);
    const targetShares = minShares * multiplier + 1;
    let prices: number[] = [];
    try { prices = (Array.isArray(raw?.outcomePrices) ? raw.outcomePrices : JSON.parse(raw?.outcomePrices ?? '[]')).map(Number).filter((value: number) => Number.isFinite(value) && value > 0); } catch { prices = []; }
    const cheapestEarning = Math.max(0.10, prices.length ? Math.min(...prices) : 0.10);
    return targetShares * cheapestEarning;
  }

  /** Batch-fetch gamma market metadata for specific CLOB reward condition ids (gamma supports repeated condition_ids). */
  private async fetchGammaMarketsByConditionIds(conditionIds: string[]): Promise<any[]> {
    const base = this.config.venues.polymarket.gammaUrl.replace(/\/+$/, '');
    const out: any[] = [];
    for (let i = 0; i < conditionIds.length; i += POLYMARKET_GAMMA_CONDITION_BATCH) {
      const batch = conditionIds.slice(i, i + POLYMARKET_GAMMA_CONDITION_BATCH);
      const url = new URL(`${base}/markets`);
      url.searchParams.set('closed', 'false');
      url.searchParams.set('limit', String(batch.length));
      for (const cid of batch) url.searchParams.append('condition_ids', cid);
      try {
        for (const raw of extractList(await httpJson<any>(url.toString()))) {
          if (Array.isArray(raw?.markets)) for (const child of raw.markets) out.push({ ...raw, ...child });
          else out.push(raw);
        }
      } catch {
        // skip a failed batch, keep the rest
      }
    }
    return out;
  }

  /** Fallback universe when the CLOB reward set is unavailable: a plain gamma active scan (legacy behaviour). */
  private async fetchGammaActiveMarkets(): Promise<Market[]> {
    const url = new URL(`${this.config.venues.polymarket.gammaUrl.replace(/\/+$/, '')}/markets`);
    url.searchParams.set('active', 'true');
    url.searchParams.set('closed', 'false');
    url.searchParams.set('limit', '120');
    const payload = await httpJson<any>(url.toString());
    return extractList(payload)
      .flatMap((raw) => Array.isArray(raw?.markets) ? raw.markets.map((child: any) => ({ ...raw, ...child })) : [raw])
      .filter((raw) => raw?.active !== false && raw?.closed !== true && raw?.archived !== true)
      .flatMap((raw) => normalizePolymarketMarket(raw, this.rewardByToken))
      .filter((market) => market.tokenId);
  }

  async getOrderbook(tokenId: string) {
    if (this.config.venues.polymarket.useWsOrderbook) {
      try {
        return await this.wsClient().getOrderbook(tokenId, POLY_WS_ORDERBOOK_MAX_AGE_MS, POLY_WS_ORDERBOOK_WAIT_MS);
      } catch {
        // Any WS error / staleness / failed sanity check falls back to REST below.
      }
    }
    const url = new URL(`${this.config.venues.polymarket.clobUrl.replace(/\/+$/, '')}/book`);
    url.searchParams.set('token_id', tokenId);
    return buildOrderbook(this.name, tokenId, await httpJson<any>(url.toString()));
  }

  /**
   * WS watch-all support (same optimization as Predict): batch-subscribe the scanned markets so their books
   * arrive via push and are read from cache for free. Gated by the existing useWsOrderbook flag so it only runs
   * once you've verified the WS in your environment; off => these no-op and the venue keeps using REST.
   */
  watchMarkets(markets: Market[]): void {
    if (!this.config.venues.polymarket.useWsOrderbook) return;
    const tokenIds = [...new Set(markets
      .filter((market) => market.venue === 'polymarket' && market.tokenId)
      .map((market) => market.tokenId))];
    if (tokenIds.length === 0) return;
    void this.wsClient().reconcileMarkets(tokenIds).catch(() => undefined);
  }

  getCachedOrderbook(tokenId: string): Orderbook | undefined {
    if (!this.config.venues.polymarket.useWsOrderbook) return undefined;
    return this.wsClient().getCachedOrderbook(tokenId, POLY_WS_WATCH_CACHE_MAX_AGE_MS);
  }

  /** Seed WS cache with a REST-fetched book (cold-subscription rescue). */
  primeBook(tokenId: string, book: Orderbook): void {
    if (!this.config.venues.polymarket.useWsOrderbook) return;
    this.wsClient().primeBook(tokenId, book);
  }

  /** REST-only orderbook fetch (skips the WS wait) for watch-all cache misses. */
  async getOrderbookRest(tokenId: string): Promise<Orderbook> {
    const url = new URL(`${this.config.venues.polymarket.clobUrl.replace(/\/+$/, '')}/book`);
    url.searchParams.set('token_id', tokenId);
    return buildOrderbook(this.name, tokenId, await httpJson<any>(url.toString()));
  }

  /**
   * Bulk orderbook fetch via Polymarket's POST /books. Returns a Map keyed by tokenId; missing tokens (no usable
   * book in the response) are simply absent from the Map so the caller can fall back to single /book for them.
   *
   * Why this exists: the scan loop without this is bottlenecked at ~5 single /book calls/sec on a 941-market
   * universe, never reaching the route-audit coverage gate. Batched /books returns dozens of books per round-trip
   * and lifts the universe coverage from ~18% (stuck) to >30% within minutes.
   *
   * Per-request batch is bounded by POLYMARKET_BOOKS_BATCH_SIZE to stay well under Polymarket's per-request body
   * limit (empirically ~20-30 tokens is reliably accepted). Network / HTTP / parse failure throws — the caller
   * MUST catch and fall back to single-fetch so a venue outage never silently drops markets from scan coverage.
   */
  async getOrderbooksBatch(tokenIds: string[]): Promise<Map<string, Orderbook>> {
    const unique = [...new Set(tokenIds.filter(Boolean))];
    const results = new Map<string, Orderbook>();
    if (unique.length === 0) return results;
    const url = `${this.config.venues.polymarket.clobUrl.replace(/\/+$/, '')}/books`;
    // Slice into bounded batches, then run several batches in parallel. Each batch has its own try/catch so a
    // transient HTTP failure on one batch drops only that slice (caller falls back to single /book for those
    // tokens) — partial success is preserved instead of throwing away the work the other batches did.
    const batches: string[][] = [];
    for (let i = 0; i < unique.length; i += POLYMARKET_BOOKS_BATCH_SIZE) {
      batches.push(unique.slice(i, i + POLYMARKET_BOOKS_BATCH_SIZE));
    }
    let cursor = 0;
    const workers = Array.from({ length: Math.min(POLYMARKET_BOOKS_BATCH_CONCURRENCY, batches.length) }, async () => {
      while (cursor < batches.length) {
        const idx = cursor;
        cursor += 1;
        const batch = batches[idx]!;
        try {
          const body = JSON.stringify(batch.map((tokenId) => ({ token_id: tokenId })));
          const payload = await httpJson<any>(url, { method: 'POST', body });
          // /books returns either a top-level array of book objects, OR an object with a `books`/`data` field. Be
          // generous in what we accept so future minor schema tweaks don't break the parse.
          const items: any[] = Array.isArray(payload)
            ? payload
            : Array.isArray(payload?.books)
              ? payload.books
              : Array.isArray(payload?.data)
                ? payload.data
                : [];
          for (const item of items) {
            const id = String(item?.asset_id ?? item?.token_id ?? item?.tokenId ?? '');
            if (!id) continue;
            if (!Array.isArray(item?.bids) && !Array.isArray(item?.asks)) continue;
            results.set(id, buildOrderbook(this.name, id, item));
          }
        } catch { /* per-batch failure: tokens in this slice fall back to single-fetch in the caller */ }
      }
    });
    await Promise.all(workers);
    return results;
  }

  wsWatchStats(): { connected: boolean; watchedMarkets: number; cachedOrderbooks: number } {
    return this.wsClient().stats();
  }

  /** Best-effort, idempotent subscribe to the authenticated user channel for real-time fills. Off unless useWsOrderbook + creds. */
  private primeUserStream(): void {
    if (!this.config.venues.polymarket.useWsOrderbook || !this.credential) return;
    void this.wsClient().subscribeUser(this.credential, []).catch(() => undefined);
  }

  /** Real-time order/trade events captured from the user channel (raw, for observability / faster fill awareness). */
  recentUserEvents(limit = 50): Array<{ type: string; data: unknown; receivedAt: number }> {
    return this.wsClient().recentUserEvents(limit);
  }

  /** Engine-layer hook for "venue pushed me a fill, ledger it now". The listener fires for every order / trade
   *  event the user channel delivers, including buffered events that arrived before the listener was registered
   *  (so a startup race doesn't lose fills). Passing undefined clears the listener. */
  setUserEventListener(listener: import('./polymarket-ws.js').PolymarketUserEventListener | undefined): void {
    this.wsClient().setUserEventListener(listener);
  }

  /** Pass-through to the market-channel WS book-update hook. Engine wires this so it can re-run placement
   *  protections in real-time the moment the orderbook moves, instead of waiting for the next ~16s cycle. */
  setBookUpdateListener(listener: import('./polymarket-ws.js').PolymarketBookUpdateListener | undefined): void {
    this.wsClient().setBookUpdateListener(listener);
  }

  /** True if the user channel disconnected since the engine last consumed the flag. The engine reads this each
   *  cycle and, when true, forces a REST account-state reconcile as a belt-and-suspenders catch-up for fills that
   *  may have arrived while the WS was down. */
  consumeUserChannelDisconnectFlag(): number {
    return this.wsClient().consumeUserDisconnectedFlag();
  }

  private wsClient(): PolymarketWsClient {
    const url = this.config.venues.polymarket.wsUrl;
    let client = PolymarketVenue.wsClients.get(url);
    if (!client) {
      client = new PolymarketWsClient(url);
      PolymarketVenue.wsClients.set(url, client);
    }
    return client;
  }

  static closeSharedWsClients(): void {
    for (const client of PolymarketVenue.wsClients.values()) client.close();
    PolymarketVenue.wsClients.clear();
  }

  async getBalances(address: string, signer?: SignerProvider): Promise<Balance[]> {
    const owner = this.config.venues.polymarket.funderAddress || signer?.address || address;
    if (!/^0x[a-fA-F0-9]{40}$/.test(owner)) return [];
    // Balance only moves on order placement/cancel (collateral lock) or fills — the same user-channel events that
    // invalidate the other account caches. External deposits are bounded by the cache TTL.
    const wsBalances = this.userCacheState('account');
    if (shouldServeWsAccountCache(this.balancesCache, owner, wsBalances, Date.now())) {
      return this.balancesCache.value.map((balance) => ({ ...balance }));
    }
    const balancesSeqBefore = wsBalances?.seq;
    const storeBalances = (balances: Balance[]): Balance[] => {
      if (balancesSeqBefore !== undefined && balances.length > 0) {
        this.balancesCache = { owner, value: balances.map((balance) => ({ ...balance })), at: Date.now(), seq: balancesSeqBefore };
      }
      return balances;
    };
    // Deposit-wallet / proxy flow (signatureType != 0): the TRADEABLE collateral is what the CLOB reports via
    // getBalanceAllowance — the raw on-chain balanceOf of a Polymarket-managed deposit wallet is not it (often 0
    // for an undeployed funder). Mirrors py-clob-client's get_balance_allowance(COLLATERAL).
    if (this.config.venues.polymarket.signatureType !== 0 && signer instanceof LocalWalletSigner) {
      try {
        if (!this.credential) await this.authenticate(signer);
        const ba: any = await this.client(signer).getBalanceAllowance({ asset_type: 'COLLATERAL' } as any);
        const value = Number(ba?.balance ?? 0) / 1e6;
        return storeBalances([{ asset: 'pUSD', available: value, total: value }]);
      } catch {
        // fall through to on-chain read
      }
    }
    try {
      const balance = await this.pusdContract().balanceOf(owner);
      const value = Number(formatUnits(balance, 6));
      return storeBalances([{ asset: 'pUSD', available: value, total: value }]);
    } catch {
      return [];
    }
  }

  async getPositions(address: string): Promise<Position[]> {
    const owner = this.tradingAddress(address);
    this.primeUserStream();
    const ws = this.userCacheState('trade');
    if (shouldServeWsAccountCache(this.positionsCache, owner, ws, Date.now())) {
      return this.positionsCache.value.map((position) => ({ ...position }));
    }
    const seqBefore = ws?.seq;
    const url = new URL(`${this.config.venues.polymarket.dataApiUrl.replace(/\/+$/, '')}/positions`);
    url.searchParams.set('user', owner);
    try {
      const payload = await httpJson<any>(url.toString());
      const positions = extractList(payload)
        .map((item) => normalizePolymarketPosition(item))
        .filter((position): position is Position => position !== undefined);
      // Store with the seq captured BEFORE the REST flight: an event landing mid-flight bumps the live seq past this
      // snapshot, so the next read refetches instead of trusting a possibly-pre-event response.
      if (seqBefore !== undefined) {
        this.positionsCache = { owner, value: positions.map((position) => ({ ...position })), at: Date.now(), seq: seqBefore };
      }
      return positions;
    } catch (error) {
      // data-api unreachable (e.g. a proxy/DNS sinkhole — see the polymarket-dataapi-proxy memory). Fall back to
      // on-chain CTF balances, which are THE authoritative source for this wallet's holdings. Only the bot's own
      // tokens (recent open orders + last-known positions) are queried — exactly the set a maker fill could create a
      // position on — so the fill circuit-breaker / single-leg detection keep working. If there is nothing to query,
      // or the chain read also fails, rethrow so the engine keeps its safe positions.unavailable stall.
      const tokens = this.fallbackPositionTokens();
      if (tokens.length === 0) throw error;
      const onChain = await this.getPositionsOnChainFallback(owner, tokens);
      if (seqBefore !== undefined) {
        this.positionsCache = { owner, value: onChain.map((position) => ({ ...position })), at: Date.now(), seq: seqBefore };
      }
      return onChain;
    }
  }

  async getOpenOrders(address: string): Promise<OpenOrder[]> {
    if (!this.credential) return [];
    this.primeUserStream();
    const owner = this.tradingAddress(address);
    this.lastL2Address = owner;
    const ws = this.userCacheState('account');
    if (shouldServeWsAccountCache(this.ordersCache, owner, ws, Date.now())) {
      return this.ordersCache.value.map((order) => ({ ...order }));
    }
    const seqBefore = ws?.seq;
    const client = this.client(undefined, owner);
    const clientAny = client as any;
    if (typeof clientAny.getOpenOrders !== 'function') return [];
    const response = await clientAny.getOpenOrders({ owner });
    const orders = extractList(response)
      .map((order) => normalizePolymarketOpenOrder(order))
      .filter((order): order is OpenOrder => order !== undefined);
    this.trackRecentOrderTokens(orders);
    if (seqBefore !== undefined) {
      this.ordersCache = { owner, value: orders.map((order) => ({ ...order })), at: Date.now(), seq: seqBefore };
    }
    return orders;
  }

  /**
   * User-channel state for cache decisions. Returns undefined (= never serve cache) unless the WS orderbook feature
   * is on and the channel is connected-and-fresh. 'account' keys on order+trade events, 'trade' on fills only.
   */
  private userCacheState(kind: 'account' | 'trade'): { healthy: boolean; seq: number } | undefined {
    if (!this.config.venues.polymarket.useWsOrderbook || !this.credential) return undefined;
    const state = this.wsClient().userChannelState();
    return { healthy: state.healthy, seq: kind === 'account' ? state.accountEventsSeq : state.tradeEventsSeq };
  }

  /** Own order actions change account state deterministically — drop caches without waiting for the WS echo. */
  private invalidateAccountCaches(): void {
    this.ordersCache = undefined;
    this.positionsCache = undefined;
  }

  async getAccountRiskSnapshot(address: string, signer: SignerProvider, sinceTs: number): Promise<AccountRiskSnapshot> {
    if (!this.credential) throw new Error('Polymarket CLOB credentials are required for account risk snapshot. Run mm auth polymarket first.');
    const owner = this.tradingAddress(address || signer.address);
    const [tradesPayload, positions, valuePayload, balances] = await Promise.all([
      this.fetchUserTrades(owner, sinceTs),
      this.getPositions(owner),
      this.fetchUserValue(owner),
      this.getBalances(owner, signer)
    ]);
    const fills = extractList(tradesPayload)
      .map((item, index) => normalizePolymarketFill(item, index))
      .filter((fill) => fill.ts >= sinceTs);
    const positionValueUsd = positions.reduce((sum, position) => sum + finiteOrZero(position.notionalUsd), 0);
    const valueUsd = finiteOrUndefined(toFiniteNumber(valuePayload?.value, valuePayload?.totalValue, valuePayload?.currentValue));
    const equityUsd = pickPolymarketEquityUsd(valueUsd, balances, positionValueUsd);
    const realizedPnlUsd = sumDefined([
      finiteOrUndefined(toFiniteNumber(valuePayload?.realizedPnl, valuePayload?.realizedPnlUsd)),
      ...fills.map((fill) => fill.realizedPnlUsd)
    ]);
    const unrealizedPnlUsd = finiteOrUndefined(toFiniteNumber(valuePayload?.unrealizedPnl, valuePayload?.unrealizedPnlUsd));
    const netCashflowUsd = sumDefined(fills.map((fill) => fill.cashflowUsd));
    const feesUsd = sumDefined(fills.map((fill) => fill.feeUsd));
    const warnings: string[] = [];
    if (fills.length === 0) warnings.push('Polymarket trades API returned no same-day fill records.');
    if (realizedPnlUsd === undefined && unrealizedPnlUsd === undefined && equityUsd === undefined && netCashflowUsd === undefined) {
      warnings.push('Polymarket account endpoints did not expose PnL/cashflow/equity fields.');
    }
    return {
      venue: this.name,
      account: owner,
      source: 'venue',
      capturedAt: Date.now(),
      dayStart: sinceTs,
      ...(equityUsd !== undefined ? { equityUsd } : {}),
      ...(realizedPnlUsd !== undefined ? { realizedPnlUsd } : {}),
      ...(unrealizedPnlUsd !== undefined ? { unrealizedPnlUsd } : {}),
      ...(netCashflowUsd !== undefined ? { netCashflowUsd } : {}),
      ...(feesUsd !== undefined ? { feesUsd } : {}),
      fills,
      positions,
      balances,
      warnings,
      raw: { tradeCount: extractList(tradesPayload).length, value: valuePayload }
    };
  }

  async preflight(signer: SignerProvider, _tokenIds: string[] = []): Promise<PreflightResult> {
    const funder = this.config.venues.polymarket.funderAddress || signer.address;
    const sigType = this.config.venues.polymarket.signatureType;
    // signatureType 1/2 (Polymarket proxy) and 3 (Gnosis Safe) traditionally need a proxy/Safe-aware signer
    // that supplies the funder wallet's signing strategy (EIP-1271 for Safe, proxy-relayed for type 2). The
    // strict pre-block check ("fail closed if LocalWalletSigner + sigType≠0") had to be relaxed when actual
    // production usage on this account proved that sigType=3 with an EOA signer DOES work end-to-end against
    // Polymarket — observed 24h with 495 successful order submissions on this exact combo. The CLOB accepts
    // the signature because the funder address is a Polymarket-deployed proxy whose owner is the EOA signer.
    // We still warn loudly when the combination LOOKS suspicious so an operator can spot a real Safe-key
    // misconfiguration, but we no longer block startup on this check.
    const sigTypeValid = [0, 1, 2, 3].includes(sigType);
    const eoa = signer instanceof LocalWalletSigner;
    const looksOrthodox = sigTypeValid && (sigType === 0 ? eoa : !eoa);
    const sigTypeMessage = !sigTypeValid
      ? `signatureType ${sigType} 非法（必须 0|1|2|3）— 拒绝启动`
      : looksOrthodox
        ? `${sigType}${eoa ? '（EOA 兼容）' : '（proxy/Safe 兼容签名器）'}`
        : sigType === 0
          ? `signatureType=0 但 signer 不是 LocalWalletSigner — 罕见组合,启动前请确认`
          : `signatureType=${sigType} + LocalWalletSigner（EOA）— 生产证明这个组合在某些 Polymarket 部署下可行（funder=proxy/Safe，owner=EOA），允许启动但若实际下单全部失败请检查 funderAddress`;
    const checks: PreflightResult['checks'] = [
      { name: 'clob-credentials', ok: Boolean(this.credential), message: this.credential ? 'loaded from encrypted credential' : 'missing; run mm auth polymarket' },
      { name: 'signer-address', ok: /^0x[a-fA-F0-9]{40}$/.test(signer.address), message: signer.address },
      { name: 'funder-address', ok: /^0x[a-fA-F0-9]{40}$/.test(funder), message: funder },
      // signature-type check only HARD-BLOCKS on a literally-invalid sigType number. Mixed-orthodoxy combos
      // (sigType=3 + EOA) get the warning text in the message but ok:true so live can start. The compatibility
      // is now a runtime fact established by empirical production usage on this account.
      { name: 'signature-type', ok: sigTypeValid, message: sigTypeMessage }
    ];
    try {
      const version = await this.client().getVersion();
      checks.push({ name: 'clob-version', ok: version === POLYMARKET_CLOB_VERSION, message: `production=${version}, required=${POLYMARKET_CLOB_VERSION}` });
    } catch (error) {
      checks.push({ name: 'clob-version', ok: false, message: error instanceof Error ? error.message : String(error) });
    }
    try {
      const geoblock = await polymarketGeoblock();
      let closedOnly: boolean | undefined;
      if (geoblock.country === 'JP' && this.credential) {
        try {
          const response = await this.client(undefined, funder).getClosedOnlyMode();
          closedOnly = polymarketClosedOnlyValue(response);
        } catch {
          closedOnly = undefined;
        }
      }
      const decision = polymarketGeoTradingDecision(geoblock, closedOnly);
      checks.push({
        name: 'geoblock',
        ok: decision.ok,
        message: decision.message
      });
    } catch (error) {
      checks.push({ name: 'geoblock', ok: false, message: error instanceof Error ? error.message : String(error) });
    }
    try {
      const gas = await this.getNativeGasBalance(signer, POLYMARKET_GAS_MIN_POL);
      checks.push({ name: 'polygon-gas', ok: gas.ok, message: gas.message });
      const balances = await this.getBalances(funder, signer);
      const pusd = balances[0]?.available ?? 0;
      checks.push({ name: 'pusd-balance', ok: pusd > 0, message: `${pusd.toFixed(6)} pUSD` });
    } catch (error) {
      checks.push({ name: 'chain-balance', ok: false, message: error instanceof Error ? error.message : String(error) });
    }
    if (this.credential) {
      try {
        const orders = await this.getOpenOrders(funder);
        checks.push({ name: 'open-order-sync', ok: true, message: `${orders.length} open orders` });
      } catch (error) {
        checks.push({ name: 'open-order-sync', ok: false, message: error instanceof Error ? error.message : String(error) });
      }
    }
    if (this.config.strategy.onFillAction === 'sellAllAtMarket') {
      checks.push({ name: 'liquidation-capability', ok: false, message: 'Polymarket 未接入完整套仓合并退出，实盘必须使用 onFillAction=hold' });
    } else {
      checks.push({ name: 'liquidation-capability', ok: true, message: 'onFillAction=hold；Polymarket 不会自动市价卖出' });
    }
    return {
      ok: checks.every((check) => check.ok),
      venue: this.name,
      signerAddress: signer.address,
      makerAddress: funder,
      checks
    };
  }

  async authenticate(signer: SignerProvider): Promise<AuthResult> {
    if (!(signer instanceof LocalWalletSigner)) throw new Error('Polymarket auth requires local wallet signer.');
    this.runtimeSigner = signer;
    const credential = await deriveOrCreatePolymarketCredential(this.client(signer) as any);
    this.credential = credential;
    return { venue: this.name, name: 'clob', credential, summary: `Polymarket CLOB credentials ready for ${signer.address}` };
  }

  async inspectApprovals(signer: SignerProvider, _tokenId?: string): Promise<PreflightResult> {
    const funder = this.config.venues.polymarket.funderAddress || signer.address;
    const checks = [
      { name: 'signer', ok: /^0x[a-fA-F0-9]{40}$/.test(signer.address), message: signer.address },
      { name: 'funder', ok: /^0x[a-fA-F0-9]{40}$/.test(funder), message: funder },
      { name: 'clob-credentials', ok: Boolean(this.credential), message: this.credential ? 'loaded' : 'missing; run auth polymarket before live trading' }
    ];
    // Deposit-wallet / proxy flow (signatureType != 0): approvals are managed by Polymarket. The authoritative
    // source is the CLOB's getBalanceAllowance (on-chain reads of the managed funder are not meaningful and read 0).
    if (this.config.venues.polymarket.signatureType !== 0 && signer instanceof LocalWalletSigner) {
      try {
        if (!this.credential) await this.authenticate(signer);
        const ba: any = await this.client(signer).getBalanceAllowance({ asset_type: 'COLLATERAL' } as any);
        const allowances: Record<string, unknown> = ba?.allowances ?? {};
        const allowOf = (addr: string): number => {
          for (const [key, value] of Object.entries(allowances)) {
            if (key.toLowerCase() === addr.toLowerCase()) return Number(value) || 0;
          }
          return 0;
        };
        const exAllow = allowOf(POLYMARKET_EXCHANGE_V2);
        const negAllow = allowOf(POLYMARKET_NEG_RISK_EXCHANGE_V2);
        checks.push({ name: 'pusd-exchange-v2', ok: exAllow > 0, message: exAllow > 0 ? '普通市场 pUSD 授权充足(CLOB)' : '普通市场 pUSD 未授权(CLOB)' });
        checks.push({ name: 'pusd-neg-risk-v2', ok: negAllow > 0, message: negAllow > 0 ? 'Neg-Risk pUSD 授权充足(CLOB)' : 'Neg-Risk pUSD 未授权(CLOB)' });
        // CTF approval for a managed deposit wallet is handled by Polymarket; two-sided LP is BUY-only so CTF
        // isn't required to PLACE orders (only matters for SELL/exit). Don't block placement on it.
        checks.push({ name: 'ctf-exchange-v2', ok: true, message: '存款钱包流程:CTF 由 Polymarket 托管(双边 LP 只挂 BUY,挂单不需要)' });
        checks.push({ name: 'ctf-neg-risk-v2', ok: true, message: '存款钱包流程:CTF 由 Polymarket 托管' });
        return { ok: checks.every((check) => check.ok), venue: this.name, signerAddress: signer.address, makerAddress: funder, checks };
      } catch (error) {
        checks.push({ name: 'balance-allowance', ok: false, message: error instanceof Error ? error.message : String(error) });
        return { ok: false, venue: this.name, signerAddress: signer.address, makerAddress: funder, checks };
      }
    }
    try {
      const token = this.pusdContract();
      const [exchangeAllowance, negRiskAllowance] = await Promise.all([
        token.allowance(funder, POLYMARKET_EXCHANGE_V2),
        token.allowance(funder, POLYMARKET_NEG_RISK_EXCHANGE_V2)
      ]);
      checks.push(allowanceCheck('pusd-exchange-v2', exchangeAllowance, '普通市场 pUSD'));
      checks.push(allowanceCheck('pusd-neg-risk-v2', negRiskAllowance, 'Neg-Risk 市场 pUSD'));
    } catch (error) {
      checks.push({ name: 'pusd-allowance', ok: false, message: error instanceof Error ? error.message : String(error) });
    }
    try {
      const ctf = this.ctfContract();
      const [exchangeApproved, negRiskApproved] = await Promise.all([
        ctf.isApprovedForAll(funder, POLYMARKET_EXCHANGE_V2),
        ctf.isApprovedForAll(funder, POLYMARKET_NEG_RISK_EXCHANGE_V2)
      ]);
      checks.push({ name: 'ctf-exchange-v2', ok: exchangeApproved, message: exchangeApproved ? '普通市场 outcome token 已授权' : '普通市场 outcome token 未授权，SELL/止损会失败' });
      checks.push({ name: 'ctf-neg-risk-v2', ok: negRiskApproved, message: negRiskApproved ? 'Neg-Risk outcome token 已授权' : 'Neg-Risk outcome token 未授权，SELL/止损会失败' });
    } catch (error) {
      checks.push({ name: 'ctf-allowance', ok: false, message: error instanceof Error ? error.message : String(error) });
    }
    return { ok: checks.every((check) => check.ok), venue: this.name, signerAddress: signer.address, makerAddress: funder, checks };
  }

  private async ctfApprovalCheck(tokenId?: string): Promise<{ name: string; ok: boolean; message: string }> {
    let token = tokenId;
    if (!token) {
      try { await this.loadRewards(); } catch { /* best-effort token discovery */ }
      token = [...this.rewardByToken.keys()][0];
    }
    const allowance = token ? await this.conditionalAllowance(token, this.lastL2Address) : undefined;
    return ctfApprovalCheckResult(allowance, Boolean(token));
  }

  /**
   * Resolve the authoritative CLOB tick size for a token (cached). Polymarket tick
   * sizes vary per market/price and stale metadata gets orders rejected, so we trust
   * the CLOB value and only fall back to metadata / 0.01 when it is unavailable.
   */
  private async resolveTickSize(tokenId: string, fallback?: number): Promise<number> {
    const cached = this.tickByToken.get(tokenId);
    if (cached && Date.now() - cached.ts < POLY_TICK_CACHE_TTL_MS) return cached.tick;
    try {
      const clientAny = this.client(undefined) as any;
      if (typeof clientAny.getTickSize === 'function') {
        const tick = toOptionalFiniteNumber(await clientAny.getTickSize(tokenId));
        if (tick !== undefined && tick > 0 && tick <= 0.1) {
          this.tickByToken.set(tokenId, { tick, ts: Date.now() });
          return tick;
        }
      }
    } catch {
      // fall back to the last good tick / metadata tick below
    }
    return cached?.tick ?? (fallback && fallback > 0 ? fallback : 0.01);
  }

  private async conditionalAllowance(tokenId: string, address?: string): Promise<number | undefined> {
    if (!this.credential) return undefined;
    if (address) this.lastL2Address = address;
    const clientAny = this.client(undefined, address ?? this.lastL2Address) as any;
    if (typeof clientAny.getBalanceAllowance !== 'function') return undefined;
    try {
      const response = await clientAny.getBalanceAllowance({ asset_type: 'CONDITIONAL', token_id: tokenId });
      return polymarketAllowanceValue(response);
    } catch {
      return undefined;
    }
  }

  async getNativeGasBalance(signer: SignerProvider, required = POLYMARKET_GAS_MIN_POL) {
    const balance = Number(formatEther(await this.provider().getBalance(signer.address)));
    return {
      asset: 'POL',
      balance,
      address: signer.address,
      required,
      requiredSource: 'configured' as const,
      ok: balance >= required,
      message: `${balance.toFixed(6)} POL / required ${required.toFixed(6)} POL`
    };
  }

  async grantApprovals(signer: SignerProvider, request: ApprovalGrantRequest): Promise<PreflightResult> {
    if (!(signer instanceof LocalWalletSigner)) throw new Error('Polymarket approval grant requires local wallet signer.');
    if (!request.confirm) throw new Error('Polymarket approval grant requires explicit confirmation.');
    if (!Number.isFinite(request.amountUsd) || request.amountUsd <= 0) throw new Error('Approval amount must be positive.');
    if (!request.tokenId) throw new Error('Polymarket approval grant requires a token id to select the exact V2 exchange.');
    const wallet = signer.unsafeEthersWalletForTransactions().connect(this.provider());
    const pusd: any = new Contract(POLYMARKET_PUSD, ERC20_ABI, wallet);
    const ctf: any = new Contract(POLYMARKET_CONDITIONAL_TOKENS, ERC1155_ABI, wallet);
    const amount = parseUnits(request.amountUsd.toFixed(6), 6);
    const negRisk = await this.client(signer).getNegRisk(request.tokenId);
    const spender = polymarketApprovalTarget(negRisk);
    const transactions: string[] = [];
    const current = await pusd.allowance(signer.address, spender);
    if (current !== amount) {
      const tx = await pusd.approve(spender, amount);
      transactions.push(tx.hash);
      await tx.wait();
    }
    if (request.includeConditionalTokens && !(await ctf.isApprovedForAll(signer.address, spender))) {
        const tx = await ctf.setApprovalForAll(spender, true);
        transactions.push(tx.hash);
        await tx.wait();
    }
    if (this.credential) {
      await this.client(signer).updateBalanceAllowance({ asset_type: 'COLLATERAL' as any });
    }
    const finalAllowance = await pusd.allowance(signer.address, spender);
    const checks: PreflightResult['checks'] = [
      { name: 'signer', ok: true, message: signer.address },
      {
        name: negRisk ? 'pusd-neg-risk-v2' : 'pusd-exchange-v2',
        ok: finalAllowance === amount,
        message: `${negRisk ? 'Neg-Risk' : '普通'}市场 allowance=${Number(formatUnits(finalAllowance, 6)).toFixed(6)} pUSD`
      }
    ];
    if (request.includeConditionalTokens) {
      const approved = await ctf.isApprovedForAll(signer.address, spender);
      checks.push({
        name: negRisk ? 'ctf-neg-risk-v2' : 'ctf-exchange-v2',
        ok: approved,
        message: approved ? 'outcome token 已授权' : 'outcome token 未授权'
      });
    }
    return {
      ok: checks.every((check) => check.ok),
      venue: this.name,
      signerAddress: signer.address,
      makerAddress: signer.address,
      checks: [
        ...checks,
        { name: 'approval-transactions', ok: true, message: transactions.length ? transactions.join(',') : 'already exact' }
      ]
    };
  }

  /**
   * One-shot trading approvals for BOTH V2 exchanges (normal + neg-risk): bounded pUSD allowance + CTF
   * setApprovalForAll. Triggered by an explicit user click in the UI so the on-chain transactions are
   * user-initiated. Idempotent — only sends a tx where the current state is below target.
   */
  async grantTradingApprovals(signer: SignerProvider, amountUsd = 100): Promise<{ ok: boolean; checks: PreflightResult['checks']; txHashes: string[] }> {
    if (!(signer instanceof LocalWalletSigner)) throw new Error('Polymarket approval grant requires local wallet signer.');
    const wallet = signer.unsafeEthersWalletForTransactions().connect(this.provider());
    const pusd: any = new Contract(POLYMARKET_PUSD, ERC20_ABI, wallet);
    const ctf: any = new Contract(POLYMARKET_CONDITIONAL_TOKENS, ERC1155_ABI, wallet);
    // Grant an UNLIMITED pUSD allowance to both V2 exchanges (matches the Polymarket UI) so resting-order over-rest is
    // never capped by allowance. We no longer grant the bounded `amountUsd`; it is kept only as a floor that forces a
    // re-approval, while an allowance that is already effectively unlimited is left untouched (idempotent — no tx).
    const minRequired = parseUnits(Math.max(1, amountUsd).toFixed(6), 6);
    const alreadyUnlimited = MaxUint256 / 2n;
    const spenders: Array<{ name: string; address: string }> = [
      { name: 'exchange', address: POLYMARKET_EXCHANGE_V2 },
      { name: 'neg-risk', address: POLYMARKET_NEG_RISK_EXCHANGE_V2 }
    ];
    const txHashes: string[] = [];
    for (const { address: spender } of spenders) {
      const current = await pusd.allowance(signer.address, spender);
      if (current < alreadyUnlimited || current < minRequired) {
        const tx = await pusd.approve(spender, MaxUint256);
        txHashes.push(tx.hash);
        await tx.wait();
      }
      if (!(await ctf.isApprovedForAll(signer.address, spender))) {
        const tx = await ctf.setApprovalForAll(spender, true);
        txHashes.push(tx.hash);
        await tx.wait();
      }
    }
    if (this.credential) {
      try {
        await this.client(signer).updateBalanceAllowance({ asset_type: 'COLLATERAL' as any });
      } catch {
        // best-effort cache refresh
      }
    }
    const checks: PreflightResult['checks'] = [];
    for (const { name, address: spender } of spenders) {
      const allowance = Number(formatUnits(await pusd.allowance(signer.address, spender), 6));
      const approved = await ctf.isApprovedForAll(signer.address, spender);
      checks.push({ name: `pusd-${name}`, ok: allowance >= 1, message: `pUSD allowance=${allowance >= 1e12 ? 'unlimited' : allowance.toFixed(2)}` });
      checks.push({ name: `ctf-${name}`, ok: approved, message: approved ? 'CTF approved' : 'CTF not approved' });
    }
    return { ok: checks.every((check) => check.ok), checks, txHashes };
  }

  async createOrder(intent: OrderIntent, signer: SignerProvider): Promise<OrderResult> {
    if (!(signer instanceof LocalWalletSigner)) throw new Error('Polymarket live order creation requires local wallet signer.');
    if (!this.credential) throw new Error('Polymarket CLOB credentials are required. Run mm auth polymarket first.');
    this.lastL2Address = this.config.venues.polymarket.funderAddress || signer.address;
    const client = this.client(signer);
    const tickSize = await this.resolveTickSize(intent.tokenId, intent.market.tickSize);
    // Network dead-man switch: when polymarketOrderTtlSec > 0, place GTD (good-till-date) so the venue auto-cancels the
    // order if the bot/network dies (a dead bot can't send cancels). Polymarket requires expiry ≥ ~60s; the bot
    // refreshes orders well before expiry so they don't lapse during normal operation.
    const ttlSec = Math.trunc(this.config.strategy.polymarketOrderTtlSec ?? 0);
    const useGtd = ttlSec > 0;
    const response = await client.createAndPostOrder(
      {
        tokenID: intent.tokenId,
        price: alignPrice(intent.price, tickSize, intent.side),
        side: intent.side === 'BUY' ? Side.BUY : Side.SELL,
        size: intent.size,
        ...(useGtd ? { expiration: Math.floor(Date.now() / 1000) + Math.max(60, ttlSec) } : {})
      },
      {
        tickSize: formatTick(tickSize),
        negRisk: intent.market.negRisk
      },
      useGtd ? OrderType.GTD : OrderType.GTC,
      true
    );
    if (response?.success === false) {
      throw new Error(response?.errorMsg || response?.message || 'Polymarket order rejected.');
    }
    this.invalidateAccountCaches();
    return {
      venue: this.name,
      clientOrderId: intent.clientOrderId,
      externalId: String(response?.orderID ?? response?.orderId ?? response?.id ?? ''),
      status: 'OPEN',
      raw: response
    };
  }

  async createMarketableOrder(intent: OrderIntent, signer: SignerProvider): Promise<OrderResult> {
    if (!(signer instanceof LocalWalletSigner)) throw new Error('Polymarket live marketable order creation requires local wallet signer.');
    if (!this.credential) throw new Error('Polymarket CLOB credentials are required. Run mm auth polymarket first.');
    this.lastL2Address = this.config.venues.polymarket.funderAddress || signer.address;
    const client = this.client(signer);
    const tickSize = await this.resolveTickSize(intent.tokenId, intent.market.tickSize);
    const response = await client.createAndPostMarketOrder(
      {
        tokenID: intent.tokenId,
        side: intent.side === 'BUY' ? Side.BUY : Side.SELL,
        amount: intent.side === 'SELL' ? intent.size : intent.notionalUsd,
        price: intent.price,
        orderType: OrderType.FAK
      },
      {
        tickSize: formatTick(tickSize),
        negRisk: intent.market.negRisk
      },
      OrderType.FAK
    );
    if (response?.success === false) {
      throw new Error(response?.errorMsg || response?.message || 'Polymarket marketable order rejected.');
    }
    this.invalidateAccountCaches();
    return {
      venue: this.name,
      clientOrderId: intent.clientOrderId,
      externalId: String(response?.orderID ?? response?.orderId ?? response?.id ?? ''),
      status: polymarketMarketOrderStatus(response),
      raw: response
    };
  }

  async cancelOrders(orderIds: string[]): Promise<void> {
    if (orderIds.length === 0) return;
    if (!this.credential) throw new Error('Polymarket CLOB credentials are required. Run mm auth polymarket first.');
    this.lastCancelFailedIds = [];
    // CLOB.cancelOrders typically returns { canceled: string[], not_canceled: { [id]: string } } (per-id reasons).
    // Two failure modes deserve different handling:
    //  1) The whole call raises (network 5xx, 401, malformed creds) — caller already handles via try/catch and
    //     marks the cancel as failed, leaving local OPEN orders for the next reconcile.
    //  2) The call succeeds but some ids end up in not_canceled (e.g. already filled, already canceled, unknown
    //     id). The cleanest behaviour is: log per-id reasons, treat already-gone ids as effectively canceled
    //     (the order is no longer on the book), and only throw if EVERY id failed for a non-terminal reason.
    const response = await this.client(undefined, this.lastL2Address ?? this.config.venues.polymarket.funderAddress).cancelOrders(orderIds) as unknown;
    this.invalidateAccountCaches();
    const result = (response && typeof response === 'object') ? response as Record<string, unknown> : {};
    const notCanceledRaw = result.not_canceled ?? (result as Record<string, unknown>).notCanceled;
    const notCanceled = (notCanceledRaw && typeof notCanceledRaw === 'object') ? notCanceledRaw as Record<string, string> : {};
    const failedIds = Object.keys(notCanceled);
    if (failedIds.length === 0) return;
    const allFailedAndNonTerminal = failedIds.length === orderIds.length
      && failedIds.every((id) => !/already|not[_ ]found|filled|matched|canceled/i.test(String(notCanceled[id] ?? '')));
    if (allFailedAndNonTerminal) {
      throw new Error(`Polymarket cancelOrders rejected all ${orderIds.length} ids: ${failedIds.map((id) => `${id}: ${notCanceled[id]}`).join('; ')}`);
    }
    // Partial / terminal — surface details so the caller can decide whether to retry the failed ids.
    this.lastCancelFailedIds = failedIds;
  }

  private lastCancelFailedIds: string[] = [];

  /** Ids reported as not_canceled by the most recent cancelOrders call (cleared on the next success). */
  getLastCancelFailedIds(): string[] {
    return [...this.lastCancelFailedIds];
  }

  private async loadRewards(): Promise<void> {
    // The CLOB sampling set is the authoritative reward universe + params. Refresh on a TTL (reward epochs roll daily)
    // and build into temp maps so a failed fetch never clears a good set. Also rank condition ids by daily rate so
    // getMarkets can take the top-N as the candidate universe.
    if (this.rewardByToken.size > 0 && Date.now() - this.rewardsLoadedAt < POLYMARKET_REWARDS_TTL_MS) return;
    for (const endpoint of ['/sampling-simplified-markets', '/simplified-markets']) {
      try {
        const base = `${this.config.venues.polymarket.clobUrl.replace(/\/+$/, '')}${endpoint}`;
        // Paginate through ALL pages (API default page size is ~1000). Without this, the bot only saw the first-page
        // arbitrary slice (markets aren't ordered by daily_rate on the wire), so high-rate markets later in pagination
        // — Strait of Hormuz #11, SPY #12, WTI #13, US-Iran Nuclear #14, all $1000/day — were silently dropped.
        const entries: any[] = [];
        let nextCursor: string | undefined;
        for (let page = 0; page < POLYMARKET_SAMPLING_MAX_PAGES; page += 1) {
          const url = nextCursor ? `${base}?next_cursor=${encodeURIComponent(nextCursor)}` : base;
          const payload = await httpJson<any>(url);
          for (const item of extractList(payload)) entries.push(item);
          nextCursor = (payload && typeof payload === 'object' ? (payload as Record<string, unknown>).next_cursor : undefined) as string | undefined;
          if (!nextCursor || nextCursor === 'LTE=' || extractList(payload).length === 0) break;
        }
        const byToken = new Map<string, Market['rewards']>();
        const ranked: Array<{ conditionId: string; dailyRate: number }> = [];
        for (const entry of entries) {
          if (entry?.closed === true || entry?.archived === true) continue;
          const rewards = entry?.rewards ?? {};
          const minShares = toFiniteNumber(rewards?.min_size);
          const maxSpreadCents = normalizeRewardSpread(rewards?.max_spread);
          const level = inferRewardLevel(minShares, maxSpreadCents);
          // rewards.rates[].asset_address is the COLLATERAL (USDC.e/pUSD) — the daily rate, not a token key.
          // The reward applies to the market's OUTCOME tokens (entry.tokens[].token_id), so key by those.
          const rates = Array.isArray(rewards?.rates) ? rewards.rates : [];
          const dailyRate = rates.reduce((sum: number, rate: any) => sum + Math.max(0, toFiniteNumber(rate?.rewards_daily_rate)), 0);
          const tokens = Array.isArray(entry?.tokens) ? entry.tokens : [];
          if (dailyRate <= 0 && minShares <= 0 && !maxSpreadCents) continue;
          const accepting = toOptionalBoolean(entry?.accepting_orders) !== false;
          const rule: Market['rewards'] = {
            enabled: true,
            ...(level ? { level } : {}),
            ...(minShares > 0 ? { minShares } : {}),
            ...(maxSpreadCents ? { maxSpreadCents } : {}),
            ...(dailyRate > 0 ? { dailyRate } : {}),
            reason: accepting ? 'polymarket-rewards' : 'not-accepting-orders'
          };
          for (const token of tokens) {
            const tokenId = String(token?.token_id ?? '');
            if (tokenId) byToken.set(tokenId, rule);
          }
          const conditionId = String(entry?.condition_id ?? '');
          if (conditionId && accepting) ranked.push({ conditionId, dailyRate });
        }
        if (byToken.size > 0) {
          ranked.sort((a, b) => b.dailyRate - a.dailyRate);
          this.rewardByToken = byToken;
          this.rewardConditionIds = [...new Set(ranked.map((entry) => entry.conditionId))];
          this.rewardsLoadedAt = Date.now();
          return;
        }
      } catch {
        continue;
      }
    }
  }

  private async fetchUserTrades(owner: string, sinceTs: number): Promise<any> {
    const url = new URL(`${this.config.venues.polymarket.dataApiUrl.replace(/\/+$/, '')}/trades`);
    url.searchParams.set('user', owner);
    url.searchParams.set('limit', '500');
    url.searchParams.set('after', String(Math.floor(sinceTs / 1000)));
    return httpJson<any>(url.toString());
  }

  private async fetchUserValue(owner: string): Promise<any> {
    const url = new URL(`${this.config.venues.polymarket.dataApiUrl.replace(/\/+$/, '')}/value`);
    url.searchParams.set('user', owner);
    return httpJson<any>(url.toString());
  }

  private client(signer?: LocalWalletSigner, address?: string): ClobClient {
    // L2 auth (api key) must be signed as the SIGNER even in the deposit-wallet flow where the funder (maker) is a
    // different address. Fall back to the stored runtime signer so signer-less calls (getOpenOrders etc.) still
    // authenticate as the signer — otherwise the CLOB returns "Invalid api key" (the key belongs to the signer).
    const authSigner = signer ?? this.runtimeSigner;
    const wallet = authSigner?.unsafePolymarketWalletClientForSdk() ?? addressOnlyPolymarketWalletClient(address);
    const funder = this.config.venues.polymarket.funderAddress || authSigner?.address;
    return new ClobClient({
      host: this.config.venues.polymarket.clobUrl.replace(/\/+$/, ''),
      chain: this.config.venues.polymarket.chainId as Chain,
      signer: wallet as any,
      creds: this.credential,
      signatureType: this.config.venues.polymarket.signatureType as SignatureTypeV2,
      funderAddress: funder,
      useServerTime: true,
      retryOnError: true,
      throwOnError: true
    });
  }

  private tradingAddress(fallback: string): string {
    return this.config.venues.polymarket.funderAddress || fallback;
  }

  private rpcUrls(): string[] {
    return [
      this.config.venues.polymarket.rpcUrl,
      ...(POLYMARKET_RPC_FALLBACKS[this.config.venues.polymarket.chainId] ?? [])
    ].filter((url, index, urls) => Boolean(url) && urls.findIndex((item) => new URL(item).origin === new URL(url).origin) === index);
  }

  private provider(): FallbackProvider {
    const chainId = this.config.venues.polymarket.chainId;
    // Prioritized failover (quorum 1 = first healthy response wins, 2s stall timeout) so a slow/down endpoint
    // can't stall balance/approval reads — mirrors Predict's BSC fallback list.
    const configs = this.rpcUrls().map((url, index) => ({
      provider: new JsonRpcProvider(url, chainId, { staticNetwork: true }),
      priority: index + 1,
      stallTimeout: 2000,
      weight: 1
    }));
    return new FallbackProvider(configs, chainId, { quorum: 1 });
  }

  private pusdContract(): any {
    return new Contract(POLYMARKET_PUSD, ERC20_ABI, this.provider());
  }

  private ctfContract(): any {
    return new Contract(POLYMARKET_CONDITIONAL_TOKENS, ERC1155_ABI, this.provider());
  }

  private trackRecentOrderTokens(orders: OpenOrder[]): void {
    const now = Date.now();
    for (const order of orders) this.recentOrderTokens.set(order.tokenId, now);
    for (const [token, ts] of this.recentOrderTokens) {
      if (now - ts > POLY_POSITION_FALLBACK_TOKEN_TTL_MS) this.recentOrderTokens.delete(token);
    }
  }

  /** Bot-owned tokens to probe on-chain when the data-api is down: recent order tokens + cached orders + last positions. */
  private fallbackPositionTokens(): string[] {
    const tokens = new Set<string>();
    const cutoff = Date.now() - POLY_POSITION_FALLBACK_TOKEN_TTL_MS;
    for (const [token, ts] of this.recentOrderTokens) if (ts >= cutoff) tokens.add(token);
    for (const order of this.ordersCache?.value ?? []) tokens.add(order.tokenId);
    for (const position of this.positionsCache?.value ?? []) tokens.add(position.tokenId);
    return [...tokens].filter(Boolean);
  }

  /** Best-effort entry price per token: the resting BUY price (a maker fill ≈ that price), else the last-known avg. */
  private fallbackPriceByToken(tokenIds: string[]): Map<string, number> {
    const map = new Map<string, number>();
    const orders = this.ordersCache?.value ?? [];
    const lastPositions = this.positionsCache?.value ?? [];
    for (const token of tokenIds) {
      const order = orders.find((o) => o.tokenId === token && o.side === 'BUY' && Number.isFinite(o.price));
      if (order) { map.set(token, order.price); continue; }
      const pos = lastPositions.find((p) => p.tokenId === token && p.averagePrice !== undefined);
      if (pos?.averagePrice !== undefined) map.set(token, pos.averagePrice);
    }
    return map;
  }

  private async getPositionsOnChainFallback(owner: string, tokenIds: string[]): Promise<Position[]> {
    if (tokenIds.length === 0) return [];
    const ctf = this.ctfContract();
    const accounts = tokenIds.map(() => owner);
    const raw = (await ctf.balanceOfBatch(accounts, tokenIds.map((id) => BigInt(id)))) as Array<bigint>;
    return positionsFromCtfBalances(tokenIds, raw, this.fallbackPriceByToken(tokenIds));
  }
}

function addressOnlyPolymarketWalletClient(address: string | undefined): unknown {
  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) return undefined;
  return {
    account: { address },
    getAddresses: async () => [address],
    requestAddresses: async () => [address],
    signTypedData: async () => {
      throw new Error('Polymarket signing requires a local wallet signer.');
    }
  };
}

function clobCredentialFromResponse(value: unknown): { key: string; secret: string; passphrase: string } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const credential = {
    key: String(raw.apiKey ?? raw.key ?? ''),
    secret: String(raw.apiSecret ?? raw.secret ?? ''),
    passphrase: String(raw.apiPassphrase ?? raw.passphrase ?? '')
  };
  return credential.key && credential.secret && credential.passphrase ? credential : undefined;
}

function clobCredentialResponseSummary(methodName: string, value: unknown): string {
  if (!value || typeof value !== 'object') return `${methodName} returned ${typeof value}`;
  const raw = value as Record<string, unknown>;
  const keys = Object.keys(raw).filter((key) => !/secret|passphrase|key/i.test(key));
  const error = typeof raw.error === 'string' ? ` error=${raw.error}` : '';
  const status = raw.status !== undefined ? ` status=${String(raw.status)}` : '';
  return `${methodName}${status}${error}${keys.length ? ` keys=${keys.join(',')}` : ''}`;
}

export async function deriveOrCreatePolymarketCredential(client: {
  deriveApiKey?: (nonce: number) => Promise<unknown>;
  createApiKey?: (nonce: number) => Promise<unknown>;
}): Promise<{ key: string; secret: string; passphrase: string }> {
  // V2's createOrDeriveApiKey can throw on create when nonce 0 already exists,
  // before it reaches derive. Derive-first handles existing and new wallets.
  const methods = [
    ['deriveApiKey', client.deriveApiKey?.bind(client)],
    ['createApiKey', client.createApiKey?.bind(client)]
  ] as const;
  let lastResponseSummary = 'no supported SDK credential method';
  for (const [methodName, method] of methods) {
    if (!method) continue;
    try {
      const response = await method(0);
      const credential = clobCredentialFromResponse(response);
      if (credential) return credential;
      lastResponseSummary = clobCredentialResponseSummary(methodName, response);
    } catch (error) {
      lastResponseSummary = `${methodName}: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  throw new Error(`Polymarket CLOB credential response was incomplete (${lastResponseSummary}).`);
}

/**
 * Pure decision for the CTF (outcome-token) approval preflight check.
 * Only a verifiably-zero allowance blocks live (so missing exit approval is caught);
 * an unreadable allowance or no token to test downgrades to a loud warning, never a false block.
 */
export function ctfApprovalCheckResult(allowance: number | undefined, tokenAvailable: boolean): { name: string; ok: boolean; message: string } {
  if (!tokenAvailable) return { name: 'ctf-allowance', ok: true, message: 'CTF outcome-token 授权未能自动验证(暂无可用 token);请确保已对 Exchange 授权,否则 reduce-only 止损卖不出去' };
  if (allowance === undefined) return { name: 'ctf-allowance', ok: true, message: 'CTF outcome-token 授权未能自动验证;请手动确认已授权 Exchange,否则 reduce-only 止损卖不出去' };
  if (allowance <= 0) return { name: 'ctf-allowance', ok: false, message: 'CTF outcome-token 未授权 Exchange,reduce-only 止损/全退会失败;请先授权再开实盘' };
  return { name: 'ctf-allowance', ok: true, message: `CTF outcome-token 已授权(allowance=${allowance}),reduce-only 止损可执行` };
}

export function polymarketAllowanceValue(response: unknown): number | undefined {
  if (!response || typeof response !== 'object') return undefined;
  const direct = toOptionalFiniteNumber((response as { allowance?: unknown }).allowance);
  if (direct !== undefined) return direct;
  const nested = (response as { allowances?: unknown }).allowances;
  if (!nested || typeof nested !== 'object') return undefined;
  const values = Object.values(nested as Record<string, unknown>)
    .map((value) => toOptionalFiniteNumber(value))
    .filter((value): value is number => value !== undefined);
  if (values.length === 0) return undefined;
  return Math.max(...values);
}

export function polymarketApprovalTarget(negRisk: boolean): string {
  return negRisk ? POLYMARKET_NEG_RISK_EXCHANGE_V2 : POLYMARKET_EXCHANGE_V2;
}

export function polymarketMarketOrderStatus(response: unknown): OrderResult['status'] {
  if (!response || typeof response !== 'object') return 'UNKNOWN';
  const status = String((response as { status?: unknown }).status ?? '').toLowerCase();
  if (status === 'matched') return 'FILLED';
  if (status === 'unmatched') return 'CANCELED';
  if (status === 'delayed') return 'PENDING_OPEN';
  if (status === 'live') return 'OPEN';
  return 'UNKNOWN';
}

function allowanceCheck(name: string, allowance: bigint, label: string): { name: string; ok: boolean; message: string } {
  const value = Number(formatUnits(allowance, 6));
  return {
    name,
    ok: value > 0,
    message: value > 0 ? `${label} allowance=${value.toFixed(6)} pUSD` : `${label} 未授权`
  };
}

export function normalizePolymarketGeoblock(payload: unknown): { blocked: boolean; country?: string; region?: string } {
  if (!payload || typeof payload !== 'object' || typeof (payload as { blocked?: unknown }).blocked !== 'boolean') {
    throw new Error('Polymarket geoblock response is malformed.');
  }
  const raw = payload as { blocked: boolean; country?: unknown; region?: unknown };
  return {
    blocked: raw.blocked,
    country: typeof raw.country === 'string' ? raw.country : undefined,
    region: typeof raw.region === 'string' ? raw.region : undefined
  };
}

export function polymarketGeoTradingDecision(
  geoblock: { blocked: boolean; country?: string; region?: string },
  closedOnly?: boolean
): { ok: boolean; message: string } {
  const country = geoblock.country || 'unknown';
  const region = geoblock.region || '-';
  if (!geoblock.blocked) return { ok: true, message: `allowed country=${country}` };
  // The official API restrictions table marks Japan as frontend-only. Require
  // an authenticated CLOB closed-only check before allowing API order flow.
  if (country === 'JP') {
    if (closedOnly === false) return { ok: true, message: 'frontend-only country=JP; CLOB closed_only=false' };
    if (closedOnly === true) return { ok: false, message: 'country=JP; CLOB closed_only=true' };
    return { ok: false, message: 'country=JP frontend-only, but CLOB closed-only status could not be verified' };
  }
  return { ok: false, message: `blocked country=${country} region=${region}` };
}

export async function polymarketGeoblock(): Promise<{ blocked: boolean; country?: string; region?: string }> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch('https://polymarket.com/api/geoblock', {
        headers: {
          accept: 'application/json',
          'user-agent': 'safe-market-maker/0.1'
        },
        redirect: 'follow',
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`Polymarket geoblock HTTP ${response.status}`);
      return normalizePolymarketGeoblock(await response.json());
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function polymarketClosedOnlyValue(response: unknown): boolean | undefined {
  if (!response || typeof response !== 'object') return undefined;
  const value = (response as { closed_only?: unknown; closedOnly?: unknown }).closed_only
    ?? (response as { closedOnly?: unknown }).closedOnly;
  return typeof value === 'boolean' ? value : undefined;
}

function formatTick(tick: number): '0.1' | '0.01' | '0.001' | '0.0001' {
  if (tick >= 0.1) return '0.1';
  if (tick >= 0.01) return '0.01';
  if (tick >= 0.001) return '0.001';
  return '0.0001';
}

function alignPrice(price: number, tick: number, side: 'BUY' | 'SELL'): number {
  const safeTick = tick > 0 ? tick : 0.01;
  const bounded = Math.min(1 - safeTick, Math.max(safeTick, price));
  const rawSteps = bounded / safeTick;
  const steps = side === 'BUY' ? Math.floor(rawSteps + 1e-9) : Math.ceil(rawSteps - 1e-9);
  return Number((steps * safeTick).toFixed(6));
}

function finiteOrUndefined(value: number): number | undefined {
  return Number.isFinite(value) ? Number(value) : undefined;
}

function finiteOrZero(value: number | undefined): number {
  return Number.isFinite(value) ? Number(value) : 0;
}

function sumDefined(values: Array<number | undefined>): number | undefined {
  const finite = values.filter((value): value is number => Number.isFinite(value));
  if (finite.length === 0) return undefined;
  return Number(finite.reduce((sum, value) => sum + value, 0).toFixed(4));
}

/** ?? would treat the platform's literal 0 as truthy and skip the balance fallback; require strict > 0 to use it. */
export function pickPolymarketEquityUsd(
  valueUsd: number | undefined,
  balances: Balance[],
  positionValueUsd: number
): number | undefined {
  if (valueUsd !== undefined && Number.isFinite(valueUsd) && valueUsd > 0) {
    return valueUsd;
  }
  return accountEquityUsd(balances, positionValueUsd);
}
