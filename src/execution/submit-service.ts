import type { AppConfig } from '../config/schema.js';
import type { AccountRiskDecision, OpenOrder, OrderIntent, Orderbook, Position, VenueName } from '../domain/types.js';
import { dayStartTs } from '../risk/account-risk.js';
import { accountRiskReasonCode, rejectReason } from '../risk/reject-reasons.js';
import { accountRiskWindowStart } from '../risk/risk-window.js';
import type { SignerProvider } from '../secrets/signer.js';
import type { StateStore } from '../store/sqlite.js';
import { StrategyEngine } from '../strategy/strategy-engine.js';
import { httpErrorDetails } from '../observability/http-error.js';
import type { VenueAdapter } from '../venues/types.js';
import { AccountSyncService } from './account-sync.js';
import { ExecutionRecorder } from './event-recorder.js';
import { evaluateSubmitGuard } from './submit-guard.js';

export type SubmitServiceResult =
  | {
      status: 'submitted';
      externalId?: string;
      verifiedOpen: boolean;
      openOrder?: OpenOrder;
      submittedIntent?: OrderIntent;
      raw?: unknown;
    }
  | {
      status: 'rejected';
    };

export interface PendingSubmittedOrder {
  clientOrderId: string;
  externalId: string;
  intent: OrderIntent;
  submitRaw?: unknown;
}

export type SubmittedOpenOrdersVerification =
  | {
      ok: true;
      attempts: number;
      orders: Array<{ submitted: PendingSubmittedOrder; order: OpenOrder }>;
    }
  | {
      ok: false;
      attempts: number;
      reason: string;
      detail?: string;
      verified: Array<{ submitted: PendingSubmittedOrder; order: OpenOrder }>;
      missing: string[];
      mismatches: Array<{ externalId: string; reason: string; detail?: string; order?: OpenOrder }>;
    };

export type SubmittedOpenOrdersPendingConfirmation = {
  attempts: number;
  reason: 'delayed-open-order-visibility';
  verification: Extract<SubmittedOpenOrdersVerification, { ok: false }>;
  pendingOrders: OpenOrder[];
};

export interface SubmitServiceInput {
  venue: VenueName;
  signer: SignerProvider;
  signerAddress?: string;
  dayStart?: number;
  intent: OrderIntent;
  initialBook: Orderbook;
  positions: Position[];
  openOrders: OpenOrder[];
  verifyOpen?: boolean;
  repriceRewardQuote?: boolean;
  accountRiskDecision?: AccountRiskDecision;
}

const POST_SUBMIT_VERIFY_TIMEOUT_MS = 3500;
const POST_SUBMIT_GROUP_VERIFY_TIMEOUT_MS = 12000;
const POST_SUBMIT_VERIFY_RETRY_MS = 750;
const PRICE_VERIFY_EPSILON = 0.000001;
const MIN_SIZE_VERIFY_EPSILON = 0.001;
const SIZE_VERIFY_RELATIVE_EPSILON = 0.0001;

export class SubmitService {
  private readonly accountSync: AccountSyncService;
  private readonly recorder: ExecutionRecorder;
  private readonly strategy: StrategyEngine;

  constructor(
    private readonly config: AppConfig,
    private readonly adapter: VenueAdapter,
    private readonly store: StateStore
  ) {
    this.accountSync = new AccountSyncService(config, adapter, store);
    this.recorder = new ExecutionRecorder(store);
    this.strategy = new StrategyEngine(config);
  }

