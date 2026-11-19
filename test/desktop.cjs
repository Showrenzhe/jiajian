'use strict';

const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { once } = require('node:events');
const { mkdirSync, mkdtempSync } = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { promisify } = require('node:util');
const { app } = require('electron');
const { launchDesktop } = require('../src/desktop.cjs');
const { inspectAsset } = require('../src/media.cjs');
const { ffmpeg, fixtures } = require('./fixtures.cjs');

app.disableHardwareAcceleration();

const execFileAsync = promisify(execFile);

async function runDraftPhase(phase, root, video, narration) {
  const creating = phase === 'draft-create';
  const profile = path.join(root, 'draft-profile');
  const selections = creating ? [
    { title: '选择分镜素材', file: video },
    { title: '选择口播音频', file: narration },
  ] : [];
  const win = await launchDesktop({
    show: false,
    dataDirectory: profile,
    dialogs: {
      async showOpenDialog(_window, options) {
        const next = selections.shift();
        assert.equal(options.title, next?.title);
        return { canceled: false, filePaths: [next.file] };
      },
      async showSaveDialog() { throw new Error('自动草稿流程不应打开保存对话框'); },
    },
  });
  const evaluate = (expression) => win.webContents.executeJavaScript(expression, true);
  const click = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  async function waitFor(expression, message) {
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      if (await evaluate(expression)) return;
      await delay(50);
    }
    const notice = await evaluate('document.querySelector("#notice").textContent');
    throw new Error(`${message}: ${notice}`);
  }
  const openNarration = () => evaluate(`(() => {
    document.querySelector('#inspector-tab-narration').click();
    if (!document.querySelector('#whole-track-settings').open) document.querySelector('#whole-track-summary').click();
  })()`);
  const narrationRestored = `document.querySelector('#narration-name').textContent.includes(${JSON.stringify(path.basename(narration))})`;
  if (creating) {
    await click('#home-create');
    await waitFor('!document.querySelector("#editor-workspace").hidden && !document.querySelector("#import-materials").disabled', '首页新建应直接进入可编辑的空草稿');
    await click('#empty-import-visual');
    await waitFor('document.querySelectorAll("#shots .asset").length === 1', '应导入原始视频');
    assert.ok(await evaluate('[...document.querySelectorAll("#shots-empty button")].every((button) => !button.checkVisibility())'), '导入素材后应隐藏时间轴空状态入口');
    await openNarration();
    await click('#pick-narration');
    await waitFor(narrationRestored, '应添加本地口播');
    assert.deepEqual(selections, []);
    await evaluate(`for (const [selector, value] of [['#shots .start', '0.35'], ['#shots .end', '1.20']]) {
      const input = document.querySelector(selector);
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }`);
  } else {
    const draftDirectory = path.join(profile, 'drafts');
    const [draftFile, ...duplicates] = (await fs.readdir(draftDirectory)).filter((name) => name.endsWith('.sdworkbench'));
    assert.ok(draftFile && duplicates.length === 0, '应只写入一个自动草稿快照');
    const snapshot = JSON.parse(await fs.readFile(path.join(draftDirectory, draftFile), 'utf8'));
    assert.deepEqual(snapshot.assets.map(({ path: file }) => file).sort(), [video, narration].sort(), '草稿应保留视频和口播原始路径');
    await waitFor('document.querySelectorAll("#draft-list .draft-open").length === 1', '重启后首页应列出未手动保存的草稿');
    await waitFor('document.querySelector("#draft-list .draft-cover img")?.naturalWidth > 0', '重启后草稿应显示原视频封面');
    await click('#draft-list .draft-open');
    await waitFor('!document.querySelector("#editor-workspace").hidden && document.querySelectorAll("#shots .asset").length === 1', '点击草稿应恢复原编辑器与分镜');
    const trim = await evaluate('[document.querySelector("#shots .start").valueAsNumber, document.querySelector("#shots .end").valueAsNumber]');
    assert.deepEqual(trim, [0.35, 1.2], '关闭前最后的裁剪必须跨进程重启保留');
    await click('#shots .preview-asset');
    await waitFor(`document.querySelector('#preview-name').textContent === ${JSON.stringify(path.basename(video))} && document.querySelector('#preview').readyState >= 2`, '重启后原始视频应可解码预览');
    await openNarration();
    await waitFor(narrationRestored, '应恢复原口播');
    await click('#review-narration');
    await waitFor('document.querySelector("#narration-review").open && document.querySelector("#narration-review-audio").readyState >= 2', '重启后原口播应可解码试听');
    await click('#narration-review-close');
    await fs.writeFile(path.join(root, 'draft-reopened.json'), JSON.stringify({ draftFile, trim, video, narration }, null, 2));
  }
  const closed = once(win, 'closed');
  win.close();
  await closed;
}

