import { exec } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SETTINGS, loadSettings } from './config.js';
import { resolvePorts, ensureMihomoBinary, findAvailablePort } from './preflight.js';
import { prepareRuntimeSubscription } from './subscribe.js';
import { startMihomoProcess, fetchFilteredProxies } from './mihomo.js';
import { runSerialSpeedTests } from './tester.js';
import {
  sortResults,
  saveSpeedRank,
  applyTopNodeToClashVerge,
  listHistorySnapshots,
  loadHistorySnapshot,
} from './report.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const settingsPath = path.join(rootDir, 'settings.json');
const configsDir = path.join(rootDir, 'configs');
const binaryPath = path.join(rootDir, 'bin', 'mihomo.exe');
const outputPath = path.join(rootDir, 'results', 'speed-rank.json');
const historyDir = path.join(rootDir, 'results', 'history');
const distDir = path.join(rootDir, 'web', 'dist');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const sseClients = new Set();

const jobState = {
  running: false,
  stage: 'idle',
  total: 0,
  completed: 0,
  sortBy: 'avg',
  results: [],
  logs: [],
  abortController: null,
  activeMihomo: null,
};

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    res.write(payload);
  }
}

function pushLog(message) {
  const entry = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${message}`;
  jobState.logs.push(entry);
  if (jobState.logs.length > 200) jobState.logs.shift();
  broadcast('log', { message: entry });
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(data));
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
}

async function runSpeedtestJob({ sortBy = 'avg', limit = 0 }) {
  jobState.running = true;
  jobState.stage = 'preflight';
  jobState.total = 0;
  jobState.completed = 0;
  jobState.sortBy = sortBy;
  jobState.results = [];
  jobState.logs = [];
  jobState.abortController = new AbortController();

  broadcast('state', {
    running: true,
    stage: jobState.stage,
    total: 0,
    completed: 0,
    sortBy,
  });

  try {
    const { settings } = await loadSettings(settingsPath);
    pushLog('正在预检端口与 Mihomo 内核...');
    const { mixedPort, controllerPort } = await resolvePorts(settings);
    const binInfo = await ensureMihomoBinary(binaryPath);
    pushLog(`内核就绪: ${binInfo.path} (mixedPort=${mixedPort}, controllerPort=${controllerPort})`);

    if (jobState.abortController.signal.aborted) throw new Error('测速已被用户取消');

    jobState.stage = 'subscribe';
    broadcast('state', { running: true, stage: jobState.stage, total: 0, completed: 0, sortBy });
    pushLog('正在拉取并解析订阅...');
    const subInfo = await prepareRuntimeSubscription(settings, {
      mixedPort,
      controllerPort,
      configsDir,
    });
    pushLog(
      `订阅解析完成 (${subInfo.source} / ${subInfo.format}${subInfo.usedUserAgent ? ` / ${subInfo.usedUserAgent}` : ''})`,
    );

    if (jobState.abortController.signal.aborted) throw new Error('测速已被用户取消');

    jobState.stage = 'starting-core';
    broadcast('state', { running: true, stage: jobState.stage, total: 0, completed: 0, sortBy });
    pushLog('正在拉起 Mihomo 内核...');

    const mihomo = await startMihomoProcess({
      binaryPath: binInfo.path,
      configsDir,
      runtimeYamlPath: subInfo.runtimeYamlPath,
      controllerPort,
      controllerSecret: settings.controllerSecret,
      hasProviders: subInfo.hasProviders,
    });
    jobState.activeMihomo = mihomo;

    try {
      const controllerCtx = {
        controllerPort,
        controllerSecret: settings.controllerSecret,
        dispatcher: mihomo.dispatcher,
      };

      let nodes = await fetchFilteredProxies(controllerCtx, settings.excludeKeywords, {
        includeRegions: settings.includeRegions,
        includeKeywords: settings.includeKeywords,
        regionKeywords: settings.regionKeywords,
      });
      if (nodes.length === 0) {
        pushLog('未发现符合条件的有效出站节点。');
        return;
      }
      if (limit > 0 && nodes.length > limit) {
        pushLog(`共发现 ${nodes.length} 个有效节点，按设置抽测前 ${limit} 个节点...`);
        nodes = nodes.slice(0, limit);
      } else {
        pushLog(`共发现 ${nodes.length} 个有效节点，开始串行双阶段测速...`);
      }

      jobState.stage = 'testing';
      jobState.total = nodes.length;
      broadcast('state', {
        running: true,
        stage: jobState.stage,
        total: jobState.total,
        completed: 0,
        sortBy,
      });

      const rawResults = await runSerialSpeedTests(nodes, {
        ...controllerCtx,
        mixedPort,
        settings,
        signal: jobState.abortController.signal,
        onProgress: ({ index, total, result }) => {
          jobState.completed = index;
          jobState.results.push(result);
          const msg =
            result.latencyMs === null
              ? `[${index}/${total}] ${result.name} -> ${result.status}`
              : result.status !== 'OK'
                ? `[${index}/${total}] ${result.name} -> 延迟 ${result.latencyMs}ms | 失败 (${result.error || result.status})`
                : `[${index}/${total}] ${result.name} -> 延迟 ${result.latencyMs}ms | 均速 ${result.avgSpeedMBps.toFixed(2)} MB/s | 稳态 ${result.steadySpeedMBps.toFixed(2)} MB/s`;
          pushLog(msg);
          broadcast('progress', {
            index,
            total,
            result,
          });
        },
      });

      const sorted = sortResults(rawResults, sortBy);
      jobState.results = sorted;
      await saveSpeedRank(sorted, outputPath, sortBy);

      if (jobState.abortController.signal.aborted) {
        pushLog(`测速已手动中止，已保存当前 ${sorted.length} 个节点的结果。`);
      } else {
        pushLog(`全部测速完成！结果已保存至 results/speed-rank.json`);
      }

      broadcast('done', {
        aborted: jobState.abortController.signal.aborted,
        results: sorted,
      });
    } finally {
      jobState.activeMihomo = null;
      await mihomo.stop();
    }
  } catch (err) {
    pushLog(`测速异常终止: ${err.message}`);
    broadcast('error', { message: err.message });
  } finally {
    jobState.running = false;
    jobState.stage = 'idle';
    jobState.abortController = null;
    broadcast('state', {
      running: false,
      stage: 'idle',
      total: jobState.total,
      completed: jobState.completed,
      sortBy: jobState.sortBy,
    });
  }
}

async function serveStatic(reqPath, res) {
  let relPath = reqPath === '/' ? 'index.html' : reqPath.replace(/^\/+/, '');
  let target = path.join(distDir, relPath);
  try {
    const stat = await fs.stat(target);
    if (stat.isDirectory()) {
      target = path.join(target, 'index.html');
    }
  } catch {
    target = path.join(distDir, 'index.html');
  }

  try {
    const content = await fs.readFile(target);
    const ext = path.extname(target).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    res.end(content);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('前端静态资源尚未构建，请先在 web/ 目录运行 npm run build，或使用 Vite 开发模式 (npm run dev)。');
  }
}

export function createApiServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);

    try {
      if (req.method === 'GET' && url.pathname === '/api/settings') {
        const { settings } = await loadSettings(settingsPath);
        return sendJson(res, 200, { settings });
      }

      if (req.method === 'PUT' && url.pathname === '/api/settings') {
        const body = await readJsonBody(req);
        const { settings: current } = await loadSettings(settingsPath);
        const updated = {
          ...DEFAULT_SETTINGS,
          ...current,
          ...body,
        };
        await fs.writeFile(settingsPath, JSON.stringify(updated, null, 2) + '\n', 'utf8');
        return sendJson(res, 200, { settings: updated });
      }

      if (req.method === 'GET' && url.pathname === '/api/results') {
        if (jobState.running && jobState.results.length > 0) {
          return sendJson(res, 200, {
            running: true,
            results: jobState.results,
            sortBy: jobState.sortBy,
          });
        }
        try {
          const raw = await fs.readFile(outputPath, 'utf8');
          const data = JSON.parse(raw);
          return sendJson(res, 200, { running: false, ...data });
        } catch {
          return sendJson(res, 200, { running: false, results: [], totalNodes: 0, okNodes: 0 });
        }
      }

      if (req.method === 'GET' && url.pathname === '/api/history') {
        const items = await listHistorySnapshots(historyDir);
        return sendJson(res, 200, { history: items });
      }

      if (req.method === 'GET' && url.pathname === '/api/history/node') {
        const nodeName = url.searchParams.get('name') || '';
        if (!nodeName) {
          return sendJson(res, 400, { error: '缺少 name 参数' });
        }
        const snapshots = await listHistorySnapshots(historyDir);
        const records = [];
        for (const snap of snapshots.slice(0, 15)) {
          try {
            const full = await loadHistorySnapshot(historyDir, snap.id);
            const match = (full.results || []).find((r) => r.name === nodeName);
            if (match) {
              records.push({
                id: snap.id,
                generatedAt: snap.generatedAt,
                ...match,
              });
            }
          } catch {
            // ignore
          }
        }
        return sendJson(res, 200, { nodeName, records });
      }

      if (req.method === 'GET' && url.pathname.startsWith('/api/history/')) {
        const id = decodeURIComponent(url.pathname.slice('/api/history/'.length));
        try {
          const snapshot = await loadHistorySnapshot(historyDir, id);
          return sendJson(res, 200, snapshot);
        } catch {
          return sendJson(res, 404, { error: '未找到对应的历史记录' });
        }
      }

      if (req.method === 'GET' && url.pathname === '/api/speedtest/stream') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        sseClients.add(res);
        res.write(
          `event: init\ndata: ${JSON.stringify({
            running: jobState.running,
            stage: jobState.stage,
            total: jobState.total,
            completed: jobState.completed,
            sortBy: jobState.sortBy,
            results: jobState.results,
            logs: jobState.logs,
          })}\n\n`,
        );
        req.on('close', () => sseClients.delete(res));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/speedtest/start') {
        if (jobState.running) {
          return sendJson(res, 409, { error: '已有测速任务正在运行中' });
        }
        const body = await readJsonBody(req);
        if (typeof body.subscribeUrl === 'string' && body.subscribeUrl.trim()) {
          const { settings: current } = await loadSettings(settingsPath);
          const updated = { ...current, subscribeUrl: body.subscribeUrl.trim() };
          await fs.writeFile(settingsPath, JSON.stringify(updated, null, 2) + '\n', 'utf8');
        }
        const sortBy = ['avg', 'steady', 'value'].includes(body.sortBy) ? body.sortBy : 'avg';
        const limit = Number.isFinite(Number(body.limit)) ? Number(body.limit) : 0;

        runSpeedtestJob({ sortBy, limit });
        return sendJson(res, 202, { started: true, sortBy, limit });
      }

      if (req.method === 'POST' && url.pathname === '/api/speedtest/stop') {
        if (!jobState.running) {
          return sendJson(res, 200, { stopped: false, message: '当前没有运行中的测速任务' });
        }
        jobState.abortController?.abort();
        await jobState.activeMihomo?.stop().catch(() => {});
        return sendJson(res, 200, { stopped: true });
      }

      if (req.method === 'POST' && url.pathname === '/api/clash-verge/apply') {
        const body = await readJsonBody(req);
        if (!body.nodeName) {
          return sendJson(res, 400, { error: '缺少 nodeName 参数' });
        }
        const { settings } = await loadSettings(settingsPath);
        const result = await applyTopNodeToClashVerge(body.nodeName, {
          ...settings,
          autoApplyTopNode: true,
        });
        return sendJson(res, result.applied ? 200 : 400, result);
      }

      if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
        return await serveStatic(url.pathname, res);
      }

      return sendJson(res, 404, { error: 'Not Found' });
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  });
}

// 直接运行此文件时启动 HTTP 服务（支持端口占用自动递增重试）
const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  const startPort = Number(process.env.UI_PORT || 19190);
  const shouldOpen = process.argv.includes('--open') || process.env.OPEN_BROWSER === '1';

  const listenWithFallback = async (candidatePort) => {
    const port = await findAvailablePort(candidatePort);
    const server = createApiServer();
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE' && port < 65535) {
        listenWithFallback(port + 1);
      } else {
        console.error(`Web 服务启动失败: ${err.message}`);
        process.exit(1);
      }
    });
    server.listen(port, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${port}`;
      console.log(`Mihomo Speedtest Web 服务已启动: ${url}`);
      if (shouldOpen) {
        exec(`cmd /c start "" "${url}"`);
      }
    });
  };

  await listenWithFallback(startPort);
}
