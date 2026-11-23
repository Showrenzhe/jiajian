'use strict';

const assert = require('node:assert/strict');
const { mkdtempSync } = require('node:fs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { app, nativeImage } = require('electron');
const { launchDesktop } = require('../src/desktop.cjs');
const { saveProject, readProject } = require('../src/project-format.cjs');
const { inspectAsset } = require('../src/media.cjs');
const { clickVisible } = require('./desktop-input.cjs');
const { ffmpeg } = require('./fixtures.cjs');

app.disableHardwareAcceleration();

async function makeProject(directory) {
  const video = path.join(directory, '红绿蓝三段原声.mp4');
  const voice = path.join(directory, '独立口播.wav');
  const parts = [['red',440], ['lime',660], ['blue',880]];
  const inputs = parts.flatMap(([color,hz]) => [
    '-f','lavfi','-i',`color=c=${color}:s=160x90:r=24:d=2`,
    '-f','lavfi','-i',`sine=frequency=${hz}:sample_rate=48000:duration=2`,
  ]);
  await ffmpeg([...inputs,'-filter_complex','[0:v][1:a][2:v][3:a][4:v][5:a]concat=n=3:v=1:a=1[v][a]',
    '-map','[v]','-map','[a]','-c:v','libx264','-threads','2','-c:a','aac',video]);
  await ffmpeg(['-f','lavfi','-i','sine=frequency=1100:duration=0.4',voice]);
  const assets = new Map([['video',await inspectAsset(video,'video')],['voice',await inspectAsset(voice,'audio')]]);
  const file = path.join(directory, '两次使用同一素材.sdworkbench');
  await saveProject(file, {
    ratio:'16:9', resolution:720, fps:24, fit:'fit', keepAudio:true, unordered:false, useOriginal:true,
    useMirrors:false, count:1, priority:'picture', musicVolume:35, musicIds:[],
    shots:[[{id:'video',start:0,end:6}], [{id:'video',start:.25,end:1,volume:45}]],
    narrationMode:'segmented', segmentNarrationIds:[[],['voice']],
    segmentVoiceCuts:[[],[{offset:.15,ranges:[{start:.05,end:.3}]}]],
  }, assets);
  return file;
}

async function verifyOutput(file, samples, total) {
  const media = await inspectAsset(file,'video');
  assert.ok(Math.abs(media.duration-total)<.11, '导出应使用所有保留段与另一实例的总时长 '+media.duration);
  for (const [time,channel,hz] of samples) {
    const pixel = await ffmpeg(['-ss',String(time),'-i',file,'-an','-frames:v','1','-vf','crop=4:4:iw/2:ih/2,scale=1:1',
      '-pix_fmt','rgb24','-f','rawvideo','pipe:1']);
    assert.equal(pixel.length,3);
    assert.ok(pixel[channel]>180 && pixel.filter((_,index)=>index!==channel).every(value=>value<45),
      `导出 ${time} 秒的色段顺序错误 ${Array.from(pixel)}`);
    const sound = await ffmpeg(['-ss',String(time),'-i',file,'-vn','-t','0.10','-ac','1','-ar','8000','-f','s16le','pipe:1']);
    let crossings = 0;
    for (let i=2; i<sound.length; i+=2) if (sound.readInt16LE(i-2)<0 && sound.readInt16LE(i)>=0) crossings++;
    const actualHz = crossings*16000/sound.length;
    assert.ok(Math.abs(actualHz-hz)<25,`${time} 秒的原声应随画面裁剪，预期 ${hz} Hz，得到 ${actualHz} Hz`);
  }
}

async function check() {
  const directory = mkdtempSync(path.join(os.tmpdir(),'jiajian-source-cut-'));
  app.setPath('userData',directory);
  app.setPath('sessionData',directory);
  const input = await makeProject(directory);
  const exports = path.join(directory,'导出');
  await fs.mkdir(exports);
  let openFile = input, saveFile;
  const win = await launchDesktop({show:false,dataDirectory:path.join(directory,'profile'),dialogs:{
    async showOpenDialog(_win,options) {
      assert.ok(['打开工程','选择导出目录'].includes(options.title),options.title);
      return {canceled:false,filePaths:[options.title==='打开工程' ? openFile : exports]};
    },
    async showSaveDialog(_win,options) {
      assert.equal(options.title,'保存工程');
      return {canceled:false,filePath:saveFile};
    },
  }});
  win.setContentSize(1440,960);
  const wc = win.webContents;
  wc.setBackgroundThrottling(false);
  wc.debugger.attach();
  const read = script => wc.executeJavaScript(script,true);
  const q = selector => 'document.querySelector('+JSON.stringify(selector)+')';
  const click = selector => clickVisible(wc,selector);
  const host = '#timeline-cut-editor[data-mode="cut"]';
  const ruler = host+' .video-cut-ruler';
  const slider = host+' .video-cut-playhead[role="slider"]';
  const monitor = '#player-pane[data-cut-monitor]';
  const localVideo = q(monitor+' .preview-stage .video-cut-preview video');
  const film = host+' .video-cut-filmstrip';
  const bands = host+' .cut-source-band';
  const activeBand = q(bands+'[data-current]');
  const availableFrames = `[...document.querySelectorAll(${JSON.stringify(film+' img')})].filter(img=>img.checkVisibility() && img.naturalWidth>0).length`;
  const segment = host+' .video-cut-segment[data-index]';
  const count = 'document.querySelectorAll('+JSON.stringify(segment)+').length';
  const mainClip = shot => '.sequence-video [data-drop-shot="'+shot+'"][data-move-candidate]';
  const duration = q(mainClip(0)+' .sequence-clip-duration')+'.textContent';
  const tool = name => host+' button[data-action="'+name+'"]';
  const time = 'Number('+q(slider)+'.getAttribute("aria-valuenow"))';
  const end = 'Number('+q(slider)+'.getAttribute("aria-valuemax"))';
  const approx = (value,expected,tolerance=.06) => `Math.abs((${value})-(${expected}))<${tolerance}`;
  const clock = id => `(()=>{const [h,m,s,f]=${q(id)}.textContent.split(':').map(Number);return h*3600+m*60+s+f/24;})()`;
  async function pixel(selector,x=.5,y=.5) {
    const position=await read(`(()=>{const r=${q(selector)}.getBoundingClientRect();return {x:r.x+r.width*${x},y:r.y+r.height*${y},width:2,height:2,scale:1};})()`);
    const {data}=await wc.debugger.sendCommand('Page.captureScreenshot',{clip:position});
    const [blue,green,red]=nativeImage.createFromBuffer(Buffer.from(data,'base64')).toBitmap();
    return [red,green,blue];
  }
  async function expectFrame(selector,channel,x=.5,y=.5) {
    let rgb;
    for (const until=Date.now()+8000;Date.now()<until;) {
      rgb=await pixel(selector,x,y);
      if (rgb[channel]>180 && rgb.every((c,i)=>i===channel || c<60)) return;
      await delay(75);
    }
    throw Error('画面颜色不对应原片，目标 '+selector+'，实际 '+rgb);
  }
  async function checkBounds(start,finish) {
    await wait(approx('Number('+activeBand+'.dataset.start)',start) + ' && ' +
      approx('Number('+activeBand+'.dataset.end)',finish),'原片上的入、出点应跟随当前片段');
    const actual=await read(`(()=>{const band=${activeBand}, r=band.getBoundingClientRect(), rail=band.parentElement.getBoundingClientRect();return [(r.left-rail.left)/rail.width,(r.right-rail.left)/rail.width];})()`);
    assert.ok(Math.abs(actual[0]-start/6)<.015 && Math.abs(actual[1]-finish/6)<.015,
      '标记应使用整段 6 秒原片的比例 '+actual);
  }
  async function wait(expression,description,milliseconds=10000) {
    for (const until=Date.now()+milliseconds; Date.now()<until;) {
      if (await read(expression)) return;
      await delay(35);
    }
    const state=await read(`[document.querySelector('#notice').textContent,document.querySelector('#output-status').textContent,
      document.querySelector('#timeline-cut-editor').innerText.slice(-550),document.activeElement.outerHTML.slice(0,160)]`);
    throw Error(description+' '+JSON.stringify(state));
  }
  const mouse = (type,coords,clickCount=1) => wc.debugger.sendCommand('Input.dispatchMouseEvent',{
    type,...coords,button:'left',buttons:type==='mouseReleased'?0:1,clickCount:type==='mouseMoved'?0:clickCount,
  });
  async function key(key,code,modifiers=0) {
    const physical = key.length===1 && /[a-z]/i.test(key) ? 'Key'+key.toUpperCase() : key;
    for (const type of ['rawKeyDown','keyUp']) await wc.debugger.sendCommand('Input.dispatchKeyEvent',{
      type,key,code:physical,windowsVirtualKeyCode:code,nativeVirtualKeyCode:code,modifiers,
    });
  }
  async function point(selector,x=.5) {
    const pos = await read(`(async()=>{
      const el=${q(selector)};el.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});await new Promise(requestAnimationFrame);
      const r=el.getBoundingClientRect();return {x:r.left+r.width*${x},y:r.top+r.height*.5};
    })()`);
    return pos;
  }
  async function dblclick(selector) {
    const pos=await read(`(async()=>{
      const deadline=performance.now()+3000;
      let details;
      while (performance.now()<deadline) {
        const el=${q(selector)};el?.scrollIntoView({block:'nearest',inline:'center',behavior:'instant'});
        await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);
        if (!el?.isConnected) continue;
        const r=el.getBoundingClientRect();
        for (const portion of [.45,.25,.65,.8]) {
          const p={x:r.left+r.width*portion,y:r.top+r.height/2};
          if (el.contains(document.elementFromPoint(p.x,p.y))) return p;
        }
        details=[r.toJSON(),document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)?.outerHTML.slice(0,120)];
      }
      throw Error('无法双击目标 '+${JSON.stringify(selector)}+' '+JSON.stringify(details));
    })()`);
    for (const clicks of [1,2]) {
      await mouse('mousePressed',pos,clicks);
      await mouse('mouseReleased',pos,clicks);
    }
    await wait(q(host)+'?.checkVisibility()', '原生双击应进入素材编辑器 '+selector);
  }
  async function seek(value) {
    const coords=await point(ruler,value/await read(end));
    await mouse('mousePressed',coords);
    await mouse('mouseReleased',coords);
    await wait(approx(time,value),'定位剪辑播放头至 '+value);
  }
  async function drag(from,to,cancel=false) {
    await mouse('mousePressed',from);
    await mouse('mouseMoved',to);
    if (cancel) await key('Escape',27);
    await mouse('mouseReleased',to);
  }
  async function save(name) {
    saveFile=path.join(directory,name+'.sdworkbench');
    await click('#save-project');
    await wait(q('#notice')+'.textContent.includes('+JSON.stringify('工程已保存：'+name)+')','保存 '+name);
    return (await readProject(saveFile)).config;
  }
  async function screenshot(name,selector) {
    const output=process.env.JIAJIAN_SOURCE_CUT_SCREENSHOTS;
    if (!output) return;
    await fs.mkdir(output,{recursive:true});
    const clip=selector && await read(`(async()=>{const el=${q(selector)};el.scrollIntoView({block:'center',behavior:'instant'});
      await new Promise(requestAnimationFrame);const r=el.getBoundingClientRect();
      return {x:Math.max(0,r.x),y:Math.max(0,r.y),width:Math.min(r.width,innerWidth),height:Math.min(r.height,innerHeight),scale:1};})()`);
    const {data}=await wc.debugger.sendCommand('Page.captureScreenshot',clip ? {clip} : {});
    await fs.writeFile(path.join(output,name+'.png'),Buffer.from(data,'base64'));
  }
  try {
    await click('#home-open-project');
    await wait('!!'+q(mainClip(1)), '工程应含两处同源实例');
    const view='#timeline-view';
    await click(view); await key('End',35); await key('Enter',13);
    await wait(q(view)+'.value==="cards"','切换至分镜卡片');
    await dblclick('.shot[data-shot-index="1"] .shot-poster');
    assert.ok(Math.abs(await read(end)-.75)<.02,'卡片应打开第二个素材实例');
    await click(tool('cancel'));
    await click(view); await key('Home',36); await key('Enter',13);
    await wait(q(view)+'.value==="time"','返回时间线');
    const lock='[data-control-key="vis0"] [data-track-action="locked"]';
    await click(lock);
    const lockedPoint=await point(mainClip(0));
    for (const clicks of [1,2]) {
      await mouse('mousePressed',lockedPoint,clicks);
      await mouse('mouseReleased',lockedPoint,clicks);
    }
    assert.equal(await read(q('#timeline-cut-editor')+'.checkVisibility()'),false,'锁定的视频轨不可进入剪辑');
    await click(lock);
    const initial = await save('原始状态');
    await dblclick(mainClip(0));
    await wait(localVideo+'.readyState>=2', '载入剪辑源视频');
    assert.equal(await read(q(host+' video')),null,'底部剪辑栏不应重复创建视频窗口');
    assert.equal(await read(`[...document.querySelectorAll('#player-pane video')].filter(v=>v.checkVisibility({visibilityProperty:true})).length`),1);
    await wait(q('#player-play')+'.checkVisibility() && !'+q('#player-play')+'.disabled','剪辑可由主播放器播放');
    await click('#player-play');
    await wait(time+'>.22 && !'+localVideo+'.paused && '+q('#player-play')+'.getAttribute("aria-pressed")==="true"','主播放器接管片段播放');
    await wait(`document.querySelector('#player-more .stereo-meter i[data-level]:not([data-level="0"])')`,'片段原声应驱动主播放器声道电平');
    await click('#player-play');
    await wait(localVideo+'.paused','主控制暂停剪辑播放');
    await click('#player-more');
    await click('#player-stop');
    await wait(approx(time,0),'主播放控制可回到剪辑起点');
    await click('#player-next');
    await wait(approx(time,1/24,.004),'主播放控制可逐帧定位片段');
    await key('Escape',27);
    await wait('!'+q('#player-more-menu')+'.matches(":popover-open") && !!'+q(monitor),'关闭更多播放控制应保留片段监看');
    await checkBounds(0,6);
    await wait(availableFrames+'>=3','拖动前胶片有原片缩略图');
    const right=await point(host+' .video-cut-handle[data-edge="end"]');
    const span=await read(q(ruler)+'.getBoundingClientRect().width');
    await mouse('mousePressed',right);
    let minFrames=Infinity;
    for (let step=1;step<=12;step++) {
      await mouse('mouseMoved',{x:right.x-span*(.75*step/12),y:right.y});
      minFrames=Math.min(minFrames,await read(availableFrames));
    }
    assert.ok(minFrames>0,'连续拖动中，已解码的缩略图不能全部消失');
    await checkBounds(0,1.5);
    await expectFrame(monitor+' .video-cut-preview',0);
    await mouse('mouseReleased',{x:right.x-.75*span,y:right.y});
    await expectFrame(film,0,.86);
    console.log('连续 12 次拖动，最少仍有 '+minFrames+' 个已加载的可见胶片帧。');
    await click(tool('undo'));
    await checkBounds(0,6);
    await seek(1);
    await key('w',87);
    await wait(count+'===2','W 分割');
    await key('Escape',27);
    await wait('!'+q('#timeline-cut-editor')+'.checkVisibility()','Esc 取消');
    assert.equal(await read(q(monitor)),null,'取消应归还主播放器');
    const canceled=await save('已取消剪辑');
    assert.deepEqual(canceled,initial,'取消应完整保留工程');
    await dblclick(mainClip(0));
    await seek(.8);
    await key('w',87);
    await click('#open-project');
    await wait('!'+q(monitor)+' && !'+q('#timeline-cut-editor')+'.checkVisibility() && !!'+q(mainClip(1)),'打开另一个工程应释放剪辑监看');
    // The project catalog assigns fresh IDs on each open.
    const original = await save('重开后的原始状态');
    await dblclick(mainClip(0));
    assert.equal(await read(count),1,'切工程应丢弃未应用的分割');
    await seek(1);
    const from=await point(slider), to=await point(ruler,2/6);
    await drag(from,{x:to.x,y:from.y});
    await wait(approx(time,2)+' && '+approx(localVideo+'.currentTime',2),'拖播放头更新源视频和位置');
    await wait(approx(clock('#player-time'),2),'主时间码应跟随编辑播放头');
    await key('w',87);
    await wait(count+'===2','W 在 2 秒分割');
    await seek(4); await key('w',87);
    await wait(count+'===3','W 在 4 秒分割');
    const field=host+' input[type=number]';
    await click(field);
    for (const [char,code] of [['w',87],['q',81],['e',69]]) await key(char,code);
    await key('z',90,2);
    assert.equal(await read(count),3,'数字输入时快捷键与局部历史隔离');
    assert.equal(await read(end),6,'输入框内 Q/E 不裁剪素材');

    const handle=host+' .video-cut-handle[data-edge="end"]';
    const lastHandle=await read(`(()=>{const nodes=document.querySelectorAll(${JSON.stringify(handle)}),r=nodes[nodes.length-1].getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
    const rulerWidth=await read(q(ruler)+'.getBoundingClientRect().width');
    const shortened={x:lastHandle.x-rulerWidth/6,y:lastHandle.y};
    await drag(lastHandle,shortened,true);
    await wait(q(host)+'?.checkVisibility() && '+approx(end,6),'Esc 在拖边缘期间应恢复磁带长度并保留编辑器');
    await drag(lastHandle,shortened);
    await wait(approx(end,5),'拖动右边缘应缩短末段');
    await key('z',90,2);
    await wait(approx(end,6)+' && '+count+'===3','一次局部撤销恢复完整边界');
    await click(tool('redo'));
    await wait(approx(end,5),'局部重做恢复右边缘修剪');
    await click(tool('undo'));
    await seek(.5); await key('q',81);
    await wait(approx(end,5.5)+' && '+count+'===3','Q 只裁第一段左侧');
    await seek(4.5); await key('e',69);
    await wait(approx(end,4.5)+' && '+count+'===3','E 只裁第三段右侧');
    await click(tool('move-left'));
    await seek(1.8);
    await wait(approx(localVideo+'.currentTime',4.3,.10),'前移第三段后，编辑器预览应显示对应的蓝色原片');
    await expectFrame(monitor+' .video-cut-preview',2);
    await checkBounds(4,5);
    assert.equal(await read('document.querySelectorAll('+JSON.stringify(bands)+').length'),3);
    await wait(approx(clock('#player-time'),1.8)+' && '+approx(clock('#player-duration'),4.5),'主播放器应显示重排后的编辑时间');
    for (const [scheme,width] of [['light',1440],['dark',960]]) {
      win.setContentSize(width,900);
      await wc.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[
        {name:'prefers-color-scheme',value:scheme},{name:'prefers-reduced-motion',value:'reduce'},
      ]});
      await wait(`document.documentElement.dataset.theme===${JSON.stringify(scheme)}`,'切换到'+scheme+'主题');
      await wait(`[...document.querySelectorAll(${JSON.stringify(host+' [data-action]')})].every(el=>el.checkVisibility() && el.getBoundingClientRect().right<=innerWidth+1)`,
        '紧凑与标准窗口内操作均应完整显示');
      await wait(`[...document.querySelectorAll(${JSON.stringify(host+' .video-cut-filmstrip img')})].filter(img=>img.naturalWidth>0).length>=3`,
        '应有多个实际原片缩略图');
      if (process.env.JIAJIAN_SOURCE_CUT_SCREENSHOTS) await wait(
        `[...document.querySelectorAll(${JSON.stringify(host+' .video-cut-filmstrip img')})].every(img=>img.naturalWidth>0)`,
        '截取已载入完整色带的素材剪辑界面');
      await screenshot('素材剪辑-'+scheme);
    }
    await click(tool('apply'));
    await wait('!'+q('#timeline-cut-editor')+'.checkVisibility() && '+approx('parseFloat('+duration+')',4.5),'应用后主时间线时长更新');
    assert.equal(await read(q(monitor)),null,'应用后应还原轨道播放器');
    win.setContentSize(1440,960);
    await wait('innerWidth>1200','恢复标准窗口');
    await click('#track-undo');
    await wait(approx('parseFloat('+duration+')',6),'工程一次撤销应还原整个素材剪辑');
    await click('#track-redo');
    await wait(approx('parseFloat('+duration+')',4.5),'工程重做应恢复剪辑');
    const applied=await save('裁剪调序');
    const [a,b]=applied.shots;
    assert.deepEqual(b,original.shots[1],'第二个同源实例应保留原入出点、音量和顺序');
    const {shots:unused,...sideTracks}=applied;
    const {shots:previous,...before}=original;
    assert.deepEqual(sideTracks,before,'口播音频、音量设置与其余工程配置应完整保留');
    const expected=[[.5,2],[4,5],[2,4]];
    assert.equal(a[0].ranges.length,expected.length);
    for (const [i,{start,end:finish}] of a[0].ranges.entries()) {
      const [left,right]=expected[i];
      assert.ok(Math.abs(start-left)<.06 && Math.abs(finish-right)<.06,JSON.stringify(a[0].ranges));
    }
    openFile=saveFile;
    await click('#open-project');
    await wait(q('#notice')+'.textContent.includes("已打开工程：裁剪调序")','重开已保存工程');
    await dblclick(mainClip(0));
    assert.equal(await read(count),3,'重开后的素材编辑器恢复三段');
    await seek(1.8);
    await wait(approx(localVideo+'.currentTime',4.3,.10),'重开后原片蓝色选段仍在第二位');
    await click(tool('cancel'));
    await dblclick(mainClip(1));
    assert.equal(await read(count),1);
    assert.ok(Math.abs(await read(end)-.75)<.02,'另一同源实例的局部时间线保持独立');
    await click(tool('cancel'));
    await click('#start-export');
    await wait(q('#output-status')+'.textContent.includes("已保存 1 条")','从重开的工程实际导出',60000);
    const files=(await fs.readdir(exports)).filter(name=>name.endsWith('.mp4'));
    assert.equal(files.length,1);
    await verifyOutput(path.join(exports,files[0]),[[.55,0,440],[1.8,2,880],[3,1,660],[4.98,0,440]],5.25);
    await dblclick(mainClip(0));
    await click(tool('reset'));
    await click(tool('reverse'));
    await checkBounds(0,6);
    await click(tool('mirror'));
    await click(tool('rotate'));
    await click(tool('crop'));
    const crop='.cut-crop-dialog[open]';
    const corner=crop+' [data-corner="se"]';
    const box=await read(q(crop+' .cut-crop-box')+'.getBoundingClientRect().toJSON()');
    const fromCorner=await point(corner);
    await drag(fromCorner,{x:fromCorner.x-box.width*.25,y:fromCorner.y-box.height*.25});
    await wait(q(crop+' img')+'.naturalWidth>0','裁剪窗口载入定位参考帧');
    await screenshot('画面裁剪',crop);
    await click(crop+' [data-action="apply"]');
    await click(tool('play'));
    await wait(localVideo+'.readyState>=2 && !'+localVideo+'.paused && '+time+'>0.25','生成并播放局部倒放原声',30000);
    await click(tool('play'));
    await click(tool('apply'));
    await wait('!'+q('#timeline-cut-editor')+'.checkVisibility()','应用倒放、镜像、旋转和裁剪',30000);
    const transformed=await save('画面操作');
    const recipe=transformed.shots[0][0].sourceEdit.ranges;
    assert.deepEqual(recipe.map(r=>[r.start,r.end,r.reverse,r.mirror,r.rotation]),[[0,6,true,true,90]]);
    assert.ok(Math.abs(recipe[0].crop.width-.75)<.02 && Math.abs(recipe[0].crop.height-.75)<.02);
    assert.equal(transformed.shots[1][0].id,transformed.shots[0][0].sourceEdit.id,'另一实例仍指向同一原素材');
    const sourceId=transformed.shots[1][0].id;
    assert.deepEqual(transformed.shots[1],[{...applied.shots[1][0],id:sourceId}],'重开后的另一个实例应保留编辑参数');
    openFile=saveFile;
    await click('#open-project');
    await wait(q('#notice')+'.textContent.includes("已打开工程：画面操作")','重开包含画面操作的文件');
    await dblclick(mainClip(0));
    assert.equal(await read(q(tool('reverse'))+'.getAttribute("aria-pressed")'),'true');
    assert.equal(await read(q(tool('mirror'))+'.getAttribute("aria-pressed")'),'true');
    await click(tool('cancel'));
    await click('#start-export');
    let second;
    for (const until=Date.now()+60000;Date.now()<until;) {
      const names=await fs.readdir(exports);
      second=names.find(name=>name.endsWith('.mp4') && name!==files[0]);
      if (second && await read(q('#output-status')+'.textContent.includes("已保存 1 条") && '+q('#cancel-export')+'.hidden')) break;
      await delay(60);
    }
    assert.ok(second,'应导出重开的倒放工程');
    await verifyOutput(path.join(exports,second),[[.55,2,880],[2.5,1,660],[4.5,0,440],[6.48,0,440]],6.75);
    console.log('真实时间线双击、拖动、前后修剪、局部与工程撤销、同源实例、倒放预览和两次工程重开后的画面与原声导出均通过。');
  } finally { wc.debugger.detach(); win.destroy(); }
}

check().then(()=>app.exit(0),error=>{console.error(error);app.exit(1);});
