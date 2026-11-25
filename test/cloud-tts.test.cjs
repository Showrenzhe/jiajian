'use strict';
process.env.JIAJIAN_TEST_LOOPBACK = '1';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { test } = require('node:test');
const { createCloudTts, isSeedAudioVoiceId, seedAudioEndpoint, seedAudioVoiceId } = require('../src/cloud-tts.cjs');
const { ffmpeg } = require('./fixtures.cjs');

function wave() {
  const data = Buffer.alloc(44 + 4800);
  data.write('RIFF');
  data.writeUInt32LE(data.length - 8, 4);
  data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(24000, 24);
  data.writeUInt32LE(48000, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write('data', 36);
  data.writeUInt32LE(data.length - 44, 40);
  return data;
}

async function outputFixture(t) {
  const parent = path.resolve(__dirname, '../test-data');
  await fs.mkdir(parent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parent, 'cloud-tts-'));
  t.after(async () => {
    const checked = await fs.realpath(directory);
    assert.equal(path.dirname(checked), await fs.realpath(parent));
    assert.ok(path.basename(checked).startsWith('cloud-tts-'));
    await fs.rm(checked, { recursive: true, force: true });
  });
  return directory;
}

async function stubService(t, respond) {
  const calls = [];
  function route(call) {
    calls.push(call);
    const { status = 200, body, headers = {} } = respond(call);
    const bytes = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    return { status, headers, bytes };
  }
  const server = http.createServer(async (request, response) => {
    if (request.url === '/_self-check') { response.writeHead(204).end(); return; }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const { status, headers, bytes } = route({ method: request.method, path: request.url, headers: request.headers, body: Buffer.concat(chunks) });
    response.writeHead(status, headers).end(bytes);
  });
  let port;
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    port = server.address().port;
    await new Promise((resolve, reject) => {
      const probe = http.get(new URL(`http://127.0.0.1:${port}/_self-check`), { agent: false }, (response) => {
        response.resume();
        response.once('end', resolve);
      });
      probe.once('error', reject);
    });
    t.after(() => new Promise((resolve) => server.close(resolve)));
  } catch (error) {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    if (!['EACCES', 'EPERM'].includes(error.code)) throw error;
    t.diagnostic('Managed sandbox denied loopback traffic. Using the same stub with a mocked HTTP transport.');
    port = 31917;
    t.mock.method(http, 'request', (url, options, receive) => {
      assert.equal(url.origin, `http://127.0.0.1:${port}`);
      assert.equal(options.agent, false);
      const request = new EventEmitter();
      request.end = (body) => {
        const headers = Object.fromEntries(Object.entries(options.headers).map(([key, value]) => [key.toLowerCase(), value]));
        const result = route({ method: options.method, path: url.pathname, headers, body: body ?? Buffer.alloc(0) });
        const response = new PassThrough();
        response.statusCode = result.status;
        response.headers = result.headers;
        receive(response);
        response.end(result.bytes);
      };
      return request;
    });
  }

  const directory = await outputFixture(t);
  return {
    calls, directory,
    provider: (options = {}) => createCloudTts({
      baseUrl: `http://127.0.0.1:${port}/gateway/`, apiKey: null, outputDirectory: directory,
      pollIntervalMs: 2, requestTimeoutMs: 1000, jobTimeoutMs: 3000, cancelTimeoutMs: 1000, ...options,
    }),
  };
}

test('validates base URLs and reports unconfigured status without contacting a service', async () => {
  assert.deepEqual(createCloudTts({ baseUrl: null, apiKey: null }).status(), { configured: false });
  for (const baseUrl of ['http://localhost:80', 'http://2130706433', 'http://127.1', 'https://user@example.test', 'https://example.test/?', 'https://example.test/#secret']) {
    assert.throws(() => createCloudTts({ baseUrl, apiKey: null }), /语音服务/);
  }
  assert.throws(() => createCloudTts({ baseUrl: 'https://example.test', apiKey: 'fake\nsecret' }), /密钥格式/);
  await assert.rejects(createCloudTts({ baseUrl: null, apiKey: null }).listVoices(), /尚未配置/);
});

