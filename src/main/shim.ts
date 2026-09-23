import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import { VIEWABLE_EXTENSIONS } from '@shared/preview'
import { keychainNamespace } from '@shared/types'

export interface ShimPaths {
  shimDir: string
  regDir: string
  /** dir the `open` shim drops preview-open requests into */
  openDir: string
  /** dir the claude shim exchanges multi-account pick req/res files through */
  pickDir: string
}

/**
 * A `claude` shim placed early on a tab's PATH. When the user runs `claude`
 * (directly or via a wrapper that internally calls `claude`), this intercepts the
 * call, injects `--session-id <uuid>` for new interactive sessions, and writes a
 * registration file the app watches — so manually started sessions show up in the
 * sidebar and can be switched to.
 *
 * It does two INDEPENDENT things, with deliberately different scopes:
 *  - registration (sidebar binding): new + resume launches only; print/version/
 *    subcommand calls are passed straight through.
 *  - credential injection (multi-account balancing): every call that needs auth,
 *    INCLUDING `-p`/--print and resume — a bare `claude -p` in a shell tab must not
 *    reach an unauthenticated claude. Only auth-free calls (--version/doctor/mcp/…)
 *    and `setup-token` (the login flow itself) are left alone.
 */
const SHIM_SCRIPT = `#!/usr/bin/env bash
# koloft claude shim — registers claude launches (new + resume) so the app can bind
# each tab to its session jsonl. New sessions get an injected --session-id; resume
# binds by the given id, or by the most-recently-active jsonl in the cwd.
self_dir="$(cd "$(dirname "$0")" >/dev/null 2>&1 && pwd)"
real=""
old_ifs="$IFS"; IFS=":"
set -f
for d in $PATH; do
  [ "$d" = "$self_dir" ] && continue
  [ -x "$d/claude" ] || continue
  # never exec another Koloft instance's claude shim (nested Kolofts put two shim dirs on
  # PATH; each skips only its own dir, so two shims would exec each other forever).
  if head -n 2 "$d/claude" 2>/dev/null | grep -q "koloft claude shim"; then continue; fi
  real="$d/claude"; break
done
set +f
IFS="$old_ifs"
if [ -z "$real" ]; then echo "koloft-shim: real 'claude' not found on PATH" >&2; exit 127; fi

# A token that FOLLOWS a value-taking flag is that flag's value, never a keyword of
# ours: \`-w update\` names a worktree, and reading its value as the \`update\`
# subcommand would send a real session down the passthrough branch (no --settings, no
# registration, no injected --session-id). Same list in all three scans below; only
# this one still has to capture the id after -r/--resume/--session-id.
skip=0
resume=0
sid=""
prev=""
valflag=0
for a in "$@"; do
  if [ "$valflag" = "1" ]; then
    valflag=0
    case "$a" in
      -*) ;;                                   # not a value after all (optional-value flags like -w / -r)
      *) case "$prev" in -r|--resume|--session-id) sid="$a" ;; esac
         prev="$a"; continue ;;
    esac
  fi
  case "$a" in
    -p|--print|--version|-v|-h|--help|--help-all|mcp|config|doctor|update|install) skip=1 ;;
    -r|--resume|-c|--continue) resume=1 ;;
  esac
  case "$a" in
    -w|--worktree|--name|-n|--model|--permission-mode|--settings|--session-id|-r|--resume|--agent|--effort) valflag=1 ;;
  esac
  prev="$a"
done
case "$1" in ""|-*) ;; *) skip=1 ;; esac

# ---- utility terminal guard (A9 / §06) --------------------------------------------
# A Koloft terminal tab is the user's tool surface, not an agent surface: an
# interactive TUI started there would be a session Koloft neither orchestrates nor
# previews. Sits BEFORE the pick section below so a blocked launch never consumes a
# balancer slot. The allow-list lives HERE and nowhere else, and is deliberately NOT
# the \`skip\` set above: --resume and a bare initial prompt skip registration yet still
# open a full TUI, so both must be blocked. Product funnel, not a security boundary —
# \`env -u KOLOFT_UTIL\` and absolute-path launches are an explicit non-goal.
if [ "$KOLOFT_UTIL" = "1" ]; then
  utilok=0
  valflag=0
  for a in "$@"; do
    if [ "$valflag" = "1" ]; then
      valflag=0
      case "$a" in -*) ;; *) continue ;; esac   # a flag's value, not a keyword (\`-w update\`)
    fi
    case "$a" in
      -p|--print|-h|--help|--help-all|-v|--version|doctor|mcp|config|auth|setup-token|agents|project|update|install|plugin|import) utilok=1 ;;
    esac
    case "$a" in
      -w|--worktree|--name|-n|--model|--permission-mode|--settings|--session-id|-r|--resume|--agent|--effort) valflag=1 ;;
    esac
  done
  if [ "$utilok" = "0" ]; then
    printf '⛔ Koloft — this is a Koloft terminal, not an agent surface.\\n' >&2
    printf '   %s\\n' "Start interactive Claude from the sidebar's ＋ (⌘N)." >&2
    printf '   %s\\n' 'Non-interactive use is fine: claude -p · --help · doctor · mcp · …' >&2
    exit 1
  fi
fi

# Koloft injects a SessionStart hook via --settings (Claude merges it with, rather
# than replacing, the user's own settings) so each tab reports its live session id
# back to the app — covering the in-TUI /resume the shim itself can't see.
pre=()
[ -n "$KOLOFT_HOOK_SETTINGS" ] && pre=(--settings "$KOLOFT_HOOK_SETTINGS")

newid() {
  u="$(uuidgen 2>/dev/null | tr 'A-Z' 'a-z')"
  if [ -z "$u" ] && [ -r /proc/sys/kernel/random/uuid ]; then u="$(cat /proc/sys/kernel/random/uuid)"; fi
  echo "$u"
}

register() {
  # §06 (D8): a utility shell binds to no session. ptyManager withholds its
  # KOLOFT_SESSION_DIR, so an allow-listed launch that still reaches registration —
  # \`claude --debug agents\`, which the skip set above does not cover — would fall back
  # to \$HOME/.koloft/sessions and leave an orphan file no Koloft ever collects.
  [ "$KOLOFT_UTIL" = "1" ] && return 0
  reg_dir="$KOLOFT_SESSION_DIR"
  if [ -z "$reg_dir" ]; then reg_dir="$HOME/.koloft/sessions"; fi
  mkdir -p "$reg_dir"
  printf '{"tabId":"%s","regId":"%s","sessionId":"%s","cwd":"%s","ts":%s,"mode":"%s"}\\n' \\
    "$KOLOFT_TAB_ID" "$1" "$2" "$PWD" "$(date +%s)" "$3" > "$reg_dir/$1.json"
}

# ---- multi-account pick (Koloft balancer) -------------------------------------------
# Sits BEFORE the branch cascade so every exec path below inherits the injected env.
# Injection is DECOUPLED from registration: -p/--print still get a token (a bare
# \`claude -p\` in a shell tab must not hit an unauthenticated claude), while
# auth-free calls — and setup-token, the login flow itself — skip injection.
# Policy (mode on/off) lives in MAIN: the shim always asks; main answers instantly
# with account:null reason:disabled when the mode is off, so a runtime toggle
# reaches every already-open tab.
# ---- Koloft browser control (D2/D9) ---------------------------------------------
# Deliberately ABOVE — and outside — the pick cascade below: with the balancer off that
# whole block is skipped, and an endpoint injected only in there would work in tests and
# silently drift in real use. Read per LAUNCH from a file Koloft rewrites, so the master
# switch and a changed port reach tabs that are already open (a pty's env is frozen).
# A utility shell never gets the file (D9 — no agent can reach that shell).
if [ -n "$KOLOFT_CDP_DIR" ] && [ -n "$KOLOFT_TAB_ID" ] && [ "$KOLOFT_UTIL" != "1" ]; then
  kcdp="$(cat "$KOLOFT_CDP_DIR/$KOLOFT_TAB_ID" 2>/dev/null)"
  if [ -n "$kcdp" ]; then
    # the tool-specific variable playwright-mcp reads with zero configuration, and the
    # generic one every other client (the Playwright CLI, a skill, a script) is told about
    export PLAYWRIGHT_MCP_CDP_ENDPOINT="$kcdp"
    export KOLOFT_BROWSER_CDP="$kcdp"
  fi
  kcdp=""
fi

inj=()
noinj=0
hasperm=0
hasp=0
valflag=0
for a in "$@"; do
  if [ "$valflag" = "1" ]; then
    valflag=0
    case "$a" in -*) ;; *) continue ;; esac   # a flag's value, not a keyword (\`-w update\`)
  fi
  case "$a" in
    --version|-v|-h|--help|--help-all|mcp|config|doctor|update|install|setup-token) noinj=1 ;;
    --dangerously-skip-permissions|--permission-mode|--permission-mode=*) hasperm=1 ;;
    -p|--print) hasp=1 ;;
  esac
  case "$a" in
    -w|--worktree|--name|-n|--model|--permission-mode|--settings|--session-id|-r|--resume|--agent|--effort) valflag=1 ;;
  esac
done
if [ "$noinj" = "0" ]; then
  if [ -n "$CLAUDE_CODE_OAUTH_TOKEN" ] || [ -n "$ANTHROPIC_API_KEY" ] || [ -n "$ANTHROPIC_AUTH_TOKEN" ]; then
    # Respect external wrappers / nested calls — but say so when balancing was on at
    # spawn, or an ambient key in a profile silently swallows the whole feature.
    # KOLOFT_MULTI_ACCOUNT is a spawn-time snapshot (pty env is frozen), so a tab opened
    # BEFORE the mode was switched on stays quiet here. Deliberate: the alternative is
    # a pick round-trip on every passthrough launch, and the case self-corrects in any
    # newly opened tab. Injection itself is never gated on it — main owns that policy.
    [ -n "$KOLOFT_MULTI_ACCOUNT" ] && echo "koloft: auth token already in env, skipping balancing" >&2
  elif [ -n "$KOLOFT_PICK_DIR" ] && [ -n "$KOLOFT_TAB_ID" ] && [ -n "$KOLOFT_PID" ] && kill -0 "$KOLOFT_PID" 2>/dev/null; then
    pickid="$(newid)"
    [ -n "$pickid" ] || pickid="$$-$(date +%s)"
    preq="$KOLOFT_PICK_DIR/req-$pickid.json"
    pres="$KOLOFT_PICK_DIR/res-$pickid.json"
    printf '{"tabId":"%s","ts":%s}\\n' "$KOLOFT_TAB_ID" "$(date +%s)" > "$preq" 2>/dev/null
    pwaits=0
    while [ ! -f "$pres" ] && [ "$pwaits" -lt 60 ]; do sleep 0.05; pwaits=$((pwaits+1)); done
    pacct=""
    preason="timeout"
    if [ -f "$pres" ]; then
      pacct="$(sed -n 's/.*"account":"\\([^"]*\\)".*/\\1/p' "$pres" 2>/dev/null)"
      pkind="$(sed -n 's/.*"kind":"\\([^"]*\\)".*/\\1/p' "$pres" 2>/dev/null)"
      pbanner="$(sed -n 's/.*"banner":"\\([^"]*\\)".*/\\1/p' "$pres" 2>/dev/null)"
      # its own key, not a \\n inside banner: this sed lifts a JSON string verbatim, so
      # an escaped newline would arrive as the two characters \\ n and print as \\n.
      pwarn="$(sed -n 's/.*"warning":"\\([^"]*\\)".*/\\1/p' "$pres" 2>/dev/null)"
      pbase="$(sed -n 's/.*"baseUrl":"\\([^"]*\\)".*/\\1/p' "$pres" 2>/dev/null)"
      pmodel="$(sed -n 's/.*"model":"\\([^"]*\\)".*/\\1/p' "$pres" 2>/dev/null)"
      preason="$(sed -n 's/.*"reason":"\\([^"]*\\)".*/\\1/p' "$pres" 2>/dev/null)"
      pflag="$(sed -n 's/.*"skipFlag":true.*/1/p' "$pres" 2>/dev/null)"
    fi
    rm -f "$preq" "$pres" 2>/dev/null
    if [ -n "$pacct" ]; then
      # per-build Keychain namespace, substituted from keychainService() at shim-write
      # time — the shim reads the credential itself (main never hands a token across
      # the file channel), so both sides must resolve the SAME service name.
      psvc="__KOLOFT_KEYCHAIN_NS__-claude-oauth"
      [ "$pkind" = "apikey" ] && psvc="__KOLOFT_KEYCHAIN_NS__-anthropic-api"
      [ "$pkind" = "custom" ] && psvc="__KOLOFT_KEYCHAIN_NS__-custom-endpoint"
      # wall-clock cap the Keychain read: an authorization prompt must degrade to a
      # bare exec after ~5s, never hang the launch (macOS ships no timeout(1)).
      # \`exec\` is load-bearing: $! is the SUBSHELL's pid, and bash only folds a
      # subshell into its last command when that command stands alone — the umask
      # ahead of it defeats that, so without exec the kill below reaps the wrapper
      # and leaves \`security\` running, still holding the dialog that blocked us.
      ptokf="$KOLOFT_PICK_DIR/tok-$pickid"
      ( umask 077; exec security find-generic-password -s "$psvc" -a "$pacct" -w > "$ptokf" 2>/dev/null ) &
      psec=$!
      pswait=0
      while kill -0 "$psec" 2>/dev/null && [ "$pswait" -lt 100 ]; do sleep 0.05; pswait=$((pswait+1)); done
      kill "$psec" 2>/dev/null
      wait "$psec" 2>/dev/null
      ptok="$(cat "$ptokf" 2>/dev/null)"
      rm -f "$ptokf" 2>/dev/null
      if [ -n "$ptok" ]; then
        if [ "$pkind" = "apikey" ]; then
          export ANTHROPIC_API_KEY="$ptok"
          unset CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_AUTH_TOKEN
        elif [ "$pkind" = "custom" ]; then
          # third-party Anthropic-compatible endpoint: auth goes in ANTHROPIC_AUTH_TOKEN
          # (Bearer), and the endpoint serves its OWN models — so every model slot the
          # CLI might reach for is pinned to it, or claude asks for a claude-* model
          # this endpoint cannot answer.
          export ANTHROPIC_AUTH_TOKEN="$ptok"
          export ANTHROPIC_BASE_URL="$pbase"
          unset CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY
          if [ -n "$pmodel" ]; then
            # the same model pins accountEnv sets for a remote launch (src/main/remote/launch.ts) — add to both
            export ANTHROPIC_MODEL="$pmodel"
            export ANTHROPIC_DEFAULT_OPUS_MODEL="$pmodel"
            export ANTHROPIC_DEFAULT_SONNET_MODEL="$pmodel"
            export ANTHROPIC_DEFAULT_HAIKU_MODEL="$pmodel"
            export ANTHROPIC_DEFAULT_FABLE_MODEL="$pmodel"
            export CLAUDE_CODE_SUBAGENT_MODEL="$pmodel"
            # without FORCE the subagent model is only a default, and an agent whose
            # definition names a claude-* model id escapes the pin and 404s
            export CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1
          fi
        else
          export CLAUDE_CODE_OAUTH_TOKEN="$ptok"
          unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN
        fi
        ptok=""
        # The account TAG — a label, never a credential. Both the SessionStart hook
        # (SessionInfo.account) and the embedded statusline's account segment read
        # \$ANT_ACCOUNT; ptyManager strips any INHERITED value at spawn precisely so
        # that this per-launch one, which Koloft itself chose, is the only one that can
        # reach a session. Without it the shipped statusline renders that segment
        # blank in every tab.
        export ANT_ACCOUNT="$pacct"
        [ -n "$pbanner" ] && printf '%s\\n' "$pbanner" >&2
        # D18: the pool has no included fable allowance left. This is the ONLY thing
        # warning the user before a metered fable session — never deduped, never gated.
        [ -n "$pwarn" ] && printf '%s\\n' "$pwarn" >&2
        if [ "$pflag" = "1" ] && [ "$hasperm" = "0" ] && [ "$hasp" = "0" ]; then
          inj+=(--dangerously-skip-permissions)
        fi
      else
        echo "koloft: no credential for $pacct, launching as-is" >&2
      fi
    else
      case "$preason" in
        no-accounts) echo "koloft: no usable account, using default login" >&2 ;;
        timeout) echo "koloft: account pick timed out, launching as-is" >&2 ;;
      esac
    fi
  fi
fi

# ---- scheduled jobs: the first message and the row title (§4.6) --------------
# A scheduled run must start with the job's task text already typed in. Koloft never
# writes into a pty, so the text rides here as an env var and only the NEW-SESSION
# branch below turns it into argv.
#  - not a bare positional: \`case "$1" in ""|-*)\` above treats a leading positional as
#    a passthrough launch, which would cost the run its registration and its hooks.
#  - \`--\` in front: a task text may legally start with a dash, and without the
#    separator claude would read it as a flag.
#  - read and \`unset\` HERE, before every exec: claude's Bash tool hands its whole env
#    to the commands it runs, so a nested \`claude\` (or anything else the session
#    spawns) would otherwise inherit the prompt and re-type it.
# With both variables empty the argv below is byte-identical to a plain launch.
kfp="$KOLOFT_FIRST_PROMPT"
ksn="$KOLOFT_SESSION_NAME"
unset KOLOFT_FIRST_PROMPT KOLOFT_SESSION_NAME

if [ "$skip" = "1" ]; then
  exec "$real" "\${inj[@]}" "$@"
fi

if [ -n "$sid" ]; then
  register "$(newid)" "$sid" "exact"
  exec "$real" "\${pre[@]}" "\${inj[@]}" "$@"
fi

if [ "$resume" = "1" ]; then
  register "$(newid)" "" "resume"
  exec "$real" "\${pre[@]}" "\${inj[@]}" "$@"
fi

nid="$(newid)"
if [ -n "$nid" ]; then
  register "$nid" "$nid" "new"
  extra=()
  [ -n "$ksn" ] && extra+=(--name "$ksn")
  [ -n "$kfp" ] && extra+=(-- "$kfp")
  exec "$real" "\${pre[@]}" "\${inj[@]}" --session-id "$nid" "$@" "\${extra[@]}"
fi
exec "$real" "\${inj[@]}" "$@"
`

