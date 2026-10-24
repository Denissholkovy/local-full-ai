const PLAN_DEFINITION = {
  type: 'function',
  function: {
    name: 'update_plan',
    description: 'Write or update the checklist for the current task. Pass the full list every time. Mark finished items with done=true. Keep 3-8 short items.',
    parameters: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          description: 'The full checklist',
          items: {
            type: 'object',
            properties: {
              text: { type: 'string' },
              done: { type: 'boolean' }
            },
            required: ['text']
          }
        }
      },
      required: ['items']
    }
  }
};

const FINISH_DEFINITION = {
  type: 'function',
  function: {
    name: 'finish_task',
    description: 'Call this only when the whole task is completely done and verified. Pass a short summary of what was done and anything the user must know.',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'What was done, files changed, open issues' }
      },
      required: ['summary']
    }
  }
};

const DELEGATE_DEFINITION = {
  type: 'function',
  function: {
    name: 'delegate_task',
    description: 'Hand a big, self-contained job to a helper agent with a fresh context. Only worth it for work across many files or several independent areas that can run in parallel; do small jobs yourself, a helper is much slower. The helper cannot see this chat, so write a complete brief. Mode "research" reads only, "worker" may change files.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short name of the job, e.g. "Map the payment flow"' },
        goal: { type: 'string', description: 'What the helper must find out or do, and why, in a few sentences' },
        files: { type: 'array', items: { type: 'string' }, description: 'Files and folders you already know are relevant (relative paths), so the helper does not search for them' },
        known: { type: 'string', description: 'What you already know or ruled out, so the helper does not repeat it' },
        deliverable: { type: 'string', description: 'Exactly what the report must contain, e.g. "list of functions with file:line and a one-line purpose each"' },
        mode: { type: 'string', enum: ['research', 'worker'], description: 'research = read only, worker = may edit and run commands' }
      },
      required: ['title', 'goal', 'deliverable']
    }
  }
};

const MIN_GOAL_CHARS = 25;

// A helper starts from nothing: a thin brief makes it search the whole project again.
function briefProblem(args) {
  const goal = String(args.goal || args.task || '').trim();
  if (goal.length < MIN_GOAL_CHARS) return 'The brief is too thin: write the goal in a few full sentences (what to find or do, and why).';
  if (!String(args.deliverable || '').trim() && !args.task) return 'Say in "deliverable" exactly what the report must contain.';
  return null;
}

function formatBrief(args) {
  const files = (Array.isArray(args.files) ? args.files : String(args.files || '').split(/[,\n]/)).map((f) => String(f).trim()).filter(Boolean);
  return [
    `Goal: ${String(args.goal || args.task || '').trim()}`,
    files.length ? `Start with these files: ${files.join(', ')}` : '',
    String(args.known || '').trim() ? `Already known (do not repeat it): ${String(args.known).trim()}` : '',
    String(args.deliverable || '').trim() ? `Your report must contain: ${String(args.deliverable).trim()}` : '',
    'Stay inside this goal, be quick, and stop as soon as you can answer.'
  ].filter(Boolean).join('\n\n');
}

const REMEMBER_DEFINITION = {
  type: 'function',
  function: {
    name: 'remember',
    description: 'Save one short, lasting fact about this project for future chats: a convention, where something lives, how to run or test it, or a mistake to avoid. Not for the current task details.',
    parameters: {
      type: 'object',
      properties: {
        note: { type: 'string', description: 'One sentence, e.g. "Tests run with npm test (jest); UI strings live in src/i18n.js"' }
      },
      required: ['note']
    }
  }
};

const ASK_DEFINITION = {
  type: 'function',
  function: {
    name: 'ask_user',
    description: 'Ask the user a short clarifying question when the request is ambiguous or you need a decision you cannot safely guess (which approach, which file, destructive choices). Offer 2-4 short answer options when possible; the user can also type their own answer. Do not ask about trivial things.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'One clear question' },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional 2-4 short suggested answers'
        }
      },
      required: ['question']
    }
  }
};

