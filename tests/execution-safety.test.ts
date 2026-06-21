import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { appConfigSchema, type AppConfig } from '../src/config/schema.js';
import type {
  AccountRiskSnapshot,
  Balance,
  Market,
  OpenOrder,
  OrderIntent,
  OrderResult,
  Orderbook,
  Position,
  PreflightResult,
  MergePositionsResult,
  NativeGasBalance,
  SplitPositionsResult,
  VenueName
} from '../src/domain/types.js';
import { ExecutionEngine } from '../src/execution/engine.js';
import { clearSharedMarketCache } from '../src/execution/market-data-sync.js';
import { runPreflight } from '../src/execution/preflight.js';
import { importWallet } from '../src/secrets/keystore.js';
import type { SignerProvider } from '../src/secrets/signer.js';
import { StateStore } from '../src/store/sqlite.js';
import type { VenueAdapter } from '../src/venues/types.js';

const testSigner: SignerProvider = {
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
  marketId: 'market-1',
  conditionId: 'condition-1',
  outcome: 'Yes',
  question: 'Will safety tests pass?',
  volume24hUsd: 10000,
  liquidityUsd: 15000,
  acceptingOrders: true,
  endTime: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  endTimeSource: 'market-end',
  negRisk: false,
  feeRateBps: 0,
  tickSize: 0.01,
  rewards: { enabled: true, minShares: 9, maxSpreadCents: 6 }
};

const noMarket: Market = {
  ...market,
  tokenId: 'token-no',
  outcome: 'No'
};

const book: Orderbook = {
  venue: 'predict',
  tokenId: 'token-1',
  receivedAt: Date.now(),
  bids: [
    { price: 0.49, size: 1000 },
    { price: 0.48, size: 1000 },
    { price: 0.47, size: 1000 },
    { price: 0.46, size: 1000 }
  ],
  asks: [
    { price: 0.51, size: 1000 },
    { price: 0.52, size: 1000 },
    { price: 0.53, size: 1000 },
    { price: 0.54, size: 1000 }
  ]
};

function cashProbeBook(tokenId: string, receivedAt = Date.now(), topPrice = 0.49, topSize = 1000): Orderbook {
  const supportPrice = Number((topPrice - 0.01).toFixed(3));
  const lowerPrice = Number((supportPrice - 0.01).toFixed(3));
  return {
    ...book,
    tokenId,
    receivedAt,
    bids: [
      { price: topPrice, size: topSize },
      { price: supportPrice, size: 1000 },
      { price: lowerPrice, size: 1000 },
      { price: Number((lowerPrice - 0.01).toFixed(3)), size: 1000 }
    ],
    asks: [{ price: Number((topPrice + 0.02).toFixed(3)), size: 1000 }]
  };
}

class MockVenue implements VenueAdapter {
  readonly name: VenueName = 'predict';
  createCalls = 0;
  cancelCalls = 0;
  canceledIds: string[] = [];
  openOrders: OpenOrder[] = [];
  failOpenOrders = false;
  failPositions = false;
  failOrderbook = false;
  requireHydratedOrderbook = false;
  requestedOrderbooks: string[] = [];
  hydratedMarkets: Market[] = [];
  preserveBookTimestamps = false;
  failAccountRisk = false;
  markets: Market[] = [market];
  books: Orderbook[] = [{ ...book, receivedAt: Date.now() }];
  accountRiskSnapshot?: Partial<AccountRiskSnapshot>;
  balances: Balance[] = [{ asset: 'USDT', available: 1000, total: 1000 }];
  positions: Position[] = [];
  marketableCalls = 0;
  splitCalls = 0;
  splitRequests: Array<{ conditionId: string; amountUsd: number }> = [];
  nativeGas: NativeGasBalance = { asset: 'BNB', balance: 1, required: 0.0001, ok: true, message: '1 BNB' };
  failGasCheck = false;
  mergeCalls = 0;
  mergeRequests: Array<{ conditionId: string; amountUsd: number }> = [];

  constructor(private readonly preflightChecks: PreflightResult['checks'] = []) {}

  async testConnection(): Promise<boolean> {
    return true;
  }

  async getMarkets(): Promise<Market[]> {
    return this.markets;
  }

  hydrateFromMarkets(markets: Market[]): void {
    this.hydratedMarkets = markets;
  }

  async getOrderbook(tokenId: string): Promise<Orderbook> {
    if (this.failOrderbook) throw new Error('book unavailable');
    if (this.requireHydratedOrderbook && !this.hydratedMarkets.some((item) => item.tokenId === tokenId)) {
      throw new Error('book unavailable until adapter is hydrated');
    }
    this.requestedOrderbooks.push(tokenId);
    const nextIndex = this.books.findIndex((item) => item.tokenId === tokenId);
    const next = (nextIndex >= 0 ? this.books.splice(nextIndex, 1)[0] : this.books.shift()) ?? book;
    return { ...next, tokenId, receivedAt: this.preserveBookTimestamps ? next.receivedAt : Date.now() };
  }

  async estimateSplitMergeGas(): Promise<NativeGasBalance> {
    if (this.failGasCheck) throw new Error('BNB RPC timeout');
    return this.nativeGas;
  }

  async getBalances(): Promise<Balance[]> {
    return this.balances;
  }

  async getPositions(): Promise<Position[]> {
    if (this.failPositions) throw new Error('positions unavailable');
    return this.positions;
  }

  async getOpenOrders(): Promise<OpenOrder[]> {
    if (this.failOpenOrders) throw new Error('open orders unavailable');
    return this.openOrders;
  }

  async getAccountRiskSnapshot(address: string, _signer: SignerProvider, sinceTs: number): Promise<AccountRiskSnapshot> {
    if (this.failAccountRisk) throw new Error('account risk unavailable');
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
      positions: this.positions,
      balances: this.balances,
      warnings: [],
      ...this.accountRiskSnapshot
    };
  }

  async preflight(signer: SignerProvider): Promise<PreflightResult> {
    return {
      ok: this.preflightChecks.every((check) => check.ok),
      venue: this.name,
      signerAddress: signer.address,
      makerAddress: signer.address,
      checks: this.preflightChecks
    };
  }

  async createOrder(_intent: OrderIntent): Promise<OrderResult> {
    this.createCalls += 1;
    const externalId = `remote-${this.createCalls}`;
    this.openOrders.push({
      venue: this.name,
      externalId,
      tokenId: _intent.tokenId,
      side: _intent.side,
      price: _intent.price,
      size: _intent.size,
      status: 'OPEN',
      raw: { id: externalId }
    });
    return { venue: this.name, clientOrderId: _intent.clientOrderId, externalId, status: 'OPEN' };
  }

  async createMarketableOrder(_intent: OrderIntent): Promise<OrderResult> {
    this.marketableCalls += 1;
    this.positions = this.positions.filter((position) => position.tokenId !== _intent.tokenId);
    return { venue: this.name, clientOrderId: _intent.clientOrderId, externalId: 'liquidation-1', status: 'FILLED' };
  }

  async splitPositions(request: { conditionId: string; amountUsd: number }): Promise<SplitPositionsResult> {
    this.splitCalls += 1;
    this.splitRequests.push({ conditionId: request.conditionId, amountUsd: request.amountUsd });
    this.positions = [
      { venue: this.name, tokenId: market.tokenId, size: request.amountUsd, notionalUsd: request.amountUsd * 0.5 },
      { venue: this.name, tokenId: noMarket.tokenId, size: request.amountUsd, notionalUsd: request.amountUsd * 0.5 }
    ];
    return {
      venue: this.name,
      conditionId: request.conditionId,
      amountUsd: request.amountUsd,
      txHash: `split-${this.splitCalls}`
    };
  }

  async getNativeGasBalance(): Promise<NativeGasBalance> {
    if (this.failGasCheck) throw new Error('BNB RPC timeout');
    return this.nativeGas;
  }

  async mergePositions(request: { conditionId: string; amountUsd: number }): Promise<MergePositionsResult> {
    this.mergeCalls += 1;
    this.mergeRequests.push({ conditionId: request.conditionId, amountUsd: request.amountUsd });
    return {
      venue: this.name,
      conditionId: request.conditionId,
      amountUsd: request.amountUsd,
      txHash: `merge-${this.mergeCalls}`
    };
  }

  async cancelOrders(orderIds: string[]): Promise<void> {
    this.cancelCalls += 1;
    this.canceledIds.push(...orderIds);
    this.openOrders = this.openOrders.filter((order) => !orderIds.includes(order.externalId));
  }
}

class SlowConnectionVenue extends MockVenue {
  override async testConnection(): Promise<boolean> {
    return new Promise<boolean>(() => undefined);
  }
}

class PolymarketMockVenue extends MockVenue {
  override readonly name = 'polymarket' as const;
  override balances: Balance[] = [{ asset: 'USDC', available: 19, total: 27 }];
  override markets: Market[] = [{
    ...market,
    venue: 'polymarket' as const,
    tokenId: 'poly-token',
    marketId: 'poly-market',
    conditionId: 'poly-condition',
    rewards: { enabled: true, level: 5, minShares: 10, maxSpreadCents: 6, dailyRate: 5000 }
  }];
  override openOrders: OpenOrder[] = [];
  override books: Orderbook[] = [{
    ...book,
    venue: 'polymarket' as const,
    tokenId: 'poly-token',
    receivedAt: Date.now()
  }];

  override async getAccountRiskSnapshot(address: string, _signer: SignerProvider, sinceTs: number): Promise<AccountRiskSnapshot> {
    if (this.failAccountRisk) throw new Error('account risk unavailable');
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
      positions: this.positions,
      balances: this.balances,
      warnings: [],
      ...this.accountRiskSnapshot
    };
  }
}

