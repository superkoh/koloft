import path from 'path'
import {
  PENDING_SESSION_TITLE,
  PLACEHOLDER_SESSION_TITLE,
  type SessionRow,
  type WorktreeStateMeta
} from '@shared/types'
import { classifyUserPrompt, encodeCwd, INTERRUPT_TEXTS } from './sessionTracker'

export type { SessionRow }

// Multi-bucket session aggregation for the workspace sidebar (agent-centric §6).
// Pure logic over injected dependencies — all IO (git, fs, ~/.claude/projects)
// belongs to the wiring layer.

export interface Bucket {
  slug: string
  dir: string
  /** the machine this bucket's transcripts were mirrored from; absent = this Mac.
   *  A launch may only resolve into a bucket with the same host. */
  host?: string
}

export interface ResolveBucketsDeps {
  /** Directories parsed from `git worktree list --porcelain`; the first entry is
   *  the main checkout (a duplicate of wsPath after A1 normalization). */
  gitWorktreeList(root: string): string[]
  listProjectSlugs(): string[]
  /** cwd recorded by the first message line of a jsonl in that slug dir, null when unreadable. */
  readFirstCwd(slug: string): string | null
}

/** Real Claude truncates an over-long encoded cwd and appends `-` + 6 random
 *  alphanumerics (V1,); encodeCwd never truncates, so a direct-encode
 *  miss must fall back to prefix matching on the suffix-stripped slug. */
const TRUNC_SUFFIX = /-[a-zA-Z0-9]{6}$/

function truncBase(slug: string): string {
  return slug.replace(TRUNC_SUFFIX, '')
}

export function resolveBuckets(wsPath: string, deps: ResolveBucketsDeps): Bucket[] {
  const dirs: string[] = []
  for (const d of [wsPath, ...deps.gitWorktreeList(wsPath)]) {
    const n = path.resolve(d)
    if (!dirs.includes(n)) dirs.push(n)
  }
  const slugs = deps.listProjectSlugs()
  const buckets = dirs.map((dir) => {
    const enc = encodeCwd(dir)
    if (slugs.includes(enc)) return { slug: enc, dir }
    // A prefix hit is only a candidate — the jsonl's own cwd is the arbiter,
    // which also rejects a sibling repo whose name is a prefix (…-koloft vs …-koloft2).
    const hit = slugs.find(
      (s) => s !== enc && enc.startsWith(truncBase(s)) && deps.readFirstCwd(s) === dir
    )
    // No hit keeps the direct-encode slug: the bucket may simply not exist yet,
    // and listing it is harmless (empty jsonl set).
    return { slug: hit ?? enc, dir }
  })
  // D2: claude removes its own unchanged worktree at exit — dir
  // AND git registration — while the session's jsonls survive under the slug. So
  // `git worktree list` alone cannot be the bucket source: any unclaimed slug that
  // prefix-matches this workspace's worktree home and whose own recorded cwd
  // confirms it sat exactly one level under it becomes an orphan bucket (rows then
  // grey out via the §4 invalidCwd path — hidden never). The cwd check is the
  // arbiter as everywhere else; the prefix (either direction, for V1 truncation)
  // is only the cheap trigger. Also covers `git worktree list` failing outright
  // (packaged app under launchd's minimal PATH): live worktrees resolve here too.
  const home = wsPath + '/.claude/worktrees/'
  const homePrefix = encodeCwd(home)
  const claimed = new Set(buckets.map((b) => b.slug))
  for (const s of slugs) {
    if (claimed.has(s)) continue
    const base = truncBase(s)
    if (!s.startsWith(homePrefix) && !(base !== s && homePrefix.startsWith(base))) continue
    const cwd = deps.readFirstCwd(s)
    if (!cwd || !cwd.startsWith(home)) continue
    if (cwd.slice(home.length).includes('/')) continue // subdir session — D5: out of scope
    buckets.push({ slug: s, dir: cwd })
    claimed.add(s)
  }
  return buckets
}

