import type { AppConfig } from '../config/schema.js';
import { venueLiveEnabled } from '../config/live-enabled.js';
import type { AccountRiskDecision, Balance, Market, NativeGasBalance, OpenOrder, OrderSide, Orderbook, Position, VenueName } from '../domain/types.js';
import { capitalUsage, primaryStableBalance as primaryStableBalanceFromRisk } from '../risk/capital-risk.js';
import { marketTimeDecision, type MarketGuardDecision } from '../risk/market-guard.js';
import { effectiveOrderbookTick, isWithinRewardBand, rewardTargetShares, roundToTick, shouldEnforceRewardMinimum } from '../strategy/rewards/common.js';
import { completeSetInventoryGroups, expectedOutcomeCount, hasCompleteOutcomeSet, isPairedEntryMode, marketGroupKey, pairedPositionGroups } from '../strategy/paired-inventory.js';
import { discoverRoutableMarkets } from '../strategy/market-discovery.js';
import { effectiveQuoteSide } from '../strategy/strategy-engine.js';
import { bestBidAsk } from '../venues/normalize.js';

export type StartupSideStatus = 'ready' | 'conditional' | 'skipped' | 'blocked';

export interface StartupDataStatus {
  ok: boolean;
  message: string;
}

export interface StartupSideFact {
  side: OrderSide;
  requested: boolean;
  status: StartupSideStatus;
  plannedOrders: number;
  label: string;
  reason: string;
}

export interface StartupFacts {
  venue: VenueName;
  address: string;
  signerAddress?: string;
  checkedAt: string;
  liveEnabled: boolean;
  readyToQuote: boolean;
  summary: string;
  blockingReasons: string[];
  dataStatus: {
    balances: StartupDataStatus;
    positions: StartupDataStatus;
    openOrders: StartupDataStatus;
    accountRisk: StartupDataStatus;
    markets: StartupDataStatus;
  };
  marketGuard: {
    ok: boolean;
    checked: number;
    blocked: number;
    unknownEndTime: number;
    nearSettlement: number;
    cancelWindow: number;
    nearEventStart: number;
    eventStarted: number;
    sample: Array<{
      tokenId: string;
      question: string;
      outcome?: string;
      decision: MarketGuardDecision;
    }>;
  };
  funds: {
    asset: string;
    availableUsd: number;
    totalUsd: number;
    reserveUsd: number;
    reservedOpenOrdersUsd: number;
    actualFrozenUsd?: number;
    reserveDriftUsd?: number;
    reserveDriftPct?: number;
    reserveDriftOk: boolean;
    reserveDriftMessage: string;
    spendableUsd: number;
    targetOrderUsd: number;
    maxAffordableOrders: number;
    maxBuyOrdersByFunds: number;
  };
  rewardMinimum: {
    enforce: boolean;
    checked: number;
    underfunded: number;
    highestMinimumUsd?: number;
    message: string;
  };
  splitEntry?: {
    active: boolean;
    supported: boolean;
    hasCompleteInventory: boolean;
    canAttempt: boolean;
    status: 'inactive' | 'ready-with-inventory' | 'ready-to-split' | 'unsupported' | 'no-pair' | 'condition-missing' | 'funds-insufficient' | 'risk-limit' | 'gas-insufficient' | 'gas-warning';
    candidatePairs: number;
    conditionReadyPairs: number;
    plannedSellOrders: number;
    estimatedMinimumSplitUsd?: number;
    estimatedFullOrderSplitUsd?: number;
    gas?: NativeGasBalance;
    message: string;
  };
  inventory: {
    tokenCount: number;
    totalNotionalUsd: number;
    sufficientTokenCount: number;
  };
  requestedSides: OrderSide[];
  quoteSlots: number;
  expected: {
    buyOrders: number;
    sellOrders: number;
    totalOrders: number;
  };
  sides: Record<OrderSide, StartupSideFact>;
  openOrdersCount: number;
  positionsCount: number;
  accountRisk?: AccountRiskDecision;
  nativeGas?: NativeGasBalance;
}

export interface ComputeStartupFactsInput {
  config: AppConfig;
  venue: VenueName;
  address: string;
  signerAddress?: string;
  balances: Balance[];
  positions: Position[];
  openOrders: OpenOrder[];
  markets?: Market[];
  books?: Map<string, Orderbook>;
  accountRisk?: AccountRiskDecision;
  nativeGas?: NativeGasBalance;
  checkedAt?: Date;
  dataStatus?: Partial<StartupFacts['dataStatus']>;
}

