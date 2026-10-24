const { settings } = require('./vscodeStub');
const test = require('node:test');
const assert = require('node:assert');
const support = require('../src/chat/cloudSupport');

function panel(models) {
  return Object.assign(Object.create(support), {
    _context: { globalState: { get: (key, fallback) => (key === 'localAI.cloudModels' ? models : key.startsWith('localAI.cloudConsent') ? true : fallback) } }
  });
}

const models = [
  { name: 'cloud:groq:llama-3.3-70b', providerId: 'groq', modelId: 'llama-3.3-70b' },
  { name: 'cloud:gemini:gemini-3-pro', providerId: 'gemini', modelId: 'gemini-3-pro' }
];

test('a limit error moves the run to a model of another provider when auto fallback is on', async () => {
  settings.cloudAutoFallback = true;
  const posted = [];
  const ctx = { isSub: false, modelName: 'cloud:groq:llama-3.3-70b', run: {}, post: (m) => posted.push(m) };
  const switched = await panel(models)._switchAfterLimit(ctx, new Error('Groq: the free limit is used up for now'));
  assert.strictEqual(switched, true);
  assert.strictEqual(ctx.modelName, 'cloud:gemini:gemini-3-pro');
  assert.strictEqual(posted.length, 1);
  assert.strictEqual(await panel(models)._switchAfterLimit(ctx, new Error('limit used up')), false);
});

test('nothing switches when the setting is off or the error is not about limits', async () => {
  settings.cloudAutoFallback = false;
  const ctx = { isSub: false, modelName: 'cloud:groq:llama-3.3-70b', run: {}, post: () => {} };
  assert.strictEqual(await panel(models)._switchAfterLimit(ctx, new Error('limit used up')), false);
  settings.cloudAutoFallback = true;
  assert.strictEqual(await panel(models)._switchAfterLimit(ctx, new Error('The provider rejected the API key.')), false);
  const local = { isSub: false, modelName: 'qwen3:8b', run: {}, post: () => {} };
  assert.strictEqual(await panel(models)._switchAfterLimit(local, new Error('limit')), false);
  settings.cloudAutoFallback = undefined;
});
