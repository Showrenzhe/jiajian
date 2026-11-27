'use strict';

// Short, retimed tracks use one sample-accurate Web Audio loop. Longer tracks
// keep two streaming decoders, so memory is independent of composition length.
window.createDraftMusic = function (bus, notifyError) {
  let entry,
    rate,
    context,
    level,
    source,
    shortBuffer,
    streams = [],
    running = false;
  let started = 0,
    failed = false;
  let cachedLoop;
  function unavailable() {
    if (!failed) notifyError?.();
    failed = true;
    for (const stream of streams) stream.audio.pause();
    bus.playing(false);
    return true;
  }
  function stop() {
    if (!entry) return;
    if (source) {
      source.stop();
      source.disconnect();
      source = undefined;
    }
    for (const { audio, input, fade } of streams) {
      audio.pause();
      input.disconnect();
      fade.disconnect();
      audio.removeAttribute('src');
      audio.load();
    }
    streams = [];
    level.disconnect();
    entry = undefined;
    shortBuffer = undefined;
    running = false;
    bus.playing(false);
  }
  function loopBuffer(pcm, timing) {
    if (cachedLoop?.pcm === pcm && cachedLoop.period === timing.period) return cachedLoop.buffer;
    const frames = Math.max(1, Math.round(timing.length * 48000));
    const buffer = context.createBuffer(2, frames, 48000);
    const first = Math.round(timing.period * 48000);
    for (let channel = 0; channel < 2; channel++) {
      const out = buffer.getChannelData(channel);
      for (let i = 0; i < frames; i++) out[i] = pcm.samples[2 * i + channel] ?? 0;
      for (let i = first; i < frames; i++) {
        let sample = 0;
        for (const branch of window.musicMix.loopAt(i / 48000, timing)) {
          sample += (pcm.samples[2 * Math.round(branch.position * 48000) + channel] ?? 0) * branch.gain;
        }
        out[i] = sample;
      }
    }
    cachedLoop = { pcm, period: timing.period, buffer };
    return buffer;
  }
  function createStream() {
    const audio = new Audio();
    audio.crossOrigin = 'anonymous';
    audio.preload = 'auto';
    audio.src = entry.asset.url;
    audio.playbackRate = entry.rate * rate;
    const input = context.createMediaElementSource(audio),
      fade = context.createGain();
    input.connect(fade);
    fade.connect(level);
    fade.gain.value = 0;
    return { audio, input, fade, cycle: -1 };
  }
  function prepare(next, at, shuttleRate) {
    if (next !== entry || rate !== shuttleRate) {
      stop();
      entry = next;
      rate = shuttleRate;
      failed = false;
      started = performance.now();
      const output = bus.output();
      context = output.context;
      if (context.state === 'suspended') context.resume().catch(() => {});
      level = context.createGain();
      level.connect(output);
      if (entry.pcm) shortBuffer = loopBuffer(entry.pcm, entry.timing);
      else streams = entry.timing.overlap > 0 ? [createStream(), createStream()] : [createStream()];
    }
    if (failed) return true;
    if (context.state !== 'running' && performance.now() - started > 10000) return unavailable();
    if (shortBuffer) return context.state === 'running';
    const elapsed = at - entry.start,
      cycle = Math.floor(Math.round(elapsed * 48000) / Math.round(entry.timing.period * 48000));
    const branches = window.musicMix.loopAt(elapsed, entry.timing);
    let ready = true;
    for (const stream of streams) stream.active = false;
    for (const [i, branch] of branches.entries()) {
      const step = branches.length === 2 && i === 0 ? cycle - 1 : cycle;
      const stream = streams[step % streams.length],
        audio = stream.audio;
      const target = branch.position * entry.rate;
      stream.active = true;
      if (audio.error || (audio.readyState < 1 && performance.now() - started > 10000)) return unavailable();
      if (audio.readyState < 1) {
        ready = false;
        continue;
      }
      if (stream.cycle !== step || Math.abs(audio.currentTime - target) > 0.2 * audio.playbackRate) {
        if (!audio.seeking && Math.abs(audio.currentTime - target) > 0.01) audio.currentTime = target;
        stream.cycle = step;
      }
      if (audio.seeking || audio.readyState < 2) ready = false;
      const gain = stream.fade.gain,
        now = context.currentTime;
      gain.cancelScheduledValues(now);
      gain.setValueAtTime(branch.gain, now);
      if (branches.length === 2) {
        const left = entry.timing.overlap - branches[1].position;
        if (left > 0) gain.linearRampToValueAtTime(i === 0 ? 0 : 1, now + left / rate);
      }
    }
    for (const stream of streams) {
      if (stream.active || stream.cycle === -1) continue;
      stream.audio.pause();
      stream.fade.gain.value = 0;
      stream.cycle = -1;
      if (stream.audio.readyState >= 1) stream.audio.currentTime = 0;
    }
    return ready && context.state === 'running';
  }
  function play(at) {
    if (failed) return;
    if (!running) {
      const now = context.currentTime,
        elapsed = at - entry.start;
      level.gain.setValueAtTime(entry.gain * window.musicMix.gainAt(entry.envelope, at), now);
      for (const point of entry.envelope) {
        if (point.time > at)
          level.gain.linearRampToValueAtTime(point.gain * entry.gain, now + (point.time - at) / rate);
      }
      if (shortBuffer) {
        source = context.createBufferSource();
        source.buffer = shortBuffer;
        source.loop = true;
        source.loopStart = entry.timing.overlap;
        source.loopEnd = entry.timing.length;
        source.playbackRate.value = rate;
        source.connect(level);
        const offset =
          elapsed < entry.timing.length
            ? elapsed
            : entry.timing.overlap + ((elapsed - entry.timing.length) % entry.timing.period);
        source.start(now, offset);
      }
      running = true;
      bus.playing(true);
    }
    for (const { active, audio } of streams) {
      if (active && audio.paused && !audio.error && !audio.seeking && audio.readyState >= 2)
        audio.play().catch(() => {});
    }
  }
  return { prepare, play, stop };
};