export function computeStartupFacts(input: ComputeStartupFactsInput): StartupFacts {
  const checkedAt = input.checkedAt ?? new Date();
  const liveEnabled = venueLiveEnabled(input.config, input.venue);
  const quoteSlots = Math.max(1, input.config.risk.maxMarkets);
  const requestedSides = configuredSides(input.config);
  const targetOrderUsd = roundUsd(input.config.risk.orderSizeUsd);
  const primary = primaryStableBalance(input.balances);
  const usage = capitalUsage(input.config, input.balances, input.openOrders);
  const reserveUsd = usage.reserveUsd;
  const reservedOpenOrdersUsd = usage.reservedOpenOrdersUsd;
  const availableUsd = usage.availableUsd;
  const totalUsd = usage.totalUsd;
  const spendableUsd = usage.spendableUsd;
  const maxAffordableOrders = targetOrderUsd > 0 ? Math.floor((spendableUsd + 1e-9) / targetOrderUsd) : 0;
  const maxBuyOrdersByFunds = Math.min(quoteSlots, maxAffordableOrders);
  const inventoryPositions = input.positions.filter((position) => position.size > 1e-9 || Math.abs(position.notionalUsd) > 0.01);
  const sufficientTokenCount = inventoryPositions.filter((position) => Math.abs(position.notionalUsd) + 1e-9 >= targetOrderUsd).length;
  const dataStatus = {
    balances: input.dataStatus?.balances ?? { ok: true, message: `${input.balances.length} balances` },
    positions: input.dataStatus?.positions ?? { ok: true, message: `${input.positions.length} positions` },
    openOrders: input.dataStatus?.openOrders ?? { ok: true, message: `${input.openOrders.length} open orders` },
    markets: input.dataStatus?.markets ?? { ok: true, message: `${input.markets?.length ?? 0} candidate markets` },
    accountRisk: input.dataStatus?.accountRisk ?? (
      input.accountRisk
        ? { ok: input.accountRisk.ok, message: input.accountRisk.message }
        : { ok: false, message: '账户级风控未检查，禁止新增挂单' }
    )
  };
  const marketGuard = startupMarketGuard(input.config, input.venue, input.markets ?? [], checkedAt.getTime());
  const rewardMinimum = startupRewardMinimum(input.config, input.venue, input.markets ?? []);
  const pairedGroupCount = input.markets ? pairedPositionGroups(input.config, input.markets, input.positions).size : 0;
  const completeSetGroups = input.markets ? completeSetInventoryGroups(input.config, input.markets, input.positions) : [];
  const splitInventorySellOrders = splitInventoryOrderCount(input.config, completeSetGroups, quoteSlots);
  const splitEntry = startupSplitEntry({
    config: input.config,
    venue: input.venue,
    markets: input.markets ?? [],
    books: input.books,
    dataStatus,
    targetOrderUsd,
    spendableUsd,
    maxPositionUsd: input.config.risk.maxPositionUsd,
    quoteSlots,
    pairedGroupCount,
    nativeGas: input.nativeGas
  });

  const buy = buyFact({
    requested: requestedSides.includes('BUY'),
    liveEnabled,
    balancesOk: dataStatus.balances.ok,
    primary,
    targetOrderUsd,
    maxSingleOrderUsd: input.config.risk.maxSingleOrderUsd,
    maxPositionUsd: input.config.risk.maxPositionUsd,
    spendableUsd,
    plannedOrders: maxBuyOrdersByFunds
  });
  const sell = sellFact({
    requested: requestedSides.includes('SELL'),
    liveEnabled,
    positionsOk: dataStatus.positions.ok,
    targetOrderUsd,
    quoteSlots,
    inventoryTokenCount: inventoryPositions.length,
    sufficientTokenCount,
    pairedMode: isPairedEntryMode(input.config),
    pairedGroupCount,
    splitInventorySellOrders,
    splitEntry
  });
  const baseBlockingReasons = baseBlocks(liveEnabled, dataStatus, input.accountRisk, marketGuard);
  const expected = {
    buyOrders: buy.status === 'ready' ? buy.plannedOrders : 0,
    sellOrders: sell.status === 'ready' || sell.status === 'conditional' ? sell.plannedOrders : 0,
    totalOrders: 0
  };
  expected.totalOrders = expected.buyOrders + expected.sellOrders;
  const blockingReasons = [...baseBlockingReasons];
  if (!usage.driftOk) blockingReasons.push(usage.driftMessage);
  if (expected.totalOrders === 0) {
    const sideReasons = [buy, sell]
      .filter((side) => side.requested)
      .map((side) => side.reason);
    blockingReasons.push(sideReasons.length > 0 ? sideReasons.join('；') : '当前配置没有请求任何挂单方向');
  }
  const readyToQuote = blockingReasons.length === 0;

  return {
    venue: input.venue,
    address: input.address,
    ...(input.signerAddress ? { signerAddress: input.signerAddress } : {}),
    checkedAt: checkedAt.toISOString(),
    liveEnabled,
    readyToQuote,
    summary: summaryText(readyToQuote, expected, buy, sell, blockingReasons),
    blockingReasons,
    dataStatus,
    marketGuard,
    funds: {
      asset: primary?.asset ?? 'USD',
      availableUsd,
      totalUsd,
      reserveUsd,
      reservedOpenOrdersUsd,
      ...(usage.actualFrozenUsd !== undefined ? { actualFrozenUsd: usage.actualFrozenUsd } : {}),
      ...(usage.reserveDriftUsd !== undefined ? { reserveDriftUsd: usage.reserveDriftUsd } : {}),
      ...(usage.reserveDriftPct !== undefined ? { reserveDriftPct: usage.reserveDriftPct } : {}),
      reserveDriftOk: usage.driftOk,
      reserveDriftMessage: usage.driftMessage,
      spendableUsd,
      targetOrderUsd,
      maxAffordableOrders,
      maxBuyOrdersByFunds
    },
    rewardMinimum,
    ...(splitEntry.active ? { splitEntry } : {}),
    inventory: {
      tokenCount: inventoryPositions.length,
      totalNotionalUsd: roundUsd(inventoryPositions.reduce((sum, position) => sum + Math.abs(position.notionalUsd), 0)),
      sufficientTokenCount
    },
    requestedSides,
    quoteSlots,
    expected,
    sides: { BUY: buy, SELL: sell },
    openOrdersCount: input.openOrders.length,
    positionsCount: input.positions.length,
    ...(input.accountRisk ? { accountRisk: input.accountRisk } : {}),
    ...(input.nativeGas ? { nativeGas: input.nativeGas } : {})
  };
}

