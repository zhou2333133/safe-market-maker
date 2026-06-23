import type { AppConfig } from '../../config/schema.js';
import type { Market, OpenOrder, OrderSide, Orderbook, OrderbookLevel, Position, VenueName } from '../../domain/types.js';
import { bestBidAsk, inferRewardLevel } from '../../venues/normalize.js';
import type { RewardMarketAssessment, RewardQuotePlan, RewardReplaceDecision, VenueRewardOptimizer } from './types.js';

const CASH_BUY_OVERSIZE_TOLERANCE_USD = 0.25;
const CASH_BUY_OVERSIZE_TOLERANCE_PCT = 0.05;
const CASH_BUY_MAINTENANCE_DEPTH_FLOOR_PCT = 0.8;
// Polymarket follows the user's polymarketStartLevel knob: startLevel=2 needs 1 level in front
// (level 1 = the top), startLevel=3 needs 2, etc. Predict keeps the legacy floor of 3.
function cashMinFrontLevels(config: AppConfig, market?: Market): number {
  if (market?.venue === 'polymarket') {
    const startLevel = Math.max(1, Math.trunc(config.strategy.polymarketStartLevel ?? 2));
    return Math.max(1, startLevel - 1);
  }
  return 3;
}
// Polymarket's hard per-order size floor (shares). An order below this is rejected outright by the exchange
// ("Size (1.23) lower than the minimum: 5"), independent of the much larger reward min_shares.
const POLYMARKET_MIN_ORDER_SHARES = 5;

type ProtectedRewardLevel = OrderbookLevel & {
  protectedPrice: number;
  protectedDepthLevel?: number;
};

export interface BaseOptimizerOptions {
  venue: VenueName;
  name: string;
  marketLabel: string;
  dailyRateWeight: number;
  boostWeight: number;
  liquidityWeight: number;
  volumeWeight: number;
  spreadRiskWeight: number;
}

export abstract class BaseRewardOptimizer implements VenueRewardOptimizer {
  readonly venue: VenueName;

  protected constructor(
    protected readonly config: AppConfig,
    protected readonly options: BaseOptimizerOptions
  ) {
    this.venue = options.venue;
  }

  marketKey(market: Market): string {
    return market.conditionId || market.marketId || market.eventId || market.tokenId;
  }

