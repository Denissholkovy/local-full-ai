const PREFIX = 'cloud:';

const PROVIDERS = [
  {
    id: 'groq',
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    keyUrl: 'https://console.groq.com/keys',
    limitsUrl: 'https://console.groq.com/settings/limits',
    note: 'Very fast. Free tier with per-minute and per-day limits, no card needed.',
    dataNote: 'Check Groq\'s data policy for the free tier.'
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyUrl: 'https://openrouter.ai/keys',
    limitsUrl: 'https://openrouter.ai/docs/api-reference/limits',
    note: 'Many models; the ones ending in ":free" cost nothing. Free models are strictly rate limited and the list changes.',
    dataNote: 'Free models are served by third parties that may log or train on prompts.',
    onlyFree: true
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyUrl: 'https://aistudio.google.com/apikey',
    limitsUrl: 'https://ai.google.dev/gemini-api/docs/rate-limits',
    note: 'Strong models with a free tier (limits depend on the model and your project).',
    dataNote: 'On the free tier Google may use prompts to improve its products (not in the EEA, UK and Switzerland).'
  },
  {
    id: 'mistral',
    name: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    keyUrl: 'https://console.mistral.ai/api-keys',
    limitsUrl: 'https://docs.mistral.ai/deployment/laplateforme/tier/',
    note: 'Free "Experiment" plan with monthly limits.',
    dataNote: 'On the free plan prompts may be used for training unless you opt out.'
  },
  {
    id: 'cerebras',
    name: 'Cerebras',
    baseUrl: 'https://api.cerebras.ai/v1',
    keyUrl: 'https://cloud.cerebras.ai/',
    limitsUrl: 'https://inference-docs.cerebras.ai/support/rate-limits',
    note: 'Extremely fast. Free access has changed over time, so check the dashboard.',
    dataNote: 'Check Cerebras\' data policy.'
  },
  {
    id: 'custom',
    name: 'Other (OpenAI-compatible)',
    baseUrl: '',
    keyUrl: '',
    limitsUrl: '',
    note: 'Any service with an OpenAI-compatible /v1/chat/completions endpoint.',
    dataNote: 'Your messages go to the address you enter.'
  }
];

const NON_CHAT = /(whisper|embed|tts|speech|guard|safeguard|moderation|rerank|transcri|dall-e|imagen|image-gen|audio|ocr|orpheus|playai|arabic|allam|veo|lyria|aqa|robotics|live|native-audio|-image|image-preview|learnlm|bidi|realtime|dictation|computer-use|deep-research|codestral-embed|saba)/i;

// Models that are good at coding and tool use, and models that are too small for agent work.
const BEST = /(gpt-oss-120b|llama-3\.3-70b|llama-4|qwen3-coder|qwen3-(235|32)b|qwen-3-(235|32)b|kimi-k2|gemini-(2\.5|3)|gemini-2\.0-flash$|mistral-(large|medium)|codestral|devstral|deepseek-(v3|r1|chat)|glm-4|minimax|compound|llama-3\.1-405b|gpt-4|gpt-5|claude)/i;
const WEAK = /(\b[1-8]b\b|-[1-8]b-|-(1|3|7|8)b$|instant|nano|tiny|mini|lite|small|e2b|e4b)/i;

function rank(id) {
  const size = String(id).match(/(?:^|[-_/.])(\d{1,3})b(?:$|[-_.:])/i);
  const billions = size ? Number(size[1]) : 0;
  if (/qwen/i.test(id) && billions >= 27) return 'best';
  if (BEST.test(id) && !/-[1-8]b\b/i.test(id)) return 'best';
  if (WEAK.test(id)) return 'weak';
  return 'ok';
}

function isCloudModel(name) {
  return typeof name === 'string' && name.startsWith(PREFIX);
}

function makeName(providerId, modelId) {
  return `${PREFIX}${providerId}:${modelId}`;
}

function parseName(name) {
  if (!isCloudModel(name)) return null;
  const rest = name.slice(PREFIX.length);
  const idx = rest.indexOf(':');
  if (idx === -1) return null;
  return { providerId: rest.slice(0, idx), modelId: rest.slice(idx + 1) };
}

function provider(id) {
  return PROVIDERS.find((p) => p.id === id) || null;
}

function cleanModelId(provider, id) {
  return String(id || '').replace(/^models\//, '');
}

function filterModels(providerDef, ids) {
  let list = ids.map((id) => cleanModelId(providerDef, id)).filter((id) => id && !NON_CHAT.test(id));
  if (providerDef && providerDef.onlyFree) list = list.filter((id) => /:free$/.test(id));
  const sorted = [...new Set(list)];
  // Gemini: newest version first, because Google retires old models for new accounts.
  return providerDef && providerDef.id === 'gemini'
    ? sorted.sort((a, b) => b.localeCompare(a, 'en', { numeric: true }))
    : sorted.sort((a, b) => a.localeCompare(b));
}

module.exports = { rank, PREFIX, PROVIDERS, isCloudModel, makeName, parseName, provider, filterModels };
