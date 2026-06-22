import { describe, expect, it } from 'vitest';
import { appConfigSchema } from '../src/config/schema.js';
import type { Market, OrderIntent, OrderResult, Orderbook, VenueName } from '../src/domain/types.js';
import { auditRouteOpportunities, auditRouteOpportunitiesBatch, mergeRouteAuditCheckpoint, routeAuditBasketForExecution } from '../src/execution/route-audit.js';
import type { VenueAdapter } from '../src/venues/types.js';

const baseMarket: Market = {
  venue: 'predict',
  tokenId: 'base-token',
  question: 'Base market?',
  volume24hUsd: 0,
  liquidityUsd: 0,
  acceptingOrders: true,
  endTime: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  endTimeSource: 'market-end',
  negRisk: false,
  feeRateBps: 0,
  tickSize: 0.01,
  rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 20 }
};

const baseBook: Orderbook = {
  venue: 'predict',
  tokenId: 'base-token',
  receivedAt: Date.now(),
  bids: [{ price: 0.5, size: 1000 }],
  asks: [{ price: 0.51, size: 1000 }]
};

function cashProbeBook(tokenId: string, topPrice = 0.5, topSize = 220): Orderbook {
  const supportPrice = Number((topPrice - 0.01).toFixed(3));
  const lowerPrice = Number((supportPrice - 0.01).toFixed(3));
  return {
    ...baseBook,
    tokenId,
    bids: [
      { price: topPrice, size: topSize },
      { price: supportPrice, size: 60 },
      { price: lowerPrice, size: 60 },
      { price: Number((lowerPrice - 0.01).toFixed(3)), size: 60 }
    ],
    asks: [{ price: Number((topPrice + 0.01).toFixed(3)), size: 1000 }]
  };
}

class AuditVenue implements VenueAdapter {
  readonly name: VenueName = 'predict';
  createOrderCalls = 0;
  getMarketsCalls = 0;
  maxConcurrentOrderbooks = 0;
  private currentOrderbooks = 0;

  constructor(
    readonly markets: Market[],
    readonly books: Map<string, Orderbook>,
    readonly options: { orderbookDelayMs?: number } = {}
  ) {}

  async testConnection(): Promise<boolean> { return true; }
  async getMarkets(): Promise<Market[]> {
    this.getMarketsCalls += 1;
    return this.markets;
  }
  hydrateFromMarkets(): void { return undefined; }
  async getOrderbook(tokenId: string): Promise<Orderbook> {
    this.currentOrderbooks += 1;
    this.maxConcurrentOrderbooks = Math.max(this.maxConcurrentOrderbooks, this.currentOrderbooks);
    try {
      if (this.options.orderbookDelayMs) await new Promise((resolve) => setTimeout(resolve, this.options.orderbookDelayMs));
      const book = this.books.get(tokenId);
      if (!book) throw new Error(`missing book ${tokenId}`);
      return book;
    } finally {
      this.currentOrderbooks -= 1;
    }
  }
  async getBalances() { return []; }
  async getPositions() { return []; }
  async getOpenOrders() { return []; }
  async createOrder(_intent: OrderIntent): Promise<OrderResult> {
    this.createOrderCalls += 1;
    throw new Error('route audit must not submit orders');
  }
  async cancelOrders(): Promise<void> { throw new Error('route audit must not cancel orders'); }
}

