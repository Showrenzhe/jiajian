'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { inspectAsset, createVideoThumbnail, normalizeSubtitleStyle, planMontage, planExtraction, exportBatch, maxWholeTracks } = require('../src/media.cjs');
const { prepareMontagePlans } = require('../src/preview-plans.cjs');
const { ffmpeg, fixtures } = require('./fixtures.cjs');

async function fixtureDirectory(t) {
  const parent = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(parent, 'sd-media-test-'));
  t.after(async () => {
    const resolved = await fs.realpath(root);
    assert.equal(path.dirname(resolved), parent);
    assert.ok(path.basename(resolved).startsWith('sd-media-test-'));
    await fs.rm(resolved, { force: true, recursive: true });
  });
  const files = await fixtures(root);
  const catalog = new Map(await Promise.all(Object.entries(files).map(async ([id, file]) => [
    id, await inspectAsset(file, file.endsWith('.wav') ? 'audio' : file.endsWith('.png') ? 'image' : 'video'),
  ])));
  const output = path.join(root, 'output');
  await fs.mkdir(output);
  return { catalog, output };
}

const montage = {
  shots: [
    [{ id: 'red', start: 0.3, end: 0.95 }, { id: 'blue', start: 0.1, end: 0.95 }],
    [{ id: 'green', start: 0.1, end: 0.75 }],
  ],
  ratio: '9:16', resolution: 720, fps: 24, fit: 'fill', keepAudio: false, unordered: false,
  useOriginal: true, useMirrors: false,
  musicIds: ['music'], musicVolume: 50, count: 2,
};

async function frameColor(file, seconds) {
  const [red, green, blue] = await ffmpeg([
    '-ss', String(seconds), '-i', file, '-an', '-frames:v', '1', '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
  ]);
  return { red, green, blue };
}

async function toneAt(media, position) {
  const pcm = await ffmpeg(['-ss', position, '-i', media, '-t', '0.1', '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1']);
  assert.ok(pcm.length >= 1000);
  let crossings = 0;
  let peak = 0;
  let last = 0;
  for (let offset = 0; offset < pcm.length; offset += 2) {
    const sample = pcm.readInt16LE(offset);
    if (sample > 0 && last <= 0) crossings += 1;
    peak = Math.max(peak, Math.abs(sample));
    last = sample;
  }
  return peak < 100 ? 0 : crossings * 8000 / (pcm.length / 2);
}

test('decodes a bounded JPEG thumbnail from the actual video stream', async (t) => {
  const { catalog, output } = await fixtureDirectory(t);
  const asset = catalog.get('red');
  const bytes = await createVideoThumbnail(asset);
  assert.ok(Buffer.isBuffer(bytes) && bytes.length < 64 * 1024);
  const thumbnail = path.join(output, 'thumbnail.jpg');
  await fs.writeFile(thumbnail, bytes);
  const { width, height, codec } = await inspectAsset(thumbnail, 'image');
  assert.deepEqual([width, height, codec], [240, 180, 'mjpeg']);
  const color = await frameColor(thumbnail, 0);
  assert.ok(color.red > 220 && color.blue < 35);
  assert.equal(await createVideoThumbnail(catalog.get('still')), null);
  assert.equal(await createVideoThumbnail({ ...asset, path: path.join(output, 'missing.mp4') }), null);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(createVideoThumbnail(asset, { signal: controller.signal }), { name: 'AbortError' });
});

test('renders different ordered combinations with trim, portrait framing and looping music', async (t) => {
  const { catalog, output } = await fixtureDirectory(t);
  const plans = planMontage(montage, catalog);
  const updates = [];
  const batch = await exportBatch(plans, output, { onUpdate: (update) => updates.push(update) });
  assert.deepEqual(batch.failures, []);
  assert.equal(batch.results.length, 2);
  assert.equal(batch.cancelled, false);
  assert.ok(updates.some((update) => update.fraction > 0 && update.fraction < 1));

  const [first, second] = batch.results.map((item) => item.path);
  for (const [index, file] of [first, second].entries()) {
    const rendered = await inspectAsset(file, 'video');
    assert.equal(rendered.width, 720);
    assert.equal(rendered.height, 1280);
    assert.equal(rendered.codec, 'h264');
    assert.equal(rendered.fps, 24);
    assert.notEqual(rendered.audioIndex, null);
    assert.ok(Math.abs(rendered.duration - plans[index].duration) < 0.12, `duration ${rendered.duration}`);
    assert.ok((await frameColor(file, 1.0)).green > 85);

    const samples = await ffmpeg(['-ss', '0.9', '-i', file, '-t', '0.15', '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1']);
    assert.ok(samples.length > 0);
    assert.ok(samples.some((_, offset) => offset % 2 === 0 && Math.abs(samples.readInt16LE(offset)) > 150));
  }
  const colors = await Promise.all([frameColor(first, 0.3), frameColor(second, 0.3)]);
  assert.ok(colors.some((color) => color.red > 220 && color.blue < 35));
  assert.ok(colors.some((color) => color.blue > 220 && color.red < 35));
  assert.equal((await fs.readdir(output)).length, 2);
});

