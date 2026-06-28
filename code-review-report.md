# Safe Market Maker — 全面代码审查报告

**审查日期**: 2026-06-27  
**审查范围**: `src/execution/`, `src/risk/`, `src/strategy/` 核心模块 (8个关键文件, ~3000+行)  
**审查人**: Code Reviewer Expert

---

## 1. 整体架构评估

### 架构模式: ⭐⭐⭐⭐ (优秀)

项目采用了清晰的分层架构，模块间职责分离良好：

| 层级 | 模块 | 评价 |
|------|------|------|
| 编排层 | `ExecutionEngine` | 核心循环协调器，流程清晰 |
| 策略层 | `StrategyEngine` + `rewards/*` | 奖励优化与报价生成分离 |
| 风控层 | `account-risk`, `capital-risk`, `risk-engine`, `market-guard` | 多层防护，决策树清晰 |
| 服务层 | `CancelService`, `CashFillExitService`, `LiquidationService` | 独立可测试 |
| 数据层 | `MarketDataSyncService`, `AccountSyncService` | 缓存+同步分离 |
| 适配层 | `venues/*` | Polymarket/Predict 完全独立 |

**设计亮点:**
- Polymarket/Predict 两个交易所完全独立，无共享参数泄漏
- A-2 (WS fill → cancel+exit) 和 A-3 (WS book → retreat) 的 dedupe Set 分离设计（22d2c6b 修复）
- 支持 protectOnly 降级模式 — 持仓API不可用时仍然维护现有挂单
- killExit 循环 + exitOnlyMode 状态机确保止损后持仓清空
- unreservedMaker 路径跳过 planReplaceRaceDefer，消除 ~16s 订单缺口

---

## 2. 🔴 Blocker 级问题 (建议修复)

### 🔴 B1: `verifyNakedOrderViaRest` 在串行循环中调用，可能阻塞撤单阶段

**文件**: `src/execution/cancel-service.ts` 第 227 行  
**严重程度**: 中高 — 当多个订单同时触发 30s 裸奔阈值时影响撤单时效

```typescript
// cancelReplaceableOrders 中的 for 循环 (line 205)
for (const order of managedOpenOrders) {
  // ...
  const verifyResult = await this.verifyNakedOrderViaRest(venue, order, market, books);
  // ...
}
```

**问题**: `verifyNakedOrderViaRest` 发起 REST 请求（超时 2s），在 `for` 循环中串行 `await`。如果多个订单同时满足 `longNakedRest` 条件（>30s 无新鲜 book），每个订单依次等待 2s REST 超时，导致此轮 `cancelReplaceableOrders` 总耗时线性增长。

**实际风险**: 正常运行时订单的 WS book 缓存应在 30s 内更新，此路径仅命中最安静的 Predict 市场（无 WS 推送）。风险窗口窄但存在。

**建议修复**:
```typescript
// 将多个 REST 验证并发执行
const verifyPromises: Array<{ order: OpenOrder; promise: Promise<...> }> = [];
for (const order of managedOpenOrders) {
  if (longNakedRest && market && isCashProtectedBuyOrder(...)) {
    verifyPromises.push({ 
      order, 
      promise: this.verifyNakedOrderViaRest(venue, order, market, books)
    });
    continue;
  }
  // ... 其他逻辑
}
// 并发等待
const results = await Promise.all(verifyPromises.map(v => v.promise));
```

或者，如果并发 REST 请求会触发频率限制，至少加一个并发上限（如最多 3 个并发）。

---

### 🔴 B2: `protectOnBookUpdate` 注释声称"sub-millisecond"，但实际 await 可能触发 REST

**文件**: `src/execution/engine.ts` 第 974 行  
**严重程度**: 低 — 实际影响小，但代码与注释矛盾可能导致未来维护者误解

```typescript
// 第 973 行注释: "Don't await a fetch here: this hot path must stay sub-millisecond."
const markets = await this.marketDataSync.resolveMarketsForOpenOrders(venue, [tokenId]);
```

