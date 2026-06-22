import type { AppConfig } from '../config/schema.js';
import type { Market, VenueName } from '../domain/types.js';
import { marketTimeDecision } from '../risk/market-guard.js';
import { marketGroupKey } from './paired-inventory.js';
import { rewardLevel } from './rewards/common.js';
import { StrategyEngine } from './strategy-engine.js';

export interface MarketOrderbookScanPlan {
  markets: Market[];
  active: Market[];
  hot: Market[];
  explore: Market[];
  fullScan: boolean;
  totalMetadata: number;
  eligibleMetadata: number;
  eligibleGroups: number;
  safeMetadata: number;
  safeGroups: number;
  skippedUnsafeTime: number;
  skippedUnavailableCooldown: number;
  hotBudget: number;
  exploreBudget: number;
  rateBudget: number;
  scannedGroups: number;
  activeGroups: number;
  hotGroups: number;
  exploreGroups: number;
  coveragePct: number;
}

export interface MarketOrderbookScanPlanOptions {
  activeTokenIds?: Iterable<string>;
  forceFullScan?: boolean;
  suppressedTokenIds?: Iterable<string>;
}

const exploreCursors = new Map<string, number>();
const constrainedSlotCursors = new Map<string, number>();
const PREDICT_DEFAULT_API_RATE_LIMIT_PER_MINUTE = 240;
const ORDERBOOK_SCAN_RATE_BUDGET_RATIO = 0.5;
// Periodic full route scan (forceFullScan, every FULL_ROUTE_ORDERBOOK_SCAN_INTERVAL_MS) fetches a broad slice so the
// rolling route-audit can climb toward the cash execution gate's coverage. This is the TOTAL orderbook cap for that
// cycle (active management + scan): a 100+ book burst (15 active + 100 scan) once made the cycle exceed the loop's
// 45s slow-cycle guard (→ pause + shed markets). The cap is active-aware (FULL_ROUTE_SCAN_MAX_ORDERBOOKS - active),
// so with cash maxMarkets now small (≤~5 active, not 15) we have headroom to scan more PER CYCLE — ~70 books is still
// comfortably under the 45s guard yet covers the ~250-market universe in far fewer 5-min passes, so the bot reaches
// the 60% gate and picks from a much larger candidate pool sooner (was the "only 2 tradable" warm-up complaint).
const FULL_ROUTE_SCAN_MAX_ORDERBOOKS = 70;

export function discoverRoutableMarkets(config: AppConfig, venue: VenueName, markets: Market[]): Market[] {
  const sameVenue = markets.filter((market) => market.venue === venue);
  if (sameVenue.length === 0) return [];
  return new StrategyEngine(config)
    .recommend(sameVenue, Math.max(1, sameVenue.length))
    .map((entry) => entry.market);
}

