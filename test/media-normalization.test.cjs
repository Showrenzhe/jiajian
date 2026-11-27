'use strict';

const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { promisify } = require('node:util');
const { mediaTool } = require('../src/media-tool.cjs');
const { inspectAsset, createTrackProxy, exportBatch, supportsHdrToneMap } = require('../src/media.cjs');
const { createPreviewBatch, prepareMontagePlans, selectPreviewPlans } = require('../src/preview-plans.cjs');
const { ffmpeg, normalizationFixture } = require('./fixtures.cjs');

const exec = promisify(execFile);
const fps = 25;
const transfers = { pq: 'smpte2084', hlg: 'arib-std-b67' };
const cornerOrder = {
  silent: ['red', 'lime', 'blue', 'yellow'],
  rotate90: ['lime', 'yellow', 'red', 'blue'],
  rotate270: ['blue', 'red', 'yellow', 'lime'],
  exif: ['blue', 'red', 'yellow', 'lime'],
};

async function probe(file, ...args) {
  const { stdout } = await exec(mediaTool('ffprobe'), ['-v', 'error', ...args, '-of', 'json', file], { windowsHide: true });
  return JSON.parse(stdout);
}

let encoders;
async function missingEncoder(kind) {
  encoders ??= ffmpeg(['-encoders']).then((bytes) => new Set(
    Array.from(bytes.toString().matchAll(/^\s*[VAS][A-Z.]{5}\s+(\S+)/gm), (match) => match[1])
  ));
  const available = await encoders;
  const required = ['libx264', 'aac', ...(kind === 'exif' ? ['mjpeg'] : [])];
  const missing = required.filter((name) => !available.has(name));
  if (missing.length) return '当前 FFmpeg 缺少编码器 ' + missing.join(', ');
  if (transfers[kind]) {
    const help = await ffmpeg(['-h', 'encoder=libx264']);
    if (!help.toString().includes('yuv420p10le')) return '当前 libx264 编码器不支持 yuv420p10le';
  }
}

// 桌面生成预览和导出已选均从这一批次取得计划，再各自渲染文件。
async function renderShot(asset, directory, kind, hdrMode) {
  const portrait = ['rotate90', 'rotate270', 'exif'].includes(kind);
  const config = {
    shots: [[{ id: 'source', start: 0, end: asset.duration ?? 3 }]],
    ratio: portrait ? '9:16' : '16:9', resolution: 720, fps, fit: 'fit',
    keepAudio: true, unordered: false, useOriginal: true, useMirrors: false,
    musicIds: [], musicVolume: 50, count: 1, ...(hdrMode && { hdrMode }),
  };
  const catalog = new Map([['source', asset]]);
  const results = await renderSelection(config, catalog, directory);
  if (asset.kind === 'video') {
    results.proxy = path.join(directory, 'proxy.mp4');
    await createTrackProxy(asset, results.proxy, undefined, 256, undefined, { fps, hdrMode });
  }
  return results;
}

async function renderSelection(config, catalog, directory) {
  const batch = createPreviewBatch(config, catalog, await prepareMontagePlans(config, catalog));
  assert.equal(batch.entries.length, 1);
  const results = {};
  for (const stage of ['preview', 'export']) {
    const output = path.join(directory, stage);
    await fs.mkdir(output);
    const selected = selectPreviewPlans(batch, config, { id: batch.id, indices: [0] });
    const result = await exportBatch(selected, output);
    assert.deepEqual(result.failures, []);
    assert.equal(result.results.length, 1);
    results[stage] = result.results[0].path;
  }
  return results;
}

