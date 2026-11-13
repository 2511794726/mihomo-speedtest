import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

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
