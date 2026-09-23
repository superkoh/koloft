#!/usr/bin/env node
/*
 * A deterministic stand-in for the real `claude` CLI, used by the E2E suite. The Koloft
 * shim intercepts `claude` on PATH and exec's this as the "real" binary, handing it
 * `--settings <file> --session-id <uuid>` exactly as it would the real one. This
 * emulates ONLY the external LLM process; every Koloft code path it drives — the shim
 * registration, the injected SessionStart/Stop/UserPromptSubmit hooks, the jsonl the
 * tracker tails, the sidebar, the file preview — is the real thing.
 *
 * On launch it: fires SessionStart (authoritative bind), writes a realistic transcript
 * (user prompt + ai-title + an assistant Write tool_use touching a file that exists on
 * disk), then flips run-state prompt->stop. It then stays alive reading stdin so the
 * tab keeps reading as a live claude session (the liveness sweep looks for a running
 * `claude`); each typed line becomes a new prompt that appends a Read tool_use.
 *
 * Agent-centric extensions (contract anchor = the real-claude behavior recorded in
 * docs/claude-code-contract.md §1–§4: V2 + claude 2.1.227
 * experiments E1–E8 — every shape below mimics an entry there):
 *  - `-w <name>`: really creates `<cwd>/.claude/worktrees/<name>` on branch
 *    `worktree-<name>` (an existing dir is silently reused, exit 0 — the V2 contract);
 *    hooks and the files it touches then use the worktree dir as their cwd, but the
 *    TRANSCRIPT stays in the launch cwd's slug (E2) with a `worktree-state` head
 *    record binding it to the checkout. The call log still records the LAUNCH cwd,
 *    with the worktree dir in a separate `effectiveCwd` field.
 *  - `--resume <id> -w <name>`: the V1/E4 combination — enter (creating if needed)
 *    that worktree and carry the existing transcript into it.
 *  - stdin `/enter-worktree <name>` / `/exit-worktree`: the EnterWorktree /
 *    ExitWorktree tools — the session moves into (or back out of) a checkout
 *    mid-conversation. The transcript is RENAMED into the other slug (a rename, never a
 *    copy: the inode is what Koloft follows), a `relocated` record names where it landed
 *    and a `worktree-state` record says whether it is bound to one — and NO hook fires at
 *    all, which is the whole difficulty. On the way out the records stop carrying a cwd
 *    (measured: 195/195 real sessions never log a directory again after leaving).
 *  - stdin `/clear`: SessionEnd(reason=clear, process stays alive) → new uuid + new
 *    transcript → SessionStart(source=clear).
 *  - stdin `/resume <id>`: switches to that id and its existing jsonl →
 *    SessionStart(source=resume).
 *  - stdin `/compact`: SessionEnd + SessionStart(source=compact) on the SAME id —
 *    the in-place restart the lifecycle contract requires to be a list no-op.
 *  - stdin `/exit` in a worktree session: clean checkout → silent auto-cleanup (dir +
 *    branch); dirty → the real "1. Keep worktree / 2. Remove worktree" prompt, read
 *    from stdin. Either way the process exits (E2/E8: no in-place rebirth).
 *  - stdin `/write <rel>`: writes the file mid-turn (Write tool_use) and holds the
 *    turn open ~2.5s before Stop — the always-on-follow observation window.
 *  - stdin `/scratch <name>`: drops a file into this session's own scratchpad dir
 *    (`$KOLOFT_SCRATCHPAD_BASE/<slug>/<sessionId>/scratchpad/`) and emits NO tool_use and
 *    no hook — the shape a Bash command or a subagent produces, which the transcript
 *    never records. The only way to see such a file is to list the real directory.
 *  - stdin `/open <target>`: spawns `open <target>` from inside this session's pty, so
 *    the Koloft open shim sees the session's own KOLOFT_TAB_ID/KOLOFT_OPEN_DIR — the agent-source
 *    open (Claude Code's Bash tool / the TUI's own `Bun.spawn(["open", url])`).
 *    Transcript-silent like /scratch: the interception is the whole effect.
 *  - `<home>/fake-claude-no-status`: bind and then report NOTHING — an empty
 *    transcript (records would let the tracker's transcript recovery derive a
 *    run-state) and SessionStart with source 'compact' (every other source makes
 *    bindSession seed 'waiting'). The one way to hold the bound-but-statusless
 *    'claude' state open for observation (T-LIFE-10).
 *  - `<home>/fake-claude-exit` (content = exit code): print one assertable error
 *    line and exit immediately, firing no hook at all.
 *  - `<home>/fake-claude-lazy`: bind for real (SessionStart, source
 *    'startup') but write NO transcript — the state real Claude Code is in between
 *    SessionStart and the first user message, since it creates the jsonl lazily.
 *    The first typed line runs through the ordinary handlers, whose append() creates
 *    the file exactly as the real thing does. A `--resume` launch ignores the
 *    sentinel: resuming means the conversation already exists, and its startup turn
 *    is what every restart spec reads as "the resumed session is back on its feet".
 *  - `<home>/fake-claude-hang` (BB-E08): start, write the call log line, then
 *    sleep forever — no hook (so nothing ever binds), no transcript, no worktree, and
 *    no signal handlers at all, so the SIGHUP that kills the tab really ends the pid.
 *    The shape a claude that never comes up has, which is what the cron runner's start
 *    deadline exists for.
 *
 * `--` on the command line (§4.6): everything after it is the FIRST TYPED
 * MESSAGE, not flags. argv is split at it before anything reads a flag value (so a
 * task text like `-w nightly` is never mistaken for a worktree name), the message is
 * recorded in the call log as `firstPrompt`, and it REPLACES the canned startup turn
 * outright — no canned records, no NOTES.md, no prompt/stop pair, just SessionStart
 * and then the text through the very handler a stdin line goes through. So
 * `/need-approval` as a task text behaves exactly as when it is typed, and nothing
 * lands in the jsonl after the permission prompt to look like new work.
 */
const fs = require('fs')
const path = require('path')
const cp = require('child_process')
const readline = require('readline')

// `--` separates claude's own flags from the FIRST TYPED MESSAGE (a scheduled job's
// task text; the shim appends `-- "<text>"`, §4.6). Everything after it is
// message, never flags — so the split happens HERE, before any argVal() call, or a
// task text such as `-w nightly` would be read as this launch's worktree name.
const rawArgv = process.argv.slice(2)
const dashDashAt = rawArgv.indexOf('--')
const argv = dashDashAt >= 0 ? rawArgv.slice(0, dashDashAt) : rawArgv
const firstPrompt = dashDashAt >= 0 ? rawArgv.slice(dashDashAt + 1).join(' ') : null
const argVal = (flag) => {
  const i = argv.indexOf(flag)
  return i >= 0 ? argv[i + 1] : undefined
}

