import type { AppConfig } from '../config/schema.js';
import type { AccountRiskDecision, AccountRiskSnapshot, Market, NativeGasBalance, OpenOrder, Orderbook, Position, VenueName } from '../domain/types.js';
import type { SignerProvider } from '../secrets/signer.js';
import type { StateStore } from '../store/sqlite.js';
import { rejectReason } from '../risk/reject-reasons.js';
import { planReplaceRaceDefer, primaryStableBalance } from '../risk/capital-risk.js';
import { StrategyEngine } from '../strategy/strategy-engine.js';
import { completeSetInventoryGroups, isCashMultiMarketEntry, isPairedEntryMode } from '../strategy/paired-inventory.js';
import type { VenueAdapter } from '../venues/types.js';
import { mergeMarkets } from './market-merge.js';
import { AccountSyncService } from './account-sync.js';
import { OrderReconciler } from './order-reconciler.js';
import { fullCashAuditBasketFromValue, RouteService } from './route-service.js';
import { LiquidationService } from './liquidation-service.js';
import { MarketDataSyncService } from './market-data-sync.js';
import { CancelService } from './cancel-service.js';
import { CashFillExitService, isMaterialCashPosition, type CashFillExitResult } from './cash-fill-exit-service.js';
import { ExecutionRecorder } from './event-recorder.js';
import { QuoteCycleService } from './quote-cycle-service.js';
import { SplitEntryService } from './split-entry-service.js';
import { accountRiskWindowStart } from '../risk/risk-window.js';
import { evaluateAccountRisk } from '../risk/account-risk.js';

const CASH_NEW_ORDER_PAUSE_CHECKPOINT_PREFIX = 'cash-new-order-pause';
const KILL_EXIT_MAX_ATTEMPTS = 8;
// Wait between in-cycle kill-exit retries so chain-confirmed exits free up CTF/USDC balance before the next submit
// (Polymarket rejects "not enough balance / allowance" until the on-chain settlement of the prior exit lands).
const KILL_EXIT_BACKOFF_MS = 1500;

export interface RunOnceOptions {
  venue: VenueName;
  signer: SignerProvider;
  /**
   * Fast quote-refresh tick: re-quote ONLY the markets that currently hold resting orders/positions, reading their
   * order books from the WS cache and skipping the full-universe candidate audit (the ~16s bottleneck). All account
   * safety (orders/positions/balances sync, global stop-loss, per-fill exit, account-risk gate) still runs exactly as
   * in a full cycle — only the market-discovery + full-book audit is skipped. New-market discovery/rotation happens on
   * full cycles. When there are no active markets this tick simply does maintenance and returns.
   */
  fast?: boolean;
}

export interface RunOnceResult {
  stopRequested?: boolean;
  stopReason?: 'daily-loss-limit' | 'equity-drawdown-limit';
  canceledManagedOrders?: number;
  /**
   * Risk-stop fired but positions remain after the in-cycle kill-exit retries. The loop must keep cycling in
   * exit-only mode (no new entries) until the positions truly clear; only then is it safe to stopRequested.
   */
  exitOnlyMode?: boolean;
  /** Count of material positions remaining when exitOnlyMode is true, for visibility. */
  exitOnlyPendingPositions?: number;
}

function accountRiskStopReason(reason: AccountRiskDecision['reason']): RunOnceResult['stopReason'] | undefined {
  if (reason === 'daily-loss-limit' || reason === 'equity-drawdown-limit') return reason;
  return undefined;
}

export class ExecutionEngine {
  private readonly strategy: StrategyEngine;
  private readonly accountSync: AccountSyncService;
  private readonly orderReconciler: OrderReconciler;
  private readonly routeService: RouteService;
  private readonly liquidationService: LiquidationService;
  private readonly marketDataSync: MarketDataSyncService;
  private readonly cancelService: CancelService;
  private readonly cashFillExitService: CashFillExitService;
  private readonly recorder: ExecutionRecorder;
  private readonly quoteCycleService: QuoteCycleService;
  private readonly splitEntryService: SplitEntryService;

  constructor(
    private readonly config: AppConfig,
    private readonly adapter: VenueAdapter,
    private readonly store: StateStore
  ) {
    this.strategy = new StrategyEngine(config);
    this.accountSync = new AccountSyncService(config, adapter, store);
    this.orderReconciler = new OrderReconciler(adapter, store);
    this.routeService = new RouteService(config, store);
    this.liquidationService = new LiquidationService(config, adapter, store);
    this.marketDataSync = new MarketDataSyncService(config, adapter, store);
    this.cancelService = new CancelService(config, adapter, store);
    this.cashFillExitService = new CashFillExitService(config, adapter, store);
    this.recorder = new ExecutionRecorder(store);
    this.quoteCycleService = new QuoteCycleService(config, adapter, store);
    this.splitEntryService = new SplitEntryService(config, adapter, store);
  }

