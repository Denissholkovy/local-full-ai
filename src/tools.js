const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'out', 'build', '.next', '.venv', 'venv',
  '__pycache__', 'coverage', '.idea', '.gradle', 'Pods', 'target',
  '.svn', '.hg', '.cache', '.turbo', '.parcel-cache', '.pytest_cache', '.mypy_cache', '.DS_Store'
]);
const MAX_READ_CHARS = 12000;
const MAX_READ_BYTES = 2 * 1024 * 1024;
const MAX_TREE_DEPTH = 5;
const OVERVIEW_ENTRIES = 70;
const MAX_LIST_ENTRIES = 300;
const MAX_SEARCH_MATCHES = 60;
const MAX_SEARCH_FILE_BYTES = 1024 * 1024;
const MAX_COMMAND_OUTPUT = 8000;
const COMMAND_TIMEOUT_MS = 60000;
const SOURCE_EXTENSIONS = new Set(['.html', '.htm', '.css', '.js', '.mjs', '.ts', '.tsx', '.jsx', '.py', '.json', '.md', '.go', '.rs', '.java', '.php', '.vue', '.svelte']);

const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'Explore the project. Without "pattern" shows the folder tree of "path" (use "depth" 1-5 to go deeper, default 2). With a glob "pattern" (e.g. "*.js" or "src/**/*.ts") finds files recursively. Hidden folders like .github are included.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Folder relative to the project root. Default "."' },
          depth: { type: 'integer', description: 'How many levels of the tree to show (1-5). Default 2' },
          pattern: { type: 'string', description: 'Optional glob pattern for a recursive file search' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a text file from the project. Reports the line range shown. Large files are cut; pass start_line/end_line to read the rest in parts.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the project root' },
          start_line: { type: 'integer', description: 'First line to read (1-based)' },
          end_line: { type: 'integer', description: 'Last line to read (inclusive)' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_text',
      description: 'Search inside project files (case-insensitive). Returns matching lines with file and line number. Use "glob" to limit the files, e.g. "*.ts".',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Text to look for (or a regular expression when "regex" is true)' },
          path: { type: 'string', description: 'Folder to search in, relative to the project root. Default "."' },
          glob: { type: 'string', description: 'Only search files matching this glob, e.g. "*.js" or "src/**/*.py"' },
          regex: { type: 'boolean', description: 'Treat "query" as a regular expression' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Edit a file by replacing one exact piece of text. "old_string" must match the file exactly and occur once. Read the file first.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the project root' },
          old_string: { type: 'string', description: 'Exact existing text to replace' },
          new_string: { type: 'string', description: 'Replacement text' }
        },
        required: ['path', 'old_string', 'new_string']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create a new file or completely overwrite an existing one. Prefer edit_file for small changes.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the project root' },
          content: { type: 'string', description: 'Full file content' }
        },
        required: ['path', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Run a shell command in the project root (tests, build, git, package manager). Times out after 60 seconds.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command to run' }
        },
        required: ['command']
      }
    }
  }
];

const PERMISSION_BY_TOOL = {
  edit_file: 'edit',
  write_file: 'edit',
  generate_image: 'edit',
  web_fetch: 'web',
  run_command: 'command'
};

function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  const matchesAnyDepth = !glob.includes('/');
  return new RegExp(matchesAnyDepth ? `(^|/)${re}$` : `^${re}$`, 'i');
}

const REPEAT_LINES = 6;

// A block of at least REPEAT_LINES meaningful lines that appears more than once (weak models paste a page twice).
function repeatedBlock(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim());
  const seen = new Map();
  for (let i = 0; i + REPEAT_LINES <= lines.length; i++) {
    const chunk = lines.slice(i, i + REPEAT_LINES);
    if (chunk.filter((l) => l.replace(/[{}()[\];,<>/]/g, '').length > 2).length < REPEAT_LINES - 1) continue;
    const key = chunk.join('\n');
    if (seen.has(key) && i - seen.get(key) >= REPEAT_LINES) return chunk[0];
    if (!seen.has(key)) seen.set(key, i);
  }
  return null;
}

