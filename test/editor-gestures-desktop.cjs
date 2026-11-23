'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { app, nativeImage } = require('electron');
const { launchDesktop } = require('../src/desktop.cjs');
const { clickVisible } = require('./desktop-input.cjs');

app.disableHardwareAcceleration();

async function check() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jiajian-gestures-'));
  const still = path.join(root, '素材.png');
  const pixels = Buffer.alloc(160 * 90 * 4, 255);
  await fs.writeFile(still, nativeImage.createFromBitmap(pixels, { width:160, height:90 }).toPNG());
  const win = await launchDesktop({ show:false, dataDirectory:path.join(root,'profile'), dialogs:{
    async showOpenDialog() { return {canceled:false,filePaths:[still]}; },
  } });
  const wc = win.webContents;
  wc.debugger.attach();
  wc.setBackgroundThrottling(false);
  const read = expression => wc.executeJavaScript(expression,true);
  const q = selector => 'document.querySelector('+JSON.stringify(selector)+')';
  const click = selector => clickVisible(wc,selector);
  const key = async (key,code) => {
    for (const type of ['rawKeyDown','keyUp']) await wc.debugger.sendCommand('Input.dispatchKeyEvent',{type,key,code:key,windowsVirtualKeyCode:code});
  };
  const mouse = (type,point) => wc.debugger.sendCommand('Input.dispatchMouseEvent',{
    type,...point,button:'left',buttons:type==='mouseReleased'?0:1,clickCount:type==='mouseMoved'?0:1,
  });
  async function point(selector,x=.5,y=.5) {
    const result = await read(`(async()=>{
      const node=${q(selector)};node.scrollIntoView({block:'center',behavior:'instant'});await new Promise(requestAnimationFrame);
      const rect=node.getBoundingClientRect(),x=rect.left+rect.width*${x},y=rect.top+rect.height*${y};
      return node.contains(document.elementFromPoint(x,y)) ? {x,y} : null;
    })()`);
    assert.ok(result,selector+' 应可操作');
    return result;
  }
  async function wait(expression,message) {
    const until=Date.now()+6500;
    do { if(await read(expression)) return; await delay(30); } while(Date.now()<until);
    throw new Error(message);
  }
  const panel = q('#player-pane');
  const coordinates = () => read(`(()=>{const {left,top}=${panel}.getBoundingClientRect();return [left,top]})()`);
  const style = () => read("[...['position','x','y'].map(key=>document.getElementById('caption-'+key).value)]");
  try {
    win.setContentSize(1120,810);
    await click('#home-import');
    await wait(q('#still-preview')+'.naturalWidth===160','应载入静态素材');
    const picture = q('.player-picture');
    const scaledWidth = factor => picture+'.offsetWidth>0 && Math.abs('+picture+'.getBoundingClientRect().width-'+picture+'.offsetWidth*'+factor+')<2';
    const zoom = q('#player-zoom');
    await click('#player-zoom');
    await wait(zoom+'.matches(":open")','应打开预览缩放选项');
    await key('End',35);
    await key('Enter',13);
    await wait(zoom+'.value==="2" && '+scaledWidth(2),'缩放应把实际显示画面放大两倍');
    assert.ok(await read(zoom+'.matches(":focus-visible") && getComputedStyle('+zoom+'.parentElement).outlineStyle==="solid"'),'键盘调整缩放时放大镜按钮应显示焦点');
    await click('#player-zoom');
    await wait(zoom+'.matches(":open")','应能再次打开预览缩放选项');
    await key('Home',36);
    await key('ArrowDown',40);
    await key('Enter',13);
    await wait(zoom+'.value==="1" && '+scaledWidth(1),'恢复适应后应还原画面大小');
    await click('#player-fullscreen');
    await wait('document.fullscreenElement==='+panel,'全屏按钮应放大播放器面板');
    await click('#player-fullscreen');
    await wait('!document.fullscreenElement','再次点击应退出全屏');
    await click('#player-more');
    await key('Escape',27);
    await wait('!'+q('#player-more-menu')+'.matches(":popover-open") && document.activeElement.id==="player-more"','关闭播放控制菜单后应回焦到更多');
    await click('#player-more');
    await click('#player-float');
    await wait(panel+'.matches(":popover-open")','静态画面应打开悬浮面板');
    const origin = await coordinates();
    const heading = await point('#player-pane .panel-heading');
    const moved = {x:heading.x-76,y:heading.y-50};
    await mouse('mousePressed',heading);
    await mouse('mouseMoved',moved);
    const current = await coordinates();
    assert.ok(current[0]<origin[0]-70,'悬浮窗应跟随标题栏拖动 '+JSON.stringify({origin,current,heading,moved,css:await read(panel+'.style.cssText')}));
    await key('Escape',27);
    await mouse('mouseReleased',moved);
    assert.deepEqual(await coordinates(),origin,'取消应恢复起点');
    await mouse('mousePressed',heading);
    await mouse('mouseMoved',moved);
    await mouse('mouseReleased',moved);
    assert.ok((await coordinates())[0]<origin[0]-70,'重新拖动并松手应保留位置');
    await key('Escape',27);
    assert.ok(await read('!'+panel+'.matches(":popover-open") && document.activeElement.id==="player-more"'),'Esc 应归位并聚焦可见的更多按钮');

    await click('#inspector-tab-subtitles');
    await click('#caption-save-preset');
    assert.equal(await read('document.activeElement.id'),'caption-preset-name');
    await key('Escape',27);
    assert.equal(await read('document.activeElement.id'),'caption-save-preset');
    assert.equal(await read(q('#caption-save-preset')+'.getAttribute("aria-expanded")'),'false');
    await click('#caption-save-preset');
    await click('#caption-cancel-preset');
    assert.equal(await read('document.activeElement.id'),'caption-save-preset');

    const preview = '#caption-preview-canvas', large = '#caption-zoom-canvas';
    const original = await style();
    const commits = await read("window.captionCommits=0;document.querySelector('#caption-position').addEventListener('input',()=>window.captionCommits++);window.captionCommits");
    assert.equal(commits,0);
    for (const target of [preview,large]) {
      if (target===large) await click('#caption-enlarge');
      const start = await point(target,.3,.2), end = await point(target,.6,.65);
      await mouse('mousePressed',start);
      await mouse('mouseMoved',end);
      await key('Escape',27);
      await mouse('mouseReleased',end);
      assert.deepEqual(await style(),original,target+' 取消应保留工程位置');
      assert.equal(await read('window.captionCommits'),0);
      if (target===large) assert.ok(await read(q('#caption-zoom-dialog')+'.open'),'第一层 Esc 应只取消手势');
    }
    const start = await point(large,.3,.2), end = await point(large,.6,.65);
    await mouse('mousePressed',start);
    await mouse('mouseMoved',end);
    await mouse('mouseReleased',end);
    assert.deepEqual(await style(),['custom','60','65'],'放大的预览应一次提交最终坐标');
    assert.equal(await read('window.captionCommits'),1);
    await key('Escape',27);
    await wait('document.activeElement.id==="caption-enlarge"','放大预览应返回检查器入口');

    for (const [scheme,motion,colors,duration] of [['light','no-preference','none',true],['dark','reduce','none',false],['dark','no-preference','active',false]]) {
      await wc.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[
        {name:'prefers-color-scheme',value:scheme},{name:'prefers-reduced-motion',value:motion},{name:'forced-colors',value:colors},
      ]});
      for (const open of [false,true]) {
        await click('#caption-preview-pane summary');
        const state = await read(`(()=>{const pane=${q('#caption-preview-pane')},css=getComputedStyle(pane,'::details-content');
          return {open:pane.open,moves:css.transitionProperty.includes('block-size') && parseFloat(css.transitionDuration)>0}})()`);
        assert.deepEqual(state,{open,moves:duration},scheme+' / '+motion+' / '+colors+' 折叠状态和动效');
      }
    }
    console.log('播放器悬浮归位、字幕预览取消与提交、预设焦点及检查器折叠通过。');
  } finally { wc.debugger.detach();win.destroy(); }
}

check().then(()=>app.exit(0),error=>{console.error(error);app.exit(1);});