async function picture(file, time = 0) {
  const bytes = await ffmpeg(['-ss', String(time), '-i', file, '-an', '-frames:v', '1', '-vf', 'scale=16:16',
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']);
  return [[4, 4], [12, 4], [4, 12], [12, 12]].map(([x, y]) => {
    const offset = (16 * y + x) * 3;
    return [...bytes.subarray(offset, offset + 3)];
  });
}

function assertCorners(samples, order) {
  const rgb = { red: [255, 0, 0], lime: [0, 255, 0], blue: [0, 0, 255], yellow: [255, 255, 0] };
  order.forEach((name, i) => {
    assert.ok(rgb[name].every((target, c) => Math.abs(samples[i][c] - target) < 26),
      '第 ' + (i + 1) + ' 个角应是 ' + name + '，实际 ' + samples[i]);
  });
}

async function frameTimes(file) {
  const { frames } = await probe(file, '-select_streams', 'v:0', '-show_entries', 'frame=pts_time');
  return frames.map((frame) => Number(frame.pts_time));
}

async function audioSamples(file) {
  const pcm = await ffmpeg(['-i', file, '-map', '0:a:0', '-vn', '-af', 'aresample=8000:async=1:first_pts=0', '-ac', '1', '-ar', '8000',
    '-f', 's16le', 'pipe:1']);
  return Array.from({ length: pcm.length / 2 }, (_, i) => pcm.readInt16LE(i * 2));
}

async function checkFlashAndTone(file, times, samples, expectedTime = 0.5) {
  const colors = await ffmpeg(['-i', file, '-an', '-vf', 'scale=1:1', '-fps_mode', 'passthrough',
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']);
  assert.equal(colors.length, times.length * 3);
  assert.ok(colors[0] > 225 && colors[2] < 25, '首帧应为红色');
  const blueFrame = times.findIndex((_, i) => colors[i * 3 + 2] > 225 && colors[i * 3] < 25);
  const toneStart = samples.findIndex((sample) => Math.abs(sample) > 1000) / 8000;
  assert.ok(blueFrame >= 0 && Math.abs(times[blueFrame] - expectedTime) <= 1 / fps + 1e-8,
    '画面应在 ' + expectedTime + ' 秒处变蓝，实际 ' + times[blueFrame]);
  assert.ok(Math.abs(toneStart - expectedTime) < 0.015, '原声应在 ' + expectedTime + ' 秒处起音，实际 ' + toneStart);
  assert.ok(Math.abs(times[blueFrame] - toneStart) <= 1 / fps, '声音和画面应在同一输出帧内变化');
}

function colorTags(video) {
  return [video.pix_fmt, video.color_primaries, video.color_transfer, video.color_space];
}

async function checkSource(file, kind, asset) {
  const { streams } = await probe(file, '-show_streams');
  const video = streams.find((stream) => stream.codec_type === 'video');
  assert.deepEqual([video.width, video.height], [256, 144]);
  const portrait = ['rotate90', 'rotate270', 'exif'].includes(kind);
  assert.deepEqual([asset.width, asset.height], portrait ? [144, 256] : [256, 144]);
  assert.equal(asset.duration, kind === 'exif' ? null : 1);
  if (kind === 'vfr') {
    const audio = streams.find((stream) => stream.codec_type === 'audio');
    // AAC 的首个包包含编码预留采样，首个 PTS 略早于 0.25 秒。
    assert.ok(Number(audio.start_time) >= 0.22 && Number(audio.start_time) <= 0.25, '原音轨应晚于画面起始');
    const times = await frameTimes(file);
    const gaps = times.slice(1).map((time, i) => Math.round((time - times[i]) * 1000));
    assert.deepEqual(new Set(gaps), new Set([33, 67]));
    assert.equal(asset.vfr, true);
    await checkFlashAndTone(file, times, await audioSamples(file));
  } else {
    assert.equal(streams.some((stream) => stream.codec_type === 'audio'), false);
    assert.equal(asset.audioIndex, null);
    assert.ok(!asset.vfr);
  }
  if (kind === 'exif') {
    const { frames } = await probe(file, '-read_intervals', '%+#1', '-show_entries', 'frame_tags=Orientation');
    assert.equal(Number(frames[0].tags.Orientation), 6);
  }
  if (kind === 'rotate90' || kind === 'rotate270') {
    const matrix = video.side_data_list.find((item) => item.side_data_type === 'Display Matrix');
    assert.equal((matrix.rotation + 360) % 360, kind === 'rotate90' ? 90 : 270);
  }
  if (transfers[kind]) {
    assert.equal(asset.hdr, transfers[kind]);
    assert.deepEqual(colorTags(video), ['yuv420p10le', 'bt2020', transfers[kind], 'bt2020nc']);
  }
  if (cornerOrder[kind]) assertCorners(await picture(file), cornerOrder[kind]);
}

async function checkOutput(file, stage, kind, hdrOutput) {
  const { streams } = await probe(file, '-show_streams');
  const video = streams.find((stream) => stream.codec_type === 'video');
  const audio = streams.find((stream) => stream.codec_type === 'audio');
  const portrait = ['rotate90', 'rotate270', 'exif'].includes(kind);
  const dimensions = stage === 'proxy' ? [256, 144] : [1280, 720];
  assert.deepEqual([video.width, video.height], portrait ? dimensions.reverse() : dimensions);
  assert.ok(!video.side_data_list?.some((item) => item.rotation), stage + ' 像素旋正后仍有旋转标记');
  const duration = kind === 'exif' ? 3 : 1;
  assert.equal(Number(video.duration), duration, stage + ' 画面时长');
  assert.ok(audio, stage + ' 缺少音频流');
  assert.equal(Number(audio.sample_rate), 48000);
  assert.equal(audio.channels, 2);
  assert.ok(Math.abs(Number(audio.duration) - duration) <= 1 / fps, stage + ' 音频时长');
  const samples = await audioSamples(file);
  if (kind === 'vfr') {
    const times = await frameTimes(file);
    assert.equal(times.length, duration * fps);
    times.forEach((time, i) => assert.ok(Math.abs(time - i / fps) < 0.000002, stage + ' 时间戳 ' + time));
    await checkFlashAndTone(file, times, samples);
  } else {
    assert.ok(samples.length >= (duration - 1 / fps) * 8000 && samples.every((sample) => Math.abs(sample) <= 1),
      stage + ' 无声素材应填入整段静音');
  }
  if (cornerOrder[kind]) assertCorners(await picture(file), cornerOrder[kind]);
  if (transfers[kind]) {
    const expected = hdrOutput ? ['yuv420p10le', 'bt2020', transfers[kind], 'bt2020nc']
      : ['yuv420p', 'bt709', 'bt709', 'bt709'];
    assert.deepEqual(colorTags(video), expected, stage + ' 色彩规格');
    const [dark, light] = await picture(file);
    assert.ok(light[0] - dark[0] > 35, stage + ' 应能分辨明暗灰阶');
    if (hdrOutput) {
      assert.ok(Math.abs(dark[0] - 54) <= 6 && Math.abs(light[0] - 143) <= 6, stage + ' 应保留原始 HDR 灰阶');
    } else {
      assert.ok(Math.max(Math.abs(dark[0] - 54), Math.abs(light[0] - 143)) > 8,
        stage + ' 应对灰阶做色调映射，实测 ' + dark[0] + '/' + light[0]);
    }
  }
}

for (const kind of ['vfr', 'rotate90', 'rotate270', 'silent', 'exif', 'pq', 'hlg']) {
  test('规范化导入、分镜、生成预览和导出 ' + kind, async (t) => {
    const reason = await missingEncoder(kind);
    if (reason) return t.skip(reason);
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jiajian-normalize-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const file = await normalizationFixture(directory, kind);
    const asset = await inspectAsset(file, kind === 'exif' ? 'image' : 'video');
    await checkSource(file, kind, asset);
    let canToneMap;
    if (transfers[kind]) {
      const filters = await ffmpeg(['-filters']);
      const names = new Set(filters.toString().trim().split(/\r?\n/).map((line) => line.trim().split(/\s+/)[1]));
      canToneMap = names.has('zscale') && names.has('tonemap');
      assert.equal(await supportsHdrToneMap(), canToneMap, '转换能力应与当前 FFmpeg 滤镜表一致');
    }
    const modes = transfers[kind] ? [undefined, 'preserve'] : [undefined];
    for (const mode of modes) {
      const output = path.join(directory, mode ?? 'default');
      await fs.mkdir(output);
      const rendered = await renderShot(asset, output, kind, mode);
      const hdrOutput = transfers[kind] && (mode === 'preserve' || !canToneMap);
      for (const [stage, result] of Object.entries(rendered)) {
        await checkOutput(result, stage, kind, hdrOutput);
      }
    }
  });
}

test('保持 HDR 的混合工程将 SDR 与 HLG 画面转换到首个 HDR 分镜的 PQ 曲线', async (t) => {
  const reason = await missingEncoder('pq');
  if (reason) return t.skip(reason);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jiajian-mixed-hdr-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const ids = ['silent', 'pq', 'hlg'];
  const catalog = new Map();
  for (const id of ids) {
    const file = await normalizationFixture(directory, id);
    catalog.set(id, await inspectAsset(file, 'video'));
  }
  const config = {
    shots: ids.map((id) => [{ id, start: 0, end: 1 }]), hdrMode: 'preserve',
    ratio: '16:9', resolution: 720, fps, fit: 'fit',
    keepAudio: true, unordered: false, useOriginal: true, useMirrors: false,
    musicIds: [], musicVolume: 50, count: 1,
  };
  for (const result of Object.values(await renderSelection(config, catalog, directory))) {
    const { streams } = await probe(result, '-show_streams');
    const video = streams.find((stream) => stream.codec_type === 'video');
    assert.deepEqual(colorTags(video), ['yuv420p10le', 'bt2020', 'smpte2084', 'bt2020nc']);
    assert.equal(Number(video.duration), 3);
    const [red, green, blue] = await picture(result, 0.4);
    for (const [i, rgb] of [red, green, blue].entries()) {
      const others = rgb.filter((_, channel) => channel !== i);
      assert.ok(rgb[i] > Math.max(...others) + 12 && rgb[i] < 200, 'SDR 色块应以对应主色转换至 PQ，实际 ' + rgb);
    }
    for (const [time, expected] of [[1.4, [54, 143]], [2.4, [68, 119]]]) {
      // 两个输入使用相同的亮度码值。独立 zscale 以 100 尼特参考白将 HLG 转 PQ 后得到 68/119。
      const samples = (await picture(result, time)).slice(0, 2);
      for (const [i, rgb] of samples.entries()) {
        assert.ok(rgb.every((channel) => Math.abs(channel - expected[i]) < 8),
          time + ' 秒处 PQ 灰块应约为 ' + expected[i] + '，实际为 ' + rgb);
      }
    }
  }
});

test('VFR 首画面延迟 300 毫秒时，代理、预览与成片保留素材时间戳', async (t) => {
  const reason = await missingEncoder('vfr');
  if (reason) return t.skip(reason);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jiajian-late-picture-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const source = await normalizationFixture(directory, 'vfr');
  const delayed = path.join(directory, 'late-picture.mp4');
  await ffmpeg(['-itsoffset', '0.3', '-i', source, '-f', 'lavfi', '-i',
    'aevalsrc=0.25*sin(2*PI*660*t)*gte(t\\,0.8):s=48000:d=1.3',
    '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', delayed]);
  const asset = await inspectAsset(delayed, 'video');
  assert.equal(asset.duration, 1.3);
  await checkFlashAndTone(delayed, await frameTimes(delayed), await audioSamples(delayed), 0.8);
  for (const result of Object.values(await renderShot(asset, directory, 'vfr'))) {
    const times = await frameTimes(result);
    assert.equal(times[0], 0);
    assert.ok(Math.abs(times.at(-1) + 1 / fps - asset.duration) <= 1 / fps);
    await checkFlashAndTone(result, times, await audioSamples(result), 0.8);
  }
});
