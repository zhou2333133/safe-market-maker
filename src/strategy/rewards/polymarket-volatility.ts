/**
 * Lightweight rolling midpoint-volatility tracker for Polymarket two-sided LP market selection.
 *
 * Two-sided LP is safest in RANGE-BOUND markets (both legs fill evenly -> delta-neutral complete sets)
 * and dangerous in TRENDING / high-volatility markets (one leg fills repeatedly -> directional inventory
 * + adverse selection). We sample each candidate's midpoint every routing cycle and expose the recent
 * coefficient of variation (std/mean, %) so the router can de-rank / exclude volatile markets.
 *
 * State is module-level (per process), mirroring the existing explore-cursor caches.
 */

const MAX_SAMPLES = 30;
const MIN_SAMPLES = 6;
const midHistory = new Map<string, number[]>();

export function recordPolymarketMid(tokenId: string, mid: number): void {
  if (!(mid > 0 && mid < 1)) return;
  const samples = midHistory.get(tokenId) ?? [];
  samples.push(mid);
  if (samples.length > MAX_SAMPLES) samples.shift();
  midHistory.set(tokenId, samples);
}

/** Recent midpoint coefficient of variation (%) for a token, or undefined until enough samples. */
export function polymarketMidVolatilityPct(tokenId: string): number | undefined {
  const samples = midHistory.get(tokenId);
  if (!samples || samples.length < MIN_SAMPLES) return undefined;
  const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  if (mean <= 0) return undefined;
  const variance = samples.reduce((sum, value) => sum + (value - mean) ** 2, 0) / samples.length;
  return Number(((Math.sqrt(variance) / mean) * 100).toFixed(4));
}

export function clearPolymarketVolatility(): void {
  midHistory.clear();
}
