# Changelog

All notable changes to the "Local Full AI" extension are documented here.

## [0.1.0] - 2026-10-13

A large release: the chat now works on your project.

### Added
- **Undo all changes**: after a request that edited files, the chat shows a bar with *Undo all changes* that restores every
  touched file (and removes the files the AI created).
- **Attach Git changes or Problems** with one click from the + menu.
- **Cloud: smoother limits.** The extension waits for the per-minute reset instead of hitting a 429, retries busy providers (503),
  and after a failure offers your other cloud models with one click.
- **Cloud: capabilities from the API** (vision, tools) where the provider reports them, and model lists marked "weak for agent",
  "basic agent" or "agent-ready"; Gemini lists only models that can chat; Gemini 3 thought signatures are kept for tool calls.
- **Voice input through Groq Whisper** as an alternative to the offline engine (`localAI.voiceEngine`).
- **Ukrainian interface** (`localAI.language`, follows VS Code by default).
- **Copy Diagnostics for a Bug Report** command (no keys, chats or file contents).
- Internal: the chat panel was split into smaller modules under `src/chat/`.
- **Clear Local vs Cloud sidebar**: an *Active model* card labelled LOCAL or CLOUD (with provider and a privacy hint), separate *This computer* / *Cloud* tabs, and one Settings section that is always available (even when Ollama is not running), grouped as Both / Local only / Cloud only, including a new *Cloud context size* option.
- **Project tools**: list, read, search, create and edit files and run commands in the open folder, shown as steps with
  an expandable diff, *Open file* and *Open diff*. Every change asks for approval; modes Ask / Edit automatically /
  Read only / Autopilot.
- **Autopilot** with a plan, verification, retries, command blocklist, keep-awake (macOS) and a notification when done.
- **Helper agents** (parallel research and worker agents) with their own model setting, a tool-less reader mode for
  small models, and a badge showing agents and token usage.
- **Folder access control**: Full / Ask first / Read only / No access per folder, extra folders, a working folder.
- **Skills for every model**: matching Claude skills are picked automatically and given to the model; cached on disk;
  `/skill-name` applies one by hand; `CLAUDE.md` files are included.
- **Models**: choose the quantization from the live Ollama list, hardware-aware recommendations (fits well / tight /
  slow / too heavy), cancel downloads, response modes (Precise / Balanced / Creative / Custom), context length and
  GPU / CPU settings, announcement of model changes in the chat.
- **Free cloud models (opt-in)**: connect Groq, OpenRouter, Google Gemini, Mistral, Cerebras or any OpenAI-compatible API with your own key (stored in VS Code secret storage); models are listed from the provider; works with project tools, autopilot, helper agents and skills; explicit data-sharing notice, cloud badge, rate-limit waiting and clear errors; local models stay the default and are never replaced silently. Free-tier limits are shown when the provider reports them (requests/tokens left and reset times, OpenRouter credit check).
- **Voice input** (offline, whisper.cpp) with install and remove in Settings.
- Chat list with search and a running indicator, independent generations per chat, clarifying-question dialog,
  pasted code as attachments, markdown headings and lists, automatic project check for HTML/JS.
- Workspace Trust support (Restricted Mode: chat only) and virtual workspace handling.

### Changed
- Model catalog reduced to 14 current models with `tools` / `thinking` tags and recommended picks.
- Sidebar and chat redesigned; their code moved to `media/sidebar` and `media/chat`.
- Default response mode is Precise (temperature 0.2) for more reliable code and tool calls.

### Fixed
- Cloud models burned the whole free per-minute token limit on the first request (long prompt, many tool descriptions), causing endless "limit reached, waiting" pauses: cloud requests now use a compact mode sized from the provider's reported limit, and history trimming never drops the user's request.
- The model hunted for the project files with searches and asked the user which file to fix: the relevant project files are now put into the prompt for fix/change requests.
- Ollama reported as not running when it was installed (IPv6 `localhost`, missing PATH entries); processes started
  by the extension are stopped when VS Code closes.
- A reply from one chat could be written into another after switching chats.
- Several cases where the model pasted code into the chat or claimed edits it did not make.

## [0.0.1] - 2026-07-28

### Added
- Sidebar wizard to check for Ollama, install it (Linux, macOS with Homebrew) and pick a model.
- Curated model catalog with download progress, one-click delete, quick switch.
- Chat panel with streaming, Stop, themed code blocks (Copy / Insert), file and image attachments, per-message actions.
- "Ask about selected code" in the editor context menu.
- Fully offline operation after the model is downloaded; all requests go to `localhost`.
