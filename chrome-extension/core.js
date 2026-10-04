'use strict';

/**
 * Codex 额度查询插件——共享核心模块
 *
 * 被 popup.js（弹窗界面）和 background.js（后台角标刷新）共同引用，
 * 统一封装认证链路与数据获取，避免两处重复实现：
 *   1. GET chatgpt.com/api/auth/session 拿网页会话令牌（accessToken）；
 *   2. 带 Authorization: Bearer 调用 backend-api 接口：
 *      - accounts/check 定位 account_id；
 *      - wham/usage 限额与重置时间；
 *      - wham/rate-limit-reset-credits 重置卡明细。
 *   3. 计算角标内容（取两个窗口剩余值中较小的一个作为"剩余用量"）。
 *
 * 展示口径：与官方界面一致，以「剩余」为主（剩余 = 100 - used_percent）。
 *
 * @author 黄杰
 */

/** 网页会话令牌接口：ChatGPT 网页应用从这里拿 Bearer token */
export const SESSION_URL = 'https://chatgpt.com/api/auth/session';
/** Codex CLI / 网页端共用的内部限额接口 */
export const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
/** Codex 内部重置卡明细接口：返回每张重置卡的状态与到期时间 */
export const CREDITS_URL = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits';
/** 网页端获取当前账户信息的接口，用于拿到 chatgpt-account-id */
export const ACCOUNTS_CHECK_URL = 'https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27';

/** 重置卡剩余有效期不足该毫秒数时，标记「即将到期」 */
export const EXPIRING_SOON_MS = 24 * 60 * 60 * 1000;
/** 请求上限及缓存有效期；后台和弹窗采用同一口径。 */
export const REQUEST_TIMEOUT_MS = 15000;
export const REFRESH_PERIOD_MINUTES = 30;
export const CACHE_KEY = 'lastQuota';
export const SELECTION_KEY = 'selectedAccount';
export const QUERY_STATUS_KEY = 'lastQueryStatus';
export const QUERY_MESSAGE = 'quota-query';
export const UPDATE_MESSAGE = 'quota-update';
export const SETTINGS_KEY = 'refreshSettings';
export const SETTINGS_MESSAGE = 'quota-settings';
export const REFRESH_INTERVALS = [5, 15, 30, 60];

/** 历史版本未保存设置时沿用自动刷新；损坏设置恢复默认值。 */
export function normalizeRefreshSettings(settings) {
  return {
    enabled: typeof settings?.enabled === 'boolean' ? settings.enabled : true,
    intervalMinutes: REFRESH_INTERVALS.includes(settings?.intervalMinutes)
      ? settings.intervalMinutes : REFRESH_PERIOD_MINUTES,
  };
}
export const ACCOUNT_SELECTION_REQUIRED = 'ACCOUNT_SELECTION_REQUIRED';
export const CACHE_MAX_AGE_MS = REFRESH_PERIOD_MINUTES * 60 * 1000;
export const MSG_USAGE_SCHEMA = '限额接口返回结构未识别：没有有效用量窗口，请用 --json 或官方用量页核对。';
export const MSG_CREDITS_SCHEMA = '重置卡接口返回结构未识别：无法确认卡片数量与到期时间。';

/** 校验用量结构，拒绝将损坏响应保存为一次成功查询。 */
export function validateUsage(data) {
  const rl = data && data.rate_limit;
  const windows = rl ? [rl.primary_window, rl.secondary_window] : [];
  if (!windows.some((win) => win && Number.isFinite(win.used_percent)) ||
      windows.some((win) => win != null && !Number.isFinite(win.used_percent))) {
    throw new Error(MSG_USAGE_SCHEMA);
  }
  return data;
}

/** 空数组是没有卡；缺失数组或损坏卡片属于接口错误。 */
export function validateCredits(data) {
  if (!data || !Array.isArray(data.credits) ||
      data.credits.some((card) => !card || typeof card.status !== 'string')) {
    throw new Error(MSG_CREDITS_SCHEMA);
  }
  return data;
}

/** 统一读取 JSON；超时涵盖响应体读取，区分登录、权限与结构错误。 */
async function requestJson(url, options, endpointLabel) {
  try {
    const res = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status === 401) {
      const error = new Error(`${endpointLabel}登录已失效（HTTP 401），请打开 chatgpt.com 重新登录。`);
      error.authExpired = true;
      throw error;
    }
    if (res.status === 403) {
      throw new Error(`${endpointLabel}无权访问（HTTP 403），请核对账户权限或网络访问限制。`);
    }
    if (!res.ok) {
      throw new Error(`${endpointLabel}返回 HTTP ${res.status}`);
    }
    try {
      return await res.json();
    } catch (err) {
      if (err.name === 'TimeoutError' || err.name === 'AbortError') throw err;
      throw new Error(`${endpointLabel}返回内容无法解析为 JSON。`);
    }
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new Error(`${endpointLabel}请求超时，请检查网络后重试。`);
    }
    if (err instanceof TypeError) {
      throw new Error(`${endpointLabel}网络请求失败，请检查网络或代理后重试。`);
    }
    throw err;
  }
}

