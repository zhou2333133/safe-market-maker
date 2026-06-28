import { ensureDataDirs, loadConfig } from '../config/load.js';
import { venueDisplayName, venueLiveEnabled } from '../config/live-enabled.js';
import { ExecutionEngine } from '../execution/engine.js';
import { shouldRetreatThinFront } from '../execution/cancel-service.js';
import type { AppConfig } from '../config/schema.js';
import type { OpenOrder, Market } from '../domain/types.js';
import { runPreflight } from '../execution/preflight.js';
import { usingStore } from '../store/ui-store.js';
import { HttpError } from '../venues/http.js';
import { logger } from '../observability/logger.js';
import { recordUiEvent } from './telemetry.js';
import { UiError } from './errors.js';
import { asRecord, createVenueForUi, loadSignerForUi, parseVenueParam } from './controller-utils.js';
import { clearLiveRunIntent, clearLiveStopIntent, readLiveRunIntent, readLiveStopIntent, saveLiveRunIntent, saveLiveStopIntent } from './live-intent.js';
import {
  completeLoopStop,
  createLiveLoopState,
  markLoopCycleCompleted,
  markLoopError,
  publicLoopState,
  rateLimitedCycleDelayMs,
  requestLoopStop,
  resetLoopRuntimeHandles,
  waitForNextCycle,
  type LiveLoops,
  type LiveLoopState
} from './live-loop-state.js';
import { cancelAllLive } from './manual-controller.js';
import { resolveVenueConfig } from '../config/venue-config.js';
import type { VenueName } from '../domain/types.js';
import type { SignerProvider } from '../secrets/signer.js';
import { publicErrorMessage } from '../observability/error-message.js';

const LIVE_LOOP_RETRY_MIN_MS = 5000;
const LIVE_LOOP_RETRY_MAX_MS = 60000;
const LIVE_LOOP_CYCLE_TIMEOUT_MS = 45000;
// Hard ceiling on a single cycle. The soft timeout (LIVE_LOOP_CYCLE_TIMEOUT_MS) only fires a callback; it lets
// the cycle keep running. If a cycle's runOnce(...) await never resolves — e.g. a Predict REST call awaiting
// a TCP socket the server never closes — the cycle wrapper used to block forever. Observed 2026-06-26: Predict
// cycle 572 hung 2h+ while the watchdog only logged staleness. After this hard timeout the cycle wrapper
// throws an error that the existing catch block treats as a retryable network-class fault and the loop schedules
// the next cycle ~5s later. The orphan promise is left to settle in the background (typically resolves when the
// OS-level socket timeout fires ~2 min later); accepting that small leak is preferable to a deadlocked loop.
const LIVE_LOOP_CYCLE_HARD_TIMEOUT_MS = 5 * 60 * 1000;
// Reuse the venue adapter across loop ticks instead of rebuilding it (preflight + CLOB credential derivation + WS
// connection) on every cycle. Fast quote-refresh ticks run ~10x more often than full cycles; rebuilding the adapter
// each tick would hammer the venue's auth/TLS endpoints (createApiKey) and churn the WS book subscription. The adapter
// is rebuilt only when that venue's own config block changes, or after a cycle error / loop stop clears the entry.
const liveAdapterCache = new Map<VenueName, { adapter: Awaited<ReturnType<typeof createVenueForUi>>; key: string }>();
const CASH_NEW_ORDER_PAUSE_AFTER_SLOW_CYCLE_MS = 120000;

