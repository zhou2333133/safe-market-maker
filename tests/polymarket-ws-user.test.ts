import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { PolymarketWsClient } from '../src/venues/polymarket-ws.js';
import { shouldServeWsAccountCache, type PolymarketAccountCache } from '../src/venues/polymarket.js';
import type { OpenOrder } from '../src/domain/types.js';

function fakeUserSocket(client: PolymarketWsClient, activityAgoMs = 0): void {
  const anyClient = client as any;
  anyClient.userSocket = { readyState: WebSocket.OPEN };
  anyClient.userSubscribed = true;
  anyClient.lastUserActivityAt = Date.now() - activityAgoMs;
}

function pushUserMessage(client: PolymarketWsClient, payload: unknown): void {
  (client as any).onUserMessage(Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload)));
}

describe('polymarket user channel state', () => {
  it('is unhealthy without a socket and healthy with an open socket and fresh activity', () => {
    const client = new PolymarketWsClient('wss://example.invalid/ws/market');
    expect(client.userChannelState().healthy).toBe(false);
    fakeUserSocket(client);
    expect(client.userChannelState().healthy).toBe(true);
  });

  it('goes unhealthy when no activity (pong/event) arrived within the staleness window', () => {
    const client = new PolymarketWsClient('wss://example.invalid/ws/market');
    fakeUserSocket(client, 60_000);
    expect(client.userChannelState().healthy).toBe(false);
  });

  it('bumps accountEventsSeq on order events and both seqs on trade events', () => {
    const client = new PolymarketWsClient('wss://example.invalid/ws/market');
    const before = client.userChannelState();
    pushUserMessage(client, { event_type: 'order', id: 'o1', type: 'PLACEMENT' });
    let state = client.userChannelState();
    expect(state.accountEventsSeq).toBe(before.accountEventsSeq + 1);
    expect(state.tradeEventsSeq).toBe(before.tradeEventsSeq);
    pushUserMessage(client, { event_type: 'trade', id: 't1', status: 'MATCHED' });
    state = client.userChannelState();
    expect(state.accountEventsSeq).toBe(before.accountEventsSeq + 2);
    expect(state.tradeEventsSeq).toBe(before.tradeEventsSeq + 1);
  });

  it('treats non-JSON keepalive frames as activity without bumping event seqs', () => {
    const client = new PolymarketWsClient('wss://example.invalid/ws/market');
    fakeUserSocket(client, 60_000);
    expect(client.userChannelState().healthy).toBe(false);
    const before = client.userChannelState();
    pushUserMessage(client, 'PONG');
    const state = client.userChannelState();
    expect(state.healthy).toBe(true);
    expect(state.accountEventsSeq).toBe(before.accountEventsSeq);
    expect(state.tradeEventsSeq).toBe(before.tradeEventsSeq);
  });
});

describe('shouldServeWsAccountCache', () => {
  const order: OpenOrder = { venue: 'polymarket', externalId: 'x', tokenId: 't', side: 'BUY', price: 0.5, size: 10, status: 'OPEN' };
  const now = Date.now();
  const cache: PolymarketAccountCache<OpenOrder[]> = { owner: '0xabc', value: [order], at: now - 1000, seq: 7 };

  it('serves only when healthy, same owner, same seq and within TTL', () => {
    expect(shouldServeWsAccountCache(cache, '0xabc', { healthy: true, seq: 7 }, now)).toBe(true);
  });

  it('never serves without a cache or while the channel is unhealthy', () => {
    expect(shouldServeWsAccountCache(undefined, '0xabc', { healthy: true, seq: 7 }, now)).toBe(false);
    expect(shouldServeWsAccountCache(cache, '0xabc', { healthy: false, seq: 7 }, now)).toBe(false);
    expect(shouldServeWsAccountCache(cache, '0xabc', undefined, now)).toBe(false);
  });

  it('refetches on owner mismatch, any new order/trade event, or TTL expiry', () => {
    expect(shouldServeWsAccountCache(cache, '0xother', { healthy: true, seq: 7 }, now)).toBe(false);
    expect(shouldServeWsAccountCache(cache, '0xabc', { healthy: true, seq: 8 }, now)).toBe(false);
    expect(shouldServeWsAccountCache(cache, '0xabc', { healthy: true, seq: 7 }, now + 10_000)).toBe(false);
  });
});