/** The `worktree-state` record's payload (the lifecycle contract D11). `worktreeSession.sessionId`
 *  is deliberately never read: in 14/116 real bound transcripts it is a PREDECESSOR
 *  session's id, so keying anything off it binds the wrong session. */
function readWorktreeState(obj: Record<string, unknown>): WorktreeStateMeta | undefined {
  const s = obj.worktreeSession
  if (!s || typeof s !== 'object') return undefined
  const r = s as Record<string, unknown>
  const str = (k: string): string | undefined => (typeof r[k] === 'string' ? r[k] : undefined)
  const originalCwd = str('originalCwd')
  const worktreePath = str('worktreePath')
  const worktreeName = str('worktreeName')
  const worktreeBranch = str('worktreeBranch')
  const originalHeadCommit = str('originalHeadCommit')
  if (!originalCwd || !worktreePath || !worktreeName || !worktreeBranch || !originalHeadCommit) {
    return undefined
  }
  return { originalCwd, worktreePath, worktreeName, worktreeBranch, originalHeadCommit }
}

/**
 * Fold jsonl lines into the fields the sidebar needs, pulling no more lines than
 * necessary (files can be huge; the wiring feeds a lazy line generator). Fields
 * absent from the scanned window stay undefined — the caller supplies fallbacks.
 */
export function extractJsonlMeta(lines: Iterable<string>): Partial<SessionMeta> {
  const meta: Partial<SessionMeta> = {}
  for (const line of lines) {
    let obj: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(line)
      if (!parsed || typeof parsed !== 'object') continue
      obj = parsed as Record<string, unknown>
    } catch {
      continue // torn tail / corrupt line — never fatal
    }
    if (
      meta.summary === undefined &&
      obj.type === 'summary' &&
      typeof obj.summary === 'string' &&
      obj.summary
    ) {
      meta.summary = obj.summary
    }
    // ai-title: what the live tracker titles a running row from (sessionTracker
    // parses the same records) — the cold row must agree, or a restart demotes every
    // title until re-activation. First one wins: CC re-logs the identical value
    // every few turns, so later duplicates carry nothing new.
    if (
      meta.aiTitle === undefined &&
      obj.type === 'ai-title' &&
      typeof obj.aiTitle === 'string' &&
      obj.aiTitle
    ) {
      meta.aiTitle = obj.aiTitle
    }
    // D11: first `worktree-state` line wins (a session re-entering a worktree can log
    // more than one); a record past the scan window (2/535 real files) yields no
    // binding at all and the row degrades to pre-v3 labeling — an accepted fallback.
    if (meta.worktreeState === undefined && obj.type === 'worktree-state') {
      meta.worktreeState = readWorktreeState(obj)
    }
    // cwd/timestamp: first message line carrying them wins (V1 field contract)
    if (meta.cwd === undefined && typeof obj.cwd === 'string' && obj.cwd) meta.cwd = obj.cwd
    if (meta.timestamp === undefined && typeof obj.timestamp === 'string' && obj.timestamp) {
      meta.timestamp = obj.timestamp
    }
    // Gated on firstUserText alone: once a plain prompt owns it, the command slots
    // below it in the chain can never be displayed, so scanning on for them is waste.
    if (meta.firstUserText === undefined && obj.type === 'user' && !obj.isMeta) {
      const msg = obj.message as { content?: unknown } | undefined
      const c = msg?.content
      let text = ''
      if (typeof c === 'string') text = c
      else if (Array.isArray(c)) {
        const block = c.find(
          (b: unknown): b is { text: string } =>
            !!b &&
            typeof b === 'object' &&
            (b as { type?: unknown }).type === 'text' &&
            typeof (b as { text?: unknown }).text === 'string'
        )
        if (block) text = block.text
      }
      if (text && !INTERRUPT_TEXTS.has(text)) {
        // same rules as the live tracker: command wrappers, bash echoes, skill
        // preambles and Esc-interrupt records must not become a cold row's title.
        // A command's args/name fill only their lower-priority slots (`/model opus`
        // must not pin "opus" over the user's actual first prompt).
        const cls = classifyUserPrompt(text)
        if (cls.title) meta.firstUserText = cls.title
        if (meta.commandArgsText === undefined && cls.commandArgs) {
          meta.commandArgsText = cls.commandArgs
        }
        if (meta.commandNameText === undefined && cls.commandName) {
          meta.commandNameText = cls.commandName
        }
      }
    }
    if (
      meta.summary !== undefined &&
      meta.aiTitle !== undefined &&
      meta.firstUserText !== undefined &&
      meta.cwd !== undefined &&
      meta.timestamp !== undefined
    ) {
      // D11: worktreeState is deliberately NOT part of this conjunction — most
      // transcripts carry no binding, so requiring it would make the break
      // unsatisfiable by design and turn every scan into a full head read.
      // firstUserText stays required even though commands no longer fill it: a
      // plain prompt anywhere in the window must be able to outrank the command
      // slots, so a command-only head keeps scanning (bounded by JSONL_SCAN_CAP).
      break // all fields found — stop pulling (files can be huge)
    }
  }
  return meta
}

