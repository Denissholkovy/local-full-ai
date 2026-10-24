require('./vscodeStub');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const imageGen = require('../src/imageGen');

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const JPEG = Buffer.from('ffd8ffe000104a464946', 'hex');

test('sizes are clamped and mapped to the shapes OpenAI accepts', () => {
  assert.strictEqual(imageGen.clampSize(5000), 1536);
  assert.strictEqual(imageGen.clampSize(100), 256);
  assert.strictEqual(imageGen.clampSize(1000), 1024);
  assert.strictEqual(imageGen.openaiSize(1536, 768), '1536x1024');
  assert.strictEqual(imageGen.openaiSize(512, 1024), '1024x1536');
  assert.strictEqual(imageGen.openaiSize(1024, 1024), '1024x1024');
});

test('the file extension follows what the backend really returned', () => {
  assert.strictEqual(imageGen.fixExtension('img/hero.png', 'image/jpeg'), 'img/hero.jpg');
  assert.strictEqual(imageGen.fixExtension('img/hero.jpeg', 'image/jpeg'), 'img/hero.jpeg');
  assert.strictEqual(imageGen.fixExtension('img/hero.png', 'image/png'), 'img/hero.png');
});

test('Stable Diffusion WebUI: posts to txt2img and decodes the base64 picture', async (t) => {
  let sent;
  t.mock.method(global, 'fetch', async (url, options) => {
    sent = { url, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({ images: [PNG.toString('base64')] }), { status: 200 });
  });
  const out = await imageGen.generate({ kind: 'sdwebui', url: 'http://127.0.0.1:7860/' }, { prompt: 'a cat', width: 800, height: 600 });
  assert.strictEqual(sent.url, 'http://127.0.0.1:7860/sdapi/v1/txt2img');
  assert.deepStrictEqual([sent.body.width, sent.body.height], [832, 576]);
  assert.strictEqual(out.mime, 'image/png');
});

test('OpenAI-compatible: uses the key and reads b64_json', async (t) => {
  let sent;
  t.mock.method(global, 'fetch', async (url, options) => {
    sent = { url, headers: options.headers, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({ data: [{ b64_json: JPEG.toString('base64') }] }), { status: 200 });
  });
  const config = { kind: 'openai', providerId: 'openai', model: 'gpt-image-1' };
  const out = await imageGen.generate(config, { prompt: 'a dog' }, { secrets: async () => ({ key: 'K', baseUrl: 'https://api.openai.com/v1' }) });
  assert.strictEqual(sent.url, 'https://api.openai.com/v1/images/generations');
  assert.strictEqual(sent.headers.Authorization, 'Bearer K');
  assert.strictEqual(sent.body.model, 'gpt-image-1');
  assert.strictEqual(out.mime, 'image/jpeg');
});

test('Hugging Face: raw picture bytes come back', async (t) => {
  t.mock.method(global, 'fetch', async (url) => {
    assert.match(url, /^https:\/\/router\.huggingface\.co\/hf-inference\/models\/stabilityai\//);
    return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } });
  });
  const out = await imageGen.generate({ kind: 'huggingface' }, { prompt: 'x' }, { secrets: async () => ({ key: 'hf' }) });
  assert.strictEqual(out.mime, 'image/png');
});

test('a backend that answers with something else than a picture is an error', async (t) => {
  t.mock.method(global, 'fetch', async () => new Response(JSON.stringify({ images: [Buffer.from('hello').toString('base64')] }), { status: 200 }));
  await assert.rejects(imageGen.generate({ kind: 'sdwebui' }, { prompt: 'x' }), /not with a PNG/);
});

test('without a backend the tool explains how to set it up', async () => {
  await assert.rejects(imageGen.generate(null, { prompt: 'x' }), /not set up/);
  assert.strictEqual(imageGen.describe(null), 'Off');
  assert.strictEqual(imageGen.consentName({ kind: 'sdwebui' }), null);
});

test('the chat saves the picture into the project, records it for undo and refuses to overwrite', async (t) => {
  const { WorkspaceTools } = require('../src/tools');
  const images = require('../src/chat/images');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'imggen-'));
  const tools = new WorkspaceTools(root);
  const posted = [];
  const remembered = [];
  const panel = Object.assign(Object.create(images), {
    _context: { globalState: { get: (key) => (key === 'localAI.imageGen' ? { kind: 'sdwebui' } : undefined) } },
    _cloud: {},
    _rememberFile: (session, rel) => remembered.push(rel)
  });
  const ctx = { tools, run: { aborts: new Set(), changes: new Map() }, session: {}, ui: true, post: (m) => posted.push(m) };
  t.mock.method(global, 'fetch', async () => new Response(JSON.stringify({ images: [JPEG.toString('base64')] }), { status: 200 }));

  const output = await panel._generateImage(ctx, { prompt: 'sunset', path: 'images/hero.png' }, 't1');
  const saved = path.join(fs.realpathSync(root), 'images', 'hero.jpg');
  assert.ok(fs.existsSync(saved));
  assert.match(output, /images\/hero\.jpg/);
  assert.strictEqual([...ctx.run.changes.values()][0].before, null);
  assert.deepStrictEqual(remembered, ['images/hero.jpg']);
  assert.strictEqual(posted[0].type, 'imagePreview');
  await assert.rejects(panel._generateImage(ctx, { prompt: 'again', path: 'images/hero.jpg' }, 't2'), /already exists/);
  await assert.rejects(panel._generateImage(ctx, { prompt: 'x', path: 'notes.txt' }, 't3'), /must end in/);
});
