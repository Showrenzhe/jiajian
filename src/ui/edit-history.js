'use strict';

(() => {
  function serialize(snapshot) {
    // Object property order does not change the meaning of a JSON snapshot.
    const ordered = new WeakMap();
    const result = JSON.stringify(snapshot, (_key, value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
      if (!ordered.has(value)) {
        ordered.set(value, Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]])));
      }
      return ordered.get(value);
    });
    if (result === undefined) throw new TypeError('An edit snapshot must be a JSON value.');
    return result;
  }

  function createEditHistory(initial, { limit = 50 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError('The history limit must be a nonnegative integer.');
    const past = [];
    const future = [];
    let current = serialize(initial);
    let activeGroup;

    function remember(previous) {
      if (!limit) return;
      past.push(previous);
      if (past.length > limit) past.shift();
    }

    function finishGroup() {
      if (!activeGroup) return;
      if (activeGroup.before !== current) remember(activeGroup.before);
      activeGroup = undefined;
    }

    function record(snapshot, { group } = {}) {
      const next = serialize(snapshot);
      const continues = activeGroup && group != null && Object.is(group, activeGroup.key);
      if (!continues) finishGroup();
      if (next === current) return false;

      if (group == null) remember(current);
      else if (!continues) activeGroup = { key: group, before: current };
      current = next;
      future.length = 0;
      return true;
    }

    function undo() {
      finishGroup();
      if (!past.length) return undefined;
      future.push(current);
      current = past.pop();
      return JSON.parse(current);
    }

    function redo() {
      finishGroup();
      if (!future.length) return undefined;
      remember(current);
      current = future.pop();
      return JSON.parse(current);
    }

    function reset(snapshot) {
      current = serialize(snapshot);
      past.length = 0;
      future.length = 0;
      activeGroup = undefined;
    }

    return {
      record, undo, redo, reset,
      canUndo: () => Boolean(past.length || (limit && activeGroup && activeGroup.before !== current)),
      canRedo: () => future.length > 0,
    };
  }

  if (typeof module === 'object' && module.exports) module.exports = { createEditHistory };
  else window.createEditHistory = createEditHistory;
})();
