/**
 * WebSocket 远程控制 公共中继服务器
 *
 * 功能：
 *   1. 设备注册：客户端连接后，服务器分配 9 位设备代码 + 6 位密码
 *   2. 配对连接：主控端输入对方设备代码 + 密码发起连接，服务器验证后建立会话
 *   3. 消息路由：屏幕帧、键鼠命令、剪贴板等均通过服务器按会话转发
 *   4. 服务器面板：浏览器打开 http://<ip>:3001/ 即可查看设备与会话
 *
 * 部署：
 *   node server.js  (PORT 默认 3001)
 */

const WebSocket = require('ws');
const http = require('http');
const crypto = require('crypto');
const os = require('os');

const PORT = process.env.PORT || 3001;
const HOSTNAME = os.hostname();

// ==================== 工具函数 ====================

function genDeviceCode() {
  let code = '';
  for (let i = 0; i < 9; i++) {
    code += Math.floor(Math.random() * 10).toString();
  }
  return code;
}

function genPassword() {
  let pwd = '';
  for (let i = 0; i < 6; i++) {
    pwd += Math.floor(Math.random() * 10).toString();
  }
  return pwd;
}

function genUniqueDeviceCode(existing) {
  let attempts = 0;
  while (attempts < 1000) {
    const c = genDeviceCode();
    if (!existing.has(c)) return c;
    attempts++;
  }
  return crypto.randomBytes(8).toString('hex').substring(0, 9).replace(/[a-f]/g, '1').padEnd(9, '0');
}

// ==================== 数据结构 ====================

/** 设备注册表：deviceCode -> { ws, password, sessionId, clientId, ip, hostname, registeredAt } */
const devices = new Map();
/** 会话表：sessionId -> { id, controllerCode, controlledCode, createdAt } */
const sessions = new Map();
/** clientId -> deviceCode  反向索引 */
const clientToDevice = new Map();