**问题**: 注释明确说"不要 await 一个 fetch"，但代码确实 `await` 了。虽然 `resolveMarketsForOpenOrders` → `getCachedMarkets` 在正常运行时命中内存缓存（<1ms），但在缓存过期时可能触发 REST `adapter.getMarkets()`（最长 12s 超时）。

**实际风险**: 低。正常运行时市场缓存总是热的（前序 cycle 已填充），且此路径只有当 token 有 managed BUY 订单时才会进入。但冷启动场景下存在理论上的阻塞窗口。

**建议**: 方案 A — 更新注释说明真实情况；方案 B — 在缓存未命中时立即返回（跳过此轮 WS retreat），让下一轮 cycle 处理：

```typescript
const market = marketCache.get(tokenId); // 同步读缓存
if (!market) return; // 缓存 miss → 下一轮 cycle 处理
```

---

### 🔴 B3: `hasFreshReplacementIntent` 函数名严重误导

**文件**: `src/execution/cancel-service.ts` 第 512-524 行  
**严重程度**: 低（不影响正确性，但严重影响可维护性）

```typescript
function hasFreshReplacementIntent(
  config: AppConfig,
  order: OpenOrder,
  intents: OrderIntent[],
  books: Map<string, Orderbook>
): boolean {
  const now = Date.now();
  return intents.some((intent) => {
    if (intent.tokenId === order.tokenId) return false;  // 跳过同 token 的 intent
    const book = books.get(intent.tokenId);
    return Boolean(book && now - book.receivedAt <= config.risk.staleBookMs);
  });
}
```

**问题**: 函数名暗示"检查是否有针对此订单的新鲜替换 intent"，但实际逻辑是"检查是否有**任意其他市场**的 intent 拥有新鲜 book"，即**"市场数据管道是否健康"**的探测。

函数逻辑本身正确：如果至少有一个其他市场有新鲜 book，说明市场数据管道工作正常，可以信任当前订单缺少 intent（该市场确实不再符合条件），然后安全撤单。如果所有 book 都过期，则推迟撤单避免基于过期数据误判。

**建议**: 重命名为 `hasFreshMarketDataAvailable` 或 `isMarketDataPipelineFresh`，并补充注释说明设计意图。

---

## 3. 🟡 Suggestion 级问题 (应修复)

### 🟡 S1: `map.delete()` 在 catch/finally 时序中可能丢失 dedupe 标记

**文件**: `src/execution/engine.ts` `protectOnFill` 第 933 行, `protectOnBookUpdate` 第 1026 行

两处都在 `finally` 块中调用 `perVenue.delete(tokenId)`，而 `perVenue.add(tokenId)` 在函数入口处。如果 `acquireProtectLock` 抛出（第 870/1002 行），`perVenue.delete` 不会在 finally 中执行（因为 add 在 lock 获取之前）。

```typescript
// protectOnFill 简化流程
perVenue.add(tokenId);  // 第 860 行 — 已标记
const release = await this.acquireProtectLock(venue);  // 第 870 行
try {
  // ... 可能抛出的工作 ...
} finally {
  release();            // 第 932 行
  perVenue.delete(tokenId);  // 第 933 行
}
```

**问题**: 如果 `acquireProtectLock` 抛出（极端情况），token 会留在 dedupe Set 中且永远不会被清除，导致该 token 的未来 WS fill 事件被永久忽略。

**实际风险**: 极低。`acquireProtectLock` 的 Promise 操作几乎不会抛出（只涉及 Map 操作和 Promise 创建）。但作为防御性编程原则，应在 `add` 之前就做好 delete 准备。

**建议**: 将 `add` 移动到 `acquireProtectLock` 之后的 try 块内，或将 delete 逻辑前置：

