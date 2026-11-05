const test = require('node:test');
const assert = require('node:assert');
const { requestKind } = require('../src/agentTools');
const { extractEdits } = require('../src/agentFiles');
const { rewriteProblem } = require('../src/tools');

test('requests are told apart: question, new, edit, rewrite', () => {
  const project = { hasProjectFiles: true };
  assert.strictEqual(requestKind('Що робить script.js? Коротко.', project), 'question');
  assert.strictEqual(requestKind('Як працює функція addTask?', project), 'question');
  assert.strictEqual(requestKind('Зроби простий калькулятор: index.html, style.css, script.js'), 'new');
  assert.strictEqual(requestKind('Зроби кнопку "Додати" зеленою.', project), 'edit');
  assert.strictEqual(requestKind('Додай кнопку %', project), 'edit');
  assert.strictEqual(requestKind('чому не працює кнопка', project), 'edit');
  assert.strictEqual(requestKind('Віднімання не працює: 9-4 показує 13. Виправ.', project), 'edit');
  assert.strictEqual(requestKind('перероби все, зроби туду ліст з хедером і футером', project), 'rewrite');
  assert.strictEqual(requestKind('rewrite the page from scratch', project), 'rewrite');
});

test('edit blocks are parsed, line numbers dropped, the rest kept as the reply', () => {
  const { edits, rest } = extractEdits('Ok.\n<edit path="./a.js">\n<<<<<<< SEARCH\n 3| let x = 1;\n=======\nlet x = 2;\n>>>>>>> REPLACE\n<<<<<<< SEARCH\nfoo();\n=======\nbar();\n>>>>>>> REPLACE\n</edit>\nDone.');
  assert.deepStrictEqual(edits, [
    { path: 'a.js', search: 'let x = 1;', replace: 'let x = 2;' },
    { path: 'a.js', search: 'foo();', replace: 'bar();' }
  ]);
  assert.strictEqual(rest.replace(/\s+/g, ' ').trim(), 'Ok. Done.');
});

test('a correction may change a few lines but not most of the file', () => {
  const file = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
  assert.strictEqual(rewriteProblem(file, file.replace('line 3', 'line three').replace('line 4', 'line four')), null);
  assert.match(rewriteProblem(file, 'line 0\nsomething else'), /removes or changes 29 of 30 lines/);
  assert.strictEqual(rewriteProblem('a\nb', 'c'), null);
});

const fs = require('fs');
const os = require('os');
const path = require('path');
const { WorkspaceTools } = require('../src/tools');
const { removedControls } = require('../src/projectCheck');

test('search_text with a path to one file searches that file', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'search-')));
  fs.writeFileSync(path.join(root, 'script.js'), "function addTask() {}\nbutton.addEventListener('click', addTask);\n");
  const out = await new WorkspaceTools(root).run('search_text', { query: 'addTask', path: 'script.js' });
  assert.match(out, /script\.js:1:[\s\S]*script\.js:2:/);
});

test('a correction that drops buttons is reported, an asked removal is not', () => {
  const before = '<button data-value="0">0</button><button id="clear">C</button><button data-value="+">+</button>';
  assert.match(removedControls(before, '<button data-value="%">%</button><button id="clear">C</button>', 'add a % button'), /button "0", button "\+"/);
  assert.strictEqual(removedControls(before, `${before}<button>%</button>`, 'add a % button'), null);
  assert.strictEqual(removedControls(before, '<button id="clear">C</button>', 'прибери кнопки 0 і +'), null);
});
