import { describe, expect, it } from 'vitest';
import { appConfigSchema } from '../src/config/schema.js';
import { ensurePolymarketParams, ensurePredictParams, resolveVenueConfig, stripVenuePrefixedStrategy } from '../src/config/venue-config.js';

describe('per-venue config independence', () => {
  it('synthesizes the Polymarket block from the base on first load (preserving behaviour)', () => {
    const base = appConfigSchema.parse({ risk: { maxDailyLossUsd: 37, orderSizeUsd: 22 }, strategy: { quoteRefreshMs: 3500 } });
    expect(base.polymarketParams).toBeUndefined();
    const migrated = ensurePolymarketParams(base);
    expect(migrated.polymarketParams?.risk.maxDailyLossUsd).toBe(37);
    expect(migrated.polymarketParams?.risk.orderSizeUsd).toBe(22);
    expect(migrated.polymarketParams?.strategy.quoteRefreshMs).toBe(3500);
  });

  it('does not re-synthesize when a Polymarket block already exists', () => {
    const config = ensurePolymarketParams(appConfigSchema.parse({
      risk: { maxDailyLossUsd: 50 },
      polymarketParams: { risk: { maxDailyLossUsd: 9 }, strategy: {} }
    }));
    expect(config.polymarketParams?.risk.maxDailyLossUsd).toBe(9); // kept, not overwritten by base 50
  });

  it('resolves Predict to its OWN synthesized block (base values seeded via ensurePredictParams)', () => {
    const base = ensurePredictParams(ensurePolymarketParams(appConfigSchema.parse({ risk: { maxMarkets: 30 } })));
    const resolved = resolveVenueConfig(base, 'predict');
    // Predict gets its OWN copy of risk/strategy — the seeded values match the base, but it's not the same object.
    expect(resolved.risk.maxMarkets).toBe(30);
    expect(resolved.risk).toBe(base.predictParams!.risk);
  });

  it('throws (fail-closed) when the venue params block is missing — no silent fallback to top-level', () => {
    // resolveVenueConfig REQUIRES ensure*Params to have been called. The old fallback-to-base behaviour was a
    // foot-gun: a config that skipped the synth would silently mix Predict + Polymarket defaults. Now we throw.
    const bare = appConfigSchema.parse({});
    expect(() => resolveVenueConfig(bare, 'predict')).toThrowError(/predictParams is missing/);
    expect(() => resolveVenueConfig(bare, 'polymarket')).toThrowError(/polymarketParams is missing/);
  });

  it('resolves Polymarket to its OWN block with zero fallback to Predict', () => {
    const config = ensurePredictParams(ensurePolymarketParams(appConfigSchema.parse({
      risk: { maxDailyLossUsd: 50, maxMarkets: 30, orderSizeUsd: 25 },
      polymarketParams: { risk: { maxDailyLossUsd: 8, maxMarkets: 1, orderSizeUsd: 5 }, strategy: {} }
    })));
    const poly = resolveVenueConfig(config, 'polymarket');
    expect(poly.risk.maxDailyLossUsd).toBe(8);
    expect(poly.risk.maxMarkets).toBe(1);
    expect(poly.risk.orderSizeUsd).toBe(5);
    // Predict's resolved view still shows ITS values — the two never bleed into each other.
    const pred = resolveVenueConfig(config, 'predict');
    expect(pred.risk.maxDailyLossUsd).toBe(50);
    expect(pred.risk.maxMarkets).toBe(30);
    expect(pred.risk.orderSizeUsd).toBe(25);
  });

  it('stripVenuePrefixedStrategy removes the other-venue prefixed fields, leaves shared + own', () => {
    const mixed = {
      quoteRefreshMs: 2000,
      polymarketLpTotalUsd: 100,
      polymarketFastQuoteMs: 500,
      predictFrontDepthUsd: 200,
      predictCrowdedThreshold: 50
    };
    const forPredict = stripVenuePrefixedStrategy(mixed, 'predict') as Record<string, unknown>;
    expect(forPredict.quoteRefreshMs).toBe(2000);
    expect(forPredict.predictFrontDepthUsd).toBe(200);
    expect(forPredict.predictCrowdedThreshold).toBe(50);
    expect('polymarketLpTotalUsd' in forPredict).toBe(false);
    expect('polymarketFastQuoteMs' in forPredict).toBe(false);

    const forPoly = stripVenuePrefixedStrategy(mixed, 'polymarket') as Record<string, unknown>;
    expect(forPoly.quoteRefreshMs).toBe(2000);
    expect(forPoly.polymarketLpTotalUsd).toBe(100);
    expect(forPoly.polymarketFastQuoteMs).toBe(500);
    expect('predictFrontDepthUsd' in forPoly).toBe(false);
    expect('predictCrowdedThreshold' in forPoly).toBe(false);
  });

  it('resolveVenueConfig strips cross-venue strategy fields at runtime (defence-in-depth)', () => {
    const config = ensurePredictParams(ensurePolymarketParams(appConfigSchema.parse({
      // Simulate a dirty YAML: predictParams.strategy contains polymarket* fields, and vice versa.
      predictParams: {
        risk: {},
        strategy: { polymarketLpTotalUsd: 999, predictFrontDepthUsd: 333 }
      },
      polymarketParams: {
        risk: {},
        strategy: { polymarketLpTotalUsd: 50, predictFrontDepthUsd: 444 }
      }
    })));
    const pred = resolveVenueConfig(config, 'predict');
    expect((pred.strategy as Record<string, unknown>).polymarketLpTotalUsd).toBeUndefined();
    expect((pred.strategy as Record<string, unknown>).predictFrontDepthUsd).toBe(333);
    const poly = resolveVenueConfig(config, 'polymarket');
    expect((poly.strategy as Record<string, unknown>).predictFrontDepthUsd).toBeUndefined();
    expect((poly.strategy as Record<string, unknown>).polymarketLpTotalUsd).toBe(50);
  });

  it('keeps the two blocks as independent objects (editing one never touches the other)', () => {
    const config = ensurePolymarketParams(appConfigSchema.parse({ risk: { maxDailyLossUsd: 50 } }));
    // mutate the Polymarket block
    config.polymarketParams!.risk.maxDailyLossUsd = 3;
    expect(config.risk.maxDailyLossUsd).toBe(50); // base untouched
    // mutate the base
    config.risk.maxDailyLossUsd = 99;
    expect(config.polymarketParams!.risk.maxDailyLossUsd).toBe(3); // Polymarket untouched
  });
});
