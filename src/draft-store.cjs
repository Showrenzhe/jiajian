'use strict';

const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { saveProject, loadProject } = require('./project-format.cjs');
const { imageExtensions, videoExtensions } = require('./media.cjs');

const maxBytes = 1024 * 1024;
const maxDrafts = 2048;
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function cleanName(value, fallback = '未命名剪辑') {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || value.length > 100) throw new Error('草稿名称应为不超过 100 字的文本。');
  return value.toWellFormed().replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').trim() || fallback;
}

async function readDocument(file) {
  const reader = await fs.open(file, 'r');
  try {
    const info = await reader.stat();
    if (!info.isFile() || info.size > maxBytes) throw new Error('草稿文件无效或超过大小上限。');
    const buffer = Buffer.allocUnsafe(info.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await reader.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length !== info.size) throw new Error('草稿文件正在变化。');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)));
  } finally { await reader.close(); }
}

function firstVisual(document) {
  if (!Array.isArray(document.config?.shots) || !Array.isArray(document.assets)) return null;
  const clip = document.config.shots.find((shot) => Array.isArray(shot) && shot.length)?.[0];
  const asset = clip && document.assets.find((item) => item?.id === clip.id);
  const file = asset?.path;
  if (typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\0') || /^[\\/]{2}/.test(file)
      || (process.platform === 'win32' && (!/^[a-z]:[\\/]/i.test(file) || file.slice(2).includes(':')))) return null;
  const allowed = asset.kind === 'image' ? imageExtensions : asset.kind === 'video' ? videoExtensions : [];
  return allowed.includes(path.extname(file).slice(1).toLowerCase()) ? { path: file, kind: asset.kind } : null;
}

function readDraftRecord(id, document) {
  const draft = document?.draft;
  if (document?.format !== 'sdworkbench' || document.version !== 1 || draft?.id !== id
      || !Number.isSafeInteger(draft.revision) || draft.revision < 1 || typeof draft.name !== 'string'
      || typeof draft.updatedAt !== 'string' || !Number.isFinite(Date.parse(draft.updatedAt))) throw new Error('草稿记录无效。');
  const meta = { id, name: cleanName(draft.name), revision: draft.revision, updatedAt: new Date(draft.updatedAt).toISOString() };
  if (Number.isFinite(draft.duration) && draft.duration >= 0) meta.duration = draft.duration;
  return { meta, cover: firstVisual(document) };
}

function estimateDuration(config) {
  let seconds = 0;
  for (const [clip] of config.shots) {
    if (!clip) continue;
    seconds += (clip.end - clip.start) / (clip.speed ?? 1);
  }
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) / 1000 : undefined;
}

function createDraftStore(directory) {
  const records = new Map();
  let ready;
  let writes = Promise.resolve();
  const snapshotPath = (id) => path.join(directory, `${id}.sdworkbench`);

  async function scan() {
    let directoryHandle;
    try { directoryHandle = await fs.opendir(directory); } catch (error) {
      if (error.code === 'ENOENT') return;
      throw new Error('无法读取本地草稿目录。');
    }
    let scanned = 0;
    for await (const entry of directoryHandle) {
      if (++scanned > 4096 || records.size >= maxDrafts) break;
      if (!entry.isFile() || path.extname(entry.name) !== '.sdworkbench') continue;
      const id = path.basename(entry.name, '.sdworkbench');
      if (!idPattern.test(id)) continue;
      try { records.set(id, readDraftRecord(id, await readDocument(snapshotPath(id)))); } catch {
        // A damaged draft is left on disk and cannot be chosen from the library.
      }
    }
  }

  function initialize() { return ready ??= scan(); }

  function serialize(action) {
    const operation = writes.then(async () => { await initialize(); return action(); });
    writes = operation.catch(() => {});
    return operation;
  }

  async function write(meta, config, catalog) {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const stage = path.join(directory, `.draft-${randomUUID()}.sdworkbench`);
    try {
      await saveProject(stage, config, catalog, { overwrite: true });
      const document = await readDocument(stage);
      const duration = estimateDuration(document.config);
      const draft = { ...meta, ...(duration !== undefined && { duration }) };
      document.draft = draft;
      const contents = Buffer.from(JSON.stringify(document), 'utf8');
      if (contents.length > maxBytes) throw new Error('草稿超过 1 MiB 的大小上限。');
      const writer = await fs.open(stage, 'r+');
      try {
        await writer.writeFile(contents);
        await writer.truncate(contents.length);
        await writer.sync();
      } finally { await writer.close(); }
      await fs.rename(stage, snapshotPath(meta.id));
      records.set(meta.id, { meta: draft, cover: firstVisual(document) });
      return draft;
    } finally { await fs.rm(stage, { force: true }).catch(() => {}); }
  }

  function find(id) {
    const record = typeof id === 'string' && idPattern.test(id) && records.get(id);
    if (!record) throw new Error('找不到这个本地草稿。');
    return record;
  }

  async function list() {
    await initialize();
    return [...records.values()].map(({ meta }) => ({ ...meta })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  function create({ name, config }, catalog) {
    return serialize(() => {
      if (records.size >= maxDrafts) throw new Error(`本地草稿已达到 ${maxDrafts} 条上限。`);
      return write({ id: randomUUID(), name: cleanName(name), updatedAt: new Date().toISOString(), revision: 1 }, config, catalog);
    });
  }

  function save({ id, name, config, expectedRevision }, catalog) {
    return serialize(() => {
      const { meta } = find(id);
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== meta.revision || meta.revision >= Number.MAX_SAFE_INTEGER) {
        throw new Error('草稿已更新，请重新打开后再保存。');
      }
      return write({ id, name: cleanName(name, meta.name), updatedAt: new Date().toISOString(), revision: meta.revision + 1 }, config, catalog);
    });
  }

  function open(id) {
    return serialize(async () => {
      const { meta } = find(id);
      const file = snapshotPath(id);
      if (!(await fs.lstat(file)).isFile()) throw new Error('找不到这个本地草稿。');
      return { ...meta, ...(await loadProject(file)) };
    });
  }

  function cover(id, revision) {
    const record = records.get(id);
    return record?.meta.revision === revision ? record.cover : null;
  }

  return { list, create, save, open, cover };
}

module.exports = { createDraftStore };
