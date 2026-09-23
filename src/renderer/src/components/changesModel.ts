import type { GitFileStatus, GitNumstatMap, GitStatusMap, SessionInfo } from '@shared/types'
import { isDocPath, relOf, splitPath, type ChangeFilters } from './filesModel'

/**
 * FR-38…FR-43 · FR-58 — everything the Changes stream can decide WITHOUT a DOM: cutting the
 * aggregate `git diff` into per-file sections, classifying each changed file, the filter
 * predicate, and the merge that makes FR-58's in-place update possible.
 *
 * It lives beside `filesModel.ts` for the same reason that one does: `ChangesView` may not
 * import its own container, and everything here is worth pinning with a unit test rather
 * than an e2e round.
 */

/**
 * How a changed file renders in the stream. `text` is the ordinary case — hunks, rows,
 * ⤢ expand-context. The other four are FR-41's special states: ONE summary row each, and
 * per FR-42 only `renamed` expands (into the paired diff the aggregate already carries).
 */
export type ChangeKind = 'text' | 'renamed' | 'binary' | 'deleted' | 'conflict'

/** One changed file, as both the left list's row and the stream's block read it. */
export interface ChangeEntry {
  /** absolute path — the key for git calls and for React's block identity (FR-58) */
  path: string
  /** path relative to the session's root; the stable `data-path` hook and the row label */
  rel: string
  /** `rel`'s directory prefix (with its trailing slash) and basename */
  dir: string
  name: string
  status: GitFileStatus
  kind: ChangeKind
  /** FR-43 — null for untracked and binary files, which `gitNumstat` deliberately omits;
   *  never backfilled with a `--no-index` count (closed open item,). */
  delta: { added: number; removed: number } | null
  /** FR-40's ownership group: this session's transcript wrote this path */
  wrote: boolean
}

/** One file's slice of a unified diff, keyed by the path git printed (repo-relative). */
export interface DiffSection {
  rel: string
  text: string
  /** `Binary files … differ` / `GIT binary patch` — the FR-41 binary state's only signal
   *  (the status map cannot tell a binary modification from a text one). */
  binary: boolean
  /** the rename source, when git paired the file (`rename from`), else null */
  renameFrom: string | null
  /** this section's OWN text was cut off by main's maxBuffer — set only on the per-file
   *  paths (`gitFileDiff` / `gitFileDiffFull`), which carry a truncation flag the
   *  aggregate's cannot speak for. A block must never present a partial diff as complete
   *  (§Edge), and that is as true one file at a time as it is for the whole set. */
  truncated?: boolean
}

/** One hunk of a section: the `@@` line the block prints as its own row, and the text to
 *  hand `parseUnifiedDiff` (the `@@` line included — that is where it reads line numbers). */
export interface DiffHunk {
  header: string
  text: string
}

// ---------------------------------------------------------------------------
// the aggregate diff → per-file sections

const SECTION_START = 'diff --git '

/**
 * Cut `gitDiff`'s whole-change-set output into per-file sections. Safe against a diff whose
 * CONTENT is itself a diff: every line inside a hunk carries a ' ', '+' or '-' prefix, so
 * only a real section header can start at column 0 with `diff --git `.
 *
 * A truncated aggregate (§Edge / WB-C11) ends mid-section; that partial tail is returned
 * like any other section — the caller shows the banner, and the partial content stays
 * readable rather than being dropped.
 */
export function splitAggregateDiff(diff: string): DiffSection[] {
  const out: DiffSection[] = []
  let buf: string[] | null = null
  const flush = (): void => {
    if (!buf) return
    const text = buf.join('\n')
    const rel = sectionPath(text)
    if (rel)
      out.push({ rel, text, binary: isBinarySection(text), renameFrom: renameSourceOf(text) })
  }
  for (const line of diff.split('\n')) {
    if (line.startsWith(SECTION_START)) {
      flush()
      buf = [line]
    } else if (buf) {
      buf.push(line)
    }
  }
  flush()
  return out
}

/** The section's lines before its first hunk — the only place header fields may be read.
 *  Past the first `@@`, a `+++ b/x` or `rename to x` line is FILE CONTENT (a diff of a
 *  diff), and matching it would name the wrong file. */
function preambleOf(section: string): string[] {
  const lines = section.split('\n')
  const at = lines.findIndex((l) => l.startsWith('@@'))
  return at < 0 ? lines : lines.slice(0, at)
}

function isBinarySection(section: string): boolean {
  return preambleOf(section).some(
    (l) => l === 'GIT binary patch' || (l.startsWith('Binary files ') && l.endsWith(' differ'))
  )
}