export interface SessionMeta {
  /** The AI-generated session name — the in-log `ai-title` record, or (wiring) the
   *  `<id>.title` sidecar overriding it. Top of the title chain, as in the tracker. */
  aiTitle?: string
  summary?: string
  firstUserText?: string
  /** first command's `<command-args>` — the mid-priority fallback below
   *  firstUserText, mirroring the live tracker's commandArgsTitle slot */
  commandArgsText?: string
  /** first argless command's name — the last text fallback, mirroring the live
   *  tracker's commandTitle slot */
  commandNameText?: string
  cwd: string
  /** ISO timestamp from the jsonl message line. */
  timestamp: string
  /** The `worktree-state` binding, when the head window carried one (D11). */
  worktreeState?: WorktreeStateMeta
}

export interface AggregateDeps {
  listJsonl(slug: string): { id: string; mtime: number }[]
  readMeta(slug: string, id: string): SessionMeta
  runningIds: Set<string>
  dirExists(p: string): boolean
  now(): number
}

export const TITLE_MAX = 60

function relativeAgo(tsMs: number, nowMs: number): string {
  const s = Math.floor(Math.max(0, nowMs - tsMs) / 1000)
  if (s >= 86400) return `${Math.floor(s / 86400)}d ago`
  if (s >= 3600) return `${Math.floor(s / 3600)}h ago`
  if (s >= 60) return `${Math.floor(s / 60)}m ago`
  return `${s}s ago`
}

function titleFor(meta: SessionMeta, nowMs: number): string {
  if (meta.aiTitle) return meta.aiTitle
  if (meta.summary) return meta.summary
  if (meta.firstUserText) {
    const t = meta.firstUserText
    return t.length > TITLE_MAX ? t.slice(0, TITLE_MAX) + '…' : t
  }
  if (meta.commandArgsText) {
    const t = meta.commandArgsText
    return t.length > TITLE_MAX ? t.slice(0, TITLE_MAX) + '…' : t
  }
  if (meta.commandNameText) return meta.commandNameText
  return relativeAgo(Date.parse(meta.timestamp), nowMs)
}

