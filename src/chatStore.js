const fs = require('fs');
const path = require('path');

// Chats live in one JSON file each under the extension's storage folder, not in globalState:
// globalState is loaded whole on every start of VS Code and is not meant for pictures and tool output.
const SAVE_DELAY_MS = 400;
const LEGACY_KEY = 'localAI.chatSessions';

const pending = new Map();
let folder = null;

function fileFor(id) {
  return path.join(folder, `${id}.json`);
}

function validId(id) {
  return typeof id === 'string' && /^[\w-]{1,64}$/.test(id);
}

function writeNow(session) {
  if (!folder || !validId(session.id)) return;
  const target = fileFor(session.id);
  const temp = `${target}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(session));
  fs.renameSync(temp, target);
}

function createdAt(session) {
  const stamp = parseInt(String(session.id).slice(0, -5), 36);
  return Number.isFinite(stamp) ? stamp : session.updatedAt || 0;
}

function load(context) {
  folder = path.join(context.globalStorageUri.fsPath, 'chats');
  fs.mkdirSync(folder, { recursive: true });

  const legacy = context.globalState.get(LEGACY_KEY);
  if (Array.isArray(legacy) && legacy.length) {
    try {
      legacy.forEach((session) => writeNow(session));
      context.globalState.update(LEGACY_KEY, undefined);
    } catch (_) {
      return legacy;
    }
  }

  const sessions = [];
  for (const name of fs.readdirSync(folder)) {
    if (!name.endsWith('.json')) continue;
    try {
      const session = JSON.parse(fs.readFileSync(path.join(folder, name), 'utf8'));
      if (session && validId(session.id) && Array.isArray(session.history)) sessions.push(session);
    } catch (_) {
    }
  }
  return sessions.sort((a, b) => createdAt(a) - createdAt(b));
}

function save(session) {
  if (!session || !validId(session.id)) return;
  const waiting = pending.get(session.id);
  if (waiting) {
    waiting.session = session;
    return;
  }
  const entry = { session, timer: null };
  entry.timer = setTimeout(() => {
    pending.delete(session.id);
    try {
      writeNow(entry.session);
    } catch (_) {
    }
  }, SAVE_DELAY_MS);
  pending.set(session.id, entry);
}

function remove(id) {
  const waiting = pending.get(id);
  if (waiting) {
    clearTimeout(waiting.timer);
    pending.delete(id);
  }
  if (!folder || !validId(id)) return;
  try {
    fs.unlinkSync(fileFor(id));
  } catch (_) {
  }
}

function flush() {
  for (const [id, entry] of pending) {
    clearTimeout(entry.timer);
    pending.delete(id);
    try {
      writeNow(entry.session);
    } catch (_) {
    }
  }
}

module.exports = { load, save, remove, flush };
