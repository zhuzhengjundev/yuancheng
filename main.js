/**
 * Electron 主进程 - 公共服务器 + 设备代码/密码模式
 *
 * 工作模式：
 *   - 客户端启动即连接公共中继服务器（WS）
 *   - 服务器下发 9 位设备代码 + 6 位密码（显示在 UI 上）
 *   - 用户输入对方设备代码 + 密码 → 向服务器发起 connect-device
 *   - 服务端验证后建立 session，之后所有消息（屏幕帧 / 键鼠 / 剪贴板）
 *     均通过 to-peer / from-peer 进行转发
 *   - 主控端：打开控制窗口，接收屏幕帧、发送键鼠命令
 *   - 被控端：开始推屏幕，收到命令后通过 win-robot 执行
 */

const { app, BrowserWindow, ipcMain, desktopCapturer, screen, clipboard } = require('electron');
const path = require('path');
const os = require('os');
const WebSocket = require('ws');

// ============ 服务器地址 ============
// 优先环境变量，否则使用用户指定的公共服务器
const SERVER_URLS = [
  process.env.RELAY_URL,
  'ws://172.21.22.244:3001',
  'ws://127.0.0.1:3001',
  'ws://localhost:3001'
].filter(Boolean);

// ============ 全局状态 ============
let mainWindow = null;
let controlWindow = null;  // 主控端窗口（显示对方桌面）

let ws = null;
let serverConnected = false;
let reconnectTimer = null;
let serverUrlIndex = 0;

// 本机信息
let myDeviceCode = '';
let myPassword = '';
let myClientId = '';

// 会话
let sessionId = null;
let myRole = null;       // 'controller' | 'controlled'
let peerCode = null;

// 屏幕捕获
let captureTimer = null;
const CAPTURE_INTERVAL = 150;

// ==================== 窗口 ====================
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 480,
    height: 820,
    resizable: false,
    maximizable: false,
    title: '远程控制',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile('index.html');

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createControlWindow() {
  if (controlWindow) {
    controlWindow.focus();
    return;
  }
  controlWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: '远程控制 - 对方桌面',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  controlWindow.setMenuBarVisibility(false);
  controlWindow.loadFile('control.html');
  controlWindow.on('closed', () => {
    // 主控关闭窗口 -> 结束会话
    if (myRole === 'controller') {
      sendToServer({ type: 'disconnect' });
      stopScreenCapture();
    }
    controlWindow = null;
  });
}

// ==================== 服务器连接 ====================
function connectServer() {
  if (serverConnected) return;
  if (serverUrlIndex >= SERVER_URLS.length) {
    serverUrlIndex = 0;
    scheduleReconnect(4000);
    return;
  }
  const url = SERVER_URLS[serverUrlIndex];
  console.log('[WS] 尝试连接:', url, `${serverUrlIndex + 1}/${SERVER_URLS.length}`);

  let sock;
  try {
    sock = new WebSocket(url, { timeout: 5000 });
  } catch (e) {
    serverUrlIndex++;
    scheduleReconnect(500);
    return;
  }

  let opened = false;
  const failTimer = setTimeout(() => {
    if (!opened) try { sock.terminate(); } catch (e) {}
  }, 5500);

  sock.on('open', () => {
    opened = true;
    clearTimeout(failTimer);
    serverUrlIndex = 0;
    ws = sock;
    serverConnected = true;
    console.log('[WS] 已连接服务器');
    notifyMainStatus();
  });

  sock.on('message', (raw) => {
    let data;
    try { data = JSON.parse(raw.toString()); } catch (e) { return; }
    handleServerMessage(data);
  });

  sock.on('error', () => {
    clearTimeout(failTimer);
    if (!opened) {
      serverUrlIndex++;
      scheduleReconnect(500);
    }
  });

  sock.on('close', () => {
    clearTimeout(failTimer);
    console.log('[WS] 与服务器断开');
    serverConnected = false;
    ws = null;
    // 会话级清理
    if (sessionId) {
      cleanupSession(true);
    }
    notifyMainStatus();
    if (!opened) {
      serverUrlIndex++;
      scheduleReconnect(500);
    } else {
      scheduleReconnect(3000);
    }
  });
}

function scheduleReconnect(delay = 3000) {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectServer();
  }, delay);
}

function sendToServer(data) {
  if (ws && serverConnected && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
    return true;
  }
  return false;
}

// 向对端发送（走服务器转发）
function sendToPeer(payload) {
  if (!sessionId) return false;
  return sendToServer({ type: 'to-peer', payload });
}

