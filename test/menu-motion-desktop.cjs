'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { app } = require('electron');
const { launchDesktop } = require('../src/desktop.cjs');
const { createDraftStore } = require('../src/draft-store.cjs');
const { clickVisible } = require('./desktop-input.cjs');

app.disableHardwareAcceleration();

async function run() {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'jiajian-menu-'));
  const drafts = createDraftStore(path.join(profile, 'drafts'));
  await drafts.create({ name: '菜单校样', config: { shots: [], ratio: '16:9', resolution: 720, fps: 24, fit: 'fit',
    keepAudio: true, unordered: false, useOriginal: true, useMirrors: false, musicIds: [], musicVolume: 35, count: 1 } }, new Map());
  const window = await launchDesktop({ show: false, dataDirectory: profile });
  const wc = window.webContents;
  wc.setBackgroundThrottling(false);
  wc.debugger.attach();
  const read = source => wc.executeJavaScript(source, true);
  const el = selector => 'document.querySelector(' + JSON.stringify(selector) + ')';
  const click = selector => read(el(selector) + '.click()');
  const key = async (name, code) => {
    for (const type of ['keyDown', 'keyUp']) await wc.debugger.sendCommand('Input.dispatchKeyEvent',
      { type, key: name, code: name, windowsVirtualKeyCode: code, text: name === 'Enter' && type === 'keyDown' ? '\r' : '' });
  };
  const media = features => wc.debugger.sendCommand('Emulation.setEmulatedMedia', { features });
  const settle = () => read('new Promise(resolve => setTimeout(resolve, 230))');

  try {
    await wc.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    await media([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);
    await read(`window.menuState = (node, pseudo = null) => {
      const css = getComputedStyle(node, pseudo);
      return { opacity: +css.opacity, pointer: css.pointerEvents, display: css.display,
        width: node.offsetWidth, left: node.offsetLeft, top: node.offsetTop };
    }; void 0;`);
    async function checkPopover(trigger, selector) {
      const menu = el(selector), button = el(trigger);
      await read(button + '.focus()');
      await click(trigger);
      const entering = await read(`menuState(${menu})`);
      assert.ok(entering.opacity < 1 && entering.width > 0, selector + ' should animate in: ' + JSON.stringify(entering));
      await settle();
      const open = await read(`menuState(${menu})`);
      assert.equal(open.opacity, 1);
      const origin = await read(`(() => {
        const trigger = ${button}.getBoundingClientRect(), panel = ${menu}.getBoundingClientRect();
        const [x, y] = getComputedStyle(${menu}).transformOrigin.split(' ').map(parseFloat);
        return [Math.abs(x - Math.max(0, Math.min(panel.width, trigger.left + trigger.width / 2 - panel.left))),
          Math.abs(y - (panel.top < trigger.top ? panel.height : 0))];
      })()`);
      assert.ok(origin.every(distance => distance < 2), selector + ' should scale from the trigger edge: ' + origin);
      await key('Escape', 27);
      const leaving = await read(`menuState(${menu})`);
      assert.equal(leaving.pointer, 'none', selector + ' should release hit testing immediately');
      assert.ok(leaving.opacity > 0, selector + ' should animate out');
      for (const prop of ['width', 'left', 'top']) assert.equal(leaving[prop], open[prop], selector + ' ' + prop);
      assert.equal(await read(`${menu}.contains(document.elementFromPoint(${open.left + 8}, ${open.top + 8}))`), false);
      await click(trigger);
      assert.equal(await read(menu + ".matches(':popover-open')"), true, 'Reopen during exit');
      await settle();
      await click(trigger);
      await settle();
      assert.equal((await read(`menuState(${menu})`)).display, 'none');
    }
    await clickVisible(wc, '#tab-drafts');
    for (let attempt = 0; attempt < 30 && !await read('!!document.querySelector(".draft-open")'); attempt++) await settle();
    const draft = '.draft-open', draftMenu = el('#draft-context-menu');
    await clickVisible(wc, draft, 'right');
    const opening = await read(`(() => {
      const menu = ${draftMenu}, style = getComputedStyle(menu);
      const card = document.querySelector(".draft-open").getBoundingClientRect();
      const [x, y] = style.transformOrigin.split(" ").map(parseFloat);
      return {
        duration: parseFloat(style.transitionDuration) * 1000,
        filter: style.backdropFilter,
        thick: menu.matches(".glass.glass--thick"),
        error: Math.max(Math.abs(menu.offsetLeft + x - card.x - card.width/2),
          Math.abs(menu.offsetTop + y - card.y - card.height/2)),
      };
    })()`);
    assert.ok(opening.duration >= 180 && opening.duration <= 240 && opening.thick && opening.filter !== 'none' && opening.error < 2, JSON.stringify(opening));
    await settle();
    await key('Escape', 27);
    const exitTime = await read('parseFloat(getComputedStyle(' + draftMenu + ').transitionDuration)*1000');
    assert.ok(exitTime >= 120 && exitTime <= 160);
    assert.equal(await read('document.activeElement.matches(".draft-open")'), true);
    await media([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    await settle();
    await clickVisible(wc, draft, 'right');
    assert.equal((await read('menuState(' + draftMenu + ')')).opacity, 1);
    assert.equal(await read('getComputedStyle(' + draftMenu + ').transitionDuration'), '0s');
    await key('Escape', 27);
    assert.equal(await read('document.activeElement.matches(".draft-open")'), true);
    await media([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);
    await click('#tab-script');
    await settle();
    await checkPopover('#script-assistant-toggle', '#script-assistant');
    await click('#script-go-montage');
    await settle();
    await click('#add-shot');
    await checkPopover('#timeline-more', '#timeline-more-menu');
    await checkPopover('#track-more', '#track-more-options');

    const originalSize = window.getContentSize();
    for (const [width, height] of [[1400, 900], [850, 600]]) {
      window.setContentSize(width, height);
      await settle();
      await clickVisible(wc, '#track-more');
      await settle();
      const geometry = await read(`(() => {
        const menu = document.querySelector('#track-more-options'), box = menu.getBoundingClientRect();
        const trigger = document.querySelector('#track-more').getBoundingClientRect();
        const controls = [...menu.querySelectorAll('button, input, select')].map(el => {
          const r = el.getBoundingClientRect();
          return { id: el.id, reachable: r.width > 0 && r.height > 0 && r.left >= box.left && r.right <= box.right
            && el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)) };
        });
        return { controls, fits: box.top >= 0 && box.bottom <= innerHeight && box.left >= 0 && box.right <= innerWidth,
          gap: Math.min(Math.abs(box.top - trigger.bottom), Math.abs(trigger.top - box.bottom)) };
      })()`);
      assert.ok(geometry.fits && geometry.gap <= 8, 'Edit tools should fit the window and sit against the toolbar trigger');
      for (const control of geometry.controls) assert.ok(control.reachable, control.id + ' should fit the edit popover');
      await clickVisible(wc, '#track-more-options .p-switch');
      await key('Escape', 27);
      await settle();
      assert.equal(await read('document.activeElement.id'), 'track-more', 'Escape returns to edit tools');
    }
    window.setContentSize(...originalSize);
    await settle();

    await click('#track-more');
    await settle();
    const select = el('#track-height');
    const picker = `menuState(${select}, '::picker(select)')`;
    await read(select + '.focus()');
    assert.equal(await read('document.activeElement.id'), 'track-height');
    await key('Enter', 13);
    assert.equal(await read(select + ".matches(':open')"), true);
    assert.ok((await read(picker)).opacity < 1, 'Native picker should animate in');
    await settle();
    assert.equal((await read(picker)).opacity, 1);
    assert.ok(await read(`(() => { const s = ${select}, above = s.options[0].getBoundingClientRect().top < s.getBoundingClientRect().top;
      return s.style.getPropertyValue('--picker-origin') === (above ? 'bottom' : 'top'); })()`), 'Picker moves from its trigger');
    await key('Escape', 27);
    assert.equal(await read(select + ".matches(':open')"), false);
    assert.equal(await read(el('#track-more-options') + ".matches(':popover-open')"), true);
    const pickerExit = await read(picker);
    assert.equal(pickerExit.pointer, 'none');
    assert.ok(pickerExit.opacity > 0, 'Native picker should animate out');
    await settle();
    await key('Enter', 13);
    await key('Home', 36);
    await key('ArrowDown', 40);
    await key('Enter', 13);
    assert.equal(await read(select + '.value'), 'medium');
    await key('Escape', 27);
    await settle();

    await click('#background-color');
    const wheel = el('.color-wheel-panel');
    assert.ok((await read(`menuState(${wheel})`)).opacity < 1);
    await settle();
    await key('Escape', 27);
    const wheelExit = await read(`menuState(${wheel})`);
    assert.ok(wheelExit.opacity > 0 && wheelExit.pointer === 'none');
    await click('#background-color');
    assert.equal(await read("document.querySelectorAll('.color-wheel-panel').length"), 1);
    assert.equal(await read(wheel + ".matches(':modal')"), true);
    await key('Escape', 27);
    await settle();
    assert.equal(await read(wheel + ' === null'), true);
    await media([{ name: 'prefers-reduced-motion', value: 'reduce' }, { name: 'forced-colors', value: 'active' }]);
    await click('#track-more');
    assert.equal((await read(`menuState(${el('#track-more-options')})`)).opacity, 1);
    await read(select + '.focus()');
    await key('Enter', 13);
    assert.equal((await read(picker)).opacity, 1);
    assert.equal(await read(`getComputedStyle(${select}, '::picker(select)').borderTopStyle`), 'solid');
    await key('Escape', 27);
    assert.equal((await read(picker)).display, 'none');
    assert.deepEqual(await read(`['multiple', 'size'].map(attribute => {
      const list = document.createElement('select'); list.setAttribute(attribute, attribute === 'size' ? '5' : '');
      document.body.append(list); const result = getComputedStyle(list).appearance; list.remove(); return result;
    })`), ['auto', 'auto']);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type, x: 8, y: 50, button: 'left', clickCount: 1 });
    }
    assert.equal(await read(el('#track-more-options') + ".matches(':popover-open')"), false);
    console.log('Menu entry, exit geometry, rapid reopen, nested keyboard selection, reduced motion and forced colors passed.');
  } finally {
    window.destroy();
  }
}

run().then(() => app.exit(0), error => { console.error(error); app.exit(1); });
