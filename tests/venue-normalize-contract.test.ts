import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Balance, Market, OpenOrder } from '../src/domain/types.js';
import { normalizePolymarketCollateralBalance, normalizePolymarketOpenOrder } from '../src/venues/account-normalize.js';
import { buildOrderbookForToken, normalizeBalances, normalizePolymarketMarket, normalizePredictMarket } from '../src/venues/normalize.js';

interface NormalizeContracts {
  predict: {
    market: unknown;
    expectedFirstMarket: Partial<Market>;
    snakeCaseOutcomeMarket: unknown;
    expectedSnakeCaseOutcomeMarket: Partial<Market>;
  };
  polymarket: {
    rewardsByToken: Record<string, Market['rewards']>;
    market: unknown;
    expectedFirstMarket: Partial<Market>;
    officialOpenOrder: unknown;
    expectedOfficialOpenOrder: Partial<OpenOrder>;
    officialBalanceAllowance: unknown;
    expectedOfficialBalance: Balance;
    arrayTokenMarket: unknown;
    expectedArrayTokenMarket: Partial<Market>;
  };
}

const fixturePath = path.join(process.cwd(), 'tests', 'fixtures', 'venue-normalize-contracts.json');
const contracts = JSON.parse(readFileSync(fixturePath, 'utf8')) as NormalizeContracts;

