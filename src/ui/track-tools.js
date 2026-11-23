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

  // A timeline tail trim limits the edited picture without changing its shot or playback rate.
  function pictureSpan(clip, shotSpan) {
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
  const tools = { splitRanges, candidateVideoLanes, pinCandidateLanes, pictureSpan, videoLaneCells, emptyVideoCells, soloLaneSequence, usesPlacedVideoSource };
  if (typeof module === 'object' && module.exports) module.exports = tools;
  else Object.assign(window, tools);
})();
