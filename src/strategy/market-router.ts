import type { AppConfig } from '../config/schema.js';
import type { Market, OpenOrder, OrderSide, Orderbook, Position, VenueName } from '../domain/types.js';
import { evaluateMarketGuard, spreadWithinLimits } from '../risk/market-guard.js';
import { bestBidAsk } from '../venues/normalize.js';
import { completeSetInventoryGroups, expectedOutcomeCount, hasCompleteOutcomeSet, isCashMultiMarketEntry, isPairedEntryMode, marketGroupKey, pairedPositionGroups } from './paired-inventory.js';
import { effectiveQuoteSide } from './strategy-engine.js';
import { createRewardOptimizer } from './rewards/factory.js';
import { formatUsd, isWithinRewardBand, rewardLevel, rewardQuoteProtection, rewardQuoteProtectionDiagnostic, rewardTargetShares, shouldEnforceRewardMinimum, shouldProtectRewardQuote } from './rewards/common.js';
import { polymarketQmin, polymarketRewardCompetition } from './rewards/polymarket-competition.js';
import { polymarketMidVolatilityPct, recordPolymarketMid } from './rewards/polymarket-volatility.js';

const CASH_BASKET_MAX_NEW_PER_CYCLE = 4;
// Polymarket two-sided LP volatility filter: above this recent mid coefficient-of-variation (%) a market is
// treated as too trending/volatile for safe two-sided LP and excluded; below it, efficiency is de-rated linearly.
const POLY_VOL_HARD_EXCLUDE_PCT = 8;

export interface MarketRouteMetrics {
  ppPerHour: number;
  rewardLevel: number;
  spreadCents?: number;
  spreadBps?: number;
  rewardBandDepthUsd: number;
  topDepthUsd: number;
  expectedPpPerHour?: number;
  ppPerThousandUsd?: number;
  targetSharePct?: number;
  /** Polymarket only: this leg's bid score, competing bid/ask scores on this token book, and the midpoint, for group-level Qone/Qtwo/Qmin recombination. */
  polymarketYourScore?: number;
  polymarketCompetitorBid?: number;
  polymarketCompetitorAsk?: number;
  polymarketMid?: number;
  competitionBand: 'unknown' | 'thin' | 'balanced' | 'crowded';
  minRewardNotionalUsd?: number;
  targetOrderUsd: number;
  targetShares?: number;
  targetOrderSource?: 'configured' | 'quote' | 'reward-minimum-plus-one' | 'split-paired-sell';
  liquidityUsd: number;
  volume24hUsd: number;
  remainingSafeHours?: number;
}

export interface MarketRouteCandidate {
  market: Market;
  side: OrderSide;
  score: number;
  tradable: boolean;
  reasons: string[];
  riskFlags: string[];
  metrics: MarketRouteMetrics;
  groupKey?: string;
}

export interface MarketRouteGroupSummary {
  groupKey: string;
  marketId?: string;
  question: string;
  outcomeCount: number;
  score: number;
  expectedPpPerHour: number;
  ppPerThousandUsd?: number;
  targetOrderUsd: number;
  rewardBandDepthUsd: number;
  topDepthUsd: number;
  remainingSafeHours?: number;
  candidates: MarketRouteCandidate[];
}

export interface MarketRouteSelection {
  selected: MarketRouteCandidate[];
  candidates: MarketRouteCandidate[];
  previous?: MarketRouteCandidate;
  best?: MarketRouteCandidate;
  previousGroup?: MarketRouteGroupSummary;
  bestGroup?: MarketRouteGroupSummary;
  switched: boolean;
  reason: string;
}

export interface MarketRouteContext {
  positions?: Position[];
  openOrders?: OpenOrder[];
}

export function rankMarketRoutes(
  config: AppConfig,
  venue: VenueName,
  markets: Market[],
  books: Map<string, Orderbook>,
  context: MarketRouteContext = {}
): MarketRouteCandidate[] {
  // Sample Polymarket midpoints every cycle so the volatility filter can prefer range-bound markets.
  if (isPolymarketTwoSidedLp(config, venue)) {
    for (const market of markets) {
      if (market.venue !== venue) continue;
      const book = books.get(market.tokenId);
      const mid = book ? bestBidAsk(book).mid : undefined;
      if (mid !== undefined) recordPolymarketMid(market.tokenId, mid);
    }
  }
  const optimizer = createRewardOptimizer(venue, config);
  const pairedGroups = pairedPositionGroups(config, markets, context.positions ?? []);
  const inventorySharesByGroup = new Map(completeSetInventoryGroups(config, markets, context.positions ?? [])
    .map((group) => [group.key, group.mergeableShares] as const));
  const completeMarketGroups = completeCandidateGroups(config, markets);
  const partialInventoryGroups = partialPairedInventoryGroups(config, markets, context.positions ?? [], pairedGroups);
  const splitReferencePricesByGroup = splitReferencePrices(config, venue, markets, books);
  const cashRewardPoolDepths = cashRewardPoolDepthByGroupSide(config, venue, markets, books, context.openOrders ?? []);
  return markets
    .filter((market) => market.venue === venue)
    .flatMap((market) => {
      const book = books.get(market.tokenId);
      const assessment = optimizer.assessMarket(market, book);
      const groupKey = marketGroupKey(config, market);
      const availableForPairedMode = !isPairedEntryMode(config) || completeMarketGroups.has(groupKey);
      const sides = availableForPairedMode ? routeSides(config, market, context.positions) : [];
      const candidateSides = sides.length > 0 ? sides : fallbackRouteSides(config);
      return candidateSides.map((side) => {
        const quoteDecision = routeQuoteRiskDecision(config, venue, market, book, side, context.positions ?? []);
        const referenceQuote = quoteDecision.quote ?? routeReferenceQuote(config, venue, market, book, side, context.positions ?? []);
        const cashScoringTarget = cashRouteScoringTarget(config, market, referenceQuote?.price, book);
        const metrics = routeMetrics(config, venue, market, book, [side], {
          splitInventoryShares: inventorySharesByGroup.get(groupKey),
          splitGroupReferencePrices: splitReferencePricesByGroup.get(groupKey),
          ownOpenOrders: context.openOrders,
          rewardPoolDepthUsd: cashRewardPoolDepths.get(rewardPoolDepthKey(venue, groupKey, side)),
          targetOrderUsd: cashScoringTarget?.targetOrderUsd ?? quoteDecision.quote?.notionalUsd ?? referenceQuote?.notionalUsd,
          targetShares: cashScoringTarget?.targetShares,
          targetOrderSource: cashScoringTarget?.targetOrderSource,
          targetReferencePrice: cashScoringTarget?.referencePrice ?? quoteDecision.quote?.price ?? referenceQuote?.price
        });
        const riskFlags = [...assessment.riskFlags];
        const reasons = [...assessment.reasons];
        const guard = evaluateMarketGuard(config, market, book);

        if (isPairedEntryMode(config) && !completeMarketGroups.has(groupKey)) {
          riskFlags.push('拆分双边模式需要同一市场完整 YES/NO 目标');
        } else if (isPairedEntryMode(config) && partialInventoryGroups.has(groupKey)) {
          riskFlags.push('拆分双边模式检测到单边库存，禁止继续自动挂单');
        } else if (sides.length === 0) riskFlags.push('当前挂单方向没有可执行库存');
        if (!book) riskFlags.push('盘口不可用');
        if (!guard.ok) riskFlags.push(guard.message);
        if (!quoteDecision.ok) riskFlags.push(...quoteDecision.reasons);
        if (book && metrics.rewardBandDepthUsd < metrics.targetOrderUsd) {
          reasons.push(`同组奖励带现有竞争资金低于本单金额，按低竞争机会继续评估`);
        }
        if (shouldEnforceRewardMinimum(config, market) && metrics.minRewardNotionalUsd !== undefined) {
          if (metrics.minRewardNotionalUsd > config.risk.orderSizeUsd) {
            riskFlags.push(`当前单笔金额 ${formatUsd(config.risk.orderSizeUsd)} 不足官方最低奖励份额，约需 ${formatUsd(metrics.minRewardNotionalUsd)}`);
          }
          if (metrics.minRewardNotionalUsd > config.risk.maxSingleOrderUsd) {
            riskFlags.push(`最低奖励份额约需 ${formatUsd(metrics.minRewardNotionalUsd)}，超过单笔上限 ${formatUsd(config.risk.maxSingleOrderUsd)}`);
          }
          if (metrics.minRewardNotionalUsd > config.risk.maxPositionUsd) {
            riskFlags.push(`最低奖励份额约需 ${formatUsd(metrics.minRewardNotionalUsd)}，超过持仓上限 ${formatUsd(config.risk.maxPositionUsd)}`);
          }
        }
        if (!spreadWithinLimits(config, market, metrics.spreadBps, book ? bestBidAsk(book).mid : undefined)) {
          riskFlags.push(`盘口价差过宽 ${(metrics.spreadBps ?? 0).toFixed(1)}bps(且宽于奖励带)`);
        }
        // Polymarket liquidity rewards accrue PER MARKET but pay out on your CUMULATIVE daily total — there is NO $1
        // per-market minimum (small rewards like $0.10/day are paid and add up). So this per-market reward floor is
        // OPT-IN: it only fires when polymarketMinDailyRewardUsd > 0 (the user's config sets it to 0 = off). The real
        // per-market qualifier is meeting the min reward share within the spread band, already enforced above via
        // minRewardNotionalUsd. Keep the guard so a user CAN re-impose a floor, but default behavior no longer skips
        // sub-$1 earners.
        if (venue === 'polymarket' && !config.strategy.polymarketTwoSidedLp && metrics.expectedPpPerHour !== undefined) {
          const expectedDailyUsd = metrics.expectedPpPerHour * 24;
          const minDaily = Math.max(0, config.strategy.polymarketMinDailyRewardUsd ?? 0);
          if (minDaily > 0 && expectedDailyUsd + 1e-9 < minDaily) {
            riskFlags.push(`预计当日奖励 ${formatUsd(expectedDailyUsd)} 低于 ${formatUsd(minDaily)} 单市场发放门槛(低于不发放)`);
          }
        }

        reasons.unshift(`路由方向 ${side}`);
        reasons.unshift(guard.message);
        reasons.unshift(`PP 强度 ${formatNumber(metrics.ppPerHour)}/hr`);
        reasons.unshift(`${isPairedEntryMode(config) ? '奖励带内深度' : '同组奖励带竞争资金'} ${formatUsd(metrics.rewardBandDepthUsd)}`);
        if (metrics.expectedPpPerHour !== undefined && metrics.ppPerThousandUsd !== undefined && metrics.targetSharePct !== undefined) {
          reasons.unshift(`预计有效 PP ${formatNumber(metrics.expectedPpPerHour)}/hr，同组资金占比 ${metrics.targetSharePct.toFixed(2)}%`);
          reasons.unshift(`同组奖励带拥挤度 ${competitionBandLabel(metrics.competitionBand)}，资金效率 ${formatNumber(metrics.ppPerThousandUsd)} PP/hr/kUSD`);
        }
        if (metrics.targetOrderSource === 'reward-minimum-plus-one' && metrics.targetShares !== undefined) {
          reasons.unshift(`官方最低有效份额 ${formatNumber(metrics.targetShares)} 份，PP 按实挂金额估算`);
        }
        if (metrics.spreadCents !== undefined) reasons.unshift(`盘口价差 ${metrics.spreadCents.toFixed(2)}c`);

        const score = routeScore(metrics, riskFlags.length, assessment.score);
        return {
          market,
          side,
          score,
          tradable: riskFlags.length === 0,
          reasons,
          riskFlags,
          metrics,
          groupKey
        };
      });
    })
    .sort(compareRouteCandidates);
}

