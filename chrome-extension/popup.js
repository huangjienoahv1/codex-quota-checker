'use strict';

/**
 * Codex 额度查询 Chrome 插件（popup 界面逻辑）
 *
 * 数据来源与调用链（认证/接口封装在 core.js，与 background.js 共用）：
 *   打开 popup → 先读本地缓存（chrome.storage.local.lastQuota）秒显上次结果
 *   → 再走完整链路刷新：会话令牌 → accounts/check 定位账户 → wham/usage
 *   → wham/rate-limit-reset-credits（重置卡，失败不影响主数据）。
 *   刷新成功后更新缓存并把「剩余用量」写到工具栏图标角标。
 *
 * 展示口径：与官方界面一致，以「剩余」为主（剩余 = 100 - used_percent）。
 *
 * @author 黄杰
 */

import {
  EXPIRING_SOON_MS,
  PLAN_TYPE_NAMES,
  applyBadge,
  clampPercent,
  fetchAccount,
  fetchCredits,
  fetchSessionToken,
  fetchUsage,
  formatDuration,
  formatUnix,
} from './core.js';

/** 官方用量页地址：弹窗底部链接与重置卡购买入口共用 */
const OFFICIAL_USAGE_URL = 'https://chatgpt.com/codex/cloud/settings/analytics#usage';
/** 本地缓存键：上次完整查询结果 */
const CACHE_KEY = 'lastQuota';

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

  if (!win || typeof win.used_percent !== 'number') {
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
    viewState.windows[prefix] = Date.now() + win.reset_after_seconds * 1000;
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
  const available = (creditsData.credits || [])
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
 * cached = true 表示数据来自本地缓存（秒开），"更新于"会标注缓存，
 * 等本次刷新成功后会用最新数据整体重渲染。
 */
function renderQuota(data, creditsData, creditsError, cached = false) {
  viewState = { windows: {}, cards: [] };
  const rl = data.rate_limit || {};

  document.getElementById('plan').textContent = PLAN_TYPE_NAMES[data.plan_type] || data.plan_type || '未知计划';

  // 顶部「剩余用量」取两个窗口剩余值中较小的一个，与官方界面口径一致
  const remainings = [rl.primary_window, rl.secondary_window]
    .filter((win) => win && typeof win.used_percent === 'number')
    .map((win) => 100 - clampPercent(win.used_percent));
  document.getElementById('summary').textContent =
    remainings.length > 0 ? `剩余用量 ${Math.min(...remainings).toFixed(0)}%` : '';

  document.getElementById('email').textContent = data.email || '';
  document.getElementById('updated').textContent =
    `更新于 ${new Date().toLocaleTimeString('zh-CN')}${cached ? '（缓存）' : ''}`;
  document.getElementById('limit-warn').hidden = !rl.limit_reached;
  document.getElementById('spend-warn').hidden = !(data.spend_control && data.spend_control.reached);

  renderWindow('primary', rl.primary_window);
  renderWindow('secondary', rl.secondary_window);

  // Code review 配额：接口里该字段为空就不显示整块
  const crSection = document.getElementById('section-cr');
  const cr = data.code_review_rate_limit;
  const hasCr = !!(cr && typeof cr.used_percent === 'number');
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
}

/** 把本次成功结果写入本地缓存，供下次打开秒显和后台角标刷新合并 */
async function saveCache(usage, creditsData) {
  try {
    await chrome.storage.local.set({
      [CACHE_KEY]: { usage, credits: creditsData, savedAt: Date.now() },
    });
  } catch {
    // 缓存写入失败不影响本次展示
  }
}

/** 秒开：先渲染上次缓存的结果（若有），再走完整刷新 */
async function showCache() {
  try {
    const stored = (await chrome.storage.local.get(CACHE_KEY))[CACHE_KEY];
    if (stored && stored.usage) {
      document.getElementById('status').hidden = true;
      renderQuota(stored.usage, stored.credits || null, null, true);
    }
  } catch {
    // 缓存读取失败不影响正常查询
  }
}

/**
 * 入口：拿网页会话令牌 → 定位账户 → 调限额接口 → 渲染并写缓存/角标；
 * 重置卡尽力获取，失败不影响主数据；每一步失败都有可操作的提示。
 */
async function load() {
  const statusEl = document.getElementById('status');
  if (statusEl.hidden) {
    // 秒开模式下不打断已展示的缓存内容，只在头部显示刷新状态
    statusEl.className = 'status';
    statusEl.textContent = '刷新中…';
    statusEl.hidden = false;
  } else {
    statusEl.className = 'status';
    statusEl.textContent = '查询中…';
  }
  document.getElementById('content').hidden = true;

  try {
    const session = await fetchSessionToken();
    const token = session.accessToken;
    const account = await fetchAccount(token);
    const usage = await fetchUsage(token, account.account_id);

    // 重置卡接口失败不影响窗口展示，失败原因会原样显示在重置卡区域
    let creditsData = null;
    let creditsError = null;
    try {
      creditsData = await fetchCredits(token, account.account_id);
    } catch (creditsErr) {
      creditsError = creditsErr;
    }

    statusEl.hidden = true;
    renderQuota(usage, creditsData, creditsError);
    await saveCache(usage, creditsData);
    await applyBadge(usage);
  } catch (err) {
    // 秒开失败时保留缓存内容，仅把错误写进头部状态行
    const cachedVisible = !document.getElementById('content').hidden;
    if (cachedVisible) {
      statusEl.className = 'status';
      statusEl.textContent = `刷新失败：${err instanceof TypeError ? '网络请求失败' : err.message.split('\n')[0]}`;
    } else if (err instanceof TypeError) {
      showError('网络请求失败，请检查网络或代理后重试。');
    } else {
      showError(err.message);
    }
  }
}

document.getElementById('refresh').addEventListener('click', load);
showCache();
load();
