'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { inspectAsset, recognizeLocalSpeech, runTool } = require('./media.cjs');
const { detectPauses, processAudio, retimeCaptions } = require('./audio-tools.cjs');

const characters = (text) => Array.from(text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''));

// Match in reading order. Repeated lines must consume different positions in the recording.
function matchedPositions(source, heard) {
  if (source.join('') === heard.join('')) return source.map((_, i) => i);
  if (!heard.length || heard.length > source.length * 1.4 + 4 || heard.length < source.length * 0.7
    || source.length * heard.length > 16000000) return [];
  const width = heard.length + 1;
  const scores = new Uint16Array((source.length + 1) * width);
  for (let i = 1; i <= source.length; i++) {
    for (let j = 1; j <= heard.length; j++) {
      const k = i * width + j;
      scores[k] = source[i - 1] === heard[j - 1] ? scores[k - width - 1] + 1 : Math.max(scores[k - 1], scores[k - width]);
    }
  }
  const positions = Array(source.length).fill(-1);
  let i = source.length, j = heard.length;
  while (i && j) {
    const k = i * width + j;
    if (source[i - 1] === heard[j - 1]) positions[--i] = --j;
    else if (scores[k - width] >= scores[k - 1]) i--;
    else j--;
  }
  return positions;
}

function alignScript(lines, cues, duration, pauses = []) {
  if (!Array.isArray(cues) || !cues.length || cues.length > 10000) return;
  const groups = lines.map(characters);
  if (groups.some(group => !group.length)) return;
  const heard = [], tokens = [], tokenAt = [];
  for (const cue of cues) {
    if (typeof cue?.text !== 'string') return;
    const letters = characters(cue.text);
    if (!letters.length) continue;
    if (!Number.isInteger(cue.start) || !Number.isInteger(cue.end)
        || cue.start < 0 || cue.end <= cue.start || cue.end > duration + 50 || cue.start < (tokens.at(-1)?.end ?? 0) - 20) return;
    const offset = heard.length;
    for (const letter of letters) { heard.push(letter); tokenAt.push(tokens.length); }
    tokens.push({ start: cue.start, end: Math.min(duration, cue.end), offset, length: letters.length });
  }
  const positions = matchedPositions(groups.flat(), heard);
  let offset = 0;
  const spans = [];
  for (const group of groups) {
    const matches = positions.slice(offset, offset + group.length);
    offset += group.length;
    const hits = matches.filter(pos => pos >= 0);
    if (hits.length < Math.ceil(group.length * 0.75) || hits.at(-1) - hits[0] + 1 > hits.length * 1.4
      || matches.indexOf(hits[0]) > 1 || matches.lastIndexOf(hits.at(-1)) < group.length - 2) return;
    spans.push({ first: tokenAt[hits[0]], last: tokenAt[hits.at(-1)], from: hits[0], to: hits.at(-1) });
  }
  // Unmatched speech at a seam could belong to either line. Request better timing.
  if (spans[0].from > 1 || heard.length - spans.at(-1).to > 2) return;
  const cuts = [0], shared = new Map();
  for (let i = 1; i < spans.length; i++) {
    const left = spans[i - 1], right = spans[i];
    if (right.from - left.to > 3) return;
    if (left.last === right.first) {
      const seams = shared.get(left.last) ?? [];
      seams.push(i);
      shared.set(left.last, seams);
    } else cuts[i] = Math.round((tokens[left.last].end + tokens[right.first].start) / 2);
  }
  // A sentence-level cue can cover several lines. Only divide it at measured internal
  // silences if each seam has exactly one corresponding pause in reading order.
  for (const [id, seams] of shared) {
    const token = tokens[id];
    const gaps = pauses.filter(pause => pause.start > token.start && pause.end < token.end);
    if (gaps.length !== seams.length) return;
    for (const [i, seam] of seams.entries()) {
      const cut = Math.round((gaps[i].start + gaps[i].end) / 2);
      const fraction = (spans[seam].from - token.offset) / token.length;
      if (Math.abs((cut - token.start) / (token.end - token.start) - fraction) > 0.22) return;
      cuts[seam] = cut;
    }
  }
  cuts.push(duration);
  if (cuts.slice(1).some((cut, i) => cut - cuts[i] < 100)) return;
  return spans.map((span, i) => {
    const start = cuts[i], end = cuts[i + 1];
    return { start, end, cues: [{ text: lines[i], start: Math.max(0, tokens[span.first].start - start),
      end: Math.min(end, tokens[span.last].end) - start }] };
  });
}

// Whisper may return traditional characters for simplified Mandarin. Use the built-in
// Windows text conversion only for matching. The original text stays on the timeline.
async function alignTranscript(lines, cues, duration, pauses, signal) {
  let ranges = alignScript(lines, cues, duration, pauses);
  if (ranges || process.platform !== 'win32' || !lines.some(line => /\p{Script=Han}/u.test(line))) return ranges;
  const powershell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const command = '[Console]::InputEncoding=[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);'
    + 'Add-Type -AssemblyName Microsoft.VisualBasic;'
    + '[Console]::Write([Microsoft.VisualBasic.Strings]::StrConv([Console]::In.ReadToEnd(),256,2052))';
  const converted = await new Promise((resolve, reject) => {
    const child = execFile(powershell, ['-NoProfile', '-NonInteractive', '-Command', command],
      { windowsHide: true, timeout: 10000, signal, maxBuffer: 1024 * 1024 }, (error, output) => error ? reject(error) : resolve(output));
    child.stdin.on('error', reject);
    child.stdin.end(JSON.stringify([lines, cues.map(cue => cue.text)]), 'utf8');
  });
  const [normalizedLines, recognized] = JSON.parse(converted);
  ranges = alignScript(normalizedLines, cues.map((cue, i) => ({ ...cue, text: recognized[i] })), duration, pauses);
  ranges?.forEach((range, i) => { range.cues[0].text = lines[i]; });
  return ranges;
}

