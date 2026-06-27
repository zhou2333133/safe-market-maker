import type { AppConfig } from '../config/schema.js';
import type { Balance, OpenOrder, OrderIntent, Orderbook, Position, VenueName } from '../domain/types.js';
import { logger } from '../observability/logger.js';
import { evaluateOrderCapital } from '../risk/capital-risk.js';
import { evaluateMarketGuard } from '../risk/market-guard.js';
import { marketGuardReasonCode, rejectReason, riskEngineReasonCode } from '../risk/reject-reasons.js';
import { RiskEngine } from '../risk/risk-engine.js';
import type { StateStore } from '../store/sqlite.js';
import { isPairedEntryMode } from '../strategy/paired-inventory.js';
import { ExecutionRecorder } from './event-recorder.js';
import { isTokenInExitLiquidityCooldown } from './cancel-service.js';

export type OrderGateResult =
  | { status: 'ready' }
  | { status: 'skipped-existing'; existingOrder: OpenOrder; managed: boolean }
  | {
      status: 'rejected';
      balanceSkipped: boolean;
    };

export interface OrderGateInput {
  venue: VenueName;
  intent: OrderIntent;
  book: Orderbook;
  balances: Balance[];
  positions: Position[];
  openOrders: OpenOrder[];
  remainingBalanceUsd: number;
}

export class OrderGateService {
  private readonly risk: RiskEngine;
  private readonly recorder: ExecutionRecorder;

  constructor(
    private readonly config: AppConfig,
    private readonly store: StateStore
  ) {
    this.risk = new RiskEngine(config);
    this.recorder = new ExecutionRecorder(store);
  }

  evaluate(input: OrderGateInput): OrderGateResult {
    // Exit-liquidity cooldown: reject intents for tokens currently in cooldown
    if (isTokenInExitLiquidityCooldown(this.config, input.venue, input.intent.tokenId, this.store)) {
      return { status: 'rejected', balanceSkipped: false };
    }
    const duplicateOpen = input.openOrders.find((order) =>
      order.status === 'OPEN' && order.tokenId === input.intent.tokenId && order.side === input.intent.side
    );
    if (duplicateOpen) {
      const managedIds = new Set(this.store.listManagedOpenOrders(input.venue).map((order) => order.externalId).filter(Boolean));
      const adopted = this.maybeAdoptDuplicateOpen(input, duplicateOpen, managedIds.has(duplicateOpen.externalId));
      const managed = adopted || managedIds.has(duplicateOpen.externalId);
      this.recorder.event({
        venue: input.venue,
        severity: 'info',
        type: 'quote.skip-existing',
        message: input.intent.clientOrderId,
        details: { intent: input.intent, existingOrder: duplicateOpen.externalId, managed, adopted }
      });
      logger.info('Skipped quote because an open order already exists on token side', {
        tokenId: input.intent.tokenId,
        side: input.intent.side,
        existingOrder: duplicateOpen.externalId,
        managed,
        adopted
      });
      return { status: 'skipped-existing', existingOrder: duplicateOpen, managed };
    }

    const marketLimit = this.evaluateMaxMarkets(input);
    if (!marketLimit.ok) {
      const reject = rejectReason('MAX_MARKETS_LIMIT', 'risk', 'checking-risk');
      this.recorder.event({
        venue: input.venue,
        severity: 'warn',
        type: 'risk.reject',
        message: input.intent.clientOrderId,
        details: {
          ok: false,
          reasons: [marketLimit.reason],
          activeTokenIds: marketLimit.activeTokenIds,
          maxMarkets: marketLimit.maxMarkets,
          intent: input.intent,
          reject
        }
      });
      logger.warn('Risk rejected order intent because maxMarkets is already occupied', {
        tokenId: input.intent.tokenId,
        side: input.intent.side,
        activeTokenIds: marketLimit.activeTokenIds,
        maxMarkets: marketLimit.maxMarkets
      });
      return { status: 'rejected', balanceSkipped: false };
    }

    const initialGuard = evaluateMarketGuard(this.config, input.intent.market, input.book);
    if (!initialGuard.ok) {
      this.recorder.event({
        venue: input.venue,
        severity: 'warn',
        type: 'risk.market-guard.reject',
        message: input.intent.clientOrderId,
        details: {
          guard: initialGuard,
          intent: input.intent,
          reject: rejectReason(marketGuardReasonCode(initialGuard.reason), 'market', 'checking-risk')
        }
      });
      return { status: 'rejected', balanceSkipped: false };
    }

    const capitalDecision = evaluateOrderCapital(
      this.config,
      input.intent,
      input.balances,
      input.openOrders,
      input.positions,
      input.remainingBalanceUsd
    );
    if (!capitalDecision.ok) {
      const isBalanceReject = capitalDecision.reason === 'balance-insufficient' || capitalDecision.reason === 'balance-unavailable';
      this.recorder.event({
        venue: input.venue,
        severity: 'warn',
        type: capitalDecision.reason === 'inventory-insufficient' ? 'risk.inventory-skip' : 'risk.balance-skip',
        message: input.intent.clientOrderId,
        details: {
          intent: input.intent,
          remainingBalanceUsd: input.remainingBalanceUsd,
          capital: capitalDecision,
          reject: rejectReason(capitalRejectCode(capitalDecision.reason), capitalDecision.reason === 'inventory-insufficient' ? 'risk' : 'balance', 'checking-risk')
        }
      });
      return { status: 'rejected', balanceSkipped: isBalanceReject };
    }

    this.recorder.stage(input.venue, 'checking-risk', '执行订单级风控');
    const decision = this.risk.evaluate(input.intent, input.book, input.positions, input.openOrders, {
      skipStaleBookCheck: isPredictCashRewardMaker(input.venue, this.config, input.intent)
    });
    if (!decision.ok) {
      this.recorder.event({
        venue: input.venue,
        severity: 'warn',
        type: 'risk.reject',
        message: input.intent.clientOrderId,
        details: { ...decision, reject: rejectReason(riskEngineReasonCode(decision.reasons), 'risk', 'checking-risk') }
      });
      logger.warn('Risk rejected order intent', { intent: input.intent, reasons: decision.reasons });
      return { status: 'rejected', balanceSkipped: false };
    }

    return { status: 'ready' };
  }

