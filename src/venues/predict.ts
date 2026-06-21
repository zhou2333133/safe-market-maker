import { Contract, JsonRpcProvider, ZeroHash, concat, formatUnits, parseUnits, toBeHex } from 'ethers';
import type { AppConfig } from '../config/schema.js';
import type { AccountRiskSnapshot, Balance, Market, MergePositionsResult, NativeGasBalance, OpenOrder, OrderIntent, OrderResult, Orderbook, Position, PreflightResult, SplitPositionsResult } from '../domain/types.js';
import type { SignerProvider } from '../secrets/signer.js';
import { LocalWalletSigner } from '../secrets/signer.js';
import { nativeGasLowMessage } from '../observability/error-message.js';
import { isPredictFillActivity, normalizePredictFill, normalizePredictOpenOrder, normalizePredictPosition } from './account-normalize.js';
import { extractList, httpJson, unwrapData } from './http.js';
import { buildOrderbookForToken, normalizePredictMarket } from './normalize.js';
import { PredictWsClient } from './predict-ws.js';
import type { AuthResult, ApprovalGrantRequest, MergePositionsRequest, SplitMergeGasEstimateRequest, SplitPositionsRequest, VenueAdapter } from './types.js';
import { accountEquityUsd } from '../risk/account-risk.js';

/** Market-list cache: avoids re-fetching 648 markets every full cycle. TTL mirrors config strategy.marketRefreshMs. */
interface CachedMarketList {
  merged: any[];
  fetchedAt: number;
}
let predictMarketListCache: CachedMarketList | undefined;
const PREDICT_MARKET_LIST_CACHE_MS = 60_000;

/** Clear the module-level market-list cache (used by tests that mock HTTP responses). */
export function clearPredictMarketListCache(): void {
  predictMarketListCache = undefined;
}

const ERC20_ABI = [
  'function allowance(address owner,address spender) view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
  'function approve(address spender,uint256 amount) returns (bool)'
];

const BALANCE_RPC_TIMEOUT_MS = 2500;
const PREDICT_CONNECTION_TIMEOUT_MS = 3000;
const PREDICT_PREFLIGHT_TIMEOUT_MS = 3500;
const PREDICT_MARKETS_TIMEOUT_MS = 5000;
const PREDICT_MARKET_STATS_TIMEOUT_MS = 1500;
const PREDICT_MARKET_STATS_MIN_FETCHES = 8;
const PREDICT_MARKET_STATS_MAX_FETCHES = 24;
const PREDICT_ORDERBOOK_WS_WAIT_MS = 1500;
const PREDICT_ORDERBOOK_REST_FALLBACK_MS = 1800;
const PREDICT_ORDERBOOK_MAX_AGE_MS = 1500;
// Watch-all cache read tolerance: WS pushes deliver every change, so a quiet market's last book stays valid
// well beyond the blocking-path freshness window. Generous max-age avoids needless REST warm-ups; a dead
// socket is handled separately by auto-reconnect + re-subscribe (which re-snapshots).
const PREDICT_WS_WATCH_CACHE_MAX_AGE_MS = 60_000;
const PREDICT_FALLBACK_SPLIT_MERGE_GAS_PRICE_GWEI = 3;
// BSC balance/approval RPC fallbacks, tried in order after config.rpcUrl. All verified free + no-API-key.
// publicnode + 1rpc are different providers from Binance, so a Binance-wide stall still has live fallbacks.
const PREDICT_BALANCE_RPC_FALLBACKS: Record<number, string[]> = {
  56: [
    'https://bsc-dataseed.bnbchain.org/',
    'https://bsc-dataseed.binance.org/',
    'https://bsc-rpc.publicnode.com/',
    'https://1rpc.io/bnb'
  ],
  97: ['https://bsc-testnet-dataseed.bnbchain.org/']
};

/** 在令牌真正到期前这么多毫秒就视为需要刷新，留足一轮循环的余量，避免请求途中过期。 */
const PREDICT_JWT_REFRESH_MARGIN_MS = 120_000;

/** 解析 JWT 的 exp（毫秒）。不是标准 JWT 或读不到 exp 时返回 undefined。 */
export function predictJwtExpiryMs(jwt: string): number | undefined {
  const parts = jwt.split('.');
  if (parts.length < 2) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as { exp?: unknown };
    if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) return undefined;
    return payload.exp * 1000;
  } catch {
    return undefined;
  }
}

/**
 * 令牌是否仍可安全使用。
 * 能解析出 exp 时，只有在到期前 margin 内才判定不可用（触发重新登录）；
 * 无法解析（非标准 JWT / 不透明令牌）时保持原有“存在即可用”行为，避免误伤。
 */
export function predictJwtUsable(jwt: string, now: number = Date.now()): boolean {
  const exp = predictJwtExpiryMs(jwt);
  if (exp === undefined) return true;
  return exp - PREDICT_JWT_REFRESH_MARGIN_MS > now;
}

export class PredictVenue implements VenueAdapter {
  readonly name = 'predict' as const;
  private static readonly wsClients = new Map<string, PredictWsClient>();
  private readonly tokenToMarketId = new Map<string, string>();
  private readonly outcomeIndexByToken = new Map<string, number>();
  private readonly tickSizeByToken = new Map<string, number>();
  /** 记录 REST 订单簿确认不存在的 tokenId，在同一实例生命周期内跳过重试 */
  private readonly closedMarketTokens = new Set<string>();
  private jwt?: string;

  constructor(
    private readonly config: AppConfig,
    credential?: { jwt?: string }
  ) {
    this.jwt = credential?.jwt;
  }

  static closeSharedWsClients(): void {
    for (const client of PredictVenue.wsClients.values()) client.close();
    PredictVenue.wsClients.clear();
  }

  /** Expose the shared WS client for read-only cache inspection (reporting, not trading). */
  static getSharedWsClient(wsUrl: string, apiKey?: string): PredictWsClient | undefined {
    const key = `${wsUrl}|${apiKey ? 'api-key' : 'no-api-key'}`;
    return PredictVenue.wsClients.get(key);
  }

