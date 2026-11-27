'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { mediaTool } = require('./media-tool.cjs');

const hdrTransfers = new Set(['arib-std-b67', 'smpte2084']);
let capability;
function supportsHdrToneMap() {
  capability ??= promisify(execFile)(mediaTool('ffmpeg'), ['-hide_banner', '-filters'], {
    timeout: 5000, windowsHide: true, maxBuffer: 512 * 1024,
  }).then(({stdout}) => ['tonemap', 'zscale'].every(name => new RegExp('^\\s*\\S+\\s+' + name + '\\s+V->V', 'm').test(stdout)), () => false);
  return capability;
}

async function colorOutput(assets, mode) {
  const first = assets.find(asset => hdrTransfers.has(asset?.hdr));
  if (!first) return null;
  const zscale = await supportsHdrToneMap();
  // An MP4 has one output transfer. Mixed shots share the first HDR picture's
  // transfer in preserve mode. Convert each source before it enters the graph.
  const hdr = mode === 'preserve' || !zscale ? first.hdr : null;
  return { hdr, zscale, format: hdr ? 'yuv420p10le' : 'yuv420p' };
}

function colorTags(hdr) {
  return hdrTransfers.has(hdr)
    ? { transfer: hdr, matrix: 'bt2020nc', primaries: 'bt2020' }
    : { transfer: 'bt709', matrix: 'bt709', primaries: 'bt709' };
}

function setColorTags(hdr) {
  const { transfer, matrix, primaries } = colorTags(hdr);
  return `setparams=range=limited:color_primaries=${primaries}:color_trc=${transfer}:colorspace=${matrix}`;
}

function encoderColor(output) {
  if (!output) return [];
  const { transfer, matrix, primaries } = colorTags(output.hdr);
  return ['-colorspace', matrix, '-color_primaries', primaries, '-color_trc', transfer, '-color_range', 'tv'];
}

function colorFilters(asset, output) {
  if (!output) return [];
  const hdr = hdrTransfers.has(asset?.hdr) ? asset.hdr : null;
  const source = colorTags(hdr), target = colorTags(output.hdr);
  // Only known FFprobe enums enter a filter, including when metadata is absent.
  const transfer = !hdr && ['bt709','smpte170m','iec61966-2-1','bt2020-10','bt2020-12'].includes(asset?.colorTransfer)
    ? asset.colorTransfer : source.transfer;
  const primaries = ['bt709','bt470bg','smpte170m','smpte432','bt2020'].includes(asset?.colorPrimaries)
    ? asset.colorPrimaries : source.primaries;
  const matrix = ['bt709','bt470bg','smpte170m','bt2020nc'].includes(asset?.colorSpace)
    ? asset.colorSpace : source.matrix;
  const format = asset?.alpha ? (output.hdr ? 'yuva420p10le' : 'yuva420p') : output.format;
  const chain = [];
  // Specify the matrix when converting an RGB still to YUV before zscale.
  if (!hdr && (!asset?.colorSpace || asset.colorSpace === 'gbr')) {
    chain.push('scale=out_color_matrix=bt709', 'format=' + (asset?.alpha ? 'yuva444p' : 'yuv444p'));
  }
  if (hdr && !output.hdr) {
    chain.push(`zscale=pin=${primaries}:min=${matrix}:tin=${hdr}:t=linear:npl=100`, 'format=gbrpf32le',
      'zscale=p=bt709', 'tonemap=tonemap=mobius:desat=0', 'zscale=t=bt709:m=bt709:r=limited');
  } else if (transfer !== target.transfer || primaries !== target.primaries || matrix !== target.matrix || asset?.fullRange) {
    if (output.zscale) {
      chain.push(`zscale=pin=${primaries}:min=${matrix}:tin=${transfer}:p=${target.primaries}:m=${target.matrix}:t=${target.transfer}:r=limited:npl=100`);
    } else {
      // libswscale is part of the bundled FFmpeg 8 and also works without libzimg.
      const swMatrix = value => value === 'bt2020nc' ? 'bt2020' : value === 'bt470bg' ? 'bt601' : value;
      chain.push(`scale=in_color_matrix=${swMatrix(matrix)}:out_color_matrix=${swMatrix(target.matrix)}:in_primaries=${primaries}:out_primaries=${target.primaries}:in_transfer=${transfer}:out_transfer=${target.transfer}:out_range=limited`);
    }
  }
  return [...chain, 'format=' + format, setColorTags(output.hdr)];
}

function planAssets(plan) {
  const assets = [];
  for (const clip of plan.clips) {
    for (const part of clip.visuals ?? [clip]) assets.push(part.asset, part.look?.backgroundAsset);
  }
  for (const layer of plan.layers ?? []) {
    if (layer.kind !== 'sound') assets.push(layer.asset, layer.look?.backgroundAsset);
  }
  return assets;
}

function normalizedInput(asset, index, output, graph) {
  const source = `[${index}:${asset.videoIndex}]`;
  if (!output) return source;
  const target = `[normalized${index}]`;
  graph.push(source + colorFilters(asset, output).join(',') + target);
  return target;
}

module.exports = { hdrTransfers, supportsHdrToneMap, colorOutput, colorFilters, encoderColor, setColorTags, planAssets, normalizedInput };
