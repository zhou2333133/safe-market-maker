import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ExecutionEngine } from '../src/execution/engine.js';
import { StateStore } from '../src/store/sqlite.js';
import { appConfigSchema } from '../src/config/schema.js';
import type { VenueAdapter } from '../src/venues/types.js';
import type { Market, OpenOrder, Orderbook } from '../src/domain/types.js';

// 盲区 REST 辅助扫描（仅 Predict）单元测试。覆盖 Type A/B/C/D 与频率门控：
//   Type A: 从未拿到盘口 + REST 连失败 3 次 → 撤（真裸单）
//   Type B: REST 盘口前方塌陷 → shouldRetreatThinFront 撤退
//   Type C: REST 安全（良性沉默）→ 保留 + 记录 lastRestSafeAt
//   Type D: 曾拿到盘口 + REST 连失败 3 次 → 保守撤
//   频率门控：沉默 < BLIND_SILENCE_MS 跳过；最近 REST 确认安全则跳过（低频复核）；仅 Predict 生效。

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    try { if (dir) rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

function tempStore(): StateStore {
  const dir = mkdtempSync(path.join(tmpdir(), 'engine-blind-'));
  tempDirs.push(dir);
  return new StateStore(path.join(dir, 'state.sqlite'));
}

function stubPredictAdapter(restImpl: (tokenId: string) => Orderbook | Promise<Orderbook>): VenueAdapter {
  return {
    name: 'predict',
    cancelOrders: vi.fn(async (_ids: string[]) => undefined),
    getOpenOrders: vi.fn(async () => [] as OpenOrder[]),
    getCachedOrderbook: vi.fn(() => undefined),
    getOrderbookRest: vi.fn(restImpl),
    setBookUpdateListener: vi.fn()
  } as unknown as VenueAdapter;
}

function stubPolymarketAdapter(): VenueAdapter {
  return { name: 'polymarket', cancelOrders: vi.fn(async () => undefined) } as unknown as VenueAdapter;
}

function makePredictMarket(tokenId = 'tokA'): Market {
  return {
    venue: 'predict',
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
}): Orderbook {
  return {
    venue: 'predict',
    tokenId: opts.tokenId ?? 'tokA',
    bids: opts.bids ?? [],
    asks: opts.asks ?? [],
    receivedAt: Date.now()
  };
}

function makeCashBuyOrder(tokenId: string, externalId: string, price: number, placedAtMsAgo = 60_000): OpenOrder {
  return {
    venue: 'predict',
    tokenId,
    externalId,
    clientOrderId: `c-${externalId}`,
    side: 'BUY',
    price,
    size: 75,
    status: 'OPEN',
    placedAt: Date.now() - placedAtMsAgo,
    postOnly: true
  } as unknown as OpenOrder;
}

function overrideOrders(store: StateStore, orders: OpenOrder[]): void {
  (store as unknown as { listManagedOpenOrders: ReturnType<typeof vi.fn> }).listManagedOpenOrders = vi.fn(() => orders);
}

function makeEngine(adapter: VenueAdapter, venue: 'predict' | 'polymarket' = 'predict') {
  const config = appConfigSchema.parse({
    strategy: {
      entryMode: 'cash',
      predictFrontDepthUsd: 300,
      conservativeDepthLevel: 3,
      cashSupportWindowCents: 0,
      orderSizeUsd: 30
    },
    risk: {
      orderSizeUsd: 30,
      staleBookMs: 60_000
    }
  });
  const store = tempStore();
  const engine = new ExecutionEngine(config, adapter, store);
  // 注入 market 解析，避免依赖实时 marketDataSync 缓存
  (engine as unknown as { marketDataSync: { getMarketFromCache: (v: string, id: string) => Market | undefined } })
    .marketDataSync.getMarketFromCache = vi.fn((_v: string, tokenId: string) => makePredictMarket(tokenId));
  return { engine, store };
}

function seedBookSeen(engine: ExecutionEngine, tokenId: string, silenceMs: number): void {
  const e = engine as unknown as {
    everHadBook: Map<string, Set<string>>;
    lastBookPushAt: Map<string, Map<string, number>>;
  };
  if (!e.everHadBook.has('predict')) e.everHadBook.set('predict', new Set());
  e.everHadBook.get('predict')!.add(tokenId);
  if (!e.lastBookPushAt.has('predict')) e.lastBookPushAt.set('predict', new Map());
  e.lastBookPushAt.get('predict')!.set(tokenId, Date.now() - silenceMs);
}

function seedRestSafe(engine: ExecutionEngine, tokenId: string, ageMs: number): void {
  const e = engine as unknown as { lastRestSafeAt: Map<string, Map<string, number>> };
  if (!e.lastRestSafeAt.has('predict')) e.lastRestSafeAt.set('predict', new Map());
  e.lastRestSafeAt.get('predict')!.set(tokenId, Date.now() - ageMs);
}

function resetSweepGate(engine: ExecutionEngine): void {
  (engine as unknown as { lastBlindSweepAt: number }).lastBlindSweepAt = 0;
}

function callSweep(engine: ExecutionEngine): Promise<void> {
  resetSweepGate(engine);
  return (engine as unknown as { sweepBlindSpotCashBuys: () => Promise<void> }).sweepBlindSpotCashBuys();
}

describe('ExecutionEngine.sweepBlindSpotCashBuys (盲区 REST 辅助扫描, 仅 Predict)', () => {
  it('Type C: 沉默但 REST 盘口安全 → 不撤, 记录 lastRestSafeAt', async () => {
    const adapter = stubPredictAdapter(() => makeBook({
      tokenId: 'tokA',
      bids: [
        { price: 0.43, size: 1000 }, // 前方档位 1
        { price: 0.42, size: 1000 }, // 前方档位 2
        { price: 0.41, size: 1000 }, // 前方档位 3（无论 conservativeDepthLevel 取 1/2/3 均满足队列档位数）
        { price: 0.40, size: 200 }   // 订单所在档
      ], // 前方深度 $3000 > $300
      asks: [{ price: 0.44, size: 200 }]
    }));
    const { engine, store } = makeEngine(adapter);
    overrideOrders(store, [makeCashBuyOrder('tokA', 'ext1', 0.40)]);
    seedBookSeen(engine, 'tokA', 30_000); // 沉默 30s, 视为可疑

    await callSweep(engine);

    expect(adapter.cancelOrders).not.toHaveBeenCalled();
    const safe = (engine as unknown as { lastRestSafeAt: Map<string, Map<string, number>> })
      .lastRestSafeAt.get('predict')!.get('tokA')!;
    expect(safe).toBeGreaterThan(0);
  });

  it('Type B: REST 核验发现前方塌陷 → 撤退 + 记录事件', async () => {
    const adapter = stubPredictAdapter(() => makeBook({
      tokenId: 'tokA',
      bids: [{ price: 0.41, size: 100 }, { price: 0.40, size: 200 }], // 前方深度 $41 < $300
      asks: [{ price: 0.42, size: 200 }]
    }));
    const { engine, store } = makeEngine(adapter);
    overrideOrders(store, [makeCashBuyOrder('tokA', 'ext1', 0.40)]);
    seedBookSeen(engine, 'tokA', 30_000);

    const eventSpy = vi.spyOn(store, 'recordEvent');
    await callSweep(engine);

    expect(adapter.cancelOrders).toHaveBeenCalledTimes(1);
    expect(adapter.cancelOrders).toHaveBeenCalledWith(['ext1']);
    expect(eventSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'quote.blind-spot-retreat' }));
  });

  it('Type A: 从未拿到盘口 + REST 连失败 3 次 → 真裸单撤退', async () => {
    const adapter = stubPredictAdapter(() => { throw new Error('REST 404'); });
    const { engine, store } = makeEngine(adapter);
    overrideOrders(store, [makeCashBuyOrder('tokA', 'ext1', 0.40)]);
    // 不 seed 盘口 → everHadBook 空, 视为真裸单

    await callSweep(engine); // strike 1
    await callSweep(engine); // strike 2
    const eventSpy = vi.spyOn(store, 'recordEvent');
    await callSweep(engine); // strike 3 → 撤

    expect(adapter.cancelOrders).toHaveBeenCalledTimes(1);
    expect(adapter.cancelOrders).toHaveBeenCalledWith(['ext1']);
    expect(eventSpy).toHaveBeenCalledWith(expect.objectContaining({
      type: 'quote.blind-spot-retreat',
      details: expect.objectContaining({ reasons: expect.arrayContaining([expect.objectContaining({ reason: expect.stringContaining('Type A') })]) })
    }));
  });

  it('Type D: 曾拿到盘口 + REST 连失败 3 次 → 保守撤退', async () => {
    const adapter = stubPredictAdapter(() => { throw new Error('REST 500'); });
    const { engine, store } = makeEngine(adapter);
    overrideOrders(store, [makeCashBuyOrder('tokA', 'ext1', 0.40)]);
    seedBookSeen(engine, 'tokA', 30_000); // everHadBook 已置位

    await callSweep(engine);
    await callSweep(engine);
    const eventSpy = vi.spyOn(store, 'recordEvent');
    await callSweep(engine);

    expect(adapter.cancelOrders).toHaveBeenCalledTimes(1);
    expect(eventSpy).toHaveBeenCalledWith(expect.objectContaining({
      type: 'quote.blind-spot-retreat',
      details: expect.objectContaining({ reasons: expect.arrayContaining([expect.objectContaining({ reason: expect.stringContaining('Type D') })]) })
    }));
  });

  it('Type E: REST 返回空盘（无 BBO）→ 立即撤退，不重试', async () => {
    const adapter = stubPredictAdapter(() => makeBook({
      tokenId: 'tokA',
      bids: [],
      asks: []
    }));
    const { engine, store } = makeEngine(adapter);
    overrideOrders(store, [makeCashBuyOrder('tokA', 'ext1', 0.40)]);
    seedBookSeen(engine, 'tokA', 30_000);

    const eventSpy = vi.spyOn(store, 'recordEvent');
    await callSweep(engine);

    expect(adapter.cancelOrders).toHaveBeenCalledTimes(1);
    expect(adapter.cancelOrders).toHaveBeenCalledWith(['ext1']);
    expect(eventSpy).toHaveBeenCalledWith(expect.objectContaining({
      type: 'quote.blind-spot-retreat',
      details: expect.objectContaining({
        reasons: expect.arrayContaining([expect.objectContaining({ reason: expect.stringContaining('Type E') })])
      })
    }));
    // 冷却写入 retreatedAt，防止立刻回挂
    const retreated = (engine as unknown as { retreatedAt: Map<string, Map<string, number>> })
      .retreatedAt.get('predict')!.get('tokA')!;
    expect(retreated).toBeGreaterThan(0);
  });

  it('频率门控: 沉默 < 20s (近期有 WS 推送) → 跳过 REST, 不撤', async () => {
    const restSpy = vi.fn(() => makeBook({ tokenId: 'tokA', bids: [{ price: 0.41, size: 100 }] }));
    const adapter = stubPredictAdapter(restSpy);
    const { engine, store } = makeEngine(adapter);
    overrideOrders(store, [makeCashBuyOrder('tokA', 'ext1', 0.40)]);
    seedBookSeen(engine, 'tokA', 5_000); // 仅沉默 5s < 20s

    await callSweep(engine);

    expect(restSpy).not.toHaveBeenCalled();
    expect(adapter.cancelOrders).not.toHaveBeenCalled();
  });

  it('低频复核: 最近 REST 已确认安全 → 跳过 REST', async () => {
    const restSpy = vi.fn(() => makeBook({ tokenId: 'tokA', bids: [{ price: 0.41, size: 100 }] }));
    const adapter = stubPredictAdapter(restSpy);
    const { engine, store } = makeEngine(adapter);
    overrideOrders(store, [makeCashBuyOrder('tokA', 'ext1', 0.40)]);
    seedBookSeen(engine, 'tokA', 30_000);
    seedRestSafe(engine, 'tokA', 1_000); // 1s 前刚确认安全

    await callSweep(engine);

    expect(restSpy).not.toHaveBeenCalled();
    expect(adapter.cancelOrders).not.toHaveBeenCalled();
  });

  it('仅 Predict 生效: Polymarket adapter 直接返回, 不碰 REST', async () => {
    const adapter = stubPolymarketAdapter();
    const { engine, store } = makeEngine(adapter, 'polymarket');
    overrideOrders(store, [makeCashBuyOrder('tokA', 'ext1', 0.40)]);

    await callSweep(engine);

    expect(adapter.cancelOrders).not.toHaveBeenCalled();
  });

  it('无受管现金 BUY 单 → 静默 no-op', async () => {
    const adapter = stubPredictAdapter(() => makeBook({ tokenId: 'tokA', bids: [{ price: 0.41, size: 1000 }] }));
    const { engine, store } = makeEngine(adapter);
    overrideOrders(store, []); // 无订单

    await callSweep(engine);

    expect(adapter.cancelOrders).not.toHaveBeenCalled();
  });
});
