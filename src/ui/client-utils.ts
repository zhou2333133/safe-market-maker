export const clientUtilsScript = String.raw`
function money(value) {
  const number = Number(value || 0);
  return '$' + number.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function shortId(value) {
  const text = String(value || '');
  if (text.length <= 18) return text || '-';
  return text.slice(0, 8) + '...' + text.slice(-6);
}

function liveEnabledForVenue(payload, venue) {
  const config = payload && payload.config ? payload.config : {};
  if (config.liveEnabledByVenue && typeof config.liveEnabledByVenue[venue] === 'boolean') return config.liveEnabledByVenue[venue];
  const venueConfig = config.venues && config.venues[venue] ? config.venues[venue] : {};
  if (typeof venueConfig.liveEnabled === 'boolean') return venueConfig.liveEnabled;
  return Boolean(config.liveEnabled);
}

function settingsDirtyFor(venue) {
  if (state.settingsDirty === true) return true;
  if (!state.settingsDirty || typeof state.settingsDirty !== 'object') return false;
  return Boolean(state.settingsDirty[venue]);
}

function setSettingsDirty(venue, dirty) {
  if (!state.settingsDirty || typeof state.settingsDirty !== 'object' || state.settingsDirty === true) {
    state.settingsDirty = { predict: false, polymarket: false };
  }
  state.settingsDirty[venue] = Boolean(dirty);
}

function compactNumber(value, digits = 2) {
  const number = Number(value || 0);
  return number.toLocaleString('en-US', { maximumFractionDigits: digits });
}

function formatAge(ts) {
  if (!ts) return '-';
  const time = new Date(ts).getTime();
  if (!Number.isFinite(time)) return '-';
  const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
  if (seconds < 60) return seconds + ' 秒前';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + ' 分钟前';
  return new Date(ts).toLocaleString();
}

function rewardLabel(rewards) {
  if (!rewards || !rewards.enabled) return '无积分';
  const level = Number(rewards.level || 0);
  const pp = rewards.ppPerHour ? ' · ' + compactNumber(rewards.ppPerHour, 0) + ' PP/hr' : '';
  return level > 0 ? 'LP ' + level + '级 ' + '★'.repeat(Math.min(5, level)) + pp : '有积分' + pp;
}

function timeSourceLabel(source) {
  const map = {
    'order-deadline': '停止下单',
    'market-end': '市场结束',
    'category-end': '类别结束',
    resolution: '结算/解析',
    'reward-end': 'PP结束',
    'category-start': '类别开始',
    'market-start': '市场开始',
    unknown: '未知来源'
  };
  return map[source] || source || '未知来源';
}

function futureTimeText(value, source) {
  if (!value) return '无明确时间';
  const ts = new Date(value).getTime();
  if (!Number.isFinite(ts)) return '时间不可解析';
  const diff = ts - Date.now();
  const prefix = diff >= 0 ? '剩余 ' + durationText(diff) : '已过 ' + durationText(Math.abs(diff));
  return timeSourceLabel(source) + ' · ' + prefix + ' · ' + new Date(value).toLocaleString();
}

function durationText(ms) {
  const minutes = Math.floor(Math.max(0, ms) / 60000);
  if (minutes < 60) return minutes + ' 分钟';
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 48) return rest ? hours + ' 小时 ' + rest + ' 分钟' : hours + ' 小时';
  const days = Math.floor(hours / 24);
  return days + ' 天';
}

function cnValue(key, value) {
  if (typeof value === 'boolean') return value ? '开启' : '关闭';
  if (key === 'optimizerMode') return value === 'points' ? '积分收益优化' : String(value || '-');
  if (key === 'tradingMode') return value === 'aggressive' ? '激进' : '保守';
  if (key === 'entryMode') return value === 'split' ? '拆分完整套仓' : value === 'inventory' ? '库存模式' : '单边现金模式';
  if (key === 'quoteSide') return value === 'sell' ? '库存 SELL' : value === 'both' ? 'BUY+库存SELL' : '单边 BUY';
  if (key === 'onFillAction') return value === 'sellAllAtMarket' ? '完整套仓合并退出' : '持有库存继续做市';
  if (key === 'cashOnFillAction') return value === 'sellWithinLossCap' ? '亏损上限内止损卖出' : '撤单后暂停';
  if (key === 'minRewardLevel') return Number(value || 0) > 0 ? String(value) + '级以上' : '不限';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : String(value);
  return String(value ?? '-');
}

function setAlert(kind, message) {
  const box = $('alertBox');
  box.className = 'alert ' + kind;
  box.textContent = message;
  box.scrollIntoView({ block: 'nearest' });
  window.clearTimeout(setAlert.timer);
  if (kind !== 'error') setAlert.timer = window.setTimeout(() => box.classList.add('hidden'), 7000);
}

async function api(path, options = {}) {
  const init = { ...options, headers: { ...(options.headers || {}) } };
  if (init.body && typeof init.body !== 'string') {
    init.body = JSON.stringify(init.body);
    init.headers['content-type'] = 'application/json';
  }
  if (init.method && init.method !== 'GET') init.headers['x-safe-mm-ui-token'] = UI_TOKEN;
  const response = await fetch(path, init);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    if (response.status === 403 && String(payload.error || '').includes('UI token')) {
      window.setTimeout(() => window.location.reload(), 1000);
      throw new Error('页面会话已过期，正在自动刷新。刷新后请重新点击。');
    }
    throw new Error(formatApiError(payload));
  }
  return payload;
}

function formatApiError(payload) {
  const base = compactUiMessage(payload.error || payload.message || '请求失败');
  const failedChecks = Array.isArray(payload.details && payload.details.checks)
    ? payload.details.checks.filter((check) => check && check.ok === false).slice(0, 5)
    : [];
  if (failedChecks.length === 0) return base;
  return base + '：' + failedChecks.map((check) => check.name + ' = ' + compactUiMessage(check.message)).join('；');
}

function compactUiMessage(value, max = 220) {
  const text = String(value || '').replace(/transaction="[^"]*"/gi, 'transaction="[交易数据已隐藏]"').replace(/0x[a-fA-F0-9]{80,}/g, '[交易数据已隐藏]').replace(/\s+/g, ' ').trim();
  const addressMatch = text.match(/0x[a-fA-F0-9]{40}/);
  if (text.includes('insufficient funds for intrinsic transaction cost') || text.includes('insufficient funds for gas') || text.includes('BNB 手续费余额不足')) {
    return '普通挂单不需要 BNB；但自动 split/merge 是链上交易，当前 BNB 手续费余额不足。' + (addressMatch ? ' 请充值到签名钱包：' + addressMatch[0] : '');
  }
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

async function withBusyButton(id, busyText, task) {
  const button = $(id);
  const original = button.textContent;
  const originalTitle = button.getAttribute('title') || '';
  button.disabled = true;
  button.dataset.busy = 'true';
  button.setAttribute('aria-busy', 'true');
  button.classList.add('is-busy');
  button.textContent = busyText;
  try {
    return await task();
  } finally {
    delete button.dataset.busy;
    button.removeAttribute('aria-busy');
    button.classList.remove('is-busy');
    button.disabled = false;
    button.textContent = original;
    if (originalTitle) button.setAttribute('title', originalTitle);
    if (state.lastPayload && typeof renderLiveActionButtons === 'function') {
      const venue = $('liveVenue') ? $('liveVenue').value : 'predict';
      const live = state.lastPayload.live && state.lastPayload.live[venue] ? state.lastPayload.live[venue] : { status: 'idle' };
      renderLiveActionButtons(live, liveEnabledForVenue(state.lastPayload, venue), activeOrdersForVenue(state.lastPayload.orders || [], venue).length);
    }
  }
}

function switchView(name) {
  document.querySelectorAll('.nav-item').forEach((item) => {
    item.classList.toggle('active', item.dataset.view === name);
  });
  document.querySelectorAll('.view').forEach((view) => {
    view.classList.toggle('active', view.id === 'view-' + name);
  });
  $('pageTitle').textContent = { dashboard: '实盘', polymarket: 'Polymarket', markets: '市场池', risk: '诊断' }[name] || '实盘';
  if (name === 'markets' && !state.marketsLoaded) {
    loadMarkets().catch((error) => setAlert('error', errorMessage(error)));
  }
}

function signedMoney(value) {
  const number = Number(value || 0);
  const prefix = number > 0 ? '+' : number < 0 ? '-' : '';
  return prefix + money(Math.abs(number));
}

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char]));
}

function errorMessage(error) {
  return compactUiMessage(error && error.message ? error.message : String(error));
}
`;
