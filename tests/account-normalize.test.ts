import { describe, expect, it } from 'vitest';
import {
  isPredictFillActivity,
  normalizePolymarketFill,
  normalizePolymarketCollateralBalance,
  normalizePolymarketOpenOrder,
  normalizePolymarketPosition,
  normalizePredictFill,
  normalizePredictOpenOrder,
  normalizePredictPosition
} from '../src/venues/account-normalize.js';

describe('account normalize contracts', () => {
  it('normalizes Predict positions, open orders, and fills from mixed field names', () => {
    const position = normalizePredictPosition({
      market: { id: 'market-1' },
      outcome: { name: 'YES', onChainId: 'predict-token' },
      amount: '1,250',
      valueUsd: '625.50',
      averageBuyPriceUsd: '0.5004'
    });
    const order = normalizePredictOpenOrder({
      id: 'row-1',
      pricePerShare: '0.49',
      shares: '1,000',
      order: {
        hash: 'predict-order',
        tokenId: 'predict-token',
        side: 0
      }
    });
    const fillRaw = {
      id: 'fill-1',
      type: 'MATCH',
      side: 'BUY',
      tokenId: 'predict-token',
      marketId: 'market-1',
      price: '0.50',
      shares: '1,000',
      realizedPnlUsd: '-1.25',
      feeUsd: '0.02',
      createdAt: '2026-05-20T10:00:00Z'
    };

    expect(position).toMatchObject({ tokenId: 'predict-token', size: 1250, notionalUsd: 625.5, averagePrice: 0.5004 });
    expect(order).toMatchObject({ externalId: 'row-1', tokenId: 'predict-token', side: 'BUY', price: 0.49, size: 1000 });
    expect(isPredictFillActivity(fillRaw)).toBe(true);
    expect(normalizePredictFill(fillRaw, 0)).toMatchObject({
      id: 'fill-1',
      tokenId: 'predict-token',
      marketId: 'market-1',
      side: 'BUY',
      price: 0.5,
      size: 1000,
      notionalUsd: 500,
      realizedPnlUsd: -1.25,
      feeUsd: 0.02,
      cashflowUsd: -500.02,
      ts: Date.parse('2026-05-20T10:00:00Z')
    });
  });

  it('normalizes Predict position amount wei strings from the live positions API', () => {
    const position = normalizePredictPosition({
      market: {
        id: 'market-live',
        conditionId: 'condition-live',
        question: 'Live market from position',
        tradingStatus: 'OPEN',
        isYieldBearing: true,
        rewards: {
          current: {
            startsAt: new Date(Date.now() - 60_000).toISOString(),
            endsAt: new Date(Date.now() + 60 * 60_000).toISOString(),
            hourlyRate: 1500
          }
        },
        liquidity_activation: { min_shares: 100, max_spread_cents: 6 },
        outcomes: [
          { onChainId: 'live-token', name: 'YES' },
          { onChainId: 'live-token-no', name: 'NO' }
        ]
      },
      outcome: { onChainId: 'live-token', name: 'YES' },
      amount: '10000000000000000000',
      valueUsd: '9.90'
    });

    expect(position).toMatchObject({
      tokenId: 'live-token',
      marketId: 'market-live',
      conditionId: 'condition-live',
      outcome: 'YES',
      outcomeCount: 2,
      size: 10,
      notionalUsd: 9.9
    });
    expect(position?.market).toMatchObject({
      tokenId: 'live-token',
      marketId: 'market-live',
      conditionId: 'condition-live',
      question: 'Live market from position',
      outcome: 'YES',
      outcomeCount: 2,
      yieldBearing: true,
      rewards: { enabled: true, ppPerHour: 1500 }
    });
  });

  it('normalizes Polymarket positions, open orders, and fills from mixed field names', () => {
    const position = normalizePolymarketPosition({
      asset: 'poly-token',
      conditionId: 'condition-1',
      outcome: 'YES',
      size: '1,250',
      currentValue: '650.00',
      avgPrice: '0.52'
    });
    const order = normalizePolymarketOpenOrder({
      orderID: 'poly-order',
      asset_id: 'poly-token',
      side: 'SELL',
      price: '0.53',
      original_size: '1,000',
      size_matched: '125'
    });
    const fill = normalizePolymarketFill({
      id: 'poly-fill',
      orderId: 'poly-order',
      asset: 'poly-token',
      conditionId: 'condition-1',
      side: 'SELL',
      price: '0.53',
      size: '1,000',
      realizedPnl: '2.50',
      fee: '0.03',
      timestamp: 1779271200
    }, 0);

    expect(position).toMatchObject({ tokenId: 'poly-token', marketId: 'condition-1', size: 1250, notionalUsd: 650, averagePrice: 0.52 });
    expect(order).toMatchObject({ externalId: 'poly-order', tokenId: 'poly-token', side: 'SELL', price: 0.53, size: 875 });
    expect(fill).toMatchObject({
      id: 'poly-fill',
      orderId: 'poly-order',
      tokenId: 'poly-token',
      marketId: 'condition-1',
      side: 'SELL',
      price: 0.53,
      size: 1000,
      notionalUsd: 530,
      realizedPnlUsd: 2.5,
      feeUsd: 0.03,
      cashflowUsd: 529.97,
      ts: 1779271200000
    });
  });

  it('normalizes Polymarket CLOB open-order SDK variants by remaining size', () => {
    expect(normalizePolymarketOpenOrder({
      id: 'sdk-open-order',
      market: 'poly-condition',
      asset_id: 'poly-token',
      side: 'BUY',
      original_size: '100.00',
      size_matched: '35.25',
      price: '0.40',
      status: 'OPEN'
    })).toMatchObject({
      externalId: 'sdk-open-order',
      tokenId: 'poly-token',
      side: 'BUY',
      price: 0.4,
      size: 64.75
    });

    expect(normalizePolymarketOpenOrder({
      orderID: 'post-order-id',
      token_id: 'poly-token',
      side: 'BUY',
      size: '12.50',
      original_size: '100.00',
      size_matched: '30.00',
      price: '0.60'
    })).toMatchObject({
      externalId: 'post-order-id',
      tokenId: 'poly-token',
      side: 'BUY',
      price: 0.6,
      size: 12.5
    });

    expect(normalizePolymarketOpenOrder({
      orderId: 'camel-order',
      tokenId: 'poly-token',
      side: 'SELL',
      originalSize: '10',
      sizeMatched: '12',
      price: '0.55'
    })).toMatchObject({
      externalId: 'camel-order',
      tokenId: 'poly-token',
      side: 'SELL',
      price: 0.55,
      size: 0
    });
  });

  it('normalizes Polymarket collateral balance without hiding frozen funds', () => {
    // Official @polymarket/clob-client BalanceAllowanceResponse exposes only
    // balance + allowance; without available/locked fields, treat balance as
    // both total and available instead of fabricating frozen funds.
    expect(normalizePolymarketCollateralBalance({
      balance: '40.00',
      allowance: '999'
    })).toEqual([{ asset: 'pUSD', available: 40, total: 40 }]);

    expect(normalizePolymarketCollateralBalance({
      available: '19.00',
      balance: '40.00'
    })).toEqual([{ asset: 'pUSD', available: 19, total: 40 }]);

    expect(normalizePolymarketCollateralBalance({
      data: {
        free: '19.00',
        locked: '21.00'
      }
    })).toEqual([{ asset: 'pUSD', available: 19, total: 40 }]);

    expect(normalizePolymarketCollateralBalance({ allowance: '999' })).toEqual([]);
  });

  it('builds stable fallback fill ids when venues omit official fill ids', () => {
    const predictFill = {
      type: 'MATCH',
      side: 'BUY',
      tokenId: 'predict-token',
      price: '0.50',
      shares: '20',
      createdAt: '2026-05-20T10:00:00Z'
    };
    expect(normalizePredictFill(predictFill, 0).id).toBe(normalizePredictFill(predictFill, 5).id);

    const polymarketFill = {
      side: 'SELL',
      asset: 'poly-token',
      price: '0.52',
      size: '10',
      timestamp: 1779271200
    };
    expect(normalizePolymarketFill(polymarketFill, 0).id).toBe(normalizePolymarketFill(polymarketFill, 5).id);
  });

  it('normalizes Predict open-order side case-insensitively and rejects unknown side values', () => {
    expect(normalizePredictOpenOrder({
      id: 'lower-buy',
      token_id: 'predict-token',
      side: 'buy',
      price: '0.49',
      shares: '10'
    })).toMatchObject({ side: 'BUY' });

    expect(normalizePredictOpenOrder({
      id: 'unknown-side',
      token_id: 'predict-token',
      side: 'bid',
      price: '0.49',
      shares: '10'
    })).toBeUndefined();
  });

  it('normalizes Predict live open orders using the platform cancel id and human units', () => {
    const order = normalizePredictOpenOrder({
      amount: '29629000000000000000',
      amountFilled: '0',
      currency: 'USDT',
      id: '220162001',
      isNegRisk: false,
      isYieldBearing: true,
      marketId: 342689,
      order: {
        hash: '0x12c5a3937cd395b9817d4c554dc95988ce501606a16de370227c90721e8f8f12',
        makerAmount: '7999830000000000000',
        side: 0,
        takerAmount: '29629000000000000000',
        tokenId: '61138423286087147984685173027268833137277584883210300098648137790834179463029'
      },
      status: 'OPEN',
      strategy: 'LIMIT'
    });

    expect(order).toMatchObject({
      externalId: '220162001',
      tokenId: '61138423286087147984685173027268833137277584883210300098648137790834179463029',
      side: 'BUY',
      price: 0.27,
      size: 29.629
    });
  });

  it('normalizes the current Predict MATCH_SUCCESS activity schema', () => {
    const buyRaw = {
      name: 'MATCH_SUCCESS',
      amountFilled: '119040000000000000000',
      priceExecuted: '378000000000000000',
      createdAt: '2026-06-06T06:06:56.000Z',
      transactionHash: '0xbuy',
      market: { id: 5087 },
      outcome: { name: 'Yes', onChainId: 'predict-token' },
      order: {
        amount: '119040000000000000000',
        price: '378000000000000000',
        quoteType: 'Bid',
        fee: { amount: '0', type: 'SHARES' }
      }
    };
    const sellRaw = {
      name: 'MATCH_SUCCESS',
      amountFilled: '119040000000000000000',
      priceExecuted: '350000000000000000',
      createdAt: '2026-06-07T05:22:34.000Z',
      transactionHash: '0xsell',
      market: { id: 5087 },
      outcome: { name: 'Yes', onChainId: 'predict-token' },
      order: {
        amount: '119040000000000000000',
        price: '350000000000000000',
        quoteType: 'Ask',
        fee: { amount: '749952000000000000', type: 'COLLATERAL' }
      }
    };

    expect(isPredictFillActivity(buyRaw)).toBe(true);
    expect(isPredictFillActivity({ ...buyRaw, name: 'CREATE', amountFilled: null })).toBe(false);
    expect(normalizePredictFill(buyRaw, 0)).toMatchObject({
      id: 'predict:0xbuy:predict-token:5087:BUY:0.37800000:119.04000000:44.99710000:1780726016000',
      tokenId: 'predict-token',
      marketId: '5087',
      side: 'BUY',
      price: 0.378,
      size: 119.04,
      notionalUsd: 44.9971,
      feeUsd: 0,
      cashflowUsd: -44.9971
    });
    expect(normalizePredictFill(sellRaw, 0)).toMatchObject({
      tokenId: 'predict-token',
      marketId: '5087',
      side: 'SELL',
      price: 0.35,
      size: 119.04,
      notionalUsd: 41.664,
      feeUsd: 0.749952,
      cashflowUsd: 40.914
    });
  });

  it('normalizes Polymarket open-order side case-insensitively and rejects unknown side values', () => {
    expect(normalizePolymarketOpenOrder({
      id: 'lower-sell',
      asset_id: 'poly-token',
      side: 'sell',
      price: '0.51',
      size: '10'
    })).toMatchObject({ side: 'SELL' });

    expect(normalizePolymarketOpenOrder({
      id: 'unknown-side',
      asset_id: 'poly-token',
      side: 'bid',
      price: '0.49',
      size: '10'
    })).toBeUndefined();
  });
});
