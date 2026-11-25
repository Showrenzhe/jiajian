'use strict';

const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { normalizeSubtitles } = require('./subtitles.cjs');
const { createBreezeBlue, breezeEndpoint } = require('./breezeblue.cjs');

const maxJson = 1024 * 1024;
const maxWave = 64 * 1024 * 1024;
const maxText = 500;
const seedAudioEndpoint = 'https://openspeech.bytedance.com/api/v3/tts/create';
const seedAudioVoiceId = 'seed-audio';
// 官方 TTS 2.0 音色表 https://docs.volcengine.com/docs/doubao-voice/tone-list-3?lang=zh
const seedAudioVoices = new Map([
  [seedAudioVoiceId, '由提示词生成音色'],
  ['zh_female_vv_uranus_bigtts', 'Vivi 2.0'],
  ['zh_female_xiaohe_uranus_bigtts', '小何 2.0'],
  ['zh_male_m191_uranus_bigtts', '云舟 2.0'],
  ['zh_male_taocheng_uranus_bigtts', '小天 2.0'],
  ['zh_male_jieshuoxiaoming_uranus_bigtts', '解说小明 2.0'],
  ['zh_female_qingxinnvsheng_uranus_bigtts', '清新女声 2.0'],
  ['zh_male_ruyaqingnian_uranus_bigtts', '儒雅青年 2.0'],
  ['zh_female_wenroushunv_uranus_bigtts', '温柔淑女 2.0'],
  ['zh_female_zhixingnv_uranus_bigtts', '知性女声 2.0'],
  ['zh_male_cixingjieshuonan_uranus_bigtts', '磁性解说男声 2.0'],
  ['zh_male_shenyeboke_uranus_bigtts', '深夜播客 2.0'],
  ['zh_female_shaoergushi_uranus_bigtts', '少儿故事 2.0'],
]);
const maxSeedText = 3000;
const maxMp3 = 16 * 1024 * 1024;
const maxMp3Base64 = Math.ceil(maxMp3 / 3) * 4;
const maxSeedJson = maxMp3Base64 + maxJson;
const identifier = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/;
const statuses = new Set(['queued', 'running', 'succeeded', 'failed', 'cancelled']);

class ServiceError extends Error {}

