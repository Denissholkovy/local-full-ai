// How the AI works on a request, chosen from what the model can carry:
// - direct:   one pass. The model sees the relevant files and returns complete files. For small or slow models:
//             a tool loop only multiplies their mistakes and their waiting time.
// - standard: tool loop with a short plan, no helper agents. For mid-size models.
// - agent:    full tool loop with helper agents for big jobs. For strong and fast models.
const MODES = ['direct', 'standard', 'agent'];

const LABELS = {
  direct: 'Fast',
  standard: 'Standard',
  agent: 'Agent'
};

const SMALL_B = 4.5;
const STRONG_B = 14;
const SLOW_TPS = 6;
const FAST_TPS = 15;

function billions(modelName, parameterSize) {
  const fromDetails = String(parameterSize || '').match(/(\d+(?:\.\d+)?)\s*B/i);
  if (fromDetails) return Number(fromDetails[1]);
  const fromName = String(modelName || '').match(/(?:^|[:\-_/])(\d+(?:\.\d+)?)b(?:$|[-_:.])/i);
  return fromName ? Number(fromName[1]) : 0;
}

// facts: { setting, cloud, localServer, rank, compact, nativeTools, size (billions, 0 = unknown), tokensPerSec (0 = unknown) }
function decide(facts) {
  if (MODES.includes(facts.setting)) {
    return facts.setting !== 'direct' && !facts.nativeTools ? 'direct' : facts.setting;
  }
  if (!facts.nativeTools) return 'direct';
  if (facts.cloud && !facts.localServer) {
    if (facts.rank === 'weak' || facts.compact) return 'standard';
    return 'agent';
  }
  const size = facts.size || 0;
  const speed = facts.tokensPerSec || 0;
  if ((size && size <= SMALL_B) || (speed && speed < SLOW_TPS)) return 'direct';
  if (size >= STRONG_B && (!speed || speed >= FAST_TPS)) return 'agent';
  return 'standard';
}

function why(mode, facts) {
  if (MODES.includes(facts.setting)) return 'chosen in Settings';
  if (!facts.nativeTools) return 'the model cannot use tools';
  if (facts.cloud && !facts.localServer) return mode === 'agent' ? 'strong cloud model' : 'small cloud model or small free limit';
  const parts = [];
  if (facts.size) parts.push(`${facts.size}B`);
  if (facts.tokensPerSec) parts.push(`${facts.tokensPerSec.toFixed(0)} tokens/s`);
  return parts.join(', ') || 'unknown size';
}

module.exports = { MODES, LABELS, decide, why, billions, SMALL_B, STRONG_B, SLOW_TPS, FAST_TPS };
