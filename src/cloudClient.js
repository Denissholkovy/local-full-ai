const { parseName, provider, setServers } = require('./cloudProviders');
const limits = require('./cloudLimits');
const capabilities = require('./modelCapabilities');
const loopGuard = require('./loopGuard');

const MAX_RETRIES = 5;
const MAX_WAIT_S = 60;
const IDLE_TIMEOUT_MS = 90000;

function lenientJson(text) {
  try {
    return JSON.parse(text);
  } catch (_) {
    return {};
  }
}

function keyOptional(providerId) {
  const def = provider(providerId);
  return !!(def && def.server);
}

function authHeaders(key) {
  return key ? { Authorization: `Bearer ${key}` } : {};
}

function isJson(text) {
  try {
    JSON.parse(text);
    return true;
  } catch (_) {
    return false;
  }
}

function imageMime(b64) {
  const head = String(b64 || '').slice(0, 12);
  if (head.startsWith('/9j/')) return 'image/jpeg';
  if (head.startsWith('iVBOR')) return 'image/png';
  if (head.startsWith('R0lG')) return 'image/gif';
  if (head.startsWith('UklG')) return 'image/webp';
  if (head.startsWith('Qk')) return 'image/bmp';
  return 'image/png';
}

function toOpenAIMessages(messages, providerId) {
  const out = [];
  // Pictures are large: send them only with the latest message that has any.
  let lastImageIdx = -1;
  messages.forEach((m, i) => { if (m.role === 'user' && Array.isArray(m.images) && m.images.length) lastImageIdx = i; });
  let counter = 0;
  let pending = [];
  for (let mi = 0; mi < messages.length; mi++) {
    const m = messages[mi];
    if (m.role === 'system') {
      out.push({ role: 'system', content: m.content });
    } else if (m.role === 'user') {
      if (Array.isArray(m.images) && m.images.length && mi !== lastImageIdx) {
        out.push({ role: 'user', content: (m.content || '') + '\n[' + m.images.length + ' image(s) attached earlier, not re-sent]' });
      } else if (Array.isArray(m.images) && m.images.length) {
        out.push({
          role: 'user',
          content: [
            { type: 'text', text: m.content || '' },
            ...m.images.map((b64) => ({ type: 'image_url', image_url: { url: `data:${imageMime(b64)};base64,${b64}` } }))
          ]
        });
      } else {
        out.push({ role: 'user', content: m.content || '' });
      }
    } else if (m.role === 'assistant') {
      const msg = { role: 'assistant', content: m.content || '' };
      pending = [];
      if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
        msg.tool_calls = m.tool_calls.map((tc) => {
          const id = `call_${++counter}`;
          pending.push(id);
          const args = tc.function && tc.function.arguments;
          // Gemini 3 needs its "thought signature" echoed back with every tool call it made.
          const extra = tc.extra_content || (providerId === 'gemini' ? { google: { thought_signature: 'skip_thought_signature_validator' } } : null);
          return {
            id,
            type: 'function',
            ...(extra ? { extra_content: extra } : {}),
            function: {
              name: (tc.function && tc.function.name) || 'unknown',
              arguments: typeof args === 'string' ? args : JSON.stringify(args || {})
            }
          };
        });
      }
      out.push(msg);
    } else if (m.role === 'tool') {
      const id = pending.shift();
      if (id) out.push({ role: 'tool', tool_call_id: id, content: m.content || '' });
      else out.push({ role: 'user', content: `Result of ${m.tool_name || 'a tool'}:\n${m.content || ''}` });
    }
  }
  return out;
}

class CloudClient {
  constructor(context) {
    this._context = context;
    setServers(context.globalState.get('localAI.customServers', []));
    capabilities.setCloudCaps(context.globalState.get('localAI.cloudCaps', {}));
    limits.loadModelCaps(context.globalState.get('localAI.cloudModelCaps', {}));
  }

  async _key(providerId) {
    return (await this._context.secrets.get(`localAI.key.${providerId}`)) || '';
  }

  async credentials(providerId) {
    return { key: await this._key(providerId), baseUrl: await this._baseUrl(providerId) };
  }

