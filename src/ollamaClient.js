const http = require('http');
const https = require('https');

const DEFAULT_URL = 'http://localhost:11434';
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
        if (!line.trim()) return;
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

  chat(modelName, messages) {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify({
        model: modelName,
        messages,
        stream: false
      });

      const req = this._client().request(
        this._options('/api/chat', 'POST', payload),
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            try {
              const parsed = JSON.parse(data);
              if (parsed.error) return reject(new Error(parsed.error));
              resolve(parsed.message ? parsed.message.content : '');
            } catch (err) {
              reject(err);
            }
          });
        }
      );

      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }

  chatStream(modelName, messages, onToken, options = {}) {
    const { onAbortReady, keepAlive, onStats, onThinking, tools, numCtx, generation } = options;

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
      if (numCtx || generation) {
        payloadObj.options = { ...(generation || {}) };
        if (numCtx) payloadObj.options.num_ctx = numCtx;
      }
      const payload = JSON.stringify(payloadObj);
      let aborted = false;
      let settled = false;
      let fullText = '';
      const toolCalls = [];

      const fail = (err) => {
        if (settled) return;
        settled = true;
        reject(err);
      };
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve({ content: fullText, toolCalls });
      };

      const handleLine = (line) => {
        if (!line.trim()) return;
        let evt;
        try {
          evt = JSON.parse(line);
        } catch (_) {
          return;
        }
        if (evt.error) return fail(new Error(evt.error));
        const message = evt.message;
        if (message) {
          if (message.thinking && onThinking) onThinking(message.thinking);
          if (message.content) {
            fullText += message.content;
            if (onToken) onToken(message.content);
          }
          if (Array.isArray(message.tool_calls)) {
            toolCalls.push(...message.tool_calls);
          }
        }
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

      if (onAbortReady) {
        onAbortReady(() => {
          aborted = true;
          req.destroy();
          finish();
        });
      }

      req.on('error', (err) => (aborted ? finish() : fail(err)));
      req.write(payload);
      req.end();
    });
  }
}

module.exports = { OllamaClient };
