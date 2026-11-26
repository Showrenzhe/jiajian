'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');

const batchScrollLimitMs = 25.05;

function batchTimings(data) {
  assert.ok(Number.isFinite(data?.firstRenderMs) && data.firstRenderMs > 0, '1000 条列表首绘耗时无效');
  assert.ok(Array.isArray(data.filterInputMs) && data.filterInputMs.length === 5 &&
    data.filterInputMs.every(ms => Number.isFinite(ms) && ms >= 0), '需要五个有效的真实筛选输入耗时');
  return data;
}

function summarizeBatchTimings(runs) {
  const first = runs.map(run => run.firstRenderMs);
  const filter = runs.flatMap(run => run.filterInputMs);
  const sorted = [...filter].sort((a, b) => a - b);
  const mean = first.reduce((sum, ms) => sum + ms, 0) / first.length;
  return {
    firstRenderMs: first,
    meanFirstRenderMs: Number(mean.toFixed(2)),
    filterInputMs: filter,
    filterP95Ms: sorted[Math.ceil(sorted.length * .95) - 1],
  };
}

function checkBatchScroll(ms, regressions) {
  if (ms > batchScrollLimitMs) regressions.push(`1000 条列表滚动 P95 为 ${ms} ms，超过 ${batchScrollLimitMs} ms`);
}

function compare(previous, current) {
  const environment = (report) => {
    const {
      platform,
      cpu,
      windowDip,
      refreshHz,
      scaleFactor,
      gpu,
      shots,
      candidateClips,
      videoLanes,
      batchRows,
      durationMs,
      adapters,
    } = report.environment;
    return {
      platform,
      cpu,
      windowDip,
      refreshHz,
      scaleFactor,
      gpu,
      shots,
      candidateClips,
      videoLanes,
      batchRows,
      durationMs,
      adapters: adapters.map(({ vendorId, deviceId }) => [vendorId, deviceId]).sort(),
    };
  };
  if (JSON.stringify(environment(previous)) !== JSON.stringify(environment(current))) {
    return { comparable: false, regressions: [] };
  }
  const regressions = [];
  for (const [scene, before] of Object.entries(previous.results)) {
    const after = current.results[scene];
    assert.ok(Number.isFinite(before.p95Ms) && Number.isFinite(after?.p95Ms), '缺少 P95 数据 ' + scene);
    if (after.p95Ms > before.p95Ms * 1.2 && after.p95Ms > before.p95Ms + 2) {
      regressions.push(`${scene} 的 P95 从 ${before.p95Ms} ms 增至 ${after.p95Ms} ms`);
    }
  }
  const result = { comparable: true, regressions };
  if (current.results.batchScroll) checkBatchScroll(current.results.batchScroll.p95Ms, regressions);
  if (previous.batchPreview || current.batchPreview) {
    result.batchPreview = {
      base: previous.batchPreview ? summarizeBatchTimings([batchTimings(previous.batchPreview)]) : null,
      head: summarizeBatchTimings([batchTimings(current.batchPreview)]),
    };
  }
  return result;
}
const scenes = ['idle', 'candidateDrag', 'playheadScrub', 'panelResize', 'timelineZoom', 'batchScroll'];
const runNames = ['base-1', 'head-1', 'head-2', 'base-2'];
const minIntervals = 100;

