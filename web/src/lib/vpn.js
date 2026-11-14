/**
 * 格式化字节数为人类可读字符串 (B / KB / MB / GB)。
 * @param {number} bytes
 */
export function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value <= 0) return '0 B';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(2)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * 格式化耗时毫秒数为可读时长。
 * @param {number} ms
 */
export function formatDuration(ms) {
  const totalMs = Math.max(0, Number(ms) || 0);
  if (totalMs === 0) return '--';
  const totalSec = Math.floor(totalMs / 1000);
  if (totalSec < 60) {
    return `${(totalMs / 1000).toFixed(1)} 秒`;
  }
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  if (hours > 0) {
    return `${hours}小时${String(minutes).padStart(2, '0')}分${String(seconds).padStart(2, '0')}秒`;
  }
  return `${minutes}分${String(seconds).padStart(2, '0')}秒`;
}

/**
 * 格式化实时计时器 (MM:SS)。
 * @param {number} ms
 */
export function formatTimerClock(ms) {
  const totalSec = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export const VPN_TOOLS = [
  {
    id: 'clash-verge',
    name: 'Clash Verge (Rev)',
    mode: 'clash-api',
    defaultApi: 'http://127.0.0.1:9097',
    icon: 'mdi:shield-check-outline',
    desc: '通过 Clash Verge 外部控制接口 (默认 9097) 一键切换节点',
  },
  {
    id: 'mihomo-party',
    name: 'Mihomo Party',
    mode: 'clash-api',
    defaultApi: 'http://127.0.0.1:9090',
    icon: 'mdi:rocket-launch-outline',
    desc: '通过 Mihomo Party 外部控制接口 (默认 9090) 一键切换节点',
  },
  {
    id: 'clash-nyanpasu',
    name: 'Clash Nyanpasu',
    mode: 'clash-api',
    defaultApi: 'http://127.0.0.1:9090',
    icon: 'mdi:cat',
    desc: '通过 Clash Nyanpasu 外部控制接口 (默认 9090) 一键切换节点',
  },
  {
    id: 'clash-common',
    name: 'Clash / FlClash / OpenClash 通用',
    mode: 'clash-api',
    defaultApi: 'http://127.0.0.1:9090',
    icon: 'mdi:lan-connect',
    desc: '支持 FlClash、Clash for Windows、OpenClash、ClashX 等任意 Clash/Mihomo 控制端',
  },
  {
    id: 'v2rayn',
    name: 'v2rayN / Nekoray / Hiddify',
    mode: 'manual',
    defaultApi: '',
    icon: 'mdi:application-brackets-outline',
    desc: '无 Clash 控制 API：支持一键复制节点名称，在客户端内搜索并设为活动服务器',
  },
  {
    id: 'mobile',
    name: 'Shadowrocket / Surge / Sing-box',
    mode: 'manual',
    defaultApi: '',
    icon: 'mdi:cellphone-link',
    desc: '移动端/多平台客户端：支持一键复制节点名称或完整测速摘要，方便跨设备选用',
  },
];

/**
 * 校验主流 Clash/Mihomo 外部控制 API 地址格式并规范化。
 * @param {string} rawUrl
 */
export function validateClashApiUrl(rawUrl) {
  const trimmed = String(rawUrl || '').trim();
  if (!trimmed) {
    return { valid: false, normalized: '', error: '请输入控制 API 地址，例如 http://127.0.0.1:9097' };
  }
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { valid: false, normalized: '', error: 'URL 格式无效，请以 http:// 或 https:// 开头（如 http://127.0.0.1:9097）' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { valid: false, normalized: '', error: '仅支持 http:// 或 https:// 协议' };
  }
  if (!parsed.hostname) {
    return { valid: false, normalized: '', error: '缺少有效的主机名或 IP 地址' };
  }
  if (parsed.port) {
    const p = Number(parsed.port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      return { valid: false, normalized: '', error: '端口号必须在 1～65535 之间' };
    }
  }
  return {
    valid: true,
    normalized: `${parsed.protocol}//${parsed.host}`,
    error: '',
  };
}
