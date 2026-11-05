const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { ICONS } = require('../icons');
const capabilities = require('../modelCapabilities');
const { isVisionModel, isCloudModelName, cloudCap } = capabilities;
const ollamaProcess = require('../ollamaProcess');
const { WorkspaceTools, normalizeArgs, truncate } = require('../tools');
const skillsLib = require('../skills');
const workspaceLib = require('../workspace');
const { resolveWorkspaceRoot } = workspaceLib;
const agentTools = require('../agentTools');
const voice = require('../voice');
const modelState = require('../modelState');
const agentFiles = require('../agentFiles');
const generationLib = require('../generation');
const beforeContent = require('../beforeContent');
const projectCheck = require('../projectCheck');
const cloud = require('../cloudProviders');
const diagnostics = require('../diagnostics');
const { CloudClient } = require('../cloudClient');
const cloudLimits = require('../cloudLimits');
const MODEL_CATALOG = require('../catalog').models;
const { spawn, execFile } = require('child_process');

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
const TEXT_FILE_EXTENSIONS = [
  'txt', 'md', 'js', 'ts', 'jsx', 'tsx', 'py', 'json', 'html', 'css', 'java', 'go', 'rs', 'c', 'cpp', 'log'
];
const MAX_TEXT_FILE_CHARS = 12000;
const MAX_TOOL_RESULT_CHARS = 8000;
const VOICE_MAX_MS = 120000;
const MAX_AGENT_STEPS = 25;
const MAX_DUMP_NUDGES = 2;
const MAX_CUT_NUDGES = 2;
const CONTEXT_FILE_CHARS = 6000;
const CONTEXT_TOTAL_CHARS = 14000;
const AUTOPILOT_MAX_STEPS = 400;
const MAX_NUDGES = 6;
const MAX_REPEAT_WARNINGS = 3;
const SUBAGENT_MAX_STEPS = { research: 25, worker: 40, verify: 14 };
const MAX_SUBAGENT_REPORT_CHARS = 6000;
const RETRY_DELAY_MS = 4000;
const MAX_RETRIES = 6;
const DEFAULT_CONTEXT_SIZE = 16384;
const CHARS_PER_TOKEN = 2.5;

const LANGUAGE_BY_EXTENSION = {
  '.js': 'javascript',
  '.ts': 'typescript',
  '.jsx': 'javascript',
  '.tsx': 'typescript',
  '.py': 'python',
  '.json': 'json',
  '.html': 'html',
  '.css': 'css',
  '.java': 'java',
  '.go': 'go',
  '.rs': 'rust',
  '.c': 'c',
  '.cpp': 'cpp',
  '.md': 'markdown',
  '.txt': '',
  '.log': ''
};

function estimateChars(messages) {
  return messages.reduce((sum, m) => {
    let size = typeof m.content === 'string' ? m.content.length : 0;
    if (m.tool_calls) size += JSON.stringify(m.tool_calls).length;
    return sum + size;
  }, 0);
}

function shrinkToolOutputs(messages, limit) {
  return messages.map((m) => (m.role === 'tool' && typeof m.content === 'string' && m.content.length > limit
    ? { ...m, content: `${m.content.slice(0, limit)}\n... [shortened to save tokens]` }
    : m));
}

function trimMessagesToFit(messages, maxChars) {
  const systemMsgs = messages.filter((m) => m.role === 'system');
  let rest = messages.filter((m) => m.role !== 'system');
  let trimmed = false;

  const taskIndex = rest.map((m) => m.role === 'user' && !m.synthetic).lastIndexOf(true);
  const systemChars = estimateChars(systemMsgs);
  const taskChars = taskIndex >= 0 ? estimateChars([rest[taskIndex]]) : 0;
  const budget = Math.max(maxChars, systemChars + taskChars + 3000);
  const fits = () => estimateChars([...systemMsgs, ...rest]) <= budget;

  while (!fits() && taskIndex > 0 && rest.length > 1 && rest.findIndex((m, i) => i < (rest.length - 1)) !== -1) {
    const idx = rest.map((m) => m.role === 'user' && !m.synthetic).lastIndexOf(true);
    if (idx <= 0) break;
    rest.shift();
    trimmed = true;
  }

  if (!fits()) {
    rest = shrinkToolOutputs(rest, 900);
    trimmed = true;
  }

  while (!fits()) {
    const idx = rest.map((m) => m.role === 'user' && !m.synthetic).lastIndexOf(true);
    const after = rest.slice(idx + 1);
    if (after.length <= 2) break;
    let cut = 1;
    while (cut < after.length - 1 && after[cut].role === 'tool') cut++;
    rest = [...rest.slice(0, idx + 1), ...after.slice(cut)];
    trimmed = true;
  }

  while (trimmed && rest.length > 1 && rest[0].role === 'tool') rest.shift();
  return { messages: [...systemMsgs, ...rest], trimmed };
}

