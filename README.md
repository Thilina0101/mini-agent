# mini-agent

A small AI coding agent that runs in your terminal, powered by Claude (Claude Opus 5.5).
Tell it what you want in plain words. It explores your project, edits files, and runs commands to check its work.
**Every file change and command needs your OK first.**

```
> add a "Clear all" button to the sales page
⚙ search
  searched /Sales/ in . → 4 match(es)
⚙ read_file
  read index.html (lines 1-640 of 640)
⚙ edit_file
  Edit index.html
  - <button class="btn secondary" id="todayBtn">Today</button>
  + <button class="btn secondary" id="todayBtn">Today</button>
  + <button class="btn danger" id="clearAllBtn">Clear all</button>
  Allow? [y]es / [n]o / [a]lways allow file changes this session / or type feedback:
```

## Setup (one time)

1. **Get a Claude API key** at https://platform.claude.com → *API Keys* → *Create Key*.
   You pay for what you use (see "Cost" below).
2. Create a file named **`.env`** in this folder (`C:\Users\Dell\mini-agent\.env`) containing:
   ```
   ANTHROPIC_API_KEY=sk-ant-...your key...
   ```
   Never share this file or put it on GitHub. `.gitignore` already keeps it out of git.
3. Dependencies are already installed. If you move the folder, run `npm install` inside it.

## Use it

Run it from a terminal, pointing it at the project you want to work on:

```powershell
node C:\Users\Dell\mini-agent\agent.mjs C:\Users\Dell\restaurant-pos
```

Or `cd` into a project folder and run `node C:\Users\Dell\mini-agent\agent.mjs`.

**Shortcut (optional):** run `npm link` once inside `C:\Users\Dell\mini-agent`. After that you can type `mini-agent` in any folder.

| You type | What happens |
|---|---|
| Any request | Claude works on it, using the tools below |
| `y` / Enter | Approve this change or command |
| `n` | Decline it (Claude will ask how you want to proceed) |
| `a` | Approve this kind of action for the rest of the session |
| any other text | Decline and tell Claude what to do instead |
| `Ctrl+C` | Stop Claude mid-answer (press again at the prompt to quit) |
| `/clear` | Start a fresh conversation |
| `/exit` | Quit |

## What Claude can do

| Tool | Needs approval? |
|---|---|
| `list_files`: see the folder structure | No |
| `read_file`: read a file | No |
| `search`: find text in files (regex) | No |
| `write_file`: create or replace a file | **Yes** (shows a preview) |
| `edit_file`: change part of a file | **Yes** (shows the before/after) |
| `run_command`: run a command (PowerShell on Windows) | **Yes** |

Claude can only touch files **inside the project folder** you started it in. Paths outside it are refused.

**Project notes:** put an `AGENT.md` (or `CLAUDE.md`) in your project with things Claude should always know
(e.g. "Never change Code.gs without telling me to redeploy"). It's read at startup.

## Settings (in `.env`)

```
AGENT_MODEL=claude-opus-5-5   # default; e.g. claude-sonnet-5-5 is cheaper
AGENT_EFFORT=high             # low | medium | high | xhigh | max
```

Lower effort is faster and cheaper; higher effort thinks harder on difficult tasks.

## Cost

Each answer prints its token use and a running estimate, e.g. `session ≈ $0.042`.
Claude Opus 5.5 costs about $4 per million input tokens and $20 per million output tokens.
Prompt caching is on, so the repeated parts of a long conversation cost about 95% less.
A typical small task costs a few cents. Long sessions on big projects cost more, so use `/clear` between unrelated tasks.

## How it works (for the curious)

- `agent.mjs` streams responses from the Claude Messages API (`@anthropic-ai/sdk`) and runs a tool-use loop:
  Claude asks for a tool → the agent runs it (after your approval) → sends back the result → repeat until Claude is done.
- Thinking is adaptive (Claude decides how much to think) and its summary is shown dimmed (💭).
- Tool inputs stream as they're written (`eager_input_streaming`), and every input is validated before it runs.
- If Claude's safety system declines a request, it automatically retries on a fallback model (`fallbacks: "default"`).
- The conversation is only ever appended to, never edited, which keeps prompt caching working.