  assessMarket(market: Market, book?: Orderbook): RewardMarketAssessment {
    const reasons: string[] = [];
    const riskFlags: string[] = [];
    const level = rewardLevel(market);
    const rewards = market.rewards;

    if (!rewards?.enabled) riskFlags.push('无积分/奖励规则');
    else {
      reasons.push(`${this.options.marketLabel}奖励规则已开启`);
      if (level > 0) reasons.push(`LP 奖励 ${level}级`);
      if (market.boosted) reasons.push('Boost 高奖励进行中');
      if (rewards.minShares) reasons.push(`最低奖励份额 ${formatNumber(rewards.minShares)} 份`);
      if (rewards.maxSpreadCents) reasons.push(`奖励允许价差 ${formatNumber(rewards.maxSpreadCents)}c`);
      if (rewards.ppPerHour) reasons.push(`官方当前 PP ${formatNumber(rewards.ppPerHour)}/hr`);
      if (rewards.dailyRate) reasons.push(`预计日奖励 ${formatNumber(rewards.dailyRate)}`);
    }

    if (this.config.strategy.pointsOnly && !rewards?.enabled) riskFlags.push('已开启只做积分市场');
    if (this.config.strategy.pointsOnly && rewards?.enabled && !validRewardSpreadCents(rewards.maxSpreadCents)) {
      riskFlags.push('官方奖励价差缺失，不能验证 PP 有效挂单范围');
    }
    if (this.config.strategy.acceptingOnly && !market.acceptingOrders) riskFlags.push('市场暂不接受订单');
    const minRewardLevel = this.config.strategy.minRewardLevel ?? 0;
    if (minRewardLevel > 0 && level < minRewardLevel) riskFlags.push(`LP 奖励低于 ${minRewardLevel}级`);
    // Predict markets do not have a reliable metadataPriceUsd — the API default is 0.5 for every
    // market, which produces impossible minNotional estimates (always $50.50 for 101 shares) and
    // causes every market to appear unaffordable. When the live orderbook is missing we must not
    // fall back to this fake default; instead skip the pre-book affordability estimates and defer to
    // rewardSizedOrder() which runs later with actual orderbook prices.
    const mid = bookMid(book) ?? (market.venue === 'predict' ? undefined : 0.5);
   const minRewardShares = rewardTargetShares(this.config, rewards?.minShares);
   const minRewardNotional = (minRewardShares && mid !== undefined) ? minRewardShares * mid : undefined;
    if (minRewardNotional !== undefined) {
      if (minRewardNotional > this.config.risk.maxSingleOrderUsd) {
        reasons.push(`奖励最低份额约需 ${formatUsd(minRewardNotional)}，当前单笔上限可能挡单`);
      }
      if (minRewardNotional > this.config.risk.maxPositionUsd) {
        reasons.push(`奖励最低份额约需 ${formatUsd(minRewardNotional)}，当前持仓上限可能挡单`);
      }
    }
    // Polymarket + Predict affordability (the soft min-size rule): a market only pays if your single order can meet
    // its reward min-size AT THIS TOKEN'S PRICE. Estimate with the live book mid when present. Polymarket falls
    // back to metadataPriceUsd; Predict skips the fallback because Predict's metadataPriceUsd is always 0.5 (fake).
    if (shouldEnforceRewardMinimum(this.config, market) && minRewardShares !== undefined && minRewardShares > 0 && market.venue !== 'polymarket') {
      // Predict pre-book affordability: only flag when we HAVE a real orderbook mid price.
      // Without a book the estimate is unreliable (metadataPriceUsd is always 0.5), so defer
      // to the live-book check in rewardSizedOrder() during buildQuote. This prevents
     // every Predict market from being wrongly marked unaffordable on startup.
      if (mid !== undefined) {
        const orderUsd = Math.max(0, this.config.risk.orderSizeUsd);
        // Estimate at the BUY-side price (the order rests at/near the best bid, below mid). Using mid overstates the
        // cost and false-rejects boundary orders that the precise rewardSizedOrder() sizing would actually accept.
        const minNotional = minRewardShares * ((book ? bestBidAsk(book).bestBid : undefined) ?? mid);
        if (orderUsd > 0 && orderUsd + 1e-9 < minNotional) {
          riskFlags.push(`单笔 ${formatUsd(orderUsd)} 不足该市场最低有效份额(按当前盘口中位价约需 ${formatUsd(minNotional)})`);
        }
      }
   }
    if (shouldEnforceRewardMinimum(this.config, market) && market.venue === 'polymarket' && minRewardShares !== undefined && minRewardShares > 0) {
     const orderUsd = Math.max(0, this.config.risk.orderSizeUsd);
     const estimatedPrice = (book ? (bestBidAsk(book).bestBid ?? bookMid(book)) : undefined) ?? market.metadataPriceUsd;
      const estimatedLegPrice = Math.max(0.10, estimatedPrice ?? 0.10);
      const minSizeUsd = minRewardShares * estimatedLegPrice;
      if (orderUsd > 0 && orderUsd + 1e-9 < minSizeUsd) {
        riskFlags.push(`单笔 ${formatUsd(orderUsd)} 不足该市场最低有效份额(按当前价约需 ${formatUsd(minSizeUsd)})`);
      }
    }
    // Metadata-stage price band: a token whose metadata price already sits at/outside the safe band (e.g. 0.03 — the
    // live guard will block it on mid anyway) should not spend a scan/audit slot. Book-backed assessments use the
    // live mid via the market guard instead, so this only fires pre-book.
    if (!book && market.metadataPriceUsd !== undefined
      && (market.metadataPriceUsd <= this.config.risk.minPrice || market.metadataPriceUsd >= this.config.risk.maxPrice)) {
      riskFlags.push(`元数据价 ${market.metadataPriceUsd.toFixed(3)} 超出安全价带 ${this.config.risk.minPrice}-${this.config.risk.maxPrice}`);
    }

    let qualifyingDepthUsd = 0;
    if (book) {
      const bbo = bestBidAsk(book);
      if (bbo.bestBid === undefined || bbo.bestAsk === undefined || bbo.mid === undefined || bbo.spread === undefined) {
        riskFlags.push('盘口缺少 BBO');
      } else {
        qualifyingDepthUsd = qualifyingDepth(book, rewards?.maxSpreadCents);
        reasons.push(`奖励带内深度 ${formatUsd(qualifyingDepthUsd)}`);
      }
    }
    if (market.liquidityUsd < this.config.strategy.minMarketLiquidityUsd) {
      const liveDepthCoversLiquidityFloor = book !== undefined && qualifyingDepthUsd >= this.config.strategy.minMarketLiquidityUsd;
      if (this.config.strategy.entryMode === 'cash' && this.config.strategy.pointsOnly && rewards?.enabled) {
        reasons.push(`现金积分模式忽略市场总流动性元数据下限，改用实时奖励带深度排序`);
      } else if (liveDepthCoversLiquidityFloor) {
        reasons.push(`市场总流动性元数据偏低，但实时奖励带深度 ${formatUsd(qualifyingDepthUsd)} 已覆盖流动性下限`);
      } else {
        riskFlags.push(`市场总流动性低于 ${this.config.strategy.minMarketLiquidityUsd} USD`);
      }
    }

    const liquidityScore = Math.log10(market.liquidityUsd + 1) * this.options.liquidityWeight;
    const volumeScore = Math.log10(market.volume24hUsd + 1) * this.options.volumeWeight;
    const rewardScore = rewards?.enabled ? 45 + level * 18 : 0;
    const boostScore = market.boosted ? this.options.boostWeight : 0;
    const ppPerHourScore = rewards?.ppPerHour ? Math.min(160, Math.log10(rewards.ppPerHour + 1) * 34) : 0;
    const dailyRateScore = rewards?.dailyRate ? Math.min(60, Math.log10(rewards.dailyRate + 1) * this.options.dailyRateWeight) : 0;
    const depthScore = Math.min(35, Math.log10(qualifyingDepthUsd + 1) * 8);
    const spreadPenalty = book ? orderbookSpreadPenalty(book, this.options.spreadRiskWeight) : 0;
    const riskPenalty = riskFlags.length * 35;
    const score = Math.max(0, liquidityScore + volumeScore + rewardScore + boostScore + ppPerHourScore + dailyRateScore + depthScore - spreadPenalty - riskPenalty);

    reasons.push(`市场总流动性 ${formatUsd(market.liquidityUsd)}`, `24h 成交量 ${formatUsd(market.volume24hUsd)}`);
    this.addVenueReasons(market, reasons, riskFlags, qualifyingDepthUsd);

    return {
      venue: this.venue,
      optimizer: this.options.name,
      eligible: riskFlags.length === 0,
      score,
      reasons,
      riskFlags,
      rewardLevel: level,
      marketKey: this.marketKey(market),
      ...(minRewardNotional !== undefined ? { estimatedMinRewardNotionalUsd: Number(minRewardNotional.toFixed(4)) } : {}),
      ...(qualifyingDepthUsd > 0 ? { qualifyingDepthUsd: Number(qualifyingDepthUsd.toFixed(4)) } : {})
    };
  }

