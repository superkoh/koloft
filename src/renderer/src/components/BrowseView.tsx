import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent
} from 'react'
import { LuFile, LuFolder, LuFolderOpen, LuStar, LuX } from 'react-icons/lu'
import type {
  ContentHit,
  DirEntry,
  EditCreateResult,
  GitNumstatMap,
  GitStatusMap,
  SearchHit,
  SessionInfo
} from '@shared/types'
import { HIDDEN_BY_DEFAULT_NAMES } from '@shared/types'
import { basename } from '@shared/preview'
import { installSlideOnHover } from './filesSide'
import {
  NO_MATCHES,
  SEARCH_DEBOUNCE_MS,
  ancestorDirs,
  buildSyn,
  changedDirsOf,
  deltaFor,
  hiddenTouchedUnder,
  hitDir,
  initialExpansion,
  inRoot,
  livePath,
  locFor,
  midTruncate,
  outsideFiles,
  persistableExpansion,
  scratchpadEntries,
  sessionIndex,
  truncationNotice,
  type SynNode
} from '../browseModel'
import {
  GIT_LETTER,
  expandedKey,
  loadFlag,
  loadList,
  saveFlag,
  saveList,
  showIgnoredKey
} from './filesModel'
import '../browseView.css'

/** The dimmed row's tooltip — the reason it was hidden a moment ago. The row is only
 *  dimmed, never labelled: the column is 252px and already carries an icon, the name, a
 *  git letter and a ±count, so the reason goes here instead of stealing width. */
export function ignoredTitle(name: string): string {
  return HIDDEN_BY_DEFAULT_NAMES.has(name)
    ? 'Hidden by default — shown because "Show ignored files" is on'
    : 'Ignored by .gitignore'
}

/**
 * FR-44…FR-49 — the Browse half of the pinned `files` tab. This is the retiring
 * `FileTree`'s job, moved into the panel: lazy directory browsing, the two virtual roots,
 * both search modes, the decoration rail, the row context menu, keyboard navigation, and
 * the two per-workspace localStorage conveniences.
 *
 * It renders the NAVIGATION column only. The reading area beside it belongs to
 * `FilesView`, which also owns FR-31's artifact header over it — that split is what makes
 * WB-B09 ("Browse and Changes reach the same artifact, with the same header") structural
 * rather than a thing to keep in sync by hand.
 *
 * Three things this view deliberately does NOT do, each one a requirement rather than an
 * omission: it runs no git poll of its own (`git` / `numstat` arrive as props from the
 * panel's single visibility-gated pipeline, FR-51/FR-58), it builds no context menu
 * (FR-48's is `FilesView`'s, shared with Changes) and it creates no tab (FR-10 —
 * `onOpen` is the one exit, and `FilesView` decides html-vs-reading-area per FR-11).
 */
export interface BrowseViewProps {
  root: string
  /** decorations come off the session: `files` carries `access` ('wrote' / 'read') and
   *  `lastWritten` drives the being-written pulse */
  session: SessionInfo | null
  git: GitStatusMap
  numstat: GitNumstatMap
  /** the file the reading area currently shows — the active row, and the target of
   *  FR-47's auto-scroll */
  current: string | null
  /** FR-45 — the search row is open */
  searchOpen: boolean
  /** bumped whenever ⌘⇧F asks for the focus, so a repeat press is observable */
  searchFocusNonce: number
  /** the search row's own close affordance; ⌘⇧F's second press comes down as
   *  `searchOpen` going false, and both must clear the query */
  onCloseSearch: () => void
  /** FR-49 — most-recent-first, capped at 12, user opens only */
  recents: string[]
  bookmarks: string[]
  /** FR-10 — a click renders in the reading area (no tab); FilesView routes html to a
   *  `web` tab per FR-11 before this ever sees it. `line` carries a content-search hit. */
  onOpen: (path: string, line?: number) => void
  /** B-03 — a DOUBLE click opens the file in a tab of its own, already editable. Two
   *  clicks to get from seeing a file to changing it, which is what reading one costs. */
  onEdit: (path: string) => void
  /** B-06 — the folder whose "New File…" is waiting for a name, or null. It is the
   *  CONTEXT MENU that starts this, and the menu lives one component up, so the state does
   *  too — the tree only renders the box. */
  newFileDir: string | null
  /** B-06 — the box is done: with the file that was created, or null when it was cancelled */
  onNewFileDone: (created: EditCreateResult | null) => void
  onContextMenu: (e: ReactMouseEvent, path: string, isDir: boolean) => void
  /** the column's width — shared with Changes' list and dragged in FilesView */
  sideWidth: number
  /**
   * FR-51 — the panel is expanded AND this tab is the active one, i.e. the same signal
   * `FilesBody` already receives and hands to `ChangesView`. It gates the filesystem calls
   * Browse makes on its own initiative (the scratchpad re-list, the ↗ Outside existence
   * probes, revealing a newly-opened file's ancestors), because `fs.listDir` spawns
   * `git check-ignore` and WB-K08 counts every git process a collapsed panel starts.
   *
   * The live directory refresh needs no flag at all — it subscribes to `fs:dir-changed`
   * without ever calling `watchDir`, so it can only fire while the PANEL's own
   * visibility-gated watch is up. Optional, defaulting to `true`, so the view is fully
   * functional before the prop is threaded through `FilesView`; until it is, an agent
   * `open` behind a collapsed panel can still cost one listing per ancestor directory.
   */
  active?: boolean
}

/* All tree icons are Lucide, as in the retiring tree: the folder's open/closed glyph IS
   the fold indicator, so there is no chevron column to pay 16px per level for. */
function FolderIcon({ open }: { open?: boolean }): JSX.Element {
  return (
    <span className="ft-icon" aria-hidden>
      {open ? <LuFolderOpen size={13} /> : <LuFolder size={13} />}
    </span>
  )
}

