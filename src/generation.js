const vscode = require('vscode');

function config() {
  return vscode.workspace.getConfiguration('localAI');
}

function numberOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

// Sampling is left to the model: Ollama models ship the values their makers recommend, and thinking models break
// with a low temperature (Qwen warns against it).
function options() {
  return {};
}

const THINKING = {
  auto: 'Auto (small models answer directly)',
  fast: 'Fast (little thinking)',
  deep: 'Deep (think longer)'
};

function thinkingMode() {
  const mode = config().get('thinking');
  return THINKING[mode] ? mode : 'auto';
}

function billions(modelName) {
  const m = String(modelName || '').match(/(?:^|[:\-_])(\d+(?:\.\d+)?)b(?:$|[-_:.])/i);
  return m ? Number(m[1]) : 0;
}

// Value for Ollama's "think" field, or undefined to leave the model's default. GPT-OSS only knows levels.
// Only models that can switch thinking off get false; the others always think and are kept short by thinkBudget.
function think(modelName, canSwitch) {
  const mode = thinkingMode();
  const gptOss = /gpt-oss/i.test(String(modelName));
  if (mode === 'deep') return gptOss ? 'high' : true;
  const wantsFast = mode === 'fast' || (billions(modelName) > 0 && billions(modelName) < 13);
  if (!wantsFast) return undefined;
  if (gptOss) return 'low';
  return canSwitch ? false : undefined;
}

// How much thinking (in characters, about 4 per token) before the model is told to answer. 0 = no limit.
// It follows the request: a question needs little, a correction some, a new feature the most.
// "plan" is the thinking before a feature built in steps; each "step" (one file) then needs little more.
const BUDGETS = {
  small: { question: 1500, edit: 3000, new: 12000, rewrite: 12000, plan: 6000, step: 2500 },
  big: { question: 4000, edit: 8000, new: 24000, rewrite: 24000, plan: 16000, step: 6000 }
};

function thinkBudget(modelName, kind = 'edit') {
  const mode = thinkingMode();
  if (mode === 'deep') return 0;
  if (mode === 'fast') return 1500;
  const size = billions(modelName);
  const table = size > 0 && size < 13 ? BUDGETS.small : BUDGETS.big;
  return table[kind] || table.edit;
}

// Models without a thinking phase write more exact code with little randomness; thinking models keep their own
// settings (a low temperature makes them loop).
function samplingFor(thinks) {
  return thinks === false ? { temperature: 0.2, top_p: 0.9 } : {};
}

function summary() {
  const cfg = config();
  const ctx = numberOr(cfg.get('contextSize'), 16384);
  return {
    contextSize: ctx,
    contextLabel: ctx >= 1024 ? `${Math.round(ctx / 1024)}K tokens` : `${ctx} tokens`,
    thinkingLabel: THINKING[thinkingMode()],
    agentModeLabel: ({ auto: 'Auto', direct: 'Fast', standard: 'Standard', agent: 'Agent' })[String(cfg.get('agentMode') || 'auto')] || 'Auto',
    reviewerLabel: String(cfg.get('reviewerModel') || '').trim().replace(/^cloud:[^:]+:/, '') || 'Same as chat'
  };
}

module.exports = { THINKING, options, summary, thinkingMode, think, thinkBudget, samplingFor };
