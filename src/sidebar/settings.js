const { vscode, voice, generationLib, cloud } = require('./common');
const imageGen = require('../imageGen');
const capabilities = require('../modelCapabilities');

// Methods mixed into SidebarProvider.prototype (see sidebarProvider.js).
module.exports = {
  async _chooseImageBackend() {
    const current = this._context.globalState.get('localAI.imageGen', null);
    const providers = (await this._cloudState()).providers.filter((p) => p.hasKey && !['groq', 'cerebras', 'openrouter', 'mistral', 'anthropic', 'custom'].includes(p.id));
    const picked = await vscode.window.showQuickPick(
      [
        { label: 'Off', description: imageGen.isConfigured(current) ? '' : 'current', detail: 'The AI draws icons as SVG files but makes no pictures.', kind: 'off' },
        { label: 'Stable Diffusion WebUI / Forge / Draw Things', description: 'on this computer', detail: 'Free and private. Start the app with its API enabled (WebUI: --api; Draw Things: HTTP server on).', kind: 'sdwebui' },
        { label: 'Hugging Face', description: providers.some((p) => p.id === 'huggingface') ? 'token saved' : 'connect it under Cloud models first', detail: 'Text-to-image models such as Stable Diffusion 3 and FLUX, paid from your Hugging Face credits.', kind: 'huggingface' },
        ...providers.filter((p) => p.id !== 'huggingface').map((p) => ({
          label: p.name,
          description: p.local ? 'on this computer' : 'cloud',
          detail: 'Uses its OpenAI-compatible /images/generations endpoint (OpenAI, Gemini, LocalAI and similar). Usually paid.',
          kind: 'openai',
          provider: p
        }))
      ],
      { title: 'Image generation: where should pictures be made?', placeHolder: `Now: ${imageGen.describe(current)}` }
    );
    if (!picked) return;
    let config = null;
    if (picked.kind === 'sdwebui') {
      const url = await vscode.window.showInputBox({
        prompt: 'Address of the Stable Diffusion WebUI API',
        value: (current && current.kind === 'sdwebui' && current.url) || imageGen.DEFAULT_SDWEBUI_URL,
        validateInput: (v) => (/^https?:\/\/\S+$/.test(v.trim()) ? null : 'Enter a full address starting with http:// or https://')
      });
      if (!url) return;
      config = { kind: 'sdwebui', url: url.trim().replace(/\/+$/, '') };
    } else if (picked.kind === 'huggingface') {
      if (!providers.some((p) => p.id === 'huggingface')) {
        vscode.window.showWarningMessage('Connect Hugging Face under Cloud models first, then choose it here.');
        return;
      }
      const model = await vscode.window.showInputBox({
        prompt: 'Hugging Face text-to-image model',
        value: (current && current.kind === 'huggingface' && current.model) || imageGen.DEFAULT_HF_MODEL
      });
      if (!model) return;
      config = { kind: 'huggingface', model: model.trim() };
    } else if (picked.kind === 'openai') {
      const model = await vscode.window.showInputBox({
        prompt: `Image model of ${picked.provider.name} (as named in its API)`,
        placeHolder: picked.provider.id === 'openai' ? 'for example gpt-image-1' : 'the exact model id from the provider',
        value: current && current.kind === 'openai' && current.providerId === picked.provider.id ? current.model : '',
        validateInput: (v) => (v.trim() ? null : 'Enter the model id')
      });
      if (!model) return;
      config = { kind: 'openai', providerId: picked.provider.id, providerName: picked.provider.name, model: model.trim() };
    }
    await this._context.globalState.update('localAI.imageGen', config);
    await this._refreshState();
  },

  async _chooseAutocomplete() {
    const config = vscode.workspace.getConfiguration('localAI');
    const on = config.get('autocomplete') === true;
    const current = String(config.get('autocompleteModel') || '').trim() || 'auto';
    const models = (await this._ollamaClient.listLocalModels().catch(() => [])).filter((m) => !cloud.isOllamaCloud(m.name)).sort((a, b) => a.size - b.size);
    const save = (map) => this._context.globalState.update('localAI.localCaps', map);
    for (const m of models) await capabilities.learnLocal(this._ollamaClient, m.name, save);
    const fim = models.filter((m) => capabilities.localCap(m.name, 'insert'));
    const items = [
      { label: `${!on ? '$(check) ' : ''}Off`, value: null },
      { label: `${on && current === 'auto' ? '$(check) ' : ''}Auto: the smallest model that can complete code`, description: fim[0] ? fim[0].name : 'none installed', value: 'auto' },
      ...(fim.length ? [{ label: 'Installed models that can complete code', kind: vscode.QuickPickItemKind.Separator }] : []),
      ...fim.map((m) => ({ label: `${on && current === m.name ? '$(check) ' : ''}${m.name}`, description: `${(m.size / 1e9).toFixed(1)} GB`, value: m.name }))
    ];
    if (!fim.length) items.push({ label: '$(download) Install qwen2.5-coder:1.5b', description: 'about 1 GB, fast enough for every keystroke', value: 'install' });
    const picked = await vscode.window.showQuickPick(items, { title: 'Code completion as you type (local only)', placeHolder: 'Small models are best here: they answer before you type the next key.' });
    if (!picked) return;
    if (picked.value === 'install') {
      await this._installModel('qwen2.5-coder:1.5b');
      return;
    }
    await config.update('autocomplete', picked.value !== null, vscode.ConfigurationTarget.Global);
    if (picked.value) await config.update('autocompleteModel', picked.value === 'auto' ? '' : picked.value, vscode.ConfigurationTarget.Global);
  },

  async _chooseEmbeddingModel() {
    const config = vscode.workspace.getConfiguration('localAI');
    const current = String(config.get('embeddingModel') || '').trim() || 'auto';
    const models = (await this._ollamaClient.listLocalModels().catch(() => [])).filter((m) => !cloud.isOllamaCloud(m.name));
    const save = (map) => this._context.globalState.update('localAI.localCaps', map);
    for (const m of models) await capabilities.learnLocal(this._ollamaClient, m.name, save);
    const embedders = models.filter((m) => capabilities.localCap(m.name, 'embedding'));
    const items = [
      { label: `${current === 'auto' ? '$(check) ' : ''}Auto`, description: embedders[0] ? embedders[0].name : 'no embedding model installed', value: '' },
      { label: `${current === 'off' ? '$(check) ' : ''}Off`, value: 'off' },
      ...embedders.map((m) => ({ label: `${current === m.name ? '$(check) ' : ''}${m.name}`, description: `${Math.round(m.size / 1e6)} MB`, value: m.name }))
    ];
    if (!embedders.length) items.push({ label: '$(download) Install nomic-embed-text', description: 'about 270 MB', value: 'install' });
    const picked = await vscode.window.showQuickPick(items, {
      title: 'Meaning search in the project (semantic_search)',
      placeHolder: 'A small local model turns the code into vectors so the AI finds "where the login is handled" without exact names.'
    });
    if (!picked) return;
    if (picked.value === 'install') return this._installModel('nomic-embed-text');
    await config.update('embeddingModel', picked.value, vscode.ConfigurationTarget.Global);
  },

  async _manageMcp() {
    const mcpConfig = require('../mcpConfig');
    const manager = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Starting MCP servers...' },
      () => mcpConfig.ensure(this._context)
    );
    const icons = { ready: '$(check)', failed: '$(error)', starting: '$(sync)', stopped: '$(circle-slash)' };
    const servers = manager.servers();
    const picked = await vscode.window.showQuickPick(
      [
        ...servers.map((s) => ({
          label: `${icons[s.status] || ''} ${s.name}`,
          description: s.status === 'ready' ? `${s.tools.length} tools` : s.status,
          detail: s.status === 'failed' ? s.error.split('\n')[0] : s.tools.slice(0, 8).join(', '),
          server: s
        })),
        { label: '$(add) Add a server (command)...', action: 'addCommand' },
        { label: '$(globe) Add a server (URL)...', action: 'addUrl' },
        { label: '$(json) Edit MCP settings (JSON)', action: 'json' }
      ],
      { title: 'MCP servers', placeHolder: servers.length ? 'Pick a server to restart or remove it' : 'No servers yet. Add one, or put a .mcp.json in the project.' }
    );
    if (!picked) return;
    const config = vscode.workspace.getConfiguration('localAI');
    const current = { ...mcpConfig.userServers() };
    if (picked.action === 'json') {
      await vscode.commands.executeCommand('workbench.action.openSettingsJson');
      return;
    }
    if (picked.action === 'addCommand' || picked.action === 'addUrl') {
      const name = await vscode.window.showInputBox({ prompt: 'Server name', validateInput: (v) => (/^[\w-]{1,30}$/.test(v) ? null : 'Letters, digits, - and _ only') });
      if (!name) return;
      if (picked.action === 'addCommand') {
        const line = await vscode.window.showInputBox({ prompt: 'Command that starts the server', placeHolder: 'npx -y @modelcontextprotocol/server-filesystem /path/to/folder', ignoreFocusOut: true });
        if (!line) return;
        const parts = line.trim().split(/\s+/);
        current[name] = { command: parts[0], args: parts.slice(1) };
      } else {
        const url = await vscode.window.showInputBox({ prompt: 'Server URL (Streamable HTTP)', placeHolder: 'https://example.com/mcp', validateInput: (v) => (/^https?:\/\/\S+$/.test(v.trim()) ? null : 'Enter a full URL') });
        if (!url) return;
        current[name] = { type: 'http', url: url.trim() };
      }
      await config.update('mcpServers', current, vscode.ConfigurationTarget.Global);
      await mcpConfig.ensure(this._context);
      const added = mcpConfig.manager.servers().find((s) => s.name === name);
      if (added && added.status === 'failed') vscode.window.showErrorMessage(`MCP server "${name}" did not start: ${added.error}`);
      else if (added) vscode.window.showInformationMessage(`MCP server "${name}" is ready with ${added.tools.length} tools.`);
      return;
    }
    const action = await vscode.window.showQuickPick(
      [{ label: 'Restart', value: 'restart' }, ...(current[picked.server.name] ? [{ label: 'Remove', value: 'remove' }] : [])],
      { title: picked.server.name }
    );
    if (!action) return;
    if (action.value === 'restart') await mcpConfig.manager.restart(picked.server.name);
    if (action.value === 'remove') {
      delete current[picked.server.name];
      await config.update('mcpServers', current, vscode.ConfigurationTarget.Global);
      await mcpConfig.ensure(this._context);
    }
  },

  async _chooseReviewerModel() {
    const config = vscode.workspace.getConfiguration('localAI');
    const current = String(config.get('reviewerModel') || '').trim();
    const local = (await this._ollamaClient.listLocalModels().catch(() => [])).filter((m) => !/embed/i.test(m.name)).sort((a, b) => b.size - a.size);
    const cloudModels = this._context.globalState.get('localAI.cloudModels', []);
    const picked = await vscode.window.showQuickPick([
      { label: `${!current ? '$(check) ' : ''}Same model as the chat`, description: 'default', value: '' },
      ...(local.length ? [{ label: 'Installed models', kind: vscode.QuickPickItemKind.Separator }] : []),
      ...local.map((m) => ({ label: `${current === m.name ? '$(check) ' : ''}${m.name}`, description: `${(m.size / 1e9).toFixed(1)} GB`, value: m.name })),
      ...(cloudModels.length ? [{ label: 'Cloud models (the changed files are sent there)', kind: vscode.QuickPickItemKind.Separator }] : []),
      ...cloudModels.map((m) => ({ label: `${current === m.name ? '$(check) ' : ''}${m.modelId}`, description: m.providerId, value: m.name }))
    ], { title: 'Reviewer agent model', placeHolder: 'A second, stronger model catches mistakes the chat model makes. Used when "Check changes" runs the reviewer.' });
    if (!picked || picked.value === undefined) return;
    await config.update('reviewerModel', picked.value, vscode.ConfigurationTarget.Global);
  },

  async _showUsageStats() {
    const usageStats = require('../usageStats');
    const fmt = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(Math.round(n)));
    const period = await vscode.window.showQuickPick(
      [{ label: 'Today', days: 1 }, { label: 'Last 7 days', days: 7 }, { label: 'Last 30 days', days: 30 }],
      { title: 'Usage statistics' }
    );
    if (!period) return;
    const rows = usageStats.summary(this._context, period.days);
    await vscode.window.showQuickPick(
      rows.length
        ? rows.map((r) => ({
          label: r.model.replace(/^cloud:([^:]+):/, '$1: '),
          description: `${fmt(r.prompt)} in · ${fmt(r.output)} out · ${r.requests} requests`,
          detail: `${r.model.startsWith('cloud:') || /[:-]cloud$/.test(r.model) ? 'Cloud' : 'Local'} · about ${r.tokensPerSec.toFixed(1)} tokens/s`
        }))
        : [{ label: 'No requests in this period yet.' }],
      { title: `Usage: ${period.label.toLowerCase()}`, placeHolder: 'Tokens read (in) and written (out) per model. Cloud tokens count against your free limits.' }
    );
  },

  async _chooseAgentMode() {
    const config = vscode.workspace.getConfiguration('localAI');
    const current = String(config.get('agentMode') || 'auto');
    const items = [
      { value: 'auto', label: 'Auto', detail: 'Picked from the model: fast for 4B or slow models, standard for 7-13B, agent for strong cloud models and fast 14B+.' },
      { value: 'direct', label: 'Fast', detail: 'One pass: the model sees the relevant files and returns complete files. Quickest and most reliable with small models.' },
      { value: 'standard', label: 'Standard', detail: 'Works with tools and a short plan, no helper agents.' },
      { value: 'agent', label: 'Agent', detail: 'Full tool loop with helper agents for big jobs. Needs a strong model that runs fast.' }
    ].map((i) => ({ ...i, label: `${i.value === current ? '$(check) ' : ''}${i.label}` }));
    const picked = await vscode.window.showQuickPick(items, { title: 'Work mode: how the AI works on your project' });
    if (picked) await config.update('agentMode', picked.value, vscode.ConfigurationTarget.Global);
  },

  async _chooseThinking() {
    const config = vscode.workspace.getConfiguration('localAI');
    const current = generationLib.thinkingMode();
    const details = {
      auto: 'Each model uses its own default.',
      fast: 'Skips most of the thinking. Best for small edits and questions.',
      deep: 'Thinks longer before it answers. Best for hard bugs and planning.'
    };
    const picked = await vscode.window.showQuickPick(
      Object.entries(generationLib.THINKING).map(([id, label]) => ({ label: `${id === current ? '$(check) ' : ''}${label}`, detail: details[id], value: id })),
      { title: 'Thinking (local models that can reason: Qwen3, GPT-OSS, DeepSeek-R1...)' }
    );
    if (picked) await config.update('thinking', picked.value, vscode.ConfigurationTarget.Global);
  },

  async _chooseContext() {
    const config = vscode.workspace.getConfiguration('localAI');
    const current = Number(config.get('contextSize')) || 16384;
    const sizes = [4096, 8192, 16384, 32768, 65536, 131072];
    const notes = { 4096: 'fastest, remembers little', 8192: 'short chats', 16384: 'default, good for projects', 32768: 'long files and chats, more RAM', 65536: 'very long, needs a lot of RAM', 131072: 'maximum, only for big machines' };
    const picked = await vscode.window.showQuickPick(
      sizes.map((n) => ({ label: `${n === current ? '$(check) ' : ''}${Math.round(n / 1024)}K tokens`, description: notes[n], value: n })),
      { title: 'Context length (how much the model remembers)', placeHolder: 'Larger values use more RAM and are slower. Models have their own maximum.' }
    );
    if (picked) await config.update('contextSize', picked.value, vscode.ConfigurationTarget.Global);
  },

  async _promptSystemPrompt() {
    const current = this._context.globalState.get('localAI.systemPrompt') || '';
    const value = await vscode.window.showInputBox({
      prompt: 'System prompt / persona (leave empty to remove)',
      placeHolder: 'e.g. "Always answer with code only, no explanations"',
      value: current
    });
    if (value === undefined) return;
    await this._context.globalState.update('localAI.systemPrompt', value);
    await this._refreshState();
  },

  async _chooseVoiceEngine() {
    const config = vscode.workspace.getConfiguration('localAI');
    const current = config.get('voiceEngine') === 'groq' ? 'groq' : 'local';
    const picked = await vscode.window.showQuickPick(
      [
        { label: `${current === 'local' ? '$(check) ' : ''}Local (offline whisper.cpp)`, detail: 'Nothing leaves your computer. Needs a one-time setup and is slower on weak machines.', value: 'local' },
        { label: `${current === 'groq' ? '$(check) ' : ''}Groq Whisper (cloud)`, detail: 'Fast and accurate, good with Ukrainian, nothing to install. Needs the Groq key; each recording is sent to Groq.', value: 'groq' }
      ],
      { title: 'Which speech recognition should voice input use?' }
    );
    if (!picked) return;
    await config.update('voiceEngine', picked.value, vscode.ConfigurationTarget.Global);
    if (picked.value === 'groq' && !(await this._context.secrets.get('localAI.key.groq'))) {
      vscode.window.showInformationMessage('Add your Groq key in the Cloud tab (Providers) to use it for voice.');
    }
    await this._refreshState();
  },

  async _removeVoice() {
    const info = voice.info();
    const uninstall = info.canUninstallWhisper ? voice.uninstallCommand() : null;
    const actions = [];
    if (info.modelIsOurs) actions.push('Delete speech model');
    if (uninstall) actions.push('Delete model and uninstall whisper.cpp');
    if (actions.length === 0) {
      vscode.window.showInformationMessage(
        'Nothing to delete here: the speech model and whisper.cpp were not installed by this extension. Remove them where you installed them.'
      );
      return;
    }
    const choice = await vscode.window.showWarningMessage(
      `Remove offline voice input? This frees about ${info.modelMB} MB and the microphone button will stop working until you set it up again. Your recorder (ffmpeg/sox) is left alone.`,
      { modal: true },
      ...actions
    );
    if (!choice) return;

    try {
      if (info.modelIsOurs) voice.removeModel();
      if (choice.includes('uninstall') && uninstall) {
        voice.runInTerminal('Remove whisper.cpp', uninstall);
      }
      vscode.window.showInformationMessage('Voice input removed. You can set it up again any time from Settings.');
    } catch (err) {
      vscode.window.showErrorMessage(`Could not remove voice input: ${err.message}`);
    }
    await this._refreshState();
  },
};
