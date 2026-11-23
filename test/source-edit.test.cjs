'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { normalizeSourceEditRanges,prepareSourceEdit } = require('../src/source-edit.cjs');
const { inspectAsset } = require('../src/media.cjs');
const { ffmpeg } = require('./fixtures.cjs');

test('normalizes source-relative effects and rejects invalid or oversized edits',()=>{
  const plain={start:0,end:1};
  assert.deepEqual(normalizeSourceEditRanges([{...plain,reverse:false,rotation:0,crop:{x:0,y:0,width:1,height:1}}],1),[plain]);
  for (const edit of [{reverse:'yes'},{mirror:1},{rotation:30},{crop:{x:.4,y:0,width:.7,height:1}},{end:1.2}]) {
    assert.throws(()=>normalizeSourceEditRanges([{...plain,...edit}],1));
  }
  assert.throws(()=>normalizeSourceEditRanges(Array(2001).fill(plain),1));
  assert.throws(()=>normalizeSourceEditRanges([{start:.3,end:.31}],1));
  const intersection=[{start:.31,end:.39},{start:.70,end:.72}];
  assert.deepEqual(normalizeSourceEditRanges(intersection,1),intersection);
});

test('renders bounded reverse chunks, original audio, normalized crop, mirror and clockwise rotation',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'jiajian-source-effects-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const source=path.join(root,'四象限.mp4');
  const pattern="color=red:s=160x96:r=24:d=10,drawbox=x=80:y=0:w=80:h=48:c=lime:t=fill,"
    +"drawbox=x=0:y=48:w=80:h=48:c=blue:t=fill,drawbox=x=80:y=48:w=80:h=48:c=yellow:t=fill,"
    +"drawbox=x=70:y=35:w=20:h=24:c=white:t=fill:enable='gte(t,5)'";
  await ffmpeg(['-f','lavfi','-i',pattern,'-f','lavfi','-i','sine=frequency=440:duration=5',
    '-f','lavfi','-i','sine=frequency=880:duration=5','-filter_complex','[1:a][2:a]concat=n=2:v=0:a=1[a]',
    '-map','0:v','-map','[a]','-c:v','libx264','-threads','2','-c:a','aac',source]);
  const sourceBytes=await fs.readFile(source);
  const asset=await inspectAsset(source,'video');
  const ranges=[
    {start:0,end:10,reverse:true},
    {start:0,end:.5,crop:{x:0,y:0,width:1,height:.5},mirror:true,rotation:90},
    {start:0,end:.5,mirror:true},
    {start:0,end:.5,rotation:180},
    {start:0,end:.5,rotation:270},
  ];
  const cache=path.join(root,'source-edits');
  const [file,same]=await Promise.all([prepareSourceEdit(asset,ranges,cache),prepareSourceEdit(asset,ranges,cache)]);
  assert.equal(file,same);
  assert.deepEqual(await fs.readdir(cache),[path.basename(file)]);
  const media=await inspectAsset(file,'video');
  assert.deepEqual([media.width,media.height,media.fps,media.duration],[160,96,24,12]);
  const rgb=async(t,x,y)=>{
    const sample=await ffmpeg(['-ss',String(t),'-i',file,'-an','-frames:v','1','-vf',`crop=4:4:${x}:${y},scale=1:1`,
      '-pix_fmt','rgb24','-f','rawvideo','pipe:1']);
    assert.equal(sample.length,3);
    return [...sample].map(v=>Number(v>135)).join('');
  };
  for (const [t,x,y,expected] of [
    [.3,77,40,'111'],[3,77,40,'111'],[6.7,77,40,'100'],[9.7,77,40,'100'],
    [10.25,78,20,'010'],[10.25,78,72,'100'],[10.25,15,45,'000'],
    [10.75,12,12,'010'],[11.25,12,12,'110'],[11.75,70,20,'010'],
  ]) assert.equal(await rgb(t,x,y),expected,`时间 ${t} 秒，位置 ${x},${y}`);
  for (const [time,hz] of [[.3,880],[3,880],[6.7,440],[9.7,440],[10.25,440]]) {
    const pcm=await ffmpeg(['-ss',String(time),'-i',file,'-vn','-t','0.1','-ac','1','-ar','8000','-f','s16le','pipe:1']);
    let count=0;
    for (let i=2;i<pcm.length;i+=2) if (pcm.readInt16LE(i-2)<0 && pcm.readInt16LE(i)>=0) count++;
    assert.ok(Math.abs(count*16000/pcm.length-hz)<20,'倒放原声频率错误 '+time);
  }
  const silent=path.join(root,'无声.mp4');
  await ffmpeg(['-i',source,'-an','-c:v','copy',silent]);
  const quiet=await prepareSourceEdit(await inspectAsset(silent,'video'),[{start:.5,end:1.5,reverse:true}],cache);
  assert.equal((await inspectAsset(quiet,'video')).audioIndex,null);
  const short=await prepareSourceEdit(asset,[{start:.01,end:.09},{start:9.97,end:9.99,reverse:true}],cache);
  const shortMedia=await inspectAsset(short,'video');
  assert.equal(shortMedia.duration,.125,'最短合法工程总长应向上保留至少 0.1 秒');
  const last=await ffmpeg(['-ss','0.08','-i',short,'-an','-frames:v','1','-vf','crop=4:4:77:40,scale=1:1',
    '-pix_fmt','rgb24','-f','rawvideo','pipe:1']);
  assert.equal(last.length,3);
  assert.ok([...last].every(v=>v>200),'末段不足一帧的短交集应保留源末帧');
  const remainder=await prepareSourceEdit(asset,[{start:4,end:4.04,reverse:true},{start:0,end:4,reverse:true,mirror:true}],cache);
  const remnant=await inspectAsset(remainder,'video');
  assert.equal(remnant.fps,24,'首个孤立帧和下一长段的 DTS 应连续');
  assert.ok(Math.abs(remnant.duration-97/24)<.002);
  await fs.writeFile(quiet,'损坏的剪辑缓存');
  assert.equal(await prepareSourceEdit(await inspectAsset(silent,'video'),[{start:.5,end:1.5,reverse:true}],cache),quiet);
  assert.equal((await inspectAsset(quiet,'video')).duration,1,'应重建损坏的持久缓存');
  assert.deepEqual(await fs.readFile(source),sourceBytes);
});
