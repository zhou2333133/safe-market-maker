import { describe, expect, it } from 'vitest';
import { appConfigSchema } from '../src/config/schema.js';
import type { Market, OpenOrder, OrderIntent, Position } from '../src/domain/types.js';
import { capitalUsage, evaluateOrderCapital, planReplaceRaceDefer } from '../src/risk/capital-risk.js';

const market: Market = {
  venue: 'predict',
  tokenId: 'token-1',
  question: 'Will this test pass?',
  volume24hUsd: 10000,
  liquidityUsd: 10000,
  acceptingOrders: true,
  negRisk: false,
  feeRateBps: 0,
  tickSize: 0.01,
  rewards: { enabled: true }
};

function config(overrides: Record<string, unknown> = {}) {
  return appConfigSchema.parse({
    liveEnabled: true,
    risk: {
      orderSizeUsd: 8,
      maxSingleOrderUsd: 8,
      maxPositionUsd: 20,
      maxOpenOrderReserveDriftUsd: 2,
      maxOpenOrderReserveDriftPct: 25
    },
    strategy: { balanceReserveUsd: 1 },
    ...overrides
  });
}

function intent(side: 'BUY' | 'SELL', size = 16): OrderIntent {
  return {
    venue: 'predict',
    market,
    tokenId: market.tokenId,
    side,
    price: 0.5,
    size,
    notionalUsd: 8,
    postOnly: true,
    reason: 'test',
    clientOrderId: `test-${side}`
  };
}

describe('capital risk', () => {
  it('subtracts estimated open-order reservation before allowing a BUY', () => {
    const openOrders: OpenOrder[] = [{
      venue: 'predict',
      externalId: 'existing',
      tokenId: 'other-token',
      side: 'BUY',
      price: 0.5,
      size: 20,
      status: 'OPEN'
    }];

    const usage = capitalUsage(config(), [{ asset: 'USDT', available: 19, total: 19 }], openOrders);
    const decision = evaluateOrderCapital(config(), intent('BUY'), [{ asset: 'USDT', available: 19, total: 19 }], openOrders, []);

    expect(usage).toMatchObject({
      availableUsd: 19,
      reserveUsd: 1,
      reservedOpenOrdersUsd: 10,
      spendableUsd: 8,
      driftOk: true
    });
    expect(decision.ok).toBe(true);
  });

  it('does not count existing SELL orders as stablecoin reservation', () => {
    const openOrders: OpenOrder[] = [{
      venue: 'predict',
      externalId: 'existing-sell',
      tokenId: market.tokenId,
      side: 'SELL',
      price: 0.5,
      size: 20,
      status: 'OPEN'
    }];

    const usage = capitalUsage(config(), [{ asset: 'USDT', available: 19, total: 19 }], openOrders);

    expect(usage.reservedOpenOrdersUsd).toBe(0);
    expect(usage.spendableUsd).toBe(18);
  });

  it('blocks BUY when no stable balance is available', () => {
    const decision = evaluateOrderCapital(config(), intent('BUY'), [{ asset: 'POINT', available: 100, total: 100 }], [], []);

    expect(decision).toMatchObject({
      ok: false,
      reason: 'balance-unavailable'
    });
  });

  it('blocks BUY when platform frozen balance drifts too far from estimated open-order reservation', () => {
    const openOrders: OpenOrder[] = [{
      venue: 'predict',
      externalId: 'existing',
      tokenId: 'other-token',
      side: 'BUY',
      price: 0.5,
      size: 10,
      status: 'OPEN'
    }];
    const decision = evaluateOrderCapital(
      config(),
      intent('BUY'),
      [{ asset: 'USDT', available: 19, total: 40 }],
      openOrders,
      []
    );

    expect(decision.ok).toBe(false);
    expect(decision.reason).toBe('reserve-drift');
    expect(decision.usage).toMatchObject({
      actualFrozenUsd: 21,
      reservedOpenOrdersUsd: 5,
      driftOk: false
    });
  });

  it('does not reject Predict cash maker BUY only because visible balance is below the order notional', () => {
    const decision = evaluateOrderCapital(
      config({
        risk: {
          orderSizeUsd: 8,
          maxSingleOrderUsd: 8,
          maxPositionUsd: 20,
          maxMarkets: 10,
          maxOpenOrderReserveDriftUsd: 100,
          maxOpenOrderReserveDriftPct: 100
        },
        strategy: { entryMode: 'cash', quoteSide: 'buy', balanceReserveUsd: 1 }
      }),
      intent('BUY'),
      [{ asset: 'USDT', available: 1, total: 1 }],
      [],
      [],
      1
    );

    expect(decision.ok).toBe(true);
    expect(decision.message).toContain('非冻结挂单');
  });

  it('accepts BUY when estimated open-order reservation matches platform frozen balance', () => {
    const openOrders: OpenOrder[] = [{
      venue: 'polymarket',
      externalId: 'existing',
      tokenId: 'other-token',
      side: 'BUY',
      price: 0.5,
      size: 42,
      status: 'OPEN'
    }];
    const decision = evaluateOrderCapital(
      config(),
      { ...intent('BUY'), venue: 'polymarket' },
      [{ asset: 'USDC', available: 19, total: 40 }],
      openOrders,
      []
    );

    expect(decision.ok).toBe(true);
    expect(decision.usage).toMatchObject({
      actualFrozenUsd: 21,
      reservedOpenOrdersUsd: 21,
      spendableUsd: 18,
      driftOk: true
    });
  });

  it('blocks SELL when synchronized inventory cannot cover the order size', () => {
    const positions: Position[] = [{
      venue: 'predict',
      tokenId: market.tokenId,
      size: 4,
      notionalUsd: 2
    }];

    const decision = evaluateOrderCapital(
      config(),
      intent('SELL', 16),
      [{ asset: 'USDT', available: 19, total: 19 }],
      [],
      positions
    );

    expect(decision).toMatchObject({
      ok: false,
      reason: 'inventory-insufficient'
    });
  });
});

describe('planReplaceRaceDefer (small-wallet replace-race guard)', () => {
  it('defers re-placing a just-cancelled BUY when the wallet cannot hold old+new at once', () => {
    // notionalUsd 8 -> needs >= 16 to hold the old (being cancelled) and the new together; 10 cannot.
    const result = planReplaceRaceDefer([intent('BUY')], ['token-1'], 10);
    expect(result.placeable).toHaveLength(0);
    expect(result.deferredTokenIds).toEqual(['token-1']);
  });

  it('re-places a just-cancelled BUY immediately when the wallet can hold old+new (>= 2x notional)', () => {
    const i = intent('BUY');
    const result = planReplaceRaceDefer([i], ['token-1'], 20);
    expect(result.placeable).toEqual([i]);
    expect(result.deferredTokenIds).toEqual([]);
  });

  it('does not touch intents whose token was not cancelled this cycle (even on a tiny wallet)', () => {
    const i = intent('BUY');
    const result = planReplaceRaceDefer([i], ['some-other-token'], 1);
    expect(result.placeable).toEqual([i]);
    expect(result.deferredTokenIds).toEqual([]);
  });

  it('never defers a SELL exit, regardless of balance', () => {
    const i = intent('SELL', 16);
    const result = planReplaceRaceDefer([i], ['token-1'], 1);
    expect(result.placeable).toEqual([i]);
    expect(result.deferredTokenIds).toEqual([]);
  });

  it('is a no-op when nothing was cancelled this cycle', () => {
    const i = intent('BUY');
    expect(planReplaceRaceDefer([i], [], 1).placeable).toEqual([i]);
  });
});
