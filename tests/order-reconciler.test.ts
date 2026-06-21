import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Market, OpenOrder, OrderIntent, OrderResult, Orderbook, PreflightResult } from '../src/domain/types.js';
import { OrderReconciler } from '../src/execution/order-reconciler.js';
import { StateStore } from '../src/store/sqlite.js';
import type { VenueAdapter } from '../src/venues/types.js';

const pendingMarket: Market = {
  venue: 'predict',
  tokenId: 'token-pending',
  question: 'Pending open order?',
  volume24hUsd: 10000,
  liquidityUsd: 10000,
  acceptingOrders: true,
  endTime: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  endTimeSource: 'market-end',
  negRisk: false,
  feeRateBps: 0,
  tickSize: 0.01,
  rewards: { enabled: true, level: 5, minShares: 10, maxSpreadCents: 6 }
};

const pendingIntent: OrderIntent = {
  venue: 'predict',
  market: pendingMarket,
  tokenId: pendingMarket.tokenId,
  side: 'SELL',
  price: 0.51,
  size: 10,
  notionalUsd: 5.1,
  postOnly: true,
  liquidity: 'maker',
  reason: 'pending-open-test',
  clientOrderId: 'pending-open-client'
};

class OrderReconcilerMockVenue implements VenueAdapter {
  readonly name = 'predict' as const;
  openOrders: OpenOrder[] = [];
  failOpenOrders = false;

  async testConnection(): Promise<boolean> {
    return true;
  }

  async getMarkets(): Promise<Market[]> {
    return [];
  }

  async getOrderbook(): Promise<Orderbook> {
    throw new Error('not used');
  }

  async getBalances() {
    return [];
  }

  async getPositions() {
    return [];
  }

  async getOpenOrders(): Promise<OpenOrder[]> {
    if (this.failOpenOrders) throw new Error('open order endpoint down');
    return this.openOrders;
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

function withStore<T>(run: (store: StateStore) => Promise<T> | T): Promise<T> | T {
  const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-order-reconcile-'));
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

describe('order reconciler', () => {
  it('syncs remote open orders into the local live ledger', async () => {
    await withStore(async (store) => {
      const venue = new OrderReconcilerMockVenue();
      venue.openOrders = [{
        venue: 'predict',
        externalId: 'remote-open-order',
        tokenId: 'token-1',
        side: 'BUY',
        price: 0.5,
        size: 10,
        status: 'OPEN'
      }];

      const result = await new OrderReconciler(venue, store).syncOpenOrders('predict', '0xabc');

      expect(result).toMatchObject({ ok: true, openOrders: venue.openOrders });
      expect(store.listOpenOrders('predict')).toHaveLength(1);
      expect(store.listOpenOrders('predict')[0]).toMatchObject({
        externalId: 'remote-open-order',
        status: 'OPEN'
      });
    });
  });

  it('returns local pending-open submitted orders together with remote open orders', async () => {
    await withStore(async (store) => {
      const venue = new OrderReconcilerMockVenue();
      venue.openOrders = [{
        venue: 'predict',
        externalId: 'remote-open-order',
        tokenId: 'token-remote',
        side: 'SELL',
        price: 0.52,
        size: 10,
        status: 'OPEN'
      }];
      store.recordPlannedOrder(pendingIntent, 'live');
      store.recordOrderResult({
        venue: 'predict',
        clientOrderId: pendingIntent.clientOrderId,
        externalId: 'pending-open-order',
        status: 'PENDING_OPEN'
      });

      const result = await new OrderReconciler(venue, store).syncOpenOrders('predict', '0xabc');

      expect(result).toMatchObject({ ok: true });
      expect(result.openOrders.map((order) => order.externalId).sort()).toEqual(['pending-open-order', 'remote-open-order']);
      expect(result.openOrders.find((order) => order.externalId === 'pending-open-order')).toMatchObject({
        tokenId: pendingIntent.tokenId,
        status: 'PENDING_OPEN'
      });
    });
  });

  it('does not return stale local pending-open orders as active when remote sync excludes them', async () => {
    await withStore(async (store) => {
      const venue = new OrderReconcilerMockVenue();
      store.recordPlannedOrder(pendingIntent, 'live');
      store.recordOrderResult({
        venue: 'predict',
        clientOrderId: pendingIntent.clientOrderId,
        externalId: 'stale-pending-open-order',
        status: 'PENDING_OPEN'
      });
      store.markStalePendingOpenOrdersCanceled('predict', -1);

      const result = await new OrderReconciler(venue, store).syncOpenOrders('predict', '0xabc');

      expect(result).toMatchObject({ ok: true, openOrders: [] });
      expect(store.listOpenOrders('predict')).toEqual([]);
      expect(store.listRecentOrders(1)[0]).toMatchObject({
        externalId: 'stale-pending-open-order',
        status: 'UNKNOWN'
      });
    });
  });

  it('returns freshly confirmed managed open orders during remote visibility lag', async () => {
    await withStore(async (store) => {
      const venue = new OrderReconcilerMockVenue();
      store.recordPlannedOrder(pendingIntent, 'live');
      store.recordOrderResult({
        venue: 'predict',
        clientOrderId: pendingIntent.clientOrderId,
        externalId: 'fresh-open-order',
        status: 'OPEN'
      });

      const result = await new OrderReconciler(venue, store).syncOpenOrders('predict', '0xabc');

      expect(result).toMatchObject({ ok: true });
      expect(result.openOrders).toEqual([expect.objectContaining({
        externalId: 'fresh-open-order',
        tokenId: pendingIntent.tokenId,
        status: 'OPEN'
      })]);
    });
  });

  it('fails closed with a structured reject when remote open orders cannot be synced', async () => {
    await withStore(async (store) => {
      const venue = new OrderReconcilerMockVenue();
      venue.failOpenOrders = true;

      const result = await new OrderReconciler(venue, store).syncOpenOrders('predict', '0xabc');

      expect(result).toMatchObject({ ok: false, openOrders: [], error: 'open order endpoint down' });
      expect(store.getCheckpoint('run.predict')?.value).toMatchObject({
        skippedQuoting: true,
        reason: 'open-orders.unavailable'
      });
      const event = store.listRecentEvents(5).find((item) => item.type === 'open-orders.unavailable');
      expect(event).toBeTruthy();
      expect(event?.details).toMatchObject({
        reject: {
          reason_code: 'OPEN_ORDERS_UNAVAILABLE',
          category: 'platform',
          stage: 'syncing-orders'
        }
      });
    });
  });
});
