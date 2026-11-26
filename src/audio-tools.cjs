'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { runTool, inspectAsset, recognizeLocalSpeech } = require('./media.cjs');
const { mediaTool } = require('./media-tool.cjs');
const ffmpeg = mediaTool('ffmpeg');
const library = require('./vendor-path.cjs')('vocals');
const common = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y'];
const mediaInput = ['-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mov,matroska,webm,avi,mpegts,mpeg,mp3,wav,aac,flac,ogg'];
const raw = ['-f', 'f32le', '-ar', '44100', '-ac', '2'];
const labels = { extract: '原声', vocals: '人声', bed: '伴奏', trim: '去气口' };
const num = (v) => Number(v.toFixed(6));

function validateAudio(asset) {
  if (!['audio','video'].includes(asset?.kind) || !Number.isInteger(asset.audioIndex) || asset.audioIndex < 0 || !Number.isFinite(asset.duration)) {
    throw new Error('请选择含音轨的视频或音频。');
  }
}
function checked(value, min, max, label) {
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(label + '超出范围。');
  return value;
}
async function detectPauses(asset, { threshold = -35, minimum = 0.3, padding = 0.06, fillers = false } = {}, { signal } = {}) {
  validateAudio(asset);
  checked(threshold, -65, -15, '静音阈值'); checked(minimum, 0.1, 5, '最短停顿'); checked(padding, 0, 0.5, '保留气口');
  const output = await runTool(ffmpeg, [...common, ...mediaInput, '-i', asset.path, '-map', '0:' + asset.audioIndex, '-vn',
    '-af', `asetpts=PTS-STARTPTS,silencedetect=noise=${threshold}dB:d=${minimum},ametadata=mode=print:file=-`, '-f', 'null', '-'], {signal});
  let start = null;
  const pauses = [];
  const add = (end) => {
    if (start === null) return;
    const from = num(start < 0.001 ? 0 : start + padding);
    const until = num(Math.min(asset.duration, end >= asset.duration - 0.001 ? asset.duration : end - padding));
    if (until - from >= 0.02) pauses.push({start: from, end: until});
    start = null;
  };
  for (const [, event, time] of output.matchAll(/^lavfi\.silence_(start|end)=([\d.e+-]+)\r?$/gm)) {
    if (event === 'start') start = Number(time);
    else add(Number(time));
  }
  add(asset.duration);
  if (!fillers) return pauses;
  let transcript;
  try { transcript=await recognizeLocalSpeech(asset,{signal}); }
  catch(error) { if(error.message.includes('没有识别到可用的人声')) return pauses; throw error; }
  return mergeFillers(pauses,transcript.cues,asset.duration);
}
function mergeFillers(pauses,cues,duration) {
  const fillers=[];
  for (const cue of cues) {
    const spoken=cue.text.toLowerCase().replace(/[\s\p{P}]/gu,'');
    if (!/^(?:[嗯呃额唔啊噢哦]+|u+h+|u+m+|e+r+|h+m+)$/.test(spoken)) continue;
    const start=Math.max(0,cue.start/1000),end=Math.min(duration,cue.end/1000);
    if (end>start && end-start<=2.5) fillers.push({start,end,label:'语气词「'+cue.text.trim()+'」'});
  }
  const merged=[];
  for(const interval of [...pauses,...fillers].sort((a,b)=>a.start-b.start)) {
    const last=merged.at(-1);
    if (last && interval.start<=last.end) {last.end=Math.max(last.end,interval.end);if(interval.label)last.label=interval.label;}
    else merged.push({...interval});
  }
  return merged;
}
function retimeCaptions(cues,removed) {
  if (!cues?.length) return undefined;
  const map=(ms)=>Math.max(0,ms-Math.round(removed.reduce((sum,{start,end})=>sum+Math.max(0,Math.min(ms/1000,end)-start),0)*1000));
  return cues.map((cue)=>({...cue,start:map(cue.start),end:map(cue.end)})).filter((cue)=>cue.end>cue.start);
}
function retained(duration, removals) {
  if (!Array.isArray(removals) || !removals.length || removals.length > 2000) throw new Error('请选择 1 至 2000 处需要移除的停顿。');
  const keep = [];
  let cursor = 0;
  for (const {start, end} of [...removals].sort((a,b) => a.start-b.start)) {
    if (![start,end].every(Number.isFinite) || start < cursor || end <= start || end > duration + 0.001) throw new Error('停顿有重叠或起止时间无效。');
    if (start > cursor) keep.push({start:cursor,end:start});
    cursor = end;
  }
  if (cursor < duration) keep.push({start:cursor,end:duration});
  if (keep.reduce((sum, r) => sum + r.end-r.start, 0) < 0.1) throw new Error('处理后至少需要保留 0.1 秒。');
  return keep;
}

