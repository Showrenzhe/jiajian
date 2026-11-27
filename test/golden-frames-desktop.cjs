'use strict';

const assert = require('node:assert/strict');
const { mkdirSync, mkdtempSync, realpathSync } = require('node:fs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { app, nativeImage } = require('electron');
const { launchDesktop } = require('../src/desktop.cjs');
const { inspectAsset } = require('../src/media.cjs');
const { saveProject } = require('../src/project-format.cjs');
const { clickVisible } = require('./desktop-input.cjs');
const { ffmpeg, normalizationFixture } = require('./fixtures.cjs');

app.disableHardwareAcceleration();
const fps = 30;
const width = 256, height = 144;
// Chromium and swscale round YUV→RGB and downsample glyph edges differently. Allow
// four 8-bit levels on average; the one-frame fade drift affects large flat patches.
const maxFrameMae = 4;
// T11's untagged SD bars are represented at HD size. The BT.709 display transform
// can shift a saturated green by 40 codes; color identity and fade slope are checked separately.
const colorTolerance = 45;
const fadeRatioTolerance = .035; // Compression is <1% in the interior of a flat green patch.
const smoke = process.env.JIAJIAN_GOLDEN_SMOKE === '1';
const shiftTransition = process.argv.includes('--shift-transition');
const samples = [
  ['first', 0], ['before-caption', 11], ['caption-onset', 12], ['fade-out', 22],
  ['transition-middle', 24], ['fade-in', 26], ['speed-middle', 30],
];

async function makeProject(root) {
  const catalog = new Map();
  for (const id of smoke ? ['silent'] : ['silent', 'vfr']) {
    const asset = await normalizationFixture(root, id);
    catalog.set(id, await inspectAsset(asset, 'video'));
  }
  const config = {
    shots: [[{ id: 'silent', start: 0, end: .8 }]], ratio: '16:9', resolution: 720,
    fps, fit: 'fit', keepAudio: true, unordered: false, useOriginal: true, useMirrors: false,
    musicIds: [], musicVolume: 50, count: 1, priority: 'picture',
  };
  if (!smoke) {
    config.shots.push([{ id: 'vfr', start: .2, end: 1, speed: 2 }]);
    config.shotTransitions = [{ kind: 'fade-black', duration: .2 }, null];
    config.timelineCaptions = { name: '测试字幕', cues: [{ start: 400, end: 600, text: 'FRAME 12' }] };
    config.subtitleStyle = { size: 32, textColor: '#ffffff', position: 'bottom' };
  }
  const project = path.join(root, '黄金帧.jiajian');
  await saveProject(project, config, catalog);
  const projects = [project];
  if (shiftTransition) {
    assert.ok(!smoke, '单帧转场偏差需运行完整工程');
    config.shotTransitions[0].duration += 1 / fps;
    const changed = path.join(root, '转场多一帧.jiajian');
    await saveProject(changed, config, catalog);
    projects.push(changed);
  }
  return projects;
}

// Runs in the page with its real, paused composition player. Target frame centers
// avoid inclusive/exclusive rounding at a boundary. seeked makes drawImage use the new frame.
async function samplePlayer(frame, fps, width, height) {
  const video = document.getElementById('preview');
  video.pause();
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('预览定位超时，第 ' + frame + ' 帧')), 5000);
    video.addEventListener('seeked', () => { clearTimeout(timeout); resolve(); }, { once: true });
    video.currentTime = (frame + .5) / fps;
  });
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(video, 0, 0, width, height);
  return canvas.toDataURL().split(',')[1];
}

