'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const os=require('node:os');
const fs=require('node:fs/promises');
const path=require('node:path');
const {createPerformanceCache,readPerformance}=require('../src/performance-cache.cjs');

test('preload once per boot, reuse unchanged draft media, invalidate edits and clear only owned proxies',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'jiajian-boot-test-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'素材.mp4');
  await fs.writeFile(file,'v1');
  let probes=0,posters=0,encodes=0,visits=0,boot=100000;
  const options={
    bootTime:()=>boot,
    inspect:async(p,kind)=>{probes++;return {path:p,kind,duration:3,width:1920,height:1080};},
    thumbnail:async()=>{posters++;return Buffer.from('poster');},
    encode:async(_asset,out,_signal,edge)=>{encodes++;await fs.writeFile(out,'proxy'+edge);},
  };
  async function* refs() {visits++;yield {path:path.join(dir,'missing.mp4'),kind:'video'};yield {path:file,kind:'video'};yield {path:file,kind:'video'};}
  let cache=createPerformanceCache(dir,options);
  assert.equal(await cache.preload(refs),true);
  assert.deepEqual([visits,probes,posters,encodes],[1,1,1,1]);
  cache.close();
  cache=createPerformanceCache(dir,options);
  assert.equal(await cache.preload(refs),false);
  const asset=await cache.inspectCached(file,'video');
  assert.equal(await fs.readFile(await cache.proxy(asset),'utf8'),'proxy640');
  boot+=20000;
  assert.equal(await cache.preload(refs),true);
  assert.deepEqual([visits,probes,posters,encodes],[2,1,1,1]);
  await fs.appendFile(file,'-changed');
  const newAsset=await cache.inspectCached(file,'video');
  await cache.proxy(newAsset);
  assert.equal(probes,2);
  assert.equal(encodes,2);
  const location=path.join(dir,'移动缓存');
  await cache.change({location,optimization:'smooth',defaultProxy:false});
  assert.equal(await fs.readFile(await cache.proxy(newAsset),'utf8'),'proxy480');
  await fs.writeFile(path.join(location,'用户原片.mp4'),'original');
  assert.equal((await cache.view()).bytes,8);
  await cache.clear();
  assert.deepEqual(await fs.readdir(location),['用户原片.mp4']);
  assert.equal((await cache.view()).bytes,0);
});

test('loading a legacy GPU preference preserves proxy settings and drops the obsolete key on save', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jiajian-legacy-performance-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'performance.json');
  const prefs = { defaultProxy: false, optimization: 'quality', location: path.join(dir, '代理') };
  await fs.writeFile(file, JSON.stringify({ ...prefs, gpu: false }));
  assert.deepEqual(readPerformance(dir), { ...prefs, hdrMode:'sdr' });
  const cache = createPerformanceCache(dir, {});
  await assert.rejects(cache.change({ gpu: false }), /性能设置无效/);
  await cache.change({ optimization: 'smooth' });
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { ...prefs, optimization: 'smooth',hdrMode:'sdr' });
});

test('small HDR and VFR proxies follow project fps, color capability and saved preferences', async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'jiajian-color-cache-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'素材.mp4');
  await fs.writeFile(file,'fixture');
  const asset={path:file,kind:'video',width:256,height:144,duration:4,hdr:'smpte2084',vfr:true};
  let available=true;
  const cache=createPerformanceCache(dir,{supportsHdrToneMap:async()=>available,
    encode:async(_asset,out,_signal,edge,retime,options)=>fs.writeFile(out,JSON.stringify({edge,retime,...options}))});
  const proxy=await cache.proxy(asset,{fps:25});
  assert.deepEqual(JSON.parse(await fs.readFile(proxy,'utf8')),{edge:256,fps:25,hdrMode:'sdr'});
  assert.notEqual(await cache.proxy(asset,{fps:60}),proxy);
  assert.equal(await cache.proxy(asset,{fps:0}),null);
  const retime={rate:4,original:true,fps:25};
  const retimed=await cache.proxy(asset,{retime});
  await assert.rejects(cache.change({hdrMode:'bad'}),/性能设置无效/);
  await cache.change({hdrMode:'preserve'});
  assert.equal(readPerformance(dir).hdrMode,'preserve');
  const preserved=await cache.proxy(asset,{fps:25});
  assert.notEqual(preserved,proxy);
  assert.notEqual(await cache.proxy(asset,{retime}),retimed);
  await cache.change({hdrMode:'sdr'});
  available=false;
  assert.equal(await cache.proxy(asset,{fps:25}),preserved);
  assert.equal(await cache.proxy({...asset,hdr:undefined,vfr:false},{fps:25}),null);
  cache.close();
});

