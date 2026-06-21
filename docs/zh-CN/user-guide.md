# 积分收益优化机器人中文使用说明

这份说明对应 2026-06-06 的本机实盘控制台版本：程序运行时只提供实盘路径，测试代码使用 mock，不会作为用户模式暴露。

请先记住三条规则：

- 私钥不写进 `config.yaml`，也不要发到聊天里。第一次启动 UI 时可从 `SAFE_MM_PREDICT_PRIVATE_KEY`、`SAFE_MM_POLYMARKET_PRIVATE_KEY` 或 `SAFE_MM_PRIVATE_KEY` 读取，程序会自动本机加密保存。
- UI 主界面只负责自动做市实盘控制、市场池和诊断；手动买卖不再作为主导航入口。
- 实盘不会一键裸奔，UI 必须通过配置、签名、凭据、市场、授权/余额和风控预检；CLI 仍保留命令行确认参数。

Polymarket 当前接入官方 CLOB V2，主网结算资产是 Polygon 上的 pUSD。全新 EOA 钱包使用 `signatureType: 0`、`funderAddress: ""` 即可自动派生 nonce 0 的 CLOB 凭据，不需要先去网页挂单。预检会阻断完整受限/close-only 地区、POL gas 不足、pUSD 余额不足、V2 普通/Neg-Risk 交易所授权不足或开放订单同步失败。官方把日本列为仅前端 UI 受限，因此程序还会读取认证 CLOB 的 `closed_only` 状态，只有明确为 `false` 才允许 API 交易。

## 这个机器人现在优化什么

当前目标不是“随便挂买卖单”，而是“尽量把资金放到能拿积分/LP 奖励的位置”：

1. 先筛选有积分/奖励规则的市场。
2. 按平台分别判断奖励等级、最低份额、允许价差、Boost 或 daily rewards rate。
3. 只在订单仍处于奖励价差窗口内时保留订单。
4. 当盘口移动导致旧单不再符合奖励规则，或目标价移动超过设定 tick，就撤旧单换新单。
5. 余额、单笔上限、持仓上限、开放订单数、盘口新鲜度和 post-only 风控仍然优先于收益。
6. UI 只展示真实状态，不伪造盘口或成交；`/api/live/status` 只反映当前实盘循环状态和最近错误。

Predict.fun 和 Polymarket 已拆成两个独立积分模块：

| 平台 | 模块关注点 | 为什么不同 |
| --- | --- | --- |
| Predict.fun | pp 星级、Boost、最低奖励份额、奖励价差窗口、盘口深度 | Predict 的积分更偏活动/等级和 Boost 市场，网页上的 pp 星级很关键 |
| Polymarket | daily rewards rate、min size、max spread、队列深度、neg-risk | Polymarket 的 Rewards 更看每日奖励权重、最小订单规模和 CLOB 队列风险 |

## 自动挂单流程

每一轮自动做市会按下面流程走：

1. 同步账户级风控快照：平台成交、仓位、余额和权益。快照不可用、过期或缺少可验证的本轮 PnL/权益字段时，本轮禁止新增挂单。
2. 同步远端开放订单，写入 SQLite，本地先知道现在还有哪些单挂着。
3. 同步持仓和余额。余额太低时不会继续下单，只写入审计事件。
4. 如果 `autoSelectMarkets: true`，从实时市场列表里挑出候选市场；如果是手动模式，则只使用 `selectedMarkets`。
5. 由 `MarketDataSyncService` 拉取候选 token 的盘口；某个盘口不可用时跳过该市场并记录 `ORDERBOOK_UNAVAILABLE`，不会用旧数据或虚拟盘口补齐。
6. 运行 PP 路由器。现金单边模式按官方 PP/hr、同一市场组 YES/NO 在当前挂单方向的奖励带总竞争资金、101 份目标订单金额计算 PP/hr/kUSD 资金效率；split 双边 SELL 模式才把同一 YES/NO 市场组相加成 `groupExpectedPP`。
7. 现金单边模式维护一个多市场挂单篮子，不做 split/merge，也不做旧式单池换池；篮子按资金效率从高到低滚动，篮子外的机器人旧单会撤，篮子内的旧单按盘口保护继续维护。split 模式才比较当前完整套仓市场组和全局最优完整市场组，并把 gas、剩余安全时间和换池收益门槛纳入判断。
8. 对 Predict.fun 或 Polymarket 分别运行平台专用优化器，生成目标买单/卖单。
9. 当前推荐实盘入口是 Predict.fun cash 单边 BUY：普通 maker 挂单是 REST 签名订单，不需要 BNB，也不会自动 split/merge。若启用 split 模式，Predict.fun 会先按 SDK split 能力尝试拆出完整 YES/NO 套仓；有完整套仓后只挂双边 SELL maker，split/merge 是链上交易，需要签名钱包有少量 BNB 付手续费。
10. 由 `CancelService` 检查旧单：
   - 旧单仍在奖励价差窗口内，价格也没偏太多：保留。
   - 旧单已经不符合奖励规则、市场不再入选、目标价移动超过 `replaceThresholdTicks`、或自动路由切到更好市场：撤单。
11. 对新目标订单做风控：盘口是否过期、是否穿越 BBO、单笔/持仓/开放订单是否超限、订单数量是否满足奖励最低份额。
12. 下单前再次拉最新盘口。PP maker 订单会先用最新盘口重新计算一次最终安全报价，再做最终风控复检；避免提交几秒前已经变得太靠前的旧价格。
13. 提交成功后立刻回读平台开放订单。只有平台开放订单里能看到同一个订单且价格一致，UI/账本才把它当作已确认 OPEN；如果回读不到或价格不一致，会标记为需要核验，等待下一轮远端订单同步纠正。
14. 记录当前目标市场、订单、拒单原因、撤单原因和运行指标。