export function primaryStableBalance(balances: Balance[]): Balance | undefined {
  return primaryStableBalanceFromRisk(balances);
}

export function configuredSides(config: AppConfig): OrderSide[] {
  const quoteSide = effectiveQuoteSide(config);
  if (quoteSide === 'both') return ['BUY', 'SELL'];
  return quoteSide === 'sell' ? ['SELL'] : ['BUY'];
}

function buyFact(input: {
  requested: boolean;
  liveEnabled: boolean;
  balancesOk: boolean;
  primary?: Balance;
  targetOrderUsd: number;
  maxSingleOrderUsd: number;
  maxPositionUsd: number;
  spendableUsd: number;
  plannedOrders: number;
}): StartupSideFact {
  if (!input.requested) return sideFact('BUY', false, 'skipped', 0, '未请求 BUY', '当前挂单方向不是 BUY。');
  if (!input.liveEnabled) return sideFact('BUY', true, 'blocked', 0, 'BUY 被阻断', '当前模块实盘开关未开启。');
  if (!input.balancesOk) return sideFact('BUY', true, 'blocked', 0, 'BUY 被阻断', '余额同步失败，不能确认可用资金。');
  if (!input.primary) return sideFact('BUY', true, 'blocked', 0, 'BUY 被阻断', '没有可验证的 USDT/USDC/pUSD/USD 余额。');
  if (input.targetOrderUsd > input.maxSingleOrderUsd) {
    return sideFact('BUY', true, 'blocked', 0, 'BUY 被阻断', `目标单笔 ${fmt(input.targetOrderUsd)} 超过单笔上限 ${fmt(input.maxSingleOrderUsd)}。`);
  }
  if (input.targetOrderUsd > input.maxPositionUsd) {
    return sideFact('BUY', true, 'blocked', 0, 'BUY 被阻断', `目标单笔 ${fmt(input.targetOrderUsd)} 超过持仓上限 ${fmt(input.maxPositionUsd)}。`);
  }
  if (input.plannedOrders <= 0) {
    return sideFact('BUY', true, 'blocked', 0, 'BUY 资金不足', `扣除预留和开放订单后，可用资金 ${fmt(input.spendableUsd)} 小于目标单笔 ${fmt(input.targetOrderUsd)}。`);
  }
  return sideFact('BUY', true, 'ready', input.plannedOrders, `BUY 可挂 ${input.plannedOrders} 笔`, `资金可支持本轮最多 ${input.plannedOrders} 笔 BUY。`);
}

