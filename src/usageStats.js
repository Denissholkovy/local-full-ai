// Tokens and speed per model and day, kept for a month: { "2026-10-23": { "qwen3:8b": { requests, prompt, output, seconds } } }
const KEY = 'localAI.usageStats';
const KEEP_DAYS = 30;

function dayOf(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Kept in memory as well: several answers can finish before globalState has saved the previous one.
const cache = new WeakMap();

function load(context) {
  if (!cache.has(context)) cache.set(context, { ...context.globalState.get(KEY, {}) });
  return cache.get(context);
}

function record(context, modelName, stats, now = Date.now()) {
  if (!modelName || !stats) return;
  const all = load(context);
  const day = dayOf(now);
  const models = { ...(all[day] || {}) };
  const entry = { requests: 0, prompt: 0, output: 0, seconds: 0, ...(models[modelName] || {}) };
  entry.requests += 1;
  entry.prompt += stats.promptEvalCount || 0;
  entry.output += stats.evalCount || 0;
  entry.seconds += (stats.evalDuration || 0) / 1e9;
  models[modelName] = entry;
  all[day] = models;
  const oldest = dayOf(now - KEEP_DAYS * 24 * 3600 * 1000);
  Object.keys(all).forEach((d) => {
    if (d < oldest) delete all[d];
  });
  Promise.resolve(context.globalState.update(KEY, { ...all })).catch(() => {});
}

// Totals per model over the last `days` days, biggest first.
function summary(context, days, now = Date.now()) {
  const all = load(context);
  const from = dayOf(now - (days - 1) * 24 * 3600 * 1000);
  const totals = new Map();
  Object.entries(all).forEach(([day, models]) => {
    if (day < from) return;
    Object.entries(models).forEach(([model, e]) => {
      const t = totals.get(model) || { model, requests: 0, prompt: 0, output: 0, seconds: 0 };
      t.requests += e.requests;
      t.prompt += e.prompt;
      t.output += e.output;
      t.seconds += e.seconds;
      totals.set(model, t);
    });
  });
  return [...totals.values()]
    .map((t) => ({ ...t, tokensPerSec: t.seconds > 0 ? t.output / t.seconds : 0 }))
    .sort((a, b) => b.prompt + b.output - (a.prompt + a.output));
}

module.exports = { record, summary, dayOf };