async function render(root, profile, projects) {
  const output = path.join(root, 'export');
  await fs.mkdir(output);
  const win = await launchDesktop({
    show: false, dataDirectory: profile,
    dialogs: { async showOpenDialog(_win, { title }) {
      if (title === '选择导出目录') return { canceled: false, filePaths: [output] };
      assert.equal(title, '打开工程');
      assert.ok(projects.length);
      return { canceled: false, filePaths: [projects.shift()] };
    } },
  });
  const contents = win.webContents;
  const js = (expression) => contents.executeJavaScript(expression, true);
  const click = (selector) => clickVisible(contents, selector);
  async function wait(expression, message) {
    for (const end = Date.now() + 30000; Date.now() < end;) {
      if (await js(expression)) return;
      await delay(50);
    }
    throw new Error(message + ' ' + await js("document.querySelector('#notice').textContent"));
  }
  await click('#home-open-project');
  await wait("document.querySelector('#notice').textContent.includes('已打开工程') && !document.querySelector('#prepare-preview').disabled", '打开黄金帧工程');
  await click('#prepare-preview');
  await wait("document.querySelector('.preview-composition') && !document.querySelector('.preview-composition').disabled", '生成组合');
  await click('.preview-composition');
  await wait("document.querySelector('#preview-name').textContent === '混剪预览 1' && document.querySelector('#preview').readyState >= 2", '播放器解码成片预览');
  const geometry = await js("((v) => [v.videoWidth, v.videoHeight, Math.round(v.duration * 30)])(document.querySelector('#preview'))");
  assert.deepEqual(geometry, [1280, 720, smoke ? 24 : 36], '预览画幅与帧数');
  const frames = [];
  for (const [label, frame] of smoke ? samples.slice(0, 1) : samples) {
    const encoded = await js(`(${samplePlayer})(${frame},${fps},${width},${height})`);
    frames.push({ label, frame, preview: Buffer.from(encoded, 'base64') });
  }
  let previewFile;
  if (!smoke) {
    const response = await contents.session.fetch(await js("document.querySelector('#preview').currentSrc"));
    assert.equal(response.status, 200, '读取与播放器同一个合成资源供音频比较');
    previewFile = path.join(root, 'preview.mp4');
    await fs.writeFile(previewFile, Buffer.from(await response.arrayBuffer()));
  }
  if (shiftTransition) {
    await click('#open-project');
    await wait("document.querySelector('#project-status').textContent.includes('转场多一帧') && !document.querySelector('#start-export').disabled", '打开单帧偏差工程');
  }
  await click('#start-export');
  await wait("document.querySelector('#output-status').textContent.includes('已保存 1 条')", '导出正式 MP4');
  const files = (await fs.readdir(output)).filter(name => name.endsWith('.mp4'));
  assert.equal(files.length, 1);
  assert.equal(projects.length, 0);
  return { frames, previewFile, exportFile: path.join(output, files[0]) };
}

function bitmap(png) {
  const image = nativeImage.createFromBuffer(png);
  assert.deepEqual(image.getSize(), { width, height });
  return image.toBitmap(); // BGRA, both inputs are opaque.
}

function comparePixels(a, b) {
  const diff = Buffer.alloc(a.length, 255);
  let sum = 0;
  for (let i = 0; i < a.length; i += 4) {
    for (let channel = 0; channel < 3; channel++) {
      const delta = Math.abs(a[i + channel] - b[i + channel]);
      sum += delta;
      diff[i + channel] = Math.min(255, 4 * delta);
    }
  }
  return { mae: sum / (width * height * 3), diff };
}

function semanticError(pixels, label, first) {
  const patches = [[64, 36], [192, 36], [64, 108], [192, 108]].map(([x, y]) => {
    const i = (y * width + x) * 4;
    return [pixels[i + 2], pixels[i + 1], pixels[i]];
  });
  // Neither renderer is the oracle. T11 supplies known quadrants and a source-time
  // color switch. The fade center stays black for any duration, so check shoulders too.
  const colors = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0]];
  let expected;
  if (label === 'first') expected = colors;
  if (label === 'fade-out') {
    // This green channel remains below clipping under either SD or HD matrix.
    const i = (36 * width + 192) * 4 + 1;
    const ratio = pixels[i] / first[i];
    if (Math.abs(ratio - 2/3) > fadeRatioTolerance) return '淡出亮度比例 ' + ratio.toFixed(3) + '，预期 2/3';
    expected = colors.map(rgb => rgb.map(c => c * 2 / 3));
  }
  if (label === 'transition-middle') expected = Array(4).fill([0, 0, 0]);
  if (label === 'fade-in') expected = Array(4).fill([170, 0, 0]);
  if (label === 'speed-middle') expected = Array(4).fill([0, 0, 255]);
  if (expected && patches.some((rgb, i) => rgb.some((c, j) => Math.abs(c - expected[i][j]) > colorTolerance))) {
    return '色块 RGB 实测 ' + JSON.stringify(patches) + '，预期 ' + JSON.stringify(expected);
  }
  if (label === 'before-caption' || label === 'caption-onset') {
    let white = 0;
    for (let i = 4 * width * height / 2; i < pixels.length; i += 4) {
      if (Math.min(pixels[i], pixels[i + 1], pixels[i + 2]) > 210) white++;
    }
    // Saturated quadrants contain no white; 25 interior glyph pixels are enough
    // across Windows font versions without binding the golden to a font rasterizer.
    if (label === 'before-caption' ? white > 3 : white < 25) return '字幕区白色像素数 ' + white;
  }
}

