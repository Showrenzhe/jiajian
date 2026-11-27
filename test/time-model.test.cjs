'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { exportBatch, inspectAsset, planMontage } = require('../src/media.cjs');
const { prepareMontagePlans, createPreviewBatch, selectPreviewPlans } = require('../src/preview-plans.cjs');
const { ffmpeg, fixtures } = require('./fixtures.cjs');

const settings = {
  ratio: '16:9', resolution: 720, fit: 'fit', fps: 24,
  keepAudio: false, unordered: false, useOriginal: true, useMirrors: false, musicIds: [], count: 1,
};
const source = { kind: 'video', name: '画面', duration: 4 };

// Integer ticks represent these millisecond source cuts exactly at every selected speed.
const ticksPerSecond = 60000;
function longProject() {
  let seed = 0x4a4a10;
  function draw(limit) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return Math.floor(seed / 0x100000000 * limit);
  }
  const ticks = [];
  const shots = Array.from({ length: 200 }, () => {
    const first = 127 + draw(201), last = 149 + draw(251);
    const speed = [.5, 1, 1.25, 1.5, 2][draw(5)];
    const start = 51 + draw(29), resume = start + first + 70;
    ticks.push((first + last) * 60 / speed);
    return [{ id: 'video', start: start / 1000, end: (resume + last) / 1000, speed,
      ranges: [{ start: start / 1000, end: (start + first) / 1000 },
        { start: resume / 1000, end: (resume + last) / 1000 }] }];
  });
  const shotTransitions = shots.map((_, i) => i % 3 === 0
    ? { kind: i % 2 ? 'fade-black' : 'fade-white', duration: .25 } : null);
  return { config: { ...settings, shots, shotTransitions }, ticks };
}

// Internal cuts select the nearest frame. The final frame covers the entire remaining span.
function frameBoundaries(ticks, fps) {
  let total = 0;
  return [0, ...ticks.map((span, i) => {
    total += span;
    const numerator = total * fps;
    return i === ticks.length - 1 ? Math.ceil(numerator / ticksPerSecond)
      : Math.floor((numerator + ticksPerSecond / 2) / ticksPerSecond);
  })];
}

for (const fps of [24, 25, 30, 60]) {
  test(`200 个随机倍速、转场和多区间裁剪的分镜累计到正确的输出帧（${fps} fps）`, async () => {
    const { config, ticks } = longProject();
    config.fps = fps;
    const catalog = new Map([['video', source]]);
    const plans = await prepareMontagePlans(config, catalog);
    const batch = createPreviewBatch(config, catalog, plans);
    const [plan] = selectPreviewPlans(batch, config, { id: batch.id, indices: [0] });
    const boundaries = frameBoundaries(ticks, fps);
    const total = boundaries.at(-1);
    assert.equal(plan.duration, total / fps);
    assert.equal(batch.entries[0].duration, total / fps);
    assert.equal(plan.clips.length, ticks.length);
    let frame = 0;
    for (const [index, clip] of plan.clips.entries()) {
      const expected = boundaries[index + 1] - boundaries[index];
      assert.equal(clip.shotIndex, index);
      assert.equal(frame, boundaries[index], `shot ${index} in`);
      assert.equal(clip.outputFrames, expected, `shot ${index} frames`);
      assert.equal(clip.outputDuration, expected / fps, `shot ${index} duration`);
      assert.equal(clip.visuals.reduce((sum, visual) => sum + visual.outputFrames, 0), expected);
      frame += clip.outputFrames;
      assert.equal(frame, boundaries[index + 1], `shot ${index} out`);
    }
    assert.equal(frame, total);
  });
}

test('原速单裁段也使用相邻分镜共享的帧边界', () => {
  const shots = Array.from({ length: 3 }, () => [{ id: 'video', start: .03, end: .24 }]);
  const [plan] = planMontage({ ...settings, shots }, new Map([['video', source]]));
  assert.deepEqual(plan.clips.map(clip => clip.outputFrames), [5, 5, 6]);
  assert.equal(plan.duration, 16 / 24);
});

