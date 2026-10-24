# Antigravity CLI contract ledger

Measured facts about Google's Antigravity CLI (`agy`) that Koloft depends on and that
**reading Koloft's own code cannot reveal**. Claude Code, Codex, Muse Code and the
platforms have their own ledgers. Each entry says how it was established; a disproven
entry is corrected in place, never kept for history. Code cites a section with an
`// AGY§N` marker.

**How everything here was established, unless a bullet says otherwise**: agy 1.3.6,
the Linux arm64 build from the official installer, in Debian bookworm Docker
containers (no D-Bus, mostly `--network none`, sometimes behind a logging HTTPS proxy),
October 2026. The command line, storage, hooks, keys, local API, title slot, `-p`
output and account-folder links were then measured again on agy 1.4.0 (build
`1.4.0-5281842794987520`, Linux arm64) and none had changed. The macOS facts come from
a throwaway macOS 27 virtual machine (tart, no screen) running agy 1.3.6, started
inside the desktop login session so the Keychain works. A bullet measured only on
1.4.0 or only on macOS says so. Stand-ins, none needing a Google account:

- a **fake Gemini server**: `"modelProvider":"gemini"` in `settings.json`, a made-up
  `GEMINI_API_KEY`, and `GOOGLE_GEMINI_BASE_URL` pointing at a local server that
  answers the one call agy makes (§2), and can make agy call its tools;
- a **fake Google sign-in**: Google's OAuth and Code Assist endpoints faked behind a
  local CA (`SSL_CERT_FILE`) and an HTTPS proxy that logged every request and the
  Bearer token it carried;
- a **fake update manifest** serving a "newer" version;
- a **terminal**: a pty driver that answers the TUI's queries (DA1, DA2, DECRQM, OSC
  11, OSC 7501, XTVERSION, cursor position), or tmux 3.3a where a bullet names it.

Nothing ran against Google's real servers.

## §1 The command line

- `agy` starts the TUI (text user interface). `agy --version` prints only the version
  (`1.3.6`, `1.4.0`); `agy version` exits 2. `--version` and `--help` create no files.
- `-c` / `--continue` resumes the conversation saved for this folder (§8,
  `cache/last_conversations.json`). `--conversation=<id>` resumes by id; an unknown id
  prints `warning: conversation "<id>" not found`, starts a new conversation and
  (with `-p`) exits 0.
- Other flags: `--mode accept-edits|auto|plan`, `--dangerously-skip-permissions`,
  `--sandbox`, `--model`, `--effort`, `--add-dir`, `--agent`, `-i`, `-p`,
  `--output-format`, `--input-format`, `--print-timeout`, `--json-schema`. `-p` with
  `-i` exits 2.
- Subcommands (`agy --help`, 1.3.6, Linux, 2026-10-17): `agent`/`agents`, `changelog`,
  `help`, `install`, `mcp`, `mic-serve`, `models`, `plugin`/`plugins`,
  `remote-control`, `update` — none opens the TUI. Flags that take a value: `--add-dir`,
  `--agent`, `--conversation`, `--effort`, `-i`/`--prompt-interactive`,
  `--input-format`, `--json-schema`, `--log-file`, `--mode`, `--model`,
  `--output-format`, `--print-timeout`, `--project`; `-p`/`--print`/`--prompt` run one
  prompt without the TUI. Flags parse Go-style, so `--flag=value` works too.
- Hidden flags, missing from `--help` but working: `--gemini_dir=<absolute path>`
  (§4) and `--csrf_token=<value>` (§16). `--app_data_dir` exists too: an absolute path
  fails with "must not be absolute", a relative one lands under the gemini dir.
  `--server_port`, `--language_server_port`, `--lsp_port`, `--http_server_port` and
  `--port` are unknown flags (agy prints its help).
- A first message at launch (1.4.0): `-i "<text>"` and `--prompt-interactive "<text>"`
  send it at once and stay interactive (SessionStart, PreInvocation, PostInvocation,
  Stop fire as for a typed message; 7501 `idle` comes 30–50 ms before `working`).
  `agy "<text>"` exits 2: `Error: unexpected argument "<text>". Prompts are read only
  from -p/--print, -i/--prompt-interactive, or stdin…`.
- No flag or environment variable adds a system prompt. `ANTIGRAVITY_CONVERSATION_ID`
  set at launch is ignored: there is no way to choose a new conversation's id.
- `/exit` prints `Resume with -c (or command below):` and `agy --conversation=<id>`,
  then exits 0.
- `AGY_CLI_NONINTERACTIVE_HEADLESS=1` or `AGY_CLI_INTERACTIVE_HEADLESS=1` without a
  terminal exits at once with `could not open TTY`.
- `agy changelog` downloads the list from
  `raw.githubusercontent.com/google-antigravity/antigravity-cli/…/CHANGELOG.md`;
  offline, the 1.4.0 binary shows its built-in copy, whose newest entry is 1.3.6.

## §2 What agy sends the model

- On the API-key route the only call is `POST
  /v1beta/models/<model>:streamGenerateContent?alt=sse`, with headers
  `x-goog-api-key` and `user-agent: google-genai-sdk/1.75.0 gl-go/…`. No model-list or
  token-count calls.
- One Server-Sent Event is a whole answer:
  `data: {"candidates":[{"content":{"role":"model","parts":[…]},"finishReason":"STOP"}],"usageMetadata":{…}}`.
  A `functionCall` part makes agy run a tool.
- Each new conversation makes two calls: `gemini-3.1-flash-lite-preview` gets the
  first prompt with no tools, and its answer becomes the title (§8);
  `gemini-3.1-pro-preview` does the turn with 13 tools (§13), a `systemInstruction`
  and `thinkingBudget:1024`. `-p` runs do the same.
- The user's words arrive wrapped:
  `<USER_REQUEST>\n…\n</USER_REQUEST>\n<ADDITIONAL_METADATA>…local time…</ADDITIONAL_METADATA>`.
  The first turn also carries a `<USER_SETTINGS_CHANGE>` block.
- These files reach `systemInstruction` as `<RULE[user_global]>` or `<RULE[<path>]>`
  blocks: `~/.gemini/GEMINI.md`, `~/.gemini/config/AGENTS.md`,
  `~/.gemini/config/GEMINI.md`, `<workspace>/AGENTS.md`, `<workspace>/GEMINI.md`.

## §3 Install, version and self-update

- The installer (`curl -fsSL https://antigravity.google/cli/install.sh | bash`) reads
  `https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/<platform>.json`
  (`{version, url, sha512}`), downloads a tarball from
  `storage.googleapis.com/antigravity-public/antigravity-cli/<ver>-<build>/…`, checks
  its sha512, unpacks it in `~/.cache/antigravity/staging` (left empty), copies the
  binary to `~/.local/bin/agy` (or `--dir`), then runs `agy install`. It installs the
  current release (1.4.0 when run on macOS). If `~/.local/bin/agy` already exists it
  exits 0 and does nothing.
- The binary is one 207 MB file, no launcher script (Linux 1.3.6).
- `agy install` (flags `--dir`, `--skip-path`, `--skip-aliases`) appends
  `# Added by Antigravity CLI installer` and `export PATH="$HOME/.local/bin:$PATH"`
  only to shell start-up files that already exist: `.bashrc` and `.profile` for a bash
  user, `.zshrc` and `.zprofile` for a zsh user who had both. A second run adds
  nothing. With none of them it writes nothing, exits 0 and prints an
  `echo 'export PATH=…' >> ~/.zshrc` hint; `.zshenv` is never written, so `zsh -c`
  never finds `agy`.
- macOS, a fresh zsh user after the installer (1.4.0): no start-up file was written,
  and `command -v agy` failed in `zsh -l -c`, `zsh -l -i -c`, `zsh -c`, `zsh -i -c`
  and `bash -l -c`. `/etc/paths` has no `~/.local/bin`.
- Every launch spawns a background updater ("Spawned background update process")
  unless the last check was under 15 minutes ago, kept in
  `<appDataDir>/last_check.timestamp`, so a new data folder checks again on its first
  launch.
- An update replaces the binary in place at the path that was run, as a new file; the
  old one stays beside it as `<name>.<unixnanos>.old` (still there after the next
  start). `<appDataDir>/updater/update_status.json` says
  `{"success":true,"message":"Update successful, restart CLI to use"}`.
  `agy update` prints `Checking for updates… Found new version… Update successful!
  Please restart agy.` and exits 0.
- Only `AGY_CLI_DISABLE_AUTO_UPDATE=true` turns it off (log: `Auto-update disabled via
  environment variable`). `1`, `TRUE`, `True`, `yes` and `on` do not. No
  `settings.json` key does.
- Two data folders updating the same binary at once: both downloaded, one reported
  success and the other `{"success":false,"message":"Update failed, please install
  from website"}`; the binary was whole and ran, and both runs exited 0.

## §4 Where agy keeps its data and what moves it

- The gemini dir is `~/.gemini`. agy's own folder is `<geminiDir>/antigravity-cli`:
  `settings.json`, `antigravity-oauth-token` (§6), `conversation_summaries.db`,
  `conversations/<id>.db`, `brain/<id>/`, `annotations/<id>.pbtxt`, `presence/`,
  `history.jsonl`, `cache/` (`onboarding.json`, `last_conversations.json`,
  `default_project_id.txt`), `log/cli-<ts>.log` (one per launch; `cli.log` links to
  the newest), `updater/`, `installation_id`, `jetski_state.pbtxt`, `implicit/`, and,
  from the first model turn, `bin/` and `builtin/skills/`. Shared config sits in
  `<geminiDir>/config/`: `config.json`, `mcp_config.json`, `hooks.json`,
  `projects/default-cli-project.json`, `.migrated`, rules, `GEMINI.md`. The desktop
  app's conversations are read from `<geminiDir>/antigravity/conversations` (§23).
