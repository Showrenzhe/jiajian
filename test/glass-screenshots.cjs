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

module.exports = async function capture({win,wc,read,click,wait,key,select,readyPicture,draft,output}) {
  await fs.mkdir(output,{recursive:true});
  const results = [];
  const bounds = [];
  const video = '.sequence-video [data-move-candidate]';
  const menu = '#video-track-menu';
  const dialog = '#editing-help-dialog';
  const quit = () => key('Escape','Escape');
  const moving = () => read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const titleControls=['.titlebar','#title-home','#app-settings','#software-update-entry'];
  const editorControls=[...titleControls,'#materials-pane','#player-pane','#montage-inspector','#montage-pane',
    '#player-transport','#player-time','#player-play','#player-more','.timeline-header','#timeline-tracks-tab','#timeline-view','#timeline-tracks-panel',
    '.sequence-ruler .sequence-head','.sequence-cursor-clock'];
  const draftCard='#draft-list [data-draft-id="'+draft.id+'"]';
  const homeControls=[...titleControls,'#home-heading','#home-create','#home-open-project','#home-montage','#tab-montage',
    '#tab-scene-split','#tab-script',draftCard,draftCard+' .draft-meta'];
  async function navigate(selector,mode) {
    await click(selector);
    await wait('document.querySelector(".app-frame").dataset.mode==='+JSON.stringify(mode)+' && !document.documentElement.classList.contains("workspace-transitioning")');
    await moving();
  }

  async function snapshot(name, width, height) {
    await moving();
    const shot = await wc.capturePage();
    assert.deepEqual(shot.getSize(),{width,height},name);
    await fs.writeFile(path.join(output,name+'.png'),shot.toPNG());
  }
  async function surfaces(selector, mode) {
    const info = await read(`(() => {
      const onscreen=el=>{
        const r=el.getBoundingClientRect();
        return r.width>0 && r.height>0 && r.right>0 && r.left<innerWidth && r.bottom>0 && r.top<innerHeight
          && el.checkVisibility({visibilityProperty:true,opacityProperty:true});
      };
      const visible=[...document.querySelectorAll('.glass')].filter(onscreen);
      const surfaces=visible.map(el=>({id:el.id || el.dataset.glassSurface || el.className,filter:getComputedStyle(el).backdropFilter}));
      const box=el=>{const r=el.getBoundingClientRect();return {x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)}};
      const filtered = [];
      for (const el of document.querySelectorAll('body *')) {
        if (!onscreen(el)) continue;
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
      return {surface:box(document.querySelector(${JSON.stringify(selector)})),title,surfaces,filtered};
    })()`);
    assert.ok(info.filtered.length <= (mode==='off' ? 0 : 4), JSON.stringify({selector,mode,filtered:info.filtered}));
    assert.ok(info.surfaces.length <= 4, JSON.stringify({selector,mode,surfaces:info.surfaces}));
    if(mode==='full') assert.ok(info.filtered.length>0, selector+' 完整档应有实际玻璃采样');
    const functional=selector==='#editor-workspace' ? '#player-transport' : selector==='#home' ? '#home-local-tools' : null;
    if (functional) {
      assert.equal(info.filtered.some(row=>row.node===functional),mode==='full',
        functional+' 应随档位切换实际采样 '+JSON.stringify(info.filtered));
    }
    if(selector===menu || selector===dialog) {
      const top=info.surfaces.find(s=>s.id===selector.slice(1));
      assert.ok(top,selector+' 应作为前景玻璃显示');
      assert.equal(top.filter==='none',mode!=='full',JSON.stringify({selector,mode,top}));
    }
    return info;
  }
  async function checkBounds(required, optional=[]) {
    const geometry=await read(`(() => {
      const boxes=[];
      for(const selector of ${JSON.stringify(required.concat(optional))}) {
        const nodes=[...document.querySelectorAll(selector)].filter(el=>el.checkVisibility({visibilityProperty:true,opacityProperty:true}));
        for(const el of nodes){
          const r=el.getBoundingClientRect();
          boxes.push({selector,id:el.id,left:r.left,top:r.top,right:r.right,bottom:r.bottom});
        }
      }
      const doc=document.documentElement;
      return {width:innerWidth,height:innerHeight,pageWidth:doc.scrollWidth,boxes};
    })()`);
    assert.ok(geometry.pageWidth<=geometry.width+1,'页面存在横向溢出 '+JSON.stringify(geometry));
    for(const selector of required) assert.ok(geometry.boxes.some(b=>b.selector===selector),'应显示 '+selector);
    for(const box of geometry.boxes) {
      assert.ok(box.left>=-1 && box.right<=geometry.width+1 && box.top>=-1 && box.bottom<=geometry.height+1
        && box.right>box.left && box.bottom>box.top,'控件越出窗口 '+JSON.stringify({box,width:geometry.width,height:geometry.height}));
    }
    return geometry.boxes;
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
      await wait(`[...document.querySelectorAll('.sequence-video [data-move-candidate]')].every(clip => {
        const images = [...clip.querySelectorAll('.sequence-frames img')];
        return images.length > 0 && images.every(img => img.complete && img.naturalWidth > 0);
      })`);
      const editorInfo=await surfaces('#editor-workspace',mode);
      let sidebarFilters;
      if (width===1366 && theme==='light' && mode==='full') {
        await click('#nav-toggle');
        await wait('document.querySelector("#nav-toggle").ariaExpanded==="true"');
        await delay(250);
        sidebarFilters=(await surfaces('#editor-workspace',mode)).filtered;
        assert.ok(sidebarFilters.some(el=>el.node==='#workspace-navigation'));
        await click('#nav-toggle');
        await wait('document.querySelector("#nav-toggle").ariaExpanded==="false"');
        await delay(250);
      }
      const editorBoxes=await checkBounds(editorControls,['.player-control-row .player-picker','.player-control-row #player-duration',
        '.player-control-row #player-fullscreen','.track-toolbar > button','.track-edit-actions > button']);
      await snapshot(name+'-editor',width,height);
      let layout;
      if(width===1366 && theme==='light' && mode==='full') {
        await click('#panel-layout-toggle');
        await wait('document.querySelector("#layout-editing-hint").checkVisibility()');
        await delay(250);
        layout=await surfaces('#layout-editing-hint',mode);
        await checkBounds([...titleControls,'#layout-editing-hint','#panel-layout-toggle']);
        await snapshot(name+'-layout',width,height);
        await quit();
        await wait('!document.querySelector("#layout-editing-hint").checkVisibility()');
      }
      const shotStrip='.sequence-shots [data-reorder-shot]';
      const shotTitles=()=>read('[...document.querySelectorAll('+JSON.stringify(shotStrip)+')].map(el=>el.textContent)');
      const original=await shotTitles();
      assert.equal(original.length,draft.shotCount);
      await navigate('#title-home','home');
      const card='document.querySelector('+JSON.stringify(draftCard)+')';
      await wait(card+'?.querySelector(".draft-cover img")?.naturalWidth > 0');
      const badge=await read(`(() => {
        const card=${card}, cover=card.querySelector('.draft-cover').getBoundingClientRect();
        const badge=card.querySelector('.draft-meta'), r=badge.getBoundingClientRect(), time=badge.querySelector('time');
        return {label:badge.textContent, edited:time.dateTime, inside:r.left>=cover.left-1 && r.top>=cover.top-1
          && r.right<=cover.right+1 && r.bottom<=cover.bottom+1};
      })()`);
      assert.ok(badge.inside && badge.label.includes('0:10') && badge.label.includes('5 个分镜')
        && Number.isFinite(Date.parse(badge.edited)),'草稿封面的时长、分镜数与编辑时间 '+JSON.stringify(badge));
      const homeInfo=await surfaces('#home',mode);
      const homeBoxes=await checkBounds(homeControls);
      await snapshot(name+'-home',width,height);
      await navigate('#home-montage','montage');
      await wait('document.querySelectorAll('+JSON.stringify(shotStrip)+').length==='+original.length);
      assert.deepEqual(await shotTitles(),original,'从首页续编保留已载入的测试工程');
      await readyPicture();
      await clickVisible(wc,video,'right');
      await wait('document.querySelector("#video-track-menu:popover-open")');
      await delay(250);
      const menuInfo=await surfaces(menu,mode);
      await checkBounds([menu]);
      await snapshot(name+'-menu',width,height);
      if (width===1366) await contrastSamples(theme,mode);
      await quit();
      await delay(200);
      await click('#editing-help-entry');
      await wait('document.querySelector("#editing-help-dialog:modal")');
      await delay(250);
      const dialogInfo=await surfaces(dialog,mode);
      await checkBounds([dialog]);
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
        menuFilters:menuInfo.filtered,dialogFilters:dialogInfo.filtered,menuGlass:menuInfo.surfaces,dialogGlass:dialogInfo.surfaces,
        editor:{...editorInfo,controls:editorBoxes,sidebarFilters},home:{...homeInfo,controls:homeBoxes,badge},layout});
      await quit();
      await delay(200);
    }
  }
  await fs.writeFile(path.join(output,'measurements.json'),JSON.stringify({bounds,results},null,2));
  console.log('33 张实际窗口截图、8 组亮暗缩略图文字对比度、玻璃层数及界面边界检查通过。');
};
