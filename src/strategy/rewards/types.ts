import type { AppConfig } from '../../config/schema.js';
import type { Market, OpenOrder, OrderSide, Orderbook, Position, VenueName } from '../../domain/types.js';

export interface RewardMarketAssessment {
  venue: VenueName;
  optimizer: string;
  eligible: boolean;
  score: number;
  reasons: string[];
  riskFlags: string[];
  rewardLevel: number;
  marketKey: string;
  estimatedMinRewardNotionalUsd?: number;
  qualifyingDepthUsd?: number;
}

export interface RewardQuoteContext {
  config: AppConfig;
  positions: Position[];
}

export interface RewardQuotePlan {
  price: number;
  size: number;
  notionalUsd: number;
  reason: string;
  rewardScore: number;
  rewardLevel: number;
  minRewardShares?: number;
  maxRewardSpreadCents?: number;
}

export interface RewardReplaceDecision {
  replace: boolean;
  reason: string;
}

export interface VenueRewardOptimizer {
  readonly venue: VenueName;
  marketKey(market: Market): string;
  assessMarket(market: Market, book?: Orderbook): RewardMarketAssessment;
  buildQuote(market: Market, book: Orderbook, side: OrderSide, context: RewardQuoteContext): RewardQuotePlan | undefined;
  shouldReplaceOrder(order: OpenOrder, desired: RewardQuotePlan, market: Market, book: Orderbook): RewardReplaceDecision;
}
