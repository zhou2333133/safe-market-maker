import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

/**
 * Backend-only forensic log. Writes a full-fidelity, daily-rotated JSONL audit trail under <dataDir>/forensic/ that is
 * NEVER served to the frontend. It exists so that after-the-fact "how did this actually happen" questions (why a stop
 * did/didn't fire, what the book looked like when an order was filled, what the risk snapshot really contained) can be
 * answered from a durable record — separate from the UI events table, which truncates and drops the silent-pass cases.
 *
 * Hard rule: forensic logging must NEVER affect bot execution. Every call is wrapped so a disk/serialization error is
 * swallowed; when unconfigured it is a no-op.
 */

let forensicDir: string | undefined;

// Highest-frequency, lowest-signal events are dropped so the meaningful trail (fills, exits, rejects, risk gates,
// replaces, errors) isn't buried. Everything else — including exit-blocked thrashing — is kept.
const NOISY_EVENT_TYPES = new Set(['quote.skip-existing', 'quote.final-repriced']);

/** Point the forensic log at <dataDir>/forensic/. Safe to call repeatedly (e.g. each store open). */
export function configureForensicLog(dataDir: string): void {
  try {
    const dir = path.join(dataDir, 'forensic');
    mkdirSync(dir, { recursive: true });
    forensicDir = dir;
  } catch {
    forensicDir = undefined;
  }
}

/** Current day's forensic file path, or undefined when unconfigured. Exposed for ops/tests. */
export function currentForensicFile(now = Date.now()): string | undefined {
  if (!forensicDir) return undefined;
  return path.join(forensicDir, `forensic-${new Date(now).toISOString().slice(0, 10)}.jsonl`);
}

/** Append one structured forensic record. `kind` groups records (e.g. 'event', 'risk-gate', 'fill-detected'). */
export function forensicLog(kind: string, venue: string | undefined, data: Record<string, unknown>): void {
  const file = currentForensicFile();
  if (!file) return;
  try {
    const ts = Date.now();
    appendFileSync(file, JSON.stringify({ ts, iso: new Date(ts).toISOString(), kind, venue, ...data }) + '\n');
  } catch {
    /* forensic logging must never break the bot */
  }
}

/** Mirror a recorded event into the forensic log at FULL detail (the UI table truncates), minus the noisy types. */
export function forensicLogEvent(input: { venue?: string; severity?: string; type: string; message: string; details?: unknown }): void {
  if (NOISY_EVENT_TYPES.has(input.type)) return;
  forensicLog('event', input.venue, {
    type: input.type,
    severity: input.severity,
    message: input.message,
    details: input.details
  });
}

/** Test-only: forget the configured directory so each test starts clean. */
export function resetForensicLogForTest(): void {
  forensicDir = undefined;
}

/**
 * Delete forensic JSONL files older than retentionMs (default 30d). Called from store retention at startup so the
 * bot self-maintains disk; never throws. Files match `forensic-YYYY-MM-DD.jsonl`; anything else in the dir is left alone.
 */
export function pruneOldForensicFiles(dataDir: string, retentionMs: number, now = Date.now()): number {
  let deleted = 0;
  try {
    const fs = require('node:fs') as typeof import('node:fs');
    const dir = path.join(dataDir, 'forensic');
    if (!fs.existsSync(dir)) return 0;
    const cutoff = now - retentionMs;
    for (const entry of fs.readdirSync(dir)) {
      const match = /^forensic-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(entry);
      if (!match) continue;
      const dayMs = Date.parse(match[1] + 'T00:00:00Z');
      if (!Number.isFinite(dayMs) || dayMs >= cutoff) continue;
      try { fs.unlinkSync(path.join(dir, entry)); deleted += 1; } catch { /* ignore */ }
    }
  } catch { /* never throw */ }
  return deleted;
}
