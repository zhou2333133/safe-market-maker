import { beforeEach, describe, expect, it } from 'vitest';
import { clearPolymarketVolatility, polymarketMidVolatilityPct, recordPolymarketMid } from '../src/strategy/rewards/polymarket-volatility.js';

describe('polymarket mid volatility filter', () => {
  beforeEach(() => clearPolymarketVolatility());

  it('returns undefined until there are enough samples', () => {
    recordPolymarketMid('t', 0.5);
    recordPolymarketMid('t', 0.5);
    expect(polymarketMidVolatilityPct('t')).toBeUndefined();
  });

  it('range-bound market has low volatility', () => {
    for (let i = 0; i < 12; i++) recordPolymarketMid('stable', 0.5 + (i % 2 ? 0.001 : -0.001));
    expect(polymarketMidVolatilityPct('stable')!).toBeLessThan(1);
  });

  it('trending market has high volatility', () => {
    for (let i = 0; i < 10; i++) recordPolymarketMid('trend', 0.4 + i * 0.02); // 0.40 -> 0.58
    expect(polymarketMidVolatilityPct('trend')!).toBeGreaterThan(5);
  });

  it('ignores out-of-range mids (<=0 or >=1)', () => {
    for (let i = 0; i < 10; i++) recordPolymarketMid('x', 0.5);
    recordPolymarketMid('x', 1.5);
    recordPolymarketMid('x', 0);
    expect(polymarketMidVolatilityPct('x')!).toBeCloseTo(0, 3);
  });
});
