/**
 * Electron 主进程 - P2P 直连版
 * 无需独立信令服务器，两个客户端直接互连
 * 每个客户端既监听端口又主动连接对方公网 IP
 */

const { app, BrowserWindow, ipcMain, desktopCapturer, screen, clipboard } = require('electron');
const path = require('path');
const WebSocket = require('ws');
const WebSocketServer = WebSocket.Server;
const crypto = require('crypto');
const os = require('os');

// ============ P2P 配置 ============
const P2P_PORT = 3001;
// 两个公网 IP（程序会自动判断本机是哪个，然后连另一个）
const PEER_IPS = ['27.115.22.146', '58.210.4.122'];

// 本机唯一标识（用于握手时区分"连到自己"还是"连到对方"）
const MY_ID = crypto.randomUUID();

// ============ 全局状态 ============
let mainWindow = null;
let controlWindow = null;

// P2P 连接
let p2pSocket = null;        // 与对方的 WebSocket 连接
let p2pConnected = false;
let connectTimer = null;     // 定时重试连接
let wsServer = null;          // 本机 WebSocket Server

// 屏幕捕获
let captureTimer = null;
const CAPTURE_INTERVAL = 150;

// 是否正在向对方发送屏幕
let isSendingScreen = false;

// ============ 窗口管理 ============

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 480,
    height: 520,
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
    // 通知对方停止发送屏幕
    sendP2P({ type: 'screen-stop' });
    controlWindow = null;
  });
}

// ============ P2P 网络层 ============

function sendP2P(data) {
  if (p2pSocket && p2pConnected && p2pSocket.readyState === WebSocket.OPEN) {
    p2pSocket.send(JSON.stringify(data));
    return true;
  }
  return false;
}

function notifyStatus() {
  if (mainWindow) {
    mainWindow.webContents.send('p2p-status', { connected: p2pConnected });
  }
}

// 启动 WebSocket Server（接收入站连接）
function startWsServer() {
  try {
    wsServer = new WebSocketServer({ port: P2P_PORT });
    console.log(`[P2P] WebSocket Server 监听端口 ${P2P_PORT}`);

    wsServer.on('connection', (ws, req) => {
      console.log('[P2P] 收到入站连接:', req.socket.remoteAddress);
      handlePeerConnection(ws, 'incoming');
    });

    wsServer.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`[P2P] 端口 ${P2P_PORT} 被占用，请先释放`);
      } else {
        console.error('[P2P] Server错误:', err.message);
      }
    });
  } catch (e) {
    console.error('[P2P] 启动Server失败:', e.message);
  }
}

// 主动连接对方公网 IP
function startConnectingPeers() {
  if (connectTimer) return;

  const tryConnectAll = () => {
    if (p2pConnected) return; // 已连接，停止重试

    for (const ip of PEER_IPS) {
      tryConnectPeer(ip);
    }
  };

  // 立即尝试一次
  tryConnectAll();
  // 定时重试
  connectTimer = setInterval(tryConnectAll, 5000);
}

function tryConnectPeer(ip) {
  if (p2pConnected) return;

  const url = `ws://${ip}:${P2P_PORT}`;
  let ws;

  try {
    ws = new WebSocket(url, { timeout: 3000 });
  } catch (e) {
    return;
  }

  const timeoutTimer = setTimeout(() => {
    if (ws.readyState === WebSocket.CONNECTING) {
      try { ws.terminate(); } catch (e) {}
    }
  }, 4000);

  ws.on('open', () => {
    clearTimeout(timeoutTimer);
    console.log('[P2P] 连接成功:', url);
    // 发送握手
    ws.send(JSON.stringify({ type: 'hello', id: MY_ID }));
  });

  ws.on('message', (msg) => {
    let data;
    try {
      data = JSON.parse(msg.toString());
    } catch (e) { return; }

    // 握手应答
    if (data.type === 'hello-ack') {
      if (data.id === MY_ID) {
        // 连到了自己，断开
        console.log('[P2P] 连到了自己，断开');
        try { ws.close(); } catch (e) {}
        return;
      }
      // 连到了对方
      handlePeerConnection(ws, 'outgoing');
    }
  });

  ws.on('error', () => {
    clearTimeout(timeoutTimer);
  });

  ws.on('close', () => {
    clearTimeout(timeoutTimer);
  });
}

