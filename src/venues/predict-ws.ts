import WebSocket from 'ws';
import type { Orderbook } from '../domain/types.js';
import { buildOrderbookForToken } from './normalize.js';

interface CachedOrderbook {
  payload: unknown;
  receivedAt: number;
}

interface Waiter {
  resolve: (book: Orderbook) => void;
  reject: (error: Error) => void;
  tokenId: string;
  timer: NodeJS.Timeout;
  complement: boolean;
  complementTickSize?: number;
}

interface PredictWsMessage {
  type?: string;
  topic?: string;
  data?: unknown;
  success?: boolean;
  error?: { code?: string; message?: string };
}

const DEFAULT_CONNECT_TIMEOUT_MS = 5000;
// PredictFun server probes heartbeat every 15s; allow 3 probe cycles (45s) before treating
// the connection as half-open. Covers 2 missed probes + 1 grace cycle. See
// https://dev.predict.fun/heartbeats-1915508m0
const HEARTBEAT_TIMEOUT_MS = 45_000;
const HEARTBEAT_CHECK_INTERVAL_MS = 5_000;

export class PredictWsClient {
  private socket?: WebSocket;
  private connecting?: Promise<void>;
  private connected = false;
  private requestId = 1;
  private readonly desiredTopics = new Set<string>();
  private readonly activeTopics = new Set<string>();
  private readonly orderbooks = new Map<string, CachedOrderbook>();
  private readonly waiters = new Map<string, Waiter[]>();
  private readonly walletEvents: Array<{ topic: string; data: unknown; receivedAt: number }> = [];
  /** Optional listener that fires after every predictOrderbook WS push. The engine uses this to re-evaluate
   *  placement protections in real-time instead of waiting for the next cycle. The callback receives marketId
   *  (not tokenId) because Predict WS pushes per-market orderbooks. Wrapped in try/catch at the invocation
   *  site so a buggy listener can never tear down the WS reader. */
  private bookUpdateListener?: ((marketId: string) => void);
  /** Optional listener that fires when the underlying WS connection drops (close or error). The engine
   *  wires this to a force-cancel of all managed orders so disconnect protection is NOT gated behind the
   *  (potentially stalled) main runOnce loop. Wrapped in optional chaining at the call site so a missing
   *  listener is a safe no-op (e.g. on the very first connect attempt before the engine has registered). */
  private disconnectListener?: (() => void);
  private keepAlive = false;
  private reconnectTimer?: NodeJS.Timeout;
  private reconnectAttempts = 0;
  /** Timestamp of the last heartbeat received from the server. The heartbeat-watch timer closes
   *  the socket when this goes stale beyond HEARTBEAT_TIMEOUT_MS, so a half-open connection
   *  (socket OPEN but server stopped probing) is detected within ~45s instead of waiting for
   *  an OS-level close event that may never arrive. */
  private lastHeartbeatAt = 0;
  private heartbeatCheckTimer?: NodeJS.Timeout;

  constructor(
    private readonly wsUrl: string,
    private readonly apiKey?: string
  ) {}

  /**
   * Reconcile the orderbook watch set against the desired markets on the single persistent socket
   * (one push stream, no per-market REST cost): batch-subscribe newcomers, best-effort unsubscribe markets
   * that dropped out so a long session never accumulates dead subscriptions. Marks the connection keep-alive
   * so it auto-reconnects + re-subscribes on drop. Wallet-event topics are left untouched.
   */
  async reconcileMarkets(marketIds: string[]): Promise<void> {
    const desired = new Set(uniqueTopics(marketIds));
    this.keepAlive = true;
    const stale = [...this.desiredTopics].filter((topic) => topic.startsWith('predictOrderbook/') && !desired.has(topic));
    if (stale.length > 0) this.dropTopics(stale);
    for (const topic of desired) this.desiredTopics.add(topic);
    await this.ensureConnected();
    this.sendSubscribeBatched([...desired].filter((topic) => !this.activeTopics.has(topic)));
  }

