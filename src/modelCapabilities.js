const MODEL_CATALOG = require('./models.json');

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

const CATALOG_VISION_NAMES = new Set(
  MODEL_CATALOG.filter((m) => m.category === 'vision').map((m) => m.name)
);

function isVisionModel(modelName) {
  if (!modelName) return false;
  if (CATALOG_VISION_NAMES.has(modelName)) return true;

  const lower = modelName.toLowerCase();
  return VISION_MODEL_HINTS.some((hint) => lower.includes(hint));
}

module.exports = { isVisionModel, VISION_MODEL_HINTS };
