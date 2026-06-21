import { describe, expect, it } from 'vitest';
import { appConfigSchema } from '../src/config/schema.js';
import type { AccountRiskSnapshot } from '../src/domain/types.js';
import { evaluateAccountRisk } from '../src/risk/account-risk.js';

function config(maxDailyLossUsd = 8, polymarketMaxLossUsd = 8) {
  return appConfigSchema.parse({
    liveEnabled: true,
    risk: { maxDailyLossUsd },
    strategy: { polymarketMaxLossUsd }
  });
}

function snapshot(over: Partial<AccountRiskSnapshot> = {}): AccountRiskSnapshot {
  return {
    venue: 'polymarket',
    account: '0xtest',
    source: 'venue',
    capturedAt: Date.now(),
    dayStart: Date.now() - 3600_000,
    realizedPnlUsd: 0,
    unrealizedPnlUsd: 0,
    netCashflowUsd: 0,
    equityUsd: 100,
    dayStartEquityUsd: 100,
    fills: [],
    positions: [],
    balances: [],
    warnings: [],
    ...over
  };
}

describe('evaluateAccountRisk stop-loss robustness (the $8-stop bug fix)', () => {
  it('FIRES on a realized loss past the cap even when equity reads 0 (the failed-read case that used to blind it)', () => {
    const decision = evaluateAccountRisk('polymarket', config(8, 8), snapshot({
      equityUsd: 0, dayStartEquityUsd: 0, realizedPnlUsd: -66.7
    }));
    expect(decision.ok).toBe(false);
    expect(decision.reason).toBe('daily-loss-limit');
  });

  it('no longer treats a 0/0 equity read as a real $0 PnL — falls back to realized (small loss still passes)', () => {
    const decision = evaluateAccountRisk('polymarket', config(8, 8), snapshot({
      equityUsd: 0, dayStartEquityUsd: 0, realizedPnlUsd: -2
    }));
    expect(decision.ok).toBe(true);
  });

  it('belt-and-suspenders: fires on a realized loss even when equity-based PnL looks fine (stale-high equity masking it)', () => {
    const decision = evaluateAccountRisk('polymarket', config(8, 8), snapshot({
      equityUsd: 100, dayStartEquityUsd: 100, realizedPnlUsd: -10
    }));
    expect(decision.ok).toBe(false);
    expect(decision.reason).toBe('daily-loss-limit');
  });

  it('still passes a healthy account (real positive equity, sub-cap loss)', () => {
    expect(evaluateAccountRisk('polymarket', config(8, 8), snapshot({
      equityUsd: 95, dayStartEquityUsd: 100, realizedPnlUsd: -5
    })).ok).toBe(true);
  });

  it('still fires on a real equity drawdown past the cap', () => {
    expect(evaluateAccountRisk('polymarket', config(8, 8), snapshot({
      equityUsd: 90, dayStartEquityUsd: 100, realizedPnlUsd: -10
    })).ok).toBe(false);
  });
});
