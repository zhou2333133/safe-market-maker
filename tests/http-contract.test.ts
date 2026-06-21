import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { parseUnits } from 'ethers';
import { WebSocketServer } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { appConfigSchema } from '../src/config/schema.js';
import type { SignerProvider } from '../src/secrets/signer.js';
import { LocalWalletSigner } from '../src/secrets/signer.js';
import { PolymarketVenue } from '../src/venues/polymarket.js';
import { clearPredictMarketListCache, PredictVenue } from '../src/venues/predict.js';
import type { Market } from '../src/domain/types.js';

const servers: Array<{ close: () => Promise<void> }> = [];
const wsServers: Array<{ close: () => Promise<void> }> = [];

const signer: SignerProvider = {
  address: '0x1111111111111111111111111111111111111111',
  async signMessage(message) {
    return `signed:${String(message)}`;
  },
  async signTypedData() {
    return '0xtyped';
  }
};

afterEach(async () => {
  clearPredictMarketListCache();
  PredictVenue.closeSharedWsClients();
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(wsServers.splice(0).map((server) => server.close()));
});

describe('venue HTTP contract tests', () => {
  it('normalizes Predict markets, orderbooks, and auth token responses', async () => {
    const seen: Array<{ method: string; url: string; body: unknown; apiKey?: string }> = [];
    let restOrderbookCalls = 0;
    const wsUrl = await mockWsServer((message, socket) => {
      if (message?.method === 'subscribe' && message?.params?.includes('predictOrderbook/market-1')) {
        socket.send(JSON.stringify({ type: 'R', requestId: message.requestId, success: true, data: null }));
        socket.send(JSON.stringify({
          type: 'M',
          topic: 'predictOrderbook/market-1',
          data: { bids: [[0.49, 100]], asks: [[0.51, 100]] }
        }));
      }
      if (message?.method === 'heartbeat') return;
    });
    const rpcUrl = await mockServer(async (req, res) => {
      const body = await readBody(req) as any;
      if (Array.isArray(body)) {
        return json(res, body.map(rpcResponse));
      }
      return json(res, rpcResponse(body));
    });
    const baseUrl = await mockServer(async (req, res) => {
      const body = await readBody(req);
      seen.push({ method: req.method ?? '', url: req.url ?? '', body, apiKey: req.headers['x-api-key'] as string | undefined });
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === '/v1/markets') {
        expect(url.searchParams.get('status')).toBe('OPEN');
        return json(res, {
          data: {
            markets: [
              {
                id: 'market-1',
                question: 'Will Predict contract pass?',
                tradingStatus: 'OPEN',
                status: 'REGISTERED',
                isYieldBearing: true,
                outcomes: [{ name: 'YES', onChainId: 'predict-token' }],
                liquidity_activation: { active: true, min_shares: 100, max_spread_cents: 6 },
                rewards: {
                  current: {
                    startsAt: new Date(Date.now() - 60_000).toISOString(),
                    endsAt: new Date(Date.now() + 60 * 60_000).toISOString(),
                    hourlyRate: 3000
                  }
                }
              }
            ]
          }
        });
      }
      if (url.pathname === '/v1/markets/market-1/stats') {
        return json(res, { data: { totalLiquidityUsd: 1000, volume24hUsd: 2000, volumeTotalUsd: 3000 } });
      }
      if (req.url === '/v1/markets/predict-token/orderbook') {
        restOrderbookCalls += 1;
        return json(res, {
          tokenId: 'predict-token',
          bids: [{ price: '0.49', shares: '100' }],
          asks: [{ price: '0.51', shares: '100' }]
        });
      }
      if (url.pathname === '/v1/orders' && req.method === 'GET') {
        expect(url.searchParams.get('status')).toBe('OPEN');
        expect(url.searchParams.get('first')).toBe('100');
        expect(url.searchParams.has('maker')).toBe(false);
        return json(res, {
          success: true,
          data: [
            {
              id: 'order-1',
              pricePerShare: '0.5',
              shares: '10',
              status: 'OPEN',
              order: {
                hash: 'hash-1',
                tokenId: 'predict-token',
                side: 0,
                makerAmount: '5',
                takerAmount: '10'
              }
            }
          ]
        });
      }
      if (url.pathname === '/v1/positions' && req.method === 'GET') {
        expect(url.searchParams.get('first')).toBe('100');
        expect(url.searchParams.has('account')).toBe(false);
        return json(res, {
          success: true,
          data: [
            {
              id: 'position-1',
              market: { id: 'market-1' },
              outcome: { name: 'YES', onChainId: 'predict-token' },
              amount: '2',
              valueUsd: '1.4',
              averageBuyPriceUsd: '0.7'
            }
          ]
        });
      }
      if (url.pathname === '/v1/account/activity' && req.method === 'GET') {
        expect(url.searchParams.get('first')).toBe('100');
        return json(res, {
          success: true,
          data: [
            {
              id: 'activity-1',
              type: 'MATCH',
              side: 'BUY',
              tokenId: 'predict-token',
              price: '0.50',
              shares: '10',
              realizedPnlUsd: '-1.25',
              feeUsd: '0.02',
              createdAt: new Date().toISOString()
            }
          ]
        });
      }
      if (url.pathname === '/v1/orders/remove' && req.method === 'POST') {
        expect(body).toEqual({ data: { ids: ['order-1'] } });
        return json(res, { success: true, removed: ['order-1'], noop: [] });
      }
      if (req.url === '/v1/auth/message') return json(res, { data: { message: 'sign this challenge' } });
      if (req.url === '/v1/auth' && req.method === 'POST') return json(res, { data: { token: 'jwt-token' } });
      res.statusCode = 404;
      res.end('{}');
    });
    const config = appConfigSchema.parse({
      endpointPolicy: { allowCustom: true },
      venues: { predict: { apiBaseUrl: baseUrl, apiKey: 'api-key', rpcUrl, wsUrl } }
    });
    const venue = new PredictVenue(config, { jwt: 'jwt-token' });
    const markets = await venue.getMarkets();
    expect(markets[0]?.tokenId).toBe('predict-token');
    expect(markets[0]?.yieldBearing).toBe(true);
    expect(markets[0]?.rewards?.enabled).toBe(true);
    expect(markets[0]?.rewards?.level).toBe(5);
    const book = await venue.getOrderbook('predict-token');
    expect(book.bids[0]?.price).toBe(0.49);
    expect(restOrderbookCalls).toBe(0);
    const balances = await venue.getBalances(signer.address);
    expect(balances).toEqual([{ asset: 'USDT', available: 0.23, total: 0.23 }]);
    const openOrders = await venue.getOpenOrders(signer.address);
    expect(openOrders[0]?.externalId).toBe('order-1');
    expect(openOrders[0]?.price).toBe(0.5);
    const positions = await venue.getPositions(signer.address);
    expect(positions[0]).toMatchObject({ tokenId: 'predict-token', size: 2, notionalUsd: 1.4, averagePrice: 0.7 });
    const riskSnapshot = await venue.getAccountRiskSnapshot(signer.address, signer, Date.now() - 60_000);
    expect(riskSnapshot.fills[0]).toMatchObject({ id: 'activity-1', tokenId: 'predict-token', realizedPnlUsd: -1.25 });
    expect(riskSnapshot.realizedPnlUsd).toBe(-1.25);
    expect(riskSnapshot.unrealizedPnlUsd).toBe(0);
    expect(riskSnapshot.equityUsd).toBeGreaterThan(0);
    const approval = await venue.inspectApprovals(
      new LocalWalletSigner('0x0123456789012345678901234567890123456789012345678901234567890123'),
      undefined
    );
    expect(approval.checks.find((check) => check.name === 'native-gas')?.ok).toBe(true);
    expect(approval.checks.find((check) => check.name === 'native-gas')?.message).toContain('accepted because existing approval');
    expect(approval.checks.find((check) => check.name === 'usdt-allowance')).toBeUndefined();
    await venue.cancelOrders(['order-1']);
    const auth = await venue.authenticate(signer);
    expect(auth.credential).toEqual({ jwt: 'jwt-token' });
    expect(seen.some((entry) => entry.apiKey === 'api-key')).toBe(true);
  });

  it('keeps Predict account fills and positions available when USDT balance RPC fails', async () => {
    const baseUrl = await mockServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === '/v1/positions' && req.method === 'GET') {
        return json(res, {
          success: true,
          data: [
            {
              id: 'position-1',
              market: { id: 'market-1' },
              outcome: { name: 'YES', onChainId: 'predict-token' },
              amount: '2',
              valueUsd: '1.4',
              averageBuyPriceUsd: '0.7'
            }
          ]
        });
      }
      if (url.pathname === '/v1/account/activity' && req.method === 'GET') {
        return json(res, {
          success: true,
          data: [
            {
              id: 'activity-1',
              type: 'MATCH',
              side: 'BUY',
              tokenId: 'predict-token',
              price: '0.50',
              shares: '10',
              realizedPnlUsd: '-1.25',
              createdAt: new Date().toISOString()
            }
          ]
        });
      }
      res.statusCode = 404;
      res.end('{}');
    });
    const config = appConfigSchema.parse({
      endpointPolicy: { allowCustom: true },
      venues: { predict: { apiBaseUrl: baseUrl } }
    });
    const venue = new PredictVenue(config, { jwt: 'jwt-token' });
    (venue as unknown as { getBalances: () => Promise<never> }).getBalances = async () => {
      throw new Error('balance rpc down');
    };

    const snapshot = await venue.getAccountRiskSnapshot(signer.address, signer, Date.now() - 60_000);

    expect(snapshot.source).toBe('venue');
    expect(snapshot.balances).toEqual([]);
    expect(snapshot.fills[0]).toMatchObject({ id: 'activity-1', tokenId: 'predict-token', realizedPnlUsd: -1.25 });
    expect(snapshot.positions[0]).toMatchObject({ tokenId: 'predict-token', size: 2, notionalUsd: 1.4 });
    expect(snapshot.realizedPnlUsd).toBe(-1.25);
    expect(snapshot.equityUsd).toBeUndefined();
    expect(snapshot.warnings.some((warning) => warning.includes('USDT balance unavailable'))).toBe(true);
  });

  it('caps Predict market stats fetches while keeping selected markets prioritized', async () => {
    const seenStatsIds: string[] = [];
    const baseUrl = await mockServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === '/v1/markets') {
        const markets = Array.from({ length: 30 }, (_, index) => ({
          id: `market-${index}`,
          question: `Predict market ${index}`,
          tradingStatus: 'OPEN',
          status: 'REGISTERED',
          outcomes: [{ name: 'YES', onChainId: `token-${index}` }],
          liquidity_activation: { active: true, min_shares: 100, max_spread_cents: 6 },
          rewards: {
            current: {
              startsAt: new Date(Date.now() - 60_000).toISOString(),
              endsAt: new Date(Date.now() + 60 * 60_000).toISOString(),
              hourlyRate: 1000
            }
          }
        }));
        return json(res, { data: { markets } });
      }
      if (url.pathname === '/v1/categories') {
        return json(res, { data: { categories: [] } });
      }
      if (url.pathname.startsWith('/v1/markets/') && url.pathname.endsWith('/stats')) {
        seenStatsIds.push(url.pathname.split('/')[3] ?? '');
        return json(res, { data: { totalLiquidityUsd: 1000, volume24hUsd: 2000, volumeTotalUsd: 3000 } });
      }
      res.statusCode = 404;
      res.end('{}');
    });
    const config = appConfigSchema.parse({
      endpointPolicy: { allowCustom: true },
      strategy: { autoSelectMarkets: true, candidateLimit: 12 },
      selectedMarkets: { predict: ['token-28', 'token-29'], polymarket: [] },
      venues: { predict: { apiBaseUrl: baseUrl } }
    });
    const venue = new PredictVenue(config);
    const markets = await venue.getMarkets();

    expect(markets).toHaveLength(30);
    expect(seenStatsIds.length).toBe(24);
    expect(new Set(seenStatsIds).size).toBe(24);
    expect(seenStatsIds).toContain('market-28');
    expect(seenStatsIds).toContain('market-29');
  });

  it('retries Predict cancel with alternate payload shapes when remove rejects ids under data', async () => {
    const bodies: unknown[] = [];
    const baseUrl = await mockServer(async (req, res) => {
      const body = await readBody(req);
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === '/v1/orders/remove' && req.method === 'POST') {
        bodies.push(body);
        if (bodies.length === 1) {
          res.statusCode = 400;
          return json(res, { error: 'ids shape rejected' });
        }
        return json(res, { success: true, removed: ['order-1'] });
      }
      res.statusCode = 404;
      res.end('{}');
    });
    const config = appConfigSchema.parse({
      endpointPolicy: { allowCustom: true },
      venues: { predict: { apiBaseUrl: baseUrl } }
    });
    const venue = new PredictVenue(config, { jwt: 'jwt-token' });

    await venue.cancelOrders(['order-1']);

    expect(bodies).toEqual([
      { data: { ids: ['order-1'] } },
      { data: { orderIds: ['order-1'] } }
    ]);
  });

  it('submits Predict limit orders with 18-decimal share and price amounts', async () => {
    let submittedBody: any;
    const wsUrl = await mockWsServer((message, socket) => {
      if (message?.method === 'subscribe') {
        socket.send(JSON.stringify({ type: 'R', requestId: message.requestId, success: true, data: null }));
      }
    });
    const rpcUrl = await mockServer(async (req, res) => {
      const body = await readBody(req) as any;
      return json(res, rpcResponse(body));
    });
    const baseUrl = await mockServer(async (req, res) => {
      const body = await readBody(req);
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === '/v1/orders' && req.method === 'POST') {
        expect(req.headers.authorization).toBe('Bearer jwt-token');
        submittedBody = body;
        return json(res, { data: { orderId: '220162001', orderHash: 'predict-live-order' } });
      }
      res.statusCode = 404;
      res.end('{}');
    });
    const config = appConfigSchema.parse({
      endpointPolicy: { allowCustom: true },
      venues: { predict: { apiBaseUrl: baseUrl, rpcUrl, wsUrl } }
    });
    const venue = new PredictVenue(config, { jwt: 'jwt-token' });
    const liveSigner = new LocalWalletSigner('0x0123456789012345678901234567890123456789012345678901234567890123');
    const result = await venue.createOrder({
      venue: 'predict',
      market: {
        venue: 'predict',
        tokenId: '12345',
        question: 'Spurs vs. Thunder',
        outcome: 'SAS',
        volume24hUsd: 10000,
        liquidityUsd: 30000,
        acceptingOrders: true,
        endTime: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        endTimeSource: 'market-end',
        negRisk: false,
        yieldBearing: true,
        feeRateBps: 0,
        tickSize: 0.01,
        rewards: { enabled: true, level: 5, minShares: 10, maxSpreadCents: 6 }
      },
      tokenId: '12345',
      side: 'BUY',
      price: 0.15,
      size: 53.3333,
      notionalUsd: 8,
      postOnly: true,
      reason: 'regression',
      clientOrderId: 'predict-quantity-wei-regression'
    }, liveSigner);

    expect(result.externalId).toBe('220162001');
    const order = submittedBody?.data?.order;
    expect(order).toBeTruthy();
    expect(submittedBody?.data?.pricePerShare).toBe(parseUnits('0.15', 18).toString());
    expect(order.signature).toMatch(/^0x/i);
    expect(order.maker).toBe(liveSigner.address);
    expect(order.signer).toBe(liveSigner.address);
    expect(BigInt(order.makerAmount)).toBeGreaterThan(parseUnits('7.99', 18));
    expect(BigInt(order.makerAmount)).toBeLessThan(parseUnits('8.01', 18));
    expect(BigInt(order.takerAmount)).toBeGreaterThan(parseUnits('53', 18));
  });

  it('requires Predict orderbook REST reads to be token-specific when the market has multiple outcomes', async () => {
    const baseUrl = await mockServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === '/v1/markets/yes-token/orderbook') {
        return json(res, {
          tokenId: 'yes-token',
          bids: [{ price: '0.176', shares: '100' }],
          asks: [{ price: '0.178', shares: '100' }]
        });
      }
      if (url.pathname === '/v1/markets/no-token/orderbook') {
        return json(res, {
          tokenId: 'no-token',
          bids: [{ price: '0.821', shares: '100' }],
          asks: [{ price: '0.824', shares: '100' }]
        });
      }
      res.statusCode = 404;
      res.end('{}');
    });
    const config = appConfigSchema.parse({
      endpointPolicy: { allowCustom: true },
      venues: { predict: { apiBaseUrl: baseUrl } }
    });
    const venue = new PredictVenue(config, { jwt: 'jwt-token' });

    const yesBook = await venue.getOrderbook('yes-token');
    const noBook = await venue.getOrderbook('no-token');

    expect(yesBook.asks[0]?.price).toBe(0.178);
    expect(noBook.asks[0]?.price).toBe(0.824);
  });

  it('falls back from a Predict token orderbook 400 to the market-level orderbook', async () => {
    const paths: string[] = [];
    const baseUrl = await mockServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      paths.push(url.pathname);
      if (url.pathname === '/v1/markets') {
        return json(res, {
          data: {
            markets: [
              {
                id: 'market-fallback',
                question: 'Fallback market',
                tradingStatus: 'OPEN',
                outcomes: [
                  { name: 'YES', onChainId: 'yes-token' },
                  { name: 'NO', onChainId: 'no-token' }
                ]
              }
            ]
          }
        });
      }
      if (url.pathname === '/v1/categories') return json(res, { data: { categories: [] } });
      if (url.pathname === '/v1/markets/yes-token/orderbook') {
        res.statusCode = 400;
        return json(res, { error: 'token path unsupported' });
      }
      if (url.pathname === '/v1/markets/market-fallback/orderbook') {
        return json(res, {
          bids: [{ price: '0.49', shares: '100' }],
          asks: [{ price: '0.51', shares: '100' }]
        });
      }
      res.statusCode = 404;
      res.end('{}');
    });
    const config = appConfigSchema.parse({
      endpointPolicy: { allowCustom: true },
      venues: { predict: { apiBaseUrl: baseUrl } }
    });
    const venue = new PredictVenue(config, { jwt: 'jwt-token' });
    await venue.getMarkets();

    const book = await venue.getOrderbook('yes-token');

    expect(book.bids[0]?.price).toBe(0.49);
    expect(paths).toContain('/v1/markets/yes-token/orderbook');
    expect(paths).toContain('/v1/markets/market-fallback/orderbook');
  });

  it('complements the second Predict binary outcome when WS exposes only a market-level book', async () => {
    const wsUrl = await mockWsServer((message, socket) => {
      if (message?.method === 'subscribe' && message?.params?.includes('predictOrderbook/sports-market')) {
        socket.send(JSON.stringify({ type: 'R', requestId: message.requestId, success: true, data: null }));
        socket.send(JSON.stringify({
          type: 'M',
          topic: 'predictOrderbook/sports-market',
          data: {
            bids: [{ price: '0.176', shares: '1000' }],
            asks: [{ price: '0.177', shares: '900' }]
          }
        }));
      }
    });
    const baseUrl = await mockServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === '/v1/markets') {
        return json(res, {
          data: {
            markets: [
              {
                id: 'sports-market',
                question: 'Thunder vs. Spurs',
                tradingStatus: 'OPEN',
                tickSize: 0.001,
                outcomes: [
                  { name: 'Spurs', onChainId: 'sas-token' },
                  { name: 'Thunder', onChainId: 'okc-token' }
                ]
              }
            ]
          }
        });
      }
      if (url.pathname === '/v1/categories') return json(res, { data: { categories: [] } });
      res.statusCode = 404;
      res.end('{}');
    });
    const config = appConfigSchema.parse({
      endpointPolicy: { allowCustom: true },
      venues: { predict: { apiBaseUrl: baseUrl, wsUrl } }
    });
    const venue = new PredictVenue(config);

    const markets = await venue.getMarkets();
    expect(markets.map((market) => market.outcomeIndex)).toEqual([0, 1]);
    const firstOutcomeBook = await venue.getOrderbook('sas-token');
    const secondOutcomeBook = await venue.getOrderbook('okc-token');

    expect(firstOutcomeBook.bids[0]?.price).toBe(0.176);
    expect(firstOutcomeBook.asks[0]?.price).toBe(0.177);
    expect(secondOutcomeBook.bids[0]?.price).toBe(0.823);
    expect(secondOutcomeBook.asks[0]?.price).toBe(0.824);
  });

  it('uses Predict yield-bearing exchange contracts when signing yield-bearing markets', async () => {
    const typedDataCalls: any[] = [];
    const responseBody = await createPredictOrderWithSdk({
      orderBuilder: {
        getLimitOrderAmounts({ quantityWei, pricePerShareWei }: any) {
          return {
            pricePerShare: pricePerShareWei,
            makerAmount: parseUnits('8', 18),
            takerAmount: quantityWei
          };
        },
        buildOrder(_strategy: string, data: any) {
          return {
            maker: data.maker,
            signer: data.signer,
            tokenId: String(data.tokenId),
            makerAmount: String(data.makerAmount),
            takerAmount: String(data.takerAmount),
            feeRateBps: String(data.feeRateBps),
            side: data.side
          };
        },
        buildTypedData(order: any, flags: any) {
          typedDataCalls.push(flags);
          return { order, flags };
        },
        async signTypedDataOrder(typedData: any) {
          return { ...typedData.order, signature: '0xsigned' };
        },
        buildTypedDataHash() {
          return '0xhash';
        }
      },
      market: {
        venue: 'predict',
        tokenId: '12345',
        question: 'Yield-bearing market',
        volume24hUsd: 10000,
        liquidityUsd: 30000,
        acceptingOrders: true,
        endTime: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        endTimeSource: 'market-end',
        negRisk: false,
        yieldBearing: true,
        feeRateBps: 0,
        tickSize: 0.01
      }
    });

    expect(typedDataCalls[0]).toEqual({ isNegRisk: false, isYieldBearing: true });
    expect(responseBody?.data?.order?.hash).toBe('0xhash');
  });

  it('normalizes Polymarket gamma, rewards, and CLOB book responses', async () => {
    const baseUrl = await mockServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === '/sampling-simplified-markets') {
        return json(res, {
          data: [
            {
              condition_id: 'condition-1',
              accepting_orders: true,
              tokens: [{ token_id: 'poly-token', outcome: 'Yes' }],
              rewards: {
                min_size: 100,
                max_spread: 0.06,
                rates: [{ asset_address: '0x2791bca1f2de4661ed88a30c99a7a9449aa84174', rewards_daily_rate: 12 }]
              }
            }
          ]
        });
      }
      if (url.pathname === '/markets') {
        return json(res, [
          {
            id: 'event-1',
            conditionId: 'condition-1',
            active: true,
            closed: false,
            question: 'Will Polymarket contract pass?',
            outcomes: JSON.stringify(['YES']),
            clobTokenIds: JSON.stringify(['poly-token']),
            volume: '3000',
            liquidity: '4000',
            minimumTickSize: '0.01'
          }
        ]);
      }
      if (url.pathname === '/book') {
        expect(url.searchParams.get('token_id')).toBe('poly-token');
        return json(res, { bids: [{ price: '0.48', size: '200' }], asks: [{ price: '0.52', size: '200' }] });
      }
      if (url.pathname === '/positions') {
        expect(url.searchParams.get('user')).toBe(signer.address);
        return json(res, [
          {
            asset: 'poly-token',
            conditionId: 'condition-1',
            outcome: 'YES',
            size: '12',
            currentValue: '6.24',
            avgPrice: '0.50'
          }
        ]);
      }
      if (url.pathname === '/trades') {
        expect(url.searchParams.get('user')).toBe(signer.address);
        return json(res, [
          {
            id: 'trade-1',
            asset: 'poly-token',
            side: 'SELL',
            price: '0.52',
            size: '4',
            realizedPnl: '0.08',
            timestamp: Math.floor(Date.now() / 1000)
          }
        ]);
      }
      if (url.pathname === '/value') {
        expect(url.searchParams.get('user')).toBe(signer.address);
        return json(res, { value: '506.24', realizedPnl: '0.08', unrealizedPnl: '-0.01' });
      }
      res.statusCode = 404;
      res.end('{}');
    });
    const config = appConfigSchema.parse({
      endpointPolicy: { allowCustom: true },
      venues: { polymarket: { gammaUrl: baseUrl, clobUrl: baseUrl, dataApiUrl: baseUrl } }
    });
    const venue = new PolymarketVenue(config, { key: 'key', secret: 'secret', passphrase: 'pass' });
    const markets = await venue.getMarkets();
    expect(markets[0]?.tokenId).toBe('poly-token');
    expect(markets[0]?.rewards?.dailyRate).toBe(12);
    const book = await venue.getOrderbook('poly-token');
    expect(book.asks[0]?.price).toBe(0.52);
    const positions = await venue.getPositions(signer.address);
    expect(positions[0]).toMatchObject({ tokenId: 'poly-token', size: 12, notionalUsd: 6.24 });
    const riskSnapshot = await venue.getAccountRiskSnapshot(signer.address, signer, Date.now() - 60_000);
    expect(riskSnapshot.fills[0]).toMatchObject({ id: 'trade-1', tokenId: 'poly-token', realizedPnlUsd: 0.08 });
    expect(riskSnapshot.equityUsd).toBe(506.24);
  });
});

