import { z } from 'zod';

const endpointPolicySchema = z.object({
  allowCustom: z.boolean().default(false),
  extraAllowedHosts: z.array(z.string()).default([])
}).default({});

const riskSchema = z.object({
  orderSizeUsd: z.number().positive().default(25),
  maxSingleOrderUsd: z.number().positive().default(25),
  maxPositionUsd: z.number().positive().default(100),
  maxDailyLossUsd: z.number().positive().default(50),
  maxAccountRiskStaleMs: z.number().int().positive().default(120000),
  maxOpenOrderReserveDriftUsd: z.number().nonnegative().default(2),
  maxOpenOrderReserveDriftPct: z.number().nonnegative().default(25),
  settlementNoNewOrdersMs: z.number().int().nonnegative().default(30 * 60 * 1000),
  settlementCancelOpenOrdersMs: z.number().int().nonnegative().default(10 * 60 * 1000),
  shortEventMaxDurationMs: z.number().int().nonnegative().default(12 * 60 * 60 * 1000),
  eventStartNoNewOrdersMs: z.number().int().nonnegative().default(30 * 60 * 1000),
  eventStartCancelOpenOrdersMs: z.number().int().nonnegative().default(10 * 60 * 1000),
  blockUnknownEndTime: z.boolean().default(true),
  maxBboMoveCents: z.number().positive().default(2),
  maxSpreadMoveBps: z.number().positive().default(150),
  maxOpenOrdersPerMarket: z.number().int().positive().default(4),
  maxMarkets: z.number().int().positive().default(3),
  staleBookMs: z.number().int().positive().default(2000),
  minDepthUsdPerSide: z.number().nonnegative().default(25),
  minPrice: z.number().min(0).max(1).default(0.08),
  maxPrice: z.number().min(0).max(1).default(0.92),
  minSpreadBps: z.number().nonnegative().default(0),
  maxSpreadBps: z.number().positive().default(600),
  requirePostOnly: z.boolean().default(true)
}).default({});

