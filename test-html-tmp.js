
var __listeners = {};
var window = { 
  remoteAPI: {
    onCaptureStats: function(cb) { __listeners.capture = cb; return function(){}; },
    onRobotStatus: function(cb) { __listeners.robot = cb; return function(){}; },
    getDeviceInfo: function() { return Promise.resolve({deviceCode:'123 456 789',password:'test',serverConnected:false,session:null}); },
    refreshPassword: function() { return Promise.resolve({}); },
    connectDevice: function() { return Promise.resolve({}); },
    disconnect: function() { return Promise.resolve({}); },
    openScreenRecordSettings: function() { return Promise.resolve({}); },
    validateWsUrl: function() { return Promise.resolve({valid:false}); },
    saveWsUrl: function() { return Promise.resolve({}); },
    getWsUrl: function() { return Promise.resolve(null); },
    gotoHome: function() { return Promise.resolve({}); },
    gotoSetup: function() { return Promise.resolve({}); },
    onAppStatus: function() { return function(){}; },
    onDeviceInfo: function() { return function(){}; },
    onConnectError: function() { return function(){}; },
    onConnectOk: function() { return function(){}; },
    onIncomingControl: function() { return function(){}; },
    onCaptureStatus: function() { return function(){}; },
    onScreenFrameHeader: function() { return function(){}; },
    onScreenFrameChunk: function() { return function(){}; },
    onScreenFrame: function() { return function(){}; },
    onSessionEnded: function() { return function(){}; },
    onDiagStats: function() { return function(){}; }
  } 
};
var document = { 
  getElementById: function(id) { 
    return { 
      get textContent() { return ''; }, 
      set textContent(v) {},
      get innerHTML() { return ''; },
      set innerHTML(v) {},
      classList: { add: function(){}, remove: function(){}, toggle: function(){} },
      appendChild: function(){},
      removeChild: function(){},
      style: {}
    };
  },
  addEventListener: function() {}
};
var navigator = { clipboard: { writeText: function() { return Promise.resolve(true); } } };
var setTimeout = function() { return 0; };
var clearTimeout = function() {};
var console = { log: function(){ process.stdout.write('[LOG] ' + Array.prototype.join.call(arguments, ' ') + '\n'); } };


    const api = window.remoteAPI;
    const $ = (id) => document.getElementById(id);

    // ============ 工具 ============
    function fmtCode(c) {
      if (!c) return '--- --- ---';
      const s = c.replace(/\s/g, '');
      if (s.length !== 9) return s;
      return s.slice(0, 3) + ' ' + s.slice(3, 6) + ' ' + s.slice(6);
    }
    function cleanCode(s) { return (s || '').toString().replace(/\D/g, '').slice(0, 9); }

    let toastTimer = null;
    function toast(msg) {
      const el = $('toast');
      el.textContent = msg;
      el.classList.add('show');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => el.classList.remove('show'), 1600);
    }
    async function copyText(txt) {
      try {
        await navigator.clipboard.writeText(txt);
        return true;
      } catch (e) {
        try {
          const ta = document.createElement('textarea');
          ta.value = txt; document.body.appendChild(ta);
          ta.select(); document.execCommand('copy');
          document.body.removeChild(ta);
          return true;
        } catch (e2) { return false; }
      }
    }

    // ============ 渲染 ============
    function renderDevice(code, pwd) {
      $('deviceCode').textContent = fmtCode(code);
      $('password').textContent = pwd ? pwd : '------';
    }

    function renderServerStatus(connected) {
      const el = $('serverStatus');
      const txt = $('serverStatusText');
      if (connected) {
        el.classList.add('online'); el.classList.remove('offline');
        txt.textContent = '已连接服务器';
      } else {
        el.classList.remove('online'); el.classList.add('offline');
        txt.textContent = '正在连接服务器...';
      }
    }

    function renderSession(session) {
      const controlling = $('sessControlling');
      const controlled = $('sessControlled');
      const btnDisconnect = $('btnDisconnect');
      const connectArea = $('btnConnect');
      const inputs = [ $('inputCode'), $('inputPwd') ];

      if (!session) {
        controlling.classList.remove('show');
        controlled.classList.remove('show');
        btnDisconnect.style.display = 'none';
        connectArea.disabled = false;
        inputs.forEach(i => i.disabled = false);
        return;
      }
      btnDisconnect.style.display = 'block';
      connectArea.disabled = true;
      inputs.forEach(i => i.disabled = true);

      const prettyPeer = fmtCode(session.peerCode);
      if (session.role === 'controller') {
        controlling.classList.add('show');
        controlled.classList.remove('show');
        $('peerCodeA').textContent = prettyPeer;
      } else {
        controlling.classList.remove('show');
        controlled.classList.add('show');
        $('peerCodeB').textContent = prettyPeer;
      }
    }

    function showError(msg) {
      const el = $('errTip');
      el.textContent = '❌ ' + msg;
      el.classList.add('show');
      clearTimeout(showError._t);
      showError._t = setTimeout(() => el.classList.remove('show'), 4000);
    }
    function clearError() { $('errTip').classList.remove('show'); }

    // ============ 事件 ============
    // 修改服务器地址
    $('btnSettings').onclick = () => {
      if (api.gotoSetup) api.gotoSetup();
    };

    $('btnCopyCode').onclick = async () => {
      const info = await api.getDeviceInfo();
      if (info && info.deviceCode) {
        const c = cleanCode(info.deviceCode);
        if (await copyText(c)) toast('设备代码已复制');
      } else {
        toast('尚未获取到设备代码');
      }
    };
    $('btnCopyAll').onclick = async () => {
      const info = await api.getDeviceInfo();
      if (info && info.deviceCode && info.password) {
        const c = cleanCode(info.deviceCode);
        const text = `设备代码：${fmtCode(c)}\n密码：${info.password}`;
        if (await copyText(text)) toast('已复制设备代码+密码');
      } else {
        toast('尚未获取到本机信息');
      }
    };
    $('btnRefresh').onclick = async () => {
      await api.refreshPassword();
      toast('正在刷新密码...');
    };

    // 输入自动格式化
    $('inputCode').addEventListener('input', (e) => {
      const cleaned = cleanCode(e.target.value);
      e.target.value = fmtCode(cleaned).replace(/---/g, '').trim();
      clearError();
    });
    $('inputPwd').addEventListener('input', (e) => {
      e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
      clearError();
    });

    $('btnConnect').onclick = async () => {
      clearError();
      const rawCode = $('inputCode').value;
      const pwd = $('inputPwd').value;
      const code = cleanCode(rawCode);
      if (code.length !== 9) { showError('请输入9位设备代码'); return; }
      if (pwd.length !== 6) { showError('请输入6位密码'); return; }

      const info = await api.getDeviceInfo();
      if (!info || !info.serverConnected) { showError('尚未连接到服务器，请稍候重试'); return; }
      if (info.session) { showError('当前已有会话，请先断开'); return; }

      $('btnConnect').disabled = true;
      $('btnConnect').textContent = '连接中...';
      const ok = await api.connectDevice(code, pwd);
      if (!ok) {
        $('btnConnect').disabled = false;
        $('btnConnect').textContent = '连接远程设备';
        showError('发送失败，请检查网络');
      }
      // 成功/失败 会通过事件回调 updateSession / showError 处理
    };

    $('btnDisconnect').onclick = async () => {
      await api.disconnect();
      toast('已断开连接');
      renderSession(null);
    };

    // ============ 事件订阅 ============
    api.onAppStatus((s) => {
      renderServerStatus(!!s.serverConnected);
      renderDevice(s.deviceCode, s.password);
      renderSession(s.session);
    });
    api.onDeviceInfo((d) => {
      renderDevice(d.deviceCode, d.password);
      toast(d.password ? '密码已刷新' : '本机信息已更新');
    });
    api.onConnectError((msg) => {
      $('btnConnect').disabled = false;
      $('btnConnect').textContent = '连接远程设备';
      showError(msg);
    });
    api.onConnectOk((r) => {
      $('btnConnect').disabled = true;
      $('btnConnect').textContent = '已连接';
      toast(`已连接到 ${fmtCode(r.peerCode)}`);
    });
    api.onIncomingControl((r) => {
      toast(`设备 ${fmtCode(r.peerCode)} 正在控制本机`);
    });
    api.onCaptureStatus((s) => {
      const warn = $('captureWarn');
      const msg = $('captureWarnMsg');
      if (!s.ok) {
        msg.textContent = s.message || '屏幕捕获失败，请检查屏幕录制权限';
        warn.classList.add('show');
      } else {
        warn.classList.remove('show');
      }
    });
    $('btnFixCapture').onclick = () => {
      if (api.openScreenRecordSettings) {
        api.openScreenRecordSettings();
        toast('已打开系统设置，请开启屏幕录制权限');
      }
    };
    api.onSessionEnded(() => {
      renderSession(null);
      $('btnConnect').disabled = false;
      $('btnConnect').textContent = '连接远程设备';
      toast('会话已结束');
    });

    // ============ 被控端实时诊断 ============
    const diagData = { capture: null, robot: null };
    let captureLoggedError = '';
    let robotLoggedError = '';
    let robotReadyLogged = false;
    function renderDiag() {
      const el = $('diagText');
      if (!el) return;
      const c = diagData.capture, r = diagData.robot;
      if (!c && !r) { el.textContent = '未在控制会话中'; return; }
      const parts = [];
      if (c) {
        if (c.running) {
          if (c.frames > 0) {
            parts.push(`推流: ✅已发${c.frames}帧 ${c.lastSizeKB}KB/帧`);
          } else {
            parts.push(`推流: ⏳0帧`);
          }
          if (c.fails > 0) {
            parts.push(`失败${c.fails}次`);
          }
          if (c.error) {
            parts.push(`原因: ${c.error}`);
          }
        } else {
          parts.push('推流: ❌未启动');
        }
      }
      if (r) {
        if (r.loaded) {
          parts.push(`键鼠: ✅已加载 (${r.ready ? '就绪' : '初始化中'})`);
        } else {
          parts.push(`键鼠: ❌加载失败`);
          if (r.error) parts.push(`错误: ${r.error}`);
        }
        parts.push(`收到命令${r.cmds}条`);
      }
      el.innerHTML = parts.map(p => `<div>${p}</div>`).join('');
    }
    if (api.onCaptureStats) {
      api.onCaptureStats((c) => {
        diagData.capture = c;
        renderDiag();
        if (c.error && (!captureLoggedError || captureLoggedError !== c.error)) {
          captureLoggedError = c.error;
          console.log('[被控诊断] 推流错误:', c.error);
        }
        if (!c.running) {
          console.log('[被控诊断] 推流未启动');
        } else if (c.frames > 0) {
          if (c.frames % 10 === 0) console.log(`[被控诊断] 已发${c.frames}帧 ${c.lastSizeKB}KB/帧`);
        }
      });
    }
    if (api.onRobotStatus) {
      api.onRobotStatus((r) => {
        diagData.robot = r;
        renderDiag();
        if (!r.loaded && r.error && r.error !== robotLoggedError) {
          robotLoggedError = r.error;
          console.log('[被控诊断] 键鼠加载失败:', r.error);
        }
        if (r.loaded && !robotReadyLogged) {
          robotReadyLogged = true;
          console.log('[被控诊断] 键鼠模块已就绪');
        }
      });
    }

    // ============ 初始化 ============
    (async function init() {
      const s = await api.getDeviceInfo();
      renderServerStatus(!!s.serverConnected);
      renderDevice(s.deviceCode, s.password);
      renderSession(s.session);
    })();
  