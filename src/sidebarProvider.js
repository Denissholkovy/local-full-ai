const vscode = require('vscode');
const modelState = require('./modelState');
const { RECOMMENDED_MODELS } = require('./modelPicker');
const { ICONS } = require('./icons');
const ollamaProcess = require('./ollamaProcess');
const skillsLib = require('./skills');
const voice = require('./voice');
const modelTags = require('./modelTags');
const generationLib = require('./generation');
const hardware = require('./hardware');
const cloud = require('./cloudProviders');
const { isVisionModel, cloudCap } = require('./modelCapabilities');
const { CloudClient } = require('./cloudClient');
const cloudLimits = require('./cloudLimits');
const workspaceLib = require('./workspace');
const { resolveWorkspaceRoot } = workspaceLib;

class SidebarProvider {
  constructor(context, ollamaClient) {
    this._context = context;
    this._ollamaClient = ollamaClient;
    this._view = null;
    this._pullInProgress = new Set();
    this._pullAborts = new Map();
    this._cloudClient = new CloudClient(context);
  }

  resolveWebviewView(webviewView) {
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this._context.extensionUri, 'media')]
    };
    webviewView.webview.html = this._getHtml();

    webviewView.webview.onDidReceiveMessage(async (msg) => {
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
        case 'manualModel':
          await this._promptManualModel();
          break;
        case 'editSystemPrompt':
          await this._promptSystemPrompt();
          break;
        case 'editKeepAlive':
          await this._promptKeepAlive();
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
        case 'chooseResponseMode':
          await this._chooseResponseMode();
          break;
        case 'chooseContext':
          await this._chooseContext();
          break;
        case 'chooseCloudContext':
          await this._chooseCloudContext();
          break;
        case 'chooseGpu':
          await this._chooseGpu();
          break;
        case 'chooseHelperModel':
          await this._chooseHelperModel();
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
        case 'toggleIncludeActiveFile': {
          const current = this._context.globalState.get('localAI.includeActiveFile', false);
          await this._context.globalState.update('localAI.includeActiveFile', !current);
          await this._refreshState();
          break;
        }
      }
    });

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

  _skillSources() {
    const config = vscode.workspace.getConfiguration('localAI');
    return skillsLib.describeSources({
      workspaceRoot: resolveWorkspaceRoot(),
      extraFolders: config.get('extraSkillFolders') || []
    });
  }

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
  }

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
  }

  _pretty(p) {
    const home = require('os').homedir();
    return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
  }

  _folderState() {
    const path = require('path');
    const fs = require('fs');
    const config = vscode.workspace.getConfiguration('localAI');
    const rules = workspaceLib.readRules();
    const workspace = workspaceLib.workspaceFolderPaths();
    const primary = workspaceLib.resolveWorkingRoot();
    const items = [];
    workspace.forEach((p) => {
      const rule = rules.find((r) => r.path === p);
      items.push({ path: p, display: this._pretty(p), name: path.basename(p), kind: 'project', level: rule ? rule.level : 'full', primary: p === primary, removable: false, exists: true });
    });
    rules.filter((r) => !workspace.includes(r.path)).forEach((r) => {
      let exists = false;
      try {
        exists = fs.statSync(r.path).isDirectory();
      } catch (_) {
        exists = false;
      }
      items.push({
        path: r.path,
        display: this._pretty(r.path),
        name: path.basename(r.path) || r.path,
        kind: workspace.some((w) => workspaceLib.isInside(r.path, w)) ? 'inside' : 'extra',
        level: r.level,
        primary: r.path === primary,
        removable: true,
        exists
      });
    });
    if (primary && !items.some((i) => i.path === primary)) {
      items.unshift({ path: primary, display: this._pretty(primary), name: path.basename(primary), kind: 'auto', level: 'full', primary: true, removable: false, exists: true });
    }
    return { items, primary, hasOverride: !!config.get('workingFolder'), noWorkspace: workspace.length === 0 };
  }

  async _updateRules(mutate) {
    const config = vscode.workspace.getConfiguration('localAI');
    const raw = (config.get('folderAccess') || []).filter((r) => r && typeof r.path === 'string');
    await config.update('folderAccess', mutate(raw), vscode.ConfigurationTarget.Global);
  }

  async _setFolderLevel(folderPath, level) {
    if (!workspaceLib.LEVELS.includes(level) || !folderPath) return;
    const workspace = workspaceLib.workspaceFolderPaths();
    await this._updateRules((raw) => {
      const rest = raw.filter((r) => workspaceLib.normalize(workspaceLib.expandHome(r.path)) !== folderPath);
      if (level === 'full' && workspace.includes(folderPath)) return rest;
      return [...rest, { path: folderPath, level }];
    });
  }

  async _cloudState() {
    const providers = [];
    for (const p of cloud.PROVIDERS) {
      const hasKey = !!(await this._context.secrets.get(`localAI.key.${p.id}`));
      const seen = cloudLimits.get(p.id);
      providers.push({
        id: p.id,
        name: p.name,
        hasKey,
        hasKeyPage: !!p.keyUrl,
        hasLimits: !!p.limitsUrl,
        canCheck: p.id === 'openrouter',
        note: p.note,
        dataNote: p.dataNote,
        limits: seen ? { at: seen.at, model: seen.model, items: seen.items, retryAfter: seen.retryAfter } : null
      });
    }
    const models = this._context.globalState.get('localAI.cloudModels', []).map((m) => ({
      ...m,
      tier: cloudCap(m.name, 'tools') === false ? 'notools' : cloud.rank(m.modelId),
      vision: isVisionModel(m.name)
    }));
    return { providers, models };
  }

  async _cloudConnect() {
    const items = (await this._cloudState()).providers.map((p) => {
      const def = cloud.provider(p.id);
      return { label: `${p.hasKey ? '$(check) ' : ''}${p.name}`, description: p.hasKey ? 'key saved' : def.keyUrl ? 'free key available' : '', detail: p.note, id: p.id };
    });
    const picked = await vscode.window.showQuickPick(items, {
      title: 'Connect a cloud provider',
      placeHolder: 'Local models too weak? Pick a provider with a free tier. Your prompts are sent to it.'
    });
    if (!picked) return;
    const state = (await this._cloudState()).providers.find((p) => p.id === picked.id);
    if (state && state.hasKey) await this._cloudPickModels(picked.id);
    else await this._cloudSetKey(picked.id, true);
  }

  async _cloudSetKey(providerId, offerKeyPage) {
    const def = cloud.provider(providerId);
    if (!def) return;
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
        `${def.name}: create a free API key on their site, then paste it here.`,
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
  }

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
  }

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
  }

  async _cloudRemoveKey(providerId) {
    const def = cloud.provider(providerId);
    const confirm = await vscode.window.showWarningMessage(`Remove the ${def.name} key and its models from this extension?`, { modal: true }, 'Remove');
    if (confirm !== 'Remove') return;
    await this._context.secrets.delete(`localAI.key.${providerId}`);
    const current = this._context.globalState.get('localAI.cloudModels', []);
    await this._context.globalState.update('localAI.cloudModels', current.filter((m) => m.providerId !== providerId));
    const selected = this._context.globalState.get('localAI.selectedModel');
    const parsed = cloud.parseName(selected);
    if (parsed && parsed.providerId === providerId) await modelState.setSelectedModel(this._context, undefined);
    await this._refreshState();
  }

  async _cloudRemoveModel(name) {
    const current = this._context.globalState.get('localAI.cloudModels', []);
    await this._context.globalState.update('localAI.cloudModels', current.filter((m) => m.name !== name));
    if (this._context.globalState.get('localAI.selectedModel') === name) await modelState.setSelectedModel(this._context, undefined);
    await this._refreshState();
  }

  async _chooseVariant(modelName) {
    if (!modelName) return;
    let variants;
    try {
      variants = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Loading variants of ${modelName} from ollama.com...` },
        () => modelTags.fetchVariants(modelName)
      );
    } catch (err) {
      const choice = await vscode.window.showErrorMessage(
        `Could not load the variant list: ${err.message}`,
        'Enter a tag manually'
      );
      if (choice === 'Enter a tag manually') {
        const [family, size] = modelName.split(':');
        const typed = await vscode.window.showInputBox({
          prompt: `Exact tag to download, for example ${family}:${(size || '7b').split('-')[0]}-instruct-q8_0 (see ollama.com/library/${family}/tags)`,
          value: modelName,
          validateInput: (v) => (/^[\w.\-]+(?::[\w.\-]+)?$/.test(v) ? null : 'Use the form name:tag')
        });
        if (typed) await this._installModel(typed.trim());
      }
      return;
    }
    if (!variants || variants.length === 0) {
      vscode.window.showInformationMessage(`${modelName} has no other quantization variants. You can still install it as it is.`);
      return;
    }

    const localModels = await this._ollamaClient.listLocalModels().catch(() => []);
    const installed = new Set(localModels.map((m) => m.name));
    const byDigest = new Map(localModels.filter((m) => m.digest).map((m) => [m.digest.slice(0, 12), m.name]));
    const installedAs = (v) => (v.digest && byDigest.get(v.digest)) || (installed.has(v.name) ? v.name : null);

    const ctx = generationLib.summary().contextSize;
    const hw = hardware.info();
    const best = hardware.bestVariant(variants, ctx);
    const rows = variants.map((v) => ({ v, a: hardware.assess(v.sizeGB, v.name, ctx) }));
    const iconFor = { great: '$(pass-filled)', ok: '$(pass)', tight: '$(warning)', slow: '$(clock)', heavy: '$(error)', unknown: '$(circle-outline)' };

    const makeItem = ({ v, a }) => ({
      label: `${best && v.name === best.name ? '$(star-full) ' : `${iconFor[a.level]} `}${installedAs(v) ? '$(check) ' : ''}${v.quant}`,
      description: `${v.sizeGB ? `${v.sizeGB.toFixed(1)} GB` : 'size unknown'}${v.context ? ` \u00b7 ${v.context} context` : ''}${installedAs(v) ? ` \u00b7 installed as ${installedAs(v)}` : ''}`,
      detail: `${best && v.name === best.name ? 'Recommended for your computer. ' : ''}${hardware.LEVEL_TEXT[a.level] ? `${hardware.LEVEL_TEXT[a.level][0].toUpperCase()}${hardware.LEVEL_TEXT[a.level].slice(1)}` : ''}${a.needGB ? ` (needs about ${a.needGB.toFixed(1)} GB of ${a.budgetGB.toFixed(1)} GB)` : ''}. ${v.note}  [${v.name}]`,
      variant: v
    });

    const Separator = vscode.QuickPickItemKind.Separator;
    const items = [];
    const push = (label, filter) => {
      const group = rows.filter(filter).sort((x, y) => y.v.sizeGB - x.v.sizeGB);
      if (group.length === 0) return;
      items.push({ label, kind: Separator });
      group.forEach((r) => items.push(makeItem(r)));
    };
    push('Recommended for your computer', (r) => best && r.v.name === best.name);
    push('Fits your computer', (r) => ['great', 'ok'].includes(r.a.level) && !(best && r.v.name === best.name));
    push('Tight or slow', (r) => ['tight', 'slow'].includes(r.a.level));
    push('Too heavy for this computer', (r) => r.a.level === 'heavy');
    push('Size unknown', (r) => r.a.level === 'unknown');

    const picked = await vscode.window.showQuickPick(items, {
      title: `Quantization for ${modelName}  -  your computer: ${hw.label}`,
      placeHolder: best
        ? 'The star is the best quality that still fits well. Lower number = smaller and faster, higher = better quality.'
        : 'None of these fit well on this computer. A smaller model (e.g. 7B) with a higher quantization is a better choice.',
      matchOnDetail: true
    });
    if (!picked || !picked.variant) return;
    const already = installedAs(picked.variant);
    if (already) {
      await modelState.setSelectedModel(this._context, already);
      vscode.window.showInformationMessage(`Already installed as ${already}. It is now the active model.`);
      return;
    }
    await this._installModel(picked.variant.name, picked.variant.sizeGB || undefined);
  }

  _hardwareState() {
    const hw = hardware.info();
    const ctx = generationLib.summary().contextSize;
    const fits = {};
    RECOMMENDED_MODELS.forEach((m) => {
      fits[m.name] = { level: hardware.assess(m.sizeGB, m.name, ctx).level, best: false };
    });
    ['code', 'general', 'vision'].forEach((category) => {
      const candidates = RECOMMENDED_MODELS.filter((m) => m.category === category && ['great', 'ok'].includes(fits[m.name].level))
        .sort((a, b) => b.sizeGB - a.sizeGB);
      const withTools = candidates.filter((m) => (m.tags || []).includes('tools'));
      const pick = (category === 'vision' ? candidates : withTools.length ? withTools : candidates)[0];
      if (pick) fits[pick.name].best = true;
    });
    return { label: hw.label, comfortGB: Math.round(hardware.comfortableModelGB(ctx) * 10) / 10, fits };
  }

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
  }

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
  }

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
          const entry = require('./models.json').find((c) => c.name === m.name);
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
  }

  async _chooseCloudContext() {
    const config = vscode.workspace.getConfiguration('localAI');
    const current = Number(config.get('cloudContextSize')) || 12000;
    const sizes = [4000, 6000, 8000, 12000, 16000, 32000];
    const notes = {
      4000: 'safest for very small free limits',
      6000: 'fits tiny per-minute limits (compact mode)',
      8000: 'compact mode up to here',
      12000: 'default',
      16000: 'longer chats, needs a bigger free limit',
      32000: 'only for providers with large limits'
    };
    const picked = await vscode.window.showQuickPick(
      sizes.map((n) => ({ label: `${n === current ? '$(check) ' : ''}${Math.round(n / 1000)}K tokens`, description: notes[n], value: n })),
      { title: 'Cloud context size (how much is sent to a cloud model)', placeHolder: 'Free tiers allow only a few thousand tokens per minute. The extension also lowers this automatically from the limit the provider reports.' }
    );
    if (picked) await config.update('cloudContextSize', picked.value, vscode.ConfigurationTarget.Global);
  }

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
  }

  async _addAccessFolder() {
    const picked = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      openLabel: 'Choose folder',
      title: 'Choose a folder to give or restrict access to'
    });
    if (!picked || picked.length === 0) return;
    const folderPath = workspaceLib.normalize(picked[0].fsPath);
    const level = await vscode.window.showQuickPick(
      [
        { label: 'Read only', description: 'The AI can look at the files but not change them', level: 'read' },
        { label: 'Ask first', description: 'Reads freely; every edit or command needs your approval, even in auto modes', level: 'ask' },
        { label: 'Full access', description: 'Follows the permission mode (ask / auto / autopilot)', level: 'full' },
        { label: 'No access', description: 'Hide this folder from the AI completely', level: 'none' }
      ],
      { title: `Access level for ${this._pretty(folderPath)}` }
    );
    if (!level) return;
    await this._setFolderLevel(folderPath, level.level);
  }

  async _addSkillFolder() {
    const picked = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      openLabel: 'Use as skills folder',
      title: 'Choose a folder that contains skills (subfolders with SKILL.md)'
    });
    if (!picked || picked.length === 0) return;
    const config = vscode.workspace.getConfiguration('localAI');
    const current = config.get('extraSkillFolders') || [];
    const next = picked[0].fsPath;
    if (!current.includes(next)) {
      await config.update('extraSkillFolders', [...current, next], vscode.ConfigurationTarget.Global);
    }
  }

  async _uninstallOllama() {
    const confirm = await vscode.window.showWarningMessage(
      'This will completely remove Ollama and delete ALL downloaded models from your disk. This cannot be undone. Are you sure?',
      { modal: true },
      'Uninstall everything'
    );
    if (confirm !== 'Uninstall everything') return;

    const platform = process.platform;
    let commands = [];

    if (platform === 'darwin') {
      let hasBrew = false;
      try {
        const { execSync } = require('child_process');
        execSync('which brew', { timeout: 3000 });
        hasBrew = true;
      } catch (_) {
        hasBrew = false;
      }

      if (hasBrew) {
        commands = [
          'brew services stop ollama',
          'brew uninstall ollama',
          'rm -rf ~/.ollama'
        ];
      } else {
        commands = [
          'pkill ollama',
          'rm -rf /Applications/Ollama.app',
          'sudo rm -f /usr/local/bin/ollama',
          'rm -rf ~/.ollama'
        ];
      }
    } else if (platform === 'linux') {
      commands = [
        'sudo systemctl stop ollama',
        'sudo systemctl disable ollama',
        'sudo rm -f /usr/local/bin/ollama',
        'sudo rm -rf /usr/share/ollama',
        'sudo rm -f /etc/systemd/system/ollama.service',
        'rm -rf ~/.ollama'
      ];
    } else {
      vscode.window.showInformationMessage(
        'On Windows, uninstall Ollama from Settings > Apps, like any other program. Its model data lives in %USERPROFILE%\\.ollama if you want to delete that too.'
      );
      return;
    }

    const terminal = vscode.window.createTerminal('Uninstall Ollama');
    terminal.show();
    terminal.sendText(commands.join(' && '));

    vscode.window.showInformationMessage(
      'Uninstall started in the terminal. Some steps may ask for your password. Click "Check again" once it finishes.'
    );

    await modelState.setSelectedModel(this._context, undefined);
  }

  async _waitUntilReady(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this._ollamaClient.ping()) return true;
      await new Promise((resolve) => setTimeout(resolve, 600));
    }
    return false;
  }

  async _startOllamaServer() {
    if (await this._ollamaClient.ping()) {
      await this._refreshState();
      return;
    }

    const result = ollamaProcess.startServer();

    if (!result.started && result.reason === 'not-installed') {
      vscode.window.showErrorMessage(
        'Ollama is not installed (the "ollama" program was not found). Use "Install automatically" or download it from ollama.com.'
      );
      await this._refreshState();
      return;
    }

    if (!result.started && result.reason !== 'already-running') {
      vscode.window.showErrorMessage(`Could not start Ollama: ${result.reason}`);
      await this._refreshState();
      return;
    }

    const ready = await this._waitUntilReady(12000);
    if (!ready) {
      vscode.window.showErrorMessage('Ollama was started but is not answering yet. Click "Check again" in a few seconds.');
    }
    await this._refreshState();
  }

  _autoInstallOllama() {
    const platform = process.platform; // 'darwin' | 'linux' | 'win32'
    let command = null;

    if (platform === 'linux') {
      command = 'curl -fsSL https://ollama.com/install.sh | sh';
    } else if (platform === 'darwin') {
      let hasBrew = false;
      try {
        const { execSync } = require('child_process');
        execSync('which brew', { timeout: 3000 });
        hasBrew = true;
      } catch (_) {
        hasBrew = false;
      }
      if (hasBrew) {
        command = 'brew install ollama && brew services start ollama';
      }
    }

    if (!command) {
      vscode.window.showInformationMessage(
        'Automatic installation is not available on this OS (no Homebrew, or this is Windows). Opening the download page instead.'
      );
      vscode.env.openExternal(vscode.Uri.parse('https://ollama.com/download'));
      return;
    }

    const terminal = vscode.window.createTerminal('Install Ollama');
    terminal.show();
    terminal.sendText(command);

    vscode.window.showInformationMessage(
      'Installation started in the terminal. Once it finishes, click "Check again".'
    );
  }

  async _deleteModel(modelName) {
    const confirm = await vscode.window.showWarningMessage(
      `Delete model "${modelName}" from disk? This frees up space, but you'll need to download it again if you need it later.`,
      { modal: true },
      'Delete'
    );
    if (confirm !== 'Delete') return;

    try {
      await this._ollamaClient.deleteModel(modelName);

      const currentSelected = this._context.globalState.get('localAI.selectedModel');
      if (currentSelected === modelName) {
        await modelState.setSelectedModel(this._context, undefined);
      }

      vscode.window.showInformationMessage(`Model ${modelName} deleted.`);
      await this._refreshState();
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to delete model: ${err.message}`);
    }
  }

  async _promptManualModel() {
    const modelName = await vscode.window.showInputBox({
      prompt: 'Model name (e.g. llama3.1:8b)',
      placeHolder: 'model:tag'
    });
    if (modelName) {
      await this._installModel(modelName);
    }
  }

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
  }

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
  }

  async _commonState() {
    const config = vscode.workspace.getConfiguration('localAI');
    return {
      selectedModel: this._context.globalState.get('localAI.selectedModel') || null,
      systemPrompt: this._context.globalState.get('localAI.systemPrompt') || '',
      keepAlive: this._context.globalState.get('localAI.keepAlive') || '',
      includeActiveFile: this._context.globalState.get('localAI.includeActiveFile', false),
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
      totalRamGB: require('os').totalmem() / (1024 * 1024 * 1024),
      hardware: this._hardwareState()
    });
  }

  async _installModel(modelName, sizeOverrideGB) {
    if (!this._view || this._pullInProgress.has(modelName)) return;

    const catalogEntry = RECOMMENDED_MODELS.find((m) => m.name === modelName);
    const knownSize = typeof sizeOverrideGB === 'number' ? sizeOverrideGB : catalogEntry && catalogEntry.sizeGB;
    if (typeof knownSize === 'number') {
      const os = require('os');
      const totalRamGB = os.totalmem() / (1024 * 1024 * 1024);
      if (knownSize > totalRamGB * 0.7) {
        const choice = await vscode.window.showWarningMessage(
          `This model needs about ${knownSize} GB, but your machine has ~${totalRamGB.toFixed(0)} GB of RAM total. It may run very slowly, swap heavily, or fail to load. Continue anyway?`,
          { modal: true },
          'Install anyway'
        );
        if (choice !== 'Install anyway') return;
      }
    }

    this._pullInProgress.add(modelName);

    this._view.webview.postMessage({ type: 'pullStart', modelName });

    let lastPercent = 0;
    try {
      await this._ollamaClient.pullModel(modelName, (evt) => {
        if (!this._view) return;
        if (evt.total && evt.completed) {
          const percent = Math.round((evt.completed / evt.total) * 100);
          if (percent !== lastPercent) {
            lastPercent = percent;
            this._view.webview.postMessage({
              type: 'pullProgress',
              modelName,
              percent,
              status: evt.status || ''
            });
          }
        } else if (evt.status) {
          this._view.webview.postMessage({
            type: 'pullProgress',
            modelName,
            percent: lastPercent,
            status: evt.status
          });
        }
      }, { onAbortReady: (abort) => this._pullAborts.set(modelName, abort) });
      this._pullAborts.delete(modelName);

      await modelState.setSelectedModel(this._context, modelName);
      this._pullInProgress.delete(modelName);
      this._view.webview.postMessage({ type: 'pullDone', modelName });
      await this._refreshState();
      vscode.window.showInformationMessage(
        `Model ${modelName} downloaded and ready to use offline.`
      );
    } catch (err) {
      this._pullInProgress.delete(modelName);
      this._pullAborts.delete(modelName);
      if (err.cancelled) {
        this._view.webview.postMessage({ type: 'pullCancelled', modelName });
        vscode.window.showInformationMessage(`Download of ${modelName} cancelled. What was already downloaded is kept, so installing it again resumes.`);
        return;
      }
      this._view.webview.postMessage({
        type: 'pullError',
        modelName,
        message: err.message
      });
      vscode.window.showErrorMessage(`Failed to download model: ${err.message}`);
    }
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

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<link rel="stylesheet" href="${media('sidebar', 'sidebar.css')}" />
</head>
<body>
  <div id="content"></div>
<script>window.ICONS = ${iconMap}; window.__LANG = ${JSON.stringify(uiLang)};</script>
<script src="${media('i18n.js')}"></script>
<script src="${media('sidebar', 'sidebar.js')}"></script>
</body>
</html>`;
  }
}

module.exports = { SidebarProvider };
