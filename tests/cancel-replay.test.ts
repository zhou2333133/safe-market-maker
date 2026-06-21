import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { appConfigSchema } from '../src/config/schema.js';
import type {
  AccountRiskSnapshot,
  Balance,
  Market,
  OpenOrder,
  OrderIntent,
  OrderResult,
  OrderSide,
  Orderbook,
  Position,
  PreflightResult,
  VenueName
} from '../src/domain/types.js';
import { CancelService } from '../src/execution/cancel-service.js';
import type { SignerProvider } from '../src/secrets/signer.js';
import { StateStore } from '../src/store/sqlite.js';
import type { MarketRouteCandidate } from '../src/strategy/market-router.js';
import type { VenueAdapter } from '../src/venues/types.js';

interface CancelReplayCase {
  name: string;
  mode: 'guarded' | 'replaceable';
  extraManagedTokens?: string[];
  openOrders: Array<{
    externalId: string;
    tokenId: string;
    side: OrderSide;
    price: number;
    size: number;
  }>;
  markets: Array<{
    tokenId: string;
    endTimeOffsetMs: number | null;
  }>;
  books?: Array<Omit<Orderbook, 'venue' | 'receivedAt'> & { tokenId: string }>;
  desiredIntents?: Array<{
    tokenId: string;
    side: OrderSide;
    price: number;
    size: number;
  }>;
  expectedCanceledIds: string[];
  expectedEventType?: string;
}

const fixturePath = path.join(process.cwd(), 'tests', 'fixtures', 'cancel-replay.json');
const cases = JSON.parse(readFileSync(fixturePath, 'utf8')) as CancelReplayCase[];

const baseMarket: Market = {
  venue: 'predict',
  tokenId: 'token-replay',
  question: 'Cancel replay market',
  volume24hUsd: 10000,
  liquidityUsd: 15000,
  acceptingOrders: true,
  endTime: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  endTimeSource: 'market-end',
  negRisk: false,
  feeRateBps: 0,
  tickSize: 0.01,
  rewards: { enabled: true, level: 5, minShares: 10, maxSpreadCents: 6 }
};

