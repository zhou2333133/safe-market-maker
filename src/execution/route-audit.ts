import type { AppConfig } from '../config/schema.js';
import type { Market, Orderbook, VenueName } from '../domain/types.js';
import { marketTimeDecision } from '../risk/market-guard.js';
import { discoverRoutableMarkets } from '../strategy/market-discovery.js';
import { isPairedEntryMode } from '../strategy/paired-inventory.js';
import { rankMarketRoutes, selectMarketRoutes, type MarketRouteCandidate } from '../strategy/market-router.js';
import type { VenueAdapter } from '../venues/types.js';
import { applyCashFillCooldown, cashFillBlockedScope, type CashFillCooldown } from './cash-fill-cooldown.js';

export interface RouteAuditFailure {
  tokenId: string;
  marketId?: string;
  question: string;
  outcome?: string;
  error: string;
}

export interface RouteAuditResult {
  venue: VenueName;
  capturedAt: string;
  totals: {
    metadata: number;
    eligible: number;
    safe: number;
    scanned: number;
    failed: number;
    tradable: number;
  };
  selected: PublicRouteAuditCandidate[];
  topByExpected: PublicRouteAuditCandidate[];
  topByEfficiency: PublicRouteAuditCandidate[];
  rejectedTop: PublicRouteAuditCandidate[];
  failures: RouteAuditFailure[];
}

export interface RouteAuditOptions {
  top?: number;
  delayMs?: number;
  cashFillCooldown?: CashFillCooldown;
}

export interface BatchedRouteAuditOptions {
  top?: number;
  batchSize?: number;
  delayMs?: number;
  orderbookConcurrency?: number;
  orderbookTimeoutMs?: number;
  markets?: Market[];
  previousValue?: unknown;
  reset?: boolean;
  cashFillCooldown?: CashFillCooldown;
}

export type BatchedRouteAuditResult = RouteAuditResult & {
  executionBasket: PublicRouteAuditCandidate[];
  executionBasketCapturedAt?: string;
  latestFullAudit?: LatestFullRouteAuditProof;
  coveragePct: number;
  complete: boolean;
  source: string;
  progress: {
    runId: string;
    startedAt: string;
    updatedAt: string;
    cursor: number;
    total: number;
    scanned: number;
    failed: number;
    batchSize: number;
    orderbookConcurrency: number;
    orderbookTimeoutMs: number;
    remaining: number;
    complete: boolean;
  };
};

export interface LatestFullRouteAuditProof {
  capturedAt: string;
  source: string;
  coveragePct: number;
  totals: RouteAuditResult['totals'];
  executionBasket: PublicRouteAuditCandidate[];
  topByExpected: PublicRouteAuditCandidate[];
  topByEfficiency: PublicRouteAuditCandidate[];
  selected: PublicRouteAuditCandidate[];
}

interface PublicAuditOrderbook {
  venue: VenueName;
  tokenId: string;
  bids: Array<{ price: number; size: number }>;
  asks: Array<{ price: number; size: number }>;
  receivedAt: number;
}

interface BatchedRouteAuditState {
  venue: VenueName;
  runId: string;
  startedAt: string;
  cursor: number;
  books: PublicAuditOrderbook[];
  failures: RouteAuditFailure[];
  marketFingerprint: string;
  configFingerprint: string;
}

export type PublicRouteAuditCandidate = ReturnType<typeof publicRouteAuditCandidate>;

const FULL_AUDIT_PROOF_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const HIGH_COVERAGE_ROLLING_AUDIT_PCT = 60;
const MIN_HIGH_COVERAGE_ROLLING_AUDIT_SCANNED = 100;

export function buildRouteAuditFromSnapshot(
  config: AppConfig,
  venue: VenueName,
  allMarkets: Market[],
  books: Map<string, Orderbook>,
  options: { top?: number; failures?: RouteAuditFailure[]; cashFillCooldown?: CashFillCooldown } = {}
): RouteAuditResult {
  const top = Math.max(1, Math.min(100, options.top ?? 25));
  const sameVenue = allMarkets.filter((market) => market.venue === venue);
  const eligible = discoverRoutableMarkets(config, venue, sameVenue);
  const safe = eligible.filter((market) => marketTimeDecision(config, market).ok);
  return buildRouteAuditFromSafeMarkets(config, venue, sameVenue, safe, books, {
    top,
    failures: options.failures,
    eligibleCount: eligible.length,
    failureCount: Math.max(0, safe.length - books.size),
    cashFillCooldown: options.cashFillCooldown
  });
}

