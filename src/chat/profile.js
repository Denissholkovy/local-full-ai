const { vscode, cloud } = require('./common');
const agentProfile = require('../agentProfile');
const usageStats = require('../usageStats');

// Methods mixed into ChatPanel.prototype (see chatPanel.js).
module.exports = {
  // { mode: 'direct' | 'standard' | 'agent', reason } for this model on this computer.
  async _workProfile(modelName, nativeTools) {
    const setting = String(vscode.workspace.getConfiguration('localAI').get('agentMode') || 'auto');
    const parsed = cloud.parseName(modelName);
    const isCloud = cloud.isCloudModel(modelName) || cloud.isOllamaCloud(modelName);
    let parameterSize = '';
    if (!isCloud) {
      try {
        const installed = (await this._installedModelDetails()).find((m) => m.name === modelName);
        parameterSize = installed ? installed.parameterSize : '';
      } catch (_) {
      }
    }
    const measured = usageStats.summary(this._context, 7).find((r) => r.model === modelName);
    const facts = {
      setting,
      cloud: isCloud,
      localServer: cloud.isLocalServer(modelName),
      rank: parsed ? cloud.rank(parsed.modelId) : cloud.isOllamaCloud(modelName) ? 'best' : 'ok',
      compact: !!parsed && this._cloudBudget(modelName) <= 8000,
      nativeTools,
      size: agentProfile.billions(modelName, parameterSize),
      tokensPerSec: measured && measured.requests >= 2 ? measured.tokensPerSec : 0
    };
    const mode = agentProfile.decide(facts);
    return { mode, reason: agentProfile.why(mode, facts) };
  },

  async _installedModelDetails() {
    const models = await this._ollamaClient.listLocalModels();
    return models.map((m) => ({ name: m.name, parameterSize: (m.details && m.details.parameter_size) || '' }));
  }
};