  buildQuote(market: Market, book: Orderbook, side: OrderSide, context: { config: AppConfig; positions: Position[] }): RewardQuotePlan | undefined {
    if (!this.assessMarket(market, book).eligible) return undefined;
    const level = this.depthLevel();
    const tick = effectiveOrderbookTick(market, book);
    const cashProbe = cashProbeProtectionEnabled(this.config, side, market);
    const protectedLevel = shouldProtectRewardQuote(this.config, side)
      ? protectedRewardLevel(this.config, market, book, side, level)
      : undefined;
    if (cashProbe && !protectedLevel) return undefined;
    const rawLevel = protectedLevel
      ?? (side === 'BUY'
          ? book.bids[Math.max(0, level - 1)] ?? book.bids.at(-1) ?? book.bids[0]
          : book.asks[Math.max(0, level - 1)] ?? book.asks.at(-1) ?? book.asks[0]);
    if (!rawLevel) return undefined;

    const initial = protectedLevel?.protectedPrice ?? (side === 'BUY'
      ? rawLevel.price - tick * this.config.strategy.retreatTicks
      : rawLevel.price + tick * this.config.strategy.retreatTicks);
    let price = this.fitRewardBand(side, initial, tick, market.rewards?.maxSpreadCents, book);
    if (price === undefined) return undefined;
    // Lift a too-low BUY up to minPrice: on cheap legs the configured depth level can land below minPrice (= below
    // the 0.10 reward earn floor — zero reward AND a guaranteed order-level risk reject). The lifted price must still
    // be post-only (below best ask); front-depth protection re-validates at the lifted price below. SELL quotes keep
    // the old behaviour (outside-band SELLs stay unquotable rather than being repriced more aggressively).
    if (side === 'BUY' && price < this.config.risk.minPrice) {
      const bbo = bestBidAsk(book);
      price = roundToTick(this.config.risk.minPrice, tick, 'BUY');
      if (bbo.bestAsk === undefined || price >= bbo.bestAsk) return undefined;
    }
    if (!isWithinRewardBand(side, price, book, market.rewards?.maxSpreadCents)) return undefined;
    if (shouldProtectRewardQuote(this.config, side) && !rewardQuoteProtection(this.config, side, price, book, market).ok) {
      return undefined;
    }

    const sizePlan = rewardSizedOrder(this.config, price, market.rewards?.minShares, market);
    if (!sizePlan) return undefined;
    const minRewardShares = rewardTargetShares(this.config, market.rewards?.minShares);
    if (this.shouldSkipForInventory(market, side, context.positions)) return undefined;
    if (this.shouldSkipSellWithoutInventory(market, side, context.positions, sizePlan.size)) return undefined;
    const assessment = this.assessMarket(market, book);
    const reasonLevel = protectedLevel?.protectedDepthLevel ?? level;
    return {
      ...sizePlan,
      price,
      reason: `${this.options.name}-${side === 'BUY' ? 'bid' : 'ask'}-level-${reasonLevel}`,
      rewardScore: Number(assessment.score.toFixed(2)),
      rewardLevel: assessment.rewardLevel,
      ...(minRewardShares !== undefined ? { minRewardShares } : {}),
      ...(market.rewards?.maxSpreadCents ? { maxRewardSpreadCents: market.rewards.maxSpreadCents } : {})
    };
  }

  shouldReplaceOrder(order: OpenOrder, desired: RewardQuotePlan, market: Market, book: Orderbook): RewardReplaceDecision {
    const tick = effectiveOrderbookTick(market, book);
    const thresholdTicks = this.config.strategy.replaceThresholdTicks ?? 1;
    const priceDeltaTicks = Math.abs(order.price - desired.price) / tick;
    const cashBuy = isCashBuyMaintenanceOrder(this.config, order, market);
    let cashBuyMaintenanceProtectionReason: string | undefined;
    if (!isWithinRewardBand(order.side, order.price, book, market.rewards?.maxSpreadCents)) {
      return { replace: true, reason: '现有订单已不在奖励价差范围内' };
    }
    if (shouldProtectRewardQuote(this.config, order.side)) {
      const protection = rewardQuoteProtection(this.config, order.side, order.price, book, market);
      if (!protection.ok) {
        if (cashBuy && canKeepCashBuyWithMaintenanceProtection(protection)) {
          cashBuyMaintenanceProtectionReason = `现金单边 BUY 保护深度处于维护容忍区：${protection.reason}`;
        } else {
          return { replace: true, reason: protection.reason };
        }
      }
    }
    if (cashBuy && order.price < desired.price - tick * thresholdTicks - 1e-9) {
      return { replace: false, reason: '现金单边 BUY 旧单价格更低且仍安全，不为追价撤换' };
    }
   if (cashBuy && order.price > desired.price + tick * thresholdTicks + 1e-9) {
      // Predict: suppressing price-drift replace. The resting order's price may drift slightly above
      // the ideal target as the BBO moves, but if it's still within the reward spread band and the
      // protection depth check (above) passed, replacing it would just forfeit queue position for the
      // same outcome. Polymarket keeps this check because its order fills are actual market events;
      // Predict orders almost never fill — the primary goal is staying safe and earning points.
      if (market.venue === 'predict') {
        return { replace: false, reason: 'Predict 现金单边 BUY 价格略高目标但保护深度和奖励范围通过，保留现有订单避免换单失去队列位置' };
      }
     return { replace: true, reason: `现金单边 BUY 价格高于当前安全目标 ${priceDeltaTicks.toFixed(1)} tick` };
    }
    if (!cashBuy && priceDeltaTicks > thresholdTicks + 1e-6) {
      return { replace: true, reason: `目标价移动 ${priceDeltaTicks.toFixed(1)} tick` };
    }
    const sizeDelta = Math.abs(order.size - desired.size);
    // Polymarket floors order size to its amount precision (e.g. target 5.7471 rests as 5.74), so the resting size
    // can never exactly equal the strategy's unrounded target. Absorb one size-rounding step (~0.01 shares) for
    // Polymarket to stop perpetual cancel/replace churn. Predict is unchanged (byte-identical tolerance).
    const sizeTolerance = this.venue === 'polymarket'
      ? Math.max(0.02, desired.size * 0.002)
      : Math.max(0.0001, desired.size * 0.001);
    if (!cashBuy && sizeDelta > sizeTolerance) {
      return { replace: true, reason: `现有订单数量 ${formatNumber(order.size)} 与当前目标 ${formatNumber(desired.size)} 不一致` };
    }
    if (shouldEnforceRewardMinimum(this.config, market) && desired.minRewardShares && order.size + 1e-9 < desired.minRewardShares) {
      return { replace: true, reason: '现有订单数量低于奖励最低份额' };
    }
    const orderNotional = order.price * order.size;
    const desiredCap = Math.max(desired.notionalUsd, this.config.risk.orderSizeUsd);
    const overSizeTolerance = cashBuy
      ? Math.max(CASH_BUY_OVERSIZE_TOLERANCE_USD, desiredCap * CASH_BUY_OVERSIZE_TOLERANCE_PCT)
      : 0.01;
    if (!(this.config.strategy.enforceRewardMinimum ?? true) && orderNotional > desiredCap + overSizeTolerance) {
      return { replace: true, reason: `现有订单金额 ${formatUsd(orderNotional)} 超过当前目标金额 ${formatUsd(desiredCap)}` };
    }
    return { replace: false, reason: cashBuyMaintenanceProtectionReason ?? '现有订单仍符合奖励目标' };
  }

