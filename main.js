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

const { app, BrowserWindow, ipcMain, desktopCapturer, screen, clipboard, systemPreferences, shell } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const WebSocket = require('ws');

// ============ 配置文件（读写 WS 地址、clientId 等） ============
const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch (e) {
    return {};
  }
}

function saveConfig(cfg) {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf-8');
  } catch (e) {
    console.error('[CFG] 保存配置失败:', e.message);
  }
}

function getSavedWsUrl() {
  return loadConfig().wsUrl || null;
}

function setSavedWsUrl(url) {
  const cfg = loadConfig();
  cfg.wsUrl = url;
  saveConfig(cfg);
  console.log('[CFG] 已保存 WS 地址:', url);
}

// ============ 稳定 clientId 生成 ============
// 基于 hostname + userData 路径生成稳定 ID，保证同一设备每次相同
function generateStableClientId() {
  const cfg = loadConfig();
  if (cfg.stableClientId) {
    return cfg.stableClientId;
  }
  // 首次生成：基于 hostname 和 app userData 路径生成
  const seed = `${os.hostname()}|${app.getPath('userData')}`;
  const hash = crypto.createHash('sha256').update(seed).digest('hex');
  const id = hash.substring(0, 20);  // 20字符足够唯一
  
  // 保存到配置
  cfg.stableClientId = id;
  saveConfig(cfg);
  console.log('[CFG] 生成并保存 stableClientId:', id);
  return id;
}

function getStableClientId() {
  return generateStableClientId();
}

// 保存服务器返回的设备代码和密码到本地（用于显示和记忆）
function saveDeviceInfoLocal(deviceCode, password) {
  const cfg = loadConfig();
  cfg.deviceCode = deviceCode;
  cfg.password = password;
  saveConfig(cfg);
}

function getSavedDeviceInfo() {
  const cfg = loadConfig();
  return {
    deviceCode: cfg.deviceCode || '',
    password: cfg.password || ''
  };
}

// ============ 服务器地址 ============
let currentWsUrl = null;   // 当前使用的 WS 地址（从配置或用户输入）
let SERVER_URLS = [];      // 候选地址列表

