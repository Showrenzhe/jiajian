'use strict';

// Each source interval contributes in proportion to its time on screen.
// A reordered clip retains its identity; a mirrored picture uses a separate identity.
function visualProfile(plan, ids) {
  const bySource = new Map();
  let total = 0;
  for (const clip of plan.clips) {
    if (plan.cover?.mode === 'first-shot' && clip.shotIndex === 0) continue;
    for (const visual of clip.visuals ?? [clip]) {
      const key = JSON.stringify([ids.get(visual.asset) ?? visual.asset.path ?? visual.asset.name, Boolean(visual.mirror)]);
      const weight = visual.outputFrames ?? Math.round(visual.duration * (visual.repeat ?? 1) * plan.fps);
      if (!weight) continue;
      const still = visual.asset.kind === 'image';
      const start = still ? 0 : Math.round(visual.start * 1000);
      const end = still ? 1 : start + Math.max(1, Math.round((visual.sourceDuration ?? visual.duration * (visual.speed ?? 1)) * 1000));
      const rate = weight / (end - start);
      if (!bySource.has(key)) bySource.set(key, new Map());
      const points = bySource.get(key);
      points.set(start, (points.get(start) ?? 0) + rate);
      points.set(end, (points.get(end) ?? 0) - rate);
      total += weight;
    }
  }
  const spans = new Map();
  for (const [key, events] of bySource) {
    const result = [];
    let before = 0, rate = 0;
    for (const [point, delta] of [...events].sort((a, b) => a[0] - b[0])) {
      if (point > before && rate > 1e-9) result.push([before, point, rate]);
      rate += delta;
      before = point;
    }
    spans.set(key, result);
  }
  return { spans, total };
}

function overlap(a, b) {
  let value = 0, i = 0, j = 0;
  while (i < a.length && j < b.length) {
    const left = a[i], right = b[j];
    const length = Math.min(left[1], right[1]) - Math.max(left[0], right[0]);
    if (length > 0) value += length * Math.min(left[2], right[2]);
    if (left[1] <= right[1]) i++;
    if (right[1] <= left[1]) j++;
  }
  return value;
}

function measureBatchReuse(plans, catalog) {
  const ids = new Map([...catalog].map(([id, asset]) => [asset, asset.path ?? id]));
  const sourceIndex = new Map();
  const weights = [];
  return plans.map((plan, index) => {
    const { spans, total } = visualProfile(plan, ids);
    const matches = new Map();
    for (const [source, intervals] of spans) {
      const past = sourceIndex.get(source) ?? [];
      for (const item of past) {
        const shared = overlap(item.intervals, intervals);
        if (shared) matches.set(item.index, (matches.get(item.index) ?? 0) + shared);
      }
      past.push({ index, intervals });
      sourceIndex.set(source, past);
    }
    let best = 0, peer = null;
    for (const [other, shared] of matches) {
      const fraction = shared / Math.max(total, weights[other]);
      if (fraction > best) { best = fraction; peer = other; }
    }
    weights.push(total);
    const same = best >= 1 - 1e-8;
    return { percent: same ? 100 : Math.min(99, Math.max(best > 0 ? 1 : 0, Math.round(best * 100))),
      kind: same ? 'same' : best > 0 ? 'partial' : 'none', peer };
  });
}

module.exports = { measureBatchReuse };
