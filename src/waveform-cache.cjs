'use strict';

// Multiple lanes can refer to one recording. Share both the decode and its completed peak array.
function createWaveformCache() {
  const cache = new Map(), pending = new Map(), waiting = [];
  let active = 0, scope = new AbortController();

  function drain() {
    while (active < 2 && waiting.length) {
      const task = waiting.shift();
      active++;
      Promise.resolve().then(()=>task.read(task.signal)).then((waveform)=>{
        if (waveform && !task.signal.aborted) {
          cache.set(task.key,waveform);
          if (cache.size > 256) cache.delete(cache.keys().next().value);
          task.resolve(waveform);
        } else task.resolve(null);
      },()=>task.resolve(null)).finally(()=>{
        if (pending.get(task.key) === task) pending.delete(task.key);
        active--;
        drain();
      });
    }
  }

  function get(key, read) {
    if (cache.has(key)) {
      const waveform = cache.get(key);
      cache.delete(key);
      cache.set(key,waveform);
      return Promise.resolve(waveform);
    }
    if (pending.has(key)) return pending.get(key).promise;
    if (pending.size >= 512) return Promise.resolve(null);
    const task = {key,read,signal:scope.signal,...Promise.withResolvers()};
    pending.set(key,task);
    waiting.push(task);
    drain();
    return task.promise;
  }

  function reset() {
    scope.abort();
    scope = new AbortController();
    cache.clear();
    pending.clear();
    for (const task of waiting.splice(0)) task.resolve(null);
  }
  return {get,reset};
}

module.exports = {createWaveformCache};
