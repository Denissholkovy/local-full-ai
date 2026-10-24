const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../src/chatStore');

function context(legacy) {
  const state = { 'localAI.chatSessions': legacy };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-full-ai-'));
  return { state, dir, globalStorageUri: { fsPath: dir }, globalState: { get: (k) => state[k], update: (k, v) => { state[k] = v; } } };
}

test('old chats move from globalState into files, in creation order', () => {
  const ctx = context([
    { id: 'm1a2b3c4aaaaa', title: 'first', history: [] },
    { id: 'm1a2b3c5bbbbb', title: 'second', history: [{ role: 'user', content: 'hi' }] }
  ]);
  const sessions = store.load(ctx);
  assert.deepStrictEqual(sessions.map((s) => s.title), ['first', 'second']);
  assert.strictEqual(ctx.state['localAI.chatSessions'], undefined);
  assert.strictEqual(fs.readdirSync(path.join(ctx.dir, 'chats')).length, 2);
});

test('save, flush and remove change what loads next time', () => {
  const ctx = context(undefined);
  store.load(ctx);
  store.save({ id: 'm1a2b3c6ccccc', title: 'kept', history: [] });
  store.save({ id: 'm1a2b3c7ddddd', title: 'deleted', history: [] });
  store.flush();
  store.remove('m1a2b3c7ddddd');
  assert.deepStrictEqual(store.load(ctx).map((s) => s.title), ['kept']);
});

test('ids that could escape the folder are ignored', () => {
  const ctx = context(undefined);
  store.load(ctx);
  store.save({ id: '../evil', title: 'x', history: [] });
  store.flush();
  assert.strictEqual(fs.existsSync(path.join(ctx.dir, 'evil.json')), false);
});