const strategySchema = z.object({
  optimizerMode: z.enum(['points']).default('points'),
  tradingMode: z.enum(['conservative', 'aggressive']).default('conservative'),
  pointsOnly: z.boolean().default(true),
  acceptingOnly: z.boolean().default(true),
  autoSelectMarkets: z.boolean().default(true),
  minMarketLiquidityUsd: z.number().nonnegative().default(0),
  minRewardLevel: z.number().int().min(0).max(5).default(0),
  minRewardSizeMultiplier: z.number().positive().default(1),
  enforceRewardMinimum: z.boolean().default(true),
  candidateLimit: z.number().int().positive().default(12),
  switchThresholdPct: z.number().nonnegative().default(15),
  gasBufferMultiplier: z.number().positive().default(1.35),
  fallbackSplitMergeGasUnits: z.number().int().positive().default(450000),
  minSwitchBenefitMultiplier: z.number().nonnegative().default(4),
  minSwitchEdgeAfterGasUsd: z.number().nonnegative().default(0.05),
  minSafeHoursForSwitch: z.number().nonnegative().default(0.5),
  bnbUsdForGasEstimate: z.number().positive().default(650),
  entryMode: z.enum(['cash', 'inventory', 'split']).default('cash'),
  dualSide: z.boolean().default(false),
  quoteSide: z.enum(['buy', 'sell', 'both']).default('buy'),
  quoteRefreshMs: z.number().int().positive().default(2000),
  marketRefreshMs: z.number().int().positive().default(60000),
  conservativeDepthLevel: z.number().int().min(1).default(1),
  aggressiveDepthLevel: z.number().int().min(1).default(3),
  retreatTicks: z.number().int().min(0).default(1),
  replaceThresholdTicks: z.number().int().min(0).default(1),
  // Predict cash-buy stale-book grace period (ms). 0 = use the hard-coded default (15s). Set to 60000 (60s) to
  // match the watch-all cache tolerance so quiet Predict.fun markets aren't cancelled for stale WS books.
  predictCashBuyStaleGraceMs: z.number().nonnegative().default(0),
  cashProbeMinFrontDepthUsd: z.number().nonnegative().default(100),
  // Predict-specific front-depth floor (overrides cashProbeMinFrontDepthUsd for Predict only). Minimum USD of resting
  // orders required IN FRONT of a Predict cash-buy order. 0 = fall back to cashProbeMinFrontDepthUsd.
  predictFrontDepthUsd: z.number().nonnegative().default(0),
  cashProbeDepthMultiplier: z.number().nonnegative().default(2),
  cashProbeMaxSupportGapCents: z.number().positive().default(1.5),
  // Max gap between the level above the order and the support wall below it, in TICK multiples (adaptive to each
  // venue's tick — 0.1c on Polymarket). Replaces the absolute-cents cap, which was non-binding at 0.1c ticks.
  cashProbeMaxSupportGapTicks: z.number().positive().default(10),
  cashProbeNeverTopOfBook: z.boolean().default(true),
  // Exit-liquidity (back-support) gate: require bid depth BELOW the resting BUY (within the exit-loss cap) to be able to
  // absorb the full order size, so a fill can be unwound at ≤ the loss cap instead of becoming stuck single-leg
  // inventory. Opt-in per venue (off by default = unchanged behaviour).
  cashRequireExitLiquidity: z.boolean().default(false),
  // Max ticks BELOW the resting BUY that count as exit liquidity (close-behind protection). Liquidity further than
  // this is a big-loss exit and does NOT count as protection. ~2 ticks ≈ unwind within 1-2 ticks. Tune freely.
  cashExitLiquidityMaxTicks: z.number().positive().default(2),
  // CENT-based support window (user's core rule #3): bids within this many cents BELOW the resting BUY must
  // collectively cover the full order size, regardless of venue tick. Same 1¢ rule works for 1¢ tick markets
  // (need 19¢ bid for 20¢ placement) and 0.1¢ tick markets (need cumulative depth in 21.1¢-22.1¢ for 22.1¢
  // placement). 0 = disabled (default for backward compat); set to 1 per venue to enable the strict rule.
  cashSupportWindowCents: z.number().nonnegative().default(0),
  cancelOutsideReward: z.boolean().default(true),
  onFillAction: z.enum(['hold', 'sellAllAtMarket']).default('hold'),
  cashOnFillAction: z.enum(['hold', 'sellWithinLossCap']).default('hold'),
  cashMaxExitLossPct: z.number().min(0).max(100).default(30),
  liquidationSlippageTicks: z.number().int().min(0).default(2),
  liquidationMaxSlippageCents: z.number().positive().default(10),
  minPositionSizeToLiquidate: z.number().positive().default(0.0001),
  balanceReserveUsd: z.number().nonnegative().default(1),
  inventorySkewEnabled: z.boolean().default(true),
  maxInventorySkewUsd: z.number().positive().default(50),
  dedupeMarketGroups: z.boolean().default(true),
  maxTokensPerMarket: z.number().int().positive().default(2),
  polymarketTwoSidedLp: z.boolean().default(false),
  // Total notional budget for one Polymarket two-sided LP group (YES + NO legs combined, split across the two legs).
  polymarketLpTotalUsd: z.number().positive().default(20),
  // How many Polymarket markets to run a two-sided LP in at once. Default 1 (single focused market); raise to diversify.
  polymarketMaxMarkets: z.number().int().positive().default(1),
  // Hard principal-loss kill switch (USD) for Polymarket: at this session loss, cancel + reduce-only exit everything and stop until manual restart. 0 = use risk.maxDailyLossUsd only.
  polymarketMaxLossUsd: z.number().nonnegative().default(0),
  // Polymarket pays nothing if a market's daily reward to you is below this (platform threshold is $1/day, paid after 08:00). Markets whose estimated daily reward is under this are skipped to avoid quoting for zero payout.
  polymarketMinDailyRewardUsd: z.number().nonnegative().default(1),
  // Polymarket two-sided LP placement (manual, separate from Predict): which reward-band level to start at
  // (1 = best/front, 2 = one level behind the front, ...) and the minimum USD of resting orders required IN FRONT of
  // your order (protection depth). Higher level / deeper front = less likely to be filled, slightly lower reward.
  polymarketStartLevel: z.number().int().min(1).default(2),
  polymarketFrontDepthUsd: z.number().nonnegative().default(150),
  // Runtime fast-retreat floor: each (fast) tick re-checks the LIVE front cushion ($ of bids ahead of our resting BUY).
  // If it falls below this, the placement protection has been pulled/swept and the order is about to be filled — it is
  // cancelled (retreated) immediately, in fast ticks too. 0 = off. Set BELOW polymarketFrontDepthUsd for hysteresis.
  polymarketRetreatFrontDepthUsd: z.number().nonnegative().default(0),
  // Fast quote-refresh (Polymarket single-sided). On most loop ticks the engine re-quotes ONLY the markets that
  // currently hold resting orders/positions — reading their books straight from the WS cache — and skips the
  // full-universe candidate audit (the ~16s bottleneck), so resting orders stay pinned to their target level within
  // ~1-2s as the book moves. polymarketFastQuoteMs = the gap between fast ticks (0 = disabled, every tick is a full
  // discovery cycle, i.e. legacy behaviour). polymarketFullCycleMs = how often a FULL discovery/rotation/audit cycle
  // runs in between fast ticks. Both default 0 so Predict and any venue that doesn't set them is completely unchanged.
 polymarketFastQuoteMs: z.number().nonnegative().default(0),
 polymarketFullCycleMs: z.number().nonnegative().default(0),
  // Predict fast quote-refresh (same mechanism as Polymarket's). On most loop ticks the engine re-quotes ONLY the
  // markets that currently hold resting orders — reading books from WS cache — and skips the full-universe candidate
  // audit. predictFastQuoteMs = gap between fast ticks (0 = disabled). predictFullCycleMs = how often a full
  // discovery/rotation cycle runs between fast ticks.
  predictFastQuoteMs: z.number().nonnegative().default(0),
  predictFullCycleMs: z.number().nonnegative().default(0),
  // Predict competition-density gate (0 = disabled). When set (e.g. 250): if the reward-band qualifying depth (USD)
  // exceeds orderSizeUsd × this multiplier, the market is flagged as too crowded and rendered ineligible.
  // Matches the predict-report "crowded" threshold logic.
  predictCrowdedThreshold: z.number().nonnegative().default(0),
 // Treat Polymarket cash maker BUYs as UNRESERVED (like Predict): don't pre-deduct each resting order's notional from
  // spendable balance, so total resting notional can exceed the wallet balance (the "挂单不锁金额" farming model). Only
  // safe if Polymarket's CLOB itself does not hard-cap cumulative open-order notional at balance — verify empirically
  // before relying on it. Default false (conservative: each order reserves its notional, total ≤ balance).
  polymarketUnreservedMaker: z.boolean().default(false),
  // Network dead-man switch: place Polymarket orders as GTD (good-till-date) with this expiry (seconds), so if the bot
  // or network dies the venue auto-cancels them within the window (a dead bot can't send cancels). The bot refreshes
  // each order well before expiry, so during normal operation orders never lapse. 0 = GTC (no auto-expiry). Polymarket
 // requires expiry ≥ ~60s; values 1-59 are lifted to 60. Recommended 90-180 for farming.
 polymarketOrderTtlSec: z.number().int().nonnegative().default(0),
  // Predict (predict.fun): GTD dead-man switch expiry in seconds — same concept as polymarketOrderTtlSec but for
  // Predict REST API. Predict itself does NOT support server-side GTD, so this is only a virtual timer the bot
  // uses to refresh orders (cancel + re-place) to keep them near expiration during normal operation. Set to 0 to
  // disable the virtual GTD refresh entirely for Predict (recommended: Predict orders rest indefinitely on the
  // book and are only replaced by the price-drift / reward-band logic). 0 = no virtual GTD refresh.
  predictOrderTtlSec: z.number().int().nonnegative().default(0),
  // Polymarket-only exit-liquidity cooldown (OPT-IN): after exitLiquidityCooldownStrikes exit-liquidity cancels
  // within exitLiquidityCooldownWindowMs, the order-gate skips that token for exitLiquidityCooldownMs to avoid
  // cancel-replace churn on thin books. Left OPTIONAL (no default) so it stays OFF for Predict / any venue that
  // does not set it — enable it only in polymarketParams.strategy. Undefined => feature off.
  exitLiquidityCooldownStrikes: z.number().int().min(1).optional(),
  exitLiquidityCooldownWindowMs: z.number().int().min(30000).optional(),
  exitLiquidityCooldownMs: z.number().int().min(60000).optional(),
 // Polymarket-independent strategy params (separate from Predict): market-switch margin (%) and per-token
 // exposure cap (USD; 0 = fall back to risk.maxPositionUsd). Changing these never affects Predict.
 polymarketSwitchThresholdPct: z.number().nonnegative().default(20),
  polymarketMaxPositionUsd: z.number().nonnegative().default(0),
  // Polymarket SMALL-LIVE TEST MODE: relax the reward-admission gates (min_shares, $1/day payout threshold,
  // volatility exclusion, front-depth floor) so a tiny two-sided order can validate the place/retreat/exit
  // plumbing WITHOUT earning rewards. Predict is never affected. Turn off for real reward farming.
  polymarketTestMode: z.boolean().default(false),
  // How this venue fetches orderbooks (each venue has its own copy in its own block). Default true = subscribe
  // the markets being scanned to one persistent WebSocket and read books from the push cache (no per-market REST
  // cost), so the number of markets you quote scales with maxMarkets instead of being capped by the REST
  // throttle. Market selection, switching, depth and placement are unchanged — only the data source changes; if
  // a WS book is not fresh it falls back to REST automatically. Set false to force the old REST-only fetch.
  wsWatchAll: z.boolean().default(true)
}).default({});