  async _baseUrl(providerId) {
    const def = provider(providerId);
    if (providerId === 'custom') {
      return (this._context.globalState.get('localAI.cloudCustomUrl') || '').replace(/\/+$/, '');
    }
    return def ? def.baseUrl : '';
  }

  async listModels(providerId) {
    const key = await this._key(providerId);
    const base = await this._baseUrl(providerId);
    if (!key && !keyOptional(providerId)) throw new Error('No API key saved for this provider.');
    if (!base) throw new Error('No address set for this provider.');
    if (providerId === 'anthropic') {
      // Anthropic lists its models only through its own API, with its own key header.
      const res = await fetch('https://api.anthropic.com/v1/models?limit=1000', { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } });
      if (res.status === 401 || res.status === 403) throw new Error('The provider rejected the API key.');
      if (!res.ok) throw new Error(`The provider answered ${res.status}.`);
      const data = await res.json();
      return (data.data || []).map((m) => m.id).filter(Boolean);
    }
    if (providerId === 'gemini') {
      // The native list says which models can chat (generateContent); the OpenAI-style list does not.
      try {
        const native = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000', { headers: { 'x-goog-api-key': key } });
        if (native.ok) {
          const data = await native.json();
          const chat = (data.models || []).filter((m) => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'));
          if (chat.length) return chat.map((m) => m.name);
        }
      } catch (_) {
      }
    }
    const res = await fetch(`${base}/models`, { headers: authHeaders(key) });
    if (res.status === 401 || res.status === 403) throw new Error('The provider rejected the API key.');
    if (!res.ok) throw new Error(`The provider answered ${res.status}.`);
    const data = await res.json();
    const list = Array.isArray(data) ? data : data.data || data.models || [];
    this._learnCapabilities(providerId, list);
    return list.map((m) => (typeof m === 'string' ? m : m.id || m.name)).filter(Boolean);
  }

  // Some providers (OpenRouter) say which models see images and call tools: remember it instead of guessing from names.
  _learnCapabilities(providerId, list) {
    const known = { ...capabilities.getCloudCaps() };
    let changed = false;
    list.forEach((m) => {
      if (!m || typeof m !== 'object' || !m.id) return;
      const entry = {};
      const modalities = m.architecture && m.architecture.input_modalities;
      if (Array.isArray(modalities)) entry.vision = modalities.includes('image');
      if (Array.isArray(m.supported_parameters)) entry.tools = m.supported_parameters.includes('tools');
      if (!Object.keys(entry).length) return;
      known[`cloud:${providerId}:${m.id}`] = entry;
      changed = true;
    });
    if (changed) {
      capabilities.setCloudCaps(known);
      Promise.resolve(this._context.globalState.update('localAI.cloudCaps', known)).catch(() => {});
    }
  }

  // Sends one tiny request to find out whether a model really answers for this key.
  async testModel(fullName) {
    try {
      const r = await this.chatStream(fullName, [{ role: 'user', content: 'Reply with the single word OK.' }], () => {}, { maxTokens: 16, quick: true });
      return { ok: true, content: r.content };
    } catch (err) {
      const msg = String(err.message || err);
      return { ok: false, busy: /overloaded|busy|high demand|limit is used up|limit reached/i.test(msg), error: msg };
    }
  }

  async accountInfo(providerId) {
    if (providerId !== 'openrouter') return null;
    const key = await this._key(providerId);
    const base = await this._baseUrl(providerId);
    if (!key) throw new Error('No API key saved for this provider.');
    const res = await fetch(`${base}/key`, { headers: { Authorization: `Bearer ${key}` } });
    if (res.status === 401 || res.status === 403) throw new Error('The provider rejected the API key.');
    if (!res.ok) throw new Error(`The provider answered ${res.status}.`);
    const data = (await res.json()).data || {};
    const items = [];
    if (data.limit_remaining !== undefined && data.limit_remaining !== null) {
      items.push({ scope: 'credits', label: 'Credit left (USD)', limit: data.limit === null ? null : Number(data.limit), remaining: Number(data.limit_remaining), reset: '' });
    }
    if (data.usage !== undefined) items.push({ scope: 'usage', label: 'Spent so far (USD)', limit: null, remaining: Number(data.usage), reset: '' });
    if (data.rate_limit && data.rate_limit.requests) {
      items.push({ scope: 'rate', label: `Rate limit (${data.rate_limit.interval || 'interval'})`, limit: Number(data.rate_limit.requests), remaining: null, reset: '' });
    }
    if (data.is_free_tier !== undefined) {
      items.push({ scope: 'tier', label: data.is_free_tier ? 'Free tier: about 50 free-model requests per day' : 'Paid account: higher free-model limit', limit: null, remaining: null, reset: '' });
    }
    return limits.recordItems(providerId, items);
  }

