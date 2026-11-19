'use strict';

const assert = require('node:assert/strict');
const { createCipheriv, createDecipheriv, randomBytes } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { test } = require('node:test');
const { createCloudTtsSettings, publicSettings } = require('../src/cloud-tts-settings.cjs');
const { createCloudTts, seedAudioEndpoint } = require('../src/cloud-tts.cjs');
const { breezeEndpoint } = require('../src/breezeblue.cjs');

function mockStorage() {
  const secret = randomBytes(32);
  return {
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async (text) => {
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', secret, nonce);
      const bytes = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), bytes]);
    },
    decryptStringAsync: async (input) => {
      const decipher = createDecipheriv('aes-256-gcm', secret, input.subarray(0, 12));
      decipher.setAuthTag(input.subarray(12, 28));
      return { result: Buffer.concat([decipher.update(input.subarray(28)), decipher.final()]).toString('utf8'), shouldReEncrypt: false };
    },
  };
}

async function settingsFixture(t) {
  const parent = path.resolve(__dirname, '../test-data');
  await fs.mkdir(parent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parent, 'tts-settings-'));
  const file = path.join(directory, 'cloud-tts-settings.json');
  t.after(async () => {
    await fs.rm(file, { force: true });
    await fs.rmdir(directory);
  });
  const safeStorage = mockStorage();
  return { directory, file, safeStorage, settings: createCloudTtsSettings({ directory, safeStorage }) };
}

test('stores ciphertext and keeps a key on same-origin gateway edits', async (t) => {
  const { settings, file, directory } = await settingsFixture(t);
  const empty = await settings.load();
  assert.deepEqual(empty, { provider: 'breezeblue', baseUrl: breezeEndpoint, apiKey: '' });
  const first = await settings.save(empty, { baseUrl: 'HTTPS://speech.example.test:443/gateway/', apiKey: '  test-key-example  ' });
  assert.deepEqual(settings.publicSettings(first), { baseUrl: 'https://speech.example.test/gateway/', hasApiKey: true });
  assert.equal(Object.hasOwn(publicSettings(first), 'apiKey'), false);
  const record = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(Object.keys(record), ['version', 'baseUrl', 'keyCiphertext']);
  assert.ok(Buffer.from(record.keyCiphertext, 'base64').length > 28);
  assert.ok(!JSON.stringify(record).includes('test-key-example'));
  assert.deepEqual(await settings.load(), first);
  const edited = await settings.save(first, { baseUrl: 'https://speech.example.test/new', apiKey: ' ' });
  assert.equal(edited.apiKey, first.apiKey);
  assert.deepEqual(await settings.load(), edited);
  assert.deepEqual(await fs.readdir(directory), ['cloud-tts-settings.json']);
});

test('requires explicit key replacement or clearing when moving to another origin', async (t) => {
  const { settings, file } = await settingsFixture(t);
  const first = await settings.save(await settings.load(), { baseUrl: 'https://voice.example.test', apiKey: 'test-key-one' });
  await assert.rejects(settings.save(first, { baseUrl: 'https://other.example.test', apiKey: '' }), /来源已变更/);
  await assert.rejects(settings.save(first, { baseUrl: 'http://localhost:8080', clearKey: true }), /HTTPS/);
  assert.deepEqual(await settings.load(), first);
  const second = await settings.save(first, { baseUrl: 'https://other.example.test', apiKey: 'test-key-two' });
  const third = await settings.save(second, { baseUrl: 'http://127.0.0.1:8080', clearKey: true });
  assert.deepEqual(publicSettings(third), { baseUrl: 'http://127.0.0.1:8080/', hasApiKey: false });
  const fourth = await settings.save(third, { apiKey: 'test-key-three' });
  assert.deepEqual(await settings.save(fourth, { baseUrl: '' }), { baseUrl: '', apiKey: '' });
  assert.deepEqual(await settings.load(), { baseUrl: '', apiKey: '' });
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { version: 1, baseUrl: '', keyCiphertext: null, provider: 'gateway' });
});

test('rejects origin tampering and reports unavailable secure storage without disclosing keys', async (t) => {
  const { settings, safeStorage, directory, file } = await settingsFixture(t);
  const first = await settings.save(await settings.load(), { baseUrl: 'https://voice.example.test', apiKey: 'test-key-secret' });
  const record = JSON.parse(await fs.readFile(file, 'utf8'));
  await fs.writeFile(file, JSON.stringify({ ...record, baseUrl: 'https://changed.example.test' }));
  await assert.rejects(settings.load(), (error) => /无法读取语音服务密钥/.test(error.message) && !error.message.includes(first.apiKey));
  const unavailable = createCloudTtsSettings({ directory, safeStorage: { ...safeStorage, isAsyncEncryptionAvailable: async () => false } });
  const before = await fs.readFile(file, 'utf8');
  await assert.rejects(unavailable.save(first, { apiKey: 'test-key-new' }), (error) => /安全存储不可用/.test(error.message) && !error.message.includes('test-key-new'));
  assert.equal(await fs.readFile(file, 'utf8'), before);
  assert.deepEqual(await unavailable.save(first, { clearKey: true }), { baseUrl: first.baseUrl, apiKey: '' });
});

