import { createInterface } from 'node:readline/promises';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { appConfigSchema, type AppConfig } from '../config/schema.js';

interface Questioner {
  question(prompt: string): Promise<string>;
  close(): void;
}

type RiskPreset = 'test' | 'small' | 'standard';

const RISK_PRESETS: Record<RiskPreset, { label: string; risk: AppConfig['risk'] }> = {
  test: {
    label: 'test - 最小测试档，第一次推荐',
    risk: {
      orderSizeUsd: 5,
      maxSingleOrderUsd: 5,
      maxPositionUsd: 20,
      maxDailyLossUsd: 10,
      maxAccountRiskStaleMs: 120000,
      maxOpenOrderReserveDriftUsd: 2,
      maxOpenOrderReserveDriftPct: 25,
      settlementNoNewOrdersMs: 1800000,
      settlementCancelOpenOrdersMs: 600000,
      shortEventMaxDurationMs: 43200000,
      eventStartNoNewOrdersMs: 1800000,
      eventStartCancelOpenOrdersMs: 600000,
      blockUnknownEndTime: true,
      maxBboMoveCents: 2,
      maxSpreadMoveBps: 150,
      maxOpenOrdersPerMarket: 2,
      maxMarkets: 1,
      staleBookMs: 2000,
      minDepthUsdPerSide: 25,
      minPrice: 0.08,
      maxPrice: 0.92,
      minSpreadBps: 0,
      maxSpreadBps: 600,
      requirePostOnly: true
    }
  },
  small: {
    label: 'small - 小额实盘准备档',
    risk: {
      orderSizeUsd: 10,
      maxSingleOrderUsd: 10,
      maxPositionUsd: 50,
      maxDailyLossUsd: 20,
      maxAccountRiskStaleMs: 120000,
      maxOpenOrderReserveDriftUsd: 2,
      maxOpenOrderReserveDriftPct: 25,
      settlementNoNewOrdersMs: 1800000,
      settlementCancelOpenOrdersMs: 600000,
      shortEventMaxDurationMs: 43200000,
      eventStartNoNewOrdersMs: 1800000,
      eventStartCancelOpenOrdersMs: 600000,
      blockUnknownEndTime: true,
      maxBboMoveCents: 2,
      maxSpreadMoveBps: 150,
      maxOpenOrdersPerMarket: 2,
      maxMarkets: 2,
      staleBookMs: 2000,
      minDepthUsdPerSide: 25,
      minPrice: 0.08,
      maxPrice: 0.92,
      minSpreadBps: 0,
      maxSpreadBps: 600,
      requirePostOnly: true
    }
  },
  standard: {
    label: 'standard - 默认保守档，不建议第一次 live 直接用',
    risk: {
      orderSizeUsd: 25,
      maxSingleOrderUsd: 25,
      maxPositionUsd: 100,
      maxDailyLossUsd: 50,
      maxAccountRiskStaleMs: 120000,
      maxOpenOrderReserveDriftUsd: 2,
      maxOpenOrderReserveDriftPct: 25,
      settlementNoNewOrdersMs: 1800000,
      settlementCancelOpenOrdersMs: 600000,
      shortEventMaxDurationMs: 43200000,
      eventStartNoNewOrdersMs: 1800000,
      eventStartCancelOpenOrdersMs: 600000,
      blockUnknownEndTime: true,
      maxBboMoveCents: 2,
      maxSpreadMoveBps: 150,
      maxOpenOrdersPerMarket: 4,
      maxMarkets: 3,
      staleBookMs: 2000,
      minDepthUsdPerSide: 25,
      minPrice: 0.08,
      maxPrice: 0.92,
      minSpreadBps: 0,
      maxSpreadBps: 600,
      requirePostOnly: true
    }
  }
};

