import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { appConfigSchema } from '../src/config/schema.js';
import type {
  AccountRiskDecision,
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
import { SubmitService } from '../src/execution/submit-service.js';
import type { SignerProvider } from '../src/secrets/signer.js';
import { StateStore } from '../src/store/sqlite.js';
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
  question: 'Submit safely?',
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
    { price: 0.47, size: 1000 }
  ],
  asks: [
    { price: 0.51, size: 1000 },
    { price: 0.52, size: 1000 },
    { price: 0.53, size: 1000 }
  ]
};

const intent: OrderIntent = {
  venue: 'predict',
  market,
  tokenId: market.tokenId,
  side: 'BUY',
  price: 0.49,
  size: 10,
  notionalUsd: 4.9,
  postOnly: true,
  reason: 'test',
  clientOrderId: 'submit-service-test',
  reward: { optimizer: 'test', score: 10, level: 5, minShares: 10, maxSpreadCents: 6 }
};

class MockVenue implements VenueAdapter {
  readonly name: VenueName = 'predict';
  createCalls = 0;
  accountRiskSnapshotCalls = 0;
  freshBook: Orderbook = book;
  submittedIntent?: OrderIntent;
  postSubmitOpenOrders?: OpenOrder[];
  accountRiskSnapshot?: Partial<AccountRiskSnapshot>;
  failFreshBook = false;
  failCreateOrder = false;

  async testConnection(): Promise<boolean> {
    return true;
  }

  async getMarkets(): Promise<Market[]> {
    return [market];
  }

  async getOrderbook(): Promise<Orderbook> {
    if (this.failFreshBook) throw new Error('fresh book unavailable');
    return { ...this.freshBook, receivedAt: Date.now() };
  }

  async getBalances(): Promise<Balance[]> {
    return [];
  }

  async getPositions(): Promise<Position[]> {
    return [];
  }

  async getOpenOrders(): Promise<OpenOrder[]> {
    return this.postSubmitOpenOrders ?? [];
  }

  async getAccountRiskSnapshot(address: string, _signer: SignerProvider, sinceTs: number): Promise<AccountRiskSnapshot> {
    this.accountRiskSnapshotCalls += 1;
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
      warnings: [],
      ...this.accountRiskSnapshot
    };
  }

  async preflight(): Promise<PreflightResult> {
    return { ok: true, venue: this.name, checks: [] };
  }

  async createOrder(orderIntent: OrderIntent): Promise<OrderResult> {
    this.createCalls += 1;
    this.submittedIntent = orderIntent;
    this.postSubmitOpenOrders ??= [{
      venue: this.name,
      externalId: 'remote-submit-1',
      tokenId: orderIntent.tokenId,
      side: orderIntent.side,
      price: orderIntent.price,
      size: orderIntent.size,
      status: 'OPEN',
      raw: { id: 'remote-submit-1' }
    }];
    if (this.failCreateOrder) throw new Error('submit endpoint unavailable');
    return {
      venue: this.name,
      clientOrderId: orderIntent.clientOrderId,
      externalId: 'remote-submit-1',
      status: 'OPEN',
      raw: { status: 'accepted' }
    };
  }

  async cancelOrders(): Promise<void> {
    return undefined;
  }
}

