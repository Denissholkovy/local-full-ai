# Changelog

All notable changes to the "Local Full AI" extension are documented here.

## [Unreleased]

### Fixed
- Small local models (under 13B, such as qwen3:4b) spent minutes "thinking" before every short answer. Thinking now has a
  budget (about 1000 tokens for small models, 4000 for big ones, none with "Deep"): when it is used up, or the model thinks
  in circles, the thinking is closed and the model continues straight with the answer. Models that cannot switch thinking
  off (Qwen3 "Thinking" builds) are no longer sent think:false, which made their thoughts appear as the answer, and
  thoughts that leak into an answer are hidden.
- Models use their own recommended sampling settings (temperature and so on) again; a fixed low temperature made
  thinking models loop.
- A feature could be "done" with buttons that do nothing (a calculator of three buttons and no code). The checks after a
  change now report new buttons and fields that no script uses, and the AI adds the missing logic.
- Local models could show the same answer twice: a model that repeats its previous text after a tool result or a fix
  round, an autopilot summary written both as text and in finish_task, and a retried request that left the cut-off text of
  the failed attempt in front of the new one.
- Cloud answers were stopped after 2 minutes in total, also while they were still streaming or waiting for a rate limit.
  Now only 90 seconds of silence stop a request.
- A large file written by a cloud model could be cut off by the output limit and saved half empty. Cut-off tool calls are
  dropped and the model is asked to write the file in parts; the output limit is 8K tokens where the provider allows it.
- Limits of Groq, Gemini and Cerebras are tracked per model, so one model's used-up budget no longer delays another.
- Tool and image support of local models is read from Ollama (`/api/show`) instead of guessed from the name, and the
  context length never exceeds what the model supports.
- Ollama requests had no timeout: a model that never answered hung the chat. The chat now says when a model is being
  loaded into memory.
- "Ask About Selected Code" lost the selection when the chat panel opened for the first time.
- Chats are stored as files in the extension storage instead of VS Code's global state (old chats are moved over), which
  kept pictures and tool output in memory on every start.
- A fix round could break working code: the reviewer reported a non-problem and the model rewrote a whole file, dropping
  functions the page still used. Now a rewrite that removes functions still in use is undone right away, a fix round
  that makes the checks worse is rolled back, and the reviewer only fails real breakage (quoting the wrong line).

### Changed
- Fewer settings. Removed: Response mode and its Custom values (temperature, top-p, top-k, repeat penalty; answers always
  use the precise preset, the most reliable for code and tools), GPU layers (Ollama decides), `multiAgent` (the work mode
  decides about helper agents), "Send active file" (the open file is already shown to the model) and the unused
  `selectedModel`. Keep model in RAM, Cloud context size and Helper agents model left the sidebar (still in the settings
  JSON); models now stay loaded for 30 minutes by default.
- **Work modes** (`localAI.agentMode`, shown next to the model in the chat): **Fast** for 4B and slow models (the model
  gets the relevant files and answers with complete files in one pass), **Standard** for 7-13B (tools and a short plan
  with checkable items, no helper agents), **Agent** for strong cloud models and fast 14B+ (full loop with helpers).
  Auto picks from the model's size and its measured speed.
- The files shown to the model include the scripts and styles linked from a page, so a feature can get its JavaScript.
- A file written with a block repeated (a page pasted twice) is not saved, and the model is told why.
- `edit_file` also finds the code when only the indentation differs.
- Shorter, clearer replies: the answer first, no introductions.
- Helper agents no longer start for every task. They are offered only when you ask for them, or for tasks in a large
  project (60+ source files), at most 3 per request (6 in autopilot), and each gets a structured brief (goal, known files,
  what is already known, the report it must return). "Parallel" or "user agent" in a message no longer forces them.
- The reviewer agent runs only for bigger changes (3+ files or 80+ changed lines, and in autopilot); small edits get the
  quick checks. `localAI.verifyChanges: "always"` keeps the old behaviour.
- Autopilot runs only test/build/lint/inspect commands (plus `localAI.autopilotCommands`) and never a script it
  just wrote; very small models (4B and below) no longer start helper agents.
- The sidebar no longer runs uninstall commands for Ollama; it shows the steps instead.
- Webviews have a Content-Security-Policy.
- Windows: command and Ollama processes are stopped with their whole process tree; voice input works with ffmpeg.

### Added
- **OpenAI-compatible servers**: LM Studio, llama.cpp, Jan, vLLM or any other address, as many as you like, key optional.
  Servers on this computer need no cloud notice.
- **Ollama Cloud** models (Kimi K2.7 Code, GLM 5.3, DeepSeek V4, MiniMax M3) through your Ollama, with sign-in from the sidebar.
- New providers: Hugging Face, NVIDIA, DeepSeek, OpenAI and Anthropic (the paid ones are marked).
- **Switch model when a limit is hit** (`localAI.cloudAutoFallback`): continue with your next cloud model instead of waiting.
- **Pictures**: the agent can make images for the project (`generate_image`) with Stable Diffusion WebUI / Forge / Draw
  Things on this computer, Hugging Face, or an OpenAI-compatible images API; previews in the chat; command
  **Generate Image**. Icons are still drawn as SVG.
- **Code completion as you type** with a small local model (`localAI.autocomplete`, status bar toggle).
- **Meaning search** (`semantic_search`) with a local embedding model such as nomic-embed-text.
- **MCP servers**: tools from `localAI.mcpServers` and, after you allow each one, the project's `.mcp.json`.
- **`@local`** in VS Code's own chat view.
- **`get_problems`**: the agent reads the Problems panel, and the checks after a change include new errors from the
  language servers.
- **Edit a message**: removes it and what followed, puts its text back in the input and can restore the files the AI changed
  since then (every request keeps a checkpoint).
- **Write Commit Message** in Source Control, **Fix Selected Terminal Error** in the terminal menu, and
  **Fix / Explain with Local Full AI** on the light bulb.
- **`web_fetch`**: the agent can read public web pages after you approve each one (never in autopilot).
- **Reviewer model** (`localAI.reviewerModel`): a second model checks the work.
- **Thinking** setting for local reasoning models (fast / deep).
- Long chats are summarised instead of silently dropping the oldest messages.
- **Usage statistics** per model and day.
- Unit tests (`npm test`) that also run in CI before publishing.
: after a task that changed files, quick checks plus (for capable models) a reviewer agent check the
  work and the AI fixes what is broken, up to two rounds (`localAI.verifyChanges`).
- **Project memory** (`.localai/memory.md`, plus `AGENTS.md` / `CLAUDE.md`) and a map of where things are defined in
  every request.
- **First-run choice** between running on this computer and a free cloud provider.
- Recommended local models are refreshed daily from the project repository.
- Undo all changes survives a restart.
- Cloud models with a tiny free limit are marked "tiny free limit" and offered last as fallbacks.

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
