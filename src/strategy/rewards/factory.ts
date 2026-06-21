import type { AppConfig } from '../../config/schema.js';
import type { VenueName } from '../../domain/types.js';
import { PolymarketRewardOptimizer } from './polymarket.js';
import { PredictRewardOptimizer } from './predict.js';
import type { VenueRewardOptimizer } from './types.js';

export function createRewardOptimizer(venue: VenueName, config: AppConfig): VenueRewardOptimizer {
  return venue === 'polymarket'
    ? new PolymarketRewardOptimizer(config)
    : new PredictRewardOptimizer(config);
}
