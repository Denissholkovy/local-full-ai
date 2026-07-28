const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { ICONS } = require('./icons');
const { isVisionModel } = require('./modelCapabilities');
const ollamaProcess = require('./ollamaProcess');

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
const TEXT_FILE_EXTENSIONS = [
  'txt', 'md', 'js', 'ts', 'py', 'json', 'html', 'css', 'java', 'go', 'rs', 'c', 'cpp', 'log'
];
const MAX_TEXT_FILE_CHARS = 12000;

const LANGUAGE_BY_EXTENSION = {
  '.js': 'javascript',
  '.ts': 'typescript',
  '.py': 'python',
  '.json': 'json',
  '.html': 'html',
  '.css': 'css',
  '.java': 'java',
  '.go': 'go',
  '.rs': 'rust',
  '.c': 'c',
  '.cpp': 'cpp',
  '.md': 'markdown',
  '.txt': '',
  '.log': ''
};

class ChatPanel {
  static currentPanel;

  static createOrShow(context, ollamaClient) {
    if (ChatPanel.currentPanel) {
      ChatPanel.currentPanel._panel.reveal(vscode.ViewColumn.Beside);
      return ChatPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      'localAIChat',
      'Local Full AI Chat',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );

    ChatPanel.currentPanel = new ChatPanel(panel, context, ollamaClient);
    return ChatPanel.currentPanel;
  }

