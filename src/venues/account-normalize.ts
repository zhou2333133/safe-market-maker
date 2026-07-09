import type { AccountFill, Balance, OpenOrder, Position } from '../domain/types.js';
import { normalizePredictMarket, toFiniteNumber, toOptionalFiniteNumber } from './normalize.js';

export function normalizePredictPosition(item: any): Position | undefined {
  const tokenId = String(item?.outcome?.onChainId ?? item?.token_id ?? item?.tokenId ?? '');
  if (!tokenId) return undefined;
  const averagePrice = toOptionalFiniteNumber(item?.averageBuyPriceUsd, item?.averagePrice, item?.avgPrice);
  const outcomeCount = Array.isArray(item?.market?.outcomes) ? item.market.outcomes.length : undefined;
  const positionMarket = normalizePredictPositionMarket(item, tokenId);
  return {
    venue: 'predict',
    tokenId,
    marketId: item?.market?.id !== undefined ? String(item.market.id) : item?.market_id ? String(item.market_id) : item?.marketId ? String(item.marketId) : undefined,
    conditionId: positionConditionId(item),
    outcome: positionOutcomeName(item),
    ...(outcomeCount !== undefined ? { outcomeCount } : {}),
    ...(positionMarket ? { market: positionMarket } : {}),
    size: predictNumber(item?.amount, item?.shares, item?.size) ?? 0,
    notionalUsd: toFiniteNumber(item?.valueUsd, item?.notionalUsd, item?.value, item?.usdValue),
    ...(averagePrice !== undefined ? { averagePrice } : {})
  };
}

export function normalizePredictOpenOrder(raw: any): OpenOrder | undefined {
  const order = raw?.order ?? raw;
  const side = parseOrderSide(order?.side ?? raw?.side);
  const externalId = firstNonEmptyString(
    raw?.id,
    raw?.orderId,
    raw?.order_id,
    order?.id,
    order?.orderId,
    order?.order_id,
    order?.hash,
    order?.order_hash,
    raw?.orderHash,
    raw?.order_hash
  );
  const tokenId = String(order?.tokenId ?? order?.token_id ?? raw?.token_id ?? '');
  if (!externalId || !tokenId || !side) return undefined;
  const originalSize = predictOrderShares(raw, order, side);
  const filledSize = predictNumber(raw?.amountFilled, raw?.amount_filled, raw?.filledAmount, raw?.filled_amount) ?? 0;
  const remainingSize = originalSize !== undefined
    ? Math.max(0, originalSize - filledSize)
    : predictNumber(raw?.shares, order?.shares);
  const price = predictNumber(raw?.pricePerShare, raw?.price_per_share, raw?.price, order?.pricePerShare, order?.price_per_share, order?.price)
    ?? predictOrderPrice(order, side);
  return {
    venue: 'predict',
    externalId,
    tokenId,
    side,
    price: price ?? 0,
    size: Number((remainingSize ?? 0).toFixed(4)),
    status: 'OPEN',
    raw
  };
}

function predictOrderShares(raw: any, order: any, side: 'BUY' | 'SELL'): number | undefined {
  const explicitShares = predictNumber(raw?.shares, order?.shares);
  if (explicitShares !== undefined) return explicitShares;
  const amount = predictNumber(raw?.amount);
  if (amount !== undefined) return amount;
  return side === 'BUY'
    ? predictNumber(order?.takerAmount, order?.taker_amount)
    : predictNumber(order?.makerAmount, order?.maker_amount);
}

function predictOrderPrice(order: any, side: 'BUY' | 'SELL'): number | undefined {
  const makerAmount = predictNumber(order?.makerAmount, order?.maker_amount);
  const takerAmount = predictNumber(order?.takerAmount, order?.taker_amount);
  if (!makerAmount || !takerAmount) return undefined;
  const price = side === 'BUY' ? makerAmount / takerAmount : takerAmount / makerAmount;
  return Number.isFinite(price) ? Number(price.toFixed(6)) : undefined;
}

function predictNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    if (typeof value === 'string') {
      const cleaned = value.replace(/,/g, '').trim();
      if (!cleaned) continue;
      if (/^-?\d+$/.test(cleaned) && cleaned.replace(/^-/, '').length > 12) {
        const parsedWei = weiStringToNumber(cleaned);
        if (parsedWei !== undefined) return parsedWei;
      }
      const parsed = Number(cleaned);
      if (Number.isFinite(parsed)) return parsed;
      continue;
    }
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function positionOutcomeName(item: any): string | undefined {
  if (item?.outcome && typeof item.outcome === 'object') {
    const value = item.outcome.name ?? item.outcome.outcome ?? item.outcome.name_zh ?? item.outcome.nameZh;
    return value !== undefined ? String(value) : undefined;
  }
  return item?.outcome ? String(item.outcome) : undefined;
}

