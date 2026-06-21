import type { AppConfig } from './schema.js';
import type { VenueName } from '../domain/types.js';

export function venueLiveEnabled(config: AppConfig, venue: VenueName): boolean {
  const venueConfig = config.venues[venue];
  return typeof venueConfig.liveEnabled === 'boolean' ? venueConfig.liveEnabled : config.liveEnabled;
}

export function liveEnabledByVenue(config: AppConfig): Record<VenueName, boolean> {
  return {
    predict: venueLiveEnabled(config, 'predict'),
    polymarket: venueLiveEnabled(config, 'polymarket')
  };
}

export function venueDisplayName(venue: VenueName): string {
  return venue === 'predict' ? 'Predict' : 'Polymarket';
}
