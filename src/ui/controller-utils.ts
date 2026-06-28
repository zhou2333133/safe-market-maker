import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../config/schema.js';
import type { Balance, Market, OrderIntent, OrderSide, VenueName } from '../domain/types.js';
import { dayStartTs } from '../risk/account-risk.js';
import { accountRiskWindowStart } from '../risk/risk-window.js';
import { loadWalletSigner, saveCredential } from '../secrets/keystore.js';
import { hasRuntimePrivateKey, loadRuntimeSigner } from '../secrets/runtime.js';
import type { SignerProvider } from '../secrets/signer.js';
import { marketRewardLevel as rewardLevelForMarket } from '../strategy/strategy-engine.js';
import type { VenueAdapter } from '../venues/types.js';
import { UiError } from './errors.js';
import type { StartupDataStatus } from '../execution/startup-facts.js';
import { createVenue } from '../venues/factory.js';
import { setRuntimeCredential } from '../secrets/runtime.js';
import type { StateStore } from '../store/sqlite.js';
import { AccountSyncService } from '../execution/account-sync.js';

export function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

export function requiredString(value: unknown, name: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new UiError(400, `${name} 不能为空。`);
  return text;
}

export function parseVenueParam(value: unknown): VenueName {
  if (value === 'predict' || value === 'polymarket') return value;
  throw new UiError(400, 'venue 必须是 predict 或 polymarket。');
}

export function parseSideParam(value: unknown): OrderSide {
  if (value === 'BUY' || value === 'SELL') return value;
  throw new UiError(400, 'side 必须是 BUY 或 SELL。');
}

export function parseTradingMode(value: unknown): AppConfig['strategy']['tradingMode'] {
  if (value === 'conservative' || value === 'aggressive') return value;
  throw new UiError(400, '报价模式必须是 conservative 或 aggressive。');
}

export function parseQuoteSide(value: unknown): AppConfig['strategy']['quoteSide'] {
  if (value === 'buy' || value === 'sell' || value === 'both') return value;
  throw new UiError(400, '挂单方向必须是 buy、sell 或 both。');
}

export function parseEntryMode(value: unknown, fallback: AppConfig['strategy']['entryMode']): AppConfig['strategy']['entryMode'] {
  if (value === undefined || value === null || value === '') return fallback;
  if (value === 'cash' || value === 'inventory' || value === 'split') return value;
  throw new UiError(400, '入场模式必须是 cash、inventory 或 split。');
}

export function parseOnFillAction(value: unknown, fallback: AppConfig['strategy']['onFillAction']): AppConfig['strategy']['onFillAction'] {
  if (value === undefined || value === null || value === '') return fallback;
  if (value === 'hold' || value === 'sellAllAtMarket') return value;
  throw new UiError(400, '退出动作必须是 hold 或 sellAllAtMarket。');
}

export function parseBoolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.toLowerCase();
    if (['true', '1', 'yes', 'y', 'on', '是', '开启'].includes(normalized)) return true;
    if (['false', '0', 'no', 'n', 'off', '否', '关闭'].includes(normalized)) return false;
  }
  throw new UiError(400, '布尔值格式错误。');
}

export function currentDepthLevel(config: AppConfig): number {
  return config.strategy.tradingMode === 'aggressive'
    ? config.strategy.aggressiveDepthLevel
    : config.strategy.conservativeDepthLevel;
}

export function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = value === undefined || value === null || value === '' ? fallback : Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) throw new UiError(400, `数字必须在 ${min} 到 ${max} 之间。`);
  return parsed;
}

export async function withRequestTimeout<T>(promise: Promise<T>, ms: number, errorFactory: () => Error): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(errorFactory()), ms);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function loadSignerForUi(dataDir: string, venue: VenueName, passphrase?: string): SignerProvider | undefined {
  if (passphrase) {
    try {
      return loadWalletSigner(dataDir, venue, passphrase);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new UiError(400, message);
    }
  }
  // 无密码 + 无 runtime-secrets → 静默返回 undefined，让调用方跳过需要签名者的操作。
  // 只在有运行时私钥（本机开发环境，有 SAFE_MM_PRIVATE_KEY 或 runtime-secrets）时才自动加载。
  if (!hasRuntimePrivateKey(venue, dataDir)) return undefined;
  try {
    return loadRuntimeSigner(venue, dataDir);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new UiError(400, message);
  }
}

