import type { AppConfig } from '../../config/schema.js';
import type { Market } from '../../domain/types.js';
import { BaseRewardOptimizer, formatUsd, rewardTargetShares } from './common.js';

export class PredictRewardOptimizer extends BaseRewardOptimizer {
  constructor(config: AppConfig) {
    super(config, {
      venue: 'predict',
      name: 'predict-points',
      marketLabel: 'Predict.fun 积分',
      dailyRateWeight: 4,
      boostWeight: 70,
      liquidityWeight: 9,
      volumeWeight: 7,
      spreadRiskWeight: 8
    });
  }

  protected override addVenueReasons(market: Market, reasons: string[], riskFlags: string[], qualifyingDepthUsd?: number): void {
    if (market.boosted) reasons.push('Predict Boost 市场优先级最高');
    if (market.rewards?.maxSpreadCents && market.rewards.maxSpreadCents < 4) {
      reasons.push('Predict 奖励价差窗口偏窄，容易因盘口移动失效');
    }
    if (market.liquidityUsd > 0 && market.volume24hUsd > market.liquidityUsd * 4) {
      reasons.push('成交活跃，撤换单频率可能较高');
    }
    if (market.rewards?.minShares) {
      const targetShares = rewardTargetShares(this.config, market.rewards.minShares) ?? market.rewards.minShares;
      const estimated = targetShares * 0.5;
      reasons.push(`按 50c 粗算最低奖励订单约 ${formatUsd(estimated)}`);
    }
    // Competition density gate: when the reward-band depth dwarfs a single order, the market
    // is too crowded to earn meaningful points. Mark it ineligible to steer capital elsewhere.
    if (qualifyingDepthUsd && qualifyingDepthUsd > 0 && (this.config.strategy.predictCrowdedThreshold ?? 0) > 0) {
      const targetUsd = this.config.risk.orderSizeUsd;
      const threshold = this.config.strategy.predictCrowdedThreshold;
      if (qualifyingDepthUsd > targetUsd * threshold) {
        riskFlags.push(`奖励带竞争过于拥挤（深度 $${qualifyingDepthUsd.toFixed(0)} 超 ${threshold}x 阈值，单笔 $${targetUsd}）`);
      }
    }
  }
}