export async function liveStart(configPath: string, body: unknown, liveLoops: LiveLoops): Promise<unknown> {
  const request = asRecord(body);
  const venue = parseVenueParam(request.venue);
  const existing = liveLoops.get(venue);
  if (existing?.status === 'running' || existing?.status === 'stopping') {
    const message = existing.status === 'running'
      ? `${venue} 实盘循环已经在运行中。`
      : `${venue} 实盘循环正在停止中，请等待当前一轮收尾。`;
    return {
      ok: true,
      alreadyActive: true,
      message,
      live: publicLoopState(existing, venue)
    };
  }
  const loaded = loadConfig(configPath);
  // Run this venue on its own fully-independent risk + strategy (Predict = unchanged base; Polymarket = its block).
  loaded.config = resolveVenueConfig(loaded.config, venue);
  if (!venueLiveEnabled(loaded.config, venue)) {
    throw new UiError(400, `${venueDisplayName(venue)} 实盘开关未开启。请在该模块页面打开并保存后再启动。`);
  }
  const selectedCount = loaded.config.selectedMarkets[venue].length;
  if (selectedCount === 0 && !loaded.config.strategy.autoSelectMarkets) {
    throw new UiError(400, '还没有选择实盘市场。请先在“市场”页应用推荐，或手动配置 selectedMarkets。');
  }
  const passphrase = typeof request.passphrase === 'string' && request.passphrase ? request.passphrase : (process.env.SAFE_MM_PASSPHRASE ?? '');
  ensureDataDirs(loaded.dataDir);
  let signer: SignerProvider | undefined;
  const store = usingStore(loaded.dataDir);
  try {
    store.recordEvent({
      venue,
      severity: 'warn',
      type: 'ui.live.start.requested',
      message: '用户点击开启实盘，开始启动流程',
      details: { selectedMarkets: selectedCount, autoSelectMarkets: loaded.config.strategy.autoSelectMarkets }
    });
    signer = loadSignerForUi(loaded.dataDir, venue, passphrase);
    if (!signer) {
      throw new UiError(400, '需要 keystore 密码才能启动实盘交易。请输入密码后重试。');
    }
    const adapter = await createVenueForUi(loaded.config, loaded.dataDir, venue, signer, passphrase);
    store.recordEvent({
      venue,
      type: 'ui.live.preflight.started',
      message: '开始实盘预检：运行时签名、凭据、市场、余额、授权、开放订单和风控',
      details: { timeoutMs: 6000 }
    });
    const preflight = await runPreflight({
      config: loaded.config,
      dataDir: loaded.dataDir,
      venue,
      signer,
      store,
      adapter,
      skipConfirm: true,
      preflightTimeoutMs: 6000,
      softNetworkChecks: true
    });
    if (!preflight.ok) {
      store.recordEvent({ venue, severity: 'error', type: 'ui.live.preflight.failed', message: '开始实盘预检失败', details: preflight });
      throw new UiError(400, '开始实盘预检失败', preflight);
    }
    store.recordEvent({ venue, type: 'ui.live.preflight.passed', message: '实盘预检通过', details: preflight });
  } catch (error) {
    store.recordEvent({
      venue,
      severity: 'error',
      type: 'ui.live.start.failed',
      message: publicErrorMessage(error)
    });
    throw error;
  } finally {
    store.close();
  }
  clearLiveStopIntent(loaded.dataDir, venue);
  const intent = saveLiveRunIntent(loaded.dataDir, venue, 'user-start', '用户点击开始实盘，服务重启或网络恢复后应自动恢复监控循环。');
  const sessionStartedAt = new Date(intent.sessionStartedAt);
  checkpointLiveSession(configPath, venue, intent.sessionStartedAt, 'user-start', '本轮实盘止损金额从这次点击开始统计');
  const loop = createLiveLoopState(venue, sessionStartedAt, { restartCount: 0 });
  liveLoops.set(venue, loop);
  loop.running = runLiveLoop(configPath, venue, passphrase, signer, loop).catch((error) => containVenueLoopFailure(configPath, venue, loop, error));
  recordUiEvent(configPath, venue, 'warn', 'ui.live.loop.started', '实盘循环已启动', {
    quoteRefreshMs: loaded.config.strategy.quoteRefreshMs,
    autoResume: true
  });
  return { ok: true, live: publicLoopState(loop, venue) };
}

