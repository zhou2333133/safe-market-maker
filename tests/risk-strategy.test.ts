import { describe, expect, it } from 'vitest';
import { appConfigSchema } from '../src/config/schema.js';
import type { Market, OpenOrder, OrderIntent, Orderbook } from '../src/domain/types.js';
import { RiskEngine } from '../src/risk/risk-engine.js';
import { rankMarketRoutes, selectMarketRoutes } from '../src/strategy/market-router.js';
import { completeSetInventoryGroups, pairedPositionGroups } from '../src/strategy/paired-inventory.js';
import { StrategyEngine } from '../src/strategy/strategy-engine.js';
import { normalizePredictMarket } from '../src/venues/normalize.js';

const market: Market = {
  venue: 'predict',
  tokenId: 'token-1',
  question: 'Will this test pass?',
  volume24hUsd: 10000,
  liquidityUsd: 15000,
  acceptingOrders: true,
  endTime: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  endTimeSource: 'market-end',
  negRisk: false,
  feeRateBps: 0,
  tickSize: 0.01,
  rewards: { enabled: true, minShares: 100, maxSpreadCents: 6 }
};

const noMarket: Market = {
  ...market,
  tokenId: 'token-no',
  marketId: 'market-pair',
  outcome: 'No'
};

const book: Orderbook = {
  venue: 'predict',
  tokenId: 'token-1',
  receivedAt: Date.now(),
  bids: [
    { price: 0.49, size: 1000 },
    { price: 0.48, size: 1000 },
    { price: 0.47, size: 1000 },
    { price: 0.46, size: 1000 }
  ],
  asks: [
    { price: 0.51, size: 1000 },
    { price: 0.52, size: 1000 },
    { price: 0.53, size: 1000 },
    { price: 0.54, size: 1000 }
  ]
};

const pairedMarket: Market = { ...market, marketId: 'market-pair' };

function cashProbeBook(
  tokenId: string,
  options: {
    topPrice?: number;
    topSize?: number;
    supportPrice?: number;
    supportSize?: number;
    lowerPrice?: number;
    lowerSize?: number;
    fourthPrice?: number;
    fourthSize?: number;
    askPrice?: number;
    askSize?: number;
  } = {}
): Orderbook {
  const topPrice = options.topPrice ?? 0.5;
  const supportPrice = options.supportPrice ?? Number((topPrice - 0.01).toFixed(3));
  const lowerPrice = options.lowerPrice ?? Number((supportPrice - 0.01).toFixed(3));
  const fourthPrice = options.fourthPrice ?? Number((lowerPrice - 0.01).toFixed(3));
  return {
    ...book,
    tokenId,
    bids: [
      { price: topPrice, size: options.topSize ?? 300 },
      { price: supportPrice, size: options.supportSize ?? 300 },
      { price: lowerPrice, size: options.lowerSize ?? 300 },
      { price: fourthPrice, size: options.fourthSize ?? 300 }
    ],
    asks: [{ price: options.askPrice ?? Number((topPrice + 0.01).toFixed(3)), size: options.askSize ?? 1000 }]
  };
}

