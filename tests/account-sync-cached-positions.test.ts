import { describe, expect, it, vi } from 'vitest';
import { appConfigSchema } from '../src/config/schema.js';
import { AccountSyncService } from '../src/execution/account-sync.js';
import type { Position } from '../src/domain/types.js';

const config = appConfigSchema.parse({});

function fakeStore() {
  const events: Array<{ type: string; details: any; message: string }> = [];
  return {
    events,
    recordEvent: (e: any) => { events.push({ type: e.type, details: e.details, message: e.message }); },
    checkpoint: () => {},
    getCheckpoint: () => undefined,
    getLatestAccountRiskSnapshot: () => undefined,
    recordAccountRiskSnapshot: () => {},
    localCashExitLossSince: () => ({ count: 0, estimatedLossUsd: 0, estimatedRealizedPnlUsd: 0 }),
    cashFillCooldownEntries: () => []
  } as any;
}

function fakeAdapter(positionsByCall: (Position[] | Error)[]) {
  let i = 0;
  return {
    getPositions: vi.fn(async () => {
      const next = positionsByCall[Math.min(i, positionsByCall.length - 1)];
      i += 1;
      if (next instanceof Error) throw next;
      return next as Position[];
    })
  } as any;
}

describe('AccountSyncService.syncPositions cached-fallback (POLY/Predict independent)', () => {
  it('caches the latest successful positions and returns them when next fetch fails', async () => {
    const positions: Position[] = [
      { venue: 'polymarket', tokenId: 'tokA', size: 100, averagePrice: 0.5, notionalUsd: 50, conditionId: 'c1' } as Position
    ];
    const store = fakeStore();
    const adapter = fakeAdapter([positions, new Error('fetch failed')]);
    const svc = new AccountSyncService(config, adapter, store);

    const first = await svc.syncPositions({ venue: 'polymarket', signerAddress: '0x1' });
    expect(first.ok).toBe(true);
    expect(first.cached).toBeUndefined();
    expect(first.positions).toEqual(positions);

    const second = await svc.syncPositions({ venue: 'polymarket', signerAddress: '0x1' });
    expect(second.ok).toBe(true);
    expect(second.cached).toBe(true);
    expect(second.positions).toEqual(positions); // same data from cache
    expect(typeof second.cachedAgeMs).toBe('number');

    // Operator-visible event was emitted (warn level, not error — degraded mode is recoverable)
    const fallbackEvt = store.events.find((e: any) => e.type === 'positions.cached-fallback');
    expect(fallbackEvt).toBeDefined();
  });

  it('returns ok:false (no cached) when first call fails — engine should still exit then', async () => {
    const store = fakeStore();
    const adapter = fakeAdapter([new Error('first call fail')]);
    const svc = new AccountSyncService(config, adapter, store);

    const result = await svc.syncPositions({ venue: 'polymarket', signerAddress: '0x1' });
    expect(result.ok).toBe(false);
    expect(result.cached).toBeUndefined();
    expect(result.positions).toEqual([]);

    // The user-facing event must be error-level (no cache to fall back on, real degradation)
    const evt = store.events.find((e: any) => e.type === 'positions.unavailable');
    expect(evt).toBeDefined();
  });

  it('caches are per-venue: Predict failure does not return Polymarket positions', async () => {
    const polyPositions: Position[] = [
      { venue: 'polymarket', tokenId: 'p1', size: 50, averagePrice: 0.3, notionalUsd: 15, conditionId: 'c-poly' } as Position
    ];
    const store = fakeStore();
    let call = 0;
    const adapter = {
      getPositions: vi.fn(async () => {
        call += 1;
        if (call === 1) return polyPositions; // polymarket succeeds
        throw new Error('predict failed'); // predict fails (no cache)
      })
    } as any;
    const svc = new AccountSyncService(config, adapter, store);

    await svc.syncPositions({ venue: 'polymarket', signerAddress: '0x1' });
    const predictResult = await svc.syncPositions({ venue: 'predict', signerAddress: '0x2' });
    expect(predictResult.ok).toBe(false);
    expect(predictResult.positions).toEqual([]); // NOT polyPositions — caches are venue-scoped
  });
});