function renameSourceOf(section: string): string | null {
  const line = preambleOf(section).find((l) => l.startsWith('rename from '))
  return line ? line.slice('rename from '.length) : null
}

/** Which file a section is about, repo-relative. `+++ b/<path>` is preferred because it
 *  holds ONE path and runs to the end of the line (a name with spaces survives); a delete
 *  has no `+++` and falls back to `--- a/<path>`; a binary or mode-only change has neither
 *  and falls back to the `diff --git` header, whose two halves are only separable by
 *  convention. */
function sectionPath(section: string): string | null {
  const lines = preambleOf(section)
  const rename = lines.find((l) => l.startsWith('rename to '))
  if (rename) return rename.slice('rename to '.length)
  const plus = lines.find((l) => l.startsWith('+++ '))
  if (plus && !plus.startsWith('+++ /dev/null')) return stripSide(plus.slice(4))
  const minus = lines.find((l) => l.startsWith('--- '))
  if (minus && !minus.startsWith('--- /dev/null')) return stripSide(minus.slice(4))
  return headerPath(lines[0] ?? '')
}

/** Drop the `a/`/`b/` side prefix, and everything from the TAB git appends when the name
 *  contains a space (`--- a/sp ace.txt\t`) — measured against real output,. */
function stripSide(p: string): string {
  const tab = p.indexOf('\t')
  const cut = tab < 0 ? p : p.slice(0, tab)
  return cut.startsWith('a/') || cut.startsWith('b/') ? cut.slice(2) : cut
}

function headerPath(header: string): string | null {
  if (!header.startsWith(SECTION_START)) return null
  const rest = header.slice(SECTION_START.length)
  // the overwhelmingly common case: the same path on both sides, so an `a/X b/X` match
  // whose halves agree is unambiguous even when X contains a space
  const both = /^a\/(.+) b\/(.+)$/.exec(rest)
  if (both && both[1] === both[2]) return both[1]
  const at = rest.lastIndexOf(' b/')
  return at < 0 ? null : rest.slice(at + 3)
}

/** Attach each section to the absolute path the status map uses. Section paths are
 *  relative to the repo toplevel `gitDiff` hands back, never to the session root. */
export function sectionsByPath(
  sections: readonly DiffSection[],
  paths: readonly string[],
  toplevel: string | null
): Record<string, DiffSection> {
  const known = new Set(paths)
  const out: Record<string, DiffSection> = {}
  for (const s of sections) {
    const abs = `${toplevel}/${s.rel}`
    if (known.has(abs)) out[abs] = s
  }
  return out
}

/**
 * Merge a freshly fetched section map into the one on screen, REUSING every object whose
 * text is unchanged. That identity is what FR-58 rests on: `ChangeBlock` is memoized on it,
 * so a poll that touched one file re-renders one block and leaves the rest of the stream —
 * and the scroll position — untouched (WB-C09). Returns `prev` itself when nothing moved.
 */
export function mergeSections(
  prev: Record<string, DiffSection>,
  next: Record<string, DiffSection>
): Record<string, DiffSection> {
  const out: Record<string, DiffSection> = {}
  let changed = false
  for (const [path, section] of Object.entries(next)) {
    const old = prev[path]
    if (
      old &&
      old.text === section.text &&
      old.binary === section.binary &&
      old.renameFrom === section.renameFrom
    ) {
      out[path] = old
    } else {
      out[path] = section
      changed = true
    }
  }
  if (!changed && Object.keys(prev).length === Object.keys(out).length) return prev
  return out
}

/** Split one file's section into hunks. Everything before the first `@@` (the `diff --git`
 *  header, `index`, `---`/`+++`, rename/mode lines) is chrome the block prints itself. */
