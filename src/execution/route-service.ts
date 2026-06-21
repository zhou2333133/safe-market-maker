import type { AppConfig } from '../config/schema.js';
import type { Market, OpenOrder, Orderbook, Position, VenueName } from '../domain/types.js';
import { evaluateMarketGuard } from '../risk/market-guard.js';
import { rejectReason } from '../risk/reject-reasons.js';
import type { StateStore } from '../store/sqlite.js';
import { completeSetInventoryGroups, isCashMultiMarketEntry, isPairedEntryMode } from '../strategy/paired-inventory.js';
import { isPolymarketTwoSidedLp, rankMarketRoutes, selectMarketRoutes, type MarketRouteCandidate, type MarketRouteSelection } from '../strategy/market-router.js';
import { applyCashFillCooldown, buildCashFillCooldown } from './cash-fill-cooldown.js';

const MIN_CASH_SWITCH_ROUTE_COVERAGE_PCT = 80;
const MIN_CASH_ROLLING_ROUTE_AUDIT_COVERAGE_PCT = 60;
const MIN_CASH_ROLLING_ROUTE_AUDIT_SCANNED = 100;
const RECENT_CASH_ROUTE_MEMORY_MS = 2 * 60 * 1000;
const MAX_CASH_CURRENT_BOOK_MISSING_MS = 3 * 60 * 1000;
const FULL_CASH_ROUTE_AUDIT_MAX_AGE_MS = 2 * 60 * 60 * 1000;

interface CashAuditBasketProof {
  tokenIds: string[];
  source: string;
  ageMs: number;
  coveragePct?: number;
  complete: boolean;
}

interface CashExecutionGate {
  candidates: MarketRouteCandidate[];
  fullAuditReady: boolean;
  reason: string;
}

export class RouteService {
  constructor(
    private readonly config: AppConfig,
    private readonly store: StateStore
  ) {}

  selectRoutes(
    venue: VenueName,
    markets: Market[],
    books: Map<string, Orderbook>,
    openOrders: OpenOrder[],
    positions: Position[] = []
  ): MarketRouteSelection {
    if (!this.config.strategy.autoSelectMarkets) {
      const candidates = markets.map((market) => this.manualCandidate(market, books.get(market.tokenId)));
      return {
        selected: candidates.filter((candidate) => candidate.tradable).slice(0, Math.max(1, this.config.risk.maxMarkets)),
        candidates,
        switched: false,
        reason: '手动 selectedMarkets 模式'
      };
    }
    const polymarketTwoSided = isPolymarketTwoSidedLp(this.config, venue);
    const ranked = rankMarketRoutes(this.config, venue, markets, books, { positions, openOrders });
    const cooldown = buildCashFillCooldown(this.config, venue, this.store);
    const cooledRanked = isCashMultiMarketEntry(this.config) && !polymarketTwoSided
      ? ranked.map((candidate) => applyCashFillCooldown(candidate, cooldown))
      : ranked;
    const inventoryTokenIds = completeSetInventoryGroups(this.config, markets, positions).flatMap((group) => group.markets.map((market) => market.tokenId));
    const previousContext = this.previousRoutingContext(venue, markets, openOrders, inventoryTokenIds);
    const cashExecutionGate = isCashMultiMarketEntry(this.config) && !polymarketTwoSided
      ? this.cashExecutionGate(venue, cooledRanked, previousContext.previousTokenIds)
      : undefined;
    const candidates = cashExecutionGate?.candidates ?? cooledRanked;
    const selection = selectMarketRoutes(this.config, venue, candidates, previousContext.previousTokenIds);
    const gatedSelection = cashExecutionGate
      ? cashExecutionGate.fullAuditReady
        ? {
            ...selection,
            reason: `${selection.reason}；${cashExecutionGate.reason}`
          }
        : {
            ...selection,
            candidates: cooledRanked,
            switched: false,
            reason: `${selection.reason}；${cashExecutionGate.reason}`
          }
      : selection;
    if (!isCashMultiMarketEntry(this.config) && !polymarketTwoSided) {
      const missingCurrentBookDecision = this.maybeDeferCashRouteSwitchForMissingCurrentBook(venue, gatedSelection, previousContext.preferredTokenIds);
      if (missingCurrentBookDecision) return missingCurrentBookDecision;
      const coverageDecision = this.maybeDeferCashRouteSwitchForCoverage(venue, gatedSelection, previousContext.preferredTokenIds);
      if (coverageDecision) return coverageDecision;
    }
    if (
      isPairedEntryMode(this.config)
      && inventoryTokenIds.length > 0
      && gatedSelection.selected.length > 0
      && gatedSelection.selected.every((candidate) => !inventoryTokenIds.includes(candidate.market.tokenId))
    ) {
      return {
        ...gatedSelection,
        switched: true,
        reason: `${gatedSelection.reason}；当前完整套仓不在目标市场，先合并退出旧套仓`
      };
    }
    return gatedSelection;
  }

