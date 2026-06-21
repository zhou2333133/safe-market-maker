import { describe, expect, it } from 'vitest';
import { appConfigSchema } from '../src/config/schema.js';
import type { Market, Orderbook } from '../src/domain/types.js';
import { polymarketQmin, polymarketRewardCompetition } from '../src/strategy/rewards/polymarket-competition.js';

const config = appConfigSchema.parse({ risk: { orderSizeUsd: 30 } });

function market(rewards: Market['rewards']): Market {
  return {
    venue: 'polymarket',
    tokenId: 'tok-yes',
    marketId: 'mkt-1',
    question: 'Test market?',
    outcome: 'Yes',
    volume24hUsd: 10000,
    liquidityUsd: 5000,
    acceptingOrders: true,
    negRisk: false,
    feeRateBps: 0,
    tickSize: 0.01,
    rewards
  };
}

function book(bids: Array<[number, number]>, asks: Array<[number, number]>): Orderbook {
  return {
    venue: 'polymarket',
    tokenId: 'tok-yes',
    bids: bids.map(([price, size]) => ({ price, size })),
    asks: asks.map(([price, size]) => ({ price, size })),
    receivedAt: Date.now()
  };
}

// mid = 0.50 (bestBid 0.49 / bestAsk 0.51); reward band ±3c => 0.47..0.53
const REWARDS = { enabled: true, dailyRate: 240, maxSpreadCents: 3, minShares: 5 };

describe('polymarketQmin — official scoring (c = 3)', () => {
  it('balanced two-sided in [0.10,0.90] scores min(Qone,Qtwo)', () => {
    expect(polymarketQmin(10, 10, 0.5)).toBeCloseTo(10); // max(min 10, max/3=3.33) = 10
  });
  it('one-sided in range earns only max/3', () => {
    expect(polymarketQmin(9, 0, 0.5)).toBeCloseTo(3); // max(0, 9/3)
  });
  it('imbalanced in range = max(min, max/3)', () => {
    expect(polymarketQmin(19, 1, 0.5)).toBeCloseTo(19 / 3); // max(1, 6.33)
  });
  it('outside [0.10,0.90] requires two-sided (one-sided = 0)', () => {
    expect(polymarketQmin(9, 0, 0.05)).toBe(0);
    expect(polymarketQmin(9, 0, 0.95)).toBe(0);
    expect(polymarketQmin(8, 4, 0.05)).toBe(4); // min(8,4)
  });
});

describe('polymarketRewardCompetition', () => {
  it('returns undefined without a daily reward rate or reward spread (safe fallback)', () => {
    const b = book([[0.49, 1000]], [[0.51, 1000]]);
    expect(polymarketRewardCompetition({ config, market: market({ enabled: true }), book: b, targetOrderUsd: 30, targetReferencePrice: 0.49 })).toBeUndefined();
    expect(polymarketRewardCompetition({ config, market: market({ enabled: true, dailyRate: 240 }), book: b, targetOrderUsd: 30, targetReferencePrice: 0.49 })).toBeUndefined();
  });

  it('weights nearer-to-mid competitors more heavily, so a far-from-mid book gives you a bigger share', () => {
    const nearCompetitor = book([[0.49, 1000], [0.485, 0]], [[0.51, 1000]]); // 1c from mid: heavy
    const farCompetitor = book([[0.47, 1000]], [[0.53, 1000]]);              // 3c from mid: ~0 weight
    const near = polymarketRewardCompetition({ config, market: market(REWARDS), book: nearCompetitor, targetOrderUsd: 30, targetReferencePrice: 0.49 })!;
    const far = polymarketRewardCompetition({ config, market: market(REWARDS), book: farCompetitor, targetOrderUsd: 30, targetReferencePrice: 0.49 })!;
    expect(near).toBeDefined();
    expect(far).toBeDefined();
    expect(far.targetSharePct).toBeGreaterThan(near.targetSharePct);
    expect(far.expectedDailyRewardUsd).toBeGreaterThan(near.expectedDailyRewardUsd);
    expect(near.competitorBidScore + near.competitorAskScore).toBeGreaterThan(far.competitorBidScore + far.competitorAskScore);
  });

  it('reports capital utilization (PP/hr per kUSD) and a competition band', () => {
    const thin = polymarketRewardCompetition({ config, market: market(REWARDS), book: book([[0.49, 5]], [[0.51, 5]]), targetOrderUsd: 30, targetReferencePrice: 0.49 })!;
    const crowded = polymarketRewardCompetition({ config, market: market(REWARDS), book: book([[0.49, 5_000_000]], [[0.51, 5_000_000]]), targetOrderUsd: 30, targetReferencePrice: 0.49 })!;
    expect(thin.competitionBand).toBe('thin');
    expect(crowded.competitionBand).toBe('crowded');
    expect(thin.ppPerThousandUsd).toBeGreaterThan(crowded.ppPerThousandUsd);
    // expected hourly reward never exceeds the whole daily pool / 24
    expect(thin.expectedPpPerHour).toBeLessThanOrEqual(REWARDS.dailyRate / 24 + 1e-9);
  });

  it('ignores competing depth outside the reward band', () => {
    const inBand = polymarketRewardCompetition({ config, market: market(REWARDS), book: book([[0.49, 1000]], [[0.51, 1000]]), targetOrderUsd: 30, targetReferencePrice: 0.49 })!;
    const outOfBand = polymarketRewardCompetition({ config, market: market(REWARDS), book: book([[0.49, 1000], [0.40, 1_000_000]], [[0.51, 1000], [0.60, 1_000_000]]), targetOrderUsd: 30, targetReferencePrice: 0.49 })!;
    // the huge 0.40 / 0.60 depth is far outside the ±3c band and must not change competition
    expect(outOfBand.competitorBidScore + outOfBand.competitorAskScore).toBeCloseTo(inBand.competitorBidScore + inBand.competitorAskScore, 6);
  });
});
