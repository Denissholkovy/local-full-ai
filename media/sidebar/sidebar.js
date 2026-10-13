(function () {
  const ICONS = window.ICONS || {};
  const vscode = acquireVsCodeApi();
  const content = document.getElementById('content');

  const CATEGORIES = [
    { id: 'code', label: 'Code' },
    { id: 'general', label: 'General' },
    { id: 'vision', label: 'Vision' }
  ];

  let state = { view: 'loading' };
  let activeTab = 'code';
  let settingsOpen = false;
  let skillsOpen = false;
  let voiceOpen = false;
  let foldersOpen = false;
  const pulls = {};

  function send(type, extra) {
    vscode.postMessage(Object.assign({ type }, extra || {}));
  }

  function icon(name) {
    return ICONS[name] || '';
  }

  function esc(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatSize(gb) {
    if (!gb) return '';
    return gb < 1 ? Math.round(gb * 1024) + ' MB' : (Math.round(gb * 10) / 10) + ' GB';
  }

  function bind(selector, handler) {
    content.querySelectorAll(selector).forEach((el) => {
      el.onclick = (e) => handler(el, e);
    });
  }

  function renderNotRunning() {
    const installed = !!state.installed;
    let html = '';
    if (installed) {
      html += '<div class="notice warn">' + icon('warning') + '<span><b>Ollama is installed but not running.</b><br><span class="muted">Start it to use your models.</span></span></div>';
      html += '<button class="btn primary" data-act="start">' + icon('play') + ' Start Ollama</button>';
      html += '<button class="btn" data-act="recheck">' + icon('refresh') + ' Check again</button>';
      if (state.binary) html += '<div class="path-hint" title="' + esc(state.binary) + '">Found at ' + esc(state.binary) + '</div>';
    } else {
      html += '<div class="notice warn">' + icon('warning') + '<span><b>Ollama is not installed.</b><br><span class="muted">It runs the models on your computer.</span></span></div>';
      html += '<button class="btn primary" data-act="autoInstall">' + icon('bolt') + ' Install automatically</button>';
      html += '<button class="btn" data-act="download">' + icon('download') + ' Download from website</button>';
      html += '<button class="btn" data-act="recheck">' + icon('refresh') + ' I installed it, check again</button>';
    }
    html += '<div class="footer">';
    html += '<button class="btn danger" data-act="uninstall">' + icon('trash') + ' Uninstall Ollama completely</button>';
    html += '</div>';
    content.innerHTML = html;

    bind('[data-act="start"]', () => {
      state = { view: 'loading', message: 'Starting Ollama...' };
      render();
      send('startOllamaServer');
    });
    bind('[data-act="autoInstall"]', () => send('autoInstallOllama'));
    bind('[data-act="download"]', () => send('openOllamaSite'));
    bind('[data-act="recheck"]', () => {
      state = { view: 'loading', message: 'Checking Ollama...' };
      render();
      send('recheckOllama');
    });
    bind('[data-act="uninstall"]', () => send('uninstallOllama'));
  }

  function tagsHtml(tags) {
    return (tags || []).map((t) => '<span class="tag">' + esc(t) + '</span>').join('');
  }

  function metaHtml(sizeText, tags, extra) {
    const parts = [];
    if (sizeText) parts.push('<span class="size">' + sizeText + '</span>');
    (tags || []).forEach((t) => parts.push('<span class="tag">' + esc(t) + '</span>'));
    if (extra) parts.push(extra);
    return '<div class="card-meta">' + parts.join('') + '</div>';
  }

  function installedRow(m) {
    const isActive = state.selectedModel === m.name;
    const catalog = state.catalog.find((c) => c.name === m.name);
    const title = catalog ? catalog.label : m.name;
    return '<div class="model-card' + (isActive ? ' active' : '') + '">' +
      '<div class="card-main">' +
        '<div class="card-title"><span class="model-name" title="' + esc(m.name) + '">' + esc(title) + '</span></div>' +
        metaHtml(formatSize(m.sizeGB), [].concat(m.quant ? [m.quant] : [], (catalog && catalog.tags) || [])) +
        '<div class="card-desc">' + esc(m.name) + '</div>' +
      '</div>' +
      '<div class="card-actions">' +
        (isActive
          ? '<span class="badge">Active</span>'
          : '<button class="mini-btn" data-act="use" data-model="' + esc(m.name) + '">Use</button>') +
        '<button class="icon-btn" data-act="variants" data-model="' + esc(m.name) + '" title="Other quantizations of this model">' + icon('sliders') + '</button>' +
        '<button class="icon-btn" data-act="delete" data-model="' + esc(m.name) + '" title="Delete model">' + icon('trash') + '</button>' +
      '</div>' +
    '</div>';
  }

  function fitTag(fit) {
    if (fit.best) return '<span class="tag best" title="The strongest model of this kind that runs well on your computer">&#9733; best for your PC</span>';
    switch (fit.level) {
      case 'great': return '<span class="tag ok" title="Runs comfortably on your computer">fits your PC</span>';
      case 'ok': return '<span class="tag ok" title="Fits your computer well">fits your PC</span>';
      case 'tight': return '<span class="tag warn" title="Fits, but little memory is left">tight</span>';
      case 'slow': return '<span class="tag warn" title="Will partly run on the CPU and be slow">slow</span>';
      case 'heavy': return '<span class="tag warn" title="Too heavy for this computer">too heavy</span>';
      default: return '';
    }
  }

  function libraryRow(m) {
    const pull = pulls[m.name];
    const fit = (state.hardware && state.hardware.fits && state.hardware.fits[m.name]) || { level: 'unknown', best: false };
    const heavy = fit.level === 'heavy';
    const pulling = pull && !pull.done;
    return '<div class="model-card' + (heavy ? ' heavy' : '') + '">' +
      '<div class="card-main">' +
        '<div class="card-title"><span class="model-name">' + esc(m.label) + '</span>' +
          (m.recommended ? '<span class="star" title="Recommended">&#9733;</span>' : '') + '</div>' +
        metaHtml(formatSize(m.sizeGB), m.tags, fitTag(fit)) +
        '<div class="card-desc">' + esc(m.description) + '</div>' +
      '</div>' +
      '<div class="card-actions">' +
        (pulling ? '<button class="mini-btn cancel" data-act="cancelPull" data-model="' + esc(m.name) + '" title="Stop downloading"' + (pull.stopping ? ' disabled' : '') + '>' + (pull.stopping ? 'Stopping...' : 'Cancel') + '</button>' : '<button class="icon-btn" data-act="variants" data-model="' + esc(m.name) + '" title="Choose quantization (size vs quality)">' + icon('sliders') + '</button>' +
          '<button class="mini-btn" data-act="install" data-model="' + esc(m.name) + '">Install</button>') +
      '</div>' +
      (pulling
        ? '<div class="pull"><div class="progress-track"><div class="progress-fill" style="width:' + (pull.percent || 0) + '%"></div></div>' +
          '<div class="progress-label">' + esc(pull.status || '') + ' ' + (pull.percent || 0) + '%</div></div>'
        : '') +
    '</div>';
  }

  const SOURCE_LABELS = { project: 'Project', user: 'Your skills', custom: 'Custom folder' };

  function skillsSummary() {
    const sk = state.skills;
    if (!sk) return 'none';
    if (!sk.enabled) return 'Off';
    return sk.skills.length + ' loaded';
  }

  function skillsDetailsHtml() {
    const sk = state.skills;
    if (!sk) return '';
    let html = '<div class="skills-box">';
    html += '<button class="setting" data-act="toggleSkills"><span>Load into chat</span><span class="value">' + (sk.enabled ? 'On' : 'Off') + '</span></button>';
    html += '<button class="setting" data-act="toggleAutoSkills" title="Pick the skills that match each request and give them to any model directly"><span>Apply matching skills automatically</span><span class="value">' + (sk.auto ? 'On' : 'Off') + '</span></button>';
    html += '<button class="setting" data-act="rescanSkills" title="Re-read the skill folders now"><span>Rescan skills</span><span class="value">' + (sk.cache ? sk.cache.cached + ' cached' : '') + '</span></button>';

    html += '<div class="skills-sub">Folders scanned</div>';
    sk.folders.forEach((f) => {
      html += '<div class="folder-row' + (f.exists ? '' : ' missing') + '"' + (f.exists ? ' data-act="revealFolder" data-path="' + esc(f.path) + '"' : '') + ' title="' + esc(f.path) + '">' +
        '<span class="folder-dot"></span>' +
        '<span class="folder-path">' + esc(f.display) + '</span>' +
        '<span class="folder-count">' + (f.exists ? f.used + (f.found !== f.used ? '/' + f.found : '') : 'not found') + '</span>' +
      '</div>';
    });
    html += '<button class="btn link" data-act="addSkillFolder">' + icon('plus') + ' Add skills folder...</button>';

    html += '<div class="skills-sub">' + (sk.enabled ? 'Loaded skills' : 'Found, not loaded') + ' <span class="count">' + sk.skills.length + '</span></div>';
    if (sk.skills.length === 0) {
      html += '<div class="empty">No skills found. A skill is a folder with a SKILL.md file.</div>';
    } else {
      html += '<div class="skill-list' + (sk.enabled ? '' : ' off') + '">';
      sk.skills.forEach((x) => {
        html += '<div class="skill-row" data-act="openSkill" data-path="' + esc(x.file) + '" title="' + esc(x.description || x.name) + '">' +
          '<span class="skill-name">/' + esc(x.name) + '</span>' +
          '<span class="tag">' + esc(SOURCE_LABELS[x.source] || x.source) + '</span>' +
        '</div>';
      });
      html += '</div>';
    }

    if (sk.instructions.length > 0) {
      html += '<div class="skills-sub">Instructions (CLAUDE.md)</div>';
      sk.instructions.forEach((i) => {
        html += '<div class="folder-row" data-act="openSkill" data-path="' + esc(i.path) + '" title="' + esc(i.path) + '">' +
          '<span class="folder-dot"></span><span class="folder-path">' + esc(i.label) + ': ' + esc(i.display) + '</span>' +
          '<span class="folder-count">' + (i.chars > 999 ? (i.chars / 1000).toFixed(1) + 'k' : i.chars) + ' chars</span></div>';
      });
    }
    html += '<div class="skills-note">Matching skills are applied automatically to every model, and the chat tells you which. Type <b>/</b> to apply one by hand. Skills are read once and cached (also between sessions).</div>';
    html += '</div>';
    return html;
  }

  const LEVEL_OPTIONS = [
    { id: 'full', label: 'Full access' },
    { id: 'ask', label: 'Ask first' },
    { id: 'read', label: 'Read only' },
    { id: 'none', label: 'No access' }
  ];
  const KIND_LABELS = { project: 'Project', extra: 'Extra folder', inside: 'Inside project', auto: 'Active file folder' };

  function foldersSummary() {
    const f = state.folders;
    if (!f) return 'none';
    const restricted = f.items.filter((i) => i.level !== 'full').length;
    return f.items.length + (f.items.length === 1 ? ' folder' : ' folders') + (restricted ? ', ' + restricted + ' restricted' : '');
  }

  function foldersDetailsHtml() {
    const f = state.folders;
    if (!f) return '';
    let html = '<div class="skills-box">';
    html += '<div class="skills-sub" style="margin-top:0">Where the AI may work</div>';
    if (f.items.length === 0) {
      html += '<div class="empty">No folder is open. Open a folder in VS Code or add one below.</div>';
    }
    f.items.forEach((i) => {
      html += '<div class="access-row' + (i.exists ? '' : ' missing') + '">' +
        '<div class="access-head"><span class="access-name" title="' + esc(i.path) + '">' + esc(i.name) + '</span>' +
          '<span class="tag">' + esc(KIND_LABELS[i.kind] || i.kind) + '</span>' +
          (i.primary ? '<span class="tag work">Working folder</span>' : '') + '</div>' +
        '<div class="access-path" title="' + esc(i.path) + '">' + esc(i.display) + (i.exists ? '' : ' (not found)') + '</div>' +
        '<div class="access-ctl">' +
          '<select class="level-select" data-act="level" data-path="' + esc(i.path) + '">' +
            LEVEL_OPTIONS.map((o) => '<option value="' + o.id + '"' + (o.id === i.level ? ' selected' : '') + '>' + o.label + '</option>').join('') +
          '</select>' +
          (!i.primary && i.level !== 'none' && i.exists ? '<button class="mini-btn" data-act="workHere" data-path="' + esc(i.path) + '">Work here</button>' : '') +
          (i.removable ? '<button class="icon-btn" data-act="removeFolder" data-path="' + esc(i.path) + '" title="Remove rule">' + icon('trash') + '</button>' : '') +
        '</div>' +
      '</div>';
    });
    if (f.hasOverride) {
      html += '<button class="btn link" data-act="autoWorking">' + icon('refresh') + ' Use the open project automatically</button>';
    }
    html += '<button class="btn link" data-act="addFolder">' + icon('plus') + ' Add or restrict a folder...</button>';
    html += '<div class="skills-note"><b>Full</b> follows your permission mode. <b>Ask first</b> always asks before edits or commands. <b>Read only</b> lets the AI look but not change. <b>No access</b> hides it completely. The deepest matching folder wins, so you can hide a subfolder such as <b>secrets</b> inside a project. Commands run in the working folder, so set it to Read only or No access to block them.</div>';
    html += '</div>';
    return html;
  }

  function voiceSummary() {
    const v = state.voice;
    if (!v) return 'unknown';
    if (v.ready) return 'Installed';
    if (v.whisper || v.model) return 'Incomplete';
    return 'Not installed';
  }

  function voiceDetailsHtml() {
    const v = state.voice;
    if (!v) return '';
    const row = (ok, label, value) =>
      '<div class="folder-row' + (ok ? '' : ' missing') + '" title="' + esc(value || '') + '">' +
        '<span class="folder-dot"></span><span class="folder-path">' + esc(label) + '</span>' +
        '<span class="folder-count">' + esc(value || 'missing') + '</span></div>';
    let html = '<div class="skills-box">';
    html += '<div class="skills-sub" style="margin-top:0">Offline voice input</div>';
    html += row(!!v.whisper, 'Speech recognition (whisper.cpp)', v.whisper ? 'installed' : 'missing');
    html += row(!!v.model, 'Speech model', v.model ? v.modelMB + ' MB' : 'missing');
    html += row(!!v.recorder, 'Recorder', v.recorder || 'missing');
    html += '<div class="skills-note">Works without internet and uses no resources until you press the microphone.</div>';
    if (!v.ready) {
      html += '<button class="btn primary" style="margin-top:10px" data-act="setupVoice">' + icon('download') + ' Set up voice input</button>';
    }
    if (v.modelIsOurs || v.canUninstallWhisper) {
      html += '<button class="btn danger" style="margin-top:6px" data-act="removeVoice">' + icon('trash') + ' Remove voice input...</button>';
    }
    html += '</div>';
    return html;
  }

  function renderReady() {
    const installedNames = new Set(state.installed.map((m) => m.name));
    let html = '';

    if (state.selectedModel && installedNames.has(state.selectedModel)) {
      html += '<div class="notice ok">' + icon('check') + '<span>Active model: <b>' + esc(state.selectedModel) + '</b></span></div>';
      html += '<button class="btn primary" data-act="chat">' + icon('chat') + ' Open chat</button>';
    } else {
      html += '<div class="notice warn">' + icon('warning') + '<span>No model selected. Install or pick one below.</span></div>';
    }

    html += '<div class="section-toggle" data-act="toggleSettings">' +
      (settingsOpen ? icon('chevronDown') : icon('chevronRight')) + '<span>Settings</span></div>';
    if (settingsOpen) {
      html += '<div class="settings-box">';
      const prompt = state.systemPrompt ? state.systemPrompt.slice(0, 40) + (state.systemPrompt.length > 40 ? '...' : '') : 'none';
      html += '<button class="setting" data-act="systemPrompt"><span>System prompt</span><span class="value">' + esc(prompt) + '</span></button>';
      const g = state.generation;
      if (g) {
        html += '<button class="setting" data-act="responseMode"><span>Response mode</span><span class="value">' + esc(g.modeLabel) + '</span></button>';
        html += '<button class="setting" data-act="contextLength"><span>Context length</span><span class="value">' + esc(g.contextLabel) + '</span></button>';
        html += '<button class="setting" data-act="gpuMode"><span>Run on</span><span class="value">' + esc(g.gpuLabel) + '</span></button>';
        html += '<button class="setting" data-act="helperModel"><span>Helper agents model</span><span class="value">' + esc(g.helperLabel) + '</span></button>';
      }
      html += '<button class="setting" data-act="keepAlive"><span>Keep model in RAM</span><span class="value">' + esc(state.keepAlive || '5m (default)') + '</span></button>';
      html += '<button class="setting" data-act="activeFile"><span>Send active file as context</span><span class="value">' + (state.includeActiveFile ? 'On' : 'Off') + '</span></button>';
      html += '<button class="setting" data-act="toggleFoldersOpen"><span>Folder access</span><span class="value">' + esc(foldersSummary()) + ' ' + (foldersOpen ? '&#9652;' : '&#9662;') + '</span></button>';
      html += '<button class="setting" data-act="toggleVoiceOpen"><span>Voice input</span><span class="value">' + esc(voiceSummary()) + ' ' + (voiceOpen ? '&#9652;' : '&#9662;') + '</span></button>';
      html += '<button class="setting" data-act="toggleSkillsOpen"><span>Claude skills</span><span class="value">' + esc(skillsSummary()) + ' ' + (skillsOpen ? '&#9652;' : '&#9662;') + '</span></button>';
      html += '</div>';
      if (foldersOpen) html += foldersDetailsHtml();
      if (voiceOpen) html += voiceDetailsHtml();
      if (skillsOpen) html += skillsDetailsHtml();
    }

    if (state.installed.length > 0) {
      html += '<h3>Installed <span class="count">' + state.installed.length + '</span></h3>';
      state.installed.forEach((m) => { html += installedRow(m); });
    }

    html += '<h3>Get more models</h3>';
    if (state.hardware) {
      html += '<div class="hw-line">Your computer: ' + esc(state.hardware.label) + '. Comfortable model files: up to about ' + state.hardware.comfortGB + ' GB.</div>';
    }
    html += '<div class="tabs">' + CATEGORIES.map((c) =>
      '<button class="tab' + (c.id === activeTab ? ' active' : '') + '" data-act="tab" data-tab="' + c.id + '">' + c.label + '</button>'
    ).join('') + '</div>';

    const available = state.catalog
      .filter((m) => m.category === activeTab && !installedNames.has(m.name))
      .sort((a, b) => Number(!!b.recommended) - Number(!!a.recommended) || a.sizeGB - b.sizeGB);

    if (available.length === 0) {
      html += '<div class="empty">Everything in this category is already installed.</div>';
    } else {
      available.forEach((m) => { html += libraryRow(m); });
    }

    html += '<div class="footer">';
    html += '<button class="btn link" data-act="manual">' + icon('pencil') + ' Install a model by name...</button>';
    html += '<button class="btn danger" data-act="uninstall">' + icon('trash') + ' Uninstall Ollama completely</button>';
    html += '</div>';

    content.innerHTML = html;

    bind('[data-act="chat"]', () => send('openChat'));
    bind('[data-act="toggleSettings"]', () => { settingsOpen = !settingsOpen; render(); });
    bind('[data-act="systemPrompt"]', () => send('editSystemPrompt'));
    bind('[data-act="keepAlive"]', () => send('editKeepAlive'));
    bind('[data-act="activeFile"]', () => send('toggleIncludeActiveFile'));
    bind('[data-act="tab"]', (el) => { activeTab = el.getAttribute('data-tab'); render(); });
    bind('[data-act="install"]', (el) => send('installModel', { modelName: el.getAttribute('data-model') }));
    bind('[data-act="use"]', (el) => send('selectInstalledModel', { modelName: el.getAttribute('data-model') }));
    bind('[data-act="delete"]', (el, e) => {
      e.stopPropagation();
      send('deleteModel', { modelName: el.getAttribute('data-model') });
    });
    bind('[data-act="cancelPull"]', (el, e) => { e.stopPropagation(); if (pulls[el.getAttribute('data-model')]) pulls[el.getAttribute('data-model')].stopping = true; render(); send('cancelPull', { modelName: el.getAttribute('data-model') }); });
    bind('[data-act="variants"]', (el, e) => { e.stopPropagation(); send('chooseVariant', { modelName: el.getAttribute('data-model') }); });
    bind('[data-act="responseMode"]', () => send('chooseResponseMode'));
    bind('[data-act="contextLength"]', () => send('chooseContext'));
    bind('[data-act="gpuMode"]', () => send('chooseGpu'));
    bind('[data-act="helperModel"]', () => send('chooseHelperModel'));
    bind('[data-act="toggleFoldersOpen"]', () => { foldersOpen = !foldersOpen; render(); });
    bind('[data-act="addFolder"]', () => send('addAccessFolder'));
    bind('[data-act="removeFolder"]', (el) => send('removeAccessFolder', { path: el.getAttribute('data-path') }));
    bind('[data-act="workHere"]', (el) => send('setWorkingFolder', { path: el.getAttribute('data-path') }));
    bind('[data-act="autoWorking"]', () => send('setWorkingFolder', { path: null }));
    content.querySelectorAll('select[data-act="level"]').forEach((sel) => {
      sel.onchange = () => send('setFolderLevel', { path: sel.getAttribute('data-path'), level: sel.value });
    });
    bind('[data-act="toggleVoiceOpen"]', () => { voiceOpen = !voiceOpen; render(); });
    bind('[data-act="setupVoice"]', () => send('setupVoice'));
    bind('[data-act="removeVoice"]', () => send('removeVoice'));
    bind('[data-act="toggleSkillsOpen"]', () => { skillsOpen = !skillsOpen; render(); });
    bind('[data-act="toggleSkills"]', () => send('toggleSkills'));
    bind('[data-act="toggleAutoSkills"]', () => send('toggleAutoSkills'));
    bind('[data-act="rescanSkills"]', () => send('rescanSkills'));
    bind('[data-act="addSkillFolder"]', () => send('addSkillFolder'));
    bind('[data-act="openSkill"]', (el) => send('openSkill', { path: el.getAttribute('data-path') }));
    bind('[data-act="revealFolder"]', (el) => send('revealFolder', { path: el.getAttribute('data-path') }));
    bind('[data-act="manual"]', () => send('manualModel'));
    bind('[data-act="uninstall"]', () => send('uninstallOllama'));
  }

  function render() {
    if (state.view === 'notRunning') return renderNotRunning();
    if (state.view === 'ready') return renderReady();
    content.innerHTML = '<div id="loading"><span class="spinner"></span>' + esc(state.message || 'Checking Ollama...') + '</div>';
  }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'ollamaNotRunning':
        state = { view: 'notRunning', installed: msg.installed, binary: msg.binary };
        render();
        break;
      case 'ollamaReady':
        state = {
          view: 'ready',
          installed: msg.installedModels,
          catalog: msg.recommendedModels,
          selectedModel: msg.selectedModel,
          systemPrompt: msg.systemPrompt || '',
          keepAlive: msg.keepAlive || '',
          includeActiveFile: !!msg.includeActiveFile,
          totalRamGB: msg.totalRamGB || 0,
          generation: msg.generation || null,
          hardware: msg.hardware || null,
          voice: msg.voice || null,
          folders: msg.folders || null,
          skills: msg.skills || null
        };
        Object.keys(pulls).forEach((name) => {
          if (pulls[name].done) delete pulls[name];
        });
        render();
        break;
      case 'pullStart':
        pulls[msg.modelName] = { percent: 0, status: 'Starting download...', done: false };
        render();
        break;
      case 'pullProgress':
        pulls[msg.modelName] = { percent: msg.percent, status: msg.status, done: false, stopping: !!(pulls[msg.modelName] && pulls[msg.modelName].stopping) };
        render();
        break;
      case 'pullDone':
        pulls[msg.modelName] = { percent: 100, status: 'Done', done: true };
        break;
      case 'pullError':
      case 'pullCancelled':
        delete pulls[msg.modelName];
        render();
        break;
    }
  });

  window.addEventListener('focus', () => {
    if (state.view === 'ready') send('ready');
  });

  render();
  send('ready');
})();
