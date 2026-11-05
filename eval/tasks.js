const fs = require('fs');
const path = require('path');
const { openPage, press, calculate, visibleText, clickables, labelOf } = require('./browser');

const CALC_HTML = `<!DOCTYPE html>
<html lang="uk">
<head>
  <meta charset="UTF-8">
  <title>Калькулятор</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <h1>Калькулятор</h1>
  <div class="calculator">
    <input type="text" id="display" value="0" readonly>
    <div class="keys">
      <button data-value="7">7</button><button data-value="8">8</button><button data-value="9">9</button><button data-value="/">/</button>
      <button data-value="4">4</button><button data-value="5">5</button><button data-value="6">6</button><button data-value="*">*</button>
      <button data-value="1">1</button><button data-value="2">2</button><button data-value="3">3</button><button data-value="-">-</button>
      <button data-value="0">0</button><button id="clear">C</button><button id="equals">=</button><button data-value="+">+</button>
    </div>
  </div>
  <script src="script.js"></script>
</body>
</html>
`;

const CALC_CSS = `body {
  font-family: sans-serif;
  background: #f4f4f4;
}

.calculator {
  width: 240px;
  margin: 40px auto;
}

#display {
  width: 100%;
  font-size: 24px;
  text-align: right;
}

.keys {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 6px;
}

button {
  padding: 14px;
  font-size: 18px;
}
`;

const calcScript = (minus) => `const display = document.getElementById('display');
let expression = '';

function show(value) {
  display.value = value === '' ? '0' : value;
}

function compute(a, op, b) {
  if (op === '+') return a + b;
  if (op === '-') return ${minus};
  if (op === '*') return a * b;
  if (op === '/') return b === 0 ? NaN : a / b;
  return b;
}

function evaluate(text) {
  const parts = text.match(/(\\d+\\.?\\d*|[+\\-*/])/g) || [];
  let result = Number(parts[0] || 0);
  for (let i = 1; i < parts.length; i += 2) {
    result = compute(result, parts[i], Number(parts[i + 1]));
  }
  return result;
}

document.querySelectorAll('button[data-value]').forEach((button) => {
  button.addEventListener('click', () => {
    expression += button.dataset.value;
    show(expression);
  });
});

document.getElementById('clear').addEventListener('click', () => {
  expression = '';
  show(expression);
});

document.getElementById('equals').addEventListener('click', () => {
  const result = evaluate(expression);
  expression = Number.isFinite(result) ? String(result) : '';
  show(Number.isFinite(result) ? result : 'Error');
});
`;

const TODO_HTML = `<!DOCTYPE html>
<html lang="uk">
<head>
  <meta charset="UTF-8">
  <title>Todo List</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <header>
    <h1>Todo List</h1>
  </header>
  <main>
    <div class="container">
      <input type="text" id="new-task" placeholder="Нова задача">
      <button id="add-task">Додати</button>
      <ul id="task-list"></ul>
    </div>
  </main>
  <footer>
    <p>&copy; 2026 Todo List</p>
  </footer>
  <script src="script.js"></script>
</body>
</html>
`;

const TODO_CSS = `body {
  font-family: sans-serif;
  margin: 0;
}

header, footer {
  background: #333;
  color: #fff;
  padding: 12px;
}

.container {
  max-width: 400px;
  margin: 20px auto;
}

#add-task {
  background: #2196f3;
  color: #fff;
  border: none;
  padding: 8px 14px;
}

.completed {
  text-decoration: line-through;
}
`;

const TODO_JS = `document.addEventListener('DOMContentLoaded', () => {
  const taskInput = document.getElementById('new-task');
  const addButton = document.getElementById('add-task');
  const taskList = document.getElementById('task-list');

  addButton.addEventListener('click', addTask);

  function addTask() {
    const taskText = taskInput.value.trim();
    if (taskText === '') return;
    const li = document.createElement('li');
    li.textContent = taskText;
    li.addEventListener('click', toggleTask);
    taskList.appendChild(li);
    taskInput.value = '';
  }

  function toggleTask(event) {
    event.target.classList.toggle('completed');
  }
});
`;

const calcProject = (minus = 'a - b') => ({ 'index.html': CALC_HTML, 'style.css': CALC_CSS, 'script.js': calcScript(minus) });
const todoProject = () => ({ 'index.html': TODO_HTML, 'style.css': TODO_CSS, 'script.js': TODO_JS });

// Every #hex, rgb() and hsl() colour in a text, as [hue, saturation, lightness].
function colors(text) {
  const out = [];
  for (const m of text.matchAll(/#([0-9a-f]{3}|[0-9a-f]{6})\b/gi)) {
    const h = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1];
    out.push(hsl(parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)));
  }
  for (const m of text.matchAll(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/gi)) out.push(hsl(+m[1], +m[2], +m[3]));
  for (const m of text.matchAll(/hsla?\(\s*(\d+)\s*,\s*(\d+)%\s*,\s*(\d+)%/gi)) out.push([+m[1], +m[2] / 100, +m[3] / 100]);
  return out;
}

function hsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

function isGreen([h, s, l]) {
  return h >= 80 && h <= 170 && s >= 0.25 && l >= 0.15 && l <= 0.85;
}

function read(dir, rel) {
  try {
    return fs.readFileSync(path.join(dir, rel), 'utf8');
  } catch (_) {
    return null;
  }
}

