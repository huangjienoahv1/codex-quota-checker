'use strict';

/**
 * Codex 额度查询 Chrome 插件（popup 逻辑）
 *
 * 认证链路（与 ChatGPT 网页应用完全一致，这是本次修复的关键）：
 *   chatgpt.com 的 backend-api 接口不认裸 Cookie，网页应用自己是先从
 *   /api/auth/session 拿会话令牌（accessToken），再带 Authorization: Bearer
 *   调用所有 backend-api 接口。本插件复刻同样的链路：
 *   1. GET /api/auth/session 拿会话令牌（要求浏览器已登录 chatgpt.com）；
 *   2. GET /backend-api/accounts/check/v4-2023-04-27（带 Bearer）定位 account_id；
 *   3. GET /backend-api/wham/usage（带 Bearer + chatgpt-account-id 头）拿限额与重置时间；
 *   4. GET /backend-api/wham/rate-limit-reset-credits 拿每张重置卡的到期时间，
 *      该步失败只影响重置卡区域，不影响窗口额度展示。
 *   渲染结果后每秒本地刷新一次倒计时，不额外发请求。
 *
 * 与本地命令行版（../local/codex-quota.js）的差异：
 *   本地版直接用 ~/.codex/auth.json 的 Codex OAuth token；插件用网页会话令牌。
 * 展示口径：与官方界面一致，以「剩余」为主（剩余 = 100 - used_percent）。
 *
 * @author 黄杰
 */

/** 网页会话令牌接口：ChatGPT 网页应用从这里拿 Bearer token */
const SESSION_URL = 'https://chatgpt.com/api/auth/session';
/** Codex CLI / 网页端共用的内部限额接口 */
const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
/** Codex 内部重置卡明细接口：返回每张重置卡的状态与到期时间 */
const CREDITS_URL = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits';
/** 网页端获取当前账户信息的接口，用于拿到 chatgpt-account-id */
const ACCOUNTS_CHECK_URL = 'https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27';

/** 重置卡剩余有效期不足该毫秒数时，标记「即将到期」 */
const EXPIRING_SOON_MS = 24 * 60 * 60 * 1000;

/** plan_type 到中文名称的映射；未收录的值原样展示 */
const PLAN_TYPE_NAMES = {
  free: 'Free',
  prolite: 'Pro Lite',
  plus: 'Plus',
  pro: 'Pro',
  team: 'Team',
  business: 'Business',
  enterprise: 'Enterprise',
};

/** 每秒刷新倒计时的定时器句柄；每次重新渲染前先清掉旧定时器 */
let countdownTimer = null;
/**
 * 当前渲染状态，供每秒 tick 更新倒计时：
 * windows: { primary: 重置时刻ms|null, secondary: ... }
 * cards:   [{ el: 到期文本元素, expiresAtMs }]
 */
let viewState = null;

/** 把毫秒时长格式化为中文时长，例如 2天3小时 / 5小时41分 / 8分钟 */
function formatDuration(ms) {
  const sec = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(sec / 86400);
  const hours = Math.floor((sec % 86400) / 3600);
  const minutes = Math.floor((sec % 3600) / 60);
  if (days > 0) return `${days}天${hours}小时`;
  if (hours > 0) return `${hours}小时${minutes}分`;
  if (minutes > 0) return `${minutes}分钟`;
  return `${sec}秒`;
}

/** 把 Unix 毫秒时间戳格式化为本地 MM-dd HH:mm */
function formatUnix(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 把百分比限制在 0-100 区间 */
function clampPercent(value) {
  return Math.max(0, Math.min(100, value));
}

/**
 * 从网页会话拿 Bearer 令牌（与 ChatGPT 网页应用相同的来源）。
 * 拿不到令牌说明登录态不可用，给出明确提示。
 */
async function fetchSessionToken() {
  let res;
  try {
    res = await fetch(SESSION_URL, { credentials: 'include' });
  } catch (err) {
    throw new Error('网络请求失败，请检查网络或代理后重试。');
  }
  if (!res.ok) {
    throw new Error(`会话接口返回 HTTP ${res.status}。请打开 chatgpt.com 确认已登录后重试。`);
  }
  const data = await res.json();
  if (!data || !data.accessToken) {
    throw new Error(
      '未获取到网页会话令牌。\n请在浏览器打开 chatgpt.com 确认已登录（能正常聊天），然后点「刷新」。'
    );
  }
  return data;
}

/**
 * 带 Bearer 令牌调用 backend-api GET 接口并解析 JSON。
 * accountId 为空时不带 chatgpt-account-id 头。失败抛出带可读信息的错误。
 */
async function fetchApiJson(token, url, accountId, endpointLabel) {
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
  if (accountId) {
    // 多账户/团队计划下需要账户请求头定位到当前账户
    headers['chatgpt-account-id'] = accountId;
  }
  const res = await fetch(url, { credentials: 'include', headers });
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      `${endpointLabel}无权访问（HTTP ${res.status}）。\n登录可能已过期：请刷新 chatgpt.com 页面确认能正常使用后，再点「刷新」。`
    );
  }
  if (!res.ok) {
    throw new Error(`${endpointLabel}返回 HTTP ${res.status}`);
  }
  return res.json();
}

