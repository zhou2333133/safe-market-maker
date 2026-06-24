import { describe, expect, it } from 'vitest';
import { marketEndDecision } from '../src/risk/market-guard.js';
import { appConfigSchema } from '../src/config/schema.js';
import type { Market } from '../src/domain/types.js';

const config = appConfigSchema.parse({});

function market(overrides: Partial<Market> = {}): Market {
  return {
    venue: 'polymarket',
    tokenId: 'tok-x',
    marketId: 'm-x',
    conditionId: 'c-x',
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
    rewards: { enabled: true },
    startTime: '2026-05-05T00:00:00Z',
    startTimeSource: 'market-start',
    endTime: '2026-05-31T00:00:00Z',
    endTimeSource: 'market-end',
    ...overrides
  };
}

describe('marketEndDecision — stale endDate bypass when venue still acceptingOrders', () => {
  const now = new Date('2026-06-24T18:00:00Z').getTime(); // 25 days past the 2026-05-31 endDate

  it('PASSES a stale-endDate market when acceptingOrders=true (live signal trumps calendar)', () => {
    const m = market({ acceptingOrders: true });
    const decision = marketEndDecision(config, m, now);
    expect(decision.ok).toBe(true);
    expect(decision.reason).toBe('ok');
    expect(decision.message).toContain('信 venue 不信 calendar');
  });

  it('BLOCKS a stale-endDate market when acceptingOrders=false (no live override)', () => {
    const m = market({ acceptingOrders: false });
    const decision = marketEndDecision(config, m, now);
    expect(decision.ok).toBe(false);
    expect(decision.reason).toBe('market-ended');
    expect(decision.cancelOpenOrders).toBe(true);
  });

  it('Still blocks within the settlement-cancel window even if acceptingOrders=true (only past-end gets the bypass)', () => {
    // 5 minutes before the future endTime — within the default settlementCancelOpenOrdersMs (10 min)
    const m = market({ endTime: '2026-06-24T18:05:00Z', acceptingOrders: true });
    const decision = marketEndDecision(config, m, now);
    expect(decision.ok).toBe(false);
    expect(decision.reason).toBe('cancel-window');
  });

  it('Predict markets get the same bypass (logic is venue-agnostic, only Polymarket has the data bug today)', () => {
    const m = market({ venue: 'predict', acceptingOrders: true });
    const decision = marketEndDecision(config, m, now);
    expect(decision.ok).toBe(true);
  });
});
