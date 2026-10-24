const MODEL_CATALOG = require('./catalog').models;

const VISION_MODEL_HINTS = [
  'llava',
  'bakllava',
  'llama3.2-vision',
  'llama-vision',
  'moondream',
  'qwen2-vl',
  'qwen2.5-vl',
  'qwen2.5vl',
  'qwen3-vl',
  'minicpm-v',
  'pixtral',
  'granite3.2-vision',
  'gemma3'
];

const isCatalogVision = (name) => MODEL_CATALOG.some((m) => m.category === 'vision' && m.name === name);

const CLOUD_VISION_HINTS = [
  'gemini', 'gpt-4o', 'gpt-4.1', 'gpt-4-turbo', 'gpt-5', 'llama-4', 'llama-3.2-11b', 'llama-3.2-90b', 'pixtral',
  'vision', '-vl', 'vl-', 'llava', 'scout', 'maverick', 'gemma-3', 'gemma3', 'mistral-small-3', 'mistral-small-latest',
  'mistral-medium', 'mistral-large-latest', 'claude', 'grok-4', 'qwen2.5-vl', 'internvl', 'molmo', 'minicpm-v'
];

// Facts the providers told us about their models: { "cloud:openrouter:x/y": { vision: true, tools: false } }
let cloudCaps = {};

function setCloudCaps(map) {
  cloudCaps = map && typeof map === 'object' ? map : {};
}

function cloudCap(modelName, key) {
  const entry = cloudCaps[modelName];
  return entry && typeof entry[key] === 'boolean' ? entry[key] : null;
}

// What Ollama reported for installed models: { "qwen3:8b": { capabilities: [...], contextLength } }
let localCaps = {};

function setLocalCaps(map) {
  localCaps = map && typeof map === 'object' ? map : {};
}

// true / false when Ollama told us, null when unknown (old Ollama or not checked yet).
function localCap(modelName, capability) {
  const entry = localCaps[modelName];
  return entry && Array.isArray(entry.capabilities) ? entry.capabilities.includes(capability) : null;
}

// true when the model can be told not to think (think:false); false for models that always think.
function canSwitchThinking(modelName) {
  const entry = localCaps[modelName];
  return !!(entry && entry.thinkingSwitch);
}

function localContextLength(modelName) {
  const entry = localCaps[modelName];
  return (entry && entry.contextLength) || 0;
}

// Asks Ollama once per model version what it can do; `save` stores the updated map.
async function learnLocal(client, modelName, save) {
  if (!modelName || isCloudModelName(modelName)) return;
  try {
    const installed = (await client.listLocalModels()).find((m) => m.name === modelName);
    if (!installed) return;
    const known = localCaps[modelName];
    if (known && known.digest === installed.digest && known.capsVersion === 2) return;
    const info = await client.showModel(modelName);
    if (!info) return;
    localCaps = { ...localCaps, [modelName]: { ...info, digest: installed.digest } };
    if (save) await save(localCaps);
  } catch (_) {
  }
}

function isVisionModel(modelName) {
  if (!modelName) return false;
  if (!String(modelName).startsWith('cloud:')) {
    const known = localCap(modelName, 'vision');
    if (known !== null) return known;
  }
  if (String(modelName).startsWith('cloud:')) {
    const known = cloudCap(modelName, 'vision');
    if (known !== null) return known;
    const lowerCloud = String(modelName).toLowerCase();
    return CLOUD_VISION_HINTS.some((hint) => lowerCloud.includes(hint));
  }
  if (isCatalogVision(modelName)) return true;

  const lower = modelName.toLowerCase();
  return VISION_MODEL_HINTS.some((hint) => lower.includes(hint));
}

function isCloudModelName(modelName) {
  return String(modelName || '').startsWith('cloud:');
}

module.exports = { setCloudCaps, cloudCap, getCloudCaps: () => cloudCaps, setLocalCaps, getLocalCaps: () => localCaps, learnLocal, localCap, localContextLength, canSwitchThinking, isVisionModel, isCloudModelName, VISION_MODEL_HINTS };
