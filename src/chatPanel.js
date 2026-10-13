const { vscode, fs, path, ICONS, isVisionModel, isCloudModelName, ollamaProcess, WorkspaceTools, normalizeArgs, truncate, skillsLib, workspaceLib, resolveWorkspaceRoot, agentTools, voice, modelState, agentFiles, beforeContent, projectCheck, cloud, diagnostics, CloudClient, cloudLimits, spawn, MAX_TEXT_FILE_CHARS, MAX_TOOL_RESULT_CHARS, MAX_AGENT_STEPS, MAX_DUMP_NUDGES, AUTOPILOT_MAX_STEPS, MAX_NUDGES, MAX_REPEAT_WARNINGS, RETRY_DELAY_MS, MAX_RETRIES, CHARS_PER_TOKEN, trimMessagesToFit, modelSupportsTools, languageNote, isSmallModel, isTinyModel, displayTitle, capDiff, toOllamaMessages, buildCompactAgentPrompt, compactTools, buildAgentPrompt, buildFilesPrompt } = require('./chat/common');

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
    this._cloud = new CloudClient(context);
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
    const limitsWatcher = cloudLimits.onDidChange(({ providerId }) => {
      const selected = this._context.globalState.get('localAI.selectedModel');
      const parsed = cloud.parseName(selected);
      if (parsed && parsed.providerId === providerId) this._post(this._limitsMessage(selected, cloudLimits.get(providerId)));
    });
    const trustWatcher = vscode.workspace.onDidGrantWorkspaceTrust ? vscode.workspace.onDidGrantWorkspaceTrust(() => this._sendModelInfo()) : { dispose() {} };
    this._panel.onDidDispose(() => {
      folderWatcher.dispose();
      editorWatcher.dispose();
      modelWatcher.dispose();
      limitsWatcher.dispose();
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
      case 'attachContext':
        await this._attachContext(msg.kind);
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
      case 'revertChanges':
        await this._revertChanges();
        break;
      case 'switchModelAndRetry':
        await this._switchAndRetry(msg.model);
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
      case 'openCloudLimits': {
        const def = cloud.provider(msg.providerId);
        if (def && def.limitsUrl) vscode.env.openExternal(vscode.Uri.parse(def.limitsUrl));
        break;
      }
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
    if (message && (message.type === 'error' || message.type === 'contextTrimmed') && message.text) diagnostics.record(message.type, message.text);
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
    if (current && cloud.isCloudModel(current)) {
      text += ` Cloud model: your messages and the files it reads are sent to ${this._cloudProviderName(current)}.`;
    } else if (previous && cloud.isCloudModel(previous)) {
      text += ' Back to a local model: nothing leaves your computer.';
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
      cloudProvider: modelName ? this._cloudProviderName(modelName) : null,
      cloudLimits: modelName && cloud.isCloudModel(modelName) ? this._limitsMessage(modelName, cloudLimits.get((cloud.parseName(modelName) || {}).providerId)) : null,
      workspaceName: root ? path.basename(root) : null,
      agentEnabled: this._context.globalState.get('localAI.agentEnabled', true),
      trusted: workspaceLib.isTrusted(),
      permissionMode: this._context.globalState.get('localAI.permissionMode', 'ask'),
      toolsUnsupported: modelName ? this._noToolsModels.has(modelName) || !modelSupportsTools(modelName) : false,
      filesMode: !!(modelName && (this._noToolsModels.has(modelName) || !modelSupportsTools(modelName)) && this._context.globalState.get('localAI.agentEnabled', true) && this._getTools()),
      voiceReady: voice.status().ready && (voice.engine() !== 'groq' || this._groqKeyKnown()),
      voiceEngine: voice.engine(),
      skills: this._skills().map((sk) => ({ name: sk.name, description: sk.description }))
    });
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

    if (!(await this._ensureCloudConsent(modelName))) {
      this._post({ type: 'error', text: 'Cloud model not used. Pick a local model, or accept the notice to use the cloud one.' });
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
      if (imageBase64s.length > 0 && !isVisionModel(modelName)) {
        contentParts.push(`(${imageBase64s.length} picture(s) were attached but the current model cannot see images, so they were not sent.)`);
      } else if (imageBase64s.length > 0) {
        userMessage.images = isCloudModelName(modelName) ? imageBase64s.slice(0, 4) : imageBase64s;
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

    if (!(await this._ensureCloudConsent(modelName))) return;
    const history = session.history;
    while (history.length > 0 && history[history.length - 1].role !== 'user') {
      history.pop();
    }
    this._persistSessions(session);

    await this._streamAssistantReply(modelName, session);
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
      parts.push(ctx.compact && tools ? buildCompactAgentPrompt(path.basename(tools.root)) : buildAgentPrompt(tools ? path.basename(tools.root) : null));
      if (tools) late.push(ctx.compact
        ? `Project structure:\n${tools.overview(30, 1)}`
        : `Folders you may use (paths outside the main folder must be absolute):\n${tools.accessSummary()}\n\nProject structure (first levels; use list_files to go deeper):\n${tools.overview()}`);
      if (tools && (ctx.session.writtenFiles || []).length) {
        late.push(`Files you created or changed in this chat (continue from them when the user asks for corrections): ${ctx.session.writtenFiles.join(', ')}`);
      }
      if (tools) {
        const current = this._filesContext(ctx);
        if (current) late.push(current);
      }
      if (tools && ctx.canDelegate && !ctx.compact) {
        parts.push(
          'Helper agents: for a big investigation or a self-contained sub-job, call delegate_task (mode "research" to read, "worker" to change). Give the helper full instructions because it cannot see this chat. Delegate independent jobs in the same turn so they run in parallel. Do small tasks yourself.'
        );
      }
      if (!autopilot && ctx.toolsEnabled && !ctx.compact) {
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

    if (skills.length > 0 && !ctx.compact) parts.push(skillsLib.skillsPromptSection(skills));
    if (vscode.workspace.getConfiguration('localAI').get('useClaudeSkills') !== false && !ctx.compact) {
      const instructions = skillsLib.loadInstructions(this._workspaceRoot());
      if (instructions) parts.push(instructions);
    }
    const userSystemPrompt = this._context.globalState.get('localAI.systemPrompt') || '';
    if (userSystemPrompt) parts.push(userSystemPrompt);
    if (ctx.autoSkillsText && !ctx.isSub && !ctx.compact) late.push(ctx.autoSkillsText);
    const lang = languageNote(run.lang);
    return (lang && !ctx.isSub ? [lang, ...parts, ...late] : [...parts, ...late]).join('\n\n');
  }

  _toolDefinitions(ctx) {
    if (!ctx.toolsEnabled) return undefined;
    let defs = ctx.tools ? WorkspaceTools.definitions() : [];
    if (ctx.isSub && ctx.subMode === 'research') {
      defs = defs.filter((d) => agentTools.READ_ONLY_TOOLS.has(d.function.name));
    }
    if (ctx.skills.length && !ctx.compact) defs = [...defs, skillsLib.USE_SKILL_DEFINITION];
    if (!ctx.isSub) {
      const wantsAgents = agentTools.mentionsAgents(ctx.run.task);
      if (ctx.tools && ctx.canDelegate && (!ctx.compact || wantsAgents)) defs = [...defs, agentTools.DELEGATE_DEFINITION];
      if (ctx.autopilot) defs = [...defs, agentTools.PLAN_DEFINITION, agentTools.FINISH_DEFINITION];
      else if (!ctx.compact) defs = [...defs, agentTools.ASK_DEFINITION];
    }
    if (ctx.compact && defs.length) defs = compactTools(defs);
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
    const { messages, trimmed } = trimMessagesToFit(all, Math.floor(this._contextSize(ctx.modelName) * CHARS_PER_TOKEN));
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
      changes: new Map(),
      awake: null
    };
    session.lastChanges = null;
    this._postFor(session, { type: 'changesSummary', files: [] });
    this._runs.set(session.id, run);
    this._sendSessionsList();

    const lastUser = [...session.history].reverse().find((m) => m.role === 'user' && !m.synthetic);
    run.task = lastUser ? displayTitle(lastUser).slice(0, 2000) : '';
    if (isTinyModel(modelName) && !session.tinyWarned && agentTools.looksLikeTask(run.task)) {
      session.tinyWarned = true;
      this._postFor(session, { type: 'notice', text: `${modelName} is a very small model: it often invents files or says it changed something when it did not. For work on your project pick a 7B+ model (or a cloud model) and check the changes it makes.` });
    }
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
      compact: cloud.isCloudModel(modelName) && this._cloudBudget(modelName) <= 8000,
      autoSkillsText: autoSkills.text,
      userText: run.task,
      canDelegate: this._multiAgentEnabled() && !isTinyModel(modelName),
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
      if (run.changes.size > 0) {
        session.lastChanges = [...run.changes.values()];
        ctx.post({ type: 'changesSummary', files: session.lastChanges.map((c) => ({ rel: c.rel, isNew: c.before === null })) });
      }
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
        return await this._clientFor(ctx.modelName).chatStream(
          ctx.modelName,
          messages,
          (token) => {
            if (!ctx.ui) return;
            run.partial += token;
            post({ type: 'assistantToken', text: token });
          },
          this._modelOptions(ctx.modelName, {
            onAbortReady: (abortFn) => {
              run.aborts.add(abortFn);
              ctx.currentAbort = abortFn;
            },
            tools: defs,
            onNotice: (text) => post({ type: 'contextTrimmed', text }),
            onLimits: (seen) => this._postFor(ctx.session, this._limitsMessage(ctx.modelName, seen)),
            onThinking: () => ctx.ui && post({ type: 'assistantThinking' }),
            onStats: (stats) => {
              if (ctx.usage) {
                ctx.usage.prompt += stats.promptEvalCount || 0;
                ctx.usage.output += stats.evalCount || 0;
                this._postUsage(ctx.session);
              }
              if (ctx.ui) post({ type: 'generationStats', stats });
            }
          })
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
          showStartServer: isConnRefused,
          fallbacks: ctx.ui && !ctx.isSub && cloud.isCloudModel(ctx.modelName) && !run.stopped ? this._fallbackModels(ctx.modelName) : undefined
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
        let group;
        if (cloud.isCloudModel(ctx.modelName)) {
          // Free cloud limits are shared by all requests: helpers run one after another, not in parallel.
          group = [];
          for (const c of calls.slice(i, j)) group.push(await this._executeToolCall(c, ctx));
        } else {
          group = await Promise.all(calls.slice(i, j).map((c) => this._executeToolCall(c, ctx)));
        }
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
              if (!run.changes.has(abs)) run.changes.set(abs, { abs, rel: tools.relative(abs), before: beforeText });
              run.changes.get(abs).after = afterText;
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
    const uiLang = (() => {
      const setting = vscode.workspace.getConfiguration('localAI').get('language') || 'auto';
      if (setting === 'en' || setting === 'uk') return setting;
      return String(vscode.env.language || 'en').toLowerCase().startsWith('uk') ? 'uk' : 'en';
    })();
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
        <button class="pill" id="limitsBtn" title="Free-tier limits of the cloud provider" style="display:none;"></button>
        <button class="pill" id="usageBtn" title="Helper agents and tokens" style="display:none;"></button>
      </div>
      <button class="tool-btn" id="micBtn" title="Voice input">${ICONS.mic}</button>
      <button class="pill" id="modeBtn" title="What the AI may do without asking"></button>
      <button id="stopBtn" title="Stop generating">${ICONS.stop}</button>
      <button id="sendBtn" title="Send">${ICONS.send}</button>
    </div>
  </div>

<script>window.ICONS = ${iconMap}; window.__LANG = ${JSON.stringify(uiLang)};</script>
<script src="${media('i18n.js')}"></script>
<script src="${media('vendor', 'highlight.min.js')}"></script>
<script src="${media('chat', 'chat.js')}"></script>
</body>
</html>`;
  }
}

for (const mixin of ['subagents', 'voiceInput', 'attachments', 'cloudSupport', 'filesMode', 'changes']) {
  Object.assign(ChatPanel.prototype, require(`./chat/${mixin}`));
}

module.exports = { ChatPanel };
