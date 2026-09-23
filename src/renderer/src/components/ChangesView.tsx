import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type MouseEvent as ReactMouseEvent,
  type RefObject
} from 'react'
import type { ArtifactView, GitNumstatMap, GitStatusMap, SessionInfo } from '@shared/types'
import { isWebPagePath } from '@shared/preview'
import { parseUnifiedDiff, type ParsedDiff } from '../inlineDiff'
import { highlightCode, langForPath } from '../highlight'
import { InlineDiff } from './InlineDiff'
import { GIT_LETTER, type ChangeFilters } from './filesModel'
import { installSlideOnHover } from './filesSide'
import {
  CHANGES_MSG,
  HIGHLIGHT_LEAD_IN,
  baseArg,
  buildEntries,
  emptyStreamMessage,
  groupByDir,
  isBigDiff,
  mergeSections,
  nearViewport,
  passesFilters,
  sectionsByPath,
  splitAggregateDiff,
  splitHunks,
  stableEntries,
  totalDelta,
  writtenPaths,
  type ChangeEntry,
  type DiffSection
} from './changesModel'
import '../changesView.css'

/**
 * FR-38…FR-43 · FR-58 — the Changes half of the pinned `files` tab: a left file list and
 * ONE continuous diff stream beside it.
 *
 * The load-bearing property is that it is a stream, not a page swap: clicking a row in the
 * left list scrolls the right column to that file's anchor while every other file's block
 * stays in the DOM (WB-C01 scrolls back up and expects the previous block still rendered).
 * That rules out rendering only the selected file.
 */
export interface ChangesViewProps {
  /** the session's worktree; never null here (FilesBody renders the placeholder) */
  root: string
  /** the resolved baseline — a commit sha, the literal `'HEAD'`, or null when it could
   *  not resolve. Pass it to every git call so NFR-02 holds: the base is resolved ONCE
   *  per refresh by the panel, never re-derived per file (WB-C17 counts the processes).
   *
   *  `undefined` is the panel's THIRD state — "still resolving" — and it is deliberately
   *  not collapsed into null here. The two mean opposite things to git: null is "this repo
   *  has no baseline", which main answers with its staged+unstaged fallback, while
   *  undefined is "nobody has decided yet". The stream waits for it (see the fetch effect)
   *  instead of asking, which is what keeps NFR-02 true on a cold open as well. */
  base: string | null | undefined
  /** the panel's merged status/numstat poll (FR-58). A change here is the in-place
   *  update signal: re-query only the files whose entry actually moved, and key the
   *  blocks by path so React keeps the untouched DOM and the scroll position (WB-C09). */
  git: GitStatusMap
  numstat: GitNumstatMap
  /** FR-40's three groups, already ANDed by the caller's contract; `session` ownership
   *  resolves against `session.files` (`access === 'wrote'`) */
  filters: ChangeFilters
  session: SessionInfo | null
  /** ↻ — re-query the whole set and drop every per-file ⤢ expansion (FR-38/FR-58) */
  refreshNonce: number
  /** the left list asked to scroll to this file; the nonce makes a repeat click scroll
   *  again (FR-38) */
  anchor: { rel: string; nonce: number } | null
  /** the Files tab is the active tab and the panel is showing */
  active: boolean
  /** FR-11 — an .html/.htm block's `↗ New tab` opens a `web` tab (a page has no in-panel
   *  rendered form); a ROW click on one anchors the stream like any other row */
  onOpenWeb: (path: string) => void
  /** the left column's width, shared with Browse's tree and dragged in FilesView */
  sideWidth: number
  /** FR-12 — a block's `↗ New tab` splits it into a standalone `file` tab, inheriting
   *  the block's current view and scroll offset */
  onSplit: (path: string, view: ArtifactView, scrollTop: number) => void
  /** FR-48 — the shared row context menu, owned by FilesView */
  onContextMenu: (e: ReactMouseEvent, path: string, isDir: boolean) => void
  /** clicking a row in the left list; FilesView turns it into an `anchor` */
  onScrollRequest: (rel: string) => void
  /** FR-35 — the panel's find bar searches this element */
  streamRef: RefObject<HTMLDivElement | null>
}

/** Every user-visible state string lives in the pure layer (`CHANGES_MSG`), so a spec can
 *  import the text instead of copying it. */
const MSG = CHANGES_MSG

/** Per-file diffs for untracked files are the one thing the aggregate cannot carry (`git
 *  diff` never lists them), so they cost one git call each. The cap keeps a freshly cloned
 *  or generated tree from spawning hundreds; the overflow says so rather than pretending. */
const UNTRACKED_CAP = 60
const FETCH_CHUNK = 8

interface LoadState {
  done: boolean
  failed: boolean
  truncated: boolean
  /** main found no repo around the root (§Edge) */
  notRepo: boolean
  /** how many files the aggregate CARRIED — counted before the status-map join; the fetch
   *  effect says why that order is load-bearing */
  files: number
  /** a fetch is in flight. Distinct from `!done`, which is true only before the FIRST
   *  answer: every later run (a poll that saw the workspace move, the status map landing
   *  after the diff, ↻) re-fetches with `done` already true, and a block whose section the
   *  previous run did not carry would otherwise print "No diff available." for the whole
   *  re-fetch — an answer, where the truth is "not yet". */
  pending: boolean
  /** untracked files' own diffs are still arriving; their blocks say "loading", not
   *  "no diff" */
  backfill: boolean
}

/** the stream before its first answer — also what a root switch resets to */
const IDLE_LOAD: LoadState = {
  done: false,
  failed: false,
  truncated: false,
  notRepo: false,
  files: 0,
  pending: false,
  backfill: false
}

