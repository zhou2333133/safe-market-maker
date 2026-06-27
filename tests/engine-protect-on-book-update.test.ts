import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ExecutionEngine } from '../src/execution/engine.js';
import { StateStore } from '../src/store/sqlite.js';
import { appConfigSchema } from '../src/config/schema.js';
import type { VenueAdapter } from '../src/venues/types.js';
import type { Market, OpenOrder, Orderbook } from '../src/domain/types.js';

// A-3 unit tests: the WS-driven placement-protection re-check (protectOnBookUpdate). Exercises the 3-condition
// gates (front depth, exit liquidity) running on the fresh push-cache book, the per-(venue, tokenId) dedupe,
// and the venue lock + lastWsProtectAt stamp coordination with the cycle's quote-place phase.

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    try { if (dir) rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

function tempStore(): StateStore {
  const dir = mkdtempSync(path.join(tmpdir(), 'engine-book-'));
  tempDirs.push(dir);
  return new StateStore(path.join(dir, 'state.sqlite'));
}

function stubAdapter(): VenueAdapter {
  // Minimal adapter — the engine constructor wires nothing (no setUserEventListener, no setBookUpdateListener
  // means no WS wiring; tests drive protectOnBookUpdate directly).
  return {
    cancelOrders: vi.fn(async (_ids: string[]) => undefined),
    getOpenOrders: vi.fn(async () => [] as OpenOrder[]),
    getCachedOrderbook: vi.fn(() => undefined)
  } as unknown as VenueAdapter;
}

function makeMarket(tokenId = 'tokA'): Market {
  return {
    venue: 'polymarket',
    tokenId,
    marketId: 'mkt1',
    conditionId: 'c1',
    question: 'Q',
    outcome: 'Yes',
    outcomeIndex: 0,
    outcomeCount: 2,
    volume24hUsd: 1000,
    liquidityUsd: 1000,
    acceptingOrders: true,
    negRisk: false,
    feeRateBps: 0,
    tickSize: 0.01,
    rewards: { enabled: true, minShares: 100, maxSpreadCents: 3 }
  } as Market;
}

function makeBook(opts: {
  tokenId?: string;
  bids?: Array<{ price: number; size: number }>;
  asks?: Array<{ price: number; size: number }>;
  receivedAt?: number;
}): Orderbook {
  return {
    venue: 'polymarket',
    tokenId: opts.tokenId ?? 'tokA',
    bids: opts.bids ?? [],
    asks: opts.asks ?? [],
    receivedAt: opts.receivedAt ?? Date.now()
  };
}

function insertManagedOrder(store: StateStore, opts: { tokenId: string; externalId: string; side: 'BUY' | 'SELL'; price: number; size: number }) {
  const clientId = `test-${opts.externalId}`;
  store.recordPlannedOrder({
    venue: 'polymarket',
    tokenId: opts.tokenId,
    side: opts.side,
    price: opts.price,
    size: opts.size,
    notionalUsd: opts.price * opts.size,
    clientOrderId: clientId,
    reason: 'test-setup',
    postOnly: true,
    market: makeMarket(opts.tokenId)
  } as any, 'live');
  store.recordOrderResult({
    venue: 'polymarket',
    clientOrderId: clientId,
    externalId: opts.externalId,
    status: 'OPEN',
    raw: {}
  } as any);
}

function makeEngine(adapter: VenueAdapter, configOverrides: { strategy?: any; risk?: any } = {}) {
  const config = appConfigSchema.parse({
    strategy: {
      entryMode: 'cash',
      polymarketRetreatFrontDepthUsd: 300,
      cashSupportWindowCents: 0, // Default: only condition 1 (front depth) checked
      ...configOverrides.strategy
    },
    risk: {
      orderSizeUsd: 30,
      staleBookMs: 60000, // long so test books are never auto-stale
      ...configOverrides.risk
    }
  });
  const store = tempStore();
  const engine = new ExecutionEngine(config, adapter, store);
  // Inject market resolution so the test doesn't depend on a live marketDataSync cache.
  // engine's marketDataSync is private but JS lets us monkey-patch via the engine instance.
  (engine as unknown as { marketDataSync: { getMarketFromCache: (v: string, id: string) => Market | undefined } }).marketDataSync.getMarketFromCache = vi.fn((_venue: string, tokenId: string) =>
    makeMarket(tokenId)
  );
  return { engine, store };
}

describe('ExecutionEngine.protectOnBookUpdate (A-3: WS-driven 3-condition retreat)', () => {
  it('healthy book → no cancel, no event, dedupe set cleared after', async () => {
    const adapter = stubAdapter();
    // Front depth: bid @ 0.41 size 1000 = $410 (> $300 floor). Healthy.
    (adapter.getCachedOrderbook as ReturnType<typeof vi.fn>).mockReturnValue(makeBook({
      bids: [{ price: 0.41, size: 1000 }, { price: 0.40, size: 200 }],
      asks: [{ price: 0.42, size: 200 }]
    }));
    const { engine, store } = makeEngine(adapter);
    insertManagedOrder(store, { tokenId: 'tokA', externalId: 'ext1', side: 'BUY', price: 0.40, size: 75 });

    await engine.protectOnBookUpdate('polymarket', 'tokA');

    expect(adapter.cancelOrders).not.toHaveBeenCalled();
    expect((engine as unknown as { protectingBookTokens: Map<string, Set<string>> }).protectingBookTokens.get('polymarket')?.has('tokA')).toBe(false);
    expect((engine as unknown as { lastWsProtectAt: Map<string, number> }).lastWsProtectAt.get('polymarket')).toBeUndefined();
  });

  it('front depth dropped below floor → cancels the BUY immediately + stamps lastWsProtectAt', async () => {
    const adapter = stubAdapter();
    // Front depth: bid @ 0.41 size 100 = $41 (< $300 floor). Retreat.
    (adapter.getCachedOrderbook as ReturnType<typeof vi.fn>).mockReturnValue(makeBook({
      bids: [{ price: 0.41, size: 100 }, { price: 0.40, size: 200 }],
      asks: [{ price: 0.42, size: 200 }]
    }));
    const { engine, store } = makeEngine(adapter);
    insertManagedOrder(store, { tokenId: 'tokA', externalId: 'ext1', side: 'BUY', price: 0.40, size: 75 });

    const before = Date.now();
    await engine.protectOnBookUpdate('polymarket', 'tokA');

    expect(adapter.cancelOrders).toHaveBeenCalledTimes(1);
    expect(adapter.cancelOrders).toHaveBeenCalledWith(['ext1']);
    const stamp = (engine as unknown as { lastWsProtectAt: Map<string, number> }).lastWsProtectAt.get('polymarket') as number;
    expect(stamp).toBeGreaterThanOrEqual(before);
  });

  it('rear exit liquidity gone → cancels even when front is healthy', async () => {
    const adapter = stubAdapter();
    // Front healthy: bid @ 0.41 size 1000 = $410. But rear exit window (2¢) has only $11 inside [0.38, 0.40),
    // way below the $30 order size requirement. shouldRetreatThinFront triggers on the support shortfall path.
    (adapter.getCachedOrderbook as ReturnType<typeof vi.fn>).mockReturnValue(makeBook({
      bids: [
        { price: 0.41, size: 1000 }, // front (above order) — healthy
        { price: 0.39, size: 30 }    // 0.39 × 30 = $11.70 inside 2¢ exit window — INSUFFICIENT
      ],
      asks: [{ price: 0.42, size: 200 }]
    }));
    const { engine, store } = makeEngine(adapter, { strategy: { cashSupportWindowCents: 2 } });
    insertManagedOrder(store, { tokenId: 'tokA', externalId: 'ext1', side: 'BUY', price: 0.40, size: 75 });

    await engine.protectOnBookUpdate('polymarket', 'tokA');

    expect(adapter.cancelOrders).toHaveBeenCalledWith(['ext1']);
  });

  it('no managed orders on this token → silent no-op (does not even hit the book cache)', async () => {
    const adapter = stubAdapter();
    const { engine } = makeEngine(adapter); // No managed order inserted
    await engine.protectOnBookUpdate('polymarket', 'tokA');
    expect(adapter.cancelOrders).not.toHaveBeenCalled();
    // The order check short-circuits BEFORE the book read — proves the hot path is cheap when irrelevant.
    expect(adapter.getCachedOrderbook).not.toHaveBeenCalled();
  });

  it('no cached book available → silent no-op (cycle catches via REST verify)', async () => {
    const adapter = stubAdapter();
    (adapter.getCachedOrderbook as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    const { engine, store } = makeEngine(adapter);
    insertManagedOrder(store, { tokenId: 'tokA', externalId: 'ext1', side: 'BUY', price: 0.40, size: 75 });

    await engine.protectOnBookUpdate('polymarket', 'tokA');
    expect(adapter.cancelOrders).not.toHaveBeenCalled();
  });

  it('SELL-side resting order → ignored (shouldRetreatThinFront only acts on cash BUY)', async () => {
    const adapter = stubAdapter();
    (adapter.getCachedOrderbook as ReturnType<typeof vi.fn>).mockReturnValue(makeBook({
      bids: [{ price: 0.41, size: 100 }] // would trip BUY retreat
    }));
    const { engine, store } = makeEngine(adapter);
    insertManagedOrder(store, { tokenId: 'tokA', externalId: 'ext1', side: 'SELL', price: 0.42, size: 75 });

    await engine.protectOnBookUpdate('polymarket', 'tokA');
    expect(adapter.cancelOrders).not.toHaveBeenCalled();
  });

  it('per-(venue, tokenId) dedupe: concurrent calls for the SAME token issue only ONE cancel', async () => {
    const adapter = stubAdapter();
    (adapter.getCachedOrderbook as ReturnType<typeof vi.fn>).mockReturnValue(makeBook({
      bids: [{ price: 0.41, size: 50 }] // $20 < $300 → trip retreat
    }));
    let resolveCancel: (() => void) | undefined;
    (adapter.cancelOrders as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise<void>((resolve) => { resolveCancel = () => resolve(); }));

    const { engine, store } = makeEngine(adapter);
    insertManagedOrder(store, { tokenId: 'tokA', externalId: 'ext1', side: 'BUY', price: 0.40, size: 75 });

    const p1 = engine.protectOnBookUpdate('polymarket', 'tokA');
    // Drain microtasks so p1 has registered the in-flight token AND reached the await on cancelOrders.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const p2 = engine.protectOnBookUpdate('polymarket', 'tokA');
    resolveCancel!();
    await Promise.all([p1, p2]);

    expect(adapter.cancelOrders).toHaveBeenCalledTimes(1);
  });

  it('different tokens both run independently (lock serializes, neither dropped)', async () => {
    const adapter = stubAdapter();
    (adapter.getCachedOrderbook as ReturnType<typeof vi.fn>).mockImplementation((tokenId: string) =>
      makeBook({ tokenId, bids: [{ price: 0.41, size: 50 }] }) // both bad
    );
    const { engine, store } = makeEngine(adapter);
    insertManagedOrder(store, { tokenId: 'tokA', externalId: 'extA', side: 'BUY', price: 0.40, size: 75 });
    insertManagedOrder(store, { tokenId: 'tokB', externalId: 'extB', side: 'BUY', price: 0.40, size: 75 });

    await Promise.all([
      engine.protectOnBookUpdate('polymarket', 'tokA'),
      engine.protectOnBookUpdate('polymarket', 'tokB')
    ]);

    expect(adapter.cancelOrders).toHaveBeenCalledTimes(2);
    expect((adapter.cancelOrders as ReturnType<typeof vi.fn>).mock.calls.flat()).toEqual(expect.arrayContaining([['extA'], ['extB']]));
  });

  it('cleans up in-flight token even when adapter.cancelOrders throws (no leak)', async () => {
    const adapter = stubAdapter();
    (adapter.getCachedOrderbook as ReturnType<typeof vi.fn>).mockReturnValue(makeBook({
      bids: [{ price: 0.41, size: 50 }] // trip retreat
    }));
    (adapter.cancelOrders as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('venue 503'));

    const { engine, store } = makeEngine(adapter);
    insertManagedOrder(store, { tokenId: 'tokA', externalId: 'ext1', side: 'BUY', price: 0.40, size: 75 });

    await expect(engine.protectOnBookUpdate('polymarket', 'tokA')).resolves.toBeUndefined();
    expect((engine as unknown as { protectingBookTokens: Map<string, Set<string>> }).protectingBookTokens.get('polymarket')?.has('tokA')).toBe(false);
  });
});