export function planMarketOrderbookScan(
  config: AppConfig,
  venue: VenueName,
  markets: Market[],
  options: MarketOrderbookScanPlanOptions = {}
): MarketOrderbookScanPlan {
  const sameVenue = markets.filter((market) => market.venue === venue);
  const activeTokenIds = new Set([...options.activeTokenIds ?? []].filter(Boolean));
  const suppressedTokenIds = new Set([...options.suppressedTokenIds ?? []].filter(Boolean));
  const active = uniqueMarkets(sameVenue.filter((market) => activeTokenIds.has(market.tokenId) && marketTimeDecision(config, market).ok));
  const activeTokens = new Set(active.map((market) => market.tokenId));
  const eligible = discoverRoutableMarkets(config, venue, markets);
  const safe = eligible.filter((market) => marketTimeDecision(config, market).ok);
  const candidateSafe = safe.filter((market) => activeTokens.has(market.tokenId) || !suppressedTokenIds.has(market.tokenId));
  const skippedUnavailableCooldown = safe.length - candidateSafe.length;
  if (options.forceFullScan) {
    const nonActiveSafe = candidateSafe.filter((market) => !activeTokens.has(market.tokenId));
    const normalRateBudget = orderbookScanRateBudget(config, active.length);
    const baseNonActiveBudget = Math.max(0, normalRateBudget - active.length);
    // Cash single-sided gates placement on a rolling route-audit reaching ≥60% universe coverage. The tiny per-cycle
    // budget can never get there, so the periodic full scan fetches a large bounded slice in one pass (still well under
    // the per-minute rate limit) to let the loop self-start placing without a manual audit. Other modes (split/paired
    // two-sided LP) don't use the coverage gate, so they keep the normal rotating budget.
    // Leave room for the active orders so active + scan stays ~FULL_ROUTE_SCAN_MAX_ORDERBOOKS total — at high
    // maxMarkets the active set already eats the budget, so the extra scan shrinks rather than blowing the cycle.
    const fullScanBudget = config.strategy.entryMode === 'cash'
      ? Math.min(nonActiveSafe.length, Math.max(baseNonActiveBudget, FULL_ROUTE_SCAN_MAX_ORDERBOOKS - active.length))
      : baseNonActiveBudget;
    const selectedNonActive = rotatingExploreMarkets(config, venue, prioritizedMarkets(config, nonActiveSafe), fullScanBudget, 'full');
    const selected = uniqueMarkets([...active, ...selectedNonActive]);
    return {
      markets: selected,
      active,
      hot: selectedNonActive,
      explore: [],
      fullScan: true,
      totalMetadata: markets.filter((market) => market.venue === venue).length,
      eligibleMetadata: eligible.length,
      eligibleGroups: groupedMarkets(config, eligible).size,
      safeMetadata: safe.length,
      safeGroups: groupedMarkets(config, safe).size,
      skippedUnsafeTime: eligible.length - safe.length,
      skippedUnavailableCooldown,
      hotBudget: selectedNonActive.length,
      exploreBudget: 0,
      rateBudget: normalRateBudget,
      scannedGroups: groupedMarkets(config, selected).size,
      activeGroups: groupedMarkets(config, active).size,
      hotGroups: groupedMarkets(config, selectedNonActive).size,
      exploreGroups: 0,
      coveragePct: safe.length > 0 ? Number((selected.length / safe.length * 100).toFixed(2)) : 0
    };
  }
  const maxTokensPerMarket = Math.max(1, config.strategy.maxTokensPerMarket ?? 2);
  const requestedHotBudget = Math.max(
    config.strategy.candidateLimit ?? 12,
    config.risk.maxMarkets * maxTokensPerMarket,
    config.risk.maxMarkets
  );
  const requestedExploreBudget = Math.max(
    maxTokensPerMarket,
    config.strategy.entryMode === 'cash'
      ? config.risk.maxMarkets
      : Math.min(Math.ceil(requestedHotBudget / 3), Math.max(maxTokensPerMarket, config.risk.maxMarkets * maxTokensPerMarket))
  );
  const rateBudget = orderbookScanRateBudget(config, active.length);
  const nonActiveBudget = Math.max(0, rateBudget - active.length);
  const constrainedSlot = constrainedNonActiveSlot(config, venue, nonActiveBudget, maxTokensPerMarket);
  const exploreBudget = constrainedSlot === 'explore'
    ? nonActiveBudget
    : constrainedSlot === 'hot'
      ? 0
      : effectiveExploreBudget(nonActiveBudget, requestedExploreBudget, maxTokensPerMarket);
  const hotBudget = constrainedSlot === 'hot'
    ? Math.min(requestedHotBudget, nonActiveBudget)
    : constrainedSlot === 'explore'
      ? 0
      : Math.max(0, Math.min(requestedHotBudget, nonActiveBudget - exploreBudget));

  const sortedSafe = prioritizedMarkets(config, safe
    .filter((market) => !activeTokens.has(market.tokenId) && !suppressedTokenIds.has(market.tokenId))
  );
  const hot = selectGroupedMarkets(config, sortedSafe, hotBudget);
  const hotTokens = new Set(hot.map((market) => market.tokenId));
  const remaining = sortedSafe.filter((market) => !hotTokens.has(market.tokenId));
  const explore = rotatingExploreMarkets(config, venue, remaining, exploreBudget, 'explore');
  const selected = uniqueMarkets([...active, ...hot, ...explore]);

  return {
    markets: selected,
    active,
    hot,
    explore,
    fullScan: false,
    totalMetadata: markets.filter((market) => market.venue === venue).length,
    eligibleMetadata: eligible.length,
    eligibleGroups: groupedMarkets(config, eligible).size,
    safeMetadata: safe.length,
    safeGroups: groupedMarkets(config, safe).size,
    skippedUnsafeTime: eligible.length - safe.length,
    skippedUnavailableCooldown,
    hotBudget,
    exploreBudget,
    rateBudget,
    scannedGroups: groupedMarkets(config, selected).size,
    activeGroups: groupedMarkets(config, active).size,
    hotGroups: groupedMarkets(config, hot).size,
    exploreGroups: groupedMarkets(config, explore).size,
    coveragePct: safe.length > 0 ? Number((selected.length / safe.length * 100).toFixed(2)) : 0
  };
}

