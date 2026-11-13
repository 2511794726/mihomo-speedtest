import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { Agent } from 'undici';
import { runStreamDownloadTest, runSerialSpeedTests } from '../src/tester.js';

/**
 * 创建一个简单的本地 HTTP Forward Proxy（支持普通 HTTP 转发与 CONNECT 隧道）。
 */
function startMockForwardProxy() {
  const server = http.createServer((clientReq, clientRes) => {
    const targetUrl = new URL(clientReq.url);
    const proxyReq = http.request(
      {
        hostname: targetUrl.hostname,
        port: targetUrl.port,
        path: targetUrl.pathname + targetUrl.search,
        method: clientReq.method,
        headers: clientReq.headers,
      },
      (proxyRes) => {
        clientRes.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(clientRes);
      },
    );
    proxyReq.on('error', (err) => {
      if (!clientRes.headersSent) clientRes.writeHead(502);
      clientRes.end(err.message);
    });
    clientReq.pipe(proxyReq);
  });

  server.on('connect', (req, clientSocket, head) => {
    const [host, portStr] = req.url.split(':');
    const targetSocket = net.connect(Number(portStr) || 80, host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) targetSocket.write(head);
      targetSocket.pipe(clientSocket);
      clientSocket.pipe(targetSocket);
    });
    targetSocket.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => targetSocket.destroy());
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

test('TC-TST-02, 03, 04, 05, 06: Stream download steady speed, cap abort, >512KB timeout, <512KB reset & env isolation', async () => {
  const proxy = await startMockForwardProxy();
  const targetServer = http.createServer((req, res) => {
    if (req.url === '/steady') {
      // 持续 2.2s 输出数据，验证稳态速率计算
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      const chunk = Buffer.alloc(64 * 1024, 0x61);
      let count = 0;
      const timer = setInterval(() => {
        if (res.destroyed) {
          clearInterval(timer);
          return;
        }
        res.write(chunk);
        count += 1;
        if (count >= 22) {
          clearInterval(timer);
          res.end();
        }
      }, 100);
      req.on('close', () => clearInterval(timer));
    } else if (req.url === '/cap') {
      // 持续高速吐出最多 5MB，测试 1MB 熔断
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      const chunk = Buffer.alloc(256 * 1024, 0x62);
      let sent = 0;
      const timer = setInterval(() => {
        if (res.destroyed) {
          clearInterval(timer);
          return;
        }
        res.write(chunk);
        sent += chunk.length;
        if (sent >= 5 * 1024 * 1024) {
          clearInterval(timer);
          res.end();
        }
      }, 20);
      req.on('close', () => clearInterval(timer));
    } else if (req.url === '/partial-timeout') {
      // 先发 600KB 然后挂起直到客户端超时
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.write(Buffer.alloc(600 * 1024, 0x63));
    } else if (req.url === '/reset-small') {
      // 发 100KB 后直接销毁连接
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.write(Buffer.alloc(100 * 1024, 0x64));
      setTimeout(() => res.socket?.destroy(), 30);
    }
  });

  await new Promise((resolve) => targetServer.listen(0, '127.0.0.1', resolve));
  const targetPort = targetServer.address().port;

  // TC-TST-06: 注入无效环境变量代理，验证 ProxyAgent 完全隔离不走它
  const prevHttpProxy = process.env.HTTP_PROXY;
  process.env.HTTP_PROXY = 'http://127.0.0.1:59999';

  try {
    // TC-TST-02: 稳态下载
    const steadyRes = await runStreamDownloadTest({
      mixedPort: proxy.port,
      testUrl: `http://127.0.0.1:${targetPort}/steady`,
      maxBytesPerNode: 10 * 1024 * 1024,
      downloadTimeoutMs: 5000,
      multiplier: 2.0,
    });
    assert.equal(steadyRes.ok, true);
    assert.equal(steadyRes.status, 'completed');
    assert.ok(steadyRes.avgSpeedMBps > 0);
    assert.ok(steadyRes.steadySpeedMBps > 0);
    assert.equal(steadyRes.valueScore, Number((steadyRes.avgSpeedMBps / 2.0).toFixed(2)));

    // TC-TST-03: 流量上限熔断
    const capRes = await runStreamDownloadTest({
      mixedPort: proxy.port,
      testUrl: `http://127.0.0.1:${targetPort}/cap`,
      maxBytesPerNode: 1024 * 1024,
      downloadTimeoutMs: 5000,
      multiplier: 1.0,
    });
    assert.equal(capRes.ok, true);
    assert.equal(capRes.status, 'capped');
    assert.ok(capRes.totalBytes >= 1024 * 1024);
    assert.ok(capRes.totalBytes < 2 * 1024 * 1024);

    // TC-TST-04: 超时截断 >512KB 保留成绩
    const partialRes = await runStreamDownloadTest({
      mixedPort: proxy.port,
      testUrl: `http://127.0.0.1:${targetPort}/partial-timeout`,
      maxBytesPerNode: 10 * 1024 * 1024,
      downloadTimeoutMs: 400,
      multiplier: 1.0,
    });
    assert.equal(partialRes.ok, true);
    assert.equal(partialRes.status, 'timeout');
    assert.ok(partialRes.totalBytes > 512 * 1024);
    assert.ok(partialRes.avgSpeedMBps > 0);

    // TC-TST-05: 异常断流 <512KB 判无效
    const resetRes = await runStreamDownloadTest({
      mixedPort: proxy.port,
      testUrl: `http://127.0.0.1:${targetPort}/reset-small`,
      maxBytesPerNode: 10 * 1024 * 1024,
      downloadTimeoutMs: 3000,
      multiplier: 1.0,
    });
    assert.equal(resetRes.ok, false);
    assert.equal(resetRes.avgSpeedMBps, 0);
  } finally {
    if (prevHttpProxy === undefined) {
      delete process.env.HTTP_PROXY;
    } else {
      process.env.HTTP_PROXY = prevHttpProxy;
    }
    await new Promise((resolve) => targetServer.close(resolve));
    await proxy.close();
  }
});

test('TC-TST-01: runSerialSpeedTests skips download when latency check fails', async () => {
  const controllerServer = http.createServer((req, res) => {
    if (req.method === 'PUT' && req.url === '/proxies/GLOBAL') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.url?.includes('/delay')) {
      res.writeHead(504);
      res.end('Gateway Timeout');
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => controllerServer.listen(0, '127.0.0.1', resolve));
  const controllerPort = controllerServer.address().port;
  const dispatcher = new Agent();

  try {
    const results = await runSerialSpeedTests(
      [{ name: 'DeadNode', type: 'VLESS', multiplier: 1.0 }],
      {
        controllerPort,
        controllerSecret: '',
        dispatcher,
        mixedPort: 17890,
        settings: {
          latencyTimeoutMs: 500,
          downloadTimeoutMs: 1000,
          maxBytesPerNode: 1024 * 1024,
          testUrl: 'http://127.0.0.1:1/unreachable',
        },
      },
    );
    assert.equal(results.length, 1);
    assert.equal(results[0].status, 'Dead / Timeout');
    assert.equal(results[0].latencyMs, null);
    assert.equal(results[0].avgSpeedMBps, 0);
  } finally {
    await dispatcher.close();
    await new Promise((resolve) => controllerServer.close(resolve));
  }
});