test('口播优先保留样本精度，接缝静音、倍速和空口播分镜共同决定视频帧边界', () => {
  const catalog = new Map([['video', source],
    ['a', { kind: 'audio', name: '前句', duration: .48625, edgeSilence: { trailing: .2025 } }],
    ['b', { kind: 'audio', name: '后句', duration: .525, edgeSilence: { leading: .19375 } }]]);
  const shots = Array.from({ length: 4 }, () => [{ id: 'video', start: .03, end: .24 }]);
  const config = { ...settings, shots, priority: 'voice', narrationMode: 'segmented',
    segmentNarrationIds: [['a'], ['b'], [], []],
    segmentVoiceCuts: [[null], [{ speed: 1.25, ranges: [{ start: 0, end: .225 }, { start: .3, end: .525 }] }], [], []],
    generatedCaptions: { b: { name: '后句字幕', cues: [
      { start: 230, end: 290, text: '被剪掉' }, { start: 300, end: 600, text: '保留的第二段' },
    ] } } };
  // Fill retains 25 ms at either side of the detected seam. Reference keeps the edited sound whole.
  for (const [voiceAlignment, seconds, secondCue] of [
    ['fill', [.30875, .23, .21, .21], [.35875, .53875]],
    ['reference', [.48625, .36, .21, .21], [.66625, .84625]],
  ]) {
    const [plan] = planMontage({ ...config, voiceAlignment }, catalog);
    const edges = frameBoundaries(seconds.map(s => Math.round(s * ticksPerSecond)), config.fps);
    assert.deepEqual(plan.clips.map(c => c.outputFrames), seconds.map((_, i) => edges[i + 1] - edges[i]));
    assert.equal(plan.duration, edges.at(-1) / config.fps);
    assert.deepEqual(plan.subtitles.cues.map(c => c.text), ['保留的第二段']);
    const [cue] = plan.subtitles.cues;
    assert.equal(cue.start, Math.ceil(secondCue[0] * 1000));
    assert.equal(cue.end, Math.floor(secondCue[1] * 1000));
  }
});

test('200 段口播的每一条字幕都在所属音频的采样区间内', () => {
  const { config, ticks } = longProject();
  const fps = config.fps;
  const cuts = frameBoundaries(ticks, fps);
  const catalog = new Map([['video', source]]);
  const generatedCaptions = {};
  const segmentNarrationIds = [];
  const segmentVoiceCuts = [];
  const windows = new Map();
  const sampleRate = 48000, samplesPerFrame = sampleRate / fps;
  for (let i = 0; i < ticks.length; i++) {
    const id = `voice-${i}`;
    const offset = 11 + i % 7;
    const length = 5643 + i % 31;
    catalog.set(id, { kind: 'audio', name: id, duration: length / sampleRate });
    segmentNarrationIds.push([id]);
    segmentVoiceCuts.push([{ speed: 1, offset: offset / sampleRate }]);
    const start = cuts[i] * samplesPerFrame + offset;
    const end = Math.min(start + length, cuts[i + 1] * samplesPerFrame);
    const cues = [
      { start: 0, end: 51, text: `${id}-a` },
      { start: 54, end: 800, text: `${id}-b` },
    ];
    generatedCaptions[id] = { name: id, cues };
    for (const cue of cues) windows.set(cue.text, { start, end });
  }
  const [plan] = planMontage({ ...config, narrationMode: 'segmented',
    segmentNarrationIds, segmentVoiceCuts, generatedCaptions }, catalog);
  for (const cue of plan.subtitles.cues) {
    const audio = windows.get(cue.text);
    assert.ok(audio, `unexpected or repeated cue ${cue.text}`);
    assert.ok(cue.start * sampleRate >= audio.start * 1000, `${cue.text} starts before its audio`);
    assert.ok(cue.end * sampleRate <= audio.end * 1000, `${cue.text} ends after its audio`);
    assert.ok(cue.start < cue.end);
    windows.delete(cue.text);
  }
  assert.equal(windows.size, 0, 'every source line survives');
});

