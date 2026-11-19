'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { test } = require('node:test');
const { readProjectLibrary, rememberProject } = require('../src/project-library.cjs');

async function makeLibrary(t) {
  const parent = path.resolve(__dirname, '../test-data');
  await fs.mkdir(parent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parent, 'project-library-'));
  const file = path.join(directory, 'recent-projects.json');
  t.after(async () => {
    await fs.rm(file, { force: true });
    await fs.rmdir(directory);
  });
  return { directory, file };
}

test('persists concurrent additions in order and retains a project ID when reopened', async (t) => {
  const { directory } = await makeLibrary(t);
  const rows = await readProjectLibrary(directory);
  assert.deepEqual(rows, []);
  const first = path.join(directory, 'first.sdworkbench');
  const second = path.join(directory, '第二个.sdworkbench');
  const [a, b] = await Promise.all([rememberProject(directory, rows, first), rememberProject(directory, rows, second)]);
  assert.deepEqual(rows, [b, a]);
  const again = process.platform === 'win32' ? path.join(directory, 'First.SDWORKBENCH') : first;
  const reopened = await rememberProject(directory, rows, again);
  assert.equal(reopened.id, a.id);
  assert.deepEqual(rows, [reopened, b]);
  assert.deepEqual(await readProjectLibrary(directory), rows);
  assert.deepEqual(await fs.readdir(directory), ['recent-projects.json']);
});

test('cleans invalid or duplicate entries and keeps at most forty projects', async (t) => {
  const { directory, file } = await makeLibrary(t);
  const openedAt = '2026-11-06T01:00:00.000Z';
  const makeRow = (item) => ({ id: randomUUID(), path: item, name: 'untrusted name', openedAt });
  const available = Array.from({ length: 44 }, (_, index) => makeRow(path.join(directory, `project-${index}.sdworkbench`)));
  const [first, ...remaining] = available;
  await fs.writeFile(file, JSON.stringify([
    makeRow('relative.sdworkbench'), makeRow('\\\\server\\share\\remote.sdworkbench'),
    makeRow(path.join(directory, 'wrong.mp4')), first,
    makeRow(first.path), { ...makeRow(path.join(directory, 'duplicate.sdworkbench')), id: first.id },
    ...remaining,
  ]), { flag: 'wx' });
  const rows = await readProjectLibrary(directory);
  assert.equal(rows.length, 40);
  assert.equal(rows[0].name, 'project-0');
  assert.equal(rows.at(-1).name, 'project-39');
  await assert.rejects(rememberProject(directory, rows, 'relative.sdworkbench'), /本地/);
  const added = await rememberProject(directory, rows, path.join(directory, 'new.sdworkbench'));
  assert.equal(rows.length, 40);
  assert.equal(rows[0].id, added.id);
  assert.equal(rows.at(-1).name, 'project-38');
  assert.deepEqual(await readProjectLibrary(directory), rows);
});
