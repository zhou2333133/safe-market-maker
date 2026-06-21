import { describe, expect, it } from 'vitest';
import { appConfigSchema } from '../src/config/schema.js';
import type { Market, OrderIntent } from '../src/domain/types.js';
import { filterPolymarketLpPairsBySetMargin } from '../src/strategy/strategy-engine.js';

const config = appConfigSchema.parse({ strategy: { polymarketTwoSidedLp: true } });
const offConfig = appConfigSchema.parse({ strategy: { polymarketTwoSidedLp: false } });

function intent(marketId: string, tokenId: string, outcomeIndex: number, price: number): OrderIntent {
  const market: Market = {
    venue: 'polymarket',
    tokenId,
    marketId,
    conditionId: marketId,
    question: 'Q',
    outcome: outcomeIndex === 0 ? 'Yes' : 'No',
    outcomeIndex,
    outcomeCount: 2,
    volume24hUsd: 0,
    liquidityUsd: 0,
    acceptingOrders: true,
    negRisk: false,
    feeRateBps: 0,
    tickSize: 0.01,
    rewards: { enabled: true }
  };
  return { venue: 'polymarket', market, tokenId, side: 'BUY', price, size: 10, notionalUsd: price * 10, postOnly: true, reason: 'test', clientOrderId: `${tokenId}-${price}` };
}

describe('filterPolymarketLpPairsBySetMargin (YES+NO < 1 guard)', () => {
  it('keeps a complete pair whose prices leave complete-set margin', () => {
    const out = filterPolymarketLpPairsBySetMargin(config, 'polymarket', [intent('A', 'a-yes', 0, 0.49), intent('A', 'a-no', 1, 0.49)]);
    expect(out).toHaveLength(2); // 0.98 < 1
  });

  it('DROPS a pair that would guarantee a complete-set loss (sum >= 1)', () => {
    const out = filterPolymarketLpPairsBySetMargin(config, 'polymarket', [intent('A', 'a-yes', 0, 0.52), intent('A', 'a-no', 1, 0.52)]);
    expect(out).toHaveLength(0); // 1.04 >= 1
  });

  it('drops a lone leg (two-sided LP needs a complete pair)', () => {
    expect(filterPolymarketLpPairsBySetMargin(config, 'polymarket', [intent('A', 'a-yes', 0, 0.49)])).toHaveLength(0);
  });

  it('is a passthrough when two-sided LP is off, or the venue is not polymarket', () => {
    const legs = [intent('A', 'a-yes', 0, 0.52), intent('A', 'a-no', 1, 0.52)];
    expect(filterPolymarketLpPairsBySetMargin(offConfig, 'polymarket', legs)).toHaveLength(2);
    expect(filterPolymarketLpPairsBySetMargin(config, 'predict', legs)).toHaveLength(2);
  });
});
