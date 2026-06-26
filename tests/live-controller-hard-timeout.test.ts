import { describe, expect, it, vi } from 'vitest';
import { withLiveCycleTimeout } from '../src/ui/live-controller.js';

// Production 2026-06-26 incident: Predict cycle 572 hung 2h+ awaiting a network call that never resolved.
// The watchdog at server.ts only emitted a stale-detected event; nothing actually aborted the await. This patch
// adds an optional hardTimeoutMs that races the cycle promise so a stuck cycle gets abandoned within 5 min and
// the loop's existing retryable-error handler schedules the next cycle. These tests cover the 3 branches.

describe('withLiveCycleTimeout (supervisor hard-timeout self-heal)', () => {
  it('resolves normally when the cycle finishes BEFORE the soft timeout — no callback, no rejection', async () => {
    const onSoft = vi.fn();
    const onHard = vi.fn();
    const result = await withLiveCycleTimeout(
      Promise.resolve('done'),
      1000,
      'polymarket',
      1,
      onSoft,
      { hardTimeoutMs: 5000, onHardTimeout: onHard }
    );
    expect(result).toBe('done');
    expect(onSoft).not.toHaveBeenCalled();
    expect(onHard).not.toHaveBeenCalled();
  });

  it('fires onTimeout (soft) when cycle exceeds soft timeout but still resolves before hard — old behaviour preserved', async () => {
    const onSoft = vi.fn();
    const onHard = vi.fn();
    const slowPromise = new Promise<string>((resolve) => setTimeout(() => resolve('eventually-done'), 80));
    const result = await withLiveCycleTimeout(
      slowPromise,
      20,                      // 20ms soft → fires
      'polymarket',
      42,
      onSoft,
      { hardTimeoutMs: 500, onHardTimeout: onHard } // 500ms hard → won't fire
    );
    expect(result).toBe('eventually-done');
    expect(onSoft).toHaveBeenCalledTimes(1);
    expect(onHard).not.toHaveBeenCalled();
  });

  it('REJECTS with hard-timeout error when promise never resolves — fires onHardTimeout, abandons orphan', async () => {
    const onSoft = vi.fn();
    const onHard = vi.fn();
    // Promise that NEVER resolves — simulates the production stuck cycle.
    const hungPromise = new Promise<string>(() => { /* never settles */ });
    await expect(
      withLiveCycleTimeout(
        hungPromise,
        20,
        'predict',
        572,
        onSoft,
        { hardTimeoutMs: 100, onHardTimeout: onHard }
      )
    ).rejects.toThrow(/hard-timeout after 100ms/);
    expect(onSoft).toHaveBeenCalledTimes(1);
    expect(onHard).toHaveBeenCalledTimes(1);
  });

  it('without hardTimeoutMs option → preserves original behaviour (await indefinitely until promise settles)', async () => {
    // Original API: just (promise, ms, venue, cycle, onTimeout). No hard ceiling, original soft serialization
    // semantics. Verify the function still works without options.
    const onSoft = vi.fn();
    const lateResolver = new Promise<string>((resolve) => setTimeout(() => resolve('late'), 40));
    const result = await withLiveCycleTimeout(lateResolver, 10, 'polymarket', 7, onSoft);
    expect(result).toBe('late');
    expect(onSoft).toHaveBeenCalledTimes(1);
  });

  it('hardTimeoutMs <= ms is treated as no hard timeout (defensive — caller misconfigured)', async () => {
    const onSoft = vi.fn();
    const onHard = vi.fn();
    // hardTimeoutMs (50) < ms (100). Spec: ignore the hard option entirely; rely on soft path.
    const slowResolve = new Promise<string>((resolve) => setTimeout(() => resolve('finally'), 200));
    const result = await withLiveCycleTimeout(
      slowResolve,
      100,
      'polymarket',
      1,
      onSoft,
      { hardTimeoutMs: 50, onHardTimeout: onHard }
    );
    expect(result).toBe('finally');
    expect(onSoft).toHaveBeenCalledTimes(1);
    expect(onHard).not.toHaveBeenCalled(); // hard option ignored — config error tolerated, not weaponised
  });
});
