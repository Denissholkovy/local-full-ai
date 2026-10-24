const { vscode, modelState, RECOMMENDED_MODELS, ICONS, ollamaProcess, skillsLib, voice, generationLib, hardware, cloud, CloudClient, cloudLimits, workspaceLib } = require('./sidebar/common');

class SidebarProvider {
  constructor(context, ollamaClient) {
    this._context = context;
    this._ollamaClient = ollamaClient;
    this._view = null;
    this._pullInProgress = new Set();
    this._pullAborts = new Map();
    this._cloudClient = new CloudClient(context);
    require('./modelCapabilities').setLocalCaps(context.globalState.get('localAI.localCaps', {}));
  }

  resolveWebviewView(webviewView) {
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this._context.extensionUri, 'media')]
    };
    webviewView.webview.html = this._getHtml();

    webviewView.webview.onDidReceiveMessage((msg) => {
      // A failing action must say so instead of silently doing nothing.
      this._handleMessage(msg).catch((err) => {
        vscode.window.showErrorMessage(`Local Full AI: "${msg.type}" failed: ${err.message}`);
      });
    });

    this._watch(webviewView);
  }

  async _handleMessage(msg) {
      switch (msg.type) {
        case 'ready':
        case 'recheckOllama':
          await this._refreshState();
          break;
        case 'openOllamaSite':
          vscode.env.openExternal(vscode.Uri.parse('https://ollama.com/download'));
          break;
        case 'autoInstallOllama':
          this._autoInstallOllama();
          break;
        case 'startOllamaServer':
          await this._startOllamaServer();
          break;
        case 'uninstallOllama':
          this._uninstallOllama();
          break;
        case 'installModel':
          await this._installModel(msg.modelName);
          break;
        case 'selectInstalledModel':
          await modelState.setSelectedModel(this._context, msg.modelName);
          await this._refreshState();
          break;
        case 'deleteModel':
          await this._deleteModel(msg.modelName);
          break;
        case 'openChat':
          await vscode.commands.executeCommand('localAI.openChat');
          break;
        case 'ollamaSignin':
          this._ollamaSignin();
          break;
        case 'manualModel':
          await this._promptManualModel();
          break;
        case 'editSystemPrompt':
          await this._promptSystemPrompt();
          break;
        case 'setFolderLevel':
          await this._setFolderLevel(msg.path, msg.level);
          break;
        case 'addAccessFolder':
          await this._addAccessFolder();
          break;
        case 'removeAccessFolder':
          await this._updateRules((raw) => raw.filter((r) => workspaceLib.normalize(workspaceLib.expandHome(r.path)) !== msg.path));
          break;
        case 'setWorkingFolder': {
          const known = this._folderState().items.some((i) => i.path === msg.path);
          const value = msg.path && known ? msg.path : '';
          await vscode.workspace.getConfiguration('localAI').update('workingFolder', value, vscode.ConfigurationTarget.Global);
          break;
        }
        case 'cloudSetKey':
          await this._cloudSetKey(msg.providerId);
          break;
        case 'cloudPickModels':
          await this._cloudPickModels(msg.providerId);
          break;
        case 'cloudCheckLimits': {
          try {
            const entry = await this._cloudClient.accountInfo(msg.providerId);
            if (!entry) vscode.window.showInformationMessage('This provider has no limits query. Limits are shown after the first model answer.');
          } catch (err) {
            vscode.window.showErrorMessage(`Could not check the limits: ${err.message}`);
          }
          await this._refreshState();
          break;
        }
        case 'cloudRemoveKey':
          await this._cloudRemoveKey(msg.providerId);
          break;
        case 'cloudTestModel': {
          const r = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'Testing the model...' },
            () => this._cloudClient.testModel(msg.name)
          );
          if (r.ok) vscode.window.showInformationMessage('The model answers: it works.');
          else vscode.window.showWarningMessage(r.error);
          break;
        }
        case 'cloudRemoveModel':
          await this._cloudRemoveModel(msg.name);
          break;
        case 'cloudOpenPage': {
          const def = cloud.provider(msg.providerId);
          const url = msg.which === 'limits' ? def && def.limitsUrl : def && def.keyUrl;
          if (url) vscode.env.openExternal(vscode.Uri.parse(url));
          break;
        }
        case 'cloudConnect':
          await this._cloudConnect();
          break;
        case 'cancelPull': {
          const abort = this._pullAborts.get(msg.modelName);
          if (abort) abort();
          break;
        }
        case 'chooseVariant':
          await this._chooseVariant(msg.modelName);
          break;
        case 'chooseAgentMode':
          await this._chooseAgentMode();
          break;
        case 'showUsageStats':
          await this._showUsageStats();
          break;
        case 'chooseReviewerModel':
          await this._chooseReviewerModel();
          break;
        case 'manageMcp':
          await this._manageMcp();
          break;
        case 'chooseEmbeddingModel':
          await this._chooseEmbeddingModel();
          break;
        case 'chooseAutocomplete':
          await this._chooseAutocomplete();
          break;
        case 'chooseImageBackend':
          await this._chooseImageBackend();
          break;
        case 'chooseThinking':
          await this._chooseThinking();
          break;
        case 'chooseContext':
          await this._chooseContext();
          break;
        case 'chooseVoiceEngine':
          await this._chooseVoiceEngine();
          break;
        case 'setupVoice':
          voice.openSetupTerminal();
          break;
        case 'removeVoice':
          await this._removeVoice();
          break;
        case 'toggleSkills': {
          const config = vscode.workspace.getConfiguration('localAI');
          await config.update('useClaudeSkills', config.get('useClaudeSkills') === false, vscode.ConfigurationTarget.Global);
          break;
        }
        case 'toggleAutoSkills': {
          const config = vscode.workspace.getConfiguration('localAI');
          await config.update('autoSkills', config.get('autoSkills') === false, vscode.ConfigurationTarget.Global);
          break;
        }
        case 'rescanSkills':
          skillsLib.invalidate();
          await this._refreshState();
          vscode.window.showInformationMessage('Skills rescanned.');
          break;
        case 'addSkillFolder':
          await this._addSkillFolder();
          break;
        case 'openSkill': {
          const known = this._skillSources().skills.find((sk) => sk.file === msg.path);
          if (known) {
            const doc = await vscode.workspace.openTextDocument(known.file);
            await vscode.window.showTextDocument(doc);
          }
          break;
        }
        case 'revealFolder': {
          const known = this._skillSources().folders.find((f) => f.path === msg.path && f.exists);
          if (known) await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(known.path));
          break;
        }
        case 'toggleCloudFallback': {
          const config = vscode.workspace.getConfiguration('localAI');
          await config.update('cloudAutoFallback', config.get('cloudAutoFallback') !== true, vscode.ConfigurationTarget.Global);
          break;
        }

      }
  }

  _watch(webviewView) {
    const configWatcher = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('localAI')) this._refreshState();
    });
    const folderWatcher = vscode.workspace.onDidChangeWorkspaceFolders(() => this._refreshState());
    const modelWatcher = modelState.onDidChange(() => this._refreshState());
    let limitsTimer = null;
    const limitsWatcher = cloudLimits.onDidChange(() => {
      if (limitsTimer) return;
      limitsTimer = setTimeout(() => {
        limitsTimer = null;
        this._refreshState();
      }, 2000);
    });
    webviewView.onDidDispose(() => {
      configWatcher.dispose();
      folderWatcher.dispose();
      modelWatcher.dispose();
      limitsWatcher.dispose();
      if (limitsTimer) clearTimeout(limitsTimer);
    });

    this._refreshState();
  }

  async _commonState() {
    const config = vscode.workspace.getConfiguration('localAI');
    return {
      selectedModel: this._context.globalState.get('localAI.selectedModel') || null,
      systemPrompt: this._context.globalState.get('localAI.systemPrompt') || '',
      cloudAutoFallback: vscode.workspace.getConfiguration('localAI').get('cloudAutoFallback') === true,
      autocomplete: (() => {
        const cfg = vscode.workspace.getConfiguration('localAI');
        return cfg.get('autocomplete') === true ? String(cfg.get('autocompleteModel') || '').trim() || 'Auto' : 'Off';
      })(),
      embeddingModel: (() => {
        const v = String(vscode.workspace.getConfiguration('localAI').get('embeddingModel') || '').trim();
        return !v || v === 'auto' ? 'Auto' : v === 'off' ? 'Off' : v;
      })(),
      imageBackend: require('./imageGen').describe(this._context.globalState.get('localAI.imageGen', null)),
      voice: voice.info(),
      generation: generationLib.summary(),
      cloud: await this._cloudState(),
      folders: this._folderState(),
      skills: {
        enabled: config.get('useClaudeSkills') !== false,
        auto: config.get('autoSkills') !== false,
        cache: skillsLib.cacheInfo(),
        ...this._skillSources()
      }
    };
  }

  async _refreshState() {
    if (!this._view) return;
    const common = await this._commonState();

    const isRunning = await this._ollamaClient.ping();
    if (!isRunning) {
      this._view.webview.postMessage({
        type: 'ollamaNotRunning',
        ...common,
        installed: !!ollamaProcess.findBinary(),
        binary: ollamaProcess.findBinary()
      });
      return;
    }

    let localModels = [];
    try {
      localModels = await this._ollamaClient.listLocalModels();
    } catch (_) {
      localModels = [];
    }

    const installed = localModels.map((m) => ({
      name: m.name,
      quant: (m.details && m.details.quantization_level) || '',
      params: (m.details && m.details.parameter_size) || '',
      sizeGB: m.size ? m.size / (1024 * 1024 * 1024) : 0
    }));

    this._view.webview.postMessage({
      type: 'ollamaReady',
      ...common,
      installedModels: installed,
      recommendedModels: RECOMMENDED_MODELS,
      ollamaCloudModels: require('./catalog').cloudModels,
      totalRamGB: require('os').totalmem() / (1024 * 1024 * 1024),
      hardware: this._hardwareState()
    });
  }

  _getHtml() {
    const media = (...parts) =>
      this._view.webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, 'media', ...parts));
    const uiLang = (() => {
      const setting = vscode.workspace.getConfiguration('localAI').get('language') || 'auto';
      if (setting === 'en' || setting === 'uk') return setting;
      return String(vscode.env.language || 'en').toLowerCase().startsWith('uk') ? 'uk' : 'en';
    })();
    const iconMap = JSON.stringify(ICONS).replace(/</g, '\\u003c');

    const nonce = require('crypto').randomBytes(16).toString('base64');
    const csp = [
      "default-src 'none'",
      `img-src ${this._view.webview.cspSource} data: https:`,
      `style-src ${this._view.webview.cspSource} 'unsafe-inline'`,
      `font-src ${this._view.webview.cspSource}`,
      `script-src 'nonce-${nonce}'`
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<link rel="stylesheet" href="${media('sidebar', 'sidebar.css')}" />
</head>
<body>
  <div id="content"></div>
<script nonce="${nonce}">window.ICONS = ${iconMap}; window.__LANG = ${JSON.stringify(uiLang)};</script>
<script nonce="${nonce}" src="${media('i18n.js')}"></script>
<script nonce="${nonce}" src="${media('sidebar', 'sidebar.js')}"></script>
</body>
</html>`;
  }
}

for (const mixin of ['cloud', 'ollama', 'settings', 'folders']) {
  Object.assign(SidebarProvider.prototype, require(`./sidebar/${mixin}`));
}

module.exports = { SidebarProvider };
