import { mkdtempSync, rmSync } from 'node:fs';
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
  Orderbook,
  Position,
  PreflightResult,
  VenueName
} from '../src/domain/types.js';
import { ExecutionEngine } from '../src/execution/engine.js';
import { importWallet } from '../src/secrets/keystore.js';
import type { SignerProvider } from '../src/secrets/signer.js';
import { StateStore } from '../src/store/sqlite.js';
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
  marketId: 'market-1',
  conditionId: 'condition-1',
  outcome: 'Yes',
  question: 'Disconnect force-cancel?',
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

class MockVenue implements VenueAdapter {
  readonly name: VenueName = 'predict';
  canceledIds: string[] = [];
  disconnectListener?: (() => void) | undefined;

  async testConnection(): Promise<boolean> {
    return true;
  }

  async getMarkets(): Promise<Market[]> {
    return [market];
  }

  async getOrderbook(): Promise<Orderbook> {
    return {
      venue: this.name,
      tokenId: market.tokenId,
      receivedAt: Date.now(),
      bids: [{ price: 0.49, size: 100 }],
      asks: [{ price: 0.51, size: 100 }]
    };
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

  // 捕获 engine 在构造时注入的"断线全撤"回调（等价于 predict-ws 的 onDisconnect 触发）
  setDisconnectListener(listener: (() => void) | undefined): void {
    this.disconnectListener = listener;
  }
}

describe('engine disconnect → force-cancel (independent of main loop)', () => {
  it('wires the WS disconnect event to a force-cancel of all managed orders', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config = appConfigSchema.parse({ liveEnabled: true });
    const venue = new MockVenue();
    importWallet(dir, 'predict', '5'.repeat(64), 'passphrase');
    const intent: OrderIntent = {
      venue: 'predict',
      market,
      tokenId: market.tokenId,
      side: 'BUY',
      price: 0.49,
      size: 20,
      notionalUsd: 9.8,
      postOnly: true,
      reason: 'dc-test',
      clientOrderId: 'dc-client'
    };
    store.recordPlannedOrder(intent, 'live');
    store.recordOrderResult({ venue: 'predict', clientOrderId: intent.clientOrderId, externalId: 'dc-external', status: 'OPEN' });
    try {
      // 构造即注入（engine 构造函数内）：WS 断线 listener 应已被 adapter 捕获
      const engine = new ExecutionEngine(config, venue, store);
      expect(venue.disconnectListener).toBeTypeOf('function');
      // 即便主循环卡死，WS 断线事件回调也会触发全撤——这里模拟该回调被 fire
      venue.disconnectListener!();
      // cancelAllManagedOnDisconnect 是 async fire-and-forget；等微任务完成
      await new Promise((resolve) => setImmediate(resolve));

      expect(venue.canceledIds).toEqual(['dc-external']);
      // store 中受管单已被标记撤单
      expect(store.listManagedOpenOrders('predict').filter((o) => o.status === 'OPEN')).toEqual([]);
      // 记录了断线全撤事件
      expect(store.listRecentEvents(20).some((e) => e.type === 'ws.health.cancel-all-disconnect')).toBe(true);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is a no-op (no cancel, no throw) when there are no managed orders', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config = appConfigSchema.parse({ liveEnabled: true });
    const venue = new MockVenue();
    importWallet(dir, 'predict', '6'.repeat(64), 'passphrase');
    try {
      const engine = new ExecutionEngine(config, venue, store);
      expect(venue.disconnectListener).toBeTypeOf('function');
      venue.disconnectListener!();
      await new Promise((resolve) => setImmediate(resolve));
      expect(venue.canceledIds).toEqual([]);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is idempotent: firing disconnect twice does not double-cancel', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-'));
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    const config = appConfigSchema.parse({ liveEnabled: true });
    const venue = new MockVenue();
    importWallet(dir, 'predict', '7'.repeat(64), 'passphrase');
    const intent: OrderIntent = {
      venue: 'predict',
      market,
      tokenId: market.tokenId,
      side: 'BUY',
      price: 0.49,
      size: 20,
      notionalUsd: 9.8,
      postOnly: true,
      reason: 'dc-idem',
      clientOrderId: 'dc-idem-client'
    };
    store.recordPlannedOrder(intent, 'live');
    store.recordOrderResult({ venue: 'predict', clientOrderId: intent.clientOrderId, externalId: 'dc-idem-ext', status: 'OPEN' });
    try {
      const engine = new ExecutionEngine(config, venue, store);
      venue.disconnectListener!();
      await new Promise((resolve) => setImmediate(resolve));
      // 第二次断线（已撤完，store 无 OPEN 单）
      venue.disconnectListener!();
      await new Promise((resolve) => setImmediate(resolve));
      expect(venue.canceledIds).toEqual(['dc-idem-ext']);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
