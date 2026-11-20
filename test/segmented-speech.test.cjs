'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { alignScript, synthesizeSegmented } = require('../src/segmented-speech.cjs');
const { ffmpeg } = require('./fixtures.cjs');

test('identical lines consume successive timestamps and retain punctuation and pauses', () => {
  const lines = ['出发！', '出发。'];
  const cues = [{ text: '出发', start: 150, end: 400 }, { text: '出发', start: 800, end: 1240 }];
  assert.deepEqual(alignScript(lines, cues, 1800), [
    { start: 0, end: 600, cues: [{ start: 150, end: 400, text: lines[0] }] },
    { start: 600, end: 1800, cues: [{ start: 200, end: 640, text: lines[1] }] },
  ]);
  assert.equal(alignScript(lines, [cues[0]], 1800), undefined);
  assert.equal(alignScript(lines, cues.toReversed(), 1800), undefined);
});

test('a cue spanning a seam needs corresponding acoustic evidence', () => {
  const lines = ['左侧。', '右侧。'];
  const coarse = [{ start: 0, end: 1200, text: '左侧右侧' }];
  assert.equal(alignScript(lines, coarse, 1300), undefined);
  assert.equal(alignScript(lines, coarse, 1300, [{ start: 40, end: 130 }]), undefined);
  assert.equal(alignScript(lines, coarse, 1300, [{ start: 400, end: 600 }])[0].end, 500);
});

test('one request creates two lossless parts using offline timing and preserves sparse shot indexes', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'jiajian-segmented-speech-'));
  t.after(async () => {
    assert.equal(path.dirname(base), os.tmpdir());
    await fs.rm(base, { recursive: true, force: true });
  });
  const directory = path.join(base, 'voice'), original = path.join(base, 'original.wav');
  await ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000:duration=0.53',
    '-f', 'lavfi', '-i', 'sine=frequency=790:sample_rate=48000:duration=0.67',
    '-filter_complex', '[0:a][1:a]concat=n=2:v=0:a=1', original]);
  const jobs = [{ text: '向左', index: 1, voiceId: 'voice' }, { text: '向右', index: 5, voiceId: 'voice' }];
  let calls = 0, recognitions = 0;
  const options = { directory, jobs, speed: 1, volume: 100, signal: new AbortController().signal, progress() {},
    provider: { status: () => ({}), async synthesize({ text, enableSubtitles }) {
      calls++;
      assert.equal(enableSubtitles, true);
      assert.equal(text, '向左\n向右');
      return { path: original };
    } },
    async recognize() {
      recognitions++;
      return { cues: [{ text: '向左', start: 20, end: 500 }, { text: '向右', start: 560, end: 1100 }] };
    },
  };
  const results = await synthesizeSegmented(options);
  assert.equal(calls, 1);
  assert.equal(recognitions, 1);
  assert.deepEqual(results.map(row => [row.index, row.asset.duration]), [[1, 0.53], [5, 0.67]]);
  const pcm = file => ffmpeg(['-i', file, '-map', '0:a:0', '-f', 's16le', '-']);
  assert.deepEqual(Buffer.concat(await Promise.all(results.map(row => pcm(row.asset.path)))), await pcm(original));
  const existing = await fs.readdir(directory);
  const controller = new AbortController();
  await assert.rejects(synthesizeSegmented({ ...options, signal: controller.signal, progress(_phase, completed) {
    if (completed === 1) controller.abort();
  } }), { name: 'AbortError' });
  assert.deepEqual(await fs.readdir(directory), existing);
  await assert.rejects(synthesizeSegmented({ ...options, jobs: [{ ...jobs[0], text: '字'.repeat(499) }, jobs[1]] }), /整篇台词超过/);
  assert.equal(calls, 2);
});
