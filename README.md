# Local Full AI

A private AI coding assistant that runs **entirely on your computer**, powered by [Ollama](https://ollama.com).
Chat about your code, let it create and edit files in your project (with your approval), run on autopilot,
split big jobs between helper agents, talk to it with your voice, and manage your models,
all inside VS Code. No account, no API key, no subscription, and your code stays on your machine.

## Highlights

**Works on your project**
- Reads, searches, creates and edits files in the open folder and shows the work as steps
  (*Creating index.html*, *Updating script.js*) with an expandable diff, **Open file** and **Open diff**.
- Every edit and command asks first (*Allow* / *Allow in this chat* / *Deny*, or type what to do instead).
  Modes: **Ask before edits**, **Edit automatically**, **Read only**, **Autopilot**.
- The chat is for talking and corrections: code goes into files, not into the conversation.
  Ask for a change later and it continues from the current file on disk, including your own edits.
- **Autopilot**: give a task and walk away. It plans, works, checks the project, retries, and stops only when
  everything on its checklist is done. Dangerous commands (`sudo`, `git push`, destructive deletes) are blocked.
- **Helper agents**: the main chat can start research and worker agents in parallel. Research helpers can run
  on a small fast model. A badge shows how many agents ran and the tokens used.
- It can **ask you** a clarifying question in a small dialog above the input.

**Safe by design**
- **Folder access levels** per folder: Full, Ask first, Read only, No access (hidden). Add extra folders, pick the
  working folder. The file tools never read or write outside the folders you allow. Commands run in the working
  folder and always need your approval (Autopilot uses a blocklist instead).
- Respects VS Code **Workspace Trust**: in Restricted Mode the AI can only chat.
- When VS Code closes, everything the extension started is stopped (an Ollama installed as a system service keeps
  running, but its models are unloaded from memory).

**Models made easy**
- Guided Ollama setup, a hand-picked catalog (Code, General, Vision), cancel a download any time.
- **Pick the quantization** from the live Ollama list with exact sizes and context length.
- **Fit for your computer**: Apple Silicon, NVIDIA or CPU is detected; every model and quantization is marked
  *fits well / tight / slow / too heavy*, with a recommended pick.
- Response mode like LM Studio: Precise / Balanced / Creative / Custom, context length (4K to 128K), GPU or CPU.
- Switching the model is announced in the chat.

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
| `localAI.responseMode` | precise | How the model answers. Precise (low temperature) is the most reliable for code and tool use. |
| `localAI.temperature` | 0.2 | Randomness for the Custom response mode. |
| `localAI.topP` | 0.9 | Nucleus sampling for the Custom response mode. |
| `localAI.topK` | 40 | Top-K sampling for the Custom response mode. |
| `localAI.repeatPenalty` | 1.05 | Repeat penalty for the Custom response mode. |
| `localAI.gpuLayers` | -1 | How many model layers run on the GPU. -1 = automatic, 0 = CPU only. |
| `localAI.folderAccess` | [] | Folders the AI may use and how far it may go in each. The deepest matching folder wins. Project folders default to full. |
| `localAI.workingFolder` | (empty) | Folder the AI works from (relative paths and commands). Empty means the open project folder. |
| `localAI.unloadModelsOnClose` | on | When VS Code closes, unload the models from RAM if Ollama was started by something other than this extension. A server started by this extension is stopped completely. |
| `localAI.autoSkills` | on | Pick the skills that match each request and give them to the model directly, so skills work with every model (no tool calling needed). |
| `localAI.multiAgent` | on | Let the main chat start helper agents (delegate_task) for research and sub-tasks. |
| `localAI.subagentModel` | (empty) | Model for research helper agents. Empty = same as the chat, "auto" = the smallest installed model, or an exact model name. A small model is fast for simple reading tasks; helpers that edit files always use the chat model. |
| `localAI.voiceLanguage` | auto | Language for voice input (whisper language code such as en, uk, ru) or auto to detect. |
| `localAI.whisperBinaryPath` | (empty) | Path to whisper-cli (whisper.cpp). Empty means search PATH and Homebrew. |
| `localAI.whisperModelPath` | (empty) | Path to a whisper.cpp ggml model. Empty means ~/.local-full-ai/whisper/ggml-base.bin. |
| `localAI.contextSize` | 16384 | Context window (tokens) requested from Ollama. Larger values remember more of the project but use more RAM. |

## Commands

- **Local Full AI: Select / Download Model** (`localAI.selectModel`)
- **Local Full AI: Open Chat** (`localAI.openChat`)
- **Local Full AI: Ask About Selected Code** (`localAI.askAboutSelection`)

## Privacy and network

- Chats, files and skills are processed by your local Ollama. Nothing is sent to any AI service.
- The extension talks to the network only to: download models (Ollama), load the list of quantization variants
  from `ollama.com`, and, if you set up voice input, download a speech model from Hugging Face.
- Chat history is stored in VS Code's local storage on your computer. Delete a chat from the chat list to remove it.
- Commands the AI runs are executed in your project folder and always need your approval, except in Autopilot, where
  the blocklist applies. Use a folder under version control for Autopilot.

## Platform notes

| | macOS | Linux | Windows |
|---|---|---|---|
| Chat, models, project tools | yes | yes | yes |
| Automatic Ollama install | Homebrew | install script | use the official installer |
| Voice input | yes | `arecord` / `sox` / `ffmpeg` | not yet |
| Keep-awake during Autopilot | yes | no | no |
| Hardware fit | Apple Silicon, CPU | NVIDIA, CPU | NVIDIA, CPU |

## Known limitations

- Quality depends on the model. Small local models can misunderstand tasks or fail to fix bugs; the chat says
  *"No file was changed"* when a reply did not change anything. For real debugging use a larger model.
- The fit estimate is approximate and the context memory is a rough guess.
- Autopilot stops if VS Code is closed; it does not resume after a restart.
- Voice transcription quality depends on the whisper model and your microphone.

## Troubleshooting

- **"Ollama is installed but not running"**: press **Start Ollama** in the sidebar, or run `ollama serve`.
- **The AI only answers in text**: project access may be off (folder button in the chat header) or the folder is
  untrusted. Pick a model with the `tools` tag for the best results.
- **Microphone does nothing**: allow the microphone for VS Code in your system settings, and install `ffmpeg` or `sox`.
- **A model is too slow**: choose a smaller model or a lower quantization (the sliders button on the model card), or lower the context length.

## License

MIT
