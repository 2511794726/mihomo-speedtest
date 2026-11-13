import { ProxyAgent, fetch as undiciFetch } from 'undici';
import { controllerFetch } from './mihomo.js';

const STEADY_WARMUP_MS = 1500;
const MIN_VALID_BYTES_ON_ABORT = 512 * 1024; // 512KB

/**
 * 切换 Mihomo GLOBAL 策略组出口节点。
 * @param {object} ctx
 * @param {string} nodeName
 */
export async function switchGlobalProxy(ctx, nodeName) {
  const res = await controllerFetch(ctx, '/proxies/GLOBAL', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: nodeName }),
  });
  if (res.status !== 204 && res.status !== 200) {
    throw new Error(`切换 GLOBAL 节点失败 (${nodeName}): HTTP ${res.status}`);
  }
}

/**
 * 第一关：真连接延迟预筛。
 * @param {object} ctx
 * @param {string} nodeName
 * @param {number} latencyTimeoutMs
 * @returns {Promise<number | null>} 延迟毫秒数，超时或失败返回 null
 */
export async function testNodeLatency(ctx, nodeName, latencyTimeoutMs) {
  const encoded = encodeURIComponent(nodeName);
  const apiPath = `/proxies/${encoded}/delay?timeout=${latencyTimeoutMs}&url=${encodeURIComponent('http://www.gstatic.com/generate_204')}`;
  try {
    const res = await controllerFetch(ctx, apiPath, {
      signal: AbortSignal.timeout(latencyTimeoutMs + 1500),
    });
    if (res.status !== 200) return null;
    const data = await res.json();
    return typeof data?.delay === 'number' && data.delay >= 0 ? data.delay : null;
  } catch {
    return null;
  }
}

/**
 * 计算下载速率指标。
 * @param {{
 *   totalBytes: number,
 *   steadyBytes: number,
 *   startTime: number,
 *   steadyStartTime: number | null,
 *   endTime: number,
 *   multiplier: number
 * }} metrics
 */
export function computeSpeedMetrics({
  totalBytes,
  steadyBytes,
  startTime,
  steadyStartTime,
  endTime,
  multiplier,
}) {
  const elapsedMs = Math.max(endTime - startTime, 1);
  const elapsedSeconds = elapsedMs / 1000;
  const avgSpeedMBps = totalBytes / (1024 * 1024) / elapsedSeconds;

  let steadySpeedMBps = avgSpeedMBps;
  if (elapsedMs >= 2000 && steadyStartTime !== null && steadyBytes > 0) {
    const steadyElapsedSeconds = Math.max((endTime - steadyStartTime) / 1000, 0.001);
    steadySpeedMBps = steadyBytes / (1024 * 1024) / steadyElapsedSeconds;
  }

  const valueScore = avgSpeedMBps / (multiplier || 1.0);
  return {
    avgSpeedMBps: Number(avgSpeedMBps.toFixed(2)),
    steadySpeedMBps: Number(steadySpeedMBps.toFixed(2)),
    valueScore: Number(valueScore.toFixed(2)),
  };
}

/**
 * 第二关：通过显式 ProxyAgent 执行流式下载测速（隔离系统代理环境变量）。
 * @param {{
 *   mixedPort: number,
 *   testUrl: string,
 *   maxBytesPerNode: number,
 *   downloadTimeoutMs: number,
 *   multiplier: number
 * }} options
 * @returns {Promise<{
 *   ok: boolean,
 *   status: 'completed' | 'capped' | 'timeout' | 'error',
 *   totalBytes: number,
 *   avgSpeedMBps: number,
 *   steadySpeedMBps: number,
 *   valueScore: number,
 *   error?: string
 * }>}
 */
