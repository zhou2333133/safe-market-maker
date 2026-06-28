import type { AppConfig } from '../config/schema.js';
import { normalizeLiveStrategyConfig } from '../config/schema.js';
import { liveEnabledByVenue, venueLiveEnabled } from '../config/live-enabled.js';
import { ensureDataDirs, loadConfig, saveConfig } from '../config/load.js';
import { resolveVenueConfig } from '../config/venue-config.js';
import { existsSync } from 'node:fs';
import type { AccountRiskDecision, AccountRiskSnapshot, Balance, Market, OpenOrder, Orderbook, Position, VenueName } from '../domain/types.js';
import { disabledPlugins } from '../plugins/registry.js';
import { dayStartTs, evaluateAccountRisk } from '../risk/account-risk.js';
import { StrategyEngine } from '../strategy/strategy-engine.js';
import { createVenue } from '../venues/factory.js';
import { usingStore } from '../store/ui-store.js';
import { getSharedCachedMarkets } from '../execution/market-data-sync.js';
import { computeStartupFacts } from '../execution/startup-facts.js';
import { enrichMarketsWithPositionMarkets } from '../execution/market-data-sync.js';
import { planMarketOrderbookScan } from '../strategy/market-discovery.js';
import { isPairedEntryMode } from '../strategy/paired-inventory.js';
import { auditRouteOpportunitiesBatch } from '../execution/route-audit.js';
import { buildCashFillCooldown } from '../execution/cash-fill-cooldown.js';
import { liveStatus, type LiveLoops } from './live-loop-state.js';
import { UiError } from './errors.js';
import { credentialPath, hasWallet } from '../secrets/keystore.js';
import { hasRuntimeCredential, runtimeSignerStatus } from '../secrets/runtime.js';
import { publicLiveRunIntents } from './live-intent.js';
import { accountRiskWindowStart } from '../risk/risk-window.js';
import {
  accountRiskDecision,
  asRecord,
  balanceAddress,
  boundedNumber,
  configWithRecommendationFilters,
  createVenueForUi,
  decorateRecommendation,
  filterMarkets,
  loadSignerForUi,
  parseBoolean,
  parseTradingMode,
  parseVenueParam,
  publicBalance,
  readStatus,
  recommendationFilters,
  rejectStats,
  requiredString,
  settleReadWithTimeout,
  valueOrEmpty,
  withRequestTimeout
} from './controller-utils.js';
import { generatePredictReport } from '../strategy/rewards/predict-report.js';

const BALANCE_REFRESH_TIMEOUT_MS = 4000;
const STARTUP_FACTS_TIMEOUT_MS = 8000;
const STARTUP_FACT_READ_TIMEOUT_MS = 6500;
const STARTUP_FACT_MARKETS_READ_TIMEOUT_MS = 12000;
const STARTUP_FACT_BOOKS_READ_TIMEOUT_MS = 6500;

type PublicRouteItem = {
  tokenId?: string;
  side?: string;
  marketId?: string;
  question?: string;
  outcome?: string;
  score?: number;
  tradable?: boolean;
  reasons?: string[];
  riskFlags?: string[];
  groupKey?: string;
  startTime?: string;
  startTimeSource?: string;
  endTime?: string;
  endTimeSource?: string;
  metrics?: Record<string, unknown>;
};

type PublicRouteGroup = {
  groupKey?: string;
  marketId?: string;
  question?: string;
  outcomeCount?: number;
  score?: number;
  expectedPpPerHour?: number;
  ppPerThousandUsd?: number;
  targetOrderUsd?: number;
  rewardBandDepthUsd?: number;
  topDepthUsd?: number;
  remainingSafeHours?: number;
  legs?: PublicRouteItem[];
};

type RouteCheckpointValue = {
  mode?: string;
  reason?: string;
  switched?: boolean;
  fillCircuitBreaker?: boolean;
  canceledManagedOrders?: number;
  cashExit?: {
    attempted?: boolean;
    submitted?: number;
    blocked?: number;
    failed?: number;
  };
  selected?: PublicRouteItem[];
  best?: PublicRouteItem;
  selectedGroup?: PublicRouteGroup;
  bestGroup?: PublicRouteGroup;
  previousGroup?: PublicRouteGroup;
  candidates?: PublicRouteItem[];
};

export async function status(configPath: string, serverInfo: { host: string; port: number }, liveLoops: LiveLoops): Promise<unknown> {
  return readUiStatus(configPath, serverInfo, liveLoops, { summary: false });
}

export async function statusSummary(configPath: string, serverInfo: { host: string; port: number }, liveLoops: LiveLoops): Promise<unknown> {
  return readUiStatus(configPath, serverInfo, liveLoops, { summary: true });
}

