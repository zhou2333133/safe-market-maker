import type { AppConfig } from '../config/schema.js';
import type { AccountRiskDecision, AccountRiskSnapshot, Balance, Position, VenueName } from '../domain/types.js';
import { dayStartTs, evaluateAccountRisk } from '../risk/account-risk.js';
import { forensicLog } from '../observability/forensic-log.js';
import { httpErrorDetails } from '../observability/http-error.js';
import { accountRiskReasonCode, rejectReason } from '../risk/reject-reasons.js';
import type { SignerProvider } from '../secrets/signer.js';
import type { StateStore } from '../store/sqlite.js';
import type { VenueAdapter } from '../venues/types.js';

const LIVE_SESSION_BASELINE_MAX_DELAY_MS = 5 * 60_000;

export type AccountRiskScope = 'auto-loop' | 'manual-order';

export interface AccountRiskGateInput {
  venue: VenueName;
  signerAddress: string;
  signer: SignerProvider;
  dayStart?: number;
  scope?: AccountRiskScope;
}

export interface AccountSyncInput {
  venue: VenueName;
  signerAddress: string;
  signer: SignerProvider;
}

export interface PositionSyncResult {
  ok: boolean;
  positions: Position[];
}

export class AccountSyncService {
  constructor(
    private readonly config: AppConfig,
    private readonly adapter: VenueAdapter,
    private readonly store: StateStore
  ) {}

  async accountRiskGate(input: AccountRiskGateInput): Promise<AccountRiskDecision> {
    const dayStart = input.dayStart ?? dayStartTs();
    const scope = input.scope ?? 'auto-loop';
    let snapshot: AccountRiskSnapshot | undefined;
    try {
      if (!this.adapter.getAccountRiskSnapshot) {
        throw new Error(`${input.venue} adapter does not expose account risk snapshot`);
      }
      snapshot = await this.adapter.getAccountRiskSnapshot(input.signerAddress, input.signer, dayStart);
      snapshot = this.withLiveSessionEquityBaseline(input.venue, snapshot, dayStart);
      snapshot = this.withLocalCashExitLossFallback(input.venue, snapshot, dayStart);
      this.store.recordAccountRiskSnapshot(snapshot);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.recordEvent({
        venue: input.venue,
        severity: 'error',
        type: 'risk.account-snapshot.unavailable',
        message: '账户级成交/仓位/权益风控数据不可用，本轮不会新增订单',
        details: { error: message, scope, ...httpErrorDetails(error), reject: rejectReason('ACCOUNT_SNAPSHOT_UNAVAILABLE', 'account', scope) }
      });
      const decision = evaluateAccountRisk(input.venue, this.config, undefined);
      this.store.recordAccountRiskDecision({ ...decision, message: `${decision.message}：${message}` });
      this.store.checkpoint(`run.${input.venue}`, { mode: 'live', skippedQuoting: true, reason: 'risk.account-snapshot.unavailable', scope });
      return decision;
    }

    const decision = evaluateAccountRisk(input.venue, this.config, snapshot);
    // Forensic capture of EVERY stop-loss evaluation — including the silent ok:true passes the UI never records.
    // This is what makes "why didn't the $N stop fire" answerable after the fact: the raw equity/dayStart/realized
    // inputs are all here, so a poisoned 0 equity baseline producing dailyPnl=0 is visible cycle by cycle.
    forensicLog('risk-gate', input.venue, {
      scope,
      ok: decision.ok,
      reason: decision.reason,
      maxDailyLossUsd: decision.maxDailyLossUsd,
      dailyPnlUsd: decision.dailyPnlUsd,
      realizedPnlUsd: decision.realizedPnlUsd,
      unrealizedPnlUsd: decision.unrealizedPnlUsd,
      equityUsd: decision.equityUsd,
      dayStartEquityUsd: decision.dayStartEquityUsd,
      netCashflowUsd: decision.netCashflowUsd,
      fills: snapshot?.fills?.length,
      positions: snapshot?.positions?.length,
      warnings: decision.warnings
    });
    this.store.recordAccountRiskDecision(decision);
    if (decision.ok) return decision;

    this.store.recordEvent({
      venue: input.venue,
      severity: 'error',
      type: decision.reason === 'daily-loss-limit' || decision.reason === 'equity-drawdown-limit'
        ? 'risk.daily-loss-limit'
        : 'risk.account-gate.blocked',
      message: decision.message,
      details: {
        decision,
        scope,
        snapshotSource: snapshot.source,
        since: new Date(dayStart).toISOString(),
        reject: rejectReason(accountRiskReasonCode(decision.reason), 'account', scope)
      }
    });
    this.store.checkpoint(`run.${input.venue}`, { mode: 'live', skippedQuoting: true, reason: decision.reason, scope, decision });
    return decision;
  }