  private previousRoutingContext(
    venue: VenueName,
    markets: Market[],
    openOrders: OpenOrder[],
    inventoryTokenIds: string[]
  ): { previousTokenIds: string[]; preferredTokenIds: string[] } {
    const openTokenIds = new Set(openOrders.map((order) => order.tokenId).filter(Boolean));
    const routeMemory = this.previousRouteMemory(venue);
    const marketTokenIds = new Set(markets.map((market) => market.tokenId));
    const canUseRecentCashRouteMemory = !isPairedEntryMode(this.config)
      && routeMemory.ageMs !== undefined
      && routeMemory.ageMs <= RECENT_CASH_ROUTE_MEMORY_MS;
    const routeTokens = routeMemory.tokenIds.filter((tokenId) => (
      openTokenIds.has(tokenId)
      || inventoryTokenIds.includes(tokenId)
      || (canUseRecentCashRouteMemory && marketTokenIds.has(tokenId))
    ));
    const remainingOpenTokenIds = [...openTokenIds].filter((tokenId) => !routeTokens.includes(tokenId));
    const preferredTokenIds = routeTokens.length > 0 ? routeTokens : [...new Set([...inventoryTokenIds, ...remainingOpenTokenIds])];
    return {
      previousTokenIds: [...new Set([...routeTokens, ...inventoryTokenIds, ...remainingOpenTokenIds])],
      preferredTokenIds
    };
  }

  private previousRouteMemory(venue: VenueName): { tokenIds: string[]; ageMs?: number } {
    const checkpoint = this.store.getCheckpoint(`route.${venue}`);
    if (!checkpoint?.value || typeof checkpoint.value !== 'object') return { tokenIds: [] };
    const selected = (checkpoint.value as { selected?: unknown }).selected;
    if (!Array.isArray(selected)) return { tokenIds: [] };
    const tokenIds = selected
      .map((item) => (item && typeof item === 'object' ? (item as { tokenId?: unknown }).tokenId : undefined))
      .filter((tokenId): tokenId is string => typeof tokenId === 'string' && tokenId.length > 0);
    const ts = checkpoint.ts ? Date.parse(checkpoint.ts) : Number.NaN;
    return {
      tokenIds,
      ...(Number.isFinite(ts) ? { ageMs: Date.now() - ts } : {})
    };
  }

  private cashExecutionGate(
    venue: VenueName,
    candidates: MarketRouteCandidate[],
    previousTokenIds: string[]
  ): CashExecutionGate {
    const fullAuditBasket = this.fullCashAuditBasket(venue);
    if (!fullAuditBasket) {
      const previous = this.orderCandidatesByTokenIds(candidates, previousTokenIds);
      return {
        candidates: previous,
        fullAuditReady: false,
        reason: previous.length > 0
          ? '等待新鲜完整全站路由审计，禁止用局部 rolling 候选补新市场；本轮只维护已有现金单边订单'
          : '等待新鲜完整全站路由审计，禁止用局部 rolling 候选新增现金单边市场'
      };
    }
    const ordered = this.orderCandidatesByTokenIds(candidates, fullAuditBasket.tokenIds);
    return {
      candidates: ordered,
      fullAuditReady: true,
      reason: auditBasketReason(fullAuditBasket)
    };
  }

  private orderCandidatesByTokenIds(candidates: MarketRouteCandidate[], tokenIds: string[]): MarketRouteCandidate[] {
    const desiredTokenIds = [...new Set(tokenIds.filter(Boolean))];
    if (desiredTokenIds.length === 0) return [];
    const byToken = new Map(candidates.map((candidate) => [candidate.market.tokenId, candidate] as const));
    const ordered = desiredTokenIds.flatMap((tokenId) => {
      const candidate = byToken.get(tokenId);
      return candidate ? [candidate] : [];
    });
    return ordered;
  }

  private fullCashAuditBasket(venue: VenueName): CashAuditBasketProof | undefined {
    const audit = this.store.getCheckpoint(`route-audit.${venue}`);
    if (!audit?.value || typeof audit.value !== 'object') return undefined;
    return fullCashAuditBasketFromValue(audit.value);
  }

