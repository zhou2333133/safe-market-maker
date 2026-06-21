export type VenueName = 'predict' | 'polymarket';
export type ExecutionMode = 'live';
export type TradingMode = 'conservative' | 'aggressive';
export type OrderSide = 'BUY' | 'SELL';
export type OrderStatus = 'OPEN' | 'PENDING_OPEN' | 'FILLED' | 'CANCELED' | 'REJECTED' | 'PLANNED' | 'UNKNOWN';

export interface Market {
  venue: VenueName;
  tokenId: string;
  marketId?: string;
  conditionId?: string;
  eventId?: string;
  question: string;
  outcome?: string;
  outcomeIndex?: number;
  outcomeCount?: number;
  url?: string;
  slug?: string;
  volume24hUsd: number;
  liquidityUsd: number;
  acceptingOrders: boolean;
  startTime?: string;
  startTimeSource?: 'category-start' | 'market-start' | 'unknown';
  endTime?: string;
  endTimeSource?: 'order-deadline' | 'market-end' | 'category-end' | 'resolution' | 'reward-end' | 'unknown';
  negRisk: boolean;
  yieldBearing?: boolean;
  feeRateBps: number;
  tickSize: number;
  boosted?: boolean;
  boostStartsAt?: string;
  boostEndsAt?: string;
  rewards?: RewardRules;
  /**
   * Metadata-stage price estimate for THIS outcome token (e.g. Polymarket gamma outcomePrices), used by pre-book
   * ranking/affordability checks so they agree with what the live book will later show. Never used for quoting.
   */
  metadataPriceUsd?: number;
}

export interface RewardRules {
  enabled: boolean;
  level?: number;
  minShares?: number;
  maxSpreadCents?: number;
  ppPerHour?: number;
  dailyRate?: number;
  efficiency?: number;
  reason?: string;
}

export interface OrderbookLevel {
  price: number;
  size: number;
}

export interface Orderbook {
  venue: VenueName;
  tokenId: string;
  bids: OrderbookLevel[];
  asks: OrderbookLevel[];
  receivedAt: number;
}

export interface Balance {
  asset: string;
  available: number;
  total: number;
}

export interface Position {
  venue: VenueName;
  tokenId: string;
  marketId?: string;
  conditionId?: string;
  outcome?: string;
  outcomeCount?: number;
  market?: Market;
  size: number;
  notionalUsd: number;
  averagePrice?: number;
}

export interface OpenOrder {
  venue: VenueName;
  externalId: string;
  tokenId: string;
  side: OrderSide;
  price: number;
  size: number;
  status: OrderStatus;
  /** Epoch ms this order was placed (from the store ledger). Used to refresh GTD orders before they expire. */
  placedAt?: number;
  raw?: unknown;
}

export interface AccountFill {
  venue: VenueName;
  id: string;
  orderId?: string;
  tokenId?: string;
  marketId?: string;
  side?: OrderSide;
  price?: number;
  size?: number;
  notionalUsd: number;
  feeUsd?: number;
  realizedPnlUsd?: number;
  cashflowUsd?: number;
  ts: number;
  raw?: unknown;
}

export interface AccountRiskSnapshot {
  venue: VenueName;
  account: string;
  source: 'venue' | 'venue+chain' | 'local-fallback';
  capturedAt: number;
  dayStart: number;
  equityUsd?: number;
  dayStartEquityUsd?: number;
  realizedPnlUsd?: number;
  unrealizedPnlUsd?: number;
  netCashflowUsd?: number;
  feesUsd?: number;
  fills: AccountFill[];
  positions: Position[];
  balances: Balance[];
  warnings: string[];
  raw?: unknown;
}

export interface AccountRiskDecision {
  ok: boolean;
  venue: VenueName;
  reason: 'ok' | 'snapshot-unavailable' | 'snapshot-stale' | 'daily-loss-limit' | 'equity-drawdown-limit';
  capturedAt?: number;
  maxDailyLossUsd: number;
  dailyPnlUsd?: number;
  realizedPnlUsd?: number;
  unrealizedPnlUsd?: number;
  netCashflowUsd?: number;
  equityUsd?: number;
  dayStartEquityUsd?: number;
  warnings: string[];
  message: string;
}

export interface OrderIntent {
  venue: VenueName;
  market: Market;
  tokenId: string;
  side: OrderSide;
  price: number;
  size: number;
  notionalUsd: number;
  postOnly: boolean;
  liquidity?: 'maker' | 'taker';
  reduceOnly?: boolean;
  reason: string;
  clientOrderId: string;
  reward?: {
    optimizer: string;
    score: number;
    level: number;
    minShares?: number;
    maxSpreadCents?: number;
  };
}

export interface OrderResult {
  venue: VenueName;
  clientOrderId: string;
  externalId?: string;
  status: OrderStatus;
  raw?: unknown;
}

export interface PreflightResult {
  ok: boolean;
  venue: VenueName;
  signerAddress?: string;
  makerAddress?: string;
  checks: Array<{ name: string; ok: boolean; message: string }>;
}

export interface NativeGasBalance {
  asset: string;
  balance: number;
  address?: string;
  label?: string;
  required?: number;
  requiredSource?: 'dynamic-estimate' | 'fallback-estimate' | 'configured';
  estimatedGasUnits?: number;
  gasPriceGwei?: number;
  bufferMultiplier?: number;
  estimateStatus?: 'estimated' | 'fallback';
  estimateMessage?: string;
  ok: boolean;
  message: string;
}

export interface SplitPositionsResult {
  venue: VenueName;
  conditionId: string;
  amountUsd: number;
  txHash?: string;
  raw?: unknown;
}

export interface MergePositionsResult {
  venue: VenueName;
  conditionId: string;
  amountUsd: number;
  txHash?: string;
  raw?: unknown;
}

export interface Recommendation {
  market: Market;
  score: number;
  reasons: string[];
  riskFlags: string[];
}

export interface RuntimeContext {
  mode: ExecutionMode;
  venue: VenueName;
  now: number;
}
