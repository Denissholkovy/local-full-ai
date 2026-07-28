const vscode = require('vscode');
const { RECOMMENDED_MODELS } = require('./modelPicker');
const { ICONS } = require('./icons');
const ollamaProcess = require('./ollamaProcess');

class SidebarProvider {
  constructor(context, ollamaClient) {
    this._context = context;
    this._ollamaClient = ollamaClient;
    this._view = null;
    this._pullInProgress = new Set();
  }

  resolveWebviewView(webviewView) {
    this._view = webviewView;
    webviewView.webview.options = { enableScripts: true };
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
          await this._context.globalState.update('localAI.selectedModel', msg.modelName);
          await this._refreshState();
          break;
        case 'deleteModel':
          await this._deleteModel(msg.modelName);
          break;
        case 'openChat':
          await vscode.commands.executeCommand('localAI.openChat');
          break;
        case 'askSelection':
          await vscode.commands.executeCommand('localAI.askAboutSelection');
          break;
        case 'manualModel':
          await this._promptManualModel();
          break;
      }
    });

    this._refreshState();
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

    await this._context.globalState.update('localAI.selectedModel', undefined);
  }

  async _startOllamaServer() {
    const result = ollamaProcess.startServer();

    if (!result.started && result.reason === 'already-running') {
      vscode.window.showInformationMessage('Ollama server is already running.');
      await this._refreshState();
      return;
    }

    if (!result.started) {
      vscode.window.showErrorMessage(
        `Could not start Ollama: ${result.reason}. Make sure Ollama is installed and the "ollama" command is on your PATH.`
      );
      return;
    }

    vscode.window.showInformationMessage(
      'Starting Ollama server... it will stop automatically when you close VS Code.'
    );

    await new Promise((resolve) => setTimeout(resolve, 1500));
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
        await this._context.globalState.update('localAI.selectedModel', undefined);
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

  async _refreshState() {
    if (!this._view) return;

    const isRunning = await this._ollamaClient.ping();
    if (!isRunning) {
      this._view.webview.postMessage({ type: 'ollamaNotRunning' });
      return;
    }

    let localModels = [];
    try {
      localModels = await this._ollamaClient.listLocalModels();
    } catch (_) {
      localModels = [];
    }

    const localNames = localModels.map((m) => m.name);
    const selectedModel = this._context.globalState.get('localAI.selectedModel') || null;

    this._view.webview.postMessage({
      type: 'ollamaReady',
      installedModels: localNames,
      recommendedModels: RECOMMENDED_MODELS,
      selectedModel
    });
  }

  async _installModel(modelName) {
    if (!this._view || this._pullInProgress.has(modelName)) return;
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
      });

      await this._context.globalState.update('localAI.selectedModel', modelName);
      this._pullInProgress.delete(modelName);
      this._view.webview.postMessage({ type: 'pullDone', modelName });
      await this._refreshState();
      vscode.window.showInformationMessage(
        `Model ${modelName} downloaded and ready to use offline.`
      );
    } catch (err) {
      this._pullInProgress.delete(modelName);
      this._view.webview.postMessage({
        type: 'pullError',
        modelName,
        message: err.message
      });
      vscode.window.showErrorMessage(`Failed to download model: ${err.message}`);
    }
  }

  _getHtml() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<style>
  * { box-sizing: border-box; }
  body {
    font-family: var(--vscode-font-family);
    color: var(--vscode-editor-foreground);
    padding: 12px;
    margin: 0;
  }
  h3 {
    margin: 0 0 8px 0;
    font-size: 11px;
    text-transform: uppercase;
    opacity: 0.65;
    letter-spacing: 0.5px;
  }
  .box {
    padding: 12px;
    border-radius: 6px;
    background: var(--vscode-textBlockQuote-background);
    margin-bottom: 14px;
    font-size: 13px;
    line-height: 1.5;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .box.warn { border-left: 3px solid #d9822b; }
  .box.ok { border-left: 3px solid #4caf50; }
  .box .icon-svg { flex-shrink: 0; }

  button {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    text-align: left;
    background: var(--vscode-button-secondaryBackground, var(--vscode-button-background));
    color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground));
    border: none;
    padding: 9px 12px;
    margin-bottom: 8px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 13px;
  }
  .icon-svg { flex-shrink: 0; display: block; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button:disabled { opacity: 0.5; cursor: default; }
  button.primary {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    font-weight: 600;
  }
  button.primary:hover { background: var(--vscode-button-hoverBackground); }

  .model-card {
    border: 1px solid var(--vscode-widget-border);
    border-radius: 6px;
    padding: 10px;
    margin-bottom: 10px;
  }
  .model-card .name {
    font-weight: 600;
    font-size: 13px;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .model-card .desc {
    font-size: 11px;
    opacity: 0.7;
    margin: 3px 0 8px 0;
  }
  .badge {
    font-size: 10px;
    padding: 2px 6px;
    border-radius: 10px;
    background: #4caf50;
    color: white;
  }
  .badge.active {
    background: var(--vscode-button-background);
  }

  .quick-switch {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 14px;
  }
  .quick-switch .chip {
    padding: 4px 10px;
    border-radius: 12px;
    background: var(--vscode-editorWidget-background);
    border: 1px solid var(--vscode-widget-border);
    font-size: 11px;
    cursor: pointer;
  }
  .quick-switch .chip:hover {
    background: rgba(127,127,127,0.2);
  }
  .quick-switch .chip.active {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border-color: var(--vscode-button-background);
    cursor: default;
  }

  .model-card .name-actions {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .icon-btn {
    display: inline-flex;
    width: auto;
    background: transparent !important;
    border: none;
    padding: 2px 5px !important;
    margin: 0 !important;
    cursor: pointer;
    opacity: 0.6;
  }
  .icon-btn:hover {
    opacity: 1;
    background: rgba(244,71,71,0.15) !important;
    border-radius: 4px;
  }
  .progress-track {
    height: 6px;
    border-radius: 3px;
    background: var(--vscode-editorWidget-background);
    overflow: hidden;
    margin-top: 6px;
  }
  .progress-fill {
    height: 100%;
    background: var(--vscode-button-background);
    width: 0%;
    transition: width 0.2s ease;
  }
  .progress-label {
    font-size: 10px;
    opacity: 0.7;
    margin-top: 4px;
  }
  #loading { font-size: 12px; opacity: 0.7; }
  .divider { height: 1px; background: var(--vscode-widget-border); margin: 14px 0; }

  .category-header {
    display: flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
    padding: 6px 4px;
    margin-top: 10px;
    border-radius: 4px;
    user-select: none;
  }
  .category-header:hover {
    background: rgba(127,127,127,0.15);
  }
  .category-header .chevron {
    display: flex;
    align-items: center;
    opacity: 0.7;
  }
  .category-header .category-title {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    opacity: 0.9;
    font-weight: 600;
  }
  .category-header .category-count {
    font-size: 10px;
    opacity: 0.55;
    margin-left: auto;
  }

  .family-heading {
    font-size: 10.5px;
    opacity: 0.6;
    margin: 10px 0 4px 4px;
    text-transform: uppercase;
    letter-spacing: 0.3px;
  }
  .danger-zone {
    margin-top: 16px;
    padding-top: 12px;
    border-top: 1px solid var(--vscode-widget-border);
  }
  .danger-link {
    background: transparent !important;
    color: var(--vscode-errorForeground) !important;
    opacity: 0.6;
    font-size: 12px;
  }
  .danger-link:hover {
    opacity: 1;
    background: rgba(244,71,71,0.1) !important;
  }
</style>
</head>
<body>
  <div id="content"><div id="loading">Checking Ollama...</div></div>

<script>
  const vscode = acquireVsCodeApi();
  const content = document.getElementById('content');
  let state = { view: 'loading' };
  const pulls = {};
  const collapsedCategories = {};

  function send(type, extra) {
    vscode.postMessage(Object.assign({ type }, extra || {}));
  }

  function render() {
    if (state.view === 'loading') {
      content.innerHTML = '<div id="loading">Checking Ollama...</div>';
      return;
    }

    if (state.view === 'notRunning') {
      content.innerHTML =
        '<div class="box warn">${ICONS.warning} Ollama was not found or is not running on localhost.</div>' +
        '<h3>Already installed?</h3>' +
        '<button class="primary" id="btnStartServer">${ICONS.play} Start Ollama server</button>' +
        '<h3 style="margin-top:14px;">Not installed yet?</h3>' +
        '<button id="btnAutoInstall">${ICONS.bolt} Install automatically</button>' +
        '<button id="btnDownload">${ICONS.download} Download manually (website)</button>' +
        '<button id="btnRecheck">${ICONS.refresh} I installed it, check again</button>' +
        '<div class="danger-zone"><button id="btnUninstall" class="danger-link">${ICONS.trash} Uninstall Ollama completely</button></div>';
      document.getElementById('btnStartServer').onclick = () => {
        state.view = 'loading';
        render();
        send('startOllamaServer');
      };
      document.getElementById('btnAutoInstall').onclick = () => send('autoInstallOllama');
      document.getElementById('btnDownload').onclick = () => send('openOllamaSite');
      document.getElementById('btnRecheck').onclick = () => {
        state.view = 'loading';
        render();
        send('recheckOllama');
      };
      document.getElementById('btnUninstall').onclick = () => send('uninstallOllama');
      return;
    }

    if (state.view === 'ready') {
      let html = '';

      if (state.selectedModel) {
        html += '<div class="box ok">${ICONS.check} Active model: <b>' + state.selectedModel + '</b></div>';
        html += '<button class="primary" id="btnChat">${ICONS.chat} Open chat</button>';
        html += '<button id="btnAsk">${ICONS.scissors} Ask about selected code</button>';

        if (state.installedModels.length > 0) {
          html += '<h3>Quick switch</h3>';
          html += '<div class="quick-switch">';
          state.installedModels.forEach((name) => {
            const isActive = name === state.selectedModel;
            html += '<span class="chip' + (isActive ? ' active' : '') + '" data-quick-model="' + name + '">' + name + '</span>';
          });
          html += '</div>';
        }

        html += '<div class="divider"></div>';
      } else {
        html += '<div class="box warn">${ICONS.warning} No model selected yet. Pick one below.</div>';
      }

      html += '<h3>Models</h3>';

      const allModels = state.recommendedModels.map((m) => ({
        name: m.name,
        label: m.label,
        description: m.description,
        category: m.category || 'general',
        family: m.family || m.name,
        sizeGB: typeof m.sizeGB === 'number' ? m.sizeGB : 0
      }));

      state.installedModels.forEach((name) => {
        if (!allModels.find((m) => m.name === name)) {
          allModels.unshift({ name, label: name, description: 'installed manually', category: 'other', family: name, sizeGB: 0 });
        }
      });

      const categoryLabels = { code: 'Code', general: 'General', vision: 'Vision', other: 'Other' };
      const categoryOrder = ['code', 'general', 'vision', 'other'];
      const grouped = {};
      allModels.forEach((m) => {
        if (!grouped[m.category]) grouped[m.category] = [];
        grouped[m.category].push(m);
      });

      categoryOrder.forEach((cat) => {
        if (!grouped[cat] || grouped[cat].length === 0) return;
        const isCollapsed = collapsedCategories[cat] !== false;

        html += '<div class="category-header" data-category="' + cat + '">' +
          '<span class="chevron">' + (isCollapsed ? '${ICONS.chevronRight}' : '${ICONS.chevronDown}') + '</span>' +
          '<span class="category-title">' + (categoryLabels[cat] || cat) + '</span>' +
          '<span class="category-count">' + grouped[cat].length + '</span>' +
        '</div>';

        if (isCollapsed) return;

        const byFamily = {};
        const familyOrder = [];
        grouped[cat].forEach((m) => {
          if (!byFamily[m.family]) {
            byFamily[m.family] = [];
            familyOrder.push(m.family);
          }
          byFamily[m.family].push(m);
        });

        const familyRank = familyOrder.map((fam, idx) => {
          const models = byFamily[fam];
          const hasActive = models.some((m) => m.name === state.selectedModel);
          const hasInstalled = models.some((m) => state.installedModels.includes(m.name));
          const priority = hasActive ? 0 : hasInstalled ? 1 : 2;
          return { fam, priority, idx };
        });
        familyRank.sort((a, b) => a.priority - b.priority || a.idx - b.idx);

        familyRank.forEach(({ fam }) => {
          const modelsInFamily = byFamily[fam].slice().sort((a, b) => a.sizeGB - b.sizeGB);

          html += '<div class="family-heading">' + fam + '</div>';

          modelsInFamily.forEach((m) => {
            const installed = state.installedModels.includes(m.name);
            const isActive = state.selectedModel === m.name;
            const pull = pulls[m.name];

            html += '<div class="model-card" data-model="' + m.name + '">';
            html += '<div class="name"><span>' + m.label + '</span>';
            html += '<span class="name-actions">';
            if (isActive) html += '<span class="badge active">active</span>';
            else if (installed) html += '<span class="badge">downloaded</span>';
            if (installed) {
              html += '<button class="icon-btn" data-action="delete" data-model="' + m.name + '" title="Delete model">${ICONS.trash}</button>';
            }
            html += '</span>';
            html += '</div>';
            html += '<div class="desc">' + (m.description || '') + '</div>';

            if (pull && !pull.done) {
              html += '<div class="progress-track"><div class="progress-fill" style="width:' + (pull.percent || 0) + '%"></div></div>';
              html += '<div class="progress-label">' + (pull.status || '') + ' ' + (pull.percent || 0) + '%</div>';
            } else if (installed) {
              html += '<button data-action="use" data-model="' + m.name + '"' + (isActive ? ' disabled' : '') + '>' +
                      (isActive ? '${ICONS.check} Selected' : 'Use this model') + '</button>';
            } else {
              html += '<button data-action="install" data-model="' + m.name + '">Install</button>';
            }

            html += '</div>';
          });
        });
      });

      html += '<button id="btnManual">${ICONS.pencil} Enter a model name manually...</button>';
      html += '<div class="danger-zone"><button id="btnUninstall" class="danger-link">${ICONS.trash} Uninstall Ollama completely</button></div>';

      content.innerHTML = html;

      content.querySelectorAll('.category-header').forEach((header) => {
        header.onclick = () => {
          const cat = header.getAttribute('data-category');
          const currentlyCollapsed = collapsedCategories[cat] !== false;
          collapsedCategories[cat] = !currentlyCollapsed;
          render();
        };
      });

      const chatBtn = document.getElementById('btnChat');
      if (chatBtn) chatBtn.onclick = () => send('openChat');
      const askBtn = document.getElementById('btnAsk');
      if (askBtn) askBtn.onclick = () => send('askSelection');
      document.getElementById('btnManual').onclick = () => send('manualModel');
      document.getElementById('btnUninstall').onclick = () => send('uninstallOllama');

      content.querySelectorAll('button[data-action="install"]').forEach((btn) => {
        btn.onclick = () => send('installModel', { modelName: btn.getAttribute('data-model') });
      });
      content.querySelectorAll('button[data-action="use"]').forEach((btn) => {
        btn.onclick = () => send('selectInstalledModel', { modelName: btn.getAttribute('data-model') });
      });
      content.querySelectorAll('button[data-action="delete"]').forEach((btn) => {
        btn.onclick = (e) => {
          e.stopPropagation();
          send('deleteModel', { modelName: btn.getAttribute('data-model') });
        };
      });
      content.querySelectorAll('.quick-switch .chip[data-quick-model]').forEach((chip) => {
        if (chip.classList.contains('active')) return;
        chip.onclick = () => send('selectInstalledModel', { modelName: chip.getAttribute('data-quick-model') });
      });
    }
  }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'ollamaNotRunning':
        state = { view: 'notRunning' };
        render();
        break;
      case 'ollamaReady':
        state = {
          view: 'ready',
          installedModels: msg.installedModels,
          recommendedModels: msg.recommendedModels,
          selectedModel: msg.selectedModel
        };
        render();
        break;
      case 'pullStart':
        pulls[msg.modelName] = { percent: 0, status: 'Starting download...', done: false };
        render();
        break;
      case 'pullProgress':
        pulls[msg.modelName] = { percent: msg.percent, status: msg.status, done: false };
        render();
        break;
      case 'pullDone':
        pulls[msg.modelName] = { percent: 100, status: 'Done', done: true };
        break;
      case 'pullError':
        delete pulls[msg.modelName];
        render();
        break;
    }
  });

  send('ready');
</script>
</body>
</html>`;
  }
}

module.exports = { SidebarProvider };
