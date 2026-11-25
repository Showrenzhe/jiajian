'use strict';

const fs = require('node:fs/promises');
const { existsSync } = require('node:fs');
const { createHash, randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const modelDirectory = require('./vendor-path.cjs')('foreground');
const frameBytes = 320 * 320;
const ffmpeg = process.env.JIAJIAN_FFMPEG || process.env.SUPERDIR_REPLICA_FFMPEG || 'ffmpeg';

async function createForeground(asset, directory, { signal, onProgress = () => {} } = {}) {
  if (!['image', 'video'].includes(asset?.kind) || !path.isAbsolute(asset.path)) throw new Error('请选择本地图片或视频进行抠像。');
  if (!existsSync(path.join(modelDirectory, 'foreground.exe')) || process.platform !== 'win32' || process.arch !== 'x64') throw new Error('离线抠像需要 Windows x64 版佳剪及其 foreground 模型目录。');
  signal?.throwIfAborted();
  const stats = await fs.stat(asset.path);
  const hash = createHash('sha256').update(JSON.stringify(['u2netp-1', asset.path, stats.size, stats.mtimeMs])).digest('hex').slice(0, 24);
  const image = asset.kind === 'image';
  const extension = image ? '.png' : '.webm';
  const stem = path.basename(asset.path, path.extname(asset.path)).slice(0, 60);
  await fs.mkdir(directory, { recursive: true });
  const final = path.join(directory, stem + '-前景-' + hash + extension);
  if (await fs.stat(final).then((s) => s.isFile() && s.size > 0, () => false)) return final;
  const temp = path.join(directory, '.' + randomUUID() + extension);
  const fps = image ? 1 : Math.max(1, Math.min(120, asset.fps || 30));
  const expectedFrames = image ? 1 : Math.ceil(asset.duration * fps);
  const input = image ? ['-protocol_whitelist', 'file,pipe', '-f', 'image2', '-pattern_type', 'none'] :
    ['-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mov,matroska,webm,avi,mpegts,mpeg'];
  const common = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-threads', '2'];
  const decoderArgs = [...common, ...input, '-i', asset.path, '-map', '0:' + asset.videoIndex, '-an',
    '-vf', `fps=${fps},scale=320:320:flags=bilinear,setsar=1`, ...(image ? ['-frames:v', '1'] : []),
    '-threads', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'];
  // A still has only one demuxed frame; fps=1 can drop it with the image2 default clock.
  if (image) decoderArgs[decoderArgs.indexOf('-vf') + 1] = 'scale=320:320:flags=bilinear,setsar=1';
  const source = image ? `[0:${asset.videoIndex}]setpts=PTS-STARTPTS` : `[0:${asset.videoIndex}]fps=${fps},setpts=PTS-STARTPTS`;
  const graph = `${source},format=rgb24[base];[1:v]scale=${asset.width}:${asset.height}:flags=bilinear,format=gray[mask];[base][mask]alphamerge=shortest=1[fg]`;
  const encoderArgs = [...common, '-filter_complex_threads', '2', ...input, '-i', asset.path,
    '-f', 'rawvideo', '-s', '320x320', '-pixel_format', 'gray', '-framerate', String(fps), '-i', 'pipe:0',
    '-filter_complex', graph, '-map', '[fg]', ...(image ? ['-frames:v', '1', '-threads', '1', '-pix_fmt', 'rgba', '-update', '1'] :
      ['-map', '0:a:0?', '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-auto-alt-ref', '0', '-row-mt', '1',
        '-threads', '3', '-deadline', 'realtime', '-cpu-used', '7', '-crf', '26', '-b:v', '0', '-c:a', 'libopus', '-b:a', '128k']), '-n', temp];
  const children = [];
  const promises = [];
  const stop = () => children.forEach((child) => child.kill());
  function start(name, command, args) {
    const child = spawn(command, args, { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    children.push(child);
    let details = '';
    child.stderr.on('data', (chunk) => { details = (details + chunk.toString()).slice(-1000); });
    promises.push(new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => code === 0 ? resolve() : reject(new Error(name + '失败。' + details.trim())));
    }));
    return child;
  }
  signal?.addEventListener('abort', stop, { once: true });
  try {
    const decoder = start('解码原素材', ffmpeg, decoderArgs);
    const inference = start('前景识别', path.join(modelDirectory, 'foreground.exe'), [path.join(modelDirectory, 'u2netp.onnx')]);
    const encoder = start('保存透明素材', ffmpeg, encoderArgs);
    decoder.stdin.end();
    let received = 0, last = -1;
    const report = new Transform({ transform(chunk, _encoding, done) {
      received += chunk.length;
      const percent = Math.min(99, Math.floor(100 * received / frameBytes / expectedFrames));
      if (percent !== last) { last = percent; onProgress(percent / 100); }
      done(null, chunk);
    } });
    promises.push(pipeline(decoder.stdout, inference.stdin), pipeline(inference.stdout, report, encoder.stdin));
    if (signal?.aborted) stop();
    await Promise.all(promises);
    signal?.throwIfAborted();
    if (received < frameBytes || !(await fs.stat(temp)).size) throw new Error('前景模型没有生成有效的画面。');
    await fs.rename(temp, final);
    onProgress(1);
    return final;
  } catch (error) {
    stop();
    await Promise.allSettled(promises);
    signal?.throwIfAborted();
    throw error;
  } finally {
    signal?.removeEventListener('abort', stop);
    await fs.rm(temp, { force: true });
  }
}

module.exports = { createForeground };
