'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { inspectAsset, createVideoThumbnail, createTrackProxy, normalizeSubtitleStyle, planMontage, planExtraction, exportBatch, maxWholeTracks } = require('../src/media.cjs');
const { prepareMontagePlans } = require('../src/preview-plans.cjs');
const { ffmpeg, fixtures } = require('./fixtures.cjs');
const { createForeground } = require('../src/foreground.cjs');
const { detectPauses, processAudio, retained, mergeFillers, retimeCaptions } = require('../src/audio-tools.cjs');

test('音频波形从各声道读出静音、反相高频和裁剪区间，区分无声视频与原声视频', async (t) => {
  const {extractAudioWaveform} = require('../src/media.cjs');
  const {catalog,output}=await fixtureDirectory(t);
  const file=path.join(output,'立体声反相.wav');
  const gated='sin(2*PI*9000*t)*between(t\\,0.2\\,0.5)';
  await ffmpeg(['-f','lavfi','-i',`aevalsrc=0.75*${gated}|-0.75*${gated}:d=1:s=48000`,'-c:a','pcm_s16le',file]);
  const audio=await inspectAsset(file,'audio');
  const full=await extractAudioWaveform(audio);
  assert.equal(full.duration,1);
  assert.equal(full.start,0);
  assert.equal(full.end,1);
  assert.equal(full.step,.01);
  assert.equal(full.peaks.length,100);
  assert.ok(full.peaks.slice(0,19).every((v)=>v===0));
  assert.ok(full.peaks.slice(22,48).every((v)=>Math.abs(v-.75)<.001));
  assert.ok(full.peaks.slice(51).every((v)=>v===0));
  const cut=await extractAudioWaveform(audio,{start:.41,end:.66});
  assert.deepEqual(cut.peaks,full.peaks.slice(41,66));
  assert.equal(cut.start,.41);
  assert.equal(await extractAudioWaveform(catalog.get('green')),null);
  assert.equal(await extractAudioWaveform(catalog.get('still')),null);
  assert.ok((await extractAudioWaveform(catalog.get('red'))).peaks.some((v)=>v>.05));
  const delayed=path.join(output,'推迟的原声.mkv');
  await ffmpeg(['-f','lavfi','-i','color=blue:s=64x64:r=10:d=2','-itsoffset','0.3','-i',file,
    '-map','0:v:0','-map','1:a:0','-c:v','libx264','-threads','1','-c:a','pcm_s16le',delayed]);
  const wrapped=await inspectAsset(delayed,'video');
  const offset=await extractAudioWaveform(wrapped,{start:.1,end:1.4});
  assert.ok(offset.peaks.slice(0,38).every((v)=>v===0));
  assert.ok(offset.peaks.slice(42,68).every((v)=>Math.abs(v-.75)<.001));
  assert.ok(offset.peaks.slice(72).every((v)=>v===0));
  const quiet=path.join(output,'长静音.wav');
  await ffmpeg(['-f','lavfi','-i','anullsrc=r=8000:cl=mono','-t','50','-c:a','pcm_s16le',quiet]);
  const flat=await extractAudioWaveform(await inspectAsset(quiet,'audio'));
  assert.ok(flat.peaks.length<=4096 && flat.step*flat.peaks.length>=50);
  assert.ok(flat.peaks.every((v)=>v===0),'真正的静音轨保留完整的静音波形');
});

test('音频波形缓存合并并限制并发，切换工程时丢弃旧解码和排队任务',async()=>{
  const {createWaveformCache}=require('../src/waveform-cache.cjs');
  const cache=createWaveformCache();
  const gate=Promise.withResolvers(), calls=[];
  const read=(name)=>async(signal)=>{calls.push(name);await gate.promise;return {name,cancelled:signal.aborted};};
  const a=cache.get('A',read('A')), duplicate=cache.get('A',read('duplicate'));
  const b=cache.get('B',read('B')), queued=cache.get('C',read('C'));
  await Promise.resolve();
  assert.equal(a,duplicate);
  assert.deepEqual(calls,['A','B']);
  cache.reset();
  const fresh=cache.get('A',read('fresh'));
  gate.resolve();
  assert.deepEqual(await Promise.all([a,b,queued]),[null,null,null]);
  const result=await fresh;
  assert.deepEqual(result,{name:'fresh',cancelled:false});
  assert.deepEqual(calls,['A','B','fresh']);
  assert.equal(await cache.get('A',()=>{throw Error('不应再次解码');}),result);
});

test('语气词只从独立的识别片段中提出，去停顿后重新对应字幕',()=>{
  const cuts=mergeFillers([{start:0.9,end:1.5}],[
    {start:1400,end:1600,text:'呃。'},{start:1650,end:2200,text:'嗯，就是这里。'},
  ],3);
  assert.deepEqual(cuts,[{start:0.9,end:1.6,label:'语气词「呃。」'}]);
  assert.deepEqual(retimeCaptions([{start:0,end:450,text:'前'},{start:920,end:1550,text:'嗯'},{start:2000,end:2800,text:'后'}],cuts),
    [{start:0,end:450,text:'前'},{start:1300,end:2100,text:'后'}]);
});

test('去气口按可调整的区间同步裁切声画，原声可单独导入', async (t) => {
  const {output}=await fixtureDirectory(t);
  const file=path.join(output,'pauses.mp4');
  await ffmpeg(['-f','lavfi','-i','color=c=red:s=160x120:r=25:d=3','-f','lavfi','-i',
    'aevalsrc=0.3*sin(2*PI*440*t)*between(t\\,0.2\\,0.8)+0.3*sin(2*PI*600*t)*between(t\\,1.6\\,2.7):d=3:s=44100',
    '-shortest','-c:a','aac','-c:v','libx264','-threads','1',file]);
  const asset=await inspectAsset(file,'video'), gaps=await detectPauses(asset);
  assert.equal(gaps.length,2);assert.ok(Math.abs(gaps[0].start-0.86)<0.01 && Math.abs(gaps[0].end-1.54)<0.01);
  const [cut]=await processAudio(asset,{mode:'trim',intervals:[{start:0.90,end:1.55}]},output);
  assert.ok(Math.abs(cut.duration-2.35)<0.05);assert.equal(cut.width,160);assert.notEqual(cut.audioIndex,null);
  const [sound]=await processAudio(asset,{mode:'extract'},output);
  assert.equal(sound.kind,'audio');assert.ok(Math.abs(sound.duration-3)<0.04);
  assert.throws(()=>retained(3,[{start:0,end:3}]),/保留/);
  assert.throws(()=>retained(3,[{start:1,end:2.5},{start:2,end:3}]),/重叠/);
});

test('离线人声与伴奏逐样本重合成原混音', {skip:process.platform!=='win32'}, async (t) => {
  const {output}=await fixtureDirectory(t);
  const file=path.join(output,'stems.wav');
  await ffmpeg(['-f','lavfi','-i','aevalsrc=0.12*sin(2*PI*98*t)+0.15*sin(2*PI*460*t)*(0.7+0.3*cos(2*PI*4*t)):s=44100:d=5',
    '-ac','2','-c:a','pcm_s16le',file]);
  const [voice,bed]=await processAudio(await inspectAsset(file,'audio'),{mode:'both'},output);
  const pcm=await Promise.all([file,voice.path,bed.path].map((item)=>ffmpeg(['-i',item,'-ac','1','-f','s16le','-'])));
  const [original,v,b]=pcm;assert.equal(v.length,original.length);assert.equal(b.length,original.length);
  let error=0, vocalEnergy=0, bedEnergy=0;
  for(let i=0;i<original.length;i+=2) {
    const a=v.readInt16LE(i), bsample=b.readInt16LE(i);
    error=Math.max(error,Math.abs(original.readInt16LE(i)-a-bsample));vocalEnergy+=a*a;bedEnergy+=bsample*bsample;
  }
  assert.ok(error<=2,'两条音轨必须能重构混音');assert.ok(vocalEnergy>1000 && bedEnergy>1000);
});

async function fixtureDirectory(t) {
  const parent = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(parent, 'sd-media-test-'));
  t.after(async () => {
    const resolved = await fs.realpath(root);
    assert.equal(path.dirname(resolved), parent);
    assert.ok(path.basename(resolved).startsWith('sd-media-test-'));
    await fs.rm(resolved, { force: true, recursive: true });
  });
  const files = await fixtures(root);
  const catalog = new Map(await Promise.all(Object.entries(files).map(async ([id, file]) => [
    id, await inspectAsset(file, file.endsWith('.wav') ? 'audio' : file.endsWith('.png') ? 'image' : 'video'),
  ])));
  const output = path.join(root, 'output');
  await fs.mkdir(output);
  return { catalog, output };
}

const montage = {
  shots: [
    [{ id: 'red', start: 0.3, end: 0.95 }, { id: 'blue', start: 0.1, end: 0.95 }],
    [{ id: 'green', start: 0.1, end: 0.75 }],
  ],
  ratio: '9:16', resolution: 720, fps: 24, fit: 'fill', keepAudio: false, unordered: false,
  useOriginal: true, useMirrors: false,
  musicIds: ['music'], musicVolume: 50, count: 2,
};

test('anchors whole narration to a reordered shot and burns only the selected video captions',async(t)=>{
  const {catalog,output}=await fixtureDirectory(t);
  const caption={name:'重点字',cues:[{start:100,end:450,text:'测试 SALE',highlights:[{word:'SALE',color:'#ffff00'}]}]};
  const cfg={...montage,ratio:'16:9',musicIds:[],count:1,shots:[[{id:'green',start:0,end:.5,videoSubtitles:caption}],[{id:'blue',start:0,end:.5}]],narrationId:'music',priority:'picture',wholeStartShots:[1],generatedCaptions:{music:'跟随分镜'}};
  const [plan]=planMontage(cfg,catalog);
  assert.equal(plan.voiceStart,.5);
  assert.equal(plan.subtitles.cues[0].start,500);
  assert.deepEqual(plan.videoSubtitles.cues,caption.cues);
  const {results,failures}=await exportBatch([plan],output);
  assert.deepEqual(failures,[]);
  const file=results[0].path;
  assert.equal(await toneAt(file,'0.15'),0);
  assert.ok(Math.abs(await toneAt(file,'0.60')-660)<65);
  const rgb=await ffmpeg(['-ss','0.25','-i',file,'-vf','crop=640:200:(iw-640)/2:ih-200','-frames:v','1','-an','-pix_fmt','rgb24','-f','rawvideo','pipe:1']);
  let yellow=0;
  for(let i=0;i<rgb.length;i+=3) if(rgb[i]>180 && rgb[i+1]>180 && rgb[i+2]<80) yellow++;
  assert.ok(yellow>50,'指定词应在导出的画面上显示为黄色');
  const [reordered]=planMontage({...cfg,unordered:true},catalog,()=>0);
  assert.equal(reordered.clips[0].shotIndex,1);
  assert.equal(reordered.voiceStart ?? 0,0);
});

async function frameColor(file, seconds) {
  const [red, green, blue] = await ffmpeg([
    '-ss', String(seconds), '-i', file, '-an', '-frames:v', '1', '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
  ]);
  return { red, green, blue };
}

async function toneAt(media, position) {
  const pcm = await ffmpeg(['-ss', position, '-i', media, '-t', '0.1', '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1']);
  assert.ok(pcm.length >= 1000);
  let crossings = 0;
  let peak = 0;
  let last = 0;
  for (let offset = 0; offset < pcm.length; offset += 2) {
    const sample = pcm.readInt16LE(offset);
    if (sample > 0 && last <= 0) crossings += 1;
    peak = Math.max(peak, Math.abs(sample));
    last = sample;
  }
  return peak < 100 ? 0 : crossings * 8000 / (pcm.length / 2);
}

