const { spawn } = require('child_process');

// A small Model Context Protocol client: stdio servers (a command) and Streamable HTTP servers (a URL).
// No SDK, because the extension ships without dependencies.
const PROTOCOL_VERSION = '2025-06-18';
const START_TIMEOUT_MS = 30000;
const CALL_TIMEOUT_MS = 120000;
const MAX_TOOLS_PER_SERVER = 40;
const MAX_STDERR = 4000;

function safeName(text) {
  return String(text || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 30) || 'server';
}

function toolName(server, tool) {
  return `mcp__${safeName(server)}__${String(tool).replace(/[^a-zA-Z0-9_-]/g, '_')}`.slice(0, 64);
}

// Text a model can read from a tools/call result.
function resultText(result) {
  if (!result) return '';
  const parts = (Array.isArray(result.content) ? result.content : []).map((c) => {
    if (c.type === 'text') return c.text;
    if (c.type === 'resource' && c.resource) return c.resource.text || `[resource ${c.resource.uri}]`;
    if (c.type === 'resource_link') return `[resource ${c.uri}]`;
    if (c.type === 'image') return `[image ${c.mimeType || ''}]`;
    return `[${c.type} content]`;
  });
  if (!parts.length && result.structuredContent) parts.push(JSON.stringify(result.structuredContent));
  return parts.join('\n');
}

class Connection {
  constructor(name, spec) {
    this.name = name;
    this.spec = spec;
    this.tools = [];
    this.status = 'stopped';
    this.error = '';
    this._nextId = 1;
    this._pending = new Map();
    this._proc = null;
    this._buffer = '';
    this._stderr = '';
    this._session = null;
  }

  get kind() {
    return this.spec.url ? 'http' : 'stdio';
  }

  async start() {
    this.status = 'starting';
    this.error = '';
    try {
      if (this.kind === 'stdio') this._spawn();
      await this._request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'local-full-ai', version: '1' }
      }, START_TIMEOUT_MS);
      await this._notify('notifications/initialized');
      const tools = [];
      let cursor;
      do {
        const page = await this._request('tools/list', cursor ? { cursor } : {}, START_TIMEOUT_MS);
        tools.push(...(page.tools || []));
        cursor = page.nextCursor;
      } while (cursor && tools.length < MAX_TOOLS_PER_SERVER);
      this.tools = tools.slice(0, MAX_TOOLS_PER_SERVER);
      this.status = 'ready';
    } catch (err) {
      this.status = 'failed';
      this.error = `${err.message}${this._stderr ? `\n${this._stderr.slice(-600)}` : ''}`;
      this.stop();
      this.status = 'failed';
    }
    return this;
  }

  _spawn() {
    const { command, args = [], env = {}, cwd } = this.spec;
    if (!command) throw new Error('No command given.');
    this._proc = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      windowsHide: true
    });
    this._proc.stdout.on('data', (chunk) => this._onData(chunk));
    this._proc.stderr.on('data', (chunk) => {
      this._stderr = (this._stderr + chunk.toString()).slice(-MAX_STDERR);
    });
    const fail = (message) => {
      this.status = 'failed';
      this.error = this.error || message;
      for (const [, waiter] of this._pending) waiter.reject(new Error(message));
      this._pending.clear();
    };
    this._proc.on('error', (err) => fail(`Could not start "${command}": ${err.message}`));
    this._proc.on('exit', (code) => {
      if (this.status !== 'stopped') fail(`The server stopped (exit code ${code}).`);
    });
  }

  _onData(chunk) {
    this._buffer += chunk.toString();
    const lines = this._buffer.split('\n');
    this._buffer = lines.pop();
    lines.forEach((line) => this._onMessage(line));
  }

  _onMessage(line) {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (_) {
      return;
    }
    if (msg.id !== undefined && msg.method) {
      // The server asks us something (sampling, roots...): this client offers none of it.
      this._send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Not supported by this client' } }).catch(() => {});
      return;
    }
    const waiter = msg.id !== undefined ? this._pending.get(msg.id) : null;
    if (!waiter) return;
    this._pending.delete(msg.id);
    if (msg.error) waiter.reject(new Error(msg.error.message || 'MCP error'));
    else waiter.resolve(msg.result || {});
  }

  async _send(message) {
    if (this.kind === 'stdio') {
      if (!this._proc || !this._proc.stdin.writable) throw new Error('The server is not running.');
      this._proc.stdin.write(`${JSON.stringify(message)}\n`);
      return;
    }
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(this.spec.headers || {}),
      ...(this._session ? { 'Mcp-Session-Id': this._session } : {}),
      ...(message.method !== 'initialize' ? { 'MCP-Protocol-Version': PROTOCOL_VERSION } : {})
    };
    const res = await fetch(this.spec.url, { method: 'POST', headers, body: JSON.stringify(message) });
    const session = res.headers.get('mcp-session-id');
    if (session) this._session = session;
    if (res.status === 401 || res.status === 403) throw new Error('The server needs authorisation (add a header with a token in its settings).');
    if (!res.ok && res.status !== 202) throw new Error(`The server answered ${res.status}.`);
    if (res.status === 202 || message.id === undefined) {
      await res.text().catch(() => '');
      return;
    }
    const type = res.headers.get('content-type') || '';
    const text = await res.text();
    if (type.includes('text/event-stream')) {
      text.split('\n').filter((l) => l.startsWith('data:')).forEach((l) => this._onMessage(l.slice(5).trim()));
    } else {
      this._onMessage(text);
    }
  }

  _request(method, params, timeoutMs = CALL_TIMEOUT_MS) {
    const id = this._nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`No answer to ${method} after ${Math.round(timeoutMs / 1000)}s.`));
      }, timeoutMs);
      this._pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        }
      });
      this._send({ jsonrpc: '2.0', id, method, params }).catch((err) => {
        const waiter = this._pending.get(id);
        if (waiter) {
          this._pending.delete(id);
          waiter.reject(err);
        }
      });
    });
  }

  _notify(method, params) {
    return this._send({ jsonrpc: '2.0', method, ...(params ? { params } : {}) });
  }

  async call(tool, args) {
    if (this.status !== 'ready') throw new Error(`MCP server "${this.name}" is not running${this.error ? `: ${this.error}` : ''}.`);
    return this._request('tools/call', { name: tool, arguments: args || {} });
  }

  stop() {
    this.status = 'stopped';
    for (const [, waiter] of this._pending) waiter.reject(new Error('The server was stopped.'));
    this._pending.clear();
    if (this._proc) {
      try {
        this._proc.kill();
      } catch (_) {
      }
      this._proc = null;
    }
    if (this.kind === 'http' && this._session) {
      fetch(this.spec.url, { method: 'DELETE', headers: { 'Mcp-Session-Id': this._session, ...(this.spec.headers || {}) } }).catch(() => {});
      this._session = null;
    }
  }
}

