import { describe, expect, it, vi } from 'vitest';
import { PolymarketUserStreamHandler, parsePolymarketTrade } from '../src/execution/polymarket-user-stream-handler.js';

function fakeStore() {
  return {
    recordWsFill: vi.fn(),
    recordEvent: vi.fn(),
    checkpoint: vi.fn(),
    getCheckpoint: vi.fn(() => undefined)
  } as any;
}

describe('parsePolymarketTrade — defensive wire-format parsing', () => {
  it('parses the canonical TRADE shape (snake_case fields, string numbers)', () => {
    const fill = parsePolymarketTrade({
      event_type: 'trade',
      trade_id: '0xtrade1',
      taker_order_id: '0xorder1',
      asset_id: 'tokA',
      market: '0xcond1',
      side: 'BUY',
      price: '0.5',
      size: '100',
      fee: '0.5',
      timestamp: '1780000000'  // seconds
    }, 1781000000000);
    expect(fill).toBeDefined();
    expect(fill?.fillId).toBe('0xtrade1');
    expect(fill?.tokenId).toBe('tokA');
    expect(fill?.side).toBe('BUY');
    expect(fill?.price).toBe(0.5);
    expect(fill?.size).toBe(100);
    expect(fill?.notionalUsd).toBe(50);
    expect(fill?.feeUsd).toBe(0.5);
    expect(fill?.fillTs).toBe(1780000000 * 1000);
  });

  it('accepts camelCase aliases and ms-precision timestamps', () => {
    const fill = parsePolymarketTrade({
      type: 'trade',
      tradeId: 'tid42',
      assetId: 'tokB',
      side: 'sell',
      matchPrice: 0.62,
      matchSize: 50,
      timestamp: 1780000000123 // already ms
    }, 99);
    expect(fill?.fillId).toBe('tid42');
    expect(fill?.side).toBe('SELL');
    expect(fill?.notionalUsd).toBe(31);
    expect(fill?.fillTs).toBe(1780000000123);
  });

  it('falls back to receivedAt when wire format omits timestamp', () => {
    const fill = parsePolymarketTrade({ trade_id: 't1', price: 0.1, size: 1 }, 1782000000000);
    expect(fill?.fillTs).toBe(1782000000000);
  });

  it('returns undefined when fill_id / trade_id is missing (we must not write a fill we cannot dedup)', () => {
    expect(parsePolymarketTrade({ price: 0.5, size: 10 }, 0)).toBeUndefined();
  });

  it('returns undefined when price or size is non-positive (avoids zero-priced ghost fills)', () => {
    expect(parsePolymarketTrade({ trade_id: 't1', price: 0, size: 10 }, 0)).toBeUndefined();
    expect(parsePolymarketTrade({ trade_id: 't1', price: 0.5, size: 0 }, 0)).toBeUndefined();
  });
});

describe('PolymarketUserStreamHandler — store integration', () => {
  it('writes a fill to the WS-leg ledger AND records a warn event for operator visibility', () => {
    const store = fakeStore();
    const handler = new PolymarketUserStreamHandler(store);
    handler.handle('trade', {
      event_type: 'trade',
      trade_id: '0xabc',
      asset_id: 'tokA',
      side: 'BUY',
      price: '0.65',
      size: '100',
      timestamp: '1780000000'
    }, 1781000000000);
    expect(store.recordWsFill).toHaveBeenCalledTimes(1);
    const call = store.recordWsFill.mock.calls[0][0];
    expect(call.venue).toBe('polymarket');
    expect(call.fillId).toBe('0xabc');
    expect(call.notionalUsd).toBe(65);
    // operator-facing event must mention the fill so monitoring sees it without scanning raw rows
    const eventCall = store.recordEvent.mock.calls.find((c: any) => c[0].type === 'fill.ws-ledgered');
    expect(eventCall).toBeDefined();
    expect(eventCall[0].severity).toBe('warn'); // warn = "operator should see this", not error
  });

  it('records "ws-unparseable" event (not throw, not silent) when the wire format is something we do not know yet', () => {
    const store = fakeStore();
    const handler = new PolymarketUserStreamHandler(store);
    handler.handle('trade', { event_type: 'trade', something: 'we do not understand' }, 0);
    expect(store.recordWsFill).not.toHaveBeenCalled();
    const evt = store.recordEvent.mock.calls.find((c: any) => c[0].type === 'fill.ws-unparseable');
    expect(evt).toBeDefined();
  });

  it('order updates are surfaced as observability events without throwing (Commit 1 scope)', () => {
    const store = fakeStore();
    const handler = new PolymarketUserStreamHandler(store);
    handler.handle('order', { id: '0xord', status: 'CANCELED' }, 0);
    expect(store.recordWsFill).not.toHaveBeenCalled();
    const evt = store.recordEvent.mock.calls.find((c: any) => c[0].type === 'order.ws-update');
    expect(evt).toBeDefined();
    expect(evt[0].details.externalId).toBe('0xord');
    expect(evt[0].details.status).toBe('CANCELED');
  });

  it('handler.handle catches recordWsFill DB failures and logs error event (must not throw, must not kill WS)', () => {
    const store = fakeStore();
    store.recordWsFill.mockImplementationOnce(() => { throw new Error('disk full'); });
    const handler = new PolymarketUserStreamHandler(store);
    expect(() => handler.handle('trade', {
      event_type: 'trade', trade_id: 't', price: 0.5, size: 10
    }, 0)).not.toThrow();
    const evt = store.recordEvent.mock.calls.find((c: any) => c[0].type === 'fill.ws-ledger-failed');
    expect(evt).toBeDefined();
    expect(evt[0].severity).toBe('error');
  });
});
