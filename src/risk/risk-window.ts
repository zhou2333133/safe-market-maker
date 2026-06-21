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
  return Number.isFinite(ts) ? ts : fallback;
}
