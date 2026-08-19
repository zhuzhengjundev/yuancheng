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

// ============ 全局错误捕获（写入日志文件，排查白屏用） ============
const diagLogPath = require('path').join(require('os').tmpdir(), 'remotecontrol-crash.log');
function logCrash(msg) {
  try {
    const fs = require('fs');
    const ts = new Date().toISOString();
    fs.appendFileSync(diagLogPath, `[${ts}] ${msg}\n`);
    console.error('[CRASH-LOG]', msg);
  } catch (_) {}
}
process.on('uncaughtException', (e) => {
  logCrash('uncaughtException: ' + e.message + '\n' + e.stack);
});
process.on('unhandledRejection', (e) => {
  logCrash('unhandledRejection: ' + (e ? (e.message || String(e)) : 'unknown'));
});
logCrash('主进程开始加载...');

const { app, BrowserWindow, ipcMain, desktopCapturer, screen, clipboard, systemPreferences, shell } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const WebSocket = require('ws');

// 禁用硬件加速（解决 Windows 白屏/GPU 崩溃问题）
app.disableHardwareAcceleration();
logCrash('硬件加速已禁用');

logCrash('Electron 模块已加载');

// ============ 配置文件（读写 WS 地址、clientId 等） ============
// 注意：app.getPath('userData') 在 app ready 前调用可能返回空路径
let CONFIG_PATH = '';

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
let frameEverReceived = false; // 主控端是否曾收到过帧
let diagStats = { framesReceived: 0, emptyFrames: 0, framesSizeKB: '0.0', headersSent: 0, chunksSent: 0, lastFrameTime: 0 }; // 主控端链路诊断
let lastCaptureSizeKB = '0.0'; // 被控端最近一帧大小
let remoteCmdReceived = 0;     // 被控端收到的键鼠命令数
let lastCaptureError = '';    // 被控端最近一次捕获失败详情
let captureSendFailCount = 0;  // 被控端帧发送失败计数
let captureSendFailLog = 0;    // 发送失败日志限频
let robotLoadError = '';      // 被控端 win-robot 加载错误详情
let _winRobot = null;        // 键鼠控制模块（提前声明避免 TDZ 白屏）

// 诊断推送：把主进程状态实时显示到界面上（打包后无控制台，排查全靠这个）
setInterval(() => {
  try {
    if (myRole === 'controller' && controlWindow && !controlWindow.isDestroyed()) {
      controlWindow.webContents.send('diag-stats', diagStats);
    }
    if (myRole === 'controlled' && sessionId && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('capture-stats', {
        frames: captureFrameCount,
        fails: captureFailCount,
        running: captureTimer != null,
        lastSizeKB: lastCaptureSizeKB,
        error: lastCaptureError
      });
      const r = _winRobot;
      mainWindow.webContents.send('robot-status', {
        loaded: !!r,
        ready: !!(r && r.isReady && r.isReady()),
        cmds: remoteCmdReceived,
        error: robotLoadError
      });
    }
  } catch (e) {}
}, 1000);

// 屏幕捕获
let captureTimer = null;
const CAPTURE_INTERVAL = 150;
let captureFrameCount = 0;
let captureFailCount = 0;

