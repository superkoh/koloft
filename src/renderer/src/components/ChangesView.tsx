import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
  type MouseEvent as ReactMouseEvent,
  type RefObject
} from 'react'
import type { ArtifactView, GitNumstatMap, GitStatusMap, SessionInfo } from '@shared/types'
import { opensAsWebTab } from '@shared/browserRoute'
import { parseUnifiedDiff, type ParsedDiff } from '@shared/unifiedDiff'
import { langForPath } from '../highlight'
import { highlightCodeOffThread } from '../offThread'
import { InlineDiff, MAX_INLINE_ROWS } from './InlineDiff'
import { GIT_LETTER, type ChangeFilters } from './filesModel'
import { installSlideOnHover } from './filesSide'
import { keepCaretInSessionTerminal } from '../keys'
import { CommentBox, type CommentTarget } from './CommentBox'
import {
  CHANGES_MSG,
  HIGHLIGHT_LEAD_IN,
  baseArg,
  baseUnresolved,
  blocksPastBudget,
  buildEntries,
  emptyStreamMessage,
  groupByDir,
  hunkPrompt,
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
  type DiffSection,
  type HunkPrompt
} from './changesModel'
import '../changesView.css'
import '../fileTree.css'
import '../inlineDiff.css'

export interface ChangesViewProps {
  root: string
  base: string | null | undefined
  firstReadFailed: boolean
  onReread: () => void
  git: GitStatusMap
  numstat: GitNumstatMap
  filters: ChangeFilters
  session: SessionInfo | null
  refreshNonce: number
  anchor: { rel: string; nonce: number } | null
  active: boolean
  onOpenWeb: (path: string) => void
  sideWidth: number
  onSplit: (path: string, view: ArtifactView, scrollTop: number) => void
  onContextMenu: (e: ReactMouseEvent, path: string, isDir: boolean) => void
  onScrollRequest: (rel: string) => void
  commentTo: CommentTarget
  streamRef: RefObject<HTMLDivElement | null>
}

const MSG = CHANGES_MSG

const UNTRACKED_DIFF_SPAWN_CAP = 60
const FETCH_CHUNK = 8

interface LoadState {
  done: boolean
  failed: boolean
  truncated: boolean
  notRepo: boolean
  files: number
  pending: boolean
  backfill: boolean
}

const IDLE_LOAD: LoadState = {
  done: false,
  failed: false,
  truncated: false,
  notRepo: false,
  files: 0,
  pending: false,
  backfill: false
}

function scrollStreamOnly(stream: HTMLElement, block: HTMLElement): void {
  stream.scrollTop = block.offsetTop
}