function FileIcon(): JSX.Element {
  return (
    <span className="ft-icon" aria-hidden>
      <LuFile size={13} />
    </span>
  )
}

type SearchMode = 'name' | 'content'

/** Synthetic `data-path` values for the rows that stand for no directory on disk. They are
 *  namespaced with `__` so they can never collide with an absolute path, and the two the
 *  retiring tree already had keep ITS spellings — `__external__` in particular is the
 *  Outside node's sentinel there, and reusing it keeps the tree-retirement's e2e migration
 *  a textual substitution rather than a rewrite. (⌗ Scratchpad has no sentinel: its
 *  `data-path` is the real scratchpad directory, as before.) */
const SEC_BOOKMARKS = '__bookmarks__'
const SEC_RECENTS = '__recents__'
const SEC_OUTSIDE = '__external__'

/** B-06 — the refusals `edit.create` can answer with, in words that say what to do next. */
function createRefusal(failure: string): string {
  if (failure.includes('KOLOFT_EXISTS')) return 'That name is taken.'
  if (failure.includes('KOLOFT_BAD_NAME')) return 'Just a file name — no “/” and no “..”.'
  // the folder itself went away under the box; another name would fail the same way, so
  // the sentence says what happened rather than inviting a retry
  if (failure.includes('KOLOFT_DIR_GONE')) return 'The folder is gone — nothing was written.'
  return 'Could not make the file.'
}

/**
 * B-06 — the inline name box, sitting where the new file will appear.
 *
 * A refusal keeps the box open with the sentence beside it: the fix is another name, and
 * the place to type it is the box that is already there. Enter creates, Escape gives up.
 */
function NewFileRow({
  onCreate,
  onCancel
}: {
  onCreate: (name: string) => Promise<string | null>
  onCancel: () => void
}): JSX.Element {
  const [error, setError] = useState('')
  return (
    <div className="ft-node ft-newfile-row">
      <FileIcon />
      <input
        className="ft-newfile"
        autoFocus
        spellCheck={false}
        placeholder="name.conf"
        aria-label="New file name"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation()
            onCancel()
            return
          }
          // the tree's own arrow navigation is one node up and it preventDefaults, so
          // without this the caret cannot move inside the box being typed into
          if (e.key.startsWith('Arrow')) e.stopPropagation()
          if (e.key !== 'Enter') return
          e.stopPropagation()
          const name = e.currentTarget.value.trim()
          if (!name) return
          setError('')
          // No in-flight guard: a second Enter on the same name answers KOLOFT_EXISTS and
          // changes nothing, while a guard that swallowed one would leave the user typing
          // into a box that had silently stopped listening.
          void onCreate(name).then((message) => {
            if (message) setError(message)
          })
        }}
      />
      {error && <span className="ft-newfile-err">{error}</span>}
    </div>
  )
}

