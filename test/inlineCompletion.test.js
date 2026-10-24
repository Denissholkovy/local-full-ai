require('./vscodeStub');
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { tidy } = require('../src/inlineCompletion');
const { OllamaClient } = require('../src/ollamaClient');

test('tidy keeps one line in the middle of a line and stops before the existing code', () => {
  assert.strictEqual(tidy('a + b;\nreturn x;', ');', true), 'a + b;');
  assert.strictEqual(tidy('  return a + b;\n}\n\nfunction next() {}', '\nfunction next() {}', false), '  return a + b;\n}');
  assert.strictEqual(tidy('x<|endoftext|>', '', false), 'x');
  assert.strictEqual(tidy('\n\n  ', '', false), '');
});

test('generate sends the suffix for fill-in-the-middle and returns the text', async () => {
  let body;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      body = JSON.parse(raw);
      res.end(JSON.stringify({ response: 'a + b', done: true }));
    });
  });
  await new Promise((resolve) => server.listen(0, resolve));
  try {
    const client = new OllamaClient(`http://127.0.0.1:${server.address().port}`);
    const out = await client.generate('qwen2.5-coder:1.5b', { prompt: 'function add(a, b) { return ', suffix: ' }', options: { num_predict: 20 } });
    assert.strictEqual(out, 'a + b');
    assert.strictEqual(body.suffix, ' }');
    assert.strictEqual(body.stream, false);
  } finally {
    server.close();
  }
});

test('an aborted completion request is cancelled', async () => {
  const server = http.createServer(() => {});
  await new Promise((resolve) => server.listen(0, resolve));
  try {
    const client = new OllamaClient(`http://127.0.0.1:${server.address().port}`);
    const controller = new AbortController();
    const pending = client.generate('m', { prompt: 'x' }, controller.signal);
    controller.abort();
    await assert.rejects(pending, /cancelled/);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
