const MAX_NAMES = 4;
const MAX_LINES_PER_NAME = 6;
const MAX_NAME_CHARS = 1500;
const MAX_SNIPPETS = 3;
const MAX_SNIPPET_CHARS = 3500;
// A meaning match far below the best one is usually noise.
const RELATIVE_SCORE = 0.85;

const NAME_PATTERNS = [
  /`([^`\s]{3,60})`/g,
  /(?<![\w$.])([A-Za-z_$][\w$]{2,})\(\)/g,
  /(?<![\w$])([a-z]+[A-Z][\w$]*)(?![\w$])/g,
  /(?<![\w$])([A-Z][a-z0-9]+[A-Z][\w$]*)(?![\w$])/g,
  /(?<![\w$])([A-Za-z]+_[A-Za-z0-9_]+)(?![\w$])/g,
  /(?<![\w$.\/])([#][A-Za-z][\w-]{2,})/g
];

// Code names the user typed (camelCase, snake_case, name(), `quoted`, #id): worth looking up in the project.
function codeNames(text) {
  const source = String(text || '');
  const names = [];
  for (const re of NAME_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(source)) && names.length < MAX_NAMES) {
      const name = m[1].replace(/\(\)$/, '');
      if (/\.[a-z]{1,5}$/i.test(name) || /^https?:/i.test(name)) continue;
      if (!names.includes(name)) names.push(name);
    }
  }
  return names;
}

// `hits`: [{ name, lines: ['rel:12: text', ...] }] from a text search of the project.
function formatNameHits(hits) {
  const blocks = [];
  let used = 0;
  for (const { name, lines } of hits) {
    if (!lines.length) continue;
    const block = `${name}:\n${lines.slice(0, MAX_LINES_PER_NAME).map((l) => `  ${l}`).join('\n')}`;
    if (used + block.length > MAX_NAME_CHARS) break;
    blocks.push(block);
    used += block.length;
  }
  return blocks.length ? `Where the names from the request appear in the project (file:line):\n${blocks.join('\n')}` : '';
}

// `hits` from the meaning index, best first; files already shown in full are left out.
function formatSnippets(hits, shown = new Set()) {
  if (!hits.length) return '';
  const best = hits[0].score;
  const blocks = [];
  let used = 0;
  for (const hit of hits) {
    if (blocks.length >= MAX_SNIPPETS) break;
    if (hit.score < best * RELATIVE_SCORE || shown.has(hit.rel) || !String(hit.snippet || '').trim()) continue;
    const block = `### ${hit.rel} (lines ${hit.start}-${hit.end})\n\`\`\`\n${hit.snippet}\n\`\`\``;
    if (used + block.length > MAX_SNIPPET_CHARS) break;
    blocks.push(block);
    used += block.length;
  }
  return blocks.length ? `Code that looks related to the request (found by meaning; read the whole file before changing it):\n\n${blocks.join('\n\n')}` : '';
}

module.exports = { codeNames, formatNameHits, formatSnippets };