function send(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

// ==================== 数据聚合接口 ====================

function getStats() {
  const devList = [];
  for (const [code, d] of devices) {
    devList.push({
      code,
      hostname: d.hostname || '未知设备',
      ip: d.ip,
      password: d.password,
      online: !!(d.ws && d.ws.readyState === WebSocket.OPEN),
      sessionId: d.sessionId
    });
  }

  const sessList = [];
  for (const [sid, s] of sessions) {
    const c = devices.get(s.controllerCode);
    const t = devices.get(s.controlledCode);
    sessList.push({
      sessionId: sid.substring(0, 8),
      controller: s.controllerCode,
      controllerHostname: c ? (c.hostname || '未知') : '未知',
      controlled: s.controlledCode,
      controlledHostname: t ? (t.hostname || '未知') : '未知',
      createdAt: s.createdAt
    });
  }

  return {
    hostname: HOSTNAME,
    port: PORT,
    uptime: Math.floor(process.uptime()),
    devices: devList,
    sessions: sessList
  };
}

// ==================== HTTP 接口 ====================
const server = http.createServer((req, res) => {
  // 允许跨域（方便前端页面在任意域访问 API）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      devices: devices.size,
      sessions: sessions.size,
      uptime: process.uptime()
    }));
  } else if (req.url === '/api/stats') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(getStats()));
  } else if (req.url === '/') {
    // 返回管理面板 HTML
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(DASHBOARD_HTML);
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

// ==================== WebSocket 服务 ====================
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
  const clientId = crypto.randomUUID();
  let myDeviceCode = null;
  let mySessionId = null;

  console.log(`[SVR] 新连接 client=${clientId}  ip=${req.socket.remoteAddress}`);

  myDeviceCode = genUniqueDeviceCode(new Set(devices.keys()));
  const myPassword = genPassword();

  devices.set(myDeviceCode, {
    ws,
    password: myPassword,
    sessionId: null,
    clientId,
    ip: req.socket.remoteAddress,
    hostname: '',   // 等待客户端上报
    registeredAt: Date.now()
  });
  clientToDevice.set(clientId, myDeviceCode);

  console.log(`[SVR] 设备注册 code=${formatCode(myDeviceCode)}  pwd=${myPassword}`);

  // 下发本机信息
  send(ws, {
    type: 'device-info',
    deviceCode: myDeviceCode,
    password: myPassword,
    clientId
  });

  // 心跳
  const heartbeatTimer = setInterval(() => {
    send(ws, { type: 'ping', t: Date.now() });
  }, 30000);

  ws.on('message', (raw) => {
    let data;
    try { data = JSON.parse(raw.toString()); } catch (e) {
      send(ws, { type: 'error', message: 'Invalid JSON' });
      return;
    }

    switch (data.type) {
      case 'register-device-name': {
        // 客户端上报自己的主机名
        const d = devices.get(myDeviceCode);
        if (d && data.hostname) {
          d.hostname = String(data.hostname).substring(0, 60);
          console.log(`[SVR] 设备命名 code=${formatCode(myDeviceCode)}  name=${d.hostname}`);
        }
        break;
      }

      case 'pong':
        break;

      case 'refresh-password': {
        const d = devices.get(myDeviceCode);
        if (d) {
          const newPwd = genPassword();
          d.password = newPwd;
          send(ws, { type: 'device-info', deviceCode: myDeviceCode, password: newPwd, clientId });
        }
        break;
      }

      case 'connect-device': {
        const targetCode = (data.targetCode || '').toString().replace(/\s/g, '');
        const targetPassword = (data.targetPassword || '').toString();

        if (!/^\d{9}$/.test(targetCode)) {
          send(ws, { type: 'connect-error', message: '设备代码格式错误，应为9位数字' });
          return;
        }
        if (!/^\d{6}$/.test(targetPassword)) {
          send(ws, { type: 'connect-error', message: '密码格式错误，应为6位数字' });
          return;
        }

        const target = devices.get(targetCode);
        if (!target) {
          send(ws, { type: 'connect-error', message: '设备不在线' });
          return;
        }
        if (targetCode === myDeviceCode) {
          send(ws, { type: 'connect-error', message: '不能连接自己' });
          return;
        }
        if (target.password !== targetPassword) {
          send(ws, { type: 'connect-error', message: '密码错误' });
          return;
        }
        if (target.sessionId) {
          send(ws, { type: 'connect-error', message: '对方正在被控制中，请稍后再试' });
          return;
        }
        const mine = devices.get(myDeviceCode);
        if (mine && mine.sessionId) {
          send(ws, { type: 'connect-error', message: '您正在进行中的控制尚未结束' });
          return;
        }

        const sessionId = crypto.randomUUID();
        sessions.set(sessionId, {
          id: sessionId,
          controllerCode: myDeviceCode,
          controlledCode: targetCode,
          createdAt: Date.now()
        });
        mySessionId = sessionId;
        target.sessionId = sessionId;

        console.log(`[SVR] 会话建立 ${shortSession(sessionId)}: ${formatCode(myDeviceCode)} -> ${formatCode(targetCode)}`);

        send(ws, {
          type: 'connected',
          sessionId,
          role: 'controller',
          peerCode: targetCode
        });

        send(target.ws, {
          type: 'incoming-control',
          sessionId,
          role: 'controlled',
          peerCode: myDeviceCode
        });
        break;
      }

      case 'accept-control':
        break;

      case 'disconnect':
        endSession(mySessionId);
        break;

      case 'to-peer': {
        const sess = sessions.get(mySessionId);
        if (!sess) return;
        const peerCode = sess.controllerCode === myDeviceCode ? sess.controlledCode : sess.controllerCode;
        const peer = devices.get(peerCode);
        if (peer) {
          send(peer.ws, {
            type: 'from-peer',
            sessionId: mySessionId,
            fromRole: sess.controllerCode === myDeviceCode ? 'controller' : 'controlled',
            payload: data.payload
          });
        }
        break;
      }

      default:
        break;
    }
  });

  ws.on('close', () => {
    clearInterval(heartbeatTimer);
    console.log(`[SVR] 连接关闭 client=${clientId}`);
    if (mySessionId) endSession(mySessionId);
    if (myDeviceCode) devices.delete(myDeviceCode);
    clientToDevice.delete(clientId);
  });

  ws.on('error', (err) => {
    console.error(`[SVR] ws错误 client=${clientId}:`, err.message);
  });
});