function sellFact(input: {
  requested: boolean;
  liveEnabled: boolean;
  positionsOk: boolean;
  targetOrderUsd: number;
  quoteSlots: number;
  inventoryTokenCount: number;
  sufficientTokenCount: number;
  pairedMode: boolean;
  pairedGroupCount: number;
  splitInventorySellOrders: number;
  splitEntry: StartupFacts['splitEntry'];
}): StartupSideFact {
  if (!input.requested) return sideFact('SELL', false, 'skipped', 0, '未请求 SELL', '当前挂单方向不是 SELL。');
  if (!input.liveEnabled) return sideFact('SELL', true, 'blocked', 0, 'SELL 被阻断', '当前模块实盘开关未开启。');
  if (!input.positionsOk) return sideFact('SELL', true, 'blocked', 0, 'SELL 被阻断', '持仓同步失败，不能确认是否有可卖库存。');
  if (input.pairedMode && input.pairedGroupCount === 0) {
    if (input.splitEntry?.canAttempt) {
      return sideFact('SELL', true, 'conditional', input.splitEntry.plannedSellOrders, 'SELL 待拆分', `${input.splitEntry.message} 最终是否下单，还要看下一轮实时盘口、价差、深度和结算保护。`);
    }
    return sideFact('SELL', true, 'blocked', 0, 'SELL 被阻断', input.splitEntry?.message ?? '没有完整 YES/NO 套仓，也没有可执行的自动拆分入口。');
  }
  if (input.inventoryTokenCount === 0) {
    return sideFact('SELL', true, 'skipped', 0, 'SELL 跳过', '当前没有可卖库存；双边配置下，SELL 侧会被策略跳过。');
  }
  if (input.pairedMode && input.pairedGroupCount > 0) {
    const plannedOrders = input.splitInventorySellOrders;
    if (plannedOrders <= 0) {
      return sideFact('SELL', true, 'conditional', 0, 'SELL 可能跳过', `已看到完整 YES/NO 套仓，但完整套仓份数或目标市场不足以形成双边 SELL；实际下单会按盘口和库存复检。`);
    }
    return sideFact('SELL', true, 'conditional', plannedOrders, `SELL 最多 ${plannedOrders} 笔`, `已看到完整 YES/NO 套仓；每边按完整套仓份数等量 SELL，实际价格、份数和是否挂单会按实时盘口复检。`);
  }
  if (input.sufficientTokenCount === 0) {
    return sideFact('SELL', true, 'conditional', 0, 'SELL 可能跳过', `检测到库存，但没有任何 token 估值达到目标单笔 ${fmt(input.targetOrderUsd)}；实际目标市场库存不足时会跳过。`);
  }
  const plannedOrders = input.pairedMode
    ? Math.min(input.quoteSlots * 2, input.sufficientTokenCount)
    : Math.min(input.quoteSlots, input.sufficientTokenCount);
  return sideFact('SELL', true, 'conditional', plannedOrders, `SELL 最多 ${plannedOrders} 笔`, input.pairedMode
    ? `已看到完整 YES/NO 套仓；只有目标市场两边库存、盘口和风控都匹配时才会双边 SELL。`
    : `有 ${input.sufficientTokenCount} 个 token 库存估值覆盖目标金额；只有目标市场匹配这些库存时才会挂 SELL。`);
}

function sideFact(side: OrderSide, requested: boolean, status: StartupSideStatus, plannedOrders: number, label: string, reason: string): StartupSideFact {
  return { side, requested, status, plannedOrders, label, reason };
}

function baseBlocks(
  liveEnabled: boolean,
  dataStatus: StartupFacts['dataStatus'],
  accountRisk: AccountRiskDecision | undefined,
  marketGuard: StartupFacts['marketGuard']
): string[] {
  const reasons: string[] = [];
  if (!liveEnabled) reasons.push('当前模块实盘开关未开启。');
  if (!dataStatus.openOrders.ok) reasons.push(dataStatus.openOrders.message);
  if (!dataStatus.balances.ok) reasons.push(dataStatus.balances.message);
  if (!dataStatus.positions.ok) reasons.push(dataStatus.positions.message);
  if (!dataStatus.markets.ok) reasons.push(dataStatus.markets.message);
  if (marketGuard.checked > 0 && !marketGuard.ok) {
    reasons.push(`启动候选市场全部存在结束时间风险：${marketGuard.blocked}/${marketGuard.checked} 个被阻断。${marketGuard.sample[0]?.decision.message ?? ''}`);
  }
  if (!accountRisk) reasons.push('账户级风控未检查，禁止新增挂单。');
  else if (!accountRisk.ok) reasons.push(accountRisk.message);
  return reasons;
}