async function readUiStatus(
  configPath: string,
  serverInfo: { host: string; port: number },
  liveLoops: LiveLoops,
  options: { summary: boolean }
): Promise<unknown> {
  const loaded = loadConfig(configPath);
  ensureDataDirs(loaded.dataDir);
  const store = usingStore(loaded.dataDir);
  try {
    const venueLive = liveEnabledByVenue(loaded.config);
    const accountRisk = {
      predict: {
        decision: store.getLatestAccountRiskDecision('predict'),
        snapshot: store.getLatestAccountRiskSnapshot('predict')
      },
      polymarket: {
        decision: store.getLatestAccountRiskDecision('polymarket'),
        snapshot: store.getLatestAccountRiskSnapshot('polymarket')
      }
    };
    const riskWindows = {
      predict: riskWindowForUi('predict', store, accountRisk.predict.snapshot),
      polymarket: riskWindowForUi('polymarket', store, accountRisk.polymarket.snapshot)
    };
    const fills = {
      predict: store.summarizeFills('predict', riskWindows.predict.sinceTs),
      polymarket: store.summarizeFills('polymarket', riskWindows.polymarket.sinceTs)
    };
    const openOrders = store.listOpenOrders()
      .filter((order) => order.status === 'OPEN' || order.status === 'PENDING_OPEN');
    const activeOrders = openOrders.map(publicActiveOrder);
    return {
      ok: true,
      server: serverInfo,
      predictReport: await predictReportSnapshot(loaded, store),
      live: liveStatus(liveLoops).live,
      liveIntent: publicLiveRunIntents(loaded.dataDir),
      config: {
        liveEnabled: loaded.config.liveEnabled,
        liveEnabledByVenue: venueLive,
        dataDir: loaded.config.dataDir,
        risk: loaded.config.risk,
        strategy: loaded.config.strategy,
        polymarketParams: loaded.config.polymarketParams,
        predictParams: loaded.config.predictParams,
        wallets: {
          predict: hasWallet(loaded.dataDir, 'predict'),
          polymarket: hasWallet(loaded.dataDir, 'polymarket')
        },
        credentials: {
          predictJwt: existsSync(credentialPath(loaded.dataDir, 'predict', 'jwt')),
          polymarketClob: existsSync(credentialPath(loaded.dataDir, 'polymarket', 'clob'))
        },
        runtime: {
          signer: {
            predict: runtimeSignerStatus(loaded.dataDir, 'predict'),
            polymarket: runtimeSignerStatus(loaded.dataDir, 'polymarket')
          },
          credentials: {
            predict: hasRuntimeCredential('predict'),
            polymarket: hasRuntimeCredential('polymarket')
          }
        },
        venues: {
          predict: {
            enabled: loaded.config.venues.predict.enabled,
            liveEnabled: venueLive.predict,
            apiKeyConfigured: Boolean(loaded.config.venues.predict.apiKey),
            accountAddress: loaded.config.venues.predict.accountAddress
          },
          polymarket: {
            enabled: loaded.config.venues.polymarket.enabled,
            liveEnabled: venueLive.polymarket,
            funderAddress: loaded.config.venues.polymarket.funderAddress,
            signatureType: loaded.config.venues.polymarket.signatureType
          }
        },
        selectedMarkets: {
          predict: loaded.config.selectedMarkets.predict.length,
          polymarket: loaded.config.selectedMarkets.polymarket.length
        }
      },
      store: store.status(),
      route: {
        predict: routeCheckpointForUi(store.getCheckpoint('route.predict'), options.summary),
        polymarket: routeCheckpointForUi(store.getCheckpoint('route.polymarket'), options.summary)
      },
      marketScan: {
        predict: store.getCheckpoint('market-scan.predict'),
        polymarket: store.getCheckpoint('market-scan.polymarket')
      },
      routeAudit: {
        predict: routeAuditCheckpointForUi(store.getCheckpoint('route-audit.predict'), options.summary),
        polymarket: routeAuditCheckpointForUi(store.getCheckpoint('route-audit.polymarket'), options.summary)
      },
      stage: {
        predict: store.getCheckpoint('stage.predict'),
        polymarket: store.getCheckpoint('stage.polymarket')
      },
      wsHealth: {
        predict: store.getCheckpoint('ws-health.predict'),
        polymarket: store.getCheckpoint('ws-health.polymarket')
      },
      fillCircuitBreaker: {
        predict: store.getCheckpoint('fill-circuit-breaker.predict'),
        polymarket: store.getCheckpoint('fill-circuit-breaker.polymarket')
      },
      rejectStats: {
        predict: rejectStats(store.listRecentEvents(100).filter((event) => event.venue === 'predict')),
        polymarket: rejectStats(store.listRecentEvents(100).filter((event) => event.venue === 'polymarket'))
      },
      accountRisk,
      accountLive: {
        predict: accountLiveForUi('predict', accountRisk.predict.decision, accountRisk.predict.snapshot, loaded.config.risk.maxAccountRiskStaleMs),
        polymarket: accountLiveForUi('polymarket', accountRisk.polymarket.decision, accountRisk.polymarket.snapshot, loaded.config.risk.maxAccountRiskStaleMs)
      },
      orderRisk: {
        predict: openOrderRiskForUi('predict', loaded.config, accountRisk.predict.decision, openOrders),
        polymarket: openOrderRiskForUi('polymarket', loaded.config, accountRisk.polymarket.decision, openOrders)
      },
      riskWindows,
      fills,
      activeOrders,
      orders: store.listRecentOrders(options.summary ? 12 : 20),
      events: store.listRecentEvents(options.summary ? 12 : 20),
      disabledPlugins
    };
  } finally {
    store.close();
  }
}

function routeCheckpointForUi(
  checkpoint: { name: string; ts: string; value: unknown } | undefined,
  summary: boolean
): { name: string; ts: string; value: unknown } | undefined {
  if (!checkpoint || !summary) return checkpoint;
  return {
    ...checkpoint,
    value: summarizeRouteCheckpointValue(checkpoint.value)
  };
}

function summarizeRouteCheckpointValue(value: unknown): RouteCheckpointValue {
  if (!value || typeof value !== 'object') return {};
  const route = value as RouteCheckpointValue;
  const selected = Array.isArray(route.selected) ? route.selected.slice(0, 25).map(summarizeRouteItem) : [];
  const candidates = Array.isArray(route.candidates) ? route.candidates.slice(0, 25).map(summarizeRouteItem) : [];
  return {
    mode: route.mode,
    reason: route.reason,
    switched: route.switched,
    fillCircuitBreaker: route.fillCircuitBreaker,
    canceledManagedOrders: route.canceledManagedOrders,
    ...(route.cashExit ? { cashExit: route.cashExit } : {}),
    selected,
    ...(route.best ? { best: summarizeRouteItem(route.best) } : {}),
    ...(route.selectedGroup ? { selectedGroup: summarizeRouteGroup(route.selectedGroup) } : {}),
    ...(route.bestGroup ? { bestGroup: summarizeRouteGroup(route.bestGroup) } : {}),
    ...(route.previousGroup ? { previousGroup: summarizeRouteGroup(route.previousGroup) } : {}),
    candidates
  };
}

function summarizeRouteGroup(group: PublicRouteGroup): PublicRouteGroup {
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
    legs: Array.isArray(group.legs) ? group.legs.slice(0, 25).map(summarizeRouteItem) : []
  };
}

function summarizeRouteItem(item: PublicRouteItem): PublicRouteItem {
  return {
    tokenId: item.tokenId,
    side: item.side,
    marketId: item.marketId,
    question: item.question,
    outcome: item.outcome,
    score: item.score,
    tradable: item.tradable,
    reasons: Array.isArray(item.reasons) ? item.reasons.slice(0, 4) : [],
    riskFlags: Array.isArray(item.riskFlags) ? item.riskFlags.slice(0, 4) : [],
    groupKey: item.groupKey,
    startTime: item.startTime,
    startTimeSource: item.startTimeSource,
    endTime: item.endTime,
    endTimeSource: item.endTimeSource,
    metrics: summarizeRouteMetrics(item.metrics)
  };
}

function summarizeRouteMetrics(metrics: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!metrics) return {};
  const keys = [
    'ppPerHour',
    'rewardLevel',
    'spreadCents',
    'spreadBps',
    'rewardBandDepthUsd',
    'topDepthUsd',
    'expectedPpPerHour',
    'ppPerThousandUsd',
    'targetSharePct',
    'competitionBand',
    'minRewardNotionalUsd',
    'targetOrderUsd',
    'targetShares',
    'targetOrderSource',
    'liquidityUsd',
    'volume24hUsd',
    'remainingSafeHours'
  ];
  return Object.fromEntries(keys.flatMap((key) => key in metrics ? [[key, metrics[key]]] : []));
}

function publicActiveOrder(order: OpenOrder): Record<string, unknown> {
  return {
    venue: order.venue,
    externalId: order.externalId,
    tokenId: order.tokenId,
    side: order.side,
    price: order.price,
    size: order.size,
    notionalUsd: Number((order.price * order.size).toFixed(6)),
    status: order.status
  };
}

type SnapshotForUi = (Omit<AccountRiskSnapshot, 'fills' | 'positions' | 'balances'> & {
  ts?: string;
  raw?: unknown;
}) | undefined;

