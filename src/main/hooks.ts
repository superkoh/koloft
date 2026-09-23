import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import type { StatusLineSetting } from './statusline'
import { shq } from '@shared/shellQuote'

export interface HookPaths {
  /** the shared SessionStart hook script (tabId is passed as an arg, not via env) */
  hookScript: string
  /** dir where per-tab `--settings` files are written */
  settingsDir: string
  /** dir the hook drops {tabId, sessionId, transcriptPath} reports into */
  regDir: string
}

/**
 * A SessionStart hook Koloft injects (via `claude --settings`) into every claude it
 * launches. It fires on startup AND on in-TUI `/resume` / `/clear` — exactly the
 * moments the shim can't observe — and records the *authoritative* tab→session
 * binding. Koloft reads that instead of guessing by jsonl mtime, so multiple tabs in
 * the same cwd never cross-bind.
 *
 * tabId and regDir are baked into the command args by Koloft (see writeTabHookSettings),
 * so the hook never depends on env-var propagation, which Claude Code does not
 * reliably pass through to hook processes.
 */
export const HOOK_SCRIPT = `#!/usr/bin/env bash
# args (baked in by Koloft): $1 = registration dir, $2 = tabId,
#   $3 = event:  start|end          -> binding report  (-> $tab.json)
#                prompt|stop|notify  -> run-state report (-> $tab.status.json)
#                posttool            -> statusline git-review cache invalidation
reg="$1"; tab="$2"; event="$3"
[ -z "$reg" ] && exit 0
[ -z "$tab" ] && exit 0
input="$(cat | tr -d '\\n')"
mkdir -p "$reg" 2>/dev/null
# The tmux session this claude lives in — a remote session Koloft started over ssh
# (launch.ts tabScript sets the flag); empty for a local claude. Koloft matches a
# report to a tab by this name rather than by \\$tab: the tab id is baked into the
# settings when claude starts, and a Koloft that was quit and reopened re-attaches
# under a NEW tab id. Read BEFORE the start branch renames the session below, because
# after a /clear the name Koloft knows is still the old one.
tm=""
if [ "$KOLOFT_TMUX_FOLLOW" = "1" ] && [ -n "$TMUX" ]; then
  tm="$(tmux display-message -p -t "$TMUX_PANE" '#S' 2>/dev/null | tr -d '"\\\\[:cntrl:]')"
fi
# WHOSE session this report is about. Koloft compares it against the session the tab is
# currently driving and drops the report when they disagree (src/main/hookRouting.ts) —
# that is what keeps a \`/fork\`ed background copy, which inherits this very hook, from
# speaking for the tab it was forked from. Three properties the comparison depends on:
#  - ONE extraction, used by both the binding branch and the run-state branch. Two
#    copies that drift would compare differently-parsed strings: binding keeps working
#    while every prompt/stop/notify is dropped as "not mine", with nothing failing.
#  - the FIRST match, not the last. A greedy \`.*"session_id"\` sed takes the LAST
#    occurrence in the flattened payload, i.e. a nested object's — and Stop payloads
#    already nest objects (background_tasks). A foreign id here silently discards a real
#    turn transition: the dot pins 'working' and no turn-done is ever raised.
#  - scrubbed like every other free-form field: \`[^"]*\` captures backslashes and control
#    chars, and one of those makes the emitted JSON line unparseable — the reader skips
#    torn lines without a word.
session_id() {
  printf '%s' "$input" |
    grep -o '"session_id"[[:space:]]*:[[:space:]]*"[^"]*"' |
    head -1 |
    sed 's/.*"\\([^"]*\\)"$/\\1/' |
    tr -d '"\\\\[:cntrl:]'
}
case "$event" in
  start|end)
    sid="$(session_id)"
    tp="$(printf '%s' "$input" | sed -n 's/.*"transcript_path"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p')"
    # cwd is the session's real working dir — the worktree path for a --worktree session,
    # available here at SessionStart before claude has written any jsonl
    cwd="$(printf '%s' "$input" | sed -n 's/.*"cwd"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p')"
    # SessionEnd carries a reason (prompt_input_exit|logout|clear|other); lets Koloft tell a
    # real exit (revert the tab to a shell) from a /clear (which re-inits the session)
    reason="$(printf '%s' "$input" | sed -n 's/.*"reason"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p')"
    # SessionStart's source tells a real (re)start from an auto-compaction restart
    # ('compact' fires MID-TURN and must not reseed the run-state to 'waiting')
    src="$(printf '%s' "$input" | sed -n 's/.*"source"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p')"
    # A \`/fork\`ed copy inherits this hook, so its own SessionStart would land in the
    # parent tab's binding snapshot. Never write it: Koloft discards a fork's start anyway
    # (src/main/hookRouting.ts), and this file is a last-writer-wins snapshot with no
    # re-delivery — overwriting a report Koloft has not read yet loses that binding for
    # good, after which the tab rejects every later report of its own live session.
    if [ "$event" = "start" ] && [ "$src" = "fork" ]; then exit 0; fi
    # This hook runs as a CHILD of claude, so it inherits the account env an auth
    # auth wrapper exported before exec'ing claude — the session-info card
    # shows it. Quotes/backslashes AND control chars stripped so the value can't
    # break our JSON (stdin went through tr -d '\\n'; the env value never did — a
    # newline/tab here would make the whole registration unparseable).
    acct="$(printf '%s' "$ANT_ACCOUNT" | tr -d '"\\\\[:cntrl:]')"
    # The RUNNING claude's version — a resumed session's transcript tail still
    # carries whichever OLD version wrote it, so only the live process is truthful.
    # Two env reads and nothing slower: the report below is the ONLY thing that binds
    # the tab, and CC can cut a SessionStart hook short (Esc, or a --resume that no
    # longer waits) — a \`claude --version\` probe here (~0.4s) risked exactly that.
    #  1. CLAUDE_CODE_EXECPATH — versioned dir basename (native install; digits-and-
    #     dots only: an npm layout's basename is not a version)
    #  2. AI_AGENT — the cli stamps children with claude-code_X-Y-Z_agent
    ver="$(basename "$CLAUDE_CODE_EXECPATH" 2>/dev/null)"
    case "$ver" in ''|*[!0-9.]*) ver="";; esac
    if [ -z "$ver" ]; then
      ver="$(printf '%s' "$AI_AGENT" | sed -n 's/^claude-code_\\([0-9-]*\\)_agent$/\\1/p' | tr '-' '.')"
    fi
    # A remote session runs inside tmux, and the tmux session is named after the claude
    # session it holds. An in-TUI /clear gives claude a NEW id, so without this rename
    # the name would keep pointing at a session that no longer exists: the heartbeat
    # would read the row as cold, a resume would start a SECOND claude beside the live
    # one, and the restart would fall through to a local launch. Only set for a session
    # Koloft started over ssh (launch.ts tabScript) — a local claude renames nothing.
    if [ "$event" = "start" ] && [ "$KOLOFT_TMUX_FOLLOW" = "1" ] && [ -n "$TMUX" ] && [ -n "$sid" ]; then
      tmux rename-session -t "$TMUX_PANE" "k-$sid" 2>/dev/null
    fi
    printf '{"tabId":"%s","event":"%s","sessionId":"%s","transcriptPath":"%s","cwd":"%s","reason":"%s","source":"%s","account":"%s","ccVersion":"%s","tmux":"%s"}\\n' "$tab" "$event" "$sid" "$tp" "$cwd" "$reason" "$src" "$acct" "$ver" "$tm" > "$reg/$tab.json"
    ;;
  posttool)
    # A PR-state-changing gh command just ran (PostToolUse, matcher=Bash): mark the
    # statusline's git-review cache stale — mtime beyond ccstatusline's 30s TTL — so
    # the NEXT render re-queries at once instead of waiting the TTL out (the "PR
    # merged but still shows OPEN for a round or two" lag; the render after a tool
    # result lands within ~300ms and schedules ccstatusline's own background gh
    # fetch). The whole payload is grepped, not the extracted command: a command
    # containing quotes breaks single-line sed extraction, and a false positive
    # from tool OUTPUT costs one harmless re-query. Only *.json entries are dated:
    # touching a .json.lock would make a live refresh lock look young and SUPPRESS
    # the very refresh this exists to cause. Writes nothing to $reg — this event is
    # per-tool-call, and the reg dir must not flood (see writeTabHookSettings).
    printf '%s' "$input" | grep -qE 'gh pr (create|merge|close|reopen|ready|edit)' || exit 0
    for f in "$HOME/.cache/ccstatusline/git-review/"*.json; do
      [ -e "$f" ] && touch -t 200001010000 "$f" 2>/dev/null
    done
    ;;
  prompt|stop|notify)
    # Notification's message distinguishes a permission prompt ("…needs your permission…")
    # from an idle "waiting for your input" nudge. Strip quotes/backslashes/control chars
    # so the value can't break the JSON we emit (it's only keyword-matched on the Koloft side).
    msg="$(printf '%s' "$input" | sed -n 's/.*"message"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' | tr -d '"\\\\[:cntrl:]')"
    # WHOSE turn this is — same extraction the binding branch uses, deliberately (see
    # session_id above). A \`/fork\`ed background copy inherits this hook, so its every
    # prompt/stop/notify appends to THIS tab's log under THIS tab's id; without the
    # session id there is nothing to tell them apart and the copy drives the tab's status
    # dot and its turn-done alerts. An empty value means "unknown", which the reader
    # treats as the tab's own (a claude too old to send one).
    sid="$(session_id)"
    # Claude Code's OWN list of what is still running at this turn-end
    # (\`background_tasks\`, claude >= 2.1.228: background subagents, teammates,
    # shells, Monitors, and tasks nested one agent deep). It is the authoritative
    # answer to the question Koloft otherwise reconstructs from spawn acks, so it is
    # forwarded as \`bgl\`: the live tasks as \`id:type\` pairs
    # (\`b0167powo:shell,t6fdjbjat:teammate\`).
    # Never the raw list: a task's \`command\` can be multi-KB and quote-laden, and
    # a long line would break the one-atomic-append-per-transition property
    # below. An id is 9 base36 chars and a type comes from a fixed vocabulary
    # (shell / subagent / teammate / monitor / workflow / mcp-task /
    # cloud-session / dream / auto-mode-scan), so both are scrubbed to
    # [A-Za-z0-9_-] and can never carry JSON punctuation. The type is what lets
    # the reader treat a parked teammate or a dev server differently from a
    # running subagent. Absent key => no \`bgl\` => the reader falls back to the
    # inferred ledger, which is also what a garbled stdin gets.
    #
    # The list is exact in both directions, because neither error is cheap:
    #  - over-count PINS the dot. A reported task holds the deferred turn-end
    #    (only a later report releases it), so one phantom task means no
    #    turn-done — and the next turn-end reports it again. Hence the
    #    string-aware scan for the array's OWN closing bracket instead of scanning
    #    everything after the key: a later \`session_crons\` entry reported as
    #    running sits in the same payload. Bounding at the first \`]\` is equally
    #    wrong — a task's command may legally contain one. Objects are split on
    #    depth, string-aware too, and only the FIRST id/type/status of each is
    #    read — a description quoting another task's fields sits after them.
    #  - under-count fires a FALSE turn-done and clears the ledger with it, so
    #    'live' is defined as NOT-terminal rather than as the literal "running":
    #    an unreported status value must never read as "nothing is running".
    # Escaped quotes inside a task's command can't fake a field: they arrive as
    # \\" and don't match the unescaped-quote patterns below.
    bgl=""
    case "$input" in
      *'"background_tasks"'*)
        bgl="$(printf '%s' "$input" | awk '
          {
            key = "\\"background_tasks\\":["
            k = index($0, key)
            if (k == 0) exit
            s = substr($0, k + length(key))
            depth = 1; instr = 0; esc = 0; end = 0
            for (i = 1; i <= length(s); i++) {
              c = substr(s, i, 1)
              if (esc) { esc = 0; continue }
              if (c == "\\\\") { esc = 1; continue }
              if (c == "\\"") { instr = 1 - instr; continue }
              if (instr) continue
              if (c == "[") depth++
              else if (c == "]") { depth--; if (depth == 0) { end = i; break } }
            }
            if (end == 0) end = length(s)
            arr = substr(s, 1, end)
            list = ""
            depth = 0; instr = 0; esc = 0; start = 0
            for (i = 1; i <= length(arr); i++) {
              c = substr(arr, i, 1)
              if (esc) { esc = 0; continue }
              if (c == "\\\\") { esc = 1; continue }
              if (c == "\\"") { instr = 1 - instr; continue }
              if (instr) continue
              if (c == "{") { if (depth == 0) start = i; depth++ }
              else if (c == "}") {
                depth--
                if (depth == 0 && start > 0) {
                  obj = substr(arr, start, i - start + 1)
                  st = field(obj, "status")
                  if (st !~ /^(completed|failed|killed|stopped|cancelled|canceled)$/) {
                    id = field(obj, "id"); gsub(/[^A-Za-z0-9_-]/, "", id)
                    ty = tolower(field(obj, "type")); gsub(/ /, "-", ty); gsub(/[^a-z0-9-]/, "", ty)
                    list = list (list == "" ? "" : ",") id ":" ty
                  }
                }
              }
            }
            print ",\\"bgl\\":\\"" list "\\""
          }
          function field(o, name,    v) {
            if (!match(o, "\\"" name "\\"[ \\t]*:[ \\t]*\\"[^\\"]*\\"")) return ""
            v = substr(o, RSTART, RLENGTH)
            sub(/^"[a-z]*"[ \\t]*:[ \\t]*"/, "", v)
            sub(/"$/, "", v)
            return v
          }')"
        # awk prints the whole field, so an EMPTY list is still a field — while a
        # payload shape it could not scan prints nothing, and reports nothing:
        # a false empty list is a false turn-done
        ;;
    esac
    # APPENDED, never overwritten: two transitions of one turn (prompt then stop) can
    # land within the reader's latency, and a last-writer-wins file would collapse them
    # into the later one — losing the 'working' edge entirely, so the dot never shows the
    # turn running and no turn-done is ever raised. One short line per transition is a
    # single atomic O_APPEND write, so concurrent hooks can't interleave mid-line either.
    printf '{"tabId":"%s","event":"%s","sessionId":"%s","message":"%s","tmux":"%s"%s}\\n' "$tab" "$event" "$sid" "$msg" "$tm" "$bgl" >> "$reg/$tab.status.jsonl"
    ;;
esac
exit 0
`

