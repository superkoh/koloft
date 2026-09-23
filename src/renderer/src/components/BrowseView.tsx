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

export function ignoredTitle(name: string): string {
  return HIDDEN_BY_DEFAULT_NAMES.has(name)
    ? 'Hidden by default — shown because "Show ignored files" is on'
    : 'Ignored by .gitignore'
}

export interface BrowseViewProps {
  root: string
  session: SessionInfo | null
  git: GitStatusMap
  numstat: GitNumstatMap
  current: string | null
  searchOpen: boolean
  searchFocusNonce: number
  onCloseSearch: () => void
  recents: string[]
  bookmarks: string[]
  onOpen: (path: string, line?: number) => void
  onEdit: (path: string) => void
  newFileDir: string | null
  onNewFileDone: (created: EditCreateResult | null) => void
  onContextMenu: (e: ReactMouseEvent, path: string, isDir: boolean) => void
  sideWidth: number
  active?: boolean
}

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

const SEC_BOOKMARKS = '__bookmarks__'
const SEC_RECENTS = '__recents__'
const SEC_OUTSIDE = '__external__'
const SCRATCHPAD_RELIST_THROTTLE_MS = 600

function createRefusal(failure: string): string {
  if (failure.includes('KOLOFT_EXISTS')) return 'That name is taken.'
  if (failure.includes('KOLOFT_BAD_NAME')) return 'Just a file name — no “/” and no “..”.'
  if (failure.includes('KOLOFT_DIR_GONE')) return 'The folder is gone — nothing was written.'
  return 'Could not make the file.'
}

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
          if (e.key.startsWith('Arrow')) e.stopPropagation()
          if (e.key !== 'Enter') return
          e.stopPropagation()
          const name = e.currentTarget.value.trim()
          if (!name) return
          setError('')
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
  const [showIgnored, setShowIgnored] = useState(() => loadFlag(showIgnoredKey(root)))
  const [scratchOpen, setScratchOpen] = useState(true)
  const [extOpen, setExtOpen] = useState(true)
  const [bmOpen, setBmOpen] = useState(true)
  const [recentOpen, setRecentOpen] = useState(true)
  const [fsTick, setFsTick] = useState(0)

  const [query, setQuery] = useState('')
  const [searchMode, setSearchMode] = useState<SearchMode>('name')
  const [results, setResults] = useState<SearchHit[] | null>(null)
  const [contentResults, setContentResults] = useState<ContentHit[] | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [searching, setSearching] = useState(false)
  const [selIdx, setSelIdx] = useState(0)

  const [kbdRow, setKbdRow] = useState<string | null>(null)

  const bodyRef = useRef<HTMLDivElement>(null)
  const treeRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = treeRef.current
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
  const showIgnoredRef = useRef(showIgnored)
  showIgnoredRef.current = showIgnored

  const home = window.api.home
  const scratchpadDir = session?.scratchpadDir

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

  const firstRoot = useRef(root)
  useEffect(() => {
    if (firstRoot.current === root) {
      firstRoot.current = ''
      return
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

  useEffect(() => {
    if (!active) return
    for (const d of expanded) void loadDir(d)
  }, [active, expanded, loadDir])

  useEffect(() => {
    const off = window.api.fs.onDirChange((changed) => {
      if (changed !== root) return
      setFsTick((x) => x + 1)
    })
    return off
  }, [root])

  const relistOwedWhileHidden = useRef(false)
  useEffect(() => {
    if (fsTick === 0) return
    if (!active) {
      relistOwedWhileHidden.current = true
      return
    }
    relistOwedWhileHidden.current = false
    for (const d of expandedRef.current) {
      loadedRef.current.delete(d)
      void loadDir(d)
    }
  }, [fsTick, active, loadDir])

  useEffect(() => {
    if (!active || !relistOwedWhileHidden.current) return
    relistOwedWhileHidden.current = false
    for (const d of expandedRef.current) {
      loadedRef.current.delete(d)
      void loadDir(d)
    }
  }, [active, loadDir])

  // CC§2
  const scratchTimerRef = useRef<{ dir: string; t: ReturnType<typeof setTimeout> } | null>(null)
  useEffect(() => {
    if (!active || !scratchpadDir) return
    const pending = scratchTimerRef.current
    if (pending?.dir === scratchpadDir) return
    if (pending) clearTimeout(pending.t)
    const relistScratchpadWithoutRelistingEveryExpandedDir = (): void => {
      loadedRef.current.delete(scratchpadDir)
      void loadDir(scratchpadDir)
    }
    const t = setTimeout(() => {
      scratchTimerRef.current = null
      relistScratchpadWithoutRelistingEveryExpandedDir()
    }, SCRATCHPAD_RELIST_THROTTLE_MS)
    scratchTimerRef.current = { dir: scratchpadDir, t }
  }, [active, scratchpadDir, session?.updatedAt, loadDir])
  useEffect(
    () => () => {
      if (scratchTimerRef.current) clearTimeout(scratchTimerRef.current.t)
    },
    []
  )

  // CC§2 PLATFORM§28
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

  const idx = useMemo(() => sessionIndex(session, root), [session, root])
  const changedDirs = useMemo(() => changedDirsOf(git, root), [git, root])
  const live = livePath(session)
  const bookmarkSet = useMemo(() => new Set(bookmarks), [bookmarks])

  const scratchEntries = useMemo(
    () => scratchpadEntries(scratchpadDir ? children[scratchpadDir] : undefined, scratchpadDir),
    [children, scratchpadDir]
  )
  const scratchListed = useMemo(() => {
    const s = new Set<string>()
    for (const e of scratchEntries) if (!e.isDir) s.add(e.path)
    return s
  }, [scratchEntries])

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
          setMissingDirs((prev) =>
            prev.size === gone.size && [...gone].every((d) => prev.has(d)) ? prev : gone
          )
        }
      )
    }
    probe()
    // PLATFORM§28
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

  const toggleIgnored = useCallback((): void => {
    const next = !showIgnoredRef.current
    showIgnoredRef.current = next
    setShowIgnored(next)
    saveFlag(showIgnoredKey(root), next)
    loadedRef.current = new Set()
    for (const d of expandedRef.current) void loadDir(d)
    if (scratchpadDir) void loadDir(scratchpadDir)
  }, [root, loadDir, scratchpadDir])

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

  useEffect(() => {
    if (!newFileDir || expandedRef.current.has(newFileDir)) return
    const next = new Set(expandedRef.current)
    next.add(newFileDir)
    applyExpansion(next)
    void loadDir(newFileDir)
  }, [newFileDir, applyExpansion, loadDir])

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
  }, [current])

  useEffect(() => {
    if (!current) return
    bodyRef.current?.querySelector('.ft-node.active')?.scrollIntoView({ block: 'nearest' })
  }, [current, expanded])

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
        onDoubleClick={() => onEdit(p)}
        onContextMenu={(e) => onContextMenu(e, p, false)}
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