function positionConditionId(item: any): string | undefined {
  const value = item?.market?.conditionId
    ?? item?.market?.condition_id
    ?? item?.conditionId
    ?? item?.condition_id;
  return value !== undefined && value !== null && String(value).trim() ? String(value) : undefined;
}

function normalizePredictPositionMarket(item: any, tokenId: string): Position['market'] {
  if (!item?.market || typeof item.market !== 'object') return undefined;
  return normalizePredictMarket(item.market).find((market) => market.tokenId === tokenId);
}

function weiStringToNumber(value: string, decimals = 18): number | undefined {
  try {
    const negative = value.startsWith('-');
    const digits = negative ? value.slice(1) : value;
    const padded = digits.padStart(decimals + 1, '0');
    const whole = padded.slice(0, -decimals) || '0';
    const fraction = padded.slice(-decimals).replace(/0+$/, '');
    const parsed = Number(`${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`);
    return Number.isFinite(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function firstNonEmptyString(...values: unknown[]): string {
  for (const value of values) {
    if (value === null || value === undefined) continue;
    const text = String(value);
    if (text.trim()) return text;
  }
  return '';
}

function parseOrderSide(value: unknown): 'BUY' | 'SELL' | undefined {
  if (value === 0) return 'BUY';
  if (value === 1) return 'SELL';
  if (typeof value === 'string') {
    const normalized = value.trim().toUpperCase();
    if (normalized === 'BUY' || normalized === '0') return 'BUY';
    if (normalized === 'SELL' || normalized === '1') return 'SELL';
  }
  return undefined;
}

export function isPredictFillActivity(raw: any): boolean {
  const type = String(raw?.type ?? raw?.activityType ?? raw?.eventType ?? raw?.kind ?? raw?.name ?? '').toLowerCase();
  const status = String(raw?.status ?? raw?.order?.status ?? '').toLowerCase();
  return ['match', 'matched', 'fill', 'filled', 'trade', 'order_match'].some((item) => type.includes(item))
    || status === 'filled'
    || raw?.match !== undefined
    || raw?.trade !== undefined;
}

export function normalizePredictFill(raw: any, index: number): AccountFill {
  const order = raw?.order ?? raw?.match?.order ?? raw?.trade?.order ?? raw;
  const side = predictFillSide(raw, order);
  const price = predictNumber(raw?.priceExecuted, raw?.pricePerShare, raw?.price, raw?.match?.price, raw?.trade?.price, order?.price);
  const size = predictNumber(raw?.amountFilled, raw?.shares, raw?.size, raw?.amount, raw?.match?.shares, raw?.trade?.size, order?.shares, order?.amount);
  const notional = toOptionalFiniteNumber(raw?.notionalUsd, raw?.valueUsd, raw?.cashAmount, raw?.usdValue);
  const notionalUsd = notional ?? (price !== undefined && size !== undefined ? Number((price * size).toFixed(4)) : 0);
  const realized = toOptionalFiniteNumber(raw?.realizedPnlUsd, raw?.realizedPnl, raw?.pnlUsd, raw?.profitUsd);
  const fee = predictFillFeeUsd(raw, order, price);
  const cashflow = toOptionalFiniteNumber(raw?.cashflowUsd, raw?.netCashflowUsd)
    ?? (side ? Number(((side === 'SELL' ? notionalUsd : -notionalUsd) - (fee ?? 0)).toFixed(4)) : undefined);
  const ts = parseTs(raw?.createdAt, raw?.created_at, raw?.timestamp, raw?.time);
  const orderId = raw?.orderHash || raw?.order_hash || order?.hash ? String(raw?.orderHash ?? raw?.order_hash ?? order?.hash) : undefined;
  const tokenId = raw?.tokenId || raw?.token_id || raw?.outcome?.onChainId || order?.tokenId ? String(raw?.tokenId ?? raw?.token_id ?? raw?.outcome?.onChainId ?? order?.tokenId) : undefined;
  const marketId = raw?.marketId || raw?.market_id || raw?.market?.id ? String(raw?.marketId ?? raw?.market_id ?? raw?.market?.id) : undefined;
  const transactionHash = firstNonEmptyString(raw?.transactionHash, raw?.transaction_hash);
  return {
    venue: 'predict',
    id: String(raw?.id ?? raw?.hash ?? raw?.matchId ?? raw?.match_id ?? raw?.tradeId ?? raw?.trade_id ?? stableFillId('predict', {
      orderId: orderId ?? transactionHash,
      tokenId,
      marketId,
      side,
      price,
      size,
      notionalUsd,
      ts
    }, index)),
    orderId,
    tokenId,
    marketId,
    side,
    price,
    size,
    notionalUsd,
    feeUsd: fee,
    realizedPnlUsd: realized,
    cashflowUsd: cashflow,
    ts,
    raw
  };
}

function predictFillSide(raw: any, order: any): 'BUY' | 'SELL' | undefined {
  const explicit = parseOrderSide(raw?.side ?? order?.side ?? raw?.direction);
  if (explicit) return explicit;
  const quoteType = order?.quoteType ?? raw?.quoteType;
  if (quoteType === true) return 'SELL';
  if (quoteType === false) return 'BUY';
  const normalized = String(quoteType ?? '').trim().toUpperCase();
  if (normalized === 'ASK') return 'SELL';
  if (normalized === 'BID') return 'BUY';
  return undefined;
}

function predictFillFeeUsd(raw: any, order: any, price: number | undefined): number | undefined {
  const explicit = predictNumber(raw?.feeUsd, raw?.feesUsd);
  if (explicit !== undefined) return explicit;
  const fee = order?.fee ?? raw?.fee;
  if (fee === null || fee === undefined) return undefined;
  if (typeof fee !== 'object') return predictNumber(fee);
  const amount = predictNumber(fee.amount, fee.value);
  if (amount === undefined) return undefined;
  const type = String(fee.type ?? '').trim().toUpperCase();
  if (type === 'SHARES') {
    return price !== undefined ? Number((amount * price).toFixed(6)) : undefined;
  }
  return amount;
}

export function normalizePolymarketPosition(item: any): Position | undefined {
  const tokenId = String(item?.asset ?? item?.assetId ?? item?.tokenId ?? item?.token_id ?? '');
  if (!tokenId) return undefined;
  const averagePrice = toOptionalFiniteNumber(item?.avgPrice, item?.averagePrice);
  return {
    venue: 'polymarket',
    tokenId,
    marketId: item?.conditionId !== undefined ? String(item.conditionId) : item?.market ? String(item.market) : undefined,
    outcome: item?.outcome ? String(item.outcome) : undefined,
    size: toFiniteNumber(item?.size, item?.quantity, item?.shares),
    notionalUsd: toFiniteNumber(item?.currentValue, item?.value, item?.notional, item?.cashPnl),
    ...(averagePrice !== undefined ? { averagePrice } : {})
  };
}

export function normalizePolymarketOpenOrder(order: any): OpenOrder | undefined {
  const externalId = String(order?.orderID ?? order?.orderId ?? order?.id ?? '');
  const tokenId = String(order?.asset_id ?? order?.tokenId ?? order?.token_id ?? '');
  const side = parseOrderSide(order?.side);
  if (!externalId || !tokenId || !side) return undefined;
  const originalSize = toOptionalFiniteNumber(order?.original_size, order?.originalSize);
  const matchedSize = toOptionalFiniteNumber(order?.size_matched, order?.sizeMatched, order?.matched);
  const rawRemaining = toOptionalFiniteNumber(order?.size, order?.remaining_size, order?.remainingSize);
  let size: number | undefined = rawRemaining;
  if (size === undefined) {
    if (originalSize !== undefined) {
      size = Math.max(0, originalSize - (matchedSize ?? 0));
    } else {
      // Size unknown (no remaining/original/matched reported): do NOT synthesize a 0-sized OPEN order,
      // which the protection logic would treat as a real resting position. Skip this order instead.
      return undefined;
    }
  }
  return {
    venue: 'polymarket',
    externalId,
    tokenId,
    side,
    price: toFiniteNumber(order?.price),
    size: Number(size.toFixed(4)),
    status: 'OPEN',
    raw: order
  };
}

export function normalizePolymarketCollateralBalance(response: any): Balance[] {
  const roots = [
    response,
    response?.data,
    response?.balanceAllowance,
    response?.balance_allowance,
    response?.collateral
  ].filter((item) => item && typeof item === 'object');
  for (const root of roots) {
    const available = toOptionalFiniteNumber(
      root.available,
      root.availableBalance,
      root.available_balance,
      root.free,
      root.freeBalance,
      root.free_balance,
      root.usdcAvailable,
      root.usdc_available
    );
    const total = toOptionalFiniteNumber(
      root.total,
      root.totalBalance,
      root.total_balance,
      root.balance,
      root.collateral,
      root.usdc,
      root.cash
    );
    const locked = toOptionalFiniteNumber(
      root.locked,
      root.lockedBalance,
      root.locked_balance,
      root.frozen,
      root.frozenBalance,
      root.frozen_balance,
      root.used,
      root.usedBalance,
      root.used_balance
    );
    const normalizedTotal = total ?? (available !== undefined && locked !== undefined ? Number((available + locked).toFixed(4)) : undefined);
    if (available === undefined && normalizedTotal === undefined) continue;
    return [{
      asset: 'pUSD',
      available: available ?? normalizedTotal ?? 0,
      total: normalizedTotal ?? available ?? 0
    }];
  }
  return [];
}

export function normalizePolymarketFill(raw: any, index: number): AccountFill {
  const sideText = String(raw?.side ?? raw?.takerSide ?? raw?.makerSide ?? '').toUpperCase();
  const side = sideText === 'SELL' ? 'SELL' : sideText === 'BUY' ? 'BUY' : undefined;
  const price = toOptionalFiniteNumber(raw?.price);
  const size = toOptionalFiniteNumber(raw?.size, raw?.amount, raw?.shares);
  const notional = toOptionalFiniteNumber(raw?.notional, raw?.notionalUsd, raw?.value);
  const notionalUsd = notional ?? (price !== undefined && size !== undefined ? Number((price * size).toFixed(4)) : 0);
  const fee = toOptionalFiniteNumber(raw?.fee, raw?.feeUsd);
  const realized = toOptionalFiniteNumber(raw?.realizedPnl, raw?.realizedPnlUsd, raw?.pnl);
  const cashflow = toOptionalFiniteNumber(raw?.cashflowUsd, raw?.netCashflowUsd)
    ?? (side ? Number(((side === 'SELL' ? notionalUsd : -notionalUsd) - (fee ?? 0)).toFixed(4)) : undefined);
  const ts = parseTs(raw?.timestamp, raw?.createdAt, raw?.created_at, raw?.time);
  const orderId = raw?.orderId || raw?.orderID ? String(raw.orderId ?? raw.orderID) : undefined;
  const tokenId = raw?.asset || raw?.assetId || raw?.tokenId || raw?.token_id ? String(raw.asset ?? raw.assetId ?? raw.tokenId ?? raw.token_id) : undefined;
  const marketId = raw?.conditionId || raw?.market ? String(raw.conditionId ?? raw.market) : undefined;
  return {
    venue: 'polymarket',
    id: String(raw?.id ?? raw?.transactionHash ?? raw?.tradeId ?? raw?.orderId ?? stableFillId('polymarket', {
      orderId,
      tokenId,
      marketId,
      side,
      price,
      size,
      notionalUsd,
      ts
    }, index)),
    orderId,
    tokenId,
    marketId,
    side,
    price,
    size,
    notionalUsd,
    feeUsd: fee,
    realizedPnlUsd: realized,
    cashflowUsd: cashflow,
    ts,
    raw
  };
}

function stableFillId(
  venue: string,
  fill: {
    orderId?: string;
    tokenId?: string;
    marketId?: string;
    side?: string;
    price?: number;
    size?: number;
    notionalUsd?: number;
    ts: number;
  },
  index: number
): string {
  const parts = [
    venue,
    fill.orderId,
    fill.tokenId,
    fill.marketId,
    fill.side,
    numberKey(fill.price),
    numberKey(fill.size),
    numberKey(fill.notionalUsd),
    Number.isFinite(fill.ts) ? String(fill.ts) : undefined
  ].filter((part): part is string => Boolean(part));
  return parts.length > 1 ? parts.join(':') : `${venue}:unknown:${index}`;
}

function numberKey(value: number | undefined): string | undefined {
  return Number.isFinite(value) ? Number(value).toFixed(8) : undefined;
}

function parseTs(...values: unknown[]): number {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value > 1e12 ? value : value * 1000;
    if (typeof value === 'string' && value.trim()) {
      const numeric = Number(value);
      if (Number.isFinite(numeric)) return numeric > 1e12 ? numeric : numeric * 1000;
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return Date.now();
}