// `claude setup-token`: the real CLI does a browser round trip and PRINTS a long-lived
// token to the terminal. The fake skips the browser and prints a recognisable one, so
// the guided-login capture path (main watches the tab's output) is end-to-end testable.
if (argv[0] === 'setup-token') {
  // REALISTIC LENGTH matters: a real long-lived token runs ~108 chars, which wraps in
  // an 80-column pty and gets captured truncated. A short fixture token hides that
  // entire class of bug, so the default here is deliberately full length.
  const tok =
    process.env.KOLOFT_FAKE_SETUP_TOKEN ||
    'sk-ant-oat01-A1b2C3d4E5f6G7h8I9j0A1b2C3d4E5f6G7h8I9j0A1b2C3d4E5f6G7h8I9j0A1b2C3d4E5f6G7h8I9j0K1L2M3N4O5P6Q7R'
  // The real CLI renders through ink, which HARD-WRAPS its output at the detected
  // terminal width — so a token longer than the pty is columns wide arrives split
  // across lines, not as one contiguous run. Reproduce that faithfully; a raw write
  // would quietly pass a capture that truncates against the real thing.
  const cols = process.stdout.columns || 80
  const wrapped = tok.match(new RegExp(`.{1,${cols}}`, 'g')).join('\r\n')
  // The real CLI runs `open <auth url>` off PATH (verified against 2.1.266) and waits
  // for the browser round trip; the fake does the `open` when a spec names the url,
  // then skips straight to the token.
  const authUrl = process.env.KOLOFT_FAKE_SETUP_URL
  if (authUrl) {
    process.stdout.write(`\r\nBrowser didn't open? Visit: ${authUrl}\r\n`)
    // through a shell so `open` resolves along the pty's PATH, shim first; then a pause
    // standing in for the browser round trip the real CLI waits out — exiting on the
    // heels of the `open` would race main's delivery of it against this pty's exit
    require('child_process').spawnSync('/bin/sh', ['-c', 'open "$0"', authUrl], { stdio: 'ignore' })
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500)
  }
  process.stdout.write(`\r\nPaste this token into your environment:\r\n\r\n${wrapped}\r\n\r\n`)
  process.exit(0)
}

let sessionId = argVal('--session-id') || argVal('--resume') || require('crypto').randomUUID()
const settingsPath = argVal('--settings')
// real CC resolves every symlink and slugs the PHYSICAL directory (measured
//, docs/claude-code-contract.md §2), so a folder reached through a link
// files its transcript under the real path's slug — never the typed one's.
const launchCwd = fs.realpathSync(process.cwd())
const home = process.env.HOME || require('os').homedir()

// --- launch log (a process-boundary observation point) ---------------------------
// One JSONL record per launch: which argv this claude was started with (so a spec can
// assert a re-launch carried `--resume <id>`, or that no launch happened at all) and
// which pid it ran as (so a spec can assert the previous process really died). Written
// FIRST, before any delay, so "the process started" is observable immediately.
// `cwd` is always the LAUNCH cwd; `effectiveCwd` is where the session actually lives
// (differs only under `-w`, where CC switches into the worktree checkout).
function writeCallLog(effCwd) {
  const callLog = process.env.KOLOFT_FAKE_CLAUDE_LOG || path.join(home, 'fake-claude-calls.jsonl')
  try {
    fs.appendFileSync(
      callLog,
      JSON.stringify({
        // the WHOLE command line, `--` and the first message included, so a spec can
        // read both halves; `argv` above is only the flag half this process parses
        pid: process.pid,
        argv: rawArgv,
        cwd: launchCwd,
        effectiveCwd: effCwd,
        sessionId,
        // the first typed message the launch carried after `--`, or null
        firstPrompt,
        ts: Date.now(),
        // the multi-account observation point: which credentials (if any) the shim's
        // balancer injected into THIS process's env
        oauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN || null,
        apiKey: process.env.ANTHROPIC_API_KEY || null,
        // D2/D9: the browser endpoint the shim injected for THIS launch. A spec
        // reads the ws url from here — the same place a real agent's tools read it from
        // (their env), with no agent asked to echo anything.
        cdpEndpoint: process.env.KOLOFT_BROWSER_CDP || null,
        playwrightMcpEndpoint: process.env.PLAYWRIGHT_MCP_CDP_ENDPOINT || null
      }) + '\n'
    )
  } catch {
    /* the log is test scaffolding — never let it break the fake session */
  }
}

// --- early-exit sentinel (T-LIFE-03) ----------------------------------------------
// `<home>/fake-claude-exit` holding an exit code: the "claude binary broken / account
// injection failed" shape — one assertable error line, immediate exit, no hook fired,
// no transcript written. The call log still records the launch (the observation point
// a spec uses to prove the process did start).
try {
  const raw = fs.readFileSync(path.join(home, 'fake-claude-exit'), 'utf8').trim()
  writeCallLog(launchCwd)
  process.stdout.write('\r\n[fake-claude] fatal: E2E_EARLY_EXIT simulated launch failure\r\n')
  const code = Number(raw)
  process.exit(Number.isFinite(code) ? code : 1)
} catch {
  /* no sentinel -> a normal launch */
}

// --- hang sentinel (BB-E08) --------------------------------------------------
// `<home>/fake-claude-hang`: the process starts and then does NOTHING — no hook, so
// nothing ever binds; no transcript; no worktree; and deliberately no signal handler,
// so the SIGHUP that kills the tab really ends this pid (a spec asserts on
// processAlive). The call log still records the launch. Top-level `return` (legal in
// a CommonJS module) so none of the handlers below are ever registered.
if (fs.existsSync(path.join(home, 'fake-claude-hang'))) {
  writeCallLog(launchCwd)
  process.stdout.write('\r\n[fake-claude] hanging: never binds\r\n')
  setInterval(() => {}, 1 << 30) // keep the event loop alive forever
  return
}

// --- `-w <name>`: real worktree creation (V2 contract) ----------------------------
// Created via real git exactly like CC does: `.claude/worktrees/<name>` on branch
// `worktree-<name>`; an existing dir is silently reused. From here on the session's
// cwd (hooks, jsonl, files it touches) is the worktree checkout.
let effectiveCwd = launchCwd
const wtName = argVal('-w')

/** `.claude/worktrees/<name>` under the launch cwd, made with real git the way claude
 *  makes it; an existing one is silently reused. null when git refuses outright.
 *  Shared by the `-w` launch flag and the EnterWorktree command. */