test('starts looping music at the selected source shot after shuffle and voice alignment', async (t) => {
  const { catalog, output } = await fixtureDirectory(t);
  const config = {
    ...montage, ratio: '1:1', fps: 30, count: 1, unordered: true,
    shots: [[{ id: 'red', start: 0, end: 0.4, speed: 0.5 }], [{ id: 'green', start: 0, end: 0.6, speed: 2 }], [{ id: 'still', start: 0, end: 0.5 }]],
  };
  assert.throws(() => planMontage({ ...config, musicStartShot: 3 }, catalog), /配乐起始分镜/);
  assert.throws(() => planMontage({ ...config, musicStartShot: 1.5 }, catalog), /配乐起始分镜/);
  assert.equal(planMontage({ ...config, musicStartShot: null }, catalog, () => 0)[0].musicStart, 0);
  const [shuffled] = planMontage({ ...config, musicStartShot: 0 }, catalog, () => 0);
  assert.equal(shuffled.clips.at(-1).asset, catalog.get('red'));
  assert.equal(shuffled.musicStart, 0.8);

  const file = path.join(path.dirname(output), '配乐对齐口播.wav');
  await ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=1100', '-t', '0.9', file]);
  catalog.set('longVoice', await inspectAsset(file, 'audio'));
  const voiceConfig = { ...config, unordered: false, musicStartShot: 1, priority: 'voice', narrationVolume: 0 };
  const [refilled] = planMontage({
    ...voiceConfig, narrationId: 'longVoice',
    shots: [[{ id: 'red', start: 0, end: 0.2, speed: 2 }], [{ id: 'green', start: 0, end: 0.2, speed: 2 }]],
  }, catalog);
  assert.ok(Math.abs(refilled.musicStart - 0.45) < 1 / config.fps);
  const [compressed] = planMontage({
    ...voiceConfig, narrationId: 'music',
    shots: [[{ id: 'red', start: 0, end: 0.6 }], [{ id: 'green', start: 0, end: 0.6 }]],
  }, catalog);
  assert.equal(compressed.musicStart, 0.2);
  const batch = await exportBatch([shuffled, refilled, compressed], output);
  assert.deepEqual(batch.failures, []);
  assert.equal(batch.results.length, 3);
  const [shuffledFile, refilledFile, compressedFile] = batch.results.map((entry) => entry.path);
  assert.equal(await toneAt(shuffledFile, '0.5'), 0);
  assert.ok(Math.abs((await toneAt(shuffledFile, '0.95')) - 660) < 65);
  assert.ok(Math.abs((await toneAt(shuffledFile, '1.35')) - 660) < 65);
  assert.equal(await toneAt(refilledFile, '0.24'), 0);
  assert.ok(Math.abs((await toneAt(refilledFile, '0.61')) - 660) < 65);
  assert.equal(await toneAt(compressedFile, '0.04'), 0);
  assert.ok(Math.abs((await toneAt(compressedFile, '0.26')) - 660) < 65);
});

test('mixes still images and video, honoring the shuffle and background music selection', async (t) => {
  const { catalog, output } = await fixtureDirectory(t);
  const draws = [0, 0, 0, 0.9];
  const plans = planMontage({
    ...montage,
    shots: [[{ id: 'red', start: 0, end: 0.6 }], [{ id: 'still', start: 0, end: 0.5 }]],
    unordered: true, musicIds: ['music', 'otherMusic'], count: 1,
  }, catalog, () => draws.shift());
  assert.equal(plans[0].clips[0].asset.kind, 'image');
  assert.equal(plans[0].music, catalog.get('otherMusic'));
  const batch = await exportBatch(plans, output);
  assert.deepEqual(batch.failures, []);
  const [rendered] = batch.results;
  const stillColor = await frameColor(rendered.path, 0.2);
  const videoColor = await frameColor(rendered.path, 0.8);
  assert.ok(stillColor.red > 220 && stillColor.blue > 220);
  assert.ok(videoColor.red > 220 && videoColor.blue < 35);
  assert.ok(Math.abs((await inspectAsset(rendered.path, 'video')).duration - 1.1) < 0.12);
});

test('renders horizontal mirrors as independent candidate variants', async (t) => {
  const { catalog, output } = await fixtureDirectory(t);
  const asymmetric = path.join(path.dirname(output), '左右颜色.png');
  await ffmpeg([
    '-f', 'lavfi', '-i', 'color=red:s=160x90', '-vf', 'drawbox=x=80:y=0:w=80:h=90:color=blue:t=fill',
    '-frames:v', '1', '-threads', '1', '-update', '1', asymmetric,
  ]);
  catalog.set('asymmetric', await inspectAsset(asymmetric, 'image'));
  const plans = planMontage({
    ...montage, ratio: '16:9', shots: [[{ id: 'asymmetric', start: 0, end: 0.5 }]],
    useMirrors: true, musicIds: [], count: 2,
  }, catalog);
  assert.equal(plans.filter((plan) => plan.clips[0].mirror).length, 1);
  const batch = await exportBatch(plans, output);
  assert.deepEqual(batch.failures, []);
  assert.equal(batch.results.length, 2);
  for (const result of batch.results) {
    const [red, , blue] = await ffmpeg([
      '-i', result.path, '-an', '-frames:v', '1', '-vf', 'crop=4:4:120:200,scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
    ]);
    assert.ok(plans[result.index].clips[0].mirror ? blue > 220 && red < 35 : red > 220 && blue < 35);
  }
});

