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
import { formatBytes, formatDuration, formatTimerClock, VPN_TOOLS } from './lib/vpn.js';
import { renderSpeedtestLongImage } from './lib/exportImage.js';

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
  enableUnlockCheck: false,
  concurrency: 2,
  maxBandwidthMBps: 0,
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
const startedAtMs = ref(0);
const elapsedMs = ref(0);
const totalBytes = ref(0);
const nowTick = ref(Date.now());
const results = ref([]);
const logs = ref([]);
const logBoxRef = ref(null);

const vpnCheckLoading = ref(false);
const vpnCheckResult = ref(null);
const vpnWarningModalOpen = ref(false);
const pendingStartAfterWarn = ref(false);
const vpnShuttingDown = ref(false);
const vpnShutdownError = ref('');
const closedVpnsBeforeTest = ref([]);
const vpnRestoreModalOpen = ref(false);
const vpnLaunching = ref(false);

const applyModalOpen = ref(false);
const applyTargetNode = ref(null);
const selectedVpnToolId = ref(initialPrefs.vpnToolId || 'clash-verge');
const vpnApiUrl = ref('');
const vpnSecret = ref('');
const vpnSelector = ref('');
const vpnProbing = ref(false);
const vpnProbeResult = ref(null);
const vpnApplying = ref(false);

const previewModalOpen = ref(false);
const previewLoading = ref(false);
const previewNodes = ref([]);
const previewSelected = ref([]);
const previewSearch = ref('');

const exportModalOpen = ref(false);
const exportLoading = ref(false);
const exportTopN = ref('10');
const exportYaml = ref('');
const exportFilename = ref('mihomo-top10.yaml');
const exportCount = ref(0);
const exportError = ref('');

const retestingNode = ref('');

const liveBandwidthMBps = ref(0);
const peakBandwidthMBps = ref(0);
const bandwidthNotice = ref(null);
const dismissedSuggestUpModal = ref(false);
const scalingConcurrency = ref(false);

const bwTestModalOpen = ref(false);
const bwTestMode = ref('domestic');
const bwTestCustomUrl = ref('');
const bwTestRunning = ref(false);
const bwTestResult = ref(null);
const bwTestError = ref('');

function openBandwidthTestModal() {
  bwTestError.value = '';
  bwTestResult.value = null;
  bwTestModalOpen.value = true;
}

async function runLocalBandwidthTest() {
  bwTestRunning.value = true;
  bwTestError.value = '';
  bwTestResult.value = null;
  try {
    const res = await fetch('/api/bandwidth/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: bwTestMode.value, customUrl: bwTestCustomUrl.value.trim() }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '宽带上限测试失败');
    bwTestResult.value = data;
  } catch (err) {
    bwTestError.value = err.message;
  } finally {
    bwTestRunning.value = false;
  }
}

function applyTestedBandwidth(val) {
  settings.value.maxBandwidthMBps = Number(val) || 0;
  saveSettings(true);
  bwTestModalOpen.value = false;
  showToast(`已将宽带上限设为 ${settings.value.maxBandwidthMBps} MB/s`, 'mdi:speedometer');
}

async function applyRecommendedThreads(threads) {
  if (!(Number(settings.value.maxBandwidthMBps) > 0) && Number(threads) > 1) {
    showToast('请先设置宽带上限（或点击「测上限」自动获取）后再开启多线程', 'mdi:alert-circle-outline');
    return;
  }
  const next = Math.min(16, Math.max(1, Number(threads) || 2));
  if (running.value) {
    scalingConcurrency.value = true;
    try {
      const res = await fetch('/api/speedtest/concurrency', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ concurrency: next }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '调整线程失败');
      settings.value.concurrency = data.concurrency || next;
      bandwidthNotice.value = null;
      showToast(
        data.appliedNow
          ? `已实时热调整至 ${settings.value.concurrency} 线程（立即应用于剩余节点）`
          : `已将并发线程设为 ${settings.value.concurrency}`,
        'mdi:rocket-launch-outline',
      );
    } catch (err) {
      showToast(err.message, 'mdi:alert-circle-outline');
    } finally {
      scalingConcurrency.value = false;
    }
    return;
  }

  settings.value.concurrency = next;
  saveSettings(true);
  bandwidthNotice.value = null;
  showToast(`已将并发线程调整为 ${next} 线程`, 'mdi:check-circle-outline');
}

const concurrencyOptions = [
  { value: '1', label: '1 线程 (串行精确)' },
  { value: '2', label: '2 线程 (推荐均衡)' },
  { value: '3', label: '3 线程 (较快)' },
  { value: '4', label: '4 线程 (高速)' },
  { value: '6', label: '6 线程 (极速)' },
  { value: '8', label: '8 线程 (高并发)' },
  { value: '10', label: '10 线程 (超高速)' },
  { value: '12', label: '12 线程 (千兆推荐)' },
  { value: '16', label: '16 线程 (最大)' },
];

const hasBandwidthCap = computed(() => Number(settings.value.maxBandwidthMBps) > 0);

const maxNodeMB = computed({
  get: () => {
    const bytes = Number(settings.value.maxBytesPerNode) || 10485760;
    return Math.round((bytes / (1024 * 1024)) * 100) / 100;
  },
  set: (val) => {
    const mb = Number(val);
    if (!Number.isFinite(mb) || mb <= 0) return;
    settings.value.maxBytesPerNode = Math.round(Math.max(1, mb) * 1024 * 1024);
  },
});

const selectedConcurrency = computed({
  get: () => {
    if (!hasBandwidthCap.value) return '1';
    return String(Math.min(16, Math.max(1, Number(settings.value.concurrency) || 2)));
  },
  set: (val) => {
    const next = Math.min(16, Math.max(1, Number(val) || 2));
    if (!hasBandwidthCap.value && next > 1) {
      showToast('未设置宽带上限时不允许开启多线程，请先设置宽带上限或点击「测上限」', 'mdi:alert-circle-outline');
      settings.value.concurrency = 1;
      return;
    }
    settings.value.concurrency = next;
    saveSettings(true);
  },
});