  private dropTopics(topics: string[]): void {
    for (const topic of topics) {
      this.desiredTopics.delete(topic);
      this.activeTopics.delete(topic);
      const marketId = topic.split('/')[1];
      if (marketId) this.orderbooks.delete(marketId);
    }
    const CHUNK = 40;
    for (let index = 0; index < topics.length; index += CHUNK) {
      this.send({ method: 'unsubscribe', requestId: this.nextRequestId(), params: topics.slice(index, index + CHUNK) });
    }
  }

  /** No-wait, no-REST cache read. Returns undefined when the book is missing or older than maxAgeMs. */
  getCachedOrderbook(marketId: string, tokenId: string, maxAgeMs: number, options: { complement?: boolean; complementTickSize?: number } = {}): Orderbook | undefined {
    const ws = this.cachedBook(marketId, tokenId, maxAgeMs, options);
    if (ws) return ws;
    const primed = this.primedBooks.get(tokenId);
    if (!primed || Date.now() - primed.receivedAt > maxAgeMs) return undefined;
    return primed;
  }

  /** Seed the cache with a REST-fetched book so the next read has data even when WS hasn't pushed for this
   * market yet (cold subscription). The seed coexists with WS pushes; whichever is fresher wins via maxAgeMs
   * on read. Used by the post-submit prime hook and the cold-token prime task. */
  primeBook(tokenId: string, book: Orderbook): void {
    this.primedBooks.set(tokenId, { ...book, receivedAt: book.receivedAt || Date.now() });
  }

  private primedBooks: Map<string, Orderbook> = new Map();

  watchedMarketCount(): number {
    let count = 0;
    for (const topic of this.desiredTopics) if (topic.startsWith('predictOrderbook/')) count += 1;
    return count;
  }

  async getOrderbook(marketId: string, tokenId: string, maxAgeMs: number, waitMs: number, options: { complement?: boolean; complementTickSize?: number } = {}): Promise<Orderbook> {
    await this.subscribe(`predictOrderbook/${marketId}`);
    const cached = this.cachedBook(marketId, tokenId, maxAgeMs, options);
    if (cached) return cached;
    return new Promise<Orderbook>((resolve, reject) => {
      const timer = setTimeout(() => {
        const existing = this.waiters.get(marketId) ?? [];
        this.waiters.set(marketId, existing.filter((waiter) => waiter.timer !== timer));
        reject(new Error(`Predict WS orderbook ${marketId} did not update within ${waitMs}ms`));
      }, waitMs);
      const waiter: Waiter = {
        resolve,
        reject,
        tokenId,
        timer,
        complement: options.complement === true,
        ...(options.complementTickSize !== undefined ? { complementTickSize: options.complementTickSize } : {})
      };
      this.waiters.set(marketId, [...(this.waiters.get(marketId) ?? []), waiter]);
    });
  }

  async prefetchOrderbook(marketId: string): Promise<void> {
    await this.subscribe(`predictOrderbook/${marketId}`);
  }

  async subscribeWalletEvents(jwt: string): Promise<void> {
    if (!jwt) return;
    await this.subscribe(`predictWalletEvents/${jwt}`);
  }

  recentWalletEvents(limit = 20): Array<{ topic: string; data: unknown; receivedAt: number }> {
    return this.walletEvents.slice(-limit);
  }

  stats(): { connected: boolean; desiredTopics: number; activeTopics: number; cachedOrderbooks: number; walletEvents: number; watchedMarkets: number; keepAlive: boolean } {
    return {
      connected: this.connected,
      desiredTopics: this.desiredTopics.size,
      activeTopics: this.activeTopics.size,
      cachedOrderbooks: this.orderbooks.size,
      walletEvents: this.walletEvents.length,
      watchedMarkets: this.watchedMarketCount(),
      keepAlive: this.keepAlive
    };
  }

