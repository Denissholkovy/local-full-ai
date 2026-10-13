const { vscode, fs } = require('./common');

// Methods mixed into ChatPanel.prototype (see chatPanel.js).
module.exports = {
  async _revertChanges() {
    const session = this._currentSession();
    const changes = session.lastChanges;
    if (!changes || !changes.length || this._runs.has(session.id)) return;
    const touched = changes.filter((c) => {
      try {
        return fs.existsSync(c.abs) && fs.readFileSync(c.abs, 'utf8') !== c.after;
      } catch (_) {
        return false;
      }
    });
    const list = changes.map((c) => `${c.before === null ? 'delete' : 'restore'} ${c.rel}`).join(', ');
    const choice = await vscode.window.showWarningMessage(
      `Undo all file changes of the last request? ${list}.` + (touched.length ? ` Note: ${touched.map((c) => c.rel).join(', ')} changed again after the AI edited it; those later edits are lost too.` : '') + ' Commands the AI ran are not undone.',
      { modal: true },
      'Undo changes'
    );
    if (choice !== 'Undo changes') return;
    const failed = [];
    for (const c of changes) {
      try {
        if (c.before === null) {
          if (fs.existsSync(c.abs)) fs.unlinkSync(c.abs);
        } else {
          fs.writeFileSync(c.abs, c.before, 'utf8');
        }
      } catch (err) {
        failed.push(`${c.rel}: ${err.message}`);
      }
    }
    session.lastChanges = failed.length ? changes : null;
    const text = failed.length ? `Could not undo everything: ${failed.join('; ')}` : `Undone: ${changes.length} file${changes.length > 1 ? 's' : ''} restored to how they were before the request.`;
    session.history.push({ role: 'notice', content: text });
    this._persistSessions(session);
    this._post({ type: 'changesSummary', files: failed.length ? changes.map((c) => ({ rel: c.rel, isNew: c.before === null })) : [] });
    this._post({ type: 'notice', text });
  },
};