## 结算和开赛保护

机器人拿 PP 的前提是尽量不成交，所以时间风险比 PP 数字优先级更高。市场有三类时间会参与判断：

- `endTime`：平台能提供的最早可验证结束/停止交易时间。未知时按 `blockUnknownEndTime: true` 阻断新增挂单。
- `reward-end`：积分活动结束时间，只说明 PP 奖励到什么时候，不等于市场事件安全结束时间。
- `startTime`：事件开始时间。体育、电竞、比赛、会议、发布会这类短时事件，开始后概率和盘口会突然变，不能只看 reward-end。

短时事件保护的通用规则是：如果 `startTime` 到 `endTime` 的跨度小于 `shortEventMaxDurationMs`，就按事件盘处理。事件已经开始、临近开始停新单窗口、或开始前撤单窗口都会被 MarketGuard 拦截。这样不需要维护体育/电竞黑名单，也能覆盖很多“开赛/开奖/发布前后突然变盘”的市场。

默认建议：

| 参数 | 默认含义 |
| --- | --- |
| `shortEventMaxDurationMs` | 小于这个持续时长的市场按短时事件处理，默认 12 小时 |
| `eventStartNoNewOrdersMs` | 开始前 30 分钟停止新增 maker 单 |
| `eventStartCancelOpenOrdersMs` | 开始前 10 分钟撤掉机器人开放订单 |
| `settlementNoNewOrdersMs` | 距离结束少于 30 分钟停止新增 maker 单 |
| `settlementCancelOpenOrdersMs` | 距离结束少于 10 分钟撤掉机器人开放订单 |

高 PP 的短时比赛盘如果已经开赛，或者离开赛太近，即使奖励还在、盘口还有深度，也会被跳过或撤单。这是为了避免“为了 PP 排到危险位置，结果被突发行情吃单”。

“挂单结束”不是按时间结束，而是由状态决定：

- 点击“停止”：不再启动下一轮，但已挂订单不会自动撤。
- 点击“停止并撤单”或“紧急撤单”：停止并撤掉开放订单。
- 市场不再符合积分筛选或订单离开奖励范围：下一轮自动撤掉机器人管理的旧单。
- 自动路由发现更高资金效率的安全 PP 市场：现金单边模式会按挂单篮子滚动撤换；split 模式只有优势覆盖门槛时才迁移完整套仓目标。
- 余额不足、风控拒绝、盘口过期、API 错误：该轮跳过或进入错误状态。

## API 限额和扫描间隔

机器人现在有两层 API 保护：

- HTTP 请求按 origin 做轻量节流，默认同一 API 域名请求之间至少间隔约 120ms。
- 市场列表使用 `marketRefreshMs` 缓存，默认 60000ms，不会每一轮都全量扫描市场。

一轮大概会调用：

- 开放订单 1 次
- 持仓 1 次
- 余额 1 次
- 市场列表按缓存刷新，不是每轮都刷新；自动路由会全量读取官方合格 metadata，再按 active/hot/explore 分层读取盘口
- 每个入选 token 盘口 1 次
- 每个准备提交的订单再做 1 次最终盘口复检
- 需要撤换时额外调用撤单和下单接口

建议：

- 只做 1-3 个市场：`quoteRefreshMs` 设 8000 到 15000。
- 市场列表：`marketRefreshMs` 设 60000 到 180000。
- 如果看到 429、HTTP 频率限制、盘口响应变慢，把 `quoteRefreshMs` 提高到 15000 或 30000。
- 不建议低于 3000ms，除非你确认平台 API 允许且市场数量非常少。

旧单替换的确认条件：

- 目标价移动超过 `replaceThresholdTicks`。
- 旧单已经不在平台奖励允许价差内。
- 该市场不再满足积分筛选。
- 当前挂单方向不再需要，例如你从双边改成只挂买单。

所有替换都会写入 SQLite 事件：`quote.replace-cancel`，里面有订单 ID、token、方向和撤换原因。

## 成交和退出怎么处理

默认配置：

```yaml
strategy:
  onFillAction: hold
```

意思是：不会自动市价卖出。现金单边模式如果同步到任何 Predict 持仓，会触发成交保护并撤销机器人受管挂单；持仓消失后继续扫描和挂单，只有本轮总止损金额触发时才会停止实盘并等待手动重新开启。split 模式下，完整 YES/NO 库存本来就是挂双边 SELL 的库存。

如果手动配置：

```yaml
strategy:
  onFillAction: sellAllAtMarket
```

这个名字保留旧配置兼容，但当前含义已经改成“完整套仓合并退出”。下一轮同步持仓时，只有同一市场存在等量 YES/NO 完整套仓，才会尝试合并回 USDT。

退出流程：

1. 找到同一 `conditionId` 下完整 YES/NO 套仓。
2. 计算两边都持有的最小等量份额，例如 YES 10 份、NO 8 份，只能合并 8 份。
3. 先撤掉这个市场组里机器人管理的开放 SELL 单。
4. 调用 Predict.fun SDK `mergePositions`，把等量完整套仓合并回 USDT。
5. 如果只有单边仓位，或者 YES/NO 数量不等导致残余单边，机器人不会市价卖出残余仓位，只记录 `fill.merge-not-ready` 等待人工判断或下一轮同步。
6. Polymarket 当前没有接入完整套仓合并退出；预检和执行层都会阻断该退出动作。
7. 这一轮退出后不会继续挂新的积分单，避免刚合并又进场。

UI 的紧急撤单和 CLI 的 `cancel-all` 共用同一个 `cancelAllLiveOrders` 入口，所以两条路径的预检、订单收集、撤单语义和审计事件一致。