function routeQuoteRiskDecision(
  config: AppConfig,
  venue: VenueName,
  market: Market,
  book: Orderbook | undefined,
  side: OrderSide,
  positions: Position[]
): { ok: boolean; reasons: string[]; quote?: ReturnType<ReturnType<typeof createRewardOptimizer>['buildQuote']> } {
  if (!book) return { ok: false, reasons: ['盘口不可用'] };
  const quoteConfig = isPairedEntryMode(config)
    ? {
        ...config,
        strategy: {
          ...config.strategy,
          quoteSide: 'sell' as const,
          inventorySkewEnabled: false
        }
      }
    : config;
  const quotePositions = isPairedEntryMode(config) && side === 'SELL'
    ? [{ venue, tokenId: market.tokenId, size: Number.MAX_SAFE_INTEGER, notionalUsd: Number.MAX_SAFE_INTEGER }]
    : positions;
  const quote = createRewardOptimizer(venue, quoteConfig).buildQuote(market, book, side, {
    config: quoteConfig,
    positions: quotePositions
  });
  if (!quote) {
    return {
      ok: false,
      reasons: [rewardQuoteProtectionDiagnostic(quoteConfig, side, market, book) ?? '当前盘口无法生成可执行奖励报价']
    };
  }
  const reasons: string[] = [];
  if (!Number.isFinite(quote.price) || quote.price <= 0 || quote.price >= 1) reasons.push(`invalid price ${quote.price}`);
  if (quote.price < config.risk.minPrice || quote.price > config.risk.maxPrice) reasons.push(`price outside safe band ${quote.price}`);
  if (quote.notionalUsd > config.risk.maxSingleOrderUsd) reasons.push(`single order notional exceeds ${config.risk.maxSingleOrderUsd}`);
  if (shouldProtectRewardQuote(config, side)) {
    const protection = rewardQuoteProtection(config, side, quote.price, book, market);
    if (!protection.ok) reasons.push(protection.reason);
  }
  if (shouldEnforceRewardMinimum(config, market) && quote.minRewardShares && quote.size + 1e-9 < quote.minRewardShares) {
    reasons.push(`size below reward minimum shares ${quote.minRewardShares}`);
  }
  return { ok: reasons.length === 0, reasons, quote };
}

function routeReferenceQuote(
  config: AppConfig,
  venue: VenueName,
  market: Market,
  book: Orderbook | undefined,
  side: OrderSide,
  positions: Position[]
): ReturnType<ReturnType<typeof createRewardOptimizer>['buildQuote']> {
  if (!book) return undefined;
  const relaxedConfig: AppConfig = {
    ...config,
    risk: {
      ...config.risk,
      maxSingleOrderUsd: Math.max(config.risk.maxSingleOrderUsd, config.risk.orderSizeUsd)
    },
    strategy: {
      ...config.strategy,
      pointsOnly: false,
      enforceRewardMinimum: false
    }
  };
  const quoteConfig = isPairedEntryMode(config)
    ? {
        ...relaxedConfig,
        strategy: {
          ...relaxedConfig.strategy,
          quoteSide: 'sell' as const,
          inventorySkewEnabled: false
        }
      }
    : relaxedConfig;
  const quotePositions = isPairedEntryMode(config) && side === 'SELL'
    ? [{ venue, tokenId: market.tokenId, size: Number.MAX_SAFE_INTEGER, notionalUsd: Number.MAX_SAFE_INTEGER }]
    : positions;
  return createRewardOptimizer(venue, quoteConfig).buildQuote(market, book, side, {
    config: quoteConfig,
    positions: quotePositions
  });
}

export function selectMarketRoutes(
  config: AppConfig,
  venue: VenueName,
  candidates: MarketRouteCandidate[],
  previousTokenIds: string[] = []
): MarketRouteSelection {
  if (isPairedEntryMode(config)) {
    return selectSplitMarketRoutes(config, venue, candidates, previousTokenIds);
  }
  if (isPolymarketTwoSidedLp(config, venue)) {
    return selectPolymarketTwoSidedRoutes(config, venue, candidates, previousTokenIds);
  }
  if (isCashMultiMarketEntry(config)) {
    return selectCashMarketBasket(config, venue, candidates, previousTokenIds);
  }
  // Single-market cash path: Polymarket still rests on the lowest-exit-loss (highest-price) side of each market.
  const tradable = preferPolymarketMinExitLossSide(config, venue, candidates).filter((candidate) => candidate.tradable);
  const best = tradable[0];
  if (!best) {
    return {
      selected: [],
      candidates,
      switched: false,
      reason: '没有满足 PP、流动性、盘口和风控条件的候选市场'
    };
  }

  const previous = previousRouteCandidate(config, tradable, previousTokenIds);
  const threshold = (config.strategy.switchThresholdPct ?? 15) / 100;
  const switchDecision = previous && best.market.tokenId !== previous.market.tokenId
    ? crossPoolSwitchDecision(config, previous, best, threshold)
    : { keepPrevious: false, reason: '当前单边池子仍是最佳 101 份 PP/hr/kUSD 资金效率选择，继续维护' };
  const keepPrevious = Boolean(previous && best.market.tokenId !== previous.market.tokenId && switchDecision.keepPrevious);
  const primary = (keepPrevious && previous) ? previous : best;
  const selected = pickTopRoutes(config, venue, [primary, ...tradable.filter((candidate) => candidate.market.tokenId !== primary.market.tokenId)]);

  return {
    selected,
    candidates,
    previous,
    best,
    switched: previous !== undefined && selected.every((candidate) => !previousTokenIds.includes(candidate.market.tokenId)),
    reason: keepPrevious
      ? switchDecision.reason
      : previous
        ? best.market.tokenId === previous.market.tokenId
          ? switchDecision.reason
          : '发现更优 101 份 PP/hr/kUSD 资金效率组合，允许切换'
        : '选择当前全局最优 101 份 PP/hr/kUSD 资金效率市场'
  };
}

/**
 * Resting price of an outcome (higher = lower per-cent exit loss). For a fixed notional a higher price buys
 * fewer shares, so a 1-cent adverse move costs less (size × $0.01). Polymarket's per-outcome metadata price is
 * reliable; the book mid and the target notional/shares ratio are fallbacks.
 */
