import { spawn } from 'node:child_process';
import { Agent, fetch as undiciFetch } from 'undici';

export const ALLOWED_PROXY_TYPES = new Set([
  'ss',
  'shadowsocks',
  'ssr',
  'shadowsocksr',
  'vmess',
  'vless',
  'trojan',
  'hysteria',
  'hysteria2',
  'tuic',
  'anytls',
  'wireguard',
  'socks5',
  'http',
]);

const MULTIPLIER_REGEX = /(\d+(?:\.\d+)?)\s*[xX倍]/;

export const REGION_DEFINITIONS = {
  ASIA: {
    terms: [
      '亚洲', 'asia',
      '香港', 'hong kong', 'hongkong', 'hkg', '🇭🇰',
      '台湾', '台灣', '台北', 'taiwan', 'taipei', 'tpe', '🇹🇼',
      '日本', '东京', '大阪', 'japan', 'tokyo', 'osaka', 'nrt', 'kix', '🇯🇵',
      '新加坡', '狮城', 'singapore', '🇸🇬',
      '韩国', '韓國', '首尔', 'korea', 'seoul', 'icn', '🇰🇷',
      '澳门', 'macau', '🇲🇴',
      '马来西亚', 'malaysia', '吉隆坡', '🇲🇾',
      '泰国', 'thailand', '曼谷', 'bangkok', '🇹🇭',
      '越南', 'vietnam', '胡志明', '河内', '🇻🇳',
      '印度', 'india', '孟买', 'mumbai', '🇮🇳',
      '印尼', '印度尼西亚', 'indonesia', '雅加达', '🇮🇩',
      '菲律宾', 'philippines', '马尼拉', '🇵🇭',
      '阿联酋', '迪拜', 'dubai', '🇦🇪',
      '以色列', 'israel', '🇮🇱',
      '土耳其', 'turkey', '伊斯坦布尔', 'istanbul', '🇹🇷',
    ],
    codes: ['hk', 'tw', 'jp', 'sg', 'kr'],
    upperCodes: ['MO', 'MY', 'TH', 'VN', 'PH', 'AE', 'IL', 'TR'],
  },
  EU: {
    terms: [
      '欧洲', 'europe',
      '英国', 'united kingdom', '伦敦', 'london', '🇬🇧',
      '德国', 'germany', '法兰克福', 'frankfurt', '🇩🇪',
      '法国', 'france', '巴黎', 'paris', '🇫🇷',
      '荷兰', 'netherlands', '阿姆斯特丹', 'amsterdam', '🇳🇱',
      '瑞士', 'switzerland', '苏黎世', 'zurich', '🇨🇭',
      '瑞典', 'sweden', '斯德哥尔摩', '🇸🇪',
      '意大利', 'italy', '米兰', 'milan', '罗马', '🇮🇹',
      '西班牙', 'spain', '马德里', 'madrid', '巴塞罗那', '🇪🇸',
      '波兰', 'poland', '华沙', '🇵🇱',
      '爱尔兰', 'ireland', '都柏林', '🇮🇪',
      '芬兰', 'finland', '赫尔辛基', '🇫🇮',
      '挪威', 'norway', '🇳🇴',
      '俄罗斯', 'russia', '莫斯科', 'moscow', '🇷🇺',
      '土耳其', 'turkey', '伊斯坦布尔', 'istanbul', '🇹🇷',
      '🇪🇺',
    ],
    codes: ['uk', 'gb', 'de', 'fr', 'nl', 'ch', 'se', 'ru', 'eu'],
    upperCodes: ['ES', 'PL', 'IE', 'FI', 'TR'],
  },
  AMERICA: {
    terms: [
      '美洲', '北美', '南美', 'america',
      '美国', 'united states', '洛杉矶', '圣何塞', '西雅图', '纽约', '芝加哥', '达拉斯', '迈阿密', '硅谷',
      'los angeles', 'san jose', 'seattle', 'new york', 'lax', 'sjc', '🇺🇸',
      '加拿大', 'canada', '多伦多', '温哥华', '蒙特利尔', 'toronto', 'vancouver', '🇨🇦',
      '墨西哥', 'mexico', '🇲🇽',
      '巴西', 'brazil', '圣保罗', '🇧🇷',
      '阿根廷', 'argentina', '🇦🇷',
      '智利', 'chile', '🇨🇱',
    ],
    codes: ['us', 'usa'],
    upperCodes: ['CA', 'MX', 'BR', 'AR', 'CL'],
  },
  OCEANIA: {
    terms: [
      '大洋洲', 'oceania',
      '澳洲', '澳大利亚', 'australia', '悉尼', '墨尔本', 'sydney', 'melbourne', '🇦🇺',
      '新西兰', 'new zealand', '奥克兰', 'auckland', '🇳🇿',
    ],
    codes: ['au', 'nz'],
    upperCodes: [],
  },
  HK: {
    terms: ['香港', 'hong kong', 'hongkong', 'hkg', '🇭🇰'],
    codes: ['hk'],
    upperCodes: [],
  },
  TW: {
    terms: ['台湾', '台灣', '台北', 'taiwan', 'taipei', 'tpe', '🇹🇼'],
    codes: ['tw'],
    upperCodes: [],
  },
  JP: {
    terms: ['日本', '东京', '大阪', 'japan', 'tokyo', 'osaka', 'nrt', 'kix', '🇯🇵'],
    codes: ['jp'],
    upperCodes: [],
  },
  SG: {
    terms: ['新加坡', '狮城', 'singapore', '🇸🇬'],
    codes: ['sg'],
    upperCodes: [],
  },
  US: {
    terms: ['美国', 'united states', 'america', '洛杉矶', '圣何塞', '西雅图', '纽约', 'los angeles', 'san jose', 'seattle', 'new york', '🇺🇸'],
    codes: ['us', 'usa'],
    upperCodes: [],
  },
  KR: {
    terms: ['韩国', '韓國', '首尔', 'korea', 'seoul', 'icn', '🇰🇷'],
    codes: ['kr'],
    upperCodes: [],
  },
};