export function buildRouteAuditFromSafeMarkets(
  config: AppConfig,
  venue: VenueName,
  sameVenue: Market[],
  safe: Market[],
  books: Map<string, Orderbook>,
  options: { top?: number; failures?: RouteAuditFailure[]; eligibleCount?: number; failureCount?: number; cashFillCooldown?: CashFillCooldown } = {}
): RouteAuditResult {
  const top = Math.max(1, Math.min(100, options.top ?? 25));
  const ranked = rankMarketRoutes(config, venue, safe, books);
  const candidates = options.cashFillCooldown
    ? ranked.map((candidate) => applyCashFillCooldown(candidate, options.cashFillCooldown!))
    : ranked;
  const selection = selectMarketRoutes(config, venue, candidates);
  const tradable = candidates.filter((candidate) => candidate.tradable);
  const failures = options.failures ?? missingBookFailures(safe, books, top, 'orderbook unavailable in rolling route cache');
  return {
    venue,
    capturedAt: new Date().toISOString(),
    totals: {
      metadata: sameVenue.length,
      eligible: options.eligibleCount ?? safe.length,
      safe: safe.length,
      scanned: books.size,
      failed: options.failureCount ?? failures.length,
      tradable: tradable.length
    },
    selected: selection.selected.slice(0, top).map(publicRouteAuditCandidate),
    topByExpected: [...tradable]
      .sort((a, b) => routeExpected(b) - routeExpected(a))
      .slice(0, top)
      .map(publicRouteAuditCandidate),
    topByEfficiency: [...tradable]
      .sort((a, b) => (b.metrics.ppPerThousandUsd ?? 0) - (a.metrics.ppPerThousandUsd ?? 0) || routeExpected(b) - routeExpected(a))
      .slice(0, top)
      .map(publicRouteAuditCandidate),
    rejectedTop: candidates
      .filter((candidate) => !candidate.tradable)
      .slice(0, top)
      .map(publicRouteAuditCandidate),
    failures: failures.slice(0, top)
  };
}

export function routeAuditBasketForExecution(
  config: AppConfig,
  audit: RouteAuditResult
): PublicRouteAuditCandidate[] {
  const top = (isPairedEntryMode(config) ? audit.topByExpected : audit.topByEfficiency)
    .filter((candidate) => candidate.tradable);
  if (isPairedEntryMode(config)) return audit.selected.filter((candidate) => candidate.tradable);
  const maxMarkets = Math.max(1, config.risk.maxMarkets);
  const maxTokensPerMarket = Math.max(1, config.strategy.maxTokensPerMarket ?? 2);
  if (!config.strategy.dedupeMarketGroups) return uniqueAuditTokens(top).slice(0, maxMarkets);
  const selected: PublicRouteAuditCandidate[] = [];
  const byGroup = new Map<string, number>();
  const seenTokens = new Set<string>();
  for (const candidate of top) {
    if (seenTokens.has(candidate.tokenId)) continue;
    const key = candidate.groupKey ?? candidate.marketId ?? candidate.tokenId;
    const count = byGroup.get(key) ?? 0;
    if (count >= maxTokensPerMarket) continue;
    seenTokens.add(candidate.tokenId);
    byGroup.set(key, count + 1);
    selected.push(candidate);
    if (selected.length >= maxMarkets) break;
  }
  return selected;
}