function polymarketOutcomeExitPrice(candidate: MarketRouteCandidate): number {
  const fromTarget = candidate.metrics.targetShares && candidate.metrics.targetShares > 0
    ? candidate.metrics.targetOrderUsd / candidate.metrics.targetShares
    : undefined;
  return candidate.metrics.polymarketMid
    ?? candidate.market.metadataPriceUsd
    ?? fromTarget
    ?? 0.5;
}

/**
 * Polymarket single-sided cash: quote each market on the side with the smallest escape loss — the
 * higher-priced (stronger-liquidity) outcome, e.g. with YES 0.17 / NO 0.83 the bot must rest on NO 0.83
 * ("基数大,退出损失小"). Returns a filtered VIEW with original order preserved; it never mutates or reorders the
 * candidate list, so cross-market ranking, the returned `candidates` array, and reporting are unchanged — only
 * which side is eligible for selection. Predict (fake 0.5 metadata price, orders rarely fill), two-sided LP, and
 * paired entry are left untouched.
 */
function preferPolymarketMinExitLossSide(
  config: AppConfig,
  venue: VenueName,
  candidates: MarketRouteCandidate[]
): MarketRouteCandidate[] {
  if (venue !== 'polymarket' || config.strategy.entryMode !== 'cash') return candidates;
  if (isPairedEntryMode(config) || isPolymarketTwoSidedLp(config, venue)) return candidates;
  const byGroup = new Map<string, MarketRouteCandidate[]>();
  for (const candidate of candidates) {
    const key = marketGroupKey(config, candidate.market);
    const list = byGroup.get(key) ?? [];
    list.push(candidate);
    byGroup.set(key, list);
  }
  const dropped = new Set<MarketRouteCandidate>();
  for (const group of byGroup.values()) {
    const distinctOutcomes = new Set(group.map((candidate) => candidate.market.outcomeIndex ?? candidate.market.tokenId));
    if (distinctOutcomes.size <= 1) continue;
    const tradableSides = group.filter((candidate) => candidate.tradable);
    const pool = tradableSides.length > 0 ? tradableSides : group;
    const keep = [...pool].sort((a, b) =>
      polymarketOutcomeExitPrice(b) - polymarketOutcomeExitPrice(a) || b.score - a.score)[0];
    for (const candidate of group) {
      if (candidate !== keep) dropped.add(candidate);
    }
  }
  return dropped.size === 0 ? candidates : candidates.filter((candidate) => !dropped.has(candidate));
}

function selectCashMarketBasket(
  config: AppConfig,
  venue: VenueName,
  candidates: MarketRouteCandidate[],
  previousTokenIds: string[] = []
): MarketRouteSelection {
  // Polymarket single-sided: quote each market only on its lowest-exit-loss (highest-price) side. The full
  // candidate list is still returned below for reporting/audit; only selection eligibility is scoped here.
  const sideScoped = preferPolymarketMinExitLossSide(config, venue, candidates);
  const tradable = sideScoped.filter((candidate) => candidate.tradable);
  const best = tradable[0];
  if (!best) {
    return {
      selected: [],
      candidates,
      switched: false,
      reason: '没有满足 PP、流动性、盘口和风控条件的候选市场'
    };
  }
  const selected = pickCashBasketRoutes(config, venue, tradable, previousTokenIds);
  const selectedTokenIds = new Set(selected.map((candidate) => candidate.market.tokenId));
  const previous = previousRouteCandidate(config, tradable, previousTokenIds);
  const retained = previousTokenIds.filter((tokenId) => selectedTokenIds.has(tokenId)).length;
  const added = selected.filter((candidate) => !previousTokenIds.includes(candidate.market.tokenId)).length;
  const maxNew = cashBasketMaxNewEntries(config);
  return {
    selected,
    candidates,
    previous,
    best,
    switched: false,
    reason: previousTokenIds.length > 0
      ? `现金单边多市场模式：按 101 份 PP/hr/kUSD 资金效率降序维护最多 ${Math.max(1, config.risk.maxMarkets)} 个安全挂单；保留 ${retained} 个已有安全 token，补入 ${added} 个高分候选，每轮最多替换 ${maxNew} 个明显更优候选`
      : `现金单边多市场模式：按 101 份 PP/hr/kUSD 资金效率降序进场最多 ${Math.max(1, config.risk.maxMarkets)} 个安全挂单，不做单池自动切换`
  };
}

export function isPolymarketTwoSidedLp(config: AppConfig, venue: VenueName): boolean {
  return venue === 'polymarket' && config.strategy.polymarketTwoSidedLp === true;
}

export function polymarketLpPerLegUsd(config: AppConfig): number {
  const legs = Math.max(1, config.strategy.maxTokensPerMarket ?? 2);
  return Number((Math.max(0, config.strategy.polymarketLpTotalUsd) / legs).toFixed(4));
}

interface PolymarketLpGroup {
  groupKey: string;
  legs: MarketRouteCandidate[];
  expectedPpPerHour: number;
  expectedDailyRewardUsd: number;
  targetOrderUsd: number;
  efficiency: number;
  volatilityPct: number;
}

function polymarketLpGroups(config: AppConfig, venue: VenueName, candidates: MarketRouteCandidate[]): PolymarketLpGroup[] {
  const optimizer = createRewardOptimizer(venue, config);
  const maxTokens = Math.max(1, config.strategy.maxTokensPerMarket ?? 2);
  const groups = new Map<string, MarketRouteCandidate[]>();
  for (const candidate of candidates) {
    if (!candidate.tradable) continue;
    const key = optimizer.marketKey(candidate.market);
    const list = groups.get(key) ?? [];
    list.push(candidate);
    groups.set(key, list);
  }
  return [...groups.entries()]
    .flatMap(([groupKey, raw]) => {
      const legs = [...new Map(raw.map((candidate) => [candidate.market.tokenId, candidate] as const)).values()]
        .sort(compareOutcomeCandidates)
        .slice(0, maxTokens);
      const expected = expectedOutcomeCount(legs.map((leg) => leg.market));
      // Two-sided LP needs both legs (YES + NO) of the same group quotable at once.
      if (expected === undefined || legs.length < Math.min(2, expected)) return [];
      // Capital occupied per group:
      //  - negRisk markets: YES + NO BUYs share collateral (settlement pays at most ONE side, so the CLOB nets the
      //    requirement to max(legY, legN) rather than sum). Reflect that in efficiency or negRisk groups get a 2x
      //    artificially-inflated denominator and lose every sort against non-negRisk.
      //  - non-negRisk markets: each leg locks its own collateral, so sum is correct.
      // This is POLYMARKET-ONLY routing math; Predict's router does not call this function.
      const isNegRiskGroup = legs.length > 0 && legs.every((leg) => leg.market.negRisk === true);
      const targetOrderUsd = isNegRiskGroup
        ? Math.max(...legs.map((leg) => leg.metrics.targetOrderUsd))
        : legs.reduce((sum, leg) => sum + leg.metrics.targetOrderUsd, 0);
      // Prefer the official two-sided Qmin reward model; fall back to summing one-sided legs
      // when per-leg scores aren't available (e.g. missing book).
      const expectedPpPerHour = polymarketTwoSidedGroupExpectedPpPerHour(legs)
        ?? legs.reduce((sum, leg) => sum + routeExpectedPp(leg), 0);
      const rawEfficiency = targetOrderUsd > 0 ? (expectedPpPerHour / targetOrderUsd) * 1000 : 0;
      // Volatility filter: de-rate efficiency for trending/volatile markets (safer to LP in range-bound ones).
      const volatilityPct = legs
        .map((leg) => polymarketMidVolatilityPct(leg.market.tokenId))
        .filter((value): value is number => value !== undefined)
        .reduce((max, value) => Math.max(max, value), 0);
      const volMultiplier = volatilityPct > 0 ? Math.max(0.2, 1 - volatilityPct / POLY_VOL_HARD_EXCLUDE_PCT) : 1;
      return [{
        groupKey,
        legs,
        expectedPpPerHour: Number(expectedPpPerHour.toFixed(4)),
        expectedDailyRewardUsd: Number((expectedPpPerHour * 24).toFixed(4)),
        targetOrderUsd: Number(targetOrderUsd.toFixed(4)),
        efficiency: Number((rawEfficiency * volMultiplier).toFixed(4)),
        volatilityPct: Number(volatilityPct.toFixed(4))
      }];
    })
    .sort((a, b) => b.efficiency - a.efficiency || b.expectedPpPerHour - a.expectedPpPerHour || a.groupKey.localeCompare(b.groupKey));
}

