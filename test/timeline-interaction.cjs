'use strict';

const assert = require('node:assert/strict');

module.exports = async function checkTimelineInteraction(win, read, waitFor, checkFold) {
  const lane = '#timeline-clock .sequence-video';
  const clip = lane + ' .sequence-block';
  const trackHeight = (selector) => read(`document.querySelector(${JSON.stringify(selector)}).offsetHeight`);
  const rect = (selector) => read(`document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect().toJSON()`);
  const left = await rect(clip);
  const next = await rect(clip + ':nth-child(2)');
  const still = await rect(clip + ':nth-child(3)');
  const ruler = await rect('.sequence-ruler .sequence-content');
  assert.equal(await read(`document.querySelector('${clip} .sequence-clip-duration').textContent`),'1.50 秒','右上角应显示完整原片时长');
  win.webContents.debugger.attach();
  async function mouse(type, x, y) {
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
      type, x, y, button: type === 'mouseMoved' ? 'none' : 'left',
      buttons: type === 'mouseReleased' ? 0 : 1, clickCount: type === 'mouseMoved' ? 0 : 1,
    });
  }
  try {
    const x = left.left + left.width / 2;
    await mouse('mousePressed', x, ruler.top + 9);
    await mouse('mouseReleased', x, ruler.top + 9);
    await waitFor('document.querySelector("#preview-name").textContent.includes("红色") && Math.abs(document.querySelector("#preview").currentTime-.75)<.08', '点标尺应定位到第一条素材中部');
    const linePoint = await read(`(() => {
      const cursor=document.querySelector('.sequence-cursor');
      const line=cursor.getBoundingClientRect(),first=document.querySelector('${clip}').getBoundingClientRect();
      const x=line.left+line.width/2,y=first.top+first.height/2;
      return {x,y,hit:document.elementFromPoint(x,y)?.className};
    })()`);
    assert.equal(linePoint.hit,'sequence-cursor','应能从素材上方直接抓住播放线');
    const to = next.left + next.width / 2;
    await mouse('mousePressed', linePoint.x, linePoint.y);
    await mouse('mouseMoved', to, linePoint.y);
    await waitFor('document.querySelector("#preview-name").textContent.includes("绿色") && Math.abs(document.querySelector("#preview").currentTime-.75)<.08', '拖住播放线期间应跨分镜实时预览下一段');
    const imageX = still.left + still.width / 2;
    await mouse('mouseMoved', imageX, linePoint.y);
    await waitFor('document.querySelector("#preview-name").textContent.includes("静帧") && Math.abs(document.querySelector("#player-position").valueAsNumber-1.5)<.08', '经过图片时播放器应显示图片并同步停留时间');
    await mouse('mouseReleased', imageX, linePoint.y);
    const original = await trackHeight(lane);
    const other = await trackHeight('.sequence-shots');
    const grip = await rect(lane + ' .sequence-height-handle');
    const gx = grip.left + grip.width / 2, gy = grip.top + grip.height / 2;
    await mouse('mousePressed', gx, gy);
    await mouse('mouseMoved', gx, gy + 24);
    const enlarged = await trackHeight(lane);
    assert.ok(Math.abs(enlarged - original - 24) < 2, '拖住边界时轨道高度应即时跟随指针');
    await mouse('mouseReleased', gx, gy + 24);
    const expandedGrip = await rect(lane + ' .sequence-height-handle');
    const expandedY = expandedGrip.top + expandedGrip.height / 2;
    await mouse('mousePressed', gx, expandedY);
    await mouse('mouseMoved', gx, expandedY - enlarged);
    assert.equal(await trackHeight(lane),17,'往上拖过边界时应折叠轨道');
    for (const type of ['rawKeyDown','keyUp']) {
      await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type,key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    }
    await mouse('mouseReleased', gx, expandedY - enlarged);
    assert.equal(await trackHeight(lane),enlarged,'取消后应还原已经设置的轨高');
    assert.equal(await read(`document.querySelector('${lane} [aria-expanded]').getAttribute('aria-expanded')`),'true');
    assert.equal(await trackHeight('.sequence-shots'), other);
    const toggle = () => read(`document.querySelector('${lane} [aria-expanded]').click()`);
    assert.equal(await checkFold(lane + ' [aria-expanded]', lane), 17, '折叠后的轨道应收至色带高度');
    assert.equal(await read(`document.querySelector('${lane} [aria-expanded]').getAttribute('aria-expanded')`), 'false');
    assert.ok(await read(`(() => {const block=document.querySelector('${clip}');return block.offsetHeight>0 && getComputedStyle(block).visibility==='visible' && getComputedStyle(block).display!=='none';})()`), '折叠后素材仍应显示为色带');
    await toggle();
    await waitFor(`document.querySelector('${lane}').offsetHeight===${enlarged}`, '重新展开应还原自定义轨高');
    const reopened = await rect(lane + ' .sequence-height-handle');
    const reopenedY = reopened.top + reopened.height / 2;
    await mouse('mousePressed', gx, reopenedY);
    await mouse('mouseMoved', gx, reopenedY - 8);
    assert.ok(Math.abs(await trackHeight(lane) - enlarged + 8) < 2, '刚展开的轨道也应在拖动中即时调整高度');
    await mouse('mouseReleased', gx, reopenedY - 8);
    await read(`document.querySelector('${lane} .sequence-height-handle').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`);
    await waitFor(`document.querySelector('${lane}').offsetHeight===${original}`, '双击边界应恢复默认轨高');
    const changeSpeed = (speed) => read(`(() => {
      const input=document.querySelector('#shots .asset .speed');
      input.value='${speed}';input.dispatchEvent(new Event('input',{bubbles:true}));
    })()`);
    await changeSpeed(2);
    await waitFor(`Number(document.querySelector('${clip}').dataset.playbackDuration)===.75
      && document.querySelector('${clip} .sequence-clip-duration').textContent==='1.50 秒'
      && document.querySelector('#shots .asset-meta').textContent.startsWith('候选 0.75 秒')
      && Number(document.querySelector('${clip}:nth-child(2)').dataset.playbackDuration)===1.5`, '倍速缩短候选播放长度，原片时长保持可见');
    await changeSpeed(1);
    await waitFor(`Number(document.querySelector('${clip}').dataset.playbackDuration)===1.5`, '还原速度应同步刷新候选时长');
  } finally {
    win.webContents.debugger.detach();
  }
};
