'use strict';

(() => {
  const messages = (
    typeof module === 'object' && module.exports ? require('./messages-zh-cn.js') : window.editorMessages
  ).narrationTrim;
  const rate = 48000;
  const samples = (seconds) => Math.round(seconds * rate);
  const smartDefaults = Object.freeze({
    mode: 'smart',
    thresholdDb: -40,
    minSilenceMs: 120,
    paddingMs: 120,
    fadeMs: 100,
  });
  const legacyDefaults = Object.freeze({ ...smartDefaults, mode: 'legacy' });

  function normalizeSettings(value) {
    if (value === undefined) return legacyDefaults;
    if (!value || !['smart', 'legacy'].includes(value.mode)) throw Error(messages.invalidMode);
    const settings = { ...(value.mode === 'smart' ? smartDefaults : legacyDefaults) };
    for (const [key, min, max] of [
      ['thresholdDb', -65, -15],
      ['minSilenceMs', 100, 5000],
      ['paddingMs', 0, 500],
      ['fadeMs', 80, 150],
    ]) {
      if (value[key] === undefined) continue;
      if (
        !Number.isFinite(value[key]) ||
        (key !== 'thresholdDb' && !Number.isInteger(value[key])) ||
        value[key] < min ||
        value[key] > max
      )
        throw Error(messages.invalidParameters);
      settings[key] = value[key];
    }
    return settings;
  }

  // Keep the user's playback order, including repeated ranges. Round cumulative
  // boundaries so thousands of short sped-up pieces cannot drift independently.
  function sourcePieces(ranges, speed) {
    let sourceSamples = 0;
    return ranges.flatMap((range) => {
      const start = samples(range.start),
        end = samples(range.end);
      const at = Math.round(sourceSamples / speed);
      sourceSamples += end - start;
      const until = Math.round(sourceSamples / speed);
      return until > at ? [{ start, end, at, until }] : [];
    });
  }

  function project(part, source) {
    return part.at + Math.round(((source - part.start) * (part.until - part.at)) / (part.end - part.start));
  }

  // FFmpeg reports non-overlapping pauses in source order. Seek to the active
  // source window when an editor redraws several takes of a long recording.
  function firstPause(pauses, sourceSample) {
    let low = 0,
      high = pauses.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (samples(pauses[middle].end) < sourceSample) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  function edgeTrim(part, pauses, head, padding, minimum) {
    const target = head ? part.start : part.end;
    const pause = pauses[firstPause(pauses, target)];
    if (!pause || samples(pause.start) > target) return 0;
    const edge = head ? Math.min(part.end, samples(pause.end)) : Math.max(part.start, samples(pause.start));
    const quiet = head ? project(part, edge) - part.at : part.until - project(part, edge);
    return quiet >= minimum ? Math.max(0, quiet - padding) : 0;
  }

  function breakpoint(parts, cues, pauses, limit) {
    if (!limit) return { end: 0, reason: 'hard' };
    const earliest = Math.max(1, limit - rate / 2);
    let sentence = 0,
      silence = 0;
    for (const part of parts) {
      if (part.until < earliest || part.at > limit) continue;
      for (const cue of cues) {
        const end = samples(cue.end / 1000);
        if (end <= part.start || end > part.end || !/[。！？!?….][”’」』"')）\]]*\s*$/u.test(cue.text)) continue;
        const at = project(part, end);
        if (at >= earliest && at <= limit) sentence = Math.max(sentence, at);
      }
      const sourceAt = (t) => part.start + ((t - part.at) * (part.end - part.start)) / (part.until - part.at);
      const lower = Math.max(part.start, Math.floor(sourceAt(earliest)) - 1);
      const upper = Math.min(part.end, Math.ceil(sourceAt(limit)) + 1);
      for (let i = firstPause(pauses, lower); i < pauses.length && samples(pauses[i].start) <= upper; i++) {
        const gap = pauses[i];
        const start = Math.max(part.start, samples(gap.start)),
          end = Math.min(part.end, samples(gap.end));
        if (end <= start) continue;
        const from = project(part, start),
          to = project(part, end);
        if (from > limit || to < earliest) continue;
        const at = Math.max(earliest, Math.min(limit, Math.round((from + to) / 2)));
        silence = Math.max(silence, at);
      }
    }
    if (sentence) return { end: sentence, reason: 'sentence' };
    if (silence) return { end: silence, reason: 'pause' };
    return { end: limit, reason: 'hard' };
  }

  function buildMap({
    asset,
    ranges = undefined,
    speed = 1,
    available = Infinity,
    caption = undefined,
    settings = undefined,
    picture = false,
    trimHead = false,
    trimTail = false,
    pauses = asset.narrationPauses ?? [],
  }) {
    const policy = normalizeSettings(settings);
    const pieces = sourcePieces(ranges ?? [{ start: 0, end: asset.duration }], speed);
    const total = pieces.at(-1)?.until ?? 0;
    let head = 0,
      end = total,
      reason = 'none',
      fade = 0;
    if (total && !picture && (trimHead || trimTail)) {
      const analyzed =
        policy.mode === 'smart'
          ? pauses
          : [
              { start: 0, end: asset.edgeSilence?.leading ?? 0 },
              { start: asset.duration - (asset.edgeSilence?.trailing ?? 0), end: asset.duration },
            ];
      const padding = policy.mode === 'smart' ? policy.paddingMs * 48 : 0.025 * rate;
      const minimum = policy.mode === 'smart' ? policy.minSilenceMs * 48 : 0.12 * rate;
      if (trimHead) head = edgeTrim(pieces[0], analyzed, true, padding, minimum);
      if (trimTail) end -= edgeTrim(pieces.at(-1), analyzed, false, padding, minimum);
      const allQuiet = analyzed[0]?.start === 0 && analyzed[0].end >= asset.duration;
      if (allQuiet || end - head < 0.1 * rate) {
        head = 0;
        end = total;
      }
      if (head || end < total) reason = 'seam';
    }
    const limit = Math.max(0, samples(available));
    if (end - head > limit) {
      end = head + limit;
      reason = 'hard';
      if (picture && policy.mode === 'smart') {
        ({ end, reason } = breakpoint(pieces, caption?.cues ?? [], pauses, end));
        if (reason === 'hard') fade = Math.min(end - head, policy.fadeMs * 48);
      }
    }
    const parts = [];
    for (const p of pieces) {
      const at = Math.max(head, p.at),
        until = Math.min(end, p.until);
      if (until <= at) continue;
      const sourceAt = (t) => Math.round(p.start + ((t - p.at) * (p.end - p.start)) / (p.until - p.at));
      const start = sourceAt(at),
        stop = sourceAt(until);
      if (stop > start)
        parts.push({
          start: start / rate,
          end: stop / rate,
          outStart: (at - head) / rate,
          outEnd: (until - head) / rate,
        });
    }
    return {
      parts,
      duration: (end - head) / rate,
      trimStart: head / rate,
      trimEnd: (total - end) / rate,
      fadeDuration: fade / rate,
      reason,
    };
  }

  function mapCaptions(map, caption, offset = 0, rowLimit = Infinity) {
    if (!caption || !map.parts.length || rowLimit <= 0) return [];
    const result = [];
    const origin = samples(offset);
    function append(cue, start, end) {
      const from = Math.ceil((origin + samples(start)) / 48),
        until = Math.floor((origin + samples(end)) / 48);
      if (until > from) result.push({ ...cue, start: from, end: until });
    }
    if (typeof caption === 'string') append({ text: caption }, 0, map.duration);
    else
      for (const part of map.parts) {
        const scale = (part.outEnd - part.outStart) / (part.end - part.start);
        for (const cue of caption.cues ?? []) {
          const start = Math.max(part.start, cue.start / 1000),
            end = Math.min(part.end, cue.end / 1000);
          if (end > start)
            append(cue, part.outStart + (start - part.start) * scale, part.outStart + (end - part.start) * scale);
          if (result.length >= rowLimit) return result;
        }
      }
    return result;
  }

  const api = { smartDefaults, legacyDefaults, normalizeSettings, buildMap, mapCaptions };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else window.narrationTrim = api;
})();
