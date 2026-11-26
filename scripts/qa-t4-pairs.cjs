'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { compare } = require(path.resolve('A/scripts/compare-bench.cjs'));

const scenes = ['batchScroll', 'candidateDrag', 'idle', 'panelResize', 'playheadScrub', 'timelineZoom'];
const order = ['AB', 'BA', 'BA', 'AB'];
const manifest = JSON.parse(fs.readFileSync('evidence/manifest.json', 'utf8'));
const reports = new Map();
const errors = [];
const comparisons = [];
for (const [index, sides] of order.entries()) {
  for (const side of sides) {
    const round = (index + 1) + '-' + side;
    try {
      const report = JSON.parse(fs.readFileSync('evidence/' + round + '.json', 'utf8'));
      const env = report.environment;
      for (const field of ['platform', 'cpu', 'gpu', 'electron', 'metric']) assert.ok(env[field], field);
      for (const field of ['refreshHz', 'scaleFactor', 'durationMs', 'tracks', 'narrationSeconds']) {
        assert.ok(Number.isFinite(env[field]) && env[field] > 0, field);
      }
      assert.ok(Array.isArray(env.adapters) && env.adapters.length > 0 && env.adapters.every(adapter =>
        Number.isInteger(adapter?.vendorId) && Number.isInteger(adapter?.deviceId)), '缺少显卡标识');
      assert.ok(Array.isArray(env.windowDip) && env.windowDip.length === 2 && env.windowDip.every(size => size > 0));
      assert.match(env.sourceSha256, /^[a-f0-9]{64}$/);
      assert.equal(env.driverSha256.toUpperCase(), manifest[side].sha256['test/interaction-frames-desktop.cjs']);
      assert.deepEqual([env.shots, env.candidateClips, env.videoLanes, env.batchRows], [200, 1000, 5, 1000]);
      assert.deepEqual(Object.keys(report.results).sort(), scenes);
      for (const [name, result] of Object.entries(report.results)) {
        assert.ok(Number.isFinite(result.p95Ms) && result.p95Ms > 0, name + ' 缺少有效 P95');
        assert.ok(Number.isInteger(result.intervals) && result.intervals > 0, name + ' 缺少帧间隔');
        if (name !== 'idle') {
          assert.ok(Number.isInteger(result.trustedEvents) && result.trustedEvents > 0, name + ' 缺少真实输入');
        }
      }
      reports.set(round, report);
    } catch (error) {
      errors.push(round + ' ' + error.message);
    }
  }
}

function record(kind, before, after) {
  const previous = reports.get(before);
  const current = reports.get(after);
  if (!previous || !current) {
    comparisons.push({ kind, before, after, comparable: false, reason: '报告不完整' });
    return;
  }
  const result = compare(previous, current);
  const fields = ['sourceSha256', 'driverSha256', 'electron', 'metric', 'narrationSeconds', 'tracks'];
  const differences = fields.filter(key => previous.environment[key] !== current.environment[key]);
  if (!result.comparable || differences.length) {
    comparisons.push({ kind, before, after, comparable: false,
      reason: differences.length ? '报告字段不同 ' + differences.join(', ') : '比较器判定环境或工程不同' });
    return;
  }
  comparisons.push({ kind, before, after, ...result });
}

for (let pair = 1; pair <= order.length; pair++) record('A/B', pair + '-A', pair + '-B');
for (const side of ['A', 'B']) {
  for (let first = 1; first < order.length; first++) {
    for (let next = first + 1; next <= order.length; next++) {
      record(side + '/' + side, first + '-' + side, next + '-' + side);
    }
  }
}

const summary = { order, errors, comparisons };
fs.writeFileSync('evidence/comparisons.json', JSON.stringify(summary, null, 2) + '\n');
for (const error of errors) console.error(error);
for (const row of comparisons) {
  const outcome = row.comparable ? (row.regressions.join(' / ') || '阈值内') : row.reason;
  console.log(row.kind + ' ' + row.before + ' → ' + row.after + ' ' + outcome);
}
process.exitCode = Number(errors.length > 0 || comparisons.some(row =>
  !row.comparable || (row.kind === 'A/B' && row.regressions.length > 0)));
