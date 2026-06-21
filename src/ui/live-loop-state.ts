import type { VenueName } from '../domain/types.js';
import type { AppConfig } from '../config/schema.js';
import { publicErrorMessage } from '../observability/error-message.js';

export type LiveLoopStatus = 'idle' | 'running' | 'stopping' | 'error';

export interface LiveLoopState {
  venue: VenueName;
  status: LiveLoopStatus;
  startedAt?: string;
  stoppedAt?: string;
  lastCycleAt?: string;
  lastError?: string;
  restored?: boolean;
  retryCount?: number;
  retryAt?: string;
  cycles: number;
  /** Epoch ms of the last FULL discovery cycle (fast quote-refresh runs lighter ticks in between). */
  lastFullCycleAt?: number;
  stopRequested: boolean;
  timer?: NodeJS.Timeout;
  wake?: () => void;
  running?: Promise<void>;
}

export type LiveLoops = Map<VenueName, LiveLoopState>;

export type PublicLiveLoopState = Omit<LiveLoopState, 'timer' | 'running' | 'stopRequested' | 'wake'>;

const PREDICT_DEFAULT_API_RATE_LIMIT_PER_MINUTE = 240;
const LIVE_LOOP_RATE_LIMIT_RESERVE_PER_MINUTE = 20;
const LIVE_LOOP_BASE_REQUESTS_PER_CYCLE = 6;

export function createLiveLoopState(
  venue: VenueName,
  now: Date = new Date(),
  options: { restored?: boolean; restartCount?: number } = {}
): LiveLoopState {
  return {
    venue,
    status: 'running',
    startedAt: now.toISOString(),
    ...(options.restored ? { restored: true } : {}),
    cycles: 0,
    stopRequested: false
  };
}

export function liveStatus(liveLoops: LiveLoops): { ok: true; live: Record<VenueName, PublicLiveLoopState> } {
  return {
    ok: true,
    live: {
      predict: publicLoopState(liveLoops.get('predict'), 'predict'),
      polymarket: publicLoopState(liveLoops.get('polymarket'), 'polymarket')
    }
  };
}

export function publicLoopState(loop: LiveLoopState | undefined, venue: VenueName): PublicLiveLoopState {
  return {
    venue,
    status: loop?.status ?? 'idle',
    cycles: loop?.cycles ?? 0,
    ...(loop?.startedAt ? { startedAt: loop.startedAt } : {}),
    ...(loop?.stoppedAt ? { stoppedAt: loop.stoppedAt } : {}),
    ...(loop?.lastCycleAt ? { lastCycleAt: loop.lastCycleAt } : {}),
    ...(loop?.lastError ? { lastError: loop.lastError } : {}),
    ...(loop?.restored ? { restored: true } : {}),
    ...(loop?.retryCount ? { retryCount: loop.retryCount } : {}),
    ...(loop?.retryAt ? { retryAt: loop.retryAt } : {})
  };
}

export function requestLoopStop(loop: LiveLoopState | undefined): void {
  if (!loop) return;
  if (loop.status === 'running') loop.status = 'stopping';
  loop.stopRequested = true;
  if (loop.timer) {
    clearTimeout(loop.timer);
    loop.timer = undefined;
  }
  loop.wake?.();
}

export function completeLoopStop(loop: LiveLoopState, now: Date = new Date()): void {
  loop.status = 'idle';
  loop.stoppedAt = now.toISOString();
}

export function markLoopCycleCompleted(loop: LiveLoopState, now: Date = new Date()): void {
  loop.cycles += 1;
  loop.lastCycleAt = now.toISOString();
  delete loop.lastError;
  delete loop.retryCount;
  delete loop.retryAt;
}

export function markLoopError(loop: LiveLoopState, error: unknown): string {
  const message = publicErrorMessage(error);
  loop.status = 'error';
  loop.lastError = message;
  return message;
}

export function resetLoopRuntimeHandles(loop: LiveLoopState): void {
  loop.stopRequested = false;
  loop.timer = undefined;
  loop.wake = undefined;
  loop.running = undefined;
}

export async function waitForNextCycle(loop: LiveLoopState, ms: number): Promise<void> {
  if (loop.stopRequested) return;
  await new Promise<void>((resolve) => {
    loop.wake = resolve;
    loop.timer = setTimeout(() => {
      loop.timer = undefined;
      loop.wake = undefined;
      resolve();
    }, ms);
  });
}

export function rateLimitedCycleDelayMs(
  config: AppConfig,
  venue: VenueName,
  scanCheckpoint: unknown
): number {
  const configuredMs = Math.max(1000, Math.trunc(config.strategy.quoteRefreshMs ?? 2000));
  if (venue !== 'predict') return configuredMs;
  // Under WS orderbook fetch most reads come from the push cache (no REST), so the per-cycle REST count is far
  // below the planned market count; the 120ms per-origin throttle already self-paces the few REST misses, so we
  // keep the cycle at the configured cadence instead of inflating it by the (mostly WS-served) book count.
  if (config.strategy.wsWatchAll !== false) return configuredMs;
  const scannedOrderbooks = scanCheckpoint && typeof scanCheckpoint === 'object'
    ? Number((scanCheckpoint as { scannedOrderbooks?: unknown }).scannedOrderbooks)
    : Number.NaN;
  if (!Number.isFinite(scannedOrderbooks) || scannedOrderbooks <= 0) return configuredMs;
  const budgetPerMinute = Math.max(1, PREDICT_DEFAULT_API_RATE_LIMIT_PER_MINUTE - LIVE_LOOP_RATE_LIMIT_RESERVE_PER_MINUTE);
  const estimatedRequests = Math.ceil(scannedOrderbooks + LIVE_LOOP_BASE_REQUESTS_PER_CYCLE);
  const rateLimitedMs = Math.ceil((estimatedRequests * 60_000) / budgetPerMinute);
  return Math.max(configuredMs, Math.min(600_000, rateLimitedMs));
}