  async runOnce(options: RunOnceOptions): Promise<RunOnceResult> {
    const signerAddress = options.signer.address;
    const dayStart = accountRiskWindowStart(options.venue, this.store);
    this.stage(options.venue, 'syncing-orders', '同步平台开放订单');
    let openOrders: OpenOrder[];
    if (options.fast) {
      // Sub-second re-pin: read resting orders from the store cache (kept current by full cycles' reconcile + this
      // fast path's own place/cancel writes) instead of the ~1.2s getOpenOrders REST, so the loop can re-pin many
      // markets to their level within a tick. Fills are still caught by the freshly-synced positions + per-fill
      // circuit breaker below; full cycles reconcile the store against the live CLOB.
      openOrders = this.store.listManagedOpenOrders(options.venue)
        .filter((order) => order.status === 'OPEN' || order.status === 'PENDING_OPEN');
    } else {
      const openOrderSync = await this.orderReconciler.syncOpenOrders(options.venue, signerAddress);
      if (!openOrderSync.ok) {
        this.stage(options.venue, 'idle', '开放订单同步失败，本轮结束');
        return {};
      }
      openOrders = openOrderSync.openOrders;
    }
    this.stage(options.venue, 'syncing-positions', '同步平台持仓');
    // Orders + positions are read sequentially (not concurrently): the Polymarket data API rate-limits concurrent
    // same-origin reads, so firing them together actually slows the positions read to several seconds.
    const positionSync = await this.accountSync.syncPositions({
      venue: options.venue,
      signerAddress
    });
    if (!positionSync.ok) {
      this.stage(options.venue, 'idle', '持仓同步失败，本轮结束');
      return {};
    }
    let positions = positionSync.positions;
    let accountRisk: AccountRiskDecision;
    if (options.fast) {
      // Fast tick: reuse the most recent account-risk snapshot (refreshed every full cycle) instead of re-pulling the
      // full fills/equity history each second — that pull is the dominant per-tick cost. evaluateAccountRisk re-checks
      // the snapshot age, so a too-old snapshot still blocks new orders safely, and the per-fill exit below still runs
      // on freshly-synced positions, so a fill is still detected and exited within this same tick.
      this.stage(options.venue, 'syncing-account', '快速重报价：复用最近账户风控快照(跳过全量成交历史拉取)');
      const cachedSnapshot = this.store.getLatestAccountRiskSnapshot(options.venue);
      const snapshotForEval = cachedSnapshot
        ? ({ ...cachedSnapshot, fills: [], positions: [], balances: [] } as AccountRiskSnapshot)
        : undefined;
      accountRisk = evaluateAccountRisk(options.venue, this.config, snapshotForEval);
    } else {
      this.stage(options.venue, 'syncing-account', '同步账户级成交、仓位、余额和权益风控');
      accountRisk = await this.accountSync.accountRiskGate({ venue: options.venue, signerAddress, signer: options.signer, dayStart });
    }
    const stopReason = accountRiskStopReason(accountRisk.reason);
    if (stopReason) {
      const cancel = await this.cancelService.cancelManagedOrders(
        options.venue,
        openOrders,
        '账户总止损触发',
        'risk.daily-loss-stop.cancel-managed'
      );
      let killExit: CashFillExitResult | undefined;
      let exitPositions = positions.filter((position) => position.venue === options.venue && isMaterialCashPosition(this.config, position));
      if (exitPositions.length > 0) {
        for (let attempt = 0; attempt < KILL_EXIT_MAX_ATTEMPTS && exitPositions.length > 0; attempt += 1) {
          const killMarkets = await this.cashExitMarkets(options.venue, exitPositions);
          this.adapter.hydrateFromMarkets?.(killMarkets);
          const exit = await this.cashFillExitService.process({
            venue: options.venue,
            signer: options.signer,
            positions: exitPositions,
            openOrders: cancel.openOrders,
            markets: killMarkets,
            force: true
          });
          killExit = mergeCashExitResults(killExit, exit);
          // After each submit (even partial/failed), pause briefly so prior fills/cancels settle on-chain and free up
          // CTF/USDC balance; "not enough balance / allowance" is the venue's race-condition rejection and clears within
          // ~1-2s. Then re-sync positions and keep trying as long as positions remain — do NOT break on submitted===0
          // when positions are still material, because that is exactly when the previous fix mis-bailed.
          if (attempt + 1 < KILL_EXIT_MAX_ATTEMPTS && exitPositions.length > 0) {
            await new Promise((resolve) => setTimeout(resolve, KILL_EXIT_BACKOFF_MS));
          }
          const resync = await this.accountSync.syncPositions({ venue: options.venue, signerAddress });
          if (!resync.ok) break;
          exitPositions = resync.positions.filter((position) => position.venue === options.venue && isMaterialCashPosition(this.config, position));
        }
      }
      this.recorder.runCheckpoint(options.venue, {
        skippedQuoting: true,
        stopRequested: true,
        stopReason,
        accountRisk,
        canceledManagedOrders: cancel.canceledIds.length,
        ...(killExit ? { killExit } : {})
      });
      // If positions remain after the in-cycle retries, do NOT stop the loop yet — keep cycling in exit-only mode so
      // each subsequent cycle re-enters this same branch (account-risk is still tripped) and runs another kill-exit
      // round. Only set stopRequested when positions are truly clear. This is the fix for "止损停机后没卖完剩仓"
      // — risk-stop must halt NEW entries, but exiting existing positions is the bot's obligation regardless.
      const pendingPositions = exitPositions.length;
      const positionsCleared = pendingPositions === 0;
      const stageMessage = positionsCleared
        ? '总止损金额已触发，已撤机器人受管挂单并停止实盘，需手动重新开启'
        : `总止损金额已触发，仍有 ${pendingPositions} 个未平仓位，仅退出模式继续循环直到清零`;
      this.stage(options.venue, positionsCleared ? 'stopping' : 'exiting-positions', stageMessage, {
        reason: stopReason,
        canceledManagedOrders: cancel.canceledIds.length,
        pendingPositions
      });
      this.store.checkpoint(`route.${options.venue}`, {
        mode: 'live',
        reason: stageMessage,
        switched: false,
        selected: [],
        candidates: [],
        stopRequested: positionsCleared,
        exitOnlyMode: !positionsCleared,
        exitOnlyPendingPositions: pendingPositions,
        stopReason,
        canceledManagedOrders: cancel.canceledIds.length,
        ...(killExit ? { killExit } : {})
      });
      return positionsCleared
        ? { stopRequested: true, stopReason, canceledManagedOrders: cancel.canceledIds.length }
        : { exitOnlyMode: true, exitOnlyPendingPositions: pendingPositions, stopReason, canceledManagedOrders: cancel.canceledIds.length };
    }
    const fillCircuitBreaker = await this.maybeTripCashFillCircuitBreaker(options, openOrders, positions);
    if (fillCircuitBreaker.tripped) {
      this.recorder.runCheckpoint(options.venue, {
        fillCircuitBreaker: true,
        canceledManagedOrders: fillCircuitBreaker.canceled,
        cashExit: fillCircuitBreaker.exit,
        skippedQuoting: true
      });
      this.store.checkpoint(`route.${options.venue}`, {
        mode: 'live',
        reason: '现金单边检测到成交/持仓，已执行成交保护：撤销机器人受管挂单并按止损设置处理；持仓清空后继续扫描，只有总止损金额触发才停止实盘',
        switched: false,
        selected: [],
        fillCircuitBreaker: true,
        canceledManagedOrders: fillCircuitBreaker.canceled,
        cashExit: fillCircuitBreaker.exit
      });
      this.stage(options.venue, 'idle', '现金单边检测到成交/持仓，已执行成交保护并跳过本轮新增挂单', {
        canceledManagedOrders: fillCircuitBreaker.canceled,
        cashExit: fillCircuitBreaker.exit
      });
      return {};
    }
    if (!accountRisk.ok) {
      this.stage(options.venue, 'idle', '账户级风控拒绝，本轮结束', { reason: accountRisk.reason });
      return {};
    }
    // Fast tick with nothing resting and no inventory: there is nothing to re-pin and no fill to guard, so skip the
    // balance sync AND the market resolution (which would otherwise re-pull the candidate universe and dominate the
    // tick). The next full cycle owns discovery/placement; this keeps idle fast ticks cheap enough to poll often.
    if (options.fast && openOrders.length === 0 && positions.length === 0) {
      this.stage(options.venue, 'idle', '快速重报价：当前无在挂订单/持仓，等待下一轮全量发现挂单');
      return {};
    }
    this.stage(options.venue, 'syncing-balances', '同步可用余额');
    const balances = await this.accountSync.syncBalances({
      venue: options.venue,
      signerAddress,
      signer: options.signer
    });
    let markets: Market[];
    let books: Map<string, Orderbook>;
    let monitoredMarkets: Market[];
    let previousRouteTokenIds: string[];
    if (options.fast) {
      // FAST quote-refresh tick: re-quote ONLY the markets that currently hold resting orders/positions, reading their
      // books straight from the WS cache, and skip the full-universe sync + audit basket (the ~16s bottleneck). This
      // keeps the active orders pinned to their level sub-2s. New-market discovery/rotation stays on full cycles, so
      // when nothing is resting yet this tick just maintains and the next full cycle does the placement.
      this.stage(options.venue, 'syncing-markets', '快速重报价：只读在挂市场盘口(跳过全站审计)');
      const positionMarkets = await this.marketDataSync.resolveMarketsForPositions(options.venue, positions);
      const openOrderTokenIds = [...new Set(openOrders.map((order) => order.tokenId).filter(Boolean))];
      const openOrderMarkets = await this.marketDataSync.resolveMarketsForOpenOrders(options.venue, openOrderTokenIds);
      const activeMarkets = mergeMarkets(positionMarkets, openOrderMarkets);
      markets = activeMarkets;
      books = await this.marketDataSync.fillMissingOrderbooks(options.venue, activeMarkets, new Map());
      monitoredMarkets = activeMarkets;
      previousRouteTokenIds = this.previousRouteTokenIds(options.venue);
    } else {
      // WS health gate (predict venue): when the WS is reconnecting, skip market sync + new orders to
      // avoid a REST-fallback storm (up to 1.8s per uncached market). The WS reconnects in <30s and
      // the next cycle resumes full scanning automatically.
      const wsStats = this.adapter.wsWatchStats?.();
      if (options.venue === 'predict' && wsStats && !wsStats.connected && wsStats.watchedMarkets > 0) {
        this.stage(options.venue, 'ws-reconnecting', `WS 断线重连中(订阅 ${wsStats.watchedMarkets} 个市场)，跳过本轮市场同步和新增挂单`);
        this.recorder.event({
          venue: options.venue,
          severity: 'warn',
          type: 'ws.health.skip-cycle',
          message: 'Predict WS 断线，跳过本轮以避免 REST fallback 海量请求',
          details: { watchedMarkets: wsStats.watchedMarkets }
        });
        return {};
      }
      this.stage(options.venue, 'syncing-markets', '同步候选市场和订单簿');
      const marketSnapshot = await this.marketDataSync.sync(options.venue, { openOrders, positions });
      markets = marketSnapshot.markets;
      books = marketSnapshot.books;
      const splitEntry = await this.splitEntryService.ensurePairedInventory({
        venue: options.venue,
        signer: options.signer,
        signerAddress,
        markets,
        books,
        balances,
        positions,
        openOrders
      });
      positions = splitEntry.positions;
      const positionMarkets = await this.marketDataSync.resolveMarketsForPositions(options.venue, positions);
      const openOrderTokenIds = [...new Set(openOrders.map((order) => order.tokenId).filter(Boolean))];
      const openOrderMarkets = await this.marketDataSync.resolveMarketsForOpenOrders(options.venue, openOrderTokenIds);
      const activeMarkets = mergeMarkets(positionMarkets, openOrderMarkets);
      markets = mergeMarkets(activeMarkets, markets);
      books = await this.marketDataSync.fillMissingOrderbooks(options.venue, activeMarkets, books);
      monitoredMarkets = mergeMarkets(positionMarkets, openOrderMarkets, markets);
      previousRouteTokenIds = this.previousRouteTokenIds(options.venue);
      books = await this.refreshAuditBasketOrderbooks(options.venue, markets, books);
    }
    this.stage(options.venue, 'routing-market', '按 PP、流动性、竞争度和风控选择目标市场');
    const routeSelection = this.routeService.selectRoutes(options.venue, markets, books, openOrders, positions);
    this.stage(options.venue, 'canceling', '撤掉临近结算或不再安全的开放订单');
    openOrders = await this.cancelService.cancelGuardedOrders(options.venue, openOrders, routeSelection.candidates, monitoredMarkets);
    const routedMarkets = routeSelection.selected.map((candidate) => candidate.market);
    // On fast ticks the candidate universe is just the already-active markets, so don't overwrite the rich full-cycle
    // selection the UI/route history depends on — full cycles own market discovery + rotation bookkeeping.
    if (!options.fast) this.routeService.recordSelection(options.venue, routeSelection);
    if (routeSelection.switched && isPairedEntryMode(this.config)) {
      const gasPrecheck = await this.routeSwitchGasPrecheck(options, positions, monitoredMarkets, routedMarkets);
      if (!gasPrecheck.ok) {
        this.recorder.runCheckpoint(options.venue, { routeSwitchGasBlocked: true, skippedQuoting: true });
        this.stage(options.venue, 'idle', gasPrecheck.message);
        return {};
      }
      const switchExit = await this.liquidationService.process({
        venue: options.venue,
        signer: options.signer,
        positions,
        openOrders,
        markets: monitoredMarkets,
        refreshMarkets: () => this.marketDataSync.getCachedMarkets(options.venue),
        forceMergeCompleteSets: true,
        keepGroupKeys: routeSelection.selected.map((candidate) => candidate.groupKey).filter((key): key is string => Boolean(key)),
        reason: 'route-switch'
      });
      if (switchExit.attempted) {
        this.recorder.metric('run.route_switch_merge_transactions', switchExit.submitted, options.venue);
        this.recorder.runCheckpoint(options.venue, { routeSwitchMergeCount: switchExit.submitted, skippedQuoting: true });
        this.stage(options.venue, 'idle', switchExit.submitted > 0
          ? '路由切换已触发旧套仓合并，本轮不新增 maker 单'
          : '路由切换需要退出旧套仓，但合并未提交，本轮不新增 maker 单');
        return {};
      }
    }
    if (isPairedEntryMode(this.config) || this.config.strategy.onFillAction === 'sellAllAtMarket') {
      const liquidation = await this.liquidationService.process({
        venue: options.venue,
        signer: options.signer,
        positions,
        openOrders,
        markets: monitoredMarkets,
        refreshMarkets: () => this.marketDataSync.getCachedMarkets(options.venue)
      });
      if (liquidation.attempted) {
        this.recorder.metric('run.merge_exit_transactions', liquidation.submitted, options.venue);
        this.recorder.runCheckpoint(options.venue, { mergeExitCount: liquidation.submitted, skippedQuoting: true });
        this.stage(options.venue, 'idle', '检测到持仓并已执行合并退出处理，本轮不新增 maker 单');
        return {};
      }
    }
    this.stage(options.venue, 'planning-quotes', '生成 PP maker 挂单计划');
    const reuseFreshRouteBooks = isCashMultiMarketEntry(this.config);
    books = await this.marketDataSync.refreshOrderbooks(options.venue, routedMarkets, books, { reuseFresh: reuseFreshRouteBooks });
    const routeSides = new Map(routeSelection.selected.map((candidate) => [candidate.market.tokenId, candidate.side] as const));
    const intents = this.strategy.buildIntents(options.venue, routedMarkets, books, { positions, openOrders, balances, routeSides });
    books = await this.marketDataSync.refreshOrderbooks(options.venue, intents.map((intent) => intent.market), books, { reuseFresh: reuseFreshRouteBooks });
    const replaceCancel = await this.cancelService.cancelReplaceableOrders(options.venue, openOrders, intents, monitoredMarkets, books, previousRouteTokenIds, {
      requireFreshReplacementForObsoleteCashOrders: routeSelection.switched && !isPairedEntryMode(this.config),
      deferObsoleteCancels: options.fast === true
    });
    openOrders = replaceCancel.openOrders;
    if (replaceCancel.canceledIds.length > 0 && this.config.strategy.entryMode === 'split') {
      this.recorder.runCheckpoint(options.venue, {
        replaceCancelCount: replaceCancel.canceledIds.length,
        skippedQuoting: true
      });
      this.stage(options.venue, 'idle', '双边 SELL 已因盘口保护撤换，本轮等待下一轮重新读取盘口后再挂单', {
        canceledIds: replaceCancel.canceledIds
      });
      return {};
    }
    const cashPause = this.cashNewOrderPause(options.venue);
    if (cashPause.active) {
      this.recorder.runCheckpoint(options.venue, {
        skippedQuoting: true,
        cashNewOrderPaused: true,
        pauseReason: cashPause.reason,
        pausedUntil: cashPause.until
      });
      this.store.recordEvent({
        venue: options.venue,
        severity: 'warn',
        type: 'quote.new-orders-paused',
        message: `现金单边新挂单暂停：${cashPause.reason}`,
        details: {
          reason: cashPause.reason,
          until: cashPause.until,
          source: cashPause.source
        }
      });
      this.stage(options.venue, 'idle', '现金单边新挂单短暂停止，本轮只做同步和撤单维护', {
        reason: cashPause.reason,
        until: cashPause.until
      });
      return {};
    }
    // Replace-race guard: on wallets too small to hold a just-cancelled order AND its replacement at the same time,
    // defer the re-place one cycle so the cancel settles first (otherwise the venue counts old+new on the collateral
    // group and rejects "not enough balance / allowance"). Cash single-sided only; paired/split is untouched.
    const availableUsd = primaryStableBalance(balances)?.available ?? 0;
    const replaceRace = isPairedEntryMode(this.config)
      ? { placeable: intents, deferredTokenIds: [] as string[] }
      : planReplaceRaceDefer(intents, replaceCancel.canceledTokenIds ?? [], availableUsd);
    if (replaceRace.deferredTokenIds.length > 0) {
      this.store.recordEvent({
        venue: options.venue,
        severity: 'info',
        type: 'quote.replace-defer-settle',
        message: `余额不足以在同一抵押组同时容纳新旧两单(可用 $${availableUsd.toFixed(2)} < 2×单笔)，本轮先撤旧、下一轮待撤销结算后再挂新，避免"余额不足"被拒(${replaceRace.deferredTokenIds.length} 个)`,
        details: { tokens: replaceRace.deferredTokenIds, availableUsd, semantics: 'defer-one-cycle' }
      });
    }
    const quoteCycle = await this.quoteCycleService.process({
      venue: options.venue,
      signer: options.signer,
      signerAddress,
      dayStart,
      intents: replaceRace.placeable,
      books,
      balances,
      positions,
      openOrders,
      accountRiskDecision: accountRisk
    });
    this.stage(options.venue, 'idle', '本轮实盘循环完成', {
      accepted: quoteCycle.accepted,
      rejected: quoteCycle.rejected,
      balanceSkipped: quoteCycle.balanceSkipped
    });
    return {};
  }

