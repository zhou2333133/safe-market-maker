import type { AppConfig } from '../config/schema.js';
import type { OrderIntent, Orderbook, VenueName } from '../domain/types.js';
import { evaluateSubmitGuard } from '../execution/submit-guard.js';
import { cancelAllLiveOrders } from '../execution/cancel-all.js';
import { withLiveContext } from '../execution/live-context.js';
import { rejectReason } from '../risk/reject-reasons.js';
import type { VenueAdapter } from '../venues/types.js';
import type { SignerProvider } from '../secrets/signer.js';
import type { StateStore } from '../store/sqlite.js';
import { UiError } from './errors.js';
import {
  asRecord,
  createVenueForUi,
  parseVenueParam
} from './controller-utils.js';

export async function manualOrder(_configPath: string, _body: unknown): Promise<unknown> {
  throw new UiError(
    400,
    '手动下单入口已禁用。请使用“开始实盘”让机器人按当前单边/双边策略自动执行；紧急处理只保留停止并撤单。'
  );
}

export async function cancelAll(configPath: string, body: unknown): Promise<unknown> {
  const request = asRecord(body);
  const venue = parseVenueParam(request.venue);
  const result = await cancelAllLive(configPath, venue, request.passphrase, 'ui.cancel-all');
  return { ok: true, ...result };
}

export async function cancelAllLive(
  configPath: string,
  venue: VenueName,
  passphraseValue: unknown,
  eventType: string
): Promise<{ venue: VenueName; mode: 'live'; ids: string[] }> {
  const passphrase = typeof passphraseValue === 'string' ? passphraseValue : '';
  return withLiveContext(configPath, venue, passphrase, async ({ config, dataDir, signer, adapter, store }) => {
    adapter = await createVenueForUi(config, dataDir, venue, signer, passphrase);
    const result = await cancelAllLiveOrders({
      config,
      dataDir,
      venue,
      signer,
      store,
      adapter,
      skipConfirm: true,
      eventType,
      preflightTimeoutMs: 6000
    });
    if (!result.ok) throw new UiError(400, '紧急撤单预检失败', result.preflight);
    return { venue, mode: 'live', ids: result.ids };
  });
}

export async function submitLiveManualOrder(
  adapter: VenueAdapter,
  signer: SignerProvider,
  intent: OrderIntent,
  config: AppConfig,
  positions: Awaited<ReturnType<VenueAdapter['getPositions']>>,
  openOrders: Awaited<ReturnType<VenueAdapter['getOpenOrders']>>,
  initialBook: Orderbook,
  store?: Pick<StateStore, 'recordEvent'> & Partial<Pick<StateStore, 'markPlannedOrderRejected' | 'markPlannedOrderUnknown'>>,
  venue: VenueName = intent.venue
) {
  let freshBook;
  try {
    freshBook = await adapter.getOrderbook(intent.tokenId);
  } catch (error) {
    recordManualPreSubmitException(store, venue, intent, error, 'manual-final-orderbook-check');
    throw error;
  }
  const submitGuard = evaluateSubmitGuard({
    config,
    intent,
    initialBook,
    freshBook,
    positions,
    openOrders,
    stage: 'manual-final-orderbook-check'
  });
  if (!submitGuard.ok && submitGuard.reason === 'market-guard') {
    const details = {
      guard: submitGuard.guard,
      intent,
      reject: submitGuard.reject
    };
    store?.markPlannedOrderRejected?.(intent.clientOrderId, 'manual-final-orderbook-check', details);
    store?.recordEvent({ venue, severity: 'warn', type: 'manual-order.final-market-guard-reject', message: intent.clientOrderId, details });
    throw new UiError(400, '最终盘口保护拒绝手动实盘订单', details);
  }
  if (!submitGuard.ok) {
    const details = {
      decision: submitGuard.decision,
      intent,
      reject: submitGuard.reject
    };
    store?.markPlannedOrderRejected?.(intent.clientOrderId, 'manual-final-orderbook-check', details);
    store?.recordEvent({ venue, severity: 'warn', type: 'manual-order.final-risk-reject', message: intent.clientOrderId, details });
    throw new UiError(400, '最终盘口复检拒绝手动实盘订单', details);
  }
  try {
    return await adapter.createOrder(intent, signer);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const reject = rejectReason('SUBMIT_EXCEPTION', 'platform', 'manual-order');
    const details = { error: message, intent, reject };
    store?.markPlannedOrderUnknown?.(intent.clientOrderId, 'submit-exception', details);
    store?.recordEvent({ venue, severity: 'error', type: 'manual-order.submit-error', message: intent.clientOrderId, details });
    throw error;
  }
}

function recordManualPreSubmitException(
  store: (Pick<StateStore, 'recordEvent'> & Partial<Pick<StateStore, 'markPlannedOrderRejected'>>) | undefined,
  venue: VenueName,
  intent: OrderIntent,
  error: unknown,
  stage: string
): void {
  const message = error instanceof Error ? error.message : String(error);
  const reject = rejectReason('SUBMIT_EXCEPTION', 'platform', stage);
  const details = { error: message, intent, reject };
  store?.markPlannedOrderRejected?.(intent.clientOrderId, stage, details);
  store?.recordEvent({ venue, severity: 'error', type: 'manual-order.submit-error', message: intent.clientOrderId, details });
}
