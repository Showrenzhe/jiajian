'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { compare } = require('../scripts/compare-bench.cjs');
test('基准只在相同工程和显示环境下比较 P95，越过绝对与相对门槛才报告', () => {
  const report = (ms) => ({ environment: { refreshHz: 60, adapters: [] }, results: { batchScroll: { p95Ms: ms } } });
  assert.deepEqual(compare(report(16.7), report(17.9)), { comparable: true, regressions: [] });
  assert.equal(compare(report(16.7), report(22)).regressions.length, 1);
  const other = report(33);
  other.environment.refreshHz = 30;
  assert.equal(compare(report(16.7), other).comparable, false);
});
