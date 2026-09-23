import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import fs from 'fs'
import path from 'path'
import type { GitFileStatus, GitStatusMap, GitNumstatMap } from '@shared/types'

const execFile = promisify(execFileCb)

/** A ceiling for a git that never answers (dead network mount, disk asleep), not a
 *  responsiveness budget: the gate below keeps at most one run per query alive, so this
 *  only bounds how long a wedged one holds its 64MB buffer. 30 s clears any cold
 *  `git status` on a large repo on a laptop, which the 5 s freshness budget does not
 *  (gitStatus.defaultBranch.test.ts pins that). */
const GIT_TIMEOUT_MS = Number(process.env.KOLOFT_GIT_TIMEOUT_MS) || 30_000

/** Every git this module runs: killed (SIGTERM, rejects with what it printed so far on the
 *  error's stdout) after `timeout`, and never taking index.lock — a read of ours must not
 *  make the user's or the agent's own `git add` in the same checkout fail with "index.lock
 *  exists". */
function git(
  args: string[],
  opts: { maxBuffer?: number; timeout?: number } = {}
): Promise<{ stdout: string; stderr: string }> {
  return execFile('git', args, {
    ...opts,
    timeout: opts.timeout ?? GIT_TIMEOUT_MS,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
  })
}

const wasKilled = (e: unknown): boolean => (e as { killed?: boolean }).killed === true

/** git's answer, or null when it said no (exit ≠ 0, not installed). A git the timeout
 *  killed is NOT a "no" and rejects on through: every ladder below would otherwise walk on
 *  to its next rung against a wedged repo — 30 s each, ending in an answer to a different
 *  question — where the rejection escapes them all and the renderer keeps its last good
 *  result. */
async function gitOut(
  args: string[],
  opts?: { maxBuffer?: number; timeout?: number }
): Promise<string | null> {
  try {
    return (await git(args, opts)).stdout
  } catch (e) {
    if (wasKilled(e)) throw e
    return null
  }
}

interface Slot {
  run: Promise<unknown>
  trailing: Promise<unknown> | null
}

/** key → the run in flight and, once a caller arrived during it, the ONE re-run queued
 *  behind it. A run answers only the callers who asked before it started: a caller who
 *  arrives mid-run was woken by a change that run may have missed, so it waits for the
 *  trailing run instead — and every caller who arrives during the same run shares it. */
const slots = new Map<string, Slot>()

function coalesce<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const again = (): Promise<T> => {
    slots.delete(key) // synchronously replaced by the fresh slot below: no gap
    return coalesce(key, fn)
  }
  const slot = slots.get(key)
  if (slot) return (slot.trailing ??= slot.run.then(again, again)) as Promise<T>
  const fresh: Slot = {
    trailing: null,
    run: fn().finally(() => {
      if (!fresh.trailing) slots.delete(key)
    })
  }
  slots.set(key, fresh)
  return fresh.run as Promise<T>
}

/** `fn` behind the gate, keyed by `name` and every argument (NUL-joined: NUL cannot appear
 *  in a path). `name` is what keeps gitFileDiff and gitFileDiffFull — different questions
 *  about the same file — out of one slot. */
const gated =
  <A extends (string | boolean | undefined)[], R>(name: string, fn: (...args: A) => Promise<R>) =>
  (...args: A): Promise<R> =>
    coalesce([name, ...args].join('\0'), () => fn(...args))

/** Collapse a porcelain `XY` code (X = staged, Y = working tree) into the single
 *  status the file-tree decoration shows. Order matters: conflict/untracked are
 *  unambiguous; otherwise the "worst" change wins (delete > add/rename > modify). */
function classify(xy: string): GitFileStatus {
  const x = xy[0]
  const y = xy[1]
  if (xy === '??') return 'untracked'
  if (x === 'U' || y === 'U' || xy === 'AA' || xy === 'DD') return 'conflict'
  if (x === 'D' || y === 'D') return 'deleted'
  if (x === 'R' || y === 'R') return 'renamed'
  if (x === 'A' || y === 'A') return 'added'
  return 'modified'
}

/** Map a `git diff --name-status` status char to the tree's decoration. Renames/copies
 *  (R/C) are handled by the caller (they carry two paths); this covers the rest. */
function classifyDiff(code: string): GitFileStatus {
  if (code === 'A') return 'added'
  if (code === 'D') return 'deleted'
  if (code === 'U') return 'conflict'
  return 'modified' // M, T (typechange), and anything unexpected
}

