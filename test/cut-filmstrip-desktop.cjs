'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {app} = require('electron');
const {launchDesktop} = require('../src/desktop.cjs');
const {ffmpeg} = require('./fixtures.cjs');

async function check() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jiajian-filmstrip-'));
  app.setPath('userData', path.join(dir, 'profile'));
  const file = path.join(dir, '竖屏长GOP.mov');
  await ffmpeg(['-f','lavfi','-i','testsrc=size=1080x1920:rate=24','-t','10.75',
    '-c:v','libx264','-threads','3','-pix_fmt','yuv420p','-preset','ultrafast','-g','240','-sc_threshold','0',file]);
  const win = await launchDesktop({show:false,dataDirectory:path.join(dir,'data'),dialogs:{
    showOpenDialog:async()=>({canceled:false,filePaths:[file]}),
  }});
  const wc = win.webContents;
  wc.setBackgroundThrottling(false);
  try {
    const script = await fs.readFile(path.join(__dirname,'../src/ui/cut-filmstrip.js'),'utf8');
    await wc.executeJavaScript(`window.metrics={calls:0,pending:0,peak:0}; window.instrumented={
      workbench:{async clipThumbnail(id,t){
        metrics.calls++; metrics.pending++; metrics.peak=Math.max(metrics.peak,metrics.pending);
        try{return await workbench.clipThumbnail(id,t);}finally{metrics.pending--;}
      }},drawCutPicture:window.drawCutPicture}; ((window)=>{${script}\n})(window.instrumented);`);
    const result = await wc.executeJavaScript(`(async()=>{
      const picked=await workbench.pick('video',1), asset=picked.assets[0];
      const box=document.createElement('div');
      box.style.cssText='position:fixed;left:0;top:0;width:1160px;height:44px';
      const film=document.createElement('div');
      film.className='video-cut-filmstrip';box.append(film);document.body.append(box);
      const frame=()=>new Promise(requestAnimationFrame);
      const images=()=>[...film.querySelectorAll('img')];
      const wait=async(predicate)=>{
        const end=performance.now()+20000;
        while(!predicate()){if(performance.now()>end)throw Error('等待胶片加载超时');await frame();}
      };
      const started=performance.now();
      const strip=instrumented.mountCutFilmstrip(film,asset,[{start:0,end:asset.duration}]);
      const initialRequests=metrics.calls;
      await wait(()=>images().some(img=>img.naturalWidth));
      const firstPictureMs=Math.round(performance.now()-started);
      // Wait for the actual source samples, not just nearest-frame coverage.
      await wait(()=>new Set(images().map(img=>img.currentSrc)).size===images().length && !metrics.pending);
      const coldMs=Math.round(performance.now()-started), nodes=images();
      const before=metrics.calls;
      let covered=0;
      for(let i=1;i<=60;i++){
        strip.update([{start:i*.05,end:asset.duration}],true);
        await frame();
        if(images().every((img,j)=>img===nodes[j] && img.naturalWidth>0)) covered++;
      }
      const draggingRequests=metrics.calls-before;
      const finalRange=[{start:3,end:asset.duration}];
      strip.update(finalRange);
      await wait(()=>new Set(images().map(img=>img.currentSrc)).size===images().length && !metrics.pending);
      const after=metrics.calls;
      strip.update([{start:3.000001,end:asset.duration}]);
      await frame();
      const tinyChangeRequests=metrics.calls-after;
      const seed=nodes[0].cloneNode();
      seed.dataset.thumb=asset.id;seed.dataset.time=String(finalRange[0].start);
      document.body.append(seed);
      await seed.decode();
      strip.destroy();film.replaceChildren();
      const reopened=instrumented.mountCutFilmstrip(film,asset,finalRange);
      const seeded=images().filter(img=>img.hasAttribute('src')).length;
      const closedCalls=metrics.calls;
      reopened.destroy();box.remove();seed.remove();
      await wait(()=>!metrics.pending);
      await frame();
      return {initialRequests,firstPictureMs,coldMs,tiles:nodes.length,covered,draggingRequests,
        settledRequests:after-before,tinyChangeRequests,peak:metrics.peak,seeded,lateRequests:metrics.calls-closedCalls};
    })()`);
    assert.equal(result.initialRequests,2);
    assert.equal(result.peak,2);
    assert.equal(result.covered,60);
    assert.equal(result.draggingRequests,0);
    assert.equal(result.tinyChangeRequests,0);
    assert.equal(result.lateRequests,0);
    assert.equal(result.seeded,result.tiles);
    assert.ok(result.tiles>10 && result.settledRequests<result.tiles);
    console.log('1080×1920 长 GOP MOV 胶片拖动', JSON.stringify(result));
  } finally { win.destroy(); }
}

check().then(()=>app.exit(0),error=>{console.error(error);app.exit(1);});
