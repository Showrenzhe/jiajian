'use strict';

// Use Chromium's input pipeline so a hidden, disabled or covered control cannot pass a navigation test.
async function clickVisible(contents, selector) {
  const point = await contents.executeJavaScript(`(async () => {
    const button = document.querySelector(${JSON.stringify(selector)});
    if (!button?.checkVisibility() || button.matches(':disabled') || button.closest('[inert]')) return null;
    button.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    await new Promise(requestAnimationFrame);
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
      await client.sendCommand('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
    }
  } finally {
    if (!alreadyAttached) client.detach();
  }
}

module.exports = { clickVisible };
