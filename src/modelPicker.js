const vscode = require('vscode');
const modelState = require('./modelState');
const MODEL_CATALOG = require('./models.json');

const RECOMMENDED_MODELS = MODEL_CATALOG;

async function pickAndInstallModel(ollamaClient, context) {
  const isRunning = await ollamaClient.ping();
  if (!isRunning) {
    const choice = await vscode.window.showErrorMessage(
      "Could not connect to Ollama on localhost. Make sure Ollama is installed and running.",
      'How do I install it?'
    );
    if (choice === 'How do I install it?') {
      vscode.env.openExternal(vscode.Uri.parse('https://ollama.com/download'));
    }
    return;
  }

  let localModels = [];
  try {
    localModels = await ollamaClient.listLocalModels();
  } catch (err) {
    vscode.window.showWarningMessage(`Could not fetch the list of local models: ${err.message}`);
  }

  const localNames = new Set(localModels.map((m) => m.name));

  const Separator = vscode.QuickPickItemKind.Separator;
  const selected = context.globalState.get('localAI.selectedModel');
  const describe = (m) =>
    [m.recommended ? '\u2605' : '', `${m.sizeGB} GB`, (m.tags || []).join(', '), m.description]
      .filter(Boolean)
      .join(' · ');

  const items = [];
  if (localModels.length > 0) {
    items.push({ label: 'Installed', kind: Separator });
    localModels.forEach((m) => {
      items.push({
        label: `$(check) ${m.name}`,
        description: m.name === selected ? 'active' : 'ready to use',
        modelName: m.name,
        alreadyInstalled: true
      });
    });
  }

  const categories = [
    ['code', 'Code'],
    ['general', 'General'],
    ['vision', 'Vision']
  ];
  categories.forEach(([id, title]) => {
    const available = RECOMMENDED_MODELS.filter((m) => m.category === id && !localNames.has(m.name));
    if (available.length === 0) return;
    items.push({ label: title, kind: Separator });
    available.forEach((m) => {
      items.push({
        label: m.label,
        description: describe(m),
        modelName: m.name,
        alreadyInstalled: false
      });
    });
  });

  items.push({ label: 'Other', kind: Separator });
  items.push({
    label: '$(edit) Enter a model name manually...',
    description: 'any model from ollama.com/library',
    modelName: null,
    alreadyInstalled: false
  });

  const picked = await vscode.window.showQuickPick(items, {
    title: 'Local Full AI: pick a model',
    placeHolder: 'Choose from the list or type your own model name'
  });

  if (!picked) return;

  let modelName = picked.modelName;
  if (modelName === null) {
    modelName = await vscode.window.showInputBox({
      prompt: 'Model name (e.g. llama3.1:8b)',
      placeHolder: 'model:tag'
    });
    if (!modelName) return;
  }

  if (picked.alreadyInstalled) {
    await modelState.setSelectedModel(context, modelName);
    vscode.window.showInformationMessage(`Selected model: ${modelName}`);
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Downloading model ${modelName}`,
      cancellable: true
    },
    async (progress, token) => {
      let lastPercent = 0;
      try {
        let abort = null;
        token.onCancellationRequested(() => {
          if (abort) abort();
        });
        await ollamaClient.pullModel(modelName, (evt) => {
          if (evt.total && evt.completed) {
            const percent = Math.round((evt.completed / evt.total) * 100);
            const delta = percent - lastPercent;
            if (delta > 0) {
              progress.report({
                increment: delta,
                message: `${evt.status || ''} ${percent}%`
              });
              lastPercent = percent;
            }
          } else if (evt.status) {
            progress.report({ message: evt.status });
          }
        }, { onAbortReady: (fn) => { abort = fn; } });
        await modelState.setSelectedModel(context, modelName);
        vscode.window.showInformationMessage(
          `Model ${modelName} downloaded and ready to use offline.`
        );
      } catch (err) {
        if (err.cancelled) {
          vscode.window.showInformationMessage(`Download of ${modelName} cancelled. Installing it again resumes where it stopped.`);
          return;
        }
        vscode.window.showErrorMessage(`Failed to download model: ${err.message}`);
      }
    }
  );
}

module.exports = { pickAndInstallModel, RECOMMENDED_MODELS };
