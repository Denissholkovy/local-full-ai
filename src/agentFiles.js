const path = require('path');

const MIN_CODE_LINES = 5;
const DUMP_MIN_LINES = 8;

const DEFAULT_NAMES = {
  html: 'index.html', htm: 'index.html', css: 'style.css', scss: 'style.scss', javascript: 'script.js', js: 'script.js',
  jsx: 'App.jsx', typescript: 'index.ts', ts: 'index.ts', tsx: 'App.tsx', python: 'main.py', py: 'main.py',
  json: 'data.json', markdown: 'README.md', md: 'README.md', bash: 'script.sh', sh: 'script.sh', shell: 'script.sh',
  java: 'Main.java', go: 'main.go', rust: 'main.rs', rs: 'main.rs', c: 'main.c', cpp: 'main.cpp', php: 'index.php',
  yaml: 'config.yml', yml: 'config.yml', sql: 'query.sql', xml: 'data.xml', ruby: 'main.rb', swift: 'main.swift', kotlin: 'Main.kt'
};

const FILE_TOKEN = /([\w@./-]+\.(?:html?|css|scss|js|jsx|mjs|ts|tsx|json|md|py|sh|java|go|rs|c|cpp|h|php|yml|yaml|sql|xml|txt|rb|swift|kt|vue|svelte|toml))\b/i;

function cleanPath(raw) {
  let p = String(raw || '').trim().replace(/^[`'"]+|[`'"]+$/g, '').replace(/\\/g, '/');
  p = p.replace(/^\.\//, '');
  if (!p || path.isAbsolute(p) || p.split('/').includes('..')) return null;
  return p;
}

function unwrapFence(body) {
  const m = body.match(/^\s*```[\w+-]*\r?\n([\s\S]*?)\r?\n?```\s*$/);
  return m ? m[1] : body;
}

function trimBlock(body) {
  return body.replace(/^\r?\n/, '').replace(/\s+$/, '') + '\n';
}

function uniqueName(name, used) {
  if (!used.has(name)) return name;
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  let i = 2;
  while (used.has(`${base}${i}${ext}`)) i++;
  return `${base}${i}${ext}`;
}

const FILENAME_LINE = /^[\s#*`>_\-\d.)]*[`*_]*[\w@./-]+\.[A-Za-z0-9]{1,6}[`*_]*\s*:?\s*$/;

function dropFilenameLine(text) {
  const lines = text.split('\n');
  let i = lines.length - 1;
  while (i >= 0 && !lines[i].trim()) i--;
  if (i >= 0 && FILENAME_LINE.test(lines[i])) lines.splice(i, 1);
  return lines.join('\n');
}

function extractFiles(content) {
  const files = [];
  const used = new Set();
  let text = String(content || '');
  let lastEnd = -1;

  const MARK = '\u0001';
  text = text.replace(/<file\s+path=["']([^"']+)["']\s*>\r?\n?([\s\S]*?)(?:<\/file>|$)/g, (_all, rawPath, body) => {
    const clean = cleanPath(rawPath);
    if (!clean) return '';
    const name = uniqueName(clean, used);
    used.add(name);
    files.push({ path: name, content: trimBlock(unwrapFence(body)) });
    return MARK;
  });

  const fence = /```([\w+-]*)[ \t]*\r?\n([\s\S]*?)(?:```|$)/g;
  let out = '';
  let last = 0;
  let match;
  while ((match = fence.exec(text)) !== null) {
    const lang = (match[1] || '').toLowerCase();
    const code = match[2] || '';
    if (code.split('\n').length < MIN_CODE_LINES) continue;

    const before = text.slice(last, match.index);
    const lastLine = before.split('\n').filter((l) => l.trim()).pop() || '';
    const firstCodeLine = code.split('\n')[0] || '';
    const hinted = (lastLine.match(FILE_TOKEN) || firstCodeLine.match(FILE_TOKEN) || [])[1];
    let name = hinted ? cleanPath(hinted) : null;
    if (!name) name = DEFAULT_NAMES[lang] || 'snippet.txt';
    name = uniqueName(name, used);
    used.add(name);
    files.push({ path: name, content: trimBlock(code) });

    out += dropFilenameLine(before) + MARK;
    last = match.index + match[0].length;
  }
  out += text.slice(last);

  const lastMark = out.lastIndexOf(MARK);
  const trailingRaw = lastMark === -1 ? '' : out.slice(lastMark + 1);
  const tidy = (t) => t.replace(new RegExp(MARK, 'g'), '').replace(/```[\w+-]*[ \t]*\r?\n[\s{}\[\],]*```/g, '').replace(/\n{3,}/g, '\n\n').trim();
  return { files, text: tidy(out), trailing: tidy(trailingRaw), hadFiles: lastMark !== -1 };
}

function stripLongCode(content) {
  return String(content || '')
    .replace(/```[\w+-]*[ \t]*\r?\n([\s\S]*?)(?:```|$)/g, (all, body) => (body.split('\n').length >= MIN_CODE_LINES ? '' : all))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function hasCodeDump(content) {
  const fence = /```[\w+-]*[ \t]*\r?\n([\s\S]*?)(?:```|$)/g;
  let m;
  while ((m = fence.exec(String(content || ''))) !== null) {
    if (m[1].split('\n').length >= DUMP_MIN_LINES) return true;
  }
  return false;
}

module.exports = { extractFiles, hasCodeDump, stripLongCode };