function pairedEnvironment(env) {
  assert.equal(env?.samplingProtocol, 'paired-v1', '缺少 paired-v1 采样协议');
  const configuration = {};
  for (const key of ['electron', 'platform', 'cpu', 'gpu', 'metric']) {
    assert.ok(typeof env[key] === 'string' && env[key].trim(), '缺少环境字段 ' + key);
    configuration[key] = env[key];
  }
  for (const key of ['refreshHz', 'scaleFactor', 'durationMs', 'narrationSeconds', 'tracks', 'shots',
    'candidateClips', 'videoLanes', 'batchRows']) {
    assert.ok(Number.isFinite(env[key]) && env[key] > 0, '无效的环境字段 ' + key);
    configuration[key] = env[key];
  }
  assert.ok(Array.isArray(env.windowDip) && env.windowDip.length === 2 &&
    env.windowDip.every(value => Number.isSafeInteger(value) && value > 0), '无效的 windowDip');
  configuration.windowDip = env.windowDip;
  assert.ok(Array.isArray(env.adapters) && env.adapters.length, '缺少 GPU adapters');
  configuration.adapters = env.adapters.map(({ active, vendorId, deviceId }) => {
    assert.ok(typeof active === 'boolean' && Number.isSafeInteger(vendorId) && vendorId >= 0 &&
      Number.isSafeInteger(deviceId) && deviceId >= 0, '无效的 GPU adapter');
    return [vendorId, deviceId, active];
  }).sort((a, b) => a[0] - b[0] || a[1] - b[1] || Number(a[2]) - Number(b[2]));
  for (const key of ['sourceSha256', 'driverSha256']) {
    assert.match(env[key] || '', /^[0-9a-f]{64}$/, '无效的 ' + key);
  }
  configuration.driverSha256 = env.driverSha256;
  return configuration;
}

function pairedSample(result, scene) {
  const frames = result?.frameIntervalsMs;
  assert.ok(Array.isArray(frames) && frames.length && frames.every(ms => Number.isFinite(ms) && ms > 0),
    '缺少有效的原始帧间隔');
  assert.equal(result.intervals, frames.length, 'intervals 与原始帧数不符');
  assert.ok(Number.isFinite(result.elapsedMs) && result.elapsedMs > 0, '缺少有效的 elapsedMs');
  const elapsedMs = frames.reduce((sum, value) => sum + value, 0);
  assert.ok(Math.abs(elapsedMs - result.elapsedMs) <= 0.51, '原始帧间隔总时长与 elapsedMs 不符');
  assert.ok(Number.isSafeInteger(result.trustedEvents) && result.trustedEvents >= (scene === 'idle' ? 0 : 1),
    '可信输入数无效');
  const expectedType = scene === 'timelineZoom' || scene === 'batchScroll' ? 'wheel' : 'pointermove';
  assert.ok(Array.isArray(result.receivedInputs) &&
    result.receivedInputs.filter(event => event.type === expectedType).length === result.trustedEvents,
    'trustedEvents 与收到的可信输入记录不符');
  if (scene === 'idle') assert.equal(result.receivedInputs.length, 0, '空闲场景收到了输入');
  assert.ok(Array.isArray(result.actions) && result.actions.length === result.dispatchedInputs &&
    ((scene === 'idle') === (result.dispatchedInputs === 0)), '发出输入的计数与操作记录不符');
  for (const action of result.actions) {
    assert.ok(Number.isFinite(action?.x) && Number.isFinite(action?.y) && Number.isFinite(action?.atMs) &&
      ['mousePressed', 'mouseMoved', 'mouseReleased', 'mouseWheel'].includes(action.type), '操作记录无效');
    if (action.type === 'mouseWheel') {
      assert.ok(Number.isFinite(action.deltaX) && Number.isFinite(action.deltaY), '滚轮记录缺少位移');
    }
  }
  return {
    frameIntervalsMs: frames, intervals: frames.length, elapsedMs: result.elapsedMs,
    trustedEvents: result.trustedEvents, dispatchedInputs: result.dispatchedInputs,
  };
}

function pooledStats(samples) {
  const frameIntervalsMs = samples.flatMap(sample => sample.frameIntervalsMs);
  const sorted = [...frameIntervalsMs].sort((a, b) => a - b);
  const intervals = sorted.length;
  return {
    intervals, p95Ms: intervals ? Number(sorted[Math.ceil(0.95 * intervals) - 1].toFixed(2)) : null,
    maxMs: intervals ? sorted[intervals - 1] : null,
    over16_67Ms: sorted.filter(ms => ms > 1000 / 60).length,
    over25Ms: sorted.filter(ms => ms > 25).length, frameIntervalsMs,
  };
}