async function calcWorks(dir, cases) {
  const page = await openPage(dir);
  if (page.error) return [{ name: page.error, ok: false }];
  const checks = cases.map(([keys, expected]) => {
    const { shown, missing } = calculate(page.document, keys);
    return { name: `${keys.join(' ')} → ${expected}${missing.length ? ` (no button ${missing.join(',')})` : ''} (shows "${shown}")`, ok: !missing.length && shown.replace(/\s/g, '') === expected };
  });
  checks.push({ name: 'no script errors on the page', ok: page.errors.length === 0, detail: page.errors.slice(0, 3) });
  return checks;
}

async function todoWorks(dir) {
  const page = await openPage(dir);
  if (page.error) return [{ name: page.error, ok: false }];
  const { document, window } = page;
  const input = document.querySelector('input[type=text], input:not([type])');
  const add = clickables(document).find((b) => /додати|add/i.test(labelOf(b)));
  const before = document.querySelectorAll('li').length;
  if (input && add) {
    input.value = 'Купити хліб';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    add.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  }
  const items = [...document.querySelectorAll('li')];
  const added = items.find((li) => li.textContent.includes('Купити хліб'));
  if (added) added.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  return [
    { name: 'has a text field and an Add button', ok: !!(input && add) },
    { name: 'adding a task shows it in the list', ok: !!added && items.length > before },
    { name: 'clicking a task marks it done', ok: !!added && (added.className.length > 0 || /line-through/.test(added.getAttribute('style') || '')) },
    { name: 'no script errors on the page', ok: page.errors.length === 0, detail: page.errors.slice(0, 3) }
  ];
}

// Each task: a starting project, the user's message, the files the change may touch, and checks of the result.
const TASKS = [
  {
    id: 'new-calculator',
    kind: 'new',
    seed: {},
    prompt: 'Зроби простий калькулятор: index.html, style.css, script.js. Кнопки цифр 0-9, + - * /, = і C, дисплей показує результат.',
    check: (dir) => calcWorks(dir, [[['7', '+', '8', '='], '15'], [['9', '-', '4', '='], '5'], [['6', '*', '7', '='], '42']])
  },
  {
    id: 'new-todo',
    kind: 'new',
    seed: {},
    prompt: 'Зроби туду-список: index.html, style.css, script.js. Поле вводу, кнопка "Додати", список задач; клік по задачі позначає її виконаною.',
    check: (dir) => todoWorks(dir)
  },
  {
    id: 'edit-button-color',
    kind: 'edit',
    seed: todoProject(),
    allowed: ['style.css', 'index.html'],
    prompt: 'Зроби кнопку "Додати" зеленою.',
    check: async (dir) => {
      const css = `${read(dir, 'style.css') || ''}\n${read(dir, 'index.html') || ''}`;
      const green = /\b(green|lime|forestgreen|seagreen|limegreen|darkgreen|mediumseagreen)\b/i.test(css) || colors(css).some(isGreen);
      return [{ name: 'the Add button is green', ok: green }, ...(await todoWorks(dir))];
    }
  },
  {
    id: 'edit-heading',
    kind: 'edit',
    seed: todoProject(),
    allowed: ['index.html'],
    prompt: 'Зміни заголовок на "Мої справи".',
    check: async (dir) => {
      const html = read(dir, 'index.html') || '';
      return [{ name: 'heading says "Мої справи"', ok: /<h1[^>]*>\s*Мої справи\s*<\/h1>/i.test(html) }, ...(await todoWorks(dir))];
    }
  },
  {
    id: 'edit-add-percent',
    kind: 'edit',
    seed: calcProject(),
    allowed: ['index.html', 'script.js', 'style.css'],
    prompt: 'Додай у калькулятор кнопку % (ділить поточне число на 100).',
    check: async (dir) => {
      const checks = await calcWorks(dir, [[['7', '+', '8', '='], '15'], [['9', '-', '4', '='], '5']]);
      const page = await openPage(dir);
      let percent = false;
      if (!page.error) {
        press(page.document, 'C');
        ['5', '0'].forEach((k) => press(page.document, k));
        percent = press(page.document, '%') && /^0\.5$/.test(require('./browser').displayText(page.document));
      }
      return [{ name: '5 0 % → 0.5', ok: percent }, ...checks];
    }
  },
  {
    id: 'fix-minus-bug',
    kind: 'edit',
    seed: calcProject('a + b'),
    allowed: ['script.js'],
    prompt: 'Віднімання не працює: 9-4 показує 13. Виправ.',
    check: (dir) => calcWorks(dir, [[['9', '-', '4', '='], '5'], [['7', '+', '8', '='], '15'], [['6', '*', '7', '='], '42']])
  },
  {
    id: 'rename-function',
    kind: 'edit',
    seed: todoProject(),
    allowed: ['script.js'],
    prompt: 'Перейменуй функцію addTask на createTask всюди.',
    check: async (dir) => {
      const js = read(dir, 'script.js') || '';
      return [
        { name: 'no addTask left', ok: !/\baddTask\b/.test(js) },
        { name: 'createTask is defined', ok: /function\s+createTask\b|createTask\s*=/.test(js) },
        ...(await todoWorks(dir))
      ];
    }
  },
  {
    id: 'question',
    kind: 'question',
    seed: todoProject(),
    allowed: [],
    prompt: 'Що робить script.js? Коротко.',
    check: async (dir, run) => [{ name: 'gives an answer', ok: /задач|task|спис|list/i.test(run.answer || '') }]
  }
];

module.exports = { TASKS, calcProject, todoProject };
