import { describe, expect, it } from 'vitest';
import { appConfigSchema } from '../src/config/schema.js';
import type { Market, OpenOrder, Orderbook } from '../src/domain/types.js';
import { frontProtectionDepthUsd } from '../src/strategy/rewards/common.js';
import { shouldRetreatThinFront } from '../src/execution/cancel-service.js';

const market: Market = {
  venue: 'polymarket', tokenId: 't', question: 'q', volume24hUsd: 0, liquidityUsd: 0,
  acceptingOrders: true, negRisk: false, feeRateBps: 0, tickSize: 0.01, rewards: { enabled: true }
};
const order: OpenOrder = { venue: 'polymarket', externalId: 'x', tokenId: 't', side: 'BUY', price: 0.18, size: 400, status: 'OPEN' };

// A book whose only bid ahead of 0.18 is at 0.20 with the given $ of front cushion; a deep 0.18 bid (not "ahead").
function book(frontUsdAt020: number, receivedAt = Date.now()): Orderbook {
  return { venue: 'polymarket', tokenId: 't', bids: [{ price: 0.20, size: frontUsdAt020 / 0.20 }, { price: 0.18, size: 1000 }], asks: [{ price: 0.22, size: 500 }], receivedAt };
}
function config(retreat: number) {
  return appConfigSchema.parse({ liveEnabled: true, strategy: { entryMode: 'cash', quoteSide: 'buy', balanceReserveUsd: 1, polymarketRetreatFrontDepthUsd: retreat } });
}

describe('frontProtectionDepthUsd', () => {
  it('sums bid notional strictly ahead of a BUY (priced above it)', () => {
    expect(frontProtectionDepthUsd(book(20), 'BUY', 0.18)).toBeCloseTo(20, 2);
  });
  it('sums ask notional strictly ahead of a SELL (priced below it)', () => {
    const b: Orderbook = { venue: 'polymarket', tokenId: 't', bids: [], asks: [{ price: 0.50, size: 100 }, { price: 0.55, size: 100 }], receivedAt: Date.now() };
    expect(frontProtectionDepthUsd(b, 'SELL', 0.55)).toBeCloseTo(50, 2);
  });
});

describe('shouldRetreatThinFront (fast-retreat decision)', () => {
  it('retreats when the live front cushion has eroded below the floor', () => {
    expect(shouldRetreatThinFront(config(100), 'polymarket', order, market, book(20))).toEqual({ frontDepthUsd: 20, floorUsd: 100 });
  });
  it('does not retreat while the cushion is still adequate', () => {
    expect(shouldRetreatThinFront(config(100), 'polymarket', order, market, book(200))).toBeNull();
  });
  it('is disabled when the floor is 0', () => {
    expect(shouldRetreatThinFront(config(0), 'polymarket', order, market, book(20))).toBeNull();
  });
  it('never retreats on a stale book (avoids a false trigger on old data)', () => {
    expect(shouldRetreatThinFront(config(100), 'polymarket', order, market, book(20, Date.now() - 999999))).toBeNull();
  });
  it('only applies to polymarket cash BUY orders', () => {
    expect(shouldRetreatThinFront(config(100), 'predict', order, market, book(20))).toBeNull();
    expect(shouldRetreatThinFront(config(100), 'polymarket', { ...order, side: 'SELL' }, market, book(20))).toBeNull();
  });
});
