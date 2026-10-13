const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');
const vscode = require('vscode');

const WHISPER_NAMES = ['whisper-cli', 'whisper-cpp'];
const SEARCH_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/home/linuxbrew/.linuxbrew/bin'];
const MODEL_DIR = path.join(os.homedir(), '.local-full-ai', 'whisper');
const DEFAULT_MODEL = path.join(MODEL_DIR, 'ggml-base.bin');
const MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin';
const TRANSCRIBE_TIMEOUT_MS = 120000;
const MIN_WAV_BYTES = 6000;
const STOP_TIMEOUT_MS = 4000;
const START_CHECK_MS = 500;

const transcribing = new Set();
const recordings = new Set();

function findTool(names) {
  const dirs = [...(process.env.PATH || '').split(path.delimiter), ...SEARCH_DIRS].filter(Boolean);
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function findWhisper() {
  const configured = vscode.workspace.getConfiguration('localAI').get('whisperBinaryPath');
  if (configured && fs.existsSync(configured)) return configured;
  return findTool(WHISPER_NAMES);
}

function findModel() {
  const configured = vscode.workspace.getConfiguration('localAI').get('whisperModelPath');
  if (configured && fs.existsSync(configured)) return configured;
  return fs.existsSync(DEFAULT_MODEL) ? DEFAULT_MODEL : null;
}

function recorderSpec(file) {
  if (process.platform === 'win32') return null;
  const rec = findTool(['rec']);
  if (rec) return { bin: rec, args: ['-q', '-r', '16000', '-c', '1', '-b', '16', file] };
  const sox = findTool(['sox']);
  if (sox) return { bin: sox, args: ['-q', '-d', '-r', '16000', '-c', '1', '-b', '16', file] };
  const ffmpeg = findTool(['ffmpeg']);
  if (process.platform === 'darwin' && ffmpeg) {
    return { bin: ffmpeg, args: ['-loglevel', 'error', '-f', 'avfoundation', '-i', ':default', '-ar', '16000', '-ac', '1', '-y', file] };
  }
  if (process.platform === 'linux') {
    const arecord = findTool(['arecord']);
    if (arecord) return { bin: arecord, args: ['-q', '-f', 'S16_LE', '-r', '16000', '-c', '1', file] };
    if (ffmpeg) return { bin: ffmpeg, args: ['-loglevel', 'error', '-f', 'pulse', '-i', 'default', '-ar', '16000', '-ac', '1', '-y', file] };
  }
  return null;
}

function missing() {
  const list = [];
  if (!findWhisper()) list.push('whisper.cpp');
  if (!findModel()) list.push('speech model');
  if (!recorderSpec('x.wav')) list.push('audio recorder (sox)');
  return list;
}

function status() {
  return { ready: missing().length === 0 };
}

function setupCommand() {
  if (process.platform === 'win32') return null;
  const packages = [];
  if (!findWhisper()) packages.push('whisper-cpp');
  if (!recorderSpec('x.wav')) packages.push('sox');
  const steps = [];
  if (packages.length) steps.push(`brew install ${packages.join(' ')}`);
  if (!findModel()) steps.push(`mkdir -p "${MODEL_DIR}" && curl -L -o "${DEFAULT_MODEL}" ${MODEL_URL}`);
  return steps.length ? steps.join(' && ') : null;
}

function openSetupTerminal() {
  const command = setupCommand();
  if (!command) {
    vscode.window.showInformationMessage('Voice input already has everything it needs.');
    return;
  }
  const terminal = vscode.window.createTerminal('Voice input setup');
  terminal.show();
  terminal.sendText(command);
  vscode.window.showInformationMessage('Installing what voice input needs. When the terminal finishes, press the microphone again.');
}

function startRecording(specOverride) {
  return new Promise((resolve, reject) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-full-ai-rec-'));
    const file = path.join(dir, 'recording.wav');
    const spec = specOverride ? specOverride(file) : recorderSpec(file);
    const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
    if (!spec) {
      cleanup();
      return reject(new Error('No audio recorder found.'));
    }

    const proc = spawn(spec.bin, spec.args, { stdio: ['ignore', 'ignore', 'pipe'], detached: process.platform !== 'win32' });
    let stderr = '';
    let exited = false;
    let exitCode = null;
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    const closed = new Promise((done) => {
      proc.on('close', (code) => {
        exited = true;
        exitCode = code;
        done();
      });
      proc.on('error', (err) => {
        exited = true;
        stderr += err.message;
        done();
      });
    });

    const handle = {
      async stop() {
        recordings.delete(handle);
        if (!exited) {
          try {
            proc.kill('SIGINT');
          } catch (_) {
          }
          await Promise.race([closed, new Promise((r) => setTimeout(r, STOP_TIMEOUT_MS))]);
          if (!exited) {
            try {
              proc.kill('SIGKILL');
            } catch (_) {
            }
          }
        }
        let buffer = Buffer.alloc(0);
        try {
          buffer = fs.readFileSync(file);
        } catch (_) {
        }
        cleanup();
        if (buffer.length < MIN_WAV_BYTES) {
          const err = new Error(stderr.trim() || 'Nothing was recorded.');
          err.noAudio = true;
          throw err;
        }
        return buffer;
      },
      cancel() {
        recordings.delete(handle);
        try {
          proc.kill('SIGKILL');
        } catch (_) {
        }
        cleanup();
      }
    };

    setTimeout(() => {
      if (exited) {
        cleanup();
        const err = new Error(stderr.trim() || `The recorder stopped right away (code ${exitCode}).`);
        err.noAudio = true;
        reject(err);
      } else {
        recordings.add(handle);
        resolve(handle);
      }
    }, START_CHECK_MS);
  });
}