// ==================== 服务端消息处理 ====================
function handleServerMessage(data) {
  switch (data.type) {
    case 'device-info': {
      // 本机设备代码 + 密码（首次分配或刷新密码后）
      myDeviceCode = data.deviceCode || '';
      myPassword = data.password || '';
      myClientId = data.clientId || myClientId;
      console.log(`[APP] 本机: 设备代码=${formatCode(myDeviceCode)}  密码=${myPassword}`);

      // 向服务器上报 hostname（便于管理面板识别设备名）
      const hostName = os.hostname();
      sendToServer({ type: 'register-device-name', hostname: hostName });

      notifyDeviceInfo();
      notifyMainStatus();
      break;
    }

    case 'ping': {
      sendToServer({ type: 'pong' });
      break;
    }

    case 'connect-error': {
      if (mainWindow) {
        mainWindow.webContents.send('connect-error', data.message || '连接失败');
      }
      break;
    }

    case 'connected': {
      // 主控端 -> 会话建立（我是 controller，开始打开 control window，让对方推屏幕）
      sessionId = data.sessionId;
      myRole = data.role;
      peerCode = data.peerCode;
      console.log(`[APP] 会话建立，我是主控，对方=${formatCode(peerCode)}`);

      if (!controlWindow) createControlWindow();

      // 请求被控端开始推屏
      sendToPeer({ type: 'screen-start' });

      notifyMainStatus();
      if (mainWindow) {
        mainWindow.webContents.send('connect-ok', {
          role: myRole,
          peerCode,
          sessionId
        });
      }
      break;
    }

    case 'incoming-control': {
      // 被控端 -> 有人控制我
      sessionId = data.sessionId;
      myRole = data.role;
      peerCode = data.peerCode;
      console.log(`[APP] 被控制请求，来自=${formatCode(peerCode)}`);

      // 自动接受并开始推屏
      startScreenCapture();
      sendToServer({ type: 'accept-control' });

      notifyMainStatus();
      if (mainWindow) {
        mainWindow.webContents.send('incoming-control', {
          role: myRole,
          peerCode,
          sessionId
        });
      }
      break;
    }

    case 'session-ended': {
      console.log('[APP] 会话结束');
      cleanupSession(false);
      notifyMainStatus();
      break;
    }

    case 'from-peer': {
      handlePeerMessage(data.payload, data.fromRole);
      break;
    }

    case 'error':
      console.error('[WS] 服务端错误:', data.message);
      break;
  }
}

function cleanupSession(disconnected) {
  stopScreenCapture();
  if (controlWindow) {
    controlWindow.webContents.send('session-ended');
    // 主控端关闭窗口；被控端不关闭（它可能没打开）
    if (myRole === 'controller') {
      try { controlWindow.close(); } catch (e) {}
    }
    controlWindow = null;
  }
  sessionId = null;
  myRole = null;
  peerCode = null;
  notifyMainStatus();
}

// ==================== 对端消息处理 ====================
function handlePeerMessage(payload, fromRole) {
  if (!payload || typeof payload !== 'object') return;
  switch (payload.type) {
    case 'screen-start': {
      // 主控让我（被控）开始推屏
      if (myRole === 'controlled') {
        startScreenCapture();
      }
      break;
    }
    case 'screen-stop': {
      stopScreenCapture();
      break;
    }
    case 'screen-frame': {
      // 推给控制窗口渲染
      if (controlWindow && myRole === 'controller') {
        controlWindow.webContents.send('screen-frame', {
          image: payload.image,
          width: payload.width,
          height: payload.height
        });
      }
      break;
    }
    case 'remote-command': {
      // 来自主控的键鼠命令 —— 只有被控执行
      if (myRole === 'controlled') {
        handleRemoteCommand(payload.command, payload.params || {});
      }
      break;
    }
    case 'clipboard-sync': {
      try {
        if (payload.content !== clipboard.readText()) {
          clipboard.writeText(payload.content);
        }
      } catch (e) {}
      break;
    }
    case 'get-clipboard': {
      const content = clipboard.readText();
      sendToPeer({ type: 'clipboard-result', content });
      break;
    }
    case 'clipboard-result': {
      try { clipboard.writeText(payload.content); } catch (e) {}
      break;
    }
  }
}

// ==================== 屏幕捕获（被控端推流） ====================
function startScreenCapture() {
  if (captureTimer) return;
  console.log('[Capture] 开始屏幕捕获');

  const captureOnce = async () => {
    if (!sessionId || myRole !== 'controlled') {
      stopScreenCapture();
      return;
    }
    try {
      const primaryDisplay = screen.getPrimaryDisplay();
      const { width, height } = primaryDisplay.workAreaSize;

      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: {
          width: Math.floor(width * 0.7),
          height: Math.floor(height * 0.7)
        }
      });

      if (sources.length > 0) {
        const thumb = sources[0].thumbnail;
        const jpeg = thumb.toJPEG(65);
        sendToPeer({
          type: 'screen-frame',
          image: jpeg.toString('base64'),
          width: thumb.getWidth(),
          height: thumb.getHeight()
        });
      }
    } catch (e) {
      console.error('[Capture] 错误:', e.message);
    }
  };

  captureOnce();
  captureTimer = setInterval(captureOnce, CAPTURE_INTERVAL);
}

