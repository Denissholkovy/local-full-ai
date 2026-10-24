require('./vscodeStub');
const test = require('node:test');
const assert = require('node:assert');
const { repeatsText } = require('../src/agentTools');
const { ChatPanel } = require('../src/chatPanel');

test('a repeated answer is recognised, a new one is not', () => {
  const first = 'Я створив файл index.html з калькулятором. Відкрийте його в браузері.';
  assert.strictEqual(repeatsText(first, first), true);
  assert.strictEqual(repeatsText(`${first}\n`, `**${first}**`), true);
  assert.strictEqual(repeatsText(`${first} Готово!`, first), true);
  assert.strictEqual(repeatsText('Я виправив помилку в script.js: кнопка тепер рахує суму.', first), false);
  assert.strictEqual(repeatsText('Готово.', 'Готово.'), false);
  assert.strictEqual(repeatsText(`<think>plan</think>${first}`, first), true);
});

test('only answers of the current request count as earlier answers', () => {
  const panel = Object.create(ChatPanel.prototype);
  const history = [
    { role: 'user', content: 'привіт' },
    { role: 'assistant', content: 'Привіт! Чим можу допомогти з проєктом?' },
    { role: 'user', content: 'привіт' }
  ];
  assert.strictEqual(panel._lastAnswerThisTurn(history), null);
  history.push({ role: 'assistant', content: 'Створюю файл', tool_calls: [{}] });
  history.push({ role: 'tool', content: 'ok' });
  history.push({ role: 'user', content: '[check] fix', synthetic: true });
  assert.strictEqual(panel._lastAnswerThisTurn(history).content, 'Створюю файл');
});
