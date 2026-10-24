const vscode = require('vscode');
const { OllamaClient } = require('./ollamaClient');
const { pickAndInstallModel } = require('./modelPicker');
const { ChatPanel } = require('./chatPanel');
const { SidebarProvider } = require('./sidebarProvider');
const ollamaProcess = require('./ollamaProcess');
const voice = require('./voice');
const beforeContent = require('./beforeContent');
const diagnostics = require('./diagnostics');

let activeClient = null;

function activate(context) {
  const config = vscode.workspace.getConfiguration('localAI');
  const ollamaClient = new OllamaClient(config.get('ollamaBaseUrl'));
  activeClient = ollamaClient;

  context.subscriptions.push(
    vscode.commands.registerCommand('localAI.selectModel', () => {
      return pickAndInstallModel(ollamaClient, context);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('localAI.openChat', () => {
      ChatPanel.createOrShow(context, ollamaClient);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('localAI.askAboutSelection', () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) {
        vscode.window.showInformationMessage('Select some code in the editor first.');
        return;
      }
      const selectedText = editor.document.getText(editor.selection);
      const panel = ChatPanel.createOrShow(context, ollamaClient);
      panel.seedMessage(
        `Explain this code:\n\n\`\`\`\n${selectedText}\n\`\`\``
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('localAI.generateImage', () => require('./imageCommand').run(context))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('localAI.copyDiagnostics', async () => {
      const text = await diagnostics.build(context, ollamaClient);
      await vscode.env.clipboard.writeText(text);
      vscode.window.showInformationMessage('Diagnostics copied. Paste it into your bug report: it has no keys, chats or file contents.');
    })
  );

  try {
    require('./skills').setPersistence(context.globalStorageUri.fsPath);
  } catch (_) {
  }
  beforeContent.register(context);
  require('./inlineCompletion').register(context, ollamaClient);
  require('./chatParticipant').register(context, ollamaClient);
  require('./quickActions').register(context, ollamaClient, () => ChatPanel.createOrShow(context, ollamaClient));

  const sidebarProvider = new SidebarProvider(context, ollamaClient);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('localAI.sidebar', sidebarProvider)
  );

  require('./catalog').refresh(context).then((changed) => {
    if (changed && sidebarProvider._refreshState) sidebarProvider._refreshState().catch(() => {});
  });

  console.log('Local Full AI activated.');
}

async function deactivate() {
  if (ChatPanel.currentPanel) ChatPanel.currentPanel.dispose();
  require('./chatStore').flush();
  require('./mcpConfig').manager.stopAll();
  voice.cancelAll();
  const stoppedOwnServer = ollamaProcess.stopServer();
  const unload = vscode.workspace.getConfiguration('localAI').get('unloadModelsOnClose') !== false;
  if (!stoppedOwnServer && unload && activeClient) {
    await Promise.race([activeClient.unloadAllModels(), new Promise((resolve) => setTimeout(resolve, 3000))]);
  }
}

module.exports = { activate, deactivate };
