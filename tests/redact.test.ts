import { describe, expect, it } from 'vitest';
import { redact, redactString } from '../src/observability/redact.js';
import { publicErrorText } from '../src/observability/error-message.js';
import { Logger } from '../src/observability/logger.js';
import { StateStore } from '../src/store/sqlite.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

describe('redaction', () => {
  it('redacts private-key-like values in strings', () => {
    const secret = `0x${'a'.repeat(64)}`;
    expect(redactString(`key=${secret}`)).not.toContain(secret);
  });

  it('redacts sensitive object keys', () => {
    expect(redact({ apiKey: 'abc', nested: { jwtToken: 'def', accessToken: 'ghi' }, safe: 'ok' })).toEqual({
      apiKey: '[REDACTED]',
      nested: { jwtToken: '[REDACTED]', accessToken: '[REDACTED]' },
      safe: 'ok'
    });
  });

  it('redacts sensitive checkpoint and metric payloads through the store boundary', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-redact-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    try {
      store.checkpoint('secret-checkpoint', {
        apiKey: 'api-key-should-hide',
        passphrase: 'passphrase-should-hide',
        publicTokenId: 'not-a-standard-token-id'
      });
      store.recordMetric('secret.metric', 1, {
        authorization: 'Bearer very-secret-token-value',
        tokenId: 'public-market-token'
      });

      const checkpoint = JSON.stringify(store.getCheckpoint('secret-checkpoint'));
      expect(checkpoint).not.toContain('api-key-should-hide');
      expect(checkpoint).not.toContain('passphrase-should-hide');
      expect(checkpoint).toContain('[REDACTED]');
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps public market token identifiers visible', () => {
    expect(redact({
      tokenId: 'market-token',
      tokenAddress: '0x1234567890123456789012345678901234567890',
      authToken: 'secret-auth-token'
    })).toEqual({
      tokenId: 'market-token',
      tokenAddress: '0x1234567890123456789012345678901234567890',
      authToken: '[REDACTED]'
    });
  });

  it('serializes circular and bigint SDK-shaped payloads through the store boundary', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-redact-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const receipt: Record<string, unknown> = {
      hash: '0x1234',
      gasUsed: 123n
    };
    receipt.self = receipt;
    try {
      store.recordEvent({
        venue: 'predict',
        severity: 'warn',
        type: 'split.entry.submitted',
        message: '完整套仓拆分交易已提交',
        details: { receipt }
      });
      const [event] = store.listRecentEvents(1);
      expect(event?.details).toMatchObject({
        receipt: {
          hash: '0x1234',
          gasUsed: '123',
          self: '[Circular]'
        }
      });
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('redacts sensitive message strings before logging', () => {
    const lines: string[] = [];
    const jwt = 'eyJ' + 'a'.repeat(12) + '.' + 'b'.repeat(12) + '.' + 'c'.repeat(12);
    const logger = new Logger('debug', {
      log: (line: string) => lines.push(line),
      error: (line: string) => lines.push(line)
    });

    logger.error(`upstream rejected Bearer ${jwt}`, { apiSecret: 'should-hide' });

    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain(jwt);
    expect(lines[0]).not.toContain('should-hide');
    expect(lines[0]).toContain('[REDACTED]');
  });

  it('redacts sensitive event messages before writing SQLite audit events', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-redact-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const secret = `0x${'a'.repeat(64)}`;
    try {
      store.recordEvent({
        venue: 'predict',
        severity: 'error',
        type: 'secret-message',
        message: `failure included private key ${secret}`,
        details: { authorization: 'Bearer very-secret-token-value' }
      });
      const [event] = store.listRecentEvents(1);
      expect(event?.message).not.toContain(secret);
      expect(JSON.stringify(event?.details)).not.toContain('very-secret-token-value');
      expect(event?.message).toContain('[REDACTED_HEX]');
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('summarizes chain gas errors without exposing full transaction payloads', () => {
    const longTransaction = `Predict split positions failed: insufficient funds for intrinsic transaction cost (transaction="0x${'a'.repeat(600)}", info={ "error": { "message": "insufficient funds for gas * price + value: balance 0" } })`;
    const message = publicErrorText(longTransaction);

    expect(message).toContain('普通挂单不需要 BNB');
    expect(message).not.toContain('transaction=');
    expect(message).not.toContain('a'.repeat(80));
    expect(message.length).toBeLessThan(160);
  });

  it('flags a Cloudflare 1009 geo-block as a VPN/region issue, not a credential failure', () => {
    const message = publicErrorText('Request failed: HTTP 403 — error 1009: the owner of this website has banned the country or region your IP address is in (cloudflare)');
    expect(message).toContain('地区');
    expect(message).toMatch(/VPN/);
    expect(message).not.toContain('凭据失效'); // must NOT read as an expired-credential problem
  });

  it('makes a bare HTTP 403 mention region/VPN as a possible cause (403 is ambiguous: auth OR geo)', () => {
    const message = publicErrorText('Order placement failed: HTTP 403 Forbidden');
    expect(message).toMatch(/地区|VPN/);
  });

  it('flags an explicit region-restriction message', () => {
    const message = publicErrorText('This market is not available in your region');
    expect(message).toContain('地区');
  });

  it('treats a connection timeout as a network/VPN connectivity issue', () => {
    const message = publicErrorText('connect ETIMEDOUT 104.18.0.0:443');
    expect(message).toMatch(/网络|VPN/);
  });
});