function startupMarketGuard(config: AppConfig, venue: VenueName, markets: Market[], now: number): StartupFacts['marketGuard'] {
  const sample: StartupFacts['marketGuard']['sample'] = [];
  const checkedMarkets = discoverRoutableMarkets(config, venue, markets);
  let blocked = 0;
  let unknownEndTime = 0;
  let nearSettlement = 0;
  let cancelWindow = 0;
  let nearEventStart = 0;
  let eventStarted = 0;
  for (const market of checkedMarkets) {
    const decision = marketTimeDecision(config, market, now);
    if (!decision.ok || decision.cancelOpenOrders) {
      blocked += 1;
      if (decision.reason === 'unknown-end-time') unknownEndTime += 1;
      if (decision.reason === 'near-settlement') nearSettlement += 1;
      if (decision.reason === 'cancel-window' || decision.reason === 'market-ended') cancelWindow += 1;
      if (decision.reason === 'near-event-start' || decision.reason === 'event-start-cancel-window') nearEventStart += 1;
      if (decision.reason === 'event-started') eventStarted += 1;
      if (sample.length < 5) {
        sample.push({
          tokenId: market.tokenId,
          question: market.question,
          ...(market.outcome ? { outcome: market.outcome } : {}),
          decision
        });
      }
    }
  }
  const safeEligibleCount = checkedMarkets.length - blocked;
  return {
    ok: checkedMarkets.length === 0 || safeEligibleCount > 0,
    checked: checkedMarkets.length,
    blocked,
    unknownEndTime,
    nearSettlement,
    cancelWindow,
    nearEventStart,
    eventStarted,
    sample
  };
}

function startupRewardMinimum(config: AppConfig, venue: VenueName, markets: Market[]): StartupFacts['rewardMinimum'] {
  const checkedMarkets = discoverRoutableMarkets(config, venue, markets);
  const targetOrderUsd = config.risk.orderSizeUsd;
  const minimums = checkedMarkets
    .map((market) => {
      const targetShares = rewardTargetShares(config, market.rewards?.minShares);
      return targetShares === undefined ? undefined : targetShares * 0.5;
    })
    .filter((value): value is number => Number.isFinite(value));
  const underfunded = minimums.filter((value) => value > targetOrderUsd + 1e-9);
  const highestMinimumUsd = underfunded.length > 0 ? roundUsd(Math.max(...underfunded)) : undefined;
  const enforce = shouldEnforceRewardMinimum(config);
  const message = enforce
    ? '已开启严格 PP 最低份额；当前单笔金额买不够最低份额加 1 的候选不会下单。'
    : underfunded.length > 0
      ? `非积分小额测试模式：${underfunded.length}/${minimums.length} 个候选按 50c 粗算最低约需 ${fmt(highestMinimumUsd ?? 0)}，当前不保证计 PP。`
      : '当前候选未发现明显低于 PP 最低份额的问题。';
  return {
    enforce,
    checked: minimums.length,
    underfunded: underfunded.length,
    ...(highestMinimumUsd !== undefined ? { highestMinimumUsd } : {}),
    message
  };
}