相关参数：

| 参数 | 说明 |
| --- | --- |
| `onFillAction` | `hold` 表示持有完整套仓继续做市；`sellAllAtMarket` 仅作为旧字段名保留，当前 Predict.fun 含义是完整 YES/NO 套仓合并退出 |
| `cashOnFillAction` | cash 单边被吃后的动作。`hold` 表示撤单后暂停；`sellWithinLossCap` 表示在亏损上限内发 SELL taker 限价退出 |
| `cashMaxExitLossPct` | cash 单边最大退出亏损百分比。`30` 表示最低卖价为持仓均价的 70%，盘口低于底价时不会扫穿 |
| `liquidationSlippageTicks` | 旧市价卖出参数，当前 split 实盘退出不使用 |
| `liquidationMaxSlippageCents` | 旧市价卖出参数，当前完整套仓退出走合并，不扫盘口 |
| `minPositionSizeToLiquidate` | 小于这个完整套仓份额不触发合并退出 |

进场方式：

- 当前推荐实盘入口是 `entryMode: cash`、`quoteSide: buy`、`maxMarkets` 控制同时维护的单边 PP 挂单数量。路由按 101 份目标订单的 PP/hr/kUSD 资金效率排序，但如果 `enforceRewardMinimum: false`，实际测试单仍按 `orderSizeUsd` 下，不会被自动放大。
- Predict.fun cash 普通 REST maker 挂单不需要 BNB。自动 split/merge 只属于 `entryMode: split`，需要少量 BNB；当前公开开发文档只把 split/merge 暴露在 SDK/链上交易路径里，没有发现免 GAS 的 REST split/merge 端点。
- 如果 cash 单边订单被吃，下一轮同步到持仓后会触发成交保护：撤销全部机器人受管挂单，跳过本轮新增订单；若 `cashOnFillAction: sellWithinLossCap`，会在 `cashMaxExitLossPct` 亏损上限内发 SELL taker 限价退出，盘口低于底线则继续同步但不扫穿。持仓清空后继续扫描和挂单；只有本轮实盘累计达到 `maxDailyLossUsd` 才会停止实盘并等待手动重新开启。
- split/merge 手续费不再使用固定 `0.0001 BNB` 门槛。程序会优先按目标市场、动作和金额调用 RPC `estimateGas`，再乘以 `gasBufferMultiplier`；如果市场还没确定或估算失败，才用 `fallbackSplitMergeGasUnits` 兜底，并在真正 split/merge 前再次动态估算。
- split 换池不再只看 PP 分数。已有完整套仓时，机器人优先在当前池子撤单等待/重挂；只有新市场的 PP 效率、剩余安全时间和估算额外收益足以覆盖 merge+split 的 gas 成本，才允许跨市场切换。相关参数是 `minSwitchBenefitMultiplier`、`minSwitchEdgeAfterGasUsd`、`minSafeHoursForSwitch` 和 `bnbUsdForGasEstimate`。
- Polymarket 当前没有接入同等 split 能力；默认 fail-closed，不会自动单边 BUY 进场。
- UI 手动下单入口已经禁用，后端 `/api/manual-order` 也会直接拒绝。当前只允许“开始实盘”自动执行配置中的 cash 单边篮子或 split 套仓策略；紧急处理保留“停止并撤单”。
- 拆分金额不再用“挂满目标单笔所需份额”阻断启动。Predict.fun 官方 split 能力按最低 `$1` 处理；机器人会尽量按可用资金和持仓上限拆分，然后按真实同步到的完整套仓库存缩小双边 SELL。比如 `$8` 挂在 0.27 附近若要挂满约需 29.6 份完整套仓，但 1U/10U 仍可先拆，只是实际挂单数量会更小，或因平台最小订单限制跳过。
- `enforceRewardMinimum: true` 时，`orderSizeUsd` 是真实单笔预算上限；如果该金额买不起官方最低奖励份额加 1 份，候选会被排除，不会为了达标 PP 静默放大订单。
- `enforceRewardMinimum: false` 时，订单只按 `orderSizeUsd` 下单，适合小额实盘测试流程；路由可继续按最低奖励份额加 1 估算机会，但这类小单可能不满足平台 PP 最低份额。
- 小额实盘测试模式下，低于 PP 最低份额不是错误，不会被程序自动放大修正。比如你设置 `orderSizeUsd: 2` 且关闭严格最低份额，机器人应该按 2U 级别验证下单/撤单/切换流程，而不是为了达标 PP 擅自变成几十 U。
- split 双边 SELL 下，`orderSizeUsd` 是完整 YES/NO 卖单组的总预算。设置 2U 时，YES 和 NO 会用相同份数，但两条腿名义金额合计应大约不超过 2U，不是每条腿各 2U。已有旧单如果超过当前预算，下一轮会撤掉旧的机器人管理订单，再按新预算重建。
- 如果目标市场两边 `conditionId` 缺失或不一致、余额不足、资金冻结估算偏差过大、两边盘口不安全、或 split 后没有同步到完整 YES/NO 库存，本轮都会 fail-closed，不新增挂单。

## 目录位置

项目目录：

```powershell
C:\Users\Administrator\Documents\New project 3\safe-market-maker
```

配置文件：

```powershell
C:\Users\Administrator\Documents\New project 3\safe-market-maker\config.yaml
```

本机数据目录：

```powershell
C:\Users\Administrator\Documents\New project 3\safe-market-maker\.safe-mm
```

`.safe-mm` 下面会保存加密钱包、加密平台凭据和 SQLite 状态库。不要把这个目录发给别人。

## 当前推荐启动方式：ENV 首次导入，本机加密保存

现在 UI 不再要求你每次输入 keystore 密码。推荐方式是：

