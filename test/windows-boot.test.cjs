'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createPerformanceCache } = require('../src/performance-cache.cjs');
const { readBootIdentity } = require('../src/boot-identity.cjs');

async function temp(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jiajian-boot-event-'));
  t.after(async () => {
    assert.equal(path.dirname(directory), os.tmpdir());
    await fs.rm(directory, { recursive: true, force: true });
  });
  return directory;
}

test('same Windows boot skips preload after a clock correction, a new fast startup scans again', async t => {
  const directory = await temp(t);
  let event = '12@2026-01-01T00:00:00Z', time = 10000, scans = 0;
  const reopen = () => createPerformanceCache(directory, { bootTime: async () => ({ event, time }) });
  async function* refs() { scans++; }
  assert.equal(await reopen().preload(refs), true);
  time += 90000;
  assert.equal(await reopen().preload(refs), false, '校时后同一开机事件应继续复用');
  event = '37@2026-01-02T05:30:00Z';
  assert.equal(await reopen().preload(refs), true, '快速启动即使沿用内核运行时长也应重新预载');
  assert.equal(scans, 2);
});

test('legacy drafts keep proxies even when new drafts default to no proxy', async t => {
  const directory = await temp(t);
  const asset = path.join(directory, 'old.mp4'), disabled = path.join(directory, 'disabled.mp4');
  await Promise.all([asset, disabled].map(file => fs.writeFile(file, 'source')));
  const encoded = [];
  const cache = createPerformanceCache(directory, {
    bootTime: () => 10,
    inspect: async file => ({ kind: 'video', path: file, duration: 1, width: 1400, height: 1000 }),
    thumbnail: async () => Buffer.from('poster'),
    encode: async (video, dest) => { encoded.push(video.path); await fs.writeFile(dest, 'proxy'); },
  });
  await cache.change({ defaultProxy: false });
  await cache.preload(async function* () {
    yield { path: asset, kind: 'video' };
    yield { path: disabled, kind: 'video', proxyEnabled: false };
  });
  assert.deepEqual(encoded, [asset]);
  cache.close();
});

test('unavailable Windows event logs fall back to uptime and legacy markers migrate when the event returns', async t => {
  const directory = await temp(t), estimate = () => 15000;
  const cache = readEvent => createPerformanceCache(directory, {
    bootTime: () => readBootIdentity({ platform: 'win32', estimate, readEvent }),
  });
  let scans = 0;
  async function* refs() { scans++; }
  const denied = async () => { throw new Error('Access denied'); };
  const event = '25@2026-05-12T07:00:00Z';
  assert.equal(await cache(denied).preload(refs), true);
  assert.equal(await cache(async () => undefined).preload(refs), false);
  assert.equal(await cache(async () => event).preload(refs), false);
  const marker = path.join(directory, 'material-cache-v1', 'last-boot.json');
  assert.deepEqual(JSON.parse(await fs.readFile(marker, 'utf8')), { event, time: 15000 });
  assert.equal(await cache(denied).preload(refs), false);
  assert.equal(scans, 1);
});

test('clearing before the scheduled preload marks the current asynchronous boot identity', async t => {
  const directory = await temp(t);
  const cache = createPerformanceCache(directory, { bootTime: async () => ({ event: '47@2026-01-03T05:00:00Z', time: 45000 }) });
  await cache.clear();
  assert.equal(await cache.preload(async function* () { assert.fail('清理后本次启动应跳过预载'); }), false);
  cache.close();
});