function polymarketTwoSidedGroupExpectedPpPerHour(legs: MarketRouteCandidate[]): number | undefined {
  if (legs.length < 2) return undefined;
  const a = legs[0]!.metrics;
  const b = legs[1]!.metrics;
  if ([a.polymarketYourScore, b.polymarketYourScore, a.polymarketCompetitorBid, a.polymarketCompetitorAsk, b.polymarketCompetitorBid, b.polymarketCompetitorAsk].some((value) => value === undefined)) {
    return undefined;
  }
  const dailyRate = legs[0]!.market.rewards?.dailyRate;
  if (!dailyRate || dailyRate <= 0) return undefined;
  const mid = a.polymarketMid ?? 0.5;
  // Official Qone/Qtwo cross-partition: a NO bid is economically a YES ask.
  // My two BUY legs: leg a bid -> Qone, leg b bid -> Qtwo.
  const myQmin = polymarketQmin(a.polymarketYourScore as number, b.polymarketYourScore as number, mid);
  // Competitors: Qone = bids on a + asks on b ; Qtwo = asks on a + bids on b.
  const compQone = (a.polymarketCompetitorBid as number) + (b.polymarketCompetitorAsk as number);
  const compQtwo = (a.polymarketCompetitorAsk as number) + (b.polymarketCompetitorBid as number);
  const compQmin = polymarketQmin(compQone, compQtwo, mid);
  const total = compQmin + myQmin;
  if (total <= 0) return 0;
  const expectedDailyRewardUsd = dailyRate * (myQmin / total);
  return Number((expectedDailyRewardUsd / 24).toFixed(4));
}

function selectPolymarketTwoSidedRoutes(
  config: AppConfig,
  venue: VenueName,
  candidates: MarketRouteCandidate[],
  previousTokenIds: string[]
): MarketRouteSelection {
  const allGroups = polymarketLpGroups(config, venue, candidates);
  // Polymarket pays nothing if your daily reward for a market is below the payout threshold ($1),
  // so drop groups whose estimated daily reward is under it — quoting them only risks inventory for $0.
  // Small-live TEST MODE: drop the $1/day payout threshold and volatility exclusion so a tiny order can place.
  const testMode = config.strategy.polymarketTestMode === true;
  const minDailyRewardUsd = testMode ? 0 : Math.max(0, config.strategy.polymarketMinDailyRewardUsd ?? 1);
  const groups = allGroups.filter((group) => group.expectedDailyRewardUsd >= minDailyRewardUsd && (testMode || group.volatilityPct <= POLY_VOL_HARD_EXCLUDE_PCT));
  const bestGroup = groups[0];
  if (!bestGroup) {
    const top = allGroups[0];
    return {
      selected: [],
      candidates,
      switched: false,
      reason: !top
        ? '没有满足条件的完整 YES/NO 双边 LP 候选市场'
        : top.volatilityPct > POLY_VOL_HARD_EXCLUDE_PCT
          ? `最优双边 LP 市场近期中价波动 ${top.volatilityPct.toFixed(2)}% 偏高(趋势/高波动),本轮跳过以免被吃累积单边库存`
          : `最优双边 LP 市场预计日奖励 ${formatUsd(top.expectedDailyRewardUsd)} 低于 ${formatUsd(minDailyRewardUsd)} 发放门槛(低于不发放),本轮跳过以免空挂浪费资金`
    };
  }
  const maxMarkets = Math.max(1, config.strategy.polymarketMaxMarkets ?? 1);
  const threshold = (config.strategy.polymarketSwitchThresholdPct ?? 20) / 100;
  const previousGroup = previousTokenIds.length > 0
    ? groups.find((group) => group.legs.some((leg) => previousTokenIds.includes(leg.market.tokenId)))
    : undefined;

  let primaryGroups = groups.slice(0, maxMarkets);
  let switched = previousGroup !== undefined;
  let reason: string;
  if (previousGroup && bestGroup.groupKey !== previousGroup.groupKey) {
    // No gas on Polymarket, but use a steady margin so we don't flap on book noise.
    const beatsMargin = bestGroup.efficiency > previousGroup.efficiency * (1 + threshold);
    if (beatsMargin) {
      switched = true;
      reason = `挑战者资金效率 ${bestGroup.efficiency} 超过当前 ${previousGroup.efficiency} ×${(1 + threshold).toFixed(2)}，切换到更优双边 LP 市场`;
    } else {
      const rest = groups.filter((group) => group.groupKey !== previousGroup.groupKey).slice(0, Math.max(0, maxMarkets - 1));
      primaryGroups = [previousGroup, ...rest];
      switched = false;
      reason = `挑战者资金效率未超过当前 ×${(1 + threshold).toFixed(2)}，继续维持当前双边 LP 市场`;
    }
  } else {
    switched = false;
    reason = previousGroup ? '当前双边 LP 市场仍是最优资金效率，继续维持' : '选择当前最优资金效率的双边 LP 市场';
  }

  const selected = primaryGroups.flatMap((group) => group.legs);
  return {
    selected,
    candidates,
    ...(previousGroup?.legs[0] ? { previous: previousGroup.legs[0] } : {}),
    ...(bestGroup.legs[0] ? { best: bestGroup.legs[0] } : {}),
    switched,
    reason
  };
}

function routeMetrics(
  config: AppConfig,
  venue: VenueName,
  market: Market,
  book: Orderbook | undefined,
  sides: OrderSide[],
  context: {
    splitInventoryShares?: number;
    splitGroupReferencePrices?: Map<string, number>;
    ownOpenOrders?: OpenOrder[];
    rewardPoolDepthUsd?: number;
    targetOrderUsd?: number;
    targetShares?: number;
    targetOrderSource?: MarketRouteMetrics['targetOrderSource'];
    targetReferencePrice?: number;
  } = {}
): MarketRouteMetrics {
  const bbo = book ? bestBidAsk(book) : {};
  const mid = bbo.mid ?? 0.5;
  const spread = bbo.spread;
  const spreadCents = spread === undefined ? undefined : spread * 100;
  const spreadBps = spread === undefined || mid <= 0 ? undefined : (spread / mid) * 10000;
  const metricSides = sides.length > 0 ? sides : potentialRouteSides(config);
  // For a cash BUY the order rests at/near the best bid (below mid), so the min reward notional (cost to place the
  // target shares) should be estimated at the bid, not mid — mid overstates it and false-rejects boundary orders.
  // A provided context price (the real computed quote) always wins.
  const targetReferencePrice = validPrice(context.targetReferencePrice)
    ? context.targetReferencePrice
    : (validPrice(bbo.bestBid) ? bbo.bestBid : mid);
  const targetRewardShares = rewardTargetShares(config, market.rewards?.minShares);
  const minRewardNotionalUsd = targetRewardShares === undefined
    ? undefined
    : targetRewardShares * targetReferencePrice;
  const configuredTargetOrderUsd = config.risk.orderSizeUsd;
  const splitTargetOrderUsd = splitEffectiveSellNotionalUsd(config, venue, market, book, mid, context.splitInventoryShares, context.splitGroupReferencePrices);
  const targetOrderUsd = splitTargetOrderUsd ?? context.targetOrderUsd ?? configuredTargetOrderUsd;
  const targetOrderSource = splitTargetOrderUsd !== undefined ? 'split-paired-sell' : context.targetOrderSource ?? (context.targetOrderUsd !== undefined ? 'quote' : 'configured');
  const ppPerHour = estimatedPpPerHour(market);
  const legDepthUsd = book ? rewardBandDepthUsd(book, market, metricSides, context.ownOpenOrders) : 0;
  const bandDepthUsd = context.rewardPoolDepthUsd !== undefined && Number.isFinite(context.rewardPoolDepthUsd) && context.rewardPoolDepthUsd >= 0
    ? context.rewardPoolDepthUsd
    : legDepthUsd;
  const hasCompetitionDepth = Boolean(book) || context.rewardPoolDepthUsd !== undefined;
  // Polymarket splits its daily reward pool by a proximity-weighted score, not by
  // flat band depth, so it uses a venue-specific competition model. Predict and any
  // market without the required reward inputs keep the existing depth-based metric.
  const polymarketCompetition = venue === 'polymarket' && book
    ? polymarketRewardCompetition({
        config,
        market,
        book,
        ...(context.ownOpenOrders ? { ownOpenOrders: context.ownOpenOrders } : {}),
        targetOrderUsd,
        targetReferencePrice
      })
    : undefined;
  const competition = polymarketCompetition
    ? {
        expectedPpPerHour: polymarketCompetition.expectedPpPerHour,
        ppPerThousandUsd: polymarketCompetition.ppPerThousandUsd,
        targetSharePct: polymarketCompetition.targetSharePct,
        competitionBand: polymarketCompetition.competitionBand,
        polymarketYourScore: polymarketCompetition.yourScore,
        polymarketCompetitorBid: polymarketCompetition.competitorBidScore,
        polymarketCompetitorAsk: polymarketCompetition.competitorAskScore,
        polymarketMid: polymarketCompetition.mid
      }
    : hasCompetitionDepth
      ? competitionMetrics({
          ppPerHour,
          rewardBandDepthUsd: bandDepthUsd,
          targetOrderUsd
        })
      : { competitionBand: 'unknown' as const };
  return {
    ppPerHour,
    rewardLevel: rewardLevel(market),
    ...(spreadCents !== undefined ? { spreadCents } : {}),
    ...(spreadBps !== undefined ? { spreadBps } : {}),
    rewardBandDepthUsd: bandDepthUsd,
    topDepthUsd: book ? topDepthUsd(book, metricSides) : 0,
    ...competition,
    ...(minRewardNotionalUsd !== undefined ? { minRewardNotionalUsd: Number(minRewardNotionalUsd.toFixed(4)) } : {}),
    targetOrderUsd: Number(targetOrderUsd.toFixed(4)),
    ...(context.targetShares !== undefined ? { targetShares: Number(context.targetShares.toFixed(4)) } : {}),
    targetOrderSource,
    liquidityUsd: market.liquidityUsd,
    volume24hUsd: market.volume24hUsd,
    ...(remainingSafeHours(config, market) !== undefined ? { remainingSafeHours: remainingSafeHours(config, market) } : {})
  };
}

