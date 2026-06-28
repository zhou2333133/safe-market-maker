# Polymarket 流动性过滤 — 四阶段修正计划

> 目标：在路由阶段过滤低流动性/虚假深度/高波动市场，防止瞬时扫单被吃
> 三层过滤机制：guard-skip 累积计数 / 价差×深度比率 / negRisk 深度折扣

---

## 第一阶段：全局影响分析

### 1.1 文件清单按模块分类

```
【修改层 — 3 个文件】
  src/config/schema.ts                        配置 Schema（新增 3 个 knob）
  src/risk/market-guard.ts                    市场守卫（增强盘口评估）
  src/strategy/market-router.ts               路由评分（新增历史波动检查）

【调用链 — 不受修改影响】
  src/execution/route-service.ts              → 委托 market-router，不直接改
  src/execution/market-data-sync.ts           → guard-skip 事件已记录，无需改
  src/execution/engine.ts                     → 不涉及路由逻辑
  src/risk/reject-reasons.ts                  → 现有 reason_code 够用，无需改
  src/strategy/rewards/common.ts              → assessMarket 不变
  src/strategy/rewards/factory.ts             → 奖励优化器不变

【场地层 — 完全不受影响】
  src/venues/polymarket.ts                    独立
  src/venues/polymarket-ws.ts                 独立
  src/venues/predict.ts                       独立
  src/venues/predict-ws.ts                    独立
  src/venues/types.ts                         公共接口（不修改）

【UI 层 — 完全不受影响】
  src/ui/*.ts                                 全部不修改

【Store 层 — 完全不受影响】
  src/store/sqlite.ts                         不修改（guard-skip 数据已存在）

【策略层 — 完全不受影响】
  src/strategy/strategy-engine.ts             不修改
  src/strategy/paired-inventory.ts            不修改
  src/strategy/market-discovery.ts            不修改
```

### 1.2 依赖关系映射（修改涉及的 import 链路）

```
schema.ts  ← market-guard.ts  ← market-router.ts  ← route-service.ts
     ↑            ↑                  ↑
     │            │                  ├── rewards/common.ts (assessMarket 不变)
     │            │                  ├── rewards/factory.ts (createRewardOptimizer 不变)
     │            │                  ├── rewards/polymarket-competition.ts (competition 不变)
     │            │                  └── paired-inventory.ts (inv groups 不变)
     │            │
     │            └── domain/types.ts (Market, Orderbook 不变)
     │            └── venues/normalize.ts (bestBidAsk 不变)
     │
     └── 被所有文件 import（类型引用不修改）
```

**跨模块影响评估：**

| 修改点 | 影响范围 | Polymarket | Predict | 共享 |
|--------|---------|-----------|---------|------|
| `schema.ts` 新增 knob | 类型层面 | 可配 | 可配 | ✅ 共享 |
| `market-guard.ts` 增强评估 | 路由前检查 | 过滤生效 | 不过滤 | ✅ 共享 |
| `market-router.ts` 新增检查 | 路由评分 | 过滤生效 | 不受影响 | ✅ 共享 |

Predict 不受影响的关键：三层过滤都依赖 `market-guard` 的 `depth-collapse`/`spread-blowout` 等 guard-skip 事件。Predict 市场 guard-skip 模式不同（更少），且 Predict 的 `evaluateMarketGuard` 参数在 Predict 路由中不调用 `spreadWithinLimits`（Predict 有自己的奖励带检查）。实际运行中 Predict 市场 guard-skip 次数远低于 Polymarket。

### 1.3 回归风险点排查

**受影响的事件类型（仅新增，不修改已有）：**
- `risk.market-guard.route-reject` — 可能新增拒绝原因字符串
- `orderbook.guard-skip` — 不修改（已有数据被查询，不改写入）

**不受影响的已有流程：**
- A-2 WS 成交保护 (protectOnFill)
- A-3 WS 盘口保护 (protectOnBookUpdate)
- 成交断路器 (fill-circuit-breaker)
- 现金止损退出 (cash-fill-exit)
- 余额/风控/账户同步
- UI 渲染和状态更新
- 启动自检 (startup-facts)