const preflightBandwidthAdvice = computed(() => {
  const c = Number(settings.value.concurrency) || 1;
  const cap = Number(settings.value.maxBandwidthMBps) || 0;
  if (c <= 1 || cap <= 0) return null;
  return `当前开启 ${c} 线程（不限制单节点极速）：若测速期间总速率触及 ${cap} MB/s 上限，系统将自动减少并发线程并将受影响的高速节点放回队列重测，确保测速结果真实无低估。`;
});

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
    '印度尼西亚', '印尼', 'indonesia', '雅加达',
    '印度', 'india', '孟买', '新德里',
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
    '意大利', 'italy', '米兰', 'milan', '罗马',
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
  HK: ['香港', 'hong kong', 'hongkong', 'hkg', '🇭🇰', 'hk'],
  TW: ['台湾', '台灣', '台北', 'taiwan', 'taipei', 'tpe', '🇹🇼', 'tw'],
  JP: ['日本', '东京', '大阪', 'japan', 'tokyo', 'osaka', 'nrt', 'kix', '🇯🇵', 'jp'],
  SG: ['新加坡', '狮城', 'singapore', '🇸🇬', 'sg'],
  US: ['美国', 'united states', 'america', '洛杉矶', '圣何塞', '西雅图', '纽约', 'los angeles', 'san jose', 'seattle', 'new york', '🇺🇸', 'us', 'usa'],
  KR: ['韩国', '韓國', '首尔', 'korea', 'seoul', 'icn', '🇰🇷', 'kr'],
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
    value: 'https://dl.google.com/chrome/install/latest/chrome_installer.exe',
    label: 'Google CDN (Chrome 直链 · YouTube 同源)',
  },
  {
    value: 'https://update.code.visualstudio.com/latest/win32-x64-user/stable',
    label: 'Microsoft Azure CDN (VSCode · 全球高带宽)',
  },
  {
    value: 'https://telegram.org/dl/desktop/win64',
    label: 'Telegram 官方 CDN (纸飞机桌面端直链)',
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
    value: 'https://ash-speed.hetzner.com/100MB.bin',
    label: 'Hetzner ASH (100MB · 美东节点)',
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

watch([sortBy, limit, showAdvanced, showLogs, selectedVpnToolId], () => {
  try {
    localStorage.setItem(
      UI_PREFS_KEY,
      JSON.stringify({
        sortBy: sortBy.value,
        limit: limit.value,
        showAdvanced: showAdvanced.value,
        showLogs: showLogs.value,
        vpnToolId: selectedVpnToolId.value,
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

const displayTotalBytes = computed(() => {
  if (activeHistoryMeta.value) {
    if (typeof activeHistoryMeta.value.totalBytes === 'number' && activeHistoryMeta.value.totalBytes > 0) {
      return activeHistoryMeta.value.totalBytes;
    }
    return results.value.reduce((acc, r) => acc + (Number(r.totalBytes) || 0), 0);
  }
  if (totalBytes.value > 0) return totalBytes.value;
  return results.value.reduce((acc, r) => acc + (Number(r.totalBytes) || 0), 0);
});

const displayElapsedMs = computed(() => {
  if (activeHistoryMeta.value) {
    return Number(activeHistoryMeta.value.elapsedMs) || 0;
  }
  if (running.value && startedAtMs.value > 0) {
    return Math.max(0, nowTick.value - startedAtMs.value);
  }
  return Number(elapsedMs.value) || 0;
});

const activeVpnTool = computed(
  () => VPN_TOOLS.find((t) => t.id === selectedVpnToolId.value) || VPN_TOOLS[0],
);

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
    if (typeof data.totalBytes === 'number') totalBytes.value = data.totalBytes;
    if (typeof data.elapsedMs === 'number') elapsedMs.value = data.elapsedMs;
    if (typeof data.startedAtMs === 'number') startedAtMs.value = data.startedAtMs;
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
      concurrency: hasBandwidthCap.value ? Math.min(16, Math.max(1, Number(settings.value.concurrency) || 2)) : 1,
      maxBandwidthMBps: Math.max(0, Number(settings.value.maxBandwidthMBps) || 0),
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

async function checkVpnEnvironment() {
  vpnCheckLoading.value = true;
  try {
    const res = await fetch('/api/preflight/vpn-check');
    if (res.ok) {
      vpnCheckResult.value = await res.json();
    }
  } catch {
    // ignore
  } finally {
    vpnCheckLoading.value = false;
  }
}

async function executeStartSpeedtest(selectedNodes = []) {
  await saveSettings(true);
  const res = await fetch('/api/speedtest/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      subscribeUrl: settings.value.subscribeUrl,
      sortBy: sortBy.value,
      limit: Number(limit.value) || 0,
      selectedNodes,
      enableUnlockCheck: Boolean(settings.value.enableUnlockCheck),
      concurrency: hasBandwidthCap.value ? Math.min(16, Math.max(1, Number(settings.value.concurrency) || 2)) : 1,
      maxBandwidthMBps: Math.max(0, Number(settings.value.maxBandwidthMBps) || 0),
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
  totalBytes.value = 0;
  elapsedMs.value = 0;
  liveBandwidthMBps.value = 0;
  peakBandwidthMBps.value = 0;
  bandwidthNotice.value = null;
  dismissedSuggestUpModal.value = false;
  startedAtMs.value = Date.now();
  nowTick.value = Date.now();
  showToast('测速任务已启动', 'mdi:rocket-launch-outline');
}

async function startSpeedtest() {
  if (!settings.value.subscribeUrl.trim()) {
    showToast('请先输入订阅链接', 'mdi:alert-circle-outline');
    return;
  }
  await checkVpnEnvironment();
  if (vpnCheckResult.value?.detected) {
    pendingStartAfterWarn.value = true;
    vpnWarningModalOpen.value = true;
    return;
  }
  await executeStartSpeedtest();
}

async function confirmStartDespiteVpn() {
  vpnWarningModalOpen.value = false;
  pendingStartAfterWarn.value = false;
  vpnShutdownError.value = '';
  const selected = [...pendingSelectedNodes.value];
  pendingSelectedNodes.value = [];
  await executeStartSpeedtest(selected);
}

async function shutdownVpnAndStart() {
  vpnShuttingDown.value = true;
  vpnShutdownError.value = '';
  try {
    const res = await fetch('/api/preflight/vpn-shutdown', { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || '无法自动退出 VPN，请手动关闭后重试');
    }
    closedVpnsBeforeTest.value = Array.isArray(data.closed) ? data.closed : [];
    await checkVpnEnvironment();
    vpnWarningModalOpen.value = false;
    pendingStartAfterWarn.value = false;
    if (closedVpnsBeforeTest.value.length > 0) {
      showToast(
        `已安全退出 ${closedVpnsBeforeTest.value.map((v) => v.name).join('、')}，测速完成后将提示恢复`,
        'mdi:shield-check-outline',
      );
    }
    const selected = [...pendingSelectedNodes.value];
    pendingSelectedNodes.value = [];
    await executeStartSpeedtest(selected);
  } catch (err) {
    vpnShutdownError.value = err.message;
  } finally {
    vpnShuttingDown.value = false;
  }
}

async function relaunchClosedVpns() {
  const list = [...closedVpnsBeforeTest.value];
  if (list.length === 0) {
    vpnRestoreModalOpen.value = false;
    return;
  }
  vpnLaunching.value = true;
  try {
    for (const item of list) {
      const res = await fetch('/api/preflight/vpn-launch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ exePath: item.exePath }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `启动 ${item.name} 失败`);
    }
    showToast(`已重新打开 ${list.map((v) => v.name).join('、')}`, 'mdi:rocket-launch-outline');
    closedVpnsBeforeTest.value = [];
    vpnRestoreModalOpen.value = false;
    setTimeout(() => checkVpnEnvironment(), 2000);
  } catch (err) {
    showToast(err.message, 'mdi:alert-circle-outline');
  } finally {
    vpnLaunching.value = false;
  }
}

const pendingSelectedNodes = ref([]);

const filteredPreviewNodes = computed(() => {
  const q = previewSearch.value.trim().toLowerCase();
  if (!q) return previewNodes.value;
  return previewNodes.value.filter(
    (n) => n.name.toLowerCase().includes(q) || String(n.type || '').toLowerCase().includes(q),
  );
});

async function openPreviewPool() {
  if (!settings.value.subscribeUrl.trim()) {
    showToast('请先输入订阅链接', 'mdi:alert-circle-outline');
    return;
  }
  await saveSettings(true);
  previewModalOpen.value = true;
  previewLoading.value = true;
  previewSearch.value = '';
  previewNodes.value = [];
  previewSelected.value = [];
  try {
    const res = await fetch('/api/speedtest/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscribeUrl: settings.value.subscribeUrl }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      showToast(data.error || '预览过滤池失败', 'mdi:alert-circle-outline');
      previewModalOpen.value = false;
      return;
    }
    previewNodes.value = Array.isArray(data.nodes) ? data.nodes : [];
    previewSelected.value = previewNodes.value.map((n) => n.name);
  } catch (err) {
    showToast(`预览失败: ${err.message}`, 'mdi:alert-circle-outline');
    previewModalOpen.value = false;
  } finally {
    previewLoading.value = false;
  }
}

function togglePreviewNode(name) {
  const idx = previewSelected.value.indexOf(name);
  if (idx >= 0) {
    previewSelected.value.splice(idx, 1);
  } else {
    previewSelected.value.push(name);
  }
}

function selectAllPreview(checked) {
  const visibleNames = new Set(filteredPreviewNodes.value.map((n) => n.name));
  if (checked) {
    const merged = new Set([...previewSelected.value, ...visibleNames]);
    previewSelected.value = Array.from(merged);
  } else {
    previewSelected.value = previewSelected.value.filter((n) => !visibleNames.has(n));
  }
}

async function startSelectedSpeedtest() {
  if (previewSelected.value.length === 0) {
    showToast('请至少勾选 1 个节点', 'mdi:alert-circle-outline');
    return;
  }
  const chosen = [...previewSelected.value];
  previewModalOpen.value = false;
  await checkVpnEnvironment();
  if (vpnCheckResult.value?.detected) {
    pendingSelectedNodes.value = chosen;
    pendingStartAfterWarn.value = true;
    vpnWarningModalOpen.value = true;
    return;
  }
  await executeStartSpeedtest(chosen);
}

async function retestSingleNode(node) {
  if (!node?.name || running.value || retestingNode.value) return;
  retestingNode.value = node.name;
  try {
    const res = await fetch('/api/speedtest/retest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nodeName: node.name,
        sortBy: sortBy.value,
        enableUnlockCheck: Boolean(settings.value.enableUnlockCheck),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      showToast(data.error || '单点复测失败', 'mdi:alert-circle-outline');
      return;
    }
    if (Array.isArray(data.results)) {
      results.value = data.results;
    }
    const r = data.result;
    if (r?.status === 'OK') {
      showToast(
        `复测完成: ${r.name} · 延迟 ${r.latencyMs}ms · 均速 ${r.avgSpeedMBps.toFixed(2)} MB/s`,
        'mdi:check-circle-outline',
      );
    } else {
      showToast(`复测结果: ${r?.name || node.name} -> ${r?.status || '失败'}`, 'mdi:alert-circle-outline');
    }
  } catch (err) {
    showToast(`复测出错: ${err.message}`, 'mdi:alert-circle-outline');
  } finally {
    retestingNode.value = '';
  }
}

async function generateExportYaml() {
  exportLoading.value = true;
  exportError.value = '';
  exportYaml.value = '';
  try {
    const topN = Number(exportTopN.value) || 10;
    const okNames = sortedAndFilteredResults.value
      .filter((r) => r.status === 'OK' && r.avgSpeedMBps > 0)
      .slice(0, topN)
      .map((r) => r.name);
    const res = await fetch('/api/export/clash-yaml', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topN, nodeNames: okNames }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      exportError.value = data.error || '生成配置失败';
      return;
    }
    exportYaml.value = data.yaml || '';
    exportCount.value = data.count || 0;
    exportFilename.value = data.filename || 'mihomo-optimized.yaml';
  } catch (err) {
    exportError.value = err.message;
  } finally {
    exportLoading.value = false;
  }
}

function openExportModal() {
  exportModalOpen.value = true;
  generateExportYaml();
}

function downloadExportYaml() {
  if (!exportYaml.value) return;
  const blob = new Blob([exportYaml.value], { type: 'application/x-yaml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = exportFilename.value || 'mihomo-optimized.yaml';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast(`已下载优选配置文件: ${exportFilename.value}`, 'mdi:download');
}

const imageExportModalOpen = ref(false);
const imageExportScope = ref('ok');
const imageExportCanvasRef = ref(null);
const imageExportSize = ref({ width: 1120, height: 0 });
const imageExportCopying = ref(false);

const IMAGE_SCOPE_LABELS = {
  ok: '仅可用节点',
  top20: '可用节点 Top 20',
  all: '全部节点',
};

function getScopedExportRows() {
  const list = sortedAndFilteredResults.value;
  if (imageExportScope.value === 'ok') {
    return list.filter((r) => r.status === 'OK');
  }
  if (imageExportScope.value === 'top20') {
    return list.filter((r) => r.status === 'OK').slice(0, 20);
  }
  return list;
}

function redrawExportImage() {
  const canvas = imageExportCanvasRef.value;
  if (!canvas) return;
  const rows = getScopedExportRows();
  const size = renderSpeedtestLongImage(canvas, {
    rows,
    totalNodes: results.value.length,
    okNodes: okNodesCount.value,
    totalBytesText: formatBytes(displayTotalBytes.value),
    elapsedText: formatDuration(displayElapsedMs.value),
    fastestNode: fastestNode.value,
    sortBy: sortBy.value,
    concurrency: Number(selectedConcurrency.value) || 1,
    peakBandwidthMBps: Number(peakBandwidthMBps.value) || 0,
    bandwidthCapMBps: Number(settings.value.maxBandwidthMBps) || 0,
    sceneRecommendations: sceneRecommendations.value || [],
    scopeLabel: IMAGE_SCOPE_LABELS[imageExportScope.value] || '全部节点',
    generatedAt: activeHistoryMeta.value?.generatedAt
      ? new Date(activeHistoryMeta.value.generatedAt)
      : new Date(),
  });
  imageExportSize.value = size;
}

function openImageExportModal() {
  imageExportScope.value = okNodesCount.value > 0 ? 'ok' : 'all';
  imageExportModalOpen.value = true;
  nextTick(() => {
    redrawExportImage();
  });
}

watch(imageExportScope, () => {
  if (imageExportModalOpen.value) {
    nextTick(redrawExportImage);
  }
});

function downloadExportImage() {
  const canvas = imageExportCanvasRef.value;
  if (!canvas) return;
  canvas.toBlob((blob) => {
    if (!blob) {
      showToast('生成 PNG 图片失败', 'mdi:alert-circle-outline');
      return;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const filename = `mihomo-speedtest-${ts}.png`;
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast(`已下载排行榜长图: ${filename}`, 'mdi:image-outline');
  }, 'image/png');
}

async function copyExportImage() {
  const canvas = imageExportCanvasRef.value;
  if (!canvas || imageExportCopying.value) return;
  if (!navigator.clipboard || typeof ClipboardItem === 'undefined') {
    showToast('当前浏览器环境不支持直接复制图片，请点击下载 PNG', 'mdi:alert-circle-outline');
    return;
  }
  imageExportCopying.value = true;
  try {
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('图片编码失败');
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    showToast('已将排行榜长图复制到剪贴板', 'mdi:content-copy');
  } catch (err) {
    showToast(`复制图片失败: ${err?.message || '请改用下载 PNG'}`, 'mdi:alert-circle-outline');
  } finally {
    imageExportCopying.value = false;
  }
}

function openApplyModal(node) {
  if (!node) return;
  applyTargetNode.value = node;
  const tool = activeVpnTool.value;
  vpnApiUrl.value = settings.value.clashVergeApi || tool.defaultApi || 'http://127.0.0.1:9097';
  vpnSecret.value = settings.value.clashVergeSecret || '';
  vpnSelector.value = '';
  vpnProbeResult.value = null;
  applyModalOpen.value = true;
  if (tool.mode === 'clash-api') {
    probeVpnTool();
  }
}

function selectVpnTool(tool) {
  selectedVpnToolId.value = tool.id;
  vpnProbeResult.value = null;
  if (tool.mode === 'clash-api') {
    vpnApiUrl.value = tool.defaultApi || 'http://127.0.0.1:9090';
    vpnSelector.value = '';
    probeVpnTool();
  }
}

async function probeVpnTool() {
  if (activeVpnTool.value.mode !== 'clash-api') return;
  vpnProbing.value = true;
  try {
    const res = await fetch('/api/vpn/probe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apiUrl: vpnApiUrl.value,
        secret: vpnSecret.value,
        nodeName: applyTargetNode.value?.name || '',
      }),
    });
    if (res.ok) {
      const data = await res.json();
      vpnProbeResult.value = data;
      if (data.online && Array.isArray(data.selectors) && data.selectors.length > 0) {
        const currentExists = data.selectors.some((s) => s.name === vpnSelector.value);
        if (!currentExists) {
          const matched = data.selectors.find((s) => s.hasNode && s.name !== 'GLOBAL') || data.selectors[0];
          vpnSelector.value = matched ? matched.name : '';
        }
      }
    }
  } catch {
    vpnProbeResult.value = { online: false, selectors: [], error: '请求检测接口失败' };
  } finally {
    vpnProbing.value = false;
  }
}

async function applyToVpnTool() {
  if (!applyTargetNode.value) return;
  vpnApplying.value = true;
  try {
    const res = await fetch('/api/vpn/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apiUrl: vpnApiUrl.value,
        secret: vpnSecret.value,
        selector: vpnSelector.value,
        nodeName: applyTargetNode.value.name,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.applied) {
      showToast(data.error || '应用节点失败，请检查客户端是否已运行', 'mdi:alert-circle-outline');
      return;
    }
    settings.value.clashVergeApi = vpnApiUrl.value;
    settings.value.clashVergeSecret = vpnSecret.value;
    settings.value.clashVergeSelector = '';
    await saveSettings(true);
    showToast(data.message || `已应用节点: ${applyTargetNode.value.name}`, 'mdi:check-circle-outline');
    applyModalOpen.value = false;
  } catch (err) {
    showToast(`应用失败: ${err.message}`, 'mdi:alert-circle-outline');
  } finally {
    vpnApplying.value = false;
  }
}

async function copyNodeSummary(node) {
  if (!node) return;
  const text =
    node.status === 'OK'
      ? `节点: ${node.name} | 协议: ${node.type} | 延迟: ${node.latencyMs}ms | 均速: ${node.avgSpeedMBps.toFixed(2)} MB/s | 稳态: ${node.steadySpeedMBps.toFixed(2)} MB/s | 倍率: ${node.multiplier}x`
      : `节点: ${node.name} | 协议: ${node.type} | 状态: ${node.status}`;
  await copyNodeName(text);
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
    if (typeof data.startedAtMs === 'number') startedAtMs.value = data.startedAtMs;
    if (typeof data.elapsedMs === 'number') elapsedMs.value = data.elapsedMs;
    if (typeof data.totalBytes === 'number') totalBytes.value = data.totalBytes;
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
    if (typeof data.startedAtMs === 'number') startedAtMs.value = data.startedAtMs;
    if (typeof data.elapsedMs === 'number') elapsedMs.value = data.elapsedMs;
    if (typeof data.totalBytes === 'number') totalBytes.value = data.totalBytes;
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
    if (typeof data.totalBytes === 'number') totalBytes.value = data.totalBytes;
    if (typeof data.elapsedMs === 'number') elapsedMs.value = data.elapsedMs;
    results.value.push(data.result);
  });

  eventSource.addEventListener('bandwidth', (e) => {
    const data = JSON.parse(e.data);
    if (typeof data.currentMBps === 'number') {
      liveBandwidthMBps.value = data.currentMBps;
    }
    if (typeof data.peakMBps === 'number') {
      peakBandwidthMBps.value = data.peakMBps;
    }
  });

  eventSource.addEventListener('concurrency-updated', (e) => {
    const data = JSON.parse(e.data);
    if (typeof data.concurrency === 'number') {
      settings.value.concurrency = data.concurrency;
      bandwidthNotice.value = null;
    }
  });

  eventSource.addEventListener('bandwidth-warning', (e) => {
    const data = JSON.parse(e.data);
    const level = data.level || 'warning';
    if (level === 'clear') {
      if (bandwidthNotice.value?.level === 'suggest-up') {
        bandwidthNotice.value = null;
      }
      return;
    }
    if (data.message) {
      const hadNotice = bandwidthNotice.value?.level === level;
      bandwidthNotice.value = {
        level,
        message: data.message,
        recommendedThreads: Number(data.recommendedThreads) || 0,
        remaining: Number(data.remaining) || 0,
        usageRatio: Number(data.usageRatio) || 0,
      };
      if (!hadNotice) {
        if (level === 'suggest-up') {
          showToast(`宽带余量充足，可实时扩容至 ${data.recommendedThreads} 线程`, 'mdi:rocket-launch-outline');
        } else if (level === 'auto-scaled-down') {
          showToast(`已触及宽带上限，自动降至 ${data.concurrency} 线程并重测受影响节点`, 'mdi:shield-sync-outline');
        } else {
          showToast('已触及预设宽带上限，建议降低并发线程数', 'mdi:speedometer');
        }
      }
    }
  });

  eventSource.addEventListener('done', (e) => {
    const data = JSON.parse(e.data);
    selectedHistoryId.value = '__latest__';
    activeHistoryMeta.value = null;
    results.value = data.results;
    if (typeof data.totalBytes === 'number') totalBytes.value = data.totalBytes;
    if (typeof data.elapsedMs === 'number') elapsedMs.value = data.elapsedMs;
    liveBandwidthMBps.value = 0;
    running.value = false;
    stage.value = 'idle';
    fetchHistoryList();
    showToast(data.aborted ? '测速已中止并保存部分结果' : '全量测速已完成！');
    if (closedVpnsBeforeTest.value.length > 0) {
      vpnRestoreModalOpen.value = true;
    }
  });

  eventSource.addEventListener('error', (e) => {
    if (e.data) {
      const data = JSON.parse(e.data);
      showToast(`测速出错: ${data.message}`, 'mdi:alert-circle-outline');
    }
  });
}

let clockTimer = null;

onMounted(async () => {
  await Promise.all([fetchInitialData(), checkVpnEnvironment()]);
  connectSSE();
  clockTimer = setInterval(() => {
    if (running.value) {
      nowTick.value = Date.now();
    }
  }, 500);
});

onUnmounted(() => {
  if (clockTimer) clearInterval(clockTimer);
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

      <!-- 测速环境提示（提醒根据情况关闭现有 VPN 软件） -->
      <div
        :class="[
          'flex flex-wrap items-start justify-between gap-3 rounded-2xl border px-4 py-3 text-xs backdrop-blur-xl transition-colors',
          vpnCheckResult?.detected
            ? 'border-amber-400/40 bg-amber-500/10 text-amber-100'
            : 'border-sky-400/25 bg-sky-500/[0.07] text-slate-300',
        ]"
      >
        <div class="flex items-start gap-2.5">
          <Icon
            :icon="vpnCheckResult?.detected ? 'mdi:alert-outline' : 'mdi:information-outline'"
            :class="[
              'mt-0.5 h-4 w-4 shrink-0',
              vpnCheckResult?.detected ? 'text-amber-400' : 'text-[#0A84FF]',
            ]"
          />
          <div class="space-y-1 leading-relaxed">
            <div class="font-semibold text-slate-100">
              <template v-if="vpnCheckResult?.detected">
                检测到本机正在运行 VPN 软件或已开启系统代理 — 请根据情况先关闭后再测试
              </template>
              <template v-else>
                测速环境提示：开始测试前请根据情况关闭现有 VPN 软件（尤其是 TUN 虚拟网卡模式）
              </template>
            </div>
            <p class="text-slate-300/90">
              测速期间本工具会拉起独立 Mihomo 内核直连节点；若同时开启其他 VPN 的系统代理或 TUN 模式，可能导致“套娃测速”结果失真或路由冲突。测速完成后可再重新开启 VPN，并通过下方「应用」按钮一键切换最优节点。
            </p>
            <ul v-if="vpnCheckResult?.warnings?.length" class="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-amber-200/95">
              <li v-for="(w, wi) in vpnCheckResult.warnings" :key="wi">• {{ w }}</li>
            </ul>
          </div>
        </div>
        <Button size="sm" class="shrink-0 self-start sm:self-center whitespace-nowrap" :disabled="vpnCheckLoading || running" @click="checkVpnEnvironment">
          <Icon :icon="vpnCheckLoading ? 'mdi:loading' : 'mdi:refresh'" :class="['h-3.5 w-3.5', vpnCheckLoading && 'animate-spin']" />
          <span>{{ vpnCheckLoading ? '检测中...' : '重新检测' }}</span>
        </Button>
      </div>

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

        <div class="mt-4 flex flex-col gap-3 lg:flex-row lg:items-end">
          <div class="grid flex-1 grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <div class="flex flex-col gap-1.5">
              <label class="text-xs font-medium text-slate-400">排序维度</label>
              <Select v-model="sortBy" :options="sortOptions" />
            </div>

            <div class="flex flex-col gap-1.5">
              <label class="text-xs font-medium text-slate-400">测速节点数量</label>
              <Select v-model="limit" :options="limitOptions" :disabled="running" />
            </div>

            <div class="flex flex-col gap-1.5">
              <label class="text-xs font-medium text-slate-400 truncate">
                并发线程数
                <span v-if="!hasBandwidthCap" class="text-[11px] text-amber-400">(需先设宽带上限)</span>
              </label>
              <Select
                v-model="selectedConcurrency"
                :options="concurrencyOptions"
                :disabled="running || !hasBandwidthCap"
              />
            </div>

            <div class="flex flex-col gap-1.5">
              <label class="text-xs font-medium text-slate-400 truncate">
                宽带上限 (MB/s)
                <span v-if="settings.maxBandwidthMBps > 0" class="text-[11px] text-[#64D2FF]">
                  ≈ {{ Math.round(settings.maxBandwidthMBps * 8) }}M
                </span>
              </label>
              <div class="flex items-center gap-1.5">
                <Input
                  v-model.number="settings.maxBandwidthMBps"
                  type="number"
                  min="0"
                  step="0.5"
                  placeholder="0 = 不限制"
                  :disabled="running"
                  @blur="saveSettings(true)"
                />
                <Button
                  v-if="!running"
                  size="sm"
                  class="shrink-0 whitespace-nowrap"
                  title="直连测出当前网络真实下载上限"
                  @click="openBandwidthTestModal"
                >
                  <Icon icon="mdi:speedometer" class="h-4 w-4 text-[#64D2FF]" />
                  <span>测上限</span>
                </Button>
              </div>
            </div>
          </div>

          <div class="flex shrink-0 items-center gap-2.5">
            <Button v-if="!running" variant="primary" class="whitespace-nowrap" @click="startSpeedtest">
              <Icon icon="mdi:play" class="h-4 w-4" />
              <span>开始测速</span>
            </Button>
            <Button v-else variant="danger" class="whitespace-nowrap" @click="stopSpeedtest">
              <Icon icon="mdi:stop" class="h-4 w-4" />
              <span>停止测速</span>
            </Button>
            <Button v-if="!running" class="whitespace-nowrap" @click="openPreviewPool">
              <Icon icon="mdi:filter-check-outline" class="h-4 w-4" />
              <span>预览过滤池</span>
            </Button>
          </div>
        </div>

        <div class="mt-3 flex flex-wrap items-center gap-3">
          <label
            class="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs text-slate-200 cursor-pointer select-none hover:bg-white/[0.08] transition-colors"
            title="开启后，对测速通过的节点额外探测出口真实IP归属地及 ChatGPT / Netflix 解锁情况（单节点约多耗时 1~3 秒）"
          >
            <input
              v-model="settings.enableUnlockCheck"
              type="checkbox"
              :disabled="running"
              class="h-4 w-4 rounded border-white/20 bg-black/40 text-[#0A84FF] focus:ring-[#0A84FF]"
              @change="saveSettings(true)"
            />
            <span>落地与解锁检测 (IP/GPT/NF)</span>
          </label>
        </div>

        <!-- 宽带上限与线程数预警 / 调优建议 -->
        <div
          v-if="bandwidthNotice || preflightBandwidthAdvice"
          :class="[
            'mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border px-3.5 py-2.5 text-xs',
            bandwidthNotice?.level === 'suggest-up'
              ? 'border-[#0A84FF]/35 bg-[#0A84FF]/10 text-sky-100'
              : 'border-amber-400/35 bg-amber-500/10 text-amber-100',
          ]"
        >
          <div class="flex items-start gap-2 leading-relaxed">
            <Icon
              :icon="bandwidthNotice?.level === 'suggest-up' ? 'mdi:trending-up' : 'mdi:alert-outline'"
              :class="[
                'mt-0.5 h-4 w-4 shrink-0',
                bandwidthNotice?.level === 'suggest-up' ? 'text-[#64D2FF]' : 'text-amber-400',
              ]"
            />
            <div>
              <span class="font-semibold">
                {{
                  bandwidthNotice
                    ? bandwidthNotice.level === 'suggest-up'
                      ? '峰值宽带调优建议：'
                      : '实时宽带预警：'
                    : '并发配置提示：'
                }}
              </span>
              <span>{{ bandwidthNotice ? bandwidthNotice.message : preflightBandwidthAdvice }}</span>
            </div>
          </div>
          <button
            v-if="bandwidthNotice?.recommendedThreads > 0"
            type="button"
            :class="[
              'shrink-0 rounded-lg border px-2.5 py-1 text-[11px] font-medium transition-colors',
              bandwidthNotice.level === 'suggest-up'
                ? 'border-[#0A84FF]/50 bg-[#0A84FF]/20 text-sky-100 hover:bg-[#0A84FF]/30'
                : 'border-amber-400/50 bg-amber-500/20 text-amber-100 hover:bg-amber-500/30',
            ]"
            @click="applyRecommendedThreads(bandwidthNotice.recommendedThreads)"
          >
            设为 {{ bandwidthNotice.recommendedThreads }} 线程
          </button>
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
              <label class="text-xs font-medium text-slate-400">单节点流量熔断上限 (MB)</label>
              <Input
                v-model.number="maxNodeMB"
                type="number"
                min="1"
                step="1"
                placeholder="10"
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

      <!-- 四联统计卡 -->
      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
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
            <Icon icon="mdi:chart-donut" class="h-4 w-4 text-[#64D2FF]" />
            <span>测试使用流量 / 时长</span>
          </div>
          <div class="mt-2 flex items-baseline gap-2 font-mono text-2xl font-bold tabular-nums text-[#64D2FF]">
            <span>{{ formatBytes(displayTotalBytes) }}</span>
          </div>
          <div class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-400 font-mono tabular-nums">
            <span class="inline-flex items-center gap-1">
              <Icon icon="mdi:timer-outline" class="h-3.5 w-3.5 text-slate-400" />
              <span v-if="running">已耗时 {{ formatTimerClock(displayElapsedMs) }}</span>
              <span v-else>总时长 {{ formatDuration(displayElapsedMs) }}</span>
            </span>
            <span v-if="running && liveBandwidthMBps > 0" class="text-[#30D158]">
              实时 {{ liveBandwidthMBps.toFixed(1) }} MB/s
              <template v-if="settings.maxBandwidthMBps > 0">/ 上限 {{ settings.maxBandwidthMBps }}</template>
            </span>
            <span v-if="peakBandwidthMBps > 0" class="text-[#64D2FF]">
              峰值 {{ peakBandwidthMBps.toFixed(1) }} MB/s
            </span>
          </div>
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
              'group rounded-xl border p-4 transition-all duration-200 ease-out backdrop-blur-xl',
              scene.node
                ? 'cursor-pointer border-white/10 bg-white/[0.06] hover:-translate-y-0.5 hover:border-[#0A84FF]/50 hover:bg-white/[0.1] hover:shadow-lg hover:shadow-black/25'
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

            <div v-if="scene.node" class="mt-3 flex items-center justify-end border-t border-white/10 pt-2.5">
              <Button
                size="sm"
                variant="primary"
                class="h-7 px-2.5 text-[11px]"
                @click.stop="openApplyModal(scene.node)"
              >
                <Icon icon="mdi:send-check-outline" class="h-3.5 w-3.5" />
                <span>点击应用</span>
              </Button>
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
            <Button v-if="sortedAndFilteredResults.length > 0 && !running" size="sm" @click="openImageExportModal">
              <Icon icon="mdi:image-area" class="h-4 w-4 text-[#64D2FF]" />
              <span>导出测速长图</span>
            </Button>
            <Button v-if="okNodesCount > 0 && !running" size="sm" @click="openExportModal">
              <Icon icon="mdi:file-export-outline" class="h-4 w-4 text-[#30D158]" />
              <span>导出优选配置</span>
            </Button>
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
                :key="item.name"
                class="row-fade-in transition-colors duration-150 hover:bg-white/[0.04]"
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
                  <div v-if="item.unlock" class="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px]">
                    <Tooltip v-if="item.unlock.countryCode || item.unlock.country">
                      <template #trigger>
                        <span class="inline-flex items-center gap-1 rounded-md border border-white/10 bg-white/[0.06] px-1.5 py-0.5 text-slate-300 cursor-help">
                          <span>{{ item.unlock.countryCode || 'IP' }}</span>
                          <span>{{ item.unlock.country }}</span>
                          <span v-if="item.unlock.isp" class="max-w-[130px] truncate text-slate-400">· {{ item.unlock.isp }}</span>
                        </span>
                      </template>
                      <div class="text-xs space-y-0.5">
                        <div>出口 IP：{{ item.unlock.ip || '--' }}</div>
                        <div>归属地：{{ item.unlock.country || '--' }} ({{ item.unlock.countryCode || '--' }})</div>
                        <div>运营商：{{ item.unlock.isp || '--' }}</div>
                        <div v-if="item.unlock.ipType">
                          IP 类型：{{
                            item.unlock.ipType === 'residential'
                              ? '原生家宽 / 商宽'
                              : item.unlock.ipType === 'mobile'
                                ? '移动蜂窝 IP'
                                : '机房 / IDC'
                          }}
                        </div>
                      </div>
                    </Tooltip>
                    <span
                      v-if="item.unlock.ipType"
                      :class="[
                        'inline-flex items-center rounded-md border px-1.5 py-0.5 font-medium',
                        item.unlock.ipType === 'residential'
                          ? 'border-emerald-400/30 bg-emerald-500/15 text-emerald-300'
                          : item.unlock.ipType === 'mobile'
                            ? 'border-sky-400/30 bg-sky-500/15 text-sky-300'
                            : 'border-amber-400/25 bg-amber-500/10 text-amber-300',
                      ]"
                    >
                      {{
                        item.unlock.ipType === 'residential'
                          ? '家宽'
                          : item.unlock.ipType === 'mobile'
                            ? '移动'
                            : '机房'
                      }}
                    </span>
                    <span
                      v-if="item.unlock.chatgpt && item.unlock.chatgpt !== 'unknown'"
                      :class="[
                        'inline-flex items-center rounded-md border px-1.5 py-0.5 font-medium',
                        item.unlock.chatgpt === 'yes'
                          ? 'border-emerald-400/30 bg-emerald-500/15 text-emerald-300'
                          : 'border-rose-400/30 bg-rose-500/15 text-rose-300',
                      ]"
                    >
                      {{ item.unlock.chatgpt === 'yes' ? 'GPT ✓' : 'GPT ✗' }}
                    </span>
                    <span
                      v-if="item.unlock.netflix && item.unlock.netflix !== 'unknown'"
                      :class="[
                        'inline-flex items-center rounded-md border px-1.5 py-0.5 font-medium',
                        item.unlock.netflix === 'full'
                          ? 'border-emerald-400/30 bg-emerald-500/15 text-emerald-300'
                          : item.unlock.netflix === 'originals'
                            ? 'border-sky-400/30 bg-sky-500/15 text-sky-300'
                            : 'border-white/10 bg-white/[0.05] text-slate-400',
                      ]"
                    >
                      {{
                        item.unlock.netflix === 'full'
                          ? 'NF 全解锁'
                          : item.unlock.netflix === 'originals'
                            ? 'NF 自制'
                            : 'NF ✗'
                      }}
                    </span>
                  </div>
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
                  <div v-if="item.latencyMs !== null" class="flex flex-col items-start gap-1">
                    <Badge variant="success">{{ item.latencyMs }} ms</Badge>
                    <span
                      v-if="item.jitterMs !== undefined && item.jitterMs !== null"
                      :class="[
                        'text-[10px] leading-none',
                        item.jitterMs <= 15
                          ? 'text-emerald-400/80'
                          : item.jitterMs <= 50
                            ? 'text-amber-400/80'
                            : 'text-rose-400/90',
                      ]"
                    >
                      ±{{ item.jitterMs }}ms{{ item.packetLoss > 0 ? ` · ${item.packetLoss}%丢包` : '' }}
                    </span>
                  </div>
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
                <td class="px-3 py-2.5">
                  <div class="flex items-center gap-1.5 whitespace-nowrap">
                    <Button
                      v-if="item.status === 'OK'"
                      size="sm"
                      variant="primary"
                      @click="openApplyModal(item)"
                    >
                      <Icon icon="mdi:send-check-outline" class="h-3.5 w-3.5" />
                      <span>应用</span>
                    </Button>
                    <Button
                      size="sm"
                      :disabled="running || Boolean(retestingNode)"
                      title="仅重新测试这一个节点"
                      @click="retestSingleNode(item)"
                    >
                      <Icon
                        :icon="retestingNode === item.name ? 'mdi:loading' : 'mdi:refresh'"
                        :class="['h-3.5 w-3.5', retestingNode === item.name && 'animate-spin']"
                      />
                      <span>{{ retestingNode === item.name ? '复测中' : '复测' }}</span>
                    </Button>
                    <Button size="sm" title="查看节点历史测速对比" @click="openNodeCompare(item.name)">
                      <Icon icon="mdi:history" class="h-3.5 w-3.5" />
                      <span>历史</span>
                    </Button>
                  </div>
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

      <!-- VPN 冲突确认弹窗 -->
      <Dialog v-model:open="vpnWarningModalOpen" title="检测到本机正在运行 VPN 软件">
        <template #icon>
          <Icon icon="mdi:alert-outline" class="h-5 w-5 text-amber-400" />
        </template>
        <div class="space-y-4 text-xs leading-relaxed text-slate-300">
          <div class="rounded-xl border border-amber-400/35 bg-amber-500/10 p-3.5 text-amber-100">
            <p class="font-semibold">当前环境存在以下可能影响测速的代理/VPN 状态：</p>
            <ul class="mt-2 space-y-1 text-amber-200/95">
              <li v-for="(w, idx) in vpnCheckResult?.warnings || []" :key="idx">• {{ w }}</li>
            </ul>
          </div>
          <p>
            如果你正在使用上述 VPN 软件的 <strong>系统代理</strong> 或 <strong>TUN 虚拟网卡模式</strong>，直接测速会导致流量经过现有 VPN 转发（“套娃测速”），从而使测速结果失真或出现连接异常。
          </p>
          <p class="text-slate-400">
            建议：先关闭现有 VPN 软件（或退出 TUN 模式）后再测速。
            <template v-if="vpnCheckResult?.autoClosable?.length > 0">
              检测到支持白名单安全退出的客户端：<strong class="text-sky-300">{{ vpnCheckResult.autoClosable.map((v) => v.name).join('、') }}</strong>，可点击下方按钮自动关闭系统代理并退出（已记住路径，测完提示恢复）。
            </template>
            <template v-else>
              若当前软件不在安全自动退出白名单或仅需忽略，请手动退出后再点击「重新检测」，或选择直接继续测速。
            </template>
          </p>
          <div v-if="vpnShutdownError" class="rounded-xl border border-rose-400/35 bg-rose-500/10 p-3 text-rose-200">
            {{ vpnShutdownError }}
          </div>
          <div class="flex flex-wrap items-center justify-end gap-2 border-t border-white/10 pt-3">
            <Button variant="ghost" size="sm" :disabled="vpnShuttingDown" @click="vpnWarningModalOpen = false">取消</Button>
            <Button size="sm" :disabled="vpnShuttingDown" @click="confirmStartDespiteVpn">
              <Icon icon="mdi:play" class="h-4 w-4" />
              <span>忽略，继续测速</span>
            </Button>
            <Button
              v-if="vpnCheckResult?.autoClosable?.length > 0"
              variant="primary"
              size="sm"
              :disabled="vpnShuttingDown"
              @click="shutdownVpnAndStart"
            >
              <Icon :icon="vpnShuttingDown ? 'mdi:loading' : 'mdi:power'" :class="['h-4 w-4', vpnShuttingDown && 'animate-spin']" />
              <span>{{ vpnShuttingDown ? '正在安全退出 VPN...' : `退出 ${vpnCheckResult.autoClosable.map((v) => v.name).join('、')} 并开始测速` }}</span>
            </Button>
          </div>
        </div>
      </Dialog>

      <!-- 测速完成后恢复打开 VPN 弹窗 -->
      <Dialog v-model:open="vpnRestoreModalOpen" title="测速完成，是否重新打开 VPN？">
        <template #icon>
          <Icon icon="mdi:shield-refresh-outline" class="h-5 w-5 text-[#30D158]" />
        </template>
        <div class="space-y-4 text-xs leading-relaxed text-slate-300">
          <div class="rounded-xl border border-emerald-400/30 bg-emerald-500/10 p-3.5 text-emerald-100">
            本次测速已结束！测速前已为你安全退出并记录启动路径：
            <ul class="mt-2 space-y-1 font-medium text-emerald-200">
              <li v-for="item in closedVpnsBeforeTest" :key="item.processName">
                • {{ item.name }} <span class="font-mono text-[11px] text-emerald-300/80">({{ item.exePath }})</span>
              </li>
            </ul>
          </div>
          <p class="text-slate-400">
            重新打开后，你可以直接在下方排行榜或「智能场景推荐」卡片中点击「应用」，将测出的最优节点一键切换到 VPN 中使用。
          </p>
          <div class="flex flex-wrap items-center justify-end gap-2 border-t border-white/10 pt-3">
            <Button
              variant="ghost"
              size="sm"
              :disabled="vpnLaunching"
              @click="vpnRestoreModalOpen = false; closedVpnsBeforeTest = []"
            >
              暂不打开
            </Button>
            <Button variant="primary" size="sm" :disabled="vpnLaunching" @click="relaunchClosedVpns">
              <Icon :icon="vpnLaunching ? 'mdi:loading' : 'mdi:rocket-launch-outline'" :class="['h-4 w-4', vpnLaunching && 'animate-spin']" />
              <span>{{ vpnLaunching ? '正在启动 VPN...' : `立即重新打开 ${closedVpnsBeforeTest.map((v) => v.name).join('、')}` }}</span>
            </Button>
          </div>
        </div>
      </Dialog>

      <!-- 针对各个 VPN 工具的点击应用弹窗 -->
      <Dialog
        v-model:open="applyModalOpen"
        :title="`应用节点到 VPN 工具 — ${applyTargetNode?.name || ''}`"
      >
        <template #icon>
          <Icon icon="mdi:send-check-outline" class="h-5 w-5 text-[#0A84FF]" />
        </template>
        <div v-if="applyTargetNode" class="space-y-4 text-xs">
          <div class="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-3.5 py-2.5">
            <div class="space-y-0.5">
              <div class="font-semibold text-slate-100">{{ applyTargetNode.name }}</div>
              <div class="font-mono text-[11px] text-slate-400">
                协议 {{ applyTargetNode.type }} · 延迟 {{ applyTargetNode.latencyMs ?? '--' }} ms · 均速
                {{ applyTargetNode.avgSpeedMBps?.toFixed(2) }} MB/s · 稳态
                {{ applyTargetNode.steadySpeedMBps?.toFixed(2) }} MB/s
              </div>
            </div>
            <Button size="sm" @click="copyNodeName(applyTargetNode.name)">
              <Icon icon="mdi:content-copy" class="h-3.5 w-3.5" />
              <span>复制节点名</span>
            </Button>
          </div>

          <div>
            <div class="mb-2 font-medium text-slate-300">选择你的 VPN 客户端工具</div>
            <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <button
                v-for="tool in VPN_TOOLS"
                :key="tool.id"
                type="button"
                :class="[
                  'flex items-start gap-2.5 rounded-xl border p-3 text-left transition-all cursor-pointer',
                  selectedVpnToolId === tool.id
                    ? 'border-[#0A84FF] bg-[#0A84FF]/15 text-white shadow-[0_0_15px_rgba(10,132,255,0.2)]'
                    : 'border-white/10 bg-white/[0.04] text-slate-300 hover:bg-white/[0.08]',
                ]"
                @click="selectVpnTool(tool)"
              >
                <Icon
                  :icon="tool.icon"
                  :class="['mt-0.5 h-4 w-4 shrink-0', selectedVpnToolId === tool.id ? 'text-[#64D2FF]' : 'text-slate-400']"
                />
                <div class="min-w-0">
                  <div class="font-semibold">{{ tool.name }}</div>
                  <div class="mt-0.5 text-[11px] leading-snug text-slate-400">{{ tool.desc }}</div>
                </div>
              </button>
            </div>
          </div>

          <!-- Clash / Mihomo API 一键切换区 -->
          <div
            v-if="activeVpnTool.mode === 'clash-api'"
            class="space-y-3 rounded-xl border border-white/10 bg-black/25 p-3.5"
          >
            <div class="flex flex-wrap items-center justify-between gap-2">
              <span class="font-semibold text-slate-200">{{ activeVpnTool.name }} 外部控制配置</span>
              <Badge v-if="vpnProbeResult?.online" variant="success">客户端在线</Badge>
              <Badge v-else-if="vpnProbeResult && !vpnProbeResult.online" variant="danger">未连接</Badge>
            </div>

            <div class="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              <div class="flex flex-col gap-1">
                <div class="flex items-center justify-between">
                  <label class="text-[11px] text-slate-400">控制 API 地址（非代理端口 7890）</label>
                  <button
                    v-if="activeVpnTool.defaultApi && vpnApiUrl !== activeVpnTool.defaultApi"
                    type="button"
                    class="text-[11px] text-[#64D2FF] hover:underline cursor-pointer"
                    @click="vpnApiUrl = activeVpnTool.defaultApi; probeVpnTool()"
                  >
                    恢复默认 ({{ activeVpnTool.defaultApi.split(':').pop() }})
                  </button>
                </div>
                <Input v-model="vpnApiUrl" type="text" placeholder="http://127.0.0.1:9097" />
              </div>
              <div class="flex flex-col gap-1">
                <label class="text-[11px] text-slate-400">API Secret（在客户端「外部控制」中查看）</label>
                <Input v-model="vpnSecret" type="password" placeholder="可选密钥" />
              </div>
            </div>

            <div class="flex flex-wrap items-end gap-2.5">
              <div class="min-w-[200px] flex-1 flex flex-col gap-1">
                <label class="text-[11px] text-slate-400">目标策略组 (Selector)</label>
                <select
                  v-model="vpnSelector"
                  class="h-9 w-full rounded-xl border border-white/15 bg-slate-900/80 px-3 text-xs text-slate-100 focus:border-[#0A84FF] focus:outline-none"
                >
                  <option value="">
                    {{
                      vpnProbeResult?.selectors?.length
                        ? `默认第一个分组 (${vpnProbeResult.selectors[0].name})`
                        : '默认第一个主分组'
                    }}
                  </option>
                  <option
                    v-for="sel in vpnProbeResult?.selectors || []"
                    :key="sel.name"
                    :value="sel.name"
                  >
                    {{ sel.name }} (当前: {{ sel.now || '--' }}){{ sel.hasNode ? ' ✓ 含此节点' : '' }}
                  </option>
                </select>
              </div>
              <Button size="sm" :disabled="vpnProbing" @click="probeVpnTool">
                <Icon :icon="vpnProbing ? 'mdi:loading' : 'mdi:radar'" :class="['h-4 w-4', vpnProbing && 'animate-spin']" />
                <span>{{ vpnProbing ? '探测中...' : '检测连接' }}</span>
              </Button>
            </div>

            <div v-if="vpnProbeResult && !vpnProbeResult.online" class="text-[11px] text-rose-300">
              连接失败：{{ vpnProbeResult.error || '请确认该 VPN 客户端已启动且已开启「外部控制 / External Controller」功能' }}
            </div>

            <div class="flex justify-end gap-2 pt-1">
              <Button variant="ghost" size="sm" @click="applyModalOpen = false">取消</Button>
              <Button variant="primary" size="sm" :disabled="vpnApplying" @click="applyToVpnTool">
                <Icon :icon="vpnApplying ? 'mdi:loading' : 'mdi:check-bold'" :class="['h-4 w-4', vpnApplying && 'animate-spin']" />
                <span>{{ vpnApplying ? '正在切换...' : `立即应用到 ${activeVpnTool.name}` }}</span>
              </Button>
            </div>
          </div>

          <!-- 非 Clash API 客户端（v2rayN / Shadowrocket / Surge 等）快捷操作区 -->
          <div v-else class="space-y-3 rounded-xl border border-white/10 bg-black/25 p-3.5">
            <div class="font-semibold text-slate-200">{{ activeVpnTool.name }} 使用指引与快捷操作</div>
            <p class="leading-relaxed text-slate-400">
              该客户端未提供统一的本地节点切换 HTTP API。你可以点击下方按钮复制节点名称或测速摘要，在 {{ activeVpnTool.name }} 的服务器列表中搜索并设置为活动节点即可。
            </p>
            <div class="flex flex-wrap items-center justify-end gap-2 pt-1">
              <Button size="sm" @click="copyNodeSummary(applyTargetNode)">
                <Icon icon="mdi:text-box-check-outline" class="h-4 w-4" />
                <span>复制节点测速摘要</span>
              </Button>
              <Button variant="primary" size="sm" @click="copyNodeName(applyTargetNode.name)">
                <Icon icon="mdi:content-copy" class="h-4 w-4" />
                <span>复制节点名称去客户端切换</span>
              </Button>
            </div>
          </div>
        </div>
      </Dialog>

      <!-- 测前过滤池预览弹窗 -->
      <Dialog v-model:open="previewModalOpen" title="测前过滤池预览（所见即所得）">
        <template #icon>
          <Icon icon="mdi:filter-check-outline" class="h-5 w-5 text-[#0A84FF]" />
        </template>
        <div v-if="previewLoading" class="py-10 text-center text-xs text-slate-400">
          正在拉取订阅并按当前地区/关键词过滤，请稍候...
        </div>
        <div v-else class="space-y-3 text-xs">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <span class="text-slate-300">
              命中 <strong class="text-white">{{ previewNodes.length }}</strong> 个节点，已勾选
              <strong class="text-[#30D158]">{{ previewSelected.length }}</strong> 个
            </span>
            <div class="flex items-center gap-1.5">
              <Button size="sm" @click="selectAllPreview(true)">全选当前</Button>
              <Button size="sm" @click="selectAllPreview(false)">清空当前</Button>
            </div>
          </div>

          <Input v-model="previewSearch" type="text" placeholder="在过滤池中搜索节点名称或协议..." />

          <div class="max-h-72 overflow-y-auto rounded-xl border border-white/10 bg-black/30 divide-y divide-white/[0.06]">
            <div v-if="filteredPreviewNodes.length === 0" class="py-8 text-center text-slate-500">
              没有匹配的节点
            </div>
            <label
              v-for="node in filteredPreviewNodes"
              :key="node.name"
              class="flex items-center justify-between gap-3 px-3 py-2 hover:bg-white/[0.04] cursor-pointer select-none"
            >
              <div class="flex min-w-0 items-center gap-2.5">
                <input
                  type="checkbox"
                  :checked="previewSelected.includes(node.name)"
                  class="h-4 w-4 shrink-0 rounded border-white/20 bg-black/40 text-[#0A84FF] focus:ring-[#0A84FF]"
                  @change="togglePreviewNode(node.name)"
                />
                <span class="truncate text-slate-200">{{ node.name }}</span>
              </div>
              <div class="flex shrink-0 items-center gap-1.5">
                <Badge>{{ node.type }}</Badge>
                <span class="font-mono text-[11px] text-slate-400">{{ node.multiplier }}x</span>
              </div>
            </label>
          </div>

          <div class="flex flex-wrap items-center justify-end gap-2 border-t border-white/10 pt-3">
            <Button variant="ghost" size="sm" @click="previewModalOpen = false">关闭</Button>
            <Button variant="primary" size="sm" :disabled="previewSelected.length === 0" @click="startSelectedSpeedtest">
              <Icon icon="mdi:play" class="h-4 w-4" />
              <span>仅测选中的 {{ previewSelected.length }} 个节点</span>
            </Button>
          </div>
        </div>
      </Dialog>

      <!-- 一键导出精简 Clash 优选配置弹窗 -->
      <Dialog v-model:open="exportModalOpen" title="导出精简 Clash 优选配置文件">
        <template #icon>
          <Icon icon="mdi:file-export-outline" class="h-5 w-5 text-[#30D158]" />
        </template>
        <div class="space-y-3.5 text-xs">
          <div class="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-3.5 py-2.5">
            <div class="text-slate-300">
              自动提取当前排名前 N 个可用节点，并内置 <code class="rounded bg-white/10 px-1 py-0.5">url-test</code> 自动优选与 <code class="rounded bg-white/10 px-1 py-0.5">fallback</code> 故障转移策略组。
            </div>
            <div class="flex items-center gap-2">
              <label class="text-slate-400 whitespace-nowrap">保留节点数:</label>
              <select
                v-model="exportTopN"
                class="h-8 rounded-lg border border-white/15 bg-slate-900/80 px-2.5 text-xs text-slate-100 focus:border-[#0A84FF] focus:outline-none"
                @change="generateExportYaml"
              >
                <option value="5">Top 5</option>
                <option value="10">Top 10</option>
                <option value="20">Top 20</option>
                <option value="999">全部可用节点</option>
              </select>
            </div>
          </div>

          <div v-if="exportLoading" class="py-8 text-center text-slate-400">正在生成 Clash 优选配置...</div>
          <div v-else-if="exportError" class="rounded-xl border border-rose-400/30 bg-rose-500/10 p-3 text-rose-200">
            {{ exportError }}
          </div>
          <template v-else>
            <textarea
              :value="exportYaml"
              readonly
              rows="12"
              class="w-full rounded-xl border border-white/10 bg-black/40 p-3 font-mono text-[11px] leading-relaxed text-slate-300 focus:outline-none"
            />
            <div class="flex flex-wrap items-center justify-between gap-2 border-t border-white/10 pt-3">
              <span class="text-slate-400">共包含 {{ exportCount }} 个优选节点 · 可直接拖入 Clash Verge / Mihomo Party 使用</span>
              <div class="flex items-center gap-2">
                <Button size="sm" @click="copyNodeName(exportYaml)">
                  <Icon icon="mdi:content-copy" class="h-4 w-4" />
                  <span>复制 YAML</span>
                </Button>
                <Button variant="primary" size="sm" @click="downloadExportYaml">
                  <Icon icon="mdi:download" class="h-4 w-4" />
                  <span>下载 {{ exportFilename }}</span>
                </Button>
              </div>
            </div>
          </template>
        </div>
      </Dialog>

      <!-- 一键生成排行榜测速长图（PNG）弹窗 -->
      <Dialog v-model:open="imageExportModalOpen" title="导出排行榜测速长图（PNG）">
        <template #icon>
          <Icon icon="mdi:image-area" class="h-5 w-5 text-[#64D2FF]" />
        </template>
        <div class="space-y-3.5 text-xs">
          <div class="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-3.5 py-2.5">
            <div class="text-slate-300">
              本地高分辨率渲染（2x DPI），包含汇总指标、场景推荐与当前排序榜单，适合直接分享。
            </div>
            <div class="flex items-center gap-2">
              <label class="text-slate-400 whitespace-nowrap">导出范围:</label>
              <select
                v-model="imageExportScope"
                class="h-8 rounded-lg border border-white/15 bg-slate-900/80 px-2.5 text-xs text-slate-100 focus:border-[#0A84FF] focus:outline-none"
              >
                <option value="ok">仅可用节点 ({{ okNodesCount }})</option>
                <option value="top20">可用节点 Top 20</option>
                <option value="all">全部节点 ({{ sortedAndFilteredResults.length }})</option>
              </select>
            </div>
          </div>

          <div class="max-h-[56vh] overflow-auto rounded-xl border border-white/10 bg-[#070b14] p-2">
            <canvas
              ref="imageExportCanvasRef"
              class="mx-auto block h-auto w-full rounded-lg"
            />
          </div>

          <div class="flex flex-wrap items-center justify-between gap-2 border-t border-white/10 pt-3">
            <span class="font-mono text-[11px] text-slate-400">
              输出尺寸: {{ imageExportSize.width * 2 }}×{{ imageExportSize.height * 2 }} px (@2x PNG)
            </span>
            <div class="flex items-center gap-2">
              <Button size="sm" :disabled="imageExportCopying" @click="copyExportImage">
                <Icon icon="mdi:content-copy" class="h-4 w-4" />
                <span>{{ imageExportCopying ? '正在复制...' : '复制图片' }}</span>
              </Button>
              <Button variant="primary" size="sm" @click="downloadExportImage">
                <Icon icon="mdi:download" class="h-4 w-4" />
                <span>下载 PNG 长图</span>
              </Button>
            </div>
          </div>
        </div>
      </Dialog>

      <!-- 本地宽带上限测试弹窗 -->
      <Dialog v-model:open="bwTestModalOpen" title="本地宽带上限压测">
        <template #icon>
          <Icon icon="mdi:speedometer" class="h-5 w-5 text-[#64D2FF]" />
        </template>
        <div class="space-y-4 text-xs">
          <div class="rounded-xl border border-white/10 bg-white/[0.04] p-3 text-slate-300 leading-relaxed">
            绕过代理节点，使用 8 路并发多源直连压测约 6 秒（同时叠加多家大厂 CDN 绕开单源限速），测出当前本地千兆/百兆网络的真实下载天花板。
          </div>

          <div class="space-y-2">
            <div class="font-medium text-slate-400">选择直连测速源：</div>
            <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <button
                type="button"
                :class="[
                  'rounded-xl border p-3 text-left transition-all',
                  bwTestMode === 'domestic'
                    ? 'border-[#0A84FF] bg-[#0A84FF]/15 text-white'
                    : 'border-white/10 bg-white/[0.04] text-slate-300 hover:bg-white/[0.08]',
                ]"
                :disabled="bwTestRunning"
                @click="bwTestMode = 'domestic'"
              >
                <div class="font-semibold">多源大厂 CDN 混压（推荐）</div>
                <div class="mt-0.5 text-[11px] text-slate-400">同时并发拉取阿里云/腾讯/微软/百度等多源叠加测千兆</div>
              </button>
              <button
                type="button"
                :class="[
                  'rounded-xl border p-3 text-left transition-all',
                  bwTestMode === 'direct'
                    ? 'border-[#0A84FF] bg-[#0A84FF]/15 text-white'
                    : 'border-white/10 bg-white/[0.04] text-slate-300 hover:bg-white/[0.08]',
                ]"
                :disabled="bwTestRunning"
                @click="bwTestMode = 'direct'"
              >
                <div class="font-semibold">当前测速源直连</div>
                <div class="mt-0.5 text-[11px] text-slate-400">测本地直连当前测速服务器（如 Cloudflare）上限</div>
              </button>
            </div>
            <div class="pt-1">
              <Input
                v-model="bwTestCustomUrl"
                type="url"
                placeholder="自定义高带宽直连测速链接（可选，留空则使用上方多源混压）"
                :disabled="bwTestRunning"
              />
            </div>
          </div>

          <div v-if="bwTestRunning" class="flex items-center justify-center gap-2.5 rounded-xl border border-[#0A84FF]/30 bg-[#0A84FF]/10 py-6 text-sky-100">
            <Icon icon="mdi:loading" class="h-5 w-5 animate-spin text-[#64D2FF]" />
            <span>正在执行 4 路并发直连压测（约 5.5 秒），请稍候...</span>
          </div>

          <div v-else-if="bwTestError" class="rounded-xl border border-rose-400/35 bg-rose-500/10 p-3 text-rose-200">
            {{ bwTestError }}
          </div>

          <div v-else-if="bwTestResult" class="space-y-3 rounded-xl border border-emerald-400/30 bg-emerald-500/10 p-4">
            <div class="grid grid-cols-3 gap-3 text-center">
              <div>
                <div class="text-[11px] text-slate-400">实测峰值速率</div>
                <div class="mt-1 font-mono text-lg font-bold text-[#30D158]">
                  {{ bwTestResult.peakMBps }} MB/s
                </div>
                <div class="text-[11px] text-[#64D2FF]">≈ {{ bwTestResult.peakMbps }} Mbps</div>
              </div>
              <div>
                <div class="text-[11px] text-slate-400">稳态均速</div>
                <div class="mt-1 font-mono text-lg font-bold text-slate-100">
                  {{ bwTestResult.steadyMBps }} MB/s
                </div>
                <div class="text-[11px] text-slate-400">耗时 {{ (bwTestResult.durationMs / 1000).toFixed(1) }}s</div>
              </div>
              <div>
                <div class="text-[11px] text-slate-400">推荐上限 (90%)</div>
                <div class="mt-1 font-mono text-lg font-bold text-[#64D2FF]">
                  {{ bwTestResult.recommendedMBps }} MB/s
                </div>
                <div class="text-[11px] text-slate-400">预留 10% 日常余量</div>
              </div>
            </div>
            <div class="truncate border-t border-white/10 pt-2 text-[11px] text-slate-400" :title="bwTestResult.usedUrl">
              测速节点: {{ bwTestResult.usedUrl }} · 消耗流量 {{ formatBytes(bwTestResult.totalBytes) }}
            </div>
          </div>

          <div class="flex flex-wrap items-center justify-end gap-2 border-t border-white/10 pt-3">
            <Button variant="ghost" size="sm" :disabled="bwTestRunning" @click="bwTestModalOpen = false">关闭</Button>
            <Button size="sm" :disabled="bwTestRunning" @click="runLocalBandwidthTest">
              <Icon icon="mdi:play" class="h-4 w-4" />
              <span>{{ bwTestResult ? '重新压测' : '开始 5 秒压测' }}</span>
            </Button>
            <template v-if="bwTestResult && !bwTestRunning">
              <Button size="sm" @click="applyTestedBandwidth(bwTestResult.peakMBps)">
                <span>设为实测峰值 ({{ bwTestResult.peakMBps }})</span>
              </Button>
              <Button variant="primary" size="sm" @click="applyTestedBandwidth(bwTestResult.recommendedMBps)">
                <Icon icon="mdi:check" class="h-4 w-4" />
                <span>设为推荐上限 ({{ bwTestResult.recommendedMBps }})</span>
              </Button>
            </template>
          </div>
        </div>
      </Dialog>

      <!-- 测速中途宽带余量动态扩容悬浮弹窗 -->
      <Transition name="toast-slide">
        <div
          v-if="running && bandwidthNotice?.level === 'suggest-up' && bandwidthNotice?.recommendedThreads > 0 && !dismissedSuggestUpModal"
          class="fixed bottom-20 right-6 z-50 w-80 rounded-2xl border border-[#0A84FF]/45 bg-slate-900/95 p-4 text-xs text-slate-100 shadow-2xl backdrop-blur-2xl"
        >
        <div class="flex items-start justify-between gap-2">
          <div class="flex items-center gap-2 font-semibold text-[#64D2FF]">
            <Icon icon="mdi:rocket-launch-outline" class="h-4 w-4 shrink-0" />
            <span>监测到宽带仍有剩余性能</span>
          </div>
          <button
            type="button"
            class="rounded p-0.5 text-slate-400 transition-colors hover:bg-white/10 hover:text-slate-200"
            title="暂不调整"
            @click="dismissedSuggestUpModal = true"
          >
            <Icon icon="mdi:close" class="h-4 w-4" />
          </button>
        </div>

        <div class="mt-2.5 space-y-1.5 text-slate-300 leading-relaxed">
          <div>
            当前最高峰 <span class="font-mono font-semibold text-[#30D158]">{{ peakBandwidthMBps.toFixed(1) }} MB/s</span>
            <span v-if="settings.maxBandwidthMBps > 0">
              / 上限 {{ settings.maxBandwidthMBps }} MB/s（余量约
              <span class="font-mono font-semibold text-[#64D2FF]">{{ Math.max(0, Math.round((1 - (bandwidthNotice.usageRatio || 0)) * 100)) }}%</span>）
            </span>
          </div>
          <div>
            还有 <span class="font-mono font-semibold text-white">{{ bandwidthNotice.remaining || Math.max(0, total - completed) }}</span> 个待测节点，建议将并发从
            <span class="font-mono font-semibold text-white">{{ settings.concurrency }}</span> 线程提升至
            <span class="font-mono font-semibold text-[#64D2FF]">{{ bandwidthNotice.recommendedThreads }}</span> 线程加速完成。
          </div>
        </div>

        <div class="mt-3.5 flex items-center justify-end gap-2">
          <Button size="sm" variant="ghost" @click="dismissedSuggestUpModal = true">暂不调整</Button>
          <Button
            size="sm"
            variant="primary"
            :disabled="scalingConcurrency"
            @click="applyRecommendedThreads(bandwidthNotice.recommendedThreads)"
          >
            <Icon icon="mdi:trending-up" class="h-3.5 w-3.5" />
            <span>{{ scalingConcurrency ? '扩容中...' : `立即扩容至 ${bandwidthNotice.recommendedThreads} 线程` }}</span>
          </Button>
        </div>
        </div>
      </Transition>

      <!-- Toast 提示 -->
      <Transition name="toast-slide">
        <div
          v-if="toast"
          class="fixed bottom-6 right-6 z-50 flex items-center gap-2 rounded-xl border border-white/20 bg-slate-900/85 px-4 py-3 text-xs font-medium text-slate-100 shadow-2xl backdrop-blur-2xl"
        >
          <Icon :icon="toast.icon" class="h-4 w-4 text-[#0A84FF]" />
          <span>{{ toast.message }}</span>
        </div>
      </Transition>
    </div>
  </TooltipProvider>
</template>
