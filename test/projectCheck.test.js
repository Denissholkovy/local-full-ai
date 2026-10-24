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