**边界条件：**
- `guard-skip` 事件历史为空 → 默认允许（`recentSkips=0`）
- 盘口不存在 → 跳过三层检查（已被现有 `!book` → `missing-bbo` 覆盖）
- negRisk 字段缺失 → 默认 `false`（不打折）
- 价差未定义 → 跳过比率检查

---

## 第二阶段：逐文件修正计划

### 修正优先级（依赖顺序）

```
1. config/schema.ts          ← 底层：类型定义
2. risk/market-guard.ts      ← 底层：守卫增强
3. strategy/market-router.ts ← 上层：路由过滤
```

### 2.1 `config/schema.ts` — 新增配置字段

**位置**：`risk` 区块内（与 `minDepthUsdPerSide`、`maxSpreadBps` 并列）

```diff
+ // 流动性质量过滤：guard-skip 累积门控（最近 N 分钟同一 token 被跳过 M 次即拒绝）
+ marketGuardSkipWindowMs: z.number().nonnegative().default(300000),  // 5 分钟窗口
+ marketGuardSkipMaxCount: z.number().int().nonnegative().default(2), // 2 次即拒绝
+ 
+ // 流动性质量过滤：negRisk 市场深度折扣率（0-1，默认 60%）
+ negRiskDepthDiscount: z.number().min(0).max(1).default(0.6),
```

**影响**：只新增，不修改已有字段。两个场地均可配但 Predict 默认不触发（guard-skip 少）。

### 2.2 `risk/market-guard.ts` — 增强盘口深度评估

**位置**：`evaluateMarketGuard` 函数内，`depth-collapse` 检查之后

现有 `depth-collapse` 只检查 `minDepthUsdPerSide: 25`（过低）。需要增加：

```diff
   if (metrics.bidDepthUsd < config.risk.minDepthUsdPerSide || metrics.askDepthUsd < config.risk.minDepthUsdPerSide) {
     return block('depth-collapse', ...);
   }
+  // 第二层：价差×深度比率过滤（防空心深度）
+  // 价差 > 600bps 时，要求买盘深度至少 = 价差(bps) × 0.5 USD
+  // 例如：1132 bps 需要 $566 买盘，$495 不过关
+  if (metrics.spreadBps !== undefined && metrics.spreadBps > config.risk.maxSpreadBps) {
+    const requiredDepth = metrics.spreadBps * 0.5;
+    const effectiveBidDepth = market.negRisk
+      ? metrics.bidDepthUsd * (config.risk.negRiskDepthDiscount ?? 0.6)
+      : metrics.bidDepthUsd;
+    if (effectiveBidDepth + 1e-9 < requiredDepth) {
+      return block('depth-collapse',
+        `盘口买盘深度不足：${effectiveBidDepth.toFixed(0)} USD (价差 ${metrics.spreadBps.toFixed(0)}bps 要求 ${requiredDepth.toFixed(0)} USD)` +
+        (market.negRisk ? '，negRisk 深度已打折' : ''),
+        { metrics });
+    }
+  }
```

**不改动**：已有 `spreadWithinLimits`、`spread-jump`、`price-jump` 逻辑。

### 2.3 `strategy/market-router.ts` — 新增 guard-skip 累积检查

**位置**：`rankMarketRoutes` 函数内，`riskFlags` 收集区

```diff
   const riskFlags = [...assessment.riskFlags];
   const reasons = [...assessment.reasons];
+  
+  // 第三层：guard-skip 累积计数（防反复报警的市场）
+  // 查询 store 中该 token 在最近 N 分钟内的 guard-skip 次数
+  if (config.risk.marketGuardSkipMaxCount > 0 && book) {
+    const skipWindowMs = config.risk.marketGuardSkipWindowMs;
+    const recentSkipCount = store?.countRecentGuardSkips?.(
+      venue, market.tokenId, skipWindowMs
+    ) ?? 0;
+    if (recentSkipCount >= config.risk.marketGuardSkipMaxCount) {
+      riskFlags.push(
+        `盘口质量不稳定：最近 ${Math.round(skipWindowMs/60000)} 分钟被市场守卫拦截 ${recentSkipCount} 次，流动性不可靠`
+      );
+    }
+  }
```

**需要的能力**：store 需要新增一个轻量方法 `countRecentGuardSkips`。

### 2.4 `store/sqlite.ts` — 新增查询方法（可选）

如果 `market-router` 需要查询 store：