test('free video placements keep narration anchored and extend the canvas beyond the last shot',async(t)=>{
  const {catalog,output}=await fixtureDirectory(t);
  const [plan]=planMontage({...montage,ratio:'16:9',keepAudio:true,count:1,musicIds:[],priority:'picture',
    shots:[[{id:'red',start:0,end:.75,videoStart:.875,videoLane:1}],[{id:'green',start:0,end:.75}]],
    narrationMode:'segmented',segmentNarrationIds:[['music'],[]]},catalog);
  assert.equal(plan.duration,1.625);
  const {results,failures}=await exportBatch([plan],output);
  assert.deepEqual(failures,[]);
  const file=results[0].path;
  const blank=await frameColor(file,.16), overlap=await frameColor(file,1), tail=await frameColor(file,1.54);
  assert.ok(Math.max(blank.red,blank.green,blank.blue)<8,'moving the first picture leaves the original slot empty');
  assert.ok(overlap.green>overlap.red*3,'the higher video row covers the lower row');
  assert.ok(tail.red>tail.green*3,'the moved clip outlasts the last shot');
  assert.ok(Math.abs(await toneAt(file,'0.15')-660)<60,'segmented narration stays at its original time');
  assert.equal(await toneAt(file,'0.55'),0);
  assert.ok(Math.abs(await toneAt(file,'1.01')-440)<60,'original sound follows the new picture time');
});

test('timeline tail trims cut source sound and picture at their original rate and keep the shot clock',async(t)=>{
  const {catalog,output}=await fixtureDirectory(t);
  const source=path.join(output,'双段有声.mp4');
  await ffmpeg(['-f','lavfi','-i',"color=blue:s=160x90:r=24:d=1.5,drawbox=color=red:t=fill:enable='lt(t,0.82)'",
    '-f','lavfi','-i','sine=frequency=440:duration=1.5','-c:v','libx264','-threads','1','-c:a','aac',source]);
  catalog.set('color-change',await inspectAsset(source,'video'));
  const clip={id:'color-change',start:.25,end:1.25,speed:2,videoDuration:.375,
    videoSubtitles:{name:'原声字幕',cues:[{start:500,end:1200,text:'源字幕'}]},
    layers:[{kind:'text',text:'候选文字',start:0,end:1}]};
  const config={...montage,count:1,keepAudio:true,musicIds:[],ratio:'16:9',
    shots:[[clip],[{id:'green',start:0,end:.75}]],
    timelineCaptions:{name:'固定字幕',cues:[{start:520,end:700,text:'固定'}]}};
  const [plan]=planMontage(config,catalog);
  assert.equal(plan.duration,1.25);
  assert.equal(plan.videoSubtitles.cues[0].end,375);
  assert.equal(plan.layers[0].end,.375);
  assert.equal(plan.subtitles.cues[0].start,520);
  const {failures,results}=await exportBatch([plan],output);
  assert.deepEqual(failures,[]);
  const rendered=results[0].path;
  const [red,blue,black,green]=await Promise.all([.22,.32,.44,.75].map(t=>frameColor(rendered,t)));
  assert.ok(red.red>red.blue*2 && blue.blue>blue.red*2,'裁去片尾不额外加速');
  assert.ok(Math.max(...Object.values(black))<15 && green.green>green.red*2,'裁切形成留空，下一分镜按原时钟播放');
  assert.ok(Math.abs(await toneAt(rendered,'0.15')-440)<50);
  assert.equal(await toneAt(rendered,'0.40'),0);
  const [moved]=planMontage({...config,shots:[[{...clip,videoStart:1.25}],config.shots[1]]},catalog);
  assert.equal(moved.duration,1.625,'时间线结尾只延长到可见片尾');
  const [sliced]=planMontage({...config,shots:[[{...clip,speed:1,videoDuration:.5,
    ranges:[{start:.25,end:.5},{start:.875,end:1.25}]}],config.shots[1]]},catalog);
  const partial=await exportBatch([sliced],output);
  assert.deepEqual(partial.failures,[]);
  const [secondRange,tail]=await Promise.all([.39,.55].map(t=>frameColor(partial.results[0].path,t)));
  assert.ok(secondRange.blue>secondRange.red*2 && Math.max(...Object.values(tail))<15,'多段源区间合成后，保留第二段开头并只裁一次尾部');
});

test('track controls keep visibility independent of source and picture-in-picture sound',async(t)=>{
  const {catalog,output}=await fixtureDirectory(t);
  const config={...montage,ratio:'16:9',shots:[[{id:'red',start:0,end:.6}]],keepAudio:true,musicIds:[],count:1};
  const [hidden]=planMontage({...config,trackControls:{vis0:{hidden:true}}},catalog);
  const [muted]=planMontage({...config,mutedVideoTracks:[0]},catalog);
  const caption={name:'测试字幕',cues:[{start:0,end:300,text:'轨道字幕'}]};
  const packaged={...config,shots:[[{id:'green',start:0,end:.6,videoSubtitles:caption}]],timelineCaptions:caption,
    narrationId:'music',subtitles:caption,packaging:{composites:[[{kind:'pip',id:'red',scale:1,laneId:'cam',volume:100}]]}};
  const [pipSound]=planMontage({...packaged,trackControls:{'local-subtitles':{hidden:true},'pasted-captions':{hidden:true},
    caption0:{hidden:true}, whole0:{muted:true}, 'layer-pip-cam':{hidden:true}}},catalog);
  const [pipPicture]=planMontage({...packaged,trackControls:{'layer-pip-cam':{muted:true}}},catalog);
  assert.equal(pipSound.subtitles,null);
  assert.equal(pipSound.videoSubtitles,undefined);
  assert.deepEqual(pipSound.layers.map(l=>l.kind),['sound']);
  assert.equal(pipPicture.layers[0].kind,'pip');
  assert.equal(pipPicture.layers[0].volume,0);
  const {results,failures}=await exportBatch([hidden,muted,pipSound],output);
  assert.deepEqual(failures,[]);
  const [black,red,green]=await Promise.all(results.map(r=>frameColor(r.path,.2)));
  assert.ok(Math.max(black.red,black.green,black.blue)<8);
  assert.ok(red.red>3*red.green && green.green>3*green.red);
  const [sound,mute,pip]=await Promise.all(results.map(r=>toneAt(r.path,'0.2')));
  assert.ok(Math.abs(sound-440)<50 && Math.abs(pip-440)<50);
  assert.equal(mute,0);
});

test('track controls choose solo candidates, narration and music by physical row',async(t)=>{
  const {catalog}=await fixtureDirectory(t);
  const config={...montage,count:1,musicIds:['music','otherMusic'],narrationMode:'segmented',
    segmentNarrationIds:[['music','otherMusic'],['music']],trackControls:{vis1:{solo:true},voice1:{solo:true},music1:{solo:true}}};
  for (const selection of ['ordered','random']) {
    const [plan]=planMontage({...config,segmentNarrationSelection:selection},catalog,()=>.99);
    assert.equal(plan.clips[0].asset,catalog.get('blue'));
    assert.equal(plan.clips[0].narration,catalog.get('otherMusic'));
    assert.equal(plan.clips[1].hiddenVideo,true);
    assert.equal(plan.clips[1].voiceGain,0);
    assert.equal(plan.music,catalog.get('otherMusic'));
    assert.throws(()=>planMontage({...config,count:2,segmentNarrationSelection:selection},catalog),/生成数量/);
  }
  const [whole]=planMontage({...config,narrationMode:'whole',narrationId:'music',extraWholeTracks:[{narrationId:'otherMusic'}],
    trackControls:{whole1:{solo:true}}},catalog,()=>0);
  assert.equal(whole.wholeTrack,2);
  assert.equal(whole.narration,catalog.get('otherMusic'));
  assert.equal(whole.musicVolume,0);
});

test('track controls reveal underlying footage during hidden portions of a voice-aligned clip',async(t)=>{
  const {catalog,output}=await fixtureDirectory(t);
  const [plan]=planMontage({...montage,ratio:'16:9',count:1,musicIds:[],priority:'voice',narrationMode:'segmented',
    segmentNarrationIds:[[],['music']],trackControls:{vis0:{hidden:true}},
    shots:[[{id:'green',videoLane:2,start:0,end:.9}],
      [{id:'red',videoStart:0,start:0,end:.17},{id:'blue',start:0,end:.3}]]},catalog,()=>0);
  assert.deepEqual(plan.clips[1].visuals.map(v=>v.asset),[catalog.get('red'),catalog.get('blue')]);
  const {results,failures}=await exportBatch([plan],output);
  assert.deepEqual(failures,[]);
  const first=await frameColor(results[0].path,.04), second=await frameColor(results[0].path,.29);
  assert.ok(first.green>3*first.red && first.green>3*first.blue);
  assert.ok(second.blue>3*second.green);
});

test('the track proxy contains a smaller seekable picture with the original duration, cadence and sound', async (t) => {
  const { catalog, output } = await fixtureDirectory(t);
  const hd = path.join(output, 'hd.mp4'), proxy = path.join(output, 'proxy.mp4');
  await ffmpeg(['-i', catalog.get('red').path, '-vf', 'scale=960:720', '-c:v', 'libx264', '-threads', '2', '-c:a', 'copy', hd]);
  const original = await inspectAsset(hd, 'video');
  await createTrackProxy(original, proxy);
  const result = await inspectAsset(proxy, 'video');
  assert.deepEqual([result.width, result.height, result.fps], [640, 480, original.fps]);
  assert.ok(Math.abs(result.duration - original.duration) <= .04);
  assert.ok(Math.abs(await toneAt(proxy, '0.3') - 440) < 25);
});

test('decodes a bounded JPEG thumbnail from the actual video stream', async (t) => {
  const { catalog, output } = await fixtureDirectory(t);
  const asset = catalog.get('red');
  const bytes = await createVideoThumbnail(asset);
  assert.ok(Buffer.isBuffer(bytes) && bytes.length < 64 * 1024);
  const thumbnail = path.join(output, 'thumbnail.jpg');
  await fs.writeFile(thumbnail, bytes);
  const { width, height, codec } = await inspectAsset(thumbnail, 'image');
  assert.deepEqual([width, height, codec], [240, 180, 'mjpeg']);
  const color = await frameColor(thumbnail, 0);
  assert.ok(color.red > 220 && color.blue < 35);
  assert.equal(await createVideoThumbnail(catalog.get('still')), null);
  assert.equal(await createVideoThumbnail({ ...asset, path: path.join(output, 'missing.mp4') }), null);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(createVideoThumbnail(asset, { signal: controller.signal }), { name: 'AbortError' });
});

test('renders different ordered combinations with trim, portrait framing and looping music', async (t) => {
  const { catalog, output } = await fixtureDirectory(t);
  const plans = planMontage(montage, catalog);
  const updates = [];
  const batch = await exportBatch(plans, output, { onUpdate: (update) => updates.push(update) });
  assert.deepEqual(batch.failures, []);
  assert.equal(batch.results.length, 2);
  assert.equal(batch.cancelled, false);
  assert.ok(updates.some((update) => update.fraction > 0 && update.fraction < 1));

  const [first, second] = batch.results.map((item) => item.path);
  for (const [index, file] of [first, second].entries()) {
    const rendered = await inspectAsset(file, 'video');
    assert.equal(rendered.width, 720);
    assert.equal(rendered.height, 1280);
    assert.equal(rendered.codec, 'h264');
    assert.equal(rendered.fps, 24);
    assert.notEqual(rendered.audioIndex, null);
    assert.ok(Math.abs(rendered.duration - plans[index].duration) < 0.12, `duration ${rendered.duration}`);
    assert.ok((await frameColor(file, 1.0)).green > 85);

    const samples = await ffmpeg(['-ss', '0.9', '-i', file, '-t', '0.15', '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1']);
    assert.ok(samples.length > 0);
    assert.ok(samples.some((_, offset) => offset % 2 === 0 && Math.abs(samples.readInt16LE(offset)) > 150));
  }
  const colors = await Promise.all([frameColor(first, 0.3), frameColor(second, 0.3)]);
  assert.ok(colors.some((color) => color.red > 220 && color.blue < 35));
  assert.ok(colors.some((color) => color.blue > 220 && color.red < 35));
  assert.equal((await fs.readdir(output)).length, 2);
});

