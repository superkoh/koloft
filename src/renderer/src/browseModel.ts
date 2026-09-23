import type { DirEntry, GitNumstatMap, GitStatusMap, PreviewItem, SessionInfo } from '@shared/types'
import { isWebPagePath, previewKindForPath } from '@shared/preview'

/**
 * The pure half of Browse (FR-44…FR-49) — everything the navigation column decides
 * BEFORE it touches React or the DOM: the synthetic tree, the two virtual roots' filtering
 * rules, the decoration indices, and the search-result shaping.
 *
 * It is a module of its own because these are exactly the rules that got lost when the
 * retiring `FileTree.tsx` grew: A7's Outside allowlist, the scratchpad de-duplication and
 * the `tasks/` blackout were four scattered `useMemo` bodies with the reasoning in
 * comments. Here they are named, exported and pinned by `test/unit/browseModel.test.ts`,
 * so "Browse reproduces the tree" is a checkable claim rather than a hope.
 *
 * Nothing here reads `window`, `localStorage` or the DOM: the caller passes the home dir,
 * the listings and the session in.
 */

// ---------------------------------------------------------------------------
// paths

/** `p` is `root` itself or lives under it. String-only (the renderer has no `path`). */
export function inRoot(p: string, root: string): boolean {
  return p === root || p.startsWith(root + '/')
}

/** `p` relative to `root`, or `p` unchanged when it is outside. */
export function relTo(p: string, root: string): string {
  return inRoot(p, root) ? p.slice(root.length + 1) : p
}

/** Directories from `p`'s parent up to and including `root` (`p` must be within `root`). */
export function ancestorDirs(p: string, root: string): string[] {
  const out: string[] = []
  let d = p.slice(0, p.lastIndexOf('/'))
  while (d === root || d.startsWith(root + '/')) {
    out.push(d)
    if (d === root) break
    d = d.slice(0, d.lastIndexOf('/'))
  }
  return out
}

/** Shorten a path-ish string keeping head and tail with an ellipsis between, so the most
 *  identifying parts stay visible. The full text stays on the row's hover title. */
export function midTruncate(s: string, max = 26): string {
  if (s.length <= max) return s
  const head = Math.ceil((max - 1) / 2)
  const tail = Math.floor((max - 1) / 2)
  return s.slice(0, head) + '…' + s.slice(s.length - tail)
}

/**
 * The dim secondary hint on a row that is NOT in its own tree position (search hits,
 * bookmarks, Recents, Outside): in-project files show their directory relative to the
 * project, out-of-project files the `~`-abbreviated absolute directory. Empty for a file
 * sitting directly at the project root — the name already says everything.
 */
export function locFor(p: string, root: string, home: string): string {
  if (inRoot(p, root)) {
    const rel = relTo(p, root)
    const slash = rel.lastIndexOf('/')
    return slash === -1 ? '' : rel.slice(0, slash)
  }
  return shortenHome(p.slice(0, p.lastIndexOf('/')), home)
}

/** `p` with the user's home replaced by `~`. Every surface that shows an absolute path
 *  outside a project — the picker's note, C8's launch line, the welcome's folder list —
 *  abbreviates it the same way. */
export function shortenHome(p: string, home: string): string {
  return home && (p === home || p.startsWith(home + '/')) ? '~' + p.slice(home.length) : p
}

// ---------------------------------------------------------------------------
// synthetic trees

/**
 * A node in a tree built purely from a flat list of file paths. Directories are implicit,
 * so files the lazy listing hides — gitignored, or under a HEAVY dir — still appear here.
 * That is what FR-47's "written gitignored files forced visible" is made of.
 */
export interface SynNode {
  name: string
  path: string
  isDir: boolean
  children: SynNode[]
}

function sortSyn(nodes: SynNode[]): void {
  nodes.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  })
  for (const n of nodes) if (n.children.length) sortSyn(n.children)
}

/** Build the implicit directory tree spanning `paths`, rooted at (but not including)
 *  `root`. Paths outside `root` are ignored. Dirs before files, case-insensitive. */
export function buildSyn(paths: readonly string[], root: string): SynNode[] {
  const rootNode: SynNode = { name: '', path: root, isDir: true, children: [] }
  for (const p of paths) {
    if (!inRoot(p, root)) continue
    const rel = p.slice(root.length + 1)
    if (!rel) continue
    const segs = rel.split('/')
    let cur = rootNode
    let curPath = root
    for (let i = 0; i < segs.length; i++) {
      curPath = curPath + '/' + segs[i]
      const isLast = i === segs.length - 1
      let child = cur.children.find((c) => c.name === segs[i])
      if (!child) {
        child = { name: segs[i], path: curPath, isDir: !isLast, children: [] }
        cur.children.push(child)
      }
      cur = child
    }
  }
  sortSyn(rootNode.children)
  return rootNode.children
}

