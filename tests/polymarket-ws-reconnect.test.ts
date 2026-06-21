import { afterEach, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { PolymarketWsClient } from '../src/venues/polymarket-ws.js';

function waitFor(cond: () => boolean, timeoutMs = 4000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = (): void => {
      if (cond()) { resolve(); return; }
      if (Date.now() - start > timeoutMs) { reject(new Error('waitFor timed out')); return; }
      setTimeout(tick, 20);
    };
    tick();
  });
}

describe('Polymarket WS auto-reconnect', () => {
  let wss: WebSocketServer | undefined;
  let client: PolymarketWsClient | undefined;

  afterEach(async () => {
    client?.close();
    await new Promise<void>((resolve) => (wss ? wss.close(() => resolve()) : resolve()));
    wss = undefined;
    client = undefined;
  });

  it('auto-reconnects after an unexpected drop and stops reconnecting after close()', async () => {
    const sockets: WebSocket[] = [];
    let connections = 0;
    wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    wss.on('connection', (socket) => { connections += 1; sockets.push(socket); });
    await new Promise<void>((resolve) => wss!.once('listening', () => resolve()));
    const port = (wss.address() as { port: number }).port;

    client = new PolymarketWsClient(`ws://127.0.0.1:${port}/ws/market`);
    await client.subscribeMarkets(['tokenA']);
    expect(client.stats().connected).toBe(true);
    expect(connections).toBe(1);

    // Server drops the connection unexpectedly → the client must reconnect on its own
    // (no new subscribe() call), which the old code never did.
    sockets[0]!.close();
    await waitFor(() => connections >= 2 && (client?.stats().connected ?? false));
    expect(client.stats().connected).toBe(true);

    // An intentional close() disables auto-reconnect — no further connections.
    client.close();
    const afterClose = connections;
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(connections).toBe(afterClose);
  });
});