export async function liveStop(configPath: string, body: unknown, liveLoops: LiveLoops): Promise<unknown> {
  const venue = parseVenueParam(asRecord(body).venue);
  const loaded = loadConfig(configPath);
  ensureDataDirs(loaded.dataDir);
  clearLiveRunIntent(loaded.dataDir, venue);
  saveLiveStopIntent(loaded.dataDir, venue, 'user-stop', '用户明确停止实盘循环；保留开放订单但不在下次服务启动时自动接管，除非再次点击开始实盘。');
  const loop = liveLoops.get(venue);
  const previousStatus = loop?.status ?? 'idle';
  requestLoopStop(loop);
  recordUiEvent(
    configPath,
    venue,
    'warn',
    'ui.live.stop.requested',
    loop ? '用户点击停止，已请求实盘循环停止' : '用户点击停止，但当前没有运行中的实盘循环',
    { previousStatus, currentStatus: loop?.status ?? 'idle' }
  );
  checkpointLiveStage(configPath, venue, loop ? 'stopping' : 'idle', loop ? '正在等待当前实盘循环收尾' : '实盘循环已停止，不会自动恢复');
  return { ok: true, live: publicLoopState(liveLoops.get(venue), venue) };
}

export async function liveStopAndCancel(configPath: string, body: unknown, liveLoops: LiveLoops): Promise<unknown> {
  const request = asRecord(body);
  const venue = parseVenueParam(request.venue);
  const loaded = loadConfig(configPath);
  ensureDataDirs(loaded.dataDir);
  clearLiveRunIntent(loaded.dataDir, venue);
  saveLiveStopIntent(loaded.dataDir, venue, 'user-stop-and-cancel', '用户明确停止并撤单；不在下次服务启动时自动恢复。');
  const loop = liveLoops.get(venue);
  recordUiEvent(configPath, venue, 'warn', 'ui.live.stop-and-cancel.requested', '用户点击停止并撤单，开始停止循环并准备撤单', {
    previousStatus: loop?.status ?? 'idle'
  });
  requestLoopStop(loop);
  try {
    if (loop?.running) {
      recordUiEvent(configPath, venue, 'warn', 'ui.live.stop.waiting', '正在等待当前实盘循环真正停止');
      await loop.running.catch(() => undefined);
    }
    const cancelResult = await cancelAllLive(configPath, venue, request.passphrase ?? '', 'ui.stop-and-cancel');
    recordUiEvent(configPath, venue, 'warn', 'ui.live.stop-and-cancel.completed', `停止并撤单流程完成：${cancelResult.ids.length} 个订单`, {
      ids: cancelResult.ids
    });
    return { ok: true, live: publicLoopState(liveLoops.get(venue), venue), cancel: cancelResult };
  } catch (error) {
    recordUiEvent(configPath, venue, 'error', 'ui.live.stop-and-cancel.failed', error instanceof Error ? error.message : String(error));
    throw error;
  }
}