export function publicMarketScanPlan(plan: MarketOrderbookScanPlan): Record<string, unknown> {
  return {
    fullScan: plan.fullScan,
    totalMetadata: plan.totalMetadata,
    eligibleMetadata: plan.eligibleMetadata,
    eligibleGroups: plan.eligibleGroups,
    safeMetadata: plan.safeMetadata,
    safeGroups: plan.safeGroups,
    skippedUnsafeTime: plan.skippedUnsafeTime,
    skippedUnavailableCooldown: plan.skippedUnavailableCooldown,
    scannedOrderbooks: plan.markets.length,
    scannedGroups: plan.scannedGroups,
    active: plan.active.length,
    hot: plan.hot.length,
    explore: plan.explore.length,
    activeGroups: plan.activeGroups,
    hotGroups: plan.hotGroups,
    exploreGroups: plan.exploreGroups,
    hotBudget: plan.hotBudget,
    exploreBudget: plan.exploreBudget,
    rateBudget: plan.rateBudget,
    coveragePct: plan.coveragePct,
    activeTokens: plan.active.slice(0, 8).map(publicMarketToken),
    hotTokens: plan.hot.slice(0, 8).map(publicMarketToken),
    exploreTokens: plan.explore.slice(0, 8).map(publicMarketToken)
  };
}

function rotatingExploreMarkets(config: AppConfig, venue: VenueName, markets: Market[], budget: number, scope = 'explore'): Market[] {
  if (markets.length === 0 || budget <= 0) return [];
  const groups = groupedMarkets(config, markets);
  const entries = [...groups.values()];
  if (entries.length === 0) return [];
  const cursorKey = `${scope}:${venue}:${config.strategy.minRewardLevel}:${config.strategy.pointsOnly}:${config.strategy.acceptingOnly}`;
  const cursor = exploreCursors.get(cursorKey) ?? 0;
  const rotated = entries.slice(cursor % entries.length).concat(entries.slice(0, cursor % entries.length));
  const selected = flattenGroups(rotated, budget);
  const consumedGroups = Math.max(1, selected.groupCount);
  exploreCursors.set(cursorKey, (cursor + consumedGroups) % entries.length);
  return selected.markets;
}

function selectGroupedMarkets(config: AppConfig, markets: Market[], budget: number): Market[] {
  if (markets.length === 0 || budget <= 0) return [];
  const groups = [...groupedMarkets(config, markets).values()]
    .sort((a, b) => groupScore(config, b) - groupScore(config, a));
  return flattenGroups(groups, budget).markets;
}

