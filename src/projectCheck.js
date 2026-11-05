const fs = require('fs');
const path = require('path');
const vm = require('vm');

const MAX_FILES = 60;
const MAX_BYTES = 400000;
const MAX_ISSUES = 8;

function read(abs) {
  try {
    const stat = fs.statSync(abs);
    if (!stat.isFile() || stat.size > MAX_BYTES) return null;
    return fs.readFileSync(abs, 'utf8');
  } catch (_) {
    return null;
  }
}

function collect(tools) {
  const html = [];
  const js = [];
  const rels = tools.listSourceFiles(MAX_FILES);
  rels.forEach((rel) => {
    const ext = path.extname(rel).toLowerCase();
    if (!['.html', '.htm', '.js', '.mjs'].includes(ext)) return;
    const text = read(tools.resolve(rel));
    if (text === null) return;
    (ext === '.js' || ext === '.mjs' ? js : html).push({ rel, text });
  });
  return { html, js };
}

function stripComments(code) {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function inlineScripts(htmlText) {
  const out = [];
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(htmlText)) !== null) out.push(m[1]);
  return out;
}

function syntaxIssue(rel, code) {
  if (/^\s*(import|export)\s/m.test(code)) return null;
  try {
    new vm.Script(code, { filename: rel });
    return null;
  } catch (err) {
    const line = /:(\d+)/.exec(err.stack || '');
    return `${rel}: JavaScript syntax error${line ? ` near line ${line[1]}` : ''}: ${err.message}`;
  }
}

// Brace depth at every position of the code, ignoring strings and comments (0 = top level of the script).
function depthAt(code) {
  const depth = new Int16Array(code.length + 1);
  let d = 0;
  let quote = null;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    depth[i] = d;
    if (quote) {
      if (ch === '\\') {
        i++;
        if (i < code.length) depth[i] = d;
      } else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '/' && code[i + 1] === '/') {
      while (i < code.length && code[i] !== '\n') depth[i++] = d;
      continue;
    }
    if (ch === '/' && code[i + 1] === '*') {
      const end = code.indexOf('*/', i + 2);
      const stop = end === -1 ? code.length : end + 2;
      for (; i < stop; i++) depth[i] = d;
      i--;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if (ch === '{') d++;
    else if (ch === '}') d = Math.max(0, d - 1);
  }
  depth[code.length] = d;
  return depth;
}