export function restoreLiveLoops(configPath: string, liveLoops: LiveLoops): void {
  const loaded = loadConfig(configPath);
  ensureDataDirs(loaded.dataDir);
  const store = usingStore(loaded.dataDir);
  for (const venue of ['predict', 'polymarket'] as const) {
    let intent = readLiveRunIntent(loaded.dataDir, venue);
    const stopIntent = readLiveStopIntent(loaded.dataDir, venue);
    if (stopIntent && !intent) {
      store.checkpoint(`stage.${venue}`, {
        stage: 'idle',
        message: '实盘循环已停止，不会自动恢复',
        stoppedAt: stopIntent.updatedAt,
        source: stopIntent.source
      });
    }
    const managedOpenOrders = store.listManagedOpenOrders(venue).filter((order) => order.status === 'OPEN');
    const liveEnabled = venueLiveEnabled(loaded.config, venue);
    const shouldAdoptOpenOrders = !intent && !stopIntent && liveEnabled && managedOpenOrders.length > 0;
    if (shouldAdoptOpenOrders) {
      intent = saveLiveRunIntent(loaded.dataDir, venue, 'open-order-adoption', '服务启动时发现当前机器人已有开放订单，自动接管监控，避免孤儿单。');
      store.checkpoint(`live-session.${venue}`, {
        startedAt: intent.sessionStartedAt,
        source: 'open-order-adoption',
        reason: '服务启动时发现已有机器人开放订单，本轮止损从接管时开始统计'
      });
    }
    if (!intent || liveLoops.get(venue)?.status === 'running') continue;
    try {
      if (!liveEnabled) {
        recordUiEvent(configPath, venue, 'warn', 'ui.live.resume.skipped', `检测到自动恢复意图，但 ${venueDisplayName(venue)} 实盘开关已关闭，未自动启动循环`);
        continue;
      }
      const signer = loadSignerForUi(loaded.dataDir, venue, '');
      if (!signer) {
        logger.warn('Auto-resume skipped: no signer available (VPS without runtime-secrets, requires manual passphrase entry)');
        return;
      }
      const resumedIntent = saveLiveRunIntent(loaded.dataDir, venue, 'auto-resume', 'UI/后端重启后按上次开始实盘意图自动恢复监控循环。');
      checkpointLiveSession(configPath, venue, resumedIntent.sessionStartedAt, 'auto-resume', '自动恢复沿用上次开始实盘时的本轮止损统计窗口');
      const loop = createLiveLoopState(venue, new Date(resumedIntent.sessionStartedAt), { restored: true, restartCount: 0 });
      liveLoops.set(venue, loop);
      loop.running = runLiveLoop(configPath, venue, process.env.SAFE_MM_PASSPHRASE ?? '', signer, loop).catch((error) => containVenueLoopFailure(configPath, venue, loop, error));
      const message = intent.source === 'open-order-adoption'
        ? '服务启动时发现已有开放订单，已自动接管监控，先同步真实开放订单再决定撤换或挂单'
        : '检测到上次实盘运行意图，已自动恢复循环，先同步真实开放订单再决定撤换或挂单';
      recordUiEvent(configPath, venue, 'warn', 'ui.live.auto-resumed', message, {
        intentUpdatedAt: intent.updatedAt,
        source: intent.source,
        managedOpenOrders: managedOpenOrders.length
      });
    } catch (error) {
      recordUiEvent(
        configPath,
        venue,
        'error',
        'ui.live.resume.failed',
        publicErrorMessage(error),
        { intentUpdatedAt: intent.updatedAt }
      );
    }
  }
  store.close();
}