export async function runStreamDownloadTest(options) {
  const { mixedPort, testUrl, maxBytesPerNode, downloadTimeoutMs, multiplier } = options;
  const proxyAgent = new ProxyAgent(`http://127.0.0.1:${mixedPort}`);
  const controller = new AbortController();

  let abortedByCap = false;
  let abortedByTimeout = false;
  const timer = setTimeout(() => {
    abortedByTimeout = true;
    controller.abort();
  }, downloadTimeoutMs);

  let startTime = Date.now();
  let totalBytes = 0;
  let steadyBytes = 0;
  let steadyStartTime = null;
  let streamCompleted = false;
  let caughtError = null;

  try {
    const res = await undiciFetch(testUrl, {
      method: 'GET',
      dispatcher: proxyAgent,
      signal: controller.signal,
    });

    if (!res.ok || !res.body) {
      throw new Error(`HTTP ${res.status}`);
    }

    startTime = Date.now();
    for await (const chunk of res.body) {
      const now = Date.now();
      const len = chunk.byteLength;
      totalBytes += len;

      if (now - startTime >= STEADY_WARMUP_MS) {
        if (steadyStartTime === null) {
          steadyStartTime = now;
        }
        steadyBytes += len;
      }

      if (totalBytes >= maxBytesPerNode) {
        abortedByCap = true;
        controller.abort();
        break;
      }
    }
    if (!abortedByCap && !abortedByTimeout) {
      streamCompleted = true;
    }
  } catch (err) {
    caughtError = err;
  } finally {
    clearTimeout(timer);
    await proxyAgent.close().catch(() => {});
  }

  const endTime = Date.now();
  const hasValidPartial = totalBytes > MIN_VALID_BYTES_ON_ABORT;

  if (abortedByCap || streamCompleted || hasValidPartial) {
    const metrics = computeSpeedMetrics({
      totalBytes,
      steadyBytes,
      startTime,
      steadyStartTime,
      endTime,
      multiplier,
    });
    return {
      ok: true,
      status: abortedByCap ? 'capped' : abortedByTimeout ? 'timeout' : caughtError ? 'error' : 'completed',
      totalBytes,
      ...metrics,
      ...(caughtError && !abortedByCap ? { error: caughtError.message } : {}),
    };
  }

  return {
    ok: false,
    status: abortedByTimeout ? 'timeout' : 'error',
    totalBytes,
    avgSpeedMBps: 0,
    steadySpeedMBps: 0,
    valueScore: 0,
    error: caughtError?.message || '下载失败且数据不足 512KB',
  };
}

/**
 * 串行执行所有节点的双阶段测速循环。
 * @param {Array<{ name: string, type: string, multiplier: number }>} nodes
 * @param {{
 *   controllerPort: number,
 *   controllerSecret: string,
 *   dispatcher: import('undici').Agent,
 *   mixedPort: number,
 *   settings: object,
 *   onProgress?: (info: { index: number, total: number, result: object }) => void
 * }} ctx
 */
export async function runSerialSpeedTests(nodes, ctx) {
  const results = [];
  const total = nodes.length;

  for (let i = 0; i < total; i += 1) {
    if (ctx.signal?.aborted) {
      break;
    }
    const node = nodes[i];
    const index = i + 1;
    let record;

    try {
      await switchGlobalProxy(ctx, node.name);
      const latencyMs = await testNodeLatency(ctx, node.name, ctx.settings.latencyTimeoutMs);

      if (latencyMs === null) {
        record = {
          name: node.name,
          type: node.type,
          multiplier: node.multiplier,
          status: 'Dead / Timeout',
          latencyMs: null,
          totalBytes: 0,
          avgSpeedMBps: 0,
          steadySpeedMBps: 0,
          valueScore: 0,
        };
      } else {
        const dl = await runStreamDownloadTest({
          mixedPort: ctx.mixedPort,
          testUrl: ctx.settings.testUrl,
          maxBytesPerNode: ctx.settings.maxBytesPerNode,
          downloadTimeoutMs: ctx.settings.downloadTimeoutMs,
          multiplier: node.multiplier,
        });

        record = {
          name: node.name,
          type: node.type,
          multiplier: node.multiplier,
          status: dl.ok ? 'OK' : 'Download Failed',
          latencyMs,
          totalBytes: dl.totalBytes,
          avgSpeedMBps: dl.avgSpeedMBps,
          steadySpeedMBps: dl.steadySpeedMBps,
          valueScore: dl.valueScore,
          ...(dl.error ? { error: dl.error } : {}),
        };
      }
    } catch (err) {
      record = {
        name: node.name,
        type: node.type,
        multiplier: node.multiplier,
        status: 'Error',
        latencyMs: null,
        totalBytes: 0,
        avgSpeedMBps: 0,
        steadySpeedMBps: 0,
        valueScore: 0,
        error: err.message,
      };
    }

    results.push(record);
    ctx.onProgress?.({ index, total, result: record });
  }

  return results;
}