function cashRouteScoringTarget(
  config: AppConfig,
  market: Market,
  quotePrice: number | undefined,
  book?: Orderbook
): { targetOrderUsd: number; targetShares: number; targetOrderSource: 'reward-minimum-plus-one'; referencePrice: number } | undefined {
  if (isPairedEntryMode(config)) return undefined;
  // For cash single-leg the bot quotes the CHEAP side at/near the best bid; if the route-stage couldn't generate a
  // quote yet (book too thin for the reward-protection check), fall back to the LIVE best bid so the minRewardNotional
  // estimate reflects the actual outcome's price. The previous 0.5 mid-fallback false-rejected the cheap side of any
  // asymmetric market (Starmer No bid=0.12 was reported as needing $100.5 instead of the true $24).
  const fallbackPrice = book ? (bestBidAsk(book).bestBid ?? 0.5) : 0.5;
  if (isPolymarketTwoSidedLp(config, market.venue)) {
    const price = validPrice(quotePrice) ? quotePrice : fallbackPrice;
    const perLegUsd = polymarketLpPerLegUsd(config);
    return {
      targetOrderUsd: Number(perLegUsd.toFixed(4)),
      targetShares: Number((perLegUsd / Math.max(price, 0.0001)).toFixed(4)),
      targetOrderSource: 'reward-minimum-plus-one',
      referencePrice: price
    };
  }
  const referencePrice = validPrice(quotePrice) ? quotePrice : fallbackPrice;
  const targetShares = rewardTargetShares(config, market.rewards?.minShares);
  if (targetShares === undefined) return undefined;
  const rewardMinimumNotional = targetShares * referencePrice;
  const targetOrderUsd = shouldEnforceRewardMinimum(config)
    ? config.risk.orderSizeUsd
    : rewardMinimumNotional;
  return {
    targetOrderUsd: Number(targetOrderUsd.toFixed(4)),
    targetShares,
    targetOrderSource: 'reward-minimum-plus-one',
    referencePrice
  };
}

function validPrice(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value > 0 && value < 1;
}

function potentialRouteSides(config: AppConfig): OrderSide[] {
  if (isPairedEntryMode(config)) return ['SELL'];
  return [];
}

function fallbackRouteSides(config: AppConfig): OrderSide[] {
  if (isPairedEntryMode(config)) return ['SELL'];
  const quoteSide = effectiveQuoteSide(config);
  if (quoteSide === 'sell') return ['SELL'];
  return ['BUY'];
}

function splitEffectiveSellNotionalUsd(
  config: AppConfig,
  venue: VenueName,
  market: Market,
  book: Orderbook | undefined,
  fallbackPrice: number,
  inventoryShares: number | undefined,
  groupReferencePrices: Map<string, number> | undefined
): number | undefined {
  if (!isPairedEntryMode(config)) return undefined;
  const minRewardShares = shouldEnforceRewardMinimum(config)
    ? rewardTargetShares(config, market.rewards?.minShares) ?? 0
    : 0;
  const price = splitSellReferencePrice(config, venue, market, book) ?? fallbackPrice;
  if (!Number.isFinite(price) || price <= 0) return undefined;
  const groupPriceSum = groupReferencePrices && groupReferencePrices.size > 0
    ? [...groupReferencePrices.values()].reduce((sum, value) => sum + Math.max(0, value), 0)
    : price;
  const budgetShares = shouldEnforceRewardMinimum(config)
    ? config.risk.orderSizeUsd / Math.max(price, 0.0001)
    : config.risk.orderSizeUsd / Math.max(groupPriceSum, 0.0001);
  const plannedShares = Math.max(budgetShares, minRewardShares);
  const shares = Math.min(
    plannedShares,
    inventoryShares === undefined ? plannedShares : Math.max(0, inventoryShares)
  );
  if (!Number.isFinite(shares) || shares <= 0) return undefined;
  return Number((shares * price).toFixed(4));
}

function splitReferencePrices(
  config: AppConfig,
  venue: VenueName,
  markets: Market[],
  books: Map<string, Orderbook>
): Map<string, Map<string, number>> {
  if (!isPairedEntryMode(config)) return new Map();
  const result = new Map<string, Map<string, number>>();
  for (const market of markets) {
    const groupKey = marketGroupKey(config, market);
    const book = books.get(market.tokenId);
    const bbo = book ? bestBidAsk(book) : {};
    const price = splitSellReferencePrice(config, venue, market, book) ?? bbo.mid;
    if (!Number.isFinite(price) || price === undefined || price <= 0) continue;
    const prices = result.get(groupKey) ?? new Map<string, number>();
    prices.set(market.tokenId, price);
    result.set(groupKey, prices);
  }
  return result;
}

function splitSellReferencePrice(
  config: AppConfig,
  venue: VenueName,
  market: Market,
  book: Orderbook | undefined
): number | undefined {
  if (!book) return undefined;
  return createRewardOptimizer(venue, config).buildQuote(market, book, 'SELL', {
    config,
    positions: []
  })?.price;
}

function cashRewardPoolDepthByGroupSide(
  config: AppConfig,
  venue: VenueName,
  markets: Market[],
  books: Map<string, Orderbook>,
  ownOpenOrders: OpenOrder[]
): Map<string, number> {
  if (isPairedEntryMode(config)) return new Map();
  const result = new Map<string, number>();
  for (const market of markets) {
    if (market.venue !== venue) continue;
    const book = books.get(market.tokenId);
    if (!book) continue;
    const groupKey = marketGroupKey(config, market);
    for (const side of routeSides(config, market)) {
      const key = rewardPoolDepthKey(venue, groupKey, side);
      const depth = rewardBandDepthUsd(book, market, [side], ownOpenOrders);
      result.set(key, Number(((result.get(key) ?? 0) + depth).toFixed(4)));
    }
  }
  return result;
}

function rewardPoolDepthKey(venue: VenueName, groupKey: string, side: OrderSide): string {
  return `${venue}:${groupKey}:${side}`;
}

function routeScore(metrics: MarketRouteMetrics, riskFlagCount: number, assessmentScore: number): number {
  const expectedPpScore = metrics.expectedPpPerHour !== undefined
    ? Math.min(520, Math.log10(metrics.expectedPpPerHour + 1) * 210)
    : 0;
  const ppScore = metrics.ppPerHour > 0 ? Math.min(160, Math.log10(metrics.ppPerHour + 1) * 45) : metrics.rewardLevel * 35;
  const bandDepthScore = Math.min(120, Math.log10(metrics.rewardBandDepthUsd + 1) * 30);
  const topDepthScore = Math.min(80, Math.log10(metrics.topDepthUsd + 1) * 22);
  const competitionScore = competitionScoreFromMetrics(metrics);
  const liquidityScore = Math.min(55, Math.log10(metrics.liquidityUsd + 1) * 11);
  const volumeScore = Math.min(45, Math.log10(metrics.volume24hUsd + 1) * 9);
  const spreadScore = metrics.spreadCents === undefined
    ? -60
    : Math.max(0, 100 - metrics.spreadCents * 18);
  const targetFitScore = metrics.minRewardNotionalUsd === undefined
    ? 20
    : Math.max(0, 70 - Math.max(0, metrics.minRewardNotionalUsd - metrics.targetOrderUsd));
  return Number(Math.max(0, assessmentScore + expectedPpScore + ppScore + bandDepthScore + topDepthScore + competitionScore + liquidityScore + volumeScore + spreadScore + targetFitScore - riskFlagCount * 120).toFixed(2));
}

function previousRouteCandidate(config: AppConfig, tradable: MarketRouteCandidate[], previousTokenIds: string[]): MarketRouteCandidate | undefined {
  if (previousTokenIds.length === 0) return undefined;
  for (const tokenId of previousTokenIds) {
    const byToken = tradable.find((candidate) => candidate.market.tokenId === tokenId);
    if (byToken) return byToken;
  }
  const previousGroups = previousTokenIds
    .map((tokenId) => tradable.find((candidate) => candidate.market.tokenId === tokenId)?.groupKey)
    .filter((groupKey): groupKey is string => Boolean(groupKey));
  for (const groupKey of previousGroups) {
    const byGroup = tradable.find((candidate) => candidate.groupKey === groupKey);
    if (byGroup) return byGroup;
  }
  return undefined;
}