function transcribe(wavBuffer, language) {
  return new Promise((resolve, reject) => {
    const binary = findWhisper();
    const model = findModel();
    if (!binary || !model) {
      const err = new Error('Offline speech recognition is not installed yet.');
      err.needsSetup = true;
      return reject(err);
    }

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-full-ai-voice-'));
    const file = path.join(dir, 'audio.wav');
    fs.writeFileSync(file, wavBuffer);

    const args = ['-m', model, '-f', file, '-nt', '-np', '-sns', '-l', language || 'auto'];
    const proc = execFile(binary, args, { timeout: TRANSCRIBE_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      transcribing.delete(proc);
      fs.rmSync(dir, { recursive: true, force: true });
      if (error) return reject(new Error(`Speech recognition failed: ${error.message}`));
      const cleaned = stdout
        .replace(/\[[^\]]*\]/g, ' ')
        .replace(/\([^)]*\)/g, ' ')
        .replace(/\*[^*]*\*/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      resolve(cleaned);
    });
    transcribing.add(proc);
  });
}

function recorderName() {
  const spec = recorderSpec('x.wav');
  return spec ? path.basename(spec.bin) : null;
}

function isOurModel(model) {
  return !!model && path.resolve(model).startsWith(path.resolve(MODEL_DIR) + path.sep);
}

function info() {
  const whisper = findWhisper();
  const model = findModel();
  let modelMB = 0;
  try {
    if (model) modelMB = Math.round(fs.statSync(model).size / (1024 * 1024));
  } catch (_) {
    modelMB = 0;
  }
  return {
    whisper,
    model,
    modelMB,
    modelIsOurs: isOurModel(model),
    recorder: recorderName(),
    ready: !!(whisper && model && recorderName()),
    canUninstallWhisper: !!uninstallCommand()
  };
}

function uninstallCommand() {
  const whisper = findWhisper();
  if (!whisper) return null;
  const real = (() => {
    try {
      return fs.realpathSync(whisper);
    } catch (_) {
      return whisper;
    }
  })();
  return /homebrew|linuxbrew|Cellar/i.test(real) ? 'brew uninstall whisper-cpp' : null;
}

function removeModel() {
  cancelAll();
  let removed = false;
  if (fs.existsSync(MODEL_DIR)) {
    fs.rmSync(MODEL_DIR, { recursive: true, force: true });
    removed = true;
    const parent = path.dirname(MODEL_DIR);
    try {
      if (fs.readdirSync(parent).length === 0) fs.rmdirSync(parent);
    } catch (_) {
    }
  }
  return removed;
}

function runInTerminal(name, command) {
  const terminal = vscode.window.createTerminal(name);
  terminal.show();
  terminal.sendText(command);
}

function cancelAll() {
  for (const handle of [...recordings]) handle.cancel();
  for (const proc of transcribing) {
    try {
      proc.kill();
    } catch (_) {
    }
  }
  transcribing.clear();
}

module.exports = {
  status,
  missing,
  info,
  removeModel,
  uninstallCommand,
  runInTerminal,
  startRecording,
  transcribe,
  openSetupTerminal,
  cancelAll
};
