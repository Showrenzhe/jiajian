'use strict';

const { clickVisible } = require('./desktop-input.cjs');

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { app, powerMonitor, shell } = require('electron');
const { launchDesktop } = require('../src/desktop.cjs');

app.disableHardwareAcceleration();

async function run() {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'jiajian-update-ui-'));
  const drafts = path.join(profile, 'drafts');
  const notes = '保存草稿后重启\n<img src=x onerror="window.releaseHtmlExecuted=true">';
  const download = Promise.withResolvers();
  const task = Promise.withResolvers();
  const taskStarted = Promise.withResolvers();
  let checks = 0, downloads = 0, installs = 0;
  let clock = Date.now(), version = '0.6.4';
  const fourHours = 4 * 60 * 60 * 1000;
  let send;
  const win = await launchDesktop({
    show: false, dataDirectory: profile, checkOnStartup: true, updateClock: () => clock,
    cloudTts: {
      status: () => ({ configured: true }),
      sample() { taskStarted.resolve(); return task.promise; },
    },
    updateFactory({ onState }) {
      let state = { currentVersion: '0.6.3', status: 'idle', canManageInstallation: true };
      send = (status, details) => {
        state = { ...state, status, retry: null, message: '', ...details };
        onState(state);
        return state;
      };
      return {
        getState: () => state,
        check() { checks++; return send('available', { version, notes }); },
        async download() {
          if (++downloads === 1) return send('error', { retry: 'download', message: '测试下载失败' });
          send('downloading', { percent: 37 });
          await download.promise;
          return send('downloaded', { percent: 100 });
        },
        install() {
          installs++;
          if (installs === 1) return send('error', { retry: 'install', message: '测试安装失败' });
          return send('installing');
        },
      };
    },
  });

  const read = (js) => win.webContents.executeJavaScript(js, true);
  const click = (id) => read(`document.getElementById(${JSON.stringify(id)}).click()`);
  const textOf = (id) => read(`document.getElementById(${JSON.stringify(id)}).textContent`);
  async function until(js) {
    const end = Date.now() + 8000;
    while (!await read(js)) {
      if (Date.now() > end) throw new Error('Timed out waiting for ' + js);
      await delay(25);
    }
  }
  const waitError = () => until('!document.getElementById("update-error").hidden && !document.getElementById("update-action").disabled');
  const openToolbarUpdate = async () => {
    await click('software-update-entry');
    await until('document.getElementById("update-dialog").open');
  };
  async function expectBadge(expectedVersion) {
    const details = await read(`(() => {
      const entry = document.getElementById('software-update-entry');
      const dot = entry.querySelector('#update-badge');
      return { hidden: dot.hidden, visible: dot.checkVisibility(), decorative: !!dot.closest('[aria-hidden="true"]'),
        title: entry.title, label: entry.getAttribute('aria-label') };
    })()`);
    assert.equal(details.hidden, !expectedVersion);
    assert.equal(details.visible, !!expectedVersion);
    assert.ok(details.decorative, 'The dot must be excluded from the accessibility tree');
    assert.ok(details.label.includes('软件更新'));
    if (expectedVersion) {
      assert.ok(details.title.includes('佳剪 v' + expectedVersion));
      assert.ok(details.label.includes(details.title));
    } else {
      assert.equal(details.label, '软件更新');
      assert.doesNotMatch(details.title, /可更新|v\d/);
    }
  }
  const debuggerApi = win.webContents.debugger;
  debuggerApi.attach();
  await debuggerApi.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
  async function press(key, windowsVirtualKeyCode, modifiers = 0) {
    for (const type of ['keyDown', 'keyUp']) {
      await debuggerApi.sendCommand('Input.dispatchKeyEvent', {
        type, key, code: key, windowsVirtualKeyCode, modifiers, text: type === 'keyDown' && key === 'Enter' ? '\r' : '',
      });
    }
  }

  await until('!document.getElementById("update-notice").hidden');
  assert.equal(checks, 1);
  assert.equal(await read('!!document.querySelector("dialog[open]")'), false);
  assert.equal(downloads, 0);
  assert.ok(await read(`(() => {
    const entry = document.querySelector('.titlebar #software-update-entry');
    const group = entry?.closest('#titlebar-update');
    const shortcuts = document.querySelector('#cut-shortcuts-entry');
    const settings = document.querySelector('#app-settings');
    return entry?.checkVisibility() && entry.textContent.includes('软件更新') &&
      shortcuts?.checkVisibility() && settings?.checkVisibility() &&
      group?.nextElementSibling === shortcuts && shortcuts.nextElementSibling === settings &&
      group.getBoundingClientRect().right <= shortcuts.getBoundingClientRect().left &&
      shortcuts.getBoundingClientRect().right <= settings.getBoundingClientRect().left;
  })()`), 'The title bar should show Updates, Shortcuts and Settings in order');
  assert.match(await textOf('update-notice'), /发现新版本 0\.6\.4/);
  await expectBadge(version);
  assert.equal(await read('document.getElementById("software-update-entry").title'), '佳剪 v0.6.4 可更新');
  const [wide, height] = win.getContentSize();
  for (const scheme of ['light', 'dark']) {
    await debuggerApi.sendCommand('Emulation.setEmulatedMedia', { features: [
      { name: 'prefers-color-scheme', value: scheme }, { name: 'prefers-reduced-motion', value: 'reduce' },
    ] });
    await until(`document.documentElement.dataset.theme === "${scheme}"`);
    for (const width of [900, 1200]) {
      win.setContentSize(width, height);
      await until(`Math.abs(innerWidth - ${width}) <= 1`);
      await expectBadge(version);
      assert.equal(await read('document.getElementById("update-notice").checkVisibility()'), width === 1200);
      assert.equal(await read('document.getElementById("update-notice-dismiss").checkVisibility()'), width === 1200);
      assert.ok(await read(`(() => {
        const entry = document.getElementById('software-update-entry').getBoundingClientRect();
        const dot = document.getElementById('update-badge');
        const rect = dot.getBoundingClientRect();
        const ctx = document.createElement('canvas').getContext('2d');
        ctx.fillStyle = getComputedStyle(dot).backgroundColor;
        ctx.fillRect(0, 0, 1, 1);
        const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
        return a === 255 && r > g * 1.5 && r > b * 1.5 && rect.width >= 4 && rect.height >= 4 &&
          rect.left >= entry.left && rect.top >= entry.top && rect.right <= entry.right && rect.bottom <= entry.bottom;
      })()`), scheme + ' ' + width + 'px must display a red dot inside the update button');
    }
  }
  win.setContentSize(wide, height);
  await until(`Math.abs(innerWidth - ${wide}) <= 1`);
  await click('update-notice-dismiss');
  assert.equal(await read('document.getElementById("update-notice").hidden'), true);
  await expectBadge(version);
  assert.equal(await read('document.activeElement.id'), 'software-update-entry');
  await press('Enter', 13);
  await until('document.getElementById("update-dialog").open');
  assert.equal(await read('document.querySelectorAll("dialog[open]").length'), 1);
  assert.equal(downloads, 0, 'Opening update details should not start a download');
  assert.ok(await read('document.getElementById("update-manage-installation").checkVisibility()'));
  const settingsOpened = Promise.withResolvers();
  const originalOpen = shell.openExternal;
  try {
    shell.openExternal = async (url) => { settingsOpened.resolve(url); };
    await click('update-manage-installation');
    assert.equal(await settingsOpened.promise, 'ms-settings:appsfeatures');
    assert.equal(installs, 0);
    assert.ok(await read('document.getElementById("update-dialog").open'));
  } finally { shell.openExternal = originalOpen; }
  await press('Escape', 27);
  await until('!document.getElementById("update-dialog").open && document.activeElement.id === "software-update-entry"');
  await expectBadge(version);
  await press('Tab', 9);
  assert.equal(await read('document.activeElement.id'), 'cut-shortcuts-entry');
  await press('Tab', 9, 8); // Shift+Tab moves back to the update entry.
  assert.ok(await read(`(() => {
    const entry = document.querySelector('#software-update-entry:focus-visible');
    return entry && getComputedStyle(entry, '::after').content.includes(entry.title);
  })()`), 'A keyboard user should see the available version on focus');
  await press('Tab', 9);
  await press('Tab', 9);
  assert.equal(await read('document.activeElement.id'), 'app-settings');
  await press('Enter', 13);
  await until('document.getElementById("cloud-settings-dialog")?.open');
  assert.ok(await read('document.getElementById("appearance-settings").checkVisibility()'));
  assert.equal(await read('document.querySelector("#cloud-settings-dialog #software-update-entry")'), null);
  await press('Escape', 27);
  await until('!document.getElementById("cloud-settings-dialog").open');
  send('checking');
  await until('document.getElementById("update-status").textContent.includes("正在检查")');
  await expectBadge(version);
  send('error', { retry: 'check', message: '测试复查网络失败' });
  await until('document.getElementById("update-status").textContent === "测试复查网络失败"');
  await expectBadge(version);
  clock += fourHours - 1;
  win.emit('focus');
  assert.equal(checks, 1);
  clock++;
  version = '0.6.5';
  powerMonitor.emit('resume');
  await until('!document.getElementById("update-notice").hidden && document.getElementById("update-notice").textContent.includes("0.6.5")');
  win.emit('focus');
  assert.equal(checks, 2, 'Resume and focus must share one check interval');
  await openToolbarUpdate();
  assert.equal(await textOf('update-notes'), notes);
  assert.equal(await read('document.querySelector("#update-notes img") || window.releaseHtmlExecuted || null'), null);
  await click('update-action');
  await until('document.getElementById("update-action").textContent === "重试下载" && !document.getElementById("update-action").disabled');
  assert.equal(await textOf('update-status'), '测试下载失败');
  await expectBadge(version);
  await clickVisible(win.webContents, '#update-action');
  await until('document.getElementById("update-progress").value === 37');
  await expectBadge(version);
  assert.equal(await read('document.activeElement.id'), 'update-close', '下载时键盘应停在仍可用的关闭按钮');
  clock += fourHours;
  win.emit('focus');
  assert.equal(checks, 2, 'An active download must keep its state');
  await click('update-close');
  download.resolve();
  await until('document.getElementById("update-notice").checkVisibility() && document.getElementById("update-notice").textContent.includes("更新已就绪")');
  await expectBadge(version);
  await openToolbarUpdate();
  await until('document.getElementById("update-action").textContent === "保存并重启更新" && !document.getElementById("update-action").disabled');

  await read('window.heldSample = workbench.cloudTtsSample("sample").catch(() => {}); void 0');
  await taskStarted.promise;
  await click('update-action');
  await waitError();
  assert.match(await textOf('update-error'), /任务完成/);
  assert.equal(installs, 0);
  task.reject(new Error('测试任务已结束'));
  await read('window.heldSample');

  await click('update-close');
  await click('app-settings');
  await until('document.getElementById("cloud-settings-dialog").open && !document.getElementById("cloud-settings-api-key").disabled');
  await read('document.getElementById("cloud-settings-api-key").value="未保存的设置"');
  // Settings is modal. Exercise the same install IPC as the update button while a settings edit is pending.
  const installError = await read('workbench.installUpdate().then(() => "", error => error.message)');
  assert.match(installError, /配音设置/);
  assert.equal(await read('document.getElementById("cloud-settings-api-key").value'), '未保存的设置');
  assert.equal(installs, 0);
  assert.ok(win.isEnabled());
  await click('cloud-settings-cancel');

  await clickVisible(win.webContents, '#tab-script');
  await until('document.getElementById("script-title")?.checkVisibility()');
  await read(`window.originalSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = () => { throw new Error('模拟存储空间不足'); };
    const scriptTitle = document.getElementById('script-title');
    scriptTitle.value = '更新前的脚本'; scriptTitle.dispatchEvent(new Event('input', { bubbles: true }));`);
  await openToolbarUpdate();
  await click('update-action');
  await waitError();
  assert.match(await textOf('update-error'), /脚本草稿保存失败/);
  assert.equal(installs, 0);
  await read('Storage.prototype.setItem = window.originalSetItem; void 0');
  await click('update-close');
  await clickVisible(win.webContents, '#title-home');

  // A regular file at the directory path makes the real autosave fail deterministically.
  await fs.writeFile(drafts, 'fixture', { flag: 'wx' });
  await click('home-create');
  await until('!document.getElementById("editor-workspace").hidden && !document.getElementById("add-shot").disabled');
  await click('add-shot');
  await openToolbarUpdate();
  await click('update-action');
  await waitError();
  assert.match(await textOf('update-error'), /草稿/);
  assert.equal(installs, 0);
  assert.ok(win.isEnabled());
  await fs.unlink(drafts);
  await click('update-action');
  await until('document.getElementById("update-action").textContent === "重试保存并重启" && !document.getElementById("update-action").disabled');
  await expectBadge(version);
  const files = (await fs.readdir(drafts)).filter((name) => name.endsWith('.sdworkbench'));
  assert.equal(files.length, 1);
  const saved = JSON.parse(await fs.readFile(path.join(drafts, files[0]), 'utf8'));
  assert.equal(saved.config.shots.length, 1);
  assert.ok(await read('Object.values(localStorage).some(value => value.includes("更新前的脚本"))'));
  assert.equal(installs, 1);
  assert.ok(win.isEnabled());

  send('current', { version: '', notes: '' });
  await until('document.getElementById("update-action").textContent === "再次检查"');
  await expectBadge(null);
  send('error', { retry: 'check', message: '测试无已知更新时检查失败' });
  await until('document.getElementById("update-action").textContent === "重新检查"');
  await expectBadge(null);
  await click('update-action');
  await until('document.getElementById("update-action").textContent === "下载更新"');
  assert.equal(checks, 3);
  clock += fourHours;
  win.emit('focus');
  assert.equal(checks, 4, 'A window kept open should check again when it regains focus');
  send('unsupported', { canManageInstallation: false });
  await until('document.getElementById("update-action").textContent === "打开官方发布页"');
  await expectBadge(null);
  assert.match(await textOf('update-status'), /Windows 安装版/);
  assert.equal(await read('document.getElementById("update-manage-installation").checkVisibility()'), false);
  assert.match(await read('workbench.openInstalledApps().then(() => "", e => e.message)'), /Windows 安装版/);
  const opened = Promise.withResolvers();
  const openExternal = shell.openExternal;
  try {
    shell.openExternal = async (url) => { opened.resolve(url); };
    await click('update-action');
    assert.equal(await opened.promise, 'https://github.com/Showrenzhe/jiajian/releases/latest');
  } finally { shell.openExternal = openExternal; }
  send('error', { retry: 'install' });
  await until('!document.getElementById("update-action").disabled && document.getElementById("update-action").textContent === "重试保存并重启"');
  await click('update-action');
  await until('document.getElementById("update-status").textContent.includes("正在启动安装")');
  assert.equal(installs, 2);
  clock += fourHours;
  powerMonitor.emit('resume');
  assert.equal(checks, 4, 'Installing must never trigger another automatic check');
  console.log('标题栏更新红点、浅深与紧凑布局、键盘版本提示、下载重试、草稿与运行中任务保护通过。');
}

run().then(() => app.exit(0), (error) => { console.error(error); app.exit(1); });