1. 第一次启动时，把隔离热钱包私钥放进当前 PowerShell 会话的环境变量。
2. 启动 UI。
3. 程序检测到 ENV 后，自动加密保存到 `.safe-mm/runtime-secrets/`。
4. 以后重新启动 UI，不需要再设置 ENV，程序会自动读取本机加密副本。

第一次启动 Predict.fun：

```powershell
cd "C:\Users\Administrator\Documents\New project 3\safe-market-maker"
$env:SAFE_MM_PREDICT_PRIVATE_KEY="你的隔离热钱包私钥"
node dist/src/cli/index.js ui --port 8789
```

第一次启动 Polymarket：

```powershell
cd "C:\Users\Administrator\Documents\New project 3\safe-market-maker"
$env:SAFE_MM_POLYMARKET_PRIVATE_KEY="你的 Polymarket 隔离热钱包私钥"
node dist/src/cli/index.js ui --port 8789
```

如果两个平台共用同一个隔离热钱包，也可以使用通用变量：

```powershell
$env:SAFE_MM_PRIVATE_KEY="你的隔离热钱包私钥"
node dist/src/cli/index.js ui --port 8789
```

首次保存成功后，关闭 UI，以后直接启动：

```powershell
cd "C:\Users\Administrator\Documents\New project 3\safe-market-maker"
node dist/src/cli/index.js ui --port 8789
```

UI 顶部“签名来源”会显示：

| 显示 | 含义 |
| --- | --- |
| `SAFE_MM_PREDICT_PRIVATE_KEY 已加载并已本机加密保存` | 本次从 ENV 读取，并已保存本机加密副本 |
| `SAFE_MM_POLYMARKET_PRIVATE_KEY 已加载并已本机加密保存` | 本次从 ENV 读取 Polymarket 私钥，并已保存本机加密副本 |
| `本机加密私钥已加载` | 没有 ENV，但已经从 `.safe-mm/runtime-secrets/` 读取成功 |
| `未检测到运行时私钥` | 还没有设置 ENV，也没有本机加密副本，不能开始实盘 |

加密文件位置：

```powershell
.safe-mm\runtime-secrets\
```

这里保存的是加密后的本机副本，不是明文私钥；但它仍然是敏感数据，不要发给别人，不要上传到仓库。

旧的 `wallet import` / keystore 流程仍保留给 CLI 兼容和老数据迁移，但 UI 主流程不再依赖你输入 keystore 密码。

UI 会在每次状态轮询时用最近账户风控快照显示实时余额、账户权益、本轮 PnL 和挂单亏损估算。挂单亏损估算不是已实现亏损；它按开放 BUY 订单本金加 SELL 潜在赔付做最坏情况估算，并和本轮止损余量对比。

## 第一步：安装和构建

在项目目录运行：

```powershell
npm ci
npm run build
```

以后如果你改了代码，重新运行：

```powershell
npm run build
```

## 第二步：初始化配置

推荐用中文向导：

```powershell
node dist/src/cli/index.js init --guided
```

向导里直接回车就是使用括号里的默认值。例如：

```text
dataDir [.safe-mm]:
```

这里直接回车即可，不需要手动输入 `.safe-mm`。

## config.yaml 怎么填

`config.yaml` 只放配置，不放私钥。

### 顶层参数

| 参数 | 含义 | 建议 |
| --- | --- | --- |
| `dataDir` | 本机数据目录，保存本机加密私钥、凭据、SQLite | 默认 `.safe-mm` |
| `liveEnabled` | 实盘总开关 | 第一次保持 `false`，准备好后改成 `true` |
| `endpointPolicy.allowCustom` | 是否允许自定义 API/RPC 域名 | 默认 `false` |
| `endpointPolicy.extraAllowedHosts` | 额外允许的 endpoint origin | 不懂就空数组 |

### Predict.fun 参数

| 参数 | 含义 | 是否私钥 |
| --- | --- | --- |
| `venues.predict.enabled` | 是否启用 Predict.fun | 否 |
| `venues.predict.apiBaseUrl` | Predict API 地址 | 否 |
| `venues.predict.wsUrl` | Predict WebSocket 地址，用于实时订单簿/钱包事件 | 否 |
| `venues.predict.rpcUrl` | BSC RPC 地址 | 否 |
| `venues.predict.chainId` | BSC 主网链 ID，默认 56 | 否 |
| `venues.predict.apiKey` | Predict 平台 API key | 不是钱包私钥，但仍应保密 |
| `venues.predict.accountAddress` | Predict 账户地址，没有就留空 | 否 |

Predict 没有“平台密码”。不要把 Predict 网站密码、钱包私钥或助记词写进 `config.yaml`。

### Polymarket 参数

| 参数 | 含义 | 是否私钥 |
| --- | --- | --- |
| `venues.polymarket.enabled` | 是否启用 Polymarket | 否 |
| `venues.polymarket.gammaUrl` | Gamma API 地址 | 否 |
| `venues.polymarket.clobUrl` | CLOB API 地址 | 否 |
| `venues.polymarket.rpcUrl` | Polygon RPC，用于读取 POL、pUSD 和 V2 授权 | 否 |
| `venues.polymarket.chainId` | Polygon 主网链 ID，默认 137 | 否 |
| `venues.polymarket.funderAddress` | 新 EOA 留空；代理/合约钱包才配置实际 funder | 否 |
| `venues.polymarket.signatureType` | 新 EOA 使用 0 | 否 |
| `venues.polymarket.autoDeriveApiKey` | 是否自动派生 CLOB API 凭据 | 否 |

### selectedMarkets

```yaml
selectedMarkets:
  predict: []
  polymarket: []
```

