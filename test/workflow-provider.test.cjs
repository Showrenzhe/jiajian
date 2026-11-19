'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { getWorkflow, listWorkflows } = require('../src/workflow-provider.cjs');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { Readable } = require('node:stream');
const { fixtures } = require('./fixtures.cjs');
const { inspectAsset } = require('../src/media.cjs');
const { createCreativeSettings, runCreative } = require('../src/creative-service.cjs');

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

test('uses a local creative gateway to generate a cover, an avatar and editable source cuts', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jj-gateway-test-'));
  t.after(async () => { assert.equal(path.dirname(root), os.tmpdir()); await fs.rm(root, { recursive:true, force:true }); });
  const files = await fixtures(root);
  const catalog = new Map(await Promise.all([['red','video'], ['music','audio'], ['still','image']].map(async ([key,kind]) =>
    [key,await inspectAsset(files[key],kind)])));
  let mode = 'valid';
  const requests = [];
  const server = http.createServer(async (req, res) => {
    if (req.url === '/asset') { res.writeHead(200, { 'Content-Type':'video/mp4' }); res.end(await fs.readFile(files.red)); return; }
    const form = await new Request('http://127.0.0.1'+req.url, { method:'POST', headers:req.headers, body:Readable.toWeb(req), duplex:'half' }).formData();
    requests.push({ path:req.url, fields:[...form.keys()].sort(), auth:req.headers.authorization });
    if (req.url.endsWith('/replicate')) {
      res.writeHead(200, { 'Content-Type':'application/json' }); res.end(JSON.stringify({
        title:'示例拆解',source_url:mode === 'external' ? 'https://example.org/source.mp4' : '/asset',
        shots:[{start:.1,end:mode === 'long' ? 10 : .8,dialogue:'展示产品',name:'近景'}] })); return;
    }
    const image = req.url.endsWith('/cover');
    res.writeHead(200, { 'Content-Type':image ? 'image/png' : 'video/mp4' }); res.end(await fs.readFile(image ? files.still : files.red));
  });
  await new Promise((resolve) => server.listen(0,'127.0.0.1',resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const fakeStorage = { isAsyncEncryptionAvailable:async()=>true, encryptStringAsync:async(text)=>Buffer.from(text), decryptStringAsync:async(bytes)=>({ result:bytes.toString() }) };
  const store = createCreativeSettings(root,fakeStorage);
  const baseUrl = 'http://127.0.0.1:'+server.address().port+'/creative/';
  assert.deepEqual(await store.public(), {baseUrl:'',hasApiKey:false});
  assert.deepEqual(await store.save({baseUrl,apiKey:'test-only'}),{baseUrl,hasApiKey:true});
  await assert.rejects(store.save({baseUrl:'https://example.org/'}), /来源已变更/);
  const run = async (request) => runCreative(await store.read(),request,catalog,root);
  assert.equal((await run({action:'cover',prompt:'产品封面'})).asset.kind,'image');
  assert.equal((await run({action:'avatar',imageId:'still',voiceId:'music'})).asset.kind,'video');
  const result=await run({action:'replicate',videoId:'red'});
  assert.equal(result.sourceId,'red'); assert.deepEqual(result.shots,[{start:.1,end:.8,name:'近景',description:'',dialogue:'展示产品'}]);
  assert.equal((await run({action:'replicate',referenceUrl:'https://example.org/demo'})).asset.kind,'video');
  assert.deepEqual(requests[1].fields,['portrait','prompt','ratio','voice']);
  assert.ok(requests.every((entry)=>entry.auth==='Bearer test-only'));
  mode='long'; await assert.rejects(run({action:'replicate',videoId:'red'}), /起止时间/);
  mode='external'; await assert.rejects(run({action:'replicate',referenceUrl:'https://example.org/demo'}),/同一创作服务/);
});