  private maybeDeferCashRouteSwitchForMissingCurrentBook(
    venue: VenueName,
    selection: MarketRouteSelection,
    preferredTokenIds: string[]
  ): MarketRouteSelection | undefined {
    if (isPairedEntryMode(this.config)) return undefined;
    if (preferredTokenIds.length === 0 || selection.selected.length === 0) return undefined;
    const selectedLeavesPreferredPool = selection.selected.every((candidate) => !preferredTokenIds.includes(candidate.market.tokenId));
    if (!selectedLeavesPreferredPool) {
      this.clearCurrentBookMissingWindow(venue, preferredTokenIds);
      return undefined;
    }
    const previousMissingBook = preferredTokenIds
      .map((tokenId) => selection.candidates.find((candidate) => candidate.market.tokenId === tokenId))
      .find((candidate): candidate is MarketRouteCandidate => Boolean(candidate && isTransientOrderbookUnavailable(candidate)));
    if (!previousMissingBook) {
      this.clearCurrentBookMissingWindow(venue, preferredTokenIds);
      return undefined;
    }
    const missing = this.currentBookMissingWindow(venue, previousMissingBook.market.tokenId);
    if (missing.elapsedMs > MAX_CASH_CURRENT_BOOK_MISSING_MS) return undefined;
    return {
      ...selection,
      selected: [previousMissingBook],
      switched: false,
      reason: `当前单边池子盘口暂不可用 ${formatMs(missing.elapsedMs)}，先等待新鲜盘口，不把局部可见候选当全局最优`
    };
  }

  private currentBookMissingWindow(venue: VenueName, tokenId: string): { startedAt: number; elapsedMs: number } {
    const key = `route-missing-book.${venue}`;
    const now = Date.now();
    const checkpoint = this.store.getCheckpoint(key)?.value;
    const previous = checkpoint && typeof checkpoint === 'object'
      ? checkpoint as { tokenId?: unknown; status?: unknown; startedAt?: unknown }
      : undefined;
    const previousStartedAt = previous?.tokenId === tokenId && previous.status === 'missing' && typeof previous.startedAt === 'string'
      ? Date.parse(previous.startedAt)
      : Number.NaN;
    const startedAt = Number.isFinite(previousStartedAt) && previousStartedAt <= now ? previousStartedAt : now;
    const elapsedMs = Math.max(0, now - startedAt);
    this.store.checkpoint(key, {
      tokenId,
      status: 'missing',
      startedAt: new Date(startedAt).toISOString(),
      lastSeenAt: new Date(now).toISOString(),
      elapsedMs
    });
    return { startedAt, elapsedMs };
  }

  private clearCurrentBookMissingWindow(venue: VenueName, tokenIds: string[]): void {
    if (tokenIds.length === 0) return;
    const key = `route-missing-book.${venue}`;
    const checkpoint = this.store.getCheckpoint(key)?.value;
    if (!checkpoint || typeof checkpoint !== 'object') return;
    const previous = checkpoint as { tokenId?: unknown; status?: unknown; startedAt?: unknown };
    if (previous.status !== 'missing' || typeof previous.tokenId !== 'string') return;
    if (!tokenIds.includes(previous.tokenId)) return;
    this.store.checkpoint(key, {
      tokenId: previous.tokenId,
      status: 'cleared',
      startedAt: typeof previous.startedAt === 'string' ? previous.startedAt : undefined,
      clearedAt: new Date().toISOString()
    });
  }

  private maybeDeferCashRouteSwitchForCoverage(
    venue: VenueName,
    selection: MarketRouteSelection,
    preferredTokenIds: string[]
  ): MarketRouteSelection | undefined {
    if (isPairedEntryMode(this.config)) return undefined;
    if (preferredTokenIds.length === 0 || selection.selected.length === 0 || !selection.previous) return undefined;
    const selectedLeavesPreferredPool = selection.selected.every((candidate) => !preferredTokenIds.includes(candidate.market.tokenId));
    if (!selectedLeavesPreferredPool) return undefined;
    const scan = this.store.getCheckpoint(`market-scan.${venue}`)?.value;
    const coverage = routeCoverage(scan);
    if (coverage === undefined || coverage >= MIN_CASH_SWITCH_ROUTE_COVERAGE_PCT) return undefined;
    return {
      ...selection,
      selected: [selection.previous],
      switched: false,
      reason: `路由盘口覆盖 ${coverage.toFixed(1)}% 低于 ${MIN_CASH_SWITCH_ROUTE_COVERAGE_PCT}%，暂不把局部扫描候选当全局最优；继续维护当前单边池子`
    };
  }

