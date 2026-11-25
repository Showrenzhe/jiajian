'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');

function estimatedBytes(plan) {
  // H.264 CRF output varies with motion and detail. Use a resolution / fps
  // estimate for the UI and reserve an additional working copy of the largest item.
  if (plan.kind !== 'montage') return Math.ceil(plan.duration * 24000);
  const [width, height] = plan.size;
  return Math.ceil(plan.duration * (20000 + (width * height * plan.fps * 0.09) / 8));
}

async function checkExportDirectory(directory, plans, signal) {
  if (!path.isAbsolute(directory)) throw Error('导出目录无效。');
  const files = new Set();
  for (const plan of plans) {
    const add = (asset) => {
      if (asset?.path) files.add(asset.path);
    };
    add(plan.asset);
    add(plan.narration);
    add(plan.music);
    add(plan.cover?.asset);
    for (const clip of plan.clips ?? []) {
      add(clip.narration);
      for (const part of clip.visuals ?? [clip]) {
        add(part.asset);
        add(part.look?.backgroundAsset);
        add(part.look?.lutAsset);
      }
    }
    for (const layer of plan.layers ?? []) {
      add(layer.asset);
      add(layer.look?.backgroundAsset);
      add(layer.look?.lutAsset);
    }
  }
  const missing = [];
  const paths = [...files];
  for (let i = 0; i < paths.length; i += 12) {
    signal?.throwIfAborted();
    await Promise.all(
      paths.slice(i, i + 12).map(async (file) => {
        if (!(await fs.stat(file).catch(() => null))?.isFile()) missing.push(path.basename(file));
      }),
    );
  }
  if (missing.length) throw Error('导出素材缺失，请重新定位：\n' + missing.join('\n'));
  let probe;
  try {
    probe = await fs.mkdtemp(path.join(directory, '.jj-check-'));
    await fs.writeFile(path.join(probe, 'write'), '1');
  } catch {
    throw Error('输出目录不可写，请选择其他目录。');
  } finally {
    if (probe) await fs.rm(probe, { recursive: true, force: true });
  }
  const sizes = plans.map(estimatedBytes);
  const required = sizes.reduce((sum, n) => sum + n, 0) + Math.max(0, ...sizes);
  const stats = await fs.statfs(directory, { bigint: true });
  const free = Number(stats.bavail * stats.bsize);
  if (free < required)
    throw Error(
      `预计导出和临时文件需要 ${Math.ceil(required / 1048576)} MiB，目录剩余 ${Math.floor(free / 1048576)} MiB。请选择其他目录。`,
    );
}
module.exports = { estimatedBytes, checkExportDirectory };
