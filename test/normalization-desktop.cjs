'use strict';

const assert = require('node:assert/strict');
const { mkdtempSync } = require('node:fs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { app } = require('electron');
const media = require('../src/media.cjs');
if (process.argv.includes('--without-tone-map')) {
  require('node:test').mock.method(media,'supportsHdrToneMap',async()=>false);
}
const { launchDesktop } = require('../src/desktop.cjs');
const { saveProject } = require('../src/project-format.cjs');
const { clickVisible } = require('./desktop-input.cjs');
const { ffmpeg, normalizationFixture } = require('./fixtures.cjs');

app.disableHardwareAcceleration();

async function check() {
  const root=mkdtempSync(path.join(os.tmpdir(),'jiajian-normalization-'));
  app.setPath('userData',path.join(root,'electron'));
  app.setPath('sessionData',path.join(root,'electron'));
  if (!(await ffmpeg(['-h','encoder=libx264'])).includes('yuv420p10le')) {
    console.log('跳过 HDR 桌面场景：当前 libx264 不支持 10 bit。');
    await fs.rm(root,{recursive:true,force:true});
    return;
  }
  const profile=path.join(root,'profile');
  const project=path.join(root,'色彩与帧率.jiajian');
  let savePath=project;
  const exports=path.join(root,'exports');
  await fs.mkdir(exports);
  const files=await Promise.all(['pq','vfr'].map(kind=>normalizationFixture(root,kind)));
  const win=await launchDesktop({show:false,dataDirectory:profile,dialogs:{
    async showOpenDialog(_win,options) {
      if(options.title==='选择导出目录') return {canceled:false,filePaths:[exports]};
      return {canceled:false,filePaths:options.title==='打开工程' ? [project] : files};
    },
    async showSaveDialog() { return {canceled:false,filePath:savePath}; },
  }});
  const wc=win.webContents;
  wc.setBackgroundThrottling(false);
  wc.debugger.attach();
  const read=expression=>wc.executeJavaScript(expression,true);
  const click=selector=>clickVisible(wc,selector);
  const query=selector=>'document.querySelector('+JSON.stringify(selector)+')';
  const player=query('#preview');
  const active=player+'.currentSrc';
  const pq='.material-tile[title="pq.mp4"]', vfr='.material-tile[title="vfr.mp4"]';
  async function wait(expression,description) {
    for(const end=Date.now()+15000;Date.now()<end;) {
      if(await read(expression)) return;
      await delay(40);
    }
    const details=await read('['+active+','+player+'.error?.message,'+query('#notice')+'.textContent,'+query('#material-message')+'.textContent]');
    throw Error(description+' '+JSON.stringify(details));
  }
  async function select(selector,value) {
    await read('(()=>{const s='+query(selector)+';s.value='+JSON.stringify(value)+';s.dispatchEvent(new Event("change",{bubbles:true}));})()');
  }
  async function view(theme,width,height) {
    win.setContentSize(width,height);
    await wc.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:theme}]});
    await wait('innerWidth==='+width+' && innerHeight==='+height+' && document.documentElement.dataset.theme==='+JSON.stringify(theme),'切换窗口外观');
    await read('Promise.all(document.getAnimations().filter(a=>a.effect.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))');
  }
  async function capture(name,rect) {
    const dir=process.env.JIAJIAN_NORMALIZATION_EVIDENCE;
    if(!dir) return;
    const frame=await wc.capturePage(rect);
    assert.deepEqual([frame.getSize().width,frame.getSize().height],rect ? [rect.width,rect.height] : win.getContentSize());
    await fs.mkdir(dir,{recursive:true});
    await fs.writeFile(path.join(dir,name+'.jpg'),frame.toJPEG(85));
  }
  async function proxyMedia(previous,video=player) {
    const src=video+'.currentSrc';
    await wait(src+'.includes("/track-proxy/") && '+video+'.readyState>=2 && '+src+'!=='+JSON.stringify(previous ?? ''),'监视器应解码新的代理');
    const url=await read(src);
    const filename=new URL(url).pathname.split('/').at(-1)+'.mp4';
    assert.match(filename,/^jj-[a-f0-9]{64}\.mp4$/);
    return {url,media:await media.inspectAsset(path.join(profile,'佳剪代理',filename),'video')};
  }
  async function hdrFrame(video=player) {
    const luma=await read(`(() => {
      const canvas=document.createElement('canvas');
      canvas.width=2;canvas.height=1;
      const context=canvas.getContext('2d');
      context.drawImage(${video},0,0,2,1);
      const pixels=context.getImageData(0,0,2,1).data;
      return [pixels[0],pixels[4]];
    })()`);
    assert.ok(luma[1]>luma[0]+30,'实际解码画面应包含明暗色块 '+luma);
    return luma;
  }
  try {
    await view('light',1420,960);
    await click('#home-create');
    await wait('!'+query('#material-import')+'.disabled','打开剪辑台');
    await click('#material-import');
    await click('#material-import-files');
    await wait(query(pq+' .material-hdr')+'?.textContent==="HDR" && '+query(vfr)+' && !'+query(vfr+' .material-hdr'),'只有 HDR 素材带有标记');
    const supported=(await read('workbench.hdrPolicy()')).toneMapAvailable;
    const first=await proxyMedia();
    assert.equal(first.media.hdr,supported ? undefined : 'smpte2084');
    const before=await hdrFrame();
    await wait(query('#material-hdr-notice')+'.hidden==='+supported,'素材库显示实际降级状态');
    await capture('light-hdr-material');
    await click('#app-settings');
    await click('#performance-settings summary');
    await wait('!'+query('#performance-options')+'.disabled','加载设置');
    assert.equal(await read(query('#performance-hdr-mode')+'.value'),'sdr');
    assert.equal(await read(query('#performance-hdr-note')+'.hidden'),supported);
    await view('dark',1420,960);
    await read(query('#performance-hdr-mode')+'.scrollIntoView({block:"nearest",behavior:"instant"}); new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))');
    // Show the actual controls without including the machine's cache path further down.
    const settingRect=await read('(()=>{const dialog='+query('#cloud-settings-dialog')+'.getBoundingClientRect(), field='+query('#performance-hdr-mode')+'.getBoundingClientRect();return {x:Math.round(dialog.x),y:Math.round(dialog.y),width:Math.round(dialog.width),height:Math.round(field.bottom-dialog.y+8)};})()');
    await capture('dark-hdr-setting',settingRect);
    await select('#performance-hdr-mode','preserve');
    await wait('!'+query('#performance-options')+'.disabled && '+query('#performance-status')+'.textContent.includes("已保存")','保存色彩设置');
    await click('#cloud-settings-cancel');
    const preserved=await proxyMedia(supported ? first.url : undefined);
    assert.equal(preserved.media.hdr,'smpte2084');
    const after=await hdrFrame();
    console.log('PQ 监视器两个色块的 Canvas 红通道读数，默认与保持',before,after);
    await view('light',1366,768);
    await capture('compact-hdr-material');
    await click(vfr);
    const thirty=await proxyMedia(preserved.url);
    assert.equal(thirty.media.fps,30);
    await select('#fps','25');
    const twentyFive=await proxyMedia(thirty.url);
    assert.equal(twentyFive.media.fps,25);
    const oldId=await read(query(pq)+'.dataset.materialId');
    await click('#save-project');
    await wait(query('#project-status')+'.textContent.includes("色彩与帧率")','保存工程');
    assert.equal(JSON.parse(await fs.readFile(project,'utf8')).config.hdrMode,undefined);
    await click('#open-project');
    await wait(query(pq)+'?.dataset.materialId && '+query(pq)+'.dataset.materialId!=='+JSON.stringify(oldId),'重开工程并重新登记素材');
    assert.equal(await read(query('#fps')+'.value'),'25');
    await click(vfr);
    const reopened=await proxyMedia();
    assert.equal(new URL(reopened.url).pathname.split('/').at(-1),new URL(twentyFive.url).pathname.split('/').at(-1));
    assert.equal(reopened.media.fps,25);
    assert.equal((await read('workbench.hdrPolicy()')).hdrMode,'preserve');
    await click('#prepare-preview');
    await wait(query('.preview-composition')+'?.checkVisibility()','生成重开工程的预览组合');
    await click('.preview-composition');
    await wait(query('#preview-name')+'.textContent.includes("混剪预览") && '+player+'.readyState>=2','解码组合预览');
    await click('#start-export');
    await wait(query('#output-status')+'.textContent.includes("已保存 1 条")','导出选中的组合');
    const outputs=(await fs.readdir(exports)).filter(name=>name.endsWith('.mp4'));
    assert.equal(outputs.length,1);
    const output=await media.inspectAsset(path.join(exports,outputs[0]),'video');
    assert.deepEqual([output.hdr,output.fps,output.duration],['smpte2084',25,2]);

    // Older editors wrote eight-bit reverse files with intact PQ tags. Reopen one through the normal project loader.
    const oldEdit=path.join(root,'旧倒放.mp4');
    await ffmpeg(['-i',files[0],'-vf','reverse,format=yuv420p','-c:v','libx264','-threads','1',oldEdit]);
    const legacy=await media.inspectAsset(oldEdit,'video');
    assert.deepEqual([legacy.hdr,legacy.pixelFormat],['smpte2084','yuv420p']);
    const config={shots:[[{id:'edited',start:0,end:1,sourceEdit:{id:'source',ranges:[{start:0,end:1,reverse:true}]}}]],
      ratio:'16:9',resolution:720,fps:25,fit:'fit',keepAudio:true,unordered:false,useOriginal:true,useMirrors:false,musicIds:[],musicVolume:50,count:1};
    await saveProject(project,config,new Map([['source',await media.inspectAsset(files[0],'video')],['edited',legacy]]),{overwrite:true});
    const oldBytes=await fs.readFile(oldEdit), originalBytes=await fs.readFile(files[0]);
    const blockedCache=path.join(profile,'source-edits');
    await fs.writeFile(blockedCache,'fixture',{flag:'wx'});
    await click('#open-project');
    await wait(query('#notice')+'.textContent.includes("沿用 8 位") && !'+query('#save-project')+'.disabled','缓存不可写时应仍能重开旧工程');
    savePath=path.join(root,'保留旧倒放.jiajian');
    await click('#save-project');
    await wait(query('#project-status')+'.textContent.includes("保留旧倒放")','回退工程可另存');
    const retained=JSON.parse(await fs.readFile(savePath,'utf8'));
    assert.equal(retained.assets.find(row=>row.id===retained.config.shots[0][0].id).path,oldEdit);
    await fs.unlink(blockedCache);
    await click('#open-project');
    await wait(query('#notice')+'.textContent.includes("已打开工程") && !'+query('#notice')+'.textContent.includes("沿用 8 位") && !'+query('#save-project')+'.disabled','重试并重建十位剪辑');
    savePath=path.join(root,'恢复倒放.jiajian');
    await click('#save-project');
    await wait(query('#project-status')+'.textContent.includes("恢复倒放")','保存已恢复工程');
    const recovered=JSON.parse(await fs.readFile(savePath,'utf8'));
    const cutRow=recovered.config.shots[0][0];
    const masterPath=recovered.assets.find(row=>row.id===cutRow.id).path;
    assert.notEqual(masterPath,oldEdit);
    const master=await media.inspectAsset(masterPath,'video');
    assert.deepEqual(await fs.readFile(oldEdit),oldBytes);
    assert.deepEqual(await fs.readFile(files[0]),originalBytes);
    assert.deepEqual([master.hdr,master.pixelFormat,master.colorPrimaries,master.colorSpace],['smpte2084','yuv420p10le','bt2020','bt2020nc']);
    const assetTile='.sequence-video [data-drop-shot="0"][data-move-candidate]';
    await read(query(assetTile)+'.dispatchEvent(new MouseEvent("dblclick",{bubbles:true}))');
    const cutVideo=query('#player-pane[data-cut-monitor] .video-cut-preview video');
    await wait(cutVideo+'?.readyState>=2','载入倒放剪辑窗口');
    const source=await proxyMedia(undefined,cutVideo);
    await click('#player-play');
    const reverse=await proxyMedia(source.url,cutVideo);
    assert.equal(reverse.media.hdr,'smpte2084');
    assert.deepEqual(await hdrFrame(cutVideo),after);
    await click('#app-settings');
    await click('#performance-settings summary');
    await wait('!'+query('#performance-options')+'.disabled','读取倒放预览的色彩设置');
    await select('#performance-hdr-mode','sdr');
    await wait('!'+query('#performance-options')+'.disabled && '+query('#performance-status')+'.textContent.includes("已保存")','切换倒放预览为 SDR');
    await click('#cloud-settings-cancel');
    const reverseSdr=await proxyMedia(supported ? reverse.url : undefined,cutVideo);
    assert.equal(reverseSdr.media.hdr,supported ? undefined : 'smpte2084');
    assert.deepEqual(await hdrFrame(cutVideo),before);
    assert.equal((await media.inspectAsset(masterPath,'video')).pixelFormat,'yuv420p10le');
    console.log('HDR 标识、色彩切换、VFR 活动预览、保存重开、组合播放与导出、旧倒放恢复与切换通过。');
  } finally {
    wc.debugger.detach();
    win.destroy();
    await fs.rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:150}).catch(()=>{});
  }
}

check().then(()=>app.exit(0),error=>{console.error(error);app.exit(1);});