export function ChangesView(props: ChangesViewProps): JSX.Element {
  const {
    root,
    base,
    git,
    numstat,
    filters,
    session,
    refreshNonce,
    anchor,
    active,
    onOpenWeb,
    sideWidth,
    onSplit,
    onContextMenu,
    onScrollRequest,
    streamRef
  } = props

  /** the aggregate `gitDiff` cut per file (FR-58's one query for the whole set) */
  const [agg, setAgg] = useState<Record<string, DiffSection>>({})
  /** what the aggregate cannot carry: untracked files' own diffs */
  const [perFile, setPerFile] = useState<Record<string, DiffSection>>({})
  /** FR-38 — per file, and dropped by the next refresh */
  const [expanded, setExpanded] = useState<Record<string, string>>({})
  /** per path: this file's OWN full-context diff came back truncated (FR-38's ⤢). Separate
   *  from `expanded` so the text stays a plain diff — a marker line inside it would parse
   *  as a diff row. */
  const [expandCut, setExpandCut] = useState<Record<string, boolean>>({})
  /** FR-42's rename, and a big diff behind its Load button — the two blocks a click opens */
  const [opened, setOpened] = useState<Record<string, boolean>>({})
  /** FR-31's reduced header: Diff (default) or Source, per block */
  const [blockView, setBlockView] = useState<Record<string, 'diff' | 'source'>>({})
  /** NFR-01 — a block gains syntax highlighting only once it has been scrolled to */
  const [seen, setSeen] = useState<Record<string, true>>({})
  const [load, setLoad] = useState<LoadState>(IDLE_LOAD)
  /** the user asked the failed state to try again — the ONLY automatic retry there is */
  const [retryNonce, setRetryNonce] = useState(0)
  /** the file the left list last pointed at (Fig 2's `.active` row) */
  const [current, setCurrent] = useState<string | null>(null)

  const streamEl = useRef<HTMLDivElement>(null)
  const seq = useRef(0)
  const perFileRef = useRef(perFile)
  perFileRef.current = perFile
  const expandedRef = useRef(expanded)
  expandedRef.current = expanded
  // read through a ref by `toggleExpand`, whose identity must NOT follow the poll: it is a
  // prop of every memoized block, and a fresh callback per poll would re-render the whole
  // stream — the reflow FR-58 rules out
  const gitRef = useRef(git)
  gitRef.current = git

  const written = useMemo(() => writtenPaths(session), [session])
  const sections = useMemo(() => ({ ...perFile, ...agg }), [perFile, agg])
  const fresh = useMemo(
    () => buildEntries({ git, numstat, root, written, sections }),
    [git, numstat, root, written, sections]
  )
  // FR-58 — a poll re-derives every entry; keeping the untouched ones' identity is what
  // holds the memoized blocks (and the DOM around them) still.
  const kept = useRef<ChangeEntry[]>([])
  const entries = useMemo(() => {
    const next = stableEntries(kept.current, fresh)
    kept.current = next
    return next
  }, [fresh])
  const shown = useMemo(() => entries.filter((e) => passesFilters(e, filters)), [entries, filters])
  const groups = useMemo(() => groupByDir(shown), [shown])
  /** the whole listed set in one line — the ±N the per-file rows never add up anywhere */
  const totals = useMemo(() => totalDelta(shown), [shown])

  // A different worktree is a different change set: nothing about the last one may flash
  // under it. (A baseline CHANGE deliberately does NOT clear — `mergeSections` swaps the
  // sections that actually differ and the stream stays put.)
  //
  // The baseline being DROPPED (`base` back to `undefined`) is the other trigger, and it
  // is not the same event as the root changing: the panel drops it one commit after a
  // root change (React runs a child's effects before its parent's — see `basedRoot`) and,
  // whenever it leaves the screen, because a hidden panel's map is
  // unwatched and a NEW session on the same worktree would otherwise expand onto the
  // previous visit's rows and diffs (the panel's own `visible` effect says why). The
  // stream cannot see `visible`, but it already waits on the baseline for exactly this
  // "a new reading is coming" meaning, so keying the reset on it covers both routes with
  // one rule. A root change therefore resets twice — once on the root, once a commit
  // later on the drop — and both land on an already-empty stream. Only the DROP edge
  // resets: the baseline landing again is the fetch's own cue, not a reason to forget.
  const resetStream = useCallback((): void => {
    setAgg({})
    setPerFile({})
    setBlockView({})
    setSeen({})
    setCurrent(null)
    setLoad(IDLE_LOAD)
  }, [])
  useEffect(() => resetStream(), [root, resetStream])
  useEffect(() => {
    if (base === undefined) resetStream()
  }, [base, resetStream])

  // FR-38 — ↻ (and any change of baseline or root) drops every per-file expansion. Declared
  // BEFORE the fetch effect so the reset lands first: the fetch re-reads `expandedRef` to
  // refresh whatever is still open, and must not resurrect what this just cleared.
  const expandGen = useRef(0)
  useEffect(() => {
    expandGen.current++
    setExpanded({})
    expandedRef.current = {}
    setExpandCut({})
    setOpened({})
  }, [refreshNonce, base, root])

  // FR-58 — one query per refresh for the whole set, and a re-query whenever the panel's
  // merged poll reports the workspace moved. There is no timer here: this component polls
  // nothing on its own, which is what keeps a deleted worktree (WB-C14) from becoming a
  // retry storm — a failed run also latches until the user asks again.
  const trigger = useRef({ refreshNonce, retryNonce, base, root })
  const failed = useRef(false)
  /**
   * NFR-02 — the root this component has seen the panel drop its baseline for.
   *
   * The panel resets `base` to undefined on every root change, but that reset lands one
   * commit LATE down here: React runs a child's effects before its parent's, so the first
   * commit carrying the NEW root still carries the PREVIOUS root's sha. Fetching on it
   * would cut the new worktree against a stranger's commit, and cost an aggregate the real
   * baseline is about to spend again.
   *
   * Initialised to the MOUNTING root, because a Browse → Changes switch remounts this
   * component while the panel's base stays resolved: with a `null` start that switch would
   * wait for a reset that is never coming, and the stream would never fetch at all.
   */
  const basedRoot = useRef(root)
  useEffect(() => {
    // Learned before the `active` gate on purpose: the panel resolves its baseline while
    // it is SHOWING, which includes the window where a `file` tab is on top and this half
    // is inactive. Learning it only when active would leave the flag pointing at the old
    // root for good, and the stream would never fetch again.
    if (base === undefined) basedRoot.current = root
    if (!active) return
    // NFR-02 — WAIT for the baseline rather than ask git for one. This used to arrive as
    // `base ?? null`, which collapsed "still resolving" into "there is none": `baseArg`
    // maps null to `''`, main reads `''` as "resolve it yourself", and so every run before
    // the baseline landed made main derive a merge-base privately and diff the whole change
    // set against it. Measured on a two-file cold open: 3 baseline resolutions and 4
    // aggregates, where the work is 1 and 2 (workbench-nfr01.spec.ts counts the spawns).
    // `load.done` stays false while we wait, so `emptyStreamMessage` keeps saying "Reading
    // the change set…", which is the truth rather than an answer.
    if (base === undefined || basedRoot.current !== root) return
    const t = trigger.current
    // The baseline LANDING (undefined → sha) reads as `manual` here, and that is the right
    // answer rather than an accident: the flag exists only to break the failed-latch below,
    // and a new root's first fetch must never be held shut by the previous root's failure.
    // It cannot double-fetch — this effect runs once per changed dep tuple either way.
    const manual =
      t.refreshNonce !== refreshNonce ||
      t.retryNonce !== retryNonce ||
      t.base !== base ||
      t.root !== root
    trigger.current = { refreshNonce, retryNonce, base, root }
    if (failed.current && !manual) return // §Edge — "stops polling" until the user retries
    if (manual) failed.current = false
    setLoad((l) => (l.pending ? l : { ...l, pending: true }))

    const mine = ++seq.current
    // NFR-02 — the baseline the panel resolved, forwarded as-is. It is never `undefined`
    // here: the guard above waits instead, so main is never asked to re-derive one.
    const arg = baseArg(base)
    let cancelled = false

    void (async () => {
      let res: Awaited<ReturnType<typeof window.api.fs.gitDiff>>
      try {
        res = await window.api.fs.gitDiff(root, arg)
      } catch {
        if (cancelled || mine !== seq.current) return
        failed.current = true
        setLoad((l) => ({ ...l, done: true, failed: true, pending: false, backfill: false }))
        return
      }
      if (cancelled || mine !== seq.current) return
      const { text, truncated, notRepo, toplevel } = res
      const paths = Object.keys(git)
      const secs = splitAggregateDiff(text)
      const map = sectionsByPath(secs, paths, toplevel)
      // Untracked files are absent from every `git diff`, so they cost one call each. A
      // truncated aggregate is NOT backfilled the same way — the whole point of the banner
      // is that the change set is already too big to fetch file by file.
      const wanted = truncated
        ? []
        : paths.filter((p) => git[p] === 'untracked' && !map[p]).slice(0, UNTRACKED_CAP)
      setAgg((prev) => mergeSections(prev, map))
      // `done` is reported even when this run found NOTHING, and it has to be: the panel's
      // status map arrives on its own schedule (its poll resolves the base and THEN runs
      // status, while the wait above wakes this fetch on the base ITSELF — so the diff is
      // normally a step ahead of the map), so an early fetch legitimately sees
      // `Object.keys(git) === []` — and so does a genuinely clean repo, which needs this
      // path to reach WB-C12's empty state. The two are indistinguishable from in here.
      //
      // Which is why `files` counts the sections the aggregate CARRIED (`secs`), not the
      // ones the join kept (`map`). The join is filtered by the status map, so during that
      // window it is empty by construction, and a count taken after it is a function of
      // `git` — the same input the row count is. `emptyStreamMessage`'s "the aggregate
      // found files but the rows are still empty" rung could then never fire (the two
      // could never disagree), and the stream claimed "No changes against the base." over
      // a real change set for the whole window — which is how it first shipped. The
      // pre-join count is also what WB-C11's banner should say: a truncated aggregate
      // "shows the first N files" that came through, whether or not the status map has
      // caught up with them yet.
      //
      // `done` still goes true before the change set is known, and `pending` goes false at
      // the same moment; that is why no stream-wide flag can gate NFR-01's lazy highlight,
      // whatever its timing. The rule that holds is per block (`data-ready`) — see the
      // highlight pass below.
      setLoad({
        done: true,
        failed: false,
        truncated,
        notRepo,
        files: secs.length,
        pending: false,
        backfill: wanted.length > 0
      })

      const acc: Record<string, DiffSection> = {}
      for (const p of wanted) {
        const keep = perFileRef.current[p]
        if (keep) acc[p] = keep // keep the visible text until its refetch lands
      }
      // The third argument is what this map already knows. Without it main re-derives the
      // answer per file — toplevel, a base diff that comes back empty, `ls-files`,
      // `check-ignore` — four spawns to settle a question the status map has settled, before
      // the one `--no-index` diff that actually produces the text. WB-C17 counts processes.
      for (let i = 0; i < wanted.length; i += FETCH_CHUNK) {
        const slice = wanted.slice(i, i + FETCH_CHUNK)
        const got = await Promise.all(
          slice.map((p) =>
            window.api.fs
              .gitFileDiff(p, arg, git[p] === 'untracked')
              .then((r) => [p, r.text, r.truncated] as const)
              .catch(() => [p, '', false] as const)
          )
        )
        if (cancelled || mine !== seq.current) return
        for (const [p, diff, cut] of got) {
          const [only] = splitAggregateDiff(diff)
          // §Edge — a per-file overflow is as much a "never present a partial diff as
          // complete" case as the aggregate's, and only this call knows about it
          if (only) acc[p] = cut ? { ...only, truncated: true } : only
        }
        setPerFile((prev) => mergeSections(prev, { ...acc }))
      }
      if (!wanted.length) setPerFile((prev) => mergeSections(prev, {}))
      else setLoad((l) => (l.backfill ? { ...l, backfill: false } : l))

      // an open ⤢ survives a poll (only ↻ drops it, FR-38), so its full-context text has to
      // follow the file the same way the compact one does
      const open = Object.keys(expandedRef.current)
      if (open.length) {
        const got = await Promise.all(
          open.map((p) =>
            window.api.fs
              .gitFileDiffFull(p, arg, git[p] === 'untracked')
              .then((r) => [p, r.text, r.truncated] as const)
              .catch(() => null)
          )
        )
        if (cancelled || mine !== seq.current) return
        setExpanded((prev) => {
          const next = { ...prev }
          for (const hit of got) if (hit && next[hit[0]] !== undefined) next[hit[0]] = hit[1]
          return next
        })
        setExpandCut((prev) => {
          const next = { ...prev }
          for (const hit of got) if (hit) next[hit[0]] = hit[2]
          return next
        })
      }
    })()

    return () => {
      cancelled = true
    }
  }, [active, root, base, refreshNonce, retryNonce, git, numstat])

  /**
   * NFR-01 — the lazy-highlight trigger, and the one place where "is this block on screen"
   * is decided.
   *
   * The decision is made PER BLOCK, from the DOM, and only about a block that is already
   * showing its diff. Two earlier attempts got this wrong by asking a stream-wide question
   * instead, and both failed the same way — every block latched at once, measured at six
   * blocks × 1800 rows all carrying their spans (WB-C16):
   *
   *  · observing at mount answers about a stub. A block with no diff yet is a one-line
   *    note, so the whole change set fits one viewport and every block "is visible".
   *  · gating on a stream-wide "the load finished" flag does not fix it, because that flag
   *    goes true too early to mean anything: the first fetch runs before the panel's status
   *    map lands, finds `Object.keys(git)` empty, and still reports done (the `setLoad`
   *    after the aggregate lands) — it cannot do otherwise, since a clean repo is empty for
   *    the same reason and WB-C12 needs its empty state. The six blocks then mount into an
   *    already-"settled" stream as stubs, and their first intersection records are
   *    believed. Re-measuring live does not save it: at that instant the stubs really are
   *    ~70px. `load.pending` (the in-flight flag behind a block's "Loading…" during a
   *    re-fetch) is stream-wide for the same reason, and no better a gate.
   *
   * The invariant that does hold is local: a block whose ROWS are in the DOM has an honest
   * height, and one without them has nothing to highlight anyway. `data-ready` is stamped by
   * the block itself in the same commit that renders its rows, so it cannot disagree with
   * the DOM the way a ref or a state flag can — which is the whole lesson of the two misses.
   * Blocks are re-measured whenever the stream's content changes, because a block that grew
   * from a stub into 1800 rows never crosses an intersection threshold and so is never
   * re-reported by the observer on its own.
   *
   * Once truly seen a block stays highlighted: WB-C01 scrolls back up and expects the
   * earlier diff intact, and re-tokenizing on every scroll-back would be visible.
   */
  const obs = useRef<IntersectionObserver | null>(null)
  const watched = useRef(new Set<HTMLElement>())

  const markVisible = useCallback((els: Iterable<HTMLElement>): void => {
    const stream = streamEl.current
    if (!stream) return
    const view = stream.getBoundingClientRect()
    // A surface with no height has not been laid out (a hidden panel, a commit not yet
    // painted): every rect collapses to zero, every block "overlaps" every other, and the
    // answer would be "all of them". No measurement is better than a degenerate one.
    if (view.height === 0) return
    const hit: string[] = []
    for (const el of els) {
      const p = el.dataset.abs
      if (!p || el.dataset.ready !== '1') continue // a stub cannot be measured, and has
      const box = el.getBoundingClientRect() //      nothing to highlight either way
      if (box.height > 0 && nearViewport(box, view)) hit.push(p)
    }
    if (!hit.length) return
    setSeen((prev) => {
      const next = { ...prev }
      let added = false
      for (const p of hit) {
        if (!next[p]) {
          next[p] = true
          added = true
        }
      }
      // every scroll tick lands here; a fresh object each time would re-render the stream
      return added ? next : prev
    })
  }, [])

  /** The observer, once there is a stream to measure against. It cannot be built inside
   *  `observe`: a block registers from ITS layout effect, and React attaches a parent's ref
   *  only after every child's layout effect has run — so `streamEl.current` is still null
   *  then, and the observer would silently take the window as its root. */
  const ensureObs = useCallback((): IntersectionObserver | null => {
    if (obs.current) return obs.current
    const stream = streamEl.current
    if (!stream) return null
    obs.current = new IntersectionObserver(
      // a record is only a nudge — `markVisible` re-measures, because a record can carry
      // geometry from before the diff landed
      (records) => markVisible(records.map((r) => r.target as HTMLElement)),
      { root: stream, rootMargin: `${HIGHLIGHT_LEAD_IN}px 0px` }
    )
    return obs.current
  }, [markVisible])

  const observe = useCallback(
    (el: HTMLElement): (() => void) => {
      watched.current.add(el)
      ensureObs()?.observe(el) // null on the very first mount — the effect below adopts it
      return () => {
        watched.current.delete(el)
        obs.current?.unobserve(el)
      }
    },
    [ensureObs]
  )

  // Builds the observer on the first commit that has a stream, adopts every block that
  // registered before it existed, and re-decides visibility whenever the stream's CONTENT
  // moves — a stub growing into 1800 rows crosses no intersection threshold, so the
  // observer would never re-report it, and the block that pushed the others down is exactly
  // the one whose arrival changes every answer. `useLayoutEffect` so the measurement runs
  // after the mutation phase put this commit's rows in the DOM and before paint; a passive
  // effect would race the first frame. `observe()` on an already-observed target is a no-op.
  useLayoutEffect(() => {
    const o = ensureObs()
    if (o) for (const el of watched.current) o.observe(el)
    markVisible(watched.current)
  }, [sections, shown, ensureObs, markVisible])

  useEffect(
    () => () => {
      obs.current?.disconnect()
      obs.current = null
      watched.current.clear()
    },
    []
  )

  // FR-38 — the left list's click scrolls the stream to that file's anchor. `offsetTop`
  // against the stream (which is the offset parent) rather than `scrollIntoView`, which
  // would also scroll the panel and the window. Retried across renders until the block
  // exists, so a click that lands before the diff arrives still gets there.
  const anchored = useRef(0)
  useEffect(() => {
    const stream = streamEl.current
    if (!anchor || !stream || anchor.nonce === anchored.current) return
    const el = stream.querySelector<HTMLElement>(`.cv-blk[data-path="${CSS.escape(anchor.rel)}"]`)
    if (!el) return
    anchored.current = anchor.nonce
    setCurrent(anchor.rel)
    stream.scrollTop = el.offsetTop
  }, [anchor, groups])

  const toggleExpand = useCallback(
    (path: string): void => {
      if (expandedRef.current[path] !== undefined) {
        setExpanded((prev) => {
          const next = { ...prev }
          delete next[path]
          return next
        })
        // The truncation note belongs to the full-context text that just left the screen.
        // Left standing over the compact diff it would claim a cut that diff never had —
        // §Edge from the other direction: a complete diff presented as partial.
        setExpandCut((prev) => {
          if (!prev[path]) return prev
          const next = { ...prev }
          delete next[path]
          return next
        })
        return
      }
      // FR-38 — the SAME base the compact diff used; expanding while Changes sits on
      // "vs HEAD" must widen that diff, not silently re-derive the merge-base.
      //
      // The generation guard is not decoration: ↻ and a base switch both CLEAR `expanded`
      // (the reset effect above), and without it a late promise writes the path straight
      // back in — resurrecting an expansion ↻ is required to drop, with full-context text
      // computed against the baseline that was just abandoned.
      const gen = expandGen.current
      void window.api.fs
        .gitFileDiffFull(path, baseArg(base), gitRef.current[path] === 'untracked')
        .then((r) => {
          if (gen !== expandGen.current) return
          setExpanded((prev) => ({ ...prev, [path]: r.text }))
          setExpandCut((prev) => ({ ...prev, [path]: r.truncated }))
        })
        .catch(() => {
          if (gen !== expandGen.current) return
          setExpanded((prev) => ({ ...prev, [path]: '' }))
        })
    },
    [base]
  )

  const toggleOpen = useCallback((path: string): void => {
    setOpened((prev) => ({ ...prev, [path]: !prev[path] }))
  }, [])

  const setView = useCallback((path: string, v: 'diff' | 'source'): void => {
    setBlockView((prev) => ({ ...prev, [path]: v }))
  }, [])

  /**
   * FR-12 — ↗ New tab. The view handed over is NOT the block's literal one: FR-31 makes the
   * stream diff-only precisely so the typeset form is one click away, and WB-C02 asserts the
   * split markdown tab lands on Rendered. So a block in its default Diff view asks for
   * `render` and lets FR-30 decide (code has no Rendered view and falls back to Diff);
   * a block the reader switched to Source hands Source on, which is a real inheritance.
   * An html file has no in-panel rendered form at all — FR-11 sends it to a `web` tab.
   */
  const split = useCallback(
    (path: string, view: 'diff' | 'source', offset: number): void => {
      if (isWebPagePath(path)) {
        onOpenWeb(path)
        return
      }
      onSplit(path, view === 'source' ? 'source' : 'render', offset)
    },
    [onOpenWeb, onSplit]
  )

  /**
   * FR-10 — a row click is spent on the anchor scroll and creates no tab. That holds for an
   * .html/.htm row too: in Changes the reader came for the DIFF, and the page form is one
   * click away on the block's `↗ New tab` (`split`, which is where FR-11's web routing
   * lives for this half). Until an html row click opened the web tab instead of
   * scrolling, which read as "the panel took me somewhere I did not ask to go" — a diff
   * list whose rows do two different things depending on the file's extension.
   */
  const clickRow = useCallback(
    (e: ChangeEntry): void => {
      setCurrent(e.rel)
      onScrollRequest(e.rel)
    },
    [onScrollRequest]
  )

  // hover-slide for the left list's clipped names and directory headers (`filesSide.ts`)
  const listEl = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = listEl.current
    if (!el) return
    const off = installSlideOnHover(el, '.cv-row', '.ft-name')
    const offGrp = installSlideOnHover(el, '.cv-grp', '.cv-grp')
    return () => {
      off()
      offGrp()
    }
  }, [])

  const splitBlock = useCallback(
    (path: string, view: 'diff' | 'source', el: HTMLElement | null): void => {
      const stream = streamEl.current
      const offset = stream && el ? Math.max(0, stream.scrollTop - el.offsetTop) : 0
      split(path, view, offset)
    },
    [split]
  )

  const banner = load.failed ? (
    <div className="cv-banner cv-banner-err" role="status">
      <span>{MSG.gitFailed}</span>
      <button className="cv-retry" onClick={() => setRetryNonce((n) => n + 1)}>
        Retry
      </button>
    </div>
  ) : load.truncated ? (
    // §Edge — a truncated result is never presented as complete; what came through below
    // this banner stays readable (WB-C11)
    <div className="cv-banner" role="status">
      {MSG.truncated(load.files)}
    </div>
  ) : null

  // Never claim "no changes" while any half of the answer is still on its way — the
  // ladder (and why each rung exists) lives with `emptyStreamMessage`.
  const emptyMsg = emptyStreamMessage({ entryCount: entries.length, load })

  return (
    <div className="fv-changes" ref={streamRef}>
      <div className="cv-side" style={{ flexBasis: sideWidth }}>
        {/* The set added up, above the rows it adds up — a header of the column, outside
            the scroller. It follows the LIST (the filtered set), not the pinned tab's
            badge, which counts every changed file on purpose — hence its own file count
            beside the sum. */}
        {shown.length > 0 && (
          <div
            className="cv-total"
            title={MSG.totals(totals)}
            data-partial={totals.noCount > 0 ? '1' : undefined}
          >
            {/* The ±N leaves new and binary files out (FR-43), so a set of brand-new
                files totals `+0 −0` — a number that reads as "nothing changed". The
                caveat is therefore IN THE ROW, not only in the hover text: a tooltip
                is not read by someone who has no reason to suspect the number. */}
            <span className="cv-total-n">
              {totals.files} {totals.files === 1 ? 'file' : 'files'}
              {totals.noCount > 0 && ` · ${totals.noCount} not counted`}
            </span>
            <span className="ft-delta">
              <span className="add">+{totals.added}</span>
              <span className="del">−{totals.removed}</span>
            </span>
          </div>
        )}
        <div className="cv-list" ref={listEl}>
          {/* one group per directory, so `dir` is a unique key (`groupByDir` guarantees it) */}
          {groups.map((g) => (
            <Fragment key={g.dir}>
              <div className="cv-grp">{g.label}</div>
              {g.entries.map((e) => (
                <div
                  key={e.path}
                  className={'ft-node cv-row' + (current === e.rel ? ' active' : '')}
                  data-path={e.rel}
                  data-status={e.status}
                  title={e.rel}
                  onClick={() => clickRow(e)}
                  onContextMenu={(ev) => onContextMenu(ev, e.path, false)}
                >
                  <span className="ft-name">{e.name}</span>
                  {e.delta && (e.delta.added > 0 || e.delta.removed > 0) && (
                    <span className="ft-delta">
                      {e.delta.added > 0 && <span className="add">+{e.delta.added}</span>}
                      {e.delta.removed > 0 && <span className="del">−{e.delta.removed}</span>}
                    </span>
                  )}
                  <span className={'ft-gbadge git-' + e.status} title={e.status}>
                    {GIT_LETTER[e.status]}
                  </span>
                </div>
              ))}
            </Fragment>
          ))}
        </div>
      </div>
      <div className="cv-stream" ref={streamEl}>
        {banner}
        {shown.length === 0
          ? !load.failed && (
              <div className="fv-empty cv-empty">
                <p>{emptyMsg}</p>
              </div>
            )
          : shown.map((e) => (
              <ChangeBlock
                key={e.path}
                entry={e}
                section={sections[e.path]}
                expanded={expanded[e.path]}
                opened={!!opened[e.path]}
                view={blockView[e.path] ?? 'diff'}
                // ↻ must reach a Source view (FR-31's segment reads the file, and nothing
                // else re-reads it for a block with no section to follow), but handed to
                // EVERY block the nonce would re-render the whole stream on ↻ — so only a
                // block showing Source gets the live value; the rest see a constant and
                // keep their memo.
                sourceNonce={blockView[e.path] === 'source' ? refreshNonce : 0}
                seen={!!seen[e.path]}
                truncated={load.truncated}
                cut={!!sections[e.path]?.truncated || !!expandCut[e.path]}
                // A block with no section is "loading" while ANY fetch that could bring one
                // is in flight: the first (`!done`), a re-fetch (`pending` — the status map
                // landing after the diff is the everyday case, and it re-runs this fetch
                // with `done` already true), or the untracked backfill. None of these touch
                // `data-ready`: NFR-01 is decided per block from the DOM, never from here.
                loading={
                  !load.done ||
                  (!sections[e.path] &&
                    (load.pending || (load.backfill && e.status === 'untracked')))
                }
                observe={observe}
                onToggleExpand={toggleExpand}
                onToggleOpen={toggleOpen}
                onSetView={setView}
                onSplit={splitBlock}
                onContextMenu={onContextMenu}
              />
            ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------

interface BlockProps {
  entry: ChangeEntry
  section: DiffSection | undefined
  expanded: string | undefined
  opened: boolean
  view: 'diff' | 'source'
  /** ↻, as seen by a block in its Source view — a constant for every other block, so the
   *  memo below survives the click (see the stream where it is passed) */
  sourceNonce: number
  seen: boolean
  truncated: boolean
  /** THIS file's own diff was cut off by main's buffer (a per-file fetch or a ⤢), as
   *  opposed to `truncated`, which is the whole change set's */
  cut: boolean
  /** this file's diff has not arrived yet — distinct from "there is none" */
  loading: boolean
  observe: (el: HTMLElement) => () => void
  onToggleExpand: (path: string) => void
  onToggleOpen: (path: string) => void
  onSetView: (path: string, v: 'diff' | 'source') => void
  onSplit: (path: string, view: 'diff' | 'source', el: HTMLElement | null) => void
  onContextMenu: (e: ReactMouseEvent, path: string, isDir: boolean) => void
}

/**
 * One file in the stream. Memoized on purpose: FR-58's in-place update means a poll that
 * touched one file must re-render THAT block only — `mergeSections` keeps every other
 * section object identical, so this comparison is what leaves the surrounding DOM (and the
 * scroll position, WB-C09) alone.
 */
const ChangeBlock = memo(function ChangeBlock({
  entry,
  section,
  expanded,
  opened,
  view,
  sourceNonce,
  seen,
  truncated,
  cut,
  loading,
  observe,
  onToggleExpand,
  onToggleOpen,
  onSetView,
  onSplit,
  onContextMenu
}: BlockProps): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  // registration is a LAYOUT effect so it beats the stream's settle sweep, which is one
  // too: child layout effects run before the parent's, while a passive effect here would
  // land after it and leave the first screenful unhighlighted whenever a block mounts in
  // the same commit that settles the stream (NFR-01).
  useLayoutEffect(() => {
    const el = ref.current
    return el ? observe(el) : undefined
  }, [observe])

  const isExpanded = expanded !== undefined
  const diffText = isExpanded ? expanded : (section?.text ?? '')
  const special = entry.kind !== 'text'
  // a summary-row state (binary / deleted / conflict) never shows rows, so it never pays
  // for the parse either
  const parsable = !special || entry.kind === 'renamed'
  // the fold's saving is the rows and their tokens, not the parse; ⤢ counts as asking
  const folded = parsable && !opened && !isExpanded && isBigDiff(diffText)
  const hunks = useMemo(
    () => (parsable && !folded ? splitHunks(diffText) : []),
    [parsable, folded, diffText]
  )

  const body = ((): JSX.Element => {
    if (view === 'source') {
      return (
        <BlockSource path={entry.path} seen={seen} version={section?.text} nonce={sourceNonce} />
      )
    }
    // FR-41 — the four special states are ONE summary row; FR-42 — only a rename opens,
    // into the paired diff the aggregate already carries (never add + delete).
    if (special) {
      const summary =
        entry.kind === 'renamed'
          ? MSG.renamed(section?.renameFrom ?? null)
          : entry.kind === 'binary'
            ? MSG.binary
            : entry.kind === 'deleted'
              ? MSG.deleted
              : MSG.conflict
      if (entry.kind !== 'renamed') return <div className="cv-special">{summary}</div>
      return (
        <>
          <button
            className="cv-special cv-rename"
            aria-expanded={opened}
            onClick={() => onToggleOpen(entry.path)}
          >
            {summary}
          </button>
          {opened && (
            <Hunks
              hunks={hunks}
              entry={entry}
              seen={seen}
              expanded={isExpanded}
              onToggleExpand={onToggleExpand}
            />
          )}
        </>
      )
    }
    if (folded) {
      return (
        <button className="cv-special cv-bigdiff" onClick={() => onToggleOpen(entry.path)}>
          {MSG.bigDiff}
        </button>
      )
    }
    if (hunks.length === 0) {
      if (loading) return <div className="cv-note">Loading…</div>
      if (section) return <div className="cv-note">{MSG.noText}</div>
      return <div className="cv-note">{truncated ? MSG.cutOff : MSG.noDiff}</div>
    }
    return (
      <Hunks
        hunks={hunks}
        entry={entry}
        seen={seen}
        expanded={isExpanded}
        onToggleExpand={onToggleExpand}
      />
    )
  })()

  /**
   * NFR-01 — "this block's height is its own, not a stub's". Stamped here rather than
   * tracked in the stream's state because it is rendered in the SAME commit as the content
   * it describes, so it cannot fall out of step with the DOM the highlight pass measures.
   *
   * Structural, never a pixel threshold: rows, or an FR-41 summary row, or the Source view
   * — all three are a block showing its own final height. A block still printing `Loading…`
   * or `No diff available.` is not, and is the one this exists to exclude. The summary
   * states count even though they have nothing to highlight, so that "every block is
   * `data-ready`" is a barrier a spec can wait on without a deleted file hanging it.
   */
  const ready = view === 'source' || special || folded || hunks.length > 0

  return (
    <div
      className="cv-blk"
      ref={ref}
      data-path={entry.rel}
      data-abs={entry.path}
      data-kind={entry.kind}
      data-status={entry.status}
      data-ready={ready ? '1' : undefined}
      onContextMenu={(e) => onContextMenu(e, entry.path, false)}
    >
      {/* FR-31's reduced header: path + status + ±N + [ Diff | Source | ↗ New tab ]. No
          Rendered segment — the stream never renders (WB-C02). */}
      <div className="cv-blk-hd">
        {/* the path is also the door to Reveal in Finder / Copy path: a left click opens
            the same menu the right click does, because a right-click is not something a
            reader goes looking for */}
        <span
          className="path"
          title={`${entry.rel} — click for Reveal in Finder / Copy path`}
          onClick={(e) => onContextMenu(e, entry.path, false)}
        >
          {entry.dir && <span className="dir">{entry.dir}</span>}
          {entry.name}
        </span>
        <span className={'ft-gbadge git-' + entry.status} title={entry.status}>
          {GIT_LETTER[entry.status]}
        </span>
        {entry.delta && (entry.delta.added > 0 || entry.delta.removed > 0) && (
          <span className="ft-delta">
            {entry.delta.added > 0 && <span className="add">+{entry.delta.added}</span>}
            {entry.delta.removed > 0 && <span className="del">−{entry.delta.removed}</span>}
          </span>
        )}
        <span className="cv-gap" />
        <div className="seg" role="group" aria-label="Block view">
          <button
            className={view === 'diff' ? 'on' : undefined}
            aria-pressed={view === 'diff'}
            onClick={() => onSetView(entry.path, 'diff')}
          >
            Diff
          </button>
          <button
            className={view === 'source' ? 'on' : undefined}
            aria-pressed={view === 'source'}
            onClick={() => onSetView(entry.path, 'source')}
          >
            Source
          </button>
          <button className="cv-split" onClick={() => onSplit(entry.path, view, ref.current)}>
            ↗ New tab
          </button>
        </div>
      </div>
      {body}
      {/* §Edge — the rows above are what fitted, not what exists. Said out loud, because a
          partial diff that looks complete is the failure the banner exists to prevent, and
          it is as real one file at a time as it is for the whole set. */}
      {cut && <div className="cv-note">{MSG.fileCutOff}</div>}
    </div>
  )
})

/** A file's hunks. The ⤢ rides the FIRST hunk header (Fig 2) and acts on the whole file:
 *  FR-38's expansion is per FILE, and full context collapses the file to one hunk anyway. */
function Hunks({
  hunks,
  entry,
  seen,
  expanded,
  onToggleExpand
}: {
  hunks: { header: string; text: string }[]
  entry: ChangeEntry
  seen: boolean
  expanded: boolean
  onToggleExpand: (path: string) => void
}): JSX.Element {
  return (
    <>
      {hunks.map((h, i) => (
        <Fragment key={i}>
          <div className="cv-hunk">
            <span className="cv-hunk-hd">{h.header}</span>
            {i === 0 && (
              <button
                className="cv-exp"
                aria-pressed={expanded}
                title={expanded ? 'Back to the default context' : 'Expand context'}
                onClick={() => onToggleExpand(entry.path)}
              >
                {expanded ? '⤡ default context' : '⤢ expand context'}
              </button>
            )}
          </div>
          <DiffRows text={h.text} path={entry.path} seen={seen} />
        </Fragment>
      ))}
    </>
  )
}

/**
 * NFR-01's whole mechanism. The rows are ALWAYS in the DOM (one exception: a block folded
 * behind Load diff has none) — WB-C01 scrolls back to a block it passed and expects its
 * diff, and ⌘F must find text that was never on screen — but the
 * syntax-highlighted form (`InlineDiff`, which tokenizes on mount) is swapped in only once
 * the block has been scrolled to. The plain form deliberately mirrors `InlineDiff`'s markup
 * row for row, so the swap changes colors and nothing else: same nodes, same height, no
 * reflow of the stream around it.
 */
function DiffRows({
  text,
  path,
  seen
}: {
  text: string
  path: string
  seen: boolean
}): JSX.Element {
  const parsed = useMemo(() => parseUnifiedDiff(text), [text])
  if (seen) return <InlineDiff src={path} parsed={parsed} />
  return <PlainRows parsed={parsed} />
}

/** `InlineDiff`'s pre-highlight rendering, and nothing else. The 5000-row cap matches its
 *  own so the swap cannot change the block's height. */
const MAX_PLAIN_ROWS = 5000

function PlainRows({ parsed }: { parsed: ParsedDiff }): JSX.Element {
  const rows = parsed.rows
  const truncated = rows.length > MAX_PLAIN_ROWS
  const shown = truncated ? rows.slice(0, MAX_PLAIN_ROWS) : rows
  return (
    <div className="idiff">
      {shown.map((r, i) => (
        <div key={i} className={'idiff-row idiff-' + r.kind} data-newno={r.newNo ?? undefined}>
          <span className="idiff-num">{r.oldNo ?? ''}</span>
          <span className="idiff-num">{r.newNo ?? ''}</span>
          <span className="idiff-sign">
            {r.kind === 'add' ? '+' : r.kind === 'del' ? '−' : ' '}
          </span>
          <span className="idiff-code">{r.text || ' '}</span>
        </div>
      ))}
      {truncated && (
        <div className="idiff-hint">
          Diff truncated — showing first {MAX_PLAIN_ROWS} of {rows.length} lines.
        </div>
      )}
    </div>
  )
}

/**
 * FR-31's Source segment inside a stream block: the file as it is now, no diff and no
 * rendering. It reads on its own rather than through `ArtifactPane`, because a block is not
 * an artifact surface — it has no view ladder, no outline and no reload of its own — and
 * mounting a pane per file would defeat NFR-01's lazy pass. Highlighting waits for the same
 * `seen` gate the diff rows use.
 */
function BlockSource({
  path,
  seen,
  version,
  nonce
}: {
  path: string
  seen: boolean
  /** the block's current section text. The read has no watcher of its own, so this is the
   *  signal that the file moved on disk: without it the Source view showed the FIRST read
   *  for as long as the block lived, while the header's ±N and the Diff beside it followed
   *  the agent's edits poll by poll (FR-58). The text is the key because a section has no
   *  other identity — its text is the whole of it. */
  version: string | undefined
  /** ↻ — for the block that has no section to follow (an untracked file past the fetch
   *  cap, or one cut off by a truncated aggregate) */
  nonce: number
}): JSX.Element {
  const [state, setState] = useState<
    'loading' | 'ok' | 'missing' | 'binary' | 'tooLarge' | 'error'
  >('loading')
  const [text, setText] = useState('')
  const [html, setHtml] = useState('')

  // `version` and `nonce` are re-read triggers, not inputs — the effect reads the file
  // either way. A re-read keeps the text already on screen until the new one lands: a
  // blink to "Loading…" on every poll that touched the file would be the stream's own
  // reflow, in a block whose height WB-C09 expects to hold still.
  useEffect(() => {
    let cancelled = false
    setState((s) => (s === 'ok' ? s : 'loading'))
    window.api.preview
      .readText(path)
      .then((t) => {
        if (cancelled) return
        setText(t)
        setHtml('') // the old colours describe the old text; plain-then-coloured is NFR-01's own swap
        setState('ok')
      })
      .catch((err: unknown) => {
        if (cancelled) return
        const msg = String((err as Error)?.message ?? '')
        if (msg.includes('KOLOFT_READ_FAILED') || msg.includes('KOLOFT_NOT_FILE'))
          setState('missing')
        else if (msg.includes('KOLOFT_TOO_LARGE')) setState('tooLarge')
        else if (msg.includes('KOLOFT_BINARY')) setState('binary')
        else setState('error')
      })
    return () => {
      cancelled = true
    }
  }, [path, version, nonce])

  useEffect(() => {
    if (!seen || !text) return
    let cancelled = false
    highlightCode(text, langForPath(path))
      .then((h) => {
        if (!cancelled) setHtml(h)
      })
      .catch(() => {
        /* highlight failed — the plain text below stays on screen */
      })
    return () => {
      cancelled = true
    }
  }, [seen, text, path])

  const codeHtml = useMemo(() => ({ __html: html }), [html])

  if (state === 'loading') return <div className="cv-note">Loading…</div>
  if (state === 'missing') return <div className="cv-note">This file no longer exists.</div>
  if (state === 'binary') return <div className="cv-note">Binary file — not previewable.</div>
  if (state === 'tooLarge') return <div className="cv-note">File too large to preview.</div>
  if (state === 'error') return <div className="cv-note">Failed to read file.</div>
  // Safe by construction: `html` is Shiki's codeToHtml output, which HTML-escapes every
  // token — file content can never inject markup (same guarantee as ArtifactPane's Source).
  if (html) return <div className="cv-src" dangerouslySetInnerHTML={codeHtml} />
  return (
    <div className="cv-src">
      <pre>{text}</pre>
    </div>
  )
}