- `--gemini_dir=<absolute path>` moves all of it; with it the home folder was never
  even created.
  `HOME` moves all of it too. The only file still under the home folder is
  `$XDG_CONFIG_HOME/antigravity/plugin-secrets.json` (else
  `~/.config/antigravity/…`).
- These move nothing (each compared against a clean home): `XDG_DATA_HOME`,
  `XDG_CACHE_HOME`, `XDG_STATE_HOME`, `ANTIGRAVITY_GEMINI_DIR`,
  `ANTIGRAVITY_APP_DATA_DIR`, `JETSKI_APP_DATA_DIR`,
  `ANTIGRAVITY_EXECUTABLE_DATA_DIR`, `ANTIGRAVITY_CONFIG_REL_DIR`. `AGY_ACCOUNT`
  picks a plugin account (such as `gh`) for a sandboxed command, not agy's own
  sign-in (from `strings` on the binary only).
- Two `--gemini_dir` folders under one home, signed in with two accounts, ran at the
  same time and each sent its own Bearer token (Linux, file storage).
- `settings.json`: agy rewrites it whenever it is not in agy's own form (keys sorted,
  2-space indent, mode 0600). Kept: the keys agy writes itself, `showFeedbackSurvey`,
  `contextWindow`; dropped: `enableTelemetry`. It reads the file again just before
  writing, so a `trustedWorkspaces` entry another program added meanwhile is kept. The
  rewrite is a rename: a symlinked `settings.json` becomes a plain file and its target
  is left as it was. A symlink to a file already in agy's form survived. `agy mcp add`
  replaces a symlinked `config/mcp_config.json` the same way.
- **A folder sharing another folder's conversations.** In a `--gemini_dir` folder
  whose `antigravity-cli/{conversations, brain, annotations, presence,
  conversation_summaries.db}`, `config/{GEMINI.md, AGENTS.md, config.json,
  mcp_config.json, rules, plugins, projects}` and `cache/last_conversations.json` were
  symlinks into `~/.gemini`:
  - the `/resume` picker listed conversations made in the other folder and in
    `~/.gemini`, `--conversation=<their id>` resumed them with history and title, and
    the resuming folder's own `hooks.json` ran;
  - every link survived many runs, `/clear`s and parallel runs, except
    `cache/last_conversations.json`, which became a plain file after the first run, so
    `-c` is per folder;
  - agy wrote its own plain files into the folder (`settings.json`,
    `cache/onboarding.json`, `history.jsonl`, `installation_id`,
    `jetski_state.pbtxt`, `implicit/`, `log/`, `cli.log`, `bin/`, `builtin/`,
    `config/.migrated`);
  - the summaries db's `-wal` and `-shm` sit beside the real file, not the link, and
    are folded back in at exit;
  - two folders running 5 turns each at once (a write and a `/clear` per turn): all
    turns done, no lock or corruption errors in the logs, `pragma integrity_check` ok
    on every db.
