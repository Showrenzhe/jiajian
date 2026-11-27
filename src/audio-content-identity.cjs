'use strict';

const {createHash} = require('node:crypto');
const {createReadStream} = require('node:fs');
const fs = require('node:fs/promises');
const {materialPathKey} = require('./material-path.cjs');

const pending = new Map(), waiting = [];
let active = 0;

async function hashAudio(task) {
  const {file, controller, authorize} = task;
  await authorize?.();
  const signal = controller.signal;
  signal.throwIfAborted();
  const info = await fs.stat(file);
  if (!info.isFile()) throw Error('音频文件不可用。');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file,{signal,highWaterMark:256*1024})) hash.update(chunk);
  return hash.digest('hex');
}

function drain() {
  while (active < 2 && waiting.length) {
    const task = waiting.shift();
    if (task.controller.signal.aborted) continue;
    active++;
    hashAudio(task).then(task.resolve,task.reject).finally(()=>{
      if (pending.get(task.key) === task) pending.delete(task.key);
      active--;
      drain();
    });
  }
}

// Join current reads only. Windows can overwrite bytes without changing any exposed stat timestamp.
async function audioContentIdentity(file, {signal,authorize} = {}) {
  signal?.throwIfAborted();
  const key = materialPathKey(file);
  let task = pending.get(key);
  if (!task) {
    if (pending.size >= 512) throw Error('正在读取多个音频素材，请稍后重试。');
    task = {key,file,authorize,controller:new AbortController(),readers:0,...Promise.withResolvers()};
    waiting.push(task);
    pending.set(key,task);
    drain();
  }
  task.readers++;
  const cancelled = Promise.withResolvers();
  const abort = () => cancelled.reject(signal.reason);
  signal?.addEventListener('abort',abort,{once:true});
  try {
    return await (signal ? Promise.race([task.promise,cancelled.promise]) : task.promise);
  } finally {
    signal?.removeEventListener('abort',abort);
    if (--task.readers === 0 && pending.get(key) === task) {
      pending.delete(key);
      if (signal?.aborted) {
        task.controller.abort();
        const index = waiting.indexOf(task);
        if (index >= 0) {
          waiting.splice(index,1);
          task.reject(task.controller.signal.reason);
        }
      }
    }
  }
}

module.exports = {audioContentIdentity};
