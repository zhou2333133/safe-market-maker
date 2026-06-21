import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { appConfigSchema } from '../src/config/schema.js';
import { saveConfig } from '../src/config/load.js';
import { usingStore } from '../src/store/ui-store.js';
import { liveStart } from '../src/ui/live-controller.js';
import { saveLiveRunIntent } from '../src/ui/live-intent.js';
import { createLiveLoopState } from '../src/ui/live-loop-state.js';
import { startUiServer } from '../src/ui/server.js';

describe('local UI server', () => {
  it('serves the dashboard and status without exposing write APIs cross-origin', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-ui-'));
    const configPath = path.join(dir, 'config.yaml');
    saveConfig(configPath, appConfigSchema.parse({ dataDir: '.safe-mm' }));
    const server = await startUiServer(configPath, { port: 0 });
    try {
      const page = await fetch(server.url);
      const html = await page.text();
      expect(html).toContain('积分收益优化机器人');
      expect(html).toContain('策略控制台');
      expect(html).toContain('同时总挂单数量');
      expect(html).toContain('单笔挂单金额 USD');
      expect(html).toContain('退出亏损上限 %');
      expect(html).toContain('本轮总止损 USD');
      expect(html).toContain('Predict 实盘开关');
      expect(html).toContain('Polymarket 实盘开关');
      expect(html).toContain('挂单亏损');
      expect(html).toContain('挂单亏损估算');
      expect(html).toContain('id="marketMinLiquidity" type="number" min="0" step="1000" value="0"');
      expect(html).toContain('只看 5 级');
      expect(html).toContain('刷新余额');
      expect(html).toContain('启动检查摘要');
      expect(html).toContain('检查启动条件');
      expect(html).toContain('实盘控制台');
      expect(html).toContain('本机运行密钥，仅用于当前机器人签名');
      expect(html).toContain('运行时私钥');
      expect(html).toContain('事件总数');
      expect(html).toContain('最新检查点');
      expect(html).toContain('当前阶段');
      expect(html).toContain('最近拒绝原因');
      expect(html).toContain('机器人动态');
      expect(html).toContain('这里只显示启动、选市场、下单、撤换、错误等关键动作');
      expect(html).toContain('Predict.fun 积分模块');
      expect(html).not.toContain('Paper');
      expect(html).not.toContain('Shadow');
      expect(html).not.toContain('运行 Paper');
      expect(html).not.toContain('LIVE_START');
      expect(html).not.toContain('LIVE_MANUAL_ORDER');
      expect(html).not.toContain('Keystore 密码');
      expect(html).not.toContain('livePassphrase');
      expect(html).not.toContain('manualPassphrase');
      expect(html).not.toContain('data-view="manual"');
      const status = await fetch(`${server.url}/api/status`);
      const statusPayload = await status.json();
      expect(statusPayload).toMatchObject({
        ok: true,
        liveIntent: {
          predict: null,
          polymarket: null
        },
        config: {
          liveEnabledByVenue: {
            predict: false,
            polymarket: false
          },
          runtime: {
            signer: {
              predict: { available: false, source: 'none' },
              polymarket: { available: false, source: 'none' }
            }
          }
        },
        accountLive: {
          predict: { available: false, source: 'none' },
          polymarket: { available: false, source: 'none' }
        },
        orderRisk: {
          predict: { openOrders: 0, notionalUsd: 0, estimatedWorstCaseLossUsd: 0 },
          polymarket: { openOrders: 0, notionalUsd: 0, estimatedWorstCaseLossUsd: 0 }
        }
      });
      const summary = await fetch(`${server.url}/api/status/summary`);
      const summaryPayload = await summary.json();
      expect(summaryPayload).toMatchObject({
        ok: true,
        liveIntent: {
          predict: null,
          polymarket: null
        },
        config: {
          risk: expect.any(Object),
          strategy: expect.any(Object)
        }
      });
      const live = await fetch(`${server.url}/api/live/status`);
      expect(await live.json()).toMatchObject({ ok: true, live: { predict: { status: 'idle' } } });
      const removed = await fetch(`${server.url}/api/run-paper`);
      expect(removed.status).toBe(404);
      const blocked = await fetch(`${server.url}/api/live/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ venue: 'predict' })
      });
      expect(blocked.status).toBe(403);
      const script = await (await fetch(`${server.url}/app.js`)).text();
      expect(script).toContain('directIsNewer');
      expect(script).toContain('旧快照');
      const token = /const UI_TOKEN = "([^"]+)"/.exec(script)?.[1];
      expect(token).toBeTruthy();
      const rejectedManual = await fetch(`${server.url}/api/manual-order`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-safe-mm-ui-token': token ?? '' },
        body: JSON.stringify({ venue: 'predict', side: 'BUY', tokenId: 'token-1', price: 0.5, size: 1 })
      });
      expect(rejectedManual.status).toBe(400);
      expect(await rejectedManual.json()).toMatchObject({ ok: false, error: expect.stringContaining('手动下单入口已禁用') });
      const rejectedStartupFacts = await fetch(`${server.url}/api/startup-facts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-safe-mm-ui-token': token ?? '' },
        body: JSON.stringify({ venue: 'predict' })
      });
      expect(rejectedStartupFacts.status).toBe(400);
      expect(await rejectedStartupFacts.json()).toMatchObject({ ok: false, error: expect.stringContaining('SAFE_MM_PREDICT_PRIVATE_KEY') });
      const liveBlockedByGate = await fetch(`${server.url}/api/live/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-safe-mm-ui-token': token ?? '' },
        body: JSON.stringify({ venue: 'predict', passphrase: 'unused' })
      });
      expect(liveBlockedByGate.status).toBe(400);
      expect(await liveBlockedByGate.json()).toMatchObject({ ok: false, error: expect.stringContaining('Predict 实盘开关未开启') });
      const savedSettings = await fetch(`${server.url}/api/config/trading`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-safe-mm-ui-token': token ?? '' },
        body: JSON.stringify({
          liveEnabled: true,
          entryMode: 'cash',
          autoSelectMarkets: true,
          enforceRewardMinimum: false,
          orderSizeUsd: 12,
          maxSingleOrderUsd: 12,
          maxPositionUsd: 30,
          maxDailyLossUsd: 9,
          maxAccountRiskStaleMs: 90000,
          maxOpenOrdersPerMarket: 3,
          quoteSide: 'sell',
          tradingMode: 'conservative',
          quoteDepthLevel: 5,
          retreatTicks: 2,
          quoteRefreshMs: 10000,
          marketRefreshMs: 60000,
          replaceThresholdTicks: 1,
          onFillAction: 'sellAllAtMarket',
          liquidationSlippageTicks: 2,
          liquidationMaxSlippageCents: 10,
          minPositionSizeToLiquidate: 0.0001,
          minRewardSizeMultiplier: 1,
          balanceReserveUsd: 0,
          maxOpenOrderReserveDriftUsd: 3,
          maxOpenOrderReserveDriftPct: 30,
          settlementNoNewOrdersMs: 900000,
          settlementCancelOpenOrdersMs: 300000,
          shortEventMaxDurationMs: 21600000,
          eventStartNoNewOrdersMs: 600000,
          eventStartCancelOpenOrdersMs: 120000,
          blockUnknownEndTime: true,
          maxBboMoveCents: 12,
          maxInventorySkewUsd: 20,
          maxTokensPerMarket: 2,
          minMarketLiquidityUsd: 10000,
          minRewardLevel: 5,
          candidateLimit: 12,
          switchThresholdPct: 15,
          maxMarkets: 2,
          pointsOnly: true,
          acceptingOnly: true,
          cancelOutsideReward: true,
          inventorySkewEnabled: true,
          dedupeMarketGroups: true
        })
      });
      expect(savedSettings.status).toBe(200);
      const savedPayload = await savedSettings.json();
      expect(savedPayload).toMatchObject({
        ok: true,
        config: {
          liveEnabled: true,
          liveEnabledByVenue: {
            predict: true,
            polymarket: true
          },
          risk: { orderSizeUsd: 12, maxDailyLossUsd: 9, maxAccountRiskStaleMs: 90000, maxOpenOrdersPerMarket: 3, maxMarkets: 2, maxOpenOrderReserveDriftUsd: 3, maxOpenOrderReserveDriftPct: 30, settlementNoNewOrdersMs: 900000, settlementCancelOpenOrdersMs: 300000, shortEventMaxDurationMs: 21600000, eventStartNoNewOrdersMs: 600000, eventStartCancelOpenOrdersMs: 120000, blockUnknownEndTime: true, maxBboMoveCents: 12 },
          strategy: { autoSelectMarkets: true, enforceRewardMinimum: true, entryMode: 'cash', quoteSide: 'sell', dualSide: false, conservativeDepthLevel: 5, retreatTicks: 2, quoteRefreshMs: 10000, marketRefreshMs: 60000, replaceThresholdTicks: 1, onFillAction: 'hold', minMarketLiquidityUsd: 10000, minRewardLevel: 5, candidateLimit: 12, switchThresholdPct: 15, balanceReserveUsd: 0, acceptingOnly: true }
        }
      });

      const lowCompetitionSettings = await fetch(`${server.url}/api/config/trading`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-safe-mm-ui-token': token ?? '' },
        body: JSON.stringify({
          liveEnabled: true,
          entryMode: 'cash',
          orderSizeUsd: 12,
          maxSingleOrderUsd: 12,
          maxPositionUsd: 30,
          maxDailyLossUsd: 9,
          maxMarkets: 2,
          autoSelectMarkets: true,
          quoteSide: 'buy',
          pointsOnly: true,
          acceptingOnly: true,
          minMarketLiquidityUsd: 0
        })
      });
      expect(lowCompetitionSettings.status).toBe(200);
      expect((await lowCompetitionSettings.json()).config.strategy.minMarketLiquidityUsd).toBe(0);

      const preserveRiskLimits = await fetch(`${server.url}/api/config/trading`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-safe-mm-ui-token': token ?? '' },
        body: JSON.stringify({
          liveEnabled: true,
          entryMode: 'split',
          autoSelectMarkets: true,
          enforceRewardMinimum: false,
          orderSizeUsd: 20,
          maxDailyLossUsd: 9,
          maxAccountRiskStaleMs: 90000,
          maxOpenOrdersPerMarket: 3,
          quoteSide: 'sell',
          tradingMode: 'conservative',
          quoteDepthLevel: 5,
          retreatTicks: 2,
          quoteRefreshMs: 10000,
          marketRefreshMs: 60000,
          replaceThresholdTicks: 1,
          onFillAction: 'sellAllAtMarket',
          liquidationSlippageTicks: 2,
          liquidationMaxSlippageCents: 10,
          minPositionSizeToLiquidate: 0.0001,
          minRewardSizeMultiplier: 1,
          balanceReserveUsd: 0,
          settlementNoNewOrdersMs: 900000,
          settlementCancelOpenOrdersMs: 300000,
          shortEventMaxDurationMs: 21600000,
          eventStartNoNewOrdersMs: 600000,
          eventStartCancelOpenOrdersMs: 120000,
          blockUnknownEndTime: true,
          maxBboMoveCents: 12,
          maxInventorySkewUsd: 20,
          maxTokensPerMarket: 2,
          minMarketLiquidityUsd: 10000,
          minRewardLevel: 5,
          candidateLimit: 12,
          switchThresholdPct: 15,
          maxMarkets: 2,
          pointsOnly: true,
          acceptingOnly: true,
          cancelOutsideReward: true,
          inventorySkewEnabled: true,
          dedupeMarketGroups: true
        })
      });
      expect(preserveRiskLimits.status).toBe(200);
      const preservePayload = await preserveRiskLimits.json();
      expect(preservePayload.config.risk.orderSizeUsd).toBe(20);
      expect(preservePayload.config.risk.maxSingleOrderUsd).toBe(20);
      expect(preservePayload.config.risk.maxPositionUsd).toBe(30);
      expect(preservePayload.config.strategy).toMatchObject({
        entryMode: 'split',
        quoteSide: 'both',
        dualSide: true,
        onFillAction: 'hold'
      });
    } finally {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps Predict and Polymarket live switches independent', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-ui-'));
    const configPath = path.join(dir, 'config.yaml');
    saveConfig(configPath, appConfigSchema.parse({
      dataDir: '.safe-mm',
      liveEnabled: false,
      venues: {
        predict: { liveEnabled: false },
        polymarket: { liveEnabled: true }
      }
    }));
    const server = await startUiServer(configPath, { port: 0 });
    try {
      const script = await (await fetch(`${server.url}/app.js`)).text();
      const token = /const UI_TOKEN = "([^"]+)"/.exec(script)?.[1];

      const predictUpdate = await fetch(`${server.url}/api/config/trading`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-safe-mm-ui-token': token ?? '' },
        body: JSON.stringify({ venue: 'predict', liveEnabled: true })
      });
      expect(await predictUpdate.json()).toMatchObject({
        ok: true,
        config: {
          liveEnabled: false,
          liveEnabledByVenue: { predict: true, polymarket: true }
        }
      });

      const polymarketUpdate = await fetch(`${server.url}/api/config/trading`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-safe-mm-ui-token': token ?? '' },
        body: JSON.stringify({ venue: 'polymarket', liveEnabled: false })
      });
      expect(await polymarketUpdate.json()).toMatchObject({
        ok: true,
        config: {
          liveEnabled: false,
          liveEnabledByVenue: { predict: true, polymarket: false }
        }
      });

      const status = await (await fetch(`${server.url}/api/status`)).json();
      expect(status.config).toMatchObject({
        liveEnabledByVenue: { predict: true, polymarket: false },
        venues: {
          predict: { liveEnabled: true },
          polymarket: { liveEnabled: false }
        }
      });
    } finally {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not expose configured API keys through the UI status endpoint', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-ui-'));
    const configPath = path.join(dir, 'config.yaml');
    saveConfig(configPath, appConfigSchema.parse({
      dataDir: '.safe-mm',
      venues: { predict: { apiKey: 'predict-api-key-should-not-leak' } }
    }));
    const server = await startUiServer(configPath, { port: 0 });
    try {
      const response = await fetch(`${server.url}/api/status`);
      const text = await response.text();
      const payload = JSON.parse(text);
      const summaryText = await (await fetch(`${server.url}/api/status/summary`)).text();
      const summaryPayload = JSON.parse(summaryText);

      expect(text).not.toContain('predict-api-key-should-not-leak');
      expect(summaryText).not.toContain('predict-api-key-should-not-leak');
      expect(payload.config.venues.predict).toMatchObject({
        apiKeyConfigured: true
      });
      expect(summaryPayload.config.venues.predict).toMatchObject({
        apiKeyConfigured: true
      });
      expect(payload.config.venues.predict.apiKey).toBeUndefined();
      expect(summaryPayload.config.venues.predict.apiKey).toBeUndefined();
    } finally {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exposes persisted live auto-resume intent through status', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-ui-'));
    const configPath = path.join(dir, 'config.yaml');
    saveConfig(configPath, appConfigSchema.parse({ dataDir: '.safe-mm' }));
    saveLiveRunIntent(path.join(dir, '.safe-mm'), 'predict', 'user-start', 'test intent');
    const server = await startUiServer(configPath, { port: 0 });
    try {
      const response = await fetch(`${server.url}/api/status`);
      const payload = await response.json();

      expect(payload.liveIntent.predict).toMatchObject({
        venue: 'predict',
        enabled: true,
        source: 'user-start',
        reason: 'test intent'
      });
    } finally {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('treats duplicate live start clicks as a status refresh', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-ui-'));
    const configPath = path.join(dir, 'config.yaml');
    saveConfig(configPath, appConfigSchema.parse({ dataDir: '.safe-mm' }));
    try {
      const liveLoops = new Map();
      liveLoops.set('predict', createLiveLoopState('predict', new Date('2026-05-20T00:00:00Z')));

      const payload = await liveStart(configPath, { venue: 'predict' }, liveLoops) as {
        ok: boolean;
        alreadyActive?: boolean;
        message?: string;
        live?: { status?: string };
      };

      expect(payload).toMatchObject({
        ok: true,
        alreadyActive: true,
        live: { status: 'running' }
      });
      expect(payload.message).toContain('已经在运行中');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('summarizes fills using the latest account snapshot day boundary', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-ui-'));
    const configPath = path.join(dir, 'config.yaml');
    saveConfig(configPath, appConfigSchema.parse({ dataDir: '.safe-mm' }));
    const store = usingStore(path.join(dir, '.safe-mm'));
    try {
      store.recordAccountRiskSnapshot({
        venue: 'predict',
        account: '0x1111111111111111111111111111111111111111',
        source: 'venue',
        capturedAt: Date.parse('2026-05-20T10:00:00Z'),
        dayStart: Date.parse('2026-05-20T06:00:00Z'),
        realizedPnlUsd: 0,
        unrealizedPnlUsd: 0,
        netCashflowUsd: -10,
        fills: [
          {
            venue: 'predict',
            id: 'after-custom-boundary',
            tokenId: 'token-1',
            side: 'BUY',
            price: 0.5,
            size: 20,
            notionalUsd: 10,
            cashflowUsd: -10,
            ts: Date.parse('2026-05-20T07:00:00Z')
          },
          {
            venue: 'predict',
            id: 'before-custom-boundary',
            tokenId: 'token-1',
            side: 'BUY',
            price: 0.5,
            size: 20,
            notionalUsd: 10,
            cashflowUsd: -10,
            ts: Date.parse('2026-05-20T05:59:00Z')
          }
        ],
        positions: [],
        balances: [{ asset: 'USDT', available: 90, total: 90 }],
        warnings: []
      });
    } finally {
      store.close();
    }
    const server = await startUiServer(configPath, { port: 0 });
    try {
      const response = await fetch(`${server.url}/api/status`);
      const payload = await response.json();

      expect(payload.fills.predict).toMatchObject({
        count: 1,
        notionalUsd: 10,
        latest: { id: 'after-custom-boundary' }
      });
    } finally {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns all active open orders separately from the recent order log', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-ui-'));
    const configPath = path.join(dir, 'config.yaml');
    saveConfig(configPath, appConfigSchema.parse({ dataDir: '.safe-mm' }));
    const store = usingStore(path.join(dir, '.safe-mm'));
    try {
      store.ingestOpenOrders(Array.from({ length: 20 }, (_, index) => ({
        venue: 'predict',
        externalId: `active-${index}`,
        tokenId: `token-${index}`,
        side: 'BUY',
        price: 0.5,
        size: 10,
        status: 'OPEN'
      })), 'live');
    } finally {
      store.close();
    }
    const server = await startUiServer(configPath, { port: 0 });
    try {
      const summary = await fetch(`${server.url}/api/status/summary`);
      const payload = await summary.json();

      expect(payload.orders).toHaveLength(12);
      expect(payload.activeOrders).toHaveLength(20);
      expect(payload.activeOrders[0]).toMatchObject({
        venue: 'predict',
        tokenId: expect.any(String),
        status: 'OPEN',
        notionalUsd: 5
      });
    } finally {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('redacts sensitive upstream error text before returning UI JSON errors', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-ui-'));
    const configPath = path.join(dir, 'config.yaml');
    const secret = 'a'.repeat(64);
    saveConfig(configPath, appConfigSchema.parse({
      dataDir: '.safe-mm',
      liveEnabled: true,
      venues: {
        predict: {
          apiKey: 'predict-api-key-should-not-leak'
        }
      }
    }));
    const server = await startUiServer(configPath, { port: 0 });
    try {
      writeFileSync(configPath, `dataDir: .safe-mm\nvenues:\n  predict:\n    apiBaseUrl: https://${secret}.invalid\n`, 'utf8');
      const script = await (await fetch(`${server.url}/app.js`)).text();
      const token = /const UI_TOKEN = "([^"]+)"/.exec(script)?.[1];
      const response = await fetch(`${server.url}/api/config/trading`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-safe-mm-ui-token': token ?? '' },
        body: JSON.stringify({
          liveEnabled: true,
          tradingMode: 'conservative',
          quoteSide: 'buy'
        })
      });
      const text = await response.text();

      expect(response.status).toBe(500);
      expect(text).not.toContain(secret);
      expect(text).toContain('[REDACTED');
    } finally {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a second UI server for the same safe-market-maker config', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'safe-mm-ui-'));
    const configPath = path.join(dir, 'config.yaml');
    saveConfig(configPath, appConfigSchema.parse({ dataDir: '.safe-mm' }));
    const first = await startUiServer(configPath, { port: 0 });
    try {
      await expect(startUiServer(configPath, { port: 0 })).rejects.toThrow(/UI 已经在运行/);
    } finally {
      await first.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