async function runLiveLoop(
  configPath: string,
  venue: VenueName,
  passphrase: string,
  signer: SignerProvider,
  loop: LiveLoopState
): Promise<void> {
  try {
    while (!loop.stopRequested) {
      try {
        const loaded = loadConfig(configPath);
        // Each venue's cycle runs on its own independent risk + strategy (Predict base unchanged; Polymarket block).
       loaded.config = resolveVenueConfig(loaded.config, venue);
       ensureDataDirs(loaded.dataDir);
        const fastQuoteMs = venue === 'predict'
          ? (loaded.config.strategy.predictFastQuoteMs ?? 0)
          : (loaded.config.strategy.polymarketFastQuoteMs ?? 0);
        const fullCycleMs = venue === 'predict'
          ? (loaded.config.strategy.predictFullCycleMs ?? 0)
          : (loaded.config.strategy.polymarketFullCycleMs ?? 0);
        const fastRefreshEnabled = fastQuoteMs > 0 && fullCycleMs > 0;
        const fast = fastRefreshEnabled && Date.now() - (loop.lastFullCycleAt ?? 0) < fullCycleMs;
        // Adapter lifecycle: FAST ticks reuse the cached adapter (rebuilding per tick hammers the venue's auth/TLS —
        // the CLOB createApiKey storm), while FULL cycles always rebuild via createVenueForUi exactly like the
        // original loop — its preflight proactively renews near-expiry credentials (Predict JWT), which pure reuse
        // would silently disable. The rebuilt adapter replaces the cache so subsequent fast ticks reuse it.
        const adapterKey = JSON.stringify((loaded.config.venues as Record<string, unknown>)[venue]);
        const cachedAdapter = liveAdapterCache.get(venue);
        let adapter: Awaited<ReturnType<typeof createVenueForUi>>;
        if (fast && cachedAdapter && cachedAdapter.key === adapterKey) {
          adapter = cachedAdapter.adapter;
        } else {
          adapter = await createVenueForUi(loaded.config, loaded.dataDir, venue, signer, passphrase);
          liveAdapterCache.set(venue, { adapter, key: adapterKey });
        }
        const store = usingStore(loaded.dataDir);
        // Fast quote-refresh cadence (`fast` computed above): between full discovery cycles, run lighter ticks that
        // only re-quote already-active markets (skip the full-universe audit) so resting orders stay pinned to their
        // level. A full cycle is due once fullCycleMs has elapsed since the last one; venues with fastQuoteMs/
        // fullCycleMs = 0 always run full cycles exactly as before.
        let nextCycleMs = loaded.config.strategy.quoteRefreshMs;
        try {
          const cycle = loop.cycles + 1;
          if (!fast) store.recordEvent({ venue, type: 'ui.live.cycle.started', message: `第 ${cycle} 轮实盘循环开始` });
          let slowCycle = false;
          const runResult = await withLiveCycleTimeout(
            new ExecutionEngine(loaded.config, adapter, store).runOnce({ venue, signer, fast }),
            LIVE_LOOP_CYCLE_TIMEOUT_MS,
            venue,
            cycle,
            () => {
              slowCycle = true;
              const message = `${venue} live cycle ${cycle} exceeded ${LIVE_LOOP_CYCLE_TIMEOUT_MS}ms; waiting for it to finish before starting another cycle`;
              store.recordEvent({
                venue,
                severity: 'warn',
                type: 'ui.live.cycle.slow',
                message,
                details: { cycle, timeoutMs: LIVE_LOOP_CYCLE_TIMEOUT_MS }
              });
              store.checkpoint(`stage.${venue}`, {
                stage: 'slow-cycle',
                message: '本轮实盘循环超过预期耗时，正在等待它完成，避免启动重叠的路由/下单流程',
                cycle,
                timeoutMs: LIVE_LOOP_CYCLE_TIMEOUT_MS
              });
              if (loaded.config.strategy.entryMode === 'cash') {
                store.checkpoint(`cash-new-order-pause.${venue}`, {
                  until: new Date(Date.now() + CASH_NEW_ORDER_PAUSE_AFTER_SLOW_CYCLE_MS).toISOString(),
                  reason: '上一轮实盘循环超过 45 秒，短暂停止新增现金单边挂单，先恢复盘口监控稳定性',
                  source: 'ui.live.cycle.slow',
                  pauseMs: CASH_NEW_ORDER_PAUSE_AFTER_SLOW_CYCLE_MS,
                  cycle
                });
              }
            },
            {
              hardTimeoutMs: LIVE_LOOP_CYCLE_HARD_TIMEOUT_MS,
              onHardTimeout: () => {
                // Surface the hang loudly so the operator can see the supervisor self-healed. The orphaned
                // runOnce promise will resolve in the background when its underlying network call times out
                // at the OS level (typically ~2 min); we accept that small write-race risk in exchange for
                // recovering the loop within 5 min instead of waiting hours.
                store.recordEvent({
                  venue,
                  severity: 'error',
                  type: 'ui.live.cycle.hard-timeout',
                  message: `${venue} 实盘循环第 ${cycle} 轮卡死超过 ${LIVE_LOOP_CYCLE_HARD_TIMEOUT_MS / 1000} 秒，放弃当前 cycle 启动下一轮（supervisor 自愈）`,
                  details: { cycle, hardTimeoutMs: LIVE_LOOP_CYCLE_HARD_TIMEOUT_MS }
                });
              }
            }
          );
          if (runResult.stopRequested) {
            clearLiveRunIntent(loaded.dataDir, venue);
            saveLiveStopIntent(loaded.dataDir, venue, 'risk-stop', '总止损金额触发后自动停止；需手动点击开始才会重新挂单。');
            requestLoopStop(loop);
            store.recordEvent({
              venue,
              severity: 'error',
              type: 'ui.live.risk-stop',
              message: '总止损金额已触发，实盘循环自动停止并禁止自动恢复',
              details: runResult
            });
          } else if (runResult.exitOnlyMode) {
            // Risk-stop tripped but positions remain — persist the stop intent so the loop won't auto-resume on restart,
            // but keep cycling so each cycle re-runs the kill-exit branch until positions truly clear. Emit a single
            // event per cycle so the user sees pending count drop.
            clearLiveRunIntent(loaded.dataDir, venue);
            saveLiveStopIntent(loaded.dataDir, venue, 'risk-stop', '总止损金额触发后自动停止；正在循环退出剩余仓位，清零后才真正停止。');
            store.recordEvent({
              venue,
              severity: 'warn',
              type: 'ui.live.risk-stop.exiting',
              message: `总止损已触发，仍有 ${runResult.exitOnlyPendingPositions} 个未平仓位，仅退出模式继续`,
              details: runResult
            });
          }
          markLoopCycleCompleted(loop);
          // Stamp the full cycle's COMPLETION time (not its start): a full cycle can itself take longer than
          // fullCycleMs, so measuring from completion is what lets the fast ticks actually run for fullCycleMs before
          // the next full discovery cycle is due.
          if (!fast) loop.lastFullCycleAt = Date.now();
          // When fast quote-refresh is on, tick every fastQuoteMs (the full-vs-fast decision is time-based off
          // lastFullCycleAt); otherwise keep the rate-limited full-cycle cadence unchanged.
          nextCycleMs = fastRefreshEnabled
            ? fastQuoteMs
            : rateLimitedCycleDelayMs(
                loaded.config,
                venue,
                store.getCheckpoint(`market-scan.${venue}`)?.value
              );
          if (!fast) {
            store.recordEvent({
              venue,
              type: 'ui.live.cycle.completed',
              message: `第 ${loop.cycles} 轮实盘循环完成，等待下一轮`,
              details: {
                configuredNextCycleMs: loaded.config.strategy.quoteRefreshMs,
                nextCycleMs,
                slowCycle,
                fastRefreshEnabled
              }
            });
          }
        } finally {
          store.close();
        }
        await waitForNextCycleInterleaved(
          loop, loaded.config, loaded.dataDir, venue, adapter, nextCycleMs
        );
      } catch (error) {
        // Drop the cached adapter so the next attempt rebuilds a fresh client/credential/WS — the error may mean the
        // connection or credential went bad (e.g. a CLOB TLS/createApiKey failure).
        liveAdapterCache.delete(venue);
        if (!isRetryableLiveLoopError(error)) {
          recordLoopError(configPath, venue, markLoopError(loop, error));
          return;
        }
        const retryCount = (loop.retryCount ?? 0) + 1;
        const retryMs = retryDelayMs(retryCount);
        markLoopRetry(loop, error, retryCount, retryMs);
        recordLoopRetry(configPath, venue, error, retryCount, retryMs);
        await waitForNextCycle(loop, retryMs);
      }
    }
    completeLoopStop(loop);
    recordUiEvent(configPath, venue, 'warn', 'ui.live.loop.stopped', `实盘循环已真正停止，共完成 ${loop.cycles} 轮`, { cycles: loop.cycles });
    checkpointLiveStage(configPath, venue, 'idle', '实盘循环已真正停止');
  } finally {
    liveAdapterCache.delete(venue);
    resetLoopRuntimeHandles(loop);
  }
}

