import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { findAvailablePort, ensureMihomoBinary } from '../src/preflight.js';

test('TC-PRE-01: findAvailablePort skips occupied port and increments by 1', async () => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const occupiedPort = server.address().port;

  try {
    const available = await findAvailablePort(occupiedPort);
    assert.ok(available > occupiedPort, `Expected port > ${occupiedPort}, got ${available}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('TC-PRE-02: ensureMihomoBinary copies from first existing candidate and errors if none exist', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mihomo-pre-'));
  try {
    const candidate = path.join(tmpDir, 'source-mihomo.exe');
    const target = path.join(tmpDir, 'bin', 'mihomo.exe');
    await fs.writeFile(candidate, 'dummy-binary', 'utf8');

    const res = await ensureMihomoBinary(
      target,
      [path.join(tmpDir, 'missing.exe'), candidate],
      { copyToTarget: true },
    );
    assert.equal(res.path, target);
    assert.equal(res.copiedFrom, candidate);
    const content = await fs.readFile(target, 'utf8');
    assert.equal(content, 'dummy-binary');

    // 第二次调用应直接命中目标
    const res2 = await ensureMihomoBinary(target, []);
    assert.equal(res2.copiedFrom, null);

    // 均不存在时抛出明确中文错误
    await assert.rejects(
      () => ensureMihomoBinary(path.join(tmpDir, 'none', 'mihomo.exe'), [path.join(tmpDir, 'nope.exe')]),
      /未找到 Mihomo 内核/,
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
