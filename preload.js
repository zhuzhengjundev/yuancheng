/**
 * Electron Preload 脚本 - 公共服务器 + 设备代码/密码模式
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('remoteAPI', {
  // ============ 主界面（index.html） ============
  getDeviceInfo: () => ipcRenderer.invoke('get-device-info'),
  refreshPassword: () => ipcRenderer.invoke('refresh-password'),
  connectDevice: (targetCode, targetPassword) =>
    ipcRenderer.invoke('connect-device', { targetCode, targetPassword }),
  disconnect: () => ipcRenderer.invoke('disconnect'),

  // 主窗口事件
  onAppStatus: (callback) => {
    const h = (_e, d) => callback(d);
    ipcRenderer.on('app-status', h);
    return () => ipcRenderer.removeListener('app-status', h);
  },
  onDeviceInfo: (callback) => {
    const h = (_e, d) => callback(d);
    ipcRenderer.on('device-info', h);
    return () => ipcRenderer.removeListener('device-info', h);
  },
  onConnectError: (callback) => {
    const h = (_e, msg) => callback(msg);
    ipcRenderer.on('connect-error', h);
    return () => ipcRenderer.removeListener('connect-error', h);
  },
  onConnectOk: (callback) => {
    const h = (_e, r) => callback(r);
    ipcRenderer.on('connect-ok', h);
    return () => ipcRenderer.removeListener('connect-ok', h);
  },
  onIncomingControl: (callback) => {
    const h = (_e, r) => callback(r);
    ipcRenderer.on('incoming-control', h);
    return () => ipcRenderer.removeListener('incoming-control', h);
  },

  // ============ 控制窗口（control.html） ============
  sendCommand: (command, params) =>
    ipcRenderer.invoke('send-command', { command, params }),
  syncClipboard: (content) =>
    ipcRenderer.invoke('sync-clipboard', { content }),

  onScreenFrame: (callback) => {
    const h = (_e, d) => callback(d);
    ipcRenderer.on('screen-frame', h);
    return () => ipcRenderer.removeListener('screen-frame', h);
  },
  onSessionEnded: (callback) => {
    const h = () => callback();
    ipcRenderer.on('session-ended', h);
    return () => ipcRenderer.removeListener('session-ended', h);
  }
});
