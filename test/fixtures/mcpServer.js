const readline = require('readline');

const rl = readline.createInterface({ input: process.stdin });
const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);

rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } });
  } else if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: 99, method: 'roots/list' });
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        tools: [
          { name: 'echo', description: 'Echo text', inputSchema: { type: 'object', properties: { text: { type: 'string' } } }, annotations: { readOnlyHint: true } },
          { name: 'fail', description: 'Always fails', inputSchema: { type: 'object', properties: {} } }
        ]
      }
    });
  } else if (msg.method === 'tools/call') {
    if (msg.params.name === 'echo') send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `echo: ${msg.params.arguments.text}` }] } });
    else send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'it broke' }], isError: true } });
  }
});
