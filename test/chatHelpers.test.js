require('./vscodeStub');
const test = require('node:test');
const assert = require('node:assert');
const { trimMessagesToFit } = require('../src/chat/common');
const { extractTextToolCalls } = require('../src/agentTools');

test('trimMessagesToFit keeps the system prompt and the latest task', () => {
  const messages = [
    { role: 'system', content: 'rules' },
    { role: 'user', content: 'old '.repeat(2000) },
    { role: 'assistant', content: 'old answer '.repeat(500) },
    { role: 'user', content: 'current task' }
  ];
  const { messages: out, trimmed } = trimMessagesToFit(messages, 4000);
  assert.strictEqual(trimmed, true);
  assert.strictEqual(out[0].content, 'rules');
  assert.strictEqual(out[out.length - 1].content, 'current task');
  assert.ok(out.length < messages.length);
});

test('trimMessagesToFit leaves short chats alone', () => {
  const messages = [{ role: 'system', content: 's' }, { role: 'user', content: 'hi' }];
  assert.deepStrictEqual(trimMessagesToFit(messages, 4000), { messages, trimmed: false });
});

test('a tool call written as JSON text is turned into a real call', () => {
  const content = 'Sure:\n```json\n{"name": "write_file", "arguments": {"path": "a.txt", "content": "hi"}}\n```';
  const found = extractTextToolCalls(content, new Set(['write_file']));
  assert.strictEqual(found.calls.length, 1);
  assert.strictEqual(found.calls[0].function.name, 'write_file');
  assert.strictEqual(found.calls[0].function.arguments.path, 'a.txt');
});

test('JSON for a tool that does not exist is left as text', () => {
  assert.strictEqual(extractTextToolCalls('{"name": "launch_rocket", "arguments": {}}', new Set(['write_file'])), null);
});