  constructor(panel, context, ollamaClient) {
    this._panel = panel;
    this._context = context;
    this._ollamaClient = ollamaClient;
    this._history = [];
    this._currentAbort = null;

    this._panel.webview.html = this._getHtml();

    this._panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === 'send') {
        await this._handleUserMessage(msg.text, msg.attachment);
      } else if (msg.type === 'copyToClipboard') {
        await vscode.env.clipboard.writeText(msg.text);
      } else if (msg.type === 'insertAtCursor') {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
          editor.edit((editBuilder) => {
            editBuilder.insert(editor.selection.active, msg.text);
          });
        }
      } else if (msg.type === 'attachFile') {
        await this._handleAttachFile(msg.kind);
      } else if (msg.type === 'stopGeneration') {
        if (this._currentAbort) this._currentAbort();
      } else if (msg.type === 'ready') {
        this._sendModelInfo();
      } else if (msg.type === 'startOllamaServer') {
        await this._startOllamaServer();
      } else if (msg.type === 'clearChat') {
        this._history = [];
        if (this._currentAbort) this._currentAbort();
      }
    });

    this._panel.onDidDispose(() => {
      ChatPanel.currentPanel = undefined;
    });
  }

  async _startOllamaServer() {
    const result = ollamaProcess.startServer();

    if (!result.started && result.reason === 'already-running') {
      this._panel.webview.postMessage({
        type: 'serverStartResult',
        ok: true,
        text: 'Ollama is already running - try sending your message again.'
      });
      return;
    }

    if (!result.started) {
      this._panel.webview.postMessage({
        type: 'serverStartResult',
        ok: false,
        text: `Could not start Ollama: ${result.reason}`
      });
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 1500));
    this._panel.webview.postMessage({
      type: 'serverStartResult',
      ok: true,
      text: 'Ollama server started - try sending your message again.'
    });
  }

  _sendModelInfo() {
    const modelName = this._context.globalState.get('localAI.selectedModel') || null;
    this._panel.webview.postMessage({
      type: 'modelInfo',
      modelName,
      supportsVision: isVisionModel(modelName)
    });
  }

  async _handleAttachFile(kind) {
    const modelName = this._context.globalState.get('localAI.selectedModel');
    const supportsVision = isVisionModel(modelName);

    if (kind === 'image' && !supportsVision) {
      vscode.window.showWarningMessage(
        `The model "${modelName}" does not support image understanding. Pick a vision model (e.g. llava) to attach pictures.`
      );
      return;
    }

    const extensions = kind === 'image'
      ? ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']
      : TEXT_FILE_EXTENSIONS;

    const uris = await vscode.window.showOpenDialog({
      canSelectMany: false,
      openLabel: 'Attach',
      filters: {
        [kind === 'image' ? 'Images' : 'Text files']: extensions
      }
    });
    if (!uris || uris.length === 0) return;

    const filePath = uris[0].fsPath;
    const fileName = path.basename(filePath);
    const ext = path.extname(filePath).toLowerCase();

    try {
      if (IMAGE_EXTENSIONS.has(ext)) {
        const buffer = fs.readFileSync(filePath);
        const base64 = buffer.toString('base64');
        const mime = ext === '.jpg' ? 'jpeg' : ext.slice(1);
        this._panel.webview.postMessage({
          type: 'fileAttached',
          kind: 'image',
          name: fileName,
          base64,
          dataUrl: `data:image/${mime};base64,${base64}`
        });
      } else {
        let content = fs.readFileSync(filePath, 'utf8');
        let truncated = false;
        if (content.length > MAX_TEXT_FILE_CHARS) {
          content = content.slice(0, MAX_TEXT_FILE_CHARS);
          truncated = true;
        }
        this._panel.webview.postMessage({
          type: 'fileAttached',
          kind: 'text',
          name: fileName,
          content,
          truncated,
          language: LANGUAGE_BY_EXTENSION[ext] || ''
        });
      }
    } catch (err) {
      this._panel.webview.postMessage({
        type: 'error',
        text: `Could not read the file: ${err.message}`
      });
    }
  }

  seedMessage(text) {
    this._panel.webview.postMessage({ type: 'seed', text });
  }

  async _handleUserMessage(text, attachment) {
    const modelName = this._context.globalState.get('localAI.selectedModel');
    if (!modelName) {
      this._panel.webview.postMessage({
        type: 'error',
        text: 'Pick a model in the Local Full AI sidebar first.'
      });
      return;
    }

    const userMessage = { role: 'user', content: text };

    if (attachment && attachment.kind === 'text') {
      const lang = attachment.language || '';
      userMessage.content =
        `File: ${attachment.name}\n\`\`\`${lang}\n${attachment.content}\n\`\`\`\n\n${text}`;
    } else if (attachment && attachment.kind === 'image') {
      userMessage.images = [attachment.base64];
    }

    this._history.push(userMessage);
    this._panel.webview.postMessage({
      type: 'userMessage',
      text,
      attachment: attachment
        ? {
            kind: attachment.kind,
            name: attachment.name,
            dataUrl: attachment.dataUrl,
            content: attachment.content,
            language: attachment.language,
            truncated: attachment.truncated
          }
        : null
    });
    this._panel.webview.postMessage({
      type: 'assistantStart',
      modelName,
      supportsVision: isVisionModel(modelName)
    });

    try {
      const fullReply = await this._ollamaClient.chatStream(
        modelName,
        this._history,
        (token) => {
          this._panel.webview.postMessage({ type: 'assistantToken', text: token });
        },
        (abortFn) => {
          this._currentAbort = abortFn;
        }
      );
      this._currentAbort = null;
      this._history.push({ role: 'assistant', content: fullReply });
      this._panel.webview.postMessage({ type: 'assistantEnd' });
    } catch (err) {
      this._currentAbort = null;
      const isConnRefused = err.code === 'ECONNREFUSED' || /ECONNREFUSED/.test(err.message);
      this._panel.webview.postMessage({
        type: 'error',
        text: isConnRefused
          ? "Could not reach Ollama - the server isn't running."
          : `Error: ${err.message}`,
        showStartServer: isConnRefused
      });
    }
  }

  _getHtml() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<style>
  * { box-sizing: border-box; }
  html, body {
    height: 100%;
    margin: 0;
  }
  body {
    font-family: var(--vscode-font-family);
    color: var(--vscode-editor-foreground);
    background: var(--vscode-editor-background);
    display: flex;
    flex-direction: column;
    height: 100vh;
    overflow: hidden;
  }

  #header {
    padding: 10px 16px;
    border-bottom: 1px solid var(--vscode-widget-border);
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 12px;
    opacity: 0.85;
    flex-shrink: 0;
  }
  #header .title {
    font-weight: 600;
    font-size: 13px;
    opacity: 1;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  #modelBadge {
    padding: 2px 8px;
    border-radius: 10px;
    background: var(--vscode-badge-background, #4caf50);
    color: var(--vscode-badge-foreground, white);
    font-size: 11px;
  }
  #headerRight {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  #clearChatBtn {
    background: transparent;
    border: none;
    color: var(--vscode-descriptionForeground);
    cursor: pointer;
    padding: 3px 5px;
    border-radius: 4px;
    display: flex;
    align-items: center;
  }
  #clearChatBtn:hover {
    background: rgba(244,71,71,0.15);
    color: var(--vscode-errorForeground);
  }
  #clearChatBtn.confirming {
    background: var(--vscode-errorForeground);
    color: white;
  }

  #messages {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .row {
    display: flex;
    width: 100%;
    min-width: 0;
  }
  .row.user { justify-content: flex-end; }
  .row.assistant { justify-content: flex-start; }

  .message-col {
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-width: 88%;
    min-width: 0;
  }
  .row.user .message-col { align-items: flex-end; }
  .row.assistant .message-col { align-items: flex-start; }

  .msg-actions {
    display: flex;
    gap: 4px;
    opacity: 0;
    transition: opacity 0.12s ease;
    padding: 0 2px;
  }
  .row:hover .msg-actions { opacity: 1; }
  .msg-actions button {
    background: transparent;
    border: 1px solid var(--vscode-widget-border);
    color: var(--vscode-descriptionForeground);
    cursor: pointer;
    padding: 3px 6px;
    border-radius: 4px;
    display: flex;
    align-items: center;
  }
  .msg-actions button:hover {
    background: rgba(127,127,127,0.2);
    color: var(--vscode-editor-foreground);
  }

  .bubble {
    padding: 10px 14px;
    border-radius: 12px;
    line-height: 1.55;
    font-size: 13.5px;
    word-wrap: break-word;
    overflow-wrap: anywhere;
    min-width: 0;
    max-width: 100%;
  }
  .row.user .bubble {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border-bottom-right-radius: 3px;
  }
  .row.assistant .bubble {
    background: var(--vscode-editorWidget-background);
    color: var(--vscode-editor-foreground);
    border: 1px solid var(--vscode-widget-border);
    border-bottom-left-radius: 3px;
  }
  .row.error .bubble {
    background: rgba(244, 71, 71, 0.12);
    border: 1px solid var(--vscode-errorForeground);
    color: var(--vscode-errorForeground);
  }

  .bubble p { margin: 0 0 8px 0; }
  .bubble p:last-child { margin-bottom: 0; }
  .bubble code.inline {
    background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.2));
    color: var(--vscode-editor-foreground);
    padding: 1px 5px;
    border-radius: 4px;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.92em;
  }

  .code-block {
    margin: 8px 0;
    border-radius: 8px;
    overflow: hidden;
    max-width: 100%;
    min-width: 0;
    border: 1px solid var(--vscode-widget-border);
    box-shadow: 0 1px 3px rgba(0,0,0,0.25);
    background: var(--vscode-editor-background);
    color: var(--vscode-editor-foreground);
  }
  .code-block-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 4px 10px;
    font-size: 11px;
    background: rgba(127,127,127,0.15);
    color: var(--vscode-descriptionForeground);
  }
  .code-block-actions {
    display: flex;
    gap: 4px;
  }
  .code-block-actions button {
    display: flex;
    align-items: center;
    gap: 4px;
    background: transparent;
    border: none;
    color: var(--vscode-descriptionForeground);
    cursor: pointer;
    font-size: 11px;
    padding: 2px 6px;
    border-radius: 4px;
  }
  .code-block-actions button:hover {
    background: rgba(127,127,127,0.25);
    color: var(--vscode-editor-foreground);
  }
  .code-block pre {
    margin: 0;
    padding: 10px 14px;
    overflow-x: auto;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 12.5px;
    line-height: 1.5;
    color: var(--vscode-editor-foreground);
    background: transparent;
  }
  .code-block pre code {
    color: var(--vscode-editor-foreground);
    background: transparent;
  }

  .typing-dot {
    display: inline-block;
    width: 6px;
    height: 6px;
    margin-right: 3px;
    border-radius: 50%;
    background: currentColor;
    opacity: 0.5;
    animation: blink 1.2s infinite;
  }
  .typing-dot:nth-child(2) { animation-delay: 0.2s; }
  .typing-dot:nth-child(3) { animation-delay: 0.4s; }
  @keyframes blink { 0%, 80%, 100% { opacity: 0.25; } 40% { opacity: 1; } }

  #inputBar {
    display: flex;
    align-items: flex-end;
    gap: 8px;
    padding: 10px;
    border-top: 1px solid var(--vscode-widget-border);
    flex-shrink: 0;
  }
  #input {
    flex: 1;
    resize: none;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.4));
    box-shadow: 0 0 0 1px rgba(128,128,128,0.15);
    padding: 9px 12px;
    font-family: inherit;
    font-size: 12px;
    line-height: 1.4;
    border-radius: 8px;
    height: 40px;
    min-height: 40px;
    max-height: 160px;
  }
  #input:focus { outline: 1px solid var(--vscode-focusBorder); }
  #sendBtn {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    width: 40px;
    height: 40px;
    border-radius: 8px;
    cursor: pointer;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  #sendBtn:hover { background: var(--vscode-button-hoverBackground); }
  #sendBtn:disabled { opacity: 0.4; cursor: default; }
  #stopBtn {
    background: var(--vscode-errorForeground);
    color: white;
    border: none;
    width: 40px;
    height: 40px;
    border-radius: 8px;
    cursor: pointer;
    flex-shrink: 0;
    display: none;
    align-items: center;
    justify-content: center;
  }
  #stopBtn:hover { opacity: 0.85; }
  .icon-svg { display: block; }

  #attachBtn, #attachImageBtn {
    background: transparent;
    border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.4));
    color: var(--vscode-editor-foreground);
    width: 40px;
    height: 40px;
    border-radius: 8px;
    cursor: pointer;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  #attachBtn:hover, #attachImageBtn:hover { background: rgba(127,127,127,0.15); }

  #attachmentPreview {
    display: none;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    margin: 0 10px;
    border-radius: 6px;
    background: var(--vscode-textBlockQuote-background);
    font-size: 12px;
  }
  #attachmentPreview img {
    width: 32px;
    height: 32px;
    object-fit: cover;
    border-radius: 4px;
  }
  #attachmentPreview .attach-name { flex: 1; opacity: 0.9; }
  #attachmentPreview button {
    background: transparent;
    border: none;
    color: var(--vscode-descriptionForeground);
    cursor: pointer;
    padding: 0 4px;
    display: flex;
    align-items: center;
  }

  .msg-attachment {
    margin-bottom: 6px;
    font-size: 11px;
    opacity: 0.9;
  }
  .msg-attachment img {
    max-width: 100%;
    max-height: 160px;
    border-radius: 6px;
    display: block;
    margin-bottom: 4px;
  }
  .msg-attachment .file-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 3px 8px;
    border-radius: 10px;
    background: rgba(255,255,255,0.15);
  }