  async submit(input: SubmitServiceInput): Promise<SubmitServiceResult> {
    this.store.recordPlannedOrder(input.intent, 'live');
    this.recorder.stage(input.venue, 'final-orderbook-check', '提交前重新读取盘口并复检');
    let freshBook;
    try {
      freshBook = await this.adapter.getOrderbook(input.intent.tokenId);
    } catch (error) {
      this.recordPreSubmitException(input.venue, input.intent, error, 'final-orderbook-check');
      throw error;
    }
    let finalIntent = input.intent;
    let finalRepriceUnavailable = false;
    if (input.repriceRewardQuote !== false) {
      const repriced = this.finalizeIntent(input.intent, freshBook, input.positions);
      if (repriced) finalIntent = repriced;
      else finalRepriceUnavailable = true;
    }
    if (this.config.strategy.entryMode === 'split' && input.intent.reward && finalRepriceUnavailable) {
      const reject = rejectReason('FINAL_REPRICE_UNAVAILABLE', 'risk', 'final-orderbook-check');
      this.rejectPlannedOrder(input.intent, 'final-orderbook-check', reject);
      this.recorder.event({
        venue: input.venue,
        severity: 'warn',
        type: 'risk.final-reject',
        message: input.intent.clientOrderId,
        details: {
          intent: input.intent,
          reject,
          decision: { ok: false, reasons: ['final reward quote could not be rebuilt from fresh orderbook'] }
        }
      });
      return { status: 'rejected' };
    }
    if (finalIntent !== input.intent) {
      this.recorder.event({
        venue: input.venue,
        type: 'quote.final-repriced',
        message: input.intent.clientOrderId,
        details: {
          initial: publicIntentPrice(input.intent),
          final: publicIntentPrice(finalIntent)
        }
      });
    }
    const submitGuard = evaluateSubmitGuard({
      config: this.config,
      intent: finalIntent,
      initialBook: input.initialBook,
      freshBook,
      positions: input.positions,
      openOrders: input.openOrders
    });
    if (!submitGuard.ok && submitGuard.reason === 'market-guard') {
      this.rejectPlannedOrder(input.intent, 'final-orderbook-check', submitGuard.reject);
      this.recorder.event({
        venue: input.venue,
        severity: 'warn',
        type: 'risk.market-guard.final-reject',
        message: input.intent.clientOrderId,
        details: { guard: submitGuard.guard, intent: finalIntent, originalIntent: input.intent, reject: submitGuard.reject }
      });
      return { status: 'rejected' };
    }
    if (!submitGuard.ok) {
      this.rejectPlannedOrder(input.intent, 'final-orderbook-check', submitGuard.reject);
      this.recorder.event({
        venue: input.venue,
        severity: 'warn',
        type: 'risk.final-reject',
        message: input.intent.clientOrderId,
        details: { ...submitGuard.decision, intent: finalIntent, originalIntent: input.intent, reject: submitGuard.reject }
      });
      return { status: 'rejected' };
    }

    this.recorder.stage(input.venue, 'submitting', '提交 maker 挂单');
    const submitRisk = freshOkAccountRiskDecision(this.config, input.accountRiskDecision)
      ?? await this.accountSync.accountRiskGate({
        venue: input.venue,
        signerAddress: input.signerAddress ?? input.signer.address,
        signer: input.signer,
        dayStart: input.dayStart ?? accountRiskWindowStart(input.venue, this.store, dayStartTs()),
        scope: 'auto-loop'
      });
    if (!submitRisk.ok) {
      this.rejectPlannedOrder(input.intent, 'submitting', rejectReason(accountRiskReasonCode(submitRisk.reason), 'account', 'submitting'));
      this.recordSubmitBlocked(input.venue, input.intent, submitRisk);
      return { status: 'rejected' };
    }

    let result;
    try {
      result = await this.adapter.createOrder(finalIntent, input.signer);
    } catch (error) {
      this.recordSubmitException(input.venue, input.intent, error);
      throw error;
    }
    if (result.externalId && result.status === 'OPEN') {
      if (input.verifyOpen === false) {
        this.store.recordOrderResult({
          ...result,
          status: 'PENDING_OPEN',
          raw: { submit: result.raw, verification: { ok: false, reason: 'pending-pair-verification' } }
        });
        this.recorder.event({
          venue: input.venue,
          type: 'order.submit-pending-verification',
          message: result.clientOrderId,
          details: { result, intent: publicIntentPrice(finalIntent) }
        });
        return {
          status: 'submitted',
          externalId: result.externalId,
          verifiedOpen: false,
          submittedIntent: finalIntent,
          raw: result.raw
        };
      }
      const verification = await this.verifySubmittedOpenOrder(input.venue, input.signerAddress ?? input.signer.address, finalIntent, result);
      if (!verification.ok) {
        this.store.recordOrderResult({ ...result, status: 'UNKNOWN', raw: { submit: result.raw, verification } });
        this.recorder.event({
          venue: input.venue,
          severity: 'warn',
          type: 'order.post-submit-unverified',
          message: result.clientOrderId,
          details: { result, intent: publicIntentPrice(finalIntent), verification }
        });
        return { status: 'submitted', externalId: result.externalId, verifiedOpen: false, submittedIntent: finalIntent, raw: result.raw };
      }
      const openOrder = this.recordVerifiedSubmittedOpenOrder(input.venue, {
        clientOrderId: result.clientOrderId,
        externalId: result.externalId,
        intent: finalIntent,
        submitRaw: result.raw
      }, verification.order);
      return {
        status: 'submitted',
        externalId: openOrder.externalId,
        verifiedOpen: true,
        openOrder,
        submittedIntent: finalIntent,
        raw: result.raw
      };
    }
    this.store.recordOrderResult(result);
    this.recorder.event({ venue: input.venue, type: 'order.submitted', message: result.clientOrderId, details: result });
    if (!result.externalId || result.status !== 'OPEN') return { status: 'submitted', externalId: result.externalId, verifiedOpen: false };
    return {
      status: 'submitted',
      externalId: result.externalId,
      verifiedOpen: true,
      submittedIntent: finalIntent,
      raw: result.raw,
      openOrder: {
        venue: input.venue,
        externalId: result.externalId,
        tokenId: input.intent.tokenId,
        side: finalIntent.side,
        price: finalIntent.price,
        size: finalIntent.size,
        status: 'OPEN',
        raw: result.raw
      }
    };
  }

