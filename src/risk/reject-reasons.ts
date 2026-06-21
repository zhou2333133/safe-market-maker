import type { AccountRiskDecision } from '../domain/types.js';
import type { MarketGuardReason } from './market-guard.js';

export type RejectCategory = 'config' | 'account' | 'market' | 'orderbook' | 'balance' | 'platform' | 'risk' | 'liquidation' | 'split-entry';

export interface StructuredRejectReason {
  reason_code: string;
  category: RejectCategory;
  stage: string;
}

export function rejectReason(reason_code: string, category: RejectCategory, stage: string): StructuredRejectReason {
  return { reason_code, category, stage };
}

export function marketGuardReasonCode(reason: MarketGuardReason): string {
  return `MARKET_${reason.replace(/-/g, '_').toUpperCase()}`;
}

export function accountRiskReasonCode(reason: AccountRiskDecision['reason']): string {
  return `ACCOUNT_${reason.replace(/-/g, '_').toUpperCase()}`;
}

export function riskEngineReasonCode(reasons: string[]): string {
  const text = reasons.join(' ').toLowerCase();
  if (text.includes('stale orderbook')) return 'STALE_ORDERBOOK';
  if (text.includes('cross')) return 'WOULD_CROSS_BBO';
  if (text.includes('post-only')) return 'POST_ONLY_REQUIRED';
  if (text.includes('reward band')) return 'OUTSIDE_REWARD_BAND';
  if (text.includes('depth too low')) return 'DEPTH_TOO_LOW';
  if (text.includes('position exposure')) return 'POSITION_EXPOSURE_LIMIT';
  if (text.includes('open order count')) return 'OPEN_ORDER_LIMIT';
  if (text.includes('spread too tight')) return 'SPREAD_TOO_TIGHT';
  if (text.includes('spread too wide')) return 'SPREAD_TOO_WIDE';
  if (text.includes('split order notional')) return 'SPLIT_ORDER_SIZE_LIMIT';
  if (text.includes('single order notional')) return 'SINGLE_ORDER_LIMIT';
  return 'RISK_ENGINE_REJECT';
}
