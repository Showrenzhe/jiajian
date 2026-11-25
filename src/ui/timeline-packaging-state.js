'use strict';

// Track ownership follows shot objects when the user inserts, reorders or removes shots.
window.createTimelinePackaging = function () {
  const fresh = () => ({global: [], composites: [], textGroups: [], wholeNarration: [], segmentNarration: [], textMode: 'whole', textSelection: 'ordered'});
  let data = fresh();
  let order = [];
  function forShots(shots) {
    if (order.length !== shots.length || shots.some((shot, i) => shot !== order[i])) {
      const indices = new Map(order.map((shot, i) => [shot, i]));
      const align = (row) => shots.map((shot) => row[indices.get(shot)] ?? []);
      if (data.segmentNarration.length) data.segmentNarration = align(data.segmentNarration);
      if (data.textMode === 'segmented') data.textGroups = data.textGroups.map(align);
      order = [...shots];
    }
    return data;
  }
  function load(value, shots) {
    data = Object.assign(fresh(), structuredClone(value ?? {}));
    order = [...shots];
  }
  function choices(shots, controls) {
    const pack = window.trackControls.enabledPackaging(forShots(shots), controls);
    const alternatives = (groups) => BigInt(Math.max(1, groups.filter(Boolean).length));
    let total = alternatives(pack.composites.map((row) => row.length));
    if (pack.textMode === 'segmented' && pack.textSelection === 'random') {
      for (let i = 0; i < shots.length; i++) total *= alternatives(pack.textGroups.map((row) => row[i]?.length));
    } else total *= alternatives(pack.textGroups.map((row) => pack.textMode === 'whole' ? row[0]?.length : row.some((col) => col.length)));
    return total;
  }
  return {forShots, load, choices};
};