```typescript
const release = await this.acquireProtectLock(venue);
perVenue.add(tokenId);  // 移动到这里
try {
  // ... 
} finally {
  perVenue.delete(tokenId);
  release();
}
```

---

### 🟡 S2: `cashPositionFingerprint` 的排序键不包含 tokenId

**文件**: `src/execution/engine.ts` 第 1041-1054 行

```typescript
.sort((a, b) => `${a.marketId ?? ''}:${a.outcome ?? ''}`
  .localeCompare(`${b.marketId ?? ''}:${b.outcome ?? ''}`))
```

**问题**: 排序键使用 `marketId:outcome`，不包含 `tokenId`。在正常情况下，一个 (marketId, outcome) 对应对唯一 tokenId，但在确保数据一致性场景下，如果同一 marketId+outcome 出现两个不同 tokenId 的 position，排序结果可能在不同周期间不稳定（取决于数组输入顺序），导致 fingerprint 变化 → fill circuit breaker 错误重置。

**实际风险**: 极低。实际 position 数据中 tokenId 与 marketId+outcome 是 1:1 映射。

**建议**: 排序键加入 tokenId 确保确定性：
```typescript
.sort((a, b) => `${a.marketId ?? ''}:${a.outcome ?? ''}:${a.tokenId ?? ''}`
  .localeCompare(`${b.marketId ?? ''}:${b.outcome ?? ''}:${b.tokenId ?? ''}`))
```

---

### 🟡 S3: `capitalUsage` 中 `reserveDrift` 的 OR vs AND 语义不一致

**文件**: `src/risk/capital-risk.ts` 第 183-194 行

```typescript
const ok = driftUsd <= maxDriftUsd || driftPct <= maxDriftPct;
```

**问题**: 使用 `||` (OR) 语义 — 只要绝对误差或百分比误差**任一**通过即算 ok。这意味着一笔大额冻结余额在绝对值上偏差很大但只要百分比小就放行。虽然这可能是设计意图（大资金量的绝对偏差天然大），但在代码中缺乏注释说明。

**建议**: 考虑是否应该是 `&&`（两者都通过），或添加注释说明 OR 语义的理由。

---

### 🟡 S4: `isCashProtectedBuyOrder` 仅限 Predict — Polymarket unreserved maker 缺少同级 REST 验证

**文件**: `src/execution/cancel-service.ts` 第 689-698 行

```typescript
function isCashProtectedBuyOrder(config, order, market) {
  return ... && market.venue === 'predict'  // 仅 Predict!
}
```

**问题**: 对 Polymarket unreserved maker 模式，长时裸奔检测（`longNakedRest`）和 REST 验证路径不适用。Polymarket 的现金保护完全依赖 A-3 WS book retreat。

**分析**: 这是**有意设计** — Polymarket 有 WS 推送 book 更新用于实时 retreat，而 Predict 的无交易市场可能数分钟无 WS 推送。但值得在代码中显式注释。

---

### 🟡 S5: `forcedExitLimitPrice` 可能未被主流程调用

**文件**: `src/execution/cash-fill-exit-service.ts` 第 352 行

搜索结果显示 `force: true` 在整个 engine.ts 中从未调用 — daily-loss-limit killExit 使用 `force: false`（走 sellWithinLossCap 10%）。`forcedExitLimitPrice` 只在 `force === true` 时被调用（第 224 行）。

**建议**: 确认是否有其他调用路径（UI 手动操作？），若无，考虑标注 `@deprecated` 或删除以降低维护负担。

---

### 🟡 S6: `evaluateOrderCapital` 中 unreserved maker BUY 的余额检查较弱

**文件**: `src/risk/capital-risk.ts` 第 89-91 行

```typescript
if (isUnreservedPredictCashMakerBuy(config, intent)) {
  return { ok: true, message: 'Predict cash maker BUY ... 容量由 maxMarkets 控制', usage };
}
```

