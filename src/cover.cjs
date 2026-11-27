'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const {colorOutput, colorFilters, encoderColor, setColorTags} = require('./media-color.cjs');

function normalizeCover(value, mapId) {
  if (value === undefined) return undefined;
  if (!value || !['none', 'library', 'first-shot', 'random'].includes(value.mode)
      || !Array.isArray(value.items) || value.items.length > 100) throw new Error('封面设置无效。');
  const items = value.items.map((item) => {
    if (!item || !Number.isFinite(item.time) || item.time < 0) throw new Error('封面取帧时间无效。');
    if (item.title !== undefined && (typeof item.title !== 'string' || item.title.length > 200)) throw new Error('封面标题最多 200 字。');
    if (item.style !== undefined && !['simple','bold','accent'].includes(item.style)) throw new Error('封面文字样式无效。');
    return { id: mapId(item.id), time: item.time, ...(item.title && {title:item.title}), ...(item.style && {style:item.style}) };
  });
  const active = value.active ?? 0;
  if (!Number.isInteger(active) || active < -1 || active >= Math.max(1, items.length)
      || (value.mode === 'library' && !items.length)) throw new Error('请选择有效封面。');
  return { mode:value.mode, active, items };
}

function selectCover(config, catalog, duration, fps, random) {
  if (!config || config.mode === 'none') return null;
  if (config.mode === 'random') {
    const frames = 7 + Math.min(3,Math.floor(random()*4));
    return { mode:config.mode, frames, start:Math.max(0,duration-frames/fps)*random(), shift:random() };
  }
  if (config.mode === 'first-shot') return {mode:'first-shot'};
  const item = config.items[config.active === -1 ? Math.floor(random()*config.items.length) : config.active];
  return {mode:'library', ...item, asset:catalog.get(item.id)};
}

async function publishCover(plan, rendered, directory, files, run, signal) {
  if (!plan.cover) return rendered;
  const output = (name) => { const file = path.join(directory,name); files.push(file); return file; };
  const { cover, size:[w,h], fps } = plan;
  let body = rendered;
  const job = (args) => run(['-hide_banner','-loglevel','error','-nostdin','-n',...args], {signal,cwd:directory});
  if (cover.mode === 'random') {
    body = output('with-intro.mp4');
    const intro = cover.frames/fps;
    const zoom = 1.04;
    const sw = Math.ceil(w*zoom/2)*2, sh = Math.ceil(h*zoom/2)*2;
    const x = Math.round((sw-w)*cover.shift), y = Math.round((sh-h)*(1-cover.shift));
    const bodySamples = Math.round((plan.audioDuration ?? plan.contentDuration) * 48000);
    const color = plan.colorOutput;
    const tags = color ? ',' + setColorTags(color.hdr) : '';
    const filter = `[0:v:0]fps=${fps},tpad=stop_mode=clone:stop=${cover.frames},trim=end_frame=${cover.frames},scale=${sw}:${sh},crop=${w}:${h}:${x}:${y},setsar=1,setpts=PTS-STARTPTS[p];[1:v:0]fps=${fps},setsar=1,setpts=PTS-STARTPTS[b];[p][b]concat=n=2:v=1:a=0${tags}[v];[1:a:0]atrim=end_sample=${bodySamples},adelay=${Math.round(intro*48000)}S:all=1[a]`;
    await job(['-ss',cover.start.toFixed(6),'-t',intro.toFixed(6),'-i',rendered,'-i',rendered,'-filter_complex_threads','2','-filter_complex',filter,
      '-map','[v]','-map','[a]','-c:v','libx264','-threads','2','-preset','veryfast','-crf','18',...encoderColor(color),'-c:a','aac','-ar','48000','-movie_timescale','48000','-t',plan.duration.toFixed(6),body]);
  }
  const image = output('selected-cover.jpg');
  const source = cover.asset;
  const input = source && source.kind === 'video' ? ['-ss',Math.max(0,Math.min(cover.time,source.duration - 1/(source.fps || fps))).toFixed(6)] : [];
  const imageAsset = source ?? {hdr:plan.colorOutput?.hdr};
  const jpegColor = await colorOutput([imageAsset], 'sdr');
  const filters = [...(jpegColor?.zscale ? colorFilters(imageAsset, jpegColor) : []),
    `scale=${w}:${h}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1`];
  if (cover.title) {
    await fs.writeFile(output('cover-title.txt'), cover.title, {encoding:'utf8',flag:'wx'});
    const font = process.platform === 'win32' ? "font='Microsoft YaHei':" : '';
    const color = cover.style === 'accent' ? '0xffdf71' : 'white';
    const size = Math.max(18,Math.round(w*(cover.style === 'bold' ? .079 : .057)));
    filters.push(`drawtext=${font}textfile=cover-title.txt:expansion=none:fontsize=${size}:fontcolor=${color}:borderw=${cover.style === 'bold' ? 4 : 2}:bordercolor=black@0.85:x=(w-text_w)/2:y=(h-text_h)*0.75`);
  }
  await job([...input,'-i',source?.path ?? body,'-map',source ? `0:${source.videoIndex ?? 0}` : '0:v:0','-vf',filters.join(','),
    '-frames:v','1','-c:v','mjpeg','-q:v','2','-threads','1','-update','1',image]);
  const complete = output('with-cover.mp4');
  await job(['-i',body,'-i',image,'-map','0:v:0','-map','0:a:0','-map','1:v:0','-c','copy',
    '-disposition:v:1','attached_pic','-metadata:s:v:1','title=Cover','-movie_timescale','48000','-movflags','+faststart',complete]);
  return complete;
}

module.exports = { normalizeCover, selectCover, publishCover };
