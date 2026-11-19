'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { inspectAsset, planMontage } = require('../src/media.cjs');
const { saveProject, loadProject, normalizeScriptModel } = require('../src/project-format.cjs');
const { fixtures } = require('./fixtures.cjs');

async function testDirectory(t) {
  const parent = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(parent, 'sd-project-test-'));
  t.after(async () => {
    const resolved = await fs.realpath(root);
    assert.equal(path.dirname(resolved), parent);
    assert.ok(path.basename(resolved).startsWith('sd-project-test-'));
    await fs.rm(resolved, { force: true, recursive: true });
  });
  return root;
}

function editingConfig(overrides = {}) {
  return {
    shots: [[]], ratio: '9:16', resolution: 1080, fps: 24, fit: 'fill', keepAudio: false,
    unordered: true, useOriginal: true, useMirrors: true, musicIds: [], musicVolume: 47, count: 1,
    ...overrides,
  };
}

test('accepts more than the legacy sixteen shot groups', async (t) => {
  const root = await testDirectory(t);
  const file = path.join(root, 'large-shot-project.sdworkbench');
  const config = editingConfig({ shots: Array.from({ length: 17 }, () => []) });
  await saveProject(file, config, new Map());
  const loaded = await loadProject(file);
  assert.equal(loaded.config.shots.length, 17);
  const script = normalizeScriptModel({
    title: '长脚本', mode: 'segmented', tab: 'narration',
    whole: [{ dialogue: '', note: '' }],
    segmented: Array.from({ length: 17 }, (_, index) => ({ dialogue: `第${index + 1}镜`, note: '' })),
    textGroups: [{ dialogue: '', note: '' }],
  });
  assert.equal(script.segmented.length, 17);
});

test('round-trips a legacy project and restores narration that shares its music asset', async (t) => {
  const root = await testDirectory(t);
  const file = path.join(root, '混剪草稿.sdworkbench');
  const files = await fixtures(root);
  const catalog = new Map(await Promise.all([
    ['red', 'video'], ['blue', 'video'], ['still', 'image'], ['music', 'audio'], ['otherMusic', 'audio'],
  ].map(async ([id, kind]) => [id, await inspectAsset(files[id], kind)])));
  const config = editingConfig({
    shots: [[{ id: 'red', start: 0.2, end: 0.8 }, { id: 'still', start: 0, end: 1.25 }], []],
    musicIds: ['music'],
  });

  await saveProject(file, config, catalog);
  const loaded = await loadProject(file);
  assert.deepEqual(loaded.config, config);
  assert.deepEqual([...loaded.assets.keys()], ['red', 'still', 'music']);
  assert.deepEqual(loaded.assets.get('red'), catalog.get('red'));
  assert.deepEqual(loaded.assets.get('still'), catalog.get('still'));
  assert.deepEqual(loaded.assets.get('music'), catalog.get('music'));
  const [plan] = planMontage({ ...loaded.config, shots: loaded.config.shots.slice(0, 1) }, loaded.assets, () => 0);
  assert.equal(plan.music.path, files.music);
  assert.equal(plan.clips[0].start, 0.2);
  assert.deepEqual(plan.size, [1080, 1920]);

  const withNarration = { ...config, narrationId: 'music', priority: 'voice' };
  await saveProject(file, withNarration, catalog, { overwrite: true });
  const restored = await loadProject(file);
  assert.deepEqual(restored.config, withNarration);
  assert.deepEqual(restored.assets, loaded.assets);

  const segmented = {
    ...withNarration,
    narrationMode: 'segmented',
    segmentNarrationSelection: 'ordered',
    segmentNarrationIds: [[null, 'otherMusic'], ['music']],
    extraWholeTracks: [{
      narrationId: 'otherMusic',
      subtitles: { name: '备选字幕.srt', cues: [{ start: 0, end: 300, text: '另一段口播' }] },
    }],
    generatedCaptions: {
      music: '旧工程纯文本台词',
      otherMusic: { name: '配音字幕', cues: [{ start: 20, end: 300, text: '恢复带时间码的台词' }] },
    },
  };
  await saveProject(file, segmented, catalog, { overwrite: true });
  const restoredSegments = await loadProject(file);
  assert.deepEqual(restoredSegments.config, segmented);
  assert.equal(restoredSegments.assets.get('otherMusic').path, files.otherMusic);
  await assert.rejects(saveProject(file, { ...segmented, segmentNarrationIds: [[]] }, catalog, { overwrite: true }), /数量不匹配/);
});

