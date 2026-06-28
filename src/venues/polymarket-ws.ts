import WebSocket from 'ws';
import type { Orderbook } from '../domain/types.js';

/**
 * Minimal Polymarket CLOB market-channel WebSocket client for the few markets the
 * bot is actively quoting. It keeps a live order book per asset from the initial
 * `book` snapshot plus `price_change` deltas, and serves it with a freshness bound.
 *
 * The adapter only uses this when `venues.polymarket.useWsOrderbook` is enabled, and
 * always falls back to REST on any error / staleness / failed sanity check, so a wrong
 * or missing stream can never feed a bad book into live quoting.
 */

interface LiveBook {
  bids: Map<number, number>;
  asks: Map<number, number>;
  receivedAt: number;
  /** True when the book came from primeBook() (REST snapshot injection) and not from a WS `book` push. After a WS
   *  disconnect we MUST NOT serve a primed book that pre-dates the disconnect — Polymarket does not auto-resnapshot
   *  on reconnect for quiet markets, so the only freshness signal we have is "have we seen a real WS push since the
   *  last reconnect". cachedBook() consults this together with primeInvalidatedAt to enforce that rule. */
  primed?: boolean;
}

interface Waiter {
  resolve: (book: Orderbook) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 5000;
// Polymarket closes idle WS connections after ~10s without traffic; ping both channels well inside that window.
const WS_KEEPALIVE_INTERVAL_MS = 5000;
// User channel counts as healthy only while the socket is open AND something (pong or event) arrived recently.
// With 5s pings + RFC6455 mandatory pong replies this stays fresh; a half-open socket goes unhealthy and the
// account-state caches fall back to per-tick REST (the original behaviour).
const USER_CHANNEL_STALE_MS = 30_000;

export interface PolymarketUserChannelState {
  healthy: boolean;
  /** Bumps on every order OR trade event — invalidates the open-orders cache. */
  accountEventsSeq: number;
  /** Bumps on trade (fill) events only — invalidates the positions cache. */
  tradeEventsSeq: number;
}

/**
 * Callback shape for live account events. The handler receives the raw event record from the venue (we don't try
 * to flatten it here because Polymarket's wire shape varies across event subtypes), the high-level type, and the
 * timestamp we received it locally. The handler is expected to be cheap and never throw — exceptions get caught
 * and recorded by the WS client so a buggy listener can't kill the socket. Returning anything is ignored.
 */
/**
 * Callback shape for live market-channel orderbook updates. Invoked after every WS `book` snapshot or
 * `price_change` delta that the venue pushes for a subscribed token. The handler is expected to be cheap and
 * never throw — exceptions are caught and swallowed by the WS client so a buggy listener can't kill the socket.
 * Use this to react to depth changes in real-time (e.g. retreat a resting BUY when front cushion erodes) instead
 * of waiting for the next cycle.
 */
export type PolymarketBookUpdateListener = (
  tokenId: string,
  kind: 'snapshot' | 'price_change'
) => void;

export type PolymarketUserEventListener = (
  type: 'order' | 'trade',
  record: Record<string, unknown>,
  receivedAt: number
) => void;

export class PolymarketWsClient {
  private socket?: WebSocket;
  private connecting?: Promise<void>;
  private connected = false;
  private readonly desiredAssets = new Set<string>();
  private readonly subscribedAssets = new Set<string>();
  private readonly books = new Map<string, LiveBook>();
  private readonly waiters = new Map<string, Waiter[]>();
  private pingTimer?: NodeJS.Timeout;
  private keepAlive = true;
  private reconnectAttempts = 0;
  private reconnectTimer?: NodeJS.Timeout;
  private userSocket?: WebSocket;
  private userConnecting?: Promise<void>;
  private userSubscribed = false;
  private userPingTimer?: NodeJS.Timeout;
  private lastUserActivityAt = 0;
  private accountEventsSeq = 0;
  private tradeEventsSeq = 0;
  /** Timestamp of the most recent WS disconnect. After a disconnect, any primed (REST-injected) book whose
   *  receivedAt is older than this is no longer a valid fallback — the underlying market may have moved while the
   *  WS was down and Polymarket will not re-snapshot quiet markets. Reset to 0 on a real WS book push. */
  private primeInvalidatedAt = 0;
  /** Optional listener that gets called for every order / trade event the venue pushes. The bot uses this to
   *  ledger fills the moment the venue confirms them — independent of the REST data-api (which is the path that
   *  intermittently stalls through the user's proxy). */
  private userEventListener?: PolymarketUserEventListener;
  /** Optional listener that fires after every market-channel book update (snapshot or delta). The engine uses
   *  this to re-evaluate placement protections in real-time instead of waiting for the next cycle. Wrapped in
   *  try/catch at the invocation site so a buggy listener can't tear down the WS reader. */
  private bookUpdateListener?: PolymarketBookUpdateListener;
  /** Timestamp of the most recent user-channel disconnect; bot uses this to know it should force a REST reconcile
   *  on the next cycle (because the WS may have missed fills during the gap). 0 means "no disconnect since last
   *  successful subscribe", i.e. WS-stream-only is authoritative. */
  private userDisconnectedAt = 0;
  private userReconnectAttempts = 0;
  private userReconnectTimer?: NodeJS.Timeout;
  /** Stored credentials so the user channel can auto-reconnect without waiting for the next engine cycle. */
  private userCreds?: { key: string; secret: string; passphrase: string };
  private readonly userEvents: Array<{ type: string; data: unknown; receivedAt: number }> = [];