test('Seed Audio stores the fixed address, encrypts its key, and can be disabled by clearing it', async (t) => {
  const { settings, file } = await settingsFixture(t);
  const mockKey = 'test-seed-key';
  const selected = await settings.save(await settings.load(), { provider: 'seed-audio', apiKey: mockKey });
  assert.deepEqual(selected, { provider: 'seed-audio', baseUrl: seedAudioEndpoint, apiKey: mockKey });
  assert.deepEqual(publicSettings(selected), { provider: 'seed-audio', baseUrl: seedAudioEndpoint, hasApiKey: true });
  assert.equal(Object.hasOwn(publicSettings(selected), 'apiKey'), false);
  assert.deepEqual(await settings.load(), selected);
  assert.ok(!(await fs.readFile(file, 'utf8')).includes(mockKey));
  await assert.rejects(settings.save(selected, { baseUrl: 'https://openspeech.bytedance.com/api/v3/other' }), /固定.*服务地址/);
  const disabled = await settings.save(selected, { clearKey: true });
  assert.deepEqual(await settings.load(), { provider: 'seed-audio', baseUrl: seedAudioEndpoint, apiKey: '' });
  assert.deepEqual(publicSettings(disabled), { provider: 'seed-audio', baseUrl: seedAudioEndpoint, hasApiKey: false });
  assert.equal(createCloudTts(disabled).status().configured, false);
});

test('an empty legacy setup opens Breeze Blue, while saved provider selections retain their own credential', async (t) => {
  const { settings, file } = await settingsFixture(t);
  await fs.writeFile(file, JSON.stringify({ version: 1, baseUrl: '', keyCiphertext: null }));
  const defaults = await settings.load();
  assert.equal(defaults.provider, 'breezeblue');
  const chosen = await settings.save(defaults, { apiKey: 'fictional-breeze-test' });
  assert.equal(chosen.baseUrl, breezeEndpoint);
  assert.equal((await settings.load()).apiKey, chosen.apiKey);
  assert.deepEqual(publicSettings(chosen), { provider: 'breezeblue', baseUrl: breezeEndpoint, hasApiKey: true });
  assert.ok(!(await fs.readFile(file, 'utf8')).includes(chosen.apiKey));
  await assert.rejects(settings.save(chosen, { baseUrl: 'https://other.example.test/' }), /固定/);
  await assert.rejects(settings.save(chosen, { provider: 'seed-audio' }), /协议已变更/);
});

test('Breeze management IDs cannot replace a saved credential and legacy IDs can be corrected without losing the provider', async (t) => {
  const {settings,file,safeStorage}=await settingsFixture(t);
  const saved=await settings.save(await settings.load(),{apiKey:'test-credential'});
  const before=await fs.readFile(file);
  const incorrect='key_fixtureonly';
  const matchesHint=(error)=>/管理编号.*brz_/.test(error.message) && !error.message.includes(incorrect);
  await assert.rejects(settings.save(saved,{apiKey:incorrect}),matchesHint);
  assert.deepEqual(await fs.readFile(file),before);
  const envelope=JSON.parse(before);
  envelope.keyCiphertext=(await safeStorage.encryptStringAsync(JSON.stringify({
    provider:'breezeblue',origin:new URL(breezeEndpoint).origin,apiKey:incorrect,
  }))).toString('base64');
  await fs.writeFile(file,JSON.stringify(envelope));
  const legacy=await settings.load();
  assert.equal(legacy.provider,'breezeblue');
  assert.equal(legacy.apiKey,'');
  assert.match(publicSettings(legacy).warning,/管理编号.*brz_/);
  assert.equal(publicSettings(legacy).hasApiKey,false);
  const replacement=await settings.save(legacy,{apiKey:'new-format-allowed'});
  assert.equal((await settings.load()).apiKey,'new-format-allowed');
  assert.equal(publicSettings(replacement).warning,undefined);
});

test('switching provider cannot reuse a saved key on the same origin', async (t) => {
  const { settings, file } = await settingsFixture(t);
  const baseUrl = new URL('/gateway', seedAudioEndpoint).href;
  const legacy = await settings.save(await settings.load(), { baseUrl, apiKey: 'test-gateway-key' });
  const legacyEnvelope = JSON.parse(await fs.readFile(file, 'utf8'));
  await assert.rejects(settings.save(legacy, { provider: 'seed-audio' }), /协议已变更/);
  await fs.writeFile(file, JSON.stringify({ ...legacyEnvelope, provider: 'seed-audio', baseUrl: seedAudioEndpoint }));
  await assert.rejects(settings.load(), /无法读取语音服务密钥/);

  const seed = await settings.save(legacy, { provider: 'seed-audio', apiKey: 'test-replacement-key' });
  await assert.rejects(settings.save(seed, { provider: 'gateway', baseUrl }), /协议已变更/);
  const { provider: _, ...seedEnvelope } = JSON.parse(await fs.readFile(file, 'utf8'));
  await fs.writeFile(file, JSON.stringify({ ...seedEnvelope, baseUrl }));
  await assert.rejects(settings.load(), /无法读取语音服务密钥/);
  const gatewayAgain = await settings.save(seed, { provider: 'gateway', baseUrl, clearKey: true });
  assert.deepEqual(gatewayAgain, { baseUrl, apiKey: '' });
  assert.deepEqual(publicSettings(gatewayAgain), { baseUrl, hasApiKey: false });
  assert.deepEqual(await settings.load(), gatewayAgain);
});