function mockSeed(t, respond) {
  const calls = [];
  t.mock.method(https, 'request', (url, options, receive) => {
    const request = new EventEmitter();
    request.end = (payload) => {
      const call = { url: url.href, method: options.method, headers: options.headers, body: payload ? JSON.parse(payload) : undefined };
      calls.push(call);
      const result = respond(call);
      if (!result) {
        options.signal.addEventListener('abort', () => request.emit('error', options.signal.reason), { once: true });
        return;
      }
      const response = new PassThrough();
      response.statusCode = result.status ?? 200;
      response.headers = result.headers ?? {};
      receive(response);
      response.end(Buffer.isBuffer(result.body) ? result.body : JSON.stringify(result.body));
    };
    return request;
  });
  return calls;
}

test('Breeze Blue pages all account voices, auditions redirected samples without credentials, and generates timed or plain WAV', async (t) => {
  const directory = await outputFixture(t);
  const audio = wave();
  const voice = { voice_id: 'voc_01', name: '阿晴', language_code: 'zh', gender: 'female', preview_url: '/demo.wav' };
  const calls = mockSeed(t, ({ url, body, headers }) => {
    const address = new URL(url);
    if (address.hostname === 'samples.example.test') {
      assert.equal(headers['xi-api-key'], undefined);
      return { body: audio };
    }
    assert.equal(address.origin, 'https://api.breeze.blue');
    assert.equal(headers['xi-api-key'], 'breeze-test-only');
    assert.equal(headers.Authorization, undefined);
    if (address.pathname === '/v1/voices') {
      assert.equal(address.searchParams.get('page_size'), '100');
      if (!address.searchParams.has('next_page_token')) return { body: { voices: [voice], has_more: true, next_page_token: 'opaque+token', total: 2 } };
      assert.equal(address.searchParams.get('next_page_token'), 'opaque+token');
      return { body: { voices: [{ ...voice, voice_id: 'voc_02', preview_url: null }], has_more: false, total: 2 } };
    }
    if (address.pathname === '/demo.wav') return { status: 302, headers: { location: 'https://samples.example.test/signed' } };
    assert.equal(address.searchParams.get('output_format'), 'wav');
    assert.equal(body.model_id, 'breeze-tts-2-multilingual');
    if (address.pathname === '/v1/text-to-speech/voc_01/with-timestamps') {
      assert.deepEqual(body.voice_settings, { speed: 1.25, volume: 0.65 });
      return { body: { audio_base64: audio.toString('base64'), content_type: 'audio/wav',
        word_timestamps: [{ word: '你好', start: .1, end: .3 }, { word: '再见', start: .4, end: .8 }] } };
    }
    assert.equal(address.pathname, '/v1/text-to-speech/voc_02');
    return { body: audio };
  });
  const provider = createCloudTts({ provider: 'breezeblue', apiKey: 'breeze-test-only', outputDirectory: directory });
  const first = await provider.listVoices({ search: '晴', filter: 'female' });
  assert.equal(new URL(calls[0].url).searchParams.get('search'), '晴');
  assert.equal(new URL(calls[0].url).searchParams.get('gender'), 'female');
  assert.equal(first.voices[0].generatedSample, false);
  const second = await provider.listVoices({ ...first.next, search: '晴', filter: 'female' });
  assert.equal(second.next, null);
  assert.equal(second.voices[0].generatedSample, true);
  for (const id of ['voc_01', 'voc_02']) assert.deepEqual(await fs.readFile((await provider.sample(id)).path), audio);
  const result = await provider.synthesize({ voiceId: 'voc_01', text: '你好。再见！', speed: 1.25, volume: 65 });
  assert.deepEqual(await fs.readFile(result.path), audio);
  assert.deepEqual(result.captions, [{ start: 100, end: 300, text: '你好。' }, { start: 400, end: 800, text: '再见！' }]);
  await assert.rejects(provider.synthesize({ voiceId: 'voc_01', text: '字'.repeat(1001) }), /1000/);
  await assert.rejects(createCloudTts({ provider: 'breezeblue' }).listVoices(), /API Key/);
});