class McpManager {
  constructor() {
    this._connections = new Map();
  }

  // specs: { name: { command, args, env, cwd } | { url, headers } }. Starts new ones, stops removed or changed ones.
  async sync(specs) {
    const wanted = new Map(Object.entries(specs || {}));
    for (const [name, conn] of this._connections) {
      if (!wanted.has(name) || JSON.stringify(wanted.get(name)) !== JSON.stringify(conn.spec)) {
        conn.stop();
        this._connections.delete(name);
      }
    }
    const starting = [];
    for (const [name, spec] of wanted) {
      if (!this._connections.has(name)) {
        const conn = new Connection(name, spec);
        this._connections.set(name, conn);
        starting.push(conn.start());
      }
    }
    await Promise.all(starting);
  }

  restart(name) {
    const conn = this._connections.get(name);
    if (!conn) return Promise.resolve();
    conn.stop();
    return conn.start();
  }

  servers() {
    return [...this._connections.values()].map((c) => ({ name: c.name, kind: c.kind, status: c.status, error: c.error, tools: c.tools.map((t) => t.name) }));
  }

  // Tool definitions for the model, plus a lookup from the exposed name back to server and tool.
  definitions() {
    const defs = [];
    const lookup = new Map();
    for (const conn of this._connections.values()) {
      if (conn.status !== 'ready') continue;
      for (const tool of conn.tools) {
        const name = toolName(conn.name, tool.name);
        if (lookup.has(name)) continue;
        lookup.set(name, { server: conn.name, tool: tool.name, readOnly: !!(tool.annotations && tool.annotations.readOnlyHint) });
        defs.push({
          type: 'function',
          function: {
            name,
            description: `[MCP ${conn.name}] ${String(tool.description || tool.title || tool.name).slice(0, 600)}`,
            parameters: tool.inputSchema && tool.inputSchema.type === 'object' ? tool.inputSchema : { type: 'object', properties: {} }
          }
        });
      }
    }
    return { defs, lookup };
  }

  async call(server, tool, args) {
    const conn = this._connections.get(server);
    if (!conn) throw new Error(`No MCP server named "${server}".`);
    const result = await conn.call(tool, args);
    const text = resultText(result);
    if (result.isError) throw new Error(text || 'The MCP tool reported an error.');
    return text || '(no output)';
  }

  stopAll() {
    for (const conn of this._connections.values()) conn.stop();
    this._connections.clear();
  }
}

module.exports = { McpManager, Connection, toolName, resultText, safeName, PROTOCOL_VERSION };