function parseBase(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') throw new Error('语音服务地址无效。');
  const text = value.trim();
  if (!text) return null;
  const authority = /^https?:\/\/([^/]+)/i.exec(text)?.[1];
  if (!authority || authority.includes('@') || /[?#\\\x00-\x1f\x7f]/.test(text)) throw new Error('语音服务地址无效。');
  let base;
  try { base = new URL(text); } catch { throw new Error('语音服务地址无效。'); }
  if (base.protocol !== 'https:' && !(require('./cloud-transport-policy.cjs').allowedLocalTest() && base.protocol === 'http:' && /^127\.0\.0\.1(?::\d+)?$/.test(authority))) {
    throw new Error('语音服务须使用 HTTPS。测试仅支持 HTTP 的 127.0.0.1。');
  }
  return base;
}

function normalizeCloudTtsBaseUrl(value) {
  return parseBase(value)?.href ?? '';
}

function validOutput(file) {
  return typeof file === 'string' && path.isAbsolute(file) && !file.includes('\0') && !/^[\\/]{2}/.test(file)
    && (process.platform !== 'win32' || (/^[a-z]:[\\/]/i.test(file) && !file.slice(2).includes(':')));
}

function validId(value) {
  return typeof value === 'string' && identifier.test(value);
}

function responseError(status, message) {
  if (message) return new ServiceError(message);
  if (status === 401 || status === 403) return new ServiceError('语音服务拒绝授权。');
  if (status === 402) return new ServiceError('语音服务余额或额度不足。');
  if (status === 404) return new ServiceError('语音服务未找到所需接口或资源。');
  if (status === 429) return new ServiceError('语音服务请求过于频繁。');
  return new ServiceError('语音服务响应失败。');
}

async function requestBytes(url, apiKey, { method = 'GET', body, signal, timeout, maxBytes, accept, additionalHeaders, previewRedirects = 0, statusMessage }) {
  signal?.throwIfAborted();
  const deadline = AbortSignal.timeout(timeout);
  const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
  const headers = { Accept: accept, 'Accept-Encoding': 'identity', ...additionalHeaders };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  if (payload) {
    headers['Content-Type'] = 'application/json; charset=utf-8';
    headers['Content-Length'] = payload.length;
  }
  const transport = url.protocol === 'https:' ? https : http;
  try {
    return await new Promise((resolve, reject) => {
      const request = transport.request(url, { method, agent: false, headers, signal: requestSignal }, (response) => {
        response.once('error', reject);
        if (previewRedirects > 0 && [301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
          response.resume();
          try {
            const next = new URL(response.headers.location, url);
            if (next.protocol !== 'https:' || next.username || next.password) throw new Error();
            resolve(requestBytes(next, undefined, { signal: requestSignal, timeout, maxBytes, accept, previewRedirects: previewRedirects - 1, statusMessage,
              ...(next.origin === url.origin && { additionalHeaders }) }));
          } catch { reject(new ServiceError('语音样本下载地址无效。')); }
          return;
        }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(responseError(response.statusCode, statusMessage?.(response.statusCode, url)));
          response.destroy();
          return;
        }
        const tooLarge = () => {
          reject(new ServiceError('语音服务响应超过大小限制。'));
          response.destroy();
        };
        if (Number(response.headers['content-length']) > maxBytes) { tooLarge(); return; }
        const chunks = [];
        let length = 0;
        response.on('data', (chunk) => {
          length += chunk.length;
          if (length > maxBytes) tooLarge();
          else chunks.push(chunk);
        });
        response.once('end', () => {
          if (length <= maxBytes) resolve(Buffer.concat(chunks, length));
        });
      });
      request.once('error', reject);
      request.end(payload);
    });
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof ServiceError) throw error;
    if (deadline.aborted) throw new ServiceError('请求语音服务超时。');
    throw new ServiceError('无法连接语音服务。');
  }
}

function parseJson(bytes) {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch {
    throw new ServiceError('语音服务返回的数据格式无效。');
  }
}

function validateWave(data) {
  const invalid = () => new ServiceError('语音服务未返回有效的 WAV 音频。');
  if (data.length < 44 || data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WAVE'
      || data.readUInt32LE(4) + 8 !== data.length) throw invalid();
  let cursor = 12;
  let format = false;
  let samples = false;
  while (cursor + 8 <= data.length) {
    const tag = data.toString('ascii', cursor, cursor + 4);
    const size = data.readUInt32LE(cursor + 4);
    const stop = cursor + 8 + size + (size % 2);
    if (stop > data.length) throw invalid();
    if (tag === 'fmt ' && size >= 16) format = true;
    if (tag === 'data' && size > 0) samples = true;
    cursor = stop;
  }
  if (cursor !== data.length || !format || !samples) throw invalid();
}

async function publishAudio(directory, data, label, extension, signal) {
  signal?.throwIfAborted();
  await fs.mkdir(directory, { recursive: true });
  const output = path.join(directory, `${label}-${randomUUID()}.${extension}`);
  const temporary = `${output}.tmp`;
  const writer = await fs.open(temporary, 'wx', 0o600);
  let published = false;
  try {
    try {
      await writer.writeFile(data);
      await writer.sync();
    } finally {
      await writer.close();
    }
    signal?.throwIfAborted();
    await fs.rename(temporary, output);
    published = true;
    signal?.throwIfAborted();
    return output;
  } catch (error) {
    if (published) await fs.rm(output, { force: true });
    throw error;
  } finally {
    if (!published) await fs.rm(temporary, { force: true });
  }
}

function publishWave(directory, data, label, signal) {
  validateWave(data);
  return publishAudio(directory, data, label, 'wav', signal);
}

function safeCaptions(captions) {
  if (!Array.isArray(captions) || !captions.length) return undefined;
  try { return normalizeSubtitles({ name: '配音字幕.srt', cues: captions }).cues; } catch { return undefined; }
}

const mpeg1Bitrates = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const mpeg2Bitrates = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];