function stopScreenCapture() {
  if (captureTimer) {
    clearInterval(captureTimer);
    captureTimer = null;
  }
}

// ==================== 键鼠控制（被控端执行） ====================
let _winRobot = null;
function getWinRobot() {
  if (_winRobot) return _winRobot;
  try {
    _winRobot = require('./win-robot');
    _winRobot.init().catch(e => console.warn('[Robot] init err:', e.message));
  } catch (e) {
    console.error('[Robot] 加载失败:', e.message);
    _winRobot = null;
  }
  return _winRobot;
}

async function handleRemoteCommand(command, params) {
  if (command === 'set-clipboard') {
    if (params.content != null) {
      try { clipboard.writeText(String(params.content)); } catch (e) {}
    }
    return;
  }
  if (command === 'get-clipboard') {
    try { sendToPeer({ type: 'clipboard-result', content: clipboard.readText() }); } catch (e) {}
    return;
  }
  const r = getWinRobot();
  if (!r) return;
  try {
    switch (command) {
      case 'mouse-move':   await r.moveMouse(params.x || 0, params.y || 0); break;
      case 'mouse-click':  await r.mouseClick(params.x || 0, params.y || 0, params.button || 'left', !!params.double); break;
      case 'mouse-down':   await r.mouseDown(params.x || 0, params.y || 0, params.button || 'left'); break;
      case 'mouse-up':     await r.mouseUp(params.button || 'left'); break;
      case 'mouse-scroll': await r.scrollMouse(params.dx || 0, params.dy || 0); break;
      case 'key-down':     if (params.key) await r.keyDown(params.key); break;
      case 'key-up':       if (params.key) await r.keyUp(params.key); break;
      case 'key-tap':      if (params.key) await r.keyTap(params.key, params.modifiers || []); break;
      case 'type-string':  if (params.string) await r.typeString(params.string); break;
    }
  } catch (e) {
    console.error('[Robot] 命令失败:', command, e.message);
  }
}

// ==================== IPC 通信（渲染进程） ====================
ipcMain.handle('get-device-info', () => ({
  deviceCode: myDeviceCode,
  password: myPassword,
  serverConnected,
  session: sessionId ? { role: myRole, peerCode } : null
}));

ipcMain.handle('refresh-password', () => {
  return sendToServer({ type: 'refresh-password' });
});

ipcMain.handle('connect-device', (_e, { targetCode, targetPassword }) => {
  return sendToServer({
    type: 'connect-device',
    targetCode: (targetCode || '').toString().replace(/\s/g, ''),
    targetPassword: (targetPassword || '').toString()
  });
});

ipcMain.handle('disconnect', () => {
  sendToServer({ type: 'disconnect' });
  cleanupSession(false);
  return true;
});

// 从 control window 发出的键鼠命令（主控 -> 被控）
ipcMain.handle('send-command', (_e, { command, params }) => {
  if (!sessionId) return { success: false };
  sendToPeer({ type: 'remote-command', command, params });
  return { success: true };
});

ipcMain.handle('sync-clipboard', (_e, { content }) => {
  try { clipboard.writeText(content); } catch (e) {}
  sendToPeer({ type: 'clipboard-sync', content });
  return { success: true };
});

// ==================== 状态通知 ====================
function notifyDeviceInfo() {
  if (mainWindow) {
    mainWindow.webContents.send('device-info', {
      deviceCode: myDeviceCode,
      password: myPassword
    });
  }
}

function notifyMainStatus() {
  if (mainWindow) {
    mainWindow.webContents.send('app-status', {
      serverConnected,
      deviceCode: myDeviceCode,
      password: myPassword,
      session: sessionId ? { role: myRole, peerCode, sessionId } : null
    });
  }
}

function formatCode(code) {
  if (!code || code.length !== 9) return code;
  return code.slice(0, 3) + ' ' + code.slice(3, 6) + ' ' + code.slice(6);
}

// ==================== Electron 生命周期 ====================
app.whenReady().then(() => {
  getWinRobot();
  createMainWindow();
  connectServer();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  stopScreenCapture();
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (ws) { try { ws.close(); } catch (e) {} }
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  stopScreenCapture();
});
