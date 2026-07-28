const http = require('http');
const https = require('https');

class OllamaClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl || 'http://localhost:11434';
  }

  _client() {
    return this.baseUrl.startsWith('https') ? https : http;
  }

  ping() {
    return new Promise((resolve) => {
      const req = this._client().get(`${this.baseUrl}/api/tags`, (res) => {
        resolve(res.statusCode === 200);
      });
      req.on('error', () => resolve(false));
      req.setTimeout(2000, () => {
        req.destroy();
        resolve(false);
      });
    });
  }

  listLocalModels() {
    return new Promise((resolve, reject) => {
      const req = this._client().get(`${this.baseUrl}/api/tags`, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            resolve(
              (parsed.models || []).map((m) => ({
                name: m.name,
                size: m.size,
                modifiedAt: m.modified_at
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

  pullModel(modelName, onProgress) {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify({ name: modelName, stream: true });
      const url = new URL(`${this.baseUrl}/api/pull`);

      const req = this._client().request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload)
          }
        },
        (res) => {
          let buffer = '';
          res.on('data', (chunk) => {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop();
            for (const line of lines) {
              if (!line.trim()) continue;
              try {
                const evt = JSON.parse(line);
                if (onProgress) onProgress(evt);
                if (evt.error) {
                  reject(new Error(evt.error));
                }
              } catch (_) {
              }
            }
          });
          res.on('end', () => resolve());
        }
      );

      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }

  deleteModel(modelName) {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify({ name: modelName });
      const url = new URL(`${this.baseUrl}/api/delete`);
      const req = this._client().request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: 'DELETE',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload)
          }
        },
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
      const url = new URL(`${this.baseUrl}/api/chat`);

      const req = this._client().request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload)
          }
        },
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

  chatStream(modelName, messages, onToken, onAbortReady) {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify({
        model: modelName,
        messages,
        stream: true
      });
      const url = new URL(`${this.baseUrl}/api/chat`);
      let aborted = false;
      let fullText = '';

      const req = this._client().request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload)
          }
        },
        (res) => {
          let buffer = '';
          res.on('data', (chunk) => {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop();
            for (const line of lines) {
              if (!line.trim()) continue;
              try {
                const evt = JSON.parse(line);
                if (evt.error) return reject(new Error(evt.error));
                if (evt.message && evt.message.content) {
                  fullText += evt.message.content;
                  if (onToken) onToken(evt.message.content);
                }
              } catch (_) {
              }
            }
          });
          res.on('end', () => resolve(fullText));
        }
      );

      if (onAbortReady) {
        onAbortReady(() => {
          aborted = true;
          req.destroy();
        });
      }

      req.on('error', (err) => {
        if (aborted) {
          resolve(fullText);
        } else {
          reject(err);
        }
      });
      req.write(payload);
      req.end();
    });
  }
}

module.exports = { OllamaClient };