test('Breeze credential checks use one read-only voice query and report authentication, permission and credit failures separately', async (t) => {
  let status=200, payload={voices:[],has_more:false};
  const fixture='fixture-credential';
  const calls=mockSeed(t, ({url,method,headers})=>{
    assert.equal(url,'https://api.breeze.blue/v1/voices?page_size=1');
    assert.equal(method,'GET');
    assert.equal(headers['xi-api-key'],fixture);
    return {status,body:payload};
  });
  const provider=createCloudTts({provider:'breezeblue',apiKey:fixture});
  assert.equal(await provider.verifyAccess(),true);
  payload={error:{message:'server-'+fixture}};
  for (const [code,text] of [[401,/身份验证.*401/],[403,/权限.*403/],[402,/余额.*402/]]) {
    status=code;
    await assert.rejects(provider.verifyAccess(),(error)=>text.test(error.message) && !error.message.includes(fixture));
  }
  status=200;
  await assert.rejects(provider.verifyAccess(),/音色目录格式/);
  const bad=createCloudTts({provider:'breezeblue',apiKey:'key_exampleid'});
  await assert.rejects(bad.listVoices(),/管理编号.*brz_/);
  await assert.rejects(bad.verifyAccess(),/管理编号.*brz_/);
  assert.equal(calls.length,5);
});

test('a forbidden CDN preview offers to reload the sample without exposing signed URLs or suggesting a new API key', async (t) => {
  const directory=await outputFixture(t);
  const calls=mockSeed(t,({url,headers})=>{
    if (new URL(url).hostname==='samples.example.test') {
      assert.equal(headers['xi-api-key'],undefined);
      return {status:403,body:{detail:'sensitive-server-detail'}};
    }
    if (new URL(url).pathname==='/demo.wav') return {status:302,headers:{location:'https://samples.example.test/demo.wav?signature=private-test-value'}};
    return {body:{voices:[{voice_id:'voice1',name:'测试',preview_url:'/demo.wav'}],has_more:false}};
  });
  const provider=createCloudTts({provider:'breezeblue',apiKey:'fixture-key',outputDirectory:directory});
  await provider.listVoices();
  await assert.rejects(provider.sample('voice1'),(error)=>/试听链接.*403/.test(error.message)
    && !/API Key|signature|private-test-value|sensitive-server-detail/.test(error.message));
  assert.equal(calls.length,3);
});

