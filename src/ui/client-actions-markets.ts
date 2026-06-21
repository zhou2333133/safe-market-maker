export const clientActionsMarketsScript = String.raw`
async function refresh() {
  if (state.refreshInFlight) return;
  state.refreshInFlight = true;
  const started = performance.now();
  const forceFull = !state.lastPayload || Date.now() - state.lastFullRefreshAt > 60000;
  try {
    const payload = await api(forceFull ? '/api/status' : '/api/status/summary');
    state.lastStatusLatencyMs = Math.round(performance.now() - started);
    if (forceFull) state.lastFullRefreshAt = Date.now();
    state.refreshFailures = 0;
    state.refreshIntervalMs = state.lastStatusLatencyMs > 4000 ? 12000 : state.lastStatusLatencyMs > 2000 ? 9000 : 7000;
    renderPredictReport(payload.predictReport, payload.wsHealth && payload.wsHealth.predict && payload.wsHealth.predict.value);
    renderStatus(payload);
  } catch (error) {
    state.refreshFailures += 1;
    state.refreshIntervalMs = Math.min(30000, 7000 + state.refreshFailures * 5000);
    throw error;
  } finally {
    state.refreshInFlight = false;
    scheduleRefresh();
  }
}

function scheduleRefresh() {
  if (state.refreshTimer) window.clearTimeout(state.refreshTimer);
  state.refreshTimer = window.setTimeout(() => refresh().catch(() => undefined), state.refreshIntervalMs);
}

async function loadMarkets() {
  const venue = $('marketVenue').value;
  const top = $('marketTop').value;
  const params = new URLSearchParams({
    venue,
    top,
    minLiquidityUsd: $('marketMinLiquidity').value || '0',
    minRewardLevel: $('marketMinRewardLevel').value || '4',
    pointsOnly: String($('marketPointsOnly').checked),
    acceptingOnly: String($('marketAcceptingOnly').checked)
  });
  const payload = await api('/api/recommendations?' + params.toString());
  state.latestRecommendations = payload.recommendations || [];
  state.marketsLoaded = true;
  const list = $('marketList');
  list.innerHTML = '';
  if (state.latestRecommendations.length === 0) {
    list.innerHTML = '<div class="empty">没有推荐结果</div>';
    return;
  }
  for (const rec of state.latestRecommendations) {
    const market = rec.market;
    const row = document.createElement('article');
    row.className = 'market-row';
    const reasons = (rec.reasonsZh || rec.reasons || []).slice(0, 5).map(escapeHtml).join(' · ');
    const flags = (rec.riskFlagsZh || rec.riskFlags || []).slice(0, 3).map(escapeHtml).join(' · ');
    const outcome = market.outcome ? ' · outcome ' + escapeHtml(market.outcome) : '';
    const minShares = market.rewards && market.rewards.minShares ? '<span>最低份额 ' + Number(market.rewards.minShares).toLocaleString('en-US') + '</span>' : '';
    const maxSpread = market.rewards && market.rewards.maxSpreadCents ? '<span>奖励价差 ' + Number(market.rewards.maxSpreadCents) + 'c</span>' : '';
    const endTime = '<span>' + escapeHtml(futureTimeText(market.endTime, market.endTimeSource)) + '</span>';
    const startTime = market.startTime ? '<span>' + escapeHtml(futureTimeText(market.startTime, market.startTimeSource)) + '</span>' : '';
    row.innerHTML = '<div><h3>' + escapeHtml(market.question) + '</h3><p>' + shortId(market.tokenId) + outcome + ' · 积分评分 ' + Number(rec.score).toFixed(1) + ' · ' + reasons + (flags ? ' · 风险：' + flags : '') + '</p></div><div class="market-meta"><span>' + money(market.liquidityUsd) + ' 总流动性</span><span>' + money(market.volume24hUsd) + ' 24h量</span><span>' + rewardLabel(market.rewards) + '</span>' + minShares + maxSpread + startTime + endTime + '</div>';
    list.appendChild(row);
  }
}

async function runRouteAudit() {
  const venue = $('liveVenue').value;
  await withBusyButton('routeAuditBtn', '审计中', async () => {
    state.routeAuditRunning = true;
    appendLocalEvent('ui.route-audit.requested', '开始分批只读全站路由审计；每批最多读取 12 个安全候选盘口。');
    setAlert('info', '正在分批做只读全站审计，不会下单也不会撤单。');
    try {
      let payload = null;
      for (let step = 0; step < 24; step += 1) {
        const params = new URLSearchParams({
          venue,
          top: '80',
          batchSize: '12',
          delayMs: '0',
          orderbookConcurrency: '6',
          orderbookTimeoutMs: '6000',
          reset: step === 0 ? 'true' : 'false'
        });
        payload = await api('/api/route-audit?' + params.toString());
        const progress = payload.audit && payload.audit.progress ? payload.audit.progress : {};
        appendLocalEvent(
          payload.audit && payload.audit.complete ? 'ui.route-audit.completed' : 'ui.route-audit.progress',
          '审计进度 ' + Number(progress.scanned || 0) + '/' + Number(progress.total || 0) + '，剩余 ' + Number(progress.remaining || 0)
        );
        state.lastFullRefreshAt = 0;
        await refresh();
        if (payload.audit && payload.audit.complete) break;
        await sleep(300);
      }
      if (payload && payload.audit && payload.audit.complete) {
        setAlert('success', '全站审计完成，证明面板已更新。');
      } else {
        setAlert('info', '分批审计已推进一段；还没完整扫完，可再次点击继续。');
      }
    } catch (error) {
      appendLocalEvent('ui.route-audit.failed', errorMessage(error), 'error');
      throw error;
    } finally {
      state.routeAuditRunning = false;
    }
  });
}

async function applyMarkets() {
  const venue = $('marketVenue').value;
  const top = Number($('marketTop').value || 1);
  const payload = await api('/api/recommendations/apply', {
    method: 'POST',
    body: {
      venue,
      top,
      minLiquidityUsd: Number($('marketMinLiquidity').value || 0),
      minRewardLevel: Number($('marketMinRewardLevel').value || 4),
      pointsOnly: $('marketPointsOnly').checked,
      acceptingOnly: $('marketAcceptingOnly').checked
    }
  });
  setAlert('success', '已应用 ' + payload.count + ' 个市场到 config.yaml');
  state.marketsLoaded = false;
  await refresh();
}

async function saveTradingSettings() {
  const liveEnabled = $('settingPredictLiveEnabled').checked;
  const orderSizeUsd = Number($('settingOrderSize').value);
  const maxMarkets = Number($('settingMaxMarkets').value);
  const maxDailyLossUsd = Number($('settingMaxDailyLossUsd').value);
  const cashMaxExitLossPct = Number($('settingCashMaxExitLossPct').value);
  const payload = await api('/api/config/trading', {
    method: 'POST',
    body: {
      venue: 'predict',
      liveEnabled,
      orderSizeUsd,
      maxSingleOrderUsd: orderSizeUsd,
      maxPositionUsd: orderSizeUsd,
      maxDailyLossUsd,
      maxMarkets,
      maxOpenOrdersPerMarket: 1,
      entryMode: 'cash',
      quoteSide: 'buy',
      autoSelectMarkets: true,
      pointsOnly: true,
      acceptingOnly: true,
      enforceRewardMinimum: true,
      minMarketLiquidityUsd: 0,
      cancelOutsideReward: true,
      cashOnFillAction: 'sellWithinLossCap',
      cashMaxExitLossPct,
      dedupeMarketGroups: true,
      predictCashBuyStaleGraceMs: Number($('settingPredictCashBuyStaleGraceMs').value || 0),
      predictFrontDepthUsd: Number($('settingPredictFrontDepthUsd').value || 200),
      predictFastQuoteMs: Number($('settingPredictFastQuoteMs').value || 0),
      predictFullCycleMs: Number($('settingPredictFullCycleMs').value || 0),
      predictCrowdedThreshold: Number($('settingPredictCrowdedThreshold').value || 0),
    }
  });
  setSettingsDirty('predict', false);
  setAlert('success', 'Predict 参数已保存');
  renderConfigCards('riskGrid', payload.config.risk || {}, riskMeta);
  renderConfigCards('strategyGrid', payload.config.strategy || {}, strategyMeta);
  await refresh();
}

async function savePolymarketSettings() {
  const orderSizeUsd = Number($('settingPolymarketOrderSize').value);
  const payload = await api('/api/config/trading', {
    method: 'POST',
    body: {
      venue: 'polymarket',
      liveEnabled: $('settingPolymarketLiveEnabled').checked,
      // Single-sided cash maker only — two-sided LP and small-amount test mode removed (strict official $1 rule).
      entryMode: 'cash',
      quoteSide: 'buy',
      polymarketTwoSidedLp: false,
      polymarketTestMode: false,
      orderSizeUsd,
      maxSingleOrderUsd: orderSizeUsd,
      maxPositionUsd: orderSizeUsd,
      // The ONE market-count knob: cash single-sided is capped by risk.maxMarkets (route-service/order-gate/audit all
      // read it). polymarketMaxMarkets only affects the two-sided-LP path (off here), so we send maxMarkets as the real
      // count and keep polymarketMaxMarkets in sync from the same field so they never disagree. Set N -> exactly N markets.
      maxMarkets: Number($('settingPolymarketMaxMarkets').value),
      polymarketMaxMarkets: Number($('settingPolymarketMaxMarkets').value),
      // PL daily stop is min(maxDailyLossUsd, polymarketMaxLossUsd). The "本金止损全退" field must set BOTH or it can only
      // ever lower the stop below maxDailyLossUsd, never raise it — so users changing it to e.g. 10 would still stop at 5.
      maxDailyLossUsd: Number($('settingPolymarketMaxLossUsd').value),
      polymarketMaxLossUsd: Number($('settingPolymarketMaxLossUsd').value),
      polymarketStartLevel: Number($('settingPolymarketStartLevel').value),
      polymarketFrontDepthUsd: Number($('settingPolymarketFrontDepthUsd').value),
      polymarketFastQuoteMs: Number($('settingPolymarketFastQuoteMs').value),
      cashMaxExitLossPct: Number($('settingPolymarketCashMaxExitLossPct').value)
    }
  });
  setSettingsDirty('polymarket', false);
  setAlert('success', 'Polymarket 参数已保存(与 Predict 完全独立),下一轮生效');
  renderConfigCards('riskGrid', payload.config.risk || {}, riskMeta);
  renderConfigCards('strategyGrid', payload.config.strategy || {}, strategyMeta);
  await refresh();
}

async function grantPolymarketApprovals() {
  await withBusyButton('grantPolyApprovalsBtn', '授权中', async () => {
    appendLocalEvent('ui.polymarket.approvals.requested', '发起 Polymarket 链上授权(pUSD + CTF 给两个 V2 exchange）');
    setAlert('info', '正在发起链上授权交易,请稍候(每笔约几秒)...');
    const payload = await api('/api/polymarket/grant-approvals', { method: 'POST', body: { amountUsd: 100 } });
    const txn = (payload.txHashes && payload.txHashes.length) ? payload.txHashes.length + ' 笔交易' : '已是最新';
    if (payload.ok) setAlert('success', 'Polymarket 交易授权完成(' + txn + ')。现在可开实盘。');
    else setAlert('error', '授权未全部成功,请展开诊断日志查看。');
    await refresh();
  });
}
`;
