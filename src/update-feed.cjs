'use strict';

function updateFeed(value) {
  if (!value) return null;
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw Error('内部更新地址必须是 HTTPS 目录，不可携带凭据或查询参数。');
  }
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url.href;
}
module.exports = { updateFeed };
