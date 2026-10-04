'use strict';

/**
 * 插件查询的唯一执行入口：弹窗消息与定时闹钟均进入 queryQuota。
 * 登录身份确认后读取同账户缓存，额度先发布，卡片随后发布；所有缓存写入
 * 由本 worker 串行完成，令牌只留在请求内存中，失败会记录状态并标记角标。
 * @author 黄杰
 */
import {
  ACCOUNT_SELECTION_REQUIRED, CACHE_KEY, CACHE_MAX_AGE_MS, SELECTION_KEY, QUERY_STATUS_KEY,
  QUERY_MESSAGE, UPDATE_MESSAGE, SETTINGS_KEY, SETTINGS_MESSAGE,
  REFRESH_INTERVALS, normalizeRefreshSettings,
  fetchAccount, fetchSessionToken, fetchUsage,
  fetchCredits, applyBadge, validateUsage, validateCredits,
} from './core.js';

const ALARM_NAME = 'badge-refresh';
let inFlight = null;
let currentSnapshot = null;
let alarmTask = Promise.resolve();

/** 广播已确认身份的快照；弹窗关闭时没有监听者属于正常情况。 */
async function publish(snapshot) {
  currentSnapshot = snapshot;
  try {
    await chrome.runtime.sendMessage({ type: UPDATE_MESSAGE, snapshot });
  } catch (err) {
    if (!err.message.includes('Receiving end does not exist')) {
      console.warn('额度更新通知失败：', err.message);
    }
  }
}

/** 后台失败或数据过期时避免继续显示看似实时的剩余百分比。 */
async function markBadgeError(message) {
  await chrome.action.setBadgeText({ text: '!' });
  await chrome.action.setBadgeBackgroundColor({ color: '#fdd663' });
  await chrome.action.setBadgeTextColor({ color: '#1e1f22' });
  await chrome.action.setTitle({ title: 'Codex 额度：' + message });
}

/** 成功数据写入缓存后发布；存储失败不伪装成查询失败，保留可见警告。 */
async function saveAndPublish(snapshot) {
  try {
    await chrome.storage.local.set({
      [CACHE_KEY]: snapshot,
      [QUERY_STATUS_KEY]: { lastAttemptAt: snapshot.lastAttemptAt, lastError: snapshot.lastError },
    });
  } catch (err) {
    console.warn('额度缓存写入失败：', err.message);
    snapshot.cacheError = '本地缓存写入失败，下次打开将重新查询。';
  }
  await publish(snapshot);
}

/**
 * 确认会话用户和所选账户后查询；旧账户明细绝不合并到新用量。
 * 额度与卡片各有采集时间，失败仅保留同账户额度并显式标记错误。
 */
async function refreshBadgeAndCache(selectedId) {
  let scope = null;
  let snapshot = null;
  currentSnapshot = null;
  try {
    const session = await fetchSessionToken();
    const userId = session.user && (session.user.id || session.user.email);
    if (typeof userId !== 'string' || !userId) {
      throw new Error('会话接口缺少用户标识，无法安全匹配缓存，请重新登录。');
    }
    const storedSelection = (await chrome.storage.local.get(SELECTION_KEY))[SELECTION_KEY];
    const preferredId = selectedId || (storedSelection && storedSelection.userId === userId
      ? storedSelection.accountId : null);
    const { account, accounts } = await fetchAccount(session.accessToken, preferredId);
    scope = { userId, accountId: account.account_id };
    await chrome.storage.local.set({ [SELECTION_KEY]: scope });

    const stored = (await chrome.storage.local.get(CACHE_KEY))[CACHE_KEY];
    if (stored && stored.userId === userId && stored.accountId === scope.accountId) {
      try {
        validateUsage(stored.usage);
        if (stored.credits) validateCredits(stored.credits);
        if (!Number.isFinite(stored.savedAt)) throw new Error('缓存缺少采集时间');
        snapshot = { ...stored, accounts, cached: true, creditsPending: false };
        await publish(snapshot);
      } catch (err) {
        console.warn('清除无效额度缓存：', err.message);
        await chrome.storage.local.remove(CACHE_KEY);
        await publish({ ...scope, accounts, clearContent: true });
      }
    } else {
      // 不兼容的历史缓存与其他账号缓存必须清除，并通知弹窗隐藏旧内容。
      await chrome.storage.local.remove(CACHE_KEY);
      await publish({ ...scope, accounts, clearContent: true });
    }

    const usage = await fetchUsage(session.accessToken, scope.accountId);
    snapshot = {
      ...scope, accounts, usage, savedAt: Date.now(), credits: null,
      creditsSavedAt: null, creditsPending: true, creditsError: null,
      lastAttemptAt: Date.now(), lastError: null, cached: false,
    };
    // 主数据先进入缓存和界面，卡片网络等待不会阻塞额度展示。
    await saveAndPublish(snapshot);
    await applyBadge(usage);
    await chrome.action.setTitle({
      title: 'Codex 额度，更新于 ' + new Date(snapshot.savedAt).toLocaleString('zh-CN'),
    });

    try {
      snapshot.credits = await fetchCredits(session.accessToken, scope.accountId);
      snapshot.creditsSavedAt = Date.now();
    } catch (err) {
      snapshot.creditsError = err.message;
      console.warn('重置卡查询失败：', err.message);
      if (err.authExpired) throw err;
    }
    snapshot.creditsPending = false;
    await saveAndPublish(snapshot);
    return { ok: true, snapshot };
  } catch (err) {
    const clearContent = !scope || err.authExpired || err.code === ACCOUNT_SELECTION_REQUIRED;
    console.warn('额度查询失败：', err.message);
    try {
      await chrome.storage.local.set({
        [QUERY_STATUS_KEY]: { lastAttemptAt: Date.now(), lastError: err.message },
      });
    } catch (storageErr) {
      console.warn('查询失败状态保存失败：', storageErr.message);
    }
    if (clearContent) {
      await chrome.storage.local.remove(CACHE_KEY);
      await publish({ clearContent: true, accounts: err.accounts || [], error: err.message });
    } else if (snapshot) {
      snapshot = { ...snapshot, cached: true, creditsPending: false,
        lastError: err.message, lastAttemptAt: Date.now() };
      await saveAndPublish(snapshot);
    }
    await markBadgeError(err.message);
    return { ok: false, error: err.message, clearContent,
      accounts: err.accounts || [], snapshot: clearContent ? null : snapshot };
  }
}

