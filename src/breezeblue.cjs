'use strict';

const breezeEndpoint = 'https://api.breeze.blue/';
const apiOrigin = new URL(breezeEndpoint).origin;
const model = 'breeze-tts-2-multilingual';
const maxAudio = 64 * 1024 * 1024;
const maxText = 1000;
const validId = (id) => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/.test(id);
const clean = (value, max = 100) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, max) : '';

function validateBreezeApiKey(key) {
  if (typeof key === 'string' && key.startsWith('key_')) {
    throw new Error('你填的是 Breeze Blue 密钥管理编号。请到 Breeze 控制台的 API Keys 页面，填写创建时复制的完整 API Key（brz_ 开头）。如果已关闭创建窗口，请创建新密钥并立即复制。');
  }
}

function breezeStatusMessage(status, url) {
  if (url.origin !== apiOrigin) {
    if (status === 401 || status === 403) return `音色试听链接暂时无法访问（HTTP ${status}）。请重新加载音色列表后再试听。`;
    return;
  }
  if (status === 401) return 'Breeze Blue 身份验证失败（HTTP 401）。请在云端配音设置中重新填写创建时复制的完整 API Key。';
  if (status === 403) return 'Breeze Blue 拒绝本次操作，请检查密钥权限及账号状态（HTTP 403）。';
  if (status === 402) return 'Breeze Blue 余额或额度不足（HTTP 402）。请检查账户余额和用量。';
}