  protected addVenueReasons(_market: Market, _reasons: string[], _riskFlags: string[], _qualifyingDepthUsd?: number): void {
    return undefined;
  }

  private depthLevel(): number {
    // Polymarket reward LP places behind the front at a configurable starting level (default 2nd), single-sided.
    if (this.venue === 'polymarket') {
      return Math.max(1, this.config.strategy.polymarketStartLevel ?? 2);
    }
    return this.config.strategy.tradingMode === 'aggressive'
      ? this.config.strategy.aggressiveDepthLevel
      : this.config.strategy.conservativeDepthLevel;
  }

  private shouldSkipForInventory(market: Market, side: OrderSide, positions: Position[]): boolean {
    if (!this.config.strategy.inventorySkewEnabled) return false;
    if (side !== 'BUY') return false;
    const maxSkew = this.config.strategy.maxInventorySkewUsd ?? this.config.risk.maxPositionUsd;
    const exposure = positions
      .filter((position) => position.tokenId === market.tokenId)
      .reduce((sum, position) => sum + Math.abs(position.notionalUsd), 0);
    return exposure >= maxSkew;
  }

  private shouldSkipSellWithoutInventory(market: Market, side: OrderSide, positions: Position[], desiredSize: number): boolean {
    if (side !== 'SELL') return false;
    if (this.config.strategy.entryMode === 'split') return false;
    const heldShares = positions
      .filter((position) => position.tokenId === market.tokenId)
      .reduce((sum, position) => sum + Math.max(0, position.size), 0);
    return heldShares + 1e-9 < desiredSize;
  }

  private fitRewardBand(side: OrderSide, rawPrice: number, tick: number, maxSpreadCents: number | undefined, book: Orderbook): number | undefined {
    const bbo = bestBidAsk(book);
    if (bbo.bestBid === undefined || bbo.bestAsk === undefined) return undefined;
    let price = rawPrice;
    if (maxSpreadCents) {
      const maxDistance = maxSpreadCents / 100;
      if (side === 'BUY') price = Math.max(price, bbo.bestAsk - maxDistance);
      else price = Math.min(price, bbo.bestBid + maxDistance);
    }
    const rounded = side === 'BUY' ? roundToTick(price, tick, 'BUY') : roundToTick(price, tick, 'SELL');
    const clamped = clampPrice(rounded, tick);
    if (side === 'BUY' && clamped >= bbo.bestAsk) return undefined;
    if (side === 'SELL' && clamped <= bbo.bestBid) return undefined;
    return clamped;
  }
}

export function rewardLevel(market: Market): number {
  return market.rewards?.level ?? inferRewardLevel(market.rewards?.minShares, market.rewards?.maxSpreadCents) ?? 0;
}

export function roundToTick(price: number, tick: number, side: OrderSide): number {
  const steps = side === 'BUY' ? Math.floor(price / tick + 1e-9) : Math.ceil(price / tick - 1e-9);
  return Number((steps * tick).toFixed(6));
}

export function effectiveOrderbookTick(market: Pick<Market, 'tickSize'>, book: Pick<Orderbook, 'bids' | 'asks'>): number {
  const marketTick = normalizeTickCandidate(market.tickSize) ?? 0.01;
  const inferred = inferTickFromBook(book);
  if (inferred === undefined) return marketTick;
  return Math.min(marketTick, inferred);
}

export function clampPrice(price: number, tick: number): number {
  return Math.min(1 - tick, Math.max(tick, Number(price.toFixed(6))));
}

export function isWithinRewardBand(side: OrderSide, price: number, book: Orderbook, maxSpreadCents?: number): boolean {
  if (!maxSpreadCents) return true;
  const bbo = bestBidAsk(book);
  if (bbo.bestBid === undefined || bbo.bestAsk === undefined) return false;
  const distance = side === 'BUY' ? bbo.bestAsk - price : price - bbo.bestBid;
  return distance >= -1e-9 && distance * 100 <= maxSpreadCents + 1e-9;
}

export function rewardDistanceCents(side: OrderSide, price: number, book: Orderbook): number | undefined {
  const bbo = bestBidAsk(book);
  if (bbo.bestBid === undefined || bbo.bestAsk === undefined) return undefined;
  const distance = side === 'BUY' ? bbo.bestAsk - price : price - bbo.bestBid;
  return Number((distance * 100).toFixed(4));
}

/**
 * Notional ($) of resting orders strictly AHEAD of a maker order at `price` — for a BUY the bids priced above it, for a
 * SELL the asks priced below it. This is the "front cushion" a taker must sweep before reaching our order, i.e. the
 * exact depth `rewardQuoteProtection` validates at placement (its depthUsd). Reused by the runtime fast-retreat
 * re-check so placement and retreat measure protection identically.
 */
export function frontProtectionDepthUsd(book: Orderbook, side: OrderSide, price: number): number {
  const levels = side === 'SELL'
    ? aggregateOrderbookLevels(book.asks, 'asks').filter((level) => level.price < price - 1e-9)
    : aggregateOrderbookLevels(book.bids, 'bids').filter((level) => level.price > price + 1e-9);
  return Number(levels.reduce((sum, level) => sum + level.price * level.size, 0).toFixed(4));
}

