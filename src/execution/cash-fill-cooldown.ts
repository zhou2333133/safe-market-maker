import type { AppConfig } from '../config/schema.js';
import type { VenueName } from '../domain/types.js';
import type { StateStore } from '../store/sqlite.js';
import { isCashMultiMarketEntry } from '../strategy/paired-inventory.js';
import type { MarketRouteCandidate } from '../strategy/market-router.js';

const CASH_FILL_SESSION_FALLBACK_LOOKBACK_MS = 6 * 60 * 60 * 1000;
// Shortened from 7 days to 1 day per user request: avoids re-entering today's eaten tokens but lets older
// wounded tokens recover quickly — recent high-reward markets shouldn't be locked out for a week after one fill.
const CASH_FILL_HISTORY_LOOKBACK_MS = 24 * 60 * 60 * 1000;

export interface CashFillCooldown {
  session: Set<string>;
  history: Set<string>;
}

export type CashFillCooldownStore = Pick<StateStore, 'cashFillCooldownEntries' | 'getCheckpoint'>;

export function emptyCashFillCooldown(): CashFillCooldown {
  return { session: new Set(), history: new Set() };
}

export function buildCashFillCooldown(
  config: AppConfig,
  venue: VenueName,
  store: CashFillCooldownStore,
  now = Date.now()
): CashFillCooldown {
  if (!isCashMultiMarketEntry(config)) return emptyCashFillCooldown();
  const sessionStartedAt = liveSessionStartedAt(store, venue);
  const sessionScoped = sessionStartedAt !== undefined;
  const sessionSince = sessionScoped ? sessionStartedAt : now - CASH_FILL_SESSION_FALLBACK_LOOKBACK_MS;
  const historySince = now - CASH_FILL_HISTORY_LOOKBACK_MS;
  const since = Math.min(sessionSince, historySince);
  const entries = store.cashFillCooldownEntries(venue, since);
  const session = new Set<string>();
  const history = new Set<string>();
  const sessionStart = sessionStartedAt ?? now - CASH_FILL_SESSION_FALLBACK_LOOKBACK_MS;
  for (const item of entries) {
    const ts = Date.parse(item.ts);
    if (!Number.isFinite(ts)) continue;
    if (ts + CASH_FILL_HISTORY_LOOKBACK_MS <= now) continue;
    const inSessionWindow = sessionScoped
      ? ts >= sessionStart
      : ts + CASH_FILL_SESSION_FALLBACK_LOOKBACK_MS > now;
    const target = inSessionWindow ? session : history;
    target.add(item.tokenId);
    if (item.marketId) target.add(cashFillMarketKey(item.marketId));
  }
  return { session, history };
}

export function applyCashFillCooldown(
  candidate: MarketRouteCandidate,
  cooldown: CashFillCooldown
): MarketRouteCandidate {
  const blocked = cashFillBlockedScope(candidate.market.tokenId, candidate.market.marketId, cooldown);
  if (!blocked) return candidate;
  const riskFlags = [
    ...candidate.riskFlags,
    blocked.window === 'session'
      ? `现金单边本轮实盘已在该 ${blocked.subject} 被吃单，手动重新开始新 session 后再评估`
      : `现金单边近 24 小时已在该 ${blocked.subject} 被吃单，暂不重新挂回高危盘口`
  ];
  return {
    ...candidate,
    tradable: false,
    riskFlags,
    reasons: [
      `${blocked.window === 'session' ? '本轮成交冷却' : '近期高危成交冷却'}中，暂不重新挂回 ${candidate.market.marketId ?? candidate.market.tokenId}`,
      ...candidate.reasons
    ]
  };
}

export function cashFillBlockedScope(
  tokenId: string | undefined,
  marketId: string | undefined,
  cooldown: CashFillCooldown
): { window: 'session' | 'history'; subject: '市场' | 'token' } | undefined {
  const marketKey = marketId ? cashFillMarketKey(marketId) : undefined;
  if (marketKey && cooldown.session.has(marketKey)) return { window: 'session', subject: '市场' };
  if (tokenId && cooldown.session.has(tokenId)) return { window: 'session', subject: 'token' };
  if (marketKey && cooldown.history.has(marketKey)) return { window: 'history', subject: '市场' };
  if (tokenId && cooldown.history.has(tokenId)) return { window: 'history', subject: 'token' };
  return undefined;
}

function liveSessionStartedAt(store: Pick<StateStore, 'getCheckpoint'>, venue: VenueName): number | undefined {
  const checkpoint = store.getCheckpoint(`live-session.${venue}`)?.value;
  if (!checkpoint || typeof checkpoint !== 'object') return undefined;
  const startedAt = (checkpoint as { startedAt?: unknown }).startedAt;
  if (typeof startedAt !== 'string') return undefined;
  const parsed = Date.parse(startedAt);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function cashFillMarketKey(marketId: string): string {
  return `market:${marketId}`;
}
