'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { inspectAsset } = require('../src/media.cjs');
const { splitNarration } = require('../src/subs2srs.cjs');
const { ffmpeg } = require('./fixtures.cjs');

test('splits an MP3 into SRT-timed narration segments', async (t) => {
  const parent = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(parent, 'sd-subs2srs-test-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const audio = path.join(root, 'voice.mp3');
  const subtitles = path.join(root, 'voice.srt');
  await ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=660', '-t', '1.2', '-c:a', 'libmp3lame', '-ar', '48000', audio]);
  await fs.writeFile(subtitles, '1\n00:00:00,000 --> 00:00:00,450\n第一句\n\n2\n00:00:00,500 --> 00:00:01,100\n第二句\n', 'utf8');
  const result = await splitNarration({ subtitlePath: subtitles, audioPath: audio, outputDirectory: root });
  assert.equal(result.segments.length, 2);
  assert.deepEqual(result.segments.map(({ text }) => text), ['第一句', '第二句']);
  for (const segment of result.segments) {
    const asset = await inspectAsset(segment.path, 'audio');
    assert.equal(asset.codec, 'mp3');
    assert.ok(asset.duration >= 0.1);
  }
});