/**
 * FR-47's force-reveal: of the session-written files under `dir`, the ones whose first
 * path segment is NOT among the real listing's entries. Those are exactly the writes the
 * lazy listing hides (gitignored, or inside a HEAVY dir), and they are re-added as a
 * synthetic subtree so an agent's `dist/` or `.env` write is never lost from the tree.
 */
export function hiddenTouchedUnder(
  dir: string,
  entries: readonly DirEntry[],
  touchedInProject: readonly string[]
): string[] {
  const names = new Set(entries.map((e) => e.name))
  const prefix = dir + '/'
  return touchedInProject.filter(
    (p) => p.startsWith(prefix) && !names.has(p.slice(prefix.length).split('/')[0])
  )
}

// ---------------------------------------------------------------------------
// FR-46 — the two virtual roots, carrying A7's locked constraints

/**
 * Claude's `tasks/` directory (sibling of the per-session scratchpad) holds full subagent
 * transcripts, single files of which reach megabytes — `docs/claude-code-contract.md` §2.
 * A7 keeps it out of EVERY root, so this is checked against both spellings: the sibling of
 * the scratchpad and a `tasks/` sitting inside it. `scratchpadDir` is undefined until the
 * session binds a transcript, in which case nothing can be a tasks path yet.
 */
export function isTasksPath(p: string, scratchpadDir: string | undefined): boolean {
  if (!scratchpadDir) return false
  const sessionDir = scratchpadDir.slice(0, scratchpadDir.lastIndexOf('/'))
  for (const base of [sessionDir, scratchpadDir]) {
    if (!base) continue
    const t = base + '/tasks'
    if (p === t || p.startsWith(t + '/')) return true
  }
  return false
}

/**
 * A7's Outside allowlist: markdown, html and images only. `previewKindForPath` also
 * answers 'pdf', which is deliberately NOT here — the constraint names three kinds and a
 * pdf written to /tmp is not one of them.
 */
export function isOutsideEligible(p: string): boolean {
  const k = previewKindForPath(p)
  return k === 'markdown' || k === 'image' || isWebPagePath(p)
}

/** What the ⌗ Scratchpad node may list: whatever `listDir` returned, minus `tasks/`. */
export function scratchpadEntries(
  entries: readonly DirEntry[] | undefined,
  scratchpadDir: string | undefined
): DirEntry[] {
  if (!entries) return []
  return entries.filter((e) => !isTasksPath(e.path, scratchpadDir))
}

export interface OutsideInput {
  /** every out-of-root file the session WROTE, in session order */
  candidates: readonly PreviewItem[]
  scratchpadDir: string | undefined
  /** the files the ⌗ Scratchpad node actually lists right now */
  scratchListed: ReadonlySet<string>
  /**
   * The candidates' parent directories that have been PROBED (`fs.dirExists`) and found
   * gone. A directory absent from this set is either present or not yet probed, and both
   * keep their files visible — an unprobed directory must not flicker its rows out on
   * first paint. When a directory IS gone, every file under it drops and FR-46's "a
   * missing directory hides its whole node" follows from the node having nothing left.
   *
   * Deliberately a directory-existence question rather than "does the parent's listing
   * still contain this file". `listDir` runs `git check-ignore`, so listing-based
   * membership would silently drop an external write that its own repo happens to ignore —
   * losing exactly the artifact the ↗ Outside node exists to keep reachable — and it would
   * pay a full readdir of, say, the user's home directory to answer it.
   */
  missingDirs: ReadonlySet<string>
}

/**
 * FR-46's ↗ Outside set, with all four of A7's constraints applied in one place:
 * md/html/image only, `tasks/` never, scratchpad files never (they have their own root),
 * and nothing whose directory has gone missing.
 *
 * The scratchpad exclusion is deliberately "what the Scratchpad node LISTS", not "anything
 * under the scratchpad dir": a scratchpad file `listDir` never returns — one under a
 * build-named subdir, since HEAVY is dropped everywhere — would otherwise be reachable
 * from nowhere at all.
 */
export function outsideFiles(input: OutsideInput): PreviewItem[] {
  const { candidates, scratchpadDir, scratchListed, missingDirs } = input
  return candidates.filter((f) => {
    if (!isOutsideEligible(f.src)) return false
    if (isTasksPath(f.src, scratchpadDir)) return false
    if (scratchListed.has(f.src)) return false
    return !missingDirs.has(f.src.slice(0, f.src.lastIndexOf('/')))
  })
}

