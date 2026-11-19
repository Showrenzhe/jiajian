'use strict';

const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createCloudTts, normalizeCloudTtsBaseUrl, seedAudioEndpoint } = require('./cloud-tts.cjs');

const settingsName = 'cloud-tts-settings.json';
const maxBytes = 32 * 1024;
const gateway = 'gateway';
const seedAudio = 'seed-audio';

function withProvider(values, provider) {
  return provider === seedAudio ? { ...values, provider } : values;
}

function validProvider(provider) {
  return provider === gateway || provider === seedAudio;
}

function publicSettings(current) {
  return withProvider({ baseUrl: current?.baseUrl ?? '', hasApiKey: Boolean(current?.baseUrl && current?.apiKey) }, current?.provider);
}

function localDirectory(value) {
  return typeof value === 'string' && path.isAbsolute(value) && !value.includes('\0') && !/^[\\/]{2}/.test(value)
    && (process.platform !== 'win32' || (/^[a-z]:[\\/]/i.test(value) && !value.slice(2).includes(':')));
}

async function readEnvelope(file) {
  let reader;
  try {
    reader = await fs.open(file, 'r');
    const info = await reader.stat();
    if (!info.isFile() || info.size > maxBytes) throw new Error();
    const data = Buffer.allocUnsafe(info.size + 1);
    let length = 0;
    while (length < data.length) {
      const { bytesRead } = await reader.read(data, length, data.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length !== info.size) throw new Error();
    const entry = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(0, length)));
    const provider = entry?.provider === undefined ? gateway : entry.provider;
    if (entry?.version !== 1 || !validProvider(provider) || typeof entry.baseUrl !== 'string'
        || (provider === seedAudio && entry.baseUrl !== seedAudioEndpoint)
        || (entry.keyCiphertext !== null && typeof entry.keyCiphertext !== 'string')) throw new Error();
    const baseUrl = provider === seedAudio ? seedAudioEndpoint : normalizeCloudTtsBaseUrl(entry.baseUrl);
    return withProvider({ baseUrl, keyCiphertext: entry.keyCiphertext }, provider);
  } catch (error) {
    if (!reader && error.code === 'ENOENT') {
      return { provider: seedAudio, baseUrl: seedAudioEndpoint, keyCiphertext: null };
    }
    throw new Error('无法读取语音服务设置。请重新保存。');
  } finally {
    if (reader) await reader.close();
  }
}

async function writeEnvelope(directory, file, envelope) {
  const contents = Buffer.from(JSON.stringify(envelope), 'utf8');
  if (contents.length > maxBytes) throw new Error('语音服务设置超过大小限制。');
  const pending = path.join(directory, `cloud-tts-settings-${randomUUID()}.tmp`);
  let owned = false;
  try {
    await fs.mkdir(directory, { recursive: true });
    const writer = await fs.open(pending, 'wx', 0o600);
    owned = true;
    try {
      await writer.writeFile(contents);
      await writer.sync();
    } finally {
      await writer.close();
    }
    await fs.rename(pending, file);
    owned = false;
  } catch {
    throw new Error('无法保存语音服务设置。');
  } finally {
    if (owned) await fs.rm(pending, { force: true }).catch(() => {});
  }
}

function createCloudTtsSettings({ directory, safeStorage } = {}) {
  if (!localDirectory(directory)) throw new Error('语音服务设置须保存在本机目录。');
  const file = path.join(directory, settingsName);

  async function requireEncryption() {
    if (!(await safeStorage?.isAsyncEncryptionAvailable?.())) throw new Error();
    if (process.platform === 'linux' && safeStorage?.getSelectedStorageBackend?.() === 'basic_text') throw new Error();
  }

  async function encryptKey(baseUrl, apiKey, provider) {
    try {
      await requireEncryption();
      const payload = JSON.stringify(withProvider({ origin: new URL(baseUrl).origin, apiKey }, provider));
      const ciphertext = await safeStorage.encryptStringAsync(payload);
      if (!Buffer.isBuffer(ciphertext) || !ciphertext.length) throw new Error();
      return ciphertext.toString('base64');
    } catch {
      throw new Error('系统安全存储不可用，未保存 API 密钥。');
    }
  }

  async function decryptKey(baseUrl, encoded, provider) {
    try {
      if (!baseUrl) throw new Error();
      const ciphertext = Buffer.from(encoded, 'base64');
      if (!ciphertext.length || ciphertext.toString('base64') !== encoded) throw new Error();
      await requireEncryption();
      const { result } = await safeStorage.decryptStringAsync(ciphertext);
      const { origin, apiKey, provider: storedProvider = gateway } = JSON.parse(result);
      if (origin !== new URL(baseUrl).origin || storedProvider !== provider || typeof apiKey !== 'string' || !apiKey) throw new Error();
      createCloudTts(withProvider({ baseUrl, apiKey }, provider));
      return apiKey;
    } catch {
      throw new Error('无法读取语音服务密钥。请重新输入后保存。');
    }
  }

  async function load() {
    const { baseUrl, keyCiphertext, provider = gateway } = await readEnvelope(file);
    const apiKey = keyCiphertext === null ? '' : await decryptKey(baseUrl, keyCiphertext, provider);
    return withProvider({ baseUrl, apiKey }, provider);
  }

  async function save(current, update) {
    if (!update || typeof update !== 'object' || Array.isArray(update)) throw new Error('语音服务设置无效。');
    const oldProvider = current?.provider ?? gateway;
    const requestedAddress = typeof update.baseUrl === 'string' ? update.baseUrl.trim() : undefined;
    const inferGateway = update.provider === undefined && requestedAddress && requestedAddress !== seedAudioEndpoint
      && (oldProvider === gateway || (!current?.apiKey && current?.baseUrl === seedAudioEndpoint));
    const inferredProvider = inferGateway ? gateway : oldProvider;
    const { provider = inferredProvider, baseUrl: address, apiKey: supplied = '', clearKey = false } = update;
    if (!validProvider(provider) || typeof supplied !== 'string' || typeof clearKey !== 'boolean') throw new Error('语音服务设置无效。');
    if (provider === seedAudio && address !== undefined && address !== seedAudioEndpoint) {
      throw new Error('Seed Audio 使用固定的火山引擎服务地址。');
    }
    const baseUrl = provider === seedAudio ? seedAudioEndpoint
      : normalizeCloudTtsBaseUrl(address === undefined && provider === oldProvider ? current?.baseUrl : address);
    const oldKey = current?.apiKey ?? '';
    const newKey = supplied.trim();
    let apiKey = '';
    if (baseUrl) {
      if (clearKey && newKey) throw new Error('请在替换密钥和清除密钥中选择一项。');
      if (!clearKey && !newKey && oldKey) {
        if (provider !== oldProvider) throw new Error('语音服务协议已变更。请提供新密钥，或明确清除旧密钥。');
        if (new URL(baseUrl).origin !== new URL(current.baseUrl).origin) {
          throw new Error('语音服务来源已变更。请提供新密钥，或明确清除旧密钥。');
        }
      }
      apiKey = clearKey ? '' : newKey || oldKey;
      createCloudTts(withProvider({ baseUrl, apiKey }, provider));
    }
    const keyCiphertext = apiKey ? await encryptKey(baseUrl, apiKey, provider) : null;
    await writeEnvelope(directory, file, withProvider({ version: 1, baseUrl, keyCiphertext }, provider));
    return withProvider({ baseUrl, apiKey }, provider);
  }

  return { load, save, publicSettings };
}

module.exports = { createCloudTtsSettings, publicSettings };