async function mockServer(handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void): Promise<string> {
  const server = createServer((req, res) => {
    void Promise.resolve(handler(req, res)).catch((error) => {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push({
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function mockWsServer(handler: (message: any, socket: import('ws').WebSocket) => void): Promise<string> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  wss.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const parsed = JSON.parse(raw.toString());
      handler(parsed, socket);
    });
  });
  await new Promise<void>((resolve) => wss.once('listening', resolve));
  wsServers.push({
    close: () => new Promise<void>((resolve, reject) => {
      for (const client of wss.clients) client.terminate();
      wss.close((error) => error ? reject(error) : resolve());
    })
  });
  const address = wss.address() as AddressInfo;
  return `ws://127.0.0.1:${address.port}/ws`;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return undefined;
  return JSON.parse(raw);
}

function json(res: ServerResponse, value: unknown): void {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(value));
}

async function createPredictOrderWithSdk(input: { orderBuilder: any; market: Market }): Promise<any> {
  const wsUrl = await mockWsServer((message, socket) => {
    if (message?.method === 'subscribe') {
      socket.send(JSON.stringify({ type: 'R', requestId: message.requestId, success: true, data: null }));
    }
  });
  const rpcUrl = await mockServer(async (_req, res) => json(res, { jsonrpc: '2.0', id: 1, result: '0x38' }));
  let submittedBody: any;
  const baseUrl = await mockServer(async (req, res) => {
    const body = await readBody(req);
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/v1/orders' && req.method === 'POST') {
      submittedBody = body;
      return json(res, { data: { orderHash: 'predict-live-order' } });
    }
    res.statusCode = 404;
    res.end('{}');
  });
  const config = appConfigSchema.parse({
    endpointPolicy: { allowCustom: true },
    venues: { predict: { apiBaseUrl: baseUrl, rpcUrl, wsUrl } }
  });
  const venue = new PredictVenue(config, { jwt: 'jwt-token' });
  (venue as unknown as { predictSdk: () => Promise<any> }).predictSdk = async () => ({
    ChainId: { BnbMainnet: 56 },
    Side: { BUY: 0, SELL: 1 },
    OrderBuilder: {
      make: async () => input.orderBuilder
    }
  });
  await venue.createOrder({
    venue: 'predict',
    market: input.market,
    tokenId: input.market.tokenId,
    side: 'BUY',
    price: 0.15,
    size: 53.3333,
    notionalUsd: 8,
    postOnly: true,
    reason: 'regression',
    clientOrderId: 'predict-yield-bearing-regression'
  }, new LocalWalletSigner('0x0123456789012345678901234567890123456789012345678901234567890123'));
  return submittedBody;
}

function rpcResponse(body: any): unknown {
  if (body?.method === 'eth_call') {
    return { jsonrpc: '2.0', id: body.id, result: '0x00000000000000000000000000000000000000000000000003311fc80a570000' };
  }
  if (body?.method === 'eth_getBalance') {
    return { jsonrpc: '2.0', id: body.id, result: '0x0' };
  }
  return { jsonrpc: '2.0', id: body?.id ?? 1, result: '0x38' };
}