const READ_ONLY_TOOLS = new Set(['list_files', 'read_file', 'search_text', 'semantic_search', 'get_problems', 'use_skill']);

const DANGEROUS_COMMANDS = [
  /\bsudo\b/,
  /\brm\s+(-[a-zA-Z]*\s+)*(\/|~|\$HOME|\.\.)(\s|$|\/)/,
  /\brm\s+-[a-zA-Z]*[rf][a-zA-Z]*\s+\*/,
  /\bgit\s+push\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\b/,
  /\bgit\s+checkout\s+--\s/,
  /\b(npm|yarn|pnpm)\s+publish\b/,
  /\bmkfs\b/,
  /\bdd\s+if=/,
  /:\(\)\s*\{/,
  /\|\s*(sudo\s+)?(sh|bash|zsh)\b/,
  /\b(shutdown|reboot|halt)\b/,
  /\bchmod\s+-R\s+7?77\s+\//,
  />\s*\/dev\/(sd|disk|nvme)/
];

function dangerousCommand(command) {
  const text = String(command || '');
  return DANGEROUS_COMMANDS.some((re) => re.test(text));
}

// Autopilot runs commands without asking, so it only runs commands that check or build the project.
// Everything else is refused (the agent mentions it in its summary) instead of trusting a blocklist.
const AUTOPILOT_SAFE = [
  /^(npm|pnpm|yarn|bun)\s+(test|run(\s+[\w:.-]+)?|t|ci|install|i|exec\s+(tsc|eslint|prettier|jest|vitest|mocha))(\s+[^;&|<>`$]*)?$/,
  /^npx\s+(--yes\s+)?(tsc|eslint|prettier|jest|vitest|mocha|playwright\s+test|htmlhint|stylelint)(\s+[^;&|<>`$]*)?$/,
  /^node\s+(--check\s+)?[\w./-]+\.(m?js|cjs)(\s+[^;&|<>`$]*)?$/,
  /^(python3?|py)\s+(-m\s+(pytest|unittest|py_compile|compileall|mypy|ruff|flake8)|[\w./-]+\.py)(\s+[^;&|<>`$]*)?$/,
  /^(pytest|mypy|ruff|flake8|tsc|eslint|jest|vitest)(\s+[^;&|<>`$]*)?$/,
  /^(go\s+(test|build|vet|run)|cargo\s+(test|build|check|clippy|run)|dotnet\s+(test|build)|mvn\s+(-q\s+)?(test|compile|verify)|gradle\s+(test|build)|\.\/gradlew\s+(test|build)|make(\s+[\w.-]+)?)(\s+[^;&|<>`$]*)?$/,
  /^(ls|pwd|cat|head|tail|wc|grep|rg|find|tree|echo|which|diff)(\s+[^;&|<>`$]*)?$/,
  /^git\s+(status|diff|log|show|branch)(\s+[^;&|<>`$]*)?$/,
  /^mkdir\s+(-p\s+)?[\w./-]+$/
];

function autopilotCommandAllowed(command, extraPrefixes) {
  const text = String(command || '').trim();
  if (!text || /`|\$\(|\$\{|>|<|\bsudo\b/.test(text) || dangerousCommand(text)) return false;
  const parts = text.split(/\s*(?:&&|\|\||;|\|)\s*/).filter(Boolean);
  const extra = (extraPrefixes || []).map((p) => String(p).trim()).filter(Boolean);
  return parts.every((part) =>
    AUTOPILOT_SAFE.some((re) => re.test(part)) || extra.some((prefix) => part === prefix || part.startsWith(prefix + ' '))
  );
}

function formatPlan(items) {
  if (!items.length) return '(no plan)';
  return items.map((it) => `[${it.done ? 'x' : ' '}] ${it.text}`).join('\n');
}

function parsePlanItems(rawItems) {
  let items = rawItems;
  if (typeof items === 'string') {
    try {
      items = JSON.parse(items);
    } catch (_) {
      items = items.split('\n').map((t) => ({ text: t.replace(/^\s*[-*\[\]x ]+/i, '').trim() }));
    }
  }
  if (!Array.isArray(items)) throw new Error('"items" must be a list');
  return items
    .map((it) => (typeof it === 'string' ? { text: it, done: false } : { text: String(it.text || '').trim(), done: !!it.done }))
    .filter((it) => it.text)
    .slice(0, 20);
}

function parseLenient(text) {
  try {
    return JSON.parse(text);
  } catch (_) {
  }
  let out = '';
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (inString) {
      if (escaped) {
        out += ch;
        escaped = false;
      } else if (ch === '\\') {
        out += ch;
        escaped = true;
      } else if (ch === '"') {
        out += ch;
        inString = false;
      } else if (ch === '\n') {
        out += '\\n';
      } else if (ch === '\r') {
        out += '';
      } else if (ch === '\t') {
        out += '\\t';
      } else {
        out += ch;
      }
    } else {
      if (ch === '"') inString = true;
      out += ch;
    }
  }
  return JSON.parse(out);
}

function findJsonObjects(text) {
  const found = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] !== '{') {
      i++;
      continue;
    }
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (inString) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') inString = false;
      } else if (c === '"') {
        inString = true;
      } else if (c === '{') {
        depth++;
      } else if (c === '}') {
        depth--;
        if (depth === 0) {
          end = j;
          break;
        }
      }
    }
    if (end === -1) {
      i++;
      continue;
    }
    try {
      found.push({ start: i, end: end + 1, value: parseLenient(text.slice(i, end + 1)) });
      i = end + 1;
    } catch (_) {
      i++;
    }
  }
  return found;
}

function toCall(value, allowedNames) {
  const fn = value && (value.function || value);
  const name = fn && fn.name;
  if (!name || !allowedNames.has(name)) return null;
  let args = fn.arguments || fn.parameters || fn.args || {};
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch (_) {
      args = {};
    }
  }
  return { function: { name, arguments: args } };
}

function extractTextToolCalls(content, allowedNames) {
  const raw = String(content || '');
  if (!raw.trim()) return null;
  const objects = findJsonObjects(raw);
  const calls = [];
  const cuts = [];
  for (const obj of objects) {
    const list = Array.isArray(obj.value) ? obj.value : [obj.value];
    const mapped = list.map((v) => toCall(v, allowedNames)).filter(Boolean);
    if (mapped.length) {
      calls.push(...mapped);
      cuts.push([obj.start, obj.end]);
    }
  }
  if (!calls.length) return null;

  let rest = '';
  let last = 0;
  cuts.forEach(([start, end]) => {
    rest += raw.slice(last, start);
    last = end;
  });
  rest += raw.slice(last);
  rest = rest.replace(/```[\w-]*\s*```/g, '').replace(/\n{3,}/g, '\n\n').trim();
  return { calls, rest };
}

const TASK_WORDS = [
  'зроб(?:и|іть|ити)?', 'створ(?:и|іть|ити)?', 'напиш(?:и|іть|ати)', 'додай(?:те)?', 'додати', 'зміни(?:ти|ть)?',
  'виправ(?:и|ити|те)?', 'поправ(?:и|ити|те)?', 'реаліз(?:уй|уйте|увати)', 'онов(?:и|іть|ити)', 'видал(?:и|іть|ити)',
  'перейменуй(?:те)?', 'перепиш(?:и|іть)', 'переро(?:би|бити|біть)', 'розроби(?:ти)?', 'згенеруй(?:те)?',
  'созда(?:й|йте|ть)', 'сдела(?:й|йте|ть)', 'добав(?:ь|ьте|ить)', 'измени(?:ть)?', 'исправ(?:ь|ьте|ить)',
  'реализуй(?:те)?', 'обнови(?:ть)?', 'удали(?:ть)?', 'перепиши(?:те)?', 'напиши(?:те)?', 'разработай(?:те)?',
  'create', 'make', 'build', 'write', 'add', 'change', 'fix', 'implement', 'update', 'remove', 'delete', 'rename',
  'rewrite', 'refactor', 'generate', 'edit', 'modify', 'develop', 'set up'
];
const TASK_PATTERN = new RegExp(`(?<![\\p{L}])(?:${TASK_WORDS.join('|')})(?![\\p{L}])`, 'iu');

function looksLikeTask(userText) {
  return TASK_PATTERN.test(String(userText || ''));
}

function looksLikeFollowUpEdit(text, hasFiles) {
  if (!hasFiles) return false;
  const t = String(text || '').trim();
  if (!t || t.length > 240 || /\?\s*$/.test(t)) return false;
  return !/^(дякую|дяка|спасибо|thanks|thank you|ok|окей|добре|супер|круто|привіт|hi|hello|чудово|клас|ага)[\s.!]*$/i.test(t);
}

function detectLanguage(text) {
  const t = String(text || '');
  const cyr = (t.match(/[\u0400-\u04FF]/g) || []).length;
  const lat = (t.match(/[A-Za-z]/g) || []).length;
  if (!cyr && !lat) return null;
  if (cyr >= lat) {
    if (/[іїєґ]/i.test(t)) return 'Ukrainian';
    if (/[ыэъё]/i.test(t)) return 'Russian';
    return 'Cyrillic';
  }
  return 'English';
}

function asksForFileContent(content) {
  const tail = String(content || '').slice(-400);
  return /(provide|share|send|show|paste|надайте|надішліть|покажіть|вставте|пришлите|предоставьте|покажите).{0,60}(content|contents|file|code|вміст|файл|код|содержим)/i.test(tail);
}

function normalizeText(text) {
  return String(text || '').replace(/<think>[\s\S]*?<\/think>/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

// Small models often write their previous answer again after a tool result: true when `next` repeats `previous`.
function repeatsText(next, previous) {
  const a = normalizeText(next);
  const b = normalizeText(previous);
  if (!a || !b || Math.min(a.length, b.length) < 20) return false;
  if (a === b) return true;
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  return long.includes(short) && short.length / long.length >= 0.85;
}

// Only an explicit request for helper agents counts, not "parallel", "user agent" or "агентство".
function mentionsAgents(text) {
  const t = String(text || '');
  if (/(?<![\p{L}])(агент(и|ів|ам|ами|ах|а|ом)?|помічник(и|ів|ам|ами|а|ом)?|помощник(и|ов|ам|ами|а|ом)?|субагент\p{L}*|делегу\p{L}*)(?![\p{L}])/iu.test(t)) return true;
  return /\b(sub-?agents?|helper agents?|helpers|delegate)\b/i.test(t) || /\bagents\b/i.test(t.replace(/\buser[- ]agents?\b/gi, ''));
}

function endsWithQuestion(content) {
  return /\?/.test(String(content || '').trim().slice(-220));
}

function looksLikeToolAttempt(content) {
  return /"name"\s*:\s*"(write_file|edit_file|read_file|list_files|search_text|run_command|use_skill|delegate_task)"/.test(String(content || ''));
}

module.exports = {
  repeatsText,
  briefProblem,
  formatBrief,
  REMEMBER_DEFINITION,
  autopilotCommandAllowed,
  PLAN_DEFINITION,
  FINISH_DEFINITION,
  DELEGATE_DEFINITION,
  ASK_DEFINITION,
  READ_ONLY_TOOLS,
  dangerousCommand,
  formatPlan,
  parsePlanItems,
  extractTextToolCalls,
  looksLikeToolAttempt,
  looksLikeTask,
  mentionsAgents,
  detectLanguage,
  asksForFileContent,
  looksLikeFollowUpEdit,
  endsWithQuestion
};
