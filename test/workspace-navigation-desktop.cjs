'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { app } = require('electron');
const { launchDesktop } = require('../src/desktop.cjs');
const { clickVisible } = require('./desktop-input.cjs');
const { ffmpeg } = require('./fixtures.cjs');

app.disableHardwareAcceleration();

async function run() {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'jiajian-navigation-'));
  const movie = path.join(folder, '剪辑样片.mp4');
  const project = path.join(folder, '剪辑样片.sdworkbench');
  await ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=24', '-t', '1', '-c:v', 'libx264', '-threads', '2', movie]);
  let pick;
  let pickerCalls = 0;
  const win = await launchDesktop({ show: false, dataDirectory: path.join(folder, 'profile'), dialogs: {
    async showOpenDialog() {
      pickerCalls++;
      const choice = pick;
      pick = undefined;
      return { canceled: !choice, filePaths: choice ? [choice] : [] };
    },
    async showSaveDialog() { return { canceled: false, filePath: project }; },
  } });
  const wc = win.webContents;
  wc.debugger.attach();
  const read = code => wc.executeJavaScript(code, true);
  const click = selector => clickVisible(wc, selector);
  const current = "(document.querySelector('.app-frame').dataset.mode)";
  const frame = 'document.documentElement';
  const arrival = frame + ".getAnimations({subtree:true}).filter(a => a.animationName === 'workspace-depart')";
  const media = (motion, colors = 'none') => wc.debugger.sendCommand('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: motion }, { name: 'forced-colors', value: colors }],
  });
  async function wait(code, description) {
    const end = Date.now() + 10000;
    while (!await read(code)) {
      if (Date.now() > end) throw new Error(description);
      await delay(12);
    }
  }
  async function capture(label) {
    if (!process.env.JIAJIAN_NAVIGATION_FRAMES) return;
    await read("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    await fs.mkdir(process.env.JIAJIAN_NAVIGATION_FRAMES, { recursive: true });
    await fs.writeFile(path.join(process.env.JIAJIAN_NAVIGATION_FRAMES, label + '.png'), (await wc.capturePage()).toPNG());
  }
  async function midpoint() {
    await wait(arrival + '.length === 1', '应有原生页面快照动画');
    return read(`(() => {
      const [old] = ${arrival};
      old.pause();
      old.currentTime = 95;
      return Number(getComputedStyle(${frame}, old.effect.pseudoElement).opacity);
    })()`);
  }
  try {
    await media('no-preference');
    await wc.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    await wc.debugger.sendCommand('Animation.enable');
    await wc.debugger.sendCommand('Animation.setPlaybackRate', { playbackRate: .2 });
    await read("window.originalPlayer = document.querySelector('#preview')");
    await click('#home-open-project');
    await wait("!document.querySelector('#home-open-project').disabled", '取消选择工程后应恢复首页');
    assert.equal(await read(current), 'home');
    assert.equal(await read('document.activeElement.id'), 'home-open-project');
    assert.equal(await read(arrival + '.length'), 0);
    await capture('01-home');

    await read(`(async () => {
      document.querySelector('#home-import').click();
      const pending = document.activeViewTransition.updateCallbackDone;
      document.querySelector('#title-home').click();
      await pending;
    })()`);
    assert.equal(await read(current), 'home');
    assert.equal(pickerCalls, 1, '已取消的导航不应再弹出素材选择框');

    await click('#home-create');
    await wait(current + " === 'montage'", '新建应进入剪辑台');
    assert.equal(await read('document.activeElement.id'), 'workflow-title');
    const oldOpacity = await midpoint();
    assert.ok(oldOpacity > .2 && oldOpacity < .8);
    assert.ok(await read("document.querySelector('#editor-workspace').checkVisibility({opacityProperty:true})"));
    await capture('02-editor-arriving');
    await click('#title-home');
    await wait(current + " === 'home'", '过渡途中返回应正常生效');
    await midpoint();
    assert.equal(await read('document.activeElement.id'), 'home-heading');
    await capture('03-home-returning');
    await media('reduce');
    await wait(arrival + '.length === 0', '开启减少动态应立即停止正在播放的动画');
    await click('#home-create');
    await wait(current + " === 'montage'", '减少动态下应直接进入');
    assert.equal(await read(arrival + '.length'), 0);
    await click('#title-home');
    await media('no-preference', 'active');
    await click('#home-create');
    await wait(current + " === 'montage'", '强制色下应直接进入');
    assert.equal(await read(arrival + '.length'), 0);
    await media('no-preference');

    pick = movie;
    await click('#empty-import-visual');
    await wait("document.querySelector('#shots .asset') && !document.querySelector('#save-project').disabled", '应能立即导入视频');
    await click('#save-project');
    await wait("!document.querySelector('#save-project').disabled", '应保存真实工程');
    await fs.access(project);
    await click('#title-home');
    await wait("document.querySelector('.draft-cover img')?.naturalWidth > 0", '首页应载入草稿的真实视频封面');
    await click('.draft-open');
    await wait(current + " === 'montage' && document.querySelector('#preview').readyState >= 2", '打开草稿后原始视频应可解码');
    assert.ok(await read("originalPlayer === document.querySelector('#preview') && originalPlayer.videoWidth === 320"));
    assert.ok(await read("document.querySelector('#editor-workspace').contains(document.activeElement)"));
    assert.ok(await read("getComputedStyle(document.querySelector('#editor-workspace')).transform === 'none'"));
    await click('#title-home');
    await wait(current + " === 'home' && !document.querySelector('.draft-cover-transition')", '返回时应清理草稿封面过渡');
    pick = project;
    await click('#home-open-project');
    await wait(current + " === 'montage' && originalPlayer.readyState >= 2", '打开磁盘工程后原始视频应可解码');
    assert.equal(await read('document.activeElement.id'), 'workflow-title');
    assert.ok(await read("originalPlayer === document.querySelector('#preview') && document.querySelectorAll('#preview').length === 1"));
    await wait(arrival + '.length === 0', '动画结束后页面应恢复稳定');
    await capture('04-project-open');
    await media('reduce');
    await click('#title-home');
    win.setSize(850, 600);
    await wait('innerWidth <= 850', '窗口应缩小至支持的最小宽度');
    const focused = selector => read('document.activeElement.matches(' + JSON.stringify(selector) + ')');
    for (const [tool, heading] of [
      ['#tab-montage', '#project-workspace h1'], ['#tab-scene-split', '#scene-split-title'],
      ['#tab-audio', '#workflow-title'], ['#tab-script', '#script-workspace h1'],
    ]) {
      await click(tool);
      assert.ok(await focused(heading), tool + ' 打开后应聚焦页面标题');
      await click(tool === '#tab-script' ? '#script-back' : '#title-home');
      assert.ok(await focused(tool), '返回后应聚焦原来的工具入口 ' + tool);
      assert.ok(await read(`(() => {
        const {left, right, top, bottom} = document.activeElement.getBoundingClientRect();
        const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
        return left >= 0 && right <= innerWidth && top >= 0 && bottom <= innerHeight && document.activeElement.contains(hit);
      })()`), '恢复焦点的入口应在小窗口内可见');
    }
    await click('[data-workflow=tasks]');
    await wait(current + " === 'workflow'", '应打开任务中心');
    assert.ok(await focused('#service-title'));
    await click('#service-actions button');
    assert.ok(await focused('#recent-heading'), '查看本地导出应把键盘焦点带到结果');
    await read(`(async () => {
      document.querySelector('[data-workflow=replicate]').click();
      document.querySelector('#tab-drafts').click();
      await window.workbench.creativeSettings();
      await window.workbench.workflows();
    })()`);
    assert.equal(await read(current), 'drafts', '迟到的创作服务响应不应覆盖最后一次导航');
    assert.ok(await focused('#draft-heading'));
    await click('#title-home');
    await click('#tab-script');
    await click('.script-dialogue');
    await wc.insertText('导航回归台词');
    await click('#script-go-montage');
    await click('#edit-attached-script');
    assert.equal(await read('document.querySelector("#script-back").title'), '返回视频混剪');
    await click('.script-dialogue');
    await wc.insertText('已修改');
    await click('#script-back');
    assert.equal(await read(current), 'montage');
    assert.ok(await focused('#edit-attached-script'));
    assert.ok(await read('document.querySelector("#script-brief-rows").textContent.includes("已修改")'),
      '从剪辑台返回时应同步已编辑脚本');
    console.log('首页与各工作区往返、快速返回、减少动态、强制色、最小窗口、真实草稿与关联脚本通过。');
  } finally {
    wc.debugger.detach();
    win.destroy();
  }
}

run().then(() => app.exit(0), error => { console.error(error); app.exit(1); });
