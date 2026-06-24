import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { appConfigSchema } from '../src/config/schema.js';
import { PolymarketVenue } from '../src/venues/polymarket.js';

const config = appConfigSchema.parse({
  venues: {
    polymarket: {
      clobUrl: 'https://clob.polymarket.com',
      gammaUrl: 'https://gamma-api.polymarket.com',
      dataApiUrl: 'https://data-api.polymarket.com',
      rpcUrl: 'https://polygon-bor-rpc.publicnode.com',
      wsUrl: 'wss://ws-subscriptions-clob.polymarket.com/ws/market',
      funderAddress: '0x0000000000000000000000000000000000000000',
      signatureType: 0
    }
  }
});

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('PolymarketVenue.getOrderbooksBatch — POST /books', () => {
  it('parses a top-level array response into a Map keyed by asset_id', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([
      { asset_id: 'tokA', bids: [{ price: '0.50', size: '100' }], asks: [{ price: '0.51', size: '80' }] },
      { asset_id: 'tokB', bids: [{ price: '0.10', size: '200' }], asks: [{ price: '0.11', size: '180' }] }
    ]));
    const venue = new PolymarketVenue(config);
    const books = await venue.getOrderbooksBatch(['tokA', 'tokB']);
    expect(books.size).toBe(2);
    expect(books.get('tokA')?.bids?.[0]?.price).toBe(0.5);
    expect(books.get('tokB')?.asks?.[0]?.price).toBeCloseTo(0.11);
    // The single POST call must have included BOTH token_ids in its body.
    const lastCall = fetchMock.mock.calls.at(-1);
    expect(lastCall?.[0]).toBe('https://clob.polymarket.com/books');
    expect(JSON.parse(String(lastCall?.[1]?.body))).toEqual([{ token_id: 'tokA' }, { token_id: 'tokB' }]);
    expect(lastCall?.[1]?.method).toBe('POST');
  });

  it('also accepts { books: [...] } and { data: [...] } shapes (forward-compat)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      books: [{ token_id: 'tokC', bids: [{ price: '0.7', size: '5' }], asks: [] }]
    }));
    const venue = new PolymarketVenue(config);
    const books = await venue.getOrderbooksBatch(['tokC']);
    expect(books.get('tokC')?.bids?.[0]?.size).toBe(5);
  });

  it('drops items lacking both bids[] and asks[] (malformed response is treated as a hole, not a crash)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([
      { asset_id: 'tokOK', bids: [{ price: '0.3', size: '1' }], asks: [] },
      { asset_id: 'tokBroken' /* no bids / asks */ },
      { token_id: 'tokOK2', bids: [], asks: [{ price: '0.99', size: '50' }] }
    ]));
    const venue = new PolymarketVenue(config);
    const books = await venue.getOrderbooksBatch(['tokOK', 'tokBroken', 'tokOK2']);
    expect(books.has('tokOK')).toBe(true);
    expect(books.has('tokBroken')).toBe(false);
    expect(books.has('tokOK2')).toBe(true);
  });

  it('splits a large batch into multiple POSTs of <= POLYMARKET_BOOKS_BATCH_SIZE', async () => {
    // Fresh Response per call so each one is independently readable.
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse([])));
    const venue = new PolymarketVenue(config);
    const tokens = Array.from({ length: 25 }, (_, i) => `tok${i}`);
    await venue.getOrderbooksBatch(tokens);
    // 25 tokens / batch=20 = 2 POST calls
    expect(fetchMock.mock.calls.length).toBe(2);
    const firstBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    const secondBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(firstBody).toHaveLength(20);
    expect(secondBody).toHaveLength(5);
  });

  it('dedupes the input token list before sending', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse([])));
    const venue = new PolymarketVenue(config);
    await venue.getOrderbooksBatch(['dup', 'dup', 'dup']);
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body).toEqual([{ token_id: 'dup' }]);
  });

  it('throws on HTTP error so the caller can fall back to single /book', async () => {
    fetchMock.mockResolvedValueOnce(new Response('forbidden', { status: 403 }));
    const venue = new PolymarketVenue(config);
    await expect(venue.getOrderbooksBatch(['tokX'])).rejects.toThrow(/HTTP 403/);
  });

  it('returns an empty Map for empty / falsy-token input without hitting the network', async () => {
    const venue = new PolymarketVenue(config);
    const empty = await venue.getOrderbooksBatch([]);
    expect(empty.size).toBe(0);
    const blanks = await venue.getOrderbooksBatch(['', '', '']);
    expect(blanks.size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
