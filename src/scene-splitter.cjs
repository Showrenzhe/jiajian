'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const videoExtensions = new Set(['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v', 'ts', 'mpeg', 'mpg', 'mts', 'm2ts']);
const detectors = new Set(['content', 'adaptive', 'threshold']);
const maxBatch = 50;
const maxSceneSeconds = 3600;
const minSceneSeconds = 0.1;

function executablePath() {
  const candidates = [
    process.env.SUPERDIR_REPLICA_SCENEDETECT,
    require('./vendor-path.cjs')('scenedetect', 'scenedetect.exe'),
  ].filter(Boolean);
  return candidates.find((file) => path.isAbsolute(file) && require('node:fs').existsSync(file)) ?? 'scenedetect.exe';
}

function mediaEnvironment() {
  const env = { ...process.env };
  const ffmpeg = env.SUPERDIR_REPLICA_FFMPEG;
  if (ffmpeg && path.isAbsolute(ffmpeg)) {
    env.PATH = [path.dirname(ffmpeg), env.PATH].filter(Boolean).join(path.delimiter);
  }
  return env;
}

function validateVideo(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || !videoExtensions.has(path.extname(file).slice(1).toLowerCase())) {
    throw new Error('请选择受支持的视频文件。');
  }
  return file;
}

async function ensureOutputDirectory(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new Error('请选择有效的保存目录。');
  await fs.mkdir(directory, { recursive: true });
  const info = await fs.stat(directory);
  if (!info.isDirectory()) throw new Error('保存位置不是文件夹。');
}

function detectorArguments(detector, threshold) {
  if (detector === 'adaptive') return ['detect-adaptive', '--threshold', String(threshold)];
  if (detector === 'threshold') return ['detect-threshold', '--threshold', String(threshold)];
  return ['detect-content', '--threshold', String(threshold)];
}

function parseScenes(csv) {
  const lines = csv.split(/\r?\n/).filter(Boolean);
  const headerIndex = lines.findIndex((line) => line.startsWith('Scene Number,'));
  if (headerIndex < 0) throw new Error('场景检测没有返回有效的分镜列表。');
  const headers = lines[headerIndex].split(',');
  const index = new Map(headers.map((name, position) => [name, position]));
  return lines.slice(headerIndex + 1).map((line) => {
    const fields = line.split(',');
    const start = Number(fields[index.get('Start Time (seconds)')]);
    const end = Number(fields[index.get('End Time (seconds)')]);
    const duration = Number(fields[index.get('Length (seconds)')]);
    const startFrame = Number(fields[index.get('Start Frame')]);
    const endFrame = Number(fields[index.get('End Frame')]);
    if (![start, end, duration, startFrame, endFrame].every(Number.isFinite) || end <= start) return null;
    return { start, end, duration, startFrame, endFrame };
  }).filter(Boolean);
}

function spawnDetector(args, { signal, onProgress } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(executablePath(), args, {
      cwd: path.dirname(executablePath()),
      env: mediaEnvironment(),
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let errorOutput = '';
    let failure;
    const stop = () => child.kill();
    signal?.addEventListener('abort', stop, { once: true });
    const consume = (chunk) => {
      const text = String(chunk);
      output = (output + text).slice(-1024 * 1024);
      const progressMatches = [...text.matchAll(/Progress:\s*([0-9]+)%/g)];
      for (const match of progressMatches) {
        const value = Number(match[1]) / 100;
        onProgress?.(/split|ffmpeg|scene .*written/i.test(text) ? 0.6 + value * 0.35 : value * 0.55);
      }
      if (/Splitting video|splitting remaining scenes/i.test(text)) onProgress?.(0.6);
      if (/Detected .* scenes|Video splitting completed/i.test(text)) onProgress?.(0.98);
    };
    child.stdout.on('data', consume);
    child.stderr.on('data', (chunk) => {
      errorOutput = (errorOutput + String(chunk)).slice(-1024 * 1024);
      consume(chunk);
    });
    child.once('error', (error) => {
      failure = error.code === 'ENOENT' ? new Error('找不到场景分割引擎，请检查安装包是否完整。') : error;
    });
    child.once('close', (code) => {
      signal?.removeEventListener('abort', stop);
      if (signal?.aborted) return reject(signal.reason);
      if (failure) return reject(failure);
      if (code !== 0) return reject(new Error(errorOutput.trim() || `场景分割引擎退出（${code}）。`));
      resolve(output);
    });
  });
}

