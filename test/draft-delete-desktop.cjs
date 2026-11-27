'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { mkdirSync, mkdtempSync } = require('node:fs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { app } = require('electron');
const { launchDesktop } = require('../src/desktop.cjs');
const { createDraftStore } = require('../src/draft-store.cjs');
const { inspectAsset } = require('../src/media.cjs');
const { saveProject } = require('../src/project-format.cjs');
const { clickVisible } = require('./desktop-input.cjs');

app.disableHardwareAcceleration();
app.setVersion(require('../package.json').version);
const first = '春日街景 · 初剪', second = '周末访谈 · 片段', keeper = '城市慢镜头 · 定稿';
const card = name => '.draft-open[title=' + JSON.stringify(name) + ']';

async function edit(root, phase) {
  const profile = path.join(root, 'profile');
  const win = await launchDesktop({ show: false, dataDirectory: profile });
  const wc = win.webContents;
  wc.setBackgroundThrottling(false);
  wc.debugger.attach();
  const read = code => wc.executeJavaScript(code, true);
  const el = selector => 'document.querySelector(' + JSON.stringify(selector) + ')';
  const click = (selector, button) => clickVisible(wc, selector, button);
  const list = () => read('window.workbench.listDrafts()');
  const origins = JSON.parse(await fs.readFile(path.join(root, 'draft-ids.json'), 'utf8'));
  const mode = el('.app-frame') + '.dataset.mode';
  const menu = el('#draft-context-menu') + '.matches(":popover-open")';
  const dialog = el('#draft-delete-dialog');
  async function wait(code, message) {
    const end = Date.now() + 10000;
    while (!await read(code)) {
      if (Date.now() >= end) throw new Error(message + '。' + await read(el('#notice') + '.textContent'));
      await delay(24);
    }
  }
  async function key(key, code, virtualKey, modifiers = 0) {
    for (const type of ['rawKeyDown', 'keyUp']) {
      await wc.debugger.sendCommand('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: virtualKey, modifiers });
    }
  }
  async function screenshot(name) {
    const folder = process.env.JIAJIAN_DRAFT_DELETE_FRAMES;
    if (!folder) return;
    await read('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await fs.mkdir(folder, { recursive: true });
    const shot = await wc.capturePage();
    assert.ok(!shot.isEmpty(), '应捕获实际窗口');
    await fs.writeFile(path.join(folder, name + '.png'), shot.toPNG());
  }
  async function openMenu(name, page) {
    await click(card(name), 'right');
    await wait(menu, '右键应打开草稿菜单');
    assert.equal(await read(mode), page, '右键操作应留在当前草稿列表');
    assert.equal(await read(el('#draft-context-delete') + '.textContent.trim()'), '删除');
  }
  async function openConfirmation(name) {
    await click('#draft-context-delete');
    await wait(dialog + '.open', '选择删除后应先打开确认框');
    assert.ok(await read(dialog + '.innerText.includes(' + JSON.stringify(name) + ')'), '确认框应显示选中的草稿名');
    assert.equal(await read('document.activeElement.id'), 'draft-delete-cancel');
  }
  async function theme(scheme) {
    await wc.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [
      { name: 'prefers-color-scheme', value: scheme }, { name: 'prefers-reduced-motion', value: 'reduce' },
    ] });
    await wait('document.documentElement.dataset.theme === ' + JSON.stringify(scheme), '窗口应使用' + scheme + '外观');
  }
  async function checkSavedList() {
    await wait(el(card(keeper)) + ' && ' + el(card('未命名草稿')), '应载入保留的草稿和新保存的草稿');
    const rows = await list();
    assert.equal(rows.length, 2);
    assert.equal(rows.find(row => row.name === keeper)?.id, origins[keeper]);
    assert.ok(rows.every(row => row.id !== origins[first] && row.id !== origins[second]), '删除的草稿不能重新出现');
    const names = await read('Array.from(document.querySelectorAll(".draft-open"), button => button.title).sort()');
    assert.deepEqual(names, [keeper, '未命名草稿'].sort());
  }

  try {
    await wc.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    if (phase === 'reopen') {
      await checkSavedList();
      await click(card(keeper));
      await wait(mode + ' === "montage" && ' + el('#notice') + '.textContent.includes(' + JSON.stringify(keeper) + ')', '重启后应可打开保留的草稿');
      return;
    }
    await theme('light');
    win.setContentSize(1280, 800);
    await wait(el(card(first)) + ' && ' + el(card(second)) + ' && ' + el(card(keeper)), '首页应载入三份隔离的草稿');
    assert.equal(await read(el('#draft-list') + '.dataset.view'), 'grid');
    const badge = card(first) + ' .draft-meta';
    assert.ok(await read(el(badge) + '.innerText.includes("0:01 · 1 个分镜") && ' +
      el(badge + ' time') + '.dateTime && getComputedStyle(' + el(badge) + ').backdropFilter === "none"'),
    '封面应显示时长、分镜数与更新时间且不采样背景');
    await click(card(first));
    await wait(mode + ' === "montage" && !' + el('#save-project') + '.disabled', '打开目标草稿');
    await click('#title-home');
    await wait(mode + ' === "home" && !' + el(card(first)) + '.disabled', '返回最近草稿');
    await openMenu(first, 'home');
    await screenshot('01-浅色-网格右键');
    await key('Escape', 'Escape', 27);
    await wait('!' + menu + ' && document.activeElement.matches(' + JSON.stringify(card(first)) + ')', 'Esc 关闭菜单后焦点应返回草稿');
    await key('F10', 'F10', 121, 8);
    await wait(menu + ' && document.activeElement.id === "draft-context-delete"', 'Shift+F10 应打开相同的草稿菜单，并聚焦删除项');
    await openConfirmation(first);
    await screenshot('02-浅色-删除确认');
    await key('Escape', 'Escape', 27);
    await wait('!' + dialog + '.open && document.activeElement.matches(' + JSON.stringify(card(first)) + ')', 'Esc 应取消删除并恢复草稿焦点');
    assert.equal((await list()).length, 3);

    await theme('dark');
    win.setContentSize(850, 600);
    await click('#draft-rows');
    assert.equal(await read(el('#draft-list') + '.dataset.view'), 'list');
    await openMenu(first, 'home');
    await screenshot('03-深色-紧凑列表右键');
    await openConfirmation(first);
    await screenshot('04-深色-紧凑删除确认');
    await click('#draft-delete-cancel');
    await wait('!' + dialog + '.open', '取消按钮应关闭确认框');
    assert.equal((await list()).length, 3);
    await openMenu(first, 'home');
    await openConfirmation(first);
    await click('#draft-delete-confirm');
    await wait('!' + dialog + '.open && !' + el(card(first)), '仅确认后才移除当前编辑过的草稿');
    assert.ok(await read(el('#workspace-toast') + '.checkVisibility() && ' + el('#workspace-toast-message') + '.textContent.includes(' +
      JSON.stringify(first) + ') && ' + el('#workspace-toast-undo') + '.hidden'), '删除草稿的通知应指明名称，且不提供虚假的撤销');
    assert.deepEqual((await list()).map(row => row.id).sort(), [origins[second], origins[keeper]].sort());
    await wait(el(card(second)) + ' && ' + el(card(keeper)), '首页应保留其他两份草稿');
    await wait(el('#workspace-toast') + '.hidden && !document.body.hasAttribute("data-workspace-toast")', '提示应自动收起并释放玻璃层');

    await click('#home-create');
    await wait(mode + ' === "montage" && !' + el('#save-project') + '.disabled', '删除后应能新建');
    await key('s', 'KeyS', 83, 2);
    await wait(el('#notice') + '.textContent.includes("本地草稿已保存")', '新建后应能正常保存');
    await click('#title-home');
    await wait(el(card('未命名草稿')) + '?.checkVisibility()', '回到首页应显示新保存的草稿');
    await click('#tab-drafts');
    await wait(mode + ' === "drafts"', '进入本地草稿页');
    await click('#draft-grid');
    await openMenu(second, 'drafts');
    await openConfirmation(second);
    // An external change between opening the menu and confirming must be preserved.
    const changedFile = path.join(profile, 'drafts', origins[second] + '.sdworkbench');
    const latest = JSON.parse(await fs.readFile(changedFile, 'utf8'));
    latest.draft.name = second + '（已更新）';
    latest.draft.revision++;
    await fs.writeFile(changedFile, JSON.stringify(latest));
    await click('#draft-delete-confirm');
    await wait('!' + dialog + '.open && ' + el(card(latest.draft.name)) + ' && ' + el('#home-project-status') + '.innerText.includes("草稿已发生变化")',
      '草稿发生改动时应保留新版，显示失败原因并刷新列表');
    await openMenu(latest.draft.name, 'drafts');
    await openConfirmation(latest.draft.name);
    await click('#draft-delete-confirm');
    await wait('!' + dialog + '.open && !' + el(card(latest.draft.name)), '在本地草稿网格重新确认后应可删除新版');
    await checkSavedList();
    const reloaded = once(wc, 'did-finish-load');
    wc.reload();
    await reloaded;
    await checkSavedList();
  } finally {
    wc.debugger.detach();
    const closed = once(win, 'closed');
    win.close();
    await closed;
  }
}