// ==================== 窗口 ====================
function createMainWindow(page) {
  logCrash('createMainWindow: ' + page);
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
  
  // 渲染进程 console 转发到日志（排查白屏）
  mainWindow.webContents.on('console-message', (_level, msg, line, source) => {
    logCrash(`[Renderer] ${msg} (${source}:${line})`);
  });
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    logCrash(`渲染进程崩溃: ${details.reason}`);
  });
  
  // 强制打开 DevTools（排查白屏用）
  mainWindow.webContents.once('did-finish-load', () => {
    logCrash('主窗口加载完成: ' + page);
    logCrash('准备打开 DevTools...');
    try {
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    } catch (e) {
      logCrash('打开 DevTools 失败: ' + e.message);
    }
  });
  mainWindow.webContents.on('did-fail-load', (_e, code, desc) => {
    logCrash('主窗口加载失败: ' + code + ' ' + desc);
  });

  if (page === 'setup') {
    const saved = getSavedWsUrl();
    const mode = saved ? 'expired' : 'first';
    logCrash('加载 setup.html, mode=' + mode);
    mainWindow.loadFile('setup.html', { query: { mode } });
  } else {
    logCrash('加载 index.html');
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
  console.log('[Control] 创建控制窗口...');
  frameEverReceived = false;
  
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

  // 强制支持 F12 / Ctrl+Shift+I 打开开发者工具（菜单栏隐藏后系统快捷键会失效）
  controlWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown') {
      if (input.key === 'F12' ||
          (input.control && input.shift && (input.key.toLowerCase() === 'i' || input.key.toLowerCase() === 'j'))) {
        controlWindow.webContents.toggleDevTools();
        event.preventDefault();
      }
      // Ctrl+R 刷新（调试用）
      if (input.control && input.key.toLowerCase() === 'r') {
        controlWindow.webContents.reload();
        event.preventDefault();
      }
    }
  });
  
  // 窗口加载完成后通知被控端开始推屏
  controlWindow.webContents.once('did-finish-load', () => {
    console.log('[Control] 控制窗口已加载完成 (did-finish-load)');
    // 延迟一点时间确保渲染进程完全就绪
    setTimeout(() => {
      console.log('[Control] 请求被控端开始推屏...');
      if (myRole === 'controller' && sessionId) {
        const sent = sendToPeer({ type: 'screen-start' });
        console.log('[Control] screen-start 发送结果:', sent ? '成功' : '失败');
      } else {
        console.warn('[Control] 无法发送 screen-start: myRole=' + myRole + ', sessionId=' + !!sessionId);
      }
      
      // 重试机制：如果2秒内没有收到帧，重新请求
      setTimeout(() => {
        if (!frameEverReceived && controlWindow) {
          console.warn('[Control] 2秒内未收到任何帧，重新请求 screen-start...');
          sendToPeer({ type: 'screen-start' });
        }
      }, 2000);
      
      setTimeout(() => {
        if (!frameEverReceived && controlWindow) {
          console.warn('[Control] 5秒内仍未收到帧，再次请求...');
          sendToPeer({ type: 'screen-start' });
        }
      }, 5000);
    }, 500);
  });
  
  // 处理加载失败
  controlWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    console.error('[Control] 控制窗口加载失败:', errorCode, errorDescription);
  });
  
  controlWindow.on('closed', () => {
    console.log('[Control] 控制窗口已关闭');
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
    
    // 处理服务端分块转发消息（__server_chunked）
    if (data && data.__server_chunked) {
      handleServerChunkedMessage(data);
      return;
    }
    
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

// 分块传输：避免隧道服务截断大消息
const WS_MAX_CHUNK = 12 * 1024; // 12KB 每块（隧道服务通常限制~32KB）
let wsChunkCounter = 0;

function sendToServer(data) {
  if (!ws || serverConnected !== true || ws.readyState !== WebSocket.OPEN) {
    if (!ws || !serverConnected) return false;
  }
  
  try {
    const json = JSON.stringify(data);
    
    // 小消息直接发送
    if (json.length <= WS_MAX_CHUNK) {
      ws.send(json);
      return true;
    }
    
    // 大消息分块发送
    const msgId = ++wsChunkCounter;
    const totalChunks = Math.ceil(json.length / WS_MAX_CHUNK);
    const originalType = data.type || 'unknown';
    
    // 发送起始标记
    ws.send(JSON.stringify({
      __chunked: true,
      phase: 'start',
      msgId,
      totalChunks,
      originalType
    }));
    
    // 发送数据块
    for (let i = 0; i < totalChunks; i++) {
      const start = i * WS_MAX_CHUNK;
      const end = Math.min(start + WS_MAX_CHUNK, json.length);
      ws.send(JSON.stringify({
        __chunked: true,
        phase: 'data',
        msgId,
        chunkIndex: i,
        data: json.substring(start, end)
      }));
    }
    
    // 发送结束标记
    ws.send(JSON.stringify({
      __chunked: true,
      phase: 'end',
      msgId
    }));
    
    if (!sendToServer._chunkLog || Date.now() - sendToServer._chunkLog >= 5000) {
      console.log(`[WS] 分块发送: ${originalType}, ${totalChunks}块, 总${(json.length/1024).toFixed(1)}KB`);
      sendToServer._chunkLog = Date.now();
    }
    return true;
  } catch (e) {
    console.error('[WS] sendToServer 错误:', e.message);
    return false;
  }
}

// 向对端发送（走服务器转发）
function sendToPeer(payload) {
  if (!sessionId) return false;
  return sendToServer({ type: 'to-peer', payload });
}

// ==================== 服务端分块消息重组 ====================
const serverChunkBuffers = new Map(); // msgId -> { chunks, totalChunks, originalType }

function handleServerChunkedMessage(data) {
  if (data.phase === 'start') {
    serverChunkBuffers.set(data.msgId, {
      chunks: new Array(data.totalChunks),
      totalChunks: data.totalChunks,
      originalType: data.originalType
    });
    return;
  }
  
  if (data.phase === 'data') {
    const buf = serverChunkBuffers.get(data.msgId);
    if (buf) {
      buf.chunks[data.chunkIndex] = data.data;
    }
    return;
  }
  
  if (data.phase === 'end') {
    const buf = serverChunkBuffers.get(data.msgId);
    if (!buf) return;
    
    // 检查是否收齐
    const receivedCount = buf.chunks.filter(c => c !== undefined).length;
    if (receivedCount < buf.totalChunks) {
      console.warn(`[WS-CLIENT] 服务端分块消息不完整: ${receivedCount}/${buf.totalChunks}, type=${buf.originalType}`);
      serverChunkBuffers.delete(data.msgId);
      return;
    }
    
    // 重组
    let json = '';
    for (let i = 0; i < buf.totalChunks; i++) {
      json += buf.chunks[i];
    }
    serverChunkBuffers.delete(data.msgId);
    
    // 解析并处理
    try {
      const fullData = JSON.parse(json);
      if (!handleServerChunkedMessage._logTime || Date.now() - handleServerChunkedMessage._logTime >= 5000) {
        console.log(`[WS-CLIENT] 重组完成: ${buf.originalType}, ${buf.totalChunks}块, ${(json.length/1024).toFixed(1)}KB`);
        handleServerChunkedMessage._logTime = Date.now();
      }
      handleServerMessage(fullData);
    } catch (e) {
      console.error('[WS-CLIENT] 重组后JSON解析失败:', e.message);
    }
  }
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
      console.log(`[APP] ========== 会话建立 ==========`);
      console.log(`[APP] 会话ID: ${data.sessionId}`);
      console.log(`[APP] 角色: ${myRole}`);
      console.log(`[APP] 对方设备: ${formatCode(peerCode)}`);

      // 创建控制窗口（screen-start 将在窗口加载完成后发送）
      if (!controlWindow) {
        console.log('[APP] 创建控制窗口...');
        createControlWindow();
      } else {
        console.log('[APP] 控制窗口已存在，直接发送 screen-start');
        // 控制窗口已存在，直接发送 screen-start
        setTimeout(() => {
          if (myRole === 'controller' && sessionId) {
            const sent = sendToPeer({ type: 'screen-start' });
            console.log('[APP] screen-start 发送结果:', sent ? '成功' : '失败');
          }
        }, 300);
      }

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
      console.log(`[APP] ========== 被控制请求 ==========`);
      console.log(`[APP] 来自: ${formatCode(peerCode)}`);
      console.log(`[APP] 角色: ${myRole}`);
      console.log(`[APP] 会话ID: ${data.sessionId}`);

      // 自动接受并开始推屏
      console.log('[APP] 自动接受控制，开始推屏...');
      startScreenCapture();
      
      // 发送 accept-control 确认
      const acceptSent = sendToServer({ type: 'accept-control' });
      console.log('[APP] accept-control 发送结果:', acceptSent ? '成功' : '失败');

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
  lastCaptureError = '';
  captureSendFailCount = 0;
  remoteCmdReceived = 0;
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
  if (!payload || typeof payload !== 'object') {
    console.warn('[Peer] 收到无效payload:', payload);
    return;
  }
  
  // 记录所有收到的消息类型（调试用）
  if (!handlePeerMessage._msgLogTime || Date.now() - handlePeerMessage._msgLogTime >= 10000) {
    console.log(`[Peer] 收到消息: type=${payload.type}, fromRole=${fromRole}`);
    handlePeerMessage._msgLogTime = Date.now();
  }
  
  switch (payload.type) {
    case 'screen-start': {
      // 主控让我（被控）开始推屏
      console.log('[Peer] 收到 screen-start 请求');
      if (myRole === 'controlled') {
        startScreenCapture();
      } else {
        console.warn('[Peer] 收到 screen-start 但我不是被控端, myRole=', myRole);
      }
      break;
    }
    case 'screen-stop': {
      console.log('[Peer] 收到 screen-stop 请求');
      stopScreenCapture();
      break;
    }
    case 'screen-frame': {
      if (!payload.image) {
        diagStats.emptyFrames++;
        console.warn('[Peer] 收到空的 screen-frame（被控端捕获失败或权限问题）');
        break;
      }
      
      if (!controlWindow) {
        if (!handlePeerMessage._noWindowWarnTime || Date.now() - handlePeerMessage._noWindowWarnTime >= 5000) {
          console.warn('[Controller] 收到屏幕帧但控制窗口不存在！');
          handlePeerMessage._noWindowWarnTime = Date.now();
        }
        break;
      }
      
      if (myRole !== 'controller') break;
      
      // 标记已收到帧
      if (!frameEverReceived) {
        frameEverReceived = true;
        console.log('[Controller] ========== 首次收到屏幕帧 ==========');
      }
      
      const imageData = payload.image;

      // ====== 全部走分块 IPC 传输 ======
      // 完整大帧经 webContents.send 会被 Electron 静默截断，
      // 因此不分帧大小，统一拆成 8KB 块发送，由渲染进程重组
      const CHUNK_SIZE = 8192; // 每块 8KB
      const totalChunks = Math.ceil(imageData.length / CHUNK_SIZE);
      const frameId = Date.now() + '_' + Math.random().toString(36).substr(2, 9);

      // 先发送帧头信息（包含实际屏幕分辨率）
      controlWindow.webContents.send('screen-frame-header', {
        frameId,
        width: payload.width,
        height: payload.height,
        screenWidth: payload.screenWidth || payload.width,
        screenHeight: payload.screenHeight || payload.height,
        totalChunks,
        imageSize: imageData.length
      });

      // 分块发送
      for (let i = 0; i < totalChunks; i++) {
        const start = i * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, imageData.length);
        const chunk = imageData.substring(start, end);

        controlWindow.webContents.send('screen-frame-chunk', {
          frameId,
          chunkIndex: i,
          totalChunks,
          data: chunk
        });
      }
      
      // 主控端链路诊断统计（推送给控制窗口调试面板）
      diagStats.framesReceived++;
      diagStats.framesSizeKB = (imageData.length * 3 / 4 / 1024).toFixed(1);
      diagStats.headersSent++;
      diagStats.chunksSent += totalChunks;
      diagStats.lastFrameTime = Date.now();

      // 每5秒打印一次状态
      if (!handlePeerMessage._frameLogTime || Date.now() - handlePeerMessage._frameLogTime >= 5000) {
        const frameSizeKB = (imageData.length * 3 / 4 / 1024).toFixed(1);
        console.log(`[Controller] 屏幕帧发送: ${frameSizeKB}KB, ${payload.width}x${payload.height}`);
        handlePeerMessage._frameLogTime = Date.now();
      }
      break;
    }
    case 'remote-command': {
      // 来自主控的键鼠命令 —— 只有被控执行
      if (myRole === 'controlled') {
        remoteCmdReceived++;
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
let captureWarningShown = false;
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
  if (captureTimer) {
    console.log('[Capture] 捕获定时器已存在，跳过启动');
    return;
  }
  console.log('[Capture] ========== 开始屏幕捕获 ==========');
  console.log('[Capture] 当前状态 - sessionId:', !!sessionId, 'role:', myRole, 'ws.readyState:', ws ? ws.readyState : 'no ws');

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
  console.log(`[Capture] 屏幕分辨率: ${width}x${height}, 可用工作区: ${primaryDisplay.workAreaSize.width}x${primaryDisplay.workAreaSize.height}`);

  // 使用原始分辨率捕获，但限制最大宽度以控制传输大小
  const MAX_WIDTH = 1920;
  let thumbWidth = width;
  let thumbHeight = height;
  if (thumbWidth > MAX_WIDTH) {
    const ratio = MAX_WIDTH / thumbWidth;
    thumbWidth = MAX_WIDTH;
    thumbHeight = Math.floor(thumbHeight * ratio);
  }
  console.log(`[Capture] 捕获尺寸: ${thumbWidth}x${thumbHeight} (原始: ${width}x${height})`);

  // 立即执行一次捕获
  const captureOnce = async () => {
    if (!sessionId || myRole !== 'controlled') {
      console.log('[Capture] 停止捕获: sessionId存在=', !!sessionId, 'role=', myRole);
      stopScreenCapture();
      return;
    }
    try {
      logCrash(`[Capture] 开始捕获: sessionId=${sessionId}, role=${myRole}, size=${thumbWidth}x${thumbHeight}`);
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: {
          width: thumbWidth,
          height: thumbHeight
        }
      });
      logCrash(`[Capture] getSources 返回 ${sources.length} 个源`);
      sources.forEach((s, i) => {
        const t = s.thumbnail;
        let info = 'null';
        if (t) {
          try {
            const sz = t.getSize ? t.getSize() : { width: t.getWidth(), height: t.getHeight() };
            info = `${sz.width}x${sz.height}, empty=${t.isEmpty()}`;
          } catch (e) {
            info = 'error:' + e.message;
          }
        }
        logCrash(`[Capture] 源${i}: name=${s.display_id || s.name}, ${info}`);
      });

      // 统一的捕获失败处理（区分失败原因）
      const captureFailed = (reason, detail) => {
        captureFailCount++;
        lastCaptureError = (detail || reason).toString().substring(0, 120);
        logCrash(`[Capture] 捕获失败 #${captureFailCount}: reason=${reason}, detail=${lastCaptureError}`);
        if (captureFailCount <= 3 || captureFailCount % 20 === 0) {
          console.warn(`[Capture] 失败(${reason}) 连续第${captureFailCount}次`, detail || '');
        }
        if (captureFailCount >= 3 && !captureWarningShown) {
          captureWarningShown = true;
          const msgs = {
            'no-sources': '无可用屏幕源，请检查屏幕录制权限',
            'empty-thumbnail': '捕获到空画面：macOS 需在 系统设置>隐私与安全性>屏幕录制 中勾选本应用，然后【完全退出并重新打开】',
            'empty-jpeg': '画面编码为空：通常是屏幕录制权限未生效，请勾选权限后【完全退出并重新打开】本应用'
          };
          const reasonKey = reason.startsWith('empty') ? reason : 'no-sources';
          console.error(`[Capture] ${msgs[reasonKey]}`);
          notifyCaptureStatus({ ok: false, reason: reasonKey, message: msgs[reasonKey] });
        }
      };

      // 找一个非空的屏幕源（多屏时跳过空缩略图的源）
      const src = sources.find(s => s.thumbnail && !s.thumbnail.isEmpty());
      if (src) {
        const sz = src.thumbnail.getSize ? src.thumbnail.getSize() : { width: src.thumbnail.getWidth(), height: src.thumbnail.getHeight() };
        logCrash(`[Capture] find结果: ${src.display_id} ${sz.width}x${sz.height}`);
      } else {
        logCrash(`[Capture] find结果: 无可用源`);
      }

      if (!src) {
        if (sources.length === 0) {
          captureFailed('no-sources', 'desktopCapturer 返回 0 个屏幕源');
        } else {
          captureFailed('empty-thumbnail', `共${sources.length}个源，但所有缩略图均为空`);
        }
        return;
      }

      captureFailCount = 0;
      const thumb = src.thumbnail;
      // 获取尺寸（兼容 Texture 和 NativeImage）
      const thumbSz = thumb.getSize ? thumb.getSize() : { width: thumb.getWidth(), height: thumb.getHeight() };
      // 使用高JPEG质量以保证清晰度
      const jpeg = thumb.toJPEG(80);
      if (!jpeg || jpeg.length === 0) {
        captureFailed('empty-jpeg', `toJPEG 返回空 buffer`);
        return;
      }
      // 成功捕获，清除错误
      lastCaptureError = '';
      captureFailCount = 0;
      const base64 = jpeg.toString('base64');
      const sizeKB = (base64.length * 3 / 4 / 1024).toFixed(1);
      logCrash(`[Capture] 捕获成功: ${sizeKB}KB ${thumbSz.width}x${thumbSz.height}`);
        
        // 检查帧大小 - 如果太大则跳过
        const MAX_FRAME_SIZE = 500 * 1024; // 500KB
        if (base64.length > MAX_FRAME_SIZE * 4 / 3) {
          console.warn(`[Capture] 帧过大: ${sizeKB}KB, 可能导致传输问题`);
        }
        
        // 发送屏幕帧（包含实际屏幕分辨率用于坐标映射）
        const sent = sendToPeer({
          type: 'screen-frame',
          image: base64,
          width: thumbSz.width,
          height: thumbSz.height,
          screenWidth: width,    // 实际屏幕宽度
          screenHeight: height   // 实际屏幕高度
        });
        logCrash(`[Capture] 帧发送结果: ${sent ? '✅成功' : '❌失败'}, size=${sizeKB}KB, WS=${ws ? ws.readyState : 'no-ws'}`);
        
        if (!sent) {
          // 捕获成功但发送失败 — 单独计数
          captureSendFailCount++;
          if (!captureSendFailLog || Date.now() - captureSendFailLog >= 3000) {
            captureSendFailLog = Date.now();
            lastCaptureError = `发送失败: WS=${ws ? ws.readyState : 'no-ws'} session=${!!sessionId} (已连续${captureSendFailCount}次)`;
          }
        } else {
          captureSendFailCount = 0;
        }
        
        captureFrameCount++;
        lastCaptureSizeKB = sizeKB;
        
        // 每5秒打印一次状态
        const now = Date.now();
        if (now - lastCaptureTime >= 5000) {
          console.log(`[Capture] 状态: 已发送 ${captureFrameCount} 帧, 最近帧大小: ${sizeKB}KB, 发送结果: ${sent ? '成功' : '失败'}`);
          lastCaptureTime = now;
        }
        
        // 首次成功捕获，通知UI权限OK
        if (captureWarningShown) {
          notifyCaptureStatus({ ok: true });
          captureWarningShown = false;
        }
    } catch (e) {
      captureFailCount++;
      lastCaptureError = (e.message || String(e)).toString().substring(0, 120);
      logCrash(`[Capture] 异常 #${captureFailCount}: ${lastCaptureError}`);
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

  // 立即执行一次捕获（延迟100ms确保状态就绪）
  setTimeout(() => {
    console.log('[Capture] 执行首次捕获...');
    captureOnce();
  }, 100);
  
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
function getWinRobot() {
  if (_winRobot) return _winRobot;
  try {
    _winRobot = require('./win-robot');
    robotLoadError = '';
    _winRobot.init().catch(e => {
      robotLoadError = '初始化超时: ' + e.message;
      console.warn('[Robot] init err:', e.message);
    });
  } catch (e) {
    robotLoadError = 'require 失败: ' + e.message;
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
  if (!r) {
    // 键鼠模块加载失败 —— 明确通知（之前静默返回导致"控制不了"无任何提示）
    if (!handleRemoteCommand._robotErrTime || Date.now() - handleRemoteCommand._robotErrTime >= 10000) {
      handleRemoteCommand._robotErrTime = Date.now();
      console.error('[Robot] 键鼠模块不可用，命令被忽略:', command);
      notifyCaptureStatus({ ok: false, reason: 'robot-unavailable', message: '键鼠控制模块加载失败（PowerShell），无法执行鼠标键盘操作' });
    }
    return;
  }
  // 首次使用时确保初始化完成并同步屏幕尺寸
  if (!r.isReady()) {
    await r.init().catch(() => {});
    await r.updateScreenSize().catch(() => {});
  }
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
  // 初始化配置路径（必须在 app ready 后）
  CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');
  logCrash('APP ready, CONFIG_PATH=' + CONFIG_PATH);

  try {
    getWinRobot();
    logCrash('win-robot 加载完成');
  } catch (e) {
    logCrash('win-robot 加载异常: ' + e.message);
  }

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