// bash case-glob of every extension Koloft renders somewhere, e.g. `*.md|*.png|*.html|…`.
// VIEWABLE, not PREVIEW: since D5 an `.html` goes to the Browser rather than the
// Preview pane, and dropping it from this glob would send it to Safari instead (IMPL-3).
const EXT_GLOBS = VIEWABLE_EXTENSIONS.map((e) => `*${e}`).join('|')

/**
 * An `open` shim placed early on a tab's PATH (macOS: everything that opens a file
 * from a terminal — the user typing `open x.md`, Claude Code's Bash tool, and the
 * Claude TUI itself via `Bun.spawn(["open", url])` — resolves `open` through PATH).
 * When the single target is an http(s) URL, or an existing local file Koloft can render,
 * AND the owning Koloft process is still alive to consume it, it drops a
 * `{tabId, openId, path, url, cwd}` JSON into the open-requests dir the app watches, so
 * the target lands in Koloft's Browser / viewer pane instead of the OS default app/browser.
 * A URL fills `url` and leaves `path` empty (and vice versa): main routes by whichever
 * one it was handed, and must never resolve a URL against the cwd.
 * Anything else — flags (-a/-e/-R/…), non-http URLs, multi-file lists (the viewer shows
 * one file; intercepting a subset would drop the rest), unsupported types, missing
 * files, control-char targets, or a non-Koloft context — execs the real `open` untouched.
 * The passthrough scan skips any OTHER Koloft instance's open shim on PATH (marker in
 * the header): with nested instances two shims would otherwise exec each other forever.
 */