function modelSupportsTools(name) {
  if (cloud.isCloudModel(name)) return cloudCap(name, 'tools') !== false;
  const reported = capabilities.localCap(name, 'tools');
  if (reported !== null) return reported;
  const entry = MODEL_CATALOG.find((m) => m.name === name);
  return entry ? (entry.tags || []).includes('tools') : true;
}

function languageNote(lang) {
  if (!lang || lang === 'English') return '';
  return `IMPORTANT: the user writes in ${lang}. Write ALL your replies to the user in ${lang}, including short summaries after tool calls. Code, file names and identifiers stay unchanged.`;
}

function isSmallModel(name) {
  const m = String(cloud.isCloudModel(name) ? (cloud.parseName(name) || {}).modelId : name || '').match(/(\d+(?:\.\d+)?)b\b/i);
  return !!m && Number(m[1]) < 13;
}

// 4B and smaller: chats fine, but invents files and wanders off when it works on a project.
function isTinyModel(name) {
  if (cloud.isCloudModel(name)) return false;
  const m = String(name || '').match(/(?:^|[:\-_])(\d+(?:\.\d+)?)b(?:$|[-_:.])/i);
  return !!m && Number(m[1]) <= 4;
}

function displayTitle(message) {
  const display = message.display;
  if (display && display.text) return display.text;
  if (display && display.attachments && display.attachments.length) return display.attachments[0].name;
  return typeof message.content === 'string' ? message.content : '';
}

function capDiff(diff) {
  if (!diff) return null;
  return { added: diff.added, removed: diff.removed, isNew: diff.isNew, lines: diff.lines.slice(0, 100) };
}

function toOllamaMessages(messages) {
  return messages.filter((m) => m.role !== 'notice' && m.role !== 'step').map((m) => {
    const out = { role: m.role, content: m.content };
    if (m.images) out.images = m.images;
    if (m.tool_calls) out.tool_calls = m.tool_calls;
    if (m.tool_name) out.tool_name = m.tool_name;
    return out;
  });
}

function buildCompactAgentPrompt(rootName) {
  return [
    `You are a coding assistant in VS Code working in the project folder "${rootName}" with tools. Paths are relative to it.`,
    'Rules: the project files you need are shown below, so do not search for them; read a file with read_file only if it is not shown.',
    'To change a small file rewrite it fully with write_file; use edit_file only for big files.',
    'Never paste code in the chat: put it into files, then reply in one or two short sentences. Do the task, do not ask the user for file names or code.',
    'For a greeting, thanks or small talk just answer in plain text: do not use tools. Edits and commands need approval. Reply in the user\'s language.'
  ].join('\n');
}

function compactTools(defs) {
  return defs.map((d) => {
    const fn = d.function;
    const short = String(fn.description || '').split(/(?<=\.)\s/)[0];
    const props = {};
    Object.entries((fn.parameters && fn.parameters.properties) || {}).forEach(([k, v]) => {
      props[k] = { type: v.type, ...(v.items ? { items: v.items } : {}), ...(v.enum ? { enum: v.enum } : {}) };
    });
    return { type: 'function', function: { name: fn.name, description: short, parameters: { type: 'object', properties: props, required: (fn.parameters && fn.parameters.required) || [] } } };
  });
}

function buildAgentPrompt(rootName) {
  if (!rootName) {
    return 'You are a local assistant inside VS Code. Answer in the same language the user writes in.';
  }
  return [
    `You are a local coding assistant inside VS Code. You can work with the user's project folder "${rootName}" through tools.`,
    'Rules:',
    '- Look at the real files with tools before answering questions about the code. Never guess file contents.',
    '- For a greeting, thanks or small talk, answer in plain text without calling any tool.',
    '- All paths are relative to the project root.',
    '- To change an existing file use edit_file: copy old_string exactly from the file (a few lines that occur once) and change only what is needed. Make several small edit_file calls for several changes. Use write_file only for new files, or when the user asks to rewrite a file.',
    '- When the user asks for a correction, change only that. Keep everything else in the files exactly as it is.',
    '- The "heading" (заголовок) of a page is its visible <h1>, unless the user says the browser tab title.',
    '- Make only the changes the user asked for.',
    '- NEVER paste code or file contents into the chat. Create or change files in the project with write_file or edit_file, then reply with one or two short sentences. The chat is only for talking, questions and corrections.',
    '- When the user asks for a fix or a change, work on the existing files: read them first, then edit them. Do not start over.',
    '- Keep the layout simple: put a new standalone page or script in the project root (for example index.html, style.css, script.js) unless the project already has a clear structure. Use the file type the user asked for (an html request means .html, not a framework component).',
    '- Edits and commands need the user\'s approval. If an action is denied, do not retry it; ask what to do instead.',
    '- When the task is done, summarise what you did in one to three short sentences: what changed and how to use it.',
    '- For a question, give the answer in the first sentence, then only the details that help. No introductions.',
    '- Answer in the same language the user writes in.'
  ].join('\n');
}

