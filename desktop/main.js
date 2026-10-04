'use strict';

/** 桌面入口：窗口 → 固定 IPC → 共用查询模块；凭据只留在主进程内存。 */
const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const CORE_PATH = app.isPackaged
  ? path.join(process.resourcesPath, 'codex-quota.js')
  : path.join(__dirname, '..', 'local', 'codex-quota.js');
const { queryQuota } = require(CORE_PATH);
const PAGE_PATH = path.join(__dirname, 'ui', 'index.html');
const PAGE_URL = pathToFileURL(PAGE_PATH).href;
const USAGE_URL = 'https://chatgpt.com/codex/cloud/settings/analytics#usage';
let mainWindow = null;
let pendingQuery = null;

/** 只接受本地顶层窗口发起的动作，子框架或跳转后的页面不能调用查询。 */
function checkSender(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents ||
      event.senderFrame !== mainWindow.webContents.mainFrame ||
      event.senderFrame.url !== PAGE_URL) {
    throw new Error('请求来源无效。');
  }
}

/** 窗口关闭后直接退出；重复启动只激活现有窗口，避免多份后台查询。 */
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1080, height: 800, minWidth: 700, minHeight: 600,
    title: 'Codex 额度查询', backgroundColor: '#111715', show: false,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  });
  mainWindow.setMenu(null);
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());
  mainWindow.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  mainWindow.webContents.session.setPermissionCheckHandler(() => false);
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.loadFile(PAGE_PATH).catch((error) => {
    dialog.showErrorBox('窗口加载失败', error.message);
    app.quit();
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
  app.whenReady().then(() => {
    ipcMain.handle('quota:refresh', (event) => {
      checkSender(event);
      // 并发刷新共用一次查询；错误明确返回，刷新后不沿用旧账号数据。
      if (!pendingQuery) {
        pendingQuery = queryQuota()
          .then((data) => ({ ...data, fetchedAt: Date.now() }))
          .catch((error) => ({ usage_error: error.message }))
          .finally(() => { pendingQuery = null; });
      }
      return pendingQuery;
    });
    ipcMain.handle('quota:open-usage', (event) => {
      checkSender(event);
      return shell.openExternal(USAGE_URL);
    });
    createWindow();
  }).catch((error) => {
    dialog.showErrorBox('启动失败', error.message);
    app.quit();
  });
  app.on('window-all-closed', () => app.quit());
}