describe('execution safety', () => {
  beforeEach(() => {
    clearSharedMarketCache();
  });

  it('split mode creates a complete YES/NO inventory set before quoting two SELL orders', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config = appConfigSchema.parse({
      liveEnabled: true,
      risk: { orderSizeUsd: 8, maxSingleOrderUsd: 100, maxPositionUsd: 100, maxMarkets: 1 },
      strategy: { entryMode: 'split', enforceRewardMinimum: false, minMarketLiquidityUsd: 0, minRewardLevel: 0, maxTokensPerMarket: 2 },
      selectedMarkets: { predict: [market.tokenId, noMarket.tokenId], polymarket: [] }
    });
    const venue = new MockVenue();
    venue.markets = [market, noMarket];
    venue.books = [
      { ...book, tokenId: market.tokenId, receivedAt: Date.now() },
      { ...book, tokenId: noMarket.tokenId, receivedAt: Date.now() },
      { ...book, tokenId: market.tokenId, receivedAt: Date.now() },
      { ...book, tokenId: noMarket.tokenId, receivedAt: Date.now() }
    ];
    try {
      await new ExecutionEngine(config, venue, store).runOnce({ venue: 'predict', signer: testSigner });

      expect(venue.splitCalls).toBe(1);
      expect(venue.splitRequests[0]).toMatchObject({ conditionId: 'condition-1', amountUsd: 8 });
      expect(venue.createCalls).toBe(2);
      expect(venue.openOrders.every((order) => order.side === 'SELL')).toBe(true);
      expect(new Set(venue.openOrders.map((order) => order.tokenId))).toEqual(new Set([market.tokenId, noMarket.tokenId]));
      expect(store.listRecentEvents(20).some((event) => event.type === 'split.entry.verified')).toBe(true);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fast quote-refresh only touches active markets and skips the full-universe book audit', async () => {
    const market2: Market = { ...market, tokenId: 'token-2', marketId: 'market-2', conditionId: 'condition-2' };
    const market3: Market = { ...market, tokenId: 'token-3', marketId: 'market-3', conditionId: 'condition-3' };
    const config = appConfigSchema.parse({
      liveEnabled: true,
      risk: { orderSizeUsd: 50, maxSingleOrderUsd: 100, maxPositionUsd: 100, maxMarkets: 20, settlementNoNewOrdersMs: 0, eventStartNoNewOrdersMs: 0 },
      strategy: { entryMode: 'cash', quoteSide: 'buy', dualSide: false, enforceRewardMinimum: false, minMarketLiquidityUsd: 0, minRewardLevel: 0 },
      selectedMarkets: { predict: [], polymarket: [] }
    });
    const buildBooks = (): Orderbook[] =>
      ['token-1', 'token-2', 'token-3', 'token-1', 'token-2', 'token-3'].map((tokenId) => ({ ...book, tokenId, receivedAt: Date.now() }));
    const buildOpenOrders = (): OpenOrder[] => [
      { venue: 'predict', externalId: 'managed-active', tokenId: market.tokenId, side: 'BUY', price: 0.49, size: 10, status: 'OPEN' }
    ];

    // A FULL cycle audits the entire candidate universe — every market's book is read.
    clearSharedMarketCache();
    const fullDir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const fullStore = new StateStore(path.join(fullDir, 'state.sqlite'));
    const fullVenue = new MockVenue();
    fullVenue.markets = [market, market2, market3];
    fullVenue.books = buildBooks();
    fullVenue.openOrders = buildOpenOrders();
    try {
      await new ExecutionEngine(config, fullVenue, fullStore).runOnce({ venue: 'predict', signer: testSigner, fast: false });
      expect(fullVenue.requestedOrderbooks).toContain(market2.tokenId);
      expect(fullVenue.requestedOrderbooks).toContain(market3.tokenId);
    } finally {
      fullStore.close();
      rmSync(fullDir, { recursive: true, force: true });
    }

    // A FAST tick only re-reads the markets that currently hold resting orders — never the rest of the universe.
    clearSharedMarketCache();
    const fastDir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const fastStore = new StateStore(path.join(fastDir, 'state.sqlite'));
    const fastVenue = new MockVenue();
    fastVenue.markets = [market, market2, market3];
    fastVenue.books = buildBooks();
    fastVenue.openOrders = buildOpenOrders();
    // Fast ticks reuse the most recent account-risk snapshot (full cycles refresh it); seed one so the tick isn't
    // blocked, mirroring production where a full cycle always precedes the fast ticks.
    fastStore.recordAccountRiskSnapshot({
      venue: 'predict',
      account: testSigner.address,
      source: 'venue',
      capturedAt: Date.now(),
      dayStart: Date.now() - 3_600_000,
      realizedPnlUsd: 0,
      unrealizedPnlUsd: 0,
      netCashflowUsd: 0,
      equityUsd: 1000,
      fills: [],
      positions: [],
      balances: [{ asset: 'USDT', available: 1000, total: 1000 }],
      warnings: []
    });
    // Fast ticks read resting orders from the store cache (not getOpenOrders REST), so seed the active order there.
    recordManagedOpenOrder(fastStore, fastVenue.openOrders[0]!, market);
    try {
      await new ExecutionEngine(config, fastVenue, fastStore).runOnce({ venue: 'predict', signer: testSigner, fast: true });
      expect(fastVenue.requestedOrderbooks).toContain(market.tokenId);
      expect(fastVenue.requestedOrderbooks).not.toContain(market2.tokenId);
      expect(fastVenue.requestedOrderbooks).not.toContain(market3.tokenId);
    } finally {
      fastStore.close();
      rmSync(fastDir, { recursive: true, force: true });
    }
  });

  it('cash single-leg mode trips a fill circuit breaker and cancels only managed orders when any position appears', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config = appConfigSchema.parse({
      liveEnabled: true,
      risk: {
        orderSizeUsd: 50,
        maxSingleOrderUsd: 100,
        maxPositionUsd: 100,
        maxMarkets: 20,
        settlementNoNewOrdersMs: 0,
        eventStartNoNewOrdersMs: 0
      },
      strategy: {
        entryMode: 'cash',
        quoteSide: 'buy',
        dualSide: false,
        enforceRewardMinimum: false,
        minMarketLiquidityUsd: 0,
        minRewardLevel: 0
      },
      selectedMarkets: { predict: [], polymarket: [] }
    });
    const venue = new MockVenue();
    venue.markets = [market];
    venue.positions = [{ venue: 'predict', tokenId: market.tokenId, marketId: market.marketId, conditionId: market.conditionId, outcome: 'Yes', size: 1, notionalUsd: 0.5 }];
    venue.openOrders = [
      {
        venue: 'predict',
        externalId: 'managed-open',
        tokenId: market.tokenId,
        side: 'BUY',
        price: 0.49,
        size: 10,
        status: 'OPEN'
      },
      {
        venue: 'predict',
        externalId: 'manual-open',
        tokenId: 'manual-token',
        side: 'BUY',
        price: 0.49,
        size: 10,
        status: 'OPEN'
      }
    ];
    store.recordPlannedOrder({
      venue: 'predict',
      market,
      tokenId: market.tokenId,
      side: 'BUY',
      price: 0.49,
      size: 10,
      notionalUsd: 4.9,
      postOnly: true,
      liquidity: 'maker',
      reason: 'managed-test',
      clientOrderId: 'managed-test-client'
    }, 'live');
    store.recordOrderResult({
      venue: 'predict',
      clientOrderId: 'managed-test-client',
      externalId: 'managed-open',
      status: 'OPEN'
    });
    try {
      const result = await new ExecutionEngine(config, venue, store).runOnce({ venue: 'predict', signer: testSigner });

      expect(venue.canceledIds).toEqual(['managed-open']);
      expect(venue.createCalls).toBe(0);
      expect(result.stopRequested).toBeUndefined();
      expect(venue.openOrders.map((order) => order.externalId)).toEqual(['manual-open']);
      expect(store.listRecentEvents(10).some((event) => event.type === 'fill-circuit-breaker.triggered')).toBe(true);
      expect(store.listRecentEvents(10).some((event) => event.type === 'fill-circuit-breaker.cancel-managed')).toBe(true);
      expect(store.getCheckpoint('stage.predict')?.value).toMatchObject({
        stage: 'idle',
        message: expect.stringContaining('成交保护')
      });
      expect(store.getCheckpoint('route.predict')?.value).toMatchObject({
        fillCircuitBreaker: true,
        selected: [],
        reason: expect.stringContaining('只有总止损金额触发才停止实盘')
      });
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('cash fill circuit breaker still cancels managed orders when account snapshot is unavailable', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config = appConfigSchema.parse({
      liveEnabled: true,
      risk: {
        orderSizeUsd: 50,
        maxSingleOrderUsd: 100,
        maxPositionUsd: 100,
        maxMarkets: 20,
        settlementNoNewOrdersMs: 0,
        eventStartNoNewOrdersMs: 0
      },
      strategy: {
        entryMode: 'cash',
        quoteSide: 'buy',
        dualSide: false,
        enforceRewardMinimum: false,
        minMarketLiquidityUsd: 0,
        minRewardLevel: 0
      },
      selectedMarkets: { predict: [], polymarket: [] }
    });
    const venue = new MockVenue();
    venue.failAccountRisk = true;
    venue.markets = [market];
    venue.positions = [{ venue: 'predict', tokenId: market.tokenId, marketId: market.marketId, conditionId: market.conditionId, outcome: 'Yes', size: 1, notionalUsd: 0.5 }];
    venue.openOrders = [
      {
        venue: 'predict',
        externalId: 'managed-open',
        tokenId: market.tokenId,
        side: 'BUY',
        price: 0.49,
        size: 10,
        status: 'OPEN'
      }
    ];
    store.recordPlannedOrder({
      venue: 'predict',
      market,
      tokenId: market.tokenId,
      side: 'BUY',
      price: 0.49,
      size: 10,
      notionalUsd: 4.9,
      postOnly: true,
      liquidity: 'maker',
      reason: 'managed-test',
      clientOrderId: 'managed-test-client'
    }, 'live');
    store.recordOrderResult({
      venue: 'predict',
      clientOrderId: 'managed-test-client',
      externalId: 'managed-open',
      status: 'OPEN'
    });
    try {
      await new ExecutionEngine(config, venue, store).runOnce({ venue: 'predict', signer: testSigner });

      expect(venue.canceledIds).toEqual(['managed-open']);
      expect(venue.createCalls).toBe(0);
      expect(store.listRecentEvents(10).some((event) => event.type === 'fill-circuit-breaker.triggered')).toBe(true);
      expect(store.listRecentEvents(10).some((event) => event.type === 'risk.account-snapshot.unavailable')).toBe(true);
      expect(store.getLatestAccountRiskDecision('predict')).toMatchObject({
        ok: false,
        reason: 'snapshot-unavailable'
      });
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('cash fill circuit breaker throttles duplicate trigger events while the same position remains', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config = appConfigSchema.parse({
      liveEnabled: true,
      risk: {
        orderSizeUsd: 50,
        maxSingleOrderUsd: 100,
        maxPositionUsd: 100,
        maxMarkets: 20,
        settlementNoNewOrdersMs: 0,
        eventStartNoNewOrdersMs: 0
      },
      strategy: {
        entryMode: 'cash',
        quoteSide: 'buy',
        dualSide: false,
        enforceRewardMinimum: false,
        minMarketLiquidityUsd: 0,
        minRewardLevel: 0
      },
      selectedMarkets: { predict: [], polymarket: [] }
    });
    const venue = new MockVenue();
    venue.markets = [market];
    venue.positions = [{ venue: 'predict', tokenId: market.tokenId, marketId: market.marketId, conditionId: market.conditionId, outcome: 'Yes', size: 1, notionalUsd: 0.5 }];
    try {
      await new ExecutionEngine(config, venue, store).runOnce({ venue: 'predict', signer: testSigner });
      venue.positions = [
        ...venue.positions,
        { venue: 'predict', tokenId: noMarket.tokenId, marketId: noMarket.marketId, conditionId: noMarket.conditionId, outcome: 'No', size: 2, notionalUsd: 1 }
      ];
      await new ExecutionEngine(config, venue, store).runOnce({ venue: 'predict', signer: testSigner });

      const triggerEvents = store.listRecentEvents(20).filter((event) => event.type === 'fill-circuit-breaker.triggered');
      expect(triggerEvents).toHaveLength(1);
      expect(venue.createCalls).toBe(0);
      expect(store.getCheckpoint('fill-circuit-breaker.predict')?.value).toMatchObject({
        active: true,
        action: 'cancel-managed-and-protect'
      });
      expect(store.getCheckpoint('route.predict')?.value).toMatchObject({
        fillCircuitBreaker: true,
        selected: []
      });
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('cash fill circuit breaker exits single-leg inventory when bid is inside the configured 30 percent loss cap', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config = appConfigSchema.parse({
      liveEnabled: true,
      risk: {
        orderSizeUsd: 5,
        maxSingleOrderUsd: 100,
        maxPositionUsd: 100,
        maxMarkets: 20,
        settlementNoNewOrdersMs: 0,
        eventStartNoNewOrdersMs: 0
      },
      strategy: {
        entryMode: 'cash',
        quoteSide: 'buy',
        dualSide: false,
        cashOnFillAction: 'sellWithinLossCap',
        cashMaxExitLossPct: 30,
        enforceRewardMinimum: false,
        minMarketLiquidityUsd: 0,
        minRewardLevel: 0
      },
      selectedMarkets: { predict: [], polymarket: [] }
    });
    const venue = new MockVenue();
    venue.markets = [market];
    venue.positions = [{ venue: 'predict', tokenId: market.tokenId, marketId: market.marketId, conditionId: market.conditionId, outcome: 'Yes', market, size: 10, notionalUsd: 8, averagePrice: 0.8 }];
    venue.books = [{
      ...book,
      tokenId: market.tokenId,
      bids: [{ price: 0.58, size: 20 }],
      asks: [{ price: 0.6, size: 20 }],
      receivedAt: Date.now()
    }];
    try {
      await new ExecutionEngine(config, venue, store).runOnce({ venue: 'predict', signer: testSigner });

      expect(venue.marketableCalls).toBe(1);
      expect(venue.createCalls).toBe(0);
      const event = store.listRecentEvents(20).find((item) => item.type === 'cash-fill.exit-submitted');
      expect(event?.details).toMatchObject({
        averagePrice: 0.8,
        limitPrice: 0.56,
        maxLossPct: 30
      });
      expect(store.getCheckpoint('route.predict')?.value).toMatchObject({
        fillCircuitBreaker: true,
        cashExit: { attempted: true, submitted: 1, blocked: 0, failed: 0 }
      });
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('hydrates position markets before cash fill exit reads a Predict orderbook', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config = appConfigSchema.parse({
      liveEnabled: true,
      risk: {
        orderSizeUsd: 5,
        maxSingleOrderUsd: 100,
        maxPositionUsd: 100,
        maxMarkets: 20,
        settlementNoNewOrdersMs: 0,
        eventStartNoNewOrdersMs: 0
      },
      strategy: {
        entryMode: 'cash',
        quoteSide: 'buy',
        dualSide: false,
        cashOnFillAction: 'sellWithinLossCap',
        cashMaxExitLossPct: 30,
        enforceRewardMinimum: false,
        minMarketLiquidityUsd: 0,
        minRewardLevel: 0
      },
      selectedMarkets: { predict: [], polymarket: [] }
    });
    const venue = new MockVenue();
    venue.requireHydratedOrderbook = true;
    venue.markets = [market];
    venue.positions = [{ venue: 'predict', tokenId: market.tokenId, marketId: market.marketId, conditionId: market.conditionId, outcome: 'Yes', market, size: 10, notionalUsd: 8, averagePrice: 0.8 }];
    venue.books = [{
      ...book,
      tokenId: market.tokenId,
      bids: [{ price: 0.58, size: 20 }],
      asks: [{ price: 0.6, size: 20 }],
      receivedAt: Date.now()
    }];
    try {
      await new ExecutionEngine(config, venue, store).runOnce({ venue: 'predict', signer: testSigner });

      expect(venue.hydratedMarkets.some((item) => item.tokenId === market.tokenId)).toBe(true);
      expect(venue.marketableCalls).toBe(1);
      expect(store.getCheckpoint('route.predict')?.value).toMatchObject({
        fillCircuitBreaker: true,
        cashExit: { attempted: true, submitted: 1, blocked: 0, failed: 0 }
      });
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('cash fill circuit breaker does not sell below the configured 30 percent loss cap', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config = appConfigSchema.parse({
      liveEnabled: true,
      risk: {
        orderSizeUsd: 5,
        maxSingleOrderUsd: 100,
        maxPositionUsd: 100,
        maxMarkets: 20,
        settlementNoNewOrdersMs: 0,
        eventStartNoNewOrdersMs: 0
      },
      strategy: {
        entryMode: 'cash',
        quoteSide: 'buy',
        dualSide: false,
        cashOnFillAction: 'sellWithinLossCap',
        cashMaxExitLossPct: 30,
        enforceRewardMinimum: false,
        minMarketLiquidityUsd: 0,
        minRewardLevel: 0
      },
      selectedMarkets: { predict: [], polymarket: [] }
    });
    const venue = new MockVenue();
    venue.markets = [market];
    venue.positions = [{ venue: 'predict', tokenId: market.tokenId, marketId: market.marketId, conditionId: market.conditionId, outcome: 'Yes', market, size: 10, notionalUsd: 8, averagePrice: 0.8 }];
    venue.books = [{
      ...book,
      tokenId: market.tokenId,
      bids: [{ price: 0.55, size: 20 }],
      asks: [{ price: 0.57, size: 20 }],
      receivedAt: Date.now()
    }];
    try {
      await new ExecutionEngine(config, venue, store).runOnce({ venue: 'predict', signer: testSigner });

      expect(venue.marketableCalls).toBe(0);
      const event = store.listRecentEvents(20).find((item) => item.type === 'cash-fill.exit-blocked');
      expect(event?.message).toContain('低于最低可接受');
      expect(store.getCheckpoint('route.predict')?.value).toMatchObject({
        fillCircuitBreaker: true,
        cashExit: { attempted: true, submitted: 0, blocked: 1, failed: 0 }
      });
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses live orderbook precision for cash fill exit loss floors', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config = appConfigSchema.parse({
      liveEnabled: true,
      risk: {
        orderSizeUsd: 20,
        maxSingleOrderUsd: 20,
        maxPositionUsd: 20,
        maxMarkets: 20,
        settlementNoNewOrdersMs: 0,
        eventStartNoNewOrdersMs: 0
      },
      strategy: {
        entryMode: 'cash',
        quoteSide: 'buy',
        dualSide: false,
        cashOnFillAction: 'sellWithinLossCap',
        cashMaxExitLossPct: 10,
        enforceRewardMinimum: false,
        minMarketLiquidityUsd: 0,
        minRewardLevel: 0
      },
      selectedMarkets: { predict: [], polymarket: [] }
    });
    const venue = new MockVenue();
    const coarseMetadataMarket = { ...market, tickSize: 0.01 };
    venue.markets = [coarseMetadataMarket];
    venue.positions = [{
      venue: 'predict',
      tokenId: market.tokenId,
      marketId: market.marketId,
      conditionId: market.conditionId,
      outcome: 'Yes',
      market: coarseMetadataMarket,
      size: 1155.2279,
      notionalUsd: 21.37,
      averagePrice: 0.017
    }];
    venue.books = [{
      ...book,
      tokenId: market.tokenId,
      bids: [{ price: 0.018, size: 2000 }],
      asks: [{ price: 0.019, size: 2000 }],
      receivedAt: Date.now()
    }];
    try {
      await new ExecutionEngine(config, venue, store).runOnce({ venue: 'predict', signer: testSigner });

      expect(venue.marketableCalls).toBe(1);
      const event = store.listRecentEvents(20).find((item) => item.type === 'cash-fill.exit-submitted');
      expect(event?.details).toMatchObject({
        averagePrice: 0.017,
        limitPrice: 0.016,
        maxLossPct: 10
      });
      expect(store.getCheckpoint('route.predict')?.value).toMatchObject({
        fillCircuitBreaker: true,
        cashExit: { attempted: true, submitted: 1, blocked: 0, failed: 0 }
      });
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores sub-cent cash dust after a successful exit', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config = appConfigSchema.parse({
      liveEnabled: true,
      risk: {
        orderSizeUsd: 20,
        maxSingleOrderUsd: 20,
        maxPositionUsd: 20,
        maxMarkets: 20,
        settlementNoNewOrdersMs: 0,
        eventStartNoNewOrdersMs: 0
      },
      strategy: {
        entryMode: 'cash',
        quoteSide: 'buy',
        dualSide: false,
        cashOnFillAction: 'sellWithinLossCap',
        cashMaxExitLossPct: 10,
        enforceRewardMinimum: false,
        minMarketLiquidityUsd: 0,
        minRewardLevel: 0
      },
      selectedMarkets: { predict: [], polymarket: [] }
    });
    const venue = new MockVenue();
    venue.markets = [market];
    venue.positions = [{
      venue: 'predict',
      tokenId: market.tokenId,
      marketId: market.marketId,
      conditionId: market.conditionId,
      outcome: 'Yes',
      market,
      size: 0.027965038184026892,
      notionalUsd: 0,
      averagePrice: 0.017
    }];
    venue.books = [{
      ...book,
      tokenId: market.tokenId,
      bids: [{ price: 0.018, size: 2000 }],
      asks: [{ price: 0.019, size: 2000 }],
      receivedAt: Date.now()
    }];
    try {
      await new ExecutionEngine(config, venue, store).runOnce({ venue: 'predict', signer: testSigner });

      expect(venue.marketableCalls).toBe(0);
      expect(store.getCheckpoint('fill-circuit-breaker.predict')?.value).toMatchObject({ active: false });
      expect(store.getCheckpoint('route.predict')?.value).not.toMatchObject({ fillCircuitBreaker: true });
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rounds the cash exit loss floor up to the next tick so loss cap is not exceeded', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config = appConfigSchema.parse({
      liveEnabled: true,
      risk: {
        orderSizeUsd: 5,
        maxSingleOrderUsd: 100,
        maxPositionUsd: 100,
        maxMarkets: 20,
        settlementNoNewOrdersMs: 0,
        eventStartNoNewOrdersMs: 0
      },
      strategy: {
        entryMode: 'cash',
        quoteSide: 'buy',
        dualSide: false,
        cashOnFillAction: 'sellWithinLossCap',
        cashMaxExitLossPct: 30,
        enforceRewardMinimum: false,
        minMarketLiquidityUsd: 0,
        minRewardLevel: 0
      },
      selectedMarkets: { predict: [], polymarket: [] }
    });
    const venue = new MockVenue();
    venue.markets = [market];
    venue.positions = [{ venue: 'predict', tokenId: market.tokenId, marketId: market.marketId, conditionId: market.conditionId, outcome: 'Yes', market, size: 10, notionalUsd: 8.05, averagePrice: 0.805 }];
    venue.books = [{
      ...book,
      tokenId: market.tokenId,
      bids: [{ price: 0.57, size: 20 }],
      asks: [{ price: 0.59, size: 20 }],
      receivedAt: Date.now()
    }];
    try {
      await new ExecutionEngine(config, venue, store).runOnce({ venue: 'predict', signer: testSigner });

      expect(venue.marketableCalls).toBe(1);
      const event = store.listRecentEvents(20).find((item) => item.type === 'cash-fill.exit-submitted');
      expect(event?.details).toMatchObject({
        averagePrice: 0.805,
        limitPrice: 0.57,
        maxLossPct: 30
      });
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('split mode uses the configured order amount for complete-set split and shrinks quotes to real inventory', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config = appConfigSchema.parse({
      liveEnabled: true,
      risk: { orderSizeUsd: 8, maxSingleOrderUsd: 100, maxPositionUsd: 100, maxMarkets: 1 },
      strategy: { entryMode: 'split', balanceReserveUsd: 0, enforceRewardMinimum: false, minMarketLiquidityUsd: 0, minRewardLevel: 0, maxTokensPerMarket: 2 },
      selectedMarkets: { predict: [market.tokenId, noMarket.tokenId], polymarket: [] }
    });
    const venue = new MockVenue();
    venue.markets = [market, noMarket];
    venue.balances = [{ asset: 'USDT', available: 10, total: 10 }];
    venue.books = [
      { ...book, tokenId: market.tokenId, receivedAt: Date.now() },
      { ...book, tokenId: noMarket.tokenId, receivedAt: Date.now() }
    ];
    try {
      await new ExecutionEngine(config, venue, store).runOnce({ venue: 'predict', signer: testSigner });

      expect(venue.splitCalls).toBe(1);
      expect(venue.splitRequests[0]).toMatchObject({ conditionId: 'condition-1', amountUsd: 8 });
      expect(venue.createCalls).toBe(2);
      expect(venue.openOrders).toHaveLength(2);
      expect(Number(venue.openOrders.reduce((sum, order) => sum + order.price * order.size, 0).toFixed(4))).toBeLessThanOrEqual(8.01);
      expect(new Set(venue.openOrders.map((order) => order.size))).toHaveLength(1);
      expect(Math.max(...venue.openOrders.map((order) => order.size))).toBeLessThanOrEqual(8);
      expect(venue.openOrders.every((order) => order.price >= 0.53)).toBe(true);
      expect(store.listRecentEvents(20).some((event) => event.type === 'split.entry.verified')).toBe(true);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('split entry chooses the same expected-PP route instead of the first metadata-safe pair', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config = appConfigSchema.parse({
      liveEnabled: true,
      risk: {
        orderSizeUsd: 5,
        maxSingleOrderUsd: 100,
        maxPositionUsd: 100,
        maxMarkets: 1,
        minDepthUsdPerSide: 0,
        settlementNoNewOrdersMs: 0,
        eventStartNoNewOrdersMs: 0
      },
      strategy: {
        entryMode: 'split',
        balanceReserveUsd: 0,
        enforceRewardMinimum: false,
        minMarketLiquidityUsd: 0,
        minRewardLevel: 0,
        maxTokensPerMarket: 2,
        candidateLimit: 4,
        conservativeDepthLevel: 2,
        retreatTicks: 0,
        switchThresholdPct: 0,
        minSwitchBenefitMultiplier: 0,
        minSwitchEdgeAfterGasUsd: 0,
        minSafeHoursForSwitch: 0
      },
      selectedMarkets: { predict: [], polymarket: [] }
    });
    const endTime = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const crowdedYes: Market = {
      ...market,
      tokenId: 'split-entry-crowded-yes',
      marketId: 'split-entry-crowded',
      conditionId: 'split-entry-crowded-condition',
      outcome: 'Yes',
      outcomeCount: 2,
      endTime,
      rewards: { enabled: true, level: 5, minShares: 10, maxSpreadCents: 6, ppPerHour: 9000 }
    };
    const crowdedNo: Market = {
      ...noMarket,
      tokenId: 'split-entry-crowded-no',
      marketId: 'split-entry-crowded',
      conditionId: 'split-entry-crowded-condition',
      outcome: 'No',
      outcomeCount: 2,
      endTime,
      rewards: { enabled: true, level: 5, minShares: 10, maxSpreadCents: 6, ppPerHour: 9000 }
    };
    const efficientYes: Market = {
      ...market,
      tokenId: 'split-entry-efficient-yes',
      marketId: 'split-entry-efficient',
      conditionId: 'split-entry-efficient-condition',
      outcome: 'Yes',
      outcomeCount: 2,
      endTime,
      rewards: { enabled: true, level: 4, minShares: 10, maxSpreadCents: 6, ppPerHour: 1000 }
    };
    const efficientNo: Market = {
      ...noMarket,
      tokenId: 'split-entry-efficient-no',
      marketId: 'split-entry-efficient',
      conditionId: 'split-entry-efficient-condition',
      outcome: 'No',
      outcomeCount: 2,
      endTime,
      rewards: { enabled: true, level: 4, minShares: 10, maxSpreadCents: 6, ppPerHour: 1000 }
    };
    const venue = new MockVenue();
    venue.markets = [crowdedYes, crowdedNo, efficientYes, efficientNo];
    venue.books = [
      { ...book, tokenId: crowdedYes.tokenId, bids: [{ price: 0.49, size: 500000 }], asks: [{ price: 0.51, size: 500000 }], receivedAt: Date.now() },
      { ...book, tokenId: crowdedNo.tokenId, bids: [{ price: 0.49, size: 500000 }], asks: [{ price: 0.51, size: 500000 }], receivedAt: Date.now() },
      { ...book, tokenId: efficientYes.tokenId, bids: [{ price: 0.49, size: 1000 }], asks: [{ price: 0.51, size: 1000 }], receivedAt: Date.now() },
      { ...book, tokenId: efficientNo.tokenId, bids: [{ price: 0.49, size: 1000 }], asks: [{ price: 0.51, size: 1000 }], receivedAt: Date.now() },
      { ...book, tokenId: efficientYes.tokenId, bids: [{ price: 0.49, size: 1000 }], asks: [{ price: 0.51, size: 1000 }], receivedAt: Date.now() },
      { ...book, tokenId: efficientNo.tokenId, bids: [{ price: 0.49, size: 1000 }], asks: [{ price: 0.51, size: 1000 }], receivedAt: Date.now() }
    ];
    try {
      await new ExecutionEngine(config, venue, store).runOnce({ venue: 'predict', signer: testSigner });

      expect(venue.splitCalls).toBe(1);
      expect(venue.splitRequests[0]).toMatchObject({ conditionId: 'split-entry-efficient-condition', amountUsd: 5 });
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('split mode refuses to split when a complete pair has inconsistent condition ids', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config = appConfigSchema.parse({
      liveEnabled: true,
      risk: { orderSizeUsd: 8, maxSingleOrderUsd: 100, maxPositionUsd: 100, maxMarkets: 1 },
      strategy: { entryMode: 'split', balanceReserveUsd: 0, enforceRewardMinimum: false, minMarketLiquidityUsd: 0, minRewardLevel: 0, maxTokensPerMarket: 2 },
      selectedMarkets: { predict: [market.tokenId, noMarket.tokenId], polymarket: [] }
    });
    const venue = new MockVenue();
    venue.markets = [
      { ...market, marketId: 'market-1', conditionId: 'market-1' },
      { ...noMarket, marketId: 'market-1', conditionId: undefined }
    ];
    venue.books = [
      { ...book, tokenId: market.tokenId, receivedAt: Date.now() },
      { ...book, tokenId: noMarket.tokenId, receivedAt: Date.now() }
    ];
    try {
      await new ExecutionEngine(config, venue, store).runOnce({ venue: 'predict', signer: testSigner });

      expect(venue.splitCalls).toBe(0);
      expect(venue.createCalls).toBe(0);
      const event = store.listRecentEvents(20).find((item) => item.type === 'split.entry.blocked');
      expect(event?.message).toContain('conditionId');
      expect(event?.details).toMatchObject({
        reject: { reason_code: 'SPLIT_ENTRY_CONDITION_MISSING', category: 'split-entry', stage: 'splitting-inventory' }
      });
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('split mode blocks before chain split when BNB gas is unavailable', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config = appConfigSchema.parse({
      liveEnabled: true,
      risk: { orderSizeUsd: 8, maxSingleOrderUsd: 100, maxPositionUsd: 100, maxMarkets: 1 },
      strategy: { entryMode: 'split', balanceReserveUsd: 0, enforceRewardMinimum: false, minMarketLiquidityUsd: 0, minRewardLevel: 0, maxTokensPerMarket: 2 },
      selectedMarkets: { predict: [market.tokenId, noMarket.tokenId], polymarket: [] }
    });
    const venue = new MockVenue();
    venue.markets = [market, noMarket];
    venue.nativeGas = {
      asset: 'BNB',
      balance: 0,
      required: 0.0001,
      ok: false,
      message: 'BNB 手续费余额不足，不能发起 split/merge 链上交易；USDT 有余额也不行。'
    };
    venue.books = [
      { ...book, tokenId: market.tokenId, receivedAt: Date.now() },
      { ...book, tokenId: noMarket.tokenId, receivedAt: Date.now() }
    ];
    try {
      await new ExecutionEngine(config, venue, store).runOnce({ venue: 'predict', signer: testSigner });

      expect(venue.splitCalls).toBe(0);
      expect(venue.createCalls).toBe(0);
      const event = store.listRecentEvents(20).find((item) => item.type === 'split.entry.blocked');
      expect(event?.message).toContain('BNB 手续费余额不足');
      expect(event?.details).toMatchObject({
        reject: { reason_code: 'PREDICT_GAS_BALANCE_LOW', category: 'split-entry', stage: 'splitting-inventory' }
      });
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('split mode blocks safely when the split gas RPC check times out', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config = appConfigSchema.parse({
      liveEnabled: true,
      risk: { orderSizeUsd: 8, maxSingleOrderUsd: 100, maxPositionUsd: 100, maxMarkets: 1 },
      strategy: { entryMode: 'split', balanceReserveUsd: 0, enforceRewardMinimum: false, minMarketLiquidityUsd: 0, minRewardLevel: 0, maxTokensPerMarket: 2 },
      selectedMarkets: { predict: [market.tokenId, noMarket.tokenId], polymarket: [] }
    });
    const venue = new MockVenue();
    venue.markets = [market, noMarket];
    venue.failGasCheck = true;
    venue.books = [
      { ...book, tokenId: market.tokenId, receivedAt: Date.now() },
      { ...book, tokenId: noMarket.tokenId, receivedAt: Date.now() }
    ];
    try {
      await new ExecutionEngine(config, venue, store).runOnce({ venue: 'predict', signer: testSigner });

      expect(venue.splitCalls).toBe(0);
      expect(venue.createCalls).toBe(0);
      const event = store.listRecentEvents(20).find((item) => item.type === 'split.entry.blocked');
      expect(event?.message).toContain('gas 检查暂不可用');
      expect(event?.details).toMatchObject({
        reject: { reason_code: 'PREDICT_GAS_CHECK_UNAVAILABLE', category: 'split-entry', stage: 'splitting-inventory' }
      });
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('live execution submits mock orders only through the guarded engine path', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config = appConfigSchema.parse({
      liveEnabled: true,
      strategy: { entryMode: 'cash', enforceRewardMinimum: false },
      risk: { maxSingleOrderUsd: 100, maxPositionUsd: 200 },
      selectedMarkets: { predict: [market.tokenId], polymarket: [] }
    });
    const venue = new MockVenue();
    try {
      await new ExecutionEngine(config, venue, store).runOnce({ venue: 'predict', signer: testSigner });
      expect(venue.createCalls).toBeGreaterThan(0);
      expect(store.status().openOrders).toBeGreaterThan(0);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('cash single-leg mode does not call split or merge when routing to a new low-competition PP market', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config = appConfigSchema.parse({
      liveEnabled: true,
      risk: {
        orderSizeUsd: 5,
        maxSingleOrderUsd: 100,
        maxPositionUsd: 100,
        maxMarkets: 1,
        minDepthUsdPerSide: 0,
        settlementNoNewOrdersMs: 0,
        eventStartNoNewOrdersMs: 0
      },
      strategy: {
        entryMode: 'cash',
        quoteSide: 'buy',
        balanceReserveUsd: 0,
        enforceRewardMinimum: false,
        minMarketLiquidityUsd: 0,
        minRewardLevel: 0,
        conservativeDepthLevel: 2,
        retreatTicks: 0
      },
      selectedMarkets: { predict: [], polymarket: [] }
    });
    const endTime = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const crowded: Market = {
      ...market,
      tokenId: 'cash-route-crowded',
      marketId: 'cash-route-crowded',
      conditionId: 'cash-route-crowded-condition',
      endTime,
      rewards: { enabled: true, level: 5, minShares: 9, maxSpreadCents: 6, ppPerHour: 1000 }
    };
    const efficient: Market = {
      ...market,
      tokenId: 'cash-route-efficient',
      marketId: 'cash-route-efficient',
      conditionId: 'cash-route-efficient-condition',
      endTime,
      rewards: { enabled: true, level: 5, minShares: 9, maxSpreadCents: 6, ppPerHour: 120 }
    };
    const venue = new MockVenue();
    venue.markets = [crowded, efficient];
    venue.books = [
      cashProbeBook(crowded.tokenId, Date.now(), 0.49, 100000),
      cashProbeBook(efficient.tokenId, Date.now(), 0.49, 220),
      cashProbeBook(efficient.tokenId, Date.now(), 0.49, 220)
    ];
    try {
      await new ExecutionEngine(config, venue, store).runOnce({ venue: 'predict', signer: testSigner });

      expect(venue.splitCalls).toBe(0);
      expect(venue.mergeCalls).toBe(0);
      expect(venue.createCalls).toBe(1);
      expect(venue.openOrders).toEqual([expect.objectContaining({ tokenId: efficient.tokenId, side: 'BUY' })]);
      const route = store.getCheckpoint('route.predict')?.value as { selected?: Array<{ tokenId?: string; side?: string }> } | undefined;
      expect(route?.selected).toEqual([expect.objectContaining({ tokenId: efficient.tokenId, side: 'BUY' })]);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips markets with unavailable orderbooks instead of crashing', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config = appConfigSchema.parse({
      liveEnabled: true,
      strategy: { entryMode: 'cash', enforceRewardMinimum: false },
      risk: { maxSingleOrderUsd: 100, maxPositionUsd: 200 },
      selectedMarkets: { predict: [market.tokenId], polymarket: [] }
    });
    const venue = new MockVenue();
    venue.failOrderbook = true;
    try {
      await new ExecutionEngine(config, venue, store).runOnce({ venue: 'predict', signer: testSigner });
      expect(venue.createCalls).toBe(0);
      expect(store.status().events).toBeGreaterThan(0);
      expect(store.status().openOrders).toBe(0);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('pauses new cash orders after a monitoring instability checkpoint but still keeps existing safe orders', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config = appConfigSchema.parse({
      liveEnabled: true,
      risk: {
        orderSizeUsd: 5,
        maxSingleOrderUsd: 100,
        maxPositionUsd: 200,
        minDepthUsdPerSide: 0,
        settlementNoNewOrdersMs: 0,
        eventStartNoNewOrdersMs: 0
      },
      strategy: {
        entryMode: 'cash',
        quoteSide: 'buy',
        balanceReserveUsd: 0,
        enforceRewardMinimum: false,
        minMarketLiquidityUsd: 0,
        minRewardLevel: 0,
        conservativeDepthLevel: 2,
        retreatTicks: 0
      },
      selectedMarkets: { predict: [market.tokenId], polymarket: [] }
    });
    const venue = new MockVenue();
    venue.openOrders = [{
      venue: 'predict',
      externalId: 'safe-existing-cash',
      tokenId: market.tokenId,
      side: 'BUY',
      price: 0.46,
      size: 10,
      status: 'OPEN'
    }];
    venue.books = [
      cashProbeBook(market.tokenId, Date.now(), 0.49, 1000),
      cashProbeBook(market.tokenId, Date.now(), 0.49, 1000),
      cashProbeBook(market.tokenId, Date.now(), 0.49, 1000)
    ];
    store.checkpoint('cash-new-order-pause.predict', {
      until: new Date(Date.now() + 60_000).toISOString(),
      reason: 'test slow cycle pause',
      source: 'test'
    });
    try {
      recordManagedOpenOrder(store, venue.openOrders[0]!, market);
      await new ExecutionEngine(config, venue, store).runOnce({ venue: 'predict', signer: testSigner });

      expect(venue.cancelCalls).toBe(0);
      expect(venue.createCalls).toBe(0);
      expect(venue.openOrders).toEqual([expect.objectContaining({ externalId: 'safe-existing-cash' })]);
      const event = store.listRecentEvents(20).find((item) => item.type === 'quote.new-orders-paused');
      expect(event?.details).toMatchObject({
        reason: 'test slow cycle pause',
        source: 'test'
      });
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('live execution replaces stale reward quotes instead of stacking exposure', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config = appConfigSchema.parse({
      liveEnabled: true,
      strategy: { entryMode: 'cash', enforceRewardMinimum: false },
      risk: { maxSingleOrderUsd: 100, maxPositionUsd: 200 },
      selectedMarkets: { predict: [market.tokenId], polymarket: [] }
    });
    const venue = new MockVenue();
    venue.openOrders = [
      {
        venue: 'predict',
        externalId: 'existing-buy',
        tokenId: market.tokenId,
        side: 'BUY',
        price: 0.49,
        size: 10,
        status: 'OPEN'
      }
    ];
    try {
      recordManagedOpenOrder(store, venue.openOrders[0]!, market);
      await new ExecutionEngine(config, venue, store).runOnce({ venue: 'predict', signer: testSigner });
      expect(venue.cancelCalls).toBe(1);
      expect(venue.canceledIds).toContain('existing-buy');
      expect(venue.createCalls).toBe(1);
      expect(store.status().events).toBeGreaterThan(0);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the current cash order during a route switch until the replacement book is fresh', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config = appConfigSchema.parse({
      liveEnabled: true,
      risk: {
        orderSizeUsd: 5,
        maxSingleOrderUsd: 100,
        maxPositionUsd: 200,
        maxMarkets: 1,
        minDepthUsdPerSide: 0,
        staleBookMs: 1,
        settlementNoNewOrdersMs: 0,
        eventStartNoNewOrdersMs: 0
      },
      strategy: {
        entryMode: 'cash',
        quoteSide: 'buy',
        balanceReserveUsd: 0,
        enforceRewardMinimum: false,
        minMarketLiquidityUsd: 0,
        minRewardLevel: 0,
        conservativeDepthLevel: 1,
        retreatTicks: 0,
        candidateLimit: 2
      },
      selectedMarkets: { predict: [], polymarket: [] }
    });
    const endTime = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const current: Market = {
      ...market,
      tokenId: 'cash-keep-current',
      marketId: 'cash-keep-current',
      conditionId: 'cash-keep-current-condition',
      endTime,
      rewards: { enabled: true, level: 5, minShares: 9, maxSpreadCents: 6, ppPerHour: 60 }
    };
    const better: Market = {
      ...market,
      tokenId: 'cash-stale-replacement',
      marketId: 'cash-stale-replacement',
      conditionId: 'cash-stale-replacement-condition',
      endTime,
      rewards: { enabled: true, level: 5, minShares: 9, maxSpreadCents: 6, ppPerHour: 240 }
    };
    const venue = new MockVenue();
    venue.preserveBookTimestamps = true;
    venue.markets = [current, better];
    venue.openOrders = [{
      venue: 'predict',
      externalId: 'current-cash-order',
      tokenId: current.tokenId,
      side: 'BUY',
      price: 0.49,
      size: 10,
      status: 'OPEN'
    }];
    venue.books = [
      cashProbeBook(current.tokenId, Date.now(), 0.49, 220),
      cashProbeBook(better.tokenId, Date.now(), 0.49, 220),
      cashProbeBook(better.tokenId, Date.now() - 1000, 0.49, 220)
    ];
    try {
      recordManagedOpenOrder(store, venue.openOrders[0]!, current);
      await new ExecutionEngine(config, venue, store).runOnce({ venue: 'predict', signer: testSigner });

      expect(venue.cancelCalls).toBe(0);
      expect(venue.createCalls).toBe(0);
      expect(venue.openOrders).toEqual([expect.objectContaining({ externalId: 'current-cash-order' })]);
      expect(store.listRecentEvents(20).some((event) => event.type === 'quote.replace-deferred')).toBe(true);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the current cash pool when stale active metadata has low liquidity but live reward depth is valid', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config = appConfigSchema.parse({
      liveEnabled: true,
      risk: {
        orderSizeUsd: 51,
        maxSingleOrderUsd: 100,
        maxPositionUsd: 200,
        maxMarkets: 1,
        minDepthUsdPerSide: 0,
        settlementNoNewOrdersMs: 0,
        eventStartNoNewOrdersMs: 0
      },
      strategy: {
        entryMode: 'cash',
        quoteSide: 'buy',
        balanceReserveUsd: 0,
        enforceRewardMinimum: false,
        minMarketLiquidityUsd: 5000,
        minRewardLevel: 0,
        conservativeDepthLevel: 2,
        retreatTicks: 0,
        switchThresholdPct: 0,
        candidateLimit: 2
      },
      selectedMarkets: { predict: [], polymarket: [] }
    });
    const endTime = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const current: Market = {
      ...market,
      tokenId: 'cash-low-metadata-current',
      marketId: 'cash-low-metadata-current',
      conditionId: 'cash-low-metadata-current-condition',
      endTime,
      liquidityUsd: 0,
      rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 240 }
    };
    const lowEfficiencyRival: Market = {
      ...market,
      tokenId: 'cash-low-efficiency-rival',
      marketId: 'cash-low-efficiency-rival',
      conditionId: 'cash-low-efficiency-rival-condition',
      endTime,
      liquidityUsd: 20000,
      rewards: { enabled: true, level: 5, minShares: 100, maxSpreadCents: 6, ppPerHour: 120 }
    };
    const venue = new MockVenue();
    venue.markets = [current, lowEfficiencyRival];
    venue.openOrders = [{
      venue: 'predict',
      externalId: 'current-low-metadata-order',
      tokenId: current.tokenId,
      side: 'BUY',
      price: 0.47,
      size: 101,
      status: 'OPEN'
    }];
    const currentBook: Orderbook = {
      ...book,
      tokenId: current.tokenId,
      bids: [
        { price: 0.5, size: 20000 },
        { price: 0.49, size: 20000 },
        { price: 0.48, size: 20000 },
        { price: 0.47, size: 20000 }
      ],
      asks: [{ price: 0.52, size: 20000 }],
      receivedAt: Date.now()
    };
    venue.books = [
      currentBook,
      { ...book, tokenId: lowEfficiencyRival.tokenId, bids: [{ price: 0.9, size: 2000000 }], asks: [{ price: 0.9, size: 2000000 }], receivedAt: Date.now() },
      { ...currentBook },
      { ...currentBook },
      { ...currentBook }
    ];
    try {
      store.checkpoint('route.predict', {
        selected: [{ tokenId: current.tokenId, marketId: current.marketId, side: 'BUY' }]
      });
      recordManagedOpenOrder(store, venue.openOrders[0]!, current);
      await new ExecutionEngine(config, venue, store).runOnce({ venue: 'predict', signer: testSigner });
      expect(venue.cancelCalls).toBe(0);
      expect(venue.createCalls).toBe(0);
      const route = store.getCheckpoint('route.predict')?.value as { selected?: Array<{ tokenId?: string; tradable?: boolean }>; best?: { tokenId?: string } } | undefined;
      expect(route?.selected).toEqual([expect.objectContaining({ tokenId: current.tokenId, tradable: true })]);
      expect(route?.best?.tokenId).toBe(current.tokenId);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('live execution allows unreserved Predict cash maker BUY even when visible balance is below the quote notional', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config = appConfigSchema.parse({
      liveEnabled: true,
      strategy: { entryMode: 'cash', balanceReserveUsd: 0, enforceRewardMinimum: false },
      risk: { maxSingleOrderUsd: 100, maxPositionUsd: 200 },
      selectedMarkets: { predict: [market.tokenId], polymarket: [] }
    });
    const venue = new MockVenue();
    venue.balances = [{ asset: 'USDT', available: 0.23, total: 0.23 }];
    try {
      await new ExecutionEngine(config, venue, store).runOnce({ venue: 'predict', signer: testSigner });
      expect(venue.createCalls).toBe(1);
      expect(store.listRecentEvents(10).some((event) => event.type === 'risk.balance-skip')).toBe(false);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('live execution stops adding orders when estimated reservation and platform frozen balance drift too far', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config = appConfigSchema.parse({
      liveEnabled: true,
      strategy: { entryMode: 'cash', balanceReserveUsd: 0, enforceRewardMinimum: false },
      risk: {
        maxSingleOrderUsd: 100,
        maxPositionUsd: 200,
        maxOpenOrderReserveDriftUsd: 2,
        maxOpenOrderReserveDriftPct: 25
      },
      selectedMarkets: { predict: [market.tokenId], polymarket: [] }
    });
    const venue = new MockVenue();
    venue.balances = [{ asset: 'USDT', available: 100, total: 150 }];
    venue.openOrders = [{
      venue: 'predict',
      externalId: 'remote-reserved-buy',
      tokenId: market.tokenId,
      side: 'BUY',
      price: 0.49,
      size: 10,
      status: 'OPEN'
    }];
    try {
      recordManagedOpenOrder(store, venue.openOrders[0]!, market);
      await new ExecutionEngine(config, venue, store).runOnce({ venue: 'predict', signer: testSigner });
      expect(venue.createCalls).toBe(0);
      const event = store.listRecentEvents(20).find((item) => item.type === 'risk.balance-skip');
      expect(event?.details).toMatchObject({
        reject: { reason_code: 'RESERVE_DRIFT_TOO_LARGE', category: 'balance', stage: 'checking-risk' }
      });
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('live execution uses remaining Polymarket BUY size for open-order reservation after partial fills', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config = appConfigSchema.parse({
      liveEnabled: true,
      strategy: { entryMode: 'cash', balanceReserveUsd: 0, quoteSide: 'buy' },
      risk: {
        orderSizeUsd: 8,
        maxSingleOrderUsd: 100,
        maxPositionUsd: 200,
        maxOpenOrderReserveDriftUsd: 2,
        maxOpenOrderReserveDriftPct: 25,
        minLiquidityUsd: 1,
        minVolume24hUsd: 1,
        maxMarkets: 1
      },
      selectedMarkets: { predict: [], polymarket: ['poly-token'] }
    });
    const venue = new PolymarketMockVenue();
    venue.openOrders = [{
      venue: 'polymarket',
      externalId: 'partially-filled-buy',
      tokenId: 'other-poly-token',
      side: 'BUY',
      price: 0.5,
      size: 16,
      status: 'OPEN',
      raw: {
        original_size: '100',
        size_matched: '84'
      }
    }];
    try {
      await new ExecutionEngine(config, venue, store).runOnce({ venue: 'polymarket', signer: testSigner });
      expect(venue.createCalls).toBe(1);
      expect(store.listRecentEvents(20).some((event) => event.type === 'risk.balance-skip')).toBe(false);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('live execution blocks markets without verifiable end time', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config = appConfigSchema.parse({
      liveEnabled: true,
      risk: { maxSingleOrderUsd: 100, maxPositionUsd: 200, blockUnknownEndTime: true },
      strategy: { marketRefreshMs: 1 },
      selectedMarkets: { predict: [market.tokenId], polymarket: [] }
    });
    const venue = new MockVenue();
    venue.markets = [{ ...market, endTime: undefined, endTimeSource: undefined }];
    try {
      await new ExecutionEngine(config, venue, store).runOnce({ venue: 'predict', signer: testSigner });
      expect(venue.createCalls).toBe(0);
      expect(store.listRecentEvents(10).some((event) => event.type === 'risk.market-guard.route-reject')).toBe(true);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('live execution cancels open orders in the settlement cancel window', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const closingMarket = { ...market, endTime: new Date(Date.now() + 5 * 60 * 1000).toISOString() };
    const config = appConfigSchema.parse({
      liveEnabled: true,
      risk: {
        maxSingleOrderUsd: 100,
        maxPositionUsd: 200,
        settlementNoNewOrdersMs: 30 * 60 * 1000,
        settlementCancelOpenOrdersMs: 10 * 60 * 1000
      },
      strategy: { marketRefreshMs: 1 },
      selectedMarkets: { predict: [market.tokenId], polymarket: [] }
    });
    const venue = new MockVenue();
    venue.markets = [closingMarket];
    venue.openOrders = [{
      venue: 'predict',
      externalId: 'near-close-order',
      tokenId: market.tokenId,
      side: 'BUY',
      price: 0.49,
      size: 100,
      status: 'OPEN'
    }];
    try {
      recordManagedOpenOrder(store, venue.openOrders[0]!, closingMarket);
      await new ExecutionEngine(config, venue, store).runOnce({ venue: 'predict', signer: testSigner });
      expect(venue.canceledIds).toContain('near-close-order');
      expect(venue.createCalls).toBe(0);
      expect(store.listRecentEvents(20).some((event) => event.type === 'risk.market-guard.cancel')).toBe(true);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('live execution rejects before submit when refreshed BBO makes the planned quote unsafe', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config = appConfigSchema.parse({
      liveEnabled: true,
      risk: { maxSingleOrderUsd: 100, maxPositionUsd: 200, maxBboMoveCents: 5 },
      strategy: { entryMode: 'cash', marketRefreshMs: 1, enforceRewardMinimum: false },
      selectedMarkets: { predict: [market.tokenId], polymarket: [] }
    });
    const venue = new MockVenue();
    venue.books = [
      { ...book, receivedAt: Date.now() },
      {
        ...book,
        receivedAt: Date.now(),
        bids: [{ price: 0.78, size: 1000 }, { price: 0.77, size: 1000 }, { price: 0.76, size: 1000 }],
        asks: [{ price: 0.82, size: 1000 }, { price: 0.83, size: 1000 }, { price: 0.84, size: 1000 }]
      }
    ];
    try {
      await new ExecutionEngine(config, venue, store).runOnce({ venue: 'predict', signer: testSigner });
      expect(venue.createCalls).toBe(0);
      expect(store.listRecentEvents(20).some((event) => ['risk.final-reject', 'risk.market-guard.final-reject'].includes(event.type))).toBe(true);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('live execution stops before syncing markets when account daily loss limit is reached', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config = appConfigSchema.parse({
      liveEnabled: true,
      risk: { maxDailyLossUsd: 10, maxSingleOrderUsd: 100, maxPositionUsd: 200 },
      selectedMarkets: { predict: [market.tokenId], polymarket: [] }
    });
    const venue = new MockVenue();
    venue.accountRiskSnapshot = { realizedPnlUsd: -12, unrealizedPnlUsd: 0 };
    try {
      await new ExecutionEngine(config, venue, store).runOnce({ venue: 'predict', signer: testSigner });
      expect(venue.createCalls).toBe(0);
      expect(store.listRecentEvents(10).some((event) => event.type === 'risk.daily-loss-limit')).toBe(true);
      expect(store.getCheckpoint('stage.predict')?.value).toMatchObject({
        stage: 'stopping',
        reason: 'daily-loss-limit'
      });
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('cancels managed orders when the total daily stop loss is reached', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config = appConfigSchema.parse({
      liveEnabled: true,
      risk: { maxDailyLossUsd: 10, maxSingleOrderUsd: 100, maxPositionUsd: 200 },
      selectedMarkets: { predict: [market.tokenId], polymarket: [] }
    });
    const venue = new MockVenue();
    venue.accountRiskSnapshot = { realizedPnlUsd: -12, unrealizedPnlUsd: 0 };
    venue.openOrders = [{
      venue: 'predict',
      externalId: 'managed-open-1',
      tokenId: market.tokenId,
      side: 'BUY',
      price: 0.5,
      size: 10,
      status: 'OPEN'
    }];
    recordManagedOpenOrder(store, venue.openOrders[0]!, market);
    try {
      const result = await new ExecutionEngine(config, venue, store).runOnce({ venue: 'predict', signer: testSigner });

      expect(result).toMatchObject({
        stopRequested: true,
        stopReason: 'daily-loss-limit',
        canceledManagedOrders: 1
      });
      expect(venue.canceledIds).toEqual(['managed-open-1']);
      expect(venue.createCalls).toBe(0);
      expect(store.listRecentEvents(20).some((event) => event.type === 'risk.daily-loss-stop.cancel-managed')).toBe(true);
      expect(store.getCheckpoint('stage.predict')?.value).toMatchObject({
        stage: 'stopping',
        reason: 'daily-loss-limit',
        canceledManagedOrders: 1
      });
      expect(store.getCheckpoint('route.predict')?.value).toMatchObject({
        stopRequested: true,
        stopReason: 'daily-loss-limit',
        selected: []
      });
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('hard-stops and exits Predict inventory before the cash-fill loss cap can mask the account stop', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config = appConfigSchema.parse({
      liveEnabled: true,
      risk: { maxDailyLossUsd: 5, maxSingleOrderUsd: 100, maxPositionUsd: 200 },
      strategy: {
        entryMode: 'cash',
        cashOnFillAction: 'sellWithinLossCap',
        cashMaxExitLossPct: 10,
        liquidationSlippageTicks: 2,
        liquidationMaxSlippageCents: 10
      },
      selectedMarkets: { predict: [market.tokenId], polymarket: [] }
    });
    const venue = new MockVenue();
    venue.accountRiskSnapshot = { realizedPnlUsd: -6, unrealizedPnlUsd: 0 };
    venue.positions = [{
      venue: 'predict',
      tokenId: market.tokenId,
      marketId: market.marketId,
      outcome: market.outcome,
      market,
      size: 10,
      notionalUsd: 4.9,
      averagePrice: 0.8
    }];
    venue.books = [{ ...book, bids: [{ price: 0.49, size: 20 }], receivedAt: Date.now() }];
    try {
      const result = await new ExecutionEngine(config, venue, store).runOnce({ venue: 'predict', signer: testSigner });

      expect(result).toMatchObject({
        stopRequested: true,
        stopReason: 'daily-loss-limit'
      });
      expect(venue.marketableCalls).toBe(1);
      expect(venue.positions).toEqual([]);
      expect(store.listRecentEvents(20).some((event) => event.type === 'fill-circuit-breaker.triggered')).toBe(false);
      expect(store.getCheckpoint('route.predict')?.value).toMatchObject({
        stopRequested: true,
        stopReason: 'daily-loss-limit',
        killExit: { attempted: true, submitted: 1, blocked: 0, failed: 0 }
      });
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not stop a new live session because of cash exit losses before the session start', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config = appConfigSchema.parse({
      liveEnabled: true,
      risk: { orderSizeUsd: 5, maxDailyLossUsd: 10, maxSingleOrderUsd: 100, maxPositionUsd: 200 },
      strategy: {
        entryMode: 'cash',
        cashProbeMinFrontDepthUsd: 0,
        enforceRewardMinimum: false,
        marketRefreshMs: 1
      },
      selectedMarkets: { predict: [market.tokenId], polymarket: [] }
    });
    const venue = new MockVenue();
    venue.books = [
      cashProbeBook(market.tokenId),
      cashProbeBook(market.tokenId),
      cashProbeBook(market.tokenId)
    ];
    try {
      store.recordEvent({
        venue: 'predict',
        severity: 'warn',
        type: 'cash-fill.exit-submitted',
        message: 'old exit before this live session',
        details: {
          intent: { tokenId: 'old-session-fill-token', side: 'SELL', price: 0.2, size: 100, notionalUsd: 20 },
          position: { tokenId: 'old-session-fill-token', marketId: 'old-session-fill-market', outcome: 'Yes', size: 100, notionalUsd: 35, averagePrice: 0.35 },
          averagePrice: 0.35,
          limitPrice: 0.2
        }
      });
      store.checkpoint('live-session.predict', {
        startedAt: new Date(Date.now() + 5).toISOString(),
        source: 'user-start',
        reason: 'test session start after old loss'
      });

      const result = await new ExecutionEngine(config, venue, store).runOnce({ venue: 'predict', signer: testSigner });

      expect(result.stopRequested).toBeUndefined();
      expect(venue.createCalls).toBe(1);
      expect(store.getLatestAccountRiskDecision('predict')).toMatchObject({
        ok: true,
        reason: 'ok',
        dailyPnlUsd: 0
      });
      expect(store.listRecentEvents(20).some((event) => event.type === 'risk.daily-loss-limit')).toBe(false);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('live execution fails closed when account risk snapshot is unavailable', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config = appConfigSchema.parse({
      liveEnabled: true,
      selectedMarkets: { predict: [market.tokenId], polymarket: [] }
    });
    const venue = new MockVenue();
    venue.failAccountRisk = true;
    try {
      await new ExecutionEngine(config, venue, store).runOnce({ venue: 'predict', signer: testSigner });
      expect(venue.createCalls).toBe(0);
      expect(store.listRecentEvents(10).some((event) => event.type === 'risk.account-snapshot.unavailable')).toBe(true);
      expect(store.getLatestAccountRiskDecision('predict')?.ok).toBe(false);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('live execution fails closed when account risk snapshot is stale', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config = appConfigSchema.parse({
      liveEnabled: true,
      risk: { maxAccountRiskStaleMs: 1000 },
      selectedMarkets: { predict: [market.tokenId], polymarket: [] }
    });
    const venue = new MockVenue();
    venue.accountRiskSnapshot = { capturedAt: Date.now() - 5000 };
    try {
      await new ExecutionEngine(config, venue, store).runOnce({ venue: 'predict', signer: testSigner });
      expect(venue.createCalls).toBe(0);
      expect(store.listRecentEvents(10).some((event) => event.type === 'risk.account-gate.blocked')).toBe(true);
      expect(store.getLatestAccountRiskDecision('predict')?.reason).toBe('snapshot-stale');
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('live execution fails closed when account PnL fields are incomplete around fills or positions', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config = appConfigSchema.parse({
      liveEnabled: true,
      selectedMarkets: { predict: [market.tokenId], polymarket: [] }
    });
    const venue = new MockVenue();
    venue.accountRiskSnapshot = {
      realizedPnlUsd: undefined,
      unrealizedPnlUsd: undefined,
      equityUsd: undefined,
      fills: [
        {
          venue: 'predict',
          id: 'fill-without-pnl',
          tokenId: market.tokenId,
          side: 'BUY',
          price: 0.5,
          size: 10,
          notionalUsd: 5,
          cashflowUsd: -5,
          ts: Date.now()
        }
      ],
      positions: [{ venue: 'predict', tokenId: market.tokenId, size: 10, notionalUsd: 5 }]
    };
    try {
      await new ExecutionEngine(config, venue, store).runOnce({ venue: 'predict', signer: testSigner });
      expect(venue.createCalls).toBe(0);
      expect(store.getLatestAccountRiskDecision('predict')?.reason).toBe('snapshot-unavailable');
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('live execution fails closed when balance is unavailable', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config = appConfigSchema.parse({
      liveEnabled: true,
      strategy: { entryMode: 'cash', balanceReserveUsd: 0, enforceRewardMinimum: false },
      risk: { maxSingleOrderUsd: 100, maxPositionUsd: 200 },
      selectedMarkets: { predict: [market.tokenId], polymarket: [] }
    });
    const venue = new MockVenue();
    venue.balances = [];
    try {
      await new ExecutionEngine(config, venue, store).runOnce({ venue: 'predict', signer: testSigner });
      expect(venue.createCalls).toBe(0);
      expect(store.listRecentEvents(10).some((event) => event.type === 'balance.empty')).toBe(true);
      expect(store.listRecentEvents(10).some((event) => event.type === 'risk.balance-skip')).toBe(true);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('live execution fails closed when open orders cannot be synced', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config = appConfigSchema.parse({
      liveEnabled: true,
      selectedMarkets: { predict: [market.tokenId], polymarket: [] }
    });
    const venue = new MockVenue();
    venue.failOpenOrders = true;
    try {
      await new ExecutionEngine(config, venue, store).runOnce({ venue: 'predict', signer: testSigner });
      expect(venue.createCalls).toBe(0);
      const event = store.listRecentEvents(10).find((item) => item.type === 'open-orders.unavailable');
      expect(event).toBeTruthy();
      expect(event?.details).toMatchObject({ reject: { reason_code: 'OPEN_ORDERS_UNAVAILABLE', category: 'platform', stage: 'syncing-orders' } });
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('live execution fails closed when positions cannot be synced', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config = appConfigSchema.parse({
      liveEnabled: true,
      selectedMarkets: { predict: [market.tokenId], polymarket: [] }
    });
    const venue = new MockVenue();
    venue.failPositions = true;
    try {
      await new ExecutionEngine(config, venue, store).runOnce({ venue: 'predict', signer: testSigner });
      expect(venue.createCalls).toBe(0);
      expect(store.listRecentEvents(10).some((event) => event.type === 'positions.unavailable')).toBe(true);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('records loop stage checkpoints and structured reject codes', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config = appConfigSchema.parse({
      liveEnabled: true,
      risk: { maxSingleOrderUsd: 100, maxPositionUsd: 200, blockUnknownEndTime: true },
      strategy: { marketRefreshMs: 1 },
      selectedMarkets: { predict: [market.tokenId], polymarket: [] }
    });
    const venue = new MockVenue();
    venue.markets = [{ ...market, endTime: undefined, endTimeSource: undefined }];
    try {
      await new ExecutionEngine(config, venue, store).runOnce({ venue: 'predict', signer: testSigner });
      const stage = store.getCheckpoint('stage.predict')?.value as { stage?: string; message?: string } | undefined;
      expect(stage?.stage).toBe('idle');
      expect(stage?.message).toContain('完成');
      const event = store.listRecentEvents(20).find((item) => item.type === 'risk.market-guard.route-reject');
      expect(event?.details).toMatchObject({ reject: { reason_code: 'ROUTE_MARKET_GUARD_REJECT', category: 'market', stage: 'routing-market' } });
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('merges complete filled inventory before placing new reward quotes when exit is requested', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config = appConfigSchema.parse({
      liveEnabled: true,
      risk: { maxSingleOrderUsd: 100, maxPositionUsd: 200 },
      selectedMarkets: { predict: [market.tokenId], polymarket: [] },
      strategy: { entryMode: 'split', onFillAction: 'sellAllAtMarket', liquidationMaxSlippageCents: 10 }
    });
    const venue = new MockVenue();
    venue.markets = [market, noMarket];
    venue.positions = [
      { venue: 'predict', tokenId: market.tokenId, size: 100, notionalUsd: 50 },
      { venue: 'predict', tokenId: noMarket.tokenId, size: 100, notionalUsd: 50 }
    ];
    venue.openOrders = [
      {
        venue: 'predict',
        externalId: 'old-maker',
        tokenId: market.tokenId,
        side: 'BUY',
        price: 0.48,
        size: 100,
        status: 'OPEN'
      }
    ];
    try {
      await new ExecutionEngine(config, venue, store).runOnce({ venue: 'predict', signer: testSigner });
      expect(venue.canceledIds).toContain('old-maker');
      expect(venue.marketableCalls).toBe(0);
      expect(venue.mergeCalls).toBe(1);
      expect(venue.createCalls).toBe(0);
      expect(store.listRecentEvents(20).some((event) => event.type === 'fill.merge-submitted')).toBe(true);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('merges the current complete-set inventory instead of quoting when route switches to a better split pool', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config = appConfigSchema.parse({
      liveEnabled: true,
      risk: {
        orderSizeUsd: 5,
        maxSingleOrderUsd: 100,
        maxPositionUsd: 100,
        maxMarkets: 1,
        settlementNoNewOrdersMs: 0,
        eventStartNoNewOrdersMs: 0
      },
      strategy: {
        entryMode: 'split',
        balanceReserveUsd: 0,
        enforceRewardMinimum: false,
        minMarketLiquidityUsd: 0,
        minRewardLevel: 0,
        maxTokensPerMarket: 2,
        switchThresholdPct: 0,
        minSwitchBenefitMultiplier: 0,
        minSwitchEdgeAfterGasUsd: 0,
        minSafeHoursForSwitch: 0,
        fallbackSplitMergeGasUnits: 1,
        bnbUsdForGasEstimate: 1
      },
      selectedMarkets: { predict: [], polymarket: [] }
    });
    const endTime = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const currentYes: Market = {
      ...market,
      tokenId: 'current-switch-yes',
      marketId: 'current-switch',
      conditionId: 'current-switch-condition',
      outcome: 'Yes',
      outcomeCount: 2,
      endTime,
      rewards: { enabled: true, level: 5, minShares: 10, maxSpreadCents: 6, ppPerHour: 120 }
    };
    const currentNo: Market = {
      ...noMarket,
      tokenId: 'current-switch-no',
      marketId: 'current-switch',
      conditionId: 'current-switch-condition',
      outcome: 'No',
      outcomeCount: 2,
      endTime,
      rewards: { enabled: true, level: 5, minShares: 10, maxSpreadCents: 6, ppPerHour: 120 }
    };
    const rivalYes: Market = {
      ...market,
      tokenId: 'rival-switch-yes',
      marketId: 'rival-switch',
      conditionId: 'rival-switch-condition',
      outcome: 'Yes',
      outcomeCount: 2,
      endTime,
      rewards: { enabled: true, level: 5, minShares: 10, maxSpreadCents: 6, ppPerHour: 10000 }
    };
    const rivalNo: Market = {
      ...noMarket,
      tokenId: 'rival-switch-no',
      marketId: 'rival-switch',
      conditionId: 'rival-switch-condition',
      outcome: 'No',
      outcomeCount: 2,
      endTime,
      rewards: { enabled: true, level: 5, minShares: 10, maxSpreadCents: 6, ppPerHour: 10000 }
    };
    const venue = new MockVenue();
    venue.markets = [currentYes, currentNo, rivalYes, rivalNo];
    venue.books = [
      { ...book, tokenId: currentYes.tokenId, receivedAt: Date.now() },
      { ...book, tokenId: currentNo.tokenId, receivedAt: Date.now() },
      { ...book, tokenId: rivalYes.tokenId, receivedAt: Date.now() },
      { ...book, tokenId: rivalNo.tokenId, receivedAt: Date.now() }
    ];
    venue.positions = [
      { venue: 'predict', tokenId: currentYes.tokenId, marketId: currentYes.marketId, conditionId: currentYes.conditionId, outcome: 'Yes', outcomeCount: 2, market: currentYes, size: 5, notionalUsd: 2.5 },
      { venue: 'predict', tokenId: currentNo.tokenId, marketId: currentNo.marketId, conditionId: currentNo.conditionId, outcome: 'No', outcomeCount: 2, market: currentNo, size: 5, notionalUsd: 2.5 }
    ];
    venue.openOrders = [
      {
        venue: 'predict',
        externalId: 'current-maker-yes',
        tokenId: currentYes.tokenId,
        side: 'SELL',
        price: 0.51,
        size: 5,
        status: 'OPEN'
      },
      {
        venue: 'predict',
        externalId: 'current-maker-no',
        tokenId: currentNo.tokenId,
        side: 'SELL',
        price: 0.51,
        size: 5,
        status: 'OPEN'
      }
    ];
    try {
      await new ExecutionEngine(config, venue, store).runOnce({ venue: 'predict', signer: testSigner });

      expect(venue.mergeCalls).toBe(1);
      expect(venue.mergeRequests[0]).toMatchObject({ conditionId: 'current-switch-condition', amountUsd: 5 });
      expect(venue.canceledIds).toEqual(expect.arrayContaining(['current-maker-yes', 'current-maker-no']));
      expect(venue.createCalls).toBe(0);
      expect(venue.splitCalls).toBe(0);
      const route = store.getCheckpoint('route.predict')?.value as { switched?: boolean; selected?: Array<{ marketId?: string }> } | undefined;
      expect(route?.switched).toBe(true);
      expect(route?.selected?.map((item) => item.marketId)).toEqual(['rival-switch', 'rival-switch']);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the current split pool when route-switch gas cannot cover merge plus next split', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config = appConfigSchema.parse({
      liveEnabled: true,
      risk: {
        orderSizeUsd: 5,
        maxSingleOrderUsd: 100,
        maxPositionUsd: 100,
        maxMarkets: 1,
        settlementNoNewOrdersMs: 0,
        eventStartNoNewOrdersMs: 0
      },
      strategy: {
        entryMode: 'split',
        balanceReserveUsd: 0,
        enforceRewardMinimum: false,
        minMarketLiquidityUsd: 0,
        minRewardLevel: 0,
        maxTokensPerMarket: 2,
        switchThresholdPct: 0,
        minSwitchBenefitMultiplier: 0,
        minSwitchEdgeAfterGasUsd: 0,
        minSafeHoursForSwitch: 0,
        fallbackSplitMergeGasUnits: 1,
        bnbUsdForGasEstimate: 1
      },
      selectedMarkets: { predict: [], polymarket: [] }
    });
    const endTime = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const currentYes: Market = {
      ...market,
      tokenId: 'gas-current-yes',
      marketId: 'gas-current',
      conditionId: 'gas-current-condition',
      outcome: 'Yes',
      outcomeCount: 2,
      endTime,
      rewards: { enabled: true, level: 5, minShares: 10, maxSpreadCents: 6, ppPerHour: 120 }
    };
    const currentNo: Market = {
      ...noMarket,
      tokenId: 'gas-current-no',
      marketId: 'gas-current',
      conditionId: 'gas-current-condition',
      outcome: 'No',
      outcomeCount: 2,
      endTime,
      rewards: { enabled: true, level: 5, minShares: 10, maxSpreadCents: 6, ppPerHour: 120 }
    };
    const rivalYes: Market = {
      ...market,
      tokenId: 'gas-rival-yes',
      marketId: 'gas-rival',
      conditionId: 'gas-rival-condition',
      outcome: 'Yes',
      outcomeCount: 2,
      endTime,
      rewards: { enabled: true, level: 5, minShares: 10, maxSpreadCents: 6, ppPerHour: 10000 }
    };
    const rivalNo: Market = {
      ...noMarket,
      tokenId: 'gas-rival-no',
      marketId: 'gas-rival',
      conditionId: 'gas-rival-condition',
      outcome: 'No',
      outcomeCount: 2,
      endTime,
      rewards: { enabled: true, level: 5, minShares: 10, maxSpreadCents: 6, ppPerHour: 10000 }
    };
    const venue = new MockVenue();
    venue.nativeGas = {
      asset: 'BNB',
      balance: 0.00015,
      required: 0.0001,
      ok: true,
      message: 'Enough for one transaction only'
    };
    venue.markets = [currentYes, currentNo, rivalYes, rivalNo];
    venue.books = [
      { ...book, tokenId: currentYes.tokenId, receivedAt: Date.now() },
      { ...book, tokenId: currentNo.tokenId, receivedAt: Date.now() },
      { ...book, tokenId: rivalYes.tokenId, receivedAt: Date.now() },
      { ...book, tokenId: rivalNo.tokenId, receivedAt: Date.now() }
    ];
    venue.positions = [
      { venue: 'predict', tokenId: currentYes.tokenId, marketId: currentYes.marketId, conditionId: currentYes.conditionId, outcome: 'Yes', outcomeCount: 2, market: currentYes, size: 5, notionalUsd: 2.5 },
      { venue: 'predict', tokenId: currentNo.tokenId, marketId: currentNo.marketId, conditionId: currentNo.conditionId, outcome: 'No', outcomeCount: 2, market: currentNo, size: 5, notionalUsd: 2.5 }
    ];
    venue.openOrders = [
      {
        venue: 'predict',
        externalId: 'gas-current-maker-yes',
        tokenId: currentYes.tokenId,
        side: 'SELL',
        price: 0.51,
        size: 5,
        status: 'OPEN'
      },
      {
        venue: 'predict',
        externalId: 'gas-current-maker-no',
        tokenId: currentNo.tokenId,
        side: 'SELL',
        price: 0.51,
        size: 5,
        status: 'OPEN'
      }
    ];
    try {
      await new ExecutionEngine(config, venue, store).runOnce({ venue: 'predict', signer: testSigner });

      expect(venue.mergeCalls).toBe(0);
      expect(venue.canceledIds).toEqual([]);
      expect(venue.openOrders.map((order) => order.externalId)).toEqual(expect.arrayContaining(['gas-current-maker-yes', 'gas-current-maker-no']));
      const event = store.listRecentEvents(20).find((item) => item.type === 'route.switch-blocked');
      expect(event?.details).toMatchObject({
        reject: { reason_code: 'PREDICT_ROUTE_SWITCH_GAS_LOW', category: 'liquidation', stage: 'route-switch' }
      });
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runs a periodic full route scan, then returns to the tiered scan budget', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config = appConfigSchema.parse({
      liveEnabled: true,
      risk: {
        orderSizeUsd: 5,
        maxSingleOrderUsd: 100,
        maxPositionUsd: 100,
        maxMarkets: 1,
        settlementNoNewOrdersMs: 0,
        eventStartNoNewOrdersMs: 0
      },
      strategy: {
        entryMode: 'split',
        balanceReserveUsd: 0,
        enforceRewardMinimum: false,
        minMarketLiquidityUsd: 0,
        minRewardLevel: 0,
        maxTokensPerMarket: 2,
        candidateLimit: 20,
        quoteRefreshMs: 2000,
        switchThresholdPct: 1000,
        minSwitchBenefitMultiplier: 1000,
        minSwitchEdgeAfterGasUsd: 1000,
        minSafeHoursForSwitch: 0
      },
      selectedMarkets: { predict: [], polymarket: [] }
    });
    const endTime = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const heldYes: Market = {
      ...market,
      tokenId: 'budget-held-yes',
      marketId: 'budget-held',
      conditionId: 'budget-held-condition',
      outcome: 'Yes',
      outcomeCount: 2,
      endTime,
      rewards: { enabled: true, level: 5, minShares: 10, maxSpreadCents: 6, ppPerHour: 120 }
    };
    const heldNo: Market = {
      ...noMarket,
      tokenId: 'budget-held-no',
      marketId: 'budget-held',
      conditionId: 'budget-held-condition',
      outcome: 'No',
      outcomeCount: 2,
      endTime,
      rewards: { enabled: true, level: 5, minShares: 10, maxSpreadCents: 6, ppPerHour: 120 }
    };
    const extraMarkets = Array.from({ length: 16 }, (_, index) => ({
      ...market,
      tokenId: `budget-extra-${index}`,
      marketId: `budget-extra-${Math.floor(index / 2)}`,
      conditionId: `budget-extra-condition-${Math.floor(index / 2)}`,
      outcome: index % 2 === 0 ? 'Yes' : 'No',
      outcomeCount: 2,
      endTime,
      rewards: { enabled: true, level: 5, minShares: 10, maxSpreadCents: 6, ppPerHour: 5000 - index }
    }));
    const venue = new MockVenue();
    venue.markets = [heldYes, heldNo, ...extraMarkets];
    venue.books = venue.markets.map((item) => ({ ...book, tokenId: item.tokenId, receivedAt: Date.now() }));
    venue.positions = [
      { venue: 'predict', tokenId: heldYes.tokenId, marketId: heldYes.marketId, conditionId: heldYes.conditionId, outcome: 'Yes', outcomeCount: 2, market: heldYes, size: 5, notionalUsd: 2.5 },
      { venue: 'predict', tokenId: heldNo.tokenId, marketId: heldNo.marketId, conditionId: heldNo.conditionId, outcome: 'No', outcomeCount: 2, market: heldNo, size: 5, notionalUsd: 2.5 }
    ];
    venue.openOrders = [
      {
        venue: 'predict',
        externalId: 'budget-held-maker-yes',
        tokenId: heldYes.tokenId,
        side: 'SELL',
        price: 0.51,
        size: 5,
        status: 'OPEN'
      },
      {
        venue: 'predict',
        externalId: 'budget-held-maker-no',
        tokenId: heldNo.tokenId,
        side: 'SELL',
        price: 0.51,
        size: 5,
        status: 'OPEN'
      }
    ];
    try {
      await new ExecutionEngine(config, venue, store).runOnce({ venue: 'predict', signer: testSigner });

      const fullScanRequested = new Set(venue.requestedOrderbooks);
      const fullScan = store.getCheckpoint('market-scan.predict')?.value as { fullScan?: boolean; scannedOrderbooks?: number } | undefined;
      expect(fullScan?.fullScan).toBe(true);
      expect(fullScanRequested.size).toBeLessThanOrEqual(4);
      expect(fullScanRequested.has(heldYes.tokenId)).toBe(true);
      expect(fullScanRequested.has(heldNo.tokenId)).toBe(true);

      venue.requestedOrderbooks = [];
      await new ExecutionEngine(config, venue, store).runOnce({ venue: 'predict', signer: testSigner });

      const tieredRequested = new Set(venue.requestedOrderbooks);
      const tieredScan = store.getCheckpoint('market-scan.predict')?.value as { fullScan?: boolean; scannedOrderbooks?: number } | undefined;
      expect(tieredScan?.fullScan).toBe(false);
      expect(tieredRequested.size).toBeLessThan(venue.markets.length);
      expect(tieredRequested.has(heldYes.tokenId)).toBe(true);
      expect(tieredRequested.has(heldNo.tokenId)).toBe(true);
      expect(venue.createCalls).toBe(0);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps real market metadata when enriching active position markets after split entry', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config = appConfigSchema.parse({
      liveEnabled: true,
      risk: {
        orderSizeUsd: 5,
        maxSingleOrderUsd: 100,
        maxPositionUsd: 100,
        maxMarkets: 1,
        settlementNoNewOrdersMs: 0,
        eventStartNoNewOrdersMs: 0
      },
      strategy: {
        entryMode: 'split',
        balanceReserveUsd: 0,
        enforceRewardMinimum: false,
        minMarketLiquidityUsd: 5000,
        minRewardLevel: 0,
        maxTokensPerMarket: 2,
        candidateLimit: 4,
        quoteRefreshMs: 2000
      },
      selectedMarkets: { predict: [], polymarket: [] }
    });
    const endTime = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const yes: Market = {
      ...market,
      tokenId: 'metadata-preserve-yes',
      marketId: 'metadata-preserve',
      conditionId: 'metadata-preserve-condition',
      outcome: 'Yes',
      outcomeCount: 2,
      endTime,
      liquidityUsd: 20000,
      rewards: { enabled: true, level: 5, minShares: 10, maxSpreadCents: 6, ppPerHour: 240 }
    };
    const no: Market = {
      ...noMarket,
      tokenId: 'metadata-preserve-no',
      marketId: 'metadata-preserve',
      conditionId: 'metadata-preserve-condition',
      outcome: 'No',
      outcomeCount: 2,
      endTime,
      liquidityUsd: 20000,
      rewards: { enabled: true, level: 5, minShares: 10, maxSpreadCents: 6, ppPerHour: 240 }
    };
    const venue = new MockVenue();
    venue.markets = [yes, no];
    venue.books = [
      { ...book, tokenId: yes.tokenId, receivedAt: Date.now() },
      { ...book, tokenId: no.tokenId, receivedAt: Date.now() },
      { ...book, tokenId: yes.tokenId, receivedAt: Date.now() },
      { ...book, tokenId: no.tokenId, receivedAt: Date.now() }
    ];
    venue.splitPositions = async (request: { conditionId: string; amountUsd: number }): Promise<SplitPositionsResult> => {
      venue.splitCalls += 1;
      venue.splitRequests.push({ conditionId: request.conditionId, amountUsd: request.amountUsd });
      venue.positions = [
        { venue: venue.name, tokenId: yes.tokenId, marketId: yes.marketId, conditionId: yes.conditionId, outcome: 'Yes', outcomeCount: 2, size: request.amountUsd, notionalUsd: request.amountUsd * 0.5 },
        { venue: venue.name, tokenId: no.tokenId, marketId: no.marketId, conditionId: no.conditionId, outcome: 'No', outcomeCount: 2, size: request.amountUsd, notionalUsd: request.amountUsd * 0.5 }
      ];
      return {
        venue: venue.name,
        conditionId: request.conditionId,
        amountUsd: request.amountUsd,
        txHash: `split-${venue.splitCalls}`
      };
    };
    try {
      await new ExecutionEngine(config, venue, store).runOnce({ venue: 'predict', signer: testSigner });

      expect(venue.splitCalls).toBe(1);
      expect(venue.createCalls).toBe(2);
      const route = store.getCheckpoint('route.predict')?.value as { selectedGroup?: { marketId?: string; legs?: Array<{ metrics?: { liquidityUsd?: number } }> } } | undefined;
      expect(route?.selectedGroup?.marketId).toBe('metadata-preserve');
      expect(route?.selectedGroup?.legs?.map((leg) => leg.metrics?.liquidityUsd)).toEqual([20000, 20000]);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('merges stale complete-set inventory even when that pool is no longer in route candidates', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config = appConfigSchema.parse({
      liveEnabled: true,
      risk: {
        orderSizeUsd: 5,
        maxSingleOrderUsd: 100,
        maxPositionUsd: 100,
        maxMarkets: 1,
        settlementNoNewOrdersMs: 0,
        eventStartNoNewOrdersMs: 0
      },
      strategy: {
        entryMode: 'split',
        balanceReserveUsd: 0,
        enforceRewardMinimum: false,
        minMarketLiquidityUsd: 0,
        minRewardLevel: 0,
        maxTokensPerMarket: 2,
        switchThresholdPct: 0,
        minSwitchBenefitMultiplier: 50,
        minSwitchEdgeAfterGasUsd: 100,
        minSafeHoursForSwitch: 0
      },
      selectedMarkets: { predict: [], polymarket: [] }
    });
    const endTime = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const heldYes: Market = {
      ...market,
      tokenId: 'held-route-missing-yes',
      marketId: 'held-route-missing',
      conditionId: 'held-route-missing-condition',
      outcome: 'Yes',
      outcomeCount: 2,
      endTime,
      rewards: { enabled: false }
    };
    const heldNo: Market = {
      ...noMarket,
      tokenId: 'held-route-missing-no',
      marketId: 'held-route-missing',
      conditionId: 'held-route-missing-condition',
      outcome: 'No',
      outcomeCount: 2,
      endTime,
      rewards: { enabled: false }
    };
    const targetYes: Market = {
      ...market,
      tokenId: 'target-route-missing-yes',
      marketId: 'target-route-missing',
      conditionId: 'target-route-missing-condition',
      outcome: 'Yes',
      outcomeCount: 2,
      endTime,
      rewards: { enabled: true, level: 5, minShares: 10, maxSpreadCents: 6, ppPerHour: 240 }
    };
    const targetNo: Market = {
      ...noMarket,
      tokenId: 'target-route-missing-no',
      marketId: 'target-route-missing',
      conditionId: 'target-route-missing-condition',
      outcome: 'No',
      outcomeCount: 2,
      endTime,
      rewards: { enabled: true, level: 5, minShares: 10, maxSpreadCents: 6, ppPerHour: 240 }
    };
    const venue = new MockVenue();
    venue.markets = [targetYes, targetNo, heldYes, heldNo];
    venue.books = [
      { ...book, tokenId: targetYes.tokenId, receivedAt: Date.now() },
      { ...book, tokenId: targetNo.tokenId, receivedAt: Date.now() },
      { ...book, tokenId: heldYes.tokenId, receivedAt: Date.now() },
      { ...book, tokenId: heldNo.tokenId, receivedAt: Date.now() }
    ];
    venue.positions = [
      { venue: 'predict', tokenId: heldYes.tokenId, marketId: heldYes.marketId, conditionId: heldYes.conditionId, outcome: 'Yes', outcomeCount: 2, market: heldYes, size: 5, notionalUsd: 1 },
      { venue: 'predict', tokenId: heldNo.tokenId, marketId: heldNo.marketId, conditionId: heldNo.conditionId, outcome: 'No', outcomeCount: 2, market: heldNo, size: 5, notionalUsd: 4 }
    ];
    try {
      await new ExecutionEngine(config, venue, store).runOnce({ venue: 'predict', signer: testSigner });

      expect(venue.mergeCalls).toBe(1);
      expect(venue.mergeRequests[0]).toMatchObject({ conditionId: 'held-route-missing-condition', amountUsd: 5 });
      expect(venue.createCalls).toBe(0);
      const route = store.getCheckpoint('route.predict')?.value as { switched?: boolean; reason?: string; selected?: Array<{ marketId?: string }> } | undefined;
      expect(route?.switched).toBe(true);
      expect(route?.reason).toContain('当前完整套仓不在目标市场');
      expect(route?.selected?.map((item) => item.marketId)).toEqual(['target-route-missing', 'target-route-missing']);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('holds incomplete filled inventory instead of selling it at market', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config = appConfigSchema.parse({
      liveEnabled: true,
      risk: { maxSingleOrderUsd: 100, maxPositionUsd: 200 },
      selectedMarkets: { predict: [market.tokenId], polymarket: [] },
      strategy: { entryMode: 'split', onFillAction: 'sellAllAtMarket', liquidationMaxSlippageCents: 10 }
    });
    const venue = new MockVenue();
    venue.positions = [{ venue: 'predict', tokenId: market.tokenId, size: 5000, notionalUsd: 2500 }];
    try {
      await new ExecutionEngine(config, venue, store).runOnce({ venue: 'predict', signer: testSigner });
      expect(venue.marketableCalls).toBe(0);
      expect(venue.mergeCalls).toBe(0);
      expect(venue.createCalls).toBe(0);
      expect(store.listRecentEvents(20).some((event) => event.type === 'fill.merge-not-ready')).toBe(true);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('live preflight fails when venue credentials are missing', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const passphrase = 'correct horse battery staple';
    importWallet(dir, 'predict', '2'.repeat(64), passphrase);
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config: AppConfig = appConfigSchema.parse({ liveEnabled: true, selectedMarkets: { predict: [market.tokenId], polymarket: [] } });
    const venue = new MockVenue([{ name: 'jwt', ok: false, message: 'missing; run mm auth predict' }]);
    try {
      const result = await runPreflight({
        config,
        dataDir: dir,
        venue: 'predict',
        confirm: 'LIVE',
        signer: testSigner,
        store,
        adapter: venue
      });
      expect(result.ok).toBe(false);
      expect(result.checks.some((check) => check.name === 'venue:jwt' && !check.ok)).toBe(true);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('live preflight does not block Predict REST maker order mode when split gas is unavailable', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    importWallet(dir, 'predict', '8'.repeat(64), 'passphrase');
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config: AppConfig = appConfigSchema.parse({
      liveEnabled: true,
      selectedMarkets: { predict: [market.tokenId, noMarket.tokenId], polymarket: [] },
      strategy: { entryMode: 'split' }
    });
    const venue = new MockVenue([{ name: 'jwt', ok: true, message: 'loaded' }]);
    venue.nativeGas = {
      asset: 'BNB',
      balance: 0,
      required: 0.0001,
      ok: false,
      message: 'BNB 手续费余额不足，不能发起 split/merge 链上交易；USDT 有余额也不行。'
    };
    try {
      const result = await runPreflight({
        config,
        dataDir: dir,
        venue: 'predict',
        confirm: 'LIVE',
        signer: testSigner,
        store,
        adapter: venue
      });
      expect(result.ok).toBe(true);
      expect(result.checks.some((check) => check.name === 'split-native-gas')).toBe(false);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('live preflight times out slow venue checks instead of hanging the UI', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    importWallet(dir, 'predict', '6'.repeat(64), 'passphrase');
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config: AppConfig = appConfigSchema.parse({
      liveEnabled: true,
      selectedMarkets: { predict: [market.tokenId], polymarket: [] }
    });
    const venue = new SlowConnectionVenue([{ name: 'jwt', ok: true, message: 'loaded' }]);
    try {
      const startedAt = Date.now();
      const result = await runPreflight({
        config,
        dataDir: dir,
        venue: 'predict',
        confirm: 'LIVE',
        signer: testSigner,
        store,
        adapter: venue,
        preflightTimeoutMs: 25
      });
      expect(Date.now() - startedAt).toBeLessThan(1000);
      expect(result.ok).toBe(false);
      expect(result.checks.some((check) => check.name === 'venue-connection' && !check.ok)).toBe(true);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('UI-style live preflight softens slow network checks but keeps credential gates', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    importWallet(dir, 'predict', '7'.repeat(64), 'passphrase');
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config: AppConfig = appConfigSchema.parse({
      liveEnabled: true,
      selectedMarkets: { predict: [market.tokenId], polymarket: [] }
    });
    const venue = new SlowConnectionVenue([{ name: 'jwt', ok: true, message: 'loaded' }]);
    try {
      const result = await runPreflight({
        config,
        dataDir: dir,
        venue: 'predict',
        confirm: 'LIVE',
        signer: testSigner,
        store,
        adapter: venue,
        preflightTimeoutMs: 25,
        softNetworkChecks: true
      });
      expect(result.ok).toBe(true);
      expect(result.checks.find((check) => check.name === 'venue-connection')?.message).toContain('warning');
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('live preflight fails when liveEnabled is false', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    importWallet(dir, 'predict', '5'.repeat(64), 'passphrase');
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config: AppConfig = appConfigSchema.parse({
      liveEnabled: false,
      selectedMarkets: { predict: [market.tokenId], polymarket: [] }
    });
    const venue = new MockVenue([{ name: 'jwt', ok: true, message: 'loaded' }]);
    try {
      const result = await runPreflight({
        config,
        dataDir: dir,
        venue: 'predict',
        confirm: 'LIVE',
        signer: testSigner,
        store,
        adapter: venue
      });
      expect(result.ok).toBe(false);
      expect(result.checks.some((check) => check.name === 'live-config' && !check.ok)).toBe(true);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('live preflight allows empty selected markets when auto PP routing is enabled', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    importWallet(dir, 'predict', '3'.repeat(64), 'passphrase');
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config: AppConfig = appConfigSchema.parse({ liveEnabled: true });
    const venue = new MockVenue([{ name: 'jwt', ok: true, message: 'loaded' }]);
    try {
      const result = await runPreflight({
        config,
        dataDir: dir,
        venue: 'predict',
        confirm: 'LIVE',
        signer: testSigner,
        store,
        adapter: venue
      });
      expect(result.ok).toBe(true);
      expect(result.checks.find((check) => check.name === 'selected-markets')?.message).toContain('auto PP routing enabled');
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('hard-blocks Polymarket live preflight when merge exit is configured', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    importWallet(dir, 'polymarket', '8'.repeat(64), 'passphrase');
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config: AppConfig = appConfigSchema.parse({
      liveEnabled: true,
      strategy: { onFillAction: 'sellAllAtMarket' },
      selectedMarkets: { predict: [], polymarket: ['poly-token'] }
    });
    const baseVenue = new MockVenue();
    const venue = {
      name: 'polymarket' as const,
      testConnection: () => baseVenue.testConnection(),
      getMarkets: () => baseVenue.getMarkets(),
      getOrderbook: (tokenId: string) => baseVenue.getOrderbook(tokenId),
      getBalances: (_address: string, _signer?: SignerProvider) => baseVenue.getBalances(),
      getPositions: (_address: string) => baseVenue.getPositions(),
      getOpenOrders: (_address: string) => baseVenue.getOpenOrders(),
      createOrder: (intent: OrderIntent, _signer: SignerProvider) => baseVenue.createOrder(intent),
      cancelOrders: (orderIds: string[]) => baseVenue.cancelOrders(orderIds),
      async preflight(signer: SignerProvider): Promise<PreflightResult> {
        return {
          ok: false,
          venue: 'polymarket',
          signerAddress: signer.address,
          checks: [{ name: 'liquidation-capability', ok: false, message: 'Polymarket 未接入完整套仓合并退出' }]
        };
      }
    } satisfies VenueAdapter;
    try {
      const result = await runPreflight({
        config,
        dataDir: dir,
        venue: 'polymarket',
        confirm: 'LIVE',
        signer: testSigner,
        store,
        adapter: venue
      });
      expect(result.ok).toBe(false);
      expect(result.checks.some((check) => check.name === 'venue:liquidation-capability' && !check.ok && check.message.includes('合并退出'))).toBe(true);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('live preflight requires selected markets when manual routing is configured', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    importWallet(dir, 'predict', '3'.repeat(64), 'passphrase');
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config: AppConfig = appConfigSchema.parse({ liveEnabled: true, strategy: { autoSelectMarkets: false } });
    const venue = new MockVenue([{ name: 'jwt', ok: true, message: 'loaded' }]);
    try {
      const result = await runPreflight({
        config,
        dataDir: dir,
        venue: 'predict',
        confirm: 'LIVE',
        signer: testSigner,
        store,
        adapter: venue
      });
      expect(result.ok).toBe(false);
      expect(result.checks.some((check) => check.name === 'selected-markets' && !check.ok)).toBe(true);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('cancel-all preflight can skip selected market requirement but still checks venue credentials', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    importWallet(dir, 'predict', '4'.repeat(64), 'passphrase');
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config: AppConfig = appConfigSchema.parse({ liveEnabled: true });
    const venue = new MockVenue([{ name: 'jwt', ok: false, message: 'missing' }]);
    try {
      const result = await runPreflight({
        config,
        dataDir: dir,
        venue: 'predict',
        confirm: 'CANCEL_ALL',
        signer: testSigner,
        store,
        adapter: venue,
        expectedConfirm: 'CANCEL_ALL',
        requireSelectedMarkets: false
      });
      expect(result.checks.find((check) => check.name === 'selected-markets')?.ok).toBe(true);
      expect(result.ok).toBe(false);
      expect(result.checks.some((check) => check.name === 'venue:jwt' && !check.ok)).toBe(true);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function recordManagedOpenOrder(store: StateStore, order: OpenOrder, orderMarket: Market): void {
  const intent: OrderIntent = {
    venue: order.venue,
    market: orderMarket,
    tokenId: order.tokenId,
    side: order.side,
    price: order.price,
    size: order.size,
    notionalUsd: Number((order.price * order.size).toFixed(4)),
    postOnly: true,
    liquidity: 'maker',
    reason: 'test-managed-open-order',
    clientOrderId: `${order.venue}-${order.tokenId}-${order.side}-${order.externalId}`
  };
  store.recordPlannedOrder(intent, 'live');
  store.recordOrderResult({ venue: order.venue, clientOrderId: intent.clientOrderId, externalId: order.externalId, status: 'OPEN' });
}
