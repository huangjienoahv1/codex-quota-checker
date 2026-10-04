'use strict';

const SECOND_MS = 1000;
const MINUTE_SECONDS = 60;
const HOUR_SECONDS = 3600;
const DAY_SECONDS = 86400;
const EXPIRING_SOON_MS = DAY_SECONDS * SECOND_MS;
const LOW_REMAINING_PERCENT = 10;
const MEDIUM_REMAINING_PERCENT = 30;
const PLAN_NAMES = { free: 'Free', prolite: 'Pro Lite', plus: 'Plus', pro: 'Pro', team: 'Team', business: 'Business', enterprise: 'Enterprise' };
const CARD_AVAILABLE = 'available';
const FULL_RESET_TITLE = 'Full reset (Weekly + 5 hr)';
let loading = false;
let result = null;
let countdowns = [];
const element = (id) => document.getElementById(id);

/** 本地时间显示；时刻缺失时明确显示未知，不推测到期时间。 */
function dateText(ms) {
  if (!Number.isFinite(ms)) return '时间未知';
  return new Date(ms).toLocaleString('zh-CN', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}

/** 每秒更新真实截止时刻的剩余时间，不把倒计时结束当成配额已经恢复。 */
function duration(ms) {
  const seconds = Math.max(0, Math.floor(ms / SECOND_MS));
  const days = Math.floor(seconds / DAY_SECONDS);
  const hours = Math.floor(seconds % DAY_SECONDS / HOUR_SECONDS);
  const minutes = Math.floor(seconds % HOUR_SECONDS / MINUTE_SECONDS);
  if (days) return `${days}天${hours}小时后`;
  if (hours) return `${hours}小时${minutes}分钟后`;
  if (minutes) return `${minutes}分钟后`;
  return `${seconds}秒后`;
}

/** 从接口的绝对时刻或采集时间推导重置时刻，仅用于倒计时。 */
function resetTime(win) {
  if (Number.isFinite(win.reset_at)) return win.reset_at * SECOND_MS;
  if (Number.isFinite(win.reset_after_seconds)) return result.fetchedAt + win.reset_after_seconds * SECOND_MS;
  return null;
}

/** 渲染额度窗口：进度条和大号数字都表示剩余百分比。 */
function renderWindow(id, win) {
  const root = element(id);
  const known = win && Number.isFinite(win.used_percent);
  const used = known ? Math.min(100, Math.max(0, win.used_percent)) : null;
  const remaining = known ? 100 - used : null;
  root.querySelector('.percent').textContent = known ? `${remaining.toFixed(0)}%` : '—';
  root.querySelector('.used').textContent = known ? `已用 ${used.toFixed(0)}%` : '无可用数据';
  root.querySelector('.fill').style.width = known ? `${remaining}%` : '0%';
  root.style.setProperty('--window-color', known && remaining <= LOW_REMAINING_PERCENT ? 'var(--red)' : known && remaining <= MEDIUM_REMAINING_PERCENT ? 'var(--amber)' : 'var(--accent)');
  const bar = root.querySelector('.bar');
  if (known) bar.setAttribute('aria-valuenow', remaining.toFixed(0));
  else bar.removeAttribute('aria-valuenow');
  const reset = known ? resetTime(win) : null;
  root.querySelector('.reset').textContent = reset !== null ? `${dateText(reset)} 重置` : '重置时间未知';
  root.querySelector('.countdown').textContent = '—';
  if (reset !== null) countdowns.push({ element: root.querySelector('.countdown'), time: reset });
}

/** 重置卡独立失败时显示真实错误和已知汇总；不把明细失败展示成没有卡片。 */
function renderCredits() {
  const list = element('cards');
  list.replaceChildren();
  if (result.credits_error || !result.credits) {
    const count = result.usage?.rate_limit_reset_credits?.available_count;
    element('card-count').textContent = Number.isFinite(count) ? `可用 ${count} 张 · 明细获取失败` : '获取失败';
    const error = document.createElement('div');
    error.className = 'message error';
    error.textContent = result.credits_error || '未获取到重置卡明细。';
    list.append(error);
    return;
  }
  const cards = result.credits.credits.filter((card) => card.status === CARD_AVAILABLE)
    .map((card) => ({ ...card, expiresMs: Date.parse(card.expires_at) }))
    .sort((a, b) => (Number.isFinite(a.expiresMs) ? a.expiresMs : Infinity) - (Number.isFinite(b.expiresMs) ? b.expiresMs : Infinity));
  element('card-count').textContent = `可用 ${cards.length} 张`;
  if (!cards.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = '当前没有可用重置卡';
    list.append(empty);
  }
  cards.forEach((card) => {
    const row = element('card-template').content.firstElementChild.cloneNode(true);
    const fullReset = card.title === FULL_RESET_TITLE || card.title === '完全重置（每周 + 5 小时）';
    row.querySelector('.ticket-name strong').textContent = fullReset ? '完全重置' : card.title || '重置卡';
    row.querySelector('.ticket-name span').textContent = fullReset ? '每周 + 5 小时' : '可用重置卡';
    row.querySelector('.expiry').textContent = Number.isFinite(card.expiresMs) ? `${dateText(card.expiresMs)} 到期` : '到期时间未知';
    const countdown = row.querySelector('.ticket-countdown');
    countdown.textContent = '时间未知';
    if (Number.isFinite(card.expiresMs)) countdowns.push({ element: countdown, time: card.expiresMs, row });
    list.append(row);
  });
}

/** 更新倒计时和即将到期提示，卡片有效性仍以本次官方接口结果为准。 */
function tick() {
  countdowns.forEach((item) => {
    const remaining = item.time - Date.now();
    item.element.textContent = remaining > 0 ? duration(remaining) : item.row ? '已到期 · 请刷新确认' : '已到重置时间 · 请刷新';
    if (item.row) {
      const soon = remaining > 0 && remaining <= EXPIRING_SOON_MS;
      item.row.classList.toggle('soon', soon);
      item.row.classList.toggle('expired', remaining <= 0);
      if (soon) item.element.textContent = `即将到期 · ${duration(remaining)}`;
    }
  });
}

/** 刷新时清理旧身份与数据；查询失败只显示真实错误，不残留上个账号信息。 */
async function refresh() {
  if (loading) return;
  loading = true;
  result = null;
  countdowns = [];
  element('refresh').disabled = true;
  element('refresh').querySelector('span').textContent = '查询中…';
  element('error').hidden = true;
  element('notice').hidden = true;
  element('email').textContent = '正在读取账号…';
  element('plan').hidden = true;
  element('updated').textContent = '查询中';
  renderWindow('primary', null);
  renderWindow('secondary', null);
  element('card-count').textContent = '等待查询';
  element('cards').replaceChildren();
  try {
    result = await window.quotaApp.refresh();
    if (result.usage_error) throw new Error(result.usage_error);
    const data = result.usage;
    element('email').textContent = data.email || '账号邮箱未提供';
    element('plan').textContent = PLAN_NAMES[data.plan_type] || data.plan_type || '未知计划';
    element('plan').hidden = false;
    element('updated').textContent = `更新于 ${new Date(result.fetchedAt).toLocaleTimeString('zh-CN', { hour12: false })}`;
    renderWindow('primary', data.rate_limit.primary_window);
    renderWindow('secondary', data.rate_limit.secondary_window);
    if (data.rate_limit.limit_reached) {
      element('notice').textContent = '当前限额已用尽，请等待重置或前往官方用量页查看。';
      element('notice').hidden = false;
    }
    renderCredits();
    tick();
    element('status').textContent = '数据仅在本机显示 · 额度以本次查询结果为准';
  } catch (error) {
    element('error').textContent = error.message;
    element('error').hidden = false;
    element('email').textContent = '未能获取账号信息';
    element('updated').textContent = '查询失败';
    element('card-count').textContent = '未查询';
    element('status').textContent = '请处理上方提示后重新刷新';
  } finally {
    loading = false;
    element('refresh').disabled = false;
    element('refresh').querySelector('span').textContent = '刷新额度';
  }
}

element('refresh').addEventListener('click', refresh);
element('open-usage').addEventListener('click', async () => {
  try { await window.quotaApp.openUsage(); }
  catch (error) {
    element('error').textContent = `打开官方用量页失败：${error.message}`;
    element('error').hidden = false;
  }
});
setInterval(tick, SECOND_MS);
refresh();
