import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  sortResults,
  saveSpeedRank,
  renderTopTable,
  detectClashVergeSelector,
  applyTopNodeToClashVerge,
  listHistorySnapshots,
  loadHistorySnapshot,
} from '../src/report.js';

test('TC-RPT-01: sortResults, saveSpeedRank and renderTopTable work across sort modes', async () => {
  const sample = [
    {
      name: 'Node-A',
      type: 'VLESS',
      multiplier: 2.0,
      status: 'OK',
      latencyMs: 50,
      avgSpeedMBps: 20.0,
      steadySpeedMBps: 18.0,
      valueScore: 10.0,
    },
    {
      name: 'Node-B',
      type: 'AnyTLS',
      multiplier: 0.5,
      status: 'OK',
      latencyMs: 80,
      avgSpeedMBps: 12.0,
      steadySpeedMBps: 25.0,
      valueScore: 24.0,
    },
  ];

  assert.equal(sortResults(sample, 'avg')[0].name, 'Node-A');
  assert.equal(sortResults(sample, 'steady')[0].name, 'Node-B');
  assert.equal(sortResults(sample, 'value')[0].name, 'Node-B');

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mihomo-rpt-'));
  try {
    const outPath = path.join(tmpDir, 'speed-rank.json');
    const sorted = sortResults(sample, 'avg');
    await saveSpeedRank(sorted, outPath, 'avg');

    const saved = JSON.parse(await fs.readFile(outPath, 'utf8'));
    assert.equal(saved.totalNodes, 2);
    assert.equal(saved.okNodes, 2);
    assert.equal(saved.results[0].name, 'Node-A');

    // 验证 history/ 自动留痕与读取
    const historyDir = path.join(tmpDir, 'history');
    const historyList = await listHistorySnapshots(historyDir);
    assert.equal(historyList.length, 1);
    assert.equal(historyList[0].topNodeName, 'Node-A');
    const loaded = await loadHistorySnapshot(historyDir, historyList[0].id);
    assert.equal(loaded.results.length, 2);

    const tableStr = renderTopTable(sorted, 20);
    assert.match(tableStr, /Node-A/);
    assert.match(tableStr, /Node-B/);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('TC-RPT-02: detectClashVergeSelector & applyTopNodeToClashVerge auto-detect selector and send PUT', async () => {
  const proxiesMap = {
    GLOBAL: { name: 'GLOBAL', type: 'Selector', all: ['Node-Fast'] },
    自动选择: { name: '自动选择', type: 'URLTest', all: ['Node-Fast'] },
    节点选择: { name: '节点选择', type: 'Selector', all: ['Node-Slow', 'Node-Fast'] },
  };

  assert.equal(detectClashVergeSelector(proxiesMap, 'Node-Fast', ''), '节点选择');
  assert.equal(detectClashVergeSelector(proxiesMap, 'Node-Fast', 'GLOBAL'), 'GLOBAL');

  let appliedGroup = null;
  let appliedBody = null;
  const mockApi = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/proxies') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ proxies: proxiesMap }));
      return;
    }
    if (req.method === 'PUT' && req.url?.startsWith('/proxies/')) {
      appliedGroup = decodeURIComponent(req.url.slice('/proxies/'.length));
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        appliedBody = JSON.parse(body);
        res.writeHead(204);
        res.end();
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => mockApi.listen(0, '127.0.0.1', resolve));
  const port = mockApi.address().port;

  try {
    const res = await applyTopNodeToClashVerge('Node-Fast', {
      clashVergeApi: `http://127.0.0.1:${port}`,
      clashVergeSecret: '',
      clashVergeSelector: '',
      autoApplyTopNode: true,
    });
    assert.equal(res.applied, true);
    assert.equal(res.selector, '节点选择');
    assert.equal(appliedGroup, '节点选择');
    assert.deepEqual(appliedBody, { name: 'Node-Fast' });
  } finally {
    await new Promise((resolve) => mockApi.close(resolve));
  }
});
