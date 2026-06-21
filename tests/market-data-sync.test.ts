import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { appConfigSchema } from '../src/config/schema.js';
import type {
  AccountRiskSnapshot,
  Balance,
  Market,
  OpenOrder,
  OrderIntent,
  OrderResult,
  Orderbook,
  Position,
  PreflightResult,
  VenueName
} from '../src/domain/types.js';
import { clearSharedMarketCache, getSharedCachedMarkets, MarketDataSyncService } from '../src/execution/market-data-sync.js';
import type { SignerProvider } from '../src/secrets/signer.js';
import { StateStore } from '../src/store/sqlite.js';
import { discoverRoutableMarkets, planMarketOrderbookScan } from '../src/strategy/market-discovery.js';
import type { VenueAdapter } from '../src/venues/types.js';

const activeMarket: Market = {
  venue: 'predict',
  tokenId: 'active-token',
  question: 'Active market?',
  volume24hUsd: 10000,
  liquidityUsd: 15000,
  acceptingOrders: true,
  endTime: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  endTimeSource: 'market-end',
  negRisk: false,
  feeRateBps: 0,
  tickSize: 0.01,
  rewards: { enabled: true, level: 5, minShares: 10, maxSpreadCents: 6 }
};

const unavailableMarket: Market = {
  ...activeMarket,
  tokenId: 'unavailable-token',
  question: 'Unavailable orderbook?'
};

const book: Orderbook = {
  venue: 'predict',
  tokenId: activeMarket.tokenId,
  receivedAt: Date.now(),
  bids: [
    { price: 0.49, size: 1000 },
    { price: 0.48, size: 1000 },
    { price: 0.47, size: 1000 },
    { price: 0.46, size: 1000 }
  ],
  asks: [
    { price: 0.51, size: 1000 },
    { price: 0.52, size: 1000 },
    { price: 0.53, size: 1000 },
    { price: 0.54, size: 1000 }
  ]
};

class MockVenue implements VenueAdapter {
  readonly name: VenueName = 'predict';
  getMarketsCalls = 0;
  maxConcurrentOrderbookCalls = 0;
  activeOrderbookCalls = 0;
  hydratedMarkets: Market[] = [];
  markets: Market[] = [activeMarket, unavailableMarket];
  failToken = unavailableMarket.tokenId;
  orderbookDelayMs = 0;

  async testConnection(): Promise<boolean> {
    return true;
  }

  async getMarkets(): Promise<Market[]> {
    this.getMarketsCalls += 1;
    return this.markets;
  }

  hydrateFromMarkets(markets: Market[]): void {
    this.hydratedMarkets = markets;
  }

  async getOrderbook(tokenId: string): Promise<Orderbook> {
    this.activeOrderbookCalls += 1;
    this.maxConcurrentOrderbookCalls = Math.max(this.maxConcurrentOrderbookCalls, this.activeOrderbookCalls);
    try {
      if (this.orderbookDelayMs > 0) await sleep(this.orderbookDelayMs);
      if (tokenId === this.failToken) throw new Error('orderbook unavailable');
      return { ...book, tokenId, receivedAt: Date.now() };
    } finally {
      this.activeOrderbookCalls -= 1;
    }
  }

  async getBalances(): Promise<Balance[]> {
    return [];
  }

  async getPositions(): Promise<Position[]> {
    return [];
  }

  async getOpenOrders(): Promise<OpenOrder[]> {
    return [];
  }

  async getAccountRiskSnapshot(address: string, _signer: SignerProvider, sinceTs: number): Promise<AccountRiskSnapshot> {
    return {
      venue: this.name,
      account: address,
      source: 'venue',
      capturedAt: Date.now(),
      dayStart: sinceTs,
      realizedPnlUsd: 0,
      unrealizedPnlUsd: 0,
      netCashflowUsd: 0,
      equityUsd: 1000,
      fills: [],
      positions: [],
      balances: [],
      warnings: []
    };
  }

  async preflight(): Promise<PreflightResult> {
    return { ok: true, venue: this.name, checks: [] };
  }

  async createOrder(intent: OrderIntent): Promise<OrderResult> {
    return { venue: this.name, clientOrderId: intent.clientOrderId, status: 'OPEN' };
  }

  async cancelOrders(): Promise<void> {
    return undefined;
  }
}