这里是手动模式的允许实盘市场 tokenId 列表。默认 `autoSelectMarkets: true` 时可以留空，程序会每轮自动寻找最佳 PP 市场；如果你把 `autoSelectMarkets` 关掉，实盘预检会要求这里至少有一个市场。

想固定只做一批市场时，用推荐命令写入：

```powershell
node dist/src/cli/index.js recommend --venue predict --top 5 --apply
```

### 风控参数

| 参数 | 中文名 | 单位 | 说明 |
| --- | --- | --- | --- |
| `orderSizeUsd` | 目标挂单金额 | USD | split 模式下是完整 YES/NO 卖单组的总目标名义金额；非 split 模式下是单笔目标金额 |
| `maxSingleOrderUsd` | 单笔订单上限 | USD | 任何单笔订单都不能超过这个金额 |
| `maxPositionUsd` | 最大持仓敞口 | USD | 单个市场/Token 最多允许暴露的资金规模 |
| `maxDailyLossUsd` | 本轮总止损金额 | USD | UI 点击开始实盘后按本轮成交/仓位/余额和权益快照判断；触发后撤机器人受管挂单并停止实盘，直到手动重新开启 |
| `maxAccountRiskStaleMs` | 账户风控有效期 | ms | 账户级快照超过该时间、不可用或缺少可验证 PnL/权益字段时禁止新增挂单 |
| `maxOpenOrderReserveDriftUsd` | 冻结偏差上限 | USD | 开放 BUY 订单估算占用和平台冻结余额偏差超过该值时禁止继续加单 |
| `maxOpenOrderReserveDriftPct` | 冻结偏差上限 | % | 平台暴露冻结余额时的百分比偏差兜底 |
| `maxOpenOrdersPerMarket` | 每市场挂单数 | 笔 | 同一个市场最多保留的开放订单数量 |
| `maxMarkets` | 同时做市市场数 | 个 | 自动做市最多覆盖的市场数量 |
| `staleBookMs` | 盘口有效期 | ms | 盘口超过这个时间就视为过期 |
| `minDepthUsdPerSide` | 单边最小深度 | USD | 买卖任一侧深度不足时不下单 |
| `minPrice` | 最低报价 | 概率 | 低于这个价格不下单 |
| `maxPrice` | 最高报价 | 概率 | 高于这个价格不下单 |
| `minSpreadBps` | 最小价差 | bps | 价差太窄不下单 |
| `maxSpreadBps` | 最大价差 | bps | 价差过宽视为风险 |

如果平台同时返回 `available` 和 `total` 余额，程序认为 `available` 已经扣除了平台冻结资金；开放 BUY 订单估算占用只用于校验冻结偏差，不会再从 `available` 里重复扣一次。
| `requirePostOnly` | 只挂单不吃单 | 布尔 | 要求尽量保持 maker 行为 |

### 策略参数

| 参数 | 中文名 | 说明 |
| --- | --- | --- |
| `tradingMode` | 报价模式 | `conservative` 保守，`aggressive` 激进 |
| `entryMode` | 入场/库存模式 | 推荐实盘为 `cash`：不 split/merge，按 101 份单边 PP/hr/kUSD 低竞争机会挂 maker BUY；`split` 是可选完整 YES/NO 套仓双边 SELL 模式 |
| `optimizerMode` | 优化目标 | 当前固定为 `points`，代表积分收益优化 |
| `pointsOnly` | 只做奖励市场 | 开启后只挑选带积分或奖励规则的市场 |
| `acceptingOnly` | 只做可交易市场 | 开启后过滤关闭、已结算或暂停交易的市场 |
| `autoSelectMarkets` | 自动 PP 路由 | 开启后不需要手动 `selectedMarkets`，现金单边会维护最多 `maxMarkets` 个按 101 份 PP/hr/kUSD 排序的低竞争机会 |
| `minMarketLiquidityUsd` | 最低市场流动性 | 现金单边默认 0，因为目标是找官方奖励区间里的低竞争盘口；split 或保守模式可自行调高 |
| `minRewardLevel` | 最低 LP 奖励等级 | 现金单边默认 0，由官方当前 PP/hr 和奖励带竞争资金排序；`4`/`5` 可用于只做高等级奖励市场 |
| `minRewardSizeMultiplier` | 奖励份额倍数 | 路由和严格模式最低份额门槛倍数；`1` 是最低要求，`2` 是两倍最低份额 |
| `enforceRewardMinimum` | 严格满足最低份额 | 开启后只选择当前单笔金额能覆盖平台最低奖励份额加 1 的盘口；小额实盘测试可关闭 |
| `candidateLimit` | 热盘口扫描数量 | 每轮先全量读取市场元数据；该值只控制 hot 盘口预算，不截断全市场初筛 |
| `switchThresholdPct` | 切换优势 | 单池 cash 模式用于判断是否换目标；现金多市场篮子模式主要按排名补入/撤换，不做 merge/split 切池 |
| `gasBufferMultiplier` | Gas 安全倍数 | split/merge 动态估算后额外保留的手续费余量 |
| `fallbackSplitMergeGasUnits` | 兜底 Gas 上限 | 无法精确估算 split/merge 时使用的 gas 单位 |
| `minSwitchBenefitMultiplier` | 换池收益倍数 | 跨市场重新 split/merge 前，预期额外收益需要覆盖 gas 成本的倍数 |
| `minSwitchEdgeAfterGasUsd` | 换池净优势 | 扣除估算 gas 后仍需保留的最小美元优势 |
| `minSafeHoursForSwitch` | 换池安全时长 | 新市场剩余安全做市时间低于该值时不切换 |
| `bnbUsdForGasEstimate` | BNB 估算价 | 将 BNB gas 折算成美元比较换池成本，非交易价格 |
| `dualSide` | 双边报价 | 现金单边推荐 `false`；split 模式会自动成组双边 SELL |
| `quoteSide` | 挂单方向 | 现金单边推荐 `buy`，使用 maker BUY 抢 PP 且由保护深度避免被吃；`sell` 仅适合已有库存 |
| `quoteRefreshMs` | 扫描间隔 | 自动做市循环两轮之间等待多久；20 市场现金篮子默认 2000ms，继续扩大市场数前要观察 429/超时 |
| `marketRefreshMs` | 市场刷新间隔 | 市场列表缓存多久；默认 60000，降低 API 压力 |
| `conservativeDepthLevel` | 保守盘口层级 | 现金单边会额外要求至少 3 档前方保护，并参考第 4 档支撑报价；前方保护深度和 final submit guard 负责避免吃单风险 |
| `aggressiveDepthLevel` | 激进盘口层级 | 激进模式参考更靠前的盘口 |
| `retreatTicks` | 后退 tick | 报价从目标价后退的最小步数 |
| `replaceThresholdTicks` | 撤换阈值 | 目标报价移动超过几个 tick 就撤旧单换新单 |
| `cancelOutsideReward` | 奖励外撤单 | 市场或订单不再符合当前奖励筛选时，撤掉机器人管理的旧单 |
| `onFillAction` | 退出动作 | `hold` 表示持有完整套仓继续做市；`sellAllAtMarket` 是旧字段名，当前 Predict.fun 表示完整套仓合并退出 |
| `cashOnFillAction` | cash 被吃后动作 | `hold` 只撤单暂停；`sellWithinLossCap` 在亏损上限内立即发 SELL taker 限价退出 |
| `cashMaxExitLossPct` | cash 最大退出亏损 | 例如 `30` 表示最低卖价是持仓均价的 70%，盘口低于底线则不扫穿 |
| `liquidationSlippageTicks` | 旧卖出滑点 | 保留旧配置兼容；当前 split 实盘退出不使用 |
| `liquidationMaxSlippageCents` | 旧最大滑点 | 保留旧配置兼容；完整套仓退出走合并，不扫盘口 |
| `minPositionSizeToLiquidate` | 最小合并份额 | 低于该份额不触发完整套仓合并 |
| `balanceReserveUsd` | 余额保留 | 自动挂单前保留不用的余额；小账户可以设为 `0` |
| `inventorySkewEnabled` | 偏仓保护 | 已有持仓过高时不继续加同方向买单 |
| `maxInventorySkewUsd` | 最大偏仓 | 单 token 持仓达到该值后停止继续买入 |
| `dedupeMarketGroups` | 市场分组去重 | 同一赛事/问题限制 token 数，避免资金集中在一个市场 |
| `maxTokensPerMarket` | 单市场 Token 上限 | 同一个市场分组最多允许几个 outcome token 进入推荐和做市 |