async function synthesizeSegmented({ provider, jobs, speed, volume, pitch, trimPauses, directory, signal, progress,
  recognize = recognizeLocalSpeech }) {
  const lines = jobs.map(({ text }) => text.trim());
  const text = lines.join('\n');
  const type = provider.status().provider;
  const limit = type === 'seed-audio' ? 3000 : type === 'breezeblue' ? 1000 : 500;
  if ([...text].length > limit) throw new Error('整篇台词超过当前服务的 ' + limit + ' 字上限，请缩短后再生成。');
  if (lines.some(line => !characters(line).length)) throw new Error('每段台词至少需要一个可朗读的字或数字。');
  if (new Set(jobs.map(job => job.voiceId)).size !== 1 || jobs.some((job, i) => i && job.index <= jobs[i - 1].index)) {
    throw new Error('请按分镜顺序提交台词，并为整篇选择同一音色。');
  }
  let generated, folder, success = false;
  try {
    progress('正在连续朗读整篇台词');
    generated = await provider.synthesize({ text, voiceId: jobs[0].voiceId, speed, volume, signal, enableSubtitles: true,
      ...(type === 'seed-audio' && { pitch }), ...(type === 'breezeblue' && { wordTiming: true }) });
    const audio = await inspectAsset(generated.path, 'audio', { signal });
    if (type === 'seed-audio' && audio.codec !== 'mp3') throw new Error('Seed Audio 未返回有效的 MP3。');
    const duration = Math.round(audio.duration * 1000);
    const timing = type === 'breezeblue' ? generated.wordCues : generated.captions;
    progress('正在按原文对齐分镜');
    let ranges = alignScript(lines, timing, duration);
    if (lines.length === 1 && !ranges && type !== 'seed-audio') {
      ranges = [{ start: 0, end: duration, cues: [{ start: 0, end: duration, text: lines[0] }] }];
    }
    if (!ranges) {
      const pauses = (await detectPauses(audio, { minimum: 0.12, padding: 0 }, { signal }))
        .map(gap => ({ start: Math.round(gap.start * 1000), end: Math.round(gap.end * 1000) }));
      ranges = alignScript(lines, timing, duration, pauses);
      if (!ranges) {
        progress('正在本机识别连续口播并核对分段');
        const transcript = await recognize(audio, { signal });
        ranges = await alignTranscript(lines, transcript.cues, duration, pauses, signal);
      }
    }
    if (!ranges) throw new Error('无法可靠对齐每段原文。请检查台词、段间停顿或选择能返回词级时间码的音色服务。');
    await fs.mkdir(directory, { recursive: true });
    folder = await fs.mkdtemp(path.join(directory, '分段-'));
    const ffmpeg = process.env.JIAJIAN_FFMPEG || process.env.SUPERDIR_REPLICA_FFMPEG || 'ffmpeg';
    const splitTimes = ranges.slice(1).map(range => range.start / 1000);
    progress('正在切分配音片段');
    const name = n => '配音-' + String(n).padStart(4, '0') + '.wav';
    await runTool(ffmpeg, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-i', audio.path, '-map', '0:' + audio.audioIndex,
      '-vn', '-af', 'aresample=48000,asetnsamples=n=48:p=0', '-c:a', 'pcm_s16le', '-map_metadata', '-1',
      ...(splitTimes.length ? ['-f', 'segment', '-segment_times', splitTimes.join(','), '-reset_timestamps', '1',
        '-segment_start_number', '1', '配音-%04d.wav'] : [name(1)])], { signal, cwd: folder });
    const results = [];
    for (const [i, range] of ranges.entries()) {
      let asset = await inspectAsset(path.join(folder, name(i + 1)), 'audio', { signal });
      let timedCaptions = range.cues.map(cue => ({ ...cue, end: Math.min(cue.end, Math.round(asset.duration * 1000)) }))
        .filter(cue => cue.end > cue.start);
      if (!timedCaptions.length) throw new Error('分镜台词超出了切分后的音频时长。');
      if (trimPauses) {
        const pauses = await detectPauses(asset, {}, { signal });
        if (pauses.length && asset.duration - pauses.reduce((sum, gap) => sum + gap.end - gap.start, 0) >= 0.1) {
          const untrimmed = asset.path;
          [asset] = await processAudio(asset, { mode: 'trim', intervals: pauses }, folder, { signal });
          timedCaptions = retimeCaptions(timedCaptions, pauses);
          await fs.unlink(untrimmed);
        }
      }
      results.push({ index: jobs[i].index, voiceId: jobs[i].voiceId, asset, scriptText: lines[i], timedCaptions });
      progress('正在检查配音片段', i + 1);
    }
    signal.throwIfAborted();
    success = true;
    return results;
  } finally {
    if (generated?.path && path.dirname(generated.path) === directory) await fs.rm(generated.path, { force: true }).catch(() => {});
    if (folder && !success && path.dirname(folder) === directory) await fs.rm(folder, { recursive: true, force: true });
  }
}

module.exports = { alignScript, synthesizeSegmented };
