const fs = require('fs');
const path = require('path');

// Files a project keeps in its root by convention.
const ROOT_DOCS = new Set([
  'readme', 'changelog', 'license', 'licence', 'contributing', 'code_of_conduct', 'security', 'authors',
  'agents', 'claude', 'gemini', 'notice', 'history', 'support'
]);
const DOCS_FOLDERS = ['docs', 'doc', 'documentation'];
const BRIEF_NAME = /(brief|plan|todo|task|notes|spec|roadmap|бриф|план|задач|нотат|завдан)/i;

function docsFolder(root) {
  return DOCS_FOLDERS.find((dir) => {
    try {
      return fs.statSync(path.join(root, dir)).isDirectory();
    } catch (_) {
      return false;
    }
  }) || 'docs';
}

// Where a new Markdown file the AI writes into the project root belongs: docs/, or docs/briefs/ for plans and
// briefs. Null when the path stays as it is (not Markdown, a conventional root file, already in a folder,
// an existing file, or a path the user named in the request).
function place(relPath, { root, task = '' } = {}) {
  const rel = String(relPath || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!rel || path.isAbsolute(rel) || rel.includes('/') || !/\.(md|markdown)$/i.test(rel)) return null;
  const stem = rel.replace(/\.(md|markdown)$/i, '').toLowerCase();
  if (ROOT_DOCS.has(stem)) return null;
  if (String(task).toLowerCase().includes(rel.toLowerCase())) return null;
  if (fs.existsSync(path.join(root, rel))) return null;
  const folder = docsFolder(root);
  return BRIEF_NAME.test(stem) ? `${folder}/briefs/${rel}` : `${folder}/${rel}`;
}

module.exports = { place };
