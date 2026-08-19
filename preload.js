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
  openScreenRecordSettings: () => ipcRenderer.invoke('open-screen-record-settings'),

  // ============ WS 地址管理（setup.html + index.html） ============
  validateWsUrl: (url) => ipcRenderer.invoke('validate-ws-url', { url }),
  saveWsUrl: (url) => ipcRenderer.invoke('save-ws-url', { url }),
  getWsUrl: () => ipcRenderer.invoke('get-ws-url'),
  gotoHome: () => ipcRenderer.invoke('goto-home'),
  gotoSetup: () => ipcRenderer.invoke('goto-setup'),

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
  onCaptureStatus: (callback) => {
    const h = (_e, s) => callback(s);
    ipcRenderer.on('capture-status', h);
    return () => ipcRenderer.removeListener('capture-status', h);
  },

  // ============ 控制窗口（control.html） ============
  sendCommand: (command, params) =>
    ipcRenderer.invoke('send-command', { command, params }),
  syncClipboard: (content) =>
    ipcRenderer.invoke('sync-clipboard', { content }),

  // 分块传输：帧头
  onScreenFrameHeader: (callback) => {
    const h = (_e, d) => callback(d);
    ipcRenderer.on('screen-frame-header', h);
    return () => ipcRenderer.removeListener('screen-frame-header', h);
  },
  
  // 分块传输：数据块
  onScreenFrameChunk: (callback) => {
    const h = (_e, d) => callback(d);
    ipcRenderer.on('screen-frame-chunk', h);
    return () => ipcRenderer.removeListener('screen-frame-chunk', h);
  },
  
  // 兼容旧格式（完整帧一次性发送）
  onScreenFrame: (callback) => {
    const h = (_e, d) => callback(d);
    ipcRenderer.on('screen-frame', h);
    return () => ipcRenderer.removeListener('screen-frame', h);
  },
  
  onSessionEnded: (callback) => {
    const h = () => callback();
    ipcRenderer.on('session-ended', h);
    return () => ipcRenderer.removeListener('session-ended', h);
  },

  // ============ 诊断（全链路排查用） ============
  // 主控端：主进程收到的帧统计
  onDiagStats: (callback) => {
    const h = (_e, d) => callback(d);
    ipcRenderer.on('diag-stats', h);
    return () => ipcRenderer.removeListener('diag-stats', h);
  },
  // 被控端：捕获统计（帧数/失败数）
  onCaptureStats: (callback) => {
    const h = (_e, d) => callback(d);
    ipcRenderer.on('capture-stats', h);
    return () => ipcRenderer.removeListener('capture-stats', h);
  },
  // 被控端：键鼠模块状态
  onRobotStatus: (callback) => {
    const h = (_e, d) => callback(d);
    ipcRenderer.on('robot-status', h);
    return () => ipcRenderer.removeListener('robot-status', h);
  }
});
