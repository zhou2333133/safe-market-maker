import type { AppConfig } from '../../config/schema.js';
import type { Market } from '../../domain/types.js';
import { BaseRewardOptimizer, formatNumber } from './common.js';

export class PolymarketRewardOptimizer extends BaseRewardOptimizer {
  constructor(config: AppConfig) {
    super(config, {
      venue: 'polymarket',
      name: 'polymarket-rewards',
      marketLabel: 'Polymarket Rewards',
      dailyRateWeight: 18,
      boostWeight: 25,
      liquidityWeight: 7,
      volumeWeight: 6,
      spreadRiskWeight: 10
    });
  }

  protected override addVenueReasons(market: Market, reasons: string[], _riskFlags: string[], _qualifyingDepthUsd?: number): void {
    if (market.rewards?.dailyRate) reasons.push(`Polymarket 每日奖励权重 ${formatNumber(market.rewards.dailyRate)}`);
    if (market.negRisk) reasons.push('Neg-risk 市场，注意组合持仓和结算路径');
    if (!market.rewards?.dailyRate && market.rewards?.enabled) reasons.push('缺少 Polymarket daily rewards rate，收益排序置信度较低');
    if (market.rewards?.maxSpreadCents && market.rewards.maxSpreadCents <= 2) {
      reasons.push('Polymarket 奖励价差窗口很窄，排队和撤换风险高');
    }
  }
}
