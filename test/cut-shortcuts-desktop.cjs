'use strict';

const {app} = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {setTimeout: delay} = require('node:timers/promises');
const {launchDesktop} = require('../src/desktop.cjs');
const {saveProject} = require('../src/project-format.cjs');
const {inspectAsset} = require('../src/media.cjs');
const {ffmpeg} = require('./fixtures.cjs');
const {clickVisible} = require('./desktop-input.cjs');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');

app.disableHardwareAcceleration();
const profile = process.env.JIAJIAN_SHORTCUT_TEST_DIR;
if (profile) app.setPath('userData', path.join(profile,'profile'));
async function check(dir) {
  const file = path.join(dir, '剪辑.sdworkbench'), pathVideo = path.join(dir, '测试.mp4');
  await ffmpeg(['-f','lavfi','-i','testsrc2=s=160x90:r=24:d=3','-c:v','libx264','-threads','2',pathVideo]);
  await saveProject(file, {
    ratio:'16:9', resolution:720, fps:24, fit:'fit', keepAudio:true, unordered:false, useOriginal:true,
    useMirrors:false, count:1, priority:'picture', musicVolume:35, musicIds:[], shots:[[{id:'v',start:0,end:3}]],
  }, new Map([['v',await inspectAsset(pathVideo,'video')]]));
  const win = await launchDesktop({show:false, dataDirectory:path.join(dir, 'profile'),
    dialogs:{showOpenDialog:async()=>({canceled:false,filePaths:[file]})}});
  win.setContentSize(1320, 900);
  const wc = win.webContents;
  wc.setBackgroundThrottling(false);
  wc.debugger.attach();
  const dispatch = (method, args) => wc.debugger.sendCommand('Input.' + method, args);
  const read = js => wc.executeJavaScript(js, true);
  const click = selector => clickVisible(wc, selector);
  const bind = (id, slot = 0) => '[data-bind-action="'+id+'"][data-slot="'+slot+'"]';
  const clear = (id, slot = 0) => bind(id,slot).replace('bind-','clear-');
  const host = '#timeline-cut-editor[data-mode="cut"]', button = id => host+' [data-action="'+id+'"]';
  const count = () => read('document.querySelectorAll(".video-cut-segment").length');
  async function wait(js) {
    for (let i=0;i<150;i++) { if (await read(js)) return; await delay(30); }
    throw Error('等待超时 '+js);
  }
  async function key(key, modifiers = 0) {
    const vk = {Escape:27,Delete:46,ArrowRight:39,Tab:9}[key] ?? key.toUpperCase().charCodeAt(0);
    for (const type of ['rawKeyDown','keyUp']) await dispatch('dispatchKeyEvent', {
      type, modifiers, key, code:key.length === 1 ? 'Key'+key.toUpperCase() : key,
      windowsVirtualKeyCode:vk, nativeVirtualKeyCode:vk,
    });
  }
  async function mouseClick(selector, fraction, twice) {
    const pos = await read("(async()=>{const element=document.querySelector("+JSON.stringify(selector)+");element.scrollIntoView({block:'nearest'});await new Promise(requestAnimationFrame);const r=element.getBoundingClientRect();return {x:r.left+r.width*"+fraction+",y:r.top+r.height/2};})()");
    for (const clickCount of twice ? [1,2] : [1]) {
      for (const type of ['mousePressed','mouseReleased']) await dispatch('dispatchMouseEvent',
        {type, ...pos, clickCount, button:'left', buttons:type==='mousePressed'?1:0});
    }
  }
  const openSettings = async () => {
    await click('#cut-shortcuts-entry');
    await wait('document.querySelector("#cut-shortcuts-dialog:modal")');
    assert.equal(await read('!!document.querySelector("#cloud-settings-dialog:modal")'),false);
    await read('Promise.allSettled(document.querySelector("#cut-shortcuts-dialog").getAnimations().map(animation=>animation.finished))');
  };
  const label = id => read('window.cutShortcuts.labelFor('+JSON.stringify(id)+')');
  async function reload() {
    const completed = new Promise(resolve => wc.once('did-finish-load', resolve));
    wc.reload();
    await completed;
    await wait('typeof window.cutShortcuts?.actionFor === "function"');
  }
  try {
    for (const [scheme,width] of [['light',1320],['dark',850]]) {
      win.setContentSize(width,900);
      await wc.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:scheme}]});
      await wait(`document.documentElement.dataset.theme==="${scheme}"`);
      assert.ok(await read(`(()=>{const buttons=['software-update-entry','cut-shortcuts-entry','app-settings'].map(id=>document.getElementById(id));
        const [update,shortcuts,settings]=buttons.map(el=>el.getBoundingClientRect());
        return buttons.every(el=>el.checkVisibility()) && update.right<=shortcuts.left && shortcuts.right<=settings.left &&
          settings.right<innerWidth && buttons[1].querySelector('use').getAttribute('href')==='#icon-keyboard';})()`));
      await openSettings();
      await click('#cut-shortcuts-close');
      await wait('document.activeElement.id==="cut-shortcuts-entry" && !document.querySelector("dialog:modal")');
    }
    win.setContentSize(1320,900);
    await click('#home-open-project');
    const clip = '.sequence-video [data-move-candidate]';
    await wait('!!document.querySelector('+JSON.stringify(clip)+')');
    await mouseClick(clip,.42,true);
    await wait('!!document.querySelector('+JSON.stringify(host)+')');
    assert.equal(await read('document.querySelector(".cut-precision").open'),false);
    await click('.cut-precision summary');
    const enter = async (id,value) => read('(()=>{const e=document.querySelector(\'[data-cut-time="'+id+'"]\');e.value='+JSON.stringify(value)+';e.dispatchEvent(new Event("change",{bubbles:true}));return e.value})()');
    assert.equal(await enter('start','6'),'00:00:00.06');
    assert.equal(await enter('end','00:00:02.00'),'00:00:02.00');
    assert.equal(await enter('duration','24'),'00:00:01.00');
    assert.equal(await read('document.querySelector(\'[data-cut-time="end"]\').value'),'00:00:01.06');
    await mouseClick(host+' .video-cut-ruler',.32);
    const sourceFrame = () => read('Number(document.querySelector(".video-cut-time").textContent.match(/第 (\\d+) 帧/)[1])');
    const before = await sourceFrame();
    await key('.');
    assert.equal(await sourceFrame(),before+1);
    await key(',',8);
    assert.equal(await sourceFrame(),before-9);
    await click(button('cancel'));
    await click('dialog:modal [data-cut-leave="cancel"]');
    assert.equal(await read('document.querySelector(".cut-pending-label").hidden'),false);
    await wait('!document.querySelector(".cut-leave-dialog")');
    await click(button('cancel'));
    await click('dialog:modal [data-cut-leave="discard"]');
    await wait('!document.querySelector('+JSON.stringify(host)+')');
    await mouseClick(clip,.42,true);
    await wait('!!document.querySelector('+JSON.stringify(host)+')');
    await mouseClick(host+' .video-cut-ruler',.32);
    await openSettings();
    assert.equal(await label('split'), 'W / Ctrl+B');
    assert.equal(await read('document.querySelectorAll("#cut-shortcuts-dialog .cut-shortcut-row").length'),14);
    assert.equal(await label('quick-save'), 'Ctrl+S');
    const storedBeforeConflict = await read('localStorage.getItem("jiajian.cut-shortcuts.v1")');
    await click(bind('split'));
    await key('k',2);
    assert.match(await read('document.querySelector("#cut-shortcuts-status").textContent'), /已分配.*命令面板/);
    assert.equal(await label('split'), 'W / Ctrl+B');
    assert.equal(await read('localStorage.getItem("jiajian.cut-shortcuts.v1")'), storedBeforeConflict);
    await key('Escape');
    await click(bind('mirror'));
    await key('m');
    assert.equal(await label('mirror'), 'M', '视频菜单中的 M 不占用裁剪页键位');
    await click('#cut-shortcuts-reset');
    // Simulate a 0.9.0 binding, keeping the same real settings and key handling paths.
    await read(`(() => {
      const key = 'jiajian.cut-shortcuts.v1', saved = JSON.parse(localStorage.getItem(key));
      saved.bindings.mirror = ['Ctrl+K'];
      localStorage.setItem(key,JSON.stringify(saved));
      window.dispatchEvent(new StorageEvent('storage',{key}));
    })()`);
    await key('Escape');
    await openSettings();
    assert.match(await read('document.querySelector("#cut-shortcuts-status").textContent'), /镜像.*Ctrl\+K/);
    await key('Escape');
    await mouseClick(host+' .video-cut-ruler',.32);
    await key('k',2);
    assert.equal(await read('document.querySelector('+JSON.stringify(button('mirror'))+').getAttribute("aria-pressed")'),'true');
    assert.equal(await read('!!document.querySelector("#command-palette:modal")'),false);
    await key('k',2);
    assert.equal(await read('document.querySelector('+JSON.stringify(button('mirror'))+').getAttribute("aria-pressed")'),'false');
    await read('document.getElementById("add-shot").focus()');
    await key('k',2);
    await wait('document.querySelector("#command-palette:modal")');
    await key('Escape');
    await read(`(() => {
      const key = 'jiajian.cut-shortcuts.v1', saved = JSON.parse(localStorage.getItem(key));
      saved.bindings.mirror = [null];
      saved.bindings['quick-save'] = ['Ctrl+K'];
      localStorage.setItem(key,JSON.stringify(saved));
      window.dispatchEvent(new StorageEvent('storage',{key}));
      document.getElementById('material-search').focus();
    })()`);
    await key('k',2);
    await wait('document.getElementById("notice").textContent.includes("工程已保存")');
    assert.equal(await read('!!document.querySelector("#command-palette:modal")'),false);
    await click('#command-palette-entry');
    await wait('document.querySelector("#command-palette:modal")');
    await key('Escape');
    await openSettings();
    await click('#cut-shortcuts-reset');
    await click(bind('split'));
    await key('s',2);
    assert.match(await read('document.querySelector("#cut-shortcuts-status").textContent'), /已分配.*快速保存/);
    await key('Escape');
    if (process.env.JIAJIAN_SHORTCUT_SCREENSHOT) {
      const shot = process.env.JIAJIAN_SHORTCUT_SCREENSHOT;
      await fs.mkdir(path.dirname(shot), {recursive:true});
      await fs.writeFile(shot, (await wc.capturePage()).toPNG());
    }
    await click(bind('split'));
    await key('q');
    assert.match(await read('document.querySelector("#cut-shortcuts-status").textContent'), /已分配/);
    await key('Delete');
    assert.match(await read('document.querySelector("#cut-shortcuts-status").textContent'), /导航/);
    await key('Escape');
    assert.equal(await label('split'), 'W / Ctrl+B');
    assert.equal(await read('document.querySelector("#cut-shortcuts-dialog").open'),true);
    await click(bind('split'));
    await key('k');
    await click(clear('split',1));
    await click(bind('mirror'));
    await key('g');
    await click(bind('rotate'));
    await key('r');
    assert.equal(await count(),1,'录制键位不得修改剪辑');
    assert.equal(await label('split'),'K');
    await key('Escape');
    await wait('!document.querySelector("#cut-shortcuts-dialog[open]") && document.activeElement.id==="cut-shortcuts-entry"');
    await mouseClick(host+' .video-cut-ruler',.34);
    assert.match(await read('document.querySelector('+JSON.stringify(button('split'))+').title'),/K/);
    await key('w');
    await key('b',2);
    assert.equal(await count(),1,'已解除的主键和备用键都不得生效');
    await key('k');
    assert.equal(await count(),2);
    await key('s',2);
    await wait('document.querySelector("#notice").textContent.includes("工程已保存") && !document.querySelector("#save-project").disabled');
    assert.match(await read('document.querySelector("#notice").textContent'), /应用裁剪/);
    assert.equal(await count(),2,'快速保存应保留正在调整的两个片段');
    const savedClip = JSON.parse(await fs.readFile(file, 'utf8')).config.shots[0][0];
    assert.equal(savedClip.sourceEdit, undefined, '快速保存应仅写入已经应用的编辑');
    await key('r');
    const rotation = 'document.querySelector('+JSON.stringify(button('rotate'))+').title';
    assert.match(await read(rotation),/当前 90°.*R/);
    await mouseClick(host+' .video-cut-ruler',.1);
    assert.match(await read(rotation),/当前 0°.*R/);
    await mouseClick(host+' .video-cut-ruler',.7);
    assert.match(await read(rotation),/当前 90°.*R/);
    await key('g');
    assert.equal(await read('document.querySelector('+JSON.stringify(button('mirror'))+').getAttribute("aria-pressed")'),'true');
    await key('z',2);
    assert.equal(await read('document.querySelector('+JSON.stringify(button('mirror'))+').getAttribute("aria-pressed")'),'false');
    await key('z',10);
    assert.equal(await read('document.querySelector('+JSON.stringify(button('mirror'))+').getAttribute("aria-pressed")'),'true');
    await openSettings();
    await click(bind('mirror'));
    await key('z',2);
    assert.match(await read('document.querySelector("#cut-shortcuts-status").textContent'), /已分配.*撤销/);
    await key('Escape');
    await click(clear('undo'));
    await click(bind('mirror'));
    await key('z',2);
    assert.equal(await label('mirror'),'Ctrl+Z');
    await key('Escape');
    await wait('!document.querySelector("#cut-shortcuts-dialog[open]")');
    await click('#material-search');
    await key('z',2);
    assert.equal(await read('document.querySelector('+JSON.stringify(button('mirror'))+').getAttribute("aria-pressed")'),'true');
    await mouseClick(host+' .video-cut-ruler',.7);
    await key('z',2);
    assert.equal(await read('document.querySelector('+JSON.stringify(button('mirror'))+').getAttribute("aria-pressed")'),'false');
    assert.equal(await count(),2,'重新分配 Ctrl+Z 后不得触发局部或工程撤销');
    await key('Escape');
    await click('[data-cut-leave="discard"]');
    await reload();
    assert.equal(await label('split'),'K');
    assert.equal(await label('mirror'),'Ctrl+Z');
    await read(`(() => {
      const key = 'jiajian.cut-shortcuts.v1', saved = JSON.parse(localStorage.getItem(key));
      delete saved.bindings['quick-save'];
      saved.bindings.rotate = ['Ctrl+S'];
      localStorage.setItem(key, JSON.stringify(saved));
    })()`);
    await reload();
    assert.equal(await label('split'),'K');
    assert.equal(await label('rotate'),'Ctrl+S');
    assert.equal(await label('quick-save'),'');
    await openSettings();
    await click('#cut-shortcuts-reset');
    assert.equal(await label('split'),'W / Ctrl+B');
    assert.equal(await label('mirror'),'');
    await read('localStorage.setItem("jiajian.cut-shortcuts.v1","{")');
    await reload();
    assert.equal(await label('split'),'W / Ctrl+B');
    await openSettings();
    await click(bind('split'));
    await key('k');
    wc.session.flushStorageData();
  } finally { wc.debugger.detach(); win.destroy(); }
}

async function run() {
  if (process.env.JIAJIAN_SHORTCUT_PHASE === 'edit') return check(profile);
  if (process.env.JIAJIAN_SHORTCUT_PHASE === 'relaunch') {
    const win = await launchDesktop({show:false, dataDirectory:path.join(profile,'profile')});
    assert.equal(await win.webContents.executeJavaScript('window.cutShortcuts.labelFor("split")'),'K / Ctrl+B');
    win.destroy();
    return;
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jiajian-shortcuts-'));
  for (const phase of ['edit','relaunch']) {
    await promisify(execFile)(process.execPath,[__filename], {
      env:{...process.env,JIAJIAN_SHORTCUT_TEST_DIR:dir,JIAJIAN_SHORTCUT_PHASE:phase},windowsHide:true,timeout:60000,
    });
  }
  console.log('快捷键子菜单、冲突、清空、重新分配撤销键、输入隔离、旋转提示、实际剪辑、冷启动持久化和损坏配置回退通过。');
}

run().then(()=>app.exit(0), error=>{console.error(error);app.exit(1);});
