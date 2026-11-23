'use strict';

// Each group occupies its duration in the edited sequence. Its frames are
// sampled inside that group's original source range, even after reordering.
window.mountCutFilmstrip = function mountCutFilmstrip(target, asset, initialRanges) {
  let ranges = initialRanges;
  let signature;
  let waiting = [];
  let loading = 0;
  let timer;
  let closed = false;
  target.setAttribute('aria-hidden', 'true');

  function load() {
    while (!closed && loading < 2 && waiting.length) {
      const { image, time } = waiting.shift();
      loading++;
      window.workbench.clipThumbnail(asset.id, time).then((url) => {
        if (url && !closed && target.contains(image)) image.src = url;
      }).catch(() => {}).finally(() => {
        loading--;
        if (!timer) load();
      });
    }
  }

  function draw() {
    const width = target.clientWidth;
    const duration = ranges.reduce((sum, range) => sum + range.end - range.start, 0);
    if (closed || !width || !(duration > 0)) return;
    const aspect = asset.width > 0 && asset.height > 0 ? asset.width / asset.height : 16 / 9;
    const tileWidth = Math.max(width / 24, Math.min(100, Math.max(38, target.clientHeight * aspect)));
    const groups = ranges.map(range => {
      const {start,end} = range;
      const pixels = width * (end - start) / duration;
      const count = pixels < tileWidth / 3 ? 0 : Math.max(1, Math.round(pixels / tileWidth));
      return { ...range, count };
    });
    const next = JSON.stringify(groups);
    if (next === signature) return;
    signature = next;
    clearTimeout(timer);
    waiting = [];
    const strip = document.createDocumentFragment();
    for (const range of groups) {
      const {start,end,reverse,count} = range;
      const group = document.createElement('span');
      group.style.flexGrow = String(end - start);
      strip.append(group);
      for (let i = 0; i < count; i++) {
        const image = document.createElement('img');
        image.alt = '';
        image.draggable = false;
        image.decoding = 'async';
        group.append(image);
        if (range.crop || range.mirror || range.rotation) {
          const canvas = document.createElement('canvas');
          group.append(canvas);
          image.hidden = true;
          image.onload = () => {
            if (!closed && target.contains(canvas))
              window.drawCutPicture(canvas, image, range, image.naturalWidth, image.naturalHeight);
          };
        }
        const offset = (i + 0.5) * (end - start) / count;
        waiting.push({ image, time: reverse ? end - offset : start + offset });
      }
    }
    target.replaceChildren(strip);
    // Avoid queuing transient frames while the user drags a trim handle.
    timer = setTimeout(() => { timer = undefined; load(); }, 85);
  }

  const resize = new ResizeObserver(draw);
  resize.observe(target);
  draw();
  return {
    update(nextRanges) { ranges = nextRanges; draw(); },
    destroy() {
      closed = true;
      clearTimeout(timer);
      waiting = [];
      resize.disconnect();
    },
  };
};
