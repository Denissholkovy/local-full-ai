# Changelog

All notable changes to the "Local Full AI" extension are documented here.

## [0.0.1] - 2026-07-28

### Added
- Sidebar wizard (Activity Bar icon) to check for Ollama, install it automatically (Linux / macOS with Homebrew), and pick a model without touching the Command Palette.
- Curated catalog of 39 Ollama models (`code`, `general`, `vision` categories) with download progress bars.
- One-click delete for installed models, plus a quick-switch chip list when more than one model is installed.
- Chat panel that opens in a split to the right of the editor, with:
  - Streaming responses with a working Stop button.
  - Markdown rendering with properly styled, editor-themed code blocks (Copy / Insert into editor).
  - File attachments: text/code files are always supported; image attachments only appear for vision-capable models.
  - Per-message actions: copy an AI reply's text (excluding code, which has its own copy button) and edit/resend your own messages.
- "Ask about selected code" command available from the editor's right-click menu.
- Fully custom icon set (no emoji) sourced from `media/icons/`.
- 100% offline operation after the model is downloaded - all requests go to `localhost` only.