  /** Register a listener that fires for every predictOrderbook WS push (per-market). The engine
   *  wraps this to resolve marketId → affected tokenIds before calling protectOnBookUpdate. */
  setBookUpdateListener(listener: ((marketId: string) => void) | undefined): void {
    this.bookUpdateListener = listener;
  }

  /** Register a listener that fires when the WS connection drops. The engine wires this to a force-cancel
   *  of all managed orders so disconnect protection triggers immediately on the WS event — independent of
   *  the main loop, which may be stalled on a slow Predict REST call at that moment. */
  setDisconnectListener(listener: (() => void) | undefined): void {
    this.disconnectListener = listener;
  }

  close(): void {
    this.keepAlive = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (this.heartbeatCheckTimer) {
      clearInterval(this.heartbeatCheckTimer);
      this.heartbeatCheckTimer = undefined;
    }
    this.socket?.close();
    this.socket = undefined;
    this.connected = false;
    this.connecting = undefined;
    this.activeTopics.clear();
  }

  private cachedBook(marketId: string, tokenId: string, maxAgeMs: number, options: { complement?: boolean; complementTickSize?: number }): Orderbook | undefined {
    const cached = this.orderbooks.get(marketId);
    if (!cached || Date.now() - cached.receivedAt > maxAgeMs) return undefined;
    return {
      ...buildPredictWsOrderbook(tokenId, cached.payload, options),
      receivedAt: cached.receivedAt
    };
  }

  private async subscribe(topic: string): Promise<void> {
    this.desiredTopics.add(topic);
    await this.ensureConnected();
    if (this.activeTopics.has(topic)) return;
    this.send({ method: 'subscribe', requestId: this.nextRequestId(), params: [topic] });
    this.activeTopics.add(topic);
  }