## 第三步：准备隔离热钱包

推荐使用上面的 ENV 首次导入方式，让 UI 自动加密保存运行时私钥。旧的 CLI keystore 导入仍可用于兼容老流程或命令行工具：

```powershell
node dist/src/cli/index.js wallet import --venue predict
node dist/src/cli/index.js wallet import --venue polymarket
```

旧命令会让你输入两样东西：

1. 钱包私钥：64 位十六进制字符串，可带 `0x`。这是钱包私钥，不是 API key。
2. 本机 keystore 加密密码：你自己设置，用来加密保存私钥，以后解锁时还要输入。程序不限制长度，但不能为空；短密码更容易被猜到，不推荐。

实际命令行会显示为 3 步：

```text
第 1/3 步：粘贴 predict 钱包私钥（只输入一次，输入会显示为 *）:
第 2/3 步：设置本机 keystore 加密密码（长度不限，但不能为空；不是私钥）:
第 3/3 步：再次输入同一个本机 keystore 加密密码（不是私钥）:
```

注意：

- 第 1/3 步才是钱包私钥。
- 第 2/3 和第 3/3 步不是私钥，是你自己设置的本机加密密码。
- 本机 keystore 加密密码不再要求至少 10 个字符，但不能为空；短密码由你自己承担风险。
- 第 2/3 和第 3/3 必须一模一样，否则会提示“本机 keystore 加密密码不一致”。
- 屏幕上的 `*` 只是隐藏输入的显示方式，不代表程序又让你输入新的东西。

如果你只使用 UI 自动做市，优先使用 ENV 首次导入；如果你只做 Predict.fun，只准备 predict 对应的隔离热钱包即可。只做 Polymarket，只准备 polymarket 即可。

## 第四步：生成平台凭据

Predict：

```powershell
node dist/src/cli/index.js auth predict
```

Polymarket：

```powershell
node dist/src/cli/index.js auth polymarket
```

这个命令会用钱包签名生成或获取平台交易凭据，然后把凭据加密保存到 `.safe-mm/credentials/`。它不是网页登录，也不是让你输入平台密码。

## 第五步：选择市场或启用自动路由

默认建议使用自动 PP 路由：

```yaml
strategy:
  autoSelectMarkets: true
```

这种模式下 `selectedMarkets` 可以为空，程序会根据实时市场状态自动选择目标市场。你也可以先加载推荐，只用于人工查看：

```powershell
node dist/src/cli/index.js recommend --venue predict --top 5
```

如果你想固定只做指定市场，再把推荐写入配置并关闭自动路由：

```powershell
node dist/src/cli/index.js recommend --venue predict --top 5 --apply
```

## 第六步：检查授权和预检

检查授权：

```powershell
node dist/src/cli/index.js approvals inspect --venue predict --token-id <tokenId>
```

