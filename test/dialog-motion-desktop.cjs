'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { app } = require('electron');
const { launchDesktop } = require('../src/desktop.cjs');
const { ffmpeg } = require('./fixtures.cjs');

app.disableHardwareAcceleration();

async function run() {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'jiajian-dialog-'));
  app.setPath('userData', path.join(profile, 'electron'));
  const still = path.join(profile, '调色样图.png');
  await ffmpeg(['-f','lavfi','-i','color=red:s=160x90','-frames:v','1','-threads','1',still]);
  const win = await launchDesktop({show: false, dataDirectory: profile, dialogs: {
    async showOpenDialog() { return {canceled:false,filePaths:[still]}; },
  }});
  const wc = win.webContents;
  win.setContentSize(1440, 1000);
  wc.setBackgroundThrottling(false);
  wc.debugger.attach();
  const send = (method, args) => wc.debugger.sendCommand(method, args);
  const read = expression => wc.executeJavaScript(expression, true);
  const q = selector => 'document.querySelector(' + JSON.stringify(selector) + ')';
  const button = (parent, title) => '[...' + parent + '.querySelectorAll("button")].find(b => b.textContent === ' + JSON.stringify(title) + ')';
  const settle = () => read('new Promise(resolve => setTimeout(resolve, 250))');
  const media = value => send('Emulation.setEmulatedMedia', {features: [{name:'prefers-reduced-motion',value}]});
  async function mouse(node) {
    const point = await read('(() => {const e=' + node + ';e.scrollIntoView({block:"nearest",inline:"nearest"});const r=e.getBoundingClientRect();const x=r.left+r.width/2,y=r.top+r.height/2;return {x,y,hit:e.contains(document.elementFromPoint(x,y))};})()');
    assert.ok(point.hit, 'Hit test ' + node);
    for (const type of ['mousePressed','mouseReleased']) await send('Input.dispatchMouseEvent',
      {type, x:point.x, y:point.y, button:'left', buttons:type==='mousePressed'?1:0, clickCount:1});
  }
  async function key(keyName, code) {
    for (const type of ['keyDown','keyUp']) await send('Input.dispatchKeyEvent',
      {type,key:keyName,code:keyName,windowsVirtualKeyCode:code,text:keyName==='Enter'&&type==='keyDown'?'\r':''});
  }
  const state = node => read('sheetState(' + node + ')');
  try {
    await send('Emulation.setFocusEmulationEnabled', {enabled:true});
    await media('no-preference');
    await read('window.sheetState = d => d && ({modal:d.matches(":modal"), opacity:+getComputedStyle(d).opacity, scrim:+getComputedStyle(d,"::backdrop").opacity, pointer:getComputedStyle(d).pointerEvents, count:d.childElementCount, top:d.offsetTop}); void 0;');
    await read("document.querySelector('#tab-script').click()");
    await settle();
    await read("document.querySelector('#script-go-montage').click()");
    await settle();
    await mouse(q('#add-shot'));
    const layer = q('.sequence-dialog[open]'), trigger = q('#timeline-layer-add');
    await mouse(trigger);
    const entry = await state(layer);
    assert.ok(entry?.modal && entry.opacity < 1 && entry.scrim < 1, '包装轨道和遮罩应从透明进入 ' + JSON.stringify(entry));
    await settle();
    const open = await state(layer);
    assert.equal(open.opacity, 1);
    assert.equal(open.scrim, 1);
    const originError = await read('(() => {const d='+layer+', r='+trigger+'.getBoundingClientRect(), [x,y]=getComputedStyle(d).transformOrigin.split(" ").map(parseFloat);return Math.max(Math.abs(x-Math.max(0,Math.min(d.offsetWidth,r.left+r.width/2-d.offsetLeft))),Math.abs(y-Math.max(0,Math.min(d.offsetHeight,r.top+r.height/2-d.offsetTop))));})()');
    assert.ok(originError < 2, '包装面板从按钮方向出现');
    const motion = button(layer, '调整关键帧'), child = q('.layer-motion-dialog');
    await mouse(motion);
    assert.ok((await state(child)).opacity < 1);
    await settle();
    const childTop = (await state(child)).top;
    await key('Escape',27);
    const exit = await state(child);
    assert.ok(exit && !exit.modal && exit.opacity > 0 && exit.scrim > 0 && exit.pointer === 'none', '退出动画保留内容并释放命中');
    assert.equal(exit.top, childTop, '关闭时保留原有位置');
    assert.equal(await read('document.activeElement === '+motion),true);
    await settle();
    assert.equal(await read(child),null);

    const details = q('.sequence-dialog[open] .text-presets');
    await mouse(details + '.querySelector("summary")');
    assert.ok(await read(details + '.open && +getComputedStyle(' + details + ', "::details-content").opacity < 1'));
    await settle();
    assert.equal(await read('getComputedStyle(' + details + ', "::details-content").opacity'), '1');
    await mouse(details + '.querySelector("summary")');
    await settle();

    await read('(() => {const type=' + layer + '.querySelectorAll("select")[1];type.value="pip";type.dispatchEvent(new Event("change"));})()');
    await mouse(button(layer, '选择文件'));
    for (let attempt=0; attempt<80 && !await read('!!' + button(layer, '调色样图.png')); attempt++) {
      await read('new Promise(resolve => setTimeout(resolve, 50))');
    }
    const grading = button(layer, '调色 / 滤镜 / 特效');
    await mouse(grading);
    const visual = q('.jj-visual-editor');
    assert.ok((await state(visual)).opacity < 1);
    await settle();
    await mouse(button(visual,'应用设置'));
    assert.equal(await read('document.activeElement === ' + grading),true);
    await settle();

    await mouse(button(layer,'关闭'));
    assert.ok((await state(q('.sequence-dialog'))).opacity > 0);
    assert.equal(await read('document.activeElement === '+trigger),true);
    await mouse(trigger);
    await settle();
    assert.equal(await read('document.querySelectorAll(".sequence-dialog").length'),1);
    const form = layer + '.querySelector("form")';
    await read(form + '.requestSubmit()');
    assert.equal((await state(layer)).modal,true,'无效文字保留编辑器');
    await read(layer + '.querySelector("textarea").value = "包装保存验收"');
    await mouse(button(layer,'保存'));
    await settle();
    assert.equal(await read(q('.sequence-dialog')),null);
    assert.equal(await read('document.querySelectorAll(".sequence-layer.kind-text .sequence-block").length'),1);

    const menuButton = q('#timeline-more'), cover = q('.jj-cover-editor');
    await mouse(menuButton);
    await settle();
    await mouse(q('#timeline-cover'));
    assert.ok((await state(cover)).opacity < 1);
    await settle();
    await key('Escape',27);
    const fading = await state(cover);
    assert.ok(fading.count > 0 && fading.opacity > 0 && !fading.modal);
    await read('new Promise(requestAnimationFrame)');
    assert.equal(await read('document.activeElement.id'),'timeline-more');
    // Reopen this reusable editor before the previous close's cleanup finishes.
    await read(q('#timeline-cover')+'.click()');
    await settle();
    assert.ok((await state(cover)).modal && (await state(cover)).count > 0);
    await key('Escape',27);
    await settle();
    assert.equal((await state(cover)).count,0);

    const settings = q('#cloud-settings-dialog');
    await mouse(q('#app-settings'));
    assert.ok((await state(settings)).opacity < 1);
    await settle();
    await mouse(q('#cloud-settings-cancel'));
    assert.equal((await state(settings)).modal,false);
    await mouse(q('#app-settings'));
    await settle();
    assert.equal((await state(settings)).opacity,1);
    await key('Escape',27);
    await settle();

    await media('reduce');
    await read(trigger + '.focus()');
    await key('Enter',13);
    assert.equal((await state(layer)).opacity,1);
    assert.equal(await read(layer+'.getAnimations().length'),0);
    await key('Escape',27);
    assert.equal(await read('!!document.querySelector("dialog:modal")'),false);
    assert.equal(await read('document.activeElement === '+trigger),true);
    await settle();
    assert.equal(await read(q('.sequence-dialog')),null);
    console.log('Packaging, nested keyframes, presets and grading, tools, settings, focus, rapid reopen and reduced motion passed.');
  } finally {
    win.destroy();
  }
}

run().then(() => app.exit(0), error => {console.error(error); app.exit(1);});
