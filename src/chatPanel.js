const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { ICONS } = require('./icons');
const { isVisionModel } = require('./modelCapabilities');
const ollamaProcess = require('./ollamaProcess');
const { WorkspaceTools, normalizeArgs, truncate } = require('./tools');
const skillsLib = require('./skills');
const workspaceLib = require('./workspace');
const { resolveWorkspaceRoot } = workspaceLib;
const agentTools = require('./agentTools');
const voice = require('./voice');
const modelState = require('./modelState');
const agentFiles = require('./agentFiles');
const generationLib = require('./generation');
const beforeContent = require('./beforeContent');
const projectCheck = require('./projectCheck');
const MODEL_CATALOG = require('./models.json');
const { spawn } = require('child_process');

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
const TEXT_FILE_EXTENSIONS = [
  'txt', 'md', 'js', 'ts', 'jsx', 'tsx', 'py', 'json', 'html', 'css', 'java', 'go', 'rs', 'c', 'cpp', 'log'
];
const MAX_TEXT_FILE_CHARS = 12000;
const MAX_TOOL_RESULT_CHARS = 8000;
const VOICE_MAX_MS = 120000;
const MAX_AGENT_STEPS = 25;
const MAX_DUMP_NUDGES = 2;
const CONTEXT_FILE_CHARS = 6000;
const CONTEXT_TOTAL_CHARS = 14000;
const AUTOPILOT_MAX_STEPS = 400;
const MAX_NUDGES = 6;
const MAX_REPEAT_WARNINGS = 3;
const SUBAGENT_MAX_STEPS = { research: 25, worker: 40 };
const MAX_SUBAGENT_REPORT_CHARS = 6000;
const RETRY_DELAY_MS = 4000;
const MAX_RETRIES = 6;
const DEFAULT_CONTEXT_SIZE = 16384;
const CHARS_PER_TOKEN = 2.5;

