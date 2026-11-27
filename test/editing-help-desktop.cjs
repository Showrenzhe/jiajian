'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const {mkdtempSync} = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {setTimeout:delay} = require('node:timers/promises');
const {app,nativeImage} = require('electron');
const {launchDesktop} = require('../src/desktop.cjs');
const {saveProject} = require('../src/project-format.cjs');
const {inspectAsset} = require('../src/media.cjs');
const {createAppUpdates} = require('../src/app-updates.cjs');
const {ffmpeg} = require('./fixtures.cjs');
const {clickVisible} = require('./desktop-input.cjs');

app.on('window-all-closed',()=>{});

async function makeScenery(dir,index) {
  const width=480,height=270, bitmap=Buffer.alloc(width*height*4);
  const colors=[[162,199,208],[221,181,154],[165,180,202]];
  for (let y=0;y<height;y++) for (let x=0;x<width;x++) {
    const u=x/width,v=y/height,i=(y*width+x)*4;
    let color=colors[index].map(c=>Math.round(c+(243-c)*v*.9));
    if ((u-.72)**2+((v-.28)*height/width)**2 < .06**2) color=[248,226,177];
    for(let hill=0;hill<3;hill++) {
      const horizon=.50+.135*hill+.075*Math.sin((u+index*.34)*(5+hill)+hill*1.8);
      if(v>horizon) color=[[123,157,153],[76,120,122],[45,86,98]][hill];
    }
    bitmap[i]=color[2];bitmap[i+1]=color[1];bitmap[i+2]=color[0];bitmap[i+3]=255;
  }
  const name=['湖畔晨光','山脊落日','远山暮色'][index];
  const still=path.join(dir,name+'.png'), file=path.join(dir,name+'.mp4');
  await fs.writeFile(still,nativeImage.createFromBitmap(bitmap,{width,height}).toPNG());
  const audio = process.env.JIAJIAN_GLASS_SCREENSHOTS ? ['-f','lavfi','-i','anullsrc=r=48000:cl=mono','-c:a','aac'] : [];
  await ffmpeg(['-loop','1','-i',still,...audio,'-t','2','-r','24','-pix_fmt','yuv420p','-threads','2',file]);
  return ['scene'+index,await inspectAsset(file,'video')];
}

