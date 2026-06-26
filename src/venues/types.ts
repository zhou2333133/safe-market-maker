import type {
  AccountRiskSnapshot,
  Balance,
  Market,
  MergePositionsResult,
  NativeGasBalance,
  OpenOrder,
  OrderIntent,
  OrderResult,
  Orderbook,
  Position,
  PreflightResult,
  SplitPositionsResult,
  VenueName
} from '../domain/types.js';
import type { SignerProvider } from '../secrets/signer.js';

export interface AuthResult {
  venue: VenueName;
  name: string;
  credential: unknown;
  summary: string;
}

export interface ApprovalGrantRequest {
  amountUsd: number;
  tokenId?: string;
  includeConditionalTokens?: boolean;
  confirm: boolean;
}

export interface SplitPositionsRequest {
  market: Market;
  conditionId: string;
  amountUsd: number;
}

export interface MergePositionsRequest {
  market: Market;
  conditionId: string;
  amountUsd: number;
}

export interface SplitMergeGasEstimateRequest {
  market?: Market;
  conditionId?: string;
  amountUsd?: number;
  action?: 'split' | 'merge';
}

export interface VenueAdapter {
  readonly name: VenueName;
  testConnection(): Promise<boolean>;
  getMarkets(): Promise<Market[]>;
  /**
   * 可选：用已缓存的市场列表预热 adapter 内部状态（如 tokenToMarketId 映射）。
   * 当 ExecutionEngine 从模块级缓存命中时调用，避免因 adapter 实例重建
   * 而丢失内部映射表，从而导致 WebSocket 订单簿路由失效。
   */
  hydrateFromMarkets?(markets: Market[]): void;
  /** Retain the signer for signer-less L2 authenticated calls (Polymarket deposit-wallet flow: signer != funder). */
  setRuntimeSigner?(signer: SignerProvider): void;
  getOrderbook(tokenId: string): Promise<Orderbook>;
  /**
   * Optional WS watch-all support (Predict wide-quoting). Batch-subscribe many markets to a single
   * persistent WebSocket so their orderbooks arrive via push and are read from cache with no per-market
   * REST cost. Polymarket leaves these undefined and keeps its own per-cycle path.
   */
  watchMarkets?(markets: Market[]): void;
  /** Cache-only orderbook read (no wait, no REST). Returns undefined when not fresh in the push cache. */
  getCachedOrderbook?(tokenId: string): Orderbook | undefined;
  /** REST-only orderbook fetch that skips the blocking WS wait — used for watch-all cache misses to keep cycles fast. */
  getOrderbookRest?(tokenId: string): Promise<Orderbook>;
  /** Seed the WS push-cache with a REST-fetched book so cold-subscription tokens have data to verify protections
   * against on the very next fast-tick (without waiting for the venue to send a snapshot we may never get). */
  primeBook?(tokenId: string, book: Orderbook): void;
  /** Diagnostics for the persistent watch-all socket. */
  wsWatchStats?(): { connected: boolean; watchedMarkets: number; cachedOrderbooks: number } | undefined;
  /** OPTIONAL: bulk fetch orderbooks in one HTTP round-trip (Polymarket's POST /books). Returns a Map keyed by
   * tokenId — tokens for which the venue returned no usable book are simply absent from the Map. Should NOT throw
   * for per-token failures; only throw if the whole call fails (HTTP error, network down). Callers that get an
   * empty / partial Map for some tokens MUST fall back to single getOrderbook / getOrderbookRest for the missing
   * ones, so the scan never degrades silently. Predict has no equivalent endpoint and leaves this undefined. */
  getOrderbooksBatch?(tokenIds: string[]): Promise<Map<string, Orderbook>>;
  /** OPTIONAL: register a listener that receives real-time order / trade events the venue pushes over its user
   *  channel WS. The bot uses this to ledger fills the moment the venue confirms them, independent of REST
   *  account-state pulls. Predict has no such channel today and leaves this undefined; the engine's REST
   *  reconcile path is the sole source of truth there. */
  setUserEventListener?(listener: (
    type: 'order' | 'trade',
    record: Record<string, unknown>,
    receivedAt: number
  ) => void | undefined): void;
  /** OPTIONAL paired with setUserEventListener: returns >0 if the user channel disconnected since the engine last
   *  consumed this flag, and 0 otherwise. The engine reads it once per cycle to decide whether to force a REST
   *  account-state reconcile (catching fills that may have happened during the gap). */
  consumeUserChannelDisconnectFlag?(): number;
  /** OPTIONAL: register a listener that fires after every market-channel orderbook update (snapshot or delta).
   *  The engine uses this to re-evaluate the 3 placement protections (front depth / reward band / exit liquidity)
   *  IMMEDIATELY when a book moves — instead of waiting for the next ~16s cycle. Predict's WS only pushes on
   *  trades so it leaves this undefined; the engine's per-cycle path remains its sole protection signal. */
  setBookUpdateListener?(listener: (
    tokenId: string,
    kind: 'snapshot' | 'price_change'
  ) => void | undefined): void;
  getBalances(address: string, signer?: SignerProvider): Promise<Balance[]>;
  getPositions(address: string): Promise<Position[]>;
  getOpenOrders(address: string): Promise<OpenOrder[]>;
  getAccountRiskSnapshot?(address: string, signer: SignerProvider, sinceTs: number): Promise<AccountRiskSnapshot>;
  preflight?(signer: SignerProvider, tokenIds?: string[]): Promise<PreflightResult>;
  authenticate?(signer: SignerProvider): Promise<AuthResult>;
  inspectApprovals?(signer: SignerProvider, tokenId?: string): Promise<PreflightResult>;
  getNativeGasBalance?(signer: SignerProvider, required?: number): Promise<NativeGasBalance>;
  estimateSplitMergeGas?(signer: SignerProvider, request?: SplitMergeGasEstimateRequest): Promise<NativeGasBalance>;
  grantApprovals?(signer: SignerProvider, request: ApprovalGrantRequest): Promise<PreflightResult>;
  /** One-click trading approvals for both V2 exchanges (pUSD allowance + CTF). User-initiated from the UI. */
  grantTradingApprovals?(signer: SignerProvider, amountUsd?: number): Promise<{ ok: boolean; checks: PreflightResult['checks']; txHashes: string[] }>;
  splitPositions?(request: SplitPositionsRequest, signer: SignerProvider): Promise<SplitPositionsResult>;
  mergePositions?(request: MergePositionsRequest, signer: SignerProvider): Promise<MergePositionsResult>;
  createOrder(intent: OrderIntent, signer: SignerProvider): Promise<OrderResult>;
  createMarketableOrder?(intent: OrderIntent, signer: SignerProvider): Promise<OrderResult>;
  cancelOrders(orderIds: string[]): Promise<void>;
}
