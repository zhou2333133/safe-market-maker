import type { StateStore } from '../store/sqlite.js';
import type { VenueName } from '../domain/types.js';

/**
 * Consumes the Polymarket user-channel WS feed and ledger fills the moment the venue confirms them — independent
 * of the REST account-risk pull (which is the path that intermittently stalls through the user's proxy).
 *
 * Why it's a separate service rather than logic inlined into the engine:
 *   - The WS event handler runs on the WS reader's microtask, not inside a cycle. Keeping it scoped here means the
 *     engine's per-cycle code never deals with parsing wire formats — it just sees a fully-populated account_fills
 *     table on the next REST snapshot read.
 *   - Polymarket's wire shape varies by event subtype (TRADE_MATCHED vs TRADE_MAKER vs ORDER_UPDATE, plus the
 *     legacy {event_type:"trade"} subset). Parsing is defensive — anything we can't recognise is recorded as an
 *     observability event but never throws.
 *
 * What it does NOT do (yet):
 *   - Update orders.size_matched / status (deferred to Commit 2 which adds the column + migration).
 *   - Drive any business decision (positions, exits) — those still depend on the REST account snapshot. This
 *     service only ensures the fill is in the ledger so the FOLLOWING REST snapshot won't be the FIRST trace.
 */
export class PolymarketUserStreamHandler {
  private static readonly VENUE: VenueName = 'polymarket';

  constructor(private readonly store: StateStore) {}

  /** Entry point passed to `polymarketVenue.setUserEventListener()`. Must not throw. */
  handle(type: 'order' | 'trade', record: Record<string, unknown>, receivedAt: number): void {
    if (type === 'trade') {
      this.handleTrade(record, receivedAt);
    } else {
      this.handleOrderUpdate(record, receivedAt);
    }
  }

  private handleTrade(record: Record<string, unknown>, receivedAt: number): void {
    const fill = parsePolymarketTrade(record, receivedAt);
    if (!fill) {
      this.recordUnparseable('trade', record);
      return;
    }
    try {
      this.store.recordWsFill({
        venue: PolymarketUserStreamHandler.VENUE,
        fillId: fill.fillId,
        orderId: fill.orderId,
        tokenId: fill.tokenId,
        marketId: fill.marketId,
        side: fill.side,
        price: fill.price,
        size: fill.size,
        notionalUsd: fill.notionalUsd,
        feeUsd: fill.feeUsd,
        fillTs: fill.fillTs,
        raw: record
      });
      // Update the orders ledger so the operator can see the order's size_matched without joining account_fills.
      // applyFillSizeUpdate is idempotent on size_matched, so duplicate / out-of-order WS events are safe.
      let orderLedgered = false;
      if (fill.orderId) {
        try {
          orderLedgered = this.store.applyFillSizeUpdate(
            PolymarketUserStreamHandler.VENUE,
            fill.orderId,
            fill.size,
            { fillTs: fill.fillTs }
          );
        } catch {
          // applyFillSizeUpdate failure must not break the WS leg — account_fills already captured the data.
        }
      }
      this.store.recordEvent({
        venue: PolymarketUserStreamHandler.VENUE,
        severity: 'warn',
        type: 'fill.ws-ledgered',
        message: `WS 推送实时成交 ${fill.side} ${fill.size} @ ${fill.price} ($${fill.notionalUsd.toFixed(2)})`,
        details: {
          fillId: fill.fillId,
          orderId: fill.orderId,
          tokenId: fill.tokenId,
          side: fill.side,
          price: fill.price,
          size: fill.size,
          notionalUsd: fill.notionalUsd,
          orderLedgered,
          sourceWireType: String(record.event_type ?? record.type ?? 'trade')
        }
      });
    } catch (error) {
      // Database write failing must not kill the WS reader. Record and move on — REST snapshot is still the
      // belt-and-suspenders backup.
      this.store.recordEvent({
        venue: PolymarketUserStreamHandler.VENUE,
        severity: 'error',
        type: 'fill.ws-ledger-failed',
        message: 'WS 成交入库失败,退回 REST 兜底',
        details: { error: error instanceof Error ? error.message : String(error), fillId: fill.fillId }
      });
    }
  }

