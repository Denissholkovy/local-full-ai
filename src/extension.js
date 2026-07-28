const vscode = require('vscode');
const { OllamaClient } = require('./ollamaClient');
const { pickAndInstallModel } = require('./modelPicker');
const { ChatPanel } = require('./chatPanel');
const { SidebarProvider } = require('./sidebarProvider');

function activate(context) {
  const config = vscode.workspace.getConfiguration('localAI');
  const ollamaClient = new OllamaClient(config.get('ollamaBaseUrl'));

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

  const sidebarProvider = new SidebarProvider(context, ollamaClient);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('localAI.sidebar', sidebarProvider)
  );

  console.log('Local Full AI activated. Runs fully locally through Ollama.');
}

function deactivate() {}

module.exports = { activate, deactivate };
