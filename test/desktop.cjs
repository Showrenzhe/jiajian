'use strict';

const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { once } = require('node:events');
const { mkdirSync, mkdtempSync } = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { promisify } = require('node:util');
const { app, nativeTheme } = require('electron');
const { launchDesktop } = require('../src/desktop.cjs');
const { inspectAsset } = require('../src/media.cjs');
const { ffmpeg, fixtures } = require('./fixtures.cjs');
const { clickVisible } = require('./desktop-input.cjs');

app.disableHardwareAcceleration();
app.setVersion(require('../package.json').version);

const execFileAsync = promisify(execFile);

async function traceDockedNavigation() {
  const toggle = document.querySelector('#nav-toggle');
  const navigation = document.querySelector('#workspace-navigation');
  const area = document.querySelector('.work-area');
  const width = () => area.getBoundingClientRect().width;
  const docked = width();
  const full = area.parentElement.getBoundingClientRect().width;
  async function until(reached) {
    const deadline = performance.now() + 5000;
    const widths = [width()];
    while (!reached(widths.at(-1))) {
      if (performance.now() >= deadline) throw new Error('侧栏未到达预期位置，主区宽度 ' + widths.at(-1));
      await new Promise(requestAnimationFrame);
      const areaRect = area.getBoundingClientRect();
      if (areaRect.width > docked + 1 && areaRect.width < full - 1) {
        const sideRect = navigation.getBoundingClientRect();
        if (sideRect.width === 0 || Math.abs(sideRect.right - areaRect.left) > 1) {
          throw new Error('移动中侧栏应保持可见，其右缘应与主区的左缘相接');
        }
      }
      widths.push(areaRect.width);
    }
    return widths;
  }
  const current = navigation.querySelector('[aria-current="page"]') ?? navigation.querySelector('#tab-home');
  current.focus();
  current.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ctrlKey: true, code: 'Backslash' }));
  current.focus();
  const focusReturned = document.activeElement === toggle && navigation.inert;
  const closing = await until(w => Math.abs(w - full) < 0.02);
  toggle.click();
  const opening = await until(w => Math.abs(w - docked) < 0.02);
  toggle.click();
  const halfway = await until(w => w >= (docked + full) / 2);
  const before = halfway.at(-1);
  toggle.click();
  const reversed = await until(w => Math.abs(w - docked) < 0.02);
  return { docked, full, closing, opening, before, reversed, focusReturned, usable: !navigation.inert };
}

async function traceFloatingNavigation(mode) {
  const toggle = document.querySelector('#nav-toggle');
  const navigation = document.querySelector('#workspace-navigation');
  const area = document.querySelector('.work-area');
  const canvas = document.querySelector(mode === 'script' ? '#script-workspace' : '#editor-workspace');
  const nodes = [area, canvas];
  const initial = nodes.map(node => node.getBoundingClientRect());
  function position() {
    nodes.forEach((node, index) => {
      const rect = node.getBoundingClientRect();
      if (Math.abs(rect.width - initial[index].width) > 0.1 || Math.abs(rect.left - initial[index].left) > 0.1) {
        throw new Error(mode + ' 浮层开合过程中改变了工作区或画布的宽度或横向位置');
      }
    });
    return navigation.checkVisibility({ opacityProperty: true, visibilityProperty: true })
      ? navigation.getBoundingClientRect().right : null;
  }
  async function until(reached) {
    const deadline = performance.now() + 5000;
    const positions = [position()];
    while (!reached(positions.at(-1))) {
      if (performance.now() > deadline) throw new Error(mode + ' 浮层未到达目标位置，最后右缘 ' + positions.at(-1));
      await new Promise(requestAnimationFrame);
      positions.push(position());
    }
    return positions;
  }
  toggle.click();
  const openRight = parseFloat(getComputedStyle(navigation).left) + navigation.getBoundingClientRect().width;
  const fullyOpen = x => x !== null && Math.abs(x - openRight) < 0.02;
  const opening = await until(fullyOpen);
  const current = navigation.querySelector('#tab-home');
  const focused = document.activeElement === current && !navigation.inert;
  const escape = () => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  escape();
  current.focus();
  const focusReturned = navigation.inert && document.activeElement === toggle && toggle.getAttribute('aria-expanded') === 'false';
  const closing = await until(x => x === null);
  toggle.click();
  await until(fullyOpen);
  escape();
  const halfway = await until(x => x === null || x < openRight / 2);
  const before = halfway.at(-1);
  toggle.click();
  const reversed = await until(fullyOpen);
  return { openRight, opening, closing, before, reversed, focused, focusReturned };
}