const FAST_RETREAT_INTERVAL_MS = 3000;
const FAST_RETREAT_MAX_CANCELS = 5;
const FAST_RETREAT_DEDUPE_MS = 10000;

async function waitForNextCycleInterleaved(
  loop: LiveLoopState,
  config: AppConfig,
  dataDir: string,
  venue: VenueName,
  adapter: Awaited<ReturnType<typeof createVenueForUi>>,
  totalMs: number
): Promise<void> {
  let remaining = totalMs;
  while (remaining > 0 && !loop.stopRequested) {
    const chunk = Math.min(FAST_RETREAT_INTERVAL_MS, remaining);
    await waitForNextCycle(loop, chunk);
    remaining -= chunk;
    if (venue === 'polymarket' && remaining > 0) {
      try {
        await runFastRetreat(config, dataDir, venue, adapter);
      } catch {
        // Best-effort: fast retreat failures must never kill the loop
      }
    }
  }
}

async function runFastRetreat(
  config: AppConfig,
  dataDir: string,
  venue: VenueName,
  adapter: Awaited<ReturnType<typeof createVenueForUi>>
): Promise<void> {
  const store = usingStore(dataDir);
  try {
    const orders: OpenOrder[] = store.listManagedOpenOrders(venue)
      .filter((o) => o.status === 'OPEN' && o.side === 'BUY');
    if (orders.length === 0) return;

    const toCancel: string[] = [];
    const lastCancelCheckpoint = store.getCheckpoint(`ws-protect.${venue}`);
    const lastCancelAt: number = (lastCancelCheckpoint?.value as Record<string, unknown> | undefined)?.lastProtectAt as number ?? 0;
    const now = Date.now();

    for (const order of orders) {
      if (toCancel.length >= FAST_RETREAT_MAX_CANCELS) break;
      if (now - lastCancelAt < FAST_RETREAT_DEDUPE_MS) break;

      const book = adapter.getCachedOrderbook?.(order.tokenId);
      if (!book) continue;

      const market = {
        venue: order.venue || venue,
        tokenId: order.tokenId,
        rewards: { enabled: true, maxSpreadCents: 3 }
      } as Market;

      const retreat = shouldRetreatThinFront(config, venue, order, market, book);
      if (!retreat) continue;

      toCancel.push(order.externalId);
    }

    if (toCancel.length === 0) return;

    await adapter.cancelOrders(toCancel);
    store.markOrdersCanceled(venue, toCancel);
    store.checkpoint(`ws-protect.${venue}`, { lastProtectAt: Date.now() });
    store.recordEvent({
      venue,
      severity: 'warn',
      type: 'quote.fast-retreat',
      message: `快速撤退检查撤单 ${toCancel.length} 单`
    });
  } finally {
    store.close();
  }
}