  async cancelSubmittedOrders(venue: VenueName, orderIds: string[]): Promise<void> {
    const ids = [...new Set(orderIds.filter(Boolean))];
    if (ids.length === 0) return;
    await this.adapter.cancelOrders(ids);
    this.store.markOrdersCanceled(venue, ids);
    this.recorder.event({
      venue,
      severity: 'warn',
      type: 'split.pair-submit-rollback',
      message: `撤回不完整双边挂单：${ids.length} 个订单`,
      details: { ids }
    });
  }

  async verifySubmittedOpenOrders(
    venue: VenueName,
    signerAddress: string,
    submittedOrders: PendingSubmittedOrder[],
    timeoutMs = POST_SUBMIT_GROUP_VERIFY_TIMEOUT_MS
  ): Promise<SubmittedOpenOrdersVerification> {
    if (submittedOrders.length === 0) return { ok: true, attempts: 0, orders: [] };
    const deadline = Date.now() + timeoutMs;
    let attempts = 0;
    let lastFailure: SubmittedOpenOrdersVerification | undefined;

    while (Date.now() <= deadline) {
      attempts += 1;
      try {
        const remainingMs = Math.max(250, deadline - Date.now());
        const openOrders = await withTimeout(this.adapter.getOpenOrders(signerAddress), Math.min(POST_SUBMIT_VERIFY_TIMEOUT_MS, remainingMs));
        const verified = verifySubmittedOrdersOnce(openOrders, submittedOrders, attempts);
        if (verified.ok) return verified;
        if (verified.missing.length === 0 && verified.mismatches.length > 0) return verified;
        lastFailure = verified;
      } catch (error) {
        lastFailure = {
          ok: false,
          attempts,
          reason: 'verification-unavailable',
          detail: error instanceof Error ? error.message : String(error),
          verified: [],
          missing: submittedOrders.map((order) => order.externalId),
          mismatches: []
        };
      }
      if (Date.now() < deadline) await sleep(Math.min(POST_SUBMIT_VERIFY_RETRY_MS, Math.max(0, deadline - Date.now())));
    }

    return lastFailure ?? {
      ok: false,
      attempts,
      reason: 'not-found-in-open-orders',
      verified: [],
      missing: submittedOrders.map((order) => order.externalId),
      mismatches: []
    };
  }

  recordPendingSubmittedOpenOrders(
    venue: VenueName,
    submittedOrders: PendingSubmittedOrder[],
    verification: Extract<SubmittedOpenOrdersVerification, { ok: false }>
  ): SubmittedOpenOrdersPendingConfirmation {
    const pendingOrders = submittedOrders.map((submitted) => {
      const order = pendingOpenOrderFromSubmitted(venue, submitted);
      this.store.recordOrderResult({
        venue,
        clientOrderId: submitted.clientOrderId,
        externalId: submitted.externalId,
        status: 'PENDING_OPEN',
        raw: { submit: submitted.submitRaw, verification }
      });
      return order;
    });
    return {
      attempts: verification.attempts,
      reason: 'delayed-open-order-visibility',
      verification,
      pendingOrders
    };
  }