test('跟随分镜的整段原速和倍速 SRT 都在真实口播起止之间', () => {
  const catalog = new Map([['video', source], ['voice', { name: '整段口播', kind: 'audio', duration: .21755 }]]);
  const shots = [[{ id: 'video', start: 0, end: 5 / 24 }], [{ id: 'video', start: 0, end: .7 }]];
  const subtitles = { name: '导入.srt', cues: [
    { start: 0, end: 60, text: '开头' }, { start: 65, end: 300, text: '结尾' },
    { start: 350, end: 499, text: '超出音频' },
  ] };
  for (const narrationSpeed of [1, 1.25]) {
    const [plan] = planMontage({ ...settings, shots, narrationId: 'voice', subtitles, narrationSpeed,
      wholeStartShots: [1] }, catalog);
    const cues = plan.subtitles.cues;
    assert.deepEqual(cues.map(c => c.text), ['开头', '结尾']);
    const start = 5 / 24, end = start + .21755 / narrationSpeed;
    for (const cue of cues) {
      assert.ok(cue.start >= Math.ceil(start * 1000));
      assert.ok(cue.end <= Math.floor(end * 1000));
    }
  }
});

test('旧工程移除口播后，独立 SRT 保留自身的时间码', () => {
  const subtitles = { name: '独立.srt', cues: [{ start: 100, end: 700, text: '保留原时间码' }] };
  const config = { ...settings, shots: [[{ id: 'video', start: 0, end: 1 }]], narrationSpeed: 2, subtitles };
  const [plan] = planMontage(config, new Map([['video', source]]));
  assert.deepEqual(plan.subtitles, subtitles);
});

test('实际预览与导出都在同一帧切镜，并覆盖最后不足一帧的画面', async t => {
  const parent = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(parent, 'jiajian-time-model-'));
  t.after(async () => {
    const directory = await fs.realpath(root);
    assert.equal(path.dirname(directory), parent);
    assert.ok(path.basename(directory).startsWith('jiajian-time-model-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const files = await fixtures(root);
  const ids = ['red', 'blue', 'green'];
  const catalog = new Map(await Promise.all(ids.map(async id => [id, await inspectAsset(files[id], 'video')])));
  const shots = ids.map(id => [{ id, start: .1, end: .531, speed: 2 }]);
  shots[0][0] = { id: 'red', start: 0, end: .628, speed: 2,
    ranges: [{ start: 0, end: .203 }, { start: .4, end: .628 }] };
  const config = { ...settings, shots, fit: 'fill', shotTransitions: [null, { kind: 'fade-black', duration: .17 }, null] };
  const plans = await prepareMontagePlans(config, catalog);
  const preview = createPreviewBatch(config, catalog, plans);
  // Each 431 ms edit plays at 2×. Independent boundaries at 24 fps are 0, 5, 10, 16.
  for (const entryPoint of ['预览', '导出']) {
    const directory = path.join(root, entryPoint);
    await fs.mkdir(directory);
    const selected = selectPreviewPlans(preview, config, { id: preview.id, indices: [0] });
    const result = await exportBatch(selected, directory);
    assert.deepEqual(result.failures, []);
    const rgb = await ffmpeg(['-i', result.results[0].path, '-an', '-vf', 'scale=1:1',
      '-fps_mode', 'passthrough', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1']);
    assert.equal(rgb.length / 3, 16, `${entryPoint} decoded frame count`);
    for (let frame = 0; frame < 16; frame++) {
      const pixel = [...rgb.subarray(frame * 3, frame * 3 + 3)];
      if (frame === 10) {
        assert.ok(Math.max(...pixel) < 15, `${entryPoint} first green frame fades in from black: ${pixel}`);
      } else {
        const channel = frame < 5 ? 0 : frame < 10 ? 2 : 1;
        assert.ok(pixel[channel] > Math.max(...pixel.filter((_, index) => index !== channel)) + 12,
          `${entryPoint} frame ${frame}, RGB ${pixel}`);
      }
    }
  }
  assert.equal(preview.entries[0].duration, 16 / 24);
});