test('Seed Audio sends the official request and saves only genuine timed MP3 output', async (t) => {
  const directory = await outputFixture(t);
  const audio = await ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=660', '-t', '0.18', '-c:a', 'libmp3lame', '-ar', '48000', '-f', 'mp3', 'pipe:1']);
  const calls = mockSeed(t, () => ({ body: {
    audio: audio.toString('base64'), url: 'https://example.test/unused',
    subtitle: { text: '不能用整段文本编造时码', sentences: [{ start_time: 21, end_time: 153, text: '试\u0007音' }] },
  } }));
  const provider = createCloudTts({ provider: seedAudioVoiceId, apiKey: 'seed-test-key', outputDirectory: directory });
  assert.deepEqual(provider.status(), { configured: true, provider: 'seed-audio' });
  const { voices } = await provider.listVoices();
  const presetId = 'zh_female_vv_uranus_bigtts';
  assert.deepEqual(voices[0], { id: seedAudioVoiceId, name: '由提示词生成音色', hasSample: true });
  assert.deepEqual(voices.find(({ id }) => id === presetId), { id: presetId, name: 'Vivi 2.0', hasSample: true });
  assert.ok(voices.some(({ id }) => id === 'zh_male_m191_uranus_bigtts'));
  assert.ok(voices.every(({ id, hasSample }) => isSeedAudioVoiceId(id) && hasSample));
  const sample = await provider.sample(presetId);
  assert.equal(path.extname(sample.path), '.mp3');
  assert.deepEqual(await fs.readFile(sample.path), audio);
  assert.equal(isSeedAudioVoiceId('unknown-voice'), false);
  await assert.rejects(provider.synthesize({ text: '试音', voiceId: 'unknown-voice' }), /有效的 Seed Audio 音色/);
  await assert.rejects(provider.synthesize({ text: '字'.repeat(3001) }), /3000/);
  await assert.rejects(provider.synthesize({ text: '试音', volume: 49 }), /50 到 200/);
  await assert.rejects(provider.synthesize({ text: '试音', pitch: 1.5 }), /音调/);
  assert.equal(calls.length, 1);
  const progress = [];
  const result = await provider.synthesize({
    text: '慢速试音。', voiceId: seedAudioVoiceId, speed: 0.5, volume: 175, pitch: -6, onProgress: (value) => progress.push(value),
  });
  assert.equal(path.extname(result.path), '.mp3');
  assert.deepEqual(await fs.readFile(result.path), audio);
  assert.deepEqual(result.captions, [{ start: 21, end: 153, text: '试音' }]);
  assert.deepEqual(progress, [0, 1]);
  const call = calls[1];
  assert.equal(call.url, seedAudioEndpoint);
  assert.equal(call.method, 'POST');
  assert.equal(call.headers['X-Api-Key'], 'seed-test-key');
  assert.match(call.headers['X-Api-Request-Id'], /^[a-f0-9-]{36}$/);
  assert.equal(call.headers.Authorization, undefined);
  assert.deepEqual(call.body, {
    model: 'seed-audio-1.0', text_prompt: '慢速试音。', watermark: {},
    audio_config: { format: 'mp3', sample_rate: 48000, speech_rate: -50, loudness_rate: 75, pitch_rate: -6, enable_subtitle: true },
  });
  const withoutSubtitles = await provider.synthesize({ text: '不要字幕。', voiceId: presetId, enableSubtitles: false });
  assert.deepEqual(calls[2].body.references, [{ speaker: presetId }]);
  assert.equal(calls[2].body.text_prompt, '不要字幕。');
  assert.equal(calls[2].body.audio_config.enable_subtitle, false);
  assert.equal(withoutSubtitles.captions, undefined);
  assert.ok((await fs.readdir(directory)).every((file) => file.endsWith('.mp3')));
});

test('Seed Audio never follows response URLs and cleans up aborts and timeouts', async (t) => {
  const directory = await outputFixture(t);
  let reply = { body: { url: 'https://example.test/path?remote-secret' } };
  const calls = mockSeed(t, () => reply);
  const options = { provider: seedAudioVoiceId, apiKey: 'seed-test-key', outputDirectory: directory };
  const provider = createCloudTts(options);
  const unconfigured = createCloudTts({ provider: seedAudioVoiceId });
  assert.deepEqual(unconfigured.status(), { configured: false, provider: 'seed-audio' });
  assert.ok((await unconfigured.listVoices()).voices.length > 1);
  assert.throws(() => createCloudTts({ ...options, baseUrl: 'https://example.test/' }), /官方固定/);
  await assert.rejects(provider.synthesize({ text: '试音' }), (error) => /内嵌音频/.test(error.message) && !error.message.includes('remote-secret'));
  reply = { body: { audio: wave().toString('base64') } };
  await assert.rejects(provider.synthesize({ text: '试音' }), /有效的 MP3/);
  reply = undefined;
  const controller = new AbortController();
  const canceled = provider.synthesize({ text: '试音', signal: controller.signal });
  controller.abort();
  await assert.rejects(canceled, { name: 'AbortError' });
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(createCloudTts({ ...options, requestTimeoutMs: 15 }).synthesize({ text: '试音' }), /超时/);
  } finally { clearTimeout(keepAlive); }
  assert.equal(calls.length, 4);
  assert.ok(calls.every(({ url }) => url === seedAudioEndpoint));
  assert.deepEqual(await fs.readdir(directory), []);
});

