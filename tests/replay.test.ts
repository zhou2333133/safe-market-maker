import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { appConfigSchema } from '../src/config/schema.js';
import type { Market, Orderbook } from '../src/domain/types.js';
import { evaluateSubmitGuard } from '../src/execution/submit-guard.js';
import { evaluateMarketGuard, type MarketGuardReason } from '../src/risk/market-guard.js';
import { RiskEngine } from '../src/risk/risk-engine.js';
import { StrategyEngine } from '../src/strategy/strategy-engine.js';

interface ReplayCase {
  name: string;
  market?: {
    endTimeOffsetMs: number | null;
    endTimeSource?: Market['endTimeSource'];
  };
  book: Omit<Orderbook, 'receivedAt'> & { receivedAtOffsetMs: number };
  finalBook?: Omit<Orderbook, 'receivedAt'> & { receivedAtOffsetMs: number };
  expectedSafe: boolean;
  expectedMarketGuard: MarketGuardReason;
  expectedCancelOpenOrders?: boolean;
  expectedSubmitGuard?: string;
}

const fixturePath = path.join(process.cwd(), 'tests', 'fixtures', 'replay-books.json');
const cases = JSON.parse(readFileSync(fixturePath, 'utf8')) as ReplayCase[];

const baseMarket: Market = {
  venue: 'predict',
  tokenId: 'token-replay',
  question: 'Replay market',
  volume24hUsd: 10000,
  liquidityUsd: 5000,
  acceptingOrders: true,
  endTime: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  endTimeSource: 'market-end',
  negRisk: false,
  feeRateBps: 0,
  tickSize: 0.01,
  rewards: { enabled: true, minShares: 9, maxSpreadCents: 6 }
};

describe('orderbook replay safety', () => {
  for (const replayCase of cases) {
    it(`evaluates ${replayCase.name}`, () => {
      const now = Date.now();
      const config = appConfigSchema.parse({
        risk: { maxSingleOrderUsd: 100, maxPositionUsd: 200 },
        strategy: { entryMode: 'cash', minMarketLiquidityUsd: 0, enforceRewardMinimum: false }
      });
      const strategy = new StrategyEngine(config);
      const risk = new RiskEngine(config);
      const market = replayMarket(replayCase, now);
      const book: Orderbook = {
        ...replayCase.book,
        receivedAt: now + replayCase.book.receivedAtOffsetMs
      };
      const marketGuard = evaluateMarketGuard(config, market, book, { now });
      expect(marketGuard.reason).toBe(replayCase.expectedMarketGuard);
      if (replayCase.expectedCancelOpenOrders !== undefined) {
        expect(marketGuard.cancelOpenOrders).toBe(replayCase.expectedCancelOpenOrders);
      }
      const intents = strategy.buildIntents('predict', [market], new Map([[market.tokenId, book]]));
      if (marketGuard.ok) expect(intents.length).toBeGreaterThan(0);
      const decisions = intents.map((intent) => risk.evaluate(intent, book, [], []));
      const safeToSubmit = intents.length > 0 && decisions.every((decision) => decision.ok);
      expect(safeToSubmit).toBe(replayCase.expectedSafe);
      if (replayCase.finalBook) {
        const firstIntent = intents[0];
        expect(firstIntent).toBeDefined();
        const finalBook: Orderbook = {
          ...replayCase.finalBook,
          receivedAt: now + replayCase.finalBook.receivedAtOffsetMs
        };
        const submitDecision = evaluateSubmitGuard({
          config,
          intent: firstIntent!,
          initialBook: book,
          freshBook: finalBook,
          positions: [],
          openOrders: []
        });
        expect(submitDecision.ok).toBe(false);
        if (!submitDecision.ok) {
          expect(submitDecision.reject.reason_code).toBe(replayCase.expectedSubmitGuard);
        }
      }
    });
  }
});

function replayMarket(replayCase: ReplayCase, now: number): Market {
  if (!replayCase.market) return baseMarket;
  if (replayCase.market.endTimeOffsetMs === null) {
    return { ...baseMarket, endTime: undefined, endTimeSource: undefined };
  }
  return {
    ...baseMarket,
    endTime: new Date(now + replayCase.market.endTimeOffsetMs).toISOString(),
    endTimeSource: replayCase.market.endTimeSource
  };
}
