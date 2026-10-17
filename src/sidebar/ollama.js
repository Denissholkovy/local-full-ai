const { vscode, modelState, RECOMMENDED_MODELS, ollamaProcess, modelTags, generationLib, hardware } = require('./common');

// Methods mixed into SidebarProvider.prototype (see sidebarProvider.js).
module.exports = {
  // The extension never deletes Ollama itself: it shows the steps and lets the user run them.
  async _uninstallOllama() {
    let steps;
    if (process.platform === 'darwin') {
      steps = 'Quit Ollama from the menu bar, move Ollama.app from Applications to the Trash, then (to free the disk space of the models) delete the folder ~/.ollama. If you installed it with Homebrew: brew uninstall ollama.';
    } else if (process.platform === 'linux') {
      steps = 'Stop and remove the service and binary as described in the official Linux guide, then delete ~/.ollama (and /usr/share/ollama) to free the disk space of the models.';
    } else {
      steps = 'Uninstall Ollama from Settings > Apps like any other program, then delete %USERPROFILE%\\.ollama to free the disk space of the models.';
    }
    const choice = await vscode.window.showInformationMessage(
      `How to remove Ollama: ${steps} This deletes all downloaded models. The extension does not do it for you, so nothing is removed by accident.`,
      { modal: true },
      'Open the official guide'
    );
    if (choice === 'Open the official guide') {
      const url = process.platform === 'linux'
        ? 'https://github.com/ollama/ollama/blob/main/docs/linux.md#uninstall'
        : 'https://github.com/ollama/ollama/blob/main/docs/faq.md';
      vscode.env.openExternal(vscode.Uri.parse(url));
    }
  },

  async _waitUntilReady(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this._ollamaClient.ping()) return true;
      await new Promise((resolve) => setTimeout(resolve, 600));
    }
    return false;
  },

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
  },

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
  },

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
  },

  async _promptManualModel() {
    const modelName = await vscode.window.showInputBox({
      prompt: 'Model name (e.g. llama3.1:8b)',
      placeHolder: 'model:tag'
    });
    if (modelName) {
      await this._installModel(modelName);
    }
  },

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
  },

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
  },

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
  },
};
