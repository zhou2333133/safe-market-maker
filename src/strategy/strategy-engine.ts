import type { AppConfig } from '../config/schema.js';
import type { Balance, Market, OpenOrder, OrderIntent, OrderSide, Orderbook, Position, Recommendation, VenueName } from '../domain/types.js';
import { bestBidAsk } from '../venues/normalize.js';
import { configuredPairedStrategy, equalizeSplitSellGroupShares, filterMarketsForPairedInventory, filterSplitIntentsToCompletePairs, marketGroupKey } from './paired-inventory.js';
import { rewardLevel } from './rewards/common.js';
import { createRewardOptimizer } from './rewards/factory.js';
import type { RewardMarketAssessment, RewardQuotePlan } from './rewards/types.js';

export interface StrategyExecutionContext {
  positions?: Position[];
  openOrders?: OpenOrder[];
  balances?: Balance[];
  routeSides?: Map<string, OrderSide>;
}

export class StrategyEngine {
  constructor(private readonly config: AppConfig) {}

  recommend(markets: Market[], top: number): Recommendation[] {
    const recommendations = markets
      .map((market) => this.assessMarket(market))
      .filter((assessment) => assessment.eligible)
      .sort((a, b) => b.score - a.score);
    return this.limitByMarketGroup(recommendations, top).map((assessment) => ({
      market: assessment.market,
      score: assessment.score,
      reasons: assessment.reasons,
      riskFlags: assessment.riskFlags
    }));
  }

  eligibleMarkets(markets: Market[]): Market[] {
    return markets.filter((market) => this.assessMarket(market).eligible);
  }

  buildIntents(
    venue: VenueName,
    markets: Market[],
    books: Map<string, Orderbook>,
    context: StrategyExecutionContext = {}
  ): OrderIntent[] {
    const intents: OrderIntent[] = [];
    const baseConfig = configuredPairedStrategy(this.config);
    // Polymarket two-sided LP: split the per-market total budget across the two legs (YES + NO),
    // so each BUY leg is sized to polymarketLpTotalUsd / maxTokensPerMarket instead of risk.orderSizeUsd.
    const runtimeConfig = venue === 'polymarket' && baseConfig.strategy.polymarketTwoSidedLp
      ? {
          ...baseConfig,
          risk: {
            ...baseConfig.risk,
            orderSizeUsd: Number((Math.max(0, baseConfig.strategy.polymarketLpTotalUsd) / Math.max(1, baseConfig.strategy.maxTokensPerMarket ?? 2)).toFixed(4))
          }
        }
      : baseConfig;
    const optimizer = createRewardOptimizer(venue, runtimeConfig);
    const quoteSide = effectiveQuoteSide(runtimeConfig);
    const positions = context.positions ?? [];
    const routedTokenIds = context.routeSides ? new Set(context.routeSides.keys()) : undefined;
    const marketsToQuote = routedTokenIds
      ? filterMarketsForPairedInventory(runtimeConfig, markets, positions)
        .filter((market) => routedTokenIds.has(market.tokenId))
      : this.limitMarketsForQuoting(filterMarketsForPairedInventory(runtimeConfig, markets, positions), venue, books);

    for (const market of marketsToQuote) {
      const book = books.get(market.tokenId);
      if (!book) continue;
      const routedSide = context.routeSides?.get(market.tokenId);
      const sides = routedSide
        ? [routedSide]
        : quoteSide === 'both' ? ['BUY', 'SELL'] as const : quoteSide === 'sell' ? ['SELL'] as const : ['BUY'] as const;
      for (const side of sides) {
        const quote = optimizer.buildQuote(market, book, side, {
          config: runtimeConfig,
          positions
        });
        if (!quote) continue;
        intents.push(this.intent(venue, market, side, quote, optimizer.constructor.name));
      }
    }
    const paired = equalizeSplitSellGroupShares(runtimeConfig, filterSplitIntentsToCompletePairs(runtimeConfig, intents), positions);
    return filterPolymarketLpPairsBySetMargin(runtimeConfig, venue, paired);
  }

  shouldReplaceOrder(venue: VenueName, order: OpenOrder, desired: OrderIntent, market: Market, book: Orderbook) {
    const optimizer = createRewardOptimizer(venue, this.config);
    return optimizer.shouldReplaceOrder(order, {
      price: desired.price,
      size: desired.size,
      notionalUsd: desired.notionalUsd,
      reason: desired.reason,
      rewardScore: desired.reward?.score ?? 0,
      rewardLevel: desired.reward?.level ?? 0,
      ...(desired.reward?.minShares ? { minRewardShares: desired.reward.minShares } : {}),
      ...(desired.reward?.maxSpreadCents ? { maxRewardSpreadCents: desired.reward.maxSpreadCents } : {})
    }, market, book);
  }

  marketKey(market: Market): string {
    return createRewardOptimizer(market.venue, this.config).marketKey(market);
  }