export function ChangesView(props: ChangesViewProps): JSX.Element {
  const {
    root,
    base,
    firstReadFailed,
    onReread,
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
    commentTo,
    streamRef
  } = props

  const [agg, setAgg] = useState<Record<string, DiffSection>>({})
  const [perFile, setPerFile] = useState<Record<string, DiffSection>>({})
  const [expanded, setExpanded] = useState<Record<string, string>>({})
  const [expandCut, setExpandCut] = useState<Record<string, boolean>>({})
  const [opened, setOpened] = useState<Record<string, boolean>>({})
  const [blockView, setBlockView] = useState<Record<string, 'diff' | 'source'>>({})
  const [seen, setSeen] = useState<Record<string, true>>({})
  const [load, setLoad] = useState<LoadState>(IDLE_LOAD)
  const [retryNonce, setRetryNonce] = useState(0)
  const [current, setCurrent] = useState<string | null>(null)

  const streamEl = useRef<HTMLDivElement>(null)
  const seq = useRef(0)
  const perFileRef = useRef(perFile)
  perFileRef.current = perFile
  const expandedRef = useRef(expanded)
  expandedRef.current = expanded
  const gitRef = useRef(git)
  gitRef.current = git

  const written = useMemo(() => writtenPaths(session), [session])
  const sections = useMemo(() => ({ ...perFile, ...agg }), [perFile, agg])
  const fresh = useMemo(
    () => buildEntries({ git, numstat, root, written, sections }),
    [git, numstat, root, written, sections]
  )
  const kept = useRef<readonly ChangeEntry[]>([])
  const entries = useMemo(() => {
    const next = stableEntries(kept.current, fresh)
    kept.current = next
    return next
  }, [fresh])
  const shown = useMemo(() => entries.filter((e) => passesFilters(e, filters)), [entries, filters])
  const groups = useMemo(() => groupByDir(shown), [shown])
  const totals = useMemo(() => totalDelta(shown), [shown])

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
    if (baseUnresolved(base)) resetStream()
  }, [base, resetStream])

  const expandResetGen = useRef(0)
  useEffect(() => {
    expandResetGen.current++
    setExpanded({})
    expandedRef.current = {}
    setExpandCut({})
    setOpened({})
  }, [refreshNonce, base, root])

  useEffect(() => {
    if (baseUnresolved(base)) return
    const onlyStillChanged = <T,>(prev: Record<string, T>): Record<string, T> => {
      const gone = Object.keys(prev).filter((p) => !(p in git))
      if (!gone.length) return prev
      const next = { ...prev }
      for (const p of gone) delete next[p]
      return next
    }
    setExpanded(onlyStillChanged)
    setExpandCut(onlyStillChanged)
    setOpened(onlyStillChanged)
    setBlockView(onlyStillChanged)
  }, [git, base])

  const trigger = useRef({ refreshNonce, retryNonce, base, root })
  const failed = useRef(false)
  const rootTheBaselineIsFor = useRef(root)
  useEffect(() => {
    // ADR-0024
    if (baseUnresolved(base)) rootTheBaselineIsFor.current = root
    if (!active) return
    if (baseUnresolved(base) || rootTheBaselineIsFor.current !== root) return
    const t = trigger.current
    const manual =
      t.refreshNonce !== refreshNonce ||
      t.retryNonce !== retryNonce ||
      t.base !== base ||
      t.root !== root
    trigger.current = { refreshNonce, retryNonce, base, root }
    if (failed.current && !manual) return
    if (manual) failed.current = false
    setLoad((l) => (l.pending ? l : { ...l, pending: true }))

    const mine = ++seq.current
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
      const wanted = truncated
        ? []
        : paths.filter((p) => git[p] === 'untracked' && !map[p]).slice(0, UNTRACKED_DIFF_SPAWN_CAP)
      setAgg((prev) => mergeSections(prev, map))
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
        if (keep) acc[p] = keep
      }
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
          if (only) acc[p] = cut ? { ...only, truncated: true } : only
        }
        setPerFile((prev) => mergeSections(prev, { ...acc }))
      }
      if (!wanted.length) setPerFile((prev) => mergeSections(prev, {}))
      else setLoad((l) => (l.backfill ? { ...l, backfill: false } : l))

      const open = Object.keys(expandedRef.current).filter((p) => p in git)
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
          for (const hit of got)
            if (hit && expandedRef.current[hit[0]] !== undefined) next[hit[0]] = hit[2]
          return next
        })
      }
    })()

    return () => {
      cancelled = true
    }
  }, [active, root, base, refreshNonce, retryNonce, git, numstat])

  const obs = useRef<IntersectionObserver | null>(null)
  const watched = useRef(new Map<string, HTMLElement>())

  const markVisible = useCallback((els: Iterable<HTMLElement>): void => {
    const stream = streamEl.current
    if (!stream) return
    const view = stream.getBoundingClientRect()
    const streamNotLaidOut = view.height === 0
    if (streamNotLaidOut) return
    const hit: string[] = []
    for (const el of els) {
      const p = el.dataset.abs
      if (!p || el.dataset.ready !== '1') continue
      const box = el.getBoundingClientRect()
      if (box.height > 0 && nearViewport(box, view)) hit.push(p)
    }
    const blocks = watched.current
    const rowsOf = (p: string): number => Number(blocks.get(p)?.dataset.rows ?? 0)
    const stays = (p: string): boolean => {
      const el = blocks.get(p)
      if (!el) return false
      return (
        nearViewport(el.getBoundingClientRect(), view) ||
        !!document.getSelection()?.containsNode(el, true)
      )
    }
    setSeen((prev) => {
      const next = { ...prev }
      let changed = false
      for (const p of hit) {
        if (next[p]) continue
        next[p] = true
        changed = true
      }
      for (const p of blocksPastBudget(Object.keys(next), rowsOf, stays)) {
        delete next[p]
        changed = true
      }
      return changed ? next : prev
    })
  }, [])

  const ensureObs = useCallback((): IntersectionObserver | null => {
    if (obs.current) return obs.current
    const stream = streamEl.current
    if (!stream) return null
    obs.current = new IntersectionObserver(
      (records) => markVisible(records.map((r) => r.target as HTMLElement)),
      { root: stream, rootMargin: `${HIGHLIGHT_LEAD_IN}px 0px` }
    )
    return obs.current
  }, [markVisible])

  const observe = useCallback(
    (el: HTMLElement): (() => void) => {
      const p = el.dataset.abs ?? ''
      watched.current.set(p, el)
      ensureObs()?.observe(el)
      return () => {
        if (watched.current.get(p) === el) watched.current.delete(p)
        obs.current?.unobserve(el)
      }
    },
    [ensureObs]
  )

  useLayoutEffect(() => {
    const o = ensureObs()
    if (o) for (const el of watched.current.values()) o.observe(el)
    markVisible(watched.current.values())
  }, [sections, shown, ensureObs, markVisible])

  useEffect(
    () => () => {
      obs.current?.disconnect()
      obs.current = null
      watched.current.clear()
    },
    []
  )

  const anchored = useRef(0)
  useEffect(() => {
    const stream = streamEl.current
    if (!anchor || !stream || anchor.nonce === anchored.current) return
    const el = stream.querySelector<HTMLElement>(`.cv-blk[data-path="${CSS.escape(anchor.rel)}"]`)
    if (!el) return
    anchored.current = anchor.nonce
    setCurrent(anchor.rel)
    scrollStreamOnly(stream, el)
  }, [anchor, groups])

  const toggleExpand = useCallback(
    (path: string): void => {
      if (expandedRef.current[path] !== undefined) {
        setExpanded((prev) => {
          const next = { ...prev }
          delete next[path]
          return next
        })
        setExpandCut((prev) => {
          if (!prev[path]) return prev
          const next = { ...prev }
          delete next[path]
          return next
        })
        return
      }
      const gen = expandResetGen.current
      const stillWanted = (): boolean => gen === expandResetGen.current && path in gitRef.current
      void window.api.fs
        .gitFileDiffFull(path, baseArg(base), gitRef.current[path] === 'untracked')
        .then((r) => {
          if (!stillWanted()) return
          setExpanded((prev) => ({ ...prev, [path]: r.text }))
          setExpandCut((prev) => ({ ...prev, [path]: r.truncated }))
        })
        .catch(() => {
          if (!stillWanted()) return
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

  const split = useCallback(
    (path: string, view: 'diff' | 'source', offset: number): void => {
      if (opensAsWebTab(path)) {
        onOpenWeb(path)
        return
      }
      onSplit(path, view === 'source' ? 'source' : 'render', offset)
    },
    [onOpenWeb, onSplit]
  )

  const clickRow = useCallback(
    (e: ChangeEntry): void => {
      setCurrent(e.rel)
      onScrollRequest(e.rel)
    },
    [onScrollRequest]
  )

  const { blocked, put: putInSession } = commentTo

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

  const gitFailed = load.failed || firstReadFailed
  const banner = gitFailed ? (
    <div className="cv-banner cv-banner-err" role="status">
      <span>{MSG.gitFailed}</span>
      <button
        className="cv-retry"
        onClick={() => (load.failed ? setRetryNonce((n) => n + 1) : onReread())}
      >
        Retry
      </button>
    </div>
  ) : load.truncated ? (
    <div className="cv-banner" role="status">
      {MSG.truncated(load.files)}
    </div>
  ) : null

  const emptyMsg = emptyStreamMessage({ entryCount: entries.length, load })

  return (
    <div className="fv-changes" ref={streamRef}>
      <div className="cv-side" style={{ flexBasis: sideWidth }}>
        {shown.length > 0 && (
          <div
            className="cv-total"
            title={MSG.totals(totals)}
            data-partial={totals.noCount > 0 ? '1' : undefined}
          >
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
          ? !gitFailed && (
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
                sourceNonce={blockView[e.path] === 'source' ? refreshNonce : 0}
                seen={!!seen[e.path]}
                truncated={load.truncated}
                cut={!!sections[e.path]?.truncated || !!expandCut[e.path]}
                loading={
                  !load.done ||
                  (!sections[e.path] &&
                    (load.pending || (load.backfill && e.status === 'untracked')))
                }
                observe={observe}
                blocked={blocked}
                onToggleExpand={toggleExpand}
                onToggleOpen={toggleOpen}
                onSetView={setView}
                onSplit={splitBlock}
                onContextMenu={onContextMenu}
                onComment={putInSession}
              />
            ))}
      </div>
    </div>
  )
}

interface BlockProps {
  entry: ChangeEntry
  section: DiffSection | undefined
  expanded: string | undefined
  opened: boolean
  view: 'diff' | 'source'
  sourceNonce: number
  seen: boolean
  truncated: boolean
  cut: boolean
  loading: boolean
  observe: (el: HTMLElement) => () => void
  blocked: string | null
  onToggleExpand: (path: string) => void
  onToggleOpen: (path: string) => void
  onSetView: (path: string, v: 'diff' | 'source') => void
  onSplit: (path: string, view: 'diff' | 'source', el: HTMLElement | null) => void
  onContextMenu: (e: ReactMouseEvent, path: string, isDir: boolean) => void
  onComment: (prompt: HunkPrompt) => void
}

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
  blocked,
  onToggleExpand,
  onToggleOpen,
  onSetView,
  onSplit,
  onContextMenu,
  onComment
}: BlockProps): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    return el ? observe(el) : undefined
  }, [observe])

  const isExpanded = expanded !== undefined
  const diffText = isExpanded ? expanded : (section?.text ?? '')
  const special = entry.kind !== 'text'
  const parsable = !special || entry.kind === 'renamed'
  const folded = parsable && !opened && !isExpanded && isBigDiff(diffText)
  const showsRows = view === 'diff' && (!special || opened)
  const hunks = useMemo(
    () =>
      parsable && !folded && showsRows
        ? splitHunks(diffText).map((h) => ({ ...h, parsed: parseUnifiedDiff(h.text) }))
        : [],
    [parsable, folded, showsRows, diffText]
  )
  const rows = hunks.reduce((n, h) => n + Math.min(h.parsed.rows.length, MAX_INLINE_ROWS), 0)
  const drawnSize = { '--rows': rows, '--hunks': hunks.length } as CSSProperties

  const body = ((): JSX.Element => {
    if (view === 'source') {
      return (
        <BlockSource path={entry.path} seen={seen} version={section?.text} nonce={sourceNonce} />
      )
    }
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
              blocked={blocked}
              onToggleExpand={onToggleExpand}
              onComment={onComment}
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
        blocked={blocked}
        onToggleExpand={onToggleExpand}
        onComment={onComment}
      />
    )
  })()

  const hasFinalHeight = view === 'source' || special || folded || hunks.length > 0

  return (
    <div
      className="cv-blk"
      ref={ref}
      data-path={entry.rel}
      data-abs={entry.path}
      data-kind={entry.kind}
      data-status={entry.status}
      data-ready={hasFinalHeight ? '1' : undefined}
      data-rows={rows}
      style={drawnSize}
      onContextMenu={(e) => onContextMenu(e, entry.path, false)}
    >
      <div className="cv-blk-hd">
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
            onMouseDown={keepCaretInSessionTerminal}
            onClick={() => onSetView(entry.path, 'diff')}
          >
            Diff
          </button>
          <button
            className={view === 'source' ? 'on' : undefined}
            aria-pressed={view === 'source'}
            onMouseDown={keepCaretInSessionTerminal}
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
      {cut && <div className="cv-note">{MSG.fileCutOff}</div>}
    </div>
  )
})