async function check(root, profile) {
  const base = process.env.JIAJIAN_TEST_SCREENSHOT ? path.dirname(process.env.JIAJIAN_TEST_SCREENSHOT)
    : path.resolve('run-data/test-artifacts');
  await fs.mkdir(base, { recursive: true });
  const evidence = await fs.mkdtemp(path.join(base, 'golden-frames-'));
  console.log('黄金帧证据', evidence);
  const { frames, previewFile, exportFile } = await render(root, profile, await makeProject(root));
  const info = await inspectAsset(exportFile, 'video');
  assert.deepEqual([info.width, info.height, info.fps, Math.round(info.duration * fps)],
    [1280, 720, fps, smoke ? 24 : 36], '成片画幅、帧率与帧数');
  // Chromium treats an untagged HD picture as BT.709. Set the same fallback for
  // swscale, whose default is BT.601; preserve any matrix actually tagged in the MP4.
  const matrixOption = !info.colorSpace || info.colorSpace === 'unknown' ? ':in_color_matrix=bt709' : '';
  const report = { fps, width, height, maxFrameMae, colorTolerance, fadeRatioTolerance, frames: [] };
  const errors = [];
  let first;
  for (const { label, frame, preview } of frames) {
    const exported = await ffmpeg(['-i', exportFile, '-an', '-vf',
      `select=eq(n\\,${frame}),scale=${width}:${height}:flags=area${matrixOption}`, '-frames:v', '1',
      '-threads', '1', '-c:v', 'png', '-f', 'image2pipe', 'pipe:1']);
    const a = bitmap(preview), b = bitmap(exported);
    const { mae, diff } = comparePixels(a, b);
    first ??= [a, b];
    const issues = [semanticError(a, label, first[0]), semanticError(b, label, first[1])]
      .map((issue, i) => issue && (i ? '成片 ' : '预览 ') + issue).filter(Boolean);
    if (mae > maxFrameMae) issues.push(`RGB 平均绝对差 ${mae.toFixed(3)} 超过 ${maxFrameMae}`);
    report.frames.push({ label, frame, mae, issues });
    if (issues.length || process.env.JIAJIAN_GOLDEN_EVIDENCE === '1') {
      await Promise.all([['preview', preview], ['export', exported],
        ['diff-x4', nativeImage.createFromBitmap(diff, { width, height }).toPNG()]].map(([kind, png]) =>
          fs.writeFile(path.join(evidence, `${frame}-${label}-${kind}.png`), png)));
    }
    errors.push(...issues.map(issue => `${label} 第 ${frame} 帧：${issue}`));
  }
  if (!smoke) {
    try { report.audio = await require('./golden-audio.cjs').compareAudio(previewFile, exportFile); }
    catch (error) {
      report.audioError = error.message;
      errors.push(error.message);
    }
  }
  await fs.writeFile(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2));
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log('黄金帧通过', report.frames.map(row => `${row.label}=${row.mae.toFixed(3)}`).join(' '));
}

async function run() {
  const parent = realpathSync(os.tmpdir());
  const managed = process.env.JIAJIAN_GOLDEN_ROOT;
  const root = managed || mkdtempSync(path.join(parent, 'jiajian-golden-'));
  const profile = path.join(root, 'profile');
  const media = path.join(root, 'media');
  mkdirSync(profile);
  mkdirSync(media);
  app.setPath('userData', profile);
  app.setPath('sessionData', profile);
  // Keep the production preview encoder's own temporary MP4 inside this run as well.
  if (!managed) process.env.TEMP = process.env.TMP = process.env.TMPDIR = root;
  try { await check(media, profile); }
  finally {
    // The runner owns its root and removes it after Electron releases SQLite and cache files.
    if (!managed) {
      const dir = await fs.realpath(root);
      assert.equal(path.dirname(dir), parent);
      assert.ok(path.basename(dir).startsWith('jiajian-golden-'));
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        if (!entry.isDirectory() || !(entry.name === 'media' || entry.name.startsWith('sd-workbench-preview-'))) continue;
        await fs.rm(path.join(dir, entry.name), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      }
      // Some Chromium profile files stay locked until this standalone Electron process exits.
      await fs.rm(dir, { recursive: true, force: true }).catch(error => {
        if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error.code)) throw error;
      });
    }
  }
}

run().then(() => app.exit(0), error => { console.error(error); app.exit(1); });
