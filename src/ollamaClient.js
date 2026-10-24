const loopGuard = require('./loopGuard');
const { isOllamaCloud } = require('./cloudProviders');
const http = require('http');
const https = require('https');

const DEFAULT_URL = 'http://localhost:11434';
const FIRST_TOKEN_TIMEOUT_MS = 10 * 60 * 1000;
const IDLE_TIMEOUT_MS = 3 * 60 * 1000;
const LOADING_NOTICE_MS = 4000;
// About 4000 tokens of thinking: past this the answer is usually not getting better, only later.
const MAX_THINKING_CHARS = 16000;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0']);

function candidateUrls(baseUrl) {
  const list = [];
  const add = (u) => {
    const clean = String(u).replace(/\/+$/, '');
    if (clean && !list.includes(clean)) list.push(clean);
  };
  add(baseUrl || DEFAULT_URL);
  let parsed;
  try {
    parsed = new URL(baseUrl || DEFAULT_URL);
  } catch (_) {
    return list;
  }
  if (LOOPBACK_HOSTS.has(parsed.hostname)) {
    const port = parsed.port || '11434';
    const scheme = parsed.protocol.replace(':', '');
    add(`${scheme}://127.0.0.1:${port}`);
    add(`${scheme}://[::1]:${port}`);
  }
  const env = process.env.OLLAMA_HOST;
  if (env) {
    const withScheme = /^https?:\/\//.test(env) ? env : `http://${env}`;
    try {
      const u = new URL(withScheme);
      const host = u.hostname === '0.0.0.0' ? '127.0.0.1' : u.hostname;
      add(`${u.protocol.replace(':', '')}://${host}:${u.port || '11434'}`);
    } catch (_) {
    }
  }
  return list;
}

// Ollama Cloud models fail for account reasons a local model never has: explain them in plain words.
function cloudErrorText(modelName, error) {
  if (!isOllamaCloud(modelName)) return null;
  const text = String(error || '');
  if (/unauthori[sz]ed|sign ?in|401|403/i.test(text)) return `${modelName} runs on Ollama Cloud and needs you to sign in: press "Sign in to Ollama" under Cloud models in the sidebar, or run "ollama signin" in a terminal.`;
  if (/usage limit|quota|credits|exceeded|429|too many/i.test(text)) return `Ollama Cloud: the usage allowance of your account is used up or busy (${text.slice(0, 160)}). The free plan runs one request at a time and resets monthly. Wait a bit or pick a local model.`;
  return null;
}

// The part of the thinking to keep before telling the model to answer.
function closeThinking(thinking, reason, budget) {
  let kept = String(thinking || '');
  if (reason === 'loop') {
    const cut = loopGuard.findLoop(kept);
    if (cut > 0) kept = kept.slice(0, cut);
  } else if (budget > 0 && kept.length > budget) {
    kept = kept.slice(0, budget);
  }
  const sentence = Math.max(kept.lastIndexOf('. '), kept.lastIndexOf('.\n'));
  if (sentence > kept.length * 0.5) kept = kept.slice(0, sentence + 1);
  return `${kept.trim()}\n\nI have thought enough. Now I write the final answer, following the instructions.`;
}

// Text before a lone </think> is thinking that leaked into the answer (the opening tag was in the prompt).
function stripLeakedThinking(text) {
  const close = text.indexOf('</think>');
  if (close === -1 || text.slice(0, close).includes('<think>')) return text;
  return text.slice(close + '</think>'.length).replace(/^\s+/, '');
}

class OllamaClient {
  constructor(baseUrl) {
    this.configuredUrl = baseUrl || DEFAULT_URL;
    this.baseUrl = this.configuredUrl;
  }

  _client() {
    return this.baseUrl.startsWith('https') ? https : http;
  }

  _options(pathname, method, payload) {
    const url = new URL(`${this.baseUrl}${pathname}`);
    const options = {
      hostname: url.hostname.replace(/^\[|\]$/g, ''),
      port: url.port,
      path: url.pathname,
      method,
      headers: {}
    };
    if (payload !== undefined) {
      options.headers['Content-Type'] = 'application/json';
      options.headers['Content-Length'] = Buffer.byteLength(payload);
    }
    return options;
  }

