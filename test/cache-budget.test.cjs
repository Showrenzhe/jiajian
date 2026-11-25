'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises'),
  os = require('node:os'),
  path = require('node:path');
const { createCacheBudget } = require('../src/cache-budget.cjs');

test('a shared budget evicts oldest generated entries and clears only recognized cache files', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jiajian-cache-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const meta = path.join(root, 'meta'),
    proxy = path.join(root, 'proxy');
  await Promise.all([fs.mkdir(meta), fs.mkdir(proxy)]);
  const poster = path.join(meta, 'a'.repeat(64) + '.jpg'),
    video = path.join(proxy, 'jj-' + 'b'.repeat(64) + '.mp4');
  const original = path.join(proxy, '用户视频.mp4');
  await Promise.all([fs.writeFile(poster, '12345'), fs.writeFile(video, '123456'), fs.writeFile(original, 'keep')]);
  await fs.utimes(poster, 1, 1);
  const budget = createCacheBudget(meta, 8);
  await budget.track(proxy);
  await assert.rejects(fs.access(poster), { code: 'ENOENT' });
  assert.equal(await budget.bytes(proxy), 6);
  await budget.clear(proxy);
  assert.equal(await budget.bytes(proxy), 0);
  assert.equal(await fs.readFile(original, 'utf8'), 'keep');
});