const fallbackBook: Orderbook = {
  venue: 'predict',
  tokenId: baseMarket.tokenId,
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

describe('cancel replay safety', () => {
  for (const replayCase of cases) {
    it(`replays ${replayCase.name}`, async () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-cancel-replay-'));
      const store = new StateStore(path.join(dir, 'state.sqlite'));
      const now = Date.now();
      const markets = replayCase.markets.map((market) => replayMarket(market.tokenId, market.endTimeOffsetMs, now));
      const books = replayBooks(replayCase);
      const openOrders = replayCase.openOrders.map(replayOpenOrder);
      const intents = (replayCase.desiredIntents ?? []).map((intent) => replayIntent(intent, markets));
      const venue = new ReplayVenue(books);
      const config = appConfigSchema.parse({
        liveEnabled: true,
        risk: {
          orderSizeUsd: 10,
          maxSingleOrderUsd: 100,
          maxPositionUsd: 200,
          settlementNoNewOrdersMs: 30 * 60 * 1000,
          settlementCancelOpenOrdersMs: 10 * 60 * 1000,
          blockUnknownEndTime: true
        },
        strategy: {
          minMarketLiquidityUsd: 0,
          minRewardLevel: 0,
          replaceThresholdTicks: 1,
          cancelOutsideReward: true
        },
        selectedMarkets: {
          predict: markets.map((market) => market.tokenId),
          polymarket: []
        }
      });

      try {
        openOrders.forEach((order) => recordReplayManagedOrder(store, order, markets));
        const service = new CancelService(config, venue, store);
        const cancelResult = replayCase.mode === 'guarded'
          ? await service.cancelGuardedOrders('predict', openOrders, markets.map(routeCandidate), markets)
          : await service.cancelReplaceableOrders(
              'predict',
              openOrders,
              intents,
              markets,
              books,
              replayCase.extraManagedTokens ?? []
            );
        const remaining = Array.isArray(cancelResult) ? cancelResult : cancelResult.openOrders;

        expect(venue.canceledIds).toEqual(replayCase.expectedCanceledIds);
        expect(remaining.map((order) => order.externalId).sort()).toEqual(
          openOrders
            .filter((order) => !replayCase.expectedCanceledIds.includes(order.externalId))
            .map((order) => order.externalId)
            .sort()
        );
        if (replayCase.expectedEventType) {
          const event = store.listRecentEvents(10).find((item) => item.type === replayCase.expectedEventType);
          expect(event?.details).toMatchObject({ ids: replayCase.expectedCanceledIds });
        } else {
          expect(store.listRecentEvents(10).some((event) => event.type.includes('cancel'))).toBe(false);
        }
      } finally {
        store.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

class ReplayVenue implements VenueAdapter {
  readonly name: VenueName = 'predict';
  readonly canceledIds: string[] = [];

  constructor(private readonly books: Map<string, Orderbook>) {}

  async testConnection(): Promise<boolean> {
    return true;
  }

  async getMarkets(): Promise<Market[]> {
    return [];
  }

  async getOrderbook(tokenId: string): Promise<Orderbook> {
    return this.books.get(tokenId) ?? { ...fallbackBook, tokenId };
  }

  async getBalances(): Promise<Balance[]> {
    return [];
  }

  async getPositions(): Promise<Position[]> {
    return [];
  }

  async getOpenOrders(): Promise<OpenOrder[]> {
    return [];
  }

  async getAccountRiskSnapshot(address: string, _signer: SignerProvider, sinceTs: number): Promise<AccountRiskSnapshot> {
    return {
      venue: this.name,
      account: address,
      source: 'venue',
      capturedAt: Date.now(),
      dayStart: sinceTs,
      realizedPnlUsd: 0,
      unrealizedPnlUsd: 0,
      netCashflowUsd: 0,
      equityUsd: 1000,
      fills: [],
      positions: [],
      balances: [],
      warnings: []
    };
  }

  async preflight(): Promise<PreflightResult> {
    return { ok: true, venue: this.name, checks: [] };
  }

  async createOrder(intent: OrderIntent): Promise<OrderResult> {
    return { venue: this.name, clientOrderId: intent.clientOrderId, status: 'OPEN' };
  }

  async cancelOrders(orderIds: string[]): Promise<void> {
    this.canceledIds.push(...orderIds);
  }
}

function replayMarket(tokenId: string, endTimeOffsetMs: number | null, now: number): Market {
  return {
    ...baseMarket,
    tokenId,
    question: `Cancel replay ${tokenId}`,
    ...(endTimeOffsetMs === null
      ? { endTime: undefined, endTimeSource: undefined }
      : { endTime: new Date(now + endTimeOffsetMs).toISOString(), endTimeSource: 'market-end' as const })
  };
}

function replayBooks(replayCase: CancelReplayCase): Map<string, Orderbook> {
  return new Map((replayCase.books ?? []).map((book) => [
    book.tokenId,
    {
      venue: 'predict',
      tokenId: book.tokenId,
      receivedAt: Date.now(),
      bids: book.bids,
      asks: book.asks
    }
  ]));
}

function replayOpenOrder(order: CancelReplayCase['openOrders'][number]): OpenOrder {
  return {
    venue: 'predict',
    externalId: order.externalId,
    tokenId: order.tokenId,
    side: order.side,
    price: order.price,
    size: order.size,
    status: 'OPEN'
  };
}

function replayIntent(
  intent: NonNullable<CancelReplayCase['desiredIntents']>[number],
  markets: Market[]
): OrderIntent {
  const market = markets.find((item) => item.tokenId === intent.tokenId) ?? replayMarket(intent.tokenId, 60 * 60 * 1000, Date.now());
  return {
    venue: 'predict',
    market,
    tokenId: intent.tokenId,
    side: intent.side,
    price: intent.price,
    size: intent.size,
    notionalUsd: Number((intent.price * intent.size).toFixed(4)),
    postOnly: true,
    reason: 'cancel-replay',
    clientOrderId: `cancel-replay-${intent.tokenId}-${intent.side}`,
    reward: { optimizer: 'cancel-replay', score: 10, level: 5, minShares: 10, maxSpreadCents: 6 }
  };
}

function routeCandidate(market: Market): MarketRouteCandidate {
  return {
    market,
    side: 'BUY',
    score: 0,
    tradable: false,
    reasons: [],
    riskFlags: [],
    metrics: {
      ppPerHour: market.rewards?.ppPerHour ?? 0,
      rewardLevel: market.rewards?.level ?? 0,
      rewardBandDepthUsd: 0,
      topDepthUsd: 0,
      competitionBand: 'unknown',
      targetOrderUsd: 10,
      liquidityUsd: market.liquidityUsd,
      volume24hUsd: market.volume24hUsd
    }
  };
}

function recordReplayManagedOrder(store: StateStore, order: OpenOrder, markets: Market[]): void {
  const market = markets.find((item) => item.tokenId === order.tokenId) ?? replayMarket(order.tokenId, 60 * 60 * 1000, Date.now());
  const intent: OrderIntent = {
    venue: order.venue,
    market,
    tokenId: order.tokenId,
    side: order.side,
    price: order.price,
    size: order.size,
    notionalUsd: Number((order.price * order.size).toFixed(4)),
    postOnly: true,
    liquidity: 'maker',
    reason: 'cancel-replay-managed',
    clientOrderId: `${order.venue}-${order.tokenId}-${order.side}-${order.externalId}`
  };
  store.recordPlannedOrder(intent, 'live');
  store.recordOrderResult({ venue: order.venue, clientOrderId: intent.clientOrderId, externalId: order.externalId, status: 'OPEN' });
}