/** `absRoot` → the toplevel git answered for it. Only successful answers are stored; see
 *  `resolveToplevel` for the rule that decides when a stored answer may still be used. */
const toplevelCache = new Map<string, string>()

async function exists(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p)
    return true
  } catch {
    return false
  }
}

/** The directory git's own discovery would stop at for `dir`: the nearest of `dir` and its
 *  ancestors holding a `.git` entry (a directory in a checkout, a file in a linked worktree
 *  or submodule), or null when none does. This mirrors git's upward walk minus its ceiling
 *  and cross-device stops — a difference that can only cost a re-spawn, never a wrong hit,
 *  because a disagreement is resolved by asking git again. */
async function nearestGitHolder(dir: string): Promise<string | null> {
  for (let d = dir; ;) {
    if (await exists(path.join(d, '.git'))) return d
    const parent = path.dirname(d)
    if (parent === d) return null
    d = parent
  }
}

/** Whether `toplevel`, once answered for `absRoot`, is still what git would answer. */
async function stillToplevelOf(absRoot: string, toplevel: string): Promise<boolean> {
  if (!(await exists(absRoot))) return false
  const holder = await nearestGitHolder(absRoot)
  if (holder === null) return false
  if (holder === toplevel) return true
  // `absRoot` may reach the repo through a symlink (`/tmp` → `/private/tmp` on macOS) while
  // git prints the realpath — resolve before concluding that the answer moved
  try {
    return (await fs.promises.realpath(holder)) === toplevel
  } catch {
    return false
  }
}

/**
 * The repo's realpath'd top-level dir for `absRoot` (`rev-parse --show-toplevel`). `-z`
 * status/numstat paths are top-level-relative, so callers join onto this — else a session
 * cwd in a subdir double-prefixes every path. null when `absRoot` isn't a repo / git missing.
 *
 * Cached per `absRoot`, because it was spawned on EVERY call — measured: twice per Changes
 * poll tick (`gitStatus` + `gitNumstat`) and once more per per-file diff, so a tick over 60
 * untracked files paid for 62 identical `rev-parse` processes. The answer is a PATH, and a
 * directory's toplevel cannot change while that directory exists except by moving where
 * `.git` lives, so the invalidation rule is a stat walk, not a timer: a hit is trusted only
 * when `absRoot` still exists, `<toplevel>/.git` still exists, and no `.git` has appeared
 * in any directory between the two (git picks the NEAREST, so a nested `git init` there
 * moves the answer). Anything else is a miss and asks git again; an answer git refuses to
 * give is not cached. A `.git` deleted and recreated AT THE SAME PATH is deliberately not
 * a miss — the toplevel is that path either way, so the cached answer is still right. The
 * walk costs a handful of `access` syscalls, against the ~10 ms of a process spawn.
 */
async function resolveToplevel(absRoot: string): Promise<string | null> {
  const hit = toplevelCache.get(absRoot)
  if (hit !== undefined) {
    if (await stillToplevelOf(absRoot, hit)) return hit
    toplevelCache.delete(absRoot)
  }
  const top = (await gitOut(['-C', absRoot, 'rev-parse', '--show-toplevel']))?.trim()
  if (top) toplevelCache.set(absRoot, top)
  return top || null
}

/**
 * The repo's default branch: `origin/HEAD`'s target if it is set AND still exists, else
 * the first of origin/main, origin/master, main, master that resolves. null when none do.
 *
 * The RETURN SHAPE is part of the contract, and the two shapes are not interchangeable:
 * a value prefixed `origin/` is a remote-tracking ref (the freshness engine's `defRef`;
 * fetch/pull refspecs need it with the prefix STRIPPED), while a bare local name
 * (`main` / `master`) means the last two fallback levels hit — there is no remote
 * default branch at all, which the freshness engine must read as "nothing to measure".
 *
 * `timeoutMs` is the CALLER's to set and overrides the module's own cap: the freshness
 * engine caps it hard because it runs on a timer beside the network, while the file-tree's
 * diffBase waits for as long as `GIT_TIMEOUT_MS` allows — a tighter budget there would
 * silently drop every decoration in a repo whose metadata read is slow.
 */
