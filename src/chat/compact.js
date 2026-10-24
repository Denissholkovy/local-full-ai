const { cloud, estimateChars, truncate, CHARS_PER_TOKEN } = require('./common');

// Start summarising when the chat would fill this share of the model's context.
const COMPACT_AT = 0.7;
const SUMMARY_MAX_CHARS = 2400;
const MIN_TURNS_TO_COMPACT = 2;

function asTranscript(messages, maxChars) {
  const lines = messages
    .filter((m) => m.role === 'user' || m.role === 'assistant' || m.role === 'tool')
    .map((m) => {
      if (m.role === 'tool') return `[${m.tool_name || 'tool'} result] ${truncate(String(m.content || ''), 300)}`;
      const calls = (m.tool_calls || []).map((c) => `${c.function && c.function.name}(${truncate(JSON.stringify((c.function && c.function.arguments) || {}), 160)})`);
      const text = truncate(String(m.content || ''), 1500);
      return `${m.role === 'user' ? 'User' : 'Assistant'}: ${text}${calls.length ? ` [called ${calls.join(', ')}]` : ''}`;
    });
  let out = lines.join('\n');
  if (out.length > maxChars) out = `...\n${out.slice(out.length - maxChars)}`;
  return out;
}

// Methods mixed into ChatPanel.prototype (see chatPanel.js).
module.exports = {
  // The part of the history the model still sees word for word; older turns are only in the summary.
  _visibleHistory(ctx) {
    if (ctx.isSub) return ctx.history;
    const start = Math.min(ctx.session.summaryUpTo || 0, ctx.history.length);
    return ctx.history.slice(start);
  },

  _summaryNote(ctx) {
    if (ctx.isSub || !ctx.session.summary) return '';
    return `Summary of the earlier part of this conversation (older messages are not shown):\n${ctx.session.summary}`;
  },

  // When a long chat no longer fits, older turns are replaced by a short summary instead of being dropped.
  async _maybeCompact(ctx) {
    const { session, run } = ctx;
    const budgetChars = Math.floor(this._contextSize(ctx.modelName) * CHARS_PER_TOKEN);
    const visible = this._visibleHistory(ctx).filter((m) => m.role !== 'notice' && m.role !== 'step');
    if (estimateChars(visible) < budgetChars * COMPACT_AT) return;

    const start = Math.min(session.summaryUpTo || 0, session.history.length);
    const userTurns = [];
    session.history.forEach((m, i) => {
      if (i >= start && m.role === 'user' && !m.synthetic) userTurns.push(i);
    });
    if (userTurns.length <= MIN_TURNS_TO_COMPACT) return;
    const cut = userTurns[userTurns.length - MIN_TURNS_TO_COMPACT];

    ctx.post({ type: 'contextTrimmed', text: 'The chat is getting long: summarising the earlier messages so the model keeps the important parts...' });
    const transcript = asTranscript(session.history.slice(start, cut), Math.max(2000, Math.floor(budgetChars * 0.5)));
    const messages = [
      {
        role: 'system',
        content: 'You compress a coding conversation into notes for an assistant who will continue it. Keep: what the user wants, decisions and preferences, files created or changed and why, unfinished work, errors seen. Drop greetings and repeated text. Write short bullet points, at most 250 words, in English.'
      },
      {
        role: 'user',
        content: `${session.summary ? `Earlier notes:\n${session.summary}\n\n` : ''}Conversation to add to the notes:\n${transcript}`
      }
    ];
    try {
      const result = await this._clientFor(ctx.modelName).chatStream(
        ctx.modelName,
        messages,
        null,
        this._modelOptions(ctx.modelName, {
          maxTokens: 700,
          onAbortReady: (abortFn) => run.aborts.add(abortFn)
        })
      );
      const summary = String(result.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
      if (!summary || run.stopped) return;
      session.summary = summary.slice(0, SUMMARY_MAX_CHARS);
      session.summaryUpTo = cut;
      ctx.persist();
    } catch (_) {
      if (!cloud.isCloudModel(ctx.modelName)) return;
      ctx.post({ type: 'contextTrimmed', text: 'Could not summarise the earlier messages; the oldest ones are left out instead.' });
    }
  }
};