function buildServerUrls() {
  const saved = getSavedWsUrl();
  const urls = [];
  if (saved) urls.push(saved);
  if (process.env.RELAY_URL) urls.push(process.env.RELAY_URL);
  urls.push('ws://127.0.0.1:3001');
  urls.push('ws://localhost:3001');
  // 去重
  return [...new Set(urls)];
}

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
function createMainWindow(page) {
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

  if (page === 'setup') {
    const saved = getSavedWsUrl();
    const mode = saved ? 'expired' : 'first';
    mainWindow.loadFile('setup.html', { query: { mode } });
  } else {
    mainWindow.loadFile('index.html');
  }

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
  
  // 窗口加载完成后通知被控端开始推屏
  controlWindow.webContents.once('did-finish-load', () => {
    console.log('[Control] 控制窗口已加载完成，请求被控端开始推屏');
    // 如果是主控端，请求被控端推屏
    if (myRole === 'controller' && sessionId) {
      sendToPeer({ type: 'screen-start' });
    }
  });
  
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
  const baseUrl = SERVER_URLS[serverUrlIndex];
  // 在 URL 后追加 clientId 参数
  const stableClientId = getStableClientId();
  const sep = baseUrl.includes('?') ? '&' : '?';
  const url = `${baseUrl}${sep}clientId=${encodeURIComponent(stableClientId)}`;
  console.log('[WS] 尝试连接:', baseUrl, '(clientId:', stableClientId + ')', `${serverUrlIndex + 1}/${SERVER_URLS.length}`);

  let sock;
  try {
    const wsOpts = { timeout: 5000 };
    if (url.startsWith('wss://')) {
      wsOpts.rejectUnauthorized = false;
    }
    sock = new WebSocket(url, wsOpts);
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

      // 保存设备信息到本地配置
      saveDeviceInfoLocal(myDeviceCode, myPassword);

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
      
      // 注意：screen-start 将在控制窗口加载完成后发送（在 createControlWindow 的 did-finish-load 中）
      // 这样可以确保控制窗口已经准备好接收屏幕帧

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
  captureFailCount = 0;
  captureWarningShown = false;
  captureFrameCount = 0;
  lastCaptureTime = 0;
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
  console.log('[APP] 会话已清理, 原因:', disconnected ? '断开' : '正常结束');
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
        const frameSize = payload.image ? (payload.image.length * 3 / 4 / 1024).toFixed(1) : 0;
        controlWindow.webContents.send('screen-frame', {
          image: payload.image,
          width: payload.width,
          height: payload.height
        });
        // 每5秒打印一次接收状态
        if (!handlePeerMessage._frameLogTime || Date.now() - handlePeerMessage._frameLogTime >= 5000) {
          console.log(`[Controller] 收到屏幕帧: ${frameSize}KB, ${payload.width}x${payload.height}`);
          handlePeerMessage._frameLogTime = Date.now();
        }
      } else if (myRole === 'controller') {
        console.warn('[Controller] 收到屏幕帧但控制窗口不存在！');
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
let captureFailCount = 0;
let captureWarningShown = false;
let captureFrameCount = 0;
let lastCaptureTime = 0;

function checkScreenRecordPermission() {
  // macOS: 检查屏幕录制权限
  if (process.platform === 'darwin') {
    try {
      if (systemPreferences && systemPreferences.getMediaAccessStatus) {
        const status = systemPreferences.getMediaAccessStatus('screen');
        console.log('[Capture] 屏幕录制权限状态:', status);
        return status === 'granted';
      }
    } catch (e) {
      console.warn('[Capture] 无法检查权限状态:', e.message);
    }
  }
  return true; // 非 macOS 默认允许
}

function openScreenRecordSettings() {
  if (process.platform === 'darwin') {
    // macOS 直接打开系统设置的屏幕录制页面
    try {
      shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
    } catch (e) {
      console.warn('[Capture] 无法打开系统设置:', e.message);
    }
  }
}

function notifyCaptureStatus(status) {
  if (mainWindow) {
    mainWindow.webContents.send('capture-status', status);
  }
}

function startScreenCapture() {
  if (captureTimer) return;
  console.log('[Capture] 开始屏幕捕获');
  console.log('[Capture] 当前状态 - sessionId:', !!sessionId, 'role:', myRole);

  // 检查权限
  const hasPermission = checkScreenRecordPermission();
  if (!hasPermission) {
    console.warn('[Capture] 屏幕录制权限未授予！');
    notifyCaptureStatus({ ok: false, reason: 'no-permission', message: '屏幕录制权限未授予，请前往系统设置开启' });
    captureWarningShown = true;
  }

  // 获取屏幕尺寸信息
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.workAreaSize;
  console.log(`[Capture] 屏幕分辨率: ${width}x${height}`);

  // 使用更合理的缩略图尺寸 - 按比例缩放到合适大小
  // 目标宽度不超过 1280px，保持宽高比
  let thumbWidth = Math.floor(width * 0.5);
  let thumbHeight = Math.floor(height * 0.5);
  const MAX_WIDTH = 1280;
  if (thumbWidth > MAX_WIDTH) {
    const ratio = MAX_WIDTH / thumbWidth;
    thumbWidth = MAX_WIDTH;
    thumbHeight = Math.floor(thumbHeight * ratio);
  }
  console.log(`[Capture] 缩略图尺寸: ${thumbWidth}x${thumbHeight}`);

  const captureOnce = async () => {
    if (!sessionId || myRole !== 'controlled') {
      console.log('[Capture] 停止捕获: sessionId存在=', !!sessionId, 'role=', myRole);
      stopScreenCapture();
      return;
    }
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: {
          width: thumbWidth,
          height: thumbHeight
        }
      });

      if (sources.length > 0 && sources[0].thumbnail) {
        captureFailCount = 0;
        const thumb = sources[0].thumbnail;
        const jpeg = thumb.toJPEG(50); // 降低质量到50以减小体积
        const base64 = jpeg.toString('base64');
        const sizeKB = (base64.length * 3 / 4 / 1024).toFixed(1);
        
        // 发送屏幕帧
        const sent = sendToPeer({
          type: 'screen-frame',
          image: base64,
          width: thumb.getWidth(),
          height: thumb.getHeight()
        });
        
        captureFrameCount++;
        const now = Date.now();
        if (now - lastCaptureTime >= 5000) { // 每5秒打印一次状态
          console.log(`[Capture] 已发送 ${captureFrameCount} 帧, 最近帧大小: ${sizeKB}KB, 发送成功: ${sent}`);
          lastCaptureTime = now;
        }
        
        // 首次成功捕获，通知UI权限OK
        if (captureWarningShown) {
          notifyCaptureStatus({ ok: true });
          captureWarningShown = false;
        }
      } else {
        // 无可用屏幕源 - 可能是权限问题
        captureFailCount++;
        if (captureFailCount <= 3 || captureFailCount % 10 === 0) {
          console.warn(`[Capture] 无屏幕源可用 (连续${captureFailCount}次)`);
        }
        if (captureFailCount >= 3 && !captureWarningShown) {
          console.warn('[Capture] 检测到屏幕捕获失败，可能是权限问题');
          notifyCaptureStatus({
            ok: false,
            reason: 'no-sources',
            message: '无法捕获屏幕画面，请检查屏幕录制权限'
          });
          captureWarningShown = true;
        }
      }
    } catch (e) {
      captureFailCount++;
      if (captureFailCount <= 3 || captureFailCount % 10 === 0) {
        console.error('[Capture] 错误:', e.message);
      }
      if (captureFailCount >= 3 && !captureWarningShown) {
        notifyCaptureStatus({
          ok: false,
          reason: 'error',
          message: '屏幕捕获出错: ' + e.message
        });
        captureWarningShown = true;
      }
    }
  };

  captureOnce();
  captureTimer = setInterval(captureOnce, CAPTURE_INTERVAL);
  console.log('[Capture] 捕获定时器已启动, 间隔:', CAPTURE_INTERVAL, 'ms');
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
ipcMain.handle('get-device-info', () => {
  // 优先用全局变量（服务器连接成功后会更新），否则用本地保存的
  let code = myDeviceCode;
  let pwd = myPassword;
  if (!code || !pwd) {
    const saved = getSavedDeviceInfo();
    if (saved.deviceCode) code = saved.deviceCode;
    if (saved.password) pwd = saved.password;
  }
  return {
    deviceCode: code,
    password: pwd,
    serverConnected,
    session: sessionId ? { role: myRole, peerCode } : null
  };
});

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
  captureFailCount = 0;
  captureWarningShown = false;
  return true;
});

