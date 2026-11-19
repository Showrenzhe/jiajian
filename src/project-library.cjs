'use strict';

const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const libraryName = 'recent-projects.json';
const maxProjects = 40;
const maxBytes = 1024 * 1024;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const pendingWrites = new WeakMap();

function projectPath(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\0') || /^[\\/]{2}/.test(file)) return null;
  if (process.platform === 'win32' && (!/^[a-z]:[\\/]/i.test(file) || file.slice(2).includes(':'))) return null;
  const normalized = path.normalize(file);
  return path.extname(normalized).toLowerCase() === '.sdworkbench' ? normalized : null;
}

function pathKey(file) {
  return process.platform === 'win32' ? file.toLowerCase() : file;
}

function projectName(file) {
  return path.basename(file, path.extname(file));
}

async function readProjectLibrary(directory) {
  let reader;
  try {
    reader = await fs.open(path.join(directory, libraryName), 'r');
    const info = await reader.stat();
    if (!info.isFile() || info.size > maxBytes) return [];
    const buffer = Buffer.allocUnsafe(info.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await reader.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > info.size) return [];
    const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)));
    if (!Array.isArray(data)) return [];

    const rows = [];
    const paths = new Set();
    const ids = new Set();
    for (const row of data) {
      const file = projectPath(row?.path);
      if (!file || typeof row.id !== 'string' || !uuid.test(row.id) || typeof row.openedAt !== 'string') continue;
      const time = Date.parse(row.openedAt);
      const id = row.id.toLowerCase();
      const key = pathKey(file);
      if (!Number.isFinite(time) || paths.has(key) || ids.has(id)) continue;
      rows.push({ id, path: file, name: projectName(file), openedAt: new Date(time).toISOString() });
      paths.add(key);
      ids.add(id);
      if (rows.length === maxProjects) break;
    }
    return rows;
  } catch {
    return [];
  } finally {
    if (reader) await reader.close();
  }
}

async function writeProject(directory, rows, file) {
  const normalized = projectPath(file);
  if (!normalized) throw new Error('请选择本地的 .sdworkbench 工程文件。');
  const key = pathKey(normalized);
  const existing = rows.find((row) => pathKey(row.path) === key);
  const project = {
    id: existing?.id ?? randomUUID(), path: normalized,
    name: projectName(normalized), openedAt: new Date().toISOString(),
  };
  const next = [project, ...rows.filter((row) => pathKey(row.path) !== key)].slice(0, maxProjects);
  const contents = Buffer.from(JSON.stringify(next, null, 2), 'utf8');
  if (contents.length > maxBytes) throw new Error('最近工程记录超过大小上限。');

  const temporary = path.join(directory, `recent-projects-${randomUUID()}.tmp`);
  const writer = await fs.open(temporary, 'wx', 0o600);
  try {
    try {
      await writer.writeFile(contents);
      await writer.sync();
    } finally {
      await writer.close();
    }
    await fs.rename(temporary, path.join(directory, libraryName));
  } finally {
    await fs.rm(temporary, { force: true });
  }
  rows.splice(0, rows.length, ...next);
  return project;
}

function rememberProject(directory, rows, file) {
  const previous = pendingWrites.get(rows) ?? Promise.resolve();
  const operation = previous.catch(() => {}).then(() => writeProject(directory, rows, file));
  pendingWrites.set(rows, operation);
  return operation;
}

module.exports = { readProjectLibrary, rememberProject };