export function rewardQuoteProtection(config: AppConfig, side: OrderSide, price: number, book: Orderbook, market?: Market): { ok: boolean; reason: string; depthUsd: number; minDepthUsd: number; supportGapCents?: number } {
  const bbo = bestBidAsk(book);
  const minDepthUsd = minQuoteProtectionUsd(config, side, price, market);
  const bids = aggregateOrderbookLevels(book.bids, 'bids');
  const asks = aggregateOrderbookLevels(book.asks, 'asks');
  if (bbo.bestBid === undefined || bbo.bestAsk === undefined) {
    return { ok: false, reason: '盘口缺少 BBO，无法判断挂单保护深度', depthUsd: 0, minDepthUsd };
  }
  const depthUsd = side === 'SELL'
    ? asks
      .filter((level) => level.price < price - 1e-9)
      .reduce((sum, level) => sum + level.price * level.size, 0)
    : bids
      .filter((level) => level.price > price + 1e-9)
      .reduce((sum, level) => sum + level.price * level.size, 0);
  if (depthUsd + 1e-9 < minDepthUsd) {
    return {
      ok: false,
      reason: `前方保护深度 ${formatUsd(depthUsd)} 低于要求 ${formatUsd(minDepthUsd)}`,
      depthUsd: Number(depthUsd.toFixed(4)),
      minDepthUsd
    };
  }
  const cashProbe = cashProbeProtectionEnabled(config, side, market);
  if (cashProbe) {
    if ((config.strategy.cashProbeNeverTopOfBook ?? true) && price >= bbo.bestBid - 1e-9) {
      return {
        ok: false,
        reason: '现金单边测试单禁止挂到买一/第一档位置',
        depthUsd: Number(depthUsd.toFixed(4)),
        minDepthUsd
      };
    }
    const support = nearestSupportLevel({ bids, asks }, side, price);
    const front = nearestFrontLevel({ bids, asks }, side, price);
    if (!support || !front) {
      return {
        ok: false,
        reason: '现金单边测试单缺少前方挂单或下方支撑档位',
        depthUsd: Number(depthUsd.toFixed(4)),
        minDepthUsd
      };
    }
    const supportGapCents = side === 'BUY'
      ? (front.price - support.price) * 100
      : (support.price - front.price) * 100;
    // Gap is now measured in TICK multiples (adaptive to the venue's tick), not absolute cents.
    const gapTick = market ? effectiveOrderbookTick(market, book) : effectiveOrderbookTick({ tickSize: 0.01 }, book);
    const supportGapTicks = gapTick > 0 ? Math.abs(front.price - support.price) / gapTick : Number.POSITIVE_INFINITY;
    const maxGapTicks = config.strategy.cashProbeMaxSupportGapTicks ?? 10;
    const frontLevels = side === 'BUY'
      ? bids.filter((level) => level.price > price + 1e-9).length
      : asks.filter((level) => level.price < price - 1e-9).length;
    const requiredFrontLevels = cashMinFrontLevels(config, market);
    if (frontLevels < requiredFrontLevels) {
      return {
        ok: false,
        reason: `现金单边测试单前方只有 ${frontLevels} 档保护，低于要求 ${requiredFrontLevels} 档`,
        depthUsd: Number(depthUsd.toFixed(4)),
        minDepthUsd
      };
    }
    if (supportGapTicks > maxGapTicks + 1e-9) {
      return {
        ok: false,
        reason: `现金单边测试单前方档位到支撑档位价差 ${supportGapTicks.toFixed(1)} 跳 超过 ${maxGapTicks} 跳`,
        depthUsd: Number(depthUsd.toFixed(4)),
        minDepthUsd,
        supportGapCents: Number(supportGapCents.toFixed(4))
      };
    }
    if (side === 'BUY') {
      // Exit liquidity (rear support) — user's core rule #3: "support depth in the 1¢ window directly below my
      // placement must cover my order size." Two equivalent modes:
      //  (a) CENT-based window via cashSupportWindowCents (preferred, venue-independent): bids within X¢
      //      below placement must cover order size.
      //  (b) TICK-based window via cashRequireExitLiquidity + cashExitLiquidityMaxTicks (legacy): bids within
      //      N ticks below placement must cover order size.
      // Either mode can trigger rejection; both compute the same kind of "can I sell within close range?"
      const cents = Math.max(0, config.strategy.cashSupportWindowCents ?? 0);
      const tickGateOn = config.strategy.cashRequireExitLiquidity ?? false;
      if (cents > 0 || tickGateOn) {
        const exitTick = market ? effectiveOrderbookTick(market, book) : effectiveOrderbookTick({ tickSize: 0.01 }, book);
        const maxExitTicks = Math.max(1, config.strategy.cashExitLiquidityMaxTicks ?? 2);
        const tickFloor = tickGateOn ? price - maxExitTicks * exitTick : -Infinity;
        const centFloor = cents > 0 ? price - cents / 100 : -Infinity;
        const exitFloor = Math.max(tickFloor, centFloor);
        const exitDepthUsd = bids
          .filter((level) => level.price < price - 1e-9 && level.price >= exitFloor - 1e-9)
          .reduce((sum, level) => sum + level.price * level.size, 0);
        const requiredExitUsd = Math.max(0, config.risk.orderSizeUsd);
        if (exitDepthUsd + 1e-9 < requiredExitUsd) {
          const windowLabel = cents > 0 ? `${cents}¢ 窗口` : `${maxExitTicks} 跳`;
          return {
            ok: false,
            reason: `后方退出流动性 ${formatUsd(exitDepthUsd)}(仅近 ${windowLabel}内)不足以吃下挂单 ${formatUsd(requiredExitUsd)}(被吃会卡成单腿)`,
            depthUsd: Number(depthUsd.toFixed(4)),
            minDepthUsd,
            supportGapCents: Number(supportGapCents.toFixed(4))
          };
        }
      }
    }
    return { ok: true, reason: '现金单边测试单前方保护深度、后方退出流动性和支撑价差通过', depthUsd: Number(depthUsd.toFixed(4)), minDepthUsd };
  }
  const tick = effectiveOrderbookTick({ tickSize: 0.01 }, book);
  const minDistanceTicks = minQuoteProtectionTicks(config);
  const minDistance = tick * minDistanceTicks;
  if (side === 'SELL' && price <= bbo.bestBid + minDistance + 1e-9) {
    return {
      ok: false,
      reason: `SELL 挂单距离买一不足 ${minDistanceTicks} tick，容易被吃单`,
      depthUsd: Number(depthUsd.toFixed(4)),
      minDepthUsd
    };
  }
  if (side === 'BUY' && price >= bbo.bestAsk - minDistance - 1e-9) {
    return {
      ok: false,
      reason: `BUY 挂单距离卖一不足 ${minDistanceTicks} tick，容易被吃单`,
      depthUsd: Number(depthUsd.toFixed(4)),
      minDepthUsd
    };
  }
  return { ok: true, reason: '前方保护深度通过', depthUsd: Number(depthUsd.toFixed(4)), minDepthUsd };
}

