'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { clickVisible } = require('./desktop-input.cjs');

function luminance(rgb) {
  const [r,g,b] = rgb.map(v => v/255).map(v => v <= .04045 ? v/12.92 : ((v+.055)/1.055)**2.4);
  return .2126*r + .7152*g + .0722*b;
}

function contrast(ink, background) {
  const resolved = ink.slice(0,3).map((v,i) => (v*ink[3] + background[i]*(255-ink[3]))/255);
  const levels = [luminance(resolved),luminance(background)].sort((a,b)=>a-b);
  return (levels[1]+.05)/(levels[0]+.05);
}
function pixel(image, x, y) {
  const [b,g,r] = image.crop({x:Math.round(x),y:Math.round(y),width:1,height:1}).toBitmap();
  return [r,g,b];
}

module.exports = async function capture({win,wc,read,click,wait,key,select,output}) {
  await fs.mkdir(output,{recursive:true});
  const results = [];
  const bounds = [];
  const video = '.sequence-video [data-move-candidate]';
  const menu = '#video-track-menu';
  const dialog = '#editing-help-dialog';
  const quit = () => key('Escape','Escape');
  const moving = () => read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');

  async function snapshot(name, width, height) {
    await moving();
    const shot = await wc.capturePage();
    assert.deepEqual(shot.getSize(),{width,height},name);
    await fs.writeFile(path.join(output,name+'.png'),shot.toPNG());
  }
  async function surfaces(selector, mode) {
    const info = await read(`(() => {
      const visible=[...document.querySelectorAll('.glass')].filter(el=>el.checkVisibility({visibilityProperty:true}));
      const surfaces=visible.map(el=>({id:el.id,filter:getComputedStyle(el).backdropFilter}));
      const box=el=>{const r=el.getBoundingClientRect();return {x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)}};
      const filtered = [];
      for (const el of document.querySelectorAll('body *')) {
        if (!el.checkVisibility({visibilityProperty:true,opacityProperty:true})) continue;
        const rect=el.getBoundingClientRect();
        if (rect.width<=0 || rect.height<=0 || rect.right<=0 || rect.left>=innerWidth || rect.bottom<=0 || rect.top>=innerHeight) continue;
        const name=el.id ? '#'+el.id : el.localName+'.'+[...el.classList].join('.');
        const pseudos=['', '::before', '::after'];
        if (el.matches('dialog:modal,:popover-open')) pseudos.push('::backdrop');
        for (const pseudo of pseudos) {
          const css=getComputedStyle(el,pseudo || null);
          if (css.display==='none' || css.visibility==='hidden' || +css.opacity===0 || css.backdropFilter==='none') continue;
          if ((pseudo==='::before' || pseudo==='::after') && ['none','normal'].includes(css.content)) continue;
          filtered.push({node:name+pseudo,filter:css.backdropFilter});
        }
      }
      const title=box(document.querySelector('.titlebar'));
      return {surface:box(document.querySelector(${JSON.stringify(selector)})),title,surfaces,filtered,
        allowed:visible.every(el=>el.matches('dialog,#app-settings,#software-update-entry,#video-track-menu,#material-context-menu,#draft-context-menu'))};
    })()`);
    assert.ok(info.filtered.length <= (mode==='off' ? 0 : 4), JSON.stringify({selector,mode,filtered:info.filtered}));
    assert.ok(info.allowed && info.surfaces.length <= 4, JSON.stringify(info));
    assert.deepEqual(info.surfaces.map(s=>s.id).sort(),['app-settings','software-update-entry',selector.slice(1)].sort());
    for (const {id,filter} of info.surfaces) {
      const shadowedTitle = selector===dialog && id!==selector.slice(1);
      assert.equal(filter === 'none',mode!=='full' || shadowedTitle,JSON.stringify(info));
    }
    return info;
  }
  async function contrastSamples(theme, mode) {
    for (const [slot,behind] of [[3,0],[4,255]]) {
      const thumbnail='.sequence-video [data-drop-shot="'+slot+'"] .sequence-frames img';
      await wait('document.querySelector('+JSON.stringify(thumbnail)+')?.naturalWidth > 0');
      // Enlarge the app's decoded test thumbnail underneath the top-layer menu.
      // Keep layout, menu geometry, the native backdrop and font rendering untouched.
      await read(`(async () => {
        const img = document.querySelector(${JSON.stringify(thumbnail)}).cloneNode();
        img.id='glass-contrast-fixture';
        Object.assign(img.style,{position:'fixed',inset:'0',width:'100vw',height:'100vh',objectFit:'cover',pointerEvents:'none',zIndex:'2147483647'});
        document.body.append(img);
        await img.decode();
      })()`);
      await delay(130);
      const image = await wc.capturePage();
      const backing = pixel(image,80,150);
      assert.ok(backing.every(c=>Math.abs(c-behind)<=2), JSON.stringify({slot,backing}));
      const inks = await read(`(() => {
        const ctx=document.createElement('canvas').getContext('2d',{willReadFrequently:true});
        const rgba=color=>{ctx.clearRect(0,0,1,1);ctx.fillStyle=color;ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data]};
        return [...document.querySelectorAll('#video-track-menu button:enabled')].filter(b=>b.checkVisibility()).map(b=>{
          const r=b.getBoundingClientRect(), key=getComputedStyle(b,'::after');
          return {action:b.dataset.action,x:r.left+Math.floor(r.width*.64),y:r.top+5,ink:rgba(getComputedStyle(b).color),
            keyInk:b.dataset.menuKey ? rgba(key.color):null};
        });
      })()`);
      assert.ok(inks.length>=4);
      for (const {action,x,y,ink,keyInk} of inks) {
        const background=pixel(image,x,y);
        for (const [part,value] of [['label',ink],['shortcut',keyInk]]) {
          if (!value) continue;
          const ratio=contrast(value,background);
          const row={theme,mode,behind,action,part,ink:value,background,ratio:Number(ratio.toFixed(3))};
          assert.ok(ratio>=4.5,JSON.stringify(row));
          results.push(row);
        }
      }
      await read('document.getElementById("glass-contrast-fixture").remove()');
    }
  }
  for (const [width,height] of [[1366,768],[1920,1080]]) {
    win.setContentSize(width,height);
    await moving();
    for (const theme of ['light','dark']) for (const mode of ['full','off']) {
      const name=[width+'x'+height,theme,mode].join('-');
      await click('#app-settings');
      await click('label:has(input[name="appearance"][value="'+theme+'"])');
      await select('glass-effect',mode);
      await wait('document.documentElement.dataset.glass==='+JSON.stringify(mode)+' && document.documentElement.dataset.theme==='+JSON.stringify(theme)+' && !document.documentElement.hasAttribute("data-theme-changing")');
      await quit();
      await delay(220);
      await clickVisible(wc,video,'right');
      await wait('document.querySelector("#video-track-menu:popover-open")');
      await delay(250);
      const menuInfo=await surfaces(menu,mode);
      await snapshot(name+'-menu',width,height);
      if (width===1366) await contrastSamples(theme,mode);
      await quit();
      await delay(200);
      await click('#editing-help-entry');
      await wait('document.querySelector("#editing-help-dialog:modal")');
      await delay(250);
      const dialogInfo=await surfaces(dialog,mode);
      const heading = await read(`(() => {
        const title = document.getElementById('editing-help-title');
        const rect = title.getBoundingClientRect(), body = title.parentElement.getBoundingClientRect();
        const x = (rect.left + rect.right)/2, y = (rect.top + rect.bottom)/2;
        return {focused:document.activeElement===title, hit:title.contains(document.elementFromPoint(x,y)),
          top:rect.top, bottom:rect.bottom, viewportTop:body.top, viewportBottom:body.bottom};
      })()`);
      assert.ok(heading.focused && heading.hit && heading.top>=heading.viewportTop && heading.bottom<=heading.viewportBottom,
        name+' 帮助标题应在初始焦点和滚动视口内 '+JSON.stringify(heading));
      await snapshot(name+'-dialog',width,height);
      bounds.push({name,menu:menuInfo.surface,dialog:dialogInfo.surface,title:menuInfo.title,heading,
        menuFilters:menuInfo.filtered,dialogFilters:dialogInfo.filtered});
      await quit();
      await delay(200);
    }
  }
  await fs.writeFile(path.join(output,'measurements.json'),JSON.stringify({bounds,results},null,2));
  console.log('16 张实际窗口截图、8 组亮暗缩略图文字对比度、玻璃层范围通过。');
};
