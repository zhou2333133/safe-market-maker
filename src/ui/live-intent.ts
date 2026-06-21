import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { VenueName } from '../domain/types.js';

export interface LiveRunIntent {
  kind: 'live-run-intent';
  venue: VenueName;
  enabled: true;
  source: 'user-start' | 'auto-resume' | 'open-order-adoption';
  createdAt: string;
  updatedAt: string;
  sessionStartedAt: string;
  reason: string;
}

export type PublicLiveRunIntent = Omit<LiveRunIntent, 'kind'>;

export interface LiveStopIntent {
  kind: 'live-stop-intent';
  venue: VenueName;
  source: 'user-stop' | 'user-stop-and-cancel' | 'risk-stop';
  createdAt: string;
  updatedAt: string;
  reason: string;
}

export function saveLiveRunIntent(dataDir: string, venue: VenueName, source: LiveRunIntent['source'], reason: string): LiveRunIntent {
  const existing = readLiveRunIntent(dataDir, venue);
  const now = new Date().toISOString();
  const intent: LiveRunIntent = {
    kind: 'live-run-intent',
    venue,
    enabled: true,
    source,
    reason,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    sessionStartedAt: source === 'user-start' ? now : existing?.sessionStartedAt ?? existing?.createdAt ?? now
  };
  mkdirSync(path.dirname(liveIntentPath(dataDir, venue)), { recursive: true });
  writeFileSync(liveIntentPath(dataDir, venue), JSON.stringify(intent, null, 2), { encoding: 'utf8', flag: 'w' });
  return intent;
}

export function saveLiveStopIntent(dataDir: string, venue: VenueName, source: LiveStopIntent['source'], reason: string): LiveStopIntent {
  const existing = readLiveStopIntent(dataDir, venue);
  const now = new Date().toISOString();
  const intent: LiveStopIntent = {
    kind: 'live-stop-intent',
    venue,
    source,
    reason,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  };
  mkdirSync(path.dirname(liveStopIntentPath(dataDir, venue)), { recursive: true });
  writeFileSync(liveStopIntentPath(dataDir, venue), JSON.stringify(intent, null, 2), { encoding: 'utf8', flag: 'w' });
  return intent;
}

export function readLiveRunIntent(dataDir: string, venue: VenueName): LiveRunIntent | undefined {
  const target = liveIntentPath(dataDir, venue);
  if (!existsSync(target)) return undefined;
  const payload = JSON.parse(readFileSync(target, 'utf8')) as Partial<LiveRunIntent>;
  if (payload.kind !== 'live-run-intent' || payload.venue !== venue || payload.enabled !== true) return undefined;
  if (!payload.createdAt || !payload.updatedAt || !payload.reason || !payload.source) return undefined;
  return {
    ...payload,
    sessionStartedAt: payload.sessionStartedAt ?? payload.createdAt
  } as LiveRunIntent;
}

export function readLiveStopIntent(dataDir: string, venue: VenueName): LiveStopIntent | undefined {
  const target = liveStopIntentPath(dataDir, venue);
  if (!existsSync(target)) return undefined;
  const payload = JSON.parse(readFileSync(target, 'utf8')) as Partial<LiveStopIntent>;
  if (payload.kind !== 'live-stop-intent' || payload.venue !== venue) return undefined;
  if (!payload.createdAt || !payload.updatedAt || !payload.reason || !payload.source) return undefined;
  return payload as LiveStopIntent;
}

export function clearLiveRunIntent(dataDir: string, venue: VenueName): void {
  rmSync(liveIntentPath(dataDir, venue), { force: true });
}

export function clearLiveStopIntent(dataDir: string, venue: VenueName): void {
  rmSync(liveStopIntentPath(dataDir, venue), { force: true });
}

export function publicLiveRunIntents(dataDir: string): Record<VenueName, PublicLiveRunIntent | null> {
  return {
    predict: toPublic(readLiveRunIntent(dataDir, 'predict')),
    polymarket: toPublic(readLiveRunIntent(dataDir, 'polymarket'))
  };
}

function toPublic(intent: LiveRunIntent | undefined): PublicLiveRunIntent | null {
  if (!intent) return null;
  return {
    venue: intent.venue,
    enabled: intent.enabled,
    source: intent.source,
    reason: intent.reason,
    createdAt: intent.createdAt,
    updatedAt: intent.updatedAt,
    sessionStartedAt: intent.sessionStartedAt
  };
}

function liveIntentPath(dataDir: string, venue: VenueName): string {
  return path.join(dataDir, 'runtime-state', `${venue}.live-intent.json`);
}

function liveStopIntentPath(dataDir: string, venue: VenueName): string {
  return path.join(dataDir, 'runtime-state', `${venue}.live-stop-intent.json`);
}
