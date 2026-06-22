import type { AppConfig } from '../config/schema.js';
import type { AccountRiskDecision, AccountRiskSnapshot, Balance, VenueName } from '../domain/types.js';

export function dayStartTs(now = Date.now()): number {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return start.getTime();
}

export function effectiveMaxLossUsd(config: AppConfig, venue: VenueName): number {
  const base = config.risk.maxDailyLossUsd;
  const polyCap = config.strategy.polymarketMaxLossUsd;
  // Polymarket principal-loss kill switch: when set (>0), it tightens the hard stop.
  if (venue === 'polymarket' && Number.isFinite(polyCap) && polyCap > 0) return Math.min(base, polyCap);
  return base;
}

export function evaluateAccountRisk(
  venue: VenueName,
  config: AppConfig,
  snapshot: AccountRiskSnapshot | undefined,
  now = Date.now()
): AccountRiskDecision {
  const maxDailyLossUsd = effectiveMaxLossUsd(config, venue);
  if (!snapshot) {
    return block(venue, 'snapshot-unavailable', maxDailyLossUsd, '账户级风控数据不可用，禁止新增挂单', []);
  }
  const ageMs = now - snapshot.capturedAt;
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > config.risk.maxAccountRiskStaleMs) {
    return {
      ...baseDecision(venue, snapshot, maxDailyLossUsd),
      ok: false,
      reason: 'snapshot-stale',
      message: `账户级风控数据已过期 ${Math.max(0, ageMs).toFixed(0)}ms，禁止新增挂单`
    };
  }
  const dailyPnlUsd = dailyPnl(snapshot);
  if (dailyPnlUsd !== undefined && dailyPnlUsd <= -maxDailyLossUsd) {
    return {
      ...baseDecision(venue, snapshot, maxDailyLossUsd),
      ok: false,
      reason: 'daily-loss-limit',
      message: `账户风控窗口盈亏 ${dailyPnlUsd.toFixed(2)} USD 触及亏损上限 ${maxDailyLossUsd} USD，禁止新增挂单`
    };
  }
  // Belt-and-suspenders: a realized loss past the cap trips the stop even if the equity-based daily PnL looks fine
  // (e.g. a stale-high equity read masking it). The kill-switch must err toward halting, never silently pass a loss.
  // EXCEPTION: skip when realizedPnlUsd was overwritten by the local cash-fill-exit FALLBACK estimate (warnings flag).
  // That value is explicitly labeled "may be incomplete" and is meant for diagnostic visibility, not as a hard kill
  // signal — it false-positively halted Predict at -$9.39 estimated when the equity actually showed only -$1.02.
  // The equity-based dailyPnl check above (now using genuine venue equity) is the authoritative signal.
  const realizedLossUsd = finiteOrUndefined(snapshot.realizedPnlUsd);
  const realizedIsFallbackEstimate = snapshot.warnings.some((w) => w.includes('Local cash-fill exit fallback estimated'));
  if (realizedLossUsd !== undefined && !realizedIsFallbackEstimate && realizedLossUsd <= -maxDailyLossUsd) {
    return {
      ...baseDecision(venue, snapshot, maxDailyLossUsd),
      ok: false,
      reason: 'daily-loss-limit',
      message: `已实现亏损 ${realizedLossUsd.toFixed(2)} USD 触及亏损上限 ${maxDailyLossUsd} USD，禁止新增挂单`
    };
  }
  const equityDrawdown = equityDrawdownUsd(snapshot);
  if (equityDrawdown !== undefined && equityDrawdown >= maxDailyLossUsd) {
    return {
      ...baseDecision(venue, snapshot, maxDailyLossUsd),
      ok: false,
      reason: 'equity-drawdown-limit',
      message: `账户权益较日初回撤 ${equityDrawdown.toFixed(2)} USD 触及亏损上限 ${maxDailyLossUsd} USD，禁止新增挂单`
    };
  }
  if (dailyPnlUsd === undefined && equityDrawdown === undefined) {
    return {
      ...baseDecision(venue, snapshot, maxDailyLossUsd),
      ok: false,
      reason: 'snapshot-unavailable',
      message: '账户级风控快照缺少可验证的风控窗口 PnL/权益字段，禁止新增挂单'
    };
  }
  return {
    ...baseDecision(venue, snapshot, maxDailyLossUsd),
    ok: true,
    reason: 'ok',
    message: '账户级风控窗口通过'
  };
}

