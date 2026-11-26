'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { compare, comparePaired } = require('../scripts/compare-bench.cjs');
test('基准只在相同工程和显示环境下比较 P95，越过绝对与相对门槛才报告', () => {
  const report = (ms) => ({ environment: { refreshHz: 60, adapters: [] }, results: { batchScroll: { p95Ms: ms } } });
  assert.deepEqual(compare(report(16.7), report(17.9)), { comparable: true, regressions: [] });
  assert.equal(compare(report(16.7), report(22)).regressions.length, 1);
  const other = report(33);
  other.environment.refreshHz = 30;
  assert.equal(compare(report(16.7), other).comparable, false);
});

const scenes = ['idle', 'candidateDrag', 'playheadScrub', 'panelResize', 'timelineZoom', 'batchScroll'];
const script = require.resolve('../scripts/compare-bench.cjs');

function sample(scene, frames) {
  const wheel = scene === 'timelineZoom' || scene === 'batchScroll';
  const actions = scene === 'idle' ? [] : [{
    type: wheel ? 'mouseWheel' : 'mouseMoved', x: 10, y: 20, atMs: 1,
    ...(wheel && { deltaX: 0, deltaY: 80 }),
  }];
  const receivedInputs = actions.map(action => ({ ...action, type: wheel ? 'wheel' : 'pointermove' }));
  return {
    elapsedMs: Math.round(frames.reduce((sum, value) => sum + value, 0)),
    trustedEvents: receivedInputs.length, dispatchedInputs: actions.length, actions, receivedInputs,
    intervals: frames.length, frameIntervalsMs: frames,
    p95Ms: 10, // The gate must use raw intervals, even when this field looks good.
  };
}

function reports(t, customize = () => {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jiajian-compare-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const run of ['base-1', 'head-1', 'head-2', 'base-2']) {
    const environment = {
      samplingProtocol: 'paired-v1', platform: '10.0.26100', electron: '45.2.3', cpu: 'test CPU',
      refreshHz: 64, windowDip: [1000, 660], scaleFactor: 1, gpu: 'disabled_software',
      adapters: [{ active: false, vendorId: 5140, deviceId: 140 }], tracks: 10,
      shots: 200, candidateClips: 1000, videoLanes: 5, batchRows: 1000, narrationSeconds: 200,
      metric: 'renderer requestAnimationFrame timestamps', durationMs: 14400,
      sourceSha256: (run.startsWith('base') ? 'a' : 'b').repeat(64), driverSha256: 'c'.repeat(64),
    };
    const results = Object.fromEntries(scenes.map(scene => [scene, sample(scene, Array(50).fill(10))]));
    const report = { environment, results };
    customize(report, run);
    fs.writeFileSync(path.join(directory, run + '.json'), JSON.stringify(report));
  }
  return directory;
}

function runCli(directory) {
  const { status, stdout, stderr } = spawnSync(process.execPath, [script, '--paired', directory], { encoding: 'utf8' });
  return { status, stdout, stderr, summary: JSON.parse(fs.readFileSync(path.join(directory, 'summary.json'), 'utf8')) };
}

test('ABBA 用同侧两轮全部原始帧计算 nearest-rank P95，保留尖峰与计数', t => {
  const directory = reports(t, (report, run) => {
    const frames = run.endsWith('1') ? Array(95).fill(10) : [20, 20, 25, 30, 90];
    report.results.timelineZoom = sample('timelineZoom', frames);
  });
  const { status, summary } = runCli(directory);
  assert.equal(status, 0);
  assert.equal(summary.status, 'passed');
  assert.equal(Object.keys(summary.results).length, 6);
  const base = summary.results.timelineZoom.base;
  assert.equal(base.p95Ms, 10);
  assert.equal(base.intervals, 100);
  assert.equal(base.maxMs, 90);
  assert.equal(base.over16_67Ms, 5);
  assert.equal(base.over25Ms, 2);
  assert.deepEqual(base.frameIntervalsMs.slice(-5), [20, 20, 25, 30, 90]);
  assert.deepEqual(Object.keys(base.runs), ['base-1', 'base-2']);
  assert.notEqual(summary.sources.base, summary.sources.head);
});

test('仅注入 head 的慢帧即可触发退化，失败时 CLI 也保存摘要', t => {
  const directory = reports(t, (report, run) => {
    if (run.startsWith('head')) report.results.timelineZoom = sample('timelineZoom', [...Array(46).fill(10), ...Array(4).fill(17)]);
  });
  const { status, stderr, summary } = runCli(directory);
  assert.equal(status, 1);
  assert.match(stderr, /timelineZoom.*10 ms.*17 ms/);
  assert.equal(summary.status, 'regression');
  assert.deepEqual(summary.errors, []);
  assert.equal(summary.regressions.length, 1);
  assert.equal(summary.results.timelineZoom.head.p95Ms, 17);
});

test('双门槛沿用两位小数，刚好 20% 或刚好 2ms 均通过', t => {
  const cases = [
    ['20% 边界', 10.1, 12.12, 'passed'], ['2ms 边界', 7.3, 9.3, 'passed'],
    ['舍入后在边界', 10.1, 12.124, 'passed'], ['舍入后高于边界', 10.1, 12.126, 'regression'],
  ];
  for (const [name, before, after, status] of cases) {
    const directory = reports(t, (report, run) => {
      report.results.panelResize = sample('panelResize', Array(50).fill(run.startsWith('head') ? after : before));
    });
    assert.equal(comparePaired(directory).status, status, name);
  }
});

