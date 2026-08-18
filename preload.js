/**
 * Electron Preload 脚本 - P2P 版
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('remoteAPI', {
  // P2P 状态
  getP2pStatus: () => ipcRenderer.invoke('get-p2p-status'),

  // 发送远程命令
  sendCommand: (command, params) =>
    ipcRenderer.invoke('send-command', { command, params }),

  // 剪贴板同步
  syncClipboard: (content) =>
    ipcRenderer.invoke('sync-clipboard', { content }),

  // 断开
  disconnect: () => ipcRenderer.invoke('disconnect'),

  // 事件监听
  onP2pStatus: (callback) => {
    const handler = (_e, data) => callback(data.connected);
    ipcRenderer.on('p2p-status', handler);
    return () => ipcRenderer.removeListener('p2p-status', handler);
  },
  onScreenFrame: (callback) => {
    const handler = (_e, data) => callback(data);
    ipcRenderer.on('screen-frame', handler);
    return () => ipcRenderer.removeListener('screen-frame', handler);
  },
  onSessionEnded: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('session-ended', handler);
    return () => ipcRenderer.removeListener('session-ended', handler);
  }
});
