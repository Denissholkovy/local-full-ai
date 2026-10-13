const fs = require('fs');
const os = require('os');
const path = require('path');
const { truncate } = require('./tools');

const MAX_SKILL_CHARS = 12000;
const MAX_INSTRUCTIONS_CHARS = 3000;
const MAX_LISTED_SKILLS = 40;
const MAX_DESCRIPTION_CHARS = 110;

const USE_SKILL_DEFINITION = {
  type: 'function',
  function: {
    name: 'use_skill',
    description: 'Load the full instructions of a skill from the list in the system prompt. Call it before starting a task that matches a skill, then follow the instructions. Optionally pass "file" to read a reference file mentioned inside the skill.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill name exactly as listed' },
        file: { type: 'string', description: 'Optional file path inside the skill folder, e.g. "references/api.md"' }
      },
      required: ['name']
    }
  }
};

function expandHome(p) {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

function parseFrontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: text, raw: '' };
  const meta = {};
  const lines = match[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([A-Za-z_-]+):\s*(.*)$/);
    if (!kv) continue;
    let value = kv[2].trim();
    if (value === '>' || value === '|' || value === '>-' || value === '|-') {
      const parts = [];
      while (i + 1 < lines.length && /^\s+/.test(lines[i + 1])) parts.push(lines[++i].trim());
      value = parts.join(' ');
    }
    meta[kv[1]] = value.replace(/^["']|["']$/g, '');
  }
  return { meta, body: match[2], raw: match[1] };
}

const indexCache = new Map();
const bodyCache = new Map();
const stats = { hits: 0, parsed: 0 };
let persistFile = null;
let persistTimer = null;
let dirty = false;
let memo = null;
const MEMO_MS = 8000;

function schedulePersist() {
  dirty = true;
  if (!persistFile || persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    if (!dirty) return;
    dirty = false;
    try {
      const entries = [...indexCache.entries()].map(([file, v]) => ({ file, mtimeMs: v.mtimeMs, size: v.size, entry: v.entry }));
      fs.mkdirSync(path.dirname(persistFile), { recursive: true });
      fs.writeFileSync(persistFile, JSON.stringify({ version: 1, entries }));
    } catch (_) {
    }
  }, 1000);
  if (persistTimer.unref) persistTimer.unref();
}

function setPersistence(dir) {
  persistFile = path.join(dir, 'skills-index.json');
  try {
    const data = JSON.parse(fs.readFileSync(persistFile, 'utf8'));
    if (data && data.version === 1 && Array.isArray(data.entries)) {
      data.entries.forEach((e) => {
        if (e && e.file && e.entry) indexCache.set(e.file, { mtimeMs: e.mtimeMs, size: e.size, entry: e.entry });
      });
    }
  } catch (_) {
  }
}

function invalidate() {
  memo = null;
  indexCache.clear();
  bodyCache.clear();
  stats.hits = 0;
  stats.parsed = 0;
  schedulePersist();
}

function cacheInfo() {
  return { cached: indexCache.size, hits: stats.hits, parsed: stats.parsed, persistent: !!persistFile };
}

function readSkillsFrom(folder, source) {
  const found = [];
  let entries;
  try {
    entries = fs.readdirSync(folder, { withFileTypes: true });
  } catch (_) {
    return found;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const dir = path.join(folder, entry.name);
    const file = path.join(dir, 'SKILL.md');
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile()) continue;
      let cached = indexCache.get(file);
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
        stats.hits++;
      } else {
        const { meta, raw } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
        const triggers = (raw.match(/^\s*triggers:\s*(.+)$/m) || [])[1] || '';
        const domain = (raw.match(/^\s*domain:\s*(.+)$/m) || [])[1] || '';
        cached = {
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          entry: { name: (meta.name || entry.name).trim(), description: (meta.description || '').trim(), triggers: triggers.trim(), domain: domain.trim() }
        };
        indexCache.set(file, cached);
        stats.parsed++;
        schedulePersist();
      }
      found.push({ ...cached.entry, dir, file, source });
    } catch (_) {
    }
  }
  return found;
}

function loadSkills({ workspaceRoot, extraFolders } = {}) {
  const folders = [];
  if (workspaceRoot) folders.push([path.join(workspaceRoot, '.claude', 'skills'), 'project']);
  folders.push([path.join(os.homedir(), '.claude', 'skills'), 'user']);
  (extraFolders || []).forEach((f) => folders.push([path.resolve(expandHome(f)), 'custom']));

  const key = folders.map((f) => f[0]).join('|');
  if (memo && memo.key === key && Date.now() - memo.at < MEMO_MS) return memo.skills;

  const byName = new Map();
  for (const [folder, source] of folders) {
    for (const skill of readSkillsFrom(folder, source)) {
      if (!byName.has(skill.name.toLowerCase())) byName.set(skill.name.toLowerCase(), skill);
    }
  }
  const skills = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  memo = { key, at: Date.now(), skills };
  return skills;
}