test('媒体任务的设置快照等待已开始的保存，旧导出保留启动时的策略', async t => {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'jiajian-settings-race-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const file=path.join(directory,'input.mp4');
  await fs.writeFile(file,'fixture');
  const asset={kind:'video',path:file,width:256,height:144,duration:1,hdr:'smpte2084'};
  const started=Promise.withResolvers(), stopping=Promise.withResolvers(), release=Promise.withResolvers();
  const changes=[];
  const cache=createPerformanceCache(directory,{
    supportsHdrToneMap:async()=>true,
    onSettingsChanged:(before,after)=>changes.push([before.hdrMode,after.hdrMode]),
    async encode(_asset,out,signal,_edge,_retime,{hdrMode}) {
      if (hdrMode==='sdr') {
        signal.addEventListener('abort',()=>stopping.resolve(),{once:true});
        started.resolve();
        await release.promise;
        signal.throwIfAborted();
      }
      await fs.writeFile(out,hdrMode);
    },
  });
  t.after(()=>cache.close());
  const oldExport=await cache.settledSettings();
  const cancelled=assert.rejects(cache.proxy(asset), {name:'AbortError'});
  await started.promise;
  const saving=cache.change({hdrMode:'preserve'});
  await stopping.promise;
  let ready=false;
  const newExport=cache.settledSettings().then(snapshot=>{ready=true;return snapshot;});
  const newProxy=cache.proxy(asset);
  await new Promise(done=>setImmediate(done));
  assert.equal(ready,false);
  release.resolve();
  await Promise.all([cancelled,saving]);
  assert.equal((await newExport).hdrMode,'preserve');
  assert.equal(await fs.readFile(await newProxy,'utf8'),'preserve');
  assert.equal(oldExport.hdrMode,'sdr');
  await Promise.all([cache.change({hdrMode:'sdr'}),cache.change({hdrMode:'preserve'})]);
  assert.deepEqual(changes,[['sdr','preserve'],['preserve','sdr'],['sdr','preserve']]);
  await assert.rejects(cache.change({hdrMode:'invalid'}));
  assert.equal((await cache.settledSettings()).hdrMode,'preserve');
});

test('music measurements share disk and in-flight results, enforce access and invalidate equal-size equal-time content',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'jiajian-music-cache-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'素材.wav'), fixedTime=new Date('2025-01-01T00:00:00.000Z');
  async function replace(contents) {
    await fs.writeFile(file,contents);
    await fs.utimes(file,fixedTime,fixedTime);
  }
  await replace('aaaa');
  const asset={kind:'audio',path:file,audioIndex:0};
  const allow=async()=>{};
  let runs=0;
  const options={measureMusicLoudness:async source=>{
    runs++;
    const contents=await fs.readFile(source.path,'utf8');
    return contents==='aaaa' ? {integratedLufs:-24,truePeakDbtp:-8} : {integratedLufs:null,truePeakDbtp:null};
  }};
  let cache=createPerformanceCache(dir,options);
  const [first,other]=await Promise.all([cache.musicLoudness(asset,allow),cache.musicLoudness(asset,allow)]);
  assert.deepEqual(first,other);
  assert.equal(runs,1);
  cache.close();
  cache=createPerformanceCache(dir,options);
  t.after(()=>cache.close());
  assert.deepEqual(await cache.musicLoudness(asset,allow),first);
  await assert.rejects(cache.musicLoudness(asset,()=>{throw Error('denied');}),/denied/);
  assert.equal(runs,1);
  const before=await fs.stat(file,{bigint:true});
  await replace('bbbb');
  const after=await fs.stat(file,{bigint:true});
  assert.deepEqual([before.size,before.mtimeNs],[after.size,after.mtimeNs]);
  const changed=await cache.musicLoudness(asset,allow);
  assert.notEqual(changed.key,first.key);
  assert.deepEqual(changed.measurement,{integratedLufs:null,truePeakDbtp:null});
  assert.equal(runs,2);
  await cache.musicLoudness({...asset,audioIndex:1},allow);
  assert.equal(runs,3);
});

