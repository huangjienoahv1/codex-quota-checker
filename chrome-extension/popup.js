'use strict';

/**
 * Codex 额度查询 Chrome 插件（popup 界面逻辑）
 *
 * 数据来源与调用链（认证/接口封装在 core.js，与 background.js 共用）：
 *   打开 popup → 请求后台确认登录身份和所选账户 → 展示同账户缓存
 *   → 后台先发布额度，再发布重置卡；本文件只负责展示与账户选择。
 *
 * 展示口径：与官方界面一致，以「剩余」为主（剩余 = 100 - used_percent）。
 *
 * @author 黄杰
 */

import {
  EXPIRING_SOON_MS,
  CACHE_MAX_AGE_MS,
  QUERY_MESSAGE,
  UPDATE_MESSAGE,
  PLAN_TYPE_NAMES,
  clampPercent,
  formatDuration,
  formatUnix,
} from './core.js';

/** 官方用量页地址：弹窗底部链接与重置卡购买入口共用 */
const OFFICIAL_USAGE_URL = 'https://chatgpt.com/codex/cloud/settings/analytics#usage';
let loading = false;
let requestedAccountId = null;

/** 每秒刷新倒计时的定时器句柄；每次重新渲染前先清掉旧定时器 */
let countdownTimer = null;
/**
 * 当前渲染状态，供每秒 tick 更新倒计时：
 * windows: { primary: 重置时刻ms|null, secondary: ..., cr: ... }
 * cards:   [{ el: 到期文本元素, expiresAtMs }]
 */
let viewState = null;

/** 渲染单个限额窗口：主口径为「剩余」，进度条长度表示剩余量 */
function renderWindow(prefix, win) {
  const pctEl = document.getElementById(`pct-${prefix}`);
  const usedEl = document.getElementById(`used-${prefix}`);
  const fillEl = document.getElementById(`fill-${prefix}`);
  const resetEl = document.getElementById(`reset-${prefix}`);

  if (!win || !Number.isFinite(win.used_percent)) {
    pctEl.textContent = '无数据';
    usedEl.textContent = '';
    fillEl.style.width = '0';
    resetEl.textContent = '';
    viewState.windows[prefix] = null;
    return;
  }

  const used = clampPercent(win.used_percent);
  const remaining = 100 - used;
  pctEl.textContent = `剩 ${remaining.toFixed(0)}%`;
  usedEl.textContent = `已用 ${used.toFixed(0)}%`;
  fillEl.style.width = `${remaining}%`;
  fillEl.className = remaining <= 10 ? 'fill high' : remaining <= 30 ? 'fill mid' : 'fill';

  // 重置时刻优先用服务器的 reset_at 绝对时间戳，保证倒计时不受请求耗时影响
  if (Number.isFinite(win.reset_at)) {
    viewState.windows[prefix] = win.reset_at * 1000;
  } else if (Number.isFinite(win.reset_after_seconds)) {
    viewState.windows[prefix] = viewState.savedAt + win.reset_after_seconds * 1000;
  } else {
    viewState.windows[prefix] = null;
  }
}

/**
 * 渲染重置卡明细列表（点击卡片展开发放时间与说明）。
 * creditsData 为空且无错误 = 秒开缓存中没有明细：隐藏该区域，等刷新补全；
 * creditsData 为空且有错误 = 本次刷新失败：显示失败原因，不静默跳过。
 */
