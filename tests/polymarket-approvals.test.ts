import { describe, expect, it } from 'vitest';
import {
  ctfApprovalCheckResult,
  deriveOrCreatePolymarketCredential,
  normalizePolymarketGeoblock,
  polymarketAllowanceValue,
  polymarketApprovalTarget,
  polymarketGeoTradingDecision,
  polymarketMarketOrderStatus,
  POLYMARKET_EXCHANGE_V2,
  POLYMARKET_NEG_RISK_EXCHANGE_V2
} from '../src/venues/polymarket.js';

describe('ctfApprovalCheckResult — CTF outcome-token approval gate (needed for reduce-only exits)', () => {
  it('BLOCKS live only when the allowance is verifiably zero', () => {
    const result = ctfApprovalCheckResult(0, true);
    expect(result.ok).toBe(false);
    expect(result.name).toBe('ctf-allowance');
    expect(result.message).toContain('未授权');
  });

  it('passes when the allowance is positive (approved)', () => {
    const result = ctfApprovalCheckResult(1e30, true);
    expect(result.ok).toBe(true);
    expect(result.message).toContain('已授权');
  });

  it('warns but does NOT block when the allowance is unreadable', () => {
    expect(ctfApprovalCheckResult(undefined, true).ok).toBe(true);
  });

  it('warns but does NOT block when there is no token to test (fresh account, auto-select)', () => {
    expect(ctfApprovalCheckResult(undefined, false).ok).toBe(true);
  });
});

describe('polymarketAllowanceValue', () => {
  it('parses the nested SDK allowances map instead of treating zero allowance as unknown', () => {
    expect(polymarketAllowanceValue({
      balance: '0',
      allowances: {
        '0xE111180000d2663C0091e4f400237545B87B996B': '0',
        '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296': '0'
      }
    })).toBe(0);
  });

  it('uses the largest parsed allowance when the SDK returns multiple spender entries', () => {
    expect(polymarketAllowanceValue({
      allowances: {
        one: '0',
        two: '2500000'
      }
    })).toBe(2500000);
  });
});

describe('polymarketApprovalTarget', () => {
  it('selects only the exchange required by the chosen token', () => {
    expect(polymarketApprovalTarget(false)).toBe(POLYMARKET_EXCHANGE_V2);
    expect(polymarketApprovalTarget(true)).toBe(POLYMARKET_NEG_RISK_EXCHANGE_V2);
  });
});

describe('deriveOrCreatePolymarketCredential', () => {
  const credential = { key: 'key', secret: 'secret', passphrase: 'passphrase' };

  it('derives nonce 0 before attempting to create a credential', async () => {
    let createCalls = 0;
    await expect(deriveOrCreatePolymarketCredential({
      deriveApiKey: async (nonce) => {
        expect(nonce).toBe(0);
        return credential;
      },
      createApiKey: async () => {
        createCalls += 1;
        return credential;
      }
    })).resolves.toEqual(credential);
    expect(createCalls).toBe(0);
  });

  it('creates nonce 0 only when derivation fails', async () => {
    await expect(deriveOrCreatePolymarketCredential({
      deriveApiKey: async () => {
        throw new Error('not found');
      },
      createApiKey: async (nonce) => {
        expect(nonce).toBe(0);
        return credential;
      }
    })).resolves.toEqual(credential);
  });
});

describe('normalizePolymarketGeoblock', () => {
  it('parses an authoritative blocked response', () => {
    expect(normalizePolymarketGeoblock({ blocked: true, country: 'JP', region: '13' })).toEqual({
      blocked: true,
      country: 'JP',
      region: '13'
    });
  });

  it('fails closed when the response omits the blocked boolean', () => {
    expect(() => normalizePolymarketGeoblock({ country: 'JP' })).toThrow('malformed');
  });
});

describe('polymarketGeoTradingDecision', () => {
  it('allows Japan API trading only when authenticated CLOB mode is not close-only', () => {
    expect(polymarketGeoTradingDecision({ blocked: true, country: 'JP' }, false).ok).toBe(true);
    expect(polymarketGeoTradingDecision({ blocked: true, country: 'JP' }, true).ok).toBe(false);
    expect(polymarketGeoTradingDecision({ blocked: true, country: 'JP' }).ok).toBe(false);
  });

  it('continues to block fully restricted countries', () => {
    expect(polymarketGeoTradingDecision({ blocked: true, country: 'US', region: 'NY' }, false)).toEqual({
      ok: false,
      message: 'blocked country=US region=NY'
    });
  });
});

describe('polymarketMarketOrderStatus', () => {
  it('does not treat every accepted FAK request as a completed fill', () => {
    expect(polymarketMarketOrderStatus({ success: true, status: 'matched' })).toBe('FILLED');
    expect(polymarketMarketOrderStatus({ success: true, status: 'unmatched' })).toBe('CANCELED');
    expect(polymarketMarketOrderStatus({ success: true, status: 'delayed' })).toBe('PENDING_OPEN');
    expect(polymarketMarketOrderStatus({ success: true, status: 'live' })).toBe('OPEN');
    expect(polymarketMarketOrderStatus({ success: true })).toBe('UNKNOWN');
  });
});