test('renders colored padding and shot fades on the final retimed timeline', async (t) => {
  const { catalog, output } = await fixtureDirectory(t);
  const config = {
    ...montage, ratio: '1:1', fps: 30, fit: 'fit', count: 1, unordered: true, musicIds: [],
    shots: [[{ id: 'red', start: 0, end: 0.6 }], [{ id: 'green', start: 0, end: 0.2 }], [{ id: 'blue', start: 0, end: 0.4 }]],
    shotTransitions: [
      { kind: 'fade-black', duration: 0.4 }, { kind: 'fade-white', duration: 0.4 }, { kind: 'fade-black', duration: 0.4 },
    ],
    narrationMode: 'segmented', segmentNarrationIds: [[], ['music'], []], priority: 'voice', backgroundColor: '#00FFff',
  };
  assert.throws(() => planMontage({ ...config, shotTransitions: [null] }, catalog), /转场设置/);
  assert.throws(() => planMontage({ ...config, backgroundColor: '#FFF' }, catalog), /背景颜色/);
  const [plan] = planMontage(config, catalog, () => 0);
  assert.deepEqual(plan.clips.map((clip) => clip.transition?.kind ?? null), ['fade-white', 'fade-black', null]);
  assert.deepEqual(plan.clips.map((clip) => clip.outputDuration), [0.4, 0.4, 0.6]);
  const [compressed] = planMontage({ ...config, unordered: false, narrationMode: 'whole', narrationId: 'music' }, catalog);
  const batch = await exportBatch([plan, compressed], output);
  assert.deepEqual(batch.failures, []);
  assert.equal(batch.results.length, 2);
  const [video, shortened] = batch.results.map(({ path: file }) => file);
  assert.ok(Math.abs((await inspectAsset(video, 'video')).duration - 1.4) < 0.035);

  async function pixelAt(file, position, y = 350) {
    const pixels = await ffmpeg([
      '-ss', position, '-i', file, '-an', '-frames:v', '1', '-vf', `crop=4:4:350:${y},scale=1:1`,
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
    ]);
    assert.equal(pixels.length, 3);
    return [...pixels];
  }
  const backdrop = await pixelAt(video, '0.1', 10);
  assert.ok(backdrop[0] < 35 && backdrop[1] > 220 && backdrop[2] > 220, `padding was ${backdrop}`);
  const white = await pixelAt(video, '0.4');
  assert.ok(white.every((channel) => channel > 225), `white dip was ${white}`);
  const black = await pixelAt(video, '0.8');
  assert.ok(black.every((channel) => channel < 30), `black dip was ${black}`);
  const last = await pixelAt(video, '1.3');
  assert.ok(last[0] > 220 && last[1] < 35 && last[2] < 35, `last shot was ${last}`);
  const compressedLast = await pixelAt(shortened, '0.35');
  assert.ok(compressedLast[0] < 35 && compressedLast[1] < 35 && compressedLast[2] > 220, `compressed last shot was ${compressedLast}`);
});

test('aligns whole narration with the chosen voice or picture priority', async (t) => {
  const { catalog, output } = await fixtureDirectory(t);
  const file = path.join(path.dirname(output), '长口播.wav');
  await ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=950', '-t', '2.4', file]);
  catalog.set('longNarration', await inspectAsset(file, 'audio'));
  const config = {
    ...montage, ratio: '1:1', shots: [[{ id: 'red', start: 0, end: 0.7 }], [{ id: 'green', start: 0, end: 0.8 }]],
    musicIds: [], count: 1,
  };
  const cases = [
    { priority: 'voice', narrationId: 'music', expected: 0.4 },
    { priority: 'voice', narrationId: 'longNarration', keepAudio: true, expected: 2.4 },
    { priority: 'picture', narrationId: 'music', expected: 1.5 },
    { priority: 'picture', narrationId: 'longNarration', expected: 1.5 },
  ];
  const plans = cases.map(({ expected, ...options }) => {
    const [plan] = planMontage({ ...config, ...options }, catalog);
    assert.equal(plan.duration, expected);
    assert.strictEqual(plan.narration, catalog.get(options.narrationId));
    return plan;
  });
  const batch = await exportBatch(plans, output);
  assert.deepEqual(batch.failures, []);
  assert.equal(batch.results.length, cases.length);

  for (const [index, item] of batch.results.entries()) {
    const rendered = await inspectAsset(item.path, 'video');
    assert.ok(Math.abs(rendered.duration - cases[index].expected) < 0.06, `duration ${rendered.duration}`);
    assert.equal(rendered.fps, config.fps);
  }
  const [compressed, refilled, shortVoice, croppedVoice] = batch.results.map((item) => item.path);
  assert.ok((await frameColor(compressed, 0.09)).red > 220);
  assert.ok((await frameColor(compressed, 0.25)).green > 85);
  assert.ok((await frameColor(refilled, 0.9)).red > 220);
  assert.ok((await frameColor(refilled, 2.2)).green > 85);
  assert.ok((await frameColor(croppedVoice, 0.9)).green > 85);

  async function hasAudioAt(file, position) {
    const samples = await ffmpeg(['-ss', position, '-i', file, '-t', '0.1', '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1']);
    assert.ok(samples.length >= 800);
    return samples.some((_, offset) => offset % 2 === 0 && Math.abs(samples.readInt16LE(offset)) > 150);
  }
  assert.equal(await hasAudioAt(compressed, '0.2'), true);
  assert.equal(await hasAudioAt(refilled, '2.2'), true);
  assert.equal(await hasAudioAt(shortVoice, '0.2'), true);
  assert.equal(await hasAudioAt(shortVoice, '0.9'), false);
  assert.equal(await hasAudioAt(croppedVoice, '1.3'), true);
});