export async function runGuidedInit(base: AppConfig, configExists: boolean): Promise<AppConfig> {
  const rl = createQuestioner();
  try {
    console.log('');
    console.log('Safe Market Maker 中文初始化向导');
    console.log('按 Enter 使用括号里的默认值。这个向导不会导入私钥，也不会替你授权。');
    console.log(configExists ? '检测到已有 config.yaml：本向导会按你的回答更新配置文件。' : '未检测到 config.yaml：本向导会创建新的配置文件。');

    const dataDir = await askText(rl, 'dataDir', base.dataDir, '本地数据目录，保存 SQLite、加密钱包 keystore、平台凭据。一般保持 .safe-mm。');
    const venueChoice = await askChoice(rl, '启用哪个平台', ['predict', 'polymarket', 'both'], defaultVenueChoice(base), '只想先测一个平台就选对应平台；不确定就选 both。');
    const predictEnabled = venueChoice === 'predict' || venueChoice === 'both';
    const polymarketEnabled = venueChoice === 'polymarket' || venueChoice === 'both';

    const endpointPolicy = {
      allowCustom: await askBoolean(rl, 'endpointPolicy.allowCustom', base.endpointPolicy.allowCustom, '是否允许非默认 API/RPC endpoint。默认 false 更安全。'),
      extraAllowedHosts: base.endpointPolicy.extraAllowedHosts
    };
    if (endpointPolicy.allowCustom) {
      endpointPolicy.extraAllowedHosts = parseList(await askText(rl, 'endpointPolicy.extraAllowedHosts', endpointPolicy.extraAllowedHosts.join(','), '额外允许的 endpoint origin，逗号分隔，例如 https://example-rpc.com。'));
    } else {
      endpointPolicy.extraAllowedHosts = [];
    }

    const venues = {
      predict: {
        ...base.venues.predict,
        enabled: predictEnabled
      },
      polymarket: {
        ...base.venues.polymarket,
        enabled: polymarketEnabled
      }
    };

    if (predictEnabled) {
      console.log('');
      console.log('Predict.fun 参数');
      venues.predict.apiBaseUrl = await askText(rl, 'venues.predict.apiBaseUrl', venues.predict.apiBaseUrl, 'Predict.fun API 地址。默认官方地址即可。');
      venues.predict.wsUrl = await askText(rl, 'venues.predict.wsUrl', venues.predict.wsUrl, 'Predict.fun WebSocket 地址。盘口实时监听使用，默认官方地址即可。');
      venues.predict.rpcUrl = await askText(rl, 'venues.predict.rpcUrl', venues.predict.rpcUrl, 'BSC RPC 地址。默认官方公共 RPC 即可。');
      venues.predict.chainId = await askNumber(rl, 'venues.predict.chainId', venues.predict.chainId, '链 ID。Predict.fun 当前默认是 BSC 主网 56。', 1);
      venues.predict.apiKey = await askStoredText(rl, 'venues.predict.apiKey', venues.predict.apiKey, 'Predict.fun API key。不是钱包私钥；会明文保存在 config.yaml，不确定可先留空。');
      venues.predict.accountAddress = await askAddressText(rl, 'venues.predict.accountAddress', venues.predict.accountAddress, 'Predict 平台账户地址或代理账户地址。没有就留空。');
    }

    if (polymarketEnabled) {
      console.log('');
      console.log('Polymarket 参数');
      venues.polymarket.gammaUrl = await askText(rl, 'venues.polymarket.gammaUrl', venues.polymarket.gammaUrl, 'Polymarket Gamma 市场 API。默认官方地址即可。');
      venues.polymarket.clobUrl = await askText(rl, 'venues.polymarket.clobUrl', venues.polymarket.clobUrl, 'Polymarket CLOB API。默认官方地址即可。');
      venues.polymarket.chainId = await askNumber(rl, 'venues.polymarket.chainId', venues.polymarket.chainId, '链 ID。Polymarket 当前默认是 Polygon 主网 137。', 1);
      venues.polymarket.funderAddress = await askAddressText(rl, 'venues.polymarket.funderAddress', venues.polymarket.funderAddress, 'Polymarket 资金地址。普通钱包通常留空；代理钱包才需要填。');
      venues.polymarket.signatureType = await askNumber(rl, 'venues.polymarket.signatureType', venues.polymarket.signatureType, '签名类型。普通 EOA 通常是 0；代理钱包按平台要求填 1 或 2。', 0, 2);
      venues.polymarket.autoDeriveApiKey = await askBoolean(rl, 'venues.polymarket.autoDeriveApiKey', venues.polymarket.autoDeriveApiKey, '是否认证时自动派生 CLOB API key。通常保持 true。');
    }

    const preset = await askChoice(rl, '风控预设', Object.keys(RISK_PRESETS) as RiskPreset[], 'test', '第一次建议 test。之后可以重新运行向导改成 small 或 standard。');
    const presetRisk = RISK_PRESETS[preset].risk;
    const risk = {
      ...base.risk,
      ...presetRisk
    };

    console.log('');
    console.log(`风控参数，当前使用 ${RISK_PRESETS[preset].label}`);
    risk.orderSizeUsd = await askNumber(rl, 'risk.orderSizeUsd', risk.orderSizeUsd, '每笔订单目标金额，单位 USD。第一次建议 5。', 0.01);
    risk.maxSingleOrderUsd = await askNumber(rl, 'risk.maxSingleOrderUsd', risk.maxSingleOrderUsd, '单笔订单最大金额，必须大于等于 orderSizeUsd。', risk.orderSizeUsd);
    risk.maxPositionUsd = await askNumber(rl, 'risk.maxPositionUsd', risk.maxPositionUsd, '单市场或单 token 最大风险敞口。第一次建议 20 左右。', risk.maxSingleOrderUsd);
    risk.maxDailyLossUsd = await askNumber(rl, 'risk.maxDailyLossUsd', risk.maxDailyLossUsd, '每日亏损上限。触发后应停止并撤单。', 0.01);
    risk.maxAccountRiskStaleMs = await askNumber(rl, 'risk.maxAccountRiskStaleMs', risk.maxAccountRiskStaleMs, '账户级成交/仓位/权益风控快照超过多久视为过期。默认 120000。', 1000);
    risk.maxOpenOrderReserveDriftUsd = await askNumber(rl, 'risk.maxOpenOrderReserveDriftUsd', risk.maxOpenOrderReserveDriftUsd, '开放订单估算占用和平台冻结余额允许偏差 USD。默认 2。', 0);
    risk.maxOpenOrderReserveDriftPct = await askNumber(rl, 'risk.maxOpenOrderReserveDriftPct', risk.maxOpenOrderReserveDriftPct, '开放订单估算占用和平台冻结余额允许偏差百分比。默认 25。', 0);
    risk.settlementNoNewOrdersMs = await askNumber(rl, 'risk.settlementNoNewOrdersMs', risk.settlementNoNewOrdersMs, '距离市场结束多久停止新增挂单。默认 1800000，即 30 分钟。', 0);
    risk.settlementCancelOpenOrdersMs = await askNumber(rl, 'risk.settlementCancelOpenOrdersMs', risk.settlementCancelOpenOrdersMs, '距离市场结束多久撤掉机器人管理的旧单。默认 600000，即 10 分钟。', 0);
    risk.shortEventMaxDurationMs = await askNumber(rl, 'risk.shortEventMaxDurationMs', risk.shortEventMaxDurationMs, '开始到结束小于该时长的市场按短时赛事/事件处理。默认 43200000，即 12 小时。设 0 可关闭开赛保护。', 0);
    risk.eventStartNoNewOrdersMs = await askNumber(rl, 'risk.eventStartNoNewOrdersMs', risk.eventStartNoNewOrdersMs, '短时赛事/事件开始前多久停止新增挂单。默认 1800000，即 30 分钟。', 0);
    risk.eventStartCancelOpenOrdersMs = await askNumber(rl, 'risk.eventStartCancelOpenOrdersMs', risk.eventStartCancelOpenOrdersMs, '短时赛事/事件开始前多久撤掉机器人管理的旧单。默认 600000，即 10 分钟。', 0);
    risk.blockUnknownEndTime = await askBoolean(rl, 'risk.blockUnknownEndTime', risk.blockUnknownEndTime, '市场没有明确结束时间时是否禁止新增挂单。实盘建议 true。');
    risk.maxBboMoveCents = await askNumber(rl, 'risk.maxBboMoveCents', risk.maxBboMoveCents, '下单前复查时，BBO 中位价较生成报价时最多允许移动多少 cents。默认 2。', 0.01);
    risk.maxSpreadMoveBps = await askNumber(rl, 'risk.maxSpreadMoveBps', risk.maxSpreadMoveBps, '两次盘口扫描之间价差突变超过多少 bps 就视为不安全。默认 150。', 0.01);
    risk.maxOpenOrdersPerMarket = await askNumber(rl, 'risk.maxOpenOrdersPerMarket', risk.maxOpenOrdersPerMarket, '每个市场最多开放订单数。第一次建议 2。', 1);
    risk.maxMarkets = await askNumber(rl, 'risk.maxMarkets', risk.maxMarkets, '最多同时做市市场数量。现金单边测试建议先 20，稳定后再逐步增加。', 1);
    risk.staleBookMs = await askNumber(rl, 'risk.staleBookMs', risk.staleBookMs, '最终复检盘口超过多少毫秒视为过期，过期不下单。默认 2000。', 1);
    risk.minDepthUsdPerSide = await askNumber(rl, 'risk.minDepthUsdPerSide', risk.minDepthUsdPerSide, '每侧最小盘口深度，太薄不下单。默认 25。', 0);
    risk.minPrice = await askNumber(rl, 'risk.minPrice', risk.minPrice, '最低报价价格，避免极端低价市场。范围 0 到 1。', 0, 1);
    risk.maxPrice = await askNumber(rl, 'risk.maxPrice', risk.maxPrice, '最高报价价格，避免极端高价市场。范围 0 到 1。', risk.minPrice, 1);
    risk.minSpreadBps = await askNumber(rl, 'risk.minSpreadBps', risk.minSpreadBps, '最小价差，单位 bps。PP maker 单默认不靠最小价差硬阻断，默认 0。', 0);
    risk.maxSpreadBps = await askNumber(rl, 'risk.maxSpreadBps', risk.maxSpreadBps, '最大价差，单位 bps。过宽通常说明流动性差。', risk.minSpreadBps);
    risk.requirePostOnly = await askBoolean(rl, 'risk.requirePostOnly', risk.requirePostOnly, '是否要求 post-only 风格，避免主动吃单。建议 true。');

    console.log('');
    console.log('策略参数');
    const tradingMode = await askChoice(rl, 'strategy.tradingMode', ['conservative', 'aggressive'], base.strategy.tradingMode, 'conservative 更保守；aggressive 更靠前，第一次建议 conservative。');
    const strategy = {
      ...base.strategy,
      optimizerMode: 'points' as const,
      tradingMode,
      pointsOnly: await askBoolean(rl, 'strategy.pointsOnly', base.strategy.pointsOnly, '是否优先只做有积分或奖励的市场。建议 true。'),
      acceptingOnly: await askBoolean(rl, 'strategy.acceptingOnly', base.strategy.acceptingOnly, '是否只做开放可交易市场。建议 true。'),
      minMarketLiquidityUsd: await askNumber(rl, 'strategy.minMarketLiquidityUsd', base.strategy.minMarketLiquidityUsd, '现金单边按实时奖励带竞争资金排序，默认 0，不用总流动性过滤低竞争 FDV 市场。', 0),
      minRewardLevel: await askNumber(rl, 'strategy.minRewardLevel', base.strategy.minRewardLevel, '最低 LP 奖励等级。现金单边推文策略默认 0，由官方当前 PP 和奖励带深度决定排序。', 0, 5),
      minRewardSizeMultiplier: await askNumber(rl, 'strategy.minRewardSizeMultiplier', base.strategy.minRewardSizeMultiplier, '奖励最低份额倍数。1 表示按平台最低份额，2 表示挂两倍最低份额。', 0.1, 10),
      dualSide: await askBoolean(rl, 'strategy.dualSide', base.strategy.dualSide, '是否同时考虑双边报价。现金单边推文策略建议 false；split 模式会自动成组双边。'),
      quoteRefreshMs: await askNumber(rl, 'strategy.quoteRefreshMs', base.strategy.quoteRefreshMs, '盘口扫描和撤换单间隔，单位毫秒。默认 2000。低于 1000 容易触发 API 限流。', 1000),
      marketRefreshMs: await askNumber(rl, 'strategy.marketRefreshMs', base.strategy.marketRefreshMs, '市场列表缓存刷新间隔，单位毫秒。默认 60000，避免每轮全量扫描。', 10000),
      conservativeDepthLevel: await askNumber(rl, 'strategy.conservativeDepthLevel', base.strategy.conservativeDepthLevel, '保守档参考盘口深度层级；现金单边会额外要求至少 3 档前方保护，并参考第 4 档支撑报价。', 1),
      aggressiveDepthLevel: await askNumber(rl, 'strategy.aggressiveDepthLevel', base.strategy.aggressiveDepthLevel, '激进档参考盘口深度层级，数值越小越靠前。默认 3。', 1),
      retreatTicks: await askNumber(rl, 'strategy.retreatTicks', base.strategy.retreatTicks, '从目标价后退几个 tick，降低主动成交风险。默认 1。', 0),
      replaceThresholdTicks: await askNumber(rl, 'strategy.replaceThresholdTicks', base.strategy.replaceThresholdTicks, '目标报价移动超过几个 tick 就撤旧单换新单。默认 1。', 0),
      cancelOutsideReward: await askBoolean(rl, 'strategy.cancelOutsideReward', base.strategy.cancelOutsideReward, '订单或市场不再符合奖励规则时，是否自动撤掉机器人管理的旧单。建议 true。'),
      onFillAction: await askChoice(rl, 'strategy.onFillAction', ['hold', 'sellAllAtMarket'], base.strategy.onFillAction, '成交后动作。hold 持有完整套仓继续做市；sellAllAtMarket 当前仅表示完整 YES/NO 套仓合并退出，不用市价卖出替代。'),
      cashOnFillAction: await askChoice(rl, 'strategy.cashOnFillAction', ['hold', 'sellWithinLossCap'], base.strategy.cashOnFillAction, 'cash 单边被吃后动作。sellWithinLossCap 会在亏损上限内发 SELL taker 限价退出。'),
      cashMaxExitLossPct: await askNumber(rl, 'strategy.cashMaxExitLossPct', base.strategy.cashMaxExitLossPct, 'cash 单边被吃后，只有 SELL 退出价仍在该亏损上限内才提交卖单；30 表示最低卖价为持仓均价的 70%。', 0, 100),
      liquidationSlippageTicks: await askNumber(rl, 'strategy.liquidationSlippageTicks', base.strategy.liquidationSlippageTicks, '旧市价卖出参数，当前 split 实盘退出不使用。默认 2。', 0),
      liquidationMaxSlippageCents: await askNumber(rl, 'strategy.liquidationMaxSlippageCents', base.strategy.liquidationMaxSlippageCents, '旧市价卖出参数，当前完整套仓退出走合并。默认 10。', 0.01, 99),
      minPositionSizeToLiquidate: await askNumber(rl, 'strategy.minPositionSizeToLiquidate', base.strategy.minPositionSizeToLiquidate, '低于多少份的完整套仓不触发合并退出。默认 0.0001。', 0.0001),
      balanceReserveUsd: await askNumber(rl, 'strategy.balanceReserveUsd', base.strategy.balanceReserveUsd, '自动挂单前预留不用的余额，单位 USD；现金单边要给成交保护和重挂留缓冲。', 0),
      inventorySkewEnabled: await askBoolean(rl, 'strategy.inventorySkewEnabled', base.strategy.inventorySkewEnabled, '是否开启偏仓保护。现金单边成交后会触发持仓保护，默认 false。'),
      maxInventorySkewUsd: await askNumber(rl, 'strategy.maxInventorySkewUsd', base.strategy.maxInventorySkewUsd, '单 token 最大偏仓，达到后停止继续买入。', 0.01),
      dedupeMarketGroups: await askBoolean(rl, 'strategy.dedupeMarketGroups', base.strategy.dedupeMarketGroups, '是否按赛事/问题分组去重，避免资金集中在一个市场。建议 true。'),
      maxTokensPerMarket: await askNumber(rl, 'strategy.maxTokensPerMarket', base.strategy.maxTokensPerMarket, '同一个市场分组最多选几个 outcome token。默认 2。', 1)
    };

    const selectedMarkets = {
      predict: predictEnabled ? [...base.selectedMarkets.predict] : [],
      polymarket: polymarketEnabled ? [...base.selectedMarkets.polymarket] : []
    };
    if (await askBoolean(rl, '是否现在手动填写 selectedMarkets', false, '通常先留空，稍后用 recommend --apply 自动写入。')) {
      if (predictEnabled) selectedMarkets.predict = parseList(await askText(rl, 'selectedMarkets.predict', selectedMarkets.predict.join(','), 'Predict token id，逗号分隔。'));
      if (polymarketEnabled) selectedMarkets.polymarket = parseList(await askText(rl, 'selectedMarkets.polymarket', selectedMarkets.polymarket.join(','), 'Polymarket token id，逗号分隔。'));
    }

    const liveEnabled = await askLiveEnabled(rl);

    const config = appConfigSchema.parse({
      dataDir,
      liveEnabled,
      endpointPolicy,
      risk,
      strategy,
      venues,
      selectedMarkets
    });

    console.log('');
    console.log('配置向导完成。建议下一步先导入钱包、完成平台认证、应用推荐市场，再用实盘预检检查。');
    return config;
  } finally {
    rl.close();
  }
}

