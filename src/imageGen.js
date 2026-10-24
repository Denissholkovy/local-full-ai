// Picture generation for the project (illustrations, backgrounds, placeholders). Three kinds of backend:
// - sdwebui: Stable Diffusion WebUI / Forge / SD.Next / Draw Things on this computer (POST /sdapi/v1/txt2img)
// - openai:  any connected provider with an OpenAI-compatible /images/generations endpoint (OpenAI, Gemini, servers)
// - huggingface: text-to-image models on Hugging Face's hf-inference
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_SDWEBUI_URL = 'http://127.0.0.1:7860';
const DEFAULT_HF_MODEL = 'stabilityai/stable-diffusion-3-medium-diffusers';
const EXTENSIONS = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };

const DEFINITION = {
  type: 'function',
  function: {
    name: 'generate_image',
    description: 'Create a picture (photo, illustration, background, banner) from a text description and save it into the project as an image file. For icons, logos and simple shapes write an SVG file with write_file instead.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Detailed description of the picture in English: subject, style, colours, composition' },
        path: { type: 'string', description: 'Where to save it, relative to the project root, ending in .png, .jpg or .webp (for example images/hero.png)' },
        width: { type: 'number', description: 'Width in pixels, 256-1536 (default 1024)' },
        height: { type: 'number', description: 'Height in pixels, 256-1536 (default 1024)' }
      },
      required: ['prompt', 'path']
    }
  }
};

function isConfigured(config) {
  return !!(config && ['sdwebui', 'openai', 'huggingface'].includes(config.kind) && (config.kind !== 'openai' || (config.providerId && config.model)));
}

function describe(config) {
  if (!isConfigured(config)) return 'Off';
  if (config.kind === 'sdwebui') return `Stable Diffusion WebUI (${config.url || DEFAULT_SDWEBUI_URL})`;
  if (config.kind === 'huggingface') return `Hugging Face: ${config.model || DEFAULT_HF_MODEL}`;
  return `${config.providerName || config.providerId}: ${config.model}`;
}

// Model name used for the "where do the prompts go" notice, in the same form as chat models.
function consentName(config) {
  if (!isConfigured(config) || config.kind === 'sdwebui') return null;
  return config.kind === 'huggingface' ? 'cloud:huggingface:image' : `cloud:${config.providerId}:${config.model}`;
}

function clampSize(value) {
  const n = Math.round(Number(value) || 1024);
  return Math.min(1536, Math.max(256, Math.round(n / 64) * 64));
}

// OpenAI-style APIs accept only a few sizes: pick the one with the closest shape.
function openaiSize(width, height) {
  const ratio = width / height;
  if (ratio > 1.2) return '1536x1024';
  if (ratio < 0.83) return '1024x1536';
  return '1024x1024';
}

function mimeOf(buffer) {
  if (buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50) return 'image/png';
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8) return 'image/jpeg';
  if (buffer.length > 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

// The file must carry the extension of what the backend really returned.
function fixExtension(relPath, mime) {
  const wanted = EXTENSIONS[mime];
  if (!wanted) return relPath;
  const current = (String(relPath).match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase();
  if (current === wanted || (wanted === '.jpg' && current === '.jpeg')) return relPath;
  return current ? relPath.slice(0, -current.length) + wanted : relPath + wanted;
}

async function readError(res) {
  const text = await res.text().catch(() => '');
  try {
    const json = JSON.parse(text);
    return (json.error && (json.error.message || json.error)) || json.detail || json.message || text.slice(0, 300);
  } catch (_) {
    return text.slice(0, 300);
  }
}

async function call(url, options, label) {
  let res;
  try {
    res = await fetch(url, options);
  } catch (err) {
    if (err && err.name === 'AbortError') throw err;
    throw new Error(`${label} is not reachable (${err.message}). Is it running?`);
  }
  if (res.status === 401 || res.status === 403) throw new Error(`${label} rejected the key.`);
  if (!res.ok) throw new Error(`${label} error ${res.status}: ${await readError(res)}`);
  return res;
}

async function viaSdWebUi(config, request, signal) {
  const base = String(config.url || DEFAULT_SDWEBUI_URL).replace(/\/+$/, '');
  const res = await call(`${base}/sdapi/v1/txt2img`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: request.prompt, negative_prompt: 'blurry, low quality, watermark, text', width: request.width, height: request.height, steps: config.steps || 25 }),
    signal
  }, 'Stable Diffusion WebUI');
  const data = await res.json();
  const first = Array.isArray(data.images) && data.images[0];
  if (!first) throw new Error('Stable Diffusion WebUI returned no picture.');
  return Buffer.from(String(first).replace(/^data:[^,]+,/, ''), 'base64');
}

async function viaOpenAI(config, request, signal, { key, baseUrl }) {
  if (!baseUrl) throw new Error('No address is known for this provider.');
  const res = await call(`${baseUrl}/images/generations`, {
    method: 'POST',
    headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: config.model, prompt: request.prompt, n: 1, size: openaiSize(request.width, request.height) }),
    signal
  }, config.providerName || config.providerId);
  const data = await res.json();
  const first = Array.isArray(data.data) && data.data[0];
  if (first && first.b64_json) return Buffer.from(first.b64_json, 'base64');
  if (first && first.url) {
    const image = await call(first.url, { signal }, 'The picture link');
    return Buffer.from(await image.arrayBuffer());
  }
  throw new Error('The provider returned no picture.');
}

async function viaHuggingFace(config, request, signal, { key }) {
  if (!key) throw new Error('Hugging Face needs a token: connect Hugging Face under Cloud models first.');
  const model = config.model || DEFAULT_HF_MODEL;
  const res = await call(`https://router.huggingface.co/hf-inference/models/${model.split('/').map(encodeURIComponent).join('/')}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'image/png' },
    body: JSON.stringify({ inputs: request.prompt, parameters: { width: request.width, height: request.height } }),
    signal
  }, 'Hugging Face');
  return Buffer.from(await res.arrayBuffer());
}

// Returns { buffer, mime }. `secrets` gives { key, baseUrl } of the provider the config points to.
async function generate(config, args, { secrets, signal } = {}) {
  if (!isConfigured(config)) throw new Error('Picture generation is not set up. Choose a backend under Settings > Image generation in the sidebar.');
  const prompt = String(args.prompt || '').trim();
  if (!prompt) throw new Error('Describe the picture in "prompt".');
  const request = { prompt, width: clampSize(args.width), height: clampSize(args.height) };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });
  try {
    const access = config.kind === 'sdwebui' ? {} : await secrets(config);
    const buffer = config.kind === 'sdwebui'
      ? await viaSdWebUi(config, request, controller.signal)
      : config.kind === 'huggingface'
        ? await viaHuggingFace(config, request, controller.signal, access)
        : await viaOpenAI(config, request, controller.signal, access);
    const mime = mimeOf(buffer);
    if (!mime) throw new Error('The backend answered, but not with a PNG, JPEG or WebP picture.');
    return { buffer, mime };
  } catch (err) {
    if (err && err.name === 'AbortError') throw new Error(signal && signal.aborted ? 'Cancelled.' : 'The picture took too long and was stopped.');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { DEFINITION, DEFAULT_SDWEBUI_URL, DEFAULT_HF_MODEL, generate, isConfigured, describe, consentName, fixExtension, mimeOf, clampSize, openaiSize };
