import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { SENSITIVE_KEY_RE, PUBLIC_TOKEN_KEY_RE } from './redact.js';

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
// 'order.ws-update' dominates forensic volume (~2.3k/min, ~1.5GB/day) but is best-effort observability only
// (polymarket-user-stream-handler.ts) — order state is already durably captured in the orders ledger
// (REST-synced size_matched) and fill events, and the UI events table already throttles it. Dropping it from
// the cold archive cuts daily volume to tens of MB. Book ladders are instead captured where they actually
// matter for replay — at fill-detection (engine.ts: fill-circuit-breaker.triggered orderbookSnapshots, with a
// REST fallback so zero-liquidity tokens aren't left blank), per-cycle sampled (forensic kind 'book.snapshot'),
// and on each a3-safe/p1-safe judgment — so "what did the book look like when this got eaten" stays answerable
// without the 1.5GB/day firehose.
const NOISY_EVENT_TYPES = new Set(['quote.skip-existing', 'quote.final-repriced', 'order.ws-update']);

/**
 * Forensic-specific redaction. Unlike the generic `redact()` (used for API error responses), this does NOT
 * run the string-level 64-hex / JWT / Bearer regexes. Reason: a Polymarket `tokenId` is itself a 64-hex
 * string, so the generic string redactor would blank it out and break post-hoc `grep <tokenId>` replay.
 * Here we redact ONLY by sensitive KEY name (privateKey, secret, passphrase, signature, apiKey, ...) and
 * explicitly preserve tokenId / tokenAddress (the replay keys). Free-text strings (e.g. event `message`)
 * are left intact so timelines stay greppable. This keeps real secrets out of the cold archive without
 * harming forensics.
 */
function redactForensicValue(value: unknown, seen: WeakSet<object>): unknown {
  if (Array.isArray(value)) {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    const out = value.map((item) => redactForensicValue(item, seen));
    seen.delete(value);
    return out;
  }
  if (value && typeof value === 'object') {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (PUBLIC_TOKEN_KEY_RE.test(key)) {
        out[key] = item; // 复盘钥匙：原样保留
      } else if (SENSITIVE_KEY_RE.test(key)) {
        out[key] = '[REDACTED]';
      } else {
        out[key] = redactForensicValue(item, seen);
      }
    }
    seen.delete(value);
    return out;
  }
  return value; // 字符串/数字/布尔/null：绝不按字符串扫描，保住自由文本中的 tokenId
}

function redactForensic(value: unknown): Record<string, unknown> {
  return redactForensicValue(value, new WeakSet<object>()) as Record<string, unknown>;
}

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
    appendFileSync(file, JSON.stringify({ ts, iso: new Date(ts).toISOString(), kind, venue, ...redactForensic(data) }) + '\n');
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
