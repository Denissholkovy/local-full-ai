const { vscodeStub } = require('./vscodeStub');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ChatPanel } = require('../src/chatPanel');
const { WorkspaceTools } = require('../src/tools');

vscodeStub.languages = { getDiagnostics: () => [] };
vscodeStub.window.activeTextEditor = undefined;

const PAGE = '<!DOCTYPE html>\n<html>\n<body>\n<header><h1>Todo</h1></header>\n<input id="new-task">\n<button id="add-task">Add</button>\n<footer>f</footer>\n<script src="script.js"></script>\n</body>\n</html>\n';
const SCRIPT = "document.getElementById('add-task').addEventListener('click', () => document.getElementById('new-task').value = '');\n";

function setup(answers) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fast-')));
  fs.writeFileSync(path.join(root, 'index.html'), PAGE);
  fs.writeFileSync(path.join(root, 'script.js'), SCRIPT);
  const tools = new WorkspaceTools(root);
  const seen = [];
  const posted = [];
  const panel = Object.create(ChatPanel.prototype);
  Object.assign(panel, {
    _context: { globalState: { get: (k, d) => d, update: async () => {} }, globalStorageUri: { fsPath: root } },
    _toolCounter: 0,
    _grantsBySession: new Map(),
    _noToolsModels: new Set(),
    _clientFor: () => ({
      chatStream: async (model, messages) => {
        seen.push(messages);
        return { content: answers.shift() || 'Done.', toolCalls: [] };
      }
    }),
    _modelOptions: (m, extra) => extra,
    _revealFile: () => {},
    _sendModelInfo: () => {},
    _persistSessions: () => {}
  });
  const session = { id: 's', history: [{ role: 'user', content: 'add a calculator under the footer' }] };
  const run = { aborts: new Set(), changes: new Map(), plan: [], task: 'add a calculator under the footer', partial: '' };
  const ctx = {
    session, run, modelName: 'qwen3:4b', history: session.history, tools, skills: [], autopilot: false, mode: 'auto',
    isSub: false, filesMode: true, profile: 'direct', compact: false, userText: run.task, canDelegate: false,
    toolsEnabled: false, label: '', ui: true, maxSteps: 25, post: (m) => posted.push(m), persist: () => {}
  };
  return { root, panel, ctx, seen, posted };
}

const goodPage = PAGE.replace('<footer>f</footer>', '<footer>f</footer>\n<div class="calc"><input id="calc-display"><button id="calc-eq">=</button></div>');
const goodScript = `${SCRIPT}document.getElementById('calc-eq').addEventListener('click', () => { const d = document.getElementById('calc-display'); d.value = String(Function('return ' + d.value)()); });\n`;

test('fast mode shows the page together with its script, so the model can write the logic', async () => {
  const { panel, ctx, seen } = setup([`<file path="index.html">\n${goodPage}</file>\n<file path="script.js">\n${goodScript}</file>\nAdded a calculator.`]);
  await panel._agentLoop(ctx);
  const system = seen[0][0].content;
  assert.match(system, /### index\.html/);
  assert.match(system, /### script\.js/);
  assert.strictEqual(ctx.run.changes.size, 2);
});

test('fast mode: a page written twice is rejected and asked for again', async () => {
  const doubled = goodPage.replace('</body>', goodPage.split('<body>')[1].split('</body>')[0] + '</body>');
  const { root, panel, ctx, seen } = setup([
    `<file path="index.html">\n${doubled}</file>\nDone.`,
    `<file path="index.html">\n${goodPage}</file>\n<file path="script.js">\n${goodScript}</file>\nDone.`
  ]);
  await panel._agentLoop(ctx);
  assert.strictEqual(seen.length, 2);
  assert.match(seen[1][seen[1].length - 1].content, /NOT saved[\s\S]*repeats a block/);
  assert.strictEqual(fs.readFileSync(path.join(root, 'index.html'), 'utf8').split('<header>').length, 2);
});

test('fast mode: buttons without logic go back to the model with a concrete fix request', async () => {
  const deadPage = PAGE.replace('<footer>f</footer>', '<footer>f</footer>\n<input id="calc-input"><button id="calc-clear">C</button>');
  const { panel, ctx, seen } = setup([
    `<file path="index.html">\n${deadPage}</file>\nDone.`,
    `<file path="index.html">\n${goodPage}</file>\n<file path="script.js">\n${goodScript}</file>\nFixed.`
  ]);
  await panel._agentLoop(ctx);
  await panel._verifyAndFix(ctx);
  assert.strictEqual(seen.length, 2);
  const fixRequest = seen[1][seen[1].length - 1].content;
  assert.match(fixRequest, /#calc-input, #calc-clear[\s\S]*do nothing/);
  assert.match(fixRequest, /<file path=/);
});