async function checkNavigation(contents, mode) {
  const debuggerClient = contents.debugger;
  const evaluate = (code) => contents.executeJavaScript(code, true);
  const emulate = (motion, colors) => debuggerClient.sendCommand('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: motion }, { name: 'forced-colors', value: colors }],
  });
  debuggerClient.attach();
  try {
    assert.equal(await evaluate("document.querySelector('.app-frame').dataset.mode"), mode);
    await emulate('no-preference', 'none');
    // Slow the renderer timeline so intermediate frames remain observable on busy machines.
    await debuggerClient.sendCommand('Animation.setPlaybackRate', { playbackRate: 0.5 });
    if (mode === 'montage' || mode === 'script') {
      const trace = await evaluate(`(${traceFloatingNavigation})(${JSON.stringify(mode)})`);
      for (const positions of [trace.opening, trace.closing]) {
        const middle = positions.filter(x => x !== null && x > 1 && x < trace.openRight - 1);
        assert.ok(new Set(middle.map(Math.round)).size >= 2, mode + ' 浮层在展开和收起时都应有多个可见的中间位置');
      }
      assert.ok(trace.before > 1 && Math.abs(trace.reversed[0] - trace.before) < 1, mode + ' 退出中重开应从原位开始');
      assert.ok(trace.reversed.every(x => x !== null && x >= trace.before - 1), mode + ' 反向时应保持可见并直接展开');
      assert.ok(trace.focused && trace.focusReturned, mode + ' 浮层应聚焦工作台入口，Esc 应立即把焦点和操作权还给开关');
      const { x, y } = await evaluate(`(() => {
        const {x, y, width, height} = document.querySelector('#title-tab').getBoundingClientRect();
        return { x: x + width / 2, y: y + height / 2 };
      })()`);
      for (const type of ['mousePressed', 'mouseReleased']) {
        await debuggerClient.sendCommand('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
      }
      assert.ok(await evaluate(`document.querySelector('#workspace-navigation').inert
        && document.querySelector('#nav-toggle').getAttribute('aria-expanded') === 'false'`), mode + ' 外部点击应收起浮层');
      for (const [motion, colors] of [['reduce', 'none'], ['no-preference', 'active']]) {
        await emulate(motion, colors);
        const states = await evaluate(`(() => {
          const toggle = document.querySelector('#nav-toggle');
          const nav = document.querySelector('#workspace-navigation');
          toggle.click();
          const current = nav.querySelector('#tab-home');
          const open = nav.checkVisibility() && !nav.inert && document.activeElement === current
            && Math.abs(nav.getBoundingClientRect().right - ${trace.openRight}) < 0.02;
          const noFalseSelection = !nav.querySelector('[aria-current="page"]');
          const emulated = matchMedia('(prefers-reduced-motion: ${motion}) and (forced-colors: ${colors})').matches;
          toggle.click();
          return {emulated, open, noFalseSelection, closed: !nav.checkVisibility() && nav.inert && document.activeElement === toggle};
        })()`);
        assert.ok(states.emulated && states.open && states.closed, mode + ' 使用减少动态效果或高对比时应即时开合并保持焦点可用');
        assert.ok(states.noFalseSelection, mode + ' 侧栏应只标记与当前页对应的入口');
      }
      return;
    }
    const { docked, full, closing, opening, before, reversed, focusReturned, usable } =
      await evaluate(`(${traceDockedNavigation})()`);
    for (const widths of [closing, opening]) {
      const middle = widths.filter(w => w > docked + 1 && w < full - 1);
      assert.ok(new Set(middle.map(Math.round)).size >= 2, '侧栏展开和收起都应经过多个不同的主区宽度');
    }
    assert.ok(before < full - 1 && Math.abs(before - reversed[0]) < 1, '动画中反向应从当前位置开始');
    assert.ok(reversed.every(w => w <= before + 1) && usable, '反向后应直接回到可操作的展开状态');
    assert.ok(focusReturned, '收起时应立即禁止侧栏获得焦点，并将焦点还给开关');
    await emulate('reduce', 'none');
    await evaluate('new Promise(resolve => requestAnimationFrame(resolve))');
    assert.equal(await evaluate("matchMedia('(prefers-reduced-motion: reduce)').matches"), true);
    const widths = await evaluate(`(() => {
      const toggle = document.querySelector('#nav-toggle');
      const width = () => document.querySelector('.work-area').getBoundingClientRect().width;
      toggle.click();
      const closed = width();
      toggle.click();
      return [closed, width()];
    })()`);
    assert.deepEqual(widths, [full, docked], '减少动态效果时应在切换当下抵达目标宽度');
    if (mode === 'home') {
      await emulate('reduce', 'active');
      assert.ok(await evaluate(`getComputedStyle(document.querySelector('#workspace-navigation [aria-current="page"]')).outlineStyle !== 'none'`),
        '高对比度下应保留当前页的可见标记');
    }
  } finally {
    await debuggerClient.sendCommand('Emulation.setEmulatedMedia', { features: [] });
    await debuggerClient.sendCommand('Animation.setPlaybackRate', { playbackRate: 1 });
    debuggerClient.detach();
  }
}

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
    await click('#nav-toggle');
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
    assert.ok(await evaluate(`document.querySelector('#nav-toggle').getAttribute('aria-expanded') === 'false'
      && document.querySelector('#workspace-navigation').inert
      && document.querySelector('.work-area').clientWidth === document.querySelector('.app-frame').clientWidth`),
    '进程重启时应直接恢复收起的侧栏和整宽主区');
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
  async function checkFold(toggleSelector, bodySelector) {
    const { heights, animate } = await runInWindow(`(async () => {
      const toggle = document.querySelector(${JSON.stringify(toggleSelector)});
      const body = document.querySelector(${JSON.stringify(bodySelector)});
      const height = () => body.getBoundingClientRect().height;
      const heights = [height()];
      toggle.click();
      const deadline = performance.now() + 5000;
      do {
        if (performance.now() > deadline) throw new Error('折叠动效未结束');
        heights.push(height());
        await new Promise(requestAnimationFrame);
      } while (body.getAnimations().some(animation => animation.playState === 'running'));
      heights.push(height());
      return { heights, animate: matchMedia('(prefers-reduced-motion: no-preference) and (forced-colors: none)').matches };
    })()`);
    const start = heights[0], end = heights.at(-1);
    assert.ok(start > end + 2, bodySelector + ' 折叠后实际高度应减小');
    if (animate) assert.ok(heights.some(h => h > end + 1 && h < start - 1), bodySelector + ' 折叠应经过可见的中间高度');
    else assert.equal(heights[1], end, bodySelector + ' 减动或高对比模式应即时抵达折叠高度');
    return end;
  }
  async function screenshot(file, selector = '#export-heading') {
    // Match a visible label against its rendered text color, independent of the current theme.
    const label = await runInWindow(`(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element?.checkVisibility()) return null;
      const { left, right, top, bottom } = element.getBoundingClientRect();
      const paint = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
      paint.fillStyle = getComputedStyle(element).color;
      paint.fillRect(0, 0, 1, 1);
      const rgb = Array.from(paint.getImageData(0, 0, 1, 1).data);
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
  const navigate = selector => clickVisible(win.webContents, selector);
  async function goHome() {
    await navigate('#title-home');
    await waitFor('!document.querySelector("#home").hidden', '首页应可见');
  }
  async function checkButtonIcons(selector) {
    const broken = await runInWindow(`[...document.querySelectorAll(${JSON.stringify(selector)})].filter(button => {
      const icon = button.querySelector('svg use');
      const symbol = icon && document.getElementById(icon.getAttribute('href').slice(1));
      const bounds = icon?.getBBox();
      return symbol?.localName !== 'symbol' || !icon.checkVisibility() || !(bounds.width > 0 && bounds.height > 0);
    }).map(button => button.id || button.textContent.trim())`);
    assert.deepEqual(broken, [], '可见按钮应引用有实际绘制范围的图标');
  }
  const toolIds = ['home-import', 'tab-montage', 'tab-scene-split', 'tab-script', 'tab-audio'];
  const workflowIds = ['replicate', 'ai-video', 'smart-slice', 'assets', 'digital-avatar', 'voice-clone',
    'face-fusion', 'distribution', 'analytics', 'tasks', 'teams'];
  await waitFor('document.querySelector("#draft-status-title").textContent === "还没有本地草稿"', '空草稿首页应载入');
  assert.deepEqual(await runInWindow('[...document.querySelectorAll("#home-local-tools button")].map(b => b.id)'), toolIds);
  assert.deepEqual(await runInWindow('[...document.querySelectorAll("#workspace-navigation [data-workflow]")].map(b => b.dataset.workflow)'), workflowIds);
  assert.ok(await runInWindow(`!document.querySelector('#workspace-navigation details, #workspace-navigation summary') &&
    [...document.querySelectorAll('#workspace-navigation [data-workflow]')].every(b => b.checkVisibility()) &&
    [...document.querySelectorAll('#home-local-tools button')].every(b =>
      [...document.querySelectorAll('#workspace-navigation button, #home button')].filter(other =>
        other.checkVisibility() && other.textContent.trim() === b.textContent.trim()).length === 1)`),
  '侧栏应直接展示全部业务入口，首页五项本地创作各出现一次');
  const homeSize = win.getSize();
  for (const [width, height] of [[850, 600], homeSize]) {
    win.setSize(width, height);
    await waitFor(`Math.abs(innerWidth - ${width}) <= 1`, '首页应更新窗口宽度');
    assert.ok(await runInWindow(`(() => {
      const rail = document.querySelector('#home-local-tools').getBoundingClientRect();
      const drafts = document.querySelector('.draft-content').getBoundingClientRect();
      const buttons = [...document.querySelectorAll('#home-local-tools button')];
      return drafts.width > 0 && rail.left >= drafts.right && rail.right <= innerWidth &&
        Math.abs(rail.top - drafts.top) <= 1 && document.documentElement.scrollWidth <= innerWidth &&
        buttons.every(button => button.checkVisibility() && button.scrollWidth <= button.clientWidth + 1);
    })()`), width + 'px 首页应在草稿右侧显示五个完整入口');
    await navigate('#tab-audio');
    await waitFor('document.querySelector(".app-frame").dataset.mode === "audio"', '应从右侧工具打开音频提取');
    await goHome();
  }
  for (const theme of ['light', 'dark']) {
    nativeTheme.themeSource = theme;
    await waitFor(`document.documentElement.dataset.theme === '${theme}' && !document.documentElement.hasAttribute('data-theme-changing')`,
      '首页应完成明暗切换');
    await checkButtonIcons('#workspace-navigation button, #home-local-tools button');
    await screenshot('home-' + theme + '.png', '#local-tools-heading');
  }
  nativeTheme.themeSource = 'system';
  // Tab through the complete group and activate the last entry using a native Enter event.
  const client = win.webContents.debugger;
  client.attach();
  try {
    await client.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    async function key(name, keyCode) {
      for (const type of ['keyDown', 'keyUp']) {
        const text = type === 'keyDown' && name === 'Enter' ? '\r' : '';
        await client.sendCommand('Input.dispatchKeyEvent', { type, key: name, code: name, windowsVirtualKeyCode: keyCode, text });
      }
    }
    await runInWindow('document.querySelector("#draft-rows").focus()');
    for (const id of toolIds) {
      await key('Tab', 9);
      assert.equal(await runInWindow('document.activeElement.id'), id, 'Tab 应依次访问本地创作入口');
    }
    await key('Enter', 13);
    await waitFor('document.querySelector(".app-frame").dataset.mode === "audio"', 'Enter 应打开音频提取');
  } finally {
    client.detach();
  }
  await goHome();
  await navigate('#tab-drafts');
  await waitFor(`!document.querySelector('#home-local-tools').checkVisibility() &&
    document.querySelector('#draft-heading-label').textContent === '全部草稿' &&
    document.querySelector('#draft-status-action').checkVisibility() &&
    document.querySelector('#draft-status-action').textContent === '导入素材'`, '空草稿专页应保留自己的导入入口');
  await navigate('#tab-home');
  await navigate('#tab-scene-split');
  await waitFor('document.querySelector("#scene-split-workspace").checkVisibility()', '场景分割入口应可点击');
  await goHome();
  for (const id of workflowIds) {
    const selector = '#workspace-navigation [data-workflow="' + id + '"]';
    const label = await runInWindow(`document.querySelector(${JSON.stringify(selector)}).textContent.trim()`);
    await navigate(selector);
    await waitFor(`document.querySelector('#service-title').textContent === ${JSON.stringify(label)} &&
      document.querySelector(${JSON.stringify(selector)}).getAttribute('aria-current') === 'page'`, label + ' 应直接打开并标记选中');
  }
  await goHome();
  await checkNavigation(win.webContents, 'home');
  const files = await fixtures(root);
  const output = path.join(root, 'output');
  await fs.mkdir(output);

  await navigate('#tab-montage');
  await waitFor('!document.querySelector("#project-workspace").hidden && document.querySelector("#project-list-status").textContent.includes("还没有本地项目")', '批量混剪应先进入项目工作区');
  await checkNavigation(win.webContents, 'project');
  await runInWindow('document.querySelector("#project-new").click()');
  await waitFor('!document.querySelector("#editor-workspace").hidden', '新工程应进入剪辑台');
  await checkButtonIcons('#material-import, #material-folder-import, #material-audio-open');
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
  await checkNavigation(win.webContents, 'montage');
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
  // The viewport can report its restored size a frame before the pane ResizeObserver lays out the grid.
  await runInWindow('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const defaultMaterial = await runInWindow(materialBox);
  const defaultPlayer = await runInWindow("document.querySelector('.editor-player').getBoundingClientRect().toJSON()");
  await navigate('#panel-layout-toggle');
  const grip = '.panel-layout-box[data-pane="materials"] [data-edge="move"]';
  await waitFor(`document.querySelectorAll('.panel-layout-box [data-edge="move"]').length === 4
    && document.querySelector(${JSON.stringify(grip)}).checkVisibility()`, '布局编辑时四个面板都应可拖动');
  const start = await runInWindow(`document.querySelector(${JSON.stringify(grip)}).getBoundingClientRect().toJSON()`);
  client.attach();
  try {
    const from = { x: start.x + start.width / 2, y: start.y + start.height / 2 };
    const to = { x: defaultPlayer.x + defaultPlayer.width / 2, y: defaultPlayer.y + defaultPlayer.height / 2 };
    await client.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', ...from, button: 'left', buttons: 1, clickCount: 1 });
    await client.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...to, button: 'left', buttons: 1 });
    await client.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', ...to, button: 'left', clickCount: 1 });
  } finally {
    client.detach();
  }
  const materialInPlayerSlot = `Math.abs((${materialBox}).x - ${defaultPlayer.x}) < 2
    && Math.abs((${materialBox}).width - ${defaultPlayer.width}) < 2`;
  await waitFor(materialInPlayerSlot, '素材库应取得原播放器的位置和宽度');
  await navigate('#panel-layout-toggle');
  const layoutReload = once(win.webContents, 'did-finish-load');
  win.webContents.reload();
  await layoutReload;
  await navigate('#tab-montage');
  await navigate('#project-new');
  await waitFor(materialInPlayerSlot, '重开工作台应保留互换后的面板位置和宽度');
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
  await goHome();
  await navigate('[data-workflow=replicate]');
  await waitFor('document.querySelector("#service-title").textContent === "爆款复刻" && document.querySelector("#service-status").textContent === "待接入 API"', '待接入功能应说明真实状态');
  assert.equal(await runInWindow('document.querySelectorAll("#service-actions button").length'), 0);
  assert.ok(await runInWindow('document.querySelector("#creative-workflow-settings")?.checkVisibility()'), '未配置创作服务时应提供服务设置入口');
  await goHome();
  await navigate('#tab-script');
  await waitFor('document.querySelectorAll("#script-rows .script-row").length === 3', '脚本页应显示三个初始脚本行');
  await checkNavigation(win.webContents, 'script');
  await navigate('#nav-toggle');
  await waitFor("document.querySelector('#workspace-navigation').getBoundingClientRect().left >= 0", '浮层展开后应能点击草稿');
  await navigate('#tab-drafts');
  assert.ok(await runInWindow(`document.activeElement.id === 'draft-heading'
    && document.querySelector('.app-frame').dataset.navigation === 'docked'
    && !document.querySelector('#workspace-navigation').inert`), '从脚本浮层切到本地草稿应聚焦可见的草稿标题并恢复常驻侧栏');
  assert.equal(await runInWindow('document.querySelector("#home-local-tools").checkVisibility()'), false);
  await navigate('#tab-home');
  await navigate('#tab-script');
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
  await navigate('#tab-script');
  await waitFor('document.querySelector(".script-dialogue")?.value === "开头台词"', '重新加载后应恢复本地脚本草稿');
  await runInWindow('document.querySelector("#script-go-montage").click()');
  await waitFor('!document.querySelector("#script-brief").hidden && document.querySelector("#script-brief-rows").textContent.includes("展示第一镜")', '脚本和备注应进入混剪工程');
  await goHome();

  selections.push({ title: '选择分镜素材', files: [files.red, files.green, files.still] });
  assert.equal(await runInWindow('document.querySelector("#home").hidden'), false);
  await navigate('#home-import');
  await waitFor('document.querySelectorAll("#shots .shot").length === 3', '导入后应有三个分镜');
  assert.equal(await runInWindow('document.querySelectorAll("#material-list .material-tile").length'), 3);
  const visibleThumbnail = `(() => {
    const img = document.querySelector('.material-tile[data-kind="video"] img');
    return img?.getAttribute('src')?.startsWith('sd-workbench://asset/thumbnail/') && img.naturalWidth === 240;
  })()`;
  await waitFor(visibleThumbnail, '素材库应解码实际视频缩略图');
  await waitFor('document.querySelectorAll("#timeline-clock .sequence-shots .sequence-block").length===3', '时间线应与三个分镜一一对应');
  assert.equal(await runInWindow('document.querySelector("#timeline-view").value'), 'time');
  await require('./timeline-interaction.cjs')(win, runInWindow, waitFor, checkFold);
  await runInWindow('document.querySelector("#timeline-layer-add").click()');
  await runInWindow(`(() => {const d=document.querySelector(".sequence-dialog[open]");d.querySelector("textarea").value="产品展示";d.querySelector("form").requestSubmit();})()`);
  await waitFor('document.querySelector("#timeline-clock .kind-text")?.textContent.includes("产品展示")', '全局文字应出现在独立轨道');
  await runInWindow('document.querySelector("#track-undo").click()');
  await waitFor('!document.querySelector("#timeline-clock .kind-text")','撤销应同步移除全局文字');
  await runInWindow('document.querySelector("#timeline-clock .sequence-video .sequence-block").click()');
  await runInWindow(`(() => { const view = document.querySelector('#timeline-view'); view.value = 'cards'; view.dispatchEvent(new Event('change')); })()`);
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
  await runInWindow('document.querySelector("#material-list .material-tile").click()');
  assert.equal(await runInWindow('document.querySelector("#preview-heading").textContent'), '素材预览');
  assert.ok(await runInWindow('document.querySelector("#clip-inspector").hidden'), '素材库原片应独立于轨道裁剪参数');
  await runInWindow('document.querySelector("#shots .asset-name").click()');
  assert.equal(await runInWindow('document.querySelector("#preview-heading").textContent'), '轨道预览');
  assert.ok(await runInWindow('!document.querySelector("#clip-inspector").hidden'), '点击轨道素材应打开画面属性');
  await runInWindow('document.querySelector("#clip-enabled").click()');
  assert.ok(await runInWindow('document.querySelector("#prepare-preview").disabled && document.querySelector("#combinations").textContent.includes("分镜 1 未勾选")'));
  await runInWindow('document.querySelector("#clip-enabled").click(); document.querySelector("#clip-track-muted").click()');
  assert.equal(await runInWindow('document.querySelector("#preview").volume'), 0);
  await runInWindow('document.querySelector("#clip-track-muted").click()');
  assert.equal(await runInWindow('document.querySelector("#preview").volume'), 1);
  await runInWindow('document.querySelector("#player-next").click()');
  await waitFor('Math.abs(document.querySelector("#preview").currentTime - 1 / selected.asset.fps) < 0.008', '下一帧应按素材帧率前进');
  await runInWindow('document.querySelector("#player-stop").click()');
  await waitFor('document.querySelector("#preview").paused && document.querySelector("#preview").currentTime < 0.001', '停止应回到片段入点');
  await runInWindow('document.querySelector("#player-ratio").value = "9:16"; document.querySelector("#player-ratio").dispatchEvent(new Event("change"))');
  assert.equal(await runInWindow('document.querySelector("#ratio").value'), '9:16');
  await runInWindow('document.querySelector("#player-ratio").value = "16:9"; document.querySelector("#player-ratio").dispatchEvent(new Event("change"))');
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
  await goHome();
  await navigate('#tab-montage');
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
  await navigate('#caption-presets button[title="醒目黄字"]');
  await waitFor('document.querySelector("#caption-preview-canvas").dataset.rendered === "true" && document.querySelector("#caption-bold").checked', '实际字幕渲染预览应显示所选预设');
  await runInWindow('document.querySelector("#caption-enabled").click()');
  assert.match(await runInWindow('document.querySelector("#caption-feedback").textContent'), /关闭/);
  await runInWindow('document.querySelector("#caption-enabled").click()');
  await runInWindow(`(() => {
    const size = document.querySelector('#caption-size');
    size.value = '26';
    size.dispatchEvent(new Event('input', { bubbles: true }));
    const position = document.querySelector('#caption-position');
    position.value = 'top';
    position.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await navigate('#caption-align label:has([value=left])');
  await navigate('#caption-save-preset');
  await runInWindow('document.querySelector("#caption-preset-name").value = "片头黄字"');
  await navigate('#caption-confirm-preset');
  const personalCaption = '#caption-personal-presets button[title="片头黄字"]';
  await navigate('#caption-presets button[title="蓝色描边"]');
  await navigate(personalCaption);
  assert.equal(await runInWindow(`document.querySelector(${JSON.stringify(personalCaption)}).getAttribute('aria-pressed')`), 'true');
  assert.equal(await runInWindow("document.querySelectorAll(':is(#caption-presets, #caption-personal-presets) button[aria-pressed=true]').length"), 1);
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
  assert.equal(await runInWindow('document.querySelector("#caption-color").value'), '#ffe25a');
  assert.equal(await runInWindow('document.querySelector("#caption-align input:checked").value'), 'left');
  assert.equal(await runInWindow('document.querySelector("#caption-size-slider").valueAsNumber'), 26);
  assert.equal(await runInWindow('document.querySelector("#caption-preset-label").textContent'), '片头黄字');
  assert.equal(await runInWindow(`document.querySelector(${JSON.stringify(personalCaption)}).getAttribute('aria-pressed')`), 'true');
  assert.equal(await runInWindow("document.querySelectorAll(':is(#caption-presets, #caption-personal-presets) button[aria-pressed=true]').length"), 1);
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

  await goHome();
  await waitFor('document.querySelectorAll("#history-list li").length === 3', '首页应列出三条真实成片');
  await navigate('#tab-audio');
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
  await goHome();
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
  await navigate('#tab-montage');
  await navigate('#project-new');
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
  await runInWindow(`(${folder(path.basename(library))}).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
  await waitFor(`document.querySelectorAll(${JSON.stringify(tiles)}).length === 1 && Boolean(document.querySelector(${JSON.stringify(material(files.green))})) && Boolean(${folder(path.basename(nested))})`, '打开目录后应只显示支持的文件与子目录');
  await waitFor(`document.querySelector(${JSON.stringify(`${material(files.green)} img`)})?.naturalWidth > 0`, '打开视频前应看到已解码的文件夹视频缩略图');
  await click(material(files.green));
  await waitFor(`document.querySelector('#preview-name').textContent === ${JSON.stringify(path.basename(files.green))} && document.querySelector('#preview').readyState >= 2`, '目录内视频应能实际解码预览');
  assert.equal(await runInWindow('document.querySelectorAll("#shots .shot").length'), 0, '浏览和预览素材也不生成分镜');
  await dragMaterial(files.green, '#new-shot-drop');
  await waitFor('document.querySelectorAll("#shots .shot").length === 1 && document.querySelectorAll("#shots .asset").length === 1', '拖到新分镜区应生成一个分镜');
  await runInWindow(`(${folder(path.basename(nested))}).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
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

  await runInWindow(`(() => { const view=document.querySelector('#timeline-view');view.value='cards';view.dispatchEvent(new Event('change')); })()`);
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
  await runInWindow(`(() => {const view=document.querySelector('#timeline-view');view.value='time';view.dispatchEvent(new Event('change'));})()`);
  await waitFor(`(() => {const viewport=document.querySelector('#timeline-clock');return viewport.scrollWidth>viewport.clientWidth+100 && !document.querySelector('#track-horizontal-scroll').hidden;})()`,'时间线模式也应显示底部滚动条');
  await runInWindow('document.querySelector("#track-horizontal-scroll").scrollLeft = document.querySelector("#track-horizontal-scroll").scrollWidth');
  await waitFor(`(() => {const view=document.querySelector('#timeline-clock'),last=view.querySelector('.sequence-shots .sequence-block:last-child');
    return view.scrollLeft>100 && last.getBoundingClientRect().right<=view.getBoundingClientRect().right+2;})()`,'时间线的底部滑块应能到达最后一个分镜');
  await runInWindow(`(() => {const view=document.querySelector('#timeline-view');view.value='cards';view.dispatchEvent(new Event('change'));})()`);
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
  assert.equal(await checkFold(`${firstClip} .clip-toggle`, `${firstClip} .trim-fields`), 0, '候选素材参数应完全收起');
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
  await goHome();
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
  const wideVideo = path.join(root, '高清素材.mp4');
  await ffmpeg(['-i', files.red, '-vf', 'scale=960:720', '-c:v', 'libx264', '-threads', '2', '-c:a', 'copy', wideVideo]);
  await goHome();
  await click('#home-create');
  await waitFor("!document.querySelector('#editor-workspace').hidden && !document.querySelector('#material-import').disabled", '新草稿完成初始化后应启用素材导入');
  selections.push({ title: '选择分镜素材', files: [wideVideo] });
  await click('#material-import');
  await waitFor('document.querySelector("#preview").videoWidth === 640 && document.querySelector("#preview").currentSrc.includes("/track-proxy/")', '高清轨道索引应实际解码本地低分辨率代理');
  await click('#material-list .material-tile');
  await waitFor('document.querySelector("#preview").videoWidth === 960 && !document.querySelector("#preview").currentSrc.includes("/track-proxy/")', '回到素材库应恢复原片画质');
  await click('#subproject-new');
  await runInWindow('document.querySelector("#subproject-name").value = "杭州门店"; document.querySelector("#subproject-new-form").requestSubmit()');
  await waitFor('document.querySelector("#subproject-select").selectedOptions[0].textContent === "杭州门店"', '应在刚创建的子工程中编辑');
  await click('#subproject-materials');
  selections.push({ title: '选择分镜素材', files: [files.blue] });
  await click('#subproject-replace');
  await waitFor('document.querySelector("#shots .asset-name").textContent.includes("蓝色")', '子工程应使用专属画面');
  const savedBranch = path.join(root, '门店子工程.sdworkbench');
  saves.push({ title: '保存工程', file: savedBranch });
  await click('#save-project');
  await waitFor('document.querySelector("#project-status").textContent.includes("门店子工程")', '选择的子工程应能保存');
  const branchAsset = await runInWindow('document.querySelector("#material-list .material-tile").dataset.materialId');
  selections.push({ title: '打开工程', files: [savedBranch] });
  await click('#open-project');
  await waitFor(`document.querySelector("#subproject-select").selectedOptions[0].textContent === "杭州门店" && document.querySelector("#material-list .material-tile").dataset.materialId !== ${JSON.stringify(branchAsset)}`, '重开工程应保留子工程选择');
  await runInWindow('document.querySelector("#subproject-select").selectedIndex = 0; document.querySelector("#subproject-select").dispatchEvent(new Event("change"))');
  assert.equal(await runInWindow('document.querySelector("#shots .asset-name").textContent'), '高清素材.mp4');
  await click('#subproject-new');
  await runInWindow('document.querySelector("#subproject-name").value = "上海门店"; document.querySelector("#subproject-new-form").requestSubmit()');
  await click('#subproject-batch');
  await click('#subproject-batch-confirm');
  await waitFor('document.querySelectorAll("#preview-batch-list .batch-title").length === 2', '选中的两家门店应各生成一份预览');
  assert.deepEqual(await runInWindow('Array.from(document.querySelectorAll(".batch-title"), (item) => item.textContent)'), ['杭州门店 · 第 1 条', '上海门店 · 第 2 条']);
  await runInWindow('document.querySelector("#batch-project-filter").selectedIndex = 2; document.querySelector("#batch-project-filter").dispatchEvent(new Event("change"))');
  await click('#select-all-previews');
  assert.equal(await runInWindow('document.querySelectorAll(".batch-select:checked").length'), 1);
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
