'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');

function isLocalPath(file) {
  return typeof file === 'string' && path.isAbsolute(file) && !file.includes('\0') && !/^[\\/]{2}/.test(file)
    && (process.platform !== 'win32' || (/^[a-z]:[\\/]/i.test(file) && !file.slice(2).includes(':')));
}

function isSharedMaterialPath(file) {
  if (process.platform !== 'win32' || typeof file !== 'string' || !file.startsWith('\\\\')) return false;
  const [host, share, ...children] = file.slice(2).split('\\');
  if (!host || !/^[\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)*$/u.test(host) || !share) return false;
  if (/^(?:pipe|mailslot|ipc\$|davwwwroot)$/i.test(share)) return false;
  if (children.at(-1) === '') children.pop();
  return [share, ...children].every(part => part.length > 0 && !/[<>:"/|?*\x00-\x1f]|[ .]$/.test(part)
    && !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part));
}

function isMaterialPath(file) {
  return isLocalPath(file) || isSharedMaterialPath(file);
}

function materialPathKey(file) {
  const normalized = path.normalize(file);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

async function checkedMaterialPath(record) {
  try {
    if (!record || !isMaterialPath(record.path)) throw new Error();
    const relative = path.relative(record.root, record.path);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error();
    const info = await fs.lstat(record.path);
    if (info.isSymbolicLink() || !(record.kind === 'folder' ? info.isDirectory() : info.isFile())) throw new Error();
    const resolved = await fs.realpath(record.path);
    if (materialPathKey(resolved) !== materialPathKey(record.path)) throw new Error();
    return record.path;
  } catch {
    throw new Error(isSharedMaterialPath(record?.path) ? '共享素材不可用，请检查文件位置、网络连接和读取权限后重试。' : '素材文件夹或文件已不可用，请重新选择。');
  }
}

module.exports = { isLocalPath, isSharedMaterialPath, isMaterialPath, materialPathKey, checkedMaterialPath };
