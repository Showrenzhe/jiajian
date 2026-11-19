'use strict';

const assert=require('node:assert/strict');
const path=require('node:path');
const os=require('node:os');
const fs=require('node:fs/promises');
const {setTimeout:delay}=require('node:timers/promises');
const {app}=require('electron');
const {launchDesktop}=require('../src/desktop.cjs');
const {saveProject}=require('../src/project-format.cjs');
const {inspectAsset}=require('../src/media.cjs');
const {ffmpeg}=require('./fixtures.cjs');

app.disableHardwareAcceleration();
async function check() {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'jiajian-waves-'));
  app.setPath('userData',path.join(root,'electron'));
  const voice=path.join(root,'停顿后有声.wav'), picture=path.join(root,'有声.mp4'), quiet=path.join(root,'无音轨.mp4');
  await ffmpeg(['-f','lavfi','-i','sine=frequency=440:duration=2','-af',"volume='if(lt(t,1),0,4.8+2.5*sin(22*t))':eval=frame",voice]);
  await Promise.all([
    ffmpeg(['-f','lavfi','-i','color=teal:s=160x120:r=24','-i',voice,'-t','2','-c:v','libx264','-c:a','aac','-threads','2',picture]),
    ffmpeg(['-f','lavfi','-i','color=blue:s=160x120:r=24','-t','3','-c:v','libx264','-threads','2',quiet]),
  ]);
  const project=path.join(root,'波形工程.sdworkbench');
  const records=new Map(await Promise.all([['voice',voice,'audio'],['video',picture,'video'],['quiet',quiet,'video']]
    .map(async ([id,file,kind])=>[id,await inspectAsset(file,kind)])));
  await saveProject(project,{
    shots:[[{id:'video',start:0,end:2,speed:2,ranges:[{start:1,end:2},{start:0,end:1}]}],[{id:'quiet',start:0,end:3}]],
    ratio:'16:9',resolution:720,fps:24,fit:'fit',keepAudio:true,unordered:false,useOriginal:true,useMirrors:false,count:1,
    musicIds:['voice'],musicVolume:90,narrationId:'voice',narrationMode:'whole',narrationVolume:100,priority:'picture',
    segmentNarrationIds:[['voice'],[]],segmentVoiceCuts:[[{ranges:[{start:1.2,end:1.6},{start:0,end:.4}],offset:.1}],[]],
    packaging:{global:[{kind:'sound',id:'voice',start:0,end:.7,mediaOffset:1,volume:100},
      {kind:'pip',id:'video',start:0,end:.7,mediaOffset:1,volume:0}]},
  },records);
  const win=await launchDesktop({show:false,dataDirectory:path.join(root,'profile'),dialogs:{
    async showOpenDialog(_win,opts){assert.equal(opts.title,'打开工程');return {canceled:false,filePaths:[project]};}
  }});
  const run=async(code)=>{
    try {return await win.webContents.executeJavaScript(code,true);}
    catch(error){throw new Error(code.slice(0,220),{cause:error});}
  };
  async function wait(check,label) {
    const until=Date.now()+22000;
    do {if(await run(check))return;await delay(60);}while(Date.now()<until);
    throw new Error(label+': '+await run('document.querySelector("#notice")?.textContent'));
  }
  function query(selector){return 'document.querySelector('+JSON.stringify(selector)+')';}
  async function levels(selector,fractions) {
    const strip=query(selector+' .audio-waveform');
    await wait('!!'+strip,selector);
    await run(strip+'.scrollIntoView({block:"nearest",inline:"nearest"})');
    await wait(strip+'?.dataset.state==="ready"',selector+' 波形解码');
    return run(`(() => {
      const canvas=${strip}.querySelector('canvas'), ctx=canvas.getContext('2d'), h=canvas.height;
      return ${JSON.stringify(fractions)}.map(f=>{
        const pixels=ctx.getImageData(Math.floor(f*canvas.width),0,1,h).data;
        let filled=0;for(let y=0;y<h;y++) if(pixels[y*4+3]>0) filled++;
        return filled;
      });
    })()`);
  }
  try {
    win.setContentSize(1420,1000);
    await run(query('#home-open-project')+'.click()');
    const video='.sequence-video .sequence-block[data-drop-shot="0"]';
    const silence='.sequence-video .sequence-block[data-drop-shot="1"]';
    const [first,last]=await levels(video,[.2,.85]);
    assert.ok(first>last+2,'重新排序和变速后的候选先有声、后静音');
    assert.equal(await run('!!'+query(silence+' .audio-waveform')),false,'无音流视频不绘制波形');
    const music=await levels('.sequence-music',[.12,.37,.62,.87]);
    assert.ok(music[1]>music[0]+2 && music[3]>music[2]+2,'配乐的第二次循环应保留停顿');
    const whole=await levels('.sequence-voice',[.22,.82]);
    assert.ok(whole[1]>whole[0]+2,'整段口播按原音频显示');
    assert.ok((await levels('.kind-sound',[.35]))[0]>3,'音效从指定源偏移取样');
    assert.ok((await levels('.kind-pip',[.35]))[0]>3,'静音画中画也可看到原声形状');
    assert.ok(await run('!!'+query('.kind-pip .waveform-muted')),'静音画中画使用弱化样式');
    await run(query('.sequence-music button[aria-expanded]')+'.click()');
    await wait(query('.sequence-music .audio-waveform canvas')+'?.height<=8','折叠后波形应缩成细条');
    await run(query('.sequence-music button[aria-expanded]')+'.click()');
    await wait(query('.sequence-music .audio-waveform canvas')+'?.height>8','展开后恢复波形');
    await run(query('#timeline-fit')+'.click()');
    const resized=await levels('.sequence-music',[.12,.37,.62,.87]);
    assert.ok(resized[1]>resized[0]+2 && resized[3]>resized[2]+2,'适配缩放后波形仍严格对应时间');
    const section=await run('(()=>{const box=document.querySelector("#timeline-clock").getBoundingClientRect();const y=Math.ceil(Math.max(0,box.y));return {x:Math.ceil(box.x),y,width:Math.floor(box.width),height:Math.floor(Math.min(box.bottom,innerHeight)-y)};})()');
    await fs.writeFile(path.join(root,'时间线音频轨.png'),(await win.webContents.capturePage(section)).toPNG());
    await run('(()=>{const field=document.querySelector("#narration-mode");field.value="segmented";field.dispatchEvent(new Event("change",{bubbles:true}));})()');
    await wait(query('.sequence-voice .sequence-block')+'?.hasAttribute("data-voice-shot")','分段口播');
    const segmented=await levels('.sequence-voice',[.17,.8]);
    assert.ok(segmented[0]>segmented[1]+2,'分段口播按照重排后的原声区间取样');
    await run(query('.sequence-voice .sequence-block')+'.dispatchEvent(new MouseEvent("dblclick",{bubbles:true}))');
    const cut=await levels('.cut-source-overview',[.15,.8]);
    assert.ok(cut[1]>cut[0]+2,'口播裁剪播放头应与原音频波形同步');
    await fs.writeFile(path.join(root,'波形验收.png'),(await win.webContents.capturePage()).toPNG());
    console.log('真实波形验收通过。',root);
  } finally {win.destroy();}
}
check().then(()=>app.exit(0),e=>{console.error(e);app.exit(1);});
