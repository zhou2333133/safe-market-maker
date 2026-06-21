# 积分收益优化机器人

低风险 TypeScript 本机实盘控制台，用于 Predict.fun 和 Polymarket 的积分/LP 奖励导向做市。

中文使用手册见 [docs/zh-CN/user-guide.md](docs/zh-CN/user-guide.md)。

本项目不复用原 Electron 外壳，不把原始私钥写入 `config.yaml`。UI 默认使用运行时私钥：第一次启动时从 `SAFE_MM_PREDICT_PRIVATE_KEY`、`SAFE_MM_POLYMARKET_PRIVATE_KEY` 或 `SAFE_MM_PRIVATE_KEY` 读取，并自动加密保存到 `.safe-mm/runtime-secrets/`；以后启动会自动读取本机加密副本。

## Quick Start

```bash
npm ci
npm run build
node dist/src/cli/index.js init --guided
$env:SAFE_MM_PREDICT_PRIVATE_KEY="你的隔离热钱包私钥"
node dist/src/cli/index.js ui --port 8789
```

首次用 ENV 启动成功后，可以关闭窗口重新启动：

```bash
node dist/src/cli/index.js ui --port 8789
```

UI 会从 `.safe-mm/runtime-secrets/` 自动读取本机加密私钥。中文完整说明见 [docs/zh-CN/user-guide.md](docs/zh-CN/user-guide.md)。

UI 默认只绑定本机 `127.0.0.1`。打开 UI 后使用“开始实盘 / 停止 / 停止并撤单”控制自动做市循环。策略默认开启自动 PP 路由：先全量读取市场元数据，再分层拉取盘口。已有持仓/开放订单市场进入 active 扫描，高潜力市场进入 hot 扫描，其余合格市场进入 explore 轮询；机器人还会周期性对全部官方合格市场做一次盘口全扫，用真实全站覆盖结果校准最佳市场。默认现金单边模式按 101 份奖励目标估算每个 token/outcome 的 PP/hr/kUSD 资金效率，分母使用同一市场组 YES/NO 在该挂单方向的奖励带有效竞争资金加上本单真实金额，优先维护低竞争、安全且仍在官方奖励区间内的多市场挂单篮子；split 模式仍按完整 YES/NO 组估算 expected PP，并额外考虑 split/merge 成本。

点击“开始实盘”成功后，UI 会保存本机运行意图；服务重启或网络恢复后会自动恢复循环，先同步真实开放订单再继续监控、撤换或挂单。点击“停止”或“停止并撤单”会清除这个意图，不会在下次启动时偷偷恢复。

实盘启动必须同时满足：

- `config.yaml` 中 `liveEnabled: true`
- 已通过 ENV 首次导入运行时私钥，或本机加密私钥已存在
- 已保存 Predict JWT 或 Polymarket CLOB 凭据
- 自动 PP 路由开启，或手动模式下已选择 `selectedMarkets`
- 通过账户级风控、余额、授权、开放订单同步、SQLite 等预检；平台成交/仓位/权益快照不可用或过期时禁止新增挂单，UI 实盘总止损按本轮开始时间统计
- UI 点击开始；CLI 输入 `--confirm LIVE`
- 面板会显示当前目标市场、选择原因、PP 强度、同组奖励带竞争资金、目标订单金额和当前挂单状态
- 正式拿 PP 时开启 `enforceRewardMinimum`，并把 `orderSizeUsd` 配到能覆盖目标盘口的官方最低份额加 1；小额实盘测试可先关闭它，用较小 `orderSizeUsd` 验证流程

Polymarket 使用官方 CLOB V2 和 Polygon 主网 pUSD。新 EOA 钱包保持 `signatureType: 0`、`funderAddress: ""`，CLOB 凭据会先从 nonce 0 派生，不需要先在网页做交易。启动预检会检查官方 geoblock 地区分类和 CLOB close-only 状态、POL gas、pUSD 余额、V2 普通/Neg-Risk 交易所授权和开放订单同步；完整受限或 close-only 地区、余额/授权不足等情况都不会下单。官方将日本列为仅前端 UI 受限，因此只有在认证 CLOB 同时返回 `closed_only=false` 时才允许 API 路径。

请只使用小额隔离热钱包。本软件不承诺盈利，也不能消除交易、授权、平台 API 或链上执行风险。