test('starts looping music at the selected source shot after shuffle and voice alignment', async (t) => {
  const { catalog, output } = await fixtureDirectory(t);
  const config = {
    ...montage, ratio: '1:1', fps: 30, count: 1, unordered: true,
    shots: [[{ id: 'red', start: 0, end: 0.4, speed: 0.5 }], [{ id: 'green', start: 0, end: 0.6, speed: 2 }], [{ id: 'still', start: 0, end: 0.5 }]],
  };
  assert.throws(() => planMontage({ ...config, musicStartShot: 3 }, catalog), /配乐起始分镜/);
  assert.throws(() => planMontage({ ...config, musicStartShot: 1.5 }, catalog), /配乐起始分镜/);
  assert.equal(planMontage({ ...config, musicStartShot: null }, catalog, () => 0)[0].musicStart, 0);
  const [shuffled] = planMontage({ ...config, musicStartShot: 0 }, catalog, () => 0);
  assert.equal(shuffled.clips.at(-1).asset, catalog.get('red'));
  assert.equal(shuffled.musicStart, 0.8);

  const file = path.join(path.dirname(output), '配乐对齐口播.wav');
  await ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=1100', '-t', '0.9', file]);
  catalog.set('longVoice', await inspectAsset(file, 'audio'));
  const voiceConfig = { ...config, unordered: false, musicStartShot: 1, priority: 'voice', narrationVolume: 0 };
  const [refilled] = planMontage({
    ...voiceConfig, narrationId: 'longVoice',
    shots: [[{ id: 'red', start: 0, end: 0.2, speed: 2 }], [{ id: 'green', start: 0, end: 0.2, speed: 2 }]],
  }, catalog);
  assert.ok(Math.abs(refilled.musicStart - 0.45) < 1 / config.fps);
  const [compressed] = planMontage({
    ...voiceConfig, narrationId: 'music',
    shots: [[{ id: 'red', start: 0, end: 0.6 }], [{ id: 'green', start: 0, end: 0.6 }]],
  }, catalog);
  assert.equal(compressed.musicStart, 0.2);
  const batch = await exportBatch([shuffled, refilled, compressed], output);
  assert.deepEqual(batch.failures, []);
  assert.equal(batch.results.length, 3);
  const [shuffledFile, refilledFile, compressedFile] = batch.results.map((entry) => entry.path);
  assert.equal(await toneAt(shuffledFile, '0.5'), 0);
  assert.ok(Math.abs((await toneAt(shuffledFile, '0.95')) - 660) < 65);
  assert.ok(Math.abs((await toneAt(shuffledFile, '1.35')) - 660) < 65);
  assert.equal(await toneAt(refilledFile, '0.24'), 0);
  assert.ok(Math.abs((await toneAt(refilledFile, '0.61')) - 660) < 65);
  assert.equal(await toneAt(compressedFile, '0.04'), 0);
  assert.ok(Math.abs((await toneAt(compressedFile, '0.26')) - 660) < 65);
});

test('mixes still images and video, honoring the shuffle and background music selection', async (t) => {
  const { catalog, output } = await fixtureDirectory(t);
  const draws = [0, 0, 0, 0.9];
  const plans = planMontage({
    ...montage,
    shots: [[{ id: 'red', start: 0, end: 0.6 }], [{ id: 'still', start: 0, end: 0.5 }]],
    unordered: true, musicIds: ['music', 'otherMusic'], count: 1,
  }, catalog, () => draws.shift());
  assert.equal(plans[0].clips[0].asset.kind, 'image');
  assert.equal(plans[0].music, catalog.get('otherMusic'));
  const batch = await exportBatch(plans, output);
  assert.deepEqual(batch.failures, []);
  const [rendered] = batch.results;
  const stillColor = await frameColor(rendered.path, 0.2);
  const videoColor = await frameColor(rendered.path, 0.8);
  assert.ok(stillColor.red > 220 && stillColor.blue > 220);
  assert.ok(videoColor.red > 220 && videoColor.blue < 35);
  assert.ok(Math.abs((await inspectAsset(rendered.path, 'video')).duration - 1.1) < 0.12);
});

test('renders horizontal mirrors as independent candidate variants', async (t) => {
  const { catalog, output } = await fixtureDirectory(t);
  const asymmetric = path.join(path.dirname(output), '左右颜色.png');
  await ffmpeg([
    '-f', 'lavfi', '-i', 'color=red:s=160x90', '-vf', 'drawbox=x=80:y=0:w=80:h=90:color=blue:t=fill',
    '-frames:v', '1', '-threads', '1', '-update', '1', asymmetric,
  ]);
  catalog.set('asymmetric', await inspectAsset(asymmetric, 'image'));
  const plans = planMontage({
    ...montage, ratio: '16:9', shots: [[{ id: 'asymmetric', start: 0, end: 0.5 }]],
    useMirrors: true, musicIds: [], count: 2,
  }, catalog);
  assert.equal(plans.filter((plan) => plan.clips[0].mirror).length, 1);
  const batch = await exportBatch(plans, output);
  assert.deepEqual(batch.failures, []);
  assert.equal(batch.results.length, 2);
  for (const result of batch.results) {
    const [red, , blue] = await ffmpeg([
      '-i', result.path, '-an', '-frames:v', '1', '-vf', 'crop=4:4:120:200,scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
    ]);
    assert.ok(plans[result.index].clips[0].mirror ? blue > 220 && red < 35 : red > 220 && blue < 35);
  }
});

test('renders colored padding and shot fades on the final retimed timeline', async (t) => {
  const { catalog, output } = await fixtureDirectory(t);
  const config = {
    ...montage, ratio: '1:1', fps: 30, fit: 'fit', count: 1, unordered: true, musicIds: [],
    shots: [[{ id: 'red', start: 0, end: 0.6 }], [{ id: 'green', start: 0, end: 0.2 }], [{ id: 'blue', start: 0, end: 0.4 }]],
    shotTransitions: [
      { kind: 'fade-black', duration: 0.4 }, { kind: 'fade-white', duration: 0.4 }, { kind: 'fade-black', duration: 0.4 },
    ],
    narrationMode: 'segmented', segmentNarrationIds: [[], ['music'], []], priority: 'voice', backgroundColor: '#00FFff',
  };
  assert.throws(() => planMontage({ ...config, shotTransitions: [null] }, catalog), /转场设置/);
  assert.throws(() => planMontage({ ...config, backgroundColor: '#FFF' }, catalog), /背景颜色/);
  const [plan] = planMontage(config, catalog, () => 0);
  assert.deepEqual(plan.clips.map((clip) => clip.transition?.kind ?? null), ['fade-white', 'fade-black', null]);
  assert.deepEqual(plan.clips.map((clip) => clip.outputDuration), [0.4, 0.4, 0.6]);
  const [compressed] = planMontage({ ...config, unordered: false, narrationMode: 'whole', narrationId: 'music' }, catalog);
  const batch = await exportBatch([plan, compressed], output);
  assert.deepEqual(batch.failures, []);
  assert.equal(batch.results.length, 2);
  const [video, shortened] = batch.results.map(({ path: file }) => file);
  assert.ok(Math.abs((await inspectAsset(video, 'video')).duration - 1.4) < 0.035);

  async function pixelAt(file, position, y = 350) {
    const pixels = await ffmpeg([
      '-ss', position, '-i', file, '-an', '-frames:v', '1', '-vf', `crop=4:4:350:${y},scale=1:1`,
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
    ]);
    assert.equal(pixels.length, 3);
    return [...pixels];
  }
  const backdrop = await pixelAt(video, '0.1', 10);
  assert.ok(backdrop[0] < 35 && backdrop[1] > 220 && backdrop[2] > 220, `padding was ${backdrop}`);
  const white = await pixelAt(video, '0.4');
  assert.ok(white.every((channel) => channel > 225), `white dip was ${white}`);
  const black = await pixelAt(video, '0.8');
  assert.ok(black.every((channel) => channel < 30), `black dip was ${black}`);
  const last = await pixelAt(video, '1.3');
  assert.ok(last[0] > 220 && last[1] < 35 && last[2] < 35, `last shot was ${last}`);
  const compressedLast = await pixelAt(shortened, '0.35');
  assert.ok(compressedLast[0] < 35 && compressedLast[1] < 35 && compressedLast[2] > 220, `compressed last shot was ${compressedLast}`);
});

test('aligns whole narration with the chosen voice or picture priority', async (t) => {
  const { catalog, output } = await fixtureDirectory(t);
  const file = path.join(path.dirname(output), '长口播.wav');
  await ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=950', '-t', '2.4', file]);
  catalog.set('longNarration', await inspectAsset(file, 'audio'));
  const config = {
    ...montage, ratio: '1:1', shots: [[{ id: 'red', start: 0, end: 0.7 }], [{ id: 'green', start: 0, end: 0.8 }]],
    musicIds: [], count: 1,
  };
  const cases = [
    { priority: 'voice', narrationId: 'music', expected: 0.4 },
    { priority: 'voice', narrationId: 'longNarration', keepAudio: true, expected: 2.4 },
    { priority: 'picture', narrationId: 'music', expected: 1.5 },
    { priority: 'picture', narrationId: 'longNarration', expected: 1.5 },
  ];
  const plans = cases.map(({ expected, ...options }) => {
    const [plan] = planMontage({ ...config, ...options }, catalog);
    assert.equal(plan.duration, expected);
    assert.strictEqual(plan.narration, catalog.get(options.narrationId));
    return plan;
  });
  const batch = await exportBatch(plans, output);
  assert.deepEqual(batch.failures, []);
  assert.equal(batch.results.length, cases.length);

  for (const [index, item] of batch.results.entries()) {
    const rendered = await inspectAsset(item.path, 'video');
    assert.ok(Math.abs(rendered.duration - cases[index].expected) < 0.06, `duration ${rendered.duration}`);
    assert.equal(rendered.fps, config.fps);
  }
  const [compressed, refilled, shortVoice, croppedVoice] = batch.results.map((item) => item.path);
  assert.ok((await frameColor(compressed, 0.09)).red > 220);
  assert.ok((await frameColor(compressed, 0.25)).green > 85);
  assert.ok((await frameColor(refilled, 0.9)).red > 220);
  assert.ok((await frameColor(refilled, 2.2)).green > 85);
  assert.ok((await frameColor(croppedVoice, 0.9)).green > 85);

  async function hasAudioAt(file, position) {
    const samples = await ffmpeg(['-ss', position, '-i', file, '-t', '0.1', '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1']);
    assert.ok(samples.length >= 800);
    return samples.some((_, offset) => offset % 2 === 0 && Math.abs(samples.readInt16LE(offset)) > 150);
  }
  assert.equal(await hasAudioAt(compressed, '0.2'), true);
  assert.equal(await hasAudioAt(refilled, '2.2'), true);
  assert.equal(await hasAudioAt(shortVoice, '0.2'), true);
  assert.equal(await hasAudioAt(shortVoice, '0.9'), false);
  assert.equal(await hasAudioAt(croppedVoice, '1.3'), true);
});