function mp3FrameLength(data, offset) {
  if (offset + 4 > data.length || data[offset] !== 0xff || (data[offset + 1] & 0xe0) !== 0xe0) return 0;
  const version = (data[offset + 1] >> 3) & 3;
  if (version === 1 || ((data[offset + 1] >> 1) & 3) !== 1) return 0;
  const settings = data[offset + 2];
  const bitrate = (version === 3 ? mpeg1Bitrates : mpeg2Bitrates)[settings >> 4];
  const sampleRate = [44100, 48000, 32000][(settings >> 2) & 3] / (version === 3 ? 1 : version === 2 ? 2 : 4);
  if (!bitrate || !sampleRate) return 0;
  return Math.floor((version === 3 ? 144000 : 72000) * bitrate / sampleRate) + ((settings >> 1) & 1);
}

function decodeSeedMp3(encoded) {
  const invalid = () => new ServiceError('Seed Audio 未返回有效的 MP3 音频。');
  if (typeof encoded !== 'string' || encoded.length > maxMp3Base64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw invalid();
  const data = Buffer.from(encoded, 'base64');
  const canonical = data.toString('base64');
  if (data.length > maxMp3 || (encoded !== canonical && encoded !== canonical.replace(/=+$/, ''))) throw invalid();
  let offset = 0;
  if (data.toString('ascii', 0, 3) === 'ID3') {
    if (data.length < 10 || ![2, 3, 4].includes(data[3]) || data.subarray(6, 10).some((value) => value > 127)) throw invalid();
    offset = 10 + data.subarray(6, 10).reduce((size, value) => size * 128 + value, 0);
    if (data[3] === 4 && (data[5] & 0x10)) offset += 10;
  }
  for (let frame = 0; frame < 2; frame += 1) {
    const length = mp3FrameLength(data, offset);
    if (!length || offset + length > data.length) throw invalid();
    offset += length;
  }
  return data;
}

function seedCaptions(subtitle) {
  const sentences = subtitle?.sentences;
  if (!Array.isArray(sentences) || sentences.length > 2000) return undefined;
  return safeCaptions(sentences.map((sentence) => ({ start: sentence?.start_time, end: sentence?.end_time, text: sentence?.text })));
}

function isSeedAudioVoiceId(value) {
  return seedAudioVoices.has(value);
}

function createSeedAudio({ apiKey, outputDirectory, timeout }) {
  async function synthesize({ text, voiceId = seedAudioVoiceId, speed = 1, volume = 100, pitch = 0, enableSubtitles = true, signal, onProgress } = {}) {
    const source = typeof text === 'string' ? text.trim() : '';
    if (!source || source.length > maxSeedText * 2 || [...source].length > maxSeedText || source.includes('\0')) {
      throw new Error(`请输入 1 到 ${maxSeedText} 个字符的配音台词。`);
    }
    if (!isSeedAudioVoiceId(voiceId)) throw new Error('请选择有效的 Seed Audio 音色。');
    if (!Number.isFinite(speed) || speed < 0.5 || speed > 2) throw new Error('配音语速应在 0.5 到 2 之间。');
    if (!Number.isFinite(volume) || volume < 50 || volume > 200) throw new Error('Seed Audio 音量应在 50 到 200 之间。');
    if (!Number.isInteger(pitch) || pitch < -12 || pitch > 12) throw new Error('Seed Audio 音调应为 -12 到 12 的整数。');
    if (typeof enableSubtitles !== 'boolean') throw new Error('字幕选项无效。');
    if (!apiKey) throw new ServiceError('请先设置 Seed Audio 的 API 密钥。');
    if (!outputDirectory) throw new Error('请设置配音输出目录。');
    if (onProgress !== undefined && typeof onProgress !== 'function') throw new Error('配音进度回调无效。');

    signal?.throwIfAborted();
    onProgress?.(0);
    const response = parseJson(await requestBytes(new URL(seedAudioEndpoint), undefined, {
      method: 'POST', signal, timeout, maxBytes: maxSeedJson, accept: 'application/json',
      additionalHeaders: { 'X-Api-Key': apiKey, 'X-Api-Request-Id': randomUUID() },
      body: {
        model: 'seed-audio-1.0', text_prompt: source,
        ...(voiceId !== seedAudioVoiceId && { references: [{ speaker: voiceId }] }),
        audio_config: {
          format: 'mp3', sample_rate: 48000, speech_rate: Math.round((speed - 1) * 100),
          loudness_rate: Math.round(volume - 100), pitch_rate: pitch, enable_subtitle: enableSubtitles,
        },
        watermark: {},
      },
    }));
    if (!response || typeof response !== 'object' || (response.code !== undefined && ![0, 200, 20000000].includes(response.code))) {
      throw new ServiceError('Seed Audio 未完成配音。');
    }
    if (response.audio === undefined && typeof response.url === 'string') {
      throw new ServiceError('Seed Audio 未返回内嵌音频。工作台需要服务返回 Base64 音频。');
    }
    const audio = decodeSeedMp3(response.audio);
    const captions = enableSubtitles ? seedCaptions(response.subtitle) : undefined;
    const file = await publishAudio(outputDirectory, audio, '配音', 'mp3', signal);
    onProgress?.(1);
    return { path: file, ...(captions && { captions }) };
  }

  return {
    status: () => ({ configured: Boolean(apiKey), provider: seedAudioVoiceId }),
    listVoices: async ({ signal } = {}) => {
      signal?.throwIfAborted();
      return { voices: Array.from(seedAudioVoices, ([id, name]) => ({ id, name, hasSample: true })) };
    },
    sample: async (voiceId, { signal } = {}) => {
      if (!isSeedAudioVoiceId(voiceId)) throw new Error('请选择有效的音色。');
      return synthesize({
        text: voiceId === seedAudioVoiceId ? '自然中文旁白，语气清晰，作为音色试听。' : '你好，这是一段音色试听。',
        voiceId, enableSubtitles: false, signal,
      });
    },
    synthesize,
  };
}

function createCloudTts({
  provider = 'gateway', baseUrl, apiKey, outputDirectory,
  pollIntervalMs = 700, requestTimeoutMs = provider === 'gateway' ? 15000 : 300000,
  audioTimeoutMs = 60000, jobTimeoutMs = 300000, cancelTimeoutMs = 2500,
} = {}) {
  if (!['gateway', seedAudioVoiceId, 'breezeblue'].includes(provider)) throw new Error('语音服务类型无效。');
  const base = parseBase(baseUrl);
  if (apiKey != null && apiKey !== '' && (typeof apiKey !== 'string' || apiKey.length > 4096 || /[^\x21-\x7e]/.test(apiKey))) {
    throw new Error('语音服务 API 密钥格式无效。');
  }
  if (outputDirectory !== undefined && !validOutput(outputDirectory)) throw new Error('配音输出须使用本机目录。');
  if (![pollIntervalMs, requestTimeoutMs, audioTimeoutMs, jobTimeoutMs, cancelTimeoutMs]
    .every((value) => Number.isInteger(value) && value > 0 && value <= 3600000)) throw new Error('语音服务时限设置无效。');
  if (provider === seedAudioVoiceId) {
    if (base && base.href !== seedAudioEndpoint) throw new Error('Seed Audio 使用官方固定接口地址。');
    return createSeedAudio({ apiKey, outputDirectory, timeout: Math.min(requestTimeoutMs, jobTimeoutMs, 300000) });
  }
  if (provider === 'breezeblue') {
    if (base && base.href !== breezeEndpoint) throw new Error('Breeze Blue 使用固定的服务地址。');
    return createBreezeBlue({ apiKey, outputDirectory, timeout: Math.min(requestTimeoutMs, jobTimeoutMs),
      requestBytes, publishAudio, publishWave, parseJson, safeCaptions });
  }

  function endpoint(route) {
    if (!base) throw new ServiceError('语音服务尚未配置。');
    const url = new URL(base);
    url.pathname = `${base.pathname.replace(/\/+$/, '')}${route}`;
    return url;
  }

  async function getJson(route, options = {}) {
    const bytes = await requestBytes(endpoint(route), apiKey, {
      timeout: requestTimeoutMs, maxBytes: maxJson, accept: 'application/json', ...options,
    });
    return parseJson(bytes);
  }

  function getWave(route, signal) {
    return requestBytes(endpoint(route), apiKey, { signal, timeout: audioTimeoutMs, maxBytes: maxWave, accept: 'audio/wav' });
  }

  function status() { return { configured: Boolean(base) }; }

  async function listVoices({ signal } = {}) {
    const data = await getJson('/v1/voices', { signal });
    if (!Array.isArray(data?.voices) || data.voices.length > 512) throw new ServiceError('语音服务返回的音色列表无效。');
    const ids = new Set();
    const voices = data.voices.map((voice) => {
      const name = typeof voice?.name === 'string' ? voice.name.toWellFormed().replace(/[\x00-\x1f\x7f-\x9f]/g, '').trim() : '';
      if (!validId(voice?.id) || !name || name.length > 120 || ids.has(voice.id)) throw new ServiceError('语音服务返回的音色列表无效。');
      ids.add(voice.id);
      return { id: voice.id, name, ...(typeof voice.hasSample === 'boolean' && { hasSample: voice.hasSample }) };
    });
    return { voices };
  }

  async function sample(voiceId, { signal } = {}) {
    if (!validId(voiceId)) throw new Error('请选择有效的音色。');
    if (!outputDirectory) throw new Error('请设置配音输出目录。');
    const bytes = await getWave(`/v1/voices/${voiceId}/sample`, signal);
    return { path: await publishWave(outputDirectory, bytes, '试听', signal) };
  }

  async function cancelJob(id) {
    try {
      await requestBytes(endpoint(`/v1/speech/jobs/${id}/cancel`), apiKey, {
        method: 'POST', timeout: cancelTimeoutMs, maxBytes: maxJson, accept: 'application/json',
      });
    } catch { /* Cancellation is best-effort. */ }
  }

  async function synthesize({ text, voiceId, speed = 1, volume = 100, signal, onProgress } = {}) {
    const source = typeof text === 'string' ? text.trim() : '';
    if (!source || source.length > maxText * 2 || [...source].length > maxText || source.includes('\0')) {
      throw new Error(`请输入 1 到 ${maxText} 个字符的配音台词。`);
    }
    if (!validId(voiceId)) throw new Error('请选择有效的音色。');
    if (!Number.isFinite(speed) || speed < 0.5 || speed > 2) throw new Error('配音语速应在 0.5 到 2 之间。');
    if (!Number.isFinite(volume) || volume < 0 || volume > 100) throw new Error('配音音量应在 0 到 100 之间。');
    if (!outputDirectory) throw new Error('请设置配音输出目录。');
    if (onProgress !== undefined && typeof onProgress !== 'function') throw new Error('配音进度回调无效。');

    const deadline = AbortSignal.timeout(jobTimeoutMs);
    const jobSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    let id;
    let terminal = false;
    let progress = 0;
    try {
      let job = await getJson('/v1/speech/jobs', {
        method: 'POST', body: { text: source, voiceId, speed, volume, format: 'wav' }, signal: jobSignal,
      });
      if (!validId(job?.id)) throw new ServiceError('语音服务未返回有效的任务编号。');
      id = job.id;
      const route = `/v1/speech/jobs/${id}`;
      let state = job.status ?? 'queued';
      for (;;) {
        jobSignal.throwIfAborted();
        if (!statuses.has(state)) throw new ServiceError('语音服务返回的任务状态无效。');
        if (state === 'succeeded') {
          terminal = true;
          const captions = safeCaptions(job.captions);
          const audio = await getWave(`${route}/audio`, jobSignal);
          const file = await publishWave(outputDirectory, audio, '配音', jobSignal);
          onProgress?.(1);
          return { path: file, ...(captions && { captions }) };
        }
        if (state === 'failed' || state === 'cancelled') {
          terminal = true;
          throw new ServiceError(state === 'failed' ? '语音服务未完成配音。' : '语音服务已取消配音。');
        }
        if (Number.isFinite(job.progress) && job.progress >= progress && job.progress <= 1) {
          progress = Math.min(0.99, job.progress);
          onProgress?.(progress);
        }
        await delay(pollIntervalMs, undefined, { signal: jobSignal });
        job = await getJson(route, { signal: jobSignal });
        state = job?.status;
      }
    } catch (error) {
      if (id && !terminal) await cancelJob(id);
      signal?.throwIfAborted();
      if (deadline.aborted) throw new ServiceError('等待语音合成超时。');
      throw error;
    }
  }

  return { status, listVoices, sample, synthesize };
}

module.exports = { createCloudTts, isSeedAudioVoiceId, normalizeCloudTtsBaseUrl, seedAudioEndpoint, seedAudioVoiceId };
