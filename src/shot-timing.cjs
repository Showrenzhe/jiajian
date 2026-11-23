'use strict';

const minimum = 0.1;

function normalizeShotSettings(rows, length) {
  if (rows === undefined) return undefined;
  if (!Array.isArray(rows) || rows.length !== length) throw new Error('分镜属性数量与分镜不匹配。');
  return Array.from(rows, (row) => {
    if (row === null) return null;
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('分镜属性无效。');
    const result = {};
    for (const [key, limit] of [['name', 120], ['description', 2000]]) {
      if (row[key] === undefined) continue;
      if (typeof row[key] !== 'string' || row[key].length > limit) throw new Error('分镜名称或说明过长。');
      result[key] = row[key];
    }
    if (row.duration != null) {
      if (!Number.isFinite(row.duration) || row.duration < minimum || row.duration > 86400) throw new Error('分镜时长应为 0.1 秒至 24 小时。');
      result.duration = row.duration;
    }
    if (row.smartTrim !== undefined) {
      if (typeof row.smartTrim !== 'boolean') throw new Error('分镜智能截取设置无效。');
      result.smartTrim = row.smartTrim;
    }
    return result;
  });
}

function normalizeRanges(ranges, start, end) {
  if (!Array.isArray(ranges) || !ranges.length || ranges.length > 2000) throw new Error('候选需要有效的裁剪片段。');
  return Array.from(ranges, (range) => {
    if (!Number.isFinite(range?.start) || !Number.isFinite(range.end) || range.start < start - 1e-7
        || range.end > end + 1e-7 || range.end - range.start < minimum - 1e-7) throw new Error('裁剪片段超出素材范围或短于 0.1 秒。');
    return { start: range.start, end: range.end };
  });
}

function audioSpeed(value) {
  if (!Number.isFinite(value) || value < .5 || value > 3) throw new Error('音频倍速应为 0.5 到 3 倍。');
  return value;
}

function normalizeMusicSpeeds(values, count) {
  if (!Array.isArray(values) || values.length !== count) throw new Error('配乐倍速数量与素材不符。');
  return Array.from(values, audioSpeed);
}

function normalizeSegmentVoiceCuts(cuts, ids, catalog) {
  if (cuts === undefined) return undefined;
  if (!Array.isArray(cuts) || !Array.isArray(ids) || cuts.length !== ids.length) throw new Error('口播裁剪轨道与分镜不匹配。');
  return Array.from(cuts, (row, i) => {
    if (!Array.isArray(row) || row.length !== ids[i]?.length) throw new Error('口播裁剪与音轨数量不匹配。');
    return Array.from(row, (cut, k) => {
      if (cut === null) return null;
      const id = ids[i][k];
      if (!id || !cut || (cut.ranges === undefined && cut.speed === undefined)) throw new Error('口播裁剪缺少原始音频。');
      if (cut.offset !== undefined && (!Number.isFinite(cut.offset) || cut.offset < 0 || cut.offset > 86400)) throw new Error('口播起点无效。');
      return { ...(cut.ranges !== undefined && {ranges: normalizeRanges(cut.ranges, 0, catalog ? catalog.get(id)?.duration ?? 0 : Infinity)}),
        ...(cut.speed !== undefined && {speed: audioSpeed(cut.speed)}),
        ...(cut.offset !== undefined && { offset: cut.offset }) };
    });
  });
}

function normalizeVolumeOverrides(rows, record, shots) {
  if(!Array.isArray(rows)||rows.length>10000)throw new Error('音轨音量列表无效。');
  const seen=new Set();
  return rows.map(row=>{
    const {kind,shot,track,value}=row??{};
    if(!['music','whole','segment'].includes(kind)||!Number.isFinite(value)||value<0||value>100)throw new Error('音轨音量无效。');
    const id=record(row.id,'audio');
    if(kind!=='music'&&(!Number.isInteger(track)||track<0||track>=250))throw new Error('口播音轨无效。');
    if(kind==='segment'&&(!Number.isInteger(shot)||shot<0||shot>=shots))throw new Error('口播所属分镜无效。');
    const key=JSON.stringify([kind,kind==='segment'?shot:null,kind==='music'?null:track,id]);
    if(seen.has(key))throw new Error('音轨音量重复。');seen.add(key);
    return {kind,id,...(kind!=='music'&&{track}),...(kind==='segment'&&{shot}),value};
  });
}
function normalizeSceneCuts(rows, record) {
  if (!Array.isArray(rows) || rows.length > 1000) throw new Error('AI 拆分轨道列表无效。');
  const seen = new Set();
  return Array.from(rows, (row) => {
    if (!row || !Array.isArray(row.points) || row.points.length > 2000 || !Array.isArray(row.used) || row.used.length > 2001) throw new Error('AI 拆分轨道无效。');
    const assetId = record(row.assetId, 'visual');
    if (seen.has(assetId)) throw new Error('同一素材有重复拆分轨道。');
    seen.add(assetId);
    const points = Array.from(row.points);
    if (points.some((t, i) => !Number.isFinite(t) || t <= (points[i - 1] ?? 0))) throw new Error('AI 拆分点必须按时间递增。');
    function readRange(range) {
      if (!Number.isFinite(range?.start) || !Number.isFinite(range.end) || range.start < 0 || range.end <= range.start) throw new Error('已使用的拆分片段无效。');
      return { start: range.start, end: range.end };
    }
    if (row.hidden !== undefined && (!Array.isArray(row.hidden) || row.hidden.length > 2001)) throw new Error('隐藏拆分片段列表无效。');
    return { assetId, points, used: row.used.map(readRange), ...(row.hidden && { hidden: row.hidden.map(readRange) }) };
  });
}

// Work in source seconds across the sequence of retained pieces, including reordered ranges.
function sliceSource(ranges, offset, length) {
  const result = [];
  let remaining = length;
  for (const { start, end } of ranges) {
    const span = end - start;
    if (offset >= span) { offset -= span; continue; }
    const begin = start + offset;
    const take = Math.min(end - begin, remaining);
    if (take > 1e-9) result.push({ start: begin, end: begin + take });
    remaining -= take;
    if (remaining <= 1e-9) break;
    offset = 0;
  }
  return result;
}

module.exports = { audioSpeed, normalizeMusicSpeeds, normalizeShotSettings, normalizeRanges, normalizeSegmentVoiceCuts, normalizeSceneCuts, normalizeVolumeOverrides, sliceSource };
