'use strict';

window.mountCutFilmstrip = function mountCutFilmstrip(target, asset, initialRanges) {
  const fps = asset.fps || 30;
  const frames = new Map();
  const pending = new Set();
  const failed = new Set();
  const groups = [];
  let wanted = new Set();
  let ranges = initialRanges, dragging = false, closed = false, paintRequest;

  target.setAttribute('aria-hidden', 'true');
  const selector = CSS.escape(asset.id);
  // Reuse pictures already decoded for this source, including when the editor
  // opens while the desktop thumbnail workers are busy with other tracks.
  for (const image of document.querySelectorAll('img[data-thumb="' + selector + '"][src]')) {
    const time = Number(image.dataset.time);
    if (image.naturalWidth && Number.isFinite(time)) frames.set(time, image);
    if (frames.size >= 64) break;
  }
  if (!frames.size) {
    const poster = document.querySelector('[data-material-id="' + selector + '"] .material-thumbnail img[src]');
    if (poster?.naturalWidth) frames.set(asset.duration >= .25 ? Math.min(1, asset.duration / 10) : 0, poster);
  }

  function nearestTime(time) {
    let best, distance = Infinity;
    for (const at of frames.keys()) {
      const delta = Math.abs(at - time);
      if (delta < distance) { best = at; distance = delta; }
    }
    return best;
  }

  function paint() {
    for (const {tiles, range} of groups) {
      for (const tile of tiles) {
        const picture = frames.get(tile.time) || frames.get(nearestTime(tile.time));
        if (!picture) continue;
        if (tile.picture !== picture) {
          tile.picture = picture;
          tile.image.src = picture.currentSrc || picture.src;
        } else if (tile.effect === tile.nextEffect) continue;
        if (tile.canvas) {
          window.drawCutPicture(tile.canvas, picture, range, picture.naturalWidth, picture.naturalHeight);
        }
        tile.effect = tile.nextEffect;
      }
    }
  }

  async function load(time) {
    pending.add(time);
    try {
      const url = await window.workbench.clipThumbnail(asset.id, time);
      if (closed) return;
      if (!url) throw Error();
      const image = new Image();
      image.src = url;
      await image.decode();
      if (closed) return;
      frames.set(time, image);
      if (frames.size > 96) {
        for (const key of frames.keys()) if (!wanted.has(key)) { frames.delete(key); break; }
      }
      paint();
    } catch { if (!closed && wanted.has(time)) failed.add(time); }
    finally { pending.delete(time); pump(); }
  }

  // Cover the unrepresented parts first. With only two IPC requests in flight,
  // closing a material never leaves a whole strip queued ahead of the next one.
  function pump() {
    while (!closed && !dragging && pending.size < 2) {
      const known = [...frames.keys(), ...pending];
      let next, gap = -1;
      for (const time of wanted) {
        if (frames.has(time) || pending.has(time) || failed.has(time)) continue;
        const distance = known.length ? Math.min(...known.map(at => Math.abs(at - time))) : Infinity;
        if (distance > gap) { next = time; gap = distance; }
      }
      if (next === undefined) break;
      void load(next);
    }
  }

  function draw() {
    paintRequest = undefined;
    if (closed) return;
    const width = target.clientWidth, duration = ranges.reduce((sum, r) => sum + r.end - r.start, 0);
    if (!width || !(duration > 0)) return;
    const aspect = asset.width && asset.height ? asset.width / asset.height : 16 / 9;
    const tileWidth = Math.max(width / 24, Math.min(100, Math.max(38, target.clientHeight * aspect)));
    wanted = new Set();
    while (groups.length > ranges.length) groups.pop().element.remove();
    let elapsed = 0;
    ranges.forEach((range, i) => {
      if (!groups[i]) {
        const element = document.createElement('span');
        target.append(element);
        groups.push({element, tiles:[]});
      }
      const group = groups[i], span = range.end - range.start;
      group.range = range;
      group.element.style.flexGrow = String(span);
      // Round cumulative boundaries so hundreds of tiny edits cannot enqueue
      // hundreds of thumbnail jobs. Large visible ranges retain their own tiles.
      const visibleTiles = Math.round((elapsed + span) / duration * width / tileWidth) -
        Math.round(elapsed / duration * width / tileWidth);
      const count = Math.max(1, visibleTiles);
      elapsed += span;
      while (group.tiles.length > count) {
        const tile = group.tiles.pop();
        tile.canvas?.remove();
        tile.image.remove();
      }
      const transformed = Boolean(range.crop || range.mirror || range.rotation);
      const effect = transformed ? JSON.stringify([range.crop, range.mirror, range.rotation]) : '';
      // A source-frame grid keeps most samples stable over small trim changes.
      const spacing = 2 ** Math.max(0, Math.floor(Math.log2(span * fps / (4 * count))));
      for (let j = 0; j < count; j++) {
        if (!group.tiles[j]) {
          const image = document.createElement('img');
          image.alt = '';
          image.draggable = false;
          group.element.append(image);
          group.tiles.push({image});
        }
        const tile = group.tiles[j];
        if (transformed && !tile.canvas) {
          tile.canvas = document.createElement('canvas');
          tile.image.after(tile.canvas);
          tile.image.hidden = true;
        } else if (!transformed && tile.canvas) {
          tile.canvas.remove();
          tile.canvas = undefined;
          tile.image.hidden = false;
        }
        tile.nextEffect = effect;
        const offset = span * (j + .5) / count;
        const center = range.reverse ? range.end - offset : range.start + offset;
        const grid = Math.round(center * fps / spacing) * spacing / fps;
        const cached = nearestTime(center);
        if (cached >= range.start && cached < range.end && Math.abs(cached-center) <= span / (5*count)) {
          tile.time = cached;
        } else {
          tile.time = Math.round((grid >= range.start && grid < range.end ? grid : center) * 1000) / 1000;
        }
        if (visibleTiles) wanted.add(tile.time);
      }
    });
    for (const time of failed) if (!wanted.has(time)) failed.delete(time);
    paint();
    pump();
  }

  const resize = new ResizeObserver(draw);
  resize.observe(target);
  draw();
  return {
    update(nextRanges, trimming = false) {
      if (ranges === nextRanges && dragging === trimming) return;
      ranges = nextRanges;
      dragging = trimming;
      if (dragging) {
        if (paintRequest === undefined) paintRequest = requestAnimationFrame(draw);
      } else {
        cancelAnimationFrame(paintRequest);
        draw();
      }
    },
    destroy() {
      closed = true;
      resize.disconnect();
      cancelAnimationFrame(paintRequest);
      frames.clear();
      wanted.clear();
      groups.length = 0;
    },
  };
};
