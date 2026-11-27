'use strict';

(() => {
  const messages = (typeof module === 'object' && module.exports
    ? require('./messages-zh-cn.js') : window.editorMessages).batchRandom;
  function newSettings() {
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
    const seed = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    return { algorithm: 1, seed, minDifferentShots: 0, avoidSameOpening: false };
  }

  function normalizeSettings(value) {
    if (value === undefined) return newSettings();
    if (value?.algorithm !== 1 || typeof value.seed !== 'string' || !/^[0-9a-f]{32}$/.test(value.seed)
        || !Number.isInteger(value.minDifferentShots) || value.minDifferentShots < 0 || value.minDifferentShots > 1000
        || typeof value.avoidSameOpening !== 'boolean') throw Error(messages.invalidSettings);
    const { algorithm, seed, minDifferentShots, avoidSameOpening } = value;
    return { algorithm, seed, minDifferentShots, avoidSameOpening };
  }

  function normalizePreference(value = 'normal') {
    if (!['normal', 'required', 'low'].includes(value)) throw Error(messages.invalidPreference);
    return value;
  }

  function eligibleCandidates(items, preference = item => item.batchPreference) {
    const required = items.filter(item => normalizePreference(preference(item)) === 'required');
    return required.length ? required : items;
  }

  function combinationCount(sizes) {
    return sizes.reduce((product, size) => product * BigInt(size), 1n);
  }

  // Algorithm 1: mix the four seed words with the stable JSON namespace, then
  // use the sfc32 integer recurrence. No paths, runtime asset IDs or clocks.
  function randomFor(seed, ...stableParts) {
    const namespace = JSON.stringify(stableParts);
    let hash = 2166136261;
    for (let i = 0; i < namespace.length; i++) hash = Math.imul(hash ^ namespace.charCodeAt(i), 16777619);
    let [a, b, c, d] = seed.match(/.{8}/g).map(word => parseInt(word, 16) ^ hash);
    function next() {
      const result = (a + b + d) | 0;
      d = (d + 1) | 0;
      a = b ^ (b >>> 9);
      b = (c + (c << 3)) | 0;
      c = (((c << 21) | (c >>> 11)) + result) | 0;
      return (result >>> 0) / 4294967296;
    }
    for (let i = 0; i < 16; i++) next();
    return next;
  }

  function planningRandom(settings, activeId) {
    return activeId != null
      ? randomFor(settings.seed, 'subproject', activeId) : randomFor(settings.seed, 'main');
  }

  function shuffledOrder(size, random) {
    const order = Array.from({length: size}, (_, i) => i);
    for (let i = 0; i + 1 < size; i++) {
      const j = i + Math.floor(random() * (size - i));
      [order[i], order[j]] = [order[j], order[i]];
    }
    return order;
  }

  // Preserve the existing even rotation. Each orbit spans the lcm of the deck
  // lengths; gcd(previous period, size) gives this deck's independent shifts.
  function combinations(decks) {
    let period = 1n;
    const offsets = decks.map(deck => {
      const size = BigInt(deck.length);
      let a = period, b = size;
      while (b) [a, b] = [b, a % b];
      period = period / a * size;
      return a;
    });
    return function rowAt(index) {
      const step = BigInt(index) % period;
      let orbit = BigInt(index) / period;
      return decks.map((deck, group) => {
        const shift = orbit % offsets[group];
        orbit /= offsets[group];
        return deck[Number((step + shift) % BigInt(deck.length))];
      });
    };
  }

  function pictureDeck(shot, random) {
    const candidates = new Map();
    for (const index of shuffledOrder(shot.length, random)) {
      const clip = shot[index];
      if (!candidates.has(clip.batchSlot)) candidates.set(clip.batchSlot, []);
      candidates.get(clip.batchSlot).push(index);
    }
    // Interleave the orientations of each candidate, including repeated uses
    // of the same file as independently trimmed candidates.
    const variants = [...candidates.values()];
    const order = [];
    for (let i = 0; order.length < shot.length; i++) {
      for (const entries of variants) if (i < entries.length) order.push(entries[i]);
    }
    return order;
  }

  function weightedDeck(order, shot, random) {
    if (!shot.some(clip => clip.batchPreference === 'low') || shot.every(clip => clip.batchPreference === 'low')) return order;
    // Normal candidates have two tickets per cycle, low-frequency candidates
    // have one. Spread tickets so one candidate's tickets are never adjacent
    // merely because they were added together.
    const tickets = [];
    order.forEach((index, position) => {
      tickets.push({index, time: 2 * position});
      if (shot[index].batchPreference !== 'low') {
        tickets.push({index, time: (2 * position + order.length) % (2 * order.length)});
      }
    });
    tickets.sort((a, b) => a.time - b.time);
    const start = Math.floor(random() * tickets.length);
    return tickets.slice(start).concat(tickets.slice(0, start)).map(ticket => ticket.index);
  }

  // Small distance-only problems admit an exact check. A greedy first pair
  // can otherwise block a valid batch (e.g. three binary shots, distance two).
  function searchSmallSpace(vectors, minimum, target, initial) {
    const compatible = vectors.map((a, i) => vectors.map((b, j) => {
      if (i >= j) return false;
      let differences = 0;
      for (let k = 0; k < a.length; k++) if (a[k] !== b[k] && ++differences >= minimum) return true;
      return false;
    }));
    let best = initial, budget = 20000;
    const selected = [];
    function visit(remaining) {
      if (selected.length > best.length) best = selected.slice();
      for (let i = 0; i < remaining.length; i++) {
        if (best.length >= target || budget <= 0 || selected.length + remaining.length - i <= best.length) return;
        budget--;
        const next = remaining[i];
        selected.push(next);
        visit(remaining.slice(i + 1).filter(index => compatible[next][index]));
        selected.pop();
      }
    }
    visit(vectors.map((_, i) => i));
    return {best, complete: budget > 0 || best.length >= target};
  }

  function drawBatch({shots, extraSizes, count, settings, random, unordered, pinOpening}) {
    const sizes = shots.map(shot => shot.length).concat(extraSizes);
    const space = combinationCount(sizes);
    const decks = count === 1 ? sizes.map(size => Array.from({length: size}, (_, i) => i))
      : shots.map(shot => pictureDeck(shot, random)).concat(extraSizes.map(size => shuffledOrder(size, random)));
    const canonical = combinations(decks);
    const weightedDecks = decks.map((order, group) => group < shots.length ? weightedDeck(order, shots[group], random) : order);
    const weighted = weightedDecks.some((deck, i) => deck !== decks[i]) ? combinations(weightedDecks) : null;
    const rows = [], seen = new Set();
    const variableShots = shots.flatMap((shot, index) => new Set(shot.map(clip => clip.batchSlot)).size > 1 ? [index] : []);
    const distance = settings.minDifferentShots;
    const openingSources = new Set((unordered && !pinOpening ? shots : shots.slice(0, 1)).flatMap(shot => shot.map(clip => clip.originalMaterialId)));
    let upperBound = space;
    if (distance > 0) {
      // After omitting N-1 variable positions, the projected vectors must
      // still be unique. Removing the largest alphabets gives the best bound.
      const alphabets = variableShots.map(i => new Set(shots[i].map(clip => clip.batchSlot)).size).sort((a, b) => b - a);
      upperBound = combinationCount(alphabets.slice(distance - 1));
    }
    if (settings.avoidSameOpening && openingSources.size === 1) upperBound = 1n;
    let lastOpening;
    let remainingComparisons = 3000000;
    const distinctPictures = new Set();
    function shotOrder() {
      const order = shots.map((_, i) => i);
      if (unordered) {
        const first = pinOpening ? 1 : 0;
        for (let i = order.length - 1; i > first; i--) {
          const other = first + Math.floor(random() * (i + 1 - first));
          [order[i], order[other]] = [order[other], order[i]];
        }
      }
      return order;
    }
    function consider(indices) {
      const key = indices.join(',');
      if (seen.has(key)) return;
      const pictures = distance ? variableShots.map(i => shots[i][indices[i]].batchSlot).join(',') : undefined;
      if (distance && distinctPictures.has(pictures)) return;
      if (distance > 1) {
        for (const previous of rows) {
          let changes = 0;
          for (const i of variableShots) {
            if (--remainingComparisons <= 0) return;
            if (shots[i][indices[i]].batchSlot !== shots[i][previous.indices[i]].batchSlot && ++changes >= distance) break;
          }
          if (changes < distance) return;
        }
      }
      const order = shotOrder();
      const sourceAt = group => shots[group][indices[group]].originalMaterialId;
      if (settings.avoidSameOpening && rows.length && sourceAt(order[0]) === lastOpening) {
        const other = unordered && !pinOpening ? order.findIndex(group => sourceAt(group) !== lastOpening) : -1;
        if (other < 0) return;
        [order[0], order[other]] = [order[other], order[0]];
      }
      lastOpening = sourceAt(order[0]);
      rows.push({indices, order});
      seen.add(key);
      if (distance) distinctPictures.add(pictures);
    }

    const finished = () => rows.length >= count || BigInt(rows.length) >= upperBound || remainingComparisons <= 0;
    if (count === 1) {
      consider(weightedDecks.map(deck => deck[Math.floor(random() * deck.length)]));
    } else {
      // The weighted stream can repeat tuples. An unweighted exhaustive stream
      // supplies remaining unique tuples near capacity. Strict searches have
      // a deterministic budget, including when the Cartesian space is huge.
      const constrained = distance > 0 || settings.avoidSameOpening;
      const budget = Math.max(count, Math.min(16000, Math.floor(2000000 / sizes.length)));
      if (weighted) {
        const preferredLimit = Math.min(budget, count * 4);
        for (let i = 0; i < preferredLimit && !finished(); i++) consider(weighted(i));
      }
      const attempts = constrained ? budget : count + rows.length;
      // A second pass can place a previously deferred opening after a new one.
      for (let pass = 0; pass < (settings.avoidSameOpening ? 2 : 1) && !finished(); pass++) {
        const before = rows.length;
        for (let i = 0; i < attempts && BigInt(i) < space && !finished(); i++) consider(canonical(i));
        if (rows.length === before) break;
      }
    }
    let proven = BigInt(rows.length) >= upperBound;
    if (!proven && rows.length < count && distance > 1 && !settings.avoidSameOpening && space <= 48n && shots.length <= 32) {
      const all = Array.from({length:Number(space)}, (_, i) => canonical(i));
      const vectors = all.map(indices => variableShots.map(i => shots[i][indices[i]].batchSlot));
      const keys = new Map(all.map((indices, i) => [indices.join(','), i]));
      const current = rows.map(({indices}) => keys.get(indices.join(',')));
      const {best, complete} = searchSmallSpace(vectors, distance, Math.min(count, Number(upperBound)), current);
      if (best.length > rows.length) rows.splice(0, rows.length, ...best.map(i => ({indices:all[i], order:shotOrder()})));
      proven = complete;
    }
    const reason = rows.length === count ? null : proven ? 'impossible' : 'budget';
    return {rows, summary: {totalSpace: space.toString(), requested: count, actual: rows.length, reason}};
  }

  const api = {newSettings, normalizeSettings, normalizePreference, eligibleCandidates, combinationCount, randomFor, planningRandom, drawBatch};
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.batchVariations = api;
})();