async function processAudio(asset, request, directory, {signal} = {}) {
  validateAudio(asset);
  const {mode, intervals, withVideo=false} = request ?? {};
  if (![...Object.keys(labels), 'both'].includes(mode)) throw new Error('未知的音频处理方式。');
  if(typeof withVideo!=='boolean' || (withVideo && (asset.kind!=='video' || !['both','vocals','bed'].includes(mode)))) throw new Error('只有视频的人声分离结果可以替换原音轨。');
  const keep = mode === 'trim' ? retained(asset.duration, intervals) : null;
  await fs.mkdir(directory, {recursive:true});
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'jiajian-audio-'));
  const folder = path.join(directory, randomUUID());
  await fs.mkdir(folder);
  const outputs = [];
  const temporary = [];
  let success = false;
  try {
    const ff = (args) => runTool(ffmpeg, [...common, ...args], {signal, cwd:scratch});
    if (['vocals','bed','both'].includes(mode)) {
      temporary.push('mix.f32','vocals.f32');
      await ff([...mediaInput, '-i', asset.path, '-map', '0:' + asset.audioIndex, '-vn', ...raw, 'mix.f32']);
      await runTool(path.join(library, 'vocals.exe'), [path.join(library,'vocals.onnx'), 'mix.f32', 'vocals.f32'], {signal, cwd:scratch});
    }
    for (const part of mode === 'both' ? ['vocals','bed'] : [mode]) {
      const video = part === 'trim' && asset.kind === 'video';
      const name = path.parse(asset.name).name.replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '_').slice(0,85);
      const dest = path.join(folder, name + ' · ' + labels[part] + (video ? '.mp4' : '.wav'));
      outputs.push(dest);
      if (part === 'extract') await ff([...mediaInput, '-i', asset.path, '-map', '0:' + asset.audioIndex, '-vn', '-c:a', 'pcm_s16le', dest]);
      else if (part === 'vocals') await ff([...raw, '-i', 'vocals.f32', '-c:a', 'pcm_s16le', dest]);
      else if (part === 'bed') await ff([...raw, '-i', 'mix.f32', ...raw, '-i', 'vocals.f32', '-filter_complex', '[1:a]volume=-1[inverse];[0:a][inverse]amix=inputs=2:normalize=0:duration=first', '-c:a', 'pcm_s16le', dest]);
      else {
        const graph = [], tags = [];
        keep.forEach(({start,end}, i) => {
          const segment = 'start=' + num(start) + ':end=' + num(end);
          if (video) graph.push(`[0:${asset.videoIndex}]trim=${segment},setpts=PTS-STARTPTS[v${i}]`);
          graph.push(`[0:${asset.audioIndex}]atrim=${segment},asetpts=PTS-STARTPTS[a${i}]`);
          tags.push((video ? `[v${i}]` : '') + `[a${i}]`);
        });
        graph.push(tags.join('') + `concat=n=${keep.length}:v=${video?1:0}:a=1` + (video?'[video]':'') + '[audio]');
        temporary.push('cut.txt');
        await fs.writeFile(path.join(scratch,'cut.txt'), graph.join(';\n'));
        await ff([...mediaInput, '-i', asset.path, '-filter_complex_threads','2','-filter_complex_script','cut.txt',
          ...(video ? ['-map','[video]','-map','[audio]','-c:v','libx264','-preset','veryfast','-pix_fmt','yuv420p','-threads','2','-c:a','aac','-movflags','+faststart'] : ['-map','[audio]','-c:a','pcm_s16le']), dest]);
      }
      if(withVideo) {
        const movie=path.join(folder,name+' · '+labels[part]+'版.mp4');
        outputs.push(movie);
        const codec=['h264','hevc','av1','mpeg4'].includes(asset.codec) ? ['-c:v','copy'] :
          ['-vf','pad=ceil(iw/2)*2:ceil(ih/2)*2','-c:v','libx264','-threads','2','-pix_fmt','yuv420p','-preset','veryfast'];
        await ff([...mediaInput,'-i',asset.path,'-i',dest,'-map','0:'+asset.videoIndex,'-map','1:a:0',...codec,'-c:a','aac','-movflags','+faststart',movie]);
      }
    }
    const assets = await Promise.all(outputs.map((file) => inspectAsset(file,path.extname(file)==='.mp4'?'video':'audio',{signal})));
    success = true;
    return assets;
  } finally {
    await Promise.all(temporary.map((name)=>fs.rm(path.join(scratch,name),{force:true})));
    await fs.rmdir(scratch);
    if (!success) { await Promise.all(outputs.map((file)=>fs.rm(file,{force:true}))); await fs.rmdir(folder); }
  }
}
module.exports = { detectPauses, processAudio, retained, mergeFillers, retimeCaptions };
