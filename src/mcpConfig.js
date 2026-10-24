const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { McpManager } = require('./mcp');
const workspaceLib = require('./workspace');

// MCP servers come from two places:
// - the user's own settings (localAI.mcpServers, global only: a workspace could otherwise start any program)
// - the project's .mcp.json (the Claude Code format), only in a trusted folder and only after the user allowed each server
const manager = new McpManager();
const declined = new Set();

function hash(spec) {
  return crypto.createHash('sha1').update(JSON.stringify(spec)).digest('hex').slice(0, 16);
}

// Claude-style entry -> what the client needs. Returns null for entries it cannot run.
function normalize(entry, cwd) {
  if (!entry || typeof entry !== 'object') return null;
  const type = entry.type || (entry.url ? 'http' : 'stdio');
  if (type === 'http' || type === 'streamable-http') {
    return typeof entry.url === 'string' && /^https?:\/\//.test(entry.url) ? { url: entry.url, headers: entry.headers || {}, autoApprove: entry.autoApprove === true } : null;
  }
  if (type !== 'stdio' || typeof entry.command !== 'string' || !entry.command) return null;
  return {
    command: entry.command,
    args: Array.isArray(entry.args) ? entry.args.map(String) : [],
    env: entry.env && typeof entry.env === 'object' ? entry.env : {},
    cwd: entry.cwd || cwd,
    autoApprove: entry.autoApprove === true
  };
}

function userServers() {
  const inspected = vscode.workspace.getConfiguration('localAI').inspect('mcpServers');
  return (inspected && inspected.globalValue) || {};
}

function projectServers(root) {
  if (!root) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8'));
    return (parsed && parsed.mcpServers) || {};
  } catch (_) {
    return {};
  }
}

async function approveProjectServer(context, name, spec) {
  const key = 'localAI.mcpApproved';
  const approved = context.workspaceState.get(key, {});
  const id = hash(spec);
  if (approved[name] === id) return true;
  if (declined.has(`${name}:${id}`)) return false;
  const what = spec.url ? `connect to ${spec.url}` : `run: ${[spec.command, ...spec.args].join(' ')}`;
  const choice = await vscode.window.showWarningMessage(
    `This project's .mcp.json wants to start the MCP server "${name}" and ${what}. MCP servers run with your permissions and can read files, use the network and more. Only allow servers you trust.`,
    { modal: true },
    'Allow for this project'
  );
  if (choice !== 'Allow for this project') {
    declined.add(`${name}:${id}`);
    return false;
  }
  await context.workspaceState.update(key, { ...approved, [name]: id });
  return true;
}

// Starts the servers that should run now and returns the manager.
async function ensure(context) {
  const enabled = vscode.workspace.getConfiguration('localAI').get('mcp') !== false;
  if (!enabled || !workspaceLib.isTrusted()) {
    await manager.sync({});
    return manager;
  }
  const root = workspaceLib.resolveWorkingRoot();
  const specs = {};
  for (const [name, entry] of Object.entries(userServers())) {
    const spec = normalize(entry, root || undefined);
    if (spec) specs[name] = spec;
  }
  for (const [name, entry] of Object.entries(projectServers(root))) {
    if (specs[name]) continue;
    const spec = normalize(entry, root);
    if (spec && (await approveProjectServer(context, name, spec))) specs[name] = spec;
  }
  await manager.sync(specs);
  return manager;
}

function specFor(name) {
  const all = { ...projectServers(workspaceLib.resolveWorkingRoot()), ...userServers() };
  return normalize(all[name]);
}

module.exports = { ensure, manager, normalize, specFor, userServers };