// Where `needle` sits in `text` when indentation and trailing spaces are ignored: { start, end } or null (none or several).
function looseMatch(text, needle) {
  const lines = text.split('\n');
  const want = needle.replace(/\r/g, '').split('\n').map((l) => l.trim());
  while (want.length && !want[want.length - 1]) want.pop();
  while (want.length && !want[0]) want.shift();
  if (!want.length) return null;
  const hits = [];
  for (let i = 0; i + want.length <= lines.length; i++) {
    let ok = true;
    for (let k = 0; k < want.length; k++) {
      if (lines[i + k].replace(/\r$/, '').trim() !== want[k]) {
        ok = false;
        break;
      }
    }
    if (ok) hits.push(i);
    if (hits.length > 1) return null;
  }
  if (hits.length !== 1) return null;
  const start = lines.slice(0, hits[0]).reduce((n, l) => n + l.length + 1, 0);
  const end = start + lines.slice(hits[0], hits[0] + want.length).join('\n').length;
  return { start, end };
}

function killTree(child) {
  try {
    // On Windows a shell child keeps running unless the whole tree is ended.
    if (process.platform === 'win32') require('child_process').execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {});
    else process.kill(-child.pid, 'SIGTERM');
  } catch (_) {
    try {
      child.kill();
    } catch (_err) {
    }
  }
}

