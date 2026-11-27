'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const {mkdtempSync} = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {setTimeout: delay} = require('node:timers/promises');
const {app} = require('electron');
const {launchDesktop} = require('../src/desktop.cjs');
const {inspectAsset} = require('../src/media.cjs');
const {saveProject} = require('../src/project-format.cjs');
const {clickVisible} = require('./desktop-input.cjs');
const {ffmpeg} = require('./fixtures.cjs');

const dir = mkdtempSync(path.join(os.tmpdir(), 'jiajian-command-palette-'));
const dataDirectory = path.join(dir, 'profile');
app.setPath('userData', dataDirectory);
app.setVersion(require('../package.json').version);

async function check() {
  const file = path.join(dir, '青山暮色.jiajian'), video = path.join(dir, '蓝调渐变.mp4');
  await ffmpeg(['-f','lavfi','-i','gradients=s=480x270:c0=0x345466:c1=0x9ab0b2:x0=0:y0=200:x1=420:y1=35:speed=0.01:r=24',
    '-f','lavfi','-i','sine=f=440:r=48000','-t','2','-pix_fmt','yuv420p','-threads','2', video]);
  const asset = await inspectAsset(video, 'video');
  await saveProject(file, {ratio:'16:9',resolution:720,fps:24,fit:'fit',keepAudio:true,unordered:false,
    useOriginal:true,useMirrors:false,count:1,priority:'picture',musicVolume:35,musicIds:[],
    shots:[[{id:'v',start:0,end:1}],[{id:'v',start:1,end:2}]],
    shotSettings:[{name:'晨光',duration:1},{name:'暮色',duration:1}]}, new Map([['v',asset]]));

  let pendingPicker;
  const win = await launchDesktop({show:false, dataDirectory,
    dialogs:{showOpenDialog:async () => pendingPicker?.promise ?? {canceled:false,filePaths:[file]}}});
  const wc = win.webContents;
  wc.debugger.attach();
  wc.setBackgroundThrottling(false);
  const read = expr => wc.executeJavaScript(expr, true);
  const click = selector => clickVisible(wc, selector);
  const command = (method, params) => wc.debugger.sendCommand(method, params);
  const modal = 'document.querySelector("#command-palette:modal")';
  const focused = 'document.activeElement.id';
  const results = '[...document.querySelectorAll("#palette-results .palette-option-title")].map(el=>el.textContent)';

  async function wait(expr) {
    for (let i = 0; i < 180; i++) { if (await read(expr)) return; await delay(25); }
    throw Error('等待界面超时 ' + expr);
  }
  async function key(key, code, vk, modifiers = 0) {
    for (const type of ['rawKeyDown','keyUp']) await command('Input.dispatchKeyEvent',
      {type,key,code,windowsVirtualKeyCode:vk,nativeVirtualKeyCode:vk,modifiers});
  }
  async function open() {
    await key('k','KeyK',75,2);
    await wait(modal + ' && ' + focused + ' === "palette-query"');
  }
  const escape = () => key('Escape','Escape',27);
  const enter = () => key('Enter','Enter',13);
  const type = text => command('Input.insertText', {text});
  const output = process.env.JIAJIAN_PALETTE_EVIDENCE;
  try {
    win.setContentSize(1366,768);
    await click('#command-palette-entry');
    await wait(modal);
    await escape();
    await wait('!' + modal + ' && ' + focused + ' === "command-palette-entry"');
    await open();
    await type('搜不到这个命令');
    await wait('!document.querySelector("#palette-status").hidden && !document.querySelector("#palette-results").children.length');
    await enter();
    assert.ok(await read(modal + ' !== null'));
    await escape();

    await open();
    await type('设');
    await wait(results + '.length >= 2');
    const first = await read('document.querySelector("#palette-query").getAttribute("aria-activedescendant")');
    await key('ArrowDown','ArrowDown',40);
    assert.notEqual(await read('document.querySelector("#palette-query").getAttribute("aria-activedescendant")'), first);
    await key('ArrowUp','ArrowUp',38);
    assert.equal(await read('document.querySelector("#palette-query").getAttribute("aria-activedescendant")'), first);
    await escape();

    await open();
    await type('剪助');
    await wait(results + '[0] === window.editorCommands.get("editing-help").title');
    await enter();
    await wait('document.querySelector("#editing-help-dialog:modal")');
    await escape();
    await open();
    await type(await read('window.editorCommands.get("settings.appearance").title'));
    await click('#palette-option-0');
    await wait('document.querySelector("#cloud-settings-dialog:modal")');
    await key('k','KeyK',75,2);
    assert.equal(await read(modal + ' === null'), true);
    await escape();
    await open();
    await type('软更');
    await wait(results + '[0] === window.editorCommands.get("software-update-entry").title');
    await enter();
    await wait('document.querySelector("#update-dialog:modal")');
    await escape();
    await click('#home-open-project');
    const clip = '.sequence-video [data-move-candidate]';
    await wait('document.querySelectorAll(' + JSON.stringify(clip) + ').length === 2');
    if (await read('!!document.querySelector("#editing-tour")')) await click('#editing-tour button:first-child');
    await click(clip);
    await open();
    const priority = await read('["add-text","add-sticker","mute-video","video-speed"].map(id=>window.editorCommands.get(id).title)');
    assert.deepEqual((await read(results)).slice(0,4), priority);
    for (const theme of ['light','dark']) {
      await command('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:theme}]});
      await wait('document.documentElement.dataset.theme === ' + JSON.stringify(theme) + ' && !document.documentElement.hasAttribute("data-theme-changing")');
      await read('Promise.allSettled(document.querySelector("#command-palette").getAnimations().map(animation => animation.finished)).then(() => true)');
      const geometry = await read(`(() => {
        const r=document.querySelector('#command-palette').getBoundingClientRect();
        return {centered:Math.abs((r.left+r.right)/2-innerWidth/2)<2 && Math.abs((r.top+r.bottom)/2-innerHeight/2)<2,
          fits:r.top>=0 && r.left>=0 && r.right<=innerWidth && r.bottom<=innerHeight};
      })()`);
      assert.deepEqual(geometry,{centered:true,fits:true});
      if (output) {
        await delay(250);
        const shot = await wc.capturePage();
        assert.deepEqual(shot.getSize(),{width:1366,height:768});
        await fs.writeFile(path.join(dir,theme+'.png'), shot.toPNG());
      }
    }
    if (output) {
      await fs.mkdir(path.dirname(output),{recursive:true});
      await ffmpeg(['-y','-i',path.join(dir,'light.png'),'-i',path.join(dir,'dark.png'),'-filter_complex',
        '[0:v]scale=960:540[l];[1:v]scale=960:540[d];[l][d]hstack','-frames:v','1','-update','1','-q:v','3',output]);
    }
    await type('候选操作');
    await click('#palette-option-0');
    await wait('document.querySelector(".sequence-dialog:modal h2")?.textContent.includes("蓝调渐变")');
    await escape();
    await open();
    await type('静音片段');
    await enter();
    await open();
    await type('取消静音');
    await wait(results + '[0] === window.editorMessages.commandTitles["unmute-video"]');
    await enter();
    await open();
    await type('倍速');
    await click('#palette-option-0');
    await wait('!' + modal + ' && ' + focused + ' === "track-speed"');

    await click('#title-home');
    const available = 'window.editorCommands.get("open-project").when()';
    pendingPicker = Promise.withResolvers();
    await click('#home-open-project');
    await wait('!' + available);
    await open();
    await type('青暮');
    await wait('document.querySelector("#palette-status").textContent === window.editorMessages.commandPalette.empty');
    assert.deepEqual(await read(results), []);
    await escape();
    pendingPicker.resolve({canceled:true,filePaths:[]});
    await wait(available);

    // A request already in flight can outlive the query which displayed a recent project.
    await click('#draft-search');
    await type('保留输入');
    await open();
    await type('青暮');
    await wait(results + '[0]?.includes("青山暮色")');
    pendingPicker = Promise.withResolvers();
    await read('void window.editorCommands.execute("open-project")');
    await wait('!' + available);
    await enter();
    await wait(modal + ' && ' + focused + ' === "palette-query" && document.querySelector("#palette-status").textContent === window.editorMessages.commandPalette.recentUnavailable');
    assert.deepEqual(await read(results), []);
    pendingPicker.resolve({canceled:true,filePaths:[]});
    pendingPicker = undefined;
    await wait(available);
    await escape();
    await wait(focused + ' === "draft-search" && document.querySelector("#draft-search").value === "保留输入"');
    await open();
    await type('青暮');
    await wait(results + '[0]?.includes("青山暮色")');
    await enter();
    await wait('document.querySelector(".app-frame").dataset.mode === "montage" && document.querySelectorAll(' + JSON.stringify(clip) + ').length === 2');
    console.log('命令面板的键鼠操作、焦点恢复、模糊搜索、最近工程重开、设置和片段命令优先级通过。');
  } finally {
    wc.debugger.detach();
    win.destroy();
  }
}
check().then(() => app.exit(0), error => {console.error(error); app.exit(1);});
