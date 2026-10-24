const vscode = require('vscode');
const capabilities = require('./modelCapabilities');
const { isOllamaCloud } = require('./cloudProviders');

// Code completion as you type ("fill in the middle") with a small local model. Opt-in: it keeps a model busy.
const DEBOUNCE_MS = 300;
const PREFIX_CHARS = 3000;
const SUFFIX_CHARS = 1000;
const MAX_LINES = 8;
const PREFERRED_GB = 0.9;

function config() {
  return vscode.workspace.getConfiguration('localAI');
}

function wait(ms, token) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(true), ms);
    token.onCancellationRequested(() => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

// Cleans the model's answer: no repeated suffix, no runaway text, one line when the cursor is mid-line.
function tidy(text, suffix, midLine) {
  let out = String(text || '').replace(/\r\n/g, '\n');
  out = out.replace(/<\|[^|]*\|>|<fim_\w+>|<EOT>/g, '');
  const sameLine = suffix.split('\n')[0].trim();
  if (sameLine) {
    const at = out.indexOf(sameLine);
    if (at > 0) out = out.slice(0, at);
  }
  // Models often write the code that already follows the cursor again: stop where it starts.
  const nextCode = suffix.split('\n').map((l) => l.trim()).find((l) => l.length >= 4);
  let lines = out.split('\n');
  if (nextCode) {
    const repeat = lines.findIndex((l, i) => i > 0 && l.trim() === nextCode);
    if (repeat > 0) lines = lines.slice(0, repeat);
  }
  out = lines.join('\n').replace(/\n+$/, '');
  lines = out.split('\n');
  out = (midLine ? lines.slice(0, 1) : lines.slice(0, MAX_LINES)).join('\n');
  return out.replace(/\s+$/, '');
}

class CompletionProvider {
  constructor(context, client) {
    this._context = context;
    this._client = client;
    this._lastModel = null;
    this._failures = 0;
  }

  enabled() {
    return config().get('autocomplete') === true;
  }

  // The configured model, or the smallest installed local model that can fill in the middle.
  async model() {
    const chosen = String(config().get('autocompleteModel') || '').trim();
    if (chosen && chosen !== 'auto') return chosen;
    if (this._lastModel) return this._lastModel;
    const installed = (await this._client.listLocalModels().catch(() => []))
      .filter((m) => !isOllamaCloud(m.name))
      .sort((a, b) => a.size - b.size);
    const save = (map) => this._context.globalState.update('localAI.localCaps', map);
    for (const m of installed) await capabilities.learnLocal(this._client, m.name, save);
    const fim = installed.filter((m) => capabilities.localCap(m.name, 'insert'));
    const pick = fim.find((m) => m.size >= PREFERRED_GB * 1e9) || fim[0];
    this._lastModel = pick ? pick.name : null;
    return this._lastModel;
  }

  forget() {
    this._lastModel = null;
    this._failures = 0;
  }

  async provideInlineCompletionItems(document, position, context, token) {
    if (!this.enabled() || this._failures >= 3) return null;
    if (context.selectedCompletionInfo) return null;
    if (!(await wait(DEBOUNCE_MS, token))) return null;
    const model = await this.model();
    if (!model || token.isCancellationRequested) return null;

    const offset = document.offsetAt(position);
    const text = document.getText();
    const prefix = text.slice(Math.max(0, offset - PREFIX_CHARS), offset);
    const suffix = text.slice(offset, offset + SUFFIX_CHARS);
    const lineAfter = document.lineAt(position.line).text.slice(position.character);
    const midLine = /\S/.test(lineAfter);

    const controller = new AbortController();
    token.onCancellationRequested(() => controller.abort());
    try {
      const raw = await this._client.generate(model, {
        prompt: prefix,
        suffix,
        keepAlive: '30m',
        options: { temperature: 0.1, top_p: 0.9, num_predict: midLine ? 48 : 160, stop: ['\n\n\n'] }
      }, controller.signal);
      this._failures = 0;
      const insert = tidy(raw, suffix, midLine);
      if (!insert.trim() || token.isCancellationRequested) return null;
      return [new vscode.InlineCompletionItem(insert, new vscode.Range(position, position))];
    } catch (err) {
      if (!controller.signal.aborted) this._failures++;
      return null;
    }
  }
}

function register(context, client) {
  const provider = new CompletionProvider(context, client);
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  status.command = 'localAI.toggleAutocomplete';
  const refresh = () => {
    status.text = provider.enabled() ? '$(sparkle) AI complete' : '$(circle-slash) AI complete';
    status.tooltip = provider.enabled()
      ? `Local Full AI code completion is on (${String(config().get('autocompleteModel') || 'auto')}). Click to turn it off.`
      : 'Local Full AI code completion is off. Click to turn it on (needs a small local coder model such as qwen2.5-coder:1.5b).';
    status.show();
  };
  refresh();
  context.subscriptions.push(
    status,
    vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, provider),
    vscode.commands.registerCommand('localAI.toggleAutocomplete', async () => {
      const turnOn = !provider.enabled();
      await config().update('autocomplete', turnOn, vscode.ConfigurationTarget.Global);
      if (turnOn && !(await provider.model())) {
        vscode.window.showWarningMessage('No installed model can complete code. Install a small coder model such as qwen2.5-coder:1.5b from the sidebar.');
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('localAI.autocomplete') || e.affectsConfiguration('localAI.autocompleteModel')) {
        provider.forget();
        refresh();
      }
    })
  );
  return provider;
}

module.exports = { register, tidy };
