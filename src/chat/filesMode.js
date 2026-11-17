const { path, truncate, agentFiles, languageNote, capDiff, buildFilesPrompt } = require('./common');

// Methods mixed into ChatPanel.prototype (see chatPanel.js).
module.exports = {
  async _saveCodeAsFiles(ctx, content) {
    const { history, post, run } = ctx;
    const { edits, rest } = agentFiles.extractEdits(content);
    const parsed = agentFiles.extractFiles(rest);
    if (parsed.files.length === 0 && edits.length === 0) return null;
    if (!parsed.files.length) parsed.trailing = parsed.text;
    run.saveErrors = [];
    if (parsed.trailing) {
      history.push({ role: 'assistant', content: parsed.trailing });
      ctx.persist();
    }
    if (ctx.ui) {
      post({ type: 'assistantReplace', text: parsed.trailing });
      post({ type: 'assistantEnd' });
    }
    // Targeted changes first, so a whole-file block for the same file (if any) still sees the result.
    for (const change of edits) {
      if (run.stopped) break;
      if (!change.search.trim()) {
        run.saveErrors.push(`${change.path}: the SEARCH part is empty. Copy a few existing lines of the file into SEARCH.`);
        continue;
      }
      const result = await this._executeToolCall(
        { function: { name: 'edit_file', arguments: { path: change.path, old_string: change.search, new_string: change.replace } } },
        ctx
      );
      history.push({
        role: 'step',
        name: 'edit_file',
        path: change.path,
        ok: result.ok,
        denied: !!result.denied,
        output: truncate(result.output, 400),
        diff: capDiff(result.diff)
      });
      if (!result.ok && !result.denied) run.saveErrors.push(`${change.path}: ${String(result.output).replace(/^Error:\s*/, '')}`);
      ctx.persist();
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
      if (!result.ok && !result.denied) run.saveErrors.push(`${file.path}: ${String(result.output).replace(/^Error:\s*/, '')}`);
      ctx.persist();
    }
    return parsed.trailing || ' ';
  },

  async _forcedFilesPass(ctx) {
    const { post, run, tools } = ctx;
    post({ type: 'notice', text: 'The model did not edit the files by itself, so I am asking it to write the full files directly...' });
    const langHint = run.lang && run.lang !== 'English' ? ` Write the short text in ${run.lang}.` : '';
    const system = [
      buildFilesPrompt(path.basename(tools.root), run.kind),
      `Folders you may use:\n${tools.accessSummary()}\n\nProject structure:\n${tools.overview()}`,
      this._filesContext(ctx),
      ...(run.contextNotes || []),
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
        kind: run.kind,
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
  }
};
