'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { formatSubtitles, normalizeSubtitles, readSubtitles } = require('../src/subtitles.cjs');

async function subtitleFile(t, filename = '本地字幕.srt') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sd-subtitles-test-'));
  const file = path.join(directory, filename);
  t.after(async () => {
    await fs.rm(file, { force: true });
    await fs.rmdir(directory);
  });
  return file;
}

test('loads a UTF-8 BOM and Windows line endings and retains multiline Chinese subtitles', async (t) => {
  const file = await subtitleFile(t);
  await fs.writeFile(file, '\uFEFF1\r\n00:00:00,125 --> 00:00:02,000\r\n第一\u0000行\r\n第二行\r\n \t\r\n2\r\n00:01:02,003 --> 00:01:02,500\r\n后续\u007F。');
  const track = await readSubtitles(file);
  assert.deepEqual(track, {
    name: '本地字幕.srt',
    cues: [{ start: 125, end: 2000, text: '第一行\n第二行' }, { start: 62003, end: 62500, text: '后续。' }],
  });
  const formatted = formatSubtitles(track);
  assert.match(formatted, /00:01:02,003 --> 00:01:02,500\n后续。/);
  await fs.writeFile(file, formatted);
  assert.deepEqual(await readSubtitles(file), track);
});

test('rejects malformed numbering, time and text as well as invalid UTF-8', async (t) => {
  const file = await subtitleFile(t);
  for (const [contents, error] of [
    ['2\n00:00:00,000 --> 00:00:01,000\n字', /编号须从 1/],
    ['1\n00:00:00,000 -> 00:00:01,000\n字', /有效的时间行/],
    ['1\n00:00:00,001 --> 00:00:00,001\n字', /起止时间无效/],
    ['1\n00:00:00,000 --> 00:60:00,000\n字', /起止时间无效/],
    ['1\n00:00:00,000 --> 00:00:01,000\n\u0000', /缺少文本/],
    [Buffer.from([0xff, 0xfe, 0x31]), /UTF-8/],
  ]) {
    await fs.writeFile(file, contents);
    await assert.rejects(readSubtitles(file), error);
  }
  await assert.rejects(readSubtitles('relative.srt'), /请选择本地的/);
});

test('validates inline track data and bounds both cue count and serialized UTF-8 bytes', async (t) => {
  const file = await subtitleFile(t);
  const cue = { start: 0, end: 100, text: '字' };
  const track = { name: '字幕', cues: [cue] };
  assert.equal(normalizeSubtitles(undefined), null);
  assert.equal(formatSubtitles(null), '');
  assert.throws(() => normalizeSubtitles({ ...track, cues: [{ ...cue, end: 0.1 }] }), /起止时间无效/);
  assert.throws(() => normalizeSubtitles({ ...track, cues: [{ ...cue, text: '字\n\n内容' }] }), /含有空行/);
  assert.throws(() => normalizeSubtitles({ ...track, cues: Array(2001).fill(cue) }), /2000/);
  assert.throws(() => formatSubtitles({ ...track, cues: [{ ...cue, text: '字'.repeat(100_000) }] }), /256 KiB/);
  await fs.writeFile(file, Buffer.alloc(256 * 1024 + 1, 32));
  await assert.rejects(readSubtitles(file), /256 KiB/);
});
