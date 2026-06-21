import type { AppConfig } from '../config/schema.js';
import type { OpenOrder, OrderIntent, Orderbook, Position } from '../domain/types.js';
import { evaluateMarketGuard, spreadWithinLimits } from './market-guard.js';
import { bestBidAsk } from '../venues/normalize.js';
import { rewardQuoteProtection, shouldEnforceRewardMinimum, shouldProtectRewardQuote } from '../strategy/rewards/common.js';

export interface RiskDecision {
  ok: boolean;
  reasons: string[];
}

export interface RiskEvaluationOptions {
  skipStaleBookCheck?: boolean;
}

export class RiskEngine {
  constructor(private readonly config: AppConfig) {}

  evaluate(intent: OrderIntent, book: Orderbook, positions: Position[], openOrders: OpenOrder[], options: RiskEvaluationOptions = {}): RiskDecision {
    const reasons: string[] = [];
    const risk = this.config.risk;
    const isLiquidation = intent.reduceOnly === true && intent.liquidity === 'taker' && intent.side === 'SELL';
    const isRewardMaker = Boolean(intent.reward) && intent.liquidity === 'maker' && intent.postOnly;
    const quote = bestBidAsk(book);
    const ageMs = Date.now() - book.receivedAt;
    const marketGuard = evaluateMarketGuard(this.config, intent.market, book);
    if (!isLiquidation && !marketGuard.ok) reasons.push(marketGuard.message);
    if (!options.skipStaleBookCheck && ageMs > risk.staleBookMs) reasons.push(`stale orderbook ${ageMs}ms`);
    if (!Number.isFinite(intent.price) || intent.price <= 0 || intent.price >= 1) reasons.push(`invalid price ${intent.price}`);
    if (!Number.isFinite(intent.size) || intent.size <= 0) reasons.push(`invalid size ${intent.size}`);
    if (!isLiquidation && (intent.price < risk.minPrice || intent.price > risk.maxPrice)) reasons.push(`price outside safe band ${intent.price}`);
    if (intent.notionalUsd > risk.maxSingleOrderUsd && !isLiquidation) reasons.push(`single order notional exceeds ${risk.maxSingleOrderUsd}`);
    if (
      !isLiquidation
      && this.config.strategy.entryMode === 'split'
      && !(this.config.strategy.enforceRewardMinimum ?? true)
      && intent.notionalUsd > risk.orderSizeUsd + 0.01
    ) {
      reasons.push(`split order notional exceeds configured order size ${risk.orderSizeUsd}`);
    }
    if (risk.requirePostOnly && !intent.postOnly && !isLiquidation) reasons.push('post-only required');
    if (quote.bestBid === undefined || quote.bestAsk === undefined || quote.spread === undefined || quote.mid === undefined) {
      reasons.push('missing BBO');
    } else {
      const spreadBps = (quote.spread / quote.mid) * 10000;
      if (!isLiquidation && !isRewardMaker && spreadBps < risk.minSpreadBps) reasons.push(`spread too tight ${spreadBps.toFixed(1)}bps`);
      if (!isLiquidation && !spreadWithinLimits(this.config, intent.market, spreadBps, quote.mid)) {
        reasons.push(`spread too wide ${spreadBps.toFixed(1)}bps`);
      }
      if (intent.side === 'BUY' && intent.price >= quote.bestAsk && !isLiquidation) reasons.push('BUY quote would cross best ask');
      if (intent.side === 'SELL' && intent.price <= quote.bestBid && !isLiquidation) reasons.push('SELL quote would cross best bid');
      if (intent.reward?.maxSpreadCents && !isLiquidation) {
        const distance = intent.side === 'BUY' ? quote.bestAsk - intent.price : intent.price - quote.bestBid;
        if (distance < -1e-9 || distance * 100 > intent.reward.maxSpreadCents + 1e-9) {
          reasons.push(`quote outside reward band ${distance * 100}c > ${intent.reward.maxSpreadCents}c`);
        }
      }
      if (isRewardMaker && !isLiquidation && shouldProtectRewardQuote(this.config, intent.side)) {
        const protection = rewardQuoteProtection(this.config, intent.side, intent.price, book, intent.market);
        if (!protection.ok) reasons.push(protection.reason);
      }
    }
    if (shouldEnforceRewardMinimum(this.config, intent.market) && intent.reward?.minShares && intent.size + 1e-9 < intent.reward.minShares && !isLiquidation) {
      reasons.push(`size below reward minimum shares ${intent.reward.minShares}`);
    }
    const bidDepthUsd = book.bids.slice(0, 3).reduce((sum, level) => sum + level.price * level.size, 0);
    const askDepthUsd = book.asks.slice(0, 3).reduce((sum, level) => sum + level.price * level.size, 0);
    if (bidDepthUsd < risk.minDepthUsdPerSide) reasons.push(`bid depth too low ${bidDepthUsd.toFixed(2)}`);
    if (!isLiquidation && askDepthUsd < risk.minDepthUsdPerSide) reasons.push(`ask depth too low ${askDepthUsd.toFixed(2)}`);
    const currentExposure = positions
      .filter((position) => position.tokenId === intent.tokenId)
      .reduce((sum, position) => sum + Math.abs(position.notionalUsd), 0);
    const openExposure = openOrders
      .filter((order) => order.tokenId === intent.tokenId)
      .reduce((sum, order) => sum + openOrderAddedExposure(order), 0);
    const addedExposure = coveredSellNotional(intent, positions) >= intent.notionalUsd ? 0 : intent.notionalUsd;
    const maxPositionUsd = intent.venue === 'polymarket'
      && this.config.strategy.polymarketTwoSidedLp
      && (this.config.strategy.polymarketMaxPositionUsd ?? 0) > 0
      ? this.config.strategy.polymarketMaxPositionUsd
      : risk.maxPositionUsd;
    if (!isLiquidation && currentExposure + openExposure + addedExposure > maxPositionUsd) {
      reasons.push(`position exposure would exceed ${maxPositionUsd}`);
    }
    const marketOpenOrders = openOrders.filter((order) => order.tokenId === intent.tokenId).length;
    if (!isLiquidation && marketOpenOrders >= risk.maxOpenOrdersPerMarket) {
      reasons.push(`open order count would exceed ${risk.maxOpenOrdersPerMarket}`);
    }
    return { ok: reasons.length === 0, reasons };
  }
}

function coveredSellNotional(intent: OrderIntent, positions: Position[]): number {
  if (intent.side !== 'SELL') return 0;
  const heldShares = positions
    .filter((position) => position.tokenId === intent.tokenId)
    .reduce((sum, position) => sum + Math.max(0, position.size), 0);
  return heldShares * intent.price;
}

function openOrderAddedExposure(order: OpenOrder): number {
  return order.side === 'BUY' ? Math.abs(order.price * order.size) : 0;
}
