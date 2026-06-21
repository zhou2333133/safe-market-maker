import type { AppConfig } from '../config/schema.js';
import type { VenueName } from '../domain/types.js';
import { loadCredential } from '../secrets/keystore.js';
import { getRuntimeCredential } from '../secrets/runtime.js';
import { PolymarketVenue } from './polymarket.js';
import { PredictVenue } from './predict.js';
import type { VenueAdapter } from './types.js';

export function createVenue(
  config: AppConfig,
  dataDir: string,
  venue: VenueName,
  passphrase?: string
): VenueAdapter {
  if (venue === 'predict') {
    const credential = getRuntimeCredential(venue) as { jwt?: string } | undefined
      ?? (passphrase ? loadCredential<{ jwt?: string }>(dataDir, venue, 'jwt', passphrase) : undefined);
    return new PredictVenue(config, credential);
  }
  const credential = getRuntimeCredential(venue) as { key: string; secret: string; passphrase: string } | undefined
    ?? (passphrase
    ? loadCredential<{ key: string; secret: string; passphrase: string }>(dataDir, venue, 'clob', passphrase)
    : undefined);
  return new PolymarketVenue(config, credential);
}