  async assertAccountRiskAllowsOrder(venue: VenueName, signerAddress: string, signer: SignerProvider): Promise<AccountRiskDecision> {
    return this.accountSync.accountRiskGate({ venue, signerAddress, signer, dayStart: accountRiskWindowStart(venue, this.store), scope: 'manual-order' });
  }

  private previousRouteTokenIds(venue: VenueName): string[] {
    const checkpoint = this.store.getCheckpoint(`route.${venue}`)?.value;
    if (!checkpoint || typeof checkpoint !== 'object') return [];
    const selected = (checkpoint as { selected?: unknown }).selected;
    if (!Array.isArray(selected)) return [];
    return selected
      .map((item) => (item && typeof item === 'object' ? (item as { tokenId?: unknown }).tokenId : undefined))
      .filter((tokenId): tokenId is string => typeof tokenId === 'string' && tokenId.length > 0);
  }

  private async refreshAuditBasketOrderbooks(
    venue: VenueName,
    markets: Market[],
    books: Map<string, Orderbook>
  ): Promise<Map<string, Orderbook>> {
    if (!isCashMultiMarketEntry(this.config)) return books;
    const audit = this.store.getCheckpoint(`route-audit.${venue}`)?.value;
    const fullAuditBasket = fullCashAuditBasketFromValue(audit);
    if (!fullAuditBasket) return books;
    const tokenIds = fullAuditBasket.tokenIds.slice(0, Math.max(1, this.config.risk.maxMarkets));
    if (tokenIds.length === 0) return books;
    const byToken = new Map(markets.map((market) => [market.tokenId, market] as const));
    const basketMarkets = tokenIds.flatMap((tokenId) => {
      const market = byToken.get(tokenId);
      return market ? [market] : [];
    });
    if (basketMarkets.length === 0) return books;
    return this.marketDataSync.refreshOrderbooks(venue, basketMarkets, books, { reuseFresh: true });
  }