  recordVerifiedSubmittedOpenOrder(venue: VenueName, submitted: PendingSubmittedOrder, order: OpenOrder): OpenOrder {
    const verifiedResult = {
      venue,
      clientOrderId: submitted.clientOrderId,
      externalId: order.externalId,
      status: 'OPEN' as const,
      raw: { submit: submitted.submitRaw, verifiedOpenOrder: order.raw ?? order }
    };
    this.store.recordOrderResult(verifiedResult);
    this.recorder.event({
      venue,
      type: 'order.submitted',
      message: verifiedResult.clientOrderId,
      details: { ...verifiedResult, verified: true }
    });
    return {
      venue,
      externalId: order.externalId,
      tokenId: order.tokenId,
      side: order.side,
      price: order.price,
      size: order.size,
      status: 'OPEN',
      raw: order.raw
    };
  }

  private async verifySubmittedOpenOrder(
    venue: VenueName,
    signerAddress: string,
    intent: OrderIntent,
    result: { externalId?: string }
  ): Promise<{ ok: true; order: OpenOrder } | { ok: false; reason: string; detail?: string; order?: OpenOrder }> {
    if (!result.externalId) return { ok: false, reason: 'missing-external-id' };
    const verification = await this.verifySubmittedOpenOrders(venue, signerAddress, [{
      clientOrderId: intent.clientOrderId,
      externalId: result.externalId,
      intent
    }], POST_SUBMIT_VERIFY_TIMEOUT_MS);
    if (verification.ok) return { ok: true, order: verification.orders[0]!.order };
    const mismatch = verification.mismatches[0];
    return {
      ok: false,
      reason: mismatch?.reason ?? verification.reason,
      detail: mismatch?.detail ?? verification.detail,
      ...(mismatch?.order ? { order: mismatch.order } : {})
    };
  }

  private finalizeIntent(intent: OrderIntent, freshBook: Orderbook, positions: Position[]): OrderIntent | undefined {
    if (!intent.reward) return intent;
    const strategy = this.finalRepriceStrategy(intent);
    const repricePositions = this.config.strategy.entryMode === 'split'
      ? [{ venue: intent.venue, tokenId: intent.tokenId, size: Number.MAX_SAFE_INTEGER, notionalUsd: Number.MAX_SAFE_INTEGER }]
      : positions;
    const [freshIntent] = strategy.buildIntents(intent.venue, [intent.market], new Map([[intent.tokenId, freshBook]]), { positions: repricePositions });
    if (!freshIntent || freshIntent.side !== intent.side || freshIntent.tokenId !== intent.tokenId) return undefined;
    return {
      ...intent,
      price: freshIntent.price,
      size: this.config.strategy.entryMode === 'split' ? intent.size : freshIntent.size,
      notionalUsd: this.config.strategy.entryMode === 'split'
        ? Number((intent.size * freshIntent.price).toFixed(4))
        : freshIntent.notionalUsd,
      reason: `${intent.reason}|final-repriced:${freshIntent.reason}`,
      reward: freshIntent.reward
    };
  }

  private finalRepriceStrategy(intent: OrderIntent): StrategyEngine {
    if (this.config.strategy.entryMode !== 'split') return this.strategy;
    return new StrategyEngine({
      ...this.config,
      strategy: {
        ...this.config.strategy,
        entryMode: 'cash',
        quoteSide: intent.side === 'SELL' ? 'sell' : 'buy',
        inventorySkewEnabled: false
      }
    });
  }

  private rejectPlannedOrder(intent: OrderIntent, reason: string, details: unknown): void {
    this.store.markPlannedOrderRejected(intent.clientOrderId, reason, { intent, reject: details });
  }

  private recordSubmitBlocked(venue: VenueName, intent: OrderIntent, submitRisk: AccountRiskDecision): void {
    this.recorder.event({
      venue,
      severity: 'error',
      type: 'risk.submit-blocked',
      message: intent.clientOrderId,
      details: { ...submitRisk, reject: rejectReason(accountRiskReasonCode(submitRisk.reason), 'account', 'submitting') }
    });
  }

  private recordSubmitException(venue: VenueName, intent: OrderIntent, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const reject = rejectReason('SUBMIT_EXCEPTION', 'platform', 'submitting');
    const http = httpErrorDetails(error);
    this.store.markPlannedOrderUnknown(intent.clientOrderId, 'submit-exception', { intent, error: message, reject, ...http });
    this.recorder.event({
      venue,
      severity: 'error',
      type: 'order.submit-error',
      message: intent.clientOrderId,
      details: { error: message, intent, reject, ...http }
    });
  }

  private recordPreSubmitException(venue: VenueName, intent: OrderIntent, error: unknown, stage: string): void {
    const message = error instanceof Error ? error.message : String(error);
    const reject = rejectReason('SUBMIT_EXCEPTION', 'platform', stage);
    this.rejectPlannedOrder(intent, stage, reject);
    this.recorder.event({
      venue,
      severity: 'error',
      type: 'order.submit-error',
      message: intent.clientOrderId,
      details: { error: message, intent, reject }
    });
  }
}

