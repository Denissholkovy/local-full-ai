const { vscode, skillsLib, workspaceLib, resolveWorkspaceRoot } = require('./common');

// Methods mixed into SidebarProvider.prototype (see sidebarProvider.js).
module.exports = {
  _skillSources() {
    const config = vscode.workspace.getConfiguration('localAI');
    return skillsLib.describeSources({
      workspaceRoot: resolveWorkspaceRoot(),
      extraFolders: config.get('extraSkillFolders') || []
    });
  },

  _pretty(p) {
    const home = require('os').homedir();
    return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
  },

  _folderState() {
    const path = require('path');
    const fs = require('fs');
    const config = vscode.workspace.getConfiguration('localAI');
    const rules = workspaceLib.readRules();
    const workspace = workspaceLib.workspaceFolderPaths();
    const primary = workspaceLib.resolveWorkingRoot();
    const items = [];
    workspace.forEach((p) => {
      const rule = rules.find((r) => r.path === p);
      items.push({ path: p, display: this._pretty(p), name: path.basename(p), kind: 'project', level: rule ? rule.level : 'full', primary: p === primary, removable: false, exists: true });
    });
    rules.filter((r) => !workspace.includes(r.path)).forEach((r) => {
      let exists = false;
      try {
        exists = fs.statSync(r.path).isDirectory();
      } catch (_) {
        exists = false;
      }
      items.push({
        path: r.path,
        display: this._pretty(r.path),
        name: path.basename(r.path) || r.path,
        kind: workspace.some((w) => workspaceLib.isInside(r.path, w)) ? 'inside' : 'extra',
        level: r.level,
        primary: r.path === primary,
        removable: true,
        exists
      });
    });
    if (primary && !items.some((i) => i.path === primary)) {
      items.unshift({ path: primary, display: this._pretty(primary), name: path.basename(primary), kind: 'auto', level: 'full', primary: true, removable: false, exists: true });
    }
    return { items, primary, hasOverride: !!config.get('workingFolder'), noWorkspace: workspace.length === 0 };
  },

  async _updateRules(mutate) {
    const config = vscode.workspace.getConfiguration('localAI');
    const raw = (config.get('folderAccess') || []).filter((r) => r && typeof r.path === 'string');
    await config.update('folderAccess', mutate(raw), vscode.ConfigurationTarget.Global);
  },

  async _setFolderLevel(folderPath, level) {
    if (!workspaceLib.LEVELS.includes(level) || !folderPath) return;
    const workspace = workspaceLib.workspaceFolderPaths();
    await this._updateRules((raw) => {
      const rest = raw.filter((r) => workspaceLib.normalize(workspaceLib.expandHome(r.path)) !== folderPath);
      if (level === 'full' && workspace.includes(folderPath)) return rest;
      return [...rest, { path: folderPath, level }];
    });
  },

  async _addAccessFolder() {
    const picked = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      openLabel: 'Choose folder',
      title: 'Choose a folder to give or restrict access to'
    });
    if (!picked || picked.length === 0) return;
    const folderPath = workspaceLib.normalize(picked[0].fsPath);
    const level = await vscode.window.showQuickPick(
      [
        { label: 'Read only', description: 'The AI can look at the files but not change them', level: 'read' },
        { label: 'Ask first', description: 'Reads freely; every edit or command needs your approval, even in auto modes', level: 'ask' },
        { label: 'Full access', description: 'Follows the permission mode (ask / auto / autopilot)', level: 'full' },
        { label: 'No access', description: 'Hide this folder from the AI completely', level: 'none' }
      ],
      { title: `Access level for ${this._pretty(folderPath)}` }
    );
    if (!level) return;
    await this._setFolderLevel(folderPath, level.level);
  },

  async _addSkillFolder() {
    const picked = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      openLabel: 'Use as skills folder',
      title: 'Choose a folder that contains skills (subfolders with SKILL.md)'
    });
    if (!picked || picked.length === 0) return;
    const config = vscode.workspace.getConfiguration('localAI');
    const current = config.get('extraSkillFolders') || [];
    const next = picked[0].fsPath;
    if (!current.includes(next)) {
      await config.update('extraSkillFolders', [...current, next], vscode.ConfigurationTarget.Global);
    }
  },
};
