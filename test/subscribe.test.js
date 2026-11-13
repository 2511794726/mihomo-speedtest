import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fetchSubscriptionRaw, buildRuntimeConfig } from '../src/subscribe.js';

test('TC-SUB-01: fetchSubscriptionRaw rotates User-Agent until HTTP 200', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mihomo-sub-'));
  const server = http.createServer((req, res) => {
    if (req.headers['user-agent'] === 'AllowedUA/1.0') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('proxies:\n  - name: Node1\n    type: ss\n');
    } else {
      res.writeHead(403);
      res.end('Forbidden');
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    const rawPath = path.join(tmpDir, 'sub.raw');
    const result = await fetchSubscriptionRaw(
      `http://127.0.0.1:${port}/sub`,
      ['BlockedUA/1', 'BlockedUA/2', 'AllowedUA/1.0'],
      rawPath,
    );

    assert.equal(result.source, 'remote');
    assert.equal(result.usedUserAgent, 'AllowedUA/1.0');
    const saved = await fs.readFile(rawPath, 'utf8');
    assert.match(saved, /Node1/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('TC-SUB-02: buildRuntimeConfig handles Format A (Clash YAML) and forces global/rules/dns', async () => {
  const rawYaml = `
mixed-port: 7890
mode: rule
rules:
  - DOMAIN-SUFFIX,cn,DIRECT
  - MATCH,Proxy
proxies:
  - name: HK-01
    type: vless
    server: 1.2.3.4
    port: 443
`;
  const { format, config, hasProviders } = await buildRuntimeConfig(rawYaml, {
    mixedPort: 17891,
    controllerPort: 19091,
    controllerSecret: 'sec',
    rawUrisPath: 'unused.txt',
  });

  assert.equal(format, 'clash-yaml');
  assert.equal(hasProviders, false);
  assert.equal(config['mixed-port'], 17891);
  assert.equal(config['external-controller'], '127.0.0.1:19091');
  assert.equal(config.secret, 'sec');
  assert.equal(config.mode, 'global');
  assert.deepEqual(config.rules, ['MATCH,GLOBAL']);
  assert.equal(config.dns['enhanced-mode'], 'fake-ip');
  assert.deepEqual(config.dns.nameserver, ['223.5.5.5', '1.1.1.1']);
});

test('TC-SUB-03 & TC-SUB-04: buildRuntimeConfig handles Format B (Standard/URL-Safe Base64 & Plain URIs)', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mihomo-uri-'));
  try {
    const uris = 'vless://uuid@example.com:443#HK-VLESS\nhy2://pass@example.com:443#JP-HY2';
    // URL-safe base64 without padding
    const urlSafeB64 = Buffer.from(uris, 'utf8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    const rawUrisPath = path.join(tmpDir, 'raw-uris.txt');
    const res1 = await buildRuntimeConfig(urlSafeB64, {
      mixedPort: 17890,
      controllerPort: 19090,
      controllerSecret: 's',
      rawUrisPath,
    });

    assert.equal(res1.format, 'uri-list');
    assert.equal(res1.hasProviders, true);
    assert.equal(res1.config['proxy-providers']['sub-uris'].path, './raw-uris.txt');
    assert.deepEqual(res1.config['proxy-groups'][0].use, ['sub-uris']);

    const savedUris = await fs.readFile(rawUrisPath, 'utf8');
    assert.match(savedUris, /vless:\/\//);
    assert.match(savedUris, /hy2:\/\//);

    // Plain URI list
    const res2 = await buildRuntimeConfig(uris, {
      mixedPort: 17890,
      controllerPort: 19090,
      controllerSecret: 's',
      rawUrisPath,
    });
    assert.equal(res2.format, 'uri-list');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('TC-SUB-05: buildRuntimeConfig handles Format C (proxy-providers) and links GLOBAL group', async () => {
  const yamlProviders = `
proxy-providers:
  airport-a:
    type: http
    url: https://example.com/a.yaml
  airport-b:
    type: file
    path: ./b.yaml
`;
  const { format, config, hasProviders } = await buildRuntimeConfig(yamlProviders, {
    mixedPort: 17890,
    controllerPort: 19090,
    controllerSecret: 's',
    rawUrisPath: 'unused.txt',
  });

  assert.equal(format, 'proxy-providers');
  assert.equal(hasProviders, true);
  const globalGroup = config['proxy-groups'].find((g) => g.name === 'GLOBAL');
  assert.ok(globalGroup);
  assert.deepEqual(globalGroup.use, ['airport-a', 'airport-b']);
});
