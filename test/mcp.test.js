const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const path = require('path');
const { McpManager, toolName, resultText } = require('../src/mcp');

test('tool names are safe for every model API', () => {
  assert.strictEqual(toolName('my server', 'read.file'), 'mcp__my_server__read_file');
  assert.ok(toolName('x'.repeat(50), 'y'.repeat(50)).length <= 64);
});

test('resultText joins text parts and marks other content', () => {
  assert.strictEqual(resultText({ content: [{ type: 'text', text: 'a' }, { type: 'image', mimeType: 'image/png' }] }), 'a\n[image image/png]');
});

test('stdio server: handshake, tool list with read-only hints, calls and errors', async () => {
  const manager = new McpManager();
  try {
    await manager.sync({ fake: { command: process.execPath, args: [path.join(__dirname, 'fixtures', 'mcpServer.js')] } });
    const [server] = manager.servers();
    assert.strictEqual(server.status, 'ready', server.error);
    const { defs, lookup } = manager.definitions();
    assert.deepStrictEqual(defs.map((d) => d.function.name), ['mcp__fake__echo', 'mcp__fake__fail']);
    assert.strictEqual(lookup.get('mcp__fake__echo').readOnly, true);
    assert.strictEqual(lookup.get('mcp__fake__fail').readOnly, false);
    assert.strictEqual(await manager.call('fake', 'echo', { text: 'hi' }), 'echo: hi');
    await assert.rejects(manager.call('fake', 'fail', {}), /it broke/);
  } finally {
    manager.stopAll();
  }
});

test('a command that does not exist fails with a clear error', async () => {
  const manager = new McpManager();
  await manager.sync({ broken: { command: 'definitely-not-a-real-command-xyz' } });
  const [server] = manager.servers();
  assert.strictEqual(server.status, 'failed');
  assert.match(server.error, /definitely-not-a-real-command-xyz|ENOENT|stopped/);
  manager.stopAll();
});

test('Streamable HTTP server: session id is kept and SSE answers are read', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const msg = JSON.parse(raw || '{}');
      seen.push({ method: msg.method, session: req.headers['mcp-session-id'] });
      if (msg.id === undefined) {
        res.writeHead(202);
        return res.end();
      }
      if (msg.method === 'initialize') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'abc' });
        return res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: {} } }));
      }
      const result = msg.method === 'tools/list'
        ? { tools: [{ name: 'time', inputSchema: { type: 'object', properties: {} } }] }
        : { content: [{ type: 'text', text: 'noon' }] };
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n\n`);
    });
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const manager = new McpManager();
  try {
    await manager.sync({ web: { url: `http://127.0.0.1:${server.address().port}/mcp` } });
    assert.strictEqual(manager.servers()[0].status, 'ready', manager.servers()[0].error);
    assert.strictEqual(await manager.call('web', 'time', {}), 'noon');
    assert.strictEqual(seen[0].session, undefined);
    assert.ok(seen.slice(1).every((s) => s.session === 'abc'));
  } finally {
    manager.stopAll();
    server.close();
  }
});

test('Claude Code style entries are understood, unsupported ones are skipped', () => {
  require('./vscodeStub');
  const { normalize } = require('../src/mcpConfig');
  assert.deepStrictEqual(normalize({ command: 'npx', args: ['-y', 'srv'] }, '/p'), { command: 'npx', args: ['-y', 'srv'], env: {}, cwd: '/p', autoApprove: false });
  assert.deepStrictEqual(normalize({ type: 'http', url: 'https://x/mcp', headers: { A: 'b' } }), { url: 'https://x/mcp', headers: { A: 'b' }, autoApprove: false });
  assert.strictEqual(normalize({ type: 'sse', url: 'https://x/sse' }), null);
  assert.strictEqual(normalize({ type: 'http', url: 'file:///etc' }), null);
  assert.strictEqual(normalize({}), null);
});
