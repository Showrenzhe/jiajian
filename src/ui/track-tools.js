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

  if (typeof module === 'object' && module.exports) module.exports = { splitRanges };
  else window.splitRanges = splitRanges;
})();
