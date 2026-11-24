'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { app } = require('electron');
const { launchDesktop } = require('../src/desktop.cjs');
const { inspectAsset } = require('../src/media.cjs');
const { saveProject, loadProject } = require('../src/project-format.cjs');
const { ffmpeg } = require('./fixtures.cjs');

app.disableHardwareAcceleration();

async function run() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jiajian-voice-match-'));
  app.setPath('userData', path.join(root, 'electron'));
  const clips = ['red', 'green'], voices = ['voice-one', 'voice-two'];
  const catalog = new Map(await Promise.all([...clips, ...voices].map(async (id, index) => {
    const visual = index < clips.length;
    const file = path.join(root, id + (visual ? '.mp4' : '.wav'));
    const source = visual ? 'color=' + ['red', 'green'][index] + ':s=160x90:r=24:d=4'
      : 'sine=frequency=440:duration=' + (voices.indexOf(id) + 1);
    await ffmpeg(['-f', 'lavfi', '-i', source, ...(visual ? ['-c:v', 'libx264', '-threads', '1'] : []), file]);
    return [id, await inspectAsset(file, visual ? 'video' : 'audio')];
  })));
  const before = [[4, 3], [4, 2.5], [3.5]];
  const original = path.join(root, '分段原稿.sdworkbench');
  const saved = path.join(root, '匹配后.sdworkbench');
  await saveProject(original, {
    ratio: '16:9', resolution: 720, fps: 24, fit: 'fit', keepAudio: true, count: 1,
    unordered: false, useOriginal: true, useMirrors: false, priority: 'voice', voiceAlignment: 'fill',
    musicIds: [], musicVolume: 50, narrationMode: 'segmented', segmentNarrationIds: [[voices[0]], [voices[1]], []],
    shots: before.map(values => values.map((end, index) => ({ id: clips[index], start: 0, end, speed: 1 }))),
  }, catalog);
  // 0.8.0 stores a fixed shot duration separately from the complete source interval.
  const legacy = path.join(root, '旧版手动工程.sdworkbench');
  const legacyDraft = { id: randomUUID(), name: '旧版本地草稿', updatedAt: new Date().toISOString(), revision: 1 };
  const legacyDoc = {
    format: 'sdworkbench', version: 1,
    config: {
      ratio: '16:9', resolution: 720, fps: 24, fit: 'fit', keepAudio: true, count: 1,
      unordered: false, useOriginal: true, useMirrors: false, priority: 'voice', voiceAlignment: 'fill',
      musicIds: [], musicVolume: 50, narrationMode: 'segmented', segmentNarrationIds: [[voices[0]]],
      shotSettings: [{ duration: 1 }], shots: [[{ id: clips[0], start: 0, end: 4, speed: 1 }]],
    },
    assets: [clips[0], voices[0]].map(id => ({ id, kind: catalog.get(id).kind, path: catalog.get(id).path })),
  };
  const localDraftDir = path.join(root, 'profile', 'drafts');
  await fs.mkdir(localDraftDir, { recursive: true });
  await fs.writeFile(legacy, JSON.stringify(legacyDoc));
  await fs.writeFile(path.join(localDraftDir, legacyDraft.id + '.sdworkbench'), JSON.stringify({ ...legacyDoc, draft: legacyDraft }));
  const opens = [legacy, original, saved];
  const win = await launchDesktop({ show: false, dataDirectory: path.join(root, 'profile'), dialogs: {
    async showOpenDialog(_win, options) {
      assert.equal(options.title, '打开工程');
      assert.ok(opens.length);
      return { canceled: false, filePaths: [opens.shift()] };
    },
    async showSaveDialog(_win, options) {
      assert.equal(options.title, '保存工程');
      return { canceled: false, filePath: saved };
    },
  } });
  win.setContentSize(1560, 960);
  const wc = win.webContents;
  wc.setBackgroundThrottling(false);
  wc.debugger.attach();
  const read = expr => wc.executeJavaScript(expr, true);
  const node = selector => 'document.querySelector(' + JSON.stringify(selector) + ')';
  const menu = label => 'Array.from(document.querySelectorAll(".sequence-dialog[open] button")).find(b => b.textContent.trim() === ' + JSON.stringify(label) + ')';
  const candidate = (shot, row) => node('.sequence-video [data-drop-shot="' + shot + '"][data-candidate-index="' + row + '"]');
  const shotHeader = shot => node('.sequence-shots [data-reorder-shot][data-drop-shot="' + shot + '"]');
  async function wait(expr, label) {
    for (const limit = Date.now() + 9000; Date.now() < limit;) {
      if (await read(expr)) return;
      await delay(30);
    }
    throw new Error(label + ' / ' + await read(node('#notice') + '.textContent'));
  }
  async function click(expr, button = 'left',clickCount=1) {
    const position = await read('(async () => {let el=' + expr
      + '; if (!el?.checkVisibility() || el.disabled) return null; el.scrollIntoView({block:"nearest",inline:"nearest",behavior:"instant"});'
      + 'await new Promise(requestAnimationFrame);el='+expr+';if(!el?.checkVisibility() || el.disabled) return null;const r=el.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;'
      + 'return el.contains(document.elementFromPoint(x,y)) ? {x,y} : null;})()');
    assert.ok(position, '无法点击 ' + expr);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...position, button, clickCount,
        buttons: type === 'mouseReleased' ? 0 : button === 'right' ? 2 : 1 });
    }
  }
  const displayed = 'Array.from(document.querySelectorAll(".sequence-shots [data-reorder-shot]"), (_, i) => '
    + 'Array.from(document.querySelectorAll(\'.sequence-video [data-drop-shot="\' + i + \'"][data-move-candidate]\'), n => Number(n.dataset.playbackDuration)))';
  async function verify(expected,label) {
    await wait('JSON.stringify(' + displayed + ') === ' + JSON.stringify(JSON.stringify(expected)), label);
    assert.ok(await read('[...document.querySelectorAll(".sequence-video .sequence-clip-duration")].every(n=>n.textContent==="4.00 秒")'),'匹配和裁剪后显示四秒原片');
  }
  const all = [[1, 1], [2, 2], [3.5]];
  const single = '匹配口播时长', group = '匹配本分镜全部候选';

  async function verifyLegacyPlayback(label) {
    await wait(candidate(0, 0) + '?.checkVisibility() && !' + node('#open-project') + '.disabled', '载入' + label);
    // Focus the timeline as with Tab, without selecting a clip, matching or editing the draft.
    await read(node('#timeline-clock') + '.focus()');
    const key = { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 };
    const probe = read(`new Promise(resolve => {
      let maxTime = 0, rate = 0;
      const started = performance.now();
      const timer = setInterval(() => {
        const video = document.querySelector('.draft-transport-preview:not([hidden]) video');
        if (video && video.readyState >= 2 && (rate || !video.paused)) {
          maxTime = Math.max(maxTime, video.currentTime);
          rate = video.playbackRate;
        }
        if ((maxTime > 3.75 && (!video || video.paused)) || performance.now() - started > 6500) {
          clearInterval(timer);
          resolve({ rate, maxTime });
        }
      }, 10);
    })`);
    await wc.debugger.sendCommand('Input.dispatchKeyEvent', { ...key, type: 'keyDown', text: ' ' });
    await wc.debugger.sendCommand('Input.dispatchKeyEvent', { ...key, type: 'keyUp' });
    const observed = await probe;
    assert.equal(observed.rate, 4, label + '打开后空格应直接四倍速试播。实际 ' + JSON.stringify(observed));
    assert.ok(observed.maxTime > 3.75, label + '应播放到原片最后 0.25 秒。实际 ' + JSON.stringify(observed));
    assert.equal(await read(node('#preview-batch-list') + '.childElementCount'), 0, label + '直接空格应保留实时轨道试播');
    console.log(label + '直接空格试播', observed);
  }

  try {
    await click(node('#home-open-project'));
    await verifyLegacyPlayback('旧版手动工程');
    await click(node('#title-home'));
    const localCard = node('.draft-open[title="旧版本地草稿"]');
    await wait(localCard + '?.checkVisibility()', '首页应列出旧版本地草稿');
    await click(localCard);
    await verifyLegacyPlayback('旧版本地草稿');
    await click(node('#open-project'));
    await verify(before, '应打开三个分镜和五个候选');
    const setTrackView=view=>read('(()=>{const field='+node('#timeline-view')+';field.value='+JSON.stringify(view)+';field.dispatchEvent(new Event("change"))})()');
    await setTrackView('cards');
    const cardPreview=node('#visual-track-lane .shot .shot-poster');
    await wait(cardPreview+'?.checkVisibility()', '分镜卡片显示视频封面');
    await read('window.cardRightClick=false;window.addEventListener("contextmenu",event=>{window.cardRightClick=event.isTrusted && event.defaultPrevented},{once:true})');
    await click(cardPreview,'right');
    assert.ok(await read('window.cardRightClick && !document.querySelector("dialog[open],#video-track-menu:popover-open")'),'分镜卡片封面右击应保留原有行为');
    await click(cardPreview);
    win.setContentSize(1000,720);
    for (const theme of ['dark','light']) {
      await wc.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:theme},{name:'prefers-reduced-motion',value:'reduce'}]});
      await wait('document.documentElement.dataset.theme==='+JSON.stringify(theme),'工作区切换主题');
      await click(node('#track-more'));
      await click(node('#clip-actions'));
      await click(menu('候选包装'));
      await wait(node('.sequence-dialog[open] select')+'?.value==="local"','紧凑窗口从编辑工具进入当前候选包装');
      await click(menu('关闭'));
    }
    win.setContentSize(1560,960);
    await setTrackView('time');
    await wait(candidate(2, 0)+'?.checkVisibility()', '切回时间线');
    await click(node('#track-more'));
    await click(node('#timeline-fit'));
    if (await read(node('#track-more-options')+'.matches(":popover-open")')) await click(node('#track-more'));
    await click(candidate(2, 0));
    await wait(candidate(2,0)+'.matches(".sequence-marked")','第三镜候选已选中');
    await click(node('#track-more'));
    await click(node('#clip-actions'));
    await wait(menu(single) + '?.disabled', '缺少口播的候选应禁用匹配');
    assert.match(await read(node('.sequence-dialog[open]') + '.textContent'), /还没有分段口播/);
    await read(node('.sequence-dialog[open]') + '.close()');
    await click(candidate(0, 0));
    await click(node('#track-more'));
    await click(node('#clip-actions'));
    await click(menu(single));
    await verify([[1, 3], [4, 2.5], [3.5]], '候选操作只应将所选的四秒候选匹配为一秒');
    await click(node('#track-undo'));
    await verify(before, '撤销候选匹配');
    await click(shotHeader(0), 'right');
    assert.ok(await read('!document.querySelector("dialog[open],:popover-open")'),'分镜右键保留为空');
    await click(shotHeader(0), 'left', 2);
    await click(menu(group));
    await verify([[1, 1], [4, 2.5], [3.5]], '分镜属性应匹配本镜内两条候选');
    await click(node('#track-undo'));
    await verify(before, '一次撤销应恢复整个分镜');
    await click(node('#match-all-voice-duration'));
    await verify(all, '一键匹配应按各自口播长度处理并跳过第三镜');
    const summary = await read(node('#notice') + '.textContent');
    assert.match(summary, /已匹配 4 条候选/);
    assert.match(summary, /1 个分镜缺少口播/);
    await click(node('#track-undo'));
    await verify(before, '一次撤销应恢复全工程');
    await click(node('#track-redo'));
    await verify(all, '重做应恢复两镜匹配');
    await click(node('#save-project'));
    await wait(node('#notice') + '.textContent.includes("工程已保存")', '应保存匹配工程');
    const { config } = await loadProject(saved);
    assert.deepEqual(config.shots.map(shot => shot.map(clip => clip.end - clip.start)), before, '保留完整的画面区间');
    assert.deepEqual(config.shots.map(shot => shot.map(clip => clip.speed ?? 1)), [[4, 3], [2, 1.25], [1]]);
    assert.deepEqual(config.shots.map(shot => shot.map(clip => clip.matchedDuration)), [[1, 1], [2, 2], [undefined]]);
    await click(node('#open-project'));
    await wait(node('#notice') + '.textContent.includes("已打开工程")', '从磁盘打开匹配工程');
    await verify(all, '草稿重开应显示匹配后时长');
    assert.deepEqual(opens, []);
    console.log('三个匹配口播入口、四倍速、跳过无口播、整步撤销重做及工程重开通过。');
  } finally {
    wc.debugger.detach();
    win.destroy();
  }
}
run().then(() => app.exit(0), error => { console.error(error); app.exit(1); });
