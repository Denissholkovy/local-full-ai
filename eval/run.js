// Runs typical requests through the real chat pipeline against a live Ollama and scores the results.
// Usage: npm run eval -- --model qwen3:4b [--tasks new-calculator,edit-heading] [--timeout 420] [--label baseline]
const { vscodeStub, settings } = require('../test/vscodeStub');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ChatPanel } = require('../src/chatPanel');
const { WorkspaceTools } = require('../src/tools');
const { OllamaClient } = require('../src/ollamaClient');
const { TASKS } = require('./tasks');

vscodeStub.languages = { getDiagnostics: () => [] };
vscodeStub.window.activeTextEditor = undefined;
vscodeStub.window.showInformationMessage = () => {};
vscodeStub.window.showWarningMessage = async () => undefined;
vscodeStub.workspace.isTrusted = true;

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
}

function linesOf(text) {
  return String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

// Share of the starting code that is gone afterwards: high means the model rewrote instead of editing.
function lostLines(seed, dir) {
  let total = 0;
  let lost = 0;
  const perFile = {};
  for (const [rel, text] of Object.entries(seed)) {
    const before = linesOf(text);
    let after = [];
    try {
      after = linesOf(fs.readFileSync(path.join(dir, rel), 'utf8'));
    } catch (_) {
    }
    const pool = new Map();
    after.forEach((l) => pool.set(l, (pool.get(l) || 0) + 1));
    let gone = 0;
    before.forEach((l) => {
      const n = pool.get(l) || 0;
      if (n > 0) pool.set(l, n - 1);
      else gone++;
    });
    perFile[rel] = gone;
    total += before.length;
    lost += gone;
  }
  return { lost, total, ratio: total ? lost / total : 0, perFile };
}

function makeContext(storage) {
  const state = new Map();
  return {
    globalState: { get: (k, d) => (state.has(k) ? state.get(k) : d), update: async (k, v) => { state.set(k, v); } },
    workspaceState: { get: (k, d) => d, update: async () => {} },
    secrets: { get: async () => undefined },
    globalStorageUri: { fsPath: storage },
    extensionUri: { fsPath: path.join(__dirname, '..') }
  };
}

async function runTask(task, modelName, client, timeoutSec, outDir) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `eval-${task.id}-`)));
  Object.entries(task.seed).forEach(([rel, text]) => fs.writeFileSync(path.join(root, rel), text));
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-store-'));
  const context = makeContext(storage);
  context.globalState.update('localAI.permissionMode', 'auto');
  const tools = new WorkspaceTools(root);
  const posted = [];
  const panel = Object.create(ChatPanel.prototype);
  Object.assign(panel, {
    _context: context,
    _ollamaClient: client,
    _cloud: null,
    _runs: new Map(),
    _grantsBySession: new Map(),
    _pendingPermissions: new Map(),
    _noToolsModels: new Set(),
    _toolCounter: 0,
    _ready: true,
    _waiting: [],
    _getTools: () => tools,
    _skills: () => [],
    _pickAutoSkills: () => ({ text: '', names: [] }),
    _mcpTools: async () => null,
    _embeddingModel: async () => null,
    _sendSessionsList: () => {},
    _sendModelInfo: () => {},
    _persistSessions: () => {},
    _revealFile: () => {},
    _post: (m) => posted.push(m),
    _postFor: (s, m) => posted.push(m)
  });
  const session = { id: `eval-${task.id}`, title: task.id, history: [], updatedAt: Date.now() };
  if (task.kind === 'edit' || task.kind === 'question') session.writtenFiles = Object.keys(task.seed);
  panel._sessions = [session];
  panel._currentSessionId = session.id;
  session.history.push({ role: 'user', content: task.prompt, display: { text: task.prompt } });

  const started = Date.now();
  let timedOut = false;
  const timer = setInterval(() => {
    if ((Date.now() - started) / 1000 < timeoutSec) return;
    const run = panel._runs.get(session.id);
    if (run && !run.stopped) {
      timedOut = true;
      run.stopped = true;
      run.aborts.forEach((abort) => abort());
    }
  }, 1000);
  let crashed = null;
  try {
    await panel._streamAssistantReply(modelName, session);
  } catch (err) {
    crashed = err.stack || String(err);
  } finally {
    clearInterval(timer);
  }
  const seconds = (Date.now() - started) / 1000;
  const answer = [...session.history].reverse().find((m) => m.role === 'assistant' && m.content);
  const run = { answer: answer ? answer.content : '' };
  let checks = [];
  try {
    checks = await task.check(root, run);
  } catch (err) {
    checks = [{ name: `check crashed: ${err.message}`, ok: false }];
  }
  const loss = lostLines(task.seed, root);
  const created = fs.readdirSync(root).filter((f) => !f.startsWith('.'));
  const touchedOutside = task.allowed
    ? Object.entries(loss.perFile).filter(([rel, n]) => n > 0 && !task.allowed.includes(rel)).map(([rel]) => rel)
    : [];
  const result = {
    task: task.id,
    kind: task.kind,
    model: modelName,
    seconds: Math.round(seconds),
    timedOut,
    crashed,
    passed: checks.filter((c) => c.ok).length,
    total: checks.length,
    ok: checks.length > 0 && checks.every((c) => c.ok) && !crashed,
    lostLines: loss.lost,
    lostRatio: Number(loss.ratio.toFixed(3)),
    touchedOutside,
    files: created,
    checks,
    notices: posted.filter((m) => ['notice', 'contextTrimmed', 'error'].includes(m.type)).map((m) => m.text).filter(Boolean)
  };
  const taskDir = path.join(outDir, task.id);
  fs.mkdirSync(taskDir, { recursive: true });
  created.forEach((f) => {
    const src = path.join(root, f);
    if (fs.statSync(src).isFile()) fs.copyFileSync(src, path.join(taskDir, f));
  });
  fs.writeFileSync(path.join(taskDir, 'result.json'), JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(taskDir, 'history.json'), JSON.stringify(session.history.map((m) => ({ ...m, images: undefined })), null, 2));
  return result;
}