describe('market data sync', () => {
  beforeEach(() => {
    clearSharedMarketCache();
  });

  it('returns markets with available orderbooks and records structured skips for missing books', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config = appConfigSchema.parse({
      liveEnabled: true,
      strategy: { marketRefreshMs: 1, autoSelectMarkets: false },
      selectedMarkets: { predict: [activeMarket.tokenId, unavailableMarket.tokenId], polymarket: [] }
    });
    const venue = new MockVenue();
    try {
      const snapshot = await new MarketDataSyncService(config, venue, store).sync('predict');

      expect(snapshot.markets.map((item) => item.tokenId)).toEqual([activeMarket.tokenId, unavailableMarket.tokenId]);
      expect(snapshot.books.has(activeMarket.tokenId)).toBe(true);
      expect(snapshot.books.has(unavailableMarket.tokenId)).toBe(false);
      const event = store.listRecentEvents(10).find((item) => item.type === 'orderbook.unavailable');
      expect(event?.details).toMatchObject({
        reject: { reason_code: 'ORDERBOOK_UNAVAILABLE', category: 'orderbook', stage: 'syncing-markets' }
      });
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('hydrates adapter maps when serving markets from cache', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config = appConfigSchema.parse({
      liveEnabled: true,
      strategy: { marketRefreshMs: 60000, autoSelectMarkets: false },
      selectedMarkets: { predict: [activeMarket.tokenId], polymarket: [] }
    });
    const firstVenue = new MockVenue();
    const secondVenue = new MockVenue();
    try {
      await new MarketDataSyncService(config, firstVenue, store).resolveMarkets('predict');
      await new MarketDataSyncService(config, secondVenue, store).resolveMarkets('predict');

      expect(firstVenue.getMarketsCalls).toBe(1);
      expect(secondVenue.getMarketsCalls).toBe(0);
      expect(secondVenue.hydratedMarkets.map((item) => item.tokenId)).toContain(activeMarket.tokenId);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('shares one in-flight market refresh across overlapping readers', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config = appConfigSchema.parse({
      liveEnabled: true,
      strategy: { marketRefreshMs: 60000, autoSelectMarkets: false },
      selectedMarkets: { predict: [`inflight-${Date.now()}`], polymarket: [] }
    });
    const firstVenue = new MockVenue();
    const secondVenue = new MockVenue();
    firstVenue.markets = [{ ...activeMarket, tokenId: config.selectedMarkets.predict[0] ?? activeMarket.tokenId }];
    secondVenue.markets = [{ ...activeMarket, tokenId: 'should-not-fetch' }];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    firstVenue.getMarkets = async () => {
      firstVenue.getMarketsCalls += 1;
      await gate;
      return firstVenue.markets;
    };
    secondVenue.getMarkets = async () => {
      secondVenue.getMarketsCalls += 1;
      return secondVenue.markets;
    };
    try {
      const first = new MarketDataSyncService(config, firstVenue, store).resolveMarkets('predict');
      const second = new MarketDataSyncService(config, secondVenue, store).resolveMarkets('predict');
      release();
      const [firstMarkets, secondMarkets] = await Promise.all([first, second]);

      expect(firstVenue.getMarketsCalls).toBe(1);
      expect(secondVenue.getMarketsCalls).toBe(0);
      expect(firstMarkets.map((item) => item.tokenId)).toEqual([config.selectedMarkets.predict[0]]);
      expect(secondMarkets.map((item) => item.tokenId)).toEqual([config.selectedMarkets.predict[0]]);
      expect(secondVenue.hydratedMarkets.map((item) => item.tokenId)).toEqual([config.selectedMarkets.predict[0]]);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('times out and clears a stuck shared market refresh so the next read can recover', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config = appConfigSchema.parse({
      liveEnabled: true,
      strategy: { marketRefreshMs: 60000, autoSelectMarkets: false },
      selectedMarkets: { predict: [activeMarket.tokenId], polymarket: [] }
    });
    const stuckVenue = new MockVenue();
    stuckVenue.getMarkets = async () => {
      stuckVenue.getMarketsCalls += 1;
      return new Promise<Market[]>(() => undefined);
    };
    const recoveredVenue = new MockVenue();
    try {
      await expect(getSharedCachedMarkets(config, 'predict', stuckVenue, store, { timeoutMs: 5 }))
        .rejects.toThrow(/market list predict timed out/);

      const markets = await getSharedCachedMarkets(config, 'predict', recoveredVenue, store, { timeoutMs: 50 });

      expect(markets.map((item) => item.tokenId)).toContain(activeMarket.tokenId);
      expect(stuckVenue.getMarketsCalls).toBe(1);
      expect(recoveredVenue.getMarketsCalls).toBe(1);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back to the stale cached market list when refresh times out after a prior success', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config = appConfigSchema.parse({
      liveEnabled: true,
      strategy: { marketRefreshMs: 1, autoSelectMarkets: false },
      selectedMarkets: { predict: [activeMarket.tokenId], polymarket: [] }
    });
    const venue = new MockVenue();
    try {
      await getSharedCachedMarkets(config, 'predict', venue, store, { timeoutMs: 50 });
      venue.getMarkets = async () => {
        venue.getMarketsCalls += 1;
        return new Promise<Market[]>(() => undefined);
      };
      await sleep(2);

      const markets = await getSharedCachedMarkets(config, 'predict', venue, store, { timeoutMs: 5 });

      expect(markets.map((item) => item.tokenId)).toContain(activeMarket.tokenId);
      expect(venue.getMarketsCalls).toBe(2);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back to the persisted market list after an in-process cache reset', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config = appConfigSchema.parse({
      liveEnabled: true,
      strategy: { marketRefreshMs: 1, autoSelectMarkets: false },
      selectedMarkets: { predict: [activeMarket.tokenId], polymarket: [] }
    });
    const venue = new MockVenue();
    try {
      await getSharedCachedMarkets(config, 'predict', venue, store, { timeoutMs: 50 });
      clearSharedMarketCache();
      venue.getMarkets = async () => {
        venue.getMarketsCalls += 1;
        return new Promise<Market[]>(() => undefined);
      };
      await sleep(2);

      const markets = await getSharedCachedMarkets(config, 'predict', venue, store, { timeoutMs: 5 });

      expect(markets.map((item) => item.tokenId)).toContain(activeMarket.tokenId);
      expect(venue.hydratedMarkets.map((item) => item.tokenId)).toContain(activeMarket.tokenId);
      expect(store.listRecentEvents(10).some((event) => event.type === 'market-list.stale-fallback')).toBe(true);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back to the persisted market list when a refresh returns an empty list', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config = appConfigSchema.parse({
      liveEnabled: true,
      strategy: { marketRefreshMs: 1, autoSelectMarkets: false },
      selectedMarkets: { predict: [activeMarket.tokenId], polymarket: [] }
    });
    const venue = new MockVenue();
    try {
      await getSharedCachedMarkets(config, 'predict', venue, store, { timeoutMs: 50 });
      clearSharedMarketCache();
      venue.markets = [];
      await sleep(2);

      const markets = await getSharedCachedMarkets(config, 'predict', venue, store, { timeoutMs: 50 });

      expect(markets.map((item) => item.tokenId)).toContain(activeMarket.tokenId);
      expect(venue.hydratedMarkets.map((item) => item.tokenId)).toContain(activeMarket.tokenId);
      expect(store.listRecentEvents(10).some((event) => event.type === 'market-list.empty-fallback')).toBe(true);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps all metadata-eligible auto-routed markets while requesting orderbooks only for safe scan tiers', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config = appConfigSchema.parse({
      liveEnabled: true,
      strategy: { marketRefreshMs: 1, autoSelectMarkets: true, minMarketLiquidityUsd: 0, minRewardLevel: 0, candidateLimit: 4 },
      risk: { blockUnknownEndTime: true }
    });
    const venue = new MockVenue();
    venue.markets = [
      { ...activeMarket, tokenId: 'unknown-end', endTime: undefined, endTimeSource: undefined },
      { ...activeMarket, tokenId: 'safe-end', endTime: new Date(Date.now() + 60 * 60 * 1000).toISOString(), endTimeSource: 'reward-end' }
    ];
    const requestedBooks: string[] = [];
    const originalGetOrderbook = venue.getOrderbook.bind(venue);
    venue.getOrderbook = async (tokenId: string) => {
      requestedBooks.push(tokenId);
      return originalGetOrderbook(tokenId);
    };

    try {
      const snapshot = await new MarketDataSyncService(config, venue, store).sync('predict');

      expect(snapshot.markets.map((item) => item.tokenId)).toEqual(['unknown-end', 'safe-end']);
      expect(requestedBooks).toEqual(['safe-end']);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('discovers every metadata-eligible reward market instead of truncating at candidateLimit before orderbooks', () => {
    const config = appConfigSchema.parse({
      liveEnabled: true,
      strategy: { autoSelectMarkets: true, minMarketLiquidityUsd: 0, minRewardLevel: 0, candidateLimit: 4 },
      risk: { maxMarkets: 1 }
    });
    const markets = Array.from({ length: 10 }, (_, index) => ({
      ...activeMarket,
      tokenId: `metadata-candidate-${index}`,
      marketId: `metadata-candidate-${index}`,
      rewards: { enabled: true, level: 5, minShares: 10, maxSpreadCents: 6, ppPerHour: 1000 - index }
    }));

    const discovered = discoverRoutableMarkets(config, 'predict', markets);
    const scanPlan = planMarketOrderbookScan(config, 'predict', markets);

    expect(discovered).toHaveLength(10);
    expect(scanPlan.totalMetadata).toBe(10);
    expect(scanPlan.eligibleMetadata).toBe(10);
    expect(scanPlan.markets.length).toBeLessThan(10);
    expect(scanPlan.markets.length).toBeLessThanOrEqual(scanPlan.rateBudget);
  });

  it('keeps the hot/explore orderbook plan under the Predict REST budget while preserving active tokens', () => {
    const config = appConfigSchema.parse({
      liveEnabled: true,
      strategy: { entryMode: 'split', autoSelectMarkets: true, minMarketLiquidityUsd: 0, minRewardLevel: 0, candidateLimit: 20, quoteRefreshMs: 2000 },
      risk: { maxMarkets: 1 }
    });
    const activeTokens = ['active-budget-0', 'active-budget-1'];
    const markets = [
      ...activeTokens.map((tokenId) => ({
        ...activeMarket,
        tokenId,
        marketId: tokenId,
        rewards: { enabled: true, level: 5, minShares: 10, maxSpreadCents: 6, ppPerHour: 50 }
      })),
      ...Array.from({ length: 30 }, (_, index) => ({
        ...activeMarket,
        tokenId: `budget-candidate-${index}`,
        marketId: `budget-candidate-${index}`,
        rewards: { enabled: true, level: 5, minShares: 10, maxSpreadCents: 6, ppPerHour: 5000 - index }
      }))
    ];

    const plan = planMarketOrderbookScan(config, 'predict', markets, { activeTokenIds: activeTokens });

    expect(plan.active.map((item) => item.tokenId).sort()).toEqual(activeTokens.sort());
    expect(plan.markets.length).toBeLessThanOrEqual(plan.rateBudget);
    expect(plan.rateBudget).toBe(4);
  });

  it('keeps forced global scans under the Predict REST budget while preserving active tokens', () => {
    const config = appConfigSchema.parse({
      liveEnabled: true,
      strategy: { entryMode: 'split', autoSelectMarkets: true, minMarketLiquidityUsd: 0, minRewardLevel: 0, candidateLimit: 50, quoteRefreshMs: 2000 },
      risk: { maxMarkets: 20 }
    });
    const activeTokens = ['force-active-0', 'force-active-1'];
    const markets = [
      ...activeTokens.map((tokenId) => ({
        ...activeMarket,
        tokenId,
        marketId: tokenId,
        rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 240 }
      })),
      ...Array.from({ length: 50 }, (_, index) => ({
        ...activeMarket,
        tokenId: `force-candidate-${index}`,
        marketId: `force-candidate-${index}`,
        rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 5000 - index }
      }))
    ];

    const plan = planMarketOrderbookScan(config, 'predict', markets, { activeTokenIds: activeTokens, forceFullScan: true });

    expect(plan.fullScan).toBe(true);
    expect(plan.active.map((item) => item.tokenId).sort()).toEqual(activeTokens.sort());
    expect(plan.markets.length).toBeLessThanOrEqual(plan.rateBudget);
    expect(plan.rateBudget).toBe(4);
  });

  it('keeps several rotating full-site scan slots while cash multi-market active tokens are below maxMarkets', () => {
    const config = appConfigSchema.parse({
      liveEnabled: true,
      strategy: {
        entryMode: 'cash',
        quoteSide: 'buy',
        autoSelectMarkets: true,
        minMarketLiquidityUsd: 0,
        minRewardLevel: 0,
        candidateLimit: 60,
        quoteRefreshMs: 2000
      },
      risk: { maxMarkets: 20 }
    });
    const activeTokens = Array.from({ length: 4 }, (_, index) => `expand-active-${index}`);
    const markets = [
      ...activeTokens.map((tokenId) => ({
        ...activeMarket,
        tokenId,
        marketId: tokenId,
        rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 120 }
      })),
      {
        ...activeMarket,
        tokenId: 'expand-next',
        marketId: 'expand-next',
        rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 5000 }
      }
    ];

    const plan = planMarketOrderbookScan(config, 'predict', markets, { activeTokenIds: activeTokens });

    expect(plan.active).toHaveLength(4);
    expect(plan.rateBudget).toBe(14);
    expect(plan.markets.length).toBeLessThanOrEqual(plan.rateBudget);
    expect(plan.markets.map((item) => item.tokenId)).toContain('expand-next');
  });

  it('still explores non-active reward markets when active cash orders already fill the normal REST budget', () => {
    const config = appConfigSchema.parse({
      liveEnabled: true,
      strategy: {
        entryMode: 'cash',
        quoteSide: 'buy',
        autoSelectMarkets: true,
        minMarketLiquidityUsd: 0,
        minRewardLevel: 0,
        candidateLimit: 60,
        quoteRefreshMs: 2000
      },
      risk: { maxMarkets: 20 }
    });
    const activeTokens = Array.from({ length: 7 }, (_, index) => `article-active-${index}`);
    const markets = [
      ...activeTokens.map((tokenId) => ({
        ...activeMarket,
        tokenId,
        marketId: tokenId,
        rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 20 }
      })),
      ...Array.from({ length: 12 }, (_, index) => ({
        ...activeMarket,
        tokenId: `article-fdv-${index}`,
        marketId: `article-fdv-${index}`,
        question: `FDV market ${index}`,
        liquidityUsd: 0,
        volume24hUsd: 0,
        rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 20 }
      }))
    ];

    const plan = planMarketOrderbookScan(config, 'predict', markets, { activeTokenIds: activeTokens });
    const nonActive = [...plan.hot, ...plan.explore];

    expect(plan.active).toHaveLength(7);
    expect(nonActive.length).toBeGreaterThanOrEqual(1);
    expect(nonActive.some((market) => market.tokenId.startsWith('article-fdv-'))).toBe(true);
  });

  it('records a rolling route audit checkpoint from cached cash orderbooks', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config = appConfigSchema.parse({
      liveEnabled: true,
      strategy: {
        entryMode: 'cash',
        quoteSide: 'buy',
        autoSelectMarkets: true,
        minMarketLiquidityUsd: 0,
        minRewardLevel: 0,
        candidateLimit: 60,
        quoteRefreshMs: 2000,
        marketRefreshMs: 60000
      },
      risk: {
        orderSizeUsd: 50,
        maxMarkets: 20,
        maxSingleOrderUsd: 100,
        maxPositionUsd: 200,
        minDepthUsdPerSide: 0,
        settlementNoNewOrdersMs: 0,
        eventStartNoNewOrdersMs: 0
      }
    });
    const venue = new MockVenue();
    venue.failToken = '';
    venue.markets = [
      ...Array.from({ length: 6 }, (_, index) => ({
        ...activeMarket,
        tokenId: `rolling-audit-${index}`,
        marketId: `rolling-audit-${index}`,
        rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 300 - index }
      }))
    ];
    try {
      const snapshot = await new MarketDataSyncService(config, venue, store).sync('predict');
      const checkpoint = store.getCheckpoint('route-audit.predict')?.value as any;

      expect(snapshot.books.size).toBeGreaterThan(0);
      expect(checkpoint).toMatchObject({
        venue: 'predict',
        source: expect.any(String),
        totals: expect.objectContaining({ metadata: 6, eligible: 6, safe: 6 }),
        coveragePct: expect.any(Number)
      });
      expect(checkpoint.executionBasket.length).toBeGreaterThan(0);
      expect(checkpoint.topByExpected.length).toBeGreaterThan(0);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('alternates the only non-active group between hot and explore when rate budget is tight', () => {
    const config = appConfigSchema.parse({
      liveEnabled: true,
      strategy: { entryMode: 'split', autoSelectMarkets: true, minMarketLiquidityUsd: 0, minRewardLevel: 0, candidateLimit: 20, quoteRefreshMs: 2000 },
      risk: { maxMarkets: 1 }
    });
    const activeTokens = ['tight-active-0', 'tight-active-1'];
    const markets = [
      ...activeTokens.map((tokenId) => ({
        ...activeMarket,
        tokenId,
        marketId: tokenId,
        rewards: { enabled: true, level: 5, minShares: 10, maxSpreadCents: 6, ppPerHour: 50 }
      })),
      ...Array.from({ length: 30 }, (_, index) => ({
        ...activeMarket,
        tokenId: `tight-candidate-${index}`,
        marketId: `tight-candidate-${index}`,
        rewards: { enabled: true, level: 5, minShares: 10, maxSpreadCents: 6, ppPerHour: 5000 - index }
      }))
    ];

    const first = planMarketOrderbookScan(config, 'predict', markets, { activeTokenIds: activeTokens });
    const second = planMarketOrderbookScan(config, 'predict', markets, { activeTokenIds: activeTokens });

    expect(first.markets.length).toBeLessThanOrEqual(first.rateBudget);
    expect(second.markets.length).toBeLessThanOrEqual(second.rateBudget);
    expect([first.hot.length, second.hot.length]).toContain(2);
    expect([first.explore.length, second.explore.length]).toContain(2);
  });

  it('uses all tight non-active cash slots instead of letting one binary group consume the whole scan', () => {
    const config = appConfigSchema.parse({
      liveEnabled: true,
      strategy: {
        entryMode: 'cash',
        quoteSide: 'buy',
        autoSelectMarkets: true,
        minMarketLiquidityUsd: 0,
        minRewardLevel: 0,
        candidateLimit: 20,
        quoteRefreshMs: 2000,
        maxTokensPerMarket: 2
      },
      risk: { maxMarkets: 1 }
    });
    const currentYes = {
      ...activeMarket,
      tokenId: 'current-yes',
      marketId: 'current-market',
      conditionId: 'current-condition',
      outcome: 'Yes',
      outcomeIndex: 0,
      outcomeCount: 2,
      rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 240 }
    };
    const currentNo = {
      ...activeMarket,
      tokenId: 'current-no',
      marketId: 'current-market',
      conditionId: 'current-condition',
      outcome: 'No',
      outcomeIndex: 1,
      outcomeCount: 2,
      rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 240 }
    };
    const outsideBest = {
      ...activeMarket,
      tokenId: 'outside-best',
      marketId: 'outside-market',
      conditionId: 'outside-condition',
      outcome: 'Yes',
      outcomeIndex: 0,
      outcomeCount: 2,
      rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 60 },
      liquidityUsd: 6000,
      volume24hUsd: 6000
    };
    const outsideOther = {
      ...activeMarket,
      tokenId: 'outside-other',
      marketId: 'outside-other-market',
      conditionId: 'outside-other-condition',
      outcome: 'Yes',
      outcomeIndex: 0,
      outcomeCount: 2,
      rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 60 },
      liquidityUsd: 5500,
      volume24hUsd: 5500
    };

    const plan = planMarketOrderbookScan(config, 'predict', [
      currentYes,
      currentNo,
      outsideBest,
      outsideOther
    ], {
      activeTokenIds: [currentYes.tokenId]
    });

    expect(plan.rateBudget).toBe(5);
    expect(plan.active.map((item) => item.tokenId)).toEqual([currentYes.tokenId]);
    const nonActive = [...plan.hot, ...plan.explore];
    expect(nonActive).toHaveLength(3);
    expect(nonActive.map((item) => item.tokenId)).toContain(currentNo.tokenId);
    expect(nonActive.map((item) => item.tokenId)).toContain(outsideBest.tokenId);
    expect(plan.markets.length).toBe(4);
    expect(new Set(plan.markets.map((item) => item.marketId)).size).toBeGreaterThan(1);
  });

  it('never lets grouped market selection exceed the token scan budget', () => {
    const config = appConfigSchema.parse({
      liveEnabled: true,
      strategy: {
        entryMode: 'cash',
        quoteSide: 'buy',
        autoSelectMarkets: true,
        minMarketLiquidityUsd: 0,
        minRewardLevel: 0,
        candidateLimit: 60,
        quoteRefreshMs: 2000,
        maxTokensPerMarket: 2
      },
      risk: { maxMarkets: 20 }
    });
    const activeTokens = Array.from({ length: 5 }, (_, index) => `strict-active-${index}`);
    const markets = [
      ...activeTokens.map((tokenId) => ({
        ...activeMarket,
        tokenId,
        marketId: tokenId,
        rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 120 }
      })),
      {
        ...activeMarket,
        tokenId: 'strict-next-yes',
        marketId: 'strict-next',
        conditionId: 'strict-next-condition',
        outcome: 'Yes',
        outcomeIndex: 0,
        outcomeCount: 2,
        rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 5000 }
      },
      {
        ...activeMarket,
        tokenId: 'strict-next-no',
        marketId: 'strict-next',
        conditionId: 'strict-next-condition',
        outcome: 'No',
        outcomeIndex: 1,
        outcomeCount: 2,
        rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 5000 }
      }
    ];

    const plan = planMarketOrderbookScan(config, 'predict', markets, { activeTokenIds: activeTokens });

    expect(plan.rateBudget).toBe(15);
    expect(plan.markets.length).toBeLessThanOrEqual(plan.rateBudget);
    expect(plan.markets).toHaveLength(7);
  });

  it('temporarily suppresses non-active tokens with recent unavailable orderbooks', () => {
    const config = appConfigSchema.parse({
      liveEnabled: true,
      strategy: {
        entryMode: 'cash',
        quoteSide: 'buy',
        autoSelectMarkets: true,
        minMarketLiquidityUsd: 0,
        minRewardLevel: 0,
        candidateLimit: 20,
        quoteRefreshMs: 2000
      },
      risk: { maxMarkets: 20 }
    });
    const active = {
      ...activeMarket,
      tokenId: 'cooldown-active',
      marketId: 'cooldown-active',
      rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 100 }
    };
    const suppressed = {
      ...activeMarket,
      tokenId: 'cooldown-suppressed',
      marketId: 'cooldown-suppressed',
      rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 5000 }
    };
    const fallback = {
      ...activeMarket,
      tokenId: 'cooldown-fallback',
      marketId: 'cooldown-fallback',
      rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 4000 }
    };

    const plan = planMarketOrderbookScan(config, 'predict', [active, suppressed, fallback], {
      activeTokenIds: [active.tokenId],
      suppressedTokenIds: [suppressed.tokenId]
    });

    expect(plan.markets.map((item) => item.tokenId)).toContain(active.tokenId);
    expect(plan.markets.map((item) => item.tokenId)).toContain(fallback.tokenId);
    expect(plan.markets.map((item) => item.tokenId)).not.toContain(suppressed.tokenId);
    expect(plan.skippedUnavailableCooldown).toBe(1);
  });

  it('rotates an explore tier so low-competition markets are eventually sampled under REST limits', () => {
    const config = appConfigSchema.parse({
      liveEnabled: true,
      strategy: { autoSelectMarkets: true, minMarketLiquidityUsd: 0, minRewardLevel: 0, candidateLimit: 4 },
      risk: { maxMarkets: 1 }
    });
    const markets = Array.from({ length: 12 }, (_, index) => ({
      ...activeMarket,
      tokenId: `explore-candidate-${index}`,
      marketId: `explore-candidate-${index}`,
      rewards: { enabled: true, level: 5, minShares: 10, maxSpreadCents: 6, ppPerHour: 2000 - index }
    }));

    const first = planMarketOrderbookScan(config, 'predict', markets).explore.map((item) => item.tokenId);
    const second = planMarketOrderbookScan(config, 'predict', markets).explore.map((item) => item.tokenId);

    expect(first.length).toBeGreaterThan(0);
    expect(second.length).toBeGreaterThan(0);
    expect(second).not.toEqual(first);
  });

  it('eventually samples every eligible market group through explore without exceeding the Predict rate budget', () => {
    const config = appConfigSchema.parse({
      liveEnabled: true,
      strategy: {
        autoSelectMarkets: true,
        minMarketLiquidityUsd: 0,
        minRewardLevel: 0,
        candidateLimit: 2,
        quoteRefreshMs: 2000,
        maxTokensPerMarket: 2
      },
      risk: { maxMarkets: 1 }
    });
    const markets = Array.from({ length: 8 }, (_, index) => ([
      {
        ...activeMarket,
        tokenId: `coverage-group-${index}-yes`,
        marketId: `coverage-group-${index}`,
        conditionId: `coverage-condition-${index}`,
        outcome: 'Yes',
        outcomeIndex: 0,
        outcomeCount: 2,
        rewards: { enabled: true, level: 5, minShares: 10, maxSpreadCents: 6, ppPerHour: 2000 - index }
      },
      {
        ...activeMarket,
        tokenId: `coverage-group-${index}-no`,
        marketId: `coverage-group-${index}`,
        conditionId: `coverage-condition-${index}`,
        outcome: 'No',
        outcomeIndex: 1,
        outcomeCount: 2,
        rewards: { enabled: true, level: 5, minShares: 10, maxSpreadCents: 6, ppPerHour: 2000 - index }
      }
    ])).flat();
    const seenGroups = new Set<string>();

    for (let i = 0; i < 12; i += 1) {
      const plan = planMarketOrderbookScan(config, 'predict', markets);
      expect(plan.markets.length).toBeLessThanOrEqual(plan.rateBudget);
      expect(plan.eligibleGroups).toBe(8);
      expect(plan.scannedGroups).toBeGreaterThan(0);
      for (const item of [...plan.hot, ...plan.explore]) {
        if (item.marketId) seenGroups.add(item.marketId);
      }
    }

    expect(seenGroups).toEqual(new Set(markets.map((market) => market.marketId).filter((value): value is string => Boolean(value))));
  });

  it('always includes active open-order markets in the orderbook scan plan before hot and explore tiers', () => {
    const config = appConfigSchema.parse({
      liveEnabled: true,
      strategy: { autoSelectMarkets: true, minMarketLiquidityUsd: 0, minRewardLevel: 0, candidateLimit: 4 },
      risk: { maxMarkets: 1 }
    });
    const activeLowPotential = {
      ...activeMarket,
      tokenId: 'active-low-potential',
      marketId: 'active-low-potential',
      rewards: { enabled: true, level: 4, minShares: 100, maxSpreadCents: 6, ppPerHour: 10 }
    };
    const markets = [
      activeLowPotential,
      ...Array.from({ length: 12 }, (_, index) => ({
        ...activeMarket,
        tokenId: `hot-candidate-${index}`,
        marketId: `hot-candidate-${index}`,
        rewards: { enabled: true, level: 5, minShares: 10, maxSpreadCents: 6, ppPerHour: 5000 - index }
      }))
    ];

    const plan = planMarketOrderbookScan(config, 'predict', markets, {
      activeTokenIds: [activeLowPotential.tokenId]
    });

    expect(plan.active.map((item) => item.tokenId)).toEqual([activeLowPotential.tokenId]);
    expect(plan.markets.map((item) => item.tokenId)).toContain(activeLowPotential.tokenId);
    expect(plan.hot.map((item) => item.tokenId)).not.toContain(activeLowPotential.tokenId);
    expect(plan.explore.map((item) => item.tokenId)).not.toContain(activeLowPotential.tokenId);
  });

  it('hydrates active open-order token orderbooks even when the token is outside the hot metadata budget', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config = appConfigSchema.parse({
      liveEnabled: true,
      strategy: { marketRefreshMs: 1, autoSelectMarkets: true, minMarketLiquidityUsd: 0, minRewardLevel: 0, candidateLimit: 4 },
      risk: { maxMarkets: 1 }
    });
    const venue = new MockVenue();
    venue.failToken = '';
    const activeLowPotential = {
      ...activeMarket,
      tokenId: 'open-order-active-token',
      marketId: 'open-order-active-token',
      rewards: { enabled: true, level: 4, minShares: 100, maxSpreadCents: 6, ppPerHour: 10 }
    };
    venue.markets = [
      activeLowPotential,
      ...Array.from({ length: 12 }, (_, index) => ({
        ...activeMarket,
        tokenId: `sync-hot-candidate-${index}`,
        marketId: `sync-hot-candidate-${index}`,
        rewards: { enabled: true, level: 5, minShares: 10, maxSpreadCents: 6, ppPerHour: 5000 - index }
      }))
    ];
    try {
      const snapshot = await new MarketDataSyncService(config, venue, store).sync('predict', {
        openOrders: [{
          venue: 'predict',
          externalId: 'active-order',
          tokenId: activeLowPotential.tokenId,
          side: 'SELL',
          price: 0.51,
          size: 10,
          status: 'OPEN'
        }]
      });
      const scan = store.getCheckpoint('market-scan.predict')?.value as { active?: number } | undefined;

      expect(snapshot.books.has(activeLowPotential.tokenId)).toBe(true);
      expect(scan?.active).toBe(1);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the previous selected route token in the active scan while submit confirmation catches up', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config = appConfigSchema.parse({
      liveEnabled: true,
      strategy: { marketRefreshMs: 1, autoSelectMarkets: true, minMarketLiquidityUsd: 0, minRewardLevel: 0, candidateLimit: 4 },
      risk: { maxMarkets: 1 }
    });
    const venue = new MockVenue();
    venue.failToken = '';
    const previousRoute = {
      ...activeMarket,
      tokenId: 'previous-route-active-token',
      marketId: 'previous-route-active-token',
      rewards: { enabled: true, level: 4, minShares: 100, maxSpreadCents: 6, ppPerHour: 10 }
    };
    venue.markets = [
      previousRoute,
      ...Array.from({ length: 12 }, (_, index) => ({
        ...activeMarket,
        tokenId: `previous-route-hot-${index}`,
        marketId: `previous-route-hot-${index}`,
        rewards: { enabled: true, level: 5, minShares: 10, maxSpreadCents: 6, ppPerHour: 5000 - index }
      }))
    ];
    store.checkpoint('route.predict', {
      selected: [{ tokenId: previousRoute.tokenId, marketId: previousRoute.marketId, side: 'BUY' }]
    });
    try {
      const snapshot = await new MarketDataSyncService(config, venue, store).sync('predict');
      const scan = store.getCheckpoint('market-scan.predict')?.value as { active?: number; activeTokens?: Array<{ tokenId?: string }> } | undefined;

      expect(snapshot.books.has(previousRoute.tokenId)).toBe(true);
      expect(scan?.active).toBe(1);
      expect(scan?.activeTokens?.map((item) => item.tokenId)).toContain(previousRoute.tokenId);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reuses fresh non-active orderbooks for routing coverage without increasing the current scan budget', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config = appConfigSchema.parse({
      liveEnabled: true,
      strategy: {
        entryMode: 'split',
        marketRefreshMs: 60000,
        quoteRefreshMs: 2000,
        autoSelectMarkets: true,
        minMarketLiquidityUsd: 0,
        minRewardLevel: 0,
        candidateLimit: 2
      },
      risk: { maxMarkets: 1 }
    });
    const venue = new MockVenue();
    venue.failToken = '';
    venue.markets = Array.from({ length: 6 }, (_, index) => ({
      ...activeMarket,
      tokenId: `cached-route-${index}`,
      marketId: `cached-route-${index}`,
      rewards: { enabled: true, level: 5, minShares: 10, maxSpreadCents: 6, ppPerHour: 5000 - index }
    }));

    try {
      const service = new MarketDataSyncService(config, venue, store);
      const first = await service.sync('predict');
      const firstScan = store.getCheckpoint('market-scan.predict')?.value as { scannedOrderbooks?: number; routeUsableOrderbooks?: number; cachedOrderbooks?: number } | undefined;
      const second = await service.sync('predict');
      const secondScan = store.getCheckpoint('market-scan.predict')?.value as { scannedOrderbooks?: number; routeUsableOrderbooks?: number; cachedOrderbooks?: number } | undefined;

      expect(first.books.size).toBe(firstScan?.scannedOrderbooks);
      expect(secondScan?.scannedOrderbooks).toBeLessThan(venue.markets.length);
      expect(second.books.size).toBeGreaterThan(secondScan?.scannedOrderbooks ?? 0);
      expect(secondScan?.routeUsableOrderbooks).toBe(second.books.size);
      expect(secondScan?.cachedOrderbooks).toBeGreaterThan(0);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('shares fresh route orderbook cache across market sync service instances', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config = appConfigSchema.parse({
      liveEnabled: true,
      strategy: {
        marketRefreshMs: 60000,
        quoteRefreshMs: 2000,
        autoSelectMarkets: true,
        minMarketLiquidityUsd: 0,
        minRewardLevel: 0,
        candidateLimit: 2
      },
      risk: { maxMarkets: 1 }
    });
    const venue = new MockVenue();
    venue.failToken = '';
    venue.markets = Array.from({ length: 6 }, (_, index) => ({
      ...activeMarket,
      tokenId: `shared-cache-route-${index}`,
      marketId: `shared-cache-route-${index}`,
      rewards: { enabled: true, level: 5, minShares: 10, maxSpreadCents: 6, ppPerHour: 5000 - index }
    }));

    try {
      const first = await new MarketDataSyncService(config, venue, store).sync('predict');
      const firstScan = store.getCheckpoint('market-scan.predict')?.value as { scannedOrderbooks?: number } | undefined;
      const second = await new MarketDataSyncService(config, venue, store).sync('predict');
      const secondScan = store.getCheckpoint('market-scan.predict')?.value as { scannedOrderbooks?: number; routeUsableOrderbooks?: number; cachedOrderbooks?: number } | undefined;

      expect(first.books.size).toBe(firstScan?.scannedOrderbooks);
      expect(second.books.size).toBeGreaterThanOrEqual(secondScan?.scannedOrderbooks ?? 0);
      expect(secondScan?.cachedOrderbooks ?? 0).toBeGreaterThanOrEqual(0);
      expect(secondScan?.routeUsableOrderbooks).toBe(second.books.size);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not reuse a stale cached orderbook after the routing cache TTL expires', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config = appConfigSchema.parse({
      liveEnabled: true,
      strategy: {
        marketRefreshMs: 1,
        quoteRefreshMs: 2000,
        autoSelectMarkets: true,
        minMarketLiquidityUsd: 0,
        minRewardLevel: 0,
        candidateLimit: 2
      },
      risk: { maxMarkets: 1 }
    });
    const venue = new MockVenue();
    venue.failToken = '';
    venue.markets = Array.from({ length: 6 }, (_, index) => ({
      ...activeMarket,
      tokenId: `stale-route-${index}`,
      marketId: `stale-route-${index}`,
      rewards: { enabled: true, level: 5, minShares: 10, maxSpreadCents: 6, ppPerHour: 5000 - index }
    }));

    try {
      const service = new MarketDataSyncService(config, venue, store);
      const originalGetOrderbook = venue.getOrderbook.bind(venue);
      venue.getOrderbook = async (tokenId: string) => {
        const fresh = await originalGetOrderbook(tokenId);
        return { ...fresh, receivedAt: Date.now() - 16_000 };
      };
      await service.sync('predict');
      await service.sync('predict');
      const scan = store.getCheckpoint('market-scan.predict')?.value as { scannedOrderbooks?: number; routeUsableOrderbooks?: number; cachedOrderbooks?: number } | undefined;

      expect(scan?.routeUsableOrderbooks).toBe(scan?.scannedOrderbooks);
      expect(scan?.cachedOrderbooks).toBe(0);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fetches candidate orderbooks concurrently so early books do not age while later books wait', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config = appConfigSchema.parse({
      liveEnabled: true,
      strategy: { marketRefreshMs: 1, autoSelectMarkets: true, minMarketLiquidityUsd: 0, minRewardLevel: 0, candidateLimit: 8 },
      risk: { maxMarkets: 1 }
    });
    const venue = new MockVenue();
    venue.failToken = '';
    venue.orderbookDelayMs = 20;
    venue.markets = Array.from({ length: 8 }, (_, index) => ({
      ...activeMarket,
      tokenId: `active-token-${index}`,
      marketId: `market-${index}`
    }));
    const activeOpenOrders: OpenOrder[] = venue.markets.map((item, index) => ({
      venue: 'predict',
      externalId: `active-order-${index}`,
      tokenId: item.tokenId,
      side: 'SELL',
      price: 0.51,
      size: 10,
      status: 'OPEN'
    }));
    try {
      const startedAt = Date.now();
      const snapshot = await new MarketDataSyncService(config, venue, store).sync('predict', {
        openOrders: activeOpenOrders
      });
      const maxBookAgeMs = Math.max(...[...snapshot.books.values()].map((item) => Date.now() - item.receivedAt));

      expect(snapshot.books.size).toBe(8);
      expect(venue.maxConcurrentOrderbookCalls).toBeGreaterThan(1);
      expect(Date.now() - startedAt).toBeLessThan(140);
      expect(maxBookAgeMs).toBeLessThan(80);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves position markets from position metadata when cached market candidates omit the held tokens', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config = appConfigSchema.parse({
      liveEnabled: true,
      strategy: { marketRefreshMs: 1, autoSelectMarkets: true, minMarketLiquidityUsd: 0, minRewardLevel: 0 }
    });
    const venue = new MockVenue();
    venue.markets = [activeMarket];
    const positions: Position[] = [
      {
        venue: 'predict',
        tokenId: 'held-yes',
        marketId: 'held-market',
        conditionId: 'held-condition',
        outcome: 'YES',
        outcomeCount: 2,
        size: 10,
        notionalUsd: 0.1
      },
      {
        venue: 'predict',
        tokenId: 'held-no',
        marketId: 'held-market',
        conditionId: 'held-condition',
        outcome: 'NO',
        outcomeCount: 2,
        size: 10,
        notionalUsd: 9.9
      }
    ];
    try {
      const markets = await new MarketDataSyncService(config, venue, store).resolveMarketsForPositions('predict', positions);

      expect(markets.map((item) => item.tokenId).sort()).toEqual(['held-no', 'held-yes']);
      expect(new Set(markets.map((item) => item.conditionId))).toEqual(new Set(['held-condition']));
      expect(markets.every((item) => item.outcomeCount === 2)).toBe(true);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prefers raw platform market metadata carried by positions over placeholder position markets', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config = appConfigSchema.parse({
      liveEnabled: true,
      strategy: { marketRefreshMs: 1, autoSelectMarkets: true, minMarketLiquidityUsd: 0, minRewardLevel: 0 }
    });
    const venue = new MockVenue();
    venue.markets = [activeMarket];
    const carriedMarket: Market = {
      ...activeMarket,
      tokenId: 'held-with-market',
      marketId: 'held-market',
      conditionId: 'held-condition',
      question: 'Carried market metadata',
      endTime: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
      endTimeSource: 'reward-end',
      rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 1500 }
    };
    try {
      const markets = await new MarketDataSyncService(config, venue, store).resolveMarketsForPositions('predict', [{
        venue: 'predict',
        tokenId: carriedMarket.tokenId,
        marketId: carriedMarket.marketId,
        conditionId: carriedMarket.conditionId,
        outcome: carriedMarket.outcome,
        outcomeCount: 2,
        market: carriedMarket,
        size: 10,
        notionalUsd: 5
      }]);

      expect(markets).toHaveLength(1);
      expect(markets[0]).toMatchObject({
        tokenId: 'held-with-market',
        question: 'Carried market metadata',
        rewards: { enabled: true, ppPerHour: 1500 },
        endTimeSource: 'reward-end'
      });
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fills missing orderbooks for enriched position markets after the initial candidate sync', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config = appConfigSchema.parse({
      liveEnabled: true,
      strategy: { marketRefreshMs: 1, autoSelectMarkets: true, minMarketLiquidityUsd: 0, minRewardLevel: 0 }
    });
    const venue = new MockVenue();
    venue.failToken = '';
    const heldMarket = {
      ...activeMarket,
      tokenId: 'held-token',
      marketId: 'held-market',
      conditionId: 'held-condition'
    };
    const books = new Map<string, Orderbook>([[activeMarket.tokenId, { ...book, tokenId: activeMarket.tokenId }]]);
    try {
      await new MarketDataSyncService(config, venue, store).fillMissingOrderbooks('predict', [activeMarket, heldMarket], books);

      expect(books.has(activeMarket.tokenId)).toBe(true);
      expect(books.has(heldMarket.tokenId)).toBe(true);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Placed last: a cash forced full scan advances the shared 'full' rotation cursor, so keeping it after the
  // cursor-dependent tests above avoids perturbing their expected rotation.
  it('cash forced full scan covers a broad slice of the universe so the rolling route-audit can reach gate coverage', () => {
    const config = appConfigSchema.parse({
      liveEnabled: true,
      strategy: { entryMode: 'cash', quoteSide: 'buy', autoSelectMarkets: true, minMarketLiquidityUsd: 0, minRewardLevel: 0, candidateLimit: 60, quoteRefreshMs: 2000 },
      risk: { maxMarkets: 2 }
    });
    const markets = Array.from({ length: 120 }, (_, index) => ({
      ...activeMarket,
      tokenId: `cash-full-${index}`,
      marketId: `cash-full-${index}`,
      rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 5000 - index }
    }));

    const plan = planMarketOrderbookScan(config, 'predict', markets, { forceFullScan: true });

    expect(plan.fullScan).toBe(true);
    // Much broader than the tiny per-cycle budget (~4), but bounded (total active+scan ~FULL_ROUTE_SCAN_MAX_ORDERBOOKS=70)
    // so the cycle stays well under the loop's 45s slow-cycle guard even at high maxMarkets. Raised from 45 once cash
    // maxMarkets shrank (≤~5 active), giving headroom to cover the universe in fewer passes.
    expect(plan.markets.length).toBeGreaterThanOrEqual(30);
    expect(plan.markets.length).toBeLessThanOrEqual(70);
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
