'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { app, nativeTheme } = require('electron');
const { launchDesktop } = require('../src/desktop.cjs');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('force-device-scale-factor', '1');

async function until(check, message) {
  const deadline = Date.now() + 8000;
  while (!await check()) {
    if (Date.now() > deadline) throw Error(message);
    await delay(35);
  }
}

async function run() {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'jiajian-wheel-'));
  nativeTheme.themeSource = 'light';
  const win = await launchDesktop({ show: false, dataDirectory: profile });
  const wc = win.webContents;
  wc.debugger.attach();
  const read = js => wc.executeJavaScript(js, true);
  const dom = selector => 'document.querySelector(' + JSON.stringify(selector) + ')';
  const click = selector => read(dom(selector) + '.click()');
  const color = '#background-color', disc = '.color-wheel-disc', panel = '.color-wheel-panel';
  const value = selector => read(dom(selector) + '.value');
  const key = async (name, keyCode, modifiers = 0) => {
    for (const type of ['keyDown', 'keyUp']) await wc.debugger.sendCommand('Input.dispatchKeyEvent', {
      type, key: name, code: name, windowsVirtualKeyCode: keyCode, modifiers,
    });
  };
  const mouse = (type, x, y) => wc.debugger.sendCommand('Input.dispatchMouseEvent', {
    type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1,
  });
  const exact = async code => {
    await read(dom('[data-hex]') + '.focus(); ' + dom('[data-hex]') + '.value = ' + JSON.stringify(code));
    await key('Enter', 13);
  };
  const box = selector => read(dom(selector) + '.getBoundingClientRect().toJSON()');
  const inspectSwatch = async selector => {
    const { width, height } = await box(selector);
    assert.ok(width >= 36 && height >= 24, selector + ' should retain its click target');
    const appearance = await read(`(() => {
      const field = ${dom(selector)}, style = getComputedStyle(field);
      return [style.backgroundColor, style.borderTopWidth, style.borderRadius, style.boxShadow, field.labels.length > 0];
    })()`);
    assert.deepEqual(appearance, ['rgba(0, 0, 0, 0)', '0px', '0px', 'none', true], selector);
  };
  const captureRow = async (selector, name) => {
    const target = process.argv[2];
    if (!target) return;
    await read(dom(selector) + ".scrollIntoView({ block: 'center', behavior: 'instant' })");
    await read('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const row = await box(selector);
    const neighbors = await read(`(() => {
      const row = ${dom(selector)}, previous = row.previousElementSibling;
      const above = previous.matches('.settings-grid') ? previous.lastElementChild : previous;
      return { top: above.getBoundingClientRect().top, bottom: row.nextElementSibling.getBoundingClientRect().bottom };
    })()`);
    const viewport = await read('({ width: innerWidth, height: innerHeight })');
    const x = Math.max(0, Math.floor(row.left - 8)), y = Math.max(0, Math.floor(neighbors.top - 2));
    const clip = { x, y, width: Math.min(viewport.width, Math.ceil(row.right + 8)) - x,
      height: Math.min(viewport.height, Math.ceil(neighbors.bottom + 2)) - y };
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, name + '.png'), (await wc.capturePage(clip)).toPNG());
  };
  const capture = async name => {
    const target = process.argv[2];
    if (!target) return;
    const bounds = await box(panel), anchor = await box(color);
    const viewport = await read('({ width: innerWidth, height: innerHeight })');
    const x = Math.max(0, Math.floor(Math.min(bounds.left, anchor.left) - 56));
    const y = Math.max(0, Math.floor(Math.min(bounds.top, anchor.top) - 68));
    const clip = { x, y, width: Math.min(viewport.width, Math.ceil(Math.max(anchor.right, bounds.right) + 18)) - x,
      height: Math.min(viewport.height, Math.ceil(bounds.bottom + 30)) - y };
    await read('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, name + '.png'), (await wc.capturePage(clip)).toPNG());
  };
  await click('#home-create');
  await until(() => read(dom(color) + '.checkVisibility()'), 'Missing background color input');
  const captionRow = '.caption-field:has(.caption-colors)';
  await click('#inspector-tab-subtitles');
  for (const selector of ['#caption-color', '#caption-outline']) await inspectSwatch(selector);
  await captureRow(captionRow, '扁平色片-浅色-字幕');
  await click('.caption-colors label');
  assert.equal(await value('[data-hex]'), '#FFFFFF');
  await key('Escape', 27);
  await click('#inspector-tab-visual');
  await inspectSwatch(color);
  await read(`window.colorEvents = [];
    for (const type of ['input', 'change']) ${dom(color)}.addEventListener(type, e => colorEvents.push(e.type));`);
  await read(dom(color) + '.focus()');
  await key('Enter', 13);
  assert.equal(await read(dom(disc) + ' === document.activeElement'), true);
  assert.equal(await value('[data-hex]'), '#000000');
  assert.equal(await read(dom('[data-dropper]') + '.hidden'), await read("typeof EyeDropper !== 'function'"));
  await capture('圆形色轮-浅色-留边背景');
  const wheel = await box(disc);
  const cx = wheel.x + wheel.width / 2, cy = wheel.y + wheel.height / 2;
  await mouse('mousePressed', cx, cy);
  await mouse('mouseMoved', cx + wheel.width / 2 - 2, cy);
  await mouse('mouseReleased', cx + wheel.width / 2 - 2, cy);
  assert.match(await value(color), /^#0[0-9a-f]0[0-9a-f]ff$/);
  assert.equal((await read('colorEvents')).at(-1), 'change');
  const before = await value(color);
  await key('ArrowLeft', 37, 1);
  assert.notEqual(await value(color), before);
  await read(dom('[data-axis=v]') + '.focus()');
  await key('Home', 36);
  assert.equal(await value(color), '#000000');
  await key('End', 35);
  assert.notEqual(await value(color), '#000000');
  await exact('ffffff');
  assert.equal(await value(color), '#ffffff');
  assert.equal(await value('[data-channel="0"]'), '255');
  await key('Escape', 27);
  await until(() => read('!' + dom(panel)), 'Return to the white background swatch');
  await read(dom(color) + '.blur()');
  await captureRow('#background-color-row', '扁平色片-浅色-留边背景');
  await click(color);
  const redField = dom('[data-channel="0"]');
  await read(redField + ".focus(); " + redField + ".select()");
  await wc.debugger.sendCommand('Input.insertText', { text: '37' });
  await key('Enter', 13);
  assert.equal(await value(color), '#25ffff');
  assert.equal(await value('[data-hex]'), '#25FFFF');
  await exact('#5898CF');
  assert.equal(await value(color), '#5898cf');
  await exact('wrong');
  assert.equal(await value('[data-hex]'), '#5898CF');
  // A live theme switch should update the already-open panel.
  await wc.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [
    { name: 'prefers-color-scheme', value: 'dark' }, { name: 'prefers-reduced-motion', value: 'reduce' },
  ] });
  await until(() => read("document.documentElement.dataset.theme === 'dark'"), 'Missing dark palette');
  await read(dom(disc) + '.focus()');
  await capture('圆形色轮-深色-留边背景');
  await key('Escape', 27);
  await until(() => read('!' + dom(panel)), 'Escape should remove the picker');
  assert.equal(await read(dom(color) + ' === document.activeElement'), true);
  assert.ok(await read(dom(color) + ".matches(':focus-visible') && getComputedStyle(document.activeElement).outlineStyle === 'solid'"));
  await read(dom(color) + '.blur()');
  await captureRow('#background-color-row', '扁平色片-深色-留边背景');
  const anchor = await box(color);
  for (const type of ['mousePressed', 'mouseReleased']) await mouse(type, anchor.x + anchor.width / 2, anchor.y + anchor.height / 2);
  assert.equal(await value('[data-hex]'), '#5898CF');
  await read(dom('[data-close]') + '.focus()');
  await key('Tab', 9, 8);
  assert.equal(await read(dom('[data-channel="2"]') + ' === document.activeElement'), true);
  for (const type of ['mousePressed', 'mouseReleased']) await mouse(type, 10, 10);
  await until(() => read('!' + dom(panel)), 'Outside click should dismiss the picker');
  await until(() => read(`(async () => { const drafts = await workbench.listDrafts();
    if (!drafts.length) return false;
    return (await workbench.openDraft(drafts[0].id)).config.backgroundColor === '#5898cf'; })()`), 'Draft should retain the chosen color');
  await click('#inspector-tab-subtitles');
  await captureRow(captionRow, '扁平色片-深色-字幕');
  // Open the real nested bulk editor and its dynamically constructed color control.
  await click('#timeline-text-tools');
  await read("document.querySelector('.sequence-dialog details').open = true");
  const nested = '.sequence-dialog [name=color]';
  await inspectSwatch(nested);
  await click(nested);
  assert.equal(await read(dom(panel) + ".matches(':modal')"), true);
  await exact('a10c77');
  await key('Escape', 27);
  await until(() => read('!' + dom(panel)), 'Nested picker should close');
  assert.equal(await read(dom('.sequence-dialog') + ".matches(':modal')"), true);
  assert.equal(await read(dom(nested) + ' === document.activeElement'), true);
  assert.equal(await value(nested), '#a10c77');
  console.log('Color wheel pointer, keyboard, HEX/RGB, themes, persisted draft and nested-dialog checks passed.');
  win.destroy();
}

run().then(() => app.exit(0), error => { console.error(error); app.exit(1); });
