const BUNDLED = require('./models.json');
const BUNDLED_CLOUD = require('./ollamaCloud.json');

// Recommended local models. Starts with the list shipped in the extension and is refreshed once a day
// from the project repository, so new models can be recommended without publishing a new version.
const REMOTE_BASE = 'https://raw.githubusercontent.com/Denissholkovy/local-full-ai/main/src/';
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CATEGORIES = new Set(['code', 'general', 'vision']);

const models = BUNDLED.slice();
// Ollama Cloud models live in their own file: older versions of the extension read models.json and
// would offer them as local models, without the notice that the prompts leave the computer.
const cloudModels = BUNDLED_CLOUD.slice();

function validEntry(m) {
  return m && typeof m.name === 'string' && /^[\w.:\/-]{1,120}$/.test(m.name) &&
    typeof m.label === 'string' && m.label.length <= 80 &&
    CATEGORIES.has(m.category) &&
    (m.tags === undefined || (Array.isArray(m.tags) && m.tags.every((t) => typeof t === 'string'))) &&
    (m.description === undefined || (typeof m.description === 'string' && m.description.length <= 300));
}

function valid(list) {
  return Array.isArray(list) && list.length >= 3 && list.length <= 200 &&
    list.every((m) => validEntry(m) && typeof m.sizeGB === 'number' && m.sizeGB > 0 && m.sizeGB < 1000);
}

function validCloud(list) {
  return Array.isArray(list) && list.length >= 1 && list.length <= 100 &&
    list.every((m) => validEntry(m) && /:([\w.-]+-)?cloud$/.test(m.name));
}

async function refreshList(context, { target, file, cacheKey, check }) {
  const cached = context.globalState.get(cacheKey);
  if (cached && check(cached.models)) target.splice(0, target.length, ...cached.models);
  if (cached && Date.now() - cached.at < MAX_AGE_MS) return check(cached.models);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(REMOTE_BASE + file, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return false;
    const list = await res.json();
    if (!check(list)) return false;
    await context.globalState.update(cacheKey, { at: Date.now(), models: list });
    const changed = JSON.stringify(list) !== JSON.stringify(target);
    target.splice(0, target.length, ...list);
    return changed;
  } catch (_) {
    return false;
  }
}

// Returns true when a list changed.
async function refresh(context) {
  const results = await Promise.all([
    refreshList(context, { target: models, file: 'models.json', cacheKey: 'localAI.remoteCatalog', check: valid }),
    refreshList(context, { target: cloudModels, file: 'ollamaCloud.json', cacheKey: 'localAI.remoteCloudCatalog', check: validCloud })
  ]);
  return results.some(Boolean);
}

module.exports = { models, cloudModels, refresh, valid, validCloud };
