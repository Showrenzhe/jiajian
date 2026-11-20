'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const { createPerformanceCache } = require('../src/performance-cache.cjs');
const { createDraftStore } = require('../src/draft-store.cjs');
const { inspectAsset } = require('../src/media.cjs');
const { ffmpeg } = require('./fixtures.cjs');

async function setup(t, encode) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jiajian-proxy-queue-'));
  const cache = createPerformanceCache(dir, { encode });
  t.after(async () => { cache.close(); assert.equal(path.dirname(dir), os.tmpdir()); await fs.rm(dir, { recursive: true, force: true }); });
  const assets = await Promise.all(Array.from({ length: 15 }, async (_, i) => {
    const file = path.join(dir, i + '.mp4');
    await fs.writeFile(file, 'fixture');
    return { path: file, kind: 'video', width: 1920, height: 1080 };
  }));
  return { dir, cache, assets };
}

test('fast preview changes keep a bounded encoder queue and produce the latest preview', async t => {
  let concurrent = 0, maximum = 0, started = 0;
  const { cache, assets } = await setup(t, async (_asset, dest) => {
    concurrent++;
    started++;
    maximum = Math.max(maximum, concurrent);
    try { await delay(60); await fs.writeFile(dest, 'proxy'); } finally { concurrent--; }
  });
  const result = await Promise.all(assets.map(asset => cache.proxy(asset)));
  assert.ok(result.at(-1));
  assert.ok(maximum <= 2, '同时编码数为 ' + maximum);
  assert.ok(started <= 3, '快速浏览只应生成最先和最后请求的代理，实际 ' + started);
});

test('clear and changing folders wait for unpublished output and keep cache views consistent', async t => {
  let started, release;
  const began = new Promise(resolve => { started = resolve; });
  const hold = new Promise(resolve => { release = resolve; });
  const { dir, cache, assets } = await setup(t, async (_asset, dest) => {
    started(); await hold; await fs.writeFile(dest, 'proxy');
  });
  const original = cache.settings.location, next = path.join(dir, 'new');
  const first = cache.proxy(assets[0]).catch(() => null);
  await began;
  const clearing = cache.clear();
  const moving = cache.change({ location: next });
  release();
  const [_, cleared, moved] = await Promise.all([first, clearing, moving]);
  assert.equal(cleared.location, original);
  assert.equal(cleared.bytes, 0);
  assert.equal(moved.location, next);
  assert.deepEqual(await fs.readdir(original), []);
  assert.equal(path.dirname(await cache.proxy(assets[1])), next);
});

test('opening an unchanged saved draft after restart reuses imported media metadata', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jiajian-draft-cache-'));
  t.after(async () => { assert.equal(path.dirname(dir), os.tmpdir()); await fs.rm(dir, { recursive: true, force: true }); });
  const media = path.join(dir, 'source.mp4');
  await ffmpeg(['-f', 'lavfi', '-i', 'color=blue:s=160x90:r=24:d=0.5', '-c:v', 'libx264', '-threads', '1', media]);
  let probes = 0;
  const dependencies = { inspect: (...args) => { probes++; return inspectAsset(...args); } };
  let cache = createPerformanceCache(dir, dependencies);
  const project = path.join(dir, 'drafts');
  let drafts = createDraftStore(project, undefined, cache.inspectCached);
  const input = await cache.inspectCached(media, 'video');
  const draft = await drafts.create({ name: '复开', config: { shots: [[{ id: 'clip', start: 0, end: 0.5 }]],
    ratio: '16:9', resolution: 720, fps: 24, fit: 'fit', keepAudio: true, unordered: false, count: 1,
    useOriginal: true, useMirrors: false, musicIds: [], musicVolume: 50 } }, new Map([['clip', input]]));
  cache.close();
  cache = createPerformanceCache(dir, dependencies);
  drafts = createDraftStore(project, undefined, cache.inspectCached);
  try {
    const reopened = await drafts.open(draft.id);
    assert.equal([...reopened.assets.values()][0].path, media);
    assert.equal(probes, 1);
    await fs.utimes(media, new Date(), new Date(Date.now() + 60000));
    await drafts.open(draft.id);
    assert.equal(probes, 2, '素材修改后必须重新读取');
  } finally { cache.close(); }
});
