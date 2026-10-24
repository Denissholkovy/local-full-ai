const dns = require('dns').promises;
const net = require('net');

// Reads a public web page (documentation, an issue, a changelog) for the agent.
const TIMEOUT_MS = 20000;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_CHARS = 12000;
const MAX_REDIRECTS = 5;

const DEFINITION = {
  type: 'function',
  function: {
    name: 'web_fetch',
    description: 'Read a public web page (documentation, an API reference, a GitHub issue) and get its text. The user approves every request.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full http(s) address' }
      },
      required: ['url']
    }
  }
};

function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const lower = ip.toLowerCase();
  if (lower.startsWith('::ffff:')) return isPrivateAddress(lower.slice(7));
  return lower === '::1' || lower === '::' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80');
}

// Only public addresses: the page must not reach the user's router, local servers or cloud metadata.
async function checkTarget(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch (_) {
    throw new Error('Not a valid address.');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only http and https addresses can be read.');
  if (url.username || url.password) throw new Error('Addresses with a user name or password are not allowed.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (!addresses.length || addresses.some((a) => isPrivateAddress(a.address))) {
    throw new Error('This address points into a private network or this computer and cannot be read.');
  }
  return url;
}

function htmlToText(html) {
  return String(html)
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|pre|br|section|article)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

async function readLimited(res) {
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  while (size < MAX_BYTES) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  reader.cancel().catch(() => {});
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

async function fetchText(rawUrl, { signal } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });
  try {
    let url = await checkTarget(rawUrl);
    for (let hop = 0; ; hop++) {
      const res = await fetch(url, { redirect: 'manual', signal: controller.signal, headers: { 'User-Agent': 'local-full-ai', Accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.5' } });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        if (hop >= MAX_REDIRECTS) throw new Error('Too many redirects.');
        url = await checkTarget(new URL(res.headers.get('location'), url).toString());
        continue;
      }
      if (!res.ok) throw new Error(`The page answered ${res.status}.`);
      const type = res.headers.get('content-type') || '';
      if (!/text|json|xml|javascript/.test(type)) throw new Error(`This is not a text page (${type || 'unknown type'}).`);
      const body = await readLimited(res);
      const text = /html/.test(type) ? htmlToText(body) : body;
      return `${url}\n\n${text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n... [page shortened]` : text}`;
    }
  } catch (err) {
    if (err && err.name === 'AbortError') throw new Error('The page did not answer in time.');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { DEFINITION, fetchText, htmlToText, isPrivateAddress, checkTarget };
