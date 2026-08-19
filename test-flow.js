/**
 * 端到端流程自测脚本
 * 模拟 被控端(B) + 主控端(A) 走完整会话流程，验证屏幕帧能否走通
 *
 * 用法:
 *   node test-flow.js ws://127.0.0.1:3001          本地直连测试
 *   node test-flow.js wss://xxxx.lhr.life           隧道测试
 *
 * 测试项:
 *   1. 分块发送（新版客户端行为）：B 按 main.js 逻辑把 >12KB 消息分块发送
 *   2. 不分块直发（旧版 Mac 客户端行为）：B 直接发完整大消息
 *   3. 被控端断开 → 主控端应收到 session-ended
 */
const WebSocket = require('ws');

const SERVER = process.argv[2] || 'ws://127.0.0.1:3001';
const WS_MAX_CHUNK = 12 * 1024; // 与 main.js 一致

let chunkCounter = 0;

// ===== 复刻 main.js 的 sendToServer 分块发送逻辑 =====
function makeSender(ws) {
  return function (data) {
    const json = JSON.stringify(data);
    if (json.length <= WS_MAX_CHUNK) {
      ws.send(json);
      return { chunked: false, size: json.length };
    }
    const msgId = ++chunkCounter;
    const totalChunks = Math.ceil(json.length / WS_MAX_CHUNK);
    ws.send(JSON.stringify({ __chunked: true, phase: 'start', msgId, totalChunks, originalType: data.type || '?' }));
    for (let i = 0; i < totalChunks; i++) {
      const s = i * WS_MAX_CHUNK;
      ws.send(JSON.stringify({
        __chunked: true, phase: 'data', msgId, chunkIndex: i,
        data: json.substring(s, Math.min(s + WS_MAX_CHUNK, json.length))
      }));
    }
    ws.send(JSON.stringify({ __chunked: true, phase: 'end', msgId }));
    return { chunked: true, totalChunks, size: json.length };
  };
}

// ===== 复刻 main.js 的服务端分块重组逻辑（每连接创建一次！）=====
function makeReceiver(onMessage) {
  const buffers = new Map();
  return function (data) {
    if (data && data.__server_chunked) {
      if (data.phase === 'start') {
        buffers.set(data.msgId, { chunks: new Array(data.totalChunks), totalChunks: data.totalChunks });
        return;
      }
      if (data.phase === 'data') {
        const b = buffers.get(data.msgId);
        if (b) b.chunks[data.chunkIndex] = data.data;
        return;
      }
      if (data.phase === 'end') {
        const b = buffers.get(data.msgId);
        if (!b) return;
        const got = b.chunks.filter(c => c !== undefined).length;
        if (got < b.totalChunks) {
          console.log(`  ✗ [接收] 分块不完整 ${got}/${b.totalChunks}`);
          buffers.delete(data.msgId);
          return;
        }
        let json = '';
        for (let i = 0; i < b.totalChunks; i++) json += b.chunks[i];
        buffers.delete(data.msgId);
        try {
          onMessage(JSON.parse(json));
        } catch (e) {
          console.log('  ✗ [接收] 重组JSON解析失败: ' + e.message);
        }
      }
      return;
    }
    onMessage(data);
  };
}

// 生成 kb KB 的伪 base64 图片数据
function fakeImage(kb) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let s = '';
  const block = 4096;
  for (let i = 0; i < kb * 1024 / block; i++) {
    let seg = '';
    for (let j = 0; j < block; j++) seg += chars[Math.floor(Math.random() * chars.length)];
    s += seg;
  }
  return s;
}

const FRAME_KB = 60; // 模拟 60KB 的屏幕帧（真实帧 40-80KB）
const image60 = fakeImage(FRAME_KB);

let wsA = null, wsB = null;
let sendA = null, sendB = null;
let codeB = null, pwdB = null;
let phase = '';
let results = [];
let failTimer = null;

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}

function summaryAndExit() {
  console.log('\n========== 测试结果 ==========');
  let allOk = true;
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
    if (!r.ok) allOk = false;
  }
  console.log('=============================');
  console.log(allOk ? '✅ 全部通过' : '❌ 存在失败项');
  process.exit(allOk ? 0 : 1);
}

function armTimeout(sec, what) {
  if (failTimer) clearTimeout(failTimer);
  failTimer = setTimeout(() => {
    record(`等待 ${what}`, false, `${sec}s 超时`);
    summaryAndExit();
  }, sec * 1000);
}

