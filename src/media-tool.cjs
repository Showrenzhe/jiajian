'use strict';

const path = require('node:path');
const { existsSync } = require('node:fs');

const projectRoot = path.join(__dirname, '..');

let warnedAboutLegacy = false;

/** @param {'ffmpeg' | 'ffprobe'} tool @param {string} [resourcesPath] */
function mediaTool(tool, resourcesPath) {
  const suffix = tool.toUpperCase();
  const current = process.env[`JIAJIAN_${suffix}`];
  const legacy = process.env[`SUPERDIR_REPLICA_${suffix}`];
  if (!current && legacy && !warnedAboutLegacy) {
    warnedAboutLegacy = true;
    console.warn('旧版媒体工具环境变量已弃用，请改用 JIAJIAN_FFMPEG（FFmpeg）或 JIAJIAN_FFPROBE（FFprobe）。');
  }
  const configured = current || legacy;
  if (configured) return /[\\/]/.test(configured) ? path.resolve(configured) : configured;
  const filename = process.platform === 'win32' ? tool + '.exe' : tool;
  const bundled = path.join(resourcesPath || projectRoot, 'tools', 'ffmpeg-8.0-full_build', 'bin', filename);
  return resourcesPath || existsSync(bundled) ? bundled : tool;
}

module.exports = { mediaTool };
