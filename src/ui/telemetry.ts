import { loadConfig } from '../config/load.js';
import { usingStore } from '../store/ui-store.js';
import type { VenueName } from '../domain/types.js';

export function recordUiEvent(
  configPath: string,
  venue: VenueName,
  severity: 'info' | 'warn' | 'error',
  type: string,
  message: string,
  details?: unknown
): void {
  try {
    const loaded = loadConfig(configPath);
    const store = usingStore(loaded.dataDir);
    try {
      store.recordEvent({ venue, severity, type, message, details });
    } finally {
      store.close();
    }
  } catch {
    // UI telemetry must never block the trading control path.
  }
}