  constructor(private readonly wsUrl: string) {}

  async getOrderbook(tokenId: string, maxAgeMs: number, waitMs: number): Promise<Orderbook> {
    await this.subscribe(tokenId);
    const cached = this.cachedBook(tokenId, maxAgeMs);
    if (cached) return cached;
    return new Promise<Orderbook>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.set(tokenId, (this.waiters.get(tokenId) ?? []).filter((waiter) => waiter.timer !== timer));
        reject(new Error(`Polymarket WS orderbook ${tokenId} did not update within ${waitMs}ms`));
      }, waitMs);
      this.waiters.set(tokenId, [...(this.waiters.get(tokenId) ?? []), { resolve, reject, timer }]);
    });
  }

  /** Add-only subscribe helper kept for callers that only want to ensure a token is watched (rare). */
  async subscribeMarkets(tokenIds: string[]): Promise<void> {
    const merged = [...this.desiredAssets];
    for (const id of tokenIds.filter(Boolean)) if (!this.desiredAssets.has(id)) merged.push(id);
    await this.reconcileMarkets(merged);
  }

  /**
   * Reconcile the WS subscription set to EXACTLY the requested tokens (add new, DROP stale, keep matches).
   * Drop is essential: without it, watched accumulates every market the bot ever scanned and Polymarket's WS
   * server silently stops snapshotting most of them — observed 136 dead subscriptions of 140 watched in
   * production. Predict has used this reconcile pattern since day one; POLY now matches.
   */
  async reconcileMarkets(tokenIds: string[]): Promise<void> {
    const desired = new Set(tokenIds.filter(Boolean));
    this.keepAlive = true;
    // Drop subscriptions that are no longer desired so the server isn't holding stale state for us.
    const stale = [...this.desiredAssets].filter((id) => !desired.has(id));
    if (stale.length > 0) this.dropAssets(stale);
    let added = false;
    for (const id of desired) {
      if (!this.desiredAssets.has(id)) {
        this.desiredAssets.add(id);
        added = true;
      }
    }
    if (desired.size === 0) return;
    await this.ensureConnected();
    if (added || this.subscribedAssets.size < this.desiredAssets.size) {
      // Batch in chunks: one huge subscribe msg with hundreds of asset_ids sometimes causes Polymarket's WS
      // server to silently drop most snapshots. 50-per-batch keeps each payload small enough that every
      // subscription gets a snapshot.
      const pending = [...this.desiredAssets].filter((id) => !this.subscribedAssets.has(id));
      const targets = pending.length > 0 ? pending : [...this.desiredAssets];
      const CHUNK = 50;
      for (let i = 0; i < targets.length; i += CHUNK) {
        const batch = targets.slice(i, i + CHUNK);
        this.send({ assets_ids: batch, type: 'market' });
        for (const id of batch) this.subscribedAssets.add(id);
      }
    }
  }

  /** Drop stale subscriptions: remove from desired/subscribed sets and clear any cached book. Polymarket's WS
   * doesn't accept an unsubscribe message in the market channel, so the next full subscribe burst implicitly
   * replaces the server's interest set. We at least clear OUR caches so a dropped token doesn't keep returning
   * a stale book. */
  private dropAssets(assetIds: string[]): void {
    for (const id of assetIds) {
      this.desiredAssets.delete(id);
      this.subscribedAssets.delete(id);
      this.books.delete(id);
    }
  }

  /** No-wait, no-REST cache read. Returns undefined when the book is missing, stale, or fails the sanity check. */
  getCachedOrderbook(tokenId: string, maxAgeMs: number): Orderbook | undefined {
    return this.cachedBook(tokenId, maxAgeMs);
  }

  /** Seed the WS cache with a REST-fetched book so the next fast-tick has data to verify protections against
   * even when Polymarket's WS hasn't sent a snapshot yet for this asset (cold subscription). The seed lives
   * the same way a real WS snapshot would; subsequent price_change events update it. Required by the post-
   * submit prime hook and the periodic cold-token prime task. */
  primeBook(tokenId: string, book: Orderbook): void {
    const bids = new Map<number, number>();
    const asks = new Map<number, number>();
    for (const level of book.bids || []) if (level.price > 0 && level.price < 1 && level.size > 0) bids.set(level.price, level.size);
    for (const level of book.asks || []) if (level.price > 0 && level.price < 1 && level.size > 0) asks.set(level.price, level.size);
    this.books.set(tokenId, { bids, asks, receivedAt: book.receivedAt || Date.now(), primed: true });
  }

  stats(): { connected: boolean; watchedMarkets: number; cachedOrderbooks: number } {
    return { connected: this.connected, watchedMarkets: this.desiredAssets.size, cachedOrderbooks: this.books.size };
  }

  /**
   * Subscribe the authenticated CLOB user channel for real-time order / trade (fill) events.
   * Idempotent and best-effort: on any failure the bot keeps using REST as the source of truth.
   */
  async subscribeUser(creds: { key: string; secret: string; passphrase: string }, markets: string[] = []): Promise<void> {
    this.userCreds = creds;
    if (this.userSubscribed && this.userSocket?.readyState === WebSocket.OPEN) return;
    if (this.userConnecting) return this.userConnecting;
    const userUrl = this.wsUrl.replace(/\/market\/?$/, '/user');
    this.userConnecting = new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(userUrl);
      const timer = setTimeout(() => {
        socket.close();
        this.userConnecting = undefined;
        reject(new Error(`Polymarket user WS connection timed out after ${DEFAULT_CONNECT_TIMEOUT_MS}ms`));
      }, DEFAULT_CONNECT_TIMEOUT_MS);
      socket.once('open', () => {
        clearTimeout(timer);
        (socket as unknown as { _socket?: { unref?: () => void } })._socket?.unref?.();
        this.userSocket = socket;
        this.userConnecting = undefined;
        this.userSubscribed = true;
        this.userReconnectAttempts = 0;
        this.lastUserActivityAt = Date.now();
        socket.on('message', (data) => this.onUserMessage(data));
        socket.on('pong', () => { this.lastUserActivityAt = Date.now(); });
        socket.on('close', () => this.onUserDisconnect());
        socket.on('error', () => this.onUserDisconnect());
        socket.send(JSON.stringify({ auth: { apiKey: creds.key, secret: creds.secret, passphrase: creds.passphrase }, type: 'user', markets }));
        this.startUserKeepalive(socket);
        resolve();
      });
      socket.once('error', (error) => {
        clearTimeout(timer);
        this.userConnecting = undefined;
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
    return this.userConnecting;
  }

  recentUserEvents(limit = 50): Array<{ type: string; data: unknown; receivedAt: number }> {
    return this.userEvents.slice(-limit);
  }

  /** Register the listener that consumes every order/trade event the user channel pushes. Calling this with the
   *  same listener twice is a no-op; passing undefined clears the listener. The listener fires for every event
   *  including events received between subscribe and the listener being registered (we replay the buffered ones
   *  so a startup race doesn't lose fills). */
  /** Register the market-channel book-update listener. Replaces any previously set listener; pass undefined to
   *  clear. Invoked synchronously inside onMessage AFTER the book cache has been updated, so the listener can
   *  read the fresh book via getCachedOrderbook(tokenId) immediately. */
  setBookUpdateListener(listener: PolymarketBookUpdateListener | undefined): void {
    this.bookUpdateListener = listener;
  }

  setUserEventListener(listener: PolymarketUserEventListener | undefined): void {
    const previous = this.userEventListener;
    this.userEventListener = listener;
    if (!listener || listener === previous) return;
    // Replay buffered events so a listener registered just after subscribe doesn't miss the fills that arrived
    // in the small interval before. The buffer is short (300) so the cost is bounded.
    for (const evt of this.userEvents) {
      if (evt.type !== 'order' && evt.type !== 'trade') continue;
      try { listener(evt.type as 'order' | 'trade', evt.data as Record<string, unknown>, evt.receivedAt); }
      catch { /* a buggy listener must not kill our socket; the event stays buffered for diagnostics */ }
    }
  }

  /** True if the user channel saw a disconnect since the last subscribe success. The caller (engine) uses this to
   *  force a one-shot REST account-state reconcile on the next cycle as a belt-and-suspenders against fills that
   *  may have happened during the gap. After the engine acknowledges via consumeUserDisconnectedFlag(), this clears. */
  hasUserDisconnectedSinceLastConsume(): boolean { return this.userDisconnectedAt > 0; }
  consumeUserDisconnectedFlag(): number { const ts = this.userDisconnectedAt; this.userDisconnectedAt = 0; return ts; }

  /** Health + event sequence numbers for the user channel — used to serve/invalidate REST account-state caches. */
  userChannelState(): PolymarketUserChannelState {
    const healthy = this.userSocket?.readyState === WebSocket.OPEN
      && this.userSubscribed
      && Date.now() - this.lastUserActivityAt < USER_CHANNEL_STALE_MS;
    return { healthy, accountEventsSeq: this.accountEventsSeq, tradeEventsSeq: this.tradeEventsSeq };
  }

  private startUserKeepalive(socket: WebSocket): void {
    if (this.userPingTimer) clearInterval(this.userPingTimer);
    this.userPingTimer = setInterval(() => {
      if (socket.readyState !== WebSocket.OPEN) return;
      try {
        socket.ping();
        socket.send('PING');
      } catch {
        // socket died between checks; close/error handlers reset state
      }
    }, WS_KEEPALIVE_INTERVAL_MS);
    this.userPingTimer.unref?.();
  }

  private startMarketKeepalive(socket: WebSocket): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (socket.readyState !== WebSocket.OPEN) return;
      try {
        socket.ping();
        socket.send('PING');
      } catch {
        // socket died between checks; close/error handlers reset state
      }
    }, WS_KEEPALIVE_INTERVAL_MS);
    this.pingTimer.unref?.();
  }

  close(): void {
    this.keepAlive = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.socket?.close();
    this.socket = undefined;
    this.connected = false;
    this.connecting = undefined;
    this.subscribedAssets.clear();
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = undefined;
    }
    this.userSocket?.close();
    this.userSocket = undefined;
    this.userConnecting = undefined;
    this.userSubscribed = false;
    if (this.userPingTimer) {
      clearInterval(this.userPingTimer);
      this.userPingTimer = undefined;
    }
    if (this.userReconnectTimer) {
      clearTimeout(this.userReconnectTimer);
      this.userReconnectTimer = undefined;
    }
  }

  private onUserDisconnect(): void {
    this.userSocket = undefined;
    this.userConnecting = undefined;
    this.userSubscribed = false;
    // Mark the disconnect timestamp so the engine knows to force one REST reconcile next cycle — without this
    // flag, fills delivered while the user socket was down would never make it into the ledger (REST account-
    // snapshot may also have been stalling in the same outage window).
    this.userDisconnectedAt = Date.now();
    if (this.userPingTimer) {
      clearInterval(this.userPingTimer);
      this.userPingTimer = undefined;
    }
    // Auto-reconnect with exponential backoff (mirrors market-channel scheduleReconnect) so the user
    // WS recovers independently, without waiting for the next engine cycle's primeUserStream call.
    if (this.userCreds) this.scheduleUserReconnect();
  }

  private scheduleUserReconnect(): void {
    if (!this.keepAlive || !this.userCreds || this.userReconnectTimer || this.userConnecting) return;
    const delay = Math.min(30_000, 500 * 2 ** Math.min(this.userReconnectAttempts, 6));
    this.userReconnectAttempts += 1;
    this.userReconnectTimer = setTimeout(() => {
      this.userReconnectTimer = undefined;
      if (!this.userCreds) return;
      this.subscribeUser(this.userCreds, []).catch(() => this.scheduleUserReconnect());
    }, delay);
    this.userReconnectTimer.unref?.();
  }

  private onUserMessage(data: WebSocket.RawData): void {
    this.lastUserActivityAt = Date.now();
    const parsed = safeJson(data.toString());
    if (!parsed) return;
    const events = Array.isArray(parsed) ? parsed : [parsed];
    const now = Date.now();
    for (const event of events) {
      if (!event || typeof event !== 'object') continue;
      const record = event as Record<string, unknown>;
      const type = String(record.event_type ?? record.type ?? '');
      if (type !== 'order' && type !== 'trade') continue;
      this.accountEventsSeq += 1;
      if (type === 'trade') this.tradeEventsSeq += 1;
      this.userEvents.push({ type, data: record, receivedAt: now });
      if (this.userEvents.length > 300) this.userEvents.splice(0, this.userEvents.length - 300);
      // Notify the registered listener (engine layer) so it can ledger the fill immediately. Wrapped in try/catch
      // so a buggy handler can't tear down the WS reader loop — losing telemetry is preferable to losing the
      // socket and going dark on subsequent fills.
      if (this.userEventListener) {
        try { this.userEventListener(type as 'order' | 'trade', record, now); }
        catch { /* swallow — event remains in userEvents buffer for forensic inspection */ }
      }
    }
  }

  private cachedBook(tokenId: string, maxAgeMs: number): Orderbook | undefined {
    const live = this.books.get(tokenId);
    if (!live || Date.now() - live.receivedAt > maxAgeMs) return undefined;
    // If a WS disconnect happened after this book was primed (no real WS snapshot since), treat it as stale even
    // when its absolute age is < maxAgeMs. Polymarket does not re-snapshot quiet markets on reconnect, so a primed
    // book pre-dating the disconnect can silently misprice quotes.
    if (live.primed && this.primeInvalidatedAt > 0 && live.receivedAt < this.primeInvalidatedAt) return undefined;
    const book = this.buildBook(tokenId, live);
    return saneBook(book) ? book : undefined;
  }

  private buildBook(tokenId: string, live: LiveBook): Orderbook {
    const bids = [...live.bids.entries()].map(([price, size]) => ({ price, size })).filter((level) => level.size > 0).sort((a, b) => b.price - a.price);
    const asks = [...live.asks.entries()].map(([price, size]) => ({ price, size })).filter((level) => level.size > 0).sort((a, b) => a.price - b.price);
    return { venue: 'polymarket', tokenId, bids, asks, receivedAt: live.receivedAt };
  }

  private async subscribe(tokenId: string): Promise<void> {
    this.keepAlive = true;
    this.desiredAssets.add(tokenId);
    await this.ensureConnected();
    if (this.subscribedAssets.has(tokenId)) return;
    this.send({ assets_ids: [...this.desiredAssets], type: 'market' });
    this.subscribedAssets.add(tokenId);
  }

  private async ensureConnected(): Promise<void> {
    if (this.connected && this.socket?.readyState === WebSocket.OPEN) return;
    if (this.connecting) return this.connecting;
    this.connecting = new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.wsUrl);
      const timer = setTimeout(() => {
        socket.close();
        this.connecting = undefined;
        reject(new Error(`Polymarket WS connection timed out after ${DEFAULT_CONNECT_TIMEOUT_MS}ms`));
      }, DEFAULT_CONNECT_TIMEOUT_MS);
      socket.once('open', () => {
        clearTimeout(timer);
        (socket as unknown as { _socket?: { unref?: () => void } })._socket?.unref?.();
        this.socket = socket;
        this.connected = true;
        this.reconnectAttempts = 0;
        this.connecting = undefined;
        this.subscribedAssets.clear();
        socket.on('message', (data) => this.onMessage(data));
        socket.on('close', () => this.onDisconnect());
        socket.on('error', () => this.onDisconnect());
        this.startMarketKeepalive(socket);
        if (this.desiredAssets.size > 0) {
          this.send({ assets_ids: [...this.desiredAssets], type: 'market' });
          for (const asset of this.desiredAssets) this.subscribedAssets.add(asset);
        }
        resolve();
      });
      socket.once('error', (error) => {
        clearTimeout(timer);
        this.connecting = undefined;
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
    return this.connecting;
  }

  private onDisconnect(): void {
    this.connected = false;
    this.socket = undefined;
    this.connecting = undefined;
    this.subscribedAssets.clear();
    // Mark every cached book as needing a fresh post-reconnect snapshot before it can be served as primed-fallback.
    // We don't clear this.books here because a successful reconnect + a subsequent `book` push will overwrite the
    // entry (with primed=false) and restore service; but until that push arrives, cachedBook() will skip the entry.
    this.primeInvalidatedAt = Date.now();
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = undefined;
    }
    if (this.keepAlive && this.desiredAssets.size > 0) this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.connecting) return;
    const delay = Math.min(30_000, 500 * 2 ** Math.min(this.reconnectAttempts, 6));
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (!this.keepAlive || this.desiredAssets.size === 0) return;
      this.ensureConnected().catch(() => this.scheduleReconnect());
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private onMessage(data: WebSocket.RawData): void {
    const parsed = safeJson(data.toString());
    if (!parsed) return;
    const events = Array.isArray(parsed) ? parsed : [parsed];
    for (const event of events) {
      if (!event || typeof event !== 'object') continue;
      const record = event as Record<string, unknown>;
      const assetId = String(record.asset_id ?? record.assetId ?? '');
      if (!assetId) continue;
      const type = String(record.event_type ?? record.type ?? '');
      if (type === 'book') {
        this.applySnapshot(assetId, record.bids, record.asks);
      } else if (type === 'price_change') {
        this.applyChanges(assetId, record.changes ?? record.price_changes);
      } else {
        continue;
      }
      this.resolveWaiters(assetId);
      // Notify the registered listener (engine) so it can re-run placement protections on the fresh book
      // immediately. Wrapped in try/catch so a buggy listener can never tear down the WS reader loop —
      // losing one notification is preferable to losing the socket and going dark on subsequent updates.
      if (this.bookUpdateListener) {
        try { this.bookUpdateListener(assetId, type === 'book' ? 'snapshot' : 'price_change'); }
        catch { /* swallow */ }
      }
    }
  }

  private applySnapshot(assetId: string, bids: unknown, asks: unknown): void {
    const book: LiveBook = { bids: levelMap(bids), asks: levelMap(asks), receivedAt: Date.now() };
    this.books.set(assetId, book);
  }

  private applyChanges(assetId: string, changes: unknown): void {
    const existing = this.books.get(assetId);
    // Never layer incremental changes on top of a still-primed REST snapshot — the baseline is presumed stale (the
    // entire reason primeBook exists is to bridge a missing real snapshot) so applying deltas to it would advance
    // receivedAt past primeInvalidatedAt and let cachedBook serve a numerically wrong book as fresh. Wait for the
    // real `book` snapshot to overwrite the primed entry first.
    if (existing?.primed) return;
    const book = existing ?? { bids: new Map<number, number>(), asks: new Map<number, number>(), receivedAt: Date.now() };
    if (Array.isArray(changes)) {
      for (const change of changes) {
        if (!change || typeof change !== 'object') continue;
        const row = change as Record<string, unknown>;
        const price = toNumber(row.price);
        const size = toNumber(row.size);
        const side = String(row.side ?? '').toUpperCase();
        if (price === undefined || size === undefined || price <= 0 || price >= 1) continue;
        const target = side === 'BUY' || side === 'BID' ? book.bids : side === 'SELL' || side === 'ASK' ? book.asks : undefined;
        if (!target) continue;
        if (size <= 0) target.delete(price);
        else target.set(price, size);
      }
    }
    book.receivedAt = Date.now();
    this.books.set(assetId, book);
  }

  private resolveWaiters(assetId: string): void {
    const waiters = this.waiters.get(assetId);
    if (!waiters || waiters.length === 0) return;
    const live = this.books.get(assetId);
    if (!live) return;
    const book = this.buildBook(assetId, live);
    if (!saneBook(book)) return;
    this.waiters.delete(assetId);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(book);
    }
  }

  private send(payload: unknown): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(payload));
  }
}

function levelMap(levels: unknown): Map<number, number> {
  const map = new Map<number, number>();
  if (!Array.isArray(levels)) return map;
  for (const level of levels) {
    if (!level || typeof level !== 'object') continue;
    const row = level as Record<string, unknown>;
    const price = toNumber(row.price);
    const size = toNumber(row.size);
    if (price === undefined || size === undefined || price <= 0 || price >= 1 || size <= 0) continue;
    map.set(price, size);
  }
  return map;
}

function saneBook(book: Orderbook): boolean {
  if (book.bids.length === 0 || book.asks.length === 0) return false;
  const bestBid = book.bids[0]?.price;
  const bestAsk = book.asks[0]?.price;
  if (bestBid === undefined || bestAsk === undefined) return false;
  return bestBid > 0 && bestAsk < 1 && bestBid < bestAsk;
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