test('fills short pictures from the same shot and uniformly accelerates full visuals under voice priority', async (t) => {
  const { catalog, output } = await fixtureDirectory(t);
  const parent = path.dirname(output);
  const narration = path.join(parent, '补画面口播.wav');
  const repeatNarration = path.join(parent, '重复画面口播.wav');
  const change = path.join(parent, '尾部变色.mp4');
  await Promise.all([
    ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000:duration=0.6', narration]),
    ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000:duration=1.2', repeatNarration]),
    ffmpeg([
      '-f', 'lavfi', '-i', 'color=red:s=320x240:r=30:d=0.4',
      '-f', 'lavfi', '-i', 'color=green:s=320x240:r=30:d=0.4',
      '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0', '-c:v', 'libx264', '-threads', '2', change,
    ]),
  ]);
  catalog.set('fillNarration', await inspectAsset(narration, 'audio'));
  catalog.set('repeatNarration', await inspectAsset(repeatNarration, 'audio'));
  catalog.set('changing', await inspectAsset(change, 'video'));
  const config = { ...montage, ratio: '1:1', fps: 30, count: 1, musicIds: [], priority: 'voice' };
  const candidates = [{ id: 'red', start: 0, end: 0.4 }, { id: 'blue', start: 0, end: 0.4 }];
  const changing = { id: 'changing', start: 0, end: 0.8 };
  const cases = [
    { shots: [candidates], narrationId: 'fillNarration' },
    { shots: [candidates, [{ id: 'green', start: 0, end: 0.5 }]], narrationMode: 'segmented', segmentNarrationIds: [['fillNarration'], []] },
    { shots: [[changing]], narrationId: 'music' },
    { shots: [[changing]], narrationId: 'music', priority: 'picture' },
    { shots: [[changing]], narrationId: 'repeatNarration' },
  ];
  const plans = cases.map((options) => planMontage({ ...config, ...options }, catalog, () => 0)[0]);
  const batch = await exportBatch(plans, output);
  assert.deepEqual(batch.failures, []);
  const [whole, segmented, compressed, picture, repeated] = batch.results.map(({ path: file }) => file);
  for (const [file, seconds] of [[whole, 0.6], [segmented, 1.1], [compressed, 0.4], [picture, 0.8], [repeated, 1.2]]) {
    assert.ok(Math.abs((await inspectAsset(file, 'video')).duration - seconds) < 0.04);
  }
  for (const file of [whole, segmented]) {
    assert.ok((await frameColor(file, 0.1)).red > 220);
    assert.ok((await frameColor(file, 0.34)).blue > 220, '应完整补入同组候选并整体加速，提前进入蓝色候选');
    assert.ok((await frameColor(file, 0.53)).blue > 220);
    assert.ok(Math.abs(await toneAt(file, '0.45') - 660) < 65, '补画面时口播继续按原速播放');
  }
  assert.ok((await frameColor(segmented, 0.8)).green > 85, '下一分镜的画面不能借到上一分镜');
  assert.ok((await frameColor(compressed, 0.1)).red > 220);
  assert.ok((await frameColor(compressed, 0.31)).green > 85, '较长素材应保留变色后的尾部');
  assert.ok(Math.abs(await toneAt(compressed, '0.26') - 660) < 65);
  assert.ok((await frameColor(picture, 0.31)).red > 220, '画面优先仍按原来的素材速度播放');
  assert.ok((await frameColor(picture, 0.66)).green > 85);
  assert.equal(await toneAt(picture, '0.55'), 0);
  assert.ok((await frameColor(repeated, 0.43)).green > 85);
  assert.ok((await frameColor(repeated, 0.72)).red > 220, '没有其他候选时应从头复用当前分镜的选定素材');
  assert.ok((await frameColor(repeated, 1.03)).green > 85);
});

test('exports reordered cut ranges, smart trims and both reference narration length rules', async (t) => {
  const { catalog, output } = await fixtureDirectory(t);
  const media = path.join(path.dirname(output), '红绿.mp4');
  await ffmpeg(['-f', 'lavfi', '-i', 'color=red:s=160x90:r=30:d=0.4',
    '-f', 'lavfi', '-i', 'color=green:s=160x90:r=30:d=0.4',
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0', '-c:v', 'libx264', '-threads', '2', media]);
  catalog.set('source', await inspectAsset(media, 'video'));
  const clip = { id: 'source', start: 0, end: 0.8 };
  const config = { ...montage, shots: [[clip]], count: 1, musicIds: [], ratio: '16:9', fps: 30 };
  const plan = (additional) => planMontage({ ...config, ...additional }, catalog, () => 0.75)[0];
  const reordered = plan({ shots: [[{ ...clip, ranges: [{ start: 0.55, end: 0.8 }, { start: 0, end: 0.15 }] }]] });
  const smart = plan({ shotSettings: [{ duration: 0.2, smartTrim: true }] });
  const fixed = plan({ shotSettings: [{ duration: 0.2 }] });
  const reference = { narrationId: 'music', priority: 'voice', voiceAlignment: 'reference' };
  const long = plan(reference);
  const short = plan({ ...reference, shots: [[{ ...clip, start: 0.3, end: 0.5 }]] });
  assert.equal(reordered.clips[0].visuals.length, 2);
  assert.ok(Math.abs(short.clips[0].visuals[0].speed - 0.5) < 1e-6);
  assert.equal(short.clips[0].visuals[0].repeat, undefined);
  const batch = await exportBatch([reordered, smart, fixed, long, short], output);
  assert.deepEqual(batch.failures, []);
  const [joined, random, beginning, cropped, stretched] = batch.results.map((result) => result.path);
  assert.ok((await frameColor(joined, 0.1)).green > 85);
  assert.ok((await frameColor(joined, 0.32)).red > 220);
  assert.ok((await frameColor(random, 0.05)).green > 85);
  assert.ok((await frameColor(beginning, 0.05)).red > 220);
  assert.ok((await frameColor(cropped, 0.30)).red > 220);
  assert.ok((await frameColor(stretched, 0.08)).red > 220);
  assert.ok((await frameColor(stretched, 0.31)).green > 85);
  assert.ok(Math.abs(await toneAt(stretched, '0.22') - 660) < 65);
});

test('exports adjusted narration, looped music and sound effects at the edited speed', async t => {
  const {catalog,output}=await fixtureDirectory(t);
  const file=path.join(path.dirname(output),'倍速双音.wav');
  await ffmpeg(['-f','lavfi','-i','sine=frequency=440:duration=0.8','-f','lavfi','-i','sine=frequency=880:duration=0.8',
    '-filter_complex','[0:a][1:a]concat=n=2:v=0:a=1',file]);
  catalog.set('tone',await inspectAsset(file,'audio'));
  const config={...montage,shots:[[{id:'still',start:0,end:2.4}]],count:1,musicIds:[],priority:'voice'};
  const captions={name:'双音',cues:[{start:800,end:1600,text:'高音'}]};
  const pasted={name:'时间轴',cues:[{start:50,end:100,text:'复制的字幕'}]};
  const whole=planMontage({...config,narrationId:'tone',narrationSpeed:2,subtitles:captions,timelineCaptions:pasted},catalog)[0];
  assert.equal(whole.duration,.8);
  assert.deepEqual(whole.subtitles.cues,[...pasted.cues,{start:400,end:800,text:'高音'}]);
  const segmented=planMontage({...config,narrationMode:'segmented',segmentNarrationIds:[['tone']],
    segmentVoiceCuts:[[{ranges:[{start:.8,end:1.6},{start:0,end:.8}],speed:2,offset:.2}]],generatedCaptions:{tone:captions}},catalog)[0];
  assert.equal(segmented.duration,1);
  assert.deepEqual(segmented.subtitles.cues,[{start:200,end:600,text:'高音'}]);
  const bgm=planMontage({...config,musicIds:['tone'],musicSpeeds:[2]},catalog)[0];
  const fx=planMontage({...config,packaging:{global:[{kind:'sound',id:'tone',speed:.5,start:.2,mediaOffset:.4}]}},catalog)[0];
  assert.equal(fx.layers[0].tempo,.5);
  const batch=await exportBatch([whole,segmented,bgm,fx],output);
  assert.deepEqual(batch.failures,[]);
  for(const [i,probes] of [[[.1,440],[.5,880]],[[.02,0],[.3,880],[.75,440]],
    [[.1,440],[.5,880],[.94,440]],[[.02,0],[.5,440],[1.2,880]]].entries()) {
    for(const [at,hz] of probes) {
      const measured=await toneAt(batch.results[i].path,String(at));
      assert.ok(Math.abs(measured-hz)<65,`第 ${i+1} 条成片在 ${at} 秒应为 ${hz} Hz，实际为 ${measured} Hz`);
    }
  }
});

test('renders per-row narration cuts in edit order and remaps the original SRT timestamps', async (t) => {
  const { catalog, output } = await fixtureDirectory(t);
  const voice = path.join(path.dirname(output), '三段语音.wav');
  await ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.2',
    '-f', 'lavfi', '-i', 'sine=frequency=660:duration=0.2',
    '-f', 'lavfi', '-i', 'sine=frequency=880:duration=0.2',
    '-filter_complex', '[0:a][1:a][2:a]concat=n=3:v=0:a=1', voice]);
  catalog.set('speech', await inspectAsset(voice, 'audio'));
  const ranges = [{ start: 0.4, end: 0.6 }, { start: 0, end: 0.2 }];
  const config = { ...montage, count: 1, shots: [[{ id: 'red', start: 0, end: 0.3 }]], musicIds: [],
    priority: 'voice', narrationMode: 'segmented', segmentNarrationIds: [['speech']],
    segmentVoiceCuts: [[{ ranges }]], generatedCaptions: { speech: { name: '原始字幕', cues: [
      { start: 0, end: 200, text: '一' }, { start: 200, end: 400, text: '二' }, { start: 400, end: 600, text: '三' },
    ] } } };
  const voicePlan = planMontage(config, catalog)[0];
  assert.deepEqual(voicePlan.subtitles.cues, [{ start: 0, end: 200, text: '三' }, { start: 200, end: 400, text: '一' }]);
  assert.equal(voicePlan.duration, 0.4);
  const picture = planMontage({ ...config, priority: 'picture' }, catalog)[0];
  assert.deepEqual(picture.subtitles.cues.at(-1), { start: 200, end: 300, text: '一' });
  const delayed = planMontage({ ...config, segmentVoiceCuts: [[{ ranges, offset: 0.2 }]] }, catalog)[0];
  assert.equal(delayed.duration, 0.6);
  assert.deepEqual(delayed.subtitles.cues, [{ start: 200, end: 400, text: '三' }, { start: 400, end: 600, text: '一' }]);
  const batch = await exportBatch([voicePlan, picture, delayed], output);
  assert.deepEqual(batch.failures, []);
  for (const { path: file } of batch.results.slice(0, 2)) {
    assert.ok(Math.abs(await toneAt(file, '0.05') - 880) < 65);
    const secondTone = await toneAt(file, '0.20');
    assert.ok(Math.abs(secondTone - 440) < 65, `第二个保留区间应该是 440 Hz，实测 ${secondTone} Hz`);
  }
  const last = batch.results[2].path;
  assert.equal(await toneAt(last, '0.025'), 0);
  assert.ok(Math.abs(await toneAt(last, '0.24') - 880) < 65);
});

test('publishes selected MP4 cover artwork, pins first shot and inserts a real random intro', async (t) => {
  const { catalog, output } = await fixtureDirectory(t);
  const config = { ...montage, shots: [[{id:'red',start:0,end:0.5},{id:'green',start:0,end:0.5}],[{id:'red',start:0,end:0.4}]],
    count:1, fps:30, musicIds:[], unordered:true };
  const source = (cover) => planMontage({...config,cover},catalog,()=>0.75)[0];
  const library = source({mode:'library',items:[{id:'blue',time:0.8,title:'佳剪',style:'accent'}],active:0});
  const first = source({mode:'first-shot',items:[],active:0});
  assert.equal(first.clips[0].shotIndex,0);
  assert.throws(()=>planMontage({...config,count:2,cover:{mode:'first-shot',items:[]}},catalog),/生成数量/);
  const random = source({mode:'random',items:[],active:0});
  assert.equal(random.cover.frames,10);
  assert.ok(Math.abs(random.duration-random.contentDuration-10/30)<1e-7);
  const batch=await exportBatch([library,first,random],output);
  assert.deepEqual(batch.failures,[]);
  const {promisify}=require('node:util');
  const probe=promisify(require('node:child_process').execFile);
  for (const {path:file} of batch.results) {
    const {stdout}=await probe(process.env.SUPERDIR_REPLICA_FFPROBE||'ffprobe',['-v','error','-show_streams','-of','json',file]);
    assert.equal(JSON.parse(stdout).streams.filter((s)=>s.disposition.attached_pic===1 && s.codec_name==='mjpeg').length,1);
  }
  const picture=await ffmpeg(['-i',batch.results[0].path,'-map','0:v:1','-frames:v','1','-vf','scale=1:1','-pix_fmt','rgb24','-f','rawvideo','pipe:1']);
  assert.ok(picture[2]>picture[0]+65,'MP4 中独立的封面图像来自蓝色选帧');
  assert.ok((await frameColor(batch.results[1].path,0.2)).green>85);
  assert.ok(Math.abs((await inspectAsset(batch.results[2].path,'video')).duration-random.duration)<.05);
});