const OPEN_SHIM_SCRIPT = `#!/usr/bin/env bash
# koloft open shim — routes http(s) URLs into Koloft's Browser and previewable file opens
# into Koloft's viewer pane; everything else passes through to the real open.
self_dir="$(cd "$(dirname "$0")" >/dev/null 2>&1 && pwd)"

passthrough() {
  real=""
  old_ifs="$IFS"; IFS=":"
  set -f
  for d in $PATH; do
    [ "$d" = "$self_dir" ] && continue
    [ -x "$d/open" ] || continue
    # never exec another Koloft instance's open shim (nested dev+packaged Kolofts put two
    # shim dirs on PATH; each skips only its own dir, so two shims would loop forever)
    if head -n 2 "$d/open" 2>/dev/null | grep -q "koloft open shim"; then continue; fi
    real="$d/open"; break
  done
  set +f
  IFS="$old_ifs"
  [ -z "$real" ] && real="/usr/bin/open"
  exec "$real" "$@"
}

# outside a Koloft tab (or with no request dir to deliver into) nothing can consume
# an interception — never swallow the open
[ -n "$KOLOFT_TAB_ID" ] && [ -n "$KOLOFT_OPEN_DIR" ] || passthrough "$@"
# the owning Koloft must still be RUNNING to consume it: a tmux/nohup shell keeps this
# env long after Koloft quit, and an intercept nobody reads opens nothing anywhere
[ -n "$KOLOFT_PID" ] && kill -0 "$KOLOFT_PID" 2>/dev/null || passthrough "$@"
# one plain file target only: flags request an app/behavior, and the viewer renders
# a single file — a multi-target open keeps OS semantics rather than dropping N-1
[ "$#" -eq 1 ] || passthrough "$@"
case "$1" in -*) passthrough "$@" ;; esac

f="$1"
# a URL target is handed over as-is: the ext/existence/cwd-prefix checks below are all
# filesystem-shaped and would each swallow it (IMPL-3). Scheme judgement itself stays
# in main's routing table — this only decides which field carries the target.
url=""
abs=""
case "$f" in
  http://*|https://*) url="$f" ;;
  file://localhost/*) f="\${f#file://localhost}"; f="$(printf '%b' "\${f//%/\\\\x}")" ;;
  file:///*) f="\${f#file://}"; f="$(printf '%b' "\${f//%/\\\\x}")" ;;
  *://*) passthrough "$@" ;;
esac
if [ -z "$url" ]; then
  low="$(printf '%s' "$f" | tr '[:upper:]' '[:lower:]')"
  case "$low" in
    ${EXT_GLOBS}) ;;
    *) passthrough "$@" ;;
  esac
  [ -f "$f" ] || passthrough "$@"
  case "$f" in /*) abs="$f" ;; *) abs="$PWD/$f" ;; esac
fi
# a control char in the target/cwd would corrupt the JSON handoff — let the OS open it.
# (tr, not grep: grep is line-based, so an embedded newline never matches [[:cntrl:]])
if [ "$(printf '%s' "$abs$url$PWD" | LC_ALL=C tr -d '[:cntrl:]')" != "$abs$url$PWD" ]; then passthrough "$@"; fi

newid() {
  u="$(uuidgen 2>/dev/null | tr 'A-Z' 'a-z')"
  if [ -z "$u" ] && [ -r /proc/sys/kernel/random/uuid ]; then u="$(cat /proc/sys/kernel/random/uuid)"; fi
  echo "$u"
}

esc() { printf '%s' "$1" | sed -e 's/\\\\/\\\\\\\\/g' -e 's/"/\\\\"/g'; }

# a failed write must fall back to the real open, never exit 0 with the open lost
mkdir -p "$KOLOFT_OPEN_DIR" 2>/dev/null || passthrough "$@"
oid="$(newid)"
[ -n "$oid" ] || oid="$$-$(date +%s)"
out="$KOLOFT_OPEN_DIR/$oid.json"
printf '{"tabId":"%s","openId":"%s","path":"%s","url":"%s","cwd":"%s","ts":%s}\\n' \\
  "$(esc "$KOLOFT_TAB_ID")" "$oid" "$(esc "$abs")" "$(esc "$url")" "$(esc "$PWD")" "$(date +%s)" > "$out" 2>/dev/null \\
  || { rm -f "$out" 2>/dev/null; passthrough "$@"; }
exit 0
`