test('fills short pictures from the same shot and uniformly accelerates full visuals under voice priority', async (t) => {
  const { catalog, output } = await fixtureDirectory(t);
  const parent = path.dirname(output);
  const narration = path.join(parent, '补画面口播.wav');
  const repeatNarration = path.join(parent, '重复画面口播.wav');
  const change = path.join(parent, '尾部变色.mp4');
  await Promise.all([
    ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000:duration=0.6', narration]),
    ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000:duration=1.2', repeatNarration]),
    ffmpeg([
      '-f', 'lavfi', '-i', 'color=red:s=320x240:r=30:d=0.4',
      '-f', 'lavfi', '-i', 'color=green:s=320x240:r=30:d=0.4',
      '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0', '-c:v', 'libx264', '-threads', '2', change,
    ]),
  ]);
  catalog.set('fillNarration', await inspectAsset(narration, 'audio'));
  catalog.set('repeatNarration', await inspectAsset(repeatNarration, 'audio'));
  catalog.set('changing', await inspectAsset(change, 'video'));
  const config = { ...montage, ratio: '1:1', fps: 30, count: 1, musicIds: [], priority: 'voice' };
  const candidates = [{ id: 'red', start: 0, end: 0.4 }, { id: 'blue', start: 0, end: 0.4 }];
  const changing = { id: 'changing', start: 0, end: 0.8 };
  const cases = [
    { shots: [candidates], narrationId: 'fillNarration' },
    { shots: [candidates, [{ id: 'green', start: 0, end: 0.5 }]], narrationMode: 'segmented', segmentNarrationIds: [['fillNarration'], []] },
    { shots: [[changing]], narrationId: 'music' },
    { shots: [[changing]], narrationId: 'music', priority: 'picture' },
    { shots: [[changing]], narrationId: 'repeatNarration' },
  ];
  const plans = cases.map((options) => planMontage({ ...config, ...options }, catalog, () => 0)[0]);
  const batch = await exportBatch(plans, output);
  assert.deepEqual(batch.failures, []);
  const [whole, segmented, compressed, picture, repeated] = batch.results.map(({ path: file }) => file);
  for (const [file, seconds] of [[whole, 0.6], [segmented, 1.1], [compressed, 0.4], [picture, 0.8], [repeated, 1.2]]) {
    assert.ok(Math.abs((await inspectAsset(file, 'video')).duration - seconds) < 0.04);
  }
  for (const file of [whole, segmented]) {
    assert.ok((await frameColor(file, 0.1)).red > 220);
    assert.ok((await frameColor(file, 0.34)).blue > 220, '应完整补入同组候选并整体加速，提前进入蓝色候选');
    assert.ok((await frameColor(file, 0.53)).blue > 220);
    assert.ok(Math.abs(await toneAt(file, '0.45') - 660) < 65, '补画面时口播继续按原速播放');
  }
  assert.ok((await frameColor(segmented, 0.8)).green > 85, '下一分镜的画面不能借到上一分镜');
  assert.ok((await frameColor(compressed, 0.1)).red > 220);
  assert.ok((await frameColor(compressed, 0.31)).green > 85, '较长素材应保留变色后的尾部');
  assert.ok(Math.abs(await toneAt(compressed, '0.26') - 660) < 65);
  assert.ok((await frameColor(picture, 0.31)).red > 220, '画面优先仍按原来的素材速度播放');
  assert.ok((await frameColor(picture, 0.66)).green > 85);
  assert.equal(await toneAt(picture, '0.55'), 0);
  assert.ok((await frameColor(repeated, 0.43)).green > 85);
  assert.ok((await frameColor(repeated, 0.72)).red > 220, '没有其他候选时应从头复用当前分镜的选定素材');
  assert.ok((await frameColor(repeated, 1.03)).green > 85);
});

test('cuts only adjacent narration edge silence and keeps speech, internal pauses and captions at their original tempo', async (t) => {
  const { catalog, output } = await fixtureDirectory(t);
  async function addNarration(id, parts) {
    const file = path.join(path.dirname(output), `${id}.wav`);
    const inputs = parts.flatMap(([length, frequency]) => ['-f', 'lavfi', '-i', frequency
      ? `sine=frequency=${frequency}:sample_rate=48000:duration=${length}` : `anullsrc=r=48000:cl=mono:d=${length}`]);
    const labels = parts.map((_, index) => `[${index}:a]`).join('');
    await ffmpeg([...inputs, '-filter_complex', `${labels}concat=n=${parts.length}:v=0:a=1`, '-c:a', 'pcm_s16le', file]);
    catalog.set(id, await inspectAsset(file, 'audio'));
  }
  await addNarration('left', [[0.16], [0.25, 440], [0.2], [0.25, 550], [0.3]]);
  await addNarration('right', [[0.25], [0.45, 880], [0.2]]);
  const config = {
    ...montage, ratio: '1:1', fps: 30, count: 1, musicIds: [], narrationMode: 'segmented',
    shots: [[{ id: 'red', start: 0, end: 1.16 }, { id: 'blue', start: 0, end: 1.16 }], [{ id: 'green', start: 0, end: 0.9 }]],
    segmentNarrationIds: [['left'], ['right']],
    generatedCaptions: {
      left: { name: '第一段', cues: [{ start: 160, end: 410, text: '开场' }, { start: 610, end: 860, text: '继续' }] },
      right: { name: '第二段', cues: [{ start: 250, end: 700, text: '结束' }] },
    },
  };
  const random = () => 0.75;
  const [voice] = await prepareMontagePlans({ ...config, priority: 'voice' }, catalog, { random });
  const [picture] = await prepareMontagePlans({ ...config, priority: 'picture' }, catalog, { random });
  assert.deepEqual(voice.clips.map(({ asset }) => asset), [catalog.get('blue'), catalog.get('green')], '静音分析应保留原来抽到的素材');
  for (const [index, [leading, trailing]] of [[0.16, 0.3], [0.25, 0.2]].entries()) {
    const { edgeSilence } = voice.clips[index].narration;
    assert.ok(Math.abs(edgeSilence.leading - leading) < 0.02 && Math.abs(edgeSilence.trailing - trailing) < 0.02, JSON.stringify(edgeSilence));
  }
  assert.ok([...catalog.values()].every((asset) => asset.edgeSilence === undefined), '预览分析不能修改项目原始素材');
  assert.ok(Math.abs(voice.duration - 1.56) < 0.005, `缩短后的成片长度 ${voice.duration}`);
  assert.deepEqual(voice.subtitles.cues.slice(0, 2), config.generatedCaptions.left.cues);
  assert.ok(Math.abs(voice.subtitles.cues[2].start - 910) <= 2, '后段字幕应跟随精确剪去的开头静音');
  assert.equal(voice.subtitles.cues[2].end - voice.subtitles.cues[2].start, 450, '口播字幕的发声跨度不能因对齐而拉伸');
  assert.ok(picture.subtitles.cues[2].start > 1400, '画面优先应保留原口播停顿');
  const [separated] = await prepareMontagePlans({
    ...config, priority: 'voice', shots: [config.shots[0], [{ id: 'still', start: 0, end: 0.3 }], config.shots[1]],
    segmentNarrationIds: [['left'], [], ['right']],
  }, catalog, { random });
  assert.ok(Math.abs(separated.duration - 2.36) < 0.005 && separated.clips[2].narrationStart === 0, '有无口播分镜隔开时不裁两侧静音');
  const batch = await exportBatch([voice, picture], output);
  assert.deepEqual(batch.failures, []);
  const [voiceFile, pictureFile] = batch.results.map(({ path: file }) => file);
  for (const [position, frequency] of [['0.03', 0], ['0.22', 440], ['0.45', 0], ['0.68', 550], ['1.02', 880], ['1.44', 0]]) {
    const tone = await toneAt(voiceFile, position);
    assert.ok(frequency ? Math.abs(tone - frequency) < 65 : tone === 0, `口播优先 ${position} 秒频率 ${tone}`);
  }
  assert.equal(await toneAt(pictureFile, '1.02'), 0);
  assert.ok(Math.abs(await toneAt(pictureFile, '1.52') - 880) < 65);
});

