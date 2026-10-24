# Local Full AI

A private AI coding assistant that runs **on your computer by default**, powered by [Ollama](https://ollama.com).
Local models too weak? You can optionally connect a **free cloud model** (Groq, OpenRouter, Google Gemini and others) with your own free key.
Chat about your code, let it create and edit files in your project (with your approval), run on autopilot,
split big jobs between helper agents, talk to it with your voice, and manage your models,
all inside VS Code. Local use needs no account, no API key and no subscription, and your code stays on your machine.
Cloud models are strictly opt-in and clearly marked.

## Highlights

**Fast where it can be, agent where it pays off**
- **Work mode** (shown next to the model in the chat, Settings > Work mode): **Fast** for small or slow models: the model
  gets the relevant files (a page together with its scripts and styles) and answers with complete files in one pass.
  **Standard** for 7-13B: tools and a short plan with checkable items. **Agent** for strong cloud models and 14B+ models
  that run fast: full tool loop with helper agents for big jobs. Auto picks from the model's size and its measured speed.
- Small models answer without minutes of "thinking"; a model that thinks too long or in circles is asked again without it.
- New buttons that no script uses, and files with a block pasted twice, are caught and sent back to the model.

**Works on your project**
- Reads, searches, creates and edits files in the open folder and shows the work as steps
  (*Creating index.html*, *Updating script.js*) with an expandable diff, **Open file** and **Open diff**.
- Every edit and command asks first (*Allow* / *Allow in this chat* / *Deny*, or type what to do instead).
  Modes: **Ask before edits**, **Edit automatically**, **Read only**, **Autopilot**.
- The chat is for talking and corrections: code goes into files, not into the conversation.
  Ask for a change later and it continues from the current file on disk, including your own edits.
- **Autopilot**: give a task and walk away. It plans, works, checks the project, retries, and stops only when
  everything on its checklist is done. Dangerous commands (`sudo`, `git push`, destructive deletes) are blocked.
- **Helper agents**: for big jobs the main chat can start research and worker agents in parallel, each with a brief
  (goal, known files, what is already known, the report it must return). They are slow, so they are offered only when
  you ask for them or the project is large (60+ source files), at most 3 per request. Research helpers can run on a
  small fast model. A badge shows how many agents ran and the tokens used.
- It can **ask you** a clarifying question in a small dialog above the input.

**Checks its own work**
- When the AI finishes a task that changed files, quick checks run (syntax of the changed files, HTML ids, `onclick`
  handlers, missing scripts, new errors in the Problems panel). For bigger changes (3+ files or 80+ changed lines, and
  in autopilot) a **reviewer agent** then reads the changes, runs the project's tests when there are any, and answers
  PASS or FAIL. If something is wrong, the AI fixes it, up to two rounds
  (`localAI.verifyChanges`).
- **Undo all changes** restores every file the last request touched, also after VS Code was restarted.

**Learns your project**
- The AI keeps short notes about your project in `.localai/memory.md` (how to run tests, conventions, pitfalls) and reads
  them in every new chat. It is plain Markdown: edit or delete it as you like. `AGENTS.md` or `CLAUDE.md` in the project
  root are read too.
- Every request includes a small map of where functions, classes and element ids are defined, so small models open the
  right file instead of guessing.
- This is not fine-tuning: training a model on your code needs a strong GPU and hours per change, and rarely helps more
  than giving the model the right files and notes.

**Safe by design**
- **Folder access levels** per folder: Full, Ask first, Read only, No access (hidden). Add extra folders, pick the
  working folder. The file tools never read or write outside the folders you allow. Commands run in the working
  folder and always need your approval. Autopilot (which cannot ask) only runs commands that test, build, lint or inspect
  the project (`npm test`, `npm run build`, `pytest`, `git status` ...), never a script it just wrote itself; add your own
  with `localAI.autopilotCommands`. Note that running tests still executes your project's code.
- Respects VS Code **Workspace Trust**: in Restricted Mode the AI can only chat.
- When VS Code closes, everything the extension started is stopped (an Ollama installed as a system service keeps
  running, but its models are unloaded from memory).

**Free cloud models, when local ones are too weak**
- Settings > Cloud providers (or **Connect a cloud provider** in the sidebar): pick Groq, OpenRouter, Google Gemini,
  Mistral, Cerebras, Hugging Face or NVIDIA, create a free API key on their site, paste it, and tick the models you want.
  Paid providers (DeepSeek, OpenAI, Anthropic) are marked. The list comes straight from the provider's API, so it is never
  out of date.
- **Ollama Cloud**: very large models (Kimi K2.7 Code, GLM 5.3, DeepSeek V4...) through your own Ollama, no key: sign in
  once from the sidebar. The free plan has a monthly allowance and runs one request at a time.
- **Your own servers**: LM Studio, llama.cpp, Jan, vLLM or any OpenAI-compatible address, as many as you like, key optional.
  Servers on this computer count as local.
- **Switch model when a limit is hit** (off by default): the answer continues with your next cloud model at once.
- Cloud models work everywhere a local one does: project tools, autopilot, helper agents, skills, files steps.
- Your key is kept in VS Code's secret storage. Before the first cloud message you must accept a notice that your
  messages and the files the AI reads will be sent to that provider. The model chip shows a **cloud** badge and the
  chat announces the switch. The extension never falls back from a local model to a cloud one by itself.
- **Limits are visible.** Next to a cloud model the chat shows what is left (for example "450 tok left", turning orange
  and red as it runs low); click it for every limit the provider reports (requests and tokens per minute/day, reset times)
  and a link to the provider's limits page. Settings > Cloud providers shows the same per provider, and OpenRouter has a
  **Check now** button for credit and quota. Providers that do not report limits (for example Google Gemini) say so.
- **No surprise 429s.** The extension reads the remaining per-minute budget from the provider and waits for the reset before a request that would not fit. Busy providers (error 503) are retried automatically. If a model still fails, the chat offers your other cloud models with one click and retries the request.
- Providers that publish it (OpenRouter) tell the extension which models see images and use tools, so this is read from the API instead of guessed from the name. Model lists mark weak models ("weak for agent", "basic agent", "agent-ready") so you know what to trust with project work.
- Free tiers have limits (per minute, per day, tokens). When a limit is hit the chat waits and retries, then tells you
  clearly. Cloud context is kept modest (`localAI.cloudContextSize`) to fit those limits. Limits and data policies are the
  provider's and change over time; use each provider's **Limits** link.
- **Built for small free limits.** For cloud models with a small per-minute token limit the extension switches to a
  compact mode (shorter instructions, fewer and shorter tool descriptions, a small project snapshot, no skill list) and
  sizes the request from the limit the provider reports, so one answer does not use up the whole minute. The project
  files relevant to your request are shown to the model directly, so it does not waste requests searching for them.

**Models made easy**
- Guided Ollama setup, a hand-picked catalog (Code, General, Vision), cancel a download any time.
- **Pick the quantization** from the live Ollama list with exact sizes and context length.
- **Fit for your computer**: Apple Silicon, NVIDIA or CPU is detected; every model and quantization is marked
  *fits well / tight / slow / too heavy*, with a recommended pick.
- Context length from 4K to 128K (never more than the model supports). Answers use low randomness, the most reliable
  setting for code and tools, and the model stays loaded for 30 minutes between messages so answers start quickly.
- Switching the model is announced in the chat.

**More than chat**
- **Code completion as you type**: grey suggestions from a small local model (for example `qwen2.5-coder:1.5b`), Tab to
  accept. Off by default; toggle it in the status bar.
- **Meaning search**: with a local embedding model (`nomic-embed-text`) the agent finds "where the login is handled"
  without knowing the names (`semantic_search`). The index is built on this computer and updated as files change.
- **Pictures for your project**: the agent saves illustrations and backgrounds with `generate_image` using Stable
  Diffusion WebUI / Forge / Draw Things on this computer, Hugging Face, or an OpenAI-compatible images API. Choose it in
  Settings > Image generation, or run **Generate Image**. Icons and logos are drawn as SVG.
- **MCP servers**: tools from your own servers (`localAI.mcpServers`) and the project's `.mcp.json` (each one only after you
  allow it). Every call that is not marked read-only asks first.
