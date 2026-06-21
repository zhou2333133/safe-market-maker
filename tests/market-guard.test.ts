import { describe, expect, it } from 'vitest';
import { appConfigSchema } from '../src/config/schema.js';
import type { Market, Orderbook } from '../src/domain/types.js';
import { evaluateMarketGuard, marketEndDecision, marketStartDecision, marketTimeDecision } from '../src/risk/market-guard.js';
import { normalizePolymarketMarket, normalizePredictMarket } from '../src/venues/normalize.js';

const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const market: Market = {
  venue: 'predict',
  tokenId: 'token-1',
  question: 'Will guard tests pass?',
  volume24hUsd: 10000,
  liquidityUsd: 15000,
  acceptingOrders: true,
  endTime: future,
  endTimeSource: 'market-end',
  negRisk: false,
  feeRateBps: 0,
  tickSize: 0.01,
  rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6 }
};

const book: Orderbook = {
  venue: 'predict',
  tokenId: 'token-1',
  receivedAt: Date.now(),
  bids: [{ price: 0.49, size: 1000 }, { price: 0.48, size: 1000 }, { price: 0.47, size: 1000 }],
  asks: [{ price: 0.51, size: 1000 }, { price: 0.52, size: 1000 }, { price: 0.53, size: 1000 }]
};