test('applies candidate original volume and narration gain to rendered audio', async (t) => {
  const { catalog, output } = await fixtureDirectory(t);
  const clip = { id: 'red', start: 0, end: 0.4 };
  const config = { ...montage, ratio: '1:1', count: 1, shots: [[clip]], musicIds: [] };
  assert.throws(() => planMontage({ ...config, shots: [[{ ...clip, volume: -1 }]] }, catalog), /原声音量/);
  assert.throws(() => planMontage({ ...config, narrationVolume: '20' }, catalog), /口播音量/);
  const configs = [
    { ...config, keepAudio: true, shots: [[clip], [{ ...clip, volume: 25 }], [{ ...clip, volume: 0 }]] },
    { ...config, narrationId: 'music' },
    { ...config, narrationId: 'music', narrationVolume: 20 },
    { ...config, narrationMode: 'segmented', segmentNarrationIds: [['music']], narrationVolume: 20 },
  ];
  const batch = await exportBatch(configs.flatMap((options) => planMontage(options, catalog)), output);
  assert.deepEqual(batch.failures, []);
  assert.equal(batch.results.length, 4);

  async function peak(media, position) {
    const pcm = await ffmpeg(['-ss', position, '-i', media, '-t', '0.08', '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1']);
    assert.ok(pcm.length >= 1000);
    let max = 0;
    for (let offset = 0; offset < pcm.length; offset += 2) max = Math.max(max, Math.abs(pcm.readInt16LE(offset)));
    return max;
  }
  const [originals, fullVoice, quietVoice, quietSegment] = batch.results.map((result) => result.path);
  const originalPeak = await peak(originals, '0.12');
  assert.ok(originalPeak > 1000);
  assert.ok(Math.abs((await peak(originals, '0.52')) / originalPeak - 0.25) < 0.05);
  assert.ok(await peak(originals, '0.95') < 10);
  const voicePeak = await peak(fullVoice, '0.12');
  assert.ok(voicePeak > 1000);
  for (const file of [quietVoice, quietSegment]) {
    assert.ok(Math.abs((await peak(file, '0.12')) / voicePeak - 0.2) < 0.05);
  }
});

test('retimes source trims and preserves audio pitch through speed and narration changes', async (t) => {
  const { catalog, output } = await fixtureDirectory(t);
  const greenAudio = path.join(path.dirname(output), '绿色原声.mp4');
  await ffmpeg([
    '-f', 'lavfi', '-i', 'color=green:s=320x240:r=30', '-f', 'lavfi', '-i', 'sine=frequency=880',
    '-t', '1.2', '-c:v', 'libx264', '-c:a', 'aac', '-threads', '2', greenAudio,
  ]);
  catalog.set('greenAudio', await inspectAsset(greenAudio, 'video'));
  const slow = { id: 'red', start: 0.2, end: 0.6, speed: 0.5 };
  const fast = { id: 'greenAudio', start: 0.1, end: 0.9, speed: 2 };
  const transition = { kind: 'fade-black', duration: 0.2 };
  const config = { ...montage, ratio: '1:1', fps: 30, count: 1, shots: [[slow], [fast]], musicIds: [], keepAudio: true, shotTransitions: [transition, null] };
  assert.throws(() => planMontage({ ...config, shots: [[{ ...slow, speed: 0.49 }], [fast]] }, catalog), /播放速度/);
  const [picture] = planMontage({
    ...config, shots: [...config.shots, [{ id: 'still', start: 0, end: 0.3, speed: 3 }]], shotTransitions: [transition, null, null],
  }, catalog);
  assert.ok(Math.abs(picture.clips[0].sourceDuration - 0.4) < 1e-6);
  assert.deepEqual(picture.clips.map((clip) => clip.outputDuration), [0.8, 0.4, 0.3]);
  const [segmented] = planMontage({
    ...config, shots: [[slow], [{ ...fast, end: 0.5 }]], keepAudio: false,
    narrationMode: 'segmented', segmentNarrationIds: [['music'], ['music']], priority: 'voice',
  }, catalog);
  assert.deepEqual(segmented.clips.map((clip) => clip.outputDuration), [0.4, 0.4]);
  const [whole] = planMontage({
    ...config, shots: [[{ ...slow, end: 0.4, speed: 2 }], [{ ...fast, end: 0.3 }]], keepAudio: false,
    narrationId: 'music', priority: 'voice',
  }, catalog);
  assert.deepEqual(whole.clips.map((clip) => clip.outputDuration), [0.2, 0.2]);
  const batch = await exportBatch([picture, segmented, whole], output);
  assert.deepEqual(batch.failures, []);
  const [pictureFile, segmentedFile, wholeFile] = batch.results.map((entry) => entry.path);
  for (const [file, expected] of [[pictureFile, 1.5], [segmentedFile, 0.8], [wholeFile, 0.4]]) {
    assert.ok(Math.abs((await inspectAsset(file, 'video')).duration - expected) < 0.035);
  }
  assert.ok((await frameColor(pictureFile, 0.6)).red > 220);
  assert.ok(Object.values(await frameColor(pictureFile, 0.8)).every((color) => color < 30));
  assert.ok((await frameColor(pictureFile, 1.0)).green > 85);
  const still = await frameColor(pictureFile, 1.3);
  assert.ok(still.red > 220 && still.blue > 220);
  assert.ok(Object.values(await frameColor(wholeFile, 0.2)).every((color) => color < 30));
  assert.ok(Math.abs((await toneAt(pictureFile, '0.55')) - 440) < 60);
  assert.ok(Math.abs((await toneAt(pictureFile, '0.95')) - 880) < 60);
  assert.ok(Math.abs((await toneAt(segmentedFile, '0.62')) - 660) < 60);
  assert.ok(Math.abs((await toneAt(wholeFile, '0.22')) - 660) < 60);
});

