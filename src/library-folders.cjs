'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const ownerFile = '.jiajian-owner';
const privateScopes = '.jiajian-scopes';
const invalidName = /[<>:"/\\|?*\x00-\x1f]|[. ]$|^(con|prn|aux|nul|conin\$|conout\$|(?:com|lpt)[1-9¹²³])(?:\.|$)/i;
const fold = name => name.normalize('NFC').toLowerCase();

function normalizeLibraryFolders(value, scopes, record) {
  if (!Array.isArray(value) || value.length > 2048) throw Error('素材库最多支持 2048 个文件夹。');
  const byId = new Map(), siblings = new Set();
  const key = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
  const folders = value.map(row => {
    const { id, parentId, scope, name, assetIds, sourceKey, hiddenKeys } = row ?? {};
    if (typeof id !== 'string' || !/^[\w-]{1,128}$/.test(id) || byId.has(id) || !scopes.has(scope) ||
        !(parentId === null || typeof parentId === 'string')) throw Error('素材文件夹编号或工程无效。');
    if (typeof name !== 'string' || !name.trim() || name.length > 100 || !name.isWellFormed() || invalidName.test(name) ||
        [ownerFile,privateScopes].includes(fold(name))) throw Error('请输入有效的素材文件夹名称。');
    const sibling = JSON.stringify([scope,parentId,fold(name)]);
    if (siblings.has(sibling)) throw Error('同一位置已有同名素材文件夹。');
    siblings.add(sibling);
    if (!Array.isArray(assetIds) || (sourceKey !== undefined && !key(sourceKey)) ||
        (hiddenKeys !== undefined && (!Array.isArray(hiddenKeys) || !hiddenKeys.every(key)))) throw Error('素材文件夹内容无效。');
    const folder = {id,parentId,scope,name,assetIds:[...new Set(assetIds.map(id => record(id,'library')))],
      ...(sourceKey && {sourceKey}), ...(hiddenKeys !== undefined && {hiddenKeys:[...new Set(hiddenKeys)]})};
    byId.set(id, folder);
    return folder;
  });
  for (const folder of folders) {
    let item = folder;
    for (let depth=1; item.parentId !== null; depth++) {
      item = byId.get(item.parentId);
      if (!item || item.scope !== folder.scope || depth >= 32) throw Error('素材文件夹的父级或嵌套层数无效。');
    }
  }
  return folders;
}

function folderTree(folders) {
  const branch = id => ({id, children:new Map()});
  const root = branch('@root'), parents = new Map(folders.map(f => [f.id,branch(f.id)]));
  const scopes = branch('@scopes');
  for (const {id,parentId,scope,name} of folders) {
    let parent = root;
    if (parentId !== null) parent = parents.get(parentId);
    else if (scope !== null) {
      root.children.set(privateScopes,scopes);
      // Legacy subproject IDs need not be valid Windows directory names.
      const scopeName = Buffer.from(scope).toString('hex');
      if (!scopes.children.has(scopeName)) scopes.children.set(scopeName,branch('@' + scope));
      parent = scopes.children.get(scopeName);
    }
    parent.children.set(name,parents.get(id));
  }
  return root;
}

// The mirror only owns directories it created. Source media stay at the paths
// in the project asset catalog. Never recursively remove an arbitrary path.
async function withDraftFolderMirror(directory, draftId, folders, publish) {
  const root = path.join(directory, draftId + '.素材库'), expected = folderTree(folders);
  const undo = [];
  async function owner(dir) {
    try {
      const info = await fs.lstat(dir);
      if (!info.isDirectory() || info.isSymbolicLink()) return null;
      const file = path.join(dir,ownerFile), marker = await fs.lstat(file);
      if (!marker.isFile() || marker.size > 200) return null;
      const [draft,id] = (await fs.readFile(file,'utf8')).split('\n');
      return draft === draftId && /^@?[\w-]{1,128}$/.test(id ?? '') ? id : null;
    } catch (err) { if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null; throw err; }
  }
  const token = id => draftId + '\n' + id;
  async function create(dir,id) {
    await fs.mkdir(dir);
    try { await fs.writeFile(path.join(dir,ownerFile), token(id), {flag:'wx'}); }
    catch (err) { await fs.rmdir(dir).catch(()=>{}); throw err; }
  }
  async function remove(dir,id) {
    if (await owner(dir) !== id) throw Error('草稿素材文件夹已在磁盘上发生变化。');
    const names = await fs.readdir(dir);
    if (names.length !== 1 || names[0] !== ownerFile) throw Error('草稿素材文件夹内有额外文件，请移出后再保存：' + dir);
    const marker = path.join(dir,ownerFile);
    await fs.unlink(marker);
    try { await fs.rmdir(dir); }
    catch (err) { await fs.writeFile(marker,token(id),{flag:'wx'}).catch(()=>{}); throw err; }
  }
  async function reconcile(dir, children) {
    const byName = new Map(), byId = new Map();
    const wanted = new Map([...children].map(([name,child]) => [fold(name),child.id]));
    for (const entry of await fs.readdir(dir,{withFileTypes:true})) {
      if (entry.name === ownerFile) continue;
      const from = path.join(dir,entry.name), id = entry.isDirectory() ? await owner(from) : null;
      byName.set(fold(entry.name),{name:entry.name,id});
      if (!id) continue;
      if (byId.has(id)) throw Error('草稿素材目录内有重复的文件夹标识：' + entry.name);
      let located = from;
      // Free occupied names first, including A/B rename swaps. Moving the
      // original directory keeps user-added contents through a rename.
      if (wanted.has(fold(entry.name)) && wanted.get(fold(entry.name)) !== id) {
        located = path.join(dir,'.jiajian-' + randomUUID());
        await fs.rename(from,located);
        undo.push(() => fs.rename(located,from));
        byName.delete(fold(entry.name));
      }
      byId.set(id,located);
    }
    for (const [name,child] of children) {
      const dest = path.join(dir,name), atName = byName.get(fold(name)), from = byId.get(child.id);
      if (atName && !atName.id) throw Error('草稿素材目录内已有同名文件或文件夹：' + name);
      if (!from) {
        await create(dest,child.id);
        undo.push(() => remove(dest,child.id));
      } else if (from !== dest) {
        await fs.rename(from,dest);
        undo.push(() => fs.rename(dest,from));
      }
      byId.delete(child.id);
      await reconcile(dest,child.children);
    }
    for (const [id,file] of byId) {
      await reconcile(file,new Map());
      await remove(file,id);
      undo.push(() => create(file,id));
    }
  }
  try {
    const exists = await fs.lstat(root).then(()=>true,err=>{ if (err.code==='ENOENT') return false; throw err; });
    if (!exists && !expected.children.size) return await publish();
    if (exists && await owner(root) !== expected.id) {
      if (!expected.children.size) return await publish();
      throw Error('草稿素材库目录被其他文件占用：' + root);
    }
    if (!exists) {
      await create(root,expected.id);
      undo.push(() => remove(root,expected.id));
    }
    await reconcile(root,expected.children);
    if (!expected.children.size && (await fs.readdir(root)).length === 1) {
      await remove(root,expected.id);
      undo.push(() => create(root,expected.id));
    }
    return await publish();
  } catch (err) {
    for (const reverse of undo.reverse()) await reverse().catch(()=>{});
    throw err;
  }
}

module.exports = { normalizeLibraryFolders, withDraftFolderMirror };