function orderbookScanRateBudget(config: AppConfig, activeCount: number): number {
  const refreshMs = Math.max(1000, config.strategy.quoteRefreshMs ?? 2000);
  const requestsPerCycle = Math.max(1, Math.floor((PREDICT_DEFAULT_API_RATE_LIMIT_PER_MINUTE * refreshMs) / 60000));
  const plannedOrderbookBudget = Math.max(1, Math.floor(requestsPerCycle * ORDERBOOK_SCAN_RATE_BUDGET_RATIO));
  if (config.strategy.entryMode === 'cash') {
    return Math.max(plannedOrderbookBudget, activeCount + cashExploreSlots(config));
  }
  return Math.max(activeCount, plannedOrderbookBudget);
}

function cashExploreSlots(config: AppConfig): number {
  return Math.max(1, Math.min(20, Math.max(4, Math.ceil(Math.max(1, config.risk.maxMarkets) / 2))));
}

function constrainedNonActiveSlot(
  config: AppConfig,
  venue: VenueName,
  nonActiveBudget: number,
  maxTokensPerMarket: number
): 'hot' | 'explore' | undefined {
  if (config.strategy.entryMode === 'cash' && nonActiveBudget > 0) return 'explore';
  if (nonActiveBudget < maxTokensPerMarket) return undefined;
  if (nonActiveBudget >= maxTokensPerMarket * 2) return undefined;
  const cursorKey = [
    venue,
    config.strategy.quoteRefreshMs,
    config.strategy.candidateLimit,
    config.strategy.minRewardLevel,
    config.strategy.pointsOnly,
    config.strategy.acceptingOnly,
    config.risk.maxMarkets,
    maxTokensPerMarket
  ].join(':');
  const cursor = constrainedSlotCursors.get(cursorKey) ?? 0;
  constrainedSlotCursors.set(cursorKey, cursor + 1);
  return cursor % 2 === 0 ? 'hot' : 'explore';
}

function effectiveExploreBudget(nonActiveBudget: number, requestedExploreBudget: number, maxTokensPerMarket: number): number {
  if (nonActiveBudget <= maxTokensPerMarket) return 0;
  const hotShare = Math.max(1, Math.floor(nonActiveBudget * 2 / 3));
  return Math.min(requestedExploreBudget, Math.max(maxTokensPerMarket, nonActiveBudget - hotShare));
}

function flattenGroups(groups: Market[][], budget: number): { markets: Market[]; groupCount: number } {
  const selected: Market[] = [];
  let groupCount = 0;
  for (const group of groups) {
    if (group.length === 0) continue;
    const remaining = budget - selected.length;
    if (remaining <= 0) break;
    const toAdd = group.length > remaining ? group.slice(0, remaining) : group;
    selected.push(...toAdd);
    if (toAdd.length > 0) groupCount += 1;
    if (selected.length >= budget) break;
  }
  return { markets: uniqueMarkets(selected), groupCount };
}

function groupedMarkets(config: AppConfig, markets: Market[]): Map<string, Market[]> {
  const groups = new Map<string, Market[]>();
  for (const market of markets) {
    const key = marketGroupKey(config, market);
    const list = groups.get(key) ?? [];
    list.push(market);
    groups.set(key, list);
  }
  return groups;
}

function uniqueMarkets(markets: Market[]): Market[] {
  return [...new Map(markets.map((market) => [market.tokenId, market] as const)).values()];
}

function groupScore(config: AppConfig, markets: Market[]): number {
  if (markets.length === 0) return 0;
  const pp = Math.max(...markets.map((market) => market.rewards?.ppPerHour ?? 0));
  return markets.reduce((sum, market) => sum + metadataPotentialScore(config, market), 0) / markets.length + pp * 0.05;
}

function prioritizedMarkets(config: AppConfig, markets: Market[]): Market[] {
  return [...markets].sort((a, b) => metadataPotentialScore(config, b) - metadataPotentialScore(config, a));
}

