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
import { cancelAllLiveOrders } from '../src/execution/cancel-all.js';
import { importWallet } from '../src/secrets/keystore.js';
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
  question: 'Cancel all?',
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

class MockVenue implements VenueAdapter {
  readonly name: VenueName = 'predict';
  preflightOk = true;
  remoteOrders: OpenOrder[] = [{
    venue: 'predict',
    externalId: 'remote-order',
    tokenId: market.tokenId,
    side: 'BUY',
    price: 0.49,
    size: 10,
    status: 'OPEN'
  }];
  canceledIds: string[] = [];

  async testConnection(): Promise<boolean> {
    return true;
  }

  async getMarkets(): Promise<Market[]> {
    return [market];
  }

  async getOrderbook(): Promise<Orderbook> {
    return {
      venue: this.name,
      tokenId: market.tokenId,
      receivedAt: Date.now(),
      bids: [{ price: 0.49, size: 100 }],
      asks: [{ price: 0.51, size: 100 }]
    };
  }

  async getBalances(): Promise<Balance[]> {
    return [];
  }

  async getPositions(): Promise<Position[]> {
    return [];
  }

  async getOpenOrders(): Promise<OpenOrder[]> {
    return this.remoteOrders;
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
    return {
      ok: this.preflightOk,
      venue: this.name,
      checks: [{ name: 'credential', ok: this.preflightOk, message: this.preflightOk ? 'ok' : 'missing' }]
    };
  }

  async createOrder(intent: OrderIntent): Promise<OrderResult> {
    return { venue: this.name, clientOrderId: intent.clientOrderId, status: 'OPEN' };
  }

  async cancelOrders(orderIds: string[]): Promise<void> {
    this.canceledIds.push(...orderIds);
  }
}

describe('cancel all live orders', () => {
  it('uses one guarded flow for stored and remote open orders', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config = appConfigSchema.parse({ liveEnabled: true });
    const venue = new MockVenue();
    importWallet(dir, 'predict', '1'.repeat(64), 'passphrase');
    const localIntent: OrderIntent = {
      venue: 'predict',
      market,
      tokenId: market.tokenId,
      side: 'SELL',
      price: 0.52,
      size: 10,
      notionalUsd: 5.2,
      postOnly: true,
      reason: 'local-open-order',
      clientOrderId: 'local-client-order'
    };
    store.recordPlannedOrder(localIntent, 'live');
    store.recordOrderResult({ venue: 'predict', clientOrderId: localIntent.clientOrderId, externalId: 'local-order', status: 'OPEN' });
    try {
      const result = await cancelAllLiveOrders({
        config,
        dataDir: dir,
        venue: 'predict',
        confirm: 'CANCEL_ALL',
        signer,
        store,
        adapter: venue,
        eventType: 'cancel-all'
      });

      expect(result.ok).toBe(true);
      expect(result.ids).toEqual(['remote-order']);
      expect(venue.canceledIds).toEqual(['remote-order']);
      const event = store.listRecentEvents(10).find((item) => item.type === 'cancel-all');
      expect(event?.details).toMatchObject({ mode: 'live', ids: ['remote-order'] });
      expect(store.listOpenOrders('predict')).toEqual([]);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not send stale local Predict ids when the platform reports no open orders', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config = appConfigSchema.parse({ liveEnabled: true });
    const venue = new MockVenue();
    venue.remoteOrders = [];
    importWallet(dir, 'predict', '3'.repeat(64), 'passphrase');
    const staleIntent: OrderIntent = {
      venue: 'predict',
      market,
      tokenId: market.tokenId,
      side: 'BUY',
      price: 0.27,
      size: 29.629,
      notionalUsd: 8,
      postOnly: true,
      reason: 'stale-hash',
      clientOrderId: 'predict-token-1-BUY-stale-hash'
    };
    store.recordPlannedOrder(staleIntent, 'live');
    store.recordOrderResult({
      venue: 'predict',
      clientOrderId: staleIntent.clientOrderId,
      externalId: '0x12c5a3937cd395b9817d4c554dc95988ce501606a16de370227c90721e8f8f12',
      status: 'OPEN'
    });
    try {
      const result = await cancelAllLiveOrders({
        config,
        dataDir: dir,
        venue: 'predict',
        confirm: 'CANCEL_ALL',
        signer,
        store,
        adapter: venue,
        eventType: 'cancel-all'
      });

      expect(result.ok).toBe(true);
      expect(result.ids).toEqual([]);
      expect(venue.canceledIds).toEqual([]);
      expect(store.listOpenOrders('predict')).toEqual([]);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('allows emergency cancellation when liveEnabled is false', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config = appConfigSchema.parse({ liveEnabled: false });
    const venue = new MockVenue();
    importWallet(dir, 'predict', '4'.repeat(64), 'passphrase');
    try {
      const result = await cancelAllLiveOrders({
        config,
        dataDir: dir,
        venue: 'predict',
        confirm: 'CANCEL_ALL',
        signer,
        store,
        adapter: venue,
        eventType: 'cancel-all'
      });

      expect(result.ok).toBe(true);
      expect(result.ids).toEqual(['remote-order']);
      expect(venue.canceledIds).toEqual(['remote-order']);
      expect(result.preflight.checks.find((check) => check.name === 'live-config')).toMatchObject({
        ok: true,
        message: 'not required for this action; liveEnabled=false'
      });
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still cancels best-effort when venue preflight fails (cancel is a safety action)', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config = appConfigSchema.parse({ liveEnabled: true });
    const venue = new MockVenue();
    venue.preflightOk = false;
    importWallet(dir, 'predict', '2'.repeat(64), 'passphrase');
    try {
      const result = await cancelAllLiveOrders({
        config,
        dataDir: dir,
        venue: 'predict',
        confirm: 'CANCEL_ALL',
        signer,
        store,
        adapter: venue,
        eventType: 'cancel-all'
      });

      // A flaky/timed-out preflight (e.g. venue-live-preflight connection check) must NOT abandon the user's open
      // orders — the cancel proceeds and reports the degraded preflight as a warning.
      expect(result.ok).toBe(true);
      expect(venue.canceledIds).toEqual(['remote-order']);
      expect(store.listRecentEvents(10).some((event) => event.type === 'cancel-all.preflight-degraded')).toBe(true);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
