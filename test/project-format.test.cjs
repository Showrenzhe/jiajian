'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { inspectAsset, planMontage, exportBatch } = require('../src/media.cjs');
const { saveProject, loadProject, projectReferences, normalizeScriptModel } = require('../src/project-format.cjs');
const { isLocalPath, isMaterialPath, isSharedMaterialPath } = require('../src/material-path.cjs');
const { createDraftStore } = require('../src/draft-store.cjs');
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

test('material paths accept ordinary Windows shares and keep project locations local', {skip:process.platform !== 'win32'}, () => {
  for (const file of ['\\\\编辑室\\素材库', '\\\\NAS-01.office\\拍摄 A\\第二集\\镜头 02.mp4', '\\\\192.168.1.2\\共享\\']) {
    assert.equal(isSharedMaterialPath(file), true, file);
    assert.equal(isMaterialPath(file), true, file);
    assert.equal(isLocalPath(file), false, file);
  }
  assert.equal(isMaterialPath('Z:\\素材库\\镜头.mp4'), true);
  for (const file of [null, '相对\\镜头.mp4', 'https://nas/media.mp4', '\\\\nas', '\\\\nas\\素材\\..\\镜头.mp4',
    '\\\\nas\\素材\\镜头.mp4:extra', '\\\\nas\\素材\\NUL.mp4', '\\\\nas\\IPC$', '\\\\nas\\pipe\\media',
    '\\\\.\\C:\\镜头.mp4', '\\\\?\\UNC\\nas\\素材\\镜头.mp4']) {
    assert.equal(isMaterialPath(file), false, String(file));
  }
});

test('opening a project or cold draft never probes a share before source resolution succeeds', {skip:process.platform !== 'win32'}, async t => {
  const root = await testDirectory(t), directory = path.join(root, '草稿'), project = path.join(root, '待授权.sdworkbench');
  const source = '\\\\studio.invalid\\素材\\解说.wav';
  const config = editingConfig({musicIds:['voice']});
  const catalog = new Map([['voice', {kind:'audio', path:source, duration:1}]]);
  const attempts = [];
  // Block the network boundary here so a regression cannot contact an external host.
  for (const method of ['stat', 'lstat', 'realpath', 'open', 'readFile', 'access', 'readdir']) {
    const original = fs[method];
    t.mock.method(fs, method, (file, ...args) => {
      if (!isSharedMaterialPath(file)) return original(file, ...args);
      attempts.push(method);
      throw new Error('意外访问共享路径');
    });
  }
  await saveProject(project, config, catalog);
  const draft = await createDraftStore(directory).create({name:'待授权', config}, catalog);
  const inspect = t.mock.fn(() => { throw new Error('不应探测未授权素材'); });
  await assert.rejects(loadProject(source + '.sdworkbench', undefined, inspect), /请选择本地/);
  await assert.rejects(loadProject(project, undefined, inspect), /先.*导入.*共享素材/);
  await assert.rejects(createDraftStore(directory, undefined, inspect).open(draft.id), /先.*导入.*共享素材/);
  const deny = t.mock.fn(() => { throw new Error('共享素材未在本机登记'); });
  await assert.rejects(loadProject(project, deny, inspect), /未在本机登记/);
  await assert.rejects(createDraftStore(directory, deny, inspect).open(draft.id), /未在本机登记/);
  assert.deepEqual(deny.mock.calls.map(call => call.arguments[0]), [source, source]);
  assert.equal(inspect.mock.callCount(), 0);
  assert.deepEqual(attempts, []);
});

