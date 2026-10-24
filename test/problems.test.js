const { vscodeStub } = require('./vscodeStub');
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const problems = require('../src/problems');

const root = path.resolve('/proj');
const diag = (line, severity, message) => ({ severity, message, source: 'ts', range: { start: { line, character: 2 } } });

test('collect lists project errors and warnings, skips outside files and node_modules', () => {
  vscodeStub.languages = {
    getDiagnostics: () => [
      [{ scheme: 'file', fsPath: path.join(root, 'src', 'a.ts') }, [diag(4, 0, 'Cannot find name x'), diag(9, 1, 'Unused y'), diag(1, 3, 'hint')]],
      [{ scheme: 'file', fsPath: path.join(root, 'node_modules', 'm', 'i.ts') }, [diag(0, 0, 'lib error')]],
      [{ scheme: 'file', fsPath: path.resolve('/other/b.ts') }, [diag(0, 0, 'outside')]]
    ]
  };
  assert.deepStrictEqual(problems.collect(root), ['src/a.ts:5:3 Error: Cannot find name x (ts)', 'src/a.ts:10:3 Warning: Unused y (ts)']);
  assert.deepStrictEqual(problems.collect(root, { errorsOnly: true }), ['src/a.ts:5:3 Error: Cannot find name x (ts)']);
  assert.deepStrictEqual(problems.collect(root, { only: new Set([path.resolve('/nothing')]) }), []);
});

test('the same problem on another line counts as the same', () => {
  assert.strictEqual(problems.withoutPosition('a.ts:5:3 Error: x'), problems.withoutPosition('a.ts:40:1 Error: x'));
});