// 打开屏幕录制权限设置（macOS）
ipcMain.handle('open-screen-record-settings', () => {
  openScreenRecordSettings();
  return true;
});

// ==================== IPC：WS 地址管理 ====================
// 校验 WS 地址是否可连通
ipcMain.handle('validate-ws-url', async (_e, { url }) => {
  const trimmed = (url || '').trim();
  if (!trimmed) return { success: false, message: '地址不能为空' };
  if (!trimmed.match(/^wss?:\/\/.+/)) {
    return { success: false, message: '地址需以 ws:// 或 wss:// 开头' };
  }
  console.log('[APP] 校验 WS 地址:', trimmed);
  const result = await validateWsUrl(trimmed);
  console.log('[APP] 校验结果:', result.success ? '成功' : '失败 - ' + result.message);
  return result;
});

// 保存 WS 地址到配置文件
ipcMain.handle('save-ws-url', (_e, { url }) => {
  const trimmed = (url || '').trim();
  setSavedWsUrl(trimmed);
  currentWsUrl = trimmed;
  SERVER_URLS = buildServerUrls();
  return { success: true };
});

// 获取当前保存的 WS 地址
ipcMain.handle('get-ws-url', () => {
  return getSavedWsUrl();
});

// 从 setup 页面确认后，进入首页
ipcMain.handle('goto-home', () => {
  // 断开旧连接
  if (ws) { try { ws.close(); } catch (e) {} }
  serverConnected = false;
  serverUrlIndex = 0;
  SERVER_URLS = buildServerUrls();  // 确保用最新保存的地址
  // 重新加载首页
  if (mainWindow) {
    mainWindow.loadFile('index.html');
  }
  // 延迟一点等页面加载完
  setTimeout(() => connectServer(), 500);
  return true;
});

// 从首页点击修改按钮，跳转到 setup 页面
ipcMain.handle('goto-setup', () => {
  // 断开当前连接
  if (ws) { try { ws.close(); } catch (e) {} }
  serverConnected = false;
  if (mainWindow) {
    mainWindow.loadFile('setup.html', { query: { mode: 'modify' } });
  }
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

// ==================== WS 地址校验 ====================
function validateWsUrl(url) {
  return new Promise((resolve) => {
    if (!url || !url.match(/^wss?:\/\/.+/)) {
      resolve({ success: false, message: '地址格式无效' });
      return;
    }
    let done = false;
    const opts = { timeout: 6000 };
    if (url.startsWith('wss://')) opts.rejectUnauthorized = false;

    let sock;
    try {
      sock = new WebSocket(url, opts);
    } catch (e) {
      resolve({ success: false, message: e.message });
      return;
    }

    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        try { sock.terminate(); } catch (e) {}
        resolve({ success: false, message: '连接超时' });
      }
    }, 6500);

    sock.on('open', () => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        try { sock.close(); } catch (e) {}
        resolve({ success: true });
      }
    });

    sock.on('error', (err) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve({ success: false, message: err.message || '连接失败' });
      }
    });
  });
}

// ==================== Electron 生命周期 ====================
app.whenReady().then(async () => {
  getWinRobot();

  const savedUrl = getSavedWsUrl();
  if (!savedUrl) {
    // 首次进入：跳转到 setup 页面
    console.log('[APP] 首次使用，跳转到服务器设置页面');
    createMainWindow('setup');
  } else {
    // 非首次：先校验保存的地址
    console.log('[APP] 校验保存的 WS 地址:', savedUrl);
    const result = await validateWsUrl(savedUrl);
    if (result.success) {
      // 地址有效，直接进入首页
      currentWsUrl = savedUrl;
      SERVER_URLS = buildServerUrls();
      createMainWindow('home');
      connectServer();
    } else {
      // 地址失效，跳转到 setup 页面
      console.log('[APP] 保存的 WS 地址已失效:', result.message);
      createMainWindow('setup');
    }
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const saved = getSavedWsUrl();
      createMainWindow(saved ? 'home' : 'setup');
      if (saved) connectServer();
    }
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
