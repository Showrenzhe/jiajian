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
  await cache.change({location,optimization:'smooth',gpu:false,defaultProxy:false});
  assert.equal(readPerformance(dir).gpu,false);
  assert.equal(await fs.readFile(await cache.proxy(newAsset),'utf8'),'proxy480');
  await fs.writeFile(path.join(location,'用户原片.mp4'),'original');
  assert.equal((await cache.view()).bytes,8);
  await cache.clear();
  assert.deepEqual(await fs.readdir(location),['用户原片.mp4']);
  assert.equal((await cache.view()).bytes,0);
});