- **Problems panel**: the agent reads errors from TypeScript, ESLint, Python and other language servers (`get_problems`),
  and the checks after a change include the new ones.
- **Web pages**: the agent can read documentation or an issue (`web_fetch`) after you approve each page.
- **Edit a message** to try again: the chat goes back to that point and, if you want, the files too.
- **Write Commit Message** (Source Control), **Fix Selected Terminal Error** (terminal menu), **Fix / Explain with Local
  Full AI** (light bulb on an error), and **`@local`** in VS Code's own chat view.
- **Reviewer model**: let a second, stronger model check the work. **Usage statistics** per model and day.

**Your Claude skills, on every model**
- Skills from `~/.claude/skills`, `<project>/.claude/skills` and your own folders are matched to each request
  (also from Ukrainian or Russian wording) and handed to the model directly, so small models without tool calling use
  them too. `/skill-name` applies one by hand. `CLAUDE.md` files are included. The index is cached between sessions.

**Voice, offline**
- Dictate with the microphone button. Recording and transcription run locally (`ffmpeg` or `sox` plus whisper.cpp).
  One click installs what is missing; one click removes it again.

## Requirements

- VS Code 1.85 or newer.
- [Ollama](https://ollama.com). The sidebar can install it for you on macOS (Homebrew) and Linux; on Windows use the
  official installer.
- Enough memory for the model you pick. A 7B model in 4-bit needs about 6 GB free; the sidebar tells you what fits.
- Optional: `ffmpeg` or `sox` and `whisper-cpp` for voice input.

## Getting started

1. Click the **Local Full AI** icon in the activity bar.
2. Install or start Ollama if the sidebar asks.
3. Pick a model under **Get more models** (look for the ★ *best for your PC* tag and the **tools** tag) and wait for it to download.
4. Press **Open chat**. Open a folder in VS Code so the AI can work on your project.
5. Try: *"Create a simple calculator in index.html"*, or select code and run **Ask about selected code**.

Tips: models tagged `tools` (Qwen2.5 Coder 7B or larger, Qwen3) work on your project; models without it still save
code into files ("files mode") but cannot read your project on their own. Small models are fast but need clear, short requests.

## Settings

Most options are in the sidebar under **Settings**. The full list:

| Setting | Default | What it does |
|---|---|---|
| `localAI.ollamaBaseUrl` | http://localhost:11434 | Address of the local Ollama server |
| `localAI.useClaudeSkills` | on | Load your Claude skills (~/.claude/skills and <project>/.claude/skills) and CLAUDE.md files into the chat. Use /skill-name in the chat or let the model pick one. |
| `localAI.extraSkillFolders` | [] | Extra folders that contain skills (each skill is a subfolder with a SKILL.md). |
| `localAI.folderAccess` | [] | Folders the AI may use and how far it may go in each. The deepest matching folder wins. Project folders default to full. |
| `localAI.workingFolder` | (empty) | Folder the AI works from (relative paths and commands). Empty means the open project folder. |
| `localAI.unloadModelsOnClose` | on | When VS Code closes, unload the models from RAM if Ollama was started by something other than this extension. A server started by this extension is stopped completely. |
| `localAI.autoSkills` | on | Pick the skills that match each request and give them to the model directly, so skills work with every model (no tool calling needed). |
| `localAI.cloudContextSize` | 12000 | (Settings JSON only; lowered automatically from the provider's limits) How many tokens of chat and project context are sent to a cloud model. Free tiers have small per-minute token limits, so keep this modest. |
| `localAI.agentMode` | auto | How the AI works: auto, direct (fast, one pass with complete files), standard (tools and a plan) or agent (tools and helper agents). |
| `localAI.subagentModel` | (empty) | (Settings JSON only) Model for research helper agents. Empty = same as the chat, "auto" = the smallest installed model, or an exact model name. A small model is fast for simple reading tasks; helpers that edit files always use the chat model. |
| `localAI.language` | auto | Language of the sidebar and chat interface: "auto" follows VS Code, "en" English, "uk" Ukrainian. Applies when the panel is opened again. Messages from VS Code itself (pickers, notifications) stay in English. |
| `localAI.voiceEngine` | local | Speech recognition for voice input: "local" (offline whisper.cpp, nothing leaves the computer) or "groq" (Groq Whisper in the cloud: fast and accurate, needs the Groq key, the recording is sent to Groq). |
| `localAI.voiceLanguage` | auto | Language for voice input (whisper language code such as en, uk, ru) or auto to detect. |
| `localAI.whisperBinaryPath` | (empty) | Path to whisper-cli (whisper.cpp). Empty means search PATH and Homebrew. |
| `localAI.whisperModelPath` | (empty) | Path to a whisper.cpp ggml model. Empty means ~/.local-full-ai/whisper/ggml-base.bin. |
| `localAI.contextSize` | 16384 | Context window (tokens) requested from Ollama. Larger values remember more of the project but use more RAM. Never more than the model supports. |
| `localAI.thinking` | auto | Thinking for local reasoning models: auto, fast (little thinking) or deep. |
| `localAI.autocomplete` | off | Code completion as you type with a small local model. |
| `localAI.autocompleteModel` | (empty) | Model for code completion; empty = the smallest installed model that can fill in the middle. |
| `localAI.embeddingModel` | (empty) | Local embedding model for meaning search; empty = auto, "off" = not used. |
| `localAI.reviewerModel` | (empty) | Model of the reviewer agent; empty = the chat model. |
| `localAI.cloudAutoFallback` | off | When a cloud model hits its limit, continue with your next cloud model instead of waiting. |
| `localAI.webFetch` | on | Let the agent read public web pages after your approval. |
| `localAI.mcp` | on | Use the tools of your MCP servers. |
| `localAI.mcpServers` | {} | MCP servers in the Claude Code format (`command`/`args`/`env` or `type: "http"` + `url`); user settings only. |

## Commands

- **Local Full AI: Select / Download Model** (`localAI.selectModel`)
- **Local Full AI: Open Chat** (`localAI.openChat`)
- **Local Full AI: Ask About Selected Code** (`localAI.askAboutSelection`)
- **Local Full AI: Generate Image** (`localAI.generateImage`)
- **Local Full AI: Write Commit Message** (`localAI.generateCommitMessage`), also a button in Source Control
- **Local Full AI: Fix Selected Terminal Error** (`localAI.fixTerminalError`), also in the terminal's context menu
- **Local Full AI: Turn Code Completion On/Off** (`localAI.toggleAutocomplete`), also in the status bar
- **Local Full AI: Copy Diagnostics for a Bug Report** (`localAI.copyDiagnostics`): versions, settings and recent errors, with keys, chats and file contents left out

## Privacy and network

- With a local model, chats, files and skills are processed by your local Ollama and nothing is sent to any AI service.
- Only if you connect a cloud provider **and** select one of its models, your messages and the files the AI reads are sent
  to that provider. Free tiers of some providers may use prompts to improve their products. Do not use cloud models for
  private or sensitive code.
- Ollama Cloud models (names ending in `cloud`) run on ollama.com: they get the same notice as other cloud models.
- Picture generation sends the picture description to the backend you chose; Stable Diffusion WebUI on this computer keeps
  it local. Code completion and meaning search only use your local Ollama.
- MCP servers run with your permissions. Servers from a project's `.mcp.json` start only in a trusted folder and only after
  you allow them; tools that are not marked read-only ask before every call.
- `web_fetch` reads only public addresses (never your local network) and asks before every page.
- Otherwise the extension talks to the network only to: download models (Ollama), load the list of quantization variants
  from `ollama.com`, refresh the recommended model lists from the project's GitHub repository, and, if you set up voice
  input, download a speech model from Hugging Face.
- Chat history is stored in the extension's storage folder on your computer (one file per chat). Delete a chat from the
  chat list to remove it.
- Commands the AI runs are executed in your project folder and always need your approval, except in Autopilot, where
  the blocklist applies. Use a folder under version control for Autopilot.

## Platform notes

| | macOS | Linux | Windows |
|---|---|---|---|
| Chat, models, project tools | yes | yes | yes |
| Automatic Ollama install | Homebrew | install script | use the official installer |
| Voice input | yes | `arecord` / `sox` / `ffmpeg` | with `ffmpeg` (untested; Groq engine recommended) |
| Keep-awake during Autopilot | yes | no | no |
| Hardware fit | Apple Silicon, CPU | NVIDIA, CPU | NVIDIA, CPU |

## Known limitations

- Quality depends on the model. Small local models can misunderstand tasks or fail to fix bugs; the chat says
  *"No file was changed"* when a reply did not change anything. For real debugging use a larger model.
- The fit estimate is approximate and the context memory is a rough guess.
- Autopilot stops if VS Code is closed; it does not resume after a restart.
- Windows and Linux are much less tested than macOS.
- By default the reviewer agent is the same model as the chat, and a weak model can miss its own mistakes: pick a stronger
  one in Settings > Reviewer model. Without one, very small models (4B and below) only get the quick checks and do not
  start helper agents.
- Ollama's own picture generation is not used yet: it has no documented API so far (macOS CLI only).
- Voice transcription quality depends on the whisper model and your microphone.

## Troubleshooting

- **"Ollama is installed but not running"**: press **Start Ollama** in the sidebar, or run `ollama serve`.
- **The AI only answers in text**: project access may be off (folder button in the chat header) or the folder is
  untrusted. Pick a model with the `tools` tag for the best results.
- **Microphone does nothing**: allow the microphone for VS Code in your system settings, and install `ffmpeg` or `sox`.
- **A model is too slow**: choose a smaller model or a lower quantization (the sliders button on the model card), or lower the context length.

## License

MIT
