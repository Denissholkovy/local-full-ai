require('./vscodeStub');
const test = require('node:test');
const assert = require('node:assert');
const limits = require('../src/cloudLimits');

test('resetSeconds understands Groq, OpenAI and unix formats', () => {
  assert.strictEqual(limits.resetSeconds('1m26.4s'), 86.4);
  assert.strictEqual(limits.resetSeconds('250ms'), 0.25);
  assert.strictEqual(limits.resetSeconds('90'), 90);
  assert.strictEqual(limits.resetSeconds(''), null);
  const inTen = Math.floor(Date.now() / 1000) + 10;
  assert.ok(Math.abs(limits.resetSeconds(String(inTen)) - 10) < 2);
});

test('parseHeaders groups limit, remaining and reset by scope', () => {
  const parsed = limits.parseHeaders(new Headers({
    'x-ratelimit-limit-tokens': '6000',
    'x-ratelimit-remaining-tokens': '5500',
    'x-ratelimit-reset-tokens': '5s',
    'retry-after': '3',
    'content-type': 'text/event-stream'
  }));
  assert.strictEqual(parsed.items.length, 1);
  assert.deepStrictEqual(
    { scope: parsed.items[0].scope, limit: parsed.items[0].limit, remaining: parsed.items[0].remaining, resetSec: parsed.items[0].resetSec },
    { scope: 'tokens', limit: 6000, remaining: 5500, resetSec: 5 }
  );
  assert.strictEqual(parsed.retryAfter, '3s');
});

test('waitFor uses only the numbers of the same model for per-model providers', () => {
  const low = new Headers({ 'x-ratelimit-limit-tokens': '6000', 'x-ratelimit-remaining-tokens': '100', 'x-ratelimit-reset-tokens': '20s' });
  limits.record('groq', 'model-a', limits.parseHeaders(low));
  assert.ok(limits.waitFor('groq', 2000, 'model-a') > 19);
  assert.strictEqual(limits.waitFor('groq', 2000, 'model-b'), 0);
  assert.strictEqual(limits.waitFor('groq', 50, 'model-a'), 0);
});

test('waitFor shares account-wide limits between models', () => {
  const none = new Headers({ 'x-ratelimit-limit-requests': '20', 'x-ratelimit-remaining-requests': '0', 'x-ratelimit-reset-requests': '30' });
  limits.record('openrouter', 'a:free', limits.parseHeaders(none));
  assert.ok(limits.waitFor('openrouter', 10, 'b:free') > 29);
});
