import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { appConfigSchema } from '../src/config/schema.js';
import type {
  AccountRiskSnapshot,
  Balance,
  Market,
  MergePositionsResult,
  OpenOrder,
  OrderIntent,
  OrderResult,
  Orderbook,
  Position,
  PreflightResult,
  VenueName
} from '../src/domain/types.js';
import { LiquidationService } from '../src/execution/liquidation-service.js';
import type { SignerProvider } from '../src/secrets/signer.js';
import { StateStore } from '../src/store/sqlite.js';
import type { MergePositionsRequest, VenueAdapter } from '../src/venues/types.js';

const signer: SignerProvider = {
  address: '0x1111111111111111111111111111111111111111',
  async signMessage() {
    return '0xsig';
  },
  async signTypedData() {
    return '0xtyped';
  }
};

const yesMarket: Market = {
  venue: 'predict',
  tokenId: 'token-yes',
  marketId: 'market-1',
  conditionId: 'condition-1',
  outcome: 'Yes',
  outcomeCount: 2,
  question: 'Merge safely?',
  volume24hUsd: 10000,
  liquidityUsd: 15000,
  acceptingOrders: true,
  endTime: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  endTimeSource: 'market-end',
  negRisk: false,
  feeRateBps: 0,
  tickSize: 0.01,
  rewards: { enabled: true, minShares: 100, maxSpreadCents: 6 }
};

const noMarket: Market = {
  ...yesMarket,
  tokenId: 'token-no',
  outcome: 'No'
};

const book: Orderbook = {
  venue: 'predict',
  tokenId: yesMarket.tokenId,
  receivedAt: Date.now(),
  bids: [{ price: 0.49, size: 1000 }],
  asks: [{ price: 0.51, size: 1000 }]
};

class MockVenue implements VenueAdapter {
  readonly name: VenueName;
  cancelCalls = 0;
  canceledIds: string[] = [];
  mergeCalls = 0;
  mergeRequests: MergePositionsRequest[] = [];
  failGasCheck = false;
  markets: Market[] = [yesMarket, noMarket];

  constructor(venue: VenueName = 'predict', private readonly supportMerge = true) {
    this.name = venue;
  }

  async testConnection(): Promise<boolean> {
    return true;
  }

  async getMarkets(): Promise<Market[]> {
    return this.markets;
  }

