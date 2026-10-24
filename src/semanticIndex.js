const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Finds code by meaning ("where is the login handled") with a local embedding model.
// The index lives in the extension's storage, one file per project and model, and is updated by file time.
const CHUNK_LINES = 40;
const CHUNK_OVERLAP = 8;
const CHUNK_CHARS = 2000;
const MAX_FILE_BYTES = 200 * 1024;
const MAX_FILES = 2500;
const BATCH = 16;
const SNIPPET_LINES = 6;
const TEXT_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.vue', '.svelte', '.py', '.rb', '.php', '.go', '.rs', '.java', '.kt', '.swift',
  '.c', '.h', '.cpp', '.hpp', '.cs', '.m', '.scala', '.dart', '.lua', '.sh', '.sql', '.html', '.htm', '.css', '.scss', '.less',
  '.md', '.txt', '.json', '.yaml', '.yml', '.toml', '.xml', '.graphql', '.proto', '.ex', '.exs', '.erl', '.clj', '.r', '.jl'
]);

function toBase64(vector) {
  let norm = 0;
  for (const x of vector) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  const arr = Float32Array.from(vector, (x) => x / norm);
  return Buffer.from(arr.buffer).toString('base64');
}

function fromBase64(text) {
  const buf = Buffer.from(text, 'base64');
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

function dot(a, b) {
  let sum = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) sum += a[i] * b[i];
  return sum;
}

function chunkFile(rel, text) {
  const lines = text.split(/\r?\n/);
  const chunks = [];
  for (let start = 0; start < lines.length; start += CHUNK_LINES - CHUNK_OVERLAP) {
    const end = Math.min(lines.length, start + CHUNK_LINES);
    const body = lines.slice(start, end).join('\n');
    if (body.trim()) chunks.push({ start: start + 1, end, text: `File: ${rel}\n${body}`.slice(0, CHUNK_CHARS) });
    if (end >= lines.length) break;
  }
  return chunks;
}

class SemanticIndex {
  constructor({ storageDir, client, model }) {
    this._storageDir = storageDir;
    this._client = client;
    this.model = model;
    this._data = null;
    this._file = null;
    this._busy = null;
  }

  // nomic-embed-text was trained with these prefixes and finds much better matches with them.
  _prefix(kind) {
    if (!/nomic/i.test(this.model)) return '';
    return kind === 'query' ? 'search_query: ' : 'search_document: ';
  }

  _load(root) {
    const id = crypto.createHash('sha1').update(`${root}\n${this.model}`).digest('hex').slice(0, 16);
    const file = path.join(this._storageDir, `${id}.json`);
    if (this._file === file && this._data) return;
    this._file = file;
    try {
      this._data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!this._data || this._data.model !== this.model || typeof this._data.files !== 'object') throw new Error('stale');
    } catch (_) {
      this._data = { model: this.model, root, files: {} };
    }
  }

  _save() {
    fs.mkdirSync(this._storageDir, { recursive: true });
    const temp = `${this._file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this._data));
    fs.renameSync(temp, this._file);
  }

  // Embeds new and changed files until `budgetMs` runs out. Returns { pending } = files still waiting.
  async update(tools, { budgetMs = 60000, onProgress } = {}) {
    if (this._busy) return this._busy;
    this._busy = this._update(tools, budgetMs, onProgress).finally(() => {
      this._busy = null;
    });
    return this._busy;
  }

  async _update(tools, budgetMs, onProgress) {
    this._load(tools.root);
    const started = Date.now();
    const seen = new Set();
    const todo = [];
    let count = 0;
    tools._walk(tools.root, (abs) => {
      if (!TEXT_EXTENSIONS.has(path.extname(abs).toLowerCase())) return true;
      if (++count > MAX_FILES) return false;
      let stat;
      try {
        stat = fs.statSync(abs);
      } catch (_) {
        return true;
      }
      if (stat.size === 0 || stat.size > MAX_FILE_BYTES) return true;
      const rel = tools.relative(abs).split(path.sep).join('/');
      seen.add(rel);
      const known = this._data.files[rel];
      if (!known || known.mtime !== stat.mtimeMs || known.size !== stat.size) todo.push({ abs, rel, mtime: stat.mtimeMs, size: stat.size });
      return true;
    });
    let changed = false;
    Object.keys(this._data.files).forEach((rel) => {
      if (!seen.has(rel)) {
        delete this._data.files[rel];
        changed = true;
      }
    });

    let done = 0;
    for (const file of todo) {
      if (Date.now() - started > budgetMs) break;
      let text;
      try {
        text = fs.readFileSync(file.abs, 'utf8');
      } catch (_) {
        continue;
      }
      if (text.includes('\u0000')) continue;
      const chunks = chunkFile(file.rel, text);
      const stored = [];
      for (let i = 0; i < chunks.length; i += BATCH) {
        const batch = chunks.slice(i, i + BATCH);
        const vectors = await this._client.embed(this.model, batch.map((c) => this._prefix('document') + c.text));
        batch.forEach((c, k) => stored.push({ start: c.start, end: c.end, v: toBase64(vectors[k]) }));
      }
      this._data.files[file.rel] = { mtime: file.mtime, size: file.size, chunks: stored };
      changed = true;
      done++;
      if (onProgress && done % 25 === 0) onProgress(done, todo.length);
    }
    if (changed) this._save();
    return { pending: todo.length - done, files: Object.keys(this._data.files).length };
  }

  async search(tools, query, limit = 8) {
    this._load(tools.root);
    const [vector] = await this._client.embed(this.model, [this._prefix('query') + String(query)]);
    const q = fromBase64(toBase64(vector));
    const scored = [];
    Object.entries(this._data.files).forEach(([rel, entry]) => {
      entry.chunks.forEach((c) => scored.push({ rel, start: c.start, end: c.end, score: dot(q, fromBase64(c.v)) }));
    });
    scored.sort((a, b) => b.score - a.score);
    const picked = [];
    for (const hit of scored) {
      if (picked.length >= limit) break;
      if (picked.some((p) => p.rel === hit.rel && Math.abs(p.start - hit.start) < CHUNK_LINES)) continue;
      picked.push(hit);
    }
    return picked.map((hit) => {
      let snippet = '';
      try {
        const lines = fs.readFileSync(tools.resolve(hit.rel), 'utf8').split(/\r?\n/);
        snippet = lines.slice(hit.start - 1, hit.start - 1 + SNIPPET_LINES).join('\n');
      } catch (_) {
      }
      return { ...hit, snippet };
    });
  }
}

module.exports = { SemanticIndex, chunkFile, toBase64, fromBase64, dot };
