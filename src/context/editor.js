const MAX_SELECTION_CHARS = 3000;
const AROUND_CURSOR = 12;
const MAX_OPEN_FILES = 8;
const MAX_PROBLEMS = 10;

let lastEditor = null;

function isFileEditor(editor) {
  return !!(editor && editor.document && editor.document.uri && editor.document.uri.scheme === 'file');
}

// The chat is a webview: while the user types there VS Code reports no active text editor, so the last one is kept.
function track(vscode) {
  const remember = (editor) => {
    if (isFileEditor(editor)) lastEditor = editor;
  };
  remember(vscode.window.activeTextEditor);
  return [
    vscode.window.onDidChangeActiveTextEditor(remember),
    vscode.window.onDidChangeTextEditorSelection((event) => remember(event.textEditor)),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      if (lastEditor && lastEditor.document === doc) lastEditor = null;
    })
  ];
}

function currentEditor(vscode) {
  const active = vscode.window.activeTextEditor;
  if (isFileEditor(active)) return active;
  if (lastEditor && !lastEditor.document.isClosed) return lastEditor;
  return null;
}

function openFilePaths(vscode) {
  const found = [];
  try {
    const groups = (vscode.window.tabGroups && vscode.window.tabGroups.all) || [];
    groups.forEach((group) => group.tabs.forEach((tab) => {
      const uri = tab.input && tab.input.uri;
      if (uri && uri.scheme === 'file' && !found.includes(uri.fsPath)) found.push(uri.fsPath);
    }));
  } catch (_) {
  }
  return found;
}

function readState(vscode) {
  const openFiles = openFilePaths(vscode);
  const editor = currentEditor(vscode);
  if (!editor) return { file: null, openFiles };
  const doc = editor.document;
  const sel = editor.selection;
  return {
    file: doc.uri.fsPath,
    text: doc.getText(),
    dirty: !!doc.isDirty,
    line: sel ? sel.active.line + 1 : 1,
    selection: sel && !sel.isEmpty
      ? { text: doc.getText(sel), startLine: sel.start.line + 1, endLine: sel.end.line + 1 }
      : null,
    openFiles
  };
}

function numbered(lines, from, to, mark) {
  const width = String(to).length;
  const out = [];
  for (let n = from; n <= to; n++) out.push(`${n === mark ? '>' : ' '}${String(n).padStart(width)}| ${lines[n - 1]}`);
  return out.join('\n');
}

// `relative(abs)` gives a project path or null for files outside the project.
// `shownInFull`: the active file's whole text is already in the prompt, so only the cursor line is needed.
function describe(state, { relative, problems = [], shownInFull = false } = {}) {
  if (!state) return '';
  const rel = state.file ? relative(state.file) : null;
  const others = (state.openFiles || [])
    .filter((abs) => abs !== state.file)
    .map((abs) => relative(abs))
    .filter(Boolean)
    .slice(0, MAX_OPEN_FILES);
  if (!rel && !others.length) return '';

  const parts = ['What the user has open in VS Code right now. Words like "here", "this", "this function", "тут", "це", "цю функцію", "здесь", "это" point to it:'];
  if (rel) {
    const lines = String(state.text || '').split(/\r?\n/);
    const line = Math.min(Math.max(1, state.line || 1), lines.length);
    parts.push(`- Active file: ${rel}, cursor on line ${line}${state.dirty ? ' (it has unsaved changes, so the file on disk is older)' : ''}`);
    if (state.selection && state.selection.text.trim()) {
      const text = state.selection.text.length > MAX_SELECTION_CHARS
        ? `${state.selection.text.slice(0, MAX_SELECTION_CHARS)}\n... (selection continues)`
        : state.selection.text;
      parts.push(`- Selected code (lines ${state.selection.startLine}-${state.selection.endLine}):\n\`\`\`\n${text}\n\`\`\``);
    } else if (shownInFull) {
      if (lines[line - 1] && lines[line - 1].trim()) parts.push(`- Cursor line: ${lines[line - 1].trim().slice(0, 200)}`);
    } else {
      const from = Math.max(1, line - AROUND_CURSOR);
      const to = Math.min(lines.length, line + AROUND_CURSOR);
      parts.push(`- Around the cursor (">" marks its line):\n\`\`\`\n${numbered(lines, from, to, line)}\n\`\`\``);
    }
    if (problems.length) {
      parts.push(`- Problems VS Code shows in this file:\n${problems.slice(0, MAX_PROBLEMS).map((p) => `  ${p}`).join('\n')}`);
    }
  }
  if (others.length) parts.push(`- Other open files: ${others.join(', ')}`);
  return parts.join('\n');
}

module.exports = { track, currentEditor, readState, describe };