/**
 * Per-venue runtime firewall: if a venue's live loop ever fails fatally, the failure is fully contained to THAT
 * venue (status -> error, logged). The other venue runs as a completely separate async loop with its own state,
 * adapter, store handle and (different-origin) rate budget, so it keeps running untouched. We never rethrow, so
 * one venue can never bring down the shared process.
 */
function containVenueLoopFailure(configPath: string, venue: VenueName, loop: LiveLoopState, error: unknown): void {
  const message = markLoopError(loop, error);
  try {
    recordLoopError(configPath, venue, message);
  } catch {
    // logging must never re-throw
  }
}

export function isRetryableLiveLoopError(error: unknown): boolean {
  if (error instanceof HttpError) {
    return [401, 403, 408, 409, 425, 429].includes(error.status) || error.status >= 500;
  }
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (lower.includes('jwt is required') || lower.includes('private_key') || lower.includes('private key') || lower.includes('私钥') || lower.includes('签名')) return false;
  return [
    'timed out',
    'timeout',
    'aborted',
    'econnreset',
    'econnrefused',
    'enotfound',
    'etimedout',
    'fetch failed',
    'network',
    'socket',
    'orderbook unavailable',
    '订单簿',
    '盘口读取',
    'market list',
    '市场列表',
    // Polymarket clob-client raises "service not ready" when its internal initialization state has drifted
    // (typically after a long-running session where the SDK's cached server-time clock skews far enough that
    // signed messages fail the venue's freshness check). Subsequent calls succeed once the SDK re-syncs on the
    // next request — so this MUST be retryable, not a loop-killer. The Jun 25 04:45 incident froze POLY for
    // 2.5 hours because this string wasn't in the list.
    'service not ready'
  ].some((needle) => lower.includes(needle));
}

function retryDelayMs(retryCount: number): number {
  return Math.min(LIVE_LOOP_RETRY_MAX_MS, LIVE_LOOP_RETRY_MIN_MS * (2 ** Math.min(retryCount - 1, 4)));
}