  private intent(
    venue: VenueName,
    market: Market,
    side: 'BUY' | 'SELL',
    quote: RewardQuotePlan,
    optimizerName: string
  ): OrderIntent {
    return {
      venue,
      market,
      tokenId: market.tokenId,
      side,
      price: quote.price,
      size: quote.size,
      notionalUsd: quote.notionalUsd,
      postOnly: true,
      liquidity: 'maker',
      reason: quote.reason,
      clientOrderId: `${venue}-${market.tokenId}-${side}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      reward: {
        optimizer: optimizerName,
        score: quote.rewardScore,
        level: quote.rewardLevel,
        ...(quote.minRewardShares ? { minShares: quote.minRewardShares } : {}),
        ...(quote.maxRewardSpreadCents ? { maxSpreadCents: quote.maxRewardSpreadCents } : {})
      }
    };
  }

  private assessMarket(market: Market): RewardMarketAssessment & { market: Market } {
    const optimizer = createRewardOptimizer(market.venue, this.config);
    return { ...optimizer.assessMarket(market), market };
  }

  private limitByMarketGroup(
    assessments: Array<RewardMarketAssessment & { market: Market }>,
    top: number
  ): Array<RewardMarketAssessment & { market: Market }> {
    if (!this.config.strategy.dedupeMarketGroups) return assessments.slice(0, top);
    const maxTokensPerMarket = this.config.strategy.maxTokensPerMarket ?? 2;
    const perGroup = new Map<string, number>();
    const selected: Array<RewardMarketAssessment & { market: Market }> = [];
    for (const assessment of assessments) {
      const current = perGroup.get(assessment.marketKey) ?? 0;
      if (current >= maxTokensPerMarket) continue;
      perGroup.set(assessment.marketKey, current + 1);
      selected.push(assessment);
      if (selected.length >= top) break;
    }
    return selected;
  }

  private limitMarketsForQuoting(markets: Market[], venue: VenueName, books: Map<string, Orderbook>): Market[] {
    const optimizer = createRewardOptimizer(venue, this.config);
    const eligible = markets
      .map((market) => ({ market, assessment: optimizer.assessMarket(market, books.get(market.tokenId)) }))
      .filter((entry) => entry.assessment.eligible)
      .sort((a, b) => b.assessment.score - a.assessment.score);
    const top = configuredPairedStrategy(this.config).strategy.entryMode === 'split'
      ? this.config.risk.maxMarkets * (this.config.strategy.maxTokensPerMarket ?? 2)
      : this.config.risk.maxMarkets;
    return this.limitByMarketGroup(eligible.map((entry) => ({ ...entry.assessment, market: entry.market })), top)
      .map((entry) => entry.market);
  }
}

export function quoteSummary(book: Orderbook): string {
  const best = bestBidAsk(book);
  if (best.bestBid === undefined || best.bestAsk === undefined) return 'no BBO';
  return `bid=${best.bestBid.toFixed(4)} ask=${best.bestAsk.toFixed(4)}`;
}

export function marketRewardLevel(market: Market): number {
  return rewardLevel(market);
}

export function effectiveQuoteSide(config: AppConfig): AppConfig['strategy']['quoteSide'] {
  if (config.strategy.entryMode === 'inventory' || config.strategy.entryMode === 'split') return 'sell';
  return config.strategy.quoteSide ?? (config.strategy.dualSide ? 'both' : 'buy');
}

// Require YES_bid + NO_bid <= 1 - 0.5c so a complete-set fill on a two-sided LP can't be a guaranteed loss.
const POLYMARKET_COMPLETE_SET_MIN_MARGIN = 0.005;

export function filterPolymarketLpPairsBySetMargin(config: AppConfig, venue: VenueName, intents: OrderIntent[]): OrderIntent[] {
  if (!(venue === 'polymarket' && config.strategy.polymarketTwoSidedLp)) return intents;
  const groups = new Map<string, OrderIntent[]>();
  for (const intent of intents) {
    const key = marketGroupKey(config, intent.market);
    groups.set(key, [...(groups.get(key) ?? []), intent]);
  }
  const result: OrderIntent[] = [];
  for (const group of groups.values()) {
    const legs = [...new Map(group.map((intent) => [intent.tokenId, intent] as const)).values()];
    // Two-sided LP must be a complete YES/NO pair; a lone leg earns ~0 under Qmin, so skip it.
    if (legs.length < 2) continue;
    // A complete-set fill costs the sum of the leg prices for something worth exactly 1.
    // If that sum >= 1 (minus a small margin) the fill is a guaranteed loss — skip the group this cycle.
    const priceSum = legs.reduce((sum, intent) => sum + intent.price, 0);
    if (priceSum >= 1 - POLYMARKET_COMPLETE_SET_MIN_MARGIN) continue;
    result.push(...legs);
  }
  return result;
}