function metadataPotentialScore(config: AppConfig, market: Market): number {
  const ppPerHour = market.rewards?.ppPerHour ?? rewardLevel(market) * 600;
  const ppScore = ppPerHour > 0 ? Math.log10(ppPerHour + 1) * 90 : 0;
  // Polymarket exposes its reward pool as a daily USDC rate (not PP/hr); rank by it heavily
  // so the scan visits the highest official-reward markets first. The previous weight (40) let
  // wide-spread/high-level low-reward markets (Trump-Ahmed level=5 $100) outrank the actual top
  // reward pools (Starmer/Hormuz/Fed/World Cup level=3 $1000-$3571) because levelScore (level*55)
  // and the level*600 ppPerHour fallback gave level=5 a ~150 score advantage that drowned out a
  // 10x reward difference at the old weight. Boost so daily rate dominates the metadata stage
  // (live competition is then evaluated at the orderbook/route stage as before).
  const dailyRateScore = market.rewards?.dailyRate ? Math.log10(market.rewards.dailyRate + 1) * 180 : 0;
  const levelScore = rewardLevel(market) * 55;
  const liquidityScore = config.strategy.entryMode === 'cash'
    ? Math.min(12, Math.log10(market.liquidityUsd + 1) * 3)
    : Math.log10(market.liquidityUsd + 1) * 18;
  const volumeScore = Math.log10(market.volume24hUsd + 1) * 10;
  const boostScore = market.boosted ? 80 : 0;
  const spreadScore = market.rewards?.maxSpreadCents
    ? Math.max(0, 60 - Math.abs((market.rewards.maxSpreadCents ?? 0) - 6) * 4)
    : config.strategy.pointsOnly ? -120 : 0;
  // Polymarket affordability: a market only pays if your single order can meet its reward min-size (soft rule) AT THIS
  // TOKEN'S PRICE. Estimate with the gamma metadata price for this outcome (clamped to the 0.10 earn floor; floor-only
  // when the metadata price is unknown) so the bounded scan visits markets the order can actually earn in — consistent
  // with the route-stage minRewardNotionalUsd check. Predict is unaffected (penalty stays 0).
  let affordabilityPenalty = 0;
  if (market.venue === 'polymarket' && (market.rewards?.minShares ?? 0) > 0) {
    const orderUsd = Math.max(0, config.risk.orderSizeUsd);
    const multiplier = Math.max(1, config.strategy.minRewardSizeMultiplier ?? 1);
    const estimatedLegPrice = Math.max(0.10, market.metadataPriceUsd ?? 0.10);
    const minSizeUsd = ((market.rewards!.minShares as number) * multiplier + 1) * estimatedLegPrice;
    if (orderUsd > 0 && minSizeUsd > orderUsd + 1e-9) affordabilityPenalty = -100000;
  }
  // Polymarket: sink tokens whose metadata price is already outside the safe band (the live guard would block on mid),
  // so the bounded scan doesn't spend slots on them. Low-competition selection is handled at the route stage by the
  // book-based competition model + the $1/day threshold, not by a metadata density heuristic (which over-ranked thin,
  // unquotable markets above quotable liquid ones). Predict scoring unchanged (penalty stays 0).
  if (market.venue === 'polymarket' && market.metadataPriceUsd !== undefined
    && (market.metadataPriceUsd <= config.risk.minPrice || market.metadataPriceUsd >= config.risk.maxPrice)) {
    affordabilityPenalty -= 100000;
  }
  return ppScore + dailyRateScore + levelScore + liquidityScore + volumeScore + boostScore + spreadScore + affordabilityPenalty;
}

function publicMarketToken(market: Market): Record<string, unknown> {
  return {
    tokenId: market.tokenId,
    marketId: market.marketId,
    question: market.question,
    outcome: market.outcome,
    ppPerHour: market.rewards?.ppPerHour,
    rewardLevel: rewardLevel(market)
  };
}