  private manualCandidate(market: Market, book: Orderbook | undefined): MarketRouteCandidate {
    const guard = evaluateMarketGuard(this.config, market, book);
    const riskFlags: string[] = [];
    if (!book) riskFlags.push('盘口不可用');
    if (!guard.ok) riskFlags.push(guard.message);
    return {
      market,
      side: 'BUY',
      score: 0,
      tradable: riskFlags.length === 0,
      reasons: ['手动 selectedMarkets 模式', guard.message],
      riskFlags,
      metrics: {
        ppPerHour: market.rewards?.ppPerHour ?? 0,
        rewardLevel: market.rewards?.level ?? 0,
        rewardBandDepthUsd: 0,
        topDepthUsd: 0,
        competitionBand: 'unknown',
        targetOrderUsd: this.config.risk.orderSizeUsd,
        liquidityUsd: market.liquidityUsd,
        volume24hUsd: market.volume24hUsd
      },
      groupKey: market.marketId || market.eventId || market.conditionId || market.tokenId
    };
  }

  recordSelection(venue: VenueName, routeSelection: MarketRouteSelection): void {
    routeSelection.candidates
      .filter((candidate) => !candidate.tradable && candidate.riskFlags.some((flag) => /结束|结算|BBO|盘口|深度|跳动/.test(flag)))
      .slice(0, 5)
      .forEach((candidate) => {
        this.store.recordEvent({
          venue,
          severity: 'warn',
          type: 'risk.market-guard.route-reject',
          message: candidate.market.outcome ? `${candidate.market.outcome} · ${candidate.market.question}` : candidate.market.question,
          details: {
            tokenId: candidate.market.tokenId,
            riskFlags: candidate.riskFlags,
            startTime: candidate.market.startTime,
            startTimeSource: candidate.market.startTimeSource,
            endTime: candidate.market.endTime,
            endTimeSource: candidate.market.endTimeSource,
            reject: rejectReason('ROUTE_MARKET_GUARD_REJECT', 'market', 'routing-market')
          }
        });
      });

    this.store.checkpoint(`route.${venue}`, {
      mode: 'live',
      reason: routeSelection.reason,
      switched: routeSelection.switched,
      selected: routeSelection.selected.map(publicRouteCandidate),
      best: routeSelection.best ? publicRouteCandidate(routeSelection.best) : undefined,
      selectedGroup: routeSelection.selected.length > 0 ? publicSelectedRouteGroup(routeSelection.selected) : undefined,
      bestGroup: routeSelection.bestGroup ? publicRouteGroup(routeSelection.bestGroup) : undefined,
      previousGroup: routeSelection.previousGroup ? publicRouteGroup(routeSelection.previousGroup) : undefined,
      candidates: routeSelection.candidates.slice(0, 8).map(publicRouteCandidate)
    });
    this.store.recordEvent({
      venue,
      type: 'route.selection',
      message: routeSelection.selected.length > 0
        ? routeSelection.selected.map((candidate) => `${candidate.market.outcome ?? candidate.market.question} score=${candidate.score}`).join('; ')
        : '没有可挂单的 PP 候选市场',
      details: {
        reason: routeSelection.reason,
        switched: routeSelection.switched,
        selected: routeSelection.selected.map(publicRouteCandidate),
        rejectedTop: routeSelection.candidates.filter((candidate) => !candidate.tradable).slice(0, 5).map(publicRouteCandidate)
      }
    });
  }
}

function isTransientOrderbookUnavailable(candidate: MarketRouteCandidate): boolean {
  return candidate.riskFlags.length > 0
    && candidate.riskFlags.some((flag) => /盘口不可用|盘口缺少 BBO|missing BBO/i.test(flag))
    && candidate.riskFlags.every((flag) => /盘口不可用|盘口缺少 BBO|missing BBO|前方保护深度|支撑档位|第一档|reward minimum/i.test(flag));
}

function formatMs(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest > 0 ? `${minutes}m${rest}s` : `${minutes}m`;
}

