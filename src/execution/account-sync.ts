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
  /** True when positions come from the in-memory cache because the live fetch failed. Caller must treat
   *  these as "best-known recent" (no fresh ack of fills/transfers) and skip any flow that could place a
   *  new order based on assumed capital — but retreat / cancel / fill-circuit-breaker can still run. */
  cached?: boolean;
  /** Age (ms) of the cached positions when `cached === true`. Undefined on a fresh fetch. */
  cachedAgeMs?: number;
}

export class AccountSyncService {
  // Per-venue in-memory cache of the latest SUCCESSFUL position fetch. Survives across cycles within one
  // process lifetime so a transient venue/data-api outage (e.g. Polymarket data-api stall through a proxy
  // node) can still hand back the most recent known positions to the engine — which then runs in
  // PROTECT-ONLY mode: cancel/retreat existing orders but place no new ones. Without this fallback the
  // engine exited the cycle entirely and resting orders went unsupervised until they got filled.
  private readonly lastKnownPositions = new Map<VenueName, { positions: Position[]; capturedAt: number }>();
  // After this many ms a cached snapshot is treated as too stale to even drive protect-only logic. Long
  // enough to survive multi-minute proxy outages, short enough that an hours-long outage doesn't quietly
  // run on day-old position data. Tuned to match the operator's intuition that a multi-hour stall is a
  // problem the operator must notice.
  private static readonly POSITIONS_CACHE_TTL_MS = 30 * 60_000;

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
      const positions = await this.adapter.getPositions(input.signerAddress);
      this.lastKnownPositions.set(input.venue, { positions, capturedAt: Date.now() });
      // Persist to database so restarts recover position knowledge immediately
      if (positions.length > 0) {
        this.store.checkpoint(`positions-cache.${input.venue}`, {
          positions: positions.map((p) => ({
            tokenId: p.tokenId, size: p.size, notionalUsd: p.notionalUsd,
            averagePrice: p.averagePrice, marketId: p.marketId, outcome: p.outcome
          })),
          capturedAt: new Date().toISOString()
        });
      }
      return { ok: true, positions };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Layer 1: in-memory cache (survives within one process lifetime)
      let cached = this.lastKnownPositions.get(input.venue);
      let ageMs = cached ? Date.now() - cached.capturedAt : undefined;
      let cacheUsable = !!cached && ageMs !== undefined && ageMs <= AccountSyncService.POSITIONS_CACHE_TTL_MS;
      // Layer 2: database-persisted cache (survives restarts)
      if (!cacheUsable) {
        const dbCache = this.store.getCheckpoint(`positions-cache.${input.venue}`)?.value as
          { positions?: Array<{ tokenId: string; size: number; notionalUsd: number; averagePrice?: number; marketId?: string; outcome?: string }>; capturedAt?: string } | undefined;
        if (dbCache?.positions?.length && dbCache.capturedAt) {
          const dbAgeMs = Date.now() - new Date(dbCache.capturedAt).getTime();
          if (Number.isFinite(dbAgeMs) && dbAgeMs <= AccountSyncService.POSITIONS_CACHE_TTL_MS) {
            cached = { positions: dbCache.positions as Position[], capturedAt: Date.now() - dbAgeMs };
            ageMs = dbAgeMs;
            cacheUsable = true;
          }
        }
      }
      if (cacheUsable && cached) {
        // PROTECT-ONLY fallback: hand back the cached positions and tag them stale. The engine routes this
        // into the cancel/retreat path on existing orders but skips placing new ones, so a transient venue
        // outage cannot leave resting orders unsupervised until they get filled.
        this.store.recordEvent({
          venue: input.venue,
          severity: 'warn',
          type: 'positions.cached-fallback',
          message: `持仓接口失败，本轮使用 ${Math.round((ageMs ?? 0) / 1000)}s 前的持仓缓存，仅维护现有挂单(不新增)`,
          details: { error: message, cachedAgeMs: ageMs, positionCount: cached.positions.length, reject: rejectReason('POSITIONS_UNAVAILABLE', 'platform', 'syncing-positions') }
        });
        return { ok: true, positions: cached.positions, cached: true, cachedAgeMs: ageMs };
      }
      this.store.recordEvent({
        venue: input.venue,
        severity: 'error',
        type: 'positions.unavailable',
        message: cached
          ? `持仓同步失败,且缓存已过期(${Math.round((ageMs ?? 0) / 1000)}s)，本轮不会新增订单也不维护现有挂单`
          : '持仓同步失败，本轮不会新增订单',
        details: { error: message, cachedAgeMs: ageMs, reject: rejectReason('POSITIONS_UNAVAILABLE', 'platform', 'syncing-positions') }
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
