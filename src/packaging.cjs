'use strict';

const { sliceSource } = require('./shot-timing.cjs');
const { normalizeTextStyle } = require('./text-style.cjs');
const { normalizeLook } = require('./visual-style.cjs');
const { pictureSpan } = require('./ui/track-tools.js');
const { visitVisualIntervals } = require('./ui/voice-alignment.js');

const limits = { pip: 3, text: 3, sticker: 2, sound: 2 };
const motionBounds = { x: [0, 1], y: [0, 1], scale: [.05, 1], rotation: [-3600, 3600], opacity: [0, 1] };
const maskBounds = { x: [0, 1], y: [0, 1], width: [.01, 1], height: [.01, 1], feather: [0, 1], rotation: [-3600, 3600] };

function list(value, maximum, label) {
  if (!Array.isArray(value) || value.length > maximum) throw new Error(label + '数量无效。');
  return value;
}

function number(value, min, max, label) {
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(label + '超出有效范围。');
  return value;
}

function normalizeKeyframes(value, bounds) {
  const frames = Array.from(list(value, 250, '关键帧'), (point) => {
    const frame = { time: number(point?.time, 0, Number.MAX_SAFE_INTEGER, '关键帧时间') };
    for (const [key, range] of Object.entries(bounds)) {
      if (Object.hasOwn(point, key)) frame[key] = number(point[key], ...range, '关键帧属性');
    }
    if (Object.keys(frame).length === 1) throw new Error('关键帧缺少变换属性。');
    return frame;
  }).sort((first, second) => first.time - second.time);
  if (frames.some((frame, index) => index > 0 && frame.time === frames[index - 1].time)) throw new Error('同一图层的关键帧时间不能重复。');
  return frames;
}

function normalizeTransform(item, { defaultScale = 1, maxScale = 4 } = {}) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('画面变换参数无效。');
  const bounds = { ...motionBounds, scale: [.05, maxScale] };
  const transform = { x: number(item.x ?? .5, 0, 1, '画面横坐标'), y: number(item.y ?? .5, 0, 1, '画面纵坐标'),
    scale: number(item.scale ?? defaultScale, .05, maxScale, '画面缩放') };
  for (const key of ['rotation', 'opacity']) {
    if (item[key] !== undefined) transform[key] = number(item[key], ...bounds[key], '画面变换');
  }
  if (item.keyframes !== undefined) transform.keyframes = normalizeKeyframes(item.keyframes, bounds);
  if (item.mask != null) {
    const mask = item.mask;
    if (!['ellipse', 'rectangle'].includes(mask.shape) || (mask.invert !== undefined && typeof mask.invert !== 'boolean')) throw new Error('蒙版类型或反转设置无效。');
    transform.mask = { shape: mask.shape, x: number(mask.x ?? .5, 0, 1, '蒙版横坐标'), y: number(mask.y ?? .5, 0, 1, '蒙版纵坐标'),
      width: number(mask.width ?? .7, .01, 1, '蒙版宽度'), height: number(mask.height ?? .7, .01, 1, '蒙版高度'),
      feather: number(mask.feather ?? 0, 0, 1, '蒙版羽化'), invert: mask.invert ?? false };
    if (mask.rotation !== undefined) transform.mask.rotation = number(mask.rotation, ...maskBounds.rotation, '蒙版旋转');
    if (mask.keyframes !== undefined) transform.mask.keyframes = normalizeKeyframes(mask.keyframes, maskBounds);
  }
  return transform;
}

