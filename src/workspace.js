const fs = require('fs');
const os = require('os');
const path = require('path');
const vscode = require('vscode');

const LEVELS = ['none', 'read', 'ask', 'full'];

function expandHome(p) {
  return typeof p === 'string' && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

function normalize(p) {
  try {
    return fs.realpathSync(p);
  } catch (_) {
    return path.resolve(p);
  }
}

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch (_) {
    return false;
  }
}

function tooBroad(dir) {
  const resolved = path.resolve(dir);
  return resolved === path.parse(resolved).root || resolved === os.homedir();
}

function config() {
  return vscode.workspace.getConfiguration('localAI');
}

function workspaceFolderPaths() {
  return (vscode.workspace.workspaceFolders || []).filter((f) => f.uri.scheme === 'file').map((f) => normalize(f.uri.fsPath));
}

function resolveWorkspaceRoot() {
  const editor = vscode.window.activeTextEditor;
  const folder = editor ? vscode.workspace.getWorkspaceFolder(editor.document.uri) : undefined;
  const real = (vscode.workspace.workspaceFolders || []).filter((f) => f.uri.scheme === 'file');
  const target = (folder && folder.uri.scheme === 'file' ? folder : null) || real[0];
  if (target) return target.uri.fsPath;
  if (editor && editor.document.uri.scheme === 'file') {
    const parent = path.dirname(editor.document.uri.fsPath);
    return tooBroad(parent) ? null : parent;
  }
  return null;
}

function resolveWorkingRoot() {
  const override = expandHome(config().get('workingFolder') || '');
  if (override && isDirectory(override)) return normalize(override);
  const auto = resolveWorkspaceRoot();
  return auto ? normalize(auto) : null;
}

function readRules() {
  const raw = config().get('folderAccess');
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r) => r && typeof r.path === 'string' && LEVELS.includes(r.level))
    .map((r) => ({ stored: r.path, path: normalize(expandHome(r.path)), level: r.level }));
}

function levelFor(abs, rules, roots) {
  let best = null;
  for (const rule of rules) {
    if (isInside(abs, rule.path) && (!best || rule.path.length > best.path.length)) best = rule;
  }
  if (best) return best.level;
  return roots.some((r) => isInside(abs, r)) ? 'full' : 'none';
}

function buildPolicy(primary) {
  const rules = readRules();
  const workspace = workspaceFolderPaths();
  const roots = [];
  const add = (p) => {
    if (p && !roots.includes(p)) roots.push(p);
  };
  add(primary);
  workspace.forEach(add);
  rules.filter((r) => r.level !== 'none').forEach((r) => {
    if (!roots.some((root) => isInside(r.path, root))) add(r.path);
  });
  return { primary, roots, rules };
}

function isTrusted() {
  return vscode.workspace.isTrusted !== false;
}

module.exports = {
  isTrusted,
  LEVELS,
  normalize,
  isInside,
  expandHome,
  resolveWorkspaceRoot,
  resolveWorkingRoot,
  workspaceFolderPaths,
  readRules,
  levelFor,
  buildPolicy
};
