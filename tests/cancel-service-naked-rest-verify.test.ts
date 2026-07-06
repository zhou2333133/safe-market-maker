import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { CancelService } from '../src/execution/cancel-service.js';
import { StateStore } from '../src/store/sqlite.js';
import { stateStoreSchemaSql } from '../src/store/schema.js';
import { appConfigSchema } from '../src/config/schema.js';
import type { OpenOrder, Market, Orderbook } from '../src/domain/types.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

function tempStore(): StateStore {
  const dir = mkdtempSync(path.join(tmpdir(), 'cs-test-'));
  return new StateStore(path.join(dir, 'state.sqlite'));
}

/** Inject an order into the ledger via the planned→submitted flow so managedOpenOrders considers it ours.
 *  managedOpenOrders only returns rows whose client_order_id does NOT start with "${venue}:", so we use a
 *  client_order_id that doesn't follow that convention — same path the bot uses for its own submissions. */
function ingestAsManaged(store: StateStore, order: OpenOrder, market: Market): void {
  const clientId = `test-${order.externalId}`;
  // 1) record planned
  store.recordPlannedOrder({
    venue: order.venue,
    tokenId: order.tokenId,
    side: order.side,
    price: order.price,
    size: order.size,
    notionalUsd: order.price * order.size,
    clientOrderId: clientId,
    reason: 'test-setup',
    postOnly: true,
    market
  } as any, 'live');
  // 2) record OPEN result so status=OPEN with our external_id
  store.recordOrderResult({
    venue: order.venue,
    clientOrderId: clientId,
    externalId: order.externalId,
    status: 'OPEN',
    raw: {}
  } as any);
  // Override created_at to match order.placedAt so the bot's longNakedRest check sees an old order
  if (order.placedAt) {
    const db = (store as any).db as Database.Database;
    db.prepare(`UPDATE orders SET created_at=? WHERE client_order_id=?`).run(order.placedAt, clientId);
  }
}

const config = appConfigSchema.parse({
  strategy: {
    entryMode: 'cash',
    predictFrontDepthUsd: 200,
    polymarketRetreatFrontDepthUsd: 300,
    cashRequireExitLiquidity: false,
    cashSupportWindowCents: 0
  },
  risk: { staleBookMs: 2000 }
});

function makeMarket(venue: 'polymarket' | 'predict' = 'predict', tokenId = 'tokA'): Market {
  return {
    venue,
    tokenId,
    marketId: 'mkt',
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
    // isCashProtectedBuyOrder requires minShares > 0 AND maxSpreadCents > 0; without these the naked-rest
    // check would never fire even on Predict.
    rewards: { enabled: true, level: 3, minShares: 20, maxSpreadCents: 3 }
  } as Market;
}

function makeOrder(venue: 'polymarket' | 'predict' = 'predict', tokenId = 'tokA', placedAt?: number): OpenOrder {
  return {
    venue,
    externalId: '0xabc1234567890abcdef',
    tokenId,
    side: 'BUY',
    price: 0.5,
    size: 100,
    status: 'OPEN',
    placedAt: placedAt ?? Date.now() - 60_000 // 60s old by default = triggers longNakedRest
  } as OpenOrder;
}

function makeAdapter(getOrderbookImpl: ((tokenId: string) => Promise<Orderbook>) | undefined) {
  return {
    getOrderbook: getOrderbookImpl ? vi.fn(getOrderbookImpl) : undefined,
    primeBook: vi.fn(),
    cancelOrders: vi.fn(async () => undefined)
  } as any;
}

function healthyBook(tokenId = 'tokA'): Orderbook {
  // For a BUY order @ 0.5, "front depth" = bids ABOVE 0.5 (price-time priority puts these in line ahead of us).
  // 0.51 × 1000 + 0.52 × 500 = $770 of front above the $200 predict floor → no retreat.
  return {
    venue: 'predict',
    tokenId,
    bids: [
      { price: 0.52, size: 500 }, // front (ahead of us in line)
      { price: 0.51, size: 1000 }, // front
      { price: 0.5, size: 100 }    // our level
    ],
    asks: [{ price: 0.53, size: 300 }],
    receivedAt: Date.now()
  };
}

