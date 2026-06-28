export const clientBindScript = String.raw`
function bind() {
  document.querySelectorAll('.nav-item').forEach((button) => {
    button.addEventListener('click', () => switchView(button.dataset.view));
  });
  document.querySelectorAll('.segment').forEach((button) => {
    button.addEventListener('click', () => {
      state.side = button.dataset.side;
      document.querySelectorAll('.segment').forEach((item) => item.classList.toggle('active', item === button));
    });
  });
  $('refreshBtn').addEventListener('click', () => refresh().catch((error) => setAlert('error', errorMessage(error))));
  // 解锁按钮: 注册点击事件，一次密码同时解锁两个场地
  const unlockBtn = $('unlockBtn');
  const unlockInput = $('unlockPassphrase');
  if (unlockBtn) {
    unlockBtn.addEventListener('click', () => {
      const pw = unlockInput.value.trim();
      if (!pw) { setAlert('error', '请输入 keystore 密码'); return; }
      unlockBtn.disabled = true;
      unlockBtn.textContent = '验证中...';
      Promise.allSettled([
        api('/api/unlock', { method: 'POST', body: { venue: 'polymarket', passphrase: pw } }),
        api('/api/unlock', { method: 'POST', body: { venue: 'predict', passphrase: pw } })
      ]).then(([poly, predict]) => {
        const polyOk = poly.status === 'fulfilled' && poly.value.ok;
        const predictOk = predict.status === 'fulfilled' && predict.value.ok;
        if (polyOk || predictOk) {
          const parts = [];
          if (polyOk) parts.push('Polymarket');
          if (predictOk) parts.push('Predict');
          $('unlockIcon').textContent = '\u{1F513}';
          $('unlockLabel').textContent = parts.join('+') + ' \u5DF2\u89E3\u9501';
          unlockBtn.textContent = '\u5DF2\u89E3\u9501';
          state.keystoreUnlocked = true;
          setAlert('success', parts.join('+') + ' \u5DF2\u89E3\u9501');
          refresh();
        } else {
          setAlert('error', '\u5BC6\u7801\u4E0D\u6B63\u786E');
          unlockBtn.disabled = false;
          unlockBtn.textContent = '\u89E3\u9501';
        }
      }).catch((err) => {
        setAlert('error', errorMessage(err));
        unlockBtn.disabled = false;
        unlockBtn.textContent = '\u89E3\u9501';
      });
    });
  }
  $('liveVenue').addEventListener('change', () => {
    resetStartupFacts('平台已切换，请重新检查启动条件。');
    checkUnlockStatus().catch(() => undefined);
    refresh().catch((error) => setAlert('error', errorMessage(error)));
  });
  $('startLiveBtn').addEventListener('click', () => startLive().catch((error) => setAlert('error', errorMessage(error))));
  $('startupFactsBtn').addEventListener('click', () => checkStartupFacts().catch((error) => setAlert('error', errorMessage(error))));
  $('refreshBalanceBtn').addEventListener('click', () => refreshBalances().catch((error) => setAlert('error', errorMessage(error))));
  $('stopLiveBtn').addEventListener('click', () => stopLive().catch((error) => setAlert('error', errorMessage(error))));
  $('stopCancelBtn').addEventListener('click', () => stopAndCancel().catch((error) => setAlert('error', errorMessage(error))));
  $('saveTradingBtn').addEventListener('click', () => saveTradingSettings().catch((error) => setAlert('error', errorMessage(error))));
  $('routeAuditBtn').addEventListener('click', () => runRouteAudit().catch((error) => setAlert('error', errorMessage(error))));
  $('loadMarketsBtn').addEventListener('click', () => loadMarkets().catch((error) => setAlert('error', errorMessage(error))));
  $('applyMarketsBtn').addEventListener('click', () => applyMarkets().catch((error) => setAlert('error', errorMessage(error))));
  ['settingPredictLiveEnabled', 'settingOrderSize', 'settingMaxMarkets', 'settingCashMaxExitLossPct', 'settingMaxDailyLossUsd',
   'settingPredictCashBuyStaleGraceMs', 'settingPredictFrontDepthUsd', 'settingPredictFastQuoteMs', 'settingPredictFullCycleMs', 'settingPredictCrowdedThreshold'].forEach((id) => {
    const node = $(id);
    if (!node) return;
    node.addEventListener('input', () => { setSettingsDirty('predict', true); resetStartupFacts('Predict 参数已变化，保存后请重新检查启动条件。'); });
    node.addEventListener('change', () => { setSettingsDirty('predict', true); resetStartupFacts('Predict 参数已变化，保存后请重新检查启动条件。'); });
  });
  const savePolyBtn = $('savePolymarketBtn');
  if (savePolyBtn) savePolyBtn.addEventListener('click', () => savePolymarketSettings().catch((error) => setAlert('error', errorMessage(error))));
  const grantPolyBtn = $('grantPolyApprovalsBtn');
  if (grantPolyBtn) grantPolyBtn.addEventListener('click', () => grantPolymarketApprovals().catch((error) => setAlert('error', errorMessage(error))));
  ['settingPolymarketLiveEnabled', 'settingPolymarketOrderSize', 'settingPolymarketStartLevel', 'settingPolymarketFrontDepthUsd', 'settingPolymarketMaxMarkets', 'settingPolymarketMaxLossUsd', 'settingPolymarketCashMaxExitLossPct', 'settingPolymarketFastQuoteMs'].forEach((id) => {
    const node = $(id);
    if (!node) return;
    node.addEventListener('input', () => { setSettingsDirty('polymarket', true); });
    node.addEventListener('change', () => { setSettingsDirty('polymarket', true); });
  });
  const plStartBtn = $('plStartBtn');
  if (plStartBtn) plStartBtn.addEventListener('click', () => startLive('polymarket', 'plStartBtn', 'plStartupBtn').catch((error) => setAlert('error', errorMessage(error))));
  const plStartupBtn = $('plStartupBtn');
  if (plStartupBtn) plStartupBtn.addEventListener('click', () => checkStartupFacts('polymarket', 'plStartupBtn').catch((error) => setAlert('error', errorMessage(error))));
  const plStopBtn = $('plStopBtn');
  if (plStopBtn) plStopBtn.addEventListener('click', () => stopLive('polymarket', 'plStopBtn').catch((error) => setAlert('error', errorMessage(error))));
  const plStopCancelBtn = $('plStopCancelBtn');
  if (plStopCancelBtn) plStopCancelBtn.addEventListener('click', () => stopAndCancel('polymarket', 'plStopCancelBtn').catch((error) => setAlert('error', errorMessage(error))));
  const plRefreshBtn = $('plRefreshBtn');
  if (plRefreshBtn) plRefreshBtn.addEventListener('click', () => refresh().catch((error) => setAlert('error', errorMessage(error))));
  ['marketMinLiquidity', 'marketMinRewardLevel', 'marketPointsOnly', 'marketAcceptingOnly'].forEach((id) => {
    $(id).addEventListener('change', () => loadMarkets().catch((error) => setAlert('error', errorMessage(error))));
  });
}

bind();
checkUnlockStatus().catch(() => undefined);
refresh().catch((error) => setAlert('error', errorMessage(error)));
// Balance auto-refresh: silently fetch fresh balances on startup and every 30s, so the user never has to click 刷新余额.
autoRefreshBalances().catch(() => undefined);
window.setInterval(() => autoRefreshBalances().catch(() => undefined), 60000);
`;
