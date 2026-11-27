'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const createRegistry = require('../src/ui/commands.js');
const messages = require('../src/ui/messages-zh-cn.js');

test('快捷键文档逐项对应注册表的操作位置、名称和默认键位', () => {
  const registry = createRegistry(messages);
  const expected = registry.list().filter(command => command.help).map(({id, scope, title}) =>
    [messages.shortcutScopes[scope], title, registry.labelFor(id) || messages.shortcutSettings.unbound].join('|'));
  const markdown = fs.readFileSync(path.join(__dirname, '../docs/shortcuts.md'), 'utf8');
  const actual = markdown.split(/\r?\n/).filter(line => line.startsWith('|')).slice(2)
    .map(line => line.slice(1, -1).split('|').map(cell => cell.trim()).join('|'));
  assert.deepEqual(actual.sort(), expected.sort());
});

test('执行使用实时可用条件，自定义键位查询与默认值独立', () => {
  const registry = createRegistry(messages);
  const selection = {selected: true};
  let runs = 0;
  assert.equal(registry.execute('split', selection), false);
  registry.bind('split', {when: context => context.selected, run: () => ++runs});
  assert.equal(registry.execute('split', selection), 1);
  selection.selected = false;
  assert.equal(registry.execute('split', selection), false);
  registry.setBindingReader(id => id === 'split' ? ['G', null] : undefined);
  assert.equal(registry.labelFor('split'), 'G');
  assert.deepEqual(registry.get('split').shortcut, ['W', 'Ctrl+B']);
  assert.equal(registry.labelFor('palette'), 'Ctrl+K');
});

test('固定键冲突区分全局命令与仅在视频菜单或剪辑台生效的命令', () => {
  const registry = createRegistry(messages);
  assert.equal(registry.fixedOwner('Ctrl+K', 'split').id, 'palette');
  assert.equal(registry.fixedOwner('Ctrl+/', 'quick-save').id, 'editing-help');
  for (const key of ['M', '[', ']', 'Ctrl+Y']) {
    assert.equal(registry.fixedOwner(key, 'split'), undefined);
    assert.ok(registry.fixedOwner(key, 'quick-save'));
  }
});