// 处理与对方的连接（入站或出站）
function handlePeerConnection(ws, direction) {
  // 如果已经连接了，关闭新连接
  if (p2pConnected) {
    try { ws.close(); } catch (e) {}
    return;
  }

  // 入站连接需要等待对方的 hello 消息
  if (direction === 'incoming') {
    let helloReceived = false;
    const helloTimeout = setTimeout(() => {
      if (!helloReceived) {
        try { ws.close(); } catch (e) {}
      }
    }, 5000);

    ws.once('message', (msg) => {
      clearTimeout(helloTimeout);
      helloReceived = true;
      let data;
      try {
        data = JSON.parse(msg.toString());
      } catch (e) { return; }

      if (data.type === 'hello') {
        if (data.id === MY_ID) {
          // 连到了自己
          console.log('[P2P] 入站连接是自己，断开');
          try { ws.close(); } catch (e) {}
          return;
        }
        // 连到了对方，回复握手
        ws.send(JSON.stringify({ type: 'hello-ack', id: MY_ID }));
        establishP2P(ws);
      }
    });
  }
  // 出站连接的握手在 tryConnectPeer 中处理
  // hello-ack 确认后调用 establishP2P
}

// P2P 连接正式建立
function establishP2P(ws) {
  if (p2pConnected) {
    try { ws.close(); } catch (e) {}
    return;
  }

  p2pSocket = ws;
  p2pConnected = true;
  console.log('[P2P] 与对方建立连接');

  // 停止重试
  if (connectTimer) {
    clearInterval(connectTimer);
    connectTimer = null;
  }

  // 通知前端
  notifyStatus();

  // 自动打开控制窗口
  if (!controlWindow) {
    createControlWindow();
  }

  // 开始屏幕捕获，发送给对方
  startScreenCapture();

  // 处理对方消息
  ws.on('message', (msg) => {
    let data;
    try {
      data = JSON.parse(msg.toString());
    } catch (e) { return; }
    handleP2PMessage(data);
  });

  ws.on('close', () => {
    onP2PDisconnected();
  });

  ws.on('error', () => {
    onP2PDisconnected();
  });
}

function onP2PDisconnected() {
  console.log('[P2P] 连接断开');
  p2pSocket = null;
  p2pConnected = false;
  stopScreenCapture();

  if (mainWindow) {
    mainWindow.webContents.send('p2p-status', { connected: false });
  }
  if (controlWindow) {
    controlWindow.webContents.send('session-ended');
  }

  // 恢复重试连接
  startConnectingPeers();
}

// ============ P2P 消息处理 ============

function handleP2PMessage(data) {
  switch (data.type) {
    // 收到对方屏幕帧
    case 'screen-frame':
      if (controlWindow) {
        controlWindow.webContents.send('screen-frame', {
          image: data.image,
          width: data.width,
          height: data.height
        });
      }
      break;

    // 对方停止发送屏幕
    case 'screen-stop':
      // 对方关闭了控制窗口，但我们还保持连接
      break;

    // 收到键鼠命令
    case 'remote-command':
      handleRemoteCommand(data.command, data.params);
      break;

    // 剪贴板同步
    case 'clipboard-sync':
      try {
        if (data.content !== clipboard.readText()) {
          clipboard.writeText(data.content);
        }
      } catch (e) {}
      break;

    // 获取剪贴板
    case 'get-clipboard':
      const content = clipboard.readText();
      sendP2P({ type: 'clipboard-result', content });
      break;

    // 剪贴板结果
    case 'clipboard-result':
      try { clipboard.writeText(data.content); } catch (e) {}
      break;
  }
}

