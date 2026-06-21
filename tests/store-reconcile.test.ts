import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AccountRiskSnapshot, Market, OpenOrder, OrderIntent } from '../src/domain/types.js';
import { StateStore } from '../src/store/sqlite.js';

const market: Market = {
  venue: 'predict',
  tokenId: 'token-1',
  question: 'Store test',
  volume24hUsd: 10000,
  liquidityUsd: 10000,
  acceptingOrders: true,
  endTime: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  endTimeSource: 'market-end',
  negRisk: false,
  feeRateBps: 0,
  tickSize: 0.01,
  rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6 }
};

describe('state store reconciliation', () => {
  it('marks locally open orders as canceled when absent from remote sync', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-store-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const stale: OpenOrder = {
      venue: 'predict',
      externalId: 'stale-order',
      tokenId: 'token-1',
      side: 'BUY',
      price: 0.49,
      size: 10,
      status: 'OPEN'
    };
    const live: OpenOrder = {
      ...stale,
      externalId: 'live-order'
    };
    try {
      store.ingestOpenOrders([stale, live], 'live');
      store.reconcileOpenOrders('predict', [live], 'live');
      const open = store.listOpenOrders('predict');
      expect(open.map((order) => order.externalId)).toEqual(['live-order']);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps freshly confirmed bot-managed open orders through brief remote visibility lag', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-store-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const intent: OrderIntent = {
      venue: 'predict',
      market,
      tokenId: market.tokenId,
      side: 'SELL',
      price: 0.51,
      size: 10,
      notionalUsd: 5.1,
      postOnly: true,
      liquidity: 'maker',
      reason: 'fresh-open-lag-test',
      clientOrderId: 'fresh-open-client-1'
    };
    try {
      store.recordPlannedOrder(intent, 'live');
      store.recordOrderResult({ venue: 'predict', clientOrderId: intent.clientOrderId, externalId: 'fresh-open-remote-1', status: 'OPEN' });
      store.reconcileOpenOrders('predict', [], 'live', { freshOpenGraceMs: 120_000 });

      expect(store.listOpenOrders('predict')).toEqual([expect.objectContaining({
        externalId: 'fresh-open-remote-1',
        status: 'OPEN'
      })]);
      expect(store.status().openOrders).toBe(1);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('clears stale local open orders when remote sync returns no open orders', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-store-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const stale: OpenOrder = {
      venue: 'predict',
      externalId: 'stale-order',
      tokenId: 'token-1',
      side: 'BUY',
      price: 0.49,
      size: 10,
      status: 'OPEN'
    };
    try {
      store.ingestOpenOrders([stale], 'live');
      store.reconcileOpenOrders('predict', [], 'live');
      expect(store.listOpenOrders('predict')).toEqual([]);
      expect(store.status().openOrders).toBe(0);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps newly submitted pending-open orders through brief remote visibility lag', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-store-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const pending: OrderIntent = {
      venue: 'predict',
      market,
      tokenId: market.tokenId,
      side: 'SELL',
      price: 0.51,
      size: 10,
      notionalUsd: 5.1,
      postOnly: true,
      liquidity: 'maker',
      reason: 'pending-confirmation-test',
      clientOrderId: 'pending-client-1'
    };
    try {
      store.recordPlannedOrder(pending, 'live');
      store.recordOrderResult({ venue: 'predict', clientOrderId: pending.clientOrderId, externalId: 'pending-remote-1', status: 'PENDING_OPEN' });
      store.reconcileOpenOrders('predict', [], 'live');

      expect(store.listOpenOrders('predict')).toEqual([expect.objectContaining({
        externalId: 'pending-remote-1',
        status: 'PENDING_OPEN'
      })]);
      expect(store.status().openOrders).toBe(0);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('expires stale submitted pending-open orders that never appear in remote open orders', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-store-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const pending: OrderIntent = {
      venue: 'predict',
      market,
      tokenId: market.tokenId,
      side: 'SELL',
      price: 0.51,
      size: 10,
      notionalUsd: 5.1,
      postOnly: true,
      liquidity: 'maker',
      reason: 'pending-confirmation-test',
      clientOrderId: 'pending-client-2'
    };
    try {
      store.recordPlannedOrder(pending, 'live');
      store.recordOrderResult({ venue: 'predict', clientOrderId: pending.clientOrderId, externalId: 'pending-remote-2', status: 'PENDING_OPEN' });
      store.markStalePendingOpenOrdersCanceled('predict', -1);

      expect(store.listOpenOrders('predict')).toEqual([]);
      expect(store.status().openOrders).toBe(0);
      expect(store.listRecentOrders(1)[0]).toMatchObject({
        externalId: 'pending-remote-2',
        status: 'UNKNOWN',
        reason: 'pending-open-not-confirmed'
      });
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('expires stale planned orders that never reached platform submission', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-store-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const planned: OrderIntent = {
      venue: 'predict',
      market,
      tokenId: market.tokenId,
      side: 'SELL',
      price: 0.51,
      size: 10,
      notionalUsd: 5.1,
      postOnly: true,
      liquidity: 'maker',
      reason: 'planned-expiry-test',
      clientOrderId: 'planned-client-1'
    };
    try {
      store.recordPlannedOrder(planned, 'live');
      store.markStalePlannedOrdersUnknown('predict', -1);

      expect(store.listOpenOrders('predict')).toEqual([]);
      expect(store.status().openOrders).toBe(0);
      expect(store.listRecentOrders(1)[0]).toMatchObject({
        clientOrderId: 'planned-client-1',
        status: 'UNKNOWN',
        reason: 'planned-order-not-submitted'
      });
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not duplicate a submitted order when remote sync returns the same external id', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-store-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const intent: OrderIntent = {
      venue: 'predict',
      market,
      tokenId: market.tokenId,
      side: 'BUY',
      price: 0.49,
      size: 100,
      notionalUsd: 49,
      postOnly: true,
      liquidity: 'maker',
      reason: 'test',
      clientOrderId: 'client-1'
    };
    try {
      store.recordPlannedOrder(intent, 'live');
      store.recordOrderResult({ venue: 'predict', clientOrderId: 'client-1', externalId: 'remote-1', status: 'OPEN' });
      store.reconcileOpenOrders('predict', [{
        venue: 'predict',
        externalId: 'remote-1',
        tokenId: market.tokenId,
        side: 'BUY',
        price: 0.49,
        size: 100,
        status: 'OPEN'
      }], 'live');
      expect(store.listOpenOrders('predict')).toHaveLength(1);
      expect(store.status().openOrders).toBe(1);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rekeys a submitted Predict order from hash to platform cancel id during remote sync', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-store-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const intent: OrderIntent = {
      venue: 'predict',
      market,
      tokenId: market.tokenId,
      side: 'BUY',
      price: 0.27,
      size: 29.629,
      notionalUsd: 8,
      postOnly: true,
      liquidity: 'maker',
      reason: 'test',
      clientOrderId: 'predict-token-1-BUY-123456-hash'
    };
    try {
      store.recordPlannedOrder(intent, 'live');
      store.recordOrderResult({
        venue: 'predict',
        clientOrderId: intent.clientOrderId,
        externalId: '0x12c5a3937cd395b9817d4c554dc95988ce501606a16de370227c90721e8f8f12',
        status: 'OPEN',
        raw: { orderHash: '0x12c5a3937cd395b9817d4c554dc95988ce501606a16de370227c90721e8f8f12' }
      });
      store.reconcileOpenOrders('predict', [{
        venue: 'predict',
        externalId: '220162001',
        tokenId: market.tokenId,
        side: 'BUY',
        price: 0.27,
        size: 29.629,
        status: 'OPEN',
        raw: {
          id: '220162001',
          order: { hash: '0x12c5a3937cd395b9817d4c554dc95988ce501606a16de370227c90721e8f8f12' }
        }
      }], 'live');

      expect(store.listOpenOrders('predict')).toEqual([expect.objectContaining({
        externalId: '220162001',
        price: 0.27,
        size: 29.629
      })]);
      expect(store.status().openOrders).toBe(1);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('separates platform open orders from bot-managed open orders', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-store-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const platformOrder: OpenOrder = {
      venue: 'predict',
      externalId: 'external-platform',
      tokenId: market.tokenId,
      side: 'BUY',
      price: 0.49,
      size: 10,
      status: 'OPEN'
    };
    const intent: OrderIntent = {
      venue: 'predict',
      market,
      tokenId: market.tokenId,
      side: 'BUY',
      price: 0.48,
      size: 10,
      notionalUsd: 4.8,
      postOnly: true,
      liquidity: 'maker',
      reason: 'test',
      clientOrderId: 'predict-token-1-BUY-123456-aa'
    };
    try {
      store.ingestOpenOrders([platformOrder], 'live');
      store.recordPlannedOrder(intent, 'live');
      store.recordOrderResult({ venue: 'predict', clientOrderId: intent.clientOrderId, externalId: 'external-bot', status: 'OPEN' });

      expect(store.listOpenOrders('predict').map((order) => order.externalId).sort()).toEqual(['external-bot', 'external-platform']);
      expect(store.listManagedOpenOrders('predict').map((order) => order.externalId)).toEqual(['external-bot']);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('updates mutable open order fields from remote sync for partially filled orders', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-store-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const intent: OrderIntent = {
      venue: 'predict',
      market,
      tokenId: market.tokenId,
      side: 'BUY',
      price: 0.49,
      size: 100,
      notionalUsd: 49,
      postOnly: true,
      liquidity: 'maker',
      reason: 'test',
      clientOrderId: 'client-partial'
    };
    try {
      store.recordPlannedOrder(intent, 'live');
      store.recordOrderResult({ venue: 'predict', clientOrderId: 'client-partial', externalId: 'remote-partial', status: 'OPEN' });
      store.reconcileOpenOrders('predict', [{
        venue: 'predict',
        externalId: 'remote-partial',
        tokenId: market.tokenId,
        side: 'BUY',
        price: 0.5,
        size: 40,
        status: 'OPEN'
      }], 'live');

      expect(store.listOpenOrders('predict')).toEqual([expect.objectContaining({
        externalId: 'remote-partial',
        price: 0.5,
        size: 40
      })]);
      expect(store.listRecentOrders(1)[0]).toMatchObject({
        externalId: 'remote-partial',
        price: 0.5,
        size: 40,
        notionalUsd: 20
      });
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exposes the latest checkpoint as structured status data', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-store-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    try {
      store.checkpoint('stage.predict', { stage: 'routing-market', message: '选择市场' });
      const status = store.status();
      expect(status.lastCheckpoint).toMatchObject({ name: 'stage.predict' });
      expect(typeof status.lastCheckpoint?.ts).toBe('string');
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('summarizes same-day fills so the UI can show whether orders were eaten', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-store-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const dayStart = Date.parse('2026-05-20T00:00:00Z');
    const snapshot: AccountRiskSnapshot = {
      venue: 'predict',
      account: '0x1111111111111111111111111111111111111111',
      source: 'venue',
      capturedAt: Date.parse('2026-05-20T10:00:00Z'),
      dayStart,
      realizedPnlUsd: -1.25,
      unrealizedPnlUsd: 0,
      netCashflowUsd: -10.02,
      fills: [
        {
          venue: 'predict',
          id: 'buy-fill',
          tokenId: market.tokenId,
          side: 'BUY',
          price: 0.5,
          size: 20,
          notionalUsd: 10,
          feeUsd: 0.02,
          cashflowUsd: -10.02,
          ts: Date.parse('2026-05-20T09:00:00Z')
        },
        {
          venue: 'predict',
          id: 'yesterday-fill',
          tokenId: market.tokenId,
          side: 'SELL',
          price: 0.5,
          size: 10,
          notionalUsd: 5,
          cashflowUsd: 5,
          ts: Date.parse('2026-05-19T23:59:00Z')
        }
      ],
      positions: [],
      balances: [{ asset: 'USDT', available: 90, total: 90 }],
      warnings: []
    };
    try {
      store.recordAccountRiskSnapshot(snapshot);

      expect(store.summarizeFills('predict', dayStart)).toMatchObject({
        count: 1,
        buyCount: 1,
        sellCount: 0,
        notionalUsd: 10,
        netCashflowUsd: -10.02,
        latest: {
          id: 'buy-fill',
          tokenId: market.tokenId,
          side: 'BUY',
          notionalUsd: 10
        }
      });
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
