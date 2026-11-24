'use strict';

(() => {
  function splitRanges(start, end, { point, interval, maxParts = 16, minDuration = 0.1 } = {}) {
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
      throw new RangeError('素材裁切范围无效。');
    }
    if (!Number.isFinite(minDuration) || minDuration <= 0) throw new RangeError('最短片段时长必须大于 0。');
    if ((point === undefined) === (interval === undefined)) throw new Error('请选择按播放位置或固定时长切片。');
    if (!Number.isSafeInteger(maxParts) || maxParts < 1) throw new RangeError('可切分段数无效。');
    if (maxParts < 2) throw new RangeError('分镜数量已达上限，无法继续切分。');

    const tolerance = Math.min(1e-9, minDuration * 1e-6);
    const shortest = minDuration - tolerance;
    if (point !== undefined) {
      if (!Number.isFinite(point) || point - start < shortest || end - point < shortest) {
        throw new RangeError(`请将播放位置移到有效范围内，分割后每段至少 ${minDuration} 秒。`);
      }
      return [{ start, end: point }, { start: point, end }];
    }

    if (!Number.isFinite(interval) || interval < shortest) {
      throw new RangeError(`每段切片时长至少 ${minDuration} 秒。`);
    }
    const duration = end - start;
    const fullParts = Math.floor(duration / interval);
    const tail = duration - fullParts * interval;
    const count = fullParts + Number(tail >= shortest);
    if (!Number.isSafeInteger(count) || count > maxParts) {
      throw new RangeError(`当前工程最多可切成 ${maxParts} 段，请增大每段时长。`);
    }
    if (count < 2) throw new RangeError('素材时长不足以按当前设置切成两段。');

    // Counting the slices first avoids walking the file in small increments.
    const ranges = [];
    let position = start;
    for (let index = 1; index <= count; index += 1) {
      const next = index === count ? end : start + index * interval;
      if (next - position < shortest || next > end) throw new RangeError('切片边界过短，请增大每段时长。');
      ranges.push({ start: position, end: next });
      position = next;
    }
    return ranges;
  }

  // Candidate order drives montage choices. A physical lane may be empty above a candidate.
  function candidateVideoLanes(shot, limit = Infinity) {
    const reserved = new Map();
    for (const clip of shot) {
      const lane = clip?.videoLane;
      if (lane === undefined) continue;
      const positions = reserved.get(lane) ?? new Set();
      if (!Number.isInteger(lane) || lane < 0 || lane >= limit || positions.has(clip.videoStart)) {
        throw new Error('分镜中的视频轨编号无效或重复。');
      }
      positions.add(clip.videoStart);
      reserved.set(lane, positions);
    }
    let next = 0;
    return shot.map(clip => {
      if (clip?.videoLane !== undefined) return clip.videoLane;
      while (reserved.has(next)) next++;
      return next++;
    });
  }

  function pinCandidateLanes(shot) {
    const lanes = candidateVideoLanes(shot);
    shot.forEach((clip, i) => { clip.videoLane = lanes[i]; });
  }

  function fitVideoSpeed(sourceSeconds, windowSeconds) {
    return sourceSeconds > 0 && windowSeconds > 0 ? sourceSeconds / windowSeconds : 1;
  }

  // A 0.1-second cut can occupy a project window of up to one day.
  const minVideoSpeed = 0.000001;

  function placedVideoSpeed(clip) {
    const span = clip.videoWindow ?? (clip.videoFit === 'hold' ? clip.videoDuration : undefined);
    if (!clip.autoFitSpeed || !span) return clip.speed === undefined ? 1 : clip.speed;
    const retained = clip.ranges?.reduce((seconds, r) => seconds + (r.end - r.start), 0) ?? (clip.end - clip.start);
    return fitVideoSpeed(retained - (clip.look?.head ?? 0) - (clip.look?.tail ?? 0), span);
  }

  function sampleVideoRate(rate) {
    return rate > 16 || (rate > 0 && rate < 0.0625);
  }

  function nativeVideoRate(rate) {
    return Number.isFinite(rate) && rate > 0 ? Math.max(.0625,Math.min(16,rate)) : 1;
  }

  // A timeline tail trim limits the edited picture without changing its shot or playback rate.
  function pictureSpan(clip, shotSpan) {
    if(clip?.videoWindow!==undefined) return clip.videoWindow;
    if (clip?.videoFit === 'hold') return clip.videoDuration;
    return Math.min(shotSpan, clip?.videoDuration ?? shotSpan);
  }

  function videoLaneCells(shots, starts, widths) {
    const lanes = [];
    shots.forEach((shot, index) => {
      candidateVideoLanes(shot).forEach((lane, candidate) => {
        const clip = shot[candidate];
        (lanes[lane] ??= []).push({clip, index, start:clip.videoStart ?? starts[index], span:pictureSpan(clip, widths[index])});
      });
    });
    return lanes;
  }

  // A placed clip keeps its montage owner, but covers time on the physical lane.
  function emptyVideoCells(cells, starts, widths) {
    const occupied = [...cells].sort((a, b) => a.start - b.start);
    const gaps = [];
    let next = 0, busyUntil = 0;
    starts.forEach((start, index) => {
      const end = start + widths[index];
      let cursor = Math.max(start, busyUntil);
      while (next < occupied.length && occupied[next].start < end - 1e-7) {
        const cell = occupied[next++];
        if (cell.start > cursor + 1e-7) gaps.push({index, start:cursor, span:cell.start - cursor});
        busyUntil = Math.max(busyUntil, cell.start + cell.span);
        cursor = Math.max(cursor, busyUntil);
      }
      if (cursor < end - 1e-7) gaps.push({index, start:cursor, span:end - cursor});
    });
    return gaps;
  }

  // Keep empty insertions with their owning candidate, including after the last shot.
  function reservedVideoCells(cells) {
    return cells.flatMap(({clip,index})=>(clip.videoGaps ?? []).map(gap=>({...gap,index,gap,anchor:clip})));
  }

  function normalizeVideoGaps(gaps) {
    if(!Array.isArray(gaps) || gaps.some(gap=>!Number.isFinite(gap?.start) || gap.start<0 ||
        !Number.isFinite(gap.span) || gap.span<=0 || gap.start+gap.span>Number.MAX_SAFE_INTEGER)) throw Error('视频轨空位范围无效。');
    return gaps.map(({start,span})=>({start,span}));
  }

  function videoGroupLeaders(clips,lanes=candidateVideoLanes(clips)) {
    const seen=new Set();
    return clips.filter((clip,index)=>{
      if(!clip.videoGroup) return true;
      const key=lanes[index]+'/'+clip.videoGroup;
      if(seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function joinedVideoSequence(shot,focus) {
    if(!focus?.videoGroup) return [];
    const variants=shot.filter(clip=>Boolean(clip.mirror)===Boolean(focus.mirror));
    const lanes=candidateVideoLanes(variants);
    const lane=lanes[variants.indexOf(focus)];
    return variants.filter((clip,i)=>clip.enabled!==false && clip.videoGroup===focus.videoGroup && lanes[i]===lane)
      .sort((a,b)=>a.videoStart-b.videoStart);
  }

  // Solo monitors a physical video track. Distinct placements on that track
  // play in time order even when their montage alternatives share one owner.
  function soloLaneSequence(shot, focus, controls, shotSpan) {
    if (focus?.videoStart === undefined || !controls || (focus.videoLane !== undefined && !controls['vis' + focus.videoLane]?.solo)) return [];
    const variants = shot.filter(clip => Boolean(clip.mirror) === Boolean(focus.mirror));
    const lanes = candidateVideoLanes(variants);
    const lane = lanes[variants.indexOf(focus)];
    if (!controls['vis' + lane]?.solo) return [];
    const sequence = variants.filter((clip, i) => lanes[i] === lane && clip.enabled !== false && clip.videoStart !== undefined)
      .sort((a, b) => a.videoStart - b.videoStart);
    if (sequence.length < 2 || !sequence.includes(focus) || !sequence.some(clip => clip.videoFit === 'hold')) return [];
    let end = 0;
    for (const clip of sequence) {
      const span = pictureSpan(clip, shotSpan ?? clip.shotDuration ?? clip.videoDuration ?? clip.duration);
      if (!(span > 0) || clip.videoStart < end - 1e-7) return [];
      end = clip.videoStart + span;
    }
    return sequence;
  }

  function usesPlacedVideoSource(clip, voicePriority) {
    return !voicePriority && clip?.asset?.kind === 'video' && clip.videoStart !== undefined
      && clip.videoDuration !== undefined && clip.matchedDuration === undefined;
  }
  const tools = { splitRanges, candidateVideoLanes, pinCandidateLanes, minVideoSpeed, fitVideoSpeed, placedVideoSpeed, sampleVideoRate, nativeVideoRate, pictureSpan, videoLaneCells, emptyVideoCells,
    reservedVideoCells, normalizeVideoGaps, videoGroupLeaders, joinedVideoSequence, soloLaneSequence, usesPlacedVideoSource };
  if (typeof module === 'object' && module.exports) module.exports = tools;
  else Object.assign(window, tools);
})();