function renderCredits(usage, creditsData, creditsError) {
  const sectionEl = document.getElementById('credits');
  const titleEl = document.getElementById('credits-title');
  const listEl = document.getElementById('cards');
  const purchaseEl = document.getElementById('purchase');

  purchaseEl.hidden = true;
  purchaseEl.textContent = '';
  listEl.textContent = '';

  if (!creditsData) {
    if (!creditsError) {
      // 缓存秒开路径：没有明细就不显示，等本次刷新成功后补全
      sectionEl.hidden = true;
      return;
    }
    const reason = creditsError.message || '未知原因';
    const fallbackCount =
      usage && usage.rate_limit_reset_credits && Number.isFinite(usage.rate_limit_reset_credits.available_count)
        ? usage.rate_limit_reset_credits.available_count
        : null;
    if (fallbackCount != null) {
      titleEl.textContent = `重置卡：可用 ${fallbackCount} 张（明细获取失败，无法显示每张到期时间）`;
    } else {
      titleEl.textContent = '重置卡信息获取失败';
    }
    titleEl.className = 'credits-error';
    const errItem = document.createElement('li');
    errItem.className = 'card-empty';
    errItem.textContent = reason;
    listEl.appendChild(errItem);
    sectionEl.hidden = false;
    return;
  }

  titleEl.className = '';
  const available = creditsData.credits
    .filter((card) => card.status === 'available')
    .map((card) => ({ ...card, expireMs: Date.parse(card.expires_at) }))
    // 到期时间缺失或无法解析的卡片排到最后，避免 NaN 参与排序和展示
    .sort(
      (a, b) =>
        (Number.isNaN(a.expireMs) ? Infinity : a.expireMs) -
        (Number.isNaN(b.expireMs) ? Infinity : b.expireMs)
    );

  titleEl.textContent = `重置卡：可用 ${available.length} 张`;

  if (available.length === 0) {
    const emptyItem = document.createElement('li');
    emptyItem.className = 'card-empty';
    emptyItem.textContent = '当前没有可用重置卡';
    listEl.appendChild(emptyItem);
    sectionEl.hidden = false;
    return;
  }

  for (const card of available) {
    const item = document.createElement('li');
    const details = document.createElement('details');
    const summary = document.createElement('summary');

    const titleSpan = document.createElement('span');
    titleSpan.className = 'card-title';
    titleSpan.textContent = card.title || '重置卡';

    const expirySpan = document.createElement('span');
    expirySpan.className = 'card-expiry';

    summary.appendChild(titleSpan);
    summary.appendChild(expirySpan);

    // 展开区：卡片说明 + 发放时间（时间解析失败就不显示该行）
    const body = document.createElement('div');
    body.className = 'card-body';
    const grantedMs = card.granted_at ? Date.parse(card.granted_at) : NaN;
    const bodyLines = [
      card.description || null,
      Number.isFinite(grantedMs) ? `发放于 ${formatUnix(grantedMs)}` : null,
    ].filter(Boolean);
    body.textContent = bodyLines.join(' · ') || '无更多说明';

    details.appendChild(summary);
    details.appendChild(body);
    item.appendChild(details);
    listEl.appendChild(item);
    viewState.cards.push({ el: expirySpan, expiresAtMs: card.expireMs });
  }

  // 官方允许购买"立即重置"时给出入口
  if (creditsData.immediate_reset_purchase_eligible === true) {
    const link = document.createElement('a');
    link.href = OFFICIAL_USAGE_URL;
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.textContent = '当前账号可购买立即重置，前往官方用量页 ↗';
    purchaseEl.appendChild(link);
    purchaseEl.hidden = false;
  }

  sectionEl.hidden = false;
}

/** 每秒刷新一次：窗口重置倒计时 + 每张重置卡的到期倒计时 */
function updateCountdowns() {
  if (!viewState) {
    return;
  }
  for (const [prefix, resetAtMs] of Object.entries(viewState.windows)) {
    const el = document.getElementById(`reset-${prefix}`);
    if (!el) {
      continue;
    }
    if (!resetAtMs) {
      el.textContent = '';
      continue;
    }
    const remainMs = resetAtMs - Date.now();
    el.textContent =
      remainMs > 0
        ? `剩余 ${formatDuration(remainMs)}（${formatUnix(resetAtMs)} 重置）`
        : '已到重置时间，点击刷新查看最新额度';
  }
  for (const card of viewState.cards) {
    if (Number.isNaN(card.expiresAtMs)) {
      card.el.textContent = '到期时间未知';
      card.el.classList.remove('soon');
      continue;
    }
    const remainMs = card.expiresAtMs - Date.now();
    card.el.textContent =
      remainMs <= 0 ? '已到期' : `${formatUnix(card.expiresAtMs)} 到期（${formatDuration(remainMs)}后）`;
    card.el.classList.toggle('soon', remainMs > 0 && remainMs <= EXPIRING_SOON_MS);
  }
}