function Hunks({
  hunks,
  entry,
  seen,
  expanded,
  blocked,
  onToggleExpand,
  onComment
}: {
  hunks: { header: string; text: string; parsed: ParsedDiff }[]
  entry: ChangeEntry
  seen: boolean
  expanded: boolean
  blocked: string | null
  onToggleExpand: (path: string) => void
  onComment: (prompt: HunkPrompt) => void
}): JSX.Element {
  const [commentedHunk, setCommentedHunk] = useState<string | null>(null)
  const commenting = hunks.findIndex((h) => h.text === commentedHunk)
  const [note, setNote] = useState('')
  const openComment = (text: string | null): void => {
    setCommentedHunk(text)
    setNote('')
  }
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
            <button
              className="cv-exp cv-cmt"
              aria-pressed={commenting === i}
              disabled={!!blocked}
              title={blocked ?? MSG.comment}
              onClick={() => openComment(commenting === i ? null : h.text)}
            >
              ✎ comment
            </button>
          </div>
          {commenting === i && (
            <CommentBox
              on="hunk"
              blocked={blocked}
              note={note}
              setNote={setNote}
              onClose={() => openComment(null)}
              onPut={() => {
                openComment(null)
                onComment(hunkPrompt(entry.rel, h.text, note))
              }}
            />
          )}
          <DiffRows parsed={h.parsed} path={entry.path} seen={seen} />
        </Fragment>
      ))}
    </>
  )
}