// ============ 屏幕捕获 ============

function startScreenCapture() {
  if (captureTimer) return;
  isSendingScreen = true;
  console.log('[P2P] 开始屏幕捕获');

  const captureOnce = async () => {
    if (!isSendingScreen || !p2pConnected) {
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
        const thumbnail = sources[0].thumbnail;
        const imageData = thumbnail.toJPEG(65);

        sendP2P({
          type: 'screen-frame',
          image: imageData.toString('base64'),
          width: thumbnail.getWidth(),
          height: thumbnail.getHeight()
        });
      }
    } catch (e) {
      console.error('[P2P] 屏幕捕获错误:', e.message);
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
  isSendingScreen = false;
}

// ============ 键鼠控制 ============

let _winRobot = null;
function getWinRobot() {
  if (_winRobot) return _winRobot;
  try {
    _winRobot = require('./win-robot');
    _winRobot.init().catch(e => console.warn('[P2P] WinRobot init err:', e.message));
  } catch (e) {
    console.error('[P2P] WinRobot模块加载失败:', e.message);
    _winRobot = null;
  }
  return _winRobot;
}

async function handleRemoteCommand(command, params) {
  // 剪贴板操作
  if (command === 'set-clipboard') {
    if (params.content != null) {
      try { clipboard.writeText(String(params.content)); } catch (e) {}
    }
    return;
  }
  if (command === 'get-clipboard') {
    try {
      sendP2P({ type: 'clipboard-result', content: clipboard.readText() });
    } catch (e) {}
    return;
  }

  const r = getWinRobot();
  if (!r) return;

  try {
    switch (command) {
      case 'mouse-move':
        await r.moveMouse(params.x || 0, params.y || 0);
        break;
      case 'mouse-click':
        await r.mouseClick(params.x || 0, params.y || 0, params.button || 'left', !!params.double);
        break;
      case 'mouse-down':
        await r.mouseDown(params.x || 0, params.y || 0, params.button || 'left');
        break;
      case 'mouse-up':
        await r.mouseUp(params.button || 'left');
        break;
      case 'mouse-scroll':
        await r.scrollMouse(params.dx || 0, params.dy || 0);
        break;
      case 'key-down':
        if (params.key) await r.keyDown(params.key);
        break;
      case 'key-up':
        if (params.key) await r.keyUp(params.key);
        break;
      case 'key-tap':
        if (params.key) await r.keyTap(params.key, params.modifiers || []);
        break;
      case 'type-string':
        if (params.string) await r.typeString(params.string);
        break;
    }
  } catch (e) {
    console.error('[P2P] 命令执行失败:', command, e.message);
  }
}

// ============ IPC 通信 ============

ipcMain.handle('get-p2p-status', () => {
  return { connected: p2pConnected };
});

ipcMain.handle('send-command', (event, { command, params }) => {
  if (!p2pConnected) return { success: false };
  sendP2P({ type: 'remote-command', command, params });
  return { success: true };
});

ipcMain.handle('sync-clipboard', (event, { content }) => {
  try { clipboard.writeText(content); } catch (e) {}
  sendP2P({ type: 'clipboard-sync', content });
  return { success: true };
});

ipcMain.handle('disconnect', () => {
  if (p2pSocket) {
    try { p2pSocket.close(); } catch (e) {}
  }
  return { success: true };
});

// ============ Electron 生命周期 ============

app.whenReady().then(() => {
  // 初始化键鼠控制引擎
  getWinRobot();

  createMainWindow();

  // 启动 P2P：监听 + 主动连接
  startWsServer();
  startConnectingPeers();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  stopScreenCapture();
  if (connectTimer) {
    clearInterval(connectTimer);
    connectTimer = null;
  }
  if (wsServer) {
    try { wsServer.close(); } catch (e) {}
  }
  if (p2pSocket) {
    try { p2pSocket.close(); } catch (e) {}
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  stopScreenCapture();
});
