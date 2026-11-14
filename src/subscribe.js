import fs from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';
import { Agent, fetch as undiciFetch } from 'undici';

const URI_SCHEME_REGEX = /(?:vless|hy2|hysteria2|trojan|ss|ssr|vmess|tuic|anytls):\/\//i;

/**
 * 兼容标准 Base64 与 URL-Safe Base64 解码。
 * @param {string} input
 * @returns {string}
 */
export function decodeBase64Flexible(input) {
  const normalized = input.trim().replace(/-/g, '+').replace(/_/g, '/');
  const padLength = (4 - (normalized.length % 4)) % 4;
  const padded = normalized + '='.repeat(padLength);
  return Buffer.from(padded, 'base64').toString('utf8');
}

/**
 * 获取原始订阅文本（支持本地文件与在线 URL 多 UA 轮询，禁用系统代理环境变量）。
 * @param {string} subscribeUrl
 * @param {string[]} userAgents
 * @param {string} rawSavePath
 * @returns {Promise<{ rawText: string, source: 'local' | 'remote', usedUserAgent?: string }>}
 */
export async function fetchSubscriptionRaw(subscribeUrl, userAgents, rawSavePath) {
  const isRemote = /^https?:\/\//i.test(subscribeUrl.trim());
  let rawText = '';
  let usedUserAgent;

  if (!isRemote) {
    rawText = await fs.readFile(subscribeUrl, 'utf8');
    if (!rawText.trim()) {
      throw new Error(`本地订阅文件为空: ${subscribeUrl}`);
    }
  } else {
    const directAgent = new Agent();
    const errors = [];
    try {
      for (const ua of userAgents) {
        try {
          const res = await undiciFetch(subscribeUrl, {
            method: 'GET',
            headers: { 'User-Agent': ua },
            dispatcher: directAgent,
          });
          const body = await res.text();
          if (res.status === 200 && body.trim().length > 0) {
            rawText = body;
            usedUserAgent = ua;
            break;
          }
          errors.push(`UA="${ua}" -> HTTP ${res.status}`);
        } catch (err) {
          errors.push(`UA="${ua}" -> ${err.message}`);
        }
      }
    } finally {
      await directAgent.close();
    }

    if (!rawText.trim()) {
      throw new Error(`拉取在线订阅失败，所有 User-Agent 均未成功:\n  - ${errors.join('\n  - ')}`);
    }
  }

  await fs.mkdir(path.dirname(rawSavePath), { recursive: true });
  await fs.writeFile(rawSavePath, rawText, 'utf8');
  return {
    rawText,
    source: isRemote ? 'remote' : 'local',
    usedUserAgent,
  };
}

/**
 * 确保 proxy-groups 中包含引用指定 provider 的 GLOBAL 策略组。
 * @param {Array<Record<string, any>>} existingGroups
 * @param {string[]} providerNames
 * @returns {Array<Record<string, any>>}
 */
function ensureGlobalGroupWithProviders(existingGroups, providerNames) {
  const groups = Array.isArray(existingGroups) ? existingGroups.map((g) => ({ ...g })) : [];
  let globalGroup = groups.find((g) => g && g.name === 'GLOBAL');
  if (!globalGroup) {
    globalGroup = {
      name: 'GLOBAL',
      type: 'select',
      use: [...providerNames],
    };
    groups.unshift(globalGroup);
  } else {
    const existingUse = Array.isArray(globalGroup.use) ? globalGroup.use : [];
    globalGroup.type = 'select';
    globalGroup.use = Array.from(new Set([...existingUse, ...providerNames]));
  }
  return groups;
}

/**
 * 嗅探订阅格式并生成清洗后的 Mihomo 运行时配置对象。
 * @param {string} rawText
 * @param {{ mixedPort: number, controllerPort: number, controllerSecret: string, rawUrisPath: string }} options
 * @returns {Promise<{ format: 'clash-yaml' | 'uri-list' | 'proxy-providers', config: Record<string, any>, hasProviders: boolean }>}
 */
