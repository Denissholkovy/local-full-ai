const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const KNOWN_LOCATIONS = [
  '/opt/homebrew/bin/ollama',
  '/usr/local/bin/ollama',
  '/usr/bin/ollama',
  '/Applications/Ollama.app/Contents/Resources/ollama',
  path.join(os.homedir(), '.local', 'bin', 'ollama'),
  path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'ollama.exe')
];

let child = null;

function findBinary() {
  const exe = process.platform === 'win32' ? 'ollama.exe' : 'ollama';
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, exe);
    if (fs.existsSync(candidate)) return candidate;
  }
  return KNOWN_LOCATIONS.find((c) => c && fs.existsSync(c)) || null;
}

function isManaged() {
  return child !== null && child.exitCode === null && !child.killed;
}

function killGroup(proc) {
  if (!proc || !proc.pid) return;
  try {
    if (process.platform === 'win32') proc.kill();
    else process.kill(-proc.pid, 'SIGTERM');
  } catch (_) {
    try {
      proc.kill();
    } catch (_err) {
    }
  }
}

function startServer() {
  if (isManaged()) return { started: false, reason: 'already-running' };

  const binary = findBinary();
  if (!binary) return { started: false, reason: 'not-installed' };

  try {
    if (process.platform === 'win32') {
      child = spawn(binary, ['serve'], { stdio: 'ignore', windowsHide: true });
    } else {
      const hostPid = process.pid;
      const script = [
        `"${binary}" serve &`,
        'OP=$!',
        `while kill -0 ${hostPid} 2>/dev/null && kill -0 $OP 2>/dev/null; do sleep 2; done`,
        'kill $OP 2>/dev/null'
      ].join('\n');
      child = spawn('/bin/sh', ['-c', script], { stdio: 'ignore', detached: true });
    }
    const current = child;
    current.on('exit', () => {
      if (child === current) child = null;
    });
    current.on('error', () => {
      if (child === current) child = null;
    });
    return { started: true, binary };
  } catch (err) {
    child = null;
    return { started: false, reason: err.message };
  }
}

function stopServer() {
  if (child) {
    killGroup(child);
    child = null;
    return true;
  }
  return false;
}

process.on('exit', () => {
  if (child) killGroup(child);
});

module.exports = { startServer, stopServer, isManaged, findBinary, killGroup };
