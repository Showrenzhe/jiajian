'use strict';

const assert = require('node:assert/strict');
const { ffmpeg } = require('./fixtures.cjs');

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const BYTES_PER_SAMPLE = 2;
// 振幅 0.25 的单声道正弦转成立体声，每声道的理论 RMS 约为 0.125。
// 容许两次编码的 RMS 相差 0.006 满刻度，相当于该音量下约 0.4 dB。
const RMS_TOLERANCE = 0.006;
const SILENCE_MAX_RMS = 0.001; // −60 dBFS，容纳 AAC 编解码的微小残留。
const TONE_MIN_RMS = 0.08; // 比理论音量低约 4 dB，能识别两端同时丢失原声。

// 第一镜无原声。第二镜在 0.8 秒开始，以 2× 播放源素材 [0.2, 1.0) 秒，
// 660 Hz 音调应在工程约 0.95 秒起音。窗口避开变速接缝及 AAC 起止填充。
const WINDOWS = [
  { label: '无声素材', start: 0.20, end: 0.28, tone: false },
  { label: '倍速片段起音前', start: 0.82, end: 0.90, tone: false },
  { label: '倍速片段起音后', start: 1.02, end: 1.10, tone: true },
  { label: '倍速片段末段', start: 1.11, end: 1.17, tone: true },
];

async function decodeAudio(file) {
  return ffmpeg(['-i', file, '-map', '0:a:0', '-vn', '-af',
    `aresample=${SAMPLE_RATE}:async=1:first_pts=0`, '-ac', String(CHANNELS), '-f', 's16le', 'pipe:1']);
}

function rms(pcm, start, end, label) {
  const first = Math.round(start * SAMPLE_RATE) * CHANNELS;
  const stop = Math.round(end * SAMPLE_RATE) * CHANNELS;
  assert.ok(stop * BYTES_PER_SAMPLE <= pcm.length, `${label}：音轨未覆盖 ${start}–${end} 秒`);
  let sum = 0;
  for (let sample = first; sample < stop; sample++) {
    const amplitude = pcm.readInt16LE(sample * BYTES_PER_SAMPLE) / 32768;
    sum += amplitude * amplitude;
  }
  return Math.sqrt(sum / (stop - first));
}

async function compareAudio(previewFile, exportFile) {
  const [preview, output] = await Promise.all([decodeAudio(previewFile), decodeAudio(exportFile)]);
  return WINDOWS.map(({ label, start, end, tone }) => {
    const previewRms = rms(preview, start, end, '预览');
    const exportRms = rms(output, start, end, '成片');
    const difference = Math.abs(previewRms - exportRms);
    const location = `${label} ${start}–${end} 秒，预览 RMS=${previewRms.toFixed(5)}，成片 RMS=${exportRms.toFixed(5)}`;
    if (tone) {
      assert.ok(Math.min(previewRms, exportRms) >= TONE_MIN_RMS, `${location}，应有原声 (≥ ${TONE_MIN_RMS})`);
    } else {
      assert.ok(Math.max(previewRms, exportRms) <= SILENCE_MAX_RMS, `${location}，应为静音 (≤ ${SILENCE_MAX_RMS})`);
    }
    assert.ok(difference <= RMS_TOLERANCE, `${location}，RMS 差值超过 ${RMS_TOLERANCE}`);
    return { label, start, end, previewRms, exportRms, difference };
  });
}

module.exports = { compareAudio };