/** 合并重复刷新；显式切换账户等待旧查询结束后再执行，避免写入竞争。 */
async function queryQuota(selectedId) {
  if (inFlight) {
    if (!selectedId) return inFlight;
    await inFlight;
    return queryQuota(selectedId);
  }
  inFlight = refreshBadgeAndCache(selectedId);
  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

/** 按持久化设置同步闹钟；关闭时删除，间隔不变时保留原计划。 */
async function syncAlarm() {
  const storedSettings = (await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY];
  const settings = normalizeRefreshSettings(storedSettings);
  const alarm = await chrome.alarms.get(ALARM_NAME);
  if (!settings.enabled) {
    await chrome.alarms.clear(ALARM_NAME);
  } else if (!alarm || alarm.periodInMinutes !== settings.intervalMinutes) {
    await chrome.alarms.create(ALARM_NAME, {
      periodInMinutes: settings.intervalMinutes, delayInMinutes: settings.intervalMinutes,
    });
  }
  const state = await chrome.storage.local.get([CACHE_KEY, QUERY_STATUS_KEY]);
  const stored = state[CACHE_KEY];
  const lastError = state[QUERY_STATUS_KEY] && state[QUERY_STATUS_KEY].lastError;
  if (!inFlight && (lastError || (stored && (!Number.isFinite(stored.savedAt) ||
      Date.now() - stored.savedAt > CACHE_MAX_AGE_MS)))) {
    await markBadgeError(lastError || '缓存已过期，请刷新');
  }
  return settings;
}

/** 串行同步设置与闹钟，防止 worker 初始化和设置保存相互覆盖。 */
function ensureAlarm(settings) {
  const task = alarmTask.then(async () => {
    if (settings) await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
    return syncAlarm();
  });
  alarmTask = task.catch((err) => console.error('刷新设置同步失败：', err.message));
  return task;
}

/** 后台事件查询前检查开关，关闭后即使有已排队的闹钟也不触发查询。 */
function refreshFromEvent() {
  ensureAlarm().then((settings) => {
    if (settings.enabled) return queryQuota();
  }).catch((err) => console.error('后台刷新失败：', err.message));
}

chrome.runtime.onInstalled.addListener(refreshFromEvent);
chrome.runtime.onStartup.addListener(refreshFromEvent);
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) refreshFromEvent();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !message) return false;
  if (message.type === SETTINGS_MESSAGE) {
    const settings = message.settings;
    if (!settings || typeof settings.enabled !== 'boolean' ||
        !REFRESH_INTERVALS.includes(settings.intervalMinutes)) {
      sendResponse({ ok: false, error: '自动刷新设置无效。' });
      return false;
    }
    ensureAlarm(normalizeRefreshSettings(settings)).then((saved) => {
      sendResponse({ ok: true, settings: saved });
    }).catch((err) => {
      sendResponse({ ok: false, error: '设置保存或定时任务同步失败：' + err.message });
    });
    return true;
  }
  if (message.type !== QUERY_MESSAGE) return false;
  if (message.accountId != null && typeof message.accountId !== 'string') {
    sendResponse({ ok: false, error: '账户标识无效。', clearContent: true });
    return false;
  }
  if (inFlight && currentSnapshot && !message.accountId) {
    publish(currentSnapshot).catch((err) => console.warn('缓存通知失败：', err.message));
  }
  queryQuota(message.accountId).then(sendResponse).catch((err) => {
    console.error('查询任务失败：', err.message);
    sendResponse({ ok: false, error: '后台查询失败，请重新加载插件后重试。', clearContent: true });
  });
  return true;
});

ensureAlarm().catch((err) => console.error('定时刷新初始化失败：', err.message));
