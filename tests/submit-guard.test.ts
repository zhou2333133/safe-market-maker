import { describe, expect, it } from 'vitest';
import { appConfigSchema } from '../src/config/schema.js';
import type { Market, OrderIntent, Orderbook } from '../src/domain/types.js';
import { evaluateSubmitGuard } from '../src/execution/submit-guard.js';

const market: Market = {
  venue: 'predict',
  tokenId: 'token-1',
  question: 'Submit guard?',
  volume24hUsd: 10000,
  liquidityUsd: 15000,
  acceptingOrders: true,
  endTime: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  endTimeSource: 'market-end',
  negRisk: false,
  feeRateBps: 0,
  tickSize: 0.01,
  rewards: { enabled: true, level: 5, maxSpreadCents: 6 }
};

const book: Orderbook = {
  venue: 'predict',
  tokenId: market.tokenId,
  receivedAt: Date.now(),
  bids: [
    { price: 0.49, size: 1000 },
    { price: 0.48, size: 1000 },
    { price: 0.47, size: 1000 }
  ],
  asks: [
    { price: 0.51, size: 1000 },
    { price: 0.52, size: 1000 },
    { price: 0.53, size: 1000 }
  ]
};

const order: OrderIntent = {
  venue: 'predict',
  market,
  tokenId: market.tokenId,
  side: 'BUY',
  price: 0.49,
  size: 16,
  notionalUsd: 7.84,
  postOnly: true,
  reason: 'test',
  clientOrderId: 'submit-guard-test'
};

describe('submit guard', () => {
  it('passes when final orderbook and order risk are still valid', () => {
    const config = appConfigSchema.parse({
      liveEnabled: true,
      risk: { maxSingleOrderUsd: 100, maxPositionUsd: 200 }
    });

    expect(evaluateSubmitGuard({
      config,
      intent: order,
      initialBook: book,
      freshBook: book,
      positions: [],
      openOrders: []
    })).toMatchObject({ ok: true });
  });

  it('returns structured market reject when the final BBO jumps', () => {
    const config = appConfigSchema.parse({
      liveEnabled: true,
      risk: { maxBboMoveCents: 5, maxSingleOrderUsd: 100, maxPositionUsd: 200 }
    });
    const freshBook: Orderbook = {
      ...book,
      bids: [{ price: 0.78, size: 1000 }, { price: 0.77, size: 1000 }, { price: 0.76, size: 1000 }],
      asks: [{ price: 0.82, size: 1000 }, { price: 0.83, size: 1000 }, { price: 0.84, size: 1000 }]
    };

    expect(evaluateSubmitGuard({
      config,
      intent: order,
      initialBook: book,
      freshBook,
      positions: [],
      openOrders: []
    })).toMatchObject({
      ok: false,
      reason: 'market-guard',
      reject: {
        reason_code: 'MARKET_PRICE_JUMP',
        category: 'market',
        stage: 'final-orderbook-check'
      }
    });
  });

  it('returns structured risk reject when final order risk fails', () => {
    const config = appConfigSchema.parse({
      liveEnabled: true,
      risk: { maxSingleOrderUsd: 100, maxPositionUsd: 200, requirePostOnly: true }
    });

    expect(evaluateSubmitGuard({
      config,
      intent: { ...order, postOnly: false },
      initialBook: book,
      freshBook: book,
      positions: [],
      openOrders: [],
      stage: 'manual-final-orderbook-check'
    })).toMatchObject({
      ok: false,
      reason: 'risk',
      reject: {
        reason_code: 'POST_ONLY_REQUIRED',
        category: 'risk',
        stage: 'manual-final-orderbook-check'
      }
    });
  });
});