function startupSplitEntry(input: {
  config: AppConfig;
  venue: VenueName;
  markets: Market[];
  books?: Map<string, Orderbook>;
  dataStatus: StartupFacts['dataStatus'];
  targetOrderUsd: number;
  spendableUsd: number;
  maxPositionUsd: number;
  quoteSlots: number;
  pairedGroupCount: number;
  nativeGas?: NativeGasBalance;
}): NonNullable<StartupFacts['splitEntry']> {
  if (!isPairedEntryMode(input.config)) {
    return {
      active: false,
      supported: false,
      hasCompleteInventory: false,
      canAttempt: false,
      status: 'inactive',
      candidatePairs: 0,
      conditionReadyPairs: 0,
      plannedSellOrders: 0,
      message: '当前不是拆分完整套仓模式。'
    };
  }
  const hasCompleteInventory = input.pairedGroupCount > 0;
  if (hasCompleteInventory) {
    const plannedSellOrders = pairedStartupOrderCount(input.config, input.venue, input.markets, input.quoteSlots, input.pairedGroupCount);
    return {
      active: true,
      supported: input.venue === 'predict',
      hasCompleteInventory: true,
      canAttempt: false,
      status: 'ready-with-inventory',
      candidatePairs: input.pairedGroupCount,
      conditionReadyPairs: input.pairedGroupCount,
      plannedSellOrders,
      message: '已看到同一市场完整 YES/NO 套仓，下一轮可直接复检双边 SELL。'
    };
  }
  if (input.venue !== 'predict') {
    return {
      active: true,
      supported: false,
      hasCompleteInventory: false,
      canAttempt: false,
      status: 'unsupported',
      candidatePairs: 0,
      conditionReadyPairs: 0,
      plannedSellOrders: 0,
      message: '当前平台未接入自动拆分完整套仓；没有库存时禁止单边进场。'
    };
  }
  const pairStats = splitCandidatePairStats(input.config, input.venue, input.markets);
  if (!input.dataStatus.markets.ok) {
    return {
      active: true,
      supported: true,
      hasCompleteInventory: false,
      canAttempt: false,
      status: 'no-pair',
      candidatePairs: 0,
      conditionReadyPairs: 0,
      plannedSellOrders: 0,
      message: `市场列表不可用，无法确认哪个市场可以拆分完整套仓：${input.dataStatus.markets.message}`
    };
  }
  if (pairStats.candidatePairs === 0) {
    return {
      active: true,
      supported: true,
      hasCompleteInventory: false,
      canAttempt: false,
      status: 'no-pair',
      candidatePairs: 0,
      conditionReadyPairs: 0,
      plannedSellOrders: 0,
      message: '当前候选里没有同时包含 YES/NO 两边的可拆分市场，本轮不应进场。'
    };
  }
  if (pairStats.conditionReadyPairs === 0) {
    return {
      active: true,
      supported: true,
      hasCompleteInventory: false,
      canAttempt: false,
      status: 'condition-missing',
      candidatePairs: pairStats.candidatePairs,
      conditionReadyPairs: 0,
      plannedSellOrders: 0,
      message: '候选市场两边 conditionId 缺失或不一致，不能安全调用链上 split。'
    };
  }
  if (input.targetOrderUsd > input.maxPositionUsd + 1e-9) {
    return {
      active: true,
      supported: true,
      hasCompleteInventory: false,
      canAttempt: false,
      status: 'risk-limit',
      candidatePairs: pairStats.candidatePairs,
      conditionReadyPairs: pairStats.conditionReadyPairs,
      plannedSellOrders: 0,
      estimatedMinimumSplitUsd: roundUsd(input.targetOrderUsd),
      message: `目标单笔 ${fmt(input.targetOrderUsd)} 已超过最大持仓敞口 ${fmt(input.maxPositionUsd)}，不能先拆分。`
    };
  }
  const platformMinimumSplitUsd = 1;
  const estimatedFullOrderSplitUsd = estimateMinimumSplitUsdForStartup(input.config, input.venue, input.markets, input.books);
  if (input.nativeGas && !input.nativeGas.ok) {
    const isFallbackEstimate = input.nativeGas.estimateStatus === 'fallback' || input.nativeGas.requiredSource === 'fallback-estimate';
    const gasMessage = isFallbackEstimate
      ? `${input.nativeGas.message} 这是兜底估算，不再用固定 0.0001 BNB 硬门槛；真实 split 前会按目标市场再次动态估算，余额不足则只跳过拆分。`
      : `${input.nativeGas.message} 普通 REST maker 挂单不需要 BNB；但当前没有完整套仓时，自动拆分这一步会跳过，直到检测到完整 YES/NO 库存或补足链上手续费。`;
    return {
      active: true,
      supported: true,
      hasCompleteInventory: false,
      canAttempt: isFallbackEstimate,
      status: isFallbackEstimate ? 'gas-warning' : 'gas-insufficient',
      candidatePairs: pairStats.candidatePairs,
      conditionReadyPairs: pairStats.conditionReadyPairs,
      plannedSellOrders: isFallbackEstimate ? pairedStartupOrderCount(input.config, input.venue, input.markets, input.quoteSlots, pairStats.conditionReadyPairs) : 0,
      estimatedMinimumSplitUsd: roundUsd(platformMinimumSplitUsd),
      ...(estimatedFullOrderSplitUsd !== undefined ? { estimatedFullOrderSplitUsd: roundUsd(estimatedFullOrderSplitUsd) } : {}),
      gas: input.nativeGas,
      message: gasMessage
    };
  }
  if (platformMinimumSplitUsd > input.maxPositionUsd + 1e-9) {
    return {
      active: true,
      supported: true,
      hasCompleteInventory: false,
      canAttempt: false,
      status: 'risk-limit',
      candidatePairs: pairStats.candidatePairs,
      conditionReadyPairs: pairStats.conditionReadyPairs,
      plannedSellOrders: 0,
      estimatedMinimumSplitUsd: roundUsd(platformMinimumSplitUsd),
      ...(estimatedFullOrderSplitUsd !== undefined ? { estimatedFullOrderSplitUsd: roundUsd(estimatedFullOrderSplitUsd) } : {}),
      message: `Predict 官方拆分最低按 ${fmt(platformMinimumSplitUsd)} 处理，但最大持仓敞口 ${fmt(input.maxPositionUsd)} 不足，不能先拆分。`
    };
  }
  if (input.spendableUsd + 1e-9 < platformMinimumSplitUsd) {
    return {
      active: true,
      supported: true,
      hasCompleteInventory: false,
      canAttempt: false,
      status: 'funds-insufficient',
      candidatePairs: pairStats.candidatePairs,
      conditionReadyPairs: pairStats.conditionReadyPairs,
      plannedSellOrders: 0,
      estimatedMinimumSplitUsd: roundUsd(platformMinimumSplitUsd),
      ...(estimatedFullOrderSplitUsd !== undefined ? { estimatedFullOrderSplitUsd: roundUsd(estimatedFullOrderSplitUsd) } : {}),
      message: `Predict 官方拆分最低按 ${fmt(platformMinimumSplitUsd)} 处理，当前可新增 ${fmt(input.spendableUsd)} 不足。`
    };
  }
  const plannedSellOrders = pairedStartupOrderCount(input.config, input.venue, input.markets, input.quoteSlots, pairStats.conditionReadyPairs);
  const fullOrderHint = estimatedFullOrderSplitUsd === undefined
    ? ''
    : ` 按当前盘口估算，若要每边挂满目标单笔，约需 ${fmt(estimatedFullOrderSplitUsd)} 完整套仓；余额不足时会按实际库存缩小或跳过挂单。`;
  return {
    active: true,
    supported: true,
    hasCompleteInventory: false,
    canAttempt: true,
    status: 'ready-to-split',
    candidatePairs: pairStats.candidatePairs,
    conditionReadyPairs: pairStats.conditionReadyPairs,
    plannedSellOrders,
    estimatedMinimumSplitUsd: roundUsd(platformMinimumSplitUsd),
    ...(estimatedFullOrderSplitUsd !== undefined ? { estimatedFullOrderSplitUsd: roundUsd(estimatedFullOrderSplitUsd) } : {}),
    message: `当前没有可卖库存，但 Predict 可先按平台真实 split 能力拆分完整 YES/NO 套仓，最低按 ${fmt(platformMinimumSplitUsd)} 处理；确认两边库存后预计双边 SELL ${plannedSellOrders} 笔。${fullOrderHint}`
  };
}

