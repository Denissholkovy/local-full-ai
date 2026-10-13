const os = require('os');
const vscode = require('vscode');

const MAX_EVENTS = 40;
const events = [];

// Keys, tokens and the home folder never go into a report.
function scrub(text) {
  return String(text || '')
    .replace(os.homedir(), '~')
    .replace(/(?:Bearer\s+)?[A-Za-z0-9_\-]{28,}/g, '<redacted>')
    .replace(/https?:\/\/[^\s"')]*[?&](?:key|api_key|token)=[^\s"')&]*/gi, '<url with key removed>')
    .slice(0, 400);
}

function record(kind, text) {
  events.push({ at: new Date().toISOString(), kind, text: scrub(text) });
  while (events.length > MAX_EVENTS) events.shift();
}

async function build(context, ollamaClient) {
  const config = vscode.workspace.getConfiguration('localAI');
  const pkg = (context.extension && context.extension.packageJSON) || {};
  const settings = {};
  const declared = ((pkg.contributes || {}).configuration || {}).properties || {};
  Object.keys(declared).forEach((key) => {
    const short = key.replace(/^localAI\./, '');
    const value = config.get(short);
    if (value === undefined || value === '' || (Array.isArray(value) && !value.length)) return;
    settings[short] = typeof value === 'string' ? scrub(value) : value;
  });

  let ollama = 'not reachable';
  try {
    if (ollamaClient && (await ollamaClient.ping())) ollama = 'running';
  } catch (_) {
  }

  const connected = [];
  for (const id of ['groq', 'openrouter', 'gemini', 'mistral', 'cerebras', 'custom']) {
    try {
      if (await context.secrets.get(`localAI.key.${id}`)) connected.push(id);
    } catch (_) {
    }
  }
  const selected = context.globalState.get('localAI.selectedModel') || 'none';
  const cloudModels = context.globalState.get('localAI.cloudModels', []).map((m) => m.name);

  return [
    '# Local Full AI diagnostics',
    '(No keys, prompts, chat texts or file contents are included.)',
    '',
    `Extension: ${pkg.version || '?'}`,
    `VS Code: ${vscode.version}`,
    `OS: ${process.platform} ${os.release()} ${process.arch}`,
    `Workspace trusted: ${vscode.workspace.isTrusted}`,
    `Ollama: ${ollama}`,
    `Selected model: ${selected}`,
    `Cloud providers with a key: ${connected.join(', ') || 'none'}`,
    `Cloud models added: ${cloudModels.join(', ') || 'none'}`,
    `Permission mode: ${context.globalState.get('localAI.permissionMode', 'ask')}`,
    '',
    '## Settings changed from default',
    JSON.stringify(settings, null, 2),
    '',
    '## Recent problems (newest last)',
    events.length ? events.map((e) => `${e.at} [${e.kind}] ${e.text}`).join('\n') : '(none recorded in this session)'
  ].join('\n');
}

module.exports = { record, build, scrub };
