'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { mkdirSync, mkdtempSync } = require('node:fs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { app, nativeImage, nativeTheme } = require('electron');
const { launchDesktop } = require('../src/desktop.cjs');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('force-device-scale-factor', '1');

async function until(check, message) {
  const timeout = Date.now() + 8000;
  while (!await check()) {
    if (Date.now() > timeout) throw new Error(message);
    await delay(16);
  }
}

// Runs in the renderer. Composite translucent surfaces before measuring text contrast.
function sampleSurface(selector, paint = document.createElement('canvas').getContext('2d', { willReadFrequently: true })) {
  const el = document.querySelector(selector);
  if (!el?.checkVisibility()) throw new Error('Expected a visible ' + selector);
  paint.clearRect(0, 0, 1, 1);
  const ancestors = [];
  for (let node = el; node; node = node.parentElement) ancestors.unshift(node);
  for (const node of ancestors) {
    paint.fillStyle = getComputedStyle(node).backgroundColor;
    paint.fillRect(0, 0, 1, 1);
  }
  const background = Array.from(paint.getImageData(0, 0, 1, 1).data);
  const ink = getComputedStyle(el).color;
  paint.fillStyle = ink;
  paint.fillRect(0, 0, 1, 1);
  return { ink, background, foreground: Array.from(paint.getImageData(0, 0, 1, 1).data) };
}

function luminance(channels) {
  const [r, g, b] = channels.map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
  return .2126 * r + .7152 * g + .0722 * b;
}

// On Windows the open select is a separate Chromium surface. capturePage() only
// includes the underlying inspector; the offscreen paint event includes both.
async function checkDarkRatioMenu(wc, read, key) {
  const box = await read("document.querySelector('#ratio').getBoundingClientRect().toJSON()");
  const clip = { x: Math.ceil(box.left), y: Math.round(box.bottom) + 2, width: Math.floor(box.width) - 2, height: 66 };
  const sample = (bitmap, x, y) => {
    const offset = 4 * (y * clip.width + x);
    return [bitmap[offset + 2], bitmap[offset + 1], bitmap[offset]];
  };
  const markerX = clip.width - 8;
  const before = sample((await wc.capturePage(clip)).toBitmap(), markerX, 2);
  let menu;
  const onPaint = (_event, _dirty, frame) => {
    if (frame.isEmpty()) return;
    const pixels = frame.crop(clip).toBitmap();
    const highlight = sample(pixels, markerX, 2);
    const normal = sample(pixels, markerX, 32);
    if (highlight.some((v, i) => v !== before[i]) && highlight.some((v, i) => v !== normal[i])) menu = pixels;
  };
  wc.on('paint', onPaint);
  try {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
        type, x: box.x + box.width / 2, y: box.y + box.height / 2, button: 'left', clickCount: 1,
      });
    }
    await until(async () => menu && await read("document.querySelector('#ratio').matches(':open')"), 'Missing open ratio menu paint');
    // The first row is selected. Its trailing highlight ends where the 9:16 row begins.
    const selected = sample(menu, markerX, 2);
    let rowStart = 3;
    while (rowStart < clip.height && sample(menu, markerX, rowStart).every((v, i) => v === selected[i])) rowStart++;
    assert.ok(rowStart > 10 && rowStart * 2 <= clip.height, 'Expected a complete unselected row');
    const background = luminance(sample(menu, markerX, rowStart + 3));
    assert.ok(background < .25, 'Dark ratio menu painted a light background');
    let legiblePixels = 0;
    for (let y = rowStart + 2; y < rowStart * 2 - 2; y++) {
      for (let x = 5; x < clip.width / 2; x++) {
        if ((luminance(sample(menu, x, y)) + .05) / (background + .05) >= 4.5) legiblePixels++;
      }
    }
    assert.ok(legiblePixels >= 8, 'Expected legible 9:16 text on the open menu');
    await key('Escape', 27);
    await until(() => read("!document.querySelector('#ratio').matches(':open')"), 'Escape should dismiss the ratio menu');
    assert.equal(await read("document.querySelector('#ratio').value"), '16:9');
  } finally {
    wc.removeListener('paint', onPaint);
  }
}