function DiffRows({
  parsed,
  path,
  seen
}: {
  parsed: ParsedDiff
  path: string
  seen: boolean
}): JSX.Element {
  const box = useRef<HTMLDivElement>(null)
  const drawn = useRef<{ parsed: ParsedDiff; height: number } | null>(null)
  useLayoutEffect(() => {
    const el = box.current
    if (seen && el) drawn.current = { parsed, height: el.offsetHeight }
  }, [seen, parsed])
  const drawnHeight = drawn.current?.parsed === parsed ? drawn.current.height : undefined
  return (
    <div ref={box}>
      {seen ? (
        <InlineDiff src={path} parsed={parsed} />
      ) : (
        <UndrawnRows parsed={parsed} height={drawnHeight} />
      )}
    </div>
  )
}

function UndrawnRows({
  parsed,
  height
}: {
  parsed: ParsedDiff
  height: number | undefined
}): JSX.Element {
  const rows = parsed.rows
  const truncated = rows.length > MAX_INLINE_ROWS
  const shown = truncated ? MAX_INLINE_ROWS : rows.length
  const code = useMemo(
    () =>
      rows
        .slice(0, shown)
        .map((r) => r.text || ' ')
        .join(''),
    [rows, shown]
  )
  return (
    <div className="idiff" style={height === undefined ? undefined : { height }}>
      <div className="cv-undrawn" style={{ '--rows': shown } as CSSProperties}>
        {/* PLATFORM§24 */}
        <div className="cv-undrawn-code" hidden>
          {code}
        </div>
      </div>
      {truncated && (
        <div className="idiff-hint">
          Diff truncated — showing first {MAX_INLINE_ROWS} of {rows.length} lines.
        </div>
      )}
    </div>
  )
}