function thinFrontBook(tokenId = 'tokA'): Orderbook {
  // Front above our order is below floor — should trigger retreat.
  // 0.51 × 100 = $51 of front — well below $200 floor.
  return {
    venue: 'predict',
    tokenId,
    bids: [
      { price: 0.51, size: 100 },
      { price: 0.5, size: 100 }
    ],
    asks: [{ price: 0.52, size: 100 }],
    receivedAt: Date.now()
  };
}

describe('CancelService.cancelReplaceableOrders — REST verify before naked-rest panic cancel', () => {
  it('(a) Predict skips REST verify — order flows to shouldRetreatThinFront instead (no REST call)', async () => {
    const store = tempStore();
    const adapter = makeAdapter(async () => healthyBook());
    const keptOnlyConfig = appConfigSchema.parse({
      strategy: {
        entryMode: 'cash',
        predictFrontDepthUsd: 200,
        polymarketRetreatFrontDepthUsd: 300,
        cashRequireExitLiquidity: false,
        cashSupportWindowCents: 0,
        cancelOutsideReward: false
      },
      risk: { staleBookMs: 2000 }
    });
    const svc = new CancelService(keptOnlyConfig, adapter, store);
    const order = makeOrder();
    const market = makeMarket();
    ingestAsManaged(store, order, market);
    const result = await svc.cancelReplaceableOrders(
      'predict',
      [order],
      [],
      [market],
      new Map() // empty books → would trigger REST verify on Polymarket, Predict skips
    );
    // Predict WS pushes full snapshots: stale book = no change, cached book is valid.
    // shouldRetreatThinFront returns null on no-book (not a retreat trigger on Predict).
    expect(result.canceledIds).toHaveLength(0);
    expect(adapter.getOrderbook).not.toHaveBeenCalled();
    expect(adapter.primeBook).not.toHaveBeenCalled();
    const recents = (store as any).listRecentEvents(20);
    const keptEvt = recents.find((e: any) => e.type === 'quote.protect-rest-verify-kept');
    expect(keptEvt).toBeUndefined(); // Predict skips this path entirely
    store.close();
  });

  it('(b) Predict skips REST verify — thin front does NOT trigger cancel through REST path', async () => {
    const store = tempStore();
    const adapter = makeAdapter(async () => thinFrontBook());
    const svc = new CancelService(config, adapter, store);
    const order = makeOrder();
    const market = makeMarket();
    ingestAsManaged(store, order, market);
    const result = await svc.cancelReplaceableOrders(
      'predict',
      [order],
      [],
      [makeMarket()],
      new Map()
    );
    // REST verify skipped for Predict — order flows to shouldRetreatThinFront.
    // shouldRetreatThinFront returns null on no-book, order is kept.
    expect(result.canceledIds).toHaveLength(0);
    expect(adapter.getOrderbook).not.toHaveBeenCalled();
    const recents = (store as any).listRecentEvents(20);
    const verifiedCancelEvt = recents.find((e: any) => e.type === 'quote.protect-rest-verify-canceled');
    expect(verifiedCancelEvt).toBeUndefined();
    store.close();
  });

  it('(c) Predict skips REST verify — REST exception does NOT trigger cancel', async () => {
    const store = tempStore();
    const adapter = makeAdapter(async () => { throw new Error('fetch failed'); });
    const svc = new CancelService(config, adapter, store);
    const order = makeOrder();
    const market = makeMarket();
    ingestAsManaged(store, order, market);
    const result = await svc.cancelReplaceableOrders(
      'predict',
      [order],
      [],
      [makeMarket()],
      new Map()
    );
    expect(result.canceledIds).toHaveLength(0);
    expect(adapter.getOrderbook).not.toHaveBeenCalled();
    const recents = (store as any).listRecentEvents(20);
    const failedEvt = recents.find((e: any) => e.type === 'quote.protect-rest-verify-failed');
    expect(failedEvt).toBeUndefined();
    store.close();
  });

  it('(d) Predict skips REST verify — REST timeout does NOT trigger cancel', async () => {
    const store = tempStore();
    // never resolves
    const adapter = makeAdapter(() => new Promise(() => {/* hang */}));
    const svc = new CancelService(config, adapter, store);
    const order = makeOrder();
    const market = makeMarket();
    ingestAsManaged(store, order, market);
    const result = await svc.cancelReplaceableOrders(
      'predict',
      [order],
      [],
      [makeMarket()],
      new Map()
    );
    expect(result.canceledIds).toHaveLength(0);
    expect(adapter.getOrderbook).not.toHaveBeenCalled();
    const recents = (store as any).listRecentEvents(20);
    const failedEvt = recents.find((e: any) => e.type === 'quote.protect-rest-verify-failed');
    expect(failedEvt).toBeUndefined();
    store.close();
  }, 10000);

  it('(e) Predict skips REST verify — adapter without getOrderbook, no crash', async () => {
    const store = tempStore();
    const adapter = makeAdapter(undefined);
    const svc = new CancelService(config, adapter, store);
    const order = makeOrder();
    const market = makeMarket();
    ingestAsManaged(store, order, market);
    const result = await svc.cancelReplaceableOrders(
      'predict',
      [order],
      [],
      [makeMarket()],
      new Map()
    );
    expect(result.canceledIds).toHaveLength(0);
    expect(adapter.getOrderbook).toBeUndefined();
    store.close();
  });

  it('(f) order younger than 30s → naked-rest path does NOT fire (verify never called)', async () => {
    const store = tempStore();
    const adapter = makeAdapter(async () => healthyBook());
    const svc = new CancelService(config, adapter, store);
    // order placed 10s ago — under the 30s naked-rest threshold
    const youngOrder = makeOrder('predict', 'tokA', Date.now() - 10_000);
    ingestAsManaged(store, youngOrder, makeMarket());
    await svc.cancelReplaceableOrders(
      'predict',
      [youngOrder],
      [],
      [makeMarket()],
      new Map()
    );
    expect(adapter.getOrderbook).not.toHaveBeenCalled();
    store.close();
  });

  it('(g) POLY orders skip naked-rest path entirely (isCashProtectedBuyOrder is Predict-only by venue check) — verify never called for POLY', async () => {
    // The pre-existing isCashProtectedBuyOrder filter at cancel-service.ts:693 explicitly requires
    // `market.venue === 'predict'`. So the longNakedRest path — and thus our new REST verify — only ever
    // fires for Predict. This test confirms the venue boundary still holds: POLY orders fall through to the
    // route-based replace path, getOrderbook is NEVER called for them.
    const store = tempStore();
    const adapter = makeAdapter(async () => healthyBook('tokP'));
    const svc = new CancelService(config, adapter, store);
    const polyOrder = makeOrder('polymarket', 'tokP');
    ingestAsManaged(store, polyOrder, makeMarket('polymarket', 'tokP'));
    await svc.cancelReplaceableOrders(
      'polymarket',
      [polyOrder],
      [],
      [makeMarket('polymarket', 'tokP')],
      new Map()
    );
    expect(adapter.getOrderbook).not.toHaveBeenCalled();
    store.close();
  });
});

afterAll(() => {
  // best-effort temp dir cleanup
  try {
    const baseDir = path.join(tmpdir(), 'cs-test-');
    // each test created its own dir; SQLite WAL/SHM files cleaned by close()
  } catch {}
});

// vitest's afterAll alias to avoid an unused-import warning
import { afterAll } from 'vitest';
