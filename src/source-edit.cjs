// @ts-check
'use strict';

const { createHash } = require('node:crypto');
const { createReadStream } = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');

const pending = new Map();
const digests = new Map();
let renderQueue = Promise.resolve();
const { mediaTool } = require('./media-tool.cjs');
const { colorOutput, colorFilters, encoderColor } = require('./media-color.cjs');
const ffmpeg = mediaTool('ffmpeg');

/** @typedef {{start:number,end:number,reverse?:boolean,mirror?:boolean,rotation?:number,crop?:{x:number,y:number,width:number,height:number}}} SourceRange */
/** @param {SourceRange[]} ranges @param {number} duration @returns {SourceRange[]} */
function normalizeSourceEditRanges(ranges, duration) {
  if (!(duration>0)) throw Error('素材时长无效。');
  if (!Array.isArray(ranges) || !ranges.length || ranges.length>2000) throw Error('候选需要有效的裁剪片段。');
  let total = 0;
  const normalized=Array.from(ranges,range => {
    if (!Number.isFinite(range?.start) || !Number.isFinite(range.end) || range.start<0 ||
        range.end>duration+1e-7 || range.end<=range.start) throw Error('剪辑片段超出原素材范围。');
    const out={start:range.start,end:Math.min(range.end,duration)};
    if (out.end<=out.start) throw Error('剪辑片段没有有效时长。');
    total += out.end-out.start;
    if (total>86400) throw Error('素材剪辑不能超过 24 小时。');
    for (const flag of ['reverse','mirror']) {
      if (range[flag]!==undefined && typeof range[flag]!=='boolean') throw Error('片段方向无效。');
      if (range[flag]) out[flag]=true;
    }
    if (range.rotation!==undefined && ![0,90,180,270].includes(range.rotation)) throw Error('片段旋转角度无效。');
    if (range.rotation) out.rotation=range.rotation;
    if (range.crop!==undefined) {
      const {x,y,width,height}=range.crop || {};
      if (![x,y,width,height].every(Number.isFinite) || x<0 || y<0 || width<=0 || height<=0 ||
          x+width>1+1e-8 || y+height>1+1e-8) throw Error('裁剪框超出原画面。');
      if (x || y || width!==1 || height!==1) out.crop={x,y,width,height};
    }
    return out;
  });
  if (total<.1-1e-7) throw Error('素材剪辑至少需要保留 0.1 秒。');
  return normalized;
}