export function rewardQuoteProtectionDiagnostic(config: AppConfig, side: OrderSide, market: Market, book: Orderbook): string | undefined {
  if (!shouldProtectRewardQuote(config, side)) return undefined;
  if (!cashProbeProtectionEnabled(config, side, market)) return undefined;
  const rewards = market.rewards;
  if (!validRewardSpreadCents(rewards?.maxSpreadCents)) return undefined;
  const tick = effectiveOrderbookTick(market, book);
  const rewardLevels = aggregateOrderbookLevels(book.bids, 'bids')
    .filter((level) => isWithinRewardBand('BUY', level.price, book, rewards!.maxSpreadCents))
  const minFront = cashMinFrontLevels(config, market);
  if (rewardLevels.length < minFront + 1) return `现金单边测试单奖励带内仅 ${rewardLevels.length} 档，少于要求 ${minFront + 1} 档(${minFront} 在前 + 1 支撑)`;
  let firstFailure: string | undefined;
  for (let frontIndex = minFront - 1; frontIndex < rewardLevels.length - 1; frontIndex += 1) {
    const nearestFront = rewardLevels[frontIndex]!;
    const support = rewardLevels[frontIndex + 1]!;
    let price = roundToTick(support.price + tick, tick, 'BUY');
    if ((config.strategy.cashProbeNeverTopOfBook ?? true) && price >= nearestFront.price - 1e-9) {
      price = roundToTick(support.price, tick, 'BUY');
    }
    price = clampPrice(price, tick);
    if (!isWithinRewardBand('BUY', price, book, rewards!.maxSpreadCents)) continue;
    const protection = rewardQuoteProtection(config, 'BUY', price, book, market);
    if (protection.ok) return undefined;
    firstFailure ??= protection.reason;
  }
  return firstFailure ?? '现金单边测试单没有找到满足 101 份保护深度和支撑价差的挂价';
}

export function shouldProtectRewardQuote(config: AppConfig, side: OrderSide): boolean {
  return (config.strategy.entryMode === 'split' && side === 'SELL')
    || (config.strategy.entryMode === 'cash' && side === 'BUY');
}

