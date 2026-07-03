/**
 * Predict.fun ws-report: 纯函数报告聚合器。
 * 输入 open orders + markets metadata + WS 盘口缓存 + 配置，输出每个活跃订单的竞争占比和积分预期。
 *
 * 不依赖任何外部 IO / 网络 / 交易执行，不改变任何状态。
 */

import type { AppConfig } from '../../config/schema.js';
import type { Market, OpenOrder, Orderbook } from '../../domain/types.js';
import { computeCompetitionBand, isWithinRewardBand } from './common.js';

// ---------------------------------------------------------------------------
// 公共类型
// ---------------------------------------------------------------------------

export interface PredictOrderReport {
  /** 市场题目（用于报告标题行） */
  question: string;
  /** 市场 tokenId */
  tokenId: string;
  /** 订单方向 */
  side: string;
  /** 订单价格（美元） */
  price: number;
  /** 订单份额 */
  size: number;
  /** 订单名义金额（价格 × 份额，约值） */
  notionalUsd: number;
  /** 订单状态 */
  status: string;
  /** 官方 PP/hr */
  ppPerHour: number;
  /** 奖励带内竞争资金总额（不含自己） */
  competitionUsd: number;
  /** 占奖励带比率（%） */
  sharePct: number;
  /** 预计实际积分（pts/h） */
  expectedPtsPerHour: number;
  /** 资金效率（pts/h/kUSD） */
  ppPerThousandUsd: number;
  /** 竞争拥挤度 */
  competitionBand: 'unknown' | 'thin' | 'balanced' | 'crowded';
  /** 盘口新鲜度（ms 前的推送） */
  bookAgeMs: number;
  /** 该订单包含的买一档位深度（美元），用于展示具体档位 */
  depthLevel: string;
}

export interface PredictReportSummary {
  /** 报告生成时间戳 */
  generatedAt: number;
  /** 活跃订单总数 */
  activeOrders: number;
  /** 实时合计积分 */
  totalExpectedPtsPerHour: number;
  /** 盘口覆盖订单数（有有效 WS 缓存的订单数） */
  booksCovered: number;
  /** WS 当前订阅市场数 */
  wsWatchedMarkets: number;
  /** 每条订单的明细 */
  orders: PredictOrderReport[];
}

// ---------------------------------------------------------------------------
// 竞争指标（复用 market-router 中相同的公式，但独立不引入耦合）
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 奖励带内竞争资金（不包含自己）
// ---------------------------------------------------------------------------

function competitionInBandUsd(
  book: Orderbook,
  side: string,
  price: number,
  maxSpreadCents: number | undefined,
  ownSize: number
): number {
  const levels = side === 'BUY' ? book.bids : book.asks;
  let total = 0;
  for (const level of levels) {
    if (!isWithinRewardBand(side as 'BUY' | 'SELL', level.price, book, maxSpreadCents)) continue;
    if (Math.abs(level.price - price) < 1e-9 && ownSize > 0) {
      // 这个价格档位减去自己的份额
      total += level.price * Math.max(0, level.size - ownSize);
    } else {
      total += level.price * level.size;
    }
  }
  return Number(total.toFixed(4));
}

// ---------------------------------------------------------------------------
// 深度标签生成（买一/买二/...）
// ---------------------------------------------------------------------------

function depthLabel(side: string, price: number, book: Orderbook): string {
  const levels = side === 'BUY' ? book.bids : book.asks;
  for (let idx = 0; idx < levels.length; idx++) {
    const level = levels[idx];
    if (!level) continue;
    if (Math.abs(level.price - price) < 1e-9) {
      const ordinals = ['买一', '买二', '买三', '买四', '买五', '买六', '买七', '买八',
                        '卖一', '卖二', '卖三', '卖四', '卖五', '卖六', '卖七', '卖八'];
      const baseIndex = side === 'BUY' ? 0 : 8;
      const ordinal = ordinals[baseIndex + Math.min(idx, 7)] ?? `L${idx + 1}`;
      return `${ordinal} ${priceToCents(price)}¢`;
    }
  }
  return `${priceToCents(price)}¢`;
}