const CASE_SENSITIVE_SHORT_CODES = new Set([
  'mo', 'my', 'th', 'vn', 'in', 'id', 'ph',
  'ae', 'il', 'tr', 'it', 'es', 'pl', 'ie',
  'fi', 'no', 'ca', 'mx', 'br', 'ar', 'cl',
]);

function matchesKeywordList(name, keywords, forceCaseSensitive = false) {
  const lower = name.toLowerCase();
  return keywords.some((raw) => {
    const kw = String(raw || '').trim();
    if (!kw) return false;
    // 2~3 位纯英文字母短码：允许紧跟数字（如 HK01/US02），但不允许前后紧跟其他字母（避免 Russia 误伤 us）
    // 对易与英文单词冲突的短码（如 in/my/id/no/it），要求全大写匹配
    if (/^[a-zA-Z]{2,3}$/.test(kw)) {
      const cs = forceCaseSensitive || CASE_SENSITIVE_SHORT_CODES.has(kw.toLowerCase());
      const target = cs ? kw.toUpperCase() : kw;
      const re = new RegExp(`(?:^|[^a-zA-Z])${target}(?:[^a-zA-Z]|$)`, cs ? '' : 'i');
      return re.test(name);
    }
    return lower.includes(kw.toLowerCase());
  });
}

function matchesRegion(name, regionCode, customRegionKeywords = {}) {
  const code = String(regionCode).toUpperCase();
  const customList = customRegionKeywords?.[code];
  if (Array.isArray(customList) && customList.length > 0) {
    return matchesKeywordList(name, customList, false);
  }
  const def = REGION_DEFINITIONS[code];
  if (!def) return false;
  return (
    matchesKeywordList(name, def.terms, false) ||
    matchesKeywordList(name, def.codes, false) ||
    matchesKeywordList(name, def.upperCodes || [], true)
  );
}

