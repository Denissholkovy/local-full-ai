const { spawn } = require('child_process');

let child = null;

function isManaged() {
  return child !== null && !child.killed;
}

function startServer() {
  if (isManaged()) {
    return { started: false, reason: 'already-running' };
  }

  try {
    child = spawn('ollama', ['serve'], {
      stdio: 'ignore',
      detached: false
    });
    child.on('exit', () => {
      child = null;
    });
    child.on('error', () => {
      child = null;
    });
    return { started: true };
  } catch (err) {
    child = null;
    return { started: false, reason: err.message };
  }
}

function stopServer() {
  if (child) {
    try {
      child.kill();
    } catch (_) {
    }
    child = null;
  }
}

module.exports = { startServer, stopServer, isManaged };
