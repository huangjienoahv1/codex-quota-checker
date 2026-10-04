'use strict';

/**
 * Codex 额度查询工具（本地命令行版）
 *
 * 主要职责：
 *   1. 读取本机 Codex CLI 登录后写入的 ChatGPT OAuth 凭据（~/.codex/auth.json）；
 *   2. 用该凭据调用 Codex CLI 自身使用的两个内部接口：
 *      - GET https://chatgpt.com/backend-api/wham/usage                     限额用量与重置时间
 *      - GET https://chatgpt.com/backend-api/wham/rate-limit-reset-credits  重置卡（限额重置点）明细
 *   3. 在终端输出：5 小时窗口 / 每周窗口的剩余百分比、重置倒计时，
 *      以及每张重置卡的到期时间。
 *
 * 完整调用链：
 *   用户双击 查询额度.bat → node 运行本文件 → 读取 auth.json 中的 access_token
 *   → 并行请求上述两个接口 → 结果仅输出到终端，不落盘、不发给任何第三方。
 *
 * 展示口径：与 ChatGPT/Codex 官方界面一致，以「剩余」为主口径
 * （接口返回的是 used_percent 已用百分比，剩余 = 100 - 已用）。
 *
 * 使用方式：
 *   node codex-quota.js          正常查询并输出可读结果
 *   node codex-quota.js --json   只输出两个接口的原始 JSON（用于排查问题）
 *
 * @author 黄杰
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** Codex CLI 内部限额用量接口（与 Codex CLI / CodexBar 使用的是同一个接口） */
const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
/** Codex 内部重置卡明细接口：返回每张重置卡的状态与到期时间 */
const CREDITS_URL = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits';
/** 单次接口请求超时时间（毫秒） */
const REQUEST_TIMEOUT_MS = 15000;
/** 进度条字符宽度 */
const BAR_WIDTH = 12;
/** 重置卡剩余有效期不足该毫秒数时，标记「即将到期」 */
const EXPIRING_SOON_MS = 24 * 60 * 60 * 1000;

/** 凭据缺失或非 ChatGPT 登录模式时的提示 */
const MSG_NO_OAUTH =
  '未找到 ChatGPT 登录凭据。\n' +
  '请确认本机已安装 Codex CLI，并在终端运行过 codex login（ChatGPT 账号登录）。\n' +
  '仅使用 API Key 模式（auth_mode=apikey）时无法查询订阅额度。';
/** 凭据过期时的提示：Codex CLI 使用时会自动续期凭据 */
const MSG_TOKEN_EXPIRED =
  '登录凭据已过期（接口返回 401）。\n' +
  '请在终端随便运行一次 codex（它会自动续期凭据），或重新执行 codex login，然后再次查询。';

/** plan_type 到中文名称的映射；未收录的值原样展示 */
const PLAN_TYPE_NAMES = {
  free: 'Free（免费）',
  prolite: 'Pro Lite',
  plus: 'Plus',
  pro: 'Pro',
  team: 'Team',
  business: 'Business',
  enterprise: 'Enterprise',
};