  async getOrderbook(): Promise<Orderbook> {
    return book;
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

  async estimateSplitMergeGas() {
    if (this.failGasCheck) throw new Error('BNB RPC timeout');
    return { asset: 'BNB', balance: 1, required: 0.0001, ok: true, message: '1 BNB' };
  }

  async createOrder(intent: OrderIntent): Promise<OrderResult> {
    return { venue: this.name, clientOrderId: intent.clientOrderId, externalId: 'order', status: 'OPEN' };
  }

  async mergePositions(request: MergePositionsRequest): Promise<MergePositionsResult> {
    if (!this.supportMerge) throw new Error('merge unsupported');
    this.mergeCalls += 1;
    this.mergeRequests.push(request);
    return { venue: this.name, conditionId: request.conditionId, amountUsd: request.amountUsd, txHash: 'merge-1' };
  }

  async cancelOrders(orderIds: string[]): Promise<void> {
    this.cancelCalls += 1;
    this.canceledIds.push(...orderIds);
  }
}

describe('liquidation service', () => {
  it('cancels same-market maker orders and merges complete YES/NO sets instead of market-selling', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config = appConfigSchema.parse({
      liveEnabled: true,
      strategy: { onFillAction: 'sellAllAtMarket' }
    });
    const venue = new MockVenue();
    const positions: Position[] = [
      { venue: 'predict', tokenId: yesMarket.tokenId, size: 10, notionalUsd: 5 },
      { venue: 'predict', tokenId: noMarket.tokenId, size: 8, notionalUsd: 4 }
    ];
    const openOrders: OpenOrder[] = [{
      venue: 'predict',
      externalId: 'old-maker',
      tokenId: yesMarket.tokenId,
      side: 'SELL',
      price: 0.52,
      size: 10,
      status: 'OPEN'
    }];
    try {
      const result = await new LiquidationService(config, venue, store).process({
        venue: 'predict',
        signer,
        positions,
        openOrders,
        markets: [yesMarket, noMarket]
      });

      expect(result).toEqual({ attempted: true, submitted: 1 });
      expect(venue.canceledIds).toEqual(['old-maker']);
      expect(venue.mergeCalls).toBe(1);
      expect(venue.mergeRequests[0]).toMatchObject({ conditionId: 'condition-1', amountUsd: 8 });
      expect(store.listRecentEvents(20).some((event) => event.type === 'fill.cancel-before-merge')).toBe(true);
      expect(store.listRecentEvents(20).some((event) => event.type === 'fill.merge-submitted')).toBe(true);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('holds incomplete inventory instead of selling it at market', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config = appConfigSchema.parse({
      liveEnabled: true,
      strategy: { onFillAction: 'sellAllAtMarket' }
    });
    const venue = new MockVenue();
    try {
      const result = await new LiquidationService(config, venue, store).process({
        venue: 'predict',
        signer,
        positions: [{ venue: 'predict', tokenId: yesMarket.tokenId, size: 10, notionalUsd: 5 }],
        openOrders: [],
        markets: [yesMarket, noMarket]
      });

      expect(result).toEqual({ attempted: true, submitted: 0 });
      expect(venue.mergeCalls).toBe(0);
      const event = store.listRecentEvents(20).find((item) => item.type === 'fill.merge-not-ready');
      expect(event?.details).toMatchObject({
        reject: { reason_code: 'MERGE_EXIT_INCOMPLETE_SET', category: 'liquidation', stage: 'liquidation' }
      });
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('blocks merge without canceling current makers when the gas RPC check is unavailable', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config = appConfigSchema.parse({
      liveEnabled: true,
      strategy: { onFillAction: 'sellAllAtMarket' }
    });
    const venue = new MockVenue();
    venue.failGasCheck = true;
    const positions: Position[] = [
      { venue: 'predict', tokenId: yesMarket.tokenId, size: 10, notionalUsd: 5 },
      { venue: 'predict', tokenId: noMarket.tokenId, size: 10, notionalUsd: 5 }
    ];
    const openOrders: OpenOrder[] = [{
      venue: 'predict',
      externalId: 'old-maker',
      tokenId: yesMarket.tokenId,
      side: 'SELL',
      price: 0.52,
      size: 10,
      status: 'OPEN'
    }];
    try {
      const result = await new LiquidationService(config, venue, store).process({
        venue: 'predict',
        signer,
        positions,
        openOrders,
        markets: [yesMarket, noMarket]
      });

      expect(result).toEqual({ attempted: true, submitted: 0, failed: 1 });
      expect(venue.cancelCalls).toBe(0);
      expect(venue.mergeCalls).toBe(0);
      const event = store.listRecentEvents(20).find((item) => item.type === 'fill.merge-blocked');
      expect(event?.message).toContain('gas 检查暂不可用');
      expect(event?.details).toMatchObject({
        reject: { reason_code: 'PREDICT_GAS_CHECK_UNAVAILABLE', category: 'liquidation', stage: 'merge-exit' }
      });
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not use market selling when merge exit is unsupported', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config = appConfigSchema.parse({
      liveEnabled: true,
      strategy: { onFillAction: 'sellAllAtMarket' }
    });
    const venue = new MockVenue('polymarket');
    try {
      const result = await new LiquidationService(config, venue, store).process({
        venue: 'polymarket',
        signer,
        positions: [{ venue: 'polymarket', tokenId: yesMarket.tokenId, size: 10, notionalUsd: 5 }],
        openOrders: [],
        markets: [{ ...yesMarket, venue: 'polymarket' }]
      });

      expect(result).toEqual({ attempted: true, submitted: 0 });
      const event = store.listRecentEvents(20).find((item) => item.type === 'fill.merge-unsupported');
      expect(event?.details).toMatchObject({
        reject: { reason_code: 'MERGE_EXIT_UNSUPPORTED', category: 'liquidation', stage: 'liquidation' }
      });
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
