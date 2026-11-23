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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jiajian-performance-'));
  app.setPath('userData', path.join(root, 'electron'));
  const video = path.join(root, '样本.mp4');
  const chosen = path.join(root, '选择的目录');
  await fs.mkdir(chosen);
  await ffmpeg(['-f', 'lavfi', '-i', 'color=teal:s=960x540:r=24:d=2', '-c:v', 'libx264', '-threads', '2', video]);
  let folderRequests = 0;
  const win = await launchDesktop({ show: false, dataDirectory: path.join(root, 'profile'), dialogs: {
    async showOpenDialog(_win, options) {
      if (!options.properties.includes('openDirectory')) return { canceled: false, filePaths: [video] };
      folderRequests++;
      return folderRequests === 1 ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: [chosen] };
    },
  } });
  const js = value => win.webContents.executeJavaScript(value, true);
  const click = selector => clickVisible(win.webContents, selector);
  const read = () => js('window.workbench.performanceSettings()');
  async function wait(check, label) {
    const end = Date.now() + 12000;
    do { if (await check()) return; await delay(40); } while (Date.now() < end);
    const detail = await js("(()=>{const p=document.querySelector('#preview');return [document.querySelector('#preview-heading').textContent,document.querySelector('#preview-meta').textContent,p.videoWidth,p.error?.message,p.currentSrc,document.querySelector('#notice')?.textContent]})()");
    throw new Error(label + ' ' + JSON.stringify(detail));
  }
  const open = async () => {
    await click('#app-settings');
    await click('#performance-settings summary');
    await wait(() => js('!document.querySelector("#performance-options").disabled'), '性能设置应加载完成');
    await js('Promise.all(document.querySelector("#cloud-settings-dialog").getAnimations({subtree:true}).map(a=>a.finished.catch(()=>{})))');
  };
  try {
    win.setContentSize(1100, 740);
    await open();
    const before = await read();
    await click('#performance-gpu');
    await wait(async () => (await read()).gpu === !before.gpu, 'GPU 选择应保存');
    await click('#performance-default-proxy');
    await wait(async () => (await read()).defaultProxy === !before.defaultProxy, '新草稿代理默认值应保存');
    await js("const select=document.querySelector('#performance-optimization'); select.value='smooth'; select.dispatchEvent(new Event('change',{bubbles:true}))");
    await wait(async () => (await read()).optimization === 'smooth', '自动优化策略应保存');
    await click('#performance-folder');
    await wait(() => js('!document.querySelector("#performance-options").disabled'), '取消选择目录');
    assert.equal((await read()).location, before.location);
    await click('#performance-folder');
    await wait(async () => (await read()).location.startsWith(chosen), '显示实际设置的目录');
    await click('#cloud-settings-cancel');
    const url = await js("(async()=>{const result=await workbench.pick('video',1); return await workbench.trackProxy(result.assets[0].id)})()");
    assert.match(url, /^sd-workbench:/);
    await open();
    const cached = await read();
    assert.ok(cached.bytes > 0);
    assert.equal(await js('document.querySelector("#performance-gpu").checked'), !before.gpu);
    assert.equal(await js('document.querySelector("#performance-default-proxy").checked'), !before.defaultProxy);
    assert.equal(await js('document.querySelector("#performance-optimization").value'), 'smooth');
    assert.equal(await js('document.querySelector("#performance-location").textContent'), cached.location);
    const unrelated = path.join(cached.location, '同目录的用户文件.txt');
    await fs.writeFile(unrelated, 'keep');
    await click('#performance-clear');
    await click('#performance-keep');
    assert.equal((await read()).bytes, cached.bytes);
    await click('#performance-clear');
    await click('#performance-confirm-clear');
    await wait(async () => (await read()).bytes === 0, '清理后占用应归零');
    assert.equal(await fs.readFile(unrelated, 'utf8'), 'keep');
    await wait(() => js('document.querySelector("#performance-size").textContent.includes("0 B")'), '界面同步显示占用');
    await click('#cloud-settings-cancel');
    await js("workbench.savePerformanceSettings({defaultProxy:true})");
    await js("(async()=>{const result=await workbench.pick('video',1); return workbench.trackProxy(result.assets[0].id)})()");
    const [proxyFile] = (await fs.readdir(cached.location)).filter(name => /^jj-[a-f0-9]{64}\.mp4$/.test(name));
    await fs.writeFile(path.join(cached.location, proxyFile), 'intentionally unreadable fixture');
    await click('#home-create');
    await wait(() => js('!document.querySelector("#material-import").disabled'), '打开新草稿');
    await js('document.querySelector("#material-import").click()');
    await click('#material-import-files');
    await wait(() => js('document.querySelector("#preview-meta").textContent.includes("原片") && !document.querySelector("#preview").hidden && document.querySelector("#preview").videoWidth===960'), '轨道代理解码失败应自动显示原片');
    await js('document.querySelector("#timeline-play").click()');
    await wait(() => js('(()=>{const v=document.querySelector(".draft-transport-preview:not([hidden]) video");return v?.videoWidth===960 && v.currentTime>0.08})()'), '草稿连续播放遇到坏代理应继续播放原片');
    console.log('性能设置、选择目录、代理占用及清理通过。');
  } finally { if (!win.isDestroyed()) win.destroy(); }
}
run().then(() => app.exit(0), err => { console.error(err); app.exit(1); });