async function run() {
  const [phase, directory] = process.argv.slice(2);
  if (phase) return edit(directory, phase);
  const root = mkdtempSync(path.join(os.tmpdir(), 'jiajian-draft-delete-'));
  const coordinator = path.join(root, 'coordinator');
  mkdirSync(coordinator);
  app.setPath('userData', coordinator);
  try {
    const picture = path.join(root, '街景封面.jpg');
    await fs.copyFile(path.join(__dirname, '../src/ui/assets/project-cover.jpg'), picture);
    const catalog = new Map([['picture', await inspectAsset(picture, 'image')]]);
    const config = { shots: [[{ id: 'picture', start: 0, end: 1 }]], ratio: '16:9', resolution: 720, fps: 24,
      fit: 'fit', keepAudio: false, unordered: false, useOriginal: true, useMirrors: false, musicIds: [], musicVolume: 35, count: 1 };
    const external = path.join(root, '独立保存的工程.sdworkbench');
    await saveProject(external, config, catalog);
    const drafts = createDraftStore(path.join(root, 'profile', 'drafts'));
    const ids = {};
    for (const name of [keeper, second, first]) ids[name] = (await drafts.create({ name, config }, catalog)).id;
    await fs.writeFile(path.join(root, 'draft-ids.json'), JSON.stringify(ids));
    const protectedFiles = [picture, external, path.join(root, 'profile', 'drafts', ids[keeper] + '.sdworkbench')];
    const before = await Promise.all(protectedFiles.map(file => fs.readFile(file)));
    for (const action of ['delete', 'reopen']) {
      const child = spawn(process.execPath, [__filename, action, root], { stdio: 'inherit', windowsHide: true, timeout: 90000 });
      const [code] = await once(child, 'exit');
      assert.equal(code, 0, action + ' 桌面检查失败');
    }
    assert.deepEqual(await Promise.all(protectedFiles.map(file => fs.readFile(file))), before, '保留草稿、独立工程及源素材内容应不变');
    console.log('草稿右键、取消、确认、网格与列表、当前草稿删除后新建保存，以及冷启动复查通过。');
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  }
}

run().then(() => app.exit(0), error => { console.error(error); app.exit(1); });