**分析**: unreserved maker 模式跳过余额充足性检查是设计意图（交易所不冻结保证金），但 `maxMarkets` 控制仅限于 Predict（`order-gate-service.ts` 第 161 行的 `isPredictCashMode`）。对于 Polymarket unreserved maker，没有对应的市场数量上限检查（Polymarket 的 maker 模式市场数由 scoring 自然限制）。这是有意的，但值得文档化。

---

## 4. 💭 Nit 级问题 (锦上添花)

### 💭 N1: 中英混杂的消息字符串
`engine.ts` 中 event message 有大量中文硬编码（如"检测到 WS user channel 断开过"、"同步平台开放订单"等），缺乏国际化支持。对于开源项目或国际用户不友好。

### 💭 N2: `capitalUsage()` 返回类型过于复杂
`CapitalUsage` 接口有 11 个字段，其中 4 个是可选的（`actualFrozenUsd?`, `reserveDriftUsd?`, `reserveDriftPct?`, `driftOk` 等）。考虑拆分为必选字段 + 可选扩展类型。

### 💭 N3: 魔法数字缺少常量
多处使用 `1e-9` 作为 EPSILON 比较精度（合理），但 `0.01` 作为默认 tick size 散落在多个文件中（`cash-fill-exit-service.ts:347`, `risk-engine.ts`, `market-data-sync.ts`）。建议提取为 `DEFAULT_TICK_SIZE = 0.01`。

### 💭 N4: `withCancelServiceTimeout` 函数重复
`cancel-service.ts` 第 852 行注释承认"Inline copy of market-data-sync.ts's withTimeout"，且注释说"Kept private here... to avoid even a hint of a circular dependency"。建议提取到 `src/utils/` 消除重复。

### 💭 N5: `publicRouteCandidate` 函数中 `.slice(0, 8)` 硬编码
`route-service.ts` 第 543 和 544 行的 `.slice(0, 8)` 限制了输出数组长度，但没有解释为什么是 8。

---

## 5. 模块交互分析

### 5.1 A-2 / A-3 与 Cycle 的三方竞态

```
┌─────────────────────────┐
│   Cycle (runOnce)       │
│   ~16-20s per iteration │
├─────────────────────────┤
│ 1. sync positions       │
│ 2. account risk gate    │
│ 3. cancel guarded       │
│ 4. build intents        │──┐
│ 5. cancel replaceable   │  │
│ 6. acquireProtectLock ──┼──┼── 三方互斥
│ 7. quote place          │  │
│ 8. releaseProtectLock   │  │
└─────────────────────────┘  │
                             │
┌─────────────────────────┐  │
│ A-2: protectOnFill      │──┤
│ (WS trade event)        │  │
├─────────────────────────┤  │
│ → dedupe (fill Set)     │  │
│ → acquireProtectLock ───┼──┘
│ → cancel all + exit     │
│ → release               │
└─────────────────────────┘

┌─────────────────────────┐
│ A-3: protectOnBookUpdate│
│ (WS book push)          │
├─────────────────────────┤
│ → dedupe (book Set)     │── 独立 dedupe
│ → shouldRetreatThinFront│
│ → acquireProtectLock ───┼──  与 Cycle/A-2 互斥
│ → cancel specific       │
│ → release               │
└─────────────────────────┘
```

**正确性评估**: 三方通过 `acquireProtectLock` Promise 链互斥，A-2 和 A-3 使用独立的 dedupe Set（6c72e04 修复），设计正确。`lastWsProtectAt` 时间戳在 lock 内设置，在 lock 内读取，避免了 TOCTOU 竞态。

**潜在改进**: 在高频 WS 事件场景下，连续的 `acquireProtectLock` 调用会形成 Promise 链，但每步都是微秒级操作，不会堆积。

### 5.2 风险决策链路

