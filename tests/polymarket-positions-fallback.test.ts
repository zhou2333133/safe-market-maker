import { describe, expect, it } from 'vitest';
import { positionsFromCtfBalances } from '../src/venues/polymarket.js';

describe('positionsFromCtfBalances (on-chain positions fallback)', () => {
  it('drops zero balances, keeps non-zero, sizes by 1e6, and uses the matched price', () => {
    const positions = positionsFromCtfBalances(
      ['tokA', 'tokB', 'tokC'],
      [0n, 208330000n, 0n],
      new Map([['tokB', 0.384]])
    );
    expect(positions).toHaveLength(1);
    expect(positions[0]).toMatchObject({ venue: 'polymarket', tokenId: 'tokB', size: 208.33, averagePrice: 0.384 });
    expect(positions[0]?.notionalUsd).toBeCloseTo(208.33 * 0.384, 4);
  });

  it('falls back to a neutral 0.5 notional when no price is known (size stays exact)', () => {
    const positions = positionsFromCtfBalances(['tokA'], [50000000n], new Map());
    expect(positions[0]).toMatchObject({ size: 50, notionalUsd: 25 });
    expect(positions[0]?.averagePrice).toBeUndefined();
  });

  it('returns empty when every balance is zero or missing', () => {
    expect(positionsFromCtfBalances(['a', 'b'], [0n], new Map())).toEqual([]);
  });

  it('accepts number balances as well as bigint (defensive)', () => {
    const positions = positionsFromCtfBalances(['a'], [1000000], new Map([['a', 0.6]]));
    expect(positions[0]).toMatchObject({ size: 1 });
    expect(positions[0]?.notionalUsd).toBeCloseTo(0.6, 4);
  });

  it('ignores a non-positive price and treats it as unknown (neutral 0.5)', () => {
    const positions = positionsFromCtfBalances(['a'], [2000000n], new Map([['a', 0]]));
    expect(positions[0]?.averagePrice).toBeUndefined();
    expect(positions[0]?.notionalUsd).toBeCloseTo(1, 4); // 2 * 0.5
  });
});