test('采样不足、缺场景、单轮空样本、非正数与不可信输入分别诊断', t => {
  const directory = reports(t, (report, run) => {
    if (run !== 'base-2') return;
    delete report.results.idle;
    report.results.timelineZoom = sample('timelineZoom', Array(49).fill(10));
    report.results.panelResize = sample('panelResize', []);
    report.results.batchScroll.frameIntervalsMs[0] = 0;
    report.results.candidateDrag.trustedEvents = 0;
    report.results.playheadScrub.dispatchedInputs++;
  });
  const { status, summary } = runCli(directory);
  assert.equal(status, 1);
  assert.equal(summary.status, 'invalid');
  const errors = summary.errors.join('\n');
  for (const scene of scenes.filter(name => name !== 'timelineZoom')) assert.match(errors, new RegExp('base-2 ' + scene));
  assert.match(errors, /base timelineZoom 合计 99/);
});

test('同侧源码、四轮协议、工程和机器字段必须完整一致', t => {
  const edits = [
    [env => { env.sourceSha256 = 'd'.repeat(64); }, 'sourceSha256'],
    [env => { env.samplingProtocol = 'old'; }, 'paired-v1'],
    [env => { delete env.refreshHz; }, 'refreshHz'],
    [env => { env.windowDip[0]++; }, 'windowDip'],
    [env => { env.cpu += ' v2'; }, 'cpu'],
    [env => { env.adapters[0].active = true; }, 'adapters'],
    [env => { env.scaleFactor = 1.5; }, 'scaleFactor'],
    [env => { env.driverSha256 = 'e'.repeat(64); }, 'driverSha256'],
    [env => { env.videoLanes++; }, 'videoLanes'],
  ];
  for (const [change, field] of edits) {
    const directory = reports(t, (report, run) => { if (run === 'head-2') change(report.environment); });
    const summary = comparePaired(directory);
    assert.equal(summary.status, 'invalid', field);
    assert.match(summary.errors.join('\n'), new RegExp('head-2 .*' + field));
  }
});

test('同数量的反向输入、缺少到达页面的证据或被裁剪的原始时间跨度均不可比', t => {
  const directory = reports(t, (report, run) => {
    if (run !== 'head-1') return;
    report.results.timelineZoom.actions[0].deltaY *= -1;
    report.results.panelResize.receivedInputs = [];
    report.results.batchScroll.elapsedMs += 10;
  });
  const summary = comparePaired(directory);
  assert.equal(summary.status, 'invalid');
  const errors = summary.errors.join('\n');
  assert.match(errors, /head-1 timelineZoom.*输入序列/);
  assert.match(errors, /head-1 panelResize.*可信输入记录/);
  assert.match(errors, /head-1 batchScroll.*总时长/);
});

test('拖动从各自起点比较，允许整体平移和少量尺寸变化，拒绝轨迹缩短、反向或中途绕行', t => {
  const cases = [
    { name: '控件整体移动', scale: 1, middleY: 0, expected: 'passed' },
    { name: '500 DIP 长路径的 2% 容差', scale: 1.02, middleY: 4, expected: 'passed' },
    { name: '长路径明显缩短', scale: 0.8, middleY: 0, expected: 'invalid' },
    { name: '方向反转', scale: -1, middleY: 0, expected: 'invalid' },
    { name: '起终点相同但中间绕行', scale: 1, middleY: 5, expected: 'invalid' },
  ];
  for (const { name, scale, middleY, expected } of cases) {
    const directory = reports(t, (report, run) => {
      const head = run.startsWith('head');
      const result = report.results.playheadScrub;
      const distance = head ? 500 * scale : 500;
      const x = head ? 120 : 20;
      const y = head ? 150 : 40;
      const offsets = [0, distance / 2, distance];
      result.actions = offsets.map((offset, i) => ({
        type: 'mouseMoved', atMs: i * 16, x: x + offset, y: y + (head && i === 1 ? middleY : 0),
      }));
      result.receivedInputs = result.actions.map(event => ({ ...event, type: 'pointermove' }));
      result.dispatchedInputs = result.trustedEvents = offsets.length;
    });
    const summary = comparePaired(directory);
    assert.equal(summary.status, expected, name);
    if (expected === 'invalid') assert.match(summary.errors.join('\n'), /head-1 playheadScrub.*相对位移不同/);
  }
});

test('缺文件、JSON 无效或不能表示为有限数的帧使配对失败并写出摘要', t => {
  const directory = reports(t);
  fs.unlinkSync(path.join(directory, 'base-1.json'));
  fs.writeFileSync(path.join(directory, 'head-1.json'), '{');
  const file = path.join(directory, 'base-2.json');
  const json = fs.readFileSync(file, 'utf8').replace('"frameIntervalsMs":[10', '"frameIntervalsMs":[1e9999');
  fs.writeFileSync(file, json);
  const { status, summary } = runCli(directory);
  assert.equal(status, 1);
  assert.equal(summary.status, 'invalid');
  const errors = summary.errors.join('\n');
  assert.match(errors, /base-1.json 无法读取/);
  assert.match(errors, /head-1.json 的 JSON 无法解析/);
  assert.match(errors, /base-2 idle.*原始帧间隔/);
});
