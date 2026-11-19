'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { visualMotion } = require('./layer-motion.cjs');
const { textAppearance } = require('./text-style.cjs');
const { lookGraph } = require('./visual-style.cjs');

async function writeLayerTexts(layers, directory, temporaryFiles) {
  for (const [index, layer] of (layers ?? []).entries()) {
    if (layer.kind !== 'text') continue;
    const file = path.join(directory, `layer-${index}.txt`);
    temporaryFiles.push(file);
    await fs.writeFile(file, layer.text, { encoding: 'utf8', flag: 'wx' });
  }
}

function composeLayers(plan, args, filters, audioTracks, videoOutput, inputCount, { mediaInput, stillInput, audioTempo }) {
  const [width] = plan.size;
  const seconds = (value) => value.toFixed(6);
  for (const [index, layer] of (plan.layers ?? []).entries()) {
    const { kind, asset, start, end, mediaStart, tempo } = layer;
    const font = kind === 'text' ? textAppearance(layer.textStyle, width) : '';
    const active = `enable='gte(t,${seconds(start)})*lt(t,${seconds(end)})'`;
    const next = `[layerVideo${index}]`;
    const motion = layer.keyframes?.length || layer.rotation || layer.mask || (layer.opacity ?? 1) < 1;
    const transform = (source) => visualMotion({ layer, index, canvas: plan.size, fps: plan.fps, source, font, filters, video: videoOutput, active });
    if (kind === 'text') {
      if (motion) {
        videoOutput = transform('');
        continue;
      }
      // A separate UTF-8 file keeps all user text out of FFmpeg's filter syntax.
      const size = Math.max(1, Math.round(layer.fontSize * width / 1080 * layer.scale));
      filters.push(`${videoOutput}drawtext=${font}:textfile=layer-${index}.txt:expansion=none:fontsize=${size}:fontcolor=${layer.color}:x=w*${layer.x}-text_w/2:y=h*${layer.y}-text_h/2:${active}${next}`);
      videoOutput = next;
      continue;
    }
    const length = end - start;
    const input = inputCount++;
    const sourceLength = seconds(length * tempo);
    if (asset.kind === 'image') {
      args.push(...stillInput, '-loop', '1', '-framerate', String(plan.fps), '-threads', '2', '-t', seconds(length), '-i', asset.path);
    } else {
      args.push(...mediaInput, ...(asset.alpha && asset.codec === 'vp9' ? ['-c:v', 'libvpx-vp9'] : []),
        '-threads', '2', '-ss', seconds(mediaStart), '-t', sourceLength, '-i', asset.path);
    }
    let source=`[${input}:${asset.videoIndex}]`;
    if(kind==='pip' && layer.look) {
      const dimension=(n)=>Math.max(2,Math.round(n/2)*2);
      source=lookGraph({part:{look:layer.look,layerStart:mediaStart},source,index:'pip'+index,width:dimension(asset.width||plan.size[0]),height:dimension(asset.height||plan.size[1]),fps:plan.fps,duration:sourceLength,graph:filters,
        addBackground(bg){
          const n=inputCount++;
          args.push(...(bg.kind==='image'?[...stillInput,'-loop','1','-framerate',String(plan.fps)]:[...mediaInput,'-stream_loop','-1']),'-t',sourceLength,'-threads','2','-i',bg.path);
          return `[${n}:${bg.videoIndex}]`;
        }});
    }
    if (kind !== 'sound' && motion) {
      videoOutput = transform(source);
    } else if (kind !== 'sound') {
      const size = Math.max(2, Math.round(width * layer.scale / 2) * 2);
      const visualTempo = asset.kind === 'image' ? 1 : tempo;
      filters.push(`${source}scale=${size}:-2,setsar=1,format=rgba,settb=AVTB,setpts=(PTS-STARTPTS)/${visualTempo}+${seconds(start)}/TB[layerSource${index}]`);
      filters.push(`${videoOutput}[layerSource${index}]overlay=x=main_w*${layer.x}-overlay_w/2:y=main_h*${layer.y}-overlay_h/2:eof_action=pass:repeatlast=0:${active}${next}`);
      videoOutput = next;
    }
    if (layer.volume > 0 && asset.audioIndex != null) {
      const chain = ['asetpts=PTS-STARTPTS', 'aresample=48000', 'aformat=channel_layouts=stereo', ...audioTempo(tempo),
        `atrim=duration=${seconds(length)}`, `volume=${layer.volume / 100}`, `adelay=${Math.round(start * 48000)}S:all=1`];
      filters.push(`[${input}:${asset.audioIndex}]${chain.join(',')}[layerAudio${index}]`);
      audioTracks.push(`[layerAudio${index}]`);
    }
  }
  return { videoOutput, inputCount };
}

module.exports = { composeLayers, writeLayerTexts };
