'use strict';

(() => {
  const {usesPlacedVideoSource} = typeof module === 'object' && module.exports ? require('./track-tools.js') : window;
  const maxCandidates = 100;
  const minClipSeconds = 0.1;
  const minEdgeSilence = 0.12;
  const seamPadding = 0.025;
  const audioRate = 48000;

  // A match is an explicit edit to this candidate. Source in/out points stay in source time.
  function matchCandidateDuration(clip,seconds) {
    if(!Number.isFinite(seconds) || seconds<.000001 || seconds>86400) throw Error('请选择有效的口播时长。');
    const length=(clip.ranges?.reduce((sum,r)=>sum+r.end-r.start,0) ?? clip.end-clip.start)
      -(clip.look?.head ?? 0)-(clip.look?.tail ?? 0);
    if(!Number.isFinite(length) || !(length>0)) throw Error('请先检查候选素材的入点和出点。');
    const speed=clip.asset.kind==='image' ? 1 : Math.max(1,length/seconds);
    if(clip.matchedDuration===seconds && clip.speed===speed) return false;
    clip.matchedDuration=seconds;
    clip.speed=speed;
    return true;
  }

  function withOutputFrames(clip, duration, fps) {
    const outputFrames = Math.max(1, Math.ceil(duration * fps - 1e-7));
    return { ...clip, outputFrames, outputDuration: outputFrames / fps };
  }

  function voiceLength(clip) {
    const source = clip.narrationRanges?.reduce((sum, range) => sum + range.end - range.start, 0) ?? clip.narration.duration;
    return source / (clip.narrationSpeed ?? 1);
  }

  function voiceRange(clips, index) {
    const clip = clips[index];
    const voice = clip.narration;
    const duration = voiceLength(clip);
    const { leading = 0, trailing = 0 } = voice.edgeSilence ?? {};
    const first = clip.narrationRanges?.[0], last = clip.narrationRanges?.at(-1);
    const speed = clip.narrationSpeed ?? 1;
    const head = (first ? Math.min(first.end - first.start, leading - first.start) : leading)/speed;
    const tail = (last ? Math.min(last.end - last.start, trailing - (voice.duration - last.end)) : trailing)/speed;
    const start = clips[index - 1]?.narration && head >= minEdgeSilence ? head - seamPadding : 0;
    const end = clips[index + 1]?.narration && tail >= minEdgeSilence ? tail - seamPadding : 0;
    if (!Number.isFinite(start + end) || duration - start - end < minClipSeconds) {
      return { narrationStart: 0, narrationDuration: duration };
    }
    return { narrationStart: start, narrationDuration: duration - start - end };
  }

  function pieces(clip) {
    if (!clip.retainedRanges) return [clip];
    const { retainedRanges, ...base } = clip;
    return retainedRanges.map(({ start, end }) => ({
      ...base, start, sourceDuration: end - start, duration: (end - start) / base.speed,
      layerStart: start - base.candidateStart,
    }));
  }

  function trimVisualEnd(visual, seconds) {
    const sourceDuration = seconds * (visual.speed ?? 1);
    return { ...visual, sourceDuration, duration: seconds };
  }

  function referenceVisuals(clip, target, frames, fps) {
    const original = pieces(clip);
    if (clip.duration <= target) {
      if (clip.matchedDuration) repeatVisual(original, target - clip.duration);
      return fitVisuals(clip, original, visualDuration(original) / target, frames, fps);
    }
    let remaining = target;
    const kept = [];
    for (const visual of original) {
      kept.push(visual.duration > remaining ? trimVisualEnd(visual, remaining) : visual);
      remaining -= visual.duration;
      if (remaining < 1e-9) break;
    }
    return fitVisuals(clip, kept, 1, frames, fps);
  }

  function visualDuration(visuals) {
    return visuals.reduce((seconds, visual) => seconds + visual.duration * (visual.repeat ?? 1), 0);
  }

  function repeatVisual(visuals, seconds) {
    if (seconds <= 1e-9) return;
    const shortest = visuals.reduce((best, visual) => visual.duration < best.duration ? visual : best);
    const repeat = Math.max(1, Math.ceil(seconds / shortest.duration - 1e-7));
    if (shortest === visuals.at(-1)) visuals[visuals.length - 1] = { ...shortest, repeat: repeat + 1 };
    else visuals.push({ ...shortest, repeat });
  }

  function fitVisuals(clip, visuals, tempo, outputFrames, fps) {
    let duration = 0;
    let assigned = 0;
    const parts = visuals.map((visual, index) => {
      duration += visual.duration * (visual.repeat ?? 1) / tempo;
      const boundary = index === visuals.length - 1 ? outputFrames : Math.min(outputFrames, Math.round(duration * fps));
      const frames = boundary - assigned;
      assigned = boundary;
      return { ...visual, speed: (visual.speed ?? 1) * tempo, outputFrames: frames, outputDuration: frames / fps };
    });
    return { ...clip, visuals: parts, outputFrames, outputDuration: outputFrames / fps };
  }

  // Keep the shot clock independent from the positioned candidate's retained source and playback rate.
  function placedVideoFrames(clip, outputFrames, fps) {
    return clip.retainedRanges ? fitVisuals(clip,pieces(clip),1,outputFrames,fps)
      : { ...clip, outputFrames, outputDuration:outputFrames/fps };
  }

  function fitSegmentedVoice(clips, pools, fps, alignment, preserveFixedClock = false) {
    let samples = 0;
    let assigned = 0;
    return clips.map((clip, index) => {
      const range = clip.narration ? (alignment === 'reference'
        ? { narrationStart: 0, narrationDuration: voiceLength(clip) } : voiceRange(clips, index)) : null;
      const fixedClock = preserveFixedClock && !range ? clip.shotDuration : undefined;
      const target = range ? (clip.voiceOffset ?? 0) + range.narrationDuration
        : fixedClock ?? withOutputFrames(clip, clip.shotDuration ?? clip.duration, fps).outputDuration;
      const clipSamples = Math.round(target * audioRate);
      const timelineDuration = fixedClock ?? clipSamples / audioRate;
      samples += clipSamples;
      const frameBoundary = samples * fps / audioRate;
      const boundary = index === clips.length - 1 ? Math.ceil(frameBoundary) : Math.round(frameBoundary);
      const outputFrames = boundary - assigned;
      assigned = boundary;
      const timed = { ...clip, ...range, timelineDuration };
      if (!range && usesPlacedVideoSource(clip.clip ?? clip,false)) return placedVideoFrames(timed,outputFrames,fps);
      if (range && alignment === 'reference') return referenceVisuals(timed, target, outputFrames, fps);
      if (!range && !clip.retainedRanges && !clip.shotDuration) return { ...timed, outputFrames, outputDuration: outputFrames / fps };
      const visuals = [];
      let duration = 0;
      for (const visual of pools[index]) {
        visuals.push(...pieces(visual));
        duration += visual.duration;
        if (duration >= target - 1e-9) break;
      }
      repeatVisual(visuals, target - duration);
      const tempo = Math.max(1, visualDuration(visuals) / target);
      return fitVisuals(timed, visuals, tempo, outputFrames, fps);
    });
  }

  function fitWholeVoice(clips, pools, target, fps) {
    const selections = pools.map(([selected]) => [selected]);
    const base = clips.reduce((seconds, clip) => seconds + clip.duration, 0);
    let duration = base;
    for (let candidate = 1; candidate < maxCandidates && duration < target - 1e-9; candidate += 1) {
      for (const [index, pool] of pools.entries()) {
        const visual = pool[candidate];
        if (!visual) continue;
        selections[index].push(visual);
        duration += visual.duration;
        if (duration >= target - 1e-9) break;
      }
    }
    const shortfall = target - duration;
    for (const [i, selected] of selections.entries()) selections[i] = selected.flatMap(pieces);
    if (shortfall > 1e-9) {
      for (const [index, visuals] of selections.entries()) repeatVisual(visuals, shortfall * clips[index].duration / base);
    }
    const durations = selections.map(visualDuration);
    const tempo = Math.max(1, durations.reduce((total, seconds) => total + seconds, 0) / target);
    const outputFrames = withOutputFrames(clips[0], target, fps).outputFrames;
    let elapsed = 0;
    let assigned = 0;
    return clips.map((clip, index) => {
      elapsed += durations[index] / tempo;
      const boundary = index === clips.length - 1 ? outputFrames : Math.min(outputFrames, Math.round(elapsed * fps));
      const frames = boundary - assigned;
      assigned = boundary;
      return fitVisuals(clip, selections[index], tempo, frames, fps);
    });
  }

  function fitReferenceWhole(clips, target, fps) {
    const total = clips.reduce((sum, clip) => sum + clip.duration, 0);
    const stretch = Math.max(1, target / total);
    const result = [];
    let elapsed = 0;
    let assigned = 0;
    for (const clip of clips) {
      const seconds = Math.min(target - elapsed, clip.duration * stretch);
      if (seconds <= 1e-9) break;
      elapsed += seconds;
      const boundary = elapsed >= target - 1e-9 ? Math.ceil(target * fps - 1e-7) : Math.round(elapsed * fps);
      if (boundary > assigned) result.push(referenceVisuals(clip, seconds, boundary - assigned, fps));
      assigned = boundary;
    }
    return result;
  }

  const api = { matchCandidateDuration, maxCandidates, minClipSeconds, minEdgeSilence, audioRate, withOutputFrames, voiceLength, pieces, repeatVisual, visualDuration, fitVisuals, placedVideoFrames, fitSegmentedVoice, fitWholeVoice, fitReferenceWhole };
  if (typeof module === "object" && module.exports) module.exports = api;
  else window.voiceAlignment = api;
})();
