# Safe Market Maker — 全面安全性审核报告

> 审核日期：2026-06-27  
> 审核范围：完整代码库（安全相关核心模块）  
> 审核方法：静态代码分析 + 架构审查

---

## 总体评估

**安全等级：良好（B+）**

这是一个整体安全意识较强的项目。加密实现遵循 OWASP 2025 标准，密钥管理有专用的多层保护机制，日志脱敏覆盖全面，配置验证使用了严格的 Zod schema。发现了 2 个高风险问题、5 个中等风险问题和 5 个低风险问题。高风险的实质影响有限（项目是本地运行的 CLI 工具），但在某些部署场景下需要修复。

---

## 一、输入验证

### 🟡 中危 #1：WebSocket 消息解析缺乏对恶意载荷的类型防护

**位置**：  
- `src/venues/polymarket-ws.ts:463-489`（市场频道消息处理）
- `src/venues/polymarket-ws.ts:347-369`（用户频道消息处理）
- `src/venues/predict-ws.ts`（Predict WebSocket 消息处理）

**发现**：WebSocket 消息在 `JSON.parse()` 后使用 `safeJson()` 函数（它捕获 JSON 解析异常），然后对每个事件对象进行字段提取。但 `safeJson()` 只检查 JSON 语法正确性，不验证消息结构和类型。攻击者如能劫持 WebSocket 连接（例如通过中间人攻击），可以注入精心构造的 JSON 载荷，触发下游逻辑异常。

```typescript
// polymarket-ws.ts:463
private onMessage(data: WebSocket.RawData): void {
  const parsed = safeJson(data.toString());  // 只验证 JSON 语法，不验证结构
  // ...
}
```

**实际风险**：中等。WebSocket 连接使用 WSS（加密传输），中间人攻击难度高。但代码中没有对消息结构做 Zod 校验这一点，在防御纵深上是个缺口。

**修复建议**：
1. 为每种 WebSocket 消息类型定义 Zod schema
2. 在 `safeJson()` 之后使用 `.safeParse()` 校验关键字段
3. 对不通过 schema 校验的消息静默丢弃并记录日志

---

### 🟡 中危 #2：HTTP 响应反序列化缺乏类型安全保障

**位置**：`src/venues/http.ts:36-61`（`httpJsonOnce` 函数）

**发现**：`httpJsonOnce` 将 HTTP 响应用 `safeParseJson` 解析后，直接通过 `as T` 进行类型断言返回。没有对返回数据的结构做任何运行时校验。如果 Polymarket 或 Predict API 返回了意料之外的数据结构，错误会在远离数据入口的地方以难以调试的方式暴露。

```typescript
// http.ts:57
return payload as T;  // 强制类型断言，无运行时校验
```

**实际风险**：低至中等。调用方依赖 TypeScript 编译时类型，但外部 API 的契约可能随时间变化。

**修复建议**：
1. 对关键 API 响应（订单簿、持仓、余额）使用 Zod schema 做运行时校验
2. 校验失败时抛出明确的错误，包含原始载荷用于调试

---

### 💭 低危 #3：UI 请求体 JSON 解析后未做进一步类型校验

**位置**：`src/ui/server.ts:341-357`（`readJson` 函数）

**发现**：请求体被限制为 1MB，通过 `JSON.parse()` 解析后返回 `unknown` 类型。各 API 端点（`query-controller.ts`）通过辅助函数（`requiredString`、`parseBoolean`、`parseTradingMode` 等）进行字段提取和校验，这种做法总体良好。但未对照 schema 做全量校验，理论上可能出现字段缺失时的意外默认值。

**实际风险**：极低。UI 仅绑定到 127.0.0.1，无法从外部访问。同一机器上的其他进程攻击是唯一的向量。

**修复建议**：为每个 API 端点的请求体定义 Zod schema，在 `readJson` 之后统一校验。当前的手动字段提取已足够安全，此建议仅作为工程实践的改进。

---

## 二、认证与授权

### ✅ 整体评估：良好

该项目是一个本地 CLI 工具，不涉及传统意义上的多用户登录/会话管理。但发现以下需要关注的点：

