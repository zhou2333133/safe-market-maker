import type Database from 'better-sqlite3';
import type { VenueName } from '../domain/types.js';
import { redact, redactString } from '../observability/redact.js';

export interface StoreStatus {
  openOrders: number;
  events: number;
  lastCheckpoint?: {
    name: string;
    ts: string;
  };
}

export interface RecentEvent {
  id: number;
  ts: string;
  venue?: string;
  severity: string;
  type: string;
  message: string;
  details: unknown;
}

export interface LocalCashExitLossSummary {
  count: number;
  estimatedLossUsd: number;
  estimatedRealizedPnlUsd: number;
  latest?: {
    ts: string;
    tokenId?: string;
    marketId?: string;
    outcome?: string;
    averagePrice?: number;
    exitPrice?: number;
    size?: number;
    estimatedLossUsd: number;
  };
}

export interface CashFillCooldownEntry {
  ts: string;
  tokenId: string;
  marketId?: string;
  outcome?: string;
  source: 'fill-circuit-breaker.triggered' | 'cash-fill.exit-submitted';
}

export class ObservabilityRepository {
  constructor(private readonly db: Database.Database) {}

  recordEvent(input: {
    venue?: VenueName;
    severity?: 'info' | 'warn' | 'error';
    type: string;
    message: string;
    details?: unknown;
  }): void {
    this.db.prepare(`
      INSERT INTO events (ts, venue, severity, type, message, details_json)
      VALUES (@ts, @venue, @severity, @type, @message, @details_json)
    `).run({
      ts: Date.now(),
      venue: input.venue ?? null,
      severity: input.severity ?? 'info',
      type: input.type,
      message: redactString(input.message),
      details_json: JSON.stringify(redact(input.details ?? {}))
    });
  }

  listRecentEvents(limit = 20): RecentEvent[] {
    const rows = this.db.prepare(`
      SELECT id, ts, venue, severity, type, message, details_json
      FROM events
      ORDER BY ts DESC
      LIMIT ?
    `).all(limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: Number(row.id),
      ts: new Date(Number(row.ts)).toISOString(),
      ...(row.venue ? { venue: String(row.venue) } : {}),
      severity: String(row.severity),
      type: String(row.type),
      message: String(row.message),
      details: JSON.parse(String(row.details_json || '{}'))
    }));
  }

  localCashExitLossSince(venue: VenueName, sinceTs: number): LocalCashExitLossSummary {
    const rows = this.db.prepare(`
      SELECT ts, details_json
      FROM events
      WHERE venue = ?
        AND ts >= ?
        AND type = 'cash-fill.exit-submitted'
      ORDER BY ts ASC
    `).all(venue, sinceTs) as Array<{ ts: number; details_json: string }>;
    let estimatedLossUsd = 0;
    let latest: LocalCashExitLossSummary['latest'];
    for (const row of rows) {
      const details = parseDetails(row.details_json);
      const estimate = estimateCashExitLoss(details);
      if (!estimate || estimate.estimatedLossUsd <= 0) continue;
      estimatedLossUsd += estimate.estimatedLossUsd;
      latest = {
        ts: new Date(row.ts).toISOString(),
        ...estimate
      };
    }
    const roundedLoss = round(estimatedLossUsd);
    return {
      count: rows.length,
      estimatedLossUsd: roundedLoss,
      estimatedRealizedPnlUsd: round(-roundedLoss),
      ...(latest ? { latest } : {})
    };
  }

  cashFillCooldownEntries(venue: VenueName, sinceTs: number): CashFillCooldownEntry[] {
    const rows = this.db.prepare(`
      SELECT ts, type, details_json
      FROM events
      WHERE venue = ?
        AND ts >= ?
        AND type IN ('fill-circuit-breaker.triggered', 'cash-fill.exit-submitted')
      ORDER BY ts DESC
      LIMIT 200
    `).all(venue, sinceTs) as Array<{ ts: number; type: CashFillCooldownEntry['source']; details_json: string }>;
    return rows.flatMap((row) => {
      const details = parseDetails(row.details_json);
      return cashFillCooldownEntriesFromDetails(row.type, row.ts, details);
    });
  }

  recordMetric(name: string, value: number, labels: Record<string, unknown> = {}): void {
    this.db.prepare(`
      INSERT INTO metrics (ts, name, value, labels_json)
      VALUES (@ts, @name, @value, @labels_json)
    `).run({
      ts: Date.now(),
      name,
      value,
      labels_json: JSON.stringify(redact(labels))
    });
  }

  checkpoint(name: string, value: unknown): void {
    this.db.prepare(`
      INSERT INTO checkpoints (name, ts, value_json)
      VALUES (@name, @ts, @value_json)
      ON CONFLICT(name) DO UPDATE SET ts=@ts, value_json=@value_json
    `).run({
      name,
      ts: Date.now(),
      value_json: JSON.stringify(redact(value))
    });
  }

  getCheckpoint(name: string): { name: string; ts: string; value: unknown } | undefined {
    const row = this.db.prepare(`
      SELECT name, ts, value_json
      FROM checkpoints
      WHERE name = ?
    `).get(name) as { name: string; ts: number; value_json: string } | undefined;
    if (!row) return undefined;
    return {
      name: row.name,
      ts: new Date(row.ts).toISOString(),
      value: JSON.parse(row.value_json || '{}')
    };
  }

  status(openOrders: number): StoreStatus {
    const latestEvent = this.db.prepare(`SELECT id FROM events ORDER BY ts DESC LIMIT 1`).get() as { id: number } | undefined;
    const events = latestEvent ? Number(latestEvent.id) : 0;
    const checkpoint = this.db.prepare(`SELECT name, ts FROM checkpoints INDEXED BY idx_checkpoints_ts_desc ORDER BY ts DESC LIMIT 1`).get() as { name: string; ts: number } | undefined;
    const result: StoreStatus = { openOrders, events };
    if (checkpoint) {
      result.lastCheckpoint = {
        name: checkpoint.name,
        ts: new Date(checkpoint.ts).toISOString()
      };
    }
    return result;
  }
}