test('a resolved SMB recording reopens as the same source in both projects and cold drafts', {skip:process.platform !== 'win32'}, async t => {
  const root = await testDirectory(t), project = path.join(root, '已选录音.sdworkbench'), directory = path.join(root, '草稿');
  // A loopback share exercises real SMB and ffprobe without assuming an external NAS.
  const drive = path.parse(root).root;
  if (!/^[a-z]:\\$/i.test(drive)) return t.skip('临时目录不在本机盘符上');
  const folder = path.join('\\\\localhost\\' + drive[0] + '$', path.relative(drive, root));
  if (!await fs.stat(folder).then(info => info.isDirectory(), () => false)) return t.skip('此账户没有回环共享读取权限');
  const filename = '同事录音.wav', source = path.join(folder, filename);
  await ffmpeg(['-f','lavfi','-i','sine=frequency=440:duration=0.4','-c:a','pcm_s16le',path.join(root, filename)]);
  const recording = await inspectAsset(source, 'audio');
  const catalog = new Map([['voice', recording]]);
  const config = editingConfig({musicIds:['voice']});
  await saveProject(project, config, catalog);
  const draft = await createDraftStore(directory).create({name:'已选录音', config}, catalog);
  const resolve = t.mock.fn(file => {
    assert.equal(file, source);
    return file;
  });
  for (const opened of [await loadProject(project, resolve), await createDraftStore(directory, resolve).open(draft.id)]) {
    assert.equal(opened.assets.get('voice').path, source);
    assert.equal(opened.assets.get('voice').duration, recording.duration);
    assert.deepEqual(opened.config.musicIds, ['voice']);
  }
  assert.equal(resolve.mock.callCount(), 2);
});

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
  const clip = {id:'edited', start:0, end:.5, speed:2, sourceEdit:{id:'original',ranges}};
  const config = editingConfig({shots:[[clip]], resolution:720, keepAudio:true, subprojects:{
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
  // The reverse cache remains at source speed. Apply the saved rate exactly once at export.
  const plans = planMontage(reopened.config, reopened.assets);
  const {failures, results} = await exportBatch(plans, root);
  assert.deepEqual(failures, []);
  const exported = await inspectAsset(results[0].path, 'video');
  assert.ok(Math.abs(exported.duration - .25) < 1 / config.fps);
  assert.ok(Number.isInteger(exported.audioIndex));
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

test('recent drafts retain auto-fit cuts below 0.5x and above 3x when opened and saved again', async t => {
  const root = await testDirectory(t);
  const video = path.join(root, '片段.mp4');
  await ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=128x72:rate=30', '-t', '4', '-c:v', 'libx264', '-threads', '1', video]);
  const catalog = new Map([['video', await inspectAsset(video, 'video')]]);
  const spans = [1.4460000000000015, .9990000000000023];
  const shots = [.7, 3.466].map((end, index) => [{
    id: 'video', start: 0, end, videoLane: 1, videoStart: index ? spans[0] : 0,
    videoFollowsShot: true, videoDuration: spans[index], videoFit: 'hold',
    speed: end / spans[index], autoFitSpeed: true,
  }]);
  const config = editingConfig({ shots, shotSettings: spans.map(duration => ({ duration })), useMirrors: false, unordered: false });
  const folder = path.join(root, '草稿');
  const draft = await createDraftStore(folder).create({ name: '自动倍速', config }, catalog);
  const cold = createDraftStore(folder);
  const [recent] = await cold.list();
  assert.equal(recent.id, draft.id);
  const opened = await cold.open(recent.id);
  assert.deepEqual(opened.config.shots, shots);
  const saved = await cold.save({ id: recent.id, expectedRevision: opened.revision, config: opened.config }, opened.assets);
  const restored = await createDraftStore(folder).open(saved.id);
  assert.deepEqual(restored.config.shots, shots);
  const [plan] = planMontage(restored.config, restored.assets);
  assert.deepEqual(plan.clips.map(clip => clip.speed), shots.map(([clip]) => clip.speed));
  for (const speed of [0, -1, Infinity, '0.48']) {
    const invalid = { ...config, shots: [[{ ...shots[0][0], speed }], shots[1]] };
    await assert.rejects(cold.save({ id: saved.id, expectedRevision: saved.revision, config: invalid }, catalog), /素材速度无效/);
  }
  assert.deepEqual((await cold.open(saved.id)).config.shots, shots);
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
  const empty=await initial.create({name:'旧稿乙',config},catalog);
  const firstShotCover={mode:'first-shot',active:0,items:[]};
  const second=await initial.save({id:empty.id,expectedRevision:1,config:{...config,cover:firstShotCover}},catalog);
  assert.equal(second.revision,2);
  assert.equal(initial.cover(second.id,2),null,'空分镜暂时没有可取帧的素材');
  assert.deepEqual((await initial.open(second.id)).config.cover,firstShotCover);
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
  const changedDraft = (await cold.list()).find(r=>r.id===first.id);
  assert.equal(changedDraft.name,'外改甲');
  assert.equal(changedDraft.shotCount,1,'列表应从正文计算实际分镜数');
  assert.equal(changedDraft.duration,.75,'缺少时长元数据的旧草稿从现有片段估算时长');
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
  const oldIndex=JSON.parse(await fs.readFile(index,'utf8'));
  oldIndex.version=1;
  for(const row of oldIndex.entries) delete row.meta.shotCount;
  oldIndex.checksum=require('node:crypto').createHash('sha256').update(JSON.stringify(oldIndex.entries)).digest('hex');
  await fs.writeFile(index,JSON.stringify(oldIndex));
  const upgraded=createDraftStore(directory);
  const rows=await upgraded.list();
  assert.equal(rows.find(row=>row.id===first.id).shotCount,1);
  assert.deepEqual(rows.find(row=>row.id===second.id),second,'旧版索引重建后应保留空分镜的首镜封面草稿');
  assert.equal(upgraded.cover(second.id,2),null);
  assert.equal(reads,10,'旧版索引应一次重建，并在随后的启动中复用');
  await createDraftStore(directory).list();
  assert.equal(reads,10);
});

test('incomplete legacy shots keep readable draft metadata and the project validation error',async t=>{
  const directory=await testDirectory(t);
  const store=createDraftStore(directory);
  const cases=[
    [undefined,/分镜或配乐数量无效/],
    [[null],/候选素材数量无效/],
    [[[null]],/无效的素材编号/],
  ];
  for (const [shots,validationError] of cases) {
    const id=require('node:crypto').randomUUID();
    const config=editingConfig({shots});
    const doc={format:'sdworkbench',version:1,assets:[],config,draft:{id,name:'待修复',revision:1,updatedAt:new Date().toISOString()}};
    await fs.writeFile(path.join(directory,id+'.sdworkbench'),JSON.stringify(doc));
    const row=(await store.list()).find(item=>item.id===id);
    assert.equal(row.name,'待修复');
    assert.equal(row.shotCount,shots?.length);
    assert.equal(row.duration,undefined);
    const cold=createDraftStore(directory);
    assert.deepEqual((await cold.list()).find(item=>item.id===id),row);
    await assert.rejects(cold.open(id),validationError);
  }
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

test('v1 and v2 keep saved speeds across active and overridden shots and back up the original bytes once', async t => {
  const root = await testDirectory(t);
  const source = {id:'video', path:path.join(root, 'eight-seconds.mp4'), kind:'video', duration:8, width:32, height:32};
  const base = {id:source.id, start:0, end:8};
  const oldClips = [{...base, speed:1}, {...base, speed:12}, {...base, autoFitSpeed:true, speed:8,
    videoStart:0, videoDuration:1, videoFit:'hold'}, {...base, matchedDuration:2, speed:5}, base];
  const shots = oldClips.map(clip => [clip]);
  const subprojects = {active:'child', main:[{index:0, clips:[oldClips[1]]}],
    projects:[{id:'child', name:'子工程', shots:[{index:0, clips:[oldClips[3]]}]}]};
  for (const [oldVersion, extension] of [[1, 'sdworkbench'], [2, 'jiajian']]) {
    const file = path.join(root, 'old.' + extension);
    const backup = path.join(root, 'old.pre-v4.' + extension);
    const bytes = Buffer.from(JSON.stringify({format:'sdworkbench', version:oldVersion,
      config:editingConfig({shots, subprojects}), assets:[source]}, null, 2) + '\r\n');
    await fs.writeFile(file, bytes);
    const opened = await loadProject(file, undefined, async () => source);
    assert.deepEqual(opened.config.shots.flat().map(clip => [clip.speedMode, clip.speed]),
      [['legacy',1], ['legacy',12], ['legacy',8], ['legacy',5], ['legacy',undefined]]);
    assert.equal(opened.config.subprojects.main[0].clips[0].speedMode, 'legacy');
    assert.equal(opened.config.subprojects.projects[0].shots[0].clips[0].speedMode, 'legacy');
    assert.deepEqual(await fs.readFile(file), bytes);
    await assert.rejects(fs.stat(backup), {code:'ENOENT'});
    const rename = fs.rename;
    const fault = t.mock.method(fs, 'rename', async (from,to) => {
      if (to === file) throw Object.assign(new Error('simulated publication failure'), {code:'EIO'});
      return rename(from,to);
    });
    await assert.rejects(saveProject(file, opened.config, opened.assets, {overwrite:true}), {code:'EIO'});
    fault.mock.restore();
    assert.deepEqual(await fs.readFile(file), bytes);
    assert.deepEqual(await fs.readFile(backup), bytes);
    await Promise.all([1,2].map(() => saveProject(file, opened.config, opened.assets, {overwrite:true})));
    assert.deepEqual(await fs.readFile(backup), bytes);
    assert.equal(JSON.parse(await fs.readFile(file)).version, 4);
    assert.deepEqual((await loadProject(file, undefined, async () => source)).config, opened.config);
    assert.deepEqual((await loadProject(backup, undefined, async () => source)).config, opened.config);
    assert.deepEqual((await fs.readdir(root)).filter(item => item.endsWith('.' + extension)).sort(),
      [path.basename(file), path.basename(backup)].sort());
  }
});

test('legacy projects and cold drafts gain named markers at fixed project seconds and keep independent upgrade backups', async t => {
  const root = await testDirectory(t), catalog = new Map();
  const markers = [{id:'start',name:'片头',time:0}, {id:'cut',name:'换镜',time:1.25}];
  for (const version of [1,2,3]) {
    const legacy = {format:'sdworkbench', version, config:editingConfig(), assets:[]};
    for (const extension of ['jiajian','sdworkbench']) {
      const stem = path.join(root, 'v' + version);
      const file = stem + '.' + extension, preV4 = stem + '.pre-v4.' + extension;
      const preV3 = stem + '.pre-v3.' + extension;
      const oldBytes = Buffer.from(JSON.stringify(legacy, null, 2) + '\r\n');
      await fs.writeFile(file,oldBytes);
      await fs.writeFile(preV3,'earlier T13 backup');
      const {config} = await loadProject(file);
      assert.deepEqual(config.timelineMarkers,[]);
      assert.deepEqual(await fs.readFile(file),oldBytes);
      await assert.rejects(fs.stat(preV4),{code:'ENOENT'});
      await saveProject(file,{...config, timelineMarkers:markers},catalog,{overwrite:true});
      assert.deepEqual((await loadProject(file)).config.timelineMarkers,markers);
      await saveProject(file,{...config, fps:60, timelineMarkers:markers},catalog,{overwrite:true});
      const reopened = (await loadProject(file)).config;
      assert.equal(reopened.timelineMarkers[1].time * reopened.fps,75);
      await saveProject(file,{...reopened,timelineMarkers:[]},catalog,{overwrite:true});
      assert.deepEqual((await loadProject(file)).config.timelineMarkers,[]);
      assert.deepEqual(await fs.readFile(preV4),oldBytes);
      assert.equal(await fs.readFile(preV3,'utf8'),'earlier T13 backup');
      assert.equal(JSON.parse(await fs.readFile(file)).version,4);
    }
    const directory = path.join(root, 'drafts-v' + version);
    const {id} = await createDraftStore(directory).create({name:'旧草稿',config:legacy.config},catalog);
    const file = path.join(directory,id+'.sdworkbench');
    const {draft} = JSON.parse(await fs.readFile(file));
    const bytes = Buffer.from(JSON.stringify({...legacy,draft}));
    await fs.writeFile(file,bytes);
    const store = createDraftStore(directory);
    const opened = await store.open(id);
    assert.deepEqual(opened.config.timelineMarkers,[]);
    assert.deepEqual(await fs.readFile(file),bytes);
    await store.save({id,expectedRevision:opened.revision,config:{...opened.config,timelineMarkers:markers}},catalog);
    assert.deepEqual((await createDraftStore(directory).open(id)).config.timelineMarkers,markers);
    assert.deepEqual(await fs.readFile(path.join(directory,id+'.pre-v4.sdworkbench')),bytes);
  }
});

test('marker validation rejects bad records before replacing the saved project', async t => {
  const root = await testDirectory(t), file = path.join(root,'markers.jiajian'), catalog = new Map();
  const marker = {id:'one',name:'画面',time:0};
  const config = editingConfig({timelineMarkers:[marker]});
  await saveProject(file,config,catalog);
  const saved = await fs.readFile(file);
  for (const rows of [null,[null],[marker,marker],[{...marker,id:''}],[{...marker,name:'\n'}],
    [{...marker,name:' ' }],[{...marker,name:'长'.repeat(101)}],[{...marker,time:-1}],
    [{...marker,time:Infinity}],Array(2001).fill(marker)]) {
    await assert.rejects(saveProject(file,{...config,timelineMarkers:rows},catalog,{overwrite:true}),/标记/);
    assert.deepEqual(await fs.readFile(file),saved);
  }
  const old = {format:'sdworkbench',config:{...config,timelineMarkers:'v3 private extension'},assets:[]};
  for (const version of [1,2,3]) assert.deepEqual(projectReferences({...old,version}).config.timelineMarkers,[]);
  assert.throws(()=>projectReferences({...old,version:4}),/标记/);
});

test('exporting a migrated project with an editor marker preserves the project bytes and the rendered plan', async t => {
  const root = await testDirectory(t), file = path.join(root,'original.jiajian');
  const {red} = await fixtures(root);
  const config = editingConfig({shots:[[{id:'red',start:0,end:.25}]],resolution:720,unordered:false,useMirrors:false});
  const bytes = Buffer.from(JSON.stringify({format:'sdworkbench',version:3,config,assets:[{id:'red',kind:'video',path:red}]}));
  await fs.writeFile(file,bytes);
  const opened = await loadProject(file);
  const baseline = planMontage(opened.config,opened.assets,()=>0);
  const plans = planMontage({...opened.config,timelineMarkers:[{id:'m',name:'课间',time:.125}]},opened.assets,()=>0);
  assert.deepEqual(plans,baseline);
  const {failures,results} = await exportBatch(plans,root);
  assert.equal(failures.length,0);
  assert.equal(results.length,1);
  assert.deepEqual(await fs.readFile(file),bytes);
  await assert.rejects(fs.stat(path.join(root,'original.pre-v4.jiajian')),{code:'ENOENT'});
});

test('v4 preserves all six clip decisions, locked 1x and resolved automatic speed in projects and cold drafts', async t => {
  const root = await testDirectory(t), folder = path.join(root, 'drafts');
  const source = {id:'video', kind:'video', path:path.join(root,'video.mp4'), duration:8, width:32, height:32};
  const catalog = new Map([[source.id,source]]), inspect = async () => source;
  const base = {id:source.id,start:0,end:8};
  const choices = ['trim-start','trim-end','continue','loop','hold','group'];
  const shots = choices.map(speedOverflow => [{...base, speedMode:'auto', speedOverflow, speed:4,
    autoFitSpeed:true, videoStart:0, videoDuration:1, videoFit:'hold'}]);
  shots.push([{...base,speed:1,speedMode:'manual'}], [{...base,speed:1}]);
  const config = editingConfig({shots});
  const store = createDraftStore(folder,undefined,inspect);
  const draft = await store.create({name:'choices',config},catalog);
  const file = path.join(root,'new.jiajian');
  await saveProject(file, config, catalog);
  const cold = createDraftStore(folder,undefined,inspect);
  for (const reopened of [await loadProject(file,undefined,inspect), await cold.open(draft.id)]) {
    assert.deepEqual(reopened.config.shots,shots);
  }
  for (const invalid of [{speedMode:'guessed'},{speedOverflow:'skip'}]) {
    await assert.rejects(saveProject(file, editingConfig({shots:[[{...base,...invalid}]]}), catalog, {overwrite:true}), /无效/);
  }
});

test('old matched narration, implicit speed and fitted placement keep their historic clocks when the window changes', async t => {
  const directory = await testDirectory(t);
  const video = {id:'v',kind:'video',path:path.join(directory,'eight.mp4'),width:32,height:32,duration:8};
  const voice = {id:'n',kind:'audio',path:path.join(directory,'voice.wav')};
  const base = {id:video.id,start:0,end:8};
  const matched = {...base,speed:2,matchedDuration:4};
  const placed = {...base,speed:1,autoFitSpeed:true,videoStart:0,videoFit:'hold',videoFollowsShot:true};
  // Each row records the T12 output: source seconds, effective speed, repetition count.
  const cases = [
    [matched,1,'fill',[8,8,1]], [matched,1,'reference',[2,2,1]],
    [matched,48,'fill',[8,2,12]], [matched,48,'reference',[8,2,12]],
    [base,1,'fill',[8,8,1]], [base,48,'reference',[8,1/6,1]],
    [{...placed,videoDuration:4},1,'fill',[8,2,1]],
    [{...placed,videoDuration:1},1,'fill',[8,8,1]],
    [{...placed,videoDuration:48},48,'reference',[8,1/6,1]],
  ];
  for (const version of [1,2]) for (const [clip,duration,voiceAlignment,expected] of cases) {
    const old = {format:'sdworkbench',version,assets:[video,voice],
      config:editingConfig({shots:[[clip]],priority:'voice',narrationMode:'segmented',segmentNarrationIds:[['n']],voiceAlignment})};
    const {config} = projectReferences(old);
    const catalog = new Map([['v',video],['n',{...voice,duration}]]);
    const file = path.join(directory,'migrated.jiajian');
    await saveProject(file,config,catalog,{overwrite:true});
    const reopened = await loadProject(file,undefined,async file => file === video.path ? video : {...voice,duration});
    for (const state of [config,reopened.config]) {
      const [plan] = planMontage({...state,autoSpeedRange:{min:.25,max:4}},catalog,()=>0);
      assert.equal(plan.speedChallenges?.length ?? 0,0,'重开和改动窗口应沿用旧工程的播放规则');
      const [picture] = plan.clips;
      assert.equal(picture.outputFrames,duration*state.fps);
      assert.deepEqual(picture.visuals.map(part => [part.sourceDuration,part.speed,part.repeat ?? 1]),[expected]);
    }
  }
});

test('upgrading a cold draft aborts on a backup conflict and permits only one save of the same revision', async t => {
  const directory = await testDirectory(t), config = editingConfig(), catalog = new Map();
  const {id} = await createDraftStore(directory).create({name:'旧草稿',config},catalog);
  const file = path.join(directory,id + '.sdworkbench'), backup = path.join(directory,id + '.pre-v4.sdworkbench');
  const document = JSON.parse(await fs.readFile(file));
  const old = Buffer.from(JSON.stringify({...document,version:1}));
  await fs.writeFile(file,old);
  const stores = [createDraftStore(directory),createDraftStore(directory)];
  const [opened] = await Promise.all(stores.map(store => store.open(id)));
  const request = {id, config:opened.config, expectedRevision:opened.revision};
  const otherBackup = JSON.stringify({...document,version:1, draft:{...document.draft,name:'另一份备份'}});
  await fs.writeFile(backup,otherBackup);
  await assert.rejects(stores[0].save(request,catalog), /备份/);
  assert.deepEqual(await fs.readFile(file),old);
  assert.equal(await fs.readFile(backup,'utf8'),otherBackup);
  await fs.unlink(backup);
  const results = await Promise.allSettled(stores.map(store => store.save(request,catalog)));
  assert.equal(results.filter(result => result.status === 'fulfilled').length,1);
  assert.match(results.find(result => result.status === 'rejected').reason.message,/草稿已更新/);
  assert.deepEqual(await fs.readFile(backup),old);
  assert.equal(JSON.parse(await fs.readFile(file)).version,4);
  const cold = createDraftStore(directory);
  assert.deepEqual((await cold.list()).map(item => item.id),[id]);
  assert.equal((await cold.open(id)).revision,opened.revision + 1);
});

test('on a volume without hard links, a complete backup survives a failed upgrade and draft removal and can be restored', async t => {
  const directory = await testDirectory(t), config = editingConfig(), catalog = new Map();
  const {id} = await createDraftStore(directory).create({name:'旧草稿',config},catalog);
  const file = path.join(directory,id + '.sdworkbench');
  const backup = path.join(file + '.pre-v4',path.basename(file));
  const document = JSON.parse(await fs.readFile(file));
  const original = Buffer.from(JSON.stringify({...document,version:1},null,2) + '\r\n');
  await fs.writeFile(file,original);
  const cold = createDraftStore(directory);
  const opened = await cold.open(id);
  const request = {id,config:opened.config,expectedRevision:opened.revision};
  t.mock.method(fs,'link',async () => { throw Object.assign(new Error('hard links unsupported'),{code:'ENOTSUP'}); });
  const rename = fs.rename;
  const fault = t.mock.method(fs,'rename',async (from,to) => {
    if (to === file) throw Object.assign(new Error('simulated publication failure'),{code:'EIO'});
    return rename(from,to);
  });
  await assert.rejects(cold.save(request,catalog), {code:'EIO'});
  fault.mock.restore();
  assert.deepEqual(await fs.readFile(file),original);
  assert.deepEqual(await fs.readFile(backup),original);
  const saved = await cold.save(request,catalog);
  assert.equal(saved.revision,opened.revision + 1);
  assert.equal(JSON.parse(await fs.readFile(file)).version,4);
  assert.deepEqual((await createDraftStore(directory).list()).map(row => row.id),[id]);
  await cold.remove({id,expectedRevision:saved.revision});
  assert.deepEqual(await createDraftStore(directory).list(),[]);
  assert.deepEqual(await fs.readFile(backup),original);
  assert.deepEqual((await loadProject(backup)).config,opened.config);
  await fs.copyFile(backup,file,fs.constants.COPYFILE_EXCL);
  const restored = await createDraftStore(directory).open(id);
  assert.equal(restored.revision,opened.revision);
  assert.equal(restored.name,opened.name);
  assert.deepEqual(restored.config,opened.config);
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
  await fs.writeFile(file, JSON.stringify({ ...saved, version: 5 }));
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
