import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { AccountRiskDecision, AccountRiskSnapshot, ExecutionMode, OpenOrder, OrderIntent, OrderResult, VenueName } from '../domain/types.js';
import { ObservabilityRepository, type CashFillCooldownEntry, type LocalCashExitLossSummary, type RecentEvent, type StoreStatus } from './observability-repository.js';
import { OrderLedgerRepository, type RecentOrder } from './order-ledger-repository.js';
import { RiskRepository, type AccountEquityPoint, type FillSummary } from './risk-repository.js';
import { stateStoreSchemaSql } from './schema.js';
import { configureForensicLog, forensicLogEvent, pruneOldForensicFiles } from '../observability/forensic-log.js';

// Retention windows: events/metrics/orders(non-open)/account_risk_* in SQLite kept for 24h (SQLITE_RETENTION_MS; hot tier, queried by UI + audit), forensic JSONL on disk
// kept for 1d (cold archive, post-hoc complete record). Operator reviews every fill on demand, so a detailed trail
// beyond 1 day is not needed and would only grow disk. Production observed ~1.5GB/day forensic growth (POLY's
// order.ws-update fires ~2.3k/min and dominates), so 1d ≈ 1.5GB on disk — comfortable. Original 30d was sized
// against a 60MB/day estimate that's ~25x off; 3d was an intermediate; 1d is the operator-chosen window. Both
// auto-pruned at store-open so a long-running bot self-maintains.
const SQLITE_RETENTION_MS = 24 * 60 * 60 * 1000;
const FORENSIC_RETENTION_MS = 1 * 24 * 60 * 60 * 1000;

let retentionTimer: ReturnType<typeof setInterval> | undefined;
/**
 * Self-maintaining retention: opens its own short-lived StateStore every 6h to purge expired rows, so a bot that
 * runs for weeks without restarting does not accumulate unbounded events/metrics/orders/risk history. Singleton —
 * safe to call from multiple startup paths; only the first call arms the timer.
 */
export function startRetentionTimer(dataDir: string): void {
  if (retentionTimer) return;
  const dbPath = path.join(dataDir, 'state.sqlite');
  retentionTimer = setInterval(() => {
    try {
      const s = new StateStore(dbPath);
      try { s.pruneRetention(path.dirname(dbPath)); } finally { s.close(); }
    } catch { /* retention must never crash the process */ }
  }, 6 * 60 * 60 * 1000);
  retentionTimer.unref?.();
}

export class StateStore {
  private readonly db: Database.Database;
  private readonly observability: ObservabilityRepository;
  private readonly orders: OrderLedgerRepository;
  private readonly risks: RiskRepository;
  private consecutiveWriteErrors = 0;
  private lastWriteErrorAt = 0;