function parseDetails(raw: string): unknown {
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return {};
  }
}

function estimateCashExitLoss(details: unknown): Omit<NonNullable<LocalCashExitLossSummary['latest']>, 'ts'> | undefined {
  if (!details || typeof details !== 'object') return undefined;
  const root = details as Record<string, unknown>;
  const position = root.position && typeof root.position === 'object' ? root.position as Record<string, unknown> : undefined;
  const intent = root.intent && typeof root.intent === 'object' ? root.intent as Record<string, unknown> : undefined;
  if (!position || !intent) return undefined;
  const size = finiteNumber(intent.size) ?? finiteNumber(position.size);
  const averagePrice = finiteNumber(root.averagePrice) ?? finiteNumber(position.averagePrice);
  const exitPrice = finiteNumber(root.limitPrice) ?? finiteNumber(intent.price);
  const positionNotional = finiteNumber(position.notionalUsd);
  const exitNotional = finiteNumber(intent.notionalUsd);
  const notionalLoss = positionNotional !== undefined && exitNotional !== undefined
    ? positionNotional - exitNotional
    : undefined;
  const priceLoss = size !== undefined && averagePrice !== undefined && exitPrice !== undefined
    ? (averagePrice - exitPrice) * size
    : undefined;
  const estimatedLossUsd = Math.max(0, notionalLoss ?? priceLoss ?? 0);
  if (!Number.isFinite(estimatedLossUsd) || estimatedLossUsd <= 0) return undefined;
  return {
    estimatedLossUsd: round(estimatedLossUsd),
    ...(position.tokenId ? { tokenId: String(position.tokenId) } : {}),
    ...(position.marketId ? { marketId: String(position.marketId) } : {}),
    ...(position.outcome ? { outcome: String(position.outcome) } : {}),
    ...(averagePrice !== undefined ? { averagePrice } : {}),
    ...(exitPrice !== undefined ? { exitPrice } : {}),
    ...(size !== undefined ? { size } : {})
  };
}

function cashFillCooldownEntriesFromDetails(
  source: CashFillCooldownEntry['source'],
  ts: number,
  details: unknown
): CashFillCooldownEntry[] {
  if (!details || typeof details !== 'object') return [];
  const root = details as Record<string, unknown>;
  const rawPositions = source === 'cash-fill.exit-submitted'
    ? [root.position]
    : Array.isArray(root.positions)
      ? root.positions
      : [];
  return rawPositions.flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return [];
    const position = raw as Record<string, unknown>;
    if (typeof position.tokenId !== 'string' || position.tokenId.length === 0) return [];
    return [{
      ts: new Date(ts).toISOString(),
      tokenId: position.tokenId,
      ...(typeof position.marketId === 'string' && position.marketId.length > 0 ? { marketId: position.marketId } : {}),
      ...(typeof position.outcome === 'string' && position.outcome.length > 0 ? { outcome: position.outcome } : {}),
      source
    }];
  });
}

function finiteNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function round(value: number): number {
  return Number((Number.isFinite(value) ? value : 0).toFixed(4));
}