function routeCoverage(scan: unknown): number | undefined {
  if (!scan || typeof scan !== 'object') return undefined;
  const value = scan as { routeUsableOrderbooks?: unknown; eligibleMetadata?: unknown; coveragePct?: unknown };
  const eligible = Number(value.eligibleMetadata ?? 0);
  const usable = Number(value.routeUsableOrderbooks ?? 0);
  if (Number.isFinite(eligible) && eligible > 0 && Number.isFinite(usable) && usable >= 0) {
    return Number((usable / eligible * 100).toFixed(2));
  }
  const fallback = Number(value.coveragePct ?? Number.NaN);
  return Number.isFinite(fallback) ? fallback : undefined;
}

export function fullCashAuditBasketFromValue(value: unknown): CashAuditBasketProof | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const row = value as {
    latestFullAudit?: unknown;
    executionBasket?: unknown;
    executionBasketCapturedAt?: unknown;
    capturedAt?: unknown;
    complete?: unknown;
    coveragePct?: unknown;
    source?: unknown;
    totals?: unknown;
    failedTokenIds?: unknown;
  };
  const latest = fullCashAuditBasketProof(row.latestFullAudit);
  if (latest) return latest;
  const source = typeof row.source === 'string' ? row.source : '';
  const complete = row.complete === true || isFullAuditSource(source);
  const coveragePct = Number(row.coveragePct ?? 100);
  if (!Number.isFinite(coveragePct)) return undefined;
  const capturedAt = typeof row.executionBasketCapturedAt === 'string'
    ? row.executionBasketCapturedAt
    : typeof row.capturedAt === 'string' ? row.capturedAt : undefined;
  const tokenIds = tokenIdsFromExecutionBasket(row.executionBasket);
  if (complete) {
    if (coveragePct < 100) return undefined;
  } else if (!isHighCoverageRollingAudit(row, source, coveragePct, tokenIds)) {
    return undefined;
  }
  const ageMs = ageMsFromIso(capturedAt);
  if (tokenIds.length === 0 || ageMs === undefined || ageMs > FULL_CASH_ROUTE_AUDIT_MAX_AGE_MS) return undefined;
  return {
    tokenIds,
    source: complete ? canonicalFullAuditSource(source || 'complete-cache') : 'rolling-cache-high-coverage',
    ageMs,
    coveragePct,
    complete
  };
}

function fullCashAuditBasketProof(value: unknown): CashAuditBasketProof | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const row = value as { executionBasket?: unknown; capturedAt?: unknown; coveragePct?: unknown; source?: unknown };
  const coveragePct = Number(row.coveragePct ?? 100);
  if (!Number.isFinite(coveragePct) || coveragePct < 100) return undefined;
  const tokenIds = tokenIdsFromExecutionBasket(row.executionBasket);
  const ageMs = ageMsFromIso(typeof row.capturedAt === 'string' ? row.capturedAt : undefined);
  if (tokenIds.length === 0 || ageMs === undefined || ageMs > FULL_CASH_ROUTE_AUDIT_MAX_AGE_MS) return undefined;
  const source = typeof row.source === 'string' && row.source ? row.source : 'manual-full-audit';
  if (!isFullAuditSource(source)) return undefined;
  return { tokenIds, source: canonicalFullAuditSource(source), ageMs, coveragePct, complete: true };
}

function auditBasketReason(proof: CashAuditBasketProof): string {
  const coverage = proof.coveragePct !== undefined ? `，coverage=${proof.coveragePct.toFixed(2)}%` : '';
  if (proof.complete) return `使用 ${proof.source} 完整全站审计篮子${coverage}，age=${formatMs(proof.ageMs)}`;
  return `使用高覆盖 rolling-cache 审计篮子${coverage}，age=${formatMs(proof.ageMs)}`;
}

function isHighCoverageRollingAudit(
  row: { totals?: unknown; failedTokenIds?: unknown },
  source: string,
  coveragePct: number,
  tokenIds: string[]
): boolean {
  if (!source.includes('rolling-cache') || source.includes('partial')) return false;
  if (coveragePct < MIN_CASH_ROLLING_ROUTE_AUDIT_COVERAGE_PCT) return false;
  if (tokenIds.length === 0) return false;
  const totals = auditTotals(row.totals);
  if (!totals || totals.safe <= 0 || totals.scanned <= 0) return false;
  const minScanned = Math.min(totals.safe, MIN_CASH_ROLLING_ROUTE_AUDIT_SCANNED);
  if (totals.scanned < minScanned) return false;
  if (totals.tradable < tokenIds.length) return false;
  const failedTokenIds = stringArray(row.failedTokenIds);
  if (tokenIds.some((tokenId) => failedTokenIds.includes(tokenId))) return false;
  return true;
}

