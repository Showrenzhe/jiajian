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
  function samePanes(boxes, expected) {
    for (const selector of selectors) {
      for (const prop of ['left', 'top', 'right', 'bottom']) near(boxes[selector][prop], expected[selector][prop]);
    }
  }
  function exchanged(boxes, first, second) {
    const a = paneSelectors[first], b = paneSelectors[second];
    return { ...boxes, [a]: boxes[b], [b]: boxes[a] };
  }
  const moveGrip = pane => `.panel-layout-box[data-pane="${pane}"] [data-edge="move"]`;
  const targetPane = () => evaluate("document.querySelector('.panel-layout-box[data-drop-target]')?.dataset.pane ?? null");
  async function paneCenter(pane) {
    const rect = (await snapshot())[paneSelectors[pane]];
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }
  async function beginSwap(pane) {
    const start = await center(moveGrip(pane));
    await mouse('mouseMoved', start, {});
    await mouse('mousePressed', start, { button: 'left', buttons: 1, clickCount: 1 });
    await settle();
  }
  async function hoverAt(point, expected) {
    await mouse('mouseMoved', point, { buttons: 1 });
    await settle();
    assert.equal(await targetPane(), expected, 'only the pane under the pointer offers to swap');
    return point;
  }
  async function dropAt(point) {
    await mouse('mouseReleased', point, { button: 'left', clickCount: 1 });
    await settle();
    assert.equal(await targetPane(), null);
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
  const motion = value => wc.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [
    { name: 'prefers-color-scheme', value: 'dark' }, { name: 'prefers-reduced-motion', value },
  ] });
  await motion('no-preference');
  await adjust();
  const stage = await snapshot();
  const left = stage['#materials-pane'], middle = stage['.editor-player'];
  const seamPoint = { x: (left.right + middle.left) / 2, y: left.top + left.height / 2 };
  const playerPoint = await paneCenter('player');
  const inspectorPoint = await paneCenter('inspector');
  await beginSwap('materials');
  await hoverAt(playerPoint, 'player');
  await hoverAt(inspectorPoint, 'inspector');
  samePanes(await snapshot(), stage);
  await hoverAt(seamPoint, null);
  await dropAt(seamPoint);
  samePanes(await snapshot(), stage);
  await beginSwap('materials');
  await hoverAt(playerPoint, 'player');
  await hoverAt({ x: 2, y: 2 }, null);
  await dropAt({ x: 2, y: 2 });
  samePanes(await snapshot(), stage);
  await beginSwap('materials');
  await hoverAt(playerPoint, 'player');
  await dropAt(seamPoint);
  samePanes(await snapshot(), stage);

  await wc.debugger.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: true });
  try {
    await touch('touchStart', [await center(moveGrip('materials'))]);
    await touch('touchMove', [playerPoint]);
    await settle();
    assert.equal(await targetPane(), 'player');
    await touch('touchCancel', []);
    await settle();
    assert.equal(await targetPane(), null);
    samePanes(await snapshot(), stage);
  } finally {
    await wc.debugger.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: false });
  }

  const animatedTransforms = `document.getAnimations().filter(a => a.id === 'panel-slot-arrival').length`;
  await beginSwap('materials');
  await hoverAt(playerPoint, 'player');
  assert.ok(await evaluate(`[...document.querySelectorAll('.panel-layout-box')].every(box =>
    [box, ...box.querySelectorAll('button')].every(el => [null, '::before', '::after'].every(pseudo => {
      const style = getComputedStyle(el, pseudo);
      return ![style.outlineStyle, style.borderTopStyle, style.borderRightStyle, style.borderBottomStyle, style.borderLeftStyle].includes('dashed');
    })))`), 'editing and targeting should use a continuous surface without a dashed outline');
  await dropAt(playerPoint);
  samePanes(await snapshot(), exchanged(stage, 'materials', 'player'));
  assert.ok(await evaluate(animatedTransforms) > 0, 'the contents should transition when the two slots exchange');
  await evaluate(`Promise.allSettled(document.getAnimations().filter(a => a.effect?.target?.closest('.panel-layout-pane') &&
    Number.isFinite(a.effect.getComputedTiming().endTime)).map(a => a.finished))`);
  await beginSwap('inspector');
  await hoverAt(await paneCenter('timeline'), 'timeline');
  await press('Escape');
  await dropAt(await paneCenter('timeline'));
  assert.equal(await editing(), false);
  samePanes(await snapshot(), stage);
  await reopen();
  samePanes(await snapshot(), stage);

  await motion('reduce');
  await adjust();
  await evaluate(`document.querySelector(${JSON.stringify(moveGrip('materials'))}).focus()`);
  await press('ArrowRight');
  samePanes(await snapshot(), exchanged(stage, 'materials', 'player'));
  assert.equal(await evaluate(`document.activeElement.closest('.panel-layout-box')?.dataset.pane`), 'materials');
  assert.equal(await evaluate(animatedTransforms), 0, 'reduced motion should perform the same exchange immediately');
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
  await click('#title-home');
  assert.equal(await visible(), 0);
  wc.debugger.detach();
  console.log('Passed panel swaps, drag targets, keyboard, motion, legacy migration, clipping, paired resizing, and persistence.');
  win.close();
}

run().catch((error) => { console.error(error); app.exit(1); });