describe('venue normalize contracts', () => {
  it('normalizes active Predict current rewards and uses reward end as a trading deadline', () => {
    const [market] = normalizePredictMarket({
      id: 'predict-current-reward',
      question: 'Predict active reward fixture',
      accepting_orders_until: new Date(Date.now() + 90 * 60 * 1000).toISOString(),
      liquidityUsd: '12,000',
      rewards: {
        current: {
          startsAt: new Date(Date.now() - 60_000).toISOString(),
          endsAt: new Date(Date.now() + 60 * 60_000).toISOString(),
          hourlyRate: '3,000'
        }
      },
      shareThreshold: 100,
      spreadThreshold: 0.06,
      outcomes: [{ onChainId: 'predict-current-token', name: 'YES' }]
    });

    expect(market).toMatchObject({
      tokenId: 'predict-current-token',
      endTimeSource: 'reward-end',
      rewards: {
        enabled: true,
        level: 5,
        minShares: 100,
        maxSpreadCents: 6,
        ppPerHour: 3000,
        reason: 'predict-current-points'
      }
    });
  });

  it('uses Predict category time as the market deadline when market-level end time is missing', () => {
    const categoryEnd = new Date(Date.now() + 2 * 60 * 60_000).toISOString();
    const [market] = normalizePredictMarket({
      id: 'predict-category-end',
      question: 'Predict category end fixture',
      categoryStartsAt: new Date(Date.now() - 60_000).toISOString(),
      categoryEndsAt: categoryEnd,
      liquidityUsd: 15000,
      rewards: {
        current: {
          startsAt: new Date(Date.now() - 60_000).toISOString(),
          endsAt: new Date(Date.now() + 3 * 60 * 60_000).toISOString(),
          hourlyRate: 500
        }
      },
      shareThreshold: 150,
      spreadThreshold: 0.05,
      outcomes: [{ onChainId: 'predict-category-token', name: 'YES' }]
    });

    expect(market).toMatchObject({
      tokenId: 'predict-category-token',
      startTimeSource: 'category-start',
      endTime: categoryEnd,
      endTimeSource: 'category-end',
      rewards: {
        enabled: true,
        level: 4,
        ppPerHour: 500
      }
    });
  });

  it('does not fabricate Predict market liquidity from huge top-of-book sizes', () => {
    const [market] = normalizePredictMarket({
      id: 'predict-no-stats',
      question: 'Predict huge book fixture',
      rewards: {
        current: {
          startsAt: new Date(Date.now() - 60_000).toISOString(),
          endsAt: new Date(Date.now() + 60 * 60_000).toISOString(),
          hourlyRate: 10
        }
      },
      shareThreshold: 100,
      spreadThreshold: 0.06,
      outcomes: [
        {
          name: 'YES',
          onChainId: 'predict-huge-yes',
          bestBid: { price: 0.001, size: 141_000_000 },
          bestAsk: { price: 0.002, size: 10_000 }
        }
      ]
    });

    expect(market?.liquidityUsd).toBe(0);
  });

  it('normalizes Predict market fields without losing comma-formatted numeric data', () => {
    const markets = normalizePredictMarket(contracts.predict.market);

    expect(markets).toHaveLength(2);
    expect(markets[0]).toMatchObject(contracts.predict.expectedFirstMarket);
    expect(markets.every((market) => market.outcomeCount === 2)).toBe(true);
    expect(markets.map((market) => market.outcomeIndex)).toEqual([0, 1]);
  });

  it('normalizes Predict snake_case outcome token and reward variants', () => {
    const markets = normalizePredictMarket(contracts.predict.snakeCaseOutcomeMarket);

    expect(markets).toHaveLength(1);
    expect(markets[0]).toMatchObject(contracts.predict.expectedSnakeCaseOutcomeMarket);
  });

  it('normalizes Predict snake_case condition id variants for split safety', () => {
    const [market] = normalizePredictMarket({
      id: 'predict-snake-condition',
      condition_id: '0xpredictSnakeCondition',
      question: 'Predict snake condition fixture',
      outcomes: [{ token_id: 'predict-snake-token', outcome: 'YES' }]
    });

    expect(market).toMatchObject({
      tokenId: 'predict-snake-token',
      conditionId: '0xpredictSnakeCondition'
    });
  });

  it('extracts the requested Predict outcome orderbook from a shared market-level payload', () => {
    const payload = {
      outcomes: [
        {
          name: 'YES',
          onChainId: 'predict-yes',
          orderbook: {
            bids: [{ price: '0.176', shares: '1000' }],
            asks: [{ price: '0.178', shares: '1000' }]
          }
        },
        {
          name: 'NO',
          onChainId: 'predict-no',
          orderbook: {
            bids: [{ price: '0.821', shares: '1000' }],
            asks: [{ price: '0.824', shares: '1000' }]
          }
        }
      ]
    };

    const yesBook = buildOrderbookForToken('predict', 'predict-yes', payload);
    const noBook = buildOrderbookForToken('predict', 'predict-no', payload);

    expect(yesBook.asks[0]?.price).toBe(0.178);
    expect(noBook.asks[0]?.price).toBe(0.824);
    expect(noBook.asks[0]?.price).not.toBe(yesBook.asks[0]?.price);
  });

  it('rejects ambiguous Predict market-level orderbooks instead of reusing one outcome for another token', () => {
    expect(() => buildOrderbookForToken('predict', 'predict-no', {
      bids: [{ price: '0.176', shares: '1000' }],
      asks: [{ price: '0.178', shares: '1000' }]
    })).toThrow(/does not identify requested token/);
  });

  it('uses token tick precision when complementing ambiguous Predict NO orderbooks', () => {
    const noBook = buildOrderbookForToken('predict', 'predict-no', {
      bids: [{ price: '0.123456', shares: '1000' }],
      asks: [{ price: '0.234567', shares: '1000' }]
    }, {
      allowAmbiguousTopLevel: true,
      complementAmbiguousTopLevel: true,
      complementTickSize: 0.001
    });

    expect(noBook.bids[0]?.price).toBe(0.765);
    expect(noBook.asks[0]?.price).toBe(0.877);
  });

  it('normalizes Polymarket market fields without losing comma-formatted numeric data', () => {
    const rewards = new Map(Object.entries(contracts.polymarket.rewardsByToken));
    const markets = normalizePolymarketMarket(contracts.polymarket.market, rewards);

    expect(markets).toHaveLength(2);
    expect(markets[0]).toMatchObject(contracts.polymarket.expectedFirstMarket);
    expect(markets.every((market) => market.outcomeCount === 2)).toBe(true);
    expect(markets.map((market) => market.outcomeIndex)).toEqual([0, 1]);
    expect(markets[1]?.rewards).toEqual({ enabled: false });
  });

  it('normalizes Polymarket array token/outcome fields and keeps reward contracts by token', () => {
    const rewards = new Map([
      ...Object.entries(contracts.polymarket.rewardsByToken),
      ['poly-array-up', contracts.polymarket.expectedArrayTokenMarket.rewards]
    ]);
    const markets = normalizePolymarketMarket(contracts.polymarket.arrayTokenMarket, rewards);

    expect(markets).toHaveLength(2);
    expect(markets[0]).toMatchObject(contracts.polymarket.expectedArrayTokenMarket);
    expect(markets[1]).toMatchObject({ tokenId: 'poly-array-down', rewards: { enabled: false } });
  });

  it('normalizes balances with separate available and total fields for frozen-fund checks', () => {
    const balances = normalizeBalances({
      data: {
        balances: [
          {
            asset: 'USDC',
            available_balance: '19.00',
            total_balance: '40.00'
          }
        ]
      }
    });

    expect(balances).toEqual([{ asset: 'USDC', available: 19, total: 40 }]);
  });

  it('normalizes Polymarket official account fixtures without fabricating frozen funds', () => {
    expect(normalizePolymarketOpenOrder(contracts.polymarket.officialOpenOrder)).toMatchObject(contracts.polymarket.expectedOfficialOpenOrder);
    expect(normalizePolymarketCollateralBalance(contracts.polymarket.officialBalanceAllowance)).toEqual([contracts.polymarket.expectedOfficialBalance]);
  });
});
