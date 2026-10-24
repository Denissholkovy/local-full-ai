const mcpConfig = require('../mcpConfig');

// Methods mixed into ChatPanel.prototype (see chatPanel.js).
module.exports = {
  // { defs, lookup } of the MCP tools that are ready, or null.
  async _mcpTools() {
    try {
      const { defs, lookup } = (await mcpConfig.ensure(this._context)).definitions();
      return defs.length ? { defs, lookup } : null;
    } catch (_) {
      return null;
    }
  },

  _mcpEntry(ctx, name) {
    return (ctx.mcp && ctx.mcp.lookup.get(name)) || null;
  },

  _mcpDefinitions(ctx) {
    if (!ctx.mcp || ctx.compact) return [];
    if (ctx.isSub && ctx.subMode !== 'worker') return ctx.mcp.defs.filter((d) => this._mcpEntry(ctx, d.function.name).readOnly);
    return ctx.mcp.defs;
  },

  // Autopilot cannot ask, so it only uses MCP tools that say they only read, or servers marked "autoApprove".
  _mcpBlockedInAutopilot(entry) {
    return !entry.readOnly && !(mcpConfig.specFor(entry.server) || {}).autoApprove;
  },

  _callMcp(entry, args) {
    return mcpConfig.manager.call(entry.server, entry.tool, args);
  }
};
