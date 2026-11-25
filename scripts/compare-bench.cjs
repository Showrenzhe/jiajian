'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');

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
  return { comparable: true, regressions };
}
if (require.main === module) {
  const reports = process.argv.slice(2).map((file) => JSON.parse(fs.readFileSync(file, 'utf8')));
  assert.equal(reports.length, 2, '需要上一次与本次报告');
  const result = compare(...reports);
  if (!result.comparable) console.log('两次采样的图形或工程配置不同，本次留作新基线。');
  else if (!result.regressions.length) console.log('各场景 P95 通过回归门槛。');
  for (const regression of result.regressions) console.error('::error::' + regression);
  process.exitCode = Number(result.regressions.length > 0);
}
module.exports = { compare };
