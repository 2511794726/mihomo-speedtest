import fs from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_SETTINGS = {
  subscribeUrl: 'https://example.com/api/v1/client/subscribe?token=YOUR_TOKEN',
  userAgents: [
    'ClashVerge/2.0.0',
    'ClashMetaForAndroid/2.11.2',
    'v2rayN/7.25.0',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
  ],
  mixedPort: 17890,
  controllerPort: 19090,
  controllerSecret: 'speedtest-secret',
  testUrl: 'https://speed.cloudflare.com/__down?bytes=25000000',
  maxBytesPerNode: 10485760,
  downloadTimeoutMs: 8000,
  latencyTimeoutMs: 3000,
  excludeKeywords: ['官网', '公告', '剩余流量', '套餐到期', '重置', '订阅', '网址'],
  includeRegions: [],
  includeKeywords: [],
  regionKeywords: {},
  clashVergeApi: 'http://127.0.0.1:9097',
  clashVergeSecret: '',
  clashVergeSelector: '',
  autoApplyTopNode: false,
};

/**
 * 读取或初始化 settings.json 配置文件。
 * @param {string} settingsPath
 * @returns {Promise<{ created: boolean, settings: typeof DEFAULT_SETTINGS }>}
 */
export async function loadSettings(settingsPath) {
  try {
    const raw = await fs.readFile(settingsPath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      created: false,
      settings: {
        ...DEFAULT_SETTINGS,
        ...parsed,
      },
    };
  } catch (err) {
    if (err.code === 'ENOENT') {
      await fs.mkdir(path.dirname(settingsPath), { recursive: true });
      await fs.writeFile(settingsPath, JSON.stringify(DEFAULT_SETTINGS, null, 2) + '\n', 'utf8');
      return {
        created: true,
        settings: { ...DEFAULT_SETTINGS },
      };
    }
    throw new Error(`读取配置文件失败 (${settingsPath}): ${err.message}`);
  }
}

const VALID_SORT_MODES = new Set(['avg', 'steady', 'value']);

/**
 * 解析命令行参数，支持 --sort=avg|steady|value。
 * @param {string[]} argv
 * @returns {{ sortBy: 'avg' | 'steady' | 'value' }}
 */
export function parseCliArgs(argv = process.argv.slice(2)) {
  let sortBy = 'avg';
  for (const arg of argv) {
    if (arg.startsWith('--sort=')) {
      const value = arg.slice('--sort='.length).trim().toLowerCase();
      if (VALID_SORT_MODES.has(value)) {
        sortBy = value;
      } else {
        throw new Error(`不支持的排序参数 "${value}"，可选值: avg, steady, value`);
      }
    }
  }
  return { sortBy };
}
