const vscode = require('vscode');

const PRESETS = {
  precise: { label: 'Precise (code)', description: 'Low randomness. Most reliable for code and tool calls', temperature: 0.2, top_p: 0.9, top_k: 40, repeat_penalty: 1.05 },
  balanced: { label: 'Balanced', description: 'Good for mixed work and conversation', temperature: 0.7, top_p: 0.9, top_k: 40, repeat_penalty: 1.1 },
  creative: { label: 'Creative', description: 'More varied wording and ideas, less predictable', temperature: 1.0, top_p: 0.95, top_k: 60, repeat_penalty: 1.1 }
};

function config() {
  return vscode.workspace.getConfiguration('localAI');
}

function currentMode() {
  const mode = config().get('responseMode');
  return PRESETS[mode] || mode === 'custom' ? mode : 'precise';
}

function numberOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function options() {
  const cfg = config();
  const mode = currentMode();
  const base = mode === 'custom'
    ? {
        temperature: numberOr(cfg.get('temperature'), 0.2),
        top_p: numberOr(cfg.get('topP'), 0.9),
        top_k: numberOr(cfg.get('topK'), 40),
        repeat_penalty: numberOr(cfg.get('repeatPenalty'), 1.05)
      }
    : { temperature: PRESETS[mode].temperature, top_p: PRESETS[mode].top_p, top_k: PRESETS[mode].top_k, repeat_penalty: PRESETS[mode].repeat_penalty };
  const gpu = numberOr(cfg.get('gpuLayers'), -1);
  if (gpu >= 0) base.num_gpu = gpu;
  return base;
}

function summary() {
  const cfg = config();
  const mode = currentMode();
  const opts = options();
  const ctx = numberOr(cfg.get('contextSize'), 16384);
  const gpu = numberOr(cfg.get('gpuLayers'), -1);
  return {
    mode,
    modeLabel: mode === 'custom' ? `Custom (temp ${opts.temperature})` : PRESETS[mode].label,
    contextSize: ctx,
    contextLabel: ctx >= 1024 ? `${Math.round(ctx / 1024)}K tokens` : `${ctx} tokens`,
    gpuLabel: gpu < 0 ? 'Auto' : gpu === 0 ? 'CPU only' : `${gpu} layers`,
    cloudContextLabel: (() => {
      const n = numberOr(cfg.get('cloudContextSize'), 12000);
      return `${Math.round(n / 1000)}K tokens`;
    })(),
    helperLabel: (() => {
      const h = String(cfg.get('subagentModel') || '').trim();
      return !h ? 'Same as chat' : h === 'auto' ? 'Auto (smallest installed)' : h;
    })()
  };
}

module.exports = { PRESETS, options, summary, currentMode };