function priceToCents(price: number): string {
  return (price * 100).toFixed(1);
}

// ---------------------------------------------------------------------------
// 订单条目报告生成
// ---------------------------------------------------------------------------

function buildOrderReport(
  order: OpenOrder,
  market: Market | undefined,
  ppPerHour: number,
  maxSpreadCents: number | undefined,
  book: Orderbook | undefined
): PredictOrderReport {
  const notionalUsd = order.price * order.size;
  const bookAgeMs = book?.receivedAt != null ? Date.now() - book.receivedAt : Number.NaN;

  let competitionUsd = 0;
  let sharePct = 0;
  let expectedPtsPerHour = 0;
  let ppPerThousandUsd = 0;
  let competitionBand: 'unknown' | 'thin' | 'balanced' | 'crowded' = 'unknown';
  let depthLevel = priceToCents(order.price) + '¢';

  if (book && Number.isFinite(bookAgeMs) && maxSpreadCents != null && maxSpreadCents > 0) {
    competitionUsd = competitionInBandUsd(book, order.side, order.price, maxSpreadCents, order.size);
    depthLevel = depthLabel(order.side, order.price, book);

    const metrics = computeCompetitionBand(competitionUsd, notionalUsd, ppPerHour);
    sharePct = Number(metrics.sharePct.toFixed(2));
    expectedPtsPerHour = Number(metrics.expectedPerHour.toFixed(4));
    ppPerThousandUsd = Number(metrics.ppPerThousandUsd.toFixed(4));
    competitionBand = metrics.competitionBand;
  }

  return {
    question: market?.question ?? order.tokenId,
    tokenId: order.tokenId,
    side: order.side,
    price: order.price,
    size: order.size,
    notionalUsd: Number(notionalUsd.toFixed(4)),
    status: order.status,
    ppPerHour,
    competitionUsd: Number(competitionUsd.toFixed(4)),
    sharePct,
    expectedPtsPerHour,
    ppPerThousandUsd,
    competitionBand,
    bookAgeMs,
    depthLevel
  };
}

// ---------------------------------------------------------------------------
// 公共入口：生成 Predict 持有报告
// ---------------------------------------------------------------------------

export function generatePredictReport(input: {
  config: AppConfig;
  openOrders: OpenOrder[];
  markets: Market[];
  /** marketId → 缓存的 WS 盘口 */
  books: Map<string, Orderbook>;
  /** marketId → tokenId 映射 */
  marketIdByToken: Map<string, string>;
  wsWatchedMarkets: number;
}): PredictReportSummary {
  const { openOrders, markets, books, marketIdByToken, wsWatchedMarkets } = input;

  // 只统计 Predict 的活跃订单
  const active = openOrders.filter(
    (order) =>
      order.venue === 'predict' &&
      ['OPEN', 'PENDING_OPEN', 'PLANNED', 'UNKNOWN'].includes(order.status)
  );

  // 按 tokenId 建市场索引
  const marketByToken = new Map<string, Market>();
  for (const market of markets) {
    if (market.venue === 'predict') marketByToken.set(market.tokenId, market);
  }

  const orders: PredictOrderReport[] = [];
  let booksCovered = 0;
  let totalExpectedPtsPerHour = 0;

  for (const order of active) {
    const market = marketByToken.get(order.tokenId);
    const ppPerHour = market?.rewards?.ppPerHour ?? 0;
    const maxSpreadCents = market?.rewards?.maxSpreadCents;
    const marketId = marketIdByToken.get(order.tokenId) ?? order.tokenId;
    const book = books.get(marketId);

    if (book) booksCovered += 1;

    const report = buildOrderReport(order, market, ppPerHour, maxSpreadCents, book);
    orders.push(report);
    totalExpectedPtsPerHour += report.expectedPtsPerHour;
  }

  // 按预期积分降序排序
  orders.sort((a, b) => b.expectedPtsPerHour - a.expectedPtsPerHour);

  return {
    generatedAt: Date.now(),
    activeOrders: orders.length,
    totalExpectedPtsPerHour: Number(totalExpectedPtsPerHour.toFixed(2)),
    booksCovered,
    wsWatchedMarkets,
    orders
  };
}