function auditTotals(value: unknown): { safe: number; scanned: number; tradable: number } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const row = value as { safe?: unknown; scanned?: unknown; tradable?: unknown };
  const safe = Number(row.safe ?? Number.NaN);
  const scanned = Number(row.scanned ?? Number.NaN);
  const tradable = Number(row.tradable ?? Number.NaN);
  if (![safe, scanned, tradable].every(Number.isFinite)) return undefined;
  return { safe, scanned, tradable };
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

function tokenIdsFromExecutionBasket(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .map((item) => item && typeof item === 'object' ? (item as { tokenId?: unknown }).tokenId : undefined)
    .filter((tokenId): tokenId is string => typeof tokenId === 'string' && tokenId.length > 0))];
}

function ageMsFromIso(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const ts = Date.parse(value);
  if (!Number.isFinite(ts)) return undefined;
  const ageMs = Date.now() - ts;
  return ageMs >= 0 ? ageMs : 0;
}

function isFullAuditSource(source: string): boolean {
  if (source.includes('partial')) return false;
  return source.includes('manual-full-audit') || source.includes('complete-cache');
}

function canonicalFullAuditSource(source: string): string {
  if (source.includes('manual-full-audit')) return 'manual-full-audit';
  if (source.includes('complete-cache')) return 'complete-cache';
  return source || 'complete-cache';
}

function publicRouteGroup(group: NonNullable<MarketRouteSelection['bestGroup']>) {
  return {
    groupKey: group.groupKey,
    marketId: group.marketId,
    question: group.question,
    outcomeCount: group.outcomeCount,
    score: group.score,
    expectedPpPerHour: group.expectedPpPerHour,
    ppPerThousandUsd: group.ppPerThousandUsd,
    targetOrderUsd: group.targetOrderUsd,
    rewardBandDepthUsd: group.rewardBandDepthUsd,
    topDepthUsd: group.topDepthUsd,
    remainingSafeHours: group.remainingSafeHours,
    legs: group.candidates.map(publicRouteCandidate)
  };
}

function publicSelectedRouteGroup(selected: MarketRouteCandidate[]) {
  const expectedPpPerHour = selected.reduce((sum, candidate) => sum + (candidate.metrics.expectedPpPerHour ?? 0), 0);
  const targetOrderUsd = selected.reduce((sum, candidate) => sum + (candidate.metrics.targetOrderUsd ?? 0), 0);
  const rewardBandDepthUsd = selected.reduce((sum, candidate) => sum + (candidate.metrics.rewardBandDepthUsd ?? 0), 0);
  const topDepthUsd = selected.reduce((sum, candidate) => sum + (candidate.metrics.topDepthUsd ?? 0), 0);
  const weightedEfficiency = targetOrderUsd > 0
    ? selected.reduce((sum, candidate) => sum + (candidate.metrics.ppPerThousandUsd ?? 0) * (candidate.metrics.targetOrderUsd ?? 0), 0) / targetOrderUsd
    : undefined;
  const first = selected[0];
  return {
    groupKey: first?.groupKey,
    marketId: first?.market.marketId,
    question: first?.market.question,
    outcomeCount: selected.length,
    score: Number(selected.reduce((sum, candidate) => sum + candidate.score, 0).toFixed(2)),
    expectedPpPerHour: Number(expectedPpPerHour.toFixed(4)),
    ppPerThousandUsd: weightedEfficiency === undefined ? undefined : Number(weightedEfficiency.toFixed(4)),
    targetOrderUsd: Number(targetOrderUsd.toFixed(4)),
    rewardBandDepthUsd: Number(rewardBandDepthUsd.toFixed(4)),
    topDepthUsd: Number(topDepthUsd.toFixed(4)),
    legs: selected.map(publicRouteCandidate)
  };
}

export function publicRouteCandidate(candidate: MarketRouteCandidate) {
  return {
    tokenId: candidate.market.tokenId,
    side: candidate.side,
    marketId: candidate.market.marketId,
    question: candidate.market.question,
    outcome: candidate.market.outcome,
    url: candidate.market.url,
    score: candidate.score,
    tradable: candidate.tradable,
    reasons: candidate.reasons.slice(0, 8),
    riskFlags: candidate.riskFlags.slice(0, 8),
    groupKey: candidate.groupKey,
    startTime: candidate.market.startTime,
    startTimeSource: candidate.market.startTimeSource,
    endTime: candidate.market.endTime,
    endTimeSource: candidate.market.endTimeSource,
    metrics: candidate.metrics
  };
}