// Names defined at the top level of a script, which inline onclick="..." handlers can call.
function globalNames(code) {
  const names = new Set();
  const depth = depthAt(code);
  const re = /(?:^|[^.\w$])(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|(?:^|[^.\w$])(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=|window\.([A-Za-z_$][\w$]*)\s*=/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    if (m[3]) names.add(m[3]);
    else if (depth[m.index] === 0) names.add(m[1] || m[2]);
  }
  return names;
}

function run(tools) {
  const issues = [];
  let files;
  try {
    files = collect(tools);
  } catch (_) {
    return issues;
  }
  const { html, js } = files;
  if (!html.length && !js.length) return issues;

  const ids = new Set();
  html.forEach((h) => {
    const re = /\bid\s*=\s*["']([^"']+)["']/gi;
    let m;
    while ((m = re.exec(h.text)) !== null) ids.add(m[1]);
  });

  const allCode = [...js.map((j) => j.text), ...html.flatMap((h) => inlineScripts(h.text))].join('\n');
  const clean = stripComments(allCode);
  const defined = new Set();
  const defRe = /(?:function\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function|\([^)]*\)\s*=>|[\w$]+\s*=>)|(?:window\.|this\.)?([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?function)/g;
  let dm;
  while ((dm = defRe.exec(clean)) !== null) defined.add(dm[1] || dm[2] || dm[3]);

  js.forEach((j) => {
    const issue = syntaxIssue(j.rel, j.text);
    if (issue) issues.push(issue);
  });
  html.forEach((h) => {
    inlineScripts(h.text).forEach((code) => {
      const issue = syntaxIssue(`${h.rel} (inline script)`, code);
      if (issue) issues.push(issue);
    });
  });

  if (html.length) {
    const missingIds = new Set();
    const idUse = /getElementById\(\s*["']([^"']+)["']\s*\)|querySelector\(\s*["']#([\w-]+)["']\s*\)/g;
    let m;
    while ((m = idUse.exec(clean)) !== null) {
      const id = m[1] || m[2];
      if (!ids.has(id)) missingIds.add(id);
    }
    missingIds.forEach((id) => issues.push(`The scripts use the element id "${id}" but no HTML element has id="${id}".`));
  }

  // Per page: functions called from on...= attributes must be top-level names of the scripts THIS page loads.
  const builtins = new Set(['alert', 'confirm', 'prompt', 'eval', 'parseInt', 'parseFloat', 'setTimeout', 'console', 'location', 'history', 'event', 'this', 'return', 'window', 'document']);
  const jsByPath = new Map(js.map((j) => [path.normalize(tools.resolve(j.rel)), j]));
  const loadedBy = new Map();
  html.forEach((h) => {
    const called = new Set();
    const re = /\bon(?:click|change|input|submit|keydown|keyup|load)\s*=\s*["']\s*([A-Za-z_$][\w$]*)\s*\(/gi;
    let m;
    while ((m = re.exec(h.text)) !== null) called.add(m[1]);
    const loaded = [];
    const src = /<script[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi;
    while ((m = src.exec(h.text)) !== null) {
      const abs = path.normalize(path.resolve(path.dirname(tools.resolve(h.rel)), m[1].split(/[?#]/)[0]));
      if (jsByPath.has(abs)) loaded.push(jsByPath.get(abs));
    }
    loaded.forEach((j) => loadedBy.set(j.rel, true));
    const pageCode = [...loaded.map((j) => j.text), ...inlineScripts(h.text)];
    const globals = new Set();
    pageCode.forEach((code) => globalNames(code).forEach((n) => globals.add(n)));
    const inPage = new Set();
    pageCode.forEach((code) => definedNames(code).forEach((n) => inPage.add(n)));
    called.forEach((fn) => {
      if (builtins.has(fn) || globals.has(fn)) return;
      const elsewhere = js.find((j) => !loaded.includes(j) && globalNames(j.text).has(fn));
      if (elsewhere) {
        issues.push(`${h.rel} calls ${fn}() which is in ${elsewhere.rel}, but ${h.rel} does not load ${elsewhere.rel}, so the buttons do nothing. Add <script src="${path.relative(path.dirname(h.rel), elsewhere.rel).split(path.sep).join('/')}"></script> before </body>.`);
      } else if (inPage.has(fn) || defined.has(fn)) {
        issues.push(`${h.rel} calls ${fn}() from an on...= attribute, but the script defines ${fn} inside another function (for example a DOMContentLoaded handler), so the page cannot reach it and the button does nothing. Define ${fn} at the top level of the script, or attach the handler with addEventListener inside that function.`);
      } else {
        issues.push(`${h.rel} calls ${fn}() but no script defines a function named ${fn}.`);
      }
    });
  });
  // A script that works with a page's elements but that no page loads never runs.
  js.forEach((j) => {
    if (loadedBy.has(j.rel) || !html.length || /^\s*(import|export)\s/m.test(j.text)) return;
    if (issues.some((i) => i.includes(`does not load ${j.rel}`))) return;
    const usesPage = /getElementById|querySelector|document\./.test(j.text);
    const importedElsewhere = js.some((o) => o !== j && o.text.includes(path.basename(j.rel)));
    if (usesPage && !importedElsewhere) {
      issues.push(`${j.rel} works with the page, but no HTML file loads it. Add <script src="${j.rel.split(path.sep).join('/')}"></script> before </body> in the page that needs it.`);
    }
  });

  html.forEach((h) => {
    const re = /<script[^>]*\bsrc\s*=\s*["']([^"']+)["']|<link[^>]*\bhref\s*=\s*["']([^"']+\.css)["']/gi;
    let m;
    while ((m = re.exec(h.text)) !== null) {
      const ref = m[1] || m[2];
      if (/^(https?:)?\/\//i.test(ref) || ref.startsWith('data:')) continue;
      const clean2 = ref.split('?')[0].split('#')[0];
      const abs = path.resolve(path.dirname(tools.resolve(h.rel)), clean2);
      let exists = false;
      try {
        exists = fs.existsSync(tools.resolve(path.relative(tools.root, abs) || '.'));
      } catch (_) {
        exists = false;
      }
      if (!exists) issues.push(`${h.rel} refers to "${ref}" but that file does not exist.`);
    }
  });

  return issues.slice(0, MAX_ISSUES);
}

const CONTROL_RE = /<(button|input|select|textarea)\b([^>]*)>/gi;

function controls(htmlText) {
  const out = [];
  let m;
  CONTROL_RE.lastIndex = 0;
  while ((m = CONTROL_RE.exec(String(htmlText || ''))) !== null) {
    const attrs = m[2];
    const type = (/\btype\s*=\s*["']?([\w-]+)/i.exec(attrs) || [])[1] || '';
    if (/^(hidden|submit|reset)$/i.test(type)) continue;
    out.push({
      tag: m[1].toLowerCase(),
      id: (/\bid\s*=\s*["']([^"']+)["']/i.exec(attrs) || [])[1] || '',
      classes: ((/\bclass\s*=\s*["']([^"']+)["']/i.exec(attrs) || [])[1] || '').split(/\s+/).filter(Boolean),
      inline: /\bon[a-z]+\s*=/i.test(attrs),
      attrs: [...attrs.matchAll(/([\w-]+)\s*=/g)].map((a) => a[1].toLowerCase()),
      key: m[0].replace(/\s+/g, ' ')
    });
  }
  return out;
}

// Buttons and fields added by this change that no script uses: a feature that looks done but does nothing
// (a "calculator" made of three buttons without any logic). `code` is all the project's JavaScript.
function deadControls(beforeHtml, afterHtml, code) {
  const before = new Set(controls(beforeHtml).map((c) => c.key));
  const added = controls(afterHtml).filter((c) => !before.has(c.key) && !c.inline);
  if (!added.length) return null;
  const clean = stripComments(String(code || ''));
  // Code that handles clicks for many elements at once (event.target, a selector for all buttons or all
  // [data-...] elements) may well cover the new controls: then nothing can be said for sure.
  const selectors = [...clean.matchAll(/(?:querySelectorAll|querySelector|getElementsByTagName|getElementsByClassName|closest|matches)\(\s*["'`]([^"'`]+)["'`]/g)].map((m) => m[1]);
  if (/\b(?:e|ev|evt|event)\.target\b/.test(clean)) return null;
  const generic = (c) => selectors.some((sel) => sel.split(/[\s,>+~]+/).some((part) => {
    const tag = (part.match(/^([a-z]+)/i) || [])[1];
    const attrs = [...part.matchAll(/\[([\w-]+)/g)].map((m) => m[1]);
    const tagOk = !tag || tag.toLowerCase() === c.tag;
    return tagOk && (attrs.some((a) => c.attrs.includes(a.toLowerCase())) || (tag && !attrs.length && !/[.#]/.test(part)));
  }));
  const used = (c) => (c.id && new RegExp(`["'\`#]${c.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(clean)) ||
    c.classes.some((cls) => new RegExp(`\\.${cls.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b|["'\`]${cls}["'\`]`).test(clean)) ||
    generic(c);
  if (added.some(used)) return null;
  const names = added.map((c) => (c.id ? `#${c.id}` : c.classes.length ? `${c.tag}.${c.classes[0]}` : c.tag)).slice(0, 8);
  return `The new controls (${names.join(', ')}) are not used by any script, so they do nothing. Write the complete logic for this feature in JavaScript (the page's script file or an inline script) and add any buttons it still needs.`;
}

// Buttons and fields with what identifies them for a user: the label of a button, the id or placeholder of a field.
function labelledControls(htmlText) {
  const out = [];
  const text = String(htmlText || '');
  let m;
  const buttons = /<button\b([^>]*)>([\s\S]*?)<\/button>/gi;
  while ((m = buttons.exec(text)) !== null) {
    const id = (/\bid\s*=\s*["']([^"']+)["']/i.exec(m[1]) || [])[1] || '';
    const label = m[2].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
    out.push(label ? `button "${label}"` : id ? `button #${id}` : 'button');
  }
  const fields = /<(input|select|textarea)\b([^>]*)>/gi;
  while ((m = fields.exec(text)) !== null) {
    if (/\btype\s*=\s*["']?hidden/i.test(m[2])) continue;
    const id = (/\bid\s*=\s*["']([^"']+)["']/i.exec(m[2]) || [])[1];
    const hint = (/\b(?:placeholder|value)\s*=\s*["']([^"']+)["']/i.exec(m[2]) || [])[1];
    out.push(id ? `${m[1].toLowerCase()} #${id}` : hint ? `${m[1].toLowerCase()} "${hint}"` : m[1].toLowerCase());
  }
  return out;
}

const REMOVE_WORDS = /(видал|прибер|забер|прибра|удал|убер|убра|remove|delete|drop|get rid)/i;

// Controls that a correction made disappear although the user did not ask to remove anything.
function removedControls(beforeHtml, afterHtml, task) {
  if (REMOVE_WORDS.test(String(task || ''))) return null;
  const left = new Map();
  labelledControls(afterHtml).forEach((c) => left.set(c, (left.get(c) || 0) + 1));
  const gone = [];
  labelledControls(beforeHtml).forEach((c) => {
    const n = left.get(c) || 0;
    if (n > 0) left.set(c, n - 1);
    else gone.push(c);
  });
  if (!gone.length) return null;
  return `This change removed ${gone.slice(0, 10).join(', ')}${gone.length > 10 ? '...' : ''}, but the user did not ask to remove anything. Put them back exactly as they were and only add or change what was asked.`;
}

// Names a change stopped defining while the code still uses them (a rename done only at the definition).
// `others` = [{ rel, text }] of the other scripts and pages of the project.
function orphanNames(rel, before, after, others = []) {
  const lost = [...definedNames(before)].filter((n) => !definedNames(after).has(n));
  const found = [];
  lost.forEach((name) => {
    const re = new RegExp(`(?<![\\w$.])${name.replace(/\$/g, '\\$')}(?![\\w$])`);
    const places = [];
    [{ rel, text: after }, ...others].forEach((file) => {
      String(file.text || '').split('\n').forEach((line, i) => {
        if (re.test(stripComments(line))) places.push(`${file.rel}:${i + 1}`);
      });
    });
    if (places.length) found.push(`${name} is no longer defined but is still used at ${places.slice(0, 5).join(', ')}`);
  });
  return found;
}

function scriptCode(tools) {
  try {
    const { html, js } = collect(tools);
    return [...js.map((j) => j.text), ...html.flatMap((h) => inlineScripts(h.text))].join('\n');
  } catch (_) {
    return '';
  }
}

// Names a piece of code defines (functions, classes, arrow-function constants, Python defs).
function definedNames(text) {
  const names = new Set();
  const patterns = [
    /(?:^|\n)\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g,
    /(?:^|\n)\s*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/g,
    /(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/g,
    /(?:^|\n)\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/g
  ];
  for (const re of patterns) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(String(text || '')))) names.add(m[1]);
  }
  return names;
}

function format(issues) {
  return issues.length ? issues.map((i) => `- ${i}`).join('\n') : '';
}

module.exports = { run, format, definedNames, deadControls, scriptCode, globalNames, removedControls, labelledControls, syntaxIssue, orphanNames };