test('renders selective color, timed effects, CUBE overlays and custom backgrounds after trimming', async(t)=>{
  const {catalog,output}=await fixtureDirectory(t);
  const {inspectLut,previewLook}=require('../src/visual-style.cjs');
  const file=path.join(output,"本地风格's.cube");
  await fs.writeFile(file,'LUT_3D_SIZE 2\n1 1 1\n0 1 1\n1 0 1\n0 0 1\n1 1 0\n0 1 0\n1 0 0\n0 0 0\n');
  catalog.set('inverse',await inspectLut(file));
  const config={...montage,count:1,musicIds:[],fps:30,ratio:'16:9',fit:'fill'};
  const render=(look,id='red',options={})=>planMontage({...config,shots:[[{id,start:0,end:1,look}]],...options},catalog,()=>0)[0];
  const timed=render({effects:[{kind:'negative',start:.3,end:.7,strength:100}],head:.1,tail:.1});
  assert.equal(timed.clips[0].start,.1);
  assert.ok(Math.abs(timed.duration-.8)<1e-7);
  const background=render({background:{kind:'media',ids:['still','green']}},'blue');
  assert.equal(background.clips[0].look.backgroundAsset.kind,'image');
  const pip=render({},'green',{packaging:{composites:[[{kind:'pip',id:'red',scale:1,start:0,end:1,look:{lut:'inverse'}}]]}});
  const batch=await exportBatch([timed,render({hsl:{red:{h:120}}}),render({filter:'mono'}),background,pip],output);
  assert.deepEqual(batch.failures,[]);
  const red=await frameColor(batch.results[0].path,.05),cyan=await frameColor(batch.results[0].path,.4);
  assert.ok(red.red>200&&red.green<30&&cyan.green>180&&cyan.blue>180&&cyan.red<30,JSON.stringify({red,cyan}));
  const shifted=await frameColor(batch.results[1].path,.2),grey=await frameColor(batch.results[2].path,.2);
  assert.ok(shifted.green>180&&shifted.red<50,JSON.stringify(shifted));
  assert.ok(Math.abs(grey.red-grey.green)<5&&Math.abs(grey.red-grey.blue)<5,JSON.stringify(grey));
  const sample=(i,x,y)=>ffmpeg(['-ss','0.25','-i',batch.results[i].path,'-frames:v','1','-vf',`crop=2:2:${x}:${y},scale=1:1`,'-pix_fmt','rgb24','-f','rawvideo','pipe:1']);
  const [edge,center,overlay]=await Promise.all([sample(3,12,100),sample(3,640,360),sample(4,640,360)]);
  assert.ok(edge[0]>220&&edge[2]>220&&center[0]<35&&center[2]>180);
  assert.ok(overlay[0]<30&&overlay[1]>190&&overlay[2]>190,JSON.stringify([...overlay]));
  const still=async(look)=>previewLook(process.env.SUPERDIR_REPLICA_FFMPEG||'ffmpeg',catalog.get('blue'),look,catalog,.1,'16:9');
  for(const kind of ['blur','sharpen','grain','vignette','chromatic','negative'])assert.ok((await still({effects:[{kind,start:0,end:1,strength:65}]})).length>300,kind);
  for(const bg of [{kind:'blur',strength:50},{kind:'color',color:'#abcdef'},{kind:'pattern',pattern:'gradient'},{kind:'pattern',pattern:'dots'},{kind:'media',ids:['green']}])assert.ok((await still({background:bg})).length>300,bg.kind);
});

test('applies independent track gains to music, voice slots, video sound and effects',async(t)=>{
  const {catalog,output}=await fixtureDirectory(t);
  const config={...montage,count:1,musicIds:[],keepAudio:false,priority:'picture',shots:[[{id:'red',start:0,end:.35}],[{id:'red',start:0,end:.35}]]};
  const [segmented]=planMontage({...config,narrationMode:'segmented',segmentNarrationIds:[['music'],['music']],volumeOverrides:[{kind:'segment',id:'music',shot:0,track:0,value:0}]},catalog);
  const [whole]=planMontage({...config,narrationId:'otherMusic',volumeOverrides:[{kind:'whole',id:'otherMusic',track:0,value:0}]},catalog);
  const [music]=planMontage({...config,musicIds:['music'],volumeOverrides:[{kind:'music',id:'music',value:0}]},catalog);
  const [fx]=planMontage({...config,keepAudio:true,shots:[[{id:'red',start:0,end:.35,volume:0,layers:[{kind:'sound',id:'music',volume:0}]}],[{id:'red',start:0,end:.35,volume:100}]]},catalog);
  const batch=await exportBatch([segmented,whole,music,fx],output);assert.deepEqual(batch.failures,[]);
  const peak=(i,s)=>toneAt(batch.results[i].path,s);
  assert.equal(await peak(0,'0.05'),0);assert.ok(await peak(0,'0.45')>550);
  assert.equal(await peak(1,'0.05'),0);assert.equal(await peak(2,'0.1'),0);
  assert.equal(await peak(3,'0.05'),0);assert.ok(await peak(3,'0.45')>350);
});

test('cuts only adjacent narration edge silence and keeps speech, internal pauses and captions at their original tempo', async (t) => {
  const { catalog, output } = await fixtureDirectory(t);
  async function addNarration(id, parts) {
    const file = path.join(path.dirname(output), `${id}.wav`);
    const inputs = parts.flatMap(([length, frequency]) => ['-f', 'lavfi', '-i', frequency
      ? `sine=frequency=${frequency}:sample_rate=48000:duration=${length}` : `anullsrc=r=48000:cl=mono:d=${length}`]);
    const labels = parts.map((_, index) => `[${index}:a]`).join('');
    await ffmpeg([...inputs, '-filter_complex', `${labels}concat=n=${parts.length}:v=0:a=1`, '-c:a', 'pcm_s16le', file]);
    catalog.set(id, await inspectAsset(file, 'audio'));
  }
  await addNarration('left', [[0.16], [0.25, 440], [0.2], [0.25, 550], [0.3]]);
  await addNarration('right', [[0.25], [0.45, 880], [0.2]]);
  const config = {
    ...montage, ratio: '1:1', fps: 30, count: 1, musicIds: [], narrationMode: 'segmented',
    shots: [[{ id: 'red', start: 0, end: 1.16 }, { id: 'blue', start: 0, end: 1.16 }], [{ id: 'green', start: 0, end: 0.9 }]],
    segmentNarrationIds: [['left'], ['right']],
    generatedCaptions: {
      left: { name: '第一段', cues: [{ start: 160, end: 410, text: '开场' }, { start: 610, end: 860, text: '继续' }] },
      right: { name: '第二段', cues: [{ start: 250, end: 700, text: '结束' }] },
    },
  };
  const random = () => 0.75;
  const [voice] = await prepareMontagePlans({ ...config, priority: 'voice' }, catalog, { random });
  const [picture] = await prepareMontagePlans({ ...config, priority: 'picture' }, catalog, { random });
  assert.deepEqual(voice.clips.map(({ asset }) => asset), [catalog.get('blue'), catalog.get('green')], '静音分析应保留原来抽到的素材');
  for (const [index, [leading, trailing]] of [[0.16, 0.3], [0.25, 0.2]].entries()) {
    const { edgeSilence } = voice.clips[index].narration;
    assert.ok(Math.abs(edgeSilence.leading - leading) < 0.02 && Math.abs(edgeSilence.trailing - trailing) < 0.02, JSON.stringify(edgeSilence));
  }
  assert.ok([...catalog.values()].every((asset) => asset.edgeSilence === undefined), '预览分析不能修改项目原始素材');
  assert.ok(Math.abs(voice.duration - 1.56) < 0.005, `缩短后的成片长度 ${voice.duration}`);
  assert.deepEqual(voice.subtitles.cues.slice(0, 2), config.generatedCaptions.left.cues);
  assert.ok(Math.abs(voice.subtitles.cues[2].start - 910) <= 2, '后段字幕应跟随精确剪去的开头静音');
  assert.equal(voice.subtitles.cues[2].end - voice.subtitles.cues[2].start, 450, '口播字幕的发声跨度不能因对齐而拉伸');
  assert.ok(picture.subtitles.cues[2].start > 1400, '画面优先应保留原口播停顿');
  const [separated] = await prepareMontagePlans({
    ...config, priority: 'voice', shots: [config.shots[0], [{ id: 'still', start: 0, end: 0.3 }], config.shots[1]],
    segmentNarrationIds: [['left'], [], ['right']],
  }, catalog, { random });
  assert.ok(Math.abs(separated.duration - 2.36) < 0.005 && separated.clips[2].narrationStart === 0, '有无口播分镜隔开时不裁两侧静音');
  const batch = await exportBatch([voice, picture], output);
  assert.deepEqual(batch.failures, []);
  const [voiceFile, pictureFile] = batch.results.map(({ path: file }) => file);
  for (const [position, frequency] of [['0.03', 0], ['0.22', 440], ['0.45', 0], ['0.68', 550], ['1.02', 880], ['1.44', 0]]) {
    const tone = await toneAt(voiceFile, position);
    assert.ok(frequency ? Math.abs(tone - frequency) < 65 : tone === 0, `口播优先 ${position} 秒频率 ${tone}`);
  }
  assert.equal(await toneAt(pictureFile, '1.02'), 0);
  assert.ok(Math.abs(await toneAt(pictureFile, '1.52') - 880) < 65);
});

test('exports enabled picture candidates and mutes original audio only in the selected video lane', async (t) => {
  const { catalog, output } = await fixtureDirectory(t);
  const red = { id: 'red', start: 0, end: .5, volume: 80 };
  const config = { ...montage, count: 1, keepAudio: true, musicIds: [], mutedVideoTracks: [1],
    shots: [[{ id: 'blue', start: 0, end: .5, enabled: false }, red], [red]] };
  const batch = await exportBatch(planMontage(config, catalog), output);
  assert.deepEqual(batch.failures, []);
  const file = batch.results[0].path;
  assert.ok((await frameColor(file, .2)).red > 220);
  assert.equal(await toneAt(file, '0.2'), 0);
  assert.ok(Math.abs(await toneAt(file, '0.7') - 440) < 25);
});

test('applies candidate original volume and narration gain to rendered audio', async (t) => {
  const { catalog, output } = await fixtureDirectory(t);
  const clip = { id: 'red', start: 0, end: 0.4 };
  const config = { ...montage, ratio: '1:1', count: 1, shots: [[clip]], musicIds: [] };
  assert.throws(() => planMontage({ ...config, shots: [[{ ...clip, volume: -1 }]] }, catalog), /原声音量/);
  assert.throws(() => planMontage({ ...config, narrationVolume: '20' }, catalog), /口播音量/);
  const configs = [
    { ...config, keepAudio: true, shots: [[clip], [{ ...clip, volume: 25 }], [{ ...clip, volume: 0 }]] },
    { ...config, narrationId: 'music' },
    { ...config, narrationId: 'music', narrationVolume: 20 },
    { ...config, narrationMode: 'segmented', segmentNarrationIds: [['music']], narrationVolume: 20 },
  ];
  const batch = await exportBatch(configs.flatMap((options) => planMontage(options, catalog)), output);
  assert.deepEqual(batch.failures, []);
  assert.equal(batch.results.length, 4);

  async function peak(media, position) {
    const pcm = await ffmpeg(['-ss', position, '-i', media, '-t', '0.08', '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1']);
    assert.ok(pcm.length >= 1000);
    let max = 0;
    for (let offset = 0; offset < pcm.length; offset += 2) max = Math.max(max, Math.abs(pcm.readInt16LE(offset)));
    return max;
  }
  const [originals, fullVoice, quietVoice, quietSegment] = batch.results.map((result) => result.path);
  const originalPeak = await peak(originals, '0.12');
  assert.ok(originalPeak > 1000);
  assert.ok(Math.abs((await peak(originals, '0.52')) / originalPeak - 0.25) < 0.05);
  assert.ok(await peak(originals, '0.95') < 10);
  const voicePeak = await peak(fullVoice, '0.12');
  assert.ok(voicePeak > 1000);
  for (const file of [quietVoice, quietSegment]) {
    assert.ok(Math.abs((await peak(file, '0.12')) / voicePeak - 0.2) < 0.05);
  }
});

