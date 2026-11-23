'use strict';

const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');

async function dragLibraryItem(contents, source, target, mimeType, hover, cancel=false) {
  const client = contents.debugger;
  const send = (method, params) => client.sendCommand('Input.' + method, params);
  let data,point=source;
  const capture = (_event, method, params) => { if (method === 'Input.dragIntercepted') data = params.data; };
  client.on('message', capture);
  await send('setInterceptDrags', { enabled: true });
  try {
    await send('dispatchMouseEvent', { type:'mouseMoved', x:source.x, y:source.y });
    await send('dispatchMouseEvent', { type:'mousePressed', x:source.x, y:source.y, button:'left', buttons:1, clickCount:1 });
    await send('dispatchMouseEvent', { type:'mouseMoved', x:source.x+9, y:source.y, button:'left', buttons:1 });
    await send('dispatchMouseEvent', { type:'mouseMoved', x:source.x+18, y:source.y, button:'left', buttons:1 });
    const end = Date.now() + 3000;
    while (!data && Date.now() < end) await delay(20);
    assert.ok(data?.items.some(item => item.mimeType === mimeType), '素材库应发起原生拖放 ' + mimeType);
    point=typeof target==='function' ? await target() : target;
    for (const type of ['dragEnter','dragOver']) await send('dispatchDragEvent', { type, x:point.x, y:point.y, data });
    await hover();
    await send('dispatchDragEvent', { type:cancel?'dragCancel':'drop', x:point.x, y:point.y, data });
  } finally {
    client.off('message', capture);
    await send('dispatchMouseEvent', { type:'mouseReleased', x:point.x, y:point.y, button:'left', clickCount:1 });
    await send('setInterceptDrags', { enabled: false });
  }
}

// Use Chromium's input pipeline so a hidden, disabled or covered control cannot pass a navigation test.
async function clickVisible(contents, selector, button = 'left') {
  const point = await contents.executeJavaScript(`(async () => {
    const selector = ${JSON.stringify(selector)};
    document.querySelector(selector)?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    await new Promise(requestAnimationFrame);
    // Scrolling can rebuild the timeline, so hit-test the control on the painted frame.
    const button = document.querySelector(selector);
    if (!button?.checkVisibility() || button.matches(':disabled') || button.closest('[inert]')) return null;
    const { x, y, width, height } = button.getBoundingClientRect();
    const point = { x: x + width / 2, y: y + height / 2 };
    return button.contains(document.elementFromPoint(point.x, point.y)) ? point : null;
  })()`);
  if (!point) throw new Error('无法点击可见的控件 ' + selector);
  const client = contents.debugger;
  const alreadyAttached = client.isAttached();
  if (!alreadyAttached) client.attach();
  try {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await client.sendCommand('Input.dispatchMouseEvent', { type, ...point, button, clickCount: 1 });
    }
  } finally {
    if (!alreadyAttached) client.detach();
  }
}

module.exports = { clickVisible, dragLibraryItem };
