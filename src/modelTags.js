const https = require('https');

const CACHE_MS = 10 * 60 * 1000;
const cache = new Map();

const QUANT_NOTES = [
  [/^q2/i, 'Smallest and fastest, clearly lower quality'],
  [/^q3/i, 'Small, some quality loss'],
  [/^q4_0$|^q4_1$/i, 'Older 4-bit format'],
  [/^q4_K_S$/i, '4-bit, slightly smaller'],
  [/^q4_K_M$|^q4$/i, 'Best balance of size and quality (default)'],
  [/^q5/i, 'Higher quality than 4-bit, bigger'],
  [/^q6/i, 'Very high quality, big'],
  [/^q8/i, 'Near-lossless, large'],
  [/^(fp16|f16|bf16)$/i, 'Full precision, very large'],
  [/^qat$/i, 'Quantization-aware trained, good quality at 4-bit'],
  [/^mxfp4$/i, 'Native 4-bit format of this model']
];

const QUANT_PATTERN = /(q\d(?:_K(?:_[SML])?|_\d)?|fp16|f16|bf16|qat|mxfp4)$/i;
const SKIP_PATTERN = /(base|text|pretrain|fp8)/i;

const USER_AGENT = 'Mozilla/5.0 (Local Full AI)';
const REQUEST_TIMEOUT_MS = 15000;

async function viaFetch(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: controller.signal });
    if (!res.ok) throw new Error(`ollama.com answered ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function viaHttps(url) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch (err) {
      return reject(err);
    }
    const req = https.request(
      { hostname: target.hostname, path: `${target.pathname}${target.search}`, method: 'GET', headers: { 'User-Agent': USER_AGENT, 'Accept-Encoding': 'identity' } },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`ollama.com answered ${res.statusCode}`));
        }
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve(data));
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error('ollama.com did not answer in time'));
    });
    req.end();
  });
}

async function fetchText(url) {
  const errors = [];
  if (typeof fetch === 'function') {
    try {
      return await viaFetch(url);
    } catch (err) {
      errors.push(`fetch: ${err.message}`);
    }
  }
  try {
    return await viaHttps(url);
  } catch (err) {
    errors.push(`https: ${err.message}`);
  }
  throw new Error(errors.join('; '));
}

async function registryTags(family) {
  const text = await fetchText(`https://registry.ollama.ai/v2/library/${family}/tags/list`);
  const parsed = JSON.parse(text);
  return (parsed.tags || []).map((tag) => ({ tag, digest: '', sizeGB: 0, context: '' }));
}

function parseSizeGB(text) {
  const m = String(text).match(/([\d.]+)\s*(GB|MB)/i);
  if (!m) return 0;
  const value = Number(m[1]);
  return m[2].toUpperCase() === 'MB' ? value / 1024 : value;
}

function parseTags(html, family) {
  const text = html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&middot;/g, ' ').replace(/\s+/g, ' ');
  const escaped = family.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`${escaped}:([\\w.\\-]+)\\s+([0-9a-f]{12})\\s*[\\u2022\\u00b7\\-]?\\s*([\\d.]+\\s*(?:GB|MB))(?:\\s*[\\u2022\\u00b7\\-]?\\s*(\\d+K)\\s*context window)?`, 'g');
  const found = new Map();
  let m;
  while ((m = re.exec(text)) !== null) {
    if (!found.has(m[1])) found.set(m[1], { tag: m[1], digest: m[2], sizeGB: parseSizeGB(m[3]), context: m[4] || '' });
  }
  return [...found.values()];
}

function quantOf(tag) {
  const m = tag.match(QUANT_PATTERN);
  return m ? m[1] : null;
}

function noteFor(quant) {
  const hit = QUANT_NOTES.find(([re]) => re.test(quant));
  return hit ? hit[1] : '';
}

async function fetchVariants(modelName) {
  const [family, rest] = modelName.split(':');
  const sizeToken = (rest || '').split('-')[0];
  const key = `${family}:${sizeToken}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.items;

  let all;
  try {
    const html = await fetchText(`https://ollama.com/library/${family}/tags`);
    all = parseTags(html, family);
    if (all.length === 0) throw new Error('the tag page had an unexpected format');
  } catch (pageError) {
    try {
      all = await registryTags(family);
    } catch (registryError) {
      throw new Error(`${pageError.message}; registry: ${registryError.message}`);
    }
  }
  const items = all
    .filter((t) => t.tag.startsWith(`${sizeToken}-`) && !SKIP_PATTERN.test(t.tag) && quantOf(t.tag))
    .map((t) => {
      const quant = quantOf(t.tag);
      return { name: `${family}:${t.tag}`, digest: t.digest, quant, sizeGB: t.sizeGB, context: t.context, note: noteFor(quant) };
    });

  const defaultEntry = all.find((t) => t.tag === sizeToken);
  if (defaultEntry && !items.some((i) => Math.abs(i.sizeGB - defaultEntry.sizeGB) < 0.05 && /q4_K_M|q4$/i.test(i.quant))) {
    items.unshift({ name: `${family}:${sizeToken}`, digest: defaultEntry.digest, quant: 'default', sizeGB: defaultEntry.sizeGB, context: defaultEntry.context, note: 'What Ollama installs by default (usually 4-bit)' });
  }
  items.sort((a, b) => a.sizeGB - b.sizeGB);
  cache.set(key, { at: Date.now(), items });
  return items;
}

module.exports = { fetchVariants, parseTags, quantOf, noteFor };