function selectSplitMarketRoutes(
  config: AppConfig,
  venue: VenueName,
  candidates: MarketRouteCandidate[],
  previousTokenIds: string[]
): MarketRouteSelection {
  const groups = completeSplitRouteGroups(config, venue, candidates.filter((candidate) => candidate.tradable));
  const bestGroup = groups[0];
  if (!bestGroup) {
    return {
      selected: [],
      candidates,
      switched: false,
      reason: '没有满足 PP、流动性、盘口和风控条件的完整 YES/NO 候选市场'
    };
  }

  const previousGroup = previousSplitRouteGroup(groups, previousTokenIds);
  const threshold = (config.strategy.switchThresholdPct ?? 15) / 100;
  const switchDecision = previousGroup && bestGroup.groupKey !== previousGroup.groupKey
    ? crossPoolGroupSwitchDecision(config, previousGroup, bestGroup, threshold)
    : {
        keepPrevious: previousGroup !== undefined && bestGroup.groupKey !== previousGroup.groupKey && bestGroup.score <= previousGroup.score * (1 + threshold),
        reason: `新候选优势未超过 ${(threshold * 100).toFixed(0)}%，继续留在当前市场`
      };
  const keepPrevious = Boolean(previousGroup && bestGroup.groupKey !== previousGroup.groupKey && switchDecision.keepPrevious);
  const primaryGroup = keepPrevious && previousGroup ? previousGroup : bestGroup;
  const selected = pickCompleteSplitGroups(config, venue, primaryGroup.candidates);
  const previous = previousGroup?.candidates[0];
  const best = bestGroup.candidates[0];

  return {
    selected,
    candidates,
    previous,
    best,
    previousGroup,
    bestGroup,
    switched: previousGroup !== undefined && selected.every((candidate) => !previousTokenIds.includes(candidate.market.tokenId)),
    reason: keepPrevious
      ? switchDecision.reason
      : previousGroup
        ? '发现更优 group expected PP 完整市场组，允许切换'
        : '选择当前全局最优 expected PP 完整市场组'
  };
}

function previousSplitRouteGroup(groups: MarketRouteGroupSummary[], previousTokenIds: string[]): MarketRouteGroupSummary | undefined {
  if (previousTokenIds.length === 0) return undefined;
  for (const tokenId of previousTokenIds) {
    const group = groups.find((candidateGroup) => candidateGroup.candidates.some((candidate) => candidate.market.tokenId === tokenId));
    if (group) return group;
  }
  return undefined;
}

function completeSplitRouteGroups(config: AppConfig, venue: VenueName, candidates: MarketRouteCandidate[]): MarketRouteGroupSummary[] {
  const maxTokensPerMarket = config.strategy.maxTokensPerMarket ?? 2;
  const optimizer = createRewardOptimizer(venue, config);
  const groups = new Map<string, MarketRouteCandidate[]>();
  for (const candidate of candidates) {
    const key = optimizer.marketKey(candidate.market);
    const list = groups.get(key) ?? [];
    list.push(candidate);
    groups.set(key, list);
  }
  return [...groups.entries()]
    .flatMap(([groupKey, group]) => {
      const uniqueByToken = [...new Map(group.map((candidate) => [candidate.market.tokenId, candidate] as const)).values()];
      const expected = expectedOutcomeCount(uniqueByToken.map((candidate) => candidate.market));
      if (expected === undefined || expected > maxTokensPerMarket) return [];
      if (!hasCompleteOutcomeSet(uniqueByToken.map((candidate) => candidate.market))) return [];
      const candidatesByOutcome = uniqueByToken.sort(compareOutcomeCandidates);
      return [routeGroupSummary(groupKey, candidatesByOutcome, expected)];
    })
    .sort(compareRouteGroups);
}

function routeGroupSummary(groupKey: string, candidates: MarketRouteCandidate[], outcomeCount: number): MarketRouteGroupSummary {
  const expectedPpPerHour = candidates.reduce((sum, candidate) => sum + (candidate.metrics.expectedPpPerHour ?? expectedPpFromMetrics(candidate.metrics)), 0);
  const targetOrderUsd = candidates.reduce((sum, candidate) => sum + candidate.metrics.targetOrderUsd, 0);
  const rewardBandDepthUsd = candidates.reduce((sum, candidate) => sum + candidate.metrics.rewardBandDepthUsd, 0);
  const topDepthUsd = candidates.reduce((sum, candidate) => sum + candidate.metrics.topDepthUsd, 0);
  const weightedEfficiency = targetOrderUsd > 0
    ? candidates.reduce((sum, candidate) => sum + (candidate.metrics.ppPerThousandUsd ?? 0) * candidate.metrics.targetOrderUsd, 0) / targetOrderUsd
    : undefined;
  const remainingHours = candidates
    .map((candidate) => candidate.metrics.remainingSafeHours)
    .filter((value): value is number => value !== undefined && Number.isFinite(value));
  const representative = candidates[0]!;
  return {
    groupKey,
    ...(representative.market.marketId ? { marketId: representative.market.marketId } : {}),
    question: representative.market.question,
    outcomeCount,
    score: Number(candidates.reduce((sum, candidate) => sum + candidate.score, 0).toFixed(2)),
    expectedPpPerHour: Number(expectedPpPerHour.toFixed(4)),
    ...(weightedEfficiency !== undefined ? { ppPerThousandUsd: Number(weightedEfficiency.toFixed(4)) } : {}),
    targetOrderUsd: Number(targetOrderUsd.toFixed(4)),
    rewardBandDepthUsd: Number(rewardBandDepthUsd.toFixed(4)),
    topDepthUsd: Number(topDepthUsd.toFixed(4)),
    ...(remainingHours.length > 0 ? { remainingSafeHours: Math.min(...remainingHours) } : {}),
    candidates
  };
}

function compareRouteGroups(a: MarketRouteGroupSummary, b: MarketRouteGroupSummary): number {
  return b.expectedPpPerHour - a.expectedPpPerHour
    || b.score - a.score
    || (b.ppPerThousandUsd ?? 0) - (a.ppPerThousandUsd ?? 0)
    || b.rewardBandDepthUsd - a.rewardBandDepthUsd
    || a.groupKey.localeCompare(b.groupKey);
}

function compareOutcomeCandidates(a: MarketRouteCandidate, b: MarketRouteCandidate): number {
  const aIndex = a.market.outcomeIndex ?? Number.MAX_SAFE_INTEGER;
  const bIndex = b.market.outcomeIndex ?? Number.MAX_SAFE_INTEGER;
  return aIndex - bIndex || String(a.market.outcome ?? '').localeCompare(String(b.market.outcome ?? '')) || b.score - a.score;
}

function completeCandidateGroups(config: AppConfig, markets: Market[]): Set<string> {
  const grouped = new Map<string, Market[]>();
  for (const market of markets) {
    const key = marketGroupKey(config, market);
    const list = grouped.get(key) ?? [];
    list.push(market);
    grouped.set(key, list);
  }
  return new Set([...grouped.entries()]
    .filter(([, group]) => hasCompleteOutcomeSet(group))
    .map(([key]) => key));
}

function partialPairedInventoryGroups(
  config: AppConfig,
  markets: Market[],
  positions: Position[],
  pairedGroups: Set<string>
): Set<string> {
  if (!isPairedEntryMode(config) || positions.length === 0) return new Set();
  const marketsByToken = new Map(markets.map((market) => [market.tokenId, market] as const));
  const groups = new Set<string>();
  for (const position of positions) {
    if (position.size <= 1e-9 && Math.abs(position.notionalUsd) <= 0.01) continue;
    const market = marketsByToken.get(position.tokenId) ?? position.market;
    if (!market) continue;
    const key = marketGroupKey(config, market);
    if (!pairedGroups.has(key)) groups.add(key);
  }
  return groups;
}

function crossPoolSwitchDecision(
  config: AppConfig,
  previous: MarketRouteCandidate,
  best: MarketRouteCandidate,
  threshold: number
): { keepPrevious: boolean; reason: string } {
  const previousPp = previous.metrics.expectedPpPerHour ?? expectedPpFromMetrics(previous.metrics);
  const bestPp = best.metrics.expectedPpPerHour ?? expectedPpFromMetrics(best.metrics);
  const expectedEdgeOk = previousPp <= 0
    ? bestPp > 0
    : bestPp > previousPp * (1 + threshold);
  const remainingHours = best.metrics.remainingSafeHours ?? 0;
  const minSafeHours = config.strategy.minSafeHoursForSwitch ?? 0.5;
  if (remainingHours < minSafeHours) {
    return {
      keepPrevious: true,
      reason: `新市场剩余安全时间约 ${formatNumber(remainingHours)}h，低于换池要求 ${formatNumber(minSafeHours)}h，继续当前池子`
    };
  }
  if (!expectedEdgeOk) {
    return {
      keepPrevious: true,
      reason: `新市场 101 份 PP/hr/kUSD 资金效率优势未超过 ${(threshold * 100).toFixed(0)}%，继续维护当前单边池子`
    };
  }
  const edgePct = previousPp > 0 ? ((bestPp / previousPp) - 1) * 100 : Infinity;
  return {
    keepPrevious: false,
    reason: `单边 cash 新市场 101 份 PP/hr/kUSD 资金效率提升 ${Number.isFinite(edgePct) ? `${formatNumber(edgePct)}%` : '显著'}，无需 split/merge gas，允许撤换单切换`
  };
}

