const vscode = require('vscode');

const KEY = 'localAI.selectedModel';
const emitter = new vscode.EventEmitter();

async function setSelectedModel(context, name) {
  const previous = context.globalState.get(KEY) || null;
  const current = name || null;
  await context.globalState.update(KEY, name || undefined);
  if (previous !== current) emitter.fire({ previous, current });
}

module.exports = { setSelectedModel, onDidChange: emitter.event };
