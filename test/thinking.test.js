const { settings } = require('./vscodeStub');
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const generation = require('../src/generation');
const { OllamaClient, stripLeakedThinking } = require('../src/ollamaClient');

test('think:false only goes to models that can switch thinking off', () => {
  settings.thinking = 'auto';
  assert.strictEqual(generation.think('qwen3:4b', false), undefined);
  assert.strictEqual(generation.think('qwen3:4b', true), false);
  assert.strictEqual(generation.think('qwen3:32b', true), undefined);
  assert.strictEqual(generation.think('gpt-oss:20b', false), undefined);
  settings.thinking = 'fast';
  assert.strictEqual(generation.think('gpt-oss:20b', false), 'low');
  settings.thinking = 'deep';
  assert.strictEqual(generation.think('qwen3:4b', false), true);
  settings.thinking = undefined;
});

test('thinking budgets: short for small models, none for deep', () => {
  assert.strictEqual(generation.thinkBudget('qwen3:4b'), 4000);
  assert.strictEqual(generation.thinkBudget('qwen3:32b'), 16000);
  settings.thinking = 'deep';
  assert.strictEqual(generation.thinkBudget('qwen3:4b'), 0);
  settings.thinking = 'fast';
  assert.strictEqual(generation.thinkBudget('qwen3:32b'), 1500);
  settings.thinking = undefined;
});

test('sampling is left to the model', () => {
  assert.deepStrictEqual(generation.options(), {});
});

test('thinking that leaked into the answer is removed', () => {
  assert.strictEqual(stripLeakedThinking('Okay, the user said hi.\n</think>\n\nПривіт!'), 'Привіт!');
  assert.strictEqual(stripLeakedThinking('<think>x</think>Hi'), '<think>x</think>Hi');
  assert.strictEqual(stripLeakedThinking('Plain answer'), 'Plain answer');
});

test('thinking past the budget is closed and the model continues with the answer', async () => {
  const bodies = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw);
      bodies.push(body);
      const last = body.messages[body.messages.length - 1];
      if (last.role === 'assistant') {
        res.write(JSON.stringify({ message: { content: 'Done.' } }) + '\n');
        return res.end(JSON.stringify({ done: true }) + '\n');
      }
      let n = 0;
      const timer = setInterval(() => {
        if (res.destroyed || n++ > 400) return clearInterval(timer);
        res.write(JSON.stringify({ message: { thinking: `Step ${n}: I consider layout option ${n * 7} for the page. ` } }) + '\n');
      }, 1);
      res.on('close', () => clearInterval(timer));
    });
  });
  await new Promise((resolve) => server.listen(0, resolve));
  try {
    const notices = [];
    const client = new OllamaClient(`http://127.0.0.1:${server.address().port}`);
    const result = await client.chatStream('qwen3:4b', [{ role: 'user', content: 'hi' }], () => {}, { canThink: true, thinkBudget: 1000, onNotice: (n) => notices.push(n) });
    assert.strictEqual(result.content, 'Done.');
    assert.strictEqual(bodies.length, 2);
    const prefill = bodies[1].messages[bodies[1].messages.length - 1];
    assert.strictEqual(prefill.role, 'assistant');
    assert.ok(prefill.thinking.length <= 1100 && /write the final answer/.test(prefill.thinking));
    assert.strictEqual(bodies[1].think, true);
    assert.match(notices[0], /thought long enough/);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
