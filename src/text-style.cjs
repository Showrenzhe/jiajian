'use strict';

const { existsSync } = require('node:fs');
const path = require('node:path');

const fonts = { yahei: ['msyh.ttc', 'Microsoft YaHei'], bold: ['msyhbd.ttc', 'Microsoft YaHei Bold'],
  heiti: ['simhei.ttf', 'SimHei'], song: ['simsun.ttc', 'SimSun'], kai: ['simkai.ttf', 'KaiTi'],
  fang: ['simfang.ttf', 'FangSong'], arial: ['arial.ttf', 'Arial'] };
const defaults = { font: 'yahei', outlineWidth: 1, outlineColor: '#000000', background: false, backgroundColor: '#000000',
  backgroundOpacity: .55, shadow: false, shadowColor: '#000000', shadowX: 2, shadowY: 3 };

function normalizeTextStyle(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('包装文字样式无效。');
  const result = Object.fromEntries(Object.entries(defaults).map(([key, base]) => [key, value[key] ?? base]));
  if (!Object.hasOwn(fonts, result.font) || typeof result.shadow !== 'boolean' || typeof result.background !== 'boolean'
      || !['outlineColor','backgroundColor','shadowColor'].every((key) => typeof result[key] === 'string' && /^#[A-Fa-f0-9]{6}$/.test(result[key]))) {
    throw new Error('文字字体或样式颜色无效。');
  }
  for (const [key, min, max] of [['outlineWidth',0,24],['backgroundOpacity',0,1],['shadowX',-40,40],['shadowY',-40,40]]) {
    if (!Number.isFinite(result[key]) || result[key] < min || result[key] > max) throw new Error('文字描边、底色透明度或阴影偏移无效。');
  }
  return result;
}

function textAppearance(style, width) {
  const s = style ?? defaults;
  const [file, family] = fonts[s.font];
  let font = `font='${family}'`;
  if (process.platform === 'win32') {
    const dir = path.join(process.env.SystemRoot || 'C:\\Windows','Fonts');
    const found = [file,'msyh.ttc','simsun.ttc','arial.ttf'].map((leaf) => path.join(dir,leaf)).find(existsSync);
    if (found) font = `fontfile='${found.replaceAll('\\','/').replace(':','\\:')}'`;
  }
  const pixels = (value) => value ? Math.sign(value) * Math.max(1, Math.round(Math.abs(value) * width / 1080)) : 0;
  const attributes = [font, `borderw=${pixels(s.outlineWidth)}`, `bordercolor=${s.outlineColor}${style ? '' : '@0.75'}`];
  if (s.background) attributes.push('box=1', `boxcolor=${s.backgroundColor}@${s.backgroundOpacity}`, `boxborderw=${pixels(6)}`);
  if (s.shadow) attributes.push(`shadowcolor=${s.shadowColor}`, `shadowx=${pixels(s.shadowX)}`, `shadowy=${pixels(s.shadowY)}`);
  return attributes.join(':');
}

function fontFamily(id) {
  return Object.hasOwn(fonts, id) ? fonts[id][1] : null;
}

module.exports = { normalizeTextStyle, textAppearance, fontFamily };