test('retimes source trims and preserves audio pitch through speed and narration changes', async (t) => {
  const { catalog, output } = await fixtureDirectory(t);
  const greenAudio = path.join(path.dirname(output), '绿色原声.mp4');
  await ffmpeg([
    '-f', 'lavfi', '-i', 'color=green:s=320x240:r=30', '-f', 'lavfi', '-i', 'sine=frequency=880',
    '-t', '1.2', '-c:v', 'libx264', '-c:a', 'aac', '-threads', '2', greenAudio,
  ]);
  catalog.set('greenAudio', await inspectAsset(greenAudio, 'video'));
  const slow = { id: 'red', start: 0.2, end: 0.6, speed: 0.5 };
  const fast = { id: 'greenAudio', start: 0.1, end: 0.9, speed: 2 };
  const transition = { kind: 'fade-black', duration: 0.2 };
  const config = { ...montage, ratio: '1:1', fps: 30, count: 1, shots: [[slow], [fast]], musicIds: [], keepAudio: true, shotTransitions: [transition, null] };
  assert.throws(() => planMontage({ ...config, shots: [[{ ...slow, speed: 0.49 }], [fast]] }, catalog), /播放速度/);
  const [picture] = planMontage({
    ...config, shots: [...config.shots, [{ id: 'still', start: 0, end: 0.3, speed: 3 }]], shotTransitions: [transition, null, null],
  }, catalog);
  assert.ok(Math.abs(picture.clips[0].sourceDuration - 0.4) < 1e-6);
  assert.deepEqual(picture.clips.map((clip) => clip.outputDuration), [0.8, 0.4, 0.3]);
  const [segmented] = planMontage({
    ...config, shots: [[slow], [{ ...fast, end: 0.5 }]], keepAudio: false,
    narrationMode: 'segmented', segmentNarrationIds: [['music'], ['music']], priority: 'voice',
  }, catalog);
  assert.deepEqual(segmented.clips.map((clip) => clip.outputDuration), [0.4, 0.4]);
  const [whole] = planMontage({
    ...config, shots: [[{ ...slow, end: 0.4, speed: 2 }], [{ ...fast, end: 0.3 }]], keepAudio: false,
    narrationId: 'music', priority: 'voice',
  }, catalog);
  assert.deepEqual(whole.clips.map((clip) => clip.outputDuration), [0.2, 0.2]);
  const batch = await exportBatch([picture, segmented, whole], output);
  assert.deepEqual(batch.failures, []);
  const [pictureFile, segmentedFile, wholeFile] = batch.results.map((entry) => entry.path);
  for (const [file, expected] of [[pictureFile, 1.5], [segmentedFile, 0.8], [wholeFile, 0.4]]) {
    assert.ok(Math.abs((await inspectAsset(file, 'video')).duration - expected) < 0.035);
  }
  assert.ok((await frameColor(pictureFile, 0.6)).red > 220);
  assert.ok(Object.values(await frameColor(pictureFile, 0.8)).every((color) => color < 30));
  assert.ok((await frameColor(pictureFile, 1.0)).green > 85);
  const still = await frameColor(pictureFile, 1.3);
  assert.ok(still.red > 220 && still.blue > 220);
  assert.ok(Object.values(await frameColor(wholeFile, 0.2)).every((color) => color < 30));
  assert.ok(Math.abs((await toneAt(pictureFile, '0.55')) - 440) < 60);
  assert.ok(Math.abs((await toneAt(pictureFile, '0.95')) - 880) < 60);
  assert.ok(Math.abs((await toneAt(segmentedFile, '0.62')) - 660) < 60);
  assert.ok(Math.abs((await toneAt(wholeFile, '0.22')) - 660) < 60);
});

test('draws whole narration and subtitles together, including empty tracks', () => {
  const catalog = new Map([
    ['red', { name: 'Red', kind: 'video', duration: 1.5 }],
    ['blue', { name: 'Blue', kind: 'video', duration: 1.5 }],
    ['short', { name: 'Short', kind: 'audio', duration: 0.4 }],
    ['long', { name: 'Long', kind: 'audio', duration: 1.3 }],
  ]);
  const subtitles = (name) => ({ name, cues: [{ start: 0, end: 100, text: name }] });
  const config = {
    ...montage, shots: [[{ id: 'red', start: 0, end: 1 }, { id: 'blue', start: 0, end: 1 }]],
    musicIds: [], narrationId: 'short', subtitles: subtitles('主轨.srt'), priority: 'voice', count: 8,
    extraWholeTracks: [
      { narrationId: 'long', subtitles: subtitles('长口播.srt') },
      { narrationId: null, subtitles: null },
      { narrationId: null, subtitles: subtitles('仅字幕.srt') },
    ],
  };
  const plans = planMontage(config, catalog, () => 0);
  const expected = [
    ['Short', '主轨.srt', 0.4], ['Long', '长口播.srt', 1.3],
    [null, null, 1], [null, '仅字幕.srt', 1],
  ];
  assert.equal(new Set(plans.map((plan) => `${plan.clips[0].asset.name}:${plan.wholeTrack}`)).size, 8);
  for (const plan of plans) {
    assert.deepEqual([plan.narration?.name ?? null, plan.subtitles?.name ?? null, plan.duration], expected[plan.wholeTrack - 1]);
  }
  assert.throws(() => planMontage({ ...config, count: 9 }, catalog), /生成数量/);
  assert.throws(() => planMontage({ ...config, extraWholeTracks: Array(maxWholeTracks).fill(config.extraWholeTracks[0]) }, catalog), /最多可设置 250/);
  const segmented = planMontage({ ...config, count: 2, narrationMode: 'segmented', extraWholeTracks: [null] }, catalog, () => 0);
  assert.ok(segmented.every((plan) => !plan.narration && !plan.subtitles && plan.wholeTrack === undefined));
});

test('uses the selected whole voice transcript up to the final cut and honors imported subtitles', () => {
  const catalog = new Map([
    ['red', { name: 'Red', kind: 'video', duration: 1.5 }],
    ['first', { name: 'First', kind: 'audio', duration: 0.8 }],
    ['second', { name: 'Second', kind: 'audio', duration: 0.4 }],
  ]);
  const imported = { name: '手动字幕.srt', cues: [{ start: 100, end: 200, text: '手动字幕' }] };
  const config = {
    ...montage, shots: [[{ id: 'red', start: 0, end: 0.6 }]], musicIds: [], count: 2,
    narrationId: 'first', narrationVolume: 0,
    extraWholeTracks: [{ narrationId: 'second', subtitles: imported }],
    generatedCaptions: { first: '第一行\r\n\r\n第二行', second: '只保留手动字幕' },
  };
  const [first, second] = planMontage(config, catalog, () => 0);
  assert.deepEqual(first.subtitles?.cues, [{ start: 0, end: 600, text: '第一行\n第二行' }]);
  assert.deepEqual(second.subtitles, imported);
  const [withLongerVoice] = planMontage({ ...config, count: 1, priority: 'voice' }, catalog, () => 0);
  assert.equal(withLongerVoice.subtitles?.cues[0].end, 800);
  const timed = { name: '配音字幕', cues: [
    { start: 40, end: 200, text: '第一句' },
    { start: 540, end: 750, text: '裁切到片尾' },
    { start: 750, end: 950, text: '画面优先时隐藏' },
    { start: 820, end: 900, text: '音频之外隐藏' },
  ] };
  const timedConfig = { ...config, generatedCaptions: { first: timed, second: timed } };
  const [timedFirst, timedSecond] = planMontage(timedConfig, catalog, () => 0);
  assert.deepEqual(timedFirst.subtitles, { ...timed, cues: [timed.cues[0], { ...timed.cues[1], end: 600 }] });
  assert.deepEqual(timedSecond.subtitles, imported);
  const [timedLongVoice] = planMontage({ ...timedConfig, count: 1, priority: 'voice' }, catalog, () => 0);
  assert.deepEqual(timedLongVoice.subtitles?.cues, [...timed.cues.slice(0, 2), { ...timed.cues[2], end: 800 }]);
  assert.throws(() => planMontage({ ...config, generatedCaptions: { red: '无效' } }, catalog), /对应工程中的口播音频/);
  assert.throws(() => planMontage({ ...config, generatedCaptions: { first: '字'.repeat(501) } }, catalog), /500 字/);
  assert.throws(() => planMontage({ ...config, generatedCaptions: {
    first: { ...timed, cues: [{ start: 2, end: 2, text: '无效' }] },
  } }, catalog), /起止时间无效/);
});

test('builds horizontal ordered narration tracks and independent random choices', async (t) => {
  const { catalog } = await fixtureDirectory(t);
  const config = {
    ...montage,
    narrationMode: 'segmented',
    narrationId: 'missing whole narration is unused',
    subtitles: { name: '整段字幕.srt', cues: [{ start: 0, end: 200, text: '整段' }] },
    segmentNarrationIds: [['music', null, 'otherMusic'], [null, 'otherMusic', 'music']],
    useOriginal: false, useMirrors: true,
  };
  const ordered = planMontage({ ...config, count: 6 }, catalog, () => 0);
  const firstShotChoices = ordered.filter((plan) => plan.clips[0].asset === catalog.get('red'));
  assert.equal(firstShotChoices.length, 3);
  assert.deepEqual(firstShotChoices.map((plan) => plan.clips.map((clip) => clip.narration?.name ?? null)), [
    [catalog.get('music').name, null], [null, catalog.get('otherMusic').name],
    [catalog.get('otherMusic').name, catalog.get('music').name],
  ]);
  assert.ok(ordered.every((plan) => !plan.narration && !plan.subtitles && plan.clips.every((clip) => clip.mirror)));
  const random = planMontage({ ...config, segmentNarrationSelection: 'random', count: 8 }, catalog, () => 0);
  const combinations = random.filter((plan) => plan.clips[0].asset === catalog.get('red'))
    .map((plan) => plan.clips.map((clip) => clip.narration.name).join('+'));
  assert.equal(new Set(combinations).size, 4);
  assert.throws(() => planMontage({ ...config, count: 7 }, catalog), /生成数量/);
});

