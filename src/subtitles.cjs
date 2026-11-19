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

function formatCue({ start, end, text }, index, coordinates = '') {
  return (index + 1) + '\n' + formatTime(start) + ' --> ' + formatTime(end) + coordinates + '\n' + text + '\n\n';
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
    if (cue.highlights?.length) {
      if (!Array.isArray(cue.highlights) || cue.highlights.length>64) throw new Error('每句最多支持 64 个重点词。');
      normalized.highlights=cue.highlights.map(({word,color})=>{
        if(typeof word!=='string' || !word.trim() || word.length>100 || !/^#[0-9a-f]{6}$/i.test(color)) throw new Error('字幕重点词或颜色无效。');
        return {word,color};
      });
    }
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

function markedText(cue) {
  const marks=cue.highlights ?? [];
  if (!marks.length) return cue.text;
  const escape=(word)=>word.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
  let output='',pos=0;
  while(pos<cue.text.length) {
    let next=cue.text.length, active;
    for (const entry of marks) {
      const i=cue.text.indexOf(entry.word,pos);
      if(i>=0 && (i<next || i===next && entry.word.length>(active?.word.length ?? 0))) {next=i;active=entry;}
    }
    output+=escape(cue.text.slice(pos,next));
    if (!active) break;
    output+='<font color="'+active.color+'"><b>'+escape(active.word)+'</b></font>';
    pos=next+active.word.length;
  }
  return output;
}

function formatSubtitles(track, style) {
  // FFmpeg maps the SubRip 720×480 coordinate space to the actual output frame.
  // A non-empty rectangle makes its center the text anchor in libass.
  let coordinates = '';
  if (style?.position === 'custom') {
    const x = Math.round((style.x ?? 50) * 7.2), y = Math.round((style.y ?? 85) * 4.8);
    coordinates = ` X1:${Math.max(0,x-1)} X2:${x+1} Y1:${Math.max(0,y-1)} Y2:${y+1}`;
  }
  return normalizeSubtitles(track)?.cues.map((cue,index)=>formatCue({...cue,text:markedText(cue)},index,coordinates)).join('') ?? '';
}

module.exports = { readSubtitles, parseSubtitles, normalizeSubtitles, formatSubtitles };