export function mergeRouteAuditCheckpoint(
  config: AppConfig,
  rollingAudit: RouteAuditResult,
  previousValue: unknown,
  options: { cashFillCooldown?: CashFillCooldown } = {}
): RouteAuditResult & {
  executionBasket: PublicRouteAuditCandidate[];
  executionBasketCapturedAt?: string;
  latestFullAudit?: LatestFullRouteAuditProof;
  coveragePct: number;
  complete: boolean;
  source: string;
  failedTokenIds?: string[];
} {
  const rollingBasket = routeAuditBasketForExecution(config, rollingAudit);
  const rollingCoveragePct = routeAuditCoveragePct(rollingAudit);
  const rollingComplete = rollingAudit.totals.safe > 0
    && rollingAudit.totals.scanned >= rollingAudit.totals.safe
    && rollingAudit.totals.failed === 0;
  const previousBatch = previousManualBatchAuditValue(config, previousValue, options.cashFillCooldown);
  if (previousBatch !== undefined && !rollingComplete) {
    return {
      ...previousBatch,
      source: `${previousBatch.source}+rolling-cache-preserved`
    };
  }
  const previousFullProof = previousFullAuditProof(previousValue, options.cashFillCooldown);
  const previous = previousFullAuditValue(config, previousValue, options.cashFillCooldown);
  const previousHighCoverage = previousHighCoverageRollingAuditValue(config, previousValue, options.cashFillCooldown);
  const keepPreviousBasket = !rollingComplete
    && previous !== undefined
    && previous.executionBasket.length > 0
    && previous.executionBasket.every((candidate) => rollingAudit.totals.safe === 0 || candidate.tradable);
  if (!rollingComplete && !keepPreviousBasket && previousHighCoverage && rollingCoveragePct < HIGH_COVERAGE_ROLLING_AUDIT_PCT) {
    return {
      ...previousHighCoverage,
      source: 'rolling-cache-high-coverage+rolling-cache-preserved',
      ...(previousFullProof ? { latestFullAudit: previousFullProof } : {})
    };
  }
  const latestFullAudit = rollingComplete
    ? fullProofFromAudit(rollingAudit, rollingBasket, 'complete-cache')
    : previousFullProof;
  return {
    ...rollingAudit,
    executionBasket: keepPreviousBasket ? previous.executionBasket : rollingBasket,
    executionBasketCapturedAt: keepPreviousBasket
      ? previous.executionBasketCapturedAt
      : rollingAudit.capturedAt,
    coveragePct: rollingCoveragePct,
    complete: rollingComplete,
    source: keepPreviousBasket
      ? `${rollingComplete ? 'complete-cache' : 'rolling-cache'}+${previous.source}-basket`
      : rollingComplete ? 'complete-cache' : 'rolling-cache',
    ...(latestFullAudit ? { latestFullAudit } : {})
  };
}

function previousManualBatchAuditValue(
  config: AppConfig,
  value: unknown,
  cashFillCooldown?: CashFillCooldown
): (RouteAuditResult & {
  executionBasket: PublicRouteAuditCandidate[];
  executionBasketCapturedAt?: string;
  coveragePct: number;
  complete: boolean;
  source: string;
}) | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const row = value as RouteAuditResult & {
    executionBasket?: unknown;
    source?: unknown;
    complete?: unknown;
    capturedAt?: unknown;
    progress?: unknown;
    coveragePct?: unknown;
  };
  if (row.complete === true) return undefined;
  if (typeof row.source !== 'string' || !row.source.includes('manual-full-audit-partial')) return undefined;
  if (typeof row.capturedAt !== 'string') return undefined;
  const capturedAt = Date.parse(row.capturedAt);
  const maxAgeMs = Math.max(2 * 60_000, Math.min(30 * 60_000, (config.strategy.marketRefreshMs ?? 60_000) * 30));
  if (!Number.isFinite(capturedAt) || Date.now() - capturedAt > maxAgeMs) return undefined;
  if (!Array.isArray(row.executionBasket)) return undefined;
  const executionBasket = filterPublicCandidatesForCashFillCooldown(row.executionBasket.filter(isPublicRouteAuditCandidate), cashFillCooldown);
  if (executionBasket.length === 0) return undefined;
  return {
    ...row,
    executionBasket,
    selected: filterPublicCandidatesForCashFillCooldown(Array.isArray(row.selected) ? row.selected.filter(isPublicRouteAuditCandidate) : [], cashFillCooldown),
    topByExpected: filterPublicCandidatesForCashFillCooldown(Array.isArray(row.topByExpected) ? row.topByExpected.filter(isPublicRouteAuditCandidate) : [], cashFillCooldown),
    topByEfficiency: filterPublicCandidatesForCashFillCooldown(Array.isArray(row.topByEfficiency) ? row.topByEfficiency.filter(isPublicRouteAuditCandidate) : [], cashFillCooldown),
    rejectedTop: Array.isArray(row.rejectedTop) ? row.rejectedTop.filter(isPublicRouteAuditCandidate) : [],
    coveragePct: Number.isFinite(Number(row.coveragePct)) ? Number(row.coveragePct) : routeAuditCoveragePct(row),
    complete: false,
    source: row.source
  };
}

