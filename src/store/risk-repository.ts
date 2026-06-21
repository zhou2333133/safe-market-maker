import type Database from 'better-sqlite3';
import type { AccountRiskDecision, AccountRiskSnapshot, VenueName } from '../domain/types.js';
import { redact } from '../observability/redact.js';
import type { ObservabilityRepository } from './observability-repository.js';

export interface FillSummary {
  count: number;
  buyCount: number;
  sellCount: number;
  notionalUsd: number;
  netCashflowUsd: number;
  latest?: {
    id: string;
    tokenId?: string;
    marketId?: string;
    side?: string;
    price?: number;
    size?: number;
    notionalUsd: number;
    cashflowUsd?: number;
    ts: string;
  };
}

export interface AccountEquityPoint {
  capturedAt: number;
  equityUsd: number;
}

export class RiskRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly observability: Pick<ObservabilityRepository, 'checkpoint'>
  ) {}

  recordAccountRiskSnapshot(snapshot: AccountRiskSnapshot): void {
    const insertFill = this.db.prepare(`
      INSERT INTO account_fills (
        venue, fill_id, order_id, token_id, market_id, side, price, size,
        notional_usd, fee_usd, realized_pnl_usd, cashflow_usd, fill_ts, raw_json
      )
      VALUES (
        @venue, @fill_id, @order_id, @token_id, @market_id, @side, @price, @size,
        @notional_usd, @fee_usd, @realized_pnl_usd, @cashflow_usd, @fill_ts, @raw_json
      )
      ON CONFLICT(venue, fill_id) DO UPDATE SET
        order_id=@order_id,
        token_id=@token_id,
        market_id=@market_id,
        side=@side,
        price=@price,
        size=@size,
        notional_usd=@notional_usd,
        fee_usd=@fee_usd,
        realized_pnl_usd=@realized_pnl_usd,
        cashflow_usd=@cashflow_usd,
        fill_ts=@fill_ts,
        raw_json=@raw_json
    `);
    const insertSnapshot = this.db.prepare(`
      INSERT INTO account_risk_snapshots (
        ts, venue, account, source, day_start, equity_usd, day_start_equity_usd,
        realized_pnl_usd, unrealized_pnl_usd, net_cashflow_usd, fees_usd,
        warnings_json, raw_json
      )
      VALUES (
        @ts, @venue, @account, @source, @day_start, @equity_usd, @day_start_equity_usd,
        @realized_pnl_usd, @unrealized_pnl_usd, @net_cashflow_usd, @fees_usd,
        @warnings_json, @raw_json
      )
    `);
    this.db.transaction((input: AccountRiskSnapshot) => {
      for (const fill of input.fills) {
        insertFill.run({
          venue: fill.venue,
          fill_id: fill.id,
          order_id: fill.orderId ?? null,
          token_id: fill.tokenId ?? null,
          market_id: fill.marketId ?? null,
          side: fill.side ?? null,
          price: finiteOrNull(fill.price),
          size: finiteOrNull(fill.size),
          notional_usd: finiteOrZero(fill.notionalUsd),
          fee_usd: finiteOrNull(fill.feeUsd),
          realized_pnl_usd: finiteOrNull(fill.realizedPnlUsd),
          cashflow_usd: finiteOrNull(fill.cashflowUsd),
          fill_ts: fill.ts,
          raw_json: JSON.stringify(redact(fill.raw ?? fill))
        });
      }
      insertSnapshot.run({
        ts: input.capturedAt,
        venue: input.venue,
        account: input.account,
        source: input.source,
        day_start: input.dayStart,
        equity_usd: finiteOrNull(input.equityUsd),
        day_start_equity_usd: finiteOrNull(input.dayStartEquityUsd),
        realized_pnl_usd: finiteOrNull(input.realizedPnlUsd),
        unrealized_pnl_usd: finiteOrNull(input.unrealizedPnlUsd),
        net_cashflow_usd: finiteOrNull(input.netCashflowUsd),
        fees_usd: finiteOrNull(input.feesUsd),
        warnings_json: JSON.stringify(redact(input.warnings)),
        raw_json: JSON.stringify(redact({
          ...input,
          fills: input.fills.map((fill) => ({ ...fill, raw: undefined })),
          raw: input.raw
        }))
      });
    })(snapshot);
  }

  recordAccountRiskDecision(decision: AccountRiskDecision): void {
    this.db.prepare(`
      INSERT INTO account_risk_decisions (ts, venue, ok, reason, message, details_json)
      VALUES (@ts, @venue, @ok, @reason, @message, @details_json)
    `).run({
      ts: Date.now(),
      venue: decision.venue,
      ok: decision.ok ? 1 : 0,
      reason: decision.reason,
      message: decision.message,
      details_json: JSON.stringify(redact(decision))
    });
    this.observability.checkpoint(`risk.${decision.venue}`, decision);
  }

  getLatestAccountRiskDecision(venue: VenueName): (AccountRiskDecision & { ts: string }) | undefined {
    const row = this.db.prepare(`
      SELECT ts, details_json
      FROM account_risk_decisions
      WHERE venue = ?
      ORDER BY ts DESC
      LIMIT 1
    `).get(venue) as { ts: number; details_json: string } | undefined;
    if (!row) return undefined;
    const details = JSON.parse(row.details_json || '{}') as AccountRiskDecision;
    return { ...details, ts: new Date(row.ts).toISOString() };
  }

  getLatestAccountRiskSnapshot(venue: VenueName): (Omit<AccountRiskSnapshot, 'fills' | 'positions' | 'balances'> & { ts: string }) | undefined {
    const row = this.db.prepare(`
      SELECT ts, venue, account, source, day_start, equity_usd, day_start_equity_usd,
        realized_pnl_usd, unrealized_pnl_usd, net_cashflow_usd, fees_usd, warnings_json, raw_json
      FROM account_risk_snapshots
      WHERE venue = ?
      ORDER BY ts DESC
      LIMIT 1
    `).get(venue) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const raw = JSON.parse(String(row.raw_json || '{}')) as Partial<AccountRiskSnapshot>;
    return {
      venue: row.venue as VenueName,
      account: String(row.account),
      source: row.source as AccountRiskSnapshot['source'],
      capturedAt: Number(row.ts),
      dayStart: Number(row.day_start),
      ...(row.equity_usd !== null ? { equityUsd: Number(row.equity_usd) } : {}),
      ...(row.day_start_equity_usd !== null ? { dayStartEquityUsd: Number(row.day_start_equity_usd) } : {}),
      ...(row.realized_pnl_usd !== null ? { realizedPnlUsd: Number(row.realized_pnl_usd) } : {}),
      ...(row.unrealized_pnl_usd !== null ? { unrealizedPnlUsd: Number(row.unrealized_pnl_usd) } : {}),
      ...(row.net_cashflow_usd !== null ? { netCashflowUsd: Number(row.net_cashflow_usd) } : {}),
      ...(row.fees_usd !== null ? { feesUsd: Number(row.fees_usd) } : {}),
      warnings: JSON.parse(String(row.warnings_json || '[]')) as string[],
      raw,
      ts: new Date(Number(row.ts)).toISOString()
    };
  }

  getEarliestAccountEquitySince(venue: VenueName, sinceTs: number): AccountEquityPoint | undefined {
    const row = this.db.prepare(`
      SELECT ts, equity_usd
      FROM account_risk_snapshots
      WHERE venue = ?
        AND ts >= ?
        AND equity_usd IS NOT NULL
      ORDER BY ts ASC
      LIMIT 1
    `).get(venue, sinceTs) as { ts: number; equity_usd: number } | undefined;
    if (!row || !Number.isFinite(row.equity_usd)) return undefined;
    return {
      capturedAt: Number(row.ts),
      equityUsd: Number(row.equity_usd)
    };
  }

  summarizeFills(venue: VenueName, sinceTs: number): FillSummary {
    const row = this.db.prepare(`
      SELECT
        COUNT(*) AS count,
        SUM(CASE WHEN side = 'BUY' THEN 1 ELSE 0 END) AS buy_count,
        SUM(CASE WHEN side = 'SELL' THEN 1 ELSE 0 END) AS sell_count,
        SUM(ABS(notional_usd)) AS notional_usd,
        SUM(COALESCE(cashflow_usd, 0)) AS net_cashflow_usd
      FROM account_fills
      WHERE venue = ?
        AND fill_ts >= ?
    `).get(venue, sinceTs) as Record<string, unknown>;
    const latest = this.db.prepare(`
      SELECT fill_id, token_id, market_id, side, price, size, notional_usd, cashflow_usd, fill_ts
      FROM account_fills
      WHERE venue = ?
        AND fill_ts >= ?
      ORDER BY fill_ts DESC
      LIMIT 1
    `).get(venue, sinceTs) as Record<string, unknown> | undefined;
    const summary: FillSummary = {
      count: Number(row.count ?? 0),
      buyCount: Number(row.buy_count ?? 0),
      sellCount: Number(row.sell_count ?? 0),
      notionalUsd: round(Number(row.notional_usd ?? 0)),
      netCashflowUsd: round(Number(row.net_cashflow_usd ?? 0))
    };
    if (latest) {
      summary.latest = {
        id: String(latest.fill_id),
        ...(latest.token_id ? { tokenId: String(latest.token_id) } : {}),
        ...(latest.market_id ? { marketId: String(latest.market_id) } : {}),
        ...(latest.side ? { side: String(latest.side) } : {}),
        ...(latest.price !== null ? { price: Number(latest.price) } : {}),
        ...(latest.size !== null ? { size: Number(latest.size) } : {}),
        notionalUsd: round(Number(latest.notional_usd ?? 0)),
        ...(latest.cashflow_usd !== null ? { cashflowUsd: round(Number(latest.cashflow_usd)) } : {}),
        ts: new Date(Number(latest.fill_ts)).toISOString()
      };
    }
    return summary;
  }

}

function finiteOrNull(value: number | undefined): number | null {
  return Number.isFinite(value) ? Number(value) : null;
}

function finiteOrZero(value: number | undefined): number {
  return Number.isFinite(value) ? Number(value) : 0;
}

function round(value: number): number {
  return Number((Number.isFinite(value) ? value : 0).toFixed(4));
}
