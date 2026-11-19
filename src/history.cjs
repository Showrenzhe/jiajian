'use strict';

const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { constants } = require('node:fs');

const historyLimit = 60;
const outputName = /^(?:混剪-\d{14}-\d{2}(?:-\d+)?\.mp4|提取音频-\d{14}-\d{2}(?:-\d+)?\.mp3)$/;
const redirects=Symbol('previous output paths');
function safeName(name) {
  return typeof name==='string' && name.length>0 && name.length<=150 && !/[\\/:*?"<>|\x00-\x1F]/.test(name)
    && !/[ .]$/.test(name) && !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name);
}
function localOutput(file) {
  return typeof file==='string' && path.isAbsolute(file) && !/^[\\/]{2}/.test(file) && safeName(path.basename(file)) && /\.(mp4|mp3)$/i.test(file);
}

async function readHistory(directory) {
  const file = path.join(directory, 'work-history.json');
  try {
    if ((await fs.stat(file)).size > 4 * 1024 * 1024) return [];
    const stored = JSON.parse(await fs.readFile(file, 'utf8'));
    const rows=Array.isArray(stored)?stored:stored?.rows;
    if (!Array.isArray(rows)) return [];
    const history=rows.filter((item) => localOutput(item?.path)
      && path.basename(item.path) === item.name && outputName.test(item.originalName??item.name)
      && Number.isFinite(Date.parse(item.createdAt))).slice(0, historyLimit);
    if(Array.isArray(stored.paths))history[redirects]=new Map(stored.paths.filter((entry)=>Array.isArray(entry)&&entry.length===2&&entry.every(localOutput)
      && path.dirname(entry[0])===path.dirname(entry[1])&&path.extname(entry[0])===path.extname(entry[1])));
    return history;
  } catch {
    return [];
  }
}

async function remember(directory, history, results) {
  const createdAt = new Date().toISOString();
  const entries = results.map(({ name, path: file }) => ({ name, path: file, createdAt }));
  const rows=[...entries.reverse(),...history].slice(0,historyLimit);
  await persist(directory,rows,history[redirects]);
  history.splice(0,history.length,...rows);
}
async function persist(directory,rows,paths) {
  const pending = path.join(directory, `work-history-${randomUUID()}.tmp`);
  try {
    const json=JSON.stringify(paths?.size?{rows,paths:[...paths]}:rows);
    if(Buffer.byteLength(json)>4*1024*1024)throw new Error('本机成片重命名记录已满。');
    await fs.writeFile(pending, json, { encoding: 'utf8', flag: 'wx' });
    await fs.rename(pending, path.join(directory, 'work-history.json'));
  } finally {
    await fs.rm(pending, { force: true });
  }
}
async function renameOutputs(directory,history,files,prefix) {
  if(!safeName(prefix)||!Array.isArray(files)||files.length<1||files.length>historyLimit||new Set(files).size!==files.length)throw new Error('请选择作品并输入有效的新名称。');
  const changes=files.map((file,i)=>{
    const row=history.find(item=>item.path===file);
    if(!row)throw new Error('所选作品已不在最近导出中。');
    const name=prefix+(files.length>1?'-'+String(i+1).padStart(2,'0'):'')+path.extname(row.name);
    if(!safeName(name))throw new Error('新名称过长或含系统保留字符。');
    return {row,name,from:file,to:path.join(path.dirname(file),name)};
  }).filter(c=>c.from!==c.to);
  const created=[];
  const paths=new Map(history[redirects]);
  try {
    for(const c of changes){
      const info=await fs.lstat(c.from);if(!info.isFile())throw new Error('成片文件已移动。');
      try{await fs.link(c.from,c.to);}catch(e){
        if(e.code==='EEXIST')throw new Error('同名文件已存在：'+c.name);
        if(!['EPERM','ENOSYS','ENOTSUP','EACCES','EXDEV','EINVAL'].includes(e.code))throw e;
        await fs.copyFile(c.from,c.to,constants.COPYFILE_EXCL);
      }
      created.push(c.to);
      for(const [old,current] of paths)if(current===c.from)paths.set(old,c.to);
      paths.set(c.from,c.to);paths.delete(c.to);
    }
    const rows=history.map(row=>{const c=changes.find(change=>change.row===row);return c?{...row,name:c.name,path:c.to,originalName:row.originalName??row.name}:row;});
    await persist(directory,rows,paths);
    history.splice(0,history.length,...rows);history[redirects]=paths;
  }catch(error){await Promise.all(created.map(file=>fs.unlink(file).catch(()=>{})));throw error;}
  const retained=[];
  for(const c of changes)try{await fs.unlink(c.from);}catch{retained.push(c.from);}
  return {changes:changes.map(({from,to,name})=>({from,to,name})),retained};
}
async function resolveOutput(history,file){
  const dest=history[redirects]?.get(file);if(!dest)return file;
  try{await fs.access(file);return file;}catch(error){if(error.code!=='ENOENT')throw error;return dest;}
}
module.exports = { readHistory, remember, renameOutputs, resolveOutput };
