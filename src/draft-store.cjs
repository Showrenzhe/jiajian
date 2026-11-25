'use strict';

const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { saveProject, loadProject, readProject, embeddedThumbnail, projectReferences } = require('./project-format.cjs');
const { imageExtensions, videoExtensions } = require('./media.cjs');
const { withDraftFolderMirror } = require('./library-folders.cjs');
const { isMaterialPath } = require('./material-path.cjs');

const maxBytes = 1024 * 1024;
const maxDrafts = 2048;
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function cleanName(value, fallback = '未命名剪辑') {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || value.length > 100) throw new Error('草稿名称应为不超过 100 字的文本。');
  return value.toWellFormed().replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').trim() || fallback;
}

function firstVisual(document) {
  if (!Array.isArray(document.config?.shots) || !Array.isArray(document.assets)) return null;
  const cover = document.config.cover;
  const chosen = cover?.mode === 'library' && cover.items?.[Math.max(0,cover.active ?? 0)];
  const clip = chosen || document.config.shots.find((shot) => Array.isArray(shot) && shot.length)?.[0] || document.assets.find((item) => ['video', 'image'].includes(item?.kind));
  const asset = clip && document.assets.find((item) => item?.id === clip.id);
  const time = chosen?.time ?? (cover?.mode === 'first-shot' ? clip.ranges?.[0]?.start ?? clip.start : undefined);
  return localCover(asset, time);
}

function localCover(asset, time) {
  const file = asset?.path;
  if (!isMaterialPath(file)) return null;
  const allowed = asset.kind === 'image' ? imageExtensions : asset.kind === 'video' ? videoExtensions : [];
  return allowed.includes(path.extname(file).slice(1).toLowerCase()) ? { path: file, kind: asset.kind, ...(asset.kind === 'video' && Number.isFinite(time) && {time}) } : null;
}

function draftMeta(id, draft) {
  if (draft?.id !== id
      || !Number.isSafeInteger(draft.revision) || draft.revision < 1 || typeof draft.name !== 'string'
      || typeof draft.updatedAt !== 'string' || !Number.isFinite(Date.parse(draft.updatedAt))) throw new Error('草稿记录无效。');
  const meta = { id, name: cleanName(draft.name), revision: draft.revision, updatedAt: new Date(draft.updatedAt).toISOString() };
  if (Number.isFinite(draft.duration) && draft.duration >= 0) meta.duration = draft.duration;
  return meta;
}

function estimateDuration(config) {
  let seconds = 0;
  for (const [i,shot] of config.shots.entries()) {
    const clip=shot.find((candidate)=>candidate.enabled!==false);
    if (!clip) continue;
    const source=clip.ranges?.reduce((sum,r)=>sum+r.end-r.start,0)??(clip.end-clip.start);
    seconds += clip.matchedDuration ?? config.shotSettings?.[i]?.duration ?? Math.max(0,source-(clip.look?.head??0)-(clip.look?.tail??0))/(clip.speed??1);
  }
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) / 1000 : undefined;
}