function checkGesture(reference, actions) {
  // Dispatch times and delivered event counts depend on runner load.
  const commands = events => events.map(({ type, button, buttons, clickCount, modifiers, deltaX, deltaY }) =>
    [type, button, buttons, clickCount, modifiers, deltaX, deltaY]);
  assert.ok(isDeepStrictEqual(commands(reference), commands(actions)), '发出的输入序列与其他轮不同');
  if (!actions.length) return;
  for (const axis of ['x', 'y']) {
    let min = reference[0][axis];
    let max = min;
    for (const point of reference) {
      min = Math.min(min, point[axis]);
      max = Math.max(max, point[axis]);
    }
    // Align each gesture at its own start. Allow four DIPs on short paths,
    // or two percent of the baseline span on long paths such as ruler scrubs.
    const tolerance = Math.max(4, (max - min) * 0.02);
    for (const [index, point] of actions.entries()) {
      const expected = reference[index][axis] - reference[0][axis];
      const actual = point[axis] - actions[0][axis];
      assert.ok(Math.abs(actual - expected) <= tolerance,
        `第 ${index + 1} 次输入的 ${axis} 轴相对位移不同（${actual.toFixed(1)} / ${expected.toFixed(1)} DIP，容差 ${tolerance.toFixed(1)}）`);
    }
  }
}

function comparePaired(directory) {
  const environments = {};
  const sources = {};
  const gestures = {};
  const errors = [];
  const regressions = [];
  const results = {};
  const samples = {};
  const listTimings = { base: [], head: [] };
  for (const run of runNames) {
    const filename = run + '.json';
    let report;
    try {
      report = JSON.parse(fs.readFileSync(path.join(directory, filename), 'utf8'));
    } catch (error) {
      errors.push(filename + (error instanceof SyntaxError ? ' 的 JSON 无法解析' : ' 无法读取 (' + error.code + ')'));
      continue;
    }
    try {
      environments[run] = pairedEnvironment(report?.environment);
      const side = run.split('-')[0];
      const source = report.environment.sourceSha256;
      if (sources[side] && sources[side] !== source) errors.push(run + ' 与同侧另一轮 sourceSha256 不同');
      sources[side] ??= source;
    } catch (error) {
      errors.push(run + ' ' + error.message);
    }
    if (Object.hasOwn(report ?? {}, 'batchPreview')) {
      try {
        listTimings[run.split('-')[0]].push(batchTimings(report.batchPreview));
      } catch (error) { errors.push(run + ' ' + error.message); }
    }
    samples[run] = {};
    const extraScenes = Object.keys(report?.results ?? {}).filter(name => !scenes.includes(name));
    if (extraScenes.length) errors.push(run + ' 包含 paired-v1 之外的场景');
    for (const scene of scenes) {
      try {
        const sample = pairedSample(report?.results?.[scene], scene);
        samples[run][scene] = sample;
        const actions = report.results[scene].actions;
        if (gestures[scene]) checkGesture(gestures[scene], actions);
        gestures[scene] ??= actions;
      } catch (error) {
        errors.push(run + ' ' + scene + ' ' + error.message);
      }
    }
  }
  const reference = Object.values(environments)[0];
  for (const [run, env] of Object.entries(environments)) {
    for (const key of Object.keys(env)) {
      if (!isDeepStrictEqual(reference[key], env[key])) errors.push(run + ' 环境或工程配置不同 ' + key);
    }
  }
  for (const scene of scenes) {
    const result = {};
    for (const side of ['base', 'head']) {
      const runs = {};
      const available = [];
      for (const run of runNames.filter(name => name.startsWith(side))) {
        const sample = samples[run]?.[scene];
        if (!sample) continue;
        const { frameIntervalsMs, ...counts } = sample;
        available.push(sample);
        runs[run] = counts;
      }
      result[side] = { runs, ...pooledStats(available) };
      if (result[side].intervals < minIntervals) errors.push(`${side} ${scene} 合计 ${result[side].intervals} 个帧间隔，至少需要 ${minIntervals} 个`);
    }
    results[scene] = result;
  }
  let batchPreview;
  if (listTimings.base.length || listTimings.head.length) {
    if (listTimings.base.length === 1 || listTimings.head.length !== 2) errors.push('同侧两轮的批量列表计时不完整');
    batchPreview = Object.fromEntries(Object.entries(listTimings).map(([side, runs]) =>
      [side, runs.length ? summarizeBatchTimings(runs) : null]));
  }
  if (!errors.length) {
    checkBatchScroll(results.batchScroll.head.p95Ms, regressions);
    for (const [scene, { base, head }] of Object.entries(results)) {
      // Match the driver's two-decimal P95. Use hundredths of a millisecond
      // so values exactly on either strict threshold remain eligible to pass.
      const before = Math.round(base.p95Ms * 100);
      const after = Math.round(head.p95Ms * 100);
      if (after * 5 > before * 6 && after - before > 200) {
        regressions.push(`${scene} 的 P95 从 ${base.p95Ms} ms 增至 ${head.p95Ms} ms`);
      }
    }
  }
  const status = errors.length ? 'invalid' : regressions.length ? 'regression' : 'passed';
  return { samplingProtocol: 'paired-v1', status, order: runNames, minIntervals, environments, sources, results, batchPreview, errors, regressions };
}

