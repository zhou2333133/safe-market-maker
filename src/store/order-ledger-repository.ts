import type Database from 'better-sqlite3';
import type { ExecutionMode, OpenOrder, OrderIntent, OrderResult, VenueName } from '../domain/types.js';
import { redact } from '../observability/redact.js';

export interface RecentOrder {
  clientOrderId: string;
  externalId?: string;
  venue: string;
  tokenId: string;
  side: string;
  price: number;
  size: number;
  notionalUsd: number;
  status: string;
  mode: string;
  reason?: string;
  updatedAt: string;
}

export class OrderLedgerRepository {
  constructor(private readonly db: Database.Database) {}

  /**
   * Apply a partial-or-full fill from a real-time source (WS user channel) or a REST poll. Idempotent:
   * - If the order's recorded size_matched is already ≥ filledSize, this is a stale/duplicate event and we
   *   return false without changing anything.
   * - Otherwise we update size_matched to the new value AND, if filledSize meets/exceeds the original size,
   *   transition status to FILLED. Partial fills keep status OPEN/PENDING_OPEN — they're still actively
   *   resting with reduced remaining quantity.
   * Returns true when the row was modified, false otherwise (allows callers to dedupe their own bookkeeping).
   */
  applyFillSizeUpdate(venue: string, externalId: string, filledSize: number, opts: { fillTs?: number } = {}): boolean {
    if (!externalId || !Number.isFinite(filledSize) || filledSize <= 0) return false;
    const row = this.db.prepare(`
      SELECT client_order_id, size, size_matched, status FROM orders WHERE venue=? AND external_id=?
    `).get(venue, externalId) as { client_order_id: string; size: number; size_matched: number; status: string } | undefined;
    if (!row) return false;
    // Defence against out-of-order WS events: never decrease the matched figure.
    if (row.size_matched >= filledSize - 1e-9) return false;
    const becomesFilled = filledSize + 1e-9 >= row.size;
    const newStatus = becomesFilled ? 'FILLED' : row.status === 'PLANNED' ? 'PARTIALLY_FILLED' : row.status;
    const now = opts.fillTs ?? Date.now();
    this.db.prepare(`
      UPDATE orders SET size_matched=?, status=?, updated_at=? WHERE client_order_id=?
    `).run(filledSize, newStatus, now, row.client_order_id);
    return true;
  }

