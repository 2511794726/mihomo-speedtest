import { ProxyAgent, fetch as undiciFetch } from 'undici';
import { controllerFetch } from './mihomo.js';
import { probeNodeUnlock } from './unlock.js';

const STEADY_WARMUP_MS = 1500;
const MIN_VALID_BYTES_ON_ABORT = 512 * 1024; // 512KB

/**
 * 切换 Mihomo GLOBAL 策略组出口节点。
 * @param {object} ctx
 * @param {string} nodeName
 */
export class BandwidthLimiter {
  constructor(maxMBps = 0) {
    this.maxMBps = Number(maxMBps) > 0 ? Number(maxMBps) : 0;
    this.throttled = false;
    this.lastCongestedAt = 0;
    this.windowStart = Date.now();
    this.windowBytes = 0;
    this.lastMBps = 0;
  }

  async consume(bytes) {
    if (!bytes || bytes <= 0) return;
    this.windowBytes += bytes;
    const now = Date.now();
    const elapsed = (now - this.windowStart) / 1000;
    if (elapsed >= 0.6) {
      const cur = this.windowBytes / (1024 * 1024) / elapsed;
      this.lastMBps = cur;
      this.windowStart = now;
      this.windowBytes = 0;
      if (this.maxMBps > 0 && cur >= this.maxMBps * 0.92) {
        this.throttled = true;
        this.lastCongestedAt = now;
      }
    }
  }

  markCongested() {
    this.throttled = true;
    this.lastCongestedAt = Date.now();
  }

  clearThrottled() {
    this.throttled = false;
  }

  wasCongestedBetween(startMs, endMs) {
    if (!this.lastCongestedAt) return false;
    return this.lastCongestedAt >= startMs && this.lastCongestedAt <= endMs + 300;
  }

  snapshot() {
    const now = Date.now();
    const elapsed = (now - this.windowStart) / 1000;
    const currentMBps =
      elapsed >= 0.3
        ? Number((this.windowBytes / (1024 * 1024) / elapsed).toFixed(2))
        : Number(this.lastMBps.toFixed(2));
    if (this.maxMBps > 0 && currentMBps >= this.maxMBps * 0.92) {
      this.throttled = true;
      this.lastCongestedAt = now;
    }
    return { currentMBps, throttled: this.throttled };
  }
}

