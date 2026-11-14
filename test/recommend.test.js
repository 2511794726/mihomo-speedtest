import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSceneRecommendations } from '../web/src/lib/recommend.js';

test('buildSceneRecommendations picks optimal node per scenario and ignores failed nodes', () => {
  const sample = [
    {
      name: 'Fake-IPLC-LowLat',
      status: 'Download Failed',
      latencyMs: 12,
      avgSpeedMBps: 0,
      steadySpeedMBps: 0,
      valueScore: 0,
      multiplier: 1,
    },
    {
      name: 'HK-Gaming-LowLat',
      status: 'OK',
      latencyMs: 42,
      avgSpeedMBps: 3.5,
      steadySpeedMBps: 3.2,
      valueScore: 3.5,
      multiplier: 1,
    },
    {
      name: 'JP-4K-Steady',
      status: 'OK',
      latencyMs: 120,
      avgSpeedMBps: 7.0,
      steadySpeedMBps: 10.5,
      valueScore: 7.0,
      multiplier: 1,
    },
    {
      name: 'US-Fast-Avg',
      status: 'OK',
      latencyMs: 180,
      avgSpeedMBps: 9.8,
      steadySpeedMBps: 7.5,
      valueScore: 9.8,
      multiplier: 1,
    },
    {
      name: 'TW-Budget-0.3x',
      status: 'OK',
      latencyMs: 95,
      avgSpeedMBps: 4.5,
      steadySpeedMBps: 4.8,
      valueScore: 15.0,
      multiplier: 0.3,
    },
  ];

  const recs = buildSceneRecommendations(sample);
  const byId = Object.fromEntries(recs.map((r) => [r.id, r]));

  assert.equal(byId.video.node.name, 'JP-4K-Steady');
  assert.equal(byId.download.node.name, 'US-Fast-Avg');
  assert.equal(byId.gaming.node.name, 'HK-Gaming-LowLat');
  assert.equal(byId.value.node.name, 'TW-Budget-0.3x');
  assert.equal(byId.chat.node.name, 'HK-Gaming-LowLat');
  assert.ok(byId.ai.node && byId.ai.node.name !== 'HK-Gaming-LowLat');
  assert.ok(byId.tiktok.node && byId.tiktok.node.name !== 'HK-Gaming-LowLat');
  assert.ok(byId.social.node);
});