test('draws whole narration and subtitles together, including empty tracks', () => {
  const catalog = new Map([
    ['red', { name: 'Red', kind: 'video', duration: 1.5 }],
    ['blue', { name: 'Blue', kind: 'video', duration: 1.5 }],
    ['short', { name: 'Short', kind: 'audio', duration: 0.4 }],
    ['long', { name: 'Long', kind: 'audio', duration: 1.3 }],
  ]);
  const subtitles = (name) => ({ name, cues: [{ start: 0, end: 100, text: name }] });
  const config = {
    ...montage, shots: [[{ id: 'red', start: 0, end: 1 }, { id: 'blue', start: 0, end: 1 }]],
    musicIds: [], narrationId: 'short', subtitles: subtitles('主轨.srt'), priority: 'voice', count: 8,
    extraWholeTracks: [
      { narrationId: 'long', subtitles: subtitles('长口播.srt') },
      { narrationId: null, subtitles: null },
      { narrationId: null, subtitles: subtitles('仅字幕.srt') },
    ],
  };
  const plans = planMontage(config, catalog, () => 0);
  const expected = [
    ['Short', '主轨.srt', 0.4], ['Long', '长口播.srt', 1.3],
    [null, null, 1], [null, '仅字幕.srt', 1],
  ];
  assert.equal(new Set(plans.map((plan) => `${plan.clips[0].asset.name}:${plan.wholeTrack}`)).size, 8);
  for (const plan of plans) {
    assert.deepEqual([plan.narration?.name ?? null, plan.subtitles?.name ?? null, plan.duration], expected[plan.wholeTrack - 1]);
  }
  assert.throws(() => planMontage({ ...config, count: 9 }, catalog), /生成数量/);
  assert.throws(() => planMontage({ ...config, extraWholeTracks: Array(maxWholeTracks).fill(config.extraWholeTracks[0]) }, catalog), /最多可设置 250/);
  const segmented = planMontage({ ...config, count: 2, narrationMode: 'segmented', extraWholeTracks: [null] }, catalog, () => 0);
  assert.ok(segmented.every((plan) => !plan.narration && !plan.subtitles && plan.wholeTrack === undefined));
});

test('uses the selected whole voice transcript up to the final cut and honors imported subtitles', () => {
  const catalog = new Map([
    ['red', { name: 'Red', kind: 'video', duration: 1.5 }],
    ['first', { name: 'First', kind: 'audio', duration: 0.8 }],
    ['second', { name: 'Second', kind: 'audio', duration: 0.4 }],
  ]);
  const imported = { name: '手动字幕.srt', cues: [{ start: 100, end: 200, text: '手动字幕' }] };
  const config = {
    ...montage, shots: [[{ id: 'red', start: 0, end: 0.6 }]], musicIds: [], count: 2,
    narrationId: 'first', narrationVolume: 0,
    extraWholeTracks: [{ narrationId: 'second', subtitles: imported }],
    generatedCaptions: { first: '第一行\r\n\r\n第二行', second: '只保留手动字幕' },
  };
  const [first, second] = planMontage(config, catalog, () => 0);
  assert.deepEqual(first.subtitles?.cues, [{ start: 0, end: 600, text: '第一行\n第二行' }]);
  assert.deepEqual(second.subtitles, imported);
  const [withLongerVoice] = planMontage({ ...config, count: 1, priority: 'voice' }, catalog, () => 0);
  assert.equal(withLongerVoice.subtitles?.cues[0].end, 800);
  const timed = { name: '配音字幕', cues: [
    { start: 40, end: 200, text: '第一句' },
    { start: 540, end: 750, text: '裁切到片尾' },
    { start: 750, end: 950, text: '画面优先时隐藏' },
    { start: 820, end: 900, text: '音频之外隐藏' },
  ] };
  const timedConfig = { ...config, generatedCaptions: { first: timed, second: timed } };
  const [timedFirst, timedSecond] = planMontage(timedConfig, catalog, () => 0);
  assert.deepEqual(timedFirst.subtitles, { ...timed, cues: [timed.cues[0], { ...timed.cues[1], end: 600 }] });
  assert.deepEqual(timedSecond.subtitles, imported);
  const [timedLongVoice] = planMontage({ ...timedConfig, count: 1, priority: 'voice' }, catalog, () => 0);
  assert.deepEqual(timedLongVoice.subtitles?.cues, [...timed.cues.slice(0, 2), { ...timed.cues[2], end: 800 }]);
  assert.throws(() => planMontage({ ...config, generatedCaptions: { red: '无效' } }, catalog), /对应工程中的口播音频/);
  assert.throws(() => planMontage({ ...config, generatedCaptions: { first: '字'.repeat(501) } }, catalog), /500 字/);
  assert.throws(() => planMontage({ ...config, generatedCaptions: {
    first: { ...timed, cues: [{ start: 2, end: 2, text: '无效' }] },
  } }, catalog), /起止时间无效/);
});

