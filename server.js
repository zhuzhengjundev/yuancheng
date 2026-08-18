/**
 * WebSocket 信令服务器
 * 负责设备注册、连接转发、消息中继
 */

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3001;

// 设备注册表: deviceId -> { ws, password, name, isOnline }
const devices = new Map();

// 连接会话: sessionId -> { controllerId, targetId, controllerWs, targetWs }
const sessions = new Map();

// 生成6位数字密码
function generatePassword() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// 生成9位数字设备ID
function generateDeviceId() {
  let id = '';
  for (let i = 0; i < 9; i++) {
    id += Math.floor(Math.random() * 10).toString();
  }
  return id;
}

// 发送JSON消息
function sendJSON(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

wss.on('connection', (ws, req) => {
  console.log('[Server] 新客户端连接');

  let currentDeviceId = null;

  ws.on('message', (message) => {
    let data;
    try {
      data = JSON.parse(message.toString());
    } catch (e) {
      console.error('[Server] 消息解析失败:', e);
      return;
    }

    console.log('[Server] 收到消息:', data.type, data.deviceId || '');

    switch (data.type) {
      // ===== 设备注册/登录 =====
      case 'register': {
        // 生成或使用指定的deviceId
        let deviceId = data.deviceId;
        if (!deviceId || !devices.has(deviceId)) {
          // 生成新的设备ID
          do {
            deviceId = generateDeviceId();
          } while (devices.has(deviceId));
        }

        const password = generatePassword();

        // 如果之前有连接，先断开旧的
        const oldDev = devices.get(deviceId);
        if (oldDev && oldDev.ws && oldDev.ws !== ws) {
          sendJSON(oldDev.ws, { type: 'kicked', reason: '设备在其他地方登录' });
          try { oldDev.ws.close(); } catch (e) {}
        }

        devices.set(deviceId, {
          ws,
          password,
          name: data.deviceName || '远程设备',
          isOnline: true,
          registeredAt: Date.now()
        });

        currentDeviceId = deviceId;

        sendJSON(ws, {
          type: 'registered',
          deviceId,
          password,
          deviceName: data.deviceName || '远程设备'
        });

        console.log(`[Server] 设备注册: ${deviceId} / 密码: ${password}`);
        break;
      }

      // ===== 心跳保活 =====
      case 'heartbeat': {
        if (currentDeviceId && devices.has(currentDeviceId)) {
          const dev = devices.get(currentDeviceId);
          dev.lastHeartbeat = Date.now();
          sendJSON(ws, { type: 'heartbeat-ack' });
        }
        break;
      }

      // ===== 发起连接请求（控制端 -> 服务器 -> 被控端） =====
      case 'connect-request': {
        const { targetId, password, senderId } = data;

        if (!devices.has(targetId)) {
          sendJSON(ws, {
            type: 'connect-error',
            reason: '目标设备不存在或离线'
          });
          return;
        }

        const target = devices.get(targetId);
        if (!target.isOnline) {
          sendJSON(ws, {
            type: 'connect-error',
            reason: '目标设备离线'
          });
          return;
        }

        // 验证密码
        if (target.password !== password) {
          sendJSON(ws, {
            type: 'connect-error',
            reason: '密码错误'
          });
          return;
        }

        // 创建会话
        const sessionId = uuidv4();
        sessions.set(sessionId, {
          sessionId,
          controllerId: senderId,
          targetId,
          controllerWs: ws,
          targetWs: target.ws,
          createdAt: Date.now()
        });

        // 通知被控端有人请求连接
        sendJSON(target.ws, {
          type: 'incoming-connection',
          sessionId,
          controllerId: senderId,
          controllerName: data.controllerName || '控制端用户'
        });

        // 通知控制端，等待被控端确认
        sendJSON(ws, {
          type: 'connect-waiting',
          sessionId,
          targetId
        });

        console.log(`[Server] 连接请求: ${senderId} -> ${targetId}, session: ${sessionId}`);
        break;
      }

      // ===== 被控端接受连接 =====
      case 'connect-accept': {
        const { sessionId } = data;
        const session = sessions.get(sessionId);
        if (!session) return;

        session.accepted = true;

        // 通知控制端连接成功
        sendJSON(session.controllerWs, {
          type: 'connect-success',
          sessionId,
          targetId: session.targetId
        });

        // 通知被控端准备好
        sendJSON(session.targetWs, {
          type: 'session-started',
          sessionId,
          controllerId: session.controllerId
        });

        console.log(`[Server] 连接建立: ${session.controllerId} <-> ${session.targetId}`);
        break;
      }

      // ===== 被控端拒绝连接 =====
      case 'connect-reject': {
        const { sessionId, reason } = data;
        const session = sessions.get(sessionId);
        if (!session) return;

        sendJSON(session.controllerWs, {
          type: 'connect-rejected',
          reason: reason || '对方拒绝了连接请求'
        });

        sessions.delete(sessionId);
        break;
      }

      // ===== 屏幕帧数据（被控端 -> 服务器 -> 控制端） =====
      case 'screen-frame': {
        const { sessionId } = data;
        const session = sessions.get(sessionId);
        if (!session || !session.accepted) return;

        // 只转发图像数据，减轻日志量
        sendJSON(session.controllerWs, {
          type: 'screen-frame',
          sessionId,
          image: data.image,
          width: data.width,
          height: data.height
        });
        break;
      }

      // ===== 远程命令（控制端 -> 服务器 -> 被控端） =====
      case 'remote-command': {
        const { sessionId, command, params } = data;
        const session = sessions.get(sessionId);
        if (!session || !session.accepted) return;

        sendJSON(session.targetWs, {
          type: 'remote-command',
          sessionId,
          command,
          params
        });
        break;
      }

      // ===== 命令执行结果（被控端 -> 服务器 -> 控制端） =====
      case 'command-result': {
        const { sessionId, command, result } = data;
        const session = sessions.get(sessionId);
        if (!session || !session.accepted) return;

        sendJSON(session.controllerWs, {
          type: 'command-result',
          sessionId,
          command,
          result
        });
        break;
      }

      // ===== 剪贴板同步 =====
      case 'clipboard-sync': {
        const { sessionId, content, direction } = data;
        const session = sessions.get(sessionId);
        if (!session || !session.accepted) return;

        if (direction === 'controller-to-target') {
          sendJSON(session.targetWs, {
            type: 'clipboard-sync',
            sessionId,
            content
          });
        } else {
          sendJSON(session.controllerWs, {
            type: 'clipboard-sync',
            sessionId,
            content
          });
        }
        break;
      }

      // ===== 断开会话 =====
      case 'disconnect-session': {
        const { sessionId } = data;
        const session = sessions.get(sessionId);
        if (!session) return;

        sendJSON(session.controllerWs, { type: 'session-ended', sessionId });
        sendJSON(session.targetWs, { type: 'session-ended', sessionId });

        sessions.delete(sessionId);
        console.log(`[Server] 会话结束: ${sessionId}`);
        break;
      }

      default:
        console.log('[Server] 未知消息类型:', data.type);
    }
  });

  ws.on('close', () => {
    console.log('[Server] 客户端断开连接');

    // 标记设备离线
    if (currentDeviceId && devices.has(currentDeviceId)) {
      const dev = devices.get(currentDeviceId);
      if (dev.ws === ws) {
        dev.isOnline = false;
        // 给30秒宽限期，暂时不删除设备ID和密码（可以重新连接）
        // setTimeout(() => {
        //   if (devices.has(currentDeviceId) && !devices.get(currentDeviceId).isOnline) {
        //     devices.delete(currentDeviceId);
        //   }
        // }, 30000);
      }
    }

    // 清理相关会话
    for (const [sessionId, session] of sessions.entries()) {
      if (session.controllerWs === ws || session.targetWs === ws) {
        const otherWs = session.controllerWs === ws ? session.targetWs : session.controllerWs;
        sendJSON(otherWs, { type: 'session-ended', sessionId });
        sessions.delete(sessionId);
      }
    }
  });

  ws.on('error', (err) => {
    console.error('[Server] WebSocket错误:', err);
  });
});

// HTTP 健康检查
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    onlineDevices: Array.from(devices.values()).filter(d => d.isOnline).length,
    activeSessions: sessions.size
  });
});

app.get('/', (req, res) => {
  res.send(`
    <h1>RemoteControl 信令服务器</h1>
    <p>在线设备: ${Array.from(devices.values()).filter(d => d.isOnline).length}</p>
    <p>活跃会话: ${sessions.size}</p>
    <p>设备列表:</p>
    <ul>
      ${Array.from(devices.entries()).map(([id, d]) => 
        `<li>${id} - ${d.name} [${d.isOnline ? '在线' : '离线'}] 密码:${d.password}</li>`
      ).join('')}
    </ul>
  `);
});

server.listen(PORT, () => {
  console.log(`[Server] 信令服务器启动成功 - http://localhost:${PORT}`);
  console.log(`[Server] WebSocket 监听在 ws://localhost:${PORT}`);
});
