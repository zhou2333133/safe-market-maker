export const clientRenderStatusScript = String.raw`
function renderStatus(payload) {
  state.lastPayload = payload;
  $('connectionText').textContent = payload.server.host + ':' + payload.server.port;
  const venue = $('liveVenue').value;
  const live = payload.live[venue] || { status: 'idle', cycles: 0 };
  const liveEnabled = liveEnabledForVenue(payload, venue);
  const walletReady = Boolean(payload.config.wallets[venue]);
  const runtimeSigner = payload.config.runtime && payload.config.runtime.signer ? payload.config.runtime.signer[venue] : null;
  const runtimeSignerReady = Boolean(runtimeSigner && runtimeSigner.available);
  const runtimeCredentialReady = Boolean(payload.config.runtime && payload.config.runtime.credentials && payload.config.runtime.credentials[venue]);
  const storedCredentialReady = venue === 'predict' ? Boolean(payload.config.credentials.predictJwt) : Boolean(payload.config.credentials.polymarketClob);
  const credentialReady = runtimeCredentialReady || storedCredentialReady;
  const signerReady = runtimeSignerReady;
  const selected = Number(payload.config.selectedMarkets[venue] || 0);
  $('metricLiveStatus').textContent = liveStatusLabel[live.status] || live.status;
  $('metricLiveStatus').className = live.status === 'running' ? 'live-on' : live.status === 'error' ? 'danger-text' : '';
  if ($('metricLiveVenue')) $('metricLiveVenue').textContent = venueLabel[venue];
  renderBalanceSummary(payload, venue);
  renderOpenOrderRisk(payload, venue);
  $('metricOpenOrders').textContent = payload.store.openOrders;
  $('metricRouteMode').textContent = payload.config.strategy.autoSelectMarkets ? '自动选优' : selected + ' 个手动';
  const apiReady = venue === 'predict' ? Boolean(payload.config.venues.predict.apiKeyConfigured) : true;
  const signerText = runtimeSignerReady
    ? runtimeSigner.label
    : walletReady
      ? '缺运行时私钥（旧钱包文件不用于 UI）'
      : '缺运行时私钥';
  const credentialText = venue === 'predict'
    ? (credentialReady ? 'JWT已就绪' : '缺JWT')
    : (credentialReady ? 'CLOB已就绪' : '缺CLOB');
  if ($('metricWalletCredential')) {
    $('metricWalletCredential').textContent = venue === 'predict'
      ? (apiReady ? 'API已填' : '缺API') + ' / ' + signerText + ' / ' + credentialText
      : signerText + ' / ' + credentialText;
    const authError = venue === 'predict' && live.lastError && (String(live.lastError).includes('认证失败') || String(live.lastError).includes('未授权'));
    if (authError) $('metricWalletCredential').textContent += ' / 认证失败';
    $('metricWalletCredential').className = signerReady && credentialReady && !authError ? 'live-on' : 'danger-text';
  }
  if ($('runtimeSignerStatus')) {
    $('runtimeSignerStatus').textContent = runtimeSignerReady
      ? runtimeSigner.label + (runtimeSigner.address ? ' · ' + shortId(runtimeSigner.address) : '')
      : walletReady
        ? '未检测到运行时私钥；旧钱包文件不用于 UI 启动'
        : '未检测到运行时私钥';
    $('runtimeSignerStatus').className = runtimeSignerReady ? 'live-on' : 'danger-text';
  }
  $('metricRecentError').textContent = currentLiveError(live, payload.events || []) || '无';
  renderAccountRiskSummary(payload, venue);
  renderStoreStatus(payload, venue);
  renderLivePanel(live, venue, liveEnabled);
  renderCommandBar(payload, venue, live);
  renderStageAndRejects(payload, venue);
  renderBotActivity(payload, venue, live);
  renderRoutePanel(payload, venue);
  renderPpEstimatePanel(payload, venue, live);
  renderProofPanel(payload, venue);
  renderOrders(payload.orders || []);
  renderEvents(visibleEvents(payload.events || []));
  renderStaticConfigCards(payload);
  populateTradingSettings(payload);
  renderSettingsSummary(payload);
  renderPolymarketView(payload);
}

function plText(id, text) { const node = $(id); if (node) node.textContent = text; }
function polyBandLabel(band) { return { thin: '偏薄', balanced: '适中', crowded: '拥挤' }[band] || '未知'; }

function polyLegCard(leg, orders) {
  const m = leg.metrics || {};
  const open = (orders || []).filter((o) => o.venue === 'polymarket' && o.tokenId === leg.tokenId && (o.status === 'OPEN' || o.status === 'PENDING_OPEN'));
  const stateText = open.length > 0 ? '已挂 ' + open.length + ' 单' : '待挂';
  const budget = typeof m.targetOrderUsd === 'number' ? '$' + m.targetOrderUsd.toFixed(2) : '-';
  return '<article class="pair-leg"><span>' + (leg.outcome || 'leg') + ' · BUY</span><strong>' + budget + '</strong><p>' + stateText + ' · token ' + shortId(leg.tokenId) + '</p></article>';
}

// One card per ACTUAL live order (real placement), so multi-market over-resting shows every order with its real
// price/size/notional/status — not just the first selected market. Market name is looked up from route candidates.
function polyOrderCard(order, markets) {
  const ref = (markets || []).find((x) => x && x.tokenId === order.tokenId);
  const name = ref && ref.question ? ref.question : shortId(order.tokenId);
  const m = (ref && ref.metrics) || {};
  const px = typeof order.price === 'number' ? order.price : undefined;
  const sz = typeof order.size === 'number' ? order.size : undefined;
  const notional = px !== undefined && sz !== undefined ? '$' + (px * sz).toFixed(2) : '-';
  const st = order.status === 'OPEN' ? '已挂' : order.status === 'PENDING_OPEN' ? '挂单中' : order.status;
  const cls = order.status === 'OPEN' ? 'pair-leg' : 'pair-leg pending';
  // Per-order detail: front-protection depth + this market's projected daily reward, pulled from the matched candidate.
  const front = typeof m.rewardBandDepthUsd === 'number' ? '前方$' + Math.round(m.rewardBandDepthUsd) : '';
  const daily = typeof m.expectedPpPerHour === 'number' ? '~$' + (m.expectedPpPerHour * 24).toFixed(2) + '/天' : '';
  const extra = [front, daily].filter(Boolean).join(' · ');
  return '<article class="' + cls + '"><span>' + (order.side || 'BUY') + ' · ' + st + '</span><strong>' + notional
    + '</strong><p>价 ' + (px !== undefined ? px : '-') + ' · ' + (sz !== undefined ? sz.toFixed(1) : '-') + ' 份'
    + (extra ? ' · ' + extra : '') + ' · ' + escapeHtml(String(name).slice(0, 26)) + '</p></article>';
}

function renderPlEvents(payload) {
  const list = $('plEventsList');
  if (!list) return;
  const events = visibleEvents(payload.events || []).filter((e) => !e.venue || e.venue === 'polymarket' || e.local).slice(0, 30);
  list.innerHTML = '';
  if (events.length === 0) { list.innerHTML = '<div class="empty">暂无 Polymarket 日志</div>'; return; }
  for (const event of events) {
    const item = document.createElement('div');
    item.className = 'event ' + event.severity + (event.local ? ' local' : '');
    const label = eventLabel[event.type] || event.type;
    item.innerHTML = '<span>' + escapeHtml(label) + '</span><strong>' + escapeHtml(event.message) + '</strong><time>' + new Date(event.ts).toLocaleTimeString() + '</time>';
    list.appendChild(item);
  }
}

// Polymarket holdings report — mirrors the Predict 持仓报告 table (renderPredictReport) so the PL state is just as
// scannable: one row per live BUY order with price + which side, exit-loss per adverse cent, expected pt/h, your
// reward-band share, competing capital, crowding and capital efficiency. Metrics are matched from the live route
// candidates by tokenId; the shared helpers (competitionLabel / money / shortId) live in the same client bundle.
function renderPolymarketReport(payload) {
  const container = $('polymarketReport');
  if (!container) return;
  const plOpen = allUiOrders(payload).filter((o) => o.venue === 'polymarket' && (o.status === 'OPEN' || o.status === 'PENDING_OPEN'));
  const route = payload.route && payload.route.polymarket && payload.route.polymarket.value;
  const cands = route ? (route.candidates || []).concat(route.selected || []) : [];
  const byToken = new Map();
  for (const c of cands) { const t = c.tokenId || (c.market && c.market.tokenId); if (t && !byToken.has(t)) byToken.set(t, c); }
  if (plOpen.length === 0) {
    container.innerHTML = '<div class="panel"><div class="panel-title">Polymarket 持仓报告</div><div class="empty">暂无活跃挂单。达标市场出现后,这里按 Predict 报告同样的方式显示每笔 BUY 挂单的占比、竞争、资金效率和逃跑损失。</div></div>';
    return;
  }
  let totalDaily = 0;
  for (const o of plOpen) { const mm = (byToken.get(o.tokenId) || {}).metrics || {}; if (typeof mm.expectedPpPerHour === 'number') totalDaily += mm.expectedPpPerHour * 24; }
  const acct = (payload.accountLive && payload.accountLive.polymarket) || {};
  const sb = acct.stableBalanceUsd || {};
  const fresh = state.autoBalances && state.autoBalances.polymarket;
  const bal = fresh && Number.isFinite(fresh.usd) ? fresh.usd : (typeof sb.available === 'number' ? sb.available : undefined);
  const notional = plOpen.reduce((s, o) => s + ((typeof o.price === 'number' && typeof o.size === 'number') ? o.price * o.size : 0), 0);
  const wsh = payload.wsHealth && payload.wsHealth.polymarket && payload.wsHealth.polymarket.value;
  const wsBadge = wsh
    ? (wsh.connected
        ? ' | <span style="color:#98c379">WS🟢实时盘口 缓存' + (wsh.cachedOrderbooks || 0) + '/订阅' + (wsh.watchedMarkets || 0) + '</span>'
        : ' | <span style="color:#e06c75">WS🔴断线·REST兜底(盘口可能滞后→陈旧即撤)</span>')
    : '';
  let html = '<div class="panel"><div class="panel-title">Polymarket 持仓报告 | ' + plOpen.length + ' 个活跃 | 今日预计 $' + totalDaily.toFixed(2)
    + ' | 名义 $' + notional.toFixed(0) + (bal !== undefined ? ' / 余额 $' + bal.toFixed(0) : '') + wsBadge + '</div>';
  html += '<table class="report-table"><thead><tr><th>市场</th><th>方向</th><th>价格</th><th>逃跑损失/1c</th><th>预期 pt/h</th><th>占奖励带</th><th>竞争资金</th><th>拥挤度</th><th>资金效率</th><th>名义</th></tr></thead><tbody>';
  for (const o of plOpen) {
    const c = byToken.get(o.tokenId) || {};
    const m = c.metrics || {};
    const band = m.competitionBand;
    const bandClass = band === 'crowded' ? 'warn' : band === 'thin' ? 'muted' : band === 'balanced' ? 'ok' : '';
    const price = typeof o.price === 'number' ? o.price : undefined;
    const size = typeof o.size === 'number' ? o.size : undefined;
    const exitLoss = size !== undefined ? '$' + (size * 0.01).toFixed(2) : '---';
    const q = c.question || (c.market && c.market.question) || shortId(o.tokenId);
    const pp = typeof m.expectedPpPerHour === 'number' ? m.expectedPpPerHour : undefined;
    html += '<tr>';
    html += '<td>' + escapeHtml(String(q).slice(0, 42)) + '</td>';
    html += '<td><span class="pill buy">买 ' + escapeHtml(String(c.outcome || (c.market && c.market.outcome) || '')) + '</span></td>';
    html += '<td>' + (price !== undefined ? price.toFixed(3) : '---') + (price !== undefined && price >= 0.5 ? ' <span class="band ok">高价侧</span>' : '') + '</td>';
    html += '<td>' + exitLoss + '</td>';
    html += '<td><strong>' + (pp !== undefined ? pp.toFixed(2) : '---') + '</strong></td>';
    html += '<td>' + (typeof m.targetSharePct === 'number' ? m.targetSharePct.toFixed(2) + '%' : '---') + '</td>';
    html += '<td>' + money(m.rewardBandDepthUsd) + '</td>';
    html += '<td><span class="band ' + bandClass + '">' + competitionLabel(band) + '</span></td>';
    html += '<td>' + (typeof m.ppPerThousandUsd === 'number' ? m.ppPerThousandUsd.toFixed(2) + ' pt/k' : '---') + '</td>';
    html += '<td>$' + (price !== undefined && size !== undefined ? (price * size).toFixed(0) : '---') + '</td>';
    html += '</tr>';
  }
  html += '</tbody></table></div>';
  container.innerHTML = html;
}

function renderPolymarketView(payload) {
  const live = (payload.live && payload.live.polymarket) || { status: 'idle' };
  renderPolymarketReport(payload);
  const liveEnabled = liveEnabledForVenue(payload, 'polymarket');
  // Polymarket reads its OWN independent block (config.polymarketParams), never Predict's base strategy/risk —
  // otherwise the panel shows Predict's values (e.g. front depth 150) instead of the PL ones the user set (100).
  const plParams = payload.config.polymarketParams || {};
  const strat = plParams.strategy || payload.config.strategy || {};
  const route = payload.route && payload.route.polymarket && payload.route.polymarket.value;
  const selected = route && Array.isArray(route.selected) ? route.selected : [];
  const candidates = route && Array.isArray(route.candidates) ? route.candidates : [];
  const minDaily = Number(strat.polymarketMinDailyRewardUsd ?? 1);
  const startLevel = strat.polymarketStartLevel ?? 2;
  const frontDepth = strat.polymarketFrontDepthUsd ?? 150;
  const plOrderSize = (plParams.risk && plParams.risk.orderSizeUsd) || (payload.config.risk && payload.config.risk.orderSizeUsd) || '';
  const dailyOf = (c) => (c && c.metrics && typeof c.metrics.expectedPpPerHour === 'number') ? c.metrics.expectedPpPerHour * 24 : undefined;

  // Command bar: status, headline, KPIs, buttons
  const badge = $('plLiveBadge');
  if (badge) { badge.textContent = liveStatusLabel[live.status] || live.status; badge.className = 'status-badge ' + (live.status || 'idle'); }
  plText('plHeadline', strat.polymarketTestMode ? 'Polymarket 单边做市 · ⚠测试模式' : 'Polymarket 单边做市');
  plText('plSubline', live.status === 'running'
    ? '实盘运行中:只在预计日奖励达 $' + minDaily.toFixed(0) + ' 官方门槛的市场挂单(单边 BUY),保持在第 ' + startLevel + ' 挡、前方≥$' + frontDepth + ' 保护。'
    : !liveEnabled
      ? 'Polymarket 实盘开关关闭;在下方打开并保存后才允许启动。'
      : '已就绪;点"开始实盘"启动(首次需链上授权 + funder/私钥,预检会拦)。');
  const plOpen = allUiOrders(payload).filter((o) => o.venue === 'polymarket' && (o.status === 'OPEN' || o.status === 'PENDING_OPEN'));
  plText('plOpenOrders', String(plOpen.length));
  // Real-time balance + total resting notional (from the live account snapshot) — critical for over-resting so you can
  // see notional vs balance at a glance. Snapshot refreshes each live cycle; shows '-' before the first run today.
  const acct = (payload.accountLive && payload.accountLive.polymarket) || {};
  const sb = acct.stableBalanceUsd || {};
  // Prefer the silent auto-refreshed balance (state.autoBalances, ~30s) over the slower account snapshot, so the panel
  // shows a fresh figure even when the PL loop is idle — and so the status poll doesn't revert it to a stale value.
  const fresh = state.autoBalances && state.autoBalances.polymarket;
  const availUsd = fresh && Number.isFinite(fresh.usd) ? fresh.usd
    : (typeof sb.available === 'number' ? sb.available : undefined);
  plText('plBalanceLive', availUsd !== undefined
    ? '$' + availUsd.toFixed(2) + (!fresh && typeof sb.total === 'number' && Math.abs(sb.total - availUsd) > 0.01 ? ' / 总$' + sb.total.toFixed(2) : '')
    : '-(自动刷新中)');
  const openNotional = plOpen.reduce((s, o) => s + (typeof o.price === 'number' && typeof o.size === 'number' ? o.price * o.size : 0), 0);
  const overRest = availUsd !== undefined && availUsd > 0.01 && openNotional > availUsd + 0.01;
  // Merged KPI: "N 单 / $名义" (the separate 名义合计 KPI was removed to declutter). ⚠超额 only if notional > balance.
  plText('plOpenOrders', plOpen.length + ' 单' + (plOpen.length ? ' / $' + openNotional.toFixed(0) : '') + (overRest ? ' ⚠超额' + (openNotional / availUsd).toFixed(1) + '×' : ''));
  const errNode = $('plError');
  if (errNode) { errNode.textContent = live.lastError || '无'; errNode.className = live.lastError ? 'danger-text' : ''; }
  const startBtn = $('plStartBtn');
  if (startBtn && startBtn.dataset.busy !== 'true') {
    startBtn.textContent = startButtonText(live.status, liveEnabled);
    startBtn.title = startButtonTitle(live.status, liveEnabled);
    startBtn.disabled = (live.status === 'running' || live.status === 'stopping');
  }
  const stopBtn = $('plStopBtn'); if (stopBtn) stopBtn.disabled = (live.status === 'idle');

  // Settings-derived (plPerLeg repurposed to level/front-protection, plLossStop = principal stop)
  plText('plPerLeg', '第 ' + startLevel + ' 挡 · 前方≥$' + frontDepth + ' 保护');
  plText('plLossStop', Number(strat.polymarketMaxLossUsd || 0) > 0 ? '$' + Number(strat.polymarketMaxLossUsd).toFixed(2) + ' 触发即全退停机' : '未单独设置,用本轮总止损');

  // Pick the reference market to explain the current state. Prefer the selected one; else the best-expected
  // candidate that is actually QUOTABLE (tradable) — the headline candidates are often thin, high-expected but
  // unquotable markets, so falling back to best-any only when no tradable one exists keeps the panel honest.
  const chosen = selected.length > 0 ? selected[0] : undefined;
  let bestTradable, bestTradableD = -1, bestAny, bestAnyD = -1;
  for (const c of candidates) {
    const d = dailyOf(c); if (d === undefined) continue;
    if (d > bestAnyD) { bestAnyD = d; bestAny = c; }
    if (c.tradable && d > bestTradableD) { bestTradableD = d; bestTradable = c; }
  }
  const ref = chosen || bestTradable || bestAny;
  const refQuotable = Boolean(chosen) || Boolean(ref && ref.tradable);
  const legGrid = $('plLegGrid');
  // If there are ANY real live orders, always show them all (one card each) — the actual placed state takes priority
  // over the "best candidate" explainer, so multi-market over-resting is fully visible.
  const ordersHtml = plOpen.length > 0 ? plOpen.map((o) => polyOrderCard(o, candidates.concat(selected))).join('') : null;

  if (!ref) {
    plText('plMarket', live.status === 'running' ? '等待扫描达标市场' : '未启动');
    ['plExpectedReward', 'plBalance', 'plUtilization', 'plCompetition', 'plKpiReward', 'plKpiBalance'].forEach((id) => plText(id, '-'));
    const r = $('plReadiness');
    if (r) { r.textContent = live.status === 'running' ? '本轮全网无满足条件的市场(盘口/份额/$' + minDaily.toFixed(0) + '门槛),已暂停新增挂单' : '未启动'; r.className = ''; }
    if (legGrid) legGrid.innerHTML = ordersHtml ?? ('<article class="pair-leg empty"><span>当前挂单</span><strong>暂无</strong><p>选中达 $' + minDaily.toFixed(0) + '/日官方门槛的市场后,这里显示这条 BUY 挂单的价格、份额、距中价和真实状态。</p></article>');
    plText('plSubline', live.status === 'running'
      ? '● 运行中 · 本轮全网无满足条件市场(盘口/份额/$' + minDaily.toFixed(0) + ' 门槛),暂停新增'
      : (liveEnabled ? '已就绪 · 点「开始实盘」启动' : '实盘开关关闭 · 下方打开并保存后才能启动'));
    renderPlEvents(payload);
    return;
  }

  const expDaily = dailyOf(ref);
  const below = expDaily !== undefined && expDaily < minDaily;
  // A market only counts as "earning" when it is BOTH quotable and >= the $1 threshold. A high-expected but
  // unquotable market must not show green ("达标"), or the panel implies the bot should be placing when it can't.
  const earning = refQuotable && !below && expDaily !== undefined;
  plText('plMarket', (chosen ? '' : '【最优待选】') + (ref.question || shortId(ref.tokenId)));
  const rewardNode = $('plExpectedReward');
  if (rewardNode) {
    rewardNode.textContent = expDaily === undefined ? '-(待盘口)' : '$' + expDaily.toFixed(2) + '/日' + (refQuotable ? '' : '(盘口不可挂)');
    rewardNode.className = earning ? 'good-text' : (expDaily === undefined ? '' : 'danger-text');
  }
  // plBalance label repurposed to the $1 official threshold status (see HTML)
  const thr = $('plBalance');
  if (thr) {
    thr.textContent = !refQuotable ? '盘口不可挂(份额/价差/保护不足),$1 门槛无从谈起'
      : expDaily === undefined ? '门槛 $' + minDaily.toFixed(2) + '/日(待盘口)'
      : below ? '✗ 低于 $' + minDaily.toFixed(2) + '/日 → 官方不发,暂不挂单' : '✓ ≥ $' + minDaily.toFixed(2) + '/日 达标';
    thr.className = earning ? 'good-text' : 'danger-text';
  }
  plText('plKpiReward', expDaily === undefined ? '-' : '$' + expDaily.toFixed(2) + '/日');
  plText('plKpiBalance', !refQuotable ? '盘口不可挂' : expDaily === undefined ? '-' : (below ? '未达$' + minDaily.toFixed(0) : '已达标'));
  const eff = ref.metrics && ref.metrics.ppPerThousandUsd;
  plText('plUtilization', typeof eff === 'number' ? eff.toFixed(2) + ' /hr/kUSD' : '-');
  plText('plCompetition', polyBandLabel(ref.metrics && ref.metrics.competitionBand));

  // Reason the bot isn't placing: a quotable-but-sub-$1 market (raise order size / wait), vs the best market being
  // unquotable (book too thin / spread too wide for safe single-sided placement). Keeps the $30 dilemma explicit.
  const blockFlag = (ref.riskFlags && ref.riskFlags[0]) || '盘口/份额/门槛未满足';
  // The bot can't place yet for THREE distinct reasons — don't mislabel them all as "below $1":
  //  (a) audit gate still warming up (route reason mentions 全站审计/coverage) — temporary, auto-resolves;
  //  (b) the best quotable market is genuinely < $1/day (raise order size);
  //  (c) the best market is unquotable (book too thin/wide).
  const auditGate = route && typeof route.reason === 'string' && /审计|等待新鲜|覆盖/.test(route.reason);
  const r = $('plReadiness');
  if (r) {
    if (chosen) { r.textContent = '已选中并挂单,保持第 ' + startLevel + ' 挡;被吃即按平仓亏损上限退出'; r.className = 'good-text'; }
    else if (auditGate) { r.textContent = '全站审计覆盖率爬坡中(需 ≥60% 才挂;刚启动约 8-10 分钟),达标后自动开始挂单'; r.className = ''; }
    else if (refQuotable && below) { r.textContent = '最优可挂市场预计 <$' + minDaily.toFixed(2) + '/日 → 官方不发奖励,暂不挂单(提高单笔金额可改善)'; r.className = 'danger-text'; }
    else if (refQuotable) { r.textContent = '最优市场已达标,本轮在扫描/选市中,稍候自动挂单'; r.className = ''; }
    else { r.textContent = '高奖励市场盘口太薄无法安全挂单(' + blockFlag + ');流动市场竞争高、<$' + minDaily.toFixed(2) + '/日'; r.className = 'danger-text'; }
  }
  if (legGrid) {
    legGrid.innerHTML = ordersHtml ?? (chosen
      ? polyLegCard(chosen, allUiOrders(payload))
      : '<article class="pair-leg empty"><span>当前挂单</span><strong>暂无(' + (auditGate ? '审计爬坡中' : '等待达标') + ')</strong><p>' + (auditGate
        ? '全站审计覆盖率还没到 60%(刚启动约 8-10 分钟),达标后自动挂单,无需手动操作。'
        : refQuotable && below
          ? '最优可挂市场预计 ' + (expDaily === undefined ? '-' : '$' + expDaily.toFixed(2) + '/日') + ',未达 $' + minDaily.toFixed(2) + ' 官方门槛 —— 挂了一分不发,故不挂。提高单笔金额或等更优市场即可达标。'
          : refQuotable
            ? '最优市场已达标(' + (expDaily === undefined ? '-' : '$' + expDaily.toFixed(2) + '/日') + '),本轮在选市中,稍候自动挂。'
            : '当前高日奖励的市场盘口太薄/价差太宽,无法安全单边挂单;流动性好的市场竞争太高,$' + plOrderSize + ' 预计 <$' + minDaily.toFixed(2) + '。提高单笔金额可同时改善两边。') + '</p></article>');
  }
  // Prominent top-of-panel state line — "what is it doing right now" at a glance (the why/detail stays in the grid below).
  plText('plSubline', live.status !== 'running'
    ? (liveEnabled ? '已就绪 · 点「开始实盘」启动(首次需链上授权 + funder/私钥)' : '实盘开关关闭 · 在下方打开并保存后才能启动')
    : plOpen.length > 0 ? '● 正在挂 ' + plOpen.length + ' 单 · 名义 $' + openNotional.toFixed(0) + (typeof expDaily === 'number' ? ' · 今日预计 $' + expDaily.toFixed(2) + '/天' : '')
    : chosen ? '● 已选中市场 · 本轮挂单中,稍候出现在下方挂单区'
    : auditGate ? '● 预热中 · 全站审计覆盖率爬坡(达 60% 自动挂单 · 刚启动约 8-10 分钟)'
    : (refQuotable && below) ? '● 等待达标市场 · 当前最优 $' + (expDaily === undefined ? '-' : expDaily.toFixed(2)) + '/天 未过 $' + minDaily.toFixed(0) + ' 门槛(加大单笔可改善)'
    : refQuotable ? '● 已找到达标市场 · 本轮选市中,稍候自动挂'
    : '● 等待可挂市场 · 盘口太薄 / 竞争过高');
  renderPlEvents(payload);
}

function renderStaticConfigCards(payload) {
  const signature = JSON.stringify({
    risk: payload.config.risk || {},
    strategy: payload.config.strategy || {}
  });
  if (signature === state.lastConfigSignature) return;
  state.lastConfigSignature = signature;
  renderConfigCards('riskGrid', payload.config.risk || {}, riskMeta);
  renderConfigCards('strategyGrid', payload.config.strategy || {}, strategyMeta);
}

function renderCommandBar(payload, venue, live) {
  const active = activeOrdersForVenue(allUiOrders(payload), venue);
  const exposure = active.reduce((sum, order) => sum + Number(order.notionalUsd || order.price * order.size || 0), 0);
  const orderRisk = payload.orderRisk && payload.orderRisk[venue] ? payload.orderRisk[venue] : null;
  const riskText = $('metricAccountRisk') ? $('metricAccountRisk').textContent : '未同步';
  const recent = compactUiMessage(currentLiveError(live, payload.events || []) || '无');
  const intent = payload.liveIntent && payload.liveIntent[venue] ? payload.liveIntent[venue] : null;
  const selected = selectedRouteItems(payload, venue);
  const pair = routeOrderSummary(allUiOrders(payload), venue, selected);
  const badge = $('liveBadge');
  $('commandOpenOrders').textContent = String(active.length);
  $('commandExposure').textContent = money(orderRisk ? orderRisk.notionalUsd : exposure);
  if ($('commandOrderLoss')) {
    $('commandOrderLoss').textContent = orderRisk ? money(orderRisk.estimatedWorstCaseLossUsd || 0) : '未同步';
    $('commandOrderLoss').className = orderRisk && orderRisk.exceedsLossRemaining ? 'danger-text' : '';
  }
  $('commandRisk').textContent = riskText || '未同步';
  $('commandRisk').className = riskText === '允许新增挂单' ? 'live-on' : riskText && riskText !== '未同步' ? '' : 'danger-text';
  $('commandError').textContent = recent;
  $('commandError').className = recent === '无' ? 'live-on' : 'danger-text';
  renderLiveActionButtons(live, liveEnabledForVenue(payload, venue), active.length);
  if (active.length > 0) {
    if (live.status !== 'running') {
      badge.className = 'status-badge stopping';
      badge.textContent = intent ? '待恢复' : '有挂单';
    }
    $('commandHeadline').textContent = pair.expected > 1 ? pair.headline : '正在挂单：' + active.length + ' 笔开放订单';
    const loop = live.status === 'running' ? '循环运行中' : '循环未运行';
    const recovery = intent && live.status !== 'running' ? ' · 下次服务启动会自动恢复监控' : '';
    $('commandSubline').textContent = pair.expected > 1
      ? pair.detail + ' · ' + loop + recovery
      : active.map((order) => (order.side === 'BUY' ? '买' : '卖') + ' ' + Number(order.price).toFixed(4) + ' · ' + money(order.notionalUsd || order.price * order.size)).join(' / ') + ' · ' + loop + recovery;
    return;
  }
  if (live.status === 'running') {
    $('commandHeadline').textContent = '实盘运行中，等待挂单机会';
    $('commandSubline').textContent = '每轮会同步账户、扫描市场、撤换旧单，并在风控通过时挂 maker 单。';
    return;
  }
  if (live.status === 'error') {
    $('commandHeadline').textContent = '实盘循环错误';
    $('commandSubline').textContent = compactUiMessage(live.lastError || '查看最近错误后重新启动。');
    return;
  }
  $('commandHeadline').textContent = '等待启动';
  $('commandSubline').textContent = '先检查启动条件，再开始实盘。';
}

function renderLiveActionButtons(live, liveEnabled, activeCount = 0) {
  const status = live && live.status ? live.status : 'idle';
  setCommandButton('startLiveBtn', startButtonText(status, liveEnabled), startButtonTitle(status, liveEnabled), status === 'running' || status === 'stopping');
  setCommandButton('startupFactsBtn', '启动检查', '只读检查余额、库存、开放订单、账户风控和 PP 最低份额', false);
  setCommandButton('refreshBalanceBtn', '刷新余额', '只读刷新账户余额', false);
  setCommandButton('stopLiveBtn', stopButtonText(status), stopButtonTitle(status), false);
  setCommandButton('stopCancelBtn', '停止并撤单', stopCancelButtonTitle(status, activeCount), false);
}

function setCommandButton(id, text, title, disabled) {
  const button = $(id);
  if (!button || button.dataset.busy === 'true') return;
  button.textContent = text;
  button.title = title;
  button.disabled = Boolean(disabled);
}

function startButtonText(status, liveEnabled) {
  if (!liveEnabled) return '实盘开关关闭';
  if (status === 'running') return '运行中';
  if (status === 'stopping') return '停止中';
  if (status === 'error') return '重新开始';
  return '开始实盘';
}

function startButtonTitle(status, liveEnabled) {
  if (!liveEnabled) return '当前模块实盘开关未开启';
  if (status === 'running') return '实盘循环已经运行中';
  if (status === 'stopping') return '实盘循环正在停止中';
  if (status === 'error') return '修复错误后重新开始实盘';
  return '开始实盘监控';
}

function stopButtonText(status) {
  if (status === 'stopping') return '停止中';
  return '停止监控';
}

function stopButtonTitle(status) {
  if (status === 'idle') return '当前没有运行中的实盘循环；点击会确认停止状态并禁止自动恢复';
  if (status === 'error') return '循环已处于错误状态';
  if (status === 'stopping') return '已经请求停止，等待当前一轮收尾';
  return '停止实盘监控，保留开放订单';
}

function stopCancelButtonTitle(status, activeCount) {
  if (status === 'idle' && activeCount === 0) return '当前未运行且无开放订单；点击会确认停止状态并执行 0 单撤单检查';
  return '停止实盘并撤掉机器人受管开放订单';
}

function recentError(events) {
  const event = events.find((item) => item.severity === 'error' || String(item.type).includes('error'));
  if (!event) return '';
  return botRejectText(event);
}

function currentLiveError(live, events) {
  if (live.status === 'error') return live.lastError || recentError(events);
  if (live.status === 'running' && live.lastError) return live.lastError;
  return '';
}

function renderSettingsSummary(payload) {
  const target = $('settingsSummaryText');
  if (!target) return;
  const risk = payload.config.risk || {};
  const strategy = payload.config.strategy || {};
  target.textContent = '同时 ' + (risk.maxMarkets || 1) + ' 单 · 单笔 ' + money(risk.orderSizeUsd || 0)
    + ' · 退出亏损上限 ' + Number(strategy.cashMaxExitLossPct ?? 30).toFixed(0) + '%'
    + ' · 本轮总止损 ' + money(risk.maxDailyLossUsd || 0)
    + ' · 评分按 101 份 PP/hr/kUSD';
}

function renderAccountRiskSummary(payload, venue) {
  const risk = payload.accountRisk && payload.accountRisk[venue] ? payload.accountRisk[venue] : {};
  const fills = payload.fills && payload.fills[venue] ? payload.fills[venue] : null;
  const riskWindow = payload.riskWindows && payload.riskWindows[venue] ? payload.riskWindows[venue] : null;
  const decision = risk.decision || null;
  const snapshot = risk.snapshot || null;
  const metric = $('metricAccountRisk');
  const badge = $('riskStatusBadge');
  const grid = $('accountRiskGrid');
  if (!decision) {
    metric.textContent = '未同步';
    metric.className = 'danger-text';
    badge.className = 'status-badge error';
    badge.textContent = '未同步';
    grid.innerHTML = riskEmptyHtml();
    return;
  }
  const status = decision.ok ? 'running' : 'error';
  const label = riskReasonLabel[decision.reason] || decision.reason || '未知';
  metric.textContent = label;
  metric.className = decision.ok ? 'live-on' : 'danger-text';
  badge.className = 'status-badge ' + status;
  badge.textContent = label;
  const windowPnl = decision.dailyPnlUsd ?? (decision.realizedPnlUsd !== undefined || decision.unrealizedPnlUsd !== undefined
    ? Number((Number(decision.realizedPnlUsd || 0) + Number(decision.unrealizedPnlUsd || 0)).toFixed(4))
    : undefined);
  const capturedAt = decision.capturedAt ? new Date(decision.capturedAt).toISOString() : snapshot?.ts;
  // A stopped venue stops refreshing its account snapshot, so an old PnL/position can mislead — e.g. it keeps showing
  // a floating loss after the position was already closed. Flag the snapshot as EXPIRED instead of presenting that old
  // number as the live one. (Showing a true real-time 0 would require a background signed read; here we at least stop
  // misrepresenting stale data as current.)
  const maxStaleMs = Number(payload.config && payload.config.risk ? payload.config.risk.maxAccountRiskStaleMs : 0) || 120000;
  const snapshotAgeMs = capturedAt ? Math.max(0, Date.now() - new Date(capturedAt).getTime()) : undefined;
  const venueStatus = payload.live && payload.live[venue] ? payload.live[venue].status : undefined;
  const expiredSnap = snapshotAgeMs !== undefined && snapshotAgeMs > maxStaleMs && venueStatus !== 'running' && venueStatus !== 'stopping';
  const warnings = Array.isArray(decision.warnings) && decision.warnings.length > 0
    ? '<div class="risk-warning">' + decision.warnings.slice(0, 3).map(escapeHtml).join(' · ') + '</div>'
    : '';
  grid.innerHTML = [
    riskItemHtml('状态', label, decision.message || '等待账户级风控同步', decision.ok ? 'ok' : 'bad'),
    riskItemHtml('数据新鲜度', capturedAt ? (formatAge(capturedAt) + (expiredSnap ? ' · 已过期' : '')) : '无快照', expiredSnap ? '已停止运行，账户快照不再刷新；下面的盈亏/持仓可能已不是实时数字，重启实盘后会自动刷新' : '平台成交、仓位、余额和权益快照时间', expiredSnap ? 'bad' : 'ok'),
    riskItemHtml('统计起点', riskWindow?.since ? new Date(riskWindow.since).toLocaleString() : '未知', riskWindow?.source === 'live-session' ? '本轮实盘开始时间' : '未运行时使用快照窗口'),
    riskItemHtml('本轮 PnL', windowPnl === undefined ? '未知' : (signedMoney(windowPnl) + (expiredSnap ? '（已过期·旧快照）' : '')), expiredSnap ? '这是停止那一刻的旧快照、非实时；持仓可能已平、亏损可能已结算，重启实盘后会刷新为真实数字' : '从本轮实盘开始后统计；未知会阻断新增挂单', expiredSnap ? 'bad' : (windowPnl !== undefined && windowPnl < 0 ? 'bad' : 'ok')),
    riskItemHtml('本轮总止损', money(decision.maxDailyLossUsd || payload.config.risk.maxDailyLossUsd || 0), '从点击开始实盘后累计；触及后撤机器人受管挂单并停止实盘'),
    riskItemHtml('账户权益', decision.equityUsd === undefined ? '未知' : money(decision.equityUsd), '来自平台 value 或余额 + 持仓估值'),
    riskItemHtml('成交净现金流', decision.netCashflowUsd === undefined ? '未知' : signedMoney(decision.netCashflowUsd), '风控窗口内平台成交归一化现金流'),
    riskItemHtml('本轮成交', fillSummaryText(fills), fillSummaryHint(fills), fills && fills.count > 0 ? 'bad' : 'ok')
  ].join('') + warnings;
}

function fillSummaryText(fills) {
  if (!fills) return '未知';
  if (!fills.count) return '0 笔';
  return fills.count + ' 笔 / ' + money(fills.notionalUsd || 0);
}

function fillSummaryHint(fills) {
  if (!fills) return '等待平台成交同步';
  if (!fills.count) return '当前风控窗口暂未同步到成交记录';
  const latest = fills.latest || {};
  const side = latest.side ? sideLabel[latest.side] || latest.side : '未知方向';
  const ts = latest.ts ? new Date(latest.ts).toLocaleString() : '未知时间';
  return '最近 ' + side + ' ' + money(latest.notionalUsd || 0) + ' · ' + ts;
}

function renderStoreStatus(payload, venue) {
  const store = payload.store || {};
  $('storeEventCount').textContent = compactNumber(store.events || 0, 0);
  const checkpoint = store.lastCheckpoint || null;
  if (checkpoint && checkpoint.name && checkpoint.ts) {
    $('storeLastCheckpointLabel').textContent = String(checkpoint.name);
    $('storeLastCheckpointTime').textContent = new Date(checkpoint.ts).toLocaleString() + ' · ' + formatAge(checkpoint.ts);
  } else {
    $('storeLastCheckpointLabel').textContent = '暂无';
    $('storeLastCheckpointTime').textContent = '还没有写入 checkpoint。';
  }
  const stageCheckpoint = payload.stage && payload.stage[venue] ? payload.stage[venue] : null;
  const value = stageCheckpoint && stageCheckpoint.value ? stageCheckpoint.value : {};
  $('storeCurrentStage').textContent = stageLabel(value.stage || 'idle');
  $('storeCurrentStageMessage').textContent = value.message || '等待实盘循环。';
}

function riskEmptyHtml() {
  return '<div class="empty">还没有账户级风控快照。启动实盘循环或提交手动单前，会先同步平台成交、仓位、余额和权益；同步失败会禁止新增挂单。</div>';
}

function riskItemHtml(label, value, hint, tone = '') {
  return '<article class="risk-item ' + tone + '"><span>' + escapeHtml(label) + '</span><strong>' + escapeHtml(value) + '</strong><p>' + escapeHtml(hint) + '</p></article>';
}

function renderLivePanel(live, venue, liveEnabled) {
  const badge = $('liveBadge');
  badge.className = 'status-badge ' + (live.status || 'idle');
  badge.textContent = liveStatusLabel[live.status] || live.status || '未启动';
  const parts = [];
  parts.push(venueLabel[venue] + ' 实盘开关：' + (liveEnabled ? '开启' : '关闭'));
  parts.push('循环次数：' + (live.cycles || 0));
  if (live.startedAt) parts.push('启动时间：' + new Date(live.startedAt).toLocaleString());
  if (live.lastCycleAt) parts.push('最近一轮：' + new Date(live.lastCycleAt).toLocaleString());
  if (live.restored) parts.push('本次为自动恢复');
  if (live.retryAt) parts.push('断线重试：' + new Date(live.retryAt).toLocaleTimeString());
  if (live.lastError) parts.push('最近错误：' + compactUiMessage(live.lastError));
  $('liveDetail').textContent = parts.join(' · ');
}

function renderStageAndRejects(payload, venue) {
  const checkpoint = payload.stage && payload.stage[venue] ? payload.stage[venue] : null;
  const value = checkpoint && checkpoint.value ? checkpoint.value : {};
  $('stageState').textContent = stageLabel(value.stage || 'idle');
  $('stageMessage').textContent = value.message || '等待实盘循环';
  const stats = payload.rejectStats && payload.rejectStats[venue] ? payload.rejectStats[venue] : [];
  $('rejectSummary').textContent = stats.length === 0
    ? '暂无'
    : stats.slice(0, 3).map((item) => rejectLabel(item.reasonCode) + ' ' + item.count + '次').join(' / ');
}

function selectedRouteItems(payload, venue) {
  const checkpoint = payload.route && payload.route[venue];
  const value = checkpoint && checkpoint.value ? checkpoint.value : null;
  const selected = value && Array.isArray(value.selected) ? value.selected : [];
  if (selected.length > 0) return selected;
  if (value && value.best) return [value.best];
  return [];
}

function routeOrderSummary(orders, venue, selected) {
  const expected = selected && selected.length > 1 ? selected.length : 0;
  const tokenSet = new Set((selected || []).map((item) => item.tokenId).filter(Boolean));
  const active = activeOrdersForVenue(orders || [], venue).filter((order) => tokenSet.size === 0 || tokenSet.has(order.tokenId));
  const confirmed = active.filter((order) => order.status === 'OPEN').length;
  const pending = active.filter((order) => order.status === 'PENDING_OPEN').length;
  const missing = Math.max(0, expected - active.length);
  const ok = expected > 0 && missing === 0 && pending === 0;
  const waiting = expected > 0 && missing === 0 && pending > 0;
  const headline = expected > 1
    ? ok
      ? 'PP 篮子已完整挂单'
      : waiting
        ? 'PP 篮子等待平台确认'
        : 'PP 篮子覆盖不完整'
    : active.length > 0
      ? '正在挂单：' + active.length + ' 笔开放订单'
      : '未挂单';
  const detail = expected > 1
    ? '已确认 ' + confirmed + ' / 待确认 ' + pending + ' / 缺失 ' + missing
    : active.map((order) => orderSummaryText(order)).join(' / ');
  return { expected, active, confirmed, pending, missing, ok, waiting, headline, detail };
}

function orderSummaryText(order) {
  if (!order) return '';
  return (order.side === 'BUY' ? '买' : '卖') + ' ' + Number(order.price).toFixed(4) + ' · ' + money(order.notionalUsd || order.price * order.size);
}

function renderBotActivity(payload, venue, live) {
  const list = $('botActivityList');
  if (!list) return;
  const events = visibleBotEvents(payload.events || [], venue);
  const route = payload.route && payload.route[venue] ? payload.route[venue].value : null;
  const stageCheckpoint = payload.stage && payload.stage[venue] ? payload.stage[venue] : null;
  const stage = stageCheckpoint && stageCheckpoint.value ? stageCheckpoint.value : {};
  const latest = events[0];

  $('botActivityHeadline').textContent = botHeadline(payload, venue, live, stage, route, latest);
  $('botActivityNext').textContent = botNextStep(payload, venue, live, stage, route, latest);
  const signature = JSON.stringify(events.slice(0, 6).map((event) => [event.id, event.ts, event.type, event.message, event.severity]));
  if (signature === state.lastBotActivitySignature) return;
  state.lastBotActivitySignature = signature;

  if (events.length === 0) {
    list.innerHTML = '<div class="empty">暂无关键动态。启动、选市场、拒绝、提交和撤单会显示在这里。</div>';
    return;
  }
  list.innerHTML = events.slice(0, 6).map((event) => botEventHtml(event)).join('');
}

function visibleBotEvents(serverEvents, venue) {
  const importantTypes = new Set([
    'ui.live.start.requested',
    'ui.live.preflight.started',
    'ui.live.preflight.passed',
    'ui.live.preflight.failed',
    'ui.live.start.failed',
    'ui.live.loop.started',
    'ui.live.auto-resumed',
    'ui.live.resume.skipped',
    'ui.live.resume.failed',
    'ui.live.retrying',
    'ui.live.cycle.started',
    'ui.live.cycle.completed',
    'ui.live.risk-stop',
    'ui.live.loop.stopped',
    'ui.live-loop.error',
    'ui.live.stop.requested',
    'ui.live.stop-and-cancel.requested',
    'ui.live.stop-and-cancel.completed',
    'route.selection',
    'risk.account-snapshot.unavailable',
    'risk.account-gate.blocked',
    'risk.daily-loss-limit',
    'risk.balance-skip',
    'risk.inventory-skip',
    'open-orders.unavailable',
    'positions.unavailable',
    'balance.empty',
    'balance.unavailable',
    'orderbook.unavailable',
    'risk.market-guard.route-reject',
    'risk.market-guard.reject',
    'risk.market-guard.final-reject',
    'risk.reject',
    'risk.final-reject',
    'risk.submit-blocked',
    'quote.skip-existing',
    'quote.replace-cancel',
    'quote.replace-deferred',
    'order.submitted',
    'order.submit-pending-verification',
    'order.submit-error',
    'fill-circuit-breaker.triggered',
    'fill-circuit-breaker.cancel-managed',
    'cash-fill.exit-submitted',
    'cash-fill.exit-blocked',
    'cash-fill.exit-failed',
    'cash-fill.exit-unsupported',
    'split.pair-submit-pending-confirmation',
    'split.pair-submit-verified',
    'split.pair-submit-unverified',
    'fill.cancel-before-merge',
    'fill.merge-submitted',
    'fill.merge-not-ready',
    'fill.merge-unsupported'
  ]);
  const relevantLocal = state.localEvents.filter((event) => event.venue === venue || !event.venue);
  const relevantServer = serverEvents.filter((event) => (event.venue === venue || !event.venue) && importantTypes.has(event.type));
  const seen = new Set();
  return [...relevantLocal, ...relevantServer]
    .filter((event) => {
      const key = [event.ts, event.type, event.message].join('|');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());
}

function botHeadline(payload, venue, live, stage, route, latest) {
  const open = activeOrdersForVenue(allUiOrders(payload), venue).length;
  const intent = payload.liveIntent && payload.liveIntent[venue] ? payload.liveIntent[venue] : null;
  const fillBreaker = fillCircuitBreakerValue(payload, venue);
  if (fillBreaker && fillBreaker.active) return '现金单边成交保护：本轮停止新增';
  if (live.status === 'running') {
    if (live.retryAt) return '网络/平台异常，自动重试中';
    if (open > 0) return '正在挂单：' + open + ' 笔开放订单';
    if (stage.stage && stage.stage !== 'idle') return '正在' + stageLabel(stage.stage);
    if (latest && isRejectEvent(latest)) return '本轮未新增挂单：' + botRejectText(latest);
    return '实盘循环运行中，等待下一轮扫描';
  }
  if (open > 0) return intent ? '已有开放订单，等待自动恢复监控' : '已有开放订单，循环未运行';
  if (live.status === 'error') return '实盘循环错误：' + compactUiMessage(live.lastError || '请看最近动态');
  if (live.status === 'stopping') return '正在停止实盘循环';
  if (stage.stage === 'idle') return '等待启动';
  if (latest && isRejectEvent(latest)) return '最近未下单原因：' + botRejectText(latest);
  const selected = route && Array.isArray(route.selected) ? route.selected : [];
  if (selected.length > 0) return '目标市场已选中';
  return '等待启动';
}

function botNextStep(payload, venue, live, stage, route, latest) {
  const open = activeOrdersForVenue(allUiOrders(payload), venue).length;
  const intent = payload.liveIntent && payload.liveIntent[venue] ? payload.liveIntent[venue] : null;
  const fillBreaker = fillCircuitBreakerValue(payload, venue);
  if (fillBreaker && fillBreaker.active) {
    const count = Array.isArray(fillBreaker.positions) ? fillBreaker.positions.length : 0;
    const action = payload.config.strategy && payload.config.strategy.cashOnFillAction === 'sellWithinLossCap'
      ? '会在亏损上限内尝试 SELL taker 止损退出'
      : '会继续同步和撤受管订单，但不会新增现金单边挂单';
    return '检测到 ' + count + ' 个 Predict 持仓，机器人' + action + '；持仓消失后继续扫描，只有总止损金额触发才停止实盘。';
  }
  if (live.status === 'running') {
    const wait = payload.config.strategy && payload.config.strategy.quoteRefreshMs ? payload.config.strategy.quoteRefreshMs : 0;
    const suffix = wait ? '，约 ' + Math.round(wait / 1000) + ' 秒后自动进入下一轮' : '，会自动进入下一轮';
    if (live.retryAt) {
      const message = String(live.lastError || '');
      if (message.includes('认证失败') || message.includes('未授权') || message.toLowerCase().includes('unauthorized')) {
        return '平台认证不可用，机器人当前不能可靠同步开放订单、撤换或新增；请重新授权后让循环恢复。';
      }
      return '不会把开放订单放成孤儿单；循环会在 ' + new Date(live.retryAt).toLocaleTimeString() + ' 自动重试，同步真实开放订单后再决定撤换。';
    }
    if (stage.stage && stage.stage !== 'idle') return (stage.message || '当前阶段进行中') + suffix;
    if (latest && isRejectEvent(latest)) return '这次被拦截不会直接放弃；只要循环仍在运行，下一轮会重新扫描市场和盘口。';
    return '会持续同步账户、扫描 PP 市场、撤换旧单，并在风控通过时挂 maker 单。';
  }
  if (open > 0 && intent) return '开放订单仍在平台；当前已记录自动恢复意图，服务重启后会自动恢复监控。';
  if (open > 0) return '开放订单仍在平台；只有启动实盘循环后，机器人才会继续监控、撤换和切换市场。';
  if (live.status === 'error') return '循环已停止在错误状态，需要修复最近错误后重新点击开始实盘。';
  if (live.status === 'stopping') return '正在等待当前一轮收尾；需要立即清理开放订单时用“停止并撤单”。';
  if (!liveEnabledForVenue(payload, venue)) return venueLabel[venue] + ' 实盘开关关闭；请在当前模块页面打开并保存后再启动。';
  if (latest && latest.type === 'ui.live.preflight.failed') return '预检失败时不会启动循环；修复凭据、余额或配置后重新点击开始实盘。';
  if (latest && isRejectEvent(latest)) return '当前没有运行中的循环；再次点击开始实盘后会重新检查并尝试。';
  if (route && Array.isArray(route.selected) && route.selected.length > 0) return routeMarketText(route.selected[0]);
  return '点击开始实盘前可先检查启动条件，确认单边挂单、余额、库存和风控是否通过。';
}

function botEventHtml(event) {
  const label = eventLabel[event.type] || event.type;
  return '<div class="bot-activity-item ' + escapeHtml(event.severity || 'info') + (event.local ? ' local' : '') + '"><span>' + escapeHtml(label) + '</span><strong>' + escapeHtml(botEventMessage(event)) + '</strong><time>' + formatAge(event.ts) + '</time></div>';
}

function botEventMessage(event) {
  if (event.type === 'route.selection') {
    const details = event.details || {};
    const selected = Array.isArray(details.selected) ? details.selected : [];
    if (selected.length > 0) return '选中 ' + routeMarketText(selected[0]);
    return '没有可挂单的 PP 候选市场';
  }
  if (isRejectEvent(event)) {
    return botRejectText(event);
  }
  if (event.type === 'order.submitted') return '已提交 maker 挂单：' + shortId(event.message);
  if (event.type === 'order.submit-pending-verification') return '订单已提交，等待平台开放订单确认：' + shortId(event.message);
  if (event.type === 'split.pair-submit-pending-confirmation') return '双边 SELL 已提交，平台开放订单接口正在补全显示';
  if (event.type === 'split.pair-submit-verified') return '双边 SELL 已完整确认';
  if (event.type === 'split.pair-submit-unverified') return '双边 SELL 未能确认完整，已按安全规则处理';
  if (event.type === 'split.entry.blocked') return compactUiMessage(event.message || '完整套仓拆分被阻断');
  if (event.type === 'quote.skip-existing') return '已有同方向开放订单，本轮不重复堆单';
  if (event.type === 'quote.replace-cancel') return '旧单不再符合目标，已进入撤换流程';
  if (event.type === 'quote.replace-deferred') return '路由快照或替换目标暂不完整，本轮先保留旧单';
  if (event.type === 'fill-circuit-breaker.triggered') return '检测到持仓/成交，现金单边策略已执行成交保护';
  if (event.type === 'fill-circuit-breaker.hold') return '现金单边成交保护保持中，等待持仓退出或下一轮同步';
  if (event.type === 'fill-circuit-breaker.cancel-managed') return '成交保护正在撤销机器人受管订单';
  if (event.type === 'cash-fill.exit-submitted') return '已按 cash 亏损上限提交止损退出单';
  if (event.type === 'cash-fill.exit-blocked') return compactUiMessage(event.message || 'cash 止损退出被亏损线或盘口阻断');
  if (event.type === 'cash-fill.exit-failed') return compactUiMessage(event.message || 'cash 止损退出提交失败');
  if (event.type === 'cash-fill.exit-unsupported') return '当前平台不支持 cash 自动止损退出';
  if (event.type === 'ui.live.auto-resumed') return '服务重启后已自动恢复实盘监控';
  if (event.type === 'ui.live.retrying') return '网络/平台临时异常，正在自动重试';
  return compactUiMessage(event.message || event.type);
}

function isRejectEvent(event) {
  return Boolean(extractReject(event)) || [
    'risk.account-snapshot.unavailable',
    'risk.account-gate.blocked',
    'risk.daily-loss-limit',
    'risk.balance-skip',
    'risk.inventory-skip',
    'open-orders.unavailable',
    'positions.unavailable',
    'balance.empty',
    'balance.unavailable',
    'orderbook.unavailable',
    'risk.market-guard.route-reject',
    'risk.market-guard.reject',
    'risk.market-guard.final-reject',
    'risk.reject',
    'risk.final-reject',
    'risk.submit-blocked',
    'order.submit-error',
    'fill-circuit-breaker.triggered',
    'fill-circuit-breaker.hold',
    'cash-fill.exit-blocked',
    'cash-fill.exit-failed',
    'cash-fill.exit-unsupported',
    'ui.live.preflight.failed',
    'ui.live.start.failed',
    'ui.live-loop.error',
    'ui.live.resume.failed'
  ].includes(event.type);
}

function botRejectText(event) {
  if (event.type === 'risk.account-snapshot.unavailable') return '账户成交/仓位数据不可用';
  if (event.type === 'risk.account-gate.blocked') return event.message || '账户风控阻断';
  if (event.type === 'risk.balance-skip') return riskFlagsText(event, '余额不足或资金占用超限');
  if (event.type === 'risk.inventory-skip') return riskFlagsText(event, '没有可卖库存');
  if (event.type === 'risk.market-guard.route-reject') return routeRejectText(event);
  if (event.type === 'risk.market-guard.reject') return marketGuardText(event);
  if (event.type === 'risk.market-guard.final-reject') return marketGuardText(event);
  if (event.type === 'risk.reject') return riskFlagsText(event, '订单风控拒绝');
  if (event.type === 'risk.final-reject') return riskFlagsText(event, '订单风控拒绝');
  if (event.type === 'risk.submit-blocked') return riskFlagsText(event, '提交前阻断');
  const reject = extractReject(event);
  if (reject && reject.reason_code) return rejectLabel(reject.reason_code);
  if (event.type === 'orderbook.unavailable') return '盘口读取失败';
  if (event.type === 'split.entry.blocked') return compactUiMessage(event.message || '完整套仓拆分被阻断');
  if (event.type === 'balance.empty') return '余额为空或不可确认';
  if (event.type === 'balance.unavailable') return '余额不可用';
  if (event.type === 'positions.unavailable') return '持仓同步失败';
  if (event.type === 'open-orders.unavailable') return '开放订单同步失败';
  if (event.type === 'ui.live.retrying') return '网络/平台接口临时异常，机器人会自动重试';
  if (event.type === 'fill-circuit-breaker.triggered') return '检测到持仓，已撤受管订单并按止损设置处理';
  if (event.type === 'fill-circuit-breaker.hold') return '成交保护保持中，等待持仓退出或下一轮同步';
  return compactUiMessage(event.message || '被风控拒绝');
}

function fillCircuitBreakerValue(payload, venue) {
  const checkpoint = payload.fillCircuitBreaker && payload.fillCircuitBreaker[venue];
  return checkpoint && checkpoint.value ? checkpoint.value : null;
}

function routeRejectText(event) {
  const details = event.details || {};
  return riskFlagsText(event, '市场暂时不适合挂单' + (details.tokenId ? ' · ' + shortId(details.tokenId) : ''));
}

function marketGuardText(event) {
  const details = event.details || {};
  const guard = details.guard || details.decision || {};
  if (guard.reason) return rejectLabel('MARKET_' + String(guard.reason).replaceAll('-', '_').toUpperCase());
  return riskFlagsText(event, '市场安全检查未通过');
}

function riskFlagsText(event, fallback) {
  const details = event.details || {};
  const flags = Array.isArray(details.riskFlags)
    ? details.riskFlags
    : Array.isArray(details.reasons)
      ? details.reasons
      : Array.isArray(details.decision?.reasons)
        ? details.decision.reasons
        : details.capital?.reason
          ? [details.capital.reason]
        : [];
  if (flags.length === 0) return fallback;
  return flags.slice(0, 2).map(humanRiskFlag).join(' / ');
}

function humanRiskFlag(flag) {
  const text = String(flag || '');
  const lower = text.toLowerCase();
  const value = text.match(/([0-9]+(?:\.[0-9]+)?\s*(?:bps|ms|c))/i)?.[1];
  const suffix = value ? ' ' + value : '';
  if (text.includes('结束时间') || text.includes('结算') || text.includes('结束') || lower.includes('settlement')) return '时间不安全';
  if (text.includes('开赛') || text.includes('赛事') || text.includes('事件开始') || lower.includes('event start')) return '临近开始/已开始';
  if (text.includes('盘口不可用') || text.includes('缺少 BBO') || lower.includes('missing bbo')) return '盘口不可用';
  if (text.includes('盘口深度不足') || text.includes('深度') || lower.includes('depth')) return '深度不足';
  if (text.includes('价差过宽') || lower.includes('spread too wide') || lower.includes('spread-blowout')) return '价差太宽' + suffix;
  if (text.includes('价差') && (text.includes('太窄') || lower.includes('too tight'))) return '价差太窄' + suffix;
  if (lower.includes('stale orderbook') || text.includes('过期')) return '盘口太旧' + suffix;
  if (text.includes('跳动') || lower.includes('price jump')) return '价格跳动过大';
  if (text.includes('会吃单') || lower.includes('cross')) return '可能吃单';
  if (text.includes('奖励带') || lower.includes('reward band')) return '不在 PP 奖励带';
  if (text.includes('持仓') || lower.includes('position exposure')) return '持仓超限';
  if (text.includes('单笔') || lower.includes('single order')) return '单笔金额超限';
  if (lower.includes('inventory-insufficient')) return '没有可卖库存';
  if (lower.includes('balance-insufficient')) return '余额不足';
  if (lower.includes('reserve-drift')) return '冻结偏差过大';
  return text;
}

function extractReject(event) {
  const details = event && event.details ? event.details : {};
  if (details.reject && typeof details.reject === 'object') return details.reject;
  if (details.decision && details.decision.reject && typeof details.decision.reject === 'object') return details.decision.reject;
  if (details.guard && details.guard.reject && typeof details.guard.reject === 'object') return details.guard.reject;
  return null;
}

function routeMarketText(item) {
  if (!item) return '-';
  const name = (item.outcome ? item.outcome + ' · ' : '') + (item.question || shortId(item.tokenId));
  return name + ' · Token ' + shortId(item.tokenId);
}

function activeOrdersForVenue(orders, venue) {
  return orders.filter((order) => order.venue === venue && ['OPEN', 'PENDING_OPEN'].includes(order.status));
}

function stageLabel(value) {
  const map = {
    'syncing-account': '同步账户',
    'syncing-orders': '同步订单',
    'syncing-positions': '同步持仓',
    'syncing-balances': '同步余额',
    'syncing-markets': '同步市场',
    'routing-market': '选择市场',
    canceling: '撤单检查',
    'planning-quotes': '生成挂单',
    'checking-risk': '订单风控',
    'final-orderbook-check': '最终盘口',
    submitting: '提交订单',
    retrying: '断线重试',
    idle: '空闲',
    error: '错误'
  };
  return map[value] || String(value || 'idle');
}

function rejectLabel(code) {
  const map = {
    ACCOUNT_SNAPSHOT_UNAVAILABLE: '账户风控不可用',
    ACCOUNT_SNAPSHOT_STALE: '账户数据过期',
    ACCOUNT_DAILY_LOSS_LIMIT: '总止损触发',
    BALANCE_EMPTY: '余额为空',
    BALANCE_UNAVAILABLE: '余额不可用',
    BALANCE_INSUFFICIENT: '余额不足',
    INVENTORY_INSUFFICIENT: '没有可卖库存',
    RESERVE_DRIFT_TOO_LARGE: '冻结偏差过大',
    ORDERBOOK_UNAVAILABLE: '盘口不可用',
    MARKET_UNKNOWN_END_TIME: '未知结束时间',
    MARKET_NEAR_SETTLEMENT: '临近结算',
    MARKET_CANCEL_WINDOW: '撤单窗口',
    MARKET_MARKET_ENDED: '市场已结束',
    MARKET_EVENT_STARTED: '事件已开始',
    MARKET_NEAR_EVENT_START: '临近开始',
    MARKET_EVENT_START_CANCEL_WINDOW: '开始前撤单窗口',
    MARKET_MISSING_BBO: '盘口不可用',
    MARKET_SPREAD_BLOWOUT: '价差太宽',
    MARKET_PRICE_EXTREME: '价格接近0/1',
    MARKET_PRICE_JUMP: '盘口跳动',
    MARKET_DEPTH_COLLAPSE: '深度不足',
    ROUTE_MARKET_GUARD_REJECT: '市场安全不通过',
    STALE_ORDERBOOK: '盘口太旧',
    SPREAD_TOO_TIGHT: '价差太窄',
    SPREAD_TOO_WIDE: '价差太宽',
    DEPTH_TOO_LOW: '深度不足',
    OPEN_ORDER_LIMIT: '订单数超限',
    SINGLE_ORDER_LIMIT: '单笔金额超限',
    POST_ONLY_REQUIRED: '不是只挂单',
    WOULD_CROSS_BBO: '会吃单',
    OUTSIDE_REWARD_BAND: '不在奖励带',
    POSITION_EXPOSURE_LIMIT: '持仓超限',
    MAX_MARKETS_LIMIT: '市场数超限',
    RISK_ENGINE_REJECT: '订单风控拒绝',
    PREDICT_GAS_BALANCE_LOW: 'BNB手续费不足'
  };
  return map[code] || String(code || '未知拒绝');
}

function renderRoutePanel(payload, venue) {
  const checkpoint = payload.route && payload.route[venue];
  const scanCheckpoint = payload.marketScan && payload.marketScan[venue];
  const auditCheckpoint = payload.routeAudit && payload.routeAudit[venue];
  const auditValue = auditCheckpoint && auditCheckpoint.value ? auditCheckpoint.value : null;
  const value = checkpoint && checkpoint.value ? checkpoint.value : null;
  const selected = value && Array.isArray(value.selected) ? value.selected : [];
  const current = selected[0] || (value && value.best);
  const latestReject = current ? latestOrderRejectForToken(payload.events || [], venue, current.tokenId, checkpoint?.ts) : null;
  const panel = $('routePanel');
  panel.className = 'route-panel';
  const maxMarkets = Math.max(1, Number(payload.config.risk && payload.config.risk.maxMarkets || 1));
  const fillBreaker = fillCircuitBreakerValue(payload, venue);
  if (fillBreaker && fillBreaker.active) panel.classList.add('route-risk');
  if (!current) {
    panel.classList.add('empty-route');
    $('routeMarket').textContent = fillBreaker && fillBreaker.active
      ? '现金单边成交保护'
      : payload.config.strategy.autoSelectMarkets ? '等待第一轮 PP 扫描' : '手动 selectedMarkets 模式';
    $('routeReason').textContent = fillBreaker && fillBreaker.active
      ? fillCircuitBreakerText(fillBreaker)
      : value && value.reason ? value.reason : emptyRouteReason(payload, venue) + auditSummaryText(auditValue);
    $('routePp').textContent = '-';
    $('routeSpread').textContent = '-';
    $('routeDepth').textContent = '-';
    $('routeCompetition').textContent = '-';
    $('routeOrderState').textContent = '0/' + maxMarkets + ' active';
    $('routeOrderSize').textContent = routeScoringBasisText(payload.config, null);
    renderPairLegGrid(allUiOrders(payload), venue, selected, payload.events || [], checkpoint?.ts);
    if ($('routeTime')) $('routeTime').textContent = '0/' + maxMarkets;
    return;
  }
  const metrics = current.metrics || {};
  const selectedGroup = value && value.selectedGroup ? value.selectedGroup : null;
  const bestGroup = value && value.bestGroup ? value.bestGroup : null;
  const previousGroup = value && value.previousGroup ? value.previousGroup : null;
  const groupMetrics = selectedGroup || bestGroup || null;
  const label = (current.outcome ? current.outcome + ' · ' : '') + (current.question || shortId(current.tokenId));
  if (current.tradable === false) panel.classList.add('route-risk');
  $('routeMarket').textContent = '#1/' + maxMarkets + ' · ' + label;
  const chosenCount = ' · 已选 ' + selected.length + '/' + maxMarkets;
  const switched = value && value.switched ? ' · 已切换' : '';
  const risk = Array.isArray(current.riskFlags) && current.riskFlags.length > 0 ? ' · 风险：' + current.riskFlags.slice(0, 2).join(' / ') : '';
  const cashMode = payload.config.strategy && payload.config.strategy.entryMode === 'cash';
  const gasAware = cashMode ? ' · cash 单边不做 split/merge' : value.reason && value.reason.includes('换池') ? ' · 已考虑 split/merge gas' : '';
  const groupCompare = routeGroupCompareText(selectedGroup, bestGroup, previousGroup);
  const scanText = scanSummaryText(scanCheckpoint && scanCheckpoint.value);
  const auditText = auditSummaryText(auditValue);
  const routeOrders = allUiOrders(payload);
  $('routeReason').textContent = (value.reason || '当前最优低竞争 PP 篮子') + switched + gasAware + chosenCount + groupCompare + scanText + auditText + ' · Token ' + shortId(current.tokenId) + ' · ' + (current.reasons || []).slice(0, 3).join(' · ') + risk;
  $('routePp').textContent = routeExpectedText(selected, metrics, groupMetrics);
  $('routeSpread').textContent = routeApiText(metrics, scanCheckpoint && scanCheckpoint.value, state.lastStatusLatencyMs, auditValue);
  $('routeDepth').textContent = routeDepthText(metrics, groupMetrics);
  $('routeCompetition').textContent = basketGapText(selected, maxMarkets, scanCheckpoint && scanCheckpoint.value, payload.rejectStats && payload.rejectStats[venue], auditValue);
  const pair = routeOrderSummary(routeOrders, venue, selected.length > 0 ? selected : [current]);
  $('routeOrderState').textContent = basketOrderStateText(routeOrders, venue, selected, maxMarkets, pair);
  $('routeOrderSize').textContent = routeScoringBasisText(payload.config, metrics);
  if ($('currentOrderHint')) $('currentOrderHint').textContent = basketOrderHint(routeOrders, venue, selected, pair);
  if ($('currentOrderNext')) $('currentOrderNext').textContent = currentOrderNextText(payload, venue, current, metrics, groupMetrics);
  renderPairLegGrid(routeOrders, venue, selected.length > 0 ? selected : [current], payload.events || [], checkpoint?.ts);
  if ($('routeTime')) $('routeTime').textContent = selected.length + '/' + maxMarkets + ' 目标 · ' + activeOrdersForVenue(routeOrders, venue).length + ' 开放';
  const rewardMinimumWarning = routeRewardMinimumWarning(payload.config, metrics);
  if (rewardMinimumWarning) {
    panel.classList.add('route-risk');
    $('routeReason').textContent = $('routeReason').textContent + ' · ' + rewardMinimumWarning;
  }
  if (latestReject && activeOrdersForVenue(routeOrders, venue).filter((order) => order.tokenId === current.tokenId).length === 0) {
    panel.classList.add('route-risk');
    $('routeReason').textContent = $('routeReason').textContent + ' · 本轮未挂：' + botRejectText(latestReject);
  }
}

function renderPpEstimatePanel(payload, venue, live) {
  const panel = $('ppEstimatePanel');
  if (!panel) return;
  const selected = selectedRouteItems(payload, venue);
  const active = activeOrdersForVenue(allUiOrders(payload), venue);
  const openTokenSet = new Set(active.map((order) => order.tokenId).filter(Boolean));
  const covered = selected.filter((item) => item && item.tokenId && openTokenSet.has(item.tokenId));
  const targetHourly = selected.reduce((sum, item) => sum + Number(item.metrics && item.metrics.expectedPpPerHour || 0), 0);
  const liveHourly = covered.reduce((sum, item) => sum + Number(item.metrics && item.metrics.expectedPpPerHour || 0), 0);
  const route = payload.route && payload.route[venue] ? payload.route[venue] : null;
  const progress = beijingDayProgress();
  const targetShares = selected
    .map((item) => Number(item.metrics && item.metrics.targetShares || 0))
    .filter((value) => Number.isFinite(value) && value > 0);
  const minShares = targetShares.length ? Math.min(...targetShares) : 101;
  const maxShares = targetShares.length ? Math.max(...targetShares) : 101;
  const shareText = minShares === maxShares
    ? compactNumber(minShares, 4) + ' 份'
    : compactNumber(minShares, 4) + '-' + compactNumber(maxShares, 4) + ' 份';
  const routeAge = route && route.ts ? ' · 路由 ' + formatAge(route.ts) : '';
  const running = live && live.status === 'running';
  const coverageText = covered.length + '/' + selected.length;
  panel.className = 'pp-estimate-panel' + (!liveHourly || selected.length === 0 || !running ? ' waiting' : '');
  if (!targetHourly || selected.length === 0) {
    $('ppTodayEstimate').textContent = '-';
    $('ppDailyProjection').textContent = '-';
    $('ppHourlyEstimate').textContent = '-';
    $('ppDayProgress').textContent = 'BJ ' + progress.clockText;
    $('ppEstimateBasis').textContent = '等待路由后，按真实 OPEN/PENDING 覆盖的盘口合计估算；这里只显示 UI 预测，不影响交易。';
    return;
  }
  const todayEstimate = liveHourly * progress.elapsedHours;
  const dailyProjection = liveHourly * 24;
  $('ppTodayEstimate').textContent = compactNumber(todayEstimate, 4) + ' PP';
  $('ppDailyProjection').textContent = compactNumber(dailyProjection, 4) + ' PP';
  $('ppHourlyEstimate').textContent = compactNumber(liveHourly, 4) + ' / ' + compactNumber(targetHourly, 4) + ' PP/hr';
  $('ppDayProgress').textContent = 'BJ ' + progress.clockText + ' · 已过 ' + compactNumber(progress.elapsedHours, 2) + 'h';
  $('ppEstimateBasis').textContent = (running ? '运行中' : '未运行')
    + ' · 主数字按真实已挂/待确认 ' + coverageText + ' 个目标合计'
    + ' · 目标篮子按 ' + selected.length + ' 个目标、' + shareText + ' 路由评分口径对照'
    + ' · 今日值为从北京时间 00:00 起按当前速率折算'
    + routeAge
    + ' · 估算/非官方，不改变策略。';
}

function allUiOrders(payload) {
  if (Array.isArray(payload.activeOrders)) return payload.activeOrders;
  return payload.orders || [];
}

function beijingDayProgress(now = new Date()) {
  const utcMs = now.getTime();
  const beijingOffsetMs = 8 * 60 * 60 * 1000;
  const shifted = new Date(utcMs + beijingOffsetMs);
  const startUtcMs = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - beijingOffsetMs;
  const elapsedHours = Math.max(0, Math.min(24, (utcMs - startUtcMs) / 3600000));
  const clockText = String(shifted.getUTCHours()).padStart(2, '0') + ':' + String(shifted.getUTCMinutes()).padStart(2, '0');
  return {
    elapsedHours,
    remainingHours: Math.max(0, 24 - elapsedHours),
    clockText
  };
}

function renderProofPanel(payload, venue) {
  const checkpoint = payload.routeAudit && payload.routeAudit[venue];
  const audit = checkpoint && checkpoint.value ? checkpoint.value : null;
  const route = payload.route && payload.route[venue] ? payload.route[venue].value : null;
  const maxMarkets = Math.max(1, Number(payload.config.risk && payload.config.risk.maxMarkets || 1));
  if (!audit) {
    $('proofHeadline').textContent = '等待路由审计';
    $('proofSubline').textContent = '启动后会用滚动盘口缓存生成证明；也可以点“审计”做一次只读全站扫描。';
    $('proofCoverage').textContent = '-';
    $('proofMatch').textContent = '-';
    $('proofFailed').textContent = '-';
    $('proofSource').textContent = '-';
    $('proofList').innerHTML = '<div class="empty">暂无审计数据。</div>';
    return;
  }
  const basket = Array.isArray(audit.executionBasket) ? audit.executionBasket : [];
  const fullProof = audit.latestFullAudit && typeof audit.latestFullAudit === 'object' ? audit.latestFullAudit : null;
  const displayAudit = fullProof || audit;
  const displayBasket = fullProof && Array.isArray(fullProof.executionBasket) ? fullProof.executionBasket : basket;
  const ranked = Array.isArray(displayAudit.topByEfficiency) && displayAudit.topByEfficiency.length
    ? displayAudit.topByEfficiency
    : Array.isArray(displayAudit.topByExpected) ? displayAudit.topByExpected : [];
  const selected = route && Array.isArray(route.selected) ? route.selected : [];
  const proof = proofCompare(displayBasket.length ? displayBasket : selected, ranked, maxMarkets);
  const routeProof = displayBasket.length ? proofCompare(selected, displayBasket, maxMarkets) : { matchCount: selected.length, missingHigher: 0 };
  const totals = displayAudit.totals || audit.totals || {};
  const scanned = Number(totals.scanned || 0);
  const safe = Number(totals.safe || 0);
  const failed = Number(totals.failed || 0);
  const tradable = Number(totals.tradable || 0);
  const coverage = Number(displayAudit.coveragePct || audit.coveragePct || 0);
  const source = String(displayAudit.source || audit.source || 'rolling-cache');
  const complete = audit.complete === true || Boolean(fullProof);
  const progress = audit.progress || null;
  const freshness = displayAudit.capturedAt ? formatAge(displayAudit.capturedAt) : audit.capturedAt ? formatAge(audit.capturedAt) : '-';
  const rollingCoverage = fullProof && audit.coveragePct !== undefined
    ? ' · 当前滚动覆盖 ' + compactNumber(Number(audit.coveragePct || 0), 1) + '%'
    : '';
  const headline = fullProof
    ? '完整审计证明：执行篮子已按全站效率榜校验'
    : complete
    ? '完整审计：执行篮子已按全站效率榜校验'
    : source.includes('manual-full-audit-partial')
      ? '分批全站审计：当前证明覆盖 ' + compactNumber(coverage, 1) + '%'
      : '滚动审计：当前证明覆盖 ' + compactNumber(coverage, 1) + '%';
  $('proofHeadline').textContent = headline;
  const progressText = progress && progress.total
    ? ' · 进度 ' + Number(progress.scanned || scanned) + '/' + Number(progress.total || safe) + ' · 剩余 ' + Number(progress.remaining || 0)
    : '';
  $('proofSubline').textContent = '安全市场 ' + safe + ' · 已扫盘口 ' + scanned + ' · 可交易 ' + tradable + progressText + rollingCoverage
    + ' · 审计篮子 ' + displayBasket.length + '/' + maxMarkets
    + ' · 当前路由命中 ' + routeProof.matchCount + '/' + Math.min(maxMarkets, displayBasket.length || maxMarkets)
    + (proof.missingHigher > 0 ? ' · 有 ' + proof.missingHigher + ' 个更高效候选未在执行篮子' : ' · 执行篮子覆盖当前效率榜前列');
  $('proofCoverage').textContent = safe > 0 ? compactNumber(coverage, 1) + '% · ' + scanned + '/' + safe : '无安全市场';
  $('proofMatch').textContent = '篮子 ' + proof.matchCount + '/' + Math.min(maxMarkets, ranked.length || maxMarkets)
    + ' · 路由 ' + routeProof.matchCount + '/' + Math.min(maxMarkets, displayBasket.length || maxMarkets)
    + (proof.missingHigher || routeProof.missingHigher ? ' · 缺 ' + Math.max(proof.missingHigher, routeProof.missingHigher) : '');
  $('proofMatch').className = proof.missingHigher === 0 && routeProof.missingHigher === 0 ? 'live-on' : 'danger-text';
  $('proofFailed').textContent = failed + ' 失败' + (Array.isArray(displayAudit.rejectedTop) && displayAudit.rejectedTop.length ? ' · 拒绝样本 ' + displayAudit.rejectedTop.length : '');
  $('proofSource').textContent = sourceLabel(source) + ' · ' + freshness;
  $('proofList').innerHTML = proofListHtml(proof, displayBasket.length ? displayBasket : selected, ranked, maxMarkets);
}

function proofCompare(basket, ranked, maxMarkets) {
  const basketIds = new Set((basket || []).map((item) => item.tokenId).filter(Boolean));
  const top = (ranked || []).slice(0, maxMarkets);
  const missing = top.filter((item) => item && item.tokenId && !basketIds.has(item.tokenId));
  const matchCount = top.length - missing.length;
  return {
    top,
    missing,
    matchCount,
    missingHigher: missing.length
  };
}

function proofListHtml(proof, basket, ranked, maxMarkets) {
  const rows = [];
  const basketIds = new Set((basket || []).map((item) => item.tokenId).filter(Boolean));
  const top = (ranked || []).slice(0, Math.min(maxMarkets, 8));
  for (let index = 0; index < top.length; index += 1) {
    const item = top[index];
    const inBasket = basketIds.has(item.tokenId);
    rows.push(proofRowHtml(item, index + 1, inBasket ? '执行中' : '未进篮子', inBasket ? 'ok' : 'miss'));
  }
  if (rows.length === 0) {
    return '<div class="empty">审计没有返回可交易效率榜；通常是盘口覆盖不足或候选都被风控拒绝。</div>';
  }
  const extra = proof.missingHigher > 0
    ? '<div class="proof-note">有更高效候选未进入执行篮子时，通常是当前路由保留已有安全订单、分组去重、盘口刚刷新或滚动缓存未完整导致；点“审计”可做一次只读全站复核。</div>'
    : '<div class="proof-note ok">当前执行篮子覆盖了已审计效率榜前列；若来源是 rolling-cache，结论仍受覆盖率限制。</div>';
  return rows.join('') + extra;
}

function proofRowHtml(item, rank, status, tone) {
  const metrics = item.metrics || {};
  const label = (item.outcome ? item.outcome + ' · ' : '') + (item.question || shortId(item.tokenId));
  const efficiency = metrics.ppPerThousandUsd === undefined ? '-' : compactNumber(metrics.ppPerThousandUsd, 4) + ' PP/hr/kUSD';
  const expected = metrics.expectedPpPerHour === undefined ? '-' : compactNumber(metrics.expectedPpPerHour, 4) + ' PP/hr';
  const depth = money(metrics.rewardBandDepthUsd || 0) + ' 奖励带';
  const target = proofTargetText(metrics);
  return '<article class="proof-row ' + tone + '"><span>#' + rank + ' ' + escapeHtml(status) + '</span><strong>' + escapeHtml(label) + '</strong><p>' + escapeHtml(efficiency + ' · ' + expected + ' · ' + target + ' · ' + depth) + '</p></article>';
}

function sourceLabel(source) {
  if (String(source).includes('manual-full-audit-partial')) return '分批全站审计';
  if (String(source).includes('manual-full-audit')) return '手动全站审计';
  if (String(source).includes('complete-cache')) return '完整缓存';
  if (String(source).includes('rolling-cache')) return '滚动缓存';
  return source || '-';
}

function proofTargetText(metrics) {
  const shares = metrics.targetShares ? compactNumber(metrics.targetShares, 4) + ' 份' : '评分目标';
  return shares + '≈' + money(metrics.targetOrderUsd || 0);
}

function fillCircuitBreakerText(value) {
  const positions = Array.isArray(value.positions) ? value.positions : [];
  const first = positions[0] || {};
  const firstText = first.marketId
    ? '市场 ' + first.marketId + (first.outcome ? ' · ' + first.outcome : '')
    : first.tokenId ? 'Token ' + shortId(first.tokenId) : '检测到持仓';
  const extra = positions.length > 1 ? '，另有 ' + (positions.length - 1) + ' 个持仓' : '';
  const exit = value.exit && value.exit.attempted
    ? '止损退出：提交 ' + (value.exit.submitted || 0) + '，阻断 ' + (value.exit.blocked || 0) + '，失败 ' + (value.exit.failed || 0) + '。'
    : '';
  return '检测到现金单边持仓，已撤受管挂单并跳过本轮新增；' + firstText + extra + '。' + exit + ' 持仓消失后系统会自动恢复扫描；只有总止损金额触发才会停止实盘。';
}

function renderPairLegGrid(orders, venue, selected, events = [], routeTs = null) {
  const target = $('pairLegGrid');
  if (!target) return;
  const items = selected || [];
  const signature = JSON.stringify({
    selected: items.map((item) => [item.tokenId, item.side, item.score, item.tradable, item.metrics && item.metrics.expectedPpPerHour, item.metrics && item.metrics.rewardBandDepthUsd]),
    orders: (orders || []).filter((order) => order.venue === venue && ['OPEN', 'PENDING_OPEN'].includes(order.status)).map((order) => [order.tokenId, order.status, order.price, order.size, order.notionalUsd, order.updatedAt]),
    events: (events || []).slice(0, 8).map((event) => [event.ts, event.type, event.message])
  });
  if (signature === state.lastRouteSignature) return;
  state.lastRouteSignature = signature;
  const selectedTokens = new Set(items.map((item) => item.tokenId).filter(Boolean));
  const allActive = activeOrdersForVenue(orders || [], venue);
  const active = allActive.filter((order) => selectedTokens.has(order.tokenId));
  // Also surface any live order NOT in the current basket (orphan / being-cancelled / dropped from selection) as its
  // own detail card, so no real order is ever hidden — symmetric with the Polymarket panel's full order list.
  const orphanHtml = allActive
    .filter((order) => !selectedTokens.has(order.tokenId) && (order.status === 'OPEN' || order.status === 'PENDING_OPEN'))
    .map((order) => polyOrderCard(order, items))
    .join('');
  if (items.length === 0 && orphanHtml === '') {
    target.innerHTML = '<article class="pair-leg empty"><span>篮子目标</span><strong>等待目标市场</strong><p>启动后这里会显示每个目标 token 的方向、挂单状态和缺失原因。</p></article>';
    return;
  }
  target.innerHTML = items.slice(0, 20).map((item, index) => pairLegHtml(item, active, index, events, venue, routeTs)).join('') + orphanHtml;
}

function pairLegHtml(item, activeOrders, index, events = [], venue = '', routeTs = null) {
  const tokenOrders = activeOrders.filter((order) => order.tokenId === item.tokenId);
  const preferred = tokenOrders.find((order) => order.status === 'OPEN')
    || tokenOrders.find((order) => order.status === 'PENDING_OPEN')
    || null;
  const side = item.side || 'BUY';
  const metrics = item.metrics || {};
  const label = '#' + (index + 1) + ' ' + (item.outcome || '机会') + ' ' + side;
  const expected = routeEfficiencyLine(metrics);
  const share = metrics.targetSharePct === undefined ? '-' : compactNumber(metrics.targetSharePct, 3) + '%';
  const target = routeTargetText({ risk: {}, strategy: {} }, metrics, null);
  const quality = expected + ' · ' + target + ' · 占比 ' + share;
  if (!preferred) {
    const reject = latestOrderRejectForToken(events, venue, item.tokenId, routeTs);
    const reason = reject ? botRejectText(reject) : (item.riskFlags || [])[0] || '下一轮会按策略补齐或保持等待。';
    return '<article class="pair-leg missing"><span>' + escapeHtml(label) + '</span><strong>缺失</strong><p>' + escapeHtml(quality) + ' · ' + escapeHtml(reason) + ' · Token ' + escapeHtml(shortId(item.tokenId)) + '</p></article>';
  }
  const statusClass = String(preferred.status || '').toLowerCase().replaceAll('_', '-');
  const statusText = orderStatusLabel[preferred.status] || preferred.status;
  return '<article class="pair-leg ' + escapeHtml(statusClass) + '"><span>' + escapeHtml(label) + '</span><strong>' + escapeHtml(statusText) + ' · price ' + Number(preferred.price).toFixed(4) + '</strong><p>' + escapeHtml(quality) + ' · 实挂 ' + escapeHtml(money(preferred.notionalUsd || preferred.price * preferred.size)) + ' / ' + compactNumber(preferred.size, 4) + ' 份 · ' + (preferred.externalId ? 'ID ' + shortId(preferred.externalId) : shortId(preferred.clientOrderId || preferred.tokenId)) + ' · ' + formatAge(preferred.updatedAt) + '</p></article>';
}

function currentOrderHint(orders, venue, tokenId) {
  const active = orders.filter((order) => order.venue === venue && order.tokenId === tokenId && ['OPEN', 'PENDING_OPEN'].includes(order.status));
  if (active.length === 0) return '当前目标市场还没有开放订单。';
  const pending = active.filter((order) => order.status === 'PENDING_OPEN').length;
  const ids = active.map((order) => order.externalId ? 'ID ' + shortId(order.externalId) : order.status).join(' / ');
  return pending > 0
    ? '已提交，等待平台开放订单确认：' + ids
    : '平台开放订单接口已确认：' + ids;
}

function routeOrderHint(pair) {
  if (!pair || pair.expected <= 1) return '';
  if (pair.missing > 0) return '目标路由还不完整：缺 ' + pair.missing + ' 个订单；循环会继续补齐或按安全规则处理。';
  if (pair.pending > 0) return '平台已返回订单 ID；其中 ' + pair.pending + ' 条腿等待开放订单接口确认。';
  return '目标路由已由平台开放订单接口确认。';
}

function basketOrderStateText(orders, venue, selected, maxMarkets, pair) {
  const selectedTokens = new Set((selected || []).map((item) => item.tokenId).filter(Boolean));
  const active = activeOrdersForVenue(orders || [], venue).filter((order) => selectedTokens.has(order.tokenId));
  const open = active.filter((order) => order.status === 'OPEN').length;
  const pending = active.filter((order) => order.status === 'PENDING_OPEN').length;
  const target = Math.min(maxMarkets, Math.max(selected.length, selectedTokens.size));
  if (target === 0) return '0/' + maxMarkets + ' active';
  if (pair && pair.missing === 0 && pending === 0 && open >= target) return open + '/' + maxMarkets + ' active';
  return active.length + '/' + maxMarkets + ' active · OPEN ' + open + ' · 待确认 ' + pending + ' · 缺 ' + Math.max(0, target - active.length);
}

function basketOrderHint(orders, venue, selected, pair) {
  const selectedTokens = new Set((selected || []).map((item) => item.tokenId).filter(Boolean));
  const active = activeOrdersForVenue(orders || [], venue).filter((order) => selectedTokens.has(order.tokenId));
  if (active.length === 0) return '当前 PP 篮子还没有平台确认的开放订单。';
  const pending = active.filter((order) => order.status === 'PENDING_OPEN').length;
  if (pending > 0) return '有 ' + pending + ' 笔已提交但仍等待开放订单接口确认。';
  if (pair && pair.missing > 0) return '已确认 ' + active.length + ' 笔，剩余目标会在下一轮按余额、盘口和风控补齐。';
  return '平台开放订单接口已确认当前篮子；成交/持仓一旦出现会触发现金单边成交保护。';
}

function currentOrderNextText(payload, venue, current, metrics, groupMetrics) {
  const live = payload.live && payload.live[venue] ? payload.live[venue] : {};
  const target = money((groupMetrics && groupMetrics.targetOrderUsd) || metrics.targetOrderUsd || payload.config.risk.orderSizeUsd || 0);
  const actual = money(payload.config.risk.orderSizeUsd || 0);
  const active = activeOrdersForVenue(allUiOrders(payload), venue).filter((order) => order.tokenId === current.tokenId).length;
  const entryMode = payload.config.strategy && payload.config.strategy.entryMode;
  const scoringShares = metrics && metrics.targetShares ? compactNumber(metrics.targetShares, 4) : '';
  const scoringTarget = metrics && metrics.targetOrderSource === 'reward-minimum-plus-one'
    ? '最低 ' + scoringShares + ' 份；按实挂 ' + target + ' 估算 PP。'
    : '';
  if (live.status === 'running') return entryMode === 'split'
    ? '目标金额 ' + target + '；split 双腿按总预算拆分，更优市场出现时会按规则撤换。'
    : (scoringTarget || ('目标金额 ' + target + '；')) + '按同组奖励带竞争资金下的单边 PP/hr/kUSD 选低竞争机会并持续撤换。';
  if (live.status === 'error') return '循环错误，修复后再继续管理订单。';
  if (active > 0) return '当前已有开放订单；循环未运行，启动后才会继续自动监控和撤换。';
  return (scoringTarget || ('目标金额 ' + target + '；')) + '启动后按 PP/流动性/安全时间自动判断。';
}

function routeRewardMinimumWarning(config, metrics) {
  if (!metrics || metrics.minRewardNotionalUsd === undefined) return '';
  if (!config.strategy || config.strategy.entryMode === 'cash') return '';
  if (config.strategy.enforceRewardMinimum !== false) return '';
  const target = Number(config.risk && config.risk.orderSizeUsd || 0);
  const minimum = Number(metrics.minRewardNotionalUsd || 0);
  if (!Number.isFinite(target) || !Number.isFinite(minimum) || minimum <= target) return '';
  return '当前实挂金额低于 PP 最低份额约 ' + money(minimum) + '，路由按最低份额+1估算，但测试单不保证计 PP';
}

function routeTargetText(config, metrics, groupMetrics) {
  const target = (groupMetrics && groupMetrics.targetOrderUsd) || metrics.targetOrderUsd || config.risk.orderSizeUsd || 0;
  if (metrics && metrics.targetOrderSource === 'reward-minimum-plus-one') {
    const shares = metrics.targetShares ? compactNumber(metrics.targetShares, 4) + '份最低 · ' : '';
    const prefix = '实挂 ';
    return prefix + shares + money(target);
  }
  return money(target);
}

function routeScoringBasisText(config, metrics) {
  if (metrics && metrics.targetOrderSource === 'reward-minimum-plus-one') {
    const shares = metrics.targetShares ? compactNumber(metrics.targetShares, 4) + ' 份' : '最低份额+1';
    const label = '最低份额';
    return label + ' ' + shares + ' · 实挂 ' + money(metrics.targetOrderUsd || 0);
  }
  return '实挂上限 ' + money(config.risk && config.risk.orderSizeUsd || 0);
}

function routeExpectedText(selected, metrics, groupMetrics) {
  const total = selected && selected.length > 0
    ? selected.reduce((sum, item) => sum + Number(item.metrics && item.metrics.expectedPpPerHour || 0), 0)
    : Number((groupMetrics && groupMetrics.expectedPpPerHour) || metrics.expectedPpPerHour || 0);
  const best = Number(metrics.expectedPpPerHour || 0);
  if (!total) return '-';
  return compactNumber(best, 4) + '/hr best · ' + compactNumber(total, 4) + '/hr basket';
}

function routeApiText(metrics, scan, latencyMs, audit) {
  const parts = [];
  if (metrics.spreadCents !== undefined) parts.push(Number(metrics.spreadCents).toFixed(2) + 'c');
  if (scan) {
    const usable = Number(scan.routeUsableOrderbooks || 0);
    const scanned = Number(scan.scannedOrderbooks || 0);
    const cached = Number(scan.cachedOrderbooks || 0);
    if (scanned || usable) parts.push('盘口 ' + usable + '/' + scanned + (cached ? ' 缓存' + cached : ''));
  }
  if (audit && audit.totals) {
    const totals = audit.totals || {};
    const coverage = audit.coveragePct === undefined ? '' : ' ' + compactNumber(audit.coveragePct, 1) + '%';
    parts.push('全站榜 ' + Number(totals.scanned || 0) + '/' + Number(totals.safe || 0) + coverage);
  }
  if (latencyMs) parts.push('UI ' + latencyMs + 'ms');
  return parts.length ? parts.join(' · ') : '-';
}

function basketGapText(selected, maxMarkets, scan, rejectStats, audit) {
  const parts = [];
  const selectedCount = selected.length;
  if (selectedCount < maxMarkets) parts.push('只选到 ' + selectedCount + '/' + maxMarkets);
  if (audit) {
    const basket = Array.isArray(audit.executionBasket) ? audit.executionBasket : [];
  const top = Array.isArray(audit.topByEfficiency) && audit.topByEfficiency.length ? audit.topByEfficiency : (Array.isArray(audit.topByExpected) ? audit.topByExpected : []);
    if (basket.length) parts.push('执行榜 ' + basket.length + '/' + maxMarkets);
    if (top.length) parts.push('全站#1 ' + routeMarketText(top[0]));
    if (audit.source) parts.push(String(audit.source));
  }
  if (scan) {
    const eligible = Number(scan.eligibleMetadata || 0);
    const safe = Number(scan.safeMetadata || 0);
    const usable = Number(scan.routeUsableOrderbooks || 0);
    const scanned = Number(scan.scannedOrderbooks || 0);
    if (eligible) parts.push('官方合格 ' + eligible);
    if (safe) parts.push('安全 ' + safe);
    if (scanned || usable) parts.push('可用盘口 ' + usable + '/' + scanned);
  }
  const topRejects = Array.isArray(rejectStats) ? rejectStats.slice(0, 2).map((item) => rejectLabel(item.reasonCode) + ' ' + item.count) : [];
  parts.push(...topRejects);
  return parts.length ? parts.join(' · ') : '已挂满或等待下一轮扫描';
}

function auditSummaryText(audit) {
  if (!audit || !audit.totals) return '';
  const totals = audit.totals || {};
  const basket = Array.isArray(audit.executionBasket) ? audit.executionBasket : [];
  const source = audit.source ? String(audit.source) : 'rolling-cache';
  const coverage = audit.coveragePct === undefined ? '' : ' / ' + compactNumber(audit.coveragePct, 1) + '%';
  const ranked = Array.isArray(audit.topByEfficiency) && audit.topByEfficiency.length ? audit.topByEfficiency : (Array.isArray(audit.topByExpected) ? audit.topByExpected : []);
  const top = ranked[0] ? ' / 效率#1 ' + routeMarketText(ranked[0]) : '';
  return ' · 全站效率榜 ' + Number(totals.scanned || 0) + '/' + Number(totals.safe || 0) + coverage + ' · 执行 ' + basket.length + ' · ' + source + top;
}

function routeSafetyTimeText(current) {
  const parts = [];
  if (current.startTime) parts.push('开始 ' + futureTimeText(current.startTime, current.startTimeSource));
  if (current.endTime) parts.push('结束 ' + futureTimeText(current.endTime, current.endTimeSource));
  return parts.length > 0 ? parts.join(' / ') : '无明确时间';
}

function competitionText(metrics, groupMetrics) {
  if (metrics.ppPerThousandUsd === undefined || metrics.targetSharePct === undefined) return '未知';
  const band = { balanced: '适中', crowded: '拥挤', thin: '偏薄', unknown: '未知' }[metrics.competitionBand] || '未知';
  const expectedValue = groupMetrics && groupMetrics.expectedPpPerHour !== undefined ? groupMetrics.expectedPpPerHour : metrics.expectedPpPerHour;
  const expected = expectedValue === undefined ? '' : ' · 预计组 ' + compactNumber(expectedValue, 4) + ' PP/hr';
  return band + expected + ' · 占比 ' + compactNumber(metrics.targetSharePct, 2) + '% · 估算/非官方';
}

function routeEfficiencyLine(metrics) {
  if (!metrics) return '-';
  const efficiency = metrics.ppPerThousandUsd === undefined ? '-' : compactNumber(metrics.ppPerThousandUsd, 4) + ' PP/hr/kUSD';
  const expected = metrics.expectedPpPerHour === undefined ? '-' : compactNumber(metrics.expectedPpPerHour, 4) + ' PP/hr';
  return efficiency + ' · ' + expected;
}

function routeDepthText(metrics, groupMetrics) {
  const leg = money(metrics.rewardBandDepthUsd || 0) + ' / ' + money(metrics.topDepthUsd || 0);
  if (!groupMetrics) return leg + ' 同组竞争/前三档';
  return money(groupMetrics.rewardBandDepthUsd || 0) + ' / ' + money(groupMetrics.topDepthUsd || 0) + ' 组';
}

function routeGroupCompareText(selectedGroup, bestGroup, previousGroup) {
  if (!bestGroup && !selectedGroup && !previousGroup) return '';
  const selectedPp = Number((selectedGroup && selectedGroup.expectedPpPerHour) || 0);
  const bestPp = Number((bestGroup && bestGroup.expectedPpPerHour) || 0);
  const previousPp = Number((previousGroup && previousGroup.expectedPpPerHour) || 0);
  const pieces = [];
  if (selectedGroup) pieces.push('当前组预计 ' + compactNumber(selectedPp, 4) + ' PP/hr');
  if (bestGroup && (!selectedGroup || bestGroup.groupKey !== selectedGroup.groupKey)) {
    pieces.push('最优组 ' + compactNumber(bestPp, 4) + ' PP/hr');
  }
  if (bestGroup && previousGroup && bestGroup.groupKey !== previousGroup.groupKey) {
    pieces.push('差额 ' + compactNumber(Math.max(0, bestPp - previousPp), 4) + ' PP/hr');
  }
  return pieces.length ? ' · ' + pieces.join(' · ') : '';
}

function scanSummaryText(scan) {
  if (!scan) return '';
  const total = Number(scan.totalMetadata || 0);
  const eligible = Number(scan.eligibleMetadata || 0);
  const scanned = Number(scan.scannedOrderbooks || 0);
  const routeUsable = Number(scan.routeUsableOrderbooks || 0);
  const cached = Number(scan.cachedOrderbooks || 0);
  const scannedGroups = Number(scan.scannedGroups || 0);
  const safeGroups = Number(scan.safeGroups || scan.eligibleGroups || 0);
  const coveragePct = Number(scan.coveragePct || 0);
  const active = Number(scan.active || 0);
  const explore = Number(scan.explore || 0);
  if (!total && !eligible && !scanned) return '';
  const tiers = [];
  if (active) tiers.push('active ' + active);
  if (explore) tiers.push('explore ' + explore);
  const groups = safeGroups ? ' / ' + scannedGroups + '/' + safeGroups + ' 组' : '';
  const coverage = coveragePct ? ' / ' + compactNumber(coveragePct, 1) + '%' : '';
  const routeCoverage = routeUsable > scanned ? ' / 路由可用 ' + routeUsable + '（缓存 ' + cached + '）' : '';
  return ' · 扫描 ' + total + ' 全量 / ' + eligible + ' 合格 / ' + scanned + ' 盘口' + routeCoverage + groups + coverage + (tiers.length ? '（' + tiers.join(' / ') + '）' : '');
}

function emptyRouteReason(payload, venue) {
  const scan = payload.marketScan && payload.marketScan[venue] ? payload.marketScan[venue].value : null;
  const text = scanSummaryText(scan);
  return '启动后会显示当前目标市场、选择原因和切换状态。' + text;
}

function routeOrderState(orders, events, venue, tokenId, afterTs) {
  const active = orders.filter((order) => order.venue === venue && order.tokenId === tokenId && ['OPEN', 'PENDING_OPEN'].includes(order.status));
  if (active.length === 0) {
    const latestReject = latestOrderRejectForToken(events, venue, tokenId, afterTs);
    return latestReject ? '未挂：' + botRejectText(latestReject) : '等待下单';
  }
  const sides = active.map((order) => (order.side === 'BUY' ? '买' : '卖') + ' ' + Number(order.price).toFixed(4) + ' · ' + money(order.notionalUsd || order.price * order.size) + (order.status === 'PENDING_OPEN' ? ' 待确认' : '')).join(' / ');
  return active.length + ' 单 · ' + sides;
}

function latestOrderRejectForToken(events, venue, tokenId, afterTs) {
  const after = afterTs ? new Date(afterTs).getTime() - 5000 : 0;
  return (events || []).find((event) => {
    if (event.venue !== venue) return false;
    if (after && new Date(event.ts).getTime() < after) return false;
    if (!['risk.reject', 'risk.final-reject', 'risk.market-guard.reject', 'risk.market-guard.final-reject', 'risk.balance-skip', 'risk.inventory-skip'].includes(event.type)) return false;
    const details = event.details || {};
    const intent = details.intent || details.decision?.intent || {};
    if (intent.tokenId === tokenId) return true;
    return typeof event.message === 'string' && event.message.includes(tokenId);
  }) || null;
}

function renderBalanceSummary(payload, venue) {
  const liveAccount = payload && payload.accountLive && payload.accountLive[venue] ? payload.accountLive[venue] : null;
  const direct = state.balances && state.balances.venue === venue ? state.balances : null;
  const liveTs = liveAccount && liveAccount.capturedAt ? new Date(liveAccount.capturedAt).getTime() : 0;
  const directTs = direct && direct.capturedAt ? new Date(direct.capturedAt).getTime() : 0;
  const directIsNewer = direct && (!liveAccount || directTs >= liveTs);
  const maxAgeMs = payload && payload.config && payload.config.risk
    ? Number(payload.config.risk.maxAccountRiskStaleMs || 30000)
    : 30000;
  if (directIsNewer) {
    if (direct.error) {
      $('metricBalanceSummary').textContent = '刷新失败';
      $('metricBalanceSummary').className = 'danger-text';
      const target = $('balanceList');
      if (target) target.innerHTML = '<div class="empty">实时余额刷新失败：' + escapeHtml(direct.error) + '</div>';
      return;
    }
    const balances = direct.balances || [];
    const primary = balances.find((item) => ['USDT', 'USDC', 'PUSD', 'USD'].includes(String(item.asset).toUpperCase())) || balances[0];
    const stale = directTs > 0 && Date.now() - directTs > maxAgeMs;
    $('metricBalanceSummary').textContent = primary
      ? displayBalanceAmount(primary).toFixed(2) + ' ' + primary.asset + (stale ? '（已过期）' : '')
      : '暂无余额';
    $('metricBalanceSummary').className = primary && !stale ? 'live-on' : 'danger-text';
    return;
  }
  if (liveAccount && liveAccount.available) {
    const primary = primaryAccountBalance(liveAccount);
    const equity = liveAccount.equityUsd;
    const stale = Boolean(liveAccount.stale);
    if (primary) {
      $('metricBalanceSummary').textContent = displayBalanceAmount(primary).toFixed(2) + ' ' + primary.asset + (stale ? '（旧快照）' : '');
      $('metricBalanceSummary').className = stale ? 'danger-text' : 'live-on';
    } else if (equity !== undefined) {
      $('metricBalanceSummary').textContent = money(equity) + ' 权益' + (stale ? '（旧快照）' : '');
      $('metricBalanceSummary').className = stale ? 'danger-text' : 'live-on';
    } else {
      $('metricBalanceSummary').textContent = '有快照，无余额';
      $('metricBalanceSummary').className = 'danger-text';
    }
    renderAccountBalanceList(liveAccount);
    return;
  }
  if (!state.balances || state.balances.venue !== venue) {
    $('metricBalanceSummary').textContent = '未刷新';
    $('metricBalanceSummary').className = '';
    return;
  }
  const balances = state.balances.balances || [];
  const primary = balances.find((item) => ['USDT', 'USDC', 'PUSD', 'USD'].includes(String(item.asset).toUpperCase())) || balances[0];
  $('metricBalanceSummary').textContent = primary ? (displayBalanceAmount(primary).toFixed(2) + ' ' + primary.asset) : '暂无余额';
  $('metricBalanceSummary').className = primary ? 'live-on' : 'danger-text';
}

function primaryAccountBalance(account) {
  const balances = account && Array.isArray(account.balances) ? account.balances : [];
  return balances.find((item) => ['USDT', 'USDC', 'PUSD', 'USD'].includes(String(item.asset).toUpperCase())) || balances[0] || null;
}

function renderAccountBalanceList(account) {
  const target = $('balanceList');
  if (!target) return;
  const balances = Array.isArray(account.balances) ? account.balances : [];
  const address = shortId(account.account);
  const captured = account.capturedAt ? ' · 快照 ' + formatAge(account.capturedAt) : '';
  const equity = account.equityUsd !== undefined ? '<div class="balance-item"><span>账户权益</span><strong>' + money(account.equityUsd) + '</strong><em>本轮 PnL ' + (account.dailyPnlUsd === undefined ? '未知' : signedMoney(account.dailyPnlUsd)) + '</em></div>' : '';
  if (balances.length === 0) {
    target.innerHTML = '<div class="balance-address">账户：' + address + captured + '</div>' + equity + '<div class="empty">账户快照没有返回可显示余额；可点“刷新余额”做一次只读实时查询。</div>';
    return;
  }
  target.innerHTML = '<div class="balance-address">账户：' + address + captured + '</div>' + equity + balances.map((item) => balanceItemHtml(item)).join('');
}

function renderOpenOrderRisk(payload, venue) {
  const risk = payload && payload.orderRisk && payload.orderRisk[venue] ? payload.orderRisk[venue] : null;
  const card = $('orderRiskCard');
  if (!card || !risk) return;
  const hasOrders = Number(risk.openOrders || 0) > 0;
  $('orderRiskLoss').textContent = hasOrders ? money(risk.estimatedWorstCaseLossUsd || 0) : '$0.00';
  $('orderRiskLoss').className = risk.exceedsLossRemaining ? 'danger-text' : hasOrders ? '' : 'live-on';
  $('orderRiskExposure').textContent = money(risk.notionalUsd || 0);
  $('orderRiskOpenCount').textContent = String(risk.openOrders || 0) + ' 笔';
  $('orderRiskRemaining').textContent = risk.lossRemainingUsd === undefined ? '未知' : money(risk.lossRemainingUsd);
  $('orderRiskRemaining').className = risk.exceedsLossRemaining ? 'danger-text' : '';
  $('orderRiskBreakdown').textContent = 'BUY ' + money(risk.buyNotionalUsd || 0) + ' / SELL ' + money(risk.sellNotionalUsd || 0);
  $('orderRiskHint').textContent = hasOrders
    ? '开放订单未成交前不是已亏损；这里按 BUY 本金 + SELL 潜在赔付估算最坏亏损，并和本轮止损余量对比。'
    : '当前没有开放订单；有挂单后这里会显示占用金额、最坏亏损估算和止损余量。';
  card.className = 'order-risk-card ' + (risk.exceedsLossRemaining ? 'blocked' : hasOrders ? 'active' : 'idle');
}

function renderBalances(payload) {
  state.balances = payload;
  renderBalanceSummary(state.lastPayload, payload.venue);
  const target = $('balanceList');
  const balances = payload.balances || [];
  const address = shortId(payload.address);
  if (balances.length === 0) {
    target.innerHTML = '<div class="empty">账户 ' + address + ' 暂无可显示余额，或平台余额接口没有返回数据。</div>';
    return;
  }
  target.innerHTML = '<div class="balance-address">余额地址：' + address + '</div>' + balances.map((item) => balanceItemHtml(item)).join('');
}

function balanceItemHtml(item) {
  const available = Number(item.available || 0);
  const total = Number(item.total || 0);
  const amount = displayBalanceAmount(item);
  const same = Math.abs(available - total) < 0.00000001;
  return '<div class="balance-item"><span>' + escapeHtml(item.asset) + '</span><strong>余额 ' + amount.toFixed(4) + '</strong><em>' + (same ? '可用同余额' : ('可用 ' + available.toFixed(4) + ' / 总额 ' + total.toFixed(4))) + '</em></div>';
}

function displayBalanceAmount(item) {
  return Math.max(Number(item.available || 0), Number(item.total || 0));
}

function renderStartupFacts(facts) {
  state.startupFacts = facts;
  const card = $('startupFactsCard');
  card.className = 'startup-card ' + (facts.readyToQuote ? 'ready' : 'blocked');
  $('startupSummary').textContent = facts.summary || '检查完成';
  $('startupHint').textContent = facts.readyToQuote
    ? '这是基于平台刚返回的余额、库存、开放订单和账户风控计算出来的实际启动结果。'
    : (facts.blockingReasons || []).slice(0, 2).join('；') || '启动条件不完整。';
  const funds = facts.funds || {};
  $('startupFunds').textContent = fundsText(funds);
  $('startupExpected').textContent = startupExpectedText(facts);
  $('startupBuy').textContent = sideFactText(facts.sides && facts.sides.BUY);
  $('startupSell').textContent = sideFactText(facts.sides && facts.sides.SELL);
  const inventory = facts.inventory || {};
  $('startupInventory').textContent = inventory.tokenCount
    ? inventory.tokenCount + ' 个 token，估值 ' + money(inventory.totalNotionalUsd || 0)
    : facts.splitEntry?.canAttempt
      ? '无库存；下一轮先拆分'
      : '无可卖库存';
  if ($('startupGasAddress')) $('startupGasAddress').textContent = startupGasAddressText(facts);
  if ($('startupSplitEntry')) $('startupSplitEntry').textContent = splitEntryText(facts.splitEntry);
  $('startupRisk').textContent = startupRiskText(facts);
  if ($('startupRewardMinimum')) $('startupRewardMinimum').textContent = rewardMinimumText(facts.rewardMinimum);
  $('startupSettlement').textContent = settlementText(facts.marketGuard);
  appendStartupDataStatus(facts);
}

function fundsText(funds) {
  const parts = [
    (funds.asset || 'USD') + ' 可用 ' + money(funds.availableUsd || 0),
    '预留 ' + money(funds.reserveUsd || 0),
    '开放订单估算占用 ' + money(funds.reservedOpenOrdersUsd || 0),
    '可新增 ' + money(funds.spendableUsd || 0)
  ];
  if (funds.actualFrozenUsd !== undefined) {
    parts.push('平台冻结 ' + money(funds.actualFrozenUsd || 0));
    const drift = funds.reserveDriftUsd !== undefined ? money(funds.reserveDriftUsd || 0) : '-';
    const pct = funds.reserveDriftPct !== undefined ? Number(funds.reserveDriftPct || 0).toFixed(2) + '%' : '-';
    parts.push((funds.reserveDriftOk === false ? '偏差异常 ' : '偏差正常 ') + drift + ' / ' + pct);
  } else {
    parts.push('平台未返回独立冻结余额，按估算占用');
  }
  return parts.join('，');
}

function startupExpectedText(facts) {
  if (facts && facts.splitEntry && facts.splitEntry.active) {
    if (facts.splitEntry.status === 'gas-insufficient') return '不能拆分：BNB 手续费不足';
    if (facts.splitEntry.status === 'gas-warning') return '可尝试动态估算：真实拆分前会复检 BNB 手续费';
    if (facts.splitEntry.canAttempt) return '先拆完整套仓，预计双边 SELL ' + (facts.splitEntry.plannedSellOrders || 0) + ' 笔';
    if (facts.splitEntry.hasCompleteInventory) return '已有完整套仓，预计双边 SELL ' + (facts.expected?.sellOrders || 0) + ' 笔';
    return '完整套仓入口未通过，预计不新增挂单';
  }
  return 'BUY ' + (facts.expected?.buyOrders || 0) + ' / SELL ' + (facts.expected?.sellOrders || 0) + '，共 ' + (facts.expected?.totalOrders || 0) + ' 笔';
}


function resetStartupFacts(reason) {
  state.startupFacts = null;
  const card = $('startupFactsCard');
  card.className = 'startup-card pending';
  $('startupSummary').textContent = '还没有检查';
  $('startupHint').textContent = reason || '点击“检查启动条件”，这里会显示预计单边/双边挂单、库存、余额和风控结果。';
  ['startupFunds', 'startupExpected', 'startupBuy', 'startupSell', 'startupInventory', 'startupGasAddress', 'startupSplitEntry', 'startupRisk', 'startupRewardMinimum', 'startupSettlement', 'routeTime'].forEach((id) => {
    if (!$(id)) return;
    $(id).textContent = '未检查';
  });
}

function rewardMinimumText(rewardMinimum) {
  if (!rewardMinimum) return '未检查';
  return rewardMinimum.message || (rewardMinimum.enforce ? '严格检查' : '未强制最低份额');
}

function sideFactText(fact) {
  if (!fact) return '未检查';
  return fact.label + '：' + fact.reason;
}

function splitEntryText(splitEntry) {
  if (!splitEntry || !splitEntry.active) return '未启用';
  if (splitEntry.status === 'ready-with-inventory') return '已持有完整 YES/NO 套仓；下一轮复检双边 SELL。';
  if (splitEntry.status === 'gas-insufficient') return compactUiMessage(splitEntry.message || '普通挂单不需要 BNB；但自动 split/merge 是链上交易，当前 BNB 手续费余额不足。');
  if (splitEntry.status === 'gas-warning') return compactUiMessage(splitEntry.message || '当前只有兜底 gas 估算；真实拆分前会再次动态估算。');
  if (splitEntry.status === 'ready-to-split') {
    const estimate = splitEntry.estimatedFullOrderSplitUsd
      ? ' 挂满目标金额估算需 ' + money(splitEntry.estimatedFullOrderSplitUsd) + '，余额不足会按实际库存缩小。'
      : '';
    return '可尝试：按平台最低拆分完整 YES/NO 套仓，再双边 SELL。' + estimate;
  }
  return splitEntry.message || '完整套仓入口未通过。';
}

function startupGasAddressText(facts) {
  const gas = facts.nativeGas || (facts.splitEntry && facts.splitEntry.gas);
  const address = gas && gas.address ? gas.address : facts.signerAddress;
  if (!address) return '未检测到签名钱包地址';
  const balance = gas ? ' · 当前 ' + compactNumber(gas.balance || 0, 8) + ' ' + (gas.asset || 'BNB') : '';
  const required = gas && gas.required ? ' · 至少 ' + compactNumber(gas.required, 8) + ' ' + (gas.asset || 'BNB') : '';
  const detail = gas && gas.estimatedGasUnits
    ? ' · ' + (gas.estimateStatus === 'fallback' ? '兜底估算' : '动态估算') + ' ' + compactNumber(gas.estimatedGasUnits, 0) + ' gas @ ' + compactNumber(gas.gasPriceGwei || 0, 2) + ' gwei'
    : '';
  const status = gas ? (gas.ok ? '手续费足够' : '手续费不足/待复检') : 'split/merge 手续费地址';
  return status + '：' + address + balance + required + detail;
}

function startupRiskText(facts) {
  const guard = facts.marketGuard || {};
  if (guard.checked && guard.blocked) {
    const sample = guard.sample && guard.sample[0] && guard.sample[0].decision ? '；' + guard.sample[0].decision.message : '';
    return (guard.ok ? '部分候选时间风险 ' : '市场时间风险 ') + guard.blocked + '/' + guard.checked + sample;
  }
  const accountRisk = facts.accountRisk || {};
  return accountRisk.message || facts.dataStatus?.accountRisk?.message || '未检查';
}

function appendStartupDataStatus(facts) {
  const statuses = facts.dataStatus || {};
  const failed = Object.entries(statuses)
    .filter(([, status]) => status && status.ok === false)
    .map(([name, status]) => dataStatusLabel(name) + '：' + status.message);
  if (failed.length === 0) return;
  $('startupHint').textContent = $('startupHint').textContent + ' 数据源异常：' + failed.slice(0, 3).join('；');
}

function dataStatusLabel(name) {
  return {
    balances: '余额/RPC',
    positions: '库存',
    openOrders: '开放订单',
    accountRisk: '账户风控',
    markets: '市场列表'
  }[name] || name;
}

function settlementText(guard) {
  if (!guard || !guard.checked) return '未检查候选市场';
  const parts = ['检查 ' + guard.checked + ' 个，阻断 ' + guard.blocked + ' 个'];
  if (guard.unknownEndTime) parts.push('未知结束 ' + guard.unknownEndTime);
  if (guard.nearSettlement) parts.push('停新单 ' + guard.nearSettlement);
  if (guard.cancelWindow) parts.push('撤单窗口 ' + guard.cancelWindow);
  if (guard.nearEventStart) parts.push('临近开始 ' + guard.nearEventStart);
  if (guard.eventStarted) parts.push('已开始 ' + guard.eventStarted);
  const sample = Array.isArray(guard.sample) && guard.sample[0] ? guard.sample[0].decision : null;
  if (sample && sample.endTime) {
    parts.push('最近风险 ' + new Date(sample.endTime).toLocaleString() + ' · ' + (sample.endTimeSource || 'unknown'));
  }
  return parts.join(' · ');
}
`;
