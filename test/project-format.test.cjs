'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { inspectAsset, planMontage, exportBatch } = require('../src/media.cjs');
const { saveProject, loadProject, normalizeScriptModel } = require('../src/project-format.cjs');
const { fixtures, ffmpeg } = require('./fixtures.cjs');

async function testDirectory(t) {
  const parent = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(parent, 'sd-project-test-'));
  t.after(async () => {
    const resolved = await fs.realpath(root);
    assert.equal(path.dirname(resolved), parent);
    assert.ok(path.basename(resolved).startsWith('sd-project-test-'));
    await fs.rm(resolved, { force: true, recursive: true });
  });
  return root;
}

function editingConfig(overrides = {}) {
  return {
    shots: [[]], ratio: '9:16', resolution: 1080, fps: 24, fit: 'fill', keepAudio: false,
    unordered: true, useOriginal: true, useMirrors: true, musicIds: [], musicVolume: 47, count: 1,
    ...overrides,
  };
}

test('persists packaging-only assets and voice, text-group and candidate layers in partially filled drafts', async (t) => {
  const root = await testDirectory(t);
  const file = path.join(root, '图层工程.sdworkbench');
  const files = await fixtures(root);
  const catalog = new Map(await Promise.all([['red', 'video'], ['still', 'image'], ['music', 'audio']]
    .map(async ([id, kind]) => [id, await inspectAsset(files[id], kind)])));
  const text = { kind: 'text', text: '第二镜', start: .1, end: null,
    textStyle: { font: 'song', outlineWidth: 3, background: true, backgroundOpacity: .42, shadow: true } };
  const sticker = { kind: 'sticker', id: 'still', start: 0, end: null };
  const config = editingConfig({
    shots: [[], [{ id: 'red', start: .1, end: 1.2, layers: [sticker] }]],
    narrationMode: 'segmented', segmentNarrationIds: [[], ['music']], useMirrors: false,
    packaging: { global: [], composites: [[sticker]], textMode: 'segmented', textSelection: 'random', textGroups: [[[], [text]]],
      segmentNarration: [[], [[text]]], wholeNarration: [[text]] },
  });
  await saveProject(file, config, catalog);
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(Object.keys(saved)[0], 'thumbnail');
  assert.match(saved.thumbnail, /^data:image\/jpeg;base64,\/9j\//);
  const jpeg = path.join(root, '封面.jpg');
  await fs.writeFile(jpeg, Buffer.from(saved.thumbnail.split(',')[1], 'base64'));
  const pixel = await ffmpeg(['-i', jpeg, '-vf', 'scale=1:1', '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-']);
  assert.ok(pixel[0] > 220 && pixel[1] < 30 && pixel[2] < 30, '工程内嵌缩略图应来自第一个红色视频候选');
  const loaded = await loadProject(file);
  assert.equal(loaded.assets.get('still').path, files.still);
  assert.equal(loaded.config.shots[1][0].layers[0].id, 'still');
  assert.equal(loaded.config.packaging.textGroups[0][1][0].text, text.text);
  const style = loaded.config.packaging.textGroups[0][1][0].textStyle;
  assert.deepEqual([style.font,style.outlineWidth,style.backgroundOpacity,style.shadow],['song',3,.42,true]);
  assert.equal(loaded.config.packaging.segmentNarration[1][0][0].text, text.text);
  assert.equal(loaded.config.packaging.wholeNarration[0][0].end, null);
  const invalid = { ...config, packaging: { global: [{ ...sticker, id: 'absent' }] } };
  await assert.rejects(saveProject(file, invalid, catalog, { overwrite: true }), /缺失|找不到|缺少/);
  assert.deepEqual((await loadProject(file)).config, loaded.config);
});

test('reopens reversible source edits and rebuilds a missing result in the local edit cache', async (t) => {
  const { prepareSourceEdit } = require('../src/source-edit.cjs');
  const root = await testDirectory(t);
  const file = path.join(root, 'source-edits.sdworkbench');
  const { red } = await fixtures(root);
  const original = await inspectAsset(red, 'video');
  const bytes = await fs.readFile(red);
  const ranges = [{start:.25, end:.75, mirror:true, reverse:true}];
  const rendered = await prepareSourceEdit(original, ranges, path.join(root, 'cache'));
  const result = await inspectAsset(rendered, 'video');
  const clip = {id:'edited', start:0, end:.5, sourceEdit:{id:'original',ranges}};
  const config = editingConfig({shots:[[clip]], subprojects:{
    active:null, main:[], projects:[{id:'second',name:'副本',shots:[{index:0,clips:[clip]}]}]
  }});
  const assets = new Map([['original', original], ['edited', result]]);
  await saveProject(file, config, assets);
  assert.deepEqual((await loadProject(file)).config, config);
  await fs.unlink(rendered);
  const cache = path.join(root, 'rebuilt');
  const reopened = await loadProject(file, undefined, inspectAsset, cache);
  assert.deepEqual(reopened.config, config);
  assert.equal(path.dirname(reopened.assets.get('edited').path), cache);
  assert.ok(Math.abs(reopened.assets.get('edited').duration - .5) < .05);
  assert.deepEqual(await fs.readFile(red), bytes);
  await assert.rejects(saveProject(file, editingConfig({shots:[[{...clip, sourceEdit:{id:'original', ranges:[{start:0,end:2000}]}}]]}), assets, {overwrite:true}), /范围/);
});

test('a draft with every visual excluded keeps muted tracks, clips and original volume', async (t) => {
  const root = await testDirectory(t);
  const file = path.join(root, '未参与剪辑.sdworkbench');
  const files = await fixtures(root);
  const catalog = new Map([['red', await inspectAsset(files.red, 'video')]]);
  const config = editingConfig({ shots: [[
    { id: 'red', start: .1, end: .8, videoLane:0, videoStart:2.125, videoDuration:.35, volume: 42, enabled: false },
    { id: 'red', start: .8, end: 1, videoLane:0, videoStart:5.25, enabled:false },
  ]], mutedVideoTracks: [0], trackControls:{vis0:{locked:true,hidden:true}} });
  await saveProject(file, config, catalog);
  assert.deepEqual((await loadProject(file)).config, config);
  await assert.rejects(saveProject(file, {...config, shots:[[{...config.shots[0][0],videoStart:-1}]]}, catalog), /落点/);
  await assert.rejects(saveProject(file, {...config, shots:[[{...config.shots[0][0],videoDuration:0}]]}, catalog), /裁切时长/);
  const placed={...config.shots[0][0],enabled:true,videoFit:'hold'};
  const occupied={...config,shots:[[placed,{...placed}]]};
  await assert.rejects(saveProject(file,occupied,catalog,{overwrite:true}),/视频轨/);
  assert.throws(()=>planMontage(occupied,catalog),/视频轨/);
  assert.deepEqual((await loadProject(file)).config,config,'回绝同一轨道起点的两个片段后保留旧工程');
  await assert.rejects(saveProject(file, { ...config, mutedVideoTracks: [-1] }, catalog), /静音/);
});

test('independent instances of one video save, reopen and export at the same time on different tracks', async (t) => {
  const root = await testDirectory(t);
  const file = path.join(root, '同源双轨.sdworkbench');
  const { red } = await fixtures(root);
  const catalog = new Map([['red', await inspectAsset(red, 'video')]]);
  const placed = { id: 'red', start: 0, end: 1, videoStart: 0, videoDuration: .5, videoFit: 'hold' };
  const clips = [{ ...placed, videoLane: 0, speed: 1, volume: 40 }, { ...placed, videoLane: 1, speed: 2, volume: 75 }];
  const config = editingConfig({ shots: [clips], resolution: 720, keepAudio: true, useMirrors: false, count: 2 });
  await saveProject(file, config, catalog);
  const loaded = await loadProject(file);
  assert.equal(loaded.assets.size, 1);
  assert.deepEqual(loaded.config.shots[0], clips);
  const plans = planMontage(loaded.config, loaded.assets);
  const variants = plans.map(plan => plan.clips[0]).sort((a, b) => a.videoLane - b.videoLane);
  assert.deepEqual(variants.map(clip => [clip.videoLane, clip.speed, clip.volume]), [[0, 1, .4], [1, 2, .75]]);
  const { failures, results } = await exportBatch(plans, root);
  assert.deepEqual(failures, []);
  assert.equal(results.length, 2);
  for (const result of results) assert.ok((await inspectAsset(result.path, 'video')).duration >= .5);
});

test('deleting inherited footage in one store persists its empty shot without removing the shared footage', async (t) => {
  const {createSubprojects}=require('../src/ui/subprojects.js');
  const {resolveSubprojectShots}=require('../src/subprojects.cjs');
  const root=await testDirectory(t), files=await fixtures(root);
  const catalog=new Map([['red',await inspectAsset(files.red,'video')]]);
  const shots=[[{asset:{id:'red'},start:0,end:.5}]];
  const serialize=({asset,start,end})=>({id:asset.id,start,end});
  const revive=({id,start,end})=>({asset:{id},start,end});
  const state=createSubprojects({shots,serialize,revive});
  state.create('杭州店\n上海店');
  const branch=state.active.id;
  state.removeMaterialReferences(new Set(['red']));
  state.applyFallbacks();
  assert.equal(shots[0].length,0);
  const file=path.join(root,'library.sdworkbench');
  const bins=[{scope:null,ids:['red'],hidden:[]},{scope:branch,ids:[],hidden:['a'.repeat(64)]}];
  await saveProject(file,editingConfig({shots:shots.map(shot=>shot.map(serialize)),subprojects:state.pack(),materialBins:bins}),catalog);
  const loaded=await loadProject(file), stores=resolveSubprojectShots(loaded.config);
  assert.deepEqual(loaded.config.materialBins,bins);
  assert.equal(stores.get(branch).effective[0].length,0);
  assert.equal(stores.get(state.projects[1].id).effective[0][0].id,'red');
  state.select(null);
  assert.equal(shots[0][0].asset.id,'red');
  state.select(branch);
  assert.deepEqual(shots,[[]]);
});

test('subprojects keep their isolated candidates and inherit public edits across switches, reordering and disk reload', async (t) => {
  const { createSubprojects } = require('../src/ui/subprojects.js');
  const root = await testDirectory(t);
  const file = path.join(root, '门店.sdworkbench');
  const files = await fixtures(root);
  const catalog = new Map(await Promise.all(['red', 'green', 'blue'].map(async (id) => [id, await inspectAsset(files[id], 'video')])));
  const clip = (id) => ({ id, start: 0, end: 1 });
  const first = [clip('red')], second = [clip('green')], shots = [first, second];
  const state = createSubprojects({ shots, serialize: (item) => item, revive: structuredClone });
  state.create('杭州店');
  const hangzhou = state.active.id;
  first.splice(0, 1, clip('blue'));
  state.create('上海店');
  assert.equal(first[0].id, 'red');
  state.select(null);
  second[0].start = .2;
  shots.reverse();
  state.select(hangzhou);
  assert.deepEqual(shots.map((s) => s[0].id), ['green', 'blue']);
  assert.equal(second[0].start, .2);
  const config = editingConfig({ shots, subprojects: state.pack() });
  await saveProject(file, config, catalog);
  const loaded = await loadProject(file);
  assert.deepEqual([...loaded.assets.keys()].sort(), ['blue', 'green', 'red']);
  const restored = createSubprojects({ shots: loaded.config.shots, serialize: (item) => item, revive: structuredClone });
  restored.restore(loaded.config.subprojects);
  assert.equal(restored.active.name, '杭州店');
  assert.ok(planMontage({ ...loaded.config, unordered: false }, loaded.assets)[0].clips[1].asset.name.includes('蓝色'));
  restored.select(null);
  assert.deepEqual(loaded.config.shots.map((s) => s[0].id), ['green', 'red']);
  restored.select(hangzhou);
  restored.revert(loaded.config.shots[1]);
  assert.equal(loaded.config.shots[1][0].id, 'red');
  assert.deepEqual(restored.pack().main, []);
});

test('accepts more than the legacy sixteen shot groups', async (t) => {
  const root = await testDirectory(t);
  const file = path.join(root, 'large-shot-project.sdworkbench');
  const config = editingConfig({ shots: Array.from({ length: 17 }, () => []) });
  await saveProject(file, config, new Map());
  const loaded = await loadProject(file);
  assert.equal(loaded.config.shots.length, 17);
  const script = normalizeScriptModel({
    title: '长脚本', mode: 'segmented', tab: 'narration',
    whole: [{ dialogue: '', note: '' }],
    segmented: Array.from({ length: 17 }, (_, index) => ({ dialogue: `第${index + 1}镜`, note: '' })),
    textGroups: [{ dialogue: '', note: '' }],
  });
  assert.equal(script.segmented.length, 17);
});

test('saves shot timing, range alternatives and AI source cut marks in a partially filled draft', async (t) => {
  const root = await testDirectory(t);
  const files = await fixtures(root);
  const catalog = new Map([['red', await inspectAsset(files.red, 'video')], ['blue', await inspectAsset(files.blue, 'video')], ['voice', await inspectAsset(files.music, 'audio')]]);
  const lut=path.join(root,'颜色.cube');
  await fs.writeFile(lut,'LUT_3D_SIZE 2\n'+'1 1 1\n'.repeat(8));
  catalog.set('lut',await require('../src/visual-style.cjs').inspectLut(lut));
  const config = editingConfig({
    shots: [[], [{ id: 'red', start: 0, end: 1, ranges: [{ start: 0.5, end: 1 }, { start: 0, end: 0.2 }] },
      { id: 'red', start: 0.2, end: 0.5, look:{head:.05,tail:.05,grade:{brightness:10},lut:'lut',background:{kind:'media',ids:['blue']}} }]], musicIds: [], filterLibrary:['lut'],
    shotSettings: [null, { name: '细节', description: '转身', duration: 0.6, smartTrim: true }], voiceAlignment: 'reference',
    narrationMode: 'segmented', segmentNarrationIds: [[], ['voice']], segmentVoiceCuts: [[], [{ ranges: [{ start: 0.1, end: 0.3 }] }]],
    sceneCuts: [{ assetId: 'blue', points: [0.5, 1], used: [{ start: 0, end: 0.5 }] }],
    assetAliases:[{id:'red',kind:'video',name:'主题镜头-01.mp4'}],volumeOverrides:[{kind:'segment',id:'voice',shot:1,track:0,value:42}],
    cover: {mode:'library',items:[{id:'blue',time:0.6,title:'本地封面',style:'bold'}],active:0},
  });
  const file = path.join(root, '带裁剪的分镜.sdworkbench');
  await saveProject(file, config, catalog);
  const restored = await loadProject(file);
  assert.deepEqual(restored.config, config);
  assert.ok(restored.assets.has('blue'));
  assert.equal(restored.assets.get('lut').path,lut);
  await assert.rejects(saveProject(file, { ...config, sceneCuts: [{ assetId: 'blue', points: [3], used: [] }] }, catalog), /超出视频范围/);
});

test('round-trips a legacy project and restores narration that shares its music asset', async (t) => {
  const root = await testDirectory(t);
  const file = path.join(root, '混剪草稿.sdworkbench');
  const files = await fixtures(root);
  const catalog = new Map(await Promise.all([
    ['red', 'video'], ['blue', 'video'], ['still', 'image'], ['music', 'audio'], ['otherMusic', 'audio'],
  ].map(async ([id, kind]) => [id, await inspectAsset(files[id], kind)])));
  const config = editingConfig({
    shots: [[{ id: 'red', start: 0.2, end: 0.8 }, { id: 'still', start: 0, end: 1.25 }], []],
    musicIds: ['music'],
  });

  await saveProject(file, config, catalog);
  const loaded = await loadProject(file);
  assert.deepEqual(loaded.config, config);
  assert.deepEqual([...loaded.assets.keys()], ['red', 'still', 'music']);
  assert.deepEqual(loaded.assets.get('red'), catalog.get('red'));
  assert.deepEqual(loaded.assets.get('still'), catalog.get('still'));
  assert.deepEqual(loaded.assets.get('music'), catalog.get('music'));
  const [plan] = planMontage({ ...loaded.config, shots: loaded.config.shots.slice(0, 1) }, loaded.assets, () => 0);
  assert.equal(plan.music.path, files.music);
  assert.equal(plan.clips[0].start, 0.2);
  assert.deepEqual(plan.size, [1080, 1920]);

  const withNarration = { ...config, narrationId: 'music', priority: 'voice' };
  await saveProject(file, withNarration, catalog, { overwrite: true });
  const restored = await loadProject(file);
  assert.deepEqual(restored.config, withNarration);
  assert.deepEqual(restored.assets, loaded.assets);

  const segmented = {
    ...withNarration,
    narrationMode: 'segmented',
    segmentNarrationSelection: 'ordered',
    segmentNarrationIds: [[null, 'otherMusic'], ['music']],
    extraWholeTracks: [{
      narrationId: 'otherMusic',
      subtitles: { name: '备选字幕.srt', cues: [{ start: 0, end: 300, text: '另一段口播' }] },
    }],
    generatedCaptions: {
      music: '旧工程纯文本台词',
      otherMusic: { name: '配音字幕', cues: [{ start: 20, end: 300, text: '恢复带时间码的台词' }] },
    },
  };
  await saveProject(file, segmented, catalog, { overwrite: true });
  const restoredSegments = await loadProject(file);
  assert.deepEqual(restoredSegments.config, segmented);
  assert.equal(restoredSegments.assets.get('otherMusic').path, files.otherMusic);
  await assert.rejects(saveProject(file, { ...segmented, segmentNarrationIds: [[]] }, catalog, { overwrite: true }), /数量不匹配/);
});

test('cold draft lists reuse their index and JPEG and recover from external edits and cache damage',async t=>{
  const {createDraftStore}=require('../src/draft-store.cjs');
  const directory=await testDirectory(t), catalog=new Map(), config=editingConfig();
  const initial=createDraftStore(directory);
  const first=await initial.create({name:'旧稿甲',config},catalog);
  const second=await initial.create({name:'旧稿乙',config},catalog);
  const file=path.join(directory,first.id+'.sdworkbench');
  const jpeg=await initial.thumbnail(first.id,1);
  assert.ok(jpeg?.length);
  const cache=path.join(directory,'.list-cache'), index=path.join(cache,'index.json');
  let reads=0;
  const open=fs.open.bind(fs);
  t.mock.method(fs,'open',(name,...args)=>{
    if(typeof name==='string' && name.endsWith('.sdworkbench') && args[0]==='r') reads++;
    return open(name,...args);
  });

  const cold=createDraftStore(directory);
  assert.deepEqual(new Set((await cold.list()).map(r=>r.id)),new Set([first.id,second.id]));
  assert.deepEqual(await cold.thumbnail(first.id,1),jpeg);
  assert.equal(reads,0,'冷启动列表和封面均跳过工程正文');

  const source=JSON.parse(await fs.readFile(file,'utf8'));
  source.draft.name='外改甲';
  const assetPath=path.join(directory,'素材.mp4');
  source.assets=[{id:'clip',path:assetPath,kind:'video'}];
  source.config.shots=[[{id:'clip',start:.25,end:1}]];
  source.config.cover={mode:'first-shot'};
  await fs.writeFile(file,JSON.stringify(source));
  assert.equal((await cold.list()).find(r=>r.id===first.id).name,'外改甲');
  assert.deepEqual(cold.cover(first.id,1),{path:assetPath,kind:'video',time:.25});
  assert.equal(reads,1,'只重读外改的草稿');
  const before=await fs.stat(file);
  source.draft.name='同长甲';
  await fs.writeFile(file,JSON.stringify(source));
  await fs.utimes(file,before.atime,before.mtime);
  const restart=createDraftStore(directory);
  assert.equal((await restart.list()).find(r=>r.id===first.id).name,'同长甲');
  assert.equal(reads,2,'同长度并恢复 mtime 的改稿也会刷新');
  assert.deepEqual(restart.cover(first.id,1),cold.cover(first.id,1));

  await fs.writeFile(path.join(cache,first.id+'.jpg'),'damaged');
  const repaired=await Promise.all([restart.thumbnail(first.id,1),restart.thumbnail(first.id,1)]);
  assert.deepEqual(repaired,[jpeg,jpeg]);
  assert.equal(reads,3,'并发请求仅重读一次正文以修复 JPEG');
  assert.deepEqual(await restart.thumbnail(first.id,1),jpeg);
  assert.equal(reads,3);
  await fs.writeFile(index,'{}');
  assert.equal((await createDraftStore(directory).list()).length,2);
  assert.equal(reads,5);
  await fs.rm(index);
  assert.equal((await createDraftStore(directory).list()).length,2);
  assert.equal(reads,7);
  const rebuilt=createDraftStore(directory);
  assert.equal((await rebuilt.list()).length,2);
  assert.deepEqual(rebuilt.cover(first.id,1),cold.cover(first.id,1));
  assert.equal(reads,7,'索引修复后下一次冷启动再次命中');
  delete source.thumbnail;
  await fs.writeFile(file,JSON.stringify(source));
  assert.equal(await rebuilt.thumbnail(first.id,1),null,'移除内嵌封面后不会返回旧图');
  assert.equal(reads,8);
  assert.deepEqual(rebuilt.cover(first.id,1),{path:assetPath,kind:'video',time:.25});
  const legacy=createDraftStore(directory);
  await legacy.list();
  assert.equal(await legacy.thumbnail(first.id,1),null);
  assert.deepEqual(legacy.cover(first.id,1),rebuilt.cover(first.id,1));
  assert.equal(reads,8,'旧格式封面路径和无内嵌封面标记可从索引加载');
});

test('draft folders follow nested renames and deletions without touching external or unmanaged files', async t => {
  const {createDraftStore}=require('../src/draft-store.cjs');
  const root=await testDirectory(t), directory=path.join(root,'drafts'), catalog=new Map();
  const store=createDraftStore(directory);
  const item=(id,name,parentId=null)=>({id,name,parentId,scope:null,assetIds:[]});
  const first=[item('a','主素材'),item('b','空目录','a'),item('c','图片')];
  const config=folders=>editingConfig({shots:[],libraryFolders:folders});
  let draft=await store.create({name:'分镜',config:config(first)},catalog);
  const mirror=path.join(directory,draft.id+'.素材库');
  const save=async folders=>{
    draft=await store.save({id:draft.id,expectedRevision:draft.revision,config:config(folders)},catalog);
  };
  const external=path.join(root,'图片');
  await fs.mkdir(external);
  await fs.writeFile(path.join(external,'原始文件'),'original');
  const manual=path.join(mirror,'主素材','空目录','个人笔记');
  await fs.writeFile(manual,'keep');
  const renamed=[item('a','图片'),item('b','空目录','a'),item('c','主素材')];
  await save(renamed);
  const moved=path.join(mirror,'图片','空目录','个人笔记');
  assert.equal(await fs.readFile(moved,'utf8'),'keep');
  assert.deepEqual((await createDraftStore(directory).open(draft.id)).config.libraryFolders,renamed);
  await assert.rejects(save([]),/额外文件/);
  assert.deepEqual((await store.open(draft.id)).config.libraryFolders,renamed);
  assert.equal(await fs.readFile(moved,'utf8'),'keep');
  await fs.unlink(moved);
  await fs.mkdir(path.join(mirror,'已有文件夹'));
  await assert.rejects(save([...renamed,item('d','已有文件夹')]),/同名/);
  assert.deepEqual((await store.open(draft.id)).config.libraryFolders,renamed);
  await fs.rmdir(path.join(mirror,'已有文件夹'));
  const target=path.join(mirror,'外部目录');
  await fs.symlink(external,target,process.platform==='win32'?'junction':'dir');
  await assert.rejects(save([item('d','外部目录')]),/同名/);
  await fs.unlink(target);
  for (const invalid of [[item('x','..')],[item('x','COM1.mov')],[item('a','父','b'),item('b','子','a')],
    [item('x','A'),item('y','a')]]) await assert.rejects(save(invalid),/文件夹/);
  await save([]);
  await assert.rejects(fs.stat(mirror),{code:'ENOENT'});
  assert.equal(await fs.readFile(path.join(external,'原始文件'),'utf8'),'original');
});

test('deleting a draft survives restart, rejects stale writes and preserves shared media', async t => {
  const { createDraftStore } = require('../src/draft-store.cjs');
  const root = await testDirectory(t), directory = path.join(root, 'drafts');
  const store = createDraftStore(directory);
  const image = path.join(root, 'original.png');
  await ffmpeg(['-f', 'lavfi', '-i', 'color=red:s=32x32', '-frames:v', '1', '-threads', '1', '-update', '1', image]);
  const bytes = await fs.readFile(image);
  const catalog = new Map([['image', await inspectAsset(image, 'image')]]);
  const config = editingConfig({ shots: [[{ id: 'image', start: 0, end: 1 }]], libraryFolders: [
    { id: 'group', name: '素材', scope: null, parentId: null, assetIds: ['image'] },
  ] });
  const first = await store.create({ name: '同名', config }, catalog);
  const second = await store.create({ name: '同名', config }, catalog);
  const request = { id: first.id, expectedRevision: first.revision };
  const file = path.join(directory, first.id + '.sdworkbench');
  const external = path.join(root, first.id + '.sdworkbench');
  await saveProject(external, config, catalog);
  const projectBytes = await fs.readFile(external);
  await assert.rejects(store.remove({ ...request, id: external }), /找不到/);
  await assert.rejects(store.remove({ ...request, expectedRevision: 0 }), /刷新/);
  await fs.appendFile(file, ' ');
  await assert.rejects(store.remove(request), /刷新/);
  await store.list();
  const mirror = path.join(directory, first.id + '.素材库');
  const unlink = fs.unlink;
  const locked = t.mock.method(fs, 'unlink', async target => {
    if (target === file) throw Object.assign(new Error('locked'), { code: 'EBUSY' });
    return unlink(target);
  });
  await assert.rejects(store.remove(request), /被占用/);
  locked.mock.restore();
  assert.equal((await store.open(first.id)).revision, first.revision);
  assert.ok((await fs.stat(mirror)).isDirectory());
  const outcomes = await Promise.allSettled([store.remove(request), store.save({ ...request, config }, catalog)]);
  assert.deepEqual(outcomes[0], { status: 'fulfilled', value: true });
  assert.match(outcomes[1].reason.message, /找不到/);
  for (const removed of [file, mirror, path.join(directory, '.list-cache', first.id + '.jpg')]) {
    await assert.rejects(fs.stat(removed), { code: 'ENOENT' });
  }
  const cold = createDraftStore(directory);
  assert.deepEqual(await cold.list(), [second]);
  await assert.rejects(cold.open(first.id), /找不到/);
  assert.equal((await cold.open(second.id)).assets.get('image').path, image);
  const manual = path.join(directory, second.id + '.素材库', '素材', '个人笔记');
  await fs.writeFile(manual, 'keep');
  await cold.remove({ id: second.id, expectedRevision: second.revision });
  assert.deepEqual(await createDraftStore(directory).list(), []);
  assert.equal(await fs.readFile(manual, 'utf8'), 'keep');
  assert.deepEqual(await fs.readFile(image), bytes);
  assert.deepEqual(await fs.readFile(external), projectBytes);
});

test('folder-only audio and visual assets persist without a timeline reference', async t=>{
  const root=await testDirectory(t), files=await fixtures(root), file=path.join(root,'素材目录.sdworkbench');
  const libraryFolders=[{id:'group',parentId:null,scope:null,name:'声画',assetIds:['still','music'],
    sourceKey:'a'.repeat(64),hiddenKeys:['b'.repeat(64)]}];
  const catalog=new Map(await Promise.all([['still','image'],['music','audio']].map(async ([id,kind])=>[id,await inspectAsset(files[id],kind)])));
  await saveProject(file,editingConfig({shots:[],libraryFolders,materialBins:[{scope:null,ids:['music'],hidden:[]}]}),catalog);
  const project=await loadProject(file);
  assert.deepEqual(project.config.libraryFolders,libraryFolders);
  assert.equal(project.assets.get('music').kind,'audio');
  assert.equal(project.assets.get('still').path,files.still);
});

test('allows empty drafts and atomically rejects unconfirmed same-name saves', async (t) => {
  const root = await testDirectory(t);
  const file = path.join(root, 'draft.sdworkbench');
  const catalog = new Map();
  const original = editingConfig({ shots: [] });
  await saveProject(file, original, catalog);
  const first = await fs.readFile(file, 'utf8');
  await assert.rejects(saveProject(file, editingConfig(), catalog), { code: 'EEXIST' });
  await assert.rejects(saveProject(file, editingConfig({ shots: [[{ id: 'missing', start: 0, end: 1 }]] }), catalog, { overwrite: true }), /缺失/);
  assert.equal(await fs.readFile(file, 'utf8'), first);

  const replacement = editingConfig({ shots: [[], []], narrationId: null, priority: 'voice', script: null });
  await saveProject(file, replacement, catalog, { overwrite: true });
  assert.deepEqual(await loadProject(file), { config: replacement, assets: new Map() });
  assert.deepEqual(await fs.readdir(root), ['draft.sdworkbench']);
});

test('restores script selections and plain text and rejects oversized script data', async (t) => {
  const root = await testDirectory(t);
  const file = path.join(root, '创作脚本.sdworkbench');
  const script = {
    title: '短片脚本',
    mode: 'segmented',
    tab: 'textGroups',
    whole: [{ dialogue: '片头\u0000\r\n片尾', note: '' }],
    segmented: [{ dialogue: '第一镜', note: '补拍' }],
    textGroups: [{ dialogue: '<文字组>', note: '\t保留' }],
  };
  const config = editingConfig({ script });
  await saveProject(file, config, new Map(), { overwrite: true });
  const restored = await loadProject(file);
  assert.deepEqual(restored.config, {
    ...config,
    script: { ...script, whole: [{ dialogue: '片头\n片尾', note: '' }] },
  });

  const row = { dialogue: '界'.repeat(4096), note: '' };
  assert.throws(() => normalizeScriptModel({ ...script, title: '字'.repeat(101) }), /100 字/);
  assert.throws(() => normalizeScriptModel({ ...script, whole: [{ ...row, note: '字'.repeat(4097) }] }), /4096 字/);
  assert.throws(() => normalizeScriptModel({ ...script, whole: Array(251).fill(row) }), /250 行/);
  assert.throws(() => normalizeScriptModel({ ...script, whole: Array(22).fill(row) }), /256 KiB/);
});

test('opening a large draft renews the inspection deadline for each batch and still times out a stalled batch', async (t) => {
  const root = await testDirectory(t);
  const file = path.join(root, 'inspection.sdworkbench');
  const ids = Array.from({ length: 8 }, (_, index) => 'audio-' + index);
  const catalog = new Map(ids.map(id => [id, { kind: 'audio', path: path.join(root, id + '.mp3'), duration: 1 }]));
  await saveProject(file, editingConfig({ musicIds: ids }), catalog);

  let now = 0;
  const timers = [];
  t.mock.method(AbortSignal, 'timeout', milliseconds => {
    const controller = new AbortController();
    timers.push({ controller, expires: now + milliseconds });
    return controller.signal;
  });
  function advance(milliseconds) {
    now += milliseconds;
    for (const timer of timers) if (timer.expires <= now) timer.controller.abort();
  }
  let inspected = 0;
  const restored = await loadProject(file, undefined, async (source, kind, { signal }) => {
    if (inspected++ % 4 === 0) advance(40_000);
    signal.throwIfAborted();
    return { kind, path: source, duration: 1 };
  });
  assert.deepEqual([...restored.assets.keys()], ids);
  await assert.rejects(loadProject(file, undefined, async (_source, _kind, { signal }) => {
    advance(60_001);
    signal.throwIfAborted();
  }), /读取工程素材超时/);
});

test('reports missing media and rejects incompatible or undeclared asset references', async (t) => {
  const root = await testDirectory(t);
  const file = path.join(root, 'broken.sdworkbench');
  const config = editingConfig({ shots: [[{ id: 'clip', start: 0, end: 1 }]] });
  const catalog = new Map([['clip', { kind: 'video', path: path.join(root, '失踪.mp4'), duration: 2 }]]);
  await saveProject(file, config, catalog);
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  await assert.rejects(loadProject(file), /找不到工程素材「失踪.mp4」/);

  await assert.rejects(saveProject(file, { ...config, narrationId: 'missing' }, catalog, { overwrite: true }), /缺失或类型不匹配/);
  await assert.rejects(saveProject(file, { ...config, narrationId: 'clip' }, catalog, { overwrite: true }), /同时作为画面和音频/);
  await fs.writeFile(file, JSON.stringify({ ...saved, config: { ...config, priority: 'unknown' } }));
  await assert.rejects(loadProject(file), /音画优先模式无效/);

  await fs.writeFile(file, JSON.stringify({ ...saved, assets: [...saved.assets, { id: 'extra', kind: 'audio', path: 'C:\\unused.wav' }] }));
  await assert.rejects(loadProject(file), /素材清单与引用不一致/);
  await fs.writeFile(file, JSON.stringify({ ...saved, assets: [{ ...saved.assets[0], path: '../relative.mp4' }] }));
  await assert.rejects(loadProject(file), /缺失或类型不匹配/);
  await fs.writeFile(file, JSON.stringify({ ...saved, version: 2 }));
  await assert.rejects(loadProject(file), /不支持此工程文件格式或版本/);
});

test('bounds manifest input before parsing and rejects damaged JSON', async (t) => {
  const root = await testDirectory(t);
  const file = path.join(root, 'bad.sdworkbench');
  await fs.writeFile(file, ' '.repeat(1024 * 1024 + 1));
  await assert.rejects(loadProject(file), /1 MiB/);
  await fs.writeFile(file, '{');
  await assert.rejects(loadProject(file), /无效或已损坏/);
  await assert.rejects(loadProject('relative.sdworkbench'), /请选择本地的/);
});

test('renames published files without overwriting and opens an old draft through two subsequent names',async(t)=>{
  const root=await testDirectory(t),files=await fixtures(root);
  const {remember,readHistory,renameOutputs,resolveOutput}=require('../src/history.cjs');
  const original=path.join(root,'混剪-20261119123456-01.mp4'),other=path.join(root,'混剪-20261119123456-02.mp4');
  await fs.copyFile(files.red,original);await fs.copyFile(files.blue,other);
  const recent=[];
  await remember(root,recent,[original,other].map(file=>({name:path.basename(file),path:file})));
  const draft=path.join(root,'仍引用旧名称.sdworkbench');
  await saveProject(draft,editingConfig({shots:[[{id:'clip',start:0,end:.7}]],musicIds:[]}),new Map([['clip',await inspectAsset(original,'video')]]));
  const taken=path.join(root,'同名-02.mp4');await fs.writeFile(taken,'保持原有文件内容');
  await assert.rejects(renameOutputs(root,recent,[original,other],'同名'),/已存在/);
  assert.equal(await fs.readFile(taken,'utf8'),'保持原有文件内容');
  await assert.rejects(fs.access(path.join(root,'同名-01.mp4')),{code:'ENOENT'});
  assert.equal((await renameOutputs(root,recent,[original,other],'新作品')).changes.length,2);
  const first=path.join(root,'新作品-01.mp4');
  await renameOutputs(root,recent,[first],'最终标题');
  const reload=await readHistory(root);
  const restored=await loadProject(draft,file=>resolveOutput(reload,file));
  assert.equal(restored.assets.get('clip').path,path.join(root,'最终标题.mp4'));
  assert.ok(reload.some(r=>r.name==='最终标题.mp4'));
  await assert.rejects(fs.access(original),{code:'ENOENT'});
});
