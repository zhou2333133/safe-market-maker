import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { appConfigSchema } from '../src/config/schema.js';
import type { Market, Orderbook } from '../src/domain/types.js';
import { RouteService } from '../src/execution/route-service.js';
import { StateStore } from '../src/store/sqlite.js';

const market: Market = {
  venue: 'predict',
  tokenId: 'token-1',
  question: 'Route service?',
  volume24hUsd: 10000,
  liquidityUsd: 15000,
  acceptingOrders: true,
  endTime: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  endTimeSource: 'market-end',
  negRisk: false,
  feeRateBps: 0,
  tickSize: 0.01,
  rewards: { enabled: true, level: 5, minShares: 10, maxSpreadCents: 6, ppPerHour: 4200 }
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

function cashProbeBook(tokenId: string, topPrice = 0.49, topSize = 1000): Orderbook {
  const supportPrice = Number((topPrice - 0.01).toFixed(3));
  const lowerPrice = Number((supportPrice - 0.01).toFixed(3));
  return {
    ...book,
    tokenId,
    bids: [
      { price: topPrice, size: topSize },
      { price: supportPrice, size: 1000 },
      { price: lowerPrice, size: 1000 },
      { price: Number((lowerPrice - 0.01).toFixed(3)), size: 1000 }
    ],
    asks: [{ price: Number((topPrice + 0.02).toFixed(3)), size: 1000 }]
  };
}

function withStore<T>(run: (store: StateStore) => Promise<T> | T): Promise<T> | T {
  const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-route-'));
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

describe('route service', () => {
  it('keeps manual selected markets in manual routing mode', () => {
    withStore((store) => {
      const config = appConfigSchema.parse({
        strategy: { autoSelectMarkets: false },
        selectedMarkets: { predict: [market.tokenId], polymarket: [] }
      });
      const selection = new RouteService(config, store).selectRoutes('predict', [market], new Map([[market.tokenId, book]]), []);

      expect(selection).toMatchObject({
        reason: '手动 selectedMarkets 模式',
        selected: [{ market: { tokenId: market.tokenId }, tradable: true }]
      });
    });
  });

  it('does not mark unsafe manual selected markets as tradable', () => {
    withStore((store) => {
      const config = appConfigSchema.parse({
        risk: { blockUnknownEndTime: true },
        strategy: { autoSelectMarkets: false },
        selectedMarkets: { predict: ['unknown-end-token'], polymarket: [] }
      });
      const unknownEnd: Market = {
        ...market,
        tokenId: 'unknown-end-token',
        endTime: undefined,
        endTimeSource: undefined
      };
      const selection = new RouteService(config, store).selectRoutes('predict', [unknownEnd], new Map(), []);

      expect(selection.selected).toEqual([]);
      expect(selection.candidates[0]).toMatchObject({
        market: { tokenId: unknownEnd.tokenId },
        tradable: false
      });
      expect(selection.candidates[0]?.riskFlags.join(' ')).toContain('结束');
    });
  });

  it('records route checkpoint, selection event, and structured route rejects', () => {
    withStore((store) => {
      const config = appConfigSchema.parse({
        liveEnabled: true,
        risk: { orderSizeUsd: 8, maxSingleOrderUsd: 100, maxPositionUsd: 200, maxMarkets: 1 },
        strategy: { entryMode: 'cash', autoSelectMarkets: true, minMarketLiquidityUsd: 1, minRewardLevel: 0 }
      });
      const unknownEnd: Market = {
        ...market,
        tokenId: 'unknown-end-token',
        question: 'Unknown end market',
        endTime: undefined,
        endTimeSource: undefined
      };
      const service = new RouteService(config, store);
      const safeBook = {
        ...book,
        bids: [
          { price: 0.49, size: 1000 },
          { price: 0.48, size: 1000 },
          { price: 0.47, size: 1000 },
          { price: 0.46, size: 1000 }
        ]
      };
      const selection = service.selectRoutes('predict', [market, unknownEnd], new Map([
        [market.tokenId, safeBook],
        [unknownEnd.tokenId, { ...safeBook, tokenId: unknownEnd.tokenId }]
      ]), []);
      service.recordSelection('predict', selection);

      expect(store.getCheckpoint('route.predict')?.value).toMatchObject({
        reason: expect.any(String),
        selected: expect.arrayContaining([expect.objectContaining({ tokenId: market.tokenId })])
      });
      expect(store.listRecentEvents(10).some((event) => event.type === 'route.selection')).toBe(true);
      const reject = store.listRecentEvents(10).find((event) => event.type === 'risk.market-guard.route-reject');
      expect(reject?.details).toMatchObject({
        reject: {
          reason_code: 'ROUTE_MARKET_GUARD_REJECT',
          category: 'market',
          stage: 'routing-market'
        }
      });
    });
  });

  it('keeps the current cash route when route orderbook coverage is too low for a global switch', () => {
    withStore((store) => {
      const config = appConfigSchema.parse({
        liveEnabled: true,
        risk: {
          orderSizeUsd: 51,
          maxSingleOrderUsd: 100,
          maxPositionUsd: 200,
          maxMarkets: 1,
          minDepthUsdPerSide: 0,
          settlementNoNewOrdersMs: 0,
          eventStartNoNewOrdersMs: 0
        },
        strategy: {
          entryMode: 'cash',
          autoSelectMarkets: true,
          quoteSide: 'buy',
          enforceRewardMinimum: false,
          minMarketLiquidityUsd: 0,
          minRewardLevel: 0,
          switchThresholdPct: 0,
          minSafeHoursForSwitch: 0
        }
      });
      const current: Market = {
        ...market,
        tokenId: 'coverage-current-route',
        marketId: 'coverage-current-route',
        rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 100 }
      };
      const rival: Market = {
        ...market,
        tokenId: 'coverage-rival-route',
        marketId: 'coverage-rival-route',
        rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 5000 }
      };
      store.checkpoint('market-scan.predict', {
        eligibleMetadata: 20,
        scannedOrderbooks: 2,
        routeUsableOrderbooks: 2,
        coveragePct: 10
      });

      const selection = new RouteService(config, store).selectRoutes('predict', [current, rival], new Map([
        [current.tokenId, cashProbeBook(current.tokenId)],
        [rival.tokenId, cashProbeBook(rival.tokenId)]
      ]), [{
        venue: 'predict',
        externalId: 'current-order',
        tokenId: current.tokenId,
        side: 'BUY',
        price: 0.49,
        size: 10,
        status: 'OPEN'
      }]);

      expect(selection.selected[0]?.market.tokenId).toBe(current.tokenId);
      expect(selection.switched).toBe(false);
      expect(selection.reason).toContain('路由盘口覆盖');
    });
  });

  it('allows a cash route switch after enough route orderbook coverage is available', () => {
    withStore((store) => {
      const config = appConfigSchema.parse({
        liveEnabled: true,
        risk: {
          orderSizeUsd: 51,
          maxSingleOrderUsd: 100,
          maxPositionUsd: 200,
          maxMarkets: 1,
          minDepthUsdPerSide: 0,
          settlementNoNewOrdersMs: 0,
          eventStartNoNewOrdersMs: 0
        },
        strategy: {
          entryMode: 'cash',
          autoSelectMarkets: true,
          quoteSide: 'buy',
          enforceRewardMinimum: false,
          minMarketLiquidityUsd: 0,
          minRewardLevel: 0,
          switchThresholdPct: 0,
          minSafeHoursForSwitch: 0
        }
      });
      const current: Market = {
        ...market,
        tokenId: 'coverage-ok-current-route',
        marketId: 'coverage-ok-current-route',
        rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 100 }
      };
      const rival: Market = {
        ...market,
        tokenId: 'coverage-ok-rival-route',
        marketId: 'coverage-ok-rival-route',
        rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 5000 }
      };
      store.checkpoint('market-scan.predict', {
        eligibleMetadata: 20,
        scannedOrderbooks: 2,
        routeUsableOrderbooks: 18,
        coveragePct: 90
      });

      const selection = new RouteService(config, store).selectRoutes('predict', [current, rival], new Map([
        [current.tokenId, cashProbeBook(current.tokenId)],
        [rival.tokenId, cashProbeBook(rival.tokenId)]
      ]), [{
        venue: 'predict',
        externalId: 'current-order',
        tokenId: current.tokenId,
        side: 'BUY',
        price: 0.49,
        size: 10,
        status: 'OPEN'
      }]);

      expect(selection.selected[0]?.market.tokenId).toBe(rival.tokenId);
      expect(selection.switched).toBe(true);
    });
  });

  it('only maintains current cash basket orders while waiting for a fresh full-site audit', () => {
    withStore((store) => {
      const config = appConfigSchema.parse({
        liveEnabled: true,
        risk: {
          orderSizeUsd: 50,
          maxSingleOrderUsd: 100,
          maxPositionUsd: 200,
          maxMarkets: 3,
          minDepthUsdPerSide: 0,
          settlementNoNewOrdersMs: 0,
          eventStartNoNewOrdersMs: 0
        },
        strategy: {
          entryMode: 'cash',
          autoSelectMarkets: true,
          quoteSide: 'buy',
          enforceRewardMinimum: false,
          minMarketLiquidityUsd: 0,
          minRewardLevel: 0,
          switchThresholdPct: 0,
          minSafeHoursForSwitch: 0
        }
      });
      const current: Market = {
        ...market,
        tokenId: 'basket-coverage-current',
        marketId: 'basket-coverage-current',
        rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 100 }
      };
      const rival: Market = {
        ...market,
        tokenId: 'basket-coverage-rival',
        marketId: 'basket-coverage-rival',
        rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 5000 }
      };
      const third: Market = {
        ...market,
        tokenId: 'basket-coverage-third',
        marketId: 'basket-coverage-third',
        rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 4000 }
      };
      store.checkpoint('market-scan.predict', {
        eligibleMetadata: 20,
        scannedOrderbooks: 3,
        routeUsableOrderbooks: 3,
        coveragePct: 15
      });

      const selection = new RouteService(config, store).selectRoutes('predict', [current, rival, third], new Map([
        [current.tokenId, cashProbeBook(current.tokenId)],
        [rival.tokenId, cashProbeBook(rival.tokenId)],
        [third.tokenId, cashProbeBook(third.tokenId)]
      ]), [{
        venue: 'predict',
        externalId: 'current-order',
        tokenId: current.tokenId,
        side: 'BUY',
        price: 0.49,
        size: 10,
        status: 'OPEN'
      }]);

      expect(selection.selected.map((candidate) => candidate.market.tokenId)).toEqual([current.tokenId]);
      expect(selection.switched).toBe(false);
      expect(selection.reason).toContain('等待新鲜完整全站路由审计');
      expect(selection.reason).toContain('禁止用局部 rolling 候选补新市场');
    });
  });

  it('prioritizes the fresh full-site audit basket for cash multi-market execution', () => {
    withStore((store) => {
      const config = appConfigSchema.parse({
        liveEnabled: true,
        risk: {
          orderSizeUsd: 50,
          maxSingleOrderUsd: 100,
          maxPositionUsd: 200,
          maxMarkets: 2,
          minDepthUsdPerSide: 0,
          settlementNoNewOrdersMs: 0,
          eventStartNoNewOrdersMs: 0
        },
        strategy: {
          entryMode: 'cash',
          autoSelectMarkets: true,
          quoteSide: 'buy',
          enforceRewardMinimum: false,
          minMarketLiquidityUsd: 0,
          minRewardLevel: 0,
          maxTokensPerMarket: 2
        }
      });
      const headline: Market = {
        ...market,
        tokenId: 'audit-headline-local',
        marketId: 'audit-headline-local',
        rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 5000 }
      };
      const auditedBest: Market = {
        ...market,
        tokenId: 'audit-basket-best',
        marketId: 'audit-basket-best',
        rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 200 }
      };
      const auditedSecond: Market = {
        ...market,
        tokenId: 'audit-basket-second',
        marketId: 'audit-basket-second',
        rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 180 }
      };
      store.checkpoint('route-audit.predict', {
        capturedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
        coveragePct: 100,
        complete: true,
        source: 'complete-cache',
        executionBasket: [
          { tokenId: auditedBest.tokenId, side: 'BUY', tradable: true },
          { tokenId: auditedSecond.tokenId, side: 'BUY', tradable: true }
        ]
      });

      const selection = new RouteService(config, store).selectRoutes('predict', [headline, auditedBest, auditedSecond], new Map([
        [headline.tokenId, cashProbeBook(headline.tokenId)],
        [auditedBest.tokenId, cashProbeBook(auditedBest.tokenId, 0.49, 220)],
        [auditedSecond.tokenId, cashProbeBook(auditedSecond.tokenId, 0.49, 230)]
      ]), []);

      expect(selection.selected.map((candidate) => candidate.market.tokenId)).toEqual([
        auditedBest.tokenId,
        auditedSecond.tokenId
      ]);
      expect(selection.best?.market.tokenId).toBe(auditedBest.tokenId);
      expect(selection.reason).toContain('现金单边多市场模式');
    });
  });

  it('does not let low-coverage partial route audits reorder cash execution', () => {
    withStore((store) => {
      const config = appConfigSchema.parse({
        liveEnabled: true,
        risk: {
          orderSizeUsd: 50,
          maxSingleOrderUsd: 100,
          maxPositionUsd: 200,
          maxMarkets: 2,
          minDepthUsdPerSide: 0,
          settlementNoNewOrdersMs: 0,
          eventStartNoNewOrdersMs: 0
        },
        strategy: {
          entryMode: 'cash',
          autoSelectMarkets: true,
          quoteSide: 'buy',
          enforceRewardMinimum: false,
          minMarketLiquidityUsd: 0,
          minRewardLevel: 0,
          maxTokensPerMarket: 2
        }
      });
      const highScore: Market = {
        ...market,
        tokenId: 'partial-audit-high-score',
        marketId: 'partial-audit-high-score',
        rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 500 }
      };
      const partialBasketOnly: Market = {
        ...market,
        tokenId: 'partial-audit-basket-only',
        marketId: 'partial-audit-basket-only',
        rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 100 }
      };
      store.checkpoint('route-audit.predict', {
        capturedAt: new Date().toISOString(),
        coveragePct: 10,
        complete: false,
        source: 'manual-full-audit-partial',
        executionBasket: [
          { tokenId: partialBasketOnly.tokenId, side: 'BUY', tradable: true }
        ]
      });

      const selection = new RouteService(config, store).selectRoutes('predict', [highScore, partialBasketOnly], new Map([
        [highScore.tokenId, cashProbeBook(highScore.tokenId, 0.5, 220)],
        [partialBasketOnly.tokenId, cashProbeBook(partialBasketOnly.tokenId, 0.5, 220)]
      ]), []);

      expect(selection.selected).toEqual([]);
      expect(selection.reason).toContain('等待新鲜完整全站路由审计');
      expect(selection.reason).toContain('禁止用局部 rolling 候选新增现金单边市场');
    });
  });

  it('uses a high-coverage rolling audit basket for cash execution while a perfect full-site proof is unavailable', () => {
    withStore((store) => {
      const config = appConfigSchema.parse({
        liveEnabled: true,
        risk: {
          orderSizeUsd: 50,
          maxSingleOrderUsd: 100,
          maxPositionUsd: 200,
          maxMarkets: 2,
          minDepthUsdPerSide: 0,
          settlementNoNewOrdersMs: 0,
          eventStartNoNewOrdersMs: 0
        },
        strategy: {
          entryMode: 'cash',
          autoSelectMarkets: true,
          quoteSide: 'buy',
          enforceRewardMinimum: false,
          minMarketLiquidityUsd: 0,
          minRewardLevel: 0,
          maxTokensPerMarket: 2
        }
      });
      const localHeadline: Market = {
        ...market,
        tokenId: 'high-coverage-local-headline',
        marketId: 'high-coverage-local-headline',
        rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 9000 }
      };
      const auditedBest: Market = {
        ...market,
        tokenId: 'high-coverage-audited-best',
        marketId: 'high-coverage-audited-best',
        rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 300 }
      };
      const auditedSecond: Market = {
        ...market,
        tokenId: 'high-coverage-audited-second',
        marketId: 'high-coverage-audited-second',
        rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 250 }
      };
      store.checkpoint('route-audit.predict', {
        capturedAt: new Date().toISOString(),
        executionBasketCapturedAt: new Date().toISOString(),
        coveragePct: 62.5,
        complete: false,
        source: 'rolling-cache',
        totals: { metadata: 680, eligible: 404, safe: 402, scanned: 321, failed: 81, tradable: 42 },
        failedTokenIds: [],
        executionBasket: [
          { tokenId: auditedBest.tokenId, side: 'BUY', tradable: true },
          { tokenId: auditedSecond.tokenId, side: 'BUY', tradable: true }
        ]
      });

      const selection = new RouteService(config, store).selectRoutes('predict', [localHeadline, auditedBest, auditedSecond], new Map([
        [localHeadline.tokenId, cashProbeBook(localHeadline.tokenId)],
        [auditedBest.tokenId, cashProbeBook(auditedBest.tokenId, 0.49, 220)],
        [auditedSecond.tokenId, cashProbeBook(auditedSecond.tokenId, 0.49, 230)]
      ]), []);

      expect(selection.selected.map((candidate) => candidate.market.tokenId)).toEqual([
        auditedBest.tokenId,
        auditedSecond.tokenId
      ]);
      expect(selection.best?.market.tokenId).toBe(auditedBest.tokenId);
      expect(selection.reason).toContain('使用高覆盖 rolling-cache 审计篮子');
      expect(selection.reason).toContain('coverage=62.50%');
    });
  });

  it('does not use a high-coverage rolling audit basket when one of its tokens just failed orderbook sync', () => {
    withStore((store) => {
      const config = appConfigSchema.parse({
        liveEnabled: true,
        risk: {
          orderSizeUsd: 50,
          maxSingleOrderUsd: 100,
          maxPositionUsd: 200,
          maxMarkets: 2,
          minDepthUsdPerSide: 0,
          settlementNoNewOrdersMs: 0,
          eventStartNoNewOrdersMs: 0
        },
        strategy: {
          entryMode: 'cash',
          autoSelectMarkets: true,
          quoteSide: 'buy',
          enforceRewardMinimum: false,
          minMarketLiquidityUsd: 0,
          minRewardLevel: 0,
          maxTokensPerMarket: 2
        }
      });
      const failedBasket: Market = {
        ...market,
        tokenId: 'high-coverage-failed-basket',
        marketId: 'high-coverage-failed-basket',
        rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 300 }
      };
      const backup: Market = {
        ...market,
        tokenId: 'high-coverage-failed-backup',
        marketId: 'high-coverage-failed-backup',
        rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 250 }
      };
      store.checkpoint('route-audit.predict', {
        capturedAt: new Date().toISOString(),
        executionBasketCapturedAt: new Date().toISOString(),
        coveragePct: 90,
        complete: false,
        source: 'rolling-cache',
        totals: { metadata: 200, eligible: 180, safe: 150, scanned: 135, failed: 15, tradable: 20 },
        failedTokenIds: [failedBasket.tokenId],
        executionBasket: [
          { tokenId: failedBasket.tokenId, side: 'BUY', tradable: true },
          { tokenId: backup.tokenId, side: 'BUY', tradable: true }
        ]
      });

      const selection = new RouteService(config, store).selectRoutes('predict', [failedBasket, backup], new Map([
        [failedBasket.tokenId, cashProbeBook(failedBasket.tokenId, 0.49, 220)],
        [backup.tokenId, cashProbeBook(backup.tokenId, 0.49, 220)]
      ]), []);

      expect(selection.selected).toEqual([]);
      expect(selection.reason).toContain('等待新鲜完整全站路由审计');
    });
  });

  it('does not use rolling partial candidates to add or replace cash basket orders', () => {
    withStore((store) => {
      const config = appConfigSchema.parse({
        liveEnabled: true,
        risk: {
          orderSizeUsd: 50,
          maxSingleOrderUsd: 100,
          maxPositionUsd: 200,
          maxMarkets: 3,
          minDepthUsdPerSide: 0,
          settlementNoNewOrdersMs: 0,
          eventStartNoNewOrdersMs: 0
        },
        strategy: {
          entryMode: 'cash',
          autoSelectMarkets: true,
          quoteSide: 'buy',
          enforceRewardMinimum: false,
          minMarketLiquidityUsd: 0,
          minRewardLevel: 0,
          switchThresholdPct: 0,
          minSafeHoursForSwitch: 0,
          maxTokensPerMarket: 2
        }
      });
      const current: Market = {
        ...market,
        tokenId: 'partial-guard-current',
        marketId: 'partial-guard-current',
        rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 100 }
      };
      const rollingBest: Market = {
        ...market,
        tokenId: 'partial-guard-rolling-best',
        marketId: 'partial-guard-rolling-best',
        rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 9000 }
      };
      const rollingSecond: Market = {
        ...market,
        tokenId: 'partial-guard-rolling-second',
        marketId: 'partial-guard-rolling-second',
        rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 8000 }
      };
      store.checkpoint('route-audit.predict', {
        capturedAt: new Date().toISOString(),
        coveragePct: 20,
        complete: false,
        source: 'rolling-cache',
        executionBasket: [
          { tokenId: rollingBest.tokenId, side: 'BUY', tradable: true },
          { tokenId: rollingSecond.tokenId, side: 'BUY', tradable: true }
        ]
      });

      const selection = new RouteService(config, store).selectRoutes('predict', [current, rollingBest, rollingSecond], new Map([
        [current.tokenId, cashProbeBook(current.tokenId)],
        [rollingBest.tokenId, cashProbeBook(rollingBest.tokenId)],
        [rollingSecond.tokenId, cashProbeBook(rollingSecond.tokenId)]
      ]), [{
        venue: 'predict',
        externalId: 'partial-guard-current-order',
        tokenId: current.tokenId,
        side: 'BUY',
        price: 0.49,
        size: 101,
        status: 'OPEN'
      }]);

      expect(selection.selected.map((candidate) => candidate.market.tokenId)).toEqual([current.tokenId]);
      expect(selection.reason).toContain('等待新鲜完整全站路由审计');
      expect(selection.reason).toContain('只维护已有现金单边订单');
    });
  });

  it('uses the previous route checkpoint as the current cash pool when multiple open orders exist', () => {
    withStore((store) => {
      const config = appConfigSchema.parse({
        liveEnabled: true,
        risk: {
          orderSizeUsd: 50,
          maxSingleOrderUsd: 100,
          maxPositionUsd: 200,
          maxMarkets: 1,
          minDepthUsdPerSide: 0,
          settlementNoNewOrdersMs: 0,
          eventStartNoNewOrdersMs: 0
        },
        strategy: {
          entryMode: 'cash',
          autoSelectMarkets: true,
          quoteSide: 'buy',
          enforceRewardMinimum: false,
          minMarketLiquidityUsd: 0,
          minRewardLevel: 0,
          switchThresholdPct: 0,
          minSafeHoursForSwitch: 0
        }
      });
      const previousRoute: Market = {
        ...market,
        tokenId: 'checkpoint-current-route',
        marketId: 'checkpoint-current-route',
        rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 1000 }
      };
      const strayOpen: Market = {
        ...market,
        tokenId: 'stray-open-route',
        marketId: 'stray-open-route',
        rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 5000 }
      };
      store.checkpoint('route.predict', {
        selected: [{ tokenId: previousRoute.tokenId, marketId: previousRoute.marketId, side: 'BUY' }]
      });
      store.checkpoint('market-scan.predict', {
        eligibleMetadata: 20,
        scannedOrderbooks: 2,
        routeUsableOrderbooks: 2,
        coveragePct: 10
      });

      const selection = new RouteService(config, store).selectRoutes('predict', [previousRoute, strayOpen], new Map([
        [previousRoute.tokenId, cashProbeBook(previousRoute.tokenId)],
        [strayOpen.tokenId, cashProbeBook(strayOpen.tokenId)]
      ]), [
        {
          venue: 'predict',
          externalId: 'previous-route-order',
          tokenId: previousRoute.tokenId,
          side: 'BUY',
          price: 0.49,
          size: 10,
          status: 'OPEN'
        },
        {
          venue: 'predict',
          externalId: 'stray-open-order',
          tokenId: strayOpen.tokenId,
          side: 'BUY',
          price: 0.49,
          size: 10,
          status: 'OPEN'
        }
      ]);

      expect(selection.selected[0]?.market.tokenId).toBe(previousRoute.tokenId);
      expect(selection.switched).toBe(false);
      expect(selection.reason).toContain('路由盘口覆盖');
    });
  });

  it('keeps a recent cash route checkpoint when the current pool orderbook is temporarily missing', () => {
    withStore((store) => {
      const config = appConfigSchema.parse({
        liveEnabled: true,
        risk: {
          orderSizeUsd: 51,
          maxSingleOrderUsd: 100,
          maxPositionUsd: 200,
          maxMarkets: 1,
          minDepthUsdPerSide: 0,
          settlementNoNewOrdersMs: 0,
          eventStartNoNewOrdersMs: 0
        },
        strategy: {
          entryMode: 'cash',
          autoSelectMarkets: true,
          quoteSide: 'buy',
          enforceRewardMinimum: false,
          minMarketLiquidityUsd: 0,
          minRewardLevel: 0,
          switchThresholdPct: 0,
          minSafeHoursForSwitch: 0
        }
      });
      const current: Market = {
        ...market,
        tokenId: 'missing-book-current-route',
        marketId: 'missing-book-current-route',
        rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 6000 }
      };
      const rival: Market = {
        ...market,
        tokenId: 'missing-book-rival-route',
        marketId: 'missing-book-rival-route',
        rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 5000 }
      };
      store.checkpoint('route.predict', {
        selected: [{ tokenId: current.tokenId, marketId: current.marketId, side: 'BUY' }]
      });
      store.checkpoint('market-scan.predict', {
        eligibleMetadata: 20,
        scannedOrderbooks: 20,
        routeUsableOrderbooks: 20,
        coveragePct: 100
      });

      const selection = new RouteService(config, store).selectRoutes('predict', [current, rival], new Map([
        [rival.tokenId, cashProbeBook(rival.tokenId)]
      ]), [{
        venue: 'predict',
        externalId: 'current-open-order',
        tokenId: current.tokenId,
        side: 'BUY',
        price: 0.49,
        size: 101,
        status: 'OPEN'
      }]);

      expect(selection.selected[0]?.market.tokenId).toBe(current.tokenId);
      expect(selection.selected[0]?.tradable).toBe(false);
      expect(selection.switched).toBe(false);
      expect(selection.reason).toContain('盘口暂不可用');
      expect(selection.reason).toContain('局部可见');
      expect(store.getCheckpoint('route-missing-book.predict')?.value).toMatchObject({
        tokenId: current.tokenId,
        status: 'missing'
      });
    });
  });

  it('excludes recently filled cash markets from the multi-market basket', () => {
    withStore((store) => {
      const config = appConfigSchema.parse({
        liveEnabled: true,
        risk: {
          orderSizeUsd: 51,
          maxSingleOrderUsd: 100,
          maxPositionUsd: 200,
          maxMarkets: 2,
          minDepthUsdPerSide: 0,
          settlementNoNewOrdersMs: 0,
          eventStartNoNewOrdersMs: 0
        },
        strategy: {
          entryMode: 'cash',
          autoSelectMarkets: true,
          quoteSide: 'buy',
          enforceRewardMinimum: false,
          minMarketLiquidityUsd: 0,
          minRewardLevel: 0,
          switchThresholdPct: 0,
          minSafeHoursForSwitch: 0
        }
      });
      const filled: Market = {
        ...market,
        tokenId: 'recent-fill-token',
        marketId: 'recent-fill-market',
        rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 5000 }
      };
      const backup: Market = {
        ...market,
        tokenId: 'recent-fill-backup',
        marketId: 'recent-fill-backup',
        rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 1000 }
      };
      store.recordEvent({
        venue: 'predict',
        severity: 'error',
        type: 'fill-circuit-breaker.triggered',
        message: 'cash fill',
        details: {
          positions: [{ tokenId: filled.tokenId, marketId: filled.marketId, outcome: 'Yes', size: 101, notionalUsd: 30 }]
        }
      });
      store.checkpoint('route-audit.predict', {
        capturedAt: new Date().toISOString(),
        coveragePct: 100,
        complete: true,
        source: 'complete-cache',
        executionBasket: [
          { tokenId: filled.tokenId, side: 'BUY', tradable: true },
          { tokenId: backup.tokenId, side: 'BUY', tradable: true }
        ]
      });

      const selection = new RouteService(config, store).selectRoutes('predict', [filled, backup], new Map([
        [filled.tokenId, cashProbeBook(filled.tokenId)],
        [backup.tokenId, cashProbeBook(backup.tokenId)]
      ]), []);

      expect(selection.selected.map((candidate) => candidate.market.tokenId)).toEqual([backup.tokenId]);
      expect(selection.candidates.find((candidate) => candidate.market.tokenId === filled.tokenId)).toMatchObject({
        tradable: false,
        riskFlags: [expect.stringContaining('本轮实盘已在该 市场 被吃单')]
      });
    });
  });

  it('does not retain a current cash basket token that filled during the live session', () => {
    withStore((store) => {
      const config = appConfigSchema.parse({
        liveEnabled: true,
        risk: {
          orderSizeUsd: 51,
          maxSingleOrderUsd: 100,
          maxPositionUsd: 200,
          maxMarkets: 2,
          minDepthUsdPerSide: 0,
          settlementNoNewOrdersMs: 0,
          eventStartNoNewOrdersMs: 0
        },
        strategy: {
          entryMode: 'cash',
          autoSelectMarkets: true,
          quoteSide: 'buy',
          enforceRewardMinimum: false,
          minMarketLiquidityUsd: 0,
          minRewardLevel: 0,
          switchThresholdPct: 0,
          minSafeHoursForSwitch: 0
        }
      });
      const filled: Market = {
        ...market,
        tokenId: 'session-fill-current-token',
        marketId: 'session-fill-current-market',
        rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 5000 }
      };
      const backup: Market = {
        ...market,
        tokenId: 'session-fill-backup',
        marketId: 'session-fill-backup',
        rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 1000 }
      };
      store.checkpoint('live-session.predict', {
        startedAt: new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString()
      });
      store.checkpoint('route.predict', {
        selected: [{ tokenId: filled.tokenId, marketId: filled.marketId, side: 'BUY' }]
      });
      store.recordEvent({
        venue: 'predict',
        severity: 'error',
        type: 'fill-circuit-breaker.triggered',
        message: 'cash fill',
        details: {
          positions: [{ tokenId: filled.tokenId, marketId: filled.marketId, outcome: 'Yes', size: 101, notionalUsd: 30 }]
        }
      });
      store.checkpoint('route-audit.predict', {
        capturedAt: new Date().toISOString(),
        coveragePct: 100,
        complete: true,
        source: 'complete-cache',
        executionBasket: [
          { tokenId: filled.tokenId, side: 'BUY', tradable: true },
          { tokenId: backup.tokenId, side: 'BUY', tradable: true }
        ]
      });

      const selection = new RouteService(config, store).selectRoutes('predict', [filled, backup], new Map([
        [filled.tokenId, cashProbeBook(filled.tokenId)],
        [backup.tokenId, cashProbeBook(backup.tokenId)]
      ]), [{
        venue: 'predict',
        externalId: 'current-filled-order',
        tokenId: filled.tokenId,
        side: 'BUY',
        price: 0.49,
        size: 101,
        status: 'OPEN'
      }]);

      expect(selection.selected.map((candidate) => candidate.market.tokenId)).toEqual([backup.tokenId]);
      expect(selection.candidates.find((candidate) => candidate.market.tokenId === filled.tokenId)).toMatchObject({
        tradable: false,
        riskFlags: [expect.stringContaining('本轮实盘已在该 市场 被吃单')]
      });
    });
  });

  it('excludes cash markets that were filled before the current session but still inside the recent risk window', () => {
    withStore((store) => {
      const config = appConfigSchema.parse({
        liveEnabled: true,
        risk: {
          orderSizeUsd: 51,
          maxSingleOrderUsd: 100,
          maxPositionUsd: 200,
          maxMarkets: 2,
          minDepthUsdPerSide: 0,
          settlementNoNewOrdersMs: 0,
          eventStartNoNewOrdersMs: 0
        },
        strategy: {
          entryMode: 'cash',
          autoSelectMarkets: true,
          quoteSide: 'buy',
          enforceRewardMinimum: false,
          minMarketLiquidityUsd: 0,
          minRewardLevel: 0,
          switchThresholdPct: 0,
          minSafeHoursForSwitch: 0
        }
      });
      const historicalFill: Market = {
        ...market,
        tokenId: 'historical-fill-token',
        marketId: 'historical-fill-market',
        rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 5000 }
      };
      const sameMarketOtherOutcome: Market = {
        ...market,
        tokenId: 'historical-fill-other-outcome',
        marketId: historicalFill.marketId,
        outcome: 'No',
        rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 4000 }
      };
      const backup: Market = {
        ...market,
        tokenId: 'historical-fill-backup',
        marketId: 'historical-fill-backup',
        rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 1000 }
      };
      store.recordEvent({
        venue: 'predict',
        severity: 'error',
        type: 'fill-circuit-breaker.triggered',
        message: 'old cash fill before current session',
        details: {
          positions: [{ tokenId: historicalFill.tokenId, marketId: historicalFill.marketId, outcome: 'Yes', size: 101, notionalUsd: 30 }]
        }
      });
      store.checkpoint('live-session.predict', {
        startedAt: new Date(Date.now() + 1).toISOString()
      });
      store.checkpoint('route-audit.predict', {
        capturedAt: new Date().toISOString(),
        coveragePct: 100,
        complete: true,
        source: 'complete-cache',
        executionBasket: [
          { tokenId: historicalFill.tokenId, side: 'BUY', tradable: true },
          { tokenId: sameMarketOtherOutcome.tokenId, side: 'BUY', tradable: true },
          { tokenId: backup.tokenId, side: 'BUY', tradable: true }
        ]
      });

      const selection = new RouteService(config, store).selectRoutes('predict', [historicalFill, sameMarketOtherOutcome, backup], new Map([
        [historicalFill.tokenId, cashProbeBook(historicalFill.tokenId)],
        [sameMarketOtherOutcome.tokenId, cashProbeBook(sameMarketOtherOutcome.tokenId)],
        [backup.tokenId, cashProbeBook(backup.tokenId)]
      ]), []);

      expect(selection.selected.map((candidate) => candidate.market.tokenId)).toEqual([backup.tokenId]);
      expect(selection.candidates.find((candidate) => candidate.market.tokenId === historicalFill.tokenId)).toMatchObject({
        tradable: false,
        riskFlags: [expect.stringContaining('近 7 天已在该 市场 被吃单')]
      });
      expect(selection.candidates.find((candidate) => candidate.market.tokenId === sameMarketOtherOutcome.tokenId)).toMatchObject({
        tradable: false,
        riskFlags: [expect.stringContaining('近 7 天已在该 市场 被吃单')]
      });
    });
  });
});