### 🟡 中危 #4：UI 令牌通过内联 JavaScript 明文分发

**位置**：  
- `src/ui/server.ts:134`（`uiToken = randomBytes(32).toString('hex')`）
- `src/ui/assets.ts:9-15`（`appScript` 函数将令牌内联）

**发现**：UI 服务器的 CSRF 保护依赖一个 256 位随机令牌（`uiToken`），通过 `x-safe-mm-ui-token` 头部传递。这个令牌在服务器端生成后，通过 `/app.js` 响应内联注入为 JavaScript 变量 `UI_TOKEN`。任何能读取 `/app.js` 内容的东西都可以获取这个令牌。

```typescript
// assets.ts:9
export function appScript(uiToken: string): string {
  return `'use strict';
const UI_TOKEN = ${JSON.stringify(uiToken)};
${clientScript}`;
}
```

服务端有双重保护——同源检查（`isOriginAllowed`）在令牌校验之前执行：

```typescript
// server.ts:311-319
if (!isOriginAllowed(req, serverInfo)) {
  throw new UiError(403, 'UI 同源校验失败。请从本机 UI 页面操作。');
}
const token = req.headers['x-safe-mm-ui-token'];
if (token !== uiToken) throw new UiError(403, 'UI token 校验失败。请从本机 UI 页面操作。');
```

**实际风险**：中等。令牌泄露的途径包括：
- 同一台机器上的其他进程可以读取 `http://127.0.0.1:8787/app.js`
- 浏览器扩展可以注入页面读取 `UI_TOKEN` 变量
- 如果用户意外配置了远程访问且未正确配置防火墙

建议的改进方案是将令牌改为每次页面加载时重新生成（类似传统 CSRF token 模式），而不是在 `/app.js` 中静态内联。

---

### 💭 低危 #5：UI 远程访问开关缺乏额外保护

**位置**：`src/ui/server.ts:127-129`

**发现**：`--allow-remote-ui` 标志一旦设置，会将 UI 服务器绑定到所有网络接口。此时同源检查（Origin/Referer）仍然是有效的，但存在以下风险：
- 如果用户也获得了 `uiToken`（例如通过网络嗅探或屏幕共享），就可以从远程发送交易指令
- 没有基于 IP 的白名单或速率限制来限制远程访问

**实际风险**：低。这需要用户主动启用远程访问且令牌同时被泄露。

**修复建议**：
1. 当 `allowRemote` 为 true 时，添加 IP 白名单配置选项
2. 对远程 mutation 端点添加请求速率限制
3. 在日志中明确记录所有远程 mutation 操作的来源 IP

---

### ✅ 已正确实现的安全措施

- 私钥签名者使用 Proxy 阻止 `.privateKey`、`.signingKey`、`.mnemonic` 的直接读取（`src/secrets/signer.ts:30-47`）
- SDK 钱包方法返回经过 Proxy 包装的对象，防止 SDK 内部代码意外暴露私钥
- keystore 文件使用 AES-256-GCM 加密存储，需口令才能解密
- 终端密码输入使用掩码（`*` 回显），防止肩窥（`src/secrets/prompt.ts`）

---

## 三、敏感数据处理

### 🔴 高危 #6：config.yaml 中存放明文 API 密钥

**位置**：`config.yaml:108`

```yaml
predict:
  apiKey: b4dc9873-3a25-481d-be2d-ab6fd975cc15
```

**发现**：Predict.fun 的 API 密钥以明文形式硬编码在 `config.yaml` 中。虽然 `config.yaml` 在 `.gitignore` 中（排除了意外提交），但该文件在本地文件系统中以明文存在。

**影响**：
- 任何有权访问文件系统的进程/用户都可以读取此密钥
- 备份工具可能复制明文密钥
- 如果 `.gitignore` 被错误修改，密钥可能被提交到版本控制

**修复建议**：
1. 将 `apiKey` 移入加密的 keystore 系统（使用与私钥相同的 AES-256-GCM 加密）
2. 或通过环境变量 `SAFE_MM_PREDICT_API_KEY` 注入
3. 修改 `assertNoRawSecrets` 函数，将 `apiKey` 加入禁止明文名单
4. 在 `saveConfig` 中自动将 config 中的明文密钥迁移到 keystore 并清空 YAML 中的值

