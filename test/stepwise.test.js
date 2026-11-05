const { vscodeStub } = require('./vscodeStub');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ChatPanel } = require('../src/chatPanel');
const { WorkspaceTools } = require('../src/tools');
const { parsePlan } = require('../src/chat/stepwise');

vscodeStub.languages = { getDiagnostics: () => [] };

const PLAN = `Sure, here is the plan.
**FILES:**
- \`script.js\`: logic
- index.html: page with the calculator
- style.css: looks
ELEMENTS:
- #display: shows the input and result
- #btn-7: digit 7
- #equals: computes
CHECKS:
1. pressing 7 + 8 = shows 15
`;

test('the plan is read from loose model output, pages first', () => {
  const plan = parsePlan(`<think>hmm</think>${PLAN}`);
  assert.deepStrictEqual(plan.files.map((f) => f.path), ['index.html', 'style.css', 'script.js']);
  assert.deepStrictEqual(plan.ids.map((e) => e.id), ['display', 'btn-7', 'equals']);
  assert.deepStrictEqual(plan.checks, ['pressing 7 + 8 = shows 15']);
  assert.match(plan.text, /Must work: pressing 7 \+ 8 = shows 15/);
});

function setup(answers) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'steps-')));
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
        return { content: answers.shift() || '', toolCalls: [] };
      }
    }),
    _modelOptions: (m, extra) => extra,
    _revealFile: () => {},
    _sendModelInfo: () => {},
    _persistSessions: () => {}
  });
  const session = { id: 's', history: [{ role: 'user', content: 'make a calculator' }] };
  const run = { aborts: new Set(), changes: new Map(), plan: [], task: 'make a calculator', kind: 'new', partial: '' };
  const ctx = {
    session, run, modelName: 'qwen3:4b', history: session.history, tools, skills: [], autopilot: false, mode: 'auto',
    isSub: false, filesMode: true, profile: 'direct', compact: false, userText: run.task, canDelegate: false,
    toolsEnabled: false, label: '', ui: true, maxSteps: 25, post: (m) => posted.push(m), persist: () => {}
  };
  return { root, panel, ctx, seen, posted };
}

test('a new feature is planned, then written one file at a time with the earlier files in view', async () => {
  const { root, panel, ctx, seen } = setup([
    PLAN,
    '<file path="index.html">\n<input id="display"><button id="btn-7">7</button><button id="equals">=</button>\n<script src="script.js"></script>\n</file>',
    '<file path="style.css">\n#display { width: 100%; }\n</file>',
    '<file path="script.js">\ndocument.getElementById("equals").onclick = () => {};\ndocument.getElementById("btn-7").onclick = () => {};\n</file>\nCalculator ready.'
  ]);
  assert.strictEqual(panel._stepwiseWanted(ctx), true);
  assert.strictEqual(await panel._buildInSteps(ctx), true);
  assert.strictEqual(seen.length, 4);
  assert.match(seen[3][1].content, /### index\.html[\s\S]*### style\.css/);
  assert.match(seen[3][1].content, /ONLY the file script\.js[\s\S]*display, btn-7, equals/);
  ['index.html', 'style.css', 'script.js'].forEach((f) => assert.ok(fs.existsSync(path.join(root, f)), f));
  assert.ok(ctx.history.some((m) => m.plan && /\*\*Plan\*\*/.test(m.content)));
  assert.strictEqual(ctx.history[ctx.history.length - 1].content, 'Calculator ready.');
  assert.deepStrictEqual(panel._planProblems(ctx), []);
});

test('ids from the plan that the page lacks are reported for a fix', async () => {
  const { panel, ctx } = setup([
    PLAN,
    '<file path="index.html">\n<input id="display">\n</file>',
    '<file path="style.css">\nbody {}\n</file>',
    '<file path="script.js">\nconsole.log(1);\n</file>'
  ]);
  await panel._buildInSteps(ctx);
  assert.match(panel._planProblems(ctx)[0], /#btn-7, #equals/);
});

test('a plan with fewer than two files falls back to the normal one-pass flow', async () => {
  const { panel, ctx, seen } = setup(['FILES:\n- index.html: everything\n']);
  assert.strictEqual(await panel._buildInSteps(ctx), false);
  assert.strictEqual(seen.length, 1);
});
