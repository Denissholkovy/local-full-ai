const { fs, path } = require('./common');
const imageGen = require('../imageGen');
const consent = require('../consent');

const PREVIEW_MAX_BYTES = 3 * 1024 * 1024;

// Methods mixed into ChatPanel.prototype (see chatPanel.js).
module.exports = {
  _imageConfig() {
    return this._context.globalState.get('localAI.imageGen', null);
  },

  _imagesEnabled(ctx) {
    return imageGen.isConfigured(this._imageConfig()) && !!ctx.tools && ctx.mode !== 'readonly' && (!ctx.isSub || ctx.subMode === 'worker');
  },

  async _generateImage(ctx, args, id) {
    const { tools, run } = ctx;
    const config = this._imageConfig();
    const sendsOut = imageGen.consentName(config);
    if (sendsOut && !(await consent.ensure(this._context, sendsOut))) {
      throw new Error('The user did not allow sending the picture description to the image service. Use an SVG file instead, or ask the user.');
    }
    const wanted = String(args.path || '').trim();
    if (!/\.(png|jpe?g|webp)$/i.test(wanted)) throw new Error('"path" must end in .png, .jpg or .webp.');
    if (fs.existsSync(tools.resolve(wanted, 'write'))) throw new Error(`${wanted} already exists. Pick a new file name; existing pictures are never overwritten.`);

    const controller = new AbortController();
    const abort = () => controller.abort();
    run.aborts.add(abort);
    let result;
    try {
      result = await imageGen.generate(config, args, {
        signal: controller.signal,
        secrets: (c) => this._cloud.credentials(c.kind === 'huggingface' ? 'huggingface' : c.providerId)
      });
    } finally {
      run.aborts.delete(abort);
    }

    const rel = imageGen.fixExtension(wanted, result.mime);
    const abs = tools.resolve(rel, 'write');
    if (fs.existsSync(abs)) throw new Error(`${rel} already exists. Pick a new file name.`);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, result.buffer);

    const shown = tools.relative(abs);
    run.changes.set(abs, { abs, rel: shown, before: null, after: null, binary: true });
    this._rememberFile(ctx.session, shown);
    if (ctx.ui && result.buffer.length <= PREVIEW_MAX_BYTES) {
      ctx.post({ type: 'imagePreview', id, path: shown, dataUrl: `data:${result.mime};base64,${result.buffer.toString('base64')}` });
    }
    const size = `${imageGen.clampSize(args.width)}x${imageGen.clampSize(args.height)}`;
    return `Saved the picture to ${shown} (about ${size}, ${Math.round(result.buffer.length / 1024)} KB).${rel !== wanted ? ` The service returned a ${result.mime} file, so the extension was changed: use "${shown}".` : ''} Reference this path in the code.`;
  }
};
