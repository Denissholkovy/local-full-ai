const { vscode, fs, path, truncate, agentFiles, capDiff, buildFilesPrompt, languageNote } = require('./common');

// A new feature for a small model, in steps: a short plan first (files, element ids, what must work), then one
// file per request, each seeing the plan and the files already written. Short answers stay coherent; one long
// answer with three files loses the thread (buttons without code).
const MAX_PLAN_FILES = 4;
const ORDER = ['.html', '.htm', '.css', '.js', '.mjs'];

const PLAN_PROMPT = [
  'You plan a small coding task. Do not write code. Reply in exactly this format (keep the three headings in English):',
  'FILES:',
  '- <path>: <one short sentence, no code>',
  'ELEMENTS:',
  '- #<id>: <what it is and what it does>',
  'CHECKS:',
  '- <one behaviour that must work, the way a user would test it>',
  '',
  'List every button, field and display the page needs under ELEMENTS, each with its own id.',
  'Use the file names the user asked for. At most 4 files, 30 elements and 6 checks. Nothing else.'
].join('\n');

function parsePlan(text) {
  const plan = { files: [], ids: [], checks: [], text: '' };
  let section = '';
  String(text || '').replace(/<think>[\s\S]*?<\/think>/g, '').split('\n').forEach((raw) => {
    const line = raw.trim();
    const heading = line.match(/^\**\s*(FILES|ELEMENTS|CHECKS)\s*:?\**\s*$/i);
    if (heading) {
      section = heading[1].toUpperCase();
      return;
    }
    const item = line.match(/^[-*•]\s*(.+)$/) || line.match(/^\d+[.)]\s*(.+)$/);
    if (!item) return;
    const body = item[1].replace(/`/g, '').trim();
    if (section === 'FILES') {
      const file = body.match(/^([\w./-]+\.[A-Za-z0-9]{1,6})\b\s*[:\-–]?\s*(.*)$/);
      const purpose = String(file ? file[2] : '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
      if (file && !file[1].includes('..') && !path.isAbsolute(file[1])) plan.files.push({ path: file[1].replace(/^\.\//, ''), purpose });
    } else if (section === 'ELEMENTS') {
      const el = body.match(/^#([\w-]+)\s*[:\-–]?\s*(.*)$/);
      if (el) plan.ids.push({ id: el[1], what: el[2].replace(/<[^>]*>/g, ' ').trim().slice(0, 80) });
    } else if (section === 'CHECKS') {
      plan.checks.push(body);
    }
  });
  const rank = (p) => {
    const i = ORDER.indexOf(path.extname(p).toLowerCase());
    return i === -1 ? ORDER.length : i;
  };
  plan.files = plan.files.slice(0, MAX_PLAN_FILES).sort((a, b) => rank(a.path) - rank(b.path));
  plan.text = [
    `Files: ${plan.files.map((f) => `${f.path}${f.purpose ? ` (${f.purpose})` : ''}`).join('; ')}`,
    plan.ids.length ? `Elements: ${plan.ids.map((e) => `#${e.id}${e.what ? ` ${e.what}` : ''}`).join('; ')}` : '',
    plan.checks.length ? `Must work: ${plan.checks.join('; ')}` : ''
  ].filter(Boolean).join('\n');
  return plan;
}

function planMarkdown(plan) {
  const lines = ['**Plan**', ''];
  plan.files.forEach((f) => lines.push(`- \`${f.path}\`${f.purpose ? ` — ${f.purpose}` : ''}`));
  if (plan.checks.length) {
    lines.push('', '**Must work**', '');
    plan.checks.forEach((c) => lines.push(`- ${c}`));
  }
  return lines.join('\n');
}

