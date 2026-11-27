'use strict';

const { randomUUID } = require('node:crypto');
const {normalizeSettings,planningRandom} = require('./ui/batch-variations.js');
const {speedPlanningErrors,narrationTrim:trimMessages} = require('./ui/messages-zh-cn.js');
const { estimatedBytes } = require('./export-preflight.cjs');
const { planMontage, analyzeNarrationSilence, analyzeNarrationPauses } = require('./media.cjs');
const { measureBatchReuse } = require('./visual-similarity.cjs');
const { normalizeSubprojects, resolveSubprojectShots,projectVoiceConfig } = require('./subprojects.cjs');

async function prepareMontagePlans(config, catalog, { signal, random, batchLimit, silenceCache, pauseCache, analyzePauses=analyzeNarrationPauses } = {}) {
  signal?.throwIfAborted();
  random ??= planningRandom(normalizeSettings(config?.batchRandom),config?.subprojects?.active);
  const seams = config?.priority === 'voice' && config.narrationMode === 'segmented' && config.voiceAlignment !== 'reference';
  const smart = config?.narrationTrim?.mode === 'smart';
  const picture = smart && (config.priority ?? 'picture') === 'picture';
  if (!seams && !picture) return planMontage(config, catalog, random, batchLimit);

  const draws = [];
  const plans = planMontage(config, catalog, () => {
    const value = random();
    draws.push(value);
    return value;
  }, batchLimit);
  const toAnalyze = new Set();
  for (const { clips,narration,narrationMap } of plans) {
    if (picture) {
      if (narrationMap?.reason === 'hard' && narrationMap.duration > 0) toAnalyze.add(narration);
      for (const clip of clips) {
        if (clip.narrationMap?.reason === 'hard' && clip.narrationMap.duration > 0) toAnalyze.add(clip.narration);
      }
      continue;
    }
    for (let index = 1; index < clips.length; index += 1) {
      const before = clips[index - 1].narration;
      const after = clips[index].narration;
      if (before && after) {
        toAnalyze.add(before);
        toAnalyze.add(after);
      }
    }
  }
  const voices = [...toAnalyze];
  const measured = new Map();
  for (let index = 0; index < voices.length; index += 4) {
    const group = voices.slice(index, index + 4);
    const results = await Promise.allSettled(group.map((asset) => smart ? pauseCache?.get(asset) ?? analyzePauses(asset,config.narrationTrim,{signal})
      : silenceCache?.get(asset) ?? analyzeNarrationSilence(asset, { signal })));
    signal?.throwIfAborted();
    for (const [position, result] of results.entries()) {
      const asset = group[position];
      if (result.status === 'rejected') throw new Error(`无法检查口播「${asset.name}」的接缝，请确认音频可以正常读取。`, { cause: result.reason });
      if (smart) {
        if (!Array.isArray(result.value)) throw new Error(trimMessages.analysisExpired(asset.name));
        pauseCache?.set(asset,result.value);
        if (result.value.length) measured.set(asset,result.value);
        continue;
      }
      const edgeSilence = result.value;
      silenceCache?.set(asset,edgeSilence);
      if (edgeSilence.leading || edgeSilence.trailing) measured.set(asset, {edgeSilence});
    }
  }
  signal?.throwIfAborted();
  if (!measured.size) return plans;

  // Reuse the original draws so shortening a seam cannot change the selected combination or order.
  let cursor = 0;
  if (smart) return planMontage(config,catalog,() => draws[cursor++],batchLimit,measured);
  const enriched = new Map([...catalog].map(([id, asset]) => [id, measured.has(asset)
    ? { ...asset, ...measured.get(asset) } : asset]));
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
  const summaries = [];
  const settings = config.batchRandom === undefined ? undefined : normalizeSettings(config.batchRandom);
  // Every subproject in one generation uses the same recording and trim settings.
  // A new invocation gets a fresh cache, including a confirmed speed-choice retry.
  const batchOptions = {...options,batchLimit:1000,pauseCache:new Map(),silenceCache:options?.silenceCache ?? new Map()};
  for (const { id, count } of scope) {
    const project = projects.get(id);
    try {
      const optionsForProject = settings === undefined ? batchOptions : {
        ...batchOptions, random: planningRandom(settings, id)
      };
      const batch = await prepareMontagePlans({ ...config, ...projectVoiceConfig(config,project,subprojects.mainVoice), shots: project.effective, count }, catalog, optionsForProject);
      summaries.push({ id, name:project.name, ...batch.batchSummary });
      for (const plan of batch) plans.push({ ...plan, subproject: { id, name: project.name } });
    } catch (error) {
      options?.signal?.throwIfAborted();
      throw new Error(`子工程「${project.name}」：${error.message}`, { cause: error });
    }
  }
  Object.defineProperty(plans,'batchSummary',{value:{
    totalSpace:summaries.reduce((sum,row)=>sum+BigInt(row.totalSpace),0n).toString(),
    requested:total, actual:plans.length,
    reason:summaries.some(row=>row.reason==='budget') ? 'budget' : summaries.find(row=>row.reason)?.reason ?? null,
    subprojects:summaries,
  }});
  return plans;
}

// Keep one pending draw per editor window. Retrying a dialog uses the same
// pictures, narration rows, ordering, cover and music through both seam passes.
function createSpeedPlanningSession() {
  let pending;
  return async function prepare(config,scope,catalog,{signal,response,random,analyzePauses}={}) {
    if (!config.autoSpeedRange && !response) {
      pending=undefined;
      const options={signal,random,analyzePauses};
      return {plans:scope===undefined ? await prepareMontagePlans(config,catalog,options)
        : await prepareSubprojectPlans(config,scope,catalog,options)};
    }
    const key=JSON.stringify([config,scope]);
    random ??= planningRandom(normalizeSettings(config.batchRandom),config.subprojects?.active);
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
    const options={signal,random:nextDraw,silenceCache,analyzePauses};
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
    batchSummary: plans.batchSummary,
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
