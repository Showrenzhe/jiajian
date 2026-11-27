'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRenderingPolicy } = require('../src/rendering-policy.cjs');
const editorMessages = require('../src/ui/messages-zh-cn.js');
const script = fs.readFileSync(path.join(__dirname, '../src/ui/glass-effect.js'), 'utf8');

function openWindow(active, storage) {
  const window = { workbench: { softwareRenderingActive: active }, editorMessages };
  const root = { dataset: {} };
  vm.runInNewContext(script, { window, document: { documentElement: root }, localStorage: storage });
  const firstGlass = root.dataset.glass;
  const picker = new EventTarget();
  const note = {};
  window.bindGlassEffectPicker(picker, note);
  function choose(value) {
    assert.equal(picker.disabled, false);
    picker.value = value;
    picker.dispatchEvent(new Event('change'));
    return root.dataset.glass;
  }
  return { firstGlass, picker, note, choose };
}

test('glass uses the saved preference before settings mount and survives restarts in and out of software rendering', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jiajian-glass-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const data = new Map();
  const storage = { getItem: key => data.get(key), setItem: (key, value) => data.set(key, value) };
  const hardware = createRenderingPolicy(dir, () => 1000);
  const first = openWindow(hardware.active, storage);
  assert.equal(first.firstGlass, 'full');
  assert.equal(first.choose('lite'), 'lite');
  assert.equal(openWindow(hardware.active, storage).firstGlass, 'lite');

  for (let i = 0; i < 2; i++) hardware.processGone({ type: 'GPU', reason: 'crashed' });
  assert.equal(openWindow(hardware.active, storage).firstGlass, 'lite');
  const recovered = createRenderingPolicy(dir);
  const locked = openWindow(recovered.active, storage);
  assert.equal(locked.firstGlass, 'off');
  assert.equal(locked.picker.value, 'off');
  assert.equal(locked.picker.disabled, true);
  assert.equal(locked.note.hidden, false);
  assert.equal(locked.note.textContent, editorMessages.glassEffect.compatibility);
  assert.equal(recovered.consumeNotice(), true);
  recovered.set(false);
  assert.equal(openWindow(recovered.active, storage).firstGlass, 'off');
  const restored = createRenderingPolicy(dir);
  const unlocked = openWindow(restored.active, storage);
  assert.equal(unlocked.firstGlass, 'lite');
  assert.equal(unlocked.note.hidden, true);

  assert.equal(unlocked.choose('off'), 'off');
  restored.set(true);
  const manual = createRenderingPolicy(dir);
  assert.equal(openWindow(manual.active, storage).picker.disabled, true);
  manual.set(false);
  const last = openWindow(createRenderingPolicy(dir).active, storage);
  assert.equal(last.firstGlass, 'off');
  assert.equal(last.choose('full'), 'full');
  assert.equal(data.get('jiajian.glass'), 'full');
});

test('an unrecognized preference falls back to full, and a failed write keeps the selected effect', () => {
  const ui = openWindow(false, {
    getItem: () => 'unknown',
    setItem: () => { throw Error('unavailable'); },
  });
  assert.equal(ui.firstGlass, 'full');
  assert.equal(ui.choose('off'), 'full');
  assert.equal(ui.picker.value, 'full');
  assert.equal(ui.note.hidden, false);
  assert.equal(ui.note.textContent, editorMessages.glassEffect.storageError);
});