```
evaluateAccountRisk()
  ├── snapshot undefined         → reject
  ├── snapshot stale            → reject (snapshot-stale)
  ├── equity-based dailyPnl    → 优先
  │   └── equityUsd - dayStartEquityUsd
  ├── realizedPnlUsd backup    → 双重保险（跳过 fallback estimate）
  └── equityDrawdown           → maxDailyLossUsd 比较

→ EvaluateOrderCapital()       ← 订单级
  ├── reserveDrift 检查
  ├── unreserved maker 跳过余额检查
  └── spendableUsd / inventory 检查

→ RiskEngine.evaluate()        ← 订单级
  ├── market guard (时间/盘口)
  ├── stale book
  ├── BBO crossing
  ├── position exposure
  └── open order limit
```

**正确性评估**: 三层防护 (account → capital → order) 合理。`equityPnlUsd` 中对 `equity <= 0` 的拒绝是正确的 — 0 权益是数据读取失败的标志，不是真实权益。

---

## 6. 性能分析

### 6.1 核心循环瓶颈

| 阶段 | 典型耗时 | 瓶颈来源 |
|------|---------|---------|
| syncOpenOrders (REST) | ~1.2s | 交易所 API |
| syncPositions (REST) | ~1-3s | 交易所 API（与订单同步串行以避免 rate limit） |
| accountRiskGate | ~2-5s | 完整成交历史拉取 + 权益计算 |
| marketDataSync (full) | ~8-12s | 候选市场发现 + 批量 orderbook REST |
| cancelReplaceableOrders | ~0.1-0.5s | 纯计算 + REST verify（罕见） |
| quoteCycleService | ~0.5-1s | 订单提交 |

**Fast tick 优化**: 当 `fast=true`，跳过 marketDataSync full scan，仅用 WS 缓存 re-pin 活动市场 → 总循环时间从 ~16s 降至 ~2s。这是关键的架构优化，正确实现了。

### 6.2 内存使用

- `marketCache`：Map<string, {ts, markets}> — 按交易所存储，每个 ~500KB
- `orderbookCache`：Map<string, Map<string, Orderbook>> — 按交易所+token 存储，每个 token ~2KB
- `protectLocks`：Map<VenueName, Promise> — 每交易所一个，可忽略
- `protectingFillTokens` / `protectingBookTokens`：Map<VenueName, Set<string>> — 临时标记，随 WS 事件即时清理

**无内存泄漏风险**。所有 Map 和 Set 都有明确的清理路径。

---

## 7. 安全性评估

### 7.1 密钥管理
`SignerProvider` 通过 `src/secrets/` 模块管理，密钥文件加密存储（AES-256-GCM），口令仅在内存中持有。代码层面未发现密钥泄漏路径。

### 7.2 输入验证
- WS 解析 (`parsePolymarketTrade`): 严格验证 fillId、price、size 字段，拒绝无效数据
- Config schema (`schema.ts`): Zod 验证所有配置参数
- HTTP 错误: 统一通过 `httpErrorDetails` 捕获，不会泄漏内部状态

### 7.3 资金安全
多层止损体系确保单日最大亏损可控：
- `maxDailyLossUsd` (配置: $8) — 硬性止损
- `cashMaxExitLossPct` (10%) — 退出止损上限
- `polymarketMaxLossUsd` — Polymarket 专用止损
- `liquidationMaxSlippageCents` — 强制退出滑点上限

---

## 8. 代码质量亮点

值得称赞的设计和实现：

1. **A-2/A-3 dedupe 分离**: `protectingFillTokens` 和 `protectingBookTokens` 两个独立 Set，防止 book retreat 事件吞噬 fill stop-loss（6c72e04 修复的生产事故）
2. **protectOnly 降级模式**: 持仓 API 不可用时仍维护现有挂单，不新增但也不裸奔
3. **killExit 循环 + exitOnlyMode**: 止损触发后持续循环直到持仓清零，不会"止损停机后没卖完剩仓"
4. **unreservedMaker 跳过 planReplaceRaceDefer**: 正确识别 Polymarket/Predict 的保证金模型差异，消除 16s 订单缺口
5. **余额快照的零值检测**: `equityPnlUsd` 对 `equity <= 0` 的拒绝逻辑非常精巧 — 0 权益意味着数据源故障而非真实余额
6. **multi-maker fill 校正**: `parsePolymarketTrade` 从 `maker_orders` 提取机器人实际份额，避免 14.8x fill size 膨胀
7. **防御性编程**: 大量 try-catch + fallback 机制，WS 读取器永不崩溃

