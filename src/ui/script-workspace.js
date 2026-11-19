'use strict';

(() => {
  const storageKey = 'sd-workbench-script-draft-v1';
  const maxFieldLength = 4096;
  const maxImportLength = 500000;
  const rowLimit = { whole: 250, segmented: 1000, textGroups: 250 };
  const emptyRow = () => ({ dialogue: '', note: '' });

  const markup = `
    <header class="script-workspace-header">
      <div class="script-title-area">
        <button id="script-back" type="button" aria-label="返回工作台" title="返回工作台" hidden><svg class="ui-icon" aria-hidden="true"><use href="#icon-chevron"></use></svg></button>
        <h1>脚本编辑</h1>
      </div>
      <div class="script-header-actions">
        <button id="script-share" type="button" disabled title="云端分享尚未接入">分享脚本</button>
        <button id="script-cloud-read-all" type="button"><svg class="ui-icon" aria-hidden="true"><use href="#icon-audio"></use></svg>全部台词朗读</button>
        <button id="script-go-montage" type="button" class="script-blue">前往混剪<svg class="ui-icon" aria-hidden="true"><use href="#icon-chevron"></use></svg></button>
      </div>
    </header>
    <div class="script-workspace-body">
      <aside id="script-assistant" class="script-assistant" aria-labelledby="script-assistant-heading" popover>
        <h2 id="script-assistant-heading">AI 助手</h2>
        <p class="script-model-status script-subtle">以下工具等待接入 AI 服务。</p>
        <div class="script-ai-tools">
          <button type="button" disabled>AI 模板</button>
          <button type="button" disabled>爆款复刻</button>
          <button type="button" disabled>解析台词</button>
          <button type="button" disabled>文字组脚本</button>
          <button type="button" disabled>仿写</button>
        </div>
      </aside>
      <section class="script-content" aria-label="脚本编辑">
        <div class="script-document-heading">
          <div class="script-document-name">
            <input id="script-title" maxlength="100" aria-label="脚本名称" title="编辑脚本名称" placeholder="脚本名称">
            <span id="script-save-status" class="script-subtle" role="status"></span>
          </div>
          <div class="script-rail" role="group" aria-label="脚本工具">
            <button id="script-import-dialogue" type="button">批量导入台词</button>
            <button id="script-import-text-groups" type="button">批量导入文字组</button>
            <button type="button" id="script-assistant-toggle" class="script-rail-current" popovertarget="script-assistant"><svg class="ui-icon" aria-hidden="true"><use href="#icon-spark"></use></svg>AI 助手</button>
          </div>
        </div>
        <div class="script-sheet">
          <div class="script-sheet-controls">
            <nav class="script-content-tabs" aria-label="编辑内容">
              <button id="script-content-tab" type="button">脚本内容</button>
              <button id="script-text-group-tab" type="button">文字组（大字报）</button>
            </nav>
            <div id="script-mode-options" class="script-mode-options" role="group" aria-label="口播脚本类型">
              <button id="script-mode-whole" type="button">整段式口播</button>
              <button id="script-mode-segmented" type="button">分段式口播</button>
            </div>
          </div>
          <div class="script-grid-wrap">
            <table class="script-grid" aria-label="脚本内容表格">
              <colgroup><col class="script-index-col"><col><col class="script-note-col"></colgroup>
              <thead><tr><th scope="col" id="script-index-heading">脚本编号</th><th scope="col" id="script-dialogue-heading">口播台词</th><th scope="col">参考画面要求/备注</th></tr></thead>
              <tbody id="script-rows"></tbody>
            </table>
          </div>
          <div class="script-sheet-footer">
            <button id="script-add-row" type="button">＋ 新增脚本</button>
            <span id="script-row-count" class="script-subtle" role="status"></span>
          </div>
        </div>
      </section>
    </div>
    <dialog id="script-import-dialog" class="script-import-dialog" aria-labelledby="script-import-heading">
      <form id="script-import-form">
        <h2 id="script-import-heading"></h2>
        <p id="script-import-instructions" class="script-subtle">每行一条。以 1、2、等编号开头时，未编号的后续行会接到上一条。可用 Tab 分隔内容和备注。</p>
        <textarea id="script-import-input" aria-labelledby="script-import-heading" aria-describedby="script-import-instructions" rows="8"></textarea>
        <p id="script-import-error" role="alert" hidden></p>
        <div class="script-import-actions">
          <button id="script-import-cancel" type="button">取消</button>
          <button id="script-import-confirm" type="submit" class="script-blue">导入</button>
        </div>
      </form>
    </dialog>`;

  function normalize(value) {
    const model = {
      title: typeof value?.title === 'string' ? value.title.slice(0, 100) : '未命名创意',
      tab: value?.tab === 'textGroups' ? 'textGroups' : 'narration',
      mode: value?.mode === 'segmented' ? 'segmented' : 'whole',
    };
    for (const key of Object.keys(rowLimit)) {
      const saved = value?.[key];
      model[key] = Array.isArray(saved) && saved.length
        ? Array.from(saved.slice(0, rowLimit[key]), (row) => ({
          dialogue: typeof row?.dialogue === 'string' ? row.dialogue.slice(0, maxFieldLength) : '',
          note: typeof row?.note === 'string' ? row.note.slice(0, maxFieldLength) : '',
        }))
        : Array.from({ length: 3 }, emptyRow);
    }
    return model;
  }

  function storedDraft() {
    try {
      return normalize(JSON.parse(window.localStorage.getItem(storageKey)));
    } catch {
      return normalize();
    }
  }

  function parseImport(text) {
    if (text.length > maxImportLength) throw new Error('粘贴的内容太长，请分批导入。');
    const lines = text.replace(/\r\n?/g, '\n').trim().split('\n');
    const numbered = /^\s*(?:\d{1,3}[、.．:：)）]|[（(]\d{1,3}[）)])[ \t]*(.*)$/u;
    const rowFromLine = (line) => {
      const [dialogue, ...note] = line.split('\t');
      return { dialogue: dialogue.trim(), note: note.join('\t').trim() };
    };
    const rows = [];
    if (numbered.test(lines[0])) {
      for (const line of lines) {
        const match = numbered.exec(line);
        if (match) rows.push(rowFromLine(match[1]));
        else rows.at(-1).dialogue += `\n${line}`;
      }
    } else {
      for (const line of lines) if (line.trim()) rows.push(rowFromLine(line));
    }
    const result = rows.map(({ dialogue, note }) => ({ dialogue: dialogue.trim(), note })).filter(hasContent);
    if (!result.length) throw new Error('请先粘贴要导入的内容。');
    if (result.some(({ dialogue, note }) => dialogue.length > maxFieldLength || note.length > maxFieldLength)) {
      throw new Error(`每格最多 ${maxFieldLength} 字，请缩短后重试。`);
    }
    return result;
  }

  function hasContent({ dialogue, note }) {
    return Boolean(dialogue.trim() || note.trim());
  }

  window.mountScriptWorkspace = (container, { onMontage, onBack, onNarrate } = {}) => {
    const template = document.createElement('template');
    template.innerHTML = markup;
    container.classList.add('script-workspace');
    container.replaceChildren(template.content);
    const $ = (id) => container.querySelector(`#${id}`);
    const title = $('script-title');
    const status = $('script-save-status');
    const body = $('script-rows');
    const importDialog = $('script-import-dialog');
    const importInput = $('script-import-input');
    const importError = $('script-import-error');
    let model = storedDraft();
    let importKey;

    function activeKey() {
      return model.tab === 'textGroups' ? 'textGroups' : model.mode;
    }

    function persist() {
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(model));
        status.textContent = '已保存到本机';
      } catch {
        status.textContent = '当前草稿未能保存到本机';
      }
    }

    function updateRowCount() {
      const key = activeKey();
      const rows = model[key];
      $('script-row-count').textContent = `已填写 ${rows.filter(hasContent).length} / ${rows.length} 条`;
      $('script-add-row').disabled = rows.length >= rowLimit[key];
    }

    function makeRow(key, row, index) {
      const tableRow = document.createElement('tr');
      tableRow.className = 'script-row';
      const indexCell = document.createElement('th');
      indexCell.scope = 'row';
      const number = document.createElement('span');
      number.className = 'script-row-number';
      number.textContent = `${key === 'textGroups' ? '文字组' : '脚本'} ${index + 1}`;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'script-remove-row';
      remove.textContent = '删除';
      remove.setAttribute('aria-label', `删除第 ${index + 1} 条`);
      remove.addEventListener('click', () => {
        model[key].splice(index, 1);
        if (!model[key].length) model[key].push(emptyRow());
        renderRows();
        body.rows[Math.min(index, body.rows.length - 1)].querySelector('.script-dialogue').focus();
        persist();
      });
      indexCell.append(number, remove);
      tableRow.append(indexCell);

      for (const [field, label] of [['dialogue', key === 'textGroups' ? '文字组内容' : '口播台词'], ['note', '参考画面要求或备注']]) {
        const cell = document.createElement('td');
        const input = document.createElement('textarea');
        input.className = `script-${field}`;
        input.setAttribute('aria-label', `第 ${index + 1} 条${label}`);
        input.placeholder = field === 'note' ? '添加参考画面要求或备注' : `请输入${label}`;
        input.maxLength = maxFieldLength;
        input.value = row[field];
        const length = field === 'dialogue' ? document.createElement('span') : null;
        if (length) {
          length.className = 'script-dialogue-length';
          length.textContent = `${row.dialogue.trim().length} 字`;
        }
        input.addEventListener('input', () => {
          row[field] = input.value;
          if (length) length.textContent = `${row.dialogue.trim().length} 字`;
          updateRowCount();
          persist();
        });
        cell.append(input);
        if (length) cell.append(length);
        tableRow.append(cell);
      }
      return tableRow;
    }

    function renderRows() {
      const key = activeKey();
      const text = key === 'textGroups';
      $('script-content-tab').setAttribute('aria-pressed', String(!text));
      $('script-text-group-tab').setAttribute('aria-pressed', String(text));
      $('script-mode-options').hidden = text;
      $('script-cloud-read-all').hidden = text || !onNarrate;
      $('script-mode-whole').setAttribute('aria-pressed', String(model.mode === 'whole'));
      $('script-mode-segmented').setAttribute('aria-pressed', String(model.mode === 'segmented'));
      $('script-index-heading').textContent = text ? '文字组编号' : '脚本编号';
      $('script-dialogue-heading').textContent = text ? '文字组内容' : '口播台词';
      $('script-add-row').textContent = text ? '＋ 新增文字组' : '＋ 新增脚本';
      body.replaceChildren(...model[key].map((row, index) => makeRow(key, row, index)));
      updateRowCount();
    }

    function showImport(key) {
      importKey = key;
      $('script-import-heading').textContent = key === 'textGroups' ? '批量导入文字组'
        : key === 'whole' ? '批量导入整段台词' : '批量导入分段台词';
      importInput.value = '';
      importInput.removeAttribute('aria-invalid');
      importError.hidden = true;
      importDialog.showModal();
      importInput.focus();
    }

    function switchTab(tab) {
      model.tab = tab;
      renderRows();
      persist();
    }

    title.value = model.title;
    title.addEventListener('input', () => { model.title = title.value; persist(); });
    $('script-back').hidden = !onBack;
    $('script-back').addEventListener('click', () => onBack?.());
    $('script-cloud-read-all').addEventListener('click', () => {
      persist();
      onNarrate?.(normalize(model));
    });
    $('script-go-montage').disabled = !onMontage;
    $('script-go-montage').addEventListener('click', () => {
      persist();
      const next = normalize(model);
      if (new TextEncoder().encode(JSON.stringify(next)).byteLength > 256 * 1024) {
        status.textContent = '脚本内容超过工程上限，请缩短后再进入混剪。';
        return;
      }
      onMontage?.(next);
    });
    $('script-content-tab').addEventListener('click', () => switchTab('narration'));
    $('script-text-group-tab').addEventListener('click', () => switchTab('textGroups'));
    for (const mode of ['whole', 'segmented']) {
      $(`script-mode-${mode}`).addEventListener('click', () => {
        model.mode = mode;
        renderRows();
        persist();
      });
    }
    $('script-add-row').addEventListener('click', () => {
      const key = activeKey();
      if (model[key].length >= rowLimit[key]) return;
      const row = emptyRow();
      model[key].push(row);
      const entry = makeRow(key, row, model[key].length - 1);
      body.append(entry);
      entry.querySelector('.script-dialogue').focus();
      updateRowCount();
      persist();
    });
    $('script-import-dialogue').addEventListener('click', () => showImport(model.mode));
    $('script-import-text-groups').addEventListener('click', () => showImport('textGroups'));
    $('script-import-cancel').addEventListener('click', () => importDialog.close());
    $('script-import-form').addEventListener('submit', (event) => {
      event.preventDefault();
      try {
        const incoming = parseImport(importInput.value);
        const rows = model[importKey];
        const slots = rows.flatMap((row, index) => hasContent(row) ? [] : [index]);
        if (incoming.length > slots.length + rowLimit[importKey] - rows.length) {
          throw new Error(`当前页最多支持 ${rowLimit[importKey]} 条。`);
        }
        for (const [index, row] of incoming.entries()) {
          if (index < slots.length) rows[slots[index]] = row;
          else rows.push(row);
        }
        importDialog.close();
        switchTab(importKey === 'textGroups' ? 'textGroups' : 'narration');
      } catch (error) {
        importError.textContent = error.message;
        importError.hidden = false;
        importInput.setAttribute('aria-invalid', 'true');
        importInput.focus();
      }
    });
    renderRows();

    return {
      getModel: () => normalize(model),
      restore(value) {
        model = normalize(value);
        title.value = model.title;
        renderRows();
        persist();
      },
    };
  };
})();
