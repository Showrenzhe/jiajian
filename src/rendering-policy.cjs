'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function read(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function createRenderingPolicy(directory, now = Date.now) {
  const file = path.join(directory, 'rendering.json');
  let state = read(file);
  function save(value) {
    const temp = file + '.' + randomUUID() + '.tmp';
    try {
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(temp, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
      fs.renameSync(temp, file);
      state = value;
    } finally {
      fs.rmSync(temp, { force: true });
    }
  }
  // Capture the legacy preference before another performance setting rewrites performance.json.
  if (typeof state.software !== 'boolean')
    save({ software: read(path.join(directory, 'performance.json')).gpu === false });
  const active = state.software;
  let lastCrash;
  return {
    active,
    get software() {
      return state.software;
    },
    set(software) {
      if (typeof software !== 'boolean') throw Error('兼容模式设置无效。');
      save({ software });
      lastCrash = undefined;
    },
    processGone({ type, reason }) {
      if (
        type !== 'GPU' ||
        !['abnormal-exit', 'crashed', 'oom', 'launch-failed', 'integrity-failure'].includes(reason) ||
        active ||
        state.software
      )
        return;
      const time = now();
      if (lastCrash !== undefined && time - lastCrash <= 60000) save({ software: true, notify: true });
      lastCrash = time;
    },
    consumeNotice() {
      if (!active || !state.notify) return false;
      save({ software: true });
      return true;
    },
  };
}

module.exports = { createRenderingPolicy };
