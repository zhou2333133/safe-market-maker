import { describe, expect, it } from 'vitest';
import {
  completeLoopStop,
  createLiveLoopState,
  liveStatus,
  markLoopCycleCompleted,
  markLoopError,
  publicLoopState,
  rateLimitedCycleDelayMs,
  requestLoopStop,
  resetLoopRuntimeHandles
} from '../src/ui/live-loop-state.js';
import { appConfigSchema } from '../src/config/schema.js';

describe('UI live loop state', () => {
  it('serializes idle and running venue state without runtime handles', () => {
    const loop = createLiveLoopState('predict', new Date('2026-05-20T08:00:00.000Z'), { restored: true });
    loop.running = Promise.resolve();
    loop.wake = () => undefined;
    loop.retryCount = 2;
    loop.retryAt = '2026-05-20T08:00:05.000Z';

    expect(publicLoopState(loop, 'predict')).toEqual({
      venue: 'predict',
      status: 'running',
      cycles: 0,
      startedAt: '2026-05-20T08:00:00.000Z',
      restored: true,
      retryCount: 2,
      retryAt: '2026-05-20T08:00:05.000Z'
    });
    expect(liveStatus(new Map([['predict', loop]]))).toMatchObject({
      ok: true,
      live: {
        predict: { status: 'running', cycles: 0 },
        polymarket: { status: 'idle', cycles: 0 }
      }
    });
  });

  it('marks stop requests and clears pending timers', () => {
    const loop = createLiveLoopState('predict');
    let woke = false;
    loop.timer = setTimeout(() => undefined, 1000);
    loop.wake = () => {
      woke = true;
    };

    requestLoopStop(loop);

    expect(loop.status).toBe('stopping');
    expect(loop.stopRequested).toBe(true);
    expect(loop.timer).toBeUndefined();
    expect(woke).toBe(true);
  });

  it('tracks cycle completion, stop completion, and error state', () => {
    const loop = createLiveLoopState('polymarket', new Date('2026-05-20T08:00:00.000Z'));
    loop.retryCount = 1;
    loop.retryAt = '2026-05-20T08:00:05.000Z';
    markLoopCycleCompleted(loop, new Date('2026-05-20T08:00:10.000Z'));
    expect(loop.cycles).toBe(1);
    expect(loop.lastCycleAt).toBe('2026-05-20T08:00:10.000Z');
    expect(loop.retryCount).toBeUndefined();
    expect(loop.retryAt).toBeUndefined();

    const message = markLoopError(loop, new Error('boom'));
    expect(message).toBe('boom');
    expect(loop.status).toBe('error');
    expect(loop.lastError).toBe('boom');

    completeLoopStop(loop, new Date('2026-05-20T08:00:20.000Z'));
    expect(loop.status).toBe('idle');
    expect(loop.stoppedAt).toBe('2026-05-20T08:00:20.000Z');

    loop.stopRequested = true;
    loop.wake = () => undefined;
    loop.running = Promise.resolve();
    resetLoopRuntimeHandles(loop);
    expect(loop.stopRequested).toBe(false);
    expect(loop.wake).toBeUndefined();
    expect(loop.running).toBeUndefined();
  });

  it('stretches Predict live cycles when the REST-budget scan path is active (watch-all off)', () => {
    const config = appConfigSchema.parse({
      strategy: { quoteRefreshMs: 2000, wsWatchAll: false }
    });

    expect(rateLimitedCycleDelayMs(config, 'predict', { scannedOrderbooks: 30 })).toBeGreaterThan(9000);
    expect(rateLimitedCycleDelayMs(config, 'predict', { scannedOrderbooks: 4 })).toBe(2728);
    expect(rateLimitedCycleDelayMs(config, 'polymarket', { scannedOrderbooks: 30 })).toBe(2000);
  });

  it('keeps Predict cycles at the configured cadence under WS orderbook fetch (default)', () => {
    const config = appConfigSchema.parse({ strategy: { quoteRefreshMs: 2000 } });
    // WS serves most reads, so the cycle is not inflated by the (mostly cache-served) book count.
    expect(rateLimitedCycleDelayMs(config, 'predict', { scannedOrderbooks: 30 })).toBe(2000);
  });
});