  async chatStream(fullName, messages, onToken, options = {}) {
    const parsed = parseName(fullName);
    if (!parsed) throw new Error(`"${fullName}" is not a cloud model.`);
    const { onAbortReady, onStats, onThinking, tools, generation, onNotice, onLimits, maxTokens, quick, failFast } = options;
    const key = await this._key(parsed.providerId);
    const base = await this._baseUrl(parsed.providerId);
    if (!key && !keyOptional(parsed.providerId)) throw new Error(`No API key for ${provider(parsed.providerId).name}. Add it in the sidebar under Cloud models.`);
    if (!base) throw new Error('No address set for this provider.');

    const body = {
      model: parsed.modelId,
      messages: toOpenAIMessages(messages, parsed.providerId),
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: maxTokens || 4096
    };
    if (generation && !(provider(parsed.providerId) || {}).noSampling) {
      if (generation.temperature !== undefined) body.temperature = generation.temperature;
      if (generation.top_p !== undefined) body.top_p = generation.top_p;
    }
    if (Array.isArray(tools) && tools.length) body.tools = tools;

    const controller = new AbortController();
    let aborted = false;
    if (onAbortReady) {
      onAbortReady(() => {
        aborted = true;
        controller.abort();
      });
    }
    // Only silence counts as a timeout: waiting for limits or retries does not, and every chunk resets it.
    let timer = null;
    let timedOut = false;
    const idle = {
      arm: () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, IDLE_TIMEOUT_MS);
      },
      pause: () => clearTimeout(timer)
    };

    // Look at the provider's remaining per-minute budget and wait for the reset instead of running into a 429.
    if (!quick) {
      const estimate = Math.ceil(JSON.stringify(body.messages).length / 3.5) + (body.tools ? Math.ceil(JSON.stringify(body.tools).length / 3.5) : 0) + 300;
      const pause = limits.waitFor(parsed.providerId, estimate, parsed.modelId);
      if (pause > 0.5 && pause <= 65) {
        if (onNotice) onNotice(`${provider(parsed.providerId).name}: the per-minute token budget is almost used. Waiting ${Math.ceil(pause)}s so the request is not rejected...`);
        await new Promise((resolve) => {
          const t = setTimeout(resolve, Math.ceil(pause + 0.5) * 1000);
          controller.signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
        });
      }
    }

    let content = '';
    const calls = new Map();
    let usage = null;
    let finishReason = '';
    let looped = false;
    const watchLoop = loopGuard.makeWatcher();
    const started = Date.now();

    try {
      let res;
      for (let attempt = 1; ; attempt++) {
        idle.arm();
        res = await fetch(`${base}/chat/completions`, {
          method: 'POST',
          headers: { ...authHeaders(key), 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal
        });
        idle.pause();
        const seen = limits.record(parsed.providerId, parsed.modelId, limits.parseHeaders(res.headers));
        if (onLimits) onLimits(seen);
        if ([500, 502, 503, 504, 529].includes(res.status) && attempt <= 4 && !quick && !failFast) {
          // Temporary overload on the provider's side: wait a little and try again.
          const wait = [2, 4, 8, 12][attempt - 1] || 12;
          if (onNotice) onNotice(`${provider(parsed.providerId).name} is busy right now (error ${res.status}). Trying again in ${wait}s (${attempt}/4)...`);
          await res.text().catch(() => '');
          await new Promise((resolve, reject) => {
            const t = setTimeout(resolve, wait * 1000);
            controller.signal.addEventListener('abort', () => {
              clearTimeout(t);
              reject(new Error('aborted'));
            }, { once: true });
          });
          continue;
        }
        if (res.status === 400 && body.max_tokens > 4096) {
          const peek = await res.clone().text().catch(() => '');
          if (/max_tokens|max_completion_tokens|max_output_tokens|maximum.*(output|completion) tokens/i.test(peek)) {
            body.max_tokens = 4096;
            await res.text().catch(() => '');
            continue;
          }
        }
        if (res.status === 429 && attempt <= MAX_RETRIES) {
          const peek = await res.clone().text().catch(() => '');
          const tooLarge = peek.match(/Limit (\d+),\s*Used (\d+),\s*Requested (\d+)/i);
          const hardTooLarge = /request too large|reduce your message|too many tokens in (a )?single/i.test(peek) ||
            (tooLarge && Number(tooLarge[3]) > Number(tooLarge[1]));
          if (hardTooLarge) {
            const m = peek.match(/Limit (\d+).*?Requested (\d+)/is);
            const pname = provider(parsed.providerId).name;
            if (m) {
              limits.setModelCap(parsed.providerId, parsed.modelId, Number(m[1]));
              Promise.resolve(this._context.globalState.update('localAI.cloudModelCaps', limits.allModelCaps())).catch(() => {});
            }
            if (m && Number(m[1]) < 3000) {
              throw new Error(`${pname} allows "${parsed.modelId}" only ${m[1]} tokens per minute on the free tier, and this request needs ${m[2]}. That is too small for working on a project: pick another model (for example a larger one in "Change models").`);
            }
            throw new Error(`${pname}: this request is larger than the free per-minute token limit${m ? ` (limit ${m[1]}, requested ${m[2]})` : ''}. Lower "Cloud context size" in Settings, or use a model with a bigger limit.`);
          }
          // Another model is ready to take over: switching is faster than waiting for the reset.
          if (failFast) break;
          const header = Number(res.headers.get('retry-after'));
          let hinted = 0;
          const again = peek.match(/try again in\s+(?:(\d+)m)?\s*(\d+(?:\.\d+)?)(ms|s)/i);
          if (again) hinted = (Number(again[1] || 0) * 60) + (again[3].toLowerCase() === 'ms' ? Number(again[2]) / 1000 : Number(again[2]));
          const base = Math.max(Number.isFinite(header) && header > 0 ? header : 0, hinted);
          const wait = Math.min((base || 5 * attempt) + 1, MAX_WAIT_S);
          if (onNotice) onNotice(`${provider(parsed.providerId).name} free per-minute limit reached. Waiting ${Math.ceil(wait)}s and trying again (${attempt}/${MAX_RETRIES})...`);
          await res.text().catch(() => '');
          await new Promise((resolve, reject) => {
            const t = setTimeout(resolve, wait * 1000);
            controller.signal.addEventListener('abort', () => {
              clearTimeout(t);
              reject(new Error('aborted'));
            }, { once: true });
          });
          continue;
        }
        break;
      }

      if (!res.ok) {
        let detail = '';
        try {
          const text = await res.text();
          const json = lenientJson(text);
          detail = (json.error && (json.error.message || json.error)) || json.message || text.slice(0, 300);
        } catch (_) {
        }
        const name = provider(parsed.providerId).name;
        if ([500, 502, 503, 504, 529].includes(res.status)) throw new Error(`${name} is overloaded at the moment (error ${res.status}) and did not recover after several tries. This often happens with the newest models: try again in a minute or pick another model.`);
        if (res.status === 401 || res.status === 403) throw new Error(`${name} rejected the API key. Check it in the sidebar under Cloud models.`);
        if (res.status === 429) throw new Error(`${name}: the free limit is used up for now (${detail || 'rate limit'}). Try again later, pick another model or another provider.`);
        if (res.status === 400 && /websocket|bidi|realtime|not supported for generateContent|does not support (chat|text)|only supports/i.test(String(detail))) {
          throw new Error(`${name}: "${parsed.modelId}" is not a normal chat model (it is for live audio/video or another special use). Remove it in the sidebar and pick another model with "Change models".`);
        }
        if (res.status === 404 && /no longer available|deprecated|retired|sunset/i.test(String(detail))) {
          const hint = String(detail).match(/use (?:models\/)?([\w.\-]+)/i);
          throw new Error(`${name} has retired "${parsed.modelId}" for new accounts${hint ? ` and suggests "${hint[1]}"` : ''}. Remove it in the sidebar and pick a newer model with "Change models" (newest models are listed first).`);
        }
        if (res.status === 404) throw new Error(`${name}: model "${parsed.modelId}" was not found${detail ? ` (${String(detail).slice(0, 160)})` : ''}. It may have been removed or is not available for your key; remove it and pick another with "Change models".`);
        if (res.status === 413) throw new Error(`${name}: the request is too large for the free limits. Lower the cloud context size in Settings.`);
        if (/(does not|doesn't|do not|not) support(ed)? .*tool|tool(s| use| calling)? (is|are) not supported|tools? not supported/i.test(String(detail)) && !/signature/i.test(String(detail)) && body.tools) throw new Error(`This model does not support tools (${detail})`);
        throw new Error(`${name} error ${res.status}: ${detail}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let done = false;

      const handle = (line) => {
        if (!line.startsWith('data:')) return;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') {
          if (payload === '[DONE]') done = true;
          return;
        }
        let evt;
        try {
          evt = JSON.parse(payload);
        } catch (_) {
          return;
        }
        if (evt.error) throw new Error(evt.error.message || 'The provider reported an error.');
        if (evt.usage) usage = evt.usage;
        if (evt.choices && evt.choices[0] && evt.choices[0].finish_reason) finishReason = evt.choices[0].finish_reason;
        const delta = evt.choices && evt.choices[0] && evt.choices[0].delta;
        if (!delta) return;
        const thinking = delta.reasoning || delta.reasoning_content;
        if (thinking && onThinking) onThinking(thinking);
        if (typeof delta.content === 'string' && delta.content) {
          content += delta.content;
          if (onToken) onToken(delta.content);
          const cut = watchLoop(content);
          if (cut >= 0) {
            looped = true;
            content = content.slice(0, cut);
            controller.abort();
          }
        }
        if (Array.isArray(delta.tool_calls)) {
          delta.tool_calls.forEach((tc) => {
            const index = tc.index !== undefined ? tc.index : calls.size;
            const entry = calls.get(index) || { name: '', args: '' };
            if (tc.extra_content) entry.extra = tc.extra_content;
            if (tc.function && tc.function.name) entry.name += tc.function.name;
            if (tc.function && typeof tc.function.arguments === 'string') entry.args += tc.function.arguments;
            calls.set(index, entry);
          });
        }
      };

      while (!done) {
        idle.arm();
        const { value, done: finished } = await reader.read();
        if (finished) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        lines.forEach((l) => handle(l.trim()));
      }
      handle(buffer.trim());
    } catch (err) {
      if (looped && !aborted) {
        if (onNotice) onNotice('The model started repeating itself, so the answer was cut. This model is too weak for this task: pick a stronger one.');
        return { content, toolCalls: [] };
      }
      if (aborted) return { content, toolCalls: [] };
      if (timedOut || (err && err.name === 'AbortError')) throw new Error(`The cloud provider sent nothing for ${IDLE_TIMEOUT_MS / 1000}s and the request was stopped. Try again or pick another model.`);
      throw err;
    } finally {
      idle.pause();
    }

    const truncated = finishReason === 'length';
    // A call cut off by the output limit has broken arguments: running it would write a half file.
    const toolCalls = [...calls.entries()]
      .sort((a, b) => a[0] - b[0])
      .filter(([, c]) => c.name && !(truncated && c.args && !isJson(c.args)))
      .map(([, c]) => ({ function: { name: c.name, arguments: c.args ? lenientJson(c.args) : {} }, ...(c.extra ? { extra_content: c.extra } : {}) }));

    if (onStats) {
      const out = usage ? usage.completion_tokens || 0 : Math.ceil(content.length / 4);
      const seconds = Math.max((Date.now() - started) / 1000, 0.001);
      onStats({
        tokensPerSec: out / seconds,
        promptEvalCount: usage ? usage.prompt_tokens || 0 : 0,
        evalCount: out,
        evalDuration: seconds * 1e9
      });
    }
    return { content, toolCalls, truncated };
  }
}

module.exports = { CloudClient, toOpenAIMessages };
