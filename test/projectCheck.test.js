const test = require('node:test');
const assert = require('node:assert');
const { deadControls } = require('../src/projectCheck');

const page = (extra) => `<body><input id="new-task"><button id="add-task">Add</button>${extra}<script src="script.js"></script></body>`;
const script = "document.getElementById('new-task'); document.getElementById('add-task').addEventListener('click', add);";

test('new buttons that no script uses are reported', () => {
  const after = page('<div class="calculator"><input type="text" id="calc-input"><button id="calc-clear">C</button></div>');
  assert.match(deadControls(page(''), after, script), /#calc-input, #calc-clear.*do nothing/);
});

test('wired, inline, class-based and old controls are fine', () => {
  assert.strictEqual(deadControls('', page(''), script), null);
  assert.strictEqual(deadControls(page(''), page('<button id="calc-clear">C</button>'), `${script} document.querySelector('#calc-clear')`), null);
  assert.strictEqual(deadControls('', '<button onclick="go()">Go</button>', ''), null);
  assert.strictEqual(deadControls('', '<button class="key">1</button><button class="key">2</button>', "document.querySelectorAll('.key')"), null);
  assert.strictEqual(deadControls('', '<input type="hidden" name="x"><button type="submit">Send</button>', ''), null);
});

const fs = require('fs');
const os = require('os');
const path = require('path');
const { run } = require('../src/projectCheck');
const { WorkspaceTools } = require('../src/tools');

function project(files) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'check-')));
  Object.entries(files).forEach(([rel, text]) => fs.writeFileSync(path.join(root, rel), text));
  return run(new WorkspaceTools(root));
}

test('a page that calls functions of a script it never loads is reported once, with the fix', () => {
  const issues = project({ 'index.html': '<button onclick="append(1)">1</button>', 'script.js': 'function append(v) { document.title = v; }' });
  assert.strictEqual(issues.length, 1);
  assert.match(issues[0], /does not load script\.js[\s\S]*<script src="script\.js"><\/script>/);
});

test('a handler defined inside DOMContentLoaded cannot be reached from onclick', () => {
  const issues = project({
    'index.html': '<button onclick="add()">+</button><script src="app.js"></script>',
    'app.js': "document.addEventListener('DOMContentLoaded', () => {\n  function add() { return 1; }\n});\n"
  });
  assert.match(issues.join('\n'), /defines add inside another function/);
});

test('working pages are not reported', () => {
  assert.deepStrictEqual(project({
    'index.html': '<button onclick="add()">+</button><button data-value="7">7</button><script src="app.js"></script>',
    'app.js': "function add() {}\nconst s = '}{';\ndocument.querySelectorAll('button[data-value]').forEach((b) => b.addEventListener('click', add));\n"
  }), []);
});

test('controls covered by a generic selector are not dead', () => {
  const before = '<div class="keys"><button data-value="7">7</button></div>';
  const after = '<div class="keys"><button data-value="7">7</button><button data-value="%">%</button></div>';
  assert.strictEqual(deadControls(before, after, "document.querySelectorAll('button[data-value]')"), null);
  assert.strictEqual(deadControls(before, after, "document.querySelector('.keys').addEventListener('click', (e) => e.target)"), null);
  assert.match(deadControls(before, after, "document.getElementById('x')"), /do nothing/);
});

const { orphanNames } = require('../src/projectCheck');

test('a rename done only at the definition is reported with the places still to change', () => {
  const before = "button.addEventListener('click', addTask);\nfunction addTask() {}\n";
  const after = "button.addEventListener('click', addTask);\nfunction createTask() {}\n";
  assert.deepStrictEqual(orphanNames('script.js', before, after, [{ rel: 'index.html', text: '<button onclick="addTask()">' }]), [
    'addTask is no longer defined but is still used at script.js:1, index.html:1'
  ]);
  assert.deepStrictEqual(orphanNames('script.js', before, before.replace(/addTask/g, 'createTask')), []);
  assert.deepStrictEqual(orphanNames('script.js', 'function a() {}\na();', 'b();'), []);
});
