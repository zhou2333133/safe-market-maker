import { describe, expect, it } from 'vitest';
import { appConfigSchema } from '../src/config/schema.js';
import type { SignerProvider } from '../src/secrets/signer.js';
import { PredictVenue, predictJwtExpiryMs, predictJwtUsable } from '../src/venues/predict.js';

function jwtWithExp(expSeconds: number | undefined): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const claims = expSeconds === undefined ? { sub: 'x' } : { sub: 'x', exp: expSeconds };
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${header}.${payload}.sig`;
}

const mockSigner: SignerProvider = {
  address: `0x${'1'.repeat(40)}`,
  signMessage: async () => '0xsig',
  signTypedData: async () => '0xsig'
};

describe('predict JWT freshness gating', () => {
  it('decodes a standard JWT exp claim', () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    expect(predictJwtExpiryMs(jwtWithExp(exp))).toBe(exp * 1000);
  });

  it('treats an expired JWT as unusable', () => {
    expect(predictJwtUsable(jwtWithExp(Math.floor(Date.now() / 1000) - 60))).toBe(false);
  });

  it('treats a comfortably-future JWT as usable', () => {
    expect(predictJwtUsable(jwtWithExp(Math.floor(Date.now() / 1000) + 3600))).toBe(true);
  });

  it('flags a JWT inside the refresh margin as unusable so it refreshes before mid-cycle expiry', () => {
    expect(predictJwtUsable(jwtWithExp(Math.floor(Date.now() / 1000) + 30))).toBe(false);
  });

  it('falls back to "usable" for opaque non-JWT tokens (preserves presence-only behavior)', () => {
    expect(predictJwtExpiryMs('opaque-token')).toBeUndefined();
    expect(predictJwtUsable('opaque-token')).toBe(true);
  });

  it('preflight reports jwt check NOT ok when the stored token is expired, so re-auth is triggered', async () => {
    const config = appConfigSchema.parse({ venues: { predict: { apiKey: 'k' } } });
    const venue = new PredictVenue(config, { jwt: jwtWithExp(Math.floor(Date.now() / 1000) - 10) });
    const result = await venue.preflight(mockSigner);
    expect(result.checks.find((check) => check.name === 'jwt')?.ok).toBe(false);
    expect(result.ok).toBe(false);
  });

  it('preflight reports jwt check ok when the stored token is still fresh', async () => {
    const config = appConfigSchema.parse({ venues: { predict: { apiKey: 'k' } } });
    const venue = new PredictVenue(config, { jwt: jwtWithExp(Math.floor(Date.now() / 1000) + 3600) });
    const result = await venue.preflight(mockSigner);
    expect(result.checks.find((check) => check.name === 'jwt')?.ok).toBe(true);
  });
});
