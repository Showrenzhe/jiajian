'use strict';

// Directory names and membership belong to the project. The media service's
// browsing ids are session-local and are never written to a project file.
window.createMaterialFolderTree = function createMaterialFolderTree() {
  const rows = new Map();
  const sources = new Map();
  const grants = new Set();
  const files = new Map();
  const folded = name => name.normalize('NFC').toLowerCase();
  const reserved = /^(con|prn|aux|nul|conin\$|conout\$|(?:com|lpt)[1-9¹²³])(\.|$)|^\.jiajian-(owner|scopes)$/i;
  function children(scope, parentId) {
    return [...rows.values()].filter(row => row.scope === scope && row.parentId === parentId);
  }
  function validate(name, siblings, except) {
    if (!name.trim() || name.length > 100 || !name.isWellFormed() || /[<>:"/\\|?*\x00-\x1f]|[. ]$/.test(name) || reserved.test(name)) {
      throw Error('请输入有效的文件夹名称，最多 100 个字符。');
    }
    if (siblings.some(row => row.id !== except && folded(row.name) === folded(name))) throw Error('同一位置已有这个文件夹。');
    return name;
  }
  function rowFor(scope, parentId, name, siblings) {
    validate(name, siblings);
    let depth = 1;
    for (let parent = parentId; parent; parent = rows.get(parent)?.parentId) depth++;
    if (depth > 32 || rows.size >= 2048) throw Error('素材库最多支持 32 层、2048 个文件夹。');
    return {id: crypto.randomUUID(), scope, parentId, name, assetIds: []};
  }
  function uniqueName(name, siblings) {
    let base = name.slice(0, 100).toWellFormed().replace(/[. ]+$/, '');
    if (!base) base = '文件夹';
    if (reserved.test(base)) base = ('文件夹 ' + base).slice(0, 100).toWellFormed();
    let value = base;
    for (let i = 2; siblings.some(row => folded(row.name) === folded(value)); i++) {
      const suffix = ' (' + i + ')';
      value = base.slice(0, 100 - suffix.length).toWellFormed() + suffix;
    }
    return value;
  }
  async function importDirectory(api, scope, parentId, root, extraSiblings = []) {
    const pending = [], warnings = new Set();
    let baseDepth = 1;
    for (let id = parentId; id; id = rows.get(id)?.parentId) baseDepth++;
    async function visit(entry, parent, depth, listing) {
      const siblings = [...children(scope, parent), ...pending.filter(row => row.parentId === parent)];
      let row = siblings.find(child => child.sourceKey === entry.sourceKey);
      if (!row) {
        if (depth > 32 || rows.size + pending.length >= 2048) throw Error('素材库最多支持 32 层、2048 个文件夹。');
        const names = parent === parentId ? [...siblings, ...extraSiblings] : siblings;
        const name = uniqueName(entry.name, names);
        validate(name, names);
        row = {id: crypto.randomUUID(), scope, parentId: parent, name, sourceKey: entry.sourceKey, assetIds: []};
        pending.push(row);
      }
      sources.set(entry.sourceKey, entry.id);
      let content = listing;
      if (!content) {
        try { content = await api.browseMaterialFolder(entry.id); }
        catch (error) {
          if (depth === baseDepth) throw error;
          warnings.add('无法读取「' + entry.name + '」中的素材。');
          return row;
        }
      }
      for (const note of content.warnings ?? []) warnings.add(note);
      for (const child of content.folders) await visit(child, row.id, depth + 1);
      return row;
    }
    const row = await visit(root, parentId, baseDepth, root.folders ? root : null);
    for (const item of pending) rows.set(item.id, item);
    grants.add(root.sourceKey);
    return {row, warnings: [...warnings]};
  }
  async function read(api, row) {
    let listing, warning;
    if (row.sourceKey && sources.has(row.sourceKey)) {
      try {
        listing = await api.browseMaterialFolder(sources.get(row.sourceKey));
        for (const nested of listing.folders) if (!grants.has(nested.sourceKey) || !sources.has(nested.sourceKey)) sources.set(nested.sourceKey, nested.id);
      } catch (error) { warning = error.message; }
    }
    files.set(row.id, listing?.files ?? []);
    return warning || listing?.warnings?.join(' · ') || (row.sourceKey && !listing ? '原素材目录暂不可用。' : '');
  }
  function descendants(id) {
    const ids = new Set([id]);
    const visit = parent => {
      for (const row of rows.values()) if (row.parentId === parent) { ids.add(row.id); visit(row.id); }
    };
    visit(id);
    return ids;
  }
  return {
    rows, sources, grants, files, children, descendants, uniqueName, importDirectory, read,
    create(scope, parentId, name, siblings) {
      const row = rowFor(scope, parentId, name, siblings);
      rows.set(row.id, row);
      return row;
    },
    rename(row, name, siblings) { row.name = validate(name, siblings, row.id); },
    remove(row) {
      const removed = [];
      for (const id of descendants(row.id)) { removed.push(rows.get(id)); rows.delete(id); files.delete(id); }
      return removed;
    },
    restore(snapshot, full, roots, keys) {
      rows.clear();
      if (full) { sources.clear(); files.clear(); }
      grants.clear();
      for (const key of keys) grants.add(key);
      for (const root of roots) sources.set(root.sourceKey, root.id);
      for (const row of structuredClone(snapshot)) rows.set(row.id, row);
    },
  };
};