function crossPoolGroupSwitchDecision(
  config: AppConfig,
  previous: MarketRouteGroupSummary,
  best: MarketRouteGroupSummary,
  threshold: number
): { keepPrevious: boolean; reason: string } {
  const expectedPpEdgeOk = best.expectedPpPerHour > previous.expectedPpPerHour * (1 + threshold);
  const remainingHours = best.remainingSafeHours ?? 0;
  const minSafeHours = config.strategy.minSafeHoursForSwitch ?? 0.5;
  if (remainingHours < minSafeHours) {
    return {
      keepPrevious: true,
      reason: `新市场剩余安全时间约 ${formatNumber(remainingHours)}h，低于换池要求 ${formatNumber(minSafeHours)}h，继续当前池子`
    };
  }
  const gasCostUsd = splitMergeRoundTripGasUsd(config);
  const extraPpValueUsd = switchGroupPpEdgeUsd(previous, best, remainingHours);
  const requiredBenefit = Math.max(
    config.strategy.minSwitchEdgeAfterGasUsd ?? 0.05,
    gasCostUsd * Math.max(0, config.strategy.minSwitchBenefitMultiplier ?? 4)
  );
  if (!expectedPpEdgeOk || extraPpValueUsd < requiredBenefit) {
    return {
      keepPrevious: true,
      reason: `新市场优势不足以覆盖换池成本：预计额外价值 ${formatUsd(extraPpValueUsd)}，要求至少 ${formatUsd(requiredBenefit)}；优先撤单/重挂当前池子`
    };
  }
  return {
    keepPrevious: false,
    reason: `新市场预计额外价值 ${formatUsd(extraPpValueUsd)} 已覆盖换池 gas 成本 ${formatUsd(gasCostUsd)}，允许切换`
  };
}

function switchGroupPpEdgeUsd(previous: MarketRouteGroupSummary, best: MarketRouteGroupSummary, remainingHours: number): number {
  const estimatedPp = Math.max(0, best.expectedPpPerHour - previous.expectedPpPerHour) * Math.max(0, remainingHours);
  return Number((estimatedPp / 1000).toFixed(4));
}

function splitMergeRoundTripGasUsd(config: AppConfig): number {
  const gasUnits = Math.max(1, config.strategy.fallbackSplitMergeGasUnits ?? 450000);
  const gasPriceGwei = 3;
  const buffer = Math.max(1, config.strategy.gasBufferMultiplier ?? 1.35);
  const oneTxBnb = gasUnits * gasPriceGwei * 1e-9 * buffer;
  return Number((oneTxBnb * 2 * (config.strategy.bnbUsdForGasEstimate ?? 650)).toFixed(4));
}

function pickTopRoutes(config: AppConfig, venue: VenueName, candidates: MarketRouteCandidate[]): MarketRouteCandidate[] {
  if (isPairedEntryMode(config)) return pickCompleteSplitGroups(config, venue, candidates);
  const maxMarkets = Math.max(1, config.risk.maxMarkets);
  const maxTokensPerMarket = config.strategy.maxTokensPerMarket ?? 2;
  const maxSelected = maxMarkets;
  if (!config.strategy.dedupeMarketGroups) return uniqueTokenRoutes(candidates).slice(0, maxSelected);
  const optimizer = createRewardOptimizer(venue, config);
  const perGroup = new Map<string, number>();
  const perToken = new Set<string>();
  const selected: MarketRouteCandidate[] = [];
  for (const candidate of candidates) {
    if (perToken.has(candidate.market.tokenId)) continue;
    const key = optimizer.marketKey(candidate.market);
    const count = perGroup.get(key) ?? 0;
    if (count >= maxTokensPerMarket) continue;
    perToken.add(candidate.market.tokenId);
    perGroup.set(key, count + 1);
    selected.push(candidate);
    if (selected.length >= maxSelected) break;
  }
  return selected;
}

function pickCashBasketRoutes(
  config: AppConfig,
  venue: VenueName,
  candidates: MarketRouteCandidate[],
  previousTokenIds: string[]
): MarketRouteCandidate[] {
  if (isPairedEntryMode(config)) return pickTopRoutes(config, venue, candidates);
  if (previousTokenIds.length === 0) return pickTopRoutes(config, venue, candidates);
  const maxMarkets = Math.max(1, config.risk.maxMarkets);
  const maxTokensPerMarket = config.strategy.maxTokensPerMarket ?? 2;
  const optimizer = createRewardOptimizer(venue, config);
  const byToken = new Map(candidates.map((candidate) => [candidate.market.tokenId, candidate] as const));
  const previousCandidates = uniquePreviousCandidates(previousTokenIds, byToken);
  const replacement = cashBasketReplacementPlan(config, candidates, previousCandidates);
  const selected: MarketRouteCandidate[] = [];
  const perGroup = new Map<string, number>();
  const perToken = new Set<string>();
  const add = (candidate: MarketRouteCandidate | undefined): void => {
    if (!candidate || selected.length >= maxMarkets) return;
    if (perToken.has(candidate.market.tokenId)) return;
    const group = optimizer.marketKey(candidate.market);
    const count = perGroup.get(group) ?? 0;
    if ((config.strategy.dedupeMarketGroups ?? true) && count >= maxTokensPerMarket) return;
    perToken.add(candidate.market.tokenId);
    perGroup.set(group, count + 1);
    selected.push(candidate);
  };
  for (const tokenId of replacement.newTokenIds) add(byToken.get(tokenId));
  for (const tokenId of previousTokenIds) {
    if (replacement.replacedPreviousTokenIds.has(tokenId)) continue;
    add(byToken.get(tokenId));
  }
  for (const candidate of candidates) add(candidate);
  return selected;
}

function uniquePreviousCandidates(
  previousTokenIds: string[],
  byToken: Map<string, MarketRouteCandidate>
): MarketRouteCandidate[] {
  const seen = new Set<string>();
  const previous: MarketRouteCandidate[] = [];
  for (const tokenId of previousTokenIds) {
    if (seen.has(tokenId)) continue;
    seen.add(tokenId);
    const candidate = byToken.get(tokenId);
    if (candidate) previous.push(candidate);
  }
  return previous;
}

function cashBasketReplacementPlan(
  config: AppConfig,
  candidates: MarketRouteCandidate[],
  previousCandidates: MarketRouteCandidate[]
): { newTokenIds: string[]; replacedPreviousTokenIds: Set<string> } {
  if (previousCandidates.length === 0) return { newTokenIds: [], replacedPreviousTokenIds: new Set() };
  const maxNew = cashBasketMaxNewEntries(config);
  const threshold = Math.max(0, (config.strategy.switchThresholdPct ?? 15) / 100);
  const previousTokens = new Set(previousCandidates.map((candidate) => candidate.market.tokenId));
  const replacedPreviousTokenIds = new Set<string>();
  const replacementPool = [...previousCandidates].sort(compareCashReplacementPriority);
  const newTokenIds: string[] = [];

  for (const candidate of candidates) {
    if (newTokenIds.length >= maxNew) break;
    if (previousTokens.has(candidate.market.tokenId)) continue;
    const replacement = replacementPool.find((previous) => {
      if (replacedPreviousTokenIds.has(previous.market.tokenId)) return false;
      return cashCandidateMateriallyBetter(candidate, previous, threshold);
    });
    if (!replacement) continue;
    replacedPreviousTokenIds.add(replacement.market.tokenId);
    newTokenIds.push(candidate.market.tokenId);
  }

  return { newTokenIds, replacedPreviousTokenIds };
}

function compareCashReplacementPriority(a: MarketRouteCandidate, b: MarketRouteCandidate): number {
  return cashReplacementEfficiency(a) - cashReplacementEfficiency(b)
    || routeExpectedPp(a) - routeExpectedPp(b)
    || a.score - b.score
    || a.market.tokenId.localeCompare(b.market.tokenId);
}

function cashCandidateMateriallyBetter(candidate: MarketRouteCandidate, previous: MarketRouteCandidate, threshold: number): boolean {
  const candidateEfficiency = cashReplacementEfficiency(candidate);
  const previousEfficiency = cashReplacementEfficiency(previous);
  if (candidateEfficiency <= previousEfficiency * (1 + threshold)) return false;
  if (candidateEfficiency > 0 || previousEfficiency > 0) return true;
  return routeExpectedPp(candidate) > routeExpectedPp(previous) * (1 + threshold);
}

function cashReplacementEfficiency(candidate: MarketRouteCandidate): number {
  return candidate.metrics.ppPerThousandUsd ?? cashEfficiencyPpPerThousand(candidate) ?? 0;
}

function cashBasketMaxNewEntries(config: AppConfig): number {
  const maxMarkets = Math.max(1, config.risk.maxMarkets);
  return Math.max(1, Math.min(CASH_BASKET_MAX_NEW_PER_CYCLE, Math.ceil(maxMarkets * 0.2)));
}