function splitCandidatePairStats(config: AppConfig, venue: VenueName, markets: Market[]): { candidatePairs: number; conditionReadyPairs: number } {
  const candidates = discoverRoutableMarkets(config, venue, markets);
  const groups = new Map<string, Market[]>();
  for (const market of candidates) {
    const key = splitCandidateGroupKey(market);
    const list = groups.get(key) ?? [];
    list.push(market);
    groups.set(key, list);
  }
  let candidatePairs = 0;
  let conditionReadyPairs = 0;
  for (const group of groups.values()) {
    if (!hasCompleteOutcomeSet(group)) continue;
    candidatePairs += 1;
    if (completeGroupConditionId(group)) conditionReadyPairs += 1;
  }
  return { candidatePairs, conditionReadyPairs };
}

function estimateMinimumSplitUsdForStartup(
  config: AppConfig,
  venue: VenueName,
  markets: Market[],
  books: Map<string, Orderbook> | undefined
): number | undefined {
  if (!books || books.size === 0) return undefined;
  const candidates = discoverRoutableMarkets(config, venue, markets);
  const groups = new Map<string, Market[]>();
  for (const market of candidates) {
    const key = marketGroupKey(config, market);
    const list = groups.get(key) ?? [];
    list.push(market);
    groups.set(key, list);
  }
  const estimates: number[] = [];
  for (const group of groups.values()) {
    const priced = group
      .map((market) => {
        const book = books.get(market.tokenId);
        const sellPrice = book ? estimatedSellQuotePrice(config, market, book) : undefined;
        if (sellPrice === undefined) return undefined;
        return splitSharesForSell(config, market, sellPrice);
      })
      .filter((value): value is number => value !== undefined && Number.isFinite(value) && value > 0);
    const pricedMarkets = group.filter((market) => books.has(market.tokenId));
    if (hasCompleteOutcomeSet(pricedMarkets) && priced.length >= (expectedOutcomeCount(pricedMarkets) ?? Number.MAX_SAFE_INTEGER)) {
      estimates.push(Math.max(...priced));
    }
  }
  if (estimates.length === 0) return undefined;
  const best = estimates.length > 0 ? Math.min(...estimates) : undefined;
  return best === undefined ? undefined : roundUsd(best);
}