const predictVenueSchema = z.object({
  enabled: z.boolean().default(true),
  liveEnabled: z.boolean().optional(),
  apiBaseUrl: z.string().url().default('https://api.predict.fun'),
  wsUrl: z.string().url().default('wss://ws.predict.fun/ws'),
  rpcUrl: z.string().url().default('https://bsc-dataseed.binance.org'),
  chainId: z.number().int().positive().default(56),
  apiKey: z.string().default(''),
  accountAddress: z.string().default('')
}).default({});

const polymarketVenueSchema = z.object({
  enabled: z.boolean().default(true),
  liveEnabled: z.boolean().optional(),
  gammaUrl: z.string().url().default('https://gamma-api.polymarket.com'),
  clobUrl: z.string().url().default('https://clob.polymarket.com'),
  // Account data (positions / trades / portfolio value) live on the Polymarket data API,
  // NOT on the gamma metadata host. Used by the account-risk snapshot and the kill switch.
  dataApiUrl: z.string().url().default('https://data-api.polymarket.com'),
  rpcUrl: z.string().url().default('https://polygon-bor-rpc.publicnode.com'),
  chainId: z.number().int().positive().default(137),
  funderAddress: z.string().default(''),
  signatureType: z.number().int().min(0).max(3).default(0),
  autoDeriveApiKey: z.boolean().default(true),
  wsUrl: z.string().url().default('wss://ws-subscriptions-clob.polymarket.com/ws/market'),
  // Stream the active market's order book over the CLOB market channel instead of REST polling.
  // Off by default; enable only after validating the stream in your own environment (REST is the fallback).
  useWsOrderbook: z.boolean().default(false)
}).default({});

