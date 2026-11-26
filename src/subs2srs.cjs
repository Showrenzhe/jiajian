'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { inspectAsset, audioExtensions } = require('./media.cjs');
const { readSubtitles } = require('./subtitles.cjs');
const { mediaTool } = require('./media-tool.cjs');

function localFile(file, extensions) {
  return typeof file === 'string' && path.isAbsolute(file) && !file.includes('\0') && !/^[\\/]{2}/.test(file)
    && extensions.includes(path.extname(file).slice(1).toLowerCase())
    && (process.platform !== 'win32' || (/^[a-z]:[\\/]/i.test(file) && !file.slice(2).includes(':')));
}

function runFfmpeg(args, { signal, timeout = 120000 } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(mediaTool('ffmpeg'), args, { shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let errors = '';
    let failure;
    const stop = () => child.kill();
    const timer = setTimeout(() => {
      failure = new Error('音频分割超时。');
      stop();
    }, timeout);
    signal?.addEventListener('abort', stop, { once: true });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (part) => { errors = (errors + part).slice(-3000); });
    child.once('error', (error) => {
      failure = error.code === 'ENOENT' ? new Error('找不到 FFmpeg，请检查离线包是否完整。') : error;
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      if (signal?.aborted) return reject(signal.reason);
      if (failure) return reject(failure);
      if (code !== 0) return reject(new Error(errors.trim() || `FFmpeg 退出（${code}）。`));
      resolve();
    });
  });
}

async function splitNarration({ subtitlePath, audioPath, outputDirectory, signal, onProgress } = {}) {
  if (!localFile(subtitlePath, ['srt'])) throw new Error('请选择本地的 SRT 字幕文件。');
  if (!localFile(audioPath, audioExtensions)) throw new Error('请选择受支持的 MP3 或音频文件。');
  if (typeof outputDirectory !== 'string' || !path.isAbsolute(outputDirectory) || outputDirectory.includes('\0')) {
    throw new Error('口播输出目录无效。');
  }
  const track = await readSubtitles(subtitlePath);
  const audio = await inspectAsset(audioPath, 'audio', { signal });
  const output = path.join(outputDirectory, `subs2srs-${randomUUID()}`);
  await fs.mkdir(output, { recursive: true });
  const segments = [];
  try {
    for (const [index, cue] of track.cues.entries()) {
      signal?.throwIfAborted();
      const start = cue.start / 1000;
      const end = Math.min(cue.end / 1000, audio.duration);
      const duration = end - start;
      if (start >= audio.duration || duration < 0.1) continue;
      const file = path.join(output, `${String(index + 1).padStart(4, '0')}.mp3`);
      await runFfmpeg([
        '-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
        '-ss', String(start), '-i', audioPath, '-t', String(duration),
        '-map', '0:a:0', '-vn', '-sn', '-dn', '-map_metadata', '-1',
        '-c:a', 'libmp3lame', '-ar', '48000', '-ac', '2', '-b:a', '192k', file,
      ], { signal });
      segments.push({ path: file, text: cue.text, start: cue.start, end: Math.round(end * 1000), index });
      onProgress?.((index + 1) / track.cues.length);
    }
    if (!segments.length) throw new Error('SRT 时间码没有落在 MP3 的有效时长内。');
    return { name: track.name, audioName: audio.name, segments };
  } catch (error) {
    await fs.rm(output, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

module.exports = { splitNarration };
