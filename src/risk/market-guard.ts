import type { AppConfig } from '../config/schema.js';
import type { Market, Orderbook } from '../domain/types.js';
import { bestBidAsk } from '../venues/normalize.js';

export type MarketGuardReason =
  | 'ok'
  | 'unknown-end-time'
  | 'market-ended'
  | 'near-settlement'
  | 'cancel-window'
  | 'event-started'
  | 'near-event-start'
  | 'event-start-cancel-window'
  | 'price-jump'
  | 'missing-bbo'
  | 'spread-blowout'
  | 'spread-jump'
  | 'price-extreme'
  | 'depth-collapse';

export interface MarketGuardDecision {
  ok: boolean;
  cancelOpenOrders: boolean;
  reason: MarketGuardReason;
  message: string;
  endTime?: string;
  endTimeSource?: Market['endTimeSource'];
  msToEnd?: number;
  startTime?: string;
  startTimeSource?: Market['startTimeSource'];
  msToStart?: number;
  metrics?: {
    mid?: number;
    previousMid?: number;
    bboMoveCents?: number;
    spreadBps?: number;
    previousSpreadBps?: number;
    spreadMoveBps?: number;
    bidDepthUsd: number;
    askDepthUsd: number;
  };
}

export interface MarketGuardOptions {
  previousBook?: Orderbook;
  now?: number;
}

/**
 * Spread acceptance shared by the market guard, route flags and order-level risk: the relative-bps cap, with a
 * Polymarket reward-market exemption. A bps cap misjudges cheap legs — at price 0.13 even the 1-tick minimum spread
 * is ~770bps, which would ban exactly the legs a small order can meet reward min-size on. For those, the
 * reward-making criterion is ABSOLUTE width vs the official reward band: a book no wider than the band
 * (rewards.maxSpreadCents) is tight enough to quote inside it.
 */
export function spreadWithinLimits(
  config: AppConfig,
  market: Market,
  spreadBps: number | undefined,
  mid: number | undefined
): boolean {
  if (spreadBps === undefined) return true;
  if (spreadBps <= config.risk.maxSpreadBps) return true;
  if (market.venue !== 'polymarket') return false;
  const bandCents = market.rewards?.enabled ? market.rewards.maxSpreadCents : undefined;
  if (bandCents === undefined || bandCents <= 0 || mid === undefined || mid <= 0) return false;
  const spreadCents = (spreadBps * mid) / 100;
  return spreadCents <= bandCents + 1e-9;
}

export function evaluateMarketGuard(
  config: AppConfig,
  market: Market,
  book: Orderbook | undefined,
  options: MarketGuardOptions = {}
): MarketGuardDecision {
  const now = options.now ?? Date.now();
  const time = marketTimeDecision(config, market, now);
  if (!time.ok || time.cancelOpenOrders) return time;
  if (!book) return block('missing-bbo', '盘口不可用，禁止新增挂单');
  const metrics = bookMetrics(book, options.previousBook);
  if (metrics.mid === undefined) return block('missing-bbo', '盘口缺少 BBO，禁止新增挂单', { metrics });
  if (metrics.mid <= config.risk.minPrice || metrics.mid >= config.risk.maxPrice) {
    return block('price-extreme', `盘口中位价 ${metrics.mid.toFixed(4)} 接近 0/1，禁止新增挂单`, { metrics });
  }
  if (metrics.spreadMoveBps !== undefined && metrics.spreadMoveBps > config.risk.maxSpreadMoveBps) {
    // On cheap legs a 1-tick spread change is a huge RELATIVE move; when both the previous and current spread are
    // acceptable (bps cap or reward-band width), the move is normal noise — absolute jumps remain guarded by
    // maxBboMoveCents below.
    const bothSpreadsAcceptable = spreadWithinLimits(config, market, metrics.spreadBps, metrics.mid)
      && spreadWithinLimits(config, market, metrics.previousSpreadBps, metrics.mid);
    if (!bothSpreadsAcceptable) {
      return block('spread-jump', `盘口价差突变 ${metrics.spreadMoveBps.toFixed(1)}bps，超过 ${config.risk.maxSpreadMoveBps}bps`, { metrics });
    }
  }
  if (!spreadWithinLimits(config, market, metrics.spreadBps, metrics.mid)) {
    return block('spread-blowout', `盘口价差 ${(metrics.spreadBps ?? 0).toFixed(1)}bps 超过上限 ${config.risk.maxSpreadBps}bps(且宽于奖励带)`, { metrics });
  }
  if (metrics.bidDepthUsd < config.risk.minDepthUsdPerSide || metrics.askDepthUsd < config.risk.minDepthUsdPerSide) {
    return block('depth-collapse', `盘口深度不足：bid ${metrics.bidDepthUsd.toFixed(2)} / ask ${metrics.askDepthUsd.toFixed(2)} USD`, { metrics });
  }
  if (metrics.bboMoveCents !== undefined && metrics.bboMoveCents > config.risk.maxBboMoveCents) {
    return block('price-jump', `下单前 BBO 中位价跳动 ${metrics.bboMoveCents.toFixed(2)}c，超过 ${config.risk.maxBboMoveCents}c`, { metrics });
  }
  return {
    ok: true,
    cancelOpenOrders: false,
    reason: 'ok',
    message: '市场时间和盘口状态通过',
    endTime: market.endTime,
    endTimeSource: market.endTimeSource,
    ...(time.msToEnd !== undefined ? { msToEnd: time.msToEnd } : {}),
    ...(market.startTime ? { startTime: market.startTime } : {}),
    ...(market.startTimeSource ? { startTimeSource: market.startTimeSource } : {}),
    ...(time.msToStart !== undefined ? { msToStart: time.msToStart } : {}),
    metrics
  };
}

