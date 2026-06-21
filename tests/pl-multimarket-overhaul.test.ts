import { describe, expect, it } from 'vitest';
import { isOrderLevelSubmitRejection } from '../src/execution/quote-cycle-service.js';
import { rewardQuoteProtection } from '../src/strategy/rewards/common.js';
import { appConfigSchema } from '../src/config/schema.js';
import type { Market, Orderbook } from '../src/domain/types.js';

// Graceful per-order rejection: Polymarket throws a PLAIN Error (not an HttpError) when a resting order would exceed
// the wallet ("not enough balance / allowance"). For the multi-market over-rest model this MUST be a per-order skip,
// never a fatal loop error — a halted loop can't cancel its GTD orders or keep farming. (Old build halted here.)
describe('isOrderLevelSubmitRejection (over-rest graceful skip)', () => {
  it('treats the Polymarket over-rest "not enough balance / allowance" rejection as a per-order skip', () => {
    const error = new Error(
      'not enough balance / allowance: the balance is not enough -> balance: 93308118, sum of active orders: 49995460, order amount (inc. fees): 49995460'
    );
    expect(isOrderLevelSubmitRejection(error)).toBe(true);
  });

  it('treats post-only-would-cross and sub-minimum-size as per-order skips', () => {
    expect(isOrderLevelSubmitRejection(new Error('order would cross the book (post only)'))).toBe(true);
    expect(isOrderLevelSubmitRejection(new Error('order size is below the minimum size'))).toBe(true);
    expect(isOrderLevelSubmitRejection(new Error('invalid price: not a multiple of tick size'))).toBe(true);
  });

  it('does NOT swallow connectivity or credential failures (those must stay fatal/retryable upstream)', () => {
    expect(isOrderLevelSubmitRejection(new Error('ECONNRESET'))).toBe(false);
    expect(isOrderLevelSubmitRejection(new Error('fetch failed: network timeout'))).toBe(false);
    expect(isOrderLevelSubmitRejection(new Error('jwt is required'))).toBe(false);
  });
});

// Exit-liquidity (back-support) gate: a single-sided BUY must have enough bid depth BELOW its resting price WITHIN a few
// ticks (close behind) to be sold out at ~1-2 ticks if filled — otherwise a fill becomes stuck single-leg inventory.
// Front protection alone is not enough; distant liquidity (a big-loss exit) does NOT count.
describe('rewardQuoteProtection back/exit-liquidity gate (cashRequireExitLiquidity)', () => {
  const plMarket: Market = {
    venue: 'polymarket',
    tokenId: 'pl-exit-token',
    question: 'exit liquidity?',
    volume24hUsd: 1000,
    liquidityUsd: 5000,
    acceptingOrders: true,
    endTime: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    endTimeSource: 'market-end',
    negRisk: false,
    feeRateBps: 0,
    tickSize: 0.01,
    rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 5, ppPerHour: 100 }
  };
  // Front (bids above 0.62): 0.63/0.64/0.65 deep — passes front depth ($576 ≥ $200), 3-level and gap checks.
  const mkBook = (back: Array<{ price: number; size: number }>): Orderbook => ({
    venue: 'polymarket',
    tokenId: 'pl-exit-token',
    receivedAt: Date.now(),
    bids: [{ price: 0.65, size: 300 }, { price: 0.64, size: 300 }, { price: 0.63, size: 300 }, ...back],
    asks: [{ price: 0.66, size: 1000 }]
  });
  const cfg = (requireExit: boolean) => appConfigSchema.parse({
    risk: { orderSizeUsd: 80, minDepthUsdPerSide: 0 },
    strategy: {
      entryMode: 'cash', quoteSide: 'buy', cashMaxExitLossPct: 8, cashRequireExitLiquidity: requireExit,
      polymarketFrontDepthUsd: 200, cashProbeMaxSupportGapTicks: 10, cashProbeNeverTopOfBook: true
    }
  });

  it('rejects a BUY whose back support cannot absorb the order (would become stuck single-leg)', () => {
    // back 0.61×50 ($30.5) + 0.60×50 ($30) = $60.5 < $80 order
    const decision = rewardQuoteProtection(cfg(true), 'BUY', 0.62, mkBook([{ price: 0.61, size: 50 }, { price: 0.60, size: 50 }]), plMarket);
    expect(decision.ok).toBe(false);
    expect(decision.reason).toContain('后方退出流动性');
  });

  it('accepts a BUY whose back support can absorb the full order within the exit-loss cap', () => {
    // back 0.61×100 ($61) + 0.60×100 ($60) = $121 ≥ $80 order
    const decision = rewardQuoteProtection(cfg(true), 'BUY', 0.62, mkBook([{ price: 0.61, size: 100 }, { price: 0.60, size: 100 }]), plMarket);
    expect(decision.ok).toBe(true);
  });

  it('does NOT apply the back-support gate when cashRequireExitLiquidity is off (default behaviour unchanged)', () => {
    const decision = rewardQuoteProtection(cfg(false), 'BUY', 0.62, mkBook([{ price: 0.61, size: 50 }, { price: 0.60, size: 50 }]), plMarket);
    expect(decision.ok).toBe(true);
  });

  it('rejects a BUY whose exit liquidity is huge but too far below the tick window (big-loss exit ≠ protection)', () => {
    // back 0.58×1000 ($580) + 0.55×1000 ($550) — enormous, but 4-7 ticks below 0.62; window is 2 ticks (floor 0.60), so $0 counts
    const decision = rewardQuoteProtection(cfg(true), 'BUY', 0.62, mkBook([{ price: 0.58, size: 1000 }, { price: 0.55, size: 1000 }]), plMarket);
    expect(decision.ok).toBe(false);
    expect(decision.reason).toContain('后方退出流动性');
  });
});