export const appConfigSchema = z.object({
  dataDir: z.string().min(1).default('.safe-mm'),
  liveEnabled: z.boolean().default(false),
  endpointPolicy: endpointPolicySchema,
  risk: riskSchema,
  strategy: strategySchema,
  venues: z.object({
    predict: predictVenueSchema,
    polymarket: polymarketVenueSchema
  }).default({}),
  selectedMarkets: z.object({
    predict: z.array(z.string()).default([]),
    polymarket: z.array(z.string()).default([])
  }).default({}),
  // Polymarket's FULLY INDEPENDENT risk + strategy parameters — a complete separate copy with ZERO fallback to
  // the top-level risk/strategy (which belong to Predict). resolveVenueConfig() swaps these in for Polymarket,
  // so every single parameter is each venue's own and editing one venue never leaks into the other. Optional in
  // the YAML; load.ts synthesizes it from the base config on first load so existing behaviour is preserved.
  polymarketParams: z.object({
    risk: riskSchema,
    strategy: strategySchema
  }).optional()
  ,
  // Predict's independent risk + strategy parameters (same pattern as polymarketParams). When present,
  // resolveVenueConfig() uses this block for Predict. When absent, Predict falls back to the top-level
  // risk/strategy (backward-compatible). Optional; load.ts synthesizes it from the base config on first load.
  predictParams: z.object({
    risk: riskSchema,
    strategy: strategySchema
  }).optional()
});

