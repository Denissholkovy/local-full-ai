(function () {
  const ICONS = window.ICONS || {};
  const hljs = typeof hljsModule !== 'undefined' ? hljsModule.default : null;
  const vscode = acquireVsCodeApi();

  const messagesEl = document.getElementById('messages');
  const input = document.getElementById('input');
  const sendBtn = document.getElementById('sendBtn');
  const stopBtn = document.getElementById('stopBtn');
  const plusBtn = document.getElementById('plusBtn');
  const slashBtn = document.getElementById('slashBtn');
  const modeBtn = document.getElementById('modeBtn');
  const micBtn = document.getElementById('micBtn');
  const usageBtn = document.getElementById('usageBtn');
  const limitsBtn = document.getElementById('limitsBtn');
  let cloudLimits = null;
  const attachmentPreview = document.getElementById('attachmentPreview');
  const modelChip = document.getElementById('modelChip');
  const workspaceChip = document.getElementById('workspaceChip');
  const newChatBtn = document.getElementById('newChatBtn');
  const chatTitleBtn = document.getElementById('chatTitleBtn');
  const chatTitle = document.getElementById('chatTitle');
  const sessionMenu = document.getElementById('sessionMenu');
  let sessionsCache = [];
  let sessionQuery = '';

  const TICK = String.fromCharCode(96);
  const FENCE = TICK + TICK + TICK;
  const NEWLINE = String.fromCharCode(10);

  let currentBubble = null;
  let currentRaw = '';
  let pendingAttachments = [];
  let regenerateBtn = null;
  let lastGenStats = null;
  let currentModelName = '';
  let hideCode = false;
  let isGenerating = false;
  let usage = { main: { prompt: 0, output: 0 }, agents: [] };
  let skills = [];
  let slashMatches = [];
  let slashIndex = 0;
  let info = { modelName: null, workspaceName: null, agentEnabled: true, toolsUnsupported: false };
  const toolCards = {};
  let historyPending = [];

  function escapeHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function icon(name) {
    return ICONS[name] || '';
  }

  function post(message) {
    vscode.postMessage(message);
  }

  function isNearBottom() {
    return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80;
  }

  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function inlineMarkdown(text) {
    let out = escapeHtml(text);
    out = out.replace(/`([^`]+)`/g, '<code class="inline">$1</code>');
    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    return out;
  }

  function renderPlainSegment(segment) {
    const lines = segment.split(NEWLINE);
    let html = '';
    let paragraph = [];
    let listType = null;

    function flushParagraph() {
      if (paragraph.length) {
        html += '<p>' + paragraph.map(inlineMarkdown).join('<br>') + '</p>';
        paragraph = [];
      }
    }
    function closeList() {
      if (listType) {
        html += '</' + listType + '>';
        listType = null;
      }
    }

    lines.forEach((line) => {
      const heading = line.match(/^(#{1,4})\s+(.*)$/);
      const bullet = line.match(/^\s*[-*]\s+(.*)$/);
      const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);

      if (!line.trim()) {
        flushParagraph();
        closeList();
      } else if (heading) {
        flushParagraph();
        closeList();
        const level = Math.min(heading[1].length, 4);
        html += '<h' + level + '>' + inlineMarkdown(heading[2]) + '</h' + level + '>';
      } else if (bullet || numbered) {
        flushParagraph();
        const wanted = bullet ? 'ul' : 'ol';
        if (listType !== wanted) {
          closeList();
          html += '<' + wanted + '>';
          listType = wanted;
        }
        html += '<li>' + inlineMarkdown((bullet || numbered)[1]) + '</li>';
      } else {
        closeList();
        paragraph.push(line);
      }
    });
    flushParagraph();
    closeList();
    return html;
  }

  function splitThinking(raw) {
    let visible = raw.replace(/<think>[\s\S]*?<\/think>/g, '');
    const open = visible.indexOf('<think>');
    let thinking = false;
    if (open !== -1) {
      visible = visible.slice(0, open);
      thinking = true;
    }
    return { visible: visible.trim(), thinking };
  }

  // The streaming bubble is re-rendered on every token, which would restart a CSS animation at 0 degrees
  // each time (the spinner looks frozen). A negative delay keeps the rotation in step with the clock.
  function spinnerHtml() {
    return '<span class="spinner" style="animation-delay:-' + (Date.now() % 800) + 'ms"></span>';
  }

  function fileChip(label, busy) {
    return '<div class="file-chip-line">' + (busy ? spinnerHtml() : icon('fileText')) + '<span>' + escapeHtml(label) + '</span></div>';
  }

  let isStreaming = false;

  function renderFences(visible, hideCode) {
    const fenceRegex = new RegExp(FENCE + '(\\w*)\\n?([\\s\\S]*?)(?:' + FENCE + '|$)', 'g');
    let html = '';
    let lastIndex = 0;
    let match;

    while ((match = fenceRegex.exec(visible)) !== null) {
      const before = visible.slice(lastIndex, match.index);
      if (before) html += renderPlainSegment(before);
      const code = match[2] || '';
      if (hideCode && code.split(NEWLINE).length >= 5) {
        html += fileChip(isStreaming ? 'Writing code' + (match[1] ? ' (' + match[1] + ')' : '') + '...' : 'Code goes into a project file', isStreaming);
      } else {
        html += buildCodeBlock(match[1] || '', code);
      }
      lastIndex = fenceRegex.lastIndex;
    }
    const rest = visible.slice(lastIndex);
    if (rest) html += renderPlainSegment(rest);
    return html;
  }

  function renderMarkdown(raw, hideCode) {
    const { visible, thinking } = splitThinking(raw);
    let html = '';

    if (hideCode) {
      const callAt = visible.search(/\{\s*"name"\s*:\s*"(write_file|edit_file|read_file|list_files|search_text|run_command|delegate_task)"/);
      if (callAt !== -1) {
        const lead = visible.slice(0, callAt);
        const cleanLead = lead.replace(new RegExp(FENCE + '[\\w-]*\\s*$'), '');
        return (cleanLead.trim() ? renderFences(cleanLead, true) : '') + fileChip('Preparing the file changes...', isStreaming);
      }
      const fileTag = /<file\s+path=["']([^"']+)["']\s*>[\s\S]*?(<\/file>|$)/g;
      let last = 0;
      let m;
      while ((m = fileTag.exec(visible)) !== null) {
        const before = visible.slice(last, m.index);
        if (before) html += renderFences(before, true);
        html += fileChip((m[2] ? 'File: ' : 'Writing ') + m[1] + (m[2] ? '' : '...'), !m[2] && isStreaming);
        last = fileTag.lastIndex;
        if (m[0].length === 0) fileTag.lastIndex++;
      }
      const rest = visible.slice(last);
      if (rest) html += renderFences(rest, true);
    } else {
      html = renderFences(visible, false);
    }

    if (thinking && !html) html = '<span class="thinking-label">Thinking...</span>';
    return html;
  }

  function buildCodeBlock(lang, code) {
    const codeId = 'code_' + Math.random().toString(36).slice(2, 9);
    return (
      '<div class="code-block">' +
        '<div class="code-block-header">' +
          '<span>' + escapeHtml(lang || 'code') + '</span>' +
          '<span class="code-block-actions">' +
            '<button data-action="copy" data-target="' + codeId + '">' + icon('copy') + ' Copy</button>' +
            '<button data-action="insert" data-target="' + codeId + '">' + icon('insert') + ' Insert</button>' +
          '</span>' +
        '</div>' +
        '<pre><code id="' + codeId + '" data-lang="' + escapeHtml(lang || '') + '">' + escapeHtml(code) + '</code></pre>' +
      '</div>'
    );
  }

  function highlightCodeBlocks(container) {
    if (!hljs) return;
    container.querySelectorAll('pre code[data-lang]').forEach((el) => {
      const lang = el.getAttribute('data-lang');
      try {
        const result = lang && hljs.getLanguage(lang)
          ? hljs.highlight(el.textContent, { language: lang, ignoreIllegals: true })
          : hljs.highlightAuto(el.textContent);
        el.innerHTML = result.value;
        el.classList.add('hljs');
      } catch (_) {
      }
    });
  }

  function attachCodeBlockActions(container) {
    container.querySelectorAll('button[data-action]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const codeEl = document.getElementById(btn.getAttribute('data-target'));
        if (!codeEl) return;
        if (btn.getAttribute('data-action') === 'copy') {
          post({ type: 'copyToClipboard', text: codeEl.textContent });
          const original = btn.innerHTML;
          btn.innerHTML = icon('check') + ' Copied';
          setTimeout(() => (btn.innerHTML = original), 1500);
        } else {
          post({ type: 'insertAtCursor', text: codeEl.textContent });
        }
      });
    });
  }

  function stripCodeFences(raw) {
    return splitThinking(raw).visible
      .replace(new RegExp(FENCE + '[\\s\\S]*?' + FENCE, 'g'), '')
      .replace(new RegExp(FENCE + '[\\s\\S]*$', 'g'), '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function removeEmptyState() {
    const empty = messagesEl.querySelector('.empty-state');
    if (empty) empty.remove();
  }

  function renderEmptyState() {
    messagesEl.innerHTML = '';
    const hasProject = !!info.workspaceName;
    const suggestions = hasProject
      ? ['Create a simple calculator in index.html', 'Explain the structure of this project', 'Find possible bugs in the main files']
      : ['Explain how closures work in JavaScript', 'Write a function that debounces another function'];

    const intro = hasProject
      ? (!info.agentEnabled
        ? 'Project access is <b>off</b>, so I can only chat. Click the folder button above to let me create and edit files in <b>' + escapeHtml(info.workspaceName) + '</b>.'
        : info.toolsUnsupported && info.filesMode
        ? 'I work in <b>' + escapeHtml(info.workspaceName) + '</b>: code goes into files, the chat is for talking and corrections. This small model cannot read your project on its own, so name the files you want changed. A <b>tools</b> model (e.g. Qwen2.5 Coder 7B) does it better.'
        : info.toolsUnsupported
        ? 'The model <b>' + escapeHtml(info.modelName || '') + '</b> cannot use tools here. Pick a model tagged <b>tools</b> (e.g. Qwen2.5 Coder 7B) to work with <b>' + escapeHtml(info.workspaceName) + '</b>.'
        : 'I work in <b>' + escapeHtml(info.workspaceName) + '</b>: I create and edit files myself and ask before changes. The chat is for talking and corrections.')
      : 'Open a folder in VS Code and I can read, edit and run things in your project. For now I can only chat.';

    const wrap = document.createElement('div');
    wrap.className = 'empty-state';
    wrap.innerHTML = '<h2>What are we building?</h2><p>' + intro + '</p><div class="suggestions"></div>';
    const list = wrap.querySelector('.suggestions');
    suggestions.forEach((text) => {
      const btn = document.createElement('button');
      btn.className = 'suggestion';
      btn.textContent = text;
      btn.onclick = () => {
        input.value = text;
        autoResize();
        input.focus();
      };
      list.appendChild(btn);
    });
    messagesEl.appendChild(wrap);
  }

  function addRow(html, cls, rawText) {
    removeEmptyState();
    const row = document.createElement('div');
    row.className = 'row ' + cls;
    row.dataset.rawText = rawText || '';

    const col = document.createElement('div');
    col.className = 'message-col';

    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.innerHTML = html;
    col.appendChild(bubble);

    if (cls === 'user' || cls === 'assistant') {
      const actions = document.createElement('div');
      actions.className = 'msg-actions';
      actions.innerHTML = cls === 'user'
        ? '<button data-msg-action="edit" title="Edit">' + icon('pencil') + '</button>'
        : '<button data-msg-action="copy" title="Copy text">' + icon('copy') + '</button>';
      col.appendChild(actions);

      actions.querySelectorAll('button').forEach((btn) => {
        btn.addEventListener('click', () => {
          const text = row.dataset.rawText || '';
          if (btn.getAttribute('data-msg-action') === 'copy') {
            post({ type: 'copyToClipboard', text: stripCodeFences(text) });
            const original = btn.innerHTML;
            btn.innerHTML = icon('check');
            setTimeout(() => (btn.innerHTML = original), 1200);
          } else {
            input.value = text;
            autoResize();
            input.focus();
          }
        });
      });
    }

    row.appendChild(col);
    const wasNearBottom = isNearBottom();
    messagesEl.appendChild(row);
    if (wasNearBottom) scrollToBottom();
    attachCodeBlockActions(bubble);
    highlightCodeBlocks(bubble);
    return bubble;
  }

  function toolIcon(name) {
    switch (name) {
      case 'list_files': return icon('folder');
      case 'search_text': return icon('search');
      case 'run_command': return icon('terminal');
      case 'use_skill': return icon('bolt');
      case 'ask_user': return icon('chat');
      case 'delegate_task': return icon('agents');
      case 'edit_file':
      case 'write_file': return icon('pencil');
      default: return icon('fileText');
    }
  }

  function labelFor(name, args) {
    args = args || {};
    switch (name) {
      case 'list_files': return 'Listing ' + (args.pattern || args.path || '.');
      case 'read_file': return 'Reading ' + (args.path || '');
      case 'search_text': return 'Searching "' + (args.query || '') + '"';
      case 'edit_file': return 'Editing ' + (args.path || '');
      case 'write_file': return 'Updating ' + (args.path || '');
      case 'run_command': return 'Running ' + (args.command || '');
      case 'use_skill': return 'Skill ' + (args.name || '');
      case 'ask_user': return 'Question: ' + (args.question || '');
      case 'delegate_task': return 'Agent: ' + (args.title || 'helper');
      case 'update_plan': return 'Plan';
      case 'finish_task': return 'Finish task';
      default: return name;
    }
  }

  function addToolCard(id, name, label, filePath) {
    removeEmptyState();
    const row = document.createElement('div');
    row.className = 'row tool';
    const col = document.createElement('div');
    col.className = 'message-col';
    const card = document.createElement('div');
    card.className = 'tool-card';
    card.dataset.tool = name;
    card.dataset.path = filePath || '';

    let labelHtml = escapeHtml(label);
    if (filePath && label.endsWith(filePath)) {
      labelHtml = escapeHtml(label.slice(0, label.length - filePath.length)) +
        '<span class="file-link" data-path="' + escapeHtml(filePath) + '">' + escapeHtml(filePath) + '</span>';
    }

    card.innerHTML =
      '<div class="tool-head">' + toolIcon(name) +
        '<span class="tool-label">' + labelHtml + '</span>' +
        '<span class="tool-note"></span>' +
        '<span class="tool-status pending"><span class="spinner"></span></span>' +
      '</div>' +
      '<pre class="tool-output"></pre>';

    card.querySelector('.tool-head').addEventListener('click', (e) => {
      const link = e.target.closest('.file-link');
      if (link) {
        post({ type: 'openFile', path: link.getAttribute('data-path') });
        return;
      }
      card.classList.toggle('open');
    });

    col.appendChild(card);
    row.appendChild(col);
    const wasNearBottom = isNearBottom();
    messagesEl.appendChild(row);
    if (wasNearBottom) scrollToBottom();
    toolCards[id] = card;
    return card;
  }

  const PAST_TENSE = [
    ['Creating ', 'Created '], ['Updating ', 'Updated '], ['Editing ', 'Edited '], ['Reading ', 'Read '],
    ['Listing ', 'Listed '], ['Searching ', 'Searched '], ['Running ', 'Ran ']
  ];

  function finishToolCard(card, ok, denied, output, diff, diffMeta) {
    const labelEl = card.querySelector('.tool-label');
    if (ok && labelEl) {
      const node = labelEl.firstChild;
      if (node && node.nodeType === 3) {
        for (const pair of PAST_TENSE) {
          if (node.nodeValue.indexOf(pair[0]) === 0) {
            node.nodeValue = pair[1] + node.nodeValue.slice(pair[0].length);
            break;
          }
        }
      }
    }
    const status = card.querySelector('.tool-status');
    status.className = 'tool-status ' + (ok ? 'ok' : 'err');
    status.innerHTML = denied ? icon('shield') + ' Denied' : ok ? icon('check') : icon('warning');
    const out = card.querySelector('.tool-output');
    out.textContent = output || '';
    if (diff && diff.lines) {
      out.textContent = '';
      const stat = document.createElement('span');
      stat.className = 'diff-stat';
      stat.textContent = diff.isNew ? '+' + diff.added + ' new' : '+' + diff.added + ' -' + diff.removed;
      const label = card.querySelector('.tool-label');
      if (label) label.appendChild(stat);
      const VISIBLE = 24;
      diff.lines.forEach((line, index) => {
        const row = document.createElement('div');
        row.className = 'dl ' + (line.t === '+' ? 'add' : line.t === '-' ? 'del' : 'ctx') + (index >= VISIBLE ? ' extra' : '');
        row.textContent = (line.t === ' ' ? '  ' : line.t + ' ') + line.s;
        out.appendChild(row);
      });
      if (diff.lines.length <= 14) card.classList.add('open');

      const actions = document.createElement('div');
      actions.className = 'tool-actions';
      if (diff.lines.length > VISIBLE) {
        const more = document.createElement('button');
        more.textContent = 'Show all ' + diff.lines.length + ' lines';
        more.onclick = () => {
          const expanded = out.classList.toggle('expanded');
          more.textContent = expanded ? 'Show less' : 'Show all ' + diff.lines.length + ' lines';
        };
        actions.appendChild(more);
      }
      if (diffMeta && diffMeta.path) {
        const open = document.createElement('button');
        open.textContent = 'Open file';
        open.onclick = () => post({ type: 'openFile', path: diffMeta.path });
        actions.appendChild(open);
        if (diffMeta.hasBefore) {
          const cmp = document.createElement('button');
          cmp.textContent = 'Open diff';
          cmp.onclick = () => post({ type: 'openDiff', id: diffMeta.id });
          actions.appendChild(cmp);
        }
      }
      card.appendChild(actions);
    } else if (ok && card.dataset.path && (card.dataset.tool === 'write_file' || card.dataset.tool === 'edit_file')) {
      const actions = document.createElement('div');
      actions.className = 'tool-actions';
      const open = document.createElement('button');
      open.textContent = 'Open file';
      open.onclick = () => post({ type: 'openFile', path: card.dataset.path });
      actions.appendChild(open);
      card.appendChild(actions);
      card.classList.add('open');
    }
    if (card.dataset.tool === 'update_plan' && output) card.classList.add('open');
    if (!output) card.querySelector('.tool-head').style.cursor = 'default';
  }

  function buildDiff(preview) {
    const box = document.createElement('div');
    box.className = 'diff';
    const add = (cls, prefix, text) => {
      text.split(NEWLINE).forEach((line) => {
        const el = document.createElement('div');
        el.className = cls;
        el.textContent = prefix + line;
        box.appendChild(el);
      });
    };
    if (preview.kind === 'diff') {
      add('del', '- ', preview.removed);
      add('add', '+ ', preview.added);
    } else if (preview.kind === 'file') {
      add('add', '+ ', preview.head);
    } else if (preview.kind === 'command') {
      add('ctx', '$ ', preview.command);
    }
    return box;
  }

  const dialogDock = document.getElementById('dialogDock');
  let dialogQueue = [];
  let dialogActive = null;
  let dialogSelected = 0;

  function clearDialogs() {
    dialogQueue = [];
    dialogActive = null;
    renderDialog();
  }

  function enqueueDialog(msg) {
    if ((dialogActive && dialogActive.id === msg.id) || dialogQueue.some((d) => d.id === msg.id)) return;
    dialogQueue.push(msg);
    if (!dialogActive) nextDialog();
    else renderDialog();
  }

  function removeDialog(id) {
    dialogQueue = dialogQueue.filter((d) => d.id !== id);
    if (dialogActive && dialogActive.id === id) nextDialog();
    else renderDialog();
  }

  function nextDialog() {
    dialogActive = dialogQueue.shift() || null;
    dialogSelected = 0;
    renderDialog();
  }

  function dialogOptions(d) {
    if (d.type === 'toolQuestion') {
      return (d.options || []).map((label) => ({ label, decision: 'answer', extra: label }));
    }
    const isCommand = d.permission === 'command';
    return [
      { label: 'Yes', decision: 'allow' },
      { label: isCommand ? "Yes, and don't ask again for commands in this chat" : "Yes, and don't ask again for edits in this chat", decision: 'always' },
      { label: 'No', decision: 'deny' }
    ];
  }

  function answerDialog(option, typed) {
    const d = dialogActive;
    if (!d) return;
    const isQuestion = d.type === 'toolQuestion';
    let decision;
    let extra;
    if (typed) {
      decision = isQuestion ? 'answer' : 'deny';
      extra = typed;
    } else if (option) {
      decision = option.decision;
      extra = option.extra;
    } else {
      decision = isQuestion ? 'cancel' : 'deny';
    }
    post({ type: 'toolDecision', id: d.id, decision, extra });
    nextDialog();
  }

  function renderDialog() {
    if (!dialogActive) {
      dialogDock.innerHTML = '';
      dialogDock.style.display = 'none';
      return;
    }
    const d = dialogActive;
    const isQuestion = d.type === 'toolQuestion';
    const preview = d.preview || {};
    const options = dialogOptions(d);
    dialogSelected = Math.min(dialogSelected, Math.max(options.length - 1, 0));

    const title = isQuestion
      ? d.question
      : d.permission === 'command'
        ? 'Run this command?'
        : preview.kind === 'file' && !preview.exists
          ? 'Create this file?'
          : 'Apply this change?';

    dialogDock.style.display = 'block';
    dialogDock.innerHTML = '';
    const box = document.createElement('div');
    box.className = 'dialog';
    box.tabIndex = -1;

    const head = document.createElement('div');
    head.className = 'dialog-head';
    head.innerHTML = '<span class="dialog-icon">' + icon(isQuestion ? 'chat' : 'shield') + '</span>' +
      '<span class="dialog-title"></span>' +
      (dialogQueue.length ? '<span class="dialog-count">1 of ' + (dialogQueue.length + 1) + '</span>' : '');
    head.querySelector('.dialog-title').textContent = title;
    box.appendChild(head);

    if (!isQuestion) {
      const subtitle = document.createElement('div');
      subtitle.className = 'dialog-sub';
      subtitle.textContent = d.label || '';
      box.appendChild(subtitle);
      box.appendChild(buildDiff(preview));
    }

    const list = document.createElement('div');
    list.className = 'dialog-options';
    options.forEach((opt, i) => {
      const btn = document.createElement('button');
      btn.className = 'dialog-option' + (i === dialogSelected ? ' selected' : '');
      btn.innerHTML = '<span class="dialog-num">' + (i + 1) + '</span><span class="dialog-label"></span>';
      btn.querySelector('.dialog-label').textContent = opt.label;
      btn.addEventListener('click', () => answerDialog(opt));
      btn.addEventListener('mouseenter', () => {
        dialogSelected = i;
        list.querySelectorAll('.dialog-option').forEach((b, k) => b.classList.toggle('selected', k === i));
      });
      list.appendChild(btn);
    });
    box.appendChild(list);

    const field = document.createElement('input');
    field.type = 'text';
    field.className = 'dialog-input';
    field.placeholder = isQuestion ? 'Or type your own answer' : 'Tell the AI what to do instead';
    field.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        e.stopPropagation();
        const typed = field.value.trim();
        if (typed) answerDialog(null, typed);
        else if (options[dialogSelected]) answerDialog(options[dialogSelected]);
      }
    });
    box.appendChild(field);

    const hint = document.createElement('div');
    hint.className = 'dialog-hint';
    hint.textContent = (options.length ? '1-' + options.length + ' or Enter to choose' : 'Type an answer and press Enter') + '  \u00b7  Esc to cancel';
    box.appendChild(hint);

    dialogDock.appendChild(box);
    scrollToBottom();
    if (isQuestion && options.length === 0) field.focus();
    else box.focus({ preventScroll: true });
  }

  document.addEventListener('keydown', (e) => {
    if (!dialogActive) return;
    const typing = e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA');
    const options = dialogOptions(dialogActive);
    if (e.key === 'Escape') {
      e.preventDefault();
      answerDialog(null);
      return;
    }
    if (typing) return;
    if (/^[1-9]$/.test(e.key) && options[Number(e.key) - 1]) {
      e.preventDefault();
      answerDialog(options[Number(e.key) - 1]);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      dialogSelected = (dialogSelected + (e.key === 'ArrowDown' ? 1 : options.length - 1)) % Math.max(options.length, 1);
      renderDialog();
    } else if (e.key === 'Enter' && options[dialogSelected]) {
      e.preventDefault();
      answerDialog(options[dialogSelected]);
    }
  });

  function clearRegenerateButton() {
    if (regenerateBtn) {
      regenerateBtn.remove();
      regenerateBtn = null;
    }
  }

  function addRegenerateButton() {
    clearRegenerateButton();
    const rows = messagesEl.querySelectorAll('.row.assistant');
    const row = rows[rows.length - 1];
    if (!row) return;
    const actionsEl = row.querySelector('.msg-actions');
    if (!actionsEl) return;

    const btn = document.createElement('button');
    btn.title = 'Regenerate';
    btn.innerHTML = icon('refresh');
    btn.onclick = () => {
      if (isGenerating) return;
      while (messagesEl.lastElementChild && !messagesEl.lastElementChild.classList.contains('user')) {
        messagesEl.lastElementChild.remove();
      }
      regenerateBtn = null;
      setGeneratingUI(true);
      post({ type: 'regenerate' });
    };
    actionsEl.appendChild(btn);
    regenerateBtn = btn;
  }

  // A live "the AI is working" line at the very end of the chat, so it is clear that it has not stopped
  // even when it has already written something (between steps, while thinking, while a tool runs).
  let activityEl = null;
  let activityLabel = 'Thinking';
  let activitySince = 0;
  let activityTimer = null;
  let activityMoving = false;

  function activityText() {
    const seconds = Math.max(0, Math.floor((Date.now() - activitySince) / 1000));
    return activityLabel + (seconds >= 3 ? ' \u00b7 ' + seconds + 's' : '');
  }

  function setActivity(label) {
    activityLabel = label;
    if (activityEl) activityEl.querySelector('.activity-text').textContent = activityText();
  }

  function syncActivity() {
    const dock = document.getElementById('dialogDock');
    const waitingForUser = !!(dock && dock.children.length > 0);
    const dotsOnly = !!(currentBubble && currentBubble.querySelector('.typing-dot, .thinking-label') && !currentRaw);
    if (!isGenerating || waitingForUser || dotsOnly) {
      if (activityEl && activityEl.parentNode) activityEl.remove();
      return;
    }
    if (!activityEl) {
      activityEl = document.createElement('div');
      activityEl.className = 'activity';
      activityEl.innerHTML = '<span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span><span class="activity-text"></span>';
    }
    activityEl.querySelector('.activity-text').textContent = activityText();
    if (activityEl.parentNode !== messagesEl || activityEl.nextSibling) {
      const stick = isNearBottom();
      activityMoving = true;
      messagesEl.appendChild(activityEl);
      activityMoving = false;
      if (stick) scrollToBottom();
    }
  }

  new MutationObserver(() => {
    if (!activityMoving) syncActivity();
  }).observe(messagesEl, { childList: true });
  const dockEl = document.getElementById('dialogDock');
  if (dockEl) new MutationObserver(syncActivity).observe(dockEl, { childList: true });

  function setGeneratingUI(active) {
    if (active && !isGenerating) {
      activitySince = Date.now();
      activityLabel = 'Thinking';
      if (!activityTimer) activityTimer = setInterval(() => { if (activityEl) activityEl.querySelector('.activity-text').textContent = activityText(); }, 1000);
    }
    if (!active && activityTimer) {
      clearInterval(activityTimer);
      activityTimer = null;
    }
    isGenerating = active;
    sendBtn.style.display = active ? 'none' : 'flex';
    stopBtn.style.display = active ? 'flex' : 'none';
    syncActivity();
  }

  const slashMenu = document.createElement('div');
  slashMenu.id = 'slashMenu';
  slashMenu.style.display = 'none';
  document.getElementById('inputWrap').appendChild(slashMenu);

  function closeSlashMenu() {
    slashMatches = [];
    slashMenu.style.display = 'none';
  }

  function pickSlash(skill) {
    input.value = '/' + skill.name + ' ';
    closeSlashMenu();
    autoResize();
    input.focus();
  }

  function updateSlashMenu() {
    const m = input.value.match(/^\/([\w.-]*)$/);
    if (!m || skills.length === 0) return closeSlashMenu();
    const q = m[1].toLowerCase();
    slashMatches = skills.filter((sk) => sk.name.toLowerCase().indexOf(q) !== -1).slice(0, 8);
    if (slashMatches.length === 0) return closeSlashMenu();
    slashIndex = Math.min(slashIndex, slashMatches.length - 1);
    slashMenu.innerHTML = '';
    slashMatches.forEach((sk, i) => {
      const item = document.createElement('div');
      item.className = 'slash-item' + (i === slashIndex ? ' active' : '');
      const desc = sk.description.length > 80 ? sk.description.slice(0, 80) + '...' : sk.description;
      item.innerHTML = '<span class="slash-name">/' + escapeHtml(sk.name) + '</span><span class="slash-desc">' + escapeHtml(desc) + '</span>';
      item.onmousedown = (e) => {
        e.preventDefault();
        pickSlash(sk);
      };
      slashMenu.appendChild(item);
    });
    slashMenu.style.display = 'block';
  }

  function fmtTokens(n) {
    n = Number(n) || 0;
    return n < 1000 ? String(n) : (n / 1000).toFixed(n < 10000 ? 1 : 0) + 'k';
  }

  function usageTotals() {
    const main = usage.main.prompt + usage.main.output;
    const helpers = usage.agents.reduce((sum, a) => sum + a.prompt + a.output, 0);
    return { main, helpers, total: main + helpers };
  }

  function updateUsage() {
    const count = usage.agents.length;
    const total = usageTotals().total;
    if (count === 0 && total === 0) {
      usageBtn.style.display = 'none';
      return;
    }
    const running = usage.agents.some((a) => a.status === 'running');
    usageBtn.innerHTML = icon('agents') + '<span>' + count + (count === 1 ? ' agent' : ' agents') +
      ' &middot; ' + fmtTokens(total) + ' tok' + (running ? ' ...' : '') + '</span>';
    usageBtn.style.display = 'inline-flex';
  }

  function limitsFraction(item) {
    if (item.limit && item.remaining !== null && item.limit > 0) return item.remaining / item.limit;
    return null;
  }

  function shortLabel(label) {
    return label.replace('Requests per minute', 'req/min').replace('Requests per day', 'req/day').replace('Tokens per minute', 'tok/min').replace('Tokens per day', 'tok/day').replace('Requests', 'req').replace('Tokens', 'tok');
  }

  function updateLimits() {
    if (!info.cloudProvider) {
      limitsBtn.style.display = 'none';
      return;
    }
    limitsBtn.style.display = 'inline-flex';
    const items = (cloudLimits && cloudLimits.items) || [];
    const known = items.filter((i) => limitsFraction(i) !== null);
    if (known.length === 0) {
      limitsBtn.innerHTML = icon('shield') + '<span>limits: not reported</span>';
      limitsBtn.className = 'pill';
      return;
    }
    known.sort((a, b) => limitsFraction(a) - limitsFraction(b));
    const worst = known[0];
    const frac = limitsFraction(worst);
    limitsBtn.innerHTML = icon('shield') + '<span>' + fmtTokens(worst.remaining) + ' ' + escapeHtml(shortLabel(worst.label)) + ' left</span>';
    limitsBtn.className = 'pill' + (frac < 0.1 ? ' limit-low' : frac < 0.3 ? ' limit-mid' : '');
  }

  limitsBtn.addEventListener('click', () => {
    const items = [];
    const data = cloudLimits;
    const name = (data && data.provider) || info.cloudProvider || 'the provider';
    if (!data || data.items.length === 0) {
      items.push({ label: name + ' did not report limits yet', desc: 'Limits appear after the first answer. Some providers (for example Google Gemini) never send them: check the provider page.', disabled: true });
    } else {
      data.items.forEach((i) => {
        const left = i.remaining !== null ? fmtTokens(i.remaining) : '?';
        const total = i.limit !== null ? fmtTokens(i.limit) : '?';
        const pct = limitsFraction(i);
        items.push({
          label: i.label + ': ' + left + ' of ' + total + ' left' + (pct !== null ? ' (' + Math.round(pct * 100) + '%)' : ''),
          desc: i.reset ? 'resets in ' + i.reset : 'free-tier limit reported by ' + name,
          disabled: true
        });
      });
      if (data.retryAfter) items.push({ label: 'Last answer asked to wait ' + data.retryAfter, desc: 'The limit was reached', disabled: true });
      if (data.at) items.push({ label: 'Updated ' + new Date(data.at).toLocaleTimeString(), desc: 'after the last model answer', disabled: true });
    }
    if (info.cloudProvider) {
      items.push({
        label: 'Open ' + name + ' limits page',
        desc: 'Official numbers for your account',
        onClick: () => post({ type: 'openCloudLimits', providerId: (cloudLimits && cloudLimits.providerId) || '' })
      });
    }
    openMenu(limitsBtn, items);
  });

  usageBtn.addEventListener('click', () => {
    const totals = usageTotals();
    const items = [{
      label: 'Total: ' + fmtTokens(totals.total) + ' tokens in this chat',
      desc: 'Main agent ' + fmtTokens(totals.main) + ' / helpers ' + fmtTokens(totals.helpers) + '. Counts every request, including re-sent context.'
    }];
    if (usage.agents.length === 0) {
      items.push({ label: 'No helper agents in this chat yet', desc: 'The model starts them for bigger jobs. Ask it to use helper agents to try.', disabled: true });
    }
    usage.agents.forEach((a) => {
      const tok = a.prompt + a.output;
      items.push({
        label: a.title + ' (' + a.mode + ')',
        desc: a.status + ' / ' + a.steps + ' actions / ' + fmtTokens(tok) + ' tokens (in ' + fmtTokens(a.prompt) + ', out ' + fmtTokens(a.output) + ') / ' + a.model,
        checked: a.status === 'done'
      });
    });
    openMenu(usageBtn, items);
  });

  let micState = 'idle';

  function setMicState(state) {
    micState = state;
    micBtn.classList.toggle('recording', state === 'recording');
    micBtn.classList.toggle('busy', state === 'busy');
    micBtn.title = state === 'recording' ? 'Stop and transcribe' : state === 'busy' ? 'Transcribing...' : 'Voice input';
  }

  function showVoiceError(text, needsSetup) {
    let html = escapeHtml(text);
    if (needsSetup) {
      html += '<div style="margin-top:8px;"><button class="suggestion" id="voiceSetupBtn">' + icon('download') + ' Set up voice input</button></div>';
    }
    const bubble = addRow(html, 'error');
    const btn = bubble.querySelector('#voiceSetupBtn');
    if (btn) btn.onclick = () => post({ type: 'voiceSetup' });
  }

  micBtn.addEventListener('click', () => {
    if (micState !== 'busy') post({ type: 'voiceToggle' });
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && micState === 'recording') post({ type: 'voiceCancel' });
  });

  const MODES = [
    { id: 'ask', label: 'Ask before edits', desc: 'Every edit and command needs your approval' },
    { id: 'auto', label: 'Edit automatically', desc: 'Edits are applied right away, commands still ask' },
    { id: 'readonly', label: 'Read only', desc: 'The AI can look at files but changes nothing' },
    { id: 'autopilot', label: 'Autopilot', desc: 'Works on its own until the task is done. Edits and safe commands run without asking' }
  ];

  const popMenu = document.createElement('div');
  popMenu.id = 'popMenu';
  popMenu.style.display = 'none';
  document.body.appendChild(popMenu);

  function closeMenu() {
    popMenu.style.display = 'none';
  }

  function openMenu(anchor, items, alignRight) {
    popMenu.innerHTML = '';
    items.forEach((item) => {
      const el = document.createElement('div');
      el.className = 'pop-item' + (item.disabled ? ' disabled' : '');
      el.innerHTML = '<span class="pop-check">' + (item.checked ? icon('check') : '') + '</span>' +
        '<span class="pop-text"><span class="pop-label">' + escapeHtml(item.label) + '</span>' +
        (item.desc ? '<span class="pop-desc">' + escapeHtml(item.desc) + '</span>' : '') + '</span>';
      if (!item.disabled && item.onClick) {
        el.onclick = () => {
          closeMenu();
          item.onClick();
        };
      }
      popMenu.appendChild(el);
    });
    popMenu.style.display = 'block';
    const rect = anchor.getBoundingClientRect();
    popMenu.style.bottom = (window.innerHeight - rect.top + 6) + 'px';
    if (alignRight) {
      popMenu.style.left = 'auto';
      popMenu.style.right = Math.max(8, window.innerWidth - rect.right) + 'px';
    } else {
      popMenu.style.right = 'auto';
      popMenu.style.left = Math.max(8, rect.left) + 'px';
    }
    popMenu.dataset.anchor = anchor.id;
  }

  document.addEventListener('mousedown', (e) => {
    if (popMenu.style.display === 'none') return;
    if (!popMenu.contains(e.target) && e.target.id !== popMenu.dataset.anchor && !e.target.closest('#' + popMenu.dataset.anchor)) {
      closeMenu();
    }
  });

  function autoResize() {
    input.style.height = 'auto';
    input.style.height = Math.min(Math.max(input.scrollHeight, 38), 180) + 'px';
  }

  function renderAttachmentPreview() {
    if (pendingAttachments.length === 0) {
      attachmentPreview.classList.remove('has-items');
      attachmentPreview.innerHTML = '';
      return;
    }
    attachmentPreview.classList.add('has-items');
    attachmentPreview.innerHTML = pendingAttachments
      .map((att, idx) => {
        const thumb = att.kind === 'image' ? '<img src="' + att.dataUrl + '" />' : icon('fileText');
        const label = att.name + (att.truncated ? ' (truncated)' : '');
        return '<span class="attach-chip">' + thumb +
          '<span class="attach-name">' + escapeHtml(label) + '</span>' +
          '<button data-remove-idx="' + idx + '">' + icon('close') + '</button></span>';
      })
      .join('');

    attachmentPreview.querySelectorAll('button[data-remove-idx]').forEach((btn) => {
      btn.addEventListener('click', () => {
        pendingAttachments.splice(parseInt(btn.getAttribute('data-remove-idx'), 10), 1);
        renderAttachmentPreview();
      });
    });
  }

  function looksLikeCode(text) {
    const lines = text.split(NEWLINE);
    if (lines.length < 4 && text.length < 1500) return false;
    const hits = lines.filter((l) => /[{};]\s*$|=>|^\s{2,}\S|^\s*(function|def|class|import|from|const|let|var|return|if|for|while|#include|public|private)\b/.test(l)).length;
    return hits >= 2 || text.length > 3000;
  }

  input.addEventListener('paste', (e) => {
    const text = e.clipboardData && e.clipboardData.getData('text/plain');
    if (!text || !looksLikeCode(text)) return;
    e.preventDefault();
    let language = '';
    if (hljs) {
      try {
        language = hljs.highlightAuto(text.slice(0, 4000)).language || '';
      } catch (_) {
      }
    }
    const truncated = text.length > 12000;
    pendingAttachments.push({
      kind: 'text',
      name: 'Pasted ' + (language || 'code') + ' (' + text.split(NEWLINE).length + ' lines)',
      content: truncated ? text.slice(0, 12000) : text,
      language,
      truncated
    });
    renderAttachmentPreview();
  });

  function send() {
    if (isGenerating) return;
    const text = input.value.trim();
    if (!text && pendingAttachments.length === 0) return;

    post({
      type: 'send',
      text,
      attachments: pendingAttachments.map((att) => ({
        kind: att.kind,
        name: att.name,
        base64: att.base64,
        content: att.content,
        dataUrl: att.dataUrl,
        language: att.language,
        truncated: att.truncated
      }))
    });
    input.value = '';
    closeSlashMenu();
    pendingAttachments = [];
    renderAttachmentPreview();
    autoResize();
    setGeneratingUI(true);
  }

  function applyInfo() {
    if (info.modelName) {
      const isCloud = !!info.cloudProvider;
      const shown = isCloud ? info.modelName.split(':').slice(2).join(':') : info.modelName;
      modelChip.innerHTML = icon('box') + '<span>' + escapeHtml(shown) + '</span>' +
        (isCloud ? '<span class="cloud-pill">cloud</span>' : '');
      modelChip.className = 'pill' + (isCloud ? ' is-cloud' : '');
      modelChip.title = isCloud
        ? shown + ' - cloud model: your messages and the files it reads are sent to ' + info.cloudProvider + '. Click to change the model.'
        : info.modelName + ' - click to change the model';
    } else {
      modelChip.innerHTML = icon('warning') + '<span>Pick a model</span>';
      modelChip.className = 'pill warn';
      modelChip.title = 'No model selected';
    }
    modelChip.style.display = 'inline-flex';

    if (info.workspaceName && info.trusted === false) {
      workspaceChip.innerHTML = icon('folder') + '<span>' + escapeHtml(info.workspaceName) + ' - restricted mode</span>' + icon('warning');
      workspaceChip.className = 'chip warn';
      workspaceChip.title = 'This folder is not trusted (Restricted Mode), so the AI can only chat and cannot read, edit or run anything here. Click to manage workspace trust.';
      workspaceChip.style.display = 'inline-flex';
    } else if (info.workspaceName) {
      const off = !info.agentEnabled;
      const blocked = info.folderLevel === 'none';
      const filesOnly = info.toolsUnsupported && info.filesMode && !off;
      const levelNote = { none: ' - no access', read: ' - read only', ask: ' - ask first' }[info.folderLevel] || '';
      const note = off ? ' - access off' : filesOnly ? ' - saves to files' : levelNote;
      const trailing = blocked || (info.toolsUnsupported && !info.filesMode && !off) ? icon('warning') : off ? icon('eyeOff') : icon('eye');
      workspaceChip.innerHTML = icon('folder') + '<span>' + escapeHtml(info.workspaceName) + note + '</span>' + trailing;
      workspaceChip.className = 'chip ' + (blocked || (info.toolsUnsupported && !info.filesMode && !off) ? 'warn' : off ? 'off' : 'on');
      workspaceChip.title = off
        ? 'Project access is off, so the AI can only chat. Click to turn it on and let it create and edit files in this folder.'
        : filesOnly
          ? 'This model cannot use tools. It still saves code into files in this folder instead of pasting it in the chat, but it cannot read your project on its own. Click to turn access off.'
          : info.toolsUnsupported
            ? 'This model cannot use tools. Pick a model tagged "tools" to work with your project.'
            : 'The AI can read and edit files in this folder (it asks before changes). Click to turn off.';
      workspaceChip.style.display = 'inline-flex';
    } else {
      workspaceChip.innerHTML = icon('folder') + '<span>Open folder</span>';
      workspaceChip.className = 'chip off';
      workspaceChip.title = 'Open a project folder so the AI can read and edit your files';
      workspaceChip.style.display = 'inline-flex';
    }

    const mode = MODES.find((m) => m.id === info.permissionMode) || MODES[0];
    modeBtn.innerHTML = icon('code') + '<span>' + mode.label + '</span>';
    modeBtn.style.display = info.workspaceName ? 'inline-flex' : 'none';

    if (!messagesEl.children.length || messagesEl.querySelector('.empty-state')) renderEmptyState();
  }

  function relativeTime(ts) {
    const diff = Date.now() - ts;
    const min = Math.round(diff / 60000);
    if (min < 1) return 'now';
    if (min < 60) return min + ' min';
    const hours = Math.round(min / 60);
    if (hours < 24) return hours + ' h';
    const days = Math.round(hours / 24);
    return days + (days === 1 ? ' day' : ' days');
  }

  function renderSessions(sessions) {
    sessionsCache = sessions || [];
    const current = sessionsCache.find((x) => x.isCurrent);
    const othersRunning = sessionsCache.some((x) => !x.isCurrent && x.running);
    chatTitle.textContent = (current && current.title) || 'New chat';
    chatTitleBtn.classList.toggle('busy', !!(current && current.running));
    chatTitleBtn.classList.toggle('others-busy', !(current && current.running) && othersRunning);
    if (sessionMenu.style.display !== 'none') renderSessionMenu();
  }

  function renderSessionMenu() {
    const keepSearch = document.activeElement && document.activeElement.id === 'sessionSearch';
    const q = sessionQuery.trim().toLowerCase();
    const list = sessionsCache
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .filter((x) => !q || (x.title || '').toLowerCase().indexOf(q) !== -1);

    sessionMenu.innerHTML =
      (sessionsCache.length > 5
        ? '<input id="sessionSearch" type="text" placeholder="Search chats..." value="' + escapeHtml(sessionQuery) + '" />'
        : '') +
      '<div class="session-list"></div>';
    const holder = sessionMenu.querySelector('.session-list');

    if (list.length === 0) {
      holder.innerHTML = '<div class="session-empty">No chats found</div>';
    }
    list.forEach((sess) => {
      const item = document.createElement('div');
      item.className = 'session-row' + (sess.isCurrent ? ' current' : '');
      item.innerHTML =
        '<span class="session-state">' + (sess.running ? spinnerHtml() : sess.isCurrent ? icon('check') : '') + '</span>' +
        '<span class="session-name">' + escapeHtml(sess.title || 'New chat') + '</span>' +
        '<span class="session-time">' + relativeTime(sess.updatedAt) + '</span>' +
        '<button class="session-del" title="Delete chat">' + icon('trash') + '</button>';
      item.addEventListener('click', (e) => {
        if (e.target.closest('.session-del')) return;
        closeSessionMenu();
        if (!sess.isCurrent) post({ type: 'switchSession', id: sess.id });
      });
      const del = item.querySelector('.session-del');
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        if (del.classList.contains('confirm')) {
          post({ type: 'deleteSession', id: sess.id });
          return;
        }
        del.classList.add('confirm');
        del.title = 'Click again to delete';
        setTimeout(() => del.classList.remove('confirm'), 2500);
      });
      holder.appendChild(item);
    });

    const search = sessionMenu.querySelector('#sessionSearch');
    if (search) {
      search.addEventListener('input', () => {
        sessionQuery = search.value;
        renderSessionMenu();
      });
      if (keepSearch) {
        search.focus();
        search.setSelectionRange(search.value.length, search.value.length);
      }
    }
  }

  function openSessionMenu() {
    sessionQuery = '';
    sessionMenu.style.display = 'flex';
    renderSessionMenu();
    post({ type: 'listSessions' });
  }

  function closeSessionMenu() {
    sessionMenu.style.display = 'none';
  }

  chatTitleBtn.addEventListener('click', () => {
    if (sessionMenu.style.display === 'none') openSessionMenu();
    else closeSessionMenu();
  });
  document.addEventListener('mousedown', (e) => {
    if (sessionMenu.style.display === 'none') return;
    if (!sessionMenu.contains(e.target) && !chatTitleBtn.contains(e.target)) closeSessionMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeSessionMenu();
  });

  function userHtml(text, includedActiveFile, attachments) {
    let html = '';
    if (includedActiveFile) {
      html += '<div class="msg-attachment"><span class="file-chip">' + icon('fileText') + ' active file included</span></div>';
    }
    (attachments || []).forEach((att) => {
      if (att.kind === 'image') {
        html += '<div class="msg-attachment"><img src="' + att.dataUrl + '" /></div>';
      } else {
        html += '<div class="msg-attachment">' + buildCodeBlock(att.language || '', att.content || '') + '</div>';
      }
    });
    if (text) html += escapeHtml(text).replace(/\n/g, '<br>');
    return html;
  }

  function renderLoadedHistory(history, running) {
    messagesEl.innerHTML = '';
    currentBubble = null;
    currentRaw = '';
    regenerateBtn = null;
    Object.keys(toolCards).forEach((k) => delete toolCards[k]);

    const queue = [];
    (history || []).forEach((m) => {
      if (m.role === 'user') {
        if (m.synthetic) return;
        if (m.display) {
          const attachments = (m.display.attachments || []).slice();
          (m.images || []).forEach((b64) => attachments.push({ kind: 'image', dataUrl: 'data:image/png;base64,' + b64 }));
          addRow(userHtml(m.display.text, m.display.includedActiveFile, attachments), 'user', m.display.text || '');
        } else {
          addRow(renderMarkdown(m.content || ''), 'user', m.content || '');
        }
      } else if (m.role === 'assistant') {
        if (m.content && splitThinking(m.content).visible) {
          addRow(renderMarkdown(m.content), 'assistant', m.content);
        }
        (m.tool_calls || []).forEach((call, i) => {
          const fn = call.function || {};
          let args = fn.arguments;
          if (typeof args === 'string') {
            try { args = JSON.parse(args); } catch (_) { args = {}; }
          }
          const card = addToolCard('h' + messagesEl.children.length + '_' + i, fn.name, labelFor(fn.name, args), args && args.path);
          queue.push(card);
        });
      } else if (m.role === 'step') {
        const label = (m.diff && m.diff.isNew ? 'Creating ' : 'Updating ') + m.path;
        const card = addToolCard('s' + messagesEl.children.length, 'write_file', label, m.path);
        finishToolCard(card, m.ok, m.denied, m.output || '', m.diff, m.diff ? { path: m.path, hasBefore: false } : null);
      } else if (m.role === 'notice') {
        addRow(escapeHtml(m.content || ''), 'notice');
      } else if (m.role === 'tool') {
        const card = queue.shift();
        if (card) {
          const denied = (m.content || '').indexOf('Permission denied') === 0;
          const failed = denied || (m.content || '').indexOf('Error:') === 0;
          finishToolCard(card, !failed, denied, m.content || '', m.diff, m.diff && m.meta && m.meta.path ? { path: m.meta.path, hasBefore: false } : null);
        }
      }
    });
    historyPending = running ? queue : [];
    if (!running) queue.forEach((card) => finishToolCard(card, false, false, 'No result'));

    if (messagesEl.children.length === 0) {
      renderEmptyState();
    } else if (!running) {
      addRegenerateButton();
    }
    scrollToBottom();
  }

  newChatBtn.addEventListener('click', () => {
    closeSessionMenu();
    post({ type: 'newChat' });
  });

  modelChip.addEventListener('click', () => post({ type: 'pickModel' }));
  workspaceChip.addEventListener('click', () => post({ type: !info.workspaceName ? 'openFolder' : info.trusted === false ? 'manageTrust' : 'toggleAgent' }));
  plusBtn.addEventListener('click', () => {
    openMenu(plusBtn, [
      { label: 'Attach a file', desc: 'Text or code file as context', onClick: () => post({ type: 'attachFile', kind: 'text' }) },
      {
        label: 'Attach an image',
        desc: info.supportsVision ? 'Picture for the vision model' : (info.cloudProvider ? 'This cloud model is text-only (try Llama 4 Scout or Gemini)' : 'Needs a vision model (e.g. gemma3)'),
        disabled: !info.supportsVision,
        onClick: () => post({ type: 'attachFile', kind: 'image' })
      },
      {
        label: 'Git changes',
        desc: 'Everything not committed yet, as a diff',
        onClick: () => post({ type: 'attachContext', kind: 'git' })
      },
      {
        label: 'Problems',
        desc: 'Errors and warnings from the Problems panel',
        onClick: () => post({ type: 'attachContext', kind: 'problems' })
      }
    ]);
  });
  slashBtn.addEventListener('click', () => {
    if (skills.length === 0) {
      openMenu(slashBtn, [{ label: 'No skills found', desc: 'Put skills in ~/.claude/skills or .claude/skills', disabled: true }]);
      return;
    }
    input.value = '/';
    input.focus();
    slashIndex = 0;
    updateSlashMenu();
  });
  modeBtn.addEventListener('click', () => {
    openMenu(modeBtn, MODES.map((m) => ({
      label: m.label,
      desc: m.desc,
      checked: m.id === info.permissionMode,
      onClick: () => post({ type: 'setPermissionMode', mode: m.id })
    })), true);
  });
  stopBtn.addEventListener('click', () => post({ type: 'stopGeneration' }));
  sendBtn.addEventListener('click', send);
  input.addEventListener('input', () => {
    autoResize();
    slashIndex = 0;
    updateSlashMenu();
  });
  input.addEventListener('keydown', (e) => {
    if (slashMatches.length > 0) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        slashIndex = (slashIndex + (e.key === 'ArrowDown' ? 1 : slashMatches.length - 1)) % slashMatches.length;
        updateSlashMenu();
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        pickSlash(slashMatches[slashIndex]);
        return;
      }
      if (e.key === 'Escape') {
        closeSlashMenu();
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });

  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'seed':
        input.value = msg.text;
        autoResize();
        input.focus();
        break;
      case 'userMessage': {
        clearRegenerateButton();
        addRow(userHtml(msg.text, msg.includedActiveFile, msg.attachments), 'user', msg.text || '');
        setGeneratingUI(true);
        break;
      }
      case 'assistantStart':
        hideCode = !!msg.hideCode;
        currentModelName = msg.modelName || currentModelName;
        clearRegenerateButton();
        currentRaw = '';
        currentBubble = addRow('<span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>', 'assistant');
        setGeneratingUI(true);
        setActivity('Thinking');
        break;
      case 'assistantReplace':
        if (currentBubble) {
          currentRaw = msg.text || '';
          currentBubble.innerHTML = currentRaw ? renderMarkdown(currentRaw, false) : '';
          currentBubble.closest('.row').dataset.rawText = currentRaw;
        }
        break;
      case 'assistantDiscard':
        if (currentBubble) {
          const row = currentBubble.closest('.row');
          if (row) row.remove();
          currentBubble = null;
          currentRaw = '';
        }
        syncActivity();
        break;
      case 'toolProgress': {
        const card = toolCards[msg.id];
        if (card) {
          const note = card.querySelector('.tool-note');
          if (note) note.textContent = msg.text;
          const out = card.querySelector('.tool-output');
          out.textContent += msg.text + '\n';
        }
        break;
      }
      case 'cloudLimits':
        cloudLimits = msg;
        updateLimits();
        break;
      case 'usage':
        usage = msg.usage || usage;
        updateUsage();
        break;
      case 'voiceState':
        setMicState(msg.state);
        break;
      case 'voiceResult':
        if (!msg.text) addRow('Did not catch any speech. Try again a bit closer to the microphone.', 'notice');
        if (msg.text) {
          input.value = (input.value ? input.value.replace(/\s+$/, '') + ' ' : '') + msg.text;
          autoResize();
        }
        input.focus();
        break;
      case 'voiceError':
        showVoiceError(msg.text, msg.setup);
        break;
      case 'assistantThinking':
        if (currentBubble && !currentRaw) {
          currentBubble.innerHTML = '<span class="thinking-label">Thinking...</span>';
        }
        break;
      case 'assistantToken':
        if (activityLabel !== 'Writing') {
          activityLabel = 'Writing';
          setTimeout(syncActivity, 0);
        }
        if (currentBubble) {
          const wasNearBottom = isNearBottom();
          currentRaw += msg.text;
          isStreaming = true;
          currentBubble.innerHTML = renderMarkdown(currentRaw, hideCode);
          isStreaming = false;
          currentBubble.closest('.row').dataset.rawText = currentRaw;
          attachCodeBlockActions(currentBubble);
          highlightCodeBlocks(currentBubble);
          if (wasNearBottom) scrollToBottom();
        }
        break;
      case 'assistantEnd':
        if (currentBubble) {
          const row = currentBubble.closest('.row');
          if (!splitThinking(currentRaw).visible) {
            row.remove();
          } else {
            row.dataset.rawText = currentRaw;
            if (lastGenStats) {
              const statsEl = document.createElement('div');
              statsEl.className = 'gen-stats';
              statsEl.textContent = (currentModelName ? currentModelName + ' \u00b7 ' : '') + lastGenStats.tokensPerSec.toFixed(1) + ' tok/s';
              row.querySelector('.message-col').appendChild(statsEl);
            }
          }
        }
        lastGenStats = null;
        currentBubble = null;
        currentRaw = '';
        setActivity('Thinking');
        syncActivity();
        break;
      case 'replyDone':
        currentBubble = null;
        setGeneratingUI(false);
        addRegenerateButton();
        break;
      case 'toolStart':
        setActivity('Working on your project');
        if (historyPending.length > 0) {
          toolCards[msg.id] = historyPending.shift();
        } else {
          addToolCard(msg.id, msg.name, msg.label, msg.path);
        }
        break;
      case 'toolPermission':
      case 'toolQuestion':
        enqueueDialog(msg);
        break;
      case 'toolResult':
        setActivity('Thinking');
        removeDialog(msg.id);
        if (toolCards[msg.id]) finishToolCard(toolCards[msg.id], msg.ok, msg.denied, msg.output, msg.diff, msg.diffMeta);
        break;
      case 'error': {
        let html = escapeHtml(msg.text);
        if (msg.showStartServer) {
          html += '<div style="margin-top:8px;"><button id="startServerBtn" class="suggestion">' + icon('play') + ' Start Ollama server</button></div>';
        }
        if (msg.fallbacks && msg.fallbacks.length) {
          html += '<div class="fallbacks"><div class="fallbacks-title">Try another model:</div>' +
            msg.fallbacks.map((f, i) => '<button class="suggestion fallback-btn" data-i="' + i + '" title="' + escapeHtml(f.provider || '') + '">' + escapeHtml(f.label) + ' <span class="fb-prov">' + escapeHtml(f.provider || '') + '</span></button>').join('') + '</div>';
        }
        const errBubble = addRow(html, 'error');
        errBubble.querySelectorAll('.fallback-btn').forEach((b) => {
          b.onclick = () => {
            const f = msg.fallbacks[Number(b.getAttribute('data-i'))];
            errBubble.querySelectorAll('.fallback-btn').forEach((x) => { x.disabled = true; });
            post({ type: 'switchModelAndRetry', model: f.name });
          };
        });
        const btn = errBubble.querySelector('#startServerBtn');
        if (btn) {
          btn.onclick = () => {
            btn.disabled = true;
            btn.textContent = 'Starting...';
            post({ type: 'startOllamaServer' });
          };
        }
        if (!currentBubble) setGeneratingUI(false);
        break;
      }
      case 'changesSummary': {
        const old = document.getElementById('changesBar');
        if (old) old.remove();
        if (!msg.files || !msg.files.length) break;
        const bar = document.createElement('div');
        bar.id = 'changesBar';
        bar.className = 'changes-bar';
        const created = msg.files.filter((f) => f.isNew).length;
        bar.innerHTML = '<span>' + msg.files.length + ' file' + (msg.files.length > 1 ? 's' : '') + ' changed' + (created ? ' (' + created + ' new)' : '') + '</span>' +
          '<button class="suggestion" id="undoChanges">Undo all changes</button>';
        bar.title = msg.files.map((f) => f.rel).join('\n');
        messagesEl.appendChild(bar);
        bar.querySelector('#undoChanges').onclick = () => post({ type: 'revertChanges' });
        scrollToBottom();
        break;
      }
      case 'serverStartResult':
        addRow(escapeHtml(msg.text), msg.ok ? 'assistant' : 'error');
        break;
      case 'fileAttached':
        pendingAttachments.push(msg);
        renderAttachmentPreview();
        break;
      case 'modelInfo':
        info = msg;
        cloudLimits = msg.cloudLimits || null;
        updateLimits();
        skills = msg.skills || [];
        applyInfo();
        break;
      case 'generationStats':
        lastGenStats = msg.stats;
        break;
      case 'contextTrimmed':
      case 'notice':
        addRow(escapeHtml(msg.text), 'notice');
        break;
      case 'sessionsList':
        renderSessions(msg.sessions);
        break;
      case 'loadHistory':
        clearDialogs();
        renderLoadedHistory(msg.history, msg.running);
        setGeneratingUI(!!msg.running);
        break;
    }
  });

  renderEmptyState();
  post({ type: 'ready' });
})();
