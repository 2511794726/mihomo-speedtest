<script setup>
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue';
import { Icon } from '@iconify/vue';
import { TooltipProvider, CollapsibleRoot, CollapsibleContent } from 'reka-ui';
import Button from './components/ui/Button.vue';
import Card from './components/ui/Card.vue';
import Input from './components/ui/Input.vue';
import Badge from './components/ui/Badge.vue';
import Progress from './components/ui/Progress.vue';
import Select from './components/ui/Select.vue';
import Dialog from './components/ui/Dialog.vue';
import Tooltip from './components/ui/Tooltip.vue';
import { buildSceneRecommendations } from './lib/recommend.js';

const settings = ref({
  subscribeUrl: '',
  maxBytesPerNode: 10485760,
  downloadTimeoutMs: 8000,
  latencyTimeoutMs: 3000,
  excludeKeywords: [],
  includeRegions: [],
  includeKeywords: [],
  regionKeywords: {},
  clashVergeApi: 'http://127.0.0.1:9097',
  clashVergeSelector: '',
  testUrl: 'https://speed.cloudflare.com/__down?bytes=25000000',
});

const UI_PREFS_KEY = 'mihomo_speedtest_ui_prefs';

function loadUiPrefs() {
  try {
    const raw = localStorage.getItem(UI_PREFS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

const initialPrefs = loadUiPrefs();

const excludeKeywordsText = ref('');
const includeKeywordsText = ref('');
const showAdvanced = ref(Boolean(initialPrefs.showAdvanced));
const showLogs = ref(initialPrefs.showLogs !== undefined ? Boolean(initialPrefs.showLogs) : true);
const sortBy = ref(initialPrefs.sortBy || 'avg');
const sortField = ref('avgSpeedMBps');
const sortOrder = ref('desc');
const limit = ref(initialPrefs.limit !== undefined ? String(initialPrefs.limit) : '0');
const searchQuery = ref('');

const running = ref(false);
const stage = ref('idle');
const total = ref(0);
const completed = ref(0);
const results = ref([]);
const logs = ref([]);
const logBoxRef = ref(null);

const saving = ref(false);
const historyList = ref([]);
const selectedHistoryId = ref('__latest__');
const activeHistoryMeta = ref(null);

const compareModalOpen = ref(false);
const compareNodeName = ref('');
const compareLoading = ref(false);
const compareRecords = ref([]);

const toast = ref(null);
let toastTimer = null;
let eventSource = null;

const sortOptions = [
  { value: 'avg', label: '平均下载速率 (MB/s)' },
  { value: 'steady', label: '稳态下载速率 (MB/s)' },
  { value: 'value', label: '性价比得分 (速度/倍率)' },
];

const limitOptions = [
  { value: '0', label: '全部节点' },
  { value: '5', label: '抽测前 5 个' },
  { value: '15', label: '抽测前 15 个' },
  { value: '30', label: '抽测前 30 个' },
  { value: '50', label: '抽测前 50 个' },
];

const regionPresets = [
  { code: 'ASIA', label: '🌏 亚洲' },
  { code: 'EU', label: '🌍 欧洲' },
  { code: 'AMERICA', label: '🌎 美洲' },
  { code: 'OCEANIA', label: '🦘 大洋洲' },
  { code: 'HK', label: '🇭🇰 香港' },
  { code: 'TW', label: '🇹🇼 台湾' },
  { code: 'JP', label: '🇯🇵 日本' },
  { code: 'SG', label: '🇸🇬 新加坡' },
  { code: 'US', label: '🇺🇸 美国' },
  { code: 'KR', label: '🇰🇷 韩国' },
];

const DEFAULT_REGION_KEYWORDS = {
  ASIA: [
    '香港', 'hong kong', 'hongkong', 'hk',
    '台湾', 'taiwan', 'tw', '台北', 'taipei',
    '日本', 'japan', 'jp', '东京', 'tokyo', '大阪', 'osaka',
    '新加坡', 'singapore', 'sg', '狮城',
    '韩国', 'korea', 'kr', '首尔', 'seoul',
    '马来西亚', 'malaysia', 'my', '吉隆坡',
    '泰国', 'thailand', 'th', '曼谷',
    '越南', 'vietnam', 'vn', '胡志明', '河内',
    '菲律宾', 'philippines', 'ph', '马尼拉',
    '印度尼西亚', '印尼', 'indonesia', 'id', '雅加达',
    '印度', 'india', 'in', '孟买', '新德里',
    '阿联酋', 'uae', '迪拜', 'dubai',
    '以色列', 'israel', 'il', '特拉维夫',
    '土耳其', 'turkey', 'tr', '伊斯坦布尔',
    '亚洲', 'asia',
  ],
  EU: [
    '英国', 'united kingdom', 'uk', 'gb', '伦敦', 'london',
    '德国', 'germany', 'de', '法兰克福', 'frankfurt',
    '法国', 'france', 'fr', '巴黎', 'paris',
    '荷兰', 'netherlands', 'nl', '阿姆斯特丹', 'amsterdam',
    '俄罗斯', 'russia', 'ru', '莫斯科', 'moscow',
    '意大利', 'italy', 'it', '米兰', 'milan', '罗马',
    '西班牙', 'spain', 'es', '马德里', 'madrid', '巴塞罗那',
    '瑞士', 'switzerland', 'ch', '苏黎世', 'zurich',
    '瑞典', 'sweden', 'se', '斯德哥尔摩',
    '波兰', 'poland', 'pl', '华沙',
    '芬兰', 'finland', 'fi', '赫尔辛基',
    '爱尔兰', 'ireland', 'ie', '都柏林',
    '欧洲', 'europe', 'eu',
  ],
  AMERICA: [
    '美国', 'united states', 'usa', 'us', '洛杉矶', 'los angeles', '圣何塞', 'san jose', '西雅图', 'seattle', '纽约', 'new york', '达拉斯', '芝加哥', '迈阿密', '硅谷',
    '加拿大', 'canada', 'ca', '多伦多', 'toronto', '温哥华', 'vancouver', '蒙特利尔',
    '巴西', 'brazil', 'br', '圣保罗',
    '阿根廷', 'argentina', 'ar', '布宜诺斯艾利斯',
    '墨西哥', 'mexico', 'mx',
    '智利', 'chile', 'cl', '圣地亚哥',
    '美洲', '北美', '南美', 'america',
  ],
  OCEANIA: [
    '澳大利亚', '澳洲', 'australia', 'au', '悉尼', 'sydney', '墨尔本', 'melbourne',
    '新西兰', 'new zealand', 'nz', '奥克兰', 'auckland',
    '大洋洲', 'oceania',
  ],
  HK: ['香港', 'hong kong', 'hongkong', 'hk'],
  TW: ['台湾', 'taiwan', 'tw', '台北', 'taipei'],
  JP: ['日本', 'japan', 'jp', '东京', 'tokyo', '大阪', 'osaka'],
  SG: ['新加坡', 'singapore', 'sg', '狮城'],
  US: ['美国', 'united states', 'usa', 'us', '洛杉矶', 'los angeles', '圣何塞', 'san jose', '西雅图', 'seattle', '纽约', 'new york'],
  KR: ['韩国', 'korea', 'kr', '首尔', 'seoul'],
};

const regionModalOpen = ref(false);
const editingRegionCode = ref('');
const editingRegionLabel = ref('');
const editingRegionText = ref('');
const editingRegionEnabled = ref(false);

function getEffectiveRegionKeywords(code) {
  const custom = settings.value.regionKeywords && settings.value.regionKeywords[code];
  if (Array.isArray(custom) && custom.length > 0) {
    return custom;
  }
  return DEFAULT_REGION_KEYWORDS[code] || [];
}

function isCustomRegionKeywords(code) {
  const custom = settings.value.regionKeywords && settings.value.regionKeywords[code];
  return Array.isArray(custom) && custom.length > 0;
}

function openRegionConfig(reg) {
  if (running.value) return;
  editingRegionCode.value = reg.code;
  editingRegionLabel.value = reg.label;
  editingRegionText.value = getEffectiveRegionKeywords(reg.code).join(', ');
  editingRegionEnabled.value = (settings.value.includeRegions || []).includes(reg.code);
  regionModalOpen.value = true;
}

function saveRegionConfig() {
  const code = editingRegionCode.value;
  if (!code) return;
  const parsed = editingRegionText.value
    .split(/[,，\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const nextMap = { ...(settings.value.regionKeywords || {}) };
  if (parsed.length > 0) {
    nextMap[code] = parsed;
  } else {
    delete nextMap[code];
  }
  settings.value.regionKeywords = nextMap;

  const list = Array.isArray(settings.value.includeRegions) ? [...settings.value.includeRegions] : [];
  const idx = list.indexOf(code);
  if (editingRegionEnabled.value && idx < 0) {
    list.push(code);
  } else if (!editingRegionEnabled.value && idx >= 0) {
    list.splice(idx, 1);
  }
  settings.value.includeRegions = list;

  regionModalOpen.value = false;
  saveSettings(true);
  showToast(`已保存「${editingRegionLabel.value}」匹配关键字`, 'success');
}

function resetRegionKeywords() {
  const code = editingRegionCode.value;
  if (!code) return;
  editingRegionText.value = (DEFAULT_REGION_KEYWORDS[code] || []).join(', ');
  const nextMap = { ...(settings.value.regionKeywords || {}) };
  delete nextMap[code];
  settings.value.regionKeywords = nextMap;
  saveSettings(true);
  showToast(`已恢复「${editingRegionLabel.value}」默认关键字`, 'info');
}

const isAllRegions = computed(
  () =>
    (!settings.value.includeRegions || settings.value.includeRegions.length === 0) &&
    !includeKeywordsText.value.trim(),
);

function selectAllRegions() {
  if (running.value) return;
  settings.value.includeRegions = [];
  includeKeywordsText.value = '';
  saveSettings(true);
}

function toggleRegion(code) {
  if (running.value) return;
  const list = Array.isArray(settings.value.includeRegions) ? [...settings.value.includeRegions] : [];
  const idx = list.indexOf(code);
  if (idx >= 0) {
    list.splice(idx, 1);
  } else {
    list.push(code);
  }
  settings.value.includeRegions = list;
  saveSettings(true);
}

const testUrlPresets = [
  {
    value: 'https://speed.cloudflare.com/__down?bytes=25000000',
    label: 'Cloudflare SpeedTest (25MB · 全球边缘)',
  },
  {
    value: 'https://speed.cloudflare.com/__down?bytes=50000000',
    label: 'Cloudflare SpeedTest (50MB · 极速宽带)',
  },
  {
    value: 'https://cachefly.cachefly.net/100mb.test',
    label: 'CacheFly CDN (100MB · 全球 Anycast)',
  },
  {
    value: 'https://fsn1-speed.hetzner.com/100MB.bin',
    label: 'Hetzner FSN1 (100MB · 欧洲节点)',
  },
  {
    value: 'https://proof.ovh.net/files/100Mb.dat',
    label: 'OVH Proof (100MB · 欧美节点)',
  },
  {
    value: '__custom__',
    label: '自定义测速 URL',
  },
];

const selectedTestUrlPreset = computed({
  get() {
    const matched = testUrlPresets.find((p) => p.value !== '__custom__' && p.value === settings.value.testUrl);
    return matched ? matched.value : '__custom__';
  },
  set(val) {
    if (val && val !== '__custom__') {
      settings.value.testUrl = val;
      saveSettings(true);
    }
  },
});

watch([sortBy, limit, showAdvanced, showLogs], () => {
  try {
    localStorage.setItem(
      UI_PREFS_KEY,
      JSON.stringify({
        sortBy: sortBy.value,
        limit: limit.value,
        showAdvanced: showAdvanced.value,
        showLogs: showLogs.value,
      }),
    );
  } catch {
    // ignore storage errors
  }
});

const historyOptions = computed(() => [
  { value: '__latest__', label: '当前最新结果' },
  ...historyList.value.map((h) => ({
    value: h.id,
    label: `${formatDateTime(h.generatedAt)} (${h.okNodes}/${h.totalNodes}可用, 峰值 ${(h.topAvgSpeedMBps || 0).toFixed(2)} MB/s)`,
  })),
]);

function showToast(message, icon = 'mdi:check-circle-outline') {
  toast.value = { message, icon };
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.value = null;
  }, 3500);
}

const stageText = computed(() => {
  const map = {
    idle: '空闲待命',
    preflight: '环境与端口预检',
    subscribe: '拉取并解析订阅',
    'starting-core': '拉起 Mihomo 内核',
    testing: `正在测速 (${completed.value}/${total.value})`,
  };
  return map[stage.value] || stage.value;
});

const progressPercent = computed(() => {
  if (!total.value) return 0;
  return Math.min(100, Math.round((completed.value / total.value) * 100));
});

const okNodesCount = computed(() => results.value.filter((r) => r.status === 'OK').length);

const SORT_BY_TO_FIELD = {
  avg: 'avgSpeedMBps',
  steady: 'steadySpeedMBps',
  value: 'valueScore',
};

watch(sortBy, (val) => {
  if (SORT_BY_TO_FIELD[val]) {
    sortField.value = SORT_BY_TO_FIELD[val];
    sortOrder.value = 'desc';
  }
});

function toggleSort(field) {
  if (sortField.value === field) {
    sortOrder.value = sortOrder.value === 'desc' ? 'asc' : 'desc';
  } else {
    sortField.value = field;
    sortOrder.value = field === 'latencyMs' || field === 'name' ? 'asc' : 'desc';
  }
}

function getSortIcon(field) {
  if (sortField.value !== field) return 'mdi:unfold-more-horizontal';
  return sortOrder.value === 'desc' ? 'mdi:arrow-down' : 'mdi:arrow-up';
}

function formatFailReason(item) {
  const err = String(item.error || '').toLowerCase();
  if (err.includes('abort') || err.includes('timeout')) return '超时(<512KB)';
  if (err.includes('fetch failed') || err.includes('econnreset')) return '连接被拒/断流';
  if (err.includes('不足 512kb')) return '数据不足512KB';
  return item.error || '拉流失败';
}

const PROTOCOL_DOCS = {
  anytls: {
    title: 'AnyTLS（新一代伪装协议）',
    desc: '连接复用效率高、抗干扰能力强，能有效减少频繁握手卡顿，适合日常综合上网与长期稳定使用。',
  },
  vless: {
    title: 'VLESS（轻量现代协议）',
    desc: '去掉了冗余加密开销（常搭配 Reality/TLS），传输速度快、资源占用低，非常适合 4K 视频与大文件下载。',
  },
  hysteria2: {
    title: 'Hysteria2（UDP 暴力加速）',
    desc: '基于 QUIC 协议，在晚高峰丢包、跨国高延迟网络下提速非常明显（注：少数宽带运营商会对 UDP 限速）。',
  },
  hysteria: {
    title: 'Hysteria（UDP 加速协议）',
    desc: '早期高速 UDP 传输协议，适合丢包率较高的跨国线路提速。',
  },
  tuic: {
    title: 'TUIC（低延迟 QUIC 协议）',
    desc: '基于 QUIC 的 0-RTT 握手协议，响应快、延迟低，适合网页秒开与实时交互场景。',
  },
  trojan: {
    title: 'Trojan（HTTPS 伪装协议）',
    desc: '将代理流量直接伪装成普通 HTTPS 网站访问，隐蔽性极强、稳定性高，适合办公与长期挂机。',
  },
  ss: {
    title: 'Shadowsocks（经典轻量协议）',
    desc: '历史最久、设备兼容性最好、最省电的轻量加密协议，适合路由器与各类客户端日常使用。',
  },
  shadowsocks: {
    title: 'Shadowsocks（经典轻量协议）',
    desc: '历史最久、设备兼容性最好、最省电的轻量加密协议，适合路由器与各类客户端日常使用。',
  },
  vmess: {
    title: 'VMess（传统 V2Ray 协议）',
    desc: '通用性强的老牌加密协议，稳定性不错但握手开销略高于 VLESS，适合常规网页与视频。',
  },
  wireguard: {
    title: 'WireGuard（内核级隧道协议）',
    desc: '极简高效的现代 VPN 协议，延迟低、吞吐高，适合游戏联机与大流量传输。',
  },
};

function getProtocolDoc(type) {
  const key = String(type || '').trim().toLowerCase();
  return (
    PROTOCOL_DOCS[key] || {
      title: `${type || '未知'} 协议`,
      desc: '代理节点的传输加密协议类型，用于决定数据如何安全、稳定地穿墙传输；日常直接按测速成绩选择即可。',
    }
  );
}

function formatDateTime(iso) {
  if (!iso) return '--';
  return new Date(iso).toLocaleString('zh-CN', { hour12: false });
}

const sortedAndFilteredResults = computed(() => {
  const field = sortField.value;
  const dir = sortOrder.value === 'asc' ? 1 : -1;
  const q = searchQuery.value.trim().toLowerCase();

  return [...results.value]
    .filter((item) => {
      if (!q) return true;
      return (
        item.name.toLowerCase().includes(q) ||
        String(item.type || '').toLowerCase().includes(q)
      );
    })
    .sort((a, b) => {
      if (field === 'name') {
        return a.name.localeCompare(b.name, 'zh-CN') * dir;
      }
      if (field === 'latencyMs') {
        const latA = a.latencyMs ?? (sortOrder.value === 'asc' ? Infinity : -Infinity);
        const latB = b.latencyMs ?? (sortOrder.value === 'asc' ? Infinity : -Infinity);
        if (latA !== latB) return (latA - latB) * dir;
        return (b.avgSpeedMBps || 0) - (a.avgSpeedMBps || 0);
      }
      const valA = a[field] || 0;
      const valB = b[field] || 0;
      if (valA !== valB) return (valA - valB) * dir;
      return (a.latencyMs ?? Infinity) - (b.latencyMs ?? Infinity);
    });
});

const fastestNode = computed(() => {
  return sortedAndFilteredResults.value.find((r) => r.status === 'OK' && r.avgSpeedMBps > 0) || null;
});

const sceneRecommendations = computed(() => buildSceneRecommendations(results.value));

async function copyNodeName(name) {
  if (!name) return;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(name);
    } else {
      const ta = document.createElement('textarea');
      ta.value = name;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    showToast(`已复制节点名称: ${name}`, 'mdi:content-copy');
  } catch {
    showToast('复制失败，请手动复制', 'mdi:alert-circle-outline');
  }
}

function locateRecommendedNode(nodeName) {
  if (!nodeName) return;
  if (searchQuery.value === nodeName) {
    searchQuery.value = '';
    showToast('已恢复显示全部节点', 'mdi:filter-off-outline');
  } else {
    searchQuery.value = nodeName;
    showToast(`已定位推荐节点: ${nodeName}`, 'mdi:target');
  }
}

async function fetchHistoryList() {
  const res = await fetch('/api/history');
  if (res.ok) {
    const data = await res.json();
    historyList.value = data.history || [];
  }
}

watch(selectedHistoryId, async (id) => {
  if (!id || id === '__latest__') {
    activeHistoryMeta.value = null;
    const res = await fetch('/api/results');
    if (res.ok) {
      const data = await res.json();
      results.value = Array.isArray(data.results) ? data.results : [];
    }
    return;
  }
  const res = await fetch(`/api/history/${encodeURIComponent(id)}`);
  if (res.ok) {
    const data = await res.json();
    results.value = Array.isArray(data.results) ? data.results : [];
    activeHistoryMeta.value = data;
  } else {
    showToast('加载历史记录失败', 'mdi:alert-circle-outline');
  }
});

async function openNodeCompare(nodeName) {
  compareNodeName.value = nodeName;
  compareModalOpen.value = true;
  compareLoading.value = true;
  compareRecords.value = [];
  try {
    const res = await fetch(`/api/history/node?name=${encodeURIComponent(nodeName)}`);
    if (res.ok) {
      const data = await res.json();
      compareRecords.value = data.records || [];
    }
  } finally {
    compareLoading.value = false;
  }
}

function getSpeedDelta(idx) {
  const curr = compareRecords.value[idx];
  const prev = compareRecords.value[idx + 1];
  if (!curr || !prev || curr.status !== 'OK' || prev.status !== 'OK') return null;
  return Number((curr.avgSpeedMBps - prev.avgSpeedMBps).toFixed(2));
}

async function fetchInitialData() {
  const [settingsRes, resultsRes] = await Promise.all([
    fetch('/api/settings'),
    fetch('/api/results'),
    fetchHistoryList(),
  ]);
  if (settingsRes.ok) {
    const data = await settingsRes.json();
    settings.value = data.settings;
    excludeKeywordsText.value = (data.settings.excludeKeywords || []).join(', ');
    includeKeywordsText.value = (data.settings.includeKeywords || []).join(', ');
  }
  if (resultsRes.ok) {
    const data = await resultsRes.json();
    if (Array.isArray(data.results)) {
      results.value = data.results;
    }
    if (!initialPrefs.sortBy && data.sortBy) {
      sortBy.value = data.sortBy;
    }
  }
  if (SORT_BY_TO_FIELD[sortBy.value]) {
    sortField.value = SORT_BY_TO_FIELD[sortBy.value];
  }
}

async function saveSettings(silent = false) {
  saving.value = true;
  try {
    const payload = {
      ...settings.value,
      maxBytesPerNode: Number(settings.value.maxBytesPerNode) || 10485760,
      downloadTimeoutMs: Number(settings.value.downloadTimeoutMs) || 8000,
      latencyTimeoutMs: Number(settings.value.latencyTimeoutMs) || 3000,
      excludeKeywords: excludeKeywordsText.value
        .split(/[,，]/)
        .map((s) => s.trim())
        .filter(Boolean),
      includeRegions: Array.isArray(settings.value.includeRegions) ? settings.value.includeRegions : [],
      includeKeywords: includeKeywordsText.value
        .split(/[,，]/)
        .map((s) => s.trim())
        .filter(Boolean),
      regionKeywords: settings.value.regionKeywords || {},
    };
    const res = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error('保存失败');
    const data = await res.json();
    settings.value = data.settings;
    if (silent !== true) {
      showToast('订阅链接与测速配置已保存');
    }
  } catch (err) {
    showToast(err.message, 'mdi:alert-circle-outline');
  } finally {
    saving.value = false;
  }
}

async function startSpeedtest() {
  if (!settings.value.subscribeUrl.trim()) {
    showToast('请先输入订阅链接', 'mdi:alert-circle-outline');
    return;
  }
  await saveSettings();
  const res = await fetch('/api/speedtest/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      subscribeUrl: settings.value.subscribeUrl,
      sortBy: sortBy.value,
      limit: Number(limit.value) || 0,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    showToast(err.error || '启动测速失败', 'mdi:alert-circle-outline');
    return;
  }
  selectedHistoryId.value = '__latest__';
  activeHistoryMeta.value = null;
  results.value = [];
  logs.value = [];
  showToast('测速任务已启动', 'mdi:rocket-launch-outline');
}

async function stopSpeedtest() {
  await fetch('/api/speedtest/stop', { method: 'POST' });
  showToast('正在中止测速并清理内核...', 'mdi:stop-circle-outline');
}

function scrollLogsToBottom() {
  nextTick(() => {
    if (logBoxRef.value) {
      logBoxRef.value.scrollTop = logBoxRef.value.scrollHeight;
    }
  });
}

function connectSSE() {
  eventSource = new EventSource('/api/speedtest/stream');

  eventSource.addEventListener('init', (e) => {
    const data = JSON.parse(e.data);
    running.value = data.running;
    stage.value = data.stage;
    total.value = data.total;
    completed.value = data.completed;
    if (data.running && Array.isArray(data.results)) {
      results.value = data.results;
    }
    if (Array.isArray(data.logs) && data.logs.length > 0) {
      logs.value = data.logs;
      scrollLogsToBottom();
    }
  });

  eventSource.addEventListener('state', (e) => {
    const data = JSON.parse(e.data);
    running.value = data.running;
    stage.value = data.stage;
    total.value = data.total;
    completed.value = data.completed;
  });

  eventSource.addEventListener('log', (e) => {
    const data = JSON.parse(e.data);
    logs.value.push(data.message);
    if (logs.value.length > 200) logs.value.shift();
    scrollLogsToBottom();
  });

  eventSource.addEventListener('progress', (e) => {
    const data = JSON.parse(e.data);
    completed.value = data.index;
    total.value = data.total;
    results.value.push(data.result);
  });

  eventSource.addEventListener('done', (e) => {
    const data = JSON.parse(e.data);
    selectedHistoryId.value = '__latest__';
    activeHistoryMeta.value = null;
    results.value = data.results;
    running.value = false;
    stage.value = 'idle';
    fetchHistoryList();
    showToast(data.aborted ? '测速已中止并保存部分结果' : '全量测速已完成！');
  });

  eventSource.addEventListener('error', (e) => {
    if (e.data) {
      const data = JSON.parse(e.data);
      showToast(`测速出错: ${data.message}`, 'mdi:alert-circle-outline');
    }
  });
}

onMounted(async () => {
  await fetchInitialData();
  connectSSE();
});

onUnmounted(() => {
  eventSource?.close();
});
</script>

<template>
  <TooltipProvider>
    <div class="mx-auto max-w-7xl px-5 py-7 pb-14 space-y-5">
      <!-- 顶部栏 -->
      <header class="flex flex-wrap items-center justify-between gap-4">
        <div class="flex items-center gap-3.5">
          <div
            class="flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br from-[#0A84FF] to-[#30D158] text-white shadow-[0_6px_20px_rgba(10,132,255,0.35)] ring-1 ring-inset ring-white/25"
          >
            <Icon icon="mdi:speedometer" class="h-6 w-6" />
          </div>
          <div>
            <h1 class="text-xl font-bold tracking-tight text-slate-100">Mihomo Speedtest</h1>
            <p class="text-xs text-slate-400">基于 Mihomo 内核的真实流式下载测速与订阅控制台</p>
          </div>
        </div>

        <Badge :variant="running ? 'info' : 'default'" class="px-3.5 py-1.5 text-xs">
          <Icon
            :icon="running ? 'mdi:loading' : 'mdi:check-circle-outline'"
            :class="['h-4 w-4', running && 'animate-spin']"
          />
          <span>{{ stageText }}</span>
        </Badge>
      </header>

      <!-- 订阅与测速控制卡片 -->
      <Card class="p-5 sm:p-6">
        <div class="mb-4 flex items-center justify-between gap-3">
          <div class="flex items-center gap-2 text-sm font-semibold text-slate-100">
            <Icon icon="mdi:link-variant" class="h-4 w-4 text-[#0A84FF]" />
            <span>订阅源与测速配置</span>
          </div>
          <Button size="sm" @click="showAdvanced = !showAdvanced">
            <Icon :icon="showAdvanced ? 'mdi:chevron-up' : 'mdi:tune'" class="h-4 w-4" />
            <span>{{ showAdvanced ? '收起高级参数' : '高级参数' }}</span>
          </Button>
        </div>

        <div class="flex flex-wrap gap-2.5">
          <div class="min-w-[260px] flex-1">
            <Input
              v-model="settings.subscribeUrl"
              type="url"
              placeholder="输入订阅链接 (https://...) 或本地配置文件路径"
              :disabled="running"
            />
          </div>
          <Button :disabled="saving || running" @click="saveSettings">
            <Icon icon="mdi:content-save-outline" class="h-4 w-4" />
            <span>保存配置</span>
          </Button>
        </div>

        <div class="mt-4 flex flex-wrap items-end gap-3">
          <div class="flex flex-col gap-1.5 w-52">
            <label class="text-xs font-medium text-slate-400">排序维度</label>
            <Select v-model="sortBy" :options="sortOptions" />
          </div>

          <div class="flex flex-col gap-1.5 w-40">
            <label class="text-xs font-medium text-slate-400">测速节点数量</label>
            <Select v-model="limit" :options="limitOptions" :disabled="running" />
          </div>

          <Button v-if="!running" variant="primary" @click="startSpeedtest">
            <Icon icon="mdi:play" class="h-4 w-4" />
            <span>开始测速</span>
          </Button>
          <Button v-else variant="danger" @click="stopSpeedtest">
            <Icon icon="mdi:stop" class="h-4 w-4" />
            <span>停止测速</span>
          </Button>
        </div>

        <!-- 测速地区筛选 -->
        <div class="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-white/10 pt-4">
          <div class="flex flex-wrap items-center gap-2">
            <span class="mr-1 inline-flex items-center gap-1 text-xs font-medium text-slate-400">
              <Icon icon="mdi:earth" class="h-4 w-4 text-[#0A84FF]" />
              <span>测速地区：</span>
              <Tooltip>
                <template #trigger>
                  <button
                    type="button"
                    class="inline-flex items-center text-slate-400 transition-colors hover:text-slate-200 cursor-help"
                    aria-label="地区筛选说明"
                  >
                    <Icon icon="mdi:help-circle-outline" class="h-3.5 w-3.5" />
                  </button>
                </template>
                <div class="max-w-xs space-y-1 text-xs leading-relaxed">
                  <p class="font-semibold text-white">仅通过节点名称关键字筛选</p>
                  <p class="text-slate-300">
                    不会探测真实 IP 归属地，而是按节点名称里是否包含对应地区的关键字（不区分大小写）来过滤。
                  </p>
                  <p class="text-slate-400">
                    点击左侧圆点可启用/取消该地区；点击地区名称可自定义匹配关键字。
                  </p>
                </div>
              </Tooltip>
            </span>
            <button
              type="button"
              :disabled="running"
              :class="[
                'rounded-full px-3 py-1 text-xs font-medium border transition-all cursor-pointer disabled:opacity-50',
                isAllRegions
                  ? 'bg-[#0A84FF]/25 border-[#0A84FF]/60 text-white shadow-[0_0_12px_rgba(10,132,255,0.25)]'
                  : 'bg-white/[0.06] border-white/10 text-slate-300 hover:bg-white/[0.12]',
              ]"
              @click="selectAllRegions"
            >
              全部地区
            </button>
            <div
              v-for="reg in regionPresets"
              :key="reg.code"
              :class="[
                'inline-flex items-center rounded-full border text-xs font-medium transition-all',
                (settings.includeRegions || []).includes(reg.code)
                  ? 'bg-[#0A84FF]/25 border-[#0A84FF]/60 text-white shadow-[0_0_12px_rgba(10,132,255,0.25)]'
                  : 'bg-white/[0.06] border-white/10 text-slate-300 hover:bg-white/[0.12]',
              ]"
            >
              <button
                type="button"
                :disabled="running"
                :title="(settings.includeRegions || []).includes(reg.code) ? '点击取消筛选该地区' : '点击启用筛选该地区'"
                class="flex items-center justify-center pl-2.5 pr-1 py-1 cursor-pointer disabled:opacity-50"
                @click="toggleRegion(reg.code)"
              >
                <Icon
                  :icon="(settings.includeRegions || []).includes(reg.code) ? 'mdi:check-circle' : 'mdi:circle-outline'"
                  class="h-3.5 w-3.5"
                  :class="(settings.includeRegions || []).includes(reg.code) ? 'text-[#0A84FF]' : 'text-slate-400'"
                />
              </button>
              <button
                type="button"
                :disabled="running"
                title="点击配置该地区的匹配关键字"
                class="flex items-center gap-1 pr-2.5 pl-0.5 py-1 cursor-pointer disabled:opacity-50 hover:underline"
                @click="openRegionConfig(reg)"
              >
                <span>{{ reg.label }}</span>
                <span
                  v-if="isCustomRegionKeywords(reg.code)"
                  class="h-1.5 w-1.5 rounded-full bg-amber-400"
                  title="已自定义关键字"
                />
              </button>
            </div>
          </div>
          <div class="w-full sm:w-56">
            <Input
              v-model="includeKeywordsText"
              type="text"
              placeholder="自定义包含词 (如: 家宽, 0.3x)"
              class="h-8 text-xs"
              :disabled="running"
              @blur="saveSettings(true)"
            />
          </div>
        </div>

        <CollapsibleRoot v-model:open="showAdvanced">
          <CollapsibleContent
            class="mt-5 grid grid-cols-1 gap-3.5 border-t border-white/10 pt-5 sm:grid-cols-2 lg:grid-cols-3"
          >
            <div class="flex flex-col gap-1.5 sm:col-span-2 lg:col-span-3">
              <label class="text-xs font-medium text-slate-400">测速下载文件 URL（支持预设切换或自定义）</label>
              <div class="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                <Select
                  v-model="selectedTestUrlPreset"
                  :options="testUrlPresets"
                  :disabled="running"
                />
                <Input
                  v-model="settings.testUrl"
                  type="url"
                  placeholder="https://..."
                  :disabled="running"
                  @blur="saveSettings(true)"
                />
              </div>
            </div>
            <div class="flex flex-col gap-1.5">
              <label class="text-xs font-medium text-slate-400">单节点流量熔断上限 (Bytes)</label>
              <Input
                v-model.number="settings.maxBytesPerNode"
                type="number"
                :disabled="running"
                @blur="saveSettings(true)"
              />
            </div>
            <div class="flex flex-col gap-1.5">
              <label class="text-xs font-medium text-slate-400">下载超时时间 (ms)</label>
              <Input
                v-model.number="settings.downloadTimeoutMs"
                type="number"
                :disabled="running"
                @blur="saveSettings(true)"
              />
            </div>
            <div class="flex flex-col gap-1.5">
              <label class="text-xs font-medium text-slate-400">延迟预筛超时 (ms)</label>
              <Input
                v-model.number="settings.latencyTimeoutMs"
                type="number"
                :disabled="running"
                @blur="saveSettings(true)"
              />
            </div>
            <div class="flex flex-col gap-1.5 sm:col-span-2">
              <label class="text-xs font-medium text-slate-400">排除关键词 (逗号分隔)</label>
              <Input
                v-model="excludeKeywordsText"
                type="text"
                :disabled="running"
                @blur="saveSettings(true)"
              />
            </div>
            <div class="flex flex-col gap-1.5">
              <label class="text-xs font-medium text-slate-400">Clash Verge API 地址</label>
              <Input v-model="settings.clashVergeApi" type="text" @blur="saveSettings(true)" />
            </div>
          </CollapsibleContent>
        </CollapsibleRoot>
      </Card>

      <!-- 三联统计卡 -->
      <div class="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card class="p-4 sm:p-5">
          <div class="flex items-center gap-1.5 text-xs font-medium text-slate-400">
            <Icon icon="mdi:progress-clock" class="h-4 w-4 text-[#0A84FF]" />
            <span>测速进度</span>
          </div>
          <div class="mt-2 font-mono text-2xl font-bold tabular-nums text-slate-100">
            {{ completed }} / {{ total || results.length }}
          </div>
          <Progress :model-value="progressPercent" class="mt-3" />
        </Card>

        <Card class="p-4 sm:p-5">
          <div class="flex items-center gap-1.5 text-xs font-medium text-slate-400">
            <Icon icon="mdi:server-network" class="h-4 w-4 text-[#30D158]" />
            <span>有效可用节点</span>
          </div>
          <div class="mt-2 font-mono text-2xl font-bold tabular-nums text-slate-100">
            {{ okNodesCount }}
          </div>
          <div class="mt-1 text-xs text-slate-500">共 {{ results.length }} 条记录</div>
        </Card>

        <Card class="p-4 sm:p-5">
          <div class="flex items-center gap-1.5 text-xs font-medium text-slate-400">
            <Icon icon="mdi:trophy-outline" class="h-4 w-4 text-[#FF9F0A]" />
            <span>当前最优节点</span>
          </div>
          <div class="mt-2 font-mono text-2xl font-bold tabular-nums text-[#30D158]">
            {{ fastestNode ? `${fastestNode.avgSpeedMBps.toFixed(2)} MB/s` : '--' }}
          </div>
          <div class="mt-1 truncate text-xs text-slate-400" :title="fastestNode?.name">
            {{
              fastestNode
                ? `${fastestNode.name} (稳态 ${fastestNode.steadySpeedMBps.toFixed(2)} MB/s)`
                : '暂无测速数据'
            }}
          </div>
        </Card>
      </div>

      <!-- 智能场景推荐 -->
      <Card v-if="results.length > 0" class="p-5 sm:p-6">
        <div class="mb-4 flex flex-wrap items-center justify-between gap-2">
          <div class="flex items-center gap-2 text-sm font-semibold text-slate-100">
            <Icon icon="mdi:auto-fix" class="h-4 w-4 text-[#0A84FF]" />
            <span>智能场景推荐</span>
          </div>
          <span class="text-xs text-slate-400">基于真实可用节点的延迟、稳态带宽与倍率综合匹配（点击卡片定位节点）</span>
        </div>

        <div class="grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-4">
          <div
            v-for="scene in sceneRecommendations"
            :key="scene.id"
            :class="[
              'group rounded-xl border p-4 transition-all duration-150 backdrop-blur-xl',
              scene.node
                ? 'cursor-pointer border-white/10 bg-white/[0.06] hover:border-[#0A84FF]/50 hover:bg-white/[0.1]'
                : 'border-white/5 bg-white/[0.03] opacity-60',
              scene.node && searchQuery === scene.node.name && 'border-[#0A84FF] bg-[#0A84FF]/15',
            ]"
            @click="locateRecommendedNode(scene.node?.name)"
          >
            <div class="flex items-center justify-between gap-2">
              <div class="flex items-center gap-1.5 text-xs font-medium text-slate-300">
                <Icon :icon="scene.icon" :class="['h-4 w-4', scene.accentClass]" />
                <span>{{ scene.title }}</span>
              </div>
              <Badge v-if="scene.badge" :variant="scene.badge.variant">{{ scene.badge.text }}</Badge>
            </div>

            <div
              class="mt-2.5 truncate text-sm font-semibold text-slate-100"
              :title="scene.node?.name"
            >
              {{ scene.node ? scene.node.name : '暂无推荐' }}
            </div>

            <div class="mt-2 flex items-center justify-between gap-2">
              <span class="font-mono text-xs font-semibold tabular-nums text-[#30D158]">
                {{ scene.metricText }}
              </span>
              <span class="font-mono text-[11px] tabular-nums text-slate-400">
                {{ scene.subText }}
              </span>
            </div>
          </div>
        </div>
      </Card>

      <!-- 实时日志 -->
      <Card v-if="logs.length > 0" class="p-5">
        <div class="mb-3 flex items-center justify-between">
          <div class="flex items-center gap-2 text-sm font-semibold text-slate-100">
            <Icon icon="mdi:console" class="h-4 w-4 text-slate-400" />
            <span>运行日志</span>
          </div>
          <Button size="sm" @click="showLogs = !showLogs">
            {{ showLogs ? '折叠' : '展开' }}
          </Button>
        </div>
        <div
          v-show="showLogs"
          ref="logBoxRef"
          class="max-h-44 overflow-y-auto rounded-xl border border-white/10 bg-black/35 p-3 font-mono text-xs leading-relaxed text-slate-400"
        >
          <div v-for="(line, i) in logs" :key="i">{{ line }}</div>
        </div>
      </Card>

      <!-- 节点测速排行榜 -->
      <Card class="p-5 sm:p-6">
        <div class="mb-4 flex flex-wrap items-center justify-between gap-4">
          <div class="flex items-center gap-2 text-sm font-semibold text-slate-100">
            <Icon icon="mdi:format-list-numbered" class="h-4 w-4 text-[#0A84FF]" />
            <span>节点测速排行榜</span>
          </div>

          <div class="flex flex-wrap items-center justify-end gap-2.5">
            <Select
              v-model="selectedHistoryId"
              :options="historyOptions"
              :disabled="running"
              class="w-72"
            />
            <Input
              v-model="searchQuery"
              type="text"
              placeholder="搜索节点名称或协议..."
              class="w-56"
            />
          </div>
        </div>

        <div
          v-if="activeHistoryMeta"
          class="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#0A84FF]/30 bg-[#0A84FF]/10 px-4 py-2.5 text-xs text-sky-200 backdrop-blur-xl"
        >
          <span>
            正在查看历史留痕：<strong>{{ formatDateTime(activeHistoryMeta.generatedAt) }}</strong>
            （共 {{ activeHistoryMeta.totalNodes }} 节点，{{ activeHistoryMeta.okNodes }} 可用）
          </span>
          <Button size="sm" @click="selectedHistoryId = '__latest__'">切回最新结果</Button>
        </div>

        <div class="overflow-x-auto">
          <table class="w-full border-collapse text-left text-xs sm:text-sm">
            <thead>
              <tr class="border-b border-white/10 text-slate-400 select-none">
                <th class="px-3 py-3 font-semibold whitespace-nowrap">排名</th>
                <th
                  class="px-3 py-3 font-semibold whitespace-nowrap cursor-pointer hover:text-slate-100 transition-colors"
                  :class="sortField === 'name' && 'text-[#64D2FF]'"
                  @click="toggleSort('name')"
                >
                  <span class="inline-flex items-center gap-1">
                    <span>节点名称</span>
                    <Icon :icon="getSortIcon('name')" class="h-4 w-4" />
                  </span>
                </th>
                <th class="px-3 py-3 font-semibold whitespace-nowrap">
                  <span class="inline-flex items-center gap-1.5">
                    <span>协议</span>
                    <Tooltip>
                      <template #trigger>
                        <Icon icon="mdi:help-circle-outline" class="h-4 w-4" />
                      </template>
                      <div class="font-semibold text-slate-100">什么是节点协议类型？</div>
                      <p class="mt-1 text-slate-300">
                        协议决定了你的网络数据如何加密与传输（就像快递用普通货车还是冷链专车）。
                      </p>
                      <ul class="mt-2 space-y-1 border-t border-white/15 pt-2 text-slate-300">
                        <li>• <strong>VLESS / AnyTLS / Trojan</strong>：现代主流伪装协议，稳且快</li>
                        <li>• <strong>Hysteria2 / TUIC</strong>：基于 UDP，适合晚高峰丢包提速</li>
                        <li>• <strong>SS / VMess</strong>：老牌通用协议，设备兼容性最好</li>
                      </ul>
                      <p class="mt-2 text-[11px] text-[#64D2FF]">
                        💡 小白提示：鼠标悬停下方每一行的协议标签可看详细说明，日常直接按实测速度选即可。
                      </p>
                    </Tooltip>
                  </span>
                </th>
                <th
                  class="px-3 py-3 font-semibold whitespace-nowrap cursor-pointer hover:text-slate-100 transition-colors"
                  :class="sortField === 'multiplier' && 'text-[#64D2FF]'"
                  @click="toggleSort('multiplier')"
                >
                  <span class="inline-flex items-center gap-1">
                    <span>倍率</span>
                    <Icon :icon="getSortIcon('multiplier')" class="h-4 w-4" />
                  </span>
                </th>
                <th
                  class="px-3 py-3 font-semibold whitespace-nowrap cursor-pointer hover:text-slate-100 transition-colors"
                  :class="sortField === 'latencyMs' && 'text-[#64D2FF]'"
                  @click="toggleSort('latencyMs')"
                >
                  <span class="inline-flex items-center gap-1">
                    <span>延迟</span>
                    <Icon :icon="getSortIcon('latencyMs')" class="h-4 w-4" />
                  </span>
                </th>
                <th
                  class="px-3 py-3 font-semibold whitespace-nowrap cursor-pointer hover:text-slate-100 transition-colors"
                  :class="sortField === 'avgSpeedMBps' && 'text-[#64D2FF]'"
                  @click="toggleSort('avgSpeedMBps')"
                >
                  <span class="inline-flex items-center gap-1.5">
                    <span>平均下载</span>
                    <Tooltip>
                      <template #trigger>
                        <Icon icon="mdi:help-circle-outline" class="h-4 w-4" />
                      </template>
                      <div class="font-semibold text-slate-100">全程平均下载速率</div>
                      <p class="mt-1 text-slate-300">
                        公式：总下载字节 ÷ 总耗时（1 MB/s = 8 Mbps）。单节点达 10MB 或 8 秒即熔断；若中断且不足 512KB 则记为下载失败。
                      </p>
                      <div class="mt-2 border-t border-white/15 pt-2 font-semibold text-[#64D2FF]">
                        使用场景推荐
                      </div>
                      <ul class="mt-1 space-y-0.5 text-slate-300">
                        <li>• ≥ 5 MB/s：大文件下载、云盘同步</li>
                        <li>• 1.5 ~ 5 MB/s：代码拉取、常规文件下载</li>
                        <li>• &lt; 1 MB/s：仅适合日常网页浏览与聊天</li>
                      </ul>
                    </Tooltip>
                    <Icon :icon="getSortIcon('avgSpeedMBps')" class="h-4 w-4" />
                  </span>
                </th>
                <th
                  class="px-3 py-3 font-semibold whitespace-nowrap cursor-pointer hover:text-slate-100 transition-colors"
                  :class="sortField === 'steadySpeedMBps' && 'text-[#64D2FF]'"
                  @click="toggleSort('steadySpeedMBps')"
                >
                  <span class="inline-flex items-center gap-1.5">
                    <span>稳态下载</span>
                    <Tooltip>
                      <template #trigger>
                        <Icon icon="mdi:help-circle-outline" class="h-4 w-4" />
                      </template>
                      <div class="font-semibold text-slate-100">稳态下载速率（关键指标）</div>
                      <p class="mt-1 text-slate-300">
                        跳过前 1.5 秒 TCP/TLS 慢启动阶段后的持续下载速度（总耗时不足 2 秒时等同于平均下载）。
                      </p>
                      <div class="mt-2 border-t border-white/15 pt-2 font-semibold text-[#64D2FF]">
                        使用场景推荐
                      </div>
                      <ul class="mt-1 space-y-0.5 text-slate-300">
                        <li>• ≥ 6 MB/s：流畅播放 4K/8K 高码率视频</li>
                        <li>• 2.5 ~ 6 MB/s：稳定观看 1080P60 / 2K 视频</li>
                        <li>• &lt; 1.5 MB/s：建议切换 720P 或仅用于图文浏览</li>
                      </ul>
                    </Tooltip>
                    <Icon :icon="getSortIcon('steadySpeedMBps')" class="h-4 w-4" />
                  </span>
                </th>
                <th
                  class="px-3 py-3 font-semibold whitespace-nowrap cursor-pointer hover:text-slate-100 transition-colors"
                  :class="sortField === 'valueScore' && 'text-[#64D2FF]'"
                  @click="toggleSort('valueScore')"
                >
                  <span class="inline-flex items-center gap-1">
                    <span>性价比</span>
                    <Icon :icon="getSortIcon('valueScore')" class="h-4 w-4" />
                  </span>
                </th>
                <th class="px-3 py-3 font-semibold whitespace-nowrap">操作</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-white/[0.06]">
              <tr v-if="sortedAndFilteredResults.length === 0">
                <td colspan="9" class="py-10 text-center text-slate-500">
                  暂无测速数据，点击上方「开始测速」即可开始测试
                </td>
              </tr>
              <tr
                v-for="(item, idx) in sortedAndFilteredResults"
                :key="item.name + idx"
                class="transition-colors hover:bg-white/[0.04]"
              >
                <td class="px-3 py-3 font-mono tabular-nums text-slate-400">{{ idx + 1 }}</td>
                <td class="px-3 py-3 font-medium text-slate-100">
                  <button
                    type="button"
                    class="group inline-flex items-center gap-1.5 text-left hover:text-[#64D2FF] transition-colors cursor-pointer"
                    title="点击复制节点名称"
                    @click="copyNodeName(item.name)"
                  >
                    <span>{{ item.name }}</span>
                    <Icon
                      icon="mdi:content-copy"
                      class="h-3.5 w-3.5 shrink-0 text-slate-500 opacity-0 group-hover:opacity-100 transition-opacity"
                    />
                  </button>
                </td>
                <td class="px-3 py-3">
                  <Tooltip>
                    <template #trigger>
                      <Badge class="cursor-help hover:border-white/30 transition-colors">{{ item.type }}</Badge>
                    </template>
                    <div class="font-semibold text-slate-100">{{ getProtocolDoc(item.type).title }}</div>
                    <p class="mt-1 text-slate-300">{{ getProtocolDoc(item.type).desc }}</p>
                  </Tooltip>
                </td>
                <td class="px-3 py-3 font-mono tabular-nums text-slate-300">{{ item.multiplier }}x</td>
                <td class="px-3 py-3 font-mono tabular-nums">
                  <Badge v-if="item.latencyMs !== null" variant="success">{{ item.latencyMs }} ms</Badge>
                  <Badge v-else variant="danger">延迟超时</Badge>
                </td>
                <td class="px-3 py-3 font-mono tabular-nums">
                  <span
                    v-if="item.status === 'OK'"
                    :class="item.avgSpeedMBps > 0 ? 'font-bold text-[#30D158]' : 'text-slate-300'"
                  >
                    {{ item.avgSpeedMBps.toFixed(2) }} MB/s
                  </span>
                  <Tooltip v-else-if="item.latencyMs !== null">
                    <template #trigger>
                      <Badge variant="danger" class="cursor-help inline-flex items-center gap-1 whitespace-nowrap">
                        <span>下载失败</span>
                        <Icon icon="mdi:information-outline" class="h-3.5 w-3.5 opacity-80" />
                      </Badge>
                    </template>
                    <div class="max-w-xs space-y-1 text-xs leading-relaxed">
                      <div class="font-semibold text-rose-300">{{ formatFailReason(item) }}</div>
                      <div
                        v-if="item.error && item.error !== formatFailReason(item)"
                        class="break-all font-mono text-[11px] text-slate-300"
                      >
                        {{ item.error }}
                      </div>
                    </div>
                  </Tooltip>
                  <span v-else class="text-xs text-slate-500">未测（延迟超时）</span>
                </td>
                <td class="px-3 py-3 font-mono tabular-nums text-slate-300">
                  <template v-if="item.status === 'OK'">
                    {{ item.steadySpeedMBps.toFixed(2) }} MB/s
                  </template>
                  <span v-else class="text-slate-600">--</span>
                </td>
                <td class="px-3 py-3 font-mono tabular-nums text-slate-300">
                  <template v-if="item.status === 'OK'">
                    {{ item.valueScore.toFixed(2) }}
                  </template>
                  <span v-else class="text-slate-600">--</span>
                </td>
                <td class="px-3 py-3">
                  <Button size="sm" @click="openNodeCompare(item.name)">
                    <Icon icon="mdi:history" class="h-3.5 w-3.5" />
                    <span>历史对比</span>
                  </Button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </Card>

      <!-- 节点历史对比弹窗 -->
      <Dialog v-model:open="compareModalOpen" :title="`节点历史测速对比 — ${compareNodeName}`">
        <template #icon>
          <Icon icon="mdi:history" class="h-5 w-5 text-[#0A84FF]" />
        </template>

        <div v-if="compareLoading" class="py-8 text-center text-sm text-slate-400">
          正在加载历次测速记录...
        </div>
        <div v-else-if="compareRecords.length === 0" class="py-8 text-center text-sm text-slate-500">
          暂无该节点的历史留痕记录（新测速完成后会自动保存留痕）
        </div>
        <div v-else class="overflow-x-auto">
          <table class="w-full border-collapse text-left text-xs sm:text-sm">
            <thead>
              <tr class="border-b border-white/10 text-slate-400">
                <th class="px-3 py-2.5 font-semibold">测速时间</th>
                <th class="px-3 py-2.5 font-semibold">状态 / 延迟</th>
                <th class="px-3 py-2.5 font-semibold">平均下载</th>
                <th class="px-3 py-2.5 font-semibold">稳态下载</th>
                <th class="px-3 py-2.5 font-semibold">性价比</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-white/[0.06]">
              <tr v-for="(rec, idx) in compareRecords" :key="rec.id">
                <td class="px-3 py-2.5 font-mono tabular-nums text-slate-300">
                  {{ formatDateTime(rec.generatedAt) }}
                </td>
                <td class="px-3 py-2.5 font-mono tabular-nums">
                  <Badge v-if="rec.status === 'OK'" variant="success">{{ rec.latencyMs }} ms</Badge>
                  <Badge v-else variant="danger">
                    {{ rec.latencyMs !== null ? '下载失败' : '延迟超时' }}
                  </Badge>
                </td>
                <td class="px-3 py-2.5 font-mono tabular-nums">
                  <template v-if="rec.status === 'OK'">
                    <span :class="rec.avgSpeedMBps > 0 ? 'font-semibold text-[#30D158]' : 'text-slate-300'">
                      {{ rec.avgSpeedMBps.toFixed(2) }} MB/s
                    </span>
                    <span
                      v-if="getSpeedDelta(idx) !== null && getSpeedDelta(idx) !== 0"
                      :class="[
                        'ml-1.5 text-[11px]',
                        getSpeedDelta(idx) > 0 ? 'text-[#30D158]' : 'text-[#FF453A]',
                      ]"
                    >
                      {{ getSpeedDelta(idx) > 0 ? `+${getSpeedDelta(idx)}` : getSpeedDelta(idx) }}
                    </span>
                  </template>
                  <span v-else class="text-slate-600">--</span>
                </td>
                <td class="px-3 py-2.5 font-mono tabular-nums text-slate-300">
                  {{ rec.status === 'OK' ? `${rec.steadySpeedMBps.toFixed(2)} MB/s` : '--' }}
                </td>
                <td class="px-3 py-2.5 font-mono tabular-nums text-slate-300">
                  {{ rec.status === 'OK' ? rec.valueScore.toFixed(2) : '--' }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </Dialog>

      <!-- 地区关键字配置弹窗 -->
      <Dialog v-model:open="regionModalOpen" :title="`配置「${editingRegionLabel}」匹配关键字`">
        <template #icon>
          <Icon icon="mdi:tag-multiple-outline" class="h-5 w-5 text-[#0A84FF]" />
        </template>
        <div class="space-y-4">
          <div class="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-xs leading-relaxed text-slate-300">
            地区筛选<span class="font-semibold text-white">仅通过节点名称关键字匹配</span>（不区分大小写；2-3 个纯字母代码如
            <code class="rounded bg-white/10 px-1 py-0.5 text-[11px]">hk</code>/<code class="rounded bg-white/10 px-1 py-0.5 text-[11px]">us</code>
            按单词边界匹配，避免误伤）。多个关键字请用英文或中文逗号、换行分隔。
          </div>
          <div>
            <label class="mb-1.5 block text-xs font-medium text-slate-300">匹配关键字列表</label>
            <textarea
              v-model="editingRegionText"
              rows="5"
              placeholder="例如: 香港, hong kong, hk, 港"
              class="w-full rounded-xl border border-white/15 bg-black/30 px-3 py-2 text-xs text-slate-100 placeholder-slate-500 focus:border-[#0A84FF] focus:outline-none focus:ring-1 focus:ring-[#0A84FF]"
            />
          </div>
          <label class="flex items-center gap-2 text-xs text-slate-200 cursor-pointer select-none">
            <input
              v-model="editingRegionEnabled"
              type="checkbox"
              class="h-4 w-4 rounded border-white/20 bg-black/40 text-[#0A84FF] focus:ring-[#0A84FF]"
            />
            <span>同时勾选启用「{{ editingRegionLabel }}」地区筛选</span>
          </label>
          <div class="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-white/10">
            <Button variant="ghost" size="sm" @click="resetRegionKeywords">
              <Icon icon="mdi:restore" class="h-4 w-4" />
              恢复默认
            </Button>
            <div class="flex items-center gap-2">
              <Button variant="ghost" size="sm" @click="regionModalOpen = false">取消</Button>
              <Button variant="primary" size="sm" @click="saveRegionConfig">
                <Icon icon="mdi:content-save-outline" class="h-4 w-4" />
                保存配置
              </Button>
            </div>
          </div>
        </div>
      </Dialog>

      <!-- Toast 提示 -->
      <div
        v-if="toast"
        class="fixed bottom-6 right-6 z-50 flex items-center gap-2 rounded-xl border border-white/20 bg-slate-900/85 px-4 py-3 text-xs font-medium text-slate-100 shadow-2xl backdrop-blur-2xl"
      >
        <Icon :icon="toast.icon" class="h-4 w-4 text-[#0A84FF]" />
        <span>{{ toast.message }}</span>
      </div>
    </div>
  </TooltipProvider>
</template>