export type AppConfig = z.infer<typeof appConfigSchema>;
export type VenueParams = { risk: AppConfig['risk']; strategy: AppConfig['strategy'] };

export function normalizeLiveStrategyConfig(config: AppConfig): AppConfig {
  const splitMode = config.strategy.entryMode === 'split';
  const strictCashPoints = config.strategy.entryMode === 'cash' && config.strategy.pointsOnly;
  return {
    ...config,
    strategy: {
      ...config.strategy,
      ...(splitMode ? { quoteSide: 'both' as const, dualSide: true } : {}),
      ...(strictCashPoints ? { enforceRewardMinimum: true } : {}),
      onFillAction: 'hold'
    }
  };
}

const FORBIDDEN_SECRET_KEYS = new Set([
  'privatekey',
  'private_key',
  'polymarket_private_key',
  'predict_private_key',
  'mnemonic',
  'seedphrase',
  'seed_phrase'
]);

export function assertNoRawSecrets(value: unknown, path: string[] = []): void {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.replace(/[-\s]/g, '').toLowerCase();
    if (FORBIDDEN_SECRET_KEYS.has(normalized)) {
      throw new Error(`Raw secret key "${[...path, key].join('.')}" is not allowed in config; use mm wallet import.`);
    }
    assertNoRawSecrets(child, [...path, key]);
  }
}

export const DEFAULT_ALLOWED_ENDPOINTS = new Set([
  'https://api.predict.fun',
  'wss://ws.predict.fun',
  // BSC RPC (Predict) — primary + verified free/no-key fallbacks
  'https://bsc-dataseed.binance.org',
  'https://bsc-dataseed.bnbchain.org',
  'https://bsc-rpc.publicnode.com',
  'https://1rpc.io',
  'https://gamma-api.polymarket.com',
  'https://clob.polymarket.com',
  'https://data-api.polymarket.com',
  // Polygon RPC (Polymarket) — primary + verified free/no-key fallbacks
  'https://polygon-bor-rpc.publicnode.com',
  'https://polygon.drpc.org',
  'wss://ws-subscriptions-clob.polymarket.com'
]);

export function assertEndpointAllowed(url: string, config: AppConfig): void {
  if (config.endpointPolicy.allowCustom) return;
  const normalized = new URL(url).origin;
  const allowed = new Set([...DEFAULT_ALLOWED_ENDPOINTS, ...config.endpointPolicy.extraAllowedHosts]);
  if (!allowed.has(normalized)) {
    throw new Error(`Endpoint ${normalized} is not allowed. Set endpointPolicy.allowCustom=true only after reviewing the risk.`);
  }
}
