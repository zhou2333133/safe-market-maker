import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  configureForensicLog,
  forensicLog,
  forensicLogEvent,
  currentForensicFile,
  resetForensicLogForTest
} from '../src/observability/forensic-log.js';

describe('forensic log', () => {
  beforeEach(() => resetForensicLogForTest());

  it('is a no-op (and never throws) when not configured', () => {
    expect(() => forensicLog('x', 'polymarket', { a: 1 })).not.toThrow();
    expect(currentForensicFile()).toBeUndefined();
  });

  it('writes one JSONL record per call once configured, with ts/iso/kind/venue + payload', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'forensic-'));
    configureForensicLog(dir);
    forensicLog('risk-gate', 'polymarket', { ok: true, equityUsd: 0, dayStartEquityUsd: 0, dailyPnlUsd: 0, realizedPnlUsd: -66.7 });
    const file = currentForensicFile();
    expect(file).toBeDefined();
    const lines = readFileSync(file as string, 'utf8').trim().split('\n');
    const rec = JSON.parse(lines[lines.length - 1] as string);
    expect(rec).toMatchObject({ kind: 'risk-gate', venue: 'polymarket', ok: true, equityUsd: 0, realizedPnlUsd: -66.7 });
    expect(typeof rec.ts).toBe('number');
    expect(typeof rec.iso).toBe('string');
  });

  it('drops noisy event types but keeps meaningful ones', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'forensic-'));
    configureForensicLog(dir);
    forensicLogEvent({ type: 'quote.skip-existing', message: 'noise', venue: 'polymarket' });
    forensicLogEvent({ type: 'cash-fill.exit-blocked', message: 'kept', venue: 'polymarket', severity: 'warn' });
    const file = currentForensicFile() as string;
    const content = existsSync(file) ? readFileSync(file, 'utf8') : '';
    expect(content).not.toContain('quote.skip-existing');
    expect(content).toContain('cash-fill.exit-blocked');
  });
});
