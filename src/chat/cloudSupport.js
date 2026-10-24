const consent = require('../consent');
const { vscode, modelState, generationLib, cloud, cloudLimits, DEFAULT_CONTEXT_SIZE, capabilities } = require('./common');

// Keeping the model loaded between messages avoids reloading it (often longer than the answer itself).
const DEFAULT_KEEP_ALIVE = '30m';

// Methods mixed into ChatPanel.prototype (see chatPanel.js).
module.exports = {
  _ensureCloudConsent(modelName) {
    return consent.ensure(this._context, modelName);
  },

  _cloudBudget(modelName) {
    if (cloud.isLocalServer(modelName)) return this._contextSize();
    const configured = Number(vscode.workspace.getConfiguration('localAI').get('cloudContextSize'));
    const setting = configured >= 2048 ? configured : 12000;
    const parsed = cloud.parseName(modelName);
    if (!parsed) return setting;
    const cap = cloudLimits.getModelCap(parsed.providerId, parsed.modelId);
    if (cap) return Math.max(800, Math.min(setting, Math.floor(cap * 0.6)));
    const seen = cloudLimits.get(parsed.providerId, parsed.modelId);
    const perMinute = seen && seen.items.find((i) => /tokens(-minute)?$/.test(i.scope) && i.limit > 0);
    if (perMinute) return Math.max(3500, Math.min(setting, Math.floor(perMinute.limit * 0.4)));
    return ['groq', 'openrouter'].includes(parsed.providerId) ? Math.min(setting, 5000) : setting;
  },

  _contextSize(modelName) {
    if (modelName && cloud.isCloudModel(modelName)) return this._cloudBudget(modelName);
    const configured = vscode.workspace.getConfiguration('localAI').get('contextSize');
    const wanted = Number(configured) >= 2048 ? Number(configured) : DEFAULT_CONTEXT_SIZE;
    // Asking for more than the model was trained on only wastes memory and confuses it.
    const max = modelName ? capabilities.localContextLength(modelName) : 0;
    return max >= 2048 ? Math.min(wanted, max) : wanted;
  },

  // Asks Ollama once per model version what it can do (tools, vision, thinking, context length).
  _ensureLocalCaps(modelName) {
    return capabilities.learnLocal(this._ollamaClient, modelName, (map) => this._context.globalState.update('localAI.localCaps', map));
  },

  _clientFor(modelName) {
    return cloud.isCloudModel(modelName) ? this._cloud : this._ollamaClient;
  },

  _modelOptions(modelName, extra) {
    if (cloud.isCloudModel(modelName)) {
      return {
        ...extra,
        maxTokens: this._cloudBudget(modelName) <= 8000 ? 4096 : 8192,
        failFast: this._autoFallback() && this._fallbackModels(modelName).length > 0,
        generation: generationLib.options()
      };
    }
    return {
      ...extra,
      keepAlive: this._context.globalState.get('localAI.keepAlive') || DEFAULT_KEEP_ALIVE,
      numCtx: this._contextSize(modelName),
      think: capabilities.localCap(modelName, 'thinking') ? generationLib.think(modelName, capabilities.canSwitchThinking(modelName)) : undefined,
      canThink: capabilities.localCap(modelName, 'thinking') === true,
      thinkBudget: generationLib.thinkBudget(modelName),
      generation: generationLib.options()
    };
  },

  _autoFallback() {
    return vscode.workspace.getConfiguration('localAI').get('cloudAutoFallback') === true;
  },

  // With auto fallback on, a limit or overload error moves the run to the next cloud model. Returns true when it switched.
  async _switchAfterLimit(ctx, err) {
    if (ctx.isSub || !this._autoFallback() || !cloud.isCloudModel(ctx.modelName) || cloud.isLocalServer(ctx.modelName)) return false;
    if (!/limit|quota|overloaded|busy|rate|\b(429|502|503|529)\b/i.test(String(err && err.message))) return false;
    ctx.run.tried = ctx.run.tried || new Set();
    ctx.run.tried.add(ctx.modelName);
    const next = this._fallbackModels(ctx.modelName).find((m) => !ctx.run.tried.has(m.name));
    if (!next || !(await this._ensureCloudConsent(next.name))) return false;
    ctx.post({ type: 'contextTrimmed', text: `${ctx.modelName.split(':').slice(2).join(':')} is at its limit, so this answer continues with ${next.label} (${next.provider}).` });
    ctx.modelName = next.name;
    ctx.run.modelName = next.name;
    ctx.compact = this._cloudBudget(next.name) <= 8000;
    return true;
  },

  // Other cloud models the user already added, other providers first: offered after a failure.
  _fallbackModels(failed) {
    const failedProvider = (cloud.parseName(failed) || {}).providerId;
    const all = this._context.globalState.get('localAI.cloudModels', []).filter((m) => m.name !== failed);
    const tiny = (m) => { const cap = cloudLimits.getModelCap(m.providerId, m.modelId); return cap && cap < 3000; };
    const rank = (m) => (m.providerId !== failedProvider ? 0 : 1) + (cloud.rank(m.modelId) === 'weak' ? 2 : 0) + (tiny(m) ? 4 : 0);
    return all
      .slice()
      .sort((a, b) => rank(a) - rank(b))
      .slice(0, 3)
      .map((m) => ({ name: m.name, label: m.modelId, provider: this._cloudProviderName(m.name) }));
  },

  async _switchAndRetry(modelName) {
    const known = this._context.globalState.get('localAI.cloudModels', []).some((m) => m.name === modelName);
    if (!known) return;
    const session = this._currentSession();
    if (this._runs.has(session.id)) return;
    await modelState.setSelectedModel(this._context, modelName);
    this._sendCurrentHistory();
    await this._regenerate();
  },

  _limitsMessage(modelName, entry) {
    const parsed = cloud.parseName(modelName);
    const def = parsed && cloud.provider(parsed.providerId);
    return {
      type: 'cloudLimits',
      providerId: parsed ? parsed.providerId : '',
      provider: def ? def.name : '',
      hasLimitsPage: !!(def && def.limitsUrl),
      at: entry ? entry.at : 0,
      retryAfter: entry ? entry.retryAfter : '',
      items: entry ? entry.items : []
    };
  },

  _cloudProviderName(modelName) {
    const parsed = cloud.parseName(modelName);
    const def = parsed && cloud.provider(parsed.providerId);
    return def ? def.name : null;
  },
};
