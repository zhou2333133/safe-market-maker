import { describe, expect, it } from 'vitest';
import { isTokenInExitLiquidityCooldown, updateExitLiquidityCooldown } from '../src/execution/cancel-service.js';

function mockStore() {
  const cp = new Map<string, unknown>();
  return {
    getCheckpoint: (name: string) => (cp.has(name) ? { value: cp.get(name) } : undefined),
    checkpoint: (name: string, value: unknown) => { cp.set(name, value); }
  };
}
const cfg = { strategy: { exitLiquidityCooldownStrikes: 3, exitLiquidityCooldownWindowMs: 300000, exitLiquidityCooldownMs: 7200000 } };
const exitReason = (tokenId: string) => [{ tokenId, reason: '后方退出流动性 $10(仅近 2 跳内)不足以吃下挂单 $80(被吃会卡成单腿)' }];

describe('exit-liquidity cooldown', () => {
  it('cools down a token after 3 exit-liquidity cancels within the window (~40s apart)', () => {
    const store = mockStore();
    const t0 = 1_000_000_000_000;
    updateExitLiquidityCooldown(cfg, 'polymarket', exitReason('A'), [{ tokenId: 'A' }], store, t0);
    expect(isTokenInExitLiquidityCooldown(cfg, 'polymarket', 'A', store, t0 + 1000)).toBe(false);
    updateExitLiquidityCooldown(cfg, 'polymarket', exitReason('A'), [{ tokenId: 'A' }], store, t0 + 40000);
    expect(isTokenInExitLiquidityCooldown(cfg, 'polymarket', 'A', store, t0 + 41000)).toBe(false);
    updateExitLiquidityCooldown(cfg, 'polymarket', exitReason('A'), [{ tokenId: 'A' }], store, t0 + 80000);
    expect(isTokenInExitLiquidityCooldown(cfg, 'polymarket', 'A', store, t0 + 81000)).toBe(true);
  });

  it('expires the cooldown after exitLiquidityCooldownMs', () => {
    const store = mockStore();
    const t0 = 2_000_000_000_000;
    for (const dt of [0, 40000, 80000]) updateExitLiquidityCooldown(cfg, 'polymarket', exitReason('B'), [{ tokenId: 'B' }], store, t0 + dt);
    expect(isTokenInExitLiquidityCooldown(cfg, 'polymarket', 'B', store, t0 + 80000 + 7199000)).toBe(true);
    expect(isTokenInExitLiquidityCooldown(cfg, 'polymarket', 'B', store, t0 + 80000 + 7200001)).toBe(false);
  });

  it('does NOT trigger when the 3 strikes span more than the 5-min window (firstSeenAt, not consecutive)', () => {
    const store = mockStore();
    const t0 = 3_000_000_000_000;
    updateExitLiquidityCooldown(cfg, 'polymarket', exitReason('C'), [{ tokenId: 'C' }], store, t0);
    updateExitLiquidityCooldown(cfg, 'polymarket', exitReason('C'), [{ tokenId: 'C' }], store, t0 + 200000); // +3.3min
    updateExitLiquidityCooldown(cfg, 'polymarket', exitReason('C'), [{ tokenId: 'C' }], store, t0 + 360000); // +6min from first → reset
    expect(isTokenInExitLiquidityCooldown(cfg, 'polymarket', 'C', store, t0 + 361000)).toBe(false);
  });

  it('ignores cancels that are NOT exit-liquidity (e.g. GTD refresh)', () => {
    const store = mockStore();
    const t0 = 4_000_000_000_000;
    for (const dt of [0, 40000, 80000]) updateExitLiquidityCooldown(cfg, 'polymarket', [{ tokenId: 'D', reason: 'GTD 临近到期，刷新挂单延长有效期' }], [{ tokenId: 'D' }], store, t0 + dt);
    expect(isTokenInExitLiquidityCooldown(cfg, 'polymarket', 'D', store, t0 + 81000)).toBe(false);
  });

  it('is OFF when params are unset (Predict / any venue that does not opt in)', () => {
    const store = mockStore();
    const offCfg = { strategy: {} };
    const t0 = 5_000_000_000_000;
    for (const dt of [0, 40000, 80000]) updateExitLiquidityCooldown(offCfg, 'predict', exitReason('E'), [{ tokenId: 'E' }], store, t0 + dt);
    expect(isTokenInExitLiquidityCooldown(offCfg, 'predict', 'E', store, t0 + 81000)).toBe(false);
  });
});
