import type { AppConfig } from '../config/schema.js';
import type { Market, OrderIntent, Position } from '../domain/types.js';
import { createRewardOptimizer } from './rewards/factory.js';

const EPSILON = 1e-9;

export function isPairedEntryMode(config: AppConfig): boolean {
  return config.strategy.entryMode === 'split';
}

export function isCashMultiMarketEntry(config: AppConfig): boolean {
  return !isPairedEntryMode(config) && config.strategy.entryMode === 'cash' && Math.max(1, config.risk.maxMarkets) > 1;
}

export function configuredPairedStrategy(config: AppConfig): AppConfig {
  if (!isPairedEntryMode(config)) return config;
  return {
    ...config,
    strategy: {
      ...config.strategy,
      quoteSide: 'both',
      dualSide: true,
      onFillAction: 'hold'
    }
  };
}

export function pairedPositionGroups(config: AppConfig, markets: Market[], positions: Position[]): Set<string> {
  const marketsByToken = new Map(markets.map((market) => [market.tokenId, market] as const));
  const expectedCountsByPositionKey = expectedOutcomeCountsByPositionKey(positions);
  const groups = new Map<string, { heldTokenIds: Set<string>; markets: Market[] }>();
  for (const position of positions) {
    if (position.size <= EPSILON && Math.abs(position.notionalUsd) <= 0.01) continue;
    const market = marketsByToken.get(position.tokenId) ?? positionMarket(position, expectedCountsByPositionKey);
    if (!market) continue;
    const key = marketGroupKey(config, market);
    const group = groups.get(key) ?? { heldTokenIds: new Set<string>(), markets: markets.filter((candidate) => marketGroupKey(config, candidate) === key) };
    group.markets = mergeGroupMarkets(group.markets, markets.filter((candidate) => marketGroupKey(config, candidate) === key), [market]);
    group.heldTokenIds.add(market.tokenId);
    groups.set(key, group);
  }
  return new Set([...groups.entries()]
    .filter(([, group]) => hasCompleteOutcomeSet(group.markets, group.heldTokenIds))
    .map(([key]) => key));
}

export function filterMarketsForPairedInventory(config: AppConfig, markets: Market[], positions: Position[]): Market[] {
  if (!isPairedEntryMode(config)) return markets;
  const pairedGroups = pairedPositionGroups(config, markets, positions);
  return markets.filter((market) => pairedGroups.has(marketGroupKey(config, market)));
}

export function filterSplitIntentsToCompletePairs(config: AppConfig, intents: OrderIntent[]): OrderIntent[] {
  if (!isPairedEntryMode(config)) return intents;
  const grouped = new Map<string, OrderIntent[]>();
  for (const intent of intents.filter((item) => item.side === 'SELL')) {
    const key = marketGroupKey(config, intent.market);
    const list = grouped.get(key) ?? [];
    list.push(intent);
    grouped.set(key, list);
  }
  const filtered: OrderIntent[] = [];
  for (const list of grouped.values()) {
    if (!hasCompleteOutcomeSet(list.map((intent) => intent.market), new Set(list.map((intent) => intent.tokenId)))) continue;
    filtered.push(...list);
  }
  return filtered;
}

export function equalizeSplitSellGroupShares(config: AppConfig, intents: OrderIntent[], positions: Position[] = []): OrderIntent[] {
  if (!isPairedEntryMode(config)) return intents;
  const heldByToken = new Map<string, number>();
  for (const position of positions) {
    heldByToken.set(position.tokenId, (heldByToken.get(position.tokenId) ?? 0) + Math.max(0, position.size));
  }
  const grouped = new Map<string, OrderIntent[]>();
  for (const intent of filterSplitIntentsToCompletePairs(config, intents)) {
    const key = marketGroupKey(config, intent.market);
    const list = grouped.get(key) ?? [];
    list.push(intent);
    grouped.set(key, list);
  }

  const result: OrderIntent[] = [];
  for (const group of grouped.values()) {
    const targetShares = splitGroupTargetShares(config, group, heldByToken);
    if (targetShares === undefined) continue;
    result.push(...group.map((intent) => {
      const notionalUsd = Number((intent.price * targetShares).toFixed(4));
      const equalized = Math.abs(intent.size - targetShares) > EPSILON;
      return {
        ...intent,
        size: targetShares,
        notionalUsd,
        reason: equalized ? `${intent.reason}|paired-equal-shares` : intent.reason
      };
    }));
  }
  return filterSplitIntentsToCompletePairs(config, result);
}

