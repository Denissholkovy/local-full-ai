const { vscode, path, truncate, agentTools, agentFiles, CONTEXT_FILE_CHARS, CONTEXT_TOTAL_CHARS, languageNote, capDiff, buildFilesPrompt } = require('./common');

// Methods mixed into ChatPanel.prototype (see chatPanel.js).
module.exports = {
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
      if (!file.content.trim()) continue;
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
  },

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
      result = await this._clientFor(ctx.modelName).chatStream(ctx.modelName, messages, () => {}, this._modelOptions(ctx.modelName, {
        onAbortReady: (abortFn) => run.aborts.add(abortFn)
      }));
    } catch (_) {
      return null;
    }
    if (process.env.LOCALAI_DEBUG) console.log('[forced pass raw output]', JSON.stringify(result.content.slice(0, 700)), '| len', result.content.length);
    if (run.stopped) return null;
    return this._saveCodeAsFiles(ctx, result.content);
  },

  _rememberFile(session, relPath) {
    if (!relPath) return;
    session.writtenFiles = (session.writtenFiles || []).filter((f) => f !== relPath);
    session.writtenFiles.push(relPath);
    if (session.writtenFiles.length > 12) session.writtenFiles.shift();
  },

  _filesContext(ctx) {
    const { tools, session } = ctx;
    if (!tools) return '';
    const perFile = ctx.compact ? 2200 : CONTEXT_FILE_CHARS;
    const total = ctx.compact ? 5000 : CONTEXT_TOTAL_CHARS;
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

    let snapshot = false;
    if (picks.length === 0 && !ctx.isSub && (agentTools.looksLikeTask(ctx.userText) || agentTools.looksLikeFollowUpEdit(ctx.userText, true))) {
      tools.listSourceFiles(ctx.compact ? 3 : 5).forEach(add);
      snapshot = picks.length > 0;
    }

    let budget = total;
    const blocks = [];
    for (const rel of picks) {
      if (budget <= 0) break;
      let data = null;
      try {
        data = tools.readForContext(rel, Math.min(perFile, budget));
      } catch (_) {
        data = null;
      }
      if (!data) continue;
      budget -= data.text.length;
      blocks.push(`### ${rel}${data.truncated ? ' (shortened, the file is longer)' : ''}\n\`\`\`\n${data.text}\n\`\`\``);
    }
    if (!blocks.length) return '';
    const heading = snapshot
      ? 'The project files (shown so you do not need to search for them; read others with read_file):'
      : 'Current contents of the files you are working on (the user may have changed them by hand since you wrote them, so continue from THIS version):';
    return `${heading}\n\n${blocks.join('\n\n')}`;
  },
};
