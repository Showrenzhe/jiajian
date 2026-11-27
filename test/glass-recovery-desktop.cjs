'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app } = require('electron');
const { launchDesktop } = require('../src/desktop.cjs');
const { clickVisible } = require('./desktop-input.cjs');

async function session(phase, profile) {
  const win = await launchDesktop({ show: false, dataDirectory: profile });
  const read = code => win.webContents.executeJavaScript(code, true);
  try {
    const active = phase === 'recovered';
    assert.equal(await read('workbench.softwareRenderingActive'), active);
    assert.equal(await read('document.documentElement.dataset.glass'), active ? 'off' : 'full');
    await clickVisible(win.webContents, '#app-settings');
    assert.equal(await read('document.querySelector("#glass-effect").disabled'), active);
    if (active) {
      assert.equal(await read('localStorage.getItem("jiajian.glass")'), 'lite');
      assert.ok(await read('document.querySelector("#glass-effect-note").checkVisibility()'));
      assert.match(await read('document.querySelector("#glass-effect-note").textContent'), /兼容/);
      for (const selector of ['#cloud-settings-dialog', '#app-settings', '#software-update-entry']) {
        assert.equal(await read('getComputedStyle(document.querySelector(' + JSON.stringify(selector) + ')).backdropFilter'), 'none');
      }
    } else {
      await read('const picker=document.querySelector("#glass-effect"); picker.value="lite"; picker.dispatchEvent(new Event("change",{bubbles:true}))');
      assert.equal(await read('document.documentElement.dataset.glass'), 'lite');
      for (let n = 0; n < 2; n++) app.emit('child-process-gone', {}, { type: 'GPU', reason: 'crashed', exitCode: 1 });
      assert.equal(await read('document.documentElement.dataset.glass'), 'lite');
    }
  } finally { win.destroy(); }
}

async function run() {
  const [phase, directory] = process.argv.slice(2);
  if (phase === 'normal' || phase === 'recovered') return session(phase, directory);
  const profile = mkdtempSync(path.join(os.tmpdir(), 'jiajian-glass-recovery-'));
  try {
    for (const mode of ['normal', 'recovered']) {
      const child = spawnSync(process.execPath, [__filename, mode, profile], { stdio: 'inherit', windowsHide: true, timeout: 45000 });
      if (child.error) throw child.error;
      assert.equal(child.status, 0, '玻璃档位跨启动检查 ' + mode);
    }
    console.log('两次模拟 GPU 崩溃后重启，首屏关闭玻璃、设置置灰并保留原始档位。');
  } finally {
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
run().then(() => app.exit(0), error => { console.error(error); app.exit(1); });
