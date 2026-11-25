'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { isMaterialPath, checkedMaterialPath } = require('./material-path.cjs');

function missingAsset(row, config) {
  const shots = [
    ...config.shots,
    ...(config.subprojects?.main ?? []).map((row) => row.clips),
    ...(config.subprojects?.projects ?? []).flatMap((project) => project.shots.map((row) => row.clips)),
  ];
  const ends = shots.flatMap((shot) =>
    shot.flatMap((clip) =>
      clip.id === row.id
        ? [clip.end]
        : clip.sourceEdit?.id === row.id
          ? clip.sourceEdit.ranges.map((range) => range.end)
          : [],
    ),
  );
  config.segmentNarrationIds?.forEach((ids, index) =>
    ids.forEach((id, track) => {
      if (id === row.id)
        ends.push(
          config.shotSettings?.[index]?.duration ?? 0,
          ...(config.segmentVoiceCuts?.[index]?.[track]?.ranges ?? []).map((range) => range.end),
        );
    }),
  );
  return {
    kind: row.kind,
    name: path.basename(row.path),
    missing: true,
    missingPath: row.path,
    size: row.size,
    originalDuration: row.duration,
    duration: row.duration ?? Math.max(1, ...ends),
    width: 0,
    height: 0,
    audioIndex: null,
  };
}

async function locateMissing(root, missing, inspect) {
  if (!isMaterialPath(root)) throw Error('请选择素材所在的目录。');
  await checkedMaterialPath({ root, path: root, kind: 'folder' });
  const key = (name) => (process.platform === 'win32' ? name.toLowerCase() : name);
  const names = new Map([...missing.values()].map((asset) => [key(path.basename(asset.missingPath)), []]));
  const dirs = [root];
  let count = 0;
  while (dirs.length) {
    const dir = dirs.pop();
    await checkedMaterialPath({ root, path: dir, kind: 'folder' });
    const entries = await fs.opendir(dir);
    for await (const entry of entries) {
      if (++count > 100000) throw Error('目录超过十万项，请选择更接近素材的子目录。');
      if (entry.isSymbolicLink()) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) dirs.push(file);
      else if (entry.isFile() && names.has(key(entry.name))) names.get(key(entry.name)).push(file);
    }
  }
  const found = new Map();
  for (const [id, asset] of missing) {
    const candidates = [];
    for (const file of names.get(key(path.basename(asset.missingPath))) ?? []) {
      try {
        await checkedMaterialPath({ root, path: file, kind: asset.kind });
        if (asset.size != null && (await fs.stat(file)).size !== asset.size) continue;
        const result = await inspect(file, asset.kind);
        if (asset.originalDuration != null && Math.abs(asset.originalDuration - result.duration) > 0.15) continue;
        candidates.push(result);
        if (candidates.length > 1) break;
      } catch {
        /* Keep this reference offline if the candidate cannot be verified. */
      }
    }
    if (candidates.length === 1) found.set(id, candidates[0]);
  }
  return found;
}

module.exports = { missingAsset, locateMissing };
