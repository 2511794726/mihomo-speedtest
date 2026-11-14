import test from 'node:test';
import assert from 'node:assert/strict';
import { validateClashApiUrl } from '../web/src/lib/vpn.js';

test('validateClashApiUrl validates and normalizes mainstream Clash/Mihomo controller URLs', () => {
  const okVerge = validateClashApiUrl(' http://127.0.0.1:9097/ ');
  assert.equal(okVerge.valid, true);
  assert.equal(okVerge.normalized, 'http://127.0.0.1:9097');

  const okOpenClash = validateClashApiUrl('http://192.168.1.1:9090/ui');
  assert.equal(okOpenClash.valid, true);
  assert.equal(okOpenClash.normalized, 'http://192.168.1.1:9090');

  const badEmpty = validateClashApiUrl('');
  assert.equal(badEmpty.valid, false);

  const badProto = validateClashApiUrl('ftp://127.0.0.1:9090');
  assert.equal(badProto.valid, false);

  const badUrl = validateClashApiUrl('127.0.0.1:9097');
  assert.equal(badUrl.valid, false);
});
