import { exec, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findAvailablePort } from './preflight.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const isDev = process.argv.includes('--dev');
const noOpen = process.argv.includes('--no-open');

const children = [];

function spawnManaged(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: rootDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...options,
  });
  children.push(child);
  return child;
}

function cleanup() {
  for (const child of children) {
    if (!child.killed) {
      try {
        child.kill();
      } catch {
        // ignore
      }
    }
  }
}

process.on('SIGINT', () => {
  cleanup();
  process.exit(0);
});
process.on('SIGTERM', () => {
  cleanup();
  process.exit(0);
});
process.on('exit', cleanup);

async function main() {
  if (isDev) {
    console.log('=== 启动前后端联合开发模式 ===');
    const backendPort = await findAvailablePort(Number(process.env.UI_PORT || 19190));
    const frontendPort = await findAvailablePort(
      Number(process.env.VITE_PORT || 5173),
      new Set([backendPort]),
    );
    const devEnv = {
      ...process.env,
      UI_PORT: String(backendPort),
      VITE_PORT: String(frontendPort),
    };

    const backend = spawnManaged(process.execPath, [path.join(__dirname, 'server.js')], {
      shell: false,
      env: devEnv,
    });
    const frontend = spawnManaged('npm', ['--prefix', 'web', 'run', 'dev'], {
      env: devEnv,
    });

    if (!noOpen) {
      setTimeout(() => {
        exec(`cmd /c start "" "http://127.0.0.1:${frontendPort}"`);
      }, 1200);
    }

    backend.on('exit', (code) => {
      cleanup();
      process.exit(code ?? 0);
    });
    frontend.on('exit', (code) => {
      cleanup();
      process.exit(code ?? 0);
    });
    return;
  }

  // 生产一键模式：若 web/dist 不存在则先自动构建
  const distIndex = path.join(rootDir, 'web', 'dist', 'index.html');
  let hasDist = true;
  try {
    await fs.access(distIndex);
  } catch {
    hasDist = false;
  }

  if (!hasDist) {
    console.log('未检测到前端构建产物，正在自动构建 Vue 3 界面...');
    await new Promise((resolve, reject) => {
      const build = spawn('npm', ['--prefix', 'web', 'run', 'build'], {
        cwd: rootDir,
        stdio: 'inherit',
        shell: process.platform === 'win32',
      });
      build.on('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`前端构建失败 (exit code: ${code})`));
      });
    });
  }

  const serverArgs = [path.join(__dirname, 'server.js')];
  if (!noOpen) serverArgs.push('--open');

  const server = spawnManaged(process.execPath, serverArgs, { shell: false });
  server.on('exit', (code) => {
    cleanup();
    process.exit(code ?? 0);
  });
}

main().catch((err) => {
  console.error(`启动失败: ${err.message}`);
  cleanup();
  process.exit(1);
});