export function accountEquityUsd(balances: Balance[], positionsValueUsd: number): number | undefined {
  const cash = balances
    .filter((balance) => ['USDT', 'USDC', 'PUSD', 'USD'].includes(balance.asset.toUpperCase()))
    .reduce((sum, balance) => sum + (Number.isFinite(balance.total) ? balance.total : 0), 0);
  const equity = cash + positionsValueUsd;
  return Number.isFinite(equity) ? Number(equity.toFixed(4)) : undefined;
}

function baseDecision(
  venue: VenueName,
  snapshot: AccountRiskSnapshot,
  maxDailyLossUsd: number
): Omit<AccountRiskDecision, 'ok' | 'reason' | 'message'> {
  return {
    venue,
    capturedAt: snapshot.capturedAt,
    maxDailyLossUsd,
    dailyPnlUsd: dailyPnl(snapshot),
    realizedPnlUsd: finiteOrUndefined(snapshot.realizedPnlUsd),
    unrealizedPnlUsd: finiteOrUndefined(snapshot.unrealizedPnlUsd),
    netCashflowUsd: finiteOrUndefined(snapshot.netCashflowUsd),
    equityUsd: finiteOrUndefined(snapshot.equityUsd),
    dayStartEquityUsd: finiteOrUndefined(snapshot.dayStartEquityUsd),
    warnings: snapshot.warnings
  };
}

function block(
  venue: VenueName,
  reason: AccountRiskDecision['reason'],
  maxDailyLossUsd: number,
  message: string,
  warnings: string[]
): AccountRiskDecision {
  return { ok: false, venue, reason, maxDailyLossUsd, warnings, message };
}

function dailyPnl(snapshot: AccountRiskSnapshot): number | undefined {
  const equityPnl = equityPnlUsd(snapshot);
  if (equityPnl !== undefined) return equityPnl;

  const realized = finiteOrUndefined(snapshot.realizedPnlUsd);
  const unrealized = finiteOrUndefined(snapshot.unrealizedPnlUsd);
  const hasSameDayFills = snapshot.fills.length > 0;
  const hasOpenPositions = snapshot.positions.some((position) => Math.abs(position.size) > 1e-9 || Math.abs(position.notionalUsd) > 0.01);
  const realizedReady = realized !== undefined || !hasSameDayFills;
  const unrealizedReady = unrealized !== undefined || !hasOpenPositions;
  if (realizedReady && unrealizedReady) {
    return Number(((realized ?? 0) + (unrealized ?? 0)).toFixed(4));
  }
  return undefined;
}

function equityDrawdownUsd(snapshot: AccountRiskSnapshot): number | undefined {
  const equityPnl = equityPnlUsd(snapshot);
  if (equityPnl === undefined) return undefined;
  return Number(Math.max(0, -equityPnl).toFixed(4));
}

function equityPnlUsd(snapshot: AccountRiskSnapshot): number | undefined {
  const equity = Number(snapshot.equityUsd);
  const dayStart = Number(snapshot.dayStartEquityUsd);
  // A live, funded account never reads exactly 0 (or negative) equity while trading — a 0 here is the signature of a
  // FAILED read (e.g. data-api down → cash/value parsed as 0). Trusting it computes a bogus 0 daily PnL and BLINDS the
  // stop-loss. Treat non-positive equity OR a non-positive day-start baseline as "equity unknown" so daily PnL falls
  // back to realized+unrealized, which still reflects the loss.
  if (!Number.isFinite(equity) || !Number.isFinite(dayStart) || equity <= 0 || dayStart <= 0) return undefined;
  return Number((equity - dayStart).toFixed(4));
}

function finiteOrUndefined(value: number | undefined): number | undefined {
  return Number.isFinite(value) ? Number(value) : undefined;
}
