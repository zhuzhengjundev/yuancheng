/**
 * Windows 键鼠控制模块（无需 native 编译）
 * 通过 PowerShell 内嵌 C# 调用 user32.dll API 实现
 *
 * 启动一个常驻 PowerShell 进程，通过 stdin 接收 JSON 命令，响应式执行。
 * 相比每次 spawn 新进程，响应延迟和CPU占用都低很多。
 */

const { spawn } = require('child_process');
const { screen } = require('electron');

// =============== C# 封装代码 ===============
// 使用 SendInput（比 mouse_event/keybd_event 更现代、更可靠）
const CS_CODE = `
using System;
using System.Runtime.InteropServices;
using System.Threading;
using System.Text;

public class WinRobot {
    // ===== User32 API =====
    [DllImport("user32.dll")]
    static extern bool SetCursorPos(int X, int Y);

    [DllImport("user32.dll")]
    static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);

    [DllImport("user32.dll")]
    static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

    [DllImport("user32.dll")]
    static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    [DllImport("user32.dll")]
    static extern short VkKeyScan(char ch);

    [DllImport("user32.dll")]
    static extern IntPtr GetMessageExtraInfo();

    [DllImport("user32.dll")]
    static extern bool ClipCursor(ref RECT lpRect);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT {
        public int Left, Top, Right, Bottom;
    }

    // ===== mouse_event flags =====
    const uint MOUSEEVENTF_MOVE       = 0x0001;
    const uint MOUSEEVENTF_LEFTDOWN   = 0x0002;
    const uint MOUSEEVENTF_LEFTUP     = 0x0004;
    const uint MOUSEEVENTF_RIGHTDOWN  = 0x0008;
    const uint MOUSEEVENTF_RIGHTUP    = 0x0010;
    const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
    const uint MOUSEEVENTF_MIDDLEUP   = 0x0040;
    const uint MOUSEEVENTF_WHEEL      = 0x0800;
    const uint MOUSEEVENTF_HWHEEL     = 0x1000;
    const uint MOUSEEVENTF_ABSOLUTE   = 0x8000;

    // ===== keybd_event flags =====
    const uint KEYEVENTF_KEYUP = 0x0002;
    const uint KEYEVENTF_UNICODE = 0x0004;
    const uint KEYEVENTF_SCANCODE = 0x0008;

    // ===== Virtual Keys (常用) =====
    static byte VK(string k) {
        switch (k.ToLower()) {
            case "backspace": case "back": return 0x08;
            case "tab": return 0x09;
            case "enter": case "return": return 0x0D;
            case "shift": return 0x10;
            case "control": case "ctrl": return 0x11;
            case "alt": return 0x12;
            case "pause": return 0x13;
            case "capslock": case "caps_lock": return 0x14;
            case "escape": case "esc": return 0x1B;
            case "space": return 0x20;
            case "pageup": case "page_up": return 0x21;
            case "pagedown": case "page_down": return 0x22;
            case "end": return 0x23;
            case "home": return 0x24;
            case "left": case "arrowleft": return 0x25;
            case "up": case "arrowup": return 0x26;
            case "right": case "arrowright": return 0x27;
            case "down": case "arrowdown": return 0x28;
            case "insert": return 0x2D;
            case "delete": return 0x2E;
            case "command": case "win": case "meta": return 0x5B;
            case "numlock": case "num_lock": return 0x90;
            case "scrolllock": case "scroll_lock": return 0x91;
            case ";": case ":": return 0xBA;
            case "=": case "+": return 0xBB;
            case ",": case "<": return 0xBC;
            case "-": case "_": return 0xBD;
            case ".": case ">": return 0xBE;
            case "/": case "?": return 0xBF;
            case "`": case "~": return 0xC0;
            case "[": case "{": return 0xDB;
            case "\\": case "|": return 0xDC;
            case "]": case "}": return 0xDD;
            case "'": case "\"": return 0xDE;
            case "numpad_0": return 0x60;
            case "numpad_1": return 0x61;
            case "numpad_2": return 0x62;
            case "numpad_3": return 0x63;
            case "numpad_4": return 0x64;
            case "numpad_5": return 0x65;
            case "numpad_6": return 0x66;
            case "numpad_7": return 0x67;
            case "numpad_8": return 0x68;
            case "numpad_9": return 0x69;
            case "numpad_multiply": return 0x6A;
            case "numpad_add": return 0x6B;
            case "numpad_enter": return 0x0D;
            case "numpad_subtract": return 0x6D;
            case "numpad_decimal": return 0x6E;
            case "numpad_divide": return 0x6F;
            case "f1": return 0x70; case "f2": return 0x71; case "f3": return 0x72; case "f4": return 0x73;
            case "f5": return 0x74; case "f6": return 0x75; case "f7": return 0x76; case "f8": return 0x77;
            case "f9": return 0x78; case "f10": return 0x79; case "f11": return 0x7A; case "f12": return 0x7B;
            default:
                if (k.Length == 1) {
                    char c = k[0];
                    if (c >= '0' && c <= '9') return (byte)c;
                    if (c >= 'a' && c <= 'z') return (byte)(c - 32); // 转大写
                    if (c >= 'A' && c <= 'Z') return (byte)c;
                }
                return 0;
        }
    }

    // ===== 状态 =====
    static int screenW = 1920, screenH = 1080;
    static readonly object _lock = new object();

    public static void SetScreenSize(int w, int h) {
        screenW = w; screenH = h;
    }

    // 相对坐标 (0.0 - 1.0) -> 像素
    static int RX(double x) { return Math.Max(0, Math.Min(screenW - 1, (int)Math.Round(x * screenW))); }
    static int RY(double y) { return Math.Max(0, Math.Min(screenH - 1, (int)Math.Round(y * screenH))); }

    public static void MoveMouse(double x, double y) {
        lock (_lock) SetCursorPos(RX(x), RY(y));
    }

    public static void MouseClick(double x, double y, string button, bool dbl) {
        lock (_lock) {
            int px = RX(x), py = RY(y);
            SetCursorPos(px, py);
            Thread.Sleep(2);
            uint down = 0, up = 0;
            switch (button) {
                case "right": down = MOUSEEVENTF_RIGHTDOWN; up = MOUSEEVENTF_RIGHTUP; break;
                case "middle": down = MOUSEEVENTF_MIDDLEDOWN; up = MOUSEEVENTF_MIDDLEUP; break;
                default: down = MOUSEEVENTF_LEFTDOWN; up = MOUSEEVENTF_LEFTUP; break;
            }
            mouse_event(down, 0, 0, 0, UIntPtr.Zero);
            Thread.Sleep(1);
            mouse_event(up, 0, 0, 0, UIntPtr.Zero);
            if (dbl) {
                Thread.Sleep(40);
                mouse_event(down, 0, 0, 0, UIntPtr.Zero);
                Thread.Sleep(1);
                mouse_event(up, 0, 0, 0, UIntPtr.Zero);
            }
        }
    }

    public static void MouseDown(double x, double y, string button) {
        lock (_lock) {
            int px = RX(x), py = RY(y);
            SetCursorPos(px, py);
            uint down;
            switch (button) {
                case "right": down = MOUSEEVENTF_RIGHTDOWN; break;
                case "middle": down = MOUSEEVENTF_MIDDLEDOWN; break;
                default: down = MOUSEEVENTF_LEFTDOWN; break;
            }
            mouse_event(down, 0, 0, 0, UIntPtr.Zero);
        }
    }

    public static void MouseUp(string button) {
        lock (_lock) {
            uint up;
            switch (button) {
                case "right": up = MOUSEEVENTF_RIGHTUP; break;
                case "middle": up = MOUSEEVENTF_MIDDLEUP; break;
                default: up = MOUSEEVENTF_LEFTUP; break;
            }
            mouse_event(up, 0, 0, 0, UIntPtr.Zero);
        }
    }

    public static void MouseScroll(int dx, int dy) {
        lock (_lock) {
            if (dy != 0) mouse_event(MOUSEEVENTF_WHEEL, 0, 0, (uint)(dy * 120), UIntPtr.Zero);
            if (dx != 0) mouse_event(MOUSEEVENTF_HWHEEL, 0, 0, (uint)(dx * 120), UIntPtr.Zero);
        }
    }

    public static void KeyDown(string key) {
        byte vk = VK(key);
        if (vk == 0) return;
        lock (_lock) keybd_event(vk, 0, 0, UIntPtr.Zero);
    }

    public static void KeyUp(string key) {
        byte vk = VK(key);
        if (vk == 0) return;
        lock (_lock) keybd_event(vk, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
    }

    public static void KeyTap(string key, string[] mods) {
        // 先按下修饰键，再按主键，再松开
        lock (_lock) {
            byte vk = VK(key);
            if (vk == 0 && key.Length > 1) return;
            if (mods != null) foreach (var m in mods) {
                byte mvk = VK(m); if (mvk > 0) keybd_event(mvk, 0, 0, UIntPtr.Zero);
            }
            Thread.Sleep(1);
            if (vk > 0) {
                keybd_event(vk, 0, 0, UIntPtr.Zero);
                Thread.Sleep(1);
                keybd_event(vk, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
            } else if (key.Length == 1) {
                // 未知键名，按单个字符发送
                char c = key[0];
                short vkScan = VkKeyScan(c);
                byte shiftState = (byte)((vkScan >> 8) & 0xFF);
                byte realVk = (byte)(vkScan & 0xFF);
                bool needShift = (shiftState & 1) != 0;
                if (needShift) {
                    // 之前可能已经有修饰键了，这里简单处理：再按一次shift
                    bool hadShift = false;
                    if (mods != null) foreach (var m in mods) if (m == "shift") hadShift = true;
                    if (!hadShift) keybd_event(VK("shift"), 0, 0, UIntPtr.Zero);
                }
                if (realVk > 0) {
                    keybd_event(realVk, 0, 0, UIntPtr.Zero);
                    Thread.Sleep(1);
                    keybd_event(realVk, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
                }
                if (needShift) {
                    bool hadShift = false;
                    if (mods != null) foreach (var m in mods) if (m == "shift") hadShift = true;
                    if (!hadShift) keybd_event(VK("shift"), 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
                }
            }
            Thread.Sleep(1);
            // 松开修饰键（倒序）
            if (mods != null) {
                Array.Reverse(mods);
                foreach (var m in mods) {
                    byte mvk = VK(m); if (mvk > 0) keybd_event(mvk, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
                }
            }
        }
    }

    // 通过 KEYEVENTF_UNICODE 发送字符串（支持中文等Unicode字符）
    public static void TypeString(string s) {
        if (string.IsNullOrEmpty(s)) return;
        lock (_lock) {
            foreach (char c in s) {
                keybd_event(0, (byte)c, KEYEVENTF_UNICODE, UIntPtr.Zero);
                Thread.Sleep(1);
                keybd_event(0, (byte)c, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP, UIntPtr.Zero);
                Thread.Sleep(1);
            }
        }
    }
}
`;

// =============== Node 封装 ===============

let psProcess = null;
let initialized = false;
let initPromise = null;
let sendQueue = [];

// 初始化 PowerShell 进程并编译 C# 代码
function init() {
  if (initialized) return Promise.resolve(true);
  if (initPromise) return initPromise;

  initPromise = new Promise((resolve) => {
    try {
      psProcess = spawn('powershell.exe', [
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-Command', '-'
      ], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      });

      psProcess.on('error', (err) => {
        console.error('[WinRobot] PowerShell启动失败:', err.message);
        initialized = false;
        initPromise = null;
        resolve(false);
      });

      psProcess.on('exit', (code) => {
        console.warn('[WinRobot] PowerShell进程退出 code=' + code);
        initialized = false;
        initPromise = null;
        psProcess = null;
      });

      // stdin: 写入C#代码并进入命令读取循环
      const bootScript = `
Add-Type -TypeDefinition @'
${CS_CODE}
'@ -Language CSharp

# 发送就绪信号
Write-Output "WINROBOT_READY"
[Console]::Error.WriteLine("WINROBOT_READY")

# 循环从标准输入读取命令
while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    $line = $line.Trim()
    if ($line -eq '' -or $line -eq 'exit') { break }
    try {
        $cmd = $line | ConvertFrom-Json
        $op = $cmd.op
        switch ($op) {
            'resize' { [WinRobot]::SetScreenSize([int]$cmd.w, [int]$cmd.h) }
            'mm' { [WinRobot]::MoveMouse([double]$cmd.x, [double]$cmd.y) }
            'mc' { [WinRobot]::MouseClick([double]$cmd.x, [double]$cmd.y, [string]$cmd.b, [bool]$cmd.d) }
            'md' { [WinRobot]::MouseDown([double]$cmd.x, [double]$cmd.y, [string]$cmd.b) }
            'mu' { [WinRobot]::MouseUp([string]$cmd.b) }
            'ms' { [WinRobot]::MouseScroll([int]$cmd.dx, [int]$cmd.dy) }
            'kd' { [WinRobot]::KeyDown([string]$cmd.k) }
            'ku' { [WinRobot]::KeyUp([string]$cmd.k) }
            'kt' {
                $mods = @()
                if ($cmd.m) { $mods = [string[]]$cmd.m }
                [WinRobot]::KeyTap([string]$cmd.k, $mods)
            }
            'ts' { [WinRobot]::TypeString([string]$cmd.s) }
        }
        Write-Output "OK"
    } catch {
        Write-Output "ERR"
    }
}
`;

      psProcess.stdin.write(bootScript + '\n');
      psProcess.stdin.write("echo 'BOOTSTRAP_DONE'\n");

      let ready = false;
      let gotReady = false;

      const onStdoutData = (data) => {
        const str = data.toString();
        if (!ready) {
          if (str.includes('WINROBOT_READY') || str.includes('BOOTSTRAP_DONE')) {
            gotReady = true;
          }
          if (gotReady && psProcess) {
            ready = true;
            initialized = true;
            // 立即更新屏幕尺寸
            const primaryDisplay = screen.getPrimaryDisplay();
            const { width, height } = primaryDisplay.workAreaSize;
            _sendRaw(JSON.stringify({ op: 'resize', w: width, h: height }) + '\n');
            // 清理之前排队的命令
            for (const q of sendQueue) psProcess.stdin.write(q);
            sendQueue = [];
            psProcess.stdout.off('data', onStdoutData);
            resolve(true);
          }
        }
      };

      psProcess.stdout.on('data', onStdoutData);
      psProcess.stderr.on('data', (data) => {
        const s = data.toString();
        if (s.includes('WINROBOT_READY')) {
          gotReady = true;
        }
        if (!s.includes('WINROBOT_READY') && !s.trim().startsWith('BOOTSTRAP_')) {
          // 正常错误输出（C#编译警告等）
        }
      });

      // 超时保护（15秒）
      setTimeout(() => {
        if (!initialized) {
          console.error('[WinRobot] 初始化超时');
          resolve(false);
        }
      }, 15000);

    } catch (e) {
      console.error('[WinRobot] 初始化异常:', e.message);
      resolve(false);
    }
  });

  return initPromise;
}

function _sendRaw(data) {
  if (psProcess && psProcess.stdin && psProcess.stdin.writable) {
    try {
      psProcess.stdin.write(data);
      return true;
    } catch (e) {
      console.error('[WinRobot] 写入失败:', e.message);
      return false;
    }
  }
  return false;
}

async function sendCmd(cmd) {
  if (!initialized) {
    const ok = await init();
    if (!ok) return false;
  }
  const line = JSON.stringify(cmd) + '\n';
  return _sendRaw(line);
}

// =============== 导出的接口（与之前robotjs用法保持一致） ===============

async function updateScreenSize() {
  try {
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width, height } = primaryDisplay.workAreaSize;
    return sendCmd({ op: 'resize', w: width, h: height });
  } catch (e) { return false; }
}

async function moveMouse(x, y) {
  return sendCmd({ op: 'mm', x, y });
}

async function mouseClick(x, y, button = 'left', doubleClick = false) {
  return sendCmd({ op: 'mc', x, y, b: button, d: doubleClick });
}

async function mouseDown(x, y, button = 'left') {
  return sendCmd({ op: 'md', x, y, b: button });
}

async function mouseUp(button = 'left') {
  return sendCmd({ op: 'mu', b: button });
}

async function scrollMouse(dx, dy) {
  return sendCmd({ op: 'ms', dx, dy });
}

async function keyDown(key) {
  return sendCmd({ op: 'kd', k: key });
}

async function keyUp(key) {
  return sendCmd({ op: 'ku', k: key });
}

async function keyTap(key, modifiers = []) {
  return sendCmd({ op: 'kt', k: key, m: modifiers });
}

async function typeString(str) {
  return sendCmd({ op: 'ts', s: str });
}

function isReady() {
  return initialized;
}

// 屏幕分辨率变化时更新
try {
  screen.on('display-metrics-changed', () => updateScreenSize());
} catch (e) {}

module.exports = {
  init,
  updateScreenSize,
  moveMouse,
  mouseClick,
  mouseDown,
  mouseUp,
  scrollMouse,
  keyDown,
  keyUp,
  keyTap,
  typeString,
  isReady
};