export async function createVenueForUi(
  config: AppConfig,
  dataDir: string,
  venue: VenueName,
  signer: SignerProvider,
  passphrase = ''
): Promise<VenueAdapter> {
  const adapter = createVenue(config, dataDir, venue, passphrase);
  adapter.setRuntimeSigner?.(signer);
  if (!adapter.authenticate || !adapter.preflight) return adapter;
  const preflight = await adapter.preflight(signer);
  const missingCredential = venue === 'predict'
    ? !preflight.checks.some((check) => check.name === 'jwt' && check.ok)
    : !preflight.checks.some((check) => check.name === 'clob-credentials' && check.ok);
  if (!missingCredential) return adapter;
  const auth = await adapter.authenticate(signer);
  setRuntimeCredential(venue, auth.credential as never);
  // Persist to disk so the credential survives process restart
  if (passphrase) {
    try { saveCredential(dataDir, venue, auth.name, auth.credential, passphrase); }
    catch { /* best-effort; runtime (memory) credential takes precedence */ }
  }
  const refreshed = createVenue(config, dataDir, venue, passphrase);
  refreshed.setRuntimeSigner?.(signer);
  return refreshed;
}

export function balanceAddress(config: AppConfig, venue: VenueName, signerAddress: string): string {
  const configured = venue === 'predict' ? config.venues.predict.accountAddress : config.venues.polymarket.funderAddress;
  return /^0x[a-fA-F0-9]{40}$/.test(configured) && configured.toLowerCase() !== `0x${'0'.repeat(40)}` ? configured : signerAddress;
}

export function publicBalance(balance: Balance): Balance {
  return {
    asset: balance.asset,
    available: balance.available,
    total: balance.total
  };
}

export function manualIntent(venue: VenueName, market: Market, side: OrderSide, price: number, size: number): OrderIntent {
  const notionalUsd = Number((price * size).toFixed(4));
  return {
    venue,
    market,
    tokenId: market.tokenId,
    side,
    price: Number(price.toFixed(6)),
    size: Number(size.toFixed(4)),
    notionalUsd,
    postOnly: true,
    reason: 'manual-ui-live',
    clientOrderId: `${venue}-${market.tokenId}-${side}-manual-${Date.now()}-${randomUUID().slice(0, 8)}`
  };
}

export async function accountRiskDecision(
  venue: VenueName,
  config: AppConfig,
  adapter: VenueAdapter,
  signer: SignerProvider,
  address: string,
  store: StateStore
) {
  const sinceTs = accountRiskWindowStart(venue, store, dayStartTs());
  return new AccountSyncService(config, adapter, store).accountRiskGate({
    venue,
    signerAddress: address,
    signer,
    dayStart: sinceTs
  });
}

export type SettledRead<T> = { ok: true; value: T } | { ok: false; error: string };