Predict 网页可以直接下单，不代表本机签名钱包一定有 BNB。官方 SDK 文档里，设置授权和链上取消仍需要签名钱包有少量链上 gas；但已经授权过的限价挂单通常只是签名后提交 REST 订单，不需要每次都有 BNB。程序预检会按这个逻辑判断：如果 USDT 授权已经存在，`0.0 BNB` 不会单独拦住实盘；如果授权缺失，就必须先给签名钱包准备少量 BNB 才能发授权交易。

如果需要授权，使用明确金额，不做无限授权：

```powershell
node dist/src/cli/index.js approvals grant --venue predict --token-id <tokenId> --amount-usd 20 --confirm APPROVE
```

实盘预检：

```powershell
node dist/src/cli/index.js preflight --venue predict --confirm LIVE
```

预检失败时不要强行运行。根据输出修复缺失项，例如钱包、凭据、余额、授权、手动模式下的 selectedMarkets 或 `liveEnabled`。

## 第七步：启动 UI

```powershell
node dist/src/cli/index.js ui --port 8789
```

浏览器打开：

```text
http://127.0.0.1:8789/
```

UI 是本机控制台，默认只监听 `127.0.0.1`。

UI 状态接口只显示 Predict API key 是否已配置，不会把真实 API key 发给前端。SQLite 审计事件和终端 JSON 日志会对 JWT、Bearer token、私钥形状字符串、password、passphrase、secret、apiKey 等敏感字段做脱敏。`tokenId` 这类公开市场标识会保留显示，方便你确认机器人到底挂在哪个市场。

## UI 怎么用

### 概览页

现在主导航是：

- 实盘
- 市场池
- 诊断

实盘页会先显示：

- 实盘控制：平台、签名来源、开始实盘、检查启动条件、刷新余额、停止、停止并撤单
- 策略控制台：同时总挂单数量、单笔挂单金额、退出亏损上限、本轮总止损金额

下方再显示：

- 实盘状态：未启动、运行中、停止中、错误
- 当前平台
- 开放订单数量
- PP 路由状态：自动选优或手动市场数量
- 签名和凭据是否就绪
- 当前目标市场、选择原因、PP 强度、盘口价差、同组奖励带竞争资金、目标订单金额和当前挂单状态
- 最近错误
- 最近订单和最近日志

### 开始实盘

在“实盘控制”区域：

1. 选择平台。
2. 确认“签名来源”不是 `未检测到运行时私钥`。
3. 点击“开始实盘”。

如果 `liveEnabled` 仍是关闭状态，需要先在本机配置里开启这个实盘总闸门；UI 日常界面不再暴露这个开关，避免误触。真正启动仍必须通过签名、凭据、余额、授权、订单同步和风控预检。如果预检失败，UI 会拒绝启动。

实盘页“最近日志”会记录开启实盘、预检、循环启动、每轮循环、停止请求和真正停止等过程。

点击“开始实盘”成功后，UI 会写入一个本机“实盘运行意图”。如果电脑休眠、网络断开、Node 进程重启或 UI 后端被重启，只要 `liveEnabled` 仍然开启、运行时私钥仍可读取，服务启动时会自动恢复实盘循环。恢复后的第一步一定是同步真实开放订单、持仓、余额、市场和盘口，然后才决定继续等待、撤换旧单或新增挂单，避免已有挂单变成无人监控的孤儿单。

Predict REST 市场/订单接口偶发慢时，UI 启动预检会把连接检查写成告警而不是一直卡住；真正下单前的第一轮循环仍会重新同步开放订单、持仓、余额、市场和盘口。任何一个关键同步失败，本轮都会跳过新增订单，只写错误日志。

实盘循环运行中遇到临时网络错误、接口超时、平台 5xx 或限流时，不会直接退出循环；UI 会显示“断线重试”，并按退避时间自动重试。401/403、缺私钥、缺签名能力等配置或凭据错误不会自动盲重试，需要修复后重新开始。

Predict 盘口现在优先使用官方 WebSocket：`predictOrderbook/{marketId}` 会持续更新本地订单簿缓存，程序开单前优先用 WS 缓存做最终复检；如果 WS 没有新鲜盘口，才用短超时 REST 兜底。程序也会订阅 `predictWalletEvents/{jwt}`，为订单接受、拒绝、取消和链上成交事件保留实时状态来源。WS 断开或超时不会触发盲目下单。

### 查看余额

在“实盘控制”区域：

1. 选择平台。
2. 点击“刷新余额”。

余额读取会使用运行时签名和平台凭据。UI 不会显示私钥，只显示可用余额和总额。Predict.fun 余额按官方 SDK 的 `balanceOf` 路径读取 BNB Chain 上的 USDT 余额，不再请求不存在的 REST 余额接口；程序会同时尝试配置的 RPC 和 BNB 官方 dataseed，单个 RPC 超过 2.5 秒会切换/失败，UI 总等待上限是 4 秒。实盘循环读取不到余额时按 0 可用余额处理，本轮不会新增订单。

### 策略控制台

实盘页的“策略控制台”只暴露日常需要调整的 4 个参数；其它路由、扫描、盘口保护和凭据开关继续由配置默认值或内部逻辑维护：

