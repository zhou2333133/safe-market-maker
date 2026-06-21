import { describe, expect, it } from 'vitest';
import { appConfigSchema } from '../src/config/schema.js';
import type { Market, OrderIntent, OrderResult, Orderbook, PreflightResult } from '../src/domain/types.js';
import type { SignerProvider } from '../src/secrets/signer.js';
import { submitLiveManualOrder } from '../src/ui/server.js';
import type { VenueAdapter } from '../src/venues/types.js';

const signer: SignerProvider = {
  address: '0x1111111111111111111111111111111111111111',
  async signMessage() {
    return '0xsig';
  },
  async signTypedData() {
    return '0xtyped';
  }
};

const market: Market = {
  venue: 'predict',
  tokenId: 'token-1',
  question: 'Manual order safety?',
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

const initialBook: Orderbook = {
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

function intent(overrides: Partial<OrderIntent> = {}): OrderIntent {
  return {
    venue: 'predict',
    market,
    tokenId: market.tokenId,
    side: 'BUY',
    price: 0.49,
    size: 16,
    notionalUsd: 7.84,
    postOnly: true,
    reason: 'manual-ui-live',
    clientOrderId: 'manual-test-order',
    ...overrides
  };
}

class ManualMockVenue implements VenueAdapter {
  readonly name = 'predict' as const;
  createCalls = 0;
  failCreateOrder = false;

  constructor(private readonly finalBook: Orderbook) {}

  async testConnection(): Promise<boolean> {
    return true;
  }

  async getMarkets(): Promise<Market[]> {
    return [market];
  }

  async getOrderbook(): Promise<Orderbook> {
    return this.finalBook;
  }

  async getBalances() {
    return [{ asset: 'USDT', available: 100, total: 100 }];
  }

  async getPositions() {
    return [];
  }

  async getOpenOrders() {
    return [];
  }

  async preflight(): Promise<PreflightResult> {
    return { ok: true, venue: this.name, checks: [] };
  }

  async createOrder(orderIntent: OrderIntent): Promise<OrderResult> {
    this.createCalls += 1;
    if (this.failCreateOrder) throw new Error('manual submit unavailable');
    return {
      venue: this.name,
      clientOrderId: orderIntent.clientOrderId,
      externalId: 'remote-order',
      status: 'OPEN'
    };
  }

  async cancelOrders(): Promise<void> {
    return undefined;
  }
}

describe('manual order safety', () => {
  it('records a structured final market-guard reject when BBO jumps before manual submit', async () => {
    const events: unknown[] = [];
    const config = appConfigSchema.parse({
      liveEnabled: true,
      risk: { maxBboMoveCents: 5, maxSingleOrderUsd: 100, maxPositionUsd: 200 }
    });
    const venue = new ManualMockVenue({
      ...initialBook,
      bids: [{ price: 0.78, size: 1000 }, { price: 0.77, size: 1000 }, { price: 0.76, size: 1000 }],
      asks: [{ price: 0.82, size: 1000 }, { price: 0.83, size: 1000 }, { price: 0.84, size: 1000 }]
    });

    await expect(submitLiveManualOrder(
      venue,
      signer,
      intent(),
      config,
      [],
      [],
      initialBook,
      { recordEvent: (event: unknown) => events.push(event) }
    )).rejects.toThrow('最终盘口保护拒绝手动实盘订单');

    expect(venue.createCalls).toBe(0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'manual-order.final-market-guard-reject',
      details: {
        reject: {
          reason_code: 'MARKET_PRICE_JUMP',
          category: 'market',
          stage: 'manual-final-orderbook-check'
        }
      }
    });
  });

  it('records a structured final risk reject before manual submit', async () => {
    const events: unknown[] = [];
    const config = appConfigSchema.parse({
      liveEnabled: true,
      risk: { maxSingleOrderUsd: 100, maxPositionUsd: 200, requirePostOnly: true }
    });
    const venue = new ManualMockVenue(initialBook);

    await expect(submitLiveManualOrder(
      venue,
      signer,
      intent({ postOnly: false }),
      config,
      [],
      [],
      initialBook,
      { recordEvent: (event: unknown) => events.push(event) }
    )).rejects.toThrow('最终盘口复检拒绝手动实盘订单');

    expect(venue.createCalls).toBe(0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'manual-order.final-risk-reject',
      details: {
        reject: {
          reason_code: 'POST_ONLY_REQUIRED',
          category: 'risk',
          stage: 'manual-final-orderbook-check'
        }
      }
    });
  });

  it('marks a planned manual order unknown when the submit endpoint throws', async () => {
    const events: unknown[] = [];
    const config = appConfigSchema.parse({
      liveEnabled: true,
      risk: { maxSingleOrderUsd: 100, maxPositionUsd: 200 }
    });
    const venue = new ManualMockVenue(initialBook);
    venue.failCreateOrder = true;

    await expect(submitLiveManualOrder(
      venue,
      signer,
      intent(),
      config,
      [],
      [],
      initialBook,
      {
        recordEvent: (event: unknown) => events.push(event),
        markPlannedOrderRejected: (clientOrderId: string, reason: string, details: unknown) => events.push({
          type: 'mark-rejected',
          clientOrderId,
          reason,
          details
        }),
        markPlannedOrderUnknown: (clientOrderId: string, reason: string, details: unknown) => events.push({
          type: 'mark-unknown',
          clientOrderId,
          reason,
          details
        })
      }
    )).rejects.toThrow('manual submit unavailable');

    expect(venue.createCalls).toBe(1);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'mark-unknown',
      clientOrderId: 'manual-test-order',
      reason: 'submit-exception'
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: 'manual-order.submit-error',
      details: expect.objectContaining({
        reject: expect.objectContaining({
          reason_code: 'SUBMIT_EXCEPTION',
          category: 'platform',
          stage: 'manual-order'
        })
      })
    }));
  });
});