/** Best-effort removal of `*.json` / `*.jsonl` reports left by previous runs. Not a
 *  full wipe: a *concurrent* Koloft instance may share this dir, and tab ids are globally
 *  unique now, so a peer's fresh reports must survive. Only files older than maxAgeMs
 *  go — including the append-only run-state logs, which otherwise grow for a session's
 *  whole life and are replayed from byte 0 by whoever watches them next. */
function pruneStale(dir: string, maxAgeMs = 12 * 60 * 60 * 1000): void {
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return
  }
  const now = Date.now()
  for (const name of names) {
    if (!name.endsWith('.json') && !name.endsWith('.jsonl')) continue
    const full = path.join(dir, name)
    try {
      if (now - fs.statSync(full).mtimeMs > maxAgeMs) fs.rmSync(full, { force: true })
    } catch {
      /* raced with another instance; ignore */
    }
  }
}

export function setupHooks(): HookPaths {
  const base = app.getPath('userData')
  const hookDir = path.join(base, 'hooks')
  const settingsDir = path.join(hookDir, 'settings')
  const regDir = path.join(base, 'hook-sessions')

  fs.mkdirSync(settingsDir, { recursive: true })
  fs.mkdirSync(regDir, { recursive: true })
  pruneStale(regDir)
  pruneStale(settingsDir)

  const hookScript = path.join(hookDir, 'sessionstart.sh')
  fs.writeFileSync(hookScript, HOOK_SCRIPT, { mode: 0o755 })
  fs.chmodSync(hookScript, 0o755)

  return { hookScript, settingsDir, regDir }
}