export interface CompleteSetInventoryGroup {
  key: string;
  markets: Market[];
  positions: Position[];
  mergeableShares: number;
}

export function completeSetInventoryGroups(config: AppConfig, markets: Market[], positions: Position[]): CompleteSetInventoryGroup[] {
  const marketsByToken = new Map(markets.map((market) => [market.tokenId, market] as const));
  const expectedCountsByPositionKey = expectedOutcomeCountsByPositionKey(positions);
  const grouped = new Map<string, { markets: Map<string, Market>; positions: Position[]; sharesByToken: Map<string, number> }>();
  for (const position of positions) {
    if (position.size <= EPSILON && Math.abs(position.notionalUsd) <= 0.01) continue;
    const market = marketsByToken.get(position.tokenId) ?? positionMarket(position, expectedCountsByPositionKey);
    if (!market) continue;
    const key = marketGroupKey(config, market);
    const group = grouped.get(key) ?? { markets: new Map<string, Market>(), positions: [], sharesByToken: new Map<string, number>() };
    for (const candidate of markets.filter((item) => marketGroupKey(config, item) === key)) {
      group.markets.set(candidate.tokenId, candidate);
    }
    group.markets.set(market.tokenId, market);
    group.positions.push(position);
    group.sharesByToken.set(position.tokenId, (group.sharesByToken.get(position.tokenId) ?? 0) + Math.max(0, position.size));
    grouped.set(key, group);
  }

  const result: CompleteSetInventoryGroup[] = [];
  for (const [key, group] of grouped) {
    const markets = [...group.markets.values()];
    if (!hasCompleteOutcomeSet(markets, new Set(group.sharesByToken.keys()))) continue;
    const mergeableShares = roundShares(Math.min(...markets.map((market) => group.sharesByToken.get(market.tokenId) ?? 0)));
    if (!Number.isFinite(mergeableShares) || mergeableShares <= EPSILON) continue;
    result.push({ key, markets, positions: group.positions, mergeableShares });
  }
  return result;
}

export function splitOrderGroupKey(config: AppConfig, intent: OrderIntent): string {
  return marketGroupKey(config, intent.market);
}

export function marketGroupKey(config: AppConfig, market: Market): string {
  return createRewardOptimizer(market.venue, config).marketKey(market);
}

export function hasCompleteOutcomeSet(markets: Market[], tokenIds = new Set(markets.map((market) => market.tokenId))): boolean {
  const uniqueMarkets = [...new Map(markets.map((market) => [market.tokenId, market] as const)).values()];
  const expected = expectedOutcomeCount(uniqueMarkets);
  return expected !== undefined && tokenIds.size === expected && uniqueMarkets.length === expected;
}

export function expectedOutcomeCount(markets: Market[]): number | undefined {
  const counts = markets
    .map((market) => market.outcomeCount)
    .filter((count): count is number => count !== undefined && Number.isInteger(count) && count >= 2);
  if (counts.length > 0) return Math.max(...counts);
  const tokenCount = new Set(markets.map((market) => market.tokenId).filter(Boolean)).size;
  return tokenCount === 2 ? 2 : undefined;
}

