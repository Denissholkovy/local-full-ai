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
    id: 'huggingface',
    name: 'Hugging Face',
    baseUrl: 'https://router.huggingface.co/v1',
    keyUrl: 'https://huggingface.co/settings/tokens/new?ownUserPermissions=inference.serverless.write&tokenType=fineGrained',
    limitsUrl: 'https://huggingface.co/settings/billing',
    note: 'Hundreds of open models from many hosts behind one token. Pay as you go with small monthly included credits.',
    dataNote: 'Requests are passed on to third-party inference providers; check their policies.'
  },
  {
    id: 'nvidia',
    name: 'NVIDIA',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    keyUrl: 'https://build.nvidia.com/',
    limitsUrl: 'https://build.nvidia.com/',
    note: 'Large open models hosted by NVIDIA, with free developer access for trying them out.',
    dataNote: 'Check NVIDIA\'s terms for the trial API.'
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    limitsUrl: 'https://platform.deepseek.com/usage',
    note: 'Strong and cheap coding models. Paid: needs a small top-up.',
    dataNote: 'DeepSeek stores data on servers in China.',
    paid: true
  },
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    keyUrl: 'https://platform.openai.com/api-keys',
    limitsUrl: 'https://platform.openai.com/settings/organization/limits',
    note: 'GPT models. Paid per token.',
    dataNote: 'OpenAI does not train on API data by default.',
    paid: true
  },
  {
    id: 'anthropic',
    name: 'Anthropic (Claude)',
    baseUrl: 'https://api.anthropic.com/v1',
    keyUrl: 'https://platform.claude.com/settings/keys',
    limitsUrl: 'https://platform.claude.com/docs/en/api/rate-limits',
    note: 'Claude models, very strong at code and agent work. Paid per token.',
    dataNote: 'Anthropic does not train on API data by default.',
    paid: true,
    // Newer Claude models reject a temperature below 1 and temperature together with top_p.
    noSampling: true
  },
  {
    id: 'custom',
    name: 'Other (OpenAI-compatible)',
    baseUrl: '',
    keyUrl: '',
    limitsUrl: '',
    note: 'Any OpenAI-compatible /v1/chat/completions server: LM Studio, llama.cpp, vLLM, Jan or a paid API. Add as many as you like; the key is optional.',
    dataNote: 'Your messages go to the address you enter.'
  }
];

// Ready-made addresses of servers that run on this computer and need no key.
const SERVER_PRESETS = [
  { name: 'LM Studio', baseUrl: 'http://localhost:1234/v1' },
  { name: 'llama.cpp server', baseUrl: 'http://localhost:8080/v1' },
  { name: 'Jan', baseUrl: 'http://localhost:1337/v1' },
  { name: 'vLLM', baseUrl: 'http://localhost:8000/v1' }
];

const LOOPBACK = /^https?:\/\/(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0)(:\d+)?(\/|$)/i;

function isLoopback(url) {
  return LOOPBACK.test(String(url || ''));
}

// Servers the user added: [{ id: "custom-…", name, baseUrl }].
let servers = [];

function setServers(list) {
  servers = (Array.isArray(list) ? list : []).filter((s) => s && /^custom-[\w-]+$/.test(s.id) && s.baseUrl);
}

function serverDef(s) {
  const local = isLoopback(s.baseUrl);
  return {
    id: s.id,
    name: s.name,
    baseUrl: s.baseUrl,
    keyUrl: '',
    limitsUrl: '',
    note: `${s.baseUrl}${local ? ' (on this computer)' : ''}`,
    dataNote: local ? 'The server runs on this computer.' : `Your messages go to ${s.baseUrl}.`,
    server: true,
    local
  };
}

function allProviders() {
  return [...PROVIDERS, ...servers.map(serverDef)];
}

function newServerId(name) {
  const slug = String(name || 'server').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'server';
  let id = `custom-${slug}`;
  for (let n = 2; servers.some((s) => s.id === id); n++) id = `custom-${slug}-${n}`;
  return id;
}

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

// Models such as "glm-5.3:cloud" run through the local Ollama but on ollama.com's servers.
function isOllamaCloud(name) {
  return typeof name === 'string' && !isCloudModel(name) && /:([\w.-]+-)?cloud$/i.test(name);
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
  return allProviders().find((p) => p.id === id) || null;
}

function isLocalServer(name) {
  const parsed = parseName(name);
  const def = parsed && provider(parsed.providerId);
  return !!(def && def.local);
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

module.exports = { rank, PREFIX, PROVIDERS, SERVER_PRESETS, isCloudModel, isOllamaCloud, makeName, parseName, provider, filterModels, allProviders, setServers, getServers: () => servers.slice(), newServerId, isLoopback, isLocalServer };