// Methods mixed into ChatPanel.prototype (see chatPanel.js).
module.exports = {
  _stepwiseWanted(ctx) {
    return !!(ctx.filesMode && ctx.tools && !ctx.isSub && ['new', 'rewrite'].includes(ctx.run.kind) && ctx.mode !== 'readonly');
  },

  async _ask(ctx, system, user, kind) {
    const { run } = ctx;
    const result = await this._clientFor(ctx.modelName).chatStream(
      ctx.modelName,
      [{ role: 'system', content: system }, { role: 'user', content: user }],
      null,
      this._modelOptions(ctx.modelName, {
        kind,
        onAbortReady: (abortFn) => run.aborts.add(abortFn),
        onNotice: (text, important) => ctx.post({ type: important ? 'contextTrimmed' : 'status', text }),
        onThinking: () => ctx.ui && ctx.post({ type: 'assistantThinking' })
      })
    );
    return String(result.content || '');
  },

  async _makePlan(ctx, feedback) {
    const { run, tools } = ctx;
    const existing = tools.listSourceFiles(8);
    const user = [
      `Task: ${run.task}`,
      existing.length ? `Files in the project now: ${existing.join(', ')}` : 'The project folder is empty.',
      feedback ? `The user's changes to the previous plan: ${feedback}` : ''
    ].filter(Boolean).join('\n');
    const lang = run.lang && run.lang !== 'English' ? `\nWrite the descriptions and checks in ${run.lang}.` : '';
    return parsePlan(await this._ask(ctx, PLAN_PROMPT + lang, user, 'plan'));
  },

  // The plan goes to the chat as a checklist card; the model sees it as text in later turns.
  _showPlan(ctx, plan) {
    const planData = { files: plan.files.map((f) => ({ path: f.path, purpose: f.purpose })), checks: plan.checks };
    ctx.history.push({ role: 'assistant', content: planMarkdown(plan), plan: true, planData });
    ctx.persist();
    if (ctx.ui) ctx.post({ type: 'plan', plan: planData });
  },

  // Returns true when the feature was built here; false hands the request to the normal one-pass flow.
  async _buildInSteps(ctx) {
    const { run, tools, post, history } = ctx;
    if (ctx.ui) post({ type: 'status', text: 'Planning the feature first...' });
    let plan;
    try {
      plan = await this._makePlan(ctx);
    } catch (_) {
      return false;
    }
    if (run.stopped || plan.files.length < 2) return false;

    if (vscode.workspace.getConfiguration('localAI').get('confirmPlan') === true && !ctx.autopilot) {
      this._showPlan(ctx, plan);
      const answer = await this._askUser(ctx, `p${++this._toolCounter}`, { question: 'Write the code by this plan?', options: ['Yes, write it'] });
      if (run.stopped) return true;
      const reply = answer.decision === 'answer' ? String(answer.extra || '').trim() : '';
      if (!reply) return true;
      if (!/^yes/i.test(reply)) {
        const revised = await this._makePlan(ctx, reply);
        if (revised.files.length >= 2) plan = revised;
        this._showPlan(ctx, plan);
      }
    } else {
      this._showPlan(ctx, plan);
    }
    run.planIds = plan.ids.map((e) => e.id);

    const system = [buildFilesPrompt(path.basename(tools.root), 'new'), `The plan for this task:\n${plan.text}`, languageNote(run.lang)].filter(Boolean).join('\n\n');
    let reply = '';
    run.stepwise = true;
    try {
      for (let i = 0; i < plan.files.length; i++) {
        if (run.stopped) return true;
        const target = plan.files[i].path;
        if (ctx.ui) {
          post({ type: 'status', text: `Writing ${target} (${i + 1} of ${plan.files.length})...` });
          post({ type: 'planStep', path: target, state: 'active' });
        }
        const written = plan.files.slice(0, i).map((f) => {
          const text = tools.snapshot(f.path);
          return text === null ? '' : `### ${f.path}\n\`\`\`\n${truncate(text, 6000)}\n\`\`\``;
        }).filter(Boolean);
        const ext = path.extname(target).toLowerCase();
        const idsNote = plan.ids.length && ['.html', '.htm', '.js', '.mjs'].includes(ext)
          ? ` Use exactly these element ids: ${plan.ids.map((e) => e.id).join(', ')}.`
          : '';
        const others = plan.files.filter((f) => f.path !== target && /\.(css|m?js)$/i.test(f.path));
        const linkNote = /\.html?$/i.test(target) && others.length
          ? ` Link the other planned files: ${others.map((f) => (/\.css$/i.test(f.path) ? `<link rel="stylesheet" href="${f.path}">` : `<script src="${f.path}"></script> before </body>`)).join(', ')}.`
          : '';
        const user = [
          run.task,
          written.length ? `Files already written (use their ids, classes and names):\n\n${written.join('\n\n')}` : '',
          `Now write ONLY the file ${target}, complete, in one <file path="${target}"> block.${idsNote}${linkNote}${ext === '.js' || ext === '.mjs' ? ' Give every button and field from the plan its working code.' : ''}`
        ].filter(Boolean).join('\n\n');

        let saved = false;
        for (let attempt = 0; attempt < 2 && !saved && !run.stopped; attempt++) {
          let answer;
          try {
            answer = await this._ask(ctx, system, attempt ? `${user}\n\nThe previous try was not saved: ${run.lastStepError}` : user, 'step');
          } catch (err) {
            run.lastStepError = err.message;
            continue;
          }
          const parsed = agentFiles.extractFiles(answer);
          const block = parsed.files.find((f) => f.path === target) || (parsed.files.length === 1 ? { ...parsed.files[0], path: target } : null);
          if (!block || !block.content.trim()) {
            run.lastStepError = `there was no <file path="${target}"> block.`;
            continue;
          }
          const result = await this._executeToolCall({ function: { name: 'write_file', arguments: { path: target, content: block.content } } }, ctx);
          history.push({ role: 'step', name: 'write_file', path: target, ok: result.ok, denied: !!result.denied, output: truncate(result.output, 400), diff: capDiff(result.diff) });
          ctx.persist();
          if (result.denied) return true;
          saved = result.ok;
          if (!saved) run.lastStepError = String(result.output).replace(/^Error:\s*/, '');
          if (parsed.trailing) reply = parsed.trailing;
        }
        if (ctx.ui) post({ type: 'planStep', path: target, state: saved ? 'done' : 'failed' });
      }
    } finally {
      run.stepwise = false;
    }
    if (reply && !run.stopped) {
      history.push({ role: 'assistant', content: reply });
      ctx.persist();
      if (ctx.ui) {
        post({ type: 'assistantStart', modelName: ctx.modelName });
        post({ type: 'assistantToken', text: reply });
        post({ type: 'assistantEnd' });
      }
    }
    return true;
  },

  // Ids the plan asked for that the pages do not have.
  _planProblems(ctx) {
    const ids = ctx.run.planIds || [];
    if (!ids.length || !ctx.tools) return [];
    const pages = ctx.tools.listSourceFiles(40).filter((rel) => /\.html?$/i.test(rel)).map((rel) => ctx.tools.snapshot(rel) || '').join('\n');
    const missing = ids.filter((id) => !new RegExp(`\\bid\\s*=\\s*["']${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`).test(pages));
    return missing.length ? [`The plan needs elements with these ids, but no page has them: ${missing.map((id) => `#${id}`).join(', ')}. Add them and their code.`] : [];
  }
};

module.exports.parsePlan = parsePlan;