function splitGroupTargetShares(
  config: AppConfig,
  group: OrderIntent[],
  heldByToken: Map<string, number>
): number | undefined {
  if (group.length === 0) return undefined;
  const enforceRewardMinimum = config.strategy.enforceRewardMinimum ?? true;
  const budgetShares = Math.min(...group.map((intent) => intent.size));
  const minimumShares = enforceRewardMinimum
    ? Math.max(...group.map((intent) => intent.reward?.minShares ?? 0))
    : 0;
  const desiredShares = Math.max(budgetShares, minimumShares);
  const maxPrice = Math.max(...group.map((intent) => intent.price));
  const totalGroupPrice = group.reduce((sum, intent) => sum + Math.max(0, intent.price), 0);
  const totalBudgetCapShares = enforceRewardMinimum
    ? Number.POSITIVE_INFINITY
    : config.risk.orderSizeUsd / Math.max(totalGroupPrice, 0.0001);
  const singleOrderCapShares = Math.min(
    config.risk.maxSingleOrderUsd / Math.max(maxPrice, 0.0001),
    totalBudgetCapShares
  );
  const inventoryCapShares = heldByToken.size > 0
    ? Math.min(...group.map((intent) => heldByToken.get(intent.tokenId) ?? 0))
    : Number.POSITIVE_INFINITY;
  let targetShares = roundShares(Math.min(desiredShares, singleOrderCapShares, inventoryCapShares));
  if (isPairedEntryMode(config) && heldByToken.size > 0 && targetShares <= EPSILON) {
    targetShares = roundShares(Math.min(singleOrderCapShares, inventoryCapShares));
  }
  if (!Number.isFinite(targetShares) || targetShares <= EPSILON) return undefined;
  if (enforceRewardMinimum) {
    if (minimumShares > 0 && targetShares + EPSILON < minimumShares) return undefined;
  }
  return targetShares;
}

function roundShares(value: number): number {
  return Number((Number.isFinite(value) ? value : 0).toFixed(4));
}

function positionMarket(position: Position, expectedCountsByKey: Map<string, number>): Market | undefined {
  if (position.market) return position.market;
  const key = position.conditionId || position.marketId;
  if (!key) return undefined;
  const outcomeCount = position.outcomeCount ?? expectedCountsByKey.get(key);
  return {
    venue: position.venue,
    tokenId: position.tokenId,
    ...(position.marketId ? { marketId: position.marketId } : {}),
    ...(position.conditionId ? { conditionId: position.conditionId } : {}),
    question: position.marketId ? `Position market ${position.marketId}` : `Position group ${key}`,
    ...(position.outcome ? { outcome: position.outcome } : {}),
    ...(outcomeCount !== undefined ? { outcomeCount } : {}),
    volume24hUsd: 0,
    liquidityUsd: 0,
    acceptingOrders: true,
    negRisk: false,
    feeRateBps: 0,
    tickSize: 0.01,
    rewards: { enabled: false }
  };
}

function expectedOutcomeCountsByPositionKey(positions: Position[]): Map<string, number> {
  const counts = new Map<string, number>();
  const tokenIdsByKey = new Map<string, Set<string>>();
  for (const position of positions) {
    const key = position.conditionId || position.marketId;
    if (!key) continue;
    if (position.outcomeCount !== undefined) counts.set(key, Math.max(counts.get(key) ?? 0, position.outcomeCount));
    const tokenIds = tokenIdsByKey.get(key) ?? new Set<string>();
    tokenIds.add(position.tokenId);
    tokenIdsByKey.set(key, tokenIds);
  }
  for (const [key, tokenIds] of tokenIdsByKey) {
    if (!counts.has(key) && tokenIds.size === 2) counts.set(key, 2);
  }
  return counts;
}

function mergeGroupMarkets(...groups: Market[][]): Market[] {
  const byToken = new Map<string, Market>();
  for (const market of groups.flat()) byToken.set(market.tokenId, market);
  return [...byToken.values()];
}