async function splitOne(input, options, { signal, onProgress } = {}) {
  validateVideo(input);
  const output = options.outputDirectory;
  const args = [
    '-i', input,
    '-o', output,
    '-m', `${options.minSceneSeconds}s`,
    ...detectorArguments(options.detector, options.threshold),
    'list-scenes',
    'split-video',
    '--output', output,
    '--filename', '$VIDEO_NAME-Scene-$SCENE_NUMBER',
  ];
  const text = await spawnDetector(args, { signal, onProgress });
  const csv = path.join(output, `${path.parse(input).name}-Scenes.csv`);
  const csvText = await fs.readFile(csv, 'utf8');
  const scenes = parseScenes(csvText);
  const files = scenes.map((_scene, index) => path.join(output, `${path.parse(input).name}-Scene-${String(index + 1).padStart(3, '0')}.mp4`));
  const existing = await Promise.all(files.map(async (file) => (await fs.stat(file).catch(() => null))?.isFile() ? file : null));
  if (!scenes.length || existing.some((file) => !file)) throw new Error('场景检测完成，但输出片段不完整。');
  onProgress?.(1);
  return { input, outputDirectory: output, csv, scenes, files: existing };
}

async function detectSceneCuts(input, { detector = 'content', threshold = 27, minSceneSeconds: minimum = 0.5 } = {}, { signal } = {}) {
  validateVideo(input);
  if (!detectors.has(detector) || !Number.isFinite(threshold) || threshold < 0 || threshold > 255
      || !Number.isFinite(minimum) || minimum < minSceneSeconds || minimum > maxSceneSeconds) throw new Error('场景识别参数无效。');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jiajian-scene-cuts-'));
  const csv = path.join(directory, 'cuts.csv');
  try {
    await spawnDetector(['-i', input, '-o', directory, '-m', `${minimum}s`, ...detectorArguments(detector, threshold),
      'list-scenes', '--filename', 'cuts.csv'], { signal });
    return parseScenes(await fs.readFile(csv, 'utf8')).slice(1).map((scene) => scene.start);
  } finally {
    await fs.rm(csv, { force: true });
    await fs.rmdir(directory);
  }
}

async function splitVideos(inputs, options, { signal, onProgress } = {}) {
  if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > maxBatch) throw new Error(`一次最多处理 ${maxBatch} 个视频。`);
  const detector = detectors.has(options?.detector) ? options.detector : 'content';
  const threshold = Number(options?.threshold);
  const minScene = Number(options?.minSceneSeconds);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 255) throw new Error('灵敏度阈值应在 0 到 255 之间。');
  if (!Number.isFinite(minScene) || minScene < minSceneSeconds || minScene > maxSceneSeconds) throw new Error(`最短场景时长应在 ${minSceneSeconds} 到 ${maxSceneSeconds} 秒之间。`);
  const outputDirectory = options?.outputDirectory;
  await ensureOutputDirectory(outputDirectory);
  const results = [];
  for (const [index, input] of inputs.entries()) {
    signal?.throwIfAborted();
    const result = await splitOne(input, { detector, threshold, minSceneSeconds: minScene, outputDirectory }, {
      signal,
      onProgress: (fraction) => onProgress?.({ index, count: inputs.length, fraction }),
    });
    results.push(result);
  }
  return results;
}

module.exports = { splitVideos, detectSceneCuts, parseScenes, validateVideo, videoExtensions, detectors };

