const { settings } = require('./vscodeStub');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const agentTools = require('../src/agentTools');
const verify = require('../src/chat/verify');
const subagents = require('../src/chat/subagents');
const { ChatPanel } = require('../src/chatPanel');

test('only an explicit request for helpers counts', () => {
  for (const t of ['використай агентів для дослідження', 'запусти помічників', 'делегуй задачу', 'use 3 helper agents', 'спроси субагента']) {
    assert.strictEqual(agentTools.mentionsAgents(t), true, t);
  }
  for (const t of ['зроби це паралельно', 'run the requests in parallel', 'set the User-Agent header', 'агентство нерухомості', 'the agent loop is slow']) {
    assert.strictEqual(agentTools.mentionsAgents(t), false, t);
  }
});

test('a helper needs a real brief, and the brief tells it where to start', () => {
  assert.match(agentTools.briefProblem({ title: 'x', goal: 'look' }), /too thin/);
  assert.match(agentTools.briefProblem({ title: 'x', goal: 'Find where payments are validated and why it fails' }), /deliverable/);
  assert.strictEqual(agentTools.briefProblem({ title: 'x', goal: 'Find where payments are validated and why it fails', deliverable: 'file:line list' }), null);
  assert.strictEqual(agentTools.briefProblem({ title: 'x', task: 'The user asked: fix the login page. Check that it works.' }), null);
  const brief = agentTools.formatBrief({ goal: 'Find where payments are validated', files: ['src/pay.js', 'src/api'], known: 'not in the UI', deliverable: 'file:line list' });
  assert.match(brief, /Start with these files: src\/pay\.js, src\/api/);
  assert.match(brief, /Already known \(do not repeat it\): not in the UI/);
  assert.match(brief, /Your report must contain: file:line list/);
});

function fakeTools(count) {
  return { countSourceFiles: () => count };
}

test('helpers are offered only when asked for, or for tasks in a large project', () => {
  const panel = Object.create(ChatPanel.prototype);
  assert.strictEqual(panel._shouldOfferHelpers('qwen3:14b', fakeTools(10), 'fix the button colour', false), false);
  assert.strictEqual(panel._shouldOfferHelpers('qwen3:14b', fakeTools(10), 'use helper agents to review the code', false), true);
  assert.strictEqual(panel._shouldOfferHelpers('qwen3:14b', fakeTools(200), 'add a dark mode to the app', false), true);
  assert.strictEqual(panel._shouldOfferHelpers('qwen3:14b', fakeTools(200), 'hello, how are you', false), false);
  assert.strictEqual(panel._shouldOfferHelpers('qwen3:14b', fakeTools(200), 'anything', true), true);
  assert.strictEqual(panel._shouldOfferHelpers('qwen3:4b', fakeTools(200), 'use helper agents', false), false);
});

test('the reviewer agent only runs for bigger changes unless set to always', () => {
  const panel = Object.create(verify);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-'));
  const change = (name, before, after) => [path.join(dir, name), { abs: path.join(dir, name), rel: name, before, after }];
  const small = { modelName: 'qwen3:14b', run: { changes: new Map([change('a.js', 'x\ny', 'x\nz')]) } };
  const many = { modelName: 'qwen3:14b', run: { changes: new Map([change('a.js', 'a', 'b'), change('b.js', null, 'c'), change('c.js', 'd', 'e')]) } };
  const long = { modelName: 'qwen3:14b', run: { changes: new Map([change('a.js', null, 'line\n'.repeat(100))]) } };
  settings.verifyChanges = 'auto';
  assert.deepStrictEqual(panel._changeSize(small), { files: 1, lines: 2 });
  assert.strictEqual(panel._verifyMode(small), 'quick');
  assert.strictEqual(panel._verifyMode(many), 'full');
  assert.strictEqual(panel._verifyMode(long), 'full');
  assert.strictEqual(panel._verifyMode({ ...small, autopilot: true }), 'full');
  settings.verifyChanges = 'always';
  assert.strictEqual(panel._verifyMode(small), 'full');
  settings.verifyChanges = undefined;
});

test('one request can start only a few helpers', async () => {
  const panel = Object.create(subagents);
  const ctx = { isSub: false, autopilot: false, mode: 'ask', run: { helpers: 3 } };
  await assert.rejects(panel._runSubAgent({ title: 't', goal: 'Find where the payments are validated please', deliverable: 'list' }, ctx, 'c1'), /No more helper agents/);
  await assert.rejects(panel._runSubAgent({ title: 't', goal: 'short' }, { ...ctx, run: {} }, 'c2'), /too thin/);
});
