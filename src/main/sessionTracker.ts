import { EventEmitter } from 'events'
import fs from 'fs'
import path from 'path'
import os from 'os'
import type {
  ClaudeSessionInfo as SessionInfo,
  PreviewItem,
  SessionStatus,
  FileAccess,
  SessionUsage,
  ParkedItem
} from '@shared/types'
import { PLACEHOLDER_SESSION_TITLE } from '@shared/types'
import { basename } from '@shared/preview'
import { resolvePricing } from '@shared/pricing'
import { localDayKey } from '@shared/usageFormat'
import { encodeCwd } from '@shared/cwdKey'
import { projectInfoFor } from './projectInfo'
import { inspectTaskProcs, type TaskProcs } from './taskProcs'

const PROJECTS_ROOT = path.join(os.homedir(), '.claude', 'projects')
// `/tmp` is a symlink to `/private/tmp` on macOS. Resolve it once so scratchpad paths
// are spelled the same way as the session file paths canonFile realpath's — otherwise
// the same file reaches the tree under two spellings and renders twice.
const TMP_ROOT = ((): string => {
  try {
    return fs.realpathSync('/tmp')
  } catch {
    return '/tmp'
  }
})()
const MAX_FILES = 300
// A session's Task-subagent transcripts live in a sibling `<session-id>/subagents/`
// tree and carry real priced usage (ccusage globs them; we tail them too). Re-listing
// that dir is throttled to this cadence and otherwise piggybacks the main jsonl's
// watch cycle — a subagent's tool_result is written back to the MAIN transcript when it
// finishes, so its full spend is captured no later than that turn boundary.
const SUBAGENT_SCAN_MS = envMs('KOLOFT_SUBAGENT_SCAN_MS', 5000)
// coalesce session updates: high-frequency log growth during a task would
// otherwise fire one IPC + renderer re-render per 500ms watch tick per session
const EMIT_THROTTLE_MS = 500
// a session that has been 'waiting' on the user this long downgrades to 'idle'
const IDLE_MS = envMs('KOLOFT_IDLE_MS', 4 * 60_000)
// an 'idle' session this long is closed for you. Measured: idle claude
// processes, ~2 days old, 185–350 MB each.
const AUTO_CLOSE_MS = envMs('KOLOFT_IDLE_CLOSE_MS', 30 * 60_000)
// after the Stop hook sets 'waiting', the final assistant message it fired right
// after still trails into our jsonl parse (watchFile interval + emit throttle). Only
// treat *later* assistant output as resumed work, so that settling tail can't bounce
// the dot back to 'working'. A genuine new user prompt bypasses this window entirely.
const RESUME_AFTER_STOP_MS = envMs('KOLOFT_RESUME_AFTER_STOP_MS', 2000)
// Background work (background subagents, teammates, Workflow runs, cloud agents,
// background shells, monitors) outlives the main loop's Stop — each task's
// completion re-invokes the model, so the session is still 'working' until the
// ledger drains (see isBackgroundSpawnAck / reportTurnEnd / reconcileBackground).
// Subagent transcripts that wrote within STOP_HOLD_MS of a turn-end hold it busy
// even with an empty ledger (Koloft bound mid-run, a teammate's later turn); a
// non-empty ledger holds until its tasks go silent past BG_SILENCE_MAX_MS — the
// backstop that releases a drifted ledger (a terminal notification we failed to
// parse) instead of pinning 'working' forever. The backstop is a knowing
// tradeoff: a live agent inside one silent >10min tool call is indistinguishable
// from drift and will briefly rest the dot until its next transcript write.
// Env knobs exist for the tests, which can't wait real minutes (set before
// module import, like $HOME).
const STOP_HOLD_MS = envMs('KOLOFT_STOP_HOLD_MS', 10_000)
const BG_SILENCE_MAX_MS = envMs('KOLOFT_BG_SILENCE_MS', 10 * 60_000)
// The reported-list channel (claude >= 2.1.228 sends its own task list at every
// turn-end; hooks.ts forwards it typed) replaces most of the guessing above with
// three observations — see judgeReported:
//  - a background SHELL older than this is a server / long-lived process, not a
//    step of the agent's work (product decision): it stops holding the
//    dot and is shown as parked instead. A listening TCP socket says so at once.
const SERVER_AGE_MS = envMs('KOLOFT_SERVER_AGE_MS', 30 * 60_000)
//  - a TEAMMATE whose transcript has not grown for this long is parked (idle
//    between messages), not working — Claude Code reports it 'running' either way
const TEAMMATE_QUIET_MS = envMs('KOLOFT_TEAMMATE_QUIET_MS', 60_000)
//  - the OS view of the tool shells (taskProcs: one ps + up to two lsof, ~200ms
//    of child processes) is refreshed at most this often per session
const PROCS_SCAN_MS = envMs('KOLOFT_PROCS_SCAN_MS', 5000)
// how long to wait after a transcript moved before re-rooting the session and
// saying so. Observed: 4 moves in 34 seconds, two of them 100ms apart (enter A, enter
// B, leave, enter A again) — each one clears the changed-file list, rebuilds the
// directory watch and re-diffs, so only the last move of a burst is worth landing.
const RELOCATE_SETTLE_MS = envMs('KOLOFT_RELOCATE_SETTLE_MS', 1200)

/** Claude Code encodes the session's cwd into the project dir name by replacing
 *  every non-alphanumeric character with '-'. The rule itself now lives in
 *  `@shared/cwdKey` (the workspace note files itself the same way); it is re-exported
 *  here because this module has always been where callers and tests reach for it. */
export { encodeCwd }

/** A finite non-negative number, else 0 — jsonl usage fields are occasionally absent. */
function num(x: unknown): number {
  return typeof x === 'number' && isFinite(x) && x > 0 ? x : 0
}

/** An ms knob from env, honoring an explicit 0 (`Number(v) || d` would eat it);
 *  unset/blank/whitespace/invalid/negative falls back to the default (a bare
 *  Number('') / Number(' ') is 0 — an unset-like value must not zero a window). */
function envMs(name: string, dflt: number): number {
  const v = process.env[name]
  const n = v && v.trim() ? Number(v) : NaN
  return isFinite(n) && n >= 0 ? n : dflt
}

/** Sentinel bgTasks entry for a background run we can OBSERVE (transcript growth
 *  promoted the dot) but whose spawn ack predates our bind, so no real ledger id
 *  exists. Grants the promoted hold the same silence window as a ledgered task —
 *  without it every >STOP_HOLD_MS tool call would flap the dot and fire a false
 *  turn-done. Cleared by a terminal task-notification and by hold release. */
const BG_PROMOTED = '\x00promoted'

/** One entry of Claude Code's own in-flight task list, as the Stop hook forwards it
 *  (hooks.ts `bgl`): the task id and its type label — shell / subagent / teammate /
 *  monitor / workflow / mcp-task / cloud-session / dream / auto-mode-scan (claude
 *  2.1.261; unknown labels are ignored, never counted as work). */
export interface ReportedTask {
  id: string
  type: string
  /** set on an entry a spawn ack folded in AFTER the last report (ingestSpawnAck):
   *  an OS view older than this cannot have seen the task, so its absence there
   *  is not evidence it ended. A reported entry needs none — the report's arrival
   *  refreshes the view before it is judged */
  since?: number
}

/** Parse the hook's `bgl` field (`id:type,id:type`). `undefined` in → `undefined`
 *  out (no list reported — an older claude); an empty string is an EMPTY list, which
 *  is authoritative ("nothing in flight"). */
export function parseReportedTasks(bgl: unknown): ReportedTask[] | undefined {
  if (typeof bgl !== 'string') return undefined
  const out: ReportedTask[] = []
  for (const pair of bgl.split(',')) {
    const i = pair.indexOf(':')
    if (i <= 0) continue
    out.push({ id: pair.slice(0, i), type: pair.slice(i + 1) })
  }
  return out
}

/** reported types that are an agent's own work in progress — local ones, whose
 *  transcripts show them working, and remote ones (MCP task, cloud session) with
 *  nothing local to observe; all are held from the report until the silence cap */
const AGENT_TYPES = new Set(['subagent', 'workflow', 'mcp-task', 'cloud-session'])

/** `toolUseResult.status` values that ack an agent-shaped background launch,
 *  verified against real transcripts AND the CLI's own result schemas:
 *  - async_launched   — Agent with run_in_background, and every Workflow run
 *                       (taskType 'local_workflow')
 *  - teammate_spawned — a named/team Agent (a teammate, in-process or splitpane)
 *  - remote_launched  — a cloud agent (isolation 'remote', taskType 'remote_agent') */
const BG_SPAWN_STATUSES = new Set(['async_launched', 'teammate_spawned', 'remote_launched'])

/** Task-notification statuses that mean the task is OVER. Anything else (a
 *  progress/event report) leaves the task on the ledger. 'stopped' is real:
 *  delivered for a task killed via the UI / Monitor timeout / agent teardown. */
const TERMINAL_TASK_STATUSES = new Set([
  'completed',
  'failed',
  'killed',
  'stopped',
  'cancelled',
  'canceled'
])

/**
 * Does this `toolUseResult` ack a background task? ANY live background task
 * holds the session at 'working' (product decision). Most forms
 * re-invoke the model with a terminal <task-notification> when they end, which
 * is also what retires them from the ledger — see the teammate exception below:
 *  - agent-shaped launches: status async_launched / teammate_spawned /
 *    remote_launched (background subagents, teammates, Workflows, cloud agents)
 *  - background shells: `backgroundTaskId` — plain run_in_background included,
 *    alongside timeout-auto-backgrounded and Ctrl+B-parked ones
 *  - Monitor registrations: {taskId, timeoutMs} (no status field)
 *  - skills forked into a background agent (`/code-review` & co): the Skill
 *    tool's own result shape, {status:'forked', background:true, agentId} —
 *    verified on real transcripts (claude 2.1.227). `background` is required,
 *    not decoration: the Skill tool also runs a skill in a subagent and returns
 *    its FINISHED result, and ledgering a fork that isn't backgrounded would
 *    pin the dot until the silence cap with no notification ever coming.
 * A task that never ends and never writes (a silent dev server) is released by
 * the BG_SILENCE_MAX_MS backstop — indistinguishable from ledger drift.
 *
 * Teammate exception (measured, not assumed: 149 `teammate_spawned` acks across
 * 41 recent transcripts, ZERO ever named by a <task-notification>): a teammate
 * reports through `Another Claude session sent a message: <teammate-message …>`,
 * which carries no tool-use-id, so its ledger entry is ONLY ever released by the
 * silence backstop. Consequence, unfixed here: a session that spawned a teammate
 * defers its turn-ends for up to BG_SILENCE_MAX_MS past the real end, and longer
 * still while other subagents keep refreshing lastBgActivityTs. Deliberate: a
 * teammate parked between messages is alive, not finished, and nothing on disk
 * tells the two apart.
 *
 * Known gap: an MCP tool call that auto-backgrounds (CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS)
 * has no structured marker to key on — its tool_result is the server's own payload.
 * It stays untracked — consistently so: never ledgered, so its later notification
 * retires nothing and no ledger drifts. Its state does land in
 * `<session-id>/mcp-tasks/*.meta.json`, if this ever needs to grow a channel.
 */
function isBackgroundSpawnAck(tur: unknown): boolean {
  if (!tur || typeof tur !== 'object') return false
  const r = tur as Record<string, unknown>
  if (typeof r.status === 'string' && BG_SPAWN_STATUSES.has(r.status)) return true
  if (r.status === 'forked' && r.background === true) return true
  if (typeof r.backgroundTaskId === 'string' && r.backgroundTaskId) return true
  return typeof r.taskId === 'string' && r.taskId !== '' && typeof r.timeoutMs === 'number'
}

/**
 * The `<task-notification>` payload of a record that DELIVERS one, or null.
 *
 * Claude Code has written this three ways; all are accepted because a session
 * may be resumed from a transcript an older CLI wrote:
 *  - `type:'attachment'` with `attachment.commandMode === 'task-notification'`
 *    (current: the notification entering the conversation)
 *  - `type:'queue-operation'` whose `content` is the notification (current: it
 *    is queued the moment the task reports, then removed when delivered)
 *  - `type:'user'` with `origin.kind === 'task-notification'` (pre-2.1.18x)
 *
 * Deliberately shape-bound rather than "any record containing the tag": a
 * session that greps its own transcript would otherwise retire live tasks from
 * its own tool output.
 */
function taskNotificationText(obj: any): string | null {
  if (obj?.type === 'attachment') {
    const a = obj.attachment
    return a?.commandMode === 'task-notification' && typeof a.prompt === 'string' ? a.prompt : null
  }
  if (obj?.type === 'queue-operation') {
    const c = obj.content
    return typeof c === 'string' && c.startsWith('<task-notification>') ? c : null
  }
  if (obj?.origin?.kind === 'task-notification') {
    const c = obj.message?.content
    if (typeof c === 'string') return c
    if (Array.isArray(c))
      return c.map((b: any) => (typeof b?.text === 'string' ? b.text : '')).join('\n')
    return ''
  }
  return null
}

/** Is this subagent transcript a TEAMMATE's? Its sibling `agent-<id>.meta.json`
 *  says (`taskKind: 'in_process_teammate'`, claude 2.1.261). `undefined` = not
 *  answerable yet (the meta file is missing or unparseable), so the caller asks
 *  again later — a real teammate read as "not one" would be judged idle while it
 *  works, i.e. a false turn-done. */
function readTeammateFlag(jsonl: string): boolean | undefined {
  try {
    const meta = JSON.parse(fs.readFileSync(jsonl.replace(/\.jsonl$/, '.meta.json'), 'utf8'))
    return meta?.taskKind === 'in_process_teammate'
  } catch {
    return undefined
  }
}