export function marketTimeDecision(config: AppConfig, market: Market, now = Date.now()): MarketGuardDecision {
  const end = marketEndDecision(config, market, now);
  if (!end.ok || end.cancelOpenOrders) return end;
  const start = marketStartDecision(config, market, now);
  if (!start.ok || start.cancelOpenOrders) return start;
  return {
    ok: true,
    cancelOpenOrders: false,
    reason: 'ok',
    message: '市场时间保护通过',
    ...(market.endTime ? { endTime: market.endTime } : {}),
    ...(market.endTimeSource ? { endTimeSource: market.endTimeSource } : {}),
    ...(end.msToEnd !== undefined ? { msToEnd: end.msToEnd } : {}),
    ...(market.startTime ? { startTime: market.startTime } : {}),
    ...(market.startTimeSource ? { startTimeSource: market.startTimeSource } : {}),
    ...(start.msToStart !== undefined ? { msToStart: start.msToStart } : {})
  };
}

export function marketEndDecision(config: AppConfig, market: Market, now = Date.now()): MarketGuardDecision {
  if (!market.endTime) {
    return config.risk.blockUnknownEndTime
      ? block('unknown-end-time', '市场没有明确结束/停止下单时间，按实盘保守规则禁止新增挂单并撤掉开放订单', { cancelOpenOrders: true })
      : {
          ok: true,
          cancelOpenOrders: false,
          reason: 'ok',
          message: '市场结束时间未知，但配置允许未知时间市场',
          endTimeSource: 'unknown'
        };
  }
  const endTs = Date.parse(market.endTime);
  if (!Number.isFinite(endTs)) {
    return block('unknown-end-time', '市场结束时间格式不可验证，禁止新增挂单并撤掉开放订单', {
      endTime: market.endTime,
      endTimeSource: market.endTimeSource,
      cancelOpenOrders: true
    });
  }
  const msToEnd = endTs - now;
  const common = { endTime: market.endTime, endTimeSource: market.endTimeSource, msToEnd };
  if (msToEnd <= 0) return block('market-ended', '市场已经到达结束时间，禁止新增挂单并撤掉开放订单', { ...common, cancelOpenOrders: true });
  if (msToEnd <= config.risk.settlementCancelOpenOrdersMs) {
    return block('cancel-window', `距离市场结束只剩 ${formatDuration(msToEnd)}，应撤掉开放订单`, { ...common, cancelOpenOrders: true });
  }
  if (msToEnd <= config.risk.settlementNoNewOrdersMs) {
    return block('near-settlement', `距离市场结束只剩 ${formatDuration(msToEnd)}，禁止新增挂单`, common);
  }
  return {
    ok: true,
    cancelOpenOrders: false,
    reason: 'ok',
    message: `距离市场结束 ${formatDuration(msToEnd)}，通过时间保护`,
    ...common
  };
}

