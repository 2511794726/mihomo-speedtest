import { exec } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SETTINGS, loadSettings } from './config.js';
import { resolvePorts, resolveWorkerPorts, ensureMihomoBinary, findAvailablePort, detectRunningVPN, shutdownSupportedVPNs, launchVPNByPath } from './preflight.js';
import { prepareRuntimeSubscription } from './subscribe.js';
import { startMihomoProcess, fetchFilteredProxies } from './mihomo.js';
import { BandwidthLimiter, runConcurrentSpeedTests, testLocalBandwidth, testSingleNode } from './tester.js';
import {
  sortResults,
  saveSpeedRank,
  saveSpeedRankLatestOnly,
  buildOptimizedClashYAML,
  applyTopNodeToClashVerge,
  probeVpnController,
  applyNodeToVpn,
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
  startedAtMs: 0,
  elapsedMs: 0,
  totalBytes: 0,
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

async function runSpeedtestJob({
  sortBy = 'avg',
  limit = 0,
  selectedNodes = [],
  enableUnlockCheck = undefined,
  concurrency = undefined,
  maxBandwidthMBps = undefined,
}) {
  const startedAtMs = Date.now();
  jobState.running = true;
  jobState.stage = 'preflight';
  jobState.total = 0;
  jobState.completed = 0;
  jobState.sortBy = sortBy;
  jobState.startedAtMs = startedAtMs;
  jobState.elapsedMs = 0;
  jobState.totalBytes = 0;
  jobState.results = [];
  jobState.logs = [];
  jobState.abortController = new AbortController();

  broadcast('state', {
    running: true,
    stage: jobState.stage,
    total: 0,
    completed: 0,
    sortBy,
    startedAtMs,
    elapsedMs: 0,
    totalBytes: 0,
  });

  try {
    const { settings } = await loadSettings(settingsPath);
    if (typeof enableUnlockCheck === 'boolean') {
      settings.enableUnlockCheck = enableUnlockCheck;
    }
    if (Number.isFinite(Number(concurrency)) && Number(concurrency) >= 1 && Number(concurrency) <= 16) {
      settings.concurrency = Math.floor(Number(concurrency));
    }
    if (Number.isFinite(Number(maxBandwidthMBps)) && Number(maxBandwidthMBps) >= 0) {
      settings.maxBandwidthMBps = Number(maxBandwidthMBps);
    }
    let activeConcurrency = Math.min(16, Math.max(1, Number(settings.concurrency) || 1));
    if (settings.maxBandwidthMBps <= 0 && activeConcurrency > 1) {
      activeConcurrency = 1;
      pushLog('未设置全局宽带上限，已自动锁定为 1 线程串行测速（设置宽带上限后可开启多线程）。');
    }
    pushLog(`正在预检端口与 Mihomo 内核 (初始线程: ${activeConcurrency}，预挂载最多 16 端口以支持热扩容)...`);
    const { workerPorts, controllerPort } = await resolveWorkerPorts(settings, 16);
    const binInfo = await ensureMihomoBinary(binaryPath);
    pushLog(`内核就绪: ${binInfo.path} (workerPorts=[${workerPorts.join(',')}], controllerPort=${controllerPort})`);

    if (jobState.abortController.signal.aborted) throw new Error('测速已被用户取消');

    jobState.stage = 'subscribe';
    broadcast('state', { running: true, stage: jobState.stage, total: 0, completed: 0, sortBy });
    pushLog('正在拉取并解析订阅...');
    const subInfo = await prepareRuntimeSubscription(settings, {
      workerPorts,
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
      if (Array.isArray(selectedNodes) && selectedNodes.length > 0) {
        const selectedSet = new Set(selectedNodes);
        nodes = nodes.filter((n) => selectedSet.has(n.name));
        if (nodes.length === 0) {
          pushLog('所选节点均不在当前订阅中。');
          return;
        }
        pushLog(`已按预览勾选锁定 ${nodes.length} 个节点，开始串行测速...`);
      } else if (limit > 0 && nodes.length > limit) {
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

      const limiter = new BandwidthLimiter(settings.maxBandwidthMBps);
      if (settings.maxBandwidthMBps > 0) {
        pushLog(
          `已启用智能防封顶退避: 宽带阈值 ${settings.maxBandwidthMBps} MB/s (约 ${Math.round(settings.maxBandwidthMBps * 8)} Mbps)，初始并发 ${activeConcurrency} 线程（不锁单线程速度，触顶自动降线程并重测）`,
        );
      } else {
        pushLog('已开启 1 线程串行精确测速');
      }

      let warnedBandwidth = false;
      let lastSuggestUpThreads = 0;
      let lastAutoScaleDownAt = 0;
      let peakMBps = 0;
      let activeSamples = 0;
      let currentConcurrency = activeConcurrency;
      let scalerFn = null;

      jobState.scaleConcurrency = (next) => {
        const prev = currentConcurrency;
        const clamped = Math.min(workerPorts.length, Math.max(1, Number(next) || 1));
        currentConcurrency = scalerFn ? scalerFn(clamped) : clamped;
        activeSamples = 0;
        lastSuggestUpThreads = 0;
        if (currentConcurrency < prev) {
          warnedBandwidth = false;
        }
        if (currentConcurrency !== prev) {
          pushLog(`[并发热调整] 线程数已实时变更为 ${prev} -> ${currentConcurrency} 线程（立即应用于剩余节点）`);
          broadcast('concurrency-updated', {
            concurrency: currentConcurrency,
            previous: prev,
          });
          return { concurrency: currentConcurrency, changed: true };
        }
        return { concurrency: currentConcurrency, changed: false };
      };

      const monitorTimer = setInterval(() => {
        const { currentMBps, throttled } = limiter.snapshot();
        if (currentMBps > peakMBps) peakMBps = currentMBps;
        if (currentMBps >= 0.5) activeSamples += 1;
        const remainingNodes = Math.max(0, jobState.total - jobState.completed);

        broadcast('bandwidth', {
          currentMBps,
          peakMBps,
          limitMBps: settings.maxBandwidthMBps,
          throttled,
          concurrency: currentConcurrency,
        });

        if (
          currentConcurrency > 1 &&
          settings.maxBandwidthMBps > 0 &&
          (throttled || currentMBps >= settings.maxBandwidthMBps * 0.92)
        ) {
          limiter.markCongested();
          limiter.clearThrottled();
          if (Date.now() - lastAutoScaleDownAt >= 2500) {
            lastAutoScaleDownAt = Date.now();
            warnedBandwidth = true;
            lastSuggestUpThreads = 0;
            const step = Math.max(1, Math.floor(currentConcurrency / 4));
            const nextThreads = Math.max(1, currentConcurrency - step);
            if (nextThreads < currentConcurrency) {
              const prev = currentConcurrency;
              currentConcurrency = scalerFn ? scalerFn(nextThreads) : nextThreads;
              activeSamples = 0;
              const warnMsg = `总速率已触及 ${settings.maxBandwidthMBps} MB/s 上限，已自动从 ${prev} 线程降至 ${currentConcurrency} 线程，并将受竞争影响的高速节点放回队列重测以保证测速真实性。`;
              pushLog(`[智能降线程] ${warnMsg}`);
              broadcast('concurrency-updated', {
                concurrency: currentConcurrency,
                previous: prev,
              });
              broadcast('bandwidth-warning', {
                level: 'auto-scaled-down',
                message: warnMsg,
                currentMBps,
                peakMBps,
                limitMBps: settings.maxBandwidthMBps,
                concurrency: currentConcurrency,
                recommendedThreads: currentConcurrency,
                remaining: remainingNodes,
              });
            }
          }
        } else if (
          !warnedBandwidth &&
          currentConcurrency < 16 &&
          settings.maxBandwidthMBps > 0 &&
          activeSamples >= 6 &&
          peakMBps >= 0.5 &&
          remainingNodes >= 4
        ) {
          const usageRatio = peakMBps / settings.maxBandwidthMBps;
          let recUp = 0;
          if (usageRatio < 0.72) {
            const perThreadPeak = Math.max(1.0, peakMBps / currentConcurrency);
            const estMax = Math.min(16, Math.floor((settings.maxBandwidthMBps * 0.85) / perThreadPeak));
            if (estMax > currentConcurrency) {
              recUp = estMax;
            }
          }
          if (recUp > currentConcurrency && recUp !== lastSuggestUpThreads) {
            const isFirstSuggest = lastSuggestUpThreads === 0;
            lastSuggestUpThreads = recUp;
            const suggestMsg = `当前 ${currentConcurrency} 线程网速最高峰为 ${peakMBps.toFixed(1)} MB/s（占预设上限 ${settings.maxBandwidthMBps.toFixed(1)} MB/s 的 ${Math.round(usageRatio * 100)}%），宽带余量充足，可尝试将线程提高至 ${recUp} 线程以加快测速。`;
            if (isFirstSuggest) {
              pushLog(`[并发建议] ${suggestMsg}`);
            }
            broadcast('bandwidth-warning', {
              level: 'suggest-up',
              message: suggestMsg,
              currentMBps,
              peakMBps,
              limitMBps: settings.maxBandwidthMBps,
              concurrency: currentConcurrency,
              recommendedThreads: recUp,
              remaining: remainingNodes,
              usageRatio,
            });
          } else if (recUp === 0 && lastSuggestUpThreads > 0) {
            lastSuggestUpThreads = 0;
            broadcast('bandwidth-warning', {
              level: 'clear',
              peakMBps,
              concurrency: currentConcurrency,
            });
          }
        }
      }, 900);

      let rawResults;
      try {
        rawResults = await runConcurrentSpeedTests(nodes, {
          ...controllerCtx,
          workerPorts,
          initialConcurrency: activeConcurrency,
          onRegisterScaler: (fn) => {
            scalerFn = fn;
          },
          onCongestedRetry: (nodeName, attempt) => {
            pushLog(`[防封顶重测] 节点 ${nodeName} 测速期间总速率触顶，已退回队列等待降线程后重测 (第 ${attempt} 次)`);
          },
          limiter,
          settings,
          signal: jobState.abortController.signal,
          onProgress: ({ index, total, result }) => {
            const elapsedMs = Date.now() - startedAtMs;
            jobState.completed = index;
            jobState.totalBytes += Number(result.totalBytes) || 0;
            jobState.elapsedMs = elapsedMs;
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
              totalBytes: jobState.totalBytes,
              elapsedMs,
            });
          },
        });
      } finally {
        clearInterval(monitorTimer);
      }

      const sorted = sortResults(rawResults, sortBy);
      const finalElapsedMs = Date.now() - startedAtMs;
      jobState.results = sorted;
      jobState.elapsedMs = finalElapsedMs;
      await saveSpeedRank(sorted, outputPath, sortBy, finalElapsedMs);

      if (jobState.abortController.signal.aborted) {
        pushLog(`测速已手动中止，已保存当前 ${sorted.length} 个节点的结果。`);
      } else {
        pushLog(
          `全部测速完成！共消耗 ${(jobState.totalBytes / (1024 * 1024)).toFixed(2)} MB 流量，耗时 ${(finalElapsedMs / 1000).toFixed(1)} 秒，结果已保存至 results/speed-rank.json`,
        );
      }

      broadcast('done', {
        aborted: jobState.abortController.signal.aborted,
        results: sorted,
        totalBytes: jobState.totalBytes,
        elapsedMs: finalElapsedMs,
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
    jobState.scaleConcurrency = null;
    if (!jobState.elapsedMs && startedAtMs) {
      jobState.elapsedMs = Date.now() - startedAtMs;
    }
    broadcast('state', {
      running: false,
      stage: 'idle',
      total: jobState.total,
      completed: jobState.completed,
      sortBy: jobState.sortBy,
      startedAtMs: jobState.startedAtMs,
      elapsedMs: jobState.elapsedMs,
      totalBytes: jobState.totalBytes,
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
    if (typeof enableUnlockCheck === 'boolean') {
      settings.enableUnlockCheck = enableUnlockCheck;
    }
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
            startedAtMs: jobState.startedAtMs,
            elapsedMs: jobState.elapsedMs,
            totalBytes: jobState.totalBytes,
          });
        }
        try {
          const raw = await fs.readFile(outputPath, 'utf8');
          const data = JSON.parse(raw);
          return sendJson(res, 200, { running: false, ...data });
        } catch {
          return sendJson(res, 200, {
            running: false,
            results: [],
            totalNodes: 0,
            okNodes: 0,
            totalBytes: 0,
            elapsedMs: 0,
          });
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
            startedAtMs: jobState.startedAtMs,
            elapsedMs: jobState.elapsedMs,
            totalBytes: jobState.totalBytes,
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
        const selectedNodes = Array.isArray(body.selectedNodes) ? body.selectedNodes : [];
        const enableUnlockCheck =
          typeof body.enableUnlockCheck === 'boolean' ? body.enableUnlockCheck : undefined;
        const concurrency = body.concurrency !== undefined ? Number(body.concurrency) : undefined;
        const maxBandwidthMBps =
          body.maxBandwidthMBps !== undefined ? Number(body.maxBandwidthMBps) : undefined;

        runSpeedtestJob({
          sortBy,
          limit,
          selectedNodes,
          enableUnlockCheck,
          concurrency,
          maxBandwidthMBps,
        });
        return sendJson(res, 202, { started: true, sortBy, limit });
      }

      if (req.method === 'POST' && url.pathname === '/api/speedtest/concurrency') {
        const body = await readJsonBody(req);
        const next = Math.min(16, Math.max(1, Number(body.concurrency) || 1));
        const { settings: current } = await loadSettings(settingsPath);
        if (next > 1 && !(Number(current.maxBandwidthMBps) > 0)) {
          return sendJson(res, 400, { error: '请先设置宽带上限（或点击「测上限」自动获取）后再开启多线程' });
        }
        const updated = { ...current, concurrency: next };
        await fs.writeFile(settingsPath, JSON.stringify(updated, null, 2) + '\n', 'utf8');
        let applied = next;
        let changed = false;
        const appliedNow = Boolean(jobState.running && jobState.scaleConcurrency);
        if (appliedNow) {
          const r = jobState.scaleConcurrency(next);
          applied = r.concurrency;
          changed = r.changed;
        }
        return sendJson(res, 200, {
          ok: true,
          running: jobState.running,
          concurrency: applied,
          appliedNow,
          changed,
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/bandwidth/test') {
        if (jobState.running) {
          return sendJson(res, 409, { error: '节点测速进行中，请先停止后再测宽带上限' });
        }
        const body = await readJsonBody(req);
        const { settings } = await loadSettings(settingsPath);
        try {
          const result = await testLocalBandwidth(body.mode, settings.testUrl, body.customUrl);
          return sendJson(res, 200, { ok: true, ...result });
        } catch (err) {
          return sendJson(res, 502, { error: err.message });
        }
      }

      if (req.method === 'POST' && url.pathname === '/api/speedtest/preview') {
        if (jobState.running) {
          return sendJson(res, 409, { error: '测速进行中，请先停止后再预览' });
        }
        const body = await readJsonBody(req);
        const { settings } = await loadSettings(settingsPath);
        if (typeof body.subscribeUrl === 'string' && body.subscribeUrl.trim()) {
          settings.subscribeUrl = body.subscribeUrl.trim();
        }
        const { mixedPort, controllerPort } = await resolvePorts(settings);
        const binInfo = await ensureMihomoBinary(binaryPath);
        const subInfo = await prepareRuntimeSubscription(settings, { mixedPort, controllerPort, configsDir });
        const mihomo = await startMihomoProcess({
          binaryPath: binInfo.path,
          configsDir,
          runtimeYamlPath: subInfo.runtimeYamlPath,
          controllerPort,
          controllerSecret: settings.controllerSecret,
          hasProviders: subInfo.hasProviders,
        });
        try {
          const nodes = await fetchFilteredProxies(
            { controllerPort, controllerSecret: settings.controllerSecret, dispatcher: mihomo.dispatcher },
            settings.excludeKeywords,
            {
              includeRegions: settings.includeRegions,
              includeKeywords: settings.includeKeywords,
              regionKeywords: settings.regionKeywords,
            },
          );
          return sendJson(res, 200, { totalNodes: nodes.length, nodes });
        } finally {
          await mihomo.stop().catch(() => {});
        }
      }

      if (req.method === 'POST' && url.pathname === '/api/speedtest/retest') {
        if (jobState.running) {
          return sendJson(res, 409, { error: '已有测速任务正在运行中，请先停止后再单点复测' });
        }
        const body = await readJsonBody(req);
        const nodeName = String(body.nodeName || '').trim();
        if (!nodeName) {
          return sendJson(res, 400, { error: '缺少有效的 nodeName 参数' });
        }
        const { settings } = await loadSettings(settingsPath);
        const enableUnlock =
          typeof body.enableUnlockCheck === 'boolean'
            ? body.enableUnlockCheck
            : Boolean(settings.enableUnlockCheck);

        const { mixedPort, controllerPort } = await resolvePorts(settings);
        const binInfo = await ensureMihomoBinary(binaryPath);
        const subInfo = await prepareRuntimeSubscription(settings, { mixedPort, controllerPort, configsDir });
        const mihomo = await startMihomoProcess({
          binaryPath: binInfo.path,
          configsDir,
          runtimeYamlPath: subInfo.runtimeYamlPath,
          controllerPort,
          controllerSecret: settings.controllerSecret,
          hasProviders: subInfo.hasProviders,
        });
        try {
          const controllerCtx = {
            controllerPort,
            controllerSecret: settings.controllerSecret,
            dispatcher: mihomo.dispatcher,
          };
          const nodes = await fetchFilteredProxies(controllerCtx, [], {});
          const target = nodes.find((n) => n.name === nodeName);
          if (!target) {
            return sendJson(res, 404, { error: `订阅中未找到节点「${nodeName}」` });
          }
          const result = await testSingleNode(
            target,
            { ...controllerCtx, mixedPort, settings },
            enableUnlock,
          );
          let existing = { results: [], sortBy: 'avg', elapsedMs: 0 };
          try {
            existing = JSON.parse(await fs.readFile(outputPath, 'utf8'));
          } catch {
            // ignore
          }
          const list = Array.isArray(existing.results) ? [...existing.results] : [];
          const idx = list.findIndex((r) => r.name === result.name);
          if (idx >= 0) list[idx] = result;
          else list.push(result);
          const sortBy = ['avg', 'steady', 'value'].includes(body.sortBy)
            ? body.sortBy
            : existing.sortBy || 'avg';
          const sorted = sortResults(list, sortBy);
          await saveSpeedRankLatestOnly(sorted, outputPath, sortBy, existing.elapsedMs || 0);
          return sendJson(res, 200, { result, results: sorted });
        } finally {
          await mihomo.stop().catch(() => {});
        }
      }

      if (req.method === 'POST' && url.pathname === '/api/export/clash-yaml') {
        const body = await readJsonBody(req);
        const topN = Number(body.topN) > 0 ? Number(body.topN) : 10;
        let names = Array.isArray(body.nodeNames) ? body.nodeNames : [];
        if (names.length === 0) {
          let existing;
          try {
            existing = JSON.parse(await fs.readFile(outputPath, 'utf8'));
          } catch {
            return sendJson(res, 400, { error: '暂无可用测速结果，请先运行测速' });
          }
          names = (existing.results || [])
            .filter((r) => r.status === 'OK' && r.avgSpeedMBps > 0)
            .slice(0, topN)
            .map((r) => r.name);
        }
        const runtimeYaml = path.join(configsDir, 'runtime.yaml');
        try {
          const { yaml: yamlStr, count } = await buildOptimizedClashYAML(runtimeYaml, names);
          return sendJson(res, 200, { yaml: yamlStr, count, filename: `mihomo-top${count}.yaml` });
        } catch (err) {
          return sendJson(res, 400, { error: err.message });
        }
      }

      if (req.method === 'POST' && url.pathname === '/api/speedtest/stop') {
        if (!jobState.running) {
          return sendJson(res, 200, { stopped: false, message: '当前没有运行中的测速任务' });
        }
        jobState.abortController?.abort();
        await jobState.activeMihomo?.stop().catch(() => {});
        return sendJson(res, 200, { stopped: true });
      }

      if (req.method === 'GET' && url.pathname === '/api/preflight/vpn-check') {
        const result = await detectRunningVPN();
        return sendJson(res, 200, result);
      }

      if (req.method === 'POST' && url.pathname === '/api/preflight/vpn-shutdown') {
        if (jobState.running) {
          return sendJson(res, 409, { error: '测速任务正在运行中' });
        }
        try {
          const closed = await shutdownSupportedVPNs();
          return sendJson(res, 200, { ok: true, closed });
        } catch (err) {
          return sendJson(res, 403, { error: err.message });
        }
      }

      if (req.method === 'POST' && url.pathname === '/api/preflight/vpn-launch') {
        const body = await readJsonBody(req);
        try {
          await launchVPNByPath(body.exePath);
          return sendJson(res, 200, { ok: true });
        } catch (err) {
          return sendJson(res, 400, { error: err.message });
        }
      }

      if (req.method === 'POST' && url.pathname === '/api/vpn/probe') {
        const body = await readJsonBody(req);
        const { settings } = await loadSettings(settingsPath);
    if (typeof enableUnlockCheck === 'boolean') {
      settings.enableUnlockCheck = enableUnlockCheck;
    }
        const apiUrl = String(body.apiUrl || '').trim() || settings.clashVergeApi;
        const secret = body.secret || (apiUrl === settings.clashVergeApi ? settings.clashVergeSecret : '');
        const result = await probeVpnController(apiUrl, secret, body.nodeName || '');
        return sendJson(res, 200, result);
      }

      if (req.method === 'POST' && url.pathname === '/api/vpn/apply') {
        const body = await readJsonBody(req);
        const { settings } = await loadSettings(settingsPath);
    if (typeof enableUnlockCheck === 'boolean') {
      settings.enableUnlockCheck = enableUnlockCheck;
    }
        const apiUrl = String(body.apiUrl || '').trim() || settings.clashVergeApi;
        const secret = body.secret || (apiUrl === settings.clashVergeApi ? settings.clashVergeSecret : '');
        const selector = String(body.selector || '').trim() || settings.clashVergeSelector;
        try {
          const result = await applyNodeToVpn(apiUrl, secret, selector, body.nodeName || '');
          return sendJson(res, 200, result);
        } catch (err) {
          return sendJson(res, 400, { applied: false, error: err.message });
        }
      }

      if (req.method === 'POST' && url.pathname === '/api/clash-verge/apply') {
        const body = await readJsonBody(req);
        if (!body.nodeName) {
          return sendJson(res, 400, { error: '缺少 nodeName 参数' });
        }
        const { settings } = await loadSettings(settingsPath);
    if (typeof enableUnlockCheck === 'boolean') {
      settings.enableUnlockCheck = enableUnlockCheck;
    }
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
