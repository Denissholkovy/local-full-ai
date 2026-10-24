const { vscode, path, capabilities, cloud } = require('./common');
const { SemanticIndex } = require('../semanticIndex');

const MODEL_RECHECK_MS = 5 * 60 * 1000;
const INDEX_BUDGET_MS = 45000;

const DEFINITION = {
  type: 'function',
  function: {
    name: 'semantic_search',
    description: 'Find code by meaning when you do not know the exact names, for example "where is the login handled" or "code that sends emails". Returns file paths, line ranges and a short snippet. For exact names use search_text.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What the code does, in plain words' },
        limit: { type: 'number', description: 'How many places to return (default 8)' }
      },
      required: ['query']
    }
  }
};

// Methods mixed into ChatPanel.prototype (see chatPanel.js).
module.exports = {
  // The local embedding model to use, or null (setting "off", or none installed).
  async _embeddingModel() {
    const setting = String(vscode.workspace.getConfiguration('localAI').get('embeddingModel') || '').trim();
    if (setting === 'off') return null;
    if (setting && setting !== 'auto') return setting;
    const cached = this._embedModelCache;
    if (cached && Date.now() - cached.at < MODEL_RECHECK_MS) return cached.name;
    let name = null;
    try {
      const installed = (await this._ollamaClient.listLocalModels()).filter((m) => !cloud.isOllamaCloud(m.name)).sort((a, b) => a.size - b.size);
      for (const m of installed) {
        await this._ensureLocalCaps(m.name);
        if (capabilities.localCap(m.name, 'embedding')) {
          name = m.name;
          break;
        }
      }
    } catch (_) {
    }
    this._embedModelCache = { at: Date.now(), name };
    return name;
  },

  _semanticIndex(model) {
    if (!this._semantic || this._semantic.model !== model) {
      const storageDir = path.join(this._context.globalStorageUri.fsPath, 'semantic');
      this._semantic = new SemanticIndex({ storageDir, client: this._ollamaClient, model });
    }
    return this._semantic;
  },

  async _semanticSearch(ctx, args) {
    if (!ctx.embedModel) throw new Error('No embedding model is installed.');
    const index = this._semanticIndex(ctx.embedModel);
    const state = await index.update(ctx.tools, {
      budgetMs: INDEX_BUDGET_MS,
      onProgress: (done, total) => ctx.ui && ctx.post({ type: 'contextTrimmed', text: `Indexing the project for meaning search: ${done} of ${total} files...` })
    });
    const limit = Math.min(20, Math.max(1, Number(args.limit) || 8));
    const hits = await index.search(ctx.tools, args.query, limit);
    if (!hits.length) return 'No matches. The project may have no indexable files yet.';
    const text = hits.map((h) => `${h.rel}:${h.start}-${h.end} (match ${h.score.toFixed(2)})\n${h.snippet}`).join('\n\n');
    return state.pending > 0
      ? `${text}\n\n(The index is still being built: ${state.pending} files are not searched yet. Use search_text if you miss something.)`
      : text;
  },

  _semanticDefinition() {
    return DEFINITION;
  }
};
