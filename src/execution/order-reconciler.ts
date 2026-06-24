import type { OpenOrder, VenueName } from '../domain/types.js';
import { rejectReason } from '../risk/reject-reasons.js';
import { httpErrorDetails } from '../observability/http-error.js';
import type { StateStore } from '../store/sqlite.js';
import type { VenueAdapter } from '../venues/types.js';

const FRESH_OPEN_REMOTE_GRACE_MS = 2 * 60 * 1000;
const PENDING_OPEN_CONFIRMATION_GRACE_MS = 30 * 1000;
const PLANNED_ORDER_SUBMIT_GRACE_MS = 30 * 1000;

export type OpenOrderSyncResult =
  | { ok: true; openOrders: OpenOrder[] }
  | { ok: false; openOrders: []; error: string };

export class OrderReconciler {
  constructor(
    private readonly adapter: VenueAdapter,
    private readonly store: StateStore
  ) {}

  async syncOpenOrders(venue: VenueName, signerAddress: string): Promise<OpenOrderSyncResult> {
    try {
      const openOrders = await this.adapter.getOpenOrders(signerAddress);
      this.store.reconcileOpenOrders(venue, openOrders, 'live', { freshOpenGraceMs: FRESH_OPEN_REMOTE_GRACE_MS });
      this.store.markStalePendingOpenOrdersCanceled(venue, PENDING_OPEN_CONFIRMATION_GRACE_MS);
      this.store.markStalePlannedOrdersUnknown(venue, PLANNED_ORDER_SUBMIT_GRACE_MS);
      return { ok: true, openOrders: mergeLocalManagedOpenOrders(openOrders, this.store.listManagedOpenOrders(venue)) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Local-only state cleanup MUST still run when the remote getOpenOrders fails: PENDING_OPEN orders that never
      // got their confirmation, and PLANNED orders that never got their submit-result callback, are stuck in the
      // local ledger until something marks them. Without this catch-side sweep, repeated venue outages leak ghost
      // orders that the fast-tick path will then keep trying to manage. These markers are pure local-time deductions
      // (no remote call) so they cannot themselves throw.
      try {
        this.store.markStalePendingOpenOrdersCanceled(venue, PENDING_OPEN_CONFIRMATION_GRACE_MS);
        this.store.markStalePlannedOrdersUnknown(venue, PLANNED_ORDER_SUBMIT_GRACE_MS);
      } catch { /* never let cleanup itself surface as the failure */ }
      this.store.recordEvent({
        venue,
        severity: 'error',
        type: 'open-orders.unavailable',
        message: '开放订单同步失败，本轮不会新增订单',
        details: { error: message, ...httpErrorDetails(error), reject: rejectReason('OPEN_ORDERS_UNAVAILABLE', 'platform', 'syncing-orders') }
      });
      this.store.checkpoint(`run.${venue}`, { mode: 'live', skippedQuoting: true, reason: 'open-orders.unavailable' });
      return { ok: false, openOrders: [], error: message };
    }
  }
}

function mergeLocalManagedOpenOrders(remoteOrders: OpenOrder[], managedOrders: OpenOrder[]): OpenOrder[] {
  const remoteIds = new Set(remoteOrders.map((order) => order.externalId).filter(Boolean));
  const localActive = managedOrders.filter((order) => !remoteIds.has(order.externalId));
  return [...remoteOrders, ...localActive];
}
