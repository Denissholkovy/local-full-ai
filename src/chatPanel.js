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

const MAX_CONTEXT_CHARS = 24000;

function estimateChars(messages) {
  return messages.reduce(
    (sum, m) => sum + (typeof m.content === 'string' ? m.content.length : 0),
    0
  );
}

function trimMessagesToFit(messages, maxChars) {
  const systemMsgs = messages.filter((m) => m.role === 'system');
  const rest = messages.filter((m) => m.role !== 'system');
  let trimmed = false;

  while (estimateChars([...systemMsgs, ...rest]) > maxChars && rest.length > 2) {
    rest.shift();
    trimmed = true;
  }

  return { messages: [...systemMsgs, ...rest], trimmed };
}

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
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
      }
    );

    ChatPanel.currentPanel = new ChatPanel(panel, context, ollamaClient);
    return ChatPanel.currentPanel;
  }

  constructor(panel, context, ollamaClient) {
    this._panel = panel;
    this._context = context;
    this._ollamaClient = ollamaClient;
    this._currentAbort = null;

    this._sessions = this._context.globalState.get('localAI.chatSessions', []);
    if (!Array.isArray(this._sessions) || this._sessions.length === 0) {
      this._sessions = [this._createSessionObject()];
    }
    let currentId = this._context.globalState.get('localAI.currentSessionId', null);
    let currentSession = this._sessions.find((s) => s.id === currentId);
    if (!currentSession) {
      currentSession = this._sessions[this._sessions.length - 1];
      currentId = currentSession.id;
    }
    this._currentSessionId = currentId;
    this._history = currentSession.history;

    const hljsUri = this._panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this._context.extensionUri, 'media', 'vendor', 'highlight.min.js')
    );
    this._panel.webview.html = this._getHtml(hljsUri);

    this._panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === 'send') {
        await this._handleUserMessage(msg.text, msg.attachments);
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
        this._sendCurrentHistory();
      } else if (msg.type === 'startOllamaServer') {
        await this._startOllamaServer();
      } else if (msg.type === 'clearChat') {
        this._history.length = 0;
        this._persistSessions();
        if (this._currentAbort) this._currentAbort();
      } else if (msg.type === 'regenerate') {
        await this._regenerate();
      } else if (msg.type === 'listSessions') {
        this._sendSessionsList();
      } else if (msg.type === 'newChat') {
        this._newChat();
      } else if (msg.type === 'switchSession') {
        this._switchSession(msg.id);
      } else if (msg.type === 'deleteSession') {
        this._deleteSession(msg.id);
      }
    });

    this._panel.onDidDispose(() => {
      ChatPanel.currentPanel = undefined;
    });
  }

  _createSessionObject() {
    return {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      title: 'New chat',
      history: [],
      updatedAt: Date.now()
    };
  }

  _persistSessions() {
    const session = this._sessions.find((s) => s.id === this._currentSessionId);
    if (session) {
      session.updatedAt = Date.now();
      const firstUser = session.history.find((m) => m.role === 'user');
      if (firstUser && session.title === 'New chat') {
        const raw = typeof firstUser.content === 'string' ? firstUser.content : '';
        session.title = raw.slice(0, 48) + (raw.length > 48 ? '...' : '');
      }
    }
    this._context.globalState.update('localAI.chatSessions', this._sessions);
    this._context.globalState.update('localAI.currentSessionId', this._currentSessionId);
  }

  _sendCurrentHistory() {
    this._panel.webview.postMessage({
      type: 'loadHistory',
      history: this._history
    });
  }

  _sendSessionsList() {
    const list = this._sessions
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((s) => ({ id: s.id, title: s.title, updatedAt: s.updatedAt, isCurrent: s.id === this._currentSessionId }));
    this._panel.webview.postMessage({ type: 'sessionsList', sessions: list });
  }

  _newChat() {
    if (this._currentAbort) this._currentAbort();
    const session = this._createSessionObject();
    this._sessions.push(session);
    this._currentSessionId = session.id;
    this._history = session.history;
    this._persistSessions();
    this._sendCurrentHistory();
    this._sendModelInfo();
  }

  _switchSession(id) {
    const session = this._sessions.find((s) => s.id === id);
    if (!session) return;
    if (this._currentAbort) this._currentAbort();
    this._currentSessionId = id;
    this._history = session.history;
    this._context.globalState.update('localAI.currentSessionId', this._currentSessionId);
    this._sendCurrentHistory();
    this._sendModelInfo();
  }

  _deleteSession(id) {
    const idx = this._sessions.findIndex((s) => s.id === id);
    if (idx === -1) return;
    this._sessions.splice(idx, 1);

    if (this._sessions.length === 0) {
      this._sessions = [this._createSessionObject()];
    }

    if (id === this._currentSessionId) {
      const next = this._sessions[this._sessions.length - 1];
      this._currentSessionId = next.id;
      this._history = next.history;
      this._sendCurrentHistory();
      this._sendModelInfo();
    }

    this._persistSessions();
    this._sendSessionsList();
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
      canSelectMany: true,
      openLabel: 'Attach',
      filters: {
        [kind === 'image' ? 'Images' : 'Text files']: extensions
      }
    });
    if (!uris || uris.length === 0) return;

    for (const uri of uris) {
      const filePath = uri.fsPath;
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
          text: `Could not read the file "${fileName}": ${err.message}`
        });
      }
    }
  }

  seedMessage(text) {
    this._panel.webview.postMessage({ type: 'seed', text });
  }

  async _handleUserMessage(text, attachments) {
    const modelName = this._context.globalState.get('localAI.selectedModel');
    if (!modelName) {
      this._panel.webview.postMessage({
        type: 'error',
        text: 'Pick a model in the Local Full AI sidebar first.'
      });
      return;
    }

    const userMessage = { role: 'user', content: text };
    const contentParts = [];

    const includeActiveFile = this._context.globalState.get('localAI.includeActiveFile', false);
    if (includeActiveFile) {
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        const fileName = path.basename(editor.document.fileName);
        let fileText = editor.document.getText();
        let truncated = false;
        if (fileText.length > MAX_TEXT_FILE_CHARS) {
          fileText = fileText.slice(0, MAX_TEXT_FILE_CHARS);
          truncated = true;
        }
        const lang = editor.document.languageId || '';
        contentParts.push(
          `Active file (${fileName}${truncated ? ', truncated' : ''}):\n\`\`\`${lang}\n${fileText}\n\`\`\``
        );
      }
    }

    const attachmentList = Array.isArray(attachments) ? attachments : (attachments ? [attachments] : []);

    if (attachmentList.length > 0) {
      const imageBase64s = [];
      attachmentList.forEach((att) => {
        if (att.kind === 'text') {
          const lang = att.language || '';
          contentParts.push(`File: ${att.name}\n\`\`\`${lang}\n${att.content}\n\`\`\``);
        } else if (att.kind === 'image') {
          imageBase64s.push(att.base64);
        }
      });
      if (imageBase64s.length > 0) {
        userMessage.images = imageBase64s;
      }
    }

    contentParts.push(text);
    userMessage.content = contentParts.join('\n\n');

    this._history.push(userMessage);
    this._persistSessions();
    this._panel.webview.postMessage({
      type: 'userMessage',
      text,
      includedActiveFile: includeActiveFile && !!vscode.window.activeTextEditor,
      attachments: attachmentList.map((att) => ({
        kind: att.kind,
        name: att.name,
        dataUrl: att.dataUrl,
        content: att.content,
        language: att.language,
        truncated: att.truncated
      }))
    });

    await this._streamAssistantReply(modelName);
  }

  async _regenerate() {
    const modelName = this._context.globalState.get('localAI.selectedModel');
    if (!modelName) {
      this._panel.webview.postMessage({
        type: 'error',
        text: 'Pick a model in the Local Full AI sidebar first.'
      });
      return;
    }

    if (
      this._history.length > 0 &&
      this._history[this._history.length - 1].role === 'assistant'
    ) {
      this._history.pop();
    }

    await this._streamAssistantReply(modelName);
  }

  async _streamAssistantReply(modelName) {
    this._panel.webview.postMessage({
      type: 'assistantStart',
      modelName,
      supportsVision: isVisionModel(modelName)
    });

    try {
      const systemPrompt = this._context.globalState.get('localAI.systemPrompt') || '';
      const messagesToSend = systemPrompt
        ? [{ role: 'system', content: systemPrompt }, ...this._history]
        : this._history;

      const { messages: trimmedMessages, trimmed } = trimMessagesToFit(messagesToSend, MAX_CONTEXT_CHARS);
      if (trimmed) {
        this._panel.webview.postMessage({
          type: 'contextTrimmed',
          text: 'This conversation got long - older messages were trimmed to fit the model\'s context window.'
        });
      }

      const keepAlive = this._context.globalState.get('localAI.keepAlive') || undefined;

      const fullReply = await this._ollamaClient.chatStream(
        modelName,
        trimmedMessages,
        (token) => {
          this._panel.webview.postMessage({ type: 'assistantToken', text: token });
        },
        {
          onAbortReady: (abortFn) => {
            this._currentAbort = abortFn;
          },
          keepAlive,
          onStats: (stats) => {
            this._panel.webview.postMessage({ type: 'generationStats', stats });
          }
        }
      );
      this._currentAbort = null;
      this._history.push({ role: 'assistant', content: fullReply });
      this._persistSessions();
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

  _getHtml(hljsUri) {
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

  #historyBtn, #newChatBtn {
    background: transparent;
    border: none;
    color: var(--vscode-descriptionForeground);
    cursor: pointer;
    padding: 3px 5px;
    border-radius: 4px;
    display: flex;
    align-items: center;
  }
  #historyBtn:hover, #newChatBtn:hover {
    background: rgba(127,127,127,0.2);
    color: var(--vscode-editor-foreground);
  }

  #historyDropdown {
    position: absolute;
    top: 42px;
    left: 10px;
    width: 280px;
    max-height: 340px;
    overflow-y: auto;
    background: var(--vscode-editorWidget-background);
    border: 1px solid var(--vscode-widget-border);
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    z-index: 20;
    padding: 6px;
  }
  .session-item {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 7px 8px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 12.5px;
  }
  .session-item:hover {
    background: rgba(127,127,127,0.15);
  }
  .session-item.current {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }
  .session-item .session-title {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .session-item .session-delete {
    background: transparent;
    border: none;
    color: inherit;
    opacity: 0.5;
    cursor: pointer;
    padding: 2px 4px;
    border-radius: 4px;
    display: flex;
    align-items: center;
  }
  .session-item .session-delete:hover {
    opacity: 1;
    background: rgba(244,71,71,0.25);
  }
  .session-empty {
    padding: 10px;
    font-size: 12px;
    opacity: 0.6;
    text-align: center;
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
  .row.notice .message-col { align-items: center; }

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
  .row.notice {
    justify-content: center;
  }
  .row.notice .bubble {
    background: transparent;
    border: 1px dashed var(--vscode-widget-border);
    color: var(--vscode-descriptionForeground);
    font-size: 11.5px;
    padding: 6px 12px;
  }
  .gen-stats {
    font-size: 10.5px;
    opacity: 0.5;
    padding: 0 4px;
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

  /* Syntax highlighting token colors - two palettes chosen to resemble the
     default VS Code Dark+/Light+ themes. VS Code adds a vscode-dark or
     vscode-light class to the webview body automatically. */
  body.vscode-dark .hljs-keyword,
  body.vscode-dark .hljs-literal,
  body.vscode-dark .hljs-selector-tag,
  body.vscode-dark .hljs-tag,
  body.vscode-dark .hljs-name { color: #569cd6; }
  body.vscode-dark .hljs-string,
  body.vscode-dark .hljs-regexp { color: #ce9178; }
  body.vscode-dark .hljs-number { color: #b5cea8; }
  body.vscode-dark .hljs-comment,
  body.vscode-dark .hljs-quote { color: #6a9955; font-style: italic; }
  body.vscode-dark .hljs-title,
  body.vscode-dark .hljs-title.function_,
  body.vscode-dark .hljs-section { color: #dcdcaa; }
  body.vscode-dark .hljs-built_in,
  body.vscode-dark .hljs-type,
  body.vscode-dark .hljs-class .hljs-title { color: #4ec9b0; }
  body.vscode-dark .hljs-attr,
  body.vscode-dark .hljs-attribute,
  body.vscode-dark .hljs-variable,
  body.vscode-dark .hljs-template-variable,
  body.vscode-dark .hljs-meta { color: #9cdcfe; }
  body.vscode-dark .hljs-symbol,
  body.vscode-dark .hljs-bullet,
  body.vscode-dark .hljs-link { color: #d7ba7d; }
  body.vscode-dark .hljs-deletion { color: #f48771; }
  body.vscode-dark .hljs-addition { color: #b5cea8; }
  body.vscode-dark .hljs-emphasis { font-style: italic; }
  body.vscode-dark .hljs-strong { font-weight: bold; }

  body.vscode-light .hljs-keyword,
  body.vscode-light .hljs-literal,
  body.vscode-light .hljs-selector-tag,
  body.vscode-light .hljs-tag,
  body.vscode-light .hljs-name { color: #0000ff; }
  body.vscode-light .hljs-string,
  body.vscode-light .hljs-regexp { color: #a31515; }
  body.vscode-light .hljs-number { color: #098658; }
  body.vscode-light .hljs-comment,
  body.vscode-light .hljs-quote { color: #008000; font-style: italic; }
  body.vscode-light .hljs-title,
  body.vscode-light .hljs-title.function_,
  body.vscode-light .hljs-section { color: #795e26; }
  body.vscode-light .hljs-built_in,
  body.vscode-light .hljs-type,
  body.vscode-light .hljs-class .hljs-title { color: #267f99; }
  body.vscode-light .hljs-attr,
  body.vscode-light .hljs-attribute,
  body.vscode-light .hljs-variable,
  body.vscode-light .hljs-template-variable,
  body.vscode-light .hljs-meta { color: #001080; }
  body.vscode-light .hljs-symbol,
  body.vscode-light .hljs-bullet,
  body.vscode-light .hljs-link { color: #a31515; }
  body.vscode-light .hljs-deletion { color: #a31515; }
  body.vscode-light .hljs-addition { color: #098658; }
  body.vscode-light .hljs-emphasis { font-style: italic; }
  body.vscode-light .hljs-strong { font-weight: bold; }


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
    flex-wrap: wrap;
    gap: 6px;
    padding: 6px 10px;
    margin: 0 10px;
  }
  #attachmentPreview.has-items { display: flex; }
  .attach-chip {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 6px;
    border-radius: 6px;
    background: var(--vscode-textBlockQuote-background);
    font-size: 11.5px;
  }
  .attach-chip img {
    width: 24px;
    height: 24px;
    object-fit: cover;
    border-radius: 4px;
  }
  .attach-chip .attach-name { opacity: 0.9; max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .attach-chip button {
    background: transparent;
    border: none;
    color: var(--vscode-descriptionForeground);
    cursor: pointer;
    padding: 0 2px;
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
    <button id="historyBtn" title="Chat history">${ICONS.list}</button>
    <span class="title">${ICONS.chat} Local Full AI Chat</span>
    <div id="headerRight">
      <span id="modelBadge" style="display:none;"></span>
      <button id="newChatBtn" title="New chat">${ICONS.plus}</button>
      <button id="clearChatBtn" title="Clear chat">${ICONS.trash}</button>
    </div>
  </div>
  <div id="historyDropdown" style="display:none;">
    <div id="historyList"></div>
  </div>
  <div id="messages"></div>
  <div id="attachmentPreview"></div>
  <div id="inputBar">
    <button id="attachImageBtn" title="Attach an image (vision models only)" style="display:none;">${ICONS.image}</button>
    <button id="attachBtn" title="Attach a text file">${ICONS.paperclip}</button>
    <textarea id="input" rows="1" placeholder="Ask the local model... (Enter to send, Shift+Enter for a new line)"></textarea>
    <button id="stopBtn" title="Stop generating">${ICONS.stop}</button>
    <button id="sendBtn" title="Send">${ICONS.send}</button>
  </div>

<script src="${hljsUri}"></script>
<script>
  const hljs = (typeof hljsModule !== 'undefined') ? hljsModule.default : null;
  const vscode = acquireVsCodeApi();
  const messagesEl = document.getElementById('messages');
  const input = document.getElementById('input');
  const sendBtn = document.getElementById('sendBtn');
  const stopBtn = document.getElementById('stopBtn');
  const attachBtn = document.getElementById('attachBtn');
  const attachImageBtn = document.getElementById('attachImageBtn');
  const attachmentPreview = document.getElementById('attachmentPreview');
  const modelBadge = document.getElementById('modelBadge');
  const clearChatBtn = document.getElementById('clearChatBtn');
  const historyBtn = document.getElementById('historyBtn');
  const newChatBtn = document.getElementById('newChatBtn');
  const historyDropdown = document.getElementById('historyDropdown');
  const historyList = document.getElementById('historyList');

  historyBtn.addEventListener('click', () => {
    const willShow = historyDropdown.style.display === 'none';
    historyDropdown.style.display = willShow ? 'block' : 'none';
    if (willShow) {
      vscode.postMessage({ type: 'listSessions' });
    }
  });

  document.addEventListener('click', (e) => {
    if (historyDropdown.style.display === 'none') return;
    if (!historyDropdown.contains(e.target) && !historyBtn.contains(e.target)) {
      historyDropdown.style.display = 'none';
    }
  });

  newChatBtn.addEventListener('click', () => {
    historyDropdown.style.display = 'none';
    vscode.postMessage({ type: 'newChat' });
  });

  function renderSessionsList(sessions) {
    if (!sessions || sessions.length === 0) {
      historyList.innerHTML = '<div class="session-empty">No saved chats yet</div>';
      return;
    }
    let html = '';
    sessions.forEach((s) => {
      html += '<div class="session-item' + (s.isCurrent ? ' current' : '') + '" data-session-id="' + s.id + '">' +
        '<span class="session-title">' + escapeHtml(s.title || 'New chat') + '</span>' +
        '<button class="session-delete" data-delete-session="' + s.id + '" title="Delete chat">' + ${JSON.stringify(ICONS.trash)} + '</button>' +
      '</div>';
    });
    historyList.innerHTML = html;

    historyList.querySelectorAll('.session-item').forEach((item) => {
      item.addEventListener('click', (e) => {
        if (e.target.closest('.session-delete')) return;
        const id = item.getAttribute('data-session-id');
        historyDropdown.style.display = 'none';
        vscode.postMessage({ type: 'switchSession', id });
      });
    });
    historyList.querySelectorAll('.session-delete').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = btn.getAttribute('data-delete-session');
        vscode.postMessage({ type: 'deleteSession', id });
      });
    });
  }

  function renderLoadedHistory(history) {
    messagesEl.innerHTML = '';
    currentBubble = null;
    currentRaw = '';
    lastAssistantRegenerateBtn = null;

    let lastAssistantRow = null;
    (history || []).forEach((m) => {
      if (m.role === 'system') return;
      if (m.role === 'user') {
        addRow(escapeHtml(m.content || '').replace(/\\n/g, '<br>'), 'user', m.content || '');
      } else if (m.role === 'assistant') {
        const bubble = addRow(renderMarkdown(m.content || ''), 'assistant', m.content || '');
        attachCodeBlockActions(bubble);
        highlightCodeBlocks(bubble);
        lastAssistantRow = bubble.closest('.row');
      }
    });
    if (lastAssistantRow) {
      addRegenerateButton(lastAssistantRow);
    }
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  let clearConfirmPending = false;

  function doClearChat() {
    if (isGenerating) {
      vscode.postMessage({ type: 'stopGeneration' });
    }
    messagesEl.innerHTML = '';
    currentBubble = null;
    currentRaw = '';
    pendingAttachments = [];
    lastAssistantRegenerateBtn = null;
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
  let pendingAttachments = [];
  let lastAssistantRegenerateBtn = null;
  let lastGenStats = null;
  let isGenerating = false;
  let stoppedByUser = false;

  function renderAttachmentPreview() {
    if (pendingAttachments.length === 0) {
      attachmentPreview.classList.remove('has-items');
      attachmentPreview.innerHTML = '';
      return;
    }
    attachmentPreview.classList.add('has-items');
    attachmentPreview.innerHTML = pendingAttachments
      .map((att, idx) => {
        const thumb = att.kind === 'image'
          ? '<img src="' + att.dataUrl + '" />'
          : ${JSON.stringify(ICONS.fileText)};
        const label = att.name + (att.truncated ? ' (truncated)' : '');
        return '<span class="attach-chip" data-idx="' + idx + '">' +
          thumb +
          '<span class="attach-name">' + escapeHtml(label) + '</span>' +
          '<button data-remove-idx="' + idx + '">' + ${JSON.stringify(ICONS.close)} + '</button>' +
        '</span>';
      })
      .join('');

    attachmentPreview.querySelectorAll('button[data-remove-idx]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.getAttribute('data-remove-idx'), 10);
        pendingAttachments.splice(idx, 1);
        renderAttachmentPreview();
      });
    });
  }

  function clearAttachment() {
    pendingAttachments = [];
    renderAttachmentPreview();
  }

  attachBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'attachFile', kind: 'text' });
  });
  attachImageBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'attachFile', kind: 'image' });
  });


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
        '<pre><code id="' + codeId + '" data-lang="' + (lang || '') + '">' + escapeHtml(code) + '</code></pre>' +
      '</div>'
    );
  }

  function highlightCodeBlocks(container) {
    if (!hljs) return;
    container.querySelectorAll('pre code[data-lang]').forEach((el) => {
      const lang = el.getAttribute('data-lang');
      try {
        if (lang && hljs.getLanguage(lang)) {
          const result = hljs.highlight(el.textContent, { language: lang, ignoreIllegals: true });
          el.innerHTML = result.value;
        } else {
          const result = hljs.highlightAuto(el.textContent);
          el.innerHTML = result.value;
        }
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
    const wasNearBottom = isNearBottom();
    messagesEl.appendChild(row);
    if (wasNearBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
    attachCodeBlockActions(bubble);
    highlightCodeBlocks(bubble);
    return bubble;
  }

  function isNearBottom() {
    const threshold = 80;
    return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < threshold;
  }

  function addRegenerateButton(row) {
    if (lastAssistantRegenerateBtn) {
      lastAssistantRegenerateBtn.remove();
      lastAssistantRegenerateBtn = null;
    }
    const actionsEl = row.querySelector('.msg-actions');
    if (!actionsEl) return;

    const btn = document.createElement('button');
    btn.setAttribute('data-msg-action', 'regenerate');
    btn.title = 'Regenerate';
    btn.innerHTML = ${JSON.stringify(ICONS.refresh)};
    btn.onclick = () => {
      if (isGenerating) return;
      row.remove();
      lastAssistantRegenerateBtn = null;
      vscode.postMessage({ type: 'regenerate' });
    };
    actionsEl.appendChild(btn);
    lastAssistantRegenerateBtn = btn;
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
    if (!text && pendingAttachments.length === 0) return;

    const attachmentsToSend = pendingAttachments.map((att) => ({
      kind: att.kind,
      name: att.name,
      base64: att.base64,
      content: att.content,
      dataUrl: att.dataUrl,
      language: att.language,
      truncated: att.truncated
    }));

    vscode.postMessage({ type: 'send', text: text, attachments: attachmentsToSend });
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
        if (lastAssistantRegenerateBtn) {
          lastAssistantRegenerateBtn.remove();
          lastAssistantRegenerateBtn = null;
        }
        let html = '';
        if (msg.includedActiveFile) {
          html += '<div class="msg-attachment"><span class="file-chip">' +
            ${JSON.stringify(ICONS.fileText)} + ' active file included</span></div>';
        }
        if ((msg.attachments || []).length > 0) {
          msg.attachments.forEach((att) => {
            if (att.kind === 'image') {
              html += '<div class="msg-attachment"><img src="' + att.dataUrl + '" /></div>';
            } else {
              html += '<div class="msg-attachment">' +
                buildCodeBlock(att.language || '', att.content || '') +
              '</div>';
            }
          });
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
          const wasNearBottom = isNearBottom();
          currentRaw += msg.text;
          currentBubble.innerHTML = renderMarkdown(currentRaw);
          currentBubble.closest('.row').dataset.rawText = currentRaw;
          attachCodeBlockActions(currentBubble);
          highlightCodeBlocks(currentBubble);
          if (wasNearBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
        }
        break;
      case 'assistantEnd':
        if (stoppedByUser) {
          stoppedByUser = false;
          break;
        }
        if (currentBubble) {
          const row = currentBubble.closest('.row');
          row.dataset.rawText = currentRaw;
          addRegenerateButton(row);
          if (lastGenStats) {
            const statsEl = document.createElement('div');
            statsEl.className = 'gen-stats';
            statsEl.textContent = lastGenStats.tokensPerSec.toFixed(1) + ' tok/s';
            row.querySelector('.message-col').appendChild(statsEl);
            lastGenStats = null;
          }
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
        pendingAttachments.push(msg);
        renderAttachmentPreview();
        break;
      case 'modelInfo':
        attachImageBtn.style.display = msg.supportsVision ? 'flex' : 'none';
        break;
      case 'generationStats':
        lastGenStats = msg.stats;
        break;
      case 'contextTrimmed':
        addRow(escapeHtml(msg.text), 'notice');
        break;
      case 'sessionsList':
        renderSessionsList(msg.sessions);
        break;
      case 'loadHistory':
        renderLoadedHistory(msg.history);
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