// The returned word offsets refer to the delivered, speed-adjusted audio in seconds.
function captionLines(words, source) {
  if (!Array.isArray(words)) return [];
  const tokens = words.filter((word) => typeof word?.word === 'string' && word.word.trim() && Number.isFinite(word.start)
    && Number.isFinite(word.end) && word.start >= 0 && word.end >= word.start);
  let position = 0;
  const cues = [];
  let cue;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i], word = token.word.trim();
    const index = source.indexOf(word, position);
    const end = Math.round(token.end * 1000);
    let text = word;
    if (index >= position) {
      text = source.slice(position, index + word.length);
      position = index + word.length;
      const punctuation = /^[\s，。！？；、,.!?;:“”’"）)]*/u.exec(source.slice(position))[0];
      text += punctuation;
      position += punctuation.length;
    } else if (cue && /[a-z0-9]$/i.test(cue.text) && /^[a-z0-9]/i.test(word)) text = ' ' + word;
    const start = Math.round(token.start * 1000);
    if (!cue || start - cue.end > 500 || end - cue.start > 4500 || cue.text.trim().length >= 28) {
      cue = { start, end: start + 1, text: '' };
      cues.push(cue);
    }
    cue.text += text;
    cue.end = Math.max(cue.end, end);
    if (/[。！？.!?][”’"）)]*\s*$/u.test(cue.text)) cue = undefined;
  }
  return cues;
}

function sampleExtension(bytes) {
  const tag = bytes.toString('ascii', 0, 4);
  if (tag === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE') return 'wav';
  if (tag === 'OggS') return 'ogg';
  if (tag === 'fLaC') return 'flac';
  if (bytes.toString('ascii', 4, 8) === 'ftyp') return 'm4a';
  if (tag.startsWith('ID3') || (bytes[0] === 255 && (bytes[1] & 224) === 224)) return 'mp3';
  throw new Error('Breeze Blue 返回的试听文件格式无效。');
}

function createBreezeBlue({ apiKey, outputDirectory, timeout, requestBytes, publishAudio, publishWave, parseJson, safeCaptions }) {
  const directory = new Map();
  function requireKey() {
    if (!apiKey) throw new Error('请在设置中填写 Breeze Blue API Key。');
    validateBreezeApiKey(apiKey);
  }
  const status = () => ({ provider: 'breezeblue', configured: Boolean(apiKey) });
  const request = (url, options) => requestBytes(url, undefined, { timeout, additionalHeaders: { 'xi-api-key': apiKey }, statusMessage: breezeStatusMessage, ...options });

  async function requestVoicePage(url, limit, signal) {
    const result = parseJson(await request(url, { accept: 'application/json', maxBytes: 4 * 1024 * 1024, signal }));
    if (!Array.isArray(result?.voices) || result.voices.length > limit || typeof result.has_more !== 'boolean') throw new Error('Breeze Blue 音色目录格式无效。');
    return result;
  }

  async function verifyAccess({signal} = {}) {
    requireKey();
    await requestVoicePage(new URL('/v1/voices?page_size=1', breezeEndpoint), 1, signal);
    return true;
  }

  async function listVoices({ page = 1, token = '', search = '', filter = 'all', signal } = {}) {
    requireKey();
    if (!Number.isSafeInteger(page) || page < 1 || typeof token !== 'string' || token.length > 8192
      || typeof search !== 'string' || search.length > 256 || !['all', 'zh', 'female', 'male', 'favorites'].includes(filter)) {
      throw new Error('音色筛选参数无效。');
    }
    const url = new URL('/v1/voices', breezeEndpoint);
    url.searchParams.set('page_size', '100');
    if (search.trim()) url.searchParams.set('search', search.trim());
    if (filter === 'zh') url.searchParams.set('language_code', 'zh');
    if (filter === 'male' || filter === 'female') url.searchParams.set('gender', filter);
    if (filter === 'favorites') url.searchParams.set('favorites_only', 'true');
    if (token) url.searchParams.set('next_page_token', token);
    else if (page > 1) url.searchParams.set('page', String(page));
    const result = await requestVoicePage(url, 100, signal);
    const voices = [];
    for (const item of result.voices) {
      if (!validId(item?.voice_id) || !clean(item.name)) continue;
      let preview;
      if (typeof item.preview_url === 'string' && item.preview_url.trim()) {
        try {
          const link = new URL(item.preview_url, breezeEndpoint);
          if (link.protocol === 'https:' && !link.username && !link.password) preview = link;
        } catch { /* A voice without a sample can still synthesize a preview. */ }
      }
      directory.set(item.voice_id, { preview, language: clean(item.language_code) });
      voices.push({ id: item.voice_id, name: clean(item.name, 200), hasSample: true, generatedSample: !preview,
        language: clean(item.language_code), gender: clean(item.gender), tone: (Array.isArray(item.tone) ? item.tone : []).slice(0, 3).map((t) => clean(t)),
        description: clean(item.description, 250) });
    }
    return { voices, total: Number.isSafeInteger(result.total) ? result.total : undefined,
      next: result.has_more ? { page: page + 1, token: typeof result.next_page_token === 'string' ? result.next_page_token : '' } : null };
  }

  async function synthesize({ text, voiceId, speed = 1, volume = 100, enableSubtitles = true, signal, onProgress } = {}) {
    requireKey();
    const source = typeof text === 'string' ? text.trim() : '';
    if (!validId(voiceId) || !source || source.includes('\0') || [...source].length > maxText) throw new Error('请选择音色并输入 1 至 1000 字台词。');
    if (!Number.isFinite(speed) || speed < 0.5 || speed > 2 || !Number.isFinite(volume) || volume < 1 || volume > 200
      || typeof enableSubtitles !== 'boolean') throw new Error('Breeze Blue 语速范围为 0.5–2 倍，音量范围为 1%–200%。');
    if (!outputDirectory) throw new Error('请设置配音输出目录。');
    const route = '/v1/text-to-speech/' + encodeURIComponent(voiceId) + (enableSubtitles ? '/with-timestamps' : '');
    const url = new URL(route, breezeEndpoint);
    url.searchParams.set('output_format', 'wav');
    onProgress?.(0);
    let bytes = await request(url, { method: 'POST', signal, accept: enableSubtitles ? 'application/json' : 'audio/wav',
      maxBytes: enableSubtitles ? Math.ceil(maxAudio / 3) * 4 + 2 * 1024 * 1024 : maxAudio,
      body: { text: source, model_id: model, voice_settings: { speed, volume: volume / 100 } } });
    let captions;
    if (enableSubtitles) {
      const result = parseJson(bytes);
      if (typeof result?.audio_base64 !== 'string' || result.audio_base64.length > Math.ceil(maxAudio / 3) * 4) throw new Error('Breeze Blue 未返回 WAV 音频。');
      bytes = Buffer.from(result.audio_base64, 'base64');
      captions = safeCaptions(captionLines(result.word_timestamps, source));
    }
    const file = await publishWave(outputDirectory, bytes, '配音', signal);
    onProgress?.(1);
    return { path: file, ...(captions && { captions }) };
  }

  async function sample(voiceId, { signal } = {}) {
    requireKey();
    const record = directory.get(voiceId);
    if (!record || !outputDirectory) throw new Error('请从音色目录中选择要试听的声音。');
    if (!record.preview) {
      return synthesize({ voiceId, text: record.language === 'en' ? 'Hello, this is a sample of my voice.' : '你好，这是一段音色试听。', enableSubtitles: false, signal });
    }
    const bytes = await requestBytes(record.preview, undefined, { accept: 'audio/*', signal, timeout, maxBytes: maxAudio, previewRedirects: 4,
      statusMessage: breezeStatusMessage, ...(record.preview.origin === apiOrigin && { additionalHeaders: { 'xi-api-key': apiKey } }) });
    return { path: await publishAudio(outputDirectory, bytes, '试听', sampleExtension(bytes), signal) };
  }
  return { status, listVoices, verifyAccess, sample, synthesize };
}

module.exports = { createBreezeBlue, breezeEndpoint, maxText, validateBreezeApiKey };