- **Links whose targets do not exist yet** (1.4.0, an owner with no `~/.gemini`): with
  none of the targets made, the first message fails ("create projects dir …: file
  exists", then "Failed to send message: no active conversation", `-p` too), agy logs
  `mkdir … file exists` for `conversations`, `brain` and `config/projects`, and
  replaces the `conversation_summaries.db` link with a plain file in the folder ("corrupt_on_open,
  recreating"); agy never creates `~/.gemini`. With the target folders
  `antigravity-cli/{conversations,brain,annotations,presence}` and
  `config/{projects,rules,plugins}` made beforehand and no files, everything works: the
  db is created through its link (WAL files beside the real file), `mcp_config.json`
  is created empty through its link, dangling `GEMINI.md`, `AGENTS.md`, `config.json`
  links log nothing, and every link survives. With only `conversations`, `brain` and
  `config/projects` made, turns run but no presence lock is taken and the title is not
  saved (`mkdir annotations: file exists`).
- **"Invalid Project" banner.** Every conversation's project id is
  `default-cli-project`, kept in `config/projects/default-cli-project.json`
  (`{"id":"default-cli-project","name":"CLI Project","projectResources":{}}`). A
  folder that never started a fresh conversation does not have that file (a resume
  never makes it), and resuming another folder's conversation there shows "⚠ Invalid
  Project ⎿ The project associated with this conversation is no longer valid. Use
  /fork to continue in a new project." The turn still works. It goes away once the
  folder has started one fresh conversation, or when `config/projects` is a symlink to
  `~/.gemini/config/projects`; copying `cache/default_project_id.txt` alone does not
  help. Two folders sharing `config/projects`, 3 turns and a `/new` each at once: the
  file and both links unchanged, no errors.

## §5 First run: sign-in, onboarding, trust

- Without `modelProvider`, a folder with no token shows "Welcome to the Antigravity
  CLI. You are currently not signed in." with "1. Google OAuth / 2. Use a Google Cloud
  project"; 7501 (§10) sends `blocked:kind=auth`, msg "Sign in required". A
  `GEMINI_API_KEY` is ignored without `modelProvider`.
- The Google sign-in order in a fresh folder: sign-in choice → URL and a "paste the
  authorization code" field → colour scheme ("Welcome to Antigravity CLI! Choose your
  color scheme") → Terms of Service & Data Use, with "Interactions data" ticked → "Do
  you trust the contents of this project?" → the prompt, the banner showing
  `<email> (Free)`.
- With `"modelProvider":"gemini"` and a key, the same minus sign-in. The colour and
  Terms screens send 7501 `blocked:kind=question`, msg "Finish setup"; Enter passes
  the colour screen, Down, Right, Enter picks [Done] on Terms. The trust screen ("> Yes,
  I trust this folder / No, exit") sends `blocked:kind=permission`, msg "Trust this
  folder?".
- Answers are saved as `cache/onboarding.json`
  (`{"consumerOnboardingComplete":true,"enterpriseOnboardingComplete":false,"onboardingComplete":true}`)
  and `settings.json` `"trustedWorkspaces":["<path>"]`. Without `onboarding.json`,
  agy writes an all-false one at start.
- What a folder needs before launch to skip the screens (API-key route):

  | Written before launch | First screen |
  |---|---|
  | `settings.json` `{modelProvider}`, with or without `trustedWorkspaces` | colour scheme |
  | `{modelProvider}` + `onboarding.json` | trust |
  | `{modelProvider, trustedWorkspaces}` + `onboarding.json` | the prompt |

  `onboarding.json` holding only `{"onboardingComplete":true}`, or only
  `{"consumerOnboardingComplete":true}`, is enough. On the Google route the token
  replaces `modelProvider` (§6).
- Trust is keyed by the folder path as given in `PWD`, not its real path: a symlinked
  folder is saved as the link path.
- `-p` needs neither onboarding nor trust, and records no trust.
- `/add-dir <dir>` prints "Added <dir> to workspace" with no trust question and does
  not add it to `trustedWorkspaces`.

## §6 Credentials

- Google sign-in sends the browser to `accounts.google.com/o/oauth2/auth` with PKCE
  and `redirect_uri=https://antigravity.google/oauth-callback`: no localhost callback,
  so pasting the code works from any machine. The TUI shows the URL and a paste field,
  and tries to open the browser (macOS: runs `open <url>` from `PATH`). While signing
  in on macOS agy listened on two 127.0.0.1 ports. Whether the callback page hands the
  code back by itself: not probed (needs real Google).
- After the code: `POST oauth2.googleapis.com/token`, then
  `www.googleapis.com/oauth2/v2/userinfo` and
  `daily-cloudcode-pa.googleapis.com/v1internal:{loadCodeAssist, fetchUserInfo,
  fetchAvailableModels, retrieveUserQuotaSummary, listExperiments,
  fetchAdminControls, setUserSettings}`.
- The token is `{"token":{access_token, token_type, refresh_token, expiry},
  "auth_method":"consumer", "id_token":…}`.
- **Linux**: kept in `<appDataDir>/antigravity-oauth-token`, mode 0600, whenever agy
  logs `Using file-based token storage because …`: `SSH session detected`
  (`SSH_CONNECTION`, `SSH_TTY` or `SSH_CLIENT` set; this wins over the next ones),
  `container environment detected`, or `no D-Bus session bus detected`. The binary
  also names WSL, Termux and a recent keyring timeout. A Linux desktop with a D-Bus
  keyring: not probed.
- **macOS**: kept in the login Keychain as **one item per macOS user**, service
  `gemini`, account `antigravity`, value `go-keyring-base64:` + the JSON above, whatever
  `--gemini_dir` says; no token file is written (log: `keyringAuth: loaded token`,
  `ChainedAuth: authenticated via keyring`). So a new folder opens already signed in
  as the last account, two folders send the same token, a running agy keeps its token
  in memory and, when it expires, refreshes it and writes it back over another
  folder's sign-in, and `/logout` in any folder deletes the item for every folder (no
  confirmation, no revoke request). `container=docker`, Termux or Android variables
  and an empty `DBUS_SESSION_BUS_ADDRESS` all still use the Keychain. §7 covers the
  variables that switch it to a file.
- `/logout` with file storage deletes that folder's token file only, sends no revoke
  request and returns to the sign-in screen. `-p /logout` exits 2.
- **Moving a sign-in.** Copying only `antigravity-oauth-token` into another folder
  under another home with the SSH variables set signed `-p` in there at once (one
  container, a second home standing in for a second machine). The TUI then still shows
  the colour, Terms and trust screens; with `cache/onboarding.json` and
  `trustedWorkspaces` copied too it opens on the prompt. When the copy's `expiry`
  passes, agy refreshes with the copied `refresh_token` and writes only the copy; it
  keeps the same `refresh_token` unless the server sends a new one, which it then
  saves. The original folder refreshing later with the same `refresh_token` also
  worked (fake server). Real Google (2026-10-18, agy 1.4.2, one Google AI Ultra
  account signed in on macOS, its token file copied to a Linux machine over SSH, both
  agy running): each side refreshed on its own when the hour ran out (both files then
  held a new `expiry`, an hour on), and both kept answering turns after it; the Mac
  account's `/usage` probe still read signed in.
- No token with `-p`: with stdin a terminal agy prints the URL, waits 60 s, then
  exits 1; with stdin a pipe it exits 1 at once with `Error: authentication required.
  Run 'agy' to log in, then retry.`
- **API-key route**: `settings.json` `"modelProvider":"gemini"` plus `GEMINI_API_KEY`
  (and optionally `GOOGLE_GEMINI_BASE_URL`). With `modelProvider` but no key, the TUI
  and `-p` print `modelProvider is set to "gemini" in settings.json, but the
  GEMINI_API_KEY environment variable is not set. …` and exit 1 before any 7501
  output.
- A rejected key (fake `400 API_KEY_INVALID`): `-p` exits 3 with `error: agent
  executor error: … API key not valid …` and an `AGY_ERROR:` line (§22) on stderr; the
  TUI starts normally and shows `⚠ agent executor error: … Error ID: …` at the first
  turn.
- `AGY_ADC_AUTH=1` uses `GOOGLE_APPLICATION_CREDENTIALS`; a missing or bad file only
  logs `adcAuth: failed …`, then `-p` says `authentication required` (exit 1). A
  working ADC: not probed.
- `GEMINI_API_KEY` and every other launch variable are visible to hooks (§12) and to
  commands the model runs (§25).

## §7 Storing the sign-in per folder on macOS

- (macOS) Any one of `SSH_CONNECTION`, `SSH_TTY` or `SSH_CLIENT` makes agy keep the
  token in `<gemini_dir>/antigravity-cli/antigravity-oauth-token` (0600) instead of
  the Keychain (log: `… because SSH session detected`); so does `WSL_DISTRO_NAME`
  (`… because WSL environment detected`). No flag in `--help` or `--helpfull` does.
- With it, two folders hold two sign-ins and run at the same time each with its own
  token; `/logout` in one deletes only that folder's file; the Keychain item is not
  touched.
- The variable must be set at every launch: a folder that has a token file, started
  without it, uses the Keychain item instead.
- `WSL_INTEROP` (any non-empty value) does the same (log: `… because WSL environment
  detected`), on 1.3.6 and 1.4.0. An empty value (`SSH_CONNECTION=`,
  `WSL_DISTRO_NAME=`) counts as not set.
- Where each variable is read (disassembly of both versions, then checked by running):
  the storage choice reads `SSH_TTY`, `SSH_CLIENT`, `SSH_CONNECTION`,
  `WSL_DISTRO_NAME`, `WSL_INTEROP`; sign-in reads the three SSH variables and, with any
  one set, does not open the browser (it shows the URL and the paste field only); copy
  reads `SSH_CONNECTION` only and with it skips `pbcopy` and sends only OSC 52, so the
  Mac clipboard is not changed; agy's terminal detection (`ssh=` in its log) reads the
  three SSH variables; usage reports to Google read all five (they then say "SSH" or
  "WSL"). With `WSL_DISTRO_NAME` or `WSL_INTEROP`, sign-in, copy, copy-on-select,
  image paste and the escape codes agy sends were the same as with no variable. The
  binary contains no `clip.exe`, `wslpath`, `powershell.exe` or `xclip`.
- Commands the model runs inherit the variable. Under each of the five, a model-run
  script doing git commit, push to a `file://` repo, `git credential fill` through a
  `GIT_CONFIG_COUNT` helper, `gh auth status`, `open https://…`, `pbcopy`/`pbpaste`,
  `ssh-add -l`, an `osascript` notification, node/npm, Python `webbrowser` and a
  request-file/reply-file script behaved exactly as with no variable (whole-output
  diffs differ only in the variable). No agy flag or setting strips variables from
  model commands.
- Storage choice and terminal detection read the variables once at start; the browser
  decision at every sign-in; copy at every copy.
- The Keychain item's value, decoded, is the token file's JSON: written unchanged to
  `<gemini_dir>/antigravity-cli/antigravity-oauth-token` and launched with
  `WSL_INTEROP`, agy used that account. With the variable set and no file, agy ignores
  the Keychain and asks to sign in.

## §8 Storage: the conversation list and transcripts

- **`antigravity-cli/conversation_summaries.db`** (SQLite, WAL) has one row per
  conversation: `conversation_id`, `title`, `preview`, `step_count`,
  `last_modified_time`, `last_user_input_time` (text datetimes), `workspace_uris` (a
  JSON list of `file://` URIs), `status`, `not_fully_idle`, `killed`, `source`,
  `project_id`, `app_data_dir`, `agent_name`, `parent_conversation_id`,
  `nesting_depth`, `group_id`, `raw_summary` (protobuf).
  - (1.4.0, `.schema`) Every column but `conversation_id` and `raw_summary` is `NOT
    NULL`; text columns default to `""`, so a top-level row's
    `parent_conversation_id` is `''`, never NULL. `last_modified_time` and
    `last_user_input_time` are text in UTC with `+00:00` whatever `TZ` says, with up
    to 9 decimals and trailing zeros dropped (`2026-10-16 08:04:16.1661826+00:00`);
    "never" is `0001-01-01 00:00:00+00:00`. A subagent row has `agent_name` `self`, a
    `''` title and `last_user_input_time` "never"; an unused `/new` row has
    `step_count` 0 and "never" times. The row appears at the first message
    (`RUNNING`, steps 0, both times "never") and gets its real values when the turn
    ends.
  - The row appears 0.4–0.6 s after Enter, with the made-up title. `/rename` updates
    `title`. A `/new` that is never used stays as a row with `step_count` 0.
  - `status` (`CASCADE_RUN_STATUS_IDLE` / `RUNNING`) does not tell whether a process
    is live: a finished `-p` leaves `IDLE`, opening the `/resume` picker sets every
    row not live to `""`, an open ask reads `RUNNING` with `not_fully_idle=1`, a
    background command `IDLE` with `not_fully_idle=1`.
  - Another process can read it, and a live conversation's db, mid-turn
    (`sqlite3 -readonly`, Node `node:sqlite` with `readOnly:true`).
  - A `-p` run's row has the run's cwd in `workspace_uris`.
- **`conversations/<id>.db`** (about 450 KB): tables `steps(idx, step_type, status,
  step_payload, …)`, `trajectory_meta`, `gen_metadata`, `executor_metadata`,
  `parent_references`, `trajectory_metadata_blob`, `battle_mode_infos`. Payloads are
  protobuf. Step types seen: 14 user input, 15 reply, 90, 101.
- **`brain/<id>/.system_generated/logs/transcript.jsonl`**, one line per step:
  `{step_index, source: USER_EXPLICIT|MODEL|SYSTEM, type: USER_INPUT|PLANNER_RESPONSE|GENERIC|CHECKPOINT|ERROR_MESSAGE,
  status: DONE|ERROR|INVALID|RUNNING, created_at, content, tool_calls:[{name,args}],
  input_tokens, output_tokens, cache_read_tokens, error}`.
  - The user's words are `USER_INPUT.content`, still wrapped as in §2; the reply is
    `PLANNER_RESPONSE.content`; tool results are `GENERIC.content`. Tokens are on
    `PLANNER_RESPONSE` lines.
  - `replace_file_content` results hold a unified diff:
    `[diff_block_start]\n@@ -1,5 +1,6 @@\n-l1\n+X1\n l3\n…[diff_block_end]`, with up to
    3 unchanged lines around the change, so added and removed lines can be counted.
    `write_to_file` gives only `Created file file:///<path> with requested content.…`,
    no counts, whether it creates, overwrites or appends.
  - `created_at` is UTC RFC 3339 in whole seconds (`2026-10-16T08:04:11Z`); times
    written inside `content` are local with an offset. A `PLANNER_RESPONSE` that
    ends a turn has `content` and no `tool_calls`. A subagent's transcript starts
    with a `SYSTEM_MESSAGE` step and has no `USER_INPUT`.
  - Tool args are JSON-encoded strings here (`"Overwrite":"true"`); in
    `transcript_full.jsonl`, the path hooks receive, they are typed
    (`"Overwrite":true`). Both are also kept in `logs/chunks/{transcript,
    transcript_full}/00000000.jsonl`.
  - `!cmd` (a shell command the user types) and slash commands other than `/compact`
    are not recorded.
- Other files under `brain/<id>/`: `.system_generated/steps/<stepIndex>/output.txt`
  (each command's output), `.system_generated/tasks/task-N.log` (background
  commands), empty `.user_uploaded/` and `scratch/`, and artifacts (§19).
- **When files appear.** A fresh launch writes nothing until the first prompt; then
  the `.db`, the presence lock (§9) and the transcript appear within 0.05 s of Enter.
  Any slash command, `/clear` and `/new` create the conversation at once.
- `cache/last_conversations.json` = `{"<cwd>":"<id>"}`, updated at the first prompt
  and on resume; it is what `-c` reads. `annotations/<id>.pbtxt` holds one line,
  `title:"…"`. `cache/conversation_metadata.json` is written when the `/resume` picker
  opens.
- Editing `annotations/<id>.pbtxt` with agy stopped: the next TUI's `/resume` showed
  the new title, but `conversation_summaries.db` kept the old one.
- `history.jsonl` logs typed prompts and slash commands:
  `{"display":"/model","timestamp":…,"workspace":"/home/u/proj","conversationId":"…","type":"slash_command"}`
  (prompts have no `type`). Messages sent through the local API (§16) are not logged.
- Every `-p` run leaves a conversation: 7–8 new files, about 460 KB (the
  conversation db, 4 transcripts, the pbtxt, an `implicit/<uuid>.pb`, the presence
  lock), plus changes to `last_conversations.json`, `onboarding.json`, the summaries
  db and `jetbox_summaries_proto.pb`. No flag avoids it.

## §9 Which conversation a process holds

- `presence/<id>.lock` (empty, 0600) is held with `flock` LOCK_EX by the process that
  has the conversation open (`/proc/locks`: `FLOCK ADVISORY WRITE`). The file stays
  after exit, unlocked, so a non-blocking `flock` try tells whether it is live. It
  holds no pid or path. Subagent conversations get none.
- (1.4.0) The holder keeps the lock file open: `lsof <lock>` (also through a symlinked
  folder, and when the holder is an agy using the default `~/.gemini`) lists the agy
  pid with a `W` lock; `lsof -t` exits 0 when held, 1 when free; `fuser` too. After
  `/exit` nothing holds it. The **second** process to open a conversation shows "⚠
  Conversation already open" but never opens or locks the file, not even after the
  first quits; so a held lock means a live agy has it, a free one does not prove none
  has. An outside process taking the lock (`flock -x`) made an agy opening that
  conversation show the same banner. macOS `lsof` flags: not probed.
- `/clear`, `/new`, in-TUI `/resume` and `/fork` keep the process and swap the lock:
  the old one is released and the new id's lock taken at once. `-c` and
  `--conversation` take the resumed id's lock at start, before any prompt.
- `ANTIGRAVITY_CONVERSATION_ID=<current id>` is in hook commands' and model commands'
  environment (a subagent's hooks get the child's id); not in `!cmd`.
- The status-line and title JSON `conversation_id` (§11):

  | Case | `conversation_id` |
  |---|---|
  | Fresh launch, before the first prompt | `""` |
  | `/clear`, `/new`, `/fork`, in-TUI `/resume` pick | the new id, at once |
  | While the `/resume` picker is open | briefly `""` |
  | `--conversation=<id>` or `-c` launch | that id, at once |
  | During and after a subagent | the parent's id |

## §10 Status: OSC 7501

- agy speaks the terminal "program status" protocol, OSC 7501, as Claude Code and Muse
  do. At start it writes `ESC ] 7501 ; ? BEL` and sends states only after the exact
  answer `ESC ] 7501 ; ? : states=idle,working,done,blocked,error :
  kinds=permission,question,auth ESC \`.
- `AGY_CLI_OSC7501=on`: no query, states sent without an answer. `=off`: no 7501
  output at all, even with the query answered. `1`, `0`, `true`, `false`, `force`
  behave like unset. `AGY_CLI_OSC7501_MESSAGES=brief` (measured on 1.4.0) replaces
  messages with fixed text: "Task complete", "Approve RunCommand" (no command),
  "Answer question", "Agent stopped with an error"; `0` and `false` change nothing.
- Frame: `ESC ] 7501 ; state=<state>[:kind=<kind>]:app=antigravity[:msg=<base64
  UTF-8>] BEL`.
- At start: with the variable unset and the query answered the first state is
  `idle`; with `=on` every
  launch first sends `blocked:kind=auth` "Sign in required", then `idle` about 10 ms
  later (API-key route, 1.3.6 and 1.4.0, Linux and macOS).

  | When | State | `msg` |
  |---|---|---|
  | Enter | `working` | none, or the conversation title (seen after a resume) |
  | Turn ends | `done` | the reply text; "Task complete" after `/compact` or a cancel (§16) |
  | First key after `done` | `idle` | — |
  | Command ask | `blocked:kind=permission` | "Approve RunCommand: <cmd…>", cut near 100 characters |
  | File create / edit ask | `blocked:kind=permission` | "Approve WriteToFile: Write: <path>", "Approve ReplaceFileContent: Write: <path>" |
  | Plan waiting for review (§19) | `blocked:kind=permission` | "Approve plan" |
  | Model question | `blocked:kind=question` | the question |
  | No sign-in | `blocked:kind=auth` | "Sign in required" |
  | Failed turn (§22) | `error` | the error text |
  | Ask declined with Esc or `4` | `idle`, no `done` | — |

- A turn agy starts by itself (a background command finished, a subagent reported
  back) sends `working` then `done`. `!cmd` sends no `working`. No OSC 9, OSC 777 or
  bare BEL was seen; no OSC 0/2 unless a title script is set (§11).

## §11 Status line and window title scripts

- `/statusline <path>` saves `"statusLine":{"type":"command","command":"<path>"}`.
  The title needs a hand-written `"title":{"type":"command","command":"<path>"}`;
  without it `/title on` says "No title command configured in settings.json. Please
  add a "title" block." Each works alone, and both run when both are set.
- (1.4.0) Both run under `sh -c` with agy's launch environment (PATH included). Two
  agy processes at once on one `--gemini_dir` (one `settings.json`), launched with
  different values of one variable: every run of each process's scripts saw only its
  own value. `session_id` always equals `conversation_id` (both `""` before the first
  message); there is no separate per-process id.
- Both scripts get the same JSON on stdin: `cwd`, `session_id`, `conversation_id`
  (§9), `transcript_path`, `model{id, display_name, effort}`,
  `workspace{current_dir, project_dir}`, `version`, `context_window{total_input_tokens,
  total_output_tokens, context_window_size, used_percentage, remaining_percentage,
  current_usage{input_tokens, output_tokens, cache_creation_input_tokens,
  cache_read_input_tokens}}`, `exceeds_200k_tokens`, `product:"antigravity"`,
  `agent_state`, `sandbox{enabled}`, `terminal_width`, `subagents` (once one ran),
  `conversation_title`, and `tool_confirmation_pending` (seen on macOS).
  - `agent_state`: `authenticating` (start), `idle`, `working`, `tool_use` (an ask is
    open), `reviewing` (an artifact is waiting for review, §19).
  - `conversation_title` is `null` until `/rename` or a resume pick, even after the
    summaries row has its made-up title.
  - `transcript_path` points to `<geminiDir>/antigravity/brain/…`, beside
    `antigravity-cli`, where no transcript is; the hooks' path is right (§12).
  - There is no cost key on the API-key route (1.3.6 and 1.4.0). In `context_window`,
    input = prompt − cached tokens, output = answer + thinking tokens;
    `context_window_size` is 1048576.
  - The first two inputs at launch (`authenticating`) carry `"model":null` (1.4.0).
- The scripts run at start and on each state change only: none in 25 s idle, 5 in a
  12 s turn.
- Status line: its stdout lines (several lines and ANSI colour work) replace agy's
  own line; with `"stack_with_default":true` agy's line (`? for shortcuts … Gemini 3.1
  Pro · low`) comes first and the script's lines below. A script exiting non-zero
  prints "⚠ Statusline Error ⎿ command failed: exit status 1 …" into the conversation
  area; ccstatusline exits 1 on the `"model":null` inputs ("Invalid status JSON
  format"), so it does this once per launch (1.4.0). ccstatusline also rewrites its
  `--config` file.
- Title: stdout goes out as `OSC 2;<text> BEL`, only when the text changed. Empty
  output, or a non-zero exit with no output, sends an empty `OSC 2`; `/exit` sends an
  empty `OSC 2`.

## §12 Hooks

- Files: `<geminiDir>/config/hooks.json` (run with cwd `<geminiDir>/config`) and
  `<workspace>/.agents/hooks.json` (cwd `<workspace>/.agents`), both, in no fixed
  order. No per-launch flag; `--gemini_dir` or `HOME` picks the user file.
- Format: `{"<hookName>": {"<Event>": […], "enabled"?: bool}}`. Plain events take a
  list of `{"type":"command"?, "command", "timeout"?}`; `PreToolUse` and
  `PostToolUse` take `[{"matcher":"*", "hooks":[…]}]`.
- Commands run under `sh -c` with agy's whole environment plus
  `ANTIGRAVITY_CONVERSATION_ID`; not `ANTIGRAVITY_LS_ADDRESS` or
  `ANTIGRAVITY_CSRF_TOKEN`.
- stdin is camelCase JSON: `conversationId`, `workspacePaths`, `transcriptPath` (→
  `transcript_full.jsonl`), `artifactDirectoryPath`, `modelName`
  (`gemini-3.1-pro-low`), plus per event:

  | Event | Fires | Extra fields |
  |---|---|---|
  | `SessionStart` | first prompt of a new conversation, after `/clear` or `/new`, and for each subagent; never on `-c`, `--conversation`, in-TUI `/resume` or `/fork` | none (no `source`, no parent id) |
  | `PreInvocation` / `PostInvocation` | around every model call | `invocationNum`, `initialNumSteps` |
  | `PreToolUse` | before the tool and before any ask | `toolCall{name, args}`, `stepIdx` |
  | `PostToolUse` | after the tool really ran (not when denied); for a background command, when it ends | `toolCall`, `stepIdx`, `error:""`; no output, no diff |
  | `Stop` | end of the agent loop | `executionNum`, `terminationReason` (`NO_TOOL_CALL`, `TERMINAL_CUSTOM_HOOK` after `/compact`, `ERROR`), `fullyIdle` (false while a subagent runs), `error` |

- `PermissionRequest`, `Notification`, `UserPromptSubmit` and `SessionEnd` are
  ignored and never fire. **No hook fires while agy waits for the user**; an ask shows
  only as `PreToolUse` just before it, the 7501 `blocked` frame (§10), `tool_use` in
  §11, and `RUNNING` in the summaries db. `ask_question` fires Pre/PostToolUse; `!cmd`
  fires nothing.
- When a subagent's `SessionStart` runs there is no summaries row yet for it (nor for
  a new parent), so nothing in the hook tells a child from a parent.
- `PreToolUse` stdout:
  - empty → normal;
  - `{}` → **deny** (the model reads `tool call denied by pre-tool hook: `; the screen
    still says "Edited 1 file");
  - `{"decision":"deny","reason":"<r>"}` → deny, the model reads `Encountered error in
    tool execution: tool call denied by pre-tool hook: <r>`; this holds under
    `--dangerously-skip-permissions` too, in the TUI and in `-p` (which still ends
    `SUCCESS`, exit 0);
  - text that is not JSON → the tool fails;
  - `{"decision":"allow"}`, with or without `permissionOverrides` → the ask still
    appears; `"ask"` → as if no answer; `"force_ask"` → an ask even for `view_file`,
    with a `Reason: <reason>` line.
- Adding words for the model:
  - `SessionStart` printing `{"injectSteps":[{"systemMessage":{"systemMessage":"…"}}]}`
    adds a user-role content after the first prompt: "The following is a
    <SYSTEM_MESSAGE> not actually sent by the user… injected by a SessionStart
    hook:\n…". It is stored once in the transcript and sent in every later request,
    also after a `--conversation` or `-c` resume and in a `/fork`. 300 KB arrived
    whole.
  - `PreInvocation` printing `{"injectSteps":[{"ephemeralMessage":"…"}]}` adds it as
    the last user content of that one request; copies do not pile up.
  - **What a `PreInvocation` hook can read of the model's earlier words.** 1.4.7 Linux
    arm64 in Docker, fake Gemini server answering text plus a `run_command` and then
    text, `-p` and two `-c -p` turns, `--dangerously-skip-permissions`, 2026-10-24:
    before every model call `transcript_full.jsonl` already holds every earlier step,
    the last call's `PLANNER_RESPONSE` too, so the words the model wrote beside a tool
    call are there before the call after that tool. That line reads
    `{"step_index":…,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","created_at":…,"input_tokens":…,"cache_read_tokens":…,"output_tokens":…,"content":"<text>","tool_calls":[…]}`,
    in that order, with no `{` before `content`. stdin also carries `lastUserInput`, the
    prompt as typed, unwrapped. After a tool call the ephemeral message reaches the
    model appended to that call's `functionResponse.output` after a blank line, not as a
    content of its own. A hook entry `/bin/sh <file>` runs under dash there (Debian
    12). Not run on the Mac build.
- **A `PreToolUse` hook gets about 30 s unless its entry sets `timeout` (seconds), and one
  that runs out DENIES the tool.** 1.4.2 Linux arm64 in Docker, fake model, `-p …
  --dangerously-skip-permissions --output-format json`, a hook that slept then exited 0
  printing nothing before a `run_command`, 2026-10-19: a 75 s sleep with no `timeout` and a
  20 s sleep with `"timeout": 5` were cut at ~30 s and ~5 s, the command did not run, and
  the model read `Encountered error in tool execution: JSON hook
  "jsonhook__wait_PreToolUse_0_0" failed: command failed: signal: killed` (`-p` still exit
  0). The hook's own `node` process lived on after that kill and wrote its "released"
  line later. A 130 s sleep with `"timeout": 3600` let the command run (130 s). No model
  request was made while a hook held. Not run on the Mac build (it would sign in through
  the owner's browser and keychain).

- **A `Stop` hook printing `{"decision":"block","reason":"<text>"}` (or `"decision":
  "continue"`) keeps the turn going with `<text>`.** 2026-10-20, agy 1.4.3 Linux arm64
  (manifest build, sha512 checked) in Docker, fake Gemini server, `-p "say hi"
  --dangerously-skip-permissions --output-format json`, the hook acting once: the server
  got one more request whose last user content was `<SYSTEM_MESSAGE>\nStop hook blocked
  termination: <text>\n</SYSTEM_MESSAGE>`; PreInvocation and PostInvocation fired again,
  then Stop again (`executionNum` 1, `terminationReason` `NO_TOOL_CALL`); `num_turns`
  stayed 1. The text is kept in the transcript. A hook that always blocks gets 10
  continuations; the 11th block is ignored. `injectSteps` from a `Stop` hook is dropped
  (`unknown field "injectSteps"` in agy's log). Not run in the TUI.

## §13 Tools

- The model gets 13 tools: `view_file`, `run_command`, `manage_task`,
  `send_message`, `schedule`, `invoke_subagent`, `define_subagent`,
  `manage_subagents`, `write_to_file`, `replace_file_content`, `read_url_content`,
  `search_web`, `ask_question`. Every one requires `toolSummary` and `toolAction`.
- `write_to_file {TargetFile (absolute), CodeContent, Overwrite, Description,
  ArtifactMetadata?}`; `replace_file_content {TargetFile, TargetContent,
  ReplacementContent, StartLine, EndLine, AllowMultiple, Instruction, Description}`;
  `run_command {CommandLine, Cwd, WaitMsBeforeAsync}`; `invoke_subagent
  {Subagents:[{TypeName:"self"|"research", Role, Prompt, Model?}]}` (no `TypeName`
  gives an INVALID step); `ask_question {questions:[{question, options[],
  is_multi_select}]}`, answered to the model as `A1: <option>`.
- A command that outlives `WaitMsBeforeAsync` returns "running as a background task
  with task id: <conv>/task-N … logs at file://…/brain/<id>/.system_generated/tasks/task-N.log".
  `manage_task` handles these background tasks; it is not a to-do list.
- A subagent is a child conversation: a summaries row with `parent_conversation_id`,
  `nesting_depth:1`, `agent_name:"self"`. Its result makes the parent run another
  turn.

## §14 Asks in the terminal and the keys that answer them

- File create: a diff, then "Allow creation of this file? > 1. Yes, allow creation 2.
  No, deny creation". File edit: "Accept this file edit? 1. Yes, accept this change 2.
  No, reject this change", with "shift+tab to auto-approve file edits". `1` applies;
  `2` rejects (file untouched, transcript ERROR "user denied permission for
  write_file(…)", "Interrupted", turn ends, 7501 `idle`).
- Command: "Run this command?" — 1. Yes, run command / 2. Yes, and always allow in
  this conversation (prefix) / 3. Yes, and always allow (Persist to settings.json) /
  4. No, cancel. Enter or `1` runs it. `4` declines ("User declined the tool call",
  transcript GENERIC ERROR "permission check failed for command … user denied
  permission"). Esc declines with no error step. Both show "Interrupted · What should
  Antigravity CLI do instead?", end the turn and send 7501 `idle` with no `done`.
- Question: "Question 1/1: <q>", the options plus "Write-in…". A digit picks that
  option at once; ↑/↓ then Enter picks too.

## §15 Typing into it

- A bracketed paste lands in the input box unsent; Enter sends it. Plain text then CR
  sends too.
- During a turn, paste plus Enter queues it ("▸ queued msg", footer "Press up to edit
  queued messages"); it runs right after the turn (`done`, then `working`).

## §16 The local Connect API

- agy runs a local server speaking Connect over HTTP/1.1: `POST
  http://localhost:<port>/exa.language_server_pb.LanguageServerService/<Method>`,
  `content-type: application/json`, header `x-codeium-csrf-token: <token>`, JSON body.
  Streams use `application/connect+json`, each message after a 5-byte length header.
  No token → `401 … missing CSRF token`, a wrong one → `… invalid CSRF token`.
- Launching with the hidden `--csrf_token=<value>` makes that value work. agy also
  makes its own random token, which it hands only to model commands
  (`ANTIGRAVITY_LS_ADDRESS`, `ANTIGRAVITY_CSRF_TOKEN`, §25); neither is in agy's own,
  a hook's or a title script's environment, or in any file.
- The port is random; agy listens on two localhost ports, one plain HTTP (the API) and
  one HTTPS ("Client sent an HTTP request to an HTTPS server"), told apart only by
  trying. Find them from the pid: `/proc/<pid>/fd` against `/proc/net/tcp` on Linux,
  `lsof -nP -a -p <pid> -iTCP -sTCP:LISTEN` on macOS, where both were listening within
  0.15 s of start. The same calls work on macOS (`GetStatus`,
  `SendUserCascadeMessage`).
- An idle TUI with no prompt sent (no conversation made) serves the API and renamed a
  stored conversation it did not hold: one process, about 263 MB resident, 13 threads, ~1.2% CPU.
  `-p` with `--csrf_token` serves it during its turn but leaves a conversation behind.
- `SendUserCascadeMessage {"cascadeId","items":[{"text":"…"}],"cascadeConfig":{…}}` →
  `200 {}`: the TUI shows the message and runs a full turn (7501 `working`, `done`;
  transcript `USER_INPUT`/`USER_EXPLICIT`). Sent during a turn it queues. Without
  `cascadeConfig` the turn fails: "failed to construct executor: plan model not
  specified" (7501 `error`). With only `{"plannerConfig":{"planModel":"MODEL_PLACEHOLDER_M36"}}`
  (the value is in `GetCascadeTrajectory`, first user step,
  `userInput.userConfig.plannerConfig.planModel`), `write_to_file` ran **with no ask**
  in default mode while `run_command` still asked; with the conversation's full
  `cascadeConfig` copied from that step, both asked.
- `GetCascadeTrajectory {"cascadeId"}` (~130 KB) returns every step; one waiting for
  the user has status `CORTEX_STEP_STATUS_WAITING` and `requestedInteraction`:
  - command: `{"permission":{"resource":{"action":"command","target":"<cmd>"},"persistSuggestionType":…,"suggestedPersistPattern":…,"triggerSource":{"type":"TYPE_DEFAULT_GRANT","detail":"command(*)"},"shellName":"bash"}}`;
  - file create / edit: `{"permission":{"resource":{"action":"write_file","target":"<path>"},"actionDescription":…,"triggerSource":{"type":"TYPE_DEFAULT_GRANT","detail":"write_file(/)"}}}`;
  - question (step `CORTEX_STEP_TYPE_ASK_QUESTION`):
    `{"askQuestion":{"questions":[{"question":"…","options":[{"id":"1","text":"Apple"},…]}]}}`.
  Steps also carry `metadata.modelUsage` (model, input, output, thinking, response,
  cache-read tokens) and the context estimate
  (`generatorMetadata[].chatModel.chatStartMetadata.contextWindowMetadata`).
- `HandleCascadeUserInteraction {"cascadeId","interaction":{"trajectoryId","stepIndex",…}}`:

  | `interaction` | Result |
  |---|---|
  | `"permission":{"allow":true}` | the ask closes, the command runs or the file is written, the turn goes on |
  | `"permission":{"allow":false}` on a command | not run |
  | `"permission":{"allow":false}` on a file | step ERROR, file untouched, the model goes on to `done` (key `2` ends the turn instead) |
  | `"runCommand":{"confirm":true,…}` | the ask closes but the command does **not** run |
  | `"askQuestion":{"responses":[{"question":"…","selectedOptionIds":["2"]}]}` | the model gets `A1: Banana` |
  | `"askQuestion":{"cancelled":true}` | the question closes |
  | a step not waiting | `500 "input not registered for step <n>"` |

  The TUI shows "Answered from another device."
- `UpdateConversationAnnotations {"cascadeId","annotations":{"title":"…"},"mergeAnnotations":true}`
  renames: the summaries `title`, the pbtxt and `/resume` change at once, also when
  sent to an idle agy for a conversation another process or nobody holds. A running
  agy in another process keeps the old `conversation_title` for its own scripts.
  `-p "/rename x"` is refused (exit 2, "print mode has no conversation manager").
- `StreamAgentStateUpdates {"conversationId"}` (stream): a full snapshot, then an
  update per step: `status`/`executorLoopStatus` (`CASCADE_RUN_STATUS_IDLE`,
  `RUNNING`, `CANCELING`), `mainTrajectoryUpdate.stepsUpdate` (new steps whole,
  waiting asks included), `fullyIdle`, `turnsUpdate`, `activeHook`.
- `CancelCascadeInvocation {cascadeId}` stops the turn: screen "⎿ Interrupted · What
  should Antigravity CLI do instead?", 7501 `done` "Task complete" then `idle`, only
  the `USER_INPUT` line in the transcript.
- `WaitForConversationFullyIdle {conversationId}` (`cascadeId` gives 400) returns when
  the turn ends.
- `ForkConversation` (§18). `GetConversationMetadata` gives workspaces, `createdAt`,
  `rootConversationId`, `numSteps`. `GetArtifactSnapshots` (§19).
- `GetAllCascadeTrajectories` lists only conversations the answering process has
  loaded (4 of 8 rows), not the stored list.
- `GetSlashCommands` (needs the full `cascadeConfig`) lists only the commands the
  model sees: goal, compact, schedule, browser, plan, grill-me, learn,
  agy-customizations, antigravity-guide. No method returns a slash command's screen
  output. On the API-key route `RetrieveUserQuotaSummary` → `{"response":{}}`,
  `GetUserStatus` → `{"userStatus":{}}`, `GetModelStatuses` → `{}`;
  `GetAvailableModels` and `GetCascadeModelConfigData` list models without prices;
  `GetCommandModelConfigs` and `GetUserSettings` → 501; `SendAllQueuedMessages` →
  500 `deprecated`.
- The method list (347 names) is the same in 1.3.6 and 1.4.0.

## §17 Compaction

- `/compact` runs as a turn: a `USER_INPUT` step `/compact` at the start, one model
  call, then a step `{"source":"SYSTEM","type":"CHECKPOINT","content":"# Resuming from a
  compaction\n…"}` at the end. Screen: "Compacting conversation… (1s · esc to
  cancel)", then "N steps summarized · context 100 → ~17.0k (10 summary) · took 6s".
  7501 `working`, then `done` "Task complete"; `agent_state` stays `working`. Hooks:
  `PreInvocation`, then `Stop` with `TERMINAL_CUSTOM_HOOK`; no `SessionStart`.
- Automatic compaction starts from agy's own token estimate (status line
  `total_input_tokens`) passing `checkpointConfig.maxTokenLimit` (256000); a large
  `promptTokenCount` from the model did nothing. The screen shows only "Working...";
  7501, hooks and `Stop` (`NO_TOOL_CALL`) look like a normal turn; the transcript gets
  `USER_INPUT`, `CHECKPOINT`, `PLANNER_RESPONSE`.
- The only live sign of either: in `StreamAgentStateUpdates`, `activeHook
  {HOOK_TYPE_PRE_INVOCATION, hookName:"context_summary"}` stays on for the whole
  compaction (seconds); on a normal turn it lasts under 1 ms. `GetCascadeTrajectory`
  has no compaction field.
- `AGY_CLI_AUTO_COMPACT_OVERRIDE` with `zzz`, `1000`, `1k`, `1%`, `5000`, `50%`
  changed nothing. `settings.json` `contextWindow` `"200k"` or `200000` is kept but
  changes neither limit.

## §18 Fork

- `/fork` in the TUI prints "Forked conversation. To go back, use: /resume <old
  id>": a new id in the same process, the lock and `conversation_id` follow at once
  (§9), no hook fires. The new summaries row has an empty title, no
  `parent_conversation_id`, the full step count, and no pbtxt; its `transcript.jsonl`
  holds only the steps written after the fork.
- `ForkConversation {"sourceCascadeId","forkAtStepIndex"}` → `{newCascadeId,
  forkedAtStepIndex, newProjectId}`; the title is copied, no parent id, the TUI stays
  where it was. Forking at a user-message step (0) is refused.

## §19 Artifacts and plan approval

- `write_to_file` with `ArtifactMetadata` makes `brain/<id>/<name>.md` and
  `<name>.md.metadata.json` (`{summary, updatedAt, userFacing[, requestFeedback]}`).
  The footer shows "1 artifact · /artifact to review" and `agent_state` becomes
  `reviewing`. `GetArtifactSnapshots {cascadeId}` returns each one's name, URI,
  metadata and content.
- With `RequestFeedback: true` (`implementation_plan.md`) the turn ends normally but
  the last 7501 frame is `blocked:kind=permission` "Approve plan" (no `done`). It is
  not a waiting step: no `requestedInteraction`, and no API method reviews it.
  `/artifact` shows "Action required (1 left)" with keys `y` approve, `n` reject,
  shift+a approve all, `p` preview, Esc; `y` sends a new user turn "[Approved]
  implementation_plan.md", `n` "[Rejected] …". Any new message, also one sent with
  `SendUserCascadeMessage`, clears the review state.
- `/plan` goes to the model as text. Plan mode is a separate switch (`--mode plan`,
  Agent Mode in `/config`).

## §20 Headless: `-p`

- Exit codes: 0 success, a `--print-timeout` expiry, or a tool denied by the
  permission rules; 1 start-up failures (sign-in, bad model or effort, bad
  `--json-schema`, bad stream input, no API key); 2 usage errors, `-p` with `-i`, a
  CLI-only command in stream input; 3 a model or agent error, with an `AGY_ERROR:`
  line (§22).
- `--output-format json`: `{conversation_id, status:"SUCCESS"|"ERROR", response,
  duration_seconds, num_turns, usage{input_tokens, output_tokens, thinking_tokens,
  cache_read_tokens, total_tokens}}`, plus `error`, `denied_actions[{action,
  display_name}]`, `json_schema`, `structured_output`, `command` when they apply.
- `--output-format stream-json`: `{"event":"init","conversation_id","init":{cwd,
  tools[], permission_mode, json_schema?}}`; `{"event":"step_update","step_update":{conversation_id,
  step_index, state:"ACTIVE"|"DONE"|"ERROR", step_type
  (user_input|agent_response|tool|finish|error_message), text_delta?, tool_name?,
  tool_info{name, parameters, error?}?, duration_seconds?, usage?}}`; a last
  `{"event":"result","result":{…as json…}}`; a slash command sends
  `{"event":"command_result","command":{name, data}}` first.
- Stdin: piped stdin without `-p` is the prompt. `--input-format stream-json` (with
  `--output-format stream-json`, no `-p`) reads lines
  `{"event":"user","message":{"role":"user","content":"…"}}`, one `result` per turn,
  all in one conversation; other events are skipped with a warning.
- `--conversation <id>` and `-c` continue that conversation.
- A tool the rules deny (`view_file` outside the workspace) is listed in
  `denied_actions` with a stderr hint ("Add an allow-rule under permissions.allow …
  or --dangerously-skip-permissions"), exit 0.
- `--print-timeout 2s` on a slow turn: stderr `[agy] print timeout after 2s with turn
  in progress; returning partial output`, `SUCCESS`, empty response, exit 0.
- `--json-schema` (inline or a file; root `"type":"object"`; needs json or
  stream-json output) is not sent as `responseSchema`: agy adds a `finish` tool with
  the schema's fields. A `finish` call fills `structured_output`; without one agy
  nudges the model up to 3 times, then returns `SUCCESS` with the texts joined and no
  `structured_output`.
- A trivial run takes about 100–200 ms against a fast fake with the updater off; the
  first launch in a fresh folder about 760 ms.

## §21 Models and effort

- API-key route: `agy models` prints 11 `id\tlabel` rows with no network call:
  `gemini-3.8-flash-{high,medium,low}`, `gemini-3.7-flash-…`, `gemini-3.6-flash-…`,
  `gemini-3.1-pro-{high,low}`. The default is `gemini-3.1-pro-low`, requested as
  `gemini-3.1-pro-preview`, shown "Gemini 3.1 Pro (Low)". `agy models
  --output-format json` exits 1.
- `--model` takes an id with effort (`gemini-3.8-flash-high` → URL
  `gemini-3.8-flash`) or a base name (`gemini-3.1-pro`); an unknown name exits 1 and
  lists the models.
- `--effort low|medium|high|xhigh|max`, but each model allows fewer (3.1 Pro: low and
  high; `xhigh` exits 1). It becomes `thinkingBudget`: low 1024 (Pro) / 1000 (Flash),
  high −1.
- On the Google route the list comes from `fetchAvailableModels`; an empty answer
  gives `no model configuration is available for this account`, and the real shape
  is not probed.
- `/model`, Down, Esc leaves the model unchanged.

## §22 Errors and retries

| Model server answer | Retries | 7501 | Screen |
|---|---|---|---|
| 500 | none | `error` ~0.12 s after `working` | `⚠ agent executor error: … Error 500 … Error ID: …`, then a survey `[1] Good [2] Fine [3] Bad [0] Skip` |
| Broken stream | none | `error` ~0.11 s after `working` | the parse error |
| 429 | 8 tries (gaps 4–27 s) | `working` throughout ("Loading..."), `error` at ~140 s | the 429 text |
| Stream cut off | 9 tries | `working`, `error` at ~152 s | "There was a network issue connecting to the server, please try again." |

- `Stop` hook: `terminationReason:"ERROR"`, `error:"generating and executing: …"`.
  The stream ends IDLE with `EXECUTOR_TERMINATION_REASON_ERROR`, after one
  `CORTEX_STEP_TYPE_ERROR_MESSAGE` step per try.
- Transcript: 500 and broken streams leave only a gap in step numbers; each retried
  try writes an `ERROR_MESSAGE` line, `error:"API error (attempt N): …"`.
- `-p`: exit 3, `status:"ERROR"` with `error`, and on stderr `AGY_ERROR:
  {"short_error","status","error_code","code_kind","retryable","error_id"}`.

## §23 Slash commands and their output

- TUI slash commands (`/model`, `/usage`, `/help`, `/config`, …) are not in the
  transcript; they are logged in `history.jsonl` (§8). Their output exists only on
  screen: `/usage` "Models & Quota" ("Loading quota summary..." keeps spinning on the
  API-key route); `/model` a picker with an effort slider; `/help` the version, the
  sign-in kind ("Gemini API key"), workspace, project config path, log path,
  conversation id. Esc closes `/usage` quietly and prints "⎿ Exited /<cmd> command"
  for `/model`, `/help`, `/config`; 7501 does not change.
- `-p` runs these without a model call or a conversation (output as text, or as
  `command.data` in json): `/help` (`commands[]`), `/config` (`config{…}`, 33 keys:
  agentMode, allowNonWorkspaceAccess, altScreenMode, artifactReviewPolicy,
  clearScrollbackOnResize, colorScheme, contextWindow, copyOnSelect,
  customModelsConfig, disableSlashCommands, editor, editorMode,
  enableTerminalSandbox, gcp, hideActiveItems, historySize, model, modelProvider,
  notifications, permissions, pickerGrouping, queuedMessages, runningLightSpeed,
  sandboxProxy, showFeedbackSurvey, showTips, statusLine, title, toolPermission,
  trustedWorkspaces, useG1Credits, useTerminalCursor, verbosity, vimInsertFirst),
  `/model` (`{id, label, effort, is_default}`), `/effort` (`{adjustable, current,
  available[]}`), `/credits` (`{remaining_credits}`), `/hooks`, `/permissions`
  (`scope: project|shared|global`), `/skills`, and `/usage` = `/quota`. `-p /login`
  goes to the model as text; `-p /logout` and `-p /rename` exit 2.
- `/usage` on the Google route reads `retrieveUserQuotaSummary {"project":…}` and
  prints `{description, groups[{name, description, buckets[{id, name, description,
  remaining_fraction, reset_time}]}]}` (text: `group\tbucket\t42%\t<UTC reset>`).
  Measured against a server answer made up from the binary's field names (the real
  message also has `remainingAmount`, `window`, `disabled`); on the API-key route
  `{groups:[]}`.
- `/usage` on a real Google account on the Google AI Ultra plan (2026-10-18, agy 1.4.2,
  macOS, a fresh sign-in): two groups, "Gemini Models" and "Claude and GPT models", each with buckets
  `{id, name, window, remaining_fraction, reset_time}`: `gemini-weekly` /
  `3p-weekly` named "Weekly Limit Remaining", `window:"weekly"`, and `gemini-5h` /
  `3p-5h` named "Five Hour Limit Remaining", `window:"5h"`; `remaining_fraction` 1
  (what is left, not what is used), `reset_time` an ISO UTC time (7 days and 5 hours
  after the sign-in). No `description`, `remainingAmount` or `disabled` on a bucket.
- Desktop-app conversations in `<geminiDir>/antigravity/conversations` show only in
  the `/resume` picker's "Other" tab (also through a symlinked folder), titled by
  their first message; Enter asks "Import this conversation? (y/n)". A real desktop
  db was not tried (a copied CLI db failed to import).

## §24 One conversation in two processes

- The second process to open a conversation (two folders sharing the store, §4, or
  the user's own agy) shows "⚠ Conversation already open ⎿ When you opened this
  conversation it was already open in another CLI instance on this machine. Sending
  messages from both may cause conflicts. Use /fork to continue here separately." The
  first gets no sign: no screen change, no 7501, no hook, no stream message. Only the
  first holds the presence lock (§9).
- Both can run turns, but the transcript gets duplicate step numbers and the
  conversation db keeps only the last writer's steps: the other side's turns are lost
  (`step_count` went 5 → 4). `pragma integrity_check` stays ok and nothing is logged.
  While the second side runs a turn, the summaries row's `step_count` and
  `last_modified_time` change.

## §25 Shell commands the model runs

- `run_command` runs as a child of agy: `bash -c <cmd>` on Linux, `$SHELL -c` on
  macOS (`zsh -c` there).
- `PATH` is agy's own with `<geminiDir>/antigravity-cli/bin` put first, so a folder
  prepended at launch comes second (Linux and macOS). The launch environment is kept
  (`TMPDIR` and any added variable), plus `TERM=dumb`, `PAGER=cat`, `GIT_PAGER=cat`,
  `GIT_EDITOR=false`, `HGEDITOR`, `JJ_EDITOR`, `JJ_PAGER`, `ANTIGRAVITY_AGENT=1`,
  `ANTIGRAVITY_CONVERSATION_ID`, `ANTIGRAVITY_TRAJECTORY_ID`,
  `ANTIGRAVITY_PROJECT_ID`, `ANTIGRAVITY_SOURCE_METADATA` (JSON with
  `conversationId`, `stepIndex`, `toolCall`), `ANTIGRAVITY_LS_ADDRESS=localhost:<port>`,
  `ANTIGRAVITY_CSRF_TOKEN`, `ANTIGRAVITY_APP_DATA_DIR`, `ANTIGRAVITY_AGENTAPI_EXE`.
- `!cmd` runs `/bin/bash -c` with the TUI's own environment: `PATH` unchanged, no
  `ANTIGRAVITY_*`.
- Without `--sandbox`, commands could write `/tmp`, `$TMPDIR`, the workspace and the
  home folder, run scripts anywhere, and reach unix sockets and 127.0.0.1 (macOS; on
  Linux, writing outside the workspace and reaching 127.0.0.1 were checked).
- `--sandbox` on macOS (seatbelt, `/usr/bin/sandbox-exec` with a built-in `(deny
  default)` profile): writes to `/tmp` and `$TMPDIR` work, reading workspace files
  works; writing the workspace or the home folder, reading outside the workspace,
  running a script outside the workspace (exit 126), `/bin/ps`, unix sockets and
  127.0.0.1 TCP are all refused. The model is told it can ask again with
  `BypassSandbox`.
- `--sandbox` in Docker: every command failed (`fork/exec /usr/local/bin/agy:
  operation not permitted`, or with a privileged container `connecting to sandbox
  server: … connection reset by peer`). A Linux machine outside Docker: not probed.

## §26 Approval modes

- Default: file writes and commands ask. `--mode accept-edits`: writes are approved
  ("Accept-edits mode: file edits auto-approved"), commands still ask. `--mode plan`:
  banner "Plan mode: research & plan only", prompts sent as `/plan …`; the fake
  model's write and command still asked and ran once approved. `--mode auto`: no
  banner and both still asked on the API-key route.
  `--dangerously-skip-permissions`: no asks, also with `--sandbox`.
- (1.4.2, build `1.4.2-4835981233356800`, Linux arm64, Docker, fake Gemini server,
  tmux, 2026-10-18) `--dangerously-skip-permissions` alone, with no
  `allowNonWorkspaceAccess` key, asked nothing: a file created and edited under
  `$HOME` outside the workspace, `/etc/hostname` read, and `run_command` all ran, and
  no banner showed. Without it, an outside write asks with "Reason: outside workspace"
  and a second option "Yes, and always allow non-workspace access" (which writes
  `"allowNonWorkspaceAccess": true`); an outside read asks "Allow access to this
  file?". `/tmp` counts as inside: writing and reading there asked nothing.
- (1.4.2, same setup) `/config` rows and what they write to `settings.json`; picking
  the default removes the key. Agent Mode `default` / `accept-edits` / `plan`
  (`agentMode`; no `auto` in the list). Tool Permission `request-review` (default) /
  `proceed-in-sandbox` / `always-proceed` / `strict` (`toolPermission`).
  Non-Workspace Access off / on (`allowNonWorkspaceAccess: true`). Sandbox Mode
  (`enableTerminalSandbox: true`). Artifact Review (`artifactReviewPolicy`).
  `toolPermission: "always-proceed"` alone, without the flag, also asked nothing, for
  file writes outside the workspace too.
- (1.4.2, same setup) `"agentMode": "auto"` in `settings.json` or `--mode auto` on the
  API-key route: no banner, no warning, every ask as in default; the log says `auto
  mode is unavailable, falling back to default`.

## §27 Terminal modes

- At start agy asks `CSI >q` (XTVERSION), DA1, DECRQM 2026/2027 and `OSC 11;?`. It
  turns on `?2004h` (bracketed paste), `>4;2m` (modifyOtherKeys), a kitty keyboard
  push `>1u` plus a `?u` query, `?2026` synchronized output around every frame,
  `?2027h`, and `0 q`; on exit `>4m`, `<1u`, `?2004l`, `0 q`, `?2027l`. No mouse modes
  (1000/1002/1003/1006) and no focus events (1004) in the default inline mode.
- With XTVERSION unanswered there is a brief `?1049h … ?1049l` alternate-screen flash
  at start and a second kitty push; answered (`xterm.js(5.5.0)`), neither.
- Rendering Mode in `/config`: "native terminal (inline)" (the default) or "no
  flickering (altscreen)", which writes `"altScreenMode": "always"`; picking inline
  removes the key (macOS 1.4.2, the owner's account folder after picking it, and
  Linux 1.4.2 in Docker, 2026-10-18). The switch takes effect at once.
- (Linux 1.4.2, Docker, tmux 120×40, 2026-10-18) `"altScreenMode": "always"` written
  by hand before launch starts agy in the alternate screen (`?1049h`) with mouse modes
  `?1002h` and `?1006h` (not 1000 or 1003); agy keeps the key when it rewrites the
  file. On a fresh conversation the prompt box sits right under the banner and
  reaches the bottom rows once the transcript fills the screen. On exit the screen
  holds only the "Resume with -c" lines.

## §28 Telemetry

- On every route and with every opt-out tried agy tried to reach
  `play.googleapis.com/log` (Clearcut; 2 POSTs per `-p` run, with the Bearer token
  when signed in) and `antigravity-unleash.goog/api/client/{register, features,
  metrics}` (feature flags, at start and every 60 s). Offline it only logs an error.
- `UNLEASH_URL=<other url>` stops all `antigravity-unleash.goog` requests. Nothing
  found stops `play.googleapis.com`: not `enableTelemetry` in `settings.json`
  (dropped on rewrite), `showFeedbackSurvey:false`, `config/config.json
  {"telemetryEnabled":false}`, or the `/config` "Enable Telemetry" toggle (shows `off`
  by default, writes nothing on the API-key route).
- The onboarding "Interactions data" box is an account setting: Done sends `POST
  …/v1internal:setUserSettings` with `{"userSettings":{"telemetryEnabled":true}}`, or
  `{}` when unticked. Nothing is saved locally; on the API-key route it leaves no trace.

## §29 tmux and SSH

- Inside tmux 3.3a no 7501 reaches the outer terminal, also with
  `AGY_CLI_OSC7501=on` and `allow-passthrough on`. With `=on` agy still writes the
  frames into the pane, where `tmux pipe-pane` captures them; without it the pane gets
  none.
- In tmux the TUI works (sign-in, onboarding, prompts), the status-line script
  renders, hooks run, and the title reaches `#{pane_title}` (with `set-titles on`
  tmux sends OSC 0 out).
- Over SSH: the SSH variables switch the token to a file (§6, §7) and sign-in works by
  pasting the code, with no browser on that machine.
- (1.4.0, a Koloft-style tab: real OpenSSH 10.3p1 into a Debian 12 sshd container,
  tmux 3.3a, Node 22.12.0 at `~/.koloft/node`, the fake Gemini server on that machine)
  A `--gemini_dir` folder holding `settings.json` (`modelProvider`, `trustedWorkspaces`
  with the folder, a `title` command) and `cache/onboarding.json`, with
  `GEMINI_API_KEY` from a sourced env file, opens straight on the prompt. agy rewrites
  `settings.json` in its own form and keeps the `title` block.
- Inside that tab `SSH_CONNECTION`, `SSH_TTY` and `SSH_CLIENT` reach agy; its log says
  "Using file-based token storage because SSH session detected". A non-tty `ssh host
  cmd` gives "no D-Bus session bus detected" instead — a token file either way.
- The title script and the hooks inherit the launch environment (`KOLOFT_TAB_ID`,
  `TMUX`, `TMUX_PANE`); the title script runs in the workspace, the hooks in
  `<gemini_dir>/config`. `tmux rename-session -t "$TMUX_PANE" k-<id>` from the title
  script works at the first prompt and after `/clear`.
- Over one prompt the order is: title `authenticating` twice and `idle` twice (no id),
  hook SessionStart, PreInvocation, Stop, then the first title line carrying the
  conversation id. A turn of about 50 ms never shows the title `working` state; a 4 s
  one does. An ask: PreToolUse (the whole `toolCall`), then title `tool_use` with
  `tool_confirmation_pending:true`; after `1`: title `working`, PostToolUse,
  PreInvocation, Stop, `idle`.
- Keys typed into the Mac side of `ssh -tt` answer a command ask (`1`) and a question
  (`2` picked option 2); so does `tmux send-keys`.
- `node --no-warnings --experimental-sqlite` (22.12.0) run over ssh reads the shared
  `conversation_summaries.db` read-only while agy is idle, waits on an ask, or is
  mid-turn; `workspace_uris` hold the remote folder.
- `--conversation=<id>` in a tmux session named `k-<id>` shows the history; its first
  title line already carries the id. Two tabs in one account folder hold their own
  `presence/<id>.lock` (FLOCK WRITE in `/proc/locks`); `flock -n <lock> true` exits 1
  while a conversation is open and 0 once it is free.
- `/exit` ends the tmux session and `ssh -tt` returns 0; no hook fires at exit. A
  dropped ssh client leaves tmux detached with agy running and the lock held;
  `tmux attach -d -t k-<id>` over a new `ssh -tt` redraws it and keys work.
- No OSC 7501 and no OSC 0/2 reach the Mac side through tmux (`set-titles` off); the
  title script's output lands in `#{pane_title}`.
- `rsync -a -m --inplace --delete` with includes `/*/`, `/*/.system_generated/`,
  `/*/.system_generated/logs/` and `/*/.system_generated/logs/transcript.jsonl` pulls
  just the per-conversation transcripts out of `brain/`.
- A copied token file in a folder without `modelProvider`, run over ssh: agy loads it
  ("authenticated via keyring") and calls Google with it. What Google does with one
  `refresh_token` used from two machines: not probed (no real account).
- The slim lab image has no `jq`, `python`, `xz` or `gawk`: scripts that run there are
  `sh` with `sed` and `printf`.

## §30 MCP servers, everywhere and in one project

2026-10-23, agy 1.3.6, Docker, `agy --gemini_dir=<dir> mcp add …`, then `agy -p` against a
fake Gemini server with MCP servers that logged their start.

- **`agy mcp add`** (no scope flag) writes only `<geminiDir>/config/mcp_config.json`:
  `{"mcpServers":{"<name>":{"command","args":[…],"env":{…},"disabled":false}}}` (an HTTP
  one has `serverUrl` and `headers`); `agy mcp disable` sets `"disabled": true`. `agy mcp
  list` shows only that file.
- **One project:** `<workspace>/.agents/mcp_config.json` (same shape) and
  `<workspace>/.agents/plugins/<p>/mcp_config.json` (named `<p>_<server>`) were loaded in
  folder A and not in folder B; `<A>/.gemini/mcp_config.json`, `<A>/.gemini/settings.json`
  and `<A>/.mcp.json` were not. In `-p` this held with A out of `trustedWorkspaces`.

Koloft dependents: `koloft todo`'s list of MCP servers (`src/main/mcpServers.ts`).
