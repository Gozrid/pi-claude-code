# pi-claude-code

Extensions for [pi](https://pi.dev) in one package:

- **claude-code** – uses the **Claude Code CLI** as a model provider, with your Claude subscription, even with several accounts at once. Only the connection: what the CLI does is shown by the extensions below
- **antigravity** – uses the **Antigravity CLI** (`agy`) as a model provider: Gemini, Claude and the other models of your Antigravity account. Only the connection, like **claude-code**
- **agent-status-line** – status line below the editor for the CLI providers: mode (switched with Shift+Tab), model, effort, context and usage limits
- **usage-graph** – `/usage` charts the plan usage limits of every connected account (all Claude CLI and Antigravity instances) and the tokens of every model over time
- **task-list** – the task list a CLI agent keeps, above the editor while it works on it
- **subagents** – the subagents a CLI agent runs, above the editor while they work; a click or `/subagents` opens a popup with every subagent of the session in a box and the selected one's output live
- **pi-bridge** – pi's own MCP server for the CLI agents: Claude and agy ask pi before what their mode does not allow and wait for your answer, the agents ask you questions in a dialog with options and a field for your own answer, hand wishes to change pi over to you and keep a wish list (its open wishes stand at the bottom right of the empty chat; a click on them or `/wishes` opens a popup with the whole list and each wish in full), read pi's state and settings and change them after asking, and wait for things outside that take a while (a CI run, a deployment): pi runs the command itself, shows it above the editor and starts a new turn with the result when it ends (`/watches` stops one), and show a stepper above the editor for a job of several steps (build → install → start …) that they move on live as they work, and run a big task as a workflow: they plan it as a tree of parts you review and edit, then do it part by part in subagents while the progress stands above the editor (`/workflow` opens the tree); pi's MCP servers reach the agents through pi's own connections instead of being started twice
- **permission-retry** – when a CLI agent was not allowed to do something, asks how to allow it and retries
- **provider-logo** – shows the logo of the selected model's provider in the middle of the empty chat
- **chat-crab** – a tiny Clawd (Gravi for Antigravity) above the editor that acts out what the agent is doing
- **chat-view** – changes to the chat itself, for every model: keeps the user's message pinned at the top while the answer and thinking scroll below it, shows the keys for steering and queueing (including steer now) with the waiting messages while the agent works, groups thinking and tool calls so the answer stands apart, shows tool calls readably – the CLI agents' and the MCP tools of pi's own models (highlighted code, diffs, tables, file contents with line numbers, images, errors in red, long output collapsed until Ctrl+O), draws code blocks without the ``` fences, turns Mermaid flowcharts too wide for the chat and asks the model to redraw what still does not fit, lists the loaded extensions in the empty chat, opens the session's earlier prompts as a list with ↑, shows the suggestions for /commands and files in a frame above the editor, marks shell commands in the editor (`!` purple borders, `!!` grey text, a hint where the output goes), after a long round shows the answer in a scrollable box above the editor, and lets the editor grow and shrink smoothly
- **image-paste** – attaches the images you paste (Ctrl+V), drag in or name by path in a prompt, so the model sees them directly
- **work-status** – for every model: an animation in Claude Code style while a CLI provider works, a "✻ Cooked for 1m 12s" line after each answer, a working star in the terminal tab title, a macOS notification for long answers and a session title (and so tab name) written by the provider's smallest model
- **commands** – general, useful commands for every model: `/clear`, `/effort`, `/export`
- **ide** – connects pi to a JetBrains IDE (IntelliJ IDEA, WebStorm, Android Studio, …) or VS Code through their Claude Code plugin: the selection or open file stands above the editor and goes with the next message, Alt+K (or Cmd+Alt+K in the IDE) inserts a reference like `@src/foo.ts#L12-30`, a running IDE without the plugin gets a hint, and the way back: file references in the chat open in the IDE with a click, `/ide open` opens a file at a line, `/ide diff` shows a change in the IDE's diff viewer

Each one can be switched on and off on its own with `pi config`.

## Requirements

- pi ≥ 1.4
- Claude Code CLI (`claude`) – the wizard takes care of signing in the accounts
- macOS or Linux (instances are started through `/bin/sh`)

## Installation

```bash
# from GitHub (private repo: git needs access, e.g. via gh/SSH)
pi install git:github.com/Gozrid/pi-claude-code

# or locally from a checkout – pi then loads straight from this folder
pi install ~/Projekte/Privat/pi-claude-code
```

**Free up Shift+Tab:** by default pi uses Shift+Tab to cycle the thinking level, and extensions may not override that key. Move the thinking level to another key in `~/.pi/agent/keybindings.json`:

```json
{
  "$schema": "https://pi.dev/schemas/keybindings.schema.json",
  "app.thinking.cycle": "alt+t"
}
```

(Option+T needs "Use Option as Meta key" in the terminal.) Then `/reload` in pi.

**Working indicator in the terminal tab:** like Claude Code, pi can show a running progress animation in the tab of macOS Terminal (and other terminals with OSC 9;4) while it works. This is a pi setting, off by default:

```json
{ "terminal": { "showTerminalProgress": true } }
```

**Shift+Enter in macOS Terminal:** Terminal.app sends Shift+Enter as ESC + Return, the same as Option+Enter, which pi binds to queueing a follow-up message. So Shift+Enter sends instead of starting a new line. Moving the follow-up to another key frees it for the editor's new line:

```json
{ "app.message.followUp": "alt+q" }
```

### Own settings on a new machine

`settings/` keeps my pi setup, so a new machine gets the same one:

| File | Goes to `~/.pi/agent/` as |
|---|---|
| `keybindings.json` | link: thinking level on Option+T, follow-up on Option+Q (see above) |
| `claude-code.json` | link: the Claude instances (accounts are signed in on first use or with `/login`) |
| `extensions/footer-without-model.ts` | link: footer without model, cwd and token line |
| `settings.json` | merged into the existing one, plus this checkout as package |

```bash
git clone https://github.com/Gozrid/pi-claude-code.git ~/Projekte/Privat/pi-claude-code
~/Projekte/Privat/pi-claude-code/settings/install.sh
```

Files that would be replaced are kept as `<name>.bak`. Because of the links, changes to keybindings and instances show up in the repo to commit. Sign-ins (`auth.json`), sessions and caches stay on the machine.

## claude-code

Every prompt starts `claude -p` (stream-json), or goes into the one still running for Claude's background tasks. Claude Code works with its own tools, settings and `CLAUDE.md`; pi shows text, thinking and tool calls live. One pi session corresponds to one Claude Code session, continued with `--resume`.

### Features

- **Several Claude instances** (e.g. Work + Personal), each its own provider in `/model`
- **Wizard with browser sign-in**: add and sign in new accounts with `/claude-add` or `/login` – including their own config folder
- **Models straight from the CLI**: list, aliases (`opus` → `claude-opus-5-5`) and pinned versions; after a `claude update` new models show up on their own
- **Effort per model**: pi's thinking level (and `/effort` from **commands**) offers only the levels the CLI says the model supports (→ `--effort`)
- **Visible thinking** (summary via `--thinking-display summarized`)
- **Permission modes** `auto` → `acceptEdits` → `plan` (Shift+Tab in **agent-status-line**), plus `dontAsk`, `bypassPermissions` and `manual` with `/claude-mode`
- **Publishes what the CLI does** for the other extensions: status and usage limits (**agent-status-line**), the running tool and tokens (**work-status**'s animation, **chat-crab**), the task list (**task-list**), the session's subagents with their output, read from the transcripts Claude Code writes for them (**subagents**), denied actions (**permission-retry**)
- **Readable tool calls**: each call and result goes into the chat as a block with a short header (tool and what it works on, MCP tools as `Server › tool`) and the details below – commands and code highlighted, edits as diffs, files read with line numbers, JSON indented, lists of objects as tables, images of the result (e.g. FreeCAD's `get_view`) saved in the session's temp folder and shown inline. Only for the chat: Claude gets its tool results unchanged. **chat-view** shows them collapsed (see [Tool calls](#tool-calls))
- **Steering mid-answer**: a steer (Enter while Claude works) goes into the running CLI at once and reaches Claude after its current step, not only when its whole answer is done. Claude's answer ends where it takes the steer up, the steer follows as your message, and the answer to it reads on in the same CLI run (`--replay-user-messages` tells when). Commands (`/…`) still wait for the end of the answer.
- **Background tasks live on**: while Claude's background tasks run (commands with `run_in_background`, background subagents, monitors), its CLI stays after the answer and your next prompt goes into it instead of a new one (a model or mode change goes in as a control request). When a task ends, Claude goes on by itself: the chat shows `⏺ Background command "…" completed` and a turn with Claude's answer to it, without you writing. Once no task is left, the CLI ends. Escape stops Claude's current step the way Claude Code does (an `interrupt`, not a kill), so tools in flight end as cancelled and background tasks run on. If the CLI has to end anyway – another Claude instance, effort or allowed-once tools, `/claude-new` – the chat says which tasks were stopped (`⚠ Claude Code was ended; its background task was stopped: "…"`), and Claude learns it with the next prompt. Quitting pi or switching the session ends them without a note.
- **Code in the chat instead of files**: snippets come as code blocks; test scripts and throwaway files go to a temp folder per session, not into the project
- **Permission prompts in pi** with **pi-bridge**: what the mode does not allow, Claude asks pi about and waits (`--permission-prompt-tool`), instead of a denial and a retry
- **pi's MCP servers only**: started from pi, Claude gets the servers of pi's `mcp.json` and none of its own – not its `~/.claude.json` or project servers, plugins or claude.ai connectors (`--strict-mcp-config`). `claude` started on its own keeps its servers. With **pi-bridge** they run through pi's own connections, so no server starts twice and tools pi hides stay hidden. See [MCP servers](#mcp-servers-for-the-cli-providers)

### Setting up instances

Without configuration there is one instance "Claude Code" (provider `claude-code`, command `claude`).

Add your own instances with the wizard – via **`/claude-add`** or via **`/login`** → *Sign in with an account* → *Claude CLI · add another account…*:

1. **Name**, e.g. `Work`
2. **Account**
   - an existing login: `claude` (default login in `~/.claude`) or any `~/.claude-*` folder found
   - **Sign in a new account…** – creates `~/.claude-<name>` and starts the browser sign-in
   - or a command of your own
3. **Test & confirm** – shows account, plan and number of models

The browser sign-in opens Claude's sign-in page. Usually the browser reports the sign-in back by itself; if it shows a code instead, paste it into the wizard. Esc cancels. If an existing login is not signed in, the wizard offers to sign it in as well.

**Sign in again** (e.g. expired login or another account for an instance): `/login` → *Sign in with an account* → *Claude CLI · \<instance\>*.

The first instance of your own replaces the built-in default. Each instance appears in `/model` as its own provider, e.g. `claude-work/opus`, `claude-personal/claude-opus-5-5`.

The command runs through `/bin/sh`: environment variables, `~`, `$HOME` and extra options work, **shell aliases do not** – enter the full command, e.g.

```
CLAUDE_CONFIG_DIR="$HOME/.claude-personal" claude
```

It is saved in `~/.pi/agent/claude-code.json`:

```json
{
  "instances": [
    { "id": "claude-work", "name": "Work", "command": "claude" },
    {
      "id": "claude-personal",
      "name": "Personal",
      "command": "CLAUDE_CONFIG_DIR=\"$HOME/.claude-personal\" claude",
      "contextWindow": 200000
    }
  ]
}
```

`contextWindow` (optional) sets the context window the status line shows for that instance. Claude Code reports 1M for every subscription; set it when your plan has a smaller one.

### Commands

| Command | Effect |
|---|---|
| `/claude-add` | wizard: add a new instance, with browser sign-in if wanted |
| `/login` → *Claude CLI · …* | add an account (wizard) or sign an instance in again |
| `/claude-setup` | show, rename, change the command of or remove instances |
| `/claude-setup add <name> = <command>` | add an instance without the wizard |
| `/claude-setup remove <name>` | remove an instance |
| `/claude-setup list` | list the instances |
| `/claude-mode [auto\|acceptEdits\|plan\|dontAsk\|bypassPermissions\|manual]` | set the permission mode |
| `Shift+Tab` | `auto` → `acceptEdits` → `plan` (other models: thinking level) |
| `/claude-usage` | usage limits of all instances in detail |
| `/claude-models` | reload the model lists from the CLIs |
| `/claude-scratch` | show the temp folder of the current session |
| `/claude-new` | the next prompt starts a new Claude Code session |

### Environment variables

| Variable | Meaning |
|---|---|
| `PI_CLAUDE_BIN` | command of the built-in default instance (default: `claude`) |
| `PI_CLAUDE_PERMISSION_MODE` | permission mode at start (default: `auto`) |
| `PI_CLAUDE_EXTRA_ARGS` | extra CLI arguments, separated by whitespace |
| `PI_CLAUDE_THINKING_DISPLAY` | `summarized` (default) or `omitted` |
| `PI_CLAUDE_SCRATCH_DIR` | base folder of the temp folders (default: system temp) |
| `PI_CLAUDE_NO_BROWSER` | don't open a browser when signing in, only show the link (e.g. over SSH) |
| `PI_CLAUDE_TASKS` | `0` leaves Claude's task tools off (no task list above the editor) |
| `PI_CLI_OWN_MCP` | `1` lets Claude (and agy) use their own MCP servers instead of pi's |

### Files at runtime

| File | Contents |
|---|---|
| `~/.pi/agent/claude-code.json` | your instances |
| `~/.pi/agent/claude-code-models.json` | cache of the model lists per instance |
| `~/.pi/agent/claude-code-sessions.json` | mapping pi session → Claude Code session |
| `~/.claude-<name>/` | config folders of new accounts (created by the wizard; the CLI manages the sign-in data) |
| `$TMPDIR/pi-claude-code/<session>/` | temp folder Claude may write to freely |

### Limitations

- **Permission prompts** can't be answered from pi (`--permission-prompts none`): whatever would ask is denied and reported at the end. Switch the mode with Shift+Tab or `/claude-mode`.
- **pi's tools** (read, bash, edit) are not used – Claude Code works with its own. pi's MCP servers it connects itself (see [MCP servers](#mcp-servers-for-the-cli-providers)).
- **Undocumented CLI interfaces**: `get_usage` (usage limits), `--thinking-display` and the sign-in control requests (`claude_authenticate` …) are internal or SDK internals. If a CLI version drops them, usage details or the thinking text are missing; at start-up the extension checks whether the CLI knows `--thinking-display`.
- **Context window** is reported to pi as 1M so pi doesn't summarise on its own – Claude Code compacts by itself.
- **Costs** in pi are the CLI's `total_cost_usd` (API prices), not what a subscription actually costs.

## antigravity

Every prompt starts `agy -p` (stream-json). agy works with its own tools, sign-in, `GEMINI.md`/`AGENTS.md` rules and settings (`~/.gemini/antigravity-cli/settings.json`); pi shows text and tool calls live. One pi session corresponds to one agy conversation, continued with `--conversation`.

Sign in once in agy itself (`agy`, then follow its sign-in), then pick a model with `/model` → `antigravity/…`.

### Instances (several accounts)

Like the Claude instances, each agy instance is a base command and becomes a provider of its own (`antigravity`, `antigravity-work`, …). Add one with **`/agy-add`** or via **`/login`** → *Sign in with an account* → *Antigravity CLI · add another account…*:

1. **Name**, e.g. `Work`
2. **Account** – agy keeps one Google sign-in per user, so other accounts go through its environment:
   - `agy` – the Google account agy is signed in to
   - `AGY_ADC_AUTH=1 agy` – Application Default Credentials of `gcloud` (Google Cloud project)
   - **own command**, e.g. `GEMINI_API_KEY="$(cat ~/.gemini-key)" agy`
3. **Test** (`agy models`) and **save**

agy signs in only in its own UI. If the test fails, run the command in a terminal, sign in there and quit it again; then `/login` → *Antigravity CLI · \<instance\>* checks it and loads its models. Without instances there is one, `antigravity`, running `agy`; the first instance you add replaces it.

### Features

- **Models straight from the CLI** (`agy models`): agy lists each effort as a model of its own (`gemini-4-argon-low`, `-medium`, `-high`); pi gets one model per family and its thinking level (Option+T, `/effort`) picks the variant
- **Modes** like in agy: `default` (asks – in print mode: denies – before writes, commands, web and MCP), `accept-edits` (workspace edits go through), `plan`, plus `auto` (Preview, not for every account) and `bypass` (`--dangerously-skip-permissions`) with `/agy-mode`. Shift+Tab in **agent-status-line** cycles `default` → `accept-edits` → `plan`. The start mode is agy's own `agentMode` setting
- **Background commands**: agy keeps its turn open until the commands it started in the background are done, then goes on by itself, so they survive your messages (pi holds those until the turn ends). agy has no interrupt, so Escape stops it with a signal; if steps were still running – e.g. a CI watch agy waited for – the chat says which (`⚠ Antigravity was stopped; this step was still running and ended: "…"`), and agy learns it with the next prompt
- **Thinking blocks**: agy's `stream-json` output carries only thinking token counts, so the extension reads the full thinking text of each finished step from agy's conversation transcript (`~/.gemini/antigravity-cli/brain/<conversation>/.system_generated/logs/transcript_full.jsonl`) and shows it in **chat-view** (`✻ Thinking`) like Claude Code
- **Tool calls** under the names the other extensions know (`run_command` → Bash, `write_file` → Write, `replace_file_content` → Edit, `grep_search` → Grep, …), and **diffs** of the files agy edits; calls and results as readable blocks like **claude-code**'s (see [Tool calls](#tool-calls))
- **Plan usage limits** (`agy -p /usage --output-format json`): 5-hour session and weekly quota meters for the selected model's quota group in **agent-status-line**, plus `/agy-usage` for all quota groups across every instance
- **Permission prompts in pi** with **pi-bridge** (modes `default` and `accept-edits`): before commands, writes and reads outside the workspace, agy waits for your answer in pi. See [pi-bridge](#pi-bridge)
- **Denied actions** go to **permission-retry**: agy stops its turn at the first action it may not take
- **Code in the chat instead of files**: as for claude-code, with a temp folder per session that agy may write to
- **pi's MCP servers only**: started from pi, agy gets the servers of pi's `mcp.json` instead of its own `~/.gemini/config/mcp_config.json`. `agy` started on its own keeps its servers. With **pi-bridge** they run through pi's own connections, so no server starts twice and tools pi hides stay hidden. See [MCP servers](#mcp-servers-for-the-cli-providers)

### Commands

| Command | Effect |
|---|---|
| `/agy-add` | wizard: add an instance |
| `/agy-setup [list \| add <name> = <command> \| remove <name>]` | manage instances (no arguments: interactive) |
| `/login` → *Antigravity CLI · …* | add an instance (wizard) or check one |
| `/agy-mode [default\|accept-edits\|plan\|auto\|bypass]` | set the mode |
| `/agy-usage` | show plan usage limits (5-hour and weekly buckets per model group) for every instance |
| `/agy-models` | reload the model lists from every agy instance |
| `/agy-new` | the next prompt starts a new agy conversation |
| `/agy-scratch` | show the temp folder of the current session |

### Configuration and environment

`~/.pi/agent/antigravity.json` (optional, written by the wizard):

```json
{ "instances": [{ "id": "antigravity-work", "name": "Work", "command": "AGY_ADC_AUTH=1 agy", "contextWindow": 1000000 }] }
```

`contextWindow` gives the status line a window to measure the context against; agy reports none, so without it the status line shows only the tokens. The older form `{ "command": "agy", "contextWindow": … }` still sets the default instance.

| Variable | Meaning |
|---|---|
| `PI_AGY_BIN` | command of the default instance (default: `agy`) |
| `PI_AGY_MODE` | mode at start (default: agy's `agentMode`, else `default`) |
| `PI_AGY_EXTRA_ARGS` | extra CLI arguments, separated by whitespace |
| `PI_AGY_SCRATCH_DIR` | base folder of the temp folders (default: system temp) |
| `PI_AGY_GEMINI_DIR` | agy's folder the MCP mirror links to (default: `~/.gemini`) |
| `PI_CLI_OWN_MCP` | `1` lets agy (and Claude) use their own MCP servers instead of pi's |

| File | Contents |
|---|---|
| `~/.pi/agent/antigravity.json` | the instances |
| `~/.pi/agent/antigravity-models.json` | cache of the model lists, per instance |
| `~/.pi/agent/antigravity-sessions.json` | mapping pi session → agy conversation, per instance |
| `$TMPDIR/pi-antigravity/<session>/` | temp folder agy may write to |

### Limitations

- **Thinking text per completed step**: agy does not stream thinking deltas token-by-token on stdout; each step's thinking text appears as soon as agy finishes that step and writes its local transcript log.
- **Images as files**: agy's print mode takes text only, so images in a prompt are written into the session's temp folder and the prompt names the file; agy opens it with its own tools.
- **No sign-in from pi**: agy signs in only in its own UI; pi registers the command and checks it. One Google sign-in per user – further accounts need ADC, an API key or an own command.
- **No extra system prompt**: agy has no flag for one, so pi's chat instructions go in front of the first message of each conversation.
- **pi's tools** are not used – agy works with its own.
- **Subagents** are read from agy's records and transcripts, whose format agy does not document; a new agy version may change it. agy cancels the subagents still running when its run ends, so in pi a subagent only finishes when the agent waits for it.

## MCP servers for the CLI providers

The Claude Code CLI and agy each have MCP servers of their own. Started from pi (**claude-code**, **antigravity**), they get **pi's MCP servers and only those**; started on their own (`claude`, `agy`), they keep theirs.

pi's servers are the ones in `~/.pi/agent/mcp.json` and, in a trusted project, `<project>/.pi/mcp.json` – added with `pi mcp add` or by hand (see pi's MCP docs). They are read the way pi reads them: a project entry replaces the global one of the same name or, without `command`/`url`, only switches it on or off; `enabled: false` leaves a server out, as does `exposure: "hidden"` unless `toolExposure` shows some of its tools; `${VAR}` and `!command` in `env` and `headers` are resolved, `~/` and `cwd` too. The file with the result (credentials included) lies in `$TMPDIR/pi-mcp/`, readable by the user only, and is read again for every prompt, so changes to `mcp.json` count from the next one on.

- **Claude**: `--strict-mcp-config --mcp-config <file>` – no servers from `~/.claude.json`, `.mcp.json`, plugins or claude.ai connectors. One-off questions (session titles) run without any servers, as before
- **agy** has no flag for another server list, only the hidden `--gemini_dir` for its whole folder. So it gets a mirror of `~/.gemini` in `$TMPDIR/pi-mcp/gemini-<hash>/`: every entry a link to the real one (sign-in, conversations, settings stay shared), except `config/mcp_config.json`, which lists pi's servers. An instance whose command sets its own `--gemini_dir` keeps its servers
- Without a `mcp.json`, the CLIs run without MCP servers

**Through pi's connections (with pi-bridge on)**: pi connects its servers itself anyway. So the CLIs do not start them a second time: each server is an HTTP entry `http://127.0.0.1:<port>/mcp/<server>` of **pi-bridge**, and every call runs through pi's own connection – one `dart mcp-server`, one device connection. The CLI sees exactly the tools pi's `exposure` and `toolExposure` leave reachable (`"*cloud*": "hidden"` hides them from Claude and agy too), the server's results unchanged (images included), and OAuth servers work with pi's sign-in. The first look at a server waits up to 10 s for pi to connect it. This needs pi's built-in MCP support (not with `--no-mcp` or another MCP extension) – otherwise the CLIs start the servers themselves as below.

**Started by the CLI (pi-bridge off)**: the CLIs start the servers from the entries above. Tools pi hides are left out once pi has connected the server – Claude with `--disallowedTools mcp__<server>__<tool>`, agy with `disabledTools` in its `mcp_config.json`. HTTP servers with OAuth sign in on the CLI's side, `auth` with a pi provider is not passed on, and pi's own connection to the servers goes unused.

`PI_CLI_OWN_MCP=1` lets both CLIs use their own servers again.

With **pi-bridge** on, both CLIs also get pi's own server `pi` (with `PI_CLI_OWN_MCP=1` only Claude, on top of its own servers).

## pi-bridge

An MCP server inside pi for the CLI agents it starts. It listens on `127.0.0.1` only, on a free port, and every CLI gets a token of its own; the provider extensions ask for it over the channel `pi-bridge:server` before they start their CLI. Claude sees the tools as `mcp__pi__<tool>`. pi's own models get the same tools as pi tools: `pi_ask` and `pi_change_request` directly, the others through tool search.

**No time limit on your answers**: the agents wait for a dialog (question, permission prompt, wish) as long as you take. Claude's own limit would end every MCP call after 60 seconds, so pi starts it with `MCP_TOOL_TIMEOUT` of 20 days (as good as none; a value of your own in the environment wins). For agy's permission hook pi sets 20 days as well. agy itself ends every MCP call after 3 minutes (no setting for it is known), so pi answers a dialog still open after 2½ minutes with "not answered yet, call again": the dialog stays open, and agy's next call waits on in the same dialog and gets your answer. From the moment such a dialog opens until you have answered, pi's hook holds every further action of that agy, in every mode (`bypass` included), so it cannot go on without you.

**Permission prompts (Claude)**: Claude runs with `--permission-prompts host --permission-prompt-tool mcp__pi__permission`. What its mode does not allow, it asks pi about and waits; pi shows the command or the diff:

```
Claude wants to run a command
  $ npm test
› ○ 1. Allow once  recommended
  ○ 2. Allow for this session      Rule Bash(npm test), until pi closes
  ○ 3. Always allow in this project  Adds Bash(npm test) to .claude/settings.local.json
  ○ 4. Always allow, all projects    Adds Bash(npm test) to Claude's user settings
  ○ 5. Deny                          → reason for the agent (optional)
  ✎ Own answer:                      → denied, the text goes to Claude
```

"All projects" writes to `settings.json` in the instance's config folder (`CLAUDE_CONFIG_DIR` of its command, else `~/.claude`). Without a user interface (pi in print or JSON mode) Claude denies as before and **permission-retry** offers the retry.

**Permission prompts (agy)**: agy in print mode denies what its mode does not allow, and a hook can block an action but not allow a denied one. So in modes `default` and `accept-edits` the order is reversed: the run gets broad allow rules (`command(*)`, `unsandboxed(*)`, `write_file(*)`, `read_file(*)` and pi's own tools, on top of the user's rules, via `--settings`), and a PreToolUse hook in the `--gemini_dir` mirror (`config/hooks.json`, next to the user's hooks) asks pi before:

- every command, unless one of the user's `command(…)` rules covers it (by prefix)
- every file write, except inside the workspace in `accept-edits`, unless a `write_file(…)` rule covers it
- file reads outside the workspace, unless a `read_file(…)` rule covers them

The dialog offers allow once, for this session, always (adds the exact rule, e.g. `command(npm test)`, to agy's settings) and deny with a reason. agy waits until you answer. The hook is `curl` to pi's server, with the token in a private file. When pi is not there, curl fails and agy blocks the action. URLs and other MCP servers keep agy's own rules, and their denials still go to **permission-retry**. In `plan`, `auto` and `bypass` the hook asks nothing and agy's mode decides; it only holds agy while one of pi's dialogs waits for you.

**Questions** (`ask`): one or more questions in one dialog; each with options (one marked recommended, each with a description), single or multiple choice, a field for an own answer, and an extra input field when the agent asks for one (`details` for the question, `input` for an option). ↑↓ choose, 1–9 pick, space toggles, enter confirms, tab/←→ switch questions, esc cancels. With the mouse (fullscreen mode): a click chooses an option (toggles it with multiple choice), a click on a tab switches the question, a click in the own answer or extra field puts the cursor there, the wheel moves through the options. The dialog never grows taller than the terminal: a long preview (a command, a diff – permission prompts show up to 500 lines) is wrapped and scrolls in a window with PgUp/PgDn, Shift+↑↓ or the wheel over it, so the options always stay in view.

**Wishes to change pi** (`change_request`): when you ask the agent to change pi itself ("make the CLI red"), it calls this instead of editing files, and you choose: apply now (when the wish is a setting), work on it here in this chat (the agent changes this package's folder, following its `CLAUDE.md`: checks, commit, push; then `/reload`; offered when the package is a git checkout), add to the wish list, work on it in a new pi session in this package's folder (the command goes to the clipboard), open a GitHub issue (`gh`), or nothing. Every wish comes with a title, a short title and the exact description.

**Wish list** (`~/.pi/agent/wishes.md`): Markdown, one section per wish, to read and edit by hand:

```markdown
## 1. Readable MCP tool calls in the chat
- Short: Readable MCP calls
- Status: open
- Added: 2026-11-01
- Project: /Users/me/cad

What exactly should change, as many paragraphs as needed.
```

The status is `open`, `in progress` or `done`; done wishes stay in the file with their date. While the chat is empty, the open wishes stand at the bottom right above the editor under the heading `Wishes ›` (in the accent colour, like a link) and above the hint `click or /wishes`, by short title (two or three words, at most 20 characters – `change_request` refuses longer ones, longer ones written by hand are cut – at most 6 wishes; those in progress first, marked `◐`). provider-logo draws them beside its logo; without it they stand right-aligned above the editor. They go away with the first message. The agent reads the list with `wishes` and sets a wish's status with `wish_update` – `in progress` when it starts working on it, `done` when it is finished; tell it e.g. "work on wish 3". The old list with one line per wish is still read and rewritten in the new form with the next change.

**Wish popup** (`/wishes`, `/wishes 3` for one wish, or a click on the wishes in the empty chat – on the heading or the hint for the first, on a wish for that one): the list on the left, a box per wish as wide as the subagent popup's (`○` open, `◐` in progress, `✓` done; the short title, the date it was added or done and the start of its description), the selected wish on the right in full: title, status, dates, the project it came from (a link to the folder) and the description as Markdown. It opens like `/usage`: the frame unfolds from the middle while the chat behind it darkens, then the title is typed and the rows appear. Tabs filter by status – Active (open and in progress, the default), Open, In progress, Done, All; a done wish opened directly shows under All. Keys: `↑`/`↓` (`j`/`k`) select, `PgUp`/`PgDn` (`Shift+↑`/`↓`) scroll the wish, `Tab`/`Shift+Tab` switch the filter, `/` searches title and description (all words; `Enter` keeps the search, `Esc` clears it), `s` cycles the status (open → in progress → done), `Enter` puts a prompt to work on the wish into the editor and closes the popup, `e` opens `wishes.md` in the default text editor, `c` copies the wish, `Esc`/`q` closes. With the mouse (pi's fullscreen mode): a click selects a wish or a tab, a double click works on it, the wheel moves through the list or scrolls the wish, depending on the column under it. The popup follows changes as they happen: statuses the agent sets with `wish_update` and edits to the file. On a narrow terminal it shows one column: the list, `Enter` opens the wish, `Esc` goes back.

**Waiting for things outside** (`watch`, `watches`, `watch_stop`): when the agent has to wait for something that takes a while – a GitHub Actions run, a deployment, a PR's checks – it hands pi a shell command that blocks until it is done, e.g. `gh run watch <id> --exit-status`, with a description and a time limit (default 30 minutes, at most 3 hours), and ends its turn. pi runs the command itself (`/bin/sh -c`, in the agent's working directory, in its own process group), so it does not depend on the agent's turn or its CLI process, whose background commands can end between turns. While it runs it stands above the editor (`⏳ Waiting for CI of PR #42 · 3m 12s · #1 · /watches to stop`); several can run at once. When the command ends, or is stopped at its time limit, pi sends the agent a message with the exit code and the last 40 lines of output, which starts a new turn (queued as a follow-up while the agent is busy). In the chat it shows as one line (`✓`, `✗` with the exit code, `⏱` time limit, `■` stopped), the output with Ctrl+O. `/watches` lists the running ones and stops the one you pick; a watch you stop is reported with your next message instead of starting a turn. Watches belong to the pi session: quitting pi, switching the session or `/reload` ends them without a report.

**Steps** (`steps_set`, `steps_update`, `steps_clear`): for a job of several steps that takes a while – e.g. putting an app on the phone: build the APK, check the device, install it, start it – the agent shows the steps as a stepper above the editor and moves each one on as it works (pending, running, done, failed, skipped, each with an optional note):

```
Install the app · Step 2 of 4
✓ Build APK ── ⠹ Check device ── ○ Install APK ── ○ Start app
  adb devices · 4s
```

Done steps get a green `✓`, the running one a spinner and its time, failed ones a red `✗` with their note, skipped ones `↷`, pending ones stay grey. When the row does not fit the width, the steps stand below each other. A finished list (`4 of 4 done`, or `Step 3 of 4 failed`) goes away by itself after 10 seconds; the agent can remove it earlier with `steps_clear`, you with `/steps`. A new `steps_set` replaces the list; it belongs to the pi session.

**Workflows** (`workflow_plan`, `workflow_next`, `workflow_update`, `workflow_status`): a big task planned as a tree – the whole task, big parts, and below each big part small parts, as deep as needed – where every small part is done by a subagent of its own. The agent plans one when you ask for it (`/workflow <task>` asks for you) or proposes one by itself when a task is big enough. The plan opens as a tree for your review, before anything runs:

```
╭─ Review the plan · Workflow #3 · Build a car model ───────────────────────────────╮
│ review · 0 of 7 done · subagents: default model · 3 at once                       │
│                                                                                   │
│ ▾ ○ 1 Wheels 0/2              │ 1.1 Screws                                        │
│   ○ 1.1 Screws                │ pending · model haiku                             │
│   ○ 1.2 Rubber                │ within 1 Wheels                                   │
│ ▾ ○ 2 Body 0/2                │                                                   │
│   ○ 2.1 Frame                 │ Task                                              │
│   ○ 2.2 Doors                 │ M6 screws for the four wheels                     │
╰─ a approve · f feedback · ↑↓ select · ←→ fold · e title · d task · n new · … ─────╯
```

There you edit titles (`e`) and tasks (`d`), add parts next to (`n`) or inside (`i`) the selected one, remove parts (`x`), choose the model of a part's subagents (`m`: default, haiku, sonnet, opus) or of all (`M`) and how many run at once (`+`/`-`), then approve (`a`) or send the plan back with what to change (`f`); the agent gets the plan with your edits. Ids are positions (`1.2` is the second part of the first part) and stay as they are when parts are added or removed. Parts can depend on others (`after 1`); a big part's dependencies hold for all its parts, everything else may run in parallel.

Once approved, pi hands the agent the small parts that can start (`workflow_next`, up to the number at once), the agent starts a subagent for each and reports how it ended with its summary and tokens (`workflow_update`). A part that fails is handed out once more; failing again, pi asks you: try again (with a hint for the next try), skip it, or pause the workflow – the other parts go on meanwhile. Above the editor stand the workflow's progress, its big parts and the small parts running:

```
◆ Workflow #3 Build a car model · 12 of 30 done · 3 running · 245.1k tokens · click for the tree
✓ 1 Wheels 5/5 ── ⠹ 2 Body 3/8 ── ○ 3 Windows 0/6
  ⠹ 2.4 Doors · ⠹ 2.5 Roof · ⠹ 2.6 Bonnet
```

A click on it, or `/workflow`, opens the tree with the selected part's task, model, tokens, time and result. While it runs you can pause and continue it (`p`), cancel a part (`c`, the agent is told to stop its subagents), start a part again (`r`), and edit, add and remove parts as in the review; the agent learns what you changed with its next call, and when it had already ended its turn (finished, paused, waiting for you), continuing or freeing parts again sends it a message that starts a turn. Every workflow is saved in `~/.pi/agent/workflows/<number>.json`: after pi starts again, the newest unfinished one of the folder shows paused, and continuing it (`p`) lets the agent go on (parts that were running are checked again). `/workflow <number>` opens an older one; `/workflow` without a current one lists them.

**Read**: `wishes`, `status` (version, model, thinking level, session, context, theme), `settings`, `themes`, `keybindings`, `commands`, `tools`, `mcp_servers` (headers and env values hidden), `docs` (list, search or read pi's documentation of the installed version).

**Change**, each after a confirmation: `set_theme`, `set_setting` (through pi's own settings manager), `set_keybinding`, `set_model`, `set_thinking_level`, `set_mode` (the CLI's mode, as Shift+Tab), `mcp_server_set` (add, replace or remove in `~/.pi/agent/mcp.json`). Without asking: `wish_update`, `rename_session`, `notify`, `watch`, `watch_stop`, `steps_set`, `steps_update`, `steps_clear`, `workflow_next`, `workflow_update`; `workflow_plan` waits for your review, `workflow_status` reads.

## agent-status-line

While a model of a CLI provider (a Claude CLI instance or Antigravity) is selected, shows below the editor the mode, the model (with the instance when there are several), effort, context, session and weekly limit and the time until the reset:

`⏵⏵ auto (shift+tab) │ Model: Opus 5.5 @ Work │ Effort: ●●●○○ high │ Session: ▓░░░░░░░░░ 8.0% │ Weekly: ▓▓▓░░░░░░░ 30.0% │ Reset: ⟳ 3hr 16m`

If the terminal is too narrow, the line wraps between segments onto further lines instead of being cut off.

**Shift+Tab** switches the CLI's mode like in Claude Code: `⏵⏵ auto` → `⏵⏵ accept edits` → `⏸ plan` (Antigravity: `⏵ default` → `⏵⏵ accept edits` → `⏸ plan`); the new mode is typed in with an animation and briefly lit up. For other models Shift+Tab cycles pi's thinking level, as pi itself does (see *Free up Shift+Tab* above).

With the mouse (pi's fullscreen mode), a click on the mode switches it like Shift+Tab, and a click on the effort opens `/effort` (when **commands** is on).

The data comes from the provider extensions over pi's event bus (channel `cli-agent:status`, see `extensions/shared/agent-bus.ts`); without them the line stays empty.

## usage-graph

`/usage` opens a dialog with two views. **Accounts** (the default) charts the plan usage of every connected account – all Claude CLI instances and all Antigravity instances, not just the selected one:

```
Claude · Work · read 2m ago
 100%┤
     │              ⡖⢲             ⢰⠒⡆
  50%┤       ⢀⣀⡏⠉⠁   ⢸       ⣀⣸⠉⠁    ⡇      ⢀⣀⣀⣀⣀⣀⡤⢤⣤⡯⠭⠤
     │⠤⠴⠒⡶⠾⠛⠓⠒⠒⠒⠒⠋⠉⠉⠉⢹⠉⠉⢩⠭⠏⠉         ⡇  ⡤⠼⠉⠁
   0%┤⣀⣰⠒⠃           ⢸⣀⡖⠚            ⣇⣰⠒⠃
     └────────────────────────────────────────────────────
      -24h                      -12h                   now
  ━━ 5h session  ▓▓▓▓▓▓▓░░░  72.0% · reset in 1hr 0m
  ━━ weekly      ▓▓▓▓▓░░░░░  48.8% · reset in 3d 0hr
```

One chart per account with a coloured line per limit (Claude: 5-hour session, week and per-model limits; Antigravity: the 5-hour and weekly bucket of every model group), below it the current value and the time until the reset. A value holds until the next reading and drops to 0 when its window resets. The dialog opens like the status line switches its mode: the frame unfolds from the middle of the screen while the chat behind it darkens, the title is typed into the top border behind a block cursor and a shine sweeps across it, and the rows appear from the top. Once open, the frame glides to a new size (a view with more or fewer rows, a resized terminal) instead of jumping. Then the graphs build up – and again whenever the range or the view changes – one part after another: the lines one by one, each drawn from left to right (half a second each, account after account), while its value in the legend counts up; the bars one by one from the left, each growing from the bottom. The whole build-up takes 0.7 to 3 seconds, depending on how many lines or bars there are. The dialog has a rounded frame with the keys in its bottom border; while it is open, the chat behind it is darkened to one faint shade, so the dialog stands out.

**Models** (switched to with Tab) shows the tokens of every model as bars on the timeline: one bar per time slot, stacked from a coloured segment per model (the busiest at the bottom), input and output per time slot (10 minutes at 5h, an hour at 24h, 6 hours at 7d, a day at 30d), without cache reads, which repeat the context on every call and would bury every other model. Below it each model's total in the range, split into input (with cache writes), output and cache reads, and the cost where the provider reports one. It counts every answer in pi, of every model – pi's own and the CLI providers' – and the same model through several accounts is one line. A model keeps its colour across ranges.

| Key | Effect |
|---|---|
| `Tab` | switch between Accounts and Models |
| `←` / `→` | time range: 5h, 24h, 7d, 30d |
| `↑` / `↓`, PgUp / PgDn | scroll when the accounts don't fit |
| mouse (fullscreen mode) | a click on a view or range tab picks it, the wheel scrolls, a click on `↑` / `↓ more` turns a page |
| `r` | read the usage of all accounts again |
| `Esc` / `q` | close |

The history starts when the extension is first loaded. The values come from the provider extensions over pi's event bus (channel `cli-agent:usage`, see `extensions/shared/agent-bus.ts`): whenever they read usage (at start, after answers, every 5 minutes for the selected account). On top of that, every 15 minutes while pi is idle and when `/usage` opens, usage-graph asks them (`cli-agent:usage-refresh`) to read every account. A value is written when it changes, otherwise at most every 30 minutes, to `~/.pi/agent/usage-history.jsonl`. The tokens of each answer go to `~/.pi/agent/usage-models.jsonl`. Samples older than 35 days are dropped from both.

Accounts without plan limits (API key sign-in) don't appear; neither do pi's own providers, which report no plan limits.

## task-list

Above the editor, the task list a CLI agent keeps with its own task tools (Claude Code's TaskCreate / TaskUpdate / TodoWrite):

```
Tasks 1/3 done
☒ Plan the change
◼ Writing the tests
☐ Update the README
```

It shows while the agent works on it and stays while tasks are open; a finished list goes away after the run. The tasks come over the channel `cli-agent:tasks`.

## subagents

Above the editor, the subagents a CLI agent runs right now, with their type, run time and the tool each one runs:

```
Subagents 2 running · click to watch
◐ Review PR 13  general-purpose · 1m 12s · Bash gh pr diff 13
◐ Find callers  Explore · 12s · Grep useSession
```

A click on it, or `/subagents`, opens a popup (like the wish popup): every subagent of the session in a box on the left (◐ running, ✓ done, ⊘ stopped), the selected one's prompt, thinking, text, tool calls and short results on the right. The output follows the newest step while it runs (`● live`), with `◐ working… · last step 42s ago` below it, since a CLI writes a step only once it is complete; scrolling up pauses it, End follows again. Tabs at the top filter by status, like the wish popup's: All (the default), Running, Done and Stopped, each with its count; Tab and Shift+Tab switch, a click picks one. Keys: ↑↓ select, PgUp/PgDn and Shift+↑↓ scroll, Home to the top, Esc closes; the mouse selects a box, switches tabs and scrolls each column. On a narrow terminal the boxes come first and Enter opens one.

The subagents come over the channel `cli-agent:subagents`. Neither CLI streams what a subagent does, so the providers read the transcripts the CLIs write and poll them every second:

- **Claude Code**: `<config dir>/projects/<project>/<session>/subagents/agent-<id>.jsonl` and `.meta.json` (description, type, finished) – background subagents too, also after the answer is over. A subagent that hands its report back with the `SubagentHandback` tool shows the report as its text. Claude's stream does not carry a subagent's tokens (not even with `--include-partial-messages`), so its output can only appear block by block.
- **Antigravity**: agy runs each subagent in a conversation of its own and keeps a record of it under the conversation that started it (`brain/<conversation>/.system_generated/subagents/<id>.json`: role and type); its steps come from that conversation's `transcript.jsonl`. It is done once its last model step ends its turn, stopped when agy reports it canceled (as it does for subagents still running when `agy -p` ends).

A subagent that never finished and did nothing for two minutes while its CLI is not running shows as stopped.

## permission-retry

A CLI agent in print mode cannot ask before an action its mode does not allow: the action is denied and listed at the end of the answer. Then this asks how to allow it and, after a choice, sends a retry:

```
Not allowed in mode auto: Bash npm test
› Allow Bash once and retry
  Not now
```

The provider offers the choices – Claude Code: allow the tools once, or switch to accept edits; Antigravity: switch to accept edits, always allow (adds the exact rule, e.g. `command(npm test)`, to agy's settings) or allow everything this once. The denied actions come over the channel `cli-agent:denials`.

## provider-logo

While the chat is empty, the extension replaces pi's header with the logo of the selected model's provider – centred in the terminal, with the model name and the most important commands below it. The logo grows with the terminal size (up to 3× in steps of 0.5 using half blocks; Clawd stays small). chat-view's extension list stands at the bottom left and pi-bridge's open wishes at the bottom right (a click opens the wish popup), beside the logo where they fit (where the two lists don't fit beside each other, the wishes give way). When what is below it (editor, footer) leaves too little room, it moves up only as far as needed; if it still doesn't fit, the commands go first, then the picture, so the logo is never pushed off the top. The normal header comes back with the first message; switching the model in the empty chat switches the logo.

- **Clawd**, the crab from Claude Code, for the Claude CLI instances – animated: jumps in when it appears and waves, then blinks, looks around, patters and hops now and then. `PI_LOGO_STATIC=1` keeps it still. On holidays it dresses up: Santa hat with snowfall in the background (1–26 December), party hat with fireworks in the background (New Year's Eve/Day), a pink partner Clawd with rising hearts (Valentine's Day), jester's cap with clown nose, streamers and fluttering confetti (carnival), bunny ears with painted eggs hopping in the grass (Good Friday to Easter Monday) and witch's hat (24–31 October; Clawd then comes out of the dark: first glowing eyes, its silhouette in a lightning flash, then it jumps out with fangs and red eyes). `/costume` changes the costume for the running pi session (a list to pick from, or directly e.g. `/costume halloween`; `none` without a costume, `auto` by the date again), `PI_CLAWD_COSTUME=christmas|newYear|valentine|carnival|easter|halloween|none` sets it at start
- **Gravi**, a hover bot in Google blue, for Antigravity (whichever model it runs): Clawd's moves and costumes with a rounded body and a flickering thruster flame instead of feet; it bobs gently while it hovers
- Own artwork: **Claude** (spark; Anthropic API and Claude via Bedrock/Vertex), **Gemini**, **Mistral**, **Meta**, **OpenAI**, **xAI**, **Ollama**
- All other providers: their name in a block font, for known ones (Copilot, DeepSeek, Kimi, OpenRouter, Qwen) in their brand colour
- `/logo` shows the logo again (until the next message)
- `/costume` dresses Clawd and Gravi up: a costume, `none` or `auto` (by the date) – without an argument as a list

Tip: `"quietStartup": "header"` in `~/.pi/agent/settings.json` hides pi's own startup list of loaded extensions, skills etc., so the logo stands alone (chat-view lists the extensions above the editor instead).

The provider is recognised first, then the model name. New logos go into `extensions/provider-logo/logos.ts` as pixel grids.

## chat-crab

Once a chat with a Claude model has started, a tiny, slim Clawd (10 columns, 3 rows) lives above the editor and acts out what the agent is doing. With an Antigravity model Gravi plays the same scenes, in blue, hovering on its thruster flame:

| Agent | Clawd |
|---|---|
| message sent (also steered or queued while it works) | the message folds up in the editor: its letters slide together under Clawd's side and become an envelope `[✉]`, which flies up; Clawd reaches for it, catches it and hops holding it up, then lands with a spark `✦` and a puff of dust |
| thinking | looks back and forth, scratches its head; beside it a thought bubble whose trail puffs up, the dots fill, a `?` comes up and turns into a sparkling idea `✦` |
| writing | patters; a sheet fills with words behind a moving pen `✎` |
| reads a file (Read) | reads a book with the file's name beside it: the line being read lights up as its eyes follow it, then the page turns |
| edits/writes a file (Edit, Write) | types in a little editor titled with the file and a modified dot `●`: the old line is deleted in red (`-`), the new one typed in green (`+`) |
| shell command (Bash) | types the command into a terminal with window buttons `● ● ●`, then a spinner runs while it does |
| searches files (Grep, Glob) | a magnifier `◉` sweeps a line and lights up the matches, the pattern above it |
| web (WebFetch, WebSearch) | a globe spins and sends a packet to the host and back |
| subagent (Agent, Task) | waves after a little crab that dashes off and back, the task above it |
| todos (TodoWrite, Task…) | ticks off a checklist of three, line by line |
| other tools | walks to and fro, a spinner and the tool's name beside it |
| tool failed | ducks, a red `✗ !` and stars circling its head |
| `git commit`, `git push`, tests passed | hops and waves in a burst of confetti (`committed`, `pushed`, `passed`) |
| new step (thinking, tool, writing) | plays the scene right where it is; after 20 s of thinking it moves on to another spot |
| done | hops with raised arms and waves in confetti (`done`) |
| running for more than 3 minutes | gets tired eyes |
| nothing to do | blinks and looks around; falls asleep after 90 s with Z's rising, at night (22–6 h) after 20 s |

In the empty chat provider-logo shows the big Clawd; the small one appears with the first message (that one it catches without the fold, as it only appears then). The fold plays in the editor, which pi gives extensions no hook for; so chat-crab replaces the editor with pi's own one that wraps sending – another extension that replaces the editor takes over from it. The message still goes out at once. With models of other providers it stays away. pi's own tools come from pi's tool events; the CLIs run their tools themselves, so claude-code and antigravity publish them on pi's event bus (channel `cli-agent:tool`). Beside it the crab has up to 56 columns for terminal, file name, host and text; less in narrow terminals, so it still has room to walk. While the agent works, chat-view's key hints stand right-aligned on the crab's middle row, in short form (`↵ steer · ⌃↵ now · ⌥↵ queue · esc stop`); the crab and its scenes keep left of them.

- `/crab [on|off]` shows or hides it (toggles without an argument)
- `PI_CRAB=0` starts with the crab hidden

## chat-view

Changes to how the chat itself looks and behaves – for every model.

### Pinned user message (sticky prompt)

When the user message scrolls out at the top, a copy of it stays at the top of the chat while the answer, thinking and tool output keep scrolling below – like `position: sticky` in HTML. When the next user message comes up from below while scrolling, it pushes the pinned one out at the top and takes its place; scrolling back to the message puts it back in its place in the chat. Long messages are pinned with their first 4 rows. A click on the pinned message scrolls the chat back to it.

Only in pi's fullscreen mode (`tuiMode`, the default); in regular mode the terminal scrolls by itself, so there is nothing to pin to.

- `/sticky [on|off]` switches it on or off (toggles without an argument)
- `PI_STICKY_PROMPT=0` starts with it off

### Steer and queue

While the agent works, the keys for writing to it in between stand right-aligned above the editor, with whatever is already on its way:

```
 ↪ Steer  fix the test first
 ◷ Queued then update the README
      enter steer (after this step) · ctrl+enter steer now · option+enter queue (when done) · option+up edit waiting · escape stop
```

- **Steer** (Enter): reaches the agent after the current step and redirects it – with the Claude CLI models too, see [claude-code](#claude-code)
- **Steer now** (Ctrl+Enter, or `/now <message>`): stops the current step and sends the message right away
- **Queue** (Option+Enter): waits until the agent is done, then goes out as the next message
- **Edit** (Option+↑): brings all waiting messages back into the editor
- **Stop** (Escape): cancels the run; waiting messages come back into the editor

With the mouse (pi's fullscreen mode), a click on a key in the panel does the same as the key (steer and queue take the editor's text), and a click on a waiting message brings the waiting messages back into the editor. The short keys beside chat-crab's Clawd are not clickable.

The keys come from pi's keybindings (`tui.input.submit`, `app.message.followUp`, `app.message.dequeue`, `app.interrupt`), so changes in `keybindings.json` show up here too; Ctrl+Enter needs a terminal that tells it apart from Enter (kitty keyboard protocol, e.g. Ghostty, kitty, iTerm2) – otherwise use `/now`. pi's own "Steering: …" / "Follow-up: …" lines are hidden while the list shows them. While chat-crab's Clawd is shown, the keys move onto its row in short form, with symbols for the keys.

- `/queue [on|off]` switches the panel on or off (off: pi's own lines again; toggles without an argument)
- `PI_QUEUE_VIEW=0` starts with it off

### Work and answer apart (grouped messages)

If the model thought or used tools before its answer, that goes into a framed work part; the answer follows set apart below it:

```
 ╭─ ✻ Thinking
 │  The user wants the files listed. Let me check.
 │
 ├─ ⚙ Tools · 2 calls
 │  ⏺ Bash ls -la
 │  ⎿ 3 lines
 │    ╭─
 │    │ README.md
 │    │ package.json
 │    │ extensions
 │  ⏺ Read package.json
 │  ⎿ 42 lines
 │    ╭─ json
 │    │ 1 │ {
 │    │ 2 │   "name": "pi-claude-code",
 │    … 40 more lines · click or ctrl+o to expand
 │
 ├─ ✻ Thinking
 │  Now I can answer.
 ╰─

 ● Answer ──────────────────────────────────────

 There are three entries: …
```

- Consecutive thoughts stand under one "✻ Thinking", consecutive tool calls (the CLI providers' `⏺`/`⎿` blocks, see [Tool calls](#tool-calls)) under one "⚙ Tools" with the number of calls
- Text between the steps appears as "✎ Note" in the work part; what comes after the last step is the answer. While the message is still being written, all text shows as a note; it moves under "Answer" only once the message is done
- Messages without thinking and tools look as before; hidden thinking (Ctrl+T) shows only the heading
- With the mouse (pi's fullscreen mode), a click on a thought shows or hides just that one; pi's thinking toggle sets them all alike again

#### Tool calls

The tool calls of the CLI providers (**claude-code**, **antigravity**) show as one compact header per call – the tool and what it works on – with the details indented below:

```
 ⏺ Bash Run the tests
   ╭─ bash
   │ npm test && npm run check
 ⎿ 12 lines
   ╭─
   │ ok 1 - parses
   │ Error: expected 2, got 3
   … 4 more lines · click or ctrl+o to expand
 ⏺ FreeCAD › execute_code
   ╭─ python
   │ import FreeCAD
   │ doc = FreeCAD.ActiveDocument
 ⏺ FreeCAD › get_objects Remote
 ⎿ 2 entries
   ┌──────┬─────────┬──────────────────┐
   │ Name │ Label   │ TypeId           │
   ├──────┼─────────┼──────────────────┤
   │ Body │ Housing │ PartDesign::Body │
```

- **Header**: built-in tools with their description, path (relative to the project), pattern or range; MCP tools as `Server › tool` (`mcp__freecad__execute_code` → `FreeCAD › execute_code`) with the document or object they work on. A result that does not follow its call directly names its tool
- **Code** highlighted: Bash commands, code arguments of MCP tools (`code`, `script`, `sql`, … – Python for FreeCAD) as code blocks instead of a JSON string with `\n`; the other arguments as indented JSON
- **Results**: short output in the header line; longer output below it. JSON indented, lists of objects as a table (plain fields first, at most 6 columns), files read highlighted by type with line numbers, edits as coloured diffs, images inline (where the terminal can draw them, otherwise their path), error results red and error lines in output (tracebacks, `Error:` …) too
- **Collapsed**: details show their first 8 rows and how many follow; pi's Ctrl+O (`app.tools.expand`), which expands pi's own tool output, expands them too; a click on a block (pi's fullscreen mode) expands or collapses just that one, until Ctrl+O sets them all alike again
- Only the display: the agents get their tool results unchanged, and when a CLI session has to be rebuilt from pi's transcript only the header lines go along. The message keeps at most 300 lines per call; with `/group off` the blocks show as plain Markdown, uncollapsed

MCP tools of pi's own models (`mcp__<server>__<tool>` from pi's `mcp.json`) look the same inside pi's tool box: `Server › tool` with what it works on, code highlighted, arguments as indented JSON, the result as a table, JSON or text, collapsed until Ctrl+O; pi draws their images below. Tools that bring their own renderer keep it.

- `PI_MCP_VIEW=0` leaves pi's own MCP tools as pi draws them

Code blocks in the model's messages get a line on the left instead of pi's literal ```` ```typescript ```` fences: it bends into the language at the top (`╭─ typescript`, the language dimmed and in italics) and stays open at the bottom. It takes the theme's code colour, so it stands apart from the grey frame above.

pi offers no hook for this; the extension looks for pi's `AssistantMessageComponent` in the TUI and replaces its layout. If pi changes that component, at worst the old layout stays.

- `/group [on|off]` switches it on or off (toggles without an argument)
- `PI_GROUP_MESSAGES=0` starts with it off

### Mermaid diagrams

pi itself draws ```` ```mermaid ```` blocks as box-drawing art (setting `markdown.mermaid`: `off`, `final`, `streaming`), but shows a diagram as source code when it is wider than the chat. chat-view steps in there:

- A flowchart that is too wide is drawn turned: left-right (`LR`/`RL`) as top-down, top-down as left-right, whichever fits. Long chains of boxes side by side usually fit top-down
- If a diagram fits neither way, it stays as source and, once the round is over, a note goes to the model (shown in the chat): which diagram, how many columns it needs, how many there are, and a request to draw it narrower. At most two notes in a row, then it waits until you write again; nothing is sent after Escape
- Diagrams pi cannot draw at all (syntax errors, types such as `pie` or `gantt`) stay as pi shows them

The drawing comes from `grok-mermaid`, which pi ships; chat-view loads it from pi's install. `%%{init}%%` options such as font size or spacing have no effect in the terminal.

- `PI_MERMAID_FEEDBACK=0` turns the note to the model off

### Prompt history

↑ in the empty editor opens your earlier prompts of this session as a framed list right above the editor, the newest at the bottom; it grows upwards row by row. The frame closes into the editor's top border, in the editor's border colour.

```
╭─ History ──────────────────╮
│   Fix the logo position    │
│   Commit everything        │
│ ▸ Give me an example       │
╰────────────────────────────╯
Give me an example
────────────────────────────
```

- ↑/↓ walk the list; the selected prompt goes straight into the editor
- Enter sends it, any other key edits it, Esc empties the editor, ↓ past the newest leaves the list empty; each closes the list, which shrinks back
- At most 8 rows; longer histories scroll, long prompts are cut to one line
- With the mouse (pi's fullscreen mode): a click puts a prompt into the editor, a double click sends it, the wheel walks the list
- With text in the editor or a dialog open, ↑ does what it did before
- `PI_HISTORY_STATIC=1` opens and closes it without animation

### Command list

pi's suggestions while you type – /commands, and files after `@` or Tab – show in a frame right above the editor instead of below it, like the history list: up to 8 rows, the counter (`1/43`) in the top edge, growing and shrinking row by row.

```
╭─ Commands ────────────────────── 1/43 ─╮
│ ▸ copy      Copy last agent message …  │
│   compact   Manually compact the …     │
╰────────────────────────────────────────╯
/co
────────────────────────────────────────
```

pi still does the searching, selecting, Tab and Enter; only where and how the list shows changes. With the mouse (pi's fullscreen mode), a click on a suggestion applies it like Tab, and the wheel moves the selection. The title says "Commands" when the text starts with `/`, "Files" otherwise. `PI_HISTORY_STATIC=1` turns its animation off too.

### Answer box

After a long round (90 seconds or more from sending to its end), the answer also shows in a framed box right above the editor, so it reads without scrolling the chat. Its bottom edge is the editor's top border, like the history list's.

```
╭─ ● Answer · 2m 10s ───────────── ↑ 4 more  ✕ ─╮
│ The list is done, committed and pushed. …     │
╰────────────────────── ↓ 24 more · esc close ───╯
 _
────────────────────────────────────────────────
```

- Only the answer, not thinking, tools or notes; all of it, with code blocks as in the chat
- As high as the answer, at most two thirds of the terminal; beyond that it scrolls: Shift+↑/↓ by row, Page Up/Down (fn+↑/↓ on a Mac) by page, or with the mouse wheel while the pointer is over it (in pi's fullscreen mode; the chat behind it stays put)
- Esc, a click on the ✕ in its top edge or your next message closes it; the chat behind it keeps the whole answer
- While the history or command list is open, the box makes room for it and comes back when the list closes
- Not for stopped or failed rounds
- `PI_ANSWER_BOX_AFTER=<seconds>` sets what counts as a long round (default 90)

### Shell mode

pi runs a prompt starting with `!` as a shell command: with `!` its output goes to the model with your next message, with `!!` it stays with you. The editor shows which one it is:

```
────────────────────────────────────────────────
!git status            ! shell · output goes to the AI
────────────────────────────────────────────────
```

- `!`: the editor's borders turn purple – a bright wave runs along them from the left; when the `!` goes, the old colour sweeps back in from the right
- `!!`: the same, and the text turns grey, since the output stays out of the model's sight
- A short grey hint at the right end of the last text row says where the output goes (on the bottom border when the row is too full)
- `PI_SHELL_MODE_VIEW=0` leaves the editor as pi draws it; `PI_HISTORY_STATIC=1` turns the sweep off

### Editor height

When the editor gets more or fewer rows – a new line, a long prompt from the history list, sending – it grows or shrinks one row at a time instead of jumping. While it grows, the rows around the cursor show; while it shrinks, empty rows fold away.

- `PI_EDITOR_STATIC=1` turns it off

### Extension list

While the chat is empty, the loaded extensions are listed above the editor. pi gives extensions no list of the loaded extensions; it is built from the extensions' commands and tools, so an extension that registers neither (such as task-list) is missing from it. provider-logo takes the list over and draws it itself, beside its logo where both fit; without provider-logo the list stands above the editor.

## image-paste

Sharing a screenshot with the model: copy it to the clipboard (e.g. Ctrl+Cmd+Shift+4 on macOS) and press **Ctrl+V** in the editor, or drag the file into the terminal, or type its path. pi itself only puts the path into the prompt (for a clipboard image, the path of a temp file it writes), so the model gets text and has to open the file on its own. image-paste attaches every image file named in a prompt to the message when it is sent; the path stays in the text, followed by `[image 1 attached]`.

- Found: absolute paths and `~/…`, with spaces escaped (`\ `, as dragging writes them), quoted or plain, and `file://` URLs; PNG, JPEG, GIF and WebP, checked by their content. Relative paths are left alone
- Only for models that take images; pi resizes them to the model's limits. With pi's setting `images.blockImages` nothing is attached
- Files over 30 MB and more than 20 images per message stay paths, with a warning
- With **claude-code** the image goes to Claude as an image; with **antigravity**, which takes no attachments, as a file in the session's temp folder that agy opens

- `PI_IMAGE_PASTE=0` turns it off

## work-status

For every model:

- while a CLI provider works, an animation above the editor in Claude Code style: a breathing star, a shimmering verb (or what the running tool does: Running, Reading, Editing, …), the elapsed time and the tokens so far. For Antigravity in its look: Google blue, an orbiting `◜◠◝◞◡◟` and verbs like *Levitating* or *Orbiting*
- after each answer a line `✻ Cooked for 1m 12s · ↓ 3.4k tokens` in the chat (Antigravity: `◝ Floated for 1m 12s`) (saved with the session, never sent to the model; "Interrupted after …" or "Failed after …" when it did not finish)
- the terminal tab title shows a spinning star while pi works and ✓ when an answer finished while the window was in the background
- a macOS notification when an answer took a while and the window was not in focus
- a **session title** after the first answer, so the tab reads e.g. `π - Fix context window size - pi-claude-code` instead of just the folder. It names the session as `/name` does (also in `/resume`). Sessions with a name of their own keep it.

The title is written by the **smallest model of the selected provider**, from the first prompt and the start of the answer:

- **Antigravity**: agy with its smallest variant (`gemini-3.8-flash-low`), in plan mode, without slash commands. agy cannot leave a conversation unsaved, so each title is a short conversation of its own in agy's history.
- **Claude CLI instances**: the instance's own CLI with its `haiku` alias (else its smallest tier), its own short system prompt, no tools, no MCP servers and no saved session – it never touches the chat's Claude Code session. About 800 input tokens, a few seconds, in the background.
- **Other providers**: the provider's smallest available model by name (nano, mini, lite, haiku, flash, …), else its cheapest, through pi's model registry.

| Command | Effect |
|---|---|
| `/retitle` | write a new title for the session now (also replaces a name set by hand) |
| `/name <title>` | pi's own: set the title by hand |

| Variable | Meaning |
|---|---|
| `PI_NOTIFY_AFTER` | seconds an answer must take before it notifies (default 30, `off` disables) |
| `PI_AUTO_TITLE` | `0` turns automatic session titles off |

## commands

General commands, independent of the model:

| Command | Effect |
|---|---|
| `/clear` | start a new session (like `/new`, under the name Claude Code uses) |
| `/effort [low\|medium\|high\|xhigh\|max]` | set the effort; without an argument as a slider (←/→, Enter applies, Esc cancels; a click picks a level, a second click or a double click applies it, the wheel moves). Only levels the active model supports. Corresponds to pi's thinking level (Option+T); for Claude CLI models → `claude --effort` |
| `/export` | the whole conversation as Markdown – pick *Copy to clipboard* or *Save as Markdown file* |
| `/export copy` | copy it right away |
| `/export file [path]` | save it (default: `pi-<session>-<time>.md` in the working directory) |
| `/export <file>.html` / `.jsonl` | pi's own export, as before |

The Markdown export contains the prompts and answers, thinking (folded), tool calls with their arguments and results (folded), shell commands and the summaries of compactions – to read it later or to hand it to a new chat. pi handles its built-in `/export` before any extension command, so this one takes over Enter while the editor holds `/export …`; paths ending in `.html` or `.jsonl` are left to pi.

## ide

Connects pi to the IDE you work in, the way Claude Code does: the **Claude Code plugin** for JetBrains IDEs ("Claude Code [Beta]" – IntelliJ IDEA, WebStorm, PyCharm, Rider, Android Studio, …) and the Claude Code extension for VS Code (and Cursor, Windsurf) run a small MCP server in the IDE and announce it in `~/.claude/ide/<port>.lock`. pi connects (WebSocket, the lock file's token) to the IDE whose project holds pi's folder or lies inside it – the one whose terminal pi was started in first – and keeps looking every few seconds while none is connected. Works with every model.

Above the editor:

```
⧉ IntelliJ IDEA  src/foo.ts:12-30 · 19 lines · goes with your next message · alt+k insert
```

- **Selection with the next message**: the selected lines with their text go with your next message as context (`<ide_selection>`), once per selection; without a selection the file open in the IDE is named (`<ide_context>`). The chat shows it as one line (`⧉ src/foo.ts:12-30 (19 lines) · IntelliJ IDEA`), the text with Ctrl+O. Selections over 20,000 characters go as a reference only. `/ide` switches this off and on (kept in `~/.pi/agent/ide.json`).
- **Insert a reference**: `Alt+K` inserts `@src/foo.ts#L12-30` (or `@src/foo.ts` with nothing selected) into the editor; in the IDE, `Cmd+Alt+K` / "Send to Claude Code" does the same from there. Paths outside pi's folder stay absolute.
- **Hint**: a supported IDE that runs without the plugin, or with it installed but no server running (switched off, or needs a restart), gets a line above the editor instead (`⧉ IntelliJ IDEA runs without the Claude Code plugin · …`); `/ide` hides it for good.

**The way back to the IDE:**

- **Links in the chat**: file references in answers and your messages – `` `src/foo.ts:12` ``, `src/foo.ts:12-30`, `@src/foo.ts#L12-30`, files that exist only – become links that open the file at that line in the connected IDE (Cmd+click in Ghostty, a click in pi's fullscreen mode). They use the IDE's URL scheme, so only for IDEs with their own: VS Code (`vscode://`), Cursor, Windsurf, IntelliJ IDEA (`idea://`), WebStorm, PyCharm; only in terminals with hyperlinks (OSC 8). `idea://` is also claimed by Android Studio; with both installed macOS may open either.
- **`/ide open <file>[:line]`** opens a file in the connected IDE (any IDE, through its plugin), on that line and with it selected; takes the same forms as above.
- **`/ide diff [file]`** shows a file's change since the last commit in the IDE's diff viewer – the committed version left, the file as it is now right; without a file it asks which of the changed files. The IDE waits for Accept or Reject; edits you make in the right pane and accept are saved to the file (unless it changed meanwhile).

`/ide` without arguments lists what you can do: connect to another IDE that has a lock file, disconnect, show a diff, switch sending the selection off and on, hide hints.

The IDE plugins serve one client at a time: a Claude Code started in the IDE's terminal takes the connection over from pi (and pi from it). pi then leaves that IDE alone until `/ide` connects it again.

## Development

```bash
npm run check   # type check against the types of the installed pi version
npm test        # tests, also against the installed pi
```

Installed locally (`pi install <path>`), changes take effect after `/reload` in pi.

Layout:

| File | Purpose |
|---|---|
| `extensions/claude-code/index.ts` | entry point: provider, event channels, commands, wizard |
| `extensions/claude-code/config.ts` | instances, file paths, suggestions for the wizard |
| `extensions/claude-code/cli.ts` | start the CLI, query models and usage, model cache |
| `extensions/claude-code/login.ts` | browser sign-in of an instance over the CLI's control protocol |
| `extensions/claude-code/wizard.ts` | "add instance" wizard for `/claude-add` and `/login` |
| `extensions/claude-code/stream.ts` | CLI stream → pi events, session mapping, temp folders |
| `extensions/claude-code/status.ts` | status and task list for the event channels |
| `extensions/claude-code/usage.ts` | parse plan usage limits |
| `extensions/claude-code/state.ts` | shared state, permission modes |
| `extensions/claude-code/tasks.ts`, `diff.ts` | task list and edit diffs from Claude's tool calls |
| `extensions/antigravity/index.ts` | entry point: providers per instance, /login, event channels, commands |
| `extensions/antigravity/cli.ts` | start agy, model list and its effort variants |
| `extensions/antigravity/stream.ts` | agy stream → pi events, conversation mapping, temp folders |
| `extensions/antigravity/permissions.ts` | allow rules from denied actions, agy's settings |
| `extensions/antigravity/wizard.ts` | wizard for new instances (dialogs and /login) |
| `extensions/antigravity/state.ts`, `config.ts`, `oneshot.ts` | modes and state, instances and files, one-off questions |
| `extensions/agent-status-line/index.ts` | status line below the editor, wrapping in narrow terminals, Shift+Tab |
| `extensions/usage-graph/index.ts` | `/usage` overlay, recording usage events, periodic refresh of all accounts |
| `extensions/usage-graph/history.ts` | usage history file: when to write a sample, loading and pruning |
| `extensions/usage-graph/models.ts` | tokens per answer and model: the log file and the sums per model and time slot |
| `extensions/usage-graph/chart.ts` | braille line chart and stacked bars, with value and time axis |
| `extensions/task-list/index.ts`, `render.ts` | task list above the editor |
| `extensions/subagents/index.ts` | subagent panel above the editor, `/subagents`, opening the popup |
| `extensions/subagents/panel.ts`, `browser.ts` | the panel's rows; the popup with a box per subagent and its live output |
| `extensions/claude-code/subagents.ts` | Claude's subagents from the transcripts in its config folder |
| `extensions/antigravity/subagents.ts` | agy's subagents from its conversation transcripts |
| `extensions/shared/subagent-files.ts` | following transcript files, a subagent's status and steps |
| `extensions/pi-bridge/index.ts` | pi's MCP server for the CLIs: start, tokens over `pi-bridge:server`, pi tools for pi's own models |
| `extensions/pi-bridge/server.ts` | MCP over HTTP on 127.0.0.1 (JSON-RPC: initialize, tools/list, tools/call); `/mcp/<server>` for proxied servers |
| `extensions/pi-bridge/mcp-proxy.ts` | pi's MCP servers for the CLIs through pi's own connections, without the tools pi hides |
| `extensions/pi-bridge/tools.ts` | the tools: ask, permission, change_request, wishes, watches, steps, reading and changing pi |
| `extensions/pi-bridge/watch.ts` | watches: commands pi runs while an agent waits, time limit, stop, the message with the result |
| `extensions/pi-bridge/steps.ts` | steps: the stepper an agent shows above the editor, statuses, going away when finished, its lines |
| `extensions/pi-bridge/workflow.ts` | workflows: the tree of parts, dependencies, the parts to start, failures, the user's edits, saving |
| `extensions/pi-bridge/workflow-runner.ts` | runs workflows for the tools: review, the texts for the agent, asking about failed parts, waking the agent |
| `extensions/pi-bridge/workflow-view.ts` | workflow lines above the editor and the popup with the tree (review and while it runs) |
| `extensions/pi-bridge/wishes.ts` | wish list: Markdown file, status, rows for the empty chat and the wish each opens |
| `extensions/pi-bridge/wish-popup.ts` | wish popup (`/wishes`): list and preview, filter, search, status, work on it |
| `extensions/pi-bridge/ask.ts` | question dialog: options, own answer, extra input field, several questions |
| `extensions/pi-bridge/permission.ts` | permission dialogs (Claude, agy): rules, choices, saving "always" rules |
| `extensions/pi-bridge/agy-gate.ts` | agy's gate: broad rules plus a PreToolUse hook, what pi asks about |
| `extensions/permission-retry/index.ts` | dialog for denied actions, retry |
| `extensions/provider-logo/index.ts` | logo in the empty chat: replace the header, centre, scale, animate |
| `extensions/provider-logo/logos.ts` | pixel art of the providers and block font |
| `extensions/provider-logo/clawd.ts` | Clawd and Gravi and their animation (poses and timeline) |
| `extensions/chat-crab/index.ts` | small Clawd above the editor: widget, events → mood and scene, walking |
| `extensions/chat-crab/crab.ts` | poses, animations and props (book, terminal, globe, …) of the small Clawd and Gravi per mood |
| `extensions/chat-crab/send.ts` | editor that folds a sent message into the envelope Clawd catches |
| `extensions/chat-view/sticky-prompt.ts`, `sticky.ts` | pinned user message |
| `extensions/chat-view/message-queue.ts`, `queue.ts` | steer and queue panel, steer now |
| `extensions/chat-view/grouped-messages.ts`, `grouping.ts` | work part and answer apart |
| `extensions/chat-view/code-blocks.ts` | code blocks with a line bending into the language instead of ``` fences |
| `extensions/chat-view/tool-blocks.ts` | the CLI agents' tool calls: header, details collapsed, line numbers, error lines, images |
| `extensions/chat-view/mcp-tools.ts` | MCP tools of pi's own models drawn as tool blocks (`registerToolRenderer`) |
| `extensions/chat-view/mermaid.ts`, `diagrams.ts` | Mermaid flowcharts too wide drawn turned, note to the model for what still does not fit |
| `extensions/chat-view/extension-list.ts` | list of loaded extensions in the empty chat |
| `extensions/chat-view/prompt-history.ts`, `history.ts` | earlier prompts as a list above the editor |
| `extensions/chat-view/command-list.ts` | pi's suggestions for /commands and files in a frame above the editor |
| `extensions/chat-view/editor-frame.ts` | frames above the editor that close into its top border |
| `extensions/chat-view/answer-box.ts`, `answer.ts` | answer of a long round in a scrollable box above the editor |
| `extensions/chat-view/editor-height.ts` | editor grows and shrinks row by row |
| `extensions/chat-view/shell-mode.ts` | `!` / `!!` in the editor: purple borders with a sweep, grey text, the hint |
| `extensions/image-paste/index.ts` | attach image files named in a prompt to the message |
| `extensions/image-paste/paths.ts` | find image paths in the prompt (escaped, quoted, plain spaces, `file://`, `~`) |
| `extensions/work-status/index.ts` | duration line, tab title, notifications, session titles |
| `extensions/work-status/animation.ts` | working animation while a CLI provider works |
| `extensions/work-status/title.ts` | which model writes the title, the prompt and cleaning its answer |
| `extensions/claude-code/oneshot.ts` | one-off questions to a Claude CLI instance (smallest model, no tools, no session) |
| `extensions/commands/index.ts` | `/clear`, `/effort`, `/export` |
| `extensions/commands/effort-picker.ts` | effort slider for `/effort` |
| `extensions/commands/export.ts`, `conversation.ts` | `/export` and the conversation as Markdown |
| `extensions/ide/index.ts` | IDE connection: finding and connecting the IDE, the line above the editor, Alt+K, the context with the next message, `/ide` |
| `extensions/ide/lockfiles.ts` | the IDE plugins' lock files and which IDE fits pi's folder |
| `extensions/ide/connection.ts` | MCP client over WebSocket to the IDE: handshake, notifications, tool calls |
| `extensions/ide/reference.ts` | selection → `@path#L12-30`, the label above the editor, the context for the model |
| `extensions/ide/links.ts` | file references in the chat → links to the IDE, where `/ide open` lands in a file |
| `extensions/ide/actions.ts` | opening a file and showing a diff in the IDE (`/ide open`, `/ide diff`) |
| `extensions/ide/detect.ts` | running IDEs without (an active) Claude Code plugin, for the hint |
| `extensions/shared/pi-mcp.ts` | pi's MCP servers from `mcp.json` in the shape the CLIs take |
| `extensions/antigravity/mcp.ts` | mirror of the gemini folder with pi's MCP servers for agy |
| `extensions/shared/brand.ts` | look per provider: colours, spinner, verbs, mascot |
| `extensions/shared/format.ts` | formatting shared by the extensions (durations, tokens) |
| `extensions/shared/agent-bus.ts` | event channels between the CLI providers and the extensions that show what they do |
| `extensions/shared/opening.ts` | how a dialog opens (`/usage`, the wish popup: unfolding frame, typed and lit title, rows appearing) and glides to a new size |
| `extensions/shared/backdrop.ts` | darkens the screen behind a dialog (`/usage`, the wish popup), fading in |
| `extensions/shared/pi-install.ts` | where the running pi is installed: its package (docs, version) and dependencies such as grok-mermaid |
| `extensions/shared/wish-list.ts` | event channel for the open wishes in the empty chat (pi-bridge → provider-logo), clicks on them back to the popup |
| `extensions/shared/tool-lines.ts`, `diff.ts` | tool blocks (call and result: header, code, JSON, tables, images) and edit diffs the CLI providers write into the answer |
| `settings/install.sh` | links and merges the pi settings in `settings/` into `~/.pi/agent` |
| `settings/*.json`, `settings/extensions/` | my pi settings, keybindings, Claude instances and footer extension |
| `scripts/typecheck.mjs` | `npm run check` |
