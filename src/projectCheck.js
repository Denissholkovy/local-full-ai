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

  const calledByHtml = new Set();
  html.forEach((h) => {
    const re = /\bon(?:click|change|input|submit|keydown|keyup|load)\s*=\s*["']\s*([A-Za-z_$][\w$]*)\s*\(/gi;
    let m;
    while ((m = re.exec(h.text)) !== null) calledByHtml.add(m[1]);
  });
  const builtins = new Set(['alert', 'confirm', 'prompt', 'eval', 'parseInt', 'parseFloat', 'setTimeout', 'console', 'location', 'history', 'event']);
  calledByHtml.forEach((fn) => {
    if (!defined.has(fn) && !builtins.has(fn)) issues.push(`The HTML calls ${fn}() but no script defines a function named ${fn}.`);
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

function format(issues) {
  return issues.length ? issues.map((i) => `- ${i}`).join('\n') : '';
}

module.exports = { run, format };