/** The `--settings` document itself, with the hook script, its report dir and the tab
 *  id baked into every command. Pure: a remote session builds the same document with
 *  the machine's own paths and ships it in the tab package. */
export function hookSettings(
  hookScript: string,
  regDir: string,
  tabId: string,
  statusLine?: StatusLineSetting,
  // a remote package does not know the machine's home, so its paths are spelt
  // `$HOME/.koloft/…` and must reach the shell inside DOUBLE quotes to expand
  quote: (s: string) => string = shq
): Record<string, unknown> {
  const cmd = (event: string): string =>
    `${quote(hookScript)} ${quote(regDir)} ${quote(tabId)} ${event}`
  const settings: Record<string, unknown> = {
    hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: cmd('start') }] }],
      SessionEnd: [{ hooks: [{ type: 'command', command: cmd('end') }] }],
      // run-state hooks driving the tab's status dot. Low-frequency transition points
      // (not PreToolUse/PostToolUse), so they don't flood the reg dir. Claude MERGES
      // these with the user's own hooks of the same name, so theirs keep running.
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: cmd('prompt') }] }],
      Stop: [{ hooks: [{ type: 'command', command: cmd('stop') }] }],
      Notification: [{ hooks: [{ type: 'command', command: cmd('notify') }] }]
    }
  }
  if (statusLine) {
    settings.statusLine = statusLine
    // Rides only with the statusline: it exists to freshen the statusline's PR
    // segment, and with the toggle off that cache belongs to whatever the user
    // runs themselves. Unlike the run-state hooks above this one IS per-tool-call,
    // but it never writes the reg dir — it greps stdin and touches cache mtimes.
    ;(settings.hooks as Record<string, unknown>).PostToolUse = [
      { matcher: 'Bash', hooks: [{ type: 'command', command: cmd('posttool') }] }
    ]
  }
  return settings
}