  private withLocalCashExitLossFallback(
    venue: VenueName,
    snapshot: AccountRiskSnapshot,
    dayStart: number
  ): AccountRiskSnapshot {
    const local = this.store.localCashExitLossSince(venue, dayStart);
    if (local.estimatedLossUsd <= 0) return snapshot;
    const platformRealized = Number.isFinite(snapshot.realizedPnlUsd) ? Number(snapshot.realizedPnlUsd) : undefined;
    const fallbackRealized = local.estimatedRealizedPnlUsd;
    if (platformRealized !== undefined && platformRealized <= fallbackRealized) return snapshot;
    return {
      ...snapshot,
      source: snapshot.source === 'venue' ? 'venue+chain' : snapshot.source,
      realizedPnlUsd: fallbackRealized,
      warnings: [
        ...snapshot.warnings,
        `Local cash-fill exit fallback estimated ${local.estimatedLossUsd.toFixed(4)} USD loss because venue fills may be incomplete.`
      ],
      raw: {
        ...(snapshot.raw && typeof snapshot.raw === 'object' ? snapshot.raw as Record<string, unknown> : {}),
        localCashExitLossFallback: local
      }
    };
  }

  private withLiveSessionEquityBaseline(
    venue: VenueName,
    snapshot: AccountRiskSnapshot,
    dayStart: number
  ): AccountRiskSnapshot {
    const checkpointName = `live-session.${venue}`;
    const checkpoint = this.store.getCheckpoint(checkpointName)?.value;
    if (!checkpoint || typeof checkpoint !== 'object') return snapshot;
    const value = checkpoint as Record<string, unknown>;
    const startedAt = typeof value.startedAt === 'string' ? Date.parse(value.startedAt) : NaN;
    if (!Number.isFinite(startedAt) || Math.abs(startedAt - dayStart) > 1000) return snapshot;
    const storedEquity = Number(value.equityUsd);
    // A non-positive stored baseline is POISONED: the equity read failed at session start and persisted 0. Trusting it
    // pegs dayStartEquityUsd at 0 and breaks the drawdown/PnL math (and blinds the stop). Treat it as "not captured" so
    // the block below re-captures a real baseline from the current/historical snapshot and rewrites the checkpoint.
    if (Number.isFinite(storedEquity) && storedEquity > 0) {
      return { ...snapshot, dayStartEquityUsd: storedEquity };
    }
    const historical = this.store.getEarliestAccountEquitySince(venue, dayStart);
    const historicalDelayMs = historical ? historical.capturedAt - dayStart : Number.POSITIVE_INFINITY;
    const currentDelayMs = snapshot.capturedAt - dayStart;
    const baseline = historical && historicalDelayMs >= 0 && historicalDelayMs <= LIVE_SESSION_BASELINE_MAX_DELAY_MS
      ? {
          equityUsd: historical.equityUsd,
          capturedAt: historical.capturedAt,
          source: 'historical-account-snapshot'
        }
      : Number.isFinite(snapshot.equityUsd) && currentDelayMs >= 0 && currentDelayMs <= LIVE_SESSION_BASELINE_MAX_DELAY_MS
        ? {
            equityUsd: Number(snapshot.equityUsd),
            capturedAt: snapshot.capturedAt,
            source: 'current-account-snapshot'
          }
        : undefined;
    if (!baseline) return snapshot;
    this.store.checkpoint(checkpointName, {
      ...value,
      equityUsd: baseline.equityUsd,
      equityCapturedAt: new Date(baseline.capturedAt).toISOString(),
      equitySource: baseline.source
    });
    return {
      ...snapshot,
      dayStartEquityUsd: baseline.equityUsd,
      warnings: [
        ...snapshot.warnings,
        baseline.source === 'historical-account-snapshot'
          ? 'Live-session equity baseline restored from the earliest verified account snapshot.'
          : 'Live-session equity baseline captured from the first account snapshot.'
      ]
    };
  }

  async syncPositions(input: Pick<AccountSyncInput, 'venue' | 'signerAddress'>): Promise<PositionSyncResult> {
    try {
      return {
        ok: true,
        positions: await this.adapter.getPositions(input.signerAddress)
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.recordEvent({
        venue: input.venue,
        severity: 'error',
        type: 'positions.unavailable',
        message: '持仓同步失败，本轮不会新增订单',
        details: { error: message, reject: rejectReason('POSITIONS_UNAVAILABLE', 'platform', 'syncing-positions') }
      });
      this.store.checkpoint(`run.${input.venue}`, { mode: 'live', skippedQuoting: true, reason: 'positions.unavailable' });
      return { ok: false, positions: [] };
    }
  }

  async syncBalances(input: AccountSyncInput): Promise<Balance[]> {
    try {
      const balances = await this.adapter.getBalances(input.signerAddress, input.signer);
      if (balances.length === 0) {
        this.store.recordEvent({
          venue: input.venue,
          severity: 'warn',
          type: 'balance.empty',
          message: '余额为空或不可确认，本轮不会新增订单',
          details: { address: input.signerAddress, reject: rejectReason('BALANCE_EMPTY', 'balance', 'syncing-balances') }
        });
      }
      return balances;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.recordEvent({
        venue: input.venue,
        severity: 'error',
        type: 'balance.unavailable',
        message,
        details: { address: input.signerAddress, reject: rejectReason('BALANCE_UNAVAILABLE', 'balance', 'syncing-balances') }
      });
      return [];
    }
  }
}