export async function settleRead<T>(read: () => Promise<T>): Promise<SettledRead<T>> {
  try {
    return { ok: true, value: await read() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function settleReadWithTimeout<T>(read: () => Promise<T>, ms: number, label: string): Promise<SettledRead<T>> {
  return settleRead(() => withRequestTimeout(
    read(),
    ms,
    () => new UiError(504, `${label} 超过 ${Math.round(ms / 1000)} 秒未返回`)
  ));
}

export function valueOrEmpty<T>(result: SettledRead<T[]>): T[] {
  return result.ok ? result.value : [];
}

export function readStatus<T>(result: SettledRead<T>, okMessage: string): StartupDataStatus {
  return result.ok ? { ok: true, message: okMessage } : { ok: false, message: result.error };
}

export interface RecommendationFilters {
  pointsOnly: boolean;
  acceptingOnly: boolean;
  minLiquidityUsd: number;
  minRewardLevel: number;
}

export function recommendationFilters(source: URLSearchParams | Record<string, unknown>, config: AppConfig): RecommendationFilters {
  const get = (key: string): unknown => source instanceof URLSearchParams ? source.get(key) : source[key];
  return {
    pointsOnly: parseBoolean(get('pointsOnly'), config.strategy.pointsOnly),
    acceptingOnly: parseBoolean(get('acceptingOnly'), config.strategy.acceptingOnly),
    minLiquidityUsd: boundedNumber(get('minLiquidityUsd'), config.strategy.minMarketLiquidityUsd, 0, 100000000),
    minRewardLevel: Math.trunc(boundedNumber(get('minRewardLevel'), config.strategy.minRewardLevel, 0, 5))
  };
}

export function filterMarkets(markets: Market[], filters: RecommendationFilters): Market[] {
  return markets.filter((market) => {
    if (filters.pointsOnly && !market.rewards?.enabled) return false;
    if (filters.acceptingOnly && !market.acceptingOrders) return false;
    if (market.liquidityUsd < filters.minLiquidityUsd) return false;
    if (filters.minRewardLevel > 0 && marketRewardLevel(market) < filters.minRewardLevel) return false;
    return true;
  });
}

export function configWithRecommendationFilters(config: AppConfig, filters: RecommendationFilters): AppConfig {
  return {
    ...config,
    strategy: {
      ...config.strategy,
      pointsOnly: filters.pointsOnly,
      acceptingOnly: filters.acceptingOnly,
      minMarketLiquidityUsd: filters.minLiquidityUsd,
      minRewardLevel: filters.minRewardLevel
    }
  };
}

export function marketRewardLevel(market: Market): number {
  return rewardLevelForMarket(market);
}

export function decorateRecommendation<T extends { market: Market; reasons: string[]; riskFlags: string[] }>(
  recommendation: T
): T & { tradable: boolean; reasonsZh: string[]; riskFlagsZh: string[] } {
  const riskFlagsZh = recommendation.riskFlags.map(localizeFlag);
  return {
    ...recommendation,
    tradable: riskFlagsZh.length === 0,
    reasonsZh: recommendation.reasons.map(localizeFlag),
    riskFlagsZh
  };
}

export interface RejectStat {
  reasonCode: string;
  category: string;
  stage: string;
  count: number;
  latest: string;
}

export function rejectStats(events: Array<{ ts: string; details?: unknown }>): RejectStat[] {
  const stats = new Map<string, RejectStat>();
  for (const event of events) {
    const reject = rejectFromDetails(event.details);
    if (!reject) continue;
    const key = `${reject.reason_code}|${reject.category}|${reject.stage}`;
    const current = stats.get(key) ?? {
      reasonCode: reject.reason_code,
      category: reject.category,
      stage: reject.stage,
      count: 0,
      latest: event.ts
    };
    current.count += 1;
    if (Date.parse(event.ts) > Date.parse(current.latest)) current.latest = event.ts;
    stats.set(key, current);
  }
  return [...stats.values()].sort((a, b) => b.count - a.count || Date.parse(b.latest) - Date.parse(a.latest)).slice(0, 8);
}

function rejectFromDetails(details: unknown): { reason_code: string; category: string; stage: string } | undefined {
  if (!details || typeof details !== 'object') return undefined;
  const reject = (details as { reject?: unknown }).reject;
  if (!reject || typeof reject !== 'object') return undefined;
  const candidate = reject as { reason_code?: unknown; category?: unknown; stage?: unknown };
  if (typeof candidate.reason_code !== 'string' || typeof candidate.category !== 'string' || typeof candidate.stage !== 'string') return undefined;
  return {
    reason_code: candidate.reason_code,
    category: candidate.category,
    stage: candidate.stage
  };
}

export function localizeFlag(value: string): string {
  const lower = value.toLowerCase();
  if (lower.includes('no reward')) return '无积分/奖励规则';
  if (lower.includes('reward') || lower.includes('points')) return '有积分/奖励规则';
  if (lower.includes('liquidity')) return value.replace(/^liquidity/i, '流动性').replace('low liquidity', '流动性不足');
  if (lower.includes('volume')) return value.replace(/^volume/i, '24h 成交量');
  if (lower.includes('accepting')) return '暂不接受订单';
  if (lower.includes('min shares')) return value.replace(/^min shares/i, '最低份额');
  if (lower.includes('max spread')) return value.replace(/^max spread/i, '最大价差');
  return value;
}
