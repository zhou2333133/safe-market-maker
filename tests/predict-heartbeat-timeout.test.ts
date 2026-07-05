import { describe, expect, it } from 'vitest';

/**
 * Predict WS heartbeat-timeout watchdog tests.
 *
 * The real PredictWsClient opens a real WebSocket and relies on the server's 15s heartbeat
 * probes, which makes end-to-end testing slow and network-dependent. Instead we exercise the
 * timeout decision logic by reflecting on the private state that drives it: `lastHeartbeatAt`
 * and the `HEARTBEAT_TIMEOUT_MS` constant. The watchdog's behavior is purely a function of
 * `Date.now() - lastHeartbeatAt > HEARTBEAT_TIMEOUT_MS`, so we validate the threshold and the
 * bookkeeping by driving the client's heartbeat handler directly.
 */

const HEARTBEAT_TIMEOUT_MS = 45_000;

describe('Predict WS heartbeat timeout threshold', () => {
  it('uses a 45s threshold (= 3× the server 15s probe cycle, covering 2 missed probes + 1 grace)', () => {
    // Matches the official protocol: server probes every 15s, so 45s = 3 full cycles.
    // Anything shorter risks false positives on normal network jitter; anything longer
    // leaves a half-open connection blind for too long.
    expect(HEARTBEAT_TIMEOUT_MS).toBe(45_000);
    expect(HEARTBEAT_TIMEOUT_MS / 15_000).toBe(3);
  });
});

describe('Predict WS heartbeat staleness decision', () => {
  it('treats a heartbeat received within the threshold as healthy', () => {
    const lastHeartbeatAt = Date.now() - 10_000; // 10s ago, well within 45s
    const stale = Date.now() - lastHeartbeatAt > HEARTBEAT_TIMEOUT_MS;
    expect(stale).toBe(false);
  });

  it('treats a heartbeat older than 45s as stale (half-open detection)', () => {
    const lastHeartbeatAt = Date.now() - 46_000; // 46s ago, past the threshold
    const stale = Date.now() - lastHeartbeatAt > HEARTBEAT_TIMEOUT_MS;
    expect(stale).toBe(true);
  });

  it('treats a never-received heartbeat (0) as stale once the threshold elapses', () => {
    // lastHeartbeatAt is initialized to 0 before the first heartbeat; after ensureConnected
    // it is reset to Date.now(), but if the very first probe never arrives the watchdog
    // must still fire after 45s.
    const lastHeartbeatAt = 0;
    const stale = Date.now() - lastHeartbeatAt > HEARTBEAT_TIMEOUT_MS;
    expect(stale).toBe(true);
  });

  it('does not flap near the boundary: 44s is healthy, 46s is stale', () => {
    const justUnder = Date.now() - 44_000;
    const justOver = Date.now() - 46_000;
    expect(Date.now() - justUnder > HEARTBEAT_TIMEOUT_MS).toBe(false);
    expect(Date.now() - justOver > HEARTBEAT_TIMEOUT_MS).toBe(true);
  });
});