  private stage(venue: VenueName, stage: string, message: string, details: Record<string, unknown> = {}): void {
    this.recorder.stage(venue, stage, message, details);
  }

  private async maybeTripCashFillCircuitBreaker(
    options: RunOnceOptions,
    openOrders: OpenOrder[],
    positions: Position[]
  ): Promise<{ tripped: boolean; canceled: number; exit?: CashFillExitResult }> {
    const venue = options.venue;
    if (isPairedEntryMode(this.config) || this.config.strategy.entryMode !== 'cash') {
      return { tripped: false, canceled: 0 };
    }
    // Two-sided Polymarket LP intentionally holds inventory on both legs, so the
    // per-fill cancel-and-protect trip would fight the strategy. There the
    // account-level total stop-loss remains the backstop instead.
    if (venue === 'polymarket' && this.config.strategy.polymarketTwoSidedLp) {
      return { tripped: false, canceled: 0 };
    }
    const unexpected = hasUnexpectedCashPosition(this.config, positions, venue);
    if (!unexpected.tripped) {
      this.store.checkpoint(`fill-circuit-breaker.${venue}`, { active: false, checkedAt: new Date().toISOString() });
      return { tripped: false, canceled: 0 };
    }
    const previous = cashFillCircuitBreakerState(this.store.getCheckpoint(`fill-circuit-breaker.${venue}`)?.value);
    const positionFingerprint = cashPositionFingerprint(unexpected.positions);
    const shouldLog = !previous.active;
    this.store.checkpoint(`fill-circuit-breaker.${venue}`, {
      active: true,
      triggeredAt: previous.active && previous.triggeredAt ? previous.triggeredAt : new Date().toISOString(),
      checkedAt: new Date().toISOString(),
      positionFingerprint,
      positions: unexpected.positions,
      minPositionSizeToLiquidate: this.config.strategy.minPositionSizeToLiquidate,
      action: 'cancel-managed-and-protect'
    });
    if (shouldLog) {
      this.store.recordEvent({
        venue,
        severity: 'error',
        type: 'fill-circuit-breaker.triggered',
        message: '现金单边策略检测到持仓，疑似挂单被吃，撤销机器人受管挂单并按止损设置处理；清仓后继续扫描',
        details: {
          positions: unexpected.positions,
          minPositionSizeToLiquidate: this.config.strategy.minPositionSizeToLiquidate
        }
      });
    }
    const cancel = await this.cancelService.cancelManagedOrders(
      venue,
      openOrders,
      '现金单边成交/持仓保护',
      'fill-circuit-breaker.cancel-managed'
    );
    const markets = await this.cashExitMarkets(venue, positions);
    this.adapter.hydrateFromMarkets?.(markets);
    const exit = await this.cashFillExitService.process({
      venue,
      signer: options.signer,
      positions,
      openOrders: cancel.openOrders,
      markets
    });
    this.store.checkpoint(`fill-circuit-breaker.${venue}`, {
      active: true,
      triggeredAt: previous.active && previous.triggeredAt ? previous.triggeredAt : new Date().toISOString(),
      checkedAt: new Date().toISOString(),
      positionFingerprint,
      positions: unexpected.positions,
      minPositionSizeToLiquidate: this.config.strategy.minPositionSizeToLiquidate,
      action: this.config.strategy.cashOnFillAction === 'sellWithinLossCap' ? 'sell-within-loss-cap' : 'cancel-managed-and-protect',
      exit
    });
    return { tripped: true, canceled: cancel.canceledIds.length, exit };
  }