---

### 🟡 中危 #7：本地主密钥安全性依赖文件系统权限

**位置**：`src/secrets/runtime.ts:142-149`

```typescript
function runtimeMasterKey(dataDir: string): string {
  const target = runtimeMasterKeyPath(dataDir);
  if (existsSync(target)) return readFileSync(target, 'utf8').trim();
  mkdirSync(path.dirname(target), { recursive: true });
  const key = randomBytes(32).toString('hex');
  writeFileSync(target, key, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return key;
}
```

**发现**：本地主密钥（`local-master.key`）设置为 `0o600` 权限（仅所有者可读写），这是一个良好的实践。但它是一个 32 字节（64 字符十六进制）的纯文本文件，存储在 `.safe-mm/runtime-secrets/` 目录中。获得此文件的攻击者可以解密所有本地加密的运行时钱包。

**实际风险**：中等。在单用户系统上影响有限；在共享系统或多用户服务器上（如果用户以 root 运行），其他用户可能绕过文件权限。

**修复建议**：
1. 在 Windows 上考虑使用 DPAPI（数据保护 API）加密主密钥
2. 在 macOS 上考虑使用 Keychain 存储
3. 在 Linux 上考虑使用 `secret-tool`（libsecret）或 kernel keyring
4. 至少添加启动时的权限检查日志，如果文件权限不是 `0o600` 则发出警告

---

### ✅ 已正确实现的安全措施

- **AES-256-GCM 认证加密**（`src/secrets/crypto.ts`）：使用标准的 Node.js crypto 模块，带认证标签防止篡改
- **Scrypt 密钥派生**：v2 使用 N=131072，符合 OWASP 2025 推荐标准
- **时间恒定比较**（`constantTimeEqual`）：防止时序侧信道攻击
- **全面脱敏**（`src/observability/redact.ts`）：
  - Bearer 令牌：`Bearer [REDACTED]`
  - JWT 令牌：`[REDACTED_JWT]`
  - 64 字符十六进制私钥：`[REDACTED_HEX]`
  - 根据键名自动脱敏（private_key、secret、passphrase 等）
  - 递归脱敏对象、数组、Error 对象
  - 循环引用检测和防护
- **Keystore 加密存储**（`src/secrets/keystore.ts`）：私钥和凭证在写入磁盘前加密
- **禁止在配置文件中写入明文密钥**（`src/config/schema.ts:253-272`）：`assertNoRawSecrets()` 递归扫描配置，检测 private_key、mnemonic、seed_phrase 等禁止键
- **CI 自动密钥扫描**（`scripts/secret-scan.mjs`）：扫描私钥赋值、JWT token、Polymarket secret 等模式
- **法务日志中的日志脱敏**（`src/observability/logger.ts`）：所有日志条目在写入前通过 `redact()` 处理

---

## 四、依赖安全

### 🟡 中危 #8：第三方依赖缺乏持续漏洞监控

**位置**：`package.json`、`.github/workflows/ci.yml`

**发现**：CI 中运行了 `npm audit --audit-level=moderate`，这是一个良好的基础实践。但：

1. **无 Dependabot / Renovate 配置**：没有自动化的依赖更新 PR
2. **无 SBOM 生成**：没有软件物料清单
3. **依赖锁定不完整**：只有 `package.json`，没有 `package-lock.json` 在版本控制中？需要确认

**实际风险**：中等。第三方 SDK（`@polymarket/clob-client-v2`、`@predictdotfun/sdk`）如果发现漏洞，缺乏自动化的通知和更新机制。

**关键依赖概览**：

| 依赖 | 用途 | 风险关注 |
|---|---|---|
| `ethers@6.15.0` | 钱包管理/签名 | 核心安全依赖，需关注 CVE |
| `viem@2.52.2` | 以太坊交互 | 核心安全依赖，需关注 CVE |
| `better-sqlite3@11.7.0` | 本地数据库 | 本地文件，影响范围有限 |
| `ws@8.20.1` | WebSocket | 网络攻击面 |
| `axios@1.17.0` | HTTP 客户端 | 通过 `overrides` 统一版本 |
| `@polymarket/clob-client-v2@1.0.6` | CLOB 交易 | 第三方，需关注更新 |
| `@predictdotfun/sdk@1.2.8` | Predict API | 第三方，需关注更新 |

