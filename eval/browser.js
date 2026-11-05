const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

// Opens the project's index.html in a fake browser with its local scripts, and records script errors.
async function openPage(dir, page = 'index.html') {
  const file = path.join(dir, page);
  if (!fs.existsSync(file)) return { error: `${page} is missing` };
  let html = fs.readFileSync(file, 'utf8');
  html = html.replace(/<script([^>]*)\bsrc\s*=\s*["']([^"']+)["']([^>]*)>\s*<\/script>/gi, (all, a, src) => {
    const local = path.join(dir, src.split(/[?#]/)[0]);
    if (/^(https?:)?\/\//.test(src) || !fs.existsSync(local)) return '';
    return `<script${a.replace(/\btype\s*=\s*["']module["']/i, '')}>${fs.readFileSync(local, 'utf8')}</script>`;
  });
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (err) => errors.push(String(err.message || err)));
  virtualConsole.on('error', (...args) => errors.push(args.join(' ')));
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole, url: 'http://localhost/' });
  dom.window.alert = () => {};
  dom.window.prompt = () => null;
  dom.window.confirm = () => true;
  await new Promise((resolve) => {
    if (dom.window.document.readyState === 'complete') return resolve();
    dom.window.addEventListener('load', () => resolve());
    setTimeout(resolve, 1500);
  });
  return { dom, window: dom.window, document: dom.window.document, errors };
}

const ALIASES = {
  '*': ['*', '×', 'x', 'X', '✕'],
  '/': ['/', '÷'],
  '-': ['-', '−', '–'],
  '=': ['=', 'Enter'],
  C: ['C', 'AC', 'CE', 'Clear', 'Очистити']
};

function clickables(document) {
  return [...document.querySelectorAll('button, input[type=button], input[type=submit], [onclick], [data-value], [data-key], [data-num], [data-op], .btn, .button, .key')];
}

function labelOf(el) {
  return String(el.value && el.tagName === 'INPUT' ? el.value : el.textContent || '').trim();
}

// Presses the control whose label (or data value) is `key`. Returns false when there is none.
function press(document, key) {
  const wanted = ALIASES[key] || [key];
  const el = clickables(document).find((b) => {
    const label = labelOf(b);
    const data = b.getAttribute('data-value') || b.getAttribute('data-key') || b.getAttribute('data-num') || b.getAttribute('data-op') || '';
    return wanted.includes(label) || wanted.includes(data);
  });
  if (!el) return false;
  el.dispatchEvent(new el.ownerDocument.defaultView.MouseEvent('click', { bubbles: true }));
  return true;
}

// Everything a user can read on the page: text plus the values of fields.
function visibleText(document) {
  const values = [...document.querySelectorAll('input, textarea, output')].map((el) => el.value || el.textContent || '');
  return `${document.body ? document.body.textContent : ''} ${values.join(' ')}`.replace(/\s+/g, ' ');
}

function displayText(document) {
  const display = document.querySelector('#display, #result, #screen, #output, .display, .result, .screen, .output, input[type=text], input:not([type])');
  if (!display) return '';
  return String(display.value !== undefined && display.tagName === 'INPUT' ? display.value : display.textContent).trim();
}

// Runs a key sequence on a calculator and returns what its display shows.
function calculate(document, keys) {
  press(document, 'C');
  const missing = keys.filter((k) => !press(document, k));
  return { shown: displayText(document), missing };
}

module.exports = { openPage, press, visibleText, displayText, calculate, clickables, labelOf };