export function aggregateSessions(buckets: Bucket[], deps: AggregateDeps): SessionRow[] {
  const nowMs = deps.now()
  const rows = new Map<string, SessionRow>()
  buckets.forEach((b, i) => {
    for (const f of deps.listJsonl(b.slug)) {
      const meta = deps.readMeta(b.slug, f.id)
      const row: SessionRow = {
        id: f.id,
        // a transcript with no timestamp would carry NaN into every later comparison
        createdAt: Date.parse(meta.timestamp) || 0,
        title: titleFor(meta, nowMs),
        // buckets[0] is the workspace root by resolveBuckets contract; worktree
        // attribution comes from the bucket dir, never the jsonl's gitBranch (V1: it lags).
        // D11: a binding outranks the bucket — a `-w` session's jsonl often lands in the
        // ROOT slug (90/116 real ones), where the bucket would misname it 'main'.
        worktree: meta.worktreeState?.worktreeName ?? (i === 0 ? 'main' : path.basename(b.dir)),
        cwd: meta.cwd,
        running: deps.runningIds.has(f.id),
        // stays purely cwd-based: a binding says where the session belongs, not that
        // the recorded dir is back
        invalidCwd: !deps.dirExists(meta.cwd),
        mtime: f.mtime,
        worktreeState: meta.worktreeState
      }
      // One id can sit in two buckets: when claude moves a session to another checkout it
      // renames the transcript into that slug, and the old location can keep a stale copy
      // (contract §2 — a plain `cd` moves nothing). Newest write wins. mtime is a proxy for
      // CC's own `relocated` marker, which is not read here: the record travels with the
      // file through the move, so it cannot tell a stale copy from a real one.
      const prev = rows.get(f.id)
      if (!prev || f.mtime > prev.mtime) rows.set(f.id, row)
    }
  })
  // One key for every row, newest session first, and that key never changes for the
  // life of the session — so a row keeps its place across resume, exit, and every
  // write to its transcript. Grouping running rows above cold ones, or sorting by
  // mtime, made the list reshuffle on exactly those events.
  return [...rows.values()].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
}

/** The sidebar's default policy: list only sessions Koloft itself
 *  drove — external claude runs in the same repo stay invisible until an import (or
 *  a one-off resume) binds them once. Ownership = a layout v2 `sessions[id]` entry
 *  (seeded at hook bind, GC'd with the jsonl); running rows are Koloft's own bindings
 *  by construction and always pass. The unfiltered aggregation remains the future
 *  importer's candidate source. */
export function filterOwned(
  rows: SessionRow[],
  owned: ReadonlySet<string>,
  running: ReadonlySet<string>
): SessionRow[] {
  return rows.filter((r) => owned.has(r.id) || running.has(r.id))
}

/** D9: does this workspace have anything to restore — the rows filterOwned drops,
 *  asked as a yes/no. It rides along on the pushed rows because the context menu has
 *  to grey its Restore item the moment it opens, and a 350ms hover pop-up cannot wait
 *  for an IPC round trip without flickering the item. */
export function hasHistory(
  rows: SessionRow[],
  owned: ReadonlySet<string>,
  running: ReadonlySet<string>
): boolean {
  return rows.some((r) => !owned.has(r.id) && !running.has(r.id))
}

/** A claude pty Koloft just spawned for a NEW session (a resume already has its row). */
export interface PendingLaunch {
  tabId: string
  /** the cwd it was spawned in — matched against bucket dirs to place the row */
  cwd: string
  /** the cwd the SessionStart hook reported, i.e. where claude actually ended up:
   *  `claude -w <new>` is spawned in the repo root and cd's into the worktree itself,
   *  so this is the only thing that can label the row before a jsonl exists (§4). */
  reportedCwd?: string
  /** the `-w <name>` target the tab was launched with, before git has created it: the
   *  only thing that can label the row until `reportedCwd` arrives (§4) */
  worktree?: string
  /** set once the SessionStart hook bound the tab; the row is still pending until
   *  that id shows up as a real (jsonl-backed) row */
  sessionId?: string
  /** the remote machine the tab was launched on; absent for a local launch. Two
   *  workspaces can hold the same absolute path on different machines, so the dir
   *  match below is not enough on its own. */
  host?: string
}

export interface PendingSplit {
  rows: SessionRow[]
  /** tabIds whose session materialized — the caller drops these launches for good,
   *  so an untrack later on can never resurrect a "Starting…" row */
  promoted: string[]
}

