require('./vscodeStub');
const test = require('node:test');
const assert = require('node:assert');
const { CloudClient, toOpenAIMessages } = require('../src/cloudClient');

function context(servers = []) {
  return {
    globalState: { get: (key, fallback) => (key === 'localAI.customServers' ? servers : fallback), update: async () => {} },
    secrets: { get: async (key) => (key === 'localAI.key.groq' ? 'KEY' : undefined) }
  };
}

function sse(events) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      events.forEach((e) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`)));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    }
  }), { status: 200 });
}

test('toOpenAIMessages pairs tool results with call ids and sends images only once', () => {
  const out = toOpenAIMessages([
    { role: 'user', content: 'look', images: ['iVBORw0KGgo'] },
    { role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_file', arguments: { path: 'a.js' } } }] },
    { role: 'tool', tool_name: 'read_file', content: 'code' },
    { role: 'user', content: 'again', images: ['/9j/4AAQ'] }
  ], 'groq');
  assert.strictEqual(out[0].content, 'look\n[1 image(s) attached earlier, not re-sent]');
  assert.strictEqual(out[1].tool_calls[0].id, out[2].tool_call_id);
  assert.strictEqual(out[1].tool_calls[0].function.arguments, '{"path":"a.js"}');
  assert.strictEqual(out[3].content[1].image_url.url.slice(0, 23), 'data:image/jpeg;base64,');
});

test('a tool call cut off by the output limit is dropped and reported', async (t) => {
  t.mock.method(global, 'fetch', async () => sse([
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'write_file', arguments: '{"path":"a.js","content":"half' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'length' }] }
  ]));
  const result = await new CloudClient(context()).chatStream('cloud:groq:m', [{ role: 'user', content: 'hi' }], () => {}, {});
  assert.strictEqual(result.truncated, true);
  assert.strictEqual(result.toolCalls.length, 0);
});

test('a too large max_tokens is lowered and the request repeated', async (t) => {
  const asked = [];
  t.mock.method(global, 'fetch', async (url, options) => {
    const body = JSON.parse(options.body);
    asked.push(body.max_tokens);
    if (body.max_tokens > 4096) return new Response('{"error":{"message":"max_tokens is too large"}}', { status: 400 });
    return sse([{ choices: [{ delta: { content: 'OK' } }] }]);
  });
  const result = await new CloudClient(context()).chatStream('cloud:groq:m', [{ role: 'user', content: 'hi' }], () => {}, { maxTokens: 8192 });
  assert.deepStrictEqual(asked, [8192, 4096]);
  assert.strictEqual(result.content, 'OK');
});

test('a local OpenAI-compatible server works without a key', async (t) => {
  let seen = null;
  t.mock.method(global, 'fetch', async (url, options) => {
    seen = { url, headers: options.headers };
    return sse([{ choices: [{ delta: { content: 'hi' } }] }]);
  });
  const client = new CloudClient(context([{ id: 'custom-lm-studio', name: 'LM Studio', baseUrl: 'http://localhost:1234/v1' }]));
  const result = await client.chatStream('cloud:custom-lm-studio:qwen', [{ role: 'user', content: 'hi' }], () => {}, {});
  assert.strictEqual(result.content, 'hi');
  assert.strictEqual(seen.url, 'http://localhost:1234/v1/chat/completions');
  assert.strictEqual(seen.headers.Authorization, undefined);
});

test('Anthropic gets no sampling settings, other providers do', async (t) => {
  const bodies = [];
  t.mock.method(global, 'fetch', async (url, options) => {
    bodies.push(JSON.parse(options.body));
    return sse([{ choices: [{ delta: { content: 'ok' } }] }]);
  });
  const ctx = {
    globalState: { get: (key, fallback) => fallback, update: async () => {} },
    secrets: { get: async () => 'KEY' }
  };
  const client = new CloudClient(ctx);
  const generation = { temperature: 0.2, top_p: 0.9 };
  await client.chatStream('cloud:anthropic:claude-sonnet-5-5', [{ role: 'user', content: 'hi' }], () => {}, { generation });
  await client.chatStream('cloud:openai:gpt-x', [{ role: 'user', content: 'hi' }], () => {}, { generation });
  assert.strictEqual(bodies[0].temperature, undefined);
  assert.strictEqual(bodies[0].top_p, undefined);
  assert.strictEqual(bodies[1].temperature, 0.2);
});

test('with failFast a 429 fails at once instead of waiting', async (t) => {
  let calls = 0;
  t.mock.method(global, 'fetch', async () => {
    calls++;
    return new Response('{"error":{"message":"Rate limit reached, try again in 20s"}}', { status: 429 });
  });
  const started = Date.now();
  await assert.rejects(
    new CloudClient(context()).chatStream('cloud:groq:m', [{ role: 'user', content: 'hi' }], () => {}, { failFast: true }),
    /limit is used up/
  );
  assert.strictEqual(calls, 1);
  assert.ok(Date.now() - started < 2000);
});
