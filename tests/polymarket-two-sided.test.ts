import { describe, expect, it } from 'vitest';
import { appConfigSchema } from '../src/config/schema.js';
import { effectiveMaxLossUsd } from '../src/risk/account-risk.js';
import { shouldEnforceRewardMinimum } from '../src/strategy/rewards/common.js';
import type { Market } from '../src/domain/types.js';
import {
  isPolymarketTwoSidedLp,
  polymarketLpPerLegUsd,
  selectMarketRoutes,
  type MarketRouteCandidate,
  type MarketRouteMetrics
} from '../src/strategy/market-router.js';

const config = appConfigSchema.parse({
  strategy: {
    polymarketTwoSidedLp: true,
    polymarketLpTotalUsd: 20,
    polymarketMaxMarkets: 1,
    switchThresholdPct: 20,
    entryMode: 'cash',
    quoteSide: 'buy'
  },
  risk: { maxMarkets: 15, maxDailyLossUsd: 50 }
});

function metrics(expectedPpPerHour: number): MarketRouteMetrics {
  return {
    ppPerHour: 10,
    rewardLevel: 1,
    rewardBandDepthUsd: 100,
    topDepthUsd: 100,
    competitionBand: 'balanced',
    targetOrderUsd: 10,
    liquidityUsd: 1000,
    volume24hUsd: 1000,
    expectedPpPerHour,
    ppPerThousandUsd: expectedPpPerHour * 100
  };
}

function leg(marketId: string, tokenId: string, outcomeIndex: number, expectedPpPerHour: number): MarketRouteCandidate {
  const market: Market = {
    venue: 'polymarket',
    tokenId,
    marketId,
    conditionId: marketId,
    question: `Q ${marketId}`,
    outcome: outcomeIndex === 0 ? 'Yes' : 'No',
    outcomeIndex,
    outcomeCount: 2,
    volume24hUsd: 1000,
    liquidityUsd: 1000,
    acceptingOrders: true,
    negRisk: false,
    feeRateBps: 0,
    tickSize: 0.01,
    rewards: { enabled: true, dailyRate: 240, maxSpreadCents: 3, minShares: 5 }
  };
  return { market, side: 'BUY', score: expectedPpPerHour, tradable: true, reasons: [], riskFlags: [], metrics: metrics(expectedPpPerHour), groupKey: marketId };
}

// Group A: combined expected 10 -> efficiency 10/20*1000 = 500 ; Group B: combined 4 -> 200
const groupA = [leg('A', 'a-yes', 0, 5), leg('A', 'a-no', 1, 5)];
const groupB = [leg('B', 'b-yes', 0, 2), leg('B', 'b-no', 1, 2)];

describe('polymarket two-sided LP helpers', () => {
  it('detects the mode and splits the per-leg budget', () => {
    expect(isPolymarketTwoSidedLp(config, 'polymarket')).toBe(true);
    expect(isPolymarketTwoSidedLp(config, 'predict')).toBe(false);
    expect(polymarketLpPerLegUsd(config)).toBe(10); // 20 total / 2 legs
  });

  it('tightens the hard-stop limit only for Polymarket when polymarketMaxLossUsd is set', () => {
    const withCap = appConfigSchema.parse({ strategy: { polymarketMaxLossUsd: 10 }, risk: { maxDailyLossUsd: 50 } });
    expect(effectiveMaxLossUsd(withCap, 'polymarket')).toBe(10);
    expect(effectiveMaxLossUsd(withCap, 'predict')).toBe(50);
    const noCap = appConfigSchema.parse({ risk: { maxDailyLossUsd: 50 } });
    expect(effectiveMaxLossUsd(noCap, 'polymarket')).toBe(50);
  });
});

