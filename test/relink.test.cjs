'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { smartDefaults } = require('../src/ui/narration-trim.js');
const { saveProject, loadProject, restoreLocatedEdits } = require('../src/project-format.cjs');
const { locateMissing } = require('../src/relink.cjs');
const { inspectAsset } = require('../src/media.cjs');
const { fixtures } = require('./fixtures.cjs');

test('moves a folder, saves offline, relinks by name and size, then opens a new and a legacy project', async (t) => {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'jiajian-relink-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const before = path.join(root, '原素材'),
    after = path.join(root, '新素材');
  await fs.mkdir(before);
  const files = await fixtures(before);
  const config = {
    shots: [[{ id: 'video', start: 0.1, end: 1.2 }]],
    ratio: '9:16',
    resolution: 720,
    fps: 30,
    fit: 'fill',
    keepAudio: false,
    unordered: false,
    useOriginal: true,
    useMirrors: false,
    musicIds: ['audio'],
    musicVolume: 20,
    narrationTrim: smartDefaults,
    count: 1,
  };
  const catalog = new Map([
    ['video', await inspectAsset(files.red, 'video')],
    ['audio', await inspectAsset(files.music, 'audio')],
  ]);
  const project = path.join(root, '新工程.jiajian'),
    legacy = path.join(root, '旧工程.sdworkbench');
  await saveProject(project, config, catalog);
  assert.equal(JSON.parse(await fs.readFile(project)).version, 5);
  await fs.rename(before, after);
  const offline = await loadProject(project, undefined, undefined, undefined, { allowMissing: true });
  assert.ok([...offline.assets.values()].every((a) => a.missing));
  assert.deepEqual(offline.config, config);
  await saveProject(legacy, config, offline.assets);
  const saved = JSON.parse(await fs.readFile(legacy));
  assert.equal(saved.version, 5);
  await fs.writeFile(legacy, JSON.stringify({...saved, version: 1}));
  assert.ok(saved.assets.every((a) => a.size > 0 && a.duration > 0));
  const dup = path.join(after, '同名');
  await fs.mkdir(dup);
  const extra = path.join(dup, path.basename(files.red));
  await fs.copyFile(path.join(after, path.basename(files.red)), extra);
  assert.equal((await locateMissing(after, offline.assets, inspectAsset)).has('video'), false);
  await fs.writeFile(extra, '尺寸不同');
  const located = await locateMissing(after, offline.assets, inspectAsset);
  assert.equal(located.size, 2);
  await saveProject(legacy, config, located, { overwrite: true });
  const recovered = await loadProject(legacy);
  assert.equal(recovered.assets.get('video').path, path.join(after, path.basename(files.red)));
  assert.deepEqual(recovered.config, config);
  const recipe = { id: 'video', ranges: [{ start: 0.2, end: 0.8, mirror: true }] };
  const cutConfig = { ...config, shots: [[{ id: 'cut', start: 0, end: 0.6, sourceEdit: recipe }]] };
  const missingCut = new Map([...offline.assets, ['cut', { missing: true, kind: 'video' }]]);
  await restoreLocatedEdits(cutConfig, missingCut, located, path.join(root, '重建剪辑'), inspectAsset);
  assert.ok(Math.abs(located.get('cut').duration - 0.6) < 0.05);
  assert.notEqual(located.get('cut').path, located.get('video').path);
});
