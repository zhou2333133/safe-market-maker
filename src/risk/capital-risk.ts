import type { AppConfig } from '../config/schema.js';
import type { Balance, OpenOrder, OrderIntent, Position } from '../domain/types.js';
import { isPairedEntryMode } from '../strategy/paired-inventory.js';

const STABLE_ASSETS = new Set(['USDT', 'USDC', 'PUSD', 'USD']);
const EPSILON = 1e-9;

export interface CapitalUsage {
  asset: string;
  availableUsd: number;
  totalUsd: number;
  reserveUsd: number;
  reservedOpenOrdersUsd: number;
  spendableUsd: number;
  actualFrozenUsd?: number;
  reserveDriftUsd?: number;
  reserveDriftPct?: number;
  driftOk: boolean;
  driftMessage: string;
}

export interface OrderCapitalDecision {
  ok: boolean;
  reason?: 'balance-unavailable' | 'balance-insufficient' | 'reserve-drift' | 'inventory-insufficient';
  message: string;
  usage: CapitalUsage;
}

export function primaryStableBalance(balances: Balance[]): Balance | undefined {
  return balances.find((balance) => STABLE_ASSETS.has(balance.asset.toUpperCase()));
}

export function estimateReservedOpenOrdersUsd(openOrders: OpenOrder[]): number {
  return roundUsd(openOrders
    .filter((order) => order.side === 'BUY')
    .reduce((sum, order) => sum + Math.abs(order.price * order.size), 0));
}

export function capitalUsage(config: AppConfig, balances: Balance[], openOrders: OpenOrder[]): CapitalUsage {
  const primary = primaryStableBalance(balances);
  const availableUsd = roundUsd(primary?.available ?? 0);
  const totalUsd = roundUsd(primary?.total ?? availableUsd);
  const reserveUsd = roundUsd(config.strategy.balanceReserveUsd ?? 0);
  const reservedOpenOrdersUsd = estimateReservedOpenOrdersUsd(openOrders);
  const actualFrozenUsd = totalUsd > availableUsd + EPSILON ? roundUsd(totalUsd - availableUsd) : undefined;
  const drift = reserveDrift(config, reservedOpenOrdersUsd, actualFrozenUsd);
  const estimatedReservationDeduction = actualFrozenUsd === undefined ? reservedOpenOrdersUsd : 0;
  return {
    asset: primary?.asset ?? 'USD',
    availableUsd,
    totalUsd,
    reserveUsd,
    reservedOpenOrdersUsd,
    spendableUsd: roundUsd(Math.max(0, availableUsd - reserveUsd - estimatedReservationDeduction)),
    ...(actualFrozenUsd !== undefined ? { actualFrozenUsd } : {}),
    ...(drift.reserveDriftUsd !== undefined ? { reserveDriftUsd: drift.reserveDriftUsd } : {}),
    ...(drift.reserveDriftPct !== undefined ? { reserveDriftPct: drift.reserveDriftPct } : {}),
    driftOk: drift.ok,
    driftMessage: drift.message
  };
}

export function evaluateOrderCapital(
  config: AppConfig,
  intent: OrderIntent,
  balances: Balance[],
  openOrders: OpenOrder[],
  positions: Position[],
  remainingSpendableUsd?: number
): OrderCapitalDecision {
  const usage = capitalUsage(config, balances, openOrders);
  if (!usage.driftOk) {
    return {
      ok: false,
      reason: 'reserve-drift',
      message: usage.driftMessage,
      usage
    };
  }
  if (intent.side === 'BUY') {
    if (!primaryStableBalance(balances)) {
      return {
        ok: false,
        reason: 'balance-unavailable',
        message: '没有可验证的 USDT/USDC/pUSD/USD 余额，禁止 BUY 挂单',
        usage
      };
    }
    if (isUnreservedPredictCashMakerBuy(config, intent)) {
      return { ok: true, message: 'Predict cash maker BUY 按平台非冻结挂单处理；仅校验余额可读，容量由 maxMarkets 控制', usage };
    }
    const spendable = remainingSpendableUsd ?? usage.spendableUsd;
    if (intent.notionalUsd > spendable + EPSILON) {
      return {
        ok: false,
        reason: 'balance-insufficient',
        message: `可用资金 ${fmt(spendable)} 小于订单金额 ${fmt(intent.notionalUsd)}`,
        usage
      };
    }
  }
  if (intent.side === 'SELL') {
    const heldShares = positions
      .filter((position) => position.tokenId === intent.tokenId)
      .reduce((sum, position) => sum + Math.max(0, position.size), 0);
    if (heldShares + EPSILON < intent.size) {
      return {
        ok: false,
        reason: 'inventory-insufficient',
        message: `可卖库存 ${heldShares.toFixed(4)} 小于 SELL 数量 ${intent.size.toFixed(4)}`,
        usage
      };
    }
  }
  return { ok: true, message: '资金和库存风控通过', usage };
}

