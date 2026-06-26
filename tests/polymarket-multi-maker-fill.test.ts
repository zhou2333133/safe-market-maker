import { describe, expect, it } from 'vitest';
import { parsePolymarketTrade } from '../src/execution/polymarket-user-stream-handler.js';

// Bug context (production 2026-06-26 06:55 UTC): a Polymarket TRADE with multiple makers came across the
// user-channel WS. Bot was one of N makers. The parser used `record.size` (the trade TOTAL across all
// makers, ~2065) instead of bot's own portion from `record.maker_orders[i].matched_amount` (~150). The
// inflated size flowed into the stop-loss SELL intent which the venue rejected with "balance: 150, order
// amount: 2065" — bot never exited the position and lost $76 before daily-loss-limit tripped.
//
// Fix: when the parser is given the bot's wallet address, it sums matched_amount across the maker_orders
// entries that match. Existing callers without an address fall back to record.size (backwards-compat).

const BOT_ADDR = '0xC0E72EF95e7C254F69bB4346A7591778bA46a1B8';
const OTHER_A = '0x0bc46452369b36101e158FE895Ce91F9C7Eb2d40';
const OTHER_B = '0x0446942dF9d24B9A7dE25eaC318A129C1714cC69';

function trade(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    trade_id: 'trade-1',
    asset_id: 'tokA',
    price: '0.502',
    side: 'SELL',
    size: '2065',
    ...overrides
  };
}

describe('parsePolymarketTrade — multi-maker fill size correction', () => {
  it('without botAddress: uses record.size as-is (legacy back-compat)', () => {
    const fill = parsePolymarketTrade(trade(), Date.now());
    expect(fill?.size).toBe(2065);
  });

  it('with botAddress AND maker_orders containing bot: returns bot’s matched_amount (not trade total)', () => {
    // Real production-shaped record: bot is one of three makers, matched 150 shares
    const fill = parsePolymarketTrade(
      trade({
        maker_orders: [
          { maker_address: OTHER_A, matched_amount: '900', price: '0.502', side: 'BUY' },
          { maker_address: BOT_ADDR, matched_amount: '150', price: '0.502', side: 'BUY' },
          { maker_address: OTHER_B, matched_amount: '1015', price: '0.504', side: 'BUY' }
        ]
      }),
      Date.now(),
      BOT_ADDR
    );
    expect(fill?.size).toBe(150);
  });

  it('case-insensitive bot address match (Polymarket sometimes mixes lower/upper case in maker_address)', () => {
    const fill = parsePolymarketTrade(
      trade({
        maker_orders: [
          { maker_address: BOT_ADDR.toLowerCase(), matched_amount: '75', price: '0.502', side: 'BUY' }
        ]
      }),
      Date.now(),
      BOT_ADDR // mixed case input
    );
    expect(fill?.size).toBe(75);
  });

  it('multiple bot maker_orders entries are SUMMED (bot can have several resting orders matched in one trade)', () => {
    const fill = parsePolymarketTrade(
      trade({
        maker_orders: [
          { maker_address: BOT_ADDR, matched_amount: '50', price: '0.502', side: 'BUY' },
          { maker_address: OTHER_A, matched_amount: '900', price: '0.502', side: 'BUY' },
          { maker_address: BOT_ADDR, matched_amount: '70', price: '0.501', side: 'BUY' }
        ]
      }),
      Date.now(),
      BOT_ADDR
    );
    expect(fill?.size).toBe(120); // 50 + 70
  });

  it('bot NOT in maker_orders (bot is taker): falls back to record.size — the taker IS the full trade', () => {
    const fill = parsePolymarketTrade(
      trade({
        maker_orders: [
          { maker_address: OTHER_A, matched_amount: '900', price: '0.502', side: 'BUY' },
          { maker_address: OTHER_B, matched_amount: '1165', price: '0.504', side: 'BUY' }
        ]
      }),
      Date.now(),
      BOT_ADDR
    );
    expect(fill?.size).toBe(2065); // record.size, because bot is the taker (not in maker list)
  });

  it('maker_orders absent (older wire shape): falls back to record.size', () => {
    const fill = parsePolymarketTrade(trade({ /* no maker_orders */ }), Date.now(), BOT_ADDR);
    expect(fill?.size).toBe(2065);
  });

  it('botAddress + maker_orders empty array: falls back to record.size', () => {
    const fill = parsePolymarketTrade(trade({ maker_orders: [] }), Date.now(), BOT_ADDR);
    expect(fill?.size).toBe(2065);
  });

  it('does not overwrite other fields (price / tokenId / side carry through)', () => {
    const fill = parsePolymarketTrade(
      trade({
        maker_orders: [{ maker_address: BOT_ADDR, matched_amount: '42', price: '0.502', side: 'BUY' }]
      }),
      Date.now(),
      BOT_ADDR
    );
    expect(fill?.price).toBe(0.502);
    expect(fill?.tokenId).toBe('tokA');
    expect(fill?.side).toBe('SELL');
    expect(fill?.size).toBe(42);
    // notionalUsd is computed from the corrected size, not the trade total
    expect(fill?.notionalUsd).toBeCloseTo(42 * 0.502, 6);
  });
});