  private async ensureConnected(): Promise<void> {
    if (this.connected && this.socket?.readyState === WebSocket.OPEN) return;
    if (this.connecting) return this.connecting;
    this.connecting = new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.wsUrl, {
        headers: this.apiKey ? { 'x-api-key': this.apiKey } : undefined
      });
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error(`Predict WS connection timed out after ${DEFAULT_CONNECT_TIMEOUT_MS}ms`));
      }, DEFAULT_CONNECT_TIMEOUT_MS);
      socket.once('open', () => {
        clearTimeout(timer);
        (socket as unknown as { _socket?: { unref?: () => void } })._socket?.unref?.();
        this.socket = socket;
        this.connected = true;
        this.connecting = undefined;
        this.activeTopics.clear();
        socket.on('message', (data) => this.onMessage(data));
        socket.on('close', () => this.onDisconnect());
        socket.on('error', () => this.onDisconnect());
        this.reconnectAttempts = 0;
        this.lastHeartbeatAt = Date.now();
        this.startHeartbeatWatch(socket);
        this.sendSubscribeBatched([...this.desiredTopics]);
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
    this.activeTopics.clear();
    // 断线即时全撤（独立于主循环）：WS 层事件回调直接触发 engine 的全撤，即便主循环正卡在慢 API 上，
    // Node 事件循环空闲时仍会执行，杜绝"主循环卡死 + WS 断线"同时发生时的订单裸奔窗口。
    this.disconnectListener?.();
    if (this.heartbeatCheckTimer) {
      clearInterval(this.heartbeatCheckTimer);
      this.heartbeatCheckTimer = undefined;
    }
    if (this.keepAlive && this.desiredTopics.size > 0) this.scheduleReconnect();
  }

  /**
   * Heartbeat staleness watchdog. The server probes every 15s; if we haven't seen a heartbeat
   * within HEARTBEAT_TIMEOUT_MS the socket is half-open (server stopped probing but the OS
   * hasn't delivered a close event). Force-close to trigger the existing onDisconnect →
   * scheduleReconnect path — never call onDisconnect directly, so the state machine stays
   * single-path through the 'close' event.
   */
  private startHeartbeatWatch(socket: WebSocket): void {
    if (this.heartbeatCheckTimer) clearInterval(this.heartbeatCheckTimer);
    this.heartbeatCheckTimer = setInterval(() => {
      if (socket.readyState !== WebSocket.OPEN) return;
      if (Date.now() - this.lastHeartbeatAt > HEARTBEAT_TIMEOUT_MS) {
        try { socket.close(); } catch { /* already closing */ }
      }
    }, HEARTBEAT_CHECK_INTERVAL_MS);
    this.heartbeatCheckTimer.unref?.();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.connecting) return;
    const delay = Math.min(30_000, 500 * 2 ** Math.min(this.reconnectAttempts, 6));
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (!this.keepAlive || this.desiredTopics.size === 0) return;
      this.ensureConnected().catch(() => this.scheduleReconnect());
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private sendSubscribeBatched(topics: string[]): void {
    const pending = topics.filter(Boolean);
    if (pending.length === 0) return;
    const CHUNK = 40;
    for (let index = 0; index < pending.length; index += CHUNK) {
      const chunk = pending.slice(index, index + CHUNK);
      this.send({ method: 'subscribe', requestId: this.nextRequestId(), params: chunk });
      for (const topic of chunk) this.activeTopics.add(topic);
    }
  }

  private onMessage(data: WebSocket.RawData): void {
    const message = safeJson(data.toString());
    if (!message || typeof message !== 'object') return;
    const parsed = message as PredictWsMessage;
    if (parsed.type === 'M' && parsed.topic === 'heartbeat') {
      this.lastHeartbeatAt = Date.now();
      this.send({ method: 'heartbeat', data: parsed.data });
      return;
    }
    if (parsed.type !== 'M' || typeof parsed.topic !== 'string') return;
    if (parsed.topic.startsWith('predictOrderbook/')) {
      const marketId = parsed.topic.split('/')[1];
      if (!marketId) return;
      const receivedAt = Date.now();
      this.orderbooks.set(marketId, { payload: parsed.data, receivedAt });
      const waiters = this.waiters.get(marketId) ?? [];
      this.waiters.delete(marketId);
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.resolve({ ...buildPredictWsOrderbook(waiter.tokenId, parsed.data, { complement: waiter.complement, complementTickSize: waiter.complementTickSize }), receivedAt });
      }
      // Fire book-update listener AFTER cache update — same order as Polymarket's pattern.
      // Wrapped in try/catch so a buggy listener can never tear down the WS reader.
      if (this.bookUpdateListener) {
        try { this.bookUpdateListener(marketId); }
        catch { /* swallow */ }
      }
      return;
    }
    if (parsed.topic.startsWith('predictWalletEvents/')) {
      this.walletEvents.push({ topic: parsed.topic, data: parsed.data, receivedAt: Date.now() });
      if (this.walletEvents.length > 200) this.walletEvents.splice(0, this.walletEvents.length - 200);
    }
  }

  private send(payload: unknown): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(payload));
  }

  private nextRequestId(): number {
    const current = this.requestId;
    this.requestId += 1;
    return current;
  }
}

function uniqueTopics(marketIds: string[]): string[] {
  return [...new Set(marketIds.filter(Boolean).map((id) => `predictOrderbook/${id}`))];
}

export function buildPredictWsOrderbook(tokenId: string, payload: unknown, options: { complement?: boolean; complementTickSize?: number } = {}): Orderbook {
  const data = unwrapWsData(payload);
  return buildOrderbookForToken('predict', tokenId, data, {
    allowAmbiguousTopLevel: true,
    complementAmbiguousTopLevel: options.complement === true,
    complementTickSize: options.complementTickSize
  });
}

function unwrapWsData(payload: any): any {
  return payload?.data?.orderbook ?? payload?.data?.book ?? payload?.data ?? payload?.orderbook ?? payload?.book ?? payload;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