async function run() {
  const parent = path.resolve(__dirname, '../test-data');
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(path.join(parent, 'desktop-'));
  const selections = [];
  const saves = [];
  const win = await launchDesktop({
    show: false,
    dataDirectory: path.join(root, 'profile'),
    dialogs: {
      showOpenDialog: (_window, options) => {
        const next = selections.shift();
        assert.equal(options.title, next?.title);
        if (next.title === '选择素材文件夹') assert.ok(options.properties.includes('openDirectory'));
        return Promise.resolve({ canceled: false, filePaths: next.files });
      },
      showSaveDialog: (_window, options) => {
        const next = saves.shift();
        assert.equal(options.title, next?.title);
        return Promise.resolve({ canceled: false, filePath: next.file });
      },
    },
  });
  const runInWindow = (code) => win.webContents.executeJavaScript(code, true);
  const click = (selector) => runInWindow(`document.querySelector(${JSON.stringify(selector)}).click()`);
  async function screenshot(file, selector = '#export-heading') {
    // Match a visible label against its rendered text color, independent of the current theme.
    const label = await runInWindow(`(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element?.checkVisibility()) return null;
      const { left, right, top, bottom } = element.getBoundingClientRect();
      const rgb = getComputedStyle(element).color.match(/[0-9.]+/g).slice(0, 3).map(Number);
      return { left: left / innerWidth, right: right / innerWidth, top: top / innerHeight, bottom: bottom / innerHeight, rgb };
    })()`);
    assert.ok(label, `${file} 应显示 ${selector}`);
    const signal = AbortSignal.timeout(5000);
    for (;;) {
      const pending = once(win.webContents, 'paint', { signal });
      win.webContents.invalidate();
      const [, , picture] = await pending;
      if (!picture.isEmpty()) {
        const { width, height } = picture.getSize();
        const pixels = picture.toBitmap();
        const [r, g, b] = label.rgb;
        let ink = 0, contrast = 0;
        for (let y = Math.max(0, Math.floor(label.top * height)); y < Math.min(height, Math.ceil(label.bottom * height)); y++) {
          for (let x = Math.max(0, Math.floor(label.left * width)); x < Math.min(width, Math.ceil(label.right * width)); x++) {
            const offset = (y * width + x) * 4;
            const distance = Math.max(Math.abs(pixels[offset] - b), Math.abs(pixels[offset + 1] - g), Math.abs(pixels[offset + 2] - r));
            if (distance < 32) ink++;
            if (distance > 64) contrast++;
          }
        }
        if (ink >= 8 && contrast >= 8) {
          await fs.writeFile(path.join(root, file), picture.toPNG());
          return;
        }
      }
      await delay(50, undefined, { signal });
    }
  }
  async function waitFor(expression, description, timeout = 12000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await runInWindow(expression)) return;
      await delay(60);
    }
    const status = await runInWindow(`(() => {
      const video = document.querySelector('#preview');
      return {
        notice: document.querySelector('#notice')?.textContent,
        output: document.querySelector('#output-status')?.textContent,
        video: { error: video.error?.message, state: video.readyState, seeking: video.seeking,
          paused: video.paused, time: video.currentTime, duration: video.duration,
          seekable: Array.from({ length: video.seekable.length }, (_, i) => [video.seekable.start(i), video.seekable.end(i)]) },
      };
    })()`);
    throw new Error(`${description}: ${JSON.stringify(status)}`);
  }
  async function waitForInspector(name) {
    await waitFor(`(() => {
      return ['visual', 'narration', 'subtitles', 'music', 'montage'].every((panel) => {
        const content = document.querySelector('#inspector-panel-' + panel);
        const tab = document.querySelector('#inspector-tab-' + panel);
        const active = panel === '${name}';
        return content?.hidden === !active && Boolean(content.getClientRects().length) === active
          && tab?.getAttribute('aria-selected') === String(active);
      });
    })()`, `属性栏应只显示 ${name} 标签页`);
  }
  async function openInspector(name) {
    await runInWindow(`document.querySelector('#inspector-tab-${name}').click()`);
    await waitForInspector(name);
  }
  async function openBatch(count) {
    await waitFor(`document.querySelectorAll('.batch-select').length === ${count} && !document.querySelector('#timeline-batch-tab').disabled`, '应生成可打开的混剪组合');
    await runInWindow('document.querySelector("#timeline-batch-tab").click()');
    await waitFor('document.querySelector("#timeline-tracks-panel").hidden && document.querySelector("#preview-batch").getClientRects().length > 0', '批量预览标签应显示成片组合');
  }

  assert.equal(await runInWindow('document.title'), '佳剪');
  assert.equal(await runInWindow('typeof window.require'), 'undefined');
  assert.equal(await runInWindow('typeof window.workbench.pick'), 'function');
  assert.ok(await runInWindow(`!document.querySelector('#home .home-shortcuts') &&
    ['home-import', 'tab-script', 'tab-audio', 'tab-scene-split'].every(id =>
      document.querySelector('#workspace-navigation').contains(document.getElementById(id)))`), '创作工具应集中在侧栏');
  const files = await fixtures(root);
  const output = path.join(root, 'output');
  await fs.mkdir(output);

  await runInWindow('document.querySelector("#tab-montage").click()');
  await waitFor('!document.querySelector("#project-workspace").hidden && document.querySelector("#project-list-status").textContent.includes("还没有本地项目")', '批量混剪应先进入项目工作区');
  await runInWindow('document.querySelector("#project-new").click()');
  assert.equal(await runInWindow('document.querySelector("#editor-workspace").hidden'), false);
  await waitForInspector('visual');
  const tabHighlight = () => runInWindow("parseFloat(getComputedStyle(document.querySelector('#inspector-tabs'), '::before').left)");
  const initialHighlight = await tabHighlight();
  assert.equal(await runInWindow("document.querySelector('#keep-audio').getAttribute('role')"), 'switch');
  const initialKeepAudio = await runInWindow("document.querySelector('#keep-audio').checked");
  await click('label:has(> #keep-audio)');
  assert.equal(await runInWindow("document.querySelector('#keep-audio').checked"), !initialKeepAudio);
  await click('label:has(> #keep-audio)');
  const scheme = (selector) => runInWindow(`getComputedStyle(document.querySelector(${JSON.stringify(selector)})).colorScheme`);
  assert.equal(await scheme('#editor-workspace'), await scheme('.titlebar'), '编辑器和全局工具栏应使用同一外观');
  await openInspector('narration');
  await waitFor(`parseFloat(getComputedStyle(document.querySelector('#inspector-tabs'), '::before').left) > ${initialHighlight} + 10`, '属性页的选中底色应随标签移动');
  await click('#nav-toggle');
  await waitFor("document.querySelector('#workspace-navigation').checkVisibility() && document.querySelector('#nav-toggle').getAttribute('aria-expanded') === 'true'", '编辑时应能打开同一个工作区侧栏');
  await runInWindow("document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}))");
  await waitFor("!document.querySelector('#workspace-navigation').checkVisibility() && document.activeElement.id === 'nav-toggle'", 'Esc 应收起浮动侧栏，并将焦点还给原按钮');
  await waitForInspector('narration');
  await openInspector('visual');
  assert.ok(await runInWindow('!document.querySelector("#timeline-tracks-panel").hidden && document.querySelector("#timeline-batch-tab").disabled'));
  assert.ok(await runInWindow('["#open-project", "#save-project", "#prepare-preview", "#start-export"].every((id) => document.querySelector(".editor-heading").contains(document.querySelector(id)))'), '项目和导出操作应在编辑器顶部');
  const originalSize = win.getSize();
  const originalViewport = await runInWindow('[innerWidth, innerHeight].join(",")');
  try {
    win.setSize(850, 600);
    await waitFor(`(() => {
      const workspace = document.querySelector('#editor-workspace');
      const tabs = document.querySelector('#inspector-tabs');
      const tabItems = [...tabs.querySelectorAll('[role="tab"]')];
      const visible = (element) => {
        if (!element) return false;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.top >= 0
          && rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1;
      };
      return innerWidth <= 851 && innerHeight <= 601 && workspace.scrollWidth <= workspace.clientWidth + 1
        && tabs.scrollWidth <= tabs.clientWidth + 1 && tabItems.length === 5
        && [document.querySelector('.editor-heading'), document.querySelector('#montage-pane .track-toolbar'), ...tabItems].every(visible);
    })()`, '850×600 窗口应显示编辑器顶栏、轨道工具和全部属性标签且无横向溢出');
  } finally {
    win.setSize(...originalSize);
  }
  await waitFor(`[innerWidth, innerHeight].join(',') === ${JSON.stringify(originalViewport)}`, '应恢复默认窗口尺寸');

  const materialBox = `(() => {
    const { x, y, width, height } = document.querySelector('.editor-materials').getBoundingClientRect();
    return { x, y, width, height };
  })()`;
  const defaultMaterial = await runInWindow(materialBox);
  await runInWindow('document.querySelector("#panel-layout-toggle").click()');
  await waitFor('!document.querySelector("#panel-layout-layer").hidden && document.querySelectorAll(".panel-layout-box .panel-layout-handle").length === 36', '布局编辑应提供四个移动手柄和各面板的八个缩放边');
  async function dragPanel(edge, dx, dy) {
    await runInWindow(`(() => {
      const handle = document.querySelector('.panel-layout-box[data-pane="materials"] [data-edge="${edge}"]');
      const rect = handle.getBoundingClientRect();
      const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
      const event = (type, clientX, clientY) => new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerId: 41, pointerType: 'mouse', button: 0,
        buttons: type === 'pointerup' ? 0 : 1, clientX, clientY,
      });
      handle.dispatchEvent(event('pointerdown', x, y));
      window.dispatchEvent(event('pointermove', x + ${dx}, y + ${dy}));
      window.dispatchEvent(event('pointerup', x + ${dx}, y + ${dy}));
    })()`);
  }
  await dragPanel('move', 36, 25);
  await waitFor(`document.querySelector('#editor-workspace').dataset.panelLayout === 'custom' && (${materialBox}).x > ${defaultMaterial.x + 30}`, '向画布内部拖动手柄应移动素材库');
  const movedMaterial = await runInWindow(materialBox);
  assert.ok(movedMaterial.y > defaultMaterial.y + 18);
  await dragPanel('se', 31, 19);
  await waitFor(`(${materialBox}).width > ${movedMaterial.width + 25} && (${materialBox}).height > ${movedMaterial.height + 13}`, '拖动右下角应同时调整面板宽高');
  const resizedMaterial = await runInWindow(materialBox);
  await runInWindow(`document.querySelector('.panel-layout-box[data-pane="materials"] [data-edge="w"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }))`);
  await waitFor(`(${materialBox}).width > ${resizedMaterial.width + 6}`, '方向键应能调整面板边缘');
  const customMaterial = await runInWindow(materialBox);
  const layoutReload = once(win.webContents, 'did-finish-load');
  win.webContents.reload();
  await layoutReload;
  await runInWindow('document.querySelector("#tab-montage").click(); document.querySelector("#project-new").click();');
  await waitFor(`document.querySelector('#editor-workspace').dataset.panelLayout === 'custom' && Math.abs((${materialBox}).x - ${customMaterial.x}) < 2 && Math.abs((${materialBox}).width - ${customMaterial.width}) < 2`, '重开工作台应保留自定义布局');
  await runInWindow(`(() => { const picker = document.querySelector('#panel-layout-target'); picker.value = 'timeline'; picker.dispatchEvent(new Event('change')); })()`);
  await waitFor(`Number(getComputedStyle(document.querySelector('#montage-pane')).zIndex) > Number(getComputedStyle(document.querySelector('.editor-materials')).zIndex)`, '置顶选择应能找回重叠的面板');
  try {
    win.setSize(850, 600);
    await waitFor(`(() => {
      const workspace = document.querySelector('#editor-workspace');
      const area = workspace.getBoundingClientRect();
      return innerWidth <= 851 && innerHeight <= 601 && [...workspace.querySelectorAll('.panel-layout-pane')].every((pane) => {
        const rect = pane.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.left >= area.left && rect.top >= area.top
          && rect.right <= area.right + 1 && rect.bottom <= area.bottom + 1;
      });
    })()`, '缩小窗口后自定义面板应保持在画布内');
  } finally {
    win.setSize(...originalSize);
  }
  await waitFor(`[innerWidth, innerHeight].join(',') === ${JSON.stringify(originalViewport)}`, '应恢复默认窗口尺寸');
  await runInWindow('document.querySelector("#panel-layout-reset").click()');
  await waitFor(`!document.querySelector('#editor-workspace').dataset.panelLayout && Math.abs((${materialBox}).x - ${defaultMaterial.x}) < 2 && Math.abs((${materialBox}).width - ${defaultMaterial.width}) < 2`, '恢复默认布局应回到响应式网格');

  await runInWindow('document.querySelector("#inspector-tab-visual").focus()');
  for (const [direction, panel] of [['Right', 'narration'], ['Left', 'visual']]) {
    try {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: direction });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: direction });
      await delay(80);
    } catch { /* Offscreen native input is optional. */ }
    const target = `document.activeElement?.id === 'inspector-tab-${panel}'`;
    if (!await runInWindow(target)) {
      // An offscreen window may not receive native focus from Electron.
      await runInWindow(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Arrow${direction}', bubbles: true }))`);
    }
    await waitForInspector(panel);
    assert.ok(await runInWindow(target), '方向键应切换属性页并移动键盘焦点');
  }
  await runInWindow('document.querySelector("#title-home").click()');
  await click('.nav-more summary');
  await waitFor("document.querySelector('[data-workflow=replicate]').checkVisibility()", '更多工具应从侧栏展开');
  await click('[data-workflow=replicate]');
  await waitFor('document.querySelector("#service-title").textContent === "爆款复刻" && document.querySelector("#service-status").textContent === "待接入 API"', '待接入功能应说明真实状态');
  assert.equal(await runInWindow('document.querySelectorAll("#service-actions button").length'), 0);
  await runInWindow('document.querySelector("#title-home").click()');
  await runInWindow('document.querySelector("#tab-script").click()');
  await waitFor('document.querySelectorAll("#script-rows .script-row").length === 3', '脚本页应显示三个初始脚本行');
  await runInWindow('document.querySelector("#script-import-dialogue").click()');
  await runInWindow('document.querySelector("#script-import-input").value = "1、开头台词\\t展示第一镜\\n2、第二条台词"; document.querySelector("#script-import-confirm").click();');
  await waitFor('document.querySelector(".script-dialogue").value === "开头台词" && document.querySelector(".script-note").value === "展示第一镜"', '应能批量粘贴台词和备注');
  await runInWindow('document.querySelector("#script-mode-segmented").click()');
  assert.equal(await runInWindow('document.querySelector(".script-dialogue").value'), '');
  await runInWindow('document.querySelector("#script-mode-whole").click()');
  assert.equal(await runInWindow('document.querySelector(".script-dialogue").value'), '开头台词');
  await screenshot('script-workspace.png', '#script-mode-whole');
  const reloaded = once(win.webContents, 'did-finish-load');
  win.webContents.reload();
  await reloaded;
  await runInWindow('document.querySelector("#tab-script").click()');
  await waitFor('document.querySelector(".script-dialogue")?.value === "开头台词"', '重新加载后应恢复本地脚本草稿');
  await runInWindow('document.querySelector("#script-go-montage").click()');
  await waitFor('!document.querySelector("#script-brief").hidden && document.querySelector("#script-brief-rows").textContent.includes("展示第一镜")', '脚本和备注应进入混剪工程');
  await runInWindow('document.querySelector("#title-home").click()');

  selections.push({ title: '选择分镜素材', files: [files.red, files.green, files.still] });
  assert.equal(await runInWindow('document.querySelector("#home").hidden'), false);
  await runInWindow('document.querySelector("#home-import").click()');
  await waitFor('document.querySelectorAll("#shots .shot").length === 3', '导入后应有三个分镜');
  assert.equal(await runInWindow('document.querySelectorAll("#material-list .material-tile").length'), 3);
  const visibleThumbnail = `(() => {
    const img = document.querySelector('.material-tile[data-kind="video"] img');
    return img?.getAttribute('src')?.startsWith('sd-workbench://asset/thumbnail/') && img.naturalWidth === 240;
  })()`;
  await waitFor(visibleThumbnail, '素材库应解码实际视频缩略图');
  {
    const remote = win.webContents.debugger;
    remote.attach();
    async function press(key, code = key) {
      for (const type of ['keyDown', 'keyUp']) await remote.sendCommand('Input.dispatchKeyEvent', { type, key, code });
    }
    const player = 'document.querySelector("#preview")';
    const firstTile = '#material-list li:first-child .material-tile';
    const secondTile = '#material-list li:nth-child(2) .material-tile';
    const selectedTile = (selector) => `document.activeElement.matches('${selector}[aria-pressed="true"]') && document.querySelectorAll('#material-list [aria-pressed="true"]').length === 1`;
    try {
      const initialTime = await runInWindow(`${player}.currentTime`);
      await runInWindow(`document.querySelector('${firstTile}').focus()`);
      await press('ArrowRight');
      await waitFor(`${selectedTile(secondTile)} && ${player}.readyState >= 2`, '右方向键应聚焦并选中第二个素材，载入视频');
      await press(' ', 'Space');
      await waitFor(`!${player}.paused && ${player}.currentTime > .03`, '选中视频时空格应开始播放');
      await press(' ', 'Space');
      assert.ok(await runInWindow(`${player}.paused && !${player}.ended`), '再次按空格应暂停视频');
      await press('ArrowLeft');
      await waitFor(`${selectedTile(firstTile)} && ${player}.readyState >= 2`, '左方向键应选回首个素材');
      const poster = '#visual-track-lane .shot-poster';
      await click(poster);
      await runInWindow(`document.querySelector('${poster}').focus()`);
      await waitFor(`!${player}.seeking && ${player}.readyState >= 2`, '首帧应准备好逐帧定位');
      const beforeStep = await runInWindow(`${player}.currentTime`);
      await press('ArrowRight');
      await waitFor(`${player}.paused && !${player}.seeking && Math.abs(${player}.currentTime - ${beforeStep} - 1/30) < .002`, '在首个 30fps 分镜封面按右键应前进一帧');
      await runInWindow(`${player}.currentTime = ${initialTime}`);
      await waitFor(`!${player}.seeking && Math.abs(${player}.currentTime - ${initialTime}) < .002`, '应恢复首个素材的播放头');
    } finally { remote.detach(); }
  }
  assert.ok(await runInWindow(`document.querySelector('#shots .trim-fields').hidden && document.querySelector('#shots .clip-toggle').getAttribute('aria-expanded') === 'false'`), '素材参数默认收起');
  assert.ok(await runInWindow(`(() => {
    const [player, materials, inspector, timeline] = ['.editor-player', '.editor-materials', '.montage-inspector', '#montage-pane']
      .map((selector) => document.querySelector(selector).getBoundingClientRect());
    return player.width > 0 && materials.width > 0 && inspector.width > 0 && timeline.height > 0
      && materials.right <= player.left + 1 && player.right <= inspector.left + 1
      && materials.bottom <= timeline.top + 1 && player.bottom <= timeline.top + 1
      && timeline.left <= materials.left + 1 && timeline.right >= player.right - 1;
  })()`), '素材库、播放器与检查器应从左到右排列，时间线应覆盖前两栏下方');
  await runInWindow('(() => { const search = document.querySelector("#material-search"); search.value = "红色"; search.dispatchEvent(new Event("input")); })()');
  assert.equal(await runInWindow('document.querySelectorAll("#material-list .material-tile").length'), 1);
  await waitFor('document.querySelector("#preview").readyState >= 2', '应能解码 H.264 预览');
  assert.equal(await runInWindow('document.querySelector("#preview").videoWidth'), 320);
  await runInWindow('(() => { const video = document.querySelector("#preview"); video.muted = true; return video.play(); })()');
  await waitFor('document.querySelector("#preview").currentTime > 0.1', '素材预览应实际播放');
  await runInWindow('document.querySelector("#preview").pause()');
  await runInWindow('(() => { const speed = document.querySelector("#shots .speed"); speed.value = "0.5"; speed.dispatchEvent(new Event("input")); })()');
  assert.equal(await runInWindow('document.querySelector("#preview").playbackRate'), 0.5);
  await runInWindow('(() => { const speed = document.querySelector("#shots .speed"); speed.value = "1"; speed.dispatchEvent(new Event("input")); speed.dispatchEvent(new Event("blur")); })()');
  await runInWindow('(() => { const head = document.querySelector("#track-playhead"); head.value = "0.65"; head.dispatchEvent(new Event("input")); })()');
  await waitFor('Math.abs(document.querySelector("#preview").currentTime - 0.65) < 0.04 && !document.querySelector("#track-split").disabled', '播放头应定位并允许分割');
  await runInWindow('document.querySelector("#track-split").click()');
  assert.equal(await runInWindow('document.querySelectorAll("#shots .shot").length'), 4);
  assert.equal(await runInWindow('document.querySelector(\'#shots .shot[data-shot-index="1"] .start\').valueAsNumber'), 0.65);
  await runInWindow('document.querySelector("#track-undo").click()');
  assert.equal(await runInWindow('document.querySelectorAll("#shots .shot").length'), 3);
  await runInWindow('document.querySelector("#track-redo").click()');
  assert.equal(await runInWindow('document.querySelectorAll("#shots .shot").length'), 4);
  await runInWindow('document.querySelector("#track-undo").click(); document.querySelector("#shots .preview-asset").click();');
  await runInWindow('(() => { const interval = document.querySelector("#track-slice-interval"); interval.value = "0.5"; interval.dispatchEvent(new Event("input")); document.querySelector("#track-slice").click(); })()');
  assert.equal(await runInWindow('document.querySelectorAll("#shots .shot").length'), 5);
  await runInWindow('document.querySelector("#track-undo").click(); document.querySelector("#add-shot").click(); document.querySelector("#track-clean").click();');
  assert.equal(await runInWindow('document.querySelectorAll("#shots .shot").length'), 3);
  await runInWindow('document.querySelector("#shots .preview-asset").click();');
  await runInWindow('(() => { const volume = document.querySelector("#track-volume"); volume.value = "25"; volume.dispatchEvent(new Event("input")); document.querySelector("#track-volume-scope").value = "all"; document.querySelector("#track-volume-apply").click(); })()');
  assert.equal(await runInWindow('document.querySelector("#preview").volume'), 0.25);
  await runInWindow('document.querySelector("#shots .shot:last-child .preview-asset").click()');
  await waitFor('document.querySelector("#still-preview").naturalWidth === 160 && !document.querySelector("#still-preview").hidden', '应能预览图片分镜');

  selections.push({ title: '选择分镜素材', files: [files.blue] });
  await runInWindow('document.querySelector("#shots .add-candidate").click()');
  await waitFor('document.querySelectorAll("#shots .asset").length === 4', '第一分镜应有两条候选');
  await runInWindow('(() => { const set = (selector, value) => { const input = document.querySelector(selector); input.value = value; input.dispatchEvent(new Event("input")); }; set("#shots .start", "0.25"); set("#shots .shot:last-child .end", "0.5"); set("#ratio", "9:16"); })()');
  await runInWindow('(() => { const transition = document.querySelector(".shot-transition-kind"); transition.value = "fade-white"; transition.dispatchEvent(new Event("change")); const color = document.querySelector("#background-color"); color.value = "#223344"; color.dispatchEvent(new Event("input", { bubbles: true })); })()');
  await openInspector('montage');
  await runInWindow('(() => { const count = document.querySelector("#count"); count.value = "2"; count.dispatchEvent(new Event("input")); })()');

  selections.push({ title: '选择配乐', files: [files.music, files.otherMusic] });
  await openInspector('music');
  await runInWindow('document.querySelector("#pick-music").click()');
  await waitFor('document.querySelectorAll("#music-list li").length === 2', '应读取两首配乐');
  await runInWindow('(() => { const start = document.querySelector("#music-start-shot"); start.value = "1"; start.dispatchEvent(new Event("change")); })()');

  const project = path.join(root, '混剪样片.sdworkbench');
  saves.push({ title: '保存工程', file: project });
  await runInWindow('document.querySelector("#save-project").click()');
  await waitFor('document.querySelector("#notice").textContent.includes("工程已保存")', '应保存工程');
  assert.ok((await fs.stat(project)).isFile());
  await runInWindow('(() => { const start = document.querySelector("#shots .start"); start.value = "0.75"; start.dispatchEvent(new Event("input")); })()');
  assert.equal(await runInWindow('document.querySelector("#shots .start").valueAsNumber'), 0.75);
  await runInWindow('document.querySelector("#tab-montage").click()');
  await waitFor('document.querySelector(".project-reopen")?.textContent.includes("混剪样片")', '保存后应列入本地项目');
  await runInWindow('document.querySelector(".project-reopen").click()');
  await waitFor('document.querySelector("#shots .start").valueAsNumber === 0.25 && document.querySelectorAll("#music-list li").length === 2', '应恢复保存的剪辑点和配乐');
  await waitFor(visibleThumbnail, '重新打开工程应为恢复的素材解码缩略图');
  await waitFor(`(() => {
    const player = document.querySelector('#preview');
    return player.readyState >= 2 && player.paused && Math.abs(player.currentTime - 0.25) < 0.05
      && document.querySelector('.preview-readout').checkVisibility() && document.querySelector('.shot-poster img')?.naturalWidth > 0;
  })()`, '打开工程应暂停在第一条素材的入点，并展示文件时间与真实轨道缩略图');
  await openInspector('music');
  assert.equal(await runInWindow('document.querySelector("#music-start-shot").value'), '1');
  await openInspector('visual');
  assert.equal(await runInWindow('document.querySelector("#ratio").value'), '9:16');
  assert.equal(await runInWindow('document.querySelector(".shot-transition-kind").value'), 'fade-white');
  assert.equal(await runInWindow('document.querySelector("#background-color").value'), '#223344');
  await runInWindow('document.querySelector("#shots .preview-asset").click()');
  assert.equal(await runInWindow('document.querySelector("#track-volume").valueAsNumber'), 25);
  assert.match(await runInWindow('document.querySelector("#script-brief-rows").textContent'), /开头台词/);

  selections.push({ title: '选择导出目录', files: [output] });
  await runInWindow('document.querySelector("#start-export").click()');
  await waitFor('document.querySelector("#output-status").textContent.includes("已保存 2 条") && document.querySelector("#cancel-export").hidden', '应完成两条混剪');
  assert.ok(await runInWindow('document.querySelector("#output-status").getClientRects().length > 0'), '导出结果应能在画面标签页查看');
  const videos = (await fs.readdir(output)).filter((file) => file.endsWith('.mp4'));
  assert.equal(videos.length, 2);
  const exports = await Promise.all(videos.map((file) => inspectAsset(path.join(output, file), 'video')));
  for (const exported of exports) assert.deepEqual([exported.width, exported.height, exported.fps], [720, 1280, 30]);
  const durations = exports.map((asset) => asset.duration).sort((a, b) => a - b);
  assert.ok(Math.abs(durations[0] - 3.25) < 0.1 && Math.abs(durations[1] - 3.5) < 0.1);
  await screenshot('montage.png');

  await runInWindow('document.querySelector("#prepare-preview").click()');
  await openBatch(2);
  await runInWindow('document.querySelector("#timeline-tracks-tab").click()');
  assert.ok(await runInWindow('!document.querySelector("#timeline-tracks-panel").hidden && document.querySelector("#preview-batch").hidden && !document.querySelector("#timeline-batch-tab").disabled'), '返回轨道应保留已生成的组合');
  await openBatch(2);
  await runInWindow('document.querySelectorAll(".preview-composition")[1].click()');
  await waitFor('document.querySelector("#preview-name").textContent === "混剪预览 2" && document.querySelector("#preview").readyState >= 2', '第二条混剪预览应可播放');
  const previewInfo = await runInWindow('(() => { const video = document.querySelector("#preview"); return [video.videoWidth, video.videoHeight, video.duration]; })()');
  assert.deepEqual(previewInfo.slice(0, 2), [720, 1280]);
  await runInWindow('document.querySelectorAll(".batch-select")[0].click()');
  const selectedOutput = path.join(root, 'selected');
  await fs.mkdir(selectedOutput);
  selections.push({ title: '选择导出目录', files: [selectedOutput] });
  await runInWindow('document.querySelector("#start-export").click()');
  await waitFor('document.querySelector("#output-status").textContent.includes("已保存 1 条") && document.querySelector("#cancel-export").hidden', '只应导出勾选的成片');
  const selectedVideos = (await fs.readdir(selectedOutput)).filter((file) => file.endsWith('.mp4'));
  assert.equal(selectedVideos.length, 1);
  const selectedVideo = await inspectAsset(path.join(selectedOutput, selectedVideos[0]), 'video');
  assert.ok(Math.abs(selectedVideo.duration - previewInfo[2]) < 0.05, '导出应使用预览时选定的组合');

  const narration = path.join(root, '整段口播.wav');
  await ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=1000', '-t', '4.2', narration]);
  selections.push({ title: '选择口播音频', files: [narration] });
  await openInspector('narration');
  await runInWindow('document.querySelector("#pick-narration").click()');
  await waitFor('document.querySelector("#narration-name").textContent.includes("整段口播.wav") && !document.querySelector("#priority").disabled', '应加载整段口播');
  assert.ok(await runInWindow('document.querySelector("#preview-batch").hidden && document.querySelector("#timeline-batch-tab").disabled && !document.querySelector("#timeline-tracks-panel").hidden'), '更改口播应使预览组合失效并回到轨道');
  await runInWindow('document.querySelector("#review-narration").click()');
  await waitFor('document.querySelector("#narration-review").open && document.querySelector("#narration-review-audio").readyState >= 2', '应能试听真实本地口播');
  await runInWindow('(() => { const audio = document.querySelector("#narration-review-audio"); audio.muted = true; return audio.play(); })()');
  await waitFor('document.querySelector("#narration-review-audio").currentTime > 0.1', '试听播放器应实际播放');
  await runInWindow('document.querySelector("#narration-review-caption").value = "保留的整段台词"; document.querySelector("#narration-review-save").click()');
  await runInWindow('(() => { const priority = document.querySelector("#priority"); priority.value = "voice"; priority.dispatchEvent(new Event("change")); })()');
  const subtitles = path.join(root, '样片字幕.srt');
  await fs.writeFile(subtitles, '1\r\n00:00:00,500 --> 00:00:02,000\r\n编导工作台\r\n\r\n', 'utf8');
  selections.push({ title: '选择 SRT 字幕', files: [subtitles] });
  await openInspector('subtitles');
  await runInWindow('document.querySelector("#pick-subtitles").click()');
  await waitFor('document.querySelector("#subtitle-name").textContent.includes("样片字幕.srt")', '应加载 SRT 字幕');
  await runInWindow('(() => { const size = document.querySelector("#caption-size"); size.value = "26"; size.dispatchEvent(new Event("input", { bubbles: true })); document.querySelector("#caption-position").value = "top"; })()');
  const voiceProject = path.join(root, '带口播.sdworkbench');
  saves.push({ title: '保存工程', file: voiceProject });
  await runInWindow('document.querySelector("#save-project").click()');
  await waitFor('document.querySelector("#notice").textContent.includes("工程已保存")', '应保存口播工程');
  await openInspector('narration');
  await runInWindow('(() => { const priority = document.querySelector("#priority"); priority.value = "picture"; priority.dispatchEvent(new Event("change")); })()');
  await openInspector('subtitles');
  await runInWindow('document.querySelector("#remove-subtitles").click()');
  assert.ok(!(await runInWindow('document.querySelector("#subtitle-name").textContent.includes("样片字幕.srt")')));
  selections.push({ title: '打开工程', files: [voiceProject] });
  await runInWindow('document.querySelector("#open-project").click()');
  await waitFor('document.querySelector("#priority").value === "voice" && document.querySelector("#narration-name").textContent.includes("整段口播.wav") && document.querySelector("#subtitle-name").textContent.includes("样片字幕.srt")', '应恢复口播文件、优先模式和字幕');
  await openInspector('subtitles');
  assert.equal(await runInWindow('document.querySelector("#caption-size").valueAsNumber'), 26);
  assert.equal(await runInWindow('document.querySelector("#caption-position").value'), 'top');
  await openInspector('narration');
  await runInWindow('document.querySelector("#review-narration").click()');
  assert.equal(await runInWindow('document.querySelector("#narration-review-caption").value'), '保留的整段台词');
  assert.match(await runInWindow('document.querySelector("#narration-review-note").textContent'), /SRT 优先/);
  await runInWindow('document.querySelector("#narration-review-close").click()');
  await runInWindow('document.querySelector("#prepare-preview").click()');
  await openBatch(2);
  await runInWindow('document.querySelector(".preview-composition").click()');
  await waitFor('document.querySelector("#preview-name").textContent === "混剪预览 1" && document.querySelector("#preview").readyState >= 2', '口播优先成片应可预览');
  const voicePreviewDuration = await runInWindow('document.querySelector("#preview").duration');
  assert.ok(Math.abs(voicePreviewDuration - 4.2) < 0.05, '口播优先应保留完整的原速口播时长');
  await runInWindow('(() => { const video = document.querySelector("#preview"); video.pause(); video.currentTime = 1; })()');
  await waitFor('(() => { const video = document.querySelector("#preview"); return !video.seeking && video.readyState >= 2 && Math.abs(video.currentTime - 1) < 0.05; })()', '应能定位到字幕出现的位置');
  await screenshot('narration-preview.png');

  const subtitleVariants = ['第二轨字幕.srt', '破损字幕.srt', '第三轨字幕.srt'].map((name) => path.join(root, name));
  await Promise.all([
    fs.writeFile(subtitleVariants[0], '1\n00:00:00,200 --> 00:00:02,000\n第二条字幕\n'),
    fs.writeFile(subtitleVariants[1], '不是字幕'),
    fs.writeFile(subtitleVariants[2], '1\n00:00:00,300 --> 00:00:02,500\n第三条字幕\n'),
  ]);
  selections.push({ title: '批量选择 SRT 字幕', files: subtitleVariants });
  await openInspector('subtitles');
  await runInWindow('document.querySelector("#pick-subtitle-batch").click()');
  await waitFor('document.querySelectorAll("#whole-track-list .whole-track-row").length === 2 && document.querySelector("#notice").textContent.includes("破损字幕.srt")', '批量导入应保留两个有效文件并提示失败文件');
  await openInspector('montage');
  await runInWindow('(() => { const count = document.querySelector("#count"); count.value = "6"; count.dispatchEvent(new Event("input")); })()');
  await runInWindow('document.querySelector("#prepare-preview").click()');
  await openBatch(6);
  const batchCaptions = await runInWindow('[...document.querySelectorAll(".batch-subtitles")].map((element) => element.textContent)');
  for (const caption of ['样片字幕.srt', '第二轨字幕.srt', '第三轨字幕.srt']) {
    assert.equal(batchCaptions.filter((value) => value.includes(caption)).length, 2);
  }

  await openInspector('narration');
  await runInWindow('(() => { const mode = document.querySelector("#narration-mode"); mode.value = "segmented"; mode.dispatchEvent(new Event("change")); })()');
  assert.equal(await runInWindow('document.querySelector("#whole-subtitles").hidden'), true);
  assert.equal(await runInWindow('document.querySelector("#preview-batch").hidden'), true);
  await runInWindow('document.querySelector(".add-segment-narration").click()');
  selections.push({ title: '选择口播音频', files: [files.music] });
  await runInWindow('document.querySelector(".pick-segment-narration").click()');
  await waitFor('document.querySelector(".segment-narration-name")?.textContent.includes("短配乐.wav")', '应能给第一分镜的口播轨添加音频');
  await runInWindow('document.querySelector(".review-segment-narration").click()');
  await waitFor('document.querySelector("#narration-review").open && document.querySelector("#narration-review-audio").readyState >= 2', '分段口播也应可试听');
  await runInWindow('document.querySelector("#narration-review-caption").value = "第一镜台词"; document.querySelector("#narration-review-save").click()');
  const segmentProject = path.join(root, '分段口播.sdworkbench');
  saves.push({ title: '保存工程', file: segmentProject });
  await runInWindow('document.querySelector("#save-project").click()');
  await waitFor('document.querySelector("#notice").textContent.includes("工程已保存")', '应保存分段口播工程');
  await runInWindow('document.querySelector(".remove-segment-narration").click()');
  selections.push({ title: '打开工程', files: [segmentProject] });
  await runInWindow('document.querySelector("#open-project").click()');
  await waitFor('document.querySelector("#narration-mode").value === "segmented" && document.querySelector(".segment-narration-name")?.textContent.includes("短配乐.wav")', '应恢复原分镜的分段口播');
  assert.equal(await runInWindow('document.querySelectorAll("#whole-track-list .whole-track-row").length'), 2);
  await runInWindow('document.querySelector(".review-segment-narration").click()');
  assert.equal(await runInWindow('document.querySelector("#narration-review-caption").value'), '第一镜台词');
  await runInWindow('document.querySelector("#narration-review-close").click()');
  await runInWindow('document.querySelector("#prepare-preview").click()');
  await openBatch(2);
  await waitFor('document.querySelector(".batch-clips")?.textContent.includes("无口播")', '应标明空口播分镜');
  assert.match(await runInWindow('document.querySelector(".batch-subtitles").textContent'), /口播字幕/);
  await runInWindow('document.querySelector(".preview-composition").click()');
  await waitFor('document.querySelector("#preview-name").textContent === "混剪预览 1" && document.querySelector("#preview").readyState >= 2', '分段口播成片应可预览');
  const segmentPreviewDuration = await runInWindow('document.querySelector("#preview").duration');
  assert.ok(Math.abs(segmentPreviewDuration - 2.4) < 0.05, '有口播的分镜应对齐口播长度，无口播的分镜应保留原长');
  await screenshot('segmented-preview.png');

  await runInWindow('document.querySelector("#tab-home").click()');
  await waitFor('document.querySelectorAll("#history-list li").length === 3', '首页应列出三条真实成片');
  await runInWindow('document.querySelector("#tab-audio").click()');
  selections.push({ title: '选择视频素材', files: [files.red, files.blue] });
  await runInWindow('document.querySelector("#import-materials").click()');
  await waitFor('document.querySelectorAll("#audio-list .asset").length === 1', '音频提取应略过无音轨视频');
  assert.match(await runInWindow('document.querySelector("#notice").textContent'), /没有可提取的音轨/);
  selections.push({ title: '选择导出目录', files: [output] });
  await runInWindow('document.querySelector("#start-export").click()');
  await waitFor('document.querySelector("#output-status").textContent.includes("已保存 1 条") && document.querySelector("#cancel-export").hidden', '应完成音频提取');
  const audios = (await fs.readdir(output)).filter((file) => file.endsWith('.mp3'));
  assert.equal(audios.length, 1);
  assert.equal((await inspectAsset(path.join(output, audios[0]), 'audio')).codec, 'mp3');
  assert.deepEqual(selections, []);
  assert.deepEqual(saves, []);
  await runInWindow('document.querySelector("#tab-home").click()');
  await waitFor('document.querySelectorAll("#history-list li").length === 4', '最近作品应包含三条视频和一条音频');
  const history = JSON.parse(await fs.readFile(path.join(root, 'profile', 'work-history.json'), 'utf8'));
  assert.deepEqual(history.map((item) => item.name).sort(), [...videos, ...selectedVideos, ...audios].sort());
  await waitFor('!document.querySelector("#home").hidden && [...document.querySelectorAll(".draft-cover img")].some((img) => img.naturalWidth > 0)', '首页应显示带真实封面的草稿');
  await screenshot('home.png', '#draft-heading');

  const library = path.join(root, '桌面验证素材');
  const nested = path.join(library, '分组素材');
  await fs.mkdir(nested, { recursive: true });
  await Promise.all([
    fs.copyFile(files.green, path.join(library, path.basename(files.green))),
    fs.copyFile(files.blue, path.join(nested, path.basename(files.blue))),
    fs.copyFile(files.still, path.join(nested, path.basename(files.still))),
    fs.writeFile(path.join(library, '说明.txt'), '应忽略的非媒体文件。'),
  ]);
  const folderReload = once(win.webContents, 'did-finish-load');
  win.webContents.reload();
  await folderReload;
  await runInWindow('document.querySelector("#tab-montage").click(); document.querySelector("#project-new").click();');
  await waitFor('!document.querySelector("#editor-workspace").hidden && !document.querySelector("#material-folder-import").disabled', '应打开空工程的素材库');
  const folder = (name) => `[...document.querySelectorAll('#material-folders .material-folder')].find((item) => item.textContent.includes(${JSON.stringify(name)}) || item.title === ${JSON.stringify(name)})`;
  const material = (file) => `.material-tile[title="${path.basename(file)}"]`;
  const tiles = '#material-list .material-tile';
  async function dragMaterial(file, target) {
    assert.ok(await runInWindow(`(() => {
      const source = document.querySelector(${JSON.stringify(material(file))});
      const target = document.querySelector(${JSON.stringify(target)});
      const dataTransfer = new DataTransfer();
      const drag = (type) => new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer });
      source.dispatchEvent(drag('dragstart'));
      const prepared = source.draggable && dataTransfer.types.length > 0;
      target.dispatchEvent(drag('dragenter'));
      target.dispatchEvent(drag('dragover'));
      target.dispatchEvent(drag('drop'));
      source.dispatchEvent(drag('dragend'));
      return prepared;
    })()`), '素材应通过实际拖放事件发送素材标识');
  }
  selections.push({ title: '选择素材文件夹', files: [library] });
  await click('#material-folder-import');
  await waitFor(`Boolean(${folder(path.basename(library))})`, '选中的目录应出现在素材库根目录');
  assert.equal(await runInWindow('document.querySelectorAll("#shots .shot").length'), 0, '选择素材目录不会生成分镜');
  assert.equal(await runInWindow(`document.querySelectorAll(${JSON.stringify(tiles)}).length`), 0);
  await runInWindow(`(${folder(path.basename(library))}).click()`);
  await waitFor(`document.querySelectorAll(${JSON.stringify(tiles)}).length === 1 && Boolean(document.querySelector(${JSON.stringify(material(files.green))})) && Boolean(${folder(path.basename(nested))})`, '打开目录后应只显示支持的文件与子目录');
  await waitFor(`document.querySelector(${JSON.stringify(`${material(files.green)} img`)})?.naturalWidth > 0`, '打开视频前应看到已解码的文件夹视频缩略图');
  await click(material(files.green));
  await waitFor(`document.querySelector('#preview-name').textContent === ${JSON.stringify(path.basename(files.green))} && document.querySelector('#preview').readyState >= 2`, '目录内视频应能实际解码预览');
  assert.equal(await runInWindow('document.querySelectorAll("#shots .shot").length'), 0, '浏览和预览素材也不生成分镜');
  await dragMaterial(files.green, '#new-shot-drop');
  await waitFor('document.querySelectorAll("#shots .shot").length === 1 && document.querySelectorAll("#shots .asset").length === 1', '拖到新分镜区应生成一个分镜');
  await runInWindow(`(${folder(path.basename(nested))}).click()`);
  await waitFor(`document.querySelectorAll(${JSON.stringify(tiles)}).length === 2 && Boolean(document.querySelector(${JSON.stringify(material(files.blue))})) && Boolean(document.querySelector(${JSON.stringify(material(files.still))}))`, '子目录应列出视频和图片');
  await dragMaterial(files.still, '#shots .shot');
  await waitFor('document.querySelectorAll("#shots .shot").length === 1 && document.querySelectorAll("#shots .asset").length === 2', '拖到现有分镜应加入候选');
  await dragMaterial(files.still, '#shots .shot');
  await waitFor('document.querySelector("#notice").textContent.includes("已在本组")', '应等到重复素材检查完成');
  assert.equal(await runInWindow('document.querySelectorAll("#shots .asset").length'), 2, '重复拖入同一分镜不能复制候选');
  await click(`${material(files.blue)} ~ .material-quick-add`);
  await waitFor('document.querySelector("#material-add-dialog").open && document.querySelector("#material-add-target").options.length === 2', '快捷添加应允许选择新建或已有分镜');
  await runInWindow('document.querySelector("#material-add-target").value = "0"; document.querySelector("#material-add-confirm").click();');
  await waitFor('!document.querySelector("#material-add-dialog").open && document.querySelectorAll("#shots .shot").length === 1 && document.querySelectorAll("#shots .asset").length === 3', '快捷添加应把视频放到指定分镜');
  await screenshot('material-folder.png');
  assert.equal(await runInWindow('document.querySelector("#material-selection-actions").hidden'), true);
  async function selectNestedBatch() {
    for (const file of [files.blue, files.still]) {
      await runInWindow(`document.querySelector(${JSON.stringify(material(file))}).closest('li').querySelector('.material-select').click()`);
    }
    await waitFor('document.querySelectorAll("#material-list .material-select:checked").length === 2 && !document.querySelector("#material-selection-actions").hidden && !document.querySelector("#material-add-selected").disabled', '素材库应允许同时勾选同目录的图片和视频');
  }
  const marquee = await runInWindow(`(() => {
    document.querySelector('.editor-materials').scrollTop = 0;
    const bounds = [...document.querySelectorAll(${JSON.stringify(tiles)})].map((tile) => tile.getBoundingClientRect());
    const start = { x: Math.floor(Math.min(...bounds.map((box) => box.left))) - 4, y: Math.ceil(Math.min(...bounds.map((box) => box.top))) + 2 };
    const end = { x: Math.floor(Math.max(...bounds.map((box) => box.right))) - 2, y: Math.floor(Math.max(...bounds.map((box) => box.bottom))) - 2 };
    return { start, end, startsOnBlank: document.elementFromPoint(start.x, start.y)?.matches('.editor-materials') };
  })()`);
  assert.equal(marquee.startsOnBlank, true, '框选应从素材库空白处开始');
  win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...marquee.start });
  win.webContents.sendInputEvent({ type: 'mouseMove', modifiers: ['leftButtonDown'], ...marquee.end });
  await waitFor('document.querySelector(".material-marquee")?.hidden === false', '拖动左键时应显示选框');
  win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...marquee.end });
  await waitFor('document.querySelector(".material-marquee").hidden && document.querySelectorAll("#material-list .material-select:checked").length === 2', '松开左键应勾选框内的视频和图片');
  await click('#material-add-selected');
  await waitFor('document.querySelector("#material-add-dialog").open && document.querySelector("#material-add-target").options.length === 2', '批量添加应复用分镜选择窗口');
  await runInWindow('document.querySelector("#material-add-target").value = "new"; document.querySelector("#material-add-confirm").click();');
  const batchShot = '#shots .shot[data-shot-index="1"]';
  await waitFor(`!document.querySelector('#material-add-dialog').open && document.querySelectorAll('#shots .shot').length === 2 && document.querySelectorAll(${JSON.stringify(`${batchShot} .asset`)}).length === 2`, '两个勾选素材应批量加入同一个新分镜');
  assert.deepEqual(await runInWindow(`[...document.querySelectorAll(${JSON.stringify(`${batchShot} .asset-name`)})].map((label) => label.textContent).sort()`), [path.basename(files.blue), path.basename(files.still)].sort());
  assert.equal(await runInWindow('document.querySelectorAll("#material-list .material-select:checked").length'), 0, '批量添加完成后应清除已提交勾选');
  await selectNestedBatch();
  await click('#add-shot');
  const draggedBatch = '#shots .shot[data-shot-index="2"]';
  await waitFor(`Boolean(document.querySelector(${JSON.stringify(draggedBatch)}))`, '应创建用于批量拖入的空分镜');
  await dragMaterial(files.blue, draggedBatch);
  const draggedCandidates = `document.querySelectorAll(${JSON.stringify(`${draggedBatch} .asset`)}).length`;
  await waitFor(`${draggedCandidates} === 2`, '拖动一项已勾选素材应把两项放进同一个已有分镜');
  await click('#track-undo');
  await waitFor(`document.querySelectorAll('#shots .shot').length === 3 && ${draggedCandidates} === 0`, '应一次撤销整批候选');
  await click('#track-redo');
  await waitFor(`${draggedCandidates} === 2`, '应一次恢复整批候选');
  await click(`${draggedBatch} .remove-shot`);
  await click('#material-breadcrumb .material-back');
  await waitFor(`Boolean(document.querySelector(${JSON.stringify(material(files.green))})) && document.querySelectorAll(${JSON.stringify(tiles)}).length === 1`, '返回上层应恢复父目录中的素材');
  const folderProject = path.join(root, '文件夹分镜.sdworkbench');
  saves.push({ title: '保存工程', file: folderProject });
  await click('#save-project');
  await waitFor('document.querySelector("#notice").textContent.includes("工程已保存")', '应保存从文件夹加入的分镜');
  const savedFolderProject = JSON.parse(await fs.readFile(folderProject, 'utf8'));
  assert.deepEqual(savedFolderProject.config.shots.map((shot) => shot.length), [3, 2], '工程应保留两项素材在同一分镜');
  assert.deepEqual(savedFolderProject.assets.map(({ path: file }) => file).sort(), [
    path.join(library, path.basename(files.green)),
    path.join(nested, path.basename(files.blue)),
    path.join(nested, path.basename(files.still)),
  ].sort(), '工程应保存三项素材的原始路径');
  const reopenFolderProject = once(win.webContents, 'did-finish-load');
  win.webContents.reload();
  await reopenFolderProject;
  selections.push({ title: '打开工程', files: [folderProject] });
  await click('#home-open-project');
  await waitFor('document.querySelector("#notice").textContent.includes("已打开工程") && document.querySelectorAll("#shots .asset").length === 5', '重开应恢复文件夹分镜和同组批量素材');
  assert.equal(await runInWindow('document.querySelector("#material-breadcrumb").hidden && document.querySelectorAll("#material-folders .material-folder").length === 0'), true, '目录浏览状态只保留在当前会话');
  await click(`${batchShot} .remove-shot`);

  const timelineScroll = `(() => {
    const panel = document.querySelector('#timeline-tracks-panel');
    const shots = document.querySelector('#shots');
    const bar = document.querySelector('#track-horizontal-scroll');
    const paneBox = document.querySelector('#montage-pane').getBoundingClientRect();
    const barBox = bar.getBoundingClientRect();
    const shotBox = shots.getBoundingClientRect();
    const panelBox = panel.getBoundingClientRect();
    const lastCard = shots.querySelector('.visual-lane .shot:last-child');
    const last = lastCard.getBoundingClientRect();
    const lastHeading = lastCard.querySelector('.shot-heading').getBoundingClientRect();
    return { hidden: bar.hidden || barBox.height === 0, bottom: barBox.bottom, paneBottom: paneBox.bottom,
      withinPane: barBox.left >= paneBox.left - 1 && barBox.right <= paneBox.right + 1 && barBox.top >= paneBox.top,
      gutter: bar.offsetHeight - bar.clientHeight,
      top: panel.scrollTop, verticalRange: panel.scrollHeight - panel.clientHeight,
      left: shots.scrollLeft, barLeft: bar.scrollLeft, range: shots.scrollWidth - shots.clientWidth,
      lastVisible: last.left >= shotBox.left - 1 && last.right <= shotBox.right + 1,
      lastHeadingVisible: lastHeading.top >= panelBox.top - 1 && lastHeading.bottom <= panelBox.bottom + 1 };
  })()`;
  await waitFor(`(${timelineScroll}).hidden`, '只有一个分镜时不应显示横向滚动条');
  for (let count = 2; count <= 8; count += 1) {
    await dragMaterial(files.green, '#new-shot-drop');
    await waitFor(`document.querySelectorAll('#shots .shot').length === ${count}`, '应追加用于滚动验证的分镜');
  }
  await runInWindow(`(() => {
    document.querySelector('#tracks-expand-all').click();
    const height = document.querySelector('#track-height');
    height.value = 'large';
    height.dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('#timeline-tracks-panel').scrollTop = 0;
    document.querySelector('#shots').scrollLeft = 0;
  })()`);
  await waitFor(`(() => { const value = ${timelineScroll}; return !value.hidden && value.range > 100 && value.verticalRange > 50 && value.top === 0 && value.left === 0 && value.barLeft === 0; })()`, '宽轨道和高候选应产生双向溢出');
  const initialTimeline = await runInWindow(timelineScroll);
  assert.ok(Math.abs(initialTimeline.paneBottom - initialTimeline.bottom) <= 4, '横向滚动条应贴近轨道面板底边');
  assert.ok(initialTimeline.gutter >= 10, '横向滚动应有实际可见的原生滚动条');
  await runInWindow('(() => { const panel = document.querySelector("#timeline-tracks-panel"); panel.scrollTop = panel.scrollHeight; })()');
  await waitFor(`(() => { const value = ${timelineScroll}; return value.top > 50 && !value.hidden && Math.abs(value.bottom - ${initialTimeline.bottom}) <= 1; })()`, '候选纵向滚到底时横向滚动条应留在底边');
  await runInWindow('(() => { const bar = document.querySelector("#track-horizontal-scroll"); bar.scrollLeft = bar.scrollWidth; })()');
  await waitFor(`(() => { const value = ${timelineScroll}; return value.lastVisible && Math.abs(value.left - value.range) <= 1; })()`, '把底部滚动条移到最右应能看到最后一个分镜');
  await runInWindow('(() => { const shots = document.querySelector("#shots"); shots.scrollLeft = Math.round((shots.scrollWidth - shots.clientWidth) / 3); })()');
  await waitFor(`(() => { const value = ${timelineScroll}; return value.left > 0 && value.left < value.range && Math.abs(value.left - value.barLeft) <= 2; })()`, '轨道横向滚动也应移动底部滚动条');
  await runInWindow('(() => { const zoom = document.querySelector("#track-zoom"); zoom.value = "5"; zoom.dispatchEvent(new Event("input", { bubbles: true })); })()');
  await waitFor(`(() => { const value = ${timelineScroll}; return !value.hidden && value.range > ${initialTimeline.range} + 100 && Math.abs(value.left - value.barLeft) <= 2; })()`, '轨道缩放应更新横向滚动范围并保持同步');
  await runInWindow('(() => { const bar = document.querySelector("#track-horizontal-scroll"); bar.scrollLeft = bar.scrollWidth; })()');
  await waitFor(`(() => { const value = ${timelineScroll}; return value.lastVisible && Math.abs(value.left - value.range) <= 1; })()`, '缩放后底部滚动条仍应能到达最右分镜');
  await runInWindow('document.querySelector("#timeline-tracks-panel").scrollTop = 0;');
  await waitFor(`(() => { const value = ${timelineScroll}; return value.top === 0 && value.lastVisible && value.lastHeadingVisible; })()`, '返回纵向顶部后应能访问最右分镜');
  await screenshot('timeline-scroll.png');
  await click('#prepare-preview');
  await openBatch(1);
  await waitFor(`(${timelineScroll}).hidden`, '切到批量预览应隐藏轨道滚动条');
  await click('#timeline-tracks-tab');
  await waitFor(`!(${timelineScroll}).hidden`, '返回分镜轨道应重新显示滚动条');

  const visualShot = (index) => `#visual-track-lane .shot[data-shot-index="${index}"]`;
  const narrationPanel = (index) => `#narration-track-lane .segment-narration-panel[data-shot-index="${index}"]`;
  const firstShot = visualShot(0);
  const firstNarration = narrationPanel(0);
  const lanesAligned = `(() => {
    const visual = [...document.querySelectorAll('.timeline-lane.visual-lane .shot')];
    const narration = [...document.querySelectorAll('.timeline-lane.narration-lane .segment-narration-panel')];
    return visual.length === 8 && narration.length === 8 && visual.every((shot, index) => {
      const audio = narration[index];
      const picture = shot.getBoundingClientRect();
      const voice = audio.getBoundingClientRect();
      return audio.dataset.shotIndex === shot.dataset.shotIndex && !shot.contains(audio) && voice.top >= picture.bottom - 1
        && Math.abs(voice.left - picture.left) <= 2 && Math.abs(voice.width - picture.width) <= 2;
    });
  })()`;
  assert.equal(await runInWindow('document.querySelector("#narration-track-lane").hidden'), true, '整段模式不应显示分段口播轨');
  await openInspector('narration');
  await runInWindow(`(() => {
    const mode = document.querySelector('#narration-mode');
    mode.value = 'segmented';
    mode.dispatchEvent(new Event('change', { bubbles: true }));
    const trim = document.querySelector('#shots .start');
    trim.value = '0.2';
    trim.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#shots').scrollLeft = 0;
  })()`);
  await waitFor(lanesAligned, '画面和口播应分成两行，八个分镜逐列对齐');
  await click(`${firstNarration} .add-segment-narration`);
  selections.push({ title: '选择口播音频', files: [files.music] });
  await click(`${firstNarration} .pick-segment-narration`);
  const hasFixtureNarration = (panel) => `Boolean(document.querySelector(${JSON.stringify(`${panel} .segment-narration-name`)})?.textContent.includes(${JSON.stringify(path.basename(files.music))}))`;
  await waitFor(hasFixtureNarration(firstNarration), '折叠验证应使用已导入的真实分段口播');

  const firstClip = `${firstShot} .asset:first-child`;
  const firstSegment = `${firstNarration} .segment-narration-track:first-child`;
  const disclosure = (scope, toggle, body, expanded) => `(() => {
    const root = document.querySelector(${JSON.stringify(scope)});
    return root.querySelector(${JSON.stringify(toggle)}).getAttribute('aria-expanded') === ${JSON.stringify(String(expanded))}
      && root.querySelector(${JSON.stringify(body)}).hidden === ${!expanded};
  })()`;
  await click(`${firstClip} .clip-toggle`);
  await click(`${firstSegment} .segment-track-toggle`);
  await waitFor(`${disclosure(firstClip, '.clip-toggle', '.trim-fields', false)}
    && ${disclosure(`${firstShot} .asset:nth-child(2)`, '.clip-toggle', '.trim-fields', true)}
    && ${disclosure(firstSegment, '.segment-track-toggle', '.segment-track-actions', false)}`, '候选素材和单条口播应独立折叠');
  await click(`${firstNarration} .segment-toggle`);
  await click(`${firstShot} .transition-toggle`);
  await waitFor(`${disclosure(firstNarration, '.segment-toggle', '.segment-narration-body', false)}
    && ${disclosure(firstShot, '.transition-toggle', '.shot-transition-fields', false)}
    && ${disclosure(firstShot, '.shot-toggle', '.shot-body', true)}`, '口播区和转场设置应独立折叠');
  await click(`${firstShot} .shot-toggle`);
  await click('#shots .shot:last-child .move-up');
  await waitFor(`${disclosure(firstShot, '.shot-toggle', '.shot-body', false)}
    && ${disclosure(visualShot(1), '.shot-toggle', '.shot-body', true)}
    && document.querySelector(${JSON.stringify(firstNarration)}).getClientRects().length > 0`, '折叠画面和重排其他分镜时应保留单独可见的口播轨');
  await click(`${firstShot} .shot-toggle`);
  await waitFor(`${disclosure(firstClip, '.clip-toggle', '.trim-fields', false)}
    && ${disclosure(firstNarration, '.segment-toggle', '.segment-narration-body', false)}
    && ${disclosure(firstSegment, '.segment-track-toggle', '.segment-track-actions', false)}`, '重新打开分镜应保留内层的独立折叠状态');
  await click('#tracks-collapse-all');
  await waitFor(`(() => {
    const toggles = [...document.querySelectorAll('#shots :is(.shot-toggle, .clip-toggle, .segment-toggle, .segment-track-toggle, .transition-toggle)')];
    const value = ${timelineScroll};
    return toggles.length > 8 && toggles.every((toggle) => toggle.getAttribute('aria-expanded') === 'false')
      && !value.hidden && Math.abs(value.bottom - value.paneBottom) <= 4;
  })()`, '全部收起应折叠每个分镜及其内容并保留底部滚动条');
  await screenshot('timeline-collapsed.png');
  await click('#tracks-expand-all');
  await waitFor(`(() => {
    const toggles = [...document.querySelectorAll('#shots :is(.shot-toggle, .clip-toggle, .segment-toggle, .segment-track-toggle, .transition-toggle)')];
    return toggles.length > 8 && toggles.every((toggle) => toggle.getAttribute('aria-expanded') === 'true');
  })()`, '全部展开应打开每张分镜卡和内层设置');
  assert.equal(await runInWindow('document.querySelectorAll("#shots .asset").length'), 10, '折叠不能删除候选素材');
  assert.equal(await runInWindow('document.querySelector("#shots .start").valueAsNumber'), 0.2, '折叠不能丢失已编辑的裁剪点');
  assert.ok(await runInWindow(hasFixtureNarration(firstNarration)), '折叠不能移除已导入的口播');
  await click(`${firstShot} .move-down`);
  await waitFor(`${lanesAligned} && !${hasFixtureNarration(firstNarration)} && ${hasFixtureNarration(narrationPanel(1))}
    && document.querySelector(${JSON.stringify(`${visualShot(1)} .start`)}).valueAsNumber === 0.2`, '移动分镜时口播和裁剪点应一起进入同一列');
  await click(`${visualShot(1)} .move-up`);
  await waitFor(`${lanesAligned} && ${hasFixtureNarration(firstNarration)}`, '移回分镜时两行应保持对齐');
  try {
    win.setSize(850, 600);
    await waitFor(`(() => {
      const value = ${timelineScroll};
      return innerWidth <= 851 && innerHeight <= 601 && document.documentElement.scrollWidth <= innerWidth + 1
        && !value.hidden && value.withinPane && value.gutter >= 10 && value.range > 100
        && value.bottom <= innerHeight + 1 && Math.abs(value.bottom - value.paneBottom) <= 4;
    })()`, '850×600 窗口中八个分镜应保留底部滚动条，且页面不横向溢出');
  } finally {
    win.setSize(...originalSize);
  }
  await waitFor(`[innerWidth, innerHeight].join(',') === ${JSON.stringify(originalViewport)}`, '应恢复默认窗口尺寸');
  await runInWindow('for (let count = 8; count > 1; count -= 1) document.querySelector("#shots .shot:last-child .remove-shot").click();');
  await waitFor(`(() => { const value = ${timelineScroll}; return value.hidden && value.range === 0 && value.left === 0 && value.barLeft === 0; })()`, '删到无横向溢出时应隐藏滚动条并清除旧位置');
  await click('#title-home');
  await click('#home-create');
  await waitFor('["#empty-import-visual", "#empty-split-narration"].every((id) => document.querySelector(id)?.checkVisibility() && !document.querySelector(id).disabled)', '新草稿应显示两个可用时间轴入口');
  const splitSrt = path.join(root, '双句口播.srt');
  const splitMp3 = path.join(root, '双句口播.mp3');
  await fs.writeFile(splitSrt, '1\n00:00:00,000 --> 00:00:00,300\n第一句\n\n2\n00:00:00,400 --> 00:00:00,800\n第二句\n');
  await ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'libmp3lame', splitMp3]);
  selections.push({ title: '选择口播 SRT 字幕', files: [splitSrt] }, { title: '选择整段 MP3 口播', files: [splitMp3] });
  await click('#empty-split-narration');
  await waitFor(`document.querySelectorAll('#shots .segment-narration-name').length === 2
    && document.querySelector('#narration-mode').value === 'segmented'
    && !document.querySelector('#empty-split-narration').checkVisibility()`, '从空时间轴分割 SRT 和 MP3 后应生成两组分段口播并退出空状态');
  await waitForInspector('narration');
  assert.deepEqual(await runInWindow("[...document.querySelectorAll('#narration-track-lane .segment-caption')].map((item) => item.textContent)"), ['第一句', '第二句']);
  await click(`${narrationPanel(1)} .review-segment-narration`);
  await waitFor(`document.querySelector('#narration-review').open && document.querySelector('#narration-review-audio').readyState >= 2
    && document.querySelector('#narration-review-caption').value === '第二句'`, '试听应载入第二句的实际音频和台词');
  await runInWindow("document.querySelector('#narration-review-audio').play()");
  await waitFor("document.querySelector('#narration-review-audio').currentTime > 0", '第二句口播应实际播放');
  await click('#narration-review-close');
  selections.push({ title: '选择分镜素材', files: [files.blue] });
  await click(`${narrationPanel(1)} .match-shot-visual`);
  await waitFor(`document.querySelector('${visualShot(1)} .asset-name')?.textContent === ${JSON.stringify(path.basename(files.blue))}`, '第二句应匹配选定画面');
  assert.equal(await runInWindow(`document.querySelectorAll('${visualShot(0)} .asset').length`), 0, '第二句配画面应保留第一句为空');
  assert.deepEqual(selections, []);
  assert.deepEqual(saves, []);
  for (const phase of ['draft-create', 'draft-reopen']) {
    await execFileAsync(process.execPath, [__filename, phase, root, files.red, files.music], { timeout: 45000, windowsHide: true });
  }
  const reopenedDraft = JSON.parse(await fs.readFile(path.join(root, 'draft-reopened.json'), 'utf8'));
  await fs.writeFile(path.join(root, 'passed.json'), JSON.stringify({ project: path.basename(project), voiceProject: path.basename(voiceProject), segmentProject: path.basename(segmentProject), folderProject: path.basename(folderProject), reopenedDraft, montage: videos, selectedVideos, audio: audios, durations, previewDuration: previewInfo[2], voicePreviewDuration, segmentPreviewDuration }, null, 2));
  console.log(`桌面流程通过。测试素材、成片和界面截图在 ${root}`);
  win.close();
}

const [phase, draftRoot, draftVideo, draftNarration] = process.argv.slice(2);
const task = ['draft-create', 'draft-reopen'].includes(phase) ? runDraftPhase(phase, draftRoot, draftVideo, draftNarration) : run();
task.catch((error) => { console.error(error); app.exit(1); });