export async function auditRouteOpportunities(
  config: AppConfig,
  venue: VenueName,
  adapter: VenueAdapter,
  options: RouteAuditOptions = {}
): Promise<RouteAuditResult> {
  const top = Math.max(1, Math.min(100, options.top ?? 25));
  const delayMs = Math.max(0, options.delayMs ?? 250);
  const allMarkets = (await adapter.getMarkets()).filter((market) => market.venue === venue);
  adapter.hydrateFromMarkets?.(allMarkets);
  const eligible = discoverRoutableMarkets(config, venue, allMarkets);
  const safe = eligible.filter((market) => marketTimeDecision(config, market).ok);
  const books = new Map<string, Orderbook>();
  const failures: RouteAuditFailure[] = [];
  for (const market of safe) {
    try {
      books.set(market.tokenId, await adapter.getOrderbook(market.tokenId));
    } catch (error) {
      failures.push({
        tokenId: market.tokenId,
        ...(market.marketId ? { marketId: market.marketId } : {}),
        question: market.question,
        ...(market.outcome ? { outcome: market.outcome } : {}),
        error: publicError(error)
      });
    }
    if (delayMs > 0) await sleep(delayMs);
  }
  return buildRouteAuditFromSafeMarkets(config, venue, allMarkets, safe, books, {
    top,
    failures,
    eligibleCount: eligible.length,
    failureCount: failures.length,
    cashFillCooldown: options.cashFillCooldown
  });
}

export async function auditRouteOpportunitiesBatch(
  config: AppConfig,
  venue: VenueName,
  adapter: VenueAdapter,
  options: BatchedRouteAuditOptions = {}
): Promise<BatchedRouteAuditResult> {
  const top = Math.max(1, Math.min(100, options.top ?? 60));
  const batchSize = Math.max(1, Math.min(60, Math.trunc(options.batchSize ?? 40)));
  const delayMs = Math.max(0, options.delayMs ?? 50);
  const orderbookConcurrency = Math.max(1, Math.min(8, Math.trunc(options.orderbookConcurrency ?? 6)));
  const orderbookTimeoutMs = Math.max(500, Math.min(10_000, Math.trunc(options.orderbookTimeoutMs ?? 6_000)));
  const allMarkets = (options.markets ?? await adapter.getMarkets()).filter((market) => market.venue === venue);
  adapter.hydrateFromMarkets?.(allMarkets);
  const eligible = discoverRoutableMarkets(config, venue, allMarkets);
  const safe = eligible.filter((market) => marketTimeDecision(config, market).ok);
  const previous = options.reset ? undefined : batchedRouteAuditState(options.previousValue, venue);
  const sameUniverse = previous
    && previous.marketFingerprint === marketFingerprint(safe)
    && previous.configFingerprint === routeAuditConfigFingerprint(config);
  const startedAt = sameUniverse ? previous.startedAt : new Date().toISOString();
  const runId = sameUniverse ? previous.runId : newAuditRunId();
  const books = sameUniverse ? orderbooksFromPublic(previous.books, venue) : new Map<string, Orderbook>();
  const failures = sameUniverse ? previous.failures : [];
  const failedTokenIds = new Set(failures.map((failure) => failure.tokenId));
  const cursor = sameUniverse ? Math.min(previous.cursor, safe.length) : 0;
  const end = Math.min(safe.length, cursor + batchSize);
  await mapWithConcurrency(safe.slice(cursor, end), orderbookConcurrency, async (market) => {
    try {
      books.set(market.tokenId, await withTimeout(
        adapter.getOrderbook(market.tokenId),
        orderbookTimeoutMs,
        `route audit orderbook ${market.tokenId}`
      ));
    } catch (error) {
      failedTokenIds.add(market.tokenId);
      if (!failures.some((failure) => failure.tokenId === market.tokenId)) {
        failures.push({
          tokenId: market.tokenId,
          ...(market.marketId ? { marketId: market.marketId } : {}),
          question: market.question,
          ...(market.outcome ? { outcome: market.outcome } : {}),
          error: publicError(error)
        });
      }
    }
    if (delayMs > 0) await sleep(delayMs);
  });
  const nextCursor = end;
  const complete = safe.length === 0 || nextCursor >= safe.length;
  const audit = buildRouteAuditFromSafeMarkets(config, venue, allMarkets, safe, books, {
    top,
    failures,
    eligibleCount: eligible.length,
    cashFillCooldown: options.cashFillCooldown
  });
  const basket = routeAuditBasketForExecution(config, audit);
  const updatedAt = new Date().toISOString();
  const previousFullProof = previousFullAuditProof(options.previousValue, options.cashFillCooldown);
  const latestFullAudit = complete
    ? fullProofFromAudit(audit, basket, 'manual-full-audit')
    : previousFullProof;
  return {
    ...audit,
    executionBasket: basket,
    executionBasketCapturedAt: complete ? audit.capturedAt : undefined,
    ...(latestFullAudit ? { latestFullAudit } : {}),
    coveragePct: routeAuditCoveragePct(audit),
    complete,
    source: complete ? 'manual-full-audit' : 'manual-full-audit-partial',
    progress: {
      runId,
      startedAt,
      updatedAt,
      cursor: nextCursor,
      total: safe.length,
      scanned: books.size,
      failed: failedTokenIds.size,
      batchSize,
      orderbookConcurrency,
      orderbookTimeoutMs,
      remaining: Math.max(0, safe.length - nextCursor),
      complete
    },
    runId,
    startedAt,
    cursor: nextCursor,
    books: publicOrderbooks(books),
    marketFingerprint: marketFingerprint(safe),
    configFingerprint: routeAuditConfigFingerprint(config)
  } as BatchedRouteAuditResult & {
    books: PublicAuditOrderbook[];
    marketFingerprint: string;
    configFingerprint: string;
  };
}

