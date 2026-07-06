import type { AppConfig } from './schema.js';
import type { VenueName } from '../domain/types.js';

/**
 * Both venues run on FULLY INDEPENDENT copies of risk + strategy (config.predictParams / config.polymarketParams).
 * Each is synthesized from the base config exactly once on first load, so a brand-new config starts with both
 * behaving identically to today, then diverges independently as the user edits each venue's settings.
 */
export function ensurePredictParams(config: AppConfig): AppConfig {
  if (config.predictParams) return config;
  return {
    ...config,
    predictParams: {
      risk: structuredClone(config.risk),
      strategy: stripVenuePrefixedStrategy(structuredClone(config.strategy), 'predict')
    }
  };
}

export function ensurePolymarketParams(config: AppConfig): AppConfig {
  if (config.polymarketParams) return config;
  return {
    ...config,
    polymarketParams: {
      risk: structuredClone(config.risk),
      strategy: stripVenuePrefixedStrategy(structuredClone(config.strategy), 'polymarket')
    }
  };
}

/**
 * Remove the other-venue's prefixed fields from a strategy block. Fields whose name starts with `polymarket` only
 * belong in polymarketParams.strategy; fields starting with `predict` only belong in predictParams.strategy. The
 * single `strategySchema` definition is shared (zod doesn't have a clean way to model "venue tag → field"), but
 * this stripper enforces the invariant at the seams: every place that builds a venue strategy block runs through
 * it, so cross-venue fields cannot survive to runtime even if a user (or the UI write path) put them there.
 *
 * Non-mutating: returns a NEW object so callers can safely structuredClone() upstream.
 */
export function stripVenuePrefixedStrategy<T extends Record<string, unknown>>(strategy: T, venue: VenueName): T {
  const out: Record<string, unknown> = {};
  const otherPrefix = venue === 'predict' ? 'polymarket' : 'predict';
  for (const [key, value] of Object.entries(strategy)) {
    if (key.startsWith(otherPrefix)) continue;
    out[key] = value;
  }
  return out as T;
}

/**
 * Return the risk + strategy a given venue must run on. Predict => its predictParams block. Polymarket =>
 * its polymarketParams block. The two blocks are SEPARATE COPIES with ZERO fallback to the top-level config —
 * load.ts is required to synthesize the missing block via ensurePredictParams / ensurePolymarketParams before
 * any venue runs, so a missing block at this point is a programmer error (config went through a path that
 * skipped the synth) and must throw, not silently fall back to a mixed top-level block. The throw is what
 * preserves the "edits to one venue can NEVER leak to the other" invariant.
 */
export function resolveVenueConfig(config: AppConfig, venue: VenueName): AppConfig {
  if (venue === 'predict') {
    const params = config.predictParams;
    if (!params) {
      throw new Error('predictParams is missing from config — ensurePredictParams() must be called on every load path before resolveVenueConfig().');
    }
    // Strip any polymarket* leaks that may have entered predictParams.strategy via YAML edits or UI write-backs.
    // This is a defence-in-depth seam — the engine sees a clean venue-pure strategy block regardless of upstream
    // hygiene. Predict can NEVER read a polymarket-only field at runtime even if it's physically present in YAML.
    return { ...config, risk: params.risk, strategy: stripVenuePrefixedStrategy(params.strategy, 'predict') };
  }
  if (venue !== 'polymarket') return config;
  const params = config.polymarketParams;
  if (!params) {
    throw new Error('polymarketParams is missing from config — ensurePolymarketParams() must be called on every load path before resolveVenueConfig().');
  }
  // For two-sided LP the real per-ORDER size is the total budget split across legs (polymarketLpTotalUsd /
  // maxTokensPerMarket), NOT the (often stale) base orderSizeUsd. Reflect it in risk.orderSizeUsd so the capital
  // pre-check, risk gates and sizing all use the true per-leg amount instead of blocking on the base value.
  let risk = params.risk;
  if (params.strategy.polymarketTwoSidedLp) {
    const perLeg = Number(
      (Math.max(0, params.strategy.polymarketLpTotalUsd) / Math.max(1, params.strategy.maxTokensPerMarket ?? 2)).toFixed(4)
    );
    if (perLeg > 0) {
      risk = {
        ...params.risk,
        orderSizeUsd: perLeg,
        maxSingleOrderUsd: Math.max(perLeg, params.risk.maxSingleOrderUsd),
        maxPositionUsd: Math.max(perLeg, params.risk.maxPositionUsd)
      };
    }
  }
  // Strip any predict* leaks before handing the strategy to the Polymarket engine — symmetric to the predict
  // branch above so neither venue can observe the other's prefixed parameters at runtime.
  return { ...config, risk, strategy: stripVenuePrefixedStrategy(params.strategy, 'polymarket') };
}

const VENUE_PREFIXES: ReadonlyArray<VenueName> = ['polymarket', 'predict'];
/**
 * Detect top-level `strategy` keys that are venue-prefixed (e.g. `polymarketFrontDepthUsd`) yet the corresponding
 * venue block (polymarketParams / predictParams) exists. resolveVenueConfig only reads the venue block, so these
 * top-level keys are silently IGNORED — a configuration trap (edits there look like they should work but don't).
 * Returns the offending key names so the UI can warn once at startup. Pure read, no mutation.
 */
export function findDeadTopLevelPrefixedStrategyKeys(config: AppConfig): string[] {
  const dead: string[] = [];
  const strategy = (config.strategy ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(strategy)) {
    const venue = VENUE_PREFIXES.find((v) => key.startsWith(v));
    if (!venue) continue;
    const block = venue === 'polymarket' ? config.polymarketParams : config.predictParams;
    if (block) dead.push(key);
  }
  return dead;
}
