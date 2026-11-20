'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
const { mkdirSync, mkdtempSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { app } = require('electron');
const { launchDesktop } = require('../src/desktop.cjs');

app.disableHardwareAcceleration();
app.setVersion(require('../package.json').version);
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
  const paneSelectors = Object.fromEntries([...ids, 'player'].map((id, index) => [id, selectors[index]]));
  const snapshot = () => evaluate(`Object.fromEntries(${JSON.stringify(selectors)}.map(selector =>
    [selector, document.querySelector(selector).getBoundingClientRect().toJSON()]))`);
  const visible = () => evaluate('[...document.querySelectorAll(".workspace-divider")].filter(el => el.checkVisibility()).length');
  function size(boxes, id) {
    return boxes[selectors[ids.indexOf(id)]][id === 'timeline' ? 'height' : 'width'];
  }
  function near(value, expected) { assert.ok(Math.abs(value - expected) <= 1.5, `${value} expected ${expected}`); }
  async function center(selector) {
    const point = await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      const r = el.getBoundingClientRect();
      const x = r.x + r.width / 2, y = r.y + r.height / 2;
      return { x, y, hit: el.contains(document.elementFromPoint(x, y)) };
    })()`);
    assert.ok(point.hit, selector + ' should receive input at the visible seam');
    return { x: point.x, y: point.y };
  }
  wc.debugger.attach();
  await wc.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
  const mouse = (type, pos, fields) => wc.debugger.sendCommand('Input.dispatchMouseEvent', {
    type, ...pos, button: fields.buttons === 1 ? 'left' : 'none', ...fields,
  });
  async function checkHandlePaint(selector, keyboard = false) {
    const visual = await evaluate(`(() => {
      const handle = document.querySelector(${JSON.stringify(selector)});
      const style = getComputedStyle(handle);
      const paint = document.createElement('canvas').getContext('2d');
      function painted(layer) {
        paint.clearRect(0, 0, 1, 1);
        paint.fillStyle = layer.backgroundColor;
        paint.fillRect(0, 0, 1, 1);
        return paint.getImageData(0, 0, 1, 1).data[3] > 0 || layer.backgroundImage !== 'none' || layer.boxShadow !== 'none';
      }
      const decoration = ['::before', '::after'].some(pseudo => {
        const layer = getComputedStyle(handle, pseudo);
        return !['none', 'normal'].includes(layer.content) && painted(layer);
      });
      return { marked: painted(style) || style.outlineStyle !== 'none' || decoration, focus: handle.matches(':focus-visible') };
    })()`);
    assert.equal(visual.marked, keyboard, selector + ' has a visible focus indicator only during keyboard use');
    if (keyboard) assert.ok(visual.focus, selector + ' should have keyboard focus');
  }
  async function move(id, distance, { offset = 0, cancel = false, checkPaint = false, capture } = {}) {
    const selector = `[data-split="${id}"]`;
    const pos = await center(selector);
    const axis = id === 'timeline' ? 'y' : 'x';
    pos[axis] += offset;
    const before = await snapshot();
    await mouse('mouseMoved', pos, {});
    assert.ok(await evaluate(`document.elementFromPoint(${pos.x}, ${pos.y}).matches('${selector}:hover')`), id + ' receives hover on both sides of the gutter');
    if (checkPaint) await checkHandlePaint(selector);
    await mouse('mousePressed', pos, { button: 'left', buttons: 1, clickCount: 1 });
    assert.ok(await evaluate(`document.querySelector('[data-split="${id}"]').hasPointerCapture(1)`), 'drag captures the pointer');
    const end = { ...pos };
    end[axis] += distance;
    await mouse('mouseMoved', end, { buttons: 1 });
    await settle();
    if (checkPaint) {
      assert.equal(await evaluate(`getComputedStyle(document.elementFromPoint(${end.x}, ${end.y})).cursor`), id === 'timeline' ? 'row-resize' : 'col-resize');
      await checkHandlePaint(selector);
    }
    if (capture) {
      const rect = await evaluate(`(() => { const {x, y, width, height} = document.querySelector('#editor-workspace').getBoundingClientRect(); return {x, y, width, height}; })()`);
      writeFileSync(capture, (await wc.capturePage(rect, { stayHidden: true })).toPNG());
    }
    checkGutters(await snapshot());
    if (cancel) {
      near(size(await snapshot(), id), size(before, id) + distance * (id === 'materials' ? 1 : -1));
      await press('Escape');
      samePanes(await snapshot(), before);
      assert.ok(!await evaluate(`document.querySelector('${selector}').hasPointerCapture(1)`), 'Escape releases the active drag');
      end[axis] += 12;
      await mouse('mouseMoved', end, { buttons: 1 });
    }
    await mouse('mouseReleased', end, { button: 'left', clickCount: 1 });
    await settle();
    if (cancel) samePanes(await snapshot(), before);
  }
  async function doubleClick(id) {
    const pos = await center(`[data-split="${id}"]`);
    for (const count of [1, 2]) {
      await mouse('mousePressed', pos, { button: 'left', buttons: 1, clickCount: count });
      await mouse('mouseReleased', pos, { button: 'left', clickCount: count });
    }
    await settle();
  }
  async function key(id, value) {
    await evaluate(`document.querySelector('[data-split="${id}"]').focus()`);
    await press(value);
  }
  async function press(value, modifiers = 0) {
    const keyCodes = { Tab: 9, Escape: 27, End: 35, Home: 36, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40 };
    for (const type of ['rawKeyDown', 'keyUp']) {
      await wc.debugger.sendCommand('Input.dispatchKeyEvent', {
        type, key: value, code: value, modifiers, windowsVirtualKeyCode: keyCodes[value], nativeVirtualKeyCode: keyCodes[value],
      });
    }
    await settle();
  }
  async function reopen() {
    const loaded = once(wc, 'did-finish-load');
    wc.reload();
    await loaded;
    await click('#home-create');
    await settle();
  }
  function checkGutters(boxes) {
    const [bottom, ...top] = Object.values(boxes).sort((a, b) => b.top - a.top);
    const [left, middle, right] = top.sort((a, b) => a.left - b.left);
    const gutter = middle.left - left.right;
    assert.ok(gutter >= 6 && gutter <= 8, 'The panels should have a compact visible gutter, got ' + gutter);
    near(bottom.left, left.left);
    near(bottom.right, right.right);
    near(right.left - middle.right, gutter);
    for (const box of top) {
      near(box.top, left.top);
      near(bottom.top - box.bottom, gutter);
    }
    return gutter;
  }
  async function contained() {
    const boxes = await snapshot();
    const [width, height] = await evaluate('[innerWidth,innerHeight]');
    const preview = boxes['.editor-player'];
    for (const rect of Object.values(boxes)) assert.ok(rect.x >= 0 && rect.y >= 0 && rect.right <= width + 1 && rect.bottom <= height + 1);
    assert.ok(preview.width >= 201 && preview.height >= 164);
    checkGutters(boxes);
  }
  async function adjust() {
    await click('#panel-layout-toggle');
    await settle();
  }
  const editing = () => evaluate("document.querySelector('#panel-layout-toggle').getAttribute('aria-pressed') === 'true'");
  function sameBox(actual, expected, label) {
    for (const prop of ['left', 'top', 'right', 'bottom']) {
      assert.ok(Math.abs(actual[prop] - expected[prop]) <= 1.5,
        `${label}.${prop} should be ${expected[prop]}, got ${actual[prop]}`);
    }
  }
  function samePanes(boxes, expected) {
    for (const selector of selectors) sameBox(boxes[selector], expected[selector], selector);
  }
  function betweenBoxes(actual, from, to, label) {
    for (const prop of ['left', 'top', 'width', 'height']) {
      if (Math.abs(from[prop] - to[prop]) < 10) continue;
      assert.ok(actual[prop] > Math.min(from[prop], to[prop]) && actual[prop] < Math.max(from[prop], to[prop]),
        `${label}.${prop} should be between ${from[prop]} and ${to[prop]}, got ${actual[prop]}`);
    }
  }
  function exchanged(boxes, first, second) {
    const a = paneSelectors[first], b = paneSelectors[second];
    return { ...boxes, [a]: boxes[b], [b]: boxes[a] };
  }
  const moveGrip = pane => `.panel-layout-box[data-pane="${pane}"] [data-edge="move"]`;
  const targetPane = () => evaluate("document.querySelector('.panel-layout-box[data-drop-target]')?.dataset.pane ?? null");
  const slotSnapshot = () => evaluate(`Object.fromEntries(Object.entries(${JSON.stringify(paneSelectors)}).map(([pane, selector]) =>
    [selector, document.querySelector('.panel-layout-box[data-pane="' + pane + '"]').getBoundingClientRect().toJSON()]))`);
  const paneVisual = pane => evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(paneSelectors[pane])});
    const content = [...el.children].find(child => child.checkVisibility() && child.getBoundingClientRect().width > 0);
    const style = getComputedStyle(el);
    return { box: el.getBoundingClientRect().toJSON(), content: content.getBoundingClientRect().toJSON(),
      shadow: style.boxShadow, reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
      lifted: el.hasAttribute('data-lifted'), transform: style.transform };
  })()`);
  async function finishPaneMotion() {
    await evaluate(`Promise.allSettled([...document.querySelectorAll('.panel-layout-pane')].flatMap(pane => {
      getComputedStyle(pane).transform;
      return pane.getAnimations().filter(animation => Number.isFinite(animation.effect.getComputedTiming().endTime))
        .map(animation => animation.finished);
    }))`);
  }
  // Use the browser's animation clock to sample real panel positions even on a busy desktop.
  // The check works with CSS and Web Animations and does not depend on an application animation ID.
  async function sampleMotion(pane, fraction) {
    return evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(paneSelectors[pane])});
      const properties = ['transform', 'translate', 'scale', 'width', 'height', 'left', 'top'];
      const animations = el.getAnimations().filter(a => a.effect.getKeyframes().some(frame =>
        properties.some(prop => prop in frame)));
      for (const animation of animations) {
        animation.pause();
        animation.currentTime = animation.effect.getComputedTiming().activeDuration * ${fraction};
      }
      return animations.length;
    })()`);
  }
  const resumeMotion = () => evaluate(`document.getAnimations().filter(a => a.playState === 'paused').forEach(a => a.play())`);
  async function checkReleased() {
    assert.equal(await evaluate(`document.querySelectorAll('.panel-layout-pane[data-lifted], .panel-layout-box[data-drag-source], .panel-layout-box[data-drop-target]').length`), 0);
    await finishPaneMotion();
  }
  async function paneCenter(pane) {
    const rect = (await slotSnapshot())[paneSelectors[pane]];
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }
  const storedLayout = () => evaluate(`['sd-workbench-panel-layout-v1', 'sd-workbench-split-view-v1']
    .map(key => localStorage.getItem(key))`);
  let held;
  async function preparePickup(pane, start) {
    held = { pane, start, before: await paneVisual(pane), slots: await snapshot(), stored: await storedLayout() };
  }
  async function verifyFollow(point) {
    const { pane, start, before, stored } = held;
    const visual = await paneVisual(pane);
    assert.ok(visual.lifted, 'the original pane is raised');
    assert.notEqual(visual.shadow, before.shadow);
    assert.notEqual(visual.shadow, 'none');
    const scaleX = visual.box.width / before.box.width, scaleY = visual.box.height / before.box.height;
    if (visual.reduced) {
      near(visual.box.width, before.box.width);
      near(visual.box.height, before.box.height);
    } else {
      assert.ok(scaleX > 1.001 && scaleY > 1.001, 'the held surface rises around the grab point');
    }
    // The exact content under the initial press must still be under the pointer.
    near(visual.box.left + (start.x - before.box.left) * scaleX, point.x);
    near(visual.box.top + (start.y - before.box.top) * scaleY, point.y);
    near(visual.content.left, visual.box.left + (before.content.left - before.box.left) * scaleX);
    near(visual.content.top, visual.box.top + (before.content.top - before.box.top) * scaleY);
    near(visual.content.width, before.content.width * scaleX);
    assert.deepEqual(await storedLayout(), stored, 'hover never writes a layout');
    return visual;
  }
  async function beginSwap(pane) {
    const box = (await slotSnapshot())[paneSelectors[pane]];
    const start = { x: Math.round(box.left + box.width * .37), y: Math.round(box.top + 24) };
    await preparePickup(pane, start);
    await mouse('mouseMoved', start, {});
    await mouse('mousePressed', start, { button: 'left', buttons: 1, clickCount: 1 });
    const pressed = await paneVisual(pane);
    assert.ok(pressed.lifted, 'no pointer movement or delay is needed to lift the panel');
    if (pressed.reduced) {
      assert.equal(await evaluate(`document.querySelector(${JSON.stringify(paneSelectors[pane])}).getAnimations().length`), 0,
        'the reduced-motion shadow appears without a transition');
    }
    await finishPaneMotion();
    await verifyFollow(start);
    return start;
  }
  async function verifyNeighbors(target) {
    const boxes = await snapshot();
    const source = paneSelectors[held.pane];
    for (const selector of selectors.filter(selector => selector !== source)) {
      const expected = held.slots[selector === paneSelectors[target] ? source : selector];
      sameBox(boxes[selector], expected, `while held over ${target}, ${selector}`);
    }
  }
  async function hoverAt(point, expected) {
    await mouse('mouseMoved', point, { buttons: 1 });
    const visual = await verifyFollow(point);
    assert.equal(await targetPane(), expected, 'only the fixed slot under the pointer offers to swap');
    if (!visual.reduced) await finishPaneMotion();
    else if (expected) assert.equal(await sampleMotion(expected, .5), 0, 'reduced motion makes room instantly');
    await verifyNeighbors(expected);
    return point;
  }
  async function paintedContent(box) {
    // Compare the actual rendered material list, including the part crossing into the neighboring slot.
    const rect = { x: Math.round(box.left) + 10, y: Math.round(box.top) + 32,
      width: Math.floor(box.width) - 20, height: Math.min(118, Math.floor(box.height) - 40) };
    const image = (await wc.capturePage(rect, { stayHidden: true })).resize({ width: rect.width, height: rect.height });
    return { pixels: image.toBitmap(), rect };
  }
  function samePaint(original, moved, targetLeft) {
    const before = original.pixels, after = moved.pixels;
    const { x, width, height } = moved.rect;
    const seam = Math.round(targetLeft - x);
    assert.ok(seam > 2 && seam < width - 3, 'the target edge crosses the photographed controls');
    assert.equal(after.length, before.length);
    let details = 0, matched = 0, tinted = 0;
    const seamChanges = [0, 0, 0, 0, 0];
    for (let i = 4; i < before.length; i += 4) {
      if (Math.abs(before[i] - after[i]) > 8 || Math.abs(before[i + 1] - after[i + 1]) > 8 ||
          Math.abs(before[i + 2] - after[i + 2]) > 8) {
        tinted++;
        const column = (i / 4) % width - seam;
        if (Math.abs(column) <= 2) seamChanges[column + 2]++;
      }
      const edge = before[i + 1] - before[i - 3];
      if (Math.abs(edge) < 28) continue;
      details++;
      const now = after[i + 1] - after[i - 3];
      if (Math.sign(now) === Math.sign(edge) && Math.abs(now) >= .50 * Math.abs(edge)) matched++;
    }
    assert.ok(seamChanges.every(count => count < height * .25), 'the drop border must stay behind the original controls');
    assert.ok(tinted < before.length / 4 * .09,
      `target decorations must paint behind the held panel (${tinted} visibly altered pixels)`);
    assert.ok(details > 100 && matched / details > .80,
      `the original text and controls must paint above the target (${matched}/${details} matching edges)`);
  }
  async function dropAt(point) {
    await mouse('mouseReleased', point, { button: 'left', clickCount: 1 });
    await settle();
    await checkReleased();
  }
  async function verifyClipping() {
    const spill = await evaluate(`(() => {
      const panes = [...document.querySelectorAll('.panel-layout-pane')];
      for (const pane of panes) {
        const r = pane.getBoundingClientRect();
        for (const x of [r.left + 5, r.left + r.width / 2, r.right - 5]) {
          for (const y of [r.top + 5, r.top + r.height / 2, r.bottom - 5]) {
            const foreign = document.elementsFromPoint(x, y).map(el => el.closest('.panel-layout-pane'))
              .find(other => other && other !== pane);
            if (foreign) return [pane.id, foreign.id, x, y];
          }
        }
      }
      return null;
    })()`);
    assert.equal(spill, null, 'a neighboring pane must clip its contents inside its own slot: ' + JSON.stringify(spill));
  }
  async function dragSeam(pane, edge, distances, { cancel = false, checkPaint = false } = {}) {
    const selector = `.panel-layout-box[data-pane="${pane}"] [data-edge="${edge}"]`;
    const origin = await center(selector);
    const before = await snapshot();
    const horizontal = edge !== 'n';
    const axis = horizontal ? 'x' : 'y';
    const preview = before['.editor-player'];
    let point;
    if (checkPaint) {
      await mouse('mouseMoved', origin, {});
      await checkHandlePaint(selector);
    }
    await mouse('mousePressed', origin, { button: 'left', buttons: 1, clickCount: 1 });
    for (const distance of distances) {
      point = { ...origin, [axis]: origin[axis] + distance };
      await mouse('mouseMoved', point, { buttons: 1 });
      await settle();
      if (checkPaint && distance === distances[0]) await checkHandlePaint(selector);
      const boxes = await snapshot();
      assert.equal(await evaluate("document.querySelectorAll('.panel-layout-pane[data-lifted]').length"), 0,
        'resizing a shared edge never lifts a panel');
      checkGutters(boxes);
      near(boxes['.editor-player'][horizontal ? 'right' : 'bottom'], preview[horizontal ? 'right' : 'bottom'] + distance);
      near(boxes['.editor-player'].left, preview.left);
      near(boxes['#montage-inspector'].right, before['#montage-inspector'].right);
      near(boxes['#montage-pane'].bottom, before['#montage-pane'].bottom);
    }
    if (cancel) {
      await press('Escape');
      assert.equal(await editing(), false, 'Esc during pointer capture should leave layout editing');
      await mouse('mouseMoved', origin, { buttons: 1 });
    }
    await mouse('mouseReleased', point, { button: 'left', clickCount: 1 });
    await settle();
  }

  await click('#home-create');
  await settle();
  assert.equal(await visible(), 3, await evaluate(`[document.querySelector('.app-frame').dataset.mode, document.querySelector('#editor-workspace').outerHTML.slice(0, 150), document.querySelector('#notice').textContent].join(' ')`));
  const original = await snapshot();
  checkGutters(original);
  assert.ok(await evaluate(`Object.values(document.querySelectorAll('.panel-layout-pane')).every(el => {
    const style = getComputedStyle(el);
    return ['borderTopLeftRadius','borderTopRightRadius','borderBottomLeftRadius','borderBottomRightRadius']
      .every(prop => parseFloat(style[prop]) >= 8);
  })`), 'All four corners should separate each panel from the desktop');
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('.workspace-divider')].map(el => {
    const controlled = document.getElementById(el.getAttribute('aria-controls'));
    return [el.getAttribute('role'), el.getAttribute('aria-orientation'), controlled?.checkVisibility(), el.tabIndex];
  })`), [['separator', 'vertical', true, 0], ['separator', 'vertical', true, 0], ['separator', 'horizontal', true, 0]]);
  for (const theme of ['light', 'dark']) {
    await wc.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [
      { name: 'prefers-color-scheme', value: theme }, { name: 'prefers-reduced-motion', value: 'reduce' },
    ] });
    await settle();
    assert.equal(await evaluate('document.documentElement.dataset.theme'), theme);
    for (const id of ids) {
      await mouse('mouseMoved', { x: 10, y: 10 }, {});
      await checkHandlePaint(`[data-split="${id}"]`);
      const capture = theme === 'dark' && id === 'timeline' && process.env.JIAJIAN_SPLIT_CAPTURE;
      await move(id, 20, { cancel: true, checkPaint: true, capture });
    }
  }
  for (const id of ids) {
    const sign = id === 'materials' ? 1 : -1;
    const start = size(await snapshot(), id);
    await move(id, sign * 40, { offset: -5 });
    near(size(await snapshot(), id), start + 40);
    await move(id, -sign * 22, { offset: 5 });
    near(size(await snapshot(), id), start + 18);
    await move(id, sign * 30, { cancel: true });
    await key(id, id === 'materials' ? 'ArrowRight' : id === 'inspector' ? 'ArrowLeft' : 'ArrowUp');
    near(size(await snapshot(), id), start + 26);
    await checkHandlePaint(`[data-split="${id}"]`, true);
    if (id === 'materials') {
      await press('Tab');
      await press('Tab', 8); // CDP Shift modifier.
      assert.equal(await evaluate('document.activeElement.dataset.split'), id);
      await checkHandlePaint(`[data-split="${id}"]`, true);
    }
    await doubleClick(id);
    near(size(await snapshot(), id), size(original, id));
    await move(id, sign * 45);
  }
  const changed = await snapshot();
  await evaluate(`(() => {
    const search = document.querySelector('#material-search');
    search.focus();
    search.value = '四个分镜';
    search.setSelectionRange(1, 3);
  })()`);
  await move('inspector', -34, { cancel: true });
  assert.deepEqual(await evaluate('[document.activeElement.id, document.activeElement.value, document.activeElement.selectionStart, document.activeElement.selectionEnd]'),
    ['material-search', '四个分镜', 1, 3], 'resizing and cancelling preserve text focus and selection');
  await wc.debugger.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: true });
  const touch = (type, touchPoints) => wc.debugger.sendCommand('Input.dispatchTouchEvent', { type, touchPoints });
  try {
    const point = await center('[data-split="timeline"]');
    await touch('touchStart', [point]);
    await touch('touchMove', [{ ...point, y: point.y - 28 }]);
    await settle();
    near(size(await snapshot(), 'timeline'), size(changed, 'timeline') + 28);
    await touch('touchCancel', []);
    await settle();
    samePanes(await snapshot(), changed);
  } finally {
    await wc.debugger.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: false });
  }
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
  // Both side panels at their limits must still leave the two gutters and a usable player.
  await key('materials', 'End');
  await key('inspector', 'End');
  await key('timeline', 'End');
  const compact = await snapshot();
  near(compact['.editor-player'].width, 202);
  near(compact['.editor-player'].height, 165);
  near(checkGutters(compact), 6);
  for (const id of ids) await doubleClick(id);
  win.setSize(...originalWindow);
  await settle();
  await move('materials', 20);
  const beforeEditing = await snapshot();
  await adjust();
  assert.equal(await visible(), 0);
  assert.deepEqual(await evaluate(`(() => {
    const handle = (pane, edge) => document.querySelector('.panel-layout-box[data-pane="' + pane + '"] [data-edge="' + edge + '"]');
    return [handle('inspector', 'e').checkVisibility(), handle('timeline', 's').checkVisibility(),
      getComputedStyle(handle('player', 'ne')).cursor, getComputedStyle(handle('timeline', 'nw')).cursor];
  })()`), [false, false, 'ew-resize', 'ns-resize'], 'docked handles only offer the available resizing axes');
  await dragSeam('player', 'e', [-16, -42, -67], { checkPaint: true });
  const playerEdge = '.panel-layout-box[data-pane="player"] [data-edge="e"]';
  await checkHandlePaint(playerEdge);
  await press('ArrowLeft');
  await checkHandlePaint(playerEdge, true);
  await press('Tab');
  await press('Tab', 8);
  await checkHandlePaint(playerEdge, true);
  await dragSeam('inspector', 'w', [14, 30]);
  await dragSeam('timeline', 'n', [-12, -25], { checkPaint: true });
  await click('#nav-toggle');
  await press('Escape');
  assert.ok(await editing(), 'the first Escape dismisses the open navigation drawer');
  assert.ok(await evaluate("document.querySelector('#workspace-navigation').inert"));
  await dragSeam('player', 'e', [-20], { cancel: true });
  samePanes(await snapshot(), beforeEditing);
  assert.equal(await evaluate('document.activeElement.id'), 'panel-layout-toggle');
  assert.equal(await visible(), 3);
  await reopen();
  samePanes(await snapshot(), beforeEditing);
  await adjust();
  await dragSeam('player', 'e', [-24, -46]);
  await adjust();
  const saved = await snapshot();
  await reopen();
  samePanes(await snapshot(), saved);
  await adjust();
  win.setSize(850, 600);
  await settle();
  await contained();
  const seam = await center('.panel-layout-box[data-pane="player"] [data-edge="e"]');
  await mouse('mousePressed', seam, { button: 'left', buttons: 1, clickCount: 1 });
  const width = await evaluate('innerWidth');
  for (const x of [width - 8, 8]) {
    await mouse('mouseMoved', { x, y: seam.y }, { buttons: 1 });
    await settle();
    await contained();
    const limit = await snapshot();
    assert.ok(limit['#montage-inspector'].width >= 209, 'the inspector remains usable at the right limit');
    assert.ok(Math.abs(limit['.editor-player'].right - x) > 60, 'a pane at its minimum stops the shared edge');
  }
  await mouse('mouseReleased', { x: 8, y: seam.y }, { button: 'left', clickCount: 1 });
  win.setSize(...originalWindow);
  await settle();
  await press('Escape');
  samePanes(await snapshot(), saved);

  // A v1 layout produced by shrinking only the preview left an empty strip.
  const gapped = { version: 1, order: ['player', 'materials', 'inspector', 'timeline'], boxes: {
    materials: { x: 0, y: 0, width: .22, height: .65 }, player: { x: .22, y: 0, width: .49, height: .65 },
    inspector: { x: .78, y: 0, width: .22, height: .65 }, timeline: { x: 0, y: .65, width: 1, height: .35 },
  } };
  await evaluate(`localStorage.setItem('sd-workbench-panel-layout-v1', ${JSON.stringify(JSON.stringify(gapped))})`);
  await reopen();
  const repaired = await snapshot();
  const gutter = checkGutters(repaired);
  near(repaired['.editor-player'].right + gutter, repaired['#montage-pane'].left + .71 * repaired['#montage-pane'].width);
  await adjust();
  await dragSeam('player', 'e', [-32]);
  await press('Escape');
  samePanes(await snapshot(), repaired);

  // Old free layouts could stack these rectangles. Preserve their relative placement in a tiled layout.
  const legacy = { version: 1, order: ['player', 'materials', 'inspector', 'timeline'], boxes: {
    player: { x: .04, y: .02, width: .48, height: .60 }, materials: { x: .26, y: .02, width: .32, height: .59 },
    inspector: { x: .72, y: .04, width: .27, height: .51 }, timeline: { x: .01, y: .56, width: .97, height: .43 },
  } };
  await evaluate(`localStorage.setItem('sd-workbench-panel-layout-v1', ${JSON.stringify(JSON.stringify(legacy))})`);
  await reopen();
  assert.equal(await visible(), 3);
  const migrated = await snapshot();
  checkGutters(migrated);
  assert.ok(migrated['.editor-player'].left < migrated['#materials-pane'].left);
  await reopen();
  samePanes(await snapshot(), migrated);
  await click('#panel-layout-reset');
  await settle();
  samePanes(await snapshot(), original);

  // Vary motion independently of the light/dark appearance tested above.
  const motion = (value, theme = 'dark') => wc.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [
    { name: 'prefers-color-scheme', value: theme }, { name: 'prefers-reduced-motion', value },
  ] });
  await motion('no-preference');
  await adjust();
  const stage = await snapshot();
  const slots = await slotSnapshot();
  const left = slots['#materials-pane'], middle = slots['.editor-player'];
  const seamPoint = { x: (left.right + middle.left) / 2, y: left.top + left.height / 2 };
  const playerPoint = await paneCenter('player');
  const inspectorPoint = await paneCenter('inspector');
  const rest = await paneVisual('materials');
  const stationary = await beginSwap('materials');
  assert.equal(await targetPane(), null);
  assert.ok(!await evaluate(`document.querySelector('.panel-layout-pickup')?.checkVisibility() || document.querySelector('#panel-layout-layer').innerText.includes('已抓起')`),
    'holding the panel does not show a pickup label');
  if (process.env.JIAJIAN_PICKUP_CAPTURE) {
    writeFileSync(process.env.JIAJIAN_PICKUP_CAPTURE, (await wc.capturePage(undefined, { stayHidden: true })).toPNG());
  }
  await dropAt(stationary);
  samePanes(await snapshot(), stage);
  assert.equal((await paneVisual('materials')).shadow, rest.shadow);
  const grab = await beginSwap('materials');
  await settle();
  const originalPaint = await paintedContent((await paneVisual('materials')).box);
  const diagonal = { x: Math.round(middle.left + 52), y: Math.round(left.top + 75) };
  await hoverAt({ x: grab.x + 3, y: grab.y }, null);
  await hoverAt({ x: Math.ceil(middle.left) + 1, y: diagonal.y }, 'player');
  await hoverAt(diagonal, 'player');
  await evaluate("Promise.allSettled(document.querySelector('[data-drop-target]').getAnimations().map(a => a.finished))");
  await settle();
  samePaint(originalPaint, await paintedContent((await paneVisual('materials')).box), middle.left);
  await hoverAt(inspectorPoint, 'inspector');
  await hoverAt(playerPoint, 'player');
  await hoverAt({ x: grab.x + 1, y: grab.y + 1 }, null);
  await hoverAt(inspectorPoint, 'inspector');
  await hoverAt(seamPoint, null);
  await dropAt(seamPoint);
  samePanes(await snapshot(), stage);
  assert.deepEqual(await storedLayout(), held.stored);

  // Reverse before the first displaced panel reaches the source. At each new target,
  // the returning and incoming panels must continue from their currently visible rectangles.
  const rapidStart = await beginSwap('materials');
  await mouse('mouseMoved', playerPoint, { buttons: 1 });
  assert.ok(await sampleMotion('player', .25), 'crossing into a slot starts the slide before release');
  const midSlide = (await snapshot())['.editor-player'];
  betweenBoxes(midSlide, middle, left, 'player entering the source slot');
  await mouse('mouseMoved', inspectorPoint, { buttons: 1 });
  assert.ok(await sampleMotion('player', 0));
  assert.ok(await sampleMotion('inspector', 0));
  let interrupted = await snapshot();
  sameBox(interrupted['.editor-player'], midSlide, 'player begins its return');
  sameBox(interrupted['#montage-inspector'], stage['#montage-inspector'], 'inspector starts from its physical slot');
  await sampleMotion('player', .25);
  await sampleMotion('inspector', .25);
  interrupted = await snapshot();
  betweenBoxes(interrupted['.editor-player'], midSlide, middle, 'player returning to its slot');
  betweenBoxes(interrupted['#montage-inspector'], stage['#montage-inspector'], left, 'inspector entering the source slot');
  await mouse('mouseMoved', playerPoint, { buttons: 1 });
  assert.ok(await sampleMotion('player', 0));
  assert.ok(await sampleMotion('inspector', 0));
  const reversed = await snapshot();
  sameBox(reversed['.editor-player'], interrupted['.editor-player'], 'player reverses from its visible location');
  sameBox(reversed['#montage-inspector'], interrupted['#montage-inspector'], 'inspector reverses from its visible location');
  await resumeMotion();
  await finishPaneMotion();
  await verifyFollow(playerPoint);
  await verifyNeighbors('player');
  await hoverAt(rapidStart, null);
  await dropAt(rapidStart);
  samePanes(await snapshot(), stage);
  assert.deepEqual(await storedLayout(), held.stored);

  await beginSwap('materials');
  await hoverAt(playerPoint, 'player');
  await hoverAt({ x: 2, y: 2 }, null);
  await dropAt({ x: 2, y: 2 });
  samePanes(await snapshot(), stage);
  await beginSwap('materials');
  await hoverAt(playerPoint, 'player');
  await dropAt(seamPoint);
  samePanes(await snapshot(), stage);

  await beginSwap('materials');
  const outside = { x: -36, y: left.top + 30 };
  await hoverAt(outside, null);
  await dropAt(outside);
  samePanes(await snapshot(), stage);

  const lostGrip = await beginSwap('materials');
  await hoverAt(playerPoint, 'player');
  await evaluate(`document.querySelector(${JSON.stringify(moveGrip('materials'))}).releasePointerCapture(1)`);
  await mouse('mouseMoved', { ...playerPoint, x: playerPoint.x + 2 }, { buttons: 1 });
  await checkReleased();
  await dropAt(lostGrip);
  samePanes(await snapshot(), stage);

  await wc.debugger.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: true });
  try {
    const touchStart = await center(moveGrip('materials'));
    await preparePickup('materials', touchStart);
    await touch('touchStart', [touchStart]);
    assert.ok((await paneVisual('materials')).lifted, 'touch pickup needs no movement or long press');
    await finishPaneMotion();
    await verifyFollow(touchStart);
    await touch('touchMove', [playerPoint]);
    await settle();
    assert.equal(await targetPane(), 'player');
    await verifyFollow(playerPoint);
    await finishPaneMotion();
    await verifyNeighbors('player');
    await touch('touchCancel', []);
    await settle();
    await checkReleased();
    samePanes(await snapshot(), stage);
    assert.deepEqual(await storedLayout(), held.stored, 'touch cancellation preserves the saved layout');
    for (const expected of [exchanged(stage, 'materials', 'player'), stage]) {
      const start = await paneCenter('materials'), end = await paneCenter('player');
      await preparePickup('materials', start);
      await touch('touchStart', [start]);
      await touch('touchMove', [end]);
      assert.equal(await targetPane(), 'player');
      await finishPaneMotion();
      await verifyFollow(end);
      await verifyNeighbors('player');
      await touch('touchEnd', []);
      await checkReleased();
      samePanes(await snapshot(), expected);
      assert.notDeepEqual(await storedLayout(), held.stored, 'touch release commits the preview');
    }
  } finally {
    await wc.debugger.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: false });
  }

  // Drop a different-sized panel while its neighbor is still crossing the workspace.
  const timelinePoint = await paneCenter('timeline');
  await beginSwap('inspector');
  await mouse('mouseMoved', timelinePoint, { buttons: 1 });
  assert.ok(await sampleMotion('timeline', .25));
  const crossing = await snapshot();
  betweenBoxes(crossing['#montage-pane'], stage['#montage-pane'], stage['#montage-inspector'], 'timeline making room');
  await verifyFollow(timelinePoint);
  await mouse('mouseReleased', timelinePoint, { button: 'left', clickCount: 1 });
  assert.ok(await sampleMotion('inspector', 0));
  // The timeline was paused at a known frame. It must still be there while the released pane starts landing.
  samePanes(await snapshot(), crossing);
  await resumeMotion();
  await checkReleased();
  samePanes(await snapshot(), exchanged(stage, 'timeline', 'inspector'));
  assert.notDeepEqual(await storedLayout(), held.stored, 'mouse release commits the preview');
  await reopen();
  samePanes(await snapshot(), exchanged(stage, 'timeline', 'inspector'));
  await adjust();
  await beginSwap('inspector');
  await dropAt(await hoverAt(await paneCenter('timeline'), 'timeline'));
  samePanes(await snapshot(), stage);
  await adjust();
  await adjust();

  await beginSwap('materials');
  await hoverAt(playerPoint, 'player');
  assert.ok(await evaluate(`[...document.querySelectorAll('.panel-layout-box')].every(box =>
    [box, ...box.querySelectorAll('button')].every(el => [null, '::before', '::after'].every(pseudo => {
      const style = getComputedStyle(el, pseudo);
      return ![style.outlineStyle, style.borderTopStyle, style.borderRightStyle, style.borderBottomStyle, style.borderLeftStyle].includes('dashed');
    })))`), 'editing and targeting should use a continuous surface without a dashed outline');
  const airborne = await snapshot();
  const swapped = exchanged(stage, 'materials', 'player');
  await mouse('mouseReleased', playerPoint, { button: 'left', clickCount: 1 });
  assert.ok(await sampleMotion('materials', 0), 'the released panel lands from the pointer');
  await sampleMotion('player', 0);
  samePanes(await snapshot(), airborne);
  await sampleMotion('materials', .50);
  await sampleMotion('player', .50);
  const landing = await snapshot();
  betweenBoxes(landing['#materials-pane'], airborne['#materials-pane'], swapped['#materials-pane'], 'materials landing');
  sameBox(landing['.editor-player'], left, 'the displaced player stays put throughout release');
  await resumeMotion();
  await checkReleased();
  samePanes(await snapshot(), swapped);

  // Re-grab the same panel while its return animation is still running.
  const regrab = await beginSwap('materials');
  const offset = { x: regrab.x + 34, y: regrab.y + 28 };
  await hoverAt(offset, null);
  await mouse('mouseReleased', offset, { button: 'left', clickCount: 1 });
  assert.ok(await sampleMotion('materials', .25));
  await mouse('mousePressed', offset, { button: 'left', buttons: 1, clickCount: 1 });
  await finishPaneMotion();
  const caught = await paneVisual('materials');
  assert.ok(caught.lifted);
  const next = { x: offset.x - 59, y: offset.y + 38 };
  await mouse('mouseMoved', next, { buttons: 1 });
  const pulled = await paneVisual('materials');
  near(pulled.box.left - caught.box.left, next.x - offset.x);
  near(pulled.box.top - caught.box.top, next.y - offset.y);
  await dropAt(next);
  samePanes(await snapshot(), swapped);
  await beginSwap('inspector');
  await hoverAt(await paneCenter('timeline'), 'timeline');
  const cancelledTarget = await paneCenter('timeline');
  await press('Escape');
  await dropAt(cancelledTarget);
  assert.equal(await editing(), false);
  samePanes(await snapshot(), stage);
  await reopen();
  samePanes(await snapshot(), stage);

  await motion('reduce', 'light');
  await adjust();
  const reducedGrip = await beginSwap('player');
  assert.equal(await evaluate('document.documentElement.dataset.theme'), 'light');
  await hoverAt(await paneCenter('materials'), 'materials');
  await dropAt(reducedGrip);
  samePanes(await snapshot(), stage);
  await evaluate(`document.querySelector(${JSON.stringify(moveGrip('materials'))}).focus()`);
  await press('ArrowRight');
  samePanes(await snapshot(), exchanged(stage, 'materials', 'player'));
  assert.equal(await evaluate(`document.activeElement.closest('.panel-layout-box')?.dataset.pane`), 'materials');
  assert.equal(await sampleMotion('materials', 0), 0, 'reduced motion exchanges immediately');
  await press('ArrowLeft');
  samePanes(await snapshot(), stage);
  await press('ArrowDown');
  const vertical = exchanged(stage, 'materials', 'timeline');
  samePanes(await snapshot(), vertical);
  await adjust();
  await reopen();
  samePanes(await snapshot(), vertical);
  assert.equal(await visible(), 3);
  await verifyClipping();
  const beforeResize = (await snapshot())['#materials-pane'].height;
  assert.equal(await evaluate(`document.querySelector('[data-split="timeline"]').getAttribute('aria-controls')`), 'materials-pane');
  await move('timeline', -18);
  near((await snapshot())['#materials-pane'].height, beforeResize + 18);
  await doubleClick('timeline');
  samePanes(await snapshot(), vertical);

  win.setSize(850, 600);
  await settle();
  const narrow = await snapshot();
  checkGutters(narrow);
  await verifyClipping();
  await adjust();
  await beginSwap('materials');
  await dropAt(await hoverAt(await paneCenter('inspector'), 'inspector'));
  const narrowSwapped = exchanged(narrow, 'materials', 'inspector');
  samePanes(await snapshot(), narrowSwapped);
  checkGutters(narrowSwapped);
  await adjust();
  await verifyClipping();
  await reopen();
  samePanes(await snapshot(), narrowSwapped);
  win.setSize(...originalWindow);
  await settle();
  await click('#panel-layout-reset');
  await settle();
  samePanes(await snapshot(), original);
  await adjust();
  const timelineGrip = await beginSwap('timeline');
  await click('#title-home');
  await settle();
  await checkReleased();
  await dropAt(timelineGrip);
  assert.equal(await visible(), 0);
  wc.debugger.detach();
  console.log('Passed live panel swaps while held, rapid reversals, continuous release, cancellation, re-grab, touch, reduced motion, keyboard, migration, clipping, resizing, and persistence.');
  win.close();
}

run().catch((error) => { console.error(error); app.exit(1); });
