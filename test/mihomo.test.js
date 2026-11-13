import test from 'node:test';
import assert from 'node:assert/strict';
import { extractMultiplier, filterAndNormalizeProxies } from '../src/mihomo.js';

test('TC-FLT-03: extractMultiplier parses various multiplier formats', () => {
  assert.equal(extractMultiplier('香港01 | 2x'), 2.0);
  assert.equal(extractMultiplier('日本 [0.5X]'), 0.5);
  assert.equal(extractMultiplier('新加坡 1.5倍'), 1.5);
  assert.equal(extractMultiplier('美国直连'), 1.0);
});

test('TC-FLT-01 & TC-FLT-02: filterAndNormalizeProxies keeps only allowed protocols and excludes keywords', () => {
  const proxiesMap = {
    GLOBAL: { name: 'GLOBAL', type: 'Selector' },
    Auto: { name: 'Auto', type: 'URLTest' },
    DIRECT: { name: 'DIRECT', type: 'Direct' },
    REJECT: { name: 'REJECT', type: 'Reject' },
    Info: { name: '剩余流量：100GB', type: 'Shadowsocks' },
    Expired: { name: '套餐到期：2026-12-31', type: 'Vmess' },
    HK: { name: '香港01 | 2x', type: 'AnyTLS' },
    JP: { name: '日本02', type: 'Hysteria2' },
    US: { name: '美国03 [0.5X]', type: 'VLESS' },
  };

  const filtered = filterAndNormalizeProxies(proxiesMap, ['剩余流量', '套餐到期']);
  assert.equal(filtered.length, 3);
  assert.deepEqual(
    filtered.map((n) => ({ name: n.name, multiplier: n.multiplier })),
    [
      { name: '香港01 | 2x', multiplier: 2.0 },
      { name: '日本02', multiplier: 1.0 },
      { name: '美国03 [0.5X]', multiplier: 0.5 },
    ],
  );
});

test('filterAndNormalizeProxies supports includeRegions & includeKeywords with excludeKeywords priority', () => {
  const proxiesMap = {
    InfoHK: { name: '香港剩余流量 10GB', type: 'AnyTLS' },
    HK1: { name: '🇭🇰 HK-01 IPLC', type: 'AnyTLS' },
    JP1: { name: 'Tokyo-01', type: 'VLESS' },
    TW1: { name: '台湾家宽', type: 'VLESS' },
    RU1: { name: 'Russia-01', type: 'Shadowsocks' },
  };

  // 只测香港与日本，应排除 InfoHK、TW1、RU1
  const hkJp = filterAndNormalizeProxies(proxiesMap, ['剩余流量'], {
    includeRegions: ['HK', 'JP'],
    includeKeywords: [],
  });
  assert.deepEqual(
    hkJp.map((n) => n.name),
    ['🇭🇰 HK-01 IPLC', 'Tokyo-01'],
  );

  // 测试 US 不会误匹配 Russia-01
  const usOnly = filterAndNormalizeProxies(proxiesMap, ['剩余流量'], {
    includeRegions: ['US'],
    includeKeywords: ['家宽'],
  });
  assert.deepEqual(
    usOnly.map((n) => n.name),
    ['台湾家宽'],
  );

  // 测试按大洲筛选 (ASIA)
  const asiaOnly = filterAndNormalizeProxies(proxiesMap, ['剩余流量'], {
    includeRegions: ['ASIA'],
    includeKeywords: [],
  });
  assert.deepEqual(
    asiaOnly.map((n) => n.name),
    ['🇭🇰 HK-01 IPLC', 'Tokyo-01', '台湾家宽'],
  );

  // 测试自定义 regionKeywords 覆盖默认地区关键字
  const customHk = filterAndNormalizeProxies(proxiesMap, ['剩余流量'], {
    includeRegions: ['HK'],
    includeKeywords: [],
    regionKeywords: { HK: ['家宽'] },
  });
  assert.deepEqual(
    customHk.map((n) => n.name),
    ['台湾家宽'],
  );
});