/**
 * Sidebar rows for the launches belonging to one workspace (§4 pending → promotion).
 * A launch is this workspace's when it was spawned in one of its bucket dirs — for
 * `claude -w <new>` that is the repo root, so membership is decided there and stays
 * put; the hook's reported cwd then refines WHICH bucket labels the row, which for a
 * `-w` launch is the worktree claude created for itself.
 */
export function resolvePending(
  buckets: Bucket[],
  launches: PendingLaunch[],
  rows: SessionRow[],
  nowMs: number
): PendingSplit {
  const out: PendingSplit = { rows: [], promoted: [] }
  const realIds = new Set(rows.map((r) => r.id))
  for (const l of launches) {
    const cwd = path.resolve(l.cwd)
    const i = buckets.findIndex((b) => b.host === l.host && path.resolve(b.dir) === cwd)
    if (i < 0) continue
    if (l.sessionId && realIds.has(l.sessionId)) {
      out.promoted.push(l.tabId)
      continue
    }
    // The label follows where claude actually IS, not where it was spawned. A reported
    // cwd git has not listed as a worktree yet (rescan lag) falls back to the launch
    // bucket, so the row keeps reading `main` for a beat instead of blinking out.
    const reported = l.reportedCwd ? path.resolve(l.reportedCwd) : null
    const j = reported
      ? buckets.findIndex((b) => b.host === l.host && path.resolve(b.dir) === reported)
      : -1
    const at = j < 0 ? i : j
    const dir = path.resolve(buckets[at].dir)
    // Still in the root bucket with a `-w` target pending: claude is on its way into a
    // worktree git has not created yet, so the target names it. Calling that `main`
    // would count it among the sessions a root pull disturbs (D4).
    const worktree =
      at === 0 ? (j < 0 && l.worktree ? l.worktree : 'main') : path.basename(buckets[at].dir)
    if (l.sessionId) {
      // The hook has bound: the TUI is up and this IS the session — but real Claude
      // Code writes no jsonl until the first user message, so waiting for the jsonl
      // row would leave the sidebar on Starting… long after launch (T-LIFE-01 ②:
      // the hook is the promotion). Render a running placeholder row under the real
      // id; the jsonl-backed row replaces it wholesale when it lands.
      out.rows.push({
        id: l.sessionId,
        title: PLACEHOLDER_SESSION_TITLE,
        worktree,
        cwd: dir,
        running: true,
        invalidCwd: false,
        mtime: nowMs
      })
      continue
    }
    out.rows.push({
      id: l.tabId,
      title: PENDING_SESSION_TITLE,
      worktree,
      cwd: dir,
      running: false,
      invalidCwd: false,
      mtime: nowMs,
      pending: true
    })
  }
  return out
}

export type RescanEvent =
  | { kind: 'startup' }
  | { kind: 'workspace-add' }
  | { kind: 'session-start'; cwd: string }
  | { kind: 'projects-dir-added'; dirName: string }

export interface RescanState {
  /** Known bucket dirs across all workspaces (resolved paths). */
  bucketDirs: string[]
  /** encodeCwd(ws.path) per pinned workspace. */
  workspaceSlugs: string[]
}

export function planRescan(event: RescanEvent, state: RescanState): 'rescan' | 'none' {
  switch (event.kind) {
    case 'startup':
    case 'workspace-add':
      return 'rescan'
    case 'session-start':
      return state.bucketDirs.includes(path.resolve(event.cwd)) ? 'none' : 'rescan'
    case 'projects-dir-added': {
      // A prefix hit is only a trigger signal: inclusion is decided by the rescan
      // itself (git worktree list + first-cwd confirmation), so a sibling-repo
      // false positive here costs one no-op rescan, never a wrong bucket.
      const base = truncBase(event.dirName)
      return state.workspaceSlugs.some((ws) => base.startsWith(ws) || ws.startsWith(base))
        ? 'rescan'
        : 'none'
    }
  }
}