function publicIntentPrice(intent: OrderIntent): Record<string, unknown> {
  return {
    tokenId: intent.tokenId,
    side: intent.side,
    price: intent.price,
    size: intent.size,
    notionalUsd: intent.notionalUsd,
    reason: intent.reason
  };
}

function freshOkAccountRiskDecision(config: AppConfig, decision: AccountRiskDecision | undefined): AccountRiskDecision | undefined {
  if (!decision?.ok || decision.capturedAt === undefined) return undefined;
  const ageMs = Date.now() - decision.capturedAt;
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > config.risk.maxAccountRiskStaleMs) return undefined;
  return decision;
}

function pendingOpenOrderFromSubmitted(venue: VenueName, submitted: PendingSubmittedOrder): OpenOrder {
  return {
    venue,
    externalId: submitted.externalId,
    tokenId: submitted.intent.tokenId,
    side: submitted.intent.side,
    price: submitted.intent.price,
    size: submitted.intent.size,
    status: 'PENDING_OPEN',
    raw: {
      submit: submitted.submitRaw,
      intent: publicIntentPrice(submitted.intent),
      pendingOpenConfirmation: true
    }
  };
}

function isSameOrder(order: OpenOrder, externalId: string | undefined): boolean {
  if (!externalId) return false;
  const ids = [order.externalId, ...alternateOrderIds(order.raw)].filter(Boolean);
  return ids.includes(externalId);
}

function verifySubmittedOrdersOnce(
  openOrders: OpenOrder[],
  submittedOrders: PendingSubmittedOrder[],
  attempts: number
): SubmittedOpenOrdersVerification {
  const verified: Array<{ submitted: PendingSubmittedOrder; order: OpenOrder }> = [];
  const missing: string[] = [];
  const mismatches: Array<{ externalId: string; reason: string; detail?: string; order?: OpenOrder }> = [];

  for (const submitted of submittedOrders) {
    const order = openOrders.find((candidate) => isSameOrder(candidate, submitted.externalId))
      ?? openOrders.find((candidate) => isSameOrderShape(candidate, submitted.intent));
    if (!order) {
      missing.push(submitted.externalId);
      continue;
    }
    const mismatch = submittedOrderMismatch(order, submitted.intent);
    if (mismatch) {
      mismatches.push({ externalId: submitted.externalId, ...mismatch, order });
      continue;
    }
    verified.push({ submitted, order });
  }

  if (verified.length === submittedOrders.length && missing.length === 0 && mismatches.length === 0) {
    return { ok: true, attempts, orders: verified };
  }
  return {
    ok: false,
    attempts,
    reason: missing.length > 0 ? 'not-found-in-open-orders' : 'order-mismatch',
    verified,
    missing,
    mismatches
  };
}

function submittedOrderMismatch(order: OpenOrder, intent: OrderIntent): { reason: string; detail: string } | undefined {
  const priceDelta = Math.abs(order.price - intent.price);
  if (priceDelta > PRICE_VERIFY_EPSILON) {
    return { reason: 'price-mismatch', detail: `expected ${intent.price}, platform ${order.price}` };
  }
  const sizeDelta = Math.abs(order.size - intent.size);
  const sizeTolerance = sizeVerifyTolerance(intent.size);
  if (sizeDelta > sizeTolerance) {
    return { reason: 'size-mismatch', detail: `expected ${intent.size}, platform ${order.size}, tolerance ${sizeTolerance}` };
  }
  if (order.side !== intent.side || order.tokenId !== intent.tokenId) {
    return { reason: 'identity-mismatch', detail: `expected ${intent.tokenId}:${intent.side}, platform ${order.tokenId}:${order.side}` };
  }
  return undefined;
}

function isSameOrderShape(order: OpenOrder, intent: OrderIntent): boolean {
  return order.tokenId === intent.tokenId
    && order.side === intent.side
    && Math.abs(order.price - intent.price) <= PRICE_VERIFY_EPSILON
    && Math.abs(order.size - intent.size) <= sizeVerifyTolerance(intent.size);
}

function sizeVerifyTolerance(size: number): number {
  return Math.max(MIN_SIZE_VERIFY_EPSILON, Math.abs(size) * SIZE_VERIFY_RELATIVE_EPSILON);
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

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