/**
 * 通过 accounts/check 定位当前账户（返回含 account_id 的账户对象）。
 * 兼容两种结构：标准结构的 entry.account，以及扁平结构的 entry 本身。
 * 返回了 JSON 但找不到 account_id 时，给出带诊断信息的明确错误。
 */
async function fetchAccount(token) {
  const data = await fetchApiJson(token, ACCOUNTS_CHECK_URL, null, 'accounts/check');
  const entries = data && data.accounts ? Object.values(data.accounts) : [];
  for (const entry of entries) {
    const account = entry && (entry.account || entry);
    if (account && account.account_id) {
      return account;
    }
  }
  const topKeys = data && typeof data === 'object' ? Object.keys(data).join(', ') : typeof data;
  throw new Error(
    `accounts/check 返回中未找到 account_id（顶层键: ${topKeys}）。\n请截图本提示反馈。`
  );
}

/** 调用限额接口（带 Bearer + 账户头） */
function fetchUsage(token, accountId) {
  return fetchApiJson(token, USAGE_URL, accountId, '限额接口');
}

/** 调用重置卡明细接口（带 Bearer + 账户头） */
function fetchCredits(token, accountId) {
  return fetchApiJson(token, CREDITS_URL, accountId, '重置卡接口');
}

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
 * 渲染重置卡明细列表。
 * creditsData 为空说明该接口本次获取失败：若限额响应里带有可用数量汇总，
 * 则仍显示数量并注明无法显示每张到期时间；失败原因原样展示，不静默跳过。
 */
function renderCredits(usage, creditsData, creditsError) {
  const sectionEl = document.getElementById('credits');
  const titleEl = document.getElementById('credits-title');
  const listEl = document.getElementById('cards');

  sectionEl.hidden = false;
  listEl.textContent = '';

  if (!creditsData) {
    const reason = creditsError && creditsError.message ? creditsError.message : '未知原因';
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
    return;
  }

  for (const card of available) {
    const item = document.createElement('li');
    const titleSpan = document.createElement('span');
    titleSpan.className = 'card-title';
    titleSpan.textContent = card.title || '重置卡';
    const expirySpan = document.createElement('span');
    expirySpan.className = 'card-expiry';
    item.appendChild(titleSpan);
    item.appendChild(expirySpan);
    listEl.appendChild(item);
    viewState.cards.push({ el: expirySpan, expiresAtMs: card.expireMs });
  }
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

/** 渲染完整结果 */
function renderQuota(data, creditsData, creditsError) {
  viewState = { windows: {}, cards: [] };
  const rl = data.rate_limit || {};

  document.getElementById('plan').textContent = PLAN_TYPE_NAMES[data.plan_type] || data.plan_type || '未知计划';

  // 顶部「剩余用量」取两个窗口剩余值中较小的一个，与官方界面口径一致
  const remainings = [rl.primary_window, rl.secondary_window]
    .filter((win) => win && typeof win.used_percent === 'number')
    .map((win) => 100 - clampPercent(win.used_percent));
  document.getElementById('summary').textContent =
    remainings.length > 0 ? `剩余用量 ${Math.min(...remainings).toFixed(0)}%` : '';

  document.getElementById('updated').textContent = `更新于 ${new Date().toLocaleTimeString('zh-CN')}`;
  document.getElementById('limit-warn').hidden = !rl.limit_reached;

  renderWindow('primary', rl.primary_window);
  renderWindow('secondary', rl.secondary_window);
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

/**
 * 入口：拿网页会话令牌 → 定位账户 → 调限额接口 → 渲染；
 * 重置卡尽力获取，失败不影响主数据；每一步失败都有可操作的提示。
 */
async function load() {
  const statusEl = document.getElementById('status');
  statusEl.hidden = false;
  statusEl.className = 'status';
  statusEl.textContent = '查询中…';
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
  } catch (err) {
    if (err instanceof TypeError) {
      showError('网络请求失败，请检查网络或代理后重试。');
    } else {
      showError(err.message);
    }
  }
}

document.getElementById('refresh').addEventListener('click', load);
load();