test('builds horizontal ordered narration tracks and independent random choices', async (t) => {
  const { catalog } = await fixtureDirectory(t);
  const config = {
    ...montage,
    narrationMode: 'segmented',
    narrationId: 'missing whole narration is unused',
    subtitles: { name: '整段字幕.srt', cues: [{ start: 0, end: 200, text: '整段' }] },
    segmentNarrationIds: [['music', null, 'otherMusic'], [null, 'otherMusic', 'music']],
    useOriginal: false, useMirrors: true,
  };
  const ordered = planMontage({ ...config, count: 6 }, catalog, () => 0);
  const firstShotChoices = ordered.filter((plan) => plan.clips[0].asset === catalog.get('red'));
  assert.equal(firstShotChoices.length, 3);
  assert.deepEqual(firstShotChoices.map((plan) => plan.clips.map((clip) => clip.narration?.name ?? null)), [
    [catalog.get('music').name, null], [null, catalog.get('otherMusic').name],
    [catalog.get('otherMusic').name, catalog.get('music').name],
  ]);
  assert.ok(ordered.every((plan) => !plan.narration && !plan.subtitles && plan.clips.every((clip) => clip.mirror)));
  const random = planMontage({ ...config, segmentNarrationSelection: 'random', count: 8 }, catalog, () => 0);
  const combinations = random.filter((plan) => plan.clips[0].asset === catalog.get('red'))
    .map((plan) => plan.clips.map((clip) => clip.narration.name).join('+'));
  assert.equal(new Set(combinations).size, 4);
  assert.throws(() => planMontage({ ...config, count: 7 }, catalog), /生成数量/);
});

test('keeps segmented narration on its shot after shuffling and aligns each shot separately', async (t) => {
  const { catalog, output } = await fixtureDirectory(t);
  const file = path.join(path.dirname(output), '第二段口播.wav');
  await ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=950', '-t', '0.8', file]);
  catalog.set('secondVoice', await inspectAsset(file, 'audio'));
  const config = {
    ...montage, ratio: '1:1', fps: 30, count: 1, unordered: true, musicIds: [],
    shots: [[{ id: 'red', start: 0, end: 0.6 }], [{ id: 'green', start: 0, end: 0.3 }], [{ id: 'still', start: 0, end: 0.5 }]],
    narrationMode: 'segmented', segmentNarrationIds: [['music'], ['secondVoice'], [null]],
    generatedCaptions: { music: { name: '第一镜台词', cues: [
      { start: 60, end: 230, text: '第一镜台词' },
      { start: 300, end: 550, text: '第一镜片尾' },
    ] }, secondVoice: '第二镜台词' },
    subtitles: { name: '整段字幕.srt', cues: [{ start: 0, end: 200, text: '整段字幕' }] },
  };
  const [voice] = planMontage({ ...config, priority: 'voice' }, catalog, () => 0);
  const [picture] = planMontage({ ...config, priority: 'picture' }, catalog, () => 0);
  assert.deepEqual(voice.clips.map((clip) => clip.outputDuration), [0.8, 0.5, 0.4]);
  assert.deepEqual(picture.clips.map((clip) => clip.outputDuration), [0.3, 0.5, 0.6]);
  assert.deepEqual(voice.clips.map((clip) => clip.narration?.name ?? null), [catalog.get('secondVoice').name, null, catalog.get('music').name]);
  assert.deepEqual(voice.subtitles?.cues, [
    { start: 0, end: 800, text: '第二镜台词' },
    { start: 1360, end: 1530, text: '第一镜台词' },
    { start: 1600, end: 1700, text: '第一镜片尾' },
  ]);
  assert.deepEqual(picture.subtitles?.cues, [
    { start: 0, end: 300, text: '第二镜台词' },
    { start: 860, end: 1030, text: '第一镜台词' },
    { start: 1100, end: 1200, text: '第一镜片尾' },
  ]);
  const batch = await exportBatch([voice, picture], output);
  assert.deepEqual(batch.failures, []);
  const [voiceFile, pictureFile] = batch.results.map((item) => item.path);
  assert.ok(Math.abs((await inspectAsset(voiceFile, 'video')).duration - 1.7) < 0.035);
  assert.ok(Math.abs((await inspectAsset(pictureFile, 'video')).duration - 1.4) < 0.035);
  assert.ok((await frameColor(voiceFile, 0.65)).green > 85);
  const still = await frameColor(voiceFile, 1.03);
  assert.ok(still.red > 220 && still.blue > 220);
  const red = await frameColor(voiceFile, 1.5);
  assert.ok(red.red > 220 && red.blue < 35);

  assert.ok(Math.abs((await toneAt(voiceFile, '0.6')) - 950) < 70);
  assert.equal(await toneAt(voiceFile, '0.97'), 0);
  assert.ok(Math.abs((await toneAt(voiceFile, '1.45')) - 660) < 70);
  assert.ok(Math.abs((await toneAt(pictureFile, '0.15')) - 950) < 70);
  assert.equal(await toneAt(pictureFile, '0.4'), 0);

  async function brightPixels(position) {
    const pixels = await ffmpeg([
      '-ss', position, '-i', voiceFile, '-an', '-frames:v', '1', '-vf', 'crop=600:230:60:490',
      '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1',
    ]);
    assert.equal(pixels.length, 600 * 230);
    return pixels.reduce((total, value) => total + Number(value > 210), 0);
  }
  assert.ok(await brightPixels('0.2') > 100);
  assert.equal(await brightPixels('1.0'), 0);
  assert.ok(await brightPixels('1.5') > 100);
  assert.equal(await brightPixels('1.55'), 0);
});