  /**
   * 用已缓存的市场列表预热 tokenToMarketId 映射。
   * ExecutionEngine 模块级 marketCache 命中时调用，避免 adapter 实例重建
   * 后映射表为空导致 WS 订单簿路由失效（fallback 到 REST 并触发 HTTP 400）。
   */
  hydrateFromMarkets(markets: Market[]): void {
    this.tokenToMarketId.clear();
    this.outcomeIndexByToken.clear();
    this.tickSizeByToken.clear();
    this.closedMarketTokens.clear();
    for (const market of markets) {
      if (market.tokenId && market.marketId) {
        this.tokenToMarketId.set(market.tokenId, market.marketId);
        this.tickSizeByToken.set(market.tokenId, market.tickSize);
        const outcomeIndex = binaryOutcomeIndex(market);
        if (outcomeIndex !== undefined) {
          this.outcomeIndexByToken.set(market.tokenId, outcomeIndex);
        }
      }
    }
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.tryPaths<any>('GET', ['/v1/markets', '/markets'], { status: 'OPEN', first: '1' }, false, undefined, PREDICT_CONNECTION_TIMEOUT_MS);
      return true;
    } catch {
      return false;
    }
  }

  async getMarkets(): Promise<Market[]> {
    const merged = await this.mergeRawMarkets();
    const statsFetchIds = planPredictMarketStatsFetchIds(merged, this.config);
    const rawMarkets = await Promise.all(merged.map((raw: any) => this.withStatsIfPlanned(raw, statsFetchIds)));
    const markets = rawMarkets.flatMap((raw) => normalizePredictMarket(raw)).filter((m) => m.tokenId);
    this.tokenToMarketId.clear();
    this.outcomeIndexByToken.clear();
    this.tickSizeByToken.clear();
    this.closedMarketTokens.clear();
    for (const market of markets) {
      if (market.marketId) this.tokenToMarketId.set(market.tokenId, market.marketId);
      this.tickSizeByToken.set(market.tokenId, market.tickSize);
      const outcomeIndex = binaryOutcomeIndex(market);
      if (outcomeIndex !== undefined) {
        this.outcomeIndexByToken.set(market.tokenId, outcomeIndex);
      }
    }
    return markets;
  }

  private async mergeRawMarkets(): Promise<any[]> {
    if (predictMarketListCache && (Date.now() - predictMarketListCache.fetchedAt) < PREDICT_MARKET_LIST_CACHE_MS) {
      return predictMarketListCache.merged;
    }
    const [direct, categories] = await Promise.allSettled([
      this.fetchDirectMarkets(),
      this.fetchCategoryMarkets()
    ]);
    const combined = [
      ...(categories.status === 'fulfilled' ? categories.value : []),
      ...(direct.status === 'fulfilled' ? direct.value : [])
    ].map((raw, index) => ({ ...raw, __safeMmMergeIndex: index }));
    const byId = new Map<string, any>();
    for (const raw of combined) {
      const key = String(raw?.id ?? raw?.market_id ?? raw?.marketId ?? raw?.conditionId ?? raw?.condition_id ?? '');
      if (!key) continue;
      const previous = byId.get(key);
      byId.set(key, previous ? {
        ...previous,
        ...raw,
        __safeMmMergeIndex: Math.min(Number(previous.__safeMmMergeIndex ?? raw.__safeMmMergeIndex ?? 0), Number(raw.__safeMmMergeIndex ?? 0)),
        stats: previous.stats ?? raw?.stats
      } : raw);
    }
    const merged = [...byId.values()];
    predictMarketListCache = { merged, fetchedAt: Date.now() };
    return merged;
  }

  private async fetchDirectMarkets(): Promise<any[]> {
    const payload = await this.tryPaths<any>('GET', ['/v1/markets', '/markets'], { status: 'OPEN', first: '120' }, false, undefined, PREDICT_MARKETS_TIMEOUT_MS);
    return extractList(payload);
  }

  private async fetchCategoryMarkets(): Promise<any[]> {
    const sorts = ['VOLUME_24H_DESC', 'PUBLISHED_AT_DESC', 'VOLUME_ALL_DESC'];
    const results = await Promise.allSettled(sorts.map((sort) => (
      this.tryPaths<any>('GET', ['/v1/categories', '/categories'], { status: 'OPEN', first: '24', sort }, false, undefined, PREDICT_MARKETS_TIMEOUT_MS)
    )));
    return results.flatMap((result) => {
      if (result.status !== 'fulfilled') return [];
      return extractList(result.value).flatMap((category) => {
        const markets = Array.isArray(category?.markets) ? category.markets : [];
        return markets.map((market: any) => ({
          categoryStartsAt: category?.startsAt,
          categoryEndsAt: category?.endsAt,
          categoryStatus: category?.status,
          ...market,
          categoryTitle: category?.title,
          categorySlug: category?.slug,
          categoryStats: category?.stats
        }));
      });
    });
  }

  private async withStatsIfPlanned(raw: any, statsFetchIds: Set<string>): Promise<any> {
    const id = rawMarketId(raw);
    if (!id || raw?.stats || !statsFetchIds.has(id)) return raw;
    try {
      const payload = await this.tryPaths<any>('GET', [`/v1/markets/${encodeURIComponent(String(id))}/stats`], undefined, false, undefined, PREDICT_MARKET_STATS_TIMEOUT_MS);
      return { ...raw, stats: unwrapData(payload) };
    } catch {
      return raw;
    }
  }

  async getOrderbook(tokenId: string) {
    const marketId = this.tokenToMarketId.get(tokenId) ?? tokenId;

    // 若该市场在本实例周期内已确认 4xx（市场已关闭/不存在），直接跳过避免重复请求
    if (this.closedMarketTokens.has(tokenId)) {
      throw new Error(`Predict orderbook skipped for ${marketId}: market previously returned HTTP 4xx (likely closed)`);
    }

    let wsError: unknown;
    if (this.tokenToMarketId.has(tokenId)) {
      try {
        return await this.wsClient().getOrderbook(
          marketId,
          tokenId,
          PREDICT_ORDERBOOK_MAX_AGE_MS,
          PREDICT_ORDERBOOK_WS_WAIT_MS,
          {
            complement: this.shouldComplementBinaryBook(tokenId),
            complementTickSize: this.tickSizeByToken.get(tokenId)
          }
        );
      } catch (error) {
        wsError = error;
      }
    }
    try {
      return await this.getOrderbookViaRest(tokenId, marketId);
    } catch (restError: any) {
      // 只有 404/410 才按不存在处理。Predict token 订单簿路径可能返回 400，
      // 但同一个 marketId 路径仍可用，不能把 400 缓存成永久关闭。
      if ([404, 410].includes(Number(restError?.status))) {
        this.closedMarketTokens.add(tokenId);
      }
      const wsMessage = wsError instanceof Error ? wsError.message : String(wsError ?? 'not attempted');
      const restMessage = restError instanceof Error ? restError.message : String(restError);
      throw new Error(`Predict orderbook unavailable for ${marketId}: WS=${wsMessage}; REST=${restMessage}`);
    }
  }

  /** Batch-subscribe a watch set to the persistent WS so their books arrive via push (no per-market REST). */
  watchMarkets(markets: Market[]): void {
    const marketIds = [...new Set(markets
      .filter((market) => market.venue === 'predict' && market.marketId)
      .map((market) => market.marketId as string))];
    if (marketIds.length === 0) return;
    void this.wsClient().reconcileMarkets(marketIds).catch(() => undefined);
  }

  /** REST-only orderbook fetch (skips the blocking WS wait) for watch-all cache misses, keeping cycles fast. */
  async getOrderbookRest(tokenId: string): Promise<Orderbook> {
    const marketId = this.tokenToMarketId.get(tokenId) ?? tokenId;
    return this.getOrderbookViaRest(tokenId, marketId);
  }

  /** Cache-only orderbook read for the watch-all path. Undefined => not fresh => caller may REST warm-up. */
  getCachedOrderbook(tokenId: string): Orderbook | undefined {
    if (!this.tokenToMarketId.has(tokenId)) return undefined;
    const marketId = this.tokenToMarketId.get(tokenId) ?? tokenId;
    if (this.closedMarketTokens.has(tokenId)) return undefined;
    return this.wsClient().getCachedOrderbook(marketId, tokenId, PREDICT_WS_WATCH_CACHE_MAX_AGE_MS, {
      complement: this.shouldComplementBinaryBook(tokenId),
      complementTickSize: this.tickSizeByToken.get(tokenId)
    });
  }

  wsWatchStats(): { connected: boolean; watchedMarkets: number; cachedOrderbooks: number } {
    const stats = this.wsClient().stats();
    return { connected: stats.connected, watchedMarkets: stats.watchedMarkets, cachedOrderbooks: stats.cachedOrderbooks };
  }

  async getBalances(address: string, _signer?: SignerProvider): Promise<Balance[]> {
    return this.getOnchainUsdtBalance(this.tradingAddress(address));
  }

  async getPositions(address: string): Promise<Position[]> {
    const ownerAddress = this.tradingAddress(address);
    const payload = this.jwt
      ? await this.tryPaths<any>('GET', ['/v1/positions', '/positions'], { first: '100' }, true)
      : await this.tryPaths<any>('GET', [
        `/v1/positions/${encodeURIComponent(ownerAddress)}`,
        `/positions/${encodeURIComponent(ownerAddress)}`
      ], { first: '100' });
    return extractList(payload)
      .map((item) => normalizePredictPosition(item))
      .filter((position): position is Position => position !== undefined);
  }

  async getOpenOrders(_address: string, timeoutMs?: number): Promise<OpenOrder[]> {
    if (!this.jwt) return [];
    const payload = await this.tryPaths<any>('GET', ['/v1/orders', '/orders'], { first: '100', status: 'OPEN' }, true, undefined, timeoutMs);
    return extractList(payload)
      .map((raw) => normalizePredictOpenOrder(raw))
      .filter((order): order is OpenOrder => order !== undefined);
  }

  async getAccountRiskSnapshot(address: string, signer: SignerProvider, sinceTs: number): Promise<AccountRiskSnapshot> {
    if (!this.jwt) throw new Error('Predict JWT is required for account risk snapshot. Run mm auth predict first.');
    const ownerAddress = this.tradingAddress(address || signer.address);
    const [activityPayload, positions, balanceResult] = await Promise.all([
      this.tryPaths<any>('GET', ['/v1/account/activity', '/account/activity'], {
        first: '100',
        startDate: new Date(sinceTs).toISOString()
      }, true),
      this.getPositions(ownerAddress),
      this.getBalances(ownerAddress, signer)
        .then((balances) => ({ ok: true as const, balances }))
        .catch((error) => ({ ok: false as const, error: error instanceof Error ? error.message : String(error) }))
    ]);
    const balances = balanceResult.ok ? balanceResult.balances : [];
    const fills = extractList(activityPayload)
      .filter((item) => isPredictFillActivity(item))
      .map((item, index) => normalizePredictFill(item, index))
      .filter((fill) => fill.ts >= sinceTs);
    const netCashflowUsd = sumDefined(fills.map((fill) => fill.cashflowUsd));
    const feesUsd = sumDefined(fills.map((fill) => fill.feeUsd));
    const positionValueUsd = positions.reduce((sum, position) => sum + finiteOrZero(position.notionalUsd), 0);
    const hasOpenPositions = positions.some((position) => Math.abs(position.size) > 1e-9 || Math.abs(position.notionalUsd) > 0.01);
    const venueRealizedPnlUsd = sumDefined(fills.map((fill) => fill.realizedPnlUsd));
    const realizedPnlUsd = venueRealizedPnlUsd
      ?? (!hasOpenPositions && fills.length > 0 ? netCashflowUsd : undefined);
    const unrealizedPnlUsd = predictUnrealizedPnl(positions);
    const equityUsd = balanceResult.ok ? accountEquityUsd(balances, positionValueUsd) : undefined;
    const warnings: string[] = [];
    if (fills.length === 0) warnings.push('Predict account activity returned no same-day fill records.');
    if (venueRealizedPnlUsd === undefined && realizedPnlUsd !== undefined) {
      warnings.push('Predict realized PnL inferred from net fill cashflow because the account has no open positions.');
    }
    if (!balanceResult.ok) warnings.push(`Predict USDT balance unavailable during account snapshot: ${balanceResult.error}`);
    if (realizedPnlUsd === undefined && netCashflowUsd === undefined && equityUsd === undefined) {
      warnings.push('Predict account activity did not expose PnL/cashflow/equity fields.');
    }
    return {
      venue: this.name,
      account: ownerAddress,
      source: balanceResult.ok ? 'venue+chain' : 'venue',
      capturedAt: Date.now(),
      dayStart: sinceTs,
      ...(equityUsd !== undefined ? { equityUsd } : {}),
      ...(realizedPnlUsd !== undefined ? { realizedPnlUsd } : {}),
      ...(unrealizedPnlUsd !== undefined ? { unrealizedPnlUsd } : !hasOpenPositions ? { unrealizedPnlUsd: 0 } : {}),
      ...(netCashflowUsd !== undefined ? { netCashflowUsd } : {}),
      ...(feesUsd !== undefined ? { feesUsd } : {}),
      fills,
      positions,
      balances,
      warnings,
      raw: {
        activityCount: extractList(activityPayload).length,
        ...(!balanceResult.ok ? { balanceUnavailable: true } : {})
      }
    };
  }

  async preflight(signer: SignerProvider, _tokenIds: string[] = []): Promise<PreflightResult> {
    const makerAddress = this.validAccountAddress() ?? signer.address;
    const jwtUsable = this.jwt ? predictJwtUsable(this.jwt) : false;
    const checks: PreflightResult['checks'] = [
      { name: 'api-key', ok: Boolean(this.config.venues.predict.apiKey), message: this.config.venues.predict.apiKey ? 'configured' : 'missing' },
      { name: 'jwt', ok: jwtUsable, message: !this.jwt ? 'missing; run mm auth predict' : jwtUsable ? 'loaded from encrypted credential' : 'expired or near expiry; re-deriving via apiKey' },
      { name: 'signer-address', ok: /^0x[a-fA-F0-9]{40}$/.test(signer.address), message: signer.address },
      { name: 'maker-address', ok: /^0x[a-fA-F0-9]{40}$/.test(makerAddress), message: makerAddress }
    ];
    if (this.jwt) {
      checks.push({ name: 'open-order-sync', ok: true, message: `deferred to first live cycle; timeout guard ${PREDICT_PREFLIGHT_TIMEOUT_MS}ms` });
    }
    return {
      ok: checks.every((check) => check.ok),
      venue: this.name,
      signerAddress: signer.address,
      makerAddress,
      checks
    };
  }

  async authenticate(signer: SignerProvider): Promise<AuthResult> {
    if (!this.config.venues.predict.apiKey) throw new Error('Predict apiKey is required for auth.');
    const messagePayload = await this.tryPaths<any>('GET', ['/v1/auth/message', '/auth/message']);
    const messageData = unwrapData(messagePayload);
    const message = typeof messageData === 'string' ? messageData : String(messageData?.message ?? '');
    if (!message) throw new Error('Predict auth message was empty.');
    const signature = await this.signPredictAuthMessage(signer, message);
    const signerAddress = this.validAccountAddress() ?? signer.address;
    const authPayload = await this.tryPaths<any>('POST', ['/v1/auth', '/auth'], undefined, false, {
      signer: signerAddress,
      signature,
      message
    });
    const data = unwrapData(authPayload);
    const jwt = String(data?.token ?? data?.jwt ?? data?.accessToken ?? '');
    if (!jwt) throw new Error('Predict auth succeeded but no JWT was returned.');
    this.jwt = jwt;
    return {
      venue: this.name,
      name: 'jwt',
      credential: { jwt },
      summary: `Predict JWT acquired for ${signerAddress}`
    };
  }

  async inspectApprovals(signer: SignerProvider, tokenId?: string): Promise<PreflightResult> {
    const checks: PreflightResult['checks'] = [];
    const signerAddress = signer.address;
    checks.push({ name: 'signer', ok: /^0x[a-fA-F0-9]{40}$/.test(signerAddress), message: signerAddress });
    try {
      const collateral = tokenId && signer instanceof LocalWalletSigner
        ? this.predictCollateralAddresses(await this.predictSdk(), signer)
        : undefined;
      const snapshot = await this.readApprovalSnapshotWithRpcFailover(signerAddress, collateral);
      const hasAllowance = snapshot.allowances?.some((allowance) => allowance > 0n) ?? false;
      const needsOnchainApproval = Boolean(collateral) && !hasAllowance;
      checks.push({
        name: 'native-gas',
        ok: snapshot.native > 0n || !needsOnchainApproval,
        message: snapshot.native > 0n
          ? `${formatUnits(snapshot.native, 18)} BNB`
          : needsOnchainApproval
            ? '0.0 BNB; missing allowance requires a funded signer to send approval transactions'
            : '0.0 BNB; accepted because existing approval is enough for signed REST order placement'
      });
      if (collateral && snapshot.balance !== undefined && snapshot.allowances) {
        checks.push({ name: 'usdt-balance', ok: snapshot.balance > 0n, message: `${formatUnits(snapshot.balance, 18)} USDT` });
        checks.push({
          name: 'usdt-allowance',
          ok: hasAllowance,
          message: snapshot.allowances.map((allowance, index) => `${formatUnits(allowance, 18)} USDT to ${collateral.spenderAddresses[index]}`).join('; ')
        });
      }
    } catch (error) {
      checks.push({ name: 'approval-inspection', ok: false, message: error instanceof Error ? error.message : String(error) });
    }
    return { ok: checks.every((check) => check.ok), venue: this.name, signerAddress, makerAddress: this.validAccountAddress() ?? signerAddress, checks };
  }

  async getNativeGasBalance(signer: SignerProvider, required?: number): Promise<NativeGasBalance> {
    if (required === undefined) return this.estimateSplitMergeGas(signer);
    const native = await this.readNativeBalanceWithRpcFailover(signer.address);
    const balance = Number(formatUnits(native, 18));
    const ok = Number.isFinite(balance) && balance + 1e-12 >= required;
    const addressNote = `BNB 手续费必须充值到签名钱包 ${signer.address}`;
    return {
      asset: 'BNB',
      balance: Number.isFinite(balance) ? balance : 0,
      address: signer.address,
      label: '签名钱包 / split-merge 手续费地址',
      required,
      requiredSource: 'configured',
      ok,
      message: ok
        ? `${formatBnb(balance)} BNB 可用于 split/merge 链上手续费；${addressNote}`
        : `${nativeGasLowMessage(formatBnb(required), formatBnb(Number.isFinite(balance) ? balance : 0))}${addressNote}。`
    };
  }

  async estimateSplitMergeGas(signer: SignerProvider, request: SplitMergeGasEstimateRequest = {}): Promise<NativeGasBalance> {
    const native = await this.readNativeBalanceWithRpcFailover(signer.address);
    const balance = Number(formatUnits(native, 18));
    const estimate = signer instanceof LocalWalletSigner
      ? await this.estimateSplitMergeGasCost(signer, request)
      : await this.fallbackSplitMergeGasCost('local wallet signer unavailable for dynamic estimate');
    const ok = Number.isFinite(balance) && balance + 1e-12 >= estimate.requiredBnb;
    const addressNote = `BNB 手续费必须充值到签名钱包 ${signer.address}`;
    const estimateNote = estimate.status === 'estimated'
      ? `按当前 RPC gas price 动态估算 ${formatBnb(estimate.requiredBnb)} BNB`
      : `无法精确估算，使用保守兜底 ${formatBnb(estimate.requiredBnb)} BNB`;
    return {
      asset: 'BNB',
      balance: Number.isFinite(balance) ? balance : 0,
      address: signer.address,
      label: '签名钱包 / split-merge 手续费地址',
      required: estimate.requiredBnb,
      requiredSource: estimate.status === 'estimated' ? 'dynamic-estimate' : 'fallback-estimate',
      estimatedGasUnits: estimate.gasUnits,
      gasPriceGwei: estimate.gasPriceGwei,
      bufferMultiplier: estimate.bufferMultiplier,
      estimateStatus: estimate.status,
      estimateMessage: estimate.message,
      ok,
      message: ok
        ? `${estimateNote}，当前 ${formatBnb(balance)} BNB 足够；${addressNote}`
        : `${nativeGasLowMessage(formatBnb(estimate.requiredBnb), formatBnb(Number.isFinite(balance) ? balance : 0))}${estimateNote}；${addressNote}。`
    };
  }

  async grantApprovals(signer: SignerProvider, request: ApprovalGrantRequest): Promise<PreflightResult> {
    if (!request.confirm) throw new Error('Approval grant requires explicit confirmation.');
    if (!request.tokenId) throw new Error('Predict approval grant requires --token-id so the correct spender can be derived.');
    if (!(signer instanceof LocalWalletSigner)) throw new Error('Predict approval grant requires the local wallet signer boundary.');
    const provider = new JsonRpcProvider(this.config.venues.predict.rpcUrl);
    const wallet = signer.unsafeEthersWalletForSdk().connect(provider);
    const sdk = await this.predictSdk();
    const market = (await this.getMarkets()).find((item) => item.tokenId === request.tokenId);
    const { tokenAddress, spenderAddresses, ownerAddress } = this.predictCollateralAddresses(sdk, signer, market);
    const spenderAddress = spenderAddresses[0];
    if (!spenderAddress) throw new Error('Predict approval spender address is unavailable for this chain.');
    const amount = parseUnits(String(request.amountUsd), 18);
    const token = new Contract(tokenAddress, ERC20_ABI, wallet);
    const tx = await (token as any).approve(spenderAddress, amount);
    const receipt = await tx.wait();
    return {
      ok: true,
      venue: this.name,
      signerAddress: signer.address,
      makerAddress: ownerAddress,
      checks: [{ name: 'approval-grant', ok: true, message: `Approved ${request.amountUsd} USDT in tx ${receipt?.hash ?? tx.hash}` }]
    };
  }

  async splitPositions(request: SplitPositionsRequest, signer: SignerProvider): Promise<SplitPositionsResult> {
    if (!(signer instanceof LocalWalletSigner)) throw new Error('Predict split positions requires local wallet signer.');
    if (!request.conditionId) throw new Error('Predict split positions requires conditionId.');
    if (!Number.isFinite(request.amountUsd) || request.amountUsd <= 0) throw new Error(`Predict split amount must be positive: ${request.amountUsd}`);
    const sdk = await this.predictSdk();
    const provider = new JsonRpcProvider(this.config.venues.predict.rpcUrl);
    const wallet = signer.unsafeEthersWalletForSdk().connect(provider);
    const chainId = this.config.venues.predict.chainId || sdk.ChainId.BnbMainnet;
    const account = this.validAccountAddress();
    const orderBuilder = await sdk.OrderBuilder.make(chainId, wallet, account ? { predictAccount: account } : {});
    await this.assertNativeGasForSplitMerge(signer, 'split', request, orderBuilder);
    const result = await orderBuilder.splitPositions({
      conditionId: request.conditionId,
      amount: predictOrderWei(request.amountUsd, 6),
      isNegRisk: request.market.negRisk,
      isYieldBearing: Boolean(request.market.yieldBearing)
    });
    if (!result?.success) {
      const cause = result?.cause instanceof Error ? result.cause.message : String(result?.cause ?? 'unknown split failure');
      throw new Error(`Predict split positions failed: ${cause}`);
    }
    return {
      venue: this.name,
      conditionId: request.conditionId,
      amountUsd: request.amountUsd,
      txHash: splitMergeTxHash(result.receipt),
      raw: splitMergeReceiptSummary(result.receipt)
    };
  }

  async mergePositions(request: MergePositionsRequest, signer: SignerProvider): Promise<MergePositionsResult> {
    if (!(signer instanceof LocalWalletSigner)) throw new Error('Predict merge positions requires local wallet signer.');
    if (!request.conditionId) throw new Error('Predict merge positions requires conditionId.');
    if (!Number.isFinite(request.amountUsd) || request.amountUsd <= 0) throw new Error(`Predict merge amount must be positive: ${request.amountUsd}`);
    const sdk = await this.predictSdk();
    const provider = new JsonRpcProvider(this.config.venues.predict.rpcUrl);
    const wallet = signer.unsafeEthersWalletForSdk().connect(provider);
    const chainId = this.config.venues.predict.chainId || sdk.ChainId.BnbMainnet;
    const account = this.validAccountAddress();
    const orderBuilder = await sdk.OrderBuilder.make(chainId, wallet, account ? { predictAccount: account } : {});
    await this.assertNativeGasForSplitMerge(signer, 'merge', request, orderBuilder);
    const result = await orderBuilder.mergePositions({
      conditionId: request.conditionId,
      amount: predictOrderWei(request.amountUsd, 6),
      isNegRisk: request.market.negRisk,
      isYieldBearing: Boolean(request.market.yieldBearing)
    });
    if (!result?.success) {
      const cause = result?.cause instanceof Error ? result.cause.message : String(result?.cause ?? 'unknown merge failure');
      throw new Error(`Predict merge positions failed: ${cause}`);
    }
    return {
      venue: this.name,
      conditionId: request.conditionId,
      amountUsd: request.amountUsd,
      txHash: splitMergeTxHash(result.receipt),
      raw: splitMergeReceiptSummary(result.receipt)
    };
  }

  async createOrder(intent: OrderIntent, signer: SignerProvider): Promise<OrderResult> {
    if (!this.jwt) throw new Error('Predict JWT is required. Run mm auth predict first.');
    if (!(signer instanceof LocalWalletSigner)) throw new Error('Predict live order creation requires local wallet signer.');
    void this.wsClient().subscribeWalletEvents(this.jwt).catch(() => undefined);
    const sdk = await this.predictSdk();
    const { OrderBuilder, ChainId, Side } = sdk;
    const provider = new JsonRpcProvider(this.config.venues.predict.rpcUrl);
    const wallet = signer.unsafeEthersWalletForSdk().connect(provider);
    const chainId = this.config.venues.predict.chainId || ChainId.BnbMainnet;
    const account = this.validAccountAddress();
    const orderBuilder = await OrderBuilder.make(chainId, wallet, account ? { predictAccount: account } : {});
    const sharesWei = predictOrderWei(intent.size, 5);
    const priceWei = predictOrderWei(intent.price, 6);
    const amounts = orderBuilder.getLimitOrderAmounts({
      side: intent.side === 'BUY' ? Side.BUY : Side.SELL,
      quantityWei: sharesWei,
      pricePerShareWei: priceWei
    });
    const maker = account ?? signer.address;
    // Network dead-man switch (ported from Polymarket): when polymarketOrderTtlSec > 0, attach an expiry so the venue
    // auto-cancels the resting order if the bot/network dies. cancel-service refreshes it before expiry while alive, so
    // a healthy bot's orders never lapse; only a sustained outage (> ttl) lets them expire. polymarketOrderTtlSec is a
    // generic per-venue knob despite the prefix (resolved from the base strategy for Predict).
    const ttlSec = Math.trunc(this.config.strategy.polymarketOrderTtlSec ?? 0);
    const order = orderBuilder.buildOrder('LIMIT', {
      maker,
      signer: maker,
      side: intent.side === 'BUY' ? Side.BUY : Side.SELL,
      tokenId: intent.tokenId,
      makerAmount: amounts.makerAmount,
      takerAmount: amounts.takerAmount,
      feeRateBps: intent.market.feeRateBps,
      ...(ttlSec > 0 ? { expiresAt: new Date((Math.floor(Date.now() / 1000) + Math.max(60, ttlSec)) * 1000) } : {})
    });
    const typedData = orderBuilder.buildTypedData(order, {
      isNegRisk: intent.market.negRisk,
      isYieldBearing: Boolean(intent.market.yieldBearing)
    });
    const signedOrder = await orderBuilder.signTypedDataOrder(typedData);
    const hash = orderBuilder.buildTypedDataHash(typedData);
    const response = await this.tryPaths<any>('POST', ['/v1/orders', '/orders'], undefined, true, {
      data: {
        order: { ...signedOrder, hash },
        pricePerShare: String(amounts.pricePerShare),
        strategy: 'LIMIT',
        isPostOnly: intent.postOnly ? true : undefined
      }
    });
    const data = unwrapData(response);
    return {
      venue: this.name,
      clientOrderId: intent.clientOrderId,
      externalId: String(data?.orderId ?? data?.id ?? data?.order_id ?? response?.orderId ?? response?.id ?? response?.order_id ?? data?.orderHash ?? data?.order_hash ?? response?.order_hash ?? response?.hash ?? hash),
      status: 'OPEN',
      raw: response
    };
  }

  async createMarketableOrder(intent: OrderIntent, signer: SignerProvider): Promise<OrderResult> {
    return this.createOrder({ ...intent, postOnly: false, liquidity: 'taker' }, signer);
  }

  async cancelOrders(orderIds: string[]): Promise<void> {
    if (orderIds.length === 0) return;
    if (this.jwt) void this.wsClient().subscribeWalletEvents(this.jwt).catch(() => undefined);
    const ids = [...new Set(orderIds.filter(Boolean))];
    const bodies = [
      { data: { ids } },
      { data: { orderIds: ids } },
      { ids },
      { orderIds: ids }
    ];
    let lastError: unknown;
    for (const body of bodies) {
      try {
        await this.tryPaths<any>('POST', ['/v1/orders/remove', '/orders/remove'], undefined, true, body);
        return;
      } catch (error: any) {
        lastError = error;
        if (![400, 422].includes(Number(error?.status))) throw error;
      }
    }
    throw lastError;
  }

  private async tryPaths<T>(
    method: 'GET' | 'POST',
    paths: string[],
    params?: Record<string, string>,
    requireJwt = false,
    body?: unknown,
    timeoutMs?: number
  ): Promise<T> {
    if (requireJwt && !this.jwt) {
      throw new Error('Predict JWT is required for this endpoint. Run mm auth predict first.');
    }
    let lastError: unknown;
    for (const apiPath of paths) {
      const url = new URL(this.config.venues.predict.apiBaseUrl.replace(/\/+$/, '') + apiPath);
      for (const [key, value] of Object.entries(params ?? {})) url.searchParams.set(key, value);
      try {
        return await httpJson<T>(url.toString(), {
          method,
          ...(timeoutMs ? { timeoutMs } : {}),
          body: body === undefined ? undefined : JSON.stringify(body),
          headers: {
            ...(this.config.venues.predict.apiKey ? { 'x-api-key': this.config.venues.predict.apiKey } : {}),
            ...(requireJwt && this.jwt ? { authorization: `Bearer ${this.jwt}` } : {})
          }
        });
      } catch (error: any) {
        lastError = error;
        if (![404, 405, 501].includes(Number(error?.status))) break;
      }
    }
    throw lastError;
  }

  private async getOrderbookViaRest(tokenId: string, marketId: string) {
    const attempts = [
      {
        path: `/v1/markets/${encodeURIComponent(tokenId)}/orderbook`,
        allowAmbiguousTopLevel: false
      },
      ...(marketId !== tokenId
        ? [{
            path: `/v1/markets/${encodeURIComponent(marketId)}/orderbook`,
            allowAmbiguousTopLevel: true
          }]
        : [])
    ];
    let lastError: unknown;
    for (const attempt of attempts) {
      try {
        const payload = await this.tryPaths<any>('GET', [attempt.path], undefined, true, undefined, PREDICT_ORDERBOOK_REST_FALLBACK_MS);
        return buildOrderbookForToken(this.name, tokenId, payload, {
          allowAmbiguousTopLevel: attempt.allowAmbiguousTopLevel,
          complementAmbiguousTopLevel: this.shouldComplementBinaryBook(tokenId),
          complementTickSize: this.tickSizeByToken.get(tokenId)
        });
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  private async signPredictAuthMessage(signer: SignerProvider, message: string): Promise<string> {
    const account = this.validAccountAddress();
    if (account && signer instanceof LocalWalletSigner) {
      try {
        const sdk = await this.predictSdk();
        const provider = new JsonRpcProvider(this.config.venues.predict.rpcUrl);
        const wallet = signer.unsafeEthersWalletForSdk().connect(provider);
        const orderBuilder = await sdk.OrderBuilder.make(this.config.venues.predict.chainId, wallet, { predictAccount: account });
        return await orderBuilder.signPredictAccountMessage(message);
      } catch {
        return signer.signMessage(message);
      }
    }
    return signer.signMessage(message);
  }

  private validAccountAddress(): string | undefined {
    const account = this.config.venues.predict.accountAddress.trim();
    return /^0x[a-fA-F0-9]{40}$/.test(account) && account.toLowerCase() !== `0x${'0'.repeat(40)}` ? account : undefined;
  }

  private tradingAddress(fallback: string): string {
    return this.validAccountAddress() ?? fallback;
  }

  private shouldComplementBinaryBook(tokenId: string): boolean {
    return this.outcomeIndexByToken.get(tokenId) === 1;
  }

  private async getOnchainUsdtBalance(ownerAddress: string): Promise<Balance[]> {
    const sdk = await this.predictSdk();
    const tokenAddress = sdk.AddressesByChainId?.[this.config.venues.predict.chainId]?.USDT;
    if (!tokenAddress) throw new Error(`Predict SDK has no USDT address for chain ${this.config.venues.predict.chainId}`);
    const raw = await this.readUsdtBalanceWithRpcFailover(tokenAddress, ownerAddress);
    const amount = Number(formatUnits(raw, 18));
    if (!Number.isFinite(amount)) throw new Error('Predict USDT balance was not a finite number.');
    return [{ asset: 'USDT', available: amount, total: amount }];
  }

  private async readUsdtBalanceWithRpcFailover(tokenAddress: string, ownerAddress: string): Promise<bigint> {
    const urls = this.balanceRpcUrls();
    const errors: string[] = [];
    return new Promise<bigint>((resolve, reject) => {
      let pending = urls.length;
      let settled = false;
      for (const rpcUrl of urls) {
        withTimeout(this.readUsdtBalanceFromRpc(rpcUrl, tokenAddress, ownerAddress), BALANCE_RPC_TIMEOUT_MS)
          .then((value) => {
            if (settled) return;
            settled = true;
            resolve(value);
          })
          .catch((error) => {
            errors.push(`${new URL(rpcUrl).origin}: ${error instanceof Error ? error.message : String(error)}`);
            pending -= 1;
            if (!settled && pending === 0) {
              reject(new Error(`Predict USDT balance RPC failed across ${urls.length} endpoint(s): ${errors.join(' | ')}`));
            }
          });
      }
    });
  }

  private async readNativeBalanceWithRpcFailover(ownerAddress: string): Promise<bigint> {
    const urls = this.balanceRpcUrls();
    const errors: string[] = [];
    return new Promise<bigint>((resolve, reject) => {
      let pending = urls.length;
      let settled = false;
      for (const rpcUrl of urls) {
        withTimeout(this.readNativeBalanceFromRpc(rpcUrl, ownerAddress), BALANCE_RPC_TIMEOUT_MS)
          .then((value) => {
            if (settled) return;
            settled = true;
            resolve(value);
          })
          .catch((error) => {
            errors.push(`${new URL(rpcUrl).origin}: ${error instanceof Error ? error.message : String(error)}`);
            pending -= 1;
            if (!settled && pending === 0) {
              reject(new Error(`Predict BNB balance RPC failed across ${urls.length} endpoint(s): ${errors.join(' | ')}`));
            }
          });
      }
    });
  }

  private async readNativeBalanceFromRpc(rpcUrl: string, ownerAddress: string): Promise<bigint> {
    const provider = new JsonRpcProvider(rpcUrl, this.config.venues.predict.chainId, { staticNetwork: true });
    return provider.getBalance(ownerAddress);
  }

  private async readUsdtBalanceFromRpc(rpcUrl: string, tokenAddress: string, ownerAddress: string): Promise<bigint> {
    const provider = new JsonRpcProvider(rpcUrl, this.config.venues.predict.chainId, { staticNetwork: true });
    const token = new Contract(tokenAddress, ERC20_ABI, provider);
    return await (token as any).balanceOf(ownerAddress) as bigint;
  }

  private async readApprovalSnapshotWithRpcFailover(
    signerAddress: string,
    collateral?: { tokenAddress: string; spenderAddresses: string[]; ownerAddress: string }
  ): Promise<{ native: bigint; balance?: bigint; allowances?: bigint[] }> {
    const urls = this.balanceRpcUrls();
    const errors: string[] = [];
    return new Promise((resolve, reject) => {
      let pending = urls.length;
      let settled = false;
      for (const rpcUrl of urls) {
        withTimeout(this.readApprovalSnapshotFromRpc(rpcUrl, signerAddress, collateral), BALANCE_RPC_TIMEOUT_MS)
          .then((snapshot) => {
            if (settled) return;
            settled = true;
            resolve(snapshot);
          })
          .catch((error) => {
            errors.push(`${new URL(rpcUrl).origin}: ${error instanceof Error ? error.message : String(error)}`);
            pending -= 1;
            if (!settled && pending === 0) {
              reject(new Error(`Predict approval RPC failed across ${urls.length} endpoint(s): ${errors.join(' | ')}`));
            }
          });
      }
    });
  }

  private async readApprovalSnapshotFromRpc(
    rpcUrl: string,
    signerAddress: string,
    collateral?: { tokenAddress: string; spenderAddresses: string[]; ownerAddress: string }
  ): Promise<{ native: bigint; balance?: bigint; allowances?: bigint[] }> {
    const provider = new JsonRpcProvider(rpcUrl, this.config.venues.predict.chainId, { staticNetwork: true });
    const native = await provider.getBalance(signerAddress);
    if (!collateral) return { native };
    const token = new Contract(collateral.tokenAddress, ERC20_ABI, provider);
    const [balance, ...allowances] = await Promise.all([
      (token as any).balanceOf(collateral.ownerAddress) as Promise<bigint>,
      ...collateral.spenderAddresses.map((spenderAddress) => (token as any).allowance(collateral.ownerAddress, spenderAddress) as Promise<bigint>)
    ]);
    return { native, balance, allowances };
  }

  private async estimateSplitMergeGasCost(
    signer: LocalWalletSigner,
    request: SplitMergeGasEstimateRequest & { orderBuilder?: any }
  ): Promise<PredictGasCostEstimate> {
    try {
      const sdk = await this.predictSdk();
      const provider = new JsonRpcProvider(this.config.venues.predict.rpcUrl, this.config.venues.predict.chainId, { staticNetwork: true });
      const wallet = signer.unsafeEthersWalletForSdk().connect(provider);
      const chainId = this.config.venues.predict.chainId || sdk.ChainId.BnbMainnet;
      const account = this.validAccountAddress();
      const orderBuilder = request.orderBuilder ?? await sdk.OrderBuilder.make(chainId, wallet, account ? { predictAccount: account } : {});
      const feeData = await provider.getFeeData();
      const gasPrice = feeData.gasPrice ?? parseUnits(String(PREDICT_FALLBACK_SPLIT_MERGE_GAS_PRICE_GWEI), 'gwei');
      const gasUnits = await this.estimateSplitMergeGasUnits(orderBuilder, request);
      const bufferMultiplier = Math.max(1, this.config.strategy.gasBufferMultiplier ?? 1.35);
      const requiredWei = bufferedGasCostWei(gasUnits, gasPrice, bufferMultiplier);
      return {
        requiredBnb: Number(formatUnits(requiredWei, 18)),
        gasUnits: Number(gasUnits),
        gasPriceGwei: Number(formatUnits(gasPrice, 'gwei')),
        bufferMultiplier,
        status: 'estimated',
        message: 'RPC estimateGas'
      };
    } catch (error) {
      return this.fallbackSplitMergeGasCost(error instanceof Error ? error.message : String(error));
    }
  }

  private async estimateSplitMergeGasUnits(
    orderBuilder: any,
    request: SplitMergeGasEstimateRequest
  ): Promise<bigint> {
    const market = request.market;
    if (!market || !request.conditionId || !Number.isFinite(request.amountUsd) || Number(request.amountUsd) <= 0) {
      return BigInt(this.config.strategy.fallbackSplitMergeGasUnits ?? 450000);
    }
    const amount = predictOrderWei(Number(request.amountUsd), 6);
    const action = request.action ?? 'split';
    const contracts = orderBuilder.contracts;
    if (!contracts) return BigInt(this.config.strategy.fallbackSplitMergeGasUnits ?? 450000);
    const predictAccount = this.validAccountAddress();
    const sdk = await this.predictSdk();
    const addresses = sdk.AddressesByChainId[this.config.venues.predict.chainId];
    if (!addresses) throw new Error(`Predict SDK has no addresses for chain ${this.config.venues.predict.chainId}`);
    if (market.negRisk) {
      const identifier = market.yieldBearing ? 'YIELD_BEARING_NEG_RISK_ADAPTER' : 'NEG_RISK_ADAPTER';
      const entry = contracts[identifier];
      if (predictAccount) {
        const method = action === 'merge' ? 'mergePositions(bytes32,uint256)' : 'splitPosition(bytes32,uint256)';
        const encoded = entry.codec.encodeFunctionData(method, [request.conditionId, amount]);
        return contracts.KERNEL.contract.execute.estimateGas(ZeroHash, encodeExecutionCalldata(addresses[identifier], encoded));
      }
      const method = action === 'merge' ? 'mergePositions(bytes32,uint256)' : 'splitPosition(bytes32,uint256)';
      return entry.contract[method].estimateGas(request.conditionId, amount);
    }
    const identifier = market.yieldBearing ? 'YIELD_BEARING_CONDITIONAL_TOKENS' : 'CONDITIONAL_TOKENS';
    const entry = contracts[identifier];
    const partition = [1n, 2n];
    const args = [addresses.USDT, ZeroHash, request.conditionId, partition, amount];
    if (predictAccount) {
      const encoded = entry.codec.encodeFunctionData(action === 'merge' ? 'mergePositions' : 'splitPosition', args);
      return contracts.KERNEL.contract.execute.estimateGas(ZeroHash, encodeExecutionCalldata(addresses[identifier], encoded));
    }
    return entry.contract[action === 'merge' ? 'mergePositions' : 'splitPosition'].estimateGas(...args);
  }

  private async fallbackSplitMergeGasCost(reason: string): Promise<PredictGasCostEstimate> {
    const provider = new JsonRpcProvider(this.config.venues.predict.rpcUrl, this.config.venues.predict.chainId, { staticNetwork: true });
    let gasPrice = parseUnits(String(PREDICT_FALLBACK_SPLIT_MERGE_GAS_PRICE_GWEI), 'gwei');
    try {
      gasPrice = (await provider.getFeeData()).gasPrice ?? gasPrice;
    } catch {
      // Keep static fallback when the RPC cannot expose gas price.
    }
    const gasUnits = BigInt(Math.max(1, this.config.strategy.fallbackSplitMergeGasUnits ?? 450000));
    const bufferMultiplier = Math.max(1, this.config.strategy.gasBufferMultiplier ?? 1.35);
    const requiredWei = bufferedGasCostWei(gasUnits, gasPrice, bufferMultiplier);
    return {
      requiredBnb: Number(formatUnits(requiredWei, 18)),
      gasUnits: Number(gasUnits),
      gasPriceGwei: Number(formatUnits(gasPrice, 'gwei')),
      bufferMultiplier,
      status: 'fallback',
      message: reason
    };
  }

  private async assertNativeGasForSplitMerge(
    signer: SignerProvider,
    action: 'split' | 'merge',
    request: SplitPositionsRequest | MergePositionsRequest,
    orderBuilder?: any
  ): Promise<void> {
    const snapshot = await this.estimateSplitMergeGas(signer, {
      action,
      market: request.market,
      conditionId: request.conditionId,
      amountUsd: request.amountUsd,
      ...(orderBuilder ? { orderBuilder } as any : {})
    });
    if (snapshot.ok) return;
    throw new Error(`${action === 'split' ? 'Predict split positions failed' : 'Predict merge positions failed'}: ${snapshot.message}`);
  }

  private balanceRpcUrls(): string[] {
    return [
      this.config.venues.predict.rpcUrl,
      ...(PREDICT_BALANCE_RPC_FALLBACKS[this.config.venues.predict.chainId] ?? [])
    ].filter((url, index, urls) => Boolean(url) && urls.findIndex((item) => new URL(item).origin === new URL(url).origin) === index);
  }

  private wsClient(): PredictWsClient {
    const key = `${this.config.venues.predict.wsUrl}|${this.config.venues.predict.apiKey ? 'api-key' : 'no-api-key'}`;
    const existing = PredictVenue.wsClients.get(key);
    if (existing) return existing;
    const client = new PredictWsClient(this.config.venues.predict.wsUrl, this.config.venues.predict.apiKey || undefined);
    PredictVenue.wsClients.set(key, client);
    return client;
  }

  private async predictSdk(): Promise<any> {
    const mod = await import('@predictdotfun/sdk');
    return (mod as any).default ?? mod;
  }

  private predictCollateralAddresses(sdk: any, signer: SignerProvider, market?: Market) {
    const chainId = this.config.venues.predict.chainId;
    const addresses = sdk.AddressesByChainId[chainId];
    if (!addresses) throw new Error(`Predict SDK has no addresses for chain ${chainId}`);
    const regularExchange = market?.yieldBearing ? addresses.YIELD_BEARING_CTF_EXCHANGE : addresses.CTF_EXCHANGE;
    const negRiskExchange = market?.yieldBearing ? addresses.YIELD_BEARING_NEG_RISK_CTF_EXCHANGE : addresses.NEG_RISK_CTF_EXCHANGE;
    const spenderAddresses = market?.negRisk
      ? [negRiskExchange, regularExchange].filter(Boolean)
      : [regularExchange, negRiskExchange].filter(Boolean);
    return {
      tokenAddress: addresses.USDT,
      spenderAddresses: [...new Set(spenderAddresses)],
      ownerAddress: this.validAccountAddress() ?? signer.address
    };
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function finiteOrZero(value: number | undefined): number {
  return Number.isFinite(value) ? Number(value) : 0;
}

function sumDefined(values: Array<number | undefined>): number | undefined {
  const finite = values.filter((value): value is number => Number.isFinite(value));
  if (finite.length === 0) return undefined;
  return Number(finite.reduce((sum, value) => sum + value, 0).toFixed(4));
}

function predictUnrealizedPnl(positions: Position[]): number | undefined {
  const values = positions
    .filter((position) => position.size > 1e-9 || Math.abs(position.notionalUsd) > 0.01)
    .map((position) => {
      if (!Number.isFinite(position.averagePrice) || !Number.isFinite(position.size) || !Number.isFinite(position.notionalUsd)) return undefined;
      return position.notionalUsd - Number(position.averagePrice) * position.size;
    })
    .filter((value): value is number => Number.isFinite(value));
  if (values.length === 0) return undefined;
  return Number(values.reduce((sum, value) => sum + value, 0).toFixed(4));
}

function predictOrderWei(value: number, decimals: number): bigint {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`Predict order amount must be positive: ${value}`);
  return parseUnits(value.toFixed(decimals), 18);
}

function binaryOutcomeIndex(market: Market): number | undefined {
  if (market.outcomeCount !== 2) return undefined;
  if (market.outcomeIndex === 0 || market.outcomeIndex === 1) return market.outcomeIndex;
  const normalized = String(market.outcome ?? '').trim().toLowerCase();
  if (['yes', 'true', 'up', 'for'].includes(normalized)) return 0;
  if (['no', 'false', 'down', 'against'].includes(normalized)) return 1;
  return undefined;
}

interface PredictGasCostEstimate {
  requiredBnb: number;
  gasUnits: number;
  gasPriceGwei: number;
  bufferMultiplier: number;
  status: 'estimated' | 'fallback';
  message: string;
}

function bufferedGasCostWei(gasUnits: bigint, gasPriceWei: bigint, bufferMultiplier: number): bigint {
  const basisPoints = BigInt(Math.ceil(Math.max(1, bufferMultiplier) * 10000));
  return (gasUnits * gasPriceWei * basisPoints) / 10000n;
}

function encodeExecutionCalldata(to: string, calldata: string, value = 0n): string {
  return concat([to, toBeHex(value, 32), calldata]);
}

function formatBnb(value: number): string {
  if (!Number.isFinite(value)) return '0';
  if (value === 0) return '0';
  if (value < 0.000001) return value.toExponential(2);
  return value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}

function splitMergeTxHash(receipt: unknown): string | undefined {
  if (!receipt || typeof receipt !== 'object') return undefined;
  const hash = (receipt as Record<string, unknown>).hash ?? (receipt as Record<string, unknown>).transactionHash;
  return typeof hash === 'string' && hash.trim() ? hash : undefined;
}

function splitMergeReceiptSummary(receipt: unknown): Record<string, unknown> {
  if (!receipt || typeof receipt !== 'object') return {};
  const source = receipt as Record<string, unknown>;
  const summary: Record<string, unknown> = {};
  for (const [from, to] of [
    ['hash', 'hash'],
    ['transactionHash', 'transactionHash'],
    ['blockNumber', 'blockNumber'],
    ['status', 'status'],
    ['gasUsed', 'gasUsed']
  ] as const) {
    const value = source[from];
    if (value === undefined || value === null) continue;
    summary[to] = typeof value === 'bigint' ? value.toString() : value;
  }
  return summary;
}

export function planPredictMarketStatsFetchIds(rawMarkets: any[], config: AppConfig): Set<string> {
  const budget = predictMarketStatsFetchBudget(config);
  const selected = new Set(config.selectedMarkets.predict.map((tokenId) => String(tokenId)));
  const planned = new Set<string>();
  const sorted = [...rawMarkets].sort((a, b) => rawMergeIndex(a) - rawMergeIndex(b));
  const add = (raw: any): void => {
    if (planned.size >= budget) return;
    if (raw?.stats) return;
    const id = rawMarketId(raw);
    if (id) planned.add(id);
  };

  for (const raw of sorted) {
    if (rawOutcomeTokenIds(raw).some((tokenId) => selected.has(tokenId))) add(raw);
  }

  if (config.strategy.autoSelectMarkets) {
    const limit = Math.max(1, Math.min(config.strategy.candidateLimit ?? 12, PREDICT_MARKET_STATS_MAX_FETCHES));
    for (const raw of sorted) {
      if (rawMergeIndex(raw) < limit) add(raw);
    }
  }

  const activeRewards = sorted
    .map((raw) => ({ raw, hourlyRate: activeCurrentRewardHourlyRate(raw) }))
    .filter((entry) => entry.hourlyRate > 0)
    .sort((a, b) => b.hourlyRate - a.hourlyRate || rawMergeIndex(a.raw) - rawMergeIndex(b.raw));
  for (const entry of activeRewards) add(entry.raw);

  return planned;
}

function predictMarketStatsFetchBudget(config: AppConfig): number {
  const candidateLimit = Math.max(1, config.strategy.candidateLimit ?? 12);
  return Math.min(PREDICT_MARKET_STATS_MAX_FETCHES, Math.max(PREDICT_MARKET_STATS_MIN_FETCHES, candidateLimit * 2));
}

function rawMarketId(raw: any): string {
  return String(raw?.id ?? raw?.market_id ?? raw?.marketId ?? '');
}

function rawOutcomeTokenIds(raw: any): string[] {
  const outcomes = Array.isArray(raw?.outcomes) ? raw.outcomes : [];
  return outcomes
    .map((outcome: any) => String(outcome?.onChainId ?? outcome?.tokenId ?? outcome?.token_id ?? ''))
    .filter(Boolean);
}

function rawMergeIndex(raw: any): number {
  const index = Number(raw?.__safeMmMergeIndex ?? 0);
  return Number.isFinite(index) ? index : 0;
}

function activeCurrentRewardHourlyRate(raw: any): number {
  const current = raw?.rewards?.current;
  if (!current || typeof current !== 'object') return 0;
  const hourlyRate = Number(current.hourlyRate ?? current.hourly_rate ?? 0);
  if (!Number.isFinite(hourlyRate) || hourlyRate <= 0) return 0;
  const now = Date.now();
  const startsAt = Date.parse(String(current.startsAt ?? current.starts_at ?? ''));
  const endsAt = Date.parse(String(current.endsAt ?? current.ends_at ?? ''));
  if (Number.isFinite(startsAt) && startsAt > now) return 0;
  if (Number.isFinite(endsAt) && endsAt < now) return 0;
  return hourlyRate;
}
