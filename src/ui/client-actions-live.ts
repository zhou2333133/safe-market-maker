export const clientActionsLiveScript = String.raw`
async function refreshBalances() {
  const venue = $('liveVenue').value;
  await withBusyButton('refreshBalanceBtn', '刷新中...', async () => {
    appendLocalEvent('ui.balance.refresh.requested', '已提交余额刷新请求，最多等待 8 秒');
    setAlert('info', '正在刷新余额，超过 8 秒会自动返回超时提示。');
    try {
      const payload = await api('/api/balances', {
        method: 'POST',
        body: {
          venue
        }
      });
      renderBalances(payload);
      appendLocalEvent('ui.balance.refresh.completed', '余额刷新完成：' + (payload.balances || []).length + ' 项');
      setAlert('success', '余额已刷新');
      await refresh();
    } catch (error) {
      state.balances = {
        venue,
        capturedAt: new Date().toISOString(),
        balances: [],
        error: errorMessage(error)
      };
      renderBalanceSummary(state.lastPayload, venue);
      appendLocalEvent('ui.balance.refresh.failed', errorMessage(error), 'error');
      throw error;
    }
  });
}

async function autoRefreshBalances() {
  // Silent periodic balance refresh for BOTH venues so the user never has to click 刷新余额. No busy state, no alerts,
  // no event spam — failures are non-fatal and just leave the last shown value. Stashed in state.autoBalances so the
  // Polymarket panel (plBalanceLive, normally fed by the slower account snapshot) shows a fresh value too.
  const STABLE = ['USDC', 'USDT', 'PUSD', 'USD'];
  for (const venue of ['predict', 'polymarket']) {
    try {
      const payload = await api('/api/balances', { method: 'POST', body: { venue, silent: true } });
      const usd = (payload.balances || [])
        .filter((b) => STABLE.includes(String(b.asset || '').toUpperCase()))
        .reduce((sum, b) => sum + (Number(b.available) || 0), 0);
      state.autoBalances = Object.assign({}, state.autoBalances, { [venue]: { usd, at: Date.now() } });
      if (venue === $('liveVenue').value) renderBalances(payload);
      if (venue === 'polymarket') { const node = document.getElementById('plBalanceLive'); if (node) node.textContent = '$' + usd.toFixed(2); }
    } catch (error) {
      // non-fatal: leave the last shown value
    }
  }
}

async function checkStartupFacts(venueArg, buttonId) {
  const venue = venueArg || $('liveVenue').value;
  await withBusyButton(buttonId || 'startupFactsBtn', '检查中...', async () => {
    appendLocalEvent('ui.startup-facts.requested', '正在读取真实余额、库存、开放订单和账户风控');
    setAlert('info', '正在检查启动条件；这个动作只读数据，不会下单也不会撤单。');
    try {
      const payload = await api('/api/startup-facts', {
        method: 'POST',
        body: {
          venue
        }
      });
      renderStartupFacts(payload.facts);
      appendLocalEvent('ui.startup-facts.completed', payload.facts.summary, payload.facts.readyToQuote ? 'info' : 'warn');
      setAlert(payload.facts.readyToQuote ? 'success' : 'info', payload.facts.summary);
      await refresh();
    } catch (error) {
      resetStartupFacts(errorMessage(error));
      appendLocalEvent('ui.startup-facts.failed', errorMessage(error), 'error');
      throw error;
    }
  });
}

async function startLive(venueArg, buttonId, startupBtnId) {
  const venue = venueArg || $('liveVenue').value;
  if (settingsDirtyFor(venue)) {
    setAlert('error', venueLabel[venue] + ' 有未保存的参数。请先在当前模块点击“保存参数”，再开始实盘。');
    return;
  }
  const currentLive = state.lastPayload && state.lastPayload.live ? state.lastPayload.live[venue] : null;
  if (currentLive && currentLive.status === 'running') {
    appendLocalEvent('ui.live.start.noop', venueLabel[venue] + ' 实盘循环已经在运行中', 'info');
    setAlert('info', venueLabel[venue] + ' 实盘循环已经在运行中；机器人会继续监控、撤换和维护当前订单。');
    await refresh();
    return;
  }
  if (currentLive && currentLive.status === 'stopping') {
    appendLocalEvent('ui.live.start.noop', venueLabel[venue] + ' 正在停止中，暂不重复启动', 'warn');
    setAlert('info', venueLabel[venue] + ' 正在停止当前一轮；等状态变成“未启动”后再点开始。');
    await refresh();
    return;
  }
  if (!liveEnabledForVenue(state.lastPayload, venue)) {
    setAlert('error', venueLabel[venue] + ' 实盘开关还没开启。请在该模块页面打开并保存后再开始。');
    return;
  }
  if (!state.startupFacts || state.startupFacts.venue !== venue) {
    await checkStartupFacts(venue, startupBtnId);
    if (state.startupFacts && !state.startupFacts.readyToQuote) {
      appendLocalEvent('ui.live.start.warning', '启动前检查提示暂不应新增挂单；仍会启动循环，由执行引擎按实时事实继续监控和重试。', 'warn');
    }
  } else if (!state.startupFacts.readyToQuote) {
    appendLocalEvent('ui.live.start.warning', '启动前检查提示暂不应新增挂单；仍会启动循环，由执行引擎按实时事实继续监控和重试。', 'warn');
  }
  const body = {
    venue
  };
  await withBusyButton(buttonId || 'startLiveBtn', '正在启动...', async () => {
    appendLocalEvent('ui.live.start.requested', '用户点击开启实盘，开始预检和启动流程', 'warn');
    setAlert('info', '正在执行实盘预检：运行时签名、凭据、市场、余额、授权、开放订单和风控都会检查。');
    try {
      const payload = await api('/api/live/start', { method: 'POST', body });
      if (payload.alreadyActive) {
        appendLocalEvent('ui.live.start.noop', payload.message || '实盘循环已经在运行中', 'info');
        setAlert('info', payload.message || '实盘循环已经在运行中。');
      } else {
        appendLocalEvent('ui.live.loop.started', '实盘循环已启动，日志会继续记录每一轮过程', 'warn');
        setAlert('success', '实盘循环已启动');
      }
    } catch (error) {
      appendLocalEvent('ui.live.start.failed', errorMessage(error), 'error');
      throw error;
    }
    await refresh();
  });
}

async function stopLive(venueArg, buttonId) {
  const venue = venueArg || $('liveVenue').value;
  const currentLive = state.lastPayload && state.lastPayload.live ? state.lastPayload.live[venue] : null;
  if (currentLive && currentLive.status === 'idle') {
    appendLocalEvent('ui.live.stop.noop', venueLabel[venue] + ' 实盘循环本来就是未启动', 'info');
    setAlert('info', venueLabel[venue] + ' 实盘循环当前未启动。');
    await refresh();
    return;
  }
  if (currentLive && currentLive.status === 'stopping') {
    appendLocalEvent('ui.live.stop.noop', venueLabel[venue] + ' 已经在停止中', 'info');
    setAlert('info', venueLabel[venue] + ' 已经在停止中；当前一轮收尾后会变成未启动。');
    await refresh();
    return;
  }
  await withBusyButton(buttonId || 'stopLiveBtn', '停止中...', async () => {
    appendLocalEvent('ui.live.stop.requested', '用户点击停止，正在请求实盘循环停止', 'warn');
    await api('/api/live/stop', { method: 'POST', body: { venue } });
    setAlert('info', '已请求停止，正在确认循环是否真正停止。');
    const live = await waitForLiveStatus(venue, ['idle', 'error'], 15000);
    if (live?.status === 'idle') {
      appendLocalEvent('ui.live.loop.stopped', '实盘循环已真正停止', 'warn');
      setAlert('success', '实盘循环已真正停止');
    } else if (live?.status === 'error') {
      appendLocalEvent('ui.live-loop.error', live.lastError || '实盘循环进入错误状态', 'error');
      setAlert('error', live.lastError || '实盘循环进入错误状态');
    } else {
      appendLocalEvent('ui.live.stop.waiting', '已请求停止，但当前一轮仍在收尾，请继续看日志和状态', 'warn');
      setAlert('info', '已请求停止，当前一轮仍在收尾。');
    }
    await refresh();
  });
}

async function stopAndCancel(venueArg, buttonId) {
  const body = {
    venue: venueArg || $('liveVenue').value
  };
  await withBusyButton(buttonId || 'stopCancelBtn', '停止撤单中...', async () => {
    appendLocalEvent('ui.live.stop-and-cancel.requested', '用户点击停止并撤单，先停止循环再撤开放订单', 'warn');
    try {
      const payload = await api('/api/live/stop-and-cancel', { method: 'POST', body });
      appendLocalEvent('ui.live.stop-and-cancel.completed', '停止并撤单完成：' + payload.cancel.ids.length + ' 个订单', 'warn');
      setAlert('success', '已停止并撤单：' + payload.cancel.ids.length + ' 个订单');
      await refresh();
    } catch (error) {
      appendLocalEvent('ui.live.stop-and-cancel.failed', errorMessage(error), 'error');
      throw error;
    }
  });
}

async function waitForLiveStatus(venue, finalStatuses, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(800);
    const payload = await api('/api/live/status');
    const live = payload.live && payload.live[venue];
    if (live && finalStatuses.includes(live.status)) return live;
  }
  return null;
}

// -- unlock: 输入一次 keystore 密码，服务端内存记住，重启才清除 --

async function unlockVenue() {
  const venue = state.activeVenue || 'polymarket';
  const input = $('unlockPassphrase');
  if (!input) return;
  const passphrase = input.value.trim();
  if (!passphrase) {
    setAlert('error', '请输入 keystore 密码。');
    return;
  }
  const btn = $('unlockBtn');
  btn.disabled = true;
  btn.textContent = '验证中...';
  try {
    const result = await api('/api/unlock', { method: 'POST', body: { venue, passphrase } });
    if (result.ok) {
      $('unlockIcon').textContent = '🔓';
      $('unlockLabel').textContent = '已解锁 — 重启后需重新输入';
      input.style.display = 'none';
      btn.style.display = 'none';
      state.keystoreUnlocked = true;
      setAlert('success', venueLabel[venue] + ' 已解锁');
      await refresh();
    } else {
      setAlert('error', '密码错误: ' + (result.message || ''));
    }
  } catch (error) {
    setAlert('error', errorMessage(error));
  } finally {
    btn.disabled = false;
    btn.textContent = '解锁';
  }
}

async function checkUnlockStatus() {
  const venue = state.activeVenue || 'polymarket';
  try {
    const result = await api('/api/unlock/status?venue=' + venue);
    if (result.unlocked) {
      $('unlockIcon').textContent = '🔓';
      $('unlockLabel').textContent = '已解锁 — 重启后需重新输入';
      $('unlockPassphrase').style.display = 'none';
      $('unlockBtn').style.display = 'none';
      state.keystoreUnlocked = true;
    } else {
      $('unlockIcon').textContent = '🔒';
      $('unlockLabel').textContent = '点击解锁以加载钱包';
      $('unlockPassphrase').style.display = '';
      $('unlockBtn').style.display = '';
      $('unlockPassphrase').placeholder = venue + ' keystore 密码';
      state.keystoreUnlocked = false;
    }
  } catch {
    // ignore
  }
}
`;