test('changed audio during measurement is discarded and cancelled identity reads leave other callers running', async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'jiajian-music-identity-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'input.wav');
  await fs.writeFile(file,'same-length-original');
  const {audioContentIdentity}=require('../src/audio-content-identity.cjs');
  const gate=Promise.withResolvers(), controller=new AbortController();
  const first=audioContentIdentity(file,{signal:controller.signal,authorize:()=>gate.promise});
  const second=audioContentIdentity(file);
  controller.abort();
  await assert.rejects(first,{name:'AbortError'});
  gate.resolve();
  assert.equal(await second,require('node:crypto').createHash('sha256').update('same-length-original').digest('hex'));
  const asset={kind:'audio',path:file,audioIndex:0};
  const cache=createPerformanceCache(dir,{measureMusicLoudness:async()=>{
    await fs.writeFile(file,'same-length-replaced');
    return {integratedLufs:-14,truePeakDbtp:-1};
  }});
  t.after(()=>cache.close());
  assert.equal(await cache.musicLoudness(asset,async()=>{}),null);
});

test('short stereo PCM uses the same speed filters and exact output sample count within its decode budget',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'jiajian-short-music-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'短曲.wav');
  await require('./fixtures.cjs').ffmpeg(['-f','lavfi','-i','sine=frequency=330:sample_rate=48000:duration=0.3','-c:a','pcm_s16le',file]);
  const {inspectAsset,extractShortMusicPcm}=require('../src/media.cjs');
  const asset=await inspectAsset(file,'audio');
  for (const speed of [0.5,1,2.5]) {
    const pcm=await extractShortMusicPcm(asset,speed);
    assert.equal(pcm.sampleRate,48000);
    assert.equal(pcm.channels,2);
    assert.equal(pcm.samples.length,Math.round(asset.duration/speed*48000)*2);
    assert.ok(pcm.samples.some(value=>value>0.01));
  }
  for (const speed of [0,3.1,NaN]) assert.equal(await extractShortMusicPcm(asset,speed),null);
  assert.equal(await extractShortMusicPcm({...asset,duration:5},1),null);
  assert.equal(await extractShortMusicPcm({...asset,duration:3},0.5),null);
});

test('a 1000-plan subproject batch checks each shared narration once, and a new batch checks again',async()=>{
  const {prepareSubprojectPlans}=require('../src/preview-plans.cjs');
  const projects=Array.from({length:1000},(_,i)=>({id:'p'+i,name:'门店'+i,shots:[]}));
  const catalog=new Map([['photo',{kind:'video',name:'画面',duration:1}],
    ['voice',{kind:'audio',name:'口播',duration:4,audioIndex:0}]]);
  const config={shots:[[{id:'photo',start:0,end:1}]],count:1,ratio:'16:9',resolution:720,fps:30,fit:'fit',
    keepAudio:false,unordered:false,useOriginal:true,useMirrors:false,musicIds:[],musicVolume:0,
    priority:'picture',narrationId:'voice',narrationTrim:require('../src/ui/narration-trim.js').smartDefaults,
    subprojects:{active:null,main:[],projects}};
  const scope=projects.map(({id})=>({id,count:1}));
  let calls=0;
  const options={analyzePauses:async()=>{calls++;return [];}};
  assert.equal((await prepareSubprojectPlans(config,scope,catalog,options)).length,1000);
  assert.equal(calls,1);
  await prepareSubprojectPlans(config,scope.slice(0,2),catalog,options);
  assert.equal(calls,2);
});