| 控件 | 作用 |
| --- | --- |
| 同时总挂单数量 | cash 单边模式下最多同时维护多少个安全 PP maker 挂单 |
| 单笔挂单金额 USD | 真实提交订单的单笔目标金额；正式 PP 模式下金额不足官方最低份额加 1 的盘口会被排除，小额测试模式下路由仍按最低份额估算机会 |
| 退出亏损上限 % | cash 单边被吃出持仓后，先撤机器人受管挂单；只有当前 SELL 退出价格仍在该亏损上限内才提交卖单，超过上限不扫穿 |
| 总止损金额 USD | 从点击开始实盘后累计；达到后撤机器人受管挂单并停止实盘，必须手动重新开启 |
| 撤换阈值 tick | 价格移动多少才撤旧单换新单 |
| 余额保留 USD | 预留不用的余额，避免把账户打满 |
| 最大偏仓 USD | 已有持仓达到该值后不再继续买入 |
| 单市场最多 Token | 同一市场分组最多选几个 outcome token |
| 只做有积分/奖励的市场 | 开启后只推荐有积分/奖励规则的市场 |
| 只做开放可交易市场 | 开启后过滤关闭、已结算或暂停交易的市场 |
| 自动撤掉不再符合奖励的旧单 | 开启后会把机器人管理的奖励外旧单撤掉 |
| 开启偏仓保护 | 开启后避免在同一 token 上越买越多 |
| 按市场分组去重 | 开启后避免推荐结果被同一场比赛/同一问题占满 |

### 重要：余额和最低奖励份额

如果平台要求最低 100 份，机器人按 101 份作为有效门槛；价格在 50c 左右时，一笔合格奖励订单大约需要 50.5 USD。`enforceRewardMinimum: true` 时，自动挂单不会放大金额，而是只选择当前 `orderSizeUsd` 能买够最低份额加 1 的盘口；余额或风控上限不够时会跳过。`enforceRewardMinimum: false` 时，程序允许按较小 `orderSizeUsd` 试单，但这只是验证流程，不保证拿到 PP。

这种情况下有三个选择：

1. 小额实盘测试：关闭“严格满足 PP 最低份额”，用较小 `orderSizeUsd` 验证下单、撤单、切换和面板状态。
2. 正式获取 PP：开启“严格满足 PP 最低份额”，并把 `orderSizeUsd`、`maxSingleOrderUsd`、`maxPositionUsd` 分别明确配到能覆盖目标市场的最低奖励份额加 1。UI 修改 `orderSizeUsd` 不会静默抬高两个风控上限。
3. 如果余额或授权不足，先不要启动自动实盘，先补足隔离热钱包或降低目标市场范围。

### 停止

点击“停止”会清除本机“实盘运行意图”，并请求当前循环停止。它不会自动撤掉已经挂出的订单；如果还有开放订单，页面会明确显示“已有开放订单，循环未运行”。这种状态下服务重启不会自动恢复监控，除非你再次点击“开始实盘”。

### 停止并撤单

如果你希望停止并撤掉开放订单：

1. 点击“停止并撤单”。

Predict.fun 的 REST 撤单接口会快速把订单从订单簿移除；官方文档也提醒这不等同于链上失效。UI 日志会分别显示“收到停止请求”“开始撤单”“撤单接口完成”和“循环已停止”，方便确认程序已经不再继续挂新单。

“停止并撤单”也会清除本机“实盘运行意图”。也就是说，明确停止后机器人不会在下次启动时偷偷恢复实盘；只有成功点击“开始实盘”才会重新进入自动恢复模式。

### 手动买卖

手动买卖不再作为主导航入口。这个机器人主目标是自动寻找 PP/流动性更优市场并挂 maker 单，不是手动交易工具。旧的手动订单接口仍保留给开发和应急，但日常 UI 不展示它。

## CLI 实盘命令

运行一轮：

```powershell
node dist/src/cli/index.js run --venue predict --confirm LIVE --once
```

持续运行：

```powershell
node dist/src/cli/index.js run --venue predict --confirm LIVE
```

撤单：

```powershell
node dist/src/cli/index.js cancel-all --venue predict --confirm CANCEL_ALL
```

查看本机状态：

```powershell
node dist/src/cli/index.js status
```

## 常见问题

### 私钥在哪里配置？

私钥不在 `config.yaml` 里配置。推荐第一次启动 UI 时用当前 PowerShell 会话的 ENV：

```powershell
cd "C:\Users\Administrator\Documents\New project 3\safe-market-maker"
$env:SAFE_MM_PREDICT_PRIVATE_KEY="你的隔离热钱包私钥"
node dist/src/cli/index.js ui --port 8789
```

Polymarket 使用：

```powershell
$env:SAFE_MM_POLYMARKET_PRIVATE_KEY="你的 Polymarket 隔离热钱包私钥"
node dist/src/cli/index.js ui --port 8789
```

程序会加密保存到 `.safe-mm/runtime-secrets/`。以后直接运行：

```powershell
node dist/src/cli/index.js ui --port 8789
```

### API key 在哪里配置？

Predict 的 API key 放在：

```yaml
venues:
  predict:
    apiKey: "<你的 API key>"
```

不要把钱包私钥填到这里。

### 为什么不再需要每次设置 ENV？

第一次 ENV 启动时，程序会把私钥加密保存到 `.safe-mm/runtime-secrets/`。后续启动会自动读取本机加密副本。旧的 keystore 密码流程只作为兼容路径保留，不是 UI 主流程。

### 为什么开始实盘失败？

常见原因：

- `liveEnabled` 还是 `false`
- 没有设置过运行时私钥，或 `.safe-mm/runtime-secrets/` 不存在
- 没有运行 `auth predict` 或 `auth polymarket`
- 手动路由模式下 `selectedMarkets` 为空
- Predict JWT 过期或 API 返回 401，需要重新运行 `node dist/src/cli/index.js auth predict`
- 授权额度或余额不足
- CLI 确认参数不对
- 盘口接口不可用
- 风控参数不合法

### 可以用主钱包吗？

不建议，也不按这个工具的设计目标使用。请创建小额隔离热钱包，只放你愿意承担风险的资金。

## 验证命令

开发或修改后建议运行：

```powershell
npm run check
npm run build
npm audit --audit-level=moderate
```

通过这些检查不代表没有交易风险，只代表代码质量、安全扫描和依赖审计在当前规则下通过。
