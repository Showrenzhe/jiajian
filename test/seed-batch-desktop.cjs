'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {setTimeout: delay} = require('node:timers/promises');
const {app,nativeTheme} = require('electron');
const {launchDesktop} = require('../src/desktop.cjs');
const {inspectAsset} = require('../src/media.cjs');
const {saveProject,loadProject} = require('../src/project-format.cjs');
const {fixtures,ffmpeg} = require('./fixtures.cjs');
const {clickVisible} = require('./desktop-input.cjs');
app.commandLine.appendSwitch('force-device-scale-factor','1');

async function run(root) {
  app.setPath('userData',path.join(root,'electron'));
  const files = await fixtures(root);
  const catalog = new Map(await Promise.all(['red','blue','green','music','otherMusic'].map(async id =>
    [id,await inspectAsset(files[id],id.toLowerCase().includes('music')?'audio':'video')])));
  const project = path.join(root,'两镜两曲.jiajian'), saved = path.join(root,'已换种子.jiajian');
  const output = path.join(root,'exports');
  await fs.mkdir(output);
  const shots = [['red','blue'],['blue','green']].map(row=>row.map(id=>({id,start:0,end:0.5})));
  const seed = '00001111222233334444555566667777';
  await saveProject(project,{
    shots,count:4,ratio:'16:9',resolution:720,fps:24,fit:'fit',priority:'picture',keepAudio:false,
    unordered:false,useOriginal:true,useMirrors:false,musicIds:['music','otherMusic'],musicVolume:30,
    batchRandom:{algorithm:1,seed,minDifferentShots:0,avoidSameOpening:false},
    subprojects:{active:null,main:[],projects:[{id:'variant',name:'副本',shots:[],count:2}]},
  },catalog);
  const longFile=path.join(root,'超速.mp4');
  await ffmpeg(['-f','lavfi','-i','testsrc2=s=160x90:r=24:d=3','-c:v','libx264','-threads','1',longFile]);
  catalog.set('long',await inspectAsset(longFile,'video'));
  const speedProject=path.join(root,'换批中止.jiajian');
  await saveProject(speedProject,{
    shots:Array.from({length:2},()=>[{id:'long',start:0,end:3,speedMode:'auto'}]),
    count:2,ratio:'16:9',resolution:720,fps:24,fit:'fit',priority:'voice',narrationMode:'segmented',voiceAlignment:'fill',
    segmentNarrationIds:[['music'],['otherMusic']],keepAudio:false,unordered:false,useOriginal:true,useMirrors:true,
    musicIds:[],musicVolume:30,batchRandom:{algorithm:1,seed,minDifferentShots:0,avoidSameOpening:false},
  },catalog);
  const scoped=path.join(root,'仅子工程有素材.jiajian'), scopedSaved=path.join(root,'保存子工程批次.jiajian');
  await saveProject(scoped,{
    shots:[[]],count:1,ratio:'16:9',resolution:720,fps:24,fit:'fit',priority:'picture',keepAudio:false,
    unordered:false,useOriginal:true,useMirrors:false,musicIds:['music','otherMusic'],musicVolume:30,
    batchRandom:{algorithm:1,seed,minDifferentShots:0,avoidSameOpening:false},
    subprojects:{active:null,main:[],projects:[
      {id:'available',name:'有画面',shots:[{index:0,clips:[shots[0][0]]}],count:2},
      {id:'empty',name:'暂无素材',shots:[]},
    ]},
  },catalog);
  const open=[project,saved,scoped,scopedSaved,scopedSaved,speedProject];
  const saves=[saved,scopedSaved];
  const win=await launchDesktop({show:false,dataDirectory:path.join(root,'profile'),dialogs:{
    async showOpenDialog(_win,{title}) {
      if (title==='选择导出目录') return {canceled:false,filePaths:[output]};
      assert.equal(title,'打开工程'); return {canceled:false,filePaths:[open.shift()]};
    },
    async showSaveDialog() {return {canceled:false,filePath:saves.shift()};},
  }});
  win.setContentSize(1366,768);
  win.show(); win.focus();
  const wc=win.webContents;
  wc.setBackgroundThrottling(false);
  wc.debugger.attach();
  const read=expr=>wc.executeJavaScript(expr,true);
  const q=id=>'document.querySelector('+JSON.stringify(id)+')';
  async function wait(expr) {
    for(const until=Date.now()+25000;Date.now()<until;) {
      if(await read(expr)) return;
      await delay(40);
    }
    throw Error('等待超时 '+expr+' / '+await read(q('#notice')+'.textContent'));
  }
  async function click(selector) {
    for(const until=Date.now()+5000;;) {
      try {await clickVisible(wc,selector); return;}
      catch(error) {if(Date.now()>=until || !error.message.includes('无法点击可见的控件')) throw error;}
      await delay(50);
    }
  }
  async function key(key,code,number,modifiers=0) {
    for(const type of ['rawKeyDown','keyUp']) await wc.debugger.sendCommand('Input.dispatchKeyEvent',{
      type,key,code,windowsVirtualKeyCode:number,modifiers,
    });
  }
  const batch = () => read('previewBatch.entries.map(({clips,music,wholeTrack})=>({clips,music,wholeTrack}))');
  async function generate(selector) {
    const old=await read('previewBatch?.id ?? null');
    await click(selector);
    await wait('!operation && previewBatch?.id && previewBatch.id!=='+JSON.stringify(old));
  }
  await click('#home-open-project');
  await wait(q('#inspector-tab-montage')+'?.checkVisibility()');
  if(await read(q('#editing-tour button')+'?.checkVisibility()')) await click('#editing-tour button');
  await click('#inspector-tab-montage');
  assert.equal(await read(q('#batch-seed')+'.value'),seed);
  assert.match(await read(q('#combinations')+'.textContent'),/8 种/);
  assert.match(await read(q('#batch-coverage')+'.textContent'),/50%/);
  for(const theme of ['light','dark']) {
    nativeTheme.themeSource=theme;
    await wait('document.documentElement.dataset.theme==='+JSON.stringify(theme)+' && !document.documentElement.hasAttribute("data-theme-changing")');
    await read(q('#batch-random-settings')+'.scrollIntoView({block:"center",behavior:"instant"})');
    await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    await wait('[...document.querySelectorAll("#batch-seed,#batch-same-seed,#batch-new-seed")].every(e=>{const r=e.getBoundingClientRect();return e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));})');
    const rect=await read(q('#batch-new-seed')+'.getBoundingClientRect().toJSON()');
    assert.ok(rect.top>=0 && rect.bottom<=768 && rect.x>=0 && rect.right<=1366);
    assert.equal(await read('document.documentElement.scrollWidth'),1366);
    if(process.env.JIAJIAN_BATCH_SEED_EVIDENCE) {
      await fs.mkdir(process.env.JIAJIAN_BATCH_SEED_EVIDENCE,{recursive:true});
      await wc.debugger.sendCommand('Page.captureScreenshot',{format:'png',fromSurface:true});
      const image=await win.capturePage();
      assert.deepEqual(image.getSize(),{width:1366,height:768});
      await fs.writeFile(path.join(process.env.JIAJIAN_BATCH_SEED_EVIDENCE,'1366x768-'+theme+'.png'),image.toPNG());
    }
  }
  await generate('#batch-same-seed');
  const first=await batch();
  await generate('#batch-same-seed');
  assert.deepEqual(await batch(),first);
  await generate('#batch-new-seed');
  const nextSeed=await read(q('#batch-seed')+'.value');
  assert.match(nextSeed,/^[0-9a-f]{32}$/);
  assert.notEqual(nextSeed,seed);
  const rerolled=await batch();
  await click('#save-project');
  await wait(q('#notice')+'.textContent.includes("工程已保存")');
  assert.equal((await loadProject(saved)).config.batchRandom.seed,nextSeed);
  await click('#open-project');
  await wait(q('#notice')+'.textContent.includes("已打开工程") && !operation');
  await click('#inspector-tab-montage');
  await generate('#batch-same-seed');
  assert.deepEqual(await batch(),rerolled);
  await click('#timeline-tracks-tab');
  await click('.sequence-video [data-move-candidate]');
  await click('#track-more');
  await click('#clip-actions');
  await click('#candidate-batch-preference');
  await key('Home','Home',36);
  await key('ArrowDown','ArrowDown',40);
  await key('Enter','Enter',13);
  await wait('montageConfig().shots[0][0].batchPreference==="required"');
  await click('.sequence-dialog[open] header button');
  await click('#inspector-tab-montage');
  assert.match(await read(q('#combinations')+'.textContent'),/4 种/);
  assert.match(await read(q('#batch-coverage')+'.textContent'),/接近组合上限/);
  await click('label:has(#batch-avoid-opening)');
  await click('#start-export');
  await wait('!operation && previewBatch?.batchSummary?.actual===1');
  assert.match(await read(q('#batch-generation-summary')+'.textContent'),/1 \/ 4 条/);
  await click('#clear-preview-selection');
  assert.ok(await read(q('#start-export')+'.disabled'));
  await click('.batch-entry .batch-select');
  await click('#start-export');
  await wait('!operation && '+q('#output-status')+'.textContent.includes("已保存 1 条")');
  assert.equal((await fs.readdir(output)).filter(file=>file.endsWith('.mp4')).length,1);
  await click('#subproject-batch');
  await generate('#subproject-batch-confirm');
  assert.equal(await read('previewBatch.batchSummary.subprojects[0].id'),'variant');
  await generate('#batch-new-seed');
  assert.equal(await read('previewBatch.entries[0].subproject.name'),'副本');
  await generate('#prepare-preview');
  assert.ok(await read('!montageConfig().batchSubprojectScope && !previewBatch.scope'));
  await click('#open-project');
  await wait('!operation && '+q('#project-status')+'.textContent.includes("仅子工程有素材")');
  await click('#inspector-tab-montage');
  assert.ok(await read(q('#prepare-preview')+'.disabled'));
  await click('#subproject-batch');
  await generate('#subproject-batch-confirm');
  const scopedEntries=await batch();
  assert.equal(scopedEntries.length,2);
  assert.equal(new Set(scopedEntries.map(entry=>entry.music)).size,2);
  assert.equal(await read('previewBatch.selected.size'),2);
  assert.equal(await read('previewBatch.filtered.length'),2);
  await click('#save-project');
  await wait('!operation && '+q('#notice')+'.textContent.includes("工程已保存")');
  const scopedConfig=(await loadProject(scopedSaved)).config;
  assert.equal(scopedConfig.batchSubprojectScope,true);
  assert.deepEqual(scopedConfig.subprojects.projects.map(project=>project.participates),[true,false]);
  for (const button of ['#batch-same-seed','#batch-new-seed']) {
    await click('#open-project');
    await wait('!operation && !previewBatch && '+q('#project-status')+'.textContent.includes("保存子工程批次")');
    await click('#inspector-tab-montage');
    assert.ok(await read(q('#prepare-preview')+'.disabled && !'+q(button)+'.disabled'));
    await generate(button);
    assert.deepEqual(await read('previewBatch.scope'),[{id:'available',count:2}]);
    if(button==='#batch-same-seed') assert.deepEqual(await batch(),scopedEntries);
    else assert.notEqual(await read(q('#batch-seed')+'.value'),seed);
  }
  await click('#open-project');
  await wait('!operation && '+q('#project-status')+'.textContent.includes("换批中止")');
  await click('#inspector-tab-montage');
  async function acceptSpeedChoices() {
    const dialog=q('#speed-overflow-dialog');
    for (let i=0;i<6;i++) {
      await wait('!operation || '+dialog+'.open');
      if (!await read('Boolean(operation)')) return;
      await click('[data-speed-choice="continue"]');
    }
    throw Error('超限处理未结束');
  }
  await click('#batch-same-seed');
  await wait(q('#speed-overflow-dialog')+'.open');
  await acceptSpeedChoices();
  assert.equal(await read(q('#batch-reuse-filter')+'.value'),'all');
  await click('#clear-preview-selection');
  await click('.batch-entry[data-index="1"] .batch-select');
  const snapshot=()=>read('({id:previewBatch.id,seed:montageConfig().batchRandom.seed,entries:previewBatch.entries,selected:[...previewBatch.selected]})');
  const before=await snapshot();
  assert.deepEqual(before.selected,[1]);
  await click('#batch-new-seed');
  await wait(q('#speed-overflow-dialog')+'.open');
  await click('[data-speed-cancel]');
  await wait('!operation && '+q('#notice')+'.textContent.includes("取消")');
  assert.deepEqual(await snapshot(),before);
  // Simulate an offline recording while preparing the next batch. Put it
  // back before exporting from the previous, already-confirmed plan.
  const offline=files.music+'.offline';
  await fs.rename(files.music,offline);
  try {
    await click('#batch-new-seed');
    await acceptSpeedChoices();
    await wait('!operation && '+q('#notice')+'.textContent.includes("无法检查口播")');
    assert.deepEqual(await snapshot(),before);
  } finally {await fs.rename(offline,files.music);}
  await click('#start-export');
  await wait('!operation && '+q('#output-status')+'.textContent.includes("已保存 1 条")');
  assert.equal((await fs.readdir(output)).filter(file=>file.endsWith('.mp4')).length,2);
  win.destroy();
}
async function main() {
  const parent=await fs.realpath(os.tmpdir());
  const managed=process.env.JIAJIAN_BATCH_SEED_TEST_ROOT;
  const root=managed || await fs.mkdtemp(path.join(parent,'jiajian-seed-batch-'));
  try {await run(root);}
  finally {
    if (!managed) {
      const actual=await fs.realpath(root);
      assert.equal(path.dirname(actual),parent);
      assert.ok(path.basename(actual).startsWith('jiajian-seed-batch-'));
      await fs.rm(actual,{recursive:true,force:true,maxRetries:2,retryDelay:100}).catch(error=>{
        if(!['EBUSY','EPERM','ENOTEMPTY'].includes(error.code)) throw error;
      });
    }
  }
}
main().then(()=>app.exit(0),error=>{console.error(error);app.exit(1);});