function defaultVenueChoice(config: AppConfig): 'predict' | 'polymarket' | 'both' {
  if (config.venues.predict.enabled && config.venues.polymarket.enabled) return 'both';
  if (config.venues.polymarket.enabled) return 'polymarket';
  return 'predict';
}

function createQuestioner(): Questioner {
  if (!process.stdin.isTTY) {
    const answers = readFileSync(0, 'utf8').split(/\r?\n/);
    let index = 0;
    return {
      async question(prompt: string) {
        process.stdout.write(prompt);
        const answer = answers[index++] ?? '';
        process.stdout.write(`${answer}\n`);
        return answer;
      },
      close() {
        return undefined;
      }
    };
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return {
    question(prompt: string) {
      return rl.question(prompt);
    },
    close() {
      rl.close();
    }
  };
}

async function askText(rl: Questioner, name: string, defaultValue: string, help: string): Promise<string> {
  console.log('');
  console.log(`${name}: ${help}`);
  const answer = (await rl.question(`${name} [${defaultValue || '留空'}]: `)).trim();
  return answer || defaultValue;
}

async function askStoredText(rl: Questioner, name: string, existingValue: string, help: string): Promise<string> {
  console.log('');
  console.log(`${name}: ${help}`);
  const suffix = existingValue ? 'Enter 保留现有值；输入 clear 清空；或输入新值' : '可留空；或输入新值';
  const answer = (await rl.question(`${name} [${suffix}]: `)).trim();
  if (!answer) return existingValue;
  if (answer.toLowerCase() === 'clear') return '';
  return answer;
}

async function askAddressText(rl: Questioner, name: string, defaultValue: string, help: string): Promise<string> {
  while (true) {
    const value = await askText(rl, name, defaultValue, help);
    if (!value || /^0x[a-fA-F0-9]{40}$/.test(value)) return value;
    console.log('地址格式不正确。应为 0x 开头的 40 位十六进制地址；如果没有就留空。');
  }
}

async function askChoice<T extends string>(rl: Questioner, name: string, choices: readonly T[], defaultValue: T, help: string): Promise<T> {
  const allowed = new Set<string>(choices);
  while (true) {
    console.log('');
    console.log(`${name}: ${help}`);
    console.log(`可选值: ${choices.join(' / ')}`);
    const answer = (await rl.question(`${name} [${defaultValue}]: `)).trim() || defaultValue;
    if (allowed.has(answer)) return answer as T;
    console.log(`无效选项：${answer}`);
  }
}

async function askBoolean(rl: Questioner, name: string, defaultValue: boolean, help: string): Promise<boolean> {
  while (true) {
    console.log('');
    console.log(`${name}: ${help}`);
    const hint = defaultValue ? 'Y/n' : 'y/N';
    const answer = (await rl.question(`${name} [${hint}]: `)).trim().toLowerCase();
    if (!answer) return defaultValue;
    if (['y', 'yes', 'true', '1', '是'].includes(answer)) return true;
    if (['n', 'no', 'false', '0', '否'].includes(answer)) return false;
    console.log('请输入 y 或 n。');
  }
}

async function askNumber(rl: Questioner, name: string, defaultValue: number, help: string, min?: number, max?: number): Promise<number> {
  while (true) {
    console.log('');
    console.log(`${name}: ${help}`);
    const answer = (await rl.question(`${name} [${defaultValue}]: `)).trim();
    const value = answer ? Number(answer) : defaultValue;
    if (Number.isFinite(value) && (min === undefined || value >= min) && (max === undefined || value <= max)) return value;
    const range = min !== undefined && max !== undefined ? `${min} 到 ${max}` : min !== undefined ? `大于等于 ${min}` : max !== undefined ? `小于等于 ${max}` : '有效数字';
    console.log(`请输入${range}。`);
  }
}

async function askLiveEnabled(rl: Questioner): Promise<boolean> {
  const wantsLive = await askBoolean(rl, 'liveEnabled', false, '是否在初始配置里打开实盘总开关。第一次配置强烈建议 false。');
  if (!wantsLive) return false;
  console.log('');
  console.log('开启 liveEnabled 只是打开总开关，不会绕过 --confirm LIVE、预检、钱包和授权检查。');
  const phrase = (await rl.question('如果你确认要打开，请输入 ENABLE_LIVE_INIT；其他输入都会保持 false: ')).trim();
  if (phrase === 'ENABLE_LIVE_INIT') return true;
  console.log('未输入确认短语，liveEnabled 保持 false。');
  return false;
}

function parseList(value: string): string[] {
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}