export async function switchProxyGroup(ctx, groupName, nodeName) {
  const res = await controllerFetch(ctx, `/proxies/${encodeURIComponent(groupName)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: nodeName }),
  });
  if (res.status !== 204 && res.status !== 200) {
    throw new Error(`切换 ${groupName} 节点失败 (${nodeName}): HTTP ${res.status}`);
  }
}

export async function switchGlobalProxy(ctx, nodeName) {
  return switchProxyGroup(ctx, 'GLOBAL', nodeName);
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
  const { mixedPort, testUrl, maxBytesPerNode, downloadTimeoutMs, multiplier, limiter } = options;
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
      const len = chunk.byteLength;
      if (limiter) {
        await limiter.consume(len, controller.signal);
      }
      const now = Date.now();
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
export async function testSingleNode(
  node,
  ctx,
  enableUnlockCheck = false,
  proxyGroup = 'GLOBAL',
  limiter = null,
) {
  const nodeStart = Date.now();
  let record;

  try {
    await switchProxyGroup(ctx, proxyGroup, node.name);
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
        limiter,
      });

      let unlock;
      if (dl.ok && enableUnlockCheck && !ctx.signal?.aborted) {
        unlock = await probeNodeUnlock(ctx.mixedPort);
      }

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
        ...(unlock ? { unlock } : {}),
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

  record.durationMs = Date.now() - nodeStart;
  return record;
}

export async function runSerialSpeedTests(nodes, ctx) {
  return runConcurrentSpeedTests(nodes, {
    ...ctx,
    workerPorts: [ctx.mixedPort],
    limiter: null,
  });
}

export async function runConcurrentSpeedTests(nodes, ctx) {
  const total = nodes.length;
  if (total === 0) return [];
  const enableUnlock = Boolean(ctx.settings?.enableUnlockCheck);
  const ports =
    Array.isArray(ctx.workerPorts) && ctx.workerPorts.length > 0 ? ctx.workerPorts : [ctx.mixedPort];
  const limiter = ctx.limiter || null;

  if (ports.length <= 1) {
    const results = [];
    for (let i = 0; i < total; i += 1) {
      if (ctx.signal?.aborted) break;
      const record = await testSingleNode(
        nodes[i],
        { ...ctx, mixedPort: ports[0] },
        enableUnlock,
        'GLOBAL',
        limiter,
      );
      results.push(record);
      ctx.onProgress?.({ index: i + 1, total, result: record });
    }
    return results;
  }

  const queue = nodes.map((node) => ({ node, retries: 0 }));
  let inFlight = 0;
  let completedCount = 0;
  const results = [];
  let targetConcurrency = Math.min(
    ports.length,
    Math.max(1, Number(ctx.initialConcurrency) || ports.length),
  );
  const activeSlots = new Array(ports.length).fill(false);
  const pendingPromises = [];
  const waiters = [];

  function notifyWaiters() {
    while (waiters.length > 0) {
      const fn = waiters.shift();
      fn();
    }
  }

  function spawnSlot(wIdx) {
    if (activeSlots[wIdx] || wIdx >= targetConcurrency) return;
    if (queue.length === 0 && inFlight === 0) return;
    activeSlots[wIdx] = true;
    const port = ports[wIdx];
    const group = `SPEEDTEST_W${wIdx}`;
    const p = (async () => {
      try {
        while (true) {
          if (ctx.signal?.aborted || wIdx >= targetConcurrency) break;
          while (queue.length === 0 && inFlight > 0 && !ctx.signal?.aborted && wIdx < targetConcurrency) {
            await new Promise((resolve) => waiters.push(resolve));
          }
          if (ctx.signal?.aborted || wIdx >= targetConcurrency) break;
          if (queue.length === 0 && inFlight === 0) break;
          const item = queue.shift();
          inFlight += 1;
          const nodeStart = Date.now();
          const record = await testSingleNode(
            item.node,
            { ...ctx, mixedPort: port },
            enableUnlock,
            group,
            limiter,
          );
          const nodeEnd = Date.now();
          inFlight -= 1;

          if (ctx.signal?.aborted && record.status === 'Error') {
            notifyWaiters();
            break;
          }

          if (
            record.status === 'OK' &&
            targetConcurrency > 1 &&
            limiter &&
            limiter.wasCongestedBetween(nodeStart, nodeEnd) &&
            item.retries < 2
          ) {
            queue.push({ node: item.node, retries: item.retries + 1 });
            notifyWaiters();
            ctx.onCongestedRetry?.(item.node.name, item.retries + 1);
            continue;
          }

          notifyWaiters();
          results.push(record);
          completedCount += 1;
          ctx.onProgress?.({ index: completedCount, total, result: record });
        }
      } finally {
        activeSlots[wIdx] = false;
        notifyWaiters();
      }
    })();
    pendingPromises.push(p);
  }

  function scaleTo(next) {
    const clamped = Math.min(ports.length, Math.max(1, Number(next) || 1));
    targetConcurrency = clamped;
    for (let w = 0; w < targetConcurrency; w += 1) {
      spawnSlot(w);
    }
    return targetConcurrency;
  }

  ctx.onRegisterScaler?.(scaleTo);
  scaleTo(targetConcurrency);

  while (pendingPromises.length > 0) {
    const batch = pendingPromises.splice(0, pendingPromises.length);
    await Promise.all(batch);
  }
  return results;
}

const DOMESTIC_BANDWIDTH_URLS = [
  'https://speed.cloudflare.com/__down?bytes=50000000',
  'https://speed.cloudflare.com/__down?bytes=100000000',
  'https://cachefly.cachefly.net/100mb.test',
  'https://hnd-jp-ping.vultr.com/vultr.com.100MB.bin',
  'https://sgp-ping.vultr.com/vultr.com.100MB.bin',
];

async function probeReachableBandwidthUrls(candidates) {
  const results = await Promise.all(
    candidates
      .map((u) => (typeof u === 'string' ? u.trim() : ''))
      .filter(Boolean)
      .map(async (url) => {
        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(), 2500);
        try {
          const res = await fetch(url, {
            method: 'GET',
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            },
            signal: ac.signal,
          });
          await res.body?.cancel().catch(() => {});
          if (res.status >= 200 && res.status < 400) return url;
        } catch {
          // ignore unreachable candidate
        } finally {
          clearTimeout(t);
        }
        return null;
      }),
  );
  return results.filter(Boolean);
}

export async function testLocalBandwidth(mode = 'domestic', testUrl = '', customUrl = '') {
  const trimmedCustom = typeof customUrl === 'string' ? customUrl.trim() : '';
  const normalizedMode = trimmedCustom ? 'custom' : mode === 'direct' ? 'direct' : 'domestic';

  let activeUrls = [];
  if (normalizedMode === 'custom') {
    activeUrls = await probeReachableBandwidthUrls([trimmedCustom]);
    if (activeUrls.length === 0) {
      throw new Error('自定义测速链接无法连接，请检查 URL 是否有效');
    }
  } else if (normalizedMode === 'direct') {
    if (testUrl) {
      activeUrls = await probeReachableBandwidthUrls([testUrl]);
    }
    if (activeUrls.length === 0) {
      activeUrls = await probeReachableBandwidthUrls(DOMESTIC_BANDWIDTH_URLS);
    }
  } else {
    activeUrls = await probeReachableBandwidthUrls(DOMESTIC_BANDWIDTH_URLS);
  }

  if (activeUrls.length === 0) {
    throw new Error('无法连接任何直连测速源，请检查本地网络连接');
  }

  const TEST_MS = 6000;
  const WARMUP_MS = 1000;
  const WORKERS = 8;

  const ac = new AbortController();
  const stopTimer = setTimeout(() => ac.abort(), TEST_MS);
  const startedAt = Date.now();
  let totalBytes = 0;
  let steadyBytes = 0;
  let peakMBps = 0;
  const samples = [{ at: startedAt, bytes: 0 }];

  const sampler = setInterval(() => {
    const now = Date.now();
    samples.push({ at: now, bytes: totalBytes });
    for (let i = samples.length - 2; i >= 0; i -= 1) {
      const dt = (now - samples[i].at) / 1000;
      if (dt >= 0.45) {
        const mbps = (totalBytes - samples[i].bytes) / (1024 * 1024) / dt;
        if (mbps > peakMBps) peakMBps = mbps;
        break;
      }
    }
  }, 250);

  const workerPromises = Array.from({ length: WORKERS }, async (_, idx) => {
    const targetUrl = activeUrls[idx % activeUrls.length];
    while (!ac.signal.aborted) {
      try {
        const res = await fetch(targetUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          },
          signal: ac.signal,
        });
        if (!res.ok || !res.body) break;
        const reader = res.body.getReader();
        while (!ac.signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value?.byteLength) {
            totalBytes += value.byteLength;
            if (Date.now() - startedAt >= WARMUP_MS) {
              steadyBytes += value.byteLength;
            }
          }
        }
        await reader.cancel().catch(() => {});
      } catch {
        if (ac.signal.aborted) break;
      }
    }
  });

  await Promise.allSettled(workerPromises);
  clearTimeout(stopTimer);
  clearInterval(sampler);

  const elapsedMs = Math.max(100, Date.now() - startedAt);
  if (totalBytes === 0) {
    throw new Error('未收到测速数据，请稍后重试或填写自定义测速链接');
  }

  const steadySecs = (elapsedMs - WARMUP_MS) / 1000;
  const steadyRaw =
    steadySecs > 0.5 && steadyBytes > 0
      ? steadyBytes / (1024 * 1024) / steadySecs
      : totalBytes / (1024 * 1024) / (elapsedMs / 1000);
  if (peakMBps < steadyRaw) peakMBps = steadyRaw;

  const peakRounded = Math.round(peakMBps * 10) / 10;
  const steadyRounded = Math.round(steadyRaw * 10) / 10;
  let recommended = Math.round(peakRounded * 0.9 * 10) / 10;
  if (recommended < 1.0 && peakRounded >= 1.0) recommended = 1.0;

  return {
    mode: normalizedMode,
    usedUrl: activeUrls.join(' , '),
    usedUrls: activeUrls,
    peakMBps: peakRounded,
    steadyMBps: steadyRounded,
    peakMbps: Math.round(peakRounded * 8),
    recommendedMBps: recommended,
    totalBytes,
    durationMs: elapsedMs,
  };
}
