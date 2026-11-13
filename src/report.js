import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import Table from 'cli-table3';
import { Agent, fetch as undiciFetch } from 'undici';

const SORT_FIELD_MAP = {
  avg: 'avgSpeedMBps',
  steady: 'steadySpeedMBps',
  value: 'valueScore',
};

/**
 * 按指定维度降序排列测速结果。
 * @param {Array<Record<string, any>>} results
 * @param {'avg' | 'steady' | 'value'} [sortBy='avg']
 */
export function sortResults(results, sortBy = 'avg') {
  const field = SORT_FIELD_MAP[sortBy] || 'avgSpeedMBps';
  return [...results].sort((a, b) => {
    const diff = (b[field] || 0) - (a[field] || 0);
    if (diff !== 0) return diff;
    const latA = a.latencyMs ?? Number.POSITIVE_INFINITY;
    const latB = b.latencyMs ?? Number.POSITIVE_INFINITY;
    return latA - latB;
  });
}

/**
 * 将测速结果持久化写入 JSON 文件，并在同级 history/ 目录留痕保存历史快照。
 * @param {Array<Record<string, any>>} sortedResults
 * @param {string} outputPath
 * @param {string} [sortBy='avg']
 */
export async function saveSpeedRank(sortedResults, outputPath, sortBy = 'avg') {
  const dir = path.dirname(outputPath);
  const historyDir = path.join(dir, 'history');
  await fs.mkdir(historyDir, { recursive: true });

  const now = new Date();
  const best = sortedResults.find((r) => r.status === 'OK' && r.avgSpeedMBps > 0);
  const payload = {
    generatedAt: now.toISOString(),
    sortBy,
    totalNodes: sortedResults.length,
    okNodes: sortedResults.filter((r) => r.status === 'OK').length,
    topNodeName: best?.name || null,
    topAvgSpeedMBps: best?.avgSpeedMBps || 0,
    results: sortedResults,
  };
  const jsonText = JSON.stringify(payload, null, 2) + '\n';
  await fs.writeFile(outputPath, jsonText, 'utf8');

  const safeStamp = now.toISOString().replace(/[:.]/g, '-');
  const historyPath = path.join(historyDir, `rank-${safeStamp}.json`);
  await fs.writeFile(historyPath, jsonText, 'utf8');

  // 仅保留最近 30 条历史留痕，防止无限增长
  try {
    const files = (await fs.readdir(historyDir))
      .filter((f) => f.startsWith('rank-') && f.endsWith('.json'))
      .sort()
      .reverse();
    for (const oldFile of files.slice(30)) {
      await fs.unlink(path.join(historyDir, oldFile)).catch(() => {});
    }
  } catch {
    // ignore cleanup errors
  }
}

/**
 * 列出历史留痕快照摘要（按时间倒序）。
 * @param {string} historyDir
 */
export async function listHistorySnapshots(historyDir) {
  try {
    const files = (await fs.readdir(historyDir))
      .filter((f) => f.startsWith('rank-') && f.endsWith('.json'))
      .sort()
      .reverse();

    const items = [];
    for (const file of files) {
      try {
        const raw = await fs.readFile(path.join(historyDir, file), 'utf8');
        const data = JSON.parse(raw);
        const best = Array.isArray(data.results)
          ? data.results.find((r) => r.status === 'OK' && r.avgSpeedMBps > 0)
          : null;
        items.push({
          id: file.replace(/\.json$/, ''),
          generatedAt: data.generatedAt,
          sortBy: data.sortBy || 'avg',
          totalNodes: data.totalNodes ?? (data.results?.length || 0),
          okNodes: data.okNodes ?? 0,
          topNodeName: data.topNodeName ?? best?.name ?? null,
          topAvgSpeedMBps: data.topAvgSpeedMBps ?? best?.avgSpeedMBps ?? 0,
        });
      } catch {
        // 忽略损坏的历史文件
      }
    }
    return items;
  } catch {
    return [];
  }
}

/**
 * 读取指定历史快照的完整数据。
 * @param {string} historyDir
 * @param {string} id
 */
export async function loadHistorySnapshot(historyDir, id) {
  const safeId = path.basename(id).replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safeId) throw new Error('无效的历史记录 ID');
  const filePath = path.join(historyDir, `${safeId}.json`);
  const raw = await fs.readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

/**
 * 使用 cli-table3 渲染 Top N 可视化榜单字符串。
 * @param {Array<Record<string, any>>} sortedResults
 * @param {number} [limit=20]
 * @returns {string}
 */