function prettyPath(p) {
  const home = os.homedir();
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

function describeSources({ workspaceRoot, extraFolders } = {}) {
  const folders = [];
  if (workspaceRoot) folders.push([path.join(workspaceRoot, '.claude', 'skills'), 'project']);
  folders.push([path.join(os.homedir(), '.claude', 'skills'), 'user']);
  (extraFolders || []).forEach((f) => folders.push([path.resolve(expandHome(f)), 'custom']));

  const seen = new Set();
  const skills = [];
  const folderInfo = folders.map(([folder, source]) => {
    const found = readSkillsFrom(folder, source);
    let exists = false;
    try {
      exists = fs.statSync(folder).isDirectory();
    } catch (_) {
      exists = false;
    }
    let used = 0;
    found.forEach((sk) => {
      const key = sk.name.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      skills.push({ name: sk.name, description: sk.description, source, file: sk.file });
      used++;
    });
    return { path: folder, display: prettyPath(folder), source, exists, found: found.length, used };
  });

  const instructions = [];
  const userFile = path.join(os.homedir(), '.claude', 'CLAUDE.md');
  const files = [['User', userFile]];
  if (workspaceRoot) files.push(['Project', path.join(workspaceRoot, 'CLAUDE.md')]);
  files.forEach(([label, file]) => {
    try {
      const chars = fs.readFileSync(file, 'utf8').trim().length;
      if (chars) instructions.push({ label, path: file, display: prettyPath(file), chars });
    } catch (_) {
    }
  });

  skills.sort((a, b) => a.name.localeCompare(b.name));
  return { folders: folderInfo, skills, instructions };
}

const STOP = new Set(('the and for with use when this that from your you are not any all can new its our per via into over under only also such these those they them then than will would should could has have had was were been being but out off one two more most some each other about after before during between without within across through using used uses use-when apps app code files file data work works make makes made build builds built create creates run runs set sets get gets add adds see sees how what why where which who whom whose while skill skills guide guides house project projects default defaults standard standards structure').split(/\s+/));

const SYNONYMS = [
  [/рев['\u2019\u02bc]?ю|ревю|перевір(?:ити|ь)? код|code review/u, 'review code quality pull request'],
  [/безпек|вразлив|секрет|атак/u, 'security vulnerability audit secrets'],
  [/тест|тестув|покритт/u, 'test testing qa coverage'],
  [/баг|помилк|не працю|дебаг|налагод|зламан/u, 'debug bug error broken'],
  [/баз[аиу] даних|базі даних|\bsql\b|запит до баз|постгрес|індекс/u, 'postgres sql database query index'],
  [/докер|контейнер|compose/u, 'docker container devops compose'],
  [/деплой|розгортан|\bci\b|\bcd\b|пайплайн|сервер/u, 'deploy devops ci pipeline server'],
  [/ендпо[їі]нт|ендпоінт|rest\b|\bапі\b|\bapi\b/u, 'api rest endpoint design'],
  [/сокет|вебсокет|реалтайм|real-?time|чат у реальному/u, 'websocket realtime socket'],
  [/черг|фонов|воркер|крон|розклад/u, 'queue job background bullmq worker cron'],
  [/доступн|a11y|скрінрідер|контраст/u, 'accessibility wcag screen reader contrast'],
  [/швидкіст|продуктивн|оптиміз|повільн|завантаженн[яі] сторінк/u, 'performance optimize speed web vitals'],
  [/нативн|мобільн|react native|айос|андроїд|ios|android/u, 'react native mobile app ios android'],
  [/фронт|компонент|сторінк|інтерфейс|верстк/u, 'react component frontend page ui'],
  [/типи|тайпскрипт|typescript|generic/u, 'typescript types generics'],
  [/документац|readme|опис проєкту|ченджлог|changelog/u, 'documentation readme docs changelog'],
  [/архітектур|дизайн систем|схема системи|масштабув/u, 'architecture design system scaling adr'],
  [/вимог|специфікац|фіч[ауі]|нову функці/u, 'requirements feature spec user story'],
  [/логув|логи|моніторинг|метрик|алерт|спостережен/u, 'observability logging metrics monitoring alerts'],
  [/міграці|сутніст|модул[ьюя]|контролер|nest/u, 'nestjs module entity migration controller'],
  [/автентифікац|логін|авторизац|токен|jwt/u, 'auth authentication jwt token login'],
  [/форм[аиу]|валідац/u, 'form validation input']
];

function tokenize(text) {
  return (String(text || '').toLowerCase().match(/[a-z][a-z0-9+#.]{2,}/g) || [])
    .map((t) => t.replace(/\.+$/, ''))
    .filter((t) => t.length > 2 && !STOP.has(t));
}

function expandQuery(text) {
  const lower = String(text || '').toLowerCase();
  const extra = SYNONYMS.filter(([re]) => re.test(lower)).map(([, words]) => words);
  return [...new Set(tokenize(`${lower} ${extra.join(' ')}`))];
}

function tokensMatch(a, b) {
  if (a === b) return true;
  if (a.length >= 4 && b.startsWith(a)) return true;
  if (b.length >= 4 && a.startsWith(b)) return true;
  return false;
}

function docTokens(skill) {
  if (!skill._tokens) {
    const strong = new Set(tokenize(`${skill.name.replace(/-/g, ' ')} ${skill.triggers || ''} ${skill.domain || ''}`));
    const weak = new Set(tokenize(skill.description).filter((t) => !strong.has(t)));
    skill._tokens = { strong: [...strong], weak: [...weak] };
  }
  return skill._tokens;
}

function selectSkills(skills, text, { max = 2, minScore = 4 } = {}) {
  const query = expandQuery(text);
  if (query.length === 0 || skills.length === 0) return [];

  const df = new Map();
  skills.forEach((sk) => {
    const t = docTokens(sk);
    new Set([...t.strong, ...t.weak]).forEach((tok) => df.set(tok, (df.get(tok) || 0) + 1));
  });

  const scored = skills.map((sk) => {
    const t = docTokens(sk);
    let strongHits = 0;
    let score = 0;
    t.strong.forEach((tok) => {
      if (query.some((q) => tokensMatch(q, tok))) {
        strongHits++;
        score += 3 / (1 + 0.6 * ((df.get(tok) || 1) - 1));
      }
    });
    t.weak.forEach((tok) => {
      if (query.some((q) => tokensMatch(q, tok))) score += 1 / (1 + 0.5 * ((df.get(tok) || 1) - 1));
    });
    return { skill: sk, score, strongHits };
  }).filter((x) => x.strongHits >= 1 && x.score >= minScore);

  scored.sort((a, b) => b.score - a.score);
  if (!scored.length) return [];
  const best = scored[0].score;
  return scored.filter((x) => x.score >= best * 0.6).slice(0, max).map((x) => ({ ...x.skill, score: x.score }));
}

function findSkill(skills, name) {
  const wanted = String(name || '').trim().toLowerCase();
  return skills.find((s) => s.name.toLowerCase() === wanted);
}

function readSkill(skill, file) {
  if (file) {
    const abs = path.resolve(skill.dir, file);
    const rel = path.relative(fs.realpathSync(skill.dir), fs.realpathSync(abs));
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error('File is outside the skill folder');
    }
    return truncate(fs.readFileSync(abs, 'utf8'), MAX_SKILL_CHARS);
  }
  const stat = fs.statSync(skill.file);
  const cached = bodyCache.get(skill.file);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.text;
  const { body } = parseFrontmatter(fs.readFileSync(skill.file, 'utf8'));
  const text = truncate(body.trim(), MAX_SKILL_CHARS);
  bodyCache.set(skill.file, { mtimeMs: stat.mtimeMs, text });
  return text;
}

function skillsPromptSection(skills) {
  if (skills.length === 0) return '';
  const lines = skills.slice(0, MAX_LISTED_SKILLS).map((s) => {
    const desc = s.description.length > MAX_DESCRIPTION_CHARS
      ? `${s.description.slice(0, MAX_DESCRIPTION_CHARS)}...`
      : s.description;
    return `- ${s.name}: ${desc}`;
  });
  return [
    'Available skills (the user\'s own playbooks). When the task matches one, call use_skill with its name first and follow what it says:',
    ...lines
  ].join('\n');
}

function readInstructionFile(file) {
  try {
    const text = fs.readFileSync(file, 'utf8').trim();
    return text ? truncate(text, MAX_INSTRUCTIONS_CHARS) : '';
  } catch (_) {
    return '';
  }
}

function loadInstructions(workspaceRoot) {
  const parts = [];
  const user = readInstructionFile(path.join(os.homedir(), '.claude', 'CLAUDE.md'));
  if (user) parts.push(`User instructions (CLAUDE.md):\n${user}`);
  if (workspaceRoot) {
    const project = readInstructionFile(path.join(workspaceRoot, 'CLAUDE.md'));
    if (project) parts.push(`Project instructions (CLAUDE.md):\n${project}`);
  }
  return parts.join('\n\n');
}

module.exports = {
  setPersistence,
  invalidate,
  cacheInfo,
  selectSkills,
  expandQuery,
  USE_SKILL_DEFINITION,
  loadSkills,
  describeSources,
  findSkill,
  readSkill,
  skillsPromptSection,
  loadInstructions
};
