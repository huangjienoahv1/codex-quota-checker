'use strict';

/**
 * Codex 额度查询插件——后台 service worker
 *
 * 职责：
 *   1. 每 30 分钟（chrome.alarms）自动查询一次限额，把「剩余用量」写到
 *      工具栏图标角标上：剩余 >30% 绿、10%-30% 黄、<=10% 红；
 *   2. 刷新成功后把最新限额数据合并进本地缓存（chrome.storage.local），
 *      供 popup 打开时秒显；重置卡明细字段保留 popup 上次拉到的内容。
 *
 * 失败策略：后台刷新失败时保持现有角标不变（静默，避免打扰），
 * 用户点开 popup 时仍会看到明确错误提示。
 *
 * @author 黄杰
 */

import { fetchAccount, fetchSessionToken, fetchUsage, applyBadge } from './core.js';

/** 角标定时刷新的闹钟名称 */
const ALARM_NAME = 'badge-refresh';
/** 角标自动刷新周期（分钟） */
const REFRESH_PERIOD_MINUTES = 30;

/** 查询限额 → 更新角标 → 合并本地缓存 */
async function refreshBadgeAndCache() {
  try {
    const session = await fetchSessionToken();
    const account = await fetchAccount(session.accessToken);
    const usage = await fetchUsage(session.accessToken, account.account_id);

    await applyBadge(usage);

    // 合并缓存：只更新 usage 与时间戳，保留 popup 拉到的重置卡明细
    const stored = (await chrome.storage.local.get('lastQuota')).lastQuota || {};
    await chrome.storage.local.set({
      lastQuota: { ...stored, usage, savedAt: Date.now() },
    });
  } catch {
    // 静默失败：角标保持旧值；popup 打开时会给出具体错误信息
  }
}

// 安装/更新插件时：注册定时闹钟并立即刷一次
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM_NAME, {
    periodInMinutes: REFRESH_PERIOD_MINUTES,
    delayInMinutes: 1,
  });
  refreshBadgeAndCache();
});

// 浏览器启动时：确保闹钟存在并立即刷一次
chrome.runtime.onStartup.addListener(refreshBadgeAndCache);

// 定时闹钟触发：刷新角标
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    refreshBadgeAndCache();
  }
});
