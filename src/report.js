import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import Table from 'cli-table3';
import yaml from 'js-yaml';
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
export async function saveSpeedRank(sortedResults, outputPath, sortBy = 'avg', elapsedMs = 0) {
  const dir = path.dirname(outputPath);
  const historyDir = path.join(dir, 'history');
  await fs.mkdir(historyDir, { recursive: true });

  const now = new Date();
  const best = sortedResults.find((r) => r.status === 'OK' && r.avgSpeedMBps > 0);
  const totalBytes = sortedResults.reduce((acc, r) => acc + (Number(r.totalBytes) || 0), 0);
  const payload = {
    generatedAt: now.toISOString(),
    sortBy,
    totalNodes: sortedResults.length,
    okNodes: sortedResults.filter((r) => r.status === 'OK').length,
    totalBytes,
    elapsedMs,
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
        const totalBytes =
          typeof data.totalBytes === 'number'
            ? data.totalBytes
            : (data.results || []).reduce((acc, r) => acc + (Number(r.totalBytes) || 0), 0);
        items.push({
          id: file.replace(/\.json$/, ''),
          generatedAt: data.generatedAt,
          sortBy: data.sortBy || 'avg',
          totalNodes: data.totalNodes ?? (data.results?.length || 0),
          okNodes: data.okNodes ?? 0,
          totalBytes,
          elapsedMs: Number(data.elapsedMs) || 0,
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

function normalizeApiUrl(raw) {
  const base = String(raw || '').trim().replace(/\/+$/, '');
  if (!base) return '';
  if (!/^https?:\/\//i.test(base)) {
    return `http://${base}`;
  }
  return base;
}

function selectorPriority(name) {
  const lower = String(name || '').trim().toLowerCase();
  if (lower === 'global') return 10;
  if (['节点选择', 'proxy', '代理选择', '代理模式', 'select', '国外流量'].includes(lower)) return 120;
  if (
    ['节点选择', '代理', 'proxy', 'select'].some((kw) => lower.includes(kw)) &&
    !lower.includes('不走代理') &&
    !lower.includes('直连')
  ) {
    return 100;
  }
  if (lower.includes('手动')) return 85;
  if (lower.includes('漏网之鱼') || lower.includes('final')) return 40;
  return 20;
}

export async function probeVpnController(apiUrl, secret = '', nodeName = '') {
  const baseUrl = normalizeApiUrl(apiUrl);
  if (!baseUrl) {
    return { online: false, apiUrl: '', selectors: [], error: '未配置控制 API 地址' };
  }
  const headers = {};
  if (String(secret || '').trim()) {
    headers.Authorization = `Bearer ${String(secret).trim()}`;
  }
  const dispatcher = new Agent();
  try {
    const res = await undiciFetch(`${baseUrl}/proxies`, {
      method: 'GET',
      headers,
      dispatcher,
      signal: AbortSignal.timeout(2500),
    });
    if (res.status !== 200) {
      let msg = `API 返回 HTTP ${res.status}`;
      if (res.status === 400) {
        msg = 'API 返回 HTTP 400（请确认填写的是「外部控制」端口如 9097/9090，而不是代理端口 7890）';
      } else if (res.status === 401) {
        msg = 'API 返回 HTTP 401（Secret 密钥不正确或未填写）';
      }
      return { online: false, apiUrl: baseUrl, selectors: [], error: msg };
    }
    const data = await res.json();
    const proxiesMap = data?.proxies || {};
    const orderMap = new Map();
    if (Array.isArray(proxiesMap.GLOBAL?.all)) {
      proxiesMap.GLOBAL.all.forEach((name, idx) => {
        if (!orderMap.has(name)) orderMap.set(name, idx);
      });
    }
    const selectors = [];
    let globalEntry = null;
    for (const [key, info] of Object.entries(proxiesMap)) {
      if (!info || typeof info !== 'object') continue;
      if (String(info.type || '').toLowerCase() !== 'selector') continue;
      const name = info.name || key;
      const all = Array.isArray(info.all) ? info.all : [];
      const item = {
        name,
        now: info.now || '',
        allCount: all.length,
        hasNode: nodeName ? all.includes(nodeName) : false,
      };
      if (name === 'GLOBAL') {
        globalEntry = item;
      } else {
        selectors.push(item);
      }
    }
    selectors.sort((a, b) => {
      if (a.hasNode !== b.hasNode) return a.hasNode ? -1 : 1;
      const hasA = orderMap.has(a.name);
      const hasB = orderMap.has(b.name);
      if (hasA && hasB && orderMap.get(a.name) !== orderMap.get(b.name)) {
        return orderMap.get(a.name) - orderMap.get(b.name);
      }
      if (hasA !== hasB) return hasA ? -1 : 1;
      const diff = selectorPriority(b.name) - selectorPriority(a.name);
      if (diff !== 0) return diff;
      return a.name.localeCompare(b.name);
    });
    if (globalEntry) selectors.push(globalEntry);
    return { online: true, apiUrl: baseUrl, selectors };
  } catch (err) {
    return { online: false, apiUrl: baseUrl, selectors: [], error: err.message };
  } finally {
    await dispatcher.close().catch(() => {});
  }
}

export async function saveSpeedRankLatestOnly(sortedResults, outputPath, sortBy = 'avg', elapsedMs = 0) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const now = new Date();
  const best = sortedResults.find((r) => r.status === 'OK' && r.avgSpeedMBps > 0);
  const totalBytes = sortedResults.reduce((acc, r) => acc + (Number(r.totalBytes) || 0), 0);
  const payload = {
    generatedAt: now.toISOString(),
    sortBy,
    totalNodes: sortedResults.length,
    okNodes: sortedResults.filter((r) => r.status === 'OK').length,
    totalBytes,
    elapsedMs,
    topNodeName: best?.name || null,
    topAvgSpeedMBps: best?.avgSpeedMBps || 0,
    results: sortedResults,
  };
  await fs.writeFile(outputPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
}

export async function buildOptimizedClashYAML(runtimeYamlPath, targetNames = []) {
  if (!Array.isArray(targetNames) || targetNames.length === 0) {
    throw new Error('没有可导出的可用节点');
  }
  let raw;
  try {
    raw = await fs.readFile(runtimeYamlPath, 'utf8');
  } catch {
    throw new Error(`未找到运行时订阅配置 (${runtimeYamlPath})，请先执行一次测速或预览`);
  }
  const parsed = yaml.load(raw);
  const rawProxies = Array.isArray(parsed?.proxies) ? parsed.proxies : [];
  if (rawProxies.length === 0) {
    throw new Error('当前订阅采用远程 proxy-providers 模式或未包含内联 proxies 列表，暂不支持直接导出精简 YAML');
  }
  const byName = new Map();
  for (const p of rawProxies) {
    if (p && typeof p === 'object' && p.name) {
      byName.set(p.name, p);
    }
  }
  const selectedProxies = [];
  const selectedNames = [];
  for (const name of targetNames) {
    if (byName.has(name)) {
      selectedProxies.push(byName.get(name));
      selectedNames.push(name);
    }
  }
  if (selectedProxies.length === 0) {
    throw new Error('未能从当前订阅配置中匹配到优选节点（可能订阅已更新，请重新测速）');
  }
  const outConfig = {
    'mixed-port': 7890,
    'allow-lan': false,
    mode: 'rule',
    'log-level': 'info',
    'unified-delay': true,
    'external-controller': '127.0.0.1:9090',
    proxies: selectedProxies,
    'proxy-groups': [
      {
        name: '🚀 节点选择',
        type: 'select',
        proxies: ['♻️ 自动优选', '🔯 故障转移', ...selectedNames],
      },
      {
        name: '♻️ 自动优选',
        type: 'url-test',
        url: 'http://www.gstatic.com/generate_204',
        interval: 300,
        tolerance: 50,
        proxies: selectedNames,
      },
      {
        name: '🔯 故障转移',
        type: 'fallback',
        url: 'http://www.gstatic.com/generate_204',
        interval: 300,
        proxies: selectedNames,
      },
    ],
    rules: ['GEOIP,LAN,DIRECT', 'GEOIP,CN,DIRECT', 'MATCH,🚀 节点选择'],
  };
  const header =
    '# 由 Mihomo Speedtest 自动生成的精简优选配置文件\n# 仅保留测速优选节点，内置自动测速 (url-test) 与故障转移 (fallback)\n';
  return {
    yaml: header + yaml.dump(outConfig, { lineWidth: -1, noRefs: true }),
    count: selectedProxies.length,
  };
}

export async function applyNodeToVpn(apiUrl, secret = '', selector = '', nodeName = '') {
  const baseUrl = normalizeApiUrl(apiUrl);
  if (!nodeName || !String(nodeName).trim()) {
    throw new Error('节点名称不能为空');
  }
  let targetSelector = String(selector || '').trim();
  if (!targetSelector) {
    const probe = await probeVpnController(baseUrl, secret, nodeName);
    if (!probe.online) {
      throw new Error(`客户端未在线或无法连接 (${probe.error})`);
    }
    const preferred = probe.selectors.find((s) => s.hasNode && s.name !== 'GLOBAL') || probe.selectors[0];
    if (!preferred) {
      throw new Error('未在客户端中找到可用的 Selector 策略组');
    }
    targetSelector = preferred.name;
  }

  const headers = { 'Content-Type': 'application/json' };
  if (String(secret || '').trim()) {
    headers.Authorization = `Bearer ${String(secret).trim()}`;
  }
  const dispatcher = new Agent();
  try {
    const putRes = await undiciFetch(`${baseUrl}/proxies/${encodeURIComponent(targetSelector)}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ name: nodeName }),
      dispatcher,
      signal: AbortSignal.timeout(2500),
    });
    if (putRes.status !== 204 && putRes.status !== 200) {
      throw new Error(`切换节点失败 (策略组 ${targetSelector}): HTTP ${putRes.status}`);
    }
    return {
      applied: true,
      selector: targetSelector,
      nodeName,
      message: `已将「${nodeName}」应用到策略组「${targetSelector}」`,
    };
  } finally {
    await dispatcher.close().catch(() => {});
  }
}
