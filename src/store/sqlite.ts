import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { AccountRiskDecision, AccountRiskSnapshot, ExecutionMode, OpenOrder, OrderIntent, OrderResult, VenueName } from '../domain/types.js';
import { ObservabilityRepository, type CashFillCooldownEntry, type LocalCashExitLossSummary, type RecentEvent, type StoreStatus } from './observability-repository.js';
import { OrderLedgerRepository, type RecentOrder } from './order-ledger-repository.js';
import { RiskRepository, type AccountEquityPoint, type FillSummary } from './risk-repository.js';
import { stateStoreSchemaSql } from './schema.js';
import { configureForensicLog, forensicLogEvent } from '../observability/forensic-log.js';

export class StateStore {
  private readonly db: Database.Database;
  private readonly observability: ObservabilityRepository;
  private readonly orders: OrderLedgerRepository;
  private readonly risks: RiskRepository;

  constructor(dbPath: string) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    configureForensicLog(path.dirname(dbPath));
    this.db = new Database(dbPath);
    this.observability = new ObservabilityRepository(this.db);
    this.orders = new OrderLedgerRepository(this.db);
    this.risks = new RiskRepository(this.db, this.observability);
    this.db.pragma('journal_mode = WAL');
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  migrate(): void {
    this.db.exec(stateStoreSchemaSql);
  }

  recordEvent(input: {
    venue?: VenueName;
    severity?: 'info' | 'warn' | 'error';
    type: string;
    message: string;
    details?: unknown;
  }): void {
    this.observability.recordEvent(input);
    forensicLogEvent(input);
  }

  recordPlannedOrder(intent: OrderIntent, mode: ExecutionMode): void {
    this.orders.recordPlannedOrder(intent, mode);
  }

  recordOrderResult(result: OrderResult): void {
    this.orders.recordOrderResult(result);
  }

  markPlannedOrderRejected(clientOrderId: string, reason: string, details: unknown = {}): void {
    this.orders.markPlannedOrderRejected(clientOrderId, reason, details);
  }

  markPlannedOrderUnknown(clientOrderId: string, reason: string, details: unknown = {}): void {
    this.orders.markPlannedOrderUnknown(clientOrderId, reason, details);
  }

  ingestOpenOrders(orders: OpenOrder[], mode: ExecutionMode): void {
    this.orders.ingestOpenOrders(orders, mode);
  }

  reconcileOpenOrders(
    venue: VenueName,
    remoteOrders: OpenOrder[],
    mode: ExecutionMode,
    options: { freshOpenGraceMs?: number } = {}
  ): void {
    this.orders.reconcileOpenOrders(venue, remoteOrders, mode, options);
  }

  markOrdersCanceled(venue: VenueName, orderIds: string[]): void {
    this.orders.markOrdersCanceled(venue, orderIds);
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
    this.risks.recordAccountRiskSnapshot(snapshot);
  }

  recordAccountRiskDecision(decision: AccountRiskDecision): void {
    this.risks.recordAccountRiskDecision(decision);
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
