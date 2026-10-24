const vscode = require('vscode');
const path = require('path');

const SEVERITY = ['Error', 'Warning'];

// Errors and warnings from VS Code's Problems panel (TypeScript, ESLint, Python and other language servers).
// `only`: absolute paths to limit it to; `errorsOnly`: leave warnings out.
function collect(root, { only = null, errorsOnly = false, limit = 150 } = {}) {
  const lines = [];
  for (const [uri, list] of vscode.languages.getDiagnostics()) {
    if (!uri || uri.scheme !== 'file') continue;
    if (only && !only.has(uri.fsPath)) continue;
    const rel = path.relative(root, uri.fsPath);
    if (rel.startsWith('..') || rel.split(path.sep).includes('node_modules')) continue;
    for (const d of list) {
      if (d.severity > (errorsOnly ? 0 : 1)) continue;
      lines.push(`${rel.split(path.sep).join('/')}:${d.range.start.line + 1}:${d.range.start.character + 1} ${SEVERITY[d.severity]}: ${d.message}${d.source ? ` (${d.source})` : ''}`);
      if (lines.length >= limit) return lines;
    }
  }
  return lines;
}

// The same problem moves to another line when code above it changes: compare without the position.
function withoutPosition(line) {
  return String(line).replace(/:\d+:\d+ /, ' ');
}

// Language servers need a moment after a file changes before they report on it.
function settle(ms = 1500) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const DEFINITION = {
  type: 'function',
  function: {
    name: 'get_problems',
    description: 'List the errors and warnings VS Code shows in the Problems panel (type errors, lint errors, missing imports...). Call it after changing code to check your work, or pass a path to look at one file or folder.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Optional file or folder, relative to the project root' },
        errors_only: { type: 'boolean', description: 'Only errors, no warnings' }
      }
    }
  }
};

module.exports = { collect, settle, withoutPosition, DEFINITION };
