'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');

function createCacheBudget(meta, limitBytes = 2 * 1024 ** 3) {
  let location,
    files,
    total = 0,
    queue = Promise.resolve();
  function serial(action) {
    const next = queue.then(action);
    queue = next.catch(() => {});
    return next;
  }
  async function scan(dir) {
    if (files && location === dir) return;
    const items = new Map();
    let bytes = 0;
    for (const [folder, owned] of [
      [meta, /^[a-f0-9]{64}\.(json|jpg)$/],
      [dir, /^jj-[a-f0-9]{64}\.mp4$/],
    ]) {
      for (const item of await fs.readdir(folder, { withFileTypes: true }).catch((error) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      })) {
        if (!item.isFile() || !owned.test(item.name)) continue;
        const file = path.join(folder, item.name),
          stat = await fs.stat(file).catch(() => null);
        if (stat) {
          items.set(file, { size: stat.size, time: stat.mtimeMs });
          bytes += stat.size;
        }
      }
    }
    location = dir;
    files = items;
    total = bytes;
  }
  async function remove(file) {
    try {
      await fs.rm(file, { force: true });
    } catch {
      return;
    }
    total -= files.get(file).size;
    files.delete(file);
  }
  return {
    bytes(dir) {
      return serial(async () => {
        await scan(dir);
        return total;
      });
    },
    track(dir, file) {
      return serial(async () => {
        await scan(dir);
        if (file) {
          const stat = await fs.stat(file).catch(() => null);
          if (stat) {
            total += stat.size - (files.get(file)?.size ?? 0);
            files.set(file, { size: stat.size, time: stat.mtimeMs });
          }
        }
        if (total > limitBytes) {
          for (const [name] of [...files].sort((a, b) => a[1].time - b[1].time)) {
            await remove(name);
            if (total <= limitBytes) break;
          }
        }
        return !file || files.has(file);
      });
    },
    clear(dir) {
      return serial(async () => {
        files = undefined;
        await scan(dir);
        for (const file of files.keys()) await remove(file);
      });
    },
  };
}
module.exports = { createCacheBudget };
