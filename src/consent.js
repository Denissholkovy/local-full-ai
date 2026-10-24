const vscode = require('vscode');
const cloud = require('./cloudProviders');

const OLLAMA_CLOUD = {
  id: 'ollama',
  name: 'Ollama Cloud',
  dataNote: 'Ollama says prompts and answers are not logged or used for training. The free plan has a monthly usage allowance and runs one request at a time.'
};

// Who gets the prompts when this model is used, or null when they stay on this computer.
function destination(modelName) {
  if (cloud.isOllamaCloud(modelName)) return OLLAMA_CLOUD;
  const parsed = cloud.parseName(modelName);
  if (!parsed) return null;
  const def = cloud.provider(parsed.providerId);
  if (!def || def.local) return null;
  return { id: parsed.providerId, name: def.name, dataNote: def.dataNote };
}

// Asks once per provider before anything is sent to it. Returns false when the user declined.
async function ensure(context, modelName) {
  const dest = destination(modelName);
  if (!dest) return true;
  const key = `localAI.cloudConsent.${dest.id}`;
  if (context.globalState.get(key)) return true;
  const choice = await vscode.window.showWarningMessage(
    `You are about to use a cloud model (${dest.name}). Your messages, and the files the AI reads from your project, will be sent to ${dest.name}'s servers. ${dest.dataNote} Do not use it with code or data you must keep private.`,
    { modal: true },
    'I understand, use the cloud model'
  );
  if (!choice) return false;
  await context.globalState.update(key, true);
  return true;
}

module.exports = { ensure, destination };