// ---------------------------------------------------------------------------
// FR-47 — the decoration rail's indices

export interface SessionIndex {
  /** absolute path → the session's write record, for the ±N fallback */
  wrote: Map<string, PreviewItem>
  /** in-project written paths, in session order (drives force-reveal) */
  touchedInProject: string[]
  /** directory → how many written files live under it (the ●N dir badge) */
  touchedDirCount: Map<string, number>
  /** out-of-root written files, before A7's filtering (see `outsideFiles`) */
  outsideCandidates: PreviewItem[]
}

/**
 * Everything the rail needs from `session.files`, in one pass. Only `access: 'wrote'`
 * counts: read-only touches (Read/Grep/Glob) are deliberately not surfaced anywhere in
 * the tree, exactly as in the retiring one.
 */
export function sessionIndex(session: SessionInfo | null, root: string): SessionIndex {
  const wrote = new Map<string, PreviewItem>()
  const touchedInProject: string[] = []
  const touchedDirCount = new Map<string, number>()
  const outsideCandidates: PreviewItem[] = []
  for (const f of session?.files ?? []) {
    if (f.access !== 'wrote') continue
    wrote.set(f.src, f)
    if (!inRoot(f.src, root)) {
      outsideCandidates.push(f)
      continue
    }
    if (f.src === root) continue
    touchedInProject.push(f.src)
    for (const d of ancestorDirs(f.src, root)) {
      touchedDirCount.set(d, (touchedDirCount.get(d) ?? 0) + 1)
    }
  }
  return { wrote, touchedInProject, touchedDirCount, outsideCandidates }
}

/** Ancestor directories of every git-changed file, for the directory-level change dot. */
export function changedDirsOf(git: GitStatusMap, root: string): Set<string> {
  const s = new Set<string>()
  for (const p of Object.keys(git)) {
    if (!inRoot(p, root)) continue
    for (const d of ancestorDirs(p, root)) s.add(d)
  }
  return s
}

/**
 * FR-47's ±N. The NET change against the panel's base (`git diff --numstat`) wins, so the
 * badge matches what Changes renders for the same file; the session's own running
 * edit-volume estimate is the fallback for untracked / non-repo files git cannot diff.
 */
export function deltaFor(
  p: string,
  numstat: GitNumstatMap,
  item: PreviewItem | undefined
): { added: number; removed: number } {
  const ns = numstat[p]
  if (ns) return { added: ns.added, removed: ns.removed }
  return { added: item?.added ?? 0, removed: item?.removed ?? 0 }
}

/** The being-written pulse follows `lastWritten` and only while the session is working —
 *  `lastTouched` also moves on reads and would mask the write whenever a read lands last
 *  in a parse window. */
export function livePath(session: SessionInfo | null): string | undefined {
  return session?.status === 'working' ? session?.lastWritten : undefined
}

// ---------------------------------------------------------------------------
// FR-45 — search result shaping

/** How long the box stays quiet before a query is sent (both modes). */
export const SEARCH_DEBOUNCE_MS = 150

/** §Edge Cases — "a search has no hits". One string for both modes: the user asked one
 *  question and the answer is the same either way. */
export const NO_MATCHES = 'No matches'

/** §Edge Cases — "the backend truncated results": never present a capped list as
 *  complete. `n` is how many are actually on screen. */
export function truncationNotice(n: number): string {
  return `Showing the first ${n} — narrow the query.`
}

/** The dim directory shown beside a filename hit, so same-named files stay tellable
 *  apart. Empty when the hit sits at the search root. */
export function hitDir(rel: string): string {
  const slash = rel.lastIndexOf('/')
  return slash === -1 ? '' : rel.slice(0, slash)
}

// ---------------------------------------------------------------------------
// FR-47 — persisted expansion state

/** What goes into `koloft.ft.expanded:<root>`: in-project directories only. An expanded
 *  scratchpad SUBdir belongs to one dead session's temp path, and storing those would grow
 *  the list without bound and re-`listDir` them on every mount. */
export function persistableExpansion(expanded: Iterable<string>, root: string): string[] {
  return [...expanded].filter((d) => inRoot(d, root))
}

/** The expansion a freshly mounted tree starts from: whatever was persisted, always
 *  including the root itself so the first level is never invisible. */
export function initialExpansion(saved: readonly string[] | null, root: string): Set<string> {
  const exp = new Set(saved && saved.length ? saved : [root])
  exp.add(root)
  return exp
}