/** plan_type 到中文名称的映射；未收录的值原样展示 */
export const PLAN_TYPE_NAMES = {
  free: 'Free',
  prolite: 'Pro Lite',
  plus: 'Plus',
  pro: 'Pro',
  team: 'Team',
  business: 'Business',
  enterprise: 'Enterprise',
};

/** 把毫秒时长格式化为中文时长，例如 2天3小时 / 5小时41分 / 8分钟 */
export function formatDuration(ms) {
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
export function formatUnix(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 把百分比限制在 0-100 区间 */
export function clampPercent(value) {
  return Math.max(0, Math.min(100, value));
}

/**
 * 从网页会话拿 Bearer 令牌（与 ChatGPT 网页应用相同的来源）。
 * 拿不到令牌说明登录态不可用，给出明确提示。
 */
export async function fetchSessionToken() {
  const data = await requestJson(SESSION_URL, { credentials: 'include' }, '会话接口');
  if (!data || !data.accessToken) {
    const error = new Error(
      '未获取到网页会话令牌。\n请在浏览器打开 chatgpt.com 确认已登录（能正常聊天），然后点「刷新」。'
    );
    error.authExpired = true;
    throw error;
  }
  return data;
}

/**
 * 带 Bearer 令牌调用 backend-api GET 接口并解析 JSON。
 * accountId 为空时不带 chatgpt-account-id 头。失败抛出带可读信息的错误。
 */
export async function fetchApiJson(token, url, accountId, endpointLabel) {
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
  if (accountId) {
    // 多账户/团队计划下需要账户请求头定位到当前账户
    headers['chatgpt-account-id'] = accountId;
  }
  return requestJson(url, { credentials: 'include', headers }, endpointLabel);
}

/**
 * 通过 accounts/check 枚举账户；多账户必须匹配用户明确选择的标识。
 * 兼容两种结构：标准结构的 entry.account，以及扁平结构的 entry 本身。
 * 返回了 JSON 但找不到 account_id 时，给出带诊断信息的明确错误。
 */
export async function fetchAccount(token, selectedId) {
  const data = await fetchApiJson(token, ACCOUNTS_CHECK_URL, null, 'accounts/check');
  const entries = data && data.accounts ? Object.values(data.accounts) : [];
  const accounts = entries.map((entry) => entry && (entry.account || entry))
    .filter((account) => account && typeof account.account_id === 'string' && account.account_id)
    .map((account) => ({ account_id: account.account_id,
      name: account.name || account.display_name || account.account_id }));
  const selected = accounts.find((account) => account.account_id === selectedId);
  if (selected || (!selectedId && accounts.length === 1)) {
    return { account: selected || accounts[0], accounts };
  }
  if (accounts.length > 0) {
    const error = new Error('请选择要查询的账户；此选择仅作用于额度查询工具。');
    error.code = ACCOUNT_SELECTION_REQUIRED;
    error.accounts = accounts;
    throw error;
  }
  const topKeys = data && typeof data === 'object' ? Object.keys(data).join(', ') : typeof data;
  throw new Error(`accounts/check 返回中未找到 account_id（顶层键: ${topKeys}）。\n请截图本提示反馈。`);
}

/** 调用限额接口（带 Bearer + 账户头） */
export async function fetchUsage(token, accountId) {
  const data = validateUsage(await fetchApiJson(token, USAGE_URL, accountId, '限额接口'));
  if (data.account_id && data.account_id !== accountId) {
    throw new Error('限额接口返回的账户与所选账户不一致，请重新选择账户。');
  }
  return data;
}

/** 调用重置卡明细接口（带 Bearer + 账户头） */
export async function fetchCredits(token, accountId) {
  return validateCredits(await fetchApiJson(token, CREDITS_URL, accountId, '重置卡接口'));
}

/**
 * 根据限额数据计算角标内容。
 * 取两个窗口剩余值中较小的一个（与官方"剩余用量"同口径）；
 * 返回 null 表示没有可用数据，此时不更新角标。
 */
export function computeBadge(usage) {
  const rl = usage && usage.rate_limit;
  if (!rl) {
    return null;
  }
  const remainings = [rl.primary_window, rl.secondary_window]
    .filter((win) => win && Number.isFinite(win.used_percent))
    .map((win) => 100 - clampPercent(win.used_percent));
  if (remainings.length === 0) {
    return null;
  }
  const min = Math.min(...remainings);
  const text = `${Math.round(min)}%`;
  // 剩余越少颜色越警示：>30% 绿、10%-30% 黄（配深色文字保证对比度）、<=10% 红
  if (min <= 10) {
    return { text, backgroundColor: '#f28b82', textColor: '#ffffff' };
  }
  if (min <= 30) {
    return { text, backgroundColor: '#fdd663', textColor: '#1e1f22' };
  }
  return { text, backgroundColor: '#81c995', textColor: '#ffffff' };
}

/** 把角标应用到浏览器工具栏图标上 */
export async function applyBadge(usage) {
  const badge = computeBadge(usage);
  if (!badge) {
    return;
  }
  await chrome.action.setBadgeText({ text: badge.text });
  await chrome.action.setBadgeBackgroundColor({ color: badge.backgroundColor });
  await chrome.action.setBadgeTextColor({ color: badge.textColor });
}
