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
const { clickVisible } = require('./desktop-input.cjs');

app.disableHardwareAcceleration();

async function check() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'jiajian-selection-'));
  const library = path.join(root, '素材目录');
  const project = path.join(root, '素材移除.sdworkbench');
  const picks = [];
  const openedPickers = [];
  const win = await launchDesktop({ show: false, dataDirectory: path.join(root, 'profile'), dialogs: {
    async showOpenDialog(_win, options) {
      openedPickers.push(options.title);
      const next = picks.shift();
      assert.equal(options.title, next?.title);
      return { canceled: false, filePaths: next.files };
    },
    async showSaveDialog(_win, options) {
      assert.equal(options.title, '保存工程');
      return { canceled: false, filePath: project };
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
  async function pressKey(key, code) {
    const event = { key, code:key, windowsVirtualKeyCode:code, nativeVirtualKeyCode:code };
    await send('dispatchKeyEvent', { ...event, type:'rawKeyDown' });
    await send('dispatchKeyEvent', { ...event, type:'keyUp' });
  }
  const pressDelete = () => pressKey('Delete', 46);
  async function pointerPoint(selector) {
    const point = await read('(() => {const el=' + query(selector) + ';el.scrollIntoView({block:"nearest",inline:"nearest"});'
      + 'const r=el.getBoundingClientRect();for (const n of [.5,.25,.65,.85,.12]) {const x=r.left+r.width*n,y=r.top+r.height/2;if(el.contains(document.elementFromPoint(x,y)))return {x,y};}return null;})()');
    assert.ok(point, selector + ' 应可用鼠标点击');
    return point;
  }
  async function actualClick(selector) {
    const point=await pointerPoint(selector);
    await mouse('mousePressed', point.x, point.y);
    await mouse('mouseReleased', point.x, point.y);
  }
  const undo = () => click('#track-undo');
  const video = '.sequence-video .sequence-block[data-selectable]';
  const music = '.sequence-music .sequence-block[data-selectable]';
  const voice = '.sequence-voice .sequence-block[data-selectable]';
  const layer = '.sequence-layer .sequence-block[data-selectable]';
  const tile = (file) => '.material-tile[title=' + JSON.stringify(path.basename(file)) + ']';
  const slot='.sequence-video .sequence-empty[data-drop-shot="0"]';
  try {
    await clickVisible(win.webContents,'#home-create');
    await wait('!!'+query(slot),'空工程的视频轨道应有素材落点');
    await actualClick(slot);
    await pressKey('Enter',13);
    await pressKey(' ',32);
    assert.ok(await read(query(slot)+'.tabIndex<0 && !'+query(slot)+'.matches("button,[role=button]") && document.activeElement.id==="timeline-clock"'),'空位是静态落点，键盘焦点留在时间线');
    assert.deepEqual(openedPickers,[],'点击空工程落点及按回车、空格均不应打开文件框');
    picks.push({ title: '选择分镜素材', files: [files.red, files.green, files.blue] });
    await actualClick('#material-import');
    await wait(count(video)+'===3 && '+count('.material-used')+'===3','三个素材均应标记已用');
    await actualClick(video);
    await pressDelete();
    await wait(count(video)+'===2 && !'+query(tile(files.red))+'.dataset.used','删除一个候选应移除它的使用标志并保留源素材');
    await actualClick(video);
    await wait(count(video+'.sequence-marked')+'===1','点选已有候选');
    await actualClick(slot);
    await wait(count(video+'.sequence-marked')+'===0','点击已建分镜空位应像轨道空白一样清除选区');
    const emptyPoint=await pointerPoint(slot), nextPoint=await pointerPoint(video);
    await mouse('mousePressed',emptyPoint.x,emptyPoint.y);await mouse('mouseMoved',nextPoint.x,nextPoint.y);
    await mouse('mouseReleased',nextPoint.x,nextPoint.y);
    await wait(count(video+'.sequence-marked')+'===1','可从空候选格开始框选相邻素材');
    assert.deepEqual(openedPickers,['选择分镜素材'],'只有素材库显式导入打开了文件框');
    await undo();
    await wait(count(video)+'===3 && '+query(tile(files.red))+'.dataset.used==="true"','撤销应恢复视频及使用标志');

    const box = await read('(() => {const [a,b]=document.querySelectorAll('+JSON.stringify(video)+');a.scrollIntoView({block:"nearest",inline:"nearest"});'
      +'const one=a.getBoundingClientRect(),two=b.getBoundingClientRect(),row=a.closest(".sequence-row").getBoundingClientRect();'
      +'const x=one.left+one.width*.45,y=row.top+1.4;return {x,y,toX:two.left+two.width*.65,toY:two.top+two.height*.62,hit:document.elementFromPoint(x,y)?.className};})()');
    assert.match(box.hit,/sequence-content/,'从轨道空白处框选');
    await actualClick(video);
    const originalSelection = await read(query(video+'.sequence-marked')+'.textContent');
    await mouse('mousePressed',box.x,box.y);
    await mouse('mouseMoved',box.toX,box.toY);
    await wait(count(video+'.sequence-marked')+'===2','拖动中应预览两个候选');
    await pressKey('Escape',27);
    await wait(query('.timeline-marquee')+'.hidden','Esc 应立即收起时间线选框');
    await mouse('mouseReleased',box.toX,box.toY);
    assert.equal(await read(count(video+'.sequence-marked')),1,'取消后松手应保留原来的单选');
    assert.equal(await read(query(video+'.sequence-marked')+'.textContent'),originalSelection);
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
    await read(query('#material-folders .material-folder') + '.dispatchEvent(new MouseEvent("dblclick", {bubbles:true}))');
    await wait(query(tile(files.red))+'?.dataset.used==="true" && !!'+query(tile(files.still))+' && !'+query(tile(files.still))+'.dataset.used','文件夹应区分已用与未用素材');
    await click('#add-shot');
    const emptyShot='.sequence-video .sequence-empty[data-drop-shot="3"]';
    await wait('!!'+query(emptyShot),'新建空分镜保留候选落点');
    const libraryDrop = selector=>'(() => {const source='+query(tile(files.red))+',target='+query(selector)+',dt=new DataTransfer();'
      +'for(const [el,type] of [[source,"dragstart"],[target,"dragover"],[target,"drop"],[source,"dragend"]])el.dispatchEvent(new DragEvent(type,{bubbles:true,cancelable:true,dataTransfer:dt}));})()';
    await read(libraryDrop(emptyShot));
    await wait(count(video)+'===4 && '+query(video+'[data-drop-shot="3"]')+'?.title.includes("红色")','从素材库拖入空分镜应落在该格');
    await undo();await wait('!!'+query(emptyShot),'撤销拖入应恢复空位');
    await undo();await wait('!'+query(emptyShot),'撤销新增分镜');
    await read(libraryDrop('.sequence-video [data-drop-shot="1"]'));
    await wait(count(video)+'===4 && '+query(tile(files.red)+' .material-used')+'.title.includes("1、2")','重复源文件用于两个分镜时应标出两个分镜号');
    const pickCount=openedPickers.length;
    const secondRow=slot+'[data-candidate-index="1"]';
    await actualClick(secondRow);
    const coords=await pointerPoint(secondRow);
    for(const type of ['mousePressed','mouseReleased']) {
      await send('dispatchMouseEvent',{type,...coords,button:'right',buttons:type==='mousePressed'?2:0,clickCount:1});
    }
    await wait('!!document.querySelector(".sequence-dialog[open]")','第二条视频轨空位仍可右键打开时间轴菜单');
    await pressKey('Escape',27);
    assert.equal(openedPickers.length,pickCount,'点选部分填充的候选行应保留系统文件框的关闭状态');
    await actualClick(tile(files.red));
    await pressDelete();
    await wait(count(video)+'===4 && !'+query(tile(files.red)), '从素材库移除后应保留两个分镜中的同源候选');
    assert.deepEqual(await fs.readFile(files.red), original, '删除库素材后原文件的每个字节都应保留');
    await undo();
    await wait(count(video)+'===4 && '+query(tile(files.red))+'?.dataset.used==="true"', '撤销应还原文件夹素材及其使用标记');
    await actualClick(tile(files.red));
    await pressDelete();
    await wait('!' + query(tile(files.red)), '再次移除在用素材');
    await click('#save-project');
    await wait(query('#notice') + '.textContent.includes("工程已保存")', '保存素材库移除状态');
    picks.push({title: '打开工程', files: [project]});
    await click('#open-project');
    await wait(query('#notice') + '.textContent.includes("已打开工程")', '重新载入磁盘工程');
    assert.equal(await read(count(video) + '===4 && !' + query(tile(files.red)) + ' && !!' + query(tile(files.green))), true,
      '重开后素材仍已移除，同源轨道片段均可恢复');
    assert.deepEqual(picks,[]);
    console.log('时间线删除、框选、文件夹同源标记和撤销通过。');
  } finally {
    win.webContents.debugger.detach();
    win.destroy();
  }
}

check().then(() => app.exit(0), (error) => { console.error(error); app.exit(1); });
