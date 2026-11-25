'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const semver = require('semver');
const { verifyManifest } = require('./verify-release.cjs');

async function stageUpdate(source, destination, version, notes) {
  if (!semver.valid(version) || !path.isAbsolute(destination)) throw Error('请指定版本和内部目录的绝对路径。');
  const channel = semver.prerelease(version) ? 'preview.yml' : 'latest.yml';
  await verifyManifest(source, version, notes);
  await fs.mkdir(destination, { recursive: true });
  const lock = path.join(destination, '.jiajian-update-lock');
  await fs.mkdir(lock);
  try {
    const setup = 'Jiajian-Setup-' + version + '-x64.exe';
    for (const file of [setup, setup + '.blockmap']) {
      try {
        await fs.access(path.join(destination, file));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        await fs.copyFile(path.join(source, file), path.join(lock, file));
        await fs.rename(path.join(lock, file), path.join(destination, file));
      }
    }
    // Existing versioned files must match before the server can advertise them.
    await fs.copyFile(path.join(source, channel), path.join(lock, channel));
    const yaml = require('node:module').createRequire(require.resolve('electron-updater/package.json'))('js-yaml');
    const current = await fs.readFile(path.join(destination, channel), 'utf8').catch((error) => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    if (current && semver.gt(yaml.load(current).version, version)) throw Error('此通道已有更高版本。');
    await verifyManifest(destination, version, notes, path.join(lock, channel));
    await fs.rename(path.join(lock, channel), path.join(destination, channel));
  } finally {
    await fs.rm(lock, { recursive: true, force: true });
  }
}
if (require.main === module) {
  const [source, destination, version, file] = process.argv.slice(2);
  fs.readFile(file, 'utf8')
    .then((notes) => stageUpdate(source, destination, version, notes))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
module.exports = { stageUpdate };