async function main() {
  const modelName = arg('model', 'qwen3:4b');
  const only = arg('tasks', '');
  const timeoutSec = Number(arg('timeout', '420'));
  const label = arg('label', 'run');
  settings.agentMode = arg('mode', undefined);
  const client = new OllamaClient(arg('url', 'http://127.0.0.1:11434'));
  if (!(await client.ping())) {
    console.error('Ollama is not running.');
    process.exit(1);
  }
  const tasks = TASKS.filter((t) => !only || only.split(',').includes(t.id));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir = path.join(__dirname, 'results', `${stamp}-${label}-${modelName.replace(/[^\w.-]/g, '_')}`);
  fs.mkdirSync(outDir, { recursive: true });
  const results = [];
  for (const task of tasks) {
    process.stdout.write(`${task.id} ... `);
    const r = await runTask(task, modelName, client, timeoutSec, outDir);
    results.push(r);
    console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.passed}/${r.total}  ${r.seconds}s  lost ${r.lostLines} lines (${Math.round(r.lostRatio * 100)}%)${r.touchedOutside.length ? `  touched ${r.touchedOutside.join(',')}` : ''}${r.timedOut ? '  TIMEOUT' : ''}${r.crashed ? '  CRASH' : ''}`);
    r.checks.filter((c) => !c.ok).forEach((c) => console.log(`    ✗ ${c.name}${c.detail && c.detail.length ? ` ${JSON.stringify(c.detail)}` : ''}`));
  }
  const edits = results.filter((r) => r.kind === 'edit');
  const summary = {
    model: modelName,
    label,
    passed: results.filter((r) => r.ok).length,
    tasks: results.length,
    seconds: results.reduce((n, r) => n + r.seconds, 0),
    avgLostOnEdits: edits.length ? Number((edits.reduce((n, r) => n + r.lostRatio, 0) / edits.length).toFixed(3)) : 0
  };
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify({ summary, results }, null, 2));
  console.log(`\n${summary.passed}/${summary.tasks} passed, ${summary.seconds}s total, edits lose ${Math.round(summary.avgLostOnEdits * 100)}% of the old lines on average`);
  console.log(`Details: ${outDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