function assertTextFrames(frames, selectors, checkSingleHandoff = false) {
  let minimum = Infinity;
  for (const [i, label] of selectors.entries()) {
    const polarities = [];
    for (const { samples } of frames) {
      const { foreground, background } = samples[i];
      const fg = luminance(foreground), bg = luminance(background);
      const ratio = (Math.max(bg, fg) + .05) / (Math.min(bg, fg) + .05);
      assert.ok(background[3] === 255 && ratio >= 4.5, label + ' contrast = ' + ratio.toFixed(2));
      minimum = Math.min(minimum, ratio);
      if (polarities.at(-1) !== (fg > bg)) polarities.push(fg > bg);
    }
    if (checkSingleHandoff) assert.deepEqual(polarities, [false, true], label + ' text should change polarity once');
  }
  return minimum;
}

async function worker(phase, root) {
  const picture = path.join(root, '预览色卡.png');
  nativeTheme.themeSource = 'light';
  let firstPaintDarkFraction;
  if (phase === 'cold') {
    app.once('web-contents-created', (_event, contents) => {
      contents.on('paint', (_paintEvent, _dirty, frame) => {
        if (firstPaintDarkFraction !== undefined || frame.isEmpty()) return;
        const bitmap = frame.resize({ width: 160, height: 100 }).toBitmap();
        const brightness = [];
        for (let i = 0; i < bitmap.length; i += 4) {
          brightness.push((bitmap[i] + bitmap[i + 1] + bitmap[i + 2]) / 3);
        }
        // Ignore Chromium's uniform frame before the page paints its content.
        if (Math.max(...brightness) - Math.min(...brightness) > 55) {
          firstPaintDarkFraction = brightness.filter(v => v < 128).length / brightness.length;
        }
      });
    });
  }
  const win = await launchDesktop({ show: false, dataDirectory: path.join(root, 'profile'), dialogs: {
    async showOpenDialog() { return { canceled: false, filePaths: [picture] }; },
  } });
  const wc = win.webContents;
  if (!wc.debugger.isAttached()) wc.debugger.attach();
  const read = code => wc.executeJavaScript(code, true);
  const click = selector => read('document.querySelector(' + JSON.stringify(selector) + ').click()');
  const mode = () => read('[document.documentElement.dataset.appearance, document.documentElement.dataset.theme]');
  const expectMode = (preference, effective) => until(async () => {
    const [p, e] = await mode();
    return p === preference && e === effective;
  }, 'Expected ' + preference + ' to resolve to ' + effective);
  const radio = value => 'input[name="appearance"][value="' + value + '"]';
  const media = (scheme, motion = 'no-preference') => wc.debugger.sendCommand('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: scheme }, { name: 'prefers-reduced-motion', value: motion }],
  });
  const key = async (keyName, code) => {
    for (const type of ['keyDown', 'keyUp']) {
      await wc.debugger.sendCommand('Input.dispatchKeyEvent', { type, key: keyName, code: keyName, windowsVirtualKeyCode: code });
    }
  };
  const settings = async () => {
    await click('#app-settings');
    await until(() => read('document.querySelector("#cloud-settings-dialog").open'), 'Settings should open');
  };
  const close = async () => {
    await key('Escape', 27);
    await until(() => read('!document.querySelector("#cloud-settings-dialog").open'), 'Esc should close Settings');
  };
  const colorAt = (selector, property) => read('getComputedStyle(document.querySelector(' + JSON.stringify(selector) + ')).' + property);
  const recordFrames = (selector, property) => read(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    const samples = [getComputedStyle(node).${property}];
    function record() {
      samples.push(getComputedStyle(node).${property});
      window.appearanceFrame = requestAnimationFrame(record);
    }
    window.appearanceSamples = samples;
    window.appearanceFrame = requestAnimationFrame(record);
  })()`);
  const stopRecording = () => read('cancelAnimationFrame(window.appearanceFrame); window.appearanceSamples');
  function assertInterpolated(frames, start, end, label) {
    assert.notEqual(start, end, label + ' should have distinct endpoint colors');
    const intermediate = new Set(frames.filter(c => c !== start && c !== end));
    assert.ok(intermediate.size >= 2, label + ' should ease between endpoints: ' + frames.join(', '));
  }
  async function contrast(selector, theme) {
    const { background, foreground } = await read('(' + sampleSurface + ')(' + JSON.stringify(selector) + ')');
    const bg = luminance(background), fg = luminance(foreground);
    assert.equal(background[3], 255, selector + ' should composite on an opaque backdrop');
    if (theme === 'dark' ? bg >= .25 : bg <= .55) {
      const layers = await read('(() => { const colors = []; for (let n = document.querySelector(' + JSON.stringify(selector) + '); n; n = n.parentElement) { const css = getComputedStyle(n); colors.push([n.id || n.tagName, css.backgroundColor, css.colorScheme]); } return colors; })()');
      assert.fail(selector + ' ' + theme + ' background = ' + background + ', layers = ' + JSON.stringify(layers));
    }
    const ratio = (Math.max(bg, fg) + .05) / (Math.min(bg, fg) + .05);
    assert.ok(ratio >= 4.5, selector + ' text contrast = ' + ratio.toFixed(2));
  }

  if (phase === 'cold') {
    await expectMode('dark', 'dark');
    wc.invalidate();
    await until(() => firstPaintDarkFraction !== undefined, 'Missing first content paint');
    assert.ok(firstPaintDarkFraction > .75, 'First content paint should already be dark, dark fraction = ' + firstPaintDarkFraction);
    await settings();
    assert.equal(await read('document.querySelector(' + JSON.stringify(radio('dark')) + ').checked'), true);
    return;
  }

  await expectMode('system', 'light');
  await wc.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
  await media('light', 'reduce');
  await contrast('#draft-search', 'light');
  await settings();
  assert.deepEqual((await read('Array.from(document.querySelectorAll("#cloud-settings-dialog input[name=appearance]"), n => n.value)')).sort(),
    ['dark', 'light', 'system']);
  assert.equal(await read('document.querySelector("#cloud-settings-base-url").checkVisibility()'), true);
  await click(radio('dark'));
  await expectMode('dark', 'dark');
  await contrast('#cloud-settings-base-url', 'dark');
  await media('dark', 'reduce');
  await media('light', 'reduce');
  await delay(100);
  assert.deepEqual(await mode(), ['dark', 'dark'], 'Manual appearance should survive OS changes');

  // Native radio-group arrow navigation and Escape must also work from the keyboard.
  await read('document.querySelector(' + JSON.stringify(radio('dark')) + ').focus()');
  await key('ArrowRight', 39);
  assert.notEqual((await mode())[0], 'dark', 'ArrowRight should select the adjacent appearance');
  await click(radio('light'));
  await expectMode('light', 'light');
  await media('dark', 'reduce');
  await delay(100);
  assert.deepEqual(await mode(), ['light', 'light']);
  await click(radio('system'));
  await expectMode('system', 'dark');
  await close();
  await contrast('#draft-search', 'dark');

  await settings();
  const labels = [
    '#cloud-settings-title', '#cloud-settings-key-label', '.appearance-options input[value=system] ~ span:last-child',
    '#app-settings', '#home-heading', '#draft-heading-label', '#draft-status-title', '#cloud-settings-base-url', '#cloud-settings-api-key',
  ];
  const surfaceIndex = labels.indexOf('#draft-heading-label');
  const expectedInk = {};
  for (const theme of ['dark', 'light']) {
    await click(radio(theme));
    await expectMode(theme, theme);
    expectedInk[theme] = await Promise.all(labels.map(selector => colorAt(selector, 'color')));
  }
  for (const [i, selector] of labels.entries()) {
    assert.notEqual(expectedInk.light[i], expectedInk.dark[i], selector + ' should have distinct endpoint colors');
  }
  await media('light');
  // Step the actual root animation at equal time intervals. This distinguishes a
  // single ease from two fades that decelerate and pause around middle gray.
  const curve = await read(`(async () => {
    document.querySelector('input[name=appearance][value=dark]').click();
    const animation = document.documentElement.getAnimations().find(a => a.effect.getKeyframes().some(k => '--appearance-mix' in k));
    animation.pause();
    await animation.ready;
    const paint = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    const sample = ${sampleSurface};
    const result = [];
    for (let i = 0; i <= 120; i++) {
      animation.currentTime = animation.effect.getTiming().duration * i / 120;
      result.push({ samples: ${JSON.stringify(labels)}.map(s => sample(s, paint)) });
    }
    animation.play();
    return result;
  })()`);
  const curveContrast = assertTextFrames(curve, labels, true);
  const levels = curve.filter((_, i) => i % 10 === 0).map(frame => frame.samples[surfaceIndex].background[1]);
  const deltas = levels.slice(1).map((n, i) => levels[i] - n);
  console.log('25 ms surface samples:', levels.join(', '));
  assert.ok(deltas.every(d => d >= 0) && Math.min(...deltas.slice(3, 8)) > 8,
    'The surface must keep moving through the middle of the fade: ' + levels.join(', '));
  await until(() => read('!document.documentElement.hasAttribute("data-theme-changing")'), 'Completing sampled transition');
  await media('light', 'reduce');
  await click(radio('light'));
  await expectMode('light', 'light');
  await media('light');
  await wc.debugger.sendCommand('Animation.enable');
  await wc.debugger.sendCommand('Animation.setPlaybackRate', { playbackRate: .5 });
  // Sample inherited Chinese labels, native controls and real surface colors through cleanup and a rapid reversal.
  const { frames, reversalStart, reversedAt, firstEnd } = await read(`(async () => {
    const sample = ${sampleSurface};
    const selectors = ${JSON.stringify(labels)};
    const paint = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    const frames = [];
    function record() {
      frames.push({ theme: document.documentElement.dataset.theme, samples: selectors.map(s => sample(s, paint)) });
    }
    async function switchTo(theme, waitMs) {
      document.querySelector('input[name=appearance][value=' + theme + ']').click();
      record();
      const start = performance.now();
      while (performance.now() - start < waitMs) {
        await new Promise(requestAnimationFrame);
        record();
      }
    }
    record();
    await switchTo('dark', 850);
    const firstEnd = frames.length - 1;
    await switchTo('light', 850);
    const reversalStart = frames.length;
    const panelColor = () => frames.at(-1).samples[${surfaceIndex}].background.join(',');
    const restingColor = panelColor();
    await switchTo('dark', 0);
    const timeout = performance.now() + 850;
    while (panelColor() === restingColor && performance.now() < timeout) {
      await new Promise(requestAnimationFrame);
      record();
    }
    const reversedAt = frames.length;
    await switchTo('light', 850);
    return { frames, reversalStart, reversedAt, firstEnd };
  })()`);
  await wc.debugger.sendCommand('Animation.setPlaybackRate', { playbackRate: 1 });
  const completeChanges = frames.slice(0, reversalStart);
  const observed = completeChanges.map(f => f.theme);
  assert.deepEqual(observed.filter((t, i) => !i || t !== observed[i - 1]), ['light', 'dark', 'light'],
    'Each change should hand off once without reverting');
  // The draft heading sits on the opaque content panel. Bound changes to its displayed sRGB
  // levels so one large jump followed by several almost identical shades cannot pass.
  const peakSteps = [];
  for (const section of [completeChanges.slice(0, firstEnd + 1), completeChanges.slice(firstEnd)]) {
    const levels = section.map(frame => {
      const [r, g, b] = frame.samples[surfaceIndex].background;
      return .2126 * r + .7152 * g + .0722 * b;
    });
    const span = Math.abs(levels.at(-1) - levels[0]);
    assert.ok(span > 100, 'The content panel should complete the full theme change');
    const largestStep = Math.max(...levels.slice(1).map((level, i) => Math.abs(level - levels[i])));
    peakSteps.push(Math.round(100 * largestStep / span));
    assert.ok(largestStep / span < .40, 'One frame covered ' + Math.round(100 * largestStep / span) + '% of the surface change');
    const settled = section.at(-1);
    assert.deepEqual(settled.samples.map(s => s.ink), expectedInk[settled.theme], 'Settled text should match the saved palette');
  }
  assert.ok(frames.slice(reversalStart).every(f => f.theme === 'light'),
    'Reversing before the palette handoff should not flash the abandoned theme');
  assert.notDeepEqual(frames[reversedAt - 1].samples[surfaceIndex].background, frames[reversalStart - 1].samples[surfaceIndex].background,
    'The interrupted transition should already have begun changing the surface');
  const minimumContrast = Math.min(curveContrast, assertTextFrames(frames, labels));
  console.log(`文字最低对比度 ${minimumContrast.toFixed(2)}:1，浅→深 / 深→浅最大单帧亮度跨度 ${peakSteps.join('% / ')}%。`);
  await click(radio('system'));
  await expectMode('system', 'light');
  await close();

  await media('dark', 'reduce');
  await expectMode('system', 'dark');
  assert.equal(await colorAt('#home-heading', 'color'), expectedInk.dark[labels.indexOf('#home-heading')],
    'System changes with reduced motion should reach the endpoint immediately');
  await click('#tab-script');
  await until(() => read('document.querySelector("#script-title")?.checkVisibility()'), 'Script editor should open');
  await contrast('#script-title', 'dark');
  await click('#tab-home');
  if (process.platform === 'win32') {
    await click('#home-create');
    await until(() => read("document.querySelector('#ratio').checkVisibility()"), 'Expected the ratio selector');
    await checkDarkRatioMenu(wc, read, key);
    await click('#title-home');
  }
  // A real opaque PNG should keep its pixel values in the editor throughout a theme change.
  const bitmap = Buffer.alloc(160 * 90 * 4);
  for (let i = 0; i < bitmap.length; i += 4) bitmap.set([180, 48, 180, 255], i);
  await fs.writeFile(picture, nativeImage.createFromBitmap(bitmap, { width: 160, height: 90 }).toPNG());
  await click('#home-import');
  await until(() => read('!!document.querySelector("#material-list .material-tile")'), 'The test image should import');
  await click('#material-list .material-tile');
  await until(() => read('document.querySelector("#still-preview").naturalWidth === 160 && document.querySelector("#still-preview").checkVisibility()'), 'Still preview should open');
  await contrast('#material-search', 'dark');
  async function mediaPixel() {
    const clip = await read("(() => { const b = document.querySelector('#still-preview').getBoundingClientRect(); return {x: Math.floor(b.x + b.width / 2), y: Math.floor(b.y + b.height / 2), width: 2, height: 2, scale: 1}; })()");
    const { data } = await wc.debugger.sendCommand('Page.captureScreenshot', { clip });
    return Array.from(nativeImage.createFromBuffer(Buffer.from(data, 'base64')).toBitmap().subarray(0, 4));
  }
  const original = await mediaPixel();
  assert.ok(original[0] >= 170 && original[1] <= 55 && original[2] >= 170, 'Expected test image pixel, got ' + original);
  const timeline = () => colorAt('#montage-pane', 'backgroundColor');
  const darkTimeline = await timeline();
  await media('light', 'reduce');
  await expectMode('system', 'light');
  const lightTimeline = await timeline();
  await media('dark', 'reduce');
  await expectMode('system', 'dark');
  await media('dark');
  await recordFrames('#montage-pane', 'backgroundColor');
  await media('light');
  await expectMode('system', 'light');
  assert.deepEqual(await mediaPixel(), original, 'Preview pixels should remain stable during the transition');
  await until(async () => (await timeline()) === lightTimeline, 'Timeline surface did not settle');
  assertInterpolated(await stopRecording(), darkTimeline, lightTimeline, 'Timeline surface');
  await until(() => read("!document.getAnimations().some(a => a instanceof CSSTransition && ['color','background-color'].includes(a.transitionProperty) && a.playState === 'running')"),
    'Editor text and surfaces should finish changing');
  await contrast('#material-search', 'light');
  assert.deepEqual(await mediaPixel(), original, 'Preview pixels should remain stable after the transition');
  await settings();
  await click(radio('dark'));
  await expectMode('dark', 'dark');
  await close();
  await wc.session.flushStorageData();
}

async function run() {
  const [phase, profile] = process.argv.slice(2);
  if (phase) return worker(phase, profile);
  const root = mkdtempSync(path.join(os.tmpdir(), 'jiajian-appearance-'));
  const coordinator = path.join(root, 'coordinator');
  mkdirSync(coordinator);
  app.setPath('userData', coordinator);
  try {
    for (const task of ['edit', 'cold']) {
      const child = spawn(process.execPath, [__filename, task, root], { stdio: 'inherit', windowsHide: true });
      const [code] = await once(child, 'exit');
      assert.equal(code, 0, task + ' appearance checks failed');
    }
    console.log('Appearance, transition, preview pixel and cold-start checks passed.');
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

run().then(() => app.exit(0), error => { console.error(error); app.exit(1); });