test('preserves gateway prefix, pairs progress with a job, and saves validated WAV and captions', async (t) => {
  let polls = 0;
  const pcm = wave();
  const stub = await stubService(t, ({ method, path: route }) => {
    const name = `${method} ${route}`;
    if (name === 'GET /gateway/v1/voices') return { body: { voices: [{ id: 'cn.1', name: '测试音色\u0007', hasSample: true, unused: 'filtered' }] } };
    if (name === 'GET /gateway/v1/voices/cn.1/sample') return { body: pcm };
    if (name === 'POST /gateway/v1/speech/jobs') return { status: 202, body: { id: 'job-a' } };
    if (name === 'GET /gateway/v1/speech/jobs/job-a') return { body: ++polls === 1 ? { status: 'running', progress: 0.45 }
      : { status: 'succeeded', captions: [{ start: 0, end: 90, text: '测试\u0007台词' }] } };
    if (name === 'GET /gateway/v1/speech/jobs/job-a/audio') return { body: pcm };
    return { status: 404 };
  });
  const provider = stub.provider({ apiKey: 'test-only-key' });
  assert.deepEqual(provider.status(), { configured: true });
  assert.deepEqual(await provider.listVoices(), { voices: [{ id: 'cn.1', name: '测试音色', hasSample: true }] });
  const sample = await provider.sample('cn.1');
  assert.deepEqual(await fs.readFile(sample.path), pcm);
  const progress = [];
  const result = await provider.synthesize({ text: '  测试台词  ', voiceId: 'cn.1', speed: 1.25, volume: 60, onProgress: (value) => progress.push(value) });
  assert.deepEqual(await fs.readFile(result.path), pcm);
  assert.deepEqual(result.captions, [{ start: 0, end: 90, text: '测试台词' }]);
  assert.deepEqual(progress, [0.45, 1]);
  assert.deepEqual((await fs.readdir(stub.directory)).sort(), [path.basename(sample.path), path.basename(result.path)].sort());
  assert.ok(stub.calls.every(({ headers }) => headers.authorization === 'Bearer test-only-key'));
  const submitted = stub.calls.find(({ method, path: route }) => method === 'POST' && route.endsWith('/jobs'));
  assert.deepEqual(JSON.parse(submitted.body), { text: '测试台词', voiceId: 'cn.1', speed: 1.25, volume: 60, format: 'wav' });
});

test('cancels known remote jobs on abort and deadline without publishing a file', async (t) => {
  const stub = await stubService(t, ({ method, path: route }) => {
    const name = `${method} ${route}`;
    if (name === 'POST /gateway/v1/speech/jobs') return { body: { id: 'job-b', status: 'queued' } };
    if (name === 'GET /gateway/v1/speech/jobs/job-b') return { body: { status: 'running', progress: 0.2 } };
    if (name === 'POST /gateway/v1/speech/jobs/job-b/cancel') return { status: 204 };
    return { status: 404 };
  });
  const controller = new AbortController();
  await assert.rejects(stub.provider().synthesize({ text: '台词', voiceId: 'cn.1', signal: controller.signal, onProgress: () => controller.abort() }), { name: 'AbortError' });
  await assert.rejects(stub.provider({ pollIntervalMs: 300, jobTimeoutMs: 150 }).synthesize({ text: '台词', voiceId: 'cn.1' }), /超时/);
  assert.equal(stub.calls.filter(({ path: route }) => route.endsWith('/cancel')).length, 2);
  assert.deepEqual(await fs.readdir(stub.directory), []);
});

test('rejects redirects, malformed WAV and opaque IDs without exposing remote bodies', async (t) => {
  const stub = await stubService(t, ({ path: route }) => {
    if (route.endsWith('/voices')) return { status: 302, headers: { location: 'https://example.test/' }, body: 'private remote details' };
    return { body: Buffer.from('remote server data') };
  });
  const provider = stub.provider();
  await assert.rejects(provider.listVoices(), (error) => /响应失败/.test(error.message) && !error.message.includes('private'));
  await assert.rejects(provider.sample('../secret'), /有效的音色/);
  await assert.rejects(provider.sample('cn.1'), /有效的 WAV/);
  assert.deepEqual(stub.calls.map(({ path: route }) => route), ['/gateway/v1/voices', '/gateway/v1/voices/cn.1/sample']);
  assert.deepEqual(await fs.readdir(stub.directory), []);
});