  private async cashExitMarkets(venue: VenueName, positions: Position[]): Promise<Market[]> {
    const positionMarkets = positions.map((position) => position.market).filter((market): market is Market => Boolean(market));
    if (positionMarkets.length > 0) return positionMarkets;
    try {
      return await this.marketDataSync.resolveMarketsForPositions(venue, positions);
    } catch {
      return [];
    }
  }

  private cashNewOrderPause(venue: VenueName): { active: boolean; reason?: string; until?: string; source?: string } {
    if (isPairedEntryMode(this.config) || this.config.strategy.entryMode !== 'cash') {
      return { active: false };
    }
    const checkpoint = this.store.getCheckpoint(`${CASH_NEW_ORDER_PAUSE_CHECKPOINT_PREFIX}.${venue}`)?.value;
    if (!checkpoint || typeof checkpoint !== 'object') return { active: false };
    const value = checkpoint as { until?: unknown; reason?: unknown; source?: unknown };
    if (typeof value.until !== 'string') return { active: false };
    const untilTs = Date.parse(value.until);
    if (!Number.isFinite(untilTs) || Date.now() >= untilTs) return { active: false };
    return {
      active: true,
      until: value.until,
      reason: typeof value.reason === 'string' ? value.reason : 'recent-monitoring-instability',
      source: typeof value.source === 'string' ? value.source : undefined
    };
  }

