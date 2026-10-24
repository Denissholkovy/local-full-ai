const Module = require('module');

const settings = {};

const vscodeStub = {
  EventEmitter: class {
    constructor() {
      this.listeners = [];
      this.event = (fn) => {
        this.listeners.push(fn);
        return { dispose() {} };
      };
    }
    fire(value) {
      this.listeners.forEach((fn) => fn(value));
    }
  },
  workspace: {
    getConfiguration: () => ({ get: (key) => settings[key], update: async () => {} }),
    workspaceFolders: undefined,
    isTrusted: true,
    onDidChangeConfiguration: () => ({ dispose() {} })
  },
  window: {},
  commands: {},
  Uri: { file: (p) => ({ fsPath: p }), joinPath: (...parts) => ({ fsPath: parts.map((p) => p.fsPath || p).join('/') }) },
  ConfigurationTarget: { Global: 1 },
  QuickPickItemKind: { Separator: -1 },
  ProgressLocation: { Notification: 15 },
  ViewColumn: { Beside: -2 },
  StatusBarAlignment: { Left: 1, Right: 2 },
  InlineCompletionItem: class {
    constructor(insertText, range) {
      this.insertText = insertText;
      this.range = range;
    }
  },
  Range: class {
    constructor(start, end) {
      this.start = start;
      this.end = end;
    }
  }
};

const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'vscode') return vscodeStub;
  return load.call(this, request, ...rest);
};

module.exports = { vscodeStub, settings };