describe('strategy and risk', () => {
  it('builds conservative post-only tier quotes', () => {
    const config = appConfigSchema.parse({
      strategy: { entryMode: 'cash', quoteSide: 'both', conservativeDepthLevel: 4, inventorySkewEnabled: false },
      risk: { orderSizeUsd: 100, maxSingleOrderUsd: 100, maxPositionUsd: 200 }
    });
    const strategy = new StrategyEngine(config);
    const intents = strategy.buildIntents('predict', [market], new Map([[market.tokenId, book]]), {
      positions: [{ venue: 'predict', tokenId: market.tokenId, size: 200, notionalUsd: 100 }]
    });
    expect(intents).toHaveLength(2);
    expect(intents[0]?.price).toBeLessThan(0.51);
    expect(intents[1]?.price).toBeGreaterThan(0.49);
    expect(intents.every((intent) => intent.size >= 100)).toBe(true);
    expect(intents.every((intent) => intent.reward?.level === 5)).toBe(true);
    expect(intents.every((intent) => intent.postOnly)).toBe(true);
  });

  it('supports single-side quote selection', () => {
    const config = appConfigSchema.parse({
      strategy: { entryMode: 'cash', quoteSide: 'sell' },
      risk: { orderSizeUsd: 100, maxSingleOrderUsd: 100, maxPositionUsd: 200 }
    });
    const strategy = new StrategyEngine(config);
    const intents = strategy.buildIntents('predict', [market], new Map([[market.tokenId, book]]), {
      positions: [{ venue: 'predict', tokenId: market.tokenId, size: 200, notionalUsd: 100 }]
    });
    expect(intents).toHaveLength(1);
    expect(intents[0]?.side).toBe('SELL');
  });

  it('skips automated sell quotes when there is no token inventory', () => {
    const config = appConfigSchema.parse({ strategy: { entryMode: 'cash', quoteSide: 'sell' } });
    const strategy = new StrategyEngine(config);
    const intents = strategy.buildIntents('predict', [market], new Map([[market.tokenId, book]]));
    expect(intents).toHaveLength(0);
  });

  it('split entry mode blocks single-sided inventory quotes', () => {
    const config = appConfigSchema.parse({
      risk: { maxMarkets: 1, maxSingleOrderUsd: 100, maxPositionUsd: 200 },
      strategy: { entryMode: 'split', enforceRewardMinimum: false, maxTokensPerMarket: 2 }
    });
    const strategy = new StrategyEngine(config);
    const intents = strategy.buildIntents('predict', [pairedMarket, noMarket], new Map([
      [pairedMarket.tokenId, book],
      [noMarket.tokenId, { ...book, tokenId: noMarket.tokenId }]
    ]), {
      positions: [{ venue: 'predict', tokenId: pairedMarket.tokenId, size: 100, notionalUsd: 50 }]
    });

    expect(intents).toEqual([]);
  });

  it('split entry mode quotes both outcomes only when complete inventory exists', () => {
    const config = appConfigSchema.parse({
      risk: { maxMarkets: 1, maxSingleOrderUsd: 100, maxPositionUsd: 200 },
      strategy: { entryMode: 'split', enforceRewardMinimum: false, maxTokensPerMarket: 2 }
    });
    const strategy = new StrategyEngine(config);
    const intents = strategy.buildIntents('predict', [pairedMarket, noMarket], new Map([
      [pairedMarket.tokenId, book],
      [noMarket.tokenId, { ...book, tokenId: noMarket.tokenId }]
    ]), {
      positions: [
        { venue: 'predict', tokenId: pairedMarket.tokenId, size: 100, notionalUsd: 50 },
        { venue: 'predict', tokenId: noMarket.tokenId, size: 100, notionalUsd: 50 }
      ]
    });

    expect(intents).toHaveLength(2);
    expect(intents.every((intent) => intent.side === 'SELL')).toBe(true);
    expect(new Set(intents.map((intent) => intent.tokenId))).toEqual(new Set([pairedMarket.tokenId, noMarket.tokenId]));
  });

  it('split SELL quotes retreat inside the reward band until the risk distance check passes', () => {
    const config = appConfigSchema.parse({
      risk: { orderSizeUsd: 5, maxMarkets: 1, maxSingleOrderUsd: 100, maxPositionUsd: 200 },
      strategy: {
        entryMode: 'split',
        enforceRewardMinimum: false,
        maxTokensPerMarket: 2,
        minMarketLiquidityUsd: 0,
        minRewardLevel: 0,
        retreatTicks: 1
      }
    });
    const yes: Market = { ...pairedMarket, tokenId: 'safe-yes', marketId: 'safe-pair', conditionId: 'safe-condition', outcome: 'YES', outcomeCount: 2, tickSize: 0.001 };
    const no: Market = { ...noMarket, tokenId: 'safe-no', marketId: 'safe-pair', conditionId: 'safe-condition', outcome: 'NO', outcomeCount: 2, tickSize: 0.001 };
    const yesBook: Orderbook = {
      ...book,
      tokenId: yes.tokenId,
      bids: [{ price: 0.169, size: 2000 }, { price: 0.168, size: 2000 }],
      asks: [{ price: 0.171, size: 2000 }, { price: 0.172, size: 2000 }, { price: 0.173, size: 2000 }]
    };
    const noBook: Orderbook = {
      ...book,
      tokenId: no.tokenId,
      bids: [{ price: 0.829, size: 2000 }, { price: 0.828, size: 2000 }],
      asks: [{ price: 0.83, size: 2000 }, { price: 0.831, size: 2000 }, { price: 0.832, size: 2000 }]
    };

    const intents = new StrategyEngine(config).buildIntents('predict', [yes, no], new Map([
      [yes.tokenId, yesBook],
      [no.tokenId, noBook]
    ]), {
      positions: [
        { venue: 'predict', tokenId: yes.tokenId, size: 100, notionalUsd: 17 },
        { venue: 'predict', tokenId: no.tokenId, size: 100, notionalUsd: 83 }
      ]
    });

    expect(intents).toHaveLength(2);
    const noIntent = intents.find((intent) => intent.tokenId === no.tokenId);
    expect(noIntent?.price).toBeGreaterThanOrEqual(0.831);
    expect(noIntent?.price).toBeLessThanOrEqual(0.889);
    const risk = new RiskEngine(config);
    expect(intents.map((intent) => risk.evaluate(
      intent,
      intent.tokenId === no.tokenId ? noBook : yesBook,
      [
        { venue: 'predict', tokenId: yes.tokenId, size: 100, notionalUsd: 17 },
        { venue: 'predict', tokenId: no.tokenId, size: 100, notionalUsd: 83 }
      ],
      []
    ).ok)).toEqual([true, true]);
  });

  it('requires an official reward spread before placing points quotes', () => {
    const config = appConfigSchema.parse({
      risk: { maxMarkets: 1, maxSingleOrderUsd: 100, maxPositionUsd: 200 },
      strategy: {
        entryMode: 'split',
        enforceRewardMinimum: false,
        maxTokensPerMarket: 2,
        minMarketLiquidityUsd: 0,
        minRewardLevel: 0
      }
    });
    const yes: Market = { ...pairedMarket, rewards: { enabled: true, level: 5, minShares: 100, ppPerHour: 3000 } };
    const no: Market = { ...noMarket, rewards: { enabled: true, level: 5, minShares: 100, ppPerHour: 3000 } };
    const intents = new StrategyEngine(config).buildIntents('predict', [yes, no], new Map([
      [yes.tokenId, book],
      [no.tokenId, { ...book, tokenId: no.tokenId }]
    ]), {
      positions: [
        { venue: 'predict', tokenId: yes.tokenId, size: 100, notionalUsd: 50 },
        { venue: 'predict', tokenId: no.tokenId, size: 100, notionalUsd: 50 }
      ]
    });

    expect(intents).toEqual([]);
  });

  it('chooses a protected reward SELL level instead of blindly using the configured depth level', () => {
    const config = appConfigSchema.parse({
      risk: { orderSizeUsd: 5, maxMarkets: 1, maxSingleOrderUsd: 100, maxPositionUsd: 200, minDepthUsdPerSide: 120 },
      strategy: {
        entryMode: 'split',
        enforceRewardMinimum: false,
        maxTokensPerMarket: 2,
        conservativeDepthLevel: 2,
        retreatTicks: 0,
        minMarketLiquidityUsd: 0,
        minRewardLevel: 0
      }
    });
    const protectedBook: Orderbook = {
      ...book,
      bids: [{ price: 0.52, size: 8000 }],
      asks: [
        { price: 0.54, size: 200 },
        { price: 0.55, size: 50 },
        { price: 0.56, size: 5000 }
      ]
    };

    const intents = new StrategyEngine(config).buildIntents('predict', [pairedMarket, noMarket], new Map([
      [pairedMarket.tokenId, protectedBook],
      [noMarket.tokenId, { ...protectedBook, tokenId: noMarket.tokenId }]
    ]), {
      positions: [
        { venue: 'predict', tokenId: pairedMarket.tokenId, size: 100, notionalUsd: 50 },
        { venue: 'predict', tokenId: noMarket.tokenId, size: 100, notionalUsd: 50 }
      ]
    });

    expect(intents).toHaveLength(2);
    expect(intents.every((intent) => intent.price === 0.56)).toBe(true);
  });

  it('split entry mode equalizes paired SELL shares without exceeding the configured group budget', () => {
    const config = appConfigSchema.parse({
      risk: { orderSizeUsd: 8, maxMarkets: 1, maxSingleOrderUsd: 100, maxPositionUsd: 200 },
      strategy: {
        entryMode: 'split',
        enforceRewardMinimum: false,
        maxTokensPerMarket: 2,
        conservativeDepthLevel: 2,
        retreatTicks: 1
      }
    });
    const yesBook: Orderbook = {
      ...book,
      tokenId: pairedMarket.tokenId,
      bids: [
        { price: 0.25, size: 1000 },
        { price: 0.24, size: 1000 }
      ],
      asks: [
        { price: 0.27, size: 1000 },
        { price: 0.28, size: 1000 }
      ]
    };
    const noBook: Orderbook = {
      ...book,
      tokenId: noMarket.tokenId,
      bids: [
        { price: 0.29, size: 1000 },
        { price: 0.28, size: 1000 }
      ],
      asks: [
        { price: 0.31, size: 1000 },
        { price: 0.32, size: 1000 }
      ]
    };
    const intents = new StrategyEngine(config).buildIntents('predict', [pairedMarket, noMarket], new Map([
      [pairedMarket.tokenId, yesBook],
      [noMarket.tokenId, noBook]
    ]), {
      positions: [
        { venue: 'predict', tokenId: pairedMarket.tokenId, size: 30, notionalUsd: 15 },
        { venue: 'predict', tokenId: noMarket.tokenId, size: 30, notionalUsd: 15 }
      ]
    });

    expect(intents).toHaveLength(2);
    expect(new Set(intents.map((intent) => intent.size))).toEqual(new Set([12.9032]));
    expect(intents.map((intent) => intent.notionalUsd).sort()).toEqual([3.7419, 4.2581]);
    expect(Number(intents.reduce((sum, intent) => sum + intent.notionalUsd, 0).toFixed(4))).toBeLessThanOrEqual(8);
    expect(intents.some((intent) => intent.reason.includes('paired-equal-shares'))).toBe(true);
  });

  it('split test mode keeps a 2 USD paired SELL budget from expanding through the cheaper leg share count', () => {
    const config = appConfigSchema.parse({
      risk: { orderSizeUsd: 2, maxMarkets: 1, maxSingleOrderUsd: 100, maxPositionUsd: 200 },
      strategy: {
        entryMode: 'split',
        enforceRewardMinimum: false,
        maxTokensPerMarket: 2,
        conservativeDepthLevel: 1,
        retreatTicks: 0,
        minMarketLiquidityUsd: 0,
        minRewardLevel: 0
      }
    });
    const yes: Market = { ...pairedMarket, tickSize: 0.001, rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 60 } };
    const no: Market = { ...noMarket, tickSize: 0.001, rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 60 } };
    const yesBook: Orderbook = {
      ...book,
      tokenId: yes.tokenId,
      bids: [{ price: 0.3, size: 1000 }],
      asks: [
        { price: 0.301, size: 1000 },
        { price: 0.302, size: 1000 }
      ]
    };
    const noBook: Orderbook = {
      ...book,
      tokenId: no.tokenId,
      bids: [{ price: 0.704, size: 1000 }],
      asks: [
        { price: 0.705, size: 1000 },
        { price: 0.706, size: 1000 }
      ]
    };

    const intents = new StrategyEngine(config).buildIntents('predict', [yes, no], new Map([
      [yes.tokenId, yesBook],
      [no.tokenId, noBook]
    ]), {
      positions: [
        { venue: 'predict', tokenId: yes.tokenId, size: 10, notionalUsd: 3.01 },
        { venue: 'predict', tokenId: no.tokenId, size: 10, notionalUsd: 7.05 }
      ]
    });

    expect(intents).toHaveLength(2);
    expect(new Set(intents.map((intent) => intent.size))).toEqual(new Set([1.9802]));
    expect(intents.find((intent) => intent.tokenId === yes.tokenId)?.notionalUsd).toBe(0.6);
    expect(intents.find((intent) => intent.tokenId === no.tokenId)?.notionalUsd).toBe(1.4);
    expect(Number(intents.reduce((sum, intent) => sum + intent.notionalUsd, 0).toFixed(4))).toBeLessThanOrEqual(2.01);
  });

  it('split equalized SELL shares respect the single-order risk cap on the highest-priced leg', () => {
    const config = appConfigSchema.parse({
      risk: { orderSizeUsd: 8, maxMarkets: 1, maxSingleOrderUsd: 8, maxPositionUsd: 200 },
      strategy: {
        entryMode: 'split',
        enforceRewardMinimum: false,
        maxTokensPerMarket: 2,
        conservativeDepthLevel: 2,
        retreatTicks: 1
      }
    });
    const yesBook: Orderbook = {
      ...book,
      tokenId: pairedMarket.tokenId,
      bids: [
        { price: 0.25, size: 1000 },
        { price: 0.24, size: 1000 }
      ],
      asks: [
        { price: 0.27, size: 1000 },
        { price: 0.28, size: 1000 }
      ]
    };
    const noBook: Orderbook = {
      ...book,
      tokenId: noMarket.tokenId,
      bids: [
        { price: 0.29, size: 1000 },
        { price: 0.28, size: 1000 }
      ],
      asks: [
        { price: 0.31, size: 1000 },
        { price: 0.32, size: 1000 }
      ]
    };
    const intents = new StrategyEngine(config).buildIntents('predict', [pairedMarket, noMarket], new Map([
      [pairedMarket.tokenId, yesBook],
      [noMarket.tokenId, noBook]
    ]), {
      positions: [
        { venue: 'predict', tokenId: pairedMarket.tokenId, size: 30, notionalUsd: 15 },
        { venue: 'predict', tokenId: noMarket.tokenId, size: 30, notionalUsd: 15 }
      ]
    });

    expect(intents).toHaveLength(2);
    expect(new Set(intents.map((intent) => intent.size))).toEqual(new Set([12.9032]));
    expect(Math.max(...intents.map((intent) => intent.notionalUsd))).toBeLessThanOrEqual(8);
    expect(Number(intents.reduce((sum, intent) => sum + intent.notionalUsd, 0).toFixed(4))).toBeLessThanOrEqual(8);
  });

  it('split mode shrinks paired SELL quotes to the actual complete-set inventory instead of requiring the target order size', () => {
    const config = appConfigSchema.parse({
      risk: { orderSizeUsd: 8, maxMarkets: 1, maxSingleOrderUsd: 100, maxPositionUsd: 200 },
      strategy: {
        entryMode: 'split',
        enforceRewardMinimum: false,
        maxTokensPerMarket: 2,
        conservativeDepthLevel: 2,
        retreatTicks: 1
      }
    });
    const yesBook: Orderbook = {
      ...book,
      tokenId: pairedMarket.tokenId,
      bids: [
        { price: 0.25, size: 1000 },
        { price: 0.24, size: 1000 }
      ],
      asks: [
        { price: 0.27, size: 1000 },
        { price: 0.28, size: 1000 }
      ]
    };
    const noBook: Orderbook = {
      ...book,
      tokenId: noMarket.tokenId,
      bids: [
        { price: 0.29, size: 1000 },
        { price: 0.28, size: 1000 }
      ],
      asks: [
        { price: 0.31, size: 1000 },
        { price: 0.32, size: 1000 }
      ]
    };
    const intents = new StrategyEngine(config).buildIntents('predict', [pairedMarket, noMarket], new Map([
      [pairedMarket.tokenId, yesBook],
      [noMarket.tokenId, noBook]
    ]), {
      positions: [
        { venue: 'predict', tokenId: pairedMarket.tokenId, size: 1, notionalUsd: 0.27 },
        { venue: 'predict', tokenId: noMarket.tokenId, size: 1, notionalUsd: 0.31 }
      ]
    });

    expect(intents).toHaveLength(2);
    expect(new Set(intents.map((intent) => intent.size))).toEqual(new Set([1]));
    expect(intents.map((intent) => intent.notionalUsd).sort()).toEqual([0.29, 0.33]);
  });

  it('filters recommendations to five-star LP reward markets when configured', () => {
    const config = appConfigSchema.parse({ strategy: { minRewardLevel: 5 } });
    const strategy = new StrategyEngine(config);
    const weakReward: Market = {
      ...market,
      tokenId: 'token-weak',
      rewards: { enabled: true, minShares: 200, maxSpreadCents: 3 }
    };
    const recs = strategy.recommend([weakReward, market], 10);
    expect(recs).toHaveLength(1);
    expect(recs[0]?.market.tokenId).toBe('token-1');
    expect(recs[0]?.reasons.join(' ')).toContain('LP 奖励 5级');
  });

  it('requires an active Predict current reward before treating LP rules as live five-star rewards', () => {
    const [normalized] = normalizePredictMarket({
      id: 'm1',
      question: 'Predict reward level',
      liquidity_activation: { min_shares: 100, max_spread: 0.06 },
      outcomes: [{ onChainId: 'token-predict', name: 'Yes' }]
    });
    expect(normalized?.rewards).toMatchObject({
      enabled: false,
      level: 5,
      minShares: 100,
      maxSpreadCents: 6,
      reason: 'predict-reward-rules-inactive'
    });
  });

  it('maps active Predict current rewards to five-star PP markets', () => {
    const [normalized] = normalizePredictMarket({
      id: 'm1',
      question: 'Predict reward level',
      rewards: {
        current: {
          startsAt: new Date(Date.now() - 60_000).toISOString(),
          endsAt: new Date(Date.now() + 60 * 60_000).toISOString(),
          hourlyRate: 3000
        }
      },
      liquidity_activation: { min_shares: 100, max_spread: 0.06 },
      outcomes: [{ onChainId: 'token-predict', name: 'Yes' }]
    });
    expect(normalized?.rewards?.enabled).toBe(true);
    expect(normalized?.rewards?.level).toBe(5);
    expect(normalized?.rewards?.ppPerHour).toBe(3000);
  });

  it('keeps stats-backed Predict reward rules inactive without a current reward window', () => {
    const [normalized] = normalizePredictMarket({
      id: 'm-stats',
      question: 'Predict stats reward',
      stats: {
        liquidityActivation: { minShares: 100, maxSpreadCents: 6, ppPerHour: 4200 }
      },
      outcomes: [{ onChainId: 'token-stats', name: 'Yes' }]
    });
    expect(normalized?.rewards).toMatchObject({ enabled: false, minShares: 100, maxSpreadCents: 6, ppPerHour: 4200 });
  });

  it('does not build reward quotes outside the allowed reward band', () => {
    const config = appConfigSchema.parse({
      strategy: { entryMode: 'cash', quoteSide: 'both', conservativeDepthLevel: 4, retreatTicks: 2, inventorySkewEnabled: false },
      risk: { orderSizeUsd: 100, maxSingleOrderUsd: 100, maxPositionUsd: 200 }
    });
    const strategy = new StrategyEngine(config);
    const narrowMarket: Market = {
      ...market,
      rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 2 }
    };
    const intents = strategy.buildIntents('predict', [narrowMarket], new Map([[market.tokenId, book]]), {
      positions: [{ venue: 'predict', tokenId: market.tokenId, size: 200, notionalUsd: 100 }]
    });
    expect(intents).toHaveLength(1);
    expect(intents[0]?.side).toBe('SELL');
    expect(intents[0]?.price).toBe(0.51);
  });

  it('uses live orderbook precision instead of coarse market tick when planning PP quotes', () => {
    const config = appConfigSchema.parse({
      risk: { orderSizeUsd: 8, maxSingleOrderUsd: 100, maxPositionUsd: 200 },
      strategy: {
        conservativeDepthLevel: 2,
        retreatTicks: 1,
        enforceRewardMinimum: false,
        pointsOnly: false,
        inventorySkewEnabled: false,
        quoteSide: 'buy',
        entryMode: 'cash'
      }
    });
    const decimalBook: Orderbook = {
      ...book,
      bids: [
        { price: 0.29, size: 1010.253 },
        { price: 0.289, size: 2800 },
        { price: 0.287, size: 2511.8 },
        { price: 0.286, size: 600 },
        { price: 0.28, size: 1072.3 },
        { price: 0.272, size: 500 },
        { price: 0.271, size: 7215.1 },
        { price: 0.27, size: 777.799 }
      ],
      asks: [
        { price: 0.291, size: 18942.78 },
        { price: 0.292, size: 3401.19 },
        { price: 0.294, size: 102 },
        { price: 0.295, size: 110 }
      ]
    };

    const [intent] = new StrategyEngine(config).buildIntents('predict', [market], new Map([[market.tokenId, decimalBook]]));

    expect(intent?.price).toBe(0.286);
    expect(intent?.price).toBeGreaterThan(0.27);
    expect(intent?.reason).toBe('predict-points-bid-level-3');
  });

  it('infers standard orderbook tick precision instead of sparse price gaps', () => {
    const config = appConfigSchema.parse({
      risk: { orderSizeUsd: 8, maxSingleOrderUsd: 100, maxPositionUsd: 200 },
      strategy: {
        conservativeDepthLevel: 2,
        retreatTicks: 1,
        enforceRewardMinimum: false,
        pointsOnly: false,
        inventorySkewEnabled: false,
        quoteSide: 'buy',
        entryMode: 'cash'
      }
    });
    const sparseBook: Orderbook = {
      ...book,
      bids: [
        { price: 0.29, size: 1000 },
        { price: 0.286, size: 1000 },
        { price: 0.282, size: 1000 },
        { price: 0.278, size: 1000 }
      ],
      asks: [
        { price: 0.291, size: 1000 },
        { price: 0.295, size: 1000 }
      ]
    };

    const [intent] = new StrategyEngine(config).buildIntents('predict', [market], new Map([[market.tokenId, sparseBook]]));

    expect(intent?.price).toBe(0.279);
    expect(intent?.price).not.toBe(0.282);
  });

  it('retreats a BUY quote to a safer price when the front queue disappears', () => {
    const config = appConfigSchema.parse({
      risk: { orderSizeUsd: 8, maxSingleOrderUsd: 100, maxPositionUsd: 200 },
      strategy: {
        conservativeDepthLevel: 2,
        retreatTicks: 1,
        replaceThresholdTicks: 1,
        enforceRewardMinimum: false,
        pointsOnly: false,
        inventorySkewEnabled: false,
        quoteSide: 'buy',
        entryMode: 'cash'
      }
    });
    const frontQueueGoneBook: Orderbook = {
      ...book,
      bids: [
        { price: 0.288, size: 27.874 },
        { price: 0.287, size: 2200 },
        { price: 0.286, size: 1900 },
        { price: 0.285, size: 800 },
        { price: 0.284, size: 800 }
      ],
      asks: [
        { price: 0.291, size: 18942.78 },
        { price: 0.292, size: 3401.19 }
      ]
    };
    const strategy = new StrategyEngine(config);
    const [desired] = strategy.buildIntents('predict', [market], new Map([[market.tokenId, frontQueueGoneBook]]));
    const existing: OpenOrder = {
      venue: 'predict',
      externalId: 'existing-buy',
      tokenId: market.tokenId,
      side: 'BUY',
      price: 0.288,
      size: 27.874,
      status: 'OPEN'
    };

    expect(desired?.price).toBe(0.285);
    expect(strategy.shouldReplaceOrder('predict', existing, desired as OrderIntent, market, frontQueueGoneBook)).toMatchObject({
      replace: true
    });
  });

  it('retreats a SELL quote to a safer price when the front queue disappears', () => {
    const config = appConfigSchema.parse({
      risk: { orderSizeUsd: 8, maxSingleOrderUsd: 100, maxPositionUsd: 200 },
      strategy: {
        conservativeDepthLevel: 2,
        retreatTicks: 1,
        replaceThresholdTicks: 1,
        enforceRewardMinimum: false,
        pointsOnly: false,
        inventorySkewEnabled: false,
        quoteSide: 'sell',
        entryMode: 'cash'
      }
    });
    const frontQueueGoneBook: Orderbook = {
      ...book,
      bids: [
        { price: 0.489, size: 2500 },
        { price: 0.488, size: 2500 }
      ],
      asks: [
        { price: 0.512, size: 20 },
        { price: 0.513, size: 2400 },
        { price: 0.514, size: 1700 },
        { price: 0.515, size: 900 }
      ]
    };
    const strategy = new StrategyEngine(config);
    const [desired] = strategy.buildIntents('predict', [market], new Map([[market.tokenId, frontQueueGoneBook]]), {
      positions: [{ venue: 'predict', tokenId: market.tokenId, size: 100, notionalUsd: 50 }]
    });
    const existing: OpenOrder = {
      venue: 'predict',
      externalId: 'existing-sell',
      tokenId: market.tokenId,
      side: 'SELL',
      price: 0.512,
      size: 15.625,
      status: 'OPEN'
    };

    expect(desired?.price).toBe(0.514);
    expect(strategy.shouldReplaceOrder('predict', existing, desired as OrderIntent, market, frontQueueGoneBook)).toMatchObject({
      replace: true
    });
  });

  it('routes to the highest PP market with enough reward-band liquidity', () => {
    const config = appConfigSchema.parse({
      risk: { orderSizeUsd: 100, maxSingleOrderUsd: 500, maxPositionUsd: 500 },
      strategy: { entryMode: 'cash', minMarketLiquidityUsd: 0, minRewardLevel: 0, quoteSide: 'buy' }
    });
    const thinHighPp: Market = {
      ...market,
      tokenId: 'thin-high-pp',
      question: 'High PP but thin',
      liquidityUsd: 1000,
      volume24hUsd: 2000,
      rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 3000 }
    };
    const deepHighPp: Market = {
      ...market,
      tokenId: 'deep-high-pp',
      question: 'High PP and deep',
      liquidityUsd: 3000,
      volume24hUsd: 9000,
      rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 3000 }
    };
    const lowerPp: Market = {
      ...market,
      tokenId: 'lower-pp',
      question: 'Lower PP',
      liquidityUsd: 20000,
      volume24hUsd: 20000,
      rewards: { enabled: true, level: 4, minShares: 100, maxSpreadCents: 6, ppPerHour: 1000 }
    };
    const books = new Map<string, Orderbook>([
      [thinHighPp.tokenId, { ...book, tokenId: thinHighPp.tokenId, bids: [{ price: 0.76, size: 10 }], asks: [{ price: 0.77, size: 10 }] }],
      [deepHighPp.tokenId, {
        ...book,
        tokenId: deepHighPp.tokenId,
        bids: [{ price: 0.76, size: 620 }, { price: 0.75, size: 335 }, { price: 0.74, size: 500 }, { price: 0.73, size: 500 }],
        asks: [{ price: 0.77, size: 121 }, { price: 0.78, size: 1381 }]
      }],
      [lowerPp.tokenId, {
        ...book,
        tokenId: lowerPp.tokenId,
        bids: [{ price: 0.61, size: 2000 }, { price: 0.6, size: 2000 }, { price: 0.59, size: 2000 }, { price: 0.58, size: 2000 }],
        asks: [{ price: 0.62, size: 2000 }]
      }]
    ]);

    const ranked = rankMarketRoutes(config, 'predict', [thinHighPp, deepHighPp, lowerPp], books);
    const selected = selectMarketRoutes(config, 'predict', ranked).selected;
    expect(selected[0]?.market.tokenId).toBe('deep-high-pp');
    expect(ranked.find((candidate) => candidate.market.tokenId === 'thin-high-pp')?.tradable).toBe(false);
  });

  it('keeps high official PP markets in recommendation candidates ahead of low-PP giant-liquidity markets', () => {
    const config = appConfigSchema.parse({
      strategy: { entryMode: 'cash', minMarketLiquidityUsd: 0, minRewardLevel: 5 }
    });
    const highPp: Market = {
      ...market,
      tokenId: 'high-pp',
      liquidityUsd: 12000,
      volume24hUsd: 1000,
      rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 3000 }
    };
    const lowPpHugeLiquidity: Market = {
      ...market,
      tokenId: 'low-pp-huge-liquidity',
      liquidityUsd: 500000,
      volume24hUsd: 1000,
      rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 10 }
    };

    const recs = new StrategyEngine(config).recommend([lowPpHugeLiquidity, highPp], 2);

    expect(recs[0]?.market.tokenId).toBe('high-pp');
    expect(recs[0]?.reasons.join(' ')).toContain('官方当前 PP 3,000/hr');
  });

  it('prefers verifiable PP capital efficiency when PP and safety are close', () => {
    const config = appConfigSchema.parse({
      risk: { orderSizeUsd: 100, maxSingleOrderUsd: 500, maxPositionUsd: 500 },
      strategy: { entryMode: 'cash', minMarketLiquidityUsd: 0, minRewardLevel: 0, quoteSide: 'buy' }
    });
    const crowded: Market = {
      ...market,
      tokenId: 'crowded-same-pp',
      liquidityUsd: 100000,
      volume24hUsd: 10000,
      rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 3000 }
    };
    const balanced: Market = {
      ...market,
      tokenId: 'balanced-slightly-lower-pp',
      liquidityUsd: 100000,
      volume24hUsd: 10000,
      rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 2850 }
    };
    const books = new Map<string, Orderbook>([
      [crowded.tokenId, {
        ...book,
        tokenId: crowded.tokenId,
        bids: [{ price: 0.49, size: 120000 }],
        asks: [{ price: 0.51, size: 120000 }]
      }],
      [balanced.tokenId, {
        ...book,
        tokenId: balanced.tokenId,
        bids: [{ price: 0.49, size: 10000 }],
        asks: [{ price: 0.51, size: 10000 }]
      }]
    ]);

    const ranked = rankMarketRoutes(config, 'predict', [crowded, balanced], books);
    expect(ranked[0]?.market.tokenId).toBe('balanced-slightly-lower-pp');
    expect(ranked[0]?.metrics.competitionBand).toBe('balanced');
    expect(ranked.find((candidate) => candidate.market.tokenId === crowded.tokenId)?.metrics.competitionBand).toBe('crowded');
    expect(ranked[0]?.metrics.expectedPpPerHour).toBeGreaterThan(ranked.find((candidate) => candidate.market.tokenId === crowded.tokenId)?.metrics.expectedPpPerHour ?? 0);
    expect(ranked[0]?.reasons.join(' ')).toContain('资金效率');
  });

  it('uses expected PP share as the primary route signal instead of absolute PP only', () => {
    const config = appConfigSchema.parse({
      risk: { orderSizeUsd: 100, maxSingleOrderUsd: 500, maxPositionUsd: 500 },
      strategy: { entryMode: 'cash', minMarketLiquidityUsd: 0, minRewardLevel: 0, quoteSide: 'buy' }
    });
    const highPpCrowded: Market = {
      ...market,
      tokenId: 'high-pp-crowded-route',
      liquidityUsd: 500000,
      volume24hUsd: 500000,
      rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 5000 }
    };
    const lowerPpEfficient: Market = {
      ...market,
      tokenId: 'lower-pp-efficient-route',
      liquidityUsd: 50000,
      volume24hUsd: 50000,
      rewards: { enabled: true, level: 4, minShares: 100, maxSpreadCents: 6, ppPerHour: 800 }
    };
    const books = new Map<string, Orderbook>([
      [highPpCrowded.tokenId, {
        ...book,
        tokenId: highPpCrowded.tokenId,
        bids: [{ price: 0.49, size: 500000 }],
        asks: [{ price: 0.51, size: 500000 }]
      }],
      [lowerPpEfficient.tokenId, {
        ...book,
        tokenId: lowerPpEfficient.tokenId,
        bids: [{ price: 0.49, size: 1000 }],
        asks: [{ price: 0.51, size: 1000 }]
      }]
    ]);

    const ranked = rankMarketRoutes(config, 'predict', [highPpCrowded, lowerPpEfficient], books);

    expect(ranked[0]?.market.tokenId).toBe('lower-pp-efficient-route');
    expect(ranked[0]?.metrics.expectedPpPerHour).toBeGreaterThan(ranked[1]?.metrics.expectedPpPerHour ?? 0);
    expect(ranked[0]?.reasons.join(' ')).toContain('预计有效 PP');
  });

  it('calculates strict cash route expected PP from the real configured order amount once reward minimum is affordable', () => {
    const config = appConfigSchema.parse({
      risk: { orderSizeUsd: 100, maxSingleOrderUsd: 500, maxPositionUsd: 500 },
      strategy: { entryMode: 'cash', minMarketLiquidityUsd: 0, minRewardLevel: 0, quoteSide: 'buy' }
    });
    const tinyBand: Market = {
      ...market,
      tokenId: 'tiny-band-route',
      liquidityUsd: 1000,
      volume24hUsd: 1000,
      rewards: { enabled: true, level: 5, minShares: 10, maxSpreadCents: 6, ppPerHour: 1000 }
    };
    const books = new Map<string, Orderbook>([
      [tinyBand.tokenId, {
        ...book,
        tokenId: tinyBand.tokenId,
        bids: [{ price: 0.5, size: 200 }],
        asks: [{ price: 0.51, size: 1000 }]
      }]
    ]);

    const [candidate] = rankMarketRoutes(config, 'predict', [tinyBand], books);

    expect(candidate?.metrics.rewardBandDepthUsd).toBe(100);
    expect(candidate?.metrics.targetOrderSource).toBe('reward-minimum-plus-one');
    expect(candidate?.metrics.targetShares).toBe(11);
    expect(candidate?.metrics.targetOrderUsd).toBe(100);
    expect(candidate?.metrics.minRewardNotionalUsd).toBe(5.5);
    expect(candidate?.metrics.targetSharePct).toBe(50);
    expect(candidate?.metrics.expectedPpPerHour).toBe(500);
  });

  it('keeps the current cash single-leg route when expected PP improvement is below the switch threshold', () => {
    const config = appConfigSchema.parse({
      risk: {
        orderSizeUsd: 100,
        maxSingleOrderUsd: 500,
        maxPositionUsd: 500,
        maxMarkets: 1,
        settlementNoNewOrdersMs: 0,
        eventStartNoNewOrdersMs: 0
      },
      strategy: {
        entryMode: 'cash',
        minMarketLiquidityUsd: 0,
        minRewardLevel: 0,
        quoteSide: 'buy',
        switchThresholdPct: 25,
        minSafeHoursForSwitch: 0
      }
    });
    const current: Market = {
      ...market,
      tokenId: 'cash-current-slightly-worse',
      marketId: 'cash-current-slightly-worse',
      rewards: { enabled: true, level: 5, minShares: 10, maxSpreadCents: 6, ppPerHour: 120 }
    };
    const rival: Market = {
      ...market,
      tokenId: 'cash-rival-small-edge',
      marketId: 'cash-rival-small-edge',
      rewards: { enabled: true, level: 5, minShares: 10, maxSpreadCents: 6, ppPerHour: 125 }
    };
    const books = new Map<string, Orderbook>([
      [current.tokenId, cashProbeBook(current.tokenId)],
      [rival.tokenId, cashProbeBook(rival.tokenId)]
    ]);

    const selection = selectMarketRoutes(config, 'predict', rankMarketRoutes(config, 'predict', [current, rival], books), [current.tokenId]);

    expect(selection.selected[0]?.market.tokenId).toBe(current.tokenId);
    expect(selection.switched).toBe(false);
    expect(selection.reason).toContain('PP/hr/kUSD');
    expect(selection.reason).not.toContain('gas');
  });

  it('switches between cash YES/NO branches in the same market group by 101-share capital efficiency', () => {
    const config = appConfigSchema.parse({
      risk: {
        orderSizeUsd: 100,
        maxSingleOrderUsd: 500,
        maxPositionUsd: 500,
        maxMarkets: 1,
        settlementNoNewOrdersMs: 0,
        eventStartNoNewOrdersMs: 0
      },
      strategy: {
        entryMode: 'cash',
        minMarketLiquidityUsd: 0,
        minRewardLevel: 0,
        quoteSide: 'buy',
        switchThresholdPct: 15,
        minSafeHoursForSwitch: 0
      }
    });
    const yes: Market = {
      ...market,
      tokenId: 'cash-same-group-yes',
      marketId: 'cash-same-group-market',
      conditionId: 'cash-same-group-condition',
      outcome: 'Yes',
      outcomeIndex: 0,
      outcomeCount: 2,
      rewards: { enabled: true, level: 5, minShares: 10, maxSpreadCents: 6, ppPerHour: 120 }
    };
    const no: Market = {
      ...market,
      tokenId: 'cash-same-group-no',
      marketId: 'cash-same-group-market',
      conditionId: 'cash-same-group-condition',
      outcome: 'No',
      outcomeIndex: 1,
      outcomeCount: 2,
      rewards: { enabled: true, level: 5, minShares: 10, maxSpreadCents: 6, ppPerHour: 180 }
    };
    const books = new Map<string, Orderbook>([
      [yes.tokenId, cashProbeBook(yes.tokenId)],
      [no.tokenId, cashProbeBook(no.tokenId)]
    ]);

    const selection = selectMarketRoutes(config, 'predict', rankMarketRoutes(config, 'predict', [yes, no], books), [yes.tokenId]);

    expect(selection.selected[0]?.market.tokenId).toBe(no.tokenId);
    expect(selection.switched).toBe(true);
    expect(selection.reason).toContain('PP/hr/kUSD');
  });

  it('Polymarket single-sided rests on the lowest-exit-loss (higher-price) side even when the cheap side scores higher', () => {
    const config = appConfigSchema.parse({
      risk: {
        orderSizeUsd: 100, maxSingleOrderUsd: 100, maxPositionUsd: 100, maxMarkets: 1,
        minDepthUsdPerSide: 0, minPrice: 0.1, maxPrice: 0.9, maxSpreadBps: 600
      },
      strategy: {
        entryMode: 'cash', quoteSide: 'buy', pointsOnly: true,
        minMarketLiquidityUsd: 0, minRewardLevel: 0, conservativeDepthLevel: 1, retreatTicks: 0,
        polymarketTwoSidedLp: false, cashProbeMinFrontDepthUsd: 0, polymarketFrontDepthUsd: 0
      }
    });
    // Same market group, two outcomes. YES is cheap (0.20) with a far higher reward rate → much higher PP/hr/kUSD
    // score. NO is expensive (0.80) with a low rate. By efficiency YES wins; by escape loss NO wins (a fixed $ buys
    // fewer shares at 0.80, so a 1-cent adverse move costs less). The min-exit-loss rule must pick NO.
    const yes: Market = {
      ...market, venue: 'polymarket', tokenId: 'pl-minloss-yes', marketId: 'pl-minloss-market',
      conditionId: 'pl-minloss-condition', outcome: 'Yes', outcomeIndex: 0, outcomeCount: 2,
      metadataPriceUsd: 0.20,
      rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 400 }
    };
    const no: Market = {
      ...market, venue: 'polymarket', tokenId: 'pl-minloss-no', marketId: 'pl-minloss-market',
      conditionId: 'pl-minloss-condition', outcome: 'No', outcomeIndex: 1, outcomeCount: 2,
      metadataPriceUsd: 0.80,
      rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 100 }
    };
    const books = new Map<string, Orderbook>([
      [yes.tokenId, cashProbeBook(yes.tokenId, { topPrice: 0.20, topSize: 20000, supportSize: 20000, lowerSize: 20000, fourthSize: 20000 })],
      [no.tokenId, cashProbeBook(no.tokenId, { topPrice: 0.80, topSize: 20000, supportSize: 20000, lowerSize: 20000, fourthSize: 20000 })]
    ]);

    const ranked = rankMarketRoutes(config, 'polymarket', [yes, no], books);
    const yesRank = ranked.find((candidate) => candidate.market.tokenId === yes.tokenId);
    const noRank = ranked.find((candidate) => candidate.market.tokenId === no.tokenId);
    // Both sides are individually quotable, and the cheap YES side really does score higher — so the pick below is
    // driven by escape loss, not by score.
    expect(yesRank?.tradable).toBe(true);
    expect(noRank?.tradable).toBe(true);
    expect(yesRank?.score ?? 0).toBeGreaterThan(noRank?.score ?? 0);

    const selection = selectMarketRoutes(config, 'polymarket', ranked);
    expect(selection.selected).toHaveLength(1);
    expect(selection.selected[0]?.market.tokenId).toBe(no.tokenId);
    // The full candidate list is still reported untouched (both sides visible for the report/audit).
    expect(selection.candidates.some((candidate) => candidate.market.tokenId === yes.tokenId)).toBe(true);
  });

  it('split routing estimates PP share from actual paired SELL notional instead of treating every leg as the full USD order size', () => {
    const config = appConfigSchema.parse({
      risk: { orderSizeUsd: 5, maxSingleOrderUsd: 100, maxPositionUsd: 100, maxMarkets: 1, minDepthUsdPerSide: 0, minPrice: 0.01 },
      strategy: {
        entryMode: 'split',
        enforceRewardMinimum: false,
        minMarketLiquidityUsd: 0,
        minRewardLevel: 0,
        maxTokensPerMarket: 2,
        conservativeDepthLevel: 1,
        retreatTicks: 0
      }
    });
    const yes: Market = {
      ...pairedMarket,
      tokenId: 'cheap-split-yes',
      marketId: 'cheap-split-market',
      conditionId: 'cheap-split-condition',
      outcome: 'YES',
      outcomeCount: 2,
      tickSize: 0.001,
      rewards: { enabled: true, level: 5, minShares: 10, maxSpreadCents: 6, ppPerHour: 120 }
    };
    const no: Market = {
      ...noMarket,
      tokenId: 'cheap-split-no',
      marketId: 'cheap-split-market',
      conditionId: 'cheap-split-condition',
      outcome: 'NO',
      outcomeCount: 2,
      tickSize: 0.001,
      rewards: { enabled: true, level: 5, minShares: 10, maxSpreadCents: 6, ppPerHour: 120 }
    };
    const yesBook: Orderbook = {
      ...book,
      tokenId: yes.tokenId,
      bids: [{ price: 0.089, size: 100000 }],
      asks: [{ price: 0.091, size: 100000 }]
    };
    const noBook: Orderbook = {
      ...book,
      tokenId: no.tokenId,
      bids: [{ price: 0.909, size: 100000 }],
      asks: [{ price: 0.911, size: 100000 }]
    };
    const ranked = rankMarketRoutes(config, 'predict', [yes, no], new Map([
      [yes.tokenId, yesBook],
      [no.tokenId, noBook]
    ]), {
      positions: [
        { venue: 'predict', tokenId: yes.tokenId, marketId: yes.marketId, conditionId: yes.conditionId, outcome: 'YES', outcomeCount: 2, market: yes, size: 5, notionalUsd: 0.455 },
        { venue: 'predict', tokenId: no.tokenId, marketId: no.marketId, conditionId: no.conditionId, outcome: 'NO', outcomeCount: 2, market: no, size: 5, notionalUsd: 4.555 }
      ]
    });

    const yesRoute = ranked.find((candidate) => candidate.market.tokenId === yes.tokenId);
    const noRoute = ranked.find((candidate) => candidate.market.tokenId === no.tokenId);

    expect(yesRoute?.metrics.targetOrderUsd).toBe(0.4582);
    expect(noRoute?.metrics.targetOrderUsd).toBe(4.5418);
    expect(Number(((yesRoute?.metrics.targetOrderUsd ?? 0) + (noRoute?.metrics.targetOrderUsd ?? 0)).toFixed(4))).toBe(config.risk.orderSizeUsd);
    expect(yesRoute?.metrics.targetOrderUsd).toBeLessThan(config.risk.orderSizeUsd);
    expect(noRoute?.metrics.targetOrderUsd).toBeLessThan(config.risk.orderSizeUsd);
    expect(yesRoute?.reasons.join(' ')).toContain('预计有效 PP');
  });

  it('scores both-side routing by executable BUY depth when SELL has no inventory', () => {
    const config = appConfigSchema.parse({
      risk: { orderSizeUsd: 100, maxSingleOrderUsd: 500, maxPositionUsd: 500 },
      strategy: { entryMode: 'cash', minMarketLiquidityUsd: 0, minRewardLevel: 0, quoteSide: 'both' }
    });
    const sellHeavy: Market = {
      ...market,
      tokenId: 'sell-heavy-no-inventory',
      rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 3000 }
    };
    const buyHeavy: Market = {
      ...market,
      tokenId: 'buy-heavy-executable',
      rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 3000 }
    };
    const books = new Map<string, Orderbook>([
      [sellHeavy.tokenId, {
        ...book,
        tokenId: sellHeavy.tokenId,
        bids: [{ price: 0.49, size: 50 }],
        asks: [{ price: 0.51, size: 50000 }]
      }],
      [buyHeavy.tokenId, cashProbeBook(buyHeavy.tokenId, {
        topPrice: 0.49,
        topSize: 5000,
        supportPrice: 0.48,
        supportSize: 5000,
        lowerPrice: 0.47,
        lowerSize: 5000,
        fourthPrice: 0.46,
        fourthSize: 5000,
        askPrice: 0.51,
        askSize: 50
      })]
    ]);

    const ranked = rankMarketRoutes(config, 'predict', [sellHeavy, buyHeavy], books, { positions: [] });

    expect(ranked[0]?.market.tokenId).toBe('buy-heavy-executable');
    expect(ranked.find((candidate) => candidate.market.tokenId === sellHeavy.tokenId)?.metrics.rewardBandDepthUsd).toBe(24.5);
    expect(ranked.find((candidate) => candidate.market.tokenId === buyHeavy.tokenId)?.metrics.rewardBandDepthUsd).toBe(9500);
  });

  it('selects single-leg low-competition PP opportunities by reward minimum shares plus one', () => {
    const config = appConfigSchema.parse({
      risk: { orderSizeUsd: 50, maxSingleOrderUsd: 100, maxPositionUsd: 500, maxMarkets: 1, minDepthUsdPerSide: 0 },
      strategy: {
        entryMode: 'cash',
        quoteSide: 'buy',
        enforceRewardMinimum: false,
        minMarketLiquidityUsd: 0,
        minRewardLevel: 0,
        conservativeDepthLevel: 1,
        retreatTicks: 0
      }
    });
    const headlineHighCrowded: Market = {
      ...market,
      tokenId: 'headline-high-crowded',
      question: 'Headline high but crowded',
      rewards: { enabled: true, level: 5, minShares: 10, maxSpreadCents: 6, ppPerHour: 5000 }
    };
    const lowerPpLowCompetition: Market = {
      ...market,
      tokenId: 'lower-pp-low-competition',
      question: 'Lower PP but low competition',
      rewards: { enabled: true, level: 5, minShares: 10, maxSpreadCents: 6, ppPerHour: 120 }
    };
    const books = new Map<string, Orderbook>([
      [headlineHighCrowded.tokenId, {
        ...book,
        tokenId: headlineHighCrowded.tokenId,
        bids: [
          { price: 0.5, size: 1_000_000 },
          { price: 0.49, size: 1_000_000 },
          { price: 0.48, size: 1_000_000 },
          { price: 0.47, size: 1_000_000 }
        ],
        asks: [{ price: 0.51, size: 1_000 }]
      }],
      [lowerPpLowCompetition.tokenId, {
        ...book,
        tokenId: lowerPpLowCompetition.tokenId,
        bids: [
          { price: 0.5, size: 220 },
          { price: 0.49, size: 40 },
          { price: 0.48, size: 40 },
          { price: 0.47, size: 40 }
        ],
        asks: [{ price: 0.51, size: 1_000 }]
      }]
    ]);

    const ranked = rankMarketRoutes(config, 'predict', [headlineHighCrowded, lowerPpLowCompetition], books);
    const selected = selectMarketRoutes(config, 'predict', ranked).selected;

    expect(selected).toHaveLength(1);
    expect(selected[0]?.market.tokenId).toBe(lowerPpLowCompetition.tokenId);
    expect(selected[0]?.side).toBe('BUY');
    expect(selected[0]?.metrics.targetOrderSource).toBe('reward-minimum-plus-one');
    expect(selected[0]?.metrics.targetShares).toBe(11);
    expect(selected[0]?.metrics.targetOrderUsd).toBe(50);
    expect(selected[0]?.metrics.ppPerThousandUsd).toBeGreaterThan(ranked.find((candidate) => candidate.market.tokenId === headlineHighCrowded.tokenId)?.metrics.ppPerThousandUsd ?? 0);
  });

  it('prioritizes cash single-leg PP/hr/kUSD by the configured real order amount', () => {
    const config = appConfigSchema.parse({
      risk: { orderSizeUsd: 60, maxSingleOrderUsd: 100, maxPositionUsd: 500, maxMarkets: 2, minDepthUsdPerSide: 0 },
      strategy: {
        entryMode: 'cash',
        quoteSide: 'buy',
        enforceRewardMinimum: false,
        minMarketLiquidityUsd: 0,
        minRewardLevel: 0,
        conservativeDepthLevel: 1,
        retreatTicks: 0
      }
    });
    const highExpectedCrowded: Market = {
      ...market,
      tokenId: 'high-expected-crowded',
      question: 'Higher expected but worse per dollar',
      rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 7000 }
    };
    const efficientLowCompetition: Market = {
      ...market,
      tokenId: 'efficient-low-competition',
      question: 'Lower expected but better per dollar',
      rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 40 }
    };
    const books = new Map<string, Orderbook>([
      [highExpectedCrowded.tokenId, {
        ...book,
        tokenId: highExpectedCrowded.tokenId,
        bids: [
          { price: 0.9, size: 22_000 },
          { price: 0.89, size: 22_000 },
          { price: 0.88, size: 22_000 },
          { price: 0.87, size: 22_000 }
        ],
        asks: [{ price: 0.92, size: 1_000 }]
      }],
      [efficientLowCompetition.tokenId, {
        ...book,
        tokenId: efficientLowCompetition.tokenId,
        bids: [
          { price: 0.5, size: 220 },
          { price: 0.49, size: 60 },
          { price: 0.48, size: 90 },
          { price: 0.47, size: 90 }
        ],
        asks: [{ price: 0.51, size: 1_000 }]
      }]
    ]);

    const ranked = rankMarketRoutes(config, 'predict', [highExpectedCrowded, efficientLowCompetition], books);
    const selected = selectMarketRoutes(config, 'predict', ranked).selected;
    const crowded = ranked.find((candidate) => candidate.market.tokenId === highExpectedCrowded.tokenId);
    const efficient = ranked.find((candidate) => candidate.market.tokenId === efficientLowCompetition.tokenId);

    expect(efficient?.metrics.expectedPpPerHour).toBeGreaterThan(crowded?.metrics.expectedPpPerHour ?? 0);
    expect(efficient?.metrics.ppPerThousandUsd).toBeGreaterThan(crowded?.metrics.ppPerThousandUsd ?? 0);
    expect(crowded?.tradable).toBe(false);
    expect(crowded?.riskFlags.join(' ')).toContain('不足官方最低奖励份额');
    expect(selected.map((candidate) => candidate.market.tokenId)).toEqual([
      efficientLowCompetition.tokenId
    ]);
  });

  it('keeps low-metadata-liquidity FDV reward markets eligible in cash points mode', () => {
    const config = appConfigSchema.parse({
      risk: { orderSizeUsd: 60, maxSingleOrderUsd: 100, maxPositionUsd: 500, maxMarkets: 1, minDepthUsdPerSide: 0 },
      strategy: {
        entryMode: 'cash',
        quoteSide: 'buy',
        pointsOnly: true,
        minMarketLiquidityUsd: 10000,
        minRewardLevel: 0,
        conservativeDepthLevel: 1,
        retreatTicks: 0
      }
    });
    const fdv: Market = {
      ...market,
      tokenId: 'fdv-zero-metadata-liquidity',
      question: 'Project FDV above $200M one day after launch?',
      liquidityUsd: 0,
      volume24hUsd: 0,
      rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 20 }
    };
    const fdvBook: Orderbook = {
      ...cashProbeBook(fdv.tokenId),
      asks: [{ price: 0.51, size: 300 }]
    };

    const [candidate] = rankMarketRoutes(config, 'predict', [fdv], new Map([[fdv.tokenId, fdvBook]]));
    const intents = new StrategyEngine(config).buildIntents('predict', [fdv], new Map([[fdv.tokenId, fdvBook]]), {
      routeSides: new Map([[fdv.tokenId, 'BUY']])
    });

    expect(candidate?.tradable).toBe(true);
    expect(candidate?.reasons.join(' ')).toContain('忽略市场总流动性元数据下限');
    expect(intents).toHaveLength(1);
  });

  it('blocks cash PP orders when the configured amount cannot buy 101 shares', () => {
    const config = appConfigSchema.parse({
      risk: { orderSizeUsd: 5, maxSingleOrderUsd: 5, maxPositionUsd: 500, maxMarkets: 1, minDepthUsdPerSide: 0 },
      strategy: {
        entryMode: 'cash',
        quoteSide: 'buy',
        enforceRewardMinimum: false,
        inventorySkewEnabled: false,
        minMarketLiquidityUsd: 0,
        minRewardLevel: 0,
        conservativeDepthLevel: 1,
        retreatTicks: 0
      }
    });
    const rewardMarket: Market = {
      ...market,
      tokenId: 'cash-101-share-score',
      rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 3000 }
    };
    const rewardBook: Orderbook = {
      ...cashProbeBook(rewardMarket.tokenId),
      asks: [{ price: 0.51, size: 1000 }]
    };

    const [route] = rankMarketRoutes(config, 'predict', [rewardMarket], new Map([[rewardMarket.tokenId, rewardBook]]));
    const intents = new StrategyEngine(config).buildIntents('predict', [rewardMarket], new Map([[rewardMarket.tokenId, rewardBook]]));

    expect(route?.metrics.targetOrderSource).toBe('reward-minimum-plus-one');
    expect(route?.metrics.targetShares).toBe(101);
    expect(route?.metrics.targetOrderUsd).toBe(5);
    expect(route?.tradable).toBe(false);
    expect(route?.riskFlags.join(' ')).toContain('不足官方最低奖励份额');
    expect(intents).toHaveLength(0);
  });

  it('places an affordable cash PP BUY behind the third protected queue instead of the top levels', () => {
    const config = appConfigSchema.parse({
      risk: { orderSizeUsd: 20, maxSingleOrderUsd: 20, maxPositionUsd: 500, maxMarkets: 1, minDepthUsdPerSide: 0 },
      strategy: {
        entryMode: 'cash',
        quoteSide: 'buy',
        enforceRewardMinimum: false,
        inventorySkewEnabled: false,
        minMarketLiquidityUsd: 0,
        minRewardLevel: 0,
        cashProbeMinFrontDepthUsd: 100,
        cashProbeDepthMultiplier: 2,
        cashProbeMaxSupportGapCents: 1.5
      }
    });
    const probeMarket: Market = {
      ...market,
      tokenId: 'cash-probe-safe',
      tickSize: 0.001,
      rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 3000 }
    };
    const probeBook: Orderbook = {
      ...book,
      tokenId: probeMarket.tokenId,
      bids: [
        { price: 0.165, size: 499 },
        { price: 0.16, size: 180 },
        { price: 0.153, size: 350 },
        { price: 0.145, size: 500 }
      ],
      asks: [{ price: 0.171, size: 1000 }]
    };

    const [intent] = new StrategyEngine(config).buildIntents('predict', [probeMarket], new Map([[probeMarket.tokenId, probeBook]]));
    const [route] = rankMarketRoutes(config, 'predict', [probeMarket], new Map([[probeMarket.tokenId, probeBook]]));

    expect(intent?.price).toBe(0.146);
    expect(intent?.price).toBeLessThan(0.165);
    expect(intent?.notionalUsd).toBeLessThanOrEqual(20.01);
    expect(route?.tradable).toBe(true);
    expect(route?.metrics.targetShares).toBe(101);
    expect(route?.metrics.targetOrderUsd).toBe(20);
  });

  it('Polymarket cash BUY uses the protected penny-jump (behind best bid) and rests deeper at a higher startLevel', () => {
    const plBook = (tokenId: string): Orderbook => ({
      venue: 'polymarket', tokenId, receivedAt: Date.now(),
      bids: [0.165, 0.164, 0.163, 0.162, 0.161, 0.16, 0.159].map((price) => ({ price, size: 2000 })),
      asks: [{ price: 0.171, size: 1000 }]
    });
    const plMarket: Market = { ...market, venue: 'polymarket', tokenId: 'pl-penny', tickSize: 0.001, rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 3000 } };
    const mk = (startLevel: number) => appConfigSchema.parse({
      risk: { orderSizeUsd: 60, maxSingleOrderUsd: 60, maxPositionUsd: 500, maxMarkets: 1, minDepthUsdPerSide: 0 },
      strategy: { entryMode: 'cash', quoteSide: 'buy', enforceRewardMinimum: false, inventorySkewEnabled: false, minMarketLiquidityUsd: 0, minRewardLevel: 0, polymarketStartLevel: startLevel, polymarketFrontDepthUsd: 50, cashProbeMaxSupportGapTicks: 10, polymarketMinDailyRewardUsd: 0 }
    });
    const [shallow] = new StrategyEngine(mk(2)).buildIntents('polymarket', [plMarket], new Map([[plMarket.tokenId, plBook(plMarket.tokenId)]]));
    const [deep] = new StrategyEngine(mk(5)).buildIntents('polymarket', [plMarket], new Map([[plMarket.tokenId, plBook(plMarket.tokenId)]]));
    expect(shallow?.side).toBe('BUY');
    expect(shallow?.postOnly).toBe(true);
    expect(shallow?.price).toBeLessThan(0.165); // penny-jump: behind the best bid, never top-of-book
    expect(deep?.price).toBeLessThanOrEqual(shallow!.price); // higher startLevel → deeper
  });

  it('aggregates duplicate bid prices before choosing the protected cash PP queue', () => {
    const config = appConfigSchema.parse({
      risk: { orderSizeUsd: 20, maxSingleOrderUsd: 20, maxPositionUsd: 500, maxMarkets: 1, minDepthUsdPerSide: 0 },
      strategy: {
        entryMode: 'cash',
        quoteSide: 'buy',
        enforceRewardMinimum: false,
        inventorySkewEnabled: false,
        minMarketLiquidityUsd: 0,
        minRewardLevel: 0,
        cashProbeMinFrontDepthUsd: 100,
        cashProbeDepthMultiplier: 2,
        cashProbeMaxSupportGapCents: 1.5
      }
    });
    const probeMarket: Market = {
      ...market,
      tokenId: 'cash-probe-aggregate-duplicate-prices',
      tickSize: 0.001,
      rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 3000 }
    };
    const probeBook: Orderbook = {
      ...book,
      tokenId: probeMarket.tokenId,
      bids: [
        { price: 0.165, size: 250 },
        { price: 0.165, size: 249 },
        { price: 0.16, size: 180 },
        { price: 0.153, size: 350 },
        { price: 0.145, size: 500 }
      ],
      asks: [{ price: 0.171, size: 1000 }]
    };

    const [intent] = new StrategyEngine(config).buildIntents('predict', [probeMarket], new Map([[probeMarket.tokenId, probeBook]]));
    const [route] = rankMarketRoutes(config, 'predict', [probeMarket], new Map([[probeMarket.tokenId, probeBook]]));

    expect(intent?.price).toBe(0.146);
    expect(route?.tradable).toBe(true);
    expect(route?.riskFlags).toEqual([]);
  });

  it('rejects cash PP BUY quotes when there is no fourth support level behind the third protected queue', () => {
    const config = appConfigSchema.parse({
      risk: { orderSizeUsd: 20, maxSingleOrderUsd: 20, maxPositionUsd: 500, maxMarkets: 1, minDepthUsdPerSide: 0 },
      strategy: {
        entryMode: 'cash',
        quoteSide: 'buy',
        enforceRewardMinimum: false,
        inventorySkewEnabled: false,
        minMarketLiquidityUsd: 0,
        minRewardLevel: 0,
        cashProbeMinFrontDepthUsd: 100,
        cashProbeDepthMultiplier: 2,
        cashProbeMaxSupportGapCents: 1.5
      }
    });
    const probeMarket: Market = {
      ...market,
      tokenId: 'cash-probe-missing-fourth',
      tickSize: 0.001,
      rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 3000 }
    };
    const probeBook: Orderbook = {
      ...book,
      tokenId: probeMarket.tokenId,
      bids: [
        { price: 0.165, size: 499 },
        { price: 0.16, size: 180 },
        { price: 0.153, size: 350 }
      ],
      asks: [{ price: 0.171, size: 1000 }]
    };

    const intents = new StrategyEngine(config).buildIntents('predict', [probeMarket], new Map([[probeMarket.tokenId, probeBook]]));
    const [route] = rankMarketRoutes(config, 'predict', [probeMarket], new Map([[probeMarket.tokenId, probeBook]]));

    expect(intents).toEqual([]);
    expect(route?.tradable).toBe(false);
    expect(route?.riskFlags.join(' ')).toContain('少于要求 4 档');
  });

  it('rejects cash probe BUY quotes when the support gap behind the protected queue is too wide', () => {
    const config = appConfigSchema.parse({
      risk: { orderSizeUsd: 20, maxSingleOrderUsd: 20, maxPositionUsd: 500, maxMarkets: 1, minDepthUsdPerSide: 0 },
      strategy: {
        entryMode: 'cash',
        quoteSide: 'buy',
        enforceRewardMinimum: false,
        inventorySkewEnabled: false,
        minMarketLiquidityUsd: 0,
        minRewardLevel: 0,
        cashProbeMaxSupportGapCents: 1.5
      }
    });
    const gapMarket: Market = {
      ...market,
      tokenId: 'cash-probe-gap',
      tickSize: 0.001,
      rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 3000 }
    };
    const gapBook: Orderbook = {
      ...book,
      tokenId: gapMarket.tokenId,
      bids: [
        { price: 0.165, size: 700 },
        { price: 0.164, size: 700 },
        { price: 0.16, size: 700 },
        { price: 0.13, size: 1000 }
      ],
      asks: [{ price: 0.171, size: 1000 }]
    };

    const ranked = rankMarketRoutes(config, 'predict', [gapMarket], new Map([[gapMarket.tokenId, gapBook]]));
    const intents = new StrategyEngine(config).buildIntents('predict', [gapMarket], new Map([[gapMarket.tokenId, gapBook]]));

    expect(intents).toEqual([]);
    expect(ranked[0]?.tradable).toBe(false);
    expect(ranked[0]?.riskFlags.join(' ')).toContain('支撑');
  });

  it('scales cash probe front protection by 101-share notional for high-price tokens', () => {
    const config = appConfigSchema.parse({
      risk: { orderSizeUsd: 100, maxSingleOrderUsd: 100, maxPositionUsd: 500, maxMarkets: 1, minDepthUsdPerSide: 0 },
      strategy: {
        entryMode: 'cash',
        quoteSide: 'buy',
        enforceRewardMinimum: false,
        inventorySkewEnabled: false,
        minMarketLiquidityUsd: 0,
        minRewardLevel: 0,
        cashProbeMinFrontDepthUsd: 100,
        cashProbeDepthMultiplier: 2
      }
    });
    const highPrice: Market = {
      ...market,
      tokenId: 'cash-probe-high-price',
      tickSize: 0.001,
      rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 3000 }
    };
    const insufficient: Orderbook = {
      ...book,
      tokenId: highPrice.tokenId,
      bids: [
        { price: 0.835, size: 60 },
        { price: 0.831, size: 60 },
        { price: 0.829, size: 60 },
        { price: 0.826, size: 1000 }
      ],
      asks: [{ price: 0.86, size: 1000 }]
    };
    const sufficient: Orderbook = {
      ...insufficient,
      bids: [
        { price: 0.835, size: 210 },
        { price: 0.831, size: 210 },
        { price: 0.829, size: 210 },
        { price: 0.826, size: 1000 }
      ]
    };

    const thinRoute = rankMarketRoutes(config, 'predict', [highPrice], new Map([[highPrice.tokenId, insufficient]]))[0];
    const [safeIntent] = new StrategyEngine(config).buildIntents('predict', [highPrice], new Map([[highPrice.tokenId, sufficient]]));

    expect(thinRoute?.tradable).toBe(false);
    expect(thinRoute?.riskFlags.join(' ')).toContain('$167.05');
    expect(safeIntent?.price).toBe(0.827);
  });

  it('can pick the correct branch inside the same market group when branch PP and depth differ', () => {
    const config = appConfigSchema.parse({
      risk: { orderSizeUsd: 50, maxSingleOrderUsd: 100, maxPositionUsd: 500, maxMarkets: 1, minDepthUsdPerSide: 0 },
      strategy: {
        entryMode: 'cash',
        quoteSide: 'buy',
        enforceRewardMinimum: false,
        minMarketLiquidityUsd: 0,
        minRewardLevel: 0,
        maxTokensPerMarket: 2,
        conservativeDepthLevel: 1,
        retreatTicks: 0
      }
    });
    const yes: Market = {
      ...pairedMarket,
      tokenId: 'branch-yes',
      marketId: 'branch-market',
      conditionId: 'branch-condition',
      outcome: 'YES',
      outcomeCount: 2,
      rewards: { enabled: true, level: 5, minShares: 10, maxSpreadCents: 6, ppPerHour: 60 }
    };
    const no: Market = {
      ...noMarket,
      tokenId: 'branch-no',
      marketId: 'branch-market',
      conditionId: 'branch-condition',
      outcome: 'NO',
      outcomeCount: 2,
      rewards: { enabled: true, level: 5, minShares: 10, maxSpreadCents: 6, ppPerHour: 180 }
    };
    const books = new Map<string, Orderbook>([
      [yes.tokenId, cashProbeBook(yes.tokenId, { topSize: 220, supportSize: 120 })],
      [no.tokenId, cashProbeBook(no.tokenId, { topSize: 10_000, supportSize: 10_000 })]
    ]);

    const selected = selectMarketRoutes(config, 'predict', rankMarketRoutes(config, 'predict', [yes, no], books)).selected;

    expect(selected).toHaveLength(1);
    expect(selected[0]?.market.tokenId).toBe(no.tokenId);
    expect(selected[0]?.market.outcome).toBe('NO');
  });

  it('scores cash BUY share against the same market group reward-band depth from the article formula', () => {
    const config = appConfigSchema.parse({
      risk: { orderSizeUsd: 50, maxSingleOrderUsd: 100, maxPositionUsd: 500, maxMarkets: 1, minDepthUsdPerSide: 0 },
      strategy: {
        entryMode: 'cash',
        quoteSide: 'buy',
        enforceRewardMinimum: false,
        minMarketLiquidityUsd: 0,
        minRewardLevel: 0,
        maxTokensPerMarket: 2,
        conservativeDepthLevel: 1,
        retreatTicks: 0
      }
    });
    const yes: Market = {
      ...pairedMarket,
      tokenId: 'combined-depth-yes',
      marketId: 'combined-depth-market',
      conditionId: 'combined-depth-condition',
      outcome: 'YES',
      outcomeCount: 2,
      rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 20 }
    };
    const no: Market = {
      ...noMarket,
      tokenId: 'combined-depth-no',
      marketId: 'combined-depth-market',
      conditionId: 'combined-depth-condition',
      outcome: 'NO',
      outcomeCount: 2,
      rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 20 }
    };
    const books = new Map<string, Orderbook>([
      [yes.tokenId, { ...book, tokenId: yes.tokenId, bids: [{ price: 0.5, size: 100 }], asks: [{ price: 0.51, size: 1000 }] }],
      [no.tokenId, { ...book, tokenId: no.tokenId, bids: [{ price: 0.5, size: 300 }], asks: [{ price: 0.51, size: 1000 }] }]
    ]);

    const yesRoute = rankMarketRoutes(config, 'predict', [yes, no], books).find((candidate) => candidate.market.tokenId === yes.tokenId);

    expect(yesRoute?.metrics.rewardBandDepthUsd).toBe(200);
    expect(yesRoute?.metrics.targetOrderUsd).toBe(50);
    expect(yesRoute?.metrics.expectedPpPerHour).toBe(4);
  });

  it('does not count the bot current cash order as competing reward-band depth when scoring the same route', () => {
    const config = appConfigSchema.parse({
      risk: { orderSizeUsd: 50, maxSingleOrderUsd: 100, maxPositionUsd: 500, maxMarkets: 1, minDepthUsdPerSide: 0 },
      strategy: {
        entryMode: 'cash',
        quoteSide: 'buy',
        enforceRewardMinimum: false,
        minMarketLiquidityUsd: 0,
        minRewardLevel: 0,
        conservativeDepthLevel: 1,
        retreatTicks: 0
      }
    });
    const current: Market = {
      ...market,
      tokenId: 'own-depth-current',
      marketId: 'own-depth-current',
      rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 60 }
    };
    const currentBook: Orderbook = {
      ...book,
      tokenId: current.tokenId,
      bids: [
        { price: 0.5, size: 202 },
        { price: 0.49, size: 300 },
        { price: 0.44, size: 1000 }
      ],
      asks: [{ price: 0.51, size: 1000 }]
    };

    const [withoutOwnOrder] = rankMarketRoutes(config, 'predict', [current], new Map([[current.tokenId, currentBook]]));
    const [withOwnOrder] = rankMarketRoutes(config, 'predict', [current], new Map([[current.tokenId, currentBook]]), {
      openOrders: [{
        venue: 'predict',
        externalId: 'own-current-order',
        tokenId: current.tokenId,
        side: 'BUY',
        price: 0.5,
        size: 101,
        status: 'OPEN'
      }]
    });

    expect(withoutOwnOrder?.metrics.rewardBandDepthUsd).toBe(248);
    expect(withOwnOrder?.metrics.rewardBandDepthUsd).toBe(197.5);
    expect(withOwnOrder?.metrics.expectedPpPerHour).toBeGreaterThan(withoutOwnOrder?.metrics.expectedPpPerHour ?? 0);
  });

  it('counts both branches in same-group cash competition while subtracting the bot own order', () => {
    const config = appConfigSchema.parse({
      risk: { orderSizeUsd: 50, maxSingleOrderUsd: 100, maxPositionUsd: 500, maxMarkets: 1, minDepthUsdPerSide: 0 },
      strategy: {
        entryMode: 'cash',
        quoteSide: 'buy',
        enforceRewardMinimum: false,
        minMarketLiquidityUsd: 0,
        minRewardLevel: 0,
        conservativeDepthLevel: 1,
        retreatTicks: 0
      }
    });
    const yes: Market = {
      ...pairedMarket,
      tokenId: 'own-group-depth-yes',
      marketId: 'own-group-depth-market',
      conditionId: 'own-group-depth-condition',
      outcome: 'YES',
      outcomeCount: 2,
      rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 20 }
    };
    const no: Market = {
      ...noMarket,
      tokenId: 'own-group-depth-no',
      marketId: 'own-group-depth-market',
      conditionId: 'own-group-depth-condition',
      outcome: 'NO',
      outcomeCount: 2,
      rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 20 }
    };
    const books = new Map<string, Orderbook>([
      [yes.tokenId, cashProbeBook(yes.tokenId, { topSize: 202, supportSize: 300 })],
      [no.tokenId, cashProbeBook(no.tokenId, { topSize: 300, supportSize: 300 })]
    ]);

    const yesRoute = rankMarketRoutes(config, 'predict', [yes, no], books, {
      openOrders: [{
        venue: 'predict',
        externalId: 'own-current-group-order',
        tokenId: yes.tokenId,
        side: 'BUY',
        price: 0.5,
        size: 101,
        status: 'OPEN'
      }]
    }).find((candidate) => candidate.market.tokenId === yes.tokenId);

    expect(yesRoute?.metrics.rewardBandDepthUsd).toBe(1064.5);
    expect(yesRoute?.metrics.targetOrderUsd).toBe(50);
    expect(yesRoute?.metrics.expectedPpPerHour).toBe(0.8973);
  });

  it('treats zero same-group reward-band competition as full PP capture for the tested leg', () => {
    const config = appConfigSchema.parse({
      risk: { orderSizeUsd: 50, maxSingleOrderUsd: 100, maxPositionUsd: 500, maxMarkets: 1, minDepthUsdPerSide: 0 },
      strategy: {
        entryMode: 'cash',
        quoteSide: 'buy',
        enforceRewardMinimum: false,
        minMarketLiquidityUsd: 0,
        minRewardLevel: 0,
        conservativeDepthLevel: 1,
        retreatTicks: 0
      }
    });
    const emptyCompetition: Market = {
      ...market,
      tokenId: 'zero-group-depth',
      rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 20 }
    };
    const emptyBook: Orderbook = {
      ...book,
      tokenId: emptyCompetition.tokenId,
      bids: [{ price: 0.4, size: 1000 }, { price: 0.39, size: 1000 }],
      asks: [{ price: 0.51, size: 1000 }]
    };

    const [route] = rankMarketRoutes(config, 'predict', [emptyCompetition], new Map([[emptyCompetition.tokenId, emptyBook]]));

    expect(route?.metrics.rewardBandDepthUsd).toBe(0);
    expect(route?.metrics.expectedPpPerHour).toBe(20);
    expect(route?.metrics.targetOrderUsd).toBe(50);
    expect(route?.metrics.ppPerThousandUsd).toBeCloseTo(400, 4);
    expect(route?.metrics.targetSharePct).toBe(100);
    expect(route?.metrics.competitionBand).toBe('thin');
  });

  it('selects up to maxMarkets distinct single-leg opportunities', () => {
    const config = appConfigSchema.parse({
      risk: { orderSizeUsd: 50, maxSingleOrderUsd: 100, maxPositionUsd: 1000, maxMarkets: 5, minDepthUsdPerSide: 0 },
      strategy: {
        entryMode: 'cash',
        quoteSide: 'buy',
        enforceRewardMinimum: false,
        minMarketLiquidityUsd: 0,
        minRewardLevel: 0,
        conservativeDepthLevel: 1,
        retreatTicks: 0
      }
    });
    const markets = Array.from({ length: 7 }, (_, index) => ({
      ...market,
      tokenId: `single-top-${index}`,
      marketId: `single-top-market-${index}`,
      question: `Single top ${index}`,
      rewards: { enabled: true, level: 5, minShares: 10, maxSpreadCents: 6, ppPerHour: 70 + index }
    }));
    const books = new Map<string, Orderbook>(markets.map((candidate, index) => [
      candidate.tokenId,
      {
        ...book,
        tokenId: candidate.tokenId,
        bids: [
          { price: 0.5, size: 100 + index * 10 },
          { price: 0.49, size: 2000 },
          { price: 0.48, size: 2000 },
          { price: 0.47, size: 2000 }
        ],
        asks: [{ price: 0.51, size: 1000 }]
      }
    ] as const));

    const selected = selectMarketRoutes(config, 'predict', rankMarketRoutes(config, 'predict', markets, books)).selected;

    expect(selected).toHaveLength(5);
    expect(new Set(selected.map((candidate) => candidate.market.tokenId))).toHaveLength(5);
    expect(selected.every((candidate) => candidate.side === 'BUY')).toBe(true);
  });

  it('cash multi-market routing keeps a ranked basket instead of marking a single-pool switch', () => {
    const config = appConfigSchema.parse({
      risk: { orderSizeUsd: 60, maxSingleOrderUsd: 100, maxPositionUsd: 1000, maxMarkets: 3, minDepthUsdPerSide: 0 },
      strategy: {
        entryMode: 'cash',
        quoteSide: 'buy',
        enforceRewardMinimum: false,
        minMarketLiquidityUsd: 0,
        minRewardLevel: 0,
        conservativeDepthLevel: 1,
        retreatTicks: 0
      }
    });
    const markets = Array.from({ length: 5 }, (_, index) => ({
      ...market,
      tokenId: `basket-top-${index}`,
      marketId: `basket-top-market-${index}`,
      question: `Basket top ${index}`,
      rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 100 + index * 50 }
    }));
    const books = new Map<string, Orderbook>(markets.map((candidate, index) => [
      candidate.tokenId,
      {
        ...book,
        tokenId: candidate.tokenId,
        bids: [
          { price: 0.5, size: 100 + index * 20 },
          { price: 0.49, size: 2000 },
          { price: 0.48, size: 2000 },
          { price: 0.47, size: 2000 }
        ],
        asks: [{ price: 0.51, size: 1000 }]
      }
    ] as const));

    const selection = selectMarketRoutes(config, 'predict', rankMarketRoutes(config, 'predict', markets, books), [markets[0]?.tokenId ?? '']);

    expect(selection.selected).toHaveLength(3);
    expect(selection.switched).toBe(false);
    expect(selection.reason).toContain('现金单边多市场模式');
    expect(selection.reason).toContain('每轮最多替换');
    expect(selection.selected.map((candidate) => candidate.market.tokenId)).toEqual([
      markets[4]!.tokenId,
      markets[3]!.tokenId,
      markets[2]!.tokenId
    ]);
  });

  it('retains safe existing cash basket tokens before adding close candidates', () => {
    const config = appConfigSchema.parse({
      risk: { orderSizeUsd: 60, maxSingleOrderUsd: 100, maxPositionUsd: 1000, maxMarkets: 3, minDepthUsdPerSide: 0 },
      strategy: {
        entryMode: 'cash',
        quoteSide: 'buy',
        enforceRewardMinimum: false,
        minMarketLiquidityUsd: 0,
        minRewardLevel: 0,
        conservativeDepthLevel: 1,
        retreatTicks: 0
      }
    });
    const markets = Array.from({ length: 5 }, (_, index) => ({
      ...market,
      tokenId: `stable-basket-${index}`,
      marketId: `stable-basket-market-${index}`,
      conditionId: `stable-basket-condition-${index}`,
      question: `Stable basket ${index}`,
      rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 100 }
    }));
    const books = new Map<string, Orderbook>(markets.map((candidate) => [
      candidate.tokenId,
      {
        ...book,
        tokenId: candidate.tokenId,
        bids: [
          { price: 0.5, size: 300 },
          { price: 0.49, size: 2000 },
          { price: 0.48, size: 2000 },
          { price: 0.47, size: 2000 }
        ],
        asks: [{ price: 0.51, size: 1000 }]
      }
    ] as const));

    const selection = selectMarketRoutes(
      config,
      'predict',
      rankMarketRoutes(config, 'predict', markets, books),
      [markets[0]!.tokenId, markets[1]!.tokenId]
    );

    expect(selection.selected).toHaveLength(3);
    expect(selection.selected.slice(0, 2).map((candidate) => candidate.market.tokenId)).toEqual([
      markets[0]!.tokenId,
      markets[1]!.tokenId
    ]);
    expect(selection.selected[2]?.market.tokenId).toBe(markets[2]!.tokenId);
  });

  it('throttles cash basket replacement to the highest-efficiency new candidates', () => {
    const config = appConfigSchema.parse({
      risk: { orderSizeUsd: 60, maxSingleOrderUsd: 100, maxPositionUsd: 1000, maxMarkets: 20, minDepthUsdPerSide: 0 },
      strategy: {
        entryMode: 'cash',
        quoteSide: 'buy',
        enforceRewardMinimum: false,
        minMarketLiquidityUsd: 0,
        minRewardLevel: 0,
        conservativeDepthLevel: 1,
        retreatTicks: 0
      }
    });
    const oldMarkets = Array.from({ length: 20 }, (_, index) => ({
      ...market,
      tokenId: `old-basket-${index}`,
      marketId: `old-basket-market-${index}`,
      conditionId: `old-basket-condition-${index}`,
      question: `Old basket ${index}`,
      rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 100 }
    }));
    const newMarkets = Array.from({ length: 8 }, (_, index) => ({
      ...market,
      tokenId: `new-basket-${index}`,
      marketId: `new-basket-market-${index}`,
      conditionId: `new-basket-condition-${index}`,
      question: `New basket ${index}`,
      rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 1000 + index * 100 }
    }));
    const markets = [...oldMarkets, ...newMarkets];
    const books = new Map<string, Orderbook>([
      ...oldMarkets.map((candidate) => [
        candidate.tokenId,
        cashProbeBook(candidate.tokenId, { topPrice: 0.5, topSize: 2000, supportSize: 2000, lowerSize: 2000 })
      ] as const),
      ...newMarkets.map((candidate) => [
        candidate.tokenId,
        cashProbeBook(candidate.tokenId, { topPrice: 0.5, topSize: 220, supportSize: 220, lowerSize: 220 })
      ] as const)
    ]);

    const selection = selectMarketRoutes(
      config,
      'predict',
      rankMarketRoutes(config, 'predict', markets, books),
      oldMarkets.map((candidate) => candidate.tokenId)
    );

    const selectedTokens = selection.selected.map((candidate) => candidate.market.tokenId);
    expect(selection.selected).toHaveLength(20);
    expect(selectedTokens.filter((tokenId) => tokenId.startsWith('new-basket-'))).toHaveLength(4);
    expect(selectedTokens.slice(0, 4).every((tokenId) => tokenId.startsWith('new-basket-'))).toBe(true);
    expect(selectedTokens.filter((tokenId) => tokenId.startsWith('old-basket-'))).toHaveLength(16);
    expect(selection.reason).toContain('补入 4 个高分候选');
  });

  it('rejects cash reward BUY quotes when front protection depth disappears', () => {
    const config = appConfigSchema.parse({
      risk: { maxSingleOrderUsd: 100, maxPositionUsd: 200, minDepthUsdPerSide: 1000 },
      strategy: { entryMode: 'cash', quoteSide: 'buy', enforceRewardMinimum: false }
    });
    const thinFrontBook: Orderbook = {
      ...book,
      bids: [
        { price: 0.49, size: 10 },
        { price: 0.48, size: 10 },
        { price: 0.47, size: 5000 }
      ],
      asks: [{ price: 0.51, size: 5000 }]
    };
    const decision = new RiskEngine(config).evaluate(
      {
        venue: 'predict',
        market,
        tokenId: market.tokenId,
        side: 'BUY',
        price: 0.47,
        size: 10,
        notionalUsd: 4.7,
        postOnly: true,
        liquidity: 'maker',
        reason: 'cash-buy-front-protection',
        clientOrderId: 'cash-buy-front-protection',
        reward: { optimizer: 'test', score: 10, level: 5, maxSpreadCents: 6 }
      },
      thinFrontBook,
      [],
      []
    );

    expect(decision.ok).toBe(false);
    expect(decision.reasons.join(' ')).toContain('前方保护深度');
  });

  it('split routing requires a complete two-sided market group and rejects partial held inventory', () => {
    const config = appConfigSchema.parse({
      risk: { orderSizeUsd: 8, maxSingleOrderUsd: 100, maxPositionUsd: 200, maxMarkets: 1 },
      strategy: { entryMode: 'split', enforceRewardMinimum: false, minMarketLiquidityUsd: 0, minRewardLevel: 0, maxTokensPerMarket: 2 }
    });
    const books = new Map<string, Orderbook>([
      [pairedMarket.tokenId, book],
      [noMarket.tokenId, { ...book, tokenId: noMarket.tokenId }]
    ]);

    const singleSided = rankMarketRoutes(config, 'predict', [pairedMarket, noMarket], books, {
      positions: [{ venue: 'predict', tokenId: pairedMarket.tokenId, size: 100, notionalUsd: 50 }]
    });
    expect(singleSided.every((candidate) => !candidate.tradable)).toBe(true);
    expect(singleSided[0]?.riskFlags.join(' ')).toContain('单边库存');

    const paired = rankMarketRoutes(config, 'predict', [pairedMarket, noMarket], books, {
      positions: [
        { venue: 'predict', tokenId: pairedMarket.tokenId, size: 100, notionalUsd: 50 },
        { venue: 'predict', tokenId: noMarket.tokenId, size: 100, notionalUsd: 50 }
      ]
    });
    const selected = selectMarketRoutes(config, 'predict', paired).selected;
    expect(selected).toHaveLength(2);
    expect(selected.every((candidate) => candidate.tradable)).toBe(true);
  });

  it('routes no-inventory split candidates when the market group itself is complete', () => {
    const config = appConfigSchema.parse({
      risk: { orderSizeUsd: 8, maxSingleOrderUsd: 100, maxPositionUsd: 200, maxMarkets: 1 },
      strategy: {
        entryMode: 'split',
        minMarketLiquidityUsd: 0,
        minRewardLevel: 0,
        maxTokensPerMarket: 2,
        enforceRewardMinimum: false
      }
    });
    const yes = {
      ...pairedMarket,
      tokenId: 'no-inventory-yes',
      marketId: 'no-inventory-market',
      conditionId: 'no-inventory-condition',
      outcome: 'YES',
      outcomeCount: 2,
      rewards: { enabled: true, level: 5, minShares: 10, maxSpreadCents: 6, ppPerHour: 9000 }
    };
    const no = {
      ...noMarket,
      tokenId: 'no-inventory-no',
      marketId: 'no-inventory-market',
      conditionId: 'no-inventory-condition',
      outcome: 'NO',
      outcomeCount: 2,
      rewards: { enabled: true, level: 5, minShares: 10, maxSpreadCents: 6, ppPerHour: 9000 }
    };
    const books = new Map<string, Orderbook>([
      [yes.tokenId, { ...book, tokenId: yes.tokenId }],
      [no.tokenId, { ...book, tokenId: no.tokenId }]
    ]);

    const ranked = rankMarketRoutes(config, 'predict', [yes, no], books, { positions: [] });
    const selected = selectMarketRoutes(config, 'predict', ranked).selected;

    expect(ranked.every((candidate) => candidate.tradable)).toBe(true);
    expect(selected.map((candidate) => candidate.market.tokenId).sort()).toEqual([no.tokenId, yes.tokenId].sort());
    expect(ranked[0]?.riskFlags.join(' ')).not.toContain('奖励带内深度低于');
    expect(ranked[0]?.metrics.rewardBandDepthUsd).toBeGreaterThan(0);
    expect(ranked[0]?.metrics.ppPerThousandUsd).toBeGreaterThan(0);
  });

  it('split inventory grouping recognizes complete sets from position market metadata even when markets are not in candidates', () => {
    const config = appConfigSchema.parse({
      risk: { orderSizeUsd: 8, maxSingleOrderUsd: 100, maxPositionUsd: 200, maxMarkets: 1 },
      strategy: { entryMode: 'split', minMarketLiquidityUsd: 0, minRewardLevel: 0, maxTokensPerMarket: 2 }
    });
    const yes = {
      venue: 'predict' as const,
      tokenId: 'position-yes',
      marketId: 'position-market',
      conditionId: 'position-condition',
      outcome: 'YES',
      outcomeCount: 2,
      size: 10,
      notionalUsd: 4
    };
    const no = {
      venue: 'predict' as const,
      tokenId: 'position-no',
      marketId: 'position-market',
      conditionId: 'position-condition',
      outcome: 'NO',
      outcomeCount: 2,
      size: 10,
      notionalUsd: 6
    };

    const paired = pairedPositionGroups(config, [], [yes, no]);
    const completeSets = completeSetInventoryGroups(config, [], [yes, no]);

    expect([...paired]).toEqual(['position-condition']);
    expect(completeSets).toHaveLength(1);
    expect(completeSets[0]).toMatchObject({
      key: 'position-condition',
      mergeableShares: 10
    });
    expect(completeSets[0]?.markets.map((item) => item.tokenId).sort()).toEqual(['position-no', 'position-yes']);
  });

  it('split routing selects a complete outcome group instead of a single best token', () => {
    const config = appConfigSchema.parse({
      risk: { orderSizeUsd: 8, maxSingleOrderUsd: 100, maxPositionUsd: 200, maxMarkets: 1 },
      strategy: {
        entryMode: 'split',
        minMarketLiquidityUsd: 0,
        minRewardLevel: 0,
        maxTokensPerMarket: 2,
        enforceRewardMinimum: false
      }
    });
    const yes = {
      ...pairedMarket,
      tokenId: 'split-yes',
      marketId: 'split-market',
      conditionId: 'split-condition',
      outcome: 'YES',
      outcomeCount: 2,
      rewards: { enabled: true, level: 5, minShares: 10, maxSpreadCents: 6, ppPerHour: 5000 }
    };
    const no = {
      ...noMarket,
      tokenId: 'split-no',
      marketId: 'split-market',
      conditionId: 'split-condition',
      outcome: 'NO',
      outcomeCount: 2,
      rewards: { enabled: true, level: 5, minShares: 10, maxSpreadCents: 6, ppPerHour: 1000 }
    };
    const rivalSingleLeg = {
      ...market,
      tokenId: 'rival-single-leg',
      marketId: 'rival-market',
      conditionId: 'rival-condition',
      outcome: 'YES',
      outcomeCount: 2,
      rewards: { enabled: true, level: 5, minShares: 10, maxSpreadCents: 6, ppPerHour: 9000 }
    };
    const books = new Map<string, Orderbook>([
      [yes.tokenId, { ...book, tokenId: yes.tokenId }],
      [no.tokenId, { ...book, tokenId: no.tokenId }],
      [rivalSingleLeg.tokenId, { ...book, tokenId: rivalSingleLeg.tokenId }]
    ]);

    const ranked = rankMarketRoutes(config, 'predict', [rivalSingleLeg, yes, no], books, {
      positions: [
        { venue: 'predict', tokenId: yes.tokenId, size: 100, notionalUsd: 50 },
        { venue: 'predict', tokenId: no.tokenId, size: 100, notionalUsd: 50 },
        { venue: 'predict', tokenId: rivalSingleLeg.tokenId, size: 100, notionalUsd: 50 }
      ]
    });
    const selected = selectMarketRoutes(config, 'predict', ranked).selected;

    expect(selected.map((candidate) => candidate.market.tokenId).sort()).toEqual([no.tokenId, yes.tokenId].sort());
  });

  it('split routing ranks complete groups by summed real-leg expected PP instead of the best single leg', () => {
    const config = appConfigSchema.parse({
      risk: { orderSizeUsd: 5, maxSingleOrderUsd: 100, maxPositionUsd: 200, maxMarkets: 1, minDepthUsdPerSide: 0 },
      strategy: {
        entryMode: 'split',
        minMarketLiquidityUsd: 0,
        minRewardLevel: 0,
        maxTokensPerMarket: 2,
        enforceRewardMinimum: false,
        conservativeDepthLevel: 1,
        retreatTicks: 0
      }
    });
    const lureYes = {
      ...pairedMarket,
      tokenId: 'lure-yes',
      marketId: 'lure-pool',
      conditionId: 'lure-condition',
      outcome: 'YES',
      outcomeIndex: 0,
      outcomeCount: 2,
      rewards: { enabled: true, level: 5, minShares: 10, maxSpreadCents: 6, ppPerHour: 120 }
    };
    const lureNo = {
      ...noMarket,
      tokenId: 'lure-no',
      marketId: 'lure-pool',
      conditionId: 'lure-condition',
      outcome: 'NO',
      outcomeIndex: 1,
      outcomeCount: 2,
      rewards: { enabled: true, level: 5, minShares: 10, maxSpreadCents: 6, ppPerHour: 120 }
    };
    const balancedYes = {
      ...pairedMarket,
      tokenId: 'balanced-group-yes',
      marketId: 'balanced-pool',
      conditionId: 'balanced-condition',
      outcome: 'YES',
      outcomeIndex: 0,
      outcomeCount: 2,
      rewards: { enabled: true, level: 5, minShares: 10, maxSpreadCents: 6, ppPerHour: 120 }
    };
    const balancedNo = {
      ...noMarket,
      tokenId: 'balanced-group-no',
      marketId: 'balanced-pool',
      conditionId: 'balanced-condition',
      outcome: 'NO',
      outcomeIndex: 1,
      outcomeCount: 2,
      rewards: { enabled: true, level: 5, minShares: 10, maxSpreadCents: 6, ppPerHour: 120 }
    };
    const baseSellBook = {
      ...book,
      bids: [{ price: 0.49, size: 1000 }],
      asks: [{ price: 0.51, size: 1000 }]
    };
    const books = new Map<string, Orderbook>([
      [lureYes.tokenId, { ...baseSellBook, tokenId: lureYes.tokenId, asks: [{ price: 0.51, size: 20 }] }],
      [lureNo.tokenId, { ...baseSellBook, tokenId: lureNo.tokenId, asks: [{ price: 0.51, size: 2_000_000 }] }],
      [balancedYes.tokenId, { ...baseSellBook, tokenId: balancedYes.tokenId, asks: [{ price: 0.51, size: 40 }] }],
      [balancedNo.tokenId, { ...baseSellBook, tokenId: balancedNo.tokenId, asks: [{ price: 0.51, size: 40 }] }]
    ]);

    const ranked = rankMarketRoutes(config, 'predict', [lureYes, lureNo, balancedYes, balancedNo], books);
    const selection = selectMarketRoutes(config, 'predict', ranked);

    const lureBestLeg = ranked.find((candidate) => candidate.market.tokenId === lureYes.tokenId)?.metrics.expectedPpPerHour ?? 0;
    const balancedBestLeg = ranked.find((candidate) => candidate.market.tokenId === balancedYes.tokenId)?.metrics.expectedPpPerHour ?? 0;
    expect(lureBestLeg).toBeGreaterThan(balancedBestLeg);
    expect(selection.selected.map((candidate) => candidate.market.marketId)).toEqual(['balanced-pool', 'balanced-pool']);
    expect(selection.bestGroup?.marketId).toBe('balanced-pool');
    expect(selection.bestGroup?.expectedPpPerHour).toBeGreaterThan(selection.selected[0]?.metrics.expectedPpPerHour ?? 0);
  });

  it('split routing prefers lower-PP low-competition groups by true capital share over high-PP crowded groups', () => {
    const config = appConfigSchema.parse({
      risk: { orderSizeUsd: 5, maxSingleOrderUsd: 100, maxPositionUsd: 200, maxMarkets: 1, minDepthUsdPerSide: 0 },
      strategy: {
        entryMode: 'split',
        minMarketLiquidityUsd: 0,
        minRewardLevel: 0,
        maxTokensPerMarket: 2,
        enforceRewardMinimum: false,
        conservativeDepthLevel: 1,
        retreatTicks: 0
      }
    });
    const highPpCrowdedYes = {
      ...pairedMarket,
      tokenId: 'high-pp-crowded-yes',
      marketId: 'high-pp-crowded-group',
      conditionId: 'high-pp-crowded-condition',
      outcome: 'YES',
      outcomeIndex: 0,
      outcomeCount: 2,
      rewards: { enabled: true, level: 5, minShares: 10, maxSpreadCents: 6, ppPerHour: 5000 }
    };
    const highPpCrowdedNo = {
      ...noMarket,
      tokenId: 'high-pp-crowded-no',
      marketId: 'high-pp-crowded-group',
      conditionId: 'high-pp-crowded-condition',
      outcome: 'NO',
      outcomeIndex: 1,
      outcomeCount: 2,
      rewards: { enabled: true, level: 5, minShares: 10, maxSpreadCents: 6, ppPerHour: 5000 }
    };
    const lowPpEfficientYes = {
      ...pairedMarket,
      tokenId: 'low-pp-efficient-yes',
      marketId: 'low-pp-efficient-group',
      conditionId: 'low-pp-efficient-condition',
      outcome: 'YES',
      outcomeIndex: 0,
      outcomeCount: 2,
      rewards: { enabled: true, level: 4, minShares: 10, maxSpreadCents: 6, ppPerHour: 120 }
    };
    const lowPpEfficientNo = {
      ...noMarket,
      tokenId: 'low-pp-efficient-no',
      marketId: 'low-pp-efficient-group',
      conditionId: 'low-pp-efficient-condition',
      outcome: 'NO',
      outcomeIndex: 1,
      outcomeCount: 2,
      rewards: { enabled: true, level: 4, minShares: 10, maxSpreadCents: 6, ppPerHour: 120 }
    };
    const books = new Map<string, Orderbook>([
      [highPpCrowdedYes.tokenId, { ...book, tokenId: highPpCrowdedYes.tokenId, bids: [{ price: 0.49, size: 1000 }], asks: [{ price: 0.51, size: 2_000_000 }] }],
      [highPpCrowdedNo.tokenId, { ...book, tokenId: highPpCrowdedNo.tokenId, bids: [{ price: 0.49, size: 1000 }], asks: [{ price: 0.51, size: 2_000_000 }] }],
      [lowPpEfficientYes.tokenId, { ...book, tokenId: lowPpEfficientYes.tokenId, bids: [{ price: 0.49, size: 1000 }], asks: [{ price: 0.51, size: 40 }] }],
      [lowPpEfficientNo.tokenId, { ...book, tokenId: lowPpEfficientNo.tokenId, bids: [{ price: 0.49, size: 1000 }], asks: [{ price: 0.51, size: 40 }] }]
    ]);

    const ranked = rankMarketRoutes(config, 'predict', [highPpCrowdedYes, highPpCrowdedNo, lowPpEfficientYes, lowPpEfficientNo], books);
    const selection = selectMarketRoutes(config, 'predict', ranked);

    expect(selection.bestGroup?.marketId).toBe('low-pp-efficient-group');
    expect(selection.bestGroup?.expectedPpPerHour ?? 0).toBeGreaterThan(
      ranked
        .filter((candidate) => candidate.market.marketId === 'high-pp-crowded-group')
        .reduce((sum, candidate) => sum + (candidate.metrics.expectedPpPerHour ?? 0), 0)
    );
    expect(selection.selected.map((candidate) => candidate.market.marketId)).toEqual(['low-pp-efficient-group', 'low-pp-efficient-group']);
    expect(selection.reason).toContain('expected PP');
  });

  it('keeps the current complete-set pool when a rival route cannot cover estimated switch gas', () => {
    const config = appConfigSchema.parse({
      risk: {
        orderSizeUsd: 10,
        maxSingleOrderUsd: 100,
        maxPositionUsd: 200,
        maxMarkets: 1,
        settlementNoNewOrdersMs: 0,
        eventStartNoNewOrdersMs: 0
      },
      strategy: {
        entryMode: 'split',
        minMarketLiquidityUsd: 0,
        minRewardLevel: 0,
        maxTokensPerMarket: 2,
        enforceRewardMinimum: false,
        switchThresholdPct: 0,
        minSwitchBenefitMultiplier: 50,
        minSwitchEdgeAfterGasUsd: 1,
        minSafeHoursForSwitch: 0,
        fallbackSplitMergeGasUnits: 450000,
        bnbUsdForGasEstimate: 650
      }
    });
    const endTime = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
    const currentYes = { ...pairedMarket, tokenId: 'current-yes', marketId: 'current-pool', conditionId: 'current-condition', outcome: 'YES', outcomeCount: 2, endTime, rewards: { enabled: true, level: 5, minShares: 10, maxSpreadCents: 6, ppPerHour: 3000 } };
    const currentNo = { ...noMarket, tokenId: 'current-no', marketId: 'current-pool', conditionId: 'current-condition', outcome: 'NO', outcomeCount: 2, endTime, rewards: { enabled: true, level: 5, minShares: 10, maxSpreadCents: 6, ppPerHour: 3000 } };
    const rivalYes = { ...pairedMarket, tokenId: 'rival-yes', marketId: 'rival-pool', conditionId: 'rival-condition', outcome: 'YES', outcomeCount: 2, endTime, rewards: { enabled: true, level: 5, minShares: 10, maxSpreadCents: 6, ppPerHour: 3600 } };
    const rivalNo = { ...noMarket, tokenId: 'rival-no', marketId: 'rival-pool', conditionId: 'rival-condition', outcome: 'NO', outcomeCount: 2, endTime, rewards: { enabled: true, level: 5, minShares: 10, maxSpreadCents: 6, ppPerHour: 3600 } };
    const books = new Map<string, Orderbook>([
      [currentYes.tokenId, { ...book, tokenId: currentYes.tokenId }],
      [currentNo.tokenId, { ...book, tokenId: currentNo.tokenId }],
      [rivalYes.tokenId, { ...book, tokenId: rivalYes.tokenId, bids: [{ price: 0.49, size: 2000 }], asks: [{ price: 0.51, size: 2000 }] }],
      [rivalNo.tokenId, { ...book, tokenId: rivalNo.tokenId, bids: [{ price: 0.49, size: 2000 }], asks: [{ price: 0.51, size: 2000 }] }]
    ]);

    const ranked = rankMarketRoutes(config, 'predict', [currentYes, currentNo, rivalYes, rivalNo], books, {
      positions: [
        { venue: 'predict', tokenId: currentYes.tokenId, size: 100, notionalUsd: 50 },
        { venue: 'predict', tokenId: currentNo.tokenId, size: 100, notionalUsd: 50 },
        { venue: 'predict', tokenId: rivalYes.tokenId, size: 100, notionalUsd: 50 },
        { venue: 'predict', tokenId: rivalNo.tokenId, size: 100, notionalUsd: 50 }
      ]
    });
    const selection = selectMarketRoutes(config, 'predict', ranked, [currentYes.tokenId, currentNo.tokenId]);

    expect(selection.selected.map((candidate) => candidate.market.marketId)).toEqual(['current-pool', 'current-pool']);
    expect(selection.reason).toContain('换池成本');
  });

  it('allows switching from the current complete-set pool to a materially better no-inventory split pool', () => {
    const config = appConfigSchema.parse({
      risk: {
        orderSizeUsd: 10,
        maxSingleOrderUsd: 100,
        maxPositionUsd: 200,
        maxMarkets: 1,
        settlementNoNewOrdersMs: 0,
        eventStartNoNewOrdersMs: 0
      },
      strategy: {
        entryMode: 'split',
        minMarketLiquidityUsd: 0,
        minRewardLevel: 0,
        maxTokensPerMarket: 2,
        enforceRewardMinimum: false,
        switchThresholdPct: 0,
        minSwitchBenefitMultiplier: 0,
        minSwitchEdgeAfterGasUsd: 0,
        minSafeHoursForSwitch: 0,
        fallbackSplitMergeGasUnits: 1,
        bnbUsdForGasEstimate: 1
      }
    });
    const endTime = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const currentYes = { ...pairedMarket, tokenId: 'switch-current-yes', marketId: 'switch-current', conditionId: 'switch-current-condition', outcome: 'YES', outcomeCount: 2, endTime, rewards: { enabled: true, level: 5, minShares: 10, maxSpreadCents: 6, ppPerHour: 120 } };
    const currentNo = { ...noMarket, tokenId: 'switch-current-no', marketId: 'switch-current', conditionId: 'switch-current-condition', outcome: 'NO', outcomeCount: 2, endTime, rewards: { enabled: true, level: 5, minShares: 10, maxSpreadCents: 6, ppPerHour: 120 } };
    const rivalYes = { ...pairedMarket, tokenId: 'switch-rival-yes', marketId: 'switch-rival', conditionId: 'switch-rival-condition', outcome: 'YES', outcomeCount: 2, endTime, rewards: { enabled: true, level: 5, minShares: 10, maxSpreadCents: 6, ppPerHour: 10000 } };
    const rivalNo = { ...noMarket, tokenId: 'switch-rival-no', marketId: 'switch-rival', conditionId: 'switch-rival-condition', outcome: 'NO', outcomeCount: 2, endTime, rewards: { enabled: true, level: 5, minShares: 10, maxSpreadCents: 6, ppPerHour: 10000 } };
    const books = new Map<string, Orderbook>([
      [currentYes.tokenId, { ...book, tokenId: currentYes.tokenId }],
      [currentNo.tokenId, { ...book, tokenId: currentNo.tokenId }],
      [rivalYes.tokenId, { ...book, tokenId: rivalYes.tokenId, bids: [{ price: 0.49, size: 200 }], asks: [{ price: 0.51, size: 200 }] }],
      [rivalNo.tokenId, { ...book, tokenId: rivalNo.tokenId, bids: [{ price: 0.49, size: 200 }], asks: [{ price: 0.51, size: 200 }] }]
    ]);

    const ranked = rankMarketRoutes(config, 'predict', [currentYes, currentNo, rivalYes, rivalNo], books, {
      positions: [
        { venue: 'predict', tokenId: currentYes.tokenId, size: 10, notionalUsd: 5 },
        { venue: 'predict', tokenId: currentNo.tokenId, size: 10, notionalUsd: 5 }
      ]
    });
    const selection = selectMarketRoutes(config, 'predict', ranked, [currentYes.tokenId, currentNo.tokenId]);

    expect(selection.selected.map((candidate) => candidate.market.marketId)).toEqual(['switch-rival', 'switch-rival']);
    expect(selection.switched).toBe(true);
  });

  it('uses group expected PP edge rather than single-leg score for split switch decisions', () => {
    const config = appConfigSchema.parse({
      risk: {
        orderSizeUsd: 5,
        maxSingleOrderUsd: 100,
        maxPositionUsd: 200,
        maxMarkets: 1,
        minDepthUsdPerSide: 0,
        settlementNoNewOrdersMs: 0,
        eventStartNoNewOrdersMs: 0
      },
      strategy: {
        entryMode: 'split',
        minMarketLiquidityUsd: 0,
        minRewardLevel: 0,
        maxTokensPerMarket: 2,
        enforceRewardMinimum: false,
        conservativeDepthLevel: 1,
        retreatTicks: 1,
        switchThresholdPct: 10,
        minSwitchBenefitMultiplier: 0,
        minSwitchEdgeAfterGasUsd: 0,
        minSafeHoursForSwitch: 0,
        fallbackSplitMergeGasUnits: 1,
        bnbUsdForGasEstimate: 1
      }
    });
    const endTime = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const currentYes = { ...pairedMarket, tokenId: 'edge-current-yes', marketId: 'edge-current', conditionId: 'edge-current-condition', outcome: 'YES', outcomeIndex: 0, outcomeCount: 2, endTime, rewards: { enabled: true, level: 5, minShares: 10, maxSpreadCents: 6, ppPerHour: 120 } };
    const currentNo = { ...noMarket, tokenId: 'edge-current-no', marketId: 'edge-current', conditionId: 'edge-current-condition', outcome: 'NO', outcomeIndex: 1, outcomeCount: 2, endTime, rewards: { enabled: true, level: 5, minShares: 10, maxSpreadCents: 6, ppPerHour: 120 } };
    const rivalYes = { ...pairedMarket, tokenId: 'edge-rival-yes', marketId: 'edge-rival', conditionId: 'edge-rival-condition', outcome: 'YES', outcomeIndex: 0, outcomeCount: 2, endTime, rewards: { enabled: true, level: 5, minShares: 10, maxSpreadCents: 6, ppPerHour: 120 } };
    const rivalNo = { ...noMarket, tokenId: 'edge-rival-no', marketId: 'edge-rival', conditionId: 'edge-rival-condition', outcome: 'NO', outcomeIndex: 1, outcomeCount: 2, endTime, rewards: { enabled: true, level: 5, minShares: 10, maxSpreadCents: 6, ppPerHour: 120 } };
    const books = new Map<string, Orderbook>([
      [currentYes.tokenId, { ...book, tokenId: currentYes.tokenId, bids: [{ price: 0.49, size: 1000 }], asks: [{ price: 0.52, size: 1000 }] }],
      [currentNo.tokenId, { ...book, tokenId: currentNo.tokenId, bids: [{ price: 0.49, size: 1000 }], asks: [{ price: 0.52, size: 1000 }] }],
      [rivalYes.tokenId, { ...book, tokenId: rivalYes.tokenId, bids: [{ price: 0.49, size: 1000 }], asks: [{ price: 0.52, size: 50 }] }],
      [rivalNo.tokenId, { ...book, tokenId: rivalNo.tokenId, bids: [{ price: 0.49, size: 1000 }], asks: [{ price: 0.52, size: 50 }, { price: 0.55, size: 50 }] }]
    ]);

    const ranked = rankMarketRoutes(config, 'predict', [currentYes, currentNo, rivalYes, rivalNo], books, {
      positions: [
        { venue: 'predict', tokenId: currentYes.tokenId, size: 10, notionalUsd: 5 },
        { venue: 'predict', tokenId: currentNo.tokenId, size: 10, notionalUsd: 5 }
      ]
    });
    const selection = selectMarketRoutes(config, 'predict', ranked, [currentYes.tokenId, currentNo.tokenId]);

    expect(selection.bestGroup?.marketId).toBe('edge-rival');
    expect(selection.bestGroup?.expectedPpPerHour ?? 0).toBeGreaterThan((selection.previousGroup?.expectedPpPerHour ?? 0) * 1.1);
    expect(selection.selected.map((candidate) => candidate.market.marketId)).toEqual(['edge-rival', 'edge-rival']);
  });

  it('does not route split groups whose generated SELL quote is outside the configured price band', () => {
    const config = appConfigSchema.parse({
      risk: {
        orderSizeUsd: 5,
        maxSingleOrderUsd: 100,
        maxPositionUsd: 200,
        maxMarkets: 1,
        minDepthUsdPerSide: 0,
        minPrice: 0.08,
        maxPrice: 0.92
      },
      strategy: {
        entryMode: 'split',
        minMarketLiquidityUsd: 0,
        minRewardLevel: 0,
        maxTokensPerMarket: 2,
        enforceRewardMinimum: false,
        conservativeDepthLevel: 2,
        retreatTicks: 1
      }
    });
    const yes = { ...pairedMarket, tokenId: 'price-band-yes', marketId: 'price-band', conditionId: 'price-band-condition', outcome: 'YES', outcomeIndex: 0, outcomeCount: 2, tickSize: 0.01, rewards: { enabled: true, level: 5, minShares: 10, maxSpreadCents: 6, ppPerHour: 120 } };
    const no = { ...noMarket, tokenId: 'price-band-no', marketId: 'price-band', conditionId: 'price-band-condition', outcome: 'NO', outcomeIndex: 1, outcomeCount: 2, tickSize: 0.01, rewards: { enabled: true, level: 5, minShares: 10, maxSpreadCents: 6, ppPerHour: 120 } };
    const ranked = rankMarketRoutes(config, 'predict', [yes, no], new Map([
      [yes.tokenId, {
        ...book,
        tokenId: yes.tokenId,
        bids: [{ price: 0.88, size: 1000 }, { price: 0.89, size: 1000 }],
        asks: [{ price: 0.91, size: 1000 }, { price: 0.92, size: 1000 }]
      }],
      [no.tokenId, {
        ...book,
        tokenId: no.tokenId,
        bids: [{ price: 0.91, size: 1000 }, { price: 0.92, size: 1000 }],
        asks: [{ price: 0.93, size: 1000 }, { price: 0.94, size: 1000 }]
      }]
    ]));
    const noRoute = ranked.find((candidate) => candidate.market.tokenId === no.tokenId);
    const selection = selectMarketRoutes(config, 'predict', ranked);

    expect(noRoute?.tradable).toBe(false);
    expect(noRoute?.riskFlags.join(' ')).toContain('price outside safe band');
    expect(selection.selected).toEqual([]);
  });

  it('does not route split groups whose generated SELL quote is too close to best bid', () => {
    const config = appConfigSchema.parse({
      risk: {
        orderSizeUsd: 5,
        maxSingleOrderUsd: 100,
        maxPositionUsd: 200,
        maxMarkets: 1,
        minDepthUsdPerSide: 0
      },
      strategy: {
        entryMode: 'split',
        minMarketLiquidityUsd: 0,
        minRewardLevel: 0,
        maxTokensPerMarket: 2,
        enforceRewardMinimum: false,
        conservativeDepthLevel: 2,
        retreatTicks: 1
      }
    });
    const yes = { ...pairedMarket, tokenId: 'protected-route-yes', marketId: 'protected-route', conditionId: 'protected-route-condition', outcome: 'YES', outcomeIndex: 0, outcomeCount: 2, tickSize: 0.01, rewards: { enabled: true, level: 5, minShares: 10, maxSpreadCents: 1, ppPerHour: 120 } };
    const no = { ...noMarket, tokenId: 'protected-route-no', marketId: 'protected-route', conditionId: 'protected-route-condition', outcome: 'NO', outcomeIndex: 1, outcomeCount: 2, tickSize: 0.01, rewards: { enabled: true, level: 5, minShares: 10, maxSpreadCents: 6, ppPerHour: 120 } };
    const ranked = rankMarketRoutes(config, 'predict', [yes, no], new Map([
      [yes.tokenId, {
        ...book,
        tokenId: yes.tokenId,
        bids: [{ price: 0.29, size: 1000 }],
        asks: [{ price: 0.30, size: 1000 }, { price: 0.31, size: 1000 }]
      }],
      [no.tokenId, {
        ...book,
        tokenId: no.tokenId,
        bids: [{ price: 0.49, size: 1000 }],
        asks: [{ price: 0.51, size: 1000 }, { price: 0.52, size: 1000 }]
      }]
    ]));
    const yesRoute = ranked.find((candidate) => candidate.market.tokenId === yes.tokenId);
    const selection = selectMarketRoutes(config, 'predict', ranked);

    expect(yesRoute?.tradable).toBe(false);
    expect(yesRoute?.riskFlags.join(' ')).toContain('当前盘口无法生成可执行奖励报价');
    expect(selection.selected).toEqual([]);
  });

  it('split mode does not treat two legs of a three-outcome market as a complete set', () => {
    const config = appConfigSchema.parse({
      risk: { orderSizeUsd: 8, maxSingleOrderUsd: 100, maxPositionUsd: 200, maxMarkets: 1 },
      strategy: {
        entryMode: 'split',
        minMarketLiquidityUsd: 0,
        minRewardLevel: 0,
        maxTokensPerMarket: 2,
        enforceRewardMinimum: false
      }
    });
    const up = { ...pairedMarket, tokenId: 'three-up', marketId: 'three-market', outcome: 'UP', outcomeCount: 3 };
    const mid = { ...pairedMarket, tokenId: 'three-mid', marketId: 'three-market', outcome: 'MID', outcomeCount: 3 };
    const books = new Map<string, Orderbook>([
      [up.tokenId, { ...book, tokenId: up.tokenId }],
      [mid.tokenId, { ...book, tokenId: mid.tokenId }]
    ]);

    const intents = new StrategyEngine(config).buildIntents('predict', [up, mid], books, {
      positions: [
        { venue: 'predict', tokenId: up.tokenId, size: 100, notionalUsd: 50 },
        { venue: 'predict', tokenId: mid.tokenId, size: 100, notionalUsd: 50 }
      ]
    });
    const selected = selectMarketRoutes(config, 'predict', rankMarketRoutes(config, 'predict', [up, mid], books, {
      positions: [
        { venue: 'predict', tokenId: up.tokenId, size: 100, notionalUsd: 50 },
        { venue: 'predict', tokenId: mid.tokenId, size: 100, notionalUsd: 50 }
      ]
    })).selected;

    expect(intents).toEqual([]);
    expect(selected).toEqual([]);
  });

  it('does not fabricate competition metrics when orderbook data is missing', () => {
    const config = appConfigSchema.parse({
      strategy: { entryMode: 'cash', minMarketLiquidityUsd: 0, minRewardLevel: 0 }
    });
    const [candidate] = rankMarketRoutes(config, 'predict', [market], new Map());
    expect(candidate?.tradable).toBe(false);
    expect(candidate?.metrics.competitionBand).toBe('unknown');
    expect(candidate?.metrics.ppPerThousandUsd).toBeUndefined();
    expect(candidate?.metrics.targetSharePct).toBeUndefined();
    expect(candidate?.reasons.join(' ')).not.toContain('资金效率');
  });

  it('rejects cash PP quotes below the official minimum even when legacy enforcement is disabled', () => {
    const config = appConfigSchema.parse({
      risk: { orderSizeUsd: 5, maxSingleOrderUsd: 5, maxPositionUsd: 20 },
      strategy: { entryMode: 'cash', pointsOnly: true, enforceRewardMinimum: false, inventorySkewEnabled: false }
    });
    const strategy = new StrategyEngine(config);
    const intents = strategy.buildIntents('predict', [market], new Map([[market.tokenId, book]]), {
      positions: [{ venue: 'predict', tokenId: market.tokenId, size: 200, notionalUsd: 100 }]
    });
    const [route] = rankMarketRoutes(config, 'predict', [market], new Map([[market.tokenId, book]]));

    expect(intents).toHaveLength(0);
    expect(route?.tradable).toBe(false);
    expect(route?.metrics.targetShares).toBe(101);
    expect(route?.metrics.targetOrderUsd).toBe(5);
    expect(route?.riskFlags.join(' ')).toContain('不足官方最低奖励份额');
  });

  it('skips strict cash PP quotes when the configured amount cannot buy minimum shares plus one', () => {
    const config = appConfigSchema.parse({
      risk: { orderSizeUsd: 5, maxSingleOrderUsd: 100, maxPositionUsd: 200 },
      strategy: { entryMode: 'cash', quoteSide: 'buy', enforceRewardMinimum: true, inventorySkewEnabled: false }
    });
    const intents = new StrategyEngine(config).buildIntents('predict', [market], new Map([[market.tokenId, book]]));
    const [route] = rankMarketRoutes(config, 'predict', [market], new Map([[market.tokenId, book]]));

    expect(intents).toHaveLength(0);
    expect(route?.tradable).toBe(false);
    expect(route?.metrics.targetShares).toBe(101);
    expect(route?.metrics.targetOrderUsd).toBe(5);
    expect(route?.metrics.minRewardNotionalUsd).toBeCloseTo(46.46, 4);
    expect(route?.riskFlags.join(' ')).toContain('不足官方最低奖励份额');
  });

  it('uses the configured real order amount for strict cash PP sizing when minimum shares are affordable', () => {
    const config = appConfigSchema.parse({
      risk: { orderSizeUsd: 50, maxSingleOrderUsd: 100, maxPositionUsd: 200 },
      strategy: { entryMode: 'cash', quoteSide: 'buy', enforceRewardMinimum: true, inventorySkewEnabled: false }
    });
    const [intent] = new StrategyEngine(config).buildIntents('predict', [market], new Map([[market.tokenId, book]]));
    const [route] = rankMarketRoutes(config, 'predict', [market], new Map([[market.tokenId, book]]));

    expect(intent?.side).toBe('BUY');
    expect(intent?.size).toBeGreaterThanOrEqual(market.rewards!.minShares! + 1);
    expect(intent?.notionalUsd).toBeCloseTo(50, 4);
    expect(intent?.notionalUsd).toBeLessThanOrEqual(50.01);
    expect(route?.tradable).toBe(true);
    expect(route?.metrics.targetShares).toBe(101);
    expect(route?.metrics.targetOrderUsd).toBe(50);
    expect(route?.metrics.minRewardNotionalUsd).toBeCloseTo(46.46, 4);
  });

  it('rejects strict cash PP routes whose official minimum is 200 shares plus one and exceeds the budget', () => {
    const config = appConfigSchema.parse({
      risk: { orderSizeUsd: 50, maxSingleOrderUsd: 100, maxPositionUsd: 200, maxMarkets: 1, minDepthUsdPerSide: 0 },
      strategy: { entryMode: 'cash', quoteSide: 'buy', enforceRewardMinimum: true, inventorySkewEnabled: false, minMarketLiquidityUsd: 0, minRewardLevel: 0, conservativeDepthLevel: 1, retreatTicks: 0 }
    });
    const twoHundredMinimum: Market = {
      ...market,
      tokenId: 'strict-201-minimum',
      tickSize: 0.001,
      rewards: { enabled: true, level: 5, minShares: 200, maxSpreadCents: 6, ppPerHour: 1000 }
    };
    const twoHundredBook: Orderbook = {
      ...book,
      tokenId: twoHundredMinimum.tokenId,
      bids: [
        { price: 0.3, size: 1000 },
        { price: 0.299, size: 1000 },
        { price: 0.298, size: 1000 },
        { price: 0.297, size: 1000 }
      ],
      asks: [{ price: 0.31, size: 1000 }]
    };

    const [route] = rankMarketRoutes(config, 'predict', [twoHundredMinimum], new Map([[twoHundredMinimum.tokenId, twoHundredBook]]));
    const intents = new StrategyEngine(config).buildIntents('predict', [twoHundredMinimum], new Map([[twoHundredMinimum.tokenId, twoHundredBook]]));

    expect(route?.tradable).toBe(false);
    expect(route?.metrics.targetShares).toBe(201);
    expect(route?.metrics.targetOrderUsd).toBe(50);
    expect(route?.metrics.minRewardNotionalUsd).toBe(59.697);
    expect(route?.riskFlags.join(' ')).toContain('不足官方最低奖励份额');
    expect(intents).toHaveLength(0);
  });

  it('does not reject reward maker quotes only because the spread is narrow', () => {
    const config = appConfigSchema.parse({
      risk: { maxSingleOrderUsd: 100, maxPositionUsd: 200, minSpreadBps: 80 },
      strategy: { entryMode: 'cash', enforceRewardMinimum: false }
    });
    const risk = new RiskEngine(config);
    const tightBook: Orderbook = {
      ...book,
      bids: [{ price: 0.499, size: 1000 }, { price: 0.498, size: 1000 }, { price: 0.497, size: 1000 }],
      asks: [{ price: 0.501, size: 1000 }, { price: 0.502, size: 1000 }, { price: 0.503, size: 1000 }]
    };
    const decision = risk.evaluate(
      {
        venue: 'predict',
        market,
        tokenId: market.tokenId,
        side: 'BUY',
        price: 0.499,
        size: 10,
        notionalUsd: 4.99,
        postOnly: true,
        liquidity: 'maker',
        reason: 'reward-maker-test',
        clientOrderId: 'tight-spread-reward',
        reward: { optimizer: 'test', score: 10, level: 5, maxSpreadCents: 6 }
      },
      tightBook,
      [],
      []
    );

    expect(decision.ok).toBe(false);
    expect(decision.reasons.join(' ')).not.toContain('spread too tight');
    expect(decision.reasons.join(' ')).toContain('前方保护深度');
  });

  it('does not treat covered SELL maker quotes as new position exposure', () => {
    const config = appConfigSchema.parse({
      risk: { maxSingleOrderUsd: 100, maxPositionUsd: 20 },
      strategy: { entryMode: 'cash', enforceRewardMinimum: false }
    });
    const risk = new RiskEngine(config);
    const decision = risk.evaluate(
      {
        venue: 'predict',
        market,
        tokenId: market.tokenId,
        side: 'SELL',
        price: 0.51,
        size: 16,
        notionalUsd: 8.16,
        postOnly: true,
        liquidity: 'maker',
        reason: 'covered-sell-maker-test',
        clientOrderId: 'covered-sell-maker',
        reward: { optimizer: 'test', score: 10, level: 5, maxSpreadCents: 6 }
      },
      book,
      [{ venue: 'predict', tokenId: market.tokenId, size: 40, notionalUsd: 20 }],
      []
    );

    expect(decision.ok).toBe(true);
    expect(decision.reasons.join(' ')).not.toContain('position exposure');
  });

  it('does not treat existing SELL maker quotes as exposure that blocks another covered SELL token', () => {
    const config = appConfigSchema.parse({
      risk: { maxSingleOrderUsd: 100, maxPositionUsd: 30 },
      strategy: { entryMode: 'cash', enforceRewardMinimum: false }
    });
    const risk = new RiskEngine(config);
    const decision = risk.evaluate(
      {
        venue: 'predict',
        market,
        tokenId: market.tokenId,
        side: 'SELL',
        price: 0.51,
        size: 10,
        notionalUsd: 5.1,
        postOnly: true,
        liquidity: 'maker',
        reason: 'covered-sell-with-existing-sell-test',
        clientOrderId: 'covered-sell-with-existing-sell',
        reward: { optimizer: 'test', score: 10, level: 5, maxSpreadCents: 6 }
      },
      book,
      [{ venue: 'predict', tokenId: market.tokenId, size: 100, notionalUsd: 30 }],
      [{
        venue: 'predict',
        externalId: 'existing-sell',
        tokenId: market.tokenId,
        side: 'SELL',
        price: 0.52,
        size: 20,
        status: 'OPEN'
      }]
    );

    expect(decision.ok).toBe(true);
    expect(decision.reasons.join(' ')).not.toContain('position exposure');
  });

  it('keeps narrow-spread protection for non-reward maker orders', () => {
    const config = appConfigSchema.parse({
      risk: { maxSingleOrderUsd: 100, maxPositionUsd: 200, minSpreadBps: 80 }
    });
    const risk = new RiskEngine(config);
    const tightBook: Orderbook = {
      ...book,
      bids: [{ price: 0.499, size: 1000 }, { price: 0.498, size: 1000 }, { price: 0.497, size: 1000 }],
      asks: [{ price: 0.501, size: 1000 }, { price: 0.502, size: 1000 }, { price: 0.503, size: 1000 }]
    };
    const decision = risk.evaluate(
      {
        venue: 'predict',
        market,
        tokenId: market.tokenId,
        side: 'BUY',
        price: 0.499,
        size: 10,
        notionalUsd: 4.99,
        postOnly: true,
        liquidity: 'maker',
        reason: 'plain-maker-test',
        clientOrderId: 'tight-spread-plain'
      },
      tightBook,
      [],
      []
    );

    expect(decision.ok).toBe(false);
    expect(decision.reasons.join(' ')).toContain('spread too tight');
  });

  it('rejects crossing quotes', () => {
    const config = appConfigSchema.parse({});
    const risk = new RiskEngine(config);
    const decision = risk.evaluate(
      {
        venue: 'predict',
        market,
        tokenId: market.tokenId,
        side: 'BUY',
        price: 0.51,
        size: 10,
        notionalUsd: 5.1,
        postOnly: true,
        reason: 'test',
        clientOrderId: 'test'
      },
      book,
      [],
      []
    );
    expect(decision.ok).toBe(false);
    expect(decision.reasons.join(' ')).toMatch(/cross/);
  });
});
