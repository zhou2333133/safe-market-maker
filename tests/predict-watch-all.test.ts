import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { appConfigSchema } from '../src/config/schema.js';
import type { Balance, Market, OpenOrder, OrderIntent, OrderResult, Orderbook, Position, VenueName } from '../src/domain/types.js';
import { clearSharedMarketCache, MarketDataSyncService } from '../src/execution/market-data-sync.js';
import { StateStore } from '../src/store/sqlite.js';
import type { VenueAdapter } from '../src/venues/types.js';

function predictMarket(tokenId: string, ppPerHour: number): Market {
  return {
    venue: 'predict',
    tokenId,
    marketId: tokenId,
    question: `Market ${tokenId}?`,
    volume24hUsd: 10000,
    liquidityUsd: 15000,
    acceptingOrders: true,
    endTime: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    endTimeSource: 'market-end',
    negRisk: false,
    feeRateBps: 0,
    tickSize: 0.01,
    rewards: { enabled: true, level: 5, minShares: 10, maxSpreadCents: 6, ppPerHour }
  };
}

function freshBook(tokenId: string): Orderbook {
  return {
    venue: 'predict',
    tokenId,
    receivedAt: Date.now(),
    bids: [{ price: 0.49, size: 1000 }, { price: 0.48, size: 1000 }],
    asks: [{ price: 0.51, size: 1000 }, { price: 0.52, size: 1000 }]
  };
}

class WatchAllMockVenue implements VenueAdapter {
  readonly name: VenueName = 'predict';
  markets: Market[] = [];
  watchedTokenIds: string[] = [];
  restOrderbookCalls: string[] = [];
  cachedTokens = new Set<string>();

  async testConnection(): Promise<boolean> { return true; }
  async getMarkets(): Promise<Market[]> { return this.markets; }
  hydrateFromMarkets(): void { /* no-op for test */ }
  watchMarkets(markets: Market[]): void { this.watchedTokenIds = markets.map((market) => market.tokenId); }
  getCachedOrderbook(tokenId: string): Orderbook | undefined {
    return this.cachedTokens.has(tokenId) ? freshBook(tokenId) : undefined;
  }
  wsWatchStats(): { connected: boolean; watchedMarkets: number; cachedOrderbooks: number } {
    return { connected: true, watchedMarkets: this.watchedTokenIds.length, cachedOrderbooks: this.cachedTokens.size };
  }
  async getOrderbook(tokenId: string): Promise<Orderbook> {
    this.restOrderbookCalls.push(tokenId);
    return freshBook(tokenId);
  }
  async getBalances(): Promise<Balance[]> { return []; }
  async getPositions(): Promise<Position[]> { return []; }
  async getOpenOrders(): Promise<OpenOrder[]> { return []; }
  async createOrder(intent: OrderIntent): Promise<OrderResult> {
    return { venue: this.name, clientOrderId: intent.clientOrderId, status: 'OPEN' };
  }
  async cancelOrders(): Promise<void> { return undefined; }
}

describe('WS orderbook fetch flag', () => {
  it('defaults to WS watch-all so the market count follows maxMarkets, not the REST throttle', () => {
    const config = appConfigSchema.parse({});
    expect(config.strategy.wsWatchAll).toBe(true);
  });

  it('can be turned off to fall back to the old REST-budget scanning', () => {
    const config = appConfigSchema.parse({ strategy: { wsWatchAll: false } });
    expect(config.strategy.wsWatchAll).toBe(false);
  });
});

describe('predict WS-cache-first orderbook reads (inside the unchanged scan + audit)', () => {
  beforeEach(() => {
    clearSharedMarketCache();
  });

  it('subscribes scanned markets to the WS and reads cached books for free, REST only on cache miss', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-watchall-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config = appConfigSchema.parse({
      liveEnabled: true,
      strategy: {
        entryMode: 'cash',
        quoteSide: 'buy',
        autoSelectMarkets: true,
        marketRefreshMs: 1,
        minMarketLiquidityUsd: 0,
        minRewardLevel: 0
        // wsWatchAll defaults true
      },
      risk: { maxMarkets: 20 }
    });
    const venue = new WatchAllMockVenue();
    venue.markets = [predictMarket('warm-a', 500), predictMarket('warm-b', 400), predictMarket('cold-c', 300)];
    venue.cachedTokens = new Set(['warm-a', 'warm-b']); // cold-c is a cache miss

    try {
      const snapshot = await new MarketDataSyncService(config, venue, store).sync('predict');

      // scanned markets got subscribed to the persistent WS
      expect(venue.watchedTokenIds.sort()).toEqual(['cold-c', 'warm-a', 'warm-b']);
      // every scanned market ends up with a book (audit/routing see the same coverage as before)
      expect(snapshot.books.has('warm-a')).toBe(true);
      expect(snapshot.books.has('warm-b')).toBe(true);
      expect(snapshot.books.has('cold-c')).toBe(true);
      // WS cache hits cost NO REST; only the cache miss hit REST
      expect(venue.restOrderbookCalls).not.toContain('warm-a');
      expect(venue.restOrderbookCalls).not.toContain('warm-b');
      expect(venue.restOrderbookCalls).toEqual(['cold-c']);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back to plain REST reads (no WS) when watch-all is turned off', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-watchall-off-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config = appConfigSchema.parse({
      liveEnabled: true,
      strategy: {
        entryMode: 'cash',
        quoteSide: 'buy',
        autoSelectMarkets: true,
        marketRefreshMs: 1,
        minMarketLiquidityUsd: 0,
        minRewardLevel: 0,
        wsWatchAll: false
      },
      risk: { maxMarkets: 20 }
    });
    const venue = new WatchAllMockVenue();
    venue.markets = [predictMarket('rest-a', 500), predictMarket('rest-b', 400)];
    venue.cachedTokens = new Set(['rest-a', 'rest-b']); // would be cache hits IF watch-all were on

    try {
      await new MarketDataSyncService(config, venue, store).sync('predict');
      // watch-all off => never subscribes, fetches every book over REST
      expect(venue.watchedTokenIds).toEqual([]);
      expect(venue.restOrderbookCalls.sort()).toEqual(['rest-a', 'rest-b']);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