  _probe(base) {
    return new Promise((resolve) => {
      let url;
      try {
        url = new URL(`${base}/api/tags`);
      } catch (_) {
        return resolve(false);
      }
      const client = base.startsWith('https') ? https : http;
      const req = client.get(
        { hostname: url.hostname.replace(/^\[|\]$/g, ''), port: url.port, path: url.pathname },
        (res) => {
          res.resume();
          resolve(res.statusCode === 200);
        }
      );
      req.on('error', () => resolve(false));
      req.setTimeout(2000, () => {
        req.destroy();
        resolve(false);
      });
    });
  }

  async ping() {
    const candidates = [this.baseUrl, ...candidateUrls(this.configuredUrl)].filter((u, i, arr) => arr.indexOf(u) === i);
    for (const candidate of candidates) {
      if (await this._probe(candidate)) {
        this.baseUrl = candidate;
        return true;
      }
    }
    return false;
  }

  listLocalModels() {
    return new Promise((resolve, reject) => {
      const req = this._client().get(this._options('/api/tags', 'GET'), (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            resolve(
              (parsed.models || []).map((m) => ({
                name: m.name,
                size: m.size,
                modifiedAt: m.modified_at,
                digest: m.digest || '',
                details: m.details || {}
              }))
            );
          } catch (err) {
            reject(err);
          }
        });
      });
      req.on('error', reject);
      req.setTimeout(5000, () => req.destroy(new Error('Ollama did not answer in time.')));
    });
  }

  _json(pathname, method, body, timeoutMs) {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = this._client().request(this._options(pathname, method, payload), (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve(data ? JSON.parse(data) : {});
          } catch (_) {
            resolve({});
          }
        });
      });
      req.on('error', reject);
      req.setTimeout(timeoutMs || 3000, () => {
        req.destroy();
        reject(new Error('timeout'));
      });
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }

  // Vectors for a batch of texts (embedding models only).
  async embed(modelName, inputs) {
    const result = await this._json('/api/embed', 'POST', { model: modelName, input: inputs, truncate: true }, 120000);
    if (result.error) throw new Error(result.error);
    if (!Array.isArray(result.embeddings) || result.embeddings.length !== inputs.length) throw new Error('Ollama returned no embeddings.');
    return result.embeddings;
  }

  // One short non-streaming completion; with `suffix` the model fills in the middle (code completion).
  generate(modelName, { prompt, suffix, options, keepAlive }, signal) {
    return new Promise((resolve, reject) => {
      const body = { model: modelName, prompt, stream: false, options };
      if (suffix !== undefined) body.suffix = suffix;
      if (keepAlive) body.keep_alive = keepAlive;
      const payload = JSON.stringify(body);
      const req = this._client().request(this._options('/api/generate', 'POST', payload), (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.error) return reject(new Error(parsed.error));
            resolve(parsed.response || '');
          } catch (err) {
            reject(err);
          }
        });
      });
      req.on('error', reject);
      req.setTimeout(30000, () => req.destroy(new Error('timeout')));
      if (signal) {
        if (signal.aborted) return req.destroy(new Error('cancelled'));
        signal.addEventListener('abort', () => req.destroy(new Error('cancelled')), { once: true });
      }
      req.write(payload);
      req.end();
    });
  }

  // What the model can do, as Ollama reports it: { capabilities: ['completion', 'tools', 'vision', 'thinking'], contextLength }.
  async showModel(modelName) {
    const info = await this._json('/api/show', 'POST', { model: modelName }, 5000);
    if (!info || (!info.capabilities && !info.model_info)) return null;
    const modelInfo = info.model_info || {};
    const ctxKey = Object.keys(modelInfo).find((k) => k.endsWith('.context_length'));
    const template = String(info.template || '');
    return {
      capabilities: Array.isArray(info.capabilities) ? info.capabilities : null,
      contextLength: ctxKey ? Number(modelInfo[ctxKey]) || 0 : 0,
      // Hybrid models read .Think in their template and can answer without thinking; "thinking" fine-tunes
      // (Qwen3 Thinking-2507...) always open <think>, and think:false only stops Ollama from separating it.
      thinkingSwitch: /\.Think\b/.test(template),
      capsVersion: 2
    };
  }

  async unloadAllModels() {
    try {
      const running = await this._json('/api/ps', 'GET', undefined, 2000);
      const names = (running.models || []).map((m) => m.name);
      await Promise.all(
        names.map((name) =>
          this._json('/api/generate', 'POST', { model: name, keep_alive: 0 }, 3000).catch(() => {})
        )
      );
      return names.length;
    } catch (_) {
      return 0;
    }
  }

  pullModel(modelName, onProgress, options = {}) {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify({ name: modelName, stream: true });
      let cancelled = false;
      let succeeded = false;
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        fn(value);
      };
      const cancelledError = () => {
        const err = new Error('Download cancelled');
        err.cancelled = true;
        return err;
      };

      const handleLine = (line) => {
        if (settled || !line.trim()) return;
        let evt;
        try {
          evt = JSON.parse(line);
        } catch (_) {
          return;
        }
        if (onProgress) onProgress(evt);
        if (evt.error) finish(reject, new Error(evt.error));
        if (evt.status === 'success') succeeded = true;
      };

      const req = this._client().request(
        this._options('/api/pull', 'POST', payload),
        (res) => {
          let buffer = '';
          res.on('data', (chunk) => {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop();
            lines.forEach(handleLine);
          });
          res.on('end', () => {
            handleLine(buffer);
            if (cancelled) finish(reject, cancelledError());
            else if (succeeded) finish(resolve);
            else finish(reject, new Error('The download was interrupted before it finished. Install again to resume.'));
          });
          res.on('error', (err) => finish(reject, cancelled ? cancelledError() : err));
        }
      );

      if (options.onAbortReady) {
        options.onAbortReady(() => {
          cancelled = true;
          req.destroy();
          finish(reject, cancelledError());
        });
      }

      req.on('error', (err) => finish(reject, cancelled ? cancelledError() : err));
      req.write(payload);
      req.end();
    });
  }

  deleteModel(modelName) {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify({ name: modelName });
      const req = this._client().request(
        this._options('/api/delete', 'DELETE', payload),
        (res) => {
          if (res.statusCode === 200) resolve();
          else reject(new Error(`Delete failed: ${res.statusCode}`));
        }
      );
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }

  // A model that thinks for ever (or in circles) is stopped and asked again without thinking.
  // Thinking that runs past its budget (or in circles) is cut: the model continues its own message with the
  // thinking closed, so it writes the answer right away. Works for models that cannot switch thinking off.
  async chatStream(modelName, messages, onToken, options = {}) {
    const result = await this._chatStreamOnce(modelName, messages, onToken, options);
    if (!result.overthought) return result;
    if (options.onNotice) {
      options.onNotice(result.overthought === 'loop'
        ? `${modelName} started thinking in circles, so it writes the answer now...`
        : `${modelName} has thought long enough, so it writes the answer now...`);
    }
    if (/gpt-oss/i.test(modelName)) {
      return this._chatStreamOnce(modelName, messages, onToken, { ...options, think: 'low', continued: true });
    }
    const thought = closeThinking(result.thinking, result.overthought, options.thinkBudget);
    return this._chatStreamOnce(
      modelName,
      [...messages, { role: 'assistant', content: '', thinking: thought }],
      onToken,
      { ...options, think: true, continued: true }
    );
  }

  _chatStreamOnce(modelName, messages, onToken, options = {}) {
    const { onAbortReady, keepAlive, onStats, onThinking, tools, numCtx, generation, onNotice, think } = options;

    return new Promise((resolve, reject) => {
      const payloadObj = {
        model: modelName,
        messages,
        stream: true
      };
      if (keepAlive !== undefined && keepAlive !== '') {
        payloadObj.keep_alive = keepAlive;
      }
      if (Array.isArray(tools) && tools.length > 0) {
        payloadObj.tools = tools;
      }
      if (think !== undefined) payloadObj.think = think;
      if (numCtx || generation) {
        payloadObj.options = { ...(generation || {}) };
        if (numCtx) payloadObj.options.num_ctx = numCtx;
      }
      const payload = JSON.stringify(payloadObj);
      let aborted = false;
      let settled = false;
      let fullText = '';
      let thinkingText = '';
      let overthought = null;
      const watchThinking = loopGuard.makeWatcher();
      let truncated = false;
      const toolCalls = [];
      const watchLoop = loopGuard.makeWatcher();
      let reqRef = null;

      // Loading a big model and reading a long prompt sends nothing for a while, so the first wait is long.
      let idleTimer = null;
      let loadingTimer = null;
      let gotData = false;
      const stopTimers = () => {
        clearTimeout(idleTimer);
        clearTimeout(loadingTimer);
      };
      const armIdle = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          const seconds = (gotData ? IDLE_TIMEOUT_MS : FIRST_TOKEN_TIMEOUT_MS) / 1000;
          if (reqRef) reqRef.destroy();
          fail(new Error(`Ollama sent nothing for ${seconds}s. The model may be too big for this computer: try a smaller model or a shorter context.`));
        }, gotData ? IDLE_TIMEOUT_MS : FIRST_TOKEN_TIMEOUT_MS);
      };
      const fail = (err) => {
        if (settled) return;
        settled = true;
        stopTimers();
        reject(err);
      };
      const finish = () => {
        if (settled) return;
        settled = true;
        stopTimers();
        resolve({ content: stripLeakedThinking(fullText), thinking: thinkingText, toolCalls, truncated, overthought });
      };
      if (onNotice) {
        loadingTimer = setTimeout(async () => {
          if (gotData || settled) return;
          const running = await this._json('/api/ps', 'GET', undefined, 2000).catch(() => ({}));
          const loaded = (running.models || []).some((m) => m.name === modelName || m.model === modelName);
          if (!gotData && !settled) onNotice(loaded ? `${modelName} is reading the request...` : `Loading ${modelName} into memory. The first answer after a switch takes longer...`);
        }, LOADING_NOTICE_MS);
      }

      const handleLine = (line) => {
        if (!line.trim()) return;
        let evt;
        try {
          evt = JSON.parse(line);
        } catch (_) {
          return;
        }
        if (evt.error) return fail(new Error(cloudErrorText(modelName, evt.error) || evt.error));
        const message = evt.message;
        if (message) {
          if (message.thinking) {
            thinkingText += message.thinking;
            if (onThinking) onThinking(message.thinking);
            const looped = watchThinking(thinkingText) >= 0;
            const budget = options.thinkBudget === undefined ? MAX_THINKING_CHARS : options.thinkBudget;
            if (!fullText && options.canThink && !options.continued && (looped || (budget > 0 && thinkingText.length > budget)) && !aborted) {
              aborted = true;
              overthought = looped ? 'loop' : 'long';
              if (reqRef) reqRef.destroy();
              finish();
              return;
            }
          }
          if (message.content) {
            fullText += message.content;
            if (onToken) onToken(message.content);
            const cut = watchLoop(fullText);
            if (cut >= 0 && !aborted) {
              fullText = fullText.slice(0, cut);
              aborted = true;
              if (onNotice) onNotice('The model started repeating itself, so the answer was cut. This model is too weak for this task: pick a stronger one.');
              if (reqRef) reqRef.destroy();
              finish();
              return;
            }
          }
          if (Array.isArray(message.tool_calls)) {
            toolCalls.push(...message.tool_calls);
          }
        }
        if (evt.done && evt.done_reason === 'length') truncated = true;
        if (evt.done && evt.eval_count && evt.eval_duration && onStats) {
          onStats({
            tokensPerSec: evt.eval_count / (evt.eval_duration / 1e9),
            promptEvalCount: evt.prompt_eval_count || 0,
            evalCount: evt.eval_count,
            evalDuration: evt.eval_duration
          });
        }
      };

      const req = this._client().request(
        this._options('/api/chat', 'POST', payload),
        (res) => {
          let buffer = '';
          res.on('data', (chunk) => {
            gotData = true;
            armIdle();
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop();
            lines.forEach(handleLine);
          });
          res.on('end', () => {
            handleLine(buffer);
            finish();
          });
          res.on('error', (err) => (aborted ? finish() : fail(err)));
        }
      );

      reqRef = req;
      if (onAbortReady) {
        onAbortReady(() => {
          aborted = true;
          req.destroy();
          finish();
        });
      }

      req.on('error', (err) => (aborted ? finish() : fail(err)));
      armIdle();
      req.write(payload);
      req.end();
    });
  }
}

module.exports = { OllamaClient, stripLeakedThinking, closeThinking };
