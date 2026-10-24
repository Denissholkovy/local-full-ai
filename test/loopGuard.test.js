const test = require('node:test');
const assert = require('node:assert');
const { findLoop, makeWatcher } = require('../src/loopGuard');

test('short texts and normal prose are not loops', () => {
  assert.strictEqual(findLoop('hello'), -1);
  const prose = Array.from({ length: 60 }, (_, i) => `Line ${i} explains step ${i * 7} of the plan.`).join('\n');
  assert.strictEqual(findLoop(prose), -1);
});

test('a phrase repeated over and over is cut after one round', () => {
  const text = 'Intro text that is fine. ' + 'I will fix it now. '.repeat(60);
  const cut = findLoop(text);
  assert.ok(cut > 0 && cut < text.length);
  assert.ok(text.slice(0, cut).includes('I will fix it now.'));
});

test('a long block written three times keeps one full copy and drops the repeats', () => {
  const block = Array.from({ length: 12 }, (_, i) => `function f${i}() { return ${i}; }`).join('\n') + '\n';
  const intro = 'Here are the files:\n';
  const text = intro + block + block + block;
  const cut = findLoop(text);
  assert.ok(text.slice(0, cut).startsWith(intro + block));
  assert.ok(cut < (intro + block + block).length);
});

test('the watcher only looks again after enough new text', () => {
  const watch = makeWatcher();
  const loop = 'abcdefgh-'.repeat(120);
  assert.ok(watch(loop) >= 0);
  assert.strictEqual(watch(loop + 'x'), -1);
});