function uniqueTokenRoutes(candidates: MarketRouteCandidate[]): MarketRouteCandidate[] {
  const seen = new Set<string>();
  const result: MarketRouteCandidate[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.market.tokenId)) continue;
    seen.add(candidate.market.tokenId);
    result.push(candidate);
  }
  return result;
}

function pickCompleteSplitGroups(config: AppConfig, venue: VenueName, candidates: MarketRouteCandidate[]): MarketRouteCandidate[] {
  const maxGroups = Math.max(1, config.risk.maxMarkets);
  const maxTokensPerMarket = config.strategy.maxTokensPerMarket ?? 2;
  const optimizer = createRewardOptimizer(venue, config);
  const groups = new Map<string, MarketRouteCandidate[]>();
  for (const candidate of candidates) {
    const key = optimizer.marketKey(candidate.market);
    const list = groups.get(key) ?? [];
    list.push(candidate);
    groups.set(key, list);
  }
  const selected: MarketRouteCandidate[] = [];
  for (const group of groups.values()) {
    const uniqueByToken = [...new Map(group.map((candidate) => [candidate.market.tokenId, candidate] as const)).values()]
      .sort((a, b) => b.score - a.score);
    const expected = expectedOutcomeCount(uniqueByToken.map((candidate) => candidate.market));
    if (expected === undefined || expected > maxTokensPerMarket) continue;
    if (!hasCompleteOutcomeSet(uniqueByToken.map((candidate) => candidate.market))) continue;
    selected.push(...uniqueByToken.slice(0, expected));
    if (selected.length >= maxGroups * maxTokensPerMarket) break;
  }
  return selected;
}

function routeSides(config: AppConfig, market: Market, positions?: Position[]): OrderSide[] {
  if (isPairedEntryMode(config)) return ['SELL'];
  const quoteSide = effectiveQuoteSide(config);
  const hasInventory = positions === undefined || positions.some((position) => (
    position.tokenId === market.tokenId
    && (position.size > 1e-9 || Math.abs(position.notionalUsd) > 0.01)
  ));
  if (quoteSide === 'both') return hasInventory ? ['BUY', 'SELL'] : ['BUY'];
  if (quoteSide === 'sell') return hasInventory ? ['SELL'] : [];
  return ['BUY'];
}

function rewardBandDepthUsd(book: Orderbook, market: Market, sides: OrderSide[], ownOpenOrders: OpenOrder[] = []): number {
  const ownBySidePrice = ownRewardDepthBySidePrice(market, ownOpenOrders);
  let total = 0;
  if (sides.includes('BUY')) {
    total += book.bids
      .filter((level) => isWithinRewardBand('BUY', level.price, book, market.rewards?.maxSpreadCents))
      .reduce((sum, level) => sum + level.price * Math.max(0, level.size - (ownBySidePrice.get(`BUY:${priceKey(level.price)}`) ?? 0)), 0);
  }
  if (sides.includes('SELL')) {
    total += book.asks
      .filter((level) => isWithinRewardBand('SELL', level.price, book, market.rewards?.maxSpreadCents))
      .reduce((sum, level) => sum + level.price * Math.max(0, level.size - (ownBySidePrice.get(`SELL:${priceKey(level.price)}`) ?? 0)), 0);
  }
  return Number(total.toFixed(4));
}

function ownRewardDepthBySidePrice(market: Market, openOrders: OpenOrder[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const order of openOrders) {
    if (order.tokenId !== market.tokenId) continue;
    if (!['OPEN', 'PENDING_OPEN', 'PLANNED', 'UNKNOWN'].includes(order.status)) continue;
    const key = `${order.side}:${priceKey(order.price)}`;
    result.set(key, (result.get(key) ?? 0) + Math.max(0, order.size));
  }
  return result;
}

function priceKey(price: number): string {
  return Number(price).toFixed(8);
}

function topDepthUsd(book: Orderbook, sides: OrderSide[]): number {
  let total = 0;
  if (sides.includes('BUY')) total += book.bids.slice(0, 3).reduce((sum, level) => sum + level.price * level.size, 0);
  if (sides.includes('SELL')) total += book.asks.slice(0, 3).reduce((sum, level) => sum + level.price * level.size, 0);
  return Number(total.toFixed(4));
}

function competitionMetrics(input: {
  ppPerHour: number;
  rewardBandDepthUsd: number;
  targetOrderUsd: number;
}): Pick<MarketRouteMetrics, 'expectedPpPerHour' | 'ppPerThousandUsd' | 'targetSharePct' | 'competitionBand'> {
  if (input.rewardBandDepthUsd < 0 || input.targetOrderUsd <= 0) {
    return { competitionBand: 'unknown' };
  }
  const denominator = input.rewardBandDepthUsd + input.targetOrderUsd;
  const targetSharePct = Number(((input.targetOrderUsd / denominator) * 100).toFixed(4));
  const expectedPpPerHour = Number((input.ppPerHour * input.targetOrderUsd / denominator).toFixed(4));
  const ppPerThousandUsd = Number(((expectedPpPerHour / input.targetOrderUsd) * 1000).toFixed(4));
  const competitionBand = input.rewardBandDepthUsd < input.targetOrderUsd * 3
    ? 'thin'
    : input.rewardBandDepthUsd > input.targetOrderUsd * 250
      ? 'crowded'
      : 'balanced';
  return { expectedPpPerHour, ppPerThousandUsd, targetSharePct, competitionBand };
}

function compareRouteCandidates(a: MarketRouteCandidate, b: MarketRouteCandidate): number {
  return Number(b.tradable) - Number(a.tradable)
    || cashEfficiencyPpPerThousand(b) - cashEfficiencyPpPerThousand(a)
    || routeExpectedPp(b) - routeExpectedPp(a)
    || b.score - a.score
    || b.metrics.ppPerHour - a.metrics.ppPerHour
    || b.metrics.topDepthUsd - a.metrics.topDepthUsd
    || a.market.tokenId.localeCompare(b.market.tokenId);
}

function cashEfficiencyPpPerThousand(candidate: MarketRouteCandidate): number {
  if (candidate.metrics.targetOrderSource !== 'reward-minimum-plus-one') return 0;
  return candidate.metrics.ppPerThousandUsd ?? 0;
}

function routeExpectedPp(candidate: MarketRouteCandidate): number {
  return candidate.metrics.expectedPpPerHour ?? expectedPpFromMetrics(candidate.metrics);
}

function competitionScoreFromMetrics(metrics: MarketRouteMetrics): number {
  if (metrics.ppPerThousandUsd === undefined || metrics.targetSharePct === undefined || metrics.expectedPpPerHour === undefined) return 0;
  const densityScore = Math.min(85, Math.log10(metrics.ppPerThousandUsd + 1) * 44);
  const expectedScore = Math.min(90, Math.log10(metrics.expectedPpPerHour + 1) * 60);
  const targetShare = metrics.targetSharePct;
  const shareScore = targetShare < 0.03
    ? -25
    : targetShare <= 3
      ? 24
      : targetShare <= 12
        ? 8
        : -30;
  const bandAdjustment = metrics.competitionBand === 'balanced'
    ? 15
    : metrics.competitionBand === 'crowded'
      ? -18
      : metrics.competitionBand === 'thin'
        ? -35
        : 0;
  return densityScore + expectedScore + shareScore + bandAdjustment;
}

function expectedPpFromMetrics(metrics: MarketRouteMetrics): number {
  if (metrics.rewardBandDepthUsd <= 0 || metrics.targetOrderUsd <= 0) return 0;
  return metrics.ppPerHour * metrics.targetOrderUsd / (metrics.rewardBandDepthUsd + metrics.targetOrderUsd);
}

function competitionBandLabel(value: MarketRouteMetrics['competitionBand']): string {
  if (value === 'balanced') return '适中';
  if (value === 'crowded') return '拥挤';
  if (value === 'thin') return '偏薄';
  return '未知';
}

function estimatedPpPerHour(market: Market): number {
  if (market.rewards?.ppPerHour) return market.rewards.ppPerHour;
  const level = rewardLevel(market);
  if (market.venue === 'predict') return level * 600 + (market.boosted ? 600 : 0);
  return market.rewards?.dailyRate ?? 0;
}

function remainingSafeHours(config: AppConfig, market: Market): number | undefined {
  const candidates = [market.startTime, market.endTime]
    .map((value) => value ? Date.parse(value) : Number.NaN)
    .filter((value) => Number.isFinite(value) && value > Date.now());
  if (candidates.length === 0) return undefined;
  const deadline = Math.min(...candidates);
  const guardMs = Math.max(config.risk.eventStartNoNewOrdersMs ?? 0, config.risk.settlementNoNewOrdersMs ?? 0);
  return Number(Math.max(0, (deadline - Date.now() - guardMs) / 3600000).toFixed(4));
}

function formatNumber(value: number): string {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return '0';
  const abs = Math.abs(number);
  const maximumFractionDigits = abs > 0 && abs < 0.01
    ? 4
    : abs < 1
      ? 3
      : 2;
  return number.toLocaleString('en-US', { maximumFractionDigits });
}