// "new" and "rewrite": complete files. Corrections: <edit> blocks that change only the asked part.
function buildFilesPrompt(rootName, kind = 'new') {
  const common = [
    '- If the user only asks a question or wants to talk, answer in plain text without blocks: the answer first, short.',
    '- Outside the blocks write only one to three short sentences: what you did and how to use it.',
    '- Answer in the same language the user writes in.'
  ];
  if (kind === 'edit' || kind === 'question') {
    return [
      `You are a coding assistant working inside the user's project folder "${rootName}". You cannot run tools. You change the project with blocks in exactly these formats.`,
      '',
      'To CHANGE an existing file, write edit blocks. SEARCH holds a few lines copied exactly from the file shown below; REPLACE holds the new lines:',
      '<edit path="style.css">',
      '<<<<<<< SEARCH',
      '#add-task {',
      '  background: #2196f3;',
      '=======',
      '#add-task {',
      '  background: #4caf50;',
      '>>>>>>> REPLACE',
      '</edit>',
      '',
      'To create a NEW file, write it completely:',
      '<file path="relative/path.ext">',
      '...the complete content...',
      '</file>',
      '',
      'Rules:',
      '- Change ONLY what the user asked for. Everything else stays exactly as it is: do not reformat, rename or "improve" other code.',
      '- Never rewrite a whole existing file. Use several small edit blocks when several places change (one SEARCH/REPLACE pair per place).',
      '- Copy SEARCH lines exactly from the current file, including indentation, without line numbers. Choose lines that occur only once.',
      '- A change must work: when you add a button, also add its code in the script.',
      '- The "heading" (заголовок) of a page is its visible <h1>, unless the user says the browser tab title.',
      ...common
    ].join('\n');
  }
  return [
    `You are a coding assistant working inside the user's project folder "${rootName}". You cannot run tools, but you can create files by writing them in exactly this format:`,
    '',
    '<file path="relative/path/to/file.ext">',
    '...the COMPLETE content of the file...',
    '</file>',
    '',
    'Rules:',
    '- Every piece of code goes into a <file> block and the app saves it into the project. The chat is only for talking.',
    '- Give the COMPLETE content of every file, with each section written only once.',
    '- Create the files the feature needs (for example index.html, style.css, script.js) with short relative paths. New standalone pages go in the project root. Use the file type the user asked for.',
    '- A new feature must work: write all its HTML, CSS and JavaScript, not only the buttons. Every button and field needs its code.',
    ...common
  ].join('\n');
}


module.exports = { vscode, fs, path, ICONS, capabilities, isVisionModel, isCloudModelName, cloudCap, ollamaProcess, WorkspaceTools, normalizeArgs, truncate, skillsLib, workspaceLib, resolveWorkspaceRoot, agentTools, voice, modelState, agentFiles, generationLib, beforeContent, projectCheck, cloud, diagnostics, CloudClient, cloudLimits, MODEL_CATALOG, spawn, execFile, IMAGE_EXTENSIONS, TEXT_FILE_EXTENSIONS, MAX_TEXT_FILE_CHARS, MAX_TOOL_RESULT_CHARS, VOICE_MAX_MS, MAX_AGENT_STEPS, MAX_DUMP_NUDGES, MAX_CUT_NUDGES, CONTEXT_FILE_CHARS, CONTEXT_TOTAL_CHARS, AUTOPILOT_MAX_STEPS, MAX_NUDGES, MAX_REPEAT_WARNINGS, SUBAGENT_MAX_STEPS, MAX_SUBAGENT_REPORT_CHARS, RETRY_DELAY_MS, MAX_RETRIES, DEFAULT_CONTEXT_SIZE, CHARS_PER_TOKEN, LANGUAGE_BY_EXTENSION, estimateChars, shrinkToolOutputs, trimMessagesToFit, modelSupportsTools, languageNote, isSmallModel, isTinyModel, displayTitle, capDiff, toOllamaMessages, buildCompactAgentPrompt, compactTools, buildAgentPrompt, buildFilesPrompt };
