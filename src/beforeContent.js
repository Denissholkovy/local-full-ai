const vscode = require('vscode');

const SCHEME = 'localai-before';
const MAX_ENTRIES = 60;
const entries = new Map();

function remember(id, entry) {
  entries.set(id, entry);
  while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value);
}

function get(id) {
  return entries.get(id);
}

function register(context) {
  const provider = {
    provideTextDocumentContent(uri) {
      const id = new URLSearchParams(uri.query).get('id');
      const entry = id ? entries.get(id) : null;
      return entry ? entry.before : '';
    }
  };
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(SCHEME, provider));
}

function openDiff(id) {
  const entry = entries.get(id);
  if (!entry || entry.before === null) return false;
  const left = vscode.Uri.parse(`${SCHEME}:/${encodeURIComponent(entry.rel)}?id=${encodeURIComponent(id)}`);
  const right = vscode.Uri.file(entry.abs);
  vscode.commands.executeCommand('vscode.diff', left, right, `${entry.rel} (before ↔ after)`);
  return true;
}

module.exports = { SCHEME, remember, get, register, openDiff };