export function renderTopTable(sortedResults, limit = 20) {
  const table = new Table({
    head: [
      '排名',
      '节点名称',
      '协议',
      '倍率',
      '延迟(ms)',
      '平均下载(MB/s)',
      '稳态下载(MB/s)',
      '性价比得分',
    ],
  });

  const top = sortedResults.slice(0, limit);
  top.forEach((item, idx) => {
    table.push([
      idx + 1,
      item.name,
      item.type,
      `${item.multiplier}x`,
      item.latencyMs !== null ? item.latencyMs : item.status,
      item.avgSpeedMBps.toFixed(2),
      item.steadySpeedMBps.toFixed(2),
      item.valueScore.toFixed(2),
    ]);
  });

  return table.toString();
}

/**
 * 自动探测 Clash Verge 中包含目标节点的 Selector 策略组。
 * @param {Record<string, any>} proxiesMap
 * @param {string} topNodeName
 * @param {string} [preferredSelector]
 * @returns {string | null}
 */
export function detectClashVergeSelector(proxiesMap, topNodeName, preferredSelector = '') {
  if (preferredSelector && proxiesMap?.[preferredSelector]) {
    return preferredSelector;
  }

  const candidates = [];
  for (const [key, info] of Object.entries(proxiesMap || {})) {
    if (!info || typeof info !== 'object') continue;
    const name = info.name || key;
    if (name === 'GLOBAL') continue;
    if (String(info.type || '').toLowerCase() === 'selector') {
      candidates.push({ name, all: Array.isArray(info.all) ? info.all : [] });
    }
  }

  const exactMatch = candidates.find((c) => c.all.includes(topNodeName));
  if (exactMatch) return exactMatch.name;

  if (candidates.length > 0) return candidates[0].name;
  if (proxiesMap?.GLOBAL) return 'GLOBAL';
  return null;
}

async function defaultPromptConfirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(question);
    return answer.trim().toLowerCase() === 'y';
  } finally {
    rl.close();
  }
}

/**
 * 探测 Clash Verge 是否在线并应用 Top 1 最快节点。
 * @param {string} topNodeName
 * @param {object} settings
 * @param {(question: string) => Promise<boolean>} [promptConfirm]
 * @returns {Promise<{ applied: boolean, selector?: string, reason?: string }>}
 */
export async function applyTopNodeToClashVerge(
  topNodeName,
  settings,
  promptConfirm = defaultPromptConfirm,
) {
  if (!settings.clashVergeApi) {
    return { applied: false, reason: '未配置 clashVergeApi' };
  }

  const baseUrl = settings.clashVergeApi.replace(/\/+$/, '');
  const headers = {};
  if (settings.clashVergeSecret) {
    headers.Authorization = `Bearer ${settings.clashVergeSecret}`;
  }

  const dispatcher = new Agent();
  try {
    const res = await undiciFetch(`${baseUrl}/proxies`, {
      method: 'GET',
      headers,
      dispatcher,
      signal: AbortSignal.timeout(2000),
    });

    if (res.status !== 200) {
      return { applied: false, reason: `Clash Verge API 返回 HTTP ${res.status}` };
    }

    const data = await res.json();
    const selector = detectClashVergeSelector(
      data?.proxies || {},
      topNodeName,
      settings.clashVergeSelector,
    );

    if (!selector) {
      return { applied: false, reason: '未在 Clash Verge 中找到可用的 Selector 策略组' };
    }

    let shouldApply = Boolean(settings.autoApplyTopNode);
    if (!shouldApply) {
      shouldApply = await promptConfirm(
        `\n检测到 Clash Verge 在线，是否将最快节点 "${topNodeName}" 应用到策略组 "${selector}"？(y/N): `,
      );
    }

    if (!shouldApply) {
      return { applied: false, selector, reason: '用户取消应用' };
    }

    const putRes = await undiciFetch(`${baseUrl}/proxies/${encodeURIComponent(selector)}`, {
      method: 'PUT',
      headers: {
        ...headers,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: topNodeName }),
      dispatcher,
      signal: AbortSignal.timeout(2000),
    });

    if (putRes.status !== 204 && putRes.status !== 200) {
      return { applied: false, selector, reason: `切换失败: HTTP ${putRes.status}` };
    }

    return { applied: true, selector };
  } catch (err) {
    return { applied: false, reason: `Clash Verge 未在线或无法连接 (${err.message})` };
  } finally {
    await dispatcher.close().catch(() => {});
  }
}
