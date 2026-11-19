'use strict';

const { app, BrowserWindow, dialog, ipcMain, net, protocol, safeStorage, session, shell } = require('electron');
const { randomUUID } = require('node:crypto');
const { mkdirSync } = require('node:fs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pathToFileURL } = require('node:url');
const {
  audioExtensions, imageExtensions, videoExtensions, maxExports, maxShots, maxCandidates, maxWholeTracks,
  inspectAsset, createVideoThumbnail, planExtraction, exportBatch,
} = require('./media.cjs');
const { readHistory, remember } = require('./history.cjs');
const { createPreviewBatch, selectPreviewPlans, prepareMontagePlans } = require('./preview-plans.cjs');
const { loadProject, saveProject } = require('./project-format.cjs');
const { readSubtitles } = require('./subtitles.cjs');
const { listWorkflows } = require('./workflow-provider.cjs');
const { readProjectLibrary, rememberProject } = require('./project-library.cjs');
const { createDraftStore } = require('./draft-store.cjs');
const { createCloudTts, isSeedAudioVoiceId } = require('./cloud-tts.cjs');
const { createCloudTtsSettings, publicSettings } = require('./cloud-tts-settings.cjs');
const { splitVideos, videoExtensions: sceneVideoExtensions } = require('./scene-splitter.cjs');
const { splitNarration: splitNarrationAudio } = require('./subs2srs.cjs');

const scheme = 'sd-workbench';
const page = `${scheme}://app/index.html`;
const uiFiles = new Set(['/index.html', '/app.js', '/styles.css', '/dialog-focus.js', '/script-workspace.js', '/script-workspace.css',
  '/track-workspace.css', '/edit-history.js', '/track-tools.js', '/track-tools.css', '/cloud-tts-dialog.js', '/cloud-tts-dialog.css',
  '/cloud-tts-settings.js', '/cloud-tts-settings.css', '/split-view.js', '/panel-layout.js', '/draft-workspace.js', '/assets/jiajian-logo.png',
  '/glass-material.css', '/inspector-controls.css']);
const maxCatalog = (maxShots * 2 + 1) * maxCandidates + maxWholeTracks;
const maxSubtitleBatchBytes = 1024 * 1024;
const maxSpeechJobs = maxShots;
const maxThumbnailCache = 96;
const maxThumbnailRequests = 64;
const maxThumbnailWorkers = 2;
const maxMaterialRoots = 16;
const maxMaterialRecords = 8192;
const maxFolderDepth = 12;
const maxFolderScan = 4096;
const maxListedFolders = 96;
const maxListedFiles = 320;
const maxMaterialLoads = 64;
const maxMaterialWorkers = 2;
const projectFilter = { name: '佳剪工程', extensions: ['sdworkbench'] };
const mediaTypes = new Map(Object.entries({
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
  mkv: 'video/x-matroska', avi: 'video/x-msvideo', mpg: 'video/mpeg', mpeg: 'video/mpeg',
  ts: 'video/mp2t', mts: 'video/mp2t', m2ts: 'video/mp2t',
  wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', ogg: 'audio/ogg', opus: 'audio/ogg',
}));
let schemeRegistered = false;
try {
  protocol.registerSchemesAsPrivileged([{ scheme, privileges: { standard: true, secure: true, stream: true } }]);
  schemeRegistered = true;
} catch {
  // Electron may already be ready when a caller performs asynchronous setup before launchDesktop().
}

function describeAsset(id, asset) {
  const { kind, name, duration, width, height, codec, fps, audioIndex } = asset;
  return { id, kind, name, duration, width, height, codec, fps, hasAudio: audioIndex !== null, url: `${scheme}://asset/${id}` };
}

function localMaterialPath(file) {
  return typeof file === 'string' && path.isAbsolute(file) && !file.includes('\0') && !/^[\\/]{2}/.test(file)
    && (process.platform !== 'win32' || (/^[a-z]:[\\/]/i.test(file) && !file.slice(2).includes(':')));
}

function materialPathKey(file) {
  const normalized = path.normalize(file);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function assetPathKey(kind, file) {
  return `${kind}:${kind === 'audio' ? path.normalize(file) : materialPathKey(file)}`;
}

function materialKind(file) {
  const extension = path.extname(file).slice(1).toLowerCase();
  if (imageExtensions.includes(extension)) return 'image';
  if (videoExtensions.includes(extension)) return 'video';
  return null;
}

async function checkedMaterialPath(record) {
  try {
    if (!record || !localMaterialPath(record.path)) throw new Error();
    const relative = path.relative(record.root, record.path);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error();
    const info = await fs.lstat(record.path);
    if (info.isSymbolicLink() || !(record.kind === 'folder' ? info.isDirectory() : info.isFile())) throw new Error();
    const resolved = await fs.realpath(record.path);
    if (materialPathKey(resolved) !== materialPathKey(record.path)) throw new Error();
    return record.path;
  } catch {
    throw new Error('素材文件夹或文件已不可用，请重新选择。');
  }
}

async function mediaResponse(file, range) {
  let reader;
  try {
    reader = await fs.open(file, 'r');
    const info = await reader.stat();
    const { size } = info;
    if (!info.isFile() || size === 0) return new Response(null, { status: 404 });

    let start = 0;
    let end = size - 1;
    const headers = new Headers({ 'Accept-Ranges': 'bytes' });
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      const first = match?.[1];
      const last = match?.[2];
      if (first) {
        start = Number(first);
        if (last) end = Math.min(end, Number(last));
      } else if (last) {
        start = Math.max(0, size - Number(last));
      }
      if ((!first && !last) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end) {
        headers.set('Content-Range', `bytes */${size}`);
        return new Response(null, { status: 416, headers });
      }
      headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
    }
    headers.set('Content-Length', String(end - start + 1));
    headers.set('Content-Type', mediaTypes.get(path.extname(file).slice(1).toLowerCase()) ?? 'application/octet-stream');
    const stream = reader.createReadStream({ start, end });
    reader = undefined; // The stream closes the file when read or cancelled.
    return new Response(Readable.toWeb(stream, {
      strategy: { highWaterMark: stream.readableHighWaterMark, size: (chunk) => chunk.byteLength },
    }), { status: range ? 206 : 200, headers });
  } catch {
    return new Response(null, { status: 404 });
  } finally {
    await reader?.close().catch(() => {});
  }
}

async function cleanPreviewFiles(directory, file) {
  if (file) await fs.rm(file, { force: true }).catch(() => {});
  if (directory) await fs.rmdir(directory).catch(() => {});
}

async function launchDesktop({
  show = true,
  dialogs = dialog,
  dataDirectory = path.resolve(__dirname, '../run-data'),
  cloudTts,
} = {}) {
  app.setName('佳剪');
  mkdirSync(dataDirectory, { recursive: true });
  app.setPath('userData', dataDirectory);
  if (show && !app.requestSingleInstanceLock()) {
    app.quit();
    return null;
  }
  app.commandLine.appendSwitch('disable-background-networking');
  app.commandLine.appendSwitch('disable-component-update');
  if (!schemeRegistered) {
    protocol.registerSchemesAsPrivileged([{ scheme, privileges: { standard: true, secure: true, stream: true } }]);
    schemeRegistered = true;
  }
  await app.whenReady();

  const catalog = new Map();
  const voiceSamples = new Map();
  const lookupByPath = new Map();
  const recent = await readHistory(dataDirectory);
  const projects = await readProjectLibrary(dataDirectory);
  const drafts = createDraftStore(path.join(dataDirectory, 'drafts'));
  const published = new Set(recent.map((item) => item.path));
  let job;
  let pickerOpen = false;
  let closing = false;
  let draftCloseReady = false;
  let draftCloseRequest;
  let draftCloseAllowed = false;
  let previewBatch;
  let activePreview;
  let cloudSettings = { baseUrl: '', apiKey: '' };
  let cloudSettingsWarning;
  let savingCloudSettings = false;
  const cloudSettingsStore = createCloudTtsSettings({ directory: dataDirectory, safeStorage });
  const voiceoverDirectory = path.join(dataDirectory, 'cloud-voiceovers');
  try {
    cloudSettings = await cloudSettingsStore.load();
  } catch (error) {
    cloudSettingsWarning = error.message;
  }
  cloudTts ??= createCloudTts({ ...cloudSettings, outputDirectory: voiceoverDirectory });

  async function discardPreview() {
    if (!activePreview) return;
    const previous = activePreview;
    activePreview = undefined;
    await cleanPreviewFiles(previous.directory, previous.asset.path);
  }

  const materialRoots = new Map();
  const materialFolders = new Map();
  const materialFiles = new Map();
  const materialPaths = new Map();
  const materialBrowses = new Map();
  const materialLoads = new Map();
  const folderAssetOrigins = new WeakMap();
  const materialLoadQueue = [];
  let materialWorkers = 0;

  function rememberMaterialEntry(parent, file, name, kind) {
    const key = `${parent.rootId}\0${kind}\0${materialPathKey(file)}`;
    const known = materialPaths.get(key);
    if (known) return known;
    if (materialFolders.size + materialFiles.size >= maxMaterialRecords) return null;
    const record = { id: randomUUID(), name, path: file, root: parent.root, rootId: parent.rootId, depth: parent.depth + 1, kind };
    materialPaths.set(key, record);
    (kind === 'folder' ? materialFolders : materialFiles).set(record.id, record);
    return record;
  }

  async function readMaterialFolder(record) {
    const file = await checkedMaterialPath(record);
    const folders = [];
    const files = [];
    let scanned = 0;
    let limited = false;
    try {
      for await (const entry of await fs.opendir(file)) {
        if (++scanned > maxFolderScan) { limited = true; break; }
        if (entry.isSymbolicLink() || path.basename(entry.name) !== entry.name) continue;
        const kind = entry.isDirectory() ? 'folder' : entry.isFile() ? materialKind(entry.name) : null;
        if (!kind) continue;
        const child = path.join(file, entry.name);
        if (!localMaterialPath(child)) continue;
        if (kind === 'folder' ? record.depth >= maxFolderDepth || folders.length >= maxListedFolders : files.length >= maxListedFiles) {
          limited = true;
          continue;
        }
        const item = rememberMaterialEntry(record, child, entry.name, kind);
        if (!item) { limited = true; continue; }
        const { id, name } = item;
        if (kind === 'folder') folders.push({ id, name });
        else files.push({ id, name, kind, ...(kind === 'image' && { previewUrl: `${scheme}://asset/folder-image/${id}` }) });
      }
    } catch {
      throw new Error('无法读取这个素材文件夹。');
    }
    const byName = (a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true });
    return {
      id: record.id, name: record.name, folders: folders.sort(byName), files: files.sort(byName),
      ...(limited && { warnings: ['已达到单个文件夹或本次会话的显示上限。'] }),
    };
  }

  function browseMaterialFolder(id) {
    const record = materialFolders.get(id);
    if (!record) throw new Error('素材文件夹未授权或已不可用。');
    if (materialBrowses.has(id)) return materialBrowses.get(id);
    if (materialBrowses.size >= 4) throw new Error('正在读取多个文件夹，请稍后重试。');
    const result = readMaterialFolder(record).finally(() => materialBrowses.delete(id));
    materialBrowses.set(id, result);
    return result;
  }

  async function inspectFolderFile(file, kind, signal) {
    signal.throwIfAborted();
    try { return await inspectAsset(file, kind, { signal }); } catch {
      signal.throwIfAborted();
      throw new Error('无法读取这个素材，文件可能已移动或损坏。');
    }
  }

  async function registerFolderFile(record, signal) {
    const file = await checkedMaterialPath(record);
    signal.throwIfAborted();
    const key = assetPathKey(record.kind, record.path);
    const known = lookupByPath.get(key);
    if (known) return describeAsset(known, catalog.get(known));
    if (catalog.size >= maxCatalog) throw new Error('本次会话的素材已达到上限。');
    const asset = await inspectFolderFile(file, record.kind, signal);
    await checkedMaterialPath(record);
    signal.throwIfAborted();
    const existing = lookupByPath.get(key);
    if (existing) return describeAsset(existing, catalog.get(existing));
    if (pickerOpen || job) throw new Error('请先完成当前操作。');
    if (catalog.size >= maxCatalog) throw new Error('本次会话的素材已达到上限。');
    const id = randomUUID();
    folderAssetOrigins.set(asset, record);
    catalog.set(id, asset);
    lookupByPath.set(key, id);
    return describeAsset(id, asset);
  }

  function drainMaterialLoads() {
    while (materialWorkers < maxMaterialWorkers && materialLoadQueue.length) {
      const task = materialLoadQueue.shift();
      materialWorkers += 1;
      void registerFolderFile(task.record, task.signal).then(task.resolve, task.reject).finally(() => {
        if (materialLoads.get(task.record.id) === task) materialLoads.delete(task.record.id);
        materialWorkers -= 1;
        drainMaterialLoads();
      });
    }
  }

  function loadMaterialFile(id) {
    const record = materialFiles.get(id);
    if (!record) throw new Error('素材未授权或已不可用。');
    if (pickerOpen || job) throw new Error('请先完成当前操作。');
    if (materialLoads.has(id)) return materialLoads.get(id).promise;
    if (materialLoads.size >= maxMaterialLoads) throw new Error('正在读取多个素材，请稍后重试。');
    const task = { record, signal: thumbnailScope.signal, ...Promise.withResolvers() };
    materialLoads.set(id, task);
    materialLoadQueue.push(task);
    drainMaterialLoads();
    return task.promise;
  }

  async function checkPlanFolderFiles(plans, signal) {
    const origins = new Set();
    for (const plan of plans) {
      const sources = plan.kind === 'montage'
        ? plan.clips.flatMap((clip) => (clip.visuals ?? [clip]).map(({ asset }) => asset)) : [plan.asset];
      for (const asset of sources) {
        const record = folderAssetOrigins.get(asset);
        if (record) origins.add(record);
      }
    }
    for (const record of origins) {
      if (signal.aborted) return;
      await checkedMaterialPath(record);
    }
  }

  const thumbnails = new Map();
  const thumbnailPending = new Map();
  const thumbnailQueue = [];
  let thumbnailScope = new AbortController();
  let thumbnailWorkers = 0;
  const thumbnailUrl = (id) => `${scheme}://asset/thumbnail/${id}`;
  function draftThumbnailSource(key) {
    const match = typeof key === 'string' && /^draft:([a-f0-9-]{36}):(\d{1,16})$/.exec(key);
    return match ? drafts.cover(match[1], Number(match[2])) : null;
  }
  const thumbnailSource = (id) => catalog.get(id) ?? materialFiles.get(id) ?? draftThumbnailSource(id);
  const thumbnailFolderRecord = (source) => source.root ? source : folderAssetOrigins.get(source);

  async function checkedDraftCover(source) {
    const info = await fs.lstat(source.path);
    if (!info.isFile() || materialPathKey(await fs.realpath(source.path)) !== materialPathKey(source.path)) throw new Error('草稿封面不可用。');
    return source.path;
  }

  function drainThumbnails() {
    while (thumbnailWorkers < maxThumbnailWorkers && thumbnailQueue.length) {
      const task = thumbnailQueue.shift();
      thumbnailWorkers += 1;
      void (async () => {
        let url = null;
        try {
          const record = thumbnailFolderRecord(task.asset);
          const draftSource = draftThumbnailSource(task.id);
          const file = record ? await checkedMaterialPath(record) : draftSource ? await checkedDraftCover(draftSource) : null;
          const asset = task.asset.root || draftSource ? await inspectFolderFile(file, task.asset.kind, task.signal) : task.asset;
          const bytes = await createVideoThumbnail(asset, { signal: task.signal });
          if (bytes && !task.signal.aborted && thumbnailSource(task.id) === task.asset) {
            thumbnails.set(task.id, bytes);
            if (thumbnails.size > maxThumbnailCache) thumbnails.delete(thumbnails.keys().next().value);
            url = thumbnailUrl(task.id);
          }
        } catch {
          // A missing or undecodable source uses the library tile's placeholder.
        } finally {
          if (thumbnailPending.get(task.id) === task) thumbnailPending.delete(task.id);
          thumbnailWorkers -= 1;
          task.resolve(url);
          drainThumbnails();
        }
      })();
    }
  }

  async function videoThumbnail(id) {
    const asset = thumbnailSource(id);
    if (asset?.kind !== 'video') return null;
    const signal = thumbnailScope.signal;
    const cached = thumbnails.get(id);
    if (cached) {
      const record = thumbnailFolderRecord(asset);
      const available = record ? await checkedMaterialPath(record).then(() => true, () => false)
        : await fs.stat(asset.path).then((info) => info.isFile(), () => false);
      if (signal.aborted || thumbnailSource(id) !== asset) return null;
      thumbnails.delete(id);
      if (!available) return null;
      thumbnails.set(id, cached);
      if (thumbnails.size > maxThumbnailCache) thumbnails.delete(thumbnails.keys().next().value);
      return thumbnailUrl(id);
    }
    const pending = thumbnailPending.get(id);
    if (pending) return pending.promise;
    if (thumbnailPending.size >= maxThumbnailRequests) return null;
    const { promise, resolve } = Promise.withResolvers();
    const task = { id, asset, signal, promise, resolve };
    thumbnailPending.set(id, task);
    thumbnailQueue.push(task);
    drainThumbnails();
    return promise;
  }

  function resetThumbnails() {
    thumbnailScope.abort();
    thumbnailScope = new AbortController();
    thumbnails.clear();
    thumbnailPending.clear();
    for (const task of thumbnailQueue.splice(0)) task.resolve(null);
    materialLoads.clear();
    for (const task of materialLoadQueue.splice(0)) task.reject(new Error('素材读取已取消。'));
  }

  function publicDraft(meta) {
    const cover = drafts.cover(meta.id, meta.revision);
    return { ...meta, ...(cover && { coverUrl: `${scheme}://asset/draft-cover/${meta.id}/${meta.revision}` }) };
  }

  function jpegResponse(bytes) {
    return bytes ? new Response(bytes, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' } })
      : new Response(null, { status: 404 });
  }

  async function draftCoverResponse(id, revision) {
    const source = drafts.cover(id, revision);
    if (!source) return new Response(null, { status: 404 });
    try {
      if (source.kind === 'image') return await net.fetch(pathToFileURL(await checkedDraftCover(source)).href);
      const key = `draft:${id}:${revision}`;
      return jpegResponse(await videoThumbnail(key) ? thumbnails.get(key) : null);
    } catch { return new Response(null, { status: 404 }); }
  }

  session.defaultSession.setPermissionRequestHandler((_contents, _permission, reply) => reply(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  protocol.handle(scheme, (request) => {
    const url = new URL(request.url);
    if (request.method !== 'GET' || url.search || url.port || url.username || url.password) {
      return new Response(null, { status: 404 });
    }
    if (url.hostname === 'app' && uiFiles.has(url.pathname)) {
      return net.fetch(pathToFileURL(path.join(__dirname, 'ui', url.pathname.slice(1))).href);
    }
    if (url.hostname === 'asset') {
      const draftCover = /^\/draft-cover\/([a-f0-9-]{36})\/(\d{1,16})$/.exec(url.pathname);
      if (draftCover) return draftCoverResponse(draftCover[1], Number(draftCover[2]));
      if (url.pathname.startsWith('/thumbnail/')) {
        const id = url.pathname.slice('/thumbnail/'.length);
        const bytes = (catalog.get(id) ?? materialFiles.get(id))?.kind === 'video' && thumbnails.get(id);
        return jpegResponse(bytes);
      }
      if (url.pathname.startsWith('/folder-image/')) {
        const record = materialFiles.get(url.pathname.slice('/folder-image/'.length));
        if (record?.kind === 'image') return checkedMaterialPath(record)
          .then((file) => net.fetch(pathToFileURL(file).href)).catch(() => new Response(null, { status: 404 }));
        return new Response(null, { status: 404 });
      }
      const id = url.pathname.slice(1);
      const asset = activePreview?.id === id ? activePreview.asset : catalog.get(id) ?? voiceSamples.get(id);
      if (asset) {
        const serve = (file) => asset.kind === 'video' || asset.kind === 'audio' ? mediaResponse(file, request.headers.get('range'))
          : net.fetch(pathToFileURL(file).href);
        const record = folderAssetOrigins.get(asset);
        return record ? checkedMaterialPath(record).then(serve).catch(() => new Response(null, { status: 404 })) : serve(asset.path);
      }
    }
    return new Response(null, { status: 404 });
  });

  const win = new BrowserWindow({
    show,
    width: 1340,
    height: 900,
    minWidth: 850,
    minHeight: 600,
    title: '佳剪',
    icon: path.join(__dirname, 'ui', 'assets', 'jiajian-logo.ico'),
    backgroundColor: '#e6e9ed',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: '#303947', height: 44 },
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false,
      backgroundThrottling: show, offscreen: !show,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());
  app.on('window-all-closed', () => {
    resetThumbnails();
    discardPreview().finally(() => app.quit());
  });
  app.on('second-instance', () => {
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  function clearDraftClose() {
    if (draftCloseRequest) clearTimeout(draftCloseRequest.timer);
    draftCloseRequest = undefined;
  }

  function closeAfterDraft() {
    draftCloseAllowed = true;
    setImmediate(() => { if (!win.isDestroyed()) win.close(); });
  }

  win.on('close', (event) => {
    if (job) {
      event.preventDefault();
      if (closing) return;
      const choice = dialogs.showMessageBoxSync(win, {
        type: 'warning', title: '媒体任务进行中', message: '退出会取消当前预览或剩余导出，已导出的文件会保留。',
        buttons: ['继续处理', '取消并退出'], defaultId: 0, cancelId: 0, noLink: true,
      });
      if (choice === 1) {
        closing = true;
        job.abort();
      }
      return;
    }
    if (draftCloseAllowed || !draftCloseReady || win.webContents.isDestroyed()) return;
    event.preventDefault();
    if (draftCloseRequest) return;
    const token = randomUUID();
    const timer = setTimeout(() => {
      if (win.isDestroyed() || draftCloseRequest?.token !== token) return;
      clearDraftClose();
      closing = false;
      if (!show || typeof dialogs.showMessageBoxSync !== 'function') return;
      const choice = dialogs.showMessageBoxSync(win, {
        type: 'warning', title: '草稿保存未完成', message: '尚未收到草稿保存结果。直接退出可能丢失最近的更改。',
        buttons: ['继续编辑', '仍然退出'], defaultId: 0, cancelId: 0, noLink: true,
      });
      if (choice === 1) closeAfterDraft();
    }, 15000);
    draftCloseRequest = { token, timer };
    win.webContents.send('workbench:before-draft-close', token);
  });
  win.once('closed', clearDraftClose);

  function handle(channel, action) {
    ipcMain.handle(channel, async (event, value) => {
      if (event.sender !== win.webContents || event.senderFrame?.url !== page || event.senderFrame.parent) {
        return { ok: false, error: '请求来源无效。' };
      }
      try {
        return { ok: true, value: await action(value) };
      } catch (error) {
        return { ok: false, error: error.message };
      }
    });
  }

  handle('workbench:history', () => recent);
  handle('workbench:workflows', listWorkflows);
  handle('workbench:video-thumbnail', (id) => (catalog.has(id) || materialFiles.has(id)) ? videoThumbnail(id) : null);
  handle('workbench:list-drafts', async () => (await drafts.list()).map(publicDraft));
  handle('workbench:create-draft', async (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('草稿请求无效。');
    return publicDraft(await drafts.create(value, new Map(catalog)));
  });
  handle('workbench:save-draft', async (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('草稿请求无效。');
    return publicDraft(await drafts.save(value, new Map(catalog)));
  });
  handle('workbench:draft-close-ready', () => { draftCloseReady = true; return true; });
  handle('workbench:complete-draft-close', (value) => {
    if (!draftCloseRequest || value?.token !== draftCloseRequest.token || typeof value.ok !== 'boolean') return false;
    clearDraftClose();
    if (value.ok) closeAfterDraft();
    else closing = false;
    return true;
  });
  handle('workbench:browse-material-folder', browseMaterialFolder);
  handle('workbench:load-material-file', loadMaterialFile);
  handle('workbench:pick-material-folder', async () => {
    if (pickerOpen || job) throw new Error('请先完成当前操作。');
    pickerOpen = true;
    try {
      const { canceled, filePaths } = await dialogs.showOpenDialog(win, {
        title: '选择素材文件夹', properties: ['openDirectory'],
      });
      if (canceled || !filePaths[0]) return null;
      const selected = filePaths[0];
      if (!localMaterialPath(selected)) throw new Error('请选择本机素材文件夹。');
      const file = path.resolve(selected);
      const key = materialPathKey(file);
      const existing = materialRoots.get(key);
      if (existing) return await browseMaterialFolder(existing.id);
      if (materialRoots.size >= maxMaterialRoots || materialFolders.size + materialFiles.size >= maxMaterialRecords) {
        throw new Error('本次会话的素材文件夹已达到上限。');
      }
      const id = randomUUID();
      const record = { id, name: path.basename(file) || path.parse(file).root, path: file, root: file, rootId: id, depth: 0, kind: 'folder' };
      materialRoots.set(key, record);
      materialFolders.set(id, record);
      try {
        return await browseMaterialFolder(id);
      } catch (error) {
        materialRoots.delete(key);
        materialFolders.delete(id);
        for (const [entryKey, child] of materialPaths) {
          if (child.rootId !== id) continue;
          materialPaths.delete(entryKey);
          (child.kind === 'folder' ? materialFolders : materialFiles).delete(child.id);
        }
        throw error;
      }
    } finally {
      pickerOpen = false;
    }
  });
  handle('workbench:projects', () => projects.map(({ id, name, openedAt }) => ({ id, name, openedAt })));

  const sampleByVoice = new Map();

  function requireCloudTts() {
    if (!cloudTts?.status().configured) throw new Error('请先配置工作台的云端配音接口。');
    return cloudTts;
  }

  handle('workbench:cloud-tts-settings', () => ({ ...publicSettings(cloudSettings), warning: cloudSettingsWarning }));
  handle('workbench:cloud-tts-save-settings', async (update) => {
    if (job || pickerOpen || savingCloudSettings) throw new Error('请先完成当前操作。');
    savingCloudSettings = true;
    try {
      const next = await cloudSettingsStore.save(cloudSettings, update);
      const provider = createCloudTts({ ...next, outputDirectory: voiceoverDirectory });
      cloudSettings = next;
      cloudTts = provider;
      cloudSettingsWarning = undefined;
      sampleByVoice.clear();
      voiceSamples.clear();
      return publicSettings(cloudSettings);
    } finally {
      savingCloudSettings = false;
    }
  });

  handle('workbench:cloud-tts-voices', async () => {
    const provider = cloudTts;
    const status = provider?.status();
    if (!status || (!status.configured && status.provider !== 'seed-audio')) {
      return { ...status, configured: false, voices: [] };
    }
    const manifest = await provider.listVoices();
    return { ...status, voices: manifest.voices };
  });

  handle('workbench:cloud-tts-sample', async (voiceId) => {
    const provider = requireCloudTts();
    if (job || pickerOpen || savingCloudSettings) throw new Error('请先完成当前操作。');
    if (sampleByVoice.has(voiceId)) {
      const id = sampleByVoice.get(voiceId);
      return describeAsset(id, voiceSamples.get(id));
    }
    job = new AbortController();
    try {
      const result = await provider.sample(voiceId, { signal: job.signal });
      const asset = await inspectAsset(result.path, 'audio', { signal: job.signal });
      const id = randomUUID();
      voiceSamples.set(id, asset);
      sampleByVoice.set(voiceId, id);
      return describeAsset(id, asset);
    } finally {
      finishJob();
    }
  });

  handle('workbench:cloud-tts-synthesize', async (value) => {
    const provider = requireCloudTts();
    const seedAudio = provider.status().provider === 'seed-audio';
    if (job || pickerOpen || savingCloudSettings) throw new Error('请先完成当前操作。');
    const { jobs, speed = 1, volume = 100, pitch = 0, enableSubtitles = true } = value ?? {};
    if (!Array.isArray(jobs) || !jobs.length || jobs.length > maxSpeechJobs
      || jobs.some((item) => !Number.isInteger(item?.index) || item.index < 0 || item.index >= maxShots
        || typeof item.voiceId !== 'string' || !item.voiceId || item.voiceId.length > 128
        || (seedAudio && !isSeedAudioVoiceId(item.voiceId))
        || typeof item.text !== 'string' || !item.text.trim()
        || (seedAudio ? item.text.length > 6000 || [...item.text].length > 3000 : item.text.length > 500))
      || new Set(jobs.map(({ index, voiceId }) => JSON.stringify([index, voiceId]))).size !== jobs.length
      || !Number.isFinite(speed) || speed < 0.5 || speed > 2
      || !Number.isFinite(volume) || volume < (seedAudio ? 50 : 0) || volume > (seedAudio ? 200 : 100)
      || (seedAudio && (!Number.isInteger(pitch) || pitch < -12 || pitch > 12 || typeof enableSubtitles !== 'boolean'))) {
      throw new Error(seedAudio ? '请检查提示词、语速、音量和音调。' : '请检查台词、音色、语速和音量。');
    }
    if (catalog.size + jobs.length > maxCatalog) throw new Error('本次会话的素材已达到上限。');
    job = new AbortController();
    const { signal } = job;
    const results = [];
    const failures = [];
    const progress = (index, fraction) => {
      if (!win.isDestroyed()) win.webContents.send('workbench:progress', {
        kind: 'cloud-tts', index, completed: results.length + failures.length, total: jobs.length, fraction,
      });
    };
    try {
      for (const [position, { index, text, voiceId }] of jobs.entries()) {
        if (signal.aborted) break;
        progress(position, 0);
        let generated;
        try {
          generated = await provider.synthesize({
            text, voiceId, speed, volume, signal, onProgress: (fraction) => progress(position, fraction),
            ...(seedAudio && { pitch, enableSubtitles }),
          });
          const asset = await inspectAsset(generated.path, 'audio', { signal });
          if (seedAudio && asset.codec !== 'mp3') throw new Error('Seed Audio 未返回有效的 MP3。');
          signal.throwIfAborted();
          const id = randomUUID();
          catalog.set(id, asset);
          lookupByPath.set(`audio:${path.normalize(asset.path)}`, id);
          results.push({
            index, voiceId, asset: {
              ...describeAsset(id, asset), ...(!seedAudio && { scriptText: text.trim() }), timedCaptions: generated.captions,
            },
          });
        } catch (error) {
          if (seedAudio && generated?.path && path.dirname(generated.path) === voiceoverDirectory) {
            await fs.rm(generated.path, { force: true }).catch(() => {});
          }
          if (signal.aborted) break;
          failures.push({ index, voiceId, message: error.message });
        }
        progress(position, 1);
      }
      return { results, failures, cancelled: signal.aborted };
    } finally {
      finishJob();
    }
  });

  async function trackProject(file) {
    try {
      await rememberProject(dataDirectory, projects, file);
      return undefined;
    } catch {
      return '当前工程可用，但项目列表暂时无法更新。';
    }
  }

  handle('workbench:pick-subtitles', async (value) => {
    if (job || pickerOpen) throw new Error('请先完成当前操作。');
    const batch = value !== undefined;
    const limit = batch ? value?.limit : 1;
    if (!Number.isInteger(limit) || limit < 1 || limit > maxWholeTracks) throw new Error('字幕导入数量无效。');
    pickerOpen = true;
    try {
      const { canceled, filePaths } = await dialogs.showOpenDialog(win, {
        title: batch ? '批量选择 SRT 字幕' : '选择 SRT 字幕',
        properties: batch ? ['openFile', 'multiSelections'] : ['openFile'],
        filters: [{ name: 'SRT 字幕', extensions: ['srt'] }],
      });
      if (canceled || !filePaths[0]) return null;
      if (!batch) return await readSubtitles(filePaths[0]);
      const tracks = [];
      const warnings = [];
      let bytes = 0;
      for (const file of filePaths.slice(0, maxWholeTracks)) {
        if (tracks.length === limit) {
          warnings.push(`当前最多还能导入 ${limit} 个字幕文件。`);
          break;
        }
        try {
          const track = await readSubtitles(file);
          const trackBytes = Buffer.byteLength(JSON.stringify(track));
          if (bytes + trackBytes > maxSubtitleBatchBytes) throw new Error('超出本批字幕内容大小上限。');
          tracks.push(track);
          bytes += trackBytes;
        } catch (error) {
          warnings.push(`${path.basename(file)}：${error.message}`);
        }
      }
      if (filePaths.length > maxWholeTracks) warnings.push(`一次最多检查 ${maxWholeTracks} 个字幕文件。`);
      return { tracks, warnings };
    } finally {
      pickerOpen = false;
    }
  });

  handle('workbench:pick-subs2srs-inputs', async () => {
    if (job || pickerOpen) throw new Error('请先完成当前操作。');
    pickerOpen = true;
    try {
      const subtitle = await dialogs.showOpenDialog(win, {
        title: '选择口播 SRT 字幕', properties: ['openFile'],
        filters: [{ name: 'SRT 字幕', extensions: ['srt'] }],
      });
      if (subtitle.canceled || !subtitle.filePaths[0]) return null;
      const audio = await dialogs.showOpenDialog(win, {
        title: '选择整段 MP3 口播', properties: ['openFile'],
        filters: [{ name: '音频', extensions: audioExtensions }],
      });
      if (audio.canceled || !audio.filePaths[0]) return null;
      return { subtitlePath: subtitle.filePaths[0], audioPath: audio.filePaths[0] };
    } finally {
      pickerOpen = false;
    }
  });

  handle('workbench:split-subs2srs', async (value) => {
    if (job || pickerOpen || savingCloudSettings) throw new Error('请先完成当前操作。');
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('口播分割请求无效。');
    if (catalog.size + 2000 > maxCatalog) throw new Error('本次会话的素材已达到上限。');
    job = new AbortController();
    const outputDirectory = path.join(voiceoverDirectory, `subs2srs-${randomUUID()}`);
    try {
      const result = await splitNarrationAudio({
        subtitlePath: value.subtitlePath,
        audioPath: value.audioPath,
        outputDirectory,
        signal: job.signal,
        onProgress: (fraction) => {
          if (!win.isDestroyed()) win.webContents.send('workbench:progress', { kind: 'subs2srs', fraction });
        },
      });
      const segments = [];
      for (const segment of result.segments) {
        const asset = await inspectAsset(segment.path, 'audio', { signal: job.signal });
        const id = randomUUID();
        catalog.set(id, asset);
        lookupByPath.set(`audio:${path.normalize(asset.path)}`, id);
        segments.push({
          ...describeAsset(id, asset),
          text: segment.text,
          sourceStart: segment.start,
          sourceEnd: segment.end,
        });
      }
      return { subtitleName: result.name, audioName: result.audioName, segments };
    } finally {
      finishJob();
    }
  });

  handle('workbench:save-project', async (config) => {
    if (job || pickerOpen) throw new Error('请先完成当前操作。');
    pickerOpen = true;
    try {
      const { canceled, filePath } = await dialogs.showSaveDialog(win, {
        title: '保存工程', defaultPath: '未命名工程.sdworkbench', filters: [projectFilter],
      });
      if (canceled || !filePath) return null;
      try {
        await saveProject(filePath, config, catalog);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const choice = await dialogs.showMessageBox(win, {
          type: 'warning', title: '替换工程文件', message: `替换「${path.basename(filePath)}」吗？`,
          buttons: ['保留原文件', '替换'], defaultId: 0, cancelId: 0, noLink: true,
        });
        if (choice.response !== 1) return null;
        await saveProject(filePath, config, catalog, { overwrite: true });
      }
      const libraryWarning = await trackProject(filePath);
      return { name: path.basename(filePath, path.extname(filePath)), libraryWarning };
    } finally {
      pickerOpen = false;
    }
  });

  async function restoreCatalog(config, assets) {
    const ids = new Map([...assets.keys()].map((id) => [id, randomUUID()]));
    const descriptions = [...assets].map(([id, asset]) => describeAsset(ids.get(id), asset));
    const restoredConfig = {
      ...config,
      shots: config.shots.map((shot) => shot.map((clip) => ({ ...clip, id: ids.get(clip.id) }))),
      musicIds: config.musicIds.map((id) => ids.get(id)),
      narrationId: config.narrationId ? ids.get(config.narrationId) : null,
      segmentNarrationIds: config.segmentNarrationIds?.map((row) => row.map((id) => id === null ? null : ids.get(id))),
      extraWholeTracks: config.extraWholeTracks?.map((track) => ({
        ...track,
        narrationId: track.narrationId === null ? null : ids.get(track.narrationId),
      })),
      generatedCaptions: config.generatedCaptions && Object.fromEntries(
        Object.entries(config.generatedCaptions).map(([id, caption]) => [ids.get(id), caption])),
    };
    resetThumbnails();
    catalog.clear();
    lookupByPath.clear();
    for (const [id, asset] of assets) {
      catalog.set(ids.get(id), asset);
      lookupByPath.set(assetPathKey(asset.kind, asset.path), ids.get(id));
    }
    previewBatch = undefined;
    await discardPreview();
    return { config: restoredConfig, assets: descriptions };
  }

  handle('workbench:open-draft', async (id) => {
    if (job || pickerOpen) throw new Error('请先完成当前操作。');
    pickerOpen = true;
    try {
      const { config, assets, ...meta } = await drafts.open(id);
      return { ...publicDraft(meta), ...(await restoreCatalog(config, assets)) };
    } finally {
      pickerOpen = false;
    }
  });

  handle('workbench:open-project', async (id) => {
    if (job || pickerOpen) throw new Error('请先完成当前操作。');
    pickerOpen = true;
    try {
      let projectPath;
      if (id === undefined) {
        const { canceled, filePaths } = await dialogs.showOpenDialog(win, {
          title: '打开工程', properties: ['openFile'], filters: [projectFilter],
        });
        if (canceled || !filePaths[0]) return null;
        projectPath = filePaths[0];
      } else {
        projectPath = projects.find((project) => project.id === id)?.path;
        if (!projectPath) throw new Error('找不到这个本地项目。');
      }
      const { config, assets } = await loadProject(projectPath);
      const restored = await restoreCatalog(config, assets);
      const libraryWarning = await trackProject(projectPath);
      return { name: path.basename(projectPath, path.extname(projectPath)), ...restored, libraryWarning };
    } finally {
      pickerOpen = false;
    }
  });

  handle('workbench:pick', async (value) => {
    const { kind, limit } = value || {};
    if (!['visual', 'video', 'audio', 'narration'].includes(kind) || !Number.isInteger(limit)
      || limit < 1 || limit > maxExports || (kind === 'narration' && limit !== 1)) {
      throw new Error('素材选择参数无效。');
    }
    if (pickerOpen || job) throw new Error('请先完成当前操作。');
    pickerOpen = true;
    try {
      const filters = {
        visual: { name: '视频和图片', extensions: [...videoExtensions, ...imageExtensions] },
        video: { name: '视频', extensions: videoExtensions },
        audio: { name: '音频', extensions: audioExtensions },
      };
      const mediaKind = kind === 'narration' ? 'audio' : kind;
      const titles = { visual: '选择分镜素材', video: '选择视频素材', audio: '选择配乐', narration: '选择口播音频' };
      const { canceled, filePaths } = await dialogs.showOpenDialog(win, {
        title: titles[kind],
        properties: limit === 1 ? ['openFile'] : ['openFile', 'multiSelections'],
        filters: [filters[mediaKind]],
      });
      if (canceled) return null;
      const assets = [];
      const warnings = [];
      for (const file of filePaths.slice(0, limit)) {
        try {
          const extension = path.extname(file).slice(1).toLowerCase();
          const fileKind = mediaKind === 'visual' ? (imageExtensions.includes(extension) ? 'image' : 'video') : mediaKind;
          const key = assetPathKey(fileKind, file);
          let id = lookupByPath.get(key);
          if (!id) {
            if (catalog.size >= maxCatalog) throw new Error('本次会话的素材已达到上限。');
            const asset = await inspectAsset(file, fileKind);
            id = randomUUID();
            catalog.set(id, asset);
            lookupByPath.set(key, id);
          }
          assets.push(describeAsset(id, catalog.get(id)));
        } catch (error) {
          warnings.push(`${path.basename(file)}：${error.message}`);
        }
      }
      if (filePaths.length > limit) warnings.push(`本次最多导入 ${limit} 个文件。`);
      return { assets, warnings };
    } finally {
      pickerOpen = false;
    }
  });

  async function scanSceneFolder(directory, limit = 50) {
    const files = [];
    async function visit(current, depth) {
      if (depth > 12 || files.length >= limit) return;
      for await (const entry of await fs.opendir(current)) {
        if (entry.isSymbolicLink() || path.basename(entry.name) !== entry.name) continue;
        const file = path.join(current, entry.name);
        if (entry.isDirectory()) await visit(file, depth + 1);
        else if (entry.isFile() && sceneVideoExtensions.has(path.extname(entry.name).slice(1).toLowerCase())) {
          files.push(file);
          if (files.length >= limit) return;
        }
      }
    }
    await visit(directory, 0);
    return files.sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true }));
  }

  handle('workbench:pick-scene-input', async (kind) => {
    if (!['files', 'folder'].includes(kind) || pickerOpen || job) throw new Error('请先完成当前操作。');
    pickerOpen = true;
    try {
      if (kind === 'folder') {
        const selection = await dialogs.showOpenDialog(win, { title: '选择视频文件夹', properties: ['openDirectory'] });
        if (selection.canceled || !selection.filePaths[0]) return null;
        const files = await scanSceneFolder(selection.filePaths[0]);
        if (!files.length) throw new Error('这个文件夹中没有受支持的视频文件。');
        return { files, label: path.basename(selection.filePaths[0]) || selection.filePaths[0] };
      }
      const selection = await dialogs.showOpenDialog(win, {
        title: '选择视频或文件夹',
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: '视频', extensions: [...sceneVideoExtensions] }],
      });
      if (selection.canceled || !selection.filePaths.length) return null;
      return {
        files: selection.filePaths.slice(0, 50),
        label: selection.filePaths.length === 1 ? path.basename(selection.filePaths[0]) : `已选择 ${Math.min(selection.filePaths.length, 50)} 个视频`,
      };
    } finally {
      pickerOpen = false;
    }
  });

  handle('workbench:pick-scene-output', async () => {
    if (pickerOpen || job) throw new Error('请先完成当前操作。');
    pickerOpen = true;
    try {
      const selection = await dialogs.showOpenDialog(win, { title: '选择场景保存目录', properties: ['openDirectory', 'createDirectory'] });
      if (selection.canceled || !selection.filePaths[0]) return null;
      return selection.filePaths[0];
    } finally {
      pickerOpen = false;
    }
  });

  handle('workbench:scene-split', async (value) => {
    if (job || pickerOpen) throw new Error('请先完成当前操作。');
    const inputs = Array.isArray(value?.inputs) ? value.inputs : [];
    const outputDirectory = value?.outputDirectory;
    job = new AbortController();
    try {
      const results = await splitVideos(inputs, {
        outputDirectory,
        detector: value.detector,
        threshold: value.threshold,
        minSceneSeconds: value.minSceneSeconds,
      }, {
        signal: job.signal,
        onProgress: (data) => {
          if (!win.isDestroyed()) win.webContents.send('workbench:progress', { kind: 'scene-split', ...data });
        },
      });
      if (job.signal.aborted) return null;
      return results;
    } finally {
      finishJob();
    }
  });

  function finishJob() {
    job = null;
    if (closing && !win.isDestroyed()) setImmediate(() => win.close());
  }

  handle('workbench:prepare-preview', async (config) => {
    if (job || pickerOpen) throw new Error('请先完成当前操作。');
    job = new AbortController();
    const { signal } = job;
    try {
      const plans = await prepareMontagePlans(config, catalog, { signal });
      if (signal.aborted) return null;
      previewBatch = createPreviewBatch(config, catalog, plans);
      return { id: previewBatch.id, entries: previewBatch.entries };
    } catch (error) {
      if (signal.aborted) return null;
      throw error;
    } finally {
      finishJob();
    }
  });

  handle('workbench:render-preview', async (value) => {
    if (job || pickerOpen) throw new Error('请先完成当前操作。');
    const { id, index, config } = value || {};
    const plans = selectPreviewPlans(previewBatch, config, { id, indices: [index] });
    job = new AbortController();
    let directory;
    let file;
    try {
      await checkPlanFolderFiles(plans, job.signal);
      if (job.signal.aborted) return null;
      await discardPreview();
      directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sd-workbench-preview-'));
      const result = await exportBatch(plans, directory, {
        signal: job.signal,
        onUpdate: ({ fraction }) => {
          if (!win.isDestroyed()) win.webContents.send('workbench:progress', { kind: 'preview', fraction, index, count: 1 });
        },
      });
      file = result.results[0]?.path;
      if (result.cancelled || job.signal.aborted) return null;
      if (!file) throw new Error(result.failures[0]?.message ?? '生成预览失败。');
      const asset = await inspectAsset(file, 'video', { signal: job.signal });
      if (job.signal.aborted) return null;
      asset.name = `混剪预览 ${index + 1}`;
      activePreview = { id: randomUUID(), asset, directory };
      return describeAsset(activePreview.id, asset);
    } catch (error) {
      if (job.signal.aborted) return null;
      throw error;
    } finally {
      if (directory !== activePreview?.directory) await cleanPreviewFiles(directory, file);
      finishJob();
    }
  });

  handle('workbench:export', async (value) => {
    if (job || pickerOpen) throw new Error('请先完成当前操作。');
    const { mode, config, selection: chosen } = value || {};
    if (!['montage', 'audio'].includes(mode)) throw new Error('导出模式无效。');
    job = new AbortController();
    const { signal } = job;
    try {
      const plans = mode === 'audio' ? planExtraction(config, catalog)
        : chosen ? selectPreviewPlans(previewBatch, config, chosen) : await prepareMontagePlans(config, catalog, { signal });
      if (signal.aborted) return null;
      const selection = await dialogs.showOpenDialog(win, { title: '选择导出目录', properties: ['openDirectory', 'createDirectory'] });
      if (selection.canceled) return null;
      await checkPlanFolderFiles(plans, signal);
      const result = await exportBatch(plans, selection.filePaths[0], {
        signal,
        onUpdate: (data) => {
          if (!win.isDestroyed()) win.webContents.send('workbench:progress', data);
        },
      });
      for (const file of result.results) published.add(file.path);
      if (result.results.length) {
        try {
          await remember(dataDirectory, recent, result.results);
        } catch {
          result.historyWarning = '成片已保存。工作台暂时无法写入最近作品记录。';
        }
      }
      return result;
    } catch (error) {
      if (signal.aborted) return null;
      throw error;
    } finally {
      finishJob();
    }
  });

  handle('workbench:cancel', () => job?.abort());
  handle('workbench:reveal', async (file) => {
    if (!published.has(file)) throw new Error('找不到这次生成的文件。');
    const current = await fs.stat(file).catch(() => null);
    if (!current?.isFile()) throw new Error('文件已移动或删除。');
    shell.showItemInFolder(file);
  });

  await win.loadURL(page);
  return win;
}

module.exports = { launchDesktop };
