const { vscode, voice, generationLib, cloud } = require('./common');

// Methods mixed into SidebarProvider.prototype (see sidebarProvider.js).
module.exports = {
  async _chooseResponseMode() {
    const config = vscode.workspace.getConfiguration('localAI');
    const current = generationLib.currentMode();
    const items = [
      ...Object.entries(generationLib.PRESETS).map(([id, p]) => ({
        label: `${id === current ? '$(check) ' : ''}${p.label}`,
        description: `temperature ${p.temperature}`,
        detail: p.description,
        mode: id
      })),
      { label: `${current === 'custom' ? '$(check) ' : ''}Custom...`, description: 'set temperature, top-p, top-k and repeat penalty yourself', mode: 'custom' }
    ];
    const picked = await vscode.window.showQuickPick(items, { title: 'How should the model answer?' });
    if (!picked) return;
    if (picked.mode === 'custom') {
      const ask = async (prompt, key, fallback, min, max) => {
        const value = await vscode.window.showInputBox({
          prompt,
          value: String(config.get(key) ?? fallback),
          validateInput: (v) => (Number.isFinite(Number(v)) && Number(v) >= min && Number(v) <= max ? null : `Enter a number from ${min} to ${max}`)
        });
        if (value === undefined) return false;
        await config.update(key, Number(value), vscode.ConfigurationTarget.Global);
        return true;
      };
      if (!(await ask('Temperature (0 = exact, 1 = varied)', 'temperature', 0.2, 0, 2))) return;
      if (!(await ask('Top-p (0.1 - 1)', 'topP', 0.9, 0.05, 1))) return;
      if (!(await ask('Top-k (0 = off)', 'topK', 40, 0, 1000))) return;
      if (!(await ask('Repeat penalty (1 = off)', 'repeatPenalty', 1.05, 0.5, 2))) return;
    }
    await config.update('responseMode', picked.mode, vscode.ConfigurationTarget.Global);
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

  async _chooseHelperModel() {
    const config = vscode.workspace.getConfiguration('localAI');
    const current = String(config.get('subagentModel') || '').trim();
    const models = await this._ollamaClient.listLocalModels().catch(() => []);
    const items = [
      { label: `${current === '' ? '$(check) ' : ''}Same model as the chat`, description: 'default', detail: 'Helpers use the model you chat with.', value: '' },
      { label: `${current === 'auto' ? '$(check) ' : ''}Auto: the smallest installed model`, description: 'fast helpers', detail: 'With a local chat model, research helpers use your smallest installed model that is smaller than it. With a cloud chat model, helpers use that same cloud model. Helpers that edit files always use the chat model.', value: 'auto' },
      { label: 'Installed models', kind: vscode.QuickPickItemKind.Separator },
      ...models
        .slice()
        .sort((a, b) => a.size - b.size)
        .map((m) => {
          const entry = require('../catalog').models.find((c) => c.name === m.name);
          const tools = entry ? (entry.tags || []).includes('tools') : true;
          return {
            label: `${current === m.name ? '$(check) ' : ''}${m.name}`,
            description: `${(m.size / 1e9).toFixed(1)} GB`,
            detail: tools
              ? 'Can use tools: reads and searches files itself.'
              : 'No tools: reads the files directly (fast, good for simple reading tasks).',
            value: m.name
          };
        })
    ];
    const picked = await vscode.window.showQuickPick(items, {
      title: 'Which model should research helpers use?',
      placeHolder: 'A small fast model is enough for simple reading and summarising. Helpers that edit files always use the chat model.'
    });
    if (!picked || picked.value === undefined) return;
    await config.update('subagentModel', picked.value, vscode.ConfigurationTarget.Global);
  },

  async _chooseGpu() {
    const config = vscode.workspace.getConfiguration('localAI');
    const picked = await vscode.window.showQuickPick(
      [
        { label: 'Automatic', description: 'Ollama decides (recommended)', value: -1 },
        { label: 'CPU only', description: 'Slowest, but frees the GPU and video memory', value: 0 },
        { label: 'Custom number of GPU layers...', description: 'for fine tuning when the model does not fit in video memory', value: 'custom' }
      ],
      { title: 'Where should the model run?' }
    );
    if (!picked) return;
    let value = picked.value;
    if (value === 'custom') {
      const typed = await vscode.window.showInputBox({
        prompt: 'Number of layers to put on the GPU (lower = less video memory)',
        validateInput: (v) => (/^\d+$/.test(v) ? null : 'Enter a whole number, 0 or more')
      });
      if (typed === undefined) return;
      value = Number(typed);
    }
    await config.update('gpuLayers', value, vscode.ConfigurationTarget.Global);
  },

  async _promptKeepAlive() {
    const options = [
      { label: '5m (default)', value: '' },
      { label: '30m', value: '30m' },
      { label: '1h', value: '1h' },
      { label: 'Forever (stays loaded until you change it)', value: '-1' },
      { label: 'Unload immediately after each reply', value: '0' }
    ];
    const picked = await vscode.window.showQuickPick(
      options.map((o) => o.label),
      { title: 'How long should Ollama keep the model loaded in RAM?' }
    );
    if (picked === undefined) return;
    const match = options.find((o) => o.label === picked);
    await this._context.globalState.update('localAI.keepAlive', match.value);
    await this._refreshState();
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