/** Collect every `*.jsonl` under a session's `subagents/` dir (Task/subagent
 *  transcripts nest arbitrarily deep — `subagents/workflows/<wf>/agent-*.jsonl`), so
 *  a bounded recursive walk. Cheap: the tree is tiny and we only re-list every ~5s. */
function listSubagentJsonls(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string, depth: number): void => {
    if (depth > 6 || out.length >= 500) return
    let ents: fs.Dirent[]
    try {
      ents = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of ents) {
      const full = path.join(d, e.name)
      if (e.isDirectory()) walk(full, depth + 1)
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(full)
      if (out.length >= 500) return
    }
  }
  walk(dir, 0)
  return out
}

// tools whose file_path the AI *produced/modified* — drives the 'wrote' decoration.
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
// A shell command that writes a file: a redirection to something other than /dev/null,
// tee, sed -i, touch. Claude Code logs nothing about files a Bash command touches (its
// file-history-snapshot stays empty for them), so the command text is the only trace —
// enough to say "a file changed" (liveWrites), never which one (lastWritten stays put).
const BASH_WRITES = /(^|[^0-9&])>>?\s*(?!\/dev\/null)\S|\btee\s|\bsed\s+-i\b|\btouch\s/
// file-reading tools — drives the 'read' decoration. Grep/Glob operate on dirs/globs,
// not a specific file, so they're excluded to keep 'read' file-precise.
const READ_TOOLS = new Set(['Read'])

/**
 * Claude Code's per-session scratchpad dir, or null when the session has no transcript
 * bound yet.
 *
 * Claude writes it at `<base>/<projectSlug>/<sessionId>/scratchpad`, where `<base>` is
 * `/tmp/claude-<uid>` — hardcoded in claude itself, which ignores TMPDIR (so TMP_ROOT,
 * not os.tmpdir()). `<projectSlug>` is the SAME slug as the transcript's own
 * `~/.claude/projects/<slug>/` dir, so both it and the session id are read back off
 * `jsonlPath` verbatim rather than re-derived from cwd: there is no slug algorithm to
 * keep in sync with claude's.
 *
 * The dir is created lazily (claude 2.1.227 leaves it absent until something writes
 * there), so a returned path routinely does not exist yet — callers must tolerate that.
 *
 * `KOLOFT_SCRATCHPAD_BASE` is a test-only seam (same role as `KOLOFT_CLAUDE_CMD`).
 */
export function scratchpadDirFor(jsonlPath: string | null): string | null {
  if (!jsonlPath || !jsonlPath.endsWith('.jsonl')) return null
  const sessionId = path.basename(jsonlPath, '.jsonl')
  const slug = path.basename(path.dirname(jsonlPath))
  if (!sessionId || !slug) return null
  const base =
    process.env.KOLOFT_SCRATCHPAD_BASE || path.join(TMP_ROOT, `claude-${process.getuid?.() ?? 0}`)
  return path.join(base, slug, sessionId, 'scratchpad')
}

/** claude's per-session `tasks` dir — the scratchpad's sibling, and what the tool-shell
 *  inspector reads. */
export function tasksDirOf(scratchpadDir: string): string {
  return path.join(path.dirname(scratchpadDir), 'tasks')
}

/** One tailed subagent transcript: its incremental read cursor, the last time it
 *  was seen growing (activeMs; a file frozen for a scan interval is stat'ed only
 *  on rescan ticks), and whether it belongs to a TEAMMATE — read from the sibling
 *  `.meta.json` (`taskKind: 'in_process_teammate'`), which may land a beat after
 *  the transcript, hence tri-state until it has been read. */
interface SubagentFile {
  offset: number
  tail: Buffer
  activeMs: number
  teammate?: boolean
}

/** How the session touched one file, accumulated across its tool calls. */
interface FileAcc {
  access: FileAccess
  added: number
  removed: number
}

/** the path a file-touching tool operated on, if any */
function toolFilePath(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null
  const i = input as Record<string, unknown>
  const p = i.file_path ?? i.notebook_path ?? i.path
  return typeof p === 'string' && p.length ? p : null
}

/** Count newline-delimited lines in a tool-input string; a trailing newline doesn't
 *  add a phantom empty line. Best-effort — only feeds the +N/−M decoration badge. */
function countLines(s: unknown): number {
  if (typeof s !== 'string' || s.length === 0) return 0
  let n = 1
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++
  if (s.charCodeAt(s.length - 1) === 10) n--
  return n
}

/** Best-effort lines added/removed by a write tool, from its tool_use input. Write has
 *  no prior content so `removed` is unknown (0); Edit/MultiEdit diff old vs new strings. */
function editDelta(tool: string, input: unknown): { added: number; removed: number } {
  if (!input || typeof input !== 'object') return { added: 0, removed: 0 }
  const i = input as Record<string, unknown>
  if (tool === 'Edit') return { added: countLines(i.new_string), removed: countLines(i.old_string) }
  if (tool === 'MultiEdit') {
    let added = 0
    let removed = 0
    if (Array.isArray(i.edits)) {
      for (const e of i.edits as Array<Record<string, unknown>>) {
        added += countLines(e?.new_string)
        removed += countLines(e?.old_string)
      }
    }
    return { added, removed }
  }
  if (tool === 'Write') return { added: countLines(i.content), removed: 0 }
  return { added: 0, removed: 0 } // NotebookEdit etc. — no reliable line delta
}

/** The exact text of the user record Claude Code appends when the user
 *  Esc-interrupts a turn (second variant: a tool call was in flight). NO Stop
 *  hook fires for an interrupted turn, so this record is the only turn-end
 *  evidence there is. It must never be read as a genuine new prompt: that
 *  would pin 'working' forever (no Stop ever comes), and from 'approval' it
 *  would actively PROMOTE the dot to working via the stale-recovery path. */
export const INTERRUPT_TEXTS = new Set([
  '[Request interrupted by user]',
  '[Request interrupted by user for tool use]'
])

