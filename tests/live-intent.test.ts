import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearLiveStopIntent,
  clearLiveRunIntent,
  publicLiveRunIntents,
  readLiveRunIntent,
  readLiveStopIntent,
  saveLiveRunIntent,
  saveLiveStopIntent
} from '../src/ui/live-intent.js';
import { appConfigSchema } from '../src/config/schema.js';
import { saveConfig } from '../src/config/load.js';
import { isRetryableLiveLoopError, restoreLiveLoops, withLiveCycleTimeout } from '../src/ui/live-controller.js';
import type { LiveLoops } from '../src/ui/live-loop-state.js';
import { usingStore } from '../src/store/ui-store.js';
import { HttpError } from '../src/venues/http.js';

describe('UI live run intent', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('persists and clears venue-specific auto-resume intent', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-intent-'));
    try {
      const intent = saveLiveRunIntent(dir, 'predict', 'user-start', 'start clicked');

      expect(intent).toMatchObject({
        kind: 'live-run-intent',
        venue: 'predict',
        enabled: true,
        source: 'user-start',
        sessionStartedAt: intent.createdAt,
        reason: 'start clicked'
      });
      expect(readLiveRunIntent(dir, 'predict')).toMatchObject({
        venue: 'predict',
        source: 'user-start'
      });
      expect(publicLiveRunIntents(dir).predict).toMatchObject({
        venue: 'predict',
        source: 'user-start',
        sessionStartedAt: intent.createdAt
      });
      expect(publicLiveRunIntents(dir).polymarket).toBeNull();

      clearLiveRunIntent(dir, 'predict');
      expect(readLiveRunIntent(dir, 'predict')).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resets the live risk session only on explicit user start', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-29T01:00:00.000Z'));
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-intent-'));
    try {
      const first = saveLiveRunIntent(dir, 'predict', 'user-start', 'start clicked');
      vi.setSystemTime(new Date('2026-05-29T02:00:00.000Z'));
      const resumed = saveLiveRunIntent(dir, 'predict', 'auto-resume', 'resume');
      expect(resumed.sessionStartedAt).toBe(first.sessionStartedAt);

      vi.setSystemTime(new Date('2026-05-29T03:00:00.000Z'));
      const restarted = saveLiveRunIntent(dir, 'predict', 'user-start', 'start clicked again');
      expect(restarted.sessionStartedAt).toBe('2026-05-29T03:00:00.000Z');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('persists explicit stop intent separately from run intent', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-intent-'));
    try {
      saveLiveRunIntent(dir, 'predict', 'user-start', 'start clicked');
      const stop = saveLiveStopIntent(dir, 'predict', 'user-stop', 'stop clicked');

      expect(stop).toMatchObject({
        kind: 'live-stop-intent',
        venue: 'predict',
        source: 'user-stop',
        reason: 'stop clicked'
      });
      expect(readLiveRunIntent(dir, 'predict')).toBeDefined();
      expect(readLiveStopIntent(dir, 'predict')).toMatchObject({ source: 'user-stop' });

      clearLiveStopIntent(dir, 'predict');
      expect(readLiveStopIntent(dir, 'predict')).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('records an idle stage when a stopped venue is restored after server restart', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-intent-'));
    const configPath = path.join(dir, 'config.yaml');
    try {
      saveConfig(configPath, appConfigSchema.parse({ dataDir: '.safe-mm' }));
      const dataDir = path.join(dir, '.safe-mm');
      saveLiveStopIntent(dataDir, 'predict', 'user-stop', 'stop clicked');

      restoreLiveLoops(configPath, new Map() as LiveLoops);

      const store = usingStore(dataDir);
      try {
        expect(store.getCheckpoint('stage.predict')?.value).toMatchObject({
          stage: 'idle',
          message: '实盘循环已停止，不会自动恢复',
          source: 'user-stop'
        });
      } finally {
        store.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('warns on a slow live cycle but waits for it instead of starting an overlapping retry', async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    let resolveSlowCycle!: (value: string) => void;
    const slowCycle = new Promise<string>((resolve) => {
      resolveSlowCycle = resolve;
    });

    const result = withLiveCycleTimeout(slowCycle, 1000, 'predict', 7, onTimeout);
    await vi.advanceTimersByTimeAsync(1000);

    expect(onTimeout).toHaveBeenCalledTimes(1);
    let settled = false;
    result.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    resolveSlowCycle('finished');

    await expect(result).resolves.toBe('finished');
    expect(settled).toBe(true);
  });

  it('keeps live auto-resume retrying on platform auth HTTP errors so managed orders are not orphaned', () => {
    expect(isRetryableLiveLoopError(new HttpError('HTTP 401 for https://api.predict.fun/v1/orders', 401, {}))).toBe(true);
    expect(isRetryableLiveLoopError(new HttpError('HTTP 403 for https://api.predict.fun/v1/orders', 403, {}))).toBe(true);
    expect(isRetryableLiveLoopError(new Error('Predict JWT is required for this endpoint. Run mm auth predict first.'))).toBe(false);
    expect(isRetryableLiveLoopError(new Error('SAFE_MM_PREDICT_PRIVATE_KEY missing'))).toBe(false);
  });
});