export function BrowseView({
  root,
  session,
  git,
  numstat,
  current,
  searchOpen,
  searchFocusNonce,
  onCloseSearch,
  recents,
  bookmarks,
  onOpen,
  onEdit,
  newFileDir,
  onNewFileDone,
  onContextMenu,
  sideWidth,
  active = true
}: BrowseViewProps): JSX.Element {
  const [children, setChildren] = useState<Record<string, DirEntry[]>>({})
  const [expanded, setExpanded] = useState<Set<string>>(() =>
    initialExpansion(loadList(expandedKey(root)), root)
  )
  const [loading, setLoading] = useState<Set<string>>(new Set())
  const [errors, setErrors] = useState<Set<string>>(new Set())
  // A-01 — the switch, remembered per checkout (A-05).
  const [showIgnored, setShowIgnored] = useState(() => loadFlag(showIgnoredKey(root)))
  const [scratchOpen, setScratchOpen] = useState(true)
  const [extOpen, setExtOpen] = useState(true)
  const [bmOpen, setBmOpen] = useState(true)
  const [recentOpen, setRecentOpen] = useState(true)
  const [fsTick, setFsTick] = useState(0)

  // FR-45 — the query is local; the row's OPEN/CLOSED state is the panel's (`searchOpen`).
  const [query, setQuery] = useState('')
  const [searchMode, setSearchMode] = useState<SearchMode>('name')
  const [results, setResults] = useState<SearchHit[] | null>(null)
  const [contentResults, setContentResults] = useState<ContentHit[] | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [searching, setSearching] = useState(false)
  const [selIdx, setSelIdx] = useState(0)

  // keyboard navigation tracks the focused row by a per-row id rather than by path: the
  // same file can appear in Bookmarks, in Recents and in the tree at once, and a
  // path-keyed highlight would paint all three. The id is DOM-driven so it spans lazy,
  // synthetic, virtual-root and section rows uniformly.
  const [kbdRow, setKbdRow] = useState<string | null>(null)

  const bodyRef = useRef<HTMLDivElement>(null)
  // hover-slide for clipped names, installed on the column root so it covers the tree,
  // Bookmarks, Recent and the search hits alike (`filesSide.ts`)
  const treeRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = treeRef.current
    // a search hit's clipped part is its dimmed directory (`.ft-rel`), so both are candidates
    return el ? installSlideOnHover(el, '.ft-node, .ft-result', '.ft-name, .ft-rel') : undefined
  }, [])
  const searchInputRef = useRef<HTMLInputElement>(null)
  const loadedRef = useRef<Set<string>>(new Set())
  const genRef = useRef(0)
  const searchGenRef = useRef(0)
  const expandedRef = useRef(expanded)
  expandedRef.current = expanded
  const activeRef = useRef(active)
  activeRef.current = active
  // read inside `loadDir`, which stays dependency-free so every effect that lists a
  // directory keeps its identity across a toggle
  const showIgnoredRef = useRef(showIgnored)
  showIgnoredRef.current = showIgnored

  const home = window.api.home
  const scratchpadDir = session?.scratchpadDir

  // ---- directory listings -------------------------------------------------

  const loadDir = useCallback(async (dir: string): Promise<void> => {
    if (loadedRef.current.has(dir)) return
    loadedRef.current.add(dir)
    const gen = genRef.current
    setLoading((s) => new Set(s).add(dir))
    try {
      const entries = await window.api.fs.listDir(dir, { showIgnored: showIgnoredRef.current })
      if (gen !== genRef.current) return
      setErrors((s) => {
        if (!s.has(dir)) return s
        const n = new Set(s)
        n.delete(dir)
        return n
      })
      setChildren((m) => ({ ...m, [dir]: entries }))
    } catch {
      loadedRef.current.delete(dir)
      if (gen !== genRef.current) return
      setChildren((m) => ({ ...m, [dir]: [] }))
      setErrors((s) => new Set(s).add(dir))
    } finally {
      setLoading((s) => {
        const n = new Set(s)
        n.delete(dir)
        return n
      })
    }
  }, [])

  // (re)seed on a root change: drop the old cache and restore THIS root's persisted
  // expansion. WB-P06's "workspace B is a clean default" is this line — the expansion
  // comes back out of `koloft.ft.expanded:<root>`, keyed by the root and nothing else.
  const firstRoot = useRef(root)
  useEffect(() => {
    if (firstRoot.current === root) {
      firstRoot.current = ''
      return // the lazy useState initializer already seeded the first root
    }
    genRef.current++
    loadedRef.current = new Set()
    setChildren({})
    setErrors(new Set())
    setLoading(new Set())
    setKbdRow(null)
    setScratchOpen(true)
    setExtOpen(true)
    const flag = loadFlag(showIgnoredKey(root))
    showIgnoredRef.current = flag
    setShowIgnored(flag)
    const next = initialExpansion(loadList(expandedKey(root)), root)
    expandedRef.current = next
    setExpanded(next)
  }, [root])

  // Load whatever is expanded but not yet listed. Gated on `active`: this is the call that
  // spawns `git check-ignore`, and FR-51 forbids it behind a collapsed panel. Flipping
  // `active` back on runs it, so nothing is permanently missing.
  useEffect(() => {
    if (!active) return
    for (const d of expanded) void loadDir(d)
  }, [active, expanded, loadDir])

  // Live refresh of the open directories. Deliberately SUBSCRIBE-ONLY: `watchDir` is what
  // creates the main-side watcher, and the panel already calls it for exactly this root
  // and only while it is showing (FR-51). Registering a second, ungated one here would
  // re-list the whole open tree — and with it spawn `git check-ignore` — on every external
  // edit made behind a collapsed panel, which is the traffic WB-K08 counts. Riding the
  // panel's watch instead makes that structural rather than a flag to remember.
  useEffect(() => {
    const off = window.api.fs.onDirChange((changed) => {
      if (changed !== root) return
      setFsTick((x) => x + 1)
    })
    return off
  }, [root])

  /**
   * FR-51 defers this work while Files is off screen; it must not DISCARD it.
   *
   * The panel's watcher is gated on `visible`, not on `active`, so a bump arriving while
   * the panel shows a `web` tab is routine rather than exceptional — and dropping it left
   * every open directory on a stale listing, because coming back re-runs this effect only
   * to have `loadedRef` early-return. So an inactive bump records a DEBT and the debt is
   * paid the moment Files is on screen again.
   *
   * `active` is a dep now, which is what makes "paid on return" happen at all; the ref
   * remains for the reads that must not re-subscribe.
   */
  const owed = useRef(false)
  useEffect(() => {
    if (fsTick === 0) return
    if (!active) {
      owed.current = true
      return
    }
    owed.current = false
    for (const d of expandedRef.current) {
      loadedRef.current.delete(d)
      void loadDir(d)
    }
  }, [fsTick, active, loadDir])

  useEffect(() => {
    if (!active || !owed.current) return
    owed.current = false
    for (const d of expandedRef.current) {
      loadedRef.current.delete(d)
      void loadDir(d)
    }
  }, [active, loadDir])

  // The scratchpad sits outside the root, so the watcher above never covers it. Worse, the
  // dir is created LAZILY by claude, so it usually does not exist when the session binds
  // and a watcher attached then would silently never fire. Re-list it off the session's own
  // activity instead, throttled rather than debounced: a working session ticks faster than
  // the delay, and a debounce would keep rescheduling so nothing written mid-turn appeared
  // until the turn went quiet. The pending timer is tagged with the dir it will re-list, so
  // a still-armed timer from the session we just switched away from neither suppresses this
  // one's arming nor fires against the old dir.
  const scratchTimerRef = useRef<{ dir: string; t: ReturnType<typeof setTimeout> } | null>(null)
  useEffect(() => {
    if (!active || !scratchpadDir) return
    const pending = scratchTimerRef.current
    if (pending?.dir === scratchpadDir) return
    if (pending) clearTimeout(pending.t)
    const t = setTimeout(() => {
      scratchTimerRef.current = null
      loadedRef.current.delete(scratchpadDir)
      void loadDir(scratchpadDir)
      // Deliberately NO `setFsTick` here, unlike the watcher below. This timer re-arms on
      // every session tick, so bumping the tick would re-list every expanded PROJECT
      // directory up to twice a second — one `git check-ignore` per directory per pass —
      // for the sake of a scratchpad subdir. Refreshing those expanded subdirs is the
      // watcher's job precisely because it fires on a real descendant write.
    }, 600)
    scratchTimerRef.current = { dir: scratchpadDir, t }
  }, [active, scratchpadDir, session?.updatedAt, loadDir])
  useEffect(
    () => () => {
      if (scratchTimerRef.current) clearTimeout(scratchTimerRef.current.t)
    },
    []
  )

  // First listing of the scratchpad, plus a watcher of its own — the panel's watch covers
  // the workspace root, and the scratchpad lives outside it. Three deps, each deliberate:
  //  · `scratchpadDir` — obvious.
  //  · `scratchLive` — the FIRST attach happens before claude has created the dir (it does
  //    so lazily), so `fs.watch` throws in main and silently no-ops; re-running once the
  //    dir has been seen non-empty is what actually gets a watcher onto it.
  //  · `root` — the reseed's cache wipe fires on a root change even when the session, and
  //    with it the scratchpad, has not moved.
  // The listing is invalidated FIRST because `loadDir` early-returns on `loadedRef`, and
  // returning to an already-visited session would otherwise serve a listing taken minutes
  // ago. The watcher is recursive and reports the dir it was GIVEN for any descendant
  // write, so it also bumps `fsTick` — that reloads whichever scratchpad SUBdirs the user
  // has expanded, which invalidating `dir` alone would leave stale.
  const scratchLive = !!scratchpadDir && (children[scratchpadDir]?.length ?? 0) > 0
  useEffect(() => {
    const dir = scratchpadDir
    if (!active || !dir) return
    loadedRef.current.delete(dir)
    void loadDir(dir)
    window.api.fs.watchDir(dir)
    const off = window.api.fs.onDirChange((changed) => {
      if (changed !== dir) return
      loadedRef.current.delete(dir)
      void loadDir(dir)
      setFsTick((x) => x + 1)
    })
    return () => {
      off()
      window.api.fs.unwatchDir(dir)
    }
  }, [active, scratchpadDir, scratchLive, root, loadDir])

  // ---- FR-47 decorations --------------------------------------------------

  const idx = useMemo(() => sessionIndex(session, root), [session, root])
  const changedDirs = useMemo(() => changedDirsOf(git, root), [git, root])
  const live = livePath(session)
  const bookmarkSet = useMemo(() => new Set(bookmarks), [bookmarks])

  // ---- FR-46 the two virtual roots ---------------------------------------

  const scratchEntries = useMemo(
    () => scratchpadEntries(scratchpadDir ? children[scratchpadDir] : undefined, scratchpadDir),
    [children, scratchpadDir]
  )
  const scratchListed = useMemo(() => {
    const s = new Set<string>()
    for (const e of scratchEntries) if (!e.isDir) s.add(e.path)
    return s
  }, [scratchEntries])

  // FR-46's "a missing directory hides its whole node" applies to ↗ Outside too, and
  // Outside is a flat LIST rather than one directory — so the question is asked per
  // candidate, of the directory holding it, with `fs.dirExists`: one cheap probe per
  // DISTINCT parent, which for the usual single scratch directory is one call.
  //
  // `listDir` deliberately does NOT answer this. It runs `git check-ignore`, so deriving
  // existence from "is the file still in its parent's listing" would silently drop an
  // external write that its own repo happens to ignore — losing precisely the artifact
  // this node exists to keep reachable — and would pay a full readdir of, say, the user's
  // home directory to do it. (`listDir`'s own conflation of missing/unreadable/empty is
  // what the ⌗ Scratchpad node above relies on, which is why the distinction is asked for
  // separately here rather than pushed down into it.)
  //
  // Only candidates that would otherwise be ON SCREEN are probed: the kind and `tasks/`
  // rules are pure and already exclude the rest, so a subagent transcript directory never
  // earns a probe or a watcher.
  const outsideWatched = useMemo(
    () =>
      outsideFiles({
        candidates: idx.outsideCandidates,
        scratchpadDir,
        scratchListed,
        missingDirs: new Set<string>()
      }).map((f) => f.src),
    [idx.outsideCandidates, scratchpadDir, scratchListed]
  )
  const outsideKey = outsideWatched.join('\n')
  const [missingDirs, setMissingDirs] = useState<ReadonlySet<string>>(new Set())

  useEffect(() => {
    if (!active || !outsideKey) return
    const paths = outsideKey.split('\n')
    const dirs = [...new Set(paths.map((p) => p.slice(0, p.lastIndexOf('/'))))]
    let live = true
    const probe = (): void => {
      void Promise.all(dirs.map((d) => window.api.fs.dirExists(d).catch(() => true))).then(
        (found) => {
          if (!live) return
          const gone = new Set(dirs.filter((_, i) => !found[i]))
          // identity-stable when nothing changed, so this cannot loop the memo below
          setMissingDirs((prev) =>
            prev.size === gone.size && [...gone].every((d) => prev.has(d)) ? prev : gone
          )
        }
      )
    }
    probe()
    // Deletion is the branch that MUST converge, and a recursive directory watcher cannot
    // be relied on to report a directory's own removal. `fs.watchFile` is a stat poll that
    // follows the PATH, so it fires when the file — or the directory holding it — goes:
    // the same mechanism the preview pane's auto-refresh runs on, at the same cadence.
    for (const p of paths) window.api.fs.watchFile(p)
    const off = window.api.fs.onFileChange((p) => {
      if (paths.includes(p)) probe()
    })
    return () => {
      live = false
      off()
      for (const p of paths) window.api.fs.unwatchFile(p)
    }
  }, [active, outsideKey])

  const outside = useMemo(
    () =>
      outsideFiles({
        candidates: idx.outsideCandidates,
        scratchpadDir,
        scratchListed,
        missingDirs
      }),
    [idx.outsideCandidates, scratchpadDir, scratchListed, missingDirs]
  )

  // ---- FR-45 search -------------------------------------------------------

  // Closing the row ends the search: the query goes with it, never left filtering
  // invisibly. Both ways in close the row — the × here and ⌘⇧F's second press — so this
  // one effect covers both.
  //
  // Closing also has to KEEP the focus inside the Files tab (WB-B02), and the element that
  // held it is the input that just unmounted — left alone, focus falls to <body> and the
  // panel silently stops answering its own shortcuts (FR-20/FR-53). The tree body is the
  // natural heir, but it only exists once the cleared query has emptied the results, which
  // is two renders away: hence a request here, honoured by the effect below.
  const wantBodyFocus = useRef(false)
  const wasSearchOpen = useRef(searchOpen)
  useEffect(() => {
    if (!searchOpen) {
      setQuery('')
      if (wasSearchOpen.current) wantBodyFocus.current = true
    }
    wasSearchOpen.current = searchOpen
  }, [searchOpen])

  useEffect(() => {
    if (!wantBodyFocus.current || !bodyRef.current) return
    wantBodyFocus.current = false
    bodyRef.current.focus()
  })

  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus()
  }, [searchOpen, searchFocusNonce])

  useEffect(() => {
    const q = query.trim()
    if (!q) {
      searchGenRef.current++
      setResults(null)
      setContentResults(null)
      setSearching(false)
      setTruncated(false)
      return
    }
    setSearching(true)
    const gen = ++searchGenRef.current
    const mode = searchMode
    const t = setTimeout(async () => {
      try {
        if (mode === 'content') {
          const res = await window.api.fs.searchContent(root, q, { showIgnored })
          if (gen !== searchGenRef.current) return
          setContentResults(res.hits)
          setResults(null)
          setTruncated(res.truncated)
        } else {
          const res = await window.api.fs.search(root, q, { showIgnored })
          if (gen !== searchGenRef.current) return
          setResults(res.hits)
          setContentResults(null)
          setTruncated(res.truncated)
        }
      } catch {
        if (gen !== searchGenRef.current) return
        if (mode === 'content') setContentResults([])
        else setResults([])
        setTruncated(false)
      } finally {
        if (gen === searchGenRef.current) setSearching(false)
      }
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [query, root, searchMode, showIgnored])

  useEffect(() => setSelIdx(0), [results, contentResults])

  const searchActive = results !== null || contentResults !== null

  // ---- expansion ----------------------------------------------------------

  /** The one place expansion changes, so persistence rides the mutation rather than an
   *  effect — an effect would race the root-change reseed and write one root's expansion
   *  into another's slot (WB-P06's cross-talk). */
  const applyExpansion = useCallback(
    (next: Set<string>): void => {
      expandedRef.current = next
      setExpanded(next)
      saveList(expandedKey(root), persistableExpansion(next, root))
    },
    [root]
  )

  const toggleDir = useCallback(
    (dir: string): void => {
      const next = new Set(expandedRef.current)
      if (next.has(dir)) {
        next.delete(dir)
        loadedRef.current.delete(dir)
      } else {
        next.add(dir)
        void loadDir(dir)
      }
      applyExpansion(next)
    },
    [applyExpansion, loadDir]
  )

  /** A-01/A-05 — the switch changes what EVERY listing contains, so every cached one is
   *  dropped and the open directories are listed again. The running search re-runs through
   *  its own `showIgnored` dependency below. */
  const toggleIgnored = useCallback((): void => {
    const next = !showIgnoredRef.current
    showIgnoredRef.current = next
    setShowIgnored(next)
    saveFlag(showIgnoredKey(root), next)
    loadedRef.current = new Set()
    for (const d of expandedRef.current) void loadDir(d)
    if (scratchpadDir) void loadDir(scratchpadDir)
  }, [root, loadDir, scratchpadDir])

  /**
   * B-06 — make the file, then let the listing catch up.
   *
   * Whether the name is free is decided by the creation itself (main opens it `wx`), so
   * there is no check to race with. The answer is a sentence for the box, or null when it
   * worked — the box stays open on a refusal, because it is where the fix is typed.
   */
  const createHere = useCallback(
    async (name: string): Promise<string | null> => {
      const dir = newFileDir
      if (!dir) return null
      try {
        const created = await window.api.edit.create(dir, name)
        loadedRef.current.delete(dir)
        void loadDir(dir)
        onNewFileDone(created)
        return null
      } catch (err) {
        return createRefusal(String((err as Error)?.message ?? ''))
      }
    },
    [newFileDir, loadDir, onNewFileDone]
  )

  // the box lives among the folder's children, so the folder has to be open to hold it
  useEffect(() => {
    if (!newFileDir || expandedRef.current.has(newFileDir)) return
    const next = new Set(expandedRef.current)
    next.add(newFileDir)
    applyExpansion(next)
    void loadDir(newFileDir)
  }, [newFileDir, applyExpansion, loadDir])

  // FR-47's auto-scroll needs a row to scroll TO, so a file opened from anywhere reveals
  // its ancestors first. Keyed on the path alone: a directory the user then collapses by
  // hand stays collapsed until a NEW file is opened, rather than springing back open.
  useEffect(() => {
    if (!activeRef.current || !current || !inRoot(current, root)) return
    const next = new Set(expandedRef.current)
    let grew = false
    for (const d of ancestorDirs(current, root)) {
      if (!next.has(d)) {
        next.add(d)
        grew = true
      }
    }
    if (grew) applyExpansion(next)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current])

  // …then scroll it into view. Deliberately keyed on the path only: the decoration props
  // get a fresh identity every session tick, and re-scrolling on those would fight the
  // user's own scrolling.
  useEffect(() => {
    if (!current) return
    bodyRef.current?.querySelector('.ft-node.active')?.scrollIntoView({ block: 'nearest' })
  }, [current, expanded])

  // Paint the keyboard-focused row. DOM-driven rather than a class in the JSX because the
  // row set spans four renderers (lazy, synthetic, virtual roots, sections) and the paint
  // has to survive rows being inserted or removed above it by ~500ms session ticks — so it
  // re-runs on EVERY render. Scrolling, however, must not: re-running that per tick would
  // fight the user's own scrolling, hence the "only when the focus moved" guard.
  const scrolledRow = useRef<string | null>(null)
  useEffect(() => {
    const rows = Array.from(bodyRef.current?.querySelectorAll<HTMLElement>('.ft-node') ?? [])
    let focused: HTMLElement | undefined
    for (const n of rows) {
      const on = kbdRow !== null && n.dataset.rowId === kbdRow
      n.classList.toggle('kbd-focus', on)
      if (on) focused = n
    }
    if (focused && scrolledRow.current !== kbdRow) focused.scrollIntoView({ block: 'nearest' })
    scrolledRow.current = kbdRow
  })

  const onTreeKey = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    const rows = Array.from(bodyRef.current?.querySelectorAll<HTMLElement>('.ft-node') ?? [])
    if (!rows.length) return
    const cur = kbdRow ? rows.findIndex((n) => n.dataset.rowId === kbdRow) : -1
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setKbdRow(rows[Math.min(cur < 0 ? 0 : cur + 1, rows.length - 1)]?.dataset.rowId ?? null)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setKbdRow(rows[Math.max(cur < 0 ? 0 : cur - 1, 0)]?.dataset.rowId ?? null)
    } else if (e.key === 'Enter') {
      if (cur >= 0) rows[cur].click()
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault()
      const el = cur >= 0 ? rows[cur] : null
      if (el && el.dataset.dir === '1') {
        const open = el.classList.contains('open')
        if ((e.key === 'ArrowRight' && !open) || (e.key === 'ArrowLeft' && open)) el.click()
      }
    }
  }

  // ---- rows ---------------------------------------------------------------

  const fileRow = (
    p: string,
    name: string,
    section: string,
    opts?: { loc?: string; forced?: boolean; ignored?: boolean }
  ): JSX.Element => {
    const g = git[p]
    const isActive = current === p
    const isLive = live === p
    const { added, removed } = deltaFor(p, numstat, idx.wrote.get(p))
    return (
      <div
        key={section + ':' + p}
        className={
          'ft-node ft-file' +
          (isActive ? ' active' : '') +
          (isLive ? ' live' : '') +
          (opts?.forced ? ' bv-forced' : '') +
          (opts?.ignored ? ' ignored' : '')
        }
        data-path={p}
        data-row-id={section + ':' + p}
        data-kind="file"
        {...(opts?.forced ? { 'data-forced': '1' } : {})}
        onClick={() => onOpen(p)}
        /* B-03 — the second half of "from seeing it to changing it in two clicks". The
           first click has already opened it in the reading column, which is what makes the
           double click feel like a promotion rather than a different gesture. */
        onDoubleClick={() => onEdit(p)}
        onContextMenu={(e) => onContextMenu(e, p, false)}
        /* the row is only dimmed, never labelled — the column is 252px and already
           carries an icon, the name, a git letter and a ±count, so the reason goes in
           the tooltip instead of stealing width from the name */
        title={opts?.ignored ? ignoredTitle(name) : p}
      >
        <FileIcon />
        <span className={'ft-name' + (g ? ' git-' + g : '')}>{name}</span>
        {opts?.loc ? <span className="ft-loc">{midTruncate(opts.loc)}</span> : null}
        {bookmarkSet.has(p) && (
          <span className="bv-bm" title="Bookmarked" aria-label="Bookmarked">
            <LuStar size={10} />
          </span>
        )}
        {added || removed ? (
          <span className="ft-delta">
            {added ? <span className="add">+{added}</span> : null}
            {removed ? <span className="del">−{removed}</span> : null}
          </span>
        ) : null}
        {g && (
          <span className={'ft-gbadge git-' + g} title={g}>
            {GIT_LETTER[g]}
          </span>
        )}
        {isLive && <span className="ft-pulse" title="editing now" />}
      </div>
    )
  }

  /** A directory row's one decoration slot: how many files the session wrote under it
   *  (●N) or, failing that, the plain dot that says the directory contains git changes. */
  const dirMark = (p: string): JSX.Element | null => {
    const tc = idx.touchedDirCount.get(p) ?? 0
    if (tc)
      return (
        <span className="ft-dir-agg" title={`${tc} files written here`}>
          ●{tc}
        </span>
      )
    if (changedDirs.has(p))
      return (
        <span className="bv-dot" title="contains changes" aria-label="contains changes">
          ●
        </span>
      )
    return null
  }

  const lazyDir = (p: string, name: string, section: string, ignored?: boolean): JSX.Element => {
    const isOpen = expanded.has(p)
    return (
      <div key={section + ':' + p}>
        <div
          className={
            'ft-node ft-dir' +
            (isOpen ? ' open' : '') +
            (changedDirs.has(p) ? ' has-changes' : '') +
            /* same dimming and tooltip as an ignored file: the switch reveals whole
               directories now, and a folder that opens like any other still has to say
               why it was hidden a moment ago */
            (ignored ? ' ignored' : '')
          }
          data-dir="1"
          data-kind="dir"
          data-path={p}
          data-row-id={section + ':' + p}
          onClick={() => toggleDir(p)}
          onContextMenu={(e) => onContextMenu(e, p, true)}
          title={ignored ? ignoredTitle(name) : p}
        >
          <FolderIcon open={isOpen} />
          <span className="ft-name">{name}</span>
          {dirMark(p)}
        </div>
        {isOpen && <div className="ft-children">{lazyChildren(p, section)}</div>}
      </div>
    )
  }

  const lazyChildren = (dir: string, section: string): JSX.Element => (
    <>
      {dir === newFileDir && (
        <NewFileRow onCreate={createHere} onCancel={() => onNewFileDone(null)} />
      )}
      {lazyEntries(dir, section)}
    </>
  )

  const lazyEntries = (dir: string, section: string): JSX.Element => {
    if (errors.has(dir)) return <div className="ft-hint bv-dir-error">Unable to read folder.</div>
    const entries = children[dir]
    if (!entries)
      return loading.has(dir) ? <div className="ft-hint bv-loading">Loading…</div> : <></>
    const visible = section === 'scratchpad' ? scratchpadEntries(entries, scratchpadDir) : entries
    const hidden = hiddenTouchedUnder(dir, visible, idx.touchedInProject)
    const hiddenNodes = hidden.length ? buildSyn(hidden, dir) : []
    if (visible.length === 0 && hiddenNodes.length === 0)
      return <div className="ft-hint bv-empty-dir">Empty</div>
    return (
      <>
        {visible.map((e) =>
          e.isDir
            ? lazyDir(e.path, e.name, section, e.ignored)
            : fileRow(e.path, e.name, section, e.ignored ? { ignored: true } : undefined)
        )}
        {hiddenNodes.length > 0 && renderSyn(hiddenNodes, section)}
      </>
    )
  }

  /** The force-revealed subtree: always expanded, because it exists only to make writes
   *  the listing hid reachable — a fold would hide them again. */
  const renderSyn = (nodes: SynNode[], section: string): JSX.Element => (
    <>
      {nodes.map((n) =>
        n.isDir ? (
          <div key={section + ':' + n.path}>
            <div
              className={
                'ft-node ft-dir open bv-forced' + (changedDirs.has(n.path) ? ' has-changes' : '')
              }
              data-dir="1"
              data-kind="dir"
              data-path={n.path}
              data-row-id={section + ':' + n.path}
              data-forced="1"
              onContextMenu={(e) => onContextMenu(e, n.path, true)}
              title={n.path}
            >
              <FolderIcon open />
              <span className="ft-name">{n.name}</span>
              {dirMark(n.path)}
            </div>
            <div className="ft-children">{renderSyn(n.children, section)}</div>
          </div>
        ) : (
          fileRow(n.path, n.name, section, { forced: true })
        )
      )}
    </>
  )

  /**
   * A collapsible section head. The class strings are the retiring tree's own, verbatim —
   * `ft-section` for Bookmarks/Recent, `ft-external` (+ `ft-scratchpad`) for the two
   * virtual roots — so the existing e2e selectors and the `.ft-*` rules in `styles.css`
   * keep applying. `.ft-scratchpad` in particular has no CSS at all and exists purely as a
   * query hook, which is exactly why it has to be carried across rather than dropped.
   */
  const sectionHead = (
    id: string,
    section: string,
    cls: string,
    icon: string,
    label: string,
    count: number,
    open: boolean,
    onToggle: () => void,
    extra?: { title?: string; ctx?: boolean }
  ): JSX.Element => (
    <div
      className={'ft-node ft-dir ' + cls + (open ? ' open' : '')}
      data-dir="1"
      data-kind="section"
      data-path={id}
      data-row-id={section + ':head'}
      onClick={onToggle}
      onContextMenu={extra?.ctx ? (e) => onContextMenu(e, id, true) : undefined}
      title={extra?.title ?? label}
    >
      <span className="ft-ext-icon">{icon}</span>
      <span className="ft-name">{label}</span>
      <span className="ft-dir-agg">{count}</span>
    </div>
  )

  const rootOpen = expanded.has(root)

  // ---- render -------------------------------------------------------------

  return (
    <div className="fv-tree bv" ref={treeRef} style={{ width: sideWidth }}>
      {searchOpen && (
        <div className="ft-search open bv-search" data-mode={searchMode}>
          <input
            ref={searchInputRef}
            className="ft-search-input"
            aria-label="Search files"
            placeholder={searchMode === 'content' ? 'Search contents…' : 'Filter files…'}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation()
                onCloseSearch()
                return
              }
              const len = contentResults?.length ?? results?.length ?? 0
              if (len === 0) return
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setSelIdx((i) => Math.min(i + 1, len - 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setSelIdx((i) => Math.max(i - 1, 0))
              } else if (e.key === 'Enter') {
                if (contentResults) {
                  const h = contentResults[selIdx] ?? contentResults[0]
                  if (h) onOpen(h.path, h.line)
                } else if (results) {
                  const h = results[selIdx] ?? results[0]
                  if (h) onOpen(h.path)
                }
              }
            }}
            spellCheck={false}
            autoComplete="off"
          />
          {query && (
            <button
              className="ft-search-clear"
              onClick={() => {
                setQuery('')
                searchInputRef.current?.focus()
              }}
              title="Clear query"
              aria-label="Clear query"
            >
              <LuX size={14} />
            </button>
          )}
          <div className="ft-mode" role="group" aria-label="Search mode">
            <button
              className={'ft-mode-btn' + (searchMode === 'name' ? ' on' : '')}
              data-mode="name"
              aria-pressed={searchMode === 'name'}
              onClick={() => setSearchMode('name')}
              title="Search by file name"
            >
              Name
            </button>
            <button
              className={'ft-mode-btn' + (searchMode === 'content' ? ' on' : '')}
              data-mode="content"
              aria-pressed={searchMode === 'content'}
              onClick={() => setSearchMode('content')}
              title="Search file contents (ripgrep)"
            >
              Text
            </button>
          </div>
          <button
            className="ft-search-close"
            onClick={onCloseSearch}
            title="Close search (Esc)"
            aria-label="Close search"
          >
            ✕
          </button>
        </div>
      )}

      {/* A-01 — sits above BOTH the tree and the results, because the switch decides what
          each of them contains (A-04) and a user staring at ⌘P results is exactly who
          wants to reach for it. */}
      <div className="ft-chips">
        <button
          className={'ft-chip' + (showIgnored ? ' on' : '')}
          data-chip="show-ignored"
          aria-pressed={showIgnored}
          onClick={toggleIgnored}
          title="Show ignored files — everything git ignores, node_modules and .git included"
        >
          Show ignored files
        </button>
      </div>

      {searchActive ? (
        <div className="ft-results bv-results" data-mode={searchMode}>
          {searching ? (
            <div className="ft-hint bv-searching">Searching…</div>
          ) : contentResults !== null ? (
            contentResults.length === 0 ? (
              <div className="ft-hint bv-nomatch">{NO_MATCHES}</div>
            ) : (
              <>
                {contentResults.map((h, i) => (
                  <div
                    key={h.path + ':' + h.line + ':' + i}
                    className={
                      'ft-cresult' +
                      (i === selIdx ? ' sel' : '') +
                      (current === h.path ? ' active' : '')
                    }
                    data-path={h.path}
                    data-line={h.line}
                    onClick={() => onOpen(h.path, h.line)}
                    onContextMenu={(e) => onContextMenu(e, h.path, false)}
                    onMouseEnter={() => setSelIdx(i)}
                    title={`${h.path}:${h.line}`}
                  >
                    <span className="ft-cfile">
                      {basename(h.rel)}
                      <span className="ft-cline">:{h.line}</span>
                    </span>
                    <span className="ft-ctext">{h.text}</span>
                  </div>
                ))}
                {truncated && (
                  <div className="ft-hint bv-truncated">
                    {truncationNotice(contentResults.length)}
                  </div>
                )}
              </>
            )
          ) : results !== null && results.length === 0 ? (
            <div className="ft-hint bv-nomatch">{NO_MATCHES}</div>
          ) : (
            <>
              {(results ?? []).map((h, i) => {
                const dir = hitDir(h.rel)
                return (
                  <div
                    key={h.path}
                    className={
                      'ft-result' +
                      (i === selIdx ? ' sel' : '') +
                      (current === h.path ? ' active' : '') +
                      (h.ignored ? ' ignored' : '')
                    }
                    data-path={h.path}
                    onClick={() => onOpen(h.path)}
                    onContextMenu={(e) => onContextMenu(e, h.path, false)}
                    onMouseEnter={() => setSelIdx(i)}
                    title={h.path}
                  >
                    <FileIcon />
                    <span className="ft-name">{h.name}</span>
                    {dir && <span className="ft-rel">{dir}</span>}
                  </div>
                )
              })}
              {truncated && (
                <div className="ft-hint bv-truncated">
                  {truncationNotice((results ?? []).length)}
                </div>
              )}
            </>
          )}
        </div>
      ) : (
        <div className="file-tree bv-body" ref={bodyRef} tabIndex={0} onKeyDown={onTreeKey}>
          {bookmarks.length > 0 && (
            <div className="bv-sec" data-section="bookmarks">
              {sectionHead(
                SEC_BOOKMARKS,
                'bookmarks',
                'ft-section',
                '📌',
                'Bookmarks',
                bookmarks.length,
                bmOpen,
                () => setBmOpen((o) => !o)
              )}
              {bmOpen && (
                <div className="ft-children">
                  {bookmarks.map((p) =>
                    fileRow(p, basename(p), 'bookmarks', { loc: locFor(p, root, home) })
                  )}
                </div>
              )}
            </div>
          )}

          {recents.length > 0 && (
            <div className="bv-sec" data-section="recents">
              {sectionHead(
                SEC_RECENTS,
                'recents',
                'ft-section',
                '↺',
                'Recent',
                recents.length,
                recentOpen,
                () => setRecentOpen((o) => !o)
              )}
              {recentOpen && (
                <div className="ft-children">
                  {recents.map((p) =>
                    fileRow(p, basename(p), 'recents', { loc: locFor(p, root, home) })
                  )}
                </div>
              )}
            </div>
          )}

          <div className="bv-sec" data-section="tree">
            <div
              className={'ft-node ft-dir ft-root' + (rootOpen ? ' open' : '')}
              data-dir="1"
              data-kind="dir"
              data-path={root}
              data-row-id={'tree:' + root}
              onClick={() => toggleDir(root)}
              onContextMenu={(e) => onContextMenu(e, root, true)}
              title={root}
            >
              <FolderIcon open={rootOpen} />
              <span className="ft-name">{basename(root)}</span>
              {dirMark(root)}
            </div>
            {rootOpen && <div className="ft-children">{lazyChildren(root, 'tree')}</div>}
          </div>

          {/* FR-46 — ⌗ Scratchpad. Listed straight off disk rather than derived from
              `session.files`: most of what lands there is written by Bash or by a subagent
              and so never shows up as a tracked file event. `listDir` answers [] for a
              missing, unreadable OR empty directory, which makes an empty listing the
              single condition behind "a missing directory hides its whole node". */}
          {scratchpadDir && scratchEntries.length > 0 && (
            <div className="bv-sec" data-section="scratchpad">
              {sectionHead(
                scratchpadDir,
                'scratchpad',
                'ft-external ft-scratchpad',
                '⌗',
                'Scratchpad',
                scratchEntries.length,
                scratchOpen,
                () => setScratchOpen((o) => !o),
                { title: scratchpadDir, ctx: true }
              )}
              {scratchOpen && (
                <div className="ft-children">
                  {scratchEntries.map((e) =>
                    e.isDir
                      ? lazyDir(e.path, e.name, 'scratchpad')
                      : fileRow(e.path, e.name, 'scratchpad')
                  )}
                </div>
              )}
            </div>
          )}

          {/* FR-46 — ↗ Outside: what the session wrote beyond the root, narrowed to A7's
              md/html/image allowlist. A file outside the root that is NOT one of those
              kinds is reachable from no root at all; that is a locked decision, not a gap. */}
          {outside.length > 0 && (
            <div className="bv-sec" data-section="outside">
              {sectionHead(
                SEC_OUTSIDE,
                'outside',
                'ft-external',
                '↗',
                'Outside',
                outside.length,
                extOpen,
                () => setExtOpen((o) => !o),
                { title: 'Files written outside the project this session' }
              )}
              {extOpen && (
                <div className="ft-children">
                  {outside.map((f) =>
                    fileRow(f.src, f.label || basename(f.src), 'outside', {
                      loc: locFor(f.src, root, home)
                    })
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