function printBatchTimings(batchPreview) {
  if (!batchPreview) return;
  for (const [side, timings] of Object.entries(batchPreview)) {
    if (timings) console.log(`1000 条列表 ${side} 首绘均值 ${timings.meanFirstRenderMs} ms，筛选输入 P95 ${timings.filterP95Ms} ms`);
    else console.log('历史基线未采集批量列表计时。');
  }
  if (batchPreview.base && batchPreview.head) {
    const delta = key => (batchPreview.head[key] - batchPreview.base[key]).toFixed(2);
    console.log(`候选减基线：1000 条列表首绘 ${delta('meanFirstRenderMs')} ms，筛选输入 P95 ${delta('filterP95Ms')} ms`);
  }
}

function runPaired(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const summary = comparePaired(directory);
  fs.writeFileSync(path.join(directory, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log('配对回归门槛：各侧每场至少 100 个间隔，合并 P95 同时增加超过 20% 和 2 ms 判为退化。');
  console.log('场景 / 版本 / 帧间隔数 / P95 (ms) / 最慢帧 (ms) / 超过 25 ms 数');
  for (const [scene, { base, head }] of Object.entries(summary.results)) {
    for (const [side, stats] of Object.entries({ base, head })) {
      console.log(scene, side, stats.intervals, stats.p95Ms ?? '—', stats.maxMs?.toFixed(2) ?? '—', stats.over25Ms);
    }
  }
  for (const message of [...summary.errors, ...summary.regressions]) console.error('::error::' + message);
  printBatchTimings(summary.batchPreview);
  if (summary.status === 'passed') console.log('各场景 P95 通过配对回归门槛。');
  return Number(summary.status !== 'passed');
}

if (require.main === module && process.argv[2] === '--paired') {
  assert.equal(process.argv.length, 4, '需要配对报告目录');
  process.exitCode = runPaired(process.argv[3]);
} else if (require.main === module) {
  const reports = process.argv.slice(2).map((file) => JSON.parse(fs.readFileSync(file, 'utf8')));
  assert.equal(reports.length, 2, '需要上一次与本次报告');
  const result = compare(...reports);
  printBatchTimings(result.batchPreview);
  if (!result.comparable) console.log('两次采样的图形或工程配置不同，本次留作新基线。');
  else if (!result.regressions.length) console.log('各场景 P95 通过回归门槛。');
  for (const regression of result.regressions) console.error('::error::' + regression);
  process.exitCode = Number(result.regressions.length > 0);
}
module.exports = { compare, comparePaired };
