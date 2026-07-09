import type { VenueName } from '../domain/types.js';
import type { StateStore } from '../store/sqlite.js';
import { dayStartTs } from './account-risk.js';

export function accountRiskWindowStart(
  venue: VenueName,
  store: Pick<StateStore, 'getCheckpoint'>,
  fallback = dayStartTs()
): number {
  const checkpoint = store.getCheckpoint(`live-session.${venue}`)?.value;
  if (!checkpoint || typeof checkpoint !== 'object') return fallback;
  const startedAt = (checkpoint as { startedAt?: unknown }).startedAt;
  if (typeof startedAt !== 'string') return fallback;
  const ts = Date.parse(startedAt);
  // Clamp to at least today's midnight: a session that started before midnight must not extend the
  // daily-loss window into the previous day (would under-count today's realized loss). Math.max keeps the
  // later of (session start, today 00:00) as the window boundary.
  return Number.isFinite(ts) ? Math.max(ts, fallback) : fallback;
}