function withStore<T>(run: (store: StateStore) => Promise<T> | T): Promise<T> | T {
  const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-submit-service-'));
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

function okAccountRisk(): AccountRiskDecision {
  return {
    ok: true,
    venue: 'predict',
    reason: 'ok',
    capturedAt: Date.now(),
    maxDailyLossUsd: 100,
    dailyPnlUsd: 0,
    warnings: [],
    message: 'ok'
  };
}

describe('submit service', () => {
  it('records planned order, runs final guards, submits, and returns an open-order mirror', async () => {
    await withStore(async (store) => {
      const config = appConfigSchema.parse({
        liveEnabled: true,
        risk: { maxSingleOrderUsd: 100, maxPositionUsd: 200 },
        strategy: { entryMode: 'cash' }
      });
      const venue = new MockVenue();

      const result = await new SubmitService(config, venue, store).submit({
        venue: 'predict',
        signer,
        intent,
        initialBook: book,
        positions: [],
        openOrders: []
      });

      expect(result).toMatchObject({
        status: 'submitted',
        verifiedOpen: true,
        externalId: 'remote-submit-1',
        openOrder: {
          externalId: 'remote-submit-1',
          tokenId: intent.tokenId,
          side: 'BUY',
          status: 'OPEN'
        }
      });
      expect(venue.createCalls).toBe(1);
      expect(store.listRecentOrders(5)[0]).toMatchObject({ externalId: 'remote-submit-1', status: 'OPEN' });
      expect(store.listRecentEvents(5).some((event) => event.type === 'order.submitted')).toBe(true);
    });
  });

  it('rejects without submitting when the final orderbook jumps', async () => {
    await withStore(async (store) => {
      const config = appConfigSchema.parse({
        liveEnabled: true,
        risk: { maxBboMoveCents: 5, maxSingleOrderUsd: 100, maxPositionUsd: 200 },
        strategy: { entryMode: 'cash' }
      });
      const venue = new MockVenue();
      venue.freshBook = {
        ...book,
        bids: [{ price: 0.78, size: 1000 }, { price: 0.77, size: 1000 }],
        asks: [{ price: 0.82, size: 1000 }, { price: 0.83, size: 1000 }]
      };

      const result = await new SubmitService(config, venue, store).submit({
        venue: 'predict',
        signer,
        intent,
        initialBook: book,
        positions: [],
        openOrders: []
      });

      expect(result).toEqual({ status: 'rejected' });
      expect(venue.createCalls).toBe(0);
      expect(store.status().openOrders).toBe(0);
      expect(store.listRecentOrders(5)[0]).toMatchObject({
        clientOrderId: intent.clientOrderId,
        status: 'REJECTED'
      });
      const event = store.listRecentEvents(5).find((item) => item.type === 'risk.market-guard.final-reject');
      expect(event?.details).toMatchObject({
        reject: {
          reason_code: 'MARKET_PRICE_JUMP',
          category: 'market',
          stage: 'final-orderbook-check'
        }
      });
    });
  });

  it('lets cash reward maker intents reach final fresh-book validation even when the planning book is stale', async () => {
    await withStore(async (store) => {
      const config = appConfigSchema.parse({
        risk: { maxSingleOrderUsd: 100, maxPositionUsd: 200, staleBookMs: 100 },
        strategy: { entryMode: 'cash', quoteSide: 'buy', balanceReserveUsd: 0 }
      });
      const staleBook = { ...book, receivedAt: Date.now() - 10_000 };
      const venue = new MockVenue();
      venue.postSubmitOpenOrders = [{
        venue: 'predict',
        externalId: 'remote-submit-1',
        tokenId: intent.tokenId,
        side: intent.side,
        price: intent.price,
        size: intent.size,
        status: 'OPEN'
      }];
      const result = await new SubmitService(config, venue, store).submit({
        venue: 'predict',
        signer,
        signerAddress: signer.address,
        intent,
        initialBook: staleBook,
        positions: [],
        openOrders: [],
        balances: [{ asset: 'USDT', available: 1000, total: 1000 }],
        accountRiskDecision: okAccountRisk()
      } as any);

      expect(result.status).toBe('submitted');
      expect(venue.createCalls).toBe(1);
    });
  });

  it('reprices reward maker orders from the fresh orderbook immediately before submit', async () => {
    await withStore(async (store) => {
      const config = appConfigSchema.parse({
        liveEnabled: true,
        risk: { orderSizeUsd: 8, maxSingleOrderUsd: 100, maxPositionUsd: 200 },
        strategy: {
          entryMode: 'cash',
          quoteSide: 'buy',
          conservativeDepthLevel: 2,
          retreatTicks: 1,
          enforceRewardMinimum: false,
          inventorySkewEnabled: false
        }
      });
      const venue = new MockVenue();
      venue.freshBook = {
        ...book,
        bids: [
          { price: 0.29, size: 2000 },
          { price: 0.289, size: 2200 },
          { price: 0.288, size: 1900 },
          { price: 0.287, size: 1900 }
        ],
        asks: [
          { price: 0.291, size: 2000 },
          { price: 0.292, size: 2000 }
        ]
      };

      const result = await new SubmitService(config, venue, store).submit({
        venue: 'predict',
        signer,
        intent: {
          ...intent,
          price: 0.288,
          size: 27.7778,
          notionalUsd: 8,
          reward: { optimizer: 'test', score: 10, level: 5, minShares: 10, maxSpreadCents: 6 }
        },
        initialBook: {
          ...book,
          bids: [
            { price: 0.29, size: 2000 },
            { price: 0.289, size: 2200 },
            { price: 0.288, size: 1900 },
            { price: 0.287, size: 1900 }
          ],
          asks: [
            { price: 0.291, size: 2000 },
            { price: 0.292, size: 2000 }
          ]
        },
        positions: [],
        openOrders: []
      });

      expect(result.status).toBe('submitted');
      expect(venue.createCalls).toBe(1);
      expect(venue.submittedIntent?.price).toBe(0.287);
      expect(venue.submittedIntent?.notionalUsd).toBe(8);
      expect(store.listRecentEvents(10).some((event) => event.type === 'quote.final-repriced')).toBe(true);
      expect(store.listRecentOrders(5)[0]).toMatchObject({ externalId: 'remote-submit-1', status: 'OPEN' });
    });
  });

  it('does not mirror a submitted order as confirmed OPEN when platform open-order verification disagrees', async () => {
    await withStore(async (store) => {
      const config = appConfigSchema.parse({
        liveEnabled: true,
        risk: { maxSingleOrderUsd: 100, maxPositionUsd: 200 },
        strategy: { entryMode: 'cash' }
      });
      const venue = new MockVenue();
      venue.postSubmitOpenOrders = [{
        venue: 'predict',
        externalId: 'remote-submit-1',
        tokenId: intent.tokenId,
        side: 'BUY',
        price: 0.48,
        size: 10,
        status: 'OPEN',
        raw: { id: 'remote-submit-1' }
      }];

      const result = await new SubmitService(config, venue, store).submit({
        venue: 'predict',
        signer,
        intent,
        initialBook: book,
        positions: [],
        openOrders: []
      });

      expect(result).toMatchObject({ status: 'submitted', externalId: 'remote-submit-1', verifiedOpen: false });
      expect(store.status().openOrders).toBe(0);
      expect(store.listRecentOrders(5)[0]).toMatchObject({
        clientOrderId: intent.clientOrderId,
        status: 'UNKNOWN'
      });
      expect(store.listRecentEvents(10).some((event) => event.type === 'order.post-submit-unverified')).toBe(true);
    });
  });

  it('accepts small platform size truncation during post-submit verification', async () => {
    await withStore(async (store) => {
      const config = appConfigSchema.parse({
        liveEnabled: true,
        risk: { maxSingleOrderUsd: 100, maxPositionUsd: 200 },
        strategy: { entryMode: 'cash' }
      });
      const venue = new MockVenue();
      const preciseIntent: OrderIntent = {
        ...intent,
        size: 34.4828,
        notionalUsd: intent.price * 34.4828
      };
      venue.postSubmitOpenOrders = [{
        venue: 'predict',
        externalId: 'remote-submit-1',
        tokenId: preciseIntent.tokenId,
        side: preciseIntent.side,
        price: preciseIntent.price,
        size: 34.482,
        status: 'OPEN',
        raw: { id: 'remote-submit-1' }
      }];

      const result = await new SubmitService(config, venue, store).submit({
        venue: 'predict',
        signer,
        intent: preciseIntent,
        initialBook: book,
        positions: [],
        openOrders: [],
        repriceRewardQuote: false
      });

      expect(result).toMatchObject({ status: 'submitted', externalId: 'remote-submit-1', verifiedOpen: true });
      expect(store.status().openOrders).toBe(1);
      expect(store.listRecentOrders(5)[0]).toMatchObject({ externalId: 'remote-submit-1', status: 'OPEN' });
      expect(store.listRecentEvents(10).some((event) => event.type === 'order.post-submit-unverified')).toBe(false);
    });
  });

  it('reprices split SELL reward orders from the fresh orderbook without losing the single leg', async () => {
    await withStore(async (store) => {
      const config = appConfigSchema.parse({
        liveEnabled: true,
        risk: { orderSizeUsd: 8, maxSingleOrderUsd: 100, maxPositionUsd: 200 },
        strategy: {
          entryMode: 'split',
          conservativeDepthLevel: 2,
          retreatTicks: 1,
          enforceRewardMinimum: false,
          inventorySkewEnabled: false,
          minMarketLiquidityUsd: 0,
          minRewardLevel: 0
        }
      });
      const venue = new MockVenue();
      venue.freshBook = {
        ...book,
        bids: [
          { price: 0.284, size: 2000 },
          { price: 0.283, size: 2000 }
        ],
        asks: [
          { price: 0.286, size: 2000 },
          { price: 0.287, size: 2000 },
          { price: 0.288, size: 2000 }
        ]
      };

      const result = await new SubmitService(config, venue, store).submit({
        venue: 'predict',
        signer,
        intent: {
          ...intent,
          side: 'SELL',
          price: 0.289,
          size: 27.6817,
          notionalUsd: 8,
          reward: { optimizer: 'test', score: 10, level: 5, minShares: 10, maxSpreadCents: 6 }
        },
        initialBook: {
          ...book,
          bids: [
            { price: 0.287, size: 2000 },
            { price: 0.286, size: 2000 }
          ],
          asks: [
            { price: 0.289, size: 2000 },
            { price: 0.29, size: 2000 }
          ]
        },
        positions: [{ venue: 'predict', tokenId: market.tokenId, size: 100, notionalUsd: 50 }],
        openOrders: []
      });

      expect(result.status).toBe('submitted');
      expect(venue.createCalls).toBe(1);
      expect(venue.submittedIntent?.price).toBe(0.288);
      expect(venue.submittedIntent?.size).toBe(27.6817);
      expect(venue.submittedIntent?.notionalUsd).toBe(7.9723);
      expect(venue.submittedIntent?.side).toBe('SELL');
      expect(store.listRecentEvents(10).some((event) => event.type === 'quote.final-repriced')).toBe(true);
    });
  });

  it('rejects reward orders when the fresh orderbook can no longer rebuild a safe quote', async () => {
    await withStore(async (store) => {
      const config = appConfigSchema.parse({
        liveEnabled: true,
        risk: { orderSizeUsd: 8, maxSingleOrderUsd: 100, maxPositionUsd: 200 },
        strategy: {
          entryMode: 'split',
          conservativeDepthLevel: 2,
          retreatTicks: 1,
          enforceRewardMinimum: false,
          inventorySkewEnabled: false,
          minMarketLiquidityUsd: 0,
          minRewardLevel: 0
        }
      });
      const venue = new MockVenue();
      venue.freshBook = {
        ...book,
        bids: [
          { price: 0.49, size: 2000 },
          { price: 0.489, size: 2000 }
        ],
        asks: []
      };

      const result = await new SubmitService(config, venue, store).submit({
        venue: 'predict',
        signer,
        intent: {
          ...intent,
          side: 'SELL',
          price: 0.514,
          size: 15.5642,
          notionalUsd: 8,
          reward: { optimizer: 'test', score: 10, level: 5, minShares: 10, maxSpreadCents: 6 }
        },
        initialBook: {
          ...book,
          bids: [
            { price: 0.489, size: 2500 },
            { price: 0.488, size: 2500 }
          ],
          asks: [
            { price: 0.512, size: 20 },
            { price: 0.513, size: 2400 },
            { price: 0.514, size: 1700 }
          ]
        },
        positions: [{ venue: 'predict', tokenId: market.tokenId, size: 100, notionalUsd: 50 }],
        openOrders: []
      });

      expect(result).toEqual({ status: 'rejected' });
      expect(venue.createCalls).toBe(0);
      expect(store.listRecentOrders(5)[0]).toMatchObject({
        clientOrderId: intent.clientOrderId,
        status: 'REJECTED'
      });
      expect(store.listRecentEvents(10).find((event) => event.type === 'risk.final-reject')?.details).toMatchObject({
        reject: {
          reason_code: 'FINAL_REPRICE_UNAVAILABLE',
          category: 'risk',
          stage: 'final-orderbook-check'
        }
      });
    });
  });

  it('rejects without submitting when account risk blocks immediately before submit', async () => {
    await withStore(async (store) => {
      const config = appConfigSchema.parse({
        liveEnabled: true,
        risk: { maxDailyLossUsd: 5, maxSingleOrderUsd: 100, maxPositionUsd: 200 },
        strategy: { entryMode: 'cash' }
      });
      const venue = new MockVenue();
      venue.accountRiskSnapshot = { realizedPnlUsd: -6, unrealizedPnlUsd: 0 };

      const result = await new SubmitService(config, venue, store).submit({
        venue: 'predict',
        signer,
        intent,
        initialBook: book,
        positions: [],
        openOrders: []
      });

      expect(result).toEqual({ status: 'rejected' });
      expect(venue.createCalls).toBe(0);
      expect(store.status().openOrders).toBe(0);
      expect(store.listRecentOrders(5)[0]).toMatchObject({
        clientOrderId: intent.clientOrderId,
        status: 'REJECTED'
      });
      const event = store.listRecentEvents(10).find((item) => item.type === 'risk.submit-blocked');
      expect(event?.details).toMatchObject({
        reject: {
          reason_code: 'ACCOUNT_DAILY_LOSS_LIMIT',
          category: 'account',
          stage: 'submitting'
        }
      });
    });
  });

  it('uses the live session risk window for the final pre-submit account gate', async () => {
    await withStore(async (store) => {
      const config = appConfigSchema.parse({
        liveEnabled: true,
        risk: { maxDailyLossUsd: 10, maxSingleOrderUsd: 100, maxPositionUsd: 200 },
        strategy: { entryMode: 'cash' }
      });
      const venue = new MockVenue();
      store.recordEvent({
        venue: 'predict',
        severity: 'warn',
        type: 'cash-fill.exit-submitted',
        message: 'old exit before this live session',
        details: {
          intent: { tokenId: market.tokenId, side: 'SELL', price: 0.2, size: 100, notionalUsd: 20 },
          position: { tokenId: market.tokenId, marketId: 'market-1', outcome: 'Yes', size: 100, notionalUsd: 35, averagePrice: 0.35 },
          averagePrice: 0.35,
          limitPrice: 0.2
        }
      });
      store.checkpoint('live-session.predict', {
        startedAt: new Date(Date.now() + 5).toISOString(),
        source: 'user-start',
        reason: 'test session start after old loss'
      });

      const result = await new SubmitService(config, venue, store).submit({
        venue: 'predict',
        signer,
        intent,
        initialBook: book,
        positions: [],
        openOrders: []
      });

      expect(result.status).toBe('submitted');
      expect(venue.createCalls).toBe(1);
      expect(store.getLatestAccountRiskDecision('predict')).toMatchObject({
        ok: true,
        reason: 'ok',
        dailyPnlUsd: 0
      });
    });
  });

  it('reuses a fresh account risk decision from the current live cycle before submit', async () => {
    await withStore(async (store) => {
      const config = appConfigSchema.parse({
        liveEnabled: true,
        risk: { maxSingleOrderUsd: 100, maxPositionUsd: 200 },
        strategy: { entryMode: 'cash' }
      });
      const venue = new MockVenue();

      const result = await new SubmitService(config, venue, store).submit({
        venue: 'predict',
        signer,
        intent,
        initialBook: book,
        positions: [],
        openOrders: [],
        accountRiskDecision: {
          ok: true,
          venue: 'predict',
          reason: 'ok',
          capturedAt: Date.now(),
          maxDailyLossUsd: config.risk.maxDailyLossUsd,
          dailyPnlUsd: 0,
          warnings: [],
          message: '账户级日内风控通过'
        }
      });

      expect(result.status).toBe('submitted');
      expect(venue.createCalls).toBe(1);
      expect(venue.accountRiskSnapshotCalls).toBe(0);
    });
  });

  it('marks the planned order rejected when the final orderbook read fails', async () => {
    await withStore(async (store) => {
      const config = appConfigSchema.parse({
        liveEnabled: true,
        risk: { maxSingleOrderUsd: 100, maxPositionUsd: 200 },
        strategy: { entryMode: 'cash' }
      });
      const venue = new MockVenue();
      venue.failFreshBook = true;

      await expect(new SubmitService(config, venue, store).submit({
        venue: 'predict',
        signer,
        intent,
        initialBook: book,
        positions: [],
        openOrders: []
      })).rejects.toThrow('fresh book unavailable');

      expect(venue.createCalls).toBe(0);
      expect(store.status().openOrders).toBe(0);
      expect(store.listRecentOrders(5)[0]).toMatchObject({
        clientOrderId: intent.clientOrderId,
        status: 'REJECTED'
      });
      expect(store.listRecentEvents(5).find((event) => event.type === 'order.submit-error')?.details).toMatchObject({
        reject: {
          reason_code: 'SUBMIT_EXCEPTION',
          category: 'platform',
          stage: 'final-orderbook-check'
        }
      });
    });
  });

  it('marks the planned order unknown when the submit endpoint throws', async () => {
    await withStore(async (store) => {
      const config = appConfigSchema.parse({
        liveEnabled: true,
        risk: { maxSingleOrderUsd: 100, maxPositionUsd: 200 },
        strategy: { entryMode: 'cash' }
      });
      const venue = new MockVenue();
      venue.failCreateOrder = true;

      await expect(new SubmitService(config, venue, store).submit({
        venue: 'predict',
        signer,
        intent,
        initialBook: book,
        positions: [],
        openOrders: []
      })).rejects.toThrow('submit endpoint unavailable');

      expect(venue.createCalls).toBe(1);
      expect(store.status().openOrders).toBe(0);
      expect(store.listRecentOrders(5)[0]).toMatchObject({
        clientOrderId: intent.clientOrderId,
        status: 'UNKNOWN'
      });
      expect(store.listRecentEvents(5).find((event) => event.type === 'order.submit-error')?.details).toMatchObject({
        reject: {
          reason_code: 'SUBMIT_EXCEPTION',
          category: 'platform',
          stage: 'submitting'
        }
      });
    });
  });
});
