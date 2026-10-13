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
  let cloudOpen = true;
  let mainTab = null;
  let providersOpen = false;
  let othersOpen = false;
  let moreOpen = false;
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

  // How much to trust a model with agent work (reading and editing the project), from its size and tool support.
  function agentTag(sizeGB, hasTools) {
    if (hasTools === false) return '<span class="tag warn" title="This model cannot call tools: it can only write code into files, not read or search your project.">no tools</span>';
    if (!sizeGB) return '';
    if (sizeGB < 3) return '<span class="tag warn" title="Very small: fine for chatting and tiny edits, unreliable for project work.">weak for agent</span>';
    if (sizeGB < 6.5) return '<span class="tag" title="Small model: ok for simple tasks and short files, may claim to edit without doing it.">basic agent</span>';
    return '<span class="tag ok" title="Large enough to work on a project reliably.">agent-ready</span>';
  }

  function cloudTierTag(m) {
    if (m.tier === 'notools') return '<span class="tag warn" title="This model cannot call tools.">no tools</span>';
    if (m.tier === 'weak') return '<span class="tag warn" title="Small or fast model: weaker at agent tasks.">weak for agent</span>';
    if (m.tier === 'best') return '<span class="tag ok" title="Strong at code and tools.">agent-ready</span>';
    return '';
  }

  function cloudModelCard(m) {
    const isActive = state.selectedModel === m.name;
    const def = (state.cloud && state.cloud.providers.find((p) => p.id === m.providerId)) || { name: m.providerId };
    return '<div class="model-card cloud' + (isActive ? ' active' : '') + '">' +
      '<div class="card-main">' +
        '<div class="card-title"><span class="model-name" title="' + esc(m.modelId) + '">' + esc(m.modelId) + '</span></div>' +
        '<div class="card-meta"><span class="tag cloud-tag">cloud</span><span class="size">' + esc(def.name) + '</span>' + cloudTierTag(m) + (m.vision ? '<span class="tag" title="Can look at pictures">vision</span>' : '') + '</div>' +
        '<div class="card-desc">Your messages are sent to ' + esc(def.name) + '. Free-tier limits apply.</div>' +
      '</div>' +
      '<div class="card-actions">' +
        (isActive ? '<span class="badge">Active</span>' : '<button class="mini-btn" data-act="use" data-model="' + esc(m.name) + '">Use</button>') +
        '<button class="icon-btn" data-act="cloudRemoveModel" data-model="' + esc(m.name) + '" title="Remove this cloud model">' + icon('trash') + '</button>' +
      '</div>' +
    '</div>';
  }

  function cloudSectionHtml() {
    const c = state.cloud;
    if (!c) return '';
    let html = '<h3>Cloud models (free) <span class="count">' + c.models.length + '</span></h3>';
    if (c.models.length === 0) {
      html += '<div class="cloud-intro">Local models too weak or slow? Connect a free cloud provider (Groq, OpenRouter, Google Gemini and others) with your own free API key. Your prompts then leave this computer. Local models stay the default.</div>';
    } else {
      c.models.forEach((m) => { html += cloudModelCard(m); });
    }
    html += '<button class="btn" data-act="cloudConnect">' + icon('plus') + (c.models.length ? ' Add cloud models...' : ' Connect a cloud provider...') + '</button>';
    return html;
  }

  function limitsHtml(p) {
    if (!p.hasKey) return '';
    const l = p.limits;
    if (!l || !l.items || l.items.length === 0) {
      return '<div class="limit-line muted">Remaining quota appears here after your first answer.</div>';
    }
    const rows = l.items.map((i) => {
      const left = i.remaining !== null && i.remaining !== undefined ? i.remaining : '?';
      const total = i.limit !== null && i.limit !== undefined ? i.limit : '?';
      const frac = i.limit && i.remaining !== null ? i.remaining / i.limit : null;
      const cls = frac !== null && frac < 0.1 ? ' low' : frac !== null && frac < 0.3 ? ' mid' : '';
      return '<div class="limit-row' + cls + '"><span>' + esc(i.label) + '</span><span>' + esc(left) + ' / ' + esc(total) + (i.reset ? ' &middot; resets in ' + esc(i.reset) : '') + '</span></div>';
    }).join('');
    return '<div class="limit-box">' + rows + '<div class="limit-line muted">Updated ' + new Date(l.at).toLocaleTimeString() + (l.retryAfter ? ' &middot; asked to wait ' + esc(l.retryAfter) : '') + '</div></div>';
  }

  function providerCardHtml(p, hasModels) {
    let html = '<div class="access-row prov on">' +
      '<div class="access-head"><span class="access-name">' + esc(p.name) + '</span><span class="tag ok">connected</span></div>' +
      '<div class="prov-note">' + esc(p.note) + '</div>' +
      limitsHtml(p) +
      '<div class="access-ctl cloud-ctl">' +
        '<button class="mini-btn" data-act="cloudPickModels" data-provider="' + p.id + '">' + (hasModels ? 'Change models' : 'Choose models') + '</button>' +
        (p.canCheck ? '<button class="mini-btn" data-act="cloudCheckLimits" data-provider="' + p.id + '" title="Ask the provider how much credit and quota is left">Check limits</button>' : '') +
        '<button class="mini-btn" data-act="cloudSetKey" data-provider="' + p.id + '">Change key</button>' +
        '<button class="icon-btn" data-act="cloudRemoveKey" data-provider="' + p.id + '" title="Disconnect: remove the key and its models">' + icon('trash') + '</button>' +
      '</div>';
    if (p.hasLimits) {
      html += '<a class="prov-link" href="#" data-act="cloudOpenPage" data-provider="' + p.id + '" data-which="limits">Free-tier limits of ' + esc(p.name) + ' &#8599;</a>';
    }
    return html + '</div>';
  }

  function providerRowHtml(p) {
    return '<div class="prov-row">' +
      '<div class="prov-row-main"><span class="access-name">' + esc(p.name) + '</span><div class="prov-note">' + esc(p.note) + '</div></div>' +
      '<div class="prov-row-actions">' +
        '<button class="mini-btn primary" data-act="cloudSetKey" data-provider="' + p.id + '">Connect</button>' +
        (p.hasKeyPage ? '<a class="prov-link" href="#" data-act="cloudOpenPage" data-provider="' + p.id + '" data-which="key">Get free key &#8599;</a>' : '') +
      '</div>' +
    '</div>';
  }

  function cloudDetailsHtml() {
    const c = state.cloud;
    if (!c) return '';
    const connected = c.providers.filter((p) => p.hasKey);
    const others = c.providers.filter((p) => !p.hasKey);
    let html = '<div class="skills-box">';
    connected.forEach((p) => { html += providerCardHtml(p, c.models.some((m) => m.providerId === p.id)); });
    if (others.length) {
      const open = providersOpen || connected.length === 0;
      if (connected.length) {
        html += '<div class="section-toggle sub" data-act="toggleProvidersOpen">' + (open ? icon('chevronDown') : icon('chevronRight')) +
          '<span>Add another provider (' + others.length + ')</span></div>';
      }
      if (open) others.forEach((p) => { html += providerRowHtml(p); });
    }
    html += '<div class="skills-note">Keys are kept in VS Code\'s secret storage. Free limits and data policies belong to each provider and change over time. Never use a cloud model for code you must keep private.</div>';
    html += '</div>';
    return html;
  }

  function bindCloud() {
    bind('[data-act="cloudConnect"]', () => send('cloudConnect'));
    bind('[data-act="cloudRemoveModel"]', (el, e) => { e.stopPropagation(); send('cloudRemoveModel', { name: el.getAttribute('data-model') }); });
    bind('[data-act="cloudSetKey"]', (el) => send('cloudSetKey', { providerId: el.getAttribute('data-provider') }));
    bind('[data-act="cloudPickModels"]', (el) => send('cloudPickModels', { providerId: el.getAttribute('data-provider') }));
    bind('[data-act="cloudRemoveKey"]', (el) => send('cloudRemoveKey', { providerId: el.getAttribute('data-provider') }));
    bind('[data-act="cloudCheckLimits"]', (el) => send('cloudCheckLimits', { providerId: el.getAttribute('data-provider') }));
    bind('[data-act="cloudOpenPage"]', (el, e) => { e.preventDefault(); send('cloudOpenPage', { providerId: el.getAttribute('data-provider'), which: el.getAttribute('data-which') }); });
    bind('[data-act="toggleOthersOpen"]', () => { othersOpen = !othersOpen; render(); });
    bind('[data-act="toggleMoreOpen"]', () => { moreOpen = !moreOpen; render(); });
    bind('[data-act="toggleProvidersOpen"]', () => { providersOpen = !providersOpen; render(); });
    bind('[data-act="toggleCloudOpen"]', () => { cloudOpen = !cloudOpen; render(); });
  }

  function localOffHtml() {
    let html = '<div class="notice warn">' + icon('warning') + '<span><b>' + (state.installed ? 'Ollama is installed but not running.' : 'Ollama is not installed.') +
      '</b><br><span class="muted">It runs the models on this computer. Not needed if you only use cloud models.</span></span></div>';
    if (state.installed) {
      html += '<button class="btn primary" data-act="start">' + icon('play') + ' Start Ollama</button>';
      html += '<button class="btn" data-act="recheck">' + icon('refresh') + ' Check again</button>';
      if (state.binary) html += '<div class="path-hint" title="' + esc(state.binary) + '">Found at ' + esc(state.binary) + '</div>';
    } else {
      html += '<button class="btn primary" data-act="autoInstall">' + icon('bolt') + ' Install automatically</button>';
      html += '<button class="btn" data-act="download">' + icon('download') + ' Download from website</button>';
      html += '<button class="btn" data-act="recheck">' + icon('refresh') + ' I installed it, check again</button>';
    }
    return html;
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
        metaHtml(formatSize(m.sizeGB), [].concat(m.quant ? [m.quant] : [], (catalog && catalog.tags) || []), agentTag(m.sizeGB, catalog ? (catalog.tags || []).includes('tools') : undefined)) +
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
        metaHtml(formatSize(m.sizeGB), m.tags, fitTag(fit) + (m.category === 'vision' ? '' : agentTag(m.sizeGB, (m.tags || []).includes('tools')))) +
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
    if (v.engine === 'groq') return v.ready ? 'Groq (cloud)' : 'Needs a recorder';
    if (v.ready) return 'Local';
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
    html += '<div class="skills-sub" style="margin-top:0">Voice input</div>';
    html += '<button class="setting" data-act="voiceEngine"><span>Speech recognition</span><span class="value">' + (v.engine === 'groq' ? 'Groq (cloud)' : 'Local (offline)') + '</span></button>';
    if (v.engine === 'groq') {
      html += row(!!v.recorder, 'Recorder', v.recorder || 'missing');
      html += '<div class="skills-note">Each recording is sent to Groq (whisper-large-v3-turbo) and uses your Groq free limits. Needs the Groq key from the Cloud tab.</div></div>';
      return html;
    }
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

  function isCloudName(name) {
    return typeof name === 'string' && name.indexOf('cloud:') === 0;
  }

  function describeModel(name) {
    if (!name) return null;
    if (isCloudName(name)) {
      const rest = name.slice(6);
      const idx = rest.indexOf(':');
      const providerId = rest.slice(0, idx);
      const provider = state.cloud && state.cloud.providers.find((p) => p.id === providerId);
      return { cloud: true, label: rest.slice(idx + 1), where: provider ? provider.name : providerId };
    }
    return { cloud: false, label: name, where: 'this computer' };
  }

  function bannerHtml() {
    const m = describeModel(state.selectedModel);
    if (!m) {
      return '<div class="notice warn">' + icon('warning') + '<span>No model selected. Pick one in the <b>This computer</b> or <b>Cloud</b> tab below.</span></div>';
    }
    const localDown = !m.cloud && state.view === 'notRunning';
    const cls = m.cloud ? 'cloud' : 'local';
    const badge = m.cloud ? 'CLOUD &middot; ' + esc(m.where) : 'LOCAL &middot; this computer';
    const hint = m.cloud
      ? 'Online. Your messages and the files it reads are sent to ' + esc(m.where) + '.'
      : localDown
        ? 'Ollama is not running. Start it in the <b>This computer</b> tab.'
        : 'Runs on this computer. Nothing leaves it.';
    return '<div class="active-card ' + cls + (localDown ? ' off' : '') + '">' +
      '<div class="active-top"><span class="where-badge ' + cls + '">' + badge + '</span><span class="active-label">Active model</span></div>' +
      '<div class="active-name" title="' + esc(m.label) + '">' + esc(m.label) + '</div>' +
      '<div class="active-hint">' + hint + '</div>' +
    '</div>' +
    '<button class="btn primary" data-act="chat">' + icon('chat') + ' Open chat</button>';
  }

  function currentTab() {
    return mainTab || (isCloudName(state.selectedModel) ? 'cloud' : 'local');
  }

  function mainTabsHtml(tab) {
    const localCount = state.view === 'ready' ? state.installed.length + ' installed' : 'off';
    const cloudCount = state.cloud ? state.cloud.models.length + ' added' : '';
    return '<div class="main-tabs">' +
      '<button class="main-tab local' + (tab === 'local' ? ' active' : '') + '" data-act="mainTab" data-tab="local"><span class="tab-title">This computer</span><span class="tab-sub">' + localCount + '</span></button>' +
      '<button class="main-tab cloud' + (tab === 'cloud' ? ' active' : '') + '" data-act="mainTab" data-tab="cloud"><span class="tab-title">Cloud</span><span class="tab-sub">' + esc(cloudCount) + '</span></button>' +
    '</div>';
  }

  // Same look as the section headings, but clickable: the list below opens and closes.
  function toggleHtml(act, open, label, count) {
    return '<h3 class="collapsible" data-act="' + act + '"><span class="chev">' + (open ? icon('chevronDown') : icon('chevronRight')) + esc(label) + '</span>' +
      (count !== undefined ? '<span class="count">' + count + '</span>' : '') + '</h3>';
  }

  function localPanelHtml() {
    let html = '<div class="panel-note local">Models that run on this computer through Ollama. Private and free, no internet needed.</div>';
    if (state.view !== 'ready') {
      html += localOffHtml();
      html += '<div class="footer"><button class="btn danger" data-act="uninstall">' + icon('trash') + ' Uninstall Ollama completely</button></div>';
      return html;
    }
    const installedNames = new Set(state.installed.map((m) => m.name));
    const active = state.installed.find((m) => m.name === state.selectedModel);
    const others = state.installed.filter((m) => m !== active);
    if (active) html += installedRow(active);
    if (others.length > 0) {
      html += toggleHtml('toggleOthersOpen', othersOpen || !active, active ? 'Other installed' : 'Installed', others.length);
      if (othersOpen || !active) others.forEach((m) => { html += installedRow(m); });
    }
    if (state.installed.length === 0) html += '<div class="empty">No model installed yet. Open "Get more models" below.</div>';

    const downloading = Object.keys(pulls).some((n) => !pulls[n].done);
    const open = moreOpen || downloading || state.installed.length === 0;
    html += toggleHtml('toggleMoreOpen', open, 'Get more models');
    if (open) {
      if (state.hardware) {
        html += '<div class="hw-line">Your computer: ' + esc(state.hardware.label) + '. Comfortable model files: up to about ' + state.hardware.comfortGB + ' GB.</div>';
      }
      html += '<div class="tabs">' + CATEGORIES.map((c) =>
        '<button class="tab' + (c.id === activeTab ? ' active' : '') + '" data-act="tab" data-tab="' + c.id + '">' + c.label + '</button>'
      ).join('') + '</div>';
      const available = state.catalog
        .filter((m) => m.category === activeTab && !installedNames.has(m.name))
        .sort((a, b) => Number(!!b.recommended) - Number(!!a.recommended) || a.sizeGB - b.sizeGB);
      if (available.length === 0) html += '<div class="empty">Everything in this category is already installed.</div>';
      else available.forEach((m) => { html += libraryRow(m); });
      html += '<button class="btn link" data-act="manual">' + icon('pencil') + ' Install a model by name...</button>';
      html += '<div class="footer"><button class="btn danger" data-act="uninstall">' + icon('trash') + ' Uninstall Ollama completely</button></div>';
    }
    return html;
  }

  function cloudPanelHtml() {
    let html = '<div class="panel-note cloud">Models that run online at a provider with its own free tier. They are stronger but your messages leave this computer, and free limits apply.</div>';
    html += cloudSectionHtml();
    html += '<h3>Providers</h3>' + cloudDetailsHtml();
    return html;
  }

  function scopeRow(label, value, act, scope) {
    return '<button class="setting" data-act="' + act + '"><span>' + label + '</span><span class="value">' + esc(value) + '</span></button>';
  }

  function settingsHtml() {
    let html = '<div class="section-toggle" data-act="toggleSettings">' +
      (settingsOpen ? icon('chevronDown') : icon('chevronRight')) + '<span>Settings (local and cloud)</span></div>';
    if (!settingsOpen) return html;
    const g = state.generation || {};
    const prompt = state.systemPrompt ? state.systemPrompt.slice(0, 40) + (state.systemPrompt.length > 40 ? '...' : '') : 'none';
    html += '<div class="settings-group"><span class="scope-tag both">Both</span> work with any model</div>';
    html += '<div class="settings-box">';
    html += scopeRow('System prompt', prompt, 'systemPrompt');
    html += scopeRow('Response mode', g.modeLabel || '', 'responseMode');
    html += scopeRow('Send active file as context', state.includeActiveFile ? 'On' : 'Off', 'activeFile');
    html += scopeRow('Helper agents model', g.helperLabel || '', 'helperModel');
    html += '<button class="setting" data-act="toggleFoldersOpen"><span>Folder access</span><span class="value">' + esc(foldersSummary()) + ' ' + (foldersOpen ? '&#9652;' : '&#9662;') + '</span></button>';
    html += '<button class="setting" data-act="toggleSkillsOpen"><span>Claude skills</span><span class="value">' + esc(skillsSummary()) + ' ' + (skillsOpen ? '&#9652;' : '&#9662;') + '</span></button>';
    html += '<button class="setting" data-act="toggleVoiceOpen"><span>Voice input</span><span class="value">' + esc(voiceSummary()) + ' ' + (voiceOpen ? '&#9652;' : '&#9662;') + '</span></button>';
    html += '</div>';
    if (foldersOpen) html += foldersDetailsHtml();
    if (skillsOpen) html += skillsDetailsHtml();
    if (voiceOpen) html += voiceDetailsHtml();

    html += '<div class="settings-group"><span class="scope-tag local">Local</span> only models on this computer</div>';
    html += '<div class="settings-box">';
    html += scopeRow('Context length', g.contextLabel || '', 'contextLength');
    html += scopeRow('Run on', g.gpuLabel || '', 'gpuMode');
    html += scopeRow('Keep model in RAM', state.keepAlive || '5m (default)', 'keepAlive');
    html += '</div>';

    html += '<div class="settings-group"><span class="scope-tag cloud">Cloud</span> only online models</div>';
    html += '<div class="settings-box">';
    html += scopeRow('Cloud context size', g.cloudContextLabel || '', 'cloudContext');
    html += '</div>';
    return html;
  }

  function bindAll() {
    bind('[data-act="chat"]', () => send('openChat'));
    bind('[data-act="mainTab"]', (el) => { mainTab = el.getAttribute('data-tab'); render(); });
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
    bind('[data-act="cloudContext"]', () => send('chooseCloudContext'));
    bind('[data-act="gpuMode"]', () => send('chooseGpu'));
    bind('[data-act="helperModel"]', () => send('chooseHelperModel'));
    bindCloud();
    bind('[data-act="toggleFoldersOpen"]', () => { foldersOpen = !foldersOpen; render(); });
    bind('[data-act="addFolder"]', () => send('addAccessFolder'));
    bind('[data-act="removeFolder"]', (el) => send('removeAccessFolder', { path: el.getAttribute('data-path') }));
    bind('[data-act="workHere"]', (el) => send('setWorkingFolder', { path: el.getAttribute('data-path') }));
    bind('[data-act="autoWorking"]', () => send('setWorkingFolder', { path: null }));
    content.querySelectorAll('select[data-act="level"]').forEach((sel) => {
      sel.onchange = () => send('setFolderLevel', { path: sel.getAttribute('data-path'), level: sel.value });
    });
    bind('[data-act="toggleVoiceOpen"]', () => { voiceOpen = !voiceOpen; render(); });
    bind('[data-act="voiceEngine"]', () => send('chooseVoiceEngine'));
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
    bind('[data-act="start"]', () => {
      state = Object.assign({}, state, { view: 'loading', message: 'Starting Ollama...' });
      render();
      send('startOllamaServer');
    });
    bind('[data-act="autoInstall"]', () => send('autoInstallOllama'));
    bind('[data-act="download"]', () => send('openOllamaSite'));
    bind('[data-act="recheck"]', () => {
      state = Object.assign({}, state, { view: 'loading', message: 'Checking Ollama...' });
      render();
      send('recheckOllama');
    });
  }

  function render() {
    if (state.view === 'loading' || !state.view) {
      content.innerHTML = '<div id="loading"><span class="spinner"></span>' + esc(state.message || 'Checking Ollama...') + '</div>';
      return;
    }
    const tab = currentTab();
    let html = bannerHtml();
    html += settingsHtml();
    html += '<div class="divider"></div>';
    html += mainTabsHtml(tab);
    html += tab === 'cloud' ? cloudPanelHtml() : localPanelHtml();
    content.innerHTML = html;
    bindAll();
  }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'ollamaNotRunning':
      case 'ollamaReady': {
        const ready = msg.type === 'ollamaReady';
        state = {
          view: ready ? 'ready' : 'notRunning',
          installed: ready ? msg.installedModels : !!msg.installed,
          binary: msg.binary,
          catalog: ready ? msg.recommendedModels : [],
          selectedModel: msg.selectedModel || null,
          systemPrompt: msg.systemPrompt || '',
          keepAlive: msg.keepAlive || '',
          includeActiveFile: !!msg.includeActiveFile,
          totalRamGB: msg.totalRamGB || 0,
          cloud: msg.cloud || null,
          generation: msg.generation || null,
          hardware: ready ? msg.hardware || null : null,
          voice: msg.voice || null,
          folders: msg.folders || null,
          skills: msg.skills || null
        };
        if (!ready) state.installed = !!msg.installed;
        Object.keys(pulls).forEach((name) => {
          if (pulls[name].done) delete pulls[name];
        });
        render();
        break;
      }
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
    if (state.view === 'ready' || state.view === 'notRunning') send('ready');
  });

  render();
  send('ready');
})();
