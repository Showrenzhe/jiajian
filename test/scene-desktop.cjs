'use strict';

const assert = require('node:assert/strict');
const { mkdirSync, mkdtempSync } = require('node:fs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { app } = require('electron');
const { launchDesktop } = require('../src/desktop.cjs');
const { ffmpeg } = require('./fixtures.cjs');

app.disableHardwareAcceleration();

async function run() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'sd-scene-desktop-'));
  const input = path.join(root, '场景测试.mp4');
  const output = path.join(root, '输出');
  mkdirSync(output);
  const selections = [
    { title: '选择视频或文件夹', filePaths: [input] },
    { title: '选择场景保存目录', filePaths: [output] },
  ];
  const win = await launchDesktop({
    show: false,
    dataDirectory: path.join(root, 'profile'),
    dialogs: {
      async showOpenDialog(_window, options) {
        const next = selections.shift();
        assert.equal(options.title, next?.title);
        return { canceled: false, filePaths: next.filePaths };
      },
    },
  });
  await ffmpeg([
    '-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=30:d=1',
    '-f', 'lavfi', '-i', 'color=c=green:s=320x180:r=30:d=1',
    '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=30:d=1',
    '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]',
    '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', input,
  ]);
  const js = (expression) => win.webContents.executeJavaScript(expression, true);
  const waitFor = async (expression, message) => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (await js(expression)) return;
      await delay(80);
    }
    throw new Error(message);
  };
  try {
    await js('document.querySelector("#tab-scene-split").click()');
    await waitFor('!document.querySelector("#scene-split-workspace").hidden', '应打开场景分割工作区');
    await js('document.querySelector("#scene-pick-files").click()');
    await waitFor('document.querySelectorAll("#scene-input-list li").length === 1', '应显示已选择的视频');
    await js('document.querySelector("#scene-pick-output").click()');
    await waitFor('document.querySelector("#scene-output-path").textContent.includes("输出")', '应显示输出目录');
    await js('document.querySelector("#scene-split-submit").click()');
    await waitFor('document.querySelectorAll("#scene-results tbody tr").length === 1', '应显示场景分割结果');
    assert.equal(await js('document.querySelector("#scene-results tbody td:nth-child(3)").textContent'), '3');
    console.log('场景分割桌面流程通过。');
  } finally {
    const closed = new Promise((resolve) => win.once('closed', resolve));
    win.close();
    await closed;
    await fs.rm(root, { recursive: true, force: true });
  }
}

run().catch((error) => { console.error(error); app.exit(1); });

