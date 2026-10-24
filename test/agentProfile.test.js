const test = require('node:test');
const assert = require('node:assert');
const { decide, billions } = require('../src/agentProfile');

const local = (size, tokensPerSec = 0, extra = {}) => ({ setting: 'auto', cloud: false, nativeTools: true, size, tokensPerSec, ...extra });

test('the mode follows the size and the measured speed of a local model', () => {
  assert.strictEqual(decide(local(4)), 'direct');
  assert.strictEqual(decide(local(1.5)), 'direct');
  assert.strictEqual(decide(local(8)), 'standard');
  assert.strictEqual(decide(local(8, 4)), 'direct');
  assert.strictEqual(decide(local(14, 25)), 'agent');
  assert.strictEqual(decide(local(32)), 'agent');
  assert.strictEqual(decide(local(32, 8)), 'standard');
  assert.strictEqual(decide(local(0)), 'standard');
});

test('cloud models, tool support and the setting', () => {
  assert.strictEqual(decide({ setting: 'auto', cloud: true, nativeTools: true, rank: 'best' }), 'agent');
  assert.strictEqual(decide({ setting: 'auto', cloud: true, nativeTools: true, rank: 'weak' }), 'standard');
  assert.strictEqual(decide({ setting: 'auto', cloud: true, nativeTools: true, rank: 'best', compact: true }), 'standard');
  assert.strictEqual(decide({ setting: 'auto', cloud: true, localServer: true, nativeTools: true, size: 3 }), 'direct');
  assert.strictEqual(decide(local(32, 0, { nativeTools: false })), 'direct');
  assert.strictEqual(decide(local(4, 0, { setting: 'agent' })), 'agent');
  assert.strictEqual(decide(local(32, 0, { setting: 'agent', nativeTools: false })), 'direct');
  assert.strictEqual(decide(local(32, 0, { setting: 'direct' })), 'direct');
});

test('size comes from Ollama details first, then from the name', () => {
  assert.strictEqual(billions('mymodel:latest', '7.6B'), 7.6);
  assert.strictEqual(billions('qwen2.5-coder:1.5b'), 1.5);
  assert.strictEqual(billions('llama3.1:8b-instruct-q4_K_M'), 8);
  assert.strictEqual(billions('mistral:latest'), 0);
});
