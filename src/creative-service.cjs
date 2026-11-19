'use strict';

const fs = require('node:fs/promises');
const { openAsBlob } = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { inspectAsset } = require('./media.cjs');
const { createCloudTtsSettings } = require('./cloud-tts-settings.cjs');

const formats = { 'image/png': ['image', '.png'], 'image/jpeg': ['image', '.jpg'], 'image/webp': ['image', '.webp'],
  'video/mp4': ['video', '.mp4'], 'video/webm': ['video', '.webm'], 'video/quicktime': ['video', '.mov'] };

function createCreativeSettings(directory, safeStorage) {
  // Use the existing encrypted, origin-bound credential store in a separate directory.
  const store = createCloudTtsSettings({ directory: path.join(directory, 'creative-service'), safeStorage });
  const read = async () => {
    const value = await store.load();
    return value.provider ? { baseUrl: '', apiKey: '' } : value;
  };
  const summary = (value) => ({ baseUrl: value.baseUrl, hasApiKey: Boolean(value.apiKey) });
  let queue = Promise.resolve();
  return { read, async public() { await queue; return summary(await read()); }, save(update) {
    const run = queue.then(async () => summary(await store.save(await read(), { ...update, provider: 'gateway' })));
    queue = run.catch(() => {});
    return run.catch((error) => { throw new Error(error.message.replaceAll('语音服务', '创作服务')); });
  } };
}

function cleanText(value, max) {
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw new Error('创作服务文本过长或格式无效。');
  return value.trim();
}

async function receive(response, max, write) {
  if (!response.ok) throw new Error(`创作服务返回 HTTP ${response.status}，请检查服务地址、密钥和任务参数。`);
  if (Number(response.headers.get('content-length')) > max) throw new Error('创作服务返回的内容超过大小上限。');
  let total = 0;
  for await (const chunk of response.body ?? []) {
    total += chunk.length;
    if (total > max) throw new Error('创作服务返回的内容超过大小上限。');
    await write(chunk);
  }
  if (!total) throw new Error('创作服务返回了空结果。');
}

async function saveMedia(response, expected, output, signal) {
  if (!response.ok) throw new Error(`创作服务返回 HTTP ${response.status}。`);
  const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  const format = formats[mime];
  if (format?.[0] !== expected) throw new Error('创作服务返回的媒体格式与任务不匹配。');
  await fs.mkdir(output, { recursive: true });
  const file = path.join(output, randomUUID() + format[1]);
  const handle = await fs.open(file, 'wx');
  try {
    try { await receive(response, expected === 'image' ? 32 * 1024 * 1024 : 512 * 1024 * 1024, (bytes) => handle.writeFile(bytes)); }
    finally { await handle.close(); }
    return await inspectAsset(file, expected, { signal });
  } catch (error) { await fs.rm(file, { force: true }); throw error; }
}

async function runCreative({ baseUrl, apiKey }, request, catalog, directory, { signal } = {}) {
  if (!baseUrl) throw new Error('请先在设置中填写创作服务地址。');
  const action = request?.action;
  if (!['avatar', 'cover', 'replicate'].includes(action)) throw new Error('创作任务类型无效。');
  const base = new URL(baseUrl.endsWith('/') ? baseUrl : baseUrl + '/');
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && base.hostname === '127.0.0.1')) throw new Error('创作服务地址无效。');
  const headers = apiKey ? { Authorization: 'Bearer ' + apiKey } : {};
  const form = new FormData();
  form.set('prompt', cleanText(request.prompt ?? '', 4096));
  const ratio = request.ratio ?? '9:16';
  if (!['16:9', '9:16', '1:1'].includes(ratio)) throw new Error('画幅无效。');
  form.set('ratio', ratio);
  async function attach(field, id, kinds) {
    const asset = catalog.get(id);
    if (!asset || !kinds.includes(asset.kind)) throw new Error('请选择任务需要的本地素材。');
    const file = await openAsBlob(asset.path);
    if (file.size > 512 * 1024 * 1024) throw new Error('单个上传素材须小于 512 MiB。');
    form.set(field, file, path.basename(asset.path));
    return asset;
  }
  let reference;
  if (action === 'avatar') {
    await attach('portrait', request.imageId, ['video','image']); await attach('voice', request.voiceId, ['audio']);
  } else if (action === 'cover') {
    if (request.imageId) await attach('reference', request.imageId, ['video','image']);
    if (!form.get('prompt') && !request.imageId) throw new Error('请输入封面描述或选择参考素材。');
  } else if (request.videoId) reference = await attach('reference', request.videoId, ['video']);
  else {
    let url; try { url = new URL(cleanText(request.referenceUrl, 4096)); } catch { throw new Error('请选择参考视频或填写有效链接。'); }
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('参考链接须使用 HTTPS。');
    form.set('reference_url', url.href);
  }
  const timeout = AbortSignal.timeout(10 * 60 * 1000);
  const taskSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const response = await fetch(new URL(action, base), { method: 'POST', headers, body: form, redirect: 'error', signal: taskSignal });
  if (action !== 'replicate') return { asset: await saveMedia(response, action === 'cover' ? 'image' : 'video', directory, taskSignal) };
  const chunks = [];
  await receive(response, 1024 * 1024, (part) => chunks.push(part));
  let data; try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('参考分析结果须为有效的 JSON。'); }
  if (!Array.isArray(data?.shots) || !data.shots.length || data.shots.length > 1000) throw new Error('参考分析应返回 1–1000 个分镜。');
  let downloaded;
  try {
    if (!reference) {
      const url = new URL(cleanText(data.source_url, 4096), base);
      if (url.origin !== base.origin || url.username || url.password) throw new Error('平台链接解析须返回同一创作服务下的视频地址。');
      downloaded = await saveMedia(await fetch(url, { headers, signal: taskSignal, redirect: 'error' }), 'video', directory, taskSignal);
      reference = downloaded;
    }
    const title = cleanText(data.title ?? '参考视频拆解', 100);
    const shots = Array.from(data.shots, (shot, index) => {
      if (!Number.isFinite(shot?.start) || !Number.isFinite(shot.end) || shot.start < 0 || shot.end > reference.duration + .001 || shot.end - shot.start < .1 - 1e-8) {
        throw new Error(`参考分析第 ${index + 1} 镜的起止时间超出视频范围。`);
      }
      return { start: shot.start, end: Math.min(reference.duration, shot.end), name: cleanText(shot.name ?? '', 120),
        description: cleanText(shot.description ?? '', 2000), dialogue: cleanText(shot.dialogue ?? '', 4096) };
    });
    return { title, shots, ...(downloaded ? { asset: downloaded } : { sourceId: request.videoId }) };
  } catch (error) {
    if (downloaded) await fs.rm(downloaded.path, { force: true });
    throw error;
  }
}

module.exports = { createCreativeSettings, runCreative };