export function marketStartDecision(config: AppConfig, market: Market, now = Date.now()): MarketGuardDecision {
  if (!market.startTime || !isShortTimedEvent(config, market)) {
    return {
      ok: true,
      cancelOpenOrders: false,
      reason: 'ok',
      message: '市场开始时间保护未触发'
    };
  }
  const startTs = Date.parse(market.startTime);
  if (!Number.isFinite(startTs)) {
    return {
      ok: true,
      cancelOpenOrders: false,
      reason: 'ok',
      message: '市场开始时间格式不可验证，回退到结束时间保护',
      startTime: market.startTime,
      startTimeSource: market.startTimeSource
    };
  }
  const msToStart = startTs - now;
  const common = { startTime: market.startTime, startTimeSource: market.startTimeSource, msToStart };
  if (msToStart <= 0) {
    return block('event-started', '短时赛事/事件已经开始，禁止新增挂单并撤掉开放订单', {
      ...common,
      cancelOpenOrders: true
    });
  }
  if (msToStart <= config.risk.eventStartCancelOpenOrdersMs) {
    return block('event-start-cancel-window', `距离短时赛事/事件开始只剩 ${formatDuration(msToStart)}，应撤掉开放订单`, {
      ...common,
      cancelOpenOrders: true
    });
  }
  if (msToStart <= config.risk.eventStartNoNewOrdersMs) {
    return block('near-event-start', `距离短时赛事/事件开始只剩 ${formatDuration(msToStart)}，禁止新增挂单`, common);
  }
  return {
    ok: true,
    cancelOpenOrders: false,
    reason: 'ok',
    message: `距离短时赛事/事件开始 ${formatDuration(msToStart)}，通过开赛保护`,
    ...common
  };
}

function bookMetrics(book: Orderbook, previousBook?: Orderbook): NonNullable<MarketGuardDecision['metrics']> {
  const current = bestBidAsk(book);
  const previous = previousBook ? bestBidAsk(previousBook) : {};
  const bidDepthUsd = book.bids.slice(0, 3).reduce((sum, level) => sum + level.price * level.size, 0);
  const askDepthUsd = book.asks.slice(0, 3).reduce((sum, level) => sum + level.price * level.size, 0);
  const spreadBps = current.spread !== undefined && current.mid !== undefined && current.mid > 0
    ? (current.spread / current.mid) * 10000
    : undefined;
  const previousSpreadBps = previous.spread !== undefined && previous.mid !== undefined && previous.mid > 0
    ? (previous.spread / previous.mid) * 10000
    : undefined;
  const bboMoveCents = current.mid !== undefined && previous.mid !== undefined
    ? Math.abs(current.mid - previous.mid) * 100
    : undefined;
  const spreadMoveBps = spreadBps !== undefined && previousSpreadBps !== undefined
    ? Math.abs(spreadBps - previousSpreadBps)
    : undefined;
  return {
    ...(current.mid !== undefined ? { mid: Number(current.mid.toFixed(6)) } : {}),
    ...(previous.mid !== undefined ? { previousMid: Number(previous.mid.toFixed(6)) } : {}),
    ...(bboMoveCents !== undefined ? { bboMoveCents: Number(bboMoveCents.toFixed(4)) } : {}),
    ...(spreadBps !== undefined ? { spreadBps: Number(spreadBps.toFixed(2)) } : {}),
    ...(previousSpreadBps !== undefined ? { previousSpreadBps: Number(previousSpreadBps.toFixed(2)) } : {}),
    ...(spreadMoveBps !== undefined ? { spreadMoveBps: Number(spreadMoveBps.toFixed(2)) } : {}),
    bidDepthUsd: Number(bidDepthUsd.toFixed(4)),
    askDepthUsd: Number(askDepthUsd.toFixed(4))
  };
}

function block(
  reason: MarketGuardReason,
  message: string,
  extra: Partial<MarketGuardDecision> = {}
): MarketGuardDecision {
  return {
    ok: false,
    cancelOpenOrders: Boolean(extra.cancelOpenOrders),
    reason,
    message,
    ...(extra.endTime ? { endTime: extra.endTime } : {}),
    ...(extra.endTimeSource ? { endTimeSource: extra.endTimeSource } : {}),
    ...(extra.msToEnd !== undefined ? { msToEnd: extra.msToEnd } : {}),
    ...(extra.startTime ? { startTime: extra.startTime } : {}),
    ...(extra.startTimeSource ? { startTimeSource: extra.startTimeSource } : {}),
    ...(extra.msToStart !== undefined ? { msToStart: extra.msToStart } : {}),
    ...(extra.metrics ? { metrics: extra.metrics } : {})
  };
}

function isShortTimedEvent(config: AppConfig, market: Market): boolean {
  const maxDuration = config.risk.shortEventMaxDurationMs;
  if (maxDuration <= 0) return false;
  if (!market.startTime || !market.endTime) return false;
  const startTs = Date.parse(market.startTime);
  const endTs = Date.parse(market.endTime);
  if (!Number.isFinite(startTs) || !Number.isFinite(endTs)) return false;
  const duration = endTs - startTs;
  return duration > 0 && duration <= maxDuration;
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest > 0 ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`;
}