export function formatUsd(value: number): string {
  return `$${Number(value || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

export function formatNumber(value: number): string {
  return Number(value || 0).toLocaleString('en-US', { maximumFractionDigits: 4 });
}

export function rewardTargetShares(config: AppConfig, minShares?: number): number | undefined {
  if (!Number.isFinite(minShares) || minShares === undefined || minShares <= 0) return undefined;
  const multiplier = Math.max(1, config.strategy.minRewardSizeMultiplier ?? 1);
  return Number((minShares * multiplier + 1).toFixed(4));
}

export function shouldEnforceRewardMinimum(config: AppConfig, market?: Market): boolean {
  // Polymarket small-live TEST MODE relaxes the (large) reward minimum so a tiny order can validate the full flow.
  // Applies to both single- and two-sided test runs — only the hard 5-share exchange floor remains enforced.
  if (market?.venue === 'polymarket' && config.strategy.polymarketTestMode) return false;
  return (config.strategy.enforceRewardMinimum ?? true)
    || (config.strategy.entryMode === 'cash' && config.strategy.pointsOnly);
}

function rewardSizedOrder(config: AppConfig, price: number, minShares?: number, market?: Market): Omit<RewardQuotePlan, 'price' | 'reason' | 'rewardScore' | 'rewardLevel'> | undefined {
  const targetRewardShares = rewardTargetShares(config, minShares) ?? 0;
  const minRewardNotional = targetRewardShares * price;
  const targetNotional = config.risk.orderSizeUsd;
  if (!Number.isFinite(targetNotional) || targetNotional <= 0) return undefined;
  // Polymarket enforces a hard per-ORDER floor of POLYMARKET_MIN_ORDER_SHARES shares ("Size (1.23) lower than the
  // minimum: 5") that is SEPARATE from (and far below) the reward min_shares (20–200). Test mode intentionally relaxes
  // the reward minimum so a tiny order can validate the flow, but this exchange floor still applies — skip the leg
  // when the budget can't buy the floor instead of submitting a doomed order every cycle. Scoped to Polymarket test
  // mode so Predict and normal PP sizing stay byte-identical.
  const polymarketTestRelaxed = market?.venue === 'polymarket' && config.strategy.polymarketTestMode === true;
  if (polymarketTestRelaxed && targetNotional + 1e-9 < POLYMARKET_MIN_ORDER_SHARES * price) {
    return undefined;
  }
  // Strict PP mode treats orderSizeUsd as the real per-order budget cap. If that
  // budget cannot buy the venue minimum plus one share at this quote, skip it.
  if (shouldEnforceRewardMinimum(config, market) && targetRewardShares > 0 && targetNotional + 1e-9 < minRewardNotional) return undefined;
  if (targetNotional > config.risk.maxSingleOrderUsd) return undefined;
  const size = Number((targetNotional / Math.max(price, 0.0001)).toFixed(4));
  const notionalUsd = Number((size * price).toFixed(4));
  return { size, notionalUsd };
}

function protectedRewardLevel(
  config: AppConfig,
  market: Market,
  book: Orderbook,
  side: OrderSide,
  configuredLevel: number
): ProtectedRewardLevel | undefined {
  if (cashProbeProtectionEnabled(config, side, market)) {
    return protectedCashBuyRewardLevel(config, market, book);
  }
  const rewards = market.rewards;
  if (!validRewardSpreadCents(rewards?.maxSpreadCents)) return undefined;
  const bbo = bestBidAsk(book);
  if (bbo.bestBid === undefined || bbo.bestAsk === undefined) return undefined;
  const maxSpread = rewards!.maxSpreadCents! / 100;
  const tick = effectiveOrderbookTick(market, book);
  const levels = side === 'BUY' ? book.bids : book.asks;
  const rewardLevels = levels.filter((level) => isWithinRewardBand(side, level.price, book, rewards!.maxSpreadCents));
  if (rewardLevels.length === 0) return undefined;
  const minProtectionUsd = minQuoteProtectionUsd(config, side, bbo.mid ?? 0.5, market);
  const minDistanceTicks = minQuoteProtectionTicks(config);
  const minDistance = tick * (minDistanceTicks + 1);
  const defaultIndex = Math.min(Math.max(0, configuredLevel - 1), rewardLevels.length - 1);
  const closerProtectionUsd = 1000;
  for (const level of rewardLevels.slice(0, defaultIndex)) {
    const price = protectedPrice(config, side, level, tick, bbo, maxSpread, minDistance);
    const protection = rewardQuoteProtection(config, side, price, book, market);
    if (protection.ok && protection.depthUsd >= closerProtectionUsd) return { ...level, protectedPrice: price };
  }
  const defaultLevel = rewardLevels[defaultIndex];
  if (defaultLevel) {
    const price = protectedPrice(config, side, defaultLevel, tick, bbo, maxSpread, minDistance);
    const protection = rewardQuoteProtection(config, side, price, book, market);
    if (protection.ok && protection.depthUsd >= minProtectionUsd) return { ...defaultLevel, protectedPrice: price };
  }
  for (const level of rewardLevels.slice(defaultIndex + 1)) {
    const price = protectedPrice(config, side, level, tick, bbo, maxSpread, minDistance);
    const protection = rewardQuoteProtection(config, side, price, book, market);
    if (protection.ok && protection.depthUsd >= minProtectionUsd) return { ...level, protectedPrice: price };
  }
  return undefined;
}

function protectedCashBuyRewardLevel(
  config: AppConfig,
  market: Market,
  book: Orderbook
): ProtectedRewardLevel | undefined {
  const rewards = market.rewards;
  if (!validRewardSpreadCents(rewards?.maxSpreadCents)) return undefined;
  const bbo = bestBidAsk(book);
  if (bbo.bestBid === undefined || bbo.bestAsk === undefined) return undefined;
  const tick = effectiveOrderbookTick(market, book);
  const rewardLevels = aggregateOrderbookLevels(book.bids, 'bids')
    .filter((level) => isWithinRewardBand('BUY', level.price, book, rewards!.maxSpreadCents))
  const minFront2 = cashMinFrontLevels(config, market);
  if (rewardLevels.length < minFront2 + 1) return undefined;
  // Honor the user's level: set N → rest at position N (lean on the wall that becomes N+1 = rewardLevels[N-1],
  // i.e. frontIndex N-2). Never shallower than N; if N's exact slot is invalid (out of band / fails protection),
  // step DEEPER for the next valid one (never to the front). No auto cold/hot override — just the configured level.
  const startLevel = market.venue === 'polymarket' ? Math.max(1, Math.trunc(config.strategy.polymarketStartLevel ?? 2)) : Math.max(1, Math.trunc(config.strategy.conservativeDepthLevel ?? 3));
  const firstFrontIndex = Math.max(minFront2 - 1, startLevel - 2);
  for (let frontIndex = firstFrontIndex; frontIndex < rewardLevels.length - 1; frontIndex += 1) {
    const nearestFront = rewardLevels[frontIndex]!;
    const support = rewardLevels[frontIndex + 1]!;
    let price = roundToTick(support.price + tick, tick, 'BUY');
    if ((config.strategy.cashProbeNeverTopOfBook ?? true) && price >= nearestFront.price - 1e-9) {
      price = roundToTick(support.price, tick, 'BUY');
    }
    price = clampPrice(price, tick);
    if (!isWithinRewardBand('BUY', price, book, rewards!.maxSpreadCents)) continue;
    const protection = rewardQuoteProtection(config, 'BUY', price, book, market);
    if (protection.ok) return { ...support, protectedPrice: price, protectedDepthLevel: frontIndex + 1 };
  }
  return undefined;
}

function protectedPrice(
  config: AppConfig,
  side: OrderSide,
  level: OrderbookLevel,
  tick: number,
  bbo: ReturnType<typeof bestBidAsk>,
  maxSpread: number,
  minDistance: number
): number {
  const bboBoundary = side === 'SELL'
    ? (bbo.bestBid ?? level.price) + minDistance
    : (bbo.bestAsk ?? level.price) - minDistance;
  const rewardBoundary = side === 'SELL'
    ? (bbo.bestBid ?? level.price) + maxSpread
    : (bbo.bestAsk ?? level.price) - maxSpread;
  const candidatePrice = side === 'SELL'
    ? Math.min(Math.max(level.price + tick * config.strategy.retreatTicks, bboBoundary), rewardBoundary)
    : Math.max(Math.min(level.price - tick * config.strategy.retreatTicks, bboBoundary), rewardBoundary);
  return side === 'SELL'
    ? roundToTick(candidatePrice, tick, 'SELL')
    : roundToTick(candidatePrice, tick, 'BUY');
}

function minQuoteProtectionUsd(config: AppConfig, side?: OrderSide, price?: number, market?: Market): number {
  if (side === 'BUY' && market?.venue === 'polymarket') {
    // Polymarket TEST MODE: drop the front-depth floor to ~the order size so a tiny order can validate the full flow
    // on thin books. Reward-earning runs (test mode off) keep the full configured protection depth below.
    if (config.strategy.polymarketTestMode) {
      return Math.max(1, Math.min(config.risk.minDepthUsdPerSide, Math.max(1, config.risk.orderSizeUsd)));
    }
    // Reward-earning Polymarket quoting (single-sided): rest BEHIND the configured front-depth so the order isn't at
    // the front of the book and, if it does get filled, can be exited with a small loss. This is the core protection.
    return Math.max(config.risk.minDepthUsdPerSide, config.strategy.polymarketFrontDepthUsd ?? 150);
  }
  if (side && price !== undefined && cashProbeProtectionEnabled(config, side, market)) {
    const targetShares = rewardTargetShares(config, market?.rewards?.minShares) ?? 0;
    const targetNotionalUsd = targetShares * price;
    const venueFrontDepth = (market?.venue === 'predict' && (config.strategy.predictFrontDepthUsd ?? 0) > 0)
      ? config.strategy.predictFrontDepthUsd!
      : config.strategy.cashProbeMinFrontDepthUsd ?? 100;
    return Math.max(
      config.risk.minDepthUsdPerSide,
      venueFrontDepth,
      targetNotionalUsd * (config.strategy.cashProbeDepthMultiplier ?? 2)
    );
  }
  const targetOrderUsd = Math.max(0, config.risk.orderSizeUsd);
  const minimumMultiplier = targetOrderUsd <= 5 ? 4 : targetOrderUsd <= 20 ? 3 : 2;
  return Math.max(config.risk.minDepthUsdPerSide, targetOrderUsd * minimumMultiplier);
}

function minQuoteProtectionTicks(config: AppConfig): number {
  const targetOrderUsd = Math.max(0, config.risk.orderSizeUsd);
  if (targetOrderUsd <= 5) return 2;
  if (targetOrderUsd <= 20) return 3;
  return 4;
}

function validRewardSpreadCents(value: number | undefined): boolean {
  return Number.isFinite(value) && value !== undefined && value > 0;
}

function cashProbeProtectionEnabled(config: AppConfig, side: OrderSide, market?: Market): boolean {
  // Now enabled for BOTH venues: Polymarket also uses the penny-jump / support-gap / never-top-of-book / startLevel
  // placement (it previously used the simpler protectedPrice path). PL still keeps its own front-depth floor
  // (polymarketFrontDepthUsd) because minQuoteProtectionUsd returns the PL branch before the cashProbe branch.
  return config.strategy.entryMode === 'cash'
    && side === 'BUY'
    && (market?.venue === 'predict' || market?.venue === 'polymarket')
    && validRewardSpreadCents(market.rewards?.maxSpreadCents)
    && rewardTargetShares(config, market.rewards?.minShares) !== undefined;
}

function isCashBuyMaintenanceOrder(config: AppConfig, order: OpenOrder, market: Market): boolean {
  return cashProbeProtectionEnabled(config, order.side, market);
}

function canKeepCashBuyWithMaintenanceProtection(protection: ReturnType<typeof rewardQuoteProtection>): boolean {
  if (!protection.reason.includes('前方保护深度')) return false;
  return protection.depthUsd + 1e-9 >= protection.minDepthUsd * CASH_BUY_MAINTENANCE_DEPTH_FLOOR_PCT;
}

function aggregateOrderbookLevels(levels: OrderbookLevel[], side: 'bids' | 'asks'): OrderbookLevel[] {
  const byPrice = new Map<string, { price: number; size: number }>();
  for (const level of levels) {
    if (!Number.isFinite(level.price) || !Number.isFinite(level.size) || level.price <= 0 || level.size <= 0) continue;
    const key = priceKey(level.price);
    const current = byPrice.get(key);
    if (current) current.size += level.size;
    else byPrice.set(key, { price: Number(level.price.toFixed(6)), size: level.size });
  }
  return [...byPrice.values()]
    .map((level) => ({ price: level.price, size: Number(level.size.toFixed(8)) }))
    .sort((a, b) => side === 'bids' ? b.price - a.price : a.price - b.price);
}

function nearestFrontLevel(book: Pick<Orderbook, 'bids' | 'asks'>, side: OrderSide, price: number): OrderbookLevel | undefined {
  if (side === 'BUY') {
    return book.bids
      .filter((level) => level.price > price + 1e-9)
      .sort((a, b) => a.price - b.price)[0];
  }
  return book.asks
    .filter((level) => level.price < price - 1e-9)
    .sort((a, b) => b.price - a.price)[0];
}

function nearestSupportLevel(book: Pick<Orderbook, 'bids' | 'asks'>, side: OrderSide, price: number): OrderbookLevel | undefined {
  if (side === 'BUY') {
    return book.bids
      .filter((level) => level.price <= price + 1e-9)
      .sort((a, b) => b.price - a.price)[0];
  }
  return book.asks
    .filter((level) => level.price >= price - 1e-9)
    .sort((a, b) => a.price - b.price)[0];
}

function priceKey(price: number): string {
  return Number(price).toFixed(8);
}

function inferTickFromBook(book: Pick<Orderbook, 'bids' | 'asks'>): number | undefined {
  const prices = [...book.bids, ...book.asks]
    .map((level) => priceToMicros(level.price))
    .filter((value): value is number => value !== undefined)
    .sort((a, b) => a - b);
  if (prices.length === 0) return undefined;
  const standardMicros = [
    100_000,
    50_000,
    10_000,
    5_000,
    1_000,
    500,
    100,
    50,
    10,
    5,
    1
  ];
  const inferred = standardMicros.find((candidate) => prices.every((price) => price % candidate === 0));
  return normalizeTickCandidate(inferred === undefined ? undefined : inferred / 1_000_000);
}

function priceToMicros(value: number): number | undefined {
  if (!Number.isFinite(value) || value <= 0 || value >= 1) return undefined;
  return Math.round(value * 1_000_000);
}

function normalizeTickCandidate(value: number | undefined): number | undefined {
  if (!Number.isFinite(value) || value === undefined || value <= 0) return undefined;
  const rounded = Number(value.toFixed(6));
  if (rounded < 0.000001 || rounded > 0.1) return undefined;
  return rounded;
}

function bookMid(book?: Orderbook): number | undefined {
  if (!book) return undefined;
  return bestBidAsk(book).mid;
}

function qualifyingDepth(book: Orderbook, maxSpreadCents?: number): number {
  if (!maxSpreadCents) {
    return [...book.bids.slice(0, 3), ...book.asks.slice(0, 3)].reduce((sum, level) => sum + level.price * level.size, 0);
  }
  const buyDepth = book.bids
    .filter((level) => isWithinRewardBand('BUY', level.price, book, maxSpreadCents))
    .reduce((sum, level) => sum + level.price * level.size, 0);
  const sellDepth = book.asks
    .filter((level) => isWithinRewardBand('SELL', level.price, book, maxSpreadCents))
    .reduce((sum, level) => sum + level.price * level.size, 0);
  return buyDepth + sellDepth;
}

function orderbookSpreadPenalty(book: Orderbook, weight: number): number {
  const bbo = bestBidAsk(book);
  if (bbo.spread === undefined || bbo.mid === undefined || bbo.mid <= 0) return weight * 2;
  const spreadBps = (bbo.spread / bbo.mid) * 10000;
  return Math.max(0, Math.log10(spreadBps + 1) * weight);
}
