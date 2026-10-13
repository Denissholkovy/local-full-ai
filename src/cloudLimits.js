const vscode = require('vscode');

const emitter = new vscode.EventEmitter();
const store = new Map();

const SCOPE_LABELS = {
  requests: 'Requests',
  tokens: 'Tokens',
  'requests-minute': 'Requests per minute',
  'requests-day': 'Requests per day',
  'requests-hour': 'Requests per hour',
  'tokens-minute': 'Tokens per minute',
  'tokens-day': 'Tokens per day',
  'tokens-hour': 'Tokens per hour'
};

function humanize(scope) {
  if (SCOPE_LABELS[scope]) return SCOPE_LABELS[scope];
  const text = scope.replace(/-/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function toNumber(value) {
  const n = Number(String(value).replace(/[^\d.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

// "1m26.4s", "13.5s", "250ms", "90" or a unix time -> seconds (null when unknown).
function resetSeconds(value) {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value).trim();
  if (/^\d+(\.\d+)?$/.test(text)) {
    const n = Number(text);
    return n > 1e9 ? Math.max(0, n - Date.now() / 1000) : n;
  }
  const m = text.match(/^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m(?!s))?(?:(\d+(?:\.\d+)?)s)?(?:(\d+(?:\.\d+)?)ms)?$/);
  if (m && (m[1] || m[2] || m[3] || m[4])) {
    return Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0) + Number(m[4] || 0) / 1000;
  }
  return null;
}

function formatReset(value) {
  if (value === undefined || value === null || value === '') return '';
  const text = String(value).trim();
  if (/^\d+(\.\d+)?$/.test(text)) {
    let seconds = Number(text);
    if (seconds > 1e9) seconds = Math.max(0, seconds - Date.now() / 1000);
    if (seconds >= 3600) return `${Math.round(seconds / 3600)}h`;
    if (seconds >= 60) return `${Math.round(seconds / 60)}m`;
    return `${Math.round(seconds)}s`;
  }
  const date = Date.parse(text);
  if (!Number.isNaN(date) && /\d{4}-\d{2}-\d{2}/.test(text)) {
    const seconds = Math.max(0, (date - Date.now()) / 1000);
    return seconds >= 3600 ? `${Math.round(seconds / 3600)}h` : seconds >= 60 ? `${Math.round(seconds / 60)}m` : `${Math.round(seconds)}s`;
  }
  return text;
}

function parseHeaders(headers) {
  const groups = new Map();
  let retryAfter = null;
  const each = typeof headers.forEach === 'function' ? (fn) => headers.forEach((v, k) => fn(k, v)) : (fn) => Object.entries(headers).forEach(([k, v]) => fn(k, v));
  each((rawKey, value) => {
    const key = String(rawKey).toLowerCase();
    if (key === 'retry-after') retryAfter = value;
    let m = key.match(/^x-ratelimit-(limit|remaining|reset)-(.+)$/);
    let kind;
    let scope;
    if (m) {
      kind = m[1];
      scope = m[2];
    } else if ((m = key.match(/^(?:x-)?ratelimit-(limit|remaining|reset)$/))) {
      kind = m[1];
      scope = 'requests';
    } else {
      return;
    }
    const entry = groups.get(scope) || {};
    entry[kind] = value;
    groups.set(scope, entry);
  });
  const items = [];
  groups.forEach((entry, scope) => {
    const limit = toNumber(entry.limit);
    const remaining = toNumber(entry.remaining);
    if (limit === null && remaining === null) return;
    items.push({ scope, label: humanize(scope), limit, remaining, reset: formatReset(entry.reset), resetSec: resetSeconds(entry.reset) });
  });
  items.sort((a, b) => a.label.localeCompare(b.label));
  return { items, retryAfter: retryAfter ? formatReset(retryAfter) : '' };
}

function record(providerId, modelId, parsed) {
  const previous = store.get(providerId);
  if (parsed.items.length === 0 && previous && previous.items.length && Date.now() - previous.at < 10 * 60 * 1000) {
    return previous;
  }
  const entry = { at: Date.now(), model: modelId, items: parsed.items, retryAfter: parsed.retryAfter };
  store.set(providerId, entry);
  emitter.fire({ providerId });
  return entry;
}

function recordItems(providerId, items) {
  const entry = { at: Date.now(), model: '', items, retryAfter: '' };
  store.set(providerId, entry);
  emitter.fire({ providerId });
  return entry;
}

// Per-model request ceilings learned from "request too large" errors: { "provider:model": tokens }
const modelCaps = new Map();

function setModelCap(providerId, modelId, tokens) {
  if (tokens > 0) modelCaps.set(`${providerId}:${modelId}`, tokens);
}

function getModelCap(providerId, modelId) {
  return modelCaps.get(`${providerId}:${modelId}`) || 0;
}

function get(providerId) {
  return store.get(providerId) || null;
}

// How long to wait before a request of about `tokens` tokens fits into the per-minute budget (0 = go now).
function waitFor(providerId, tokens) {
  const seen = store.get(providerId);
  if (!seen) return 0;
  const age = (Date.now() - seen.at) / 1000;
  let wait = 0;
  for (const item of seen.items) {
    if (item.remaining === null || item.resetSec === null || item.resetSec === undefined) continue;
    const left = item.resetSec - age;
    if (left <= 0 || left > 90) continue;
    const need = /^tokens(-minute)?$/.test(item.scope) ? tokens : /^requests(-minute)?$/.test(item.scope) ? 1 : 0;
    if (need && item.remaining < need) wait = Math.max(wait, left);
  }
  return wait;
}

module.exports = { setModelCap, getModelCap, waitFor, resetSeconds, parseHeaders, record, recordItems, get, onDidChange: emitter.event, formatReset };
