const vscode = require('vscode');
const cloud = require('./cloudProviders');
const consent = require('./consent');
const generationLib = require('./generation');
const { CloudClient } = require('./cloudClient');

const MAX_DIFF_CHARS = 12000;
const MAX_CODE_CHARS = 6000;

async function ask(context, ollamaClient, messages, maxTokens = 400) {
  const modelName = context.globalState.get('localAI.selectedModel');
  if (!modelName) throw new Error('Pick a model in the Local Full AI sidebar first.');
  if (!(await consent.ensure(context, modelName))) throw new Error('The cloud model was not used.');
  const client = cloud.isCloudModel(modelName) ? new CloudClient(context) : ollamaClient;
  const options = { maxTokens, generation: generationLib.options() };
  if (!cloud.isCloudModel(modelName)) options.keepAlive = context.globalState.get('localAI.keepAlive') || '30m';
  const result = await client.chatStream(modelName, messages, null, options);
  return String(result.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

function gitRepository(arg) {
  const extension = vscode.extensions.getExtension('vscode.git');
  if (!extension || !extension.isActive) return null;
  const api = extension.exports.getAPI(1);
  if (arg && arg.rootUri) return api.repositories.find((r) => r.rootUri.toString() === arg.rootUri.toString()) || null;
  return api.repositories[0] || null;
}

// Writes a commit message for the staged changes (or all changes when nothing is staged) into the Source Control box.
async function commitMessage(context, ollamaClient, arg) {
  const repo = gitRepository(arg);
  if (!repo) {
    vscode.window.showWarningMessage('No git repository is open.');
    return;
  }
  let diff = await repo.diff(true);
  if (!diff.trim()) diff = await repo.diff(false);
  if (!diff.trim()) {
    vscode.window.showInformationMessage('There are no changes to describe.');
    return;
  }
  try {
    const text = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.SourceControl, title: 'Writing the commit message...' },
      () => ask(context, ollamaClient, [
        { role: 'system', content: 'You write git commit messages. Reply with the message only: a short summary line in the imperative mood (at most 72 characters), then, only if it helps, an empty line and a few short bullet points. No code fences, no quotes.' },
        { role: 'user', content: `Write the commit message for this diff:\n\n${diff.slice(0, MAX_DIFF_CHARS)}` }
      ])
    );
    repo.inputBox.value = text.replace(/^```\w*\n?|```$/g, '').trim();
  } catch (err) {
    vscode.window.showErrorMessage(`Commit message: ${err.message}`);
  }
}

// Sends the text selected in the terminal (usually an error) to the chat and asks for a fix.
async function fixTerminalError(openChat) {
  const previous = await vscode.env.clipboard.readText();
  await vscode.commands.executeCommand('workbench.action.terminal.copySelection');
  const selected = (await vscode.env.clipboard.readText()).trim();
  await vscode.env.clipboard.writeText(previous);
  if (!selected || selected === previous.trim()) {
    vscode.window.showInformationMessage('Select the error text in the terminal first, then run this again.');
    return;
  }
  openChat().sendMessage(`This command failed in the terminal. Find the cause in the project and fix it:\n\n\`\`\`\n${selected.slice(-4000)}\n\`\`\``);
}

// The light bulb next to an error offers to let the AI fix or explain it.
class FixProvider {
  provideCodeActions(document, range, context) {
    const diagnostics = context.diagnostics.filter((d) => d.severity <= vscode.DiagnosticSeverity.Warning);
    if (!diagnostics.length) return [];
    const make = (title, mode) => {
      const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
      action.command = { command: 'localAI.fixWithAI', title, arguments: [document.uri, range, diagnostics.map((d) => d.message), mode] };
      action.diagnostics = diagnostics;
      return action;
    };
    return [make('Fix with Local Full AI', 'fix'), make('Explain with Local Full AI', 'explain')];
  }
}

function fixWithAI(openChat, uri, range, messages, mode) {
  const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  const rel = vscode.workspace.asRelativePath(uri);
  const line = range.start.line + 1;
  const around = doc
    ? doc.getText(new vscode.Range(Math.max(0, range.start.line - 15), 0, Math.min(doc.lineCount - 1, range.end.line + 15), 0)).slice(0, MAX_CODE_CHARS)
    : '';
  const problem = messages.map((m) => `- ${m}`).join('\n');
  const text = mode === 'fix'
    ? `Fix this problem in ${rel} at line ${line}:\n${problem}\n\nMake the smallest correct change in the file.`
    : `Explain this problem in ${rel} at line ${line} and how to fix it (do not change files):\n${problem}\n\n\`\`\`\n${around}\n\`\`\``;
  openChat().sendMessage(text);
}

function register(context, ollamaClient, openChat) {
  context.subscriptions.push(
    vscode.commands.registerCommand('localAI.generateCommitMessage', (arg) => commitMessage(context, ollamaClient, arg)),
    vscode.commands.registerCommand('localAI.fixTerminalError', () => fixTerminalError(openChat)),
    vscode.commands.registerCommand('localAI.fixWithAI', (uri, range, messages, mode) => fixWithAI(openChat, uri, range, messages || [], mode)),
    vscode.languages.registerCodeActionsProvider({ scheme: 'file' }, new FixProvider(), { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] })
  );
}

module.exports = { register, FixProvider };
