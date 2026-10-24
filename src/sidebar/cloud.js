const { vscode, modelState, cloud, isVisionModel, cloudCap, cloudLimits } = require('./common');

// Methods mixed into SidebarProvider.prototype (see sidebarProvider.js).
module.exports = {
  async _cloudState() {
    const providers = [];
    for (const p of cloud.allProviders()) {
      const hasKey = p.server || !!(await this._context.secrets.get(`localAI.key.${p.id}`));
      const seen = cloudLimits.get(p.id);
      providers.push({
        id: p.id,
        name: p.name,
        hasKey,
        hasKeyPage: !!p.keyUrl,
        hasLimits: !!p.limitsUrl,
        canCheck: p.id === 'openrouter',
        paid: !!p.paid,
        server: !!p.server,
        local: !!p.local,
        note: p.note,
        dataNote: p.dataNote,
        limits: seen ? { at: seen.at, model: seen.model, items: seen.items, retryAfter: seen.retryAfter } : null
      });
    }
    const models = this._context.globalState.get('localAI.cloudModels', []).map((m) => ({
      ...m,
      tier: cloudCap(m.name, 'tools') === false
        ? 'notools'
        : cloudLimits.getModelCap(m.providerId, m.modelId) && cloudLimits.getModelCap(m.providerId, m.modelId) < 3000
          ? 'tiny'
          : cloud.rank(m.modelId),
      tokenCap: cloudLimits.getModelCap(m.providerId, m.modelId) || 0,
      vision: isVisionModel(m.name)
    }));
    return { providers, models };
  },

  async _cloudConnect() {
    const items = (await this._cloudState()).providers.map((p) => {
      const def = cloud.provider(p.id);
      return { label: `${p.hasKey ? '$(check) ' : ''}${p.name}`, description: p.server ? (p.local ? 'on this computer' : 'your server') : p.hasKey ? 'key saved' : def.paid ? 'paid' : def.keyUrl ? 'free key available' : '', detail: p.note, id: p.id };
    });
    const picked = await vscode.window.showQuickPick(items, {
      title: 'Connect a cloud provider',
      placeHolder: 'Local models too weak? Pick a provider with a free tier. Your prompts are sent to it.'
    });
    if (!picked) return;
    if (picked.id === 'custom') return this._cloudAddServer();
    const state = (await this._cloudState()).providers.find((p) => p.id === picked.id);
    if (state && state.hasKey) await this._cloudPickModels(picked.id);
    else await this._cloudSetKey(picked.id, true);
  },

  async _cloudSetKey(providerId, offerKeyPage) {
    const def = cloud.provider(providerId);
    if (!def) return;
    if (providerId === 'custom' && !(await this._context.secrets.get('localAI.key.custom'))) return this._cloudAddServer();
    if (def.server) {
      if (await this._askServerKey(def)) await this._refreshState();
      return;
    }
    if (providerId === 'custom') {
      const url = await vscode.window.showInputBox({
        prompt: 'Address of the OpenAI-compatible API (the part before /chat/completions)',
        placeHolder: 'https://example.com/v1',
        value: this._context.globalState.get('localAI.cloudCustomUrl') || '',
        validateInput: (v) => (/^https?:\/\/\S+$/.test(v) ? null : 'Enter a full address starting with http:// or https://')
      });
      if (!url) return;
      await this._context.globalState.update('localAI.cloudCustomUrl', url.replace(/\/+$/, ''));
    } else if (offerKeyPage && def.keyUrl) {
      const choice = await vscode.window.showInformationMessage(
        def.paid ? `${def.name} is a paid service: create an API key on their site (you pay per use), then paste it here.` : `${def.name}: create a free API key on their site, then paste it here.`,
        'Open the key page',
        'I already have a key'
      );
      if (!choice) return;
      if (choice === 'Open the key page') vscode.env.openExternal(vscode.Uri.parse(def.keyUrl));
    }
    const key = await vscode.window.showInputBox({
      prompt: `Paste your ${def.name} API key. It is stored in VS Code's secret storage, not in settings.`,
      password: true,
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim().length >= 8 ? null : 'That looks too short for an API key')
    });
    if (!key) return;
    await this._context.secrets.store(`localAI.key.${providerId}`, key.trim());
    await this._refreshState();
    await this._cloudPickModels(providerId);
  },

  // A server with an OpenAI-compatible API (LM Studio, llama.cpp, vLLM, a paid API...). The key is optional.
  async _cloudAddServer() {
    const preset = await vscode.window.showQuickPick(
      [
        ...cloud.SERVER_PRESETS.map((p) => ({ label: p.name, description: p.baseUrl, detail: 'Runs on this computer, no key needed', preset: p })),
        { label: 'Other address...', detail: 'Any OpenAI-compatible API, on this computer, in your network or in the cloud' }
      ],
      { title: 'Add an OpenAI-compatible server', placeHolder: 'Start the server first, then pick it here' }
    );
    if (!preset) return;
    const url = await vscode.window.showInputBox({
      prompt: 'Address of the API (the part before /chat/completions)',
      placeHolder: 'http://localhost:1234/v1',
      value: preset.preset ? preset.preset.baseUrl : '',
      ignoreFocusOut: true,
      validateInput: (v) => (/^https?:\/\/\S+$/.test(v.trim()) ? null : 'Enter a full address starting with http:// or https://')
    });
    if (!url) return;
    const baseUrl = url.trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
    const name = await vscode.window.showInputBox({
      prompt: 'Name shown in the model list',
      value: preset.preset ? preset.preset.name : new URL(baseUrl).hostname,
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() ? null : 'Enter a name')
    });
    if (!name) return;
    const server = { id: cloud.newServerId(name), name: name.trim(), baseUrl };
    const list = [...cloud.getServers(), server];
    cloud.setServers(list);
    await this._context.globalState.update('localAI.customServers', list);
    if (!cloud.isLoopback(baseUrl) && !(await this._askServerKey(cloud.provider(server.id)))) {
      await this._context.globalState.update('localAI.customServers', list.filter((s) => s.id !== server.id));
      cloud.setServers(list.filter((s) => s.id !== server.id));
      return;
    }
    await this._refreshState();
    await this._cloudPickModels(server.id);
  },

  // Returns false when the user cancelled; an empty answer removes the key.
  async _askServerKey(def) {
    const key = await vscode.window.showInputBox({
      prompt: `API key for ${def.name} (leave empty if the server needs none). It is stored in VS Code's secret storage.`,
      password: true,
      ignoreFocusOut: true
    });
    if (key === undefined) return false;
    if (key.trim()) await this._context.secrets.store(`localAI.key.${def.id}`, key.trim());
    else await this._context.secrets.delete(`localAI.key.${def.id}`);
    return true;
  },

  async _cloudPickModels(providerId) {
    const def = cloud.provider(providerId);
    if (!def) return;
    let ids;
    try {
      ids = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Loading models from ${def.name}...` },
        () => this._cloudClient.listModels(providerId)
      );
    } catch (err) {
      const choice = await vscode.window.showErrorMessage(`${def.name}: ${err.message}`, 'Change the key');
      if (choice === 'Change the key') await this._cloudSetKey(providerId);
      return;
    }
    const available = cloud.filterModels(def, ids);
    if (available.length === 0) {
      vscode.window.showInformationMessage(def.onlyFree ? `${def.name} returned no free models right now. Try again later.` : `${def.name} returned no chat models.`);
      return;
    }
    const current = this._context.globalState.get('localAI.cloudModels', []);
    const chosen = new Set(current.filter((m) => m.providerId === providerId).map((m) => m.modelId));
    const picked = await vscode.window.showQuickPick(
      [
        ...['best', 'ok', 'weak'].flatMap((tier) => {
          const ids = available.filter((id) => cloud.rank(id) === tier);
          if (!ids.length) return [];
          const title = tier === 'best' ? 'Recommended: strong at code and tools' : tier === 'ok' ? 'Other chat models' : 'Small or fast models: weaker at agent tasks';
          return [
            { label: title, kind: vscode.QuickPickItemKind.Separator },
            ...ids.map((id) => ({
              label: id,
              picked: chosen.has(id),
              description: [tier === 'best' ? '\u2605 recommended' : '', isVisionModel(`cloud:${providerId}:${id}`) ? 'sees images' : '', cloudCap(`cloud:${providerId}:${id}`, 'tools') === false ? 'no tools: cannot edit your project' : ''].filter(Boolean).join(' \u00b7 ')
            }))
          ];
        })
      ],
      {
        title: `Models to add from ${def.name}`,
        placeHolder: def.onlyFree ? 'Only free models are listed. Tick the ones you want, then press Enter.' : 'Tick the models you want, then press Enter. Check the provider limits: not every model is free.',
        canPickMany: true,
        matchOnDescription: true
      }
    );
    if (!picked) return;
    const others = current.filter((m) => m.providerId !== providerId);
    const added = picked.map((i) => ({ name: cloud.makeName(providerId, i.label), providerId, modelId: i.label }));
    await this._context.globalState.update('localAI.cloudModels', [...others, ...added]);
    await this._verifyCloudModels(providerId, added.filter((m) => !chosen.has(m.modelId)));
    if (added.length > 0 && !this._context.globalState.get('localAI.selectedModel')) {
      await modelState.setSelectedModel(this._context, added[0].name);
    }
    await this._refreshState();
  },

  async _verifyCloudModels(providerId, added) {
    if (!added.length) return;
    const bad = [];
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Checking that the new models answer...' },
      async () => {
        for (const m of added.slice(0, 6)) {
          const r = await this._cloudClient.testModel(m.name);
          if (!r.ok && !r.busy) bad.push({ m, error: r.error });
        }
      }
    );
    if (!bad.length) {
      vscode.window.showInformationMessage(`${added.length} model${added.length > 1 ? 's' : ''} checked: working.`);
      return;
    }
    const list = bad.map((b) => `${b.m.modelId}: ${b.error.slice(0, 140)}`).join('\n');
    const choice = await vscode.window.showWarningMessage(`These models do not work with your key:\n${list}`, { modal: true }, 'Remove them');
    if (choice === 'Remove them') {
      const names = new Set(bad.map((b) => b.m.name));
      const current = this._context.globalState.get('localAI.cloudModels', []);
      await this._context.globalState.update('localAI.cloudModels', current.filter((m) => !names.has(m.name)));
      const selected = this._context.globalState.get('localAI.selectedModel');
      if (names.has(selected)) await modelState.setSelectedModel(this._context, null);
      await this._refreshState();
    }
  },

  async _cloudRemoveKey(providerId) {
    const def = cloud.provider(providerId);
    const confirm = await vscode.window.showWarningMessage(`Remove ${def.server ? def.name : `the ${def.name} key`} and its models from this extension?`, { modal: true }, 'Remove');
    if (confirm !== 'Remove') return;
    await this._context.secrets.delete(`localAI.key.${providerId}`);
    if (def.server) {
      const list = cloud.getServers().filter((s) => s.id !== providerId);
      cloud.setServers(list);
      await this._context.globalState.update('localAI.customServers', list);
    }
    const current = this._context.globalState.get('localAI.cloudModels', []);
    await this._context.globalState.update('localAI.cloudModels', current.filter((m) => m.providerId !== providerId));
    const selected = this._context.globalState.get('localAI.selectedModel');
    const parsed = cloud.parseName(selected);
    if (parsed && parsed.providerId === providerId) await modelState.setSelectedModel(this._context, undefined);
    await this._refreshState();
  },

  async _cloudRemoveModel(name) {
    const current = this._context.globalState.get('localAI.cloudModels', []);
    await this._context.globalState.update('localAI.cloudModels', current.filter((m) => m.name !== name));
    if (this._context.globalState.get('localAI.selectedModel') === name) await modelState.setSelectedModel(this._context, undefined);
    await this._refreshState();
  },

};