function accountLiveForUi(
  venue: VenueName,
  decision: (AccountRiskDecision & { ts?: string }) | undefined,
  snapshot: SnapshotForUi,
  maxAgeMs: number
): Record<string, unknown> {
  const balances = publicBalancesFromSnapshot(snapshot);
  const positions = positionsFromSnapshot(snapshot);
  const stableBalances = balances.filter((balance) => stableAsset(balance.asset));
  const availableUsd = roundUsd(stableBalances.reduce((sum, balance) => sum + finite(balance.available), 0));
  const totalUsd = roundUsd(stableBalances.reduce((sum, balance) => sum + finite(balance.total), 0));
  const positionNotionalUsd = roundUsd(positions.reduce((sum, position) => sum + Math.abs(finite(position.notionalUsd)), 0));
  const dailyPnlUsd = finiteMaybe(decision?.dailyPnlUsd)
    ?? (finiteMaybe(decision?.realizedPnlUsd) !== undefined || finiteMaybe(decision?.unrealizedPnlUsd) !== undefined
      ? roundUsd(finite(decision?.realizedPnlUsd) + finite(decision?.unrealizedPnlUsd))
      : undefined);
  const capturedAt = snapshot?.capturedAt ?? decision?.capturedAt;
  const ageMs = capturedAt ? Math.max(0, Date.now() - capturedAt) : undefined;
  return {
    venue,
    available: Boolean(snapshot || decision),
    account: snapshot?.account,
    capturedAt: capturedAt ? new Date(capturedAt).toISOString() : undefined,
    ageMs,
    stale: ageMs !== undefined ? ageMs > maxAgeMs : false,
    equityUsd: finiteMaybe(decision?.equityUsd) ?? finiteMaybe(snapshot?.equityUsd),
    dayStartEquityUsd: finiteMaybe(decision?.dayStartEquityUsd) ?? finiteMaybe(snapshot?.dayStartEquityUsd),
    dailyPnlUsd,
    lossLimitUsd: finiteMaybe(decision?.maxDailyLossUsd),
    lossUsedUsd: dailyPnlUsd === undefined ? undefined : roundUsd(Math.max(0, -dailyPnlUsd)),
    lossRemainingUsd: dailyPnlUsd === undefined || decision?.maxDailyLossUsd === undefined
      ? undefined
      : roundUsd(Math.max(0, finite(decision.maxDailyLossUsd) + Math.min(0, dailyPnlUsd))),
    balances,
    stableBalanceUsd: {
      available: availableUsd,
      total: totalUsd
    },
    positions: {
      count: positions.length,
      notionalUsd: positionNotionalUsd
    },
    source: snapshot ? 'account-risk-snapshot' : decision ? 'account-risk-decision' : 'none'
  };
}

function openOrderRiskForUi(
  venue: VenueName,
  config: AppConfig,
  decision: (AccountRiskDecision & { ts?: string }) | undefined,
  orders: OpenOrder[]
): Record<string, unknown> {
  const active = orders.filter((order) => order.venue === venue && (order.status === 'OPEN' || order.status === 'PENDING_OPEN'));
  const buy = active.filter((order) => order.side === 'BUY');
  const sell = active.filter((order) => order.side === 'SELL');
  const notionalUsd = roundUsd(active.reduce((sum, order) => sum + orderNotionalUsd(order), 0));
  const buyNotionalUsd = roundUsd(buy.reduce((sum, order) => sum + orderNotionalUsd(order), 0));
  const sellNotionalUsd = roundUsd(sell.reduce((sum, order) => sum + orderNotionalUsd(order), 0));
  const sellLiabilityUsd = roundUsd(sell.reduce((sum, order) => sum + Math.max(0, 1 - finite(order.price)) * finite(order.size), 0));
  const estimatedWorstCaseLossUsd = roundUsd(buyNotionalUsd + sellLiabilityUsd);
  const dailyPnlUsd = finiteMaybe(decision?.dailyPnlUsd);
  const lossLimitUsd = finiteMaybe(decision?.maxDailyLossUsd) ?? config.risk.maxDailyLossUsd;
  const lossUsedUsd = dailyPnlUsd === undefined ? undefined : roundUsd(Math.max(0, -dailyPnlUsd));
  const lossRemainingUsd = dailyPnlUsd === undefined
    ? undefined
    : roundUsd(Math.max(0, lossLimitUsd + Math.min(0, dailyPnlUsd)));
  return {
    venue,
    openOrders: active.length,
    pendingOrders: active.filter((order) => order.status === 'PENDING_OPEN').length,
    buyOrders: buy.length,
    sellOrders: sell.length,
    notionalUsd,
    buyNotionalUsd,
    sellNotionalUsd,
    sellLiabilityUsd,
    estimatedWorstCaseLossUsd,
    lossLimitUsd: roundUsd(lossLimitUsd),
    lossUsedUsd,
    lossRemainingUsd,
    exceedsLossRemaining: lossRemainingUsd !== undefined && estimatedWorstCaseLossUsd > lossRemainingUsd,
    source: 'local-open-order-ledger'
  };
}

function publicBalancesFromSnapshot(snapshot: SnapshotForUi): Balance[] {
  const raw = snapshot?.raw;
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { balances?: unknown }).balances)) return [];
  return ((raw as { balances: unknown[] }).balances)
    .map(publicBalanceLike)
    .filter((balance): balance is Balance => Boolean(balance));
}

function publicBalanceLike(value: unknown): Balance | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as Partial<Balance>;
  const asset = typeof item.asset === 'string' ? item.asset : '';
  if (!asset) return undefined;
  return {
    asset,
    available: roundUsd(finite(item.available)),
    total: roundUsd(finite(item.total))
  };
}

function positionsFromSnapshot(snapshot: SnapshotForUi): Position[] {
  const raw = snapshot?.raw;
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { positions?: unknown }).positions)) return [];
  return ((raw as { positions: unknown[] }).positions)
    .filter((position): position is Position => Boolean(position && typeof position === 'object'));
}

function stableAsset(asset: string): boolean {
  return ['USDT', 'USDC', 'PUSD', 'USD'].includes(asset.toUpperCase());
}

function orderNotionalUsd(order: OpenOrder): number {
  return finite(order.price) * finite(order.size);
}

