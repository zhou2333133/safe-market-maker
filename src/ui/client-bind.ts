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
