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
/**
 * Optional "protect on fill" hook the engine passes in to react to WS-confirmed fills BEFORE the next cycle's REST
 * positions sync notices them. Invoked once per parsed trade event with the fill's token/size/price. Must not throw —
 * fire-and-forget; the engine is expected to spawn the async protect task and handle its own errors. Without this
 * hook the handler stays at its original ledger-only behaviour (no behavior change for tests that don't wire it).
 */
export type PolymarketFillProtectHook = (tokenId: string, fillSize: number, fillPrice: number) => void;

/**
 * Returns the bot's current Polymarket maker wallet address (lower-case or mixed-case). When provided,
 * parsePolymarketTrade can find bot's slice of a multi-maker fill (record.maker_orders[i].matched_amount)
 * instead of recording the entire trade size. Production 2026-06-26: a multi-maker SELL was logged as
 * size=2065 (trade total) when bot's actual portion was ~150 — the inflated size caused the exit submit
 * to be rejected with "balance: X, order amount: Y", and the apparent loss was over-stated.
 * Pass undefined to keep the legacy "use record.size unchanged" behaviour (suitable for unit tests).
 */
export type PolymarketBotAddressGetter = () => string | undefined;

export class PolymarketUserStreamHandler {
  private static readonly VENUE: VenueName = 'polymarket';

  constructor(
    private readonly store: StateStore,
    private readonly onFillProtect?: PolymarketFillProtectHook,
    private readonly botAddressGetter?: PolymarketBotAddressGetter
  ) {}

  /** Entry point passed to `polymarketVenue.setUserEventListener()`. Must not throw. */
  handle(type: 'order' | 'trade', record: Record<string, unknown>, receivedAt: number): void {
    if (type === 'trade') {
      this.handleTrade(record, receivedAt);
    } else {
      this.handleOrderUpdate(record, receivedAt);
    }
  }

  private handleTrade(record: Record<string, unknown>, receivedAt: number): void {
    const botAddress = this.botAddressGetter?.();
    const fill = parsePolymarketTrade(record, receivedAt, botAddress);
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
      // After successful ledger, invoke the protect hook so the engine can spawn the cancel+exit task
      // BEFORE the next cycle's REST positions sync would have noticed the fill. The hook is fire-and-forget;
      // any error inside it must NOT propagate back to the WS reader (would kill the socket).
      if (this.onFillProtect && fill.tokenId && Number.isFinite(fill.price) && Number.isFinite(fill.size) && fill.size > 0) {
        try { this.onFillProtect(fill.tokenId, fill.size, fill.price); }
        catch { /* hook errors are the engine's problem, not ours */ }
      }
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

export function parsePolymarketTrade(record: Record<string, unknown>, receivedAt: number, botAddress?: string): ParsedPolymarketFill | undefined {
  // Polymarket wire schema for a TRADE message (CLOB v2): primary identifiers, side, price, size, fee. We accept
  // both snake_case and camelCase because their wire feed mixes them in places. The trade_id / id field is the
  // primary key for account_fills, so we require it; everything else is best-effort enrichment.
  const fillId = stringOrUndefined(record.trade_id ?? record.tradeId ?? record.id);
  if (!fillId) return undefined;
  const price = numberOrUndefined(record.price ?? record.match_price ?? record.matchPrice);
  const tradeTotalSize = numberOrUndefined(record.size ?? record.match_size ?? record.matchSize ?? record.size_matched ?? record.sizeMatched);
  // Multi-maker fill correction. When bot is one of N makers in a single trade, `record.size` is the trade
  // TOTAL across all makers, not bot's portion. Using the inflated total as bot's fill size both miscounts
  // the position AND causes the exit submit to fail with "balance: bot_actual_X, order amount: trade_total_Y".
  // Strategy: when botAddress is known AND record.maker_orders is present, sum the matched_amount of entries
  // whose maker_address matches bot. Three fall-through cases preserve the existing behaviour:
  //   - botAddress undefined (no bot identity available) → use record.size unchanged
  //   - record.maker_orders absent (taker-side perspective or single-maker wire shape) → use record.size
  //   - bot not in maker_orders (bot was the taker) → use record.size, which IS the taker's full size
  let size = tradeTotalSize;
  // When the bot is one of N makers, the trade's aggregate price is the taker's price, not the bot's.
  // Aggregate a weighted-average price from the bot's own maker_orders entries so the recorded price
  // and notional match what the bot actually transacted at.
  let makerWeightedPrice: number | undefined;
  let makerTokenId: string | undefined;
  if (botAddress && Array.isArray(record.maker_orders)) {
    const lower = botAddress.toLowerCase();
    let botMatched = 0;
    let botNotional = 0;
    let foundBotMaker = false;
    for (const entry of record.maker_orders) {
      if (!entry || typeof entry !== 'object') continue;
      const row = entry as Record<string, unknown>;
      const addr = stringOrUndefined(row.maker_address ?? row.makerAddress);
      if (!addr || addr.toLowerCase() !== lower) continue;
      const matched = numberOrUndefined(row.matched_amount ?? row.matchedAmount);
      const entryPrice = numberOrUndefined(row.price);
      if (matched !== undefined && matched > 0) {
        botMatched += matched;
        if (entryPrice !== undefined && entryPrice > 0) botNotional += matched * entryPrice;
        // Capture the maker's own asset_id — the trade's record.asset_id is the taker's view;
        // multi-maker cross-asset trades bundle assets under different ids.
        if (!makerTokenId) {
          const entryAssetId = stringOrUndefined(row.asset_id ?? row.assetId);
          if (entryAssetId) makerTokenId = entryAssetId;
        }
        foundBotMaker = true;
      }
    }
    if (foundBotMaker && botMatched > 0) {
      size = Number(botMatched.toFixed(8));
      if (botNotional > 0) makerWeightedPrice = Number((botNotional / botMatched).toFixed(8));
    }
  }
  const effectivePrice = makerWeightedPrice ?? price;
  if (effectivePrice === undefined || size === undefined || effectivePrice <= 0 || size <= 0) return undefined;
  const rawSide = stringOrUndefined(record.side)?.toUpperCase();
  const side: 'BUY' | 'SELL' | undefined = rawSide === 'BUY' || rawSide === 'SELL' ? rawSide as 'BUY' | 'SELL' : undefined;
  // Prefer maker-specific asset_id over trade-level: in cross-asset fills the trade record's
  // asset_id is the taker's view and may differ from the bot's matched asset.
  const tokenId = makerTokenId || stringOrUndefined(record.asset_id ?? record.assetId ?? record.token_id ?? record.tokenId);
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
    price: effectivePrice,
    size,
    notionalUsd: effectivePrice * size,
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
