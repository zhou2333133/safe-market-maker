import type { AppConfig } from '../config/schema.js';
import type { OpenOrder, OrderIntent, Orderbook, Position } from '../domain/types.js';
import { evaluateMarketGuard, type MarketGuardDecision } from '../risk/market-guard.js';
import { marketGuardReasonCode, rejectReason, riskEngineReasonCode, type StructuredRejectReason } from '../risk/reject-reasons.js';
import { RiskEngine, type RiskDecision } from '../risk/risk-engine.js';

export type SubmitGuardDecision =
  | {
      ok: true;
      freshBook: Orderbook;
    }
  | {
      ok: false;
      reason: 'market-guard' | 'risk';
      freshBook: Orderbook;
      message: string;
      stage: string;
      reject: StructuredRejectReason;
      guard?: MarketGuardDecision;
      decision?: RiskDecision;
    };

export interface SubmitGuardInput {
  config: AppConfig;
  intent: OrderIntent;
  initialBook: Orderbook;
  freshBook: Orderbook;
  positions: Position[];
  openOrders: OpenOrder[];
  stage?: string;
}

export function evaluateSubmitGuard(input: SubmitGuardInput): SubmitGuardDecision {
  const stage = input.stage ?? 'final-orderbook-check';
  const guard = evaluateMarketGuard(input.config, input.intent.market, input.freshBook, { previousBook: input.initialBook });
  if (!guard.ok) {
    return {
      ok: false,
      reason: 'market-guard',
      freshBook: input.freshBook,
      message: guard.message,
      stage,
      guard,
      reject: rejectReason(marketGuardReasonCode(guard.reason), 'market', stage)
    };
  }
  const decision = new RiskEngine(input.config).evaluate(input.intent, input.freshBook, input.positions, input.openOrders);
  if (!decision.ok) {
    return {
      ok: false,
      reason: 'risk',
      freshBook: input.freshBook,
      message: decision.reasons.join('; ') || '最终风险复检拒绝',
      stage,
      decision,
      reject: rejectReason(riskEngineReasonCode(decision.reasons), 'risk', stage)
    };
  }
  return { ok: true, freshBook: input.freshBook };
}