// The TUI replaces a pasted image in the user's typed text with a placeholder token —
// `[Image #1]`, `[Image #2]`, or a bare `[Image]` — which also lands inside
// `<command-args>` when a skill/command is invoked with an image-only argument. The
// token carries no title meaning; without removing it an image-only prompt (or
// `/cmd <pasted image>`) would title the session literally `[Image #1]`.
const IMAGE_PLACEHOLDER = /\[Image(?: #\d+)?\]/g

/** Classify a user-message's text into `{ genuine, title, commandArgs, commandName }`.
 *
 *  `genuine` — is this a real new-work prompt (drives the run-state 'user' activity
 *  signal that resumes a stale dot)? A slash command / skill invocation arrives as a
 *  block of `<command-*>` tags with the real intent in `<command-args>`; it counts
 *  when it carries args (even an image-only `[Image #1]` arg) and not when argless
 *  (e.g. `/clear`). Bash (`!cmd`) echoes, the skill-body preamble, and empty/tool-result
 *  bodies are plumbing, not prompts.
 *
 *  `title` — the display title from a PLAIN prompt, or null when there's no usable
 *  text. The TUI substitutes a pasted image in the user's typed text with a placeholder
 *  token; stripping it means a prompt whose only visible text is an image yields a null
 *  title (letting the next genuine prompt / ai-title / sidecar win) instead of titling
 *  the session `[Image #1]`, while still reporting `genuine: true` so the activity
 *  signal is preserved. The token is replaced with '' (not a space) so a mid-text CJK
 *  paste — `你好[Image #1]世界` — doesn't gain a space the user never typed; only the
 *  2+-space runs the removal leaves behind are collapsed, so ordinary prompts keep
 *  their exact spacing.
 *
 *  `commandArgs` — a slash command's `<command-args>` text, image tokens stripped. A
 *  MID-priority title fallback, never `title`: for a skill (`/spec add a feature`) the args
 *  are the intent and may title an args-only session, but for a parameter command
 *  (`/model opus`) they are a config value — pinning them as the first prompt froze
 *  the title at "opus" for good, blocking the user's actual first message. */
export function classifyUserPrompt(text: string): {
  genuine: boolean
  title: string | null
  /** a slash command's args — a MID-priority title fallback (below any plain
   *  prompt, above the bare command name), so a later real prompt re-titles */
  commandArgs: string | null
  /** an argless slash command's name (`/release-dmg`) — a LOWEST-priority title
   *  fallback (see recompute), so it can never block a later genuine prompt */
  commandName: string | null
} {
  let candidate: string
  let isCommand = false
  let commandName: string | null = null
  if (/^<command-(name|message|args|contents)>/.test(text)) {
    // The wrapper's tag order is a claude implementation detail that has already
    // changed once (<command-message> now precedes <command-name>), so accept any of
    // the KNOWN wrapper tags first — but only those: a genuine pasted prompt can
    // legitimately start with an arbitrary `<command-…>` token (e.g. XML/doc text).
    isCommand = true
    const m = text.match(/<command-args>([\s\S]*?)<\/command-args>/)
    candidate = m ? m[1] : ''
    // A truly argless command (`/release-dmg`) carries no intent text at all — its
    // name beats the generic placeholder. Image-only args instead keep the null title
    // (the pasted image is the intent; let the next genuine prompt / ai-title /
    // sidecar win), so this keys on the pre-strip args.
    if (!candidate.trim())
      commandName = text.match(/<command-name>([\s\S]*?)<\/command-name>/)?.[1]?.trim() || null
  } else if (
    /^<(bash-input|bash-stdout|bash-stderr|local-command)/.test(text) ||
    text.startsWith('Base directory for this skill')
  ) {
    return { genuine: false, title: null, commandArgs: null, commandName: null }
  } else {
    candidate = text
  }
  const genuine = candidate.trim().length > 0
  const stripped = candidate.replace(IMAGE_PLACEHOLDER, '')
  if (stripped !== candidate) candidate = stripped.replace(/[ \t]{2,}/g, ' ')
  const usable = candidate.trim() || null
  return {
    genuine,
    title: isCommand ? null : usable,
    commandArgs: isCommand ? usable : null,
    commandName
  }
}

export interface RemoteTab {
  host: string
  /** the mirror root standing in for ~/.claude/projects for this machine */
  projectsRoot: string
  /** `k-<the session id claude is driving>` — the hook renames the tmux session on
   *  every in-TUI /clear, and index.ts moves this with it, so the heartbeat's
   *  liveness, the kill and the restart all name the session that is really there */
  tmuxName: string
}

interface Tracked {
  info: SessionInfo
  // --- incremental parse state (reset on (re)bind via resetParseState) ---
  /** bytes of the bound jsonl already consumed */
  readOffset: number
  /** trailing bytes after the last '\n' (a line still being written); kept as a
   *  Buffer so a multi-byte UTF-8 char split across reads is never corrupted */
  tailBuf: Buffer
  title: string | null
  firstPrompt: string | null
  /** first command's `<command-args>`, the mid-priority title fallback: above the
   *  command name, below firstPrompt — so `/model opus` shows "opus" only until
   *  the user's actual first prompt lands */
  commandArgsTitle: string | null
  /** argless-command name, the lowest-priority title fallback (below firstPrompt) */
  commandTitle: string | null
  /** absolute tool path -> how the session touched it (read/wrote + line deltas),
   *  accumulated across the session. R12: a relative path is resolved ONCE, against the
   *  cwd of the record that named it (ingestLine), so the list keeps meaning the files
   *  that were really touched after the session moves; recompute only stat-filters. */
  candidates: Map<string, FileAcc>
  /** resolved-abs -> canonical (realpath'd) abs. Only *positive* (regular-file) results
   *  are cached, so a path that doesn't exist yet is re-checked on later ticks and gets
   *  decorated once the agent creates it. Cleared on (re)bind via resetParseState. */
  fileCache: Map<string, string>
  /** absolute path of the most recently read/written file — info.lastTouched once it
   *  passes the is-a-real-file filter */
  lastTouchedAbs: string | null
  /** absolute path of the most recently *written* file — likewise info.lastWritten */
  lastWrittenAbs: string | null
  /** the in-flight parse run's promise — doubles as the re-entrancy guard
   *  (set while a run is active, cleared in its finally), so a caller that must
   *  observe freshly appended bytes (reportTurnEnd) awaits the coalesced run
   *  instead of getting an instant no-op resolve */
  parsePromise?: Promise<void>
  parseAgain: boolean
  /** bumped by hook-driven setStatus only (prompt / approval / rebind seed) —
   *  never by the tracker's own recovery transitions (applyStatus), and never
   *  by jsonl records (a record has no ordering anchor against an in-flight
   *  Stop decision). An in-flight reportTurnEnd discards itself when this
   *  moved: its Stop belongs to a turn that is no longer the latest. */
  statusSeq: number
  /** false until the initial catch-up parse of a freshly bound jsonl is done; while
   *  false, user/assistant lines are historical replay and must NOT drive run-state
   *  (otherwise resuming an idle session would flip it to 'working' from old turns) */
  caughtUp: boolean
  /** epoch ms the current `info.status` was last set; lets a content-derived 'working'
   *  recovery skip the trailing parse of the bytes the Stop hook fired right after */
  statusSince: number
  /** pending 'waiting' -> 'idle' downgrade; cleared on any new run-state */
  idleTimer?: ReturnType<typeof setTimeout>
  autoCloseTimer?: ReturnType<typeof setTimeout>
  /** this tab's own fs.watchFile listeners, kept so cleanup/rebind removes exactly
   *  ours — two tabs may co-watch one jsonl when both drive the same session, and
   *  fs.unwatchFile(path) with no listener would tear down the sibling's watch too */
  jsonlListener?: () => void
  titleListener?: () => void
  // --- usage accumulation (per bound session; reset on rebind via resetParseState) ---
  /** `message.id requestId` of every counted assistant record — streaming rewrites
   *  the same usage object several times, so this dedups (else cost multiplies). Only
   *  records with at least one id component are keyed here (see accumulateUsage). */
  usageSeen: Set<string>
  /** true once any usage record has been counted — the emit gate (a valid id-less
   *  record can be counted without ever entering usageSeen, so size is not the gate) */
  usageAny: boolean
  usageInTok: number
  usageOutTok: number
  usageCacheWriteTok: number
  usageCacheReadTok: number
  /** running session cost; only meaningful while !usageUnknownModel */
  usageCostUsd: number
  /** any counted record used an unpriced model → the $ total is unreliable, omit it */
  usageUnknownModel: boolean
  /** latest counted record's model id + context tokens (input + cache_read + cache_creation) */
  usageModel?: string
  usageCcVersion?: string
  usageCtxTokens?: number
  /** today's cost keyed by the local day of the records that produced it */
  usageToday: { dayKey: string; cost: number }
  /** subagent jsonl path -> its own incremental read cursor + last-seen-growing time
   *  (activeMs; a file frozen for a scan interval is stat'ed only on rescan ticks).
   *  Their usage folds into the SAME accumulators above (cross-file dedup is
   *  automatic via message.id). */
  subagentFiles: Map<string, SubagentFile>
  /** epoch ms of the last subagents-dir listing (throttled to SUBAGENT_SCAN_MS) */
  subagentScanMs: number
  /** tool_use ids of live-observed background tasks (Agent run_in_background /
   *  Workflow runs) — see ingestBackgroundMarkers. Spawns replayed from a
   *  resumed/forked transcript's history are deliberately NOT counted: their
   *  processes died with the previous claude, and an orphan entry here would pin
   *  the dot at 'working'. */
  bgTasks: Set<string>
  /** newest RECORD timestamp seen across subagent transcripts + background spawn
   *  acks — record time, not fold time, so catching up a historical file never
   *  reads as live background activity. Capped at the local clock: a skewed
   *  future timestamp must not pin bgBusy via a negative quiet interval. */
  lastBgActivityTs: number
  /** newest record timestamp seen in the MAIN transcript (same capping). A sync
   *  subagent's trailing writes are always followed by its tool_result/wrap-up
   *  here, while a live background agent keeps writing after the main file went
   *  quiet — so lastBg > lastMain is what makes subagent recency mean
   *  "background", not "a foreground Task that just finished". */
  lastMainActivityTs: number
  /** epoch ms this FILE was first bound (preserved across a truncation reset —
   *  a rotation must not reclassify live-observed spawn acks as historical);
   *  catch-up records stamped after this moment are live, not history */
  bindMs: number
  /** epoch ms of the most recent parse-state reset (bind OR truncation) — the
   *  cutoff separating replayed records from ones genuinely written after the
   *  reset (a new prompt landing inside a post-truncation catch-up batch) */
  resetMs: number
  /** a turn-end (Stop / idle nudge) arrived while background work was busy;
   *  'waiting' is deferred until the background drains (reconcileBackground) */
  stopPending: boolean
  /** Claude Code's own in-flight task list from the latest turn-end that carried
   *  one (hooks.ts `bgl`), minus ids a terminal task-notification retired since.
   *  THE authority on what is in flight; re-judged every parse cycle
   *  (judgeReported) because what it means changes with time — a shell dies, a
   *  teammate goes quiet, a shell turns out to be a server. null until a list
   *  is reported (older claude: the inferred ledger applies). */
  reported: ReportedTask[] | null
  /** when the current `reported` list arrived — an agent it names is fresh from
   *  that moment even before its transcript has written a byte */
  reportedAt: number
  /** task ids the transcript's Monitor acks named (`toolUseResult.taskId`, plus
   *  the ids of shells moved to the background) → the command that started them.
   *  A Monitor is reported as a plain 'shell', and its ack is the only way to
   *  tell; the command is what the parked badge shows. */
  taskCmds: Map<string, string>
  monitorIds: Set<string>
  /** tool_use id → Bash/Monitor command, kept until its ack arrives (bounded) */
  toolCmds: Map<string, string>
  /** latest OS view of the tool shells under this tab's claude (taskProcs), and
   *  when it was taken; null = not inspected yet or could not tell */
  procs: TaskProcs | null
  procsAt: number
  procsPromise?: Promise<void>
  /** fold time of the newest growth seen in any teammate's transcript */
  teammateActiveMs: number
  /** record timestamp of the newest live Esc-interrupt record — compared against
   *  statusSince so a hook transition that raced ahead of the fold outranks it */
  lastInterruptTs: number
  /** a non-compact SessionStart arrived with NO hook cwd: the next parse batch's
   *  newest logged cwd finalizes `info.treeRoot` (the transcript replays oldest-first,
   *  so per-line pinning would root a resumed session at dead history) */
  rootPinAwaitingCatchup: boolean
  /** the bound transcript's identity on disk — the signal that the session moved to
   *  another checkout; never set for a remote tab. See followRelocation. */
  inode?: number
  /** the whole of Claude's storage has been searched for this transcript and it is
   *  nowhere: stop searching until our own path stats again (followRelocation) */
  swept?: boolean
  /** the directory named by the newest `relocated` record — where a move landed, folded
   *  in as it arrives and read only when the transcript actually moves (see land) */
  relocatedCwd?: string
  /** the settle timer for a move that has not been landed yet */
  landTimer?: ReturnType<typeof setTimeout>
  /** set for a tab whose claude runs on another machine: its transcripts arrive in a
   *  mirror under userData, so nothing here may walk the local disk for it. */
  remote?: RemoteTab
  /** periodic poll while bound: subagent transcripts grow with NO main-jsonl write
   *  (their result reaches the main file only at the next turn boundary), so the
   *  main watchFile alone would freeze their spend until the user prompts again */
  subagentTimer?: ReturnType<typeof setInterval>
}

/** Incrementally read the bytes appended past `cur.offset`, splice the carried-over
 *  partial line in front, and split off the complete lines. Advances the cursor and
 *  keeps the trailing partial in `cur.tail` (copied so the big read buffer isn't
 *  retained). Shared by the main-jsonl and subagent tails so the subtle parts —
 *  short reads, the 0x0a split (never inside a multi-byte UTF-8 sequence), the
 *  tail copy — exist once. Also drains the hooks' append-only run-state log
 *  (index.ts). Returns null on read failure (cursor untouched). */
export async function readAppendedLines(
  file: string,
  size: number,
  cur: { offset: number; tail: Buffer }
): Promise<string[] | null> {
  let newBytes: Buffer
  let fh: fs.promises.FileHandle | undefined
  try {
    fh = await fs.promises.open(file, 'r')
    const len = size - cur.offset
    newBytes = Buffer.allocUnsafe(len)
    const { bytesRead } = await fh.read(newBytes, 0, len, cur.offset)
    if (bytesRead < len) newBytes = newBytes.subarray(0, bytesRead)
  } catch {
    return null
  } finally {
    await fh?.close()
  }
  cur.offset += newBytes.length
  const buf = cur.tail.length ? Buffer.concat([cur.tail, newBytes]) : newBytes
  const lastNl = buf.lastIndexOf(0x0a)
  if (lastNl === -1) {
    cur.tail = Buffer.from(buf) // still no complete line; keep buffering
    return []
  }
  cur.tail = Buffer.from(buf.subarray(lastNl + 1))
  return buf.toString('utf8', 0, lastNl).split('\n')
}

/**
 * Binds each app terminal tab to the Claude session it is currently driving.
 *
 * Binding is entirely explicit: the injected SessionStart hook reports the
 * transcript claude is writing (`bindSession`), which covers launch, `--resume`,
 * and the in-TUI `/resume` and `/clear` — every path that changes the session
 * fires the hook again and re-binds. Nothing is inferred from the filesystem, so
 * two tabs in the same cwd can never cross-bind and the app's own parent session
 * (when Koloft is launched from inside Claude Code) is never picked up by accident.
 *
 * Binding imposes no *exclusive* ownership: two tabs may legitimately drive the
 * *same* session (e.g. `claude --resume <id>` in a second terminal). The hook
 * attaches both tabs to the one jsonl, and each tab keeps its own watch listeners
 * so closing one never tears down the other's.
 */
export class SessionTracker extends EventEmitter {
  private tracked = new Map<string, Tracked>() // key: tabId
  // balancer picks answered before the shim registers the session (the pick section
  // runs first inside the shim) — applied when track() creates the entry
  private pendingPicked = new Map<string, string>()
  private emitTimer?: ReturnType<typeof setTimeout>
  private lastEmitMs = 0
  /** the OS pid of a tab's pty process — claude itself (a session pty runs `exec
   *  claude`); wired by index.ts, absent in unit tests, in which case no
   *  tool-shell inspection runs and reported shells are trusted */
  pidOf?: (tabId: string) => number | undefined
  /** the tool-shell inspector (taskProcs); replaceable so tests can stage an OS view */
  inspect: typeof inspectTaskProcs = inspectTaskProcs
  /** auto-close guards, wired by index.ts and absent unless a test stages them. */
  activeTabId?: () => string | null
  heldTabs?: () => ReadonlySet<string>
  needsUser?: (tabId: string) => boolean

  track(tabId: string, cwd: string, remote?: RemoteTab): void {
    const prev = this.tracked.get(tabId)
    if (prev) this.cleanup(prev)

    const info: SessionInfo = {
      tabId,
      sessionId: '',
      title: PLACEHOLDER_SESSION_TITLE,
      cwd,
      treeRoot: cwd,
      jsonlPath: null,
      files: [],
      alive: true,
      updatedAt: Date.now()
    }
    if (remote) info.remote = { host: remote.host }
    const pendingPick = this.pendingPicked.get(tabId)
    if (pendingPick) {
      info.pickedAccount = pendingPick
      this.pendingPicked.delete(tabId)
    }
    const t: Tracked = {
      info,
      readOffset: 0,
      tailBuf: Buffer.alloc(0),
      title: null,
      firstPrompt: null,
      commandArgsTitle: null,
      commandTitle: null,
      candidates: new Map(),
      fileCache: new Map(),
      lastTouchedAbs: null,
      lastWrittenAbs: null,
      parseAgain: false,
      statusSeq: 0,
      caughtUp: false,
      statusSince: 0,
      usageSeen: new Set(),
      usageAny: false,
      usageInTok: 0,
      usageOutTok: 0,
      usageCacheWriteTok: 0,
      usageCacheReadTok: 0,
      usageCostUsd: 0,
      usageUnknownModel: false,
      usageToday: { dayKey: '', cost: 0 },
      subagentFiles: new Map(),
      subagentScanMs: 0,
      bgTasks: new Set(),
      lastBgActivityTs: 0,
      lastMainActivityTs: 0,
      bindMs: Date.now(),
      resetMs: Date.now(),
      stopPending: false,
      reported: null,
      reportedAt: 0,
      taskCmds: new Map(),
      monitorIds: new Set(),
      toolCmds: new Map(),
      procs: null,
      procsAt: 0,
      teammateActiveMs: 0,
      lastInterruptTs: 0,
      rootPinAwaitingCatchup: false,
      remote
    }
    this.tracked.set(tabId, t)
    this.emitUpdate()
    // a remote cwd names a directory on the machine — resolving a worktree from it
    // would read whatever happens to sit at that path on this Mac
    if (!remote) this.resolveWorktree(t)
  }

  setAlive(tabId: string, alive: boolean): void {
    const t = this.tracked.get(tabId)
    if (t) {
      t.info.alive = alive
      t.info.updatedAt = Date.now()
      this.emitUpdate()
    }
  }

  /**
   * Set a tab's live run-state from the injected run-state hooks (UserPromptSubmit
   * -> working, permission Notification -> approval; turn-end signals go through
   * reportTurnEnd, which defers 'waiting' while background work is running).
   * 'waiting' arms an idle-downgrade timer; every other state cancels it.
   */
  setStatus(tabId: string, status: SessionStatus): void {
    const t = this.tracked.get(tabId)
    if (!t) return
    // hook-driven entry only (prompt/approval/rebind seed): this is NEW-TURN
    // evidence, so it stales any in-flight reportTurnEnd decision. The tracker's
    // own recovery transitions go through applyStatus and must NOT bump — a
    // recovery of the ENDING turn (approval→working on its trailing records)
    // is not a newer turn, and bumping there would make the guard eat the Stop.
    t.statusSeq++
    this.applyStatus(t, status)
  }

  /** The one place run-state actually changes. Writes to the GIVEN instance and
   *  refuses orphans (a re-track mid-await must not let old-session logic stamp
   *  the successor session's dot or split state across two Tracked objects). */
  private applyStatus(t: Tracked, status: SessionStatus): void {
    const tabId = t.info.tabId
    if (this.tracked.get(tabId) !== t) return
    t.stopPending = false // an explicit transition supersedes a deferred turn-end
    if (t.idleTimer) {
      clearTimeout(t.idleTimer)
      t.idleTimer = undefined
    }
    if (t.autoCloseTimer) {
      clearTimeout(t.autoCloseTimer)
      t.autoCloseTimer = undefined
    }
    if (t.info.status !== status) {
      const prev = t.info.status
      t.info.status = status
      t.info.updatedAt = Date.now()
      t.statusSince = t.info.updatedAt
      // transition event (prev → next) for the attention layer — distinct from the
      // throttled 'update' snapshot, which coalesces away exactly the edges it needs
      this.emit('status', { tabId, prev, next: status })
      this.emitUpdate()
    }
    if (status === 'waiting') {
      t.idleTimer = setTimeout(() => {
        t.idleTimer = undefined
        if (t.info.status === 'waiting') {
          t.info.status = 'idle'
          t.info.updatedAt = Date.now()
          this.emit('status', { tabId, prev: 'waiting', next: 'idle' })
          this.emitUpdate()
          this.armAutoClose(t)
        }
      }, IDLE_MS)
    }
  }

  /** the clock for one tab. The ONE place it is set, so every start and every
   *  postponement is the same full window. A remote tab gets no timer at all: its
   *  process table lives on another machine this Mac can never read. */
  private armAutoClose(t: Tracked): void {
    if (t.autoCloseTimer) clearTimeout(t.autoCloseTimer)
    t.autoCloseTimer = t.remote
      ? undefined
      : setTimeout(() => void this.tryAutoClose(t), AUTO_CLOSE_MS)
  }

  /** the tab went 'idle' AUTO_CLOSE_MS ago; close it unless something says no.
   *  The verdict is only announced; index.ts does the killing. */
  private async tryAutoClose(t: Tracked): Promise<void> {
    t.autoCloseTimer = undefined
    const tabId = t.info.tabId
    // Four reasons to keep it: you are looking at it; it is parked on purpose (server /
    // Monitor / standing teammate); the renderer holds an unsaved edit or a live
    // Workbench shell for it; it raised a "needs you" mark you have not seen yet
    // (closing clears the mark, so you would never learn it wanted you).
    const held =
      tabId === this.activeTabId?.() ||
      !!t.info.parked?.length ||
      !!this.heldTabs?.().has(tabId) ||
      !!this.needsUser?.(tabId)
    const root = this.pidOf?.(tabId)
    const scratch = t.info.scratchpadDir
    if (held || !root || !scratch) {
      this.armAutoClose(t)
      return
    }
    // NOT refreshProcs: it returns early when Claude Code's reported list holds nothing
    // inspectable, which is exactly what an idle session's list looks like.
    const procs = await this.inspect(root, tasksDirOf(scratch))
    // a timer armed while we were looking means activity landed inside that beat
    if (this.tracked.get(tabId) !== t || t.info.status !== 'idle' || t.autoCloseTimer) return
    // null = could not tell (ps failed, no claude at that pid), never "nothing running".
    if (!procs || procs.shells.size > 0) {
      this.armAutoClose(t)
      return
    }
    this.emit('auto-close', { tabId })
  }

  /** typing into an idle session, or switching to it, restarts its 30 minutes.
   *  Both land well before the hook that would move the dot off 'idle'. */
  noteActivity(tabId: string): void {
    const t = this.tracked.get(tabId)
    if (!t || t.info.status !== 'idle') return
    this.armAutoClose(t)
  }

  /**
   * A turn-end signal from the hooks (Stop, or the TUI's idle "waiting for your
   * input" nudge). NOT applied unconditionally: the main loop stops while
   * background subagents / Workflow runs are still working (each completion
   * re-invokes it), and setting 'waiting' then would both lie on the dot and fire
   * a false turn-done notification. Parse first — the spawn ack in the main jsonl
   * may trail this hook by up to a watch tick — then apply 'waiting' or defer it
   * until reconcileBackground sees the background drain.
   */
  async reportTurnEnd(tabId: string, list?: ReportedTask[]): Promise<void> {
    const t = this.tracked.get(tabId)
    if (!t) return
    const seq = t.statusSeq
    try {
      await this.parse(t)
    } catch {
      // a listener throwing mid-parse must not swallow this one-shot turn-end;
      // decide on the state we have rather than pin the dot 'working' forever
    }
    // the await may have been overtaken: a newer HOOK transition (a queued
    // prompt's UserPromptSubmit, an approval, a rebind seed) makes this Stop
    // stale — its turn is no longer the latest, and applying 'waiting' now
    // would clobber the newer state. A re-track likewise orphans the decision.
    if (this.tracked.get(tabId) !== t || t.statusSeq !== seq) return
    if (list !== undefined) {
      // Claude Code's OWN list of what is in flight, taken at the moment of this
      // turn-end (see hooks.ts). It comes from the process that owns the tasks, so
      // it outranks everything this file infers from the transcript — including a
      // ledger entry no notification will ever retire. It REPLACES the previous
      // list (plus whatever acks were folded in since): a task it no longer names
      // has ended. The OS view must postdate it — a shell reported here was
      // spawned before this Stop, so a fresh snapshot sees it; a stale one might
      // not, and would read the task as already dead.
      t.reportedAt = Date.now()
      t.reported = list
      await this.refreshProcs(t, true)
      if (this.tracked.get(tabId) !== t || t.statusSeq !== seq) return
    }
    // What holds this turn-end: the typed list, judged task by task
    // (judgeReported). A turn-end with NO payload at all — the TUI's idle nudge,
    // an Esc — while a list is on record re-judges that list rather than falling
    // back to the weaker ledger: the nudge used to do exactly that, and rested
    // the dot under live tasks the ledger had never seen (spawned before the
    // bind, or by a subagent). The inferred ledger holds only when nothing was
    // ever reported (older claude).
    const busy = t.reported ? this.judgeReported(t) : this.bgBusy(t)
    if (busy) {
      t.stopPending = true
    } else {
      t.bgTasks.clear() // nothing live ⇒ drained, drifted, or never retired
      this.applyStatus(t, 'waiting')
    }
  }

  /**
   * Is anything on Claude Code's reported list WORK IN PROGRESS right now? Also
   * refreshes the parked badge (setParked) from the same pass. Judged per type,
   * because "in flight" to Claude Code is not "working" to the user:
   *  - shell: alive iff a tool shell still holds its output file (taskProcs).
   *    A live one that listens on a port or has run past SERVER_AGE_MS is a
   *    server — parked, not work. A Monitor (its ack says so; it is reported as a
   *    plain shell) waits for events — parked. With no OS view at all (no pid,
   *    ps failed) the report is trusted, under the silence cap.
   *  - subagent / workflow / MCP task / cloud session: working, unless silent
   *    past the cap AND no tool call is in flight anywhere — their end always
   *    wakes the model, so only drift ever gets here.
   *  - teammate: reported 'running' even while idle between messages, so it is
   *    working only while its transcript grows (TEAMMATE_QUIET_MS) or a tool
   *    call is in flight; otherwise parked (the count is shown).
   *  - monitor (MCP/live-update watchers), dream, auto-mode scan, anything new:
   *    housekeeping, neither work nor worth a badge.
   * "A tool call in flight" = a tool shell under claude whose output file is not a
   * reported task's: a FOREGROUND command, necessarily some agent's (the main loop
   * has stopped, or we would not be judging).
   */
  private judgeReported(t: Tracked): boolean {
    const now = Date.now()
    const list = t.reported ?? []
    const procs = t.procs
    const parked: ParkedItem[] = []
    let observed = false
    let trusted = false
    const reportedIds = new Set(list.map((x) => x.id))
    const toolCallInFlight = !!procs && [...procs.shells.keys()].some((id) => !reportedIds.has(id))
    const agentsFresh = now - Math.max(t.lastBgActivityTs, t.reportedAt) < BG_SILENCE_MAX_MS
    const teammatesFresh = now - t.teammateActiveMs < TEAMMATE_QUIET_MS
    let idleTeammates = 0
    for (const task of list) {
      if (task.type === 'shell') {
        const label = t.taskCmds.get(task.id) ?? task.id
        if (t.monitorIds.has(task.id)) {
          // on the badge until a later report drops it or a task-notification
          // (a kill from the TUI, a timeout) retires it
          parked.push({ kind: 'monitor', label })
        } else if (!procs) {
          trusted = true
        } else {
          const sh = procs.shells.get(task.id)
          if (!sh) {
            // nothing holds its output file any more: it has ended — unless
            // this view predates the ack that folded it in (a shell started
            // after the last report, judged before the next 5s refresh): then
            // the view simply has not seen it yet
            if ((task.since ?? 0) > t.procsAt) observed = true
            continue
          }
          if (sh.listening || sh.ageMs >= SERVER_AGE_MS) {
            // whole minutes: the badge re-renders on change, not every 5s tick
            parked.push({ kind: 'server', label, ageMs: Math.floor(sh.ageMs / 60_000) * 60_000 })
          } else observed = true
        }
      } else if (AGENT_TYPES.has(task.type)) {
        if (agentsFresh || toolCallInFlight) observed = true
      } else if (task.type === 'teammate') {
        if (teammatesFresh || toolCallInFlight) observed = true
        else idleTeammates++
      }
    }
    if (idleTeammates) parked.push({ kind: 'teammate', label: `${idleTeammates} idle` })
    this.setParked(t, parked)
    if (observed) return true
    if (!trusted) return false
    // trusted, unobservable: the silence cap is the drift backstop for a task that
    // died without waking the model (which would have produced a fresh report)
    return this.quietMs(t) < BG_SILENCE_MAX_MS
  }

  /** Publish the parked badge when it changed. */
  private setParked(t: Tracked, items: ParkedItem[]): void {
    const next = items.length ? items : undefined
    if (JSON.stringify(next) === JSON.stringify(t.info.parked)) return
    t.info.parked = next
    t.info.updatedAt = Date.now()
    this.emitUpdate()
  }

  /** Re-take the OS view of the tool shells (taskProcs) when the reported list
   *  has something it can tell us about; throttled to PROCS_SCAN_MS unless forced.
   *  Concurrent callers share one in-flight inspection. */
  private async refreshProcs(t: Tracked, force = false): Promise<void> {
    // a remote session's shells run on the machine: this Mac's process table would
    // report every one of them as gone, and a reported task judged dead ends the turn
    if (t.remote) return
    const list = t.reported
    const observable = (x: ReportedTask): boolean =>
      x.type === 'teammate' || AGENT_TYPES.has(x.type) || x.type === 'shell'
    if (!list?.some(observable)) return
    if (t.procsPromise) await t.procsPromise
    if (!force && Date.now() - t.procsAt < PROCS_SCAN_MS) return
    const root = this.pidOf?.(t.info.tabId)
    const scratch = t.info.scratchpadDir
    if (!root || !scratch) return // no pid resolver (unit tests): reported shells are trusted
    t.procsPromise = (async () => {
      try {
        const procs = await this.inspect(root, tasksDirOf(scratch))
        if (this.tracked.get(t.info.tabId) !== t) return
        t.procs = procs
        t.procsAt = Date.now()
      } finally {
        t.procsPromise = undefined
      }
    })()
    await t.procsPromise
  }

  /** How long the session has shown no sign of life anywhere — main transcript,
   *  subagent transcripts, its own last run-state change. The one silence
   *  measure every drift backstop is judged against (a task that died without
   *  waking the model leaves no other trace of having ended). */
  private quietMs(t: Tracked): number {
    return Date.now() - Math.max(t.lastMainActivityTs, t.lastBgActivityTs, t.statusSince)
  }

  /** Is background work plausibly still running? A non-empty ledger holds until
   *  its tasks go silent past BG_SILENCE_MAX_MS (drift release). With no ledger,
   *  recent subagent-transcript writes hold the session busy only when they came
   *  AFTER the last main-transcript record: a foreground (sync) subagent's
   *  trailing writes are always followed by its tool_result/wrap-up in the main
   *  file, while a live background agent keeps writing after the main loop went
   *  quiet — without this, every turn that ran a sync Task would delay its
   *  turn-done by the hold window. */
  private bgBusy(t: Tracked): boolean {
    const quietMs = Date.now() - t.lastBgActivityTs
    if (t.bgTasks.size > 0) return quietMs < BG_SILENCE_MAX_MS
    return t.lastBgActivityTs > t.lastMainActivityTs && quietMs < STOP_HOLD_MS
  }

  /**
   * Binding from the injected SessionStart hook — the only one there is: this tab
   * is now driving `transcriptPath` (its current session's jsonl, including after
   * an in-TUI /resume or /clear that the shim never sees).
   */
  bindSession(
    tabId: string,
    transcriptPath: string,
    sessionId: string,
    cwd = '',
    account = '',
    ccVersion = '',
    source = ''
  ): void {
    const t = this.tracked.get(tabId)
    if (!t) return
    // the auth wrapper's account tag, inherited by the SessionStart hook (a child of
    // claude) — session metadata for the info card; absent when no wrapper exported it
    if (account && t.info.account !== account) {
      t.info.account = account
      t.info.updatedAt = Date.now()
      this.emitUpdate()
    }
    // the RUNNING process's version (hook env) — a resumed session's transcript tail
    // still carries the version that WROTE it, so this outranks the jsonl-derived one
    if (ccVersion && t.info.ccVersion !== ccVersion) {
      t.info.ccVersion = ccVersion
      t.info.updatedAt = Date.now()
      this.emitUpdate()
    }
    // Adopt the hook-reported cwd (the session's real dir — the worktree path for a
    // --worktree session) right away, so the worktree marker + true path show at
    // SessionStart, before claude has written its first jsonl line.
    if (cwd) {
      // A non-compact SessionStart is a genuine session boundary (launch, /clear,
      // in-TUI /resume): the hook cwd re-pins the tree root, even when equal to the
      // launch cwd — so a later jsonl drift line can never claim the pin. A compact
      // fires MID-TURN with a possibly drifted cwd and must never re-root.
      if (source !== 'compact') this.setTreeRoot(t, cwd)
      if (cwd !== t.info.cwd) {
        t.info.cwd = cwd
        t.info.updatedAt = Date.now()
        this.emitUpdate()
      }
    } else if (source !== 'compact') {
      // no hook cwd: let the next parse batch's NEWEST logged cwd finalize the pin
      t.rootPinAwaitingCatchup = true
    }
    let file = transcriptPath
    if (t.remote) {
      // the hook ran on the machine, so its transcriptPath is a path over there: only
      // the slug (its parent folder's name) carries over to this Mac's mirror
      const slug = transcriptPath
        ? path.basename(path.dirname(transcriptPath))
        : encodeCwd(cwd || t.info.cwd)
      file = sessionId ? path.join(t.remote.projectsRoot, slug, sessionId + '.jsonl') : ''
    } else if (!file && sessionId) {
      file = path.join(PROJECTS_ROOT, encodeCwd(t.info.cwd), sessionId + '.jsonl')
    }
    if (file && file !== t.info.jsonlPath) this.bind(t, file)
    // SessionStart means the session (re)started and is now awaiting the user's
    // first prompt — fires on launch, /clear, and /resume. Seed 'waiting' so a
    // freshly bound or resumed session shows the right dot before any prompt/stop
    // hook; UserPromptSubmit will flip it to 'working' the moment the user types.
    // EXCEPT source 'compact': auto-compaction fires SessionStart MID-TURN (and a
    // manual /compact fires it while already waiting) — seeding 'waiting' there
    // fakes a working→waiting edge, i.e. a phantom turn-done notification.
    if (source !== 'compact') {
      // a session boundary also retires the previous session's reported task
      // list: what /clear or /resume left running is that session's business,
      // and the next turn-end reports this one's
      t.reported = null
      this.setParked(t, [])
      this.setStatus(tabId, 'waiting')
    }
  }

  /** The multi-account balancer picked `account` for this tab's next claude launch.
   *  A pick lands BEFORE the shim registers (its pick section precedes registration),
   *  so an unknown tab stashes the name until track() creates the entry. */
  setPickedAccount(tabId: string, account: string): void {
    const t = this.tracked.get(tabId)
    if (!t) {
      this.pendingPicked.set(tabId, account)
      return
    }
    if (t.info.pickedAccount !== account) {
      t.info.pickedAccount = account
      t.info.updatedAt = Date.now()
      this.emitUpdate()
    }
  }

  untrack(tabId: string): void {
    const t = this.tracked.get(tabId)
    if (t) this.cleanup(t)
    this.tracked.delete(tabId)
    this.emitUpdate()
  }

  /** the machine a tab's claude runs on, and the names its mirror/kill paths need */
  remoteOf(tabId: string): RemoteTab | undefined {
    return this.tracked.get(tabId)?.remote
  }

  /** An in-TUI /clear moved this remote tab to a new session, and the hook renamed
   *  the tmux session over there to match — follow it here (index.ts). */
  setRemoteTmuxName(tabId: string, tmuxName: string): void {
    const t = this.tracked.get(tabId)
    if (t?.remote) t.remote.tmuxName = tmuxName
  }

  list(): SessionInfo[] {
    return [...this.tracked.values()].map((t) => t.info)
  }

  /**
   * is there a conversation ON DISK for this session right now? ⇧⌘R kills
   * the running claude before spawning `claude --resume <id>`, and that kill cannot be
   * undone, so the restart asks this first.
   *
   * `jsonlPath` alone cannot answer it: Claude Code creates the jsonl lazily, at the
   * first user message, while the SessionStart hook reports its path immediately — a
   * bound-but-never-conversed session has a path and no file. So a TABLE HIT is
   * answered by that entry's own file and nothing else (a hit whose file is gone means
   * never-written or deleted; both must refuse, and a fallback would let a same-id file
   * elsewhere re-open the gate on a conversation the user just deleted).
   *
   * A MISS — the dead-tab anchor path, where the pty and its entry are long gone —
   * goes straight to Claude's storage: one readdir plus one existsSync per bucket,
   * by file NAME. Deliberately no aggregated rows and no cache: rows only cover pinned
   * workspaces and lag a rescan, and each of those would show up here as a false refusal.
   */
  transcriptExists(sessionId: string): boolean {
    if (!sessionId) return false
    for (const t of this.tracked.values()) {
      // alive or not: same id, same file — the first hit answers for all of them
      if (t.info.sessionId !== sessionId) continue
      // the mirror lags the machine by up to one heartbeat, so a session that has
      // just spoken can be refused for a beat — the alternative (always yes) kills a
      // live claude to resume a conversation that does not exist yet
      return !!t.info.jsonlPath && fs.existsSync(t.info.jsonlPath)
    }
    let buckets: string[]
    try {
      buckets = fs.readdirSync(PROJECTS_ROOT)
    } catch {
      return false // no Claude storage at all -> nothing to resume
    }
    return buckets.some((d) => fs.existsSync(path.join(PROJECTS_ROOT, d, sessionId + '.jsonl')))
  }

  /** The live tab driving a claude session, if one is. An unbound tab carries
   *  sessionId '', so the empty id resolves to nothing rather than to whichever
   *  tab happens to be starting up. */
  aliveTabFor(sessionId: string): string | null {
    if (!sessionId) return null
    for (const t of this.tracked.values()) {
      if (t.info.alive && t.info.sessionId === sessionId) return t.info.tabId
    }
    return null
  }

  private cleanup(t: Tracked): void {
    if (t.idleTimer) clearTimeout(t.idleTimer)
    if (t.autoCloseTimer) clearTimeout(t.autoCloseTimer)
    if (t.subagentTimer) clearInterval(t.subagentTimer)
    if (t.landTimer) clearTimeout(t.landTimer)
    if (t.info.jsonlPath) {
      // remove ONLY this tab's listeners; a sibling co-watching the same jsonl
      // (two terminals on one session) must keep its watch alive
      if (t.jsonlListener) fs.unwatchFile(t.info.jsonlPath, t.jsonlListener)
      if (t.titleListener) fs.unwatchFile(this.sidecarOf(t.info.jsonlPath), t.titleListener)
    }
  }

  /** Resolve the tab's worktree name from the directory it is in and stash it on `info`.
   *  Resolution is filesystem-only (NO `git` binary): a Finder/Dock-launched
   *  packaged app inherits launchd's minimal PATH, so shelling out to `git` would
   *  silently fail and the badge would never appear. Reading the literal `gitdir:`
   *  path also sidesteps the relative-vs-absolute / symlinked-cwd pitfalls of
   *  comparing `rev-parse --git-dir` against `--git-common-dir`. Synchronous (a
   *  handful of stats up the tree, only ever when that directory *changes*) so there is
   *  no stale-callback race, no orphaned post-untrack emit, and no cache to poison. */
  private resolveWorktree(t: Tracked): void {
    if (t.remote) return
    // asked of `treeRoot` — the directory the session IS in — and never of
    // `cwd`. A `cd` into another checkout moves cwd with the transcript staying put
    // (observed: one session hopping between a workspace and three vendored clones 11
    // times), and that is not this session changing worktree.
    this.applyWorktree(
      t,
      t.info.treeRoot ? projectInfoFor(t.info.treeRoot).worktreeName : undefined
    )
  }

  /** Move `info.treeRoot` — the directory this session is in — to `root`, verbatim (no
   *  checkout walk-up; see SessionInfo.treeRoot for who may call this and when). The
   *  worktree name rides along: the two are one fact, kept in one place. */
  private setTreeRoot(t: Tracked, root: string): void {
    t.rootPinAwaitingCatchup = false
    if (!root || t.info.treeRoot === root) return
    t.info.treeRoot = root
    t.info.updatedAt = Date.now()
    this.resolveWorktree(t)
    this.emitUpdate()
  }

  /** Commit a resolved worktree name onto the tab and emit if it changed. */
  private applyWorktree(t: Tracked, name: string | undefined): void {
    if (t.info.worktree === name) return
    t.info.worktree = name
    t.info.updatedAt = Date.now()
    this.emitUpdate()
  }

  /** Coalesced 'update' emit: leading edge fires ~immediately, bursts within
   *  EMIT_THROTTLE_MS collapse into a single trailing emit. Always sends the
   *  latest snapshot, so no update is lost — only deduplicated. */
  private emitUpdate(): void {
    if (this.emitTimer) return
    const wait = Math.max(0, EMIT_THROTTLE_MS - (Date.now() - this.lastEmitMs))
    this.emitTimer = setTimeout(() => {
      this.emitTimer = undefined
      this.lastEmitMs = Date.now()
      this.emit('update', this.list())
    }, wait)
  }

  private resetParseState(t: Tracked, keepBindMs = false): void {
    t.readOffset = 0
    t.tailBuf = Buffer.alloc(0)
    t.title = null
    t.firstPrompt = null
    t.commandArgsTitle = null
    t.commandTitle = null
    t.candidates = new Map()
    t.fileCache = new Map()
    t.lastTouchedAbs = null
    t.lastWrittenAbs = null
    t.relocatedCwd = undefined
    t.info.lastTouched = undefined
    t.info.lastWritten = undefined
    t.caughtUp = false
    // usage is per-session: a (re)bind to a *different* jsonl (the hook reporting a
    // new session) starts fresh. bindSession to the SAME jsonl never calls bind(), so
    // this isn't hit and the accumulators survive.
    t.usageSeen = new Set()
    t.usageAny = false
    t.usageInTok = 0
    t.usageOutTok = 0
    t.usageCacheWriteTok = 0
    t.usageCacheReadTok = 0
    t.usageCostUsd = 0
    t.usageUnknownModel = false
    t.usageModel = undefined
    t.usageCtxTokens = undefined
    t.usageCcVersion = undefined
    t.usageToday = { dayKey: '', cost: 0 }
    t.subagentFiles = new Map()
    t.subagentScanMs = 0
    t.info.usage = undefined
    t.bgTasks = new Set()
    t.monitorIds = new Set()
    t.taskCmds = new Map()
    t.toolCmds = new Map()
    t.teammateActiveMs = 0
    t.lastBgActivityTs = 0
    t.lastMainActivityTs = 0
    t.lastInterruptTs = 0
    // `reported` survives like stopPending: it came from the hooks, not from the
    // transcript being re-read, and a rebind seeds a fresh run-state anyway
    // A truncation reset (keepBindMs) re-reads the SAME session's rewritten
    // file: live-observed spawn acks are stamped after the original bind, so
    // preserving bindMs lets them re-enter the ledger during the catch-up —
    // restamping would demote a ledger-held run to the 10s recency channel.
    // resetMs always restamps: it is the replay cutoff (only records written
    // AFTER this reset count as genuinely new turn evidence).
    if (!keepBindMs) t.bindMs = Date.now()
    t.resetMs = Date.now()
    // stopPending deliberately survives: a truncation-triggered reset while a
    // deferred turn-end is held must not swallow the eventual 'waiting' (the
    // rebind path clears it anyway via bindSession's seeded setStatus)
  }

  /** Point this tab's watches at `file`, tearing down only ITS OWN old ones (a sibling
   *  tab may co-watch the same jsonl). No exclusive claim on `file`: two tabs may drive
   *  the same session, so watching must not lock the transcript. Shared by a (re)bind and
   *  by following a move, which differ in everything else. */
  private watchTranscript(t: Tracked, file: string): void {
    if (t.info.jsonlPath) {
      if (t.jsonlListener) fs.unwatchFile(t.info.jsonlPath, t.jsonlListener)
      if (t.titleListener) fs.unwatchFile(this.sidecarOf(t.info.jsonlPath), t.titleListener)
    }
    t.info.jsonlPath = file
    t.jsonlListener ??= (): void => void this.parse(t)
    // <id>.title may be (re)written with no accompanying jsonl activity, so watch it
    // directly — otherwise the name wouldn't refresh until the next jsonl write.
    t.titleListener ??= (): void => this.recompute(t)
    fs.watchFile(file, { interval: 500 }, t.jsonlListener)
    fs.watchFile(this.sidecarOf(file), { interval: 500 }, t.titleListener)
  }

  private bind(t: Tracked, file: string): void {
    this.watchTranscript(t, file)
    t.info.sessionId = path.basename(file, '.jsonl')
    // a move still settling belonged to the session being replaced (a /clear moments
    // after one) — its landing is not this session's business, and neither is the
    // record that an earlier session in this tab was moved
    if (t.landTimer) clearTimeout(t.landTimer)
    t.landTimer = undefined
    t.info.relocated = undefined
    // pure function of the transcript path, so it belongs here rather than in recompute:
    // rebinding is the only thing that can ever move it
    t.info.scratchpadDir = scratchpadDirFor(file) ?? undefined
    this.resetParseState(t)
    t.swept = false
    // A file with existing content at bind time has past turns to catch up on (don't
    // let them drive run-state); a fresh/empty file has none, so its very first
    // appended bytes are genuine live activity and may drive 'working' immediately.
    try {
      const st = fs.statSync(file)
      t.caughtUp = st.size === 0
      // a remote mirror's inode is meaningless (rsync rebuilds the file every pull)
      t.inode = t.remote ? undefined : st.ino
    } catch {
      t.caughtUp = true
      t.inode = undefined
    }
    // Subagent transcripts grow with NO main-jsonl write until the turn boundary,
    // so the main watch alone would freeze their spend while the session idles at
    // the prompt. Poll a parse cycle at the scan cadence to fold them regardless.
    if (t.subagentTimer) clearInterval(t.subagentTimer)
    t.subagentTimer = setInterval(() => void this.parse(t), SUBAGENT_SCAN_MS)
    void this.parse(t)
  }

  private resolvePath(raw: string, cwd: string): string | null {
    let p = raw
    if (p === '~' || p === '~/') return null
    if (p.startsWith('~/')) p = path.join(os.homedir(), p.slice(2))
    else if (!path.isAbsolute(p)) p = path.resolve(cwd, p)
    return p
  }

  /** Serialize parse runs per tab: a watch tick that arrives mid-parse just sets
   *  parseAgain so we re-read the freshly appended bytes once the current run ends.
   *  Returns the promise of the FULL coalesced run (including the parseAgain
   *  re-read) — reportTurnEnd awaits this to observe a spawn ack whose write
   *  triggered the very watch tick that is mid-parse when the Stop hook lands. */
  private parse(t: Tracked): Promise<void> {
    if (t.parsePromise) {
      t.parseAgain = true
      return t.parsePromise
    }
    t.parsePromise = (async () => {
      try {
        do {
          t.parseAgain = false
          await this.parseOnce(t)
        } while (t.parseAgain)
      } finally {
        t.parsePromise = undefined
      }
    })()
    return t.parsePromise
  }

  /**
   * make sure we are still reading THIS session's transcript, and return the
   * stat of the file to read this tick.
   *
   * `EnterWorktree` / `ExitWorktree` move a live session into (or out of) another git
   * checkout by renaming its transcript into another bucket, and fire no hook at all —
   * the SessionStart hook, Koloft's only other way to learn a transcript path, never
   * runs. So the file is tracked by its inode: gone, or a different file now sitting at
   * our path (claude sometimes leaves a few-line stub behind), means go find ours.
   *
   * Found -> adopt it (the session moved). Not found -> it really was deleted, and
   * today's behavior stands.
   *
   * The one shape this cannot see: if claude ever produced that stub by truncating our
   * file IN PLACE (same inode) and writing the moved one as a copy, nothing here would
   * fire and the truncation path below would zero the session's spend, exactly as it did
   * before. Measured once (1/965 transcripts), and the inode of the leftover was not
   * captured — so if that ever shows up, this is the place, and the fix needs a second
   * signal (our file shrank AND a longer one with our id sits elsewhere).
   *
   * No "was this a subagent's doing?" filter: a subagent cannot enter a worktree at all
   * (measured, CC 2.1.267 — see the contract ledger §2). If that ever loosens, a move
   * made by a subagent would have to be ignored, because the main loop stays where it is.
   */
  private async followRelocation(t: Tracked): Promise<fs.Stats | undefined> {
    const p = t.info.jsonlPath
    if (!p) return undefined
    const st = await this.statSafe(p)
    if (st) {
      if (t.inode === undefined || st.ino === t.inode) return st
    } else if (t.swept) {
      return undefined // already looked everywhere for it; don't look again every tick
    }
    const moved = this.findRelocated(t)
    if (!moved) {
      // Nowhere in Claude's storage. Two shapes reach this, and both keep the behavior
      // Koloft had before it followed anything:
      //   · our path is empty too — the transcript was deleted (a GC'd quiet one, a
      //     `claude project purge`). Remembered, because the search is a stat per bucket
      //     (~140, synchronous, main thread) and parseOnce runs every 5s for the life of
      //     the tab; a later stat of our own path re-arms it in parseOnce.
      //   · a DIFFERENT file sits at our path. parseOnce takes its inode, so the search
      //     does not repeat (which is why `swept` carries no weight in this shape), and
      //     reads it — zeroing the session's spend if it is the shorter leftover claude
      //     sometimes writes. Deliberate: telling that leftover from a transcript claude
      //     rewrote in place is not something the filesystem can answer, and the shape
      //     worth handling is the one that IS answerable — our file, found by its inode.
      t.swept = true
      return st
    }
    this.adoptRelocated(t, moved)
    return await this.statSafe(moved)
  }

  private async statSafe(p: string): Promise<fs.Stats | undefined> {
    try {
      return await fs.promises.stat(p)
    } catch {
      return undefined
    }
  }

  /** which bucket holds our transcript now: one stat per bucket (~140 here), only
   *  on the tick the trigger fired.
   *
   *  Locally the match is the INODE. A rename keeps it and a freshly created file of the
   *  same name never gets it, which is exactly what keeps a stray same-id copy in
   *  another bucket from being adopted. Reading the records to find the file cannot work:
   *  once it has moved, the path we hold no longer has them.
   *
   *  A remote session is matched by NAME instead, newest write wins (the rule the sidebar
   *  aggregation already picks its single row by): its transcript reaches us through an
   *  rsync mirror, which rebuilds the file rather than moving it, so no inode over there
   *  survives the trip. */
  private findRelocated(t: Tracked): string | null {
    const id = t.info.sessionId
    if (!id) return null
    // locally there is nothing to match until the file has been seen; over there, nothing
    // to match until it has been READ — a mirrored file that is not there yet has simply
    // not arrived, and adopting some other copy of the id would pin us to that copy
    if (t.remote ? !t.readOffset : t.inode === undefined) return null
    const root = t.remote ? t.remote.projectsRoot : PROJECTS_ROOT
    let buckets: string[]
    try {
      buckets = fs.readdirSync(root)
    } catch {
      return null
    }
    let newest: { file: string; mtimeMs: number } | null = null
    for (const b of buckets) {
      const file = path.join(root, b, id + '.jsonl')
      if (file === t.info.jsonlPath) continue
      let st: fs.Stats
      try {
        st = fs.statSync(file)
      } catch {
        continue
      }
      if (!t.remote) {
        if (st.ino === t.inode) return file
      } else if (!newest || st.mtimeMs > newest.mtimeMs) {
        newest = { file, mtimeMs: st.mtimeMs }
      }
    }
    return newest?.file ?? null
  }

  /** take over the moved transcript in place: same session, same bytes, same
   *  scratchpad. The read cursor and every accumulator stay as they are (a rename
   *  changes no content, so re-reading from the top would double the session's cost),
   *  and `scratchpadDir` is deliberately NOT re-derived — claude leaves the scratchpad
   *  in the bucket the session started in, so recomputing it from the new path would
   *  point Browse at a folder that does not exist. */
  private adoptRelocated(t: Tracked, file: string): void {
    // the inode is the one we matched on, so it needs no re-reading
    this.watchTranscript(t, file)
    t.info.updatedAt = Date.now()
    this.emitUpdate()
    // the re-root and its notice wait for the burst to settle; the rebind above
    // does not — cost and context % must keep counting through it.
    if (t.landTimer) clearTimeout(t.landTimer)
    t.landTimer = setTimeout(() => {
      t.landTimer = undefined
      this.land(t)
    }, RELOCATE_SETTLE_MS)
  }

  /**
   * Where the session now stands, once a burst of moves has settled: the newest
   * `relocated` record, which claude writes on every move (2-3 times each) and which is
   * the only answer that survives LEAVING a worktree — after that, no line ever carries a
   * cwd again, so `cwd` must never be used here. Taken verbatim: no walk up to a checkout
   * root, no walk down.
   *
   * The record is CONSUMED: it answers for the move it was written for and no other, so a
   * later change of file identity with no fresh record leaves the session where it is
   * (the adoption has already kept the spend and the context % counting) rather than
   * re-rooting it at the previous move's folder.
   */
  private land(t: Tracked): void {
    const dir = t.relocatedCwd
    t.relocatedCwd = undefined
    if (!dir || dir === t.info.treeRoot) return
    t.info.relocated = true
    this.setTreeRoot(t, dir)
    this.emit('relocated', { tabId: t.info.tabId, dir })
  }

  /**
   * Read only the bytes appended since the last run and fold them into the tab's
   * accumulated state, then recompute the preview lists. This replaces the old
   * "re-read + re-scan the whole (up to 20MB+) file every 500ms" approach, which
   * — even after the regex fix — was O(file size) per tick on the main process.
   */
  private async parseOnce(t: Tracked): Promise<void> {
    if (!t.info.jsonlPath) return
    let mainChanged = false
    const st = await this.followRelocation(t)
    const p = t.info.jsonlPath
    if (st) {
      t.swept = false
      if (!t.remote) t.inode = st.ino
      // truncated/rotated -> restart, keeping bindMs so live acks re-ledger
      if (st.size < t.readOffset) this.resetParseState(t, true)
      if (st.size > t.readOffset) mainChanged = await this.ingestMainAppend(t, p, st)
    }
    // Subagent transcripts grow independently of the main jsonl; fold their spend every
    // cycle (throttled dir re-list) so a session's real cost — up to ~78% from
    // subagents — is counted even when only they advanced.
    const subChanged = await this.tailSubagents(t)
    // The OS view of the tool shells, for the judgement below — only while it can
    // matter: a held turn-end, or a resting session whose badge tracks a server.
    // Not during a turn (the list is last turn's; its Stop brings a fresh one).
    const s = t.info.status
    if (t.stopPending || (s !== 'working' && s !== 'approval')) await this.refreshProcs(t)
    if (mainChanged || subChanged) this.recompute(t)
    // runs even on no-change cycles: bgBusy decays with wall time, and the 5s
    // subagent poll is what lands a deferred turn-end after the background drains
    this.reconcileBackground(t)
  }

  /** Settle the run-state against the background picture each parse cycle: land a
   *  deferred turn-end once the background drains, and promote a resting dot back
   *  to 'working' when subagent transcripts are demonstrably growing NOW (Koloft
   *  bound/restarted mid-run, a teammate's later turn). Only 'waiting'/'idle' are
   *  promoted — 'approval' needs the user regardless of background churn. */
  private reconcileBackground(t: Tracked): void {
    // Promotion FIRST: a resting dot with demonstrably fresh background growth
    // is working, even when a turn-end was deferred while it rested (an idle
    // nudge racing the background) — the stopPending branch below would
    // otherwise block this recovery for the whole background phase.
    const s = t.info.status
    if (
      (s === 'waiting' || s === 'idle') &&
      t.caughtUp &&
      t.lastBgActivityTs > t.statusSince + RESUME_AFTER_STOP_MS
    ) {
      this.applyStatus(t, 'working')
      // The main loop is NOT running (we promoted from a resting state), so
      // this 'working' is background-held: re-arm the deferred turn-end so
      // quiescence demotes it if the background dies without a notification.
      // The sentinel grants the hold a ledgered task's silence window — the
      // promotion is proof a background run exists even though its spawn ack
      // predates our bind, and the 10s recency window alone would flap the dot
      // on every longer tool call.
      t.stopPending = true
      t.bgTasks.add(BG_PROMOTED)
      return
    }
    if (!t.stopPending) {
      // Resting with a list on record: keep the parked badge honest — a server
      // that was stopped drops off it, a teammate that woke shows through the
      // promotion above. Not while a turn runs: the list is last turn's, and
      // the Stop that ends this one brings the fresh picture.
      if (t.reported && s !== 'working' && s !== 'approval') this.judgeReported(t)
      return
    }
    // Is the deferred turn-end still held? By the typed list re-judged NOW (a
    // shell died, a teammate went quiet, a server was recognised — none of which
    // needs the model to wake); by the inferred ledger when nothing was reported.
    const busy = t.reported ? this.judgeReported(t) : this.bgBusy(t)
    if (!busy) {
      // The drain itself is not the end of the turn. A terminal task-notification
      // RE-INVOKES the model, which then runs a wrap-up turn ending in its own
      // Stop — landing 'waiting' the instant the ledger empties would fire a
      // turn-done for a turn that is about to keep going, then flap back to
      // 'working' on the wrap-up's first output and fire a SECOND one. So wait
      // until the main transcript has also been quiet for the hold window: a real
      // wrap-up keeps it noisy and its own Stop lands the rest, while a task that
      // died without waking anything (drift) still rests here.
      if (Date.now() - t.lastMainActivityTs < STOP_HOLD_MS) return
      t.bgTasks.clear() // drained or drifted — a stale id must not re-arm holds
      this.applyStatus(t, 'waiting') // also clears the flag
    }
  }

  /** Read the main jsonl's newly-appended bytes and fold complete lines into state.
   *  Returns true when at least one complete line was processed (drives recompute). */
  private async ingestMainAppend(t: Tracked, p: string, st: fs.Stats): Promise<boolean> {
    const cur = { offset: t.readOffset, tail: t.tailBuf }
    const lines = await readAppendedLines(p, st.size, cur)
    if (lines !== null) {
      t.readOffset = cur.offset
      t.tailBuf = cur.tail
    }
    if (!lines || !lines.length) return false

    let sawUserPrompt = false
    let sawAssistant = false
    let sawInterrupt = false
    for (const line of lines) {
      if (!line) continue
      const activity = this.ingestLine(t, line)
      if (activity === 'user') {
        sawUserPrompt = true
        // a prompt AFTER the interrupt starts a newer turn — the interrupt's
        // turn-end is history, and demoting now would flap the new turn's dot
        sawInterrupt = false
      } else if (activity === 'assistant') sawAssistant = true
      else if (activity === 'interrupt') sawInterrupt = true
    }
    // The first parse after a (re)bind catches up on history; only appends seen
    // *after* that catch-up are live activity that may correct a stale run-state.
    // (New-turn evidence — the stopPending supersede + statusSeq bump — lives in
    // ingestLine with a per-record resetMs cutoff, so it also catches a prompt
    // landing inside a post-truncation catch-up batch.)
    // An uncancelled interrupt REPLACES the stale-recovery check: the turn just
    // ended, so there is nothing to promote — only a turn-end to land. ingestLine
    // already applied the liveness cutoff, so a catch-up batch can only reach
    // this through a genuinely live record (post-truncation re-read).
    // A hook-less bind pins the tree root from the batch's NEWEST logged cwd, now
    // that the whole replay has folded into `info.cwd` — pinning per line would root
    // a resumed session at the transcript's oldest (possibly long-dead) directory.
    if (t.rootPinAwaitingCatchup) this.setTreeRoot(t, t.info.cwd)
    if (sawInterrupt) await this.interruptTurn(t)
    else if (t.caughtUp) this.resumeWorkingIfStale(t, sawUserPrompt, sawAssistant)
    if (!t.caughtUp) t.caughtUp = true
    return true
  }

  /**
   * A live Esc-interrupt record ended the turn — the counterpart of
   * reportTurnEnd for the one turn-end Claude Code fires NO Stop hook for.
   * Same background gate: live background tasks keep the session working (the
   * interrupt aborts only the main loop) and the turn-end defers until they
   * drain. Only a running state is demoted, and a hook transition newer than
   * the record (the next turn's UserPromptSubmit racing this fold) outranks it.
   */
  private async interruptTurn(t: Tracked): Promise<void> {
    const s = t.info.status
    if (s !== 'working' && s !== 'approval') return
    if (t.statusSince > t.lastInterruptTs) return
    // The reported list already carries this turn's own spawns (ingestSpawnAck
    // folds live acks into it), so it is judged whole — on a FRESH OS view: no
    // snapshot is taken while a turn runs, so the last one predates every shell
    // this turn started, and judging on it would read them all as ended. The
    // ledger is the fallback for a session that never reported a list.
    if (t.reported) {
      await this.refreshProcs(t, true)
      // a hook transition that landed during the await (the next prompt)
      // outranks the interrupt, exactly as it would have before it
      if (this.tracked.get(t.info.tabId) !== t || t.statusSince > t.lastInterruptTs) return
    }
    const busy = t.reported ? this.judgeReported(t) : this.bgBusy(t)
    if (busy) {
      t.stopPending = true
      return
    }
    t.bgTasks.clear()
    this.applyStatus(t, 'waiting')
  }

  /** Discover (throttled) + incrementally tail this session's subagent transcripts,
   *  folding their usage into the same accumulators. Returns true if any bytes folded.
   *  Cross-file dedup is automatic (message.id+requestId is globally unique).
   *  Long-finished files are demoted: one that hasn't grown for a scan interval is
   *  stat'ed only on rescan ticks, so an agent-heavy session (hundreds of files, all
   *  frozen) doesn't burn a stat per file per 500ms watch tick; stats of the files
   *  that ARE due run concurrently, not serialized. */
  private async tailSubagents(t: Tracked): Promise<boolean> {
    const p = t.info.jsonlPath
    if (!p || !t.info.sessionId) return false
    const now = Date.now()
    const rescan = now - t.subagentScanMs >= SUBAGENT_SCAN_MS
    if (rescan) {
      t.subagentScanMs = now
      const dir = path.join(path.dirname(p), t.info.sessionId, 'subagents')
      for (const f of listSubagentJsonls(dir)) {
        let sst = t.subagentFiles.get(f)
        if (!sst) {
          sst = { offset: 0, tail: Buffer.alloc(0), activeMs: now }
          t.subagentFiles.set(f, sst)
        }
        // whose transcript is this? A teammate's growth is judged differently
        // from a subagent's (judgeReported). The meta file can land a beat after
        // the transcript, so an unreadable one is retried on the next rescan.
        if (sst.teammate === undefined) sst.teammate = readTeammateFlag(f)
      }
    }
    const due = [...t.subagentFiles].filter(
      ([, sst]) => rescan || now - sst.activeMs < SUBAGENT_SCAN_MS
    )
    const folded = await Promise.all(due.map(([file, sst]) => this.tailSubagentFile(t, file, sst)))
    return folded.some(Boolean)
  }

  /** Tail one subagent jsonl by byte offset; fold each assistant record's usage (cost
   *  only — a subagent's context is not the parent session's). Returns true if any
   *  complete usage line was folded. */
  private async tailSubagentFile(t: Tracked, file: string, sst: SubagentFile): Promise<boolean> {
    let st: fs.Stats
    try {
      st = await fs.promises.stat(file)
    } catch {
      return false
    }
    if (st.size < sst.offset) {
      sst.offset = 0
      sst.tail = Buffer.alloc(0)
    }
    if (st.size === sst.offset) return false
    sst.activeMs = Date.now() // growing — keep on the every-cycle stat list
    // growth is the moment the flag matters, so a meta file that was not there
    // at discovery is looked for again now — never given up on: a real teammate
    // read as "not one" would be judged idle while it works (a false turn-done)
    if (sst.teammate === undefined) sst.teammate = readTeammateFlag(file)
    if (sst.teammate) t.teammateActiveMs = sst.activeMs
    const lines = await readAppendedLines(file, st.size, sst)
    if (!lines) return false
    let folded = false
    for (const line of lines) {
      if (!line) continue
      let obj: any
      try {
        obj = JSON.parse(line)
      } catch {
        continue
      }
      // any record in a subagent transcript is evidence its agent is (or was, at
      // the record's own wall-clock time) alive and working — feeds bgBusy.
      // Capped at our clock so a skewed future stamp can't pin bgBusy busy.
      const ts = Math.min(Date.parse(obj?.timestamp), Date.now())
      if (isFinite(ts) && ts > t.lastBgActivityTs) t.lastBgActivityTs = ts
      if (obj && obj.type === 'assistant' && obj.message && obj.message.usage) {
        this.accumulateUsage(t, obj, false)
        folded = true
      }
    }
    return folded
  }

  /**
   * Authoritative-jsonl backstop for the hook-driven run-state: if the dot is stuck
   * on a non-working state but the transcript shows the session is actually working,
   * flip it back to 'working'. This catches a dropped `UserPromptSubmit` hook — the
   * run-state hooks all overwrite one `<tab>.status.json` whose change events
   * `fs.watch` can coalesce/miss, which would otherwise leave the dot on the previous
   * turn's 'waiting'/'idle' for the whole turn.
   *
   * Only ever *promotes* to working, and only from an already-set hook state — never
   * invents run-state when hooks aren't reporting at all (status stays undefined ->
   * neutral dot), and never the reverse (Stop/idle remain hook/timer driven).
   */
  private resumeWorkingIfStale(t: Tracked, sawUserPrompt: boolean, sawAssistant: boolean): void {
    const s = t.info.status
    if (!s || s === 'working') return
    // A genuine new user prompt is unambiguous new work — resume immediately,
    // whatever the paused state, and regardless of timing.
    if (sawUserPrompt) {
      this.applyStatus(t, 'working')
      return
    }
    if (!sawAssistant) return // title/meta/tool-result-only growth — not a run-state signal
    // Assistant output resumed without a new prompt: a granted approval or re-woken
    // idle session is producing again -> resume at once. A 'waiting' tab must first
    // outlast the Stop-settling window, so the final message Stop fired right after
    // doesn't bounce the dot back to 'working'.
    if (s === 'approval' || s === 'idle') {
      this.applyStatus(t, 'working')
    } else if (s === 'waiting' && Date.now() - t.statusSince > RESUME_AFTER_STOP_MS) {
      this.applyStatus(t, 'working')
    }
  }

  /** Ledger a background task from its spawn ack in the MAIN transcript (a
   *  tool_result user record — see isBackgroundSpawnAck for which acks count).
   *  Spawns are only counted once caught up (live); see the bgTasks field doc
   *  for why a resumed transcript's history is not. */
  private ingestSpawnAck(t: Tracked, obj: any): void {
    const tur = obj.toolUseResult
    if (!isBackgroundSpawnAck(tur) || !Array.isArray(obj.message?.content)) return
    const ts = Date.parse(obj.timestamp)
    // Live if seen post-catch-up, or stamped after this bind — the catch-up
    // batch can contain an ack appended moments after we bound (still a live
    // process). Truly historical acks (resumed/forked transcripts) stay out;
    // the upper bound rejects future-skewed HISTORICAL stamps (a transcript
    // written under a faster clock would otherwise ledger a dead task).
    const live = t.caughtUp || (isFinite(ts) && ts >= t.bindMs && ts <= Date.now())
    if (!live) return
    const toolUseIds: string[] = []
    for (const b of obj.message.content) {
      if (b?.type === 'tool_result' && typeof b.tool_use_id === 'string') {
        t.bgTasks.add(b.tool_use_id)
        toolUseIds.push(b.tool_use_id)
      }
    }
    // The same ack in the reported list's own terms, so a spawn folded in AFTER
    // the last report is judged like the reported ones (judgeReported): a shell
    // by its task id — a Monitor likewise, and remembered as one, since the
    // report calls it a plain shell; an agent by its agent id (what a later
    // report and its task-notification name); a teammate has no id in its ack,
    // so its tool-use id stands in until the next report replaces the list.
    const r = tur as Record<string, unknown>
    let task: ReportedTask | null = null
    if (typeof r.backgroundTaskId === 'string') task = { id: r.backgroundTaskId, type: 'shell' }
    else if (typeof r.taskId === 'string' && typeof r.timeoutMs === 'number') {
      task = { id: r.taskId, type: 'shell' }
      t.monitorIds.add(r.taskId)
    } else if (r.status === 'teammate_spawned') {
      // no id of its own in the ack: the tool-use id stands in (an ack without
      // one enters nothing — an empty id would merge every such spawn into one)
      if (toolUseIds[0]) task = { id: toolUseIds[0], type: 'teammate' }
      // a fresh spawn is activity: the teammate is working before its transcript
      // has written a byte, and must not be judged idle for that first moment
      t.teammateActiveMs = Date.now()
    } else if (typeof r.agentId === 'string') {
      task = { id: r.agentId, type: r.status === 'remote_launched' ? 'cloud-session' : 'subagent' }
    }
    if (task) {
      const cmd = toolUseIds.map((id) => t.toolCmds.get(id)).find((c) => c)
      if (cmd) t.taskCmds.set(task.id, cmd)
      if (t.reported && !t.reported.some((x) => x.id === task.id)) {
        t.reported.push({ ...task, since: Date.now() })
      }
    }
    for (const id of toolUseIds) t.toolCmds.delete(id)
    // a live ack is fresh activity even with an unparseable record timestamp;
    // capped at our clock so a skewed future stamp can't pin bgBusy
    const at = Math.min(isFinite(ts) ? ts : Date.now(), Date.now())
    if (at > t.lastBgActivityTs) t.lastBgActivityTs = at
  }

  /** Retire ledger entries a delivered task-notification reports as finished.
   *  Only a TERMINAL status counts: a long-lived task (a Monitor, a teammate)
   *  also emits progress notifications naming the same <tool-use-id>, and
   *  retiring on those would rest the dot while the task is still running. An
   *  unrecognized status keeps the hold — the silence backstop releases drift. */
  private ingestTaskNotification(t: Tracked, obj: any): void {
    const text = taskNotificationText(obj)
    if (text === null) return
    const st = text
      .match(/<status>([^<]*)<\/status>/)?.[1]
      ?.trim()
      .toLowerCase()
    if (!st || !TERMINAL_TASK_STATUSES.has(st)) return
    for (const m of text.matchAll(/<tool-use-id>([^<]+)<\/tool-use-id>/g)) {
      t.bgTasks.delete(m[1])
    }
    // the reported list is keyed by Claude Code's task id, which the same
    // notification names too — retiring it here is what keeps a task that ended
    // while the model was interrupted from being judged alive off a stale list
    const gone = new Set([...text.matchAll(/<task-id>([^<]+)<\/task-id>/g)].map((m) => m[1]))
    if (t.reported && gone.size) t.reported = t.reported.filter((x) => !gone.has(x.id))
    for (const id of gone) {
      t.monitorIds.delete(id)
      t.taskCmds.delete(id)
    }
    // a terminal report also retires the promotion sentinel: the run it stood
    // in for has reported, and keeping it would pin later turn-ends to the
    // ledger's long silence window
    t.bgTasks.delete(BG_PROMOTED)
  }

  /** Fold one log line into the tab's accumulated parse state. Returns the kind of
   *  live turn activity the line represents — 'user' for a genuine new prompt,
   *  'assistant' for model output, 'interrupt' for a live Esc-interrupt record —
   *  or null for tool-result / meta / title lines. parseOnce uses this to keep the
   *  run-state dot in sync (see resumeWorkingIfStale / interruptTurn). */
  private ingestLine(t: Tracked, line: string): 'user' | 'assistant' | 'interrupt' | null {
    let obj: any = null
    try {
      obj = JSON.parse(line)
    } catch {
      return null // not json — only structured tool_use is tracked
    }
    let activity: 'user' | 'assistant' | 'interrupt' | null = null
    if (obj) {
      // The session's real working dir. For a `claude --worktree` session this is
      // the worktree path, NOT the launch cwd we recorded — claude writes its jsonl
      // under the worktree's project dir, and the hook binds us there. Adopt the
      // logged cwd so the displayed path and relative-path resolution (resolvePath)
      // track the directory claude actually operates in.
      if (typeof obj.cwd === 'string' && obj.cwd && obj.cwd !== t.info.cwd) {
        t.info.cwd = obj.cwd
        // Drift moves `cwd` only — EXCEPT when the pinned root has vanished from
        // disk (`git worktree remove` under a live session): a dead pin would show
        // an empty tree forever, so the cwd move re-homes it.
        if (!fs.existsSync(t.info.treeRoot)) this.setTreeRoot(t, obj.cwd)
      }
      if (obj.type === 'ai-title' && typeof obj.aiTitle === 'string') t.title = obj.aiTitle
      // Where a move landed. Remembered, never acted on from here: the record is written
      // before the rename as often as after it, and a session also REPLAYS its old ones
      // on a resume — so the move itself is the file changing identity, and only then is
      // the newest of these read (see land).
      if (obj.type === 'relocated' && typeof obj.relocatedCwd === 'string' && obj.relocatedCwd) {
        t.relocatedCwd = obj.relocatedCwd
      }
      // main-transcript liveness, by the record's own clock (capped at ours) —
      // the reference point that tells background subagent writes apart from a
      // foreground subagent's trailing ones (see bgBusy). isSidechain records
      // are a SUBAGENT's turns, which some CC versions interleave into the main
      // jsonl: they are background activity, not main-loop activity, and
      // stamping lastMain with them would defeat exactly that comparison.
      const recTs = Math.min(Date.parse(obj.timestamp), Date.now())
      if (isFinite(recTs)) {
        if (obj.isSidechain === true) {
          if (recTs > t.lastBgActivityTs) t.lastBgActivityTs = recTs
        } else if (recTs > t.lastMainActivityTs) {
          t.lastMainActivityTs = recTs
        }
      }
      if (obj.type === 'user') this.ingestSpawnAck(t, obj)
      // a delivered task-notification is NOT a user record any more (see
      // taskNotificationText), so this runs for every record type
      this.ingestTaskNotification(t, obj)
      // A *genuine* user prompt: isMeta messages (skill bodies, local-command stdout,
      // hook notices) and the command/bash plumbing wrappers are skipped, as are
      // tool-result user messages (array content with no text block) — so this marks
      // only real user input. It drives the fallback title (first usable one) and the
      // 'user' activity signal that resumes the working dot. The two are decoupled: an
      // image-only prompt (a pasted screenshot, or `/cmd <image>`) yields no title text
      // but is still genuine activity, so a top-level image block or a genuine text body
      // sets the signal even when the title is null.
      if (obj.type === 'user' && !obj.isMeta) {
        const c = obj.message?.content
        let raw: string | null = null
        let hasImage = false
        if (typeof c === 'string') raw = c
        else if (Array.isArray(c)) {
          const text = c.find((x: any) => x?.type === 'text')
          if (text?.text) raw = text.text
          hasImage = c.some((x: any) => x?.type === 'image')
        }
        // An Esc interrupt is turn-end evidence, NOT a prompt (see INTERRUPT_TEXTS).
        // Only live records count — same replay cutoff as the prompt supersede: a
        // resumed transcript's historical interrupt must not fire a phantom turn-end.
        // Sidechain interrupts are a SUBAGENT's abort, not the main turn's.
        if (raw !== null && INTERRUPT_TEXTS.has(raw) && obj.isSidechain !== true) {
          if (t.caughtUp || (isFinite(recTs) && recTs >= t.resetMs)) {
            const at = isFinite(recTs) ? recTs : Date.now()
            if (at > t.lastInterruptTs) t.lastInterruptTs = at
            return 'interrupt'
          }
          return null
        }
        const cls = raw !== null ? classifyUserPrompt(raw) : null
        if (cls?.title && !t.firstPrompt) t.firstPrompt = cls.title
        // both command slots are kept OUT of firstPrompt: `/model opus` or an argless
        // /status typed first must not block the user's actual first prompt from
        // titling the session
        if (cls?.commandArgs && !t.commandArgsTitle) t.commandArgsTitle = cls.commandArgs
        if (cls?.commandName && !t.commandTitle) t.commandTitle = cls.commandName
        if (cls?.genuine || hasImage) {
          activity = 'user'
          // A new turn supersedes a deferred turn-end. Per record, cut off at
          // the last reset: a live append or a prompt genuinely written inside
          // a post-truncation catch-up batch counts; replayed history doesn't.
          // Safe against the ENDING turn's own late-folded prompt because a
          // deferred turn-end is only armed AFTER reportTurnEnd's parse already
          // consumed everything up to the Stop. Deliberately NOT statusSeq
          // evidence: a record has no ordering anchor against the in-flight
          // Stop (the ending turn's own prompt folds during that very parse),
          // and hook-driven cancellation already covers real queued prompts —
          // the status-report file is last-writer-wins, so in a coalesced read
          // it is the newer prompt's report that survives, not the Stop's.
          if (t.caughtUp || (isFinite(recTs) && recTs >= t.resetMs)) {
            t.stopPending = false
          }
        }
      }
      // Collect the files the session touched from its tool calls: write/edit tools →
      // 'wrote' (with best-effort line deltas), Read → 'read'. A read never downgrades a
      // file already marked 'wrote'. lastTouchedRaw tracks the live node for follow mode.
      // Fold this record's token usage into the per-session accumulators. Runs
      // regardless of content shape (an assistant record always carries usage),
      // and dedups by message.id+requestId so streaming's repeated writes count once.
      // isSidechain records are subagent turns some CC versions interleave into the
      // MAIN jsonl — their cost counts, but their context/model isn't ours (same
      // rule as the subagents/-dir channel).
      if (obj.type === 'assistant' && obj.message && obj.message.usage) {
        this.accumulateUsage(t, obj, obj.isSidechain !== true)
      }
      if (obj.type === 'assistant' && Array.isArray(obj.message?.content)) {
        activity = 'assistant' // model output of any kind — text or tool_use
        // the same liveness rule as a spawn ack: past the catch-up, or stamped after
        // this bind (a record appended moments after we bound is live too)
        const liveNow = t.caughtUp || (isFinite(recTs) && recTs >= t.bindMs)
        for (const b of obj.message.content) {
          if (!b || b.type !== 'tool_use') continue
          // the command behind a shell / Monitor task, kept until its ack names
          // the task (ingestSpawnAck) — it is what the parked badge shows.
          // Bounded: a foreground command's ack is not a spawn and never collects
          if ((b.name === 'Bash' || b.name === 'Monitor') && typeof b.input?.command === 'string') {
            if (t.toolCmds.size >= 64) t.toolCmds.delete(t.toolCmds.keys().next().value as string)
            t.toolCmds.set(b.id, b.input.command.replace(/\s+/g, ' ').trim().slice(0, 120))
            if (b.name === 'Bash' && liveNow && BASH_WRITES.test(b.input.command)) {
              t.info.liveWrites = (t.info.liveWrites ?? 0) + 1
            }
          }
          // resolved here and never again: a relative path (0.094% of them, all
          // inside one repo) means a file under the directory claude stood in when it
          // wrote this line. Re-resolving it later would re-point it every time the
          // session moves, and this list belongs to the session, not to a directory.
          const raw = toolFilePath(b.input)
          const fp = raw ? this.resolvePath(raw, t.info.cwd) : null
          if (!fp) continue
          if (WRITE_TOOLS.has(b.name)) {
            const { added, removed } = editDelta(b.name, b.input)
            const cur = t.candidates.get(fp)
            if (cur && cur.access === 'wrote') {
              cur.added += added
              cur.removed += removed
            } else {
              t.candidates.set(fp, { access: 'wrote', added, removed })
            }
            t.lastTouchedAbs = fp
            t.lastWrittenAbs = fp
            if (liveNow) t.info.liveWrites = (t.info.liveWrites ?? 0) + 1
          } else if (READ_TOOLS.has(b.name)) {
            if (!t.candidates.has(fp))
              t.candidates.set(fp, { access: 'read', added: 0, removed: 0 })
            t.lastTouchedAbs = fp
          }
        }
      }
    }
    return activity
  }

  /**
   * Fold one assistant record's `message.usage` into the tab's per-session usage
   * accumulators. Dedups by `message.id + requestId` (streaming rewrites the same
   * usage object several times — real transcripts repeat it 3× — so without this the
   * cost would multiply); an id-less record can't be keyed and is always counted.
   * Cost aligns with ccusage; an unpriced model marks the $ total unreliable (never
   * fabricated). Records from a subagent transcript pass `updateContext = false`: they
   * add cost/tokens but the LATEST *main* record alone drives context/model.
   */
  private accumulateUsage(t: Tracked, obj: any, updateContext = true): void {
    const msg = obj.message
    const model = typeof msg.model === 'string' ? msg.model : ''
    // synthetic records (e.g. injected errors) carry no real token spend
    if (model === '<synthetic>') return
    const id = typeof msg.id === 'string' ? msg.id : ''
    const reqId = typeof obj.requestId === 'string' ? obj.requestId : ''
    // Dedup only when at least one id component exists — streaming's repeated writes
    // share both id + requestId. A record with NEITHER can't be keyed, so (like
    // ccusage) always count it rather than collapsing all id-less records into one.
    if (id || reqId) {
      const key = id + ' ' + reqId
      if (t.usageSeen.has(key)) return
      t.usageSeen.add(key)
    }
    t.usageAny = true

    const u = msg.usage || {}
    const inTok = num(u.input_tokens)
    const outTok = num(u.output_tokens)
    const cacheWrite = num(u.cache_creation_input_tokens)
    const cacheRead = num(u.cache_read_input_tokens)
    t.usageInTok += inTok
    t.usageOutTok += outTok
    t.usageCacheWriteTok += cacheWrite
    t.usageCacheReadTok += cacheRead

    const pricing = model ? resolvePricing(model) : undefined
    if (!pricing) {
      t.usageUnknownModel = true
    } else {
      const cost =
        (inTok * pricing.inPerM +
          outTok * pricing.outPerM +
          cacheWrite * pricing.cacheWritePerM +
          cacheRead * pricing.cacheReadPerM) /
        1_000_000
      t.usageCostUsd += cost
      const recDay = localDayKey(obj.timestamp)
      if (recDay) {
        // advance the bucket only for a STRICTLY newer local day, so an out-of-order
        // older-dated record can't wipe today's total; an older record neither resets
        // nor adds (it isn't today). Cheap day-boundary handling with no extra timer.
        if (recDay > t.usageToday.dayKey) {
          t.usageToday.dayKey = recDay
          t.usageToday.cost = 0
        }
        if (recDay === t.usageToday.dayKey) t.usageToday.cost += cost
      }
    }
    // context/model come from the latest MAIN record only (last write wins). Subagent
    // records fold their cost but not their context — a subagent's window isn't ours.
    if (updateContext) {
      if (model) t.usageModel = model
      t.usageCtxTokens = inTok + cacheRead + cacheWrite
      // every Claude Code record carries the CLI version — session metadata the
      // info card shows next to the model (main records only; same binary anyway)
      if (typeof obj.version === 'string' && obj.version) t.usageCcVersion = obj.version
    }
  }

  /** Assemble the emit-facing SessionUsage snapshot from the accumulators, or
   *  undefined when no usage record has been seen for this session yet. */
  private buildUsage(t: Tracked): SessionUsage | undefined {
    if (!t.usageAny) return undefined
    const pricing = t.usageModel ? resolvePricing(t.usageModel) : undefined
    const ctxPct =
      pricing && t.usageCtxTokens != null ? t.usageCtxTokens / pricing.windowTokens : undefined
    // today's cost carries its own day key so the renderer expires it at local midnight
    const hasToday = !t.usageUnknownModel && t.usageToday.cost > 0 && !!t.usageToday.dayKey
    return {
      inTok: t.usageInTok,
      outTok: t.usageOutTok,
      cacheWriteTok: t.usageCacheWriteTok,
      cacheReadTok: t.usageCacheReadTok,
      costUsd: t.usageUnknownModel ? undefined : t.usageCostUsd,
      todayCostUsd: hasToday ? t.usageToday.cost : undefined,
      todayDayKey: hasToday ? t.usageToday.dayKey : undefined,
      model: t.usageModel,
      ccVersion: t.usageCcVersion,
      ctxTokens: t.usageCtxTokens,
      ctxPct
    }
  }

  /** `<id>.jsonl` -> `<id>.title`, the AI-name sidecar written next to it (by an
   *  external title generator Koloft does not own; it only reads the file if present). */
  private sidecarOf(jsonlPath: string): string {
    return jsonlPath.replace(/\.jsonl$/, '.title')
  }

  /** Read the `<session_id>.title` sidecar (one line of plain text) if present.
   *  Preferred over the in-log title; resume keeps the same session id, so the
   *  sidecar follows the session automatically. Null when absent -> fall back. */
  private titleFromSidecar(jsonlPath: string): string | null {
    try {
      const text = fs.readFileSync(this.sidecarOf(jsonlPath), 'utf8').trim()
      return text || null
    } catch {
      return null
    }
  }

  /** Derive the output-file list from accumulated state and (throttled) emit it. */
  private recompute(t: Tracked): void {
    // Canonicalize (realpath) each candidate so session paths match the realpath'd tree
    // root, merging any that collapse to the same file: 'wrote' wins over 'read', line
    // deltas sum. Non-files / missing paths drop out. The paths arrive absolute —
    // resolving them is ingestLine's job, once, at the cwd they were written at (R12).
    const byCanon = new Map<string, PreviewItem>()
    for (const [abs, acc] of t.candidates) {
      const canon = this.canonFile(t, abs)
      if (!canon) continue
      const ex = byCanon.get(canon)
      if (ex) {
        ex.added = (ex.added ?? 0) + acc.added
        ex.removed = (ex.removed ?? 0) + acc.removed
        if (acc.access === 'wrote') ex.access = 'wrote'
      } else {
        const item: PreviewItem = { src: canon, label: basename(canon), access: acc.access }
        if (acc.added) item.added = acc.added
        if (acc.removed) item.removed = acc.removed
        byCanon.set(canon, item)
      }
    }
    // Cap at MAX_FILES, but never let a flood of reads starve the writes the user cares
    // about: emit writes first, then reads, then truncate.
    const all = [...byCanon.values()]
    const files =
      all.length <= MAX_FILES
        ? all
        : [
            ...all.filter((f) => f.access === 'wrote'),
            ...all.filter((f) => f.access !== 'wrote')
          ].slice(0, MAX_FILES)

    const sidecarTitle = t.info.jsonlPath ? this.titleFromSidecar(t.info.jsonlPath) : null
    t.info.title =
      sidecarTitle ||
      t.title ||
      (t.firstPrompt ? t.firstPrompt.slice(0, 60) : null) ||
      (t.commandArgsTitle ? t.commandArgsTitle.slice(0, 60) : null) ||
      t.commandTitle ||
      PLACEHOLDER_SESSION_TITLE
    t.info.files = files
    // lastTouched / lastWritten must be real existing files (canonFile filters non-files)
    // so follow mode never opens a deleted/missing path.
    t.info.lastTouched = t.lastTouchedAbs
      ? (this.canonFile(t, t.lastTouchedAbs) ?? undefined)
      : undefined
    t.info.lastWritten = t.lastWrittenAbs
      ? (this.canonFile(t, t.lastWrittenAbs) ?? undefined)
      : undefined
    t.info.usage = this.buildUsage(t)
    t.info.updatedAt = Date.now()
    this.emitUpdate()
  }

  /** Resolved-abs -> canonical realpath when it's a regular file, else null. Only positive
   *  results are cached: a path that isn't a file yet (e.g. read before the agent creates
   *  it) is re-checked on later ticks so it gets decorated once it appears. */
  private canonFile(t: Tracked, abs: string): string | null {
    const cached = t.fileCache.get(abs)
    if (cached !== undefined) return cached
    try {
      if (fs.statSync(abs).isFile()) {
        const real = fs.realpathSync(abs)
        t.fileCache.set(abs, real)
        return real
      }
    } catch {
      /* missing / not a regular file — don't cache, re-check next tick */
    }
    return null
  }
}
