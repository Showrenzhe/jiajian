'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {promisify} = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const grades = ['temperature','tint','saturation','lightness','brightness','contrast','highlights','glow'];
const colors = { red:0, orange:30, yellow:60, green:120, cyan:180, blue:235, purple:275, magenta:315 };
const filters = { none:{},portrait:{tint:7,lightness:6,contrast:-6},food:{temperature:16,saturation:19,contrast:7},
  landscape:{saturation:17,contrast:12,highlights:-7},retro:{temperature:20,contrast:-15,saturation:-18},mono:{saturation:-100,contrast:10} };
const effects = ['blur','sharpen','grain','vignette','chromatic','negative'];
const clamp = (n,lo=0,hi=1) => Math.max(lo,Math.min(hi,n));
function number(n,lo,hi,label) {
  if(!Number.isFinite(n)||n<lo||n>hi)throw new Error(label+'无效。');return n;
}
function normalizeLook(value, mapId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('画面设置无效。');
  const out = {};
  for(const key of grades) if(value.grade?.[key] !== undefined) {
    (out.grade ??= {})[key]=number(value.grade[key],-100,100,'调色参数');
  }
  for(const color of Object.keys(colors)) for(const [key,max] of [['h',180],['s',100],['l',100]]) if(value.hsl?.[color]?.[key] !== undefined) {
    ((out.hsl ??= {})[color] ??= {})[key]=number(value.hsl[color][key],-max,max,'HSL 参数');
  }
  if(value.filter) { if(!Object.hasOwn(filters,value.filter))throw new Error('滤镜无效。');out.filter=value.filter; }
  if(value.lut)out.lut=mapId(value.lut,'lut');
  if(value.head || value.tail) {
    out.head=number(value.head??0,0,86400,'去片头时长');out.tail=number(value.tail??0,0,86400,'去片尾时长');
  }
  if(value.effects) {
    if(!Array.isArray(value.effects)||value.effects.length>10)throw new Error('每个片段最多 10 个特效。');
    out.effects=value.effects.map((e)=>{
      if(!effects.includes(e?.kind))throw new Error('特效类型无效。');
      const start=number(e.start??0,0,86400,'特效起点'), end=e.end==null?null:number(e.end,start+.000001,86400,'特效终点');
      const item={kind:e.kind,start,end,strength:number(e.strength??50,0,100,'特效强度')};
      if(e.pool?.length){if(!Array.isArray(e.pool)||e.pool.length>effects.length||e.pool.some((k)=>!effects.includes(k)))throw new Error('随机特效列表无效。');item.pool=[...new Set(e.pool)];}
      return item;
    });
  }
  if(value.background) {
    const bg=value.background;
    if(!['none','blur','color','pattern','media'].includes(bg.kind))throw new Error('素材背景类型无效。');
    out.background={kind:bg.kind};
    if(bg.kind==='blur')out.background.strength=number(bg.strength??40,1,100,'背景模糊程度');
    if(bg.kind==='color'){if(!/^#[a-f0-9]{6}$/i.test(bg.color))throw new Error('背景颜色无效。');out.background.color=bg.color;}
    if(bg.kind==='pattern'){if(!['dots','grid','gradient'].includes(bg.pattern))throw new Error('背景样式无效。');out.background.pattern=bg.pattern;}
    if(bg.kind==='media'){
      if(!Array.isArray(bg.ids)||!bg.ids.length||bg.ids.length>100)throw new Error('请选择背景素材。');
      out.background.ids=bg.ids.map((id)=>mapId(id,'visual'));
    }
  }
  return out;
}

async function inspectLut(file) {
  if(!path.isAbsolute(file)||path.extname(file).toLowerCase()!=='.cube')throw new Error('请选择本地 .cube 滤镜。');
  const reader=await fs.open(file,'r');
  try {
    const stat=await reader.stat();
    if(!stat.isFile()||stat.size>24*1024*1024)throw new Error('LUT 文件最多 24 MiB。');
    const text=await reader.readFile('utf8');
    let n=0, rows=0;
    for(const line of text.split(/\r?\n/)){
      const s=line.replace(/#.*/,'').trim(); if(!s||/^TITLE\s+/i.test(s))continue;
      if(/^LUT_3D_SIZE\s+/i.test(s)){n=Number(s.split(/\s+/)[1]);if(!Number.isInteger(n)||n<2||n>65)throw new Error('支持 2 至 65 阶的三维 LUT。');continue;}
      const domain=/^DOMAIN_(?:MIN|MAX)\s+/i.test(s);
      const parts=s.split(/\s+/).slice(domain?1:0);
      if(parts.length!==3||parts.some((v)=>!Number.isFinite(Number(v))))throw new Error('LUT 颜色数据无效。');
      if(!domain)rows++;
    }
    if(!n||rows!==n**3)throw new Error('LUT 颜色表不完整。');
    return {kind:'lut',name:path.basename(file),path:file};
  } finally {await reader.close();}
}

function gradeCube(look, n=17) {
  const g=Object.fromEntries(grades.map((key)=>[key,clamp((look.grade?.[key]??0)+(filters[look.filter]?.[key]??0),-100,100)/100]));
  const selective=Object.entries(look.hsl??{});
  const rows=['LUT_3D_SIZE '+n];
  for(let z=0;z<n;z++)for(let y=0;y<n;y++)for(let x=0;x<n;x++){
    let r=x/(n-1), b=z/(n-1), green=y/(n-1);
    const high=Math.max(r,green,b), low=Math.min(r,green,b), d=high-low;
    let l=(high+low)/2, s=d===0?0:d/(1-Math.abs(2*l-1));
    let h=0;
    if(d)h=(((high===r?(green-b)/d:high===green?(b-r)/d+2:(r-green)/d+4)*60)%360+360)%360;
    let hShift=0,sShift=0,lShift=0;
    for(const [color,adjust] of selective){
      const dist=Math.abs(((h-colors[color]+540)%360)-180);
      const weight=Math.max(0,1-dist/(color==='orange'||color==='red'?32:48))*Math.min(1,s*4);
      hShift+=(adjust.h??0)*weight;sShift+=(adjust.s??0)*weight/100;lShift+=(adjust.l??0)*weight/200;
    }
    h=((h+hShift)%360+360)%360;s=clamp(s*(1+g.saturation+sShift));l=clamp(l+lShift+g.lightness*.2);
    const chroma=(1-Math.abs(2*l-1))*s, t=chroma*(1-Math.abs(h/60%2-1)), m=l-chroma/2;
    [r,green,b]=h<60?[chroma,t,0]:h<120?[t,chroma,0]:h<180?[0,chroma,t]:h<240?[0,t,chroma]:h<300?[t,0,chroma]:[chroma,0,t];
    const lift=g.brightness*.16+g.highlights*l*l*.28+g.glow*Math.sin(Math.PI*l)*.18;
    const transform=(c,bias)=>clamp((c+m-.5)*(1+.7*g.contrast)+.5+lift+bias).toFixed(6);
    rows.push([transform(r,.12*g.temperature+.05*g.tint),transform(green,-.10*g.tint),transform(b,-.12*g.temperature+.05*g.tint)].join(' '));
  }
  return rows.join('\n')+'\n';
}

function chooseLooks(clips, catalog, random, uses) {
  const chosen=new Map();
  function choose(part) {
    const source=part.look;if(!source)return part;
    if(!chosen.has(source)){
      const settings={...source};
      if(source.background?.kind==='media')settings.backgroundAsset=catalog.get(source.background.ids[Math.floor(random()*source.background.ids.length)]);
      if(source.lut)settings.lutAsset=catalog.get(source.lut);
      settings.effects=source.effects?.map((e)=>{
        if(!e.pool?.length)return e;
        const least=Math.min(...e.pool.map((k)=>uses.get(k)??0)),pool=e.pool.filter((k)=>(uses.get(k)??0)===least);
        const kind=pool[Math.floor(random()*pool.length)];uses.set(kind,least+1);return {...e,kind};
      });
      chosen.set(source,settings);
    }
    return {...part,look:chosen.get(source)};
  }
  return clips.map((clip)=>clip.visuals?{...clip,visuals:clip.visuals.map(choose)}:choose(clip));
}

async function prepareLooks(plan,dir,files) {
  if(!plan.clips?.some(c=>(c.visuals??[c]).some(p=>p.look))&&!plan.layers?.some(layer=>layer.look))return plan;
  const prepared=new Map();
  async function get(look){
    const result={...look};
    async function store(contents){
      const name='color-'+files.length+'.cube',file=path.join(dir,name);files.push(file);
      await fs.writeFile(file,contents,{flag:'wx'});return name;
    }
    if(look.lutAsset){await inspectLut(look.lutAsset.path);result.externalLut=await store(await fs.readFile(look.lutAsset.path));}
    if(look.hsl||look.grade||look.filter && look.filter!=='none')result.gradeLut=await store(gradeCube(look));
    return result;
  }
  async function part(p) {
    if(!p.look)return p;
    if(!prepared.has(p.look))prepared.set(p.look,await get(p.look));
    return {...p,look:prepared.get(p.look)};
  }
  const clips=[];
  for(const clip of plan.clips){
    if(clip.visuals){const visuals=[];for(const p of clip.visuals)visuals.push(await part(p));clips.push({...clip,visuals});}
    else clips.push(await part(clip));
  }
  const layers=[];
  for(const layer of plan.layers??[])layers.push(await part(layer));
  return {...plan,clips,...(plan.layers&&{layers})};
}

function lookGraph({part, source, index, width, height, fps, duration, graph, addBackground}) {
  const look=part.look;if(!look)return source;
  const chain=['setpts=PTS-STARTPTS'];
  for(const file of [look.externalLut,look.gradeLut])if(file)chain.push('lut3d=file='+file);
  for(const e of look.effects??[]){
    const power=e.strength/100;if(!power)continue;
    const start=e.start-(part.layerStart??0),end=(e.end??86400)-(part.layerStart??0);
    const enable=`:enable='between(t,${start},${end})'`;
    const inverse=`val*(1-${power})+(maxval-val)*${power}`;
    const fx={blur:'gblur=sigma='+Math.max(.05,power*12),sharpen:'unsharp=5:5:'+power*2,grain:'noise=alls='+Math.round(power*35)+':allf=t+u',
      vignette:'vignette=angle='+(.01+power*.9),chromatic:'chromashift=cbh='+Math.ceil(power*10)+':crh=-'+Math.ceil(power*10),negative:`lutrgb=r='${inverse}':g='${inverse}':b='${inverse}'`};
    chain.push(fx[e.kind]+enable);
  }
  const fg=`[fg${index}]`;graph.push(source+chain.join(',')+fg);
  const bg=look.background;if(!bg||bg.kind==='none')return fg;
  const fit=`scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2:reset_sar=1`;
  const fill=`scale=${width}:${height}:force_original_aspect_ratio=increase:force_divisible_by=2:reset_sar=1,crop=${width}:${height}`;
  const output=`[look${index}]`;
  if(bg.kind==='color'){graph.push(fg+fit+`,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=${bg.color}`+output);return output;}
  const back=`[back${index}]`, front=`[front${index}]`;let pic=fg;
  if(bg.kind==='blur'){
    pic=`[srcfg${index}]`;graph.push(fg+`split=2${pic}[srcbg${index}]`);
    graph.push(`[srcbg${index}]${fill},gblur=sigma=${1+bg.strength*.25}${back}`);
  }else if(bg.kind==='media'){
    graph.push(addBackground(look.backgroundAsset)+`setpts=PTS-STARTPTS,fps=${fps},${fill}${back}`);
  }else{
    const style=bg.pattern==='gradient'?`gradients=s=${width}x${height}:r=${fps}:c0=0x23445b:c1=0x673868:speed=0.01`:
     `color=c=${bg.pattern==='dots'?'0x25344b':'0x312a42'}:s=${width}x${height}:r=${fps},drawgrid=w=${bg.pattern==='dots'?16:48}:h=${bg.pattern==='dots'?16:48}:t=1:c=white@0.12`;
    graph.push(style+',trim=duration='+duration+back);
  }
  graph.push(pic+fit+front);graph.push(back+front+'overlay=(W-w)/2:(H-h)/2:shortest=1'+output);
  return output;
}
async function previewLook(ffmpeg,asset,look,catalog,time,ratio,signal,origin=0) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'jj-look-'));const files=[];
  try{
    const [clip]=chooseLooks([{look}],catalog,()=>0,new Map());
    const p=(await prepareLooks({clips:[clip]},dir,files)).clips[0];
    p.layerStart=Math.max(0,time-origin);
    const [rw,rh]=ratio.split(':').map(Number), width=Math.round(480*Math.min(1,rw/rh)/2)*2, height=Math.round(480*Math.min(1,rh/rw)/2)*2;
    const args=['-hide_banner','-loglevel','error','-nostdin','-threads','1','-ss',String(time),'-i',asset.path];
    const graph=[];
    const source=lookGraph({part:p,source:`[0:${asset.videoIndex}]`,index:0,width,height,fps:25,duration:0.2,graph,
      addBackground(bg){args.push('-threads','1','-i',bg.path);return `[1:${bg.videoIndex}]`;}});
    graph.push(source+`scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2[out]`);
    args.push('-filter_complex_threads','1','-filter_complex',graph.join(';'),'-map','[out]','-frames:v','1','-c:v','mjpeg','-threads','1','-f','image2pipe','pipe:1');
    const result=await execFile(ffmpeg,args,{cwd:dir,windowsHide:true,encoding:'buffer',maxBuffer:2*1024*1024,timeout:15000,signal});
    return result.stdout;
  }finally{for(const file of files)await fs.rm(file,{force:true});await fs.rmdir(dir);}
}
module.exports={normalizeLook,inspectLut,chooseLooks,prepareLooks,lookGraph,previewLook};
