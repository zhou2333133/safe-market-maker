import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { appConfigSchema } from '../src/config/schema.js';
import type { AccountRiskSnapshot, Market, OrderIntent, OrderResult, Orderbook, PreflightResult } from '../src/domain/types.js';
import { AccountSyncService } from '../src/execution/account-sync.js';
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

class AccountSyncMockVenue implements VenueAdapter {
  readonly name = 'predict' as const;
  snapshot?: Partial<AccountRiskSnapshot>;
  failSnapshot = false;
  failBalances = false;
  failPositions = false;
  balances = [{ asset: 'USDT', available: 100, total: 100 }];
  positions = [{ venue: 'predict' as const, tokenId: 'token-1', size: 2, notionalUsd: 1 }];

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
    if (this.failBalances) throw new Error('balance failed');
    return this.balances;
  }

  async getPositions() {
    if (this.failPositions) throw new Error('positions failed');
    return this.positions;
  }

  async getOpenOrders() {
    return [];
  }

  async getAccountRiskSnapshot(address: string, _signer: SignerProvider, sinceTs: number): Promise<AccountRiskSnapshot> {
    if (this.failSnapshot) throw new Error(`snapshot failed Bearer ${'0x' + 'a'.repeat(64)}`);
    return {
      venue: this.name,
      account: address,
      source: 'venue',
      capturedAt: Date.now(),
      dayStart: sinceTs,
      realizedPnlUsd: 0,
      unrealizedPnlUsd: 0,
      netCashflowUsd: 0,
      equityUsd: 100,
      fills: [],
      positions: [],
      balances: [{ asset: 'USDT', available: 100, total: 100 }],
      warnings: [],
      ...this.snapshot
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

function withStore<T>(run: (store: StateStore) => Promise<T> | T): Promise<T> | T {
  const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-account-sync-'));
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

describe('account sync service', () => {
  it('records a passing account risk snapshot and decision', async () => {
    await withStore(async (store) => {
      const config = appConfigSchema.parse({ liveEnabled: true });
      const venue = new AccountSyncMockVenue();
      const decision = await new AccountSyncService(config, venue, store).accountRiskGate({
        venue: 'predict',
        signerAddress: signer.address,
        signer,
        dayStart: Date.now() - 60_000
      });

      expect(decision).toMatchObject({ ok: true, reason: 'ok' });
      expect(store.getLatestAccountRiskDecision('predict')).toMatchObject({ ok: true, reason: 'ok' });
      expect(store.getLatestAccountRiskSnapshot('predict')).toMatchObject({ venue: 'predict', account: signer.address });
      expect(store.listRecentEvents(5).some((event) => event.type === 'risk.account-gate.blocked')).toBe(false);
    });
  });

  it('persists and enforces the live-session equity baseline', async () => {
    await withStore(async (store) => {
      const startedAt = Date.now() - 60_000;
      const config = appConfigSchema.parse({
        liveEnabled: true,
        risk: { maxDailyLossUsd: 1 }
      });
      const venue = new AccountSyncMockVenue();
      store.checkpoint('live-session.predict', {
        startedAt: new Date(startedAt).toISOString(),
        source: 'user-start'
      });

      const first = await new AccountSyncService(config, venue, store).accountRiskGate({
        venue: 'predict',
        signerAddress: signer.address,
        signer,
        dayStart: startedAt
      });
      expect(first).toMatchObject({ ok: true, dailyPnlUsd: 0, dayStartEquityUsd: 100 });
      expect(store.getCheckpoint('live-session.predict')?.value).toMatchObject({ equityUsd: 100 });

      venue.snapshot = {
        equityUsd: 98.5,
        balances: [{ asset: 'USDT', available: 98.5, total: 98.5 }]
      };
      const second = await new AccountSyncService(config, venue, store).accountRiskGate({
        venue: 'predict',
        signerAddress: signer.address,
        signer,
        dayStart: startedAt
      });
      expect(second).toMatchObject({
        ok: false,
        reason: 'daily-loss-limit',
        dailyPnlUsd: -1.5,
        dayStartEquityUsd: 100
      });
    });
  });

  it('restores a missing live-session baseline from the earliest verified account snapshot', async () => {
    await withStore(async (store) => {
      const startedAt = Date.now() - 60 * 60_000;
      const config = appConfigSchema.parse({
        liveEnabled: true,
        risk: { maxDailyLossUsd: 5 }
      });
      const venue = new AccountSyncMockVenue();
      store.checkpoint('live-session.predict', {
        startedAt: new Date(startedAt).toISOString(),
        source: 'auto-resume'
      });
      store.recordAccountRiskSnapshot({
        venue: 'predict',
        account: signer.address,
        source: 'venue+chain',
        capturedAt: startedAt + 1_000,
        dayStart: startedAt,
        equityUsd: 100,
        unrealizedPnlUsd: 0,
        fills: [],
        positions: [],
        balances: [{ asset: 'USDT', available: 100, total: 100 }],
        warnings: []
      });
      venue.snapshot = {
        equityUsd: 94,
        balances: [{ asset: 'USDT', available: 94, total: 94 }]
      };

      const decision = await new AccountSyncService(config, venue, store).accountRiskGate({
        venue: 'predict',
        signerAddress: signer.address,
        signer,
        dayStart: startedAt
      });

      expect(decision).toMatchObject({
        ok: false,
        reason: 'daily-loss-limit',
        dailyPnlUsd: -6,
        equityUsd: 94,
        dayStartEquityUsd: 100
      });
      expect(store.getCheckpoint('live-session.predict')?.value).toMatchObject({
        equityUsd: 100,
        equitySource: 'historical-account-snapshot'
      });
    });
  });

  it('does not disguise an old session loss by using the current equity as a late baseline', async () => {
    await withStore(async (store) => {
      const startedAt = Date.now() - 60 * 60_000;
      const config = appConfigSchema.parse({
        liveEnabled: true,
        risk: { maxDailyLossUsd: 5 }
      });
      const venue = new AccountSyncMockVenue();
      store.checkpoint('live-session.predict', {
        startedAt: new Date(startedAt).toISOString(),
        source: 'auto-resume'
      });
      venue.snapshot = {
        equityUsd: 94,
        realizedPnlUsd: undefined,
        unrealizedPnlUsd: undefined,
        positions: [{ venue: 'predict', tokenId: 'held-token', size: 10, notionalUsd: 5 }],
        balances: [{ asset: 'USDT', available: 89, total: 89 }]
      };

      const decision = await new AccountSyncService(config, venue, store).accountRiskGate({
        venue: 'predict',
        signerAddress: signer.address,
        signer,
        dayStart: startedAt
      });

      expect(decision).toMatchObject({ ok: false, reason: 'snapshot-unavailable', equityUsd: 94 });
      expect(store.getCheckpoint('live-session.predict')?.value).not.toHaveProperty('equityUsd');
    });
  });

  it('uses local cash-fill exit losses as a stop-loss fallback when venue fills are missing', async () => {
    await withStore(async (store) => {
      const config = appConfigSchema.parse({
        liveEnabled: true,
        risk: { maxDailyLossUsd: 0.2 }
      });
      const venue = new AccountSyncMockVenue();
      store.recordEvent({
        venue: 'predict',
        severity: 'warn',
        type: 'cash-fill.exit-submitted',
        message: '现金单边止损退出已提交：exit-1',
        details: {
          intent: {
            tokenId: 'token-1',
            side: 'SELL',
            price: 0.29,
            size: 1.72,
            notionalUsd: 0.4988
          },
          position: {
            tokenId: 'token-1',
            marketId: 'market-1',
            outcome: 'Team Spirit',
            size: 1.72,
            notionalUsd: 0.73,
            averagePrice: 0.41
          },
          averagePrice: 0.41,
          limitPrice: 0.29
        }
      });

      const decision = await new AccountSyncService(config, venue, store).accountRiskGate({
        venue: 'predict',
        signerAddress: signer.address,
        signer,
        dayStart: Date.now() - 60_000
      });

      expect(decision).toMatchObject({
        ok: false,
        reason: 'daily-loss-limit',
        dailyPnlUsd: -0.2312,
        realizedPnlUsd: -0.2312
      });
      expect(decision.warnings.join(' ')).toContain('Local cash-fill exit fallback');
    });
  });

  it('fails closed and records structured reject when account snapshot is unavailable', async () => {
    await withStore(async (store) => {
      const config = appConfigSchema.parse({ liveEnabled: true });
      const venue = new AccountSyncMockVenue();
      venue.failSnapshot = true;
      const decision = await new AccountSyncService(config, venue, store).accountRiskGate({
        venue: 'predict',
        signerAddress: signer.address,
        signer,
        dayStart: Date.now() - 60_000,
        scope: 'manual-order'
      });

      expect(decision).toMatchObject({ ok: false, reason: 'snapshot-unavailable' });
      const event = store.listRecentEvents(5).find((item) => item.type === 'risk.account-snapshot.unavailable');
      expect(event).toBeTruthy();
      expect(event?.details).toMatchObject({
        reject: {
          reason_code: 'ACCOUNT_SNAPSHOT_UNAVAILABLE',
          category: 'account',
          stage: 'manual-order'
        }
      });
      expect(JSON.stringify(event)).not.toContain('0x' + 'a'.repeat(64));
    });
  });

  it('records a blocked decision when the account snapshot is stale', async () => {
    await withStore(async (store) => {
      const config = appConfigSchema.parse({
        liveEnabled: true,
        risk: { maxAccountRiskStaleMs: 1000 }
      });
      const venue = new AccountSyncMockVenue();
      venue.snapshot = { capturedAt: Date.now() - 5000 };
      const decision = await new AccountSyncService(config, venue, store).accountRiskGate({
        venue: 'predict',
        signerAddress: signer.address,
        signer,
        dayStart: Date.now() - 60_000
      });

      expect(decision).toMatchObject({ ok: false, reason: 'snapshot-stale' });
      const event = store.listRecentEvents(5).find((item) => item.type === 'risk.account-gate.blocked');
      expect(event).toBeTruthy();
      expect(event?.details).toMatchObject({
        reject: {
          reason_code: 'ACCOUNT_SNAPSHOT_STALE',
          category: 'account',
          stage: 'auto-loop'
        }
      });
      expect(store.getCheckpoint('run.predict')?.value).toMatchObject({
        skippedQuoting: true,
        reason: 'snapshot-stale'
      });
    });
  });

  it('syncs positions through the account boundary', async () => {
    await withStore(async (store) => {
      const config = appConfigSchema.parse({ liveEnabled: true });
      const venue = new AccountSyncMockVenue();
      const result = await new AccountSyncService(config, venue, store).syncPositions({
        venue: 'predict',
        signerAddress: signer.address
      });

      expect(result).toMatchObject({ ok: true, positions: [{ tokenId: 'token-1', size: 2 }] });
      expect(store.listRecentEvents(5).some((event) => event.type === 'positions.unavailable')).toBe(false);
    });
  });

  it('fails closed and records structured reject when positions are unavailable', async () => {
    await withStore(async (store) => {
      const config = appConfigSchema.parse({ liveEnabled: true });
      const venue = new AccountSyncMockVenue();
      venue.failPositions = true;
      const result = await new AccountSyncService(config, venue, store).syncPositions({
        venue: 'predict',
        signerAddress: signer.address
      });

      expect(result).toMatchObject({ ok: false, positions: [] });
      const event = store.listRecentEvents(5).find((item) => item.type === 'positions.unavailable');
      expect(event?.details).toMatchObject({
        reject: {
          reason_code: 'POSITIONS_UNAVAILABLE',
          category: 'platform',
          stage: 'syncing-positions'
        }
      });
      expect(store.getCheckpoint('run.predict')?.value).toMatchObject({
        skippedQuoting: true,
        reason: 'positions.unavailable'
      });
    });
  });

  it('records empty balance rejects without throwing', async () => {
    await withStore(async (store) => {
      const config = appConfigSchema.parse({ liveEnabled: true });
      const venue = new AccountSyncMockVenue();
      venue.balances = [];
      const balances = await new AccountSyncService(config, venue, store).syncBalances({
        venue: 'predict',
        signerAddress: signer.address,
        signer
      });

      expect(balances).toEqual([]);
      const event = store.listRecentEvents(5).find((item) => item.type === 'balance.empty');
      expect(event?.details).toMatchObject({
        reject: {
          reason_code: 'BALANCE_EMPTY',
          category: 'balance',
          stage: 'syncing-balances'
        }
      });
    });
  });

  it('returns no balances and records structured reject when balance sync fails', async () => {
    await withStore(async (store) => {
      const config = appConfigSchema.parse({ liveEnabled: true });
      const venue = new AccountSyncMockVenue();
      venue.failBalances = true;
      const balances = await new AccountSyncService(config, venue, store).syncBalances({
        venue: 'predict',
        signerAddress: signer.address,
        signer
      });

      expect(balances).toEqual([]);
      const event = store.listRecentEvents(5).find((item) => item.type === 'balance.unavailable');
      expect(event?.details).toMatchObject({
        reject: {
          reason_code: 'BALANCE_UNAVAILABLE',
          category: 'balance',
          stage: 'syncing-balances'
        }
      });
    });
  });
});