describe('route audit', () => {
  it('ranks low-competition reward markets across the full official reward universe without placing orders', async () => {
    const config = appConfigSchema.parse({
      risk: { orderSizeUsd: 60, minDepthUsdPerSide: 0, maxSingleOrderUsd: 100, maxPositionUsd: 500 },
      strategy: {
        entryMode: 'cash',
        quoteSide: 'buy',
        pointsOnly: true,
        minMarketLiquidityUsd: 10000,
        minRewardLevel: 0,
        conservativeDepthLevel: 1,
        retreatTicks: 0
      }
    });
    const crowded: Market = {
      ...baseMarket,
      tokenId: 'headline-crowded',
      marketId: 'headline-crowded',
      question: 'High PP but crowded?',
      liquidityUsd: 500000,
      rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 240 }
    };
    const fdvYes: Market = {
      ...baseMarket,
      tokenId: 'fdv-yes',
      marketId: 'fdv-market',
      conditionId: 'fdv-condition',
      outcome: 'Yes',
      outcomeCount: 2,
      question: 'Project FDV above $200M one day after launch?'
    };
    const fdvNo: Market = {
      ...baseMarket,
      tokenId: 'fdv-no',
      marketId: 'fdv-market',
      conditionId: 'fdv-condition',
      outcome: 'No',
      outcomeCount: 2,
      question: 'Project FDV above $200M one day after launch?'
    };
    const venue = new AuditVenue([crowded, fdvYes, fdvNo], new Map([
      [crowded.tokenId, cashProbeBook(crowded.tokenId, 0.5, 1_000_000)],
      [fdvYes.tokenId, cashProbeBook(fdvYes.tokenId, 0.5, 220)],
      [fdvNo.tokenId, cashProbeBook(fdvNo.tokenId, 0.5, 220)]
    ]));

    const audit = await auditRouteOpportunities(config, 'predict', venue, { top: 3, delayMs: 0 });

    expect(audit.totals).toMatchObject({ metadata: 3, eligible: 3, safe: 3, scanned: 3, failed: 0 });
    expect(['fdv-yes', 'fdv-no']).toContain(audit.topByExpected[0]?.tokenId);
    expect(audit.topByExpected[0]?.metrics.rewardBandDepthUsd).toBeGreaterThan(100);
    expect(venue.createOrderCalls).toBe(0);
  });

  it('builds the strict cash execution basket from PP/hr/kUSD efficiency at the configured real order amount', async () => {
    const config = appConfigSchema.parse({
      risk: { orderSizeUsd: 60, minDepthUsdPerSide: 0, maxSingleOrderUsd: 100, maxPositionUsd: 500, maxMarkets: 2 },
      strategy: {
        entryMode: 'cash',
        quoteSide: 'buy',
        enforceRewardMinimum: true,
        pointsOnly: true,
        minMarketLiquidityUsd: 0,
        minRewardLevel: 0,
        conservativeDepthLevel: 1,
        retreatTicks: 0
      }
    });
    const highExpectedCrowded: Market = {
      ...baseMarket,
      tokenId: 'audit-high-expected-crowded',
      marketId: 'audit-high-expected-crowded',
      rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 8000 }
    };
    const efficientLowCompetition: Market = {
      ...baseMarket,
      tokenId: 'audit-efficient-low-competition',
      marketId: 'audit-efficient-low-competition',
      rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 40 }
    };
    const venue = new AuditVenue([highExpectedCrowded, efficientLowCompetition], new Map([
      [highExpectedCrowded.tokenId, cashProbeBook(highExpectedCrowded.tokenId, 0.9, 75_000)],
      [efficientLowCompetition.tokenId, cashProbeBook(efficientLowCompetition.tokenId, 0.5, 220)]
    ]));

    const audit = await auditRouteOpportunities(config, 'predict', venue, { top: 2, delayMs: 0 });
    const basket = routeAuditBasketForExecution(config, audit);

    expect(audit.topByExpected[0]?.tokenId).toBe(efficientLowCompetition.tokenId);
    expect(audit.topByEfficiency[0]?.tokenId).toBe(efficientLowCompetition.tokenId);
    expect(basket.map((candidate) => candidate.tokenId)).toEqual([
      efficientLowCompetition.tokenId
    ]);
    expect(audit.rejectedTop.find((candidate) => candidate.tokenId === highExpectedCrowded.tokenId)?.riskFlags.join(' ')).toContain('不足官方最低奖励份额');
  });

  it('excludes strict cash routes whose configured amount cannot buy the official minimum plus one share', async () => {
    const config = appConfigSchema.parse({
      risk: { orderSizeUsd: 50, minDepthUsdPerSide: 0, maxSingleOrderUsd: 100, maxPositionUsd: 500, maxMarkets: 2 },
      strategy: {
        entryMode: 'cash',
        quoteSide: 'buy',
        enforceRewardMinimum: true,
        pointsOnly: true,
        minMarketLiquidityUsd: 0,
        minRewardLevel: 0,
        conservativeDepthLevel: 1,
        retreatTicks: 0
      }
    });
    const tooExpensive: Market = {
      ...baseMarket,
      tokenId: 'audit-strict-too-expensive',
      marketId: 'audit-strict-too-expensive',
      rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 8000 }
    };
    const affordable: Market = {
      ...baseMarket,
      tokenId: 'audit-strict-affordable',
      marketId: 'audit-strict-affordable',
      rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 40 }
    };
    const venue = new AuditVenue([tooExpensive, affordable], new Map([
      [tooExpensive.tokenId, cashProbeBook(tooExpensive.tokenId, 0.9, 220)],
      [affordable.tokenId, cashProbeBook(affordable.tokenId, 0.4, 220)]
    ]));

    const audit = await auditRouteOpportunities(config, 'predict', venue, { top: 5, delayMs: 0 });
    const basket = routeAuditBasketForExecution(config, audit);

    expect(audit.topByEfficiency.map((candidate) => candidate.tokenId)).toEqual([affordable.tokenId]);
    expect(basket.map((candidate) => candidate.tokenId)).toEqual([affordable.tokenId]);
    expect(audit.rejectedTop.find((candidate) => candidate.tokenId === tooExpensive.tokenId)?.riskFlags.join(' ')).toContain('不足官方最低奖励份额');
    expect(audit.rejectedTop.find((candidate) => candidate.tokenId === tooExpensive.tokenId)?.metrics.minRewardNotionalUsd).toBe(87.87);
    expect(audit.topByEfficiency[0]?.metrics.targetOrderUsd).toBe(50);
  });

  it('excludes recently filled cash markets from audit rankings and execution basket', async () => {
    const config = appConfigSchema.parse({
      risk: { orderSizeUsd: 50, minDepthUsdPerSide: 0, maxSingleOrderUsd: 100, maxPositionUsd: 500, maxMarkets: 2 },
      strategy: {
        entryMode: 'cash',
        quoteSide: 'buy',
        enforceRewardMinimum: true,
        pointsOnly: true,
        minMarketLiquidityUsd: 0,
        minRewardLevel: 0,
        conservativeDepthLevel: 1,
        retreatTicks: 0
      }
    });
    const historicalFill: Market = {
      ...baseMarket,
      tokenId: 'audit-historical-fill-yes',
      marketId: 'audit-historical-fill-market',
      outcome: 'Yes',
      rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 8000 }
    };
    const sameMarketOtherOutcome: Market = {
      ...baseMarket,
      tokenId: 'audit-historical-fill-no',
      marketId: historicalFill.marketId,
      outcome: 'No',
      rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 6000 }
    };
    const backup: Market = {
      ...baseMarket,
      tokenId: 'audit-historical-fill-backup',
      marketId: 'audit-historical-fill-backup',
      rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 80 }
    };
    const venue = new AuditVenue([historicalFill, sameMarketOtherOutcome, backup], new Map([
      [historicalFill.tokenId, cashProbeBook(historicalFill.tokenId, 0.4, 220)],
      [sameMarketOtherOutcome.tokenId, cashProbeBook(sameMarketOtherOutcome.tokenId, 0.4, 220)],
      [backup.tokenId, cashProbeBook(backup.tokenId, 0.4, 220)]
    ]));

    const audit = await auditRouteOpportunities(config, 'predict', venue, {
      top: 5,
      delayMs: 0,
      cashFillCooldown: {
        session: new Set(),
        history: new Set([`market:${historicalFill.marketId}`])
      }
    });
    const basket = routeAuditBasketForExecution(config, audit);

    expect(audit.topByEfficiency.map((candidate) => candidate.tokenId)).toEqual([backup.tokenId]);
    expect(audit.selected.map((candidate) => candidate.tokenId)).toEqual([backup.tokenId]);
    expect(basket.map((candidate) => candidate.tokenId)).toEqual([backup.tokenId]);
    expect(audit.rejectedTop.find((candidate) => candidate.tokenId === historicalFill.tokenId)?.riskFlags.join(' ')).toContain('近 24 小时已在该 市场 被吃单');
    expect(audit.rejectedTop.find((candidate) => candidate.tokenId === sameMarketOtherOutcome.tokenId)?.riskFlags.join(' ')).toContain('近 24 小时已在该 市场 被吃单');
  });

  it('keeps a fresh full-site audit execution basket while rolling cache coverage is partial', () => {
    const config = appConfigSchema.parse({
      risk: { orderSizeUsd: 50, minDepthUsdPerSide: 0, maxSingleOrderUsd: 100, maxPositionUsd: 500, maxMarkets: 2 },
      strategy: { entryMode: 'cash', quoteSide: 'buy', marketRefreshMs: 60000 }
    });
    const fullBest = {
      tokenId: 'full-best',
      side: 'BUY' as const,
      marketId: 'full-best',
      question: 'Full best?',
      tradable: true,
      score: 1,
      riskFlags: [],
      reasons: [],
      metrics: { ppPerHour: 60, targetOrderUsd: 50, rewardBandDepthUsd: 10 }
    };
    const rolling: ReturnType<typeof mergeRouteAuditCheckpoint> = {
      venue: 'predict',
      capturedAt: new Date().toISOString(),
      totals: { metadata: 10, eligible: 10, safe: 10, scanned: 3, failed: 7, tradable: 1 },
      selected: [],
      topByExpected: [],
      topByEfficiency: [],
      rejectedTop: [],
      failures: [],
      executionBasket: [],
      coveragePct: 30,
      complete: false,
      source: 'rolling-cache'
    };

    const merged = mergeRouteAuditCheckpoint(config, rolling, {
      ...rolling,
      capturedAt: new Date().toISOString(),
      complete: true,
      source: 'manual-full-audit',
      executionBasketCapturedAt: new Date().toISOString(),
      executionBasket: [fullBest]
    });

    expect(merged.source).toBe('rolling-cache+manual-full-audit-basket');
    expect(merged.executionBasketCapturedAt).toBeTruthy();
    expect(merged.executionBasket.map((candidate) => candidate.tokenId)).toEqual(['full-best']);
    expect(merged.latestFullAudit?.executionBasket.map((candidate) => candidate.tokenId)).toEqual(['full-best']);
    expect(merged.latestFullAudit?.coveragePct).toBe(30);
    expect(merged.coveragePct).toBe(30);
  });

  it('filters recently filled markets out of preserved route audit checkpoints', () => {
    const config = appConfigSchema.parse({
      risk: { orderSizeUsd: 50, minDepthUsdPerSide: 0, maxSingleOrderUsd: 100, maxPositionUsd: 500, maxMarkets: 2 },
      strategy: { entryMode: 'cash', quoteSide: 'buy', marketRefreshMs: 60000 }
    });
    const unsafe = {
      tokenId: 'preserved-unsafe-token',
      side: 'BUY' as const,
      marketId: 'preserved-unsafe-market',
      question: 'Preserved unsafe?',
      tradable: true,
      score: 100,
      riskFlags: [],
      reasons: [],
      metrics: { ppPerHour: 6000, targetOrderUsd: 50, rewardBandDepthUsd: 10 }
    };
    const safe = {
      tokenId: 'preserved-safe-token',
      side: 'BUY' as const,
      marketId: 'preserved-safe-market',
      question: 'Preserved safe?',
      tradable: true,
      score: 10,
      riskFlags: [],
      reasons: [],
      metrics: { ppPerHour: 60, targetOrderUsd: 50, rewardBandDepthUsd: 10 }
    };
    const rolling: ReturnType<typeof mergeRouteAuditCheckpoint> = {
      venue: 'predict',
      capturedAt: new Date().toISOString(),
      totals: { metadata: 10, eligible: 10, safe: 10, scanned: 3, failed: 7, tradable: 1 },
      selected: [],
      topByExpected: [],
      topByEfficiency: [],
      rejectedTop: [],
      failures: [],
      executionBasket: [],
      coveragePct: 30,
      complete: false,
      source: 'rolling-cache'
    };

    const merged = mergeRouteAuditCheckpoint(config, rolling, {
      ...rolling,
      capturedAt: new Date().toISOString(),
      complete: true,
      source: 'manual-full-audit',
      executionBasketCapturedAt: new Date().toISOString(),
      executionBasket: [unsafe, safe],
      latestFullAudit: {
        capturedAt: new Date().toISOString(),
        source: 'manual-full-audit',
        coveragePct: 100,
        totals: { metadata: 10, eligible: 10, safe: 10, scanned: 10, failed: 0, tradable: 2 },
        executionBasket: [unsafe, safe],
        topByExpected: [unsafe, safe],
        topByEfficiency: [unsafe, safe],
        selected: [unsafe, safe]
      }
    }, {
      cashFillCooldown: {
        session: new Set(),
        history: new Set([`market:${unsafe.marketId}`])
      }
    });

    expect(merged.executionBasket.map((candidate) => candidate.tokenId)).toEqual([safe.tokenId]);
    expect(merged.latestFullAudit?.executionBasket.map((candidate) => candidate.tokenId)).toEqual([safe.tokenId]);
    expect(merged.latestFullAudit?.topByEfficiency.map((candidate) => candidate.tokenId)).toEqual([safe.tokenId]);
  });

  it('keeps a recent full-site proof for the UI after the execution basket TTL expires', () => {
    const config = appConfigSchema.parse({
      risk: { minDepthUsdPerSide: 0, maxSingleOrderUsd: 100, maxPositionUsd: 500, maxMarkets: 2 },
      strategy: { entryMode: 'cash', quoteSide: 'buy', marketRefreshMs: 60000 }
    });
    const fullBest = {
      tokenId: 'recent-full-proof',
      side: 'BUY' as const,
      marketId: 'recent-full-proof',
      question: 'Recent full proof?',
      tradable: true,
      score: 1,
      riskFlags: [],
      reasons: [],
      metrics: { ppPerHour: 60, targetOrderUsd: 50, rewardBandDepthUsd: 10 }
    };
    const rolling: ReturnType<typeof mergeRouteAuditCheckpoint> = {
      venue: 'predict',
      capturedAt: new Date().toISOString(),
      totals: { metadata: 10, eligible: 10, safe: 10, scanned: 3, failed: 7, tradable: 1 },
      selected: [],
      topByExpected: [],
      topByEfficiency: [],
      rejectedTop: [],
      failures: [],
      executionBasket: [],
      coveragePct: 30,
      complete: false,
      source: 'rolling-cache'
    };

    const merged = mergeRouteAuditCheckpoint(config, rolling, {
      ...rolling,
      capturedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      complete: true,
      source: 'manual-full-audit',
      coveragePct: 100,
      executionBasketCapturedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      executionBasket: [fullBest],
      latestFullAudit: {
        capturedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
        source: 'manual-full-audit',
        coveragePct: 100,
        totals: { metadata: 10, eligible: 10, safe: 10, scanned: 10, failed: 0, tradable: 1 },
        executionBasket: [fullBest],
        topByExpected: [fullBest],
        topByEfficiency: [fullBest],
        selected: [fullBest]
      }
    });

    expect(merged.source).toBe('rolling-cache');
    expect(merged.executionBasket).toHaveLength(0);
    expect(merged.latestFullAudit?.coveragePct).toBe(100);
    expect(merged.latestFullAudit?.executionBasket.map((candidate) => candidate.tokenId)).toEqual(['recent-full-proof']);
  });

  it('preserves a fresh high-coverage rolling audit basket while a restarted cache is still warming up', () => {
    const config = appConfigSchema.parse({
      risk: { minDepthUsdPerSide: 0, maxSingleOrderUsd: 100, maxPositionUsd: 500, maxMarkets: 2 },
      strategy: { entryMode: 'cash', quoteSide: 'buy', marketRefreshMs: 60000 }
    });
    const rollingBest = {
      tokenId: 'high-coverage-rolling-best',
      side: 'BUY' as const,
      marketId: 'high-coverage-rolling-best',
      question: 'High coverage rolling best?',
      tradable: true,
      score: 1,
      riskFlags: [],
      reasons: [],
      metrics: { ppPerHour: 60, targetOrderUsd: 50, rewardBandDepthUsd: 10 }
    };
    const lowCoverageRolling: ReturnType<typeof mergeRouteAuditCheckpoint> = {
      venue: 'predict',
      capturedAt: new Date().toISOString(),
      totals: { metadata: 200, eligible: 160, safe: 140, scanned: 20, failed: 120, tradable: 1 },
      selected: [],
      topByExpected: [],
      topByEfficiency: [],
      rejectedTop: [],
      failures: [],
      executionBasket: [],
      coveragePct: 14.29,
      complete: false,
      source: 'rolling-cache'
    };

    const merged = mergeRouteAuditCheckpoint(config, lowCoverageRolling, {
      ...lowCoverageRolling,
      capturedAt: new Date().toISOString(),
      executionBasketCapturedAt: new Date().toISOString(),
      totals: { metadata: 200, eligible: 160, safe: 140, scanned: 115, failed: 25, tradable: 10 },
      coveragePct: 62.14,
      source: 'rolling-cache',
      executionBasket: [rollingBest]
    });

    expect(merged.source).toBe('rolling-cache-high-coverage+rolling-cache-preserved');
    expect(merged.coveragePct).toBe(62.14);
    expect(merged.executionBasket.map((candidate) => candidate.tokenId)).toEqual(['high-coverage-rolling-best']);
  });

  it('preserves an in-progress manual full-site audit when rolling route cache updates', () => {
    const config = appConfigSchema.parse({
      risk: { minDepthUsdPerSide: 0, maxSingleOrderUsd: 100, maxPositionUsd: 500, maxMarkets: 2 },
      strategy: { entryMode: 'cash', quoteSide: 'buy', marketRefreshMs: 60000 }
    });
    const partialBest = {
      tokenId: 'manual-partial-best',
      side: 'BUY' as const,
      marketId: 'manual-partial-best',
      question: 'Manual partial best?',
      tradable: true,
      score: 1,
      riskFlags: [],
      reasons: [],
      metrics: { ppPerHour: 60, targetOrderUsd: 50, rewardBandDepthUsd: 10 }
    };
    const rolling: ReturnType<typeof mergeRouteAuditCheckpoint> = {
      venue: 'predict',
      capturedAt: new Date().toISOString(),
      totals: { metadata: 10, eligible: 10, safe: 10, scanned: 3, failed: 7, tradable: 1 },
      selected: [],
      topByExpected: [],
      topByEfficiency: [],
      rejectedTop: [],
      failures: [],
      executionBasket: [],
      coveragePct: 30,
      complete: false,
      source: 'rolling-cache'
    };

    const merged = mergeRouteAuditCheckpoint(config, rolling, {
      ...rolling,
      capturedAt: new Date().toISOString(),
      complete: false,
      source: 'manual-full-audit-partial',
      coveragePct: 12,
      progress: { cursor: 12, total: 100, scanned: 12, remaining: 88 },
      executionBasket: [partialBest]
    });

    expect(merged.source).toBe('manual-full-audit-partial+rolling-cache-preserved');
    expect(merged.executionBasket.map((candidate) => candidate.tokenId)).toEqual(['manual-partial-best']);
    expect(merged.coveragePct).toBe(12);
  });

  it('advances full-site route audit in small read-only batches', async () => {
    const config = appConfigSchema.parse({
      risk: { orderSizeUsd: 60, minDepthUsdPerSide: 0, maxSingleOrderUsd: 100, maxPositionUsd: 500, maxMarkets: 2 },
      strategy: {
        entryMode: 'cash',
        quoteSide: 'buy',
        pointsOnly: true,
        minMarketLiquidityUsd: 0,
        minRewardLevel: 0,
        conservativeDepthLevel: 1,
        retreatTicks: 0
      }
    });
    const markets = Array.from({ length: 5 }, (_, index): Market => ({
      ...baseMarket,
      tokenId: `batch-${index}`,
      marketId: `batch-${index}`,
      rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 100 - index }
    }));
    const books = new Map(markets.map((market, index) => [
      market.tokenId,
      cashProbeBook(market.tokenId, 0.5, 220 + index * 10)
    ]));
    const venue = new AuditVenue(markets, books);

    const first = await auditRouteOpportunitiesBatch(config, 'predict', venue, {
      top: 5,
      batchSize: 2,
      delayMs: 0,
      reset: true
    });
    const second = await auditRouteOpportunitiesBatch(config, 'predict', venue, {
      top: 5,
      batchSize: 2,
      delayMs: 0,
      previousValue: first
    });
    const third = await auditRouteOpportunitiesBatch(config, 'predict', venue, {
      top: 5,
      batchSize: 2,
      delayMs: 0,
      previousValue: second
    });

    expect(first.complete).toBe(false);
    expect(first.source).toBe('manual-full-audit-partial');
    expect(first.progress).toMatchObject({ cursor: 2, total: 5, scanned: 2, remaining: 3 });
    expect(second.progress).toMatchObject({ cursor: 4, total: 5, scanned: 4, remaining: 1 });
    expect(third.complete).toBe(true);
    expect(third.source).toBe('manual-full-audit');
    expect(third.progress).toMatchObject({ cursor: 5, total: 5, scanned: 5, remaining: 0 });
    expect(third.executionBasket.length).toBe(2);
    expect(third.latestFullAudit?.coveragePct).toBe(100);
    expect(third.latestFullAudit?.executionBasket.length).toBe(2);
    expect(venue.createOrderCalls).toBe(0);
  });

  it('can use preloaded metadata and bounded concurrent orderbook reads for batched audits', async () => {
    const config = appConfigSchema.parse({
      risk: { minDepthUsdPerSide: 0, maxSingleOrderUsd: 100, maxPositionUsd: 500, maxMarkets: 2 },
      strategy: {
        entryMode: 'cash',
        quoteSide: 'buy',
        pointsOnly: true,
        minMarketLiquidityUsd: 0,
        minRewardLevel: 0,
        conservativeDepthLevel: 1,
        retreatTicks: 0
      }
    });
    const markets = Array.from({ length: 6 }, (_, index): Market => ({
      ...baseMarket,
      tokenId: `parallel-${index}`,
      marketId: `parallel-${index}`,
      rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 100 - index }
    }));
    const books = new Map(markets.map((market, index) => [
      market.tokenId,
      cashProbeBook(market.tokenId, 0.5, 220 + index * 10)
    ]));
    const venue = new AuditVenue(markets, books, { orderbookDelayMs: 10 });

    const audit = await auditRouteOpportunitiesBatch(config, 'predict', venue, {
      top: 6,
      batchSize: 6,
      delayMs: 0,
      orderbookConcurrency: 3,
      markets,
      reset: true
    });

    expect(venue.getMarketsCalls).toBe(0);
    expect(venue.maxConcurrentOrderbooks).toBeLessThanOrEqual(3);
    expect(venue.maxConcurrentOrderbooks).toBeGreaterThan(1);
    expect(audit.progress).toMatchObject({
      cursor: 6,
      total: 6,
      scanned: 6,
      remaining: 0,
      orderbookConcurrency: 3
    });
  });

  it('records timed-out orderbooks as batch failures without blocking the whole audit', async () => {
    const config = appConfigSchema.parse({
      risk: { minDepthUsdPerSide: 0, maxSingleOrderUsd: 100, maxPositionUsd: 500, maxMarkets: 2 },
      strategy: {
        entryMode: 'cash',
        quoteSide: 'buy',
        pointsOnly: true,
        minMarketLiquidityUsd: 0,
        minRewardLevel: 0,
        conservativeDepthLevel: 1,
        retreatTicks: 0
      }
    });
    const markets = Array.from({ length: 2 }, (_, index): Market => ({
      ...baseMarket,
      tokenId: `timeout-${index}`,
      marketId: `timeout-${index}`
    }));
    const books = new Map(markets.map((market) => [market.tokenId, cashProbeBook(market.tokenId)]));
    const venue = new AuditVenue(markets, books, { orderbookDelayMs: 650 });

    const audit = await auditRouteOpportunitiesBatch(config, 'predict', venue, {
      top: 2,
      batchSize: 2,
      delayMs: 0,
      orderbookConcurrency: 2,
      orderbookTimeoutMs: 500,
      markets,
      reset: true
    });

    expect(audit.complete).toBe(true);
    expect(audit.progress).toMatchObject({ scanned: 0, failed: 2, orderbookTimeoutMs: 500 });
    expect(audit.failures).toHaveLength(2);
    expect(audit.failures[0]?.error).toContain('timed out');
  });
});