```diff
+  countRecentGuardSkips(venue: VenueName, tokenId: string, windowMs: number): number {
+    const cutoff = Date.now() - windowMs;
+    const stmt = this.db.prepare(
+      `SELECT COUNT(*) FROM events WHERE venue = ? AND type = 'orderbook.guard-skip' AND message = ? AND ts > ?`
+    );
+    const row = stmt.get(venue, tokenId, cutoff) as { 'COUNT(*)': number } | undefined;
+    return row ? row['COUNT(*)'] : 0;
+  }
```

---

## 第三阶段：边界与异常处理

### 3.1 空值/异常状态覆盖

| 场景 | 处理方式 |
|------|---------|
| `book` 为 `undefined` | 前两层被已有 `missing-bbo` 覆盖；第三层 `if (book)` 短路 |
| `book.bids` 为空数组 | `bidDepthUsd = 0` → 触发已有 `depth-collapse` |
| `spreadBps` 为 `undefined` | 跳过第二层比率检查 |
| `metrics.mid` 为 `undefined` | 被已有 `missing-bbo` 覆盖 |
| `market.negRisk` 为 `undefined` | `?? false` 默认非 negRisk，不打折 |
| `config.risk.negRiskDepthDiscount` 未设置 | `?? 0.6` 默认 60% |
| `config.risk.marketGuardSkipMaxCount` 为 0 | 第三层关闭（向后兼容） |
| `store` 未传入 router | `store?.countRecentGuardSkips?.() ?? 0` 安全默认 |
| 首次启动无历史 guard-skip | 返回 0，不拦截 |

### 3.2 类型安全校验

| 类型 | 来源 | 校验 |
|------|------|------|
| `market.negRisk: boolean` | `domain/types.ts` Market 接口 | 已存在，无需修改 |
| `metrics.spreadBps: number` | `market-guard.ts` bookMetrics | 已计算，直接使用 |
| `metrics.bidDepthUsd: number` | `market-guard.ts` bookMetrics | 已计算（top 3 档），不变 |
| `VenueName` | `domain/types.ts` | `'polymarket' \| 'predict'` |
| `config.risk.*` | `schema.ts` | Zod 校验保证类型 |

---

## 第四阶段：验证与收尾

### 4.1 修正后自检清单

- [ ] TypeScript 编译通过 (`tsc --noEmit`)
- [ ] Kate Marshall 市场在校验下被拒（日志可见拒绝原因）
- [ ] 东京 24°C / Tyler Robinson 等健康市场不受影响
- [ ] Polymarket WS 保护链无中断
- [ ] Predict 路由选择不受影响
- [ ] VPS 编译通过 + 重启正常

### 4.2 两个场地一致性确认

| 检查项 | Polymarket | Predict | 一致？ |
|--------|-----------|---------|-------|
| guard-skip 累积计数 | ✅ 生效（事件多） | ✅ 存在（事件少） | ✅ |
| 价差×深度比率 | ✅ 生效（价差宽） | ⚠️ 较少触发 | ✅ |
| negRisk 深度折扣 | ✅ 生效 | ⚠️ Predict 无 negRisk 市场 | ✅ |
| 已有路由逻辑 | 不变 | 不变 | ✅ |
| A-2/A-3 保护 | 不变 | 不变 | ✅ |
| 配置字段 | 共用 Schema | 各自可配 | ✅ |

### 4.3 无遗漏引用点确认

搜索全仓确认所有 `evaluateMarketGuard` 调用点：
- `market-data-sync.ts` — guard-skip 事件记录，不受影响
- `market-router.ts` — 路由检查，会使用增强后的 guard
- `cancel-service.ts` — 撤单检查，会使用增强后的 guard
- `order-gate-service.ts` — 订单门控，会使用增强后的 guard
- `submit-guard.ts` — 提交前检查，会使用增强后的 guard
- `route-service.ts` — 路由服务，委托 market-router
- `split-entry-service.ts` — 拆分入场，委托 market-router
- `startup-facts.ts` — 启动检查，不受影响
- `risk-engine.ts` — 风控引擎，委托 market-guard

所有调用点都通过 `MarketGuardDecision` 接口返回 `ok: boolean`，增强后的 guard 只改变了判定条件，接口不变。