test('burns UTF-8 subtitles at their final timeline positions after voice alignment', async (t) => {
  const { catalog, output } = await fixtureDirectory(t);
  const directory = path.join(output, "成片 '样片'");
  await fs.mkdir(directory);
  const [plan] = planMontage({
    ...montage, ratio: '1:1', fps: 60, shots: [[{ id: 'red', start: 0, end: 0.2 }]],
    musicIds: [], count: 1, narrationId: 'music', priority: 'voice',
    subtitles: { name: '中文字幕.srt', cues: [{ start: 180, end: 300, text: '字幕测试' }] },
  }, catalog);
  const batch = await exportBatch([plan], directory);
  assert.deepEqual(batch.failures, []);
  assert.equal(batch.results.length, 1);
  const [{ path: file, name }] = batch.results;
  assert.deepEqual(await fs.readdir(directory), [name]);

  async function brightPixels(position) {
    const pixels = await ffmpeg([
      '-ss', position, '-i', file, '-an', '-frames:v', '1', '-vf', 'crop=600:230:60:490',
      '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1',
    ]);
    assert.equal(pixels.length, 600 * 230);
    return pixels.reduce((count, pixel) => count + Number(pixel > 210), 0);
  }
  assert.equal(await brightPixels('0.06'), 0);
  assert.ok(await brightPixels('0.24') > 100);
  assert.equal(await brightPixels('0.34'), 0);
});

test('renders the global subtitle colors and position on an alternate whole narration track', async (t) => {
  assert.deepEqual(normalizeSubtitleStyle(), { size: 18, textColor: '#ffffff', outlineColor: '#000000', position: 'bottom' });
  assert.throws(() => normalizeSubtitleStyle({ size: 36.5 }), /字号/);
  assert.throws(() => normalizeSubtitleStyle({ textColor: '#00FFFF\n' }), /颜色/);
  assert.throws(() => normalizeSubtitleStyle({ position: '__proto__' }), /位置/);
  const { catalog, output } = await fixtureDirectory(t);
  const plans = planMontage({
    ...montage, ratio: '1:1', count: 2, shots: [[{ id: 'red', start: 0, end: 0.8 }]], musicIds: [],
    extraWholeTracks: [{ narrationId: null, subtitles: { name: 'Top.srt', cues: [{ start: 0, end: 650, text: 'Styled Caption' }] } }],
    subtitleStyle: { size: 30, textColor: '#00FFFF', outlineColor: '#FF00FF', position: 'top' },
  }, catalog, () => 0);
  const alternate = plans.find((plan) => plan.wholeTrack === 2);
  assert.equal(alternate.subtitleStyle.textColor, '#00ffff');
  const batch = await exportBatch([alternate], output);
  assert.deepEqual(batch.failures, []);
  assert.equal(batch.results.length, 1);
  const [{ path: file }] = batch.results;

  async function colorsIn(y) {
    const rgb = await ffmpeg([
      '-ss', '0.3', '-i', file, '-an', '-frames:v', '1', '-vf', `crop=720:220:0:${y}`,
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
    ]);
    assert.equal(rgb.length, 720 * 220 * 3);
    let text = 0;
    let outline = 0;
    for (let i = 0; i < rgb.length; i += 3) {
      if (rgb[i] < 55 && rgb[i + 1] > 200 && rgb[i + 2] > 200) text += 1;
      if (rgb[i] > 200 && rgb[i + 1] < 55 && rgb[i + 2] > 200) outline += 1;
    }
    return { text, outline };
  }
  const top = await colorsIn(0);
  const bottom = await colorsIn(500);
  assert.ok(top.text > 500 && top.outline > 100, `subtitle pixel counts were ${JSON.stringify({ top, bottom })}`);
  assert.deepEqual(bottom, { text: 0, outline: 0 });
});

test('extracts real MP3 audio and preserves a same-name file', async (t) => {
  const { catalog, output } = await fixtureDirectory(t);
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-05T09:00:00Z') });
  const existing = path.join(output, '提取音频-20261105090000-01.mp3');
  await fs.writeFile(existing, 'original file');
  const batch = await exportBatch(planExtraction(['red'], catalog), output);
  assert.deepEqual(batch.failures, []);
  assert.equal(batch.results.length, 1);
  assert.equal(batch.results[0].name, '提取音频-20261105090000-01-2.mp3');
  assert.equal(await fs.readFile(existing, 'utf8'), 'original file');
  const rendered = await inspectAsset(batch.results[0].path, 'audio');
  assert.equal(rendered.codec, 'mp3');
  assert.ok(Math.abs(rendered.duration - 1.5) < 0.12);
  assert.throws(() => planExtraction(['blue'], catalog), /没有音轨/);
  assert.throws(() => planMontage({ ...montage, shots: [[{ id: 'red', start: 1, end: 0.5 }]] }, catalog), /有效片段/);
});

test('cancels an in-progress output and keeps previously completed media', async (t) => {
  const { catalog, output } = await fixtureDirectory(t);
  const controller = new AbortController();
  const plans = planMontage({ ...montage, ratio: '1:1', fit: 'fit', keepAudio: true, musicIds: [] }, catalog);
  const batch = await exportBatch(plans, output, {
    signal: controller.signal,
    onUpdate: ({ index, fraction }) => { if (index === 1 && fraction > 0 && fraction < 1) controller.abort(); },
  });
  assert.equal(batch.cancelled, true);
  assert.equal(batch.results.length, 1);
  assert.deepEqual(batch.failures, []);
  const rendered = await inspectAsset(batch.results[0].path, 'video');
  assert.deepEqual([rendered.width, rendered.height], [720, 720]);
  assert.deepEqual(await fs.readdir(output), [batch.results[0].name]);
});