function pairedStartupOrderCount(
  config: AppConfig,
  venue: VenueName,
  markets: Market[],
  quoteSlots: number,
  readyGroupLimit: number | undefined
): number {
  const candidates = discoverRoutableMarkets(config, venue, markets);
  const groups = new Map<string, Market[]>();
  for (const market of candidates) {
    const key = marketGroupKey(config, market);
    const list = groups.get(key) ?? [];
    list.push(market);
    groups.set(key, list);
  }
  let remainingGroups = Math.min(quoteSlots, readyGroupLimit ?? quoteSlots);
  let total = 0;
  for (const group of groups.values()) {
    if (remainingGroups <= 0) break;
    if (!hasCompleteOutcomeSet(group)) continue;
    total += expectedOutcomeCount(group) ?? 0;
    remainingGroups -= 1;
  }
  return total;
}

function splitInventoryOrderCount(
  config: AppConfig,
  groups: ReturnType<typeof completeSetInventoryGroups>,
  quoteSlots: number
): number {
  if (!isPairedEntryMode(config)) return 0;
  const maxTokensPerMarket = config.strategy.maxTokensPerMarket ?? 2;
  return groups.slice(0, Math.max(1, quoteSlots)).reduce((sum, group) => {
    const expected = expectedOutcomeCount(group.markets);
    if (expected === undefined || expected > maxTokensPerMarket) return sum;
    if (group.mergeableShares <= 1e-9) return sum;
    return sum + expected;
  }, 0);
}

function estimatedSellQuotePrice(
  config: AppConfig,
  market: Market,
  book: Orderbook
): number | undefined {
  const level = config.strategy.tradingMode === 'aggressive'
    ? config.strategy.aggressiveDepthLevel
    : config.strategy.conservativeDepthLevel;
  const rawLevel = book.asks[Math.max(0, level - 1)] ?? book.asks.at(-1) ?? book.asks[0];
  if (!rawLevel) return undefined;
  const tick = effectiveOrderbookTick(market, book);
  const bbo = bestBidAsk(book);
  if (bbo.bestBid === undefined) return undefined;
  let price = rawLevel.price + tick * (config.strategy.retreatTicks ?? 0);
  if (market.rewards?.maxSpreadCents) {
    price = Math.min(price, bbo.bestBid + market.rewards.maxSpreadCents / 100);
  }
  price = Math.min(1 - tick, Math.max(tick, roundToTick(price, tick, 'SELL')));
  return isWithinRewardBand('SELL', price, book, market.rewards?.maxSpreadCents) ? price : undefined;
}

function splitSharesForSell(config: AppConfig, market: Market, price: number): number {
  const targetRewardShares = rewardTargetShares(config, market.rewards?.minShares) ?? 0;
  const minRewardNotional = targetRewardShares * price;
  const targetNotional = shouldEnforceRewardMinimum(config)
    ? Math.max(config.risk.orderSizeUsd, minRewardNotional)
    : config.risk.orderSizeUsd;
  return Number((targetNotional / Math.max(price, 0.0001)).toFixed(4));
}

function completeGroupConditionId(markets: Market[]): string | undefined {
  const ids = markets
    .map((market) => market.conditionId?.trim())
    .filter((value): value is string => Boolean(value));
  if (ids.length !== markets.length) return undefined;
  const unique = new Set(ids);
  return unique.size === 1 ? ids[0] : undefined;
}

function splitCandidateGroupKey(market: Market): string {
  return market.marketId || market.eventId || market.conditionId || market.tokenId;
}

function summaryText(
  readyToQuote: boolean,
  expected: StartupFacts['expected'],
  buy: StartupSideFact,
  sell: StartupSideFact,
  blockingReasons: string[]
): string {
  if (!readyToQuote) return `现在不应新增挂单：${blockingReasons[0] ?? '启动条件不完整'}`;
  if (sell.requested && sell.status === 'conditional' && expected.sellOrders > 0 && buy.requested === false) {
    return `按当前事实，下一轮预计双边 SELL ${expected.sellOrders} 笔。${sell.reason}`;
  }
  const sellSuffix = sell.requested && sell.status === 'skipped' ? `；${sell.reason}` : '';
  return `按当前事实，下一轮预计实际挂单：BUY ${expected.buyOrders} 笔 / SELL ${expected.sellOrders} 笔，总计 ${expected.totalOrders} 笔。${sellSuffix || buy.reason}`;
}

function roundUsd(value: number): number {
  return Number((Number.isFinite(value) ? value : 0).toFixed(4));
}

function fmt(value: number): string {
  return `$${roundUsd(value).toFixed(2)}`;
}
