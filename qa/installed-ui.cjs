'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { createReadStream } = require('node:fs');
const fs = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setTimeout: sleep } = require('node:timers/promises');

const [phase, exe, root, expectedHash] = process.argv.slice(2);
const drafts = path.join(process.env.APPDATA, '佳剪', 'run-data', 'drafts');
const snapshotFile = path.join(root, 'old-draft.json');

async function wait(label, predicate, seconds = 90) {
  const end = Date.now() + 1000 * seconds;
  do {
    const value = await predicate();
    if (value) return value;
    await sleep(400);
  } while (Date.now() < end);
  throw new Error('Timeout: ' + label);
}
async function hash(file) {
  const sum = createHash('sha256');
  for await (const part of createReadStream(file)) sum.update(part);
  return sum.digest('hex');
}
async function connect() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const child = spawn(exe, ['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + port], { stdio: 'ignore', detached: true });
  if (phase !== 'verify') await fs.writeFile(path.join(root, 'old-main.pid'), String(child.pid));
  child.unref();
  const page = await wait('installed editor page', async () => {
    try {
      const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
      return list.find(p => p.type === 'page' && p.url === 'sd-workbench://app/index.html');
    } catch { return false; }
  });
  assert.equal(new URL(page.webSocketDebuggerUrl).hostname, '127.0.0.1');
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let seq = 0;
  const pending = new Map();
  socket.onmessage = event => {
    const msg = JSON.parse(event.data);
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(Error(msg.error.message)); else p.resolve(msg.result);
  };
  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => { pending.delete(id); reject(Error('No response to ' + method)); }, 10000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evaluate(expression) {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true });
    if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
  async function button(selector) {
    const q = JSON.stringify(selector);
    await wait('visible enabled ' + selector, () => evaluate('document.querySelector(' + q + ')?.checkVisibility() && !document.querySelector(' + q + ').disabled'));
    await evaluate('document.querySelector(' + q + ').click()');
  }
  return { evaluate, button, closeSocket: () => socket.close(), closeWindow: () => evaluate('setTimeout(() => window.close(), 100); true') };
}
async function draftSnapshot() {
  const files = await fs.readdir(drafts).catch(e => { if (e.code === 'ENOENT') return []; throw e; });
  const names = files.filter(n => n.endsWith('.sdworkbench'));
  if (names.length !== 1) return;
  const file = path.join(drafts, names[0]);
  const bytes = await fs.readFile(file);
  const doc = JSON.parse(bytes);
  if (doc.config?.shots?.length !== 2) return;
  return { name: names[0], sha256: createHash('sha256').update(bytes).digest('hex'), doc };
}
async function run() {
  assert.equal(process.env.QA_RUNNER_TYPE, 'github-hosted');
  const browser = await connect();
  const { evaluate, button } = browser;
  const count = 'document.querySelectorAll("#shots .shot-name").length';
  const action = 'document.querySelector("#update-action")?.textContent';
  const label = s => evaluate(action + ' === ' + JSON.stringify(s));
  const version = phase === 'verify' ? '0.9.0' : '0.8.9';
  try {
    await wait('installed UI reports ' + version, () => evaluate('document.querySelector("#app-version")?.textContent.trim() === ' + JSON.stringify(version)));
    if (phase === 'verify') {
      const before = JSON.parse(await fs.readFile(snapshotFile, 'utf8'));
      const after = await draftSnapshot();
      assert.ok(after, 'Original two-shot draft file is absent');
      assert.equal(after.name, before.name);
      assert.equal(after.doc.name, before.doc.name);
      assert.deepEqual(after.doc.config, before.doc.config);
      if (before.mode === 'manual') assert.equal(after.sha256, before.sha256);
      await button('#tab-drafts');
      await button('.draft-open');
      await wait('saved draft opens with two shots in new UI', () => evaluate('!document.querySelector("#editor-workspace").hidden && ' + count + ' === 2'));
      await fs.writeFile(path.join(root, 'verified.json'), JSON.stringify({ reopenedShots: 2, beforeSHA256: before.sha256, afterSHA256: after.sha256 }));
      await browser.closeWindow();
      return;
    }
    await button('#home-create');
    await button('#add-shot');
    await wait('one visible storyboard shot', () => evaluate(count + ' === 1'));
    await button('#add-shot');
    await wait('two visible storyboard shots', () => evaluate(count + ' === 2'));
    const snapshot = await wait('two real shots written to the original draft', draftSnapshot);
    await fs.writeFile(snapshotFile, JSON.stringify({ ...snapshot, mode: phase }));
    if (phase === 'manual') {
      await browser.closeWindow();
      return;
    }
    await button('#software-update-entry');
    let checked = false;
    await wait('old updater offers the real public version', async () => {
      if (await label('检查更新') || await label('再次检查')) {
        if (checked) throw Error('The official old client reported no newer stable update.');
        checked = true;
        await button('#update-action');
      }
      if (await label('重新检查')) throw Error(await evaluate('document.querySelector("#update-status").textContent'));
      return await label('下载更新');
    }, 120);
    assert.ok((await evaluate('document.querySelector("#update-status").textContent')).includes('0.9.0'));
    await button('#update-action');
    await wait('actual updater download completion', async () => {
      if (await label('重试下载')) throw Error(await evaluate('document.querySelector("#update-status").textContent'));
      return await label('保存并重启更新');
    }, 600);
    const cache = path.join(process.env.LOCALAPPDATA, 'jiajian-updater', 'pending');
    const names = (await fs.readdir(cache)).filter(f => f.toLowerCase().endsWith('.exe'));
    assert.equal(names.length, 1, 'Expected one fully downloaded update installer');
    assert.equal(await hash(path.join(cache, names[0])), expectedHash.toLowerCase(), 'UI download must equal the GitHub release digest');
    await button('#update-action');
    console.log('Clicked 保存并重启更新 on the actual 0.8.9 installation after digest verification.');
  } finally { browser.closeSocket(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
