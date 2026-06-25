import { describe, expect, it, vi } from 'vitest';
import { CashFillExitService } from '../src/execution/cash-fill-exit-service.js';
import { appConfigSchema } from '../src/config/schema.js';
import type { Market, Orderbook, Position, OrderResult } from '../src/domain/types.js';

function makeStore() {
  return {
    recordEvent: vi.fn(),
    recordOrderResult: vi.fn(),
    checkpoint: vi.fn(),
    getCheckpoint: vi.fn(() => undefined),
    localCashExitLossSince: () => ({ count: 0, estimatedLossUsd: 0, estimatedRealizedPnlUsd: 0 }),
    cashFillCooldownEntries: () => []
  } as any;
}

function makeAdapter() {
  return {
    createMarketableOrder: vi.fn(async (intent: any) => ({
      venue: 'polymarket',
      clientOrderId: intent.clientOrderId ?? 'cid1',
      externalId: '0xfill1',
      status: 'OPEN' as const,
      raw: {}
    } satisfies OrderResult)),
    getOrderbook: vi.fn(async () => ({
      venue: 'polymarket',
      tokenId: 'tokA',
      bids: [{ price: 0.6, size: 500 }, { price: 0.59, size: 300 }],
      asks: [{ price: 0.61, size: 200 }],
      receivedAt: Date.now()
    } satisfies Orderbook))
  } as any;
}

function makePosition(tokenId = 'tokA'): Position {
  return {
    venue: 'polymarket',
    tokenId,
    conditionId: 'c1',
    marketId: 'mkt',
    outcome: 'No',
    size: 100,
    averagePrice: 0.65,
    notionalUsd: 65
  } as any;
}

function makeMarket(): Market {
  return {
    venue: 'polymarket',
    tokenId: 'tokA',
    marketId: 'mkt',
    conditionId: 'c1',
    question: 'Q',
    outcome: 'No',
    outcomeIndex: 1,
    outcomeCount: 2,
    volume24hUsd: 1000,
    liquidityUsd: 1000,
    acceptingOrders: true,
    negRisk: false,
    feeRateBps: 0,
    tickSize: 0.01,
    rewards: { enabled: true }
  } as any;
}

const config = appConfigSchema.parse({
  strategy: { entryMode: 'cash', cashOnFillAction: 'sellWithinLossCap', cashMaxExitLossPct: 30 }
});

describe('CashFillExitService — idempotent exits (Bug C fix)', () => {
  it('on first call: submits the exit and records cash-fill.exit-submitted', async () => {
    const store = makeStore();
    const adapter = makeAdapter();
    const svc = new CashFillExitService(config, adapter, store);

    const result = await svc.process({
      venue: 'polymarket',
      signer: { address: '0x1', signMessage: async () => '', signTypedData: async () => '' } as any,
      positions: [makePosition()],
      openOrders: [],
      markets: [makeMarket()],
      force: true
    });
    expect(result.submitted).toBe(1);
    expect(adapter.createMarketableOrder).toHaveBeenCalledTimes(1);
    const submittedEvt = store.recordEvent.mock.calls.find((c: any) => c[0].type === 'cash-fill.exit-submitted');
    expect(submittedEvt).toBeDefined();
  });

  it('on second call within 30s: skips submit, records cash-fill.exit-skipped-duplicate (no balance:0 noise)', async () => {
    const store = makeStore();
    const adapter = makeAdapter();
    const svc = new CashFillExitService(config, adapter, store);
    const args = {
      venue: 'polymarket' as const,
      signer: { address: '0x1', signMessage: async () => '', signTypedData: async () => '' } as any,
      positions: [makePosition()],
      openOrders: [],
      markets: [makeMarket()],
      force: true as const
    };
    await svc.process(args);
    expect(adapter.createMarketableOrder).toHaveBeenCalledTimes(1);

    // Cycle 2 immediately after: data-api lag still reports the same position
    const result2 = await svc.process(args);
    expect(adapter.createMarketableOrder).toHaveBeenCalledTimes(1); // not called again
    expect(result2.submitted).toBe(0);
    expect(result2.blocked).toBe(1);
    const skipEvt = store.recordEvent.mock.calls.find((c: any) => c[0].type === 'cash-fill.exit-skipped-duplicate');
    expect(skipEvt).toBeDefined();
  });

  it('DIFFERENT tokenId in the same window is not suppressed (per-token idempotency)', async () => {
    const store = makeStore();
    const adapter = makeAdapter();
    const svc = new CashFillExitService(config, adapter, store);
    await svc.process({
      venue: 'polymarket', signer: { address: '0x1' } as any,
      positions: [makePosition('tokA')], openOrders: [], markets: [makeMarket()], force: true
    });
    expect(adapter.createMarketableOrder).toHaveBeenCalledTimes(1);

    // Second position on a DIFFERENT token - should still submit
    const result = await svc.process({
      venue: 'polymarket', signer: { address: '0x1' } as any,
      positions: [makePosition('tokB')], openOrders: [],
      markets: [{ ...makeMarket(), tokenId: 'tokB' } as any], force: true
    });
    expect(adapter.createMarketableOrder).toHaveBeenCalledTimes(2);
    expect(result.submitted).toBe(1);
  });
});

describe('isRetryableLiveLoopError — "service not ready" is now retryable (Bug D fix)', () => {
  it('classifies "service not ready" as retryable so POLY loop survives an SDK state hiccup', async () => {
    const { isRetryableLiveLoopError } = await import('../src/ui/live-controller.js');
    expect(isRetryableLiveLoopError(new Error('service not ready'))).toBe(true);
    expect(isRetryableLiveLoopError(new Error('Polymarket SDK: service not ready'))).toBe(true);
  });

  it('still classifies private-key errors as non-retryable (would be a real config / signer problem)', async () => {
    const { isRetryableLiveLoopError } = await import('../src/ui/live-controller.js');
    expect(isRetryableLiveLoopError(new Error('jwt is required'))).toBe(false);
    expect(isRetryableLiveLoopError(new Error('invalid private_key'))).toBe(false);
  });
});
