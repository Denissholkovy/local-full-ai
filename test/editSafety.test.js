const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WorkspaceTools, repeatedBlock } = require('../src/tools');

const section = '<header>\n  <h1>Todo List</h1>\n  <nav>Home</nav>\n</header>\n<main>\n  <input id="new-task">\n  <button id="add-task">Add</button>\n</main>\n';

function project(files) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'edit-')));
  Object.entries(files).forEach(([rel, text]) => fs.writeFileSync(path.join(root, rel), text));
  return { root, tools: new WorkspaceTools(root) };
}

test('a page written twice is not saved, a normal page is', async () => {
  assert.ok(repeatedBlock(section + section));
  assert.strictEqual(repeatedBlock(section), null);
  const { root, tools } = project({ 'index.html': section });
  await assert.rejects(tools.run('write_file', { path: 'index.html', content: section + section }), /repeats a block/);
  assert.strictEqual(fs.readFileSync(path.join(root, 'index.html'), 'utf8'), section);
  assert.match(await tools.run('write_file', { path: 'index.html', content: section + '<footer>x</footer>\n' }), /Overwrote/);
});

test('a file that already repeats itself can still be rewritten', async () => {
  const { tools } = project({ 'list.html': section + section });
  assert.match(await tools.run('write_file', { path: 'list.html', content: section + section + '<p>more</p>' }), /Overwrote/);
});

test('edit_file finds the code when only the indentation differs', async () => {
  const { root, tools } = project({ 'a.js': 'function f() {\n    if (x) {\n        go();\n    }\n}\n' });
  const out = await tools.run('edit_file', { path: 'a.js', old_string: 'if (x) {\n    go();\n}', new_string: 'if (x) {\n    go();\n    done();\n}' });
  assert.match(out, /ignoring indentation/);
  assert.strictEqual(fs.readFileSync(path.join(root, 'a.js'), 'utf8'), 'function f() {\n    if (x) {\n        go();\n        done();\n    }\n}\n');
});

test('an ambiguous loose match is refused', async () => {
  const { tools } = project({ 'b.js': '  go();\n    go();\n' });
  await assert.rejects(tools.run('edit_file', { path: 'b.js', old_string: 'go();', new_string: 'stop();' }), /more than once|not found/);
});
