export const appHtmlMarkup = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>积分收益优化机器人</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <div class="shell">
    <aside class="sidebar" aria-label="主导航">
      <div class="brand">
        <div class="brand-mark" aria-hidden="true">MM</div>
        <div>
          <h1>积分收益优化机器人</h1>
          <p id="connectionText">Local console</p>
        </div>
      </div>
      <nav class="nav" aria-label="视图">
        <button class="nav-item active" data-view="dashboard" type="button" title="Predict 流动性积分做市">Predict</button>
        <button class="nav-item" data-view="polymarket" type="button" title="Polymarket 单边做市">Polymarket</button>
        <button class="nav-item" data-view="markets" type="button" title="候选市场池">市场池</button>
        <button class="nav-item" data-view="risk" type="button" title="风控诊断">诊断</button>
      </nav>
      <div class="guardrail">
        <span class="dot"></span>
        <span>实盘控制台，操作前预检</span>
      </div>
    </aside>

    <main class="main">
      <header class="topbar">
        <div>
          <p class="eyebrow">本机实盘控制台</p>
          <h2 id="pageTitle">Predict</h2>
        </div>
        <button id="refreshBtn" class="icon-btn" type="button" title="刷新">↻</button>
      </header>

        <section id="alertBox" class="alert hidden" role="status"></section>

      <section class="view active" id="view-dashboard">
        <section class="live-command-bar" aria-label="实盘状态与操作">
          <div class="command-status">
            <span id="liveBadge" class="status-badge idle">未启动</span>
            <div>
              <strong id="commandHeadline">等待启动</strong>
              <p id="commandSubline">检查启动条件后再开始实盘。</p>
            </div>
          </div>
          <div class="command-kpis">
            <div><span>开放订单</span><strong id="commandOpenOrders">0</strong></div>
            <div><span>挂单占用</span><strong id="commandExposure">$0.00</strong></div>
            <div><span>挂单亏损</span><strong id="commandOrderLoss">$0.00</strong></div>
            <div><span>本轮风控</span><strong id="commandRisk">未同步</strong></div>
            <div><span>最近错误</span><strong id="commandError">无</strong></div>
          </div>
          <div id="unlockRow" class="unlock-row">
            <span class="unlock-icon" id="unlockIcon">🔒</span>
            <input id="unlockPassphrase" type="password" placeholder="keystore 密码" autocomplete="off">
            <button id="unlockBtn" class="primary-btn" type="button" onclick="event.preventDefault();unlockVenue()">解锁</button>
            <span id="unlockLabel" style="font-size:13px;color:#8b7355"></span>
          </div>
          <div class="command-actions" id="commandActions">
            <button id="startLiveBtn" class="primary-btn" type="button" title="开始实盘监控">开始实盘</button>
            <button id="startupFactsBtn" class="secondary-btn" type="button" title="检查启动条件">启动检查</button>
            <button id="refreshBalanceBtn" class="secondary-btn" type="button" title="刷新余额">刷新余额</button>
            <button id="stopLiveBtn" class="secondary-btn" type="button" title="停止实盘监控，保留开放订单">停止监控</button>
            <button id="stopCancelBtn" class="danger-btn" type="button" title="停止实盘并撤掉机器人开放订单">停止并撤单</button>
          </div>
          <div class="command-context">
            <input type="hidden" id="liveVenue" value="predict">
            <div class="live-detail compact-live-detail" id="liveDetail">本页只控制 Predict;Polymarket 在上方独立标签页,互不影响</div>
          </div>
        </section>

        <section class="overview-layout" aria-label="实盘概览">
          <div class="overview-main">
            <div class="current-order-card" aria-live="polite">
              <div>
                <span>单边 PP 篮子覆盖</span>
                <strong id="routeOrderState">未挂单</strong>
                <p id="currentOrderHint">以平台开放订单接口为准，按 101 份 PP/hr/kUSD 资金效率从高到低维护。</p>
              </div>
              <div class="target-order-box">
                <span>评分目标</span>
                <strong id="routeOrderSize">-</strong>
                <p id="currentOrderNext">当前 cash 模式按真实单笔金额筛选奖励最低份额+1，金额不足不会挂单。</p>
              </div>
              <div id="pairLegGrid" class="basket-grid">
                <article class="pair-leg empty">
                  <span>篮子目标</span>
                  <strong>等待目标市场</strong>
                  <p>启动后显示 rank、方向、价格、101 份评分金额、expected PP 和真实挂单状态。</p>
                </article>
              </div>
            </div>
            <div id="routePanel" class="route-panel" aria-live="polite">
              <div class="route-primary">
                <span>当前最佳低竞争机会</span>
                <strong id="routeMarket">等待第一轮扫描</strong>
                <p id="routeReason">启动后按 101 份单边订单进入奖励带后的 PP/hr/kUSD 资金效率排序。</p>
              </div>
              <div class="route-stats">
                <div><span>目标覆盖</span><strong id="routeTime">-</strong></div>
                <div><span>最佳资金效率</span><strong id="routePp">-</strong></div>
                <div><span>竞争深度</span><strong id="routeDepth">-</strong></div>
                <div><span>盘口/全站榜</span><strong id="routeSpread">-</strong></div>
                <div class="wide-stat"><span>执行榜/缺口</span><strong id="routeCompetition">-</strong></div>
              </div>
            </div>

            <section id="ppEstimatePanel" class="pp-estimate-panel" aria-label="预计 PP 获得" aria-live="polite">
              <div class="pp-estimate-main">
                <span>今日预计 PP</span>
                <strong id="ppTodayEstimate">-</strong>
                <p id="ppEstimateBasis">等待路由后，按当前篮子 101 份评分口径估算。</p>
              </div>
              <div class="pp-estimate-stats">
                <div><span>24h 预计</span><strong id="ppDailyProjection">-</strong></div>
                <div><span>实挂 / 目标速率</span><strong id="ppHourlyEstimate">-</strong></div>
                <div><span>北京时间</span><strong id="ppDayProgress">-</strong></div>
              </div>
            </section>

            <section class="proof-panel" aria-label="全站最优证明">
              <div class="proof-head">
                <div>
                  <span>全站最优证明</span>
                  <strong id="proofHeadline">等待路由审计</strong>
                  <p id="proofSubline">用当前滚动盘口缓存证明执行篮子和全站效率榜的关系。</p>
                </div>
                <button id="routeAuditBtn" class="secondary-btn" type="button" title="手动全站审计">审计</button>
              </div>
              <div class="proof-metrics">
                <div><span>覆盖率</span><strong id="proofCoverage">-</strong></div>
                <div><span>榜单/路由</span><strong id="proofMatch">-</strong></div>
                <div><span>缺失盘口</span><strong id="proofFailed">-</strong></div>
                <div><span>来源/时间</span><strong id="proofSource">-</strong></div>
              </div>
              <div id="proofList" class="proof-list">
                <div class="empty">有路由审计数据后，这里会显示执行 Top20 与全站效率 Top20 的差距。</div>
              </div>
            </section>

            <div class="bot-activity" aria-live="polite">
              <div class="bot-activity-main">
                <span>机器人动态</span>
                <strong id="botActivityHeadline">等待启动</strong>
                <p id="botActivityNext">这里只显示启动、选市场、下单、撤换、错误等关键动作。</p>
              </div>
              <div class="stage-strip" aria-live="polite">
                <div><span>当前阶段</span><strong id="stageState">idle</strong></div>
                <div><span>阶段说明</span><strong id="stageMessage">等待实盘循环</strong></div>
                <div><span>最近拒绝原因</span><strong id="rejectSummary">暂无</strong></div>
              </div>
            </div>
            <div id="botActivityList" class="bot-activity-list"></div>
          </div>

          <aside class="overview-side">
            <div id="startupFactsCard" class="startup-card pending" aria-live="polite">
              <div class="startup-main">
                <span>启动检查摘要</span>
                <strong id="startupSummary">还没有检查</strong>
                <p id="startupHint">点击“检查启动条件”，这里会显示预计单边篮子、库存、余额和风控结果。</p>
              </div>
              <details class="startup-details">
                <summary>查看检查细节</summary>
                <div class="startup-grid">
                  <div><span>预计实际挂单</span><strong id="startupExpected">未检查</strong></div>
                  <div><span>资金</span><strong id="startupFunds">未检查</strong></div>
                  <div><span>买入资金</span><strong id="startupBuy">未检查</strong></div>
                  <div><span>双边卖单</span><strong id="startupSell">未检查</strong></div>
                  <div><span>库存</span><strong id="startupInventory">未检查</strong></div>
                  <div class="wide-stat gas-address-row"><span>BNB 手续费充值地址</span><strong id="startupGasAddress">未检查</strong></div>
                  <div><span>完整套仓入口</span><strong id="startupSplitEntry">未检查</strong></div>
                  <div><span>账户风控</span><strong id="startupRisk">未检查</strong></div>
                  <div><span>PP 最低份额</span><strong id="startupRewardMinimum">未检查</strong></div>
                  <div class="wide-stat"><span>结算保护</span><strong id="startupSettlement">未检查</strong></div>
                </div>
              </details>
            </div>

            <div class="account-summary-card">
              <div><span>实盘状态</span><strong id="metricLiveStatus">未启动</strong></div>
              <div><span>开放订单</span><strong id="metricOpenOrders">0</strong></div>
              <div><span>余额</span><strong id="metricBalanceSummary">未刷新</strong></div>
              <div><span>本轮风控</span><strong id="metricAccountRisk">未同步</strong></div>
              <div><span>PP 路由</span><strong id="metricRouteMode">自动</strong></div>
              <div><span>最近错误</span><strong id="metricRecentError">无</strong></div>
              <div class="signer-row"><span>签名来源</span><strong id="runtimeSignerStatus">运行时私钥</strong><small>本机运行密钥，仅用于当前机器人签名。</small></div>
            </div>
            <div id="orderRiskCard" class="order-risk-card idle" aria-live="polite">
              <div class="order-risk-main">
                <span>挂单亏损估算</span>
                <strong id="orderRiskLoss">$0.00</strong>
                <p id="orderRiskHint">当前没有开放订单；有挂单后这里会显示占用金额、最坏亏损估算和止损余量。</p>
              </div>
              <div class="order-risk-grid">
                <div><span>挂单占用</span><strong id="orderRiskExposure">$0.00</strong></div>
                <div><span>开放订单</span><strong id="orderRiskOpenCount">0 笔</strong></div>
                <div><span>止损余量</span><strong id="orderRiskRemaining">未知</strong></div>
                <div><span>方向拆分</span><strong id="orderRiskBreakdown">BUY $0.00 / SELL $0.00</strong></div>
              </div>
            </div>
            <div id="balanceList" class="balance-list compact-balance">
              <div class="empty">点击“刷新余额”读取真实账户余额</div>
            </div>
          </aside>
        </section>


          <!-- Predict 实时积分报告 -->
          <div id="predictReport" class="predict-report-section" aria-live="polite"></div>

        <section class="panel strategy-console cockpit-settings" aria-label="策略参数">
          <div class="strategy-console-head">
            <div>
              <p class="eyebrow">Cash 单边 PP</p>
              <h3>策略控制台</h3>
              <p id="settingsSummaryText">按当前单笔金额筛选最低份额+1，从全站低竞争机会里维护挂单篮子。</p>
            </div>
            <button id="saveTradingBtn" class="primary-btn" type="button">保存参数</button>
          </div>
          <div class="core-setting-grid">
            <label class="core-field">
              <span>Predict 实盘开关</span>
              <input id="settingPredictLiveEnabled" type="checkbox">
            </label>
            <label class="core-field">
              <span>同时总挂单数量</span>
              <input id="settingMaxMarkets" type="number" min="1" max="100" step="1">
            </label>
            <label class="core-field">
              <span>单笔挂单金额 USD</span>
              <input id="settingOrderSize" type="number" min="1" step="1">
            </label>
            <label class="core-field">
              <span>退出亏损上限 %</span>
              <input id="settingCashMaxExitLossPct" type="number" min="0" max="100" step="1">
            </label>
            <label class="core-field">
              <span>本轮总止损 USD</span>
              <input id="settingMaxDailyLossUsd" type="number" min="0.01" step="1">
            </label>
            <label class="core-field">
              <span>盘口维护容忍时长 ms（0=默认 15s，安静市场推荐 60000）</span>
              <input id="settingPredictCashBuyStaleGraceMs" type="number" min="0" max="300000" step="5000">
            </label>
            <label class="core-field">
              <span>前方保护深度 USD（推荐 200）</span>
              <input id="settingPredictFrontDepthUsd" type="number" min="0" max="10000000" step="10">
            </label>
            <label class="core-field">
              <span>快速重报价间隔 ms（0=禁用，推荐 500）</span>
              <input id="settingPredictFastQuoteMs" type="number" min="0" max="60000" step="100">
            </label>
            <label class="core-field">
              <span>完整循环间隔 ms（推荐 30000）</span>
              <input id="settingPredictFullCycleMs" type="number" min="0" max="600000" step="1000">
            </label>
            <label class="core-field">
              <span>竞争拥挤阈值（0=禁用，推荐 250）</span>
              <input id="settingPredictCrowdedThreshold" type="number" min="0" max="10000" step="10">
            </label>
          </div>
        </section>

        <div class="content-grid live-log-grid">
          <details class="panel orders-details">
            <summary>
              <span>
                <strong>最近订单</strong>
                <small>当前真实挂单看首屏；这里保留历史订单记录。</small>
              </span>
              <em>展开</em>
            </summary>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>平台</th>
                    <th>挂单位置</th>
                    <th>方向</th>
                    <th>价格</th>
                    <th>数量</th>
                    <th>状态</th>
                  </tr>
                </thead>
                <tbody id="ordersBody"></tbody>
              </table>
            </div>
          </details>

          <details class="panel log-details">
            <summary>
              <span>
                <strong>诊断日志</strong>
                <small>需要排错时再展开，主流程只看上面的目标市场、挂单状态和机器人动态。</small>
              </span>
              <em>展开</em>
            </summary>
            <div id="eventsList" class="event-list" aria-live="polite"></div>
          </details>
        </div>
      </section>

      <section class="view" id="view-markets">
        <div class="toolbar">
          <label>
            <span>平台</span>
            <select id="marketVenue">
              <option value="predict">Predict.fun</option>
              <option value="polymarket">Polymarket</option>
            </select>
          </label>
          <label>
            <span>数量</span>
            <input id="marketTop" type="number" min="1" max="20" value="5">
          </label>
          <label>
            <span>最低市场流动性 USD</span>
            <input id="marketMinLiquidity" type="number" min="0" step="1000" value="0">
          </label>
          <label>
            <span>LP 奖励等级</span>
            <select id="marketMinRewardLevel">
              <option value="4">4 级以上</option>
              <option value="5">只看 5 级</option>
              <option value="3">3 级以上</option>
              <option value="2">2 级以上</option>
              <option value="1">1 级以上</option>
              <option value="0">不限等级</option>
            </select>
          </label>
          <label class="check-row toolbar-check">
            <input id="marketPointsOnly" type="checkbox" checked>
            <span>只看积分市场</span>
          </label>
          <label class="check-row toolbar-check">
            <input id="marketAcceptingOnly" type="checkbox" checked>
            <span>只看可交易</span>
          </label>
          <button id="loadMarketsBtn" class="primary-btn" type="button">加载推荐</button>
          <button id="applyMarketsBtn" class="secondary-btn" type="button">应用推荐</button>
        </div>
        <div class="module-strip">
          <article>
            <strong>Predict.fun 积分模块</strong>
            <span>重点看 pp 星级、Boost、最低份额、奖励价差窗口和盘口新鲜度。</span>
          </article>
          <article>
            <strong>Polymarket Rewards 模块</strong>
            <span>重点看 daily rewards rate、min size、max spread、队列深度和 neg-risk 风险。</span>
          </article>
        </div>
        <div id="marketList" class="market-list"></div>
      </section>

      <section class="view" id="view-risk">
        <section id="storeStatusPanel" class="store-status-panel" aria-live="polite">
          <div class="store-status-item">
            <span>事件总数</span>
            <strong id="storeEventCount">0</strong>
            <p>SQLite 里记录的运行事件、风控拒绝和同步结果。</p>
          </div>
          <div class="store-status-item">
            <span>最新检查点</span>
            <strong id="storeLastCheckpointLabel">暂无</strong>
            <p id="storeLastCheckpointTime">还没有写入 checkpoint。</p>
          </div>
          <div class="store-status-item">
            <span>当前阶段</span>
            <strong id="storeCurrentStage">idle</strong>
            <p id="storeCurrentStageMessage">等待实盘循环。</p>
          </div>
        </section>
        <section class="panel risk-status-panel">
          <div class="panel-head">
            <div>
              <h3>本轮账户风控</h3>
              <p>这里显示从本次开始实盘后统计的成交、仓位、余额和权益判断；数据不可用或过期时禁止新增挂单。</p>
            </div>
            <span id="riskStatusBadge" class="status-badge idle">未同步</span>
          </div>
          <div id="accountRiskGrid" class="risk-grid"></div>
        </section>
        <div class="content-grid">
          <section class="panel">
            <div class="panel-head">
              <h3>风控参数</h3>
              <span class="tag">config.yaml</span>
            </div>
            <div id="riskGrid" class="explain-grid"></div>
          </section>
          <section class="panel">
            <div class="panel-head">
              <h3>运行策略</h3>
              <span class="tag">Strategy</span>
            </div>
            <div id="strategyGrid" class="explain-grid"></div>
          </section>
        </div>
      </section>

      <section class="view" id="view-polymarket">
        <section class="live-command-bar" aria-label="Polymarket 实盘状态与操作">
          <div class="command-status">
            <span id="plLiveBadge" class="status-badge idle">未启动</span>
            <div>
              <strong id="plHeadline">Polymarket 单边做市</strong>
              <p id="plSubline">先在下方设置参数并保存,再开始实盘。只在达 $1/日官方门槛的市场挂单。</p>
            </div>
          </div>
          <div class="command-kpis">
            <div><span>实时余额</span><strong id="plBalanceLive">-</strong></div>
            <div><span>挂单 / 名义</span><strong id="plOpenOrders">0</strong></div>
            <div><span>今日预计奖励</span><strong id="plKpiReward">-</strong></div>
            <div><span>最近错误</span><strong id="plError">无</strong></div>
          </div>
          <div class="command-actions">
            <button id="plStartBtn" class="primary-btn" type="button" title="开始 Polymarket 单边做市实盘">开始实盘</button>
            <button id="plStartupBtn" class="secondary-btn" type="button" title="只读检查启动条件">启动检查</button>
            <button id="plStopBtn" class="secondary-btn" type="button" title="停止监控,保留开放订单">停止监控</button>
            <button id="plStopCancelBtn" class="danger-btn" type="button" title="停止并撤掉机器人开放订单">停止并撤单</button>
          </div>
        </section>

        <div id="polymarketReport" class="predict-report-section" aria-live="polite"></div>

        <section class="panel">
          <div class="panel-head">
            <div>
              <h3>Polymarket 单边做市参数</h3>
              <p>单边挂买(BUY)做市赚流动性奖励。改完点保存,下一轮生效。真要下单需 funder / 私钥 / 首次链上授权,开实盘预检会拦。</p>
            </div>
            <div class="btn-row">
              <button id="grantPolyApprovalsBtn" class="ghost-btn" type="button" title="首次一次性:给两个 V2 exchange 授权 pUSD + CTF(链上交易,由你点击发起)。已授权过可忽略。">首次链上授权(一次性)</button>
              <button id="savePolymarketBtn" class="primary-btn" type="button">保存参数</button>
            </div>
          </div>
          <div class="core-setting-grid">
            <label class="core-field"><span>Polymarket 实盘开关</span><input id="settingPolymarketLiveEnabled" type="checkbox"></label>
            <label class="core-field"><span>单笔挂单金额 USD</span><input id="settingPolymarketOrderSize" type="number" min="1" step="1"></label>
            <label class="core-field"><span>挂单起始挡位(1=最前,越大越安全)</span><input id="settingPolymarketStartLevel" type="number" min="1" max="20" step="1"></label>
            <label class="core-field"><span>前方保护深度 USD(至少这么多挡在你前面)</span><input id="settingPolymarketFrontDepthUsd" type="number" min="0" step="10"></label>
            <label class="core-field"><span>做市市场数量(设几个就挂几个 · 上限约 7-8)</span><input id="settingPolymarketMaxMarkets" type="number" min="1" max="50" step="1"></label>
            <label class="core-field"><span>本金止损全退 USD(全局最大亏损)</span><input id="settingPolymarketMaxLossUsd" type="number" min="0" step="1"></label>
            <label class="core-field"><span>平仓亏损上限 %(被吃后按此卖出)</span><input id="settingPolymarketCashMaxExitLossPct" type="number" min="0" max="100" step="1"></label>
            <label class="core-field"><span>快速重报价间隔 ms(越小越贴第2档)</span><input id="settingPolymarketFastQuoteMs" type="number" min="0" max="60000" step="100"></label>
          </div>
          <p class="hint">单边挂买做市:机器人按「单笔金额」自动筛「最低有效份额 ≤ 你金额」的市场并选其中最优,保持在指定挡位、前方至少保护深度。$1/天·单市场是官方硬规则(自动遵守);盘口安全等其余参数按全网实时行情自动取默认,无需手填。</p>
          <p class="hint">⚠ 用 VPN 注意:Polymarket 封锁美国及受限地区。若切到受限地区,下单会失败 —— 具体原因(地区受限 / 认证 / 网络)会显示在上方「最近错误」。下单突然全部失败时,先检查 VPN 地区。</p>
        </section>

        <section class="panel" aria-live="polite">
          <div class="panel-head">
            <div>
              <h3>单边做市状态</h3>
              <p id="plStatusSubline">显示当前/最优市场、预计日奖励是否达 $1 官方门槛、挂单挡位与前方保护、止损距离。</p>
            </div>
          </div>
          <div class="pl-status-grid">
            <div><span>当前 / 最优市场</span><strong id="plMarket">-</strong></div>
            <div><span>预计日奖励</span><strong id="plExpectedReward">-</strong></div>
            <div><span>$1 官方门槛</span><strong id="plBalance">-</strong></div>
            <div><span>挂单挡位 / 前方保护</span><strong id="plPerLeg">-</strong></div>
            <div><span>竞争度</span><strong id="plCompetition">-</strong></div>
            <div><span>资金利用率</span><strong id="plUtilization">-</strong></div>
            <div><span>本金止损全退</span><strong id="plLossStop">-</strong></div>
            <div><span>状态 / 原因</span><strong id="plReadiness">-</strong></div>
          </div>
          <div id="plLegGrid" class="basket-grid">
            <article class="pair-leg empty"><span>当前挂单</span><strong>等待达标市场</strong><p>选中达 $1/日官方门槛的市场后,这里显示这条 BUY 挂单的价格、份额、距中价和真实状态。</p></article>
          </div>
        </section>

        <section class="panel">
          <div class="panel-head">
            <div>
              <h3>Polymarket 日志</h3>
              <p>只显示 Polymarket 的启动、选市、挂单、撤换、成交、错误等关键事件。</p>
            </div>
            <button id="plRefreshBtn" class="icon-btn" type="button" title="刷新">↻</button>
          </div>
          <div id="plEventsList" class="event-list" aria-live="polite"></div>
        </section>
      </section>
    </main>
  </div>

  <script src="/app.js"></script>
</body>
</html>`;
