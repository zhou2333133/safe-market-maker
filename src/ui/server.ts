import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { ensureDataDirs, loadConfig } from '../config/load.js';
import { findDeadTopLevelPrefixedStrategyKeys } from '../config/venue-config.js';
import { startRetentionTimer } from '../store/sqlite.js';
import { appCss, appHtml, appScript } from './assets.js';
import { liveStatus, markLoopError, type LiveLoops } from './live-loop-state.js';
import { UiError } from './errors.js';
import { applyRecommendations, balances, grantPolymarketApprovals, orderbook, recommendations, routeAudit, startupFacts, predictReport, status, statusSummary, updateTradingConfig } from './query-controller.js';
import { liveStart, liveStop, liveStopAndCancel, restoreLiveLoops } from './live-controller.js';
import { cancelAll, manualOrder } from './manual-controller.js';
import { redact, redactString } from '../observability/redact.js';
import { publicErrorMessage } from '../observability/error-message.js';
import { logger } from '../observability/logger.js';
import { clearPassphrase, getPassphrase, isUnlocked, setPassphrase } from './passphrase-store.js';
export { submitLiveManualOrder } from './manual-controller.js';

export interface UiServerOptions {
  host?: string;
  port?: number;
  allowRemote?: boolean;
  enforceSingleton?: boolean;
}

export interface UiServerHandle {
  url: string;
  host: string;
  port: number;
  close(): Promise<void>;
}

class UiLockError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown
  ) {
    super(message);
  }
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const UI_LOCK_STALE_MS = 20000;

interface UiLockFile {
  project: 'safe-market-maker';
  kind: 'ui';
  pid: number;
  configPath: string;
  host: string;
  port: number;
  url: string;
  startedAt: string;
  updatedAt: string;
}

interface UiSingletonLock {
  update(serverInfo: { host: string; port: number; url: string }): void;
  release(): void;
}

let globalRejectionGuardInstalled = false;

const UNHANDLED_REJECTION_WINDOW_MS = 60_000;
const UNHANDLED_REJECTION_EXIT_THRESHOLD = 20;

/**
 * Process-level backstop so a stray async rejection from EITHER venue can never crash the shared process that
 * hosts both live loops. Each venue loop already .catch()es its own failures (see live-controller); this only
 * guards true strays. We log and keep running — the other venue must stay up.
 *
 * Escalation: a healthy process produces ~0 unhandled rejections. If we see > THRESHOLD inside WINDOW the
 * process is wedged in a tight rejection loop (typical: an adapter throwing a fresh promise per tick) and we
 * MUST exit so the OS/supervisor restarts a clean process — silent log spam at 100Hz is worse than restart.
 */
function installGlobalRejectionGuard(): void {
  if (globalRejectionGuardInstalled) return;
  globalRejectionGuardInstalled = true;
  const recent: number[] = [];
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection contained; process kept alive so the other venue keeps running', {
      reason: reason instanceof Error ? reason.message : String(reason)
    });
    const now = Date.now();
    recent.push(now);
    while (recent.length > 0 && now - recent[0]! > UNHANDLED_REJECTION_WINDOW_MS) recent.shift();
    if (recent.length >= UNHANDLED_REJECTION_EXIT_THRESHOLD) {
      logger.error(`Unhandled rejection storm: ${recent.length} in ${UNHANDLED_REJECTION_WINDOW_MS}ms — exiting so a supervisor can restart cleanly`);
      process.exit(1);
    }
  });
}

/**
 * The @predictdotfun SDK logs `[WARN]: When using a Predict account the maker and signer are ignored.` from its
 * OrderBuilder on EVERY order build (via console.warn). It is harmless noise but floods stderr (thousands of lines per
 * run). Drop exactly that line at the process level. NOTE: this is SDK-emitted, not our code — the only safe fix is to
 * filter it at the console sink; we cannot "move it to init" because we do not control the SDK's per-build call.
 */
let predictSdkNoiseFilterInstalled = false;
function installPredictSdkNoiseFilter(): void {
  if (predictSdkNoiseFilterInstalled) return;
  predictSdkNoiseFilterInstalled = true;
  const originalWarn = console.warn.bind(console);
  console.warn = function (...args: unknown[]): void {
    const head = typeof args[0] === 'string' ? args[0] : String(args[0] ?? '');
    if (head.includes('maker and signer are ignored')) return;
    originalWarn(...(args as Parameters<typeof console.warn>));
  } as typeof console.warn;
}