async function check() {
  const dir=mkdtempSync(path.join(os.tmpdir(),'jiajian-editing-guide-'));
  app.setPath('userData',path.join(dir,'electron'));
  const catalog=new Map(await Promise.all([0,1,2].map(i=>makeScenery(dir,i))));
  const glassOutput = process.env.JIAJIAN_GLASS_SCREENSHOTS;
  if (glassOutput) {
    for (const [id, name] of [['black','纯黑校样'], ['white','纯白校样']]) {
      const clip = path.join(dir, name+'.mp4');
      await ffmpeg(['-f','lavfi','-i','color='+id+':s=480x270:r=24:d=2','-threads','2',clip]);
      catalog.set(id, await inspectAsset(clip,'video'));
    }
  }
  const names=[...catalog.keys()], file=path.join(dir,'山野一日.sdworkbench');
  await saveProject(file,{
    ratio:'16:9',resolution:720,fps:24,fit:'fit',keepAudio:true,unordered:false,useOriginal:true,useMirrors:false,
    count:1,priority:'picture',musicVolume:35,musicIds:[],
    shots:names.map(id=>[{id,start:0,end:2}]), shotSettings:names.map(id=>({name:path.basename(catalog.get(id).path,'.mp4'),duration:2})),
  },catalog);
  const win=await launchDesktop({show:false,dataDirectory:path.join(dir,'drafts'),
    updateFactory:options=>createAppUpdates({...options,app:{isPackaged:false,getVersion:()=>require('../package.json').version}}),dialogs:{
    showOpenDialog:async()=>({canceled:false,filePaths:[file]}),
  }});
  const wc=win.webContents;
  wc.debugger.attach();
  wc.setBackgroundThrottling(false);
  const read=expr=>wc.executeJavaScript(expr,true);
  const click=selector=>clickVisible(wc,selector);
  const q=id=>'document.getElementById('+JSON.stringify(id)+')';
  async function wait(expr) {
    for(let i=0;i<150;i++) { if(await read(expr)) return; await delay(25); }
    throw Error('等待界面超时 '+expr);
  }
  async function key(key,code,modifiers=0) {
    const vk={Slash:191,Escape:27}[code];
    for(const type of ['rawKeyDown','keyUp']) await wc.debugger.sendCommand('Input.dispatchKeyEvent',{type,key,code,modifiers,windowsVirtualKeyCode:vk,nativeVirtualKeyCode:vk});
  }
  async function select(id,value) {
    await read('(()=>{const e='+q(id)+';e.value='+JSON.stringify(value)+';e.dispatchEvent(new Event("change",{bubbles:true}))})()');
  }
  async function readyPicture() {
    await click('.sequence-video [data-move-candidate]');
    await wait('(()=>{const v=document.getElementById("preview");return !v.hidden && v.readyState>=2 && !v.seeking})()');
    for(let i=0;i<50;i++) {
      const r=await read('(()=>{const r=document.getElementById("preview").getBoundingClientRect();return {x:r.x+r.width*.5,y:r.y+r.height*.35,width:innerWidth}})()');
      const shot=await wc.capturePage(), scale=shot.getSize().width/r.width;
      const spot=shot.crop({x:Math.round(r.x*scale),y:Math.round(r.y*scale),width:1,height:1}).toBitmap();
      if(Math.min(...spot.subarray(0,3))>55 && Math.max(...spot.subarray(0,3))-Math.min(...spot.subarray(0,3))>9) return;
      await delay(70);
    }
    throw Error('合成素材已解码，屏幕采样未出现预期画面');
  }
  async function menuContrast() {
    return read(`(()=>{
      const ctx=document.createElement('canvas').getContext('2d',{willReadFrequently:true});
      const rgba=color=>{ctx.clearRect(0,0,1,1);ctx.fillStyle=color;ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data]};
      const mix=(top,bottom)=>top.slice(0,3).map((c,i)=>(c*top[3]+bottom[i]*(255-top[3]))/255);
      const lum=rgb=>rgb.map(c=>c/255).map(c=>c<=.04045?c/12.92:((c+.055)/1.055)**2.4).reduce((a,c,i)=>a+c*[.2126,.7152,.0722][i],0);
      const reports=[];
      for(const id of ['video-track-menu','draft-context-menu','material-context-menu']) {
        const menu=document.getElementById(id), bg=rgba(getComputedStyle(menu).backgroundColor);
        const colors=[...new Set([...menu.querySelectorAll('button:enabled')].flatMap(btn=>[
          getComputedStyle(btn).color,...(btn.hasAttribute('data-menu-key')?[getComputedStyle(btn,'::after').color]:[])
        ]))];
        for(const ink of colors) for(const behind of [0,255]) {
          const background=mix(bg,[behind,behind,behind]), a=lum(background), b=lum(mix(rgba(ink),background));
          reports.push({id,ink,behind,ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05)});
        }
      }
      return reports;
    })()`);
  }
  async function collectTargets() {
    return read(`(()=>[...document.querySelectorAll('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),summary,[role=slider],[role=separator]')].filter(e=>e.checkVisibility({visibilityProperty:true})).map(e=>{
      const label=e.matches('input[type=checkbox],input[type=radio]') && e.labels?.[0], r=(label||e).getBoundingClientRect();
      return {id:e.id||e.className||e.tagName,width:Math.round(r.width),height:Math.round(r.height)};
    }).filter(o=>o.width>0 && o.height>0))()`);
  }
  async function verifyLargeHandles() {
    await click('#panel-layout-access');
    const g='#accessible-split-grips button:not([hidden])';
    const indices=await read(q('accessible-split-choice')+'.options.length');
    assert.equal(indices,11);
    const layout=()=>read('(()=>{const w=document.getElementById("editor-workspace"),s=getComputedStyle(w);return ["--split-materials","--split-inspector","--split-timeline","--split-areas"].map(id=>s.getPropertyValue(id)).join(";")})()');
    const mouse=(type,pos)=>wc.debugger.sendCommand('Input.dispatchMouseEvent',{type,...pos,button:'left',buttons:type==='mouseReleased'?0:1,clickCount:1});
    for(let i=0;i<indices;i++) {
      await select('accessible-split-choice',String(i));
      const geometry=await read('(()=>{const e=document.querySelector('+JSON.stringify(g)+'),r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,w:r.width,h:r.height,inside:[-14,14].every(dx=>[-14,14].every(dy=>e.contains(document.elementFromPoint(r.x+r.width/2+dx,r.y+r.height/2+dy))))}})()');
      assert.ok(geometry.w>=32 && geometry.h>=32 && geometry.inside,'足够大的实际拖动目标 '+i+' '+JSON.stringify(geometry));
      const before=await layout();
      const start={x:geometry.x,y:geometry.y};
      if([5,6,9,10].includes(i)) {
        await click(g);await settle();
        assert.notEqual(await layout(),before,'点击跨栏把手 '+i);
        await click(g);await settle();
        continue;
      }
      const dx=[1,8].includes(i)?-30:[0,4].includes(i)?30:0;
      const dy=i===2?-29:[3,7].includes(i)?30:[4,8].includes(i)?-24:0;
      const end={x:start.x+dx,y:start.y+dy};
      await mouse('mousePressed',start);await mouse('mouseMoved',end);await settle();
      assert.notEqual(await layout(),before,'拖动面板把手 '+i);
      await key('Escape','Escape');await mouse('mouseReleased',end);await settle();
      assert.equal(await layout(),before,'取消尺寸应恢复 '+i);
    }
    const lanes=await read('[...document.getElementById("accessible-track-choice").options].map(o=>o.value)');
    assert.ok(lanes.length>=3);
    for(const lane of lanes) {
      await select('accessible-track-choice',lane);
      const previous=await read(q('accessible-track-value')+'.valueAsNumber');
      await read(q('accessible-track-value')+'.value='+String(previous+18));
      await click('#accessible-track-apply');
      assert.equal(await read(q('accessible-track-value')+'.valueAsNumber'),previous+18);
      await click('#accessible-track-reset');
      assert.equal(await read(q('accessible-track-value')+'.valueAsNumber'),previous);
    }
    await click('#accessible-layout-controls header button');
  }
  async function settle() { await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))'); }
  try {
    win.setContentSize(1366,768);
    await click('#home-open-project');
    await wait('document.querySelectorAll(".sequence-shots [data-reorder-shot]").length==='+names.length+' && !!document.querySelector("#editing-tour")');
    for (const title of ['导入素材','建分镜','加口播','生成预览','导出']) {
      assert.ok((await read(q('editing-tour')+'.textContent')).includes(title));
      await click('#editing-tour button:last-child');
    }
    await wait('!document.querySelector("#editing-tour")');
    await click('.sequence-video [data-move-candidate]');
    if (glassOutput) {
      await readyPicture();
      await require('./glass-screenshots.cjs')({win,wc,read,click,wait,key,select,output:glassOutput});
      return;
    }
    const readme=process.env.JIAJIAN_README_SCREENSHOT;
    if (readme) {
      await wc.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:'light'}]});
      await wait('document.documentElement.dataset.theme==="light"');
      await readyPicture();
      await wait('[...document.querySelectorAll(".sequence-frames img")].every(i=>i.complete && i.naturalWidth>0)');
      await delay(250);
      await fs.mkdir(path.dirname(readme),{recursive:true});
      await fs.writeFile(readme,(await wc.capturePage()).toPNG());
    }
    await key('/','Slash',2);
    await wait('document.querySelector("#editing-help-dialog:modal")');
    const firstView = await read(`(() => {
      const dialog = document.querySelector('#editing-help-dialog');
      const body = dialog.querySelector('.cloud-settings-body'), title = document.querySelector('#editing-help-title');
      const heading = title.getBoundingClientRect(), viewport = body.getBoundingClientRect();
      const footer = dialog.querySelector('footer').getBoundingClientRect();
      return { focused:document.activeElement === title, top:body.scrollTop, outerTop:dialog.scrollTop,
        titleVisible:heading.top >= viewport.top && heading.bottom <= viewport.bottom,
        footerVisible:footer.top >= viewport.bottom - 1 && footer.bottom <= innerHeight };
    })()`);
    assert.deepEqual(firstView,{focused:true,top:0,outerTop:0,titleVisible:true,footerVisible:true},
      '1366 × 768 首开帮助时标题在正文顶部，底部操作可见');
    assert.ok((await read(q('editing-help-dialog')+'.textContent')).includes('Ctrl+S'));
    await click('#editing-help-dialog footer button:first-child');
    await click('#editing-tour button:first-child');
    await select('panel-layout-preset','口播优先');
    await wait(q('panel-layout-preset')+'.value==="口播优先"');
    await click('#panel-layout-toggle');
    await wait('document.querySelector(".layout-editing-banner").checkVisibility()');
    await select('panel-layout-preset','剪辑优先');
    await verifyLargeHandles();
    await select('panel-layout-preset','预览优先');
    await key('Escape','Escape');
    await wait(q('panel-layout-preset')+'.value==="口播优先"');
    await select('panel-layout-preset','剪辑优先');
    const lock='[data-control-key="vis0"] [data-track-action="locked"]';
    await click(lock);
    await wait('document.querySelector('+JSON.stringify(lock)+').ariaPressed==="true"');
    await click(lock);
    await wait('document.querySelector('+JSON.stringify(lock)+').ariaPressed==="false"');
    await click('#track-more');
    await click('#track-more-options [popovertarget="accessible-layout-controls"]');
    await wait(q('accessible-layout-controls')+'.matches(":popover-open")');
    await click('#accessible-layout-controls header button');
    await key('Escape','Escape');
    await click('#inspector-tab-narration');
    await click('#narration-guide summary');
    await wait(q('narration-guide')+'.offsetHeight>400');
    await settle();
    await click('#apply-narration-recommendation');
    assert.equal(await read(q('priority')+'.value'),'voice');
    await click('#inspector-tab-subtitles');
    await select('caption-preview-background','light');
    await click('#caption-enlarge');
    assert.ok(await read(q('caption-guides')+'.checked'));
    await click('#caption-guides');
    assert.ok(!await read(q('caption-guides')+'.checked'));
    await click('#caption-zoom-close');
    await click('#inspector-tab-visual');
    await click('.sequence-video [data-move-candidate]');
    await settle();
    const output=process.env.JIAJIAN_LAYOUT_SCREENSHOTS;
    if (output) await fs.mkdir(output,{recursive:true});
    await click('#open-project');
    await wait(q('notice')+'.textContent.includes("已打开工程")');
    const measures=[];
    for (const [width,height] of [[1366,768],[1280,720]]) {
      win.setContentSize(width,height);
      for (const scale of [1.25,1.50]) for (const theme of ['light','dark']) {
        wc.setZoomFactor(scale);
        await wc.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:theme}]});
        await wait('document.documentElement.dataset.theme==='+JSON.stringify(theme));
        await settle();
        const panes=await read('[...document.querySelectorAll(".panel-layout-pane")].map(el=>{const r=el.getBoundingClientRect();return {w:r.width,h:r.height}})');
        assert.ok(panes.length===4 && panes.every(({w,h})=>w>0 && h>0),width+' × '+height+' '+scale+' '+theme);
        if (await read(q('compact-inspector-toggle')+'.checkVisibility()')) {
          if (await read(q('compact-inspector-toggle')+'.ariaExpanded==="false"')) await click('#compact-inspector-toggle');
          await click('#compact-inspector-toggle');
          assert.equal(await read(q('compact-inspector-toggle')+'.ariaExpanded'),'false');
        }
        await readyPicture();
        const targets=await collectTargets();
        const contrast=await menuContrast();
        assert.ok(contrast.length && contrast.every(c=>c.ratio>=4.5),JSON.stringify(contrast));
        measures.push({width,height,scale,theme,count:targets.length,small:targets.filter(t=>Math.min(t.width,t.height)<32),contrast});
        if (output) await delay(250);
        if (output) await fs.writeFile(path.join(output,[width,height,scale,theme].join('-')+'.png'),(await wc.capturePage()).toPNG());
      }
    }
    await wc.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[
      {name:'prefers-color-scheme',value:'dark'},{name:'prefers-reduced-transparency',value:'reduce'},{name:'prefers-reduced-motion',value:'reduce'},
    ]});
    await wait('matchMedia("(prefers-reduced-transparency: reduce)").matches');
    const solid=await read(`["video-track-menu","draft-context-menu","material-context-menu"].map(id=>{
      const s=getComputedStyle(document.getElementById(id)),c=document.createElement("canvas").getContext("2d");
      c.fillStyle=s.backgroundColor;c.fillRect(0,0,1,1);
      return {id,filter:s.backdropFilter,color:s.backgroundColor,alpha:c.getImageData(0,0,1,1).data[3]};
    })`);
    assert.ok(solid.every(s=>s.filter==='none' && s.alpha===255),JSON.stringify(solid));
    await key('?','Slash',8);
    await wait('document.querySelector("#editing-help-dialog:modal")');
    await click('#editing-help-dialog footer button:last-child');
    if(output) await fs.writeFile(path.join(output,'hit-targets.json'),JSON.stringify(measures,null,2));
    console.log('五步入门、重看与速查、布局预设及 Esc 还原、口播推荐、字幕安全线通过。8 项多尺寸/缩放/外观检查通过。');
  } finally {
    wc.debugger.detach(); win.destroy();
    // Chromium releases the temporary profile when Electron exits.
  }
}
check().then(()=>app.exit(0),error=>{console.error(error);app.exit(1);});