function createDraftStore(directory,resolvePath,inspect,sourceEditDirectory,loadOptions) {
  const records = new Map();
  let ready;
  let writes = Promise.resolve();
  const snapshotPath = (id) => path.join(directory, `${id}.sdworkbench`);
  const cacheDir=path.join(directory,'.list-cache');
  const indexPath=path.join(cacheDir,'index.json');
  const coverPath=id=>path.join(cacheDir,id+'.jpg');
  const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
  const pendingThumbnails=new WeakMap();
  const mirrored = new Map();
  let indexDirty=false;

  async function fileStamp(file) {
    const info=await fs.lstat(file,{bigint:true});
    if(!info.isFile()) throw Error('找不到这个本地草稿。');
    return [info.size,info.mtimeNs,info.ctimeNs,info.ino].join(':');
  }

  async function cacheWrite(file,bytes) {
    const temp=path.join(cacheDir,'.'+randomUUID()+'.tmp');
    try {
      await fs.mkdir(cacheDir,{recursive:true,mode:0o700});
      await fs.writeFile(temp,bytes,{flag:'wx',mode:0o600});
      await fs.rename(temp,file);
      return true;
    } catch {return false;}
    finally {await fs.rm(temp,{force:true}).catch(()=>{});}
  }

  async function readSmallFile(file,limit) {
    const handle=await fs.open(file,'r');
    try {
      const info=await handle.stat();
      if(!info.isFile() || info.size>limit) throw Error('缓存大小无效。');
      const bytes=Buffer.alloc(info.size+1);
      let size=0;
      while(size<bytes.length) {
        const {bytesRead}=await handle.read(bytes,size,bytes.length-size,null);
        if(!bytesRead) break;
        size+=bytesRead;
      }
      if(size!==info.size) throw Error('缓存正在改变。');
      return bytes.subarray(0,size);
    } finally {await handle.close();}
  }

  async function readIndex() {
    try {
      const index=JSON.parse(await readSmallFile(indexPath,16*maxBytes));
      if(index.version!==1 || !Array.isArray(index.entries) || index.entries.length>maxDrafts ||
          digest(JSON.stringify(index.entries))!==index.checksum) throw Error('索引无效。');
      const cached=new Map();
      for(const row of index.entries) {
        const id=row.meta?.id;
        if(!idPattern.test(id) || cached.has(id) || typeof row.stamp!=='string' ||
            typeof row.embedded!=='boolean' || row.embedded!==Boolean(row.hash) ||
            (row.hash && !/^[a-f0-9]{64}$/.test(row.hash))) throw Error('索引条目无效。');
        const cover=localCover(row.cover,row.cover?.time);
        if(row.cover!==null && !cover) throw Error('索引封面无效。');
        cached.set(id,{...row,cover,meta:draftMeta(id,row.meta)});
      }
      return cached;
    } catch {indexDirty=true;return new Map();}
  }

  async function persistIndex() {
    const entries=[...records.values()];
    const checksum=digest(JSON.stringify(entries));
    indexDirty=!(await cacheWrite(indexPath,JSON.stringify({version:1,checksum,entries})));
  }

  async function recordDocument(id,doc,stamp) {
    if(doc?.format!=='sdworkbench' || doc.version!==1) throw Error('草稿记录无效。');
    const meta=draftMeta(id,doc.draft);
    const jpeg=embeddedThumbnail(doc);
    if(jpeg) await cacheWrite(coverPath(id),jpeg);
    return {meta,cover:firstVisual(doc),embedded:Boolean(jpeg),hash:jpeg ? digest(jpeg) : null,stamp};
  }

  async function scan(initial=false) {
    const previous=initial ? await readIndex() : records;
    const next=new Map();
    let directoryHandle;
    try { directoryHandle = await fs.opendir(directory); } catch (error) {
      if (error.code === 'ENOENT') {records.clear();return;}
      throw new Error('无法读取本地草稿目录。');
    }
    let scanned = 0;
    for await (const entry of directoryHandle) {
      if (++scanned > maxDrafts * 3 || next.size >= maxDrafts) break;
      if (!entry.isFile() || path.extname(entry.name) !== '.sdworkbench') continue;
      const id = path.basename(entry.name, '.sdworkbench');
      if (!idPattern.test(id)) continue;
      const file=snapshotPath(id);
      try {
        const stamp=await fileStamp(file), old=previous.get(id);
        if(old?.stamp===stamp) {next.set(id,old);continue;}
        mirrored.delete(id);
        indexDirty=true;
        const doc=await readProject(file);
        if(await fileStamp(file)===stamp) next.set(id,await recordDocument(id,doc,stamp));
      } catch {
        // Leave damaged or concurrently replaced drafts on disk for the next scan.
      }
    }
    for(const id of previous.keys()) if(!next.has(id)) {
      indexDirty=true;
      records.delete(id);
      mirrored.delete(id);
      await fs.rm(coverPath(id),{force:true}).catch(()=>{});
    }
    for(const [id,row] of next) records.set(id,row);
    if(indexDirty) await persistIndex();
  }

  function initialize() { return ready ??= scan(true); }

  async function mirror(id, config, publish) {
    const folders = config.libraryFolders ?? [];
    const structure = JSON.stringify(folders.map(({id,parentId,scope,name}) => [id,parentId,scope,name]));
    if (mirrored.get(id) === structure) return publish();
    const result = await withDraftFolderMirror(directory,id,folders,publish);
    mirrored.set(id,structure);
    return result;
  }

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
      const document = await readProject(stage);
      const duration = estimateDuration(document.config);
      const draft = { ...meta, ...(duration !== undefined && { duration }) };
      document.draft = draft;
      const contents = Buffer.from(JSON.stringify(document), 'utf8');
      if (contents.length - (document.thumbnail?.length ?? 0) > maxBytes) throw new Error('草稿超过 1 MiB 的大小上限。');
      const writer = await fs.open(stage, 'r+');
      try {
        await writer.writeFile(contents);
        await writer.truncate(contents.length);
        await writer.sync();
      } finally { await writer.close(); }
      await mirror(meta.id,document.config,() => fs.rename(stage, snapshotPath(meta.id)));
      records.set(meta.id,await recordDocument(meta.id,document,await fileStamp(snapshotPath(meta.id))));
      await persistIndex();
      return draft;
    } finally { await fs.rm(stage, { force: true }).catch(() => {}); }
  }

  function find(id) {
    const record = typeof id === 'string' && idPattern.test(id) && records.get(id);
    if (!record) throw new Error('找不到这个本地草稿。');
    return record;
  }

  async function list() {
    const refresh=writes.then(()=>ready ? scan() : initialize());
    writes=refresh.catch(()=>{});
    await refresh;
    return [...records.values()].map(({ meta }) => ({ ...meta })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  function create({ name, config }, catalog) {
    return serialize(() => {
      if (records.size >= maxDrafts) throw new Error(`本地草稿已达到 ${maxDrafts} 条上限。`);
      return write({ id: randomUUID(), name: cleanName(name), updatedAt: new Date().toISOString(), revision: 1 }, config, catalog);
    });
  }

  function save({ id, name, config, expectedRevision }, catalog) {
    return serialize(async () => {
      const record=find(id), {meta}=record;
      if (await fileStamp(snapshotPath(id))!==record.stamp) {
        await scan();
        throw new Error('草稿已更新，请重新打开后再保存。');
      }
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== meta.revision || meta.revision >= Number.MAX_SAFE_INTEGER) {
        throw new Error('草稿已更新，请重新打开后再保存。');
      }
      return write({ id, name: cleanName(name, meta.name), updatedAt: new Date().toISOString(), revision: meta.revision + 1 }, config, catalog);
    });
  }

  function open(id) {
    return serialize(async () => {
      const record = find(id);
      const file = snapshotPath(id);
      if (await fileStamp(file)!==record.stamp) await scan();
      const {meta}=find(id);
      const project = await loadProject(file,resolvePath,inspect,sourceEditDirectory,loadOptions);
      // Reconcile the source of truth after an interrupted rename or save.
      mirrored.delete(id);
      try { await mirror(id,project.config,() => undefined); }
      catch { /* The snapshot remains readable; saving will report any disk conflict. */ }
      return { ...meta, ...project };
    });
  }

  function remove(request) {
    return serialize(async () => {
      const { id, expectedRevision } = request ?? {};
      const record = find(id);
      const file = snapshotPath(id);
      try {
        if (expectedRevision !== record.meta.revision || await fileStamp(file) !== record.stamp) {
          throw new Error('草稿已发生变化，请刷新列表后再删除。');
        }
        await fs.unlink(file);
      } catch (error) {
        if (error.code === 'ENOENT') throw new Error('找不到这个本地草稿，请刷新列表。');
        if (['EACCES', 'EPERM', 'EBUSY'].includes(error.code)) {
          throw new Error('无法删除草稿，请检查文件是否被占用或是否有写入权限，然后重试。');
        }
        throw error;
      }
      records.delete(id);
      mirrored.delete(id);
      // The snapshot is authoritative. A mirror containing user files stays on disk.
      await withDraftFolderMirror(directory, id, [], () => {}).catch(() => {});
      await fs.rm(coverPath(id), { force: true }).catch(() => {});
      await persistIndex();
      return true;
    });
  }

  function cover(id, revision) {
    const record = records.get(id);
    return record?.meta.revision === revision ? record.cover : null;
  }

  async function thumbnail(id, revision) {
    const record = records.get(id);
    if (!record?.embedded || record.meta.revision !== revision) return null;
    if(pendingThumbnails.has(record)) return pendingThumbnails.get(record);
    const task=(async()=>{
      const file=snapshotPath(id);
      if(await fileStamp(file)!==record.stamp) {
        await list();
        return records.get(id)!==record ? thumbnail(id,revision) : null;
      }
      try {
        const bytes=await readSmallFile(coverPath(id),256*1024);
        if(digest(bytes)===record.hash) return bytes;
      } catch {}
      const jpeg=embeddedThumbnail(await readProject(file));
      if(!jpeg || digest(jpeg)!==record.hash) return null;
      return serialize(async () => {
        if (records.get(id) !== record) return null;
        await cacheWrite(coverPath(id),jpeg);
        return jpeg;
      });
    })();
    pendingThumbnails.set(record,task);
    try {return await task;} finally {pendingThumbnails.delete(record);}
  }

  async function* assetReferences() {
    await initialize();
    for (const id of records.keys()) {
      let project;
      try { project = projectReferences(await readProject(snapshotPath(id))); } catch { continue; }
      for (const row of project.rows) yield {...row, proxyEnabled:project.config.proxyEnabled};
    }
  }
  return { list, create, save, open, remove, cover, thumbnail, assetReferences };
}

module.exports = { createDraftStore };
