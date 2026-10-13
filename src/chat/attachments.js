const { vscode, fs, path, isVisionModel, isCloudModelName, workspaceLib, cloud, execFile, IMAGE_EXTENSIONS, TEXT_FILE_EXTENSIONS, MAX_TEXT_FILE_CHARS, LANGUAGE_BY_EXTENSION } = require('./common');

// Methods mixed into ChatPanel.prototype (see chatPanel.js).
module.exports = {
  _git(root, args) {
    return new Promise((resolve) => {
      execFile('git', args, { cwd: root, timeout: 15000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : stdout));
    });
  },

  // Attaches what the editor knows about the project: uncommitted git changes or the Problems panel.
  async _attachContext(kind) {
    const root = workspaceLib.resolveWorkingRoot();
    if (!root) {
      vscode.window.showWarningMessage('Open a project folder first.');
      return;
    }
    const cap = (text) => (text.length > MAX_TEXT_FILE_CHARS ? { text: text.slice(0, MAX_TEXT_FILE_CHARS), truncated: true } : { text, truncated: false });
    if (kind === 'git') {
      const diff = await this._git(root, ['diff', 'HEAD', '--no-color', '--stat', '--patch', '--unified=2']);
      if (diff === null) {
        vscode.window.showWarningMessage('Could not read git changes: this folder is not a git repository, or git is not installed.');
        return;
      }
      const status = (await this._git(root, ['status', '--short'])) || '';
      const text = `git status:\n${status}\n${diff}`.trim();
      if (!status.trim() && !diff.trim()) {
        vscode.window.showInformationMessage('There are no uncommitted changes.');
        return;
      }
      const c = cap(text);
      this._post({ type: 'fileAttached', kind: 'text', name: 'Git changes', content: c.text, truncated: c.truncated, language: 'diff' });
      return;
    }
    if (kind === 'problems') {
      const severity = ['Error', 'Warning'];
      const lines = [];
      for (const [uri, list] of vscode.languages.getDiagnostics()) {
        if (!uri || uri.scheme !== 'file') continue;
        const rel = path.relative(root, uri.fsPath);
        if (rel.startsWith('..') || rel.includes('node_modules')) continue;
        for (const d of list) {
          if (d.severity > 1) continue;
          lines.push(`${rel}:${d.range.start.line + 1}:${d.range.start.character + 1} ${severity[d.severity]}: ${d.message}${d.source ? ` (${d.source})` : ''}`);
        }
      }
      if (!lines.length) {
        vscode.window.showInformationMessage('The Problems panel has no errors or warnings.');
        return;
      }
      const c = cap(lines.slice(0, 150).join('\n'));
      this._post({ type: 'fileAttached', kind: 'text', name: 'Problems', content: c.text, truncated: c.truncated || lines.length > 150, language: '' });
    }
  },

  async _handleAttachFile(kind) {
    const modelName = this._context.globalState.get('localAI.selectedModel');
    const supportsVision = isVisionModel(modelName);

    if (kind === 'image' && !supportsVision) {
      vscode.window.showWarningMessage(
        isCloudModelName(modelName)
          ? `The cloud model "${modelName.split(':').slice(2).join(':')}" looks text-only. For pictures pick a vision cloud model, e.g. Llama 4 Scout (Groq) or a Gemini model.`
          : `The model "${modelName}" does not support image understanding. Pick a vision model (e.g. gemma3) to attach pictures.`
      );
      return;
    }

    const extensions = kind === 'image'
      ? ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']
      : TEXT_FILE_EXTENSIONS;

    const root = this._workspaceRoot();
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: true,
      openLabel: 'Attach',
      defaultUri: root ? vscode.Uri.file(root) : undefined,
      filters: {
        [kind === 'image' ? 'Images' : 'Text files']: extensions
      }
    });
    if (!uris || uris.length === 0) return;

    for (const uri of uris) {
      const filePath = uri.fsPath;
      const fileName = path.basename(filePath);
      const ext = path.extname(filePath).toLowerCase();

      try {
        if (IMAGE_EXTENSIONS.has(ext)) {
          const buffer = fs.readFileSync(filePath);
          if (isCloudModelName(modelName) && buffer.length > 3.5 * 1024 * 1024) {
            vscode.window.showWarningMessage(`"${fileName}" is ${(buffer.length / 1048576).toFixed(1)} MB. Cloud providers accept pictures up to about 4 MB: use a smaller image.`);
            return;
          }
          const base64 = buffer.toString('base64');
          const mime = ext === '.jpg' ? 'jpeg' : ext.slice(1);
          this._post({
            type: 'fileAttached',
            kind: 'image',
            name: fileName,
            base64,
            dataUrl: `data:image/${mime};base64,${base64}`
          });
        } else {
          let content = fs.readFileSync(filePath, 'utf8');
          let truncated = false;
          if (content.length > MAX_TEXT_FILE_CHARS) {
            content = content.slice(0, MAX_TEXT_FILE_CHARS);
            truncated = true;
          }
          this._post({
            type: 'fileAttached',
            kind: 'text',
            name: fileName,
            content,
            truncated,
            language: LANGUAGE_BY_EXTENSION[ext] || ''
          });
        }
      } catch (err) {
        this._post({
          type: 'error',
          text: `Could not read the file "${fileName}": ${err.message}`
        });
      }
    }
  },
};
