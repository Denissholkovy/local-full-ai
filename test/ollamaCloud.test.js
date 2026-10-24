require('./vscodeStub');
const test = require('node:test');
const assert = require('node:assert');
const cloud = require('../src/cloudProviders');
const consent = require('../src/consent');
const catalog = require('../src/catalog');

test('Ollama Cloud names are told apart from local and provider models', () => {
  assert.strictEqual(cloud.isOllamaCloud('glm-5.3:cloud'), true);
  assert.strictEqual(cloud.isOllamaCloud('deepseek-v4-pro:0813-cloud'), true);
  assert.strictEqual(cloud.isOllamaCloud('qwen3:8b'), false);
  assert.strictEqual(cloud.isOllamaCloud('cloud:groq:llama-3.3-70b'), false);
});

test('consent knows where the prompts go', () => {
  assert.strictEqual(consent.destination('qwen3:8b'), null);
  assert.strictEqual(consent.destination('glm-5.3:cloud').id, 'ollama');
  assert.strictEqual(consent.destination('cloud:groq:m').name, 'Groq');
  cloud.setServers([{ id: 'custom-lm', name: 'LM Studio', baseUrl: 'http://localhost:1234/v1' }]);
  assert.strictEqual(consent.destination('cloud:custom-lm:m'), null);
  cloud.setServers([]);
});

test('the shipped catalogs pass their own validation', () => {
  assert.ok(catalog.valid(require('../src/models.json')));
  assert.ok(catalog.validCloud(require('../src/ollamaCloud.json')));
});

test('the local catalog never contains cloud models, so old versions cannot offer them as local', () => {
  assert.ok(require('../src/models.json').every((m) => !cloud.isOllamaCloud(m.name)));
  assert.strictEqual(catalog.validCloud([{ name: 'qwen3:8b', label: 'x', category: 'code' }]), false);
});