const LANGUAGE_BY_EXTENSION = {
  '.js': 'javascript',
  '.ts': 'typescript',
  '.jsx': 'javascript',
  '.tsx': 'typescript',
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

function estimateChars(messages) {
  return messages.reduce((sum, m) => {
    let size = typeof m.content === 'string' ? m.content.length : 0;
    if (m.tool_calls) size += JSON.stringify(m.tool_calls).length;
    return sum + size;
  }, 0);
}

function trimMessagesToFit(messages, maxChars) {
  const systemMsgs = messages.filter((m) => m.role === 'system');
  const rest = messages.filter((m) => m.role !== 'system');
  let trimmed = false;

  while (estimateChars([...systemMsgs, ...rest]) > maxChars && rest.length > 2) {
    rest.shift();
    trimmed = true;
  }
  while (trimmed && rest.length > 1 && rest[0].role !== 'user') {
    rest.shift();
  }

  return { messages: [...systemMsgs, ...rest], trimmed };
}

function modelSupportsTools(name) {
  const entry = MODEL_CATALOG.find((m) => m.name === name);
  return entry ? (entry.tags || []).includes('tools') : true;
}

function languageNote(lang) {
  if (!lang || lang === 'English') return '';
  return `IMPORTANT: the user writes in ${lang}. Write ALL your replies to the user in ${lang}, including short summaries after tool calls. Code, file names and identifiers stay unchanged.`;
}

function isSmallModel(name) {
  const m = String(name || '').match(/(\d+(?:\.\d+)?)b\b/i);
  return !!m && Number(m[1]) < 13;
}

function displayTitle(message) {
  const display = message.display;
  if (display && display.text) return display.text;
  if (display && display.attachments && display.attachments.length) return display.attachments[0].name;
  return typeof message.content === 'string' ? message.content : '';
}

function capDiff(diff) {
  if (!diff) return null;
  return { added: diff.added, removed: diff.removed, isNew: diff.isNew, lines: diff.lines.slice(0, 100) };
}

function toOllamaMessages(messages) {
  return messages.filter((m) => m.role !== 'notice' && m.role !== 'step').map((m) => {
    const out = { role: m.role, content: m.content };
    if (m.images) out.images = m.images;
    if (m.tool_calls) out.tool_calls = m.tool_calls;
    if (m.tool_name) out.tool_name = m.tool_name;
    return out;
  });
}

function buildAgentPrompt(rootName) {
  if (!rootName) {
    return 'You are a local assistant inside VS Code. Answer in the same language the user writes in.';
  }
  return [
    `You are a local coding assistant inside VS Code. You can work with the user's project folder "${rootName}" through tools.`,
    'Rules:',
    '- Look at the real files with tools before answering questions about the code. Never guess file contents.',
    '- All paths are relative to the project root.',
    '- To change a SMALL file (under about 150 lines) rewrite it completely with write_file (same path, full updated content). Use edit_file only for big files, copying old_string exactly from the file.',
    '- Make only the changes the user asked for.',
    '- NEVER paste code or file contents into the chat. Create or change files in the project with write_file or edit_file, then reply with one or two short sentences. The chat is only for talking, questions and corrections.',
    '- When the user asks for a fix or a change, work on the existing files: read them first, then edit them. Do not start over.',
    '- Keep the layout simple: put a new standalone page or script in the project root (for example index.html, style.css, script.js) unless the project already has a clear structure. Use the file type the user asked for (an html request means .html, not a framework component).',
    '- Edits and commands need the user\'s approval. If an action is denied, do not retry it; ask what to do instead.',
    '- When the task is done, summarise what you did in a few short sentences.',
    '- Answer in the same language the user writes in.'
  ].join('\n');
}

function buildFilesPrompt(rootName) {
  return [
    `You are a coding assistant working inside the user's project folder "${rootName}". You cannot run tools, but you can create and change files by writing them in exactly this format:`,
    '',
    '<file path="relative/path/to/file.ext">',
    '...the COMPLETE content of the file...',
    '</file>',
    '',
    'Rules:',
    '- NEVER show code in any other way. Every piece of code goes into a <file> block and the app saves it into the project. The chat is only for talking.',
    '- Always give the COMPLETE content of a file, also when you change an existing one (use the same path to replace it). Keep everything the user did not ask to change.',
    '- Create the files that are missing (for example index.html, style.css, script.js) with short relative paths.',
    '- Keep the layout simple: new standalone pages go in the project root. Use the file type the user asked for.',
    '- Outside file blocks write only one to three short sentences: what you did and how to use it.',
    '- If the user only asks a question or wants to talk, answer in plain text without file blocks.',
    '- Answer in the same language the user writes in.'
  ].join('\n');
}

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
    this._runs = new Map();
    this._recording = null;
    this._voiceTimer = null;
    this._pendingPermissions = new Map();
    this._grantsBySession = new Map();
    this._noToolsModels = new Set();
    this._toolCounter = 0;
    this._tools = null;

    this._sessions = this._context.globalState.get('localAI.chatSessions', []);
    if (!Array.isArray(this._sessions) || this._sessions.length === 0) {
      this._sessions = [this._createSessionObject()];
    }
    this._sessions.forEach((item) => {
      if (item.usage) item.usage.agents.forEach((ag) => {
        if (ag.status === 'running') ag.status = 'stopped';
      });
    });
    let currentId = this._context.globalState.get('localAI.currentSessionId', null);
    let currentSession = this._sessions.find((s) => s.id === currentId);
    if (!currentSession) {
      currentSession = this._sessions[this._sessions.length - 1];
      currentId = currentSession.id;
    }
    this._currentSessionId = currentId;

    this._panel.webview.html = this._getHtml();

    this._panel.webview.onDidReceiveMessage((msg) => this._onWebviewMessage(msg));

    const folderWatcher = vscode.workspace.onDidChangeWorkspaceFolders(() => this._sendModelInfo());
    const editorWatcher = vscode.window.onDidChangeActiveTextEditor(() => this._sendModelInfo());
    const modelWatcher = modelState.onDidChange((change) => this._onModelChanged(change));
    const trustWatcher = vscode.workspace.onDidGrantWorkspaceTrust ? vscode.workspace.onDidGrantWorkspaceTrust(() => this._sendModelInfo()) : { dispose() {} };
    this._panel.onDidDispose(() => {
      folderWatcher.dispose();
      editorWatcher.dispose();
      modelWatcher.dispose();
      trustWatcher.dispose();
      this._stopAll();
      voice.cancelAll();
      ChatPanel.currentPanel = undefined;
    });
  }

  async _onWebviewMessage(msg) {
    switch (msg.type) {
      case 'send':
        await this._handleUserMessage(msg.text, msg.attachments);
        break;
      case 'copyToClipboard':
        await vscode.env.clipboard.writeText(msg.text);
        break;
      case 'insertAtCursor': {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
          editor.edit((editBuilder) => {
            editBuilder.insert(editor.selection.active, msg.text);
          });
        }
        break;
      }
      case 'attachFile':
        await this._handleAttachFile(msg.kind);
        break;
      case 'stopGeneration':
        this._stopSession(this._currentSessionId);
        break;
      case 'ready':
        this._sendSessionsList();
        this._sendModelInfo();
        this._sendCurrentHistory();
        break;
      case 'startOllamaServer':
        await this._startOllamaServer();
        break;
      case 'regenerate':
        await this._regenerate();
        break;
      case 'listSessions':
        this._sendSessionsList();
        break;
      case 'newChat':
        this._newChat();
        break;
      case 'switchSession':
        this._switchSession(msg.id);
        break;
      case 'deleteSession':
        this._deleteSession(msg.id);
        break;
      case 'toolDecision':
        this._resolvePermission(msg.id, msg.decision, typeof msg.extra === 'string' ? msg.extra.slice(0, 2000) : undefined);
        break;
      case 'toggleAgent': {
        const current = this._context.globalState.get('localAI.agentEnabled', true);
        await this._context.globalState.update('localAI.agentEnabled', !current);
        this._sendModelInfo();
        break;
      }
      case 'setPermissionMode':
        if (['ask', 'auto', 'readonly', 'autopilot'].includes(msg.mode)) {
          await this._context.globalState.update('localAI.permissionMode', msg.mode);
          this._sendModelInfo();
        }
        break;
      case 'voiceToggle':
        await this._toggleVoice();
        break;
      case 'voiceCancel':
        this._cancelVoice();
        break;
      case 'voiceSetup':
        voice.openSetupTerminal();
        break;
      case 'pickModel':
        await vscode.commands.executeCommand('localAI.selectModel');
        this._sendModelInfo();
        break;
      case 'manageTrust':
        await vscode.commands.executeCommand('workbench.trust.manage');
        break;
      case 'openFolder':
        await vscode.commands.executeCommand('workbench.action.files.openFolder');
        break;
      case 'openFile':
        await this._openWorkspaceFile(msg.path);
        break;
      case 'openDiff':
        beforeContent.openDiff(msg.id);
        break;
    }
  }

  _post(message) {
    this._panel.webview.postMessage(message);
  }

  _createSessionObject() {
    return {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      title: 'New chat',
      history: [],
      updatedAt: Date.now()
    };
  }

  _currentSession() {
    return this._sessions.find((s) => s.id === this._currentSessionId);
  }

  _persistSessions(session) {
    if (session) session.updatedAt = Date.now();
    this._sessions.forEach((item) => {
      const firstUser = item.history.find((m) => m.role === 'user');
      if (firstUser && item.title === 'New chat') {
        const raw = displayTitle(firstUser).replace(/\s+/g, ' ').trim();
        item.title = raw.slice(0, 48) + (raw.length > 48 ? '...' : '');
      }
    });
    this._context.globalState.update('localAI.chatSessions', this._sessions);
    this._context.globalState.update('localAI.currentSessionId', this._currentSessionId);
    this._sendSessionsList();
  }

  _usage(session) {
    if (!session.usage) {
      session.usage = { main: { prompt: 0, output: 0 }, agents: [] };
    }
    return session.usage;
  }

  _addModelNotice(session, previous, current) {
    const running = this._runs.has(session.id);
    let text = current
      ? `Model changed: ${previous || 'none'} \u2192 ${current}`
      : `Model removed (was ${previous || 'none'}). Pick a model to continue.`;
    if (current && !modelSupportsTools(current) && this._context.globalState.get('localAI.agentEnabled', true)) {
      text += ' (this model cannot use tools: it saves code into your project files but cannot read them on its own)';
    }
    if (running) text += ' - takes effect from your next message';
    session.history.push({ role: 'notice', content: text });
    session.lastModel = current;
    this._persistSessions(session);
    this._postFor(session, { type: 'notice', text });
  }

  _onModelChanged({ previous, current }) {
    this._sendModelInfo();
    const session = this._currentSession();
    if (session && session.history.some((m) => m.role === 'user')) {
      this._addModelNotice(session, previous, current);
    }
  }

  _postUsage(session) {
    this._postFor(session, { type: 'usage', usage: this._usage(session) });
  }

  _postFor(session, message) {
    if (session.id === this._currentSessionId) this._post(message);
  }

  _sendCurrentHistory() {
    const session = this._currentSession();
    const run = this._runs.get(session.id);
    this._post({ type: 'loadHistory', history: session.history, running: !!run });
    this._post({ type: 'usage', usage: this._usage(session) });
    if (!run) return;
    if (run.currentTool) {
      this._post(run.currentTool);
      if (run.permission) this._post(run.permission);
    } else if (run.streaming) {
      this._post({ type: 'assistantStart', modelName: run.modelName, supportsVision: isVisionModel(run.modelName), hideCode: true });
      if (run.partial) this._post({ type: 'assistantToken', text: run.partial });
    }
  }

  _sendSessionsList() {
    const list = this._sessions
      .map((s) => ({
        id: s.id,
        title: s.title,
        updatedAt: s.updatedAt,
        isCurrent: s.id === this._currentSessionId,
        running: this._runs.has(s.id)
      }));
    this._post({ type: 'sessionsList', sessions: list });
  }

  _newChat() {
    const session = this._createSessionObject();
    this._sessions.push(session);
    this._currentSessionId = session.id;
    this._persistSessions();
    this._sendCurrentHistory();
    this._sendModelInfo();
  }

  _switchSession(id) {
    if (!this._sessions.some((s) => s.id === id)) return;
    this._currentSessionId = id;
    this._context.globalState.update('localAI.currentSessionId', this._currentSessionId);
    this._sendSessionsList();
    this._sendCurrentHistory();
    this._sendModelInfo();
  }

  _deleteSession(id) {
    const idx = this._sessions.findIndex((s) => s.id === id);
    if (idx === -1) return;
    this._stopSession(id);
    this._sessions.splice(idx, 1);
    this._grantsBySession.delete(id);

    if (this._sessions.length === 0) {
      this._sessions = [this._createSessionObject()];
    }

    if (id === this._currentSessionId) {
      const next = this._sessions[Math.min(idx, this._sessions.length - 1)];
      this._currentSessionId = next.id;
      this._sendCurrentHistory();
      this._sendModelInfo();
    }

    this._persistSessions();
  }

  _stopSession(id) {
    const run = this._runs.get(id);
    if (!run) return;
    run.stopped = true;
    run.aborts.forEach((abort) => abort());
    if (this._tools) this._tools.cancelAll();
    for (const permissionId of [...run.pending]) {
      this._resolvePermission(permissionId, 'deny');
    }
  }

  dispose() {
    this._stopAll();
    voice.cancelAll();
    this._panel.dispose();
  }

  _stopAll() {
    for (const id of [...this._runs.keys()]) this._stopSession(id);
  }

  async _startOllamaServer() {
    const reply = (ok, text) => this._post({ type: 'serverStartResult', ok, text });

    if (await this._ollamaClient.ping()) {
      reply(true, 'Ollama is already running - try sending your message again.');
      return;
    }

    const result = ollamaProcess.startServer();
    if (!result.started && result.reason === 'not-installed') {
      reply(false, 'Ollama is not installed. Open the Local Full AI sidebar to install it.');
      return;
    }
    if (!result.started && result.reason !== 'already-running') {
      reply(false, `Could not start Ollama: ${result.reason}`);
      return;
    }

    for (let i = 0; i < 20; i++) {
      if (await this._ollamaClient.ping()) {
        reply(true, 'Ollama server started - try sending your message again.');
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 600));
    }
    reply(false, 'Ollama was started but is not answering yet. Try again in a few seconds.');
  }

  _workspaceRoot() {
    return resolveWorkspaceRoot();
  }

  _getTools() {
    if (!workspaceLib.isTrusted()) return null;
    const root = workspaceLib.resolveWorkingRoot();
    if (!root) return null;
    try {
      const policy = workspaceLib.buildPolicy(root);
      if (workspaceLib.levelFor(root, policy.rules, policy.roots) === 'none') return null;
      if (!this._tools || this._tools.root !== fs.realpathSync(root)) {
        if (this._tools) this._tools.cancelAll();
        this._tools = new WorkspaceTools(root, policy);
      } else {
        this._tools.setPolicy(policy);
      }
      return this._tools;
    } catch (_) {
      return null;
    }
  }

  _folderLevel() {
    const root = workspaceLib.resolveWorkingRoot();
    if (!root) return null;
    const policy = workspaceLib.buildPolicy(root);
    return workspaceLib.levelFor(root, policy.rules, policy.roots);
  }

  _skills() {
    const config = vscode.workspace.getConfiguration('localAI');
    if (config.get('useClaudeSkills') === false) return [];
    return skillsLib.loadSkills({
      workspaceRoot: this._workspaceRoot(),
      extraFolders: config.get('extraSkillFolders') || []
    });
  }

  _sendModelInfo() {
    const modelName = this._context.globalState.get('localAI.selectedModel') || null;
    const root = workspaceLib.resolveWorkingRoot();
    this._post({
      type: 'modelInfo',
      folderLevel: this._folderLevel(),
      modelName,
      supportsVision: isVisionModel(modelName),
      workspaceName: root ? path.basename(root) : null,
      agentEnabled: this._context.globalState.get('localAI.agentEnabled', true),
      trusted: workspaceLib.isTrusted(),
      permissionMode: this._context.globalState.get('localAI.permissionMode', 'ask'),
      toolsUnsupported: modelName ? this._noToolsModels.has(modelName) || !modelSupportsTools(modelName) : false,
      filesMode: !!(modelName && (this._noToolsModels.has(modelName) || !modelSupportsTools(modelName)) && this._context.globalState.get('localAI.agentEnabled', true) && this._getTools()),
      voiceReady: voice.status().ready,
      skills: this._skills().map((sk) => ({ name: sk.name, description: sk.description }))
    });
  }

  _voiceError(err) {
    const permissionHint = err.noAudio
      ? ' Check System Settings > Privacy & Security > Microphone and allow Visual Studio Code (or the app you started it from), then try again.'
      : '';
    this._post({ type: 'voiceError', text: `${err.message}${permissionHint}`, setup: !!err.needsSetup });
  }

  _cancelVoice() {
    if (this._voiceTimer) clearTimeout(this._voiceTimer);
    this._voiceTimer = null;
    if (this._recording) {
      this._recording.cancel();
      this._recording = null;
    }
    this._post({ type: 'voiceState', state: 'idle' });
  }

  async _toggleVoice() {
    if (this._recording) {
      const recording = this._recording;
      this._recording = null;
      if (this._voiceTimer) clearTimeout(this._voiceTimer);
      this._voiceTimer = null;
      this._post({ type: 'voiceState', state: 'busy' });
      try {
        const wav = await recording.stop();
        const language = vscode.workspace.getConfiguration('localAI').get('voiceLanguage') || 'auto';
        const text = await voice.transcribe(wav, language);
        this._post({ type: 'voiceResult', text });
      } catch (err) {
        this._voiceError(err);
      }
      this._post({ type: 'voiceState', state: 'idle' });
      return;
    }

    const lacking = voice.missing();
    if (lacking.length) {
      const err = new Error(`Voice input needs: ${lacking.join(', ')}. It works fully offline afterwards.`);
      err.needsSetup = true;
      this._voiceError(err);
      return;
    }

    try {
      this._recording = await voice.startRecording();
    } catch (err) {
      this._voiceError(err);
      return;
    }
    this._post({ type: 'voiceState', state: 'recording' });
    const current = this._recording;
    this._voiceTimer = setTimeout(() => {
      if (this._recording === current) this._toggleVoice();
    }, VOICE_MAX_MS);
  }

  _revealFile(tools, relPath) {
    try {
      const abs = tools.resolve(relPath);
      vscode.workspace.openTextDocument(abs).then(
        (doc) => vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preserveFocus: true, preview: true }),
        () => {}
      );
    } catch (_) {
    }
  }

  async _openWorkspaceFile(relPath) {
    const tools = this._getTools();
    if (!tools || !relPath) return;
    try {
      const abs = tools.resolve(relPath);
      if (!fs.existsSync(abs)) return;
      const doc = await vscode.workspace.openTextDocument(abs);
      await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preserveFocus: false });
    } catch (_) {
    }
  }

  async _handleAttachFile(kind) {
    const modelName = this._context.globalState.get('localAI.selectedModel');
    const supportsVision = isVisionModel(modelName);

    if (kind === 'image' && !supportsVision) {
      vscode.window.showWarningMessage(
        `The model "${modelName}" does not support image understanding. Pick a vision model (e.g. gemma3) to attach pictures.`
      );
      return;
    }

    const extensions = kind === 'image'
      ? ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']
      : TEXT_FILE_EXTENSIONS;

    const root = this._workspaceRoot();
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: true,
      openLabel: 'Attach',
      defaultUri: root ? vscode.Uri.file(root) : undefined,
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
          this._post({
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
          this._post({
            type: 'fileAttached',
            kind: 'text',
            name: fileName,
            content,
            truncated,
            language: LANGUAGE_BY_EXTENSION[ext] || ''
          });
        }
      } catch (err) {
        this._post({
          type: 'error',
          text: `Could not read the file "${fileName}": ${err.message}`
        });
      }
    }
  }

  seedMessage(text) {
    this._post({ type: 'seed', text });
  }

  async _handleUserMessage(text, attachments) {
    const session = this._currentSession();
    if (this._runs.has(session.id)) return;
    const modelName = this._context.globalState.get('localAI.selectedModel');
    if (!modelName) {
      this._post({
        type: 'error',
        text: 'Pick a model in the Local Full AI sidebar first.'
      });
      return;
    }

    if (session.lastModel && session.lastModel !== modelName && session.history.some((m) => m.role === 'user')) {
      this._addModelNotice(session, session.lastModel, modelName);
    }
    session.lastModel = modelName;

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

    const slash = text.match(/^\/([\w.-]+)(?:\s+([\s\S]*))?$/);
    const slashSkill = slash ? skillsLib.findSkill(this._skills(), slash[1]) : null;
    if (slashSkill) {
      let instructions = '';
      try {
        instructions = skillsLib.readSkill(slashSkill);
      } catch (_) {
      }
      contentParts.push(
        `Follow the instructions of the skill "${slashSkill.name}" for this task.\n\n${instructions}\n\nTask: ${slash[2] || 'Apply the skill to the current context.'}`
      );
    } else {
      contentParts.push(text);
    }
    userMessage.content = contentParts.join('\n\n');

    userMessage.display = {
      text,
      includedActiveFile: includeActiveFile && !!vscode.window.activeTextEditor,
      attachments: attachmentList
        .filter((att) => att.kind === 'text')
        .map((att) => ({ kind: 'text', name: att.name, language: att.language, content: att.content }))
    };
    session.history.push(userMessage);
    this._persistSessions(session);
    this._post({
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

    await this._maybeAskAccess(session);
    await this._streamAssistantReply(modelName, session);
  }

  async _maybeAskAccess(session) {
    const off = this._context.globalState.get('localAI.agentEnabled', true) === false;
    if (!off || session.accessPrompted || !workspaceLib.isTrusted() || !workspaceLib.resolveWorkingRoot()) return;
    session.accessPrompted = true;
    const id = `a${++this._toolCounter}`;
    const answer = await new Promise((resolve) => {
      this._pendingPermissions.set(id, (decision, extra) => resolve({ decision, extra }));
      this._post({
        type: 'toolQuestion',
        id,
        question: 'Project access is off, so I can only answer in the chat and cannot create or change files. Turn it on?',
        options: ['Yes, turn on project access', 'No, only chat']
      });
    });
    if (answer.decision === 'answer' && /^yes/i.test(answer.extra || '')) {
      await this._context.globalState.update('localAI.agentEnabled', true);
      this._sendModelInfo();
      this._post({ type: 'notice', text: 'Project access is on. I can now create and edit files in your project.' });
    }
  }

  async _regenerate() {
    const session = this._currentSession();
    if (this._runs.has(session.id)) return;
    const modelName = this._context.globalState.get('localAI.selectedModel');
    if (!modelName) {
      this._post({
        type: 'error',
        text: 'Pick a model in the Local Full AI sidebar first.'
      });
      return;
    }

    const history = session.history;
    while (history.length > 0 && history[history.length - 1].role !== 'user') {
      history.pop();
    }
    this._persistSessions(session);

    await this._streamAssistantReply(modelName, session);
  }

  _contextSize() {
    const configured = vscode.workspace.getConfiguration('localAI').get('contextSize');
    return Number(configured) >= 2048 ? Number(configured) : DEFAULT_CONTEXT_SIZE;
  }

  _permissionMode() {
    return this._context.globalState.get('localAI.permissionMode', 'ask');
  }

  _multiAgentEnabled() {
    return vscode.workspace.getConfiguration('localAI').get('multiAgent') !== false;
  }

  _systemPrompt(ctx) {
    const { tools, skills, run } = ctx;
    const autopilot = ctx.autopilot && !ctx.isSub;
    const parts = [];
    const late = [];

    if (ctx.isSub && ctx.reader) {
      parts.push('You are a research helper without tools, working for a lead agent. The relevant project files are included below. Answer the assigned question using only them. Reply with a compact report: findings, file names and a clear answer. Do not ask questions and do not write JSON.');
      const context = this._readerContext(ctx);
      if (context) parts.push(context);
    } else if (ctx.isSub) {
      parts.push(
        ctx.subMode === 'worker'
          ? 'You are a worker agent helping a lead agent. Do exactly the assigned task inside the project, verify it (run tests or the build when they exist), then reply with a short report: what you changed, which files, and anything left open. Never ask questions; make reasonable choices.'
          : 'You are a research agent helping a lead agent. Use only the read tools to investigate the project. Reply with a compact report: findings, exact file paths and line numbers, and a clear answer to the assigned question. Never ask questions.'
      );
      if (tools) late.push(`Project folder: "${path.basename(tools.root)}". Paths are relative to its root.\n\nProject structure:\n${tools.overview()}`);
    } else if (ctx.filesMode) {
      parts.push(buildFilesPrompt(path.basename(tools.root)));
      late.push(`Folders you may use:\n${tools.accessSummary()}\n\nProject structure:\n${tools.overview()}`);
      const current = this._filesContext(ctx);
      if (current) late.push(current);
    } else {
      parts.push(buildAgentPrompt(tools ? path.basename(tools.root) : null));
      if (tools) late.push(`Folders you may use (paths outside the main folder must be absolute):\n${tools.accessSummary()}\n\nProject structure (first levels; use list_files to go deeper):\n${tools.overview()}`);
      if (tools && (ctx.session.writtenFiles || []).length) {
        late.push(`Files you created or changed in this chat (continue from them when the user asks for corrections): ${ctx.session.writtenFiles.join(', ')}`);
      }
      if (tools) {
        const current = this._filesContext(ctx);
        if (current) late.push(current);
      }
      if (tools && ctx.canDelegate) {
        parts.push(
          'Helper agents: for a big investigation or a self-contained sub-job, call delegate_task (mode "research" to read, "worker" to change). Give the helper full instructions because it cannot see this chat. Delegate independent jobs in the same turn so they run in parallel. Do small tasks yourself.'
        );
      }
      if (!autopilot && ctx.toolsEnabled) {
        parts.push('If the request is ambiguous or you need a decision you cannot safely guess, call ask_user with one short question and 2-4 options instead of guessing. Do not ask about trivial details.');
      }
      if (autopilot) {
        parts.push([
          'AUTOPILOT MODE: the user has left and will not answer questions. Work on your own until the WHOLE task is finished and verified.',
          '- Start by calling update_plan with a short checklist, and keep it updated as you go.',
          '- Never stop to ask or chat. If something is unclear, pick the most reasonable option and mention it in the final summary.',
          '- Verify your work: run the tests, build or linter if the project has them, and fix what fails.',
          '- Commands that need sudo, push to git, or delete outside the project are blocked; find another way.',
          '- Only when every plan item is done, call finish_task with a summary. Plain text replies do not end the task.'
        ].join('\n'));
        if (run.task) late.push(`The user's task:\n${run.task}`);
        if (run.plan.length) late.push(`Current plan:\n${agentTools.formatPlan(run.plan)}`);
      }
    }

    if (skills.length > 0) parts.push(skillsLib.skillsPromptSection(skills));
    if (vscode.workspace.getConfiguration('localAI').get('useClaudeSkills') !== false) {
      const instructions = skillsLib.loadInstructions(this._workspaceRoot());
      if (instructions) parts.push(instructions);
    }
    const userSystemPrompt = this._context.globalState.get('localAI.systemPrompt') || '';
    if (userSystemPrompt) parts.push(userSystemPrompt);
    if (ctx.autoSkillsText && !ctx.isSub) late.push(ctx.autoSkillsText);
    const lang = languageNote(run.lang);
    return (lang && !ctx.isSub ? [lang, ...parts, ...late] : [...parts, ...late]).join('\n\n');
  }

  _toolDefinitions(ctx) {
    if (!ctx.toolsEnabled) return undefined;
    let defs = ctx.tools ? WorkspaceTools.definitions() : [];
    if (ctx.isSub && ctx.subMode === 'research') {
      defs = defs.filter((d) => agentTools.READ_ONLY_TOOLS.has(d.function.name));
    }
    if (ctx.skills.length) defs = [...defs, skillsLib.USE_SKILL_DEFINITION];
    if (!ctx.isSub) {
      if (ctx.tools && ctx.canDelegate) defs = [...defs, agentTools.DELEGATE_DEFINITION];
      if (ctx.autopilot) defs = [...defs, agentTools.PLAN_DEFINITION, agentTools.FINISH_DEFINITION];
      else defs = [...defs, agentTools.ASK_DEFINITION];
    }
    return defs.length ? defs : undefined;
  }

  _buildMessages(ctx) {
    const system = this._systemPrompt(ctx);
    const working = !!(ctx.filesMode || (ctx.toolsEnabled && ctx.tools));
    let visible = ctx.history.filter((m) => m.role !== 'notice' && m.role !== 'step');
    if (working && !ctx.isSub) {
      const lastUserIndex = visible.map((m) => m.role).lastIndexOf('user');
      visible = visible.map((m, i) => {
        if (m.role === 'assistant' && !m.tool_calls && typeof m.content === 'string') {
          return { ...m, content: m.content.replace(/\(saved `[^`]*`\)/g, '').replace(/```[\w+-]*[ \t]*\r?\n([\s\S]*?)```/g, (all, body) => (body.split('\n').length >= 8 ? '[code omitted, it lives in the project files]' : all)) };
        }
        if (i === lastUserIndex && !m.synthetic && typeof m.content === 'string' && !ctx.autopilot) {
          const reminder = ctx.filesMode
            ? `\n\n[Reminder: put all code into <file path="..."> blocks; the chat is only for short talk.${ctx.run.lang && ctx.run.lang !== 'English' ? ` Reply in ${ctx.run.lang}.` : ''}]`
            : `\n\n[Reminder: do the work with your tools in the project folder (write_file / edit_file). Do not write code or JSON in your reply.${ctx.run.lang && ctx.run.lang !== 'English' ? ` Reply to the user in ${ctx.run.lang}.` : ''}]`;
          return { ...m, content: m.content + reminder };
        }
        return m;
      });
    }
    const all = system ? [{ role: 'system', content: system }, ...visible] : visible;
    const { messages, trimmed } = trimMessagesToFit(all, Math.floor(this._contextSize() * CHARS_PER_TOKEN));
    return { messages: toOllamaMessages(messages), trimmed };
  }

  _keepAwake(run) {
    if (process.platform !== 'darwin') return;
    try {
      run.awake = spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' });
      run.awake.on('error', () => {
        run.awake = null;
      });
    } catch (_) {
      run.awake = null;
    }
  }

  async _streamAssistantReply(modelName, session) {
    const mode = this._permissionMode();
    const autopilot = mode === 'autopilot';
    const run = {
      stopped: false,
      aborts: new Set(),
      modelName,
      streaming: false,
      partial: '',
      currentTool: null,
      permission: null,
      pending: new Set(),
      plan: [],
      task: '',
      finished: false,
      awake: null
    };
    this._runs.set(session.id, run);
    this._sendSessionsList();

    const lastUser = [...session.history].reverse().find((m) => m.role === 'user' && !m.synthetic);
    run.task = lastUser ? displayTitle(lastUser).slice(0, 2000) : '';
    const detected = agentTools.detectLanguage(run.task);
    if (detected && detected !== 'Cyrillic') session.lang = detected;
    else if (detected === 'Cyrillic' && !session.lang) session.lang = 'Ukrainian';
    run.lang = session.lang || null;
    if (autopilot) this._keepAwake(run);

    const agentEnabled = this._context.globalState.get('localAI.agentEnabled', true);
    const nativeTools = !this._noToolsModels.has(modelName) && modelSupportsTools(modelName);
    const agentOn = agentEnabled && nativeTools;
    const tools = agentEnabled ? this._getTools() : null;
    const filesMode = agentEnabled && !nativeTools && !!tools;
    const skills = agentOn && !isSmallModel(modelName) ? this._skills() : [];
    const autoSkills = this._pickAutoSkills(session, run.task, modelName, nativeTools);

    const ctx = {
      session,
      run,
      modelName,
      history: session.history,
      tools,
      skills,
      autopilot,
      mode,
      isSub: false,
      subMode: null,
      filesMode,
      autoSkillsText: autoSkills.text,
      userText: run.task,
      canDelegate: this._multiAgentEnabled(),
      toolsEnabled: agentOn && (!!tools || skills.length > 0),
      usage: this._usage(session).main,
      label: '',
      ui: true,
      maxSteps: autopilot ? AUTOPILOT_MAX_STEPS : MAX_AGENT_STEPS,
      post: (message) => this._postFor(session, message),
      persist: () => this._persistSessions(session)
    };

    try {
      await this._agentLoop(ctx);
    } finally {
      if (run.awake) run.awake.kill();
      this._runs.delete(session.id);
      this._sendSessionsList();
      ctx.post({ type: 'replyDone' });
      if (autopilot && !run.stopped) {
        vscode.window.showInformationMessage(
          run.finished ? 'Local Full AI: the task is finished.' : 'Local Full AI: autopilot stopped, open the chat to see why.'
        );
      }
    }
  }

  async _callModel(ctx, messages) {
    const { run, post } = ctx;
    const defs = this._toolDefinitions(ctx);
    const maxAttempts = ctx.autopilot ? MAX_RETRIES : 1;

    for (let attempt = 1; ; attempt++) {
      try {
        return await this._ollamaClient.chatStream(
          ctx.modelName,
          messages,
          (token) => {
            if (!ctx.ui) return;
            run.partial += token;
            post({ type: 'assistantToken', text: token });
          },
          {
            onAbortReady: (abortFn) => {
              run.aborts.add(abortFn);
              ctx.currentAbort = abortFn;
            },
            keepAlive: this._context.globalState.get('localAI.keepAlive') || undefined,
            numCtx: this._contextSize(),
            generation: generationLib.options(),
            tools: defs,
            onThinking: () => ctx.ui && post({ type: 'assistantThinking' }),
            onStats: (stats) => {
              if (ctx.usage) {
                ctx.usage.prompt += stats.promptEvalCount || 0;
                ctx.usage.output += stats.evalCount || 0;
                this._postUsage(ctx.session);
              }
              if (ctx.ui) post({ type: 'generationStats', stats });
            }
          }
        );
      } catch (err) {
        if (run.stopped) return { content: '', toolCalls: [] };
        if (/does not support tools/i.test(err.message)) throw err;
        if (attempt >= maxAttempts) throw err;
        const refused = err.code === 'ECONNREFUSED' || /ECONNREFUSED/.test(err.message);
        if (refused) ollamaProcess.startServer();
        post({
          type: 'contextTrimmed',
          text: `Model error (${err.message}). Retrying ${attempt}/${maxAttempts - 1}...`
        });
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * (refused ? 2 : 1)));
        if (run.stopped) return { content: '', toolCalls: [] };
      } finally {
        if (ctx.currentAbort) run.aborts.delete(ctx.currentAbort);
      }
    }
  }

  async _agentLoop(ctx) {
    const { run, history, post } = ctx;
    const fakeUser = (content) => history.push({ role: 'user', content, synthetic: true });
    let nudges = 0;
    let dumpNudges = 0;
    let wrote = false;
    let delegated = false;
    let repeatWarnings = 0;
    const recent = [];
    let lastText = '';

    for (let step = 0; step < ctx.maxSteps; step++) {
      if (run.stopped) return lastText;

      if (ctx.ui) {
        run.streaming = true;
        run.partial = '';
        post({ type: 'assistantStart', modelName: ctx.modelName, supportsVision: isVisionModel(ctx.modelName), hideCode: !!(ctx.filesMode || (ctx.toolsEnabled && ctx.tools)) });
      }

      const { messages, trimmed } = this._buildMessages(ctx);
      if (trimmed && ctx.ui) {
        post({
          type: 'contextTrimmed',
          text: 'This conversation got long - older messages were trimmed to fit the model\'s context window.'
        });
      }

      let result;
      try {
        result = await this._callModel(ctx, messages);
      } catch (err) {
        run.streaming = false;
        if (ctx.ui) post({ type: 'assistantEnd' });
        if (ctx.toolsEnabled && /does not support tools/i.test(err.message)) {
          this._noToolsModels.add(ctx.modelName);
          ctx.toolsEnabled = false;
          this._sendModelInfo();
          post({
            type: 'contextTrimmed',
            text: `${ctx.modelName} cannot use tools, so it can't read or edit your project. Pick a model tagged "tools" for that.`
          });
          step--;
          continue;
        }
        const isConnRefused = err.code === 'ECONNREFUSED' || /ECONNREFUSED/.test(err.message);
        post({
          type: 'error',
          text: isConnRefused ? "Could not reach Ollama - the server isn't running." : `Error: ${err.message}`,
          showStartServer: isConnRefused
        });
        if (ctx.isSub) throw err;
        return lastText;
      }
      run.streaming = false;

      let content = result.content;
      let toolCalls = run.stopped ? [] : result.toolCalls;

      if (toolCalls.length === 0 && ctx.toolsEnabled && !run.stopped) {
        const defs = this._toolDefinitions(ctx) || [];
        const extracted = agentTools.extractTextToolCalls(content, new Set(defs.map((d) => d.function.name)));
        if (extracted) {
          toolCalls = extracted.calls;
          content = '';
          if (ctx.ui) post({ type: 'assistantDiscard' });
        }
      }

      if (ctx.filesMode && !run.stopped && toolCalls.length === 0) {
        const saved = await this._saveCodeAsFiles(ctx, content);
        if (saved !== null) return saved;
        if (agentTools.looksLikeTask(run.task) && !agentTools.endsWithQuestion(content) && dumpNudges < MAX_DUMP_NUDGES) {
          dumpNudges++;
          if (ctx.ui) post({ type: 'assistantDiscard' });
          fakeUser('[system] Do not explain how to do it. Output the complete files now, each in a <file path="..."> block, and add one or two short sentences.');
          ctx.persist();
          continue;
        }
      }

      if (toolCalls.some((c) => c.function && ['write_file', 'edit_file'].includes(c.function.name))) wrote = true;
      if (toolCalls.some((c) => c.function && c.function.name === 'delegate_task')) delegated = true;

      const hasFiles = (ctx.session.writtenFiles || []).length > 0;
      const asksContent = agentTools.asksForFileContent(content);
      const isQuestion = agentTools.endsWithQuestion(content) && !asksContent;
      const shouldAct =
        (agentTools.looksLikeTask(run.task) || agentTools.looksLikeFollowUpEdit(run.task, hasFiles)) &&
        (!isQuestion || dumpNudges === 0);
      const needsDelegate =
        ctx.canDelegate && ctx.toolsEnabled && ctx.tools && !ctx.isSub && !delegated && toolCalls.length === 0 &&
        agentTools.mentionsAgents(run.task);
      const failedAttempt =
        ctx.toolsEnabled && ctx.tools && !ctx.isSub && toolCalls.length === 0 && !wrote &&
        (agentFiles.hasCodeDump(content) || agentTools.looksLikeToolAttempt(content) || shouldAct || needsDelegate);
      if (failedAttempt) {
        if (dumpNudges < MAX_DUMP_NUDGES) {
          dumpNudges++;
          if (ctx.ui) post({ type: 'assistantDiscard' });
          let message = '[system] Do not explain how to do it, do not ask the user to do it and do not ask which action to take: the request is clear. If you truly need information, call ask_user. Otherwise do the task yourself now: call write_file to create or replace a file, or edit_file to change an existing one, in the project folder. Then reply with one or two short sentences.';
          if (agentTools.looksLikeToolAttempt(content)) {
            message = '[system] You wrote a tool call as text. Do not write JSON in your reply: call the tool function itself (write_file with "path" and "content"). Do it now.';
          } else if (agentFiles.hasCodeDump(content)) {
            message = '[system] Do not paste code into the chat. Put it into the project files: call write_file to create or replace a file, or edit_file to change an existing one. Then reply with one or two short sentences. Do it now.';
          }
          if (needsDelegate) {
            message = '[system] The user asked for helper agents. Call the delegate_task tool now, once per helper (give each a short "title", full "task" instructions including the file names, and mode "research"). Do not just say that you will; make the calls. After their reports arrive, summarize them.';
          }
          if (asksContent) {
            message = '[system] Do not ask the user for the file content: you can read it yourself with read_file (or it is shown in your instructions). Read it if needed, then change the file with write_file (full updated content). Do it now.';
          }
          fakeUser(message + (run.lang && run.lang !== 'English' ? ` Reply to the user in ${run.lang}.` : ''));
          ctx.persist();
          continue;
        }
        const saved = await this._saveCodeAsFiles(ctx, content);
        if (saved !== null) return saved;
        if (shouldAct) {
          if (ctx.ui) post({ type: 'assistantDiscard' });
          const forced = await this._forcedFilesPass(ctx);
          if (forced !== null) return forced;
        }
      }

      if (!ctx.isSub && (ctx.filesMode || (ctx.toolsEnabled && ctx.tools)) && agentFiles.hasCodeDump(content)) {
        content = agentFiles.stripLongCode(content);
        if (ctx.ui) post({ type: 'assistantReplace', text: content });
      }

      if (content || toolCalls.length > 0) {
        const assistantMessage = { role: 'assistant', content };
        if (toolCalls.length > 0) assistantMessage.tool_calls = toolCalls;
        history.push(assistantMessage);
        ctx.persist();
      }
      if (content) lastText = content;
      if (ctx.ui) post({ type: 'assistantEnd' });

      if (run.stopped) return lastText;

      if (toolCalls.length === 0) {
        if (shouldAct && !wrote && ctx.toolsEnabled && ctx.tools && !ctx.isSub && !ctx.autopilot) {
          const text = 'No file was changed in this reply: the model only described the change. Ask again, or switch to a stronger model.';
          history.push({ role: 'notice', content: text });
          ctx.persist();
          post({ type: 'notice', text });
        }
        if (!ctx.autopilot || ctx.isSub || run.finished) return lastText;
        nudges++;
        if (nudges > MAX_NUDGES) {
          post({ type: 'contextTrimmed', text: 'Autopilot stopped: the model keeps replying without finishing the task.' });
          return lastText;
        }
        const left = run.plan.filter((it) => !it.done);
        fakeUser(
          `[autopilot] The task is not finished: you have not called finish_task. ${
            left.length ? `Unfinished plan items:\n${agentTools.formatPlan(left)}\n` : 'Call update_plan if you have no plan yet.\n'
          }Keep working with tools. When everything is done and verified, call finish_task.`
        );
        ctx.persist();
        post({ type: 'contextTrimmed', text: `Autopilot: continuing the task (${nudges}/${MAX_NUDGES})...` });
        continue;
      }
      nudges = 0;

      const results = await this._executeToolBatch(toolCalls, ctx);
      results.forEach((r) => {
        const toolMessage = { role: 'tool', tool_name: r.name, content: truncate(r.output, MAX_TOOL_RESULT_CHARS) };
        if (r.diff) {
          toolMessage.diff = capDiff(r.diff);
          toolMessage.meta = { path: r.diffMeta && r.diffMeta.path };
        }
        history.push(toolMessage);
      });
      ctx.persist();

      if (run.finished) {
        if (run.summary) {
          history.push({ role: 'assistant', content: run.summary });
          ctx.persist();
          post({ type: 'assistantStart', modelName: ctx.modelName });
          post({ type: 'assistantToken', text: run.summary });
          post({ type: 'assistantEnd' });
        }
        return run.summary || lastText;
      }

      if (ctx.autopilot && !ctx.isSub) {
        toolCalls.forEach((c) => recent.push(`${c.function && c.function.name}:${JSON.stringify(c.function && c.function.arguments)}`));
        recent.splice(0, Math.max(0, recent.length - 8));
        const worst = Math.max(...recent.map((sig) => recent.filter((x) => x === sig).length));
        if (worst >= 4) {
          repeatWarnings++;
          recent.length = 0;
          if (repeatWarnings > MAX_REPEAT_WARNINGS) {
            post({ type: 'contextTrimmed', text: 'Autopilot stopped: the model is stuck repeating the same action.' });
            return lastText;
          }
          fakeUser('[autopilot] You are repeating the same action without progress. Try a different approach, or if the work is done call finish_task.');
          ctx.persist();
        }
      }
    }

    post({
      type: 'contextTrimmed',
      text: `Stopped after ${ctx.maxSteps} steps. Send a message to let me continue.`
    });
    return lastText;
  }

  async _executeToolBatch(calls, ctx) {
    const results = new Array(calls.length);
    let i = 0;
    while (i < calls.length) {
      if (ctx.run.stopped) {
        for (let k = i; k < calls.length; k++) {
          results[k] = { name: (calls[k].function && calls[k].function.name) || 'unknown', output: 'Cancelled by the user.' };
        }
        break;
      }
      const isDelegate = (c) => c.function && c.function.name === 'delegate_task';
      if (isDelegate(calls[i])) {
        let j = i;
        while (j < calls.length && isDelegate(calls[j])) j++;
        const group = await Promise.all(calls.slice(i, j).map((c) => this._executeToolCall(c, ctx)));
        group.forEach((r, k) => {
          results[i + k] = r;
        });
        i = j;
      } else {
        results[i] = await this._executeToolCall(calls[i], ctx);
        i++;
      }
    }
    return results;
  }

  async _executeToolCall(call, ctx) {
    const { run, tools, skills, post } = ctx;
    const name = (call.function && call.function.name) || 'unknown';
    const args = normalizeArgs(call.function && call.function.arguments);
    const id = `t${++this._toolCounter}`;
    const noPathTools = ['use_skill', 'delegate_task', 'update_plan', 'finish_task', 'ask_user'];
    const permission = noPathTools.includes(name) || !tools
      ? null
      : WorkspaceTools.permissionFor(name);

    const baseLabel = {
      use_skill: `Skill ${args.name || ''}`,
      delegate_task: `Agent: ${args.title || 'helper'}`,
      update_plan: 'Plan',
      finish_task: 'Finish task',
      ask_user: `Question: ${args.question || ''}`
    }[name] || (tools ? tools.label(name, args) : name);

    const start = {
      type: 'toolStart',
      id,
      name,
      label: `${ctx.label}${baseLabel}`,
      path: noPathTools.includes(name) ? null : args.path || null
    };
    if (!ctx.isSub) run.currentTool = start;
    post(start);
    if (ctx.onProgress) ctx.onProgress(baseLabel);

    let output;
    let ok = true;
    let denied = false;
    let diff = null;
    let diffMeta = null;

    const grants = this._grantsFor(ctx.session.id);
    const access = permission && tools ? tools.access(name, args) : { allowed: true };
    if (!access.allowed) {
      denied = true;
      ok = false;
      output = `Blocked by the user's folder access settings: ${access.reason}`;
    } else if (access.forceAsk && ctx.mode === 'autopilot') {
      denied = true;
      ok = false;
      output = 'This folder is set to "ask first" but autopilot cannot ask. Leave it unchanged and mention it in the summary.';
    } else if (permission && ctx.mode === 'readonly') {
      denied = true;
      ok = false;
      output = 'Permission denied: the user set read-only mode. You can only read and search. Tell the user what you would change instead.';
    } else if (permission === 'command' && ctx.mode === 'autopilot' && agentTools.dangerousCommand(args.command)) {
      denied = true;
      ok = false;
      output = 'Blocked: this command is not allowed in autopilot (sudo, git push, destructive deletes, publishing). Find another way, or leave it out and mention it in the summary.';
    } else if (
      permission &&
      ctx.mode !== 'autopilot' &&
      (access.forceAsk || (!(ctx.mode === 'auto' && permission === 'edit') && !grants.has(permission)))
    ) {
      const answer = await this._askPermission(ctx, id, name, args, permission);
      if (answer.decision === 'always') {
        if (!access.forceAsk) grants.add(permission);
      } else if (answer.decision !== 'allow') {
        denied = true;
        ok = false;
        output = answer.extra
          ? `Permission denied by the user. The user says: "${answer.extra}". Do what they say instead.`
          : 'Permission denied by the user. Do not retry this action; ask the user how to proceed.';
      }
    }

    if (!denied) {
      try {
        if (name === 'use_skill') {
          const skill = skillsLib.findSkill(skills, args.name);
          if (!skill) throw new Error(`No skill named "${args.name}". Available: ${skills.map((sk) => sk.name).join(', ')}`);
          output = skillsLib.readSkill(skill, args.file);
        } else if (name === 'update_plan') {
          run.plan = agentTools.parsePlanItems(args.items);
          output = agentTools.formatPlan(run.plan);
        } else if (name === 'finish_task') {
          const open = run.plan.filter((it) => !it.done);
          if (open.length) {
            throw new Error(`Cannot finish, these plan items are not done:\n${agentTools.formatPlan(open)}\nFinish them, or call update_plan to drop them.`);
          }
          run.finished = true;
          run.summary = String(args.summary || '').trim();
          output = 'Task marked complete.';
        } else if (name === 'ask_user') {
          const answer = await this._askUser(ctx, id, args);
          if (answer.decision === 'answer' && answer.extra) {
            output = `The user answered: "${answer.extra}"`;
          } else {
            ok = false;
            output = 'The user dismissed the question without answering. Use your best judgment, or stop and explain what you need.';
          }
        } else if (name === 'delegate_task') {
          output = await this._runSubAgent(args, ctx, id);
        } else if (!tools) {
          throw new Error('No project folder is open, so this tool is unavailable');
        } else {
          const existedBefore = name === 'write_file' && args.path ? fs.existsSync(tools.resolve(args.path)) : true;
          const isEdit = (name === 'write_file' || name === 'edit_file') && args.path;
          const beforeText = isEdit ? tools.snapshot(args.path) : null;
          output = await tools.run(name, args);
          if (isEdit) {
            const afterText = tools.snapshot(args.path);
            if (afterText !== null) {
              diff = WorkspaceTools.diff(beforeText, afterText);
              const abs = tools.resolve(args.path);
              beforeContent.remember(id, { rel: tools.relative(abs), abs, before: beforeText });
              diffMeta = { id, path: tools.relative(abs), hasBefore: beforeText !== null };
            }
          }
          if (name === 'write_file' && !existedBefore) this._revealFile(tools, args.path);
          if (name === 'write_file' || name === 'edit_file') {
            this._rememberFile(ctx.session, tools.relative(tools.resolve(args.path)));
            if (/\.(html?|m?js)$/i.test(String(args.path || ''))) {
              const found = projectCheck.format(projectCheck.run(tools));
              if (found) output += `\n\nAutomatic check after this change found problems in the project:\n${found}\nFix the ones that relate to the task.`;
            }
          }
        }
      } catch (err) {
        ok = false;
        output = `Error: ${err.message}`;
      }
    }

    if (!ctx.isSub) run.currentTool = null;
    post({ type: 'toolResult', id, ok, denied, diff, diffMeta, output: truncate(output, name === 'delegate_task' ? 3000 : 1500) });
    return { name, output, ok, denied, diff, diffMeta };
  }

  _pickAutoSkills(session, task, modelName, nativeTools) {
    const config = vscode.workspace.getConfiguration('localAI');
    if (config.get('useClaudeSkills') === false || config.get('autoSkills') === false) return { text: '', names: [] };
    if (/^\/[\w.-]+/.test(String(task || '').trim())) return { text: '', names: [] };
    const small = isSmallModel(modelName) || !nativeTools;
    let picks = [];
    try {
      picks = skillsLib.selectSkills(this._skills(), task, { max: small ? 1 : 2 });
    } catch (_) {
      picks = [];
    }
    if (picks.length === 0) return { text: '', names: [] };
    const limit = small ? 2500 : 5000;
    const blocks = [];
    for (const skill of picks) {
      try {
        blocks.push(`### ${skill.name}\n${truncate(skillsLib.readSkill(skill), limit)}`);
      } catch (_) {
      }
    }
    const names = picks.map((x) => x.name);
    if (blocks.length === 0) return { text: '', names: [] };
    const previous = (session.lastSkills || []).join(',');
    if (previous !== names.join(',')) {
      session.lastSkills = names;
      const note = `Skills applied to this request: ${names.join(', ')}`;
      session.history.push({ role: 'notice', content: note });
      this._postFor(session, { type: 'notice', text: note });
    }
    return { text: `Relevant playbooks from the user's own skills for this request. Follow them where they apply:\n\n${blocks.join('\n\n')}`, names };
  }

  async _installedModels() {
    if (this._installedCache && Date.now() - this._installedCache.at < 20000) return this._installedCache.items;
    let items = [];
    try {
      items = (await this._ollamaClient.listLocalModels()).map((m) => ({ name: m.name, size: m.size || 0 }));
    } catch (_) {
      items = [];
    }
    this._installedCache = { at: Date.now(), items };
    return items;
  }

  async _chooseHelperModel(subMode, parentModel, session) {
    if (subMode === 'worker') return parentModel;
    const configured = String(vscode.workspace.getConfiguration('localAI').get('subagentModel') || '').trim();
    if (!configured) return parentModel;
    const installed = await this._installedModels();
    if (configured === 'auto') {
      const parentSize = (installed.find((m) => m.name === parentModel) || { size: Infinity }).size;
      const candidates = installed.filter((m) => m.size > 0.5e9 && m.size < parentSize).sort((a, b) => a.size - b.size);
      const withTools = candidates.filter((m) => modelSupportsTools(m.name) && !this._noToolsModels.has(m.name));
      const pick = withTools[0] || candidates[0];
      return pick ? pick.name : parentModel;
    }
    if (installed.some((m) => m.name === configured)) return configured;
    if (!session.helperWarned) {
      session.helperWarned = true;
      this._postFor(session, { type: 'notice', text: `The helper model ${configured} is not installed, so helpers use ${parentModel}.` });
    }
    return parentModel;
  }

  _readerContext(ctx) {
    const { tools } = ctx;
    if (!tools) return '';
    const task = (ctx.history[0] && ctx.history[0].content) || '';
    let picks = tools.findFilesByName(task, 5);
    if (picks.length === 0) picks = tools.listSourceFiles(5);
    let budget = CONTEXT_TOTAL_CHARS;
    const blocks = [];
    for (const rel of picks) {
      if (budget <= 0) break;
      let data = null;
      try {
        data = tools.readForContext(rel, Math.min(CONTEXT_FILE_CHARS, budget));
      } catch (_) {
        data = null;
      }
      if (!data) continue;
      budget -= data.text.length;
      blocks.push(`### ${rel}${data.truncated ? ' (shortened)' : ''}\n\`\`\`\n${data.text}\n\`\`\``);
    }
    return `Project structure:\n${tools.overview()}\n\nFiles:\n\n${blocks.join('\n\n') || '(no readable files)'}`;
  }

  async _runSubAgent(args, parentCtx, callId) {
    if (parentCtx.isSub) throw new Error('Helper agents cannot start other agents');
    if (!args.task) throw new Error('"task" is required');
    const wantsWorker = args.mode === 'worker';
    if (wantsWorker && parentCtx.mode === 'readonly') {
      throw new Error('Read-only mode: only research helpers are allowed');
    }
    const subMode = wantsWorker ? 'worker' : 'research';
    const model = await this._chooseHelperModel(subMode, parentCtx.modelName, parentCtx.session);
    const helperHasTools = modelSupportsTools(model) && !this._noToolsModels.has(model);
    const reader = !helperHasTools;
    const title = args.title || 'helper';
    const entry = {
      id: callId,
      title,
      mode: subMode,
      model,
      steps: 0,
      prompt: 0,
      output: 0,
      status: 'running'
    };
    this._usage(parentCtx.session).agents.push(entry);
    this._postUsage(parentCtx.session);

    const subCtx = {
      ...parentCtx,
      isSub: true,
      subMode,
      canDelegate: false,
      autopilot: parentCtx.autopilot,
      modelName: model,
      toolsEnabled: parentCtx.toolsEnabled && helperHasTools,
      reader,
      history: [{ role: 'user', content: String(args.task) }],
      label: `[${title}] `,
      ui: false,
      maxSteps: SUBAGENT_MAX_STEPS[subMode],
      usage: entry,
      persist: () => {},
      onProgress: (text) => {
        entry.steps++;
        parentCtx.post({ type: 'toolProgress', id: callId, text: `${entry.steps}. ${text}` });
        this._postUsage(parentCtx.session);
      }
    };

    parentCtx.post({
      type: 'toolProgress',
      id: callId,
      text: `Model: ${model}${model !== parentCtx.modelName ? ' (helper model)' : ''}${reader ? ', reads the files directly without tools' : ''}`
    });

    let report;
    try {
      report = await this._agentLoop(subCtx);
    } catch (err) {
      entry.status = 'failed';
      this._postUsage(parentCtx.session);
      this._persistSessions(parentCtx.session);
      throw err;
    }
    entry.status = parentCtx.run.stopped ? 'stopped' : 'done';
    this._postUsage(parentCtx.session);
    this._persistSessions(parentCtx.session);
    if (parentCtx.run.stopped) return 'Cancelled by the user.';
    return truncate(report || '(the helper returned no report)', MAX_SUBAGENT_REPORT_CHARS);
  }

  async _saveCodeAsFiles(ctx, content) {
    const { history, post, run } = ctx;
    const parsed = agentFiles.extractFiles(content);
    if (parsed.files.length === 0) return null;
    if (parsed.trailing) {
      history.push({ role: 'assistant', content: parsed.trailing });
      ctx.persist();
    }
    if (ctx.ui) {
      post({ type: 'assistantReplace', text: parsed.trailing });
      post({ type: 'assistantEnd' });
    }
    for (const file of parsed.files) {
      if (run.stopped) break;
      const result = await this._executeToolCall(
        { function: { name: 'write_file', arguments: { path: file.path, content: file.content } } },
        ctx
      );
      history.push({
        role: 'step',
        name: 'write_file',
        path: file.path,
        ok: result.ok,
        denied: !!result.denied,
        output: truncate(result.output, 400),
        diff: capDiff(result.diff)
      });
      ctx.persist();
    }
    return parsed.trailing || ' ';
  }

  async _forcedFilesPass(ctx) {
    const { post, run, tools } = ctx;
    post({ type: 'notice', text: 'The model did not edit the files by itself, so I am asking it to write the full files directly...' });
    const langHint = run.lang && run.lang !== 'English' ? ` Write the short text in ${run.lang}.` : '';
    const system = [
      buildFilesPrompt(path.basename(tools.root)),
      `Folders you may use:\n${tools.accessSummary()}\n\nProject structure:\n${tools.overview()}`,
      this._filesContext(ctx),
      ctx.autoSkillsText,
      languageNote(run.lang)
    ].filter(Boolean).join('\n\n');
    const messages = [
      { role: 'system', content: system },
      { role: 'user', content: `${run.task}\n\n[Reminder: put the complete updated files into <file path="..."> blocks. No explanations of how to do it.${langHint}]` }
    ];
    let result;
    try {
      result = await this._ollamaClient.chatStream(ctx.modelName, messages, () => {}, {
        onAbortReady: (abortFn) => run.aborts.add(abortFn),
        keepAlive: this._context.globalState.get('localAI.keepAlive') || undefined,
        numCtx: this._contextSize(),
        generation: generationLib.options()
      });
    } catch (_) {
      return null;
    }
    if (process.env.LOCALAI_DEBUG) console.log('[forced pass raw output]', JSON.stringify(result.content.slice(0, 700)), '| len', result.content.length);
    if (run.stopped) return null;
    return this._saveCodeAsFiles(ctx, result.content);
  }

  _rememberFile(session, relPath) {
    if (!relPath) return;
    session.writtenFiles = (session.writtenFiles || []).filter((f) => f !== relPath);
    session.writtenFiles.push(relPath);
    if (session.writtenFiles.length > 12) session.writtenFiles.shift();
  }

  _filesContext(ctx) {
    const { tools, session } = ctx;
    if (!tools) return '';
    const picks = [];
    const add = (rel) => {
      if (rel && !picks.includes(rel)) picks.push(rel);
    };
    (session.writtenFiles || []).slice(-5).reverse().forEach(add);
    tools.findFilesByName(ctx.userText || '', 3).forEach(add);
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document.uri.scheme === 'file') {
      try {
        add(tools.relative(tools.resolve(editor.document.uri.fsPath)));
      } catch (_) {
      }
    }

    let budget = CONTEXT_TOTAL_CHARS;
    const blocks = [];
    for (const rel of picks) {
      if (budget <= 0) break;
      let data = null;
      try {
        data = tools.readForContext(rel, Math.min(CONTEXT_FILE_CHARS, budget));
      } catch (_) {
        data = null;
      }
      if (!data) continue;
      budget -= data.text.length;
      blocks.push(`### ${rel}${data.truncated ? ' (shortened, the file is longer)' : ''}\n\`\`\`\n${data.text}\n\`\`\``);
    }
    if (!blocks.length) return '';
    return `Current contents of the files you are working on (the user may have changed them by hand since you wrote them, so continue from THIS version):\n\n${blocks.join('\n\n')}`;
  }

  _grantsFor(sessionId) {
    if (!this._grantsBySession.has(sessionId)) {
      this._grantsBySession.set(sessionId, new Set());
    }
    return this._grantsBySession.get(sessionId);
  }

  _waitForUser(ctx, id, message) {
    const { run } = ctx;
    return new Promise((resolve) => {
      this._pendingPermissions.set(id, (decision, extra) => {
        run.pending.delete(id);
        run.permission = null;
        resolve({ decision, extra });
      });
      run.pending.add(id);
      run.permission = message;
      ctx.post(message);
    });
  }

  _askPermission(ctx, id, name, args, permission) {
    return this._waitForUser(ctx, id, {
      type: 'toolPermission',
      id,
      permission,
      label: ctx.tools.label(name, args),
      preview: ctx.tools.preview(name, args)
    });
  }

  _askUser(ctx, id, args) {
    const options = Array.isArray(args.options)
      ? args.options.map((o) => String(o).trim()).filter(Boolean).slice(0, 4)
      : [];
    return this._waitForUser(ctx, id, {
      type: 'toolQuestion',
      id,
      question: String(args.question || 'The assistant needs more information.'),
      options
    });
  }

  _resolvePermission(id, decision, extra) {
    const resolve = this._pendingPermissions.get(id);
    if (!resolve) return;
    this._pendingPermissions.delete(id);
    resolve(decision, extra);
  }

  _getHtml() {
    const media = (...parts) =>
      this._panel.webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, 'media', ...parts));
    const icon = (name) => JSON.stringify(ICONS[name] || '').replace(/</g, '\\u003c');
    const iconNames = Object.keys(ICONS);
    const iconMap = `{${iconNames.map((n) => `${JSON.stringify(n)}:${icon(n)}`).join(',')}}`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="stylesheet" href="${media('chat', 'chat.css')}" />
</head>
<body>
  <div id="tabbar">
    <button id="chatTitleBtn" title="Switch chat"><span id="chatTitle">New chat</span>${ICONS.chevronDown}</button>
    <div class="tabbar-spacer"></div>
    <button class="chip" id="workspaceChip" title="Project access" style="display:none;"></button>
    <button class="icon-button" id="newChatBtn" title="New chat">${ICONS.plus}</button>
  </div>
  <div id="sessionMenu" style="display:none;"></div>
  <div id="messages"></div>
  <div id="dialogDock"></div>
  <div id="attachmentPreview"></div>
  <div id="inputWrap">
    <textarea id="input" rows="1" placeholder="Ask anything about your project..."></textarea>
    <div id="inputTools">
      <div class="input-tools-left">
        <button class="tool-btn" id="plusBtn" title="Attach files">${ICONS.plus}</button>
        <button class="tool-btn" id="slashBtn" title="Skills (type / in the box)"><span class="slash-glyph">/</span></button>
        <button class="pill" id="modelChip" title="Change model"></button>
        <button class="pill" id="usageBtn" title="Helper agents and tokens" style="display:none;"></button>
      </div>
      <button class="tool-btn" id="micBtn" title="Voice input">${ICONS.mic}</button>
      <button class="pill" id="modeBtn" title="What the AI may do without asking"></button>
      <button id="stopBtn" title="Stop generating">${ICONS.stop}</button>
      <button id="sendBtn" title="Send">${ICONS.send}</button>
    </div>
  </div>

<script>window.ICONS = ${iconMap};</script>
<script src="${media('vendor', 'highlight.min.js')}"></script>
<script src="${media('chat', 'chat.js')}"></script>
</body>
</html>`;
  }
}

module.exports = { ChatPanel };
