'use strict';

const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const historyLimit = 60;
const outputName = /^(?:混剪-\d{14}-\d{2}(?:-\d+)?\.mp4|提取音频-\d{14}-\d{2}(?:-\d+)?\.mp3)$/;

async function readHistory(directory) {
  const file = path.join(directory, 'work-history.json');
  try {
    if ((await fs.stat(file)).size > 256 * 1024) return [];
    const rows = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!Array.isArray(rows)) return [];
    return rows.filter((item) => typeof item?.path === 'string' && path.isAbsolute(item.path)
      && path.basename(item.path) === item.name && outputName.test(item.name)
      && Number.isFinite(Date.parse(item.createdAt))).slice(0, historyLimit);
  } catch {
    return [];
  }
}

async function remember(directory, history, results) {
  const createdAt = new Date().toISOString();
  const entries = results.map(({ name, path: file }) => ({ name, path: file, createdAt }));
  history.unshift(...entries.reverse());
  history.length = Math.min(history.length, historyLimit);

  const pending = path.join(directory, `work-history-${randomUUID()}.tmp`);
  try {
    await fs.writeFile(pending, JSON.stringify(history, null, 2), { encoding: 'utf8', flag: 'wx' });
    await fs.rename(pending, path.join(directory, 'work-history.json'));
  } finally {
    await fs.rm(pending, { force: true });
  }
}

module.exports = { readHistory, remember };