/**
 * Replace-race guard for balance-constrained wallets.
 *
 * Polymarket checks, per collateral group, that (sum of resting orders on that group + the new order) <= wallet
 * balance. When we refresh/replace a resting BUY we cancel the old order and immediately submit the new one, but the
 * venue may still be counting the just-cancelled order until the cancel settles. On a wallet too small to hold the
 * old AND the new at once (available < ~2x the order notional), that momentary overlap trips a "not enough balance /
 * allowance" reject — the new order is bounced and the slot churns. (Observed: old $80 + new $80 = $160 > $94 balance.)
 *
 * Fix: for tokens we just cancelled this cycle, only re-place now if the wallet can clearly hold both the old and the
 * new (available >= 2x notional). Otherwise defer the re-place one cycle — by the next cycle the cancel has settled
 * and the collateral slot is free, so the replacement lands cleanly with no reject. Well-funded wallets (>= 2x) are
 * unaffected and re-place immediately. Only BUY intents are gated (SELL exits must not be deferred).
 */
export function planReplaceRaceDefer(
  intents: OrderIntent[],
  canceledTokenIds: string[],
  availableUsd: number
): { placeable: OrderIntent[]; deferredTokenIds: string[] } {
  if (canceledTokenIds.length === 0) return { placeable: intents, deferredTokenIds: [] };
  const justCanceled = new Set(canceledTokenIds);
  const deferredTokenIds: string[] = [];
  const placeable = intents.filter((intent) => {
    if (intent.side !== 'BUY' || !justCanceled.has(intent.tokenId)) return true;
    const notional = Number.isFinite(intent.notionalUsd) ? intent.notionalUsd : intent.price * intent.size;
    if (availableUsd + EPSILON >= notional * 2) return true;
    deferredTokenIds.push(intent.tokenId);
    return false;
  });
  return { placeable, deferredTokenIds };
}

export function isUnreservedPredictCashMakerBuy(config: AppConfig, intent: OrderIntent): boolean {
  // Predict cash maker BUYs are always unreserved (platform doesn't freeze resting buys). Polymarket is unreserved
  // ONLY when polymarketUnreservedMaker is explicitly enabled (the over-rest farming model — see schema note).
  const venueUnreserved = intent.venue === 'predict'
    || (intent.venue === 'polymarket' && config.strategy.polymarketUnreservedMaker === true);
  return venueUnreserved
    && config.strategy.entryMode === 'cash'
    && !isPairedEntryMode(config)
    && intent.side === 'BUY'
    && intent.postOnly
    && intent.liquidity !== 'taker';
}

function reserveDrift(
  config: AppConfig,
  reservedOpenOrdersUsd: number,
  actualFrozenUsd: number | undefined
): { ok: boolean; message: string; reserveDriftUsd?: number; reserveDriftPct?: number } {
  if (actualFrozenUsd === undefined) {
    return { ok: true, message: '平台未暴露独立冻结余额，开放订单占用按估算处理' };
  }
  const driftUsd = roundUsd(Math.abs(actualFrozenUsd - reservedOpenOrdersUsd));
  const denominator = Math.max(reservedOpenOrdersUsd, actualFrozenUsd, 1);
  const driftPct = Number(((driftUsd / denominator) * 100).toFixed(4));
  const maxDriftUsd = config.risk.maxOpenOrderReserveDriftUsd;
  const maxDriftPct = config.risk.maxOpenOrderReserveDriftPct;
  const ok = driftUsd <= maxDriftUsd || driftPct <= maxDriftPct;
  return {
    ok,
    message: ok
      ? `开放订单估算占用与平台冻结余额偏差 ${fmt(driftUsd)} / ${driftPct.toFixed(2)}%，在允许范围内`
      : `开放订单估算占用 ${fmt(reservedOpenOrdersUsd)} 与平台冻结余额 ${fmt(actualFrozenUsd)} 偏差过大，禁止继续加单`,
    reserveDriftUsd: driftUsd,
    reserveDriftPct: driftPct
  };
}

function roundUsd(value: number): number {
  return Number((Number.isFinite(value) ? value : 0).toFixed(4));
}

function fmt(value: number): string {
  return `$${roundUsd(value).toFixed(2)}`;
}