/**
 * 渲染完整结果。
 * 使用后台采集时刻显示更新时间；缓存的相对倒计时以该时刻为基准。
 */
function renderQuota(snapshot) {
  const { usage: data, credits: creditsData, cached, savedAt } = snapshot;
  const creditsError = snapshot.creditsError ? { message: snapshot.creditsError } : null;
  viewState = { windows: {}, cards: [], savedAt };
  const rl = data.rate_limit || {};

  document.getElementById('plan').textContent = PLAN_TYPE_NAMES[data.plan_type] || data.plan_type || '未知计划';

  // 顶部「剩余用量」取两个窗口剩余值中较小的一个，与官方界面口径一致
  const remainings = [rl.primary_window, rl.secondary_window]
    .filter((win) => win && Number.isFinite(win.used_percent))
    .map((win) => 100 - clampPercent(win.used_percent));
  document.getElementById('summary').textContent =
    remainings.length > 0 ? `剩余用量 ${Math.min(...remainings).toFixed(0)}%` : '';

  document.getElementById('email').textContent = data.email || '';
  const stale = Date.now() - savedAt > CACHE_MAX_AGE_MS || snapshot.lastError;
  document.getElementById('updated').textContent =
    `更新于 ${formatUnix(savedAt)}${stale ? '（过期数据）' : cached ? '（缓存）' : ''}`;
  document.getElementById('limit-warn').hidden = !rl.limit_reached;
  document.getElementById('spend-warn').hidden = !(data.spend_control && data.spend_control.reached);

  renderWindow('primary', rl.primary_window);
  renderWindow('secondary', rl.secondary_window);

  // Code review 配额：接口里该字段为空就不显示整块
  const crSection = document.getElementById('section-cr');
  const crLimit = data.code_review_rate_limit;
  const cr = crLimit && (crLimit.primary_window || crLimit.secondary_window || crLimit);
  const hasCr = !!(cr && Number.isFinite(cr.used_percent));
  crSection.hidden = !hasCr;
  if (hasCr) {
    renderWindow('cr', cr);
  }

  // 模型可用性：列出各模型状态，不可用的标注恢复时间
  const modelsEl = document.getElementById('models');
  const modelEntries = data.model_usage ? Object.entries(data.model_usage) : [];
  if (modelEntries.length > 0) {
    const text = modelEntries
      .map(([name, info]) => {
        if (info && info.available) {
          return `${name} ✓`;
        }
        const atMs = info && info.available_at ? Date.parse(info.available_at) : NaN;
        return Number.isFinite(atMs) ? `${name} ✗（${formatUnix(atMs)} 后可用）` : `${name} ✗`;
      })
      .join('、');
    modelsEl.textContent = `模型：${text}`;
    modelsEl.hidden = false;
  } else {
    modelsEl.hidden = true;
  }

  // Credit 余额：只在账号确实持有 credit 时显示
  const balanceEl = document.getElementById('credits-balance');
  if (data.credits && data.credits.has_credits && data.credits.balance != null) {
    balanceEl.textContent = `Credit 余额：${data.credits.balance}`;
    balanceEl.hidden = false;
  } else {
    balanceEl.hidden = true;
  }

  renderCredits(data, creditsData, creditsError);
  if (snapshot.creditsPending) {
    document.getElementById('credits').hidden = false;
    document.getElementById('credits-title').textContent = '重置卡：查询中…';
    document.getElementById('credits-title').className = '';
  } else if (creditsData && snapshot.creditsSavedAt) {
    document.getElementById('credits-title').textContent += `（更新于 ${formatUnix(snapshot.creditsSavedAt)}）`;
  }

  document.getElementById('content').hidden = false;
  if (countdownTimer) {
    clearInterval(countdownTimer);
  }
  updateCountdowns();
  countdownTimer = setInterval(updateCountdowns, 1000);
}