---

## 9. 问题优先级汇总

| 编号 | 问题 | 严重度 | 影响 | 修复难度 |
|------|------|--------|------|---------|
| B1 | REST verify 串行阻塞 | 🔴 中高 | 罕见场景下撤单延迟 | 中 |
| B2 | protectOnBookUpdate 注释矛盾 | 🔴 低 | 冷启动理论风险 | 低 |
| B3 | hasFreshReplacementIntent 命名 | 🔴 低 | 维护性 | 低 |
| S1 | dedupe add/delete 时序 | 🟡 低 | 极端边缘情况 | 低 |
| S2 | fingerprint sort 缺 tokenId | 🟡 极低 | 理论非确定性 | 低 |
| S3 | reserveDrift OR vs AND | 🟡 低 | 设计意图不明确 | 低 |
| S4 | isCashProtectedBuyOrder 仅 Predict | 🟡 无 | 设计选择，文档不足 | 低 |
| S5 | forcedExitLimitPrice 死代码 | 🟡 无 | 维护负担 | 低 |
| S6 | Polymarket unreserved maxMarkets | 🟡 低 | 容量控制不统一 | 中 |

---

## 10. 总体评价

**代码质量**: ⭐⭐⭐⭐½ (4.5/5)

这是一个**高质量的自动化交易系统实现**，展示了深厚的工程素养：

**优势**:
- 防御性编程超前 — 多层止损、降级模式、dedupe、锁机制一应俱全
- 生产经验丰富 — A-2/A-3 dedupe 分离、fill 校正、planReplaceRaceDefer 跳过等修复印证了真实生产反思
- 架构清晰 — 两个交易所完全独立，新增交易所只需添加 adapter
- 可观测性强 — 丰富的 forensic logging、checkpoint、structured events

**改进空间**:
- 函数命名一致性（B3）
- 串行 REST 调用性能（B1）
- 部分死代码清理（S5）
- 文档/注释补充（B2, S3, S4）

**结论**: 代码库整体健康，未发现会导致资金损失或系统崩溃的严重 bug。3 个 Blocker 级问题均为边缘场景或代码可维护性相关，5 个 Suggestion 级问题为优化建议。核心交易逻辑经过充分的生产验证，设计决策有明确的问题驱动背景。

---

*审查基于对以下文件的深入分析:*
- `src/execution/engine.ts` (1096 行) — 核心循环编排
- `src/execution/cancel-service.ts` (865 行) — 撤单与保护逻辑
- `src/execution/cash-fill-exit-service.ts` (406 行) — 成交退出
- `src/execution/polymarket-user-stream-handler.ts` (253 行) — WS 成交处理
- `src/execution/account-sync.ts` (268 行) — 账号同步
- `src/execution/route-service.ts` (552 行) — 路由选择
- `src/execution/order-gate-service.ts` (256 行) — 订单门控
- `src/risk/account-risk.ts` (160 行) — 账户风险决策
- `src/risk/capital-risk.ts` (207 行) — 资金风险评估
- `src/risk/risk-engine.ts` (104 行) — 订单风险引擎
- `src/risk/market-guard.ts` (309 行) — 市场保护
- `src/strategy/strategy-engine.ts` (206 行) — 策略引擎
- `src/config/schema.ts` (部分) — 配置模式
- `src/execution/liquidation-service.ts` (部分) — 清算服务
- `src/execution/market-data-sync.ts` (部分) — 市场数据同步
