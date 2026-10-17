const { vscode, truncate, cloud, CONTEXT_FILE_CHARS, CONTEXT_TOTAL_CHARS, SUBAGENT_MAX_STEPS, MAX_SUBAGENT_REPORT_CHARS, modelSupportsTools } = require('./common');

// Methods mixed into ChatPanel.prototype (see chatPanel.js).
module.exports = {
  async _chooseHelperModel(subMode, parentModel, session) {
    if (subMode === 'worker' || subMode === 'verify') return parentModel;
    const configured = String(vscode.workspace.getConfiguration('localAI').get('subagentModel') || '').trim();
    if (!configured) return parentModel;
    if (cloud.isCloudModel(configured)) {
      const parsed = cloud.parseName(configured);
      return parsed && this._context.globalState.get(`localAI.cloudConsent.${parsed.providerId}`) ? configured : parentModel;
    }
    if (configured === 'auto' && cloud.isCloudModel(parentModel)) return parentModel;
    let installed;
    try {
      installed = await this._installedModels();
    } catch (_) {
      return parentModel;
    }
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
  },

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
  },

  async _runSubAgent(args, parentCtx, callId) {
    if (parentCtx.isSub) throw new Error('Helper agents cannot start other agents');
    if (!args.task) throw new Error('"task" is required');
    const wantsWorker = args.mode === 'worker';
    if (wantsWorker && parentCtx.mode === 'readonly') {
      throw new Error('Read-only mode: only research helpers are allowed');
    }
    const subMode = wantsWorker ? 'worker' : args.mode === 'verify' ? 'verify' : 'research';
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
      maxSteps: parentCtx.compact ? Math.min(SUBAGENT_MAX_STEPS[subMode], 8) : SUBAGENT_MAX_STEPS[subMode],
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
  },
};
