'use strict';

(() => {
  const {usesPlacedVideoSource,applyVideoSpeedDecision,videoSpeedDecision} = typeof module === 'object' && module.exports ? require('./track-tools.js') : window;
  const maxCandidates = 100;
  const minClipSeconds = 0.1;
  const minEdgeSilence = 0.12;
  const seamPadding = 0.025;
  const audioRate = 48000;

  // A match is an explicit edit to this candidate. Source in/out points stay in source time.
  function matchCandidateDuration(clip,seconds,decision) {
    if (clip.speedMode==='manual' || (clip.speedMode==='legacy' && !decision) || (decision && decision.status!=='ready')) return false;
    if(!Number.isFinite(seconds) || seconds<.000001 || seconds>86400) throw Error('请选择有效的口播时长。');
    if (decision) {
      if (decision.target!==seconds) throw RangeError((typeof module==='object' && module.exports ? require('./messages-zh-cn.js') : window.editorMessages).speedPlanningErrors.windowChanged);
      const changed=applyVideoSpeedDecision(clip,decision) || clip.matchedDuration!==seconds || Boolean(clip.autoFitSpeed);
      clip.matchedDuration=seconds;
      delete clip.autoFitSpeed;
      return changed;
    }
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

  // Each cut shares its neighbour's boundary. Keep the last partial frame and
  // the one-frame minimum for independently visible, very fast picture edits.
  function pictureFrames(durations, fps) {
    let elapsed = 0;
    let assigned = 0;
    return durations.map((duration, i) => {
      elapsed += Math.max(1, duration * fps);
      const end = i === durations.length - 1 ? Math.ceil(elapsed - 1e-7) : Math.round(elapsed + 1e-7);
      const count = end - assigned;
      assigned = end;
      return count;
    });
  }

  function voiceLength(clip) {
    const source = clip.narrationRanges?.reduce((sum, range) => sum + range.end - range.start, 0) ?? clip.narration.duration;
    return source / (clip.narrationSpeed ?? 1);
  }

  function voiceRange(clips, index) {
    const clip = clips[index];
    return retainedVoiceRange(clip,Boolean(clips[index-1]?.narration),Boolean(clips[index+1]?.narration));
  }
  function retainedVoiceRange(clip,trimHead,trimTail) {
    if (clip.narrationMap) return {narrationStart:clip.narrationMap.trimStart, narrationDuration:clip.narrationMap.duration};
    const voice = clip.narration;
    const duration = voiceLength(clip);
    const { leading = 0, trailing = 0 } = voice.edgeSilence ?? {};
    const first = clip.narrationRanges?.[0], last = clip.narrationRanges?.at(-1);
    const speed = clip.narrationSpeed ?? 1;
    const head = (first ? Math.min(first.end - first.start, leading - first.start) : leading)/speed;
    const tail = (last ? Math.min(last.end - last.start, trailing - (voice.duration - last.end)) : trailing)/speed;
    const start = trimHead && head >= minEdgeSilence ? head - seamPadding : 0;
    const end = trimTail && tail >= minEdgeSilence ? tail - seamPadding : 0;
    if (!Number.isFinite(start + end) || duration - start - end < minClipSeconds) {
      return { narrationStart: 0, narrationDuration: duration };
    }
    return { narrationStart: start, narrationDuration: duration - start - end };
  }

  function appendLegacyCaptionCues(cues, caption, offset, speechDuration, speechStart = 0, speed = 1) {
    if (!caption) return;
    const start = Math.max(0, Math.ceil(offset * 1000 - 1e-7));
    const stop = Math.floor((offset + speechDuration) * 1000 + 1e-7);
    if (stop <= start) return;
    if (typeof caption === 'string') {
      cues.push({ start, end: stop, text: caption });
      return;
    }
    const sourceStart = speechStart * 1000;
    for (const cue of caption.cues) {
      const shiftedStart = Math.max(start, Math.round(offset * 1000 + (cue.start - sourceStart)/speed));
      const shiftedEnd = Math.min(Math.round(offset * 1000 + (cue.end - sourceStart)/speed), stop);
      if (shiftedEnd > shiftedStart) cues.push({ ...cue,start: shiftedStart, end: shiftedEnd });
    }
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

  function fixedSpeedPolicy(picture) {
    return picture.speedOverflow || picture.speedMode==='manual';
  }

  function groupAlternatives(selected,pool) {
    const asset=selected.asset ?? selected.clip?.asset;
    return pool.slice(1).filter(other=>{
      const candidate=other.asset ?? other.clip?.asset;
      return !other.hiddenVideo && candidate && !candidate.missing && candidate!==asset &&
        (!selected.originalMaterialId || other.originalMaterialId!==selected.originalMaterialId) &&
        (!asset?.id || candidate.id!==asset.id) && (!asset?.path || candidate.path!==asset.path);
    });
  }

  function checkSpeedWindow(picture,pool,target,options) {
    const {range,choices,report}=options ?? {};
    const asset=picture.asset ?? picture.clip?.asset;
    if (!range || !asset || asset.kind!=='video' || !(target>0) || picture.speedMode==='legacy' || fixedSpeedPolicy(picture)) return picture;
    const existing=picture.videoWindow ?? (picture.autoFitSpeed ? picture.videoDuration : undefined) ?? picture.matchedDuration;
    if (picture.speedMode==='auto' && Math.abs(target-existing)<1e-7) return picture;
    const sourceSeconds=picture.sourceDuration ?? picture.duration*(picture.speed ?? 1);
    const sample={asset,start:0,end:sourceSeconds};
    const settings={...range,hasGroup:groupAlternatives(picture,pool).length>0};
    let decision=videoSpeedDecision(sample,target,settings);
    if (!decision.direction) return picture;
    const key=decision.direction+':'+(settings.hasGroup ? 'group' : 'single');
    if (choices?.[key]) decision=videoSpeedDecision(sample,target,{...settings,choice:choices[key]});
    if (decision.status==='choice') {
      // Passive timeline measurements must not commit a choice or change the
      // current playback rate merely because a voice track was selected.
      if (!report) return {...picture,speedMode:'manual'};
      report({...decision,key,shotIndex:picture.shotIndex,name:asset.name,sourceSeconds});
      // The batch stays pending until all its actual windows have a choice.
      decision=videoSpeedDecision(sample,target,{...settings,choice:decision.direction==='high' ? 'trim-start' : 'hold'});
    }
    return {...picture,speed:decision.speed,duration:sourceSeconds/decision.speed,speedOverflow:decision.strategy};
  }

  // A committed speed owns the source clock. Only select source intervals, repeat
  // an edited cycle, or extend its last frame to fill the requested output window.
  function fixedSpeedVisuals(clip, pool, target, frames, fps) {
    const strategy=clip.speedOverflow;
    const original=pieces(clip);
    const duration=visualDuration(original);
    if (!(duration>0)) return fitVisuals(clip,original,1,frames,fps);
    if (strategy==='loop' && duration<target-1e-9) {
      const repeat=Math.ceil(target/duration-1e-9);
      const cycle={...original[0],repeat,duration,...(original.length>1 && {cycleParts:original})};
      return fitVisuals(clip,[cycle],1,frames,fps);
    }
    const candidates=[...original];
    if (strategy==='group' && duration<target) {
      for (const other of groupAlternatives(clip,pool)) candidates.push(...pieces(other));
    }
    let skip=strategy==='trim-end' ? Math.max(0,duration-target) : 0;
    let remaining=target;
    const kept=[];
    for (const part of candidates) {
      if (skip>=part.duration-1e-9 && skip>0) { skip-=part.duration; continue; }
      const rate=part.speed ?? 1;
      const take=Math.min(remaining,part.duration-skip);
      if (take>1e-9) kept.push({...part,start:part.start+skip*rate,layerStart:(part.layerStart ?? 0)+skip*rate,
        duration:take,sourceDuration:take*rate});
      remaining-=take;
      skip=0;
      if (remaining<1e-9) break;
    }
    if (remaining>1e-9 && kept.length) kept[kept.length-1].holdLast=true;
    return fitVisuals(clip,kept,1,frames,fps);
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

  function visitVisualIntervals(part, span, visit) {
    const pieces=part.cycleParts ?? [part];
    const repeats=part.repeat ?? 1;
    let elapsed=0;
    for (let i=0;i<repeats && elapsed<span-1e-9;i++) {
      for (const source of pieces) {
        const speed=source.speed ?? 1;
        const natural=(source.sourceDuration ?? source.duration*speed)/speed;
        const length=Math.min(natural,span-elapsed);
        if (length>0) visit(source,elapsed,length,speed);
        elapsed+=length;
      }
    }
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
      const protectedRate=visual.speedMode==='manual';
      return { ...visual, speed: (visual.speed ?? 1) * (protectedRate ? 1 : tempo), outputFrames: frames, outputDuration: frames / fps,
        ...(protectedRate && frames/fps>visual.duration && {holdLast:true}) };
    });
    return { ...clip, visuals: parts, outputFrames, outputDuration: outputFrames / fps };
  }

  // Filling a shot can introduce another source with its own rate. Audit the
  // actual parts after the common tempo is applied, including their repeats.
  function fitAutomaticVisuals(clip,pool,visuals,tempo,frames,fps,options) {
    const plan=fitVisuals(clip,visuals,tempo,frames,fps);
    if (!options?.range || clip.speedMode==='legacy') return plan;
    const {min,max}=options.range;
    plan.visuals=plan.visuals.flatMap(part=>{
      if (!part.outputFrames || !part.sourceDuration || part.speedMode==='legacy' || fixedSpeedPolicy(part) ||
          (part.speed>=min-1e-9 && part.speed<=max+1e-9)) return [part];
      const siblings=[part,...pool.filter(other=>other.asset!==part.asset || other.clip!==part.clip)];
      const target=part.outputDuration;
      const picture={...part,shotIndex:clip.shotIndex,repeat:undefined};
      const revised=checkSpeedWindow(picture,siblings,target,options);
      if (revised.speedMode==='manual' && !options.report) {
        const current={...revised,speed:part.sourceDuration/part.duration};
        return fixedSpeedVisuals(current,siblings,target,part.outputFrames,fps).visuals;
      }
      if (!revised.speedOverflow) {
        // A single complete pass still fits when a provisional repeat would
        // have required an excessive speed. Keep the whole source in that slot.
        const speed=part.sourceDuration/target;
        if (speed<min-1e-9 || speed>max+1e-9) return [part];
        return [{...picture,speed,duration:target}];
      }
      return fixedSpeedVisuals(revised,siblings,target,part.outputFrames,fps).visuals;
    });
    return plan;
  }

  // Keep the shot clock independent from the positioned candidate's retained source and playback rate.
  function placedVideoFrames(clip, outputFrames, fps) {
    return clip.retainedRanges ? fitVisuals(clip,pieces(clip),1,outputFrames,fps)
      : { ...clip, outputFrames, outputDuration:outputFrames/fps };
  }

  function fitSegmentedVoice(clips, pools, fps, alignment, preserveFixedClock = false, options) {
    let samples = 0;
    let assigned = 0;
    return clips.map((clip, index) => {
      const range = clip.narration ? (alignment === 'reference'
        ? { narrationStart: 0, narrationDuration: voiceLength(clip) } : voiceRange(clips, index)) : null;
      const fixedClock = preserveFixedClock && !range ? clip.shotDuration : undefined;
      const target = range ? (clip.voiceOffset ?? 0) + range.narrationDuration
        : Math.max(1 / fps, clip.shotDuration ?? clip.duration);
      const clipSamples = Math.round(target * audioRate);
      const timelineDuration = fixedClock ?? clipSamples / audioRate;
      samples += clipSamples;
      const frameBoundary = samples * fps / audioRate;
      const boundary = index === clips.length - 1 ? Math.ceil(frameBoundary) : Math.round(frameBoundary);
      const outputFrames = boundary - assigned;
      assigned = boundary;
      const timed = { ...checkSpeedWindow(clip,pools[index],target,options), ...range, timelineDuration };
      if (fixedSpeedPolicy(timed)) return fixedSpeedVisuals(timed,pools[index],target,outputFrames,fps);
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
      return fitAutomaticVisuals(timed,pools[index],visuals,tempo,outputFrames,fps,options);
    });
  }

  function fitWholeVoice(clips, pools, target, fps,options) {
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
      const seconds=durations[index]/tempo;
      elapsed += seconds;
      const boundary = index === clips.length - 1 ? outputFrames : Math.min(outputFrames, Math.round(elapsed * fps));
      const frames = boundary - assigned;
      assigned = boundary;
      const timed=checkSpeedWindow(clip,pools[index],seconds,options);
      if (fixedSpeedPolicy(timed)) return fixedSpeedVisuals(timed,pools[index],seconds,frames,fps);
      return fitAutomaticVisuals(clip,pools[index],selections[index],tempo,frames,fps,options);
    });
  }

  function fitReferenceWhole(clips, target, fps,pools=clips.map(clip=>[clip]),options) {
    const total = clips.reduce((sum, clip) => sum + clip.duration, 0);
    const stretch = Math.max(1, target / total);
    const result = [];
    let elapsed = 0;
    let assigned = 0;
    for (const [index,clip] of clips.entries()) {
      const seconds = Math.min(target - elapsed, clip.duration * stretch);
      if (seconds <= 1e-9) break;
      elapsed += seconds;
      const boundary = elapsed >= target - 1e-9 ? Math.ceil(target * fps - 1e-7) : Math.round(elapsed * fps);
      const timed=checkSpeedWindow(clip,pools[index],seconds,options);
      if (boundary > assigned) result.push(fixedSpeedPolicy(timed) ? fixedSpeedVisuals(timed,pools[index],seconds,boundary-assigned,fps)
        : referenceVisuals(clip, seconds, boundary - assigned, fps));
      assigned = boundary;
    }
    return result;
  }

  const api = { matchCandidateDuration, maxCandidates, minClipSeconds, minEdgeSilence, audioRate, withOutputFrames, pictureFrames, voiceLength, retainedVoiceRange, appendLegacyCaptionCues, pieces, repeatVisual, visualDuration, visitVisualIntervals, fitVisuals, fitAutomaticVisuals, fixedSpeedPolicy, fixedSpeedVisuals, checkSpeedWindow, placedVideoFrames, fitSegmentedVoice, fitWholeVoice, fitReferenceWhole };
  if (typeof module === "object" && module.exports) module.exports = api;
  else window.voiceAlignment = api;
})();
