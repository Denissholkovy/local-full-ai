const os = require('os');
const { execFileSync } = require('child_process');

const GB = 1024 * 1024 * 1024;
const OVERHEAD_GB = 0.7;
const KV_GB_PER_16K_PER_7B = 1.0;

let cached = null;

function nvidiaVram() {
  try {
    const out = execFileSync('nvidia-smi', ['--query-gpu=memory.total', '--format=csv,noheader,nounits'], { timeout: 2500, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
      .split('\n')
      .map((n) => Number(n))
      .filter((n) => n > 0);
    return out.length ? Math.max(...out) / 1024 : 0;
  } catch (_) {
    return 0;
  }
}

function info() {
  if (cached) return cached;
  const ramGB = os.totalmem() / GB;
  const cpu = (os.cpus()[0] && os.cpus()[0].model ? os.cpus()[0].model : 'CPU').replace(/\(R\)|\(TM\)|CPU|@.*$/g, '').replace(/\s+/g, ' ').trim();
  const appleSilicon = process.platform === 'darwin' && process.arch === 'arm64';
  const vramGB = appleSilicon ? 0 : nvidiaVram();

  let kind;
  let fastBudgetGB;
  if (appleSilicon) {
    kind = 'unified';
    fastBudgetGB = ramGB * (ramGB <= 36 ? 0.66 : 0.75);
  } else if (vramGB > 0) {
    kind = 'gpu';
    fastBudgetGB = vramGB * 0.92;
  } else {
    kind = 'cpu';
    fastBudgetGB = ramGB * 0.6;
  }
  const slowBudgetGB =
    kind === 'unified' ? Math.max(ramGB * 0.65, ramGB - 4) : kind === 'gpu' ? fastBudgetGB + ramGB * 0.5 : Math.max(ramGB * 0.65, ramGB - 3);

  cached = {
    ramGB,
    vramGB,
    kind,
    chip: cpu,
    fastBudgetGB,
    slowBudgetGB,
    label:
      kind === 'unified'
        ? `${cpu}, ${Math.round(ramGB)} GB unified memory`
        : kind === 'gpu'
          ? `${Math.round(vramGB)} GB video memory, ${Math.round(ramGB)} GB RAM`
          : `${Math.round(ramGB)} GB RAM, no dedicated GPU found (CPU only, slower)`
  };
  return cached;
}

function paramsBillions(modelName) {
  const m = String(modelName || '').match(/(\d+(?:\.\d+)?)b\b/i);
  return m ? Number(m[1]) : 7;
}

function assess(sizeGB, modelName, contextTokens) {
  const hw = info();
  if (!sizeGB) return { level: 'unknown', needGB: 0, budgetGB: hw.fastBudgetGB };
  const kv = KV_GB_PER_16K_PER_7B * (paramsBillions(modelName) / 7) * ((contextTokens || 16384) / 16384);
  const needGB = sizeGB + kv + OVERHEAD_GB;
  const fast = hw.fastBudgetGB;
  let level;
  if (needGB <= fast * 0.6) level = 'great';
  else if (needGB <= fast * 0.85) level = 'ok';
  else if (needGB <= fast) level = 'tight';
  else if (needGB <= hw.slowBudgetGB) level = 'slow';
  else level = 'heavy';
  return { level, needGB, budgetGB: fast };
}

const LEVEL_TEXT = {
  great: 'runs comfortably on your computer',
  ok: 'fits your computer well',
  tight: 'tight: it fits, but little memory is left',
  slow: 'will partly run on the CPU and be slow',
  heavy: 'too heavy for this computer',
  unknown: ''
};

function qualityRank(quant) {
  const q = String(quant || '').toLowerCase();
  if (/fp16|bf16|f16/.test(q)) return 9;
  if (/q8/.test(q)) return 8;
  if (/q6/.test(q)) return 7;
  if (/q5/.test(q)) return 6;
  if (/q4|qat|mxfp4|default/.test(q)) return 5;
  if (/q3/.test(q)) return 3;
  if (/q2/.test(q)) return 1;
  return 4;
}

function bestVariant(variants, contextTokens) {
  let best = null;
  for (const v of variants) {
    const a = assess(v.sizeGB, v.name, contextTokens);
    if (!['great', 'ok'].includes(a.level) || qualityRank(v.quant) < 5) continue;
    if (!best || v.sizeGB > best.v.sizeGB) best = { v, a };
  }
  return best ? best.v : null;
}

function comfortableModelGB(contextTokens) {
  const hw = info();
  const kv = KV_GB_PER_16K_PER_7B * ((contextTokens || 16384) / 16384);
  return Math.max(0, hw.fastBudgetGB * 0.85 - kv - OVERHEAD_GB);
}

module.exports = { info, assess, bestVariant, qualityRank, comfortableModelGB, LEVEL_TEXT };
