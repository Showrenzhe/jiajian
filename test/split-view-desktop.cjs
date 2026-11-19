'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
const { mkdirSync, mkdtempSync } = require('node:fs');
const path = require('node:path');
const { app } = require('electron');
const { launchDesktop } = require('../src/desktop.cjs');

app.disableHardwareAcceleration();
app.on('web-contents-created', (_event, contents) => {
  contents.on('console-message', ({ level, message }) => { if (level === 'error') console.error(message); });
});

async function run() {
  const parent = path.join(__dirname, '../test-data');
  mkdirSync(parent, { recursive: true });
  const win = await launchDesktop({ show: false, dataDirectory: mkdtempSync(path.join(parent, 'split-view-')) });
  const wc = win.webContents;
  const evaluate = (code) => wc.executeJavaScript(code, true);
  const click = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const settle = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const ids = ['materials', 'inspector', 'timeline'];
  const selectors = ['#materials-pane', '#montage-inspector', '#montage-pane', '.editor-player'];
  const snapshot = () => evaluate(`Object.fromEntries(${JSON.stringify(selectors)}.map(selector =>
    [selector, document.querySelector(selector).getBoundingClientRect().toJSON()]))`);
  const visible = () => evaluate('[...document.querySelectorAll(".workspace-divider")].filter(el => el.checkVisibility()).length');
  function size(boxes, id) {
    return boxes[selectors[ids.indexOf(id)]][id === 'timeline' ? 'height' : 'width'];
  }
  function near(value, expected) { assert.ok(Math.abs(value - expected) <= 1.5, `${value} expected ${expected}`); }
  async function center(id) {
    const point = await evaluate(`(() => {
      const el = document.querySelector('[data-split="${id}"]');
      const r = el.getBoundingClientRect();
      const x = r.x + r.width / 2, y = r.y + r.height / 2;
      return { x, y, hit: document.elementFromPoint(x, y) === el };
    })()`);
    assert.ok(point.hit, id + ' should receive input at the visible seam');
    return { x: point.x, y: point.y };
  }
  wc.debugger.attach();
  const mouse = (type, pos, fields) => wc.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...pos, ...fields });
  async function move(id, distance) {
    const pos = await center(id);
    await mouse('mousePressed', pos, { button: 'left', buttons: 1, clickCount: 1 });
    assert.ok(await evaluate(`document.querySelector('[data-split="${id}"]').hasPointerCapture(1)`), 'drag captures the pointer');
    const end = { ...pos };
    end[id === 'timeline' ? 'y' : 'x'] += distance;
    await mouse('mouseMoved', end, { buttons: 1 });
    await mouse('mouseReleased', end, { button: 'left', clickCount: 1 });
    await settle();
  }
  async function doubleClick(id) {
    const pos = await center(id);
    for (const count of [1, 2]) {
      await mouse('mousePressed', pos, { button: 'left', buttons: 1, clickCount: count });
      await mouse('mouseReleased', pos, { button: 'left', clickCount: count });
    }
    await settle();
  }
  async function key(id, value) {
    await evaluate(`document.querySelector('[data-split="${id}"]').focus()`);
    for (const type of ['keyDown', 'keyUp']) await wc.debugger.sendCommand('Input.dispatchKeyEvent', { type, key: value, code: value });
    await settle();
  }
  async function reopen() {
    const loaded = once(wc, 'did-finish-load');
    wc.reload();
    await loaded;
    await click('#home-create');
    await settle();
  }
  async function contained() {
    const boxes = await snapshot();
    const [width, height] = await evaluate('[innerWidth,innerHeight]');
    const preview = boxes['.editor-player'];
    for (const rect of Object.values(boxes)) assert.ok(rect.x >= 0 && rect.y >= 0 && rect.right <= width + 1 && rect.bottom <= height + 1);
    assert.ok(preview.width >= 201 && preview.height >= 164);
    near(boxes['#materials-pane'].right, preview.left);
    near(boxes['#montage-inspector'].left, preview.right);
    near(boxes['#montage-pane'].top, preview.bottom);
  }

  await click('#home-create');
  await settle();
  assert.equal(await visible(), 3, await evaluate(`[document.querySelector('.app-frame').dataset.mode, document.querySelector('#editor-workspace').outerHTML.slice(0, 150), document.querySelector('#notice').textContent].join(' ')`));
  const original = await snapshot();
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('.workspace-divider')].map(el => {
    const controlled = document.getElementById(el.getAttribute('aria-controls'));
    return [el.getAttribute('role'), el.getAttribute('aria-orientation'), controlled?.checkVisibility(), el.tabIndex];
  })`), [['separator', 'vertical', true, 0], ['separator', 'vertical', true, 0], ['separator', 'horizontal', true, 0]]);
  for (const id of ids) {
    const sign = id === 'materials' ? 1 : -1;
    const start = size(await snapshot(), id);
    await move(id, sign * 40);
    near(size(await snapshot(), id), start + 40);
    await move(id, -sign * 22);
    near(size(await snapshot(), id), start + 18);
    await key(id, id === 'materials' ? 'ArrowRight' : id === 'inspector' ? 'ArrowLeft' : 'ArrowUp');
    near(size(await snapshot(), id), start + 26);
    await doubleClick(id);
    near(size(await snapshot(), id), size(original, id));
    await move(id, sign * 45);
  }
  const changed = await snapshot();
  await reopen();
  for (const id of ids) near(size(await snapshot(), id), size(changed, id));

  const originalWindow = win.getSize();
  win.setSize(850, 600);
  await settle();
  await contained();
  win.setSize(...originalWindow);
  await settle();
  for (const id of ids) near(size(await snapshot(), id), size(changed, id));
  win.setSize(850, 600);
  await settle();
  for (const id of ids) {
    for (const endpoint of ['Home', 'End']) {
      await key(id, endpoint);
      const limit = await evaluate(`document.querySelector('[data-split="${id}"]').getAttribute('aria-value${endpoint === 'Home' ? 'min' : 'max'}')`);
      near(size(await snapshot(), id), Number(limit));
      await contained();
    }
    await doubleClick(id);
  }
  win.setSize(...originalWindow);
  await settle();
  await move('materials', 20);
  const beforeEditing = await snapshot();
  await click('#panel-layout-toggle');
  await settle();
  assert.equal(await visible(), 0);
  await click('#panel-layout-toggle');
  await settle();
  assert.equal(await visible(), 3);
  near(size(await snapshot(), 'materials'), size(beforeEditing, 'materials'));
  const legacy = { version: 1, order: ['player', 'materials', 'inspector', 'timeline'], boxes: {
    player: { x: .22, y: .03, width: .48, height: .49 }, materials: { x: .01, y: .02, width: .21, height: .53 },
    inspector: { x: .72, y: .04, width: .27, height: .47 }, timeline: { x: .01, y: .57, width: .97, height: .42 },
  } };
  await evaluate(`localStorage.setItem('sd-workbench-panel-layout-v1', ${JSON.stringify(JSON.stringify(legacy))})`);
  await reopen();
  assert.equal(await visible(), 0);
  assert.equal(await evaluate('document.querySelector("#editor-workspace").dataset.panelLayout'), 'custom');
  await click('#panel-layout-toggle');
  await settle();
  assert.equal(await visible(), 0);
  await click('#panel-layout-reset');
  await settle();
  assert.equal(await visible(), 3);
  for (const id of ids) near(size(await snapshot(), id), size(original, id));
  await click('#title-home');
  assert.equal(await visible(), 0);
  wc.debugger.detach();
  console.log('Passed native divider drag, reverse, keyboard, double click, bounds, persistence, and legacy reset.');
  win.close();
}

run().catch((error) => { console.error(error); app.exit(1); });
