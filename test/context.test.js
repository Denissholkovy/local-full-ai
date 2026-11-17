const { vscodeStub } = require('./vscodeStub');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const editorContext = require('../src/context/editor');
const retrieval = require('../src/context/retrieval');
const docsLocation = require('../src/context/docsLocation');
const { isSmallTalk, looksLikeFollowUpEdit } = require('../src/agentTools');

const root = path.resolve('/proj');
const relative = (abs) => (abs.startsWith(root + path.sep) ? path.relative(root, abs).split(path.sep).join('/') : null);
const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n');

function fakeEditor(file, text, { line = 0, selection = null } = {}) {
  const doc = { uri: { scheme: 'file', fsPath: file }, isClosed: false, isDirty: false, getText: (range) => (range ? selection : text) };
  return {
    document: doc,
    selection: { isEmpty: !selection, active: { line }, start: { line }, end: { line: line + 1 } }
  };
}

test('the last file editor is kept while the chat webview has the focus', () => {
  const handlers = {};
  vscodeStub.window.onDidChangeActiveTextEditor = (fn) => { handlers.active = fn; return { dispose() {} }; };
  vscodeStub.window.onDidChangeTextEditorSelection = (fn) => { handlers.selection = fn; return { dispose() {} }; };
  vscodeStub.workspace.onDidCloseTextDocument = (fn) => { handlers.close = fn; return { dispose() {} }; };
  const editor = fakeEditor(path.join(root, 'a.js'), lines);
  vscodeStub.window.activeTextEditor = editor;
  editorContext.track(vscodeStub);
  vscodeStub.window.activeTextEditor = undefined;
  handlers.active(undefined);
  assert.strictEqual(editorContext.currentEditor(vscodeStub), editor);
  handlers.close(editor.document);
  assert.strictEqual(editorContext.currentEditor(vscodeStub), null);
});

test('the editor note shows the lines around the cursor with a marker', () => {
  const state = { file: path.join(root, 'src/app.js'), text: lines, line: 20, selection: null, openFiles: [path.join(root, 'b.css'), '/elsewhere/x.js'] };
  const note = editorContext.describe(state, { relative, problems: ['src/app.js:3:1 Error: x is not defined'] });
  assert.match(note, /Active file: src\/app\.js, cursor on line 20/);
  assert.match(note, />20\| line 20/);
  assert.match(note, / 8\| line 8/);
  assert.doesNotMatch(note, /line 7\n/);
  assert.match(note, /x is not defined/);
  assert.match(note, /Other open files: b\.css$/);
  assert.doesNotMatch(note, /elsewhere/);
});

test('a selection replaces the cursor window, and a file shown in full only gets its cursor line', () => {
  const state = { file: path.join(root, 'a.js'), text: lines, line: 5, selection: { text: 'const picked = 1;', startLine: 5, endLine: 5 }, openFiles: [] };
  const withSelection = editorContext.describe(state, { relative });
  assert.match(withSelection, /Selected code \(lines 5-5\):\n```\nconst picked = 1;/);
  assert.doesNotMatch(withSelection, /Around the cursor/);
  const inFull = editorContext.describe({ ...state, selection: null }, { relative, shownInFull: true });
  assert.match(inFull, /Cursor line: line 5/);
  assert.doesNotMatch(inFull, /Around the cursor/);
});

test('nothing open in the project gives no editor note', () => {
  assert.strictEqual(editorContext.describe({ file: '/elsewhere/a.js', text: 'x', line: 1, openFiles: [] }, { relative }), '');
});

test('code names are picked out of a request', () => {
  assert.deepStrictEqual(retrieval.codeNames('виправ addTask() і `renderList`, а також user_name та #display'), ['renderList', 'addTask', 'user_name', '#display']);
  assert.deepStrictEqual(retrieval.codeNames('зроби кнопку зеленою в style.css'), []);
  assert.deepStrictEqual(retrieval.codeNames('Make it faster please'), []);
});

test('name hits and meaning snippets are formatted, weak and already shown ones left out', () => {
  assert.strictEqual(retrieval.formatNameHits([{ name: 'addTask', lines: [] }]), '');
  assert.match(retrieval.formatNameHits([{ name: 'addTask', lines: ['script.js:4: function addTask() {'] }]), /addTask:\n  script\.js:4: function addTask/);
  const hits = [
    { rel: 'a.js', start: 1, end: 20, score: 0.8, snippet: 'function a() {}' },
    { rel: 'b.js', start: 5, end: 25, score: 0.75, snippet: 'function b() {}' },
    { rel: 'c.js', start: 1, end: 20, score: 0.3, snippet: 'function c() {}' }
  ];
  const text = retrieval.formatSnippets(hits, new Set(['a.js']));
  assert.match(text, /### b\.js \(lines 5-25\)/);
  assert.doesNotMatch(text, /a\.js|c\.js/);
  assert.strictEqual(retrieval.formatSnippets([]), '');
});

test('new Markdown documents in the root go to docs/, plans and briefs to docs/briefs/', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-place-'));
  assert.strictEqual(docsLocation.place('ARCHITECTURE.md', { root: dir }), 'docs/ARCHITECTURE.md');
  assert.strictEqual(docsLocation.place('./plan.md', { root: dir }), 'docs/briefs/plan.md');
  assert.strictEqual(docsLocation.place('бриф-логін.md', { root: dir }), 'docs/briefs/бриф-логін.md');
  assert.strictEqual(docsLocation.place('README.md', { root: dir }), null);
  assert.strictEqual(docsLocation.place('CHANGELOG.md', { root: dir }), null);
  assert.strictEqual(docsLocation.place('src/notes.md', { root: dir }), null);
  assert.strictEqual(docsLocation.place('index.html', { root: dir }), null);
  assert.strictEqual(docsLocation.place('setup.md', { root: dir, task: 'створи setup.md у корені' }), null);
  fs.writeFileSync(path.join(dir, 'old.md'), '# old');
  assert.strictEqual(docsLocation.place('old.md', { root: dir }), null);
  fs.mkdirSync(path.join(dir, 'doc'));
  assert.strictEqual(docsLocation.place('guide.md', { root: dir }), 'doc/guide.md');
});

test('small talk is told apart from short follow-up requests', () => {
  assert.ok(isSmallTalk('дякую!'));
  assert.ok(isSmallTalk('ok'));
  assert.ok(!isSmallTalk('темніше'));
  assert.ok(looksLikeFollowUpEdit('темніше', true));
  assert.ok(!looksLikeFollowUpEdit('супер', true));
});
