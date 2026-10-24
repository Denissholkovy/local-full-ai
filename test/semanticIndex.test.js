const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WorkspaceTools } = require('../src/tools');
const { SemanticIndex, chunkFile } = require('../src/semanticIndex');

const WORDS = ['login', 'password', 'user', 'email', 'send', 'mail', 'chart', 'draw', 'canvas', 'price', 'cart', 'total'];

function fakeClient() {
  const client = {
    calls: 0,
    async embed(model, inputs) {
      client.calls += inputs.length;
      return inputs.map((text) => WORDS.map((w) => (text.toLowerCase().split(w).length - 1) + 0.01));
    }
  };
  return client;
}

function project() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-')));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'auth.js'), 'function checkLogin(user, password) {\n  return user.password === password; // login\n}\n');
  fs.writeFileSync(path.join(root, 'src', 'mailer.js'), 'function sendMail(email) {\n  // send email mail\n}\n');
  fs.writeFileSync(path.join(root, 'src', 'cart.js'), 'function total(cart) {\n  return cart.price * cart.total;\n}\n');
  fs.mkdirSync(path.join(root, 'node_modules'));
  fs.writeFileSync(path.join(root, 'node_modules', 'login.js'), 'login login login password');
  return root;
}

test('chunks overlap and carry the file name', () => {
  const text = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n');
  const chunks = chunkFile('a.js', text);
  assert.strictEqual(chunks[0].start, 1);
  assert.strictEqual(chunks[1].start, 33);
  assert.ok(chunks[0].text.startsWith('File: a.js\n'));
  assert.strictEqual(chunks[chunks.length - 1].end, 100);
});

test('search finds code by meaning, skips ignored folders and only re-embeds changed files', async () => {
  const root = project();
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-store-'));
  const client = fakeClient();
  const tools = new WorkspaceTools(root);
  const index = new SemanticIndex({ storageDir: storage, client, model: 'test-embed' });

  const first = await index.update(tools);
  assert.deepStrictEqual(first, { pending: 0, files: 3 });
  const hits = await index.search(tools, 'where is the user login and password checked', 2);
  assert.strictEqual(hits[0].rel, 'src/auth.js');
  assert.ok(hits[0].snippet.includes('checkLogin'));
  assert.strictEqual((await index.search(tools, 'send an email', 1))[0].rel, 'src/mailer.js');

  const before = client.calls;
  await index.update(tools);
  assert.strictEqual(client.calls, before);

  fs.writeFileSync(path.join(root, 'src', 'chart.js'), 'draw a chart on the canvas');
  fs.unlinkSync(path.join(root, 'src', 'cart.js'));
  const reopened = new SemanticIndex({ storageDir: storage, client, model: 'test-embed' });
  const second = await reopened.update(tools);
  assert.deepStrictEqual(second, { pending: 0, files: 3 });
  assert.strictEqual((await reopened.search(tools, 'canvas chart', 1))[0].rel, 'src/chart.js');
});
