'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { app } = require('electron');
const { launchDesktop } = require('../src/desktop.cjs');
const { ffmpeg } = require('./fixtures.cjs');
const { clickVisible } = require('./desktop-input.cjs');

app.disableHardwareAcceleration();

async function run() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jiajian-speed-ui-'));
  app.setPath('userData', path.join(root,'electron'));
  const folder = process.env.JIAJIAN_TEST_SCREENSHOT ? path.dirname(process.env.JIAJIAN_TEST_SCREENSHOT)
    : path.resolve('run-data/test-artifacts/speed-boundaries');
  await fs.mkdir(folder,{recursive:true});

  const video = path.join(root,'pattern.mp4'), voice = path.join(root,'voice.wav');
  await Promise.all([
    ffmpeg(['-f','lavfi','-i','testsrc2=s=160x90:r=24:d=8','-c:v','libx264','-threads','1',video]),
    ffmpeg(['-f','lavfi','-i','sine=frequency=500:duration=1',voice]),
  ]);
  const makeProject = (end,speed) => ({
    format:'sdworkbench',version:2, config:{
      shots:[[{id:'source',start:0,end,speed}]], ratio:'16:9',resolution:720,fps:24,fit:'fit',keepAudio:false,
      musicIds:[],musicVolume:50,count:1,unordered:false,useOriginal:true,useMirrors:false,priority:'voice',
      narrationMode:'segmented',segmentNarrationIds:[['voice']],voiceAlignment:'fill',
    }, assets:[{id:'source',kind:'video',path:video},{id:'voice',kind:'audio',path:voice}],
  });
  const high = path.join(root,'高倍速.jiajian'), low = path.join(root,'低倍速.jiajian');
  const original = Buffer.from(JSON.stringify(makeProject(8,6),null,2)+'\r\n');
  await fs.writeFile(high,original);
  await fs.writeFile(low,JSON.stringify(makeProject(.125,1)));
  const live=path.join(root,'实时自动对齐.jiajian'), exports=path.join(root,'exports');
  const directExports=path.join(root,'direct');
  await Promise.all([fs.mkdir(exports),fs.mkdir(directExports)]);
  let destination=directExports, outputSelections=0;
  const fresh=makeProject(8,1);
  fresh.version=3;
  fresh.config.shots[0][0].speedMode='auto';
  await fs.writeFile(live,JSON.stringify(fresh));
  const card=path.join(root,'卡片裁剪.jiajian');
  const sourceRanges=[{start:0,end:3},{start:4,end:8}];
  const aligned=structuredClone(fresh);
  Object.assign(aligned.config.shots[0][0],{ranges:sourceRanges,speed:7,matchedDuration:1});
  await fs.writeFile(card,JSON.stringify(aligned));
  const opens = [high,high,low,live,card,card], saves = [high,high,high,low,card,card];
  const win = await launchDesktop({show:false,dataDirectory:path.join(root,'profile'),dialogs:{
    async showOpenDialog(_win,options) {
      if(options.title==='选择导出目录') {outputSelections++;return {canceled:false,filePaths:[destination]};}
      assert.equal(options.title,'打开工程'); assert.ok(opens.length);
      return {canceled:false,filePaths:[opens.shift()]};
    },
    async showSaveDialog(_win,options) {
      assert.equal(options.title,'保存工程'); assert.ok(saves.length);
      return {canceled:false,filePath:saves.shift()};
    },
    async showMessageBox(_win,options) {
      assert.equal(options.title,'替换工程文件'); return {response:1};
    },
  }});
  win.setContentSize(1560,960);
  const wc = win.webContents;
  wc.setBackgroundThrottling(false);
  wc.debugger.attach();
  const read = expr => wc.executeJavaScript(expr,true);
  const el = selector => 'document.querySelector(' + JSON.stringify(selector) + ')';
  const click = selector => clickVisible(wc,selector);
  const shot = '.sequence-video [data-drop-shot="0"][data-candidate-index="0"]';
  async function wait(expr,label) {
    for (const stop=Date.now()+12000; Date.now()<stop;) {
      if (await read(expr)) return;
      await delay(30);
    }
    throw Error(label+' / '+await read(el('#notice')+'.textContent'));
  }
  async function escape() {
    for (const type of ['rawKeyDown','keyUp']) {
      await wc.debugger.sendCommand('Input.dispatchKeyEvent',{type,key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    }
  }
  async function field(selector,value) {
    await click(selector);
    for (const type of ['rawKeyDown','keyUp']) {
      await wc.debugger.sendCommand('Input.dispatchKeyEvent',{type,key:'a',code:'KeyA',windowsVirtualKeyCode:65,modifiers:2});
    }
    await wc.debugger.sendCommand('Input.insertText',{text:String(value)});
    assert.equal(await read(el(selector)+'.valueAsNumber'),value);
  }
  async function theme(scheme) {
    await wc.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[
      {name:'prefers-color-scheme',value:scheme},{name:'prefers-reduced-motion',value:'reduce'},
    ]});
    await wait('document.documentElement.dataset.theme==='+JSON.stringify(scheme),'应用主题');
  }
  async function capture(name) {
    await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    const image = await wc.capturePage();
    assert.ok(!image.isEmpty());
    await fs.writeFile(path.join(folder,'speed-'+name+'.png'),image.toPNG());
  }
  async function open(selector,file) {
    await click(selector);
    await wait(el('#notice')+'.textContent.includes('+JSON.stringify('已打开工程：' + path.basename(file,path.extname(file)))+') && !'+el('#open-project')+'.disabled','打开 '+file);
    await click(shot);
    await wait(el('#track-speed-panel')+'.checkVisibility()','显示片段倍速属性');
  }
  async function save(file,expected) {
    await click('#save-project');
    await wait(el('#notice')+'.textContent.includes("工程已保存") && !'+el('#save-project')+'.disabled','保存工程');
    const doc = JSON.parse(await fs.readFile(file));
    assert.equal(doc.version,3);
    const clip = doc.config.shots[0][0];
    for (const [key,value] of Object.entries(expected)) assert.equal(clip[key],value,key);
  }
  const dialog = el('#speed-overflow-dialog');
  const choices = () => read('[...document.querySelectorAll("#speed-overflow-dialog [data-speed-choice]")].map(b=>b.dataset.speedChoice)');
  try {
    await theme('light');
    await open('#home-open-project',high);
    assert.match(await read(el('#track-speed-source')+'.textContent'),/6/);
    await click('#app-settings');
    await wait(el('#auto-speed-min')+'?.checkVisibility()','显示本机范围设置');
    assert.deepEqual(await read('['+el('#auto-speed-min')+'.valueAsNumber,'+el('#auto-speed-max')+'.valueAsNumber]'),[.25,4]);
    await field('#auto-speed-min',.3);
    await field('#auto-speed-max',3);
    await click('#auto-speed-save');
    await wait(el('#auto-speed-settings [role=status]')+'.textContent.includes("已保存")','本机范围保存成功');
    await capture('01-light-settings');
    await escape();
    await wait('!'+el('#cloud-settings-dialog')+'.open','关闭设置');
    assert.equal(await read(el('#track-speed')+'.valueAsNumber'),6,'改范围应保留旧 6×');
    assert.deepEqual(await fs.readFile(high),original);

    await theme('dark');
    await click('#track-speed-auto');
    await wait(dialog+'.open','超过上限时打开处理选项');
    assert.deepEqual(await choices(),['trim-start','trim-end','continue']);
    assert.match(await read(el('#speed-overflow-detail')+'.textContent'),/×8/);
    await capture('02-dark-upper');
    await escape();
    await wait('!'+dialog+'.open && document.activeElement.id==="track-speed-auto"','Esc 后焦点返回自动对齐');
    assert.equal(await read(el('#track-speed')+'.valueAsNumber'),6);
    await click('#track-speed-auto');
    await wait(dialog+'.open','重新对齐可重选上限处理');
    assert.match(await read(el('[data-speed-choice="continue"]')+'.textContent'),/按上限继续.*×3/);
    await click('[data-speed-choice="continue"]');
    await save(high,{speed:3,speedMode:'auto',speedOverflow:'continue',start:0,end:8,ranges:undefined});
    await wait(el('#track-playhead')+'.max==="1"','选中片段的独立预览使用一秒窗口');
    await read(el('#preview')+'.play()');
    await wait(el('#preview')+'.paused && '+el('#preview')+'.currentTime>=2.9','原片单独预览在目标时长停下');
    assert.ok((await read(el('#preview')+'.currentTime'))<=3.001);
    await click('#track-speed-auto');
    await click('[data-speed-choice="trim-end"]');
    await wait(el('#track-speed')+'.valueAsNumber===3','保留片尾并按上限播放');
    assert.match(await read(el(shot+' .sequence-speed-badge[data-extreme]')+'.textContent'),/⚠.*3/);
    await save(high,{speed:3,speedMode:'auto',speedOverflow:'trim-end'});
    const tail=JSON.parse(await fs.readFile(high)).config.shots[0][0].ranges;
    assert.deepEqual(tail,[{start:5,end:8}]);
    assert.deepEqual(await fs.readFile(path.join(root,'高倍速.pre-v3.jiajian')),original);

    await field('#track-speed',1);
    await click('#track-speed-manual');
    await wait(el('#track-speed-source')+'.textContent.includes("手动")','手动 1× 已锁定');
    await click('#match-all-voice-duration');
    await wait(el('#notice')+'.textContent.includes("已匹配 0 条候选")','批量匹配跳过手动片段');
    await wait('!'+dialog+'.open && '+el('#track-speed-source')+'.textContent.includes("手动")','批量匹配保留手动锁定');
    await save(high,{speed:1,speedMode:'manual',speedOverflow:undefined});
    assert.deepEqual(await fs.readFile(path.join(root,'高倍速.pre-v3.jiajian')),original);
    await open('#open-project',high);
    assert.match(await read(el('#track-speed-source')+'.textContent'),/手动.*×1/);

    win.setContentSize(1366,768);
    await theme('light');
    await open('#open-project',low);
    await click('#track-speed-auto');
    await wait(dialog+'.open','低于下限时打开处理选项');
    assert.deepEqual(await choices(),['loop','hold','group']);
    assert.ok(await read(el('[data-speed-choice="group"]')+'.disabled'),'没有同组候选时不可补片');
    const viewport = await read('[innerWidth,innerHeight]');
    assert.deepEqual(viewport,[1366,768]);
    await capture('03-compact-lower');
    await click('[data-speed-cancel]');
    await wait('!'+dialog+'.open && document.activeElement.id==="track-speed-auto"','取消后焦点返回自动对齐');
    await click('#track-speed-auto');
    await click('[data-speed-choice="hold"]');
    await wait(el('#track-speed')+'.valueAsNumber===0.3','按下限播放并定格');
    await save(low,{speed:.3,speedMode:'auto',speedOverflow:'hold'});
    await open('#open-project',live);
    await click('#timeline-play');
    await wait(dialog+'.open','草稿播放前询问超限处理');
    await escape();
    await wait('!'+dialog+'.open && '+el('#timeline-play')+'.ariaPressed==="false"','取消后保持暂停');
    await click('#timeline-play');
    await click('[data-speed-choice="continue"]');
    await wait(el('#timeline-play')+'.ariaPressed==="true"','确认后播放草稿');
    await click('#timeline-play');
    await wait(el('#timeline-play')+'.ariaPressed==="false"','暂停草稿');
    await click('#start-export');
    await wait(dialog+'.open','直接导出前询问超限处理');
    await escape();
    await wait('!'+dialog+'.open && !'+el('#start-export')+'.disabled','取消导出后返回剪辑台');
    assert.equal(outputSelections,0,'取消超限处理时不应打开目录选择');
    await click('#start-export');
    await click('[data-speed-choice="continue"]');
    await wait(el('#output-status')+'.textContent.includes("已保存 1 条")','确认上限后直接导出');
    assert.equal((await fs.readdir(directExports)).filter(name=>name.endsWith('.mp4')).length,1);
    destination=exports;
    await click('#prepare-preview');
    await wait(dialog+'.open','生成组合前询问超限处理');
    await click('[data-speed-choice="continue"]');
    await wait(el('.preview-composition')+'?.checkVisibility()','生成已确认的预览');
    await click('#app-settings');
    await field('#auto-speed-max',2);
    await click('#auto-speed-save');
    await click('#cloud-settings-cancel');
    await click('.preview-composition');
    await wait(el('#preview-name')+'.textContent.includes("混剪预览") && '+el('#preview')+'.readyState>=2','本机范围变化后播放已确认组合');
    await click('#start-export');
    await wait(el('#output-status')+'.textContent.includes("已保存 1 条")','导出已确认组合');
    assert.equal((await fs.readdir(exports)).filter(name=>name.endsWith('.mp4')).length,1);
    await open('#open-project',card);
    const view=el('#timeline-view');
    await read(view+'.value="cards"; '+view+'.dispatchEvent(new Event("change",{bubbles:true}))');
    const row='.shot[data-shot-index="0"]', endInput=row+' .trim-fields .end';
    await click(row+' .shot-toggle');
    await click(row+' .clip-toggle');
    async function trimCardEnd() {
      await field(endInput,6);
      for(const type of ['rawKeyDown','keyUp']) {
        await wc.debugger.sendCommand('Input.dispatchKeyEvent',{type,key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
      }
      await wait(dialog+'.open','卡片改出点后询问超限处理');
    }
    await trimCardEnd();
    await escape();
    await wait('!'+dialog+'.open && '+el(endInput)+'.valueAsNumber===8','取消后卡片还原出点');
    await save(card,{start:0,end:8,speed:7});
    assert.deepEqual(JSON.parse(await fs.readFile(card)).config.shots[0][0].ranges,sourceRanges);
    await trimCardEnd();
    await click('[data-speed-choice="trim-end"]');
    await save(card,{start:0,end:6,speed:2,speedMode:'auto',speedOverflow:'trim-end'});
    const updated=JSON.parse(await fs.readFile(card)).config.shots[0][0];
    assert.deepEqual(updated.ranges,[{start:4,end:6}],'先应用新出点，再从剩余区间保留最末两秒');
    await read(view+'.value="time"; '+view+'.dispatchEvent(new Event("change",{bubbles:true}))');
    await open('#open-project',card);
    assert.match(await read(el('#track-speed-source')+'.textContent'),/×2.*保留片尾/);
    assert.deepEqual(opens,[]);
    assert.deepEqual(saves,[]);
    console.log('范围、超限处理、取消焦点、手动锁定、保存重开、同组可用性和升级备份均已验证。截图目录',folder);
  } finally {
    wc.debugger.detach();
    // The runner can capture the live failure before app.exit closes this window.
  }
}

run().then(()=>app.exit(0),error=>{console.error(error);app.exit(1);});
