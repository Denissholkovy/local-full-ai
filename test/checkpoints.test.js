const { vscodeStub } = require('./vscodeStub');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const changes = require('../src/chat/changes');

function setup(answer) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoints-'));
  const file = path.join(dir, 'app.js');
  fs.writeFileSync(file, 'v1');
  const session = {
    id: 's1',
    history: [
      { role: 'user', content: 'make v2', display: { text: 'make v2' } },
      { role: 'assistant', content: 'done' },
      { role: 'user', content: '[system] nudge', synthetic: true },
      { role: 'user', content: 'make v3', display: { text: 'make v3' } },
      { role: 'assistant', content: 'done' }
    ]
  };
  const posted = [];
  const panel = Object.assign(Object.create(changes), {
    _context: { globalStorageUri: { fsPath: dir } },
    _runs: new Map(),
    _currentSession: () => session,
    _persistSessions: () => {},
    _sendCurrentHistory: () => {},
    _post: (m) => posted.push(m)
  });
  fs.writeFileSync(file, 'v2');
  panel._addCheckpoint(session, 0, panel._saveUndo(session, [{ abs: file, rel: 'app.js', before: 'v1', after: 'v2' }]));
  fs.writeFileSync(file, 'v3');
  panel._addCheckpoint(session, 3, panel._saveUndo(session, [{ abs: file, rel: 'app.js', before: 'v2', after: 'v3' }]));
  vscodeStub.window.showWarningMessage = async () => answer;
  return { panel, session, file, posted };
}

test('editing the first message can restore the files of every later request', async () => {
  const { panel, session, file, posted } = setup('Undo those file changes too');
  await panel._editMessage(0);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'v1');
  assert.strictEqual(session.history.length, 0);
  assert.deepStrictEqual(session.checkpoints, []);
  assert.deepStrictEqual(posted.pop(), { type: 'seed', text: 'make v2' });
});

test('editing a later message can keep the files and only touches what came after it', async () => {
  const { panel, session, file } = setup('Keep the files as they are');
  await panel._editMessage(1);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'v3');
  assert.strictEqual(session.history.length, 3);
  assert.strictEqual(session.checkpoints.length, 1);
});

test('cancelling the question changes nothing', async () => {
  const { panel, session, file } = setup(undefined);
  await panel._editMessage(1);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'v3');
  assert.strictEqual(session.history.length, 5);
  assert.strictEqual(session.checkpoints.length, 2);
});
