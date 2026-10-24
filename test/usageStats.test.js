const test = require('node:test');
const assert = require('node:assert');
const stats = require('../src/usageStats');

function context() {
  const state = {};
  return { globalState: { get: (k, d) => (k in state ? state[k] : d), update: async (k, v) => { state[k] = v; } } };
}

test('usage adds up per model and day and old days are dropped', async () => {
  const ctx = context();
  const now = new Date(2026, 9, 23, 12).getTime();
  const day = 24 * 3600 * 1000;
  stats.record(ctx, 'qwen3:8b', { promptEvalCount: 100, evalCount: 50, evalDuration: 5e9 }, now - 40 * day);
  stats.record(ctx, 'qwen3:8b', { promptEvalCount: 1000, evalCount: 200, evalDuration: 10e9 }, now);
  stats.record(ctx, 'qwen3:8b', { promptEvalCount: 1000, evalCount: 200, evalDuration: 10e9 }, now);
  stats.record(ctx, 'cloud:groq:x', { promptEvalCount: 10, evalCount: 5, evalDuration: 1e9 }, now - 3 * day);
  await new Promise((r) => setTimeout(r, 10));
  const today = stats.summary(ctx, 1, now);
  assert.deepStrictEqual(today.map((r) => [r.model, r.requests, r.prompt, r.output]), [['qwen3:8b', 2, 2000, 400]]);
  assert.strictEqual(today[0].tokensPerSec, 20);
  assert.strictEqual(stats.summary(ctx, 7, now).length, 2);
  assert.strictEqual(Object.keys(ctx.globalState.get('localAI.usageStats')).length, 2);
});