</style>
</head>
<body>
  <div id="header">
    <span class="title">${ICONS.chat} Local Full AI Chat</span>
    <div id="headerRight">
      <span id="modelBadge" style="display:none;"></span>
      <button id="clearChatBtn" title="Clear chat">${ICONS.trash}</button>
    </div>
  </div>
  <div id="messages"></div>
  <div id="attachmentPreview">
    <img id="attachmentThumb" style="display:none;" />
    <span class="attach-name" id="attachmentName"></span>
    <button id="attachmentRemove">${ICONS.close}</button>
  </div>
  <div id="inputBar">
    <button id="attachImageBtn" title="Attach an image (vision models only)" style="display:none;">${ICONS.image}</button>
    <button id="attachBtn" title="Attach a text file">${ICONS.paperclip}</button>
    <textarea id="input" rows="1" placeholder="Ask the local model... (Enter to send, Shift+Enter for a new line)"></textarea>
    <button id="stopBtn" title="Stop generating">${ICONS.stop}</button>
    <button id="sendBtn" title="Send">${ICONS.send}</button>
  </div>

<script>
  const vscode = acquireVsCodeApi();
  const messagesEl = document.getElementById('messages');
  const input = document.getElementById('input');
  const sendBtn = document.getElementById('sendBtn');
  const stopBtn = document.getElementById('stopBtn');
  const attachBtn = document.getElementById('attachBtn');
  const attachImageBtn = document.getElementById('attachImageBtn');
  const attachmentPreview = document.getElementById('attachmentPreview');
  const attachmentThumb = document.getElementById('attachmentThumb');
  const attachmentName = document.getElementById('attachmentName');
  const attachmentRemove = document.getElementById('attachmentRemove');
  const modelBadge = document.getElementById('modelBadge');
  const clearChatBtn = document.getElementById('clearChatBtn');

  let clearConfirmPending = false;

  function doClearChat() {
    if (isGenerating) {
      vscode.postMessage({ type: 'stopGeneration' });
    }
    messagesEl.innerHTML = '';
    currentBubble = null;
    currentRaw = '';
    pendingAttachment = null;
    clearAttachment();
    setGeneratingUI(false);
    vscode.postMessage({ type: 'clearChat' });
  }

  clearChatBtn.addEventListener('click', () => {
    if (clearConfirmPending) {
      clearConfirmPending = false;
      clearChatBtn.classList.remove('confirming');
      doClearChat();
      return;
    }
    clearConfirmPending = true;
    clearChatBtn.classList.add('confirming');
    clearChatBtn.title = 'Click again to confirm';
    setTimeout(() => {
      if (clearConfirmPending) {
        clearConfirmPending = false;
        clearChatBtn.classList.remove('confirming');
        clearChatBtn.title = 'Clear chat';
      }
    }, 2500);
  });

  let currentBubble = null;
  let currentRaw = '';
  let pendingAttachment = null; // { kind, name, base64?, dataUrl?, content?, language?, truncated? }
  let isGenerating = false;
  let stoppedByUser = false;

  function clearAttachment() {
    pendingAttachment = null;
    attachmentPreview.style.display = 'none';
    attachmentThumb.style.display = 'none';
  }

  attachBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'attachFile', kind: 'text' });
  });
  attachImageBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'attachFile', kind: 'image' });
  });

  attachmentRemove.addEventListener('click', clearAttachment);

  function setGeneratingUI(active) {
    isGenerating = active;
    sendBtn.style.display = active ? 'none' : 'flex';
    stopBtn.style.display = active ? 'flex' : 'none';
  }

  stopBtn.addEventListener('click', () => {
    stoppedByUser = true;
    vscode.postMessage({ type: 'stopGeneration' });

    if (currentBubble) {
      if (!currentRaw || !currentRaw.trim()) {
        const row = currentBubble.closest('.row');
        if (row) row.remove();
      }
      currentBubble = null;
      currentRaw = '';
    }
    setGeneratingUI(false);
  });

  function escapeHtml(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function renderMarkdown(raw) {
    const fenceRegex = /\`\`\`(\\w*)\\n?([\\s\\S]*?)(?:\`\`\`|$)/g;
    let html = '';
    let lastIndex = 0;
    let match;

    function renderPlainSegment(segment) {
      let text = escapeHtml(segment);
      text = text.replace(/\`([^\`]+)\`/g, '<code class="inline">$1</code>');
      text = text.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
      return text
        .split(/\\n{2,}/)
        .map((p) => p.trim())
        .filter((p) => p.length > 0)
        .map((p) => '<p>' + p.replace(/\\n/g, '<br>') + '</p>')
        .join('');
    }

    while ((match = fenceRegex.exec(raw)) !== null) {
      const before = raw.slice(lastIndex, match.index);
      if (before) html += renderPlainSegment(before);

      const lang = match[1] || '';
      const code = match[2] || '';
      html += buildCodeBlock(lang, code);

      lastIndex = fenceRegex.lastIndex;
    }

    const rest = raw.slice(lastIndex);
    if (rest) html += renderPlainSegment(rest);

    return html;
  }

  function buildCodeBlock(lang, code) {
    const codeId = 'code_' + Math.random().toString(36).slice(2, 9);
    return (
      '<div class="code-block">' +
        '<div class="code-block-header">' +
          '<span>' + (lang || 'code') + '</span>' +
          '<span class="code-block-actions">' +
            '<button data-action="copy" data-target="' + codeId + '">' + ${JSON.stringify(ICONS.copy)} + ' Copy</button>' +
            '<button data-action="insert" data-target="' + codeId + '">' + ${JSON.stringify(ICONS.insert)} + ' Insert</button>' +
          '</span>' +
        '</div>' +
        '<pre><code id="' + codeId + '">' + escapeHtml(code) + '</code></pre>' +
      '</div>'
    );
  }

  function attachCodeBlockActions(container) {
    container.querySelectorAll('button[data-action]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const codeEl = document.getElementById(btn.getAttribute('data-target'));
        if (!codeEl) return;
        const text = codeEl.textContent;
        if (btn.getAttribute('data-action') === 'copy') {
          vscode.postMessage({ type: 'copyToClipboard', text: text });
          const original = btn.innerHTML;
          btn.innerHTML = ${JSON.stringify(ICONS.check)} + ' Copied';
          setTimeout(() => (btn.innerHTML = original), 1500);
        } else {
          vscode.postMessage({ type: 'insertAtCursor', text: text });
        }
      });
    });
  }

  function stripCodeFences(raw) {
    return raw
      .replace(/\`\`\`[\\s\\S]*?\`\`\`/g, '')
      .replace(/\`\`\`[\\s\\S]*$/g, '')
      .replace(/\\n{3,}/g, '\\n\\n')
      .trim();
  }

  function addRow(html, cls, rawText) {
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
        ? '<button data-msg-action="edit" title="Edit">' + ${JSON.stringify(ICONS.pencil)} + '</button>'
        : '<button data-msg-action="copy" title="Copy text">' + ${JSON.stringify(ICONS.copy)} + '</button>';
      col.appendChild(actions);

      actions.querySelectorAll('button').forEach((btn) => {
        btn.addEventListener('click', () => {
          const action = btn.getAttribute('data-msg-action');
          const text = row.dataset.rawText || '';
          if (action === 'copy') {
            vscode.postMessage({ type: 'copyToClipboard', text: stripCodeFences(text) });
            const original = btn.innerHTML;
            btn.innerHTML = ${JSON.stringify(ICONS.check)};
            setTimeout(() => (btn.innerHTML = original), 1200);
          } else if (action === 'edit') {
            input.value = text;
            autoResize();
            input.focus();
          }
        });
      });
    }

    row.appendChild(col);
    messagesEl.appendChild(row);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    attachCodeBlockActions(bubble);
    return bubble;
  }

  function autoResize() {
    input.style.height = 'auto';
    input.style.height = Math.min(Math.max(input.scrollHeight, 40), 160) + 'px';
  }
  input.addEventListener('input', autoResize);

  function send() {
    if (isGenerating) return;
    stoppedByUser = false;

    const text = input.value.trim();
    if (!text && !pendingAttachment) return;

    const attachmentToSend = pendingAttachment
      ? {
          kind: pendingAttachment.kind,
          name: pendingAttachment.name,
          base64: pendingAttachment.base64,
          content: pendingAttachment.content,
          dataUrl: pendingAttachment.dataUrl,
          language: pendingAttachment.language,
          truncated: pendingAttachment.truncated
        }
      : null;

    vscode.postMessage({ type: 'send', text: text, attachment: attachmentToSend });
    input.value = '';
    clearAttachment();
    autoResize();
  }

  sendBtn.addEventListener('click', send);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
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
        let html = '';
        if (msg.attachment) {
          if (msg.attachment.kind === 'image') {
            html += '<div class="msg-attachment"><img src="' + msg.attachment.dataUrl + '" /></div>';
          } else {
            html += '<div class="msg-attachment">' +
              buildCodeBlock(msg.attachment.language || '', msg.attachment.content || '') +
            '</div>';
          }
        }
        if (msg.text) {
          html += escapeHtml(msg.text).replace(/\\n/g, '<br>');
        }
        addRow(html, 'user', msg.text || '');
        break;
      }
      case 'assistantStart':
        if (msg.modelName) {
          modelBadge.textContent = msg.modelName;
          modelBadge.style.display = 'inline-block';
        }
        attachImageBtn.style.display = msg.supportsVision ? 'flex' : 'none';
        currentRaw = '';
        currentBubble = addRow(
          '<span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>',
          'assistant'
        );
        setGeneratingUI(true);
        break;
      case 'assistantToken':
        if (stoppedByUser) break;
        if (currentBubble) {
          currentRaw += msg.text;
          currentBubble.innerHTML = renderMarkdown(currentRaw);
          currentBubble.closest('.row').dataset.rawText = currentRaw;
          attachCodeBlockActions(currentBubble);
          messagesEl.scrollTop = messagesEl.scrollHeight;
        }
        break;
      case 'assistantEnd':
        if (stoppedByUser) {
          stoppedByUser = false;
          break;
        }
        if (currentBubble) {
          currentBubble.closest('.row').dataset.rawText = currentRaw;
        }
        currentBubble = null;
        currentRaw = '';
        setGeneratingUI(false);
        break;
      case 'error': {
        if (stoppedByUser) {
          stoppedByUser = false;
          break;
        }
        let html = escapeHtml(msg.text);
        if (msg.showStartServer) {
          html += '<div style="margin-top:8px;">' +
            '<button id="startServerBtn" style="display:inline-flex;align-items:center;gap:6px;width:auto;">' +
            ${JSON.stringify(ICONS.play)} + ' Start Ollama server</button></div>';
        }
        const errBubble = addRow(html, 'error');
        if (msg.showStartServer) {
          const btn = errBubble.querySelector('#startServerBtn');
          if (btn) {
            btn.onclick = () => {
              btn.disabled = true;
              btn.textContent = 'Starting...';
              vscode.postMessage({ type: 'startOllamaServer' });
            };
          }
        }
        setGeneratingUI(false);
        break;
      }
      case 'serverStartResult':
        addRow(escapeHtml(msg.text), msg.ok ? 'assistant' : 'error');
        break;
      case 'fileAttached':
        pendingAttachment = msg;
        attachmentPreview.style.display = 'flex';
        attachmentName.textContent = msg.name + (msg.truncated ? ' (truncated)' : '');
        if (msg.kind === 'image') {
          attachmentThumb.src = msg.dataUrl;
          attachmentThumb.style.display = 'block';
        } else {
          attachmentThumb.style.display = 'none';
        }
        break;
      case 'modelInfo':
        attachImageBtn.style.display = msg.supportsVision ? 'flex' : 'none';
        break;
    }
  });

  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
  }
}

module.exports = { ChatPanel };