**修复建议**：
1. 在 CI 中添加 `npm outdated` 检查
2. 配置 Dependabot 或 Renovate 自动更新依赖
3. 对核心安全依赖（ethers、viem、ws）锁定最小版本
4. 将 `npm audit` 级别提升为 `--audit-level=high`（或同时运行 moderate 和 high）

---

### 💭 低危 #9：ESLint 允许 any 类型可能削弱类型安全

**位置**：`eslint.config.js`

**发现**：根据探索结果，ESLint 配置中 `@typescript-eslint/no-explicit-any: off`。这允许在代码中使用 `any` 类型，可能引入运行时类型错误，尤其是在处理外部 API 数据时。

**实际风险**：低。不影响运行时安全，但降低了代码的自我保护能力。

**修复建议**：考虑启用 `no-explicit-any` 规则（设置为 `warn` 级别），逐步减少 `any` 的使用。

---

## 五、错误处理

### ✅ 整体评估：良好

### 💭 低危 #10：法务日志文件可能无限增长

**位置**：`src/observability/forensic-log.ts`、`src/store/sqlite.ts:16`

**发现**：法务日志（forensic JSONL）设计为 3 天自动清理，SQLite 数据 7 天自动清理。这在正常情况下足够。但如果磁盘空间极低，日志写入失败时是静默的（catch 块为空），用户不会收到磁盘空间不足的警告。

```typescript
// forensic-log.ts:44-46
} catch {
  /* forensic logging must never break the bot */
}
```

**实际风险**：低。只有在极端磁盘空间不足的情况下才可能丢失审计记录。

**修复建议**：在 catch 块中至少记录一条控制台警告，告知用户磁盘问题。

---

### ✅ 已正确实现的安全措施

- **错误消息过滤**（`src/observability/error-message.ts`）：
  - 截断超过 260 字符的错误消息
  - 移除长十六进制交易数据
  - 移除交易数据（`transaction="[交易数据已隐藏]"`）
  - 对 HTTP 401/403 返回不含具体凭据的通用消息
  - 区分地理封锁错误和认证错误，提供不同的用户引导
- **HTTP 错误体脱敏后再抛出**（`src/venues/http.ts:54-55`）：响应体通过 `redact()` 处理后包装为 `HttpError`
- **未处理拒绝防护**（`src/ui/server.ts:76-92`）：`installGlobalRejectionGuard` 在 60 秒内超过 20 次未处理拒绝时触发进程退出
- **404 和 500 的统一处理**（`src/ui/server.ts:138-149`）：所有未匹配的路由返回 404，所有异常返回 500 并通过 `publicErrorMessage()` 过滤
- **WebSocket 错误处理**：所有 WebSocket 消息解析和监听器回调都有 try/catch 包裹，防止单条坏消息导致连接断开

---

## 六、配置安全

### 🔴 高危 #11：config.yaml 中暴露账户地址和资助者地址

**位置**：`config.yaml:108-109`、`config.yaml:118`

```yaml
predict:
  apiKey: b4dc9873-...      # 明文 API 密钥
  accountAddress: "0xcE5a..." # 明文地址

polymarket:
  funderAddress: "0xC0E7..."  # 明文资助者地址
```

**发现**：虽然区块链地址本身不是秘密（可以在链上公开查询），但将其与 API 密钥、交易策略配置共同存储在同一个 YAML 文件中，会在文件泄露时暴露完整的攻击面信息。攻击者可以：
- 关联地址与交易策略参数
- 了解最大亏损限制、订单大小等风控参数
- 获得完整的账户画像用于社会工程攻击

**修复建议**：
1. 地址本身不需要加密，但应使用环境变量注入（`SAFE_MM_PREDICT_ADDRESS`）
2. 最关键的是修复 #6（API 密钥明文存储）

---

### ✅ 已正确实现的安全措施