/**
 * 从节点名称中提取流量倍率，未标注默认返回 1.0。
 * @param {string} name
 * @returns {number}
 */
export function extractMultiplier(name) {
  const match = String(name).match(MULTIPLIER_REGEX);
  if (!match) return 1.0;
  const parsed = Number.parseFloat(match[1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1.0;
}

/**
 * 根据协议白名单、排除关键词及地区/包含关键词过滤节点，并解析流量倍率。
 * @param {Record<string, { name?: string, type?: string }>} proxiesMap
 * @param {string[]} [excludeKeywords=[]]
 * @param {{ includeRegions?: string[], includeKeywords?: string[] }} [includeOpts={}]
 * @returns {Array<{ name: string, type: string, multiplier: number }>}
 */
export function filterAndNormalizeProxies(proxiesMap, excludeKeywords = [], includeOpts = {}) {
  const result = [];
  const lowerKeywords = excludeKeywords.map((kw) => kw.toLowerCase());
  const includeRegions = Array.isArray(includeOpts.includeRegions)
    ? includeOpts.includeRegions.filter(Boolean)
    : [];
  const includeKeywords = Array.isArray(includeOpts.includeKeywords)
    ? includeOpts.includeKeywords.map((kw) => kw.trim().toLowerCase()).filter(Boolean)
    : [];
  const regionKeywords = includeOpts.regionKeywords || {};
  const hasIncludeFilter = includeRegions.length > 0 || includeKeywords.length > 0;

  for (const [key, info] of Object.entries(proxiesMap || {})) {
    if (!info || typeof info !== 'object') continue;
    const name = info.name || key;
    const rawType = String(info.type || '').trim();
    if (!ALLOWED_PROXY_TYPES.has(rawType.toLowerCase())) {
      continue;
    }

    const lowerName = name.toLowerCase();
    if (lowerKeywords.some((kw) => kw && lowerName.includes(kw))) {
      continue;
    }

    if (hasIncludeFilter) {
      const hitRegion = includeRegions.some((r) => matchesRegion(name, r, regionKeywords));
      const hitKeyword = includeKeywords.some((kw) => lowerName.includes(kw));
      if (!hitRegion && !hitKeyword) {
        continue;
      }
    }

    result.push({
      name,
      type: rawType,
      multiplier: extractMultiplier(name),
    });
  }

  return result;
}

/**
 * 发起 Mihomo Controller API 请求（禁用系统代理环境变量）。
 * @param {{ controllerPort: number, controllerSecret: string, dispatcher: Agent }} ctx
 * @param {string} apiPath
 * @param {RequestInit} [init]
 */
export async function controllerFetch(ctx, apiPath, init = {}) {
  const url = `http://127.0.0.1:${ctx.controllerPort}${apiPath}`;
  const headers = {
    ...(init.headers || {}),
  };
  if (ctx.controllerSecret) {
    headers.Authorization = `Bearer ${ctx.controllerSecret}`;
  }
  return undiciFetch(url, {
    ...init,
    headers,
    dispatcher: ctx.dispatcher,
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 启动 Mihomo 内核子进程并注册退出清理钩子，等待 Controller API 就绪。
 * @param {{
 *   binaryPath: string,
 *   configsDir: string,
 *   runtimeYamlPath: string,
 *   controllerPort: number,
 *   controllerSecret: string,
 *   hasProviders?: boolean,
 *   startupTimeoutMs?: number
 * }} options
 * @returns {Promise<{
 *   child: import('node:child_process').ChildProcess,
 *   dispatcher: Agent,
 *   stop: () => Promise<void>
 * }>}
 */
export async function startMihomoProcess(options) {
  const {
    binaryPath,
    configsDir,
    runtimeYamlPath,
    controllerPort,
    controllerSecret,
    hasProviders = false,
    startupTimeoutMs = 15000,
  } = options;

  const child = spawn(binaryPath, ['-d', configsDir, '-f', runtimeYamlPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const logs = [];
  const collectLog = (chunk) => {
    logs.push(chunk.toString('utf8'));
    if (logs.length > 30) logs.shift();
  };
  child.stdout?.on('data', collectLog);
  child.stderr?.on('data', collectLog);

  let exited = false;
  let exitCode = null;
  let spawnError = null;
  child.once('error', (err) => {
    spawnError = err;
    exited = true;
  });
  child.once('exit', (code) => {
    exited = true;
    exitCode = code;
  });

  const dispatcher = new Agent();
  let stopped = false;

  const syncKill = () => {
    if (!exited && !child.killed) {
      try {
        child.kill('SIGKILL');
      } catch {
        try {
          child.kill();
        } catch {
          // ignore
        }
      }
    }
  };

  const onExit = () => syncKill();
  const onSigInt = () => {
    syncKill();
    process.exit(130);
  };
  const onSigTerm = () => {
    syncKill();
    process.exit(143);
  };
  const onUncaught = (err) => {
    syncKill();
    console.error('发生未捕获异常，已清理 Mihomo 子进程:', err);
    process.exit(1);
  };

  process.on('exit', onExit);
  process.on('SIGINT', onSigInt);
  process.on('SIGTERM', onSigTerm);
  process.on('uncaughtException', onUncaught);

  const stop = async () => {
    if (stopped) return;
    stopped = true;
    process.off('exit', onExit);
    process.off('SIGINT', onSigInt);
    process.off('SIGTERM', onSigTerm);
    process.off('uncaughtException', onUncaught);
    syncKill();
    await dispatcher.close().catch(() => {});
  };

  const ctx = { controllerPort, controllerSecret, dispatcher };
  const deadline = Date.now() + startupTimeoutMs;

  // 轮询 /version 直到返回 200
  let ready = false;
  while (Date.now() < deadline) {
    if (exited) {
      await stop();
      if (spawnError) {
        const err = new Error(`启动 Mihomo 内核失败 (${spawnError.message})`);
        err.code = spawnError.code;
        throw err;
      }
      throw new Error(`Mihomo 内核提前退出 (exit code: ${exitCode})。\n最近日志:\n${logs.join('')}`);
    }
    try {
      const res = await controllerFetch(ctx, '/version');
      if (res.status === 200) {
        ready = true;
        break;
      }
    } catch {
      // 等待内核监听端口
    }
    await sleep(200);
  }

  if (!ready) {
    await stop();
    throw new Error(`等待 Mihomo Controller API 超时 (${startupTimeoutMs}ms)。\n最近日志:\n${logs.join('')}`);
  }

  // 若配置含 proxy-providers，额外等待 /providers/proxies 加载完毕
  if (hasProviders) {
    const providerDeadline = Date.now() + 10000;
    while (Date.now() < providerDeadline) {
      if (exited) break;
      try {
        const res = await controllerFetch(ctx, '/providers/proxies');
        if (res.status === 200) {
          const data = await res.json();
          const providers = Object.values(data?.providers || {});
          const loaded = providers.some((p) => Array.isArray(p.proxies) && p.proxies.length > 0);
          if (loaded) break;
        }
      } catch {
        // ignore and retry
      }
      await sleep(250);
    }
  }

  return { child, dispatcher, stop };
}

/**
 * 从运行中的 Mihomo Controller 获取并过滤所有有效出站节点。
 * @param {{ controllerPort: number, controllerSecret: string, dispatcher: Agent }} ctx
 * @param {string[]} excludeKeywords
 * @param {{ includeRegions?: string[], includeKeywords?: string[] }} [includeOpts]
 */
export async function fetchFilteredProxies(ctx, excludeKeywords, includeOpts = {}) {
  const res = await controllerFetch(ctx, '/proxies');
  if (res.status !== 200) {
    throw new Error(`获取节点列表失败: HTTP ${res.status}`);
  }
  const data = await res.json();
  return filterAndNormalizeProxies(data?.proxies || {}, excludeKeywords, includeOpts);
}