function publicRouteAuditCandidate(candidate: MarketRouteCandidate) {
  return {
    tokenId: candidate.market.tokenId,
    side: candidate.side,
    ...(candidate.market.marketId ? { marketId: candidate.market.marketId } : {}),
    ...(candidate.groupKey ? { groupKey: candidate.groupKey } : {}),
    question: candidate.market.question,
    ...(candidate.market.outcome ? { outcome: candidate.market.outcome } : {}),
    tradable: candidate.tradable,
    score: candidate.score,
    riskFlags: candidate.riskFlags.slice(0, 6),
    reasons: candidate.reasons.slice(0, 8),
    metrics: {
      ppPerHour: candidate.metrics.ppPerHour,
      expectedPpPerHour: candidate.metrics.expectedPpPerHour,
      ppPerThousandUsd: candidate.metrics.ppPerThousandUsd,
      targetSharePct: candidate.metrics.targetSharePct,
      rewardBandDepthUsd: candidate.metrics.rewardBandDepthUsd,
      topDepthUsd: candidate.metrics.topDepthUsd,
      targetOrderUsd: candidate.metrics.targetOrderUsd,
      targetShares: candidate.metrics.targetShares,
      minRewardNotionalUsd: candidate.metrics.minRewardNotionalUsd,
      competitionBand: candidate.metrics.competitionBand,
      spreadCents: candidate.metrics.spreadCents,
      remainingSafeHours: candidate.metrics.remainingSafeHours
    }
  };
}

function uniqueAuditTokens(candidates: PublicRouteAuditCandidate[]): PublicRouteAuditCandidate[] {
  const seen = new Set<string>();
  const result: PublicRouteAuditCandidate[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.tokenId)) continue;
    seen.add(candidate.tokenId);
    result.push(candidate);
  }
  return result;
}

function routeExpected(candidate: MarketRouteCandidate): number {
  return candidate.metrics.expectedPpPerHour ?? 0;
}

function missingBookFailures(safe: Market[], books: Map<string, Orderbook>, top: number, error: string): RouteAuditFailure[] {
  return safe
    .filter((market) => !books.has(market.tokenId))
    .slice(0, top)
    .map((market) => ({
      tokenId: market.tokenId,
      ...(market.marketId ? { marketId: market.marketId } : {}),
      question: market.question,
      ...(market.outcome ? { outcome: market.outcome } : {}),
      error
    }));
}

function routeAuditCoveragePct(audit: RouteAuditResult): number {
  return audit.totals.safe > 0 ? Number((audit.totals.scanned / audit.totals.safe * 100).toFixed(2)) : 0;
}

