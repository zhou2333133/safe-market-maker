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
import { QuoteCycleService } from '../src/execution/quote-cycle-service.js';
import type { SignerProvider } from '../src/secrets/signer.js';
import { StateStore } from '../src/store/sqlite.js';
import { HttpError } from '../src/venues/http.js';
import type { VenueAdapter } from '../src/venues/types.js';

const signer: SignerProvider = {
  address: '0x1111111111111111111111111111111111111111',
  async signMessage() {
    return '0xsig';
  },
  async signTypedData() {
    return '0xtyped';
  }
};

const market: Market = {
  venue: 'predict',
  tokenId: 'token-1',
  question: 'Quote cycle?',
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

const baseBook: Orderbook = {
  venue: 'predict',
  tokenId: market.tokenId,
  receivedAt: Date.now(),
  bids: [
    { price: 0.49, size: 1000 },
    { price: 0.48, size: 1000 },
    { price: 0.47, size: 1000 }
  ],
  asks: [
    { price: 0.51, size: 1000 },
    { price: 0.52, size: 1000 },
    { price: 0.53, size: 1000 }
  ]
};

function freshBook(tokenId = market.tokenId): Orderbook {
  return { ...baseBook, tokenId, receivedAt: Date.now() };
}

describe('quote cycle service', () => {
  it('gates, submits, mirrors open orders, and records run metrics', async () => {
    await withStore(async (store) => {
      const config = appConfigSchema.parse({
        liveEnabled: true,
        risk: { maxSingleOrderUsd: 100, maxPositionUsd: 200 },
        strategy: { entryMode: 'cash', balanceReserveUsd: 0 }
      });
      const venue = new QuoteCycleVenue();
      const openOrders: OpenOrder[] = [{
        venue: 'predict',
        externalId: 'existing-buy',
        tokenId: market.tokenId,
        side: 'BUY',
        price: 0.49,
        size: 10,
        status: 'OPEN'
      }];
      const sellIntent = intent('SELL', 'sell-ready', 0.51, 10);
      const buyDuplicate = intent('BUY', 'buy-duplicate', 0.49, 10);
      const tooLargeBuy = intent('BUY', 'buy-too-large', 0.49, 500, 'token-2');
      const books = new Map([
        [market.tokenId, freshBook()],
        ['token-2', freshBook('token-2')]
      ]);

      const result = await new QuoteCycleService(config, venue, store).process({
        venue: 'predict',
        signer,
        signerAddress: signer.address,
        dayStart: Date.now() - 60_000,
        intents: [buyDuplicate, sellIntent, tooLargeBuy],
        books,
        balances: [{ asset: 'USDT', available: 100, total: 100 }],
        positions: [{ venue: 'predict', tokenId: market.tokenId, size: 20, notionalUsd: 10 }],
        openOrders
      });

      expect(result).toMatchObject({ accepted: 1, rejected: 1, balanceSkipped: 0 });
      expect(result.openOrders.map((order) => order.externalId)).toEqual(['existing-buy', 'remote-1']);
      expect(venue.createCalls).toBe(1);
      expect(store.getCheckpoint('run.predict')?.value).toMatchObject({
        accepted: 1,
        rejected: 1,
        balanceSkipped: 0
      });
      expect(store.listRecentEvents(10).some((event) => event.type === 'quote.skip-existing')).toBe(true);
      expect(store.listRecentEvents(10).some((event) => event.type === 'risk.reject')).toBe(true);
    });
  });

  it('does not spend stablecoin budget on accepted SELL quotes before later BUY quotes', async () => {
    await withStore(async (store) => {
      const config = appConfigSchema.parse({
        liveEnabled: true,
        risk: { maxSingleOrderUsd: 100, maxPositionUsd: 200 },
        strategy: { entryMode: 'cash', balanceReserveUsd: 0 }
      });
      const venue = new QuoteCycleVenue();
      const sellIntent = intent('SELL', 'sell-first', 0.51, 10);
      const buyIntent = intent('BUY', 'buy-after-sell', 0.49, 10);

      const result = await new QuoteCycleService(config, venue, store).process({
        venue: 'predict',
        signer,
        signerAddress: signer.address,
        dayStart: Date.now() - 60_000,
        intents: [sellIntent, buyIntent],
        books: new Map([[market.tokenId, freshBook()]]),
        balances: [{ asset: 'USDT', available: 4.9, total: 4.9 }],
        positions: [{ venue: 'predict', tokenId: market.tokenId, size: 20, notionalUsd: 10 }],
        openOrders: []
      });

      expect(result).toMatchObject({ accepted: 2, rejected: 0, balanceSkipped: 0 });
      expect(venue.createCalls).toBe(2);
      expect(result.openOrders.map((order) => order.externalId)).toEqual(['remote-1', 'remote-2']);
    });
  });

  it('does not open a second cash token while maxMarkets is occupied', async () => {
    await withStore(async (store) => {
      const config = appConfigSchema.parse({
        liveEnabled: true,
        risk: { maxMarkets: 1, maxSingleOrderUsd: 100, maxPositionUsd: 200 },
        strategy: { entryMode: 'cash', balanceReserveUsd: 0 }
      });
      const venue = new QuoteCycleVenue();
      const existing: OpenOrder = {
        venue: 'predict',
        externalId: 'current-cash-buy',
        tokenId: market.tokenId,
        side: 'BUY',
        price: 0.49,
        size: 10,
        status: 'OPEN'
      };
      const rival = { ...market, tokenId: 'rival-cash-token', marketId: 'rival-cash-token' };
      const existingIntent = intent('BUY', 'keep-existing', 0.49, 10, market.tokenId, market);
      const rivalIntent = intent('BUY', 'must-not-open-rival', 0.49, 10, rival.tokenId, rival);

      const result = await new QuoteCycleService(config, venue, store).process({
        venue: 'predict',
        signer,
        signerAddress: signer.address,
        dayStart: Date.now() - 60_000,
        intents: [existingIntent, rivalIntent],
        books: new Map([
          [market.tokenId, freshBook(market.tokenId)],
          [rival.tokenId, freshBook(rival.tokenId)]
        ]),
        balances: [{ asset: 'USDT', available: 100, total: 100 }],
        positions: [],
        openOrders: [existing]
      });

      expect(result).toMatchObject({ accepted: 0, rejected: 1 });
      expect(venue.createCalls).toBe(0);
      expect(result.openOrders).toEqual([existing]);
      expect(store.listRecentEvents(10).find((event) => event.type === 'risk.reject')?.details).toMatchObject({
        reject: {
          reason_code: 'MAX_MARKETS_LIMIT',
          category: 'risk',
          stage: 'checking-risk'
        },
        activeTokenIds: [market.tokenId],
        maxMarkets: 1
      });
    });
  });

  it('does not consume visible balance budget for unreserved Predict cash maker BUY orders below twenty markets', async () => {
    await withStore(async (store) => {
      const config = appConfigSchema.parse({
        liveEnabled: true,
        risk: { maxMarkets: 10, maxSingleOrderUsd: 100, maxPositionUsd: 200 },
        strategy: { entryMode: 'cash', balanceReserveUsd: 0 }
      });
      const venue = new QuoteCycleVenue();
      const firstMarket = { ...market, tokenId: 'cash-token-1', marketId: 'cash-market-1' };
      const secondMarket = { ...market, tokenId: 'cash-token-2', marketId: 'cash-market-2' };
      const firstIntent = intent('BUY', 'cash-first', 0.49, 10, firstMarket.tokenId, firstMarket);
      const secondIntent = intent('BUY', 'cash-second', 0.49, 10, secondMarket.tokenId, secondMarket);

      const result = await new QuoteCycleService(config, venue, store).process({
        venue: 'predict',
        signer,
        signerAddress: signer.address,
        dayStart: Date.now() - 60_000,
        intents: [firstIntent, secondIntent],
        books: new Map([
          [firstMarket.tokenId, freshBook(firstMarket.tokenId)],
          [secondMarket.tokenId, freshBook(secondMarket.tokenId)]
        ]),
        balances: [{ asset: 'USDT', available: 5, total: 5 }],
        positions: [],
        openOrders: []
      });

      expect(result).toMatchObject({ accepted: 2, rejected: 0, balanceSkipped: 0 });
      expect(venue.createCalls).toBe(2);
      expect(result.openOrders.map((order) => order.externalId)).toEqual(['remote-1', 'remote-2']);
      expect(store.listRecentEvents(10).some((event) => event.type === 'risk.balance-skip')).toBe(false);
    });
  });

  it('stops a split SELL pair and rolls back when a submitted leg cannot be verified open', async () => {
    await withStore(async (store) => {
      const config = appConfigSchema.parse({
        liveEnabled: true,
        risk: { orderSizeUsd: 5, maxSingleOrderUsd: 100, maxPositionUsd: 200 },
        strategy: {
          entryMode: 'split',
          balanceReserveUsd: 0,
          enforceRewardMinimum: false,
          minMarketLiquidityUsd: 0,
          minRewardLevel: 0
        }
      });
      const venue = new QuoteCycleVenue();
      venue.mutateCreatedOrder = (order) => ({ ...order, price: 0.49 });
      const yes = { ...market, tokenId: 'token-yes', marketId: 'market-pair', conditionId: 'condition-pair', outcome: 'YES' };
      const no = { ...market, tokenId: 'token-no', marketId: 'market-pair', conditionId: 'condition-pair', outcome: 'NO' };
      const yesIntent = intent('SELL', 'sell-yes', 0.51, 9, yes.tokenId, yes);
      const noIntent = intent('SELL', 'sell-no', 0.51, 9, no.tokenId, no);

      const result = await new QuoteCycleService(config, venue, store).process({
        venue: 'predict',
        signer,
        signerAddress: signer.address,
        dayStart: Date.now() - 60_000,
        intents: [yesIntent, noIntent],
        books: new Map([
          [yes.tokenId, freshBook(yes.tokenId)],
          [no.tokenId, freshBook(no.tokenId)]
        ]),
        balances: [{ asset: 'USDT', available: 100, total: 100 }],
        positions: [
          { venue: 'predict', tokenId: yes.tokenId, size: 20, notionalUsd: 10 },
          { venue: 'predict', tokenId: no.tokenId, size: 20, notionalUsd: 10 }
        ],
        openOrders: []
      });

      expect(result.accepted).toBe(0);
      expect(result.rejected).toBe(1);
      expect(result.openOrders).toEqual([]);
      expect(venue.createCalls).toBe(2);
      expect(venue.canceledIds).toEqual(['remote-1', 'remote-2']);
      expect(store.listRecentEvents(10).some((event) => event.type === 'split.pair-submit-unverified')).toBe(true);
    });
  });

  it('waits for delayed platform visibility before accepting a split SELL pair', async () => {
    await withStore(async (store) => {
      const config = appConfigSchema.parse({
        liveEnabled: true,
        risk: { orderSizeUsd: 5, maxSingleOrderUsd: 100, maxPositionUsd: 200 },
        strategy: {
          entryMode: 'split',
          balanceReserveUsd: 0,
          enforceRewardMinimum: false,
          minMarketLiquidityUsd: 0,
          minRewardLevel: 0
        }
      });
      const venue = new QuoteCycleVenue();
      venue.openOrderVisibilityLag = 2;
      const yes = { ...market, tokenId: 'token-yes', marketId: 'market-pair', conditionId: 'condition-pair', outcome: 'YES', outcomeCount: 2 };
      const no = { ...market, tokenId: 'token-no', marketId: 'market-pair', conditionId: 'condition-pair', outcome: 'NO', outcomeCount: 2 };
      const yesIntent = intent('SELL', 'sell-yes', 0.51, 9, yes.tokenId, yes);
      const noIntent = intent('SELL', 'sell-no', 0.51, 9, no.tokenId, no);

      const result = await new QuoteCycleService(config, venue, store).process({
        venue: 'predict',
        signer,
        signerAddress: signer.address,
        dayStart: Date.now() - 60_000,
        intents: [yesIntent, noIntent],
        books: new Map([
          [yes.tokenId, freshBook(yes.tokenId)],
          [no.tokenId, freshBook(no.tokenId)]
        ]),
        balances: [{ asset: 'USDT', available: 100, total: 100 }],
        positions: [
          { venue: 'predict', tokenId: yes.tokenId, size: 20, notionalUsd: 10 },
          { venue: 'predict', tokenId: no.tokenId, size: 20, notionalUsd: 10 }
        ],
        openOrders: []
      });

      expect(result.accepted).toBe(2);
      expect(result.rejected).toBe(0);
      expect(venue.createCalls).toBe(2);
      expect(venue.openOrderReadCalls).toBeGreaterThan(2);
      expect(result.openOrders.map((order) => order.externalId)).toEqual(['remote-1', 'remote-2']);
      expect(store.listRecentOrders(5).filter((order) => order.status === 'OPEN')).toHaveLength(2);
      expect(store.listRecentEvents(10).some((event) => event.type === 'split.pair-submit-verified')).toBe(true);
      expect(store.listRecentEvents(10).some((event) => event.type === 'split.pair-submit-unverified')).toBe(false);
    });
  });

  it('keeps a fully submitted split SELL pair pending when one leg is delayed in the open-order API', async () => {
    await withStore(async (store) => {
      const config = appConfigSchema.parse({
        liveEnabled: true,
        risk: { orderSizeUsd: 5, maxSingleOrderUsd: 100, maxPositionUsd: 200 },
        strategy: {
          entryMode: 'split',
          balanceReserveUsd: 0,
          enforceRewardMinimum: false,
          minMarketLiquidityUsd: 0,
          minRewardLevel: 0
        }
      });
      const venue = new QuoteCycleVenue();
      venue.hiddenOpenOrderIds.add('remote-2');
      const yes = { ...market, tokenId: 'token-yes', marketId: 'market-pair', conditionId: 'condition-pair', outcome: 'YES', outcomeCount: 2 };
      const no = { ...market, tokenId: 'token-no', marketId: 'market-pair', conditionId: 'condition-pair', outcome: 'NO', outcomeCount: 2 };
      const yesIntent = intent('SELL', 'sell-yes', 0.51, 9, yes.tokenId, yes);
      const noIntent = intent('SELL', 'sell-no', 0.51, 9, no.tokenId, no);

      const result = await new QuoteCycleService(config, venue, store, { postSubmitGroupVerifyTimeoutMs: 1 }).process({
        venue: 'predict',
        signer,
        signerAddress: signer.address,
        dayStart: Date.now() - 60_000,
        intents: [yesIntent, noIntent],
        books: new Map([
          [yes.tokenId, freshBook(yes.tokenId)],
          [no.tokenId, freshBook(no.tokenId)]
        ]),
        balances: [{ asset: 'USDT', available: 100, total: 100 }],
        positions: [
          { venue: 'predict', tokenId: yes.tokenId, size: 20, notionalUsd: 10 },
          { venue: 'predict', tokenId: no.tokenId, size: 20, notionalUsd: 10 }
        ],
        openOrders: []
      });

      expect(result.accepted).toBe(0);
      expect(result.rejected).toBe(0);
      expect(venue.createCalls).toBe(2);
      expect(venue.canceledIds).toEqual([]);
      expect(result.openOrders).toEqual([
        expect.objectContaining({ externalId: 'remote-1', tokenId: yes.tokenId, status: 'OPEN' }),
        expect.objectContaining({ externalId: 'remote-2', tokenId: no.tokenId, status: 'PENDING_OPEN' })
      ]);
      expect(store.listRecentOrders(5).filter((order) => order.status === 'OPEN')).toHaveLength(1);
      expect(store.listRecentOrders(5).filter((order) => order.status === 'PENDING_OPEN')).toHaveLength(1);
      expect(store.listRecentEvents(10).some((event) => event.type === 'split.pair-submit-pending-confirmation')).toBe(true);
      expect(store.listRecentEvents(10).some((event) => event.type === 'split.pair-submit-unverified')).toBe(false);
    });
  });

  it('cancels an existing split SELL leg when the paired leg is rejected', async () => {
    await withStore(async (store) => {
      const config = appConfigSchema.parse({
        liveEnabled: true,
        risk: { maxSingleOrderUsd: 100, maxPositionUsd: 200 },
        strategy: {
          entryMode: 'split',
          balanceReserveUsd: 0,
          enforceRewardMinimum: false,
          minMarketLiquidityUsd: 0,
          minRewardLevel: 0
        }
      });
      const venue = new QuoteCycleVenue();
      const yes = { ...market, tokenId: 'token-yes', marketId: 'market-pair', conditionId: 'condition-pair', outcome: 'YES', outcomeCount: 2 };
      const no = { ...market, tokenId: 'token-no', marketId: 'market-pair', conditionId: 'condition-pair', outcome: 'NO', outcomeCount: 2 };
      const existingYes: OpenOrder = {
        venue: 'predict',
        externalId: 'existing-yes-sell',
        tokenId: yes.tokenId,
        side: 'SELL',
        price: 0.51,
        size: 10,
        status: 'OPEN'
      };
      recordManagedOpenOrder(store, existingYes, yes);
      const yesIntent = intent('SELL', 'sell-yes', 0.51, 10, yes.tokenId, yes);
      const noIntent = intent('SELL', 'sell-no-insufficient-inventory', 0.51, 10, no.tokenId, no);

      const result = await new QuoteCycleService(config, venue, store).process({
        venue: 'predict',
        signer,
        signerAddress: signer.address,
        dayStart: Date.now() - 60_000,
        intents: [yesIntent, noIntent],
        books: new Map([
          [yes.tokenId, freshBook(yes.tokenId)],
          [no.tokenId, freshBook(no.tokenId)]
        ]),
        balances: [{ asset: 'USDT', available: 100, total: 100 }],
        positions: [
          { venue: 'predict', tokenId: yes.tokenId, size: 20, notionalUsd: 10 },
          { venue: 'predict', tokenId: no.tokenId, size: 2, notionalUsd: 1 }
        ],
        openOrders: [existingYes]
      });

      expect(result.accepted).toBe(0);
      expect(result.rejected).toBe(1);
      expect(result.openOrders).toEqual([]);
      expect(venue.createCalls).toBe(0);
      expect(venue.canceledIds).toEqual(['existing-yes-sell']);
      expect(store.listRecentEvents(10).some((event) => event.type === 'split.pair-incomplete-cancel')).toBe(true);
    });
  });

  it('keeps an existing complete split SELL group instead of canceling it as incomplete', async () => {
    await withStore(async (store) => {
      const config = appConfigSchema.parse({
        liveEnabled: true,
        risk: { maxSingleOrderUsd: 100, maxPositionUsd: 200 },
        strategy: {
          entryMode: 'split',
          balanceReserveUsd: 0,
          enforceRewardMinimum: false,
          minMarketLiquidityUsd: 0,
          minRewardLevel: 0
        }
      });
      const venue = new QuoteCycleVenue();
      const yes = { ...market, tokenId: 'token-yes', marketId: 'market-pair', conditionId: 'condition-pair', outcome: 'YES', outcomeCount: 2 };
      const no = { ...market, tokenId: 'token-no', marketId: 'market-pair', conditionId: 'condition-pair', outcome: 'NO', outcomeCount: 2 };
      const existingYes: OpenOrder = {
        venue: 'predict',
        externalId: 'existing-yes-sell',
        tokenId: yes.tokenId,
        side: 'SELL',
        price: 0.51,
        size: 10,
        status: 'OPEN'
      };
      const existingNo: OpenOrder = {
        venue: 'predict',
        externalId: 'existing-no-sell',
        tokenId: no.tokenId,
        side: 'SELL',
        price: 0.51,
        size: 10,
        status: 'OPEN'
      };
      recordManagedOpenOrder(store, existingYes, yes);
      recordManagedOpenOrder(store, existingNo, no);
      const yesIntent = intent('SELL', 'sell-yes', 0.51, 10, yes.tokenId, yes);
      const noIntent = intent('SELL', 'sell-no', 0.51, 10, no.tokenId, no);

      const result = await new QuoteCycleService(config, venue, store).process({
        venue: 'predict',
        signer,
        signerAddress: signer.address,
        dayStart: Date.now() - 60_000,
        intents: [yesIntent, noIntent],
        books: new Map([
          [yes.tokenId, freshBook(yes.tokenId)],
          [no.tokenId, freshBook(no.tokenId)]
        ]),
        balances: [{ asset: 'USDT', available: 100, total: 100 }],
        positions: [
          { venue: 'predict', tokenId: yes.tokenId, size: 20, notionalUsd: 10 },
          { venue: 'predict', tokenId: no.tokenId, size: 20, notionalUsd: 10 }
        ],
        openOrders: [existingYes, existingNo]
      });

      expect(result.accepted).toBe(0);
      expect(result.rejected).toBe(0);
      expect(result.openOrders).toEqual([existingYes, existingNo]);
      expect(venue.createCalls).toBe(0);
      expect(venue.canceledIds).toEqual([]);
      expect(store.listRecentEvents(10).some((event) => event.type === 'split.pair-incomplete-cancel')).toBe(false);
    });
  });

  it('cancels an existing complete split SELL group when its notional exceeds the current order-size budget', async () => {
    await withStore(async (store) => {
      const config = appConfigSchema.parse({
        liveEnabled: true,
        risk: { orderSizeUsd: 2, maxSingleOrderUsd: 100, maxPositionUsd: 200 },
        strategy: {
          entryMode: 'split',
          balanceReserveUsd: 0,
          enforceRewardMinimum: false,
          minMarketLiquidityUsd: 0,
          minRewardLevel: 0
        }
      });
      const venue = new QuoteCycleVenue();
      const yes = { ...market, tokenId: 'token-yes', marketId: 'market-pair', conditionId: 'condition-pair', outcome: 'YES', outcomeCount: 2 };
      const no = { ...market, tokenId: 'token-no', marketId: 'market-pair', conditionId: 'condition-pair', outcome: 'NO', outcomeCount: 2 };
      const existingYes: OpenOrder = {
        venue: 'predict',
        externalId: 'existing-yes-sell',
        tokenId: yes.tokenId,
        side: 'SELL',
        price: 0.301,
        size: 6.6445,
        status: 'OPEN'
      };
      const existingNo: OpenOrder = {
        venue: 'predict',
        externalId: 'existing-no-sell',
        tokenId: no.tokenId,
        side: 'SELL',
        price: 0.705,
        size: 6.6445,
        status: 'OPEN'
      };
      recordManagedOpenOrder(store, existingYes, yes);
      recordManagedOpenOrder(store, existingNo, no);
      const yesIntent = intent('SELL', 'sell-yes-capped', 0.301, 2.8369, yes.tokenId, yes);
      const noIntent = intent('SELL', 'sell-no-capped', 0.705, 2.8369, no.tokenId, no);

      const result = await new QuoteCycleService(config, venue, store).process({
        venue: 'predict',
        signer,
        signerAddress: signer.address,
        dayStart: Date.now() - 60_000,
        intents: [yesIntent, noIntent],
        books: new Map([
          [yes.tokenId, { ...freshBook(yes.tokenId), bids: [{ price: 0.3, size: 1000 }], asks: [{ price: 0.301, size: 1000 }] }],
          [no.tokenId, { ...freshBook(no.tokenId), bids: [{ price: 0.704, size: 1000 }], asks: [{ price: 0.705, size: 1000 }] }]
        ]),
        balances: [{ asset: 'USDT', available: 100, total: 100 }],
        positions: [
          { venue: 'predict', tokenId: yes.tokenId, size: 20, notionalUsd: 6 },
          { venue: 'predict', tokenId: no.tokenId, size: 20, notionalUsd: 14 }
        ],
        openOrders: [existingYes, existingNo]
      });

      expect(result.accepted).toBe(0);
      expect(result.rejected).toBe(0);
      expect(result.openOrders).toEqual([]);
      expect(venue.createCalls).toBe(0);
      expect(venue.canceledIds).toEqual(['existing-yes-sell', 'existing-no-sell']);
      expect(store.listRecentEvents(10).some((event) => event.type === 'split.pair-incomplete-cancel')).toBe(true);
    });
  });

  it('caps a split SELL pair by the configured total group budget before submitting', async () => {
    await withStore(async (store) => {
      const config = appConfigSchema.parse({
        liveEnabled: true,
        risk: { orderSizeUsd: 5, maxSingleOrderUsd: 100, maxPositionUsd: 200 },
        strategy: {
          entryMode: 'split',
          balanceReserveUsd: 0,
          enforceRewardMinimum: false,
          minMarketLiquidityUsd: 0,
          minRewardLevel: 0
        }
      });
      const venue = new QuoteCycleVenue();
      const yes = { ...market, tokenId: 'token-yes', marketId: 'market-pair', conditionId: 'condition-pair', outcome: 'YES', outcomeCount: 2 };
      const no = { ...market, tokenId: 'token-no', marketId: 'market-pair', conditionId: 'condition-pair', outcome: 'NO', outcomeCount: 2 };
      const yesIntent = intent('SELL', 'sell-yes', 0.092, 5, yes.tokenId, yes);
      const noIntent = intent('SELL', 'sell-no', 0.913, 5, no.tokenId, no);
      venue.books.set(yes.tokenId, {
        ...freshBook(yes.tokenId),
        bids: [{ price: 0.09, size: 1000 }],
        asks: [{ price: 0.092, size: 1000 }]
      });
      venue.books.set(no.tokenId, {
        ...freshBook(no.tokenId),
        bids: [{ price: 0.911, size: 1000 }],
        asks: [{ price: 0.913, size: 1000 }]
      });

      const result = await new QuoteCycleService(config, venue, store).process({
        venue: 'predict',
        signer,
        signerAddress: signer.address,
        dayStart: Date.now() - 60_000,
        intents: [yesIntent, noIntent],
        books: new Map(venue.books),
        balances: [{ asset: 'USDT', available: 100, total: 100 }],
        positions: [
          { venue: 'predict', tokenId: yes.tokenId, size: 20, notionalUsd: 1.84 },
          { venue: 'predict', tokenId: no.tokenId, size: 20, notionalUsd: 18.26 }
        ],
        openOrders: []
      });

      expect(result.accepted).toBe(2);
      expect(result.rejected).toBe(0);
      expect(venue.createCalls).toBe(2);
      expect(new Set(venue.openOrders.map((order) => order.size))).toEqual(new Set([4.9652]));
      expect(Number(venue.openOrders.reduce((sum, order) => sum + order.price * order.size, 0).toFixed(4))).toBeLessThanOrEqual(5.01);
      expect(venue.openOrders.some((order) => order.size === 5 && order.price > 0.9)).toBe(false);
    });
  });

  it('does not treat one existing split SELL leg plus one new leg as a fully verified pair', async () => {
    await withStore(async (store) => {
      const config = appConfigSchema.parse({
        liveEnabled: true,
        risk: { maxSingleOrderUsd: 100, maxPositionUsd: 200 },
        strategy: {
          entryMode: 'split',
          balanceReserveUsd: 0,
          enforceRewardMinimum: false,
          minMarketLiquidityUsd: 0,
          minRewardLevel: 0
        }
      });
      const venue = new QuoteCycleVenue();
      const yes = { ...market, tokenId: 'token-yes', marketId: 'market-pair', conditionId: 'condition-pair', outcome: 'YES', outcomeCount: 2 };
      const no = { ...market, tokenId: 'token-no', marketId: 'market-pair', conditionId: 'condition-pair', outcome: 'NO', outcomeCount: 2 };
      const existingYes: OpenOrder = {
        venue: 'predict',
        externalId: 'existing-yes-sell',
        tokenId: yes.tokenId,
        side: 'SELL',
        price: 0.51,
        size: 10,
        status: 'OPEN'
      };
      venue.openOrders = [existingYes];
      recordManagedOpenOrder(store, existingYes, yes);
      const yesIntent = intent('SELL', 'sell-yes', 0.51, 10, yes.tokenId, yes);
      const noIntent = intent('SELL', 'sell-no', 0.51, 10, no.tokenId, no);

      const result = await new QuoteCycleService(config, venue, store).process({
        venue: 'predict',
        signer,
        signerAddress: signer.address,
        dayStart: Date.now() - 60_000,
        intents: [yesIntent, noIntent],
        books: new Map([
          [yes.tokenId, freshBook(yes.tokenId)],
          [no.tokenId, freshBook(no.tokenId)]
        ]),
        balances: [{ asset: 'USDT', available: 100, total: 100 }],
        positions: [
          { venue: 'predict', tokenId: yes.tokenId, size: 20, notionalUsd: 10 },
          { venue: 'predict', tokenId: no.tokenId, size: 20, notionalUsd: 10 }
        ],
        openOrders: [existingYes]
      });

      expect(result.accepted).toBe(1);
      expect(result.rejected).toBe(0);
      expect(venue.createCalls).toBe(1);
      expect(result.openOrders.map((order) => order.externalId)).toEqual(['existing-yes-sell', 'remote-1']);
      expect(store.listRecentEvents(10).some((event) => event.type === 'split.pair-submit-verified')).toBe(true);
      expect(store.listRecentEvents(10).find((event) => event.type === 'split.pair-submit-verified')?.message).toContain('2 个订单');
      expect(store.listRecentEvents(10).some((event) => event.type === 'split.pair-incomplete-cancel')).toBe(false);
    });
  });

  it('rejects a split SELL group before submit when final reprice leaves a leg outside the safe price band', async () => {
    await withStore(async (store) => {
      const config = appConfigSchema.parse({
        liveEnabled: true,
        risk: { orderSizeUsd: 5, maxSingleOrderUsd: 100, maxPositionUsd: 200, maxPrice: 0.92 },
        strategy: {
          entryMode: 'split',
          balanceReserveUsd: 0,
          enforceRewardMinimum: false,
          minMarketLiquidityUsd: 0,
          minRewardLevel: 0,
          conservativeDepthLevel: 2,
          retreatTicks: 1
        }
      });
      const venue = new QuoteCycleVenue();
      const yes = { ...market, tokenId: 'token-final-yes', marketId: 'market-final-band', conditionId: 'condition-final-band', outcome: 'YES', outcomeCount: 2 };
      const no = { ...market, tokenId: 'token-final-no', marketId: 'market-final-band', conditionId: 'condition-final-band', outcome: 'NO', outcomeCount: 2 };
      const yesIntent = intent('SELL', 'sell-final-yes', 0.51, 5, yes.tokenId, yes);
      const noIntent = intent('SELL', 'sell-final-no', 0.51, 5, no.tokenId, no);
      venue.books.set(yes.tokenId, {
        ...freshBook(yes.tokenId),
        asks: [{ price: 0.51, size: 1000 }, { price: 0.52, size: 1000 }]
      });
      venue.books.set(no.tokenId, {
        ...freshBook(no.tokenId),
        bids: [{ price: 0.91, size: 1000 }, { price: 0.92, size: 1000 }],
        asks: [{ price: 0.93, size: 1000 }, { price: 0.94, size: 1000 }]
      });

      const result = await new QuoteCycleService(config, venue, store).process({
        venue: 'predict',
        signer,
        signerAddress: signer.address,
        dayStart: Date.now() - 60_000,
        intents: [yesIntent, noIntent],
        books: new Map([
          [yes.tokenId, freshBook(yes.tokenId)],
          [no.tokenId, freshBook(no.tokenId)]
        ]),
        balances: [{ asset: 'USDT', available: 100, total: 100 }],
        positions: [
          { venue: 'predict', tokenId: yes.tokenId, size: 20, notionalUsd: 10 },
          { venue: 'predict', tokenId: no.tokenId, size: 20, notionalUsd: 10 }
        ],
        openOrders: []
      });

      expect(result).toMatchObject({ accepted: 0, rejected: 1 });
      expect(venue.createCalls).toBe(0);
      expect(store.listRecentEvents(10).some((event) => event.type === 'split.pair-final-price-rejected')).toBe(true);
    });
  });

  it('rejects a split SELL group before submit when final reprice is too close to best bid', async () => {
    await withStore(async (store) => {
      const config = appConfigSchema.parse({
        liveEnabled: true,
        risk: { orderSizeUsd: 5, maxSingleOrderUsd: 100, maxPositionUsd: 200 },
        strategy: {
          entryMode: 'split',
          balanceReserveUsd: 0,
          enforceRewardMinimum: false,
          minMarketLiquidityUsd: 0,
          minRewardLevel: 0,
          conservativeDepthLevel: 2,
          retreatTicks: 1
        }
      });
      const venue = new QuoteCycleVenue();
      const yes = { ...market, tokenId: 'token-final-close-yes', marketId: 'market-final-close', conditionId: 'condition-final-close', outcome: 'YES', outcomeCount: 2, rewards: { enabled: true, level: 5, minShares: 10, maxSpreadCents: 1 } };
      const no = { ...market, tokenId: 'token-final-close-no', marketId: 'market-final-close', conditionId: 'condition-final-close', outcome: 'NO', outcomeCount: 2 };
      const yesIntent = intent('SELL', 'sell-final-close-yes', 0.51, 5, yes.tokenId, yes);
      const noIntent = intent('SELL', 'sell-final-close-no', 0.51, 5, no.tokenId, no);
      const finalTooClose: Orderbook = {
        ...freshBook(yes.tokenId),
        bids: [{ price: 0.49, size: 1000 }],
        asks: [{ price: 0.5, size: 1000 }, { price: 0.501, size: 1000 }]
      };
      const safeFinal: Orderbook = {
        ...freshBook(no.tokenId),
        bids: [{ price: 0.49, size: 1000 }],
        asks: [{ price: 0.51, size: 1000 }, { price: 0.52, size: 1000 }]
      };
      venue.books.set(yes.tokenId, finalTooClose);
      venue.books.set(no.tokenId, safeFinal);

      const result = await new QuoteCycleService(config, venue, store).process({
        venue: 'predict',
        signer,
        signerAddress: signer.address,
        dayStart: Date.now() - 60_000,
        intents: [yesIntent, noIntent],
        books: new Map([
          [yes.tokenId, freshBook(yes.tokenId)],
          [no.tokenId, freshBook(no.tokenId)]
        ]),
        balances: [{ asset: 'USDT', available: 100, total: 100 }],
        positions: [
          { venue: 'predict', tokenId: yes.tokenId, size: 20, notionalUsd: 10 },
          { venue: 'predict', tokenId: no.tokenId, size: 20, notionalUsd: 10 }
        ],
        openOrders: []
      });

      expect(result).toMatchObject({ accepted: 0, rejected: 1 });
      expect(venue.createCalls).toBe(0);
      expect(store.listRecentOrders(5)).toEqual([]);
      const event = store.listRecentEvents(10).find((item) => item.type === 'split.pair-final-price-rejected');
      expect(event?.message).toContain('最终重定价');
    });
  });

  it('keeps an existing split SELL leg when a supplemental leg is delayed in the open-order API', async () => {
    await withStore(async (store) => {
      const config = appConfigSchema.parse({
        liveEnabled: true,
        risk: { maxSingleOrderUsd: 100, maxPositionUsd: 200 },
        strategy: {
          entryMode: 'split',
          balanceReserveUsd: 0,
          enforceRewardMinimum: false,
          minMarketLiquidityUsd: 0,
          minRewardLevel: 0
        }
      });
      const venue = new QuoteCycleVenue();
      venue.hiddenOpenOrderIds.add('remote-1');
      const yes = { ...market, tokenId: 'token-yes', marketId: 'market-pair', conditionId: 'condition-pair', outcome: 'YES', outcomeCount: 2 };
      const no = { ...market, tokenId: 'token-no', marketId: 'market-pair', conditionId: 'condition-pair', outcome: 'NO', outcomeCount: 2 };
      const existingYes: OpenOrder = {
        venue: 'predict',
        externalId: 'existing-yes-sell',
        tokenId: yes.tokenId,
        side: 'SELL',
        price: 0.51,
        size: 10,
        status: 'OPEN'
      };
      venue.openOrders = [existingYes];
      recordManagedOpenOrder(store, existingYes, yes);
      const yesIntent = intent('SELL', 'sell-yes', 0.51, 10, yes.tokenId, yes);
      const noIntent = intent('SELL', 'sell-no', 0.51, 10, no.tokenId, no);

      const result = await new QuoteCycleService(config, venue, store, { postSubmitGroupVerifyTimeoutMs: 1 }).process({
        venue: 'predict',
        signer,
        signerAddress: signer.address,
        dayStart: Date.now() - 60_000,
        intents: [yesIntent, noIntent],
        books: new Map([
          [yes.tokenId, freshBook(yes.tokenId)],
          [no.tokenId, freshBook(no.tokenId)]
        ]),
        balances: [{ asset: 'USDT', available: 100, total: 100 }],
        positions: [
          { venue: 'predict', tokenId: yes.tokenId, size: 20, notionalUsd: 10 },
          { venue: 'predict', tokenId: no.tokenId, size: 20, notionalUsd: 10 }
        ],
        openOrders: [existingYes]
      });

      expect(result.accepted).toBe(0);
      expect(result.rejected).toBe(0);
      expect(venue.createCalls).toBe(1);
      expect(venue.canceledIds).toEqual([]);
      expect(result.openOrders).toEqual([
        existingYes,
        expect.objectContaining({ externalId: 'remote-1', tokenId: no.tokenId, status: 'PENDING_OPEN' })
      ]);
      expect(store.listRecentEvents(10).some((event) => event.type === 'split.pair-submit-pending-confirmation')).toBe(true);
      expect(store.listRecentEvents(10).some((event) => event.type === 'split.pair-incomplete-cancel')).toBe(false);
    });
  });

  it('does not treat a pending split SELL leg as a complete existing pair on the next cycle', async () => {
    await withStore(async (store) => {
      const config = appConfigSchema.parse({
        liveEnabled: true,
        risk: { maxSingleOrderUsd: 100, maxPositionUsd: 200 },
        strategy: {
          entryMode: 'split',
          balanceReserveUsd: 0,
          enforceRewardMinimum: false,
          minMarketLiquidityUsd: 0,
          minRewardLevel: 0
        }
      });
      const venue = new QuoteCycleVenue();
      const yes = { ...market, tokenId: 'token-yes', marketId: 'market-pair', conditionId: 'condition-pair', outcome: 'YES', outcomeCount: 2 };
      const no = { ...market, tokenId: 'token-no', marketId: 'market-pair', conditionId: 'condition-pair', outcome: 'NO', outcomeCount: 2 };
      const existingYes: OpenOrder = {
        venue: 'predict',
        externalId: 'existing-yes-sell',
        tokenId: yes.tokenId,
        side: 'SELL',
        price: 0.51,
        size: 10,
        status: 'OPEN'
      };
      const pendingNo: OpenOrder = {
        venue: 'predict',
        externalId: 'pending-no-sell',
        tokenId: no.tokenId,
        side: 'SELL',
        price: 0.51,
        size: 10,
        status: 'PENDING_OPEN'
      };
      venue.openOrders = [existingYes];
      recordManagedOpenOrder(store, existingYes, yes);
      recordManagedOpenOrder(store, pendingNo, no, 'PENDING_OPEN');
      const yesIntent = intent('SELL', 'sell-yes', 0.51, 10, yes.tokenId, yes);
      const noIntent = intent('SELL', 'sell-no', 0.51, 10, no.tokenId, no);

      const result = await new QuoteCycleService(config, venue, store).process({
        venue: 'predict',
        signer,
        signerAddress: signer.address,
        dayStart: Date.now() - 60_000,
        intents: [yesIntent, noIntent],
        books: new Map([
          [yes.tokenId, freshBook(yes.tokenId)],
          [no.tokenId, freshBook(no.tokenId)]
        ]),
        balances: [{ asset: 'USDT', available: 100, total: 100 }],
        positions: [
          { venue: 'predict', tokenId: yes.tokenId, size: 20, notionalUsd: 10 },
          { venue: 'predict', tokenId: no.tokenId, size: 20, notionalUsd: 10 }
        ],
        openOrders: [existingYes, pendingNo]
      });

      expect(result.accepted).toBe(1);
      expect(result.rejected).toBe(0);
      expect(venue.createCalls).toBe(1);
      expect(venue.openOrders.map((order) => order.tokenId)).toEqual([yes.tokenId, no.tokenId]);
      expect(store.listRecentEvents(10).find((event) => event.type === 'quote.skip-existing')?.details).toMatchObject({
        existingOrder: 'existing-yes-sell'
      });
      expect(store.listRecentEvents(10).some((event) => event.type === 'split.pair-submit-verified')).toBe(true);
    });
  });

  it('does not cancel unmanaged user SELL orders when a split group is incomplete', async () => {
    await withStore(async (store) => {
      const config = appConfigSchema.parse({
        liveEnabled: true,
        risk: { maxSingleOrderUsd: 100, maxPositionUsd: 200 },
        strategy: {
          entryMode: 'split',
          balanceReserveUsd: 0,
          enforceRewardMinimum: false,
          minMarketLiquidityUsd: 0,
          minRewardLevel: 0
        }
      });
      const venue = new QuoteCycleVenue();
      const yes = { ...market, tokenId: 'token-yes', marketId: 'market-pair', conditionId: 'condition-pair', outcome: 'YES', outcomeCount: 2 };
      const no = { ...market, tokenId: 'token-no', marketId: 'market-pair', conditionId: 'condition-pair', outcome: 'NO', outcomeCount: 2 };
      const unmanagedYes: OpenOrder = {
        venue: 'predict',
        externalId: 'user-yes-sell',
        tokenId: yes.tokenId,
        side: 'SELL',
        price: 0.51,
        size: 10,
        status: 'OPEN'
      };
      const yesIntent = intent('SELL', 'sell-yes', 0.51, 10, yes.tokenId, yes);
      const noIntent = intent('SELL', 'sell-no-insufficient-inventory', 0.51, 10, no.tokenId, no);

      const result = await new QuoteCycleService(config, venue, store).process({
        venue: 'predict',
        signer,
        signerAddress: signer.address,
        dayStart: Date.now() - 60_000,
        intents: [yesIntent, noIntent],
        books: new Map([
          [yes.tokenId, freshBook(yes.tokenId)],
          [no.tokenId, freshBook(no.tokenId)]
        ]),
        balances: [{ asset: 'USDT', available: 100, total: 100 }],
        positions: [
          { venue: 'predict', tokenId: yes.tokenId, size: 20, notionalUsd: 10 },
          { venue: 'predict', tokenId: no.tokenId, size: 2, notionalUsd: 1 }
        ],
        openOrders: [unmanagedYes]
      });

      expect(result.accepted).toBe(0);
      expect(result.rejected).toBe(1);
      expect(result.openOrders).toEqual([unmanagedYes]);
      expect(venue.createCalls).toBe(0);
      expect(venue.canceledIds).toEqual([]);
    });
  });

  it('treats a split pair submit HTTP 400 as an order-level rejection instead of throwing out of the live loop', async () => {
    await withStore(async (store) => {
      const config = appConfigSchema.parse({
        liveEnabled: true,
        risk: { maxSingleOrderUsd: 100, maxPositionUsd: 200 },
        strategy: {
          entryMode: 'split',
          balanceReserveUsd: 0,
          enforceRewardMinimum: false,
          minMarketLiquidityUsd: 0,
          minRewardLevel: 0
        }
      });
      const venue = new QuoteCycleVenue();
      venue.createOrderError = new HttpError('HTTP 400 for https://api.predict.fun/v1/orders', 400, { error: 'bad request' });
      const yes = { ...market, tokenId: 'token-yes', marketId: 'market-pair', conditionId: 'condition-pair', outcome: 'YES', outcomeCount: 2 };
      const no = { ...market, tokenId: 'token-no', marketId: 'market-pair', conditionId: 'condition-pair', outcome: 'NO', outcomeCount: 2 };
      const yesIntent = intent('SELL', 'sell-yes', 0.51, 10, yes.tokenId, yes);
      const noIntent = intent('SELL', 'sell-no', 0.51, 10, no.tokenId, no);

      const result = await new QuoteCycleService(config, venue, store).process({
        venue: 'predict',
        signer,
        signerAddress: signer.address,
        dayStart: Date.now() - 60_000,
        intents: [yesIntent, noIntent],
        books: new Map([
          [yes.tokenId, freshBook(yes.tokenId)],
          [no.tokenId, freshBook(no.tokenId)]
        ]),
        balances: [{ asset: 'USDT', available: 100, total: 100 }],
        positions: [
          { venue: 'predict', tokenId: yes.tokenId, size: 20, notionalUsd: 10 },
          { venue: 'predict', tokenId: no.tokenId, size: 20, notionalUsd: 10 }
        ],
        openOrders: []
      });

      expect(result).toMatchObject({ accepted: 0, rejected: 1 });
      expect(result.openOrders).toEqual([]);
      expect(venue.createCalls).toBe(1);
      expect(venue.canceledIds).toEqual([]);
      expect(store.listRecentEvents(10).some((event) => event.type === 'order.submit-error')).toBe(true);
      expect(store.listRecentEvents(10).some((event) => event.type === 'split.pair-submit-rejected')).toBe(true);
      expect(store.getCheckpoint('run.predict')?.value).toMatchObject({ accepted: 0, rejected: 1 });
    });
  });

  it('treats a cash single-order submit HTTP 400 as an order-level rejection and keeps later orders running', async () => {
    await withStore(async (store) => {
      const config = appConfigSchema.parse({
        liveEnabled: true,
        risk: { maxMarkets: 20, maxSingleOrderUsd: 100, maxPositionUsd: 200 },
        strategy: {
          entryMode: 'cash',
          balanceReserveUsd: 0,
          minMarketLiquidityUsd: 0,
          minRewardLevel: 0
        }
      });
      const venue = new QuoteCycleVenue();
      venue.createOrderErrors.set('cash-rejected', new HttpError('HTTP 400 for https://api.predict.fun/v1/orders', 400, { error: 'bad request' }));
      const rejectedMarket = { ...market, tokenId: 'cash-rejected-token', marketId: 'cash-rejected-market' };
      const acceptedMarket = { ...market, tokenId: 'cash-accepted-token', marketId: 'cash-accepted-market' };
      const rejectedIntent = intent('BUY', 'cash-rejected', 0.49, 10, rejectedMarket.tokenId, rejectedMarket);
      const acceptedIntent = intent('BUY', 'cash-accepted', 0.49, 10, acceptedMarket.tokenId, acceptedMarket);

      const result = await new QuoteCycleService(config, venue, store).process({
        venue: 'predict',
        signer,
        signerAddress: signer.address,
        dayStart: Date.now() - 60_000,
        intents: [rejectedIntent, acceptedIntent],
        books: new Map([
          [rejectedMarket.tokenId, freshBook(rejectedMarket.tokenId)],
          [acceptedMarket.tokenId, freshBook(acceptedMarket.tokenId)]
        ]),
        balances: [{ asset: 'USDT', available: 100, total: 100 }],
        positions: [],
        openOrders: []
      });

      expect(result).toMatchObject({ accepted: 1, rejected: 1, balanceSkipped: 0 });
      expect(result.openOrders.map((order) => order.externalId)).toEqual(['remote-2']);
      expect(venue.createCalls).toBe(2);
      const submitError = store.listRecentEvents(20).find((event) => event.type === 'order.submit-error');
      expect(submitError?.details).toMatchObject({
        httpStatus: 400,
        httpBody: { error: 'bad request' }
      });
      expect(store.listRecentEvents(20).some((event) => event.type === 'order.submit-rejected')).toBe(true);
      expect(store.getCheckpoint('run.predict')?.value).toMatchObject({ accepted: 1, rejected: 1 });
    });
  });
});

class QuoteCycleVenue implements VenueAdapter {
  readonly name: VenueName = 'predict';
  createCalls = 0;
  canceledIds: string[] = [];
  openOrders: OpenOrder[] = [];
  books = new Map<string, Orderbook>();
  verifySubmittedOrders = true;
  openOrderVisibilityLag = 0;
  openOrderReadCalls = 0;
  hiddenOpenOrderIds = new Set<string>();
  mutateCreatedOrder?: (order: OpenOrder) => OpenOrder;
  createOrderError?: Error;
  createOrderErrors = new Map<string, Error>();

  async testConnection(): Promise<boolean> {
    return true;
  }

  async getMarkets(): Promise<Market[]> {
    return [market];
  }

  async getOrderbook(tokenId: string): Promise<Orderbook> {
    const configured = this.books.get(tokenId);
    if (configured) return { ...configured, receivedAt: Date.now() };
    return freshBook(tokenId);
  }

  async getBalances(): Promise<Balance[]> {
    return [];
  }

  async getPositions(): Promise<Position[]> {
    return [];
  }

  async getOpenOrders(): Promise<OpenOrder[]> {
    this.openOrderReadCalls += 1;
    if (this.openOrderReadCalls <= this.openOrderVisibilityLag) return [];
    return this.verifySubmittedOrders
      ? this.openOrders.filter((order) => !this.hiddenOpenOrderIds.has(order.externalId))
      : [];
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

  async createOrder(orderIntent: OrderIntent): Promise<OrderResult> {
    this.createCalls += 1;
    const clientOrderError = this.createOrderErrors.get(orderIntent.clientOrderId);
    if (clientOrderError) throw clientOrderError;
    if (this.createOrderError) throw this.createOrderError;
    const order = {
      venue: this.name,
      externalId: `remote-${this.createCalls}`,
      tokenId: orderIntent.tokenId,
      side: orderIntent.side,
      price: orderIntent.price,
      size: orderIntent.size,
      status: 'OPEN',
      raw: { id: `remote-${this.createCalls}` }
    } satisfies OpenOrder;
    this.openOrders.push(this.mutateCreatedOrder ? this.mutateCreatedOrder(order) : order);
    return {
      venue: this.name,
      clientOrderId: orderIntent.clientOrderId,
      externalId: `remote-${this.createCalls}`,
      status: 'OPEN'
    };
  }

  async cancelOrders(orderIds: string[]): Promise<void> {
    this.canceledIds.push(...orderIds);
    this.openOrders = this.openOrders.filter((order) => !orderIds.includes(order.externalId));
  }
}

function intent(side: 'BUY' | 'SELL', clientOrderId: string, price: number, size: number, tokenId = market.tokenId, intentMarket = market): OrderIntent {
  return {
    venue: 'predict',
    market: { ...intentMarket, tokenId },
    tokenId,
    side,
    price,
    size,
    notionalUsd: Number((price * size).toFixed(4)),
    postOnly: true,
    reason: 'quote-cycle-test',
    clientOrderId,
    reward: { optimizer: 'test', score: 10, level: 5, minShares: 10, maxSpreadCents: 6 }
  };
}

function withStore<T>(run: (store: StateStore) => Promise<T> | T): Promise<T> | T {
  const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-quote-cycle-'));
  const store = new StateStore(path.join(dir, 'state.sqlite'));
  try {
    const result = run(store);
    if (result instanceof Promise) {
      return result.finally(() => {
        store.close();
        rmSync(dir, { recursive: true, force: true });
      });
    }
    store.close();
    rmSync(dir, { recursive: true, force: true });
    return result;
  } catch (error) {
    store.close();
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

function recordManagedOpenOrder(store: StateStore, order: OpenOrder, orderMarket: Market, status: OpenOrder['status'] = 'OPEN'): void {
  const managedIntent = intent(order.side, `managed-${order.externalId}`, order.price, order.size, order.tokenId, orderMarket);
  store.recordPlannedOrder(managedIntent, 'live');
  store.recordOrderResult({ venue: order.venue, clientOrderId: managedIntent.clientOrderId, externalId: order.externalId, status });
}

