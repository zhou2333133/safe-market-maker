export const clientRenderListsScript = String.raw`
function renderOrders(orders) {
  const signature = JSON.stringify((orders || []).map((order) => [order.clientOrderId, order.externalId, order.status, order.price, order.size, order.notionalUsd, order.updatedAt]));
  if (signature === state.lastOrdersSignature) return;
  state.lastOrdersSignature = signature;
  const body = $('ordersBody');
  body.innerHTML = '';
  if (orders.length === 0) {
    body.innerHTML = '<tr><td colspan="6" class="empty">暂无订单；启动后这里会显示目标市场、价格、数量和提交状态。</td></tr>';
    return;
  }
  for (const order of orders) {
    const tr = document.createElement('tr');
    const statusClass = String(order.status || '').toLowerCase();
    const token = shortId(order.tokenId);
    const reasonText = orderReasonLabel(order);
    const reason = reasonText ? '<small>' + escapeHtml(reasonText) + '</small>' : '';
    const location = order.question || order.marketId || token;
    const locationHint = location === token ? '' : '<small>Token ' + token + '</small>';
    tr.innerHTML = '<td>' + (venueLabel[order.venue] || order.venue) + '</td><td><strong>' + escapeHtml(location) + '</strong>' + locationHint + reason + '</td><td><span class="pill ' + order.side.toLowerCase() + '">' + (sideLabel[order.side] || order.side) + '</span></td><td>' + Number(order.price).toFixed(4) + '</td><td>' + compactNumber(order.size, 4) + '<small>' + money(order.notionalUsd || order.price * order.size) + '</small></td><td><span class="status-chip ' + statusClass + '">' + (orderStatusLabel[order.status] || order.status) + '</span><small>' + formatAge(order.updatedAt) + '</small></td>';
    body.appendChild(tr);
  }
}

function orderReasonLabel(order) {
  if (order.status === 'PENDING_OPEN') return '平台已返回订单ID，等待开放订单接口确认';
  if (order.status === 'UNKNOWN' && order.reason === 'submit-exception') return '平台拒单，未挂上';
  if (order.reason === 'submit-exception') return '平台提交失败';
  return order.reason || '';
}

function renderEvents(events) {
  const signature = JSON.stringify((events || []).map((event) => [event.id, event.ts, event.type, event.message, event.severity]));
  if (signature === state.lastEventsSignature) return;
  state.lastEventsSignature = signature;
  const list = $('eventsList');
  list.innerHTML = '';
  if (events.length === 0) {
    list.innerHTML = '<div class="empty">暂无日志</div>';
    return;
  }
  for (const event of events) {
    const item = document.createElement('div');
    item.className = 'event ' + event.severity + (event.local ? ' local' : '');
    const label = eventLabel[event.type] || event.type;
    const venue = event.venue ? ' · ' + (venueLabel[event.venue] || event.venue) : '';
    item.innerHTML = '<span>' + escapeHtml(label + venue) + '</span><strong>' + escapeHtml(event.message) + '</strong><time>' + new Date(event.ts).toLocaleTimeString() + '</time>';
    list.appendChild(item);
  }
}

function visibleEvents(serverEvents) {
  const recentLocal = state.localEvents.filter((event) => Date.now() - new Date(event.ts).getTime() < 120000);
  state.localEvents = recentLocal;
  return [...recentLocal, ...serverEvents].slice(0, 30);
}

function appendLocalEvent(type, message, severity = 'info') {
  state.localEvents.unshift({
    id: 'local-' + Date.now() + '-' + Math.random().toString(16).slice(2),
    ts: new Date().toISOString(),
    venue: $('liveVenue') ? $('liveVenue').value : undefined,
    severity,
    type,
    message,
    local: true
  });
  state.localEvents = state.localEvents.slice(0, 10);
  renderEvents(visibleEvents(state.lastPayload?.events || []));
}

function renderConfigCards(targetId, value, meta) {
  const target = $(targetId);
  target.innerHTML = '';
  for (const [key, item] of Object.entries(value)) {
    const info = meta[key] || [key, '', ''];
    const card = document.createElement('article');
    card.className = 'explain-card';
    const unit = info[1] ? '<span class="unit">' + info[1] + '</span>' : '';
    card.innerHTML = '<div class="card-top"><span>' + info[0] + '</span>' + unit + '</div><strong>' + cnValue(key, item) + '</strong><p>' + info[2] + '</p>';
    target.appendChild(card);
  }
}

function populateTradingSettings(payload) {
  const risk = payload.config.risk || {};
  const strategy = payload.config.strategy || {};
  if (!settingsDirtyFor('predict')) {
    setCheckedIfPresent('settingPredictLiveEnabled', liveEnabledForVenue(payload, 'predict'));
    setValueIfPresent('settingOrderSize', risk.orderSizeUsd ?? '');
    setValueIfPresent('settingMaxMarkets', risk.maxMarkets ?? 1);
    const ppConfig = payload.config.predictParams || { risk: {}, strategy: {} };
    setValueIfPresent('settingPredictCashBuyStaleGraceMs', ppConfig.strategy.predictCashBuyStaleGraceMs ?? 0);
    setValueIfPresent('settingPredictFrontDepthUsd', ppConfig.strategy.predictFrontDepthUsd ?? 200);
    setValueIfPresent('settingPredictFastQuoteMs', ppConfig.strategy.predictFastQuoteMs ?? 0);
    setValueIfPresent('settingPredictFullCycleMs', ppConfig.strategy.predictFullCycleMs ?? 0);
    setValueIfPresent('settingPredictCrowdedThreshold', ppConfig.strategy.predictCrowdedThreshold ?? 0);
    setValueIfPresent('settingCashMaxExitLossPct', strategy.cashMaxExitLossPct ?? 30);
    setValueIfPresent('settingMaxDailyLossUsd', risk.maxDailyLossUsd ?? '');
  }
  if (!settingsDirtyFor('polymarket')) {
    // Polymarket reads from its OWN independent block (config.polymarketParams), not Predict's base strategy.
    const pp = payload.config.polymarketParams || { risk: {}, strategy: {} };
    const pstrat = pp.strategy || {};
    const prisk = pp.risk || {};
    setCheckedIfPresent('settingPolymarketLiveEnabled', liveEnabledForVenue(payload, 'polymarket'));
    setValueIfPresent('settingPolymarketOrderSize', prisk.orderSizeUsd ?? 10);
    setValueIfPresent('settingPolymarketStartLevel', pstrat.polymarketStartLevel ?? 2);
    setValueIfPresent('settingPolymarketFrontDepthUsd', pstrat.polymarketFrontDepthUsd ?? 150);
    // The count field reflects the REAL cap (polymarketParams.risk.maxMarkets), not the vestigial polymarketMaxMarkets.
    setValueIfPresent('settingPolymarketMaxMarkets', prisk.maxMarkets ?? 1);
    setValueIfPresent('settingPolymarketMaxLossUsd', pstrat.polymarketMaxLossUsd ?? 0);
    setValueIfPresent('settingPolymarketCashMaxExitLossPct', pstrat.cashMaxExitLossPct ?? 10);
    setValueIfPresent('settingPolymarketFastQuoteMs', pstrat.polymarketFastQuoteMs ?? 0);
  }
  setValueIfPresent('marketMinLiquidity', strategy.minMarketLiquidityUsd ?? 0);
  setValueIfPresent('marketMinRewardLevel', String(strategy.minRewardLevel ?? 4));
  setCheckedIfPresent('marketPointsOnly', strategy.pointsOnly !== false);
  setCheckedIfPresent('marketAcceptingOnly', strategy.acceptingOnly !== false);
}

function setValueIfPresent(id, value) {
  const node = $(id);
  if (node) node.value = value;
}

function setCheckedIfPresent(id, value) {
  const node = $(id);
  if (node) node.checked = Boolean(value);
}
function renderPredictReport(report, wsh) {
  const container = $('predictReport');
  if (!container) return;
  if (!report || !report.orders || report.orders.length === 0) {
    container.innerHTML = '<div class="panel"><div class="panel-title">Predict 持仓报告</div><div class="empty">暂无活跃挂单。启动实盘后这里会显示每笔订单的积分预估。</div></div>';
    return;
  }
  const { activeOrders, totalExpectedPtsPerHour, booksCovered, wsWatchedMarkets, orders } = report;
  let html = '<div class="panel"><div class="panel-title">Predict 持仓报告 | ' + activeOrders + ' 个活跃 | ' + totalExpectedPtsPerHour.toFixed(1) + ' pts/h';
  if (wsh) html += wsh.connected
    ? ' | <span style="color:#98c379">WS🟢实时盘口 缓存' + (wsh.cachedOrderbooks || 0) + '/订阅' + (wsh.watchedMarkets || 0) + '</span>'
    : ' | <span style="color:#e06c75">WS🔴断线·REST兜底</span>';
  else if (wsWatchedMarkets > 0) html += ' | WS 订阅 ' + wsWatchedMarkets + ' 个市场';
  if (booksCovered < activeOrders) html += ' | <span style="color:#c678dd">盘口覆盖 ' + booksCovered + '/' + activeOrders + '</span>';
  html += '</div><table class="report-table"><thead><tr><th>市场</th><th>方向</th><th>价格</th><th>挂单位置</th><th>预期 pt/h</th><th>占奖励带</th><th>竞争资金</th><th>拥挤度</th><th>资金效率</th><th>盘口年龄</th></tr></thead><tbody>';
  for (const order of orders) {
    const bandClass = order.competitionBand === 'crowded' ? 'warn' : order.competitionBand === 'thin' ? 'muted' : order.competitionBand === 'balanced' ? 'ok' : '';
    html += '<tr>';
    html += '<td>' + escapeHtml(order.question) + '</td>';
    html += '<td><span class="pill ' + order.side.toLowerCase() + '">' + (order.side === 'BUY' ? '买' : '卖') + '</span></td>';
    html += '<td>' + Number(order.price).toFixed(4) + '</td>';
    html += '<td>' + escapeHtml(order.depthLevel) + '</td>';
    html += '<td><strong>' + order.expectedPtsPerHour.toFixed(2) + '</strong></td>';
    html += '<td>' + order.sharePct.toFixed(2) + '%</td>';
    html += '<td>' + money(order.competitionUsd) + '</td>';
    html += '<td><span class="band ' + bandClass + '">' + competitionLabel(order.competitionBand) + '</span></td>';
    html += '<td>' + order.ppPerThousandUsd.toFixed(2) + ' pt/k</td>';
    html += '<td>' + formatAgeMs(order.bookAgeMs) + '</td>';
    html += '</tr>';
  }
  html += '</tbody></table></div>';
  container.innerHTML = html;
}

function competitionLabel(band) {
  if (band === 'crowded') return '拥挤';
  if (band === 'balanced') return '适中';
  if (band === 'thin') return '偏薄';
  return '未知';
}

function formatAgeMs(ms) {
  if (ms == null || !Number.isFinite(ms)) return '---';
  if (ms < 2000) return '实时';
  if (ms < 60000) return Math.round(ms/1000) + 's';
  return Math.round(ms/60000) + 'min';
}

function money(val) {
  if (val == null || !Number.isFinite(val)) return '---';
  return '$' + val.toFixed(0);
}
`;