  private evaluateMaxMarkets(input: OrderGateInput):
    | { ok: true }
    | { ok: false; activeTokenIds: string[]; maxMarkets: number; reason: string } {
    // Only Predict cash mode enforces a hard maxMarkets gate at the order level.
    // Polymarket unreserved maker relies on scoring-based market selection in limitByMarketGroup
    // to naturally constrain the number of active markets — no separate gate needed.
    if (!isPredictCashMode(input.venue, this.config)) return { ok: true };
    const maxMarkets = Math.max(1, this.config.risk.maxMarkets);
    const activeTokenIds = new Set<string>();
    for (const order of [...input.openOrders, ...this.store.listOpenOrders(input.venue)]) {
      if (!isActiveOpenOrder(order)) continue;
      if (!order.tokenId || order.tokenId === input.intent.tokenId) continue;
      activeTokenIds.add(order.tokenId);
    }
    if (activeTokenIds.size < maxMarkets) return { ok: true };
    return {
      ok: false,
      activeTokenIds: [...activeTokenIds],
      maxMarkets,
      reason: `maxMarkets ${maxMarkets} already occupied by active tokens: ${[...activeTokenIds].join(', ')}`
    };
  }

  private maybeAdoptDuplicateOpen(input: OrderGateInput, order: OpenOrder, alreadyManaged: boolean): boolean {
    if (alreadyManaged) return false;
    if (!isPredictCashMode(input.venue, this.config)) return false;
    if (!order.externalId || order.status !== 'OPEN') return false;
    if (!isSameOrderShape(order, input.intent)) return false;
    const clientOrderId = `adopted-${input.venue}-${order.externalId}`;
    this.store.recordPlannedOrder({
      ...input.intent,
      clientOrderId,
      reason: `${input.intent.reason}|adopt-existing-open-order`
    }, 'live');
    this.store.recordOrderResult({
      venue: input.venue,
      clientOrderId,
      externalId: order.externalId,
      status: 'OPEN',
      raw: {
        adoptedExistingOpenOrder: true,
        existingOrder: order.raw ?? {
          externalId: order.externalId,
          tokenId: order.tokenId,
          side: order.side,
          price: order.price,
          size: order.size,
          status: order.status
        }
      }
    });
    this.recorder.event({
      venue: input.venue,
      severity: 'info',
      type: 'quote.adopt-existing',
      message: order.externalId,
      details: {
        tokenId: order.tokenId,
        side: order.side,
        price: order.price,
        size: order.size,
        clientOrderId
      }
    });
    return true;
  }
}

function isPredictCashMode(venue: VenueName, config: AppConfig): boolean {
  return venue === 'predict' && !isPairedEntryMode(config);
}

function isPredictCashRewardMaker(venue: VenueName, config: AppConfig, intent: OrderIntent): boolean {
  return isPredictCashMode(venue, config)
    && Boolean(intent.reward)
    && intent.postOnly
    && intent.liquidity === 'maker';
}

function capitalRejectCode(reason: ReturnType<typeof evaluateOrderCapital>['reason']): string {
  if (reason === 'balance-unavailable') return 'BALANCE_UNAVAILABLE';
  if (reason === 'balance-insufficient') return 'BALANCE_INSUFFICIENT';
  if (reason === 'reserve-drift') return 'RESERVE_DRIFT_TOO_LARGE';
  if (reason === 'inventory-insufficient') return 'INVENTORY_INSUFFICIENT';
  return 'CAPITAL_RISK_REJECT';
}

function isActiveOpenOrder(order: OpenOrder): boolean {
  return order.status === 'OPEN' || order.status === 'PENDING_OPEN' || order.status === 'PLANNED';
}

function isSameOrderShape(order: OpenOrder, intent: OrderIntent): boolean {
  return order.tokenId === intent.tokenId
    && order.side === intent.side
    && Math.abs(order.price - intent.price) <= 0.000001
    && Math.abs(order.size - intent.size) <= sizeTolerance(intent.size);
}

function sizeTolerance(size: number): number {
  return Math.max(0.001, Math.abs(size) * 0.0001);
}