/** Best-effort removal of `*.json` registrations left by previous runs. We can no
 *  longer wipe the whole dir on startup: a *concurrent* Koloft instance may share it,
 *  and tab ids are globally unique now, so a peer's fresh files must survive. Only
 *  files older than maxAgeMs are pruned; live registrations are consumed at once. */
function pruneStale(dir: string, maxAgeMs = 12 * 60 * 60 * 1000): void {
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return
  }
  const now = Date.now()
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const full = path.join(dir, name)
    try {
      if (now - fs.statSync(full).mtimeMs > maxAgeMs) fs.rmSync(full, { force: true })
    } catch {
      /* raced with another instance; ignore */
    }
  }
}

export function setupShim(): ShimPaths {
  const base = app.getPath('userData')
  const shimDir = path.join(base, 'shim')
  const regDir = path.join(base, 'sessions')
  const openDir = path.join(base, 'opens')
  const pickDir = path.join(base, 'picks')

  fs.mkdirSync(shimDir, { recursive: true })
  fs.mkdirSync(regDir, { recursive: true })
  fs.mkdirSync(openDir, { recursive: true })
  fs.mkdirSync(pickDir, { recursive: true })
  pruneStale(regDir)
  pruneStale(openDir)
  // picks are 3s-lived; anything left behind is garbage from a crash — prune, and
  // deliberately NEVER sweep-process this dir on startup (a stale pick is worthless)
  pruneStale(pickDir, 60 * 60 * 1000)

  // Bake this build's Keychain namespace in. keychainNamespace() only ever returns
  // [a-z0-9-], so it cannot break out of the double-quoted bash assignment — asserted
  // rather than assumed, since the value is interpolated into an executable script.
  const ns = keychainNamespace(app.getName())
  if (!/^[a-z0-9-]+$/.test(ns)) throw new Error(`unsafe keychain namespace: ${ns}`)

  const shimPath = path.join(shimDir, 'claude')
  fs.writeFileSync(shimPath, SHIM_SCRIPT.replaceAll('__KOLOFT_KEYCHAIN_NS__', ns), { mode: 0o755 })
  fs.chmodSync(shimPath, 0o755)

  const openShimPath = path.join(shimDir, 'open')
  fs.writeFileSync(openShimPath, OPEN_SHIM_SCRIPT, { mode: 0o755 })
  fs.chmodSync(openShimPath, 0o755)

  return { shimDir, regDir, openDir, pickDir }
}