function extractHostname(hostHeader: string): string {
  return hostHeader.split(':')[0]?.replace(/^\[|\]$/g, '') ?? '';
}

/** Same-origin check for mutation endpoints. Returns the expected serverInfo URL the request must match. */
function isOriginAllowed(req: IncomingMessage, serverInfo: { host: string; port: number }): boolean {
  const origin = req.headers['origin'];
  const referer = req.headers['referer'];
  // Allow any loopback host. SSH tunnels map to different local ports, but the request
  // still originates from the local machine — the hostname is all that matters.
  const loopbackHosts = new Set(['127.0.0.1', 'localhost', serverInfo.host]);
  const loopbackHostAllowed = (host: string): boolean => {
    if (loopbackHosts.has(host)) return true;
    try {
      // Also allow 127.0.0.2 – 127.255.255.254 (legitimate loopback aliases)
      const u = new URL(`http://${host}/`);
      return /^127\.\d+\.\d+\.\d+$/.test(u.hostname);
    } catch { return false; }
  };
  if (!origin && !referer) {
    return loopbackHostAllowed(extractHostname(String(req.headers['host'] ?? '')));
  }
  if (origin) {
    try {
      return loopbackHostAllowed(new URL(String(origin)).hostname);
    } catch { return false; }
  }
  if (referer) {
    try {
      return loopbackHostAllowed(new URL(String(referer)).hostname);
    } catch { return false; }
  }
  return false;
}

