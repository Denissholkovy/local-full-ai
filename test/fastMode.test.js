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
  ctx.run.kind = 'edit';
  await panel._agentLoop(ctx);
  await panel._verifyAndFix(ctx);
  assert.strictEqual(seen.length, 2);
  const fixRequest = seen[1][seen[1].length - 1].content;
  assert.match(fixRequest, /#calc-input, #calc-clear[\s\S]*do nothing/);
  assert.match(fixRequest, /<edit path=/);
});

const TODO_CSS = '#add-task {\n  background: #2196f3;\n  color: #fff;\n}\n\n.completed {\n  text-decoration: line-through;\n}\n\nbody {\n  margin: 0;\n}\n';

function editSetup(answers) {
  const env = setup(answers);
  fs.writeFileSync(path.join(env.root, 'style.css'), TODO_CSS);
  env.ctx.run.kind = 'edit';
  env.ctx.run.task = 'make the add button green';
  env.ctx.userText = env.ctx.run.task;
  env.ctx.session.writtenFiles = ['index.html', 'style.css', 'script.js'];
  return env;
}

test('a correction is applied as a targeted edit and the rest of the file stays', async () => {
  const { root, panel, ctx, seen } = editSetup([
    '<edit path="style.css">\n<<<<<<< SEARCH\n#add-task {\n  background: #2196f3;\n=======\n#add-task {\n  background: #4caf50;\n>>>>>>> REPLACE\n</edit>\nThe button is green now.'
  ]);
  await panel._agentLoop(ctx);
  assert.strictEqual(seen.length, 1);
  assert.match(seen[0][0].content, /<<<<<<< SEARCH/);
  assert.strictEqual(fs.readFileSync(path.join(root, 'style.css'), 'utf8'), TODO_CSS.replace('#2196f3', '#4caf50'));
});

test('a correction that rewrites the file is refused, a failed edit gets the closest lines, then it works', async () => {
  const { root, panel, ctx, seen } = editSetup([
    '<file path="style.css">\nbutton { background: green; }\n</file>\nDone.',
    '<edit path="style.css">\n<<<<<<< SEARCH\n#add-button {\n  background: blue;\n=======\n#add-task {\n  background: green;\n>>>>>>> REPLACE\n</edit>\nDone.',
    '<edit path="style.css">\n<<<<<<< SEARCH\n   2|   background: #2196f3;\n=======\n  background: #4caf50;\n>>>>>>> REPLACE\n</edit>\nDone.'
  ]);
  await panel._agentLoop(ctx);
  assert.strictEqual(seen.length, 3);
  assert.match(seen[1][seen[1].length - 1].content, /NOT saved[\s\S]*removes or changes/);
  assert.match(seen[2][seen[2].length - 1].content, /closest part of the file[\s\S]*#add-task/);
  assert.strictEqual(fs.readFileSync(path.join(root, 'style.css'), 'utf8'), TODO_CSS.replace('#2196f3', '#4caf50'));
});

test('a question in standard mode gets an answer, never a "do the task" nudge or a forced rewrite', async () => {
  const { root, panel, ctx, seen } = setup(['script.js adds tasks to the list when you press Add.']);
  Object.assign(ctx, { filesMode: false, toolsEnabled: true, profile: 'standard' });
  ctx.run.kind = 'question';
  ctx.run.task = 'Що робить script.js? Коротко.';
  ctx.userText = ctx.run.task;
  ctx.session.writtenFiles = ['index.html', 'script.js'];
  await panel._agentLoop(ctx);
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(fs.readFileSync(path.join(root, 'script.js'), 'utf8'), SCRIPT);
  assert.ok(!ctx.history.some((m) => m.synthetic));
});

test('the same failing edit twice gets the whole file the second time', async () => {
  const { panel, ctx } = setup([]);
  const call = { function: { name: 'edit_file', arguments: { path: 'script.js', old_string: 'nothing like this', new_string: 'x' } } };
  const first = await panel._executeToolCall(call, ctx);
  const second = await panel._executeToolCall(call, ctx);
  assert.match(first.output, /closest part of the file/);
  assert.match(second.output, /WHOLE file[\s\S]*1\| document\.getElementById/);
});

test('edit_file with replace_all renames every occurrence', async () => {
  const { root, panel, ctx } = setup([]);
  const first = await panel._executeToolCall({ function: { name: 'edit_file', arguments: { path: 'script.js', old_string: "getElementById('", new_string: "getElementById('x-" } } }, ctx);
  assert.match(first.output, /replace_all/);
  const out = await panel._executeToolCall({ function: { name: 'edit_file', arguments: { path: 'script.js', old_string: "getElementById('", new_string: "getElementById('x-", replace_all: true } } }, ctx);
  assert.match(out.output, /2 places/);
  assert.strictEqual((fs.readFileSync(path.join(root, 'script.js'), 'utf8').match(/x-/g) || []).length, 2);
});

test('an edit that breaks the syntax of a working script is undone at once', async () => {
  const { root, panel, ctx } = setup([]);
  ctx.run.kind = 'edit';
  const out = await panel._executeToolCall({ function: { name: 'edit_file', arguments: { path: 'script.js', old_string: "addEventListener('click', () =>", new_string: "addEventListener('click', createTask" } } }, ctx);
  assert.strictEqual(out.ok, false);
  assert.match(out.output, /Not saved, the file is unchanged: it makes a syntax error/);
  assert.strictEqual(fs.readFileSync(path.join(root, 'script.js'), 'utf8'), SCRIPT);
});

test('a correction that takes away buttons is undone at once', async () => {
  const { root, panel, ctx } = setup([]);
  ctx.run.kind = 'edit';
  ctx.run.task = 'add a % button';
  const out = await panel._executeToolCall({ function: { name: 'edit_file', arguments: { path: 'index.html', old_string: '<button id="add-task">Add</button>', new_string: '<button>%</button>' } } }, ctx);
  assert.strictEqual(out.ok, false);
  assert.match(out.output, /removed button "Add"/);
  assert.strictEqual(fs.readFileSync(path.join(root, 'index.html'), 'utf8'), PAGE);
});
