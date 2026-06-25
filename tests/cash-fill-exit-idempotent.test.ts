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

  it('CONCURRENT cycles: cache mark precedes the submit await so a second call cannot duplicate (production race fix)', async () => {
    // Production race observed 2026-06-25 12:43:25 → 12:43:33: two SELL submits 8s apart, second failed with
    // "balance: 0" because the first had already cleared the venue position. Root cause: markExitSubmitted ran
    // AFTER the await, so a parallel cycle entering process() during the in-flight submit found cache=unmarked
    // and issued a duplicate. Fix: mark BEFORE the await. This test holds the first submit pending while a
    // second process() runs and asserts only ONE createMarketableOrder call happens.
    const store = makeStore();
    let resolveFirstSubmit: ((value: OrderResult) => void) | undefined;
    const adapter = {
      createMarketableOrder: vi.fn(() => new Promise<OrderResult>((resolve) => {
        resolveFirstSubmit = resolve;
      })),
      getOrderbook: vi.fn(async () => ({
        venue: 'polymarket' as const,
        tokenId: 'tokA',
        bids: [{ price: 0.6, size: 500 }, { price: 0.59, size: 300 }],
        asks: [{ price: 0.61, size: 200 }],
        receivedAt: Date.now()
      } satisfies Orderbook))
    } as any;
    const svc = new CashFillExitService(config, adapter, store);
    const args = {
      venue: 'polymarket' as const,
      signer: { address: '0x1' } as any,
      positions: [makePosition()],
      openOrders: [],
      markets: [makeMarket()],
      force: true as const
    };

    // Start the first process() — it hits the cache mark synchronously and then awaits createMarketableOrder.
    const firstCall = svc.process(args);
    // Drain the microtask queue so the first call has progressed to the await before we start the second.
    await new Promise((r) => setImmediate(r));
    // Start the second process() while the first await is still pending.
    const secondCall = svc.process(args);
    // Now let the first submit resolve.
    resolveFirstSubmit!({
      venue: 'polymarket', clientOrderId: 'cid1', externalId: '0xfill1', status: 'FILLED', raw: {}
    } satisfies OrderResult);

    const [r1, r2] = await Promise.all([firstCall, secondCall]);

    // The invariant: only ONE submit, no matter how concurrent the cycles are.
    expect(adapter.createMarketableOrder).toHaveBeenCalledTimes(1);
    expect(r1.submitted).toBe(1);
    expect(r2.submitted).toBe(0);
    expect(r2.blocked).toBe(1);
    const skipEvt = store.recordEvent.mock.calls.find((c: any) => c[0].type === 'cash-fill.exit-skipped-duplicate');
    expect(skipEvt).toBeDefined();
  });

  it('FAILED first submit also marks the cache so a second call within 30s does not hammer the venue', async () => {
    // Without this property, a failing submit (e.g. venue 5xx, insufficient balance) would invite a tight retry
    // loop on every subsequent cycle until the position changed. The 30s back-off lets the venue settle and
    // surfaces the underlying problem to the operator instead of burying it in retry noise.
    const store = makeStore();
    const adapter = {
      createMarketableOrder: vi.fn(async () => { throw new Error('venue: 503 service unavailable'); }),
      getOrderbook: vi.fn(async () => ({
        venue: 'polymarket' as const,
        tokenId: 'tokA',
        bids: [{ price: 0.6, size: 500 }],
        asks: [{ price: 0.61, size: 200 }],
        receivedAt: Date.now()
      } satisfies Orderbook))
    } as any;
    const svc = new CashFillExitService(config, adapter, store);
    const args = {
      venue: 'polymarket' as const,
      signer: { address: '0x1' } as any,
      positions: [makePosition()],
      openOrders: [],
      markets: [makeMarket()],
      force: true as const
    };

    const r1 = await svc.process(args);
    expect(r1.failed).toBe(1);
    expect(adapter.createMarketableOrder).toHaveBeenCalledTimes(1);

    // Second call within 30s — must NOT retry; cache mark survives the failure.
    const r2 = await svc.process(args);
    expect(adapter.createMarketableOrder).toHaveBeenCalledTimes(1); // still 1
    expect(r2.blocked).toBe(1);
    expect(r2.failed).toBe(0);
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
