'use strict';

const { randomUUID } = require('node:crypto');
const {speedPlanningErrors} = require('./ui/messages-zh-cn.js');
const { estimatedBytes } = require('./export-preflight.cjs');
const { planMontage, analyzeNarrationSilence } = require('./media.cjs');
const { measureBatchReuse } = require('./visual-similarity.cjs');
const { normalizeSubprojects, resolveSubprojectShots,projectVoiceConfig } = require('./subprojects.cjs');

async function prepareMontagePlans(config, catalog, { signal, random = Math.random, batchLimit, silenceCache } = {}) {
  signal?.throwIfAborted();
  if (config?.priority !== 'voice' || config.narrationMode !== 'segmented' || config.voiceAlignment === 'reference') return planMontage(config, catalog, random, batchLimit);

  const draws = [];
  const plans = planMontage(config, catalog, () => {
    const value = random();
    draws.push(value);
    return value;
  }, batchLimit);
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
    const results = await Promise.allSettled(group.map((asset) => silenceCache?.get(asset) ?? analyzeNarrationSilence(asset, { signal })));
    signal?.throwIfAborted();
    for (const [position, result] of results.entries()) {
      const asset = group[position];
      if (result.status === 'rejected') throw new Error(`无法检查口播「${asset.name}」的接缝，请确认音频可以正常读取。`, { cause: result.reason });
      const edgeSilence = result.value;
      silenceCache?.set(asset,edgeSilence);
      if (edgeSilence.leading || edgeSilence.trailing) measured.set(asset, edgeSilence);
    }
  }
  signal?.throwIfAborted();
  if (!measured.size) return plans;

  const enriched = new Map([...catalog].map(([id, asset]) => [id, measured.has(asset)
    ? { ...asset, edgeSilence: measured.get(asset) } : asset]));
  // Reuse the original draws so shortening a seam cannot change the selected combination or order.
  let cursor = 0;
  return planMontage(config, enriched, () => draws[cursor++], batchLimit);
}

async function prepareSubprojectPlans(config, scope, catalog, options) {
  if (!Array.isArray(scope) || !scope.length || scope.length > 1000) throw new Error('请选择参与预览的子工程。');
  const subprojects = normalizeSubprojects(config.subprojects, config.shots.length, (shot) => {
    if (!Array.isArray(shot)) throw new Error('子工程分镜素材无效。');
    return shot;
  });
  const projects = resolveSubprojectShots({ ...config, subprojects });
  const selected = new Set();
  let total = 0;
  for (const row of scope) {
    if (!row || !Number.isInteger(row.count) || row.count < 1 || selected.has(row.id) || !projects.has(row.id)
        || projects.get(row.id).participates === false) throw new Error('子工程选择或生成数量无效。');
    total += row.count;
    selected.add(row.id);
  }
  if (total > 1000) throw new Error('一次最多预览 1000 条子工程成片。');
  const plans = [];
  for (const { id, count } of scope) {
    const project = projects.get(id);
    try {
      const batch = await prepareMontagePlans({ ...config, ...projectVoiceConfig(config,project,subprojects.mainVoice), shots: project.effective, count }, catalog, { ...options, batchLimit: 1000 });
      for (const plan of batch) plans.push({ ...plan, subproject: { id, name: project.name } });
    } catch (error) {
      options?.signal?.throwIfAborted();
      throw new Error(`子工程「${project.name}」：${error.message}`, { cause: error });
    }
  }
  return plans;
}

// Keep one pending draw per editor window. Retrying a dialog uses the same
// pictures, narration rows, ordering, cover and music through both seam passes.
function createSpeedPlanningSession() {
  let pending;
  return async function prepare(config,scope,catalog,{signal,response,random=Math.random}={}) {
    if (!config.autoSpeedRange && !response) {
      pending=undefined;
      const options={signal,random};
      return {plans:scope===undefined ? await prepareMontagePlans(config,catalog,options)
        : await prepareSubprojectPlans(config,scope,catalog,options)};
    }
    const key=JSON.stringify([config,scope]);
    let draws=[], choices, cursor=0;
    let silenceCache=new Map();
    if (response) {
      if (!pending || response.token!==pending.token || pending.key!==key)
        throw Error(speedPlanningErrors.expired);
      choices={...pending.choices};
      for (const item of pending.items) {
        const value=response.choices?.[item.key];
        if (!item.choices.includes(value) || (value==='group' && !item.groupAvailable))
          throw Error(speedPlanningErrors.invalidChoice);
        choices[item.key]=value;
      }
      draws=pending.draws;
      catalog=pending.catalog;
      silenceCache=pending.silenceCache;
    } else {
      catalog=new Map(catalog);
    }
    pending=undefined;
    function nextDraw() {
      if (response) {
        if (cursor>=draws.length) throw Error(speedPlanningErrors.drawChanged);
        return draws[cursor++];
      }
      const value=random();
      draws.push(value);
      return value;
    }
    const input={...config,batchSpeedChoices:choices};
    const options={signal,random:nextDraw,silenceCache};
    const plans=scope===undefined ? await prepareMontagePlans(input,catalog,options)
      : await prepareSubprojectPlans(input,scope,catalog,options);
    const grouped=new Map();
    for (const plan of plans) {
      for (const issue of plan.speedChallenges ?? []) {
        const prior=grouped.get(issue.key);
        const count=(prior?.count ?? 0)+1;
        const extreme=!prior || (issue.direction==='high' ? issue.required>prior.required : issue.required<prior.required);
        grouped.set(issue.key,{...(extreme ? issue : prior),count});
      }
    }
    if (!grouped.size) return {plans};
    const items=[...grouped.values()];
    const token=randomUUID();
    pending={key,draws,items,token,choices,catalog,silenceCache};
    return {speedChallenge:{token,items}};
  };
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
  const reuse = measureBatchReuse(plans, catalog);
  return {
    id,
    config: JSON.stringify(config),
    plans,
    entries: plans.map((plan, index) => ({
      index,
      reuse: reuse[index],
      ...(plan.subproject && { subproject: plan.subproject }),
      duration: plan.duration,
      estimatedBytes: estimatedBytes(plan),
      clips: plan.clips.map(describeClip),
      music: plan.music?.name ?? null,
      narration: plan.narration?.name ?? null,
      subtitles: plan.subtitles?.name ?? null,
      wholeTrack: plan.wholeTrack,
      ...(plan.composite !== undefined && { composite: plan.composite + 1 }),
      ...(plan.layers?.length && { layerCount: plan.layers.length }),
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

module.exports = { createPreviewBatch, selectPreviewPlans, prepareMontagePlans, prepareSubprojectPlans,createSpeedPlanningSession };
