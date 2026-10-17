const { vscode, fs, path } = require('./common');

// Methods mixed into ChatPanel.prototype (see chatPanel.js).
module.exports = {
  _undoDir() {
    const base = this._context.globalStorageUri ? this._context.globalStorageUri.fsPath : require('os').tmpdir();
    return path.join(base, 'undo');
  },

  // File contents before the request are kept on disk (not in the chat state), so Undo works after a restart.
  _saveUndo(session, changes) {
    const total = changes.reduce((n, c) => n + (c.before ? c.before.length : 0) + (c.after ? c.after.length : 0), 0);
    if (!changes.length || total > 8 * 1024 * 1024) return null;
    try {
      const dir = this._undoDir();
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${session.id}.json`);
      fs.writeFileSync(file, JSON.stringify(changes));
      return { file, files: changes.map((c) => ({ rel: c.rel, isNew: c.before === null })) };
    } catch (_) {
      return null;
    }
  },

  _loadUndo(session) {
    const saved = session.lastChanges;
    if (!saved) return null;
    if (Array.isArray(saved)) return saved;
    try {
      return JSON.parse(fs.readFileSync(saved.file, 'utf8'));
    } catch (_) {
      return null;
    }
  },

  _dropUndo(session) {
    const saved = session.lastChanges;
    if (saved && saved.file) {
      try {
        fs.unlinkSync(saved.file);
      } catch (_) {
      }
    }
    session.lastChanges = null;
  },

  async _revertChanges() {
    const session = this._currentSession();
    const changes = this._loadUndo(session);
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
    if (!failed.length) this._dropUndo(session);
    const text = failed.length ? `Could not undo everything: ${failed.join('; ')}` : `Undone: ${changes.length} file${changes.length > 1 ? 's' : ''} restored to how they were before the request.`;
    session.history.push({ role: 'notice', content: text });
    this._persistSessions(session);
    this._post({ type: 'changesSummary', files: failed.length ? changes.map((c) => ({ rel: c.rel, isNew: c.before === null })) : [] });
    this._post({ type: 'notice', text });
  },
};
