'use strict';

const defaults = { x: .5, y: .5, scale: 1, rotation: 0, opacity: 1 };

function expression(layer, key, clock) {
  let from = layer[key] ?? defaults[key];
  let at = 0;
  let result = String(from);
  for (const frame of layer.keyframes ?? []) {
    if (!Object.hasOwn(frame, key)) continue;
    const next = frame[key];
    if (frame.time === 0) result = String(next);
    else if (next !== from) result += `+(${next - from})*clip((${clock}-${at})/${frame.time - at},0,1)`;
    at = frame.time;
    from = next;
  }
  return `(${result})`;
}

function maskAlpha(mask, clock) {
  const property = (key) => expression(mask, key, clock);
  const x = `(X-W*${property('x')})`, y = `(Y-H*${property('y')})`;
  const rotates = mask.rotation || mask.keyframes?.some((frame) => frame.rotation !== undefined);
  const angle = `(${property('rotation')}*PI/180)`;
  const localX = rotates ? `(${x}*cos(${angle})+${y}*sin(${angle}))` : x;
  const localY = rotates ? `(-${x}*sin(${angle})+${y}*cos(${angle}))` : y;
  const dx = `(${localX}/(W*${property('width')}/2))`, dy = `(${localY}/(H*${property('height')}/2))`;
  const distance = mask.shape === 'ellipse' ? `hypot(${dx},${dy})` : `max(abs(${dx}),abs(${dy}))`;
  const feather = property('feather');
  const visible = mask.keyframes?.some((frame) => frame.feather !== undefined)
    ? `if(gt(${feather},0),clip((1-${distance})/${feather},0,1),lte(${distance},1))` :
    mask.feather ? `clip((1-${distance})/${mask.feather},0,1)` : `lte(${distance},1)`;
  return mask.invert ? `(1-${visible})` : visible;
}

function visualMotion({ layer, index, canvas, fps, source, font, filters, video, active }) {
  const [width, height] = canvas;
  const { asset, start, end, mediaStart, tempo } = layer;
  // Crop/priority fitting can enter the middle of an animation. All keyframes
  // belong to the original layer, regardless of its location in a compiled plan.
  const clock = (variable) => `(${variable}*${tempo}+${mediaStart})`;
  const local = clock('t');
  const mainClock = clock(`(t-${start})`);
  const x = expression(layer, 'x', mainClock);
  const y = expression(layer, 'y', mainClock);
  const scale = expression(layer, 'scale', local);
  const rotation = expression(layer, 'rotation', local);
  const animatedOpacity = layer.keyframes?.some((key) => key.opacity !== undefined);
  const maxScale = Math.max(layer.scale, ...(layer.keyframes ?? []).map((point) => point.scale ?? 0));
  const aspect = asset ? asset.height / asset.width : height / width;
  const box = Math.ceil(Math.hypot(width, width * aspect) * maxScale / 2) * 2 + 4;
  const picture = `[motion${index}]`;
  const next = `[layerVideo${index}]`;
  const chain = [];
  if (layer.kind === 'text') {
    const fontSize = Math.max(1, Math.round(layer.fontSize * width / 1080));
    source = `color=c=black@0:s=${width}x${height}:r=${fps}:d=${(end - start).toFixed(6)},format=rgba,`;
    chain.push(`drawtext=${font}:textfile=layer-${index}.txt:expansion=none:fontsize=${fontSize}:fontcolor=${layer.color}:x=(w-text_w)/2:y=(h-text_h)/2`);
  }
  chain.push('settb=AVTB', `setpts=(PTS-STARTPTS)/${asset?.kind === 'video' ? tempo : 1}`, `fps=${fps}`, 'format=rgba');
  if (layer.mask) {
    chain.push(`geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*${maskAlpha(layer.mask, clock('T'))}':interpolation=nearest`);
  }
  chain.push(`scale=w='max(2,2*round(${width}*${scale}/2))':h=-2:eval=frame`, 'setsar=1');
  if (layer.keyframes?.some((key) => key.scale !== undefined)) {
    chain.push(`pad=w=${box}:h=${box}:x=(ow-iw)/2:y=(oh-ih)/2:color=black@0:eval=frame`);
  }
  if (animatedOpacity) {
    const alpha = expression(layer, 'opacity', clock('T'));
    chain.push(`geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*${alpha}':interpolation=nearest`);
  } else if ((layer.opacity ?? 1) < 1) {
    chain.push(`colorchannelmixer=aa=${layer.opacity}`);
  }
  if (layer.rotation || layer.keyframes?.some((key) => key.rotation !== undefined)) {
    chain.push(`rotate=a='${rotation}*PI/180':ow=${box}:oh=${box}:c=black@0`);
  }
  chain.push(`setpts=PTS+${start}/TB`);
  filters.push(`${source}${chain.join(',')}${picture}`);
  filters.push(`${video}${picture}overlay=x='main_w*${x}-overlay_w/2':y='main_h*${y}-overlay_h/2':eval=frame:eof_action=pass:repeatlast=0:${active}${next}`);
  return next;
}

module.exports = { visualMotion };
