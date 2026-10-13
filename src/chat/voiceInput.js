const { vscode, voice, cloud, VOICE_MAX_MS } = require('./common');

// Methods mixed into ChatPanel.prototype (see chatPanel.js).
module.exports = {
  _cancelVoice() {
    if (this._voiceTimer) clearTimeout(this._voiceTimer);
    this._voiceTimer = null;
    if (this._recording) {
      this._recording.cancel();
      this._recording = null;
    }
    this._post({ type: 'voiceState', state: 'idle' });
  },

  async _toggleVoice() {
    if (this._recording) {
      const recording = this._recording;
      this._recording = null;
      if (this._voiceTimer) clearTimeout(this._voiceTimer);
      this._voiceTimer = null;
      this._post({ type: 'voiceState', state: 'busy' });
      try {
        const wav = await recording.stop();
        const language = vscode.workspace.getConfiguration('localAI').get('voiceLanguage') || 'auto';
        let text;
        if (voice.engine() === 'groq') {
          const apiKey = await this._context.secrets.get('localAI.key.groq');
          if (!apiKey) throw new Error('Voice input via Groq needs the Groq key: add it in the sidebar, Cloud tab.');
          if (!(await this._ensureCloudConsent('cloud:groq:whisper-large-v3-turbo'))) throw new Error('Voice input was not sent to Groq. Switch the engine to Local in Settings, or accept the notice.');
          text = await voice.transcribeGroq(wav, language, apiKey);
        } else {
          text = await voice.transcribe(wav, language);
        }
        this._post({ type: 'voiceResult', text });
      } catch (err) {
        this._voiceError(err);
      }
      this._post({ type: 'voiceState', state: 'idle' });
      return;
    }

    const lacking = voice.missing();
    if (lacking.length) {
      const err = new Error(`Voice input needs: ${lacking.join(', ')}. It works fully offline afterwards.`);
      err.needsSetup = true;
      this._voiceError(err);
      return;
    }

    try {
      this._recording = await voice.startRecording();
    } catch (err) {
      this._voiceError(err);
      return;
    }
    this._post({ type: 'voiceState', state: 'recording' });
    const current = this._recording;
    this._voiceTimer = setTimeout(() => {
      if (this._recording === current) this._toggleVoice();
    }, VOICE_MAX_MS);
  },

  // Whether a Groq key is saved (read asynchronously, cached for the synchronous status message).
  _groqKeyKnown() {
    this._context.secrets.get('localAI.key.groq').then((key) => {
      const has = !!key;
      if (has !== this._groqKey) {
        this._groqKey = has;
        this._sendModelInfo();
      }
    }, () => {});
    return !!this._groqKey;
  },

  _voiceError(err) {
    const permissionHint = err.noAudio
      ? ' Check System Settings > Privacy & Security > Microphone and allow Visual Studio Code (or the app you started it from), then try again.'
      : '';
    this._post({ type: 'voiceError', text: `${err.message}${permissionHint}`, setup: !!err.needsSetup });
  },
};