describe('market guard', () => {
  it('blocks unknown end time by default', () => {
    const config = appConfigSchema.parse({});
    const decision = marketEndDecision(config, { ...market, endTime: undefined, endTimeSource: undefined });
    expect(decision.ok).toBe(false);
    expect(decision.reason).toBe('unknown-end-time');
    expect(decision.cancelOpenOrders).toBe(true);
  });

  it('uses the earliest verifiable market time and records the source', () => {
    const [predict] = normalizePredictMarket({
      id: 'm1',
      question: 'Predict time',
      endDate: '2026-05-20T12:00:00Z',
      resolutionTime: '2026-05-20T13:00:00Z',
      accepting_orders_until: '2026-05-20T11:30:00Z',
      outcomes: [{ onChainId: 'token-predict', name: 'Yes' }]
    });
    expect(predict?.endTime).toBe('2026-05-20T11:30:00.000Z');
    expect(predict?.endTimeSource).toBe('order-deadline');

    const [poly] = normalizePolymarketMarket({
      id: 'p1',
      conditionId: 'c1',
      question: 'Poly time',
      endDate: '2026-05-20T12:00:00Z',
      settlementTime: '2026-05-20T13:00:00Z',
      outcomes: JSON.stringify(['YES']),
      clobTokenIds: JSON.stringify(['token-poly'])
    }, new Map());
    expect(poly?.endTime).toBe('2026-05-20T12:00:00.000Z');
    expect(poly?.endTimeSource).toBe('market-end');
  });

  it('treats Polymarket gameStartTime as the sports start: skips in-play single games, not long futures', () => {
    const config = appConfigSchema.parse({
      risk: {
        settlementNoNewOrdersMs: 30 * 60 * 1000,
        settlementCancelOpenOrdersMs: 10 * 60 * 1000,
        shortEventMaxDurationMs: 12 * 60 * 60 * 1000,
        eventStartNoNewOrdersMs: 30 * 60 * 1000,
        eventStartCancelOpenOrdersMs: 10 * 60 * 1000
      }
    });
    const kickoff = Date.parse('2026-06-16T18:00:00Z');
    const [game] = normalizePolymarketMarket({
      id: 'g1', conditionId: 'gc1', question: 'Lakers vs Celtics',
      gameStartTime: new Date(kickoff).toISOString(),
      endDate: new Date(kickoff + 3 * 60 * 60 * 1000).toISOString(),
      outcomes: JSON.stringify(['YES']), clobTokenIds: JSON.stringify(['tok-game'])
    }, new Map());
    expect(Date.parse(game!.startTime!)).toBe(kickoff);              // gameStartTime -> START
    expect(Date.parse(game!.endTime!)).toBe(kickoff + 3 * 60 * 60 * 1000); // NOT used as the end
    // in-play (just after kickoff) -> skip + cancel
    expect(marketTimeDecision(config, game!, kickoff + 60_000)).toMatchObject({ ok: false, reason: 'event-started', cancelOpenOrders: true });
    // well before kickoff -> ok
    expect(marketTimeDecision(config, game!, kickoff - 2 * 60 * 60 * 1000)).toMatchObject({ ok: true });

    // Long futures with a gameStartTime but resolution weeks later -> NOT short-timed -> keeps quoting (not skipped in-play)
    const [futures] = normalizePolymarketMarket({
      id: 'f1', conditionId: 'fc1', question: 'France win 2026 World Cup',
      gameStartTime: new Date(kickoff).toISOString(),
      endDate: new Date(kickoff + 30 * 24 * 60 * 60 * 1000).toISOString(),
      outcomes: JSON.stringify(['YES']), clobTokenIds: JSON.stringify(['tok-fut'])
    }, new Map());
    expect(marketTimeDecision(config, futures!, kickoff + 60_000)).toMatchObject({ ok: true });
  });

  it('uses active Predict reward end as a verifiable no-new-order deadline', () => {
    const rewardEnd = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const [predict] = normalizePredictMarket({
      id: 'm-current-reward',
      question: 'Predict current reward window',
      rewards: {
        current: {
          startsAt: new Date(Date.now() - 60_000).toISOString(),
          endsAt: rewardEnd,
          hourlyRate: 3000
        }
      },
      shareThreshold: 100,
      spreadThreshold: 0.06,
      outcomes: [{ onChainId: 'token-predict', name: 'Yes' }]
    });

    expect(predict?.endTime).toBe(rewardEnd);
    expect(predict?.endTimeSource).toBe('reward-end');
    expect(predict?.rewards).toMatchObject({ enabled: true, level: 5, ppPerHour: 3000 });
  });

  it('stops new orders near settlement and requests cancel in the cancel window', () => {
    const config = appConfigSchema.parse({
      risk: { settlementNoNewOrdersMs: 30 * 60 * 1000, settlementCancelOpenOrdersMs: 10 * 60 * 1000 }
    });
    const now = Date.now();
    const noNew = marketEndDecision(config, { ...market, endTime: new Date(now + 20 * 60 * 1000).toISOString() }, now);
    expect(noNew.ok).toBe(false);
    expect(noNew.cancelOpenOrders).toBe(false);
    expect(noNew.reason).toBe('near-settlement');

    const cancel = marketEndDecision(config, { ...market, endTime: new Date(now + 5 * 60 * 1000).toISOString() }, now);
    expect(cancel.ok).toBe(false);
    expect(cancel.cancelOpenOrders).toBe(true);
    expect(cancel.reason).toBe('cancel-window');
  });

  it('blocks short event markets after event start even when reward window lasts longer', () => {
    const eventStart = Date.parse('2026-05-21T10:00:00.000Z');
    const config = appConfigSchema.parse({
      risk: {
        settlementNoNewOrdersMs: 30 * 60 * 1000,
        settlementCancelOpenOrdersMs: 10 * 60 * 1000,
        shortEventMaxDurationMs: 12 * 60 * 60 * 1000,
        eventStartNoNewOrdersMs: 30 * 60 * 1000,
        eventStartCancelOpenOrdersMs: 10 * 60 * 1000
      }
    });
    const shortEvent: Market = {
      ...market,
      question: 'Dota 2: Natus Vincere vs PlayTime (BO3)',
      startTime: new Date(eventStart).toISOString(),
      startTimeSource: 'category-start',
      endTime: new Date(eventStart + 3 * 60 * 60 * 1000).toISOString(),
      endTimeSource: 'category-end',
      rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 3000 }
    };

    const started = marketTimeDecision(config, shortEvent, eventStart + 60_000);
    expect(started).toMatchObject({
      ok: false,
      reason: 'event-started',
      cancelOpenOrders: true
    });

    const nearStart = marketStartDecision(config, shortEvent, eventStart - 20 * 60 * 1000);
    expect(nearStart).toMatchObject({
      ok: false,
      reason: 'near-event-start',
      cancelOpenOrders: false
    });

    const cancelWindow = marketStartDecision(config, shortEvent, eventStart - 5 * 60 * 1000);
    expect(cancelWindow).toMatchObject({
      ok: false,
      reason: 'event-start-cancel-window',
      cancelOpenOrders: true
    });
  });

  it('rejects final submission when BBO jumps too far between checks', () => {
    const config = appConfigSchema.parse({ risk: { maxBboMoveCents: 5 } });
    const jumped: Orderbook = {
      ...book,
      bids: [{ price: 0.78, size: 1000 }],
      asks: [{ price: 0.82, size: 1000 }]
    };
    const decision = evaluateMarketGuard(config, market, jumped, { previousBook: book });
    expect(decision.ok).toBe(false);
    expect(decision.reason).toBe('price-jump');
  });

  it('rejects when the orderbook spread changes too violently between scans', () => {
    const config = appConfigSchema.parse({ risk: { maxBboMoveCents: 20, maxSpreadMoveBps: 100 } });
    const previous: Orderbook = {
      ...book,
      bids: [{ price: 0.49, size: 1000 }],
      asks: [{ price: 0.51, size: 1000 }]
    };
    const jumped: Orderbook = {
      ...book,
      bids: [{ price: 0.45, size: 1000 }],
      asks: [{ price: 0.55, size: 1000 }]
    };

    const decision = evaluateMarketGuard(config, market, jumped, { previousBook: previous });

    expect(decision.ok).toBe(false);
    expect(decision.reason).toBe('spread-jump');
  });
});