  recordPlannedOrder(intent: OrderIntent, mode: ExecutionMode): void {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO orders (
        client_order_id, venue, market_id, token_id, side, price, size,
        notional_usd, status, mode, reason, created_at, updated_at, raw_json
      )
      VALUES (
        @client_order_id, @venue, @market_id, @token_id, @side, @price, @size,
        @notional_usd, 'PLANNED', @mode, @reason, @created_at, @updated_at, @raw_json
      )
      ON CONFLICT(client_order_id) DO UPDATE SET
        status='PLANNED',
        updated_at=@updated_at,
        raw_json=@raw_json
    `).run({
      client_order_id: intent.clientOrderId,
      venue: intent.venue,
      market_id: intent.market.marketId ?? null,
      token_id: intent.tokenId,
      side: intent.side,
      price: intent.price,
      size: intent.size,
      notional_usd: intent.notionalUsd,
      mode,
      reason: intent.reason,
      created_at: now,
      updated_at: now,
      raw_json: JSON.stringify(redact(intent))
    });
  }

  recordOrderResult(result: OrderResult): void {
    this.db.prepare(`
      UPDATE orders
      SET external_id=@external_id, status=@status, updated_at=@updated_at, raw_json=@raw_json
      WHERE client_order_id=@client_order_id
    `).run({
      external_id: result.externalId ?? null,
      status: result.status,
      updated_at: Date.now(),
      raw_json: JSON.stringify(redact(result)),
      client_order_id: result.clientOrderId
    });
  }

  markPlannedOrderRejected(clientOrderId: string, reason: string, details: unknown = {}): void {
    this.db.prepare(`
      UPDATE orders
      SET status='REJECTED', reason=@reason, updated_at=@updated_at, raw_json=@raw_json
      WHERE client_order_id=@client_order_id
        AND status='PLANNED'
    `).run({
      client_order_id: clientOrderId,
      reason,
      updated_at: Date.now(),
      raw_json: JSON.stringify(redact(details))
    });
  }

  markPlannedOrderUnknown(clientOrderId: string, reason: string, details: unknown = {}): void {
    this.db.prepare(`
      UPDATE orders
      SET status='UNKNOWN', reason=@reason, updated_at=@updated_at, raw_json=@raw_json
      WHERE client_order_id=@client_order_id
        AND status='PLANNED'
    `).run({
      client_order_id: clientOrderId,
      reason,
      updated_at: Date.now(),
      raw_json: JSON.stringify(redact(details))
    });
  }

  ingestOpenOrders(orders: OpenOrder[], mode: ExecutionMode): void {
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO orders (
        client_order_id, external_id, venue, token_id, side, price, size,
        notional_usd, status, mode, created_at, updated_at, raw_json
      )
      VALUES (
        @client_order_id, @external_id, @venue, @token_id, @side, @price, @size,
        @notional_usd, @status, @mode, @created_at, @updated_at, @raw_json
      )
      ON CONFLICT(client_order_id) DO UPDATE SET
        external_id=@external_id,
        token_id=@token_id,
        side=@side,
        price=@price,
        size=@size,
        notional_usd=@notional_usd,
        status=@status,
        updated_at=@updated_at,
        raw_json=@raw_json
    `);
    const insertMany = this.db.transaction((items: OpenOrder[]) => {
      for (const order of items) {
        const existing = this.findExistingOpenOrder(order);
        stmt.run({
          client_order_id: existing?.client_order_id ?? `${order.venue}:${order.externalId}`,
          external_id: order.externalId,
          venue: order.venue,
          token_id: order.tokenId,
          side: order.side,
          price: order.price,
          size: order.size,
          notional_usd: order.price * order.size,
          status: order.status,
          mode,
          created_at: now,
          updated_at: now,
          raw_json: JSON.stringify(redact(order.raw ?? order))
        });
      }
    });
    insertMany(orders);
  }

  private findExistingOpenOrder(order: OpenOrder): { client_order_id: string } | undefined {
    const candidates = [order.externalId, ...alternateOrderIds(order.raw)].filter(Boolean);
    for (const id of [...new Set(candidates)]) {
      const existing = this.db.prepare(`
        SELECT client_order_id
        FROM orders
        WHERE venue = ? AND external_id = ?
        ORDER BY updated_at DESC
        LIMIT 1
      `).get(order.venue, id) as { client_order_id: string } | undefined;
      if (existing) return existing;
    }
    const hash = orderHash(order.raw);
    if (!hash) return undefined;
    return this.db.prepare(`
      SELECT client_order_id
      FROM orders
      WHERE venue = ?
        AND status IN ('OPEN', 'PENDING_OPEN', 'PLANNED')
        AND raw_json LIKE ?
      ORDER BY updated_at DESC
      LIMIT 1
    `).get(order.venue, `%${hash}%`) as { client_order_id: string } | undefined;
  }

  reconcileOpenOrders(
    venue: VenueName,
    remoteOrders: OpenOrder[],
    mode: ExecutionMode,
    options: { freshOpenGraceMs?: number } = {}
  ): void {
    const remoteIds = new Set(remoteOrders.flatMap((order) => [order.externalId, ...alternateOrderIds(order.raw)]).filter(Boolean));
    const now = Date.now();
    const remotePlaceholders = remoteIds.size > 0 ? [...remoteIds].map(() => '?').join(',') : "''";
    const remoteArgs = [...remoteIds];
    // A row that disappears from venue's open list could be EITHER cancelled OR filled. Distinguish via the
    // size_matched figure (WS / earlier fills mark it on the way down):
    //   size_matched > 0  → status=FILLED  (the venue took the rest; size_matched may equal `size` exactly or
    //                       be slightly less due to partial-fill ordering, both are FILLED for our purposes)
    //   size_matched == 0 → status=CANCELED (we cancelled it, or it was never matched)
    // Without this distinction the bot has historically labelled every filled order as CANCELED, which is what
    // hid today's BUY-eat-then-SELL incident from the orders ledger.
    const markMissingFilled = this.db.prepare(`
      UPDATE orders
      SET status='FILLED', updated_at=?
      WHERE venue=?
        AND external_id IS NOT NULL
        AND status='OPEN'
        AND size_matched > 0
        AND client_order_id LIKE ?
        AND external_id NOT IN (${remotePlaceholders})
    `);
    const markMissingClosed = this.db.prepare(`
      UPDATE orders
      SET status='CANCELED', updated_at=?
      WHERE venue=?
        AND external_id IS NOT NULL
        AND status='OPEN'
        AND size_matched = 0
        AND client_order_id LIKE ?
        AND external_id NOT IN (${remotePlaceholders})
    `);
    const markMissingManagedFilled = this.db.prepare(`
      UPDATE orders
      SET status='FILLED', updated_at=?
      WHERE venue=?
        AND external_id IS NOT NULL
        AND status='OPEN'
        AND size_matched > 0
        AND client_order_id NOT LIKE ?
        AND updated_at <= ?
        AND external_id NOT IN (${remotePlaceholders})
    `);
    const markMissingManagedClosed = this.db.prepare(`
      UPDATE orders
      SET status='CANCELED', updated_at=?
      WHERE venue=?
        AND external_id IS NOT NULL
        AND status='OPEN'
        AND size_matched = 0
        AND client_order_id NOT LIKE ?
        AND updated_at <= ?
        AND external_id NOT IN (${remotePlaceholders})
    `);
    this.db.transaction(() => {
      this.ingestOpenOrders(remoteOrders, mode);
      markMissingFilled.run(now, venue, `${venue}:%`, ...remoteArgs);
      markMissingClosed.run(now, venue, `${venue}:%`, ...remoteArgs);
      markMissingManagedFilled.run(now, venue, `${venue}:%`, now - (options.freshOpenGraceMs ?? 0), ...remoteArgs);
      markMissingManagedClosed.run(now, venue, `${venue}:%`, now - (options.freshOpenGraceMs ?? 0), ...remoteArgs);
    })();
  }

  markStalePendingOpenOrdersCanceled(venue: VenueName, olderThanMs = 30_000): void {
    const cutoff = Date.now() - Math.max(0, olderThanMs);
    this.db.prepare(`
      UPDATE orders
      SET status='UNKNOWN',
        reason='pending-open-not-confirmed',
        updated_at=@updated_at,
        raw_json=json_set(
          CASE WHEN json_valid(raw_json) THEN raw_json ELSE '{}' END,
          '$.pendingOpenExpired',
          json_object('cutoff', @cutoff)
        )
      WHERE venue=@venue
        AND status='PENDING_OPEN'
        AND external_id IS NOT NULL
        AND updated_at <= @cutoff
    `).run({ venue, cutoff, updated_at: Date.now() });
  }

  markStalePlannedOrdersUnknown(venue: VenueName, olderThanMs = 30_000): void {
    const cutoff = Date.now() - Math.max(0, olderThanMs);
    this.db.prepare(`
      UPDATE orders
      SET status='UNKNOWN',
        reason='planned-order-not-submitted',
        updated_at=@updated_at,
        raw_json=json_set(
          CASE WHEN json_valid(raw_json) THEN raw_json ELSE '{}' END,
          '$.plannedOrderExpired',
          json_object('cutoff', @cutoff)
        )
      WHERE venue=@venue
        AND status='PLANNED'
        AND external_id IS NULL
        AND updated_at <= @cutoff
    `).run({ venue, cutoff, updated_at: Date.now() });
  }

  markOrdersCanceled(venue: VenueName, orderIds: string[]): void {
    if (orderIds.length === 0) return;
    const now = Date.now();
    const stmt = this.db.prepare(`
      UPDATE orders
      SET status='CANCELED', updated_at=@updated_at
      WHERE venue=@venue AND external_id=@external_id
    `);
    const updateMany = this.db.transaction((ids: string[]) => {
      for (const id of ids) {
        stmt.run({ updated_at: now, venue, external_id: id });
      }
    });
    updateMany(orderIds);
  }

  listOpenOrders(venue?: VenueName): OpenOrder[] {
    const rows = this.db.prepare(`
      SELECT venue, external_id, token_id, side, price, size, status, raw_json
      FROM orders
      WHERE status IN ('OPEN', 'PENDING_OPEN', 'PLANNED') AND external_id IS NOT NULL
      ${venue ? 'AND venue = ?' : ''}
    `).all(...(venue ? [venue] : [])) as Array<Record<string, unknown>>;
    const byExternalId = new Map<string, OpenOrder>();
    for (const row of rows) {
      const externalId = String(row.external_id);
      byExternalId.set(externalId, {
        venue: row.venue as VenueName,
        externalId,
        tokenId: String(row.token_id),
        side: row.side as 'BUY' | 'SELL',
        price: Number(row.price),
        size: Number(row.size),
        status: row.status as OpenOrder['status'],
        raw: JSON.parse(String(row.raw_json || '{}'))
      });
    }
    return [...byExternalId.values()];
  }

  listManagedOpenOrders(venue: VenueName): OpenOrder[] {
    const rows = this.db.prepare(`
      SELECT venue, external_id, token_id, side, price, size, status, created_at, raw_json
      FROM orders
      WHERE status IN ('OPEN', 'PENDING_OPEN', 'PLANNED')
        AND external_id IS NOT NULL
        AND venue = ?
        AND client_order_id NOT LIKE ?
    `).all(venue, `${venue}:%`) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      venue: row.venue as VenueName,
      externalId: String(row.external_id),
      tokenId: String(row.token_id),
      side: row.side as 'BUY' | 'SELL',
      price: Number(row.price),
      size: Number(row.size),
      status: row.status as OpenOrder['status'],
      ...(Number.isFinite(Number(row.created_at)) ? { placedAt: Number(row.created_at) } : {}),
      raw: JSON.parse(String(row.raw_json || '{}'))
    }));
  }

  listRecentOrders(limit = 20): RecentOrder[] {
    const rows = this.db.prepare(`
      SELECT client_order_id, external_id, venue, token_id, side, price, size,
        notional_usd, status, mode, reason, updated_at
      FROM orders
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      clientOrderId: String(row.client_order_id),
      ...(row.external_id ? { externalId: String(row.external_id) } : {}),
      venue: String(row.venue),
      tokenId: String(row.token_id),
      side: String(row.side),
      price: Number(row.price),
      size: Number(row.size),
      notionalUsd: Number(row.notional_usd),
      status: String(row.status),
      mode: String(row.mode),
      ...(row.reason ? { reason: String(row.reason) } : {}),
      updatedAt: new Date(Number(row.updated_at)).toISOString()
    }));
  }

  filledCashflowSince(venue: VenueName, sinceTs: number): number {
    const rows = this.db.prepare(`
      SELECT side, price, size, status
      FROM orders
      WHERE venue = ?
        AND updated_at >= ?
        AND status = 'FILLED'
    `).all(venue, sinceTs) as Array<Record<string, unknown>>;
    return Number(rows.reduce((sum, row) => {
      const notional = Number(row.price) * Number(row.size);
      if (!Number.isFinite(notional)) return sum;
      return sum + (row.side === 'SELL' ? notional : -notional);
    }, 0).toFixed(4));
  }

  countOpenOrders(): number {
    return Number((this.db.prepare(`SELECT COUNT(DISTINCT COALESCE(external_id, client_order_id)) AS count FROM orders WHERE status = 'OPEN'`).get() as { count: number }).count);
  }
}

function alternateOrderIds(raw: unknown): string[] {
  if (!raw || typeof raw !== 'object') return [];
  const root = raw as Record<string, unknown>;
  const order = root.order && typeof root.order === 'object' ? root.order as Record<string, unknown> : {};
  return [
    root.id,
    root.orderId,
    root.order_id,
    root.orderHash,
    root.order_hash,
    root.hash,
    order.id,
    order.orderId,
    order.order_id,
    order.hash,
    order.order_hash
  ].flatMap((value) => value === null || value === undefined || String(value).trim() === '' ? [] : [String(value)]);
}

function orderHash(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const ids = alternateOrderIds(raw).filter((id) => id.startsWith('0x') && id.length >= 18);
  return ids[0];
}