function makeWorktree(name, fatal = false) {
  const wtRel = path.join('.claude', 'worktrees', name)
  const wtDir = path.join(launchCwd, wtRel)
  if (!fs.existsSync(wtDir)) {
    try {
      cp.execSync(
        `git worktree add ${JSON.stringify(wtRel)} -b ${JSON.stringify('worktree-' + name)}`,
        { cwd: launchCwd, stdio: 'pipe' }
      )
    } catch {
      try {
        // the branch already exists (a prior worktree was removed): attach to it
        cp.execSync(
          `git worktree add ${JSON.stringify(wtRel)} ${JSON.stringify('worktree-' + name)}`,
          { cwd: launchCwd, stdio: 'pipe' }
        )
      } catch (err) {
        if (!fatal) return null
        writeCallLog(launchCwd)
        process.stdout.write(`\r\n[fake-claude] worktree add failed: ${String(err)}\r\n`)
        process.exit(1)
      }
    }
  }
  return fs.realpathSync(wtDir)
}

if (wtName) effectiveCwd = makeWorktree(wtName, true)
// every record and hook below carries the session's REAL cwd (the worktree under -w).
// Not a const: EnterWorktree moves a live session into another checkout.
let cwd = effectiveCwd

const encodeCwd = (c) => c.replace(/[^a-zA-Z0-9]/g, '-')
const slugDir = (c) => path.join(home, '.claude', 'projects', encodeCwd(c))
// the lifecycle contract §6 (E2): a `-w` session's transcript stays in the LAUNCH cwd's slug —
// the session is created before claude enters the worktree — while an EMPTY slug dir
// for the checkout appears beside it. Which slug holds the jsonl and whether the
// session is worktree-bound are two independent axes (§1✎); the `worktree-state`
// record below, not the slug, is what says "worktree session".
const projDir = slugDir(wtName ? launchCwd : cwd)
fs.mkdirSync(projDir, { recursive: true })
if (wtName) fs.mkdirSync(slugDir(cwd), { recursive: true })

// `--resume <id>` finds the transcript wherever it already lives, never under this
// launch's cwd (V2: the lookup is global) — which is the only way `--resume <id> -w
// <name>` can carry the history into a different worktree (V1/E4).
function existingTranscript(id) {
  const root = path.join(home, '.claude', 'projects')
  try {
    for (const d of fs.readdirSync(root)) {
      const f = path.join(root, d, id + '.jsonl')
      if (fs.existsSync(f)) return f
    }
  } catch {
    /* no Claude storage yet -> nothing to resume into */
  }
  return null
}
const resumeId = argVal('--resume')
let transcript =
  (resumeId && existingTranscript(resumeId)) || path.join(projDir, sessionId + '.jsonl')

writeCallLog(cwd)

// Optional delayed bind: with `<home>/fake-claude-delay` present (holding a ms count),
// the process starts but fires SessionStart / writes its transcript only after that
// delay — the "claude tab exists but no session is bound yet" window. A file (not an
// env var) so it survives every launch path, including ptys Koloft spawns itself.
function delayMs() {
  try {
    const v = fs.readFileSync(path.join(home, 'fake-claude-delay'), 'utf8').trim()
    if (v) return Number(v) || 0
  } catch {
    /* no delay file -> bind immediately (the default for every other spec) */
  }
  return Number(process.env.KOLOFT_FAKE_START_DELAY_MS || 0) || 0
}

// The title for the NEXT fresh session, read from `<home>/fake-claude-next-title` and
// consumed on read. A file (not $KOLOFT_FAKE_TITLE) for the same reason delayMs() uses
// one: Koloft spawns the session pty itself, so a spec has no shell in which to export
// anything — and one-shot, so two sessions started in one app run can carry different
// titles (the whole point of the seam). A RESUMED launch never touches it: a resume of
// a title-less transcript (a seeded cold row) falling through to here would silently
// eat a title armed for a different, fresh launch.
function nextTitleFromFile() {
  if (argVal('--resume')) return null
  const f = path.join(home, 'fake-claude-next-title')
  try {
    const v = fs.readFileSync(f, 'utf8').trim()
    fs.unlinkSync(f)
    if (v) return v
  } catch {
    /* no file -> fall through to the env var / default */
  }
  return null
}

// The session title. A RESUMED session must keep the title it already has (a real
// session's title doesn't reset when you resume it), so specs can tell several
// sessions apart across a restart; a fresh one takes the one-shot file, then
// $KOLOFT_FAKE_TITLE, then the default. Resolved at most once per process: the file seam
// is consumed on read, and the transcript is written with two records that must agree.
let resolvedTitle = null
function sessionTitle() {
  if (resolvedTitle) return resolvedTitle
  return (resolvedTitle = resolveSessionTitle())
}
function resolveSessionTitle() {
  try {
    const prev = fs.readFileSync(transcript, 'utf8').split('\n')
    for (let i = prev.length - 1; i >= 0; i--) {
      if (!prev[i]) continue
      try {
        const rec = JSON.parse(prev[i])
        if (rec && rec.type === 'ai-title' && rec.aiTitle) return rec.aiTitle
      } catch {
        /* skip a partially written record */
      }
    }
  } catch {
    /* no transcript yet -> a fresh session */
  }
  return nextTitleFromFile() || process.env.KOLOFT_FAKE_TITLE || 'Fake session: project notes'
}

// --- injected hooks + statusline -------------------------------------------------
let hooks = {}
let statusLine = null
if (settingsPath) {
  try {
    const injected = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    hooks = injected.hooks || {}
    statusLine = injected.statusLine || null
  } catch {
    /* no hooks -> the session will NOT bind at all: hook registration is the only
       binding path since the mtime-follow guess layer retired (a spec seeing no
       title/usage forever should suspect a broken injected settings.json first) */
  }
}
const EVENT_KEY = {
  start: 'SessionStart',
  end: 'SessionEnd',
  prompt: 'UserPromptSubmit',
  stop: 'Stop',
  notify: 'Notification'
}
function fireHook(event, payload) {
  const cmd = hooks?.[EVENT_KEY[event]]?.[0]?.hooks?.[0]?.command
  if (!cmd) return
  // Real claude stamps EVERY hook payload with the session it belongs to, run-state
  // events included — and Koloft's gate (ownsHookReport) drops a report whose session
  // disagrees with the tab's binding, which is what stops a `/fork`ed background copy
  // from speaking for the tab it inherited these hooks from. A fixture that omitted the
  // id on prompt/stop/notify would exercise only that gate's fail-open branch, so a
  // wiring regression could drop 100% of real run-state reports with every suite green.
  const body = 'session_id' in payload ? payload : { ...payload, session_id: sessionId }
  try {
    cp.execSync(cmd, {
      input: JSON.stringify(body),
      stdio: ['pipe', 'ignore', 'ignore'],
      // the RUNNING process's version signal (native install layout); the transcript
      // records deliberately carry a DIFFERENT version so specs can pin live-wins
      env: { ...process.env, CLAUDE_CODE_EXECPATH: '/fake/versions/8.8.8' }
    })
  } catch {
    /* hook failure must not kill the fake session */
  }
}

