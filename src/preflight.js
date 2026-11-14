import { exec, execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * 获取 Windows 上常见的 Clash Verge / Mihomo 内核候选路径。
 * @returns {string[]}
 */
export function getDefaultMihomoCandidates() {
  const localAppData = process.env.LOCALAPPDATA || '';
  const candidates = [
    'C:\\Program Files\\Clash Verge\\verge-mihomo.exe',
    'C:\\Program Files\\Clash Verge\\mihomo.exe',
  ];
  if (localAppData) {
    candidates.push(
      path.join(localAppData, 'Programs', 'Clash Verge', 'verge-mihomo.exe'),
      path.join(localAppData, 'Programs', 'Clash Verge', 'mihomo.exe'),
    );
  }
  return candidates;
}

/**
 * 检测指定端口在本地回环地址是否可用。
 * @param {number} port
 * @param {string} [host='127.0.0.1']
 * @returns {Promise<boolean>}
 */
export function isPortAvailable(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

/**
 * 从起始端口开始递增查找可用端口。
 * @param {number} startPort
 * @param {Set<number>} [excludePorts]
 * @returns {Promise<number>}
 */
export async function findAvailablePort(startPort, excludePorts = new Set()) {
  let port = startPort;
  while (port <= 65535) {
    if (!excludePorts.has(port) && (await isPortAvailable(port))) {
      return port;
    }
    port += 1;
  }
  throw new Error(`从端口 ${startPort} 起未找到可用端口`);
}

/**
 * 预检并分配不冲突的 mixedPort 与 controllerPort。
 * @param {{ mixedPort: number, controllerPort: number }} settings
 * @returns {Promise<{ mixedPort: number, controllerPort: number }>}
 */
export async function resolvePorts(settings) {
  const mixedPort = await findAvailablePort(settings.mixedPort);
  const controllerPort = await findAvailablePort(settings.controllerPort, new Set([mixedPort]));
  return { mixedPort, controllerPort };
}

export async function resolveWorkerPorts(settings, concurrency = 1) {
  const n = Math.min(16, Math.max(1, Number(concurrency) || 1));
  const used = new Set();
  const workerPorts = [];
  let nextStart = settings.mixedPort;
  for (let i = 0; i < n; i += 1) {
    const p = await findAvailablePort(nextStart, used);
    used.add(p);
    workerPorts.push(p);
    nextStart = p + 1;
  }
  const controllerPort = await findAvailablePort(settings.controllerPort, used);
  return { workerPorts, controllerPort };
}

/**
 * 确保目标 Mihomo 内核可执行文件可用：
 * 1. 优先检查 targetPath (bin/mihomo.exe) 是否存在；
 * 2. 若不存在，扫描 Clash Verge 常见安装路径，默认直接复用原路径（避免触发安全软件拦截），
 *    当 copyToTarget 为 true 时复制至 targetPath。
 * @param {string} targetPath
 * @param {string[]} [candidatePaths]
 * @param {{ copyToTarget?: boolean }} [options]
 * @returns {Promise<{ path: string, copiedFrom: string | null }>}
 */
export async function ensureMihomoBinary(
  targetPath,
  candidatePaths = getDefaultMihomoCandidates(),
  options = {},
) {
  const { copyToTarget = false } = options;
  try {
    await fs.access(targetPath);
    return { path: targetPath, copiedFrom: null };
  } catch {
    // 目标不存在，继续扫描候选路径
  }

  for (const candidate of candidatePaths) {
    try {
      await fs.access(candidate);
      if (copyToTarget) {
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.copyFile(candidate, targetPath);
        return { path: targetPath, copiedFrom: candidate };
      }
      return { path: candidate, copiedFrom: null };
    } catch {
      // 当前候选路径不可用，尝试下一个
    }
  }

  throw new Error(
    `未找到 Mihomo 内核 (${targetPath})。\n` +
      '已自动扫描以下常见路径均未找到:\n' +
      candidatePaths.map((p) => `  - ${p}`).join('\n') +
      '\n请手动将 mihomo.exe（Windows x64）复制到 bin/mihomo.exe 后重新运行。',
  );
}

function isLocalPortListening(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 150);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

async function detectWindowsSystemProxy() {
  if (process.platform !== 'win32') return false;
  try {
    const { stdout } = await execFileAsync(
      'reg',
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', '/v', 'ProxyEnable'],
      { timeout: 1500 },
    );
    return stdout.toLowerCase().includes('0x1');
  } catch {
    return false;
  }
}

async function detectWindowsVPNProcesses() {
  if (process.platform !== 'win32') return [];
  const known = [
    ['clash verge.exe', 'Clash Verge'],
    ['verge-mihomo.exe', 'Clash Verge (内核)'],
    ['mihomo-party.exe', 'Mihomo Party'],
    ['clash nyanpasu.exe', 'Clash Nyanpasu'],
    ['clash for windows.exe', 'Clash for Windows'],
    ['v2rayn.exe', 'v2rayN'],
    ['nekoray.exe', 'Nekoray'],
    ['nekobox.exe', 'NekoBox'],
    ['hiddify.exe', 'Hiddify'],
    ['sing-box.exe', 'sing-box'],
  ];
  try {
    const { stdout } = await execFileAsync('tasklist', ['/FO', 'CSV', '/NH'], { timeout: 2000 });
    const lower = stdout.toLowerCase();
    const found = [];
    for (const [exe, label] of known) {
      if (lower.includes(`"${exe}"`) && !found.includes(label)) {
        found.push(label);
      }
    }
    return found;
  } catch {
    return [];
  }
}

/**
 * 检测本机是否正在运行常见 VPN 软件、代理端口或系统代理。
 */
export async function detectRunningVPN() {
  const commonPorts = [
    [7890, 'Clash 默认代理端口 (7890)'],
    [7897, 'Clash Verge 代理端口 (7897)'],
    [10808, 'v2rayN SOCKS 端口 (10808)'],
    [10809, 'v2rayN HTTP 端口 (10809)'],
    [2080, 'Nekoray 代理端口 (2080)'],
    [9097, 'Clash Verge 控制端口 (9097)'],
  ];

  const [processes, systemProxy, portChecks] = await Promise.all([
    detectWindowsVPNProcesses(),
    detectWindowsSystemProxy(),
    Promise.all(commonPorts.map(async ([port, label]) => ({ port, label, open: await isLocalPortListening(port) }))),
  ]);

  const ports = portChecks.filter((p) => p.open).map((p) => p.port);
  const portLabels = portChecks.filter((p) => p.open).map((p) => p.label);
  const envValues = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']
    .map((k) => String(process.env[k] || '').trim())
    .filter(Boolean);
  let envProxy = false;
  for (const raw of envValues) {
    try {
      const u = new URL(raw.includes('://') ? raw : `http://${raw}`);
      const host = u.hostname.toLowerCase();
      const port = Number(u.port);
      if ((host === '127.0.0.1' || host === 'localhost' || host === '::1') && port > 0) {
        const alive = await isLocalPortListening(port);
        if (!alive) continue;
      }
      envProxy = true;
      break;
    } catch {
      envProxy = true;
      break;
    }
  }

  const warnings = [];
  if (processes.length > 0) warnings.push(`检测到 VPN 客户端进程: ${processes.join('、')}`);
  if (portLabels.length > 0) warnings.push(`检测到本地代理端口占用: ${portLabels.join('、')}`);
  if (systemProxy) warnings.push('检测到 Windows 系统代理已开启');
  if (envProxy) warnings.push('检测到终端环境变量代理 (HTTP_PROXY/HTTPS_PROXY)');

  const autoClosable = await inspectActiveSupportedVPNs();
  const detected = processes.length > 0 || ports.length > 0 || systemProxy || envProxy;
  const message = detected
    ? '检测到本机可能正在运行 VPN 软件或已开启系统代理，建议根据情况先关闭（尤其是 TUN 模式）后再测速，避免影响测速准确性。'
    : '未检测到常见 VPN 软件或系统代理运行，可直接开始测速（如开启了其他 TUN 虚拟网卡，请先关闭）。';

  return { detected, processes, ports, systemProxy, envProxy, autoClosable, warnings, message };
}

const SUPPORTED_VPN_WHITELIST = {
  'clash-verge.exe': { name: 'Clash Verge', subCores: ['verge-mihomo.exe', 'verge-mihomo-alpha.exe'] },
  'mihomo-party.exe': { name: 'Mihomo Party', subCores: ['mihomo.exe', 'mihomo-alpha.exe'] },
  'clash-nyanpasu.exe': { name: 'Clash Nyanpasu', subCores: ['mihomo.exe', 'nyanpasu-mihomo.exe'] },
  'clash for windows.exe': { name: 'Clash for Windows', subCores: ['clash-win64.exe'] },
  'v2rayn.exe': { name: 'v2rayN', subCores: ['xray.exe', 'sing-box.exe', 'v2ray.exe'] },
  'nekoray.exe': { name: 'NekoRay', subCores: ['nekobox_core.exe', 'sing-box.exe'] },
  'nekobox.exe': { name: 'NekoBox', subCores: ['nekobox_core.exe', 'sing-box.exe'] },
};

export async function inspectActiveSupportedVPNs() {
  if (process.platform !== 'win32') return [];
  const cmd =
    'powershell -NoProfile -NonInteractive -Command "Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath } | Select-Object ProcessId, Name, ExecutablePath | ConvertTo-Json -Compress"';
  const stdout = await new Promise((resolve) => {
    exec(cmd, { timeout: 3000 }, (err, out) => resolve(err ? '' : out || ''));
  });
  const raw = String(stdout).trim();
  if (!raw) return [];
  let rows = [];
  try {
    const parsed = JSON.parse(raw);
    rows = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
  const seen = new Set();
  const items = [];
  for (const row of rows) {
    const lower = String(row?.Name || '').trim().toLowerCase();
    const spec = SUPPORTED_VPN_WHITELIST[lower];
    const exePath = String(row?.ExecutablePath || '').trim();
    if (!spec || !exePath || seen.has(lower)) continue;
    seen.add(lower);
    items.push({
      name: spec.name,
      processName: row.Name,
      exePath,
      pid: Number(row.ProcessId) || 0,
    });
  }
  return items;
}

export async function shutdownSupportedVPNs() {
  if (process.platform !== 'win32') {
    throw new Error('当前系统暂不支持自动退出 VPN，请手动关闭后再测速');
  }
  const active = await inspectActiveSupportedVPNs();
  if (active.length === 0) return [];

  await new Promise((resolve) => {
    exec(
      'reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 0 /f',
      { timeout: 2000 },
      () => resolve(),
    );
  });

  const procNames = new Set();
  for (const item of active) {
    procNames.add(item.processName);
    const spec = SUPPORTED_VPN_WHITELIST[item.processName.toLowerCase()];
    if (spec) {
      for (const sub of spec.subCores) procNames.add(sub);
    }
  }

  for (const pname of procNames) {
    await new Promise((resolve) => {
      exec(`taskkill /IM "${pname}" /F /T`, { timeout: 2500 }, () => resolve());
    });
  }

  await new Promise((r) => setTimeout(r, 600));
  const stillAlive = await inspectActiveSupportedVPNs();
  if (stillAlive.length > 0) {
    throw new Error(
      `无法自动退出 ${stillAlive.map((s) => s.name).join('、')}（可能以管理员权限运行或开启了系统服务），请手动右键托盘退出后再试`,
    );
  }
  return active;
}

export async function launchVPNByPath(exePath) {
  if (process.platform !== 'win32') {
    throw new Error('当前系统暂不支持自动启动 VPN');
  }
  const cleaned = String(exePath || '').trim();
  if (!cleaned || path.extname(cleaned).toLowerCase() !== '.exe') {
    throw new Error('非法的程序路径，仅允许启动 .exe 客户端');
  }
  const st = await fs.stat(cleaned).catch(() => null);
  if (!st || !st.isFile()) {
    throw new Error(`未找到 VPN 程序文件: ${cleaned}`);
  }
  const base = path.basename(cleaned).toLowerCase();
  if (!SUPPORTED_VPN_WHITELIST[base]) {
    throw new Error('该程序不在支持的 VPN 白名单内，请手动打开');
  }
  const child = spawn(cleaned, [], {
    cwd: path.dirname(cleaned),
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}
