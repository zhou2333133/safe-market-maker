import { describe, expect, it } from 'vitest';
import { appConfigSchema } from '../src/config/schema.js';
import type { AccountRiskDecision, Market, OpenOrder, Orderbook, Position } from '../src/domain/types.js';
import { computeStartupFacts } from '../src/execution/startup-facts.js';
import { normalizePolymarketCollateralBalance } from '../src/venues/account-normalize.js';

const okRisk: AccountRiskDecision = {
  ok: true,
  venue: 'predict',
  reason: 'ok',
  maxDailyLossUsd: 10,
  dailyPnlUsd: 0,
  warnings: [],
  message: '账户级日内风控通过'
};

describe('startup facts', () => {
  it('shows 19U balance with 8U dual-side and no inventory becomes BUY-only', () => {
    const config = appConfigSchema.parse({
      liveEnabled: true,
      risk: { orderSizeUsd: 8, maxSingleOrderUsd: 8, maxPositionUsd: 20, maxMarkets: 2 },
      strategy: { entryMode: 'cash', quoteSide: 'both', balanceReserveUsd: 1, enforceRewardMinimum: false }
    });
    const facts = computeStartupFacts({
      config,
      venue: 'predict',
      address: '0xabc',
      balances: [{ asset: 'USDT', available: 19, total: 19 }],
      positions: [],
      openOrders: [],
      accountRisk: okRisk,
      checkedAt: new Date('2026-05-20T00:00:00Z')
    });

    expect(facts.funds).toMatchObject({
      availableUsd: 19,
      reserveUsd: 1,
      spendableUsd: 18,
      targetOrderUsd: 8,
      maxAffordableOrders: 2
    });
    expect(facts.readyToQuote).toBe(true);
    expect(facts.expected).toEqual({ buyOrders: 2, sellOrders: 0, totalOrders: 2 });
    expect(facts.sides.BUY.status).toBe('ready');
    expect(facts.sides.SELL.status).toBe('skipped');
    expect(facts.sides.SELL.reason).toContain('没有可卖库存');
  });

  it('warns and enforces strict PP minimums when cash orders are below the estimated reward minimum', () => {
    const config = appConfigSchema.parse({
      liveEnabled: true,
      risk: { orderSizeUsd: 8, maxSingleOrderUsd: 100, maxPositionUsd: 100, maxMarkets: 1 },
      strategy: { entryMode: 'cash', quoteSide: 'buy', balanceReserveUsd: 1, enforceRewardMinimum: false, minMarketLiquidityUsd: 0, minRewardLevel: 0 }
    });
    const facts = computeStartupFacts({
      config,
      venue: 'predict',
      address: '0xabc',
      balances: [{ asset: 'USDT', available: 40, total: 40 }],
      positions: [],
      openOrders: [],
      accountRisk: okRisk,
      markets: [{
        venue: 'predict',
        tokenId: 'reward-minimum-token',
        question: 'Reward minimum?',
        volume24hUsd: 10000,
        liquidityUsd: 10000,
        acceptingOrders: true,
        endTime: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        endTimeSource: 'reward-end',
        negRisk: false,
        feeRateBps: 0,
        tickSize: 0.01,
        rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 500 }
      }]
    });

    expect(facts.readyToQuote).toBe(true);
    expect(facts.rewardMinimum).toMatchObject({
      enforce: true,
      checked: 1,
      underfunded: 1,
      highestMinimumUsd: 50.5
    });
    expect(facts.rewardMinimum.message).toContain('候选不会下单');
  });

  it('accounts for existing open-order reservation before saying BUY can quote', () => {
    const config = appConfigSchema.parse({
      liveEnabled: true,
      risk: { orderSizeUsd: 8, maxSingleOrderUsd: 8, maxPositionUsd: 20, maxMarkets: 2 },
      strategy: { entryMode: 'cash', quoteSide: 'buy', balanceReserveUsd: 1 }
    });
    const openOrders: OpenOrder[] = [{
      venue: 'predict',
      externalId: 'order-1',
      tokenId: 'token-1',
      side: 'BUY',
      price: 0.5,
      size: 20,
      status: 'OPEN'
    }];

    const facts = computeStartupFacts({
      config,
      venue: 'predict',
      address: '0xabc',
      balances: [{ asset: 'USDT', available: 19, total: 19 }],
      positions: [],
      openOrders,
      accountRisk: okRisk
    });

    expect(facts.funds.reservedOpenOrdersUsd).toBe(10);
    expect(facts.funds.spendableUsd).toBe(8);
    expect(facts.expected.buyOrders).toBe(1);
  });

  it('blocks startup when estimated open-order reservation does not match platform frozen balance', () => {
    const config = appConfigSchema.parse({
      liveEnabled: true,
      risk: {
        orderSizeUsd: 8,
        maxSingleOrderUsd: 8,
        maxPositionUsd: 20,
        maxOpenOrderReserveDriftUsd: 2,
        maxOpenOrderReserveDriftPct: 25
      },
      strategy: { entryMode: 'cash', quoteSide: 'buy', balanceReserveUsd: 1 }
    });
    const openOrders: OpenOrder[] = [{
      venue: 'predict',
      externalId: 'order-1',
      tokenId: 'token-1',
      side: 'BUY',
      price: 0.5,
      size: 10,
      status: 'OPEN'
    }];

    const facts = computeStartupFacts({
      config,
      venue: 'predict',
      address: '0xabc',
      balances: [{ asset: 'USDT', available: 19, total: 40 }],
      positions: [],
      openOrders,
      accountRisk: okRisk
    });

    expect(facts.readyToQuote).toBe(false);
    expect(facts.funds).toMatchObject({
      reservedOpenOrdersUsd: 5,
      actualFrozenUsd: 21,
      reserveDriftOk: false
    });
    expect(facts.blockingReasons.join(' ')).toContain('偏差过大');
  });

  it('uses platform available balance as already net of frozen funds when drift is valid', () => {
    const config = appConfigSchema.parse({
      liveEnabled: true,
      risk: {
        orderSizeUsd: 8,
        maxSingleOrderUsd: 8,
        maxPositionUsd: 20,
        maxOpenOrderReserveDriftUsd: 2,
        maxOpenOrderReserveDriftPct: 25,
        maxMarkets: 2
      },
      strategy: { entryMode: 'cash', quoteSide: 'buy', balanceReserveUsd: 1 }
    });
    const openOrders: OpenOrder[] = [{
      venue: 'polymarket',
      externalId: 'order-1',
      tokenId: 'token-1',
      side: 'BUY',
      price: 0.5,
      size: 42,
      status: 'OPEN'
    }];

    const facts = computeStartupFacts({
      config,
      venue: 'polymarket',
      address: '0xabc',
      balances: [{ asset: 'USDC', available: 19, total: 40 }],
      positions: [],
      openOrders,
      accountRisk: { ...okRisk, venue: 'polymarket' }
    });

    expect(facts.readyToQuote).toBe(true);
    expect(facts.funds).toMatchObject({
      availableUsd: 19,
      totalUsd: 40,
      reservedOpenOrdersUsd: 21,
      actualFrozenUsd: 21,
      spendableUsd: 18,
      maxAffordableOrders: 2,
      reserveDriftOk: true
    });
  });

  it('treats Polymarket official balance allowance as estimate-only open-order reservation', () => {
    const config = appConfigSchema.parse({
      liveEnabled: true,
      risk: {
        orderSizeUsd: 8,
        maxSingleOrderUsd: 8,
        maxPositionUsd: 20,
        maxOpenOrderReserveDriftUsd: 2,
        maxOpenOrderReserveDriftPct: 25,
        maxMarkets: 2
      },
      strategy: { entryMode: 'cash', quoteSide: 'buy', balanceReserveUsd: 1 }
    });
    const openOrders: OpenOrder[] = [{
      venue: 'polymarket',
      externalId: 'partially-open-buy',
      tokenId: 'token-1',
      side: 'BUY',
      price: 0.5,
      size: 20,
      status: 'OPEN'
    }];

    const facts = computeStartupFacts({
      config,
      venue: 'polymarket',
      address: '0xabc',
      balances: normalizePolymarketCollateralBalance({ balance: '40.00', allowance: '999999' }),
      positions: [],
      openOrders,
      accountRisk: { ...okRisk, venue: 'polymarket' }
    });

    expect(facts.readyToQuote).toBe(true);
    expect(facts.funds).toMatchObject({
      availableUsd: 40,
      totalUsd: 40,
      reservedOpenOrdersUsd: 10,
      spendableUsd: 29,
      maxAffordableOrders: 3,
      maxBuyOrdersByFunds: 2,
      reserveDriftOk: true
    });
    expect(facts.funds.actualFrozenUsd).toBeUndefined();
    expect(facts.funds.reserveDriftMessage).toContain('估算处理');
  });

  it('uses Polymarket available plus locked fields for actual frozen drift checks when exposed', () => {
    const config = appConfigSchema.parse({
      liveEnabled: true,
      risk: {
        orderSizeUsd: 8,
        maxSingleOrderUsd: 8,
        maxPositionUsd: 20,
        maxOpenOrderReserveDriftUsd: 2,
        maxOpenOrderReserveDriftPct: 25,
        maxMarkets: 2
      },
      strategy: { entryMode: 'cash', quoteSide: 'buy', balanceReserveUsd: 1 }
    });
    const openOrders: OpenOrder[] = [{
      venue: 'polymarket',
      externalId: 'remaining-open-buy',
      tokenId: 'token-1',
      side: 'BUY',
      price: 0.5,
      size: 20,
      status: 'OPEN'
    }];

    const facts = computeStartupFacts({
      config,
      venue: 'polymarket',
      address: '0xabc',
      balances: normalizePolymarketCollateralBalance({ data: { available: '19.00', locked: '10.00' } }),
      positions: [],
      openOrders,
      accountRisk: { ...okRisk, venue: 'polymarket' }
    });

    expect(facts.readyToQuote).toBe(true);
    expect(facts.funds).toMatchObject({
      availableUsd: 19,
      totalUsd: 29,
      reservedOpenOrdersUsd: 10,
      actualFrozenUsd: 10,
      spendableUsd: 18,
      maxAffordableOrders: 2,
      reserveDriftOk: true
    });
  });

  it('blocks startup facts when account-level risk is not verifiable', () => {
    const config = appConfigSchema.parse({
      liveEnabled: true,
      risk: { orderSizeUsd: 8, maxSingleOrderUsd: 8, maxPositionUsd: 20 },
      strategy: { entryMode: 'cash', quoteSide: 'buy', balanceReserveUsd: 1 }
    });
    const facts = computeStartupFacts({
      config,
      venue: 'predict',
      address: '0xabc',
      balances: [{ asset: 'USDT', available: 19, total: 19 }],
      positions: [],
      openOrders: []
    });

    expect(facts.readyToQuote).toBe(false);
    expect(facts.blockingReasons.join(' ')).toContain('账户级风控未检查');
  });

  it('keeps startup possible when only part of the candidate markets have unsafe end times', () => {
    const config = appConfigSchema.parse({
      liveEnabled: true,
      risk: { orderSizeUsd: 8, maxSingleOrderUsd: 8, maxPositionUsd: 20 },
      strategy: { entryMode: 'cash', quoteSide: 'buy', balanceReserveUsd: 1 }
    });
    const facts = computeStartupFacts({
      config,
      venue: 'predict',
      address: '0xabc',
      balances: [{ asset: 'USDT', available: 19, total: 19 }],
      positions: [],
      openOrders: [],
      accountRisk: okRisk,
      markets: [
        {
          venue: 'predict',
          tokenId: 'unknown-end',
          question: 'Unknown end',
          volume24hUsd: 10000,
          liquidityUsd: 10000,
          acceptingOrders: true,
          negRisk: false,
          feeRateBps: 0,
          tickSize: 0.01,
          rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 3000 }
        },
        {
          venue: 'predict',
          tokenId: 'safe-end',
          question: 'Safe end',
          volume24hUsd: 10000,
          liquidityUsd: 10000,
          acceptingOrders: true,
          endTime: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          endTimeSource: 'market-end',
          negRisk: false,
          feeRateBps: 0,
          tickSize: 0.01,
          rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 3000 }
        }
      ]
    });

    expect(facts.marketGuard).toMatchObject({ checked: 2, blocked: 1, ok: true });
    expect(facts.readyToQuote).toBe(true);
  });

  it('does not block startup just because the old top candidateLimit markets have unsafe end time when later eligible markets are safe', () => {
    const config = appConfigSchema.parse({
      liveEnabled: true,
      risk: { orderSizeUsd: 8, maxSingleOrderUsd: 8, maxPositionUsd: 20, maxMarkets: 2, blockUnknownEndTime: true },
      strategy: { entryMode: 'cash', quoteSide: 'buy', balanceReserveUsd: 1, candidateLimit: 12 }
    });
    const unknownMarkets: Market[] = Array.from({ length: 12 }, (_, index) => ({
      venue: 'predict',
      tokenId: `unknown-end-${index}`,
      question: `Unknown end ${index}`,
      volume24hUsd: 10000,
      liquidityUsd: 10000,
      acceptingOrders: true,
      negRisk: false,
      feeRateBps: 0,
      tickSize: 0.01,
      rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 3000 }
    }));
    const laterSafeMarkets: Market[] = Array.from({ length: 8 }, (_, index) => ({
      venue: 'predict',
      tokenId: `safe-end-${index}`,
      question: `Safe end ${index}`,
      volume24hUsd: 10000,
      liquidityUsd: 10000,
      acceptingOrders: true,
      endTime: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      endTimeSource: 'market-end',
      negRisk: false,
      feeRateBps: 0,
      tickSize: 0.01,
      rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 3000 }
    }));

    const facts = computeStartupFacts({
      config,
      venue: 'predict',
      address: '0xabc',
      balances: [{ asset: 'USDT', available: 19, total: 19 }],
      positions: [],
      openOrders: [],
      accountRisk: okRisk,
      markets: [...unknownMarkets, ...laterSafeMarkets]
    });

    expect(facts.marketGuard).toMatchObject({
      ok: true,
      checked: 20,
      blocked: 12,
      unknownEndTime: 12
    });
    expect(facts.readyToQuote).toBe(true);
    expect(facts.blockingReasons.join(' ')).not.toContain('启动候选市场全部存在结束时间风险');
  });

  it('checks only strategy-eligible startup candidates for end-time blocking', () => {
    const config = appConfigSchema.parse({
      liveEnabled: true,
      risk: { orderSizeUsd: 8, maxSingleOrderUsd: 8, maxPositionUsd: 20, maxMarkets: 1, blockUnknownEndTime: true },
      strategy: { entryMode: 'cash', quoteSide: 'buy', balanceReserveUsd: 1, candidateLimit: 3, pointsOnly: true, minMarketLiquidityUsd: 10000, minRewardLevel: 5 }
    });
    const inactiveUnknownMarkets: Market[] = Array.from({ length: 3 }, (_, index) => ({
      venue: 'predict',
      tokenId: `inactive-unknown-${index}`,
      question: `Inactive unknown ${index}`,
      volume24hUsd: 10000,
      liquidityUsd: 50000,
      acceptingOrders: true,
      negRisk: false,
      feeRateBps: 0,
      tickSize: 0.01,
      rewards: { enabled: false, level: 5, minShares: 100, maxSpreadCents: 6 }
    }));
    const activeSafe: Market = {
      venue: 'predict',
      tokenId: 'active-safe',
      question: 'Active safe',
      volume24hUsd: 10000,
      liquidityUsd: 10000,
      acceptingOrders: true,
      endTime: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      endTimeSource: 'reward-end',
      negRisk: false,
      feeRateBps: 0,
      tickSize: 0.01,
      rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 3000 }
    };

    const facts = computeStartupFacts({
      config,
      venue: 'predict',
      address: '0xabc',
      balances: [{ asset: 'USDT', available: 19, total: 19 }],
      positions: [],
      openOrders: [],
      accountRisk: okRisk,
      markets: [...inactiveUnknownMarkets, activeSafe]
    });

    expect(facts.marketGuard).toMatchObject({ ok: true, checked: 1, blocked: 0 });
    expect(facts.readyToQuote).toBe(true);
  });

  it('reports SELL as conditional when there is inventory for at least one token', () => {
    const config = appConfigSchema.parse({
      liveEnabled: true,
      risk: { orderSizeUsd: 8, maxSingleOrderUsd: 8, maxPositionUsd: 20, maxMarkets: 2 },
      strategy: { entryMode: 'cash', quoteSide: 'sell', balanceReserveUsd: 1 }
    });
    const positions: Position[] = [{
      venue: 'predict',
      tokenId: 'token-1',
      size: 20,
      notionalUsd: 10
    }];

    const facts = computeStartupFacts({
      config,
      venue: 'predict',
      address: '0xabc',
      balances: [{ asset: 'USDT', available: 0, total: 0 }],
      positions,
      openOrders: [],
      accountRisk: okRisk
    });

    expect(facts.readyToQuote).toBe(true);
    expect(facts.expected).toEqual({ buyOrders: 0, sellOrders: 1, totalOrders: 1 });
    expect(facts.sides.SELL.status).toBe('conditional');
  });

  it('treats inventory mode as covered SELL only and does not plan cash BUY orders', () => {
    const config = appConfigSchema.parse({
      liveEnabled: true,
      risk: { orderSizeUsd: 8, maxSingleOrderUsd: 8, maxPositionUsd: 20, maxMarkets: 2 },
      strategy: { entryMode: 'inventory', quoteSide: 'both', balanceReserveUsd: 1 }
    });
    const facts = computeStartupFacts({
      config,
      venue: 'predict',
      address: '0xabc',
      balances: [{ asset: 'USDT', available: 100, total: 100 }],
      positions: [{ venue: 'predict', tokenId: 'token-1', size: 20, notionalUsd: 10 }],
      openOrders: [],
      accountRisk: okRisk
    });

    expect(facts.requestedSides).toEqual(['SELL']);
    expect(facts.expected).toEqual({ buyOrders: 0, sellOrders: 1, totalOrders: 1 });
    expect(facts.sides.BUY.requested).toBe(false);
    expect(facts.sides.SELL.status).toBe('conditional');
  });

  it('allows predict split mode to start without existing inventory when a split-capable pair is visible', () => {
    const config = appConfigSchema.parse({
      liveEnabled: true,
      risk: { orderSizeUsd: 8, maxSingleOrderUsd: 8, maxPositionUsd: 20, maxMarkets: 2 },
      strategy: { entryMode: 'split', quoteSide: 'both', balanceReserveUsd: 1, minMarketLiquidityUsd: 0, minRewardLevel: 0 }
    });
    const markets = splitMarkets();
    const facts = computeStartupFacts({
      config,
      venue: 'predict',
      address: '0xabc',
      balances: [{ asset: 'USDT', available: 19, total: 19 }],
      positions: [],
      markets,
      openOrders: [],
      accountRisk: okRisk
    });

    expect(facts.requestedSides).toEqual(['SELL']);
    expect(facts.readyToQuote).toBe(true);
    expect(facts.expected).toEqual({ buyOrders: 0, sellOrders: 2, totalOrders: 2 });
    expect(facts.sides.SELL.status).toBe('conditional');
    expect(facts.sides.SELL.reason).toContain('拆分完整 YES/NO 套仓');
    expect(facts.summary).toContain('拆分完整 YES/NO 套仓');
    expect(facts.blockingReasons.join(' ')).not.toContain('没有可卖库存');
    expect(facts.splitEntry).toMatchObject({
      active: true,
      supported: true,
      hasCompleteInventory: false,
      canAttempt: true,
      status: 'ready-to-split',
      candidatePairs: 1,
      conditionReadyPairs: 1,
      plannedSellOrders: 2
    });
  });

  it('shows full-order split funding only as an estimate and keeps the platform split minimum separate', () => {
    const config = appConfigSchema.parse({
      liveEnabled: true,
      risk: { orderSizeUsd: 8, maxSingleOrderUsd: 100, maxPositionUsd: 100, maxMarkets: 1 },
      strategy: {
        entryMode: 'split',
        quoteSide: 'both',
        balanceReserveUsd: 1,
        minMarketLiquidityUsd: 0,
        minRewardLevel: 0,
        enforceRewardMinimum: false,
        conservativeDepthLevel: 2,
        retreatTicks: 1
      }
    });
    const [yes, no] = splitMarkets();
    const books = new Map<string, Orderbook>([
      [yes!.tokenId, splitBook(yes!.tokenId, 0.27)],
      [no!.tokenId, splitBook(no!.tokenId, 0.31)]
    ]);

    const facts = computeStartupFacts({
      config,
      venue: 'predict',
      address: '0xabc',
      balances: [{ asset: 'USDT', available: 40, total: 40 }],
      positions: [],
      markets: [yes!, no!],
      books,
      openOrders: [],
      accountRisk: okRisk
    });

    expect(facts.readyToQuote).toBe(true);
    expect(facts.splitEntry).toMatchObject({
      status: 'ready-to-split',
      estimatedMinimumSplitUsd: 1,
      estimatedFullOrderSplitUsd: 28.5714
    });
    expect(facts.splitEntry?.message).toContain('$28.57');
  });

  it('blocks split startup when only one leg exposes a condition id', () => {
    const config = appConfigSchema.parse({
      liveEnabled: true,
      risk: { orderSizeUsd: 8, maxSingleOrderUsd: 8, maxPositionUsd: 20, maxMarkets: 2 },
      strategy: { entryMode: 'split', quoteSide: 'both', balanceReserveUsd: 1, minMarketLiquidityUsd: 0, minRewardLevel: 0 }
    });
    const [yes, no] = splitMarkets();
    const facts = computeStartupFacts({
      config,
      venue: 'predict',
      address: '0xabc',
      balances: [{ asset: 'USDT', available: 19, total: 19 }],
      positions: [],
      markets: [
        { ...yes!, conditionId: 'condition-1' },
        { ...no!, conditionId: undefined }
      ],
      openOrders: [],
      accountRisk: okRisk
    });

    expect(facts.readyToQuote).toBe(false);
    expect(facts.expected).toEqual({ buyOrders: 0, sellOrders: 0, totalOrders: 0 });
    expect(facts.splitEntry).toMatchObject({
      status: 'condition-missing',
      candidatePairs: 1,
      conditionReadyPairs: 0
    });
    expect(facts.blockingReasons.join(' ')).toContain('conditionId');
  });

  it('does not block split startup when spendable balance is below the full target-order estimate but above platform minimum', () => {
    const config = appConfigSchema.parse({
      liveEnabled: true,
      risk: { orderSizeUsd: 8, maxSingleOrderUsd: 100, maxPositionUsd: 100, maxMarkets: 1 },
      strategy: {
        entryMode: 'split',
        quoteSide: 'both',
        balanceReserveUsd: 1,
        minMarketLiquidityUsd: 0,
        minRewardLevel: 0,
        enforceRewardMinimum: false,
        conservativeDepthLevel: 2,
        retreatTicks: 1
      }
    });
    const [yes, no] = splitMarkets();
    const books = new Map<string, Orderbook>([
      [yes!.tokenId, splitBook(yes!.tokenId, 0.27)],
      [no!.tokenId, splitBook(no!.tokenId, 0.31)]
    ]);

    const facts = computeStartupFacts({
      config,
      venue: 'predict',
      address: '0xabc',
      balances: [{ asset: 'USDT', available: 20, total: 20 }],
      positions: [],
      markets: [yes!, no!],
      books,
      openOrders: [],
      accountRisk: okRisk
    });

    expect(facts.readyToQuote).toBe(true);
    expect(facts.expected).toEqual({ buyOrders: 0, sellOrders: 2, totalOrders: 2 });
    expect(facts.splitEntry).toMatchObject({
      status: 'ready-to-split',
      estimatedMinimumSplitUsd: 1,
      estimatedFullOrderSplitUsd: 28.5714
    });
    expect(facts.blockingReasons.join(' ')).not.toContain('完整套仓至少需要 $28.57');
    expect(facts.splitEntry?.message).toContain('按实际库存缩小或跳过挂单');
  });

  it('warns split startup when BNB cannot pay the automatic split transaction', () => {
    const config = appConfigSchema.parse({
      liveEnabled: true,
      risk: { orderSizeUsd: 8, maxSingleOrderUsd: 100, maxPositionUsd: 100, maxMarkets: 1 },
      strategy: {
        entryMode: 'split',
        quoteSide: 'both',
        balanceReserveUsd: 1,
        minMarketLiquidityUsd: 0,
        minRewardLevel: 0,
        enforceRewardMinimum: false
      }
    });
    const [yes, no] = splitMarkets();
    const facts = computeStartupFacts({
      config,
      venue: 'predict',
      address: '0xabc',
      balances: [{ asset: 'USDT', available: 20, total: 20 }],
      positions: [],
      markets: [yes!, no!],
      openOrders: [],
      accountRisk: okRisk,
      nativeGas: {
        asset: 'BNB',
        balance: 0,
        address: '0x1111111111111111111111111111111111111111',
        label: '签名钱包 / split-merge 手续费地址',
        required: 0.0001,
        ok: false,
        message: 'BNB 手续费余额不足，不能发起 split/merge 链上交易；USDT 有余额也不行。'
      }
    });

    expect(facts.readyToQuote).toBe(false);
    expect(facts.expected).toEqual({ buyOrders: 0, sellOrders: 0, totalOrders: 0 });
    expect(facts.splitEntry).toMatchObject({
      status: 'gas-insufficient',
      canAttempt: false,
      gas: { asset: 'BNB', ok: false, address: '0x1111111111111111111111111111111111111111' }
    });
    expect(facts.nativeGas).toMatchObject({ address: '0x1111111111111111111111111111111111111111' });
    expect(facts.blockingReasons.join(' ')).toContain('普通 REST maker 挂单不需要 BNB');
    expect(facts.splitEntry?.message).toContain('普通 REST maker 挂单不需要 BNB');
  });

  it('does not allow split startup with only two legs of a three-outcome market', () => {
    const config = appConfigSchema.parse({
      liveEnabled: true,
      risk: { orderSizeUsd: 8, maxSingleOrderUsd: 100, maxPositionUsd: 100, maxMarkets: 1 },
      strategy: {
        entryMode: 'split',
        quoteSide: 'both',
        balanceReserveUsd: 1,
        minMarketLiquidityUsd: 0,
        minRewardLevel: 0,
        enforceRewardMinimum: false,
        maxTokensPerMarket: 2
      }
    });
    const partialThreeOutcome: Market[] = [
      {
        venue: 'predict',
        tokenId: 'three-up',
        marketId: 'three-market',
        conditionId: 'condition-three',
        outcome: 'UP',
        outcomeCount: 3,
        question: 'Three outcome?',
        volume24hUsd: 10000,
        liquidityUsd: 10000,
        acceptingOrders: true,
        endTime: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        endTimeSource: 'reward-end',
        negRisk: false,
        feeRateBps: 0,
        tickSize: 0.01,
        rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 500 }
      },
      {
        venue: 'predict',
        tokenId: 'three-mid',
        marketId: 'three-market',
        conditionId: 'condition-three',
        outcome: 'MID',
        outcomeCount: 3,
        question: 'Three outcome?',
        volume24hUsd: 10000,
        liquidityUsd: 10000,
        acceptingOrders: true,
        endTime: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        endTimeSource: 'reward-end',
        negRisk: false,
        feeRateBps: 0,
        tickSize: 0.01,
        rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 500 }
      }
    ];

    const facts = computeStartupFacts({
      config,
      venue: 'predict',
      address: '0xabc',
      balances: [{ asset: 'USDT', available: 100, total: 100 }],
      positions: [],
      markets: partialThreeOutcome,
      books: new Map(partialThreeOutcome.map((market) => [market.tokenId, splitBook(market.tokenId, 0.31)])),
      openOrders: [],
      accountRisk: okRisk
    });

    expect(facts.readyToQuote).toBe(false);
    expect(facts.expected).toEqual({ buyOrders: 0, sellOrders: 0, totalOrders: 0 });
    expect(facts.splitEntry).toMatchObject({ status: 'no-pair', candidatePairs: 0 });
  });

  it('blocks split startup on venues without automatic split support when no complete inventory exists', () => {
    const config = appConfigSchema.parse({
      liveEnabled: true,
      risk: { orderSizeUsd: 8, maxSingleOrderUsd: 8, maxPositionUsd: 20, maxMarkets: 2 },
      strategy: { entryMode: 'split', quoteSide: 'both', balanceReserveUsd: 1, minMarketLiquidityUsd: 0, minRewardLevel: 0 }
    });
    const facts = computeStartupFacts({
      config,
      venue: 'polymarket',
      address: '0xabc',
      balances: [{ asset: 'USDC', available: 100, total: 100 }],
      positions: [],
      markets: splitMarkets('polymarket'),
      openOrders: [],
      accountRisk: { ...okRisk, venue: 'polymarket' }
    });

    expect(facts.requestedSides).toEqual(['SELL']);
    expect(facts.readyToQuote).toBe(false);
    expect(facts.expected).toEqual({ buyOrders: 0, sellOrders: 0, totalOrders: 0 });
    expect(facts.blockingReasons.join(' ')).toContain('未接入自动拆分');
    expect(facts.splitEntry).toMatchObject({
      active: true,
      supported: false,
      hasCompleteInventory: false,
      canAttempt: false,
      status: 'unsupported'
    });
  });

  it('does not hard-block split startup on fallback gas estimate before target-market dynamic gas check', () => {
    const config = appConfigSchema.parse({
      liveEnabled: true,
      risk: { orderSizeUsd: 8, maxSingleOrderUsd: 8, maxPositionUsd: 20, maxMarkets: 1 },
      strategy: { entryMode: 'split', quoteSide: 'both', balanceReserveUsd: 1, minMarketLiquidityUsd: 0, minRewardLevel: 0, enforceRewardMinimum: false }
    });
    const markets = splitMarkets('predict');
    const facts = computeStartupFacts({
      config,
      venue: 'predict',
      address: '0xabc',
      balances: [{ asset: 'USDT', available: 20, total: 20 }],
      positions: [],
      markets,
      books: new Map(markets.map((market) => [market.tokenId, splitBook(market.tokenId, 0.31)])),
      openOrders: [],
      accountRisk: okRisk,
      nativeGas: {
        asset: 'BNB',
        balance: 0.00005,
        required: 0.00008,
        ok: false,
        requiredSource: 'fallback-estimate',
        estimateStatus: 'fallback',
        estimatedGasUnits: 450000,
        gasPriceGwei: 3,
        bufferMultiplier: 1.35,
        message: '兜底估算不足'
      }
    });

    expect(facts.splitEntry).toMatchObject({
      status: 'gas-warning',
      canAttempt: true,
      plannedSellOrders: 2
    });
    expect(facts.summary).toContain('预计双边 SELL');
  });

  it('allows split mode only when complete two-sided inventory is visible', () => {
    const config = appConfigSchema.parse({
      liveEnabled: true,
      risk: { orderSizeUsd: 8, maxSingleOrderUsd: 8, maxPositionUsd: 20, maxMarkets: 1 },
      strategy: { entryMode: 'split', quoteSide: 'both', balanceReserveUsd: 1 }
    });
    const positions: Position[] = [
      { venue: 'predict', tokenId: 'token-yes', size: 20, notionalUsd: 10 },
      { venue: 'predict', tokenId: 'token-no', size: 20, notionalUsd: 10 }
    ];
    const markets: Market[] = [
      {
        venue: 'predict',
        tokenId: 'token-yes',
        marketId: 'market-1',
        outcome: 'Yes',
        question: 'Complete set?',
        volume24hUsd: 10000,
        liquidityUsd: 10000,
        acceptingOrders: true,
        endTime: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        endTimeSource: 'reward-end',
        negRisk: false,
        feeRateBps: 0,
        tickSize: 0.01,
        rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 500 }
      },
      {
        venue: 'predict',
        tokenId: 'token-no',
        marketId: 'market-1',
        outcome: 'No',
        question: 'Complete set?',
        volume24hUsd: 10000,
        liquidityUsd: 10000,
        acceptingOrders: true,
        endTime: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        endTimeSource: 'reward-end',
        negRisk: false,
        feeRateBps: 0,
        tickSize: 0.01,
        rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 500 }
      }
    ];

    const facts = computeStartupFacts({
      config,
      venue: 'predict',
      address: '0xabc',
      balances: [{ asset: 'USDT', available: 0, total: 0 }],
      positions,
      markets,
      openOrders: [],
      accountRisk: okRisk
    });

    expect(facts.requestedSides).toEqual(['SELL']);
    expect(facts.readyToQuote).toBe(true);
    expect(facts.expected).toEqual({ buyOrders: 0, sellOrders: 2, totalOrders: 2 });
    expect(facts.sides.SELL.status).toBe('conditional');
    expect(facts.splitEntry).toMatchObject({
      active: true,
      supported: true,
      hasCompleteInventory: true,
      canAttempt: false,
      status: 'ready-with-inventory'
    });
  });

  it('recognizes complete split inventory from position metadata even when the market list misses the tokens', () => {
    const config = appConfigSchema.parse({
      liveEnabled: true,
      risk: { orderSizeUsd: 8, maxSingleOrderUsd: 100, maxPositionUsd: 100, maxMarkets: 1 },
      strategy: { entryMode: 'split', quoteSide: 'both', balanceReserveUsd: 1, minMarketLiquidityUsd: 0, minRewardLevel: 0 }
    });
    const positions: Position[] = [
      {
        venue: 'predict',
        tokenId: 'live-yes',
        marketId: '346517',
        conditionId: '0xcondition',
        outcome: 'YES',
        outcomeCount: 2,
        size: 10,
        notionalUsd: 0.1
      },
      {
        venue: 'predict',
        tokenId: 'live-no',
        marketId: '346517',
        conditionId: '0xcondition',
        outcome: 'NO',
        outcomeCount: 2,
        size: 10,
        notionalUsd: 9.9
      }
    ];

    const facts = computeStartupFacts({
      config,
      venue: 'predict',
      address: '0xabc',
      balances: [{ asset: 'USDT', available: 9, total: 9 }],
      positions,
      markets: [],
      openOrders: [],
      accountRisk: okRisk
    });

    expect(facts.readyToQuote).toBe(true);
    expect(facts.sides.SELL.status).toBe('conditional');
    expect(facts.expected).toEqual({ buyOrders: 0, sellOrders: 2, totalOrders: 2 });
    expect(facts.splitEntry).toMatchObject({
      hasCompleteInventory: true,
      status: 'ready-with-inventory'
    });
    expect(facts.summary).toContain('双边 SELL');
  });
});

