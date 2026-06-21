import type { VenueName } from '../domain/types.js';

export function cancelSemantics(venue: VenueName): string {
  return venue === 'predict'
    ? 'Predict REST remove: removes orders from the orderbook; it is not on-chain invalidation.'
    : 'Venue cancel endpoint completed.';
}