function BlockSource({
  path,
  seen,
  version,
  nonce
}: {
  path: string
  seen: boolean
  version: string | undefined
  nonce: number
}): JSX.Element {
  const [state, setState] = useState<
    'loading' | 'ok' | 'missing' | 'binary' | 'tooLarge' | 'error'
  >('loading')
  const [text, setText] = useState('')
  const [html, setHtml] = useState('')

  useEffect(() => {
    let cancelled = false
    setState((s) => (s === 'ok' ? s : 'loading'))
    window.api.preview
      .readText(path)
      .then((t) => {
        if (cancelled) return
        setText(t)
        setHtml('')
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
    highlightCodeOffThread(text, langForPath(path))
      .then((h) => {
        if (!cancelled) setHtml(h)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [seen, text, path])

  // PLATFORM§25
  const codeHtml = useMemo(() => ({ __html: html }), [html])

  if (state === 'loading') return <div className="cv-note">Loading…</div>
  if (state === 'missing') return <div className="cv-note">This file no longer exists.</div>
  if (state === 'binary') return <div className="cv-note">Binary file — not previewable.</div>
  if (state === 'tooLarge') return <div className="cv-note">File too large to preview.</div>
  if (state === 'error') return <div className="cv-note">Failed to read file.</div>
  if (html) return <div className="cv-src" dangerouslySetInnerHTML={codeHtml} />
  return (
    <div className="cv-src">
      <pre>{text}</pre>
    </div>
  )
}
