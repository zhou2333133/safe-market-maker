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
    this.books.set(tokenId, { bids, asks, receivedAt: book.receivedAt || Date.now() });
  }

  stats(): { connected: boolean; watchedMarkets: number; cachedOrderbooks: number } {
    return { connected: this.connected, watchedMarkets: this.desiredAssets.size, cachedOrderbooks: this.books.size };
  }

  /**
   * Subscribe the authenticated CLOB user channel for real-time order / trade (fill) events.
   * Idempotent and best-effort: on any failure the bot keeps using REST as the source of truth.
   */
  async subscribeUser(creds: { key: string; secret: string; passphrase: string }, markets: string[] = []): Promise<void> {
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
  }

  private onUserDisconnect(): void {
    this.userSocket = undefined;
    this.userConnecting = undefined;
    this.userSubscribed = false;
    if (this.userPingTimer) {
      clearInterval(this.userPingTimer);
      this.userPingTimer = undefined;
    }
  }

  private onUserMessage(data: WebSocket.RawData): void {
    this.lastUserActivityAt = Date.now();
    const parsed = safeJson(data.toString());
    if (!parsed) return;
    const events = Array.isArray(parsed) ? parsed : [parsed];
    for (const event of events) {
      if (!event || typeof event !== 'object') continue;
      const record = event as Record<string, unknown>;
      const type = String(record.event_type ?? record.type ?? '');
      if (type !== 'order' && type !== 'trade') continue;
      this.accountEventsSeq += 1;
      if (type === 'trade') this.tradeEventsSeq += 1;
      this.userEvents.push({ type, data: record, receivedAt: Date.now() });
      if (this.userEvents.length > 300) this.userEvents.splice(0, this.userEvents.length - 300);
    }
  }

  private cachedBook(tokenId: string, maxAgeMs: number): Orderbook | undefined {
    const live = this.books.get(tokenId);
    if (!live || Date.now() - live.receivedAt > maxAgeMs) return undefined;
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
    }
  }

  private applySnapshot(assetId: string, bids: unknown, asks: unknown): void {
    const book: LiveBook = { bids: levelMap(bids), asks: levelMap(asks), receivedAt: Date.now() };
    this.books.set(assetId, book);
  }

  private applyChanges(assetId: string, changes: unknown): void {
    const book = this.books.get(assetId) ?? { bids: new Map<number, number>(), asks: new Map<number, number>(), receivedAt: Date.now() };
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