describe('selectMarketRoutes — polymarket two-sided', () => {
  it('selects BOTH legs of the most capital-efficient group', () => {
    const selection = selectMarketRoutes(config, 'polymarket', [...groupB, ...groupA], []);
    expect(selection.selected).toHaveLength(2);
    expect(selection.selected.every((candidate) => candidate.groupKey === 'A')).toBe(true);
    expect(selection.selected.every((candidate) => candidate.side === 'BUY')).toBe(true);
  });

  it('switches to a challenger that beats the current group by the margin', () => {
    // currently in group B, challenger A (500) > 200 * 1.2 -> switch
    const selection = selectMarketRoutes(config, 'polymarket', [...groupA, ...groupB], ['b-yes']);
    expect(selection.switched).toBe(true);
    expect(selection.selected.every((candidate) => candidate.groupKey === 'A')).toBe(true);
  });

  it('stays put when the challenger does not beat the margin', () => {
    // currently in group A (500); challenger B (200) does not beat 500*1.2 -> keep A
    const selection = selectMarketRoutes(config, 'polymarket', [...groupB, ...groupA], ['a-yes']);
    expect(selection.switched).toBe(false);
    expect(selection.selected.every((candidate) => candidate.groupKey === 'A')).toBe(true);
  });
});

// Qmin model: reward is bottlenecked by the weaker leg, so a balanced two-sided group
// must outrank an imbalanced one with the same total capital and competition.
function scoredLeg(marketId: string, tokenId: string, outcomeIndex: number, yourScore: number, competitorScore: number): MarketRouteCandidate {
  const base = leg(marketId, tokenId, outcomeIndex, 1);
  return { ...base, metrics: { ...base.metrics, polymarketYourScore: yourScore, polymarketCompetitorBid: competitorScore / 2, polymarketCompetitorAsk: competitorScore / 2, polymarketMid: 0.5 } };
}

describe('selectMarketRoutes — polymarket Qmin two-sided', () => {
  // BAL legs (10,10) -> Qmin=10 -> groupScore 20 ; IMB legs (19,1) -> Qmin=1 -> groupScore 2
  const balanced = [scoredLeg('BAL', 'bal-yes', 0, 10, 50), scoredLeg('BAL', 'bal-no', 1, 10, 50)];
  const imbalanced = [scoredLeg('IMB', 'imb-yes', 0, 19, 50), scoredLeg('IMB', 'imb-no', 1, 1, 50)];

  it('prefers the balanced group even though the imbalanced one has higher total raw score', () => {
    const selection = selectMarketRoutes(config, 'polymarket', [...imbalanced, ...balanced], []);
    expect(selection.selected.every((candidate) => candidate.groupKey === 'BAL')).toBe(true);
  });

  it('skips a market whose estimated daily reward is below the payout threshold (no payout)', () => {
    const strict = appConfigSchema.parse({
      strategy: { polymarketTwoSidedLp: true, polymarketLpTotalUsd: 20, polymarketMaxMarkets: 1, polymarketMinDailyRewardUsd: 100000 },
      risk: { maxMarkets: 15 }
    });
    const selection = selectMarketRoutes(strict, 'polymarket', [...balanced], []);
    expect(selection.selected).toHaveLength(0);
    expect(selection.reason).toContain('发放门槛');
  });
});

describe('polymarket small-live test mode', () => {
  it('relaxes the reward-minimum for polymarket two-sided only (not predict, not when no market)', () => {
    const tc = appConfigSchema.parse({ strategy: { polymarketTwoSidedLp: true, polymarketTestMode: true, entryMode: 'cash', pointsOnly: true } });
    const poly = leg('M', 'm-yes', 0, 1).market;
    const pred: Market = { ...poly, venue: 'predict', tokenId: 'p-yes' };
    expect(shouldEnforceRewardMinimum(tc, poly)).toBe(false);
    expect(shouldEnforceRewardMinimum(tc, pred)).toBe(true);
    expect(shouldEnforceRewardMinimum(tc)).toBe(true);
  });

  it('bypasses the $1/day payout threshold so a tiny order can still place', () => {
    const tc = appConfigSchema.parse({
      strategy: { polymarketTwoSidedLp: true, polymarketTestMode: true, polymarketLpTotalUsd: 5, polymarketMaxMarkets: 1, polymarketMinDailyRewardUsd: 100000 },
      risk: { maxMarkets: 15 }
    });
    const legs = [scoredLeg('T', 't-yes', 0, 10, 50), scoredLeg('T', 't-no', 1, 10, 50)];
    const selection = selectMarketRoutes(tc, 'polymarket', legs, []);
    expect(selection.selected.length).toBeGreaterThan(0);
  });
});