export async function buildRuntimeConfig(rawText, options) {
  const { mixedPort, controllerPort, controllerSecret, rawUrisPath, workerPorts } = options;

  let parsedYaml = null;
  try {
    const doc = yaml.load(rawText);
    if (doc && typeof doc === 'object' && !Array.isArray(doc)) {
      parsedYaml = doc;
    }
  } catch {
    // 非合法 YAML，交由 Base64 / URI 层嗅探
  }

  let format = null;
  let baseConfig = {};
  let hasProviders = false;

  // 格式 A: 标准 Clash YAML (含有效 proxies)
  if (parsedYaml && Array.isArray(parsedYaml.proxies) && parsedYaml.proxies.length > 0) {
    format = 'clash-yaml';
    baseConfig = { ...parsedYaml };
    hasProviders = Boolean(
      parsedYaml['proxy-providers'] && Object.keys(parsedYaml['proxy-providers']).length > 0,
    );
  }
  // 格式 C: 远程 proxy-providers 配置 (proxies 为空但存在 proxy-providers)
  else if (
    parsedYaml &&
    parsedYaml['proxy-providers'] &&
    typeof parsedYaml['proxy-providers'] === 'object' &&
    Object.keys(parsedYaml['proxy-providers']).length > 0
  ) {
    format = 'proxy-providers';
    hasProviders = true;
    const providerNames = Object.keys(parsedYaml['proxy-providers']);
    baseConfig = {
      ...parsedYaml,
      'proxy-groups': ensureGlobalGroupWithProviders(parsedYaml['proxy-groups'], providerNames),
    };
  }
  // 格式 B: Base64 订阅或明文 URI 列表
  else {
    let uriText = '';
    if (URI_SCHEME_REGEX.test(rawText)) {
      uriText = rawText.trim();
    } else {
      const decoded = decodeBase64Flexible(rawText);
      if (URI_SCHEME_REGEX.test(decoded)) {
        uriText = decoded.trim();
      }
    }

    if (!uriText) {
      throw new Error('订阅格式无法识别：既不是有效的 Clash YAML，也不包含受支持的代理节点 URI。');
    }

    format = 'uri-list';
    hasProviders = true;
    await fs.mkdir(path.dirname(rawUrisPath), { recursive: true });
    await fs.writeFile(rawUrisPath, uriText + '\n', 'utf8');

    baseConfig = {
      'proxy-providers': {
        'sub-uris': {
          type: 'file',
          path: './raw-uris.txt',
          'health-check': {
            enable: false,
          },
        },
      },
      'proxy-groups': [
        {
          name: 'GLOBAL',
          type: 'select',
          use: ['sub-uris'],
        },
      ],
    };
  }

  // 移除可能影响独立测速实例启动的字段
  delete baseConfig.tun;
  delete baseConfig['external-ui'];
  delete baseConfig.listeners;

  const portsList =
    Array.isArray(workerPorts) && workerPorts.length > 0
      ? workerPorts
      : [mixedPort];

  // 强制覆盖顶层配置（防假速与 DNS 隔离核心）
  const runtimeConfig = {
    ...baseConfig,
    'mixed-port': portsList[0],
    'allow-lan': false,
    mode: portsList.length > 1 ? 'rule' : 'global',
    'log-level': 'warning',
    'external-controller': `127.0.0.1:${controllerPort}`,
    secret: controllerSecret,
    dns: {
      enable: true,
      'enhanced-mode': 'fake-ip',
      'fake-ip-range': '198.18.0.1/16',
      nameserver: ['223.5.5.5', '1.1.1.1'],
    },
    rules: ['MATCH,GLOBAL'],
  };

  if (portsList.length > 1) {
    const proxyNames = Array.isArray(runtimeConfig.proxies)
      ? runtimeConfig.proxies.map((p) => p?.name).filter(Boolean)
      : [];
    const providerNames =
      runtimeConfig['proxy-providers'] && typeof runtimeConfig['proxy-providers'] === 'object'
        ? Object.keys(runtimeConfig['proxy-providers'])
        : [];
    const groups = Array.isArray(runtimeConfig['proxy-groups']) ? [...runtimeConfig['proxy-groups']] : [];
    const listeners = [];
    const rules = [];

    portsList.forEach((wp, idx) => {
      const gName = `SPEEDTEST_W${idx}`;
      const grp = { name: gName, type: 'select' };
      if (proxyNames.length > 0) grp.proxies = proxyNames;
      if (providerNames.length > 0) grp.use = providerNames;
      groups.push(grp);
      listeners.push({
        name: `st-in-${idx}`,
        type: 'mixed',
        listen: '127.0.0.1',
        port: wp,
        proxy: gName,
      });
      rules.push(`IN-PORT,${wp},${gName}`);
    });
    rules.push('MATCH,GLOBAL');
    runtimeConfig['proxy-groups'] = groups;
    runtimeConfig.listeners = listeners;
    runtimeConfig.rules = rules;
  }

  return { format, config: runtimeConfig, hasProviders };
}

/**
 * 执行完整的订阅拉取、嗅探清洗并写入 runtime.yaml。
 * @param {object} settings
 * @param {{ mixedPort?: number, workerPorts?: number[], controllerPort: number, configsDir: string }} runtimeOpts
 * @returns {Promise<{ format: string, runtimeYamlPath: string, hasProviders: boolean, source: string, usedUserAgent?: string }>}
 */
export async function prepareRuntimeSubscription(
  settings,
  { mixedPort, workerPorts, controllerPort, configsDir },
) {
  const rawSavePath = path.join(configsDir, 'sub.raw');
  const rawUrisPath = path.join(configsDir, 'raw-uris.txt');
  const runtimeYamlPath = path.join(configsDir, 'runtime.yaml');

  const { rawText, source, usedUserAgent } = await fetchSubscriptionRaw(
    settings.subscribeUrl,
    settings.userAgents,
    rawSavePath,
  );

  const { format, config, hasProviders } = await buildRuntimeConfig(rawText, {
    mixedPort: mixedPort || workerPorts?.[0] || settings.mixedPort,
    workerPorts,
    controllerPort,
    controllerSecret: settings.controllerSecret,
    rawUrisPath,
  });

  await fs.mkdir(configsDir, { recursive: true });
  await fs.writeFile(runtimeYamlPath, yaml.dump(config, { lineWidth: -1 }), 'utf8');

  return {
    format,
    runtimeYamlPath,
    hasProviders,
    source,
    usedUserAgent,
  };
}