// ============ B：被控端 ============
function startB() {
  console.log('\n[B 被控端] 连接', SERVER);
  wsB = new WebSocket(SERVER + '?clientId=testflow-b-' + Date.now(), {
    timeout: 8000,
    ...(SERVER.startsWith('wss') ? { rejectUnauthorized: false } : {})
  });
  sendB = makeSender(wsB);
  const recvB = makeReceiver(onBMessage); // 每连接只创建一次

  wsB.on('open', () => console.log('[B] 已连接'));
  wsB.on('error', e => { console.log('[B] 连接错误:', e.message); summaryAndExit(); });
  wsB.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
    recvB(msg);
  });

  function onBMessage(msg) {
    if (msg.type === 'device-info') {
      codeB = msg.deviceCode;
      pwdB = msg.password;
      console.log(`[B] 设备代码=${codeB} 密码=${pwdB}`);
      startA();
    } else if (msg.type === 'incoming-control') {
      console.log('[B] 收到 incoming-control，会话已建立 (sessionId=' + msg.sessionId.substring(0, 8) + ')');
    } else if (msg.type === 'from-peer' && msg.payload.type === 'screen-start') {
      if (phase === 'chunked') {
        console.log('[B] 收到 screen-start，发送 60KB 帧（分块发送，新版客户端行为）');
        const r = sendB({ type: 'to-peer', payload: { type: 'screen-frame', image: image60, width: 960, height: 540 } });
        console.log(`[B] 已发送: ${r.chunked ? `分块${r.totalChunks}块` : '直发'}, 总${(r.size / 1024).toFixed(1)}KB`);
        record('B 分块发送 60KB 帧', true, `${r.totalChunks} 块`);
      } else if (phase === 'direct') {
        console.log('[B] 收到 screen-start，发送 60KB 帧（不分块直发，旧版客户端行为）');
        wsB.send(JSON.stringify({ type: 'to-peer', payload: { type: 'screen-frame', image: image60, width: 960, height: 540 } }));
        console.log('[B] 已直发完整 60KB 消息');
        record('B 直发 60KB 帧（不分块）', true);
      } else if (phase === 'disconnect-test') {
        console.log('[B] 收到 screen-start，阶段3：直接断开连接（模拟被控端切断）');
        record('B 断开连接（模拟被控端切断控制）', true);
        try { wsB.close(); } catch (e) {}
        // 等待 A 是否收到 session-ended
        armTimeout(8, 'A 收到 session-ended');
      }
    }
  }
}

// ============ A：主控端 ============
function startA() {
  console.log('\n[A 主控端] 连接', SERVER);
  wsA = new WebSocket(SERVER + '?clientId=testflow-a-' + Date.now(), {
    timeout: 8000,
    ...(SERVER.startsWith('wss') ? { rejectUnauthorized: false } : {})
  });
  sendA = makeSender(wsA);
  const recvA = makeReceiver(onAMessage); // 每连接只创建一次

  wsA.on('open', () => console.log('[A] 已连接'));
  wsA.on('error', e => { console.log('[A] 连接错误:', e.message); summaryAndExit(); });
  wsA.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
    recvA(msg);
  });

  function onAMessage(msg) {
    if (msg.type === 'device-info') {
      console.log(`[A] 设备代码=${msg.deviceCode}`);
      console.log('[A] 发起 connect-device ->', codeB);
      sendA({ type: 'connect-device', targetCode: codeB, targetPassword: pwdB });
      armTimeout(10, 'connected（会话建立）');
    } else if (msg.type === 'connected') {
      record('A 收到 connected（会话建立成功）', true, 'role=controller');
      armTimeout(10, 'B 收到 screen-start 并回帧');
      console.log('[A] 发送 screen-start');
      sendA({ type: 'to-peer', payload: { type: 'screen-start' } });
    } else if (msg.type === 'from-peer' && msg.payload.type === 'screen-frame') {
      const got = msg.payload.image.length;
      const ok = got === image60.length;
      record(`${phase === 'chunked' ? '分块模式' : '直发模式'}: A 收到 screen-frame 且完整`, ok,
        `收到 ${(got / 1024).toFixed(1)}KB / 期望 ${(image60.length / 1024).toFixed(1)}KB`);
      // 当前阶段结束
      if (phase === 'chunked') {
        setTimeout(() => runPhase('direct'), 500);
      } else {
        setTimeout(() => runPhase('disconnect-test'), 500);
      }
    } else if (msg.type === 'session-ended') {
      record('阶段3: 被控端断开后 A 收到 session-ended', true, '断开通知正常');
      clearTimeout(failTimer);
      setTimeout(summaryAndExit, 500);
    }
  }
}

function runPhase(p) {
  phase = p;
  const label = p === 'chunked' ? '分块发送（新版客户端）'
    : p === 'direct' ? '直发（旧版客户端）' : '被控端断开通知';
  console.log(`\n========== 阶段测试: ${label} ==========`);
  if (wsA) { try { wsA.close(); } catch (e) {} }
  if (wsB) { try { wsB.close(); } catch (e) {} }
  setTimeout(() => startB(), 800);
}

console.log('目标服务器:', SERVER);
console.log('模拟帧大小:', FRAME_KB + 'KB base64');
runPhase('chunked');
