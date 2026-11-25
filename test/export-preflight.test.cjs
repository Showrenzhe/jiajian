'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { checkExportDirectory, estimatedBytes } = require('../src/export-preflight.cjs');

test('导出预检列出选中组合的离线画面和口播，操作后保留目录内容', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jj-export-check-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const clip = { asset: { path: path.join(root, '画面.mp4') }, narration: { path: path.join(root, '口播.wav') } };
  const plan = { kind: 'montage', clips: [clip], size: [1920, 1080], fps: 30, duration: 60 };
  assert.ok(estimatedBytes(plan) > estimatedBytes({ ...plan, fps: 24 }));
  await assert.rejects(
    checkExportDirectory(root, [plan]),
    (error) => error.message.includes('画面.mp4') && error.message.includes('口播.wav'),
  );
  await Promise.all([clip.asset, clip.narration].map((item) => fs.writeFile(item.path, '1')));
  await checkExportDirectory(root, [plan]);
  assert.deepEqual((await fs.readdir(root)).sort(), ['口播.wav', '画面.mp4'].sort());
  await assert.rejects(checkExportDirectory(clip.asset.path, [plan]), /目录不可写/);
  await assert.rejects(checkExportDirectory(root, [{ ...plan, duration: 1e15 }]), /剩余/);
});
