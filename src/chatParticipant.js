const vscode = require('vscode');
const fs = require('fs');
const cloud = require('./cloudProviders');
const consent = require('./consent');
const generationLib = require('./generation');
const capabilities = require('./modelCapabilities');
const { CloudClient } = require('./cloudClient');

// "@local" in VS Code's own chat view: quick questions with the model picked in the sidebar.
// Work on the project (edits, commands, agents) stays in the Local Full AI chat, offered as a button.
const MAX_REFERENCE_CHARS = 12000;
const SYSTEM = 'You are a coding assistant inside VS Code. Answer clearly and briefly in the language of the user. Use Markdown with fenced code blocks.';

function referenceText(ref) {
  const value = ref.value;
  try {
    if (value instanceof vscode.Uri) {
      return `File ${vscode.workspace.asRelativePath(value)}:\n${fs.readFileSync(value.fsPath, 'utf8').slice(0, MAX_REFERENCE_CHARS)}`;
    }
    if (value instanceof vscode.Location) {
      const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === value.uri.toString());
      const text = doc ? doc.getText(value.range) : fs.readFileSync(value.uri.fsPath, 'utf8');
      return `From ${vscode.workspace.asRelativePath(value.uri)}:\n${text.slice(0, MAX_REFERENCE_CHARS)}`;
    }
    if (typeof value === 'string') return value.slice(0, MAX_REFERENCE_CHARS);
  } catch (_) {
  }
  return '';
}

function historyMessages(chatContext) {
  const messages = [];
  for (const turn of chatContext.history || []) {
    if (turn instanceof vscode.ChatRequestTurn) {
      messages.push({ role: 'user', content: turn.prompt });
    } else if (turn instanceof vscode.ChatResponseTurn) {
      const text = turn.response
        .map((part) => (part instanceof vscode.ChatResponseMarkdownPart ? part.value.value : ''))
        .join('');
      if (text) messages.push({ role: 'assistant', content: text });
    }
  }
  return messages.slice(-12);
}

function register(context, ollamaClient) {
  if (!vscode.chat || typeof vscode.chat.createChatParticipant !== 'function') return;
  const cloudClient = new CloudClient(context);

  const handler = async (request, chatContext, stream, token) => {
    const modelName = context.globalState.get('localAI.selectedModel');
    if (!modelName) {
      stream.markdown('Pick a model in the **Local Full AI** sidebar first.');
      stream.button({ command: 'workbench.view.extension.localAI', title: 'Open the sidebar' });
      return {};
    }
    if (!(await consent.ensure(context, modelName))) {
      stream.markdown('The cloud model was not used. Pick a local model in the sidebar, or accept the notice.');
      return {};
    }
    const extra = (request.references || []).map(referenceText).filter(Boolean);
    const editor = vscode.window.activeTextEditor;
    if (!extra.length && editor && !editor.selection.isEmpty) {
      extra.push(`Selected code in ${vscode.workspace.asRelativePath(editor.document.uri)}:\n${editor.document.getText(editor.selection).slice(0, MAX_REFERENCE_CHARS)}`);
    }
    const messages = [
      { role: 'system', content: SYSTEM },
      ...historyMessages(chatContext),
      { role: 'user', content: [...extra, request.prompt].join('\n\n') }
    ];

    const isCloud = cloud.isCloudModel(modelName);
    const client = isCloud ? cloudClient : ollamaClient;
    const options = { generation: generationLib.options() };
    if (isCloud) options.maxTokens = 4096;
    else {
      const configured = Number(vscode.workspace.getConfiguration('localAI').get('contextSize')) || 16384;
      const max = capabilities.localContextLength(modelName);
      options.numCtx = max >= 2048 ? Math.min(configured, max) : configured;
      options.keepAlive = context.globalState.get('localAI.keepAlive') || '30m';
    }
    options.onAbortReady = (abort) => token.onCancellationRequested(abort);
    options.onNotice = (text) => stream.progress(text);

    stream.progress(`Asking ${modelName}...`);
    try {
      await client.chatStream(modelName, messages, (piece) => stream.markdown(piece), options);
    } catch (err) {
      stream.markdown(`\n\n**Error:** ${err.message}`);
    }
    stream.button({ command: 'localAI.openChat', title: 'Continue in Local Full AI (can edit your project)' });
    return {};
  };

  const participant = vscode.chat.createChatParticipant('localAI.chat', handler);
  participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.png');
  context.subscriptions.push(participant);
}

module.exports = { register };
