'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const ffmpegErrors = [
  'No space left on device',
  'Permission denied',
  'Invalid data found when processing input',
  'No such file or directory',
  'Error while decoding stream',
  'Error initializing filter',
  'Invalid argument',
  'Could not write header',
  'Conversion failed',
  'Unknown encoder',
  'Decoder not found',
  'Operation timed out',
  'Error opening input',
  'Error opening output',
  'Error reinitializing filters',
  'Cannot allocate memory',
];
const usefulFlags = new Set([
  '-i',
  '-ss',
  '-t',
  '-vf',
  '-af',
  '-filter_complex',
  '-filter_complex_script',
  '-map',
  '-c:v',
  '-c:a',
  '-f',
  '-r',
  '-fps_mode',
  '-progress',
]);
const exitReasons = new Set([
  'abnormal-exit',
  'killed',
  'crashed',
  'oom',
  'launch-failed',
  'integrity-failure',
  'clean-exit',
]);
let target;
function summarizeTool(executable, args, stderr, code) {
  const binary = path
    .basename(executable)
    .toLowerCase()
    .replace(/\.exe$/, '');
  return {
    event: 'media-error',
    tool: ['ffmpeg', 'ffprobe'].includes(binary) ? binary : 'media-tool',
    flags: [...new Set(args.filter((arg) => usefulFlags.has(arg)))],
    exitCode: Number.isInteger(code) ? code : null,
    stderr: ffmpegErrors.filter((message) => stderr.toLowerCase().includes(message.toLowerCase())),
  };
}
function logToolFailure(executable, args, stderr, code) {
  target?.record(summarizeTool(executable, args, stderr, code));
}

function createDiagnostics(directory) {
  const file = path.join(directory, 'diagnostics.jsonl');
  let writes = Promise.resolve();
  function record(event) {
    const line = JSON.stringify({ time: new Date().toISOString(), ...event }) + '\n';
    writes = writes
      .then(async () => {
        if (((await fs.stat(file).catch(() => null))?.size ?? 0) > 128 * 1024)
          await fs.rename(file, file + '.previous');
        await fs.appendFile(file, line, { mode: 0o600 });
      })
      .catch(() => {});
  }
  async function snapshot(app) {
    await writes;
    const gpu = await app.getGPUInfo('basic').catch(() => ({}));
    const events = [];
    for (const f of [file + '.previous', file]) {
      for (const line of (await fs.readFile(f, 'utf8').catch(() => '')).split('\n').filter(Boolean)) {
        try {
          const e = JSON.parse(line);
          if (typeof e.time !== 'string' || !/^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(e.time)) continue;
          if (e.event === 'media-error')
            events.push({
              time: e.time,
              ...summarizeTool(
                typeof e.tool === 'string' ? e.tool : '',
                Array.isArray(e.flags) ? e.flags : [],
                Array.isArray(e.stderr) ? e.stderr.join(' ') : '',
                e.exitCode,
              ),
            });
          else if (['GPU', 'Renderer'].includes(e.event))
            events.push({
              time: e.time,
              event: e.event,
              reason: exitReasons.has(e.reason) ? e.reason : 'unknown',
              exitCode: Number.isInteger(e.exitCode) ? e.exitCode : null,
            });
        } catch {}
      }
    }
    return {
      version: app.getVersion(),
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      electron: process.versions.electron,
      graphics: (gpu.gpuDevice ?? []).map((d) => ({
        active: !!d.active,
        vendorId: Number(d.vendorId) || 0,
        deviceId: Number(d.deviceId) || 0,
      })),
      gpuCompositing: app.getGPUFeatureStatus().gpu_compositing,
      events: events.slice(-200),
    };
  }
  const result = {
    record,
    snapshot,
    processExit(type, details) {
      if (['GPU', 'Renderer'].includes(type) && details.reason !== 'clean-exit')
        record({
          event: type,
          reason: exitReasons.has(details.reason) ? details.reason : 'unknown',
          exitCode: Number.isInteger(details.exitCode) ? details.exitCode : null,
        });
    },
  };
  target = result;
  return result;
}
module.exports = { createDiagnostics, logToolFailure, summarizeTool };
