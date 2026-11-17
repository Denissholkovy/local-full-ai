const { vscode, fs, path, agentTools, CONTEXT_FILE_CHARS, CONTEXT_TOTAL_CHARS } = require('./common');
const problems = require('../problems');
const editorContext = require('../context/editor');
const retrieval = require('../context/retrieval');

// Indexing a new project for the meaning search must not hold up the first answer for long.
const RETRIEVAL_INDEX_MS = 4000;
const RETRIEVAL_HITS = 6;

// Methods mixed into ChatPanel.prototype (see chatPanel.js): everything the model is shown about the project
// besides the chat itself. Gathered once per request in `_gatherContext`, read by the system prompt builders.
module.exports = {
  // The files whose contents go into the prompt: written in this chat, named in the request, open in the editor,
  // and the scripts and styles of a page among them.
  _contextFilePicks(ctx) {
    const { tools, session } = ctx;
    const picks = [];
    const add = (rel) => {
      if (rel && !picks.includes(rel)) picks.push(rel);
    };
    (session.writtenFiles || []).slice(-5).reverse().forEach(add);
    if (!ctx.run.namedFiles) ctx.run.namedFiles = tools.findFilesByName(ctx.userText || '', 3);
    ctx.run.namedFiles.forEach(add);
    const editor = editorContext.currentEditor(vscode);
    if (editor) {
      try {
        add(tools.relative(tools.resolve(editor.document.uri.fsPath)));
      } catch (_) {
      }
    }

    picks.slice().forEach((rel) => {
      if (!/\.html?$/i.test(rel)) return;
      let html = '';
      try {
        html = fs.readFileSync(tools.resolve(rel), 'utf8');
      } catch (_) {
        return;
      }
      const re = /<script[^>]*\bsrc\s*=\s*["']([^"']+)["']|<link[^>]*\bhref\s*=\s*["']([^"']+\.css)["']/gi;
      let m;
      while ((m = re.exec(html)) !== null) {
        const ref = (m[1] || m[2]).split(/[?#]/)[0];
        if (/^(https?:)?\/\/|^data:/i.test(ref)) continue;
        try {
          const abs = path.resolve(path.dirname(tools.resolve(rel)), ref);
          if (fs.existsSync(abs)) add(tools.relative(abs));
        } catch (_) {
        }
      }
    });

    let snapshot = false;
    if (picks.length === 0 && !ctx.isSub && (agentTools.looksLikeTask(ctx.userText) || agentTools.looksLikeFollowUpEdit(ctx.userText, true))) {
      tools.listSourceFiles(ctx.compact ? 3 : 5).forEach(add);
      snapshot = picks.length > 0;
    }
    return { picks, snapshot };
  },

  _filesContext(ctx) {
    const { tools } = ctx;
    if (!tools) return '';
    const perFile = ctx.compact ? 2200 : CONTEXT_FILE_CHARS;
    const total = ctx.compact ? 5000 : CONTEXT_TOTAL_CHARS;
    const { picks, snapshot } = this._contextFilePicks(ctx);

    let budget = total;
    const blocks = [];
    const shown = new Set();
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
      if (!data.truncated) shown.add(rel);
      blocks.push(`### ${rel}${data.truncated ? ' (shortened, the file is longer)' : ''}\n\`\`\`\n${data.text}\n\`\`\``);
    }
    ctx.run.shownFiles = shown;
    if (!blocks.length) return '';
    const heading = snapshot
      ? 'The project files (shown so you do not need to search for them; read others with read_file):'
      : 'Current contents of the files you are working on (the user may have changed them by hand since you wrote them, so continue from THIS version):';
    return `${heading}\n\n${blocks.join('\n\n')}`;
  },

  // Taken once when the request starts: the editor can change while the model works.
  async _gatherContext(ctx) {
    const { tools, run } = ctx;
    run.contextNotes = [];
    if (!tools || ctx.isSub || ctx.compact || agentTools.isSmallTalk(ctx.userText)) return;
    this._filesContext(ctx);
    const editorNote = this._editorNote(ctx);
    if (editorNote) run.contextNotes.push(editorNote);
    try {
      const found = await this._retrieve(ctx);
      run.contextNotes.push(...found);
    } catch (_) {
    }
  },

  _editorNote(ctx) {
    const { tools } = ctx;
    const state = editorContext.readState(vscode);
    const relative = (abs) => {
      try {
        const rel = tools.relative(tools.resolve(abs));
        return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : null;
      } catch (_) {
        return null;
      }
    };
    const rel = state.file ? relative(state.file) : null;
    const found = rel ? problems.collect(tools.root, { only: new Set([state.file]), limit: 10 }) : [];
    return editorContext.describe(state, { relative, problems: found, shownInFull: !!rel && (ctx.run.shownFiles || new Set()).has(rel) });
  },

  // Code the request points at but the prompt does not show yet: exact names first, then a search by meaning.
  async _retrieve(ctx) {
    const { tools, run } = ctx;
    const notes = [];
    const names = retrieval.codeNames(ctx.userText);
    if (names.length) {
      const hits = [];
      for (const name of names) {
        let out = '';
        try {
          out = await tools.run('search_text', { query: name });
        } catch (_) {
          out = '';
        }
        hits.push({ name, lines: String(out).split('\n').filter((l) => /^[^:\s]+:\d+:/.test(l)) });
      }
      const text = retrieval.formatNameHits(hits);
      if (text) notes.push(text);
    }
    if (ctx.embedModel && !run.stopped) {
      const index = this._semanticIndex(ctx.embedModel);
      await index.update(tools, { budgetMs: RETRIEVAL_INDEX_MS });
      const hits = await index.search(tools, ctx.userText, RETRIEVAL_HITS);
      const text = retrieval.formatSnippets(hits, run.shownFiles || new Set());
      if (text) notes.push(text);
    }
    return notes;
  }
};
