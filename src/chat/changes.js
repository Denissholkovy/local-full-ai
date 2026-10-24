const { vscode, fs, path } = require('./common');

// How many requests back the files can be restored (per chat).
const MAX_CHECKPOINTS = 20;

function restore(c) {
  if (c.before === null) {
    if (fs.existsSync(c.abs)) fs.unlinkSync(c.abs);
  } else {
    fs.writeFileSync(c.abs, c.before, 'utf8');
  }
}

function removeFile(file) {
  try {
    fs.unlinkSync(file);
  } catch (_) {
  }
}

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
      const file = path.join(dir, `${session.id}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.json`);
      fs.writeFileSync(file, JSON.stringify(changes));
      return { file, files: changes.map((c) => ({ rel: c.rel, isNew: c.before === null })) };
    } catch (_) {
      return null;
    }
  },

  // Every request that changed files leaves a checkpoint, tied to the user message that started it.
  _addCheckpoint(session, userIndex, record) {
    session.checkpoints = [...(session.checkpoints || []), { userIndex, file: record.file, files: record.files }];
    while (session.checkpoints.length > MAX_CHECKPOINTS) removeFile(session.checkpoints.shift().file);
    session.lastChanges = record;
  },

  _readUndo(record) {
    if (!record) return null;
    if (Array.isArray(record)) return record;
    try {
      return JSON.parse(fs.readFileSync(record.file, 'utf8'));
    } catch (_) {
      return null;
    }
  },

  _loadUndo(session) {
    return this._readUndo(session.lastChanges);
  },

  _dropUndo(session) {
    const files = new Set((session.checkpoints || []).map((c) => c.file));
    if (session.lastChanges && session.lastChanges.file) files.add(session.lastChanges.file);
    files.forEach(removeFile);
    session.checkpoints = [];
    session.lastChanges = null;
  },

  _forgetCheckpoint(session, file) {
    removeFile(file);
    session.checkpoints = (session.checkpoints || []).filter((c) => c.file !== file);
    if (session.lastChanges && session.lastChanges.file === file) session.lastChanges = null;
  },

  async _revertChanges() {
    const session = this._currentSession();
    const changes = this._loadUndo(session);
    if (!changes || !changes.length || this._runs.has(session.id)) return;
    const touched = changes.filter((c) => {
      try {
        return !c.binary && fs.existsSync(c.abs) && fs.readFileSync(c.abs, 'utf8') !== c.after;
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
        restore(c);
      } catch (err) {
        failed.push(`${c.rel}: ${err.message}`);
      }
    }
    if (!failed.length && session.lastChanges) this._forgetCheckpoint(session, session.lastChanges.file);
    const text = failed.length ? `Could not undo everything: ${failed.join('; ')}` : `Undone: ${changes.length} file${changes.length > 1 ? 's' : ''} restored to how they were before the request.`;
    session.history.push({ role: 'notice', content: text });
    this._persistSessions(session);
    this._post({ type: 'changesSummary', files: failed.length ? changes.map((c) => ({ rel: c.rel, isNew: c.before === null })) : [] });
    this._post({ type: 'notice', text });
  },

  // "Edit" on one of the user's messages: that message and everything after it go away, its text goes back
  // into the input, and (if the user wants) the files the AI changed since then are restored.
  async _editMessage(ordinal) {
    const session = this._currentSession();
    if (!session || this._runs.has(session.id)) return;
    const userIndexes = [];
    session.history.forEach((m, i) => {
      if (m.role === 'user' && !m.synthetic) userIndexes.push(i);
    });
    const index = userIndexes[ordinal];
    if (index === undefined) return;
    const message = session.history[index];
    const text = (message.display && message.display.text) || (typeof message.content === 'string' ? message.content : '');

    const later = (session.checkpoints || []).filter((c) => c.userIndex >= index);
    let undoFiles = false;
    if (later.length) {
      const files = [...new Set(later.flatMap((c) => c.files.map((f) => f.rel)))];
      const choice = await vscode.window.showWarningMessage(
        `Edit this message? It and the ${session.history.length - index - 1} entries after it are removed from the chat. The AI changed ${files.length} file${files.length > 1 ? 's' : ''} since then: ${files.slice(0, 8).join(', ')}${files.length > 8 ? '...' : ''}.`,
        { modal: true },
        'Undo those file changes too',
        'Keep the files as they are'
      );
      if (!choice) return;
      undoFiles = choice === 'Undo those file changes too';
    }

    const failed = [];
    if (undoFiles) {
      for (const checkpoint of later.slice().reverse()) {
        for (const c of this._readUndo(checkpoint) || []) {
          try {
            restore(c);
          } catch (err) {
            failed.push(`${c.rel}: ${err.message}`);
          }
        }
      }
    }
    later.forEach((c) => this._forgetCheckpoint(session, c.file));
    session.lastChanges = null;
    session.history.splice(index);
    if ((session.summaryUpTo || 0) > index) {
      session.summary = null;
      session.summaryUpTo = 0;
    }
    if (failed.length) session.history.push({ role: 'notice', content: `Could not restore everything: ${failed.join('; ')}` });
    this._persistSessions(session);
    this._sendCurrentHistory();
    this._post({ type: 'seed', text });
  }
};
