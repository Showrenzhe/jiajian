'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { getWorkflow, listWorkflows } = require('../src/workflow-provider.cjs');

test('distinguishes runnable local actions from unavailable API capabilities', () => {
  const routes = listWorkflows();
  assert.equal(new Set(routes.map((route) => route.id)).size, routes.length);
  assert.deepEqual(getWorkflow('replicate'), routes.find((route) => route.id === 'replicate'));
  assert.equal(getWorkflow('unknown'), null);
  for (const id of ['replicate', 'ai-video', 'smart-slice', 'digital-avatar', 'voice-clone', 'face-fusion', 'distribution', 'analytics', 'teams']) {
    const route = getWorkflow(id);
    assert.equal(route.status, 'api-pending');
    assert.ok(route.requirements.length > 0);
    assert.deepEqual(route.localActions, []);
  }
  for (const [id, action] of [['assets', 'montage.import'], ['script', 'script.edit'], ['tasks', 'tasks.recent']]) {
    const route = getWorkflow(id);
    assert.equal(route.status, 'partial');
    assert.ok(route.requirements.length > 0);
    assert.deepEqual(route.localActions.map((entry) => entry.id), [action]);
  }
  for (const id of ['montage', 'audio']) {
    const route = getWorkflow(id);
    assert.equal(route.status, 'local');
    assert.deepEqual(route.requirements, []);
  }
});

test('does not let a caller change workflow state or requirements', () => {
  const route = getWorkflow('replicate');
  route.status = 'local';
  route.requirements[0].id = 'unrelated';
  route.localActions.push({ id: 'fake-job' });
  const reread = getWorkflow('replicate');
  assert.equal(reread.status, 'api-pending');
  assert.equal(reread.requirements[0].id, 'media.resolve-link');
  assert.deepEqual(reread.localActions, []);
});