/** 显示错误信息 */
function showError(message) {
  const statusEl = document.getElementById('status');
  statusEl.hidden = false;
  statusEl.className = 'error';
  statusEl.textContent = message;
  document.getElementById('content').hidden = true;
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = null;
  viewState = null;
}

/** 展示可查询账户；首次多账户查询保留“请选择”，不默认第一个。 */
function renderAccounts(accounts, selectedId) {
  const select = document.getElementById('account');
  select.textContent = '';
  if (!selectedId) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = '请选择账户';
    option.disabled = true;
    option.selected = true;
    select.appendChild(option);
  }
  for (const account of accounts) {
    const option = document.createElement('option');
    option.value = account.account_id;
    option.textContent = account.name || account.account_id;
    option.selected = account.account_id === selectedId;
    select.appendChild(option);
  }
  document.getElementById('account-row').hidden = accounts.length === 0;
  select.disabled = loading;
}

/** 后台只发布已匹配身份的快照；失配通知先隐藏上一账户的数据。 */
function receiveSnapshot(snapshot) {
  // 切换账户可能要等待后台旧查询结束，等待期间不得回显旧账户结果。
  if (loading && requestedAccountId && snapshot.accountId &&
      snapshot.accountId !== requestedAccountId) return;
  renderAccounts(snapshot.accounts || [], snapshot.accountId);
  if (snapshot.clearContent) {
    document.getElementById('content').hidden = true;
    if (countdownTimer) clearInterval(countdownTimer);
    countdownTimer = null;
    viewState = null;
    if (snapshot.error) showError(snapshot.error);
    return;
  }
  if (!snapshot.usage) return;
  renderQuota(snapshot);
  const statusEl = document.getElementById('status');
  const warning = snapshot.lastError || snapshot.cacheError;
  statusEl.hidden = !warning && !snapshot.cached;
  statusEl.className = warning ? 'error' : 'status';
  statusEl.textContent = warning ? '刷新提示：' + warning : '刷新中…';
}

/**
 * 弹窗入口：后台完成身份确认、请求和缓存写入，本地按钮防止重复查询。
 * 失败后仅保留后台已确认属于当前账户的缓存，过期登录不保留内容。
 */
async function load(selectedId) {
  if (loading) return;
  loading = true;
  requestedAccountId = selectedId || null;
  const refresh = document.getElementById('refresh');
  const select = document.getElementById('account');
  const statusEl = document.getElementById('status');
  refresh.disabled = true;
  select.disabled = true;
  statusEl.hidden = false;
  statusEl.className = 'status';
  statusEl.textContent = '刷新中…';
  if (selectedId) document.getElementById('content').hidden = true;
  try {
    const result = await chrome.runtime.sendMessage({ type: QUERY_MESSAGE, accountId: selectedId });
    if (!result) throw new Error('后台没有返回查询结果，请重新加载插件。');
    if (result.snapshot) receiveSnapshot(result.snapshot);
    if (!result.ok) {
      if (result.accounts && result.accounts.length) renderAccounts(result.accounts, null);
      if (result.clearContent || !result.snapshot) {
        showError(result.error);
      } else {
        statusEl.hidden = false;
        statusEl.className = 'error';
        statusEl.textContent = '刷新失败（保留上次数据）：' + result.error;
      }
    }
  } catch (err) {
    showError('后台查询失败：' + err.message);
  } finally {
    loading = false;
    requestedAccountId = null;
    refresh.disabled = false;
    select.disabled = false;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id === chrome.runtime.id && message && message.type === UPDATE_MESSAGE) {
    receiveSnapshot(message.snapshot);
    sendResponse({ received: true });
  }
  return false;
});
document.getElementById('refresh').addEventListener('click', () => load());
document.getElementById('account').addEventListener('change', (event) => load(event.target.value));
load();