/** 读取本机 Codex 登录凭据；返回 { tokens, auth_mode } 或 null（文件不存在/损坏） */
function readCodexAuth() {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const authPath = path.join(codexHome, 'auth.json');
  if (!fs.existsSync(authPath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(authPath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 用 OAuth 凭据调用 Codex 内部 GET 接口并解析 JSON。
 * usage 和重置卡两个接口的认证方式、错误语义完全一致，统一走这里。
 * 成功返回解析后的 JSON；失败抛出带可读信息的错误。
 */
async function fetchJson(tokens, url) {
  const headers = {
    Authorization: `Bearer ${tokens.access_token}`,
    Accept: 'application/json',
    // 这两个标识头与 Codex CLI 的请求保持一致，部分网关会校验
    'User-Agent': 'codex_cli_rs/1.0',
    originator: 'codex_cli_rs',
  };
  if (tokens.account_id) {
    // 账户维度请求头，多账户/团队计划下用于定位到当前账户
    headers['chatgpt-account-id'] = tokens.account_id;
  }

  let res;
  try {
    res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`网络请求失败：${err.message}（请检查网络或代理）`);
  }

  const bodyText = await res.text();

  if (res.status === 401) {
    throw new Error(MSG_TOKEN_EXPIRED);
  }
  if (!res.ok) {
    throw new Error(`接口 ${url} 返回 HTTP ${res.status}：${bodyText.slice(0, 300)}`);
  }

  try {
    return JSON.parse(bodyText);
  } catch {
    throw new Error(`接口返回内容无法解析为 JSON：${bodyText.slice(0, 300)}`);
  }
}

/** 把百分比限制在 0-100 区间，容忍接口返回浮点或越界值 */
function clampPercent(value) {
  return Math.max(0, Math.min(100, value));
}

/**
 * 渲染单个限额窗口：进度条以「剩余」为口径（与官方界面一致），
 * 同时标注已用百分比、重置时刻和重置倒计时。
 */
function renderWindow(label, win) {
  if (!win || typeof win.used_percent !== 'number') {
    console.log(`${label}：无数据`);
    return;
  }
  const used = clampPercent(win.used_percent);
  const remaining = 100 - used;
  const filled = Math.round((remaining / 100) * BAR_WIDTH);
  const bar = '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled);

  let resetText = '';
  if (Number.isFinite(win.reset_at) && Number.isFinite(win.reset_after_seconds)) {
    resetText = `${formatUnix(win.reset_at)} 重置（${formatDuration(win.reset_after_seconds)}后）`;
  } else if (Number.isFinite(win.reset_after_seconds)) {
    resetText = `${formatDuration(win.reset_after_seconds)}后重置`;
  }
  console.log(
    `${label}  ${bar} 剩 ${remaining.toFixed(0)}%（已用 ${used.toFixed(0)}%）  ${resetText}`.trimEnd()
  );
}

/**
 * 渲染重置卡明细：列出每张可用重置卡的类型、到期时间与剩余有效期。
 * creditsData 为空说明该接口本次获取失败，此时明确输出失败原因，不静默跳过。
 * expires_at 为 UTC ISO 时间字符串，统一转成本地时间显示。
 */
function renderCredits(creditsData, creditsError) {
  if (!creditsData) {
    const reason = creditsError && creditsError.message ? creditsError.message : '未知原因';
    console.log(`重置卡信息获取失败：${reason}`);
    return;
  }

  const available = (creditsData.credits || [])
    .filter((card) => card.status === 'available')
    .map((card) => ({ ...card, expireMs: Date.parse(card.expires_at) }))
    // 到期时间缺失或无法解析的卡片排到最后，避免 NaN 参与排序和展示
    .sort(
      (a, b) =>
        (Number.isNaN(a.expireMs) ? Infinity : a.expireMs) -
        (Number.isNaN(b.expireMs) ? Infinity : b.expireMs)
    );

  console.log('─'.repeat(52));
  console.log(`重置卡：可用 ${available.length} 张`);

  if (available.length === 0) {
    console.log('  （当前没有可用重置卡）');
    return;
  }

  available.forEach((card, index) => {
    const title = card.title || '重置卡';
    if (Number.isNaN(card.expireMs)) {
      console.log(`  ${index + 1}. ${title}  到期时间未知`);
      return;
    }
    const remainMs = card.expireMs - Date.now();
    const remainText = remainMs <= 0 ? '已到期' : `${formatDuration(remainMs / 1000)}后`;
    const soonMark = remainMs > 0 && remainMs <= EXPIRING_SOON_MS ? '  ⚠ 即将到期' : '';
    console.log(`  ${index + 1}. ${title}  ${formatUnix(card.expireMs / 1000)} 到期（${remainText}）${soonMark}`);
  });
}

/** 把秒数格式化为中文时长，例如 2天3小时 / 5小时41分 / 8分钟 */
function formatDuration(seconds) {
  const sec = Math.max(0, Math.floor(seconds));
  const days = Math.floor(sec / 86400);
  const hours = Math.floor((sec % 86400) / 3600);
  const minutes = Math.floor((sec % 3600) / 60);
  if (days > 0) return `${days}天${hours}小时`;
  if (hours > 0) return `${hours}小时${minutes}分`;
  if (minutes > 0) return `${minutes}分钟`;
  return `${sec}秒`;
}

/** 把 Unix 秒级时间戳格式化为本地的 MM-dd HH:mm */
function formatUnix(unixSeconds) {
  const d = new Date(unixSeconds * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 渲染完整的可读结果 */
function renderQuota(data, creditsData, creditsError) {
  const planName = PLAN_TYPE_NAMES[data.plan_type] || data.plan_type || '未知';
  const rl = data.rate_limit || {};

  // 顶部「剩余用量」取两个窗口剩余值中较小的一个，与官方界面口径一致
  const remainings = [rl.primary_window, rl.secondary_window]
    .filter((win) => win && typeof win.used_percent === 'number')
    .map((win) => 100 - clampPercent(win.used_percent));
  const overallText =
    remainings.length > 0 ? `    剩余用量 ${Math.min(...remainings).toFixed(0)}%` : '';

  console.log('');
  console.log(`Codex 额度查询    ${new Date().toLocaleString('zh-CN')}`);
  console.log(`账号：${data.email || '未知'}    计划：${planName}${overallText}`);
  console.log('─'.repeat(52));

  if (rl.limit_reached) {
    console.log('⚠  当前限额已用尽（limit_reached=true）');
  }
  renderWindow('5 小时窗口', rl.primary_window);
  renderWindow('每周窗口', rl.secondary_window);

  renderCredits(creditsData, creditsError);
  console.log('');
}

/** 程序入口：解析参数 → 读凭据 → 并行调两个接口 → 输出结果 */
async function main() {
  const auth = readCodexAuth();
  if (!auth || !auth.tokens || !auth.tokens.access_token) {
    console.error(MSG_NO_OAUTH);
    process.exitCode = 1;
    return;
  }
  if (auth.auth_mode && auth.auth_mode !== 'chatgpt' && !process.argv.includes('--json')) {
    console.error(`当前 auth_mode=${auth.auth_mode}，不是 ChatGPT 登录模式，无法查询订阅额度。`);
    process.exitCode = 1;
    return;
  }

  // 用量接口是主数据；重置卡接口失败不影响窗口展示，但失败原因要如实输出
  const [usageResult, creditsResult] = await Promise.allSettled([
    fetchJson(auth.tokens, USAGE_URL),
    fetchJson(auth.tokens, CREDITS_URL),
  ]);

  if (process.argv.includes('--json')) {
    // 排查模式：直接输出两个接口的原始返回
    const output = {};
    if (usageResult.status === 'fulfilled') {
      output.usage = usageResult.value;
    } else {
      output.usage_error = usageResult.reason.message;
    }
    if (creditsResult.status === 'fulfilled') {
      output.credits = creditsResult.value;
    } else {
      output.credits_error = creditsResult.reason.message;
    }
    console.log(JSON.stringify(output, null, 2));
    if (usageResult.status === 'rejected') {
      process.exitCode = 1;
    }
    return;
  }

  if (usageResult.status === 'rejected') {
    console.error(`查询失败：${usageResult.reason.message}`);
    process.exitCode = 1;
    return;
  }

  const data = usageResult.value;
  if (!data || !data.rate_limit) {
    console.error('接口返回中未包含限额数据，结构可能已变化。用 --json 查看原始返回。');
    process.exitCode = 1;
    return;
  }

  const creditsData = creditsResult.status === 'fulfilled' ? creditsResult.value : null;
  const creditsError = creditsResult.status === 'rejected' ? creditsResult.reason : null;
  renderQuota(data, creditsData, creditsError);
}

main();