function normalizeLayers(value, mapId, allowed) {
  return Array.from(list(value, 1000, '图层'), (item) => {
    if (!item || !Object.hasOwn(limits, item.kind) || (allowed && !allowed.includes(item.kind))) throw new Error('此轨道不支持该图层类型。');
    const kind = item.kind;
    const start = number(item.start ?? 0, 0, Number.MAX_SAFE_INTEGER, '图层入点');
    const end = item.end == null ? null : number(item.end, 0, Number.MAX_SAFE_INTEGER, '图层出点');
    if (end !== null && end <= start) throw new Error('图层出点须晚于入点。');
    const layer = { kind, start, end };
    if(kind==='sound' && item.speed!==undefined) layer.speed=number(item.speed,.5,3,'音效倍速');
    if(item.mediaOffset!==undefined) layer.mediaOffset=number(item.mediaOffset,0,Number.MAX_SAFE_INTEGER,'素材起点');
    if(item.laneId!==undefined) {
      if(typeof item.laneId!=='string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(item.laneId)) throw new Error('包装轨道编号无效。');
      layer.laneId=item.laneId;
    }
    if (kind === 'text') {
      if (typeof item.text !== 'string' || item.text.length > 4096 || !item.text.trim() || item.text.includes('\0')) throw new Error('请输入 1 至 4096 字的图层文字。');
      layer.text = item.text.toWellFormed().replace(/\r\n?/g, '\n');
      layer.fontSize = number(item.fontSize ?? 48, 1, 600, '文字字号');
      layer.color = item.color ?? '#ffffff';
      if (item.textStyle !== undefined) layer.textStyle = normalizeTextStyle(item.textStyle);
      if (!/^#[\da-f]{6}$/i.test(layer.color)) throw new Error('文字颜色须为 #RRGGBB。');
    } else {
      if (typeof item.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(item.id)) throw new Error('图层缺少有效的媒体编号。');
      layer.id = mapId(item.id, kind);
    }
    if (kind !== 'sound') {
      Object.assign(layer, normalizeTransform(item, { defaultScale: kind === 'text' ? 1 : .35, maxScale: 1 }));
    }
    if (kind === 'pip' && item.look !== undefined) layer.look = normalizeLook(item.look,(id,role)=>mapId(id,role==='lut'?'lut':'pip'));
    if (kind === 'sound' || kind === 'pip') layer.volume = number(item.volume ?? (kind === 'sound' ? 100 : 0), 0, 100, '图层音量');
    return layer;
  });
}

function normalizePackaging(value, mapId, shotCount) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('工程包装轨道无效。');
  const textMode = value.textMode ?? 'whole';
  const textSelection = value.textSelection ?? 'ordered';
  if (!['whole', 'segmented'].includes(textMode) || !['ordered', 'random'].includes(textSelection)) throw new Error('文字组匹配模式无效。');
  const layers = (items, allowed) => normalizeLayers(items, mapId, allowed);
  function composite(items) {
    const group = layers(items);
    for (const [kind, maximum] of Object.entries(limits)) {
      const boundaries = group.filter((item) => item.kind === kind)
        .flatMap((item) => [[item.start, 1], ...(item.end === null ? [] : [[item.end, -1]])])
        .sort(([a, signA], [b, signB]) => a - b || signA - signB);
      let active = 0;
      for (const [, change] of boundaries) {
        active += change;
        if (active > maximum) throw new Error(`同一复合组同时最多显示 ${maximum} 条${{ text: '文字', pip: '画中画', sound: '音效', sticker: '贴纸' }[kind]}轨道。`);
      }
    }
    return group;
  }
  return {
    global: layers(value.global ?? []),
    composites: Array.from(list(value.composites ?? [], 50, '复合组'), composite),
    textMode, textSelection,
    textGroups: Array.from(list(value.textGroups ?? [], 250, '文字组轨道'), (row) =>
      Array.from(list(row, Math.max(1, shotCount), '文字组分镜'), (items) => layers(items, ['text']))),
    wholeNarration: Array.from(list(value.wholeNarration ?? [], 250, '整段口播'), (items) => layers(items)),
    segmentNarration: Array.from(list(value.segmentNarration ?? [], shotCount, '分段口播分镜'), (row) =>
      Array.from(list(row, 250, '分段口播轨道'), (items) => layers(items))),
  };
}

function packagingChoices(pack, shotCount) {
  const groups = [];
  const choices = (indices) => {
    const at = groups.length;
    if (indices.length > 1) groups.push(indices);
    return (draws) => indices[indices.length > 1 ? draws[at] : 0];
  };
  const nonempty = (rows, match) => rows.flatMap((row, index) => match(row) ? [index] : []);
  const compositeIndex = choices(nonempty(pack.composites, (row) => row.length));
  const perShot = pack.textMode === 'segmented' && pack.textSelection === 'random';
  const textIndices = Array.from({ length: perShot ? shotCount : 1 }, (_, shot) => choices(nonempty(pack.textGroups, (row) =>
    pack.textMode === 'whole' || perShot ? row[shot]?.length : row.some((items) => items.length))));
  return {
    groups,
    select(draws) {
      return { composite: compositeIndex(draws), textRows: textIndices.map((select) => select(draws)) };
    },
  };
}

function scheduleLayers({ pack, selection, catalog, clips, duration, wholeIndex, narration, voiceStart=0, narrationSpeed=1 }) {
  const result = [];
  // Each owner has its own clock. Seek and tempo convert an owner's source range into final output seconds.
  function add(items, offset, span, seek = 0, tempo = 1) {
    for (const layer of items ?? []) {
      const asset = layer.id ? catalog.get(layer.id) : null;
      const speed = layer.speed ?? 1;
      const mediaLength = asset && asset.kind !== 'image' ? (asset.duration-(layer.mediaOffset ?? 0))/speed : Infinity;
      const sourceStart = Math.max(layer.start, seek);
      const sourceEnd = Math.min(layer.end ?? Infinity, layer.start + mediaLength, seek + span * tempo);
      const start = offset + (sourceStart - seek) / tempo;
      const end = Math.min(duration, offset + (sourceEnd - seek) / tempo);
      if (end <= start || !Number.isFinite(end)) continue;
      result.push({ ...layer, start, end, mediaStart: (sourceStart - layer.start)*speed+(layer.mediaOffset ?? 0), tempo: tempo*speed, ...(asset && { asset }) });
    }
  }
  let pictureTime = 0;
  let speechTime = 0;
  for (const clip of clips) {
    let visualTime = clip.videoStart ?? pictureTime;
    const span = clip.outputDuration ?? clip.duration;
    const pictureEnd = visualTime + pictureSpan(clip,span);
    for (const part of clip.visuals ?? [clip]) {
      if (visualTime >= pictureEnd) break;
      if (part.speedOverflow || part.holdLast) {
        const span=Math.min(part.outputDuration ?? part.duration,pictureEnd-visualTime);
        if(part.layers?.length) visitVisualIntervals(part,span,(source,elapsed,length,rate)=>{
          add(source.layers,visualTime+elapsed,length,source.layerStart ?? 0,rate);
        });
        visualTime+=span;
        continue;
      }
      const count = part.repeat ?? 1;
      const length = (part.outputDuration ?? part.duration) / count;
      if (part.layers?.length) {
        const tempo = part.speed ?? 1;
        for (let index = 0; index < count; index++) {
          const start = visualTime + index * length;
          if (start >= pictureEnd) break;
          const sourceSpan=clip.videoFit==='hold' ? (part.sourceDuration ?? part.duration)/tempo : Infinity;
          add(part.layers, start, Math.min(sourceSpan,length,pictureEnd-start), part.layerStart ?? 0, tempo);
        }
      }
      visualTime += count * length;
    }
    if (pack.textMode === 'segmented') {
      const row = selection.textRows.length === 1 ? selection.textRows[0] : selection.textRows[clip.shotIndex];
      add(pack.textGroups[row]?.[clip.shotIndex], pictureTime, span);
    }
    if (clip.narration) {
      const items = pack.segmentNarration[clip.shotIndex]?.[clip.narrationRow];
      const keep = clip.narrationRanges ?? [{ start: 0, end: clip.narration.duration }];
      const delay = clip.voiceOffset ?? 0;
      let offset = speechTime + delay;
      const speed = clip.narrationSpeed ?? 1;
      for (const range of sliceSource(keep, (clip.narrationStart ?? 0)*speed, Math.max(0, (clip.timelineDuration ?? span) - delay)*speed)) {
        const length = (range.end - range.start)/speed;
        add(items, offset, length, range.start, speed);
        offset += length;
      }
    }
    pictureTime += span;
    speechTime += clip.timelineDuration ?? span;
  }
  if (narration) add(pack.wholeNarration[wholeIndex], voiceStart, Math.min(duration-voiceStart, narration.duration/narrationSpeed), 0, narrationSpeed);
  add(pack.composites[selection.composite], 0, duration);
  if (pack.textMode === 'whole') add(pack.textGroups[selection.textRows[0]]?.[0], 0, duration);
  add(pack.global, 0, duration);
  return result;
}

module.exports = { normalizeLayers, normalizeTransform, normalizePackaging, packagingChoices, scheduleLayers };
