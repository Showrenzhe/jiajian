'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { app } = require('electron');
const { launchDesktop } = require('../src/desktop.cjs');
const { createDraftStore } = require('../src/draft-store.cjs');
const { inspectAsset } = require('../src/media.cjs');
const { clickVisible } = require('./desktop-input.cjs');
const { ffmpeg } = require('./fixtures.cjs');

app.disableHardwareAcceleration();

async function run() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jiajian-combinations-'));
  const profile = path.join(root, 'profile');
  app.setPath('userData', profile);
  const catalog = new Map(await Promise.all(['red', 'blue'].map(async (id) => {
    const file = path.join(root, id + '.png');
    await ffmpeg(['-f', 'lavfi', '-i', 'color=' + id + ':s=64x64', '-frames:v', '1', '-threads', '1', '-update', '1', file]);
    return [id, await inspectAsset(file, 'image')];
  })));
  const shots = Array.from({ length: 60 }, () => [...catalog.keys()].map((id) => ({ id, start: 0, end: 1 })));
  const drafts=createDraftStore(path.join(profile,'drafts'));
  await drafts.create({ name: '60 组双候选', config: {
    shots, count: 1, useOriginal: true, useMirrors: false, unordered: false,
    ratio: '16:9', resolution: 720, fps: 24, fit: 'fit', keepAudio: false, musicIds: [], musicVolume: 40,
  } }, catalog);
  for (const [id,hz] of [['A',440],['B',880]]) {
    const file=path.join(root,id+'.wav');
    await ffmpeg(['-f','lavfi','-i','sine=frequency='+hz+':duration=1',file]);
    catalog.set(id,await inspectAsset(file,'audio'));
  }
  const caption=text=>({name:text+'.srt',cues:[{start:0,end:500,text}]});
  await drafts.create({name:'口播 A B',config:{
    shots:[shots[0]],count:1,useOriginal:true,useMirrors:false,unordered:false,
    ratio:'16:9',resolution:720,fps:24,fit:'fit',keepAudio:false,musicIds:[],musicVolume:40,
    narrationId:'A',subtitles:caption('字幕 A'),extraWholeTracks:[{narrationId:'B',subtitles:caption('字幕 B')}],
  }},catalog);
  const win = await launchDesktop({ show: false, dataDirectory: profile });
  const contents = win.webContents;
  contents.setBackgroundThrottling(false);
  const read = (code) => contents.executeJavaScript(code, true);
  async function waitFor(code, message) {
    const until = Date.now() + 20000;
    while (!await read(code)) {
      if (Date.now() >= until) throw new Error(message);
      await delay(40);
    }
  }
  try {
    win.setContentSize(1400, 960);
    await waitFor('!!document.querySelector(".draft-open")', '草稿未载入');
    await clickVisible(contents, '.draft-open[title="60 组双候选"]');
    await waitFor('document.querySelectorAll("#shots .shot").length === 60', '草稿未恢复 60 组分镜');
    await clickVisible(contents, '#inspector-tab-montage');
    assert.equal(await read('document.querySelector("#combinations").innerText'),
      '可生成 1,152,921,504,606,846,976 种不重复组合。每批最多 1,000 条。');
    assert.equal(await read('document.querySelector("#count").max'), '1000');
    await clickVisible(contents, '#count');
    await read('document.querySelector("#count").select()');
    await contents.insertText('81');
    assert.equal(await read('document.querySelector("#count").valueAsNumber'), 81);
    assert.ok(await read('document.querySelector("#count").checkValidity() && !document.querySelector("#prepare-preview").disabled'));
    const click=selector=>clickVisible(contents,selector);
    const card='.draft-open[title="口播 A B"]';
    const toggle=lane=>'[data-control-key="'+lane+'"] [data-track-action="disabled"]';
    const element=selector=>'document.querySelector('+JSON.stringify(selector)+')';
    const reachable=selector=>'(()=>{const b='+element(selector)+';if(!b?.checkVisibility() || b.disabled)return false;const r=b.getBoundingClientRect();return b.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));})()';
    async function openVoiceDraft() {
      await click('#title-home');
      await waitFor(reachable(card),'显示可打开的双口播草稿');
      await click(card);
    }
    await openVoiceDraft();
    const max=expected=>waitFor(element('#count')+'.max==="'+expected+'"','有效组合数应为 '+expected);
    await max(4);
    await click(toggle('vis0'));await max(2);
    await click(toggle('whole0'));await max(1);
    await click('#track-undo');await max(2);
    await click('#track-redo');await max(1);
    await click(toggle('vis1'));await waitFor(element('#prepare-preview')+'.disabled','全部视频轨禁用时应提示');
    assert.match(await read(element('#combinations')+'.textContent'),/分镜 1.*启用/);
    await click(toggle('vis1'));await max(1);
    await click(toggle('caption1'));await max(1);
    await waitFor(element('#draft-save-status')+'.dataset.state==="saved"','自动草稿写入轨道状态');
    await openVoiceDraft();
    await waitFor(element(toggle('caption1'))+'?.ariaPressed==="true"','草稿重开恢复字幕禁用');
    for(const lane of ['whole0','vis0']) assert.equal(await read(element(toggle(lane))+'.ariaPressed'),'true');
    async function verifyBatch(picture,voice,subtitles) {
      await waitFor(reachable('#prepare-preview'),'双候选草稿可生成预览');
      await click('#prepare-preview');
      const row='#preview-batch-list li';
      await waitFor(element(row+' .batch-narration')+'?.textContent.includes('+JSON.stringify(voice)+')','重新生成选定口播');
      assert.match(await read(element(row+' .batch-clips')+'.textContent'),new RegExp(picture));
      assert.equal(await read(element(row+' .batch-subtitles')+'.hidden'),!subtitles);
      if(subtitles) assert.match(await read(element(row+' .batch-subtitles')+'.textContent'),new RegExp(subtitles));
      await click('#timeline-tracks-tab');
    }
    await verifyBatch('blue','B.wav',null);
    await click(toggle('vis0'));await click(toggle('vis1'));await click(toggle('whole0'));await click(toggle('whole1'));
    await max(1);
    await verifyBatch('red','A.wav','字幕 A');
    console.log('60 组组合数、轨道禁用与撤销、草稿重开和 A/B 口播成片选择通过。');
  } finally {
    win.destroy();
  }
}

run().then(() => app.exit(0), (error) => { console.error(error); app.exit(1); });
