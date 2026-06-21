import { describe, expect, it } from 'vitest';
import { appConfigSchema } from '../src/config/schema.js';
import { ensurePolymarketParams, resolveVenueConfig } from '../src/config/venue-config.js';

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

  it('resolves Predict to the UNCHANGED base config (byte-identical live path)', () => {
    const config = ensurePolymarketParams(appConfigSchema.parse({ risk: { maxMarkets: 30 } }));
    const resolved = resolveVenueConfig(config, 'predict');
    expect(resolved).toBe(config); // identity — Predict never sees the Polymarket block
    expect(resolved.risk.maxMarkets).toBe(30);
  });

  it('resolves Polymarket to its OWN block with zero fallback to Predict', () => {
    const config = ensurePolymarketParams(appConfigSchema.parse({
      risk: { maxDailyLossUsd: 50, maxMarkets: 30, orderSizeUsd: 25 },
      polymarketParams: { risk: { maxDailyLossUsd: 8, maxMarkets: 1, orderSizeUsd: 5 }, strategy: {} }
    }));
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