function append(lines) {
  fs.appendFileSync(transcript, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
}

function git(args, at) {
  try {
    return cp.execSync(`git ${args}`, { cwd: at, stdio: 'pipe' }).toString().trim()
  } catch {
    return ''
  }
}

/**
 * The worktree binding claude records at the head of a worktree session's transcript
 * (the lifecycle contract §1✎ real shape: a `worktree-state` line nesting everything under
 * `worktreeSession`). Written on entering the checkout, so a `--resume … -w` re-entry
 * records the NEW binding the same way. `worktreeSession.sessionId` is carried because
 * real transcripts carry it — 14/116 samples inherit a predecessor's id, which is why
 * nothing may key off it (D11).
 */
function appendWorktreeState() {
  append([
    {
      type: 'worktree-state',
      worktreeSession: {
        originalCwd: launchCwd,
        preEnterOriginalCwd: launchCwd,
        worktreePath: cwd,
        worktreeName: wtName,
        worktreeBranch: 'worktree-' + wtName,
        originalBranch: git('symbolic-ref --short HEAD', launchCwd) || 'main',
        originalHeadCommit: git('rev-parse HEAD', launchCwd),
        sessionId
      }
    }
  ])
}

// --- injected statusline ---------------------------------------------------------
// The real claude re-renders on every turn; ONE render per launch is enough for a
// spec to assert the injected command produces output. Async (exec, not execSync):
// the first render cold-parses a 3MB bundle and must never delay SessionStart or
// the prompt loop. Output lands in <home>/fake-claude-statusline.out for the spec.
function renderStatusline() {
  if (!statusLine || statusLine.type !== 'command' || !statusLine.command) return
  const payload = {
    hook_event_name: 'Status',
    session_id: sessionId,
    transcript_path: transcript,
    cwd,
    model: { id: 'claude-opus-4-8', display_name: 'Opus 4.8' },
    effort: { level: 'xhigh' }, // CC ≥2.1.263 ships the session's effort here (contract §6)
    workspace: { current_dir: cwd, project_dir: cwd, added_dirs: [] },
    version: '9.9.9-fake',
    cost: {
      total_cost_usd: 0.01,
      total_duration_ms: 1000,
      total_api_duration_ms: 500,
      total_lines_added: 1,
      total_lines_removed: 0
    },
    context_window: {
      total_input_tokens: 42000,
      total_output_tokens: 350,
      context_window_size: 200000,
      current_usage: {
        input_tokens: 8,
        output_tokens: 350,
        cache_creation_input_tokens: 12000,
        cache_read_input_tokens: 30000
      },
      used_percentage: 21,
      remaining_percentage: 79
    }
  }
  try {
    const child = cp.exec(
      statusLine.command,
      // COLUMNS: the real claude (≥2.1.153) exports the terminal width for the script
      { env: { ...process.env, COLUMNS: '120' }, timeout: 20000, encoding: 'utf8' },
      (err, stdout) => {
        if (err || !stdout) return
        try {
          fs.writeFileSync(path.join(home, 'fake-claude-statusline.out'), stdout)
        } catch {
          /* observation scaffolding — never let it break the fake session */
        }
      }
    )
    child.stdin.write(JSON.stringify(payload))
    child.stdin.end()
  } catch {
    /* a broken statusline must not kill the fake session */
  }
}

/** the `<task-notification>` payload a finished background task reports with,
 *  naming the tool-use-id of the call that spawned it */
function taskNotification(toolUseId, status, summary) {
  return (
    `<task-notification>\n<task-id>t_${toolUseId}</task-id>\n` +
    `<tool-use-id>${toolUseId}</tool-use-id>\n<status>${status}</status>\n` +
    `<summary>${summary}</summary>\n</task-notification>`
  )
}

// A realistic `message.usage` block + the top-level requestId/timestamp the tracker
// needs to compute cost / context %. A monotonic counter keeps each assistant record's
// id+requestId unique so the tracker's streaming-dedup doesn't collapse successive turns.
let usageSeq = 0
function usageMeta() {
  usageSeq += 1
  return {
    id: `msg_fake_${usageSeq}`,
    requestId: `req_fake_${usageSeq}`,
    // a PRICED model id so the sidebar renders a $ (not the token fallback)
    model: 'claude-opus-4-8',
    usage: {
      input_tokens: 8,
      output_tokens: 350,
      cache_creation_input_tokens: 12000,
      cache_read_input_tokens: 30000
    }
  }
}

// --- startup turn ---------------------------------------------------------------
// `<home>/fake-claude-no-status` (T-LIFE-10): the session binds (SessionStart) and
// writes its transcript, but never reports a run-state — no prompt/stop hooks fire.
function noStatus() {
  return fs.existsSync(path.join(home, 'fake-claude-no-status'))
}

// `<home>/fake-claude-lazy`: bound, with nothing on disk yet. Only a
// FRESH launch can be in that state — `--resume` found a transcript to resume, so it
// takes the normal path (and with it the transcript growth restart specs wait on).
function lazyTranscript() {
  return !resumeId && fs.existsSync(path.join(home, 'fake-claude-lazy'))
}

// the lifecycle contract §4.2 (E8): on a RESUME the SessionStart hook reports the LAUNCH dir,
// not the worktree — claude re-enters the checkout only after the hook has run.
const startCwd = resumeId ? launchCwd : cwd

function startupTurn() {
  if (noStatus()) {
    // The 'claude' run-state shape is "bound, nothing else": an EMPTY transcript
    // (the file must exist so the aggregation lists the row) and no run-state
    // signal of any kind. Two things would defeat the sentinel — startup-turn
    // records (the tracker's transcript recovery derives a status from them) and
    // a plain SessionStart (bindSession seeds 'waiting' for every source EXCEPT
    // 'compact', the one hook-legal bind that leaves the status untouched). So
    // bind with source 'compact' and stop.
    fs.writeFileSync(transcript, '')
    fireHook('start', {
      session_id: sessionId,
      transcript_path: transcript,
      cwd: startCwd,
      hook_event_name: 'SessionStart',
      source: 'compact'
    })
    process.stdout.write(`\r\n[fake-claude] session ${sessionId} bound, no status\r\n> `)
    return
  }

  if (lazyTranscript()) {
    // Bind and stop: no jsonl, no records, no prompt/stop hooks — `jsonlPath` is
    // reported by the hook while the file itself does not exist. (No worktree-state
    // record either: it is a transcript write, and this mode writes nothing.)
    fireHook('start', {
      session_id: sessionId,
      transcript_path: transcript,
      cwd: startCwd,
      hook_event_name: 'SessionStart',
      source: 'startup'
    })
    process.stdout.write(`\r\n[fake-claude] session ${sessionId} bound, no transcript yet\r\n> `)
    return
  }

  fireHook('start', {
    session_id: sessionId,
    transcript_path: transcript,
    cwd: startCwd,
    hook_event_name: 'SessionStart',
    source: 'startup'
  })
  if (wtName) appendWorktreeState()

  // §6: a launch carrying `-- <text>` starts with that text already typed, so it
  // IS this session's first turn and REPLACES the canned one ENTIRELY — records, file
  // write, hooks and all. Writing the canned pair as well would leave a user and an
  // assistant record on disk that the tracker reads AFTER a `/need-approval` fired its
  // Notification: the hook is synchronous, the jsonl tail is read a beat later, and
  // `resumeWorkingIfStale` treats either record as new work — clearing the approval
  // marker ~400 ms after it appeared. The real claude writes a turn's records BEFORE
  // it asks for permission, which is the order this keeps. One tick later, because the
  // handler and the state it reads are declared further down.
  if (firstPrompt) {
    setImmediate(() => handleLine(firstPrompt))
    renderStatusline()
    process.stdout.write(`\r\n[fake-claude] session ${sessionId} ready in ${cwd}\r\n> `)
    return
  }

  const noteRel = 'NOTES.md'
  const noteBody = '# Session notes\n\nWritten by the fake claude session for the E2E run.\n'
  fs.writeFileSync(path.join(cwd, noteRel), noteBody)
  const meta = usageMeta()
  append([
    { type: 'user', message: { role: 'user', content: 'Set up the project notes' }, cwd },
    // both title record shapes a real transcript carries: the tracker titles running
    // sessions from `ai-title`, the aggregator titles cold rows from `summary`
    // (logic.md §6 title chain) — one without the other makes a row rename itself
    // the moment it goes cold
    { type: 'ai-title', aiTitle: sessionTitle() },
    { type: 'summary', summary: sessionTitle() },
    {
      type: 'assistant',
      version: '9.9.9-fake',
      requestId: meta.requestId,
      timestamp: new Date().toISOString(),
      message: {
        role: 'assistant',
        id: meta.id,
        model: meta.model,
        content: [
          { type: 'text', text: 'Creating NOTES.md.' },
          { type: 'tool_use', name: 'Write', input: { file_path: noteRel, content: noteBody } }
        ],
        usage: meta.usage
      },
      cwd
    }
  ])
  fireHook('prompt', { hook_event_name: 'UserPromptSubmit' })
  fireHook('stop', { hook_event_name: 'Stop' })
  renderStatusline()

  process.stdout.write(`\r\n[fake-claude] session ${sessionId} ready in ${cwd}\r\n> `)
}

const startDelay = delayMs()
if (startDelay > 0) {
  process.stdout.write(`\r\n[fake-claude] delayed bind in ${startDelay}ms\r\n`)
  setTimeout(startupTurn, startDelay)
} else {
  startupTurn()
}

// --- interactive loop -----------------------------------------------------------
function shutdown(reason) {
  fireHook('end', { session_id: sessionId, transcript_path: transcript, cwd, reason })
  process.exit(0)
}

/** Uncommitted files in the worktree this session runs in — its own NOTES.md counts,
 *  exactly as the real thing counts what claude wrote during the session. */
function dirtyCount() {
  return git('status --porcelain', cwd).split('\n').filter(Boolean).length
}

/** CC's own cleanup on leaving a worktree session: the checkout AND its branch go. */
function removeWorktree() {
  git(`worktree remove --force ${JSON.stringify(cwd)}`, launchCwd)
  git(`branch -D ${JSON.stringify('worktree-' + wtName)}`, launchCwd)
}

// the lifecycle contract §4.2 (E2/E7b/E8): leaving a worktree session cleans up after itself —
// silently when the checkout is clean, through a two-choice prompt when it is not
// (Keep is the default; Remove takes the dirty files with it). Either way the process
// EXITS and reports prompt_input_exit — there is no in-place rebirth.
let worktreeChoicePending = false
function exitSession() {
  if (!wtName) return shutdown('prompt_input_exit')
  const dirty = dirtyCount()
  if (!dirty) {
    removeWorktree()
    return shutdown('prompt_input_exit')
  }
  worktreeChoicePending = true
  process.stdout.write(
    `\r\nExiting worktree session\r\n` +
      `You have ${dirty} uncommitted file(s) in this worktree\r\n` +
      `1. Keep worktree\r\n` +
      `2. Remove worktree\r\n> `
  )
}

/**
 * Env for a `/open` spawn. Koloft's open shim must still be found FIRST (that is the
 * whole point of the command), but whatever the shim decides to pass through must
 * land in the suite's recording fake `open` — never in the machine's real
 * /usr/bin/open, which would launch an actual browser/app on the developer's Mac.
 * In a pty Koloft spawns itself only the shim dir is re-pinned ahead of /usr/bin
 * (macOS path_helper hoists the system dirs in a login shell), so the fake — which
 * lives beside this script — is re-inserted right after the shim dirs, exactly the
 * `PATH="$shim:$fakebin:$PATH"` order the shell-driven specs type by hand.
 */
function openEnv() {
  const parts = (process.env.PATH || '').split(':').filter(Boolean)
  const isShimDir = (d) => {
    try {
      return fs.readFileSync(path.join(d, 'open'), 'utf8').includes('koloft open shim')
    } catch {
      return false
    }
  }
  const selfDir = path.dirname(process.argv[1] || '')
  const PATH = [...parts.filter(isShimDir), selfDir, ...parts].join(':')
  return { ...process.env, PATH }
}

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', handleLine)
// A named function, not the inline listener it used to be, so the startup turn can run
// a `--` first message through EXACTLY the path a typed line takes (§6).
function handleLine(line) {
  const text = line.trim()
  if (worktreeChoicePending) {
    // anything but an explicit 2 keeps the checkout — ⏎ on the real prompt is Keep
    if (text === '2') removeWorktree()
    return shutdown('prompt_input_exit')
  }
  if (text === '/exit' || text === 'exit' || text === '/quit') return exitSession()
  if (text === '/clear') {
    // The in-TUI id swap (T-CAN-04 shape): SessionEnd(reason=clear) WITHOUT exiting,
    // then a brand-new id + transcript, then SessionStart(source=clear). The empty jsonl
    // is written STRAIGHT AWAY rather than lazily — contract ledger §2 measured `/clear`
    // as the one exception to CC's create-at-first-message rule — and it stays empty
    // until the next prompt.
    fireHook('end', { session_id: sessionId, transcript_path: transcript, cwd, reason: 'clear' })
    sessionId = require('crypto').randomUUID()
    transcript = path.join(projDir, sessionId + '.jsonl')
    fs.writeFileSync(transcript, '')
    fireHook('start', {
      session_id: sessionId,
      transcript_path: transcript,
      cwd,
      hook_event_name: 'SessionStart',
      source: 'clear'
    })
    process.stdout.write(`\r\n[fake-claude] cleared -> session ${sessionId}\r\n> `)
    return
  }
  if (text.startsWith('/enter-worktree ') || text === '/exit-worktree') {
    const entering = text !== '/exit-worktree'
    const name = entering ? text.slice('/enter-worktree '.length).trim() : ''
    if (entering && !name) return void process.stdout.write('> ')
    const dest = entering ? makeWorktree(name) : launchCwd
    if (!dest) return void process.stdout.write('> ')
    // the move itself: ONE rename into the destination's slug, keeping the inode
    const destDir = slugDir(dest)
    fs.mkdirSync(destDir, { recursive: true })
    const moved = path.join(destDir, path.basename(transcript))
    if (fs.existsSync(transcript)) fs.renameSync(transcript, moved)
    else fs.writeFileSync(moved, '')
    transcript = moved
    // claude keeps reporting the worktree's cwd on the way IN; on the way OUT it never
    // reports a directory again (F1), so `cwd` deliberately stays where it was
    if (entering) cwd = dest
    append([
      { type: 'relocated', sessionId, relocatedCwd: dest },
      {
        type: 'worktree-state',
        sessionId,
        worktreeSession: entering
          ? {
              originalCwd: launchCwd,
              preEnterOriginalCwd: launchCwd,
              worktreePath: dest,
              worktreeName: name,
              worktreeBranch: 'worktree-' + name,
              originalBranch: 'main',
              originalHeadCommit: git('rev-parse HEAD', launchCwd),
              sessionId
            }
          : null
      }
    ])
    // and NOT A SINGLE HOOK — this is the whole point of the case
    process.stdout.write(`\r\n[fake-claude] ${entering ? 'entered' : 'left'} ${dest}\r\n> `)
    return
  }
  if (text === '/compact') {
    // The in-place restart (the lifecycle contract V5 / D2): SessionEnd then SessionStart with
    // source 'compact' on the SAME id and the SAME transcript, so the rebind guard
    // (nextId !== prevId) makes it a no-op for list membership. The end reason real
    // claude reports here is unverified (V5 stays open) — 'other' is the fail-safe
    // choice: it can never hit D1's removal whitelist.
    fireHook('end', { session_id: sessionId, transcript_path: transcript, cwd, reason: 'other' })
    fireHook('start', {
      session_id: sessionId,
      transcript_path: transcript,
      cwd,
      hook_event_name: 'SessionStart',
      source: 'compact'
    })
    process.stdout.write(`\r\n[fake-claude] compacted -> session ${sessionId}\r\n> `)
    return
  }
  if (text.startsWith('/resume ')) {
    // The in-TUI switch to another conversation: adopt the target id and its existing
    // jsonl (same bucket), announce it with SessionStart(source=resume). No SessionEnd
    // for the abandoned id — matching the real TUI (T-CAN-04).
    const target = text.slice('/resume '.length).trim()
    if (!target) return void process.stdout.write('> ')
    sessionId = target
    transcript = path.join(projDir, sessionId + '.jsonl')
    if (!fs.existsSync(transcript)) fs.writeFileSync(transcript, '')
    fireHook('start', {
      session_id: sessionId,
      transcript_path: transcript,
      cwd,
      hook_event_name: 'SessionStart',
      source: 'resume'
    })
    process.stdout.write(`\r\n[fake-claude] resumed session ${sessionId}\r\n> `)
    return
  }
  if (text === '/bg-work') {
    // Simulate a turn that spawns a BACKGROUND subagent and ends while it still
    // runs: spawn ack (real transcript shape: toolUseResult.status async_launched
    // + tool_result block) → Stop; then the agent's own transcript grows under
    // <session-id>/subagents/ for ~5s; finally the delivered task-notification
    // (origin.kind, terminal status) + a wrap-up turn → Stop.
    fireHook('prompt', { hook_event_name: 'UserPromptSubmit' })
    const bgToolUseId = 'toolu_bg_e2e'
    const meta = usageMeta()
    append([
      { type: 'user', message: { role: 'user', content: text }, cwd },
      {
        type: 'assistant',
        version: '9.9.9-fake',
        requestId: meta.requestId,
        timestamp: new Date().toISOString(),
        message: {
          role: 'assistant',
          id: meta.id,
          model: meta.model,
          content: [{ type: 'tool_use', id: bgToolUseId, name: 'Agent', input: { prompt: 'bg' } }],
          usage: meta.usage
        },
        cwd
      },
      {
        type: 'user',
        timestamp: new Date().toISOString(),
        toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'abg_e2e' },
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: bgToolUseId, content: 'Spawned successfully.' }
          ]
        },
        cwd
      }
    ])
    fireHook('stop', { hook_event_name: 'Stop' })

    const subDir = path.join(projDir, sessionId, 'subagents')
    fs.mkdirSync(subDir, { recursive: true })
    const subFile = path.join(subDir, 'agent-abg_e2e.jsonl')
    let steps = 0
    const iv = setInterval(() => {
      steps += 1
      fs.appendFileSync(
        subFile,
        JSON.stringify({
          type: 'assistant',
          timestamp: new Date().toISOString(),
          agentId: 'abg_e2e',
          isSidechain: true,
          message: { role: 'assistant', content: [{ type: 'text', text: `bg step ${steps}` }] }
        }) + '\n'
      )
      if (steps >= 10) {
        clearInterval(iv)
        const done = usageMeta()
        append([
          // how CURRENT claude delivers a terminal task-notification: a
          // `queue-operation` the moment the task reports, then an `attachment`
          // record carrying it into the conversation. (Pre-2.1.18x used a user
          // record with origin.kind — covered by the unit suite.)
          {
            type: 'queue-operation',
            operation: 'enqueue',
            timestamp: new Date().toISOString(),
            content: taskNotification(bgToolUseId, 'completed', 'background work done')
          },
          {
            type: 'attachment',
            timestamp: new Date().toISOString(),
            attachment: {
              type: 'queued_command',
              prompt: taskNotification(bgToolUseId, 'completed', 'background work done'),
              commandMode: 'task-notification'
            },
            cwd
          },
          {
            type: 'assistant',
            version: '9.9.9-fake',
            requestId: done.requestId,
            timestamp: new Date().toISOString(),
            message: {
              role: 'assistant',
              id: done.id,
              model: done.model,
              content: [{ type: 'text', text: 'Background work finished.' }],
              usage: done.usage
            },
            cwd
          }
        ])
        fireHook('stop', { hook_event_name: 'Stop' })
        process.stdout.write('[fake-claude] bg-work finished\r\n> ')
      }
    }, 500)
    process.stdout.write('[fake-claude] bg-work running\r\n> ')
    return
  }
  if (text === '/bg-reported') {
    // A turn that ends with background work Claude Code reports ITSELF, in the
    // Stop payload's `background_tasks` — and with NO spawn ack in the transcript
    // at all. That is the shape any launch Koloft does not recognise produces (a
    // forked skill, a teammate, whatever CC adds next), so nothing but the
    // reported count can hold the dot here. A second Stop reports an empty list
    // and must land the turn-end at once.
    fireHook('prompt', { hook_event_name: 'UserPromptSubmit' })
    const meta = usageMeta()
    append([
      { type: 'user', message: { role: 'user', content: text }, cwd },
      {
        type: 'assistant',
        version: '9.9.9-fake',
        requestId: meta.requestId,
        timestamp: new Date().toISOString(),
        message: {
          role: 'assistant',
          id: meta.id,
          model: meta.model,
          content: [{ type: 'text', text: 'kicked it off' }],
          usage: meta.usage
        },
        cwd
      }
    ])
    fireHook('stop', {
      hook_event_name: 'Stop',
      background_tasks: [
        { id: 'arep_e2e', type: 'subagent', status: 'running', description: 'reported work' }
      ]
    })
    setTimeout(() => {
      const done = usageMeta()
      append([
        {
          type: 'assistant',
          version: '9.9.9-fake',
          requestId: done.requestId,
          timestamp: new Date().toISOString(),
          message: {
            role: 'assistant',
            id: done.id,
            model: done.model,
            content: [{ type: 'text', text: 'reported work finished.' }],
            usage: done.usage
          },
          cwd
        }
      ])
      fireHook('stop', { hook_event_name: 'Stop', background_tasks: [] })
      process.stdout.write('[fake-claude] bg-reported finished\r\n> ')
      // 5s, matching the sibling scenarios: the spec's sampling loop only starts
      // once the working dot appears, and a dropped fs.watch event can delay that
      // by a full status-log poll (2s) — a shorter window would push the last
      // sample past the legitimate second Stop and flake on a correct waiting dot
    }, 5000)
    process.stdout.write('[fake-claude] bg-reported running\r\n> ')
    return
  }
  if (text === '/bg-monitor') {
    // A turn that leaves a persistent Monitor behind. Its ack is the only place
    // the shape says "Monitor" ({taskId, timeoutMs: 0, persistent: true}); the
    // Stop list calls it a plain shell. Koloft parks it: the dot rests, and the
    // row shows what was left running so the user can go and stop it.
    fireHook('prompt', { hook_event_name: 'UserPromptSubmit' })
    const monToolUseId = 'toolu_monitor_e2e'
    const meta = usageMeta()
    append([
      { type: 'user', message: { role: 'user', content: text }, cwd },
      {
        type: 'assistant',
        version: '9.9.9-fake',
        requestId: meta.requestId,
        timestamp: new Date().toISOString(),
        message: {
          role: 'assistant',
          id: meta.id,
          model: meta.model,
          content: [
            {
              type: 'tool_use',
              id: monToolUseId,
              name: 'Monitor',
              input: { command: 'tail -f bot.log' }
            }
          ],
          usage: meta.usage
        },
        cwd
      },
      {
        type: 'user',
        timestamp: new Date().toISOString(),
        toolUseResult: { taskId: 'mon_e2e', timeoutMs: 0, persistent: true },
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: monToolUseId,
              content: 'Monitor started (task mon_e2e).'
            }
          ]
        },
        cwd
      }
    ])
    fireHook('stop', {
      hook_event_name: 'Stop',
      background_tasks: [
        { id: 'mon_e2e', type: 'shell', status: 'running', description: 'tail -f bot.log' }
      ]
    })
    process.stdout.write('[fake-claude] bg-monitor parked\r\n> ')
    return
  }
  if (text === '/bg-shell') {
    // A turn that ends parked on a SHELL: the model ran a command synchronously,
    // it hit the tool timeout and was auto-backgrounded (toolUseResult carries
    // backgroundTaskId + timedOutAfterMs), then Stop. No transcript grows while
    // it runs — the spawn-ack ledger is the only thing holding the dot — until
    // the terminal notification wakes the model for a wrap-up turn.
    fireHook('prompt', { hook_event_name: 'UserPromptSubmit' })
    const shToolUseId = 'toolu_shell_e2e'
    const meta = usageMeta()
    append([
      { type: 'user', message: { role: 'user', content: text }, cwd },
      {
        type: 'assistant',
        version: '9.9.9-fake',
        requestId: meta.requestId,
        timestamp: new Date().toISOString(),
        message: {
          role: 'assistant',
          id: meta.id,
          model: meta.model,
          content: [
            { type: 'tool_use', id: shToolUseId, name: 'Bash', input: { command: 'npm test' } }
          ],
          usage: meta.usage
        },
        cwd
      },
      {
        type: 'user',
        timestamp: new Date().toISOString(),
        toolUseResult: {
          stdout: '',
          stderr: '',
          interrupted: false,
          backgroundTaskId: 'bash_e2e',
          timedOutAfterMs: 120000
        },
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: shToolUseId,
              content: 'Command timed out and was moved to the background (ID: bash_e2e).'
            }
          ]
        },
        cwd
      }
    ])
    fireHook('stop', { hook_event_name: 'Stop' })

    setTimeout(() => {
      const done = usageMeta()
      append([
        {
          type: 'attachment',
          timestamp: new Date().toISOString(),
          attachment: {
            type: 'queued_command',
            prompt: taskNotification(shToolUseId, 'completed', 'Background command completed'),
            commandMode: 'task-notification'
          },
          cwd
        },
        {
          type: 'assistant',
          version: '9.9.9-fake',
          requestId: done.requestId,
          timestamp: new Date().toISOString(),
          message: {
            role: 'assistant',
            id: done.id,
            model: done.model,
            content: [{ type: 'text', text: 'The suite passed.' }],
            usage: done.usage
          },
          cwd
        }
      ])
      fireHook('stop', { hook_event_name: 'Stop' })
      process.stdout.write('[fake-claude] bg-shell finished\r\n> ')
    }, 5000)
    process.stdout.write('[fake-claude] bg-shell running\r\n> ')
    return
  }
  if (text.startsWith('/write ')) {
    // A turn that WRITES a file mid-turn and keeps working for a beat before Stop —
    // the deterministic window T-AUX-08's always-on follow needs. The startup turn's
    // prompt→stop gap is narrower than the tracker's 500ms jsonl poll, so its Write
    // usually lands only after the run-state already left 'working'; a real claude
    // writes files while the turn is still in flight, which is what this reproduces.
    const rel = text.slice('/write '.length).trim()
    if (!rel) return void process.stdout.write('> ')
    fireHook('prompt', { hook_event_name: 'UserPromptSubmit' })
    // a real claude records an ABSOLUTE file_path; `/write /abs/path` is how a spec
    // reproduces a write outside the project root (scratchpad, sibling checkout)
    const abs = path.isAbsolute(rel) ? rel : path.join(cwd, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    const body = `# ${rel}\n\nWritten mid-turn by the fake claude session.\n`
    fs.writeFileSync(abs, body)
    const meta = usageMeta()
    append([
      { type: 'user', message: { role: 'user', content: text }, cwd },
      {
        type: 'assistant',
        version: '9.9.9-fake',
        requestId: meta.requestId,
        timestamp: new Date().toISOString(),
        message: {
          role: 'assistant',
          id: meta.id,
          model: meta.model,
          content: [
            { type: 'text', text: `Writing ${rel}.` },
            { type: 'tool_use', name: 'Write', input: { file_path: rel, content: body } }
          ],
          usage: meta.usage
        },
        cwd
      }
    ])
    setTimeout(() => {
      fireHook('stop', { hook_event_name: 'Stop' })
      process.stdout.write(`[fake-claude] wrote ${rel}\r\n> `)
    }, 2500)
    return
  }
  if (text.startsWith('/scratch ')) {
    // Deliberately transcript-silent: no prompt/stop hook, no record, no tool_use. The
    // file exists only on disk, exactly as it does when claude's Bash tool or a subagent
    // writes into the scratchpad — which is why the tree's Scratchpad node has to list
    // the dir instead of deriving it from session.files.
    const name = text.slice('/scratch '.length).trim()
    if (!name) return void process.stdout.write('> ')
    const base = process.env.KOLOFT_SCRATCHPAD_BASE || `/tmp/claude-${process.getuid?.() ?? 0}`
    const dir = path.join(base, path.basename(projDir), sessionId, 'scratchpad')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, name), `koloft_e2e_scratch_body for ${name}\n`)
    process.stdout.write(`[fake-claude] scratched ${name}\r\n> `)
    return
  }
  if (text.startsWith('/open-later ')) {
    // Same open, fired only once `<home>/go-open` appears: the spec arms it here, then
    // makes THIS session the background one, then drops the marker — so the open is
    // guaranteed to land while its own tab is not the active one. (A fixed delay would
    // race tab creation on a slow runner and fire while this tab is still active.)
    const target = text.slice('/open-later '.length).trim()
    if (!target) return void process.stdout.write('> ')
    const marker = path.join(home, 'go-open')
    const tick = setInterval(() => {
      if (!fs.existsSync(marker)) return
      clearInterval(tick)
      try {
        cp.execFileSync('open', [target], { cwd, stdio: 'ignore', env: openEnv() })
      } catch {
        /* the assertion is on what Koloft did with it, not on this call's status */
      }
    }, 200)
    process.stdout.write(`[fake-claude] armed open ${target}\r\n> `)
    return
  }
  if (text.startsWith('/open ')) {
    // Transcript-silent like /scratch. `open` is resolved through PATH from this
    // process's own env, so it hits Koloft's open shim with the session pty's
    // KOLOFT_TAB_ID / KOLOFT_OPEN_DIR — an agent-source open, not a user one.
    const target = text.slice('/open '.length).trim()
    if (!target) return void process.stdout.write('> ')
    try {
      cp.execFileSync('open', [target], { cwd, stdio: 'ignore', env: openEnv() })
      process.stdout.write(`[fake-claude] opened ${target}\r\n> `)
    } catch (e) {
      process.stdout.write(`[fake-claude] open failed ${target}: ${e.message}\r\n> `)
    }
    return
  }
  if (text === '/busy') {
    // A turn that STAYS in flight: prompt hook (-> run-state 'working') then steady
    // output for ~30s with no Stop, so a spec can act on a session that is genuinely
    // mid-turn. Ends by itself if nothing interrupts it.
    fireHook('prompt', { hook_event_name: 'UserPromptSubmit' })
    append([{ type: 'user', message: { role: 'user', content: text }, cwd }])
    let ticks = 0
    const busy = setInterval(() => {
      ticks += 1
      process.stdout.write(`[fake-claude] busy ${ticks}\r\n`)
      if (ticks >= 120) {
        clearInterval(busy)
        const meta = usageMeta()
        append([
          {
            type: 'assistant',
            version: '9.9.9-fake',
            requestId: meta.requestId,
            timestamp: new Date().toISOString(),
            message: {
              role: 'assistant',
              id: meta.id,
              model: meta.model,
              content: [{ type: 'text', text: 'Busy turn finished.' }],
              usage: meta.usage
            },
            cwd
          }
        ])
        fireHook('stop', { hook_event_name: 'Stop' })
        process.stdout.write('[fake-claude] busy finished\r\n> ')
      }
    }, 250)
    return
  }
  if (text === '/need-approval') {
    // simulate a tool call blocked on a permission prompt: the injected run-state
    // hook maps a Notification whose message mentions "permission" to 'approval'
    fireHook('notify', {
      hook_event_name: 'Notification',
      message: 'Claude needs your permission to use Bash'
    })
    process.stdout.write('[fake-claude] awaiting approval\r\n> ')
    return
  }
  if (!text) return void process.stdout.write('> ')
  fireHook('prompt', { hook_event_name: 'UserPromptSubmit' })
  const meta = usageMeta()
  append([
    { type: 'user', message: { role: 'user', content: text }, cwd },
    {
      type: 'assistant',
      version: '9.9.9-fake',
      requestId: meta.requestId,
      timestamp: new Date().toISOString(),
      message: {
        role: 'assistant',
        id: meta.id,
        model: meta.model,
        content: [{ type: 'tool_use', name: 'Read', input: { file_path: text } }],
        usage: meta.usage
      },
      cwd
    }
  ])
  fireHook('stop', { hook_event_name: 'Stop' })
  process.stdout.write(`[fake-claude] handled: ${text}\r\n> `)
}
// the lifecycle contract E6 (the finding that reversed D1): a SIGHUP'd claude — the signal ⌘W,
// a workspace removal and a Koloft quit all send — still fires SessionEnd, with reason
// 'other'. Reporting 'logout' here (the pre-v3 fixture) would make every teardown look
// like the user ending the session and silently drop the row from the list.
rl.on('close', () => shutdown('other'))
process.on('SIGTERM', () => shutdown('other'))
process.on('SIGHUP', () => shutdown('other'))
// the adoption repaint nudge is a real SIGWINCH (pty rows jiggled once the
// adopting TerminalView fits). The real claude redraws its whole alt-screen frame on
// it; this marker line is the falsifiable stand-in the reload spec polls for — it
// proves the signal crossed renderer → main → pty → child AND the fresh xterm renders
// what the child prints.
process.on('SIGWINCH', () => {
  process.stdout.write(`[fake-claude] winch ${process.stdout.columns}x${process.stdout.rows}\r\n> `)
})