- **严格 CSP 头部**（`src/ui/server.ts:373`）：
  ```
  default-src 'self'; script-src 'self'; style-src 'self';
  connect-src 'self'; img-src 'self' data:;
  base-uri 'none'; frame-ancestors 'none'; form-action 'none'
  ```
- **安全响应头部完整**：
  - `X-Content-Type-Options: nosniff`
  - `Referrer-Policy: no-referrer`
  - `X-Frame-Options: DENY`
  - `Cache-Control: no-store`（所有响应）
- **Loopback 绑定默认策略**（`src/ui/server.ts:127-129`）：非本地绑定需要显式 `--allow-remote-ui`
- **端点白名单默认拒绝**（`src/config/schema.ts:291-298`）：所有外部端点 URL 必须通过白名单验证
- **所有外部连接强制 HTTPS/WSS**（`src/config/schema.ts` 中各 URL 的 `.url()` 校验）
- **Zod 强类型配置验证**：所有数值范围约束、枚举约束、模式约束
- **场所参数完全隔离**（`polymarketParams` / `predictParams`）：修改一个场所的参数不会影响另一个
- **实盘双重开关**（`src/config/live-enabled.ts`）：全局 `liveEnabled` AND 场馆级 `liveEnabled` 都为 true 时才启用
- **UI 单例锁**（`src/ui/server.ts:376-441`）：基于 PID 的文件锁防止多个 UI 实例竞争
- **配置文件保存时自动清除非本场地字段**（`src/config/load.ts:50-64`）：防止跨场地配置污染
- **config.yaml 变更审计**（`src/ui/server.ts:200-241`）：配置文件修改时记录 SHA256 哈希和元数据到事件表

---

## 🔢 问题统计

| 严重等级 | 数量 | 编号 |
|---|---|---|
| 🔴 高危 | 2 | #6（明文 API 密钥），#11（敏感配置集中） |
| 🟡 中危 | 5 | #1（WS 消息结构校验），#2（HTTP 响应类型安全），#4（UI 令牌内联分发），#7（主密钥文件权限），#8（依赖漏洞监控） |
| 💭 低危 | 4 | #3（UI 请求体校验），#5（远程访问保护），#9（any 类型安全），#10（法务日志磁盘警告） |

---

## 🛡️ 安全亮点

以下设计和实现值得肯定：

1. **AES-256-GCM + Scrypt 加密**：符合 OWASP 2025 标准的密钥存储方案
2. **私钥 Proxy 保护**：通过 JavaScript Proxy 创新性地阻止 SDK 和外部代码意外读取私钥
3. **全面递归脱敏**：支持对象、数组、错误、循环引用的递归脱敏，覆盖 Bearer/JWT/十六进制私钥三种格式
4. **端点白名单默认拒绝**：所有外部 API 调用必须通过预定义白名单，降低 SSRF 风险
5. **严格 CSP + 安全头部**：UI 服务器设置了完整的浏览器安全策略
6. **CI 密钥扫描 + npm audit**：自动化安全检查流程
7. **错误消息多层过滤**：面向用户的错误经过长度截断、敏感数据替换、分类引导
8. **双场馆安全隔离**：Polymarket 和 Predict 的配置、参数、状态完全隔离
9. **未处理拒绝风暴防护**：防止异常传播导致进程静默卡死
10. **配置文件变更审计**：每次 `config.yaml` 修改都记录哈希用于事后追溯

---

## 📋 修复优先级建议

### 立即修复（本周）
- **#6**：将 `predict.apiKey` 迁移到加密 keystore 或环境变量

### 尽快修复（本月）
- **#1**：为 WebSocket 消息定义 Zod schema 校验
- **#4**：考虑 UI 令牌的动态轮换机制
- **#7**：调研平台原生密钥存储（DPAPI/Keychain/keyring）
- **#8**：配置 Dependabot/Renovate 自动依赖更新

### 计划修复（下季度）
- **#2**：为关键 API 响应添加选择性运行时校验
- **#5**：添加远程访问 IP 白名单和速率限制
- **#10**：添加磁盘空间不足的日志警告
- **#3, #9, #11**：工程实践改进，不影响实际安全
