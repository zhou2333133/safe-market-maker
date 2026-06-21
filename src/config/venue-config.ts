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
      strategy: structuredClone(config.strategy)
    }
  };
}

export function ensurePolymarketParams(config: AppConfig): AppConfig {
  if (config.polymarketParams) return config;
  return {
    ...config,
    polymarketParams: {
      risk: structuredClone(config.risk),
      strategy: structuredClone(config.strategy)
    }
  };
}

/**
 * Return the risk + strategy a given venue must run on. Predict => its predictParams block (falls back to
 * top-level config for backward compat). Polymarket => its polymarketParams block. Everything downstream
 * (engine, risk, strategy, router, data-sync) receives the resolved config and needs no venue-awareness.
 */
export function resolveVenueConfig(config: AppConfig, venue: VenueName): AppConfig {
  if (venue === 'predict') {
    const params = config.predictParams;
    if (!params) return config;
    return { ...config, risk: params.risk, strategy: params.strategy };
  }
  if (venue !== 'polymarket') return config;
  const params = config.polymarketParams;
  if (!params) {
    // Defensive: a config that skipped ensurePolymarketParams() still resolves safely to the base values.
    return config;
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
  return { ...config, risk, strategy: params.strategy };
}
