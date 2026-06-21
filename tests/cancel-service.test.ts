import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
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
import { CancelService } from '../src/execution/cancel-service.js';
import { cancelSemantics } from '../src/execution/cancel-semantics.js';
import type { SignerProvider } from '../src/secrets/signer.js';
import { StateStore } from '../src/store/sqlite.js';
import type { MarketRouteCandidate } from '../src/strategy/market-router.js';
import type { VenueAdapter } from '../src/venues/types.js';

const market: Market = {
  venue: 'predict',
  tokenId: 'token-1',
  question: 'Cancel safely?',
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

const book: Orderbook = {
  venue: 'predict',
  tokenId: market.tokenId,
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

const oldOrder: OpenOrder = {
  venue: 'predict',
  externalId: 'old-maker',
  tokenId: market.tokenId,
  side: 'BUY',
  price: 0.46,
  size: 10,
  status: 'OPEN'
};

const desiredIntent: OrderIntent = {
  venue: 'predict',
  market,
  tokenId: market.tokenId,
  side: 'BUY',
  price: 0.49,
  size: 10,
  notionalUsd: 4.9,
  postOnly: true,
  reason: 'test',
  clientOrderId: 'desired-intent',
  reward: { optimizer: 'test', score: 10, level: 5, minShares: 10, maxSpreadCents: 6 }
};

class MockVenue implements VenueAdapter {
  readonly name: VenueName = 'predict';
  canceledIds: string[] = [];

  async testConnection(): Promise<boolean> {
    return true;
  }

  async getMarkets(): Promise<Market[]> {
    return [market];
  }

  async getOrderbook(): Promise<Orderbook> {
    return book;
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

  async cancelOrders(orderIds: string[]): Promise<void> {
    this.canceledIds.push(...orderIds);
  }
}

describe('cancel service', () => {
  it('cancels replaceable reward quotes without stacking exposure', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config = appConfigSchema.parse({
      liveEnabled: true,
      strategy: { entryMode: 'inventory', replaceThresholdTicks: 1 },
      selectedMarkets: { predict: [market.tokenId], polymarket: [] }
    });
    const venue = new MockVenue();
    try {
      recordManagedOpenOrder(store, oldOrder);
      const result = await new CancelService(config, venue, store).cancelReplaceableOrders(
        'predict',
        [oldOrder],
        [desiredIntent],
        [market],
        new Map([[market.tokenId, book]])
      );

      expect(result.openOrders).toEqual([]);
      expect(venue.canceledIds).toEqual(['old-maker']);
      expect(store.listRecentEvents(10).some((event) => event.type === 'quote.replace-cancel')).toBe(true);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps a matching cash BUY order when front protection remains safe', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config = appConfigSchema.parse({
      liveEnabled: true,
      strategy: {
        entryMode: 'cash',
        quoteSide: 'buy',
        enforceRewardMinimum: false,
        replaceThresholdTicks: 1
      },
      risk: { orderSizeUsd: 4.9, maxSingleOrderUsd: 100, maxPositionUsd: 200 },
      selectedMarkets: { predict: [market.tokenId], polymarket: [] }
    });
    const venue = new MockVenue();
    const existing: OpenOrder = {
      ...oldOrder,
      price: 0.47,
      size: desiredIntent.size,
      externalId: 'matching-cash-buy'
    };
    const desired: OrderIntent = {
      ...desiredIntent,
      price: 0.47,
      notionalUsd: 4.7
    };
    const protectedBook: Orderbook = {
      ...book,
      bids: [
        { price: 0.5, size: 3000 },
        { price: 0.49, size: 3000 },
        { price: 0.48, size: 3000 },
        { price: 0.47, size: 3000 }
      ],
      asks: [{ price: 0.51, size: 3000 }]
    };
    try {
      recordManagedOpenOrder(store, existing);
      const result = await new CancelService(config, venue, store).cancelReplaceableOrders(
        'predict',
        [existing],
        [desired],
        [market],
        new Map([[market.tokenId, protectedBook]])
      );

      expect(result.openOrders).toEqual([existing]);
      expect(venue.canceledIds).toEqual([]);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('cancels a matching cash BUY order when front protection depth disappears', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config = appConfigSchema.parse({
      liveEnabled: true,
      strategy: {
        entryMode: 'cash',
        quoteSide: 'buy',
        enforceRewardMinimum: false,
        replaceThresholdTicks: 10
      },
      risk: { orderSizeUsd: 4.9, maxSingleOrderUsd: 100, maxPositionUsd: 200, minDepthUsdPerSide: 1000 },
      selectedMarkets: { predict: [market.tokenId], polymarket: [] }
    });
    const venue = new MockVenue();
    const existing: OpenOrder = {
      ...oldOrder,
      price: 0.47,
      size: 10,
      externalId: 'thin-front-cash-buy'
    };
    const desired: OrderIntent = {
      ...desiredIntent,
      price: 0.47,
      notionalUsd: 4.7,
      reward: { optimizer: 'test', score: 10, level: 5, minShares: 10, maxSpreadCents: 6 }
    };
    const thinFrontBook: Orderbook = {
      ...book,
      bids: [
        { price: 0.5, size: 10 },
        { price: 0.49, size: 10 },
        { price: 0.48, size: 10 },
        { price: 0.47, size: 5000 }
      ],
      asks: [{ price: 0.51, size: 5000 }]
    };
    try {
      recordManagedOpenOrder(store, existing);
      const result = await new CancelService(config, venue, store).cancelReplaceableOrders(
        'predict',
        [existing],
        [desired],
        [market],
        new Map([[market.tokenId, thinFrontBook]])
      );

      expect(result.openOrders).toEqual([]);
      expect(venue.canceledIds).toEqual(['thin-front-cash-buy']);
      expect(store.listRecentEvents(10).find((event) => event.type === 'quote.replace-cancel')?.details).toMatchObject({
        ids: ['thin-front-cash-buy']
      });
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps a cash BUY order when front protection is only slightly below the new-entry floor', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config = appConfigSchema.parse({
      liveEnabled: true,
      strategy: {
        entryMode: 'cash',
        quoteSide: 'buy',
        enforceRewardMinimum: false,
        replaceThresholdTicks: 1
      },
      risk: { orderSizeUsd: 5, maxSingleOrderUsd: 100, maxPositionUsd: 200, minDepthUsdPerSide: 100 },
      selectedMarkets: { predict: [market.tokenId], polymarket: [] }
    });
    const venue = new MockVenue();
    const existing: OpenOrder = {
      ...oldOrder,
      price: 0.47,
      size: 10,
      externalId: 'maintenance-depth-cash-buy'
    };
    const desired: OrderIntent = {
      ...desiredIntent,
      price: 0.47,
      size: 10.4,
      notionalUsd: 4.888,
      reward: { optimizer: 'test', score: 10, level: 5, minShares: 10, maxSpreadCents: 6 }
    };
    const maintenanceBook: Orderbook = {
      ...book,
      bids: [
        { price: 0.5, size: 10 },
        { price: 0.49, size: 120 },
        { price: 0.48, size: 50 },
        { price: 0.47, size: 5000 }
      ],
      asks: [{ price: 0.51, size: 5000 }]
    };
    try {
      recordManagedOpenOrder(store, existing);
      const result = await new CancelService(config, venue, store).cancelReplaceableOrders(
        'predict',
        [existing],
        [desired],
        [market],
        new Map([[market.tokenId, maintenanceBook]])
      );

      expect(result.openOrders).toEqual([existing]);
      expect(venue.canceledIds).toEqual([]);
      expect(store.listRecentEvents(10).some((event) => event.type === 'quote.replace-cancel')).toBe(false);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps a lower priced cash BUY instead of chasing a higher desired quote', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config = appConfigSchema.parse({
      liveEnabled: true,
      strategy: {
        entryMode: 'cash',
        quoteSide: 'buy',
        enforceRewardMinimum: false,
        replaceThresholdTicks: 1
      },
      risk: { orderSizeUsd: 5, maxSingleOrderUsd: 100, maxPositionUsd: 200, minDepthUsdPerSide: 25 },
      selectedMarkets: { predict: [market.tokenId], polymarket: [] }
    });
    const venue = new MockVenue();
    const existing: OpenOrder = {
      ...oldOrder,
      price: 0.47,
      size: 10,
      externalId: 'lower-price-cash-buy'
    };
    const desired: OrderIntent = {
      ...desiredIntent,
      price: 0.49,
      size: 10.4,
      notionalUsd: 5.096,
      reward: { optimizer: 'test', score: 10, level: 5, minShares: 10, maxSpreadCents: 6 }
    };
    const safeBook: Orderbook = {
      ...book,
      bids: [
        { price: 0.5, size: 3000 },
        { price: 0.49, size: 3000 },
        { price: 0.48, size: 3000 },
        { price: 0.47, size: 3000 }
      ],
      asks: [{ price: 0.51, size: 3000 }]
    };
    try {
      recordManagedOpenOrder(store, existing);
      const result = await new CancelService(config, venue, store).cancelReplaceableOrders(
        'predict',
        [existing],
        [desired],
        [market],
        new Map([[market.tokenId, safeBook]])
      );

      expect(result.openOrders).toEqual([existing]);
      expect(venue.canceledIds).toEqual([]);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('cancels a cash BUY order when the current price is above the safer target', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config = appConfigSchema.parse({
      liveEnabled: true,
      strategy: {
        entryMode: 'cash',
        quoteSide: 'buy',
        enforceRewardMinimum: false,
        replaceThresholdTicks: 1
      },
      risk: { orderSizeUsd: 5, maxSingleOrderUsd: 100, maxPositionUsd: 200, minDepthUsdPerSide: 25 },
      selectedMarkets: { predict: [market.tokenId], polymarket: [] }
    });
    const venue = new MockVenue();
    const existing: OpenOrder = {
      ...oldOrder,
      price: 0.48,
      size: 10,
      externalId: 'too-high-cash-buy'
    };
    const desired: OrderIntent = {
      ...desiredIntent,
      price: 0.46,
      size: 10.6,
      notionalUsd: 4.876,
      reward: { optimizer: 'test', score: 10, level: 5, minShares: 10, maxSpreadCents: 6 }
    };
    const safeBook: Orderbook = {
      ...book,
      bids: [
        { price: 0.51, size: 3000 },
        { price: 0.5, size: 3000 },
        { price: 0.49, size: 3000 },
        { price: 0.48, size: 3000 },
        { price: 0.46, size: 3000 }
      ],
      asks: [{ price: 0.52, size: 3000 }]
    };
    try {
      recordManagedOpenOrder(store, existing);
      const result = await new CancelService(config, venue, store).cancelReplaceableOrders(
        'predict',
        [existing],
        [desired],
        [market],
        new Map([[market.tokenId, safeBook]])
      );
      // Predict venue: price-drift replace is now suppressed. Orders stay put as long as
      // protection depth and reward band pass — forfeiting queue position for the same
      // outcome is wasteful.
      expect(result.openOrders).toEqual([existing]);
      expect(venue.canceledIds).toEqual([]);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fast ticks debounce a 1-tick replace until the same target repeats, then cancel', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config = appConfigSchema.parse({
      liveEnabled: true,
      // Tight support-gap (1 tick) so the existing order's 2-tick gap fails protection and a replace is genuinely
      // required — this exercises the fast-tick replace DEBOUNCE (the looser default 10-tick gap would just keep it).
      strategy: { entryMode: 'cash', quoteSide: 'buy', enforceRewardMinimum: false, replaceThresholdTicks: 1, cashProbeMaxSupportGapTicks: 1 },
      risk: { orderSizeUsd: 5, maxSingleOrderUsd: 100, maxPositionUsd: 200, minDepthUsdPerSide: 25 },
      selectedMarkets: { predict: [market.tokenId], polymarket: [] }
    });
    const venue = new MockVenue();
    const existing: OpenOrder = { ...oldOrder, price: 0.47, size: 10, externalId: 'one-tick-drift' };
    const desired: OrderIntent = { ...desiredIntent, price: 0.46, size: 10.6, notionalUsd: 4.876 };
    const safeBook: Orderbook = {
      ...book,
      bids: [
        { price: 0.51, size: 3000 },
        { price: 0.5, size: 3000 },
        { price: 0.49, size: 3000 },
        { price: 0.48, size: 3000 },
        { price: 0.46, size: 3000 }
      ],
      asks: [{ price: 0.52, size: 3000 }]
    };
    const books = new Map([[market.tokenId, safeBook]]);
    try {
      recordManagedOpenOrder(store, existing);
      const first = await new CancelService(config, venue, store).cancelReplaceableOrders(
        'predict',
        [existing],
        [desired],
        [market],
        books,
        [],
        { deferObsoleteCancels: true }
      );
      expect(first.canceledIds).toEqual([]);
      expect(venue.canceledIds).toEqual([]);

      const second = await new CancelService(config, venue, store).cancelReplaceableOrders(
        'predict',
        [existing],
        [desired],
        [market],
        books,
        [],
        { deferObsoleteCancels: true }
      );
      expect(second.canceledIds).toEqual(['one-tick-drift']);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fast ticks replace immediately when the target drifts by two or more ticks', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config = appConfigSchema.parse({
      liveEnabled: true,
      strategy: { entryMode: 'cash', quoteSide: 'buy', enforceRewardMinimum: false, replaceThresholdTicks: 1 },
      risk: { orderSizeUsd: 5, maxSingleOrderUsd: 100, maxPositionUsd: 200, minDepthUsdPerSide: 25 },
      selectedMarkets: { predict: [market.tokenId], polymarket: [] }
    });
    const venue = new MockVenue();
    const existing: OpenOrder = { ...oldOrder, price: 0.48, size: 10, externalId: 'two-tick-drift' };
    const desired: OrderIntent = { ...desiredIntent, price: 0.46, size: 10.6, notionalUsd: 4.876 };
    const safeBook: Orderbook = {
      ...book,
      bids: [
        { price: 0.51, size: 3000 },
        { price: 0.5, size: 3000 },
        { price: 0.49, size: 3000 },
        { price: 0.48, size: 3000 },
        { price: 0.46, size: 3000 }
      ],
      asks: [{ price: 0.52, size: 3000 }]
    };
    try {
      recordManagedOpenOrder(store, existing);
      const result = await new CancelService(config, venue, store).cancelReplaceableOrders(
        'predict',
        [existing],
        [desired],
        [market],
        new Map([[market.tokenId, safeBook]]),
        [],
        { deferObsoleteCancels: true }
      );
      // Predict venue: price-drift replace is now suppressed. Even a 2+ tick drift
      // does not trigger cancel/replace when protection depth and reward band are OK.
      expect(result.canceledIds).toEqual([]);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores tiny cash BUY size drift but cancels material oversize orders', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config = appConfigSchema.parse({
      liveEnabled: true,
      strategy: {
        entryMode: 'cash',
        quoteSide: 'buy',
        enforceRewardMinimum: false,
        replaceThresholdTicks: 1
      },
      risk: { orderSizeUsd: 5, maxSingleOrderUsd: 100, maxPositionUsd: 200, minDepthUsdPerSide: 25 },
      selectedMarkets: { predict: [market.tokenId], polymarket: [] }
    });
    const venue = new MockVenue();
    const tinyDrift: OpenOrder = {
      ...oldOrder,
      price: 0.47,
      size: 10.02,
      externalId: 'tiny-size-drift-cash-buy'
    };
    const oversized: OpenOrder = {
      ...oldOrder,
      price: 0.47,
      size: 11.3,
      externalId: 'oversized-cash-buy'
    };
    const desired: OrderIntent = {
      ...desiredIntent,
      price: 0.47,
      size: 10.6383,
      notionalUsd: 5,
      reward: { optimizer: 'test', score: 10, level: 5, minShares: 10, maxSpreadCents: 6 }
    };
    const safeBook: Orderbook = {
      ...book,
      bids: [
        { price: 0.5, size: 3000 },
        { price: 0.49, size: 3000 },
        { price: 0.48, size: 3000 },
        { price: 0.47, size: 3000 }
      ],
      asks: [{ price: 0.51, size: 3000 }]
    };
    try {
      recordManagedOpenOrder(store, tinyDrift);
      recordManagedOpenOrder(store, oversized);
      const result = await new CancelService(config, venue, store).cancelReplaceableOrders(
        'predict',
        [tinyDrift, oversized],
        [desired],
        [market],
        new Map([[market.tokenId, safeBook]])
      );

      expect(result.openOrders).toEqual([tinyDrift]);
      expect(venue.canceledIds).toEqual(['oversized-cash-buy']);
      expect(store.listRecentEvents(10).find((event) => event.type === 'quote.replace-cancel')?.details).toMatchObject({
        ids: ['oversized-cash-buy'],
        reasons: [expect.objectContaining({ reason: expect.stringContaining('超过当前目标金额') })]
      });
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('defers cash BUY replacement once when the maintenance book is stale', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config = appConfigSchema.parse({
      liveEnabled: true,
      strategy: {
        entryMode: 'cash',
        quoteSide: 'buy',
        enforceRewardMinimum: false,
        replaceThresholdTicks: 1
      },
      risk: { staleBookMs: 2000, orderSizeUsd: 4.9, maxSingleOrderUsd: 100, maxPositionUsd: 200 },
      selectedMarkets: { predict: [market.tokenId], polymarket: [] }
    });
    const venue = new MockVenue();
    const staleBook = { ...book, receivedAt: Date.now() - 3000 };
    try {
      recordManagedOpenOrder(store, oldOrder);
      const result = await new CancelService(config, venue, store).cancelReplaceableOrders(
        'predict',
        [oldOrder],
        [desiredIntent],
        [market],
        new Map([[market.tokenId, staleBook]])
      );

      expect(result.openOrders).toEqual([oldOrder]);
      expect(venue.canceledIds).toEqual([]);
      // Predict venue: stale books no longer produce deferred events
      expect(store.listRecentEvents(10).find((event) => event.type === 'quote.replace-deferred')).toBeUndefined();
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps a protected cash BUY order when its maintenance book is only briefly stale', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config = appConfigSchema.parse({
      liveEnabled: true,
      strategy: {
        entryMode: 'cash',
        quoteSide: 'buy',
        enforceRewardMinimum: false,
        replaceThresholdTicks: 1
      },
      risk: { staleBookMs: 2000, orderSizeUsd: 4.9, maxSingleOrderUsd: 100, maxPositionUsd: 200 },
      selectedMarkets: { predict: [market.tokenId], polymarket: [] }
    });
    const venue = new MockVenue();
    const staleBook = { ...book, receivedAt: Date.now() - 3000 };
    try {
      recordManagedOpenOrder(store, oldOrder);
      const result = await new CancelService(config, venue, store).cancelReplaceableOrders(
        'predict',
        [oldOrder],
        [{ ...desiredIntent, tokenId: oldOrder.tokenId }],
        [market],
        new Map([[market.tokenId, staleBook]])
      );

      expect(result.openOrders).toEqual([oldOrder]);
      expect(venue.canceledIds).toEqual([]);
      // Predict venue: stale books no longer produce deferred events
      expect(store.listRecentEvents(10).find((event) => event.type === 'quote.replace-deferred')).toBeUndefined();

      const second = await new CancelService(config, venue, store).cancelReplaceableOrders(
        'predict',
        [oldOrder],
        [{ ...desiredIntent, tokenId: oldOrder.tokenId }],
        [market],
        new Map([[market.tokenId, staleBook]])
      );

      expect(second.openOrders).toEqual([oldOrder]);
      expect(venue.canceledIds).toEqual([]);
      // Predict venue: stale books no longer produce deferred events
      expect(store.listRecentEvents(10).find((event) => event.type === 'quote.replace-deferred')).toBeUndefined();
      expect(store.listRecentEvents(10).some((event) => event.type === 'quote.replace-cancel')).toBe(false);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('cancels a protected cash BUY order after consecutive far-stale maintenance books', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config = appConfigSchema.parse({
      liveEnabled: true,
      strategy: {
        entryMode: 'cash',
        quoteSide: 'buy',
        enforceRewardMinimum: false,
        replaceThresholdTicks: 1
      },
      risk: { staleBookMs: 2000, orderSizeUsd: 4.9, maxSingleOrderUsd: 100, maxPositionUsd: 200 },
      selectedMarkets: { predict: [market.tokenId], polymarket: [] }
    });
    const venue = new MockVenue();
    const farStaleBook = { ...book, receivedAt: Date.now() - 20_000 };
    try {
      recordManagedOpenOrder(store, oldOrder);
      const first = await new CancelService(config, venue, store).cancelReplaceableOrders(
        'predict',
        [oldOrder],
        [{ ...desiredIntent, tokenId: oldOrder.tokenId }],
        [market],
        new Map([[market.tokenId, farStaleBook]])
      );

      expect(first.openOrders).toEqual([oldOrder]);
     expect(venue.canceledIds).toEqual([]);
      // Predict venue: stale books no longer produce deferred events
      expect(store.listRecentEvents(10).find((event) => event.type === 'quote.replace-deferred')).toBeUndefined();

     const second = await new CancelService(config, venue, store).cancelReplaceableOrders(
        'predict',
        [oldOrder],
        [{ ...desiredIntent, tokenId: oldOrder.tokenId }],
        [market],
        new Map([[market.tokenId, farStaleBook]])
      );

      // Predict venue: stale books no longer trigger cancel. Order is kept even after
      // multiple stale-book encounters — quiet Predict markets are not a risk indicator.
      expect(second.openOrders).toEqual([oldOrder]);
      expect(venue.canceledIds).toEqual([]);
      // Predict venue: stale books no longer trigger cancel events.
      expect(store.listRecentEvents(10).find((event) => event.type === 'quote.replace-cancel')?.details).toBeUndefined();
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('cancels a protected cash BUY order only after consecutive missing maintenance books', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config = appConfigSchema.parse({
      liveEnabled: true,
      strategy: {
        entryMode: 'cash',
        quoteSide: 'buy',
        enforceRewardMinimum: false,
        cancelOutsideReward: true
      },
      risk: { orderSizeUsd: 4.9, maxSingleOrderUsd: 100, maxPositionUsd: 200 },
      selectedMarkets: { predict: [market.tokenId], polymarket: [] }
    });
    const venue = new MockVenue();
    try {
      recordManagedOpenOrder(store, oldOrder);
      const result = await new CancelService(config, venue, store).cancelReplaceableOrders(
        'predict',
        [oldOrder],
        [],
        [market],
        new Map()
      );

     expect(result.openOrders).toEqual([oldOrder]);
     expect(venue.canceledIds).toEqual([]);
      // Predict venue: missing orderbook generates deferred event after first strike
      expect(store.listRecentEvents(10).find((event) => event.type === 'quote.replace-deferred')?.details).toMatchObject({
        reasons: [
          expect.objectContaining({
            orderId: 'old-maker',
            reason: expect.stringContaining('第 1/2 次确认')
          })
        ]
      });

     const second = await new CancelService(config, venue, store).cancelReplaceableOrders(
        'predict',
        [oldOrder],
        [],
        [market],
        new Map()
      );
      // Predict venue: MISSING orderbooks (WS dead, not just stale) still trigger cancel
      // after 2 consecutive strikes — if we can't verify protection at all, the order must go.
      expect(second.openOrders).toEqual([]);
      expect(venue.canceledIds).toEqual(['old-maker']);
      expect(store.listRecentEvents(10).find((event) => event.type === 'quote.replace-cancel')?.details).toMatchObject({
        ids: ['old-maker'],
        reasons: [
          expect.objectContaining({
            orderId: 'old-maker',
            reason: expect.stringContaining('连续 2 轮不可用')
          })
        ]
      });
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('cancels a managed split SELL order whose current notional is above the configured order size', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config = appConfigSchema.parse({
      liveEnabled: true,
      risk: { orderSizeUsd: 2, maxSingleOrderUsd: 100, maxPositionUsd: 200 },
      strategy: { entryMode: 'split', enforceRewardMinimum: false, replaceThresholdTicks: 1 },
      selectedMarkets: { predict: [market.tokenId], polymarket: [] }
    });
    const venue = new MockVenue();
    const oversized: OpenOrder = {
      ...oldOrder,
      side: 'SELL',
      price: 0.705,
      size: 6.6445,
      externalId: 'oversized-sell'
    };
    const wideBandMarket = {
      ...market,
      rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 60 }
    };
    const desired: OrderIntent = {
      ...desiredIntent,
      market: wideBandMarket,
      side: 'SELL',
      price: 0.705,
      size: 2.8369,
      notionalUsd: 2,
      reward: { optimizer: 'test', score: 10, level: 5, minShares: 100, maxSpreadCents: 60 }
    };
    const wideBook = {
      ...book,
      bids: [{ price: 0.704, size: 1000 }],
      asks: [{ price: 0.705, size: 1000 }]
    };
    try {
      recordManagedOpenOrder(store, oversized);
      const result = await new CancelService(config, venue, store).cancelReplaceableOrders(
        'predict',
        [oversized],
        [desired],
        [wideBandMarket],
        new Map([[market.tokenId, wideBook]])
      );

      expect(result.openOrders).toEqual([]);
      expect(venue.canceledIds).toEqual(['oversized-sell']);
      expect(store.listRecentEvents(10).find((event) => event.type === 'quote.replace-cancel')?.details).toMatchObject({
        ids: ['oversized-sell']
      });
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps managed orders when only the fresh orderbook is temporarily unavailable', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config = appConfigSchema.parse({
      liveEnabled: true,
      strategy: { entryMode: 'split', cancelOutsideReward: true },
      selectedMarkets: { predict: [market.tokenId], polymarket: [] }
    });
    const venue = new MockVenue();
    try {
      recordManagedOpenOrder(store, oldOrder);
      const result = await new CancelService(config, venue, store).cancelReplaceableOrders(
        'predict',
        [oldOrder],
        [],
        [market],
        new Map()
      );

      expect(result.openOrders).toEqual([oldOrder]);
      expect(venue.canceledIds).toEqual([]);
      expect(store.listRecentEvents(10).some((event) => event.type === 'quote.replace-deferred')).toBe(true);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps cash multi-market managed orders when an auto-route cycle has an empty market snapshot', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config = appConfigSchema.parse({
      liveEnabled: true,
      strategy: {
        entryMode: 'cash',
        quoteSide: 'buy',
        autoSelectMarkets: true,
        cancelOutsideReward: true
      },
      risk: { maxMarkets: 20 },
      selectedMarkets: { predict: [], polymarket: [] }
    });
    const venue = new MockVenue();
    try {
      recordManagedOpenOrder(store, oldOrder);
      const result = await new CancelService(config, venue, store).cancelReplaceableOrders(
        'predict',
        [oldOrder],
        [],
        [],
        new Map()
      );

      expect(result.openOrders).toEqual([oldOrder]);
      expect(venue.canceledIds).toEqual([]);
      expect(store.listRecentEvents(10).find((event) => event.type === 'quote.replace-deferred')?.details).toMatchObject({
        reasons: [expect.objectContaining({ reason: expect.stringContaining('路由快照为空') })]
      });
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('cancels a managed reward SELL order when front protection depth disappears', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config = appConfigSchema.parse({
      liveEnabled: true,
      risk: { orderSizeUsd: 5, maxSingleOrderUsd: 100, maxPositionUsd: 200, minDepthUsdPerSide: 1000 },
      strategy: { entryMode: 'split', enforceRewardMinimum: false, replaceThresholdTicks: 10 },
      selectedMarkets: { predict: [market.tokenId], polymarket: [] }
    });
    const venue = new MockVenue();
    const existing: OpenOrder = {
      ...oldOrder,
      side: 'SELL',
      price: 0.56,
      size: 8,
      externalId: 'thin-front-sell'
    };
    const desired: OrderIntent = {
      ...desiredIntent,
      side: 'SELL',
      price: 0.56,
      size: 8,
      notionalUsd: 4.48,
      reward: { optimizer: 'test', score: 10, level: 5, minShares: 10, maxSpreadCents: 6 }
    };
    const thinFrontBook: Orderbook = {
      ...book,
      bids: [{ price: 0.52, size: 3000 }],
      asks: [
        { price: 0.54, size: 10 },
        { price: 0.55, size: 10 },
        { price: 0.56, size: 5000 }
      ]
    };
    try {
      recordManagedOpenOrder(store, existing);
      const result = await new CancelService(config, venue, store).cancelReplaceableOrders(
        'predict',
        [existing],
        [desired],
        [market],
        new Map([[market.tokenId, thinFrontBook]])
      );

      expect(result.openOrders).toEqual([]);
      expect(venue.canceledIds).toEqual(['thin-front-sell']);
      expect(store.listRecentEvents(10).find((event) => event.type === 'quote.replace-cancel')?.details).toMatchObject({
        ids: ['thin-front-sell']
      });
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('cancels the complete split SELL group when one leg loses protection', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config = appConfigSchema.parse({
      liveEnabled: true,
      risk: { orderSizeUsd: 5, maxSingleOrderUsd: 100, maxPositionUsd: 200, minDepthUsdPerSide: 1000 },
      strategy: { entryMode: 'split', enforceRewardMinimum: false, replaceThresholdTicks: 10 },
      selectedMarkets: { predict: [], polymarket: [] }
    });
    const venue = new MockVenue();
    const yesMarket: Market = { ...market, tokenId: 'pair-yes', marketId: 'pair-market', conditionId: 'pair-condition', outcome: 'YES', outcomeCount: 2 };
    const noMarket: Market = { ...market, tokenId: 'pair-no', marketId: 'pair-market', conditionId: 'pair-condition', outcome: 'NO', outcomeCount: 2 };
    const yesOrder: OpenOrder = { ...oldOrder, tokenId: yesMarket.tokenId, side: 'SELL', price: 0.56, size: 8, externalId: 'pair-yes-sell' };
    const noOrder: OpenOrder = { ...oldOrder, tokenId: noMarket.tokenId, side: 'SELL', price: 0.56, size: 8, externalId: 'pair-no-sell' };
    const yesDesired: OrderIntent = {
      ...desiredIntent,
      market: yesMarket,
      tokenId: yesMarket.tokenId,
      side: 'SELL',
      price: 0.56,
      size: 8,
      notionalUsd: 4.48,
      reward: { optimizer: 'test', score: 10, level: 5, minShares: 10, maxSpreadCents: 6 }
    };
    const noDesired: OrderIntent = {
      ...yesDesired,
      market: noMarket,
      tokenId: noMarket.tokenId,
      clientOrderId: 'desired-no-sell'
    };
    const thinFrontBook: Orderbook = {
      ...book,
      tokenId: yesMarket.tokenId,
      bids: [{ price: 0.52, size: 3000 }],
      asks: [
        { price: 0.54, size: 10 },
        { price: 0.55, size: 10 },
        { price: 0.56, size: 5000 }
      ]
    };
    const safeBook: Orderbook = {
      ...book,
      tokenId: noMarket.tokenId,
      bids: [{ price: 0.52, size: 3000 }],
      asks: [
        { price: 0.53, size: 2000 },
        { price: 0.54, size: 2000 },
        { price: 0.56, size: 5000 }
      ]
    };
    try {
      recordManagedOpenOrder(store, yesOrder, yesMarket);
      recordManagedOpenOrder(store, noOrder, noMarket);
      const result = await new CancelService(config, venue, store).cancelReplaceableOrders(
        'predict',
        [yesOrder, noOrder],
        [yesDesired, noDesired],
        [yesMarket, noMarket],
        new Map([
          [yesMarket.tokenId, thinFrontBook],
          [noMarket.tokenId, safeBook]
        ])
      );

      expect(result.openOrders).toEqual([]);
      expect(venue.canceledIds).toEqual(['pair-yes-sell', 'pair-no-sell']);
      expect(store.listRecentEvents(10).find((event) => event.type === 'quote.replace-cancel')?.details).toMatchObject({
        ids: ['pair-yes-sell', 'pair-no-sell']
      });
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('cancels orders when market guard reaches the settlement cancel window', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const closingMarket = { ...market, endTime: new Date(Date.now() + 5 * 60 * 1000).toISOString() };
    const config = appConfigSchema.parse({
      liveEnabled: true,
      risk: {
        settlementNoNewOrdersMs: 30 * 60 * 1000,
        settlementCancelOpenOrdersMs: 10 * 60 * 1000
      }
    });
    const venue = new MockVenue();
    const candidate: MarketRouteCandidate = {
      market: closingMarket,
      side: 'BUY',
      score: 0,
      tradable: false,
      reasons: [],
      riskFlags: ['临近结算'],
      metrics: {
        ppPerHour: 0,
        rewardLevel: 0,
        rewardBandDepthUsd: 0,
        topDepthUsd: 0,
        competitionBand: 'unknown',
        targetOrderUsd: config.risk.orderSizeUsd,
        liquidityUsd: closingMarket.liquidityUsd,
        volume24hUsd: closingMarket.volume24hUsd
      }
    };
    try {
      recordManagedOpenOrder(store, oldOrder);
      const remaining = await new CancelService(config, venue, store).cancelGuardedOrders(
        'predict',
        [oldOrder],
        [candidate],
        [closingMarket]
      );

      expect(remaining).toEqual([]);
      expect(venue.canceledIds).toEqual(['old-maker']);
      const event = store.listRecentEvents(10).find((item) => item.type === 'risk.market-guard.cancel');
      expect(event?.details).toMatchObject({ semantics: cancelSemantics('predict') });
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('cancels managed orders when the market end time becomes unverifiable', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const unknownEndMarket = { ...market, endTime: undefined, endTimeSource: undefined };
    const config = appConfigSchema.parse({
      liveEnabled: true,
      risk: { blockUnknownEndTime: true }
    });
    const venue = new MockVenue();
    const candidate: MarketRouteCandidate = {
      market: unknownEndMarket,
      side: 'BUY',
      score: 0,
      tradable: false,
      reasons: [],
      riskFlags: ['市场没有明确结束/停止下单时间'],
      metrics: {
        ppPerHour: 0,
        rewardLevel: 0,
        rewardBandDepthUsd: 0,
        topDepthUsd: 0,
        competitionBand: 'unknown',
        targetOrderUsd: config.risk.orderSizeUsd,
        liquidityUsd: unknownEndMarket.liquidityUsd,
        volume24hUsd: unknownEndMarket.volume24hUsd
      }
    };
    try {
      recordManagedOpenOrder(store, oldOrder);
      const remaining = await new CancelService(config, venue, store).cancelGuardedOrders(
        'predict',
        [oldOrder],
        [candidate],
        [unknownEndMarket]
      );

      expect(remaining).toEqual([]);
      expect(venue.canceledIds).toEqual(['old-maker']);
      const event = store.listRecentEvents(10).find((item) => item.type === 'risk.market-guard.cancel');
      expect(event?.message).toContain('触发撤单');
      expect(event?.details).toMatchObject({ ids: ['old-maker'], semantics: cancelSemantics('predict') });
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not cancel platform open orders that are not known as this bot orders', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const closingMarket = { ...market, endTime: new Date(Date.now() + 5 * 60 * 1000).toISOString() };
    const config = appConfigSchema.parse({
      liveEnabled: true,
      risk: {
        settlementNoNewOrdersMs: 30 * 60 * 1000,
        settlementCancelOpenOrdersMs: 10 * 60 * 1000
      }
    });
    const venue = new MockVenue();
    const candidate: MarketRouteCandidate = {
      market: closingMarket,
      side: 'BUY',
      score: 0,
      tradable: false,
      reasons: [],
      riskFlags: ['临近结算'],
      metrics: {
        ppPerHour: 0,
        rewardLevel: 0,
        rewardBandDepthUsd: 0,
        topDepthUsd: 0,
        competitionBand: 'unknown',
        targetOrderUsd: config.risk.orderSizeUsd,
        liquidityUsd: closingMarket.liquidityUsd,
        volume24hUsd: closingMarket.volume24hUsd
      }
    };
    try {
      const manualOrder: OpenOrder = { ...oldOrder, externalId: 'external-manual' };
      const remaining = await new CancelService(config, venue, store).cancelGuardedOrders(
        'predict',
        [manualOrder],
        [candidate],
        [closingMarket]
      );

      expect(remaining).toEqual([manualOrder]);
      expect(venue.canceledIds).toEqual([]);
      expect(store.listRecentEvents(10).some((event) => event.type === 'risk.market-guard.cancel')).toBe(false);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function recordManagedOpenOrder(store: StateStore, order: OpenOrder, orderMarket: Market = market): void {
  const intent: OrderIntent = {
    venue: order.venue,
    market: orderMarket,
    tokenId: order.tokenId,
    side: order.side,
    price: order.price,
    size: order.size,
    notionalUsd: Number((order.price * order.size).toFixed(4)),
    postOnly: true,
    liquidity: 'maker',
    reason: 'test-managed-order',
    clientOrderId: `${order.venue}-${order.tokenId}-${order.side}-${order.externalId}-test-managed`
  };
  store.recordPlannedOrder(intent, 'live');
  store.recordOrderResult({ venue: order.venue, clientOrderId: intent.clientOrderId, externalId: order.externalId, status: 'OPEN' });
}
