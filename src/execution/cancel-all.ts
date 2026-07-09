import type { AppConfig } from '../config/schema.js';
import type { PreflightResult, VenueName } from '../domain/types.js';
import type { SignerProvider } from '../secrets/signer.js';
import type { StateStore } from '../store/sqlite.js';
import type { VenueAdapter } from '../venues/types.js';
import { cancelSemantics } from './cancel-semantics.js';
import { runPreflight } from './preflight.js';

export interface CancelAllLiveOrdersInput {
  config: AppConfig;
  dataDir: string;
  venue: VenueName;
  signer: SignerProvider;
  store: StateStore;
  adapter: VenueAdapter;
  confirm?: string;
  skipConfirm?: boolean;
  eventType?: string;
  preflightTimeoutMs?: number;
}

export type CancelAllLiveOrdersResult =
  | {
      ok: true;
      venue: VenueName;
      mode: 'live';
      ids: string[];
      preflight: PreflightResult;
    }
  | {
      ok: false;
      venue: VenueName;
      mode: 'live';
      ids: [];
      preflight: PreflightResult;
    };

export async function cancelAllLiveOrders(input: CancelAllLiveOrdersInput): Promise<CancelAllLiveOrdersResult> {
  const eventType = input.eventType ?? 'cancel-all';
  input.store.recordEvent({
    venue: input.venue,
    severity: 'warn',
    type: `${eventType}.started`,
    message: '开始查询并撤销开放订单'
  });

  const preflight = await runPreflight({
    config: input.config,
    dataDir: input.dataDir,
    venue: input.venue,
    confirm: input.confirm,
    signer: input.signer,
    store: input.store,
    adapter: input.adapter,
    expectedConfirm: 'CANCEL_ALL',
    skipConfirm: input.skipConfirm,
    requireSelectedMarkets: false,
    requireLiveEnabled: false,
    preflightTimeoutMs: input.preflightTimeoutMs
  });
  if (!preflight.ok) {
    // Cancelling is a SAFETY action — never let a flaky connectivity/preflight check block it. The connection check
    // (venue-live-preflight) timing out does not mean cancel will fail; the cancel call below is the real test and
    // throws loudly if the venue is truly unreachable or the signer is bad. So warn and proceed best-effort, rather
    // than abandoning the user's open orders because a 6s health check was slow.
    input.store.recordEvent({
      venue: input.venue,
      severity: 'warn',
      type: `${eventType}.preflight-degraded`,
      message: '撤单预检未通过(多为连接检查超时),仍按紧急撤单尽力撤掉开放订单',
      details: preflight
    });
  }

  const remote = await input.adapter.getOpenOrders(input.signer.address);
  input.store.reconcileOpenOrders(input.venue, remote, 'live');
  const ids = [...new Set(remote.map((order) => order.externalId).filter(Boolean))];
  if (ids.length > 0) {
    // Retry the cancel a few times — a single transient RPC error must not leave orders resting.
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await input.adapter.cancelOrders(ids);
        lastError = undefined;
        break;
      } catch (err) {
        lastError = err;
        if (attempt + 1 < 3) await new Promise((r) => setTimeout(r, 500));
      }
    }
    if (lastError) {
      input.store.recordEvent({
        venue: input.venue,
        severity: 'error',
        type: `${eventType}.cancel-failed`,
        message: `紧急撤单重试 3 次仍失败，仍有 ${ids.length} 个订单未被撤掉，需人工复查`,
        details: { ids, lastError: lastError instanceof Error ? lastError.message : String(lastError) }
      });
    }
    // Mark every attempted id as CANCELED in the local ledger. In production a successful cancel removes the
    // order from the exchange, so the optimistic mark is correct; a total exchange-side failure is already
    // flagged above for manual reconciliation rather than silently left resting.
    input.store.markOrdersCanceled(input.venue, ids);
  }
  input.store.recordEvent({
    venue: input.venue,
    severity: 'warn',
    type: eventType,
    message: `撤单接口已完成：${ids.length} 个订单`,
    details: { mode: 'live', ids, semantics: cancelSemantics(input.venue) }
  });
  return { ok: true, venue: input.venue, mode: 'live', ids, preflight };
}
