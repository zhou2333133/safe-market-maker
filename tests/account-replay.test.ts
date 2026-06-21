import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { appConfigSchema } from '../src/config/schema.js';
import type { AccountRiskSnapshot, Balance, OpenOrder, OrderIntent, VenueName } from '../src/domain/types.js';
import { evaluateAccountRisk } from '../src/risk/account-risk.js';
import { evaluateOrderCapital } from '../src/risk/capital-risk.js';
import { normalizePolymarketFill, normalizePolymarketPosition, normalizePredictFill, normalizePredictPosition } from '../src/venues/account-normalize.js';

interface ReplayFixture {
  predictLossLimit: {
    now: string;
    maxDailyLossUsd: number;
    fills: unknown[];
    positions: unknown[];
    balances: Balance[];
    expectedReason: string;
    expectedDailyPnlUsd: number;
  };
  polymarketStaleSnapshot: {
    now: string;
    capturedAt: string;
    maxAccountRiskStaleMs: number;
    fills: unknown[];
    positions: unknown[];
    balances: Balance[];
    expectedReason: string;
  };
  missingPnlWithLiveExposure: {
    now: string;
    capturedAt: string;
    maxAccountRiskStaleMs: number;
    fills: unknown[];
    positions: unknown[];
    balances: Balance[];
    expectedReason: string;
  };
  reserveDrift: {
    orderSizeUsd: number;
    balanceReserveUsd: number;
    maxOpenOrderReserveDriftUsd: number;
    maxOpenOrderReserveDriftPct: number;
    balances: Balance[];
    openOrders: OpenOrder[];
    expectedReason: string;
    expectedActualFrozenUsd: number;
    expectedReservedOpenOrdersUsd: number;
  };
}

const fixturePath = path.join(process.cwd(), 'tests', 'fixtures', 'account-replay.json');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as ReplayFixture;

describe('account replay safety', () => {
  it('blocks new orders when replayed same-day Predict fills breach daily loss', () => {
    const replay = fixture.predictLossLimit;
    const now = Date.parse(replay.now);
    const config = appConfigSchema.parse({
      risk: { maxDailyLossUsd: replay.maxDailyLossUsd }
    });
    const snapshot: AccountRiskSnapshot = {
      venue: 'predict',
      account: '0x1111111111111111111111111111111111111111',
      source: 'venue+chain',
      capturedAt: now,
      dayStart: now - 60_000,
      realizedPnlUsd: -12.5,
      unrealizedPnlUsd: 0,
      fills: replay.fills.map((raw, index) => normalizePredictFill(raw, index)),
      positions: replay.positions.map((raw) => normalizePredictPosition(raw)).filter((position) => position !== undefined),
      balances: replay.balances,
      warnings: []
    };

    const decision = evaluateAccountRisk('predict', config, snapshot, now);

    expect(decision.reason).toBe(replay.expectedReason);
    expect(decision.dailyPnlUsd).toBe(replay.expectedDailyPnlUsd);
    expect(decision.ok).toBe(false);
  });

  it('blocks new orders when replayed Polymarket account snapshot is stale', () => {
    const replay = fixture.polymarketStaleSnapshot;
    const now = Date.parse(replay.now);
    const config = appConfigSchema.parse({
      risk: { maxAccountRiskStaleMs: replay.maxAccountRiskStaleMs }
    });
    const snapshot = snapshotFromReplay('polymarket', {
      now: Date.parse(replay.capturedAt),
      fills: replay.fills.map((raw, index) => normalizePolymarketFill(raw, index)),
      positions: replay.positions.map((raw) => normalizePolymarketPosition(raw)).filter((position) => position !== undefined),
      balances: replay.balances
    });

    const decision = evaluateAccountRisk('polymarket', config, snapshot, now);

    expect(decision.reason).toBe(replay.expectedReason);
    expect(decision.ok).toBe(false);
  });

  it('blocks new orders when replayed exposure lacks verifiable PnL or equity', () => {
    const replay = fixture.missingPnlWithLiveExposure;
    const now = Date.parse(replay.now);
    const config = appConfigSchema.parse({
      risk: { maxAccountRiskStaleMs: replay.maxAccountRiskStaleMs }
    });
    const snapshot = snapshotFromReplay('predict', {
      now: Date.parse(replay.capturedAt),
      fills: replay.fills.map((raw, index) => normalizePredictFill(raw, index)),
      positions: replay.positions.map((raw) => normalizePredictPosition(raw)).filter((position) => position !== undefined),
      balances: replay.balances
    });

    const decision = evaluateAccountRisk('predict', config, snapshot, now);

    expect(decision.reason).toBe(replay.expectedReason);
    expect(decision.ok).toBe(false);
    expect(decision.message).toContain('缺少可验证');
  });

  it('reports positive daily PnL when account equity is above day-start equity', () => {
    const now = Date.parse('2026-05-20T10:05:00Z');
    const config = appConfigSchema.parse({ risk: { maxDailyLossUsd: 10 } });
    const snapshot: AccountRiskSnapshot = {
      venue: 'predict',
      account: '0x1111111111111111111111111111111111111111',
      source: 'venue',
      capturedAt: now,
      dayStart: now - 60_000,
      equityUsd: 105,
      dayStartEquityUsd: 100,
      fills: [],
      positions: [],
      balances: [{ asset: 'USDT', available: 105, total: 105 }],
      warnings: []
    };

    const decision = evaluateAccountRisk('predict', config, snapshot, now);

    expect(decision.ok).toBe(true);
    expect(decision.dailyPnlUsd).toBe(5);
  });

  it('blocks new BUY orders when replayed platform frozen funds drift from local open-order estimate', () => {
    const replay = fixture.reserveDrift;
    const config = appConfigSchema.parse({
      risk: {
        orderSizeUsd: replay.orderSizeUsd,
        maxSingleOrderUsd: replay.orderSizeUsd,
        maxPositionUsd: 50,
        maxOpenOrderReserveDriftUsd: replay.maxOpenOrderReserveDriftUsd,
        maxOpenOrderReserveDriftPct: replay.maxOpenOrderReserveDriftPct
      },
      strategy: { balanceReserveUsd: replay.balanceReserveUsd }
    });

    const decision = evaluateOrderCapital(
      config,
      replayOrderIntent(replay.orderSizeUsd),
      replay.balances,
      replay.openOrders,
      []
    );

    expect(decision.ok).toBe(false);
    expect(decision.reason).toBe(replay.expectedReason);
    expect(decision.usage.actualFrozenUsd).toBe(replay.expectedActualFrozenUsd);
    expect(decision.usage.reservedOpenOrdersUsd).toBe(replay.expectedReservedOpenOrdersUsd);
  });
});