function normalizeArgs(args) {
  if (typeof args === 'string') {
    try {
      return JSON.parse(args);
    } catch (_) {
      return {};
    }
  }
  return args && typeof args === 'object' ? args : {};
}

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max)}\n... [truncated, ${text.length - max} more characters]` : text;
}

function insidePath(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

class WorkspaceTools {
  constructor(root, policy) {
    this.root = fs.realpathSync(root);
    this._children = new Set();
    this.setPolicy(policy);
  }

  setPolicy(policy) {
    this.policy = policy || { primary: this.root, roots: [this.root], rules: [] };
  }

  levelFor(abs) {
    let best = null;
    for (const rule of this.policy.rules) {
      if (insidePath(abs, rule.path) && (!best || rule.path.length > best.path.length)) best = rule;
    }
    if (best) return best.level;
    return this.policy.roots.some((r) => insidePath(abs, r)) ? 'full' : 'none';
  }

  _realOf(relPath) {
    const abs = path.resolve(this.root, relPath || '.');
    let probe = abs;
    while (!fs.existsSync(probe)) {
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
    return { abs, real: path.join(fs.realpathSync(probe), path.relative(probe, abs)) };
  }

  access(name, rawArgs) {
    const args = normalizeArgs(rawArgs);
    if (name === 'edit_file' || name === 'write_file' || name === 'generate_image') {
      try {
        this.resolve(args.path, 'write');
      } catch (err) {
        return { allowed: false, reason: err.message };
      }
      const level = this.levelFor(this._realOf(args.path).real);
      return { allowed: true, forceAsk: level === 'ask' };
    }
    if (name === 'run_command') {
      const level = this.levelFor(this.root);
      if (level === 'none' || level === 'read') {
        return { allowed: false, reason: 'commands are not allowed because this folder is set to read-only or no access.' };
      }
      return { allowed: true, forceAsk: level === 'ask' };
    }
    return { allowed: true };
  }

  snapshot(relPath) {
    try {
      const abs = this.resolve(relPath);
      const stat = fs.statSync(abs);
      if (!stat.isFile() || stat.size > MAX_READ_BYTES) return null;
      return fs.readFileSync(abs, 'utf8');
    } catch (_) {
      return null;
    }
  }

  static diff(before, after) {
    const a = before === null ? [] : before.split('\n');
    const b = after.split('\n');
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start++;
    let endA = a.length;
    let endB = b.length;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
      endA--;
      endB--;
    }
    const removed = a.slice(start, endA);
    const added = b.slice(start, endB);
    const cap = 400;
    const lines = [];
    if (start > 0 && before !== null) lines.push({ t: ' ', s: `... ${start} unchanged line${start === 1 ? '' : 's'}` });
    removed.slice(0, cap).forEach((s) => lines.push({ t: '-', s }));
    if (removed.length > cap) lines.push({ t: ' ', s: `... ${removed.length - cap} more removed lines` });
    added.slice(0, cap).forEach((s) => lines.push({ t: '+', s }));
    if (added.length > cap) lines.push({ t: ' ', s: `... ${added.length - cap} more added lines` });
    return { added: added.length, removed: removed.length, isNew: before === null, lines };
  }

  // How many source files the project has (counting stops at `cap`); cached for a minute.
  countSourceFiles(cap = 200) {
    if (this._sourceCount && Date.now() - this._sourceCount.at < 60000) return this._sourceCount.n;
    let n = 0;
    this._walk(this.root, (file) => {
      if (SOURCE_EXTENSIONS.has(path.extname(file).toLowerCase())) n++;
      return n < cap;
    });
    this._sourceCount = { at: Date.now(), n };
    return n;
  }

  listSourceFiles(limit = 6) {
    const exts = SOURCE_EXTENSIONS;
    const found = [];
    let visited = 0;
    this._walk(this.root, (file) => {
      visited++;
      if (exts.has(path.extname(file).toLowerCase())) {
        try {
          found.push({ rel: this.relative(file), size: fs.statSync(file).size });
        } catch (_) {
        }
      }
      return visited < 3000;
    });
    return found.filter((f) => f.size > 0 && f.size < 200000).sort((a, b) => a.size - b.size).slice(0, limit).map((f) => f.rel);
  }

  // A short map of where things are defined, so the model can open the right file instead of guessing.
  symbolMap(maxChars = 1500) {
    const exts = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.go', '.rs', '.java', '.php', '.vue', '.svelte', '.html', '.css']);
    const patterns = [
      /(?:^|\n)\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g,
      /(?:^|\n)\s*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/g,
      /(?:^|\n)\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g,
      /(?:^|\n)\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/g,
      /(?:^|\n)\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/g,
      /\bid\s*=\s*["']([\w-]+)["']/g
    ];
    const lines = [];
    let used = 0;
    let visited = 0;
    this._walk(this.root, (file) => {
      visited++;
      if (!exts.has(path.extname(file).toLowerCase())) return visited < 3000;
      let text;
      try {
        if (fs.statSync(file).size > 150000) return true;
        text = fs.readFileSync(file, 'utf8');
      } catch (_) {
        return true;
      }
      const names = [];
      for (const re of patterns) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(text)) && names.length < 14) {
          const n = re.source.startsWith('\\bid') ? `#${m[1]}` : m[1];
          if (!names.includes(n)) names.push(n);
        }
      }
      if (!names.length) return true;
      const line = `${this.relative(file)}: ${names.join(', ')}`;
      if (used + line.length > maxChars) return false;
      lines.push(line);
      used += line.length + 1;
      return visited < 3000;
    });
    return lines.join('\n');
  }

  memoryPath() {
    return path.join(this.root, '.localai', 'memory.md');
  }

  // Notes the agent keeps about this project (conventions, how to run tests, pitfalls). Plain Markdown the user can edit.
  readMemory(maxChars = 2000) {
    const parts = [];
    try {
      const notes = fs.readFileSync(this.memoryPath(), 'utf8').trim();
      if (notes) parts.push(`Project notes (.localai/memory.md):\n${notes.slice(-maxChars)}`);
    } catch (_) {
    }
    for (const name of ['AGENTS.md', 'CLAUDE.md', '.cursorrules']) {
      try {
        const text = fs.readFileSync(path.join(this.root, name), 'utf8').trim();
        if (text) {
          parts.push(`Project instructions (${name}):\n${text.slice(0, maxChars)}`);
          break;
        }
      } catch (_) {
      }
    }
    return parts.join('\n\n');
  }

  remember(note) {
    const clean = String(note || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    if (!clean) throw new Error('"note" is required');
    const file = this.memoryPath();
    let current = '';
    try {
      current = fs.readFileSync(file, 'utf8');
    } catch (_) {
      current = '# Project notes for Local Full AI\n\nThe AI adds what it learned about this project here. Edit or delete freely.\n\n';
    }
    if (current.toLowerCase().includes(clean.toLowerCase())) return 'Already noted.';
    let next = `${current.replace(/\s*$/, '\n')}- ${clean}\n`;
    const header = next.split('\n- ')[0];
    const items = next.slice(header.length).split('\n- ').map((x) => x.trim()).filter(Boolean).map((x) => x.replace(/^- /, ''));
    while (items.join('\n').length > 4000) items.shift();
    next = `${header.replace(/\s*$/, '')}\n\n${items.map((x) => `- ${x}`).join('\n')}\n`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, next);
    return `Noted in .localai/memory.md: ${clean}`;
  }

  findFilesByName(text, limit = 3) {
    const haystack = String(text || '').toLowerCase();
    const found = [];
    let visited = 0;
    this._walk(this.root, (file) => {
      visited++;
      const base = path.basename(file).toLowerCase();
      if (base.length >= 4 && haystack.includes(base)) found.push(this.relative(file));
      return found.length < limit && visited < 4000;
    });
    return found;
  }

  readForContext(relPath, maxChars) {
    const abs = this.resolve(relPath);
    const stat = fs.statSync(abs);
    if (!stat.isFile() || stat.size > MAX_READ_BYTES) return null;
    const text = fs.readFileSync(abs, 'utf8');
    if (text.includes('\u0000')) return null;
    return { text: text.length > maxChars ? text.slice(0, maxChars) : text, truncated: text.length > maxChars };
  }

  accessSummary() {
    const roots = this.policy.roots.map((r) => {
      const level = this.levelFor(r);
      const label = { none: 'no access', read: 'read only', ask: 'edits need approval', full: 'full access' }[level];
      return `- ${r}${r === this.root ? ' (main project folder)' : ''}: ${label}`;
    });
    const hidden = this.policy.rules.filter((r) => r.level === 'none').map((r) => `- ${r.path}: no access (hidden)`);
    return [...roots, ...hidden].join('\n');
  }

  static definitions() {
    return TOOL_DEFINITIONS;
  }

  static permissionFor(name) {
    return PERMISSION_BY_TOOL[name] || null;
  }

  resolve(relPath, need = 'read') {
    const { abs, real } = this._realOf(relPath);
    if (!this.policy.roots.some((r) => insidePath(real, r))) {
      throw new Error(`Path "${relPath}" is outside the allowed folders (${this.policy.roots.join(', ')})`);
    }
    const level = this.levelFor(real);
    if (level === 'none') throw new Error(`Path "${relPath}" is blocked by the folder access settings`);
    if (need === 'write' && level === 'read') throw new Error(`"${relPath}" is in a read-only folder`);
    return abs;
  }

  relative(abs) {
    const rel = path.relative(this.root, abs);
    if (!rel) return '.';
    return rel.startsWith('..') || path.isAbsolute(rel) ? abs : rel;
  }

  label(name, rawArgs) {
    const args = normalizeArgs(rawArgs);
    switch (name) {
      case 'list_files': return `Listing ${args.pattern || args.path || '.'}`;
      case 'read_file': return `Reading ${args.path || ''}`;
      case 'search_text': return `Searching "${args.query || ''}"`;
      case 'edit_file': return `Editing ${args.path || ''}`;
      case 'generate_image': return `Drawing ${args.path || 'a picture'}`;
      case 'semantic_search': return `Searching for "${args.query || ''}"`;
      case 'web_fetch': return `Reading ${args.url || 'a web page'}`;
      case 'get_problems': return `Checking problems${args.path ? ` in ${args.path}` : ''}`;
      case 'write_file': {
        let exists = false;
        try {
          exists = !!args.path && fs.existsSync(this.resolve(args.path));
        } catch (_) {
          exists = false;
        }
        return `${exists ? 'Updating' : 'Creating'} ${args.path || ''}`;
      }
      case 'run_command': return `Running ${args.command || ''}`;
      default: {
        const mcp = String(name).match(/^mcp__(.+?)__(.+)$/);
        return mcp ? `${mcp[1]}: ${mcp[2]}` : name;
      }
    }
  }

  preview(name, rawArgs) {
    const args = normalizeArgs(rawArgs);
    if (name === 'edit_file') {
      return { kind: 'diff', path: args.path, removed: args.old_string || '', added: args.new_string || '' };
    }
    if (name === 'write_file') {
      const content = args.content || '';
      let exists = false;
      try {
        exists = fs.existsSync(this.resolve(args.path));
      } catch (_) {
        exists = false;
      }
      return {
        kind: 'file',
        path: args.path,
        exists,
        lines: content.split('\n').length,
        head: truncate(content, 600)
      };
    }
    if (name === 'run_command') {
      return { kind: 'command', command: args.command || '' };
    }
    if (name === 'web_fetch') {
      return { kind: 'mcp', args: String(args.url || '') };
    }
    if (/^mcp__/.test(String(name))) {
      return { kind: 'mcp', args: truncate(JSON.stringify(args, null, 2), 800) };
    }
    if (name === 'generate_image') {
      return { kind: 'file', path: args.path, exists: false, lines: 1, head: `Picture: ${truncate(String(args.prompt || ''), 500)}` };
    }
    return null;
  }

  async run(name, rawArgs) {
    const args = normalizeArgs(rawArgs);
    switch (name) {
      case 'list_files': return this._listFiles(args);
      case 'read_file': return this._readFile(args);
      case 'search_text': return this._searchText(args);
      case 'edit_file': return this._editFile(args);
      case 'write_file': return this._writeFile(args);
      case 'run_command': return this._runCommand(args);
      default: throw new Error(`Unknown tool "${name}"`);
    }
  }

  cancelAll() {
    for (const child of this._children) killTree(child);
    this._children.clear();
  }

  _walk(dir, visit) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return true;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        if (this.levelFor(path.join(dir, entry.name)) === 'none') continue;
        if (this._walk(path.join(dir, entry.name), visit) === false) return false;
      } else if (entry.isFile()) {
        if (visit(path.join(dir, entry.name)) === false) return false;
      }
    }
    return true;
  }

  _tree(dir, depth, limit) {
    const lines = [];
    const visit = (current, level) => {
      let entries;
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch (_) {
        return;
      }
      entries = entries
        .filter((e) => !IGNORED_DIRS.has(e.name) && this.levelFor(path.join(current, e.name)) !== 'none')
        .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (lines.length >= limit) return;
        const indent = '  '.repeat(level);
        if (entry.isDirectory()) {
          lines.push(`${indent}${entry.name}/`);
          if (level + 1 < depth) visit(path.join(current, entry.name), level + 1);
        } else {
          lines.push(`${indent}${entry.name}`);
        }
      }
    };
    visit(dir, 0);
    const truncated = lines.length >= limit;
    return { text: lines.join('\n'), truncated };
  }

  overview(maxEntries, depth) {
    const { text, truncated } = this._tree(this.root, depth || 2, maxEntries || OVERVIEW_ENTRIES);
    return `${text || '(empty folder)'}${truncated ? '\n... (more files; use list_files to explore)' : ''}`;
  }

  _listFiles({ path: dirPath, pattern, depth }) {
    const dir = this.resolve(dirPath || '.');
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      throw new Error(`"${dirPath || '.'}" is not a folder`);
    }

    if (pattern) {
      const regex = globToRegExp(pattern);
      const found = [];
      this._walk(dir, (file) => {
        const rel = this.relative(file).split(path.sep).join('/');
        if (regex.test(rel)) found.push(rel);
        return found.length < MAX_LIST_ENTRIES;
      });
      return found.length ? found.join('\n') : 'No files matched.';
    }

    const levels = Math.min(Math.max(Number(depth) || 2, 1), MAX_TREE_DEPTH);
    const { text, truncated } = this._tree(dir, levels, MAX_LIST_ENTRIES);
    if (!text) return '(empty folder)';
    return `${text}${truncated ? `\n... (stopped after ${MAX_LIST_ENTRIES} entries; list a subfolder for more)` : ''}`;
  }

  _readFile({ path: filePath, start_line: startLine, end_line: endLine }) {
    if (!filePath) throw new Error('"path" is required');
    const abs = this.resolve(filePath);
    if (!fs.existsSync(abs)) throw new Error(`File "${filePath}" does not exist`);
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) throw new Error(`"${filePath}" is a folder; use list_files`);

    let text;
    let cutByBytes = false;
    if (stat.size > MAX_READ_BYTES) {
      const fd = fs.openSync(abs, 'r');
      try {
        const buffer = Buffer.alloc(MAX_READ_BYTES);
        fs.readSync(fd, buffer, 0, MAX_READ_BYTES, 0);
        text = buffer.toString('utf8');
        cutByBytes = true;
      } finally {
        fs.closeSync(fd);
      }
    } else {
      text = fs.readFileSync(abs, 'utf8');
    }
    if (text.includes('\u0000')) throw new Error(`"${filePath}" looks like a binary file`);

    const lines = text.split(/\r?\n/);
    const total = lines.length;
    const ranged = !!(startLine || endLine);
    const from = Math.max(1, Number(startLine) || 1);
    const to = Math.min(total, Number(endLine) || total);
    let body = ranged ? lines.slice(from - 1, to).join('\n') : text;

    let shownTo = to;
    if (body.length > MAX_READ_CHARS) {
      body = body.slice(0, MAX_READ_CHARS);
      shownTo = from + body.split('\n').length - 1;
    }
    const partial = ranged || body.length < text.length || cutByBytes;
    const header = partial
      ? `[${this.relative(abs)}: lines ${from}-${shownTo} of ${total}${cutByBytes ? '+' : ''}${shownTo < to || cutByBytes ? `; continue with start_line=${shownTo + 1}` : ''}]\n`
      : '';
    return header + body;
  }

  _searchText({ query, path: dirPath, glob, regex }) {
    if (!query) throw new Error('"query" is required');
    const dir = this.resolve(dirPath || '.');
    let matcher;
    if (regex) {
      let re;
      try {
        re = new RegExp(String(query), 'i');
      } catch (err) {
        throw new Error(`Bad regex: ${err.message}`);
      }
      matcher = (line) => re.test(line);
    } else {
      const needle = String(query).toLowerCase();
      matcher = (line) => line.toLowerCase().includes(needle);
    }
    const fileFilter = glob ? globToRegExp(glob) : null;
    const matches = [];

    this._walk(dir, (file) => {
      const rel = this.relative(file).split(path.sep).join('/');
      if (fileFilter && !fileFilter.test(rel)) return true;
      let stat;
      try {
        stat = fs.statSync(file);
      } catch (_) {
        return true;
      }
      if (stat.size > MAX_SEARCH_FILE_BYTES) return true;
      let text;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch (_) {
        return true;
      }
      if (text.includes('\u0000')) return true;
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (matcher(lines[i])) {
          matches.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
          if (matches.length >= MAX_SEARCH_MATCHES) return false;
        }
      }
      return true;
    });

    if (!matches.length) return 'No matches.';
    return matches.join('\n') + (matches.length >= MAX_SEARCH_MATCHES ? `\n... (stopped after ${MAX_SEARCH_MATCHES} matches; narrow the search)` : '');
  }

  _editFile({ path: filePath, old_string: oldString, new_string: newString }) {
    if (!filePath) throw new Error('"path" is required');
    if (typeof oldString !== 'string' || oldString === '') throw new Error('"old_string" is required');
    if (typeof newString !== 'string') throw new Error('"new_string" is required');
    const abs = this.resolve(filePath, 'write');
    if (!fs.existsSync(abs)) throw new Error(`File "${filePath}" does not exist. Use write_file to create it.`);

    const text = fs.readFileSync(abs, 'utf8');
    const crlf = text.includes('\r\n');
    const toFile = (value) => (crlf ? value.replace(/\r?\n/g, '\r\n') : value);
    const target = toFile(oldString);
    const first = text.indexOf(target);
    if (first === -1) {
      const loose = looseMatch(text, oldString);
      if (loose) {
        // The match covers whole lines: move the new code to the file's indentation, keeping its inner structure.
        const indent = (text.slice(loose.start).match(/^[ \t]*/) || [''])[0];
        const firstLine = oldString.replace(/^\s*\n/, '');
        const wantedIndent = (firstLine.match(/^[ \t]*/) || [''])[0];
        const replacement = newString.replace(/^\s*\n/, '').replace(/\s+$/, '').split('\n')
          .map((l) => (!l.trim() ? '' : indent + (l.startsWith(wantedIndent) ? l.slice(wantedIndent.length) : l.trimStart())))
          .join('\n');
        fs.writeFileSync(abs, text.slice(0, loose.start) + toFile(replacement) + text.slice(loose.end));
        return `Edited ${this.relative(abs)} (matched ignoring indentation)`;
      }
      throw new Error(
        `old_string was not found in ${this.relative(abs)}. Here is the file as it is now:\n${truncate(text, 4000)}\n---\nCopy old_string exactly from it, or (better for a small file) call write_file with the complete updated content.`
      );
    }
    if (text.indexOf(target, first + 1) !== -1) {
      throw new Error('old_string occurs more than once. Include more surrounding lines to make it unique.');
    }
    fs.writeFileSync(abs, text.slice(0, first) + toFile(newString) + text.slice(first + target.length));
    return `Edited ${this.relative(abs)}`;
  }

  _writeFile({ path: filePath, content }) {
    if (!filePath) throw new Error('"path" is required');
    if (typeof content !== 'string') throw new Error('"content" is required');
    const abs = this.resolve(filePath, 'write');
    if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) throw new Error(`"${filePath}" is a folder`);
    const existed = fs.existsSync(abs);
    if (existed && !content.trim() && fs.readFileSync(abs, 'utf8').trim()) {
      throw new Error(`Refusing to replace ${this.relative(abs)} with an empty file. Write the complete new content, or use edit_file for a small change.`);
    }
    const repeated = repeatedBlock(content);
    if (repeated && !repeatedBlock(existed ? fs.readFileSync(abs, 'utf8') : '')) {
      throw new Error(`Not saved: the new content repeats a block of code (starting with "${repeated.slice(0, 80)}"). Write every part of the file only once: give the complete file with each section exactly one time.`);
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    return `${existed ? 'Overwrote' : 'Created'} ${this.relative(abs)} (${content.split('\n').length} lines)`;
  }

  _runCommand({ command }) {
    if (!command) throw new Error('"command" is required');
    return new Promise((resolve) => {
      const child = spawn(command, { shell: true, cwd: this.root, detached: process.platform !== 'win32' });
      this._children.add(child);
      let output = '';
      let timedOut = false;
      const append = (chunk) => {
        output += chunk.toString();
        if (output.length > MAX_COMMAND_OUTPUT * 4) output = output.slice(-MAX_COMMAND_OUTPUT * 2);
      };
      child.stdout.on('data', append);
      child.stderr.on('data', append);
      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child);
      }, COMMAND_TIMEOUT_MS);
      const done = (suffix) => {
        clearTimeout(timer);
        this._children.delete(child);
        const trimmed = output.length > MAX_COMMAND_OUTPUT ? `... ${output.slice(-MAX_COMMAND_OUTPUT)}` : output;
        resolve(`${trimmed.trim() || '(no output)'}\n${suffix}`);
      };
      child.on('error', (err) => done(`Failed to start: ${err.message}`));
      child.on('close', (code) => {
        done(timedOut ? `Timed out after ${COMMAND_TIMEOUT_MS / 1000}s` : `Exit code: ${code}`);
      });
    });
  }
}

module.exports = { WorkspaceTools, normalizeArgs, truncate, globToRegExp, repeatedBlock, looseMatch };