function recordLoopError(configPath: string, venue: VenueName, message: string): void {
  const loaded = loadConfig(configPath);
  const store = usingStore(loaded.dataDir);
  try {
    store.recordEvent({ venue, severity: 'error', type: 'ui.live-loop.error', message });
    store.checkpoint(`stage.${venue}`, {
      stage: 'error',
      message,
      error: message
    });
  } finally {
    store.close();
  }
}

function checkpointLiveStage(configPath: string, venue: VenueName, stage: string, message: string): void {
  const loaded = loadConfig(configPath);
  const store = usingStore(loaded.dataDir);
  try {
    store.checkpoint(`stage.${venue}`, { stage, message });
  } finally {
    store.close();
  }
}

function checkpointLiveSession(configPath: string, venue: VenueName, startedAt: string, source: string, reason: string): void {
  const loaded = loadConfig(configPath);
  const store = usingStore(loaded.dataDir);
  try {
    const checkpointName = `live-session.${venue}`;
    const existing = store.getCheckpoint(checkpointName)?.value;
    const existingValue = existing && typeof existing === 'object' ? existing as Record<string, unknown> : {};
    const preserveBaseline = existingValue.startedAt === startedAt;
    store.checkpoint(checkpointName, {
      ...(preserveBaseline ? existingValue : {}),
      startedAt,
      source,
      reason
    });
  } finally {
    store.close();
  }
}

function markLoopRetry(loop: LiveLoopState, error: unknown, retryCount: number, retryMs: number): void {
  loop.status = 'running';
  loop.retryCount = retryCount;
  loop.retryAt = new Date(Date.now() + retryMs).toISOString();
  loop.lastError = publicErrorMessage(error);
}

function recordLoopRetry(configPath: string, venue: VenueName, error: unknown, retryCount: number, retryMs: number): void {
  const loaded = loadConfig(configPath);
  const store = usingStore(loaded.dataDir);
  try {
    store.recordEvent({
      venue,
      severity: 'warn',
      type: 'ui.live.retrying',
      message: publicErrorMessage(error),
      details: { retryCount, retryMs }
    });
    store.checkpoint(`stage.${venue}`, {
      stage: 'retrying',
      message: `网络或平台接口临时异常，${Math.round(retryMs / 1000)} 秒后自动重试`,
      retryCount,
      retryMs
    });
  } finally {
    store.close();
  }
}

export async function withLiveCycleTimeout<T>(
  promise: Promise<T>,
  ms: number,
  venue: VenueName,
  cycle: number,
  onTimeout?: () => void,
  options?: { hardTimeoutMs?: number; onHardTimeout?: () => void }
): Promise<T> {
  let softTimer: NodeJS.Timeout | undefined;
  let hardTimer: NodeJS.Timeout | undefined;
  let timedOut = false;
  let hardTimedOut = false;
  try {
    softTimer = setTimeout(() => {
      timedOut = true;
      onTimeout?.();
    }, ms);
    if (options?.hardTimeoutMs && options.hardTimeoutMs > ms) {
      // Race the promise against the hard ceiling. When the ceiling wins, throw a real error so the cycle
      // wrapper's catch sees a retryable network-class fault and schedules the next cycle. Without this race,
      // a runOnce that never resolves blocks the wrapper forever (observed in production 2026-06-26).
      const hardPromise = new Promise<never>((_, reject) => {
        hardTimer = setTimeout(() => {
          hardTimedOut = true;
          options.onHardTimeout?.();
          reject(new Error(`${venue} live cycle ${cycle} hard-timeout after ${options.hardTimeoutMs}ms; abandoning stuck cycle so the next one can start`));
        }, options.hardTimeoutMs);
      });
      return await Promise.race([promise, hardPromise]);
    }
    return await promise;
  } finally {
    if (softTimer) clearTimeout(softTimer);
    if (hardTimer) clearTimeout(hardTimer);
    if (timedOut && !hardTimedOut) {
      // Soft-timeout serialization: wait for the still-pending promise so the next cycle doesn't overlap.
      // Skipped on hard-timeout — that path DELIBERATELY abandons the promise so the loop can recover.
      await promise.catch(() => undefined);
    }
  }
}