function snapshotFromReplay(
  venue: VenueName,
  input: Pick<AccountRiskSnapshot, 'fills' | 'positions' | 'balances'> & { now: number }
): AccountRiskSnapshot {
  const realizedPnlUsd = sumDefined(input.fills.map((fill) => fill.realizedPnlUsd));
  const netCashflowUsd = sumDefined(input.fills.map((fill) => fill.cashflowUsd));
  const hasOpenPositions = input.positions.some((position) => Math.abs(position.size) > 1e-9 || Math.abs(position.notionalUsd) > 0.01);
  return {
    venue,
    account: '0x1111111111111111111111111111111111111111',
    source: 'venue',
    capturedAt: input.now,
    dayStart: input.now - 60_000,
    ...(realizedPnlUsd !== undefined ? { realizedPnlUsd } : {}),
    ...(!hasOpenPositions ? { unrealizedPnlUsd: 0 } : {}),
    ...(netCashflowUsd !== undefined ? { netCashflowUsd } : {}),
    fills: input.fills,
    positions: input.positions,
    balances: input.balances,
    warnings: []
  };
}

function replayOrderIntent(notionalUsd: number): OrderIntent {
  return {
    venue: 'polymarket',
    market: {
      venue: 'polymarket',
      tokenId: 'poly-token',
      question: 'Reserve drift replay',
      volume24hUsd: 10000,
      liquidityUsd: 10000,
      acceptingOrders: true,
      negRisk: false,
      feeRateBps: 0,
      tickSize: 0.01,
      rewards: { enabled: true }
    },
    tokenId: 'poly-token',
    side: 'BUY',
    price: 0.5,
    size: Number((notionalUsd / 0.5).toFixed(4)),
    notionalUsd,
    postOnly: true,
    reason: 'reserve-drift-replay',
    clientOrderId: 'reserve-drift-replay'
  };
}

function sumDefined(values: Array<number | undefined>): number | undefined {
  const finite = values.filter((value): value is number => Number.isFinite(value));
  if (finite.length === 0) return undefined;
  return Number(finite.reduce((sum, value) => sum + value, 0).toFixed(4));
}
