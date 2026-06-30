import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ExecutionEngine } from '../src/execution/engine.js';
import { StateStore } from '../src/store/sqlite.js';
import { appConfigSchema } from '../src/config/schema.js';
import type { VenueAdapter } from '../src/venues/types.js';
import type { OpenOrder } from '../src/domain/types.js';

// A-2 unit tests for engine's WS-triggered protect-on-fill machinery: the per-venue Promise-chain mutex
// (acquireProtectLock) and the dedupe + lock-coordinated protectOnFill hook. Full exit-path integration
// (markets resolution, cashFillExitService.process semantics) is covered by cash-fill-exit-idempotent.test.ts.

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    try { if (dir) rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

function tempStore(): StateStore {
  const dir = mkdtempSync(path.join(tmpdir(), 'engine-prot-'));
  tempDirs.push(dir);
  return new StateStore(path.join(dir, 'state.sqlite'));
}

function stubAdapter(): VenueAdapter {
  // Minimal adapter: only the methods protectOnFill + cancelManagedOrders + cashExitMarkets touch.
  // No setUserEventListener so engine ctor does NOT wire the WS handler (tests drive protectOnFill directly).
  // No createMarketableOrder so cashFillExitService records exit-unsupported (doesn't affect what we assert).
  return {
    cancelOrders: vi.fn(async (_ids: string[]) => undefined),
    getOpenOrders: vi.fn(async (_owner: string) => [] as OpenOrder[])
  } as unknown as VenueAdapter;
}

function makeEngine(adapter: VenueAdapter = stubAdapter()): { engine: ExecutionEngine; adapter: VenueAdapter; store: StateStore } {
  const config = appConfigSchema.parse({});
  const store = tempStore();
  const engine = new ExecutionEngine(config, adapter, store);
  return { engine, adapter, store };
}

function setSigner(engine: ExecutionEngine, address: string): void {
  // Bypass private — in production runOnce captures these; tests inject directly.
  (engine as unknown as { lastSigner: unknown; lastSignerAddress: string }).lastSigner =
    { address, signMessage: async () => '', signTypedData: async () => '' };
  (engine as unknown as { lastSigner: unknown; lastSignerAddress: string }).lastSignerAddress = address;
}

describe('ExecutionEngine.acquireProtectLock (private — promise-chain mutex)', () => {
  it('serializes concurrent acquirers for the same venue', async () => {
    const { engine } = makeEngine();
    const events: string[] = [];
    const acquire = (engine as unknown as { acquireProtectLock: (v: 'polymarket' | 'predict') => Promise<() => void> }).acquireProtectLock.bind(engine);

    const t1 = (async () => {
      const release = await acquire('polymarket');
      events.push('t1-acquired');
      await new Promise((r) => setTimeout(r, 25));
      events.push('t1-released');
      release();
    })();
    // Tick so t1 actually acquires before t2 even tries.
    await Promise.resolve();
    const t2 = (async () => {
      const release = await acquire('polymarket');
      events.push('t2-acquired');
      release();
    })();
    await Promise.all([t1, t2]);
    expect(events).toEqual(['t1-acquired', 't1-released', 't2-acquired']);
  });

  it('different venues acquire independently (no cross-venue blocking)', async () => {
    const { engine } = makeEngine();
    const events: string[] = [];
    const acquire = (engine as unknown as { acquireProtectLock: (v: 'polymarket' | 'predict') => Promise<() => void> }).acquireProtectLock.bind(engine);

    const poly = (async () => {
      const release = await acquire('polymarket');
      await new Promise((r) => setTimeout(r, 30));
      events.push('poly-done');
      release();
    })();
    await Promise.resolve();
    const predict = (async () => {
      const release = await acquire('predict');
      events.push('predict-done');
      release();
    })();
    await Promise.all([poly, predict]);
    // predict's 0ms work completes BEFORE poly's 30ms work, despite being requested second — proves independence.
    expect(events).toEqual(['predict-done', 'poly-done']);
  });
});

describe('ExecutionEngine.protectOnFill', () => {
  it('silently no-ops when engine has no captured signer (no cycle has run yet)', async () => {
    const { engine, adapter } = makeEngine();
    await engine.protectOnFill('polymarket', 'tokA', 100, 0.32);
    expect(adapter.getOpenOrders).not.toHaveBeenCalled();
    expect(adapter.cancelOrders).not.toHaveBeenCalled();
  });

  it('stamps lastWsProtectAt > 0 after a run so the cycle can observe WS-protection happened this window', async () => {
    const { engine } = makeEngine();
    setSigner(engine, '0xABC');
    expect((engine as unknown as { lastWsProtectAt: Map<string, number> }).lastWsProtectAt.get('polymarket')).toBeUndefined();
    const before = Date.now();
    await engine.protectOnFill('polymarket', 'tokA', 100, 0.32);
    const stamp = (engine as unknown as { lastWsProtectAt: Map<string, number> }).lastWsProtectAt.get('polymarket') as number;
    expect(stamp).toBeGreaterThanOrEqual(before);
    expect(stamp).toBeLessThanOrEqual(Date.now());
  });

  it('per-(venue, tokenId) dedupe: concurrent calls for the SAME token collapse to ONE getOpenOrders call', async () => {
    const adapter = stubAdapter();
    let resolveGetOpenOrders: ((v: OpenOrder[]) => void) | undefined;
    (adapter.getOpenOrders as ReturnType<typeof vi.fn>).mockImplementation(() =>
      new Promise<OpenOrder[]>((resolve) => { resolveGetOpenOrders = resolve; })
    );
    const { engine } = makeEngine(adapter);
    setSigner(engine, '0xABC');

    // Start two concurrent protectOnFill calls for the SAME token. The first lands in the in-flight set;
    // the second must see the dedupe guard and return immediately.
    const p1 = engine.protectOnFill('polymarket', 'tokA', 100, 0.32);
    // Tick microtasks so p1 has entered the function body and registered the in-flight token.
    await Promise.resolve();
    await Promise.resolve();
    const p2 = engine.protectOnFill('polymarket', 'tokA', 50, 0.32);
    // Now let p1's getOpenOrders resolve so it can finish.
    resolveGetOpenOrders!([]);
    await Promise.all([p1, p2]);

    expect(adapter.getOpenOrders).toHaveBeenCalledTimes(1);
  });

  it('different tokens both proceed (serialized through the venue lock, but neither is dropped)', async () => {
    const { engine, adapter } = makeEngine();
    setSigner(engine, '0xABC');
    await Promise.all([
      engine.protectOnFill('polymarket', 'tokA', 100, 0.32),
      engine.protectOnFill('polymarket', 'tokB', 50, 0.50)
    ]);
    expect(adapter.getOpenOrders).toHaveBeenCalledTimes(2);
  });

  it('suppresses re-trigger within cooldown, allows re-trigger after cooldown expires', async () => {
    const { engine, adapter } = makeEngine();
    setSigner(engine, '0xABC');
    let tick = 1_000_000;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => tick);

    // First fill — should proceed normally
    await engine.protectOnFill('polymarket', 'tokA', 100, 0.32);
    expect(adapter.getOpenOrders).toHaveBeenCalledTimes(1);

    // Second fill immediately — within 60s cooldown, must be suppressed
    await engine.protectOnFill('polymarket', 'tokA', 100, 0.32);
    expect(adapter.getOpenOrders).toHaveBeenCalledTimes(1); // still 1

    // Advance time past the 60s cooldown — re-trigger now allowed
    tick += 61_000;
    await engine.protectOnFill('polymarket', 'tokA', 100, 0.32);
    expect(adapter.getOpenOrders).toHaveBeenCalledTimes(2);

    spy.mockRestore();
  });

  it('A-2 fires even when A-3 holds the SAME token in its book-dedupe (production 2026-06-26 bug regression)', async () => {
    // Before this fix, protectOnFill and protectOnBookUpdate shared one `protectingTokens` Set. Whichever
    // entered first locked the other out — for the same token. Production 12:55 UTC: a book-update on
    // token X arrived ~10ms before the fill on token X; A-3 added X to the set and was still resolving
    // markets when the WS fill landed; A-2 looked up the (shared) Set, saw X present, returned silently.
    // No stop-loss attempt was made and the bot held a losing position until daily-loss-limit tripped.
    // With separate Sets (protectingFillTokens vs protectingBookTokens), A-2 runs regardless.
    const { engine, adapter } = makeEngine();
    setSigner(engine, '0xABC');
    // Simulate A-3 having added the token to its OWN dedupe set (mid-flight).
    const bookSet = new Set<string>(['tokA']);
    (engine as unknown as { protectingBookTokens: Map<string, Set<string>> }).protectingBookTokens.set('polymarket', bookSet);

    // A-2 must still fire — verify it calls getOpenOrders and stamps lastWsProtectAt.
    await engine.protectOnFill('polymarket', 'tokA', 100, 0.32);
    expect(adapter.getOpenOrders).toHaveBeenCalledTimes(1);
    expect((engine as unknown as { lastWsProtectAt: Map<string, number> }).lastWsProtectAt.get('polymarket')).toBeGreaterThan(0);
    // And A-3's set is untouched (independent state).
    expect(bookSet.has('tokA')).toBe(true);
  });
});
