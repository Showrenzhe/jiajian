'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { app } = require('electron');
const { launchDesktop } = require('../src/desktop.cjs');
const { estimatedBytes } = require('../src/export-preflight.cjs');
const { inspectAsset } = require('../src/media.cjs');
const { saveProject } = require('../src/project-format.cjs');
const { clickVisible } = require('./desktop-input.cjs');
const { fixtures } = require('./fixtures.cjs');

app.disableHardwareAcceleration();

async function check() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jiajian-batch-list-'));
  app.setPath('userData', path.join(root, 'electron'));
  const files = await fixtures(root);
  const colors = ['red', 'green', 'blue', 'still'];
  const assets = new Map(await Promise.all(colors.map(async id =>
    [id, await inspectAsset(files[id], id === 'still' ? 'image' : 'video')])));
  const project = path.join(root, '五镜四色组合.sdworkbench');
  const shots = Array.from({length:5}, () => colors.map((id,i) => ({id,start:0,end:(i+1)/4})));
  await saveProject(project, {shots, count:1000, ratio:'16:9', resolution:720, fps:24, fit:'fit',
    priority:'picture', keepAudio:true, unordered:false, useOriginal:true, useMirrors:false, musicIds:[], musicVolume:40}, assets);
  const win = await launchDesktop({show:false, dataDirectory:path.join(root,'profile'), dialogs:{
    async showOpenDialog(_win, options) {
      assert.equal(options.title,'打开工程');
      return {canceled:false,filePaths:[project]};
    },
  }});
  const wc = win.webContents;
  wc.setBackgroundThrottling(false);
  wc.debugger.attach();
  const read = expression => wc.executeJavaScript(expression,true);
  const query = selector => 'document.querySelector('+JSON.stringify(selector)+')';
  const list = query('#preview-batch-list');
  const rows = '[...'+list+'.querySelectorAll(".batch-entry")]';
  const summary = query('#preview-batch-summary')+'.textContent';
  const click = selector => clickVisible(wc,selector);
  async function wait(condition, message, timeout=10000) {
    for(const until=Date.now()+timeout; Date.now()<until; ) {
      if(await read(condition)) return;
      await delay(35);
    }
    const state=await read('['+summary+',document.activeElement.outerHTML.slice(0,100),'+query('#notice')+'.textContent,'+list+'.scrollTop,'+list+'.scrollHeight,'+rows+'.map(row=>row.dataset.index)]');
    throw Error(message+' '+JSON.stringify(state));
  }
  async function key(key,code,modifiers=0) {
    for(const type of ['rawKeyDown','keyUp']) {
      await wc.debugger.sendCommand('Input.dispatchKeyEvent',{type,key,code:key==='a'?'KeyA':key,
        modifiers,windowsVirtualKeyCode:code,nativeVirtualKeyCode:code});
    }
  }
  async function select(id,position) {
    await click(id);
    await key('Home',36);
    for(let i=0;i<position;i++) await key('ArrowDown',40);
    await key('Enter',13);
    await wait(query(id)+'.selectedIndex==='+position,'选择 '+id+' 第 '+(position+1)+' 项');
  }
  async function search(words) {
    await click('#batch-search');
    await key('a',65,2);
    if(words) await wc.insertText(words);
    else await key('Backspace',8);
  }
  const totals = (selected,visible) => wait(summary+'==='+JSON.stringify('已选 '+selected+' / 1000 条 · 当前显示 '+visible+' 条'),'勾选和显示数量');
  const indexOfFocus='Number(document.activeElement.closest(".batch-entry")?.dataset.index)';
  async function focusAt(index,control) {
    await wait(indexOfFocus+'==='+index+' && document.activeElement.matches('+JSON.stringify(control)+')','列表焦点 '+index+' '+control);
    assert.ok(await read('(()=>{const e=document.activeElement,r=e.getBoundingClientRect();return e.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2));})()'),
      '键盘焦点可见 '+(index+1)+' '+control);
  }
  async function wheel(deltaY) {
    const pointer=await read(`(() => {
      const l=${list}, r=l.getBoundingClientRect(), pane=l.closest("#preview-batch").getBoundingClientRect();
      const x=r.left+r.width/2, y=(Math.max(r.top,pane.top)+Math.min(r.bottom,pane.bottom,innerHeight))/2;
      return l.contains(document.elementFromPoint(x,y)) && {x,y};
    })()`);
    assert.ok(pointer,'可从列表可见部分滚动');
    await wc.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseWheel',...pointer,deltaX:0,deltaY});
  }
  async function scrollWindow(fraction) {
    if(fraction===1) await wheel(await read(list+'.scrollHeight'));
    else await read(list+'.scrollTop=('+list+'.scrollHeight-'+list+'.clientHeight)*'+fraction);
    const wanted=Math.round(fraction*999);
    await wait(rows+'.some(row=>Number(row.dataset.index)==='+wanted+')','滚动到结果 '+(wanted+1));
    const info=await read(rows+'.map(row=>({id:Number(row.dataset.index),pos:row.ariaPosInSet,total:row.ariaSetSize,checked:row.querySelector(".batch-select").checked}))');
    assert.ok(info.length>0 && info.length<25,'只挂载视口和缓冲行 '+info.length);
    assert.ok(info.every((r,i)=>Number(r.pos)===r.id+1 && Number(r.total)===1000 && (!i || r.id===info[i-1].id+1)));
    return info;
  }
  async function view(theme,width,height) {
    win.setContentSize(width,height);
    await wc.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:theme}]});
    await wait('innerWidth==='+width+' && innerHeight==='+height+' && document.documentElement.dataset.theme==='+JSON.stringify(theme),'切换列表外观');
    await read('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(()=>requestAnimationFrame(done))))');
  }
  async function capture(name) {
    const directory=process.env.JIAJIAN_BATCH_EVIDENCE;
    if(!directory) return;
    await read('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))');
    const frame=await wc.capturePage();
    assert.deepEqual([frame.getSize().width,frame.getSize().height],win.getContentSize());
    await fs.mkdir(directory,{recursive:true});
    await fs.writeFile(path.join(directory,name+'.jpg'),frame.toJPEG(88));
  }
  try {
    await view('light',1420,960);
    await click('#home-open-project');
    await wait(query('#count')+'.value==="1000" && !'+query('#prepare-preview')+'.disabled','打开 1,000 条组合工程');
    await click('#prepare-preview');
    await wait(query('#preview-batch')+'.checkVisibility() && '+summary+'.includes(" / 1000 条")','批量预览生成完成');
    assert.equal(await read(query('#batch-reuse-filter')+'.value'),'all');
    await wait(summary+'.endsWith("当前显示 1000 条")','生成后直接展示全部组合');
    await totals(1000,1000);
    const first=await scrollWindow(0);
    assert.ok(first[0].id===0 && first.every(row=>row.checked));
    await capture('light-first-window');
    await click('#clear-preview-selection');
    await key('Tab',9);
    await wait('document.activeElement==='+list,'从清空按钮 Tab 进入列表');
    await key('ArrowDown',40); await focusAt(0,'.batch-select');
    for(let i=1;i<first.length+2;i++) {
      await key('ArrowDown',40); await focusAt(i,'.batch-select');
    }
    await key('ArrowUp',38); await focusAt(first.length,'.batch-select');
    await key(' ',32); await totals(1,1000);
    const marked=first.length;
    const beforeWheel=await read(list+'.scrollTop');
    await wheel(432);
    await wait(list+'.scrollTop>'+beforeWheel+'+100','真实滚轮驱动已挂载窗口');
    await view('dark',1420,960);
    const mid=await scrollWindow(.5);
    assert.ok(mid[0].id>450 && mid.at(-1).id<550 && mid.every(row=>!row.checked));
    await read(list+'.focus()');
    await key('ArrowDown',40);
    const middleIndex=await read(indexOfFocus);
    assert.ok(middleIndex>=mid[0].id && middleIndex<=mid.at(-1).id);
    await key('Tab',9); await focusAt(middleIndex,'.preview-composition');
    await key('ArrowDown',40); await focusAt(middleIndex+1,'.preview-composition');
    await capture('dark-middle-window');
    await view('light',1366,768);
    assert.equal((await scrollWindow(1)).at(-1).id,999);
    const last='.batch-entry[data-index="999"]';
    await click(last+' .batch-select'); await totals(2,1000);
    await key('ArrowDown',40); await focusAt(999,'.batch-select');
    const durationText=await read(query(last+' .batch-duration')+'.textContent');
    const match=/^([\d.]+) 秒 · 约 ([\d.]+) MiB$/.exec(durationText);
    assert.ok(match,durationText);
    const duration=Number(match[1]);
    assert.equal(match[2],(estimatedBytes({kind:'montage',size:[1280,720],fps:24,duration})/1048576).toFixed(1));
    await click(last+' .preview-composition');
    await wait(query('#preview-name')+'.textContent==="混剪预览 1000" && '+query('#preview')+'.readyState>=2','末行生成正确成片并解码',30000);
    assert.ok(Math.abs(await read(query('#preview')+'.duration')-duration)<.1,'行内预览成片时长应与该行一致');
    await capture('compact-last-preview');
    await search('第 99'); await totals(2,11);
    await key('a',65,2);
    assert.equal(await read(query('#batch-search')+'.selectionEnd-'+query('#batch-search')+'.selectionStart'),4,'搜索框保留原生全选文字');
    await totals(2,11);
    await read(list+'.focus()'); await key('a',65,2); await totals(11,11);
    assert.ok(await read(rows+'.every(r=>r.querySelector(".batch-select").checked)'));
    await key('ArrowDown',40); await focusAt(98,'.batch-select');
    await key('ArrowDown',40); await focusAt(989,'.batch-select');
    await search(''); await totals(11,1000);
    await click('#select-all-previews'); await totals(1000,1000);
    await search('第 99');
    await click('#invert-preview-selection'); await totals(989,11);
    assert.ok(await read(rows+'.every(r=>!r.querySelector(".batch-select").checked)'));
    await search('第 1000 条'); await totals(989,1);
    assert.ok(await read(query(last+' .batch-select')+'.checked'),'反选保留筛选外的末行');
    await search('第 '+(marked+1)+' 条'); await totals(989,1);
    await search('查无此素材'); await totals(989,0);
    assert.equal(await read(rows+'.length'),0);
    await read(list+'.focus()'); await key('a',65,2); await key('ArrowDown',40);
    await totals(989,0);
    await search('红色原声'); await wait(rows+'.length>0 && '+rows+'.every(r=>r.querySelector(".batch-clips").textContent.includes("红色原声"))','按素材名称搜索');
    await search(''); await totals(989,1000);
    await select('#batch-reuse-filter',4);
    await wait(rows+'.length>0 && '+rows+'.every(r=>r.querySelector(".batch-reuse").textContent==="素材重复估值 0%")','按无重复画面筛选');
    await select('#batch-reuse-filter',5); await totals(989,1000);
    await select('#batch-sort',1);
    const durations=()=>read(rows+'.map(r=>parseFloat(r.querySelector(".batch-duration").textContent))');
    const shortest=await durations();
    assert.deepEqual(shortest,[...shortest].sort((a,b)=>a-b));
    const sortedIds=await read(rows+'.map(r=>Number(r.dataset.index))');
    await read(list+'.focus()'); await key('ArrowDown',40); await focusAt(sortedIds[0],'.batch-select');
    await key('ArrowDown',40); await focusAt(sortedIds[1],'.batch-select');
    await read(list+'.scrollTop='+list+'.scrollHeight');
    await wait(rows+'.at(-1)?.ariaPosInSet==="1000"','时长排序末页');
    const longest=await durations();
    assert.deepEqual(longest,[...longest].sort((a,b)=>a-b));
    assert.ok(shortest[0]<longest.at(-1),'时长排序首尾必须有不同的结果');
    await select('#batch-sort',2);
    const percents=await read(rows+'.map(r=>Number(r.querySelector(".batch-reuse").textContent.match(/(\\d+)%/)[1]))');
    assert.deepEqual(percents,[...percents].sort((a,b)=>a-b));
    console.log('1,000 条批量预览通过。首、中、末窗口、键盘跨窗、筛选排序、全选反选和第 1000 条成片均已验证。');
  } finally {win.destroy();}
}

check().then(()=>app.exit(0),error=>{console.error(error);app.exit(1);});
