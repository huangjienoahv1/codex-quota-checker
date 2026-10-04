'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// 只暴露两个固定动作，不把文件、凭据或任意 IPC 能力交给页面。
contextBridge.exposeInMainWorld('quotaApp', {
  refresh: () => ipcRenderer.invoke('quota:refresh'),
  openUsage: () => ipcRenderer.invoke('quota:open-usage'),
});