function previousFullAuditValue(
  config: AppConfig,
  value: unknown,
  cashFillCooldown?: CashFillCooldown
): { executionBasket: PublicRouteAuditCandidate[]; executionBasketCapturedAt: string; source: string } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const row = value as { executionBasket?: unknown; executionBasketCapturedAt?: unknown; source?: unknown; complete?: unknown; capturedAt?: unknown };
  const source = canonicalFullAuditSource(typeof row.source === 'string' ? row.source : '');
  if (row.complete !== true && !source.includes('manual-full-audit') && !source.includes('complete-cache')) return undefined;
  const capturedAtSource = typeof row.executionBasketCapturedAt === 'string'
    ? row.executionBasketCapturedAt
    : typeof row.capturedAt === 'string' ? row.capturedAt : undefined;
  if (!capturedAtSource) return undefined;
  const capturedAt = Date.parse(capturedAtSource);
  const maxAgeMs = Math.max(60_000, Math.min(20 * 60_000, (config.strategy.marketRefreshMs ?? 60_000) * 20));
  if (!Number.isFinite(capturedAt) || Date.now() - capturedAt > maxAgeMs) return undefined;
  if (!Array.isArray(row.executionBasket)) return undefined;
  const executionBasket = filterPublicCandidatesForCashFillCooldown(row.executionBasket.filter(isPublicRouteAuditCandidate), cashFillCooldown);
  if (executionBasket.length === 0) return undefined;
  return { executionBasket, executionBasketCapturedAt: capturedAtSource, source: source || 'complete-cache' };
}

function previousHighCoverageRollingAuditValue(
  config: AppConfig,
  value: unknown,
  cashFillCooldown?: CashFillCooldown
): (RouteAuditResult & {
  executionBasket: PublicRouteAuditCandidate[];
  executionBasketCapturedAt?: string;
  coveragePct: number;
  complete: boolean;
  source: string;
}) | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const row = value as RouteAuditResult & {
    executionBasket?: unknown;
    executionBasketCapturedAt?: unknown;
    source?: unknown;
    complete?: unknown;
    capturedAt?: unknown;
    coveragePct?: unknown;
  };
  const source = typeof row.source === 'string' ? row.source : '';
  if (!source.includes('rolling-cache') || source.includes('partial')) return undefined;
  if (row.complete === true || source.includes('manual-full-audit') || source.includes('complete-cache')) return undefined;
  if (!isRouteAuditTotals(row.totals)) return undefined;
  const coveragePct = Number(row.coveragePct ?? routeAuditCoveragePct(row));
  if (!Number.isFinite(coveragePct) || coveragePct < HIGH_COVERAGE_ROLLING_AUDIT_PCT) return undefined;
  const minScanned = Math.min(row.totals.safe, MIN_HIGH_COVERAGE_ROLLING_AUDIT_SCANNED);
  if (row.totals.safe <= 0 || row.totals.scanned < minScanned) return undefined;
  const capturedAtSource = typeof row.executionBasketCapturedAt === 'string'
    ? row.executionBasketCapturedAt
    : typeof row.capturedAt === 'string' ? row.capturedAt : undefined;
  if (!capturedAtSource) return undefined;
  const capturedAt = Date.parse(capturedAtSource);
  const maxAgeMs = Math.max(60_000, Math.min(20 * 60_000, (config.strategy.marketRefreshMs ?? 60_000) * 20));
  if (!Number.isFinite(capturedAt) || Date.now() - capturedAt > maxAgeMs) return undefined;
  if (!Array.isArray(row.executionBasket)) return undefined;
  const executionBasket = filterPublicCandidatesForCashFillCooldown(row.executionBasket.filter(isPublicRouteAuditCandidate), cashFillCooldown);
  if (executionBasket.length === 0 || row.totals.tradable < executionBasket.length) return undefined;
  return {
    ...row,
    executionBasket,
    selected: filterPublicCandidatesForCashFillCooldown(Array.isArray(row.selected) ? row.selected.filter(isPublicRouteAuditCandidate) : [], cashFillCooldown),
    topByExpected: filterPublicCandidatesForCashFillCooldown(Array.isArray(row.topByExpected) ? row.topByExpected.filter(isPublicRouteAuditCandidate) : [], cashFillCooldown),
    topByEfficiency: filterPublicCandidatesForCashFillCooldown(Array.isArray(row.topByEfficiency) ? row.topByEfficiency.filter(isPublicRouteAuditCandidate) : [], cashFillCooldown),
    rejectedTop: Array.isArray(row.rejectedTop) ? row.rejectedTop.filter(isPublicRouteAuditCandidate) : [],
    executionBasketCapturedAt: capturedAtSource,
    coveragePct,
    complete: false,
    source: 'rolling-cache-high-coverage'
  };
}

