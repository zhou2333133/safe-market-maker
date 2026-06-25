import { describe, expect, it } from 'vitest';
import { pickPolymarketEquityUsd } from '../src/venues/polymarket.js';
import type { Balance } from '../src/domain/types.js';

// Bug context: the Polymarket /value endpoint returns a numeric `0` (not undefined/null) when there's no
// trading activity. The previous `valueUsd ?? accountEquityUsd(...)` saw 0 as a real value and short-circuited
// the balance-based fallback, leaving equity stuck at $0 forever. 20,000+ historical snapshots all read 0
// while the wallet actually held real cash. Predict has no such path — it uses balance-based equity directly.

const wallet: Balance[] = [{ asset: 'pUSD', total: 80.27, available: 80.27 }];

describe('pickPolymarketEquityUsd', () => {
  it('falls back to balance + position estimation when platform value is the literal 0', () => {
    // The bug case. Platform reports 0, wallet has $80.27, no positions. We want $80.27 — not $0.
    expect(pickPolymarketEquityUsd(0, wallet, 0)).toBe(80.27);
  });

  it('falls back to balance estimation when platform value is undefined', () => {
    expect(pickPolymarketEquityUsd(undefined, wallet, 0)).toBe(80.27);
  });

  it('falls back when platform value is negative (bad API state)', () => {
    expect(pickPolymarketEquityUsd(-5, wallet, 0)).toBe(80.27);
  });

  it('falls back when platform value is NaN', () => {
    expect(pickPolymarketEquityUsd(Number.NaN, wallet, 0)).toBe(80.27);
  });

  it('uses platform value when it is positive (preferred — includes unrealized PnL)', () => {
    // Platform value tracks unrealized PnL too, so when present and >0 it's more accurate than wallet-sum.
    expect(pickPolymarketEquityUsd(123.45, wallet, 0)).toBe(123.45);
  });

  it('uses platform value when it differs from wallet (the platform sees positions)', () => {
    expect(pickPolymarketEquityUsd(200, wallet, 50)).toBe(200);
  });

  it('returns 0 when both platform value is 0 AND wallet is empty (no money, honest answer)', () => {
    expect(pickPolymarketEquityUsd(0, [], 0)).toBe(0);
  });

  it('does not double-count: ignores wallet+position when platform value is positive', () => {
    expect(pickPolymarketEquityUsd(100, wallet, 50)).toBe(100); // not 100 + 80.27 + 50
  });

  it('sums USDT/USDC/PUSD/USD wallets in fallback (case-insensitive)', () => {
    const mixed: Balance[] = [
      { asset: 'pUSD', total: 50, available: 50 },
      { asset: 'USDC', total: 30, available: 30 },
      { asset: 'MATIC', total: 999, available: 999 } // not a stable asset — ignored
    ];
    expect(pickPolymarketEquityUsd(0, mixed, 10)).toBe(90); // 50 + 30 + 10
  });
});