export async function startUiServer(configPath: string, options: UiServerOptions = {}): Promise<UiServerHandle> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 8787;
  if (!LOOPBACK_HOSTS.has(host) && !options.allowRemote) {
    throw new Error('UI 默认只允许绑定 127.0.0.1；如果确认风险，使用 --allow-remote-ui。');
  }
  const loaded = loadConfig(configPath);
  ensureDataDirs(loaded.dataDir);
  installGlobalRejectionGuard();
  installPredictSdkNoiseFilter();
  startRetentionTimer(loaded.dataDir);
  const deadStrategyKeys = findDeadTopLevelPrefixedStrategyKeys(loaded.config);
  if (deadStrategyKeys.length > 0) {
    logger.warn(
      `配置陷阱: 顶层 strategy 中的以下键实际不生效(生效值在对应 venue 块), 请改到 polymarketParams/predictParams: ${deadStrategyKeys.join(', ')}`
    );
  }
  const singleton = acquireUiSingleton(loaded.configPath, loaded.dataDir, host, port, options.enforceSingleton !== false);
  const uiToken = randomBytes(32).toString('hex');
  const liveLoops: LiveLoops = new Map();
  const serverInfo = { host, port };
  const server = createServer((req, res) => {
    void handleRequest(req, res, loaded.configPath, uiToken, serverInfo, liveLoops).catch((error) => {
      const status = error instanceof UiError || error instanceof UiLockError ? error.status : 500;
      const message = publicErrorMessage(error);
      sendJson(res, status, {
        ok: false,
        error: redactString(message),
        ...(error instanceof UiError || error instanceof UiLockError
          ? error.details
            ? { details: redact(error.details) }
            : {}
          : {})
      });
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (error) {
    singleton?.release();
    throw error;
  }
  const address = server.address() as AddressInfo;
  const resolvedPort = address.port;
  serverInfo.port = resolvedPort;
  const url = `http://${host}:${resolvedPort}`;
  singleton?.update({ host, port: resolvedPort, url });
  restoreLiveLoops(loaded.configPath, liveLoops);
  const watchdog = startLoopStaleWatchdog(loaded.dataDir, liveLoops);
  const configWatcher = startConfigChangeWatcher(loaded.configPath, loaded.dataDir);
  return {
    url,
    host,
    port: resolvedPort,
    close: () => new Promise<void>((resolve, reject) => {
      clearInterval(watchdog);
      configWatcher?.close();
      server.close((error) => {
        singleton?.release();
        if (error) reject(error);
        else resolve();
      });
    })
  };
}

/**
 * Periodic in-process watchdog: every 5min, checks per-venue lastCycle from SQLite and emits a critical event
 * when the loop has been silent past the stale threshold (30min). Without this, a loop wedged in error state
 * (e.g. wallet-registry RPC timeout) silently sat for 6h before the user noticed — the user explicitly asked
 * for a self-detection signal so the 2h scheduled health-check can escalate immediately, instead of waiting
 * for next external poll.
 */
/**
 * Watch config.yaml for changes (any save → emit `config.changed` event with file mtime, size and a snippet hash).
 * This gives forensic reviews a clear "what changed between cycle X and Y" marker — earlier we had a hard-to-find
 * relationship between user edits and behavior shifts because config changes left no trace in the events table.
 */
function startConfigChangeWatcher(configPath: string, dataDir: string): { close(): void } | undefined {
  try {
    const fs = require('node:fs') as typeof import('node:fs');
    const path = require('node:path') as typeof import('node:path');
    const crypto = require('node:crypto') as typeof import('node:crypto');
    let debounceTimer: NodeJS.Timeout | undefined;
    let lastHash = '';
    const recordChange = (): void => {
      try {
        const buf = fs.readFileSync(configPath);
        const hash = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
        if (hash === lastHash) return;
        const previousHash = lastHash;
        lastHash = hash;
        const stat = fs.statSync(configPath);
        // Lazy import to avoid a startup-time DB open (the watcher only fires on real edits).
        void (async (): Promise<void> => {
          try {
            const { StateStore } = await import('../store/sqlite.js');
            const store = new StateStore(path.join(dataDir, 'state.sqlite'));
            try {
              store.recordEvent({
                severity: 'warn',
                type: 'config.changed',
                message: `config.yaml 修改:hash=${hash} size=${stat.size}B mtime=${stat.mtime.toISOString()}`,
                details: { hash, previousHash, size: stat.size, mtime: stat.mtime.toISOString(), path: configPath }
              });
            } finally { store.close(); }
          } catch { /* never throw from watcher */ }
        })();
      } catch { /* file unreadable, skip */ }
    };
    // Seed lastHash so the first event is a real change, not just the watcher booting.
    try { lastHash = require('node:crypto').createHash('sha256').update(require('node:fs').readFileSync(configPath)).digest('hex').slice(0, 16); } catch { /* ignore */ }
    const watcher = fs.watch(configPath, () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      // Debounce: editors often save in multiple bursts.
      debounceTimer = setTimeout(recordChange, 750);
    });
    return { close: () => { watcher.close(); if (debounceTimer) clearTimeout(debounceTimer); } };
  } catch { return undefined; }
}

function startLoopStaleWatchdog(dataDir: string, liveLoops: LiveLoops): NodeJS.Timeout {
  const LOOP_STALE_THRESHOLD_MS = 30 * 60 * 1000;
  const WATCHDOG_INTERVAL_MS = 5 * 60 * 1000;
  const lastAlertedAt = new Map<string, number>();
  const lastIntentionalStopInfoAt = new Map<string, number>();
  const tick = async (): Promise<void> => {
    try {
      const { StateStore } = await import('../store/sqlite.js');
      const path = await import('node:path');
      const dbPath = path.join(dataDir, 'state.sqlite');
      const store = new StateStore(dbPath);
      try {
        const now = Date.now();
        for (const venue of ['polymarket', 'predict'] as const) {
          const lastCycle = store.recentEventTs(venue, 'ui.live.cycle.completed');
          const loopStarted = store.recentEventTs(venue, 'ui.live.loop.started');
          const autoResumed = store.recentEventTs(venue, 'ui.live.auto-resumed');
          // Loop is considered "running" if either an explicit start OR an auto-resume happened. Earlier this only
          // checked loop.started, which silently skipped Predict (whose lifecycle is dominated by auto-resume across
          // restarts) — meaning Predict's 2.5h hang on cycle 3354 went undetected. lastCycle is the freshest signal
          // when present; otherwise fall back to whichever activation marker exists.
          const loopActivated = lastCycle ?? loopStarted ?? autoResumed;
          if (loopActivated === undefined) continue;
          const stalenessRef = lastCycle ?? loopActivated;
          const stalenessMs = now - stalenessRef;
          if (stalenessMs <= LOOP_STALE_THRESHOLD_MS) {
            lastAlertedAt.delete(venue);
            continue;
          }
          // Intentional-stop guard: if the loop was deliberately halted (risk-stop / user-stop), a stale cycle is
          // by-design — restoreLiveLoops never auto-resumes these, so the error below would be a FALSE alarm that
          // hides the real to-do (manual recovery in the UI). Downgrade to a single info event and skip auto-recovery.
          const stageCp = store.getCheckpoint('stage.' + venue);
          const stageVal = stageCp?.value as { stage?: string; source?: string } | undefined;
          if (stageVal && (stageVal.source === 'risk-stop' || stageVal.source === 'user-stop')) {
            const lastInfoMs = lastIntentionalStopInfoAt.get(venue) ?? 0;
            if (now - lastInfoMs >= LOOP_STALE_THRESHOLD_MS) {
              lastIntentionalStopInfoAt.set(venue, now);
              store.recordEvent({
                venue,
                severity: 'info',
                type: 'loop-stale-intentional-stop',
                message: `${venue} 实盘循环为主动停止（source=${stageVal.source}），非卡死，无需处理`,
                details: { lastCycleAt: lastCycle, stalenessMs, source: stageVal.source }
              });
            }
            continue;
          }
          // Re-alert at most once per stale window (every 30min) so we don't spam.
          const lastAlertMs = lastAlertedAt.get(venue) ?? 0;
          if (now - lastAlertMs < LOOP_STALE_THRESHOLD_MS) continue;
          lastAlertedAt.set(venue, now);
          store.recordEvent({
            venue,
            severity: 'error',
            type: 'loop-stale-detected',
            message: `${venue} 主循环已 ${Math.round(stalenessMs / 60000)} 分钟无 cycle（阈值 ${LOOP_STALE_THRESHOLD_MS / 60000} 分钟），可能进入 error 态或卡死`,
            details: { lastCycleAt: lastCycle, loopStartedAt: loopStarted, stalenessMs, thresholdMs: LOOP_STALE_THRESHOLD_MS }
          });
          // When the loop is stale for > 1h, attempt auto-recovery: mark the loop state as error so the UI
          // reflects reality, and let any existing inter-cycle stall watchdog / restart logic take over.
          if (stalenessMs > 60 * 60 * 1000) {
            const loop = liveLoops.get(venue);
            if (loop && loop.status === 'running') {
              markLoopError(loop, new Error(`stale-detected: ${Math.round(stalenessMs / 60000)} min without cycle`));
              store.recordEvent({
                venue,
                severity: 'error',
                type: 'loop-stale-auto-recovery',
                message: `${venue} 循环超过 60 分钟无响应，已自动标记为 error 状态`
              });
            }
          }
        }
      } finally {
        store.close();
      }
    } catch { /* watchdog errors must never crash the UI */ }
  };
  const handle = setInterval(() => { void tick(); }, WATCHDOG_INTERVAL_MS);
  handle.unref?.();
  return handle;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  configPath: string,
  uiToken: string,
  serverInfo: { host: string; port: number },
  liveLoops: LiveLoops
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
  setSecurityHeaders(res);
  if (req.method === 'GET' && url.pathname === '/') return sendText(res, 200, appHtml(), 'text/html; charset=utf-8');
  if (req.method === 'GET' && url.pathname === '/styles.css') return sendText(res, 200, appCss(), 'text/css; charset=utf-8');
  if (req.method === 'GET' && url.pathname === '/app.js') return sendText(res, 200, appScript(uiToken), 'application/javascript; charset=utf-8');
  if (req.method === 'GET' && url.pathname === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }
  if (url.pathname.startsWith('/api/') && req.method !== 'GET') {
    // Origin / Referer check first: a stolen uiToken alone (e.g. via XSS, a malicious same-machine process reading
    // /app.js) must not be enough to fire mutations. The same-origin guard restricts where the request can come
    // from, which is what the CSP can't enforce on the server side.
    if (!isOriginAllowed(req, serverInfo)) {
      throw new UiError(403, 'UI 同源校验失败。请从本机 UI 页面操作。');
    }
    const token = req.headers['x-safe-mm-ui-token'];
    if (token !== uiToken) throw new UiError(403, 'UI token 校验失败。请从本机 UI 页面操作。');
  }
  if (req.method === 'GET' && url.pathname === '/api/status') return sendJson(res, 200, await status(configPath, serverInfo, liveLoops));
  if (req.method === 'GET' && url.pathname === '/api/status/summary') return sendJson(res, 200, await statusSummary(configPath, serverInfo, liveLoops));
  if (req.method === 'GET' && url.pathname === '/api/predict/report') return sendJson(res, 200, await predictReport(configPath));
  if (req.method === 'GET' && url.pathname === '/api/live/status') return sendJson(res, 200, liveStatus(liveLoops));
  if (req.method === 'GET' && url.pathname === '/api/recommendations') return sendJson(res, 200, await recommendations(configPath, url));
  if (req.method === 'GET' && url.pathname === '/api/orderbook') return sendJson(res, 200, await orderbook(configPath, url));
  if (req.method === 'GET' && url.pathname === '/api/route-audit') return sendJson(res, 200, await routeAudit(configPath, url));

  // Inject stored passphrase into body when body doesn't include one
  const bodyWithPassphrase = async (): Promise<unknown> => {
    const body = await readJson(req);
    if (typeof body === 'object' && body) {
      const b = body as Record<string, unknown>;
      if (!b.passphrase || b.passphrase === '') {
        const venue = b.venue;
        if (typeof venue === 'string' && (venue === 'polymarket' || venue === 'predict')) {
          const stored = getPassphrase(venue);
          if (stored) {
            b.passphrase = stored;
            logger.info('BodyWithPassphrase: injected stored passphrase', { venue });
          }
        }
      }
    }
    return body;
  };

  if (req.method === 'POST' && url.pathname === '/api/balances') return sendJson(res, 200, await balances(configPath, await bodyWithPassphrase()));
  if (req.method === 'POST' && url.pathname === '/api/startup-facts') return sendJson(res, 200, await startupFacts(configPath, await bodyWithPassphrase()));
  if (req.method === 'POST' && url.pathname === '/api/polymarket/grant-approvals') return sendJson(res, 200, await grantPolymarketApprovals(configPath, await bodyWithPassphrase()));
  if (req.method === 'POST' && url.pathname === '/api/recommendations/apply') return sendJson(res, 200, await applyRecommendations(configPath, await readJson(req)));
  if (req.method === 'POST' && url.pathname === '/api/config/trading') return sendJson(res, 200, await updateTradingConfig(configPath, await readJson(req)));
  if (req.method === 'POST' && url.pathname === '/api/live/start') return sendJson(res, 200, await liveStart(configPath, await bodyWithPassphrase(), liveLoops));
  if (req.method === 'POST' && url.pathname === '/api/live/stop') return sendJson(res, 200, await liveStop(configPath, await readJson(req), liveLoops));
  if (req.method === 'POST' && url.pathname === '/api/live/stop-and-cancel') return sendJson(res, 200, await liveStopAndCancel(configPath, await bodyWithPassphrase(), liveLoops));
  if (req.method === 'POST' && url.pathname === '/api/manual-order') return sendJson(res, 200, await manualOrder(configPath, await readJson(req)));
  if (req.method === 'POST' && url.pathname === '/api/cancel-all') return sendJson(res, 200, await cancelAll(configPath, await bodyWithPassphrase()));

  // -- unlock: 前端输入密码后存入服务器内存，直到进程重启才清除 --
  if (req.method === 'POST' && url.pathname === '/api/unlock') {
    const body = await readJson(req) as Record<string, unknown>;
    const venue = typeof body.venue === 'string' ? body.venue : null;
    const passphrase = typeof body.passphrase === 'string' ? body.passphrase : '';
    if (!venue || (venue !== 'polymarket' && venue !== 'predict')) {
      return sendJson(res, 400, { ok: false, message: 'venue 必须是 polymarket 或 predict' });
    }
    if (!passphrase) {
      return sendJson(res, 400, { ok: false, message: '密码不能为空' });
    }
    // 验证密码是否正确：尝试用密码解密 keystore
    try {
      const { loadWalletSigner } = await import('../secrets/keystore.js');
      const { loadConfig } = await import('../config/load.js');
      const loaded = loadConfig(configPath);
      loadWalletSigner(loaded.dataDir, venue, passphrase);
      setPassphrase(venue, passphrase);
      return sendJson(res, 200, { ok: true, venue, unlocked: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return sendJson(res, 401, { ok: false, venue, unlocked: false, message: `密码错误: ${message}` });
    }
  }
  if (req.method === 'GET' && url.pathname === '/api/unlock/status') {
    const url2 = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const venue = url2.searchParams.get('venue');
    if (!venue || (venue !== 'polymarket' && venue !== 'predict')) {
      return sendJson(res, 400, { ok: false, message: 'venue 参数必填 (polymarket 或 predict)' });
    }
    return sendJson(res, 200, { ok: true, venue, unlocked: isUnlocked(venue) });
  }

  throw new UiError(404, 'Not found');
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 1024 * 1024) throw new UiError(413, '请求体过大。');
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new UiError(400, 'JSON 格式错误。');
  }
}

function sendText(res: ServerResponse, status: number, body: string, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store' });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function setSecurityHeaders(res: ServerResponse): void {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
}

function acquireUiSingleton(
  configPath: string,
  dataDir: string,
  host: string,
  port: number,
  enforce: boolean
): UiSingletonLock | undefined {
  if (!enforce) return undefined;
  const lockPath = path.join(dataDir, 'ui.lock.json');
  const existing = readUiLock(lockPath);
  if (existing && isLiveUiLock(existing)) {
    throw new Error(`safe-market-maker UI 已经在运行：${existing.url} (pid ${existing.pid})。请复用这个页面，或先停止旧的同项目 UI 进程。`);
  }
  const startedAt = new Date().toISOString();
  let active = true;
  let current: UiLockFile = {
    project: 'safe-market-maker',
    kind: 'ui',
    pid: process.pid,
    configPath,
    host,
    port,
    url: `http://${host}:${port}`,
    startedAt,
    updatedAt: startedAt
  };
  writeUiLock(lockPath, current);
  const heartbeat = setInterval(() => {
    if (!active) return;
    current = { ...current, updatedAt: new Date().toISOString() };
    writeUiLock(lockPath, current);
  }, Math.max(1000, Math.floor(UI_LOCK_STALE_MS / 4)));
  heartbeat.unref?.();
  const release = () => {
    if (!active) return;
    active = false;
    clearInterval(heartbeat);
    const latest = readUiLock(lockPath);
    if (latest?.pid === process.pid) {
      rmSync(lockPath, { force: true });
    }
  };
  process.once('exit', release);
  process.once('SIGINT', () => {
    release();
    process.exit(130);
  });
  process.once('SIGTERM', () => {
    release();
    process.exit(143);
  });
  return {
    update(serverInfo) {
      if (!active) return;
      current = {
        ...current,
        host: serverInfo.host,
        port: serverInfo.port,
        url: serverInfo.url,
        updatedAt: new Date().toISOString()
      };
      writeUiLock(lockPath, current);
    },
    release
  };
}

function readUiLock(lockPath: string): UiLockFile | undefined {
  if (!existsSync(lockPath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(lockPath, 'utf8')) as Partial<UiLockFile>;
    if (parsed.project !== 'safe-market-maker' || parsed.kind !== 'ui' || typeof parsed.pid !== 'number') return undefined;
    if (typeof parsed.configPath !== 'string' || typeof parsed.url !== 'string') return undefined;
    return {
      project: 'safe-market-maker',
      kind: 'ui',
      pid: parsed.pid,
      configPath: parsed.configPath,
      host: typeof parsed.host === 'string' ? parsed.host : '127.0.0.1',
      port: typeof parsed.port === 'number' ? parsed.port : 0,
      url: parsed.url,
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : new Date(0).toISOString(),
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date(0).toISOString()
    };
  } catch {
    return undefined;
  }
}

function writeUiLock(lockPath: string, lock: UiLockFile): void {
  writeFileSync(lockPath, JSON.stringify(lock, null, 2), 'utf8');
}

function isLiveUiLock(lock: UiLockFile): boolean {
  if (!pidIsRunning(lock.pid)) return false;
  const updatedAt = Date.parse(lock.updatedAt);
  if (!Number.isFinite(updatedAt)) return true;
  return Date.now() - updatedAt < UI_LOCK_STALE_MS;
}

function pidIsRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