  constructor(dbPath: string) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    configureForensicLog(path.dirname(dbPath));
    this.db = new Database(dbPath);
    this.observability = new ObservabilityRepository(this.db);
    this.orders = new OrderLedgerRepository(this.db);
    this.risks = new RiskRepository(this.db, this.observability);
    this.db.pragma('journal_mode = WAL');
    // Avoid SQLITE_BUSY when the 6h retention timer opens a second handle on the same WAL file: wait (and
    // retry internally) up to 5s instead of throwing, so concurrent pruneRetention runs don't silently fail.
    this.db.pragma('busy_timeout = 5000');
    this.migrate();
    this.pruneRetention(path.dirname(dbPath));
  }

  /**
   * Best-effort retention: drop events/metrics/orders(non-open)/account_risk_* rows older than 24h (SQLITE_RETENTION_MS)
   * from SQLite and any forensic JSONL files older than 3d. Also invoked periodically via startRetentionTimer so a
   * long-running bot self-maintains without depending on restarts. Wrapped in try/catch — retention must never block startup.
   */
  /** Public so startRetentionTimer can invoke it on a cadence; see class JSDoc for what it purges. */
  pruneRetention(dataDir: string): void {
    try {
      const cutoff = Date.now() - SQLITE_RETENTION_MS;
      const evDel = this.db.prepare('DELETE FROM events WHERE ts < ?').run(cutoff).changes;
      const meDel = this.db.prepare('DELETE FROM metrics WHERE ts < ?').run(cutoff).changes;
      // Orders still OPEN represent live managed positions — never delete those. Only purge terminal states
      // (CANCELED / UNKNOWN / REJECTED) once aged out, otherwise reconciliation loses fill history.
      const ordDel = this.db
        .prepare("DELETE FROM orders WHERE status IN ('CANCELED','UNKNOWN','REJECTED') AND updated_at < ?")
        .run(cutoff).changes;
      const snapDel = this.db.prepare('DELETE FROM account_risk_snapshots WHERE ts < ?').run(cutoff).changes;
      const decDel = this.db.prepare('DELETE FROM account_risk_decisions WHERE ts < ?').run(cutoff).changes;
      if (evDel + meDel + ordDel + snapDel + decDel > 100000) {
        // Reclaim disk after large purge so the file actually shrinks.
        this.db.exec('VACUUM');
      }
    } catch { /* retention failures must never block startup */ }
    try { pruneOldForensicFiles(dataDir, FORENSIC_RETENTION_MS); } catch { /* same */ }
  }

  close(): void {
    this.db.close();
  }

  migrate(): void {
    this.db.exec(stateStoreSchemaSql);
    this.applyAdHocMigrations();
  }

  /**
   * Idempotent column-add migrations. SQLite's CREATE TABLE IF NOT EXISTS in schema.sql only fires on FRESH
   * databases; established installations (the user's 728MB live DB) need ALTER TABLE for new columns. Each
   * migration checks the actual column list before issuing ALTER so re-running the bot is safe.
   *
   * The pattern is intentionally simple — no schema_version table yet (deferred to the broader ARCH-001 work).
   * Each migration block is a sentence in the schema's life history: state what column we want, check if it's
   * there, add if not. The cost of `PRAGMA table_info` is negligible (microseconds on a single table).
   */
  private applyAdHocMigrations(): void {
    const ordersCols = new Set(
      (this.db.prepare(`PRAGMA table_info(orders)`).all() as Array<{ name: string }>).map((r) => r.name)
    );
    if (!ordersCols.has('size_matched')) {
      // Polymarket order updates / WS trades fill this in; existing rows default to 0 which matches the
      // legacy assumption ("we never see partial fills, so they're either OPEN or CANCELED").
      this.db.exec(`ALTER TABLE orders ADD COLUMN size_matched REAL NOT NULL DEFAULT 0`);
    }
  }

  private bumpWriteError(): void {
    this.consecutiveWriteErrors += 1;
    this.lastWriteErrorAt = Date.now();
  }

  recordEvent(input: {
    venue?: VenueName;
    severity?: 'info' | 'warn' | 'error';
    type: string;
    message: string;
    details?: unknown;
  }): void {
    try {
      this.observability.recordEvent(input);
    } catch (err) {
      this.bumpWriteError();
      // Forensic log (JSONL file) is the belt-and-suspenders fallback — it never depends on SQLite.
    }
    forensicLogEvent(input);
  }

  /** Returns true when the DB write path has been failing recently — the engine uses this to enter
   *  protect-only mode so no fresh orders are placed on stale data while the DB is down. */
  dbWriteDegraded(): boolean {
    // Recover after a sustained quiet window: a write that succeeded long ago no longer implies the DB is sick.
    if (this.consecutiveWriteErrors > 0 && Date.now() - this.lastWriteErrorAt >= 120_000) {
      this.consecutiveWriteErrors = 0;
    }
    return this.consecutiveWriteErrors >= 5 && Date.now() - this.lastWriteErrorAt < 120_000;
  }

  /** Most recent timestamp (epoch ms) for an event of the given (venue, type), or undefined when none. Used by the
   * in-process stale-loop watchdog and the scheduled 2h health-check to detect wedged loops without scanning rows. */
  recentEventTs(venue: VenueName | undefined, type: string): number | undefined {
    const row = venue
      ? this.db.prepare('SELECT ts FROM events WHERE venue=? AND type=? ORDER BY ts DESC LIMIT 1').get(venue, type) as { ts?: number } | undefined
      : this.db.prepare('SELECT ts FROM events WHERE type=? ORDER BY ts DESC LIMIT 1').get(type) as { ts?: number } | undefined;
    return row && Number.isFinite(row.ts) ? Number(row.ts) : undefined;
  }

  recordPlannedOrder(intent: OrderIntent, mode: ExecutionMode): void {
    this.orders.recordPlannedOrder(intent, mode);
  }

  /** Apply a partial-or-full fill from a real-time source. Idempotent on `size_matched`. */
  applyFillSizeUpdate(venue: VenueName, externalId: string, filledSize: number, opts: { fillTs?: number } = {}): boolean {
    return this.orders.applyFillSizeUpdate(venue, externalId, filledSize, opts);
  }

  recordOrderResult(result: OrderResult): void {
    try {
      this.orders.recordOrderResult(result);
    } catch (err) {
      this.bumpWriteError();
      throw err;
    }
  }

  markPlannedOrderRejected(clientOrderId: string, reason: string, details: unknown = {}): void {
    this.orders.markPlannedOrderRejected(clientOrderId, reason, details);
  }

  markPlannedOrderUnknown(clientOrderId: string, reason: string, details: unknown = {}): void {
    this.orders.markPlannedOrderUnknown(clientOrderId, reason, details);
  }

  ingestOpenOrders(orders: OpenOrder[], mode: ExecutionMode): void {
    try {
      this.orders.ingestOpenOrders(orders, mode);
    } catch (err) {
      this.bumpWriteError();
      throw err;
    }
  }

  reconcileOpenOrders(
    venue: VenueName,
    remoteOrders: OpenOrder[],
    mode: ExecutionMode,
    options: { freshOpenGraceMs?: number } = {}
  ): void {
    try {
      this.orders.reconcileOpenOrders(venue, remoteOrders, mode, options);
    } catch (err) {
      this.bumpWriteError();
      throw err;
    }
  }

  markOrdersCanceled(venue: VenueName, orderIds: string[]): void {
    try {
      this.orders.markOrdersCanceled(venue, orderIds);
    } catch (err) {
      this.bumpWriteError();
      throw err;
    }
  }

  markStalePendingOpenOrdersCanceled(venue: VenueName, olderThanMs?: number): void {
    this.orders.markStalePendingOpenOrdersCanceled(venue, olderThanMs);
  }

  markStalePlannedOrdersUnknown(venue: VenueName, olderThanMs?: number): void {
    this.orders.markStalePlannedOrdersUnknown(venue, olderThanMs);
  }

  listOpenOrders(venue?: VenueName): OpenOrder[] {
    return this.orders.listOpenOrders(venue);
  }

  listManagedOpenOrders(venue: VenueName): OpenOrder[] {
    return this.orders.listManagedOpenOrders(venue);
  }

  /** 统计某代币在最近 windowMs 毫秒内的 guard-skip 次数（路由用，判断市场是否稳定） */
  countRecentGuardSkips(venue: VenueName, tokenId: string, windowMs: number): number {
    const cutoff = Date.now() - windowMs;
    const stmt = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM events WHERE venue = ? AND type = 'orderbook.guard-skip' AND message = ? AND ts > ?`
    );
    const row = stmt.get(venue, tokenId, cutoff) as { cnt: number } | undefined;
    return row ? row.cnt : 0;
  }

  listRecentOrders(limit = 20): RecentOrder[] {
    return this.orders.listRecentOrders(limit);
  }

  listRecentEvents(limit = 20): RecentEvent[] {
    return this.observability.listRecentEvents(limit);
  }

  filledCashflowSince(venue: VenueName, sinceTs: number): number {
    return this.orders.filledCashflowSince(venue, sinceTs);
  }

  localCashExitLossSince(venue: VenueName, sinceTs: number): LocalCashExitLossSummary {
    return this.observability.localCashExitLossSince(venue, sinceTs);
  }

  cashFillCooldownEntries(venue: VenueName, sinceTs: number): CashFillCooldownEntry[] {
    return this.observability.cashFillCooldownEntries(venue, sinceTs);
  }

  summarizeFills(venue: VenueName, sinceTs: number): FillSummary {
    return this.risks.summarizeFills(venue, sinceTs);
  }

  recordAccountRiskSnapshot(snapshot: AccountRiskSnapshot): void {
    try {
      this.risks.recordAccountRiskSnapshot(snapshot);
    } catch (err) {
      this.bumpWriteError();
      throw err;
    }
  }

  /** Insert a fill the venue WS user channel just pushed; idempotent on (venue, fill_id). See
   *  RiskRepository.recordWsFill for the WS-vs-REST dual-source semantics. */
  recordWsFill(row: import('./risk-repository.js').WsFillRow): void {
    try {
      this.risks.recordWsFill(row);
    } catch (err) {
      this.bumpWriteError();
      throw err;
    }
  }

  recordAccountRiskDecision(decision: AccountRiskDecision): void {
    try {
      this.risks.recordAccountRiskDecision(decision);
    } catch (err) {
      this.bumpWriteError();
      throw err;
    }
  }

  getLatestAccountRiskDecision(venue: VenueName): (AccountRiskDecision & { ts: string }) | undefined {
    return this.risks.getLatestAccountRiskDecision(venue);
  }

  getLatestAccountRiskSnapshot(venue: VenueName): (Omit<AccountRiskSnapshot, 'fills' | 'positions' | 'balances'> & { ts: string }) | undefined {
    return this.risks.getLatestAccountRiskSnapshot(venue);
  }

  getEarliestAccountEquitySince(venue: VenueName, sinceTs: number): AccountEquityPoint | undefined {
    return this.risks.getEarliestAccountEquitySince(venue, sinceTs);
  }

  recordMetric(name: string, value: number, labels: Record<string, unknown> = {}): void {
    this.observability.recordMetric(name, value, labels);
  }

  checkpoint(name: string, value: unknown): void {
    this.observability.checkpoint(name, value);
  }

  getCheckpoint(name: string): { name: string; ts: string; value: unknown } | undefined {
    return this.observability.getCheckpoint(name);
  }

  status(): StoreStatus {
    return this.observability.status(this.orders.countOpenOrders());
  }
}
