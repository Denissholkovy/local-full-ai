const { vscode, modelState, generationLib, cloud, cloudLimits, DEFAULT_CONTEXT_SIZE } = require('./common');

// Methods mixed into ChatPanel.prototype (see chatPanel.js).
module.exports = {
  async _ensureCloudConsent(modelName) {
    const parsed = cloud.parseName(modelName);
    if (!parsed) return true;
    const def = cloud.provider(parsed.providerId);
    const key = `localAI.cloudConsent.${parsed.providerId}`;
    if (this._context.globalState.get(key)) return true;
    const choice = await vscode.window.showWarningMessage(
      `You are about to use a cloud model (${def.name}). Your messages, and the files the AI reads from your project, will be sent to ${def.name}'s servers. ${def.dataNote} Do not use it with code or data you must keep private.`,
      { modal: true },
      'I understand, use the cloud model'
    );
    if (!choice) return false;
    await this._context.globalState.update(key, true);
    return true;
  },

  _cloudBudget(modelName) {
    const configured = Number(vscode.workspace.getConfiguration('localAI').get('cloudContextSize'));
    const setting = configured >= 2048 ? configured : 12000;
    const parsed = cloud.parseName(modelName);
    if (!parsed) return setting;
    const cap = cloudLimits.getModelCap(parsed.providerId, parsed.modelId);
    if (cap) return Math.max(800, Math.min(setting, Math.floor(cap * 0.6)));
    const seen = cloudLimits.get(parsed.providerId);
    const perMinute = seen && seen.items.find((i) => /tokens(-minute)?$/.test(i.scope) && i.limit > 0);
    if (perMinute) return Math.max(3500, Math.min(setting, Math.floor(perMinute.limit * 0.4)));
    return ['groq', 'openrouter'].includes(parsed.providerId) ? Math.min(setting, 5000) : setting;
  },

  _contextSize(modelName) {
    if (modelName && cloud.isCloudModel(modelName)) return this._cloudBudget(modelName);
    const configured = vscode.workspace.getConfiguration('localAI').get('contextSize');
    return Number(configured) >= 2048 ? Number(configured) : DEFAULT_CONTEXT_SIZE;
  },

  _clientFor(modelName) {
    return cloud.isCloudModel(modelName) ? this._cloud : this._ollamaClient;
  },

  _modelOptions(modelName, extra) {
    if (cloud.isCloudModel(modelName)) {
      return { ...extra, generation: generationLib.options() };
    }
    return {
      ...extra,
      keepAlive: this._context.globalState.get('localAI.keepAlive') || undefined,
      numCtx: this._contextSize(),
      generation: generationLib.options()
    };
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