/**
 * Write a per-tab settings file injecting a SessionStart + SessionEnd hook, with
 * this tab's id baked into the command. The returned path is passed to
 * `claude --settings`, which MERGES (not replaces) — so the user's own
 * settings/hooks (including their Stop hook that writes `<id>.title`) keep running
 * untouched; we only add ours.
 *
 * SessionStart reports the live tab→session binding (+ cwd); SessionEnd lets Koloft drop
 * the binding when claude exits in-TUI while the shell pty lives on, so the tab
 * reverts from a claude tab back to a plain terminal.
 *
 * `statusLine` (when the built-in statusline is enabled) rides the same file: the
 * CLI-args tier outranks the user's own statusLine, so Koloft's wins for this session.
 */
export function writeTabHookSettings(
  paths: HookPaths,
  tabId: string,
  statusLine?: StatusLineSetting
): string {
  // A tab id is `pty-<main pid base36>-<n>`, and the OS recycles pids: a later Koloft
  // could mint an id a previous run already used. Its run-state log is append-only
  // and read from byte 0, so start every tab's log empty — otherwise the dead tab's
  // turns would replay as this one's transitions (phantom dots and notifications).
  fs.rmSync(path.join(paths.regDir, `${tabId}.status.jsonl`), { force: true })
  // Same recycling hazard for the registration snapshot: the pty-exit drain
  // (drainExitRegistration) reads `<tab>.json` straight off disk, so a dead run's
  // SessionEnd left behind could replay as this tab's graceful exit.
  fs.rmSync(path.join(paths.regDir, `${tabId}.json`), { force: true })
  const settings = hookSettings(paths.hookScript, paths.regDir, tabId, statusLine)
  const out = path.join(paths.settingsDir, `${tabId}.json`)
  fs.writeFileSync(out, JSON.stringify(settings))
  return out
}