export function splitHunks(section: string): DiffHunk[] {
  const out: DiffHunk[] = []
  let cur: DiffHunk | null = null
  for (const line of section.split('\n')) {
    if (line.startsWith('@@')) {
      cur = { header: line, text: line }
      out.push(cur)
    } else if (cur) {
      cur.text += '\n' + line
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// entries

/** FR-40's ownership group. `access === 'wrote'` is the transcript scan's own verdict —
 *  the same signal the retiring tree's "wrote" decoration used. */
export function writtenPaths(session: SessionInfo | null): Set<string> {
  const out = new Set<string>()
  for (const f of session?.files ?? []) if (f.access === 'wrote') out.add(f.src)
  return out
}

/**
 * FR-41/FR-43 — which of the five renderings a file gets. Conflicts and deletions are
 * decided by the status map alone; `binary` needs the diff, because nothing in
 * `git status` distinguishes a binary modification from a text one.
 */
export function classifyKind(status: GitFileStatus, section: DiffSection | undefined): ChangeKind {
  if (status === 'conflict') return 'conflict'
  if (status === 'deleted') return 'deleted'
  if (status === 'renamed') return 'renamed'
  if (section?.binary) return 'binary'
  return 'text'
}

/**
 * The change set as the left list and the stream read it, sorted by directory and then by
 * name — so a directory's files are consecutive, and the list `groupByDir` folds is in the
 * stream's own order. Sorting by the whole relative path put a subdirectory between two of
 * its parent's files (`src/a.ts`, `src/lib/x.ts`, `src/z.ts`); `groupByDir` says what that
 * did.
 */
export function buildEntries(input: {
  git: GitStatusMap
  numstat: GitNumstatMap
  root: string
  written: ReadonlySet<string>
  sections: Record<string, DiffSection>
}): ChangeEntry[] {
  const { git, numstat, root, written, sections } = input
  const out: ChangeEntry[] = []
  for (const [path, status] of Object.entries(git)) {
    const kind = classifyKind(status, sections[path])
    const { dir, name } = splitPath(path, root)
    // FR-43 — untracked and binary files carry the status letter only. `gitNumstat` omits
    // them already; stating it here keeps the rule true even if a caller hands over a map
    // that doesn't.
    const raw = numstat[path]
    const delta = kind === 'binary' || status === 'untracked' ? null : (raw ?? null)
    out.push({
      path,
      rel: relOf(path, root),
      dir,
      name,
      status,
      kind,
      delta,
      wrote: written.has(path)
    })
  }
  out.sort((a, b) => cmp(a.dir, b.dir) || cmp(a.name, b.name))
  return out
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function sameEntry(a: ChangeEntry, b: ChangeEntry): boolean {
  return (
    a.path === b.path &&
    a.status === b.status &&
    a.kind === b.kind &&
    a.wrote === b.wrote &&
    a.delta?.added === b.delta?.added &&
    a.delta?.removed === b.delta?.removed &&
    (a.delta === null) === (b.delta === null)
  )
}

/**
 * Keep the object identity of every entry that did not actually move. `buildEntries` runs
 * on each poll and mints fresh objects; without this the memoized blocks would all re-render
 * whenever any one file changed, which is the "whole-stream reflow" FR-58 rules out.
 */
export function stableEntries(prev: readonly ChangeEntry[], next: ChangeEntry[]): ChangeEntry[] {
  const byPath = new Map(prev.map((e) => [e.path, e]))
  return next.map((e) => {
    const old = byPath.get(e.path)
    return old && sameEntry(old, e) ? old : e
  })
}

/** FR-40 — the three groups AND together; each is single-select with `all` as its default,
 *  so a group at `all` simply doesn't constrain. `docs` is markdown + html (`isDocPath`). */
export function passesFilters(e: ChangeEntry, f: ChangeFilters): boolean {
  if (f.status !== 'all' && e.status !== f.status) return false
  if (f.owner === 'session' && !e.wrote) return false
  if (f.type === 'docs' && !isDocPath(e.rel)) return false
  if (f.type === 'code' && isDocPath(e.rel)) return false
  return true
}

export interface ChangeGroup {
  /** the shared `dir` prefix, kept as the React key */
  dir: string
  /** what the group header prints — `/` for files at the root */
  label: string
  entries: ChangeEntry[]
}

/**
 * Fig 2's left list: ONE group per directory, in order of first appearance.
 *
 * `dir` is also the group's React key, and a key must be unique among siblings. That is a
 * hard rule rather than a nicety: given two groups under one key, React's reconciler keeps
 * only the LAST in its key map, never schedules the first for deletion, and the moment the
 * list changes shape ahead of it (a new directory sorting in front is enough) that group's
 * rows stay in the DOM as nodes React no longer knows about. They survive every later
 * render — a session switch included, which empties and refills the list around them. That
 * is how one session's rows stacked up, twice over, above another session's list
 *; it was read as a paint bug first, and the summary row moved out of the
 * scroller for it, before the rows turned out to be real.
 *
 * This used to fold consecutive runs, trusting the sort to keep a directory's files
 * together; the sort did not (see `buildEntries`). Folding through a map makes a duplicate
 * key impossible whatever order the entries arrive in, and `buildEntries`'s sort is what
 * keeps the folded order equal to the stream's — the unit test pins both.
 */
export function groupByDir(entries: readonly ChangeEntry[]): ChangeGroup[] {
  const byDir = new Map<string, ChangeGroup>()
  for (const e of entries) {
    let g = byDir.get(e.dir)
    if (!g) {
      g = { dir: e.dir, label: e.dir ? e.dir.replace(/\/$/, '') : '/', entries: [] }
      byDir.set(e.dir, g)
    }
    g.entries.push(e)
  }
  return [...byDir.values()]
}

/** What the left list's summary row prints: the whole listed set added up. */
export interface ChangeTotals {
  /** how many files the sum covers — every listed file, counted or not */
  files: number
  added: number
  removed: number
  /** files that carry NO line count at all — `delta` null: untracked and binary ones by
   *  FR-43, and any file the numstat map does not carry. They are counted here rather
   *  than dropped silently, because a set of brand-new files sums to `+0 −0` — a number
   *  that reads as "nothing changed" unless something on screen says what it leaves out. */
  noCount: number
}

/** Add up the ±N badges of the files handed in (the list shows the FILTERED set, so the
 *  caller decides which set the row describes). */
export function totalDelta(entries: readonly ChangeEntry[]): ChangeTotals {
  const out: ChangeTotals = { files: entries.length, added: 0, removed: 0, noCount: 0 }
  for (const e of entries) {
    if (!e.delta) {
      out.noCount++
      continue
    }
    out.added += e.delta.added
    out.removed += e.delta.removed
  }
  return out
}

// ---------------------------------------------------------------------------
// NFR-01's lazy highlight, the part that is arithmetic

/** How far outside the stream's viewport a block still counts as worth highlighting, in
 *  px. One value for both users — the IntersectionObserver's `rootMargin` and the sweep
 *  below — because a block that highlights under one rule and not the other would flicker
 *  its colours on and off at the boundary. */
export const HIGHLIGHT_LEAD_IN = 400

/** GitHub-style fold: a diff past this many lines is not rendered until asked. The section
 *  text is the input (not numstat) because untracked files — a new self-contained html is
 *  the common big case — have no numstat. */
export const BIG_DIFF_LINES = 2000

export function isBigDiff(text: string): boolean {
  let n = 0
  for (let i = text.indexOf('\n'); i !== -1 && n <= BIG_DIFF_LINES; i = text.indexOf('\n', i + 1))
    n++
  return n > BIG_DIFF_LINES
}

/** The vertical span of a box, in viewport coordinates (a `DOMRect` satisfies it). */
export interface Span {
  top: number
  bottom: number
}

/**
 * Is `block` near enough to `viewport` to deserve syntax highlighting? Split out of the
 * view because it is the one piece of NFR-01 that is arithmetic rather than plumbing, and
 * because an off-by-one here is invisible: the wrong answer still renders every row, just
 * with or without colour.
 */
export function nearViewport(block: Span, viewport: Span, lead = HIGHLIGHT_LEAD_IN): boolean {
  return block.bottom >= viewport.top - lead && block.top <= viewport.bottom + lead
}

/**
 * Every user-visible string the Changes stream can put on screen. They live in the pure
 * layer, not in the view, for one practical reason: §Edge names four of these states and
 * the e2e cases assert them verbatim, so a spec can import THIS module (no React, no
 * shiki) instead of copying the text and drifting from it.
 */
export const CHANGES_MSG = {
  /** §Edge — "no changes against the base" (base and filters stay usable) */
  empty: 'No changes against the base.',
  /** the first refresh has not answered yet. Distinct from `empty` on purpose: saying
   *  "no changes" before git has replied states something the panel does not know, and a
   *  hung git made it say exactly that — confidently, with no banner and no spinner. */
  loading: 'Reading the change set…',
  /** the change set is not empty; the filters hid all of it */
  filtered: 'No changes match the current filters.',
  /** §Edge — Changes says so while Browse keeps working */
  notGit: 'Not a git repository.',
  /** §Edge — a git timeout stops the polling and offers the retry */
  gitFailed: 'Repo too large or git unresponsive — retry.',
  /** the fold above — the button that renders a big file's diff */
  bigDiff: 'Large diff not shown by default — Load diff',
  /** WB-C11 — a truncated aggregate is NEVER presented as complete */
  truncated: (n: number): string => `Change set too large — showing the first ${n} files.`,
  /** FR-41's four summary rows */
  renamed: (from: string | null): string => (from ? `Renamed from ${from}` : 'Renamed'),
  binary: 'Binary file — no text diff.',
  deleted: 'File deleted — no content shown.',
  conflict: 'Merge conflict — resolve it to see a diff.',
  /** a section with no hunks at all (a mode-only change) */
  noText: 'No textual changes.',
  /** the aggregate was cut off before this file — §Edge's "never present a truncated
   *  result as complete" applies per block too */
  cutOff: 'Not shown — the change set was truncated.',
  /** this ONE file's diff overflowed main's buffer — shown under the rows that did come
   *  through, because a partial diff presented as complete is the failure §Edge names */
  fileCutOff: 'This file’s diff was truncated — showing what fits.',
  /** an untracked file past the per-file fetch cap, or a per-file diff that came back
   *  empty */
  noDiff: 'No diff available.',
  /** the left list's summary row, spelled out on hover. The numbers alone cannot say
   *  WHICH files they cover, and the answer is not the obvious one twice over: the row
   *  sums the files listed (a filter narrows it), and some files bring no line count.
   *
   *  The reason is deliberately a LIST and not a verdict. A null `delta` is usually a new
   *  or binary file (FR-43 drops those), but `buildEntries` also leaves it null for a
   *  file the numstat map simply doesn't carry — and `gitNumstat` answers `{}` for a whole
   *  repo when git fails, while `gitStatus` beside it may still have succeeded. Naming one
   *  cause would call every ordinary modified file "new or binary" in exactly that state. */
  totals: (t: ChangeTotals): string => {
    const one = t.files === 1
    let s = `${t.files} ${one ? 'file' : 'files'} listed · ${t.added} added, ${t.removed} removed.`
    if (t.noCount > 0) {
      s += ` ${t.noCount} of them ${t.noCount === 1 ? 'brings' : 'bring'} no line count (new, binary, or git gave none).`
    }
    return s
  }
} as const

/**
 * What the stream says when it has no rows to show. Pure so the ladder is testable — every
 * rung below the first exists because's manual round caught the previous version
 * claiming "No changes against the base." while the answer was still on its way:
 *
 *  · nothing answered yet → loading (a hung git left the false claim standing forever)
 *  · the aggregate diff answered WITH files but the row list is still empty → still
 *    loading. The rows come from the status map, the sections from the aggregate, and the
 *    two arrive on independent schedules; both are cut against the same resolved base
 *    (NFR-02), so this disagreement is always transient convergence — never a final state.
 *    Caught live with a 20s-slow git: diff landed at ~40s, status at ~60s, and in between
 *    the panel asserted a clean workspace over a 4-file change set.
 *    The rung only works if `files` is the number of sections the aggregate CARRIED,
 *    counted BEFORE `sectionsByPath`: that join is filtered by the status map, so a count
 *    taken after it derives from the same input as `entryCount`, the two read 0 together
 *    for the whole window, and the rung is dead code while the false claim stands — which
 *    is how it first shipped. The view counts `splitAggregateDiff`'s output for that reason.
 *  · main said there is no repo → not a repo. Main's word, not an inference: "no base and
 *    no text" was the old rule, and a fresh `git init` with no files matches it too
 */
export function emptyStreamMessage(input: {
  entryCount: number
  load: { done: boolean; failed: boolean; notRepo: boolean; files: number }
}): string {
  const { entryCount, load } = input
  if (entryCount > 0) return CHANGES_MSG.filtered
  if (!load.done && !load.failed) return CHANGES_MSG.loading
  if (load.done && !load.failed && load.files > 0) return CHANGES_MSG.loading
  if (load.done && !load.failed && load.notRepo) return CHANGES_MSG.notGit
  return CHANGES_MSG.empty
}

/**
 * NFR-02 — what to hand every git channel as its `base`. The panel resolves the baseline
 * ONCE per refresh and passes a sha or the literal `'HEAD'`; forwarding that is the whole
 * of NFR-02, and it is what WB-C17 counts.
 *
 * A NULL base is a different thing and this function cannot fix it: it means the repo has
 * no commits, and main's `baseArg` maps both `''` and `undefined` to "resolve it
 * yourself", so a fresh repo re-derives per file either way. That is deliberate rather
 * than merely tolerated — main's own staged+unstaged fallback is the only sensible answer
 * there, and it is reached exactly by not naming a base. An earlier comment here claimed
 * `''` prevented the re-derivation; it does not, and the test below now says so.
 *
 * An UNRESOLVED base (undefined) maps to the same `''`, and no caller may rely on that:
 * the stream's fetch WAITS for the baseline rather than sending an unresolved one (see
 * `ChangesView`'s fetch effect), because asking main to re-derive is exactly the double
 * resolution NFR-02 forbids. The undefined case survives here only for FR-38's ⤢, whose
 * button cannot be on screen that early — a block needs the status map, and the panel
 * clears that map in the same commit it clears the base.
 */
export function baseArg(base: string | null | undefined): string {
  return base ?? ''
}
