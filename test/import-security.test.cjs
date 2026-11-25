'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises'),
  os = require('node:os'),
  path = require('node:path');
const { readSubtitles } = require('../src/subtitles.cjs');
const { readProject } = require('../src/project-format.cjs');
const { normalizeCloudTtsBaseUrl } = require('../src/cloud-tts.cjs');
const { planMontage, inspectAsset, exportBatch } = require('../src/media.cjs');
const { ffmpeg } = require('./fixtures.cjs');

test('cloud endpoints require HTTPS by default, including loopback', (t) => {
  const previous = process.env.JIAJIAN_TEST_LOOPBACK;
  delete process.env.JIAJIAN_TEST_LOOPBACK;
  t.after(() => {
    if (previous !== undefined) process.env.JIAJIAN_TEST_LOOPBACK = previous;
  });
  assert.throws(() => normalizeCloudTtsBaseUrl('http://127.0.0.1:8123'), /HTTPS/);
  assert.throws(() => normalizeCloudTtsBaseUrl('http://example.test'), /HTTPS/);
  assert.equal(normalizeCloudTtsBaseUrl('https://example.test'), 'https://example.test/');
});

test('bounded UTF-8 imports and FFmpeg render ordinary punctuation from long Chinese paths', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jiajian-import-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const folder = path.join(root, ...Array(8).fill('分镜一 产品说明 和资料归档'.repeat(2)));
  await fs.mkdir(folder, { recursive: true });
  const srt = path.join(folder, "说明 100%, [A]'版.srt");
  const project = path.join(root, '旧工程.sdworkbench');
  for (const [file, reader, size] of [
    [srt, readSubtitles, 256 * 1024],
    [project, readProject, 1024 * 1024],
  ]) {
    await fs.writeFile(file, Buffer.alloc(size + 1, 32));
    await assert.rejects(reader(file), /上限|超过|KiB|MiB/);
    await fs.writeFile(file, Buffer.from([0xc3, 0x28]));
    await assert.rejects(reader(file), /编码|无效|损坏/);
  }
  const title = "新品: 100%, [A] '水洗' \\ 说明";
  await fs.writeFile(srt, '1\n00:00:00,000 --> 00:00:00,500\n' + title + '\n');
  const subtitles = await readSubtitles(srt);
  assert.equal(subtitles.cues[0].text, title);
  const video = path.join(folder, "蓝色 100%, [A]'版.mp4");
  await ffmpeg(['-f', 'lavfi', '-i', 'color=blue:s=128x72:r=24:d=0.7', '-c:v', 'libx264', '-threads', '1', video]);
  const asset = await inspectAsset(video, 'video'),
    catalog = new Map([['v', asset]]);
  const config = {
    shots: [[{ id: 'v', start: 0, end: 0.6, videoSubtitles: subtitles }]],
    ratio: '16:9',
    resolution: 720,
    fps: 24,
    fit: 'fill',
    keepAudio: false,
    unordered: false,
    useOriginal: true,
    useMirrors: false,
    musicIds: [],
    musicVolume: 20,
    count: 1,
    cover: { mode: 'library', active: 0, items: [{ id: 'v', time: 0, title }] },
  };
  const result = await exportBatch(
    planMontage(config, catalog, () => 0),
    root,
  );
  assert.deepEqual(result.failures, []);
  assert.ok((await inspectAsset(result.results[0].path, 'video')).duration > 0.5);
});