test('keeps segmented narration on its shot after shuffling and aligns each shot separately', async (t) => {
  const { catalog, output } = await fixtureDirectory(t);
  const file = path.join(path.dirname(output), '第二段口播.wav');
  await ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=950', '-t', '0.8', file]);
  catalog.set('secondVoice', await inspectAsset(file, 'audio'));
  const config = {
    ...montage, ratio: '1:1', fps: 30, count: 1, unordered: true, musicIds: [],
    shots: [[{ id: 'red', start: 0, end: 0.6 }], [{ id: 'green', start: 0, end: 0.3 }], [{ id: 'still', start: 0, end: 0.5 }]],
    narrationMode: 'segmented', segmentNarrationIds: [['music'], ['secondVoice'], [null]],
    generatedCaptions: { music: { name: '第一镜台词', cues: [
      { start: 60, end: 230, text: '第一镜台词' },
      { start: 300, end: 550, text: '第一镜片尾' },
    ] }, secondVoice: '第二镜台词' },
    subtitles: { name: '整段字幕.srt', cues: [{ start: 0, end: 200, text: '整段字幕' }] },
  };
  const [voice] = planMontage({ ...config, priority: 'voice' }, catalog, () => 0);
  const [picture] = planMontage({ ...config, priority: 'picture' }, catalog, () => 0);
  assert.deepEqual(voice.clips.map((clip) => clip.outputDuration), [0.8, 0.5, 0.4]);
  assert.deepEqual(picture.clips.map((clip) => clip.outputDuration), [0.3, 0.5, 0.6]);
  assert.deepEqual(voice.clips.map((clip) => clip.narration?.name ?? null), [catalog.get('secondVoice').name, null, catalog.get('music').name]);
  assert.deepEqual(voice.subtitles?.cues, [
    { start: 0, end: 800, text: '第二镜台词' },
    { start: 1360, end: 1530, text: '第一镜台词' },
    { start: 1600, end: 1700, text: '第一镜片尾' },
  ]);
  assert.deepEqual(picture.subtitles?.cues, [
    { start: 0, end: 300, text: '第二镜台词' },
    { start: 860, end: 1030, text: '第一镜台词' },
    { start: 1100, end: 1200, text: '第一镜片尾' },
  ]);
  const batch = await exportBatch([voice, picture], output);
  assert.deepEqual(batch.failures, []);
  const [voiceFile, pictureFile] = batch.results.map((item) => item.path);
  assert.ok(Math.abs((await inspectAsset(voiceFile, 'video')).duration - 1.7) < 0.035);
  assert.ok(Math.abs((await inspectAsset(pictureFile, 'video')).duration - 1.4) < 0.035);
  assert.ok((await frameColor(voiceFile, 0.65)).green > 85);
  const still = await frameColor(voiceFile, 1.03);
  assert.ok(still.red > 220 && still.blue > 220);
  const red = await frameColor(voiceFile, 1.5);
  assert.ok(red.red > 220 && red.blue < 35);

  assert.ok(Math.abs((await toneAt(voiceFile, '0.6')) - 950) < 70);
  assert.equal(await toneAt(voiceFile, '0.97'), 0);
  assert.ok(Math.abs((await toneAt(voiceFile, '1.45')) - 660) < 70);
  assert.ok(Math.abs((await toneAt(pictureFile, '0.15')) - 950) < 70);
  assert.equal(await toneAt(pictureFile, '0.4'), 0);

  async function brightPixels(position) {
    const pixels = await ffmpeg([
      '-ss', position, '-i', voiceFile, '-an', '-frames:v', '1', '-vf', 'crop=600:230:60:490',
      '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1',
    ]);
    assert.equal(pixels.length, 600 * 230);
    return pixels.reduce((total, value) => total + Number(value > 210), 0);
  }
  assert.ok(await brightPixels('0.2') > 100);
  assert.equal(await brightPixels('1.0'), 0);
  assert.ok(await brightPixels('1.5') > 100);
  assert.equal(await brightPixels('1.55'), 0);
});

test('burns UTF-8 subtitles at their final timeline positions after voice alignment', async (t) => {
  const { catalog, output } = await fixtureDirectory(t);
  const directory = path.join(output, "成片 '样片'");
  await fs.mkdir(directory);
  const [plan] = planMontage({
    ...montage, ratio: '1:1', fps: 60, shots: [[{ id: 'red', start: 0, end: 0.2 }]],
    musicIds: [], count: 1, narrationId: 'music', priority: 'voice',
    subtitles: { name: '中文字幕.srt', cues: [{ start: 180, end: 300, text: '字幕测试' }] },
  }, catalog);
  const batch = await exportBatch([plan], directory);
  assert.deepEqual(batch.failures, []);
  assert.equal(batch.results.length, 1);
  const [{ path: file, name }] = batch.results;
  assert.deepEqual(await fs.readdir(directory), [name]);

  async function brightPixels(position) {
    const pixels = await ffmpeg([
      '-ss', position, '-i', file, '-an', '-frames:v', '1', '-vf', 'crop=600:230:60:490',
      '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1',
    ]);
    assert.equal(pixels.length, 600 * 230);
    return pixels.reduce((count, pixel) => count + Number(pixel > 210), 0);
  }
  assert.equal(await brightPixels('0.06'), 0);
  assert.ok(await brightPixels('0.24') > 100);
  assert.equal(await brightPixels('0.34'), 0);
});

test('renders the global subtitle colors and position on an alternate whole narration track', async (t) => {
  assert.deepEqual(normalizeSubtitleStyle(), { size: 18, textColor: '#ffffff', outlineColor: '#000000', position: 'bottom' });
  assert.throws(() => normalizeSubtitleStyle({ size: 36.5 }), /字号/);
  assert.throws(() => normalizeSubtitleStyle({ textColor: '#00FFFF\n' }), /颜色/);
  assert.throws(() => normalizeSubtitleStyle({ position: '__proto__' }), /位置/);
  const { catalog, output } = await fixtureDirectory(t);
  const plans = planMontage({
    ...montage, ratio: '1:1', count: 2, shots: [[{ id: 'red', start: 0, end: 0.8 }]], musicIds: [],
    extraWholeTracks: [{ narrationId: null, subtitles: { name: 'Top.srt', cues: [{ start: 0, end: 650, text: 'Styled Caption' }] } }],
    subtitleStyle: { size: 30, textColor: '#00FFFF', outlineColor: '#FF00FF', position: 'top' },
  }, catalog, () => 0);
  const alternate = plans.find((plan) => plan.wholeTrack === 2);
  assert.equal(alternate.subtitleStyle.textColor, '#00ffff');
  const batch = await exportBatch([alternate], output);
  assert.deepEqual(batch.failures, []);
  assert.equal(batch.results.length, 1);
  const [{ path: file }] = batch.results;

  async function colorsIn(y) {
    const rgb = await ffmpeg([
      '-ss', '0.3', '-i', file, '-an', '-frames:v', '1', '-vf', `crop=720:220:0:${y}`,
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
    ]);
    assert.equal(rgb.length, 720 * 220 * 3);
    let text = 0;
    let outline = 0;
    for (let i = 0; i < rgb.length; i += 3) {
      if (rgb[i] < 55 && rgb[i + 1] > 200 && rgb[i + 2] > 200) text += 1;
      if (rgb[i] > 200 && rgb[i + 1] < 55 && rgb[i + 2] > 200) outline += 1;
    }
    return { text, outline };
  }
  const top = await colorsIn(0);
  const bottom = await colorsIn(500);
  assert.ok(top.text > 500 && top.outline > 100, `subtitle pixel counts were ${JSON.stringify({ top, bottom })}`);
  assert.deepEqual(bottom, { text: 0, outline: 0 });
});

test('subtitle inspector preview matches exported placement and switching captions off keeps packaging text', async (t) => {
  const { previewSubtitleStyle } = require('../src/media.cjs');
  const { catalog, output } = await fixtureDirectory(t);
  const cue = {start:0,end:600,text:'字幕 ABC'};
  const captions = {name:'口播字幕.srt',cues:[cue]};
  const style = {enabled:true,font:'song',size:24,textColor:'#ffff00',outlineColor:'#000000',outlineWidth:2,
    position:'custom',x:73,y:16,margin:24,bold:true,italic:true,underline:true,spacing:2};
  const config = {...montage,ratio:'1:1',count:1,musicIds:[],shots:[[{id:'blue',start:0,end:.8,
    videoSubtitles:{name:'画面字幕',cues:[{...cue,start:615,end:760}]}}]],subtitles:captions,subtitleStyle:style,
    packaging:{global:[{kind:'text',text:'片头标记',color:'#ffffff',fontSize:60,start:0,end:.8}]}};
  const [on] = planMontage(config,catalog);
  const [off] = planMontage({...config,subtitleStyle:{...style,enabled:false}},catalog);
  assert.equal(off.subtitles,null);
  assert.equal(off.videoSubtitles,undefined);
  assert.equal(off.layers[0].text,'片头标记');
  assert.equal(on.videoSubtitles.cues[0].text,cue.text);
  const png = path.join(output,'preview.png');
  await fs.writeFile(png,await previewSubtitleStyle({style,ratio:'1:1',cue}));
  const batch = await exportBatch([on,off],output);
  assert.deepEqual(batch.failures,[]);
  const sample = async (file,video) => ffmpeg([...(video?['-ss','0.25']:[]),'-i',file,'-frames:v','1',
    '-vf','scale=256:256','-pix_fmt','rgba','-f','rawvideo','pipe:1']);
  function bounds(pixels) {
    let count=0,left=256,top=256,right=0,bottom=0;
    for(let pixel=0; pixel<256*256; pixel++) {
      const i=pixel*4;
      if (pixels[i]<175 || pixels[i+1]<175 || pixels[i+2]>75 || pixels[i+3]<128) continue;
      const x=pixel%256, y=Math.floor(pixel/256);
      count++; left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);
    }
    return {count,left,top,right,bottom};
  }
  const bitmap=await sample(png,false);
  assert.equal(bitmap[3],0,'字幕之外的预览像素应为透明');
  const preview=bounds(bitmap), burned=bounds(await sample(batch.results[0].path,true));
  assert.ok(preview.count>80 && burned.count>80);
  assert.ok(preview.left>120 && preview.bottom<90,JSON.stringify(preview));
  assert.ok(Math.abs((preview.left+preview.right)/2-256*.73)<4 && Math.abs((preview.top+preview.bottom)/2-256*.16)<10,JSON.stringify(preview));
  for(const side of ['left','top','right','bottom']) assert.ok(Math.abs(preview[side]-burned[side])<=2,side);
  assert.equal(bounds(await sample(batch.results[1].path,true)).count,0,'关闭后不应残留字幕颜色');
  for(const bad of [{font:'not-a-font'},{align:'__proto__'},{margin:500},{enabled:'false'}]) {
    assert.throws(()=>normalizeSubtitleStyle(bad));
  }
});

test('extracts real MP3 audio and preserves a same-name file', async (t) => {
  const { catalog, output } = await fixtureDirectory(t);
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-05T09:00:00Z') });
  const existing = path.join(output, '提取音频-20261105090000-01.mp3');
  await fs.writeFile(existing, 'original file');
  const batch = await exportBatch(planExtraction(['red'], catalog), output);
  assert.deepEqual(batch.failures, []);
  assert.equal(batch.results.length, 1);
  assert.equal(batch.results[0].name, '提取音频-20261105090000-01-2.mp3');
  assert.equal(await fs.readFile(existing, 'utf8'), 'original file');
  const rendered = await inspectAsset(batch.results[0].path, 'audio');
  assert.equal(rendered.codec, 'mp3');
  assert.ok(Math.abs(rendered.duration - 1.5) < 0.12);
  assert.throws(() => planExtraction(['blue'], catalog), /没有音轨/);
  assert.throws(() => planMontage({ ...montage, shots: [[{ id: 'red', start: 1, end: 0.5 }]] }, catalog), /有效片段/);
});