  private handleOrderUpdate(record: Record<string, unknown>, _receivedAt: number): void {
    // Order updates are best-effort observability only in Commit 1; Commit 2 will use them to update
    // orders.status / orders.size_matched. For now we just surface the update for forensic inspection.
    const externalId = stringOrUndefined(record.id ?? record.order_id ?? record.orderId);
    const status = stringOrUndefined(record.status);
    if (!externalId) return;
    this.store.recordEvent({
      venue: PolymarketUserStreamHandler.VENUE,
      severity: 'info',
      type: 'order.ws-update',
      message: `WS 推送订单状态 ${externalId.slice(0, 18)}… → ${status ?? '?'}`,
      details: {
        externalId,
        status,
        sizeMatched: numberOrUndefined(record.size_matched ?? record.sizeMatched),
        side: stringOrUndefined(record.side)
      }
    });
  }

  private recordUnparseable(kind: 'order' | 'trade', record: Record<string, unknown>): void {
    this.store.recordEvent({
      venue: PolymarketUserStreamHandler.VENUE,
      severity: 'info',
      type: 'fill.ws-unparseable',
      message: `WS 事件无法解析 (kind=${kind})`,
      details: { kind, wireType: String(record.event_type ?? record.type ?? '?') }
    });
  }
}

/** Pure parser exported for unit testing without needing a StateStore. */
export interface ParsedPolymarketFill {
  fillId: string;
  orderId?: string;
  tokenId?: string;
  marketId?: string;
  side?: 'BUY' | 'SELL';
  price: number;
  size: number;
  notionalUsd: number;
  feeUsd?: number;
  fillTs: number;
}

export function parsePolymarketTrade(record: Record<string, unknown>, receivedAt: number): ParsedPolymarketFill | undefined {
  // Polymarket wire schema for a TRADE message (CLOB v2): primary identifiers, side, price, size, fee. We accept
  // both snake_case and camelCase because their wire feed mixes them in places. The trade_id / id field is the
  // primary key for account_fills, so we require it; everything else is best-effort enrichment.
  const fillId = stringOrUndefined(record.trade_id ?? record.tradeId ?? record.id);
  if (!fillId) return undefined;
  const price = numberOrUndefined(record.price ?? record.match_price ?? record.matchPrice);
  const size = numberOrUndefined(record.size ?? record.match_size ?? record.matchSize ?? record.size_matched ?? record.sizeMatched);
  if (price === undefined || size === undefined || price <= 0 || size <= 0) return undefined;
  const rawSide = stringOrUndefined(record.side)?.toUpperCase();
  const side: 'BUY' | 'SELL' | undefined = rawSide === 'BUY' || rawSide === 'SELL' ? rawSide as 'BUY' | 'SELL' : undefined;
  const tokenId = stringOrUndefined(record.asset_id ?? record.assetId ?? record.token_id ?? record.tokenId);
  const marketId = stringOrUndefined(record.market ?? record.market_id ?? record.marketId);
  const orderId = stringOrUndefined(record.taker_order_id ?? record.takerOrderId ?? record.maker_order_id ?? record.makerOrderId ?? record.order_id ?? record.orderId);
  const feeUsd = numberOrUndefined(record.fee ?? record.fee_usd ?? record.feeUsd);
  // Polymarket sends a `timestamp` field in seconds (string) for trades. Fallback to receivedAt so the ledger
  // entry is never dateless even when the wire format omits it.
  const tradeTs = numberOrUndefined(record.timestamp ?? record.ts ?? record.fill_ts ?? record.fillTs);
  const fillTs = tradeTs && tradeTs > 1_000_000_000_000
    ? tradeTs                // already ms
    : tradeTs && tradeTs > 1_000_000_000
      ? tradeTs * 1000       // seconds → ms
      : receivedAt;
  return {
    fillId,
    orderId,
    tokenId,
    marketId,
    side,
    price,
    size,
    notionalUsd: price * size,
    feeUsd,
    fillTs
  };
}

function stringOrUndefined(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}
