import type { AppConfig } from './schema.js';
import type { VenueName } from '../domain/types.js';

// Top-level liveEnabled is the global kill switch and takes precedence (AND-merge): a venue is live only when BOTH
// the top-level flag and that venue's own flag are true. A venue with no explicit liveEnabled inherits the top-level
// value. This prevents the historical "top-level liveEnabled: false but venue.liveEnabled: true silently overrides"
// foot-gun from sneaking past the user.
export function venueLiveEnabled(config: AppConfig, venue: VenueName): boolean {
  if (!config.liveEnabled) return false;
  const venueConfig = config.venues[venue];
  return typeof venueConfig.liveEnabled === 'boolean' ? venueConfig.liveEnabled : true;
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
