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

function isVisionModel(modelName) {
  if (!modelName) return false;
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

module.exports = { setCloudCaps, cloudCap, getCloudCaps: () => cloudCaps, isVisionModel, isCloudModelName, VISION_MODEL_HINTS };
