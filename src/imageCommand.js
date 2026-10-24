const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const imageGen = require('./imageGen');
const consent = require('./consent');
const workspaceLib = require('./workspace');
const { CloudClient } = require('./cloudClient');

function slug(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'picture';
}

function freeName(dir, base, ext) {
  let name = `${base}${ext}`;
  for (let n = 2; fs.existsSync(path.join(dir, name)); n++) name = `${base}-${n}${ext}`;
  return name;
}

// "Local Full AI: Generate Image": describe a picture, it is saved under images/ in the project and opened.
async function run(context) {
  const config = context.globalState.get('localAI.imageGen', null);
  if (!imageGen.isConfigured(config)) {
    const choice = await vscode.window.showInformationMessage('Picture generation is not set up yet. Choose where pictures are made in the Local Full AI sidebar under Settings > Image generation.', 'Open the sidebar');
    if (choice) vscode.commands.executeCommand('workbench.view.extension.localAI');
    return;
  }
  const root = workspaceLib.resolveWorkingRoot();
  if (!root || !workspaceLib.isTrusted()) {
    vscode.window.showWarningMessage('Open a trusted project folder first: the picture is saved into it.');
    return;
  }
  const prompt = await vscode.window.showInputBox({ prompt: 'Describe the picture (English works best)', placeHolder: 'A calm mountain lake at sunrise, soft light, flat illustration', ignoreFocusOut: true });
  if (!prompt) return;
  const shape = await vscode.window.showQuickPick(
    [
      { label: 'Square', description: '1024 x 1024', width: 1024, height: 1024 },
      { label: 'Wide', description: '1536 x 1024, for banners and backgrounds', width: 1536, height: 1024 },
      { label: 'Tall', description: '1024 x 1536, for posters and phone screens', width: 1024, height: 1536 }
    ],
    { title: 'Picture shape' }
  );
  if (!shape) return;
  const sendsOut = imageGen.consentName(config);
  if (sendsOut && !(await consent.ensure(context, sendsOut))) return;

  const cloudClient = new CloudClient(context);
  try {
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Making the picture with ${imageGen.describe(config)}...`, cancellable: true },
      (progress, token) => {
        const controller = new AbortController();
        token.onCancellationRequested(() => controller.abort());
        return imageGen.generate(config, { prompt, width: shape.width, height: shape.height }, {
          signal: controller.signal,
          secrets: (c) => cloudClient.credentials(c.kind === 'huggingface' ? 'huggingface' : c.providerId)
        });
      }
    );
    const dir = path.join(root, 'images');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, freeName(dir, slug(prompt), imageGen.fixExtension('x.png', result.mime).slice(1)));
    fs.writeFileSync(file, result.buffer);
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(file));
    vscode.window.showInformationMessage(`Saved ${path.relative(root, file)}.`);
  } catch (err) {
    vscode.window.showErrorMessage(`Picture generation failed: ${err.message}`);
  }
}

module.exports = { run };
