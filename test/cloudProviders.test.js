const test = require('node:test');
const assert = require('node:assert');
const cloud = require('../src/cloudProviders');

test('model names round-trip, also for servers with a dash in the id', () => {
  const name = cloud.makeName('custom-lm-studio', 'qwen/qwen3:8b');
  assert.deepStrictEqual(cloud.parseName(name), { providerId: 'custom-lm-studio', modelId: 'qwen/qwen3:8b' });
  assert.strictEqual(cloud.parseName('qwen3:8b'), null);
});

test('rank separates strong and weak models', () => {
  assert.strictEqual(cloud.rank('llama-3.3-70b-versatile'), 'best');
  assert.strictEqual(cloud.rank('qwen/qwen3-32b'), 'best');
  assert.strictEqual(cloud.rank('llama-3.1-8b-instant'), 'weak');
  assert.strictEqual(cloud.rank('some-model'), 'ok');
});

test('filterModels drops non-chat models and keeps only free ones on OpenRouter', () => {
  const list = cloud.filterModels(cloud.provider('openrouter'), ['a/b:free', 'a/c', 'x/embed-1:free', 'models/z:free']);
  assert.deepStrictEqual(list, ['a/b:free', 'z:free']);
});

test('servers on this computer are recognised', () => {
  cloud.setServers([{ id: 'custom-jan', name: 'Jan', baseUrl: 'http://127.0.0.1:1337/v1' }, { id: 'custom-far', name: 'Far', baseUrl: 'https://api.example.com/v1' }]);
  assert.strictEqual(cloud.isLocalServer('cloud:custom-jan:m'), true);
  assert.strictEqual(cloud.isLocalServer('cloud:custom-far:m'), false);
  assert.strictEqual(cloud.provider('custom-far').server, true);
  assert.strictEqual(cloud.newServerId('Jan'), 'custom-jan-2');
  cloud.setServers([]);
});