function finite(value: unknown): number {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function finiteMaybe(value: unknown): number | undefined {
  return Number.isFinite(Number(value)) ? Number(value) : undefined;
}

function roundUsd(value: number): number {
  return Number((Number.isFinite(value) ? value : 0).toFixed(6));
}

function routeAuditCheckpointForUi(
  checkpoint: { name: string; ts: string; value: unknown } | undefined,
  summary: boolean
): { name: string; ts: string; value: unknown } | undefined {
  if (!checkpoint || !summary || !checkpoint.value || typeof checkpoint.value !== 'object') return checkpoint;
  const value = checkpoint.value as Record<string, unknown>;
  return {
    ...checkpoint,
    value: {
      venue: value.venue,
      capturedAt: value.capturedAt,
      totals: value.totals,
      coveragePct: value.coveragePct,
      complete: value.complete,
      source: value.source,
      latestFullAudit: summarizeLatestFullAudit(value.latestFullAudit),
      progress: value.progress,
      executionBasketCapturedAt: value.executionBasketCapturedAt,
      executionBasket: Array.isArray(value.executionBasket) ? value.executionBasket.slice(0, 25).map(summarizeRouteItem) : [],
      topByExpected: Array.isArray(value.topByExpected) ? value.topByExpected.slice(0, 25).map(summarizeRouteItem) : [],
      topByEfficiency: Array.isArray(value.topByEfficiency) ? value.topByEfficiency.slice(0, 10).map(summarizeRouteItem) : [],
      selected: Array.isArray(value.selected) ? value.selected.slice(0, 25).map(summarizeRouteItem) : [],
      rejectedTop: Array.isArray(value.rejectedTop) ? value.rejectedTop.slice(0, 10).map(summarizeRouteItem) : []
    }
  };
}

function summarizeLatestFullAudit(value: unknown): unknown {
  if (!value || typeof value !== 'object') return undefined;
  const proof = value as Record<string, unknown>;
  return {
    capturedAt: proof.capturedAt,
    source: proof.source,
    coveragePct: proof.coveragePct,
    totals: proof.totals,
    executionBasket: Array.isArray(proof.executionBasket) ? proof.executionBasket.slice(0, 25).map(summarizeRouteItem) : [],
    topByExpected: Array.isArray(proof.topByExpected) ? proof.topByExpected.slice(0, 25).map(summarizeRouteItem) : [],
    topByEfficiency: Array.isArray(proof.topByEfficiency) ? proof.topByEfficiency.slice(0, 25).map(summarizeRouteItem) : [],
    selected: Array.isArray(proof.selected) ? proof.selected.slice(0, 25).map(summarizeRouteItem) : []
  };
}

function fillSummaryDayStart(snapshot: { dayStart?: number } | undefined): number {
  if (snapshot && Number.isFinite(snapshot.dayStart)) return Number(snapshot.dayStart);
  return dayStartTs();
}

function riskWindowForUi(
  venue: VenueName,
  store: Pick<ReturnType<typeof usingStore>, 'getCheckpoint'>,
  snapshot: { dayStart?: number } | undefined
): { sinceTs: number; since: string; source: 'live-session' | 'snapshot' | 'day-start' } {
  const fallback = fillSummaryDayStart(snapshot);
  const sinceTs = accountRiskWindowStart(venue, store, fallback);
  return {
    sinceTs,
    since: new Date(sinceTs).toISOString(),
    source: sinceTs !== fallback ? 'live-session' : snapshot && Number.isFinite(snapshot.dayStart) ? 'snapshot' : 'day-start'
  };
}

export async function recommendations(configPath: string, url: URL): Promise<unknown> {
  const venue = parseVenueParam(url.searchParams.get('venue'));
  const top = boundedNumber(url.searchParams.get('top'), 5, 1, 20);
  const loaded = loadConfig(configPath);
  loaded.config = resolveVenueConfig(loaded.config, venue);
  const filters = recommendationFilters(url.searchParams, loaded.config);
  const adapter = createVenue(loaded.config, loaded.dataDir, venue);
  const strategy = new StrategyEngine(configWithRecommendationFilters(loaded.config, filters));
  const markets = filterMarkets(await adapter.getMarkets(), filters);
  return { ok: true, venue, filters, recommendations: strategy.recommend(markets, top).map(decorateRecommendation) };
}

export async function applyRecommendations(configPath: string, body: unknown): Promise<unknown> {
  const request = asRecord(body);
  const venue = parseVenueParam(request.venue);
  const top = boundedNumber(request.top, 3, 1, 20);
  const loaded = loadConfig(configPath);
  // Resolve to a LOCAL view for selection only — do NOT reassign loaded.config, because we saveConfig() the base
  // below and must not write Polymarket's params over the base risk/strategy.
  const venueConfig = resolveVenueConfig(loaded.config, venue);
  const filters = recommendationFilters(request, venueConfig);
  const adapter = createVenue(venueConfig, loaded.dataDir, venue);
  const strategy = new StrategyEngine(configWithRecommendationFilters(venueConfig, filters));
  const recs = strategy.recommend(filterMarkets(await adapter.getMarkets(), filters), top);
  loaded.config.selectedMarkets[venue] = recs.map((rec) => rec.market.tokenId);
  saveConfig(loaded.configPath, loaded.config);
  return { ok: true, venue, count: recs.length, tokenIds: loaded.config.selectedMarkets[venue] };
}

export async function updateTradingConfig(configPath: string, body: unknown): Promise<unknown> {
  const request = asRecord(body);
  const loaded = loadConfig(configPath);
  const venue = request.venue === undefined ? undefined : parseVenueParam(request.venue);
  // Write to the venue's OWN independent params: Polymarket -> its block, Predict/global -> the base config.
  // `work.risk`/`work.strategy` are the same object references as the chosen block, so mutating them updates it.
  const work: typeof loaded.config = venue === 'polymarket' && loaded.config.polymarketParams
    ? { ...loaded.config, risk: loaded.config.polymarketParams.risk, strategy: loaded.config.polymarketParams.strategy }
    : loaded.config;
  const tradingMode = parseTradingModeValue(request.tradingMode, work.strategy.tradingMode);
  const orderSizeUsd = boundedNumber(request.orderSizeUsd, work.risk.orderSizeUsd, 1, 100000);
  const quoteDepthLevel = Math.trunc(boundedNumber(request.quoteDepthLevel, currentDepthLevel(work), 1, 20));
  if (request.liveEnabled !== undefined) {
    if (venue) {
      loaded.config.venues[venue].liveEnabled = parseBoolean(request.liveEnabled, venueLiveEnabled(loaded.config, venue));
    } else {
      loaded.config.liveEnabled = parseBoolean(request.liveEnabled, loaded.config.liveEnabled);
    }
  }
  work.risk.orderSizeUsd = orderSizeUsd;
  work.risk.maxSingleOrderUsd = boundedNumber(request.maxSingleOrderUsd, Math.max(work.risk.maxSingleOrderUsd, orderSizeUsd), 0.01, 1000000);
  work.risk.maxPositionUsd = boundedNumber(request.maxPositionUsd, Math.max(work.risk.maxPositionUsd, orderSizeUsd), 0.01, 1000000);
  work.risk.maxDailyLossUsd = boundedNumber(request.maxDailyLossUsd, work.risk.maxDailyLossUsd, 0.01, 1000000);
  work.risk.maxAccountRiskStaleMs = Math.trunc(boundedNumber(request.maxAccountRiskStaleMs, work.risk.maxAccountRiskStaleMs, 1000, 3600000));
  work.risk.maxOpenOrderReserveDriftUsd = boundedNumber(request.maxOpenOrderReserveDriftUsd, work.risk.maxOpenOrderReserveDriftUsd, 0, 1000000);
  work.risk.maxOpenOrderReserveDriftPct = boundedNumber(request.maxOpenOrderReserveDriftPct, work.risk.maxOpenOrderReserveDriftPct, 0, 10000);
  work.risk.settlementNoNewOrdersMs = Math.trunc(boundedNumber(request.settlementNoNewOrdersMs, work.risk.settlementNoNewOrdersMs, 0, 86400000));
  work.risk.settlementCancelOpenOrdersMs = Math.trunc(boundedNumber(request.settlementCancelOpenOrdersMs, work.risk.settlementCancelOpenOrdersMs, 0, 86400000));
  work.risk.shortEventMaxDurationMs = Math.trunc(boundedNumber(request.shortEventMaxDurationMs, work.risk.shortEventMaxDurationMs, 0, 7 * 86400000));
  work.risk.eventStartNoNewOrdersMs = Math.trunc(boundedNumber(request.eventStartNoNewOrdersMs, work.risk.eventStartNoNewOrdersMs, 0, 86400000));
  work.risk.eventStartCancelOpenOrdersMs = Math.trunc(boundedNumber(request.eventStartCancelOpenOrdersMs, work.risk.eventStartCancelOpenOrdersMs, 0, 86400000));
  work.risk.blockUnknownEndTime = parseBoolean(request.blockUnknownEndTime, work.risk.blockUnknownEndTime);
  work.risk.maxBboMoveCents = boundedNumber(request.maxBboMoveCents, work.risk.maxBboMoveCents, 0.01, 100);
  work.risk.maxSpreadMoveBps = boundedNumber(request.maxSpreadMoveBps, work.risk.maxSpreadMoveBps, 0.01, 5000);
  work.risk.maxMarkets = Math.trunc(boundedNumber(request.maxMarkets, work.risk.maxMarkets, 1, 100));
  work.risk.maxOpenOrdersPerMarket = Math.trunc(boundedNumber(request.maxOpenOrdersPerMarket, work.risk.maxOpenOrdersPerMarket, 1, 20));
  work.strategy.tradingMode = tradingMode;
  work.strategy.entryMode = parseEntryModeValue(request.entryMode, work.strategy.entryMode);
  if (isPairedEntryMode(work)) {
    work.strategy.quoteSide = 'both';
    work.strategy.dualSide = true;
  } else {
    work.strategy.quoteSide = parseQuoteSideValue(request.quoteSide, work.strategy.quoteSide);
    work.strategy.dualSide = work.strategy.quoteSide === 'both';
  }
  work.strategy.autoSelectMarkets = parseBoolean(request.autoSelectMarkets, work.strategy.autoSelectMarkets);
  work.strategy.pointsOnly = parseBoolean(request.pointsOnly, work.strategy.pointsOnly);
  work.strategy.acceptingOnly = parseBoolean(request.acceptingOnly, work.strategy.acceptingOnly);
  work.strategy.minMarketLiquidityUsd = boundedNumber(request.minMarketLiquidityUsd, work.strategy.minMarketLiquidityUsd, 0, 100000000);
  work.strategy.minRewardLevel = Math.trunc(boundedNumber(request.minRewardLevel, work.strategy.minRewardLevel, 0, 5));
  work.strategy.minRewardSizeMultiplier = boundedNumber(request.minRewardSizeMultiplier, work.strategy.minRewardSizeMultiplier, 0.1, 10);
  work.strategy.enforceRewardMinimum = parseBoolean(request.enforceRewardMinimum, work.strategy.enforceRewardMinimum);
  work.strategy.candidateLimit = Math.trunc(boundedNumber(request.candidateLimit, work.strategy.candidateLimit, 1, 100));
  work.strategy.switchThresholdPct = boundedNumber(request.switchThresholdPct, work.strategy.switchThresholdPct, 0, 100);
  work.strategy.minSwitchBenefitMultiplier = boundedNumber(request.minSwitchBenefitMultiplier, work.strategy.minSwitchBenefitMultiplier, 0, 100);
  work.strategy.minSwitchEdgeAfterGasUsd = boundedNumber(request.minSwitchEdgeAfterGasUsd, work.strategy.minSwitchEdgeAfterGasUsd, 0, 1000);
  work.strategy.minSafeHoursForSwitch = boundedNumber(request.minSafeHoursForSwitch, work.strategy.minSafeHoursForSwitch, 0, 168);
  work.strategy.bnbUsdForGasEstimate = boundedNumber(request.bnbUsdForGasEstimate, work.strategy.bnbUsdForGasEstimate, 1, 10000);
  work.strategy.gasBufferMultiplier = boundedNumber(request.gasBufferMultiplier, work.strategy.gasBufferMultiplier, 1, 10);
  work.strategy.fallbackSplitMergeGasUnits = Math.trunc(boundedNumber(request.fallbackSplitMergeGasUnits, work.strategy.fallbackSplitMergeGasUnits, 21000, 3000000));
  work.strategy.retreatTicks = Math.trunc(boundedNumber(request.retreatTicks, work.strategy.retreatTicks, 0, 20));
  work.strategy.replaceThresholdTicks = Math.trunc(boundedNumber(request.replaceThresholdTicks, work.strategy.replaceThresholdTicks, 0, 20));
  work.strategy.cancelOutsideReward = parseBoolean(request.cancelOutsideReward, work.strategy.cancelOutsideReward);
  work.strategy.quoteRefreshMs = Math.trunc(boundedNumber(request.quoteRefreshMs, work.strategy.quoteRefreshMs, 1000, 600000));
  work.strategy.marketRefreshMs = Math.trunc(boundedNumber(request.marketRefreshMs, work.strategy.marketRefreshMs, 10000, 3600000));
  work.strategy.onFillAction = 'hold';
  work.strategy.cashOnFillAction = parseCashOnFillActionValue(request.cashOnFillAction, work.strategy.cashOnFillAction);
  work.strategy.cashMaxExitLossPct = boundedNumber(request.cashMaxExitLossPct, work.strategy.cashMaxExitLossPct, 0, 100);
  work.strategy.liquidationSlippageTicks = Math.trunc(boundedNumber(request.liquidationSlippageTicks, work.strategy.liquidationSlippageTicks, 0, 100));
  work.strategy.liquidationMaxSlippageCents = boundedNumber(request.liquidationMaxSlippageCents, work.strategy.liquidationMaxSlippageCents, 0.01, 99);
  work.strategy.minPositionSizeToLiquidate = boundedNumber(request.minPositionSizeToLiquidate, work.strategy.minPositionSizeToLiquidate, 0.0001, 1000000);
  work.strategy.balanceReserveUsd = boundedNumber(request.balanceReserveUsd, work.strategy.balanceReserveUsd, 0, 1000000);
  work.strategy.inventorySkewEnabled = parseBoolean(request.inventorySkewEnabled, work.strategy.inventorySkewEnabled);
  work.strategy.maxInventorySkewUsd = boundedNumber(request.maxInventorySkewUsd, work.strategy.maxInventorySkewUsd, 0.01, 1000000);
  work.strategy.dedupeMarketGroups = parseBoolean(request.dedupeMarketGroups, work.strategy.dedupeMarketGroups);
  work.strategy.maxTokensPerMarket = Math.trunc(boundedNumber(request.maxTokensPerMarket, work.strategy.maxTokensPerMarket, 1, 20));
  work.strategy.polymarketTwoSidedLp = parseBoolean(request.polymarketTwoSidedLp, work.strategy.polymarketTwoSidedLp);
  work.strategy.polymarketLpTotalUsd = boundedNumber(request.polymarketLpTotalUsd, work.strategy.polymarketLpTotalUsd, 1, 1000000);
  work.strategy.polymarketMaxMarkets = Math.trunc(boundedNumber(request.polymarketMaxMarkets, work.strategy.polymarketMaxMarkets, 1, 50));
  work.strategy.polymarketMaxLossUsd = boundedNumber(request.polymarketMaxLossUsd, work.strategy.polymarketMaxLossUsd, 0, 1000000);
  work.strategy.polymarketMinDailyRewardUsd = boundedNumber(request.polymarketMinDailyRewardUsd, work.strategy.polymarketMinDailyRewardUsd, 0, 1000000);
  work.strategy.polymarketStartLevel = Math.trunc(boundedNumber(request.polymarketStartLevel, work.strategy.polymarketStartLevel, 1, 20));
  work.strategy.polymarketFrontDepthUsd = boundedNumber(request.polymarketFrontDepthUsd, work.strategy.polymarketFrontDepthUsd, 0, 10000000);
  work.strategy.polymarketFastQuoteMs = Math.trunc(boundedNumber(request.polymarketFastQuoteMs, work.strategy.polymarketFastQuoteMs, 0, 60000));
  work.strategy.polymarketFullCycleMs = Math.trunc(boundedNumber(request.polymarketFullCycleMs, work.strategy.polymarketFullCycleMs, 0, 600000));
  work.strategy.predictCashBuyStaleGraceMs = Math.trunc(boundedNumber(request.predictCashBuyStaleGraceMs, work.strategy.predictCashBuyStaleGraceMs, 0, 300000));
  work.strategy.predictFrontDepthUsd = boundedNumber(request.predictFrontDepthUsd, work.strategy.predictFrontDepthUsd, 0, 10000000);
  work.strategy.predictFastQuoteMs = Math.trunc(boundedNumber(request.predictFastQuoteMs, work.strategy.predictFastQuoteMs, 0, 60000));
  work.strategy.predictFullCycleMs = Math.trunc(boundedNumber(request.predictFullCycleMs, work.strategy.predictFullCycleMs, 0, 600000));
  work.strategy.predictCrowdedThreshold = boundedNumber(request.predictCrowdedThreshold, work.strategy.predictCrowdedThreshold, 0, 10000);
  work.strategy.polymarketSwitchThresholdPct = boundedNumber(request.polymarketSwitchThresholdPct, work.strategy.polymarketSwitchThresholdPct, 0, 100);
  work.strategy.polymarketMaxPositionUsd = boundedNumber(request.polymarketMaxPositionUsd, work.strategy.polymarketMaxPositionUsd, 0, 10000000);
  work.strategy.polymarketTestMode = parseBoolean(request.polymarketTestMode, work.strategy.polymarketTestMode);
  if (tradingMode === 'conservative') work.strategy.conservativeDepthLevel = quoteDepthLevel;
  if (tradingMode === 'aggressive') work.strategy.aggressiveDepthLevel = quoteDepthLevel;
  if (venue === 'predict' && loaded.config.predictParams) {
    const normalizedPredict = normalizeLiveStrategyConfig(work);
    loaded.config.predictParams = { risk: normalizedPredict.risk, strategy: normalizedPredict.strategy };
  }
  if (venue === 'polymarket' && loaded.config.polymarketParams) {
    const normalizedPoly = normalizeLiveStrategyConfig(work);
    loaded.config.polymarketParams = { risk: normalizedPoly.risk, strategy: normalizedPoly.strategy };
  }
  const normalized = normalizeLiveStrategyConfig(loaded.config);
  saveConfig(loaded.configPath, normalized);
  const savedParams = venue === 'polymarket' && normalized.polymarketParams ? normalized.polymarketParams : normalized;
  return {
    ok: true,
    config: {
      liveEnabled: normalized.liveEnabled,
      liveEnabledByVenue: liveEnabledByVenue(normalized),
      risk: savedParams.risk,
      strategy: savedParams.strategy
    }
  };
}

export async function orderbook(configPath: string, url: URL): Promise<unknown> {
  const venue = parseVenueParam(url.searchParams.get('venue'));
  const tokenId = requiredString(url.searchParams.get('tokenId'), 'tokenId');
  const loaded = loadConfig(configPath);
  const adapter = createVenue(loaded.config, loaded.dataDir, venue);
  adapter.hydrateFromMarkets?.(await getSharedCachedMarkets(loaded.config, venue, adapter));
  return { ok: true, venue, tokenId, book: await adapter.getOrderbook(tokenId) };
}

export async function routeAudit(configPath: string, url: URL): Promise<unknown> {
  const venue = parseVenueParam(url.searchParams.get('venue'));
  const top = Math.trunc(boundedNumber(url.searchParams.get('top'), 60, 1, 100));
  const batchSize = Math.trunc(boundedNumber(url.searchParams.get('batchSize'), 12, 1, 60));
  const delayMs = Math.trunc(boundedNumber(url.searchParams.get('delayMs'), 0, 0, 1000));
  const orderbookConcurrency = Math.trunc(boundedNumber(url.searchParams.get('orderbookConcurrency'), 6, 1, 8));
  const orderbookTimeoutMs = Math.trunc(boundedNumber(url.searchParams.get('orderbookTimeoutMs'), 6000, 500, 10000));
  const reset = parseBoolean(url.searchParams.get('reset'), false);
  const loaded = loadConfig(configPath);
  loaded.config = resolveVenueConfig(loaded.config, venue);
  const adapter = createVenue(loaded.config, loaded.dataDir, venue);
  ensureDataDirs(loaded.dataDir);
  const store = usingStore(loaded.dataDir);
  try {
    const markets = await getSharedCachedMarkets(loaded.config, venue, adapter, store);
    const audit = await auditRouteOpportunitiesBatch(loaded.config, venue, adapter, {
      top,
      batchSize,
      delayMs,
      orderbookConcurrency,
      orderbookTimeoutMs,
      markets,
      reset,
      previousValue: store.getCheckpoint(`route-audit.${venue}`)?.value,
      cashFillCooldown: buildCashFillCooldown(loaded.config, venue, store)
    });
    store.checkpoint(`route-audit.${venue}`, audit);
    store.recordEvent({
      venue,
      type: audit.complete ? 'ui.route-audit.completed' : 'ui.route-audit.progress',
      message: audit.complete
        ? `全站路由审计完成：${audit.progress.scanned}/${audit.progress.total} 个盘口，失败 ${audit.progress.failed}`
        : `全站路由审计进度：${audit.progress.scanned}/${audit.progress.total} 个盘口，剩余 ${audit.progress.remaining}`,
      details: {
        progress: audit.progress,
        coveragePct: audit.coveragePct,
        source: audit.source
      }
    });
    return {
      ok: true,
      audit
    };
  } finally {
    store.close();
  }
}

export async function balances(configPath: string, body: unknown): Promise<unknown> {
  const request = asRecord(body);
  const venue = parseVenueParam(request.venue);
  const passphrase = typeof request.passphrase === 'string' ? request.passphrase : '';
  // Silent mode for the periodic auto-refresh: skip the request/complete events so they don't spam the live log.
  const silent = request.silent === true;
  const loaded = loadConfig(configPath);
  loaded.config = resolveVenueConfig(loaded.config, venue);
  ensureDataDirs(loaded.dataDir);
  const startedAt = Date.now();
  const store = usingStore(loaded.dataDir);
  try {
    if (!silent) store.recordEvent({
      venue,
      type: 'ui.balance.refresh.requested',
      message: '用户点击刷新余额',
      details: { timeoutMs: BALANCE_REFRESH_TIMEOUT_MS }
    });
    const signer = loadSignerForUi(loaded.dataDir, venue, passphrase);
    if (!signer) {
      return { ok: false, venue, signerMissing: true, message: '需要输入 keystore 密码才能加载签名者' };
    }
    const adapter = await createVenueForUi(loaded.config, loaded.dataDir, venue, signer, passphrase);
    const address = balanceAddress(loaded.config, venue, signer.address);
    const values = await withRequestTimeout(
      adapter.getBalances(address),
      BALANCE_REFRESH_TIMEOUT_MS,
      () => new UiError(504, `余额刷新超过 ${BALANCE_REFRESH_TIMEOUT_MS / 1000} 秒仍未返回，请稍后重试或检查平台/RPC 网络。`)
    );
    if (!silent) store.recordEvent({
      venue,
      type: 'ui.balance.refresh.completed',
      message: `余额刷新完成：${values.length} 项，耗时 ${Date.now() - startedAt}ms`,
      details: { address, count: values.length, elapsedMs: Date.now() - startedAt }
    });
    return { ok: true, venue, address, capturedAt: new Date().toISOString(), balances: values.map(publicBalance) };
  } catch (error) {
    store.recordEvent({
      venue,
      severity: 'error',
      type: 'ui.balance.refresh.failed',
      message: error instanceof Error ? error.message : String(error),
      details: { elapsedMs: Date.now() - startedAt }
    });
    throw error;
  } finally {
    store.close();
  }
}

export async function grantPolymarketApprovals(configPath: string, body: unknown): Promise<unknown> {
  const request = asRecord(body);
  const venue: VenueName = 'polymarket';
  const passphrase = typeof request.passphrase === 'string' ? request.passphrase : '';
  const amountUsd = boundedNumber(request.amountUsd, 100, 1, 100000);
  const loaded = loadConfig(configPath);
  loaded.config = resolveVenueConfig(loaded.config, venue);
  ensureDataDirs(loaded.dataDir);
  const store = usingStore(loaded.dataDir);
  try {
    const signer = loadSignerForUi(loaded.dataDir, venue, passphrase);
    if (!signer) {
      return { ok: false, venue, signerMissing: true, message: '需要输入 keystore 密码才能加载签名者' };
    }
    const adapter = await createVenueForUi(loaded.config, loaded.dataDir, venue, signer, passphrase);
    if (!adapter.grantTradingApprovals) throw new Error('Polymarket 适配器不支持一键授权。');
    store.recordEvent({ venue, severity: 'warn', type: 'ui.polymarket.approvals.requested', message: `用户点击一键授权(pUSD 授权=无上限 unlimited）` });
    const result = await adapter.grantTradingApprovals(signer, amountUsd);
    store.recordEvent({
      venue,
      severity: result.ok ? 'info' : 'error',
      type: 'ui.polymarket.approvals.completed',
      message: result.ok ? `授权完成,共 ${result.txHashes.length} 笔交易` : '授权未全部成功',
      details: result
    });
    return { amountUsd, ...result };
  } finally {
    store.close();
  }
}

export async function startupFacts(configPath: string, body: unknown): Promise<unknown> {
  const request = asRecord(body);
  const venue = parseVenueParam(request.venue);
  const passphrase = typeof request.passphrase === 'string' ? request.passphrase : '';
  const loaded = loadConfig(configPath);
  loaded.config = resolveVenueConfig(loaded.config, venue);
  ensureDataDirs(loaded.dataDir);
  const startedAt = Date.now();
  const store = usingStore(loaded.dataDir);
  try {
    store.recordEvent({
      venue,
      type: 'ui.startup-facts.requested',
      message: '用户点击启动前事实检查',
      details: {
        timeoutMs: STARTUP_FACTS_TIMEOUT_MS,
        perReadTimeoutMs: STARTUP_FACT_READ_TIMEOUT_MS,
        marketReadTimeoutMs: STARTUP_FACT_MARKETS_READ_TIMEOUT_MS,
        booksReadTimeoutMs: STARTUP_FACT_BOOKS_READ_TIMEOUT_MS
      }
    });
    const signer = loadSignerForUi(loaded.dataDir, venue, passphrase);
    if (!signer) {
      return { ok: false, venue, signerMissing: true, message: '需要输入 keystore 密码才能加载签名者' };
    }
    const adapter = await createVenueForUi(loaded.config, loaded.dataDir, venue, signer, passphrase);
    const address = balanceAddress(loaded.config, venue, signer.address);
    const [balancesResult, positionsResult, openOrdersResult, marketsResult, accountRiskResult] = await Promise.all([
      settleReadWithTimeout(() => adapter.getBalances(address, signer), STARTUP_FACT_READ_TIMEOUT_MS, '余额/RPC读取'),
      settleReadWithTimeout(() => adapter.getPositions(address), STARTUP_FACT_READ_TIMEOUT_MS, '持仓读取'),
      settleReadWithTimeout(() => adapter.getOpenOrders(address), STARTUP_FACT_READ_TIMEOUT_MS, '开放订单读取'),
      settleReadWithTimeout(
        () => getSharedCachedMarkets(loaded.config, venue, adapter, store),
        STARTUP_FACT_MARKETS_READ_TIMEOUT_MS,
        '市场列表读取'
      ),
      settleReadWithTimeout(() => accountRiskDecision(venue, loaded.config, adapter, signer, address, store), STARTUP_FACT_READ_TIMEOUT_MS, '账户风控读取')
    ]);
    const balances = valueOrEmpty<Balance>(balancesResult);
    const positions = valueOrEmpty<Position>(positionsResult);
    const openOrders = valueOrEmpty<OpenOrder>(openOrdersResult);
    const markets = enrichMarketsWithPositionMarkets(valueOrEmpty<Market>(marketsResult), positions);
    if (marketsResult.ok && markets.length > marketsResult.value.length) adapter.hydrateFromMarkets?.(markets);
    const booksResult = marketsResult.ok
      ? await settleReadWithTimeout(
        () => startupOrderbooks(adapter, loaded.config, venue, marketsResult.value),
        STARTUP_FACT_BOOKS_READ_TIMEOUT_MS,
        '启动盘口读取'
      )
      : { ok: false as const, error: '市场列表不可用，跳过启动盘口读取' };
    const nativeGasResult = loaded.config.strategy.entryMode === 'split' && adapter.getNativeGasBalance
      ? await settleReadWithTimeout(() => adapter.getNativeGasBalance!(signer), STARTUP_FACT_READ_TIMEOUT_MS, 'BNB手续费读取')
      : undefined;
    const books = booksResult.ok ? booksResult.value : new Map();
    if (openOrdersResult.ok) store.reconcileOpenOrders(venue, openOrders, 'live');
    const accountRisk = accountRiskResult.ok ? accountRiskResult.value : evaluateAccountRisk(venue, loaded.config, undefined);
    if (!accountRiskResult.ok) store.recordAccountRiskDecision(accountRisk);
    const facts = computeStartupFacts({
      config: loaded.config,
      venue,
      address,
      signerAddress: signer.address,
      balances,
      positions,
      openOrders,
      markets,
      books,
      accountRisk,
      ...(nativeGasResult?.ok ? { nativeGas: nativeGasResult.value } : {}),
      dataStatus: {
        balances: readStatus(balancesResult, `${balances.length} 项余额`),
        positions: readStatus(positionsResult, `${positions.length} 个库存 token`),
        openOrders: readStatus(openOrdersResult, `${openOrders.length} 个开放订单`),
        markets: marketsResult.ok && booksResult.ok
          ? { ok: true, message: `${markets.length} 个候选市场，${books.size} 个盘口` }
          : readStatus(marketsResult.ok ? booksResult : marketsResult, marketsResult.ok ? `${books.size} 个盘口` : `${markets.length} 个候选市场`),
        accountRisk: accountRiskResult.ok
          ? { ok: accountRisk.ok, message: accountRisk.message }
          : { ok: false, message: `账户级风控同步失败：${accountRiskResult.error}` }
      }
    });
    store.recordEvent({
      venue,
      severity: facts.readyToQuote ? 'info' : 'warn',
      type: 'ui.startup-facts.completed',
      message: facts.summary,
      details: {
        expected: facts.expected,
        funds: facts.funds,
        splitEntry: facts.splitEntry,
        nativeGas: facts.nativeGas,
        dataStatus: facts.dataStatus,
        elapsedMs: Date.now() - startedAt
      }
    });
    return { ok: true, facts };
  } catch (error) {
    store.recordEvent({
      venue,
      severity: 'error',
      type: 'ui.startup-facts.failed',
      message: error instanceof Error ? error.message : String(error),
      details: { elapsedMs: Date.now() - startedAt }
    });
    throw error;
  } finally {
    store.close();
  }
}

async function startupOrderbooks(
  adapter: Awaited<ReturnType<typeof createVenueForUi>>,
  config: AppConfig,
  venue: VenueName,
  markets: Market[]
): Promise<Map<string, Orderbook>> {
  const books = new Map<string, Orderbook>();
  const candidates = planMarketOrderbookScan(config, venue, markets).markets;
  await Promise.allSettled(candidates.map(async (market) => {
    const book = await adapter.getOrderbook(market.tokenId);
    books.set(market.tokenId, book);
  }));
  return books;
}

function currentDepthLevel(config: AppConfig): number {
  return config.strategy.tradingMode === 'aggressive'
    ? config.strategy.aggressiveDepthLevel
    : config.strategy.conservativeDepthLevel;
}

function parseEntryModeValue(value: unknown, fallback: AppConfig['strategy']['entryMode']): AppConfig['strategy']['entryMode'] {
  if (value === undefined || value === null || value === '') return fallback;
  if (value === 'cash' || value === 'inventory' || value === 'split') return value;
  return fallback;
}

function parseTradingModeValue(value: unknown, fallback: AppConfig['strategy']['tradingMode']): AppConfig['strategy']['tradingMode'] {
  if (value === undefined || value === null || value === '') return fallback;
  return parseTradingMode(value);
}

function parseQuoteSideValue(value: unknown, fallback: AppConfig['strategy']['quoteSide']): AppConfig['strategy']['quoteSide'] {
  if (value === undefined || value === null || value === '') return fallback;
  if (value === 'buy' || value === 'sell' || value === 'both') return value;
  return fallback;
}

function parseCashOnFillActionValue(
  value: unknown,
  fallback: AppConfig['strategy']['cashOnFillAction']
): AppConfig['strategy']['cashOnFillAction'] {
  if (value === undefined || value === null || value === '') return fallback;
  if (value === 'hold' || value === 'sellWithinLossCap') return value;
  return fallback;
}
import { PredictVenue } from '../venues/predict.js';


async function predictReportSnapshot(loaded: ReturnType<typeof loadConfig>, store: ReturnType<typeof usingStore>): Promise<unknown> {
  try {
    const config = loaded.config;
    const openOrders = store.listOpenOrders()
      .filter((order) => order.venue === 'predict' && ['OPEN', 'PENDING_OPEN', 'PLANNED', 'UNKNOWN'].includes(order.status));

    if (openOrders.length === 0) return null;

    const allMarkets = await getSharedCachedMarkets(config, 'predict', undefined as never, store);
    const marketIdByToken = new Map<string, string>();
    for (const market of allMarkets) {
      marketIdByToken.set(market.tokenId, market.marketId ?? market.tokenId);
    }

    const wsCfg = config.venues.predict;
    const ws = PredictVenue.getSharedWsClient(wsCfg.wsUrl, wsCfg.apiKey || undefined);
    const books = new Map<string, import('../domain/types.js').Orderbook>();
    if (ws) {
      for (const order of openOrders) {
        const marketId = marketIdByToken.get(order.tokenId) ?? order.tokenId;
        const cached = ws.getCachedOrderbook(marketId, order.tokenId, 60_000);
        if (cached) books.set(marketId, cached);
      }
    }

    const report = generatePredictReport({
      config,
      openOrders,
      markets: allMarkets,
      books,
      marketIdByToken,
      wsWatchedMarkets: ws?.watchedMarketCount() ?? 0
    });

    return report;
  } catch {
    return null;
  }
}
export async function predictReport(configPath: string): Promise<unknown> {
  const loaded = loadConfig(configPath);
  ensureDataDirs(loaded.dataDir);
  const store = usingStore(loaded.dataDir);
  const config = loaded.config;

  const openOrders = store.listOpenOrders()
    .filter((order) => order.venue === 'predict' && ['OPEN', 'PENDING_OPEN', 'PLANNED', 'UNKNOWN'].includes(order.status));

  const allMarkets = await getSharedCachedMarkets(config, 'predict', /* adapter */ undefined as never, store);

  // Build marketId → tokenId mapping from markets
  const marketIdByToken = new Map<string, string>();
  for (const market of allMarkets) {
    marketIdByToken.set(market.tokenId, market.marketId ?? market.tokenId);
  }

  // Grab WS cache
  const wsCfg = config.venues.predict;
  const ws = PredictVenue.getSharedWsClient(wsCfg.wsUrl, wsCfg.apiKey || undefined);
  const books = new Map<string, import('../domain/types.js').Orderbook>();
  if (ws) {
    for (const order of openOrders) {
      const marketId = marketIdByToken.get(order.tokenId) ?? order.tokenId;
      const cached = ws.getCachedOrderbook(marketId, order.tokenId, 60_000);
      if (cached) books.set(marketId, cached);
    }
  }

  const report = generatePredictReport({
    config,
    openOrders,
    markets: allMarkets,
    books,
    marketIdByToken,
    wsWatchedMarkets: ws?.watchedMarketCount() ?? 0
  });

  return { ok: true, report };
}
