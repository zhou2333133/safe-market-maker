import type { AppConfig } from '../../config/schema.js';
import type { Market, OpenOrder, Orderbook } from '../../domain/types.js';
import { bestBidAsk } from '../../venues/normalize.js';

/**
 * Polymarket-accurate liquidity-reward competition / capital-utilization model,
 * following the official scoring (https://docs.polymarket.com/market-makers/liquidity-rewards):
 *
 *   - Spread score:  S(v, s) = ((v - s) / v)^2        (v = max_spread cents, s = distance from MIDPOINT)
 *   - Qone = bids on YES + asks on NO ;  Qtwo = asks on YES + bids on NO
 *   - midpoint in [0.10, 0.90]:  Qmin = max( min(Qone,Qtwo), max(Qone,Qtwo)/c ),  c = 3
 *   - midpoint < 0.10 or > 0.90: Qmin = min(Qone,Qtwo)  (two-sided required)
 *   - your share = yourQmin / (Σ makers' Qmin) ; reward = dailyRate * share
 *
 * This per-leg function returns the raw bid/ask scores and the midpoint so the
 * router can recombine the YES and NO legs into the correct Qone/Qtwo/Qmin at the
 * group level (a NO bid is economically a YES ask, so the cross-partition matters).
 * Values are calibratable estimates, NOT a platform-guaranteed payout.
 */

// Distance-from-mid decay exponent. Polymarket's published scoring is quadratic.
const POLY_SCORE_EXPONENT = 2;
// Official Qmin scaling factor c (currently 3.0 on all markets).
const POLY_QMIN_SCALING = 3.0;
// Below/above these midpoints Polymarket requires two-sided quoting to score.
const POLY_TWO_SIDED_LOW = 0.10;
const POLY_TWO_SIDED_HIGH = 0.90;
const THIN_COMPETITION_RATIO = 3;
const CROWDED_COMPETITION_RATIO = 250;

export interface PolymarketCompetition {
  expectedPpPerHour: number;
  ppPerThousandUsd: number;
  targetSharePct: number;
  competitionBand: 'unknown' | 'thin' | 'balanced' | 'crowded';
  yourScore: number;
  competitorBidScore: number;
  competitorAskScore: number;
  mid: number;
  expectedDailyRewardUsd: number;
}

/** Official Polymarket two-sided Qmin (c = 3); two-sided required outside [0.10, 0.90]. */
export function polymarketQmin(qone: number, qtwo: number, mid: number): number {
  if (mid >= POLY_TWO_SIDED_LOW && mid <= POLY_TWO_SIDED_HIGH) {
    return Math.max(Math.min(qone, qtwo), Math.max(qone, qtwo) / POLY_QMIN_SCALING);
  }
  return Math.min(qone, qtwo);
}

function spreadUtility(distanceCents: number, sizeShares: number, bandCents: number): number {
  if (!(bandCents > 0)) return 0;
  if (distanceCents < -1e-9 || distanceCents > bandCents + 1e-9) return 0;
  const proximity = Math.max(0, Math.min(1, (bandCents - distanceCents) / bandCents));
  return Math.pow(proximity, POLY_SCORE_EXPONENT) * Math.max(0, sizeShares);
}

function ownSharesBySidePrice(market: Market, openOrders: OpenOrder[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const order of openOrders) {
    if (order.tokenId !== market.tokenId) continue;
    if (!['OPEN', 'PENDING_OPEN', 'PLANNED', 'UNKNOWN'].includes(order.status)) continue;
    const key = `${order.side}:${Number(order.price).toFixed(8)}`;
    result.set(key, (result.get(key) ?? 0) + Math.max(0, order.size));
  }
  return result;
}

/**
 * Returns undefined when the market lacks the inputs needed for the Polymarket
 * model (daily rate / reward spread / usable BBO), so the caller can fall back
 * to the generic depth-based competition metric.
 */
export function polymarketRewardCompetition(input: {
  config: AppConfig;
  market: Market;
  book: Orderbook;
  ownOpenOrders?: OpenOrder[];
  targetOrderUsd: number;
  targetReferencePrice: number;
}): PolymarketCompetition | undefined {
  const { market, book } = input;
  const dailyRate = market.rewards?.dailyRate;
  const bandCents = market.rewards?.maxSpreadCents;
  if (!dailyRate || dailyRate <= 0 || !bandCents || bandCents <= 0) return undefined;
  if (!(input.targetOrderUsd > 0)) return undefined;
  const bbo = bestBidAsk(book);
  if (bbo.mid === undefined || bbo.bestBid === undefined || bbo.bestAsk === undefined) return undefined;
  const mid = bbo.mid;
  const ownShares = ownSharesBySidePrice(market, input.ownOpenOrders ?? []);

  // Reward zone is measured from the MIDPOINT (mid ± max_spread); spreadUtility zeroes beyond it.
  let competitorBidScore = 0;
  for (const level of book.bids) {
    const own = ownShares.get(`BUY:${level.price.toFixed(8)}`) ?? 0;
    competitorBidScore += spreadUtility((mid - level.price) * 100, level.size - own, bandCents);
  }
  let competitorAskScore = 0;
  for (const level of book.asks) {
    const own = ownShares.get(`SELL:${level.price.toFixed(8)}`) ?? 0;
    competitorAskScore += spreadUtility((level.price - mid) * 100, level.size - own, bandCents);
  }

  const price = input.targetReferencePrice > 0 && input.targetReferencePrice < 1 ? input.targetReferencePrice : mid;
  const yourShares = input.targetOrderUsd / Math.max(price, 0.0001);
  const yourScore = spreadUtility((mid - price) * 100, yourShares, bandCents);
  if (!(yourScore > 0)) return undefined;

  // One-sided (single-leg) estimate via the official Qmin with the opposite side = 0.
  const yourQmin = polymarketQmin(yourScore, 0, mid);
  const competitorQmin = polymarketQmin(competitorBidScore, competitorAskScore, mid);
  const total = competitorQmin + yourQmin;
  const share = total > 0 ? yourQmin / total : 0;
  const expectedDailyRewardUsd = dailyRate * share;
  const expectedPpPerHour = expectedDailyRewardUsd / 24;
  const ppPerThousandUsd = (expectedPpPerHour / input.targetOrderUsd) * 1000;
  const competitorScore = competitorBidScore + competitorAskScore;
  const competitionBand: PolymarketCompetition['competitionBand'] = competitorScore < yourScore * THIN_COMPETITION_RATIO
    ? 'thin'
    : competitorScore > yourScore * CROWDED_COMPETITION_RATIO
      ? 'crowded'
      : 'balanced';

  return {
    expectedPpPerHour: Number(expectedPpPerHour.toFixed(4)),
    ppPerThousandUsd: Number(ppPerThousandUsd.toFixed(4)),
    targetSharePct: Number((share * 100).toFixed(4)),
    competitionBand,
    yourScore: Number(yourScore.toFixed(4)),
    competitorBidScore: Number(competitorBidScore.toFixed(4)),
    competitorAskScore: Number(competitorAskScore.toFixed(4)),
    mid: Number(mid.toFixed(6)),
    expectedDailyRewardUsd: Number(expectedDailyRewardUsd.toFixed(4))
  };
}
