const BUNDLED = require('./models.json');

// Recommended local models. Starts with the list shipped in the extension and is refreshed once a day
// from the project repository, so new models can be recommended without publishing a new version.
const REMOTE_URL = 'https://raw.githubusercontent.com/Denissholkovy/local-full-ai/main/src/models.json';
const CACHE_KEY = 'localAI.remoteCatalog';
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CATEGORIES = new Set(['code', 'general', 'vision']);

const models = BUNDLED.slice();

function valid(list) {
  return Array.isArray(list) && list.length >= 3 && list.length <= 200 && list.every((m) =>
    m && typeof m.name === 'string' && /^[\w.:\/-]{1,120}$/.test(m.name) &&
    typeof m.label === 'string' && m.label.length <= 80 &&
    CATEGORIES.has(m.category) &&
    typeof m.sizeGB === 'number' && m.sizeGB > 0 && m.sizeGB < 1000 &&
    (m.tags === undefined || (Array.isArray(m.tags) && m.tags.every((t) => typeof t === 'string'))) &&
    (m.description === undefined || (typeof m.description === 'string' && m.description.length <= 300))
  );
}

function use(list) {
  models.splice(0, models.length, ...list);
}

// Returns true when the list changed.
async function refresh(context) {
  const cached = context.globalState.get(CACHE_KEY);
  if (cached && valid(cached.models)) use(cached.models);
  if (cached && Date.now() - cached.at < MAX_AGE_MS) return !!cached;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(REMOTE_URL, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return false;
    const list = await res.json();
    if (!valid(list)) return false;
    await context.globalState.update(CACHE_KEY, { at: Date.now(), models: list });
    const changed = JSON.stringify(list) !== JSON.stringify(models);
    use(list);
    return changed;
  } catch (_) {
    return false;
  }
}

module.exports = { models, refresh, valid };
