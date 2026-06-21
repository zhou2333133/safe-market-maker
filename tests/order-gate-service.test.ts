import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { appConfigSchema } from '../src/config/schema.js';
import type { Market, OpenOrder, OrderIntent, Orderbook } from '../src/domain/types.js';
import { OrderGateService } from '../src/execution/order-gate-service.js';
import { StateStore } from '../src/store/sqlite.js';

const market: Market = {
  venue: 'predict',
  tokenId: 'token-1',
  question: 'Gate safely?',
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
  clientOrderId: 'order-gate-test',
  reward: { optimizer: 'test', score: 10, level: 5, minShares: 10, maxSpreadCents: 6 }
};

function withStore<T>(run: (store: StateStore) => Promise<T> | T): Promise<T> | T {
  const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-order-gate-'));
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

describe('order gate service', () => {
  it('returns ready when duplicate, market, capital, and order risk checks pass', () => {
    withStore((store) => {
      const config = appConfigSchema.parse({
        liveEnabled: true,
        risk: { maxSingleOrderUsd: 100, maxPositionUsd: 200 }
      });
      const result = new OrderGateService(config, store).evaluate({
        venue: 'predict',
        intent,
        book,
        balances: [{ asset: 'USDT', available: 100, total: 100 }],
        positions: [],
        openOrders: [],
        remainingBalanceUsd: 100
      });

      expect(result).toEqual({ status: 'ready' });
    });
  });

  it('skips without counting a rejection when an open order already exists on the same token side', () => {
    withStore((store) => {
      const config = appConfigSchema.parse({ liveEnabled: true });
      const openOrders: OpenOrder[] = [{
        venue: 'predict',
        externalId: 'existing-buy',
        tokenId: intent.tokenId,
        side: 'BUY',
        price: 0.49,
        size: 10,
        status: 'OPEN'
      }];

      const result = new OrderGateService(config, store).evaluate({
        venue: 'predict',
        intent,
        book,
        balances: [{ asset: 'USDT', available: 100, total: 100 }],
        positions: [],
        openOrders,
        remainingBalanceUsd: 100
      });

      expect(result).toMatchObject({ status: 'skipped-existing', existingOrder: openOrders[0] });
      expect(store.listRecentEvents(5).find((event) => event.type === 'quote.skip-existing')?.details).toMatchObject({
        existingOrder: 'existing-buy'
      });
    });
  });

  it('adopts an exact duplicate open order so future maintenance can manage it', () => {
    withStore((store) => {
      const config = appConfigSchema.parse({
        liveEnabled: true,
        strategy: { entryMode: 'cash' }
      });
      const openOrders: OpenOrder[] = [{
        venue: 'predict',
        externalId: 'platform-existing-buy',
        tokenId: intent.tokenId,
        side: 'BUY',
        price: 0.49,
        size: 10,
        status: 'OPEN'
      }];

      const result = new OrderGateService(config, store).evaluate({
        venue: 'predict',
        intent,
        book,
        balances: [{ asset: 'USDT', available: 100, total: 100 }],
        positions: [],
        openOrders,
        remainingBalanceUsd: 100
      });

      expect(result).toMatchObject({ status: 'skipped-existing', managed: true });
      expect(store.listManagedOpenOrders('predict').map((order) => order.externalId)).toContain('platform-existing-buy');
      expect(store.listRecentEvents(5).find((event) => event.type === 'quote.adopt-existing')?.details).toMatchObject({
        tokenId: intent.tokenId,
        side: 'BUY',
        price: 0.49,
        size: 10
      });
      expect(store.listRecentEvents(5).find((event) => event.type === 'quote.skip-existing')?.details).toMatchObject({
        existingOrder: 'platform-existing-buy',
        managed: true,
        adopted: true
      });
    });
  });

  it('does not adopt a duplicate whose size is materially different from the intent', () => {
    withStore((store) => {
      const config = appConfigSchema.parse({
        liveEnabled: true,
        strategy: { entryMode: 'cash' }
      });
      const openOrders: OpenOrder[] = [{
        venue: 'predict',
        externalId: 'manual-existing-buy',
        tokenId: intent.tokenId,
        side: 'BUY',
        price: 0.49,
        size: 25,
        status: 'OPEN'
      }];

      const result = new OrderGateService(config, store).evaluate({
        venue: 'predict',
        intent,
        book,
        balances: [{ asset: 'USDT', available: 100, total: 100 }],
        positions: [],
        openOrders,
        remainingBalanceUsd: 100
      });

      expect(result).toMatchObject({ status: 'skipped-existing', managed: false });
      expect(store.listManagedOpenOrders('predict')).toEqual([]);
      expect(store.listRecentEvents(5).some((event) => event.type === 'quote.adopt-existing')).toBe(false);
    });
  });

  it('does not let an unconfirmed pending-open order block a replacement leg', () => {
    withStore((store) => {
      const config = appConfigSchema.parse({ liveEnabled: true });
      const openOrders: OpenOrder[] = [{
        venue: 'predict',
        externalId: 'pending-buy',
        tokenId: intent.tokenId,
        side: 'BUY',
        price: 0.49,
        size: 10,
        status: 'PENDING_OPEN'
      }];

      const result = new OrderGateService(config, store).evaluate({
        venue: 'predict',
        intent,
        book,
        balances: [{ asset: 'USDT', available: 100, total: 100 }],
        positions: [],
        openOrders,
        remainingBalanceUsd: 100
      });

      expect(result).toEqual({ status: 'ready' });
      expect(store.listRecentEvents(5).find((event) => event.type === 'quote.skip-existing')).toBeUndefined();
    });
  });

  it('blocks a new cash token when maxMarkets is already occupied', () => {
    withStore((store) => {
      const config = appConfigSchema.parse({
        liveEnabled: true,
        risk: { maxMarkets: 1, maxSingleOrderUsd: 100, maxPositionUsd: 200 },
        strategy: { entryMode: 'cash' }
      });
      const existing: OpenOrder = {
        venue: 'predict',
        externalId: 'other-token-buy',
        tokenId: 'other-token',
        side: 'BUY',
        price: 0.49,
        size: 10,
        status: 'OPEN'
      };

      const result = new OrderGateService(config, store).evaluate({
        venue: 'predict',
        intent,
        book,
        balances: [{ asset: 'USDT', available: 100, total: 100 }],
        positions: [],
        openOrders: [existing],
        remainingBalanceUsd: 100
      });

      expect(result).toEqual({ status: 'rejected', balanceSkipped: false });
      expect(store.listRecentEvents(5).find((event) => event.type === 'risk.reject')?.details).toMatchObject({
        reject: {
          reason_code: 'MAX_MARKETS_LIMIT',
          category: 'risk',
          stage: 'checking-risk'
        },
        activeTokenIds: ['other-token'],
        maxMarkets: 1
      });
    });
  });

  it('allows a new cash token when maxMarkets has free capacity', () => {
    withStore((store) => {
      const config = appConfigSchema.parse({
        liveEnabled: true,
        risk: { maxMarkets: 2, maxSingleOrderUsd: 100, maxPositionUsd: 200 },
        strategy: { entryMode: 'cash' }
      });
      const existing: OpenOrder = {
        venue: 'predict',
        externalId: 'other-token-buy',
        tokenId: 'other-token',
        side: 'BUY',
        price: 0.49,
        size: 10,
        status: 'OPEN'
      };

      const result = new OrderGateService(config, store).evaluate({
        venue: 'predict',
        intent,
        book,
        balances: [{ asset: 'USDT', available: 100, total: 100 }],
        positions: [],
        openOrders: [existing],
        remainingBalanceUsd: 100
      });

      expect(result).toEqual({ status: 'ready' });
    });
  });

  it('allows the twentieth cash token and blocks the twenty first by managed capacity', () => {
    withStore((store) => {
      const config = appConfigSchema.parse({
        liveEnabled: true,
        risk: { maxMarkets: 20, maxSingleOrderUsd: 100, maxPositionUsd: 200 },
        strategy: { entryMode: 'cash' }
      });
      const existing = Array.from({ length: 19 }, (_, index): OpenOrder => ({
        venue: 'predict',
        externalId: `existing-token-${index}`,
        tokenId: `existing-token-${index}`,
        side: 'BUY',
        price: 0.49,
        size: 10,
        status: 'OPEN'
      }));

      const twentieth = new OrderGateService(config, store).evaluate({
        venue: 'predict',
        intent,
        book,
        balances: [{ asset: 'USDT', available: 1, total: 1 }],
        positions: [],
        openOrders: existing,
        remainingBalanceUsd: 1
      });
      const twentyFirst = new OrderGateService(config, store).evaluate({
        venue: 'predict',
        intent: { ...intent, tokenId: 'twenty-first-token', market: { ...market, tokenId: 'twenty-first-token' } },
        book: { ...book, tokenId: 'twenty-first-token' },
        balances: [{ asset: 'USDT', available: 1, total: 1 }],
        positions: [],
        openOrders: [...existing, { ...existing[0]!, externalId: 'twentieth-existing', tokenId: intent.tokenId }],
        remainingBalanceUsd: 1
      });

      expect(twentieth).toEqual({ status: 'ready' });
      expect(twentyFirst).toEqual({ status: 'rejected', balanceSkipped: false });
    });
  });

  it('records a structured market reject before capital and order risk checks', () => {
    withStore((store) => {
      const config = appConfigSchema.parse({
        liveEnabled: true,
        risk: { blockUnknownEndTime: true, maxSingleOrderUsd: 100, maxPositionUsd: 200 }
      });
      const unknownEndIntent = {
        ...intent,
        market: { ...market, endTime: undefined, endTimeSource: undefined }
      };

      const result = new OrderGateService(config, store).evaluate({
        venue: 'predict',
        intent: unknownEndIntent,
        book,
        balances: [{ asset: 'USDT', available: 100, total: 100 }],
        positions: [],
        openOrders: [],
        remainingBalanceUsd: 100
      });

      expect(result).toEqual({ status: 'rejected', balanceSkipped: false });
      expect(store.listRecentEvents(5).find((event) => event.type === 'risk.market-guard.reject')?.details).toMatchObject({
        reject: {
          reason_code: 'MARKET_UNKNOWN_END_TIME',
          category: 'market',
          stage: 'checking-risk'
        }
      });
    });
  });

  it('records balance rejects and reports balanceSkipped for reserved or taker BUY orders', () => {
    withStore((store) => {
      const config = appConfigSchema.parse({
        liveEnabled: true,
        risk: { maxSingleOrderUsd: 100, maxPositionUsd: 200 },
        strategy: { balanceReserveUsd: 0 }
      });

      const result = new OrderGateService(config, store).evaluate({
        venue: 'predict',
        intent: { ...intent, liquidity: 'taker' },
        book,
        balances: [{ asset: 'USDT', available: 1, total: 1 }],
        positions: [],
        openOrders: [],
        remainingBalanceUsd: 1
      });

      expect(result).toEqual({ status: 'rejected', balanceSkipped: true });
      expect(store.listRecentEvents(5).find((event) => event.type === 'risk.balance-skip')?.details).toMatchObject({
        reject: {
          reason_code: 'BALANCE_INSUFFICIENT',
          category: 'balance',
          stage: 'checking-risk'
        }
      });
    });
  });

  it('records order-risk rejects after capital has passed', () => {
    withStore((store) => {
      const config = appConfigSchema.parse({
        liveEnabled: true,
        risk: { maxSingleOrderUsd: 100, maxPositionUsd: 200, requirePostOnly: true }
      });

      const result = new OrderGateService(config, store).evaluate({
        venue: 'predict',
        intent: { ...intent, postOnly: false },
        book,
        balances: [{ asset: 'USDT', available: 100, total: 100 }],
        positions: [],
        openOrders: [],
        remainingBalanceUsd: 100
      });

      expect(result).toEqual({ status: 'rejected', balanceSkipped: false });
      expect(store.listRecentEvents(5).find((event) => event.type === 'risk.reject')?.details).toMatchObject({
        reject: {
          reason_code: 'POST_ONLY_REQUIRED',
          category: 'risk',
          stage: 'checking-risk'
        }
      });
    });
  });

  it('rejects stale scan books before submit in the live gate', () => {
    withStore((store) => {
      const config = appConfigSchema.parse({
        liveEnabled: true,
        risk: { maxSingleOrderUsd: 100, maxPositionUsd: 200, staleBookMs: 1500 }
      });

      const result = new OrderGateService(config, store).evaluate({
        venue: 'predict',
        intent,
        book: { ...book, receivedAt: Date.now() - 9500 },
        balances: [{ asset: 'USDT', available: 100, total: 100 }],
        positions: [],
        openOrders: [],
        remainingBalanceUsd: 100
      });

      expect(result).toEqual({ status: 'rejected', balanceSkipped: false });
      expect(store.listRecentEvents(5).find((event) => event.type === 'risk.reject')?.details).toMatchObject({
        reject: {
          reason_code: 'STALE_ORDERBOOK',
          category: 'risk',
          stage: 'checking-risk'
        }
      });
    });
  });
});