function previousFullAuditProof(value: unknown, cashFillCooldown?: CashFillCooldown): LatestFullRouteAuditProof | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const row = value as Record<string, unknown>;
  const nested = parseFullAuditProof(row.latestFullAudit, cashFillCooldown);
  if (nested) return nested;
  const source = canonicalFullAuditSource(typeof row.source === 'string' ? row.source : '');
  if (row.complete !== true && !source.includes('manual-full-audit') && !source.includes('complete-cache')) return undefined;
  const capturedAt = typeof row.executionBasketCapturedAt === 'string'
    ? row.executionBasketCapturedAt
    : typeof row.capturedAt === 'string' ? row.capturedAt : undefined;
  return parseFullAuditProof({
    capturedAt,
    source: source || 'complete-cache',
    coveragePct: row.coveragePct,
    totals: row.totals,
    executionBasket: row.executionBasket,
    topByExpected: row.topByExpected,
    topByEfficiency: row.topByEfficiency,
    selected: row.selected
  }, cashFillCooldown);
}

function parseFullAuditProof(value: unknown, cashFillCooldown?: CashFillCooldown): LatestFullRouteAuditProof | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const row = value as Record<string, unknown>;
  if (typeof row.capturedAt !== 'string') return undefined;
  const capturedAt = Date.parse(row.capturedAt);
  if (!Number.isFinite(capturedAt) || Date.now() - capturedAt > FULL_AUDIT_PROOF_MAX_AGE_MS) return undefined;
  const executionBasket = Array.isArray(row.executionBasket)
    ? filterPublicCandidatesForCashFillCooldown(row.executionBasket.filter(isPublicRouteAuditCandidate), cashFillCooldown)
    : [];
  if (executionBasket.length === 0) return undefined;
  return {
    capturedAt: row.capturedAt,
    source: typeof row.source === 'string' && row.source ? row.source : 'manual-full-audit',
    coveragePct: Number.isFinite(Number(row.coveragePct)) ? Number(row.coveragePct) : 100,
    totals: isRouteAuditTotals(row.totals) ? row.totals : {
      metadata: 0,
      eligible: 0,
      safe: 0,
      scanned: 0,
      failed: 0,
      tradable: 0
    },
    executionBasket,
    topByExpected: Array.isArray(row.topByExpected) ? filterPublicCandidatesForCashFillCooldown(row.topByExpected.filter(isPublicRouteAuditCandidate), cashFillCooldown) : [],
    topByEfficiency: Array.isArray(row.topByEfficiency) ? filterPublicCandidatesForCashFillCooldown(row.topByEfficiency.filter(isPublicRouteAuditCandidate), cashFillCooldown) : [],
    selected: Array.isArray(row.selected) ? filterPublicCandidatesForCashFillCooldown(row.selected.filter(isPublicRouteAuditCandidate), cashFillCooldown) : []
  };
}

function fullProofFromAudit(
  audit: RouteAuditResult,
  executionBasket: PublicRouteAuditCandidate[],
  source: string
): LatestFullRouteAuditProof {
  return {
    capturedAt: audit.capturedAt,
    source,
    coveragePct: routeAuditCoveragePct(audit),
    totals: audit.totals,
    executionBasket,
    topByExpected: audit.topByExpected,
    topByEfficiency: audit.topByEfficiency,
    selected: audit.selected
  };
}

function isRouteAuditTotals(value: unknown): value is RouteAuditResult['totals'] {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return ['metadata', 'eligible', 'safe', 'scanned', 'failed', 'tradable']
    .every((key) => Number.isFinite(Number(row[key])));
}

function canonicalFullAuditSource(source: string): string {
  if (source.includes('manual-full-audit')) return 'manual-full-audit';
  if (source.includes('complete-cache')) return 'complete-cache';
  return source;
}

function isPublicRouteAuditCandidate(value: unknown): value is PublicRouteAuditCandidate {
  return Boolean(
    value
    && typeof value === 'object'
    && typeof (value as { tokenId?: unknown }).tokenId === 'string'
    && (value as { tradable?: unknown }).tradable !== false
  );
}

function filterPublicCandidatesForCashFillCooldown(
  candidates: PublicRouteAuditCandidate[],
  cooldown: CashFillCooldown | undefined
): PublicRouteAuditCandidate[] {
  if (!cooldown) return candidates;
  return candidates.filter((candidate) => !cashFillBlockedScope(candidate.tokenId, candidate.marketId, cooldown));
}

function publicError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 240);
}