function transform(range,width,height,pixelFormat) {
  const filters=[];
  if (range.crop) {
    const {x,y,width:w,height:h}=range.crop;
    // Snap to even source pixels for 4:2:0 media; tiny valid boxes still select one chroma cell.
    filters.push(`crop=w='max(2,trunc(iw*${w}/2)*2)':h='max(2,trunc(ih*${h}/2)*2)':x='trunc(iw*${x}/2)*2':y='trunc(ih*${y}/2)*2'`);
  }
  if (range.mirror) filters.push('hflip');
  if (range.rotation===90) filters.push('transpose=clock');
  if (range.rotation===180) filters.push('hflip','vflip');
  if (range.rotation===270) filters.push('transpose=cclock');
  filters.push(`scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2:reset_sar=1`,
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black`,'format='+pixelFormat);
  return filters;
}

async function signature(file) {
  const info=await fs.stat(file,{bigint:true});
  return [info.dev,info.ino,info.size,info.mtimeNs,info.ctimeNs].join('.');
}

async function sourceDigest(file,stamp,signal) {
  const key=JSON.stringify([file,stamp]);
  if (digests.has(key)) return digests.get(key);
  const hash=createHash('sha256');
  for await (const data of createReadStream(file,{signal})) hash.update(data);
  if (await signature(file)!==stamp) throw Error('原素材已变更，请重新载入。');
  const digest=hash.digest('hex');
  if (digests.size>=64) digests.delete(digests.keys().next().value);
  digests.set(key,digest);
  return digest;
}

/** @param {Record<string,any>} asset @param {SourceRange[]} ranges @param {string} directory
 * @param {string} sourceSignature @param {{signal?:AbortSignal}} options */
async function render(asset,ranges,directory,sourceSignature,{signal}) {
  const { runTool,inspectAsset } = require('./media.cjs');
  signal?.throwIfAborted();
  const digest=await sourceDigest(asset.path,sourceSignature,signal);
  // The editable master stays HDR. Only its playback proxy follows the display preference.
  const color=await colorOutput([asset],'preserve');
  const pixelFormat=color?.format ?? 'yuv420p';
  const key=createHash('sha256').update(JSON.stringify([color ? 'source-edit-hdr-v4' : 'source-edit-v3',digest,ranges])).digest('hex');
  const final=path.join(directory,key+'.mp4');
  await fs.mkdir(directory,{recursive:true});
  const fps=asset.fps>0 ? Number(asset.fps.toFixed(8)) : 30;
  const width=Math.max(2,2*Math.round(asset.width/2)),height=Math.max(2,2*Math.round(asset.height/2));
  const audio=Number.isInteger(asset.audioIndex);
  const minimumFrames=Math.ceil(.1*fps-1e-8);
  const framesExpected=Math.max(minimumFrames,Math.round(ranges.reduce((t,r)=>t+r.end-r.start,0)*fps));
  async function validate(file) {
    const result=await inspectAsset(file,'video',{signal});
    if (Math.abs(result.duration-framesExpected/fps)>1/fps+.01 || result.width!==width || result.height!==height ||
        Number.isInteger(result.audioIndex)!==audio || (color && (result.hdr!==color.hdr || result.pixelFormat!==pixelFormat))) throw Error('素材剪辑文件不完整，请重试。');
  }
  let cached=false;
  try { await validate(final); cached=true; }
  catch { signal?.throwIfAborted(); }
  if (cached) {
    if (await signature(asset.path)!==sourceSignature) throw Error('原素材已变更，请重新载入。');
    return final;
  }
  const work=await fs.mkdtemp(path.join(directory,'.render-'));
  const common=['-hide_banner','-loglevel','error','-nostdin','-threads','2','-filter_threads','2'];
  async function run(args) {
    const stalled=new AbortController();
    const timer=setTimeout(()=>stalled.abort(Error('应用剪辑长时间没有进展，请检查素材是否可读取后重试。')),120000);
    let lastTime=-1;
    try {
      await runTool(ffmpeg,[...common,'-progress','pipe:1','-nostats',...args],{
        cwd:work, signal:signal ? AbortSignal.any([signal,stalled.signal]) : stalled.signal,
        onProgress(seconds) {
          if (seconds>lastTime) { lastTime=seconds; timer.refresh(); }
        },
      });
    } finally {
      clearTimeout(timer);
    }
  }
  // reverse retains decoded frames. Bound its input by both bytes and duration, even for 4K+ video.
  const bytesPerPixel=color ? 3 : 1.5;
  const maxFrames=Math.max(1,Math.min(Math.ceil(fps*8),Math.floor(160*1024*1024/(width*height*bytesPerPixel))));
  const list=[];
  let totalSeconds=0,totalFrames=0;
  try {
    for (const range of ranges) {
      const span=range.end-range.start;
      totalSeconds+=span;
      const nextFrame=range===ranges.at(-1) ? framesExpected : Math.round(totalSeconds*fps);
      const frames=nextFrame-totalFrames;
      totalFrames=nextFrame;
      const chunkFrames=range.reverse ? maxFrames : Math.max(1,frames);
      const chunks=Math.ceil(frames/chunkFrames);
      for (let j=0;j<chunks;j++) {
        const index=range.reverse ? chunks-1-j : j;
        const first=index*chunkFrames, count=Math.min(chunkFrames,frames-first);
        const start=range.start+span*first/frames, seconds=span*count/frames;
        // If a retained intersection is shorter than one frame, decode the frame covering
        // its in-point, including at end of file. Trim the audio with sample precision.
        const seek=seconds<1/fps ? Math.max(0,Math.min(Math.floor(start*fps)/fps,asset.duration-1/fps)) : start;
        const length=count/fps;
        const videoFilters=['setpts=PTS-STARTPTS',`fps=${fps}:start_time=0`,...colorFilters(asset,color),...transform(range,width,height,pixelFormat),
          `tpad=stop_mode=clone:stop_duration=${length+1/fps}`,`trim=end_frame=${count}`];
        if (range.reverse) videoFilters.push('reverse');
        videoFilters.push('setpts=PTS-STARTPTS');
        const audioFilters=['aresample=48000:async=1:first_pts=0',`atrim=start=${start-seek}:duration=${seconds}`,
          'asetpts=PTS-STARTPTS','apad',`atrim=end_sample=${Math.round(length*48000)}`];
        if (range.reverse) audioFilters.push('areverse');
        audioFilters.push('asetpts=PTS-STARTPTS');
        const part='part-'+list.length+'.mov';
        // Independent audio/video filtergraphs can block each other on one demuxer
        // when trimming a seeked MOV. Schedule both streams in a single graph.
        const streams=audio ? ['-filter_complex_threads','2','-filter_complex',
          `[0:${asset.videoIndex}]${videoFilters.join(',')}[v];[0:${asset.audioIndex}]${audioFilters.join(',')}[a]`,
          '-map','[v]','-map','[a]','-c:a','pcm_s16le'] :
          ['-map','0:'+asset.videoIndex,'-vf',videoFilters.join(','),'-an'];
        await run(['-protocol_whitelist','file,pipe','-format_whitelist','mov,matroska,webm,avi,mpegts,mpeg',
          '-ss',String(seek),'-t',String(start-seek+Math.max(seconds,1.5/fps)),'-i',asset.path,...streams,
          // A one-frame part has no B-frame delay. Use the same zero reordering delay
          // on every part so the concat demuxer cannot overlap their initial DTS.
          '-c:v','libx264','-threads','2','-bf','0','-preset','veryfast','-crf','16',...encoderColor(color),'-map_metadata','-1','-sn','-dn','-n',part]);
        list.push(`file ${part}\nduration ${length.toFixed(9)}`);
      }
    }
    if (!list.length) throw Error('所选片段不足一帧。');
    await fs.writeFile(path.join(work,'parts.txt'),list.join('\n')+'\n');
    // PCM intermediates avoid AAC priming gaps at edits and reverse chunk boundaries.
    await run(['-f','concat','-safe','1','-i','parts.txt','-map','0:v:0','-c:v','copy',
      ...(audio ? ['-map','0:a:0','-c:a','aac','-b:a','192k'] : ['-an']),
      '-movflags','+faststart','-n','edited.mp4']);
    const temp=path.join(work,'edited.mp4');
    await validate(temp);
    if (await signature(asset.path)!==sourceSignature) throw Error('原素材已变更，请重新载入。');
    signal?.throwIfAborted();
    // Concurrent processes can finish the same recipe. Publish only a fully muxed file.
    try { await fs.rename(temp,final); }
    catch (error) {
      await validate(final).catch(()=>{throw error;});
    }
    return final;
  } finally {
    await fs.rm(work,{recursive:true,force:true});
  }
}

/** Renders and atomically caches a validated source edit.
 * @param {Record<string,any>} asset @param {SourceRange[]} ranges @param {string} directory
 * @param {{signal?:AbortSignal}} [options] @returns {Promise<string>} */
async function prepareSourceEdit(asset,ranges,directory,options={}) {
  if (asset?.kind!=='video' || !path.isAbsolute(asset.path)) throw Error('请先选择一段已载入的视频。');
  const normalized=normalizeSourceEditRanges(ranges,asset.duration);
  const stamp=await signature(asset.path);
  const key=JSON.stringify([directory,asset.path,stamp,normalized]);
  let task=pending.get(key);
  if (!task) {
    task=renderQueue.then(()=>render(asset,normalized,directory,stamp,options)).finally(()=>pending.delete(key));
    renderQueue=task.catch(()=>{});
    pending.set(key,task);
  }
  return task;
}

module.exports={normalizeSourceEditRanges,prepareSourceEdit};