test('renders selected packaging as timed text, sticker, picture-in-picture and sound', async (t) => {
  const { catalog, output } = await fixtureDirectory(t);
  const config = { ...montage, ratio: '1:1', count: 1, musicIds: [], shots: [[{
    id: 'red', start: 0, end: 1.4, layers: [{ kind: 'sticker', id: 'still', start: .1, end: .38, scale: .5 }],
  }]], packaging: {
    global: [{ kind: 'text', start: .7, end: 1.3, text: "佳剪 100% ':[]", fontSize: 100 }],
    composites: [[{ kind: 'pip', id: 'blue', start: .4, end: .68, scale: .5 },
      { kind: 'sound', id: 'music', start: .55, end: .85, volume: 80 }]],
  } };
  const [plan] = planMontage(config, catalog);
  assert.deepEqual(plan.layers.map((layer) => layer.kind), ['sticker', 'pip', 'sound', 'text']);
  const batch = await exportBatch([plan], output, {});
  assert.deepEqual(batch.failures, []);
  const file = batch.results[0].path;
  const center = (seconds) => ffmpeg(['-ss', seconds, '-i', file, '-an', '-frames:v', '1', '-vf', 'crop=8:8:356:356,scale=1:1',
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']);
  const [red, sticker, pip, late] = await Promise.all(['0.04', '0.21', '0.50', '1.35'].map(center));
  assert.ok(red[0] > 200 && red[2] < 40 && late[0] > 200 && late[2] < 40);
  assert.ok(sticker[0] > 200 && sticker[2] > 200);
  assert.ok(pip[2] > 200 && pip[0] < 40);
  const textFrame = await ffmpeg(['-ss', '0.9', '-i', file, '-an', '-frames:v', '1', '-vf', 'crop=440:130:140:295',
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']);
  let white = 0;
  for (let i = 0; i < textFrame.length; i += 3) if (textFrame[i + 1] > 180 && textFrame[i + 2] > 180) white++;
  assert.ok(white > 50, 'timed white text should be visible on red');
  assert.equal(await toneAt(file, '0.2'), 0);
  assert.ok(Math.abs(await toneAt(file, '0.62') - 660) < 35);
  assert.equal(await toneAt(file, '1.0'), 0);
});

test('renders font, outline, shadow and background on static and animated packaging text', async (t) => {
  const {catalog,output} = await fixtureDirectory(t);
  const textStyle = {font:'bold',outlineWidth:5,outlineColor:'#00ff00',background:true,
    backgroundColor:'#0000ff',backgroundOpacity:1,shadow:true,shadowColor:'#ff00ff',shadowX:15,shadowY:12};
  const layer = {kind:'text',text:'佳剪 / Aa',fontSize:84,textStyle};
  const [plan] = planMontage({...montage,ratio:'1:1',count:1,musicIds:[],shots:[[{id:'red',start:0,end:1.4}]],
    packaging:{global:[{...layer,start:0,end:.68},{...layer,start:.68,end:1.38,keyframes:[{time:.5,x:.53}]}]}},catalog);
  const batch = await exportBatch([plan],output,{});
  assert.deepEqual(batch.failures,[]);
  for (const time of ['0.3','1.10']) {
    const buf=await ffmpeg(['-ss',time,'-i',batch.results[0].path,'-an','-frames:v','1','-vf','crop=440:160:140:280','-f','rawvideo','-pix_fmt','rgb24','pipe:1']);
    const count={white:0,green:0,blue:0,magenta:0};
    for (let i=0;i<buf.length;i+=3) {
      const [r,g,b]=buf.subarray(i,i+3);
      if (r>200 && g>200 && b>200) count.white++;
      if (g>190 && r<70 && b<70) count.green++;
      if (b>190 && g<70 && r<70) count.blue++;
      if (r>170 && b>170 && g<80) count.magenta++;
    }
    for (const pixels of Object.values(count)) assert.ok(pixels>80,JSON.stringify({time,count}));
  }
});

test('renders interpolated layer position, scale, rotation and opacity at the original keyframe times', async (t) => {
  const { catalog, output } = await fixtureDirectory(t);
  const layer = { kind: 'sticker', id: 'still', start: .1, end: 1.3, x: .2, y: .5, scale: .28, opacity: .9,
    keyframes: [{ time: .9, x: .75, y: .35, scale: .48, rotation: 90, opacity: .35 }] };
  const [plan] = planMontage({ ...montage, ratio: '1:1', count: 1, musicIds: [],
    shots: [[{ id: 'red', start: 0, end: 1.4 }]], packaging: { global: [layer] } }, catalog);
  const batch = await exportBatch([plan], output, {});
  assert.deepEqual(batch.failures, []);
  async function region(seconds) {
    const buf = await ffmpeg(['-ss', seconds, '-i', batch.results[0].path, '-an', '-frames:v', '1', '-vf', 'scale=120:120',
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']);
    let count = 0, totalBlue = 0, totalX = 0, totalY = 0;
    let xmin = 120, xmax = 0, ymin = 120, ymax = 0;
    for (let y = 0; y < 120; y++) for (let x = 0; x < 120; x++) {
      const blue = buf[(y * 120 + x) * 3 + 2];
      if (blue < 45) continue;
      count++; totalX += x; totalY += y; totalBlue += blue;
      xmin = Math.min(xmin, x); xmax = Math.max(xmax, x); ymin = Math.min(ymin, y); ymax = Math.max(ymax, y);
    }
    assert.ok(count > 100, 'colored region should be visible at ' + seconds);
    return { x: totalX / count, y: totalY / count, blue: totalBlue / count, width: xmax - xmin, height: ymax - ymin, count };
  }
  const [early, middle, late] = await Promise.all(['0.15', '0.58', '1.12'].map(region));
  assert.ok(early.x < 35 && middle.x > 48 && middle.x < 75 && late.x > 82, JSON.stringify([early, middle, late]));
  assert.ok(early.y > late.y + 10 && early.blue > middle.blue && middle.blue > late.blue);
  assert.ok(early.width > early.height && late.height > late.width && late.count > early.count * 1.6, JSON.stringify([early, middle, late]));
});

test('runs the bundled foreground model offline and caches a usable alpha image', { skip: process.platform !== 'win32' || process.arch !== 'x64' }, async (t) => {
  const { output } = await fixtureDirectory(t);
  const image = path.join(output, '瓶子.png');
  await ffmpeg(['-f','lavfi','-i','color=c=white:s=168x128,drawbox=x=60:y=30:w=48:h=72:color=red:t=fill,drawbox=x=66:y=19:w=36:h=15:color=gray:t=fill',
    '-frames:v','1','-threads','1','-update','1',image]);
  const source = await inspectAsset(image,'image');
  const file = await createForeground(source, output);
  assert.equal(await createForeground(source, output),file);
  assert.ok((await inspectAsset(file,'image')).alpha);
  const matte = await ffmpeg(['-i',file,'-vf','alphaextract','-frames:v','1','-f','rawvideo','-pix_fmt','gray','pipe:1']);
  assert.ok(matte[70*168+80]>235 && matte[3*168+3]<15);
});

test('applies a candidate transform and feathered geometric mask before composing the timeline', async (t) => {
  const { catalog, output } = await fixtureDirectory(t);
  const mask = { shape: 'ellipse', x: .5, y: .5, width: .6, height: .6, feather: .35 };
  const [plan] = planMontage({ ...montage, ratio: '1:1', count: 1, musicIds: [],
    shots: [[{ id: 'red', start: 0, end: .8, transform: { x: .3, scale: .7, opacity: .8, mask,
      keyframes: [{ time: .5, x: .7, rotation: 45 }] } }],
    [{ id: 'blue', start: 0, end: .5, transform: { mask: { ...mask, shape: 'rectangle', feather: 0, invert: true } } }]] }, catalog);
  const batch = await exportBatch([plan], output, {});
  assert.deepEqual(batch.failures, []);
  const frame = (seconds) => ffmpeg(['-ss', seconds, '-i', batch.results[0].path, '-an', '-frames:v', '1', '-vf', 'scale=100:100',
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']);
  const [early, late, rect] = await Promise.all(['0.03', '0.63', '1.0'].map(frame));
  const point = (buf, x, y, channel) => buf[(y * 100 + x) * 3 + channel];
  assert.ok(point(early, 32, 50, 0) > 170 && point(early, 70, 50, 0) < 20);
  assert.ok(point(late, 70, 50, 0) > 170 && point(late, 30, 50, 0) < 20);
  assert.ok(point(late, 88, 50, 0) > 10 && point(late, 88, 50, 0) < 165);
  assert.ok(point(rect, 50, 50, 2) < 20 && point(rect, 4, 50, 2) > 170);
});

test('cancels an in-progress output and keeps previously completed media', async (t) => {
  const { catalog, output } = await fixtureDirectory(t);
  const controller = new AbortController();
  const plans = planMontage({ ...montage, ratio: '1:1', fit: 'fit', keepAudio: true, musicIds: [] }, catalog);
  const batch = await exportBatch(plans, output, {
    signal: controller.signal,
    onUpdate: ({ index, fraction }) => { if (index === 1 && fraction > 0 && fraction < 1) controller.abort(); },
  });
  assert.equal(batch.cancelled, true);
  assert.equal(batch.results.length, 1);
  assert.deepEqual(batch.failures, []);
  const rendered = await inspectAsset(batch.results[0].path, 'video');
  assert.deepEqual([rendered.width, rendered.height], [720, 720]);
  assert.deepEqual(await fs.readdir(output), [batch.results[0].name]);
});

test('renders a complete four-second candidate in one matched second and fills a short matched candidate', async t => {
  const { matchCandidateDuration } = require('../src/ui/voice-alignment.js');
  const { catalog, output } = await fixtureDirectory(t);
  const source = path.join(output,'双色素材.mp4');
  await ffmpeg(['-f','lavfi','-i','color=red:s=160x90:r=24:d=2','-f','lavfi','-i','color=blue:s=160x90:r=24:d=2',
    '-filter_complex','[0:v][1:v]concat=n=2:v=1:a=0','-threads','2',source]);
  catalog.set('both', await inspectAsset(source,'video'));
  const clip={id:'both',asset:catalog.get('both'),start:0,end:4,speed:1};
  assert.equal(matchCandidateDuration(clip,1),true);
  assert.equal(matchCandidateDuration(clip,1),false);
  assert.equal(clip.speed,4);
  const short={...clip,start:0,end:.4};
  matchCandidateDuration(short,1);
  const still={id:'still',asset:catalog.get('still'),start:0,end:3};
  matchCandidateDuration(still,1);
  const plans=[clip,short,still].map(candidate=>planMontage({...montage,shots:[[candidate]],fps:24,priority:'picture',musicIds:[],
    count:1,shotSettings:[{duration:.25,smartTrim:true}]},catalog,()=>0)[0]);
  assert.equal(plans[0].clips[0].speed,4);
  assert.ok(plans[1].clips[0].visuals.some(v=>v.repeat>1 && v.speed>=1));
  const batch=await exportBatch(plans,output);
  assert.deepEqual(batch.failures,[]);
  for(const {path:file} of batch.results) assert.ok(Math.abs((await inspectAsset(file,'video')).duration-1)<1/24);
  assert.ok((await frameColor(batch.results[0].path,.1)).red>200);
  assert.ok((await frameColor(batch.results[0].path,.85)).blue>200,'加速应保留原片尾部蓝色画面');
});

test('reopens a legacy fixed-length shot and accelerates its entire source to its narration', async t => {
  const { loadProject } = require('../src/project-format.cjs');
  const { output }=await fixtureDirectory(t);
  const video=path.join(output,'老工程红蓝.mp4'), voice=path.join(output,'一秒口播.wav');
  await Promise.all([
    ffmpeg(['-f','lavfi','-i','color=red:s=160x90:r=24:d=2','-f','lavfi','-i','color=blue:s=160x90:r=24:d=2',
      '-filter_complex','[0:v][1:v]concat=n=2:v=1:a=0','-threads','2',video]),
    ffmpeg(['-f','lavfi','-i','sine=frequency=600:duration=1',voice]),
  ]);
  const project=path.join(output,'旧工程.sdworkbench');
  const config={...montage,fps:24,musicIds:[],count:1,priority:'voice',narrationMode:'segmented',segmentNarrationIds:[['speech']],
    shots:[[{id:'redblue',start:0,end:4}]],shotSettings:[{duration:1}]};
  await fs.writeFile(project,JSON.stringify({format:'sdworkbench',version:1,config,assets:[
    {id:'redblue',kind:'video',path:video},{id:'speech',kind:'audio',path:voice}]}));
  const opened=await loadProject(project);
  const plan=overrides=>planMontage({...opened.config,...overrides},opened.assets,()=>0)[0];
  const accelerated=plan({}), whole=plan({narrationMode:'whole',narrationId:'speech'});
  const batch=await exportBatch([accelerated],output);
  assert.deepEqual(batch.failures,[]);
  const file=batch.results[0].path;
  assert.ok(Math.abs((await inspectAsset(file,'video')).duration-1)<1/24);
  assert.ok((await frameColor(file,.12)).red>200);
  assert.ok((await frameColor(file,.85)).blue>200,'旧草稿的蓝色尾帧应在一秒口播内出现');
  for(const p of [accelerated,whole]) assert.deepEqual(p.clips[0].visuals.map(v=>[v.sourceDuration,v.speed]),[[4,4]]);
  assert.equal(plan({priority:'picture'}).clips[0].sourceDuration,1);
  assert.equal(plan({voiceAlignment:'reference'}).clips[0].visuals[0].sourceDuration,1);
});
