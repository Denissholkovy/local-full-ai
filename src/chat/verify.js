const { vscode, fs, path, projectCheck, truncate, isTinyModel } = require('./common');
const { spawnSync } = require('child_process');

const MAX_FIX_ROUNDS = 2;

function syntaxProblem(abs, rel) {
  const ext = path.extname(abs).toLowerCase();
  try {
    if (ext === '.json') {
      JSON.parse(fs.readFileSync(abs, 'utf8'));
      return null;
    }
    if (['.js', '.mjs', '.cjs'].includes(ext)) {
      const out = spawnSync(process.execPath, ['--check', abs], {
        encoding: 'utf8',
        timeout: 10000,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
      });
      if (out.status === 0 || out.error) return null;
      const text = `${out.stderr || ''}`.trim();
      if (/Cannot use import statement|Unexpected token 'export'|ERR_REQUIRE_ESM/.test(text)) return null;
      const line = text.split('\n').filter((l) => /SyntaxError|^\s*\^/.test(l) || l.includes(abs)).slice(0, 3).join(' ');
      return `${rel}: syntax error ${line.replace(abs, rel).slice(0, 240)}`;
    }
    if (ext === '.py') {
      const out = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-m', 'py_compile', abs], { encoding: 'utf8', timeout: 10000 });
      if (out.error || out.status === 0) return null;
      return `${rel}: ${String(out.stderr || '').trim().split('\n').slice(-2).join(' ').slice(0, 240)}`;
    }
  } catch (err) {
    return `${rel}: ${err.message.slice(0, 200)}`;
  }
  return null;
}

// Methods mixed into ChatPanel.prototype (see chatPanel.js).
module.exports = {
  // Fast checks that need no model: syntax of the changed files and broken links between HTML and JS.
  _quickChecks(ctx) {
    const problems = [];
    const changes = [...ctx.run.changes.values()];
    for (const c of changes) {
      if (!fs.existsSync(c.abs)) continue;
      const problem = syntaxProblem(c.abs, c.rel);
      if (problem) problems.push(problem);
    }
    if (changes.some((c) => /\.(html?|m?js)$/i.test(c.rel))) {
      const found = projectCheck.format(projectCheck.run(ctx.tools));
      if (found) problems.push(found);
    }
    return problems;
  },

  _verifyMode(ctx) {
    const setting = vscode.workspace.getConfiguration('localAI').get('verifyChanges') || 'auto';
    if (setting === 'off') return 'off';
    if (isTinyModel(ctx.modelName)) return 'quick';
    if (ctx.compact && setting !== 'always') return 'quick';
    return 'full';
  },

  // After the agent changed files: check the work, and if something is wrong let the agent fix it (a few rounds).
  async _verifyAndFix(ctx) {
    const { run, post, history } = ctx;
    for (let round = 1; round <= MAX_FIX_ROUNDS + 1; round++) {
      const mode = this._verifyMode(ctx);
      if (mode === 'off' || run.stopped || !ctx.tools || !run.changes.size || ctx.mode === 'readonly') return;

      const problems = this._quickChecks(ctx);
      if (mode === 'full' && ctx.toolsEnabled && !problems.length) {
        const files = [...run.changes.values()].map((c) => `${c.rel}${c.before === null ? ' (new)' : ''}`).join(', ');
        const task = `The user asked: "${truncate(run.task, 1500)}"\n\nThe other agent changed these files: ${files}.\n\nCheck that the task is done and that everything works together. Run the project's tests or checks if it has them. End with "VERDICT: PASS" or "VERDICT: FAIL" and the list of problems.`;
        const result = await this._executeToolCall(
          { function: { name: 'delegate_task', arguments: { title: 'Check the work', task, mode: 'verify' } } },
          ctx
        );
        history.push({ role: 'step', name: 'delegate_task', path: null, ok: result.ok, output: truncate(result.output, 1500) });
        ctx.persist();
        if (run.stopped) return;
        const report = String(result.output || '');
        const failed = /VERDICT:\s*FAIL/i.test(report);
        if (failed) problems.push(report.slice(report.search(/VERDICT:\s*FAIL/i)).replace(/VERDICT:\s*FAIL\s*/i, '').trim() || report.slice(-1200));
      }

      if (!problems.length) {
        if (round > 1 || mode === 'full') post({ type: 'notice', text: mode === 'full' ? 'Checked by a reviewer agent: the changes look correct.' : 'Quick check passed: no syntax errors or broken links.' });
        return;
      }
      if (round > MAX_FIX_ROUNDS) {
        post({ type: 'notice', text: `The checks still report problems after ${MAX_FIX_ROUNDS} fixes. Please look at them:\n${truncate(problems.join('\n'), 1200)}` });
        return;
      }
      const snapshot = this._snapshotChanges(ctx);
      const before = this._quickChecks(ctx);
      post({ type: 'notice', text: `The check found problems, fixing them (round ${round} of ${MAX_FIX_ROUNDS})...` });
      history.push({
        role: 'user',
        synthetic: true,
        content: `[check] Your changes have these problems:\n${truncate(problems.join('\n'), 2500)}\n\nFix only these problems with small edit_file changes; read the file first. Keep all existing code and functions that still work. Do not rewrite whole files. Then reply in one or two short sentences.`
      });
      ctx.persist();
      run.finished = false;
      await this._agentLoop(ctx);
      if (run.stopped) return;
      const after = this._quickChecks(ctx);
      const worse = after.filter((p) => !before.includes(p));
      if (worse.length) {
        this._restoreSnapshot(ctx, snapshot);
        const text = `The fix made things worse (${truncate(worse.join(' '), 300)}), so it was undone. The files are as they were before the fix.`;
        history.push({ role: 'notice', content: text });
        ctx.persist();
        post({ type: 'notice', text });
        return;
      }
    }
  },

  _snapshotChanges(ctx) {
    const map = new Map();
    const files = new Set([...ctx.run.changes.keys()]);
    files.forEach((abs) => {
      try {
        map.set(abs, fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null);
      } catch (_) {
        map.set(abs, null);
      }
    });
    return map;
  },

  // Puts the files back as they were when the snapshot was taken (files created since then are removed).
  _restoreSnapshot(ctx, snapshot) {
    for (const abs of ctx.run.changes.keys()) {
      try {
        if (snapshot.has(abs)) {
          const text = snapshot.get(abs);
          if (text === null) {
            if (fs.existsSync(abs)) fs.unlinkSync(abs);
          } else {
            fs.writeFileSync(abs, text);
          }
        } else if (fs.existsSync(abs)) {
          const change = ctx.run.changes.get(abs);
          if (change.before === null) fs.unlinkSync(abs);
          else fs.writeFileSync(abs, change.before);
        }
        const change = ctx.run.changes.get(abs);
        change.after = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
      } catch (_) {
      }
    }
  }
};
