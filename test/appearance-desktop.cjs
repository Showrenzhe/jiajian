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

async function until(check, message) {
  const timeout = Date.now() + 8000;
  while (!await check()) {
    if (Date.now() > timeout) throw new Error(message);
    await delay(16);
  }
}

// Runs in the renderer. Composite translucent surfaces before measuring text contrast.
function sampleSurface(selector) {
  const el = document.querySelector(selector);
  if (!el?.checkVisibility()) throw new Error('Expected a visible ' + selector);
  const paint = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  const ancestors = [];
  for (let node = el; node; node = node.parentElement) ancestors.unshift(node);
  for (const node of ancestors) {
    paint.fillStyle = getComputedStyle(node).backgroundColor;
    paint.fillRect(0, 0, 1, 1);
  }
  const background = Array.from(paint.getImageData(0, 0, 1, 1).data);
  paint.fillStyle = getComputedStyle(el).color;
  paint.fillRect(0, 0, 1, 1);
  return { background, foreground: Array.from(paint.getImageData(0, 0, 1, 1).data) };
}

function luminance(channels) {
  const [r, g, b] = channels.map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
  return .2126 * r + .7152 * g + .0722 * b;
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

  const ink = () => colorAt('#home-heading', 'color');
  const darkInk = await ink();
  await media('light', 'reduce');
  await expectMode('system', 'light');
  const lightInk = await ink();
  assert.notEqual(lightInk, darkInk);
  await media('dark', 'reduce');
  await expectMode('system', 'dark');
  assert.equal(await ink(), darkInk, 'Reduced motion should reach the endpoint immediately');

  await media('dark');
  // Collect every rendered frame across a change, then interrupt a second change mid-flight.
  await recordFrames('#home-heading', 'color');
  await media('light');
  await until(async () => (await ink()) === lightInk, 'Appearance transition did not settle');
  assertInterpolated(await stopRecording(), darkInk, lightInk, 'Home heading');
  await recordFrames('#home-heading', 'color');
  await media('dark');
  await until(async () => { const color = await ink(); return color !== darkInk && color !== lightInk; }, 'Second transition did not start');
  await media('light');
  await until(async () => (await ink()) === lightInk, 'Reversing a transition should settle at the latest preference');
  const reversed = await stopRecording();
  assert.ok(!reversed.includes(darkInk), 'Reversal should not flash the discarded endpoint');

  await media('dark', 'reduce');
  await expectMode('system', 'dark');
  await click('#tab-script');
  await until(() => read('document.querySelector("#script-title")?.checkVisibility()'), 'Script editor should open');
  await contrast('#script-title', 'dark');
  await click('#tab-home');
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
