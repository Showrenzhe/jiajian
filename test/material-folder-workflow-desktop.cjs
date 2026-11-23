'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {setTimeout: delay} = require('node:timers/promises');
const {app} = require('electron');
const {launchDesktop} = require('../src/desktop.cjs');
const {fixtures} = require('./fixtures.cjs');
const {clickVisible, dragLibraryItem} = require('./desktop-input.cjs');

app.disableHardwareAcceleration();
async function run() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jiajian-folder-workflow-'));
  app.setPath('userData', root);
  app.setPath('sessionData', root);
  const media = await fixtures(root);
  const source = path.join(root, '机位'), nested = path.join(source, '备用');
  await fs.mkdir(nested, {recursive:true});
  const still = path.join(nested, '参考.png');
  await fs.copyFile(media.still, still);
  const original = await fs.readFile(still);
  const data = path.join(root, 'profile'), draftDir = path.join(data, 'drafts');
  const project = path.join(root, '整理.sdworkbench'), picks = [];
  const win = await launchDesktop({show:false, dataDirectory:data, dialogs:{
    async showOpenDialog(_, options) {
      const next = picks.shift();
      assert.equal(options.title, next.title);
      return {canceled:false, filePaths:next.files};
    },
    async showSaveDialog() { return {canceled:false, filePath:project}; },
  }});
  win.setContentSize(1440, 960);
  const wc = win.webContents;
  wc.setBackgroundThrottling(false);
  wc.debugger.attach();
  const read = script => wc.executeJavaScript(script, true);
  const el = selector => 'document.querySelector(' + JSON.stringify(selector) + ')';
  async function click(selector) {
    const target = el(selector);
    await wait('(()=>{const e='+target+';if(!e?.checkVisibility() || e.disabled)return false;e.scrollIntoView({block:"nearest"});const r=e.getBoundingClientRect();return e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));})()', '控件可点击 '+selector);
    await clickVisible(wc, selector);
  }
  const folder = name => '.material-folder[title=' + JSON.stringify(name) + ']';
  const item = name => '.material-tile[title=' + JSON.stringify(path.basename(name)) + ']';
  const send = (name, params) => wc.debugger.sendCommand('Input.' + name, params);
  async function until(check, label) {
    for (const end = Date.now() + 12000; Date.now() < end;) {
      if (await check()) return;
      await delay(40);
    }
    throw Error(label + ' / ' + await read('[document.querySelector("#material-message").textContent,document.querySelector("#notice").textContent,document.querySelector("#material-folder-error").textContent].join(" / ")'));
  }
  const wait = (code, label) => until(() => read(code), label);
  const exists = file => fs.stat(file).then(() => true, () => false);
  async function point(selector) {
    return read('(()=>{const r='+el(selector)+'.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()');
  }
  async function key(name, code) {
    for (const type of ['rawKeyDown','keyUp']) await send('dispatchKeyEvent',{type,key:name,code:name,windowsVirtualKeyCode:code});
  }
  async function enter(name) {
    await click(folder(name)); await key('Enter',13);
    await wait(el('#material-breadcrumb')+'.textContent.endsWith('+JSON.stringify(name)+')','打开 '+name);
  }
  async function nameFolder(name) {
    await wait(el('#material-folder-dialog')+'.open','打开命名框');
    await send('insertText',{text:name});
    await click('#material-folder-submit');
    await wait('!'+el('#material-folder-dialog')+'.open && !!'+el(folder(name)), '命名 '+name);
  }
  async function create(name) { await click('#material-folder-import'); await nameFolder(name); }
  async function pick(files, directory = false) {
    picks.push({title:directory ? '选择素材文件夹':'选择素材文件',files});
    await click('#material-import');
    await click(directory ? '#material-import-directory':'#material-import-files');
    await wait('!'+el('#material-import')+'.disabled','等待导入');
  }
  const back = () => click('#material-breadcrumb .material-back');
  try {
    await wc.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});
    await click('#home-create');
    await create('产品');
    await pick([media.red]);
    await wait('!!'+el(item(media.red)), '根目录导入');
    const tracks = 'document.querySelectorAll(".sequence-video .sequence-block[data-selectable]").length';
    assert.equal(await read(tracks), 1);
    await dragLibraryItem(wc, await point(item(media.red)), await point(folder('产品')), 'application/x-sd-workbench-material', async () => {
      assert.equal(await read(el(folder('产品'))+'.classList.contains("material-folder-drop")'), true);
    });
    await wait('!'+el(item(media.red)), '拖动后素材归入文件夹');
    await enter('产品');
    await wait('!!'+el(item(media.red)), '目录中显示已归类素材');
    await create('口播'); await enter('口播');
    await pick([media.green,media.music]);
    await wait('!!'+el(item(media.green))+' && !!'+el(item(media.music)), '当前目录同时导入画面和音频');
    await pick([source], true);
    await wait('!!'+el(folder('机位')), '在当前目录导入整个目录');
    await enter('机位'); await enter('备用');
    await wait('!!'+el(item(still)), '保留导入的层次和文件');
    await back(); await back(); await back();
    await click(folder('口播')); await key('F2',113); await nameFolder('台词');
    assert.equal(await read(tracks), 1);
    let mirror;
    await until(async () => {
      const names = await fs.readdir(draftDir).catch(() => []);
      const name = names.find(entry => entry.endsWith('.素材库'));
      if (name) mirror = path.join(draftDir,name);
      return mirror && await exists(path.join(mirror,'产品','台词','机位','备用')) && !await exists(path.join(mirror,'产品','口播'));
    }, '本地草稿目录随重命名更新');
    await click('#save-project');
    await until(() => exists(project), '保存工程');
    const stored = JSON.parse(await fs.readFile(project,'utf8')).config;
    assert.equal(stored.shots.length,1);
    assert.equal(stored.libraryFolders.find(row => row.name==='台词').assetIds.length,2);
    picks.push({title:'打开工程', files:[project]});
    await click('#open-project');
    await wait(el('#material-breadcrumb')+'.hidden && !!'+el(folder('产品')), '手动工程重开');
    await enter('产品'); await enter('台词'); await enter('机位'); await enter('备用');
    await wait('!!'+el(item(still)), '重开后按需载入嵌套目录文件');
    await back(); await back(); await back();
    await click(folder('台词')); await key('Delete',46);
    await wait('!'+el(folder('台词'))+' && !!'+el(item(media.red)), '移除子树保留其他素材');
    await until(async () => {
      const names = await fs.readdir(draftDir);
      for (const name of names.filter(entry => entry.endsWith('.sdworkbench'))) {
        try {
          const doc = JSON.parse(await fs.readFile(path.join(draftDir,name),'utf8'));
          const rows = doc.config.libraryFolders ?? [];
          if (rows.length === 1 && rows[0].name === '产品' && doc.config.shots.length===1 &&
              !await exists(path.join(draftDir,path.basename(name,'.sdworkbench')+'.素材库','产品','台词'))) return true;
        } catch {}
      }
      return false;
    }, '删除反映到自动草稿和本地子目录');
    assert.deepEqual(await fs.readFile(still),original);
    assert.equal(await read(tracks),1);
    console.log('素材库文件与目录导入、原生拖动归类、嵌套目录重命名、草稿目录同步、重开及删除均通过。');
  } finally {wc.debugger.detach(); win.destroy();}
}
run().then(()=>app.exit(0),error=>{console.error(error);app.exit(1);});
