'use strict';

(() => {
  const messages = (
    typeof module === 'object' && module.exports ? require('./messages-zh-cn.js') : window.editorMessages
  ).musicMix;
  const rate = 48000;
  const rounded = (seconds) => Math.round(seconds * rate) / rate;
  const smartDefaults = Object.freeze({
    mode: 'smart',
    ducking: true,
    duckDb: 9,
    releaseMs: 300,
    crossfadeMs: 200,
    normalizeLufs: null,
    compensateManual: false,
  });
  const legacyDefaults = Object.freeze({ ...smartDefaults, mode: 'legacy' });

  function normalizeSettings(value) {
    if (value === undefined) return legacyDefaults;
    if (!value || !['legacy', 'smart'].includes(value.mode)) throw Error(messages.invalid);
    const result = { ...smartDefaults, mode: value.mode };
    for (const [key, min, max] of [
      ['duckDb', 6, 12],
      ['releaseMs', 200, 400],
      ['crossfadeMs', 100, 300],
    ]) {
      if (value[key] === undefined) continue;
      if (!Number.isFinite(value[key]) || value[key] < min || value[key] > max) throw Error(messages.invalid);
      result[key] = value[key];
    }
    for (const key of ['ducking', 'compensateManual']) {
      if (value[key] === undefined) continue;
      if (typeof value[key] !== 'boolean') throw Error(messages.invalid);
      result[key] = value[key];
    }
    if (value.normalizeLufs !== undefined) {
      if (![null, -14, -16].includes(value.normalizeLufs)) throw Error(messages.invalid);
      result.normalizeLufs = value.normalizeLufs;
    }
    return result;
  }

  function compensationGain(loudness, enabled) {
    if (!enabled || !Number.isFinite(loudness?.integratedLufs) || !Number.isFinite(loudness?.truePeakDbtp)) return 1;
    const db = Math.min(12, Math.max(-12, -18 - loudness.integratedLufs));
    const peakLimited = db > 0 ? Math.max(-12, Math.min(db, -1 - loudness.truePeakDbtp)) : db;
    return 10 ** (peakLimited / 20);
  }

  function gainAt(points, time) {
    if (!points.length) return 1;
    let lo = 0,
      hi = points.length;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (points[mid].time <= time) lo = mid + 1;
      else hi = mid;
    }
    if (!lo) return 1;
    const before = points[lo - 1],
      after = points[lo];
    return after
      ? before.gain + ((after.gain - before.gain) * (time - before.time)) / (after.time - before.time)
      : before.gain;
  }

  function duckEnvelope(intervals, settings) {
    if (settings.mode !== 'smart' || !settings.ducking) return [];
    const ranges = [];
    for (const interval of [...intervals].sort((a, b) => a.start - b.start)) {
      const start = rounded(Math.max(0, interval.start)),
        end = rounded(interval.end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
      const last = ranges.at(-1);
      if (last && start <= last.end) last.end = Math.max(last.end, end);
      else ranges.push({ start, end });
    }
    const points = [],
      low = 10 ** (-settings.duckDb / 20);
    function point(time, gain) {
      if (points.at(-1)?.time === time) points.at(-1).gain = gain;
      else points.push({ time, gain });
    }
    for (const { start, end } of ranges) {
      const initial = gainAt(points, start);
      if (points.at(-1)?.time > start) points.pop();
      point(start, initial);
      point(Math.min(end, rounded(start + 0.01)), low);
      point(end, low);
      point(rounded(end + settings.releaseMs / 1000), 1);
    }
    return points;
  }

  function loopTiming(sourceDuration, speed, crossfadeMs, playDuration) {
    const samples = Math.max(1, Math.round((sourceDuration * rate) / speed));
    const overlap =
      Math.round(playDuration * rate) > samples
        ? Math.min(Math.floor(samples / 2), Math.max(0, Math.round((crossfadeMs * rate) / 1000)))
        : 0;
    return { length: samples / rate, overlap: overlap / rate, period: (samples - overlap) / rate };
  }

  function loopAt(t, timing) {
    const sample = Math.max(0, Math.round(t * rate)),
      period = Math.round(timing.period * rate);
    const overlap = Math.round(timing.overlap * rate);
    if (sample < period) return [{ position: sample / rate, gain: 1 }];
    const phase = sample % period;
    if (phase >= overlap) return [{ position: phase / rate, gain: 1 }];
    return [
      { position: (period + phase) / rate, gain: 1 - phase / overlap },
      { position: phase / rate, gain: phase / overlap },
    ];
  }

  const api = {
    smartDefaults,
    legacyDefaults,
    normalizeSettings,
    compensationGain,
    duckEnvelope,
    gainAt,
    loopTiming,
    loopAt,
  };
  if (typeof window !== 'undefined') window.musicMix = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})();
