'use strict';
const fs = require('node:fs/promises');
const {readFileSync} = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {createHash, randomUUID} = require('node:crypto');

const filename = 'performance.json';
const proxyName = /^jj-[0-9a-f]{64}\.mp4$/;
function readPerformance(directory) {
  let data;
  try { data = JSON.parse(readFileSync(path.join(directory, filename), 'utf8')); } catch {}
  return {
    gpu: data?.gpu !== false, defaultProxy: data?.defaultProxy !== false,
    optimization: ['smooth','quality'].includes(data?.optimization) ? data.optimization : 'smart',
    location: typeof data?.location === 'string' && path.isAbsolute(data.location)
      ? data.location : path.join(directory, '佳剪代理'),
  };
}
async function atomicWrite(file, bytes) {
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    await fs.mkdir(path.dirname(file), {recursive:true});
    await fs.writeFile(temp, bytes, {flag:'wx',mode:0o600});
    await fs.rename(temp,file);
  } finally { await fs.rm(temp,{force:true}).catch(()=>{}); }
}
async function fingerprint(file, variant) {
  const info = await fs.stat(file);
  if (!info.isFile()) throw new Error('素材路径不是文件。');
  const normalized = process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
  return createHash('sha256').update(JSON.stringify([normalized,info.size,info.mtimeMs,info.ctimeMs,variant])).digest('hex');
}