export async function defaultBranch(
  absRoot: string,
  { timeoutMs }: { timeoutMs?: number } = {}
): Promise<string | null> {
  const opts = { timeout: timeoutMs }
  const refExists = async (ref: string): Promise<boolean> =>
    (await gitOut(['-C', absRoot, 'rev-parse', '--verify', '--quiet', ref], opts)) !== null
  const ref = (
    await gitOut(['-C', absRoot, 'symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], opts)
  )?.trim()
  if (ref) {
    const short = ref.replace(/^refs\/remotes\//, '') // refs/remotes/origin/main → origin/main
    // a DANGLING origin/HEAD (common after the server renames master → main) names a
    // ref that no longer exists; handing it out fatals every caller downstream
    if (await refExists(short)) return short
  }
  for (const ref of ['origin/main', 'origin/master', 'main', 'master']) {
    if (await refExists(ref)) return ref
  }
  return null
}

/**
 * The commit the Workbench's "changes" are measured against: the merge-base of HEAD and
 * the default branch, so work that's been *committed* on a feature branch (but not yet
 * merged) stays visible — not just uncommitted edits. Two-dot `git diff <base>` then
 * shows everything since the branch forked, working-tree edits included. Degrades to
 * `HEAD` when there's no default branch / no common ancestor (so behavior matches a
 * plain working-tree diff), and to null when HEAD itself doesn't resolve (a fresh repo
 * with no commits) — callers then take their staged+unstaged fallback.
 *
 * Exported (as `fs.diffBase`): every consumer below used to re-derive this
 * privately, so one Changes refresh spawned the same `symbolic-ref` + `merge-base` pair
 * four times over. The renderer now resolves it ONCE per refresh and passes the sha down
 * as `base` — which is also what makes FR-39's "vs HEAD" switch a matter of passing the
 * literal `'HEAD'` instead of a second code path (NFR-02).
 */
async function resolveBase(absRoot: string): Promise<string | null> {
  const def = await defaultBranch(absRoot)
  if (def) {
    // null: no common ancestor (unrelated histories) or no HEAD — fall back to HEAD/null
    const mb = (await gitOut(['-C', absRoot, 'merge-base', 'HEAD', def]))?.trim()
    if (mb) return mb
  }
  const head = await gitOut(['-C', absRoot, 'rev-parse', '--verify', '--quiet', 'HEAD'])
  return head === null ? null : 'HEAD' // null: fresh repo, no commits
}

export const diffBase = gated('base', resolveBase)

/**
 * The only `base` values the IPC boundary may hand back into git's argv: the literal
 * `HEAD`, or a hex object id — i.e. exactly what `diffBase` above can have returned.
 * Anything else answers undefined, which every consumer reads as "self-derive".
 *
 * A type check alone is not enough, and this was measured: `git diff <base> …` takes the
 * base in an OPTION-PARSABLE position, and the `--` that follows it guards only the
 * pathspecs — so a renderer-supplied `base` of `--output=<file>` wrote that file through
 * all four channels (`gitStatus`, `gitNumstat`, `gitDiff`, `gitFileDiff`). A whitelist
 * closes that for good: no option starts with a hex digit or `H`.
 */
export function sanitizeBase(b: unknown): string | undefined {
  return typeof b === 'string' && /^(HEAD|[0-9a-f]{4,64})$/.test(b) ? b : undefined
}

/** Parse `git status --porcelain=v1 -z` `stdout` into `out`. A rename/copy record (X or
 *  Y is R/C) is followed by a second NUL field (the source), which is consumed/skipped. */
function parsePorcelainInto(out: GitStatusMap, stdout: string, toplevel: string): void {
  const tokens = stdout.split('\0')
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]
    if (tok.length < 4) continue // '' trailer or malformed
    const xy = tok.slice(0, 2)
    const rel = tok.slice(3)
    if (xy[0] === 'R' || xy[0] === 'C') i++ // skip the rename/copy source path
    out[path.join(toplevel, rel)] = classify(xy)
  }
}

/** Parse `git diff --name-status -z <base>` `stdout` into `out`. Tokens alternate
 *  `<status>`,`<path>`; a rename/copy (`R<score>`/`C<score>`) inserts an extra path token
 *  (old then new) and the status is attributed to the new path. Paths are top-level-relative
 *  even when git runs in a subdir, so callers join onto `toplevel`. */
function parseNameStatusInto(out: GitStatusMap, stdout: string, toplevel: string): void {
  const tokens = stdout.split('\0')
  for (let i = 0; i < tokens.length; i++) {
    const code = tokens[i]
    if (!code) continue // '' trailer
    if (code[0] === 'R' || code[0] === 'C') {
      const dst = tokens[i + 2] // i+1 = old path, i+2 = new path
      if (dst) out[path.join(toplevel, dst)] = 'renamed'
      i += 2
    } else {
      const rel = tokens[i + 1]
      if (rel) out[path.join(toplevel, rel)] = classifyDiff(code[0])
      i += 1
    }
  }
}

/**
 * Per-file change status for the repo at `absRoot`, as an absolute-path → status map for
 * the file tree's git decoration. The change set is everything that differs from the
 * merge-base with the default branch (see `diffBase`) — so files *committed* on a feature
 * branch stay decorated until the branch merges, not just uncommitted edits — plus
 * untracked files (which `git diff` never lists). `-z` NUL-separates records so paths with
 * spaces/newlines survive. Falls back to plain working-tree status when no base resolves
 * (detached HEAD with no default branch, or a fresh repo). Returns {} when `absRoot` isn't
 * a git repo / git is missing — callers treat that as "no git decoration".
 */
async function statusOf(absRoot: string, baseIn?: string): Promise<GitStatusMap> {
  const cap = { maxBuffer: 32 * 1024 * 1024 }
  // a caller-supplied base is used as given and skips resolution entirely (NFR-02); with
  // none, the self-derived path is exactly what it always was
  const [toplevel, base] = await Promise.all([
    resolveToplevel(absRoot),
    baseIn === undefined ? diffBase(absRoot) : Promise.resolve(baseIn)
  ])
  if (!toplevel) return {} // not a repo / git missing
  const out: GitStatusMap = {}
  // The three listings below ask git three independent questions, so they are SPAWNED
  // together and only their results are applied one after another. Awaiting each before
  // starting the next cost three serial round trips per poll tick for a map whose
  // overlay order — tracked, then untracked, then (below) the porcelain fallback and the
  // conflict overlay last — is decided here, not by who answered first. Each listing keeps
  // its own "said no → leave what we have" verdict, which is why one failing still cannot
  // take the other two down with it.
  const [trackedOut, othersOut, unmergedOut] = await Promise.all([
    // tracked changes since the branch forked from the default branch (committed + working)
    base ? gitOut(['-C', absRoot, 'diff', '--name-status', '-z', base, '--'], cap) : null,
    // untracked files: `git diff` omits them, so list them separately to keep their badge.
    //
    // Run at the TOPLEVEL, not at `absRoot`, and with `--full-name` — both measured, and
    // the two fix different things. `ls-files --others` lists only the files UNDER its cwd,
    // where every other listing here covers the whole repo, so from a session rooted in a
    // subdirectory an untracked file elsewhere in the repo simply went missing; `-C toplevel`
    // is what widens the scope. And it prints paths relative to that cwd, so the join below
    // used to key `<subdir>/newfile.txt` as `<toplevel>/newfile.txt` — a file that does not
    // exist (Changes showed a row whose diff loaded forever; Browse gave the real file no
    // badge). `--full-name` pins the path base to the toplevel regardless of the cwd, the
    // same fix the unmerged overlay below needed.
    gitOut(
      ['-C', toplevel, 'ls-files', '--others', '--exclude-standard', '-z', '--full-name'],
      cap
    ),
    // Unmerged paths, overlaid last so they win.
    //
    // Measured, and counter-intuitive: `git diff --name-status <base>` reports a file with
    // an UNRESOLVED conflict as plain `M` — the `U` code appears only in a bare index-vs-
    // worktree diff, in `--cached`, and in porcelain (`UU`). So on the path this function
    // normally takes (a working base), `classifyDiff`'s `'U'` branch is unreachable and a
    // live conflict is indistinguishable from an ordinary edit. FR-41/FR-42 turn on telling
    // them apart — a conflict takes a one-line summary and does NOT expand — so the state
    // has to be asked for directly. `ls-files -u` is the direct question; it prints nothing
    // outside a merge, so the cost on a clean tree is one cheap spawn.
    //
    // Both flags are load-bearing, not tidiness, and they fix two DIFFERENT defects —
    // the same pair the untracked listing above needed. `ls-files` lists only what sits
    // under its cwd, so run from a session rooted in a subdirectory it never saw a
    // conflict elsewhere in the repo and that file kept the base diff's `M` and expanded;
    // `-C toplevel` widens the scope to match `diff --name-status`. And it prints paths
    // relative to that cwd, so without `--full-name` a conflict under the subdirectory
    // was keyed at `<toplevel>/<basename>` — a path nothing else lists. Measured; the
    // fixtures put the session root AT the toplevel, which is why the suite saw neither
    // until a subdirectory-rooted case was written.
    gitOut(['-C', toplevel, 'ls-files', '-u', '-z', '--full-name'], cap)
  ])
  if (trackedOut !== null) parseNameStatusInto(out, trackedOut, toplevel)
  if (othersOut !== null) {
    for (const rel of othersOut.split('\0')) {
      if (rel) out[path.join(toplevel, rel)] = 'untracked'
    }
  } // else: no untracked listing — keep what we have
  // no base / base diff said no: fall back to plain working-tree status so uncommitted
  // edits still decorate (a fresh repo, or detached HEAD with no default branch). This one
  // stays serial on purpose — whether it is asked at all depends on the base diff's answer.
  if (trackedOut === null) {
    const porcelain = await gitOut(['-C', absRoot, 'status', '--porcelain=v1', '-z'], cap)
    if (porcelain !== null) parsePorcelainInto(out, porcelain, toplevel)
    // else: leave out as-is (untracked-only, or empty)
  }
  if (unmergedOut !== null) {
    for (const rec of unmergedOut.split('\0')) {
      // `<mode> <sha> <stage>\t<path>` — one record per stage, so a path repeats
      const tab = rec.indexOf('\t')
      if (tab < 0) continue
      out[path.join(toplevel, rec.slice(tab + 1))] = 'conflict'
    }
  } // else: no unmerged listing — the base diff's classification stands
  return out
}

export const gitStatus = gated('status', statusOf)

/** Parse `git diff --numstat -z` `stdout` into `out`, summing when a path repeats so the
 *  no-HEAD staged+unstaged passes merge. `-z` emits `<add>\t<del>\t<path>` per record, or for
 *  a rename `<add>\t<del>\t\0<old>\0<new>` — the delta is attributed to the new path. Binary
 *  files (`-\t-`) are skipped. */
function parseNumstatInto(out: GitNumstatMap, stdout: string, toplevel: string): void {
  const tokens = stdout.split('\0')
  for (let i = 0; i < tokens.length; i++) {
    // `[\s\S]` (not `.`) so a path containing a newline still matches within its token
    const m = /^(-|\d+)\t(-|\d+)\t([\s\S]*)$/.exec(tokens[i])
    if (!m) continue // '' trailer or malformed
    let rel = m[3]
    if (rel === '') {
      rel = tokens[i + 2] ?? '' // rename: next token is the old path, the one after is new
      i += 2
    }
    if (!rel || m[1] === '-') continue // missing path, or binary (no line delta)
    const key = path.join(toplevel, rel)
    const prev = out[key]
    const added = parseInt(m[1], 10)
    const removed = parseInt(m[2], 10)
    out[key] = prev
      ? { added: prev.added + added, removed: prev.removed + removed }
      : { added, removed }
  }
}

/**
 * Net line delta per changed tracked file vs the merge-base with the default branch
 * (`git diff <base> --numstat`) for the file tree's +N/−M badge — the *net* change,
 * matching `git diff`, unlike the session tracker's running edit-volume count, and
 * counting work already committed on the branch. Falls back to summed staged + unstaged
 * numstat when there's no base/HEAD yet (fresh repo), mirroring gitDiff so newly
 * `git add`-ed files still show. {} when not a repo / git missing → callers fall back to
 * the session's edit-volume estimate.
 */
async function numstatOf(absRoot: string, baseIn?: string): Promise<GitNumstatMap> {
  const cap = { maxBuffer: 64 * 1024 * 1024 }
  const [toplevel, base] = await Promise.all([
    resolveToplevel(absRoot),
    baseIn === undefined ? diffBase(absRoot) : Promise.resolve(baseIn)
  ])
  if (!toplevel) return {} // not a repo / git missing
  const out: GitNumstatMap = {}
  if (base) {
    // `--` terminates the argv the same way every other diff here does, so `base` can
    // never be read as the start of a pathspec (see `sanitizeBase` for the rev side)
    const vsBase = await gitOut(['-C', absRoot, 'diff', base, '--numstat', '-z', '--'], cap)
    if (vsBase !== null) {
      parseNumstatInto(out, vsBase, toplevel)
      return out
    }
    // said no — fall through to the fresh-repo fallback
  }
  // No base/HEAD yet (fresh repo): sum staged (vs empty tree) + unstaged so new files show.
  const [cached, unstaged] = await Promise.all([
    gitOut(['-C', absRoot, 'diff', '--cached', '--numstat', '-z', '--'], cap),
    gitOut(['-C', absRoot, 'diff', '--numstat', '-z', '--'], cap)
  ])
  if (cached !== null && unstaged !== null) {
    parseNumstatInto(out, cached, toplevel)
    parseNumstatInto(out, unstaged, toplevel)
  } // else: leave out empty — reads as "no numstat" → session estimate is used
  return out
}

export const gitNumstat = gated('numstat', numstatOf)

/** What a diff channel hands back. `truncated` exists because git's stdout is capped by
 *  `maxBuffer`, and an overflow used to hand back the partial diff SILENTLY — a half diff
 *  presented as the complete change set. The renderer needs to tell the two apart to show
 *  §Edge's "change set too large" banner. */
export interface DiffResult {
  text: string
  truncated: boolean
}

/** A maxBuffer overflow — or the timeout killing git mid-output — leaves a usable
 *  (truncated) diff on the rejected error's stdout. Returning it beats falling through and
 *  showing "no changes" for a huge real diff — but it must be LABELLED, which is the whole
 *  difference from the pre- behavior. A killed git that printed nothing rejects on
 *  through, exactly as `gitOut` does. */
function partialOf(e: unknown): DiffResult | null {
  const partial = (e as { stdout?: string }).stdout
  if (typeof partial === 'string' && partial) return { text: partial, truncated: true }
  if (wasKilled(e)) throw e
  return null
}

/** Unified diff vs `base` (defaulting to the merge-base with the default branch, so
 *  staged + unstaged + committed branch work all show) for the repo at `absRoot` — the
 *  Changes stream's input, with the toplevel its paths are relative to. Falls back to a
 *  plain `git diff` (staged + unstaged) when there's no base/HEAD yet (fresh repo).
 *  `notRepo` tells "no repo" apart from a repo with nothing to show — both answer ''
 *  with no base. */
async function diffOf(
  absRoot: string,
  baseIn?: string
): Promise<DiffResult & { notRepo: boolean; toplevel: string | null }> {
  const [toplevel, base] = await Promise.all([
    resolveToplevel(absRoot),
    baseIn === undefined ? diffBase(absRoot) : baseIn
  ])
  if (!toplevel) return { text: '', truncated: false, notRepo: true, toplevel }
  return { ...(await aggregateDiff(absRoot, base)), notRepo: false, toplevel }
}

export const gitDiff = gated('diff', diffOf)

async function aggregateDiff(absRoot: string, base: string | null): Promise<DiffResult> {
  const cap = { maxBuffer: 64 * 1024 * 1024 }
  if (base) {
    try {
      const { stdout } = await git(['-C', absRoot, 'diff', base, '--'], cap)
      return { text: stdout, truncated: false }
    } catch (e) {
      const partial = partialOf(e)
      if (partial) return partial
      // otherwise fall through to the fresh-repo fallback
    }
  }
  // No base/HEAD yet (fresh repo): combine staged + unstaged so newly `git add`-ed files show.
  try {
    const [cached, unstaged] = await Promise.all([
      git(['-C', absRoot, 'diff', '--cached', '--'], cap),
      git(['-C', absRoot, 'diff', '--'], cap)
    ])
    return { text: cached.stdout + unstaged.stdout, truncated: false }
  } catch (e2) {
    return partialOf(e2) ?? { text: '', truncated: false }
  }
}

/** Whether `absPath` is tracked in the repo at `toplevel`. Tells an untracked new file
 *  (show it whole) apart from a tracked-but-unmodified one (genuinely no diff). */
async function isTracked(toplevel: string, absPath: string): Promise<boolean> {
  return (await gitOut(['-C', toplevel, 'ls-files', '--error-unmatch', '--', absPath])) !== null
}

/** Whether `absPath` is gitignored (`check-ignore -q` exits 0 when ignored). Such files
 *  aren't pending changes, so the whole-file `--no-index` fallback shouldn't synthesize a
 *  diff for them (e.g. a session-written build artifact / .env force-revealed in the tree). */
async function isIgnored(toplevel: string, absPath: string): Promise<boolean> {
  return (await gitOut(['-C', toplevel, 'check-ignore', '-q', '--', absPath])) !== null
}

/** If `absPath` is a rename target vs `base`, the old file's absolute path; else null. A
 *  per-file `git diff <base> -- <newpath>` drops the old path and so reports a rename as a
 *  whole-file add; this recovers the pairing from a rename-detecting name-status over the
 *  whole tree — same flags as `gitStatus`, so it agrees with the tree's badge. Token layout
 *  matches `parseNameStatusInto`: a rename/copy is `R<score>`/`C<score>`,`<old>`,`<new>`. */
async function renameSourceOf(
  toplevel: string,
  base: string,
  absPath: string
): Promise<string | null> {
  const stdout = await gitOut(['-C', toplevel, 'diff', '--name-status', '-z', base, '--'], {
    maxBuffer: 32 * 1024 * 1024
  })
  if (stdout === null) return null // name-status said no — caller keeps the un-paired diff
  const tokens = stdout.split('\0')
  for (let i = 0; i < tokens.length; i++) {
    const code = tokens[i]
    if (!code) continue // '' trailer
    if (code[0] === 'R' || code[0] === 'C') {
      const src = tokens[i + 1]
      const dst = tokens[i + 2]
      if (dst && src && path.join(toplevel, dst) === absPath) return path.join(toplevel, src)
      i += 2
    } else {
      i += 1
    }
  }
  return null
}

/**
 * Unified diff for a single file `absPath`, measured against the same base as `gitDiff`
 * (merge-base with the default branch — so committed branch work shows too; staged+unstaged
 * in a fresh repo). An untracked file is absent from `git diff`, so it falls back to a
 * `--no-index` diff against /dev/null and reads as whole-file additions; a tracked-but-
 * unmodified file genuinely has no diff. '' when the file isn't in a repo / git is missing /
 * unchanged. Powers the viewer's per-file diff. `context` (lines of unified context) is
 * threaded through every git invocation so the same logic serves both the compact aggregate
 * use and the inline full-file view.
 *
 * `untracked` is the renderer saying "my status map lists this path as untracked", which
 * lets the file go straight to the `--no-index` diff. Measured before it existed: an
 * untracked file cost FIVE spawns (`rev-parse`, an empty `diff <base>`, `ls-files
 * --error-unmatch`, `check-ignore`, then `--no-index`), and Changes re-diffs every untracked
 * file (cap 60, 8 in flight) on every watcher tick — about 3.8 s per tick at 60 files, longer
 * than the debounce. With the flag it is the `--no-index` diff plus a (cached) `rev-parse`.
 * The `ls-files` / `check-ignore` probes are skipped along with the base diff, so an
 * IGNORED untracked file is shown when asked for — the renderer only asks about paths its
 * status map lists, and that map is `--exclude-standard`, so such a request means the user
 * force-revealed the file and wants to see it. A stale claim (the file was tracked between
 * the map's tick and this call) shows the whole file as an add, which is exactly what the
 * badge next to it says; the next tick corrects both together.
 */
async function fileDiff(
  absPath: string,
  context?: number,
  baseIn?: string,
  untracked = false
): Promise<DiffResult> {
  const cap = { maxBuffer: 64 * 1024 * 1024 }
  // `-U<n>` right after `diff` widens the context on every path below (base, rename-paired,
  // fresh-repo, --no-index); omitted → git's default 3.
  const ctx = context === undefined ? [] : [`-U${context}`]
  const dir = path.dirname(absPath)
  const [toplevel, base] = await Promise.all([
    resolveToplevel(dir),
    // an untracked file has no base to measure against, so never spend a resolution on one
    untracked || baseIn !== undefined ? Promise.resolve(baseIn) : diffBase(dir)
  ])
  if (!toplevel) return { text: '', truncated: false } // not a repo / git missing
  if (untracked) return noIndexDiff(toplevel, absPath, ctx, cap)
  if (base) {
    try {
      const { stdout } = await git(['-C', toplevel, 'diff', ...ctx, base, '--', absPath], cap)
      if (stdout) {
        // A renamed-and-edited file diffs as a whole-file add when scoped to its new path
        // alone (the bare pathspec drops the old path, defeating rename detection). When the
        // result looks like a fresh add, check whether it's actually a rename and, if so,
        // re-diff old+new together so the real (small) change shows — matching the tree's
        // rename-aware +N/−M badge. Modified files have no "new file mode" line and skip this.
        if (/^new file mode /m.test(stdout)) {
          const src = await renameSourceOf(toplevel, base, absPath)
          if (src) {
            try {
              const paired = await git(
                ['-C', toplevel, 'diff', ...ctx, base, '--', src, absPath],
                cap
              )
              if (paired.stdout) return { text: paired.stdout, truncated: false }
            } catch (e) {
              const partial = partialOf(e)
              if (partial) return partial
            }
          }
        }
        return { text: stdout, truncated: false }
      }
    } catch (e) {
      const partial = partialOf(e)
      if (partial) return partial
      // The panel's base can be a sha from another repo (＋ ▸ Open file…): a `bad
      // object` there, exit 128. Re-measure against the file's own repo.
      if ((e as { code?: unknown }).code === 128) {
        const own = await diffBase(toplevel)
        if (own && own !== base) return fileDiff(absPath, context, own)
      }
    }
  } else if (context !== undefined) {
    // Fresh repo (no base/HEAD), full-context: the inline viewer needs ONE whole-file hunk,
    // so diff the working tree against the empty tree (whole file as additions). Concatenating
    // staged + unstaged (the compact path below) would emit TWO whole-file hunks for a
    // staged-then-edited file, which the single-hunk inline parser would render twice.
    try {
      const { stdout } = await git(['-C', toplevel, 'diff', ...ctx, EMPTY_TREE, '--', absPath], cap)
      if (stdout) return { text: stdout, truncated: false }
    } catch (e) {
      const partial = partialOf(e)
      if (partial) return partial
    }
  } else {
    // fresh repo (no base/HEAD): staged + unstaged, mirroring gitDiff's fallback
    try {
      const [cached, unstaged] = await Promise.all([
        git(['-C', toplevel, 'diff', ...ctx, '--cached', '--', absPath], cap),
        git(['-C', toplevel, 'diff', ...ctx, '--', absPath], cap)
      ])
      const combined = cached.stdout + unstaged.stdout
      if (combined) return { text: combined, truncated: false }
    } catch (e) {
      const partial = partialOf(e)
      if (partial) return partial
    }
  }
  // empty so far: an untracked new file shows whole-file additions; a tracked unmodified
  // file truly has no diff, and a gitignored file isn't a pending change at all.
  if (await isTracked(toplevel, absPath)) return { text: '', truncated: false }
  if (await isIgnored(toplevel, absPath)) return { text: '', truncated: false }
  return noIndexDiff(toplevel, absPath, ctx, cap)
}

/** The whole of `absPath` as additions: `git diff --no-index` against /dev/null, which is
 *  how a file git does not know about gets a diff at all. It exits non-zero when content
 *  differs, so the diff arrives on the rejected error's stdout (a toplevel-relative path →
 *  clean headers). Shared by the probed tail of `fileDiff` and its `untracked` fast path,
 *  so the two can never drift apart in what they emit. */
async function noIndexDiff(
  toplevel: string,
  absPath: string,
  ctx: string[],
  cap: { maxBuffer: number }
): Promise<DiffResult> {
  const rel = path.relative(toplevel, absPath)
  try {
    const { stdout } = await git(
      ['-C', toplevel, 'diff', ...ctx, '--no-index', '--', '/dev/null', rel || absPath],
      cap
    )
    return { text: stdout, truncated: false }
  } catch (e) {
    // `--no-index` exits non-zero whenever content differs, so a diff arriving here is
    // the NORMAL path, not an overflow — only label it truncated when stdout hit the cap
    // or the timeout killed git mid-output
    const cut =
      (e as { code?: string }).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || wasKilled(e)
    return { text: partialOf(e)?.text ?? '', truncated: cut }
  }
}

/** Compact per-file diff (git's default 3 lines of context) at `base`. `untracked` is the
 *  renderer's claim that its status map lists the file as untracked — see `fileDiff`. */
export const gitFileDiff = gated('file', (absPath: string, base?: string, untracked?: boolean) =>
  fileDiff(absPath, undefined, base, untracked === true)
)

/** A `-U` larger than any real file, so every unchanged line is emitted as context and the
 *  whole file diffs as a single hunk — the input the viewer's inline full-file diff renders. */
const FULL_CONTEXT = 1_000_000_000

/** git's canonical empty-tree object id (constant across every repo). Diffing the working
 *  tree against it yields the whole file as one additions-only hunk — used for the
 *  full-context path in a repo with no commits yet (see fileDiff's fresh-repo branch). */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

/** Full-context per-file diff: the whole file as one hunk (context + adds + dels). Powers
 *  a `file` tab's Diff view and FR-38's per-block ⤢ expand-context. It takes `base` for
 *  the same reason the compact one does — expanding a block while Changes sits on
 *  `vs HEAD` must widen THAT diff, not silently re-derive the merge-base. */
export const gitFileDiffFull = gated(
  'full',
  (absPath: string, base?: string, untracked?: boolean) =>
    fileDiff(absPath, FULL_CONTEXT, base, untracked === true)
)
