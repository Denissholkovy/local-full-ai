const vscode = require('vscode');
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

  const items = [
    ...localModels.map((m) => ({
      label: `$(check) ${m.name}`,
      description: 'already installed locally',
      modelName: m.name,
      alreadyInstalled: true
    })),
    ...RECOMMENDED_MODELS.filter((m) => !localNames.has(m.name)).map((m) => ({
      label: m.label,
      description: m.description,
      modelName: m.name,
      alreadyInstalled: false
    })),
    {
      label: '$(edit) Enter a model name manually...',
      description: 'any model from ollama.com/library',
      modelName: null,
      alreadyInstalled: false
    }
  ];

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
    await context.globalState.update('localAI.selectedModel', modelName);
    vscode.window.showInformationMessage(`Selected model: ${modelName}`);
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Downloading model ${modelName}`,
      cancellable: false
    },
    async (progress) => {
      let lastPercent = 0;
      try {
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
        });
        await context.globalState.update('localAI.selectedModel', modelName);
        vscode.window.showInformationMessage(
          `Model ${modelName} downloaded and ready to use offline.`
        );
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to download model: ${err.message}`);
      }
    }
  );
}

module.exports = { pickAndInstallModel, RECOMMENDED_MODELS };