function batchedRouteAuditState(value: unknown, venue: VenueName): BatchedRouteAuditState | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const row = value as Record<string, unknown>;
  if (row.venue !== venue) return undefined;
  if (typeof row.runId !== 'string' || typeof row.startedAt !== 'string') return undefined;
  if (typeof row.marketFingerprint !== 'string' || typeof row.configFingerprint !== 'string') return undefined;
  const cursor = Number(row.cursor);
  if (!Number.isFinite(cursor) || cursor < 0) return undefined;
  const books = Array.isArray(row.books) ? row.books.filter(isPublicAuditOrderbook) : [];
  const failures = Array.isArray(row.failures) ? row.failures.filter(isRouteAuditFailure) : [];
  return {
    venue,
    runId: row.runId,
    startedAt: row.startedAt,
    cursor: Math.trunc(cursor),
    books,
    failures,
    marketFingerprint: row.marketFingerprint,
    configFingerprint: row.configFingerprint
  };
}

function publicOrderbooks(books: Map<string, Orderbook>): PublicAuditOrderbook[] {
  return [...books.values()].map((book) => ({
    venue: book.venue,
    tokenId: book.tokenId,
    bids: book.bids.slice(0, 20).map((level) => ({ price: level.price, size: level.size })),
    asks: book.asks.slice(0, 20).map((level) => ({ price: level.price, size: level.size })),
    receivedAt: book.receivedAt
  }));
}

function orderbooksFromPublic(books: PublicAuditOrderbook[], venue: VenueName): Map<string, Orderbook> {
  return new Map(books
    .filter((book) => book.venue === venue)
    .map((book) => [book.tokenId, {
      venue: book.venue,
      tokenId: book.tokenId,
      bids: book.bids,
      asks: book.asks,
      receivedAt: book.receivedAt
    }] as const));
}

function isPublicAuditOrderbook(value: unknown): value is PublicAuditOrderbook {
  if (!value || typeof value !== 'object') return false;
  const row = value as PublicAuditOrderbook;
  return (
    (row.venue === 'predict' || row.venue === 'polymarket')
    && typeof row.tokenId === 'string'
    && Array.isArray(row.bids)
    && Array.isArray(row.asks)
    && Number.isFinite(Number(row.receivedAt))
  );
}

function isRouteAuditFailure(value: unknown): value is RouteAuditFailure {
  return Boolean(
    value
    && typeof value === 'object'
    && typeof (value as { tokenId?: unknown }).tokenId === 'string'
    && typeof (value as { question?: unknown }).question === 'string'
    && typeof (value as { error?: unknown }).error === 'string'
  );
}

function marketFingerprint(markets: Market[]): string {
  return markets.map((market) => market.tokenId).sort().join('|');
}

function routeAuditConfigFingerprint(config: AppConfig): string {
  return JSON.stringify({
    maxMarkets: config.risk.maxMarkets,
    orderSizeUsd: config.risk.orderSizeUsd,
    maxSingleOrderUsd: config.risk.maxSingleOrderUsd,
    maxPositionUsd: config.risk.maxPositionUsd,
    minDepthUsdPerSide: config.risk.minDepthUsdPerSide,
    minPrice: config.risk.minPrice,
    maxPrice: config.risk.maxPrice,
    entryMode: config.strategy.entryMode,
    quoteSide: config.strategy.quoteSide,
    minMarketLiquidityUsd: config.strategy.minMarketLiquidityUsd,
    minRewardLevel: config.strategy.minRewardLevel,
    minRewardSizeMultiplier: config.strategy.minRewardSizeMultiplier,
    enforceRewardMinimum: config.strategy.enforceRewardMinimum,
    pointsOnly: config.strategy.pointsOnly,
    acceptingOnly: config.strategy.acceptingOnly,
    dedupeMarketGroups: config.strategy.dedupeMarketGroups,
    maxTokensPerMarket: config.strategy.maxTokensPerMarket,
    cashProbeMinFrontDepthUsd: config.strategy.cashProbeMinFrontDepthUsd,
    cashProbeDepthMultiplier: config.strategy.cashProbeDepthMultiplier,
    cashProbeMaxSupportGapCents: config.strategy.cashProbeMaxSupportGapCents,
    cashProbeNeverTopOfBook: config.strategy.cashProbeNeverTopOfBook
  });
}

function newAuditRunId(): string {
  return `audit-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
}

async function mapWithConcurrency<T>(
  items: T[],
  concurrency: number,
  task: (item: T) => Promise<void>
): Promise<void> {
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const item = items[nextIndex];
      nextIndex += 1;
      if (item !== undefined) await task(item);
    }
  }));
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