function splitMarkets(venue: 'predict' | 'polymarket' = 'predict'): Market[] {
  return [
    {
      venue,
      tokenId: 'token-yes',
      marketId: 'market-1',
      conditionId: 'condition-1',
      outcome: 'Yes',
      question: 'Complete set?',
      volume24hUsd: 10000,
      liquidityUsd: 10000,
      acceptingOrders: true,
      endTime: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      endTimeSource: 'reward-end',
      negRisk: false,
      feeRateBps: 0,
      tickSize: 0.01,
      rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 500 }
    },
    {
      venue,
      tokenId: 'token-no',
      marketId: 'market-1',
      conditionId: 'condition-1',
      outcome: 'No',
      question: 'Complete set?',
      volume24hUsd: 10000,
      liquidityUsd: 10000,
      acceptingOrders: true,
      endTime: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      endTimeSource: 'reward-end',
      negRisk: false,
      feeRateBps: 0,
      tickSize: 0.01,
      rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 500 }
    }
  ];
}

function splitBook(tokenId: string, sellLevelPrice: number): Orderbook {
  return {
    venue: 'predict',
    tokenId,
    receivedAt: Date.now(),
    bids: [
      { price: 0.25, size: 1000 },
      { price: 0.24, size: 1000 }
    ],
    asks: [
      { price: sellLevelPrice - 0.01, size: 1000 },
      { price: sellLevelPrice, size: 1000 },
      { price: sellLevelPrice + 0.01, size: 1000 }
    ]
  };
}
