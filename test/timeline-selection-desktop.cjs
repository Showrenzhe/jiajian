'use strict';

const assert = require('node:assert/strict');
const { mkdtempSync } = require('node:fs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { app } = require('electron');
const { launchDesktop } = require('../src/desktop.cjs');
const { fixtures } = require('./fixtures.cjs');

app.disableHardwareAcceleration();

async function check() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'jiajian-selection-'));
  const library = path.join(root, '素材目录');
  const picks = [];
  const win = await launchDesktop({ show: false, dataDirectory: path.join(root, 'profile'), dialogs: {
    async showOpenDialog(_win, options) {
      const next = picks.shift();
      assert.equal(options.title, next?.title);
      return { canceled: false, filePaths: next.files };
    },
  } });
  await fs.mkdir(library);
  const files = await fixtures(library);
  const original = await fs.readFile(files.red);
  win.setContentSize(1400, 960);
  const read = (expression) => win.webContents.executeJavaScript(expression, true);
  const query = (selector) => 'document.querySelector(' + JSON.stringify(selector) + ')';
  const count = (selector) => 'document.querySelectorAll(' + JSON.stringify(selector) + ').length';
  const click = (selector) => read(query(selector) + '.click()');
  async function wait(condition, label) {
    const end = Date.now() + 16000;
    while (Date.now() < end) {
      if (await read(condition)) return;
      await delay(50);
    }
    const state = await read('({notice:document.querySelector("#notice").textContent,focus:document.activeElement.outerHTML.slice(0,240),selected:document.querySelectorAll(".sequence-marked").length})');
    throw new Error(label + ' ' + JSON.stringify(state));
  }
  win.webContents.debugger.attach();
  const send = (method, params) => win.webContents.debugger.sendCommand('Input.' + method, params);
  const mouse = (type, x, y) => send('dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left',
    buttons: type === 'mouseReleased' ? 0 : 1, clickCount: type === 'mouseMoved' ? 0 : 1 });
  async function pressDelete() {
    const event = { key:'Delete', code:'Delete', windowsVirtualKeyCode:46, nativeVirtualKeyCode:46 };
    await send('dispatchKeyEvent', { ...event, type:'rawKeyDown' });
    await send('dispatchKeyEvent', { ...event, type:'keyUp' });
  }
  async function actualClick(selector) {
    const point = await read('(() => {const el=' + query(selector) + ';el.scrollIntoView({block:"nearest",inline:"nearest"});'
      + 'const r=el.getBoundingClientRect();for (const n of [.5,.25,.65,.85,.12]) {const x=r.left+r.width*n,y=r.top+r.height/2;if(el.contains(document.elementFromPoint(x,y)))return {x,y};}return null;})()');
    assert.ok(point, selector + ' 应可用鼠标点击');
    await mouse('mousePressed', point.x, point.y);
    await mouse('mouseReleased', point.x, point.y);
  }
  const undo = () => click('#track-undo');
  const video = '.sequence-video .sequence-block[data-selectable]';
  const music = '.sequence-music .sequence-block[data-selectable]';
  const voice = '.sequence-voice .sequence-block[data-selectable]';
  const layer = '.sequence-layer .sequence-block[data-selectable]';
  const tile = (file) => '.material-tile[title=' + JSON.stringify(path.basename(file)) + ']';
  try {
    picks.push({ title: '选择分镜素材', files: [files.red, files.green, files.blue] });
    await click('#home-import');
    await wait(count(video)+'===3 && '+count('.material-used')+'===3','三个素材均应标记已用');
    await actualClick(video);
    await pressDelete();
    await wait(count(video)+'===2 && !'+query(tile(files.red))+'.dataset.used','删除一个候选应移除它的使用标志并保留源素材');
    await undo();
    await wait(count(video)+'===3 && '+query(tile(files.red))+'.dataset.used==="true"','撤销应恢复视频及使用标志');

    const box = await read('(() => {const [a,b]=document.querySelectorAll('+JSON.stringify(video)+');a.scrollIntoView({block:"nearest",inline:"nearest"});'
      +'const one=a.getBoundingClientRect(),two=b.getBoundingClientRect(),row=a.closest(".sequence-row").getBoundingClientRect();'
      +'const x=one.left+one.width*.45,y=row.top+1.4;return {x,y,toX:two.left+two.width*.65,toY:two.top+two.height*.62,hit:document.elementFromPoint(x,y)?.className};})()');
    assert.match(box.hit,/sequence-content/,'从轨道空白处框选');
    await mouse('mousePressed',box.x,box.y);
    await mouse('mouseMoved',(box.x+box.toX)/2,box.toY);
    await mouse('mouseMoved',box.toX,box.toY);
    await mouse('mouseReleased',box.toX,box.toY);
    await wait(count(video+'.sequence-marked')+'===2','鼠标框选两个候选');
    await pressDelete();
    await wait(count(video)+'===1 && '+count('.material-used')+'===1','单次 Del 移除两个候选');
    await undo();
    await wait(count(video)+'===3 && '+count('.material-used')+'===3','一次撤销恢复整个选区');

    picks.push({ title:'选择配乐', files:[files.music] });
    await click('#inspector-tab-music');
    await click('#pick-music');
    await wait(count(music)+'===1','添加配乐');
    picks.push({ title:'选择口播音频', files:[files.otherMusic] });
    await click('#inspector-tab-narration');
    if (!await read(query('#whole-track-settings')+'.open')) await click('#whole-track-summary');
    await click('#pick-narration');
    await wait(count(voice)+'===1','添加口播');
    await click('#timeline-layer-add');
    await read('(() => {const d=document.querySelector(".sequence-dialog[open]");d.querySelector("textarea").value="删除验收";d.querySelector("form").requestSubmit()})()');
    await wait(count(layer)+'===1','添加包装文字');
    for (const [name, target] of [['配乐',music], ['包装',layer], ['口播',voice]]) {
      await actualClick(target);
      await pressDelete();
      await wait(count(target)+'===0', name+'选中后按 Del');
      await undo();
      await wait(count(target)+'===1',name+'撤销后恢复');
    }

    picks.push({ title:'选择素材文件夹',files:[library] });
    await click('#material-folder-import');
    await wait('!!'+query('#material-folders .material-folder'),'添加素材目录');
    await click('#material-folders .material-folder');
    await wait(query(tile(files.red))+'?.dataset.used==="true" && !!'+query(tile(files.still))+' && !'+query(tile(files.still))+'.dataset.used','文件夹应区分已用与未用素材');
    const duplicateDrop = '(() => {const source='+query(tile(files.red))+',target=document.querySelectorAll("#shots .shot")[1],dt=new DataTransfer();'
      +'for(const [el,type] of [[source,"dragstart"],[target,"dragover"],[target,"drop"],[source,"dragend"]])el.dispatchEvent(new DragEvent(type,{bubbles:true,cancelable:true,dataTransfer:dt}));})()';
    await read(duplicateDrop);
    await wait(count(video)+'===4 && '+query(tile(files.red)+' .material-used')+'.title.includes("1、2")','重复源文件用于两个分镜时应标出两个分镜号');
    await actualClick(tile(files.red));
    await pressDelete();
    await wait(count(video)+'===2 && !'+query(tile(files.red)), '从文件夹删除应移除两个分镜中的同源候选');
    assert.deepEqual(await fs.readFile(files.red), original, '删除库素材后原文件的每个字节都应保留');
    await undo();
    await wait(count(video)+'===4 && '+query(tile(files.red))+'?.dataset.used==="true"', '撤销应还原文件夹素材和全部同源候选');
    assert.deepEqual(picks,[]);
    console.log('时间线删除、框选、文件夹同源标记和撤销通过。');
  } finally {
    win.webContents.debugger.detach();
    win.destroy();
  }
}

check().then(() => app.exit(0), (error) => { console.error(error); app.exit(1); });