function createPerformanceCache(directory, {inspect,thumbnail,encode,bootTime=()=>Date.now()-os.uptime()*1000}) {
  let state = readPerformance(directory), writes = Promise.resolve();
  const meta = path.join(directory,'material-cache-v1'), pending = new Map();
  let proxyScope = new AbortController(), warmScope = new AbortController(), closing = false;
  const lifetime = new AbortController();
  let activeEncode, queuedPreview, queuedWarm, sequence = 0;
  function serializeChange(fn) {
    const update = writes.then(fn);
    writes = update.catch(() => {});
    return update;
  }
  function once(key, fn) {
    if (!pending.has(key)) pending.set(key, Promise.resolve().then(fn).finally(()=>pending.delete(key)));
    return pending.get(key);
  }
  async function proxyEntries(dir) {
    const entries=await fs.readdir(dir,{withFileTypes:true}).catch(error=>{
      if (error.code==='ENOENT') return [];
      throw error;
    });
    return entries.filter(e=>e.isFile() && proxyName.test(e.name)).map(e=>path.join(dir,e.name));
  }
  async function view() {
    const snapshot = state;
    let bytes=0;
    for(const file of await proxyEntries(snapshot.location)) bytes+=(await fs.stat(file).catch(()=>null))?.size ?? 0;
    return {...snapshot,bytes};
  }
  function change(patch) {
    return serializeChange(async()=>{
      const next={...state,...patch};
      if (typeof next.gpu !== 'boolean' || typeof next.defaultProxy !== 'boolean' ||
          !['smooth','quality','smart'].includes(next.optimization) || !path.isAbsolute(next.location)) throw new Error('性能设置无效。');
      if (next.location !== state.location) await fs.mkdir(next.location,{recursive:true});
      await atomicWrite(path.join(directory,filename),JSON.stringify(next));
      if (next.location !== state.location || next.optimization !== state.optimization) await resetProxies();
      state=next;
      return view();
    });
  }
  function resetProxies() {
    proxyScope.abort();
    proxyScope=new AbortController();
    queuedPreview?.resolve(null);
    queuedWarm?.resolve(null);
    queuedPreview = queuedWarm = undefined;
    return activeEncode?.promise.catch(() => {});
  }
  function startEncode(task) {
    activeEncode = task;
    task.encode().then(task.resolve, task.reject).finally(() => {
      activeEncode = undefined;
      const next = queuedPreview ?? queuedWarm;
      if (next === queuedPreview) queuedPreview = undefined;
      else queuedWarm = undefined;
      if (next) startEncode(next);
    });
  }
  function queueEncode(file, encode, background, order) {
    const existing = [activeEncode, queuedPreview, queuedWarm].find(task => task?.file === file);
    if (existing) return existing.promise;
    const task = { file, encode, order, ...Promise.withResolvers() };
    if (!activeEncode) startEncode(task);
    else if (background) {
      queuedWarm?.resolve(null);
      queuedWarm = task;
    } else if (queuedPreview && queuedPreview.order > order) task.resolve(null);
    else {
      queuedPreview?.resolve(null);
      queuedPreview = task;
    }
    return task.promise;
  }
  async function inspectCached(file,kind,{signal}={}) {
    signal?.throwIfAborted();
    const key=await fingerprint(file,kind), dest=path.join(meta,key+'.json');
    const asset=await once(dest,async()=>{
      try {
        const cached=JSON.parse(await fs.readFile(dest,'utf8'));
        if(cached.path===file && cached.kind===kind && (kind==='image'||cached.duration>0)) return cached;
      } catch {}
      // Preloading and opening a draft can share this probe. Cancelling one caller
      // must not cancel the other caller's metadata read.
      const probed=await inspect(file,kind,{signal:lifetime.signal});
      if (await fingerprint(file,kind) === key) await atomicWrite(dest,JSON.stringify(probed)).catch(()=>{});
      return probed;
    });
    signal?.throwIfAborted();
    return asset;
  }
  async function poster(asset,options={}) {
    if(asset.kind!=='video') return null;
    const key=await fingerprint(asset.path,['poster',options.time ?? null]);
    const dest=path.join(meta,key+'.jpg');
    options.signal?.throwIfAborted();
    const posterBytes = await once(dest,async()=>{
      try { return await fs.readFile(dest); } catch {}
      const bytes=await thumbnail(asset,{...options,signal:lifetime.signal});
      if(bytes && await fingerprint(asset.path,['poster',options.time ?? null]) === key) await atomicWrite(dest,bytes).catch(()=>{});
      return bytes;
    });
    options.signal?.throwIfAborted();
    return posterBytes;
  }
  async function proxy(asset, {readyOnly=false,background=false}={}) {
    const order = ++sequence;
    await writes;
    const edge={smart:640,smooth:480,quality:1280}[state.optimization];
    if(closing || (background && warmScope.signal.aborted) || asset.kind!=='video' || asset.alpha || Math.max(asset.width,asset.height)<=edge) return null;
    const dir=state.location, signal=proxyScope.signal;
    const key=await fingerprint(asset.path,['proxy-v1',edge]), file=path.join(dir,'jj-'+key+'.mp4');
    const cached = (await fs.stat(file).catch(()=>null))?.size;
    if (closing || signal.aborted) return null;
    if (cached || readyOnly) return cached ? file : null;
    return queueEncode(file,async()=>{
      signal.throwIfAborted();
      if((await fs.stat(file).catch(()=>null))?.size) return file;
      await fs.mkdir(dir,{recursive:true});
      const temp=path.join(dir,'.jj-'+randomUUID()+'.mp4');
      try {
        await encode(asset,temp,signal,edge);
        signal.throwIfAborted();
        if (await fingerprint(asset.path,['proxy-v1',edge])!==key) return null;
        signal.throwIfAborted();
        await fs.rename(temp,file);
        return file;
      } finally { await fs.rm(temp,{force:true}).catch(()=>{}); }
    },background,order);
  }
  function clear() {
    return serializeChange(async () => {
      warmScope.abort();
      await resetProxies();
      for(const file of await proxyEntries(state.location)) await fs.rm(file,{force:true});
      await atomicWrite(path.join(meta,'last-boot.json'),JSON.stringify(bootTime()));
      return view();
    });
  }
  async function preload(references) {
    const boot=bootTime(), marker=path.join(meta,'last-boot.json');
    const last=await fs.readFile(marker,'utf8').then(JSON.parse).catch(()=>null);
    if (Number.isFinite(last) && Math.abs(last-boot)<5000) return false;
    const signal=warmScope.signal, seen=new Set();
    for await (const row of references()) {
      signal.throwIfAborted();
      const useProxy=row.proxyEnabled ?? state.defaultProxy;
      const key=JSON.stringify([row.kind,row.path,useProxy]);
      if(seen.has(key)) continue;
      seen.add(key);
      try {
        const asset=await inspectCached(row.path,row.kind,{signal});
        if(asset.kind==='video') {
          await poster(asset,{signal});
          signal.throwIfAborted();
          if(useProxy) await proxy(asset,{background:true});
        }
      } catch { signal.throwIfAborted(); } // Other drafts may still have available media.
    }
    signal.throwIfAborted();
    await atomicWrite(marker,JSON.stringify(boot));
    return true;
  }
  function close() { closing=true;lifetime.abort();warmScope.abort();void resetProxies(); }
  return {view,change,clear,inspectCached,poster,proxy,preload,close,get settings(){return {...state};}};
}
module.exports={createPerformanceCache,readPerformance};