  private async routeSwitchGasPrecheck(
    options: RunOnceOptions,
    positions: Parameters<typeof completeSetInventoryGroups>[2],
    monitoredMarkets: Market[],
    routedMarkets: Market[]
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    if (options.venue !== 'predict' || !isPairedEntryMode(this.config)) return { ok: true };
    if (!this.adapter.estimateSplitMergeGas && !this.adapter.getNativeGasBalance) return { ok: true };
    const selectedKeys = new Set(routedMarkets.map((market) => market.marketId || market.eventId || market.conditionId || market.tokenId));
    const exitingGroups = completeSetInventoryGroups(this.config, monitoredMarkets, positions)
      .filter((group) => !group.markets.some((market) => selectedKeys.has(market.marketId || market.eventId || market.conditionId || market.tokenId)));
    if (exitingGroups.length === 0) return { ok: true };
    try {
      const gas = await this.estimateRouteSwitchGas(options.signer, routedMarkets[0], exitingGroups[0]?.markets[0]);
      if (!gas || gas.ok) return { ok: true };
      this.store.recordEvent({
        venue: options.venue,
        severity: 'error',
        type: 'route.switch-blocked',
        message: `换池前 BNB 手续费不足，保留当前池子：${gas.message}`,
        details: {
          gas,
          selectedMarkets: routedMarkets.map(publicMarket),
          exitingMarkets: exitingGroups.flatMap((group) => group.markets.map(publicMarket)),
          reject: rejectReason('PREDICT_ROUTE_SWITCH_GAS_LOW', 'liquidation', 'route-switch')
        }
      });
      return { ok: false, message: '换池前 BNB 手续费不足，已保留当前池子并跳过 merge/split' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.recordEvent({
        venue: options.venue,
        severity: 'warn',
        type: 'route.switch-blocked',
        message: `换池前 gas 检查暂不可用，保留当前池子：${message}`,
        details: {
          error: message,
          selectedMarkets: routedMarkets.map(publicMarket),
          exitingMarkets: exitingGroups.flatMap((group) => group.markets.map(publicMarket)),
          reject: rejectReason('PREDICT_ROUTE_SWITCH_GAS_UNAVAILABLE', 'liquidation', 'route-switch')
        }
      });
      return { ok: false, message: '换池前 gas 检查暂不可用，已保留当前池子并跳过 merge/split' };
    }
  }

  private async estimateRouteSwitchGas(
    signer: SignerProvider,
    selectedMarket: Market | undefined,
    exitingMarket: Market | undefined
  ): Promise<NativeGasBalance | undefined> {
    const mergeGas = this.adapter.estimateSplitMergeGas && exitingMarket
      ? await this.adapter.estimateSplitMergeGas(signer, {
        action: 'merge',
        market: exitingMarket,
        conditionId: exitingMarket.conditionId,
        amountUsd: this.config.risk.orderSizeUsd
      })
      : undefined;
    const splitGas = this.adapter.estimateSplitMergeGas && selectedMarket
      ? await this.adapter.estimateSplitMergeGas(signer, {
        action: 'split',
        market: selectedMarket,
        conditionId: selectedMarket.conditionId,
        amountUsd: this.config.risk.orderSizeUsd
      })
      : undefined;
    if (!mergeGas && !splitGas && this.adapter.getNativeGasBalance) return this.adapter.getNativeGasBalance(signer);
    const estimates = [mergeGas, splitGas].filter((item): item is NativeGasBalance => Boolean(item));
    if (estimates.length === 0) return undefined;
    const required = estimates.reduce((sum, item) => sum + (item.required ?? 0), 0);
    const balance = Math.min(...estimates.map((item) => item.balance).filter(Number.isFinite));
    if (!Number.isFinite(required) || required <= 0) return estimates.find((item) => !item.ok) ?? estimates[0];
    const ok = Number.isFinite(balance) && balance + 1e-12 >= required;
    const base = estimates.find((item) => !item.ok) ?? estimates[0]!;
    return {
      ...base,
      balance: Number.isFinite(balance) ? balance : base.balance,
      required,
      requiredSource: estimates.some((item) => item.requiredSource === 'fallback-estimate') ? 'fallback-estimate' : 'dynamic-estimate',
      ok,
      message: ok
        ? `当前 BNB 足够覆盖 route switch 的 merge+split 估算 ${required.toFixed(8)} BNB`
        : `当前 BNB 不足以覆盖 route switch 的 merge+split；当前约 ${(Number.isFinite(balance) ? balance : 0).toFixed(8)} BNB，预计至少 ${required.toFixed(8)} BNB`
    };
  }
}

function cashFillCircuitBreakerState(value: unknown): { active: boolean; positionFingerprint?: string; triggeredAt?: string } {
  if (!value || typeof value !== 'object') return { active: false };
  const state = value as { active?: unknown; positionFingerprint?: unknown; triggeredAt?: unknown };
  return {
    active: state.active === true,
    ...(typeof state.positionFingerprint === 'string' ? { positionFingerprint: state.positionFingerprint } : {}),
    ...(typeof state.triggeredAt === 'string' ? { triggeredAt: state.triggeredAt } : {})
  };
}

function cashPositionFingerprint(
  positions: Array<{ tokenId: string; size: number; notionalUsd: number; marketId?: string; outcome?: string }>
): string {
  return JSON.stringify(
    positions
      .map((position) => ({
        size: Number(position.size.toFixed(8)),
        notionalUsd: Number(position.notionalUsd.toFixed(6)),
        marketId: position.marketId,
        outcome: position.outcome
      }))
      .sort((a, b) => `${a.marketId ?? ''}:${a.outcome ?? ''}`.localeCompare(`${b.marketId ?? ''}:${b.outcome ?? ''}`))
  );
}

function hasUnexpectedCashPosition(
  config: AppConfig,
  positions: Position[],
  venue: VenueName
): { tripped: boolean; positions: Array<{ tokenId: string; size: number; notionalUsd: number; marketId?: string; outcome?: string }> } {
  const unsafePositions = positions
    .filter((position) => position.venue === venue)
    .filter((position) => isMaterialCashPosition(config, position))
    .map((position) => ({
      tokenId: position.tokenId,
      size: position.size,
      notionalUsd: position.notionalUsd,
      ...(position.marketId ? { marketId: position.marketId } : {}),
      ...(position.outcome ? { outcome: position.outcome } : {})
    }));
  return {
    tripped: unsafePositions.length > 0,
    positions: unsafePositions
  };
}

function mergeCashExitResults(a: CashFillExitResult | undefined, b: CashFillExitResult): CashFillExitResult {
  if (!a) return b;
  return {
    attempted: a.attempted || b.attempted,
    submitted: a.submitted + b.submitted,
    blocked: b.blocked,
    failed: a.failed + b.failed
  };
}

function publicMarket(market: Market): Record<string, unknown> {
  return {
    tokenId: market.tokenId,
    marketId: market.marketId,
    conditionId: market.conditionId,
    question: market.question,
    outcome: market.outcome
  };
}