function endSession(sessionId) {
  const sess = sessions.get(sessionId);
  if (!sess) return;
  console.log(`[SVR] 会话结束 ${shortSession(sessionId)}: ${formatCode(sess.controllerCode)} <-> ${formatCode(sess.controlledCode)}`);

  const c = devices.get(sess.controllerCode);
  const t = devices.get(sess.controlledCode);

  if (c) { c.sessionId = null; send(c.ws, { type: 'session-ended', sessionId }); }
  if (t) { t.sessionId = null; send(t.ws, { type: 'session-ended', sessionId }); }

  sessions.delete(sessionId);
}

// ==================== 工具函数 ====================
function formatCode(code) {
  if (!code || code.length !== 9) return code;
  return code.slice(0, 3) + ' ' + code.slice(3, 6) + ' ' + code.slice(6);
}
function shortSession(sid) {
  return sid ? sid.substring(0, 8) : '-';
}

// ==================== 仪表盘 HTML ====================
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>RemoteControl 信令服务器</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    background: #1a1a2e;
    color: #e4e8f0;
    min-height: 100vh;
    padding: 32px 40px;
  }
  h1 {
    font-size: 32px;
    font-weight: 700;
    margin-bottom: 24px;
    letter-spacing: 1px;
  }
  .stats {
    display: flex;
    gap: 20px;
    margin-bottom: 32px;
  }
  .stat-card {
    background: rgba(255,255,255,0.06);
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 12px;
    padding: 20px 24px;
    min-width: 160px;
  }
  .stat-card .label { font-size: 13px; color: #8892b0; margin-bottom: 6px; }
  .stat-card .value { font-size: 36px; font-weight: 700; }
  .stat-card .value.green { color: #4ade80; }
  .stat-card .value.blue { color: #60a5fa; }
  .stat-card .value.orange { color: #fbbf24; }

  h2 { font-size: 20px; margin-bottom: 16px; color: #ccd6f6; }

  .device-list { list-style: none; }
  .device-item {
    background: rgba(255,255,255,0.04);
    border: 1px solid rgba(255,255,255,0.06);
    border-radius: 10px;
    padding: 14px 18px;
    margin-bottom: 10px;
    display: flex;
    align-items: center;
    gap: 14px;
  }
  .device-item .code {
    font-family: 'SF Mono', Consolas, monospace;
    font-weight: 700;
    font-size: 16px;
    color: #e4e8f0;
    min-width: 120px;
  }
  .device-item .sep { color: #4a5568; }
  .device-item .name {
    flex: 1;
    color: #a8b2d1;
    font-size: 14px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .device-item .status {
    font-size: 12px;
    font-weight: 600;
    padding: 3px 10px;
    border-radius: 20px;
  }
  .device-item .status.online { background: rgba(74,222,128,0.15); color: #4ade80; }
  .device-item .status.offline { background: rgba(239,68,68,0.15); color: #f87171; }
  .device-item .pwd {
    font-family: 'SF Mono', Consolas, monospace;
    font-size: 13px;
    color: #fbbf24;
    background: rgba(251,191,36,0.1);
    padding: 2px 8px;
    border-radius: 6px;
  }

  .session-list { list-style: none; }
  .session-item {
    background: rgba(255,255,255,0.04);
    border: 1px solid rgba(255,255,255,0.06);
    border-radius: 10px;
    padding: 14px 18px;
    margin-bottom: 10px;
    font-size: 14px;
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .session-item .sid { font-family: monospace; color: #60a5fa; font-size: 12px; }
  .session-item .arrow { color: #8892b0; }
  .session-item .role-tag {
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 10px;
    font-weight: 600;
  }
  .role-tag.controller { background: rgba(96,165,250,0.15); color: #60a5fa; }
  .role-tag.controlled { background: rgba(251,191,36,0.15); color: #fbbf24; }

  .empty { color: #5a6478; font-size: 14px; padding: 20px 0; }

  .refresh {
    position: fixed;
    top: 24px;
    right: 32px;
    padding: 8px 18px;
    background: rgba(255,255,255,0.08);
    border: 1px solid rgba(255,255,255,0.1);
    color: #ccd6f6;
    border-radius: 8px;
    cursor: pointer;
    font-size: 13px;
  }
  .refresh:hover { background: rgba(255,255,255,0.12); }
  .auto-refresh {
    position: fixed;
    top: 68px;
    right: 32px;
    color: #5a6478;
    font-size: 12px;
  }
  .auto-refresh.on { color: #4ade80; }
</style>
</head>
<body>
  <button class="refresh" onclick="loadData()">🔄 刷新</button>
  <label class="auto-refresh" id="autoLabel">自动刷新 (10s)</label>

  <h1>RemoteControl 信令服务器</h1>

  <div class="stats">
    <div class="stat-card">
      <div class="label">在线设备</div>
      <div class="value green" id="statDevices">0</div>
    </div>
    <div class="stat-card">
      <div class="label">活跃会话</div>
      <div class="value blue" id="statSessions">0</div>
    </div>
    <div class="stat-card">
      <div class="label">已运行</div>
      <div class="value orange" id="statUptime">0s</div>
    </div>
  </div>

  <h2>设备列表：</h2>
  <ul class="device-list" id="deviceList"></ul>

  <h2 style="margin-top:32px;">会话列表：</h2>
  <ul class="session-list" id="sessionList"></ul>

<script>
let autoTimer = null;

function fmtCode(c) {
  if (!c || c.length !== 9) return c;
  return c.slice(0,3)+' '+c.slice(3,6)+' '+c.slice(6);
}

async function loadData() {
  try {
    const r = await fetch('/api/stats');
    const d = await r.json();

    document.getElementById('statDevices').textContent = d.devices.length;
    document.getElementById('statSessions').textContent = d.sessions.length;
    const m = Math.floor(d.uptime / 60);
    const s = d.uptime % 60;
    document.getElementById('statUptime').textContent = m > 0 ? m+'m '+s+'s' : s+'s';

    const dl = document.getElementById('deviceList');
    if (!d.devices.length) {
      dl.innerHTML = '<div class="empty">暂无设备在线</div>';
    } else {
      dl.innerHTML = d.devices.map(dv => {
        const code = fmtCode(dv.code);
        const name = dv.hostname || '未知设备';
        const status = dv.online ? '<span class="status online">在线</span>' : '<span class="status offline">离线</span>';
        const pwd = '<span class="pwd">密码:'+dv.password+'</span>';
        const ip = dv.ip ? ' <span style="color:#5a6478;font-size:12px;">('+dv.ip+')</span>' : '';
        return '<li class="device-item">' +
          '<span class="code">'+code+'</span>' +
          '<span class="sep">-</span>' +
          '<span class="name">'+name+ip+'</span>' +
          status + pwd +
          '</li>';
      }).join('');
    }

    const sl = document.getElementById('sessionList');
    if (!d.sessions.length) {
      sl.innerHTML = '<div class="empty">暂无活跃会话</div>';
    } else {
      sl.innerHTML = d.sessions.map(s => {
        return '<li class="session-item">' +
          '<span class="sid">'+s.sessionId+'</span>' +
          '<span class="role-tag controller">主控 '+fmtCode(s.controller)+' ('+s.controllerHostname+')</span>' +
          '<span class="arrow">→</span>' +
          '<span class="role-tag controlled">被控 '+fmtCode(s.controlled)+' ('+s.controlledHostname+')</span>' +
          '</li>';
      }).join('');
    }
  } catch (e) {
    console.error(e);
  }
}

document.getElementById('autoLabel').addEventListener('click', function() {
  if (autoTimer) {
    clearInterval(autoTimer);
    autoTimer = null;
    this.classList.remove('on');
  } else {
    autoTimer = setInterval(loadData, 10000);
    this.classList.add('on');
  }
});

loadData();
autoTimer = setInterval(loadData, 10000);
document.getElementById('autoLabel').classList.add('on');
</script>
</body>
</html>`;

// ==================== 启动 ====================
server.listen(PORT, () => {
  console.log(`[SVR] 公共中继服务器已启动: ws://0.0.0.0:${PORT}`);
  console.log(`[SVR] 管理面板: http://0.0.0.0:${PORT}/`);
  console.log(`[SVR] 健康检查: http://0.0.0.0:${PORT}/health`);
  console.log(`[SVR] API 接口: http://0.0.0.0:${PORT}/api/stats`);
  console.log(`[SVR] 等待客户端连接...`);
});
