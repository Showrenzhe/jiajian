'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const maxBytes = 256 * 1024;
const maxCues = 2000;
const maxTime = 100 * 60 * 60 * 1000 - 1;
const sizeError = '字幕内容超过 256 KiB。';

function formatTime(value) {
  const hours = Math.floor(value / 3_600_000);
  const minutes = Math.floor(value / 60_000) % 60;
  const seconds = Math.floor(value / 1000) % 60;
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, '0')).join(':')
    + ',' + String(value % 1000).padStart(3, '0');
}

function formatCue({ start, end, text }, index) {
  return (index + 1) + '\n' + formatTime(start) + ' --> ' + formatTime(end) + '\n' + text + '\n\n';
}

function normalizeSubtitles(value) {
  if (value == null) return null;
  if (typeof value.name !== 'string' || value.name.length > 255) throw new Error('字幕名称无效。');
  const name = value.name.toWellFormed().replace(/[\x00-\x1F\x7F-\x9F]/g, '').trim();
  if (!name) throw new Error('字幕名称无效。');
  if (!Array.isArray(value.cues) || value.cues.length === 0 || value.cues.length > maxCues) {
    throw new Error('字幕需要包含 1 至 2000 条内容。');
  }

  let bytes = 0;
  const cues = Array.from(value.cues, (cue, index) => {
    const { start, end, text } = cue ?? {};
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > maxTime) {
      throw new Error('第 ' + (index + 1) + ' 条字幕的起止时间无效。');
    }
    if (typeof text !== 'string') throw new Error('第 ' + (index + 1) + ' 条字幕缺少文本。');
    if (text.length > maxBytes) throw new Error(sizeError);
    const cleaned = text.toWellFormed().replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0B-\x1F\x7F-\x9F]/g, '').trim();
    if (!cleaned || /\n[ \t]*\n/.test(cleaned)) {
      throw new Error('第 ' + (index + 1) + ' 条字幕缺少文本或含有空行。');
    }
    const normalized = { start, end, text: cleaned };
    bytes += Buffer.byteLength(formatCue(normalized, index));
    if (bytes > maxBytes) throw new Error(sizeError);
    return normalized;
  });
  return { name, cues };
}

function parseTime(text) {
  const parts = /^(\d{2}):([0-5]\d):([0-5]\d),(\d{3})$/.exec(text.trim());
  if (!parts) return NaN;
  const [, hours, minutes, seconds, milliseconds] = parts.map(Number);
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + milliseconds;
}

function parseSubtitles(source, name) {
  const content = source.replace(/\r\n?/g, '\n').trim();
  const blocks = content ? content.split(/\n(?:[ \t]*\n)+/) : [];
  if (blocks.length > maxCues) throw new Error('字幕最多可包含 2000 条内容。');
  const cues = blocks.map((block, index) => {
    const [number, timing, ...lines] = block.split('\n');
    if (number.trim() !== String(index + 1)) throw new Error('字幕编号须从 1 起按顺序排列。');
    const range = timing?.split('-->');
    if (range?.length !== 2) throw new Error('第 ' + (index + 1) + ' 条字幕缺少有效的时间行。');
    return { start: parseTime(range[0]), end: parseTime(range[1]), text: lines.join('\n') };
  });
  return normalizeSubtitles({ name, cues });
}

async function readSubtitles(file) {
  const local = typeof file === 'string' && path.isAbsolute(file) && !file.includes('\0') && !/^[\\/]{2}/.test(file);
  if (!local || path.extname(file).toLowerCase() !== '.srt'
      || (process.platform === 'win32' && (!/^[a-z]:[\\/]/i.test(file) || file.slice(2).includes(':')))) {
    throw new Error('请选择本地的 .srt 字幕文件。');
  }
  const reader = await fs.open(file, 'r');
  try {
    const info = await reader.stat();
    if (!info.isFile()) throw new Error('所选字幕路径不是文件。');
    if (info.size > maxBytes) throw new Error(sizeError);
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await reader.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > maxBytes) throw new Error(sizeError);
    let source;
    try {
      source = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
    } catch {
      throw new Error('无法读取字幕编码，请使用 UTF-8 保存 SRT 文件。');
    }
    return parseSubtitles(source, path.basename(file));
  } finally {
    await reader.close();
  }
}

function formatSubtitles(track) {
  return normalizeSubtitles(track)?.cues.map(formatCue).join('') ?? '';
}

module.exports = { readSubtitles, normalizeSubtitles, formatSubtitles };
