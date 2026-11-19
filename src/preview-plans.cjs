'use strict';

const { randomUUID } = require('node:crypto');
const { planMontage, analyzeNarrationSilence } = require('./media.cjs');

async function prepareMontagePlans(config, catalog, { signal, random = Math.random } = {}) {
  signal?.throwIfAborted();
  if (config?.priority !== 'voice' || config.narrationMode !== 'segmented') return planMontage(config, catalog, random);

  const draws = [];
  const plans = planMontage(config, catalog, () => {
    const value = random();
    draws.push(value);
    return value;
  });
  const adjacentVoices = new Set();
  for (const { clips } of plans) {
    for (let index = 1; index < clips.length; index += 1) {
      const before = clips[index - 1].narration;
      const after = clips[index].narration;
      if (before && after) {
        adjacentVoices.add(before);
        adjacentVoices.add(after);
      }
    }
  }
  const voices = [...adjacentVoices];
  const measured = new Map();
  for (let index = 0; index < voices.length; index += 4) {
    const group = voices.slice(index, index + 4);
    const results = await Promise.allSettled(group.map((asset) => analyzeNarrationSilence(asset, { signal })));
    signal?.throwIfAborted();
    for (const [position, result] of results.entries()) {
      const asset = group[position];
      if (result.status === 'rejected') throw new Error(`无法检查口播「${asset.name}」的接缝，请确认音频可以正常读取。`, { cause: result.reason });
      const edgeSilence = result.value;
      if (edgeSilence.leading || edgeSilence.trailing) measured.set(asset, edgeSilence);
    }
  }
  signal?.throwIfAborted();
  if (!measured.size) return plans;

  const enriched = new Map([...catalog].map(([id, asset]) => [id, measured.has(asset)
    ? { ...asset, edgeSilence: measured.get(asset) } : asset]));
  // Reuse the original draws so shortening a seam cannot change the selected combination or order.
  let cursor = 0;
  return planMontage(config, enriched, () => draws[cursor++]);
}

function describeClip({ asset, mirror, narration, visuals }) {
  const description = { name: asset.name, mirror: Boolean(mirror), ...(narration && { narration: narration.name }) };
  if (visuals?.length > 1 || visuals?.[0]?.repeat > 1) {
    description.visuals = visuals.map(({ asset: source, mirror: mirrored, repeat }) => ({
      name: source.name, mirror: Boolean(mirrored), ...(repeat > 1 && { repeat }),
    }));
  }
  return description;
}

function createPreviewBatch(config, catalog, plans = planMontage(config, catalog)) {
  const id = randomUUID();
  return {
    id,
    config: JSON.stringify(config),
    plans,
    entries: plans.map((plan, index) => ({
      index,
      duration: plan.duration,
      clips: plan.clips.map(describeClip),
      music: plan.music?.name ?? null,
      narration: plan.narration?.name ?? null,
      subtitles: plan.subtitles?.name ?? null,
      wholeTrack: plan.wholeTrack,
    })),
  };
}

function selectPreviewPlans(batch, config, selection) {
  if (!batch || selection?.id !== batch.id || JSON.stringify(config) !== batch.config) {
    throw new Error('混剪设置已变化，请重新生成预览组合。');
  }
  const { indices } = selection;
  if (!Array.isArray(indices) || indices.length === 0 || indices.length > batch.plans.length
    || new Set(indices).size !== indices.length
    || indices.some((index) => !Number.isInteger(index) || index < 0 || index >= batch.plans.length)) {
    throw new Error('请选择有效的成片组合。');
  }
  return indices.map((index) => batch.plans[index]);
}

module.exports = { createPreviewBatch, selectPreviewPlans, prepareMontagePlans };
