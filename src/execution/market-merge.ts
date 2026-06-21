/**
 * Shared market-metadata merge helpers.
 *
 * Both `ExecutionEngine` (active-market merge) and `MarketDataSyncService`
 * (market-list cache merge) must agree on which copy of a token's metadata
 * "wins" when the same tokenId appears in multiple sources. Keeping a single
 * `marketMetadataCompleteness` scorer here prevents the two merge paths from
 * silently diverging.
 */

export function marketMetadataCompleteness(value: Record<string, unknown>): number {
  const liquidity = typeof value.liquidityUsd === 'number' ? value.liquidityUsd : 0;
  const volume = typeof value.volume24hUsd === 'number' ? value.volume24hUsd : 0;
  const rewards = value.rewards && typeof value.rewards === 'object' ? value.rewards as Record<string, unknown> : undefined;
  const rewardScore = rewards?.enabled === true ? 1000 : 0;
  const timeScore = typeof value.endTime === 'string' ? 80 : 0;
  const groupScore = typeof value.marketId === 'string' || typeof value.conditionId === 'string' ? 40 : 0;
  const marketTextScore = typeof value.question === 'string' && !value.question.startsWith('Position ') ? 20 : 0;
  return rewardScore + timeScore + groupScore + marketTextScore + Math.log10(Math.max(0, liquidity) + 1) * 8 + Math.log10(Math.max(0, volume) + 1) * 4;
}

export function betterMarketMetadata<T extends { tokenId: string }>(a: T, b: T): T {
  return marketMetadataCompleteness(b) > marketMetadataCompleteness(a) ? b : a;
}

export function uniqueMarkets<T extends { tokenId: string }>(markets: T[]): T[] {
  const byToken = new Map<string, T>();
  for (const market of markets) {
    const current = byToken.get(market.tokenId);
    byToken.set(market.tokenId, current ? betterMarketMetadata(current, market) : market);
  }
  return [...byToken.values()];
}

export function mergeMarkets<T extends { tokenId: string }>(...groups: T[][]): T[] {
  return uniqueMarkets(groups.flat());
}