test('allows empty drafts and atomically rejects unconfirmed same-name saves', async (t) => {
  const root = await testDirectory(t);
  const file = path.join(root, 'draft.sdworkbench');
  const catalog = new Map();
  const original = editingConfig({ shots: [] });
  await saveProject(file, original, catalog);
  const first = await fs.readFile(file, 'utf8');
  await assert.rejects(saveProject(file, editingConfig(), catalog), { code: 'EEXIST' });
  await assert.rejects(saveProject(file, editingConfig({ shots: [[{ id: 'missing', start: 0, end: 1 }]] }), catalog, { overwrite: true }), /缺失/);
  assert.equal(await fs.readFile(file, 'utf8'), first);

  const replacement = editingConfig({ shots: [[], []], narrationId: null, priority: 'voice', script: null });
  await saveProject(file, replacement, catalog, { overwrite: true });
  assert.deepEqual(await loadProject(file), { config: replacement, assets: new Map() });
  assert.deepEqual(await fs.readdir(root), ['draft.sdworkbench']);
});

test('restores script selections and plain text and rejects oversized script data', async (t) => {
  const root = await testDirectory(t);
  const file = path.join(root, '创作脚本.sdworkbench');
  const script = {
    title: '短片脚本',
    mode: 'segmented',
    tab: 'textGroups',
    whole: [{ dialogue: '片头\u0000\r\n片尾', note: '' }],
    segmented: [{ dialogue: '第一镜', note: '补拍' }],
    textGroups: [{ dialogue: '<文字组>', note: '\t保留' }],
  };
  const config = editingConfig({ script });
  await saveProject(file, config, new Map(), { overwrite: true });
  const restored = await loadProject(file);
  assert.deepEqual(restored.config, {
    ...config,
    script: { ...script, whole: [{ dialogue: '片头\n片尾', note: '' }] },
  });

  const row = { dialogue: '界'.repeat(4096), note: '' };
  assert.throws(() => normalizeScriptModel({ ...script, title: '字'.repeat(101) }), /100 字/);
  assert.throws(() => normalizeScriptModel({ ...script, whole: [{ ...row, note: '字'.repeat(4097) }] }), /4096 字/);
  assert.throws(() => normalizeScriptModel({ ...script, whole: Array(251).fill(row) }), /250 行/);
  assert.throws(() => normalizeScriptModel({ ...script, whole: Array(22).fill(row) }), /256 KiB/);
});

test('reports missing media and rejects incompatible or undeclared asset references', async (t) => {
  const root = await testDirectory(t);
  const file = path.join(root, 'broken.sdworkbench');
  const config = editingConfig({ shots: [[{ id: 'clip', start: 0, end: 1 }]] });
  const catalog = new Map([['clip', { kind: 'video', path: path.join(root, '失踪.mp4'), duration: 2 }]]);
  await saveProject(file, config, catalog);
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  await assert.rejects(loadProject(file), /找不到工程素材「失踪.mp4」/);

  await assert.rejects(saveProject(file, { ...config, narrationId: 'missing' }, catalog, { overwrite: true }), /缺失或类型不匹配/);
  await assert.rejects(saveProject(file, { ...config, narrationId: 'clip' }, catalog, { overwrite: true }), /同时作为画面和音频/);
  await fs.writeFile(file, JSON.stringify({ ...saved, config: { ...config, priority: 'unknown' } }));
  await assert.rejects(loadProject(file), /音画优先模式无效/);

  await fs.writeFile(file, JSON.stringify({ ...saved, assets: [...saved.assets, { id: 'extra', kind: 'audio', path: 'C:\\unused.wav' }] }));
  await assert.rejects(loadProject(file), /素材清单与引用不一致/);
  await fs.writeFile(file, JSON.stringify({ ...saved, assets: [{ ...saved.assets[0], path: '../relative.mp4' }] }));
  await assert.rejects(loadProject(file), /缺失或类型不匹配/);
  await fs.writeFile(file, JSON.stringify({ ...saved, version: 2 }));
  await assert.rejects(loadProject(file), /不支持此工程文件格式或版本/);
});

test('bounds manifest input before parsing and rejects damaged JSON', async (t) => {
  const root = await testDirectory(t);
  const file = path.join(root, 'bad.sdworkbench');
  await fs.writeFile(file, ' '.repeat(1024 * 1024 + 1));
  await assert.rejects(loadProject(file), /1 MiB/);
  await fs.writeFile(file, '{');
  await assert.rejects(loadProject(file), /无效或已损坏/);
  await assert.rejects(loadProject('relative.sdworkbench'), /请选择本地的/);
});
