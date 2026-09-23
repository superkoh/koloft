import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent
} from 'react'
import { createPortal } from 'react-dom'
import { LuAlignLeft, LuPencil, LuRotateCw, LuSearch } from 'react-icons/lu'
import '../filesView.css'
import type {
  ArtifactView,
  EditFingerprint,
  GitNumstatMap,
  GitStatusMap,
  SessionInfo
} from '@shared/types'
import { basename, isWebPagePath } from '@shared/preview'
import { boundSessionId, useActiveOpenFile, useStore, type OpenFile } from '../store'
import { ArtifactPane, NO_CAPS, sameCaps, type ArtifactCaps } from './ArtifactPane'
import { useEditProbe } from './EditPane'
import { ChangesView } from './ChangesView'
import { BrowseView } from './BrowseView'
import { clampSideWidth, readSideWidth, storeSideWidth } from './filesSide'
import {
  DEFAULT_FILTERS,
  GIT_LETTER,
  bookmarksKey,
  loadList,
  pushRecent,
  recentKey,
  relOf,
  saveList,
  splitPath,
  type BaseChoice,
  type ChangeFilters,
  type FilesMenu,
  type FilesTab
} from './filesModel'

export const READING_TAB_ID = 'files:reading'

export interface FilesController {
  tabId: string | null
  view: FilesTab
  setView: (v: FilesTab) => void
  baseChoice: BaseChoice
  setBaseChoice: (b: BaseChoice) => void
  filters: ChangeFilters
  setFilters: (f: ChangeFilters) => void
  menu: FilesMenu | null
  setMenu: (m: FilesMenu | null) => void
  searchOpen: boolean
  toggleSearch: () => void
  searchFocusNonce: number
  anchor: { rel: string; nonce: number } | null
  scrollToFile: (rel: string) => void
  refreshNonce: number
  refresh: () => void
  readingView: ArtifactView | undefined
  setReadingView: (v: ArtifactView) => void
  readingCaps: ArtifactCaps
  reportReadingCaps: (caps: ArtifactCaps) => void
  readingReloadNonce: number
  reloadReading: () => void
  outlineOpen: boolean
  setOutlineOpen: (v: boolean) => void
  recents: string[]
  bookmarks: string[]
  toggleBookmark: (path: string) => void
  openInReadingArea: (path: string, line?: number) => void
}

export function useFilesController(tabId: string | null, root: string | null): FilesController {
  const [view, setViewRaw] = useState<FilesTab>('changes')
  const [baseChoice, setBaseChoice] = useState<BaseChoice>('merge-base')
  const [filters, setFilters] = useState<ChangeFilters>(DEFAULT_FILTERS)
  const [menu, setMenu] = useState<FilesMenu | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchFocusNonce, setSearchFocusNonce] = useState(0)
  const [anchor, setAnchor] = useState<{ rel: string; nonce: number } | null>(null)
  const [refreshNonce, setRefreshNonce] = useState(0)
  const [readingView, setReadingViewRaw] = useState<ArtifactView | undefined>(undefined)
  const [readingCaps, setReadingCaps] = useState<ArtifactCaps>(NO_CAPS)
  const [readingReloadNonce, setReadingReloadNonce] = useState(0)
  const [outlineOpen, setOutlineOpen] = useState(false)
  const [recents, setRecents] = useState<string[]>([])
  const [bookmarks, setBookmarks] = useState<string[]>([])

  const setOpenFile = useStore((s) => s.setOpenFile)
  const openFile = useActiveOpenFile()

  const convAnchor = useStore((s) => (tabId ? boundSessionId(s, tabId) : undefined))
  const parked = useRef(
    new Map<string, { view: FilesTab; baseChoice: BaseChoice; filters: ChangeFilters }>()
  )
  const lastTab = useRef<string | null>(tabId)
  const lastAnchor = useRef<string | undefined>(convAnchor)
  const live = useRef({ view, baseChoice, filters })
  live.current = { view, baseChoice, filters }
  useEffect(() => {
    if (!tabId) return
    const sameTab = tabId === lastTab.current
    const sameConversation = !!convAnchor && convAnchor === lastAnchor.current
    const prevTab = lastTab.current
    lastTab.current = tabId
    if (convAnchor) lastAnchor.current = convAnchor
    if (sameTab || sameConversation) return
    if (prevTab) parked.current.set(prevTab, live.current)
    const next = parked.current.get(tabId)
    setViewRaw(next?.view ?? 'changes')
    setBaseChoice(next?.baseChoice ?? 'merge-base')
    setFilters(next?.filters ?? DEFAULT_FILTERS)
    setMenu(null)
    setSearchOpen(false)
    setAnchor(null)
    setOutlineOpen(false)
  }, [tabId, convAnchor])

  useEffect(() => {
    if (!root) {
      setRecents([])
      setBookmarks([])
      return
    }
    setRecents(loadList(recentKey(root)))
    setBookmarks(loadList(bookmarksKey(root)))
  }, [root])

  const src = openFile?.src ?? null
  useEffect(() => {
    setReadingViewRaw(undefined)
    setOutlineOpen(false)
  }, [src])

  const filesReveal = useStore((s) => s.filesReveal)
  const revealed = useRef(0)
  useEffect(() => {
    if (!filesReveal || filesReveal.nonce === revealed.current) return
    if (filesReveal.tabId !== tabId) return
    revealed.current = filesReveal.nonce
    setViewRaw('browse')
    const src = useStore.getState().openFiles[filesReveal.tabId]?.src
    if (!root || !src) return
    setRecents((prevList) => {
      const next = pushRecent(prevList, src)
      saveList(recentKey(root), next)
      return next
    })
  }, [filesReveal, root, tabId])

  const setView = useCallback((v: FilesTab): void => {
    setViewRaw(v)
    setMenu(null)
    if (v !== 'browse') setSearchOpen(false)
  }, [])

  const openInReadingArea = useCallback(
    (path: string, line?: number): void => {
      const label = basename(path)
      const next: OpenFile = line === undefined ? { src: path, label } : { src: path, label, line }
      setOpenFile(next)
      setMenu(null)
    },
    [setOpenFile]
  )

  const toggleSearch = useCallback((): void => {
    setViewRaw('browse')
    setMenu(null)
    setSearchOpen((open) => !open)
    setSearchFocusNonce((n) => n + 1)
  }, [])

  const toggleBookmark = useCallback(
    (path: string): void => {
      if (!root) return
      setBookmarks((prev) => {
        const next = prev.includes(path) ? prev.filter((p) => p !== path) : [path, ...prev]
        saveList(bookmarksKey(root), next)
        return next
      })
    },
    [root]
  )

  const reportReadingCaps = useCallback((caps: ArtifactCaps): void => {
    setReadingCaps((prev) => (sameCaps(prev, caps) ? prev : caps))
  }, [])

  return {
    tabId,
    view,
    setView,
    baseChoice,
    setBaseChoice,
    filters,
    setFilters,
    menu,
    setMenu,
    searchOpen,
    toggleSearch,
    searchFocusNonce,
    anchor,
    scrollToFile: useCallback(
      (rel: string) => setAnchor((a) => ({ rel, nonce: (a?.nonce ?? 0) + 1 })),
      []
    ),
    refreshNonce,
    refresh: useCallback(() => setRefreshNonce((n) => n + 1), []),
    readingView,
    setReadingView: setReadingViewRaw,
    readingCaps,
    reportReadingCaps,
    readingReloadNonce,
    reloadReading: useCallback(() => setReadingReloadNonce((n) => n + 1), []),
    outlineOpen,
    setOutlineOpen,
    recents,
    bookmarks,
    toggleBookmark,
    openInReadingArea
  }
}

export interface FilesBarProps {
  c: FilesController
  changedCount: number
  fullBtn: JSX.Element
}

export function FilesBar({ c, changedCount, fullBtn }: FilesBarProps): JSX.Element {
  const closeOnEsc = (e: ReactKeyboardEvent): void => {
    if (e.key === 'Escape') c.setMenu(null)
  }
  return (
    <div className="wb-bar">
      <div className="seg" role="group" aria-label="Files view">
        <button
          className={c.view === 'changes' ? 'on' : undefined}
          aria-pressed={c.view === 'changes'}
          onClick={() => c.setView('changes')}
        >
          Changes{changedCount > 0 && <span className="n">{changedCount}</span>}
        </button>
        <button
          className={c.view === 'browse' ? 'on' : undefined}
          aria-pressed={c.view === 'browse'}
          onClick={() => c.setView('browse')}
        >
          Browse
        </button>
      </div>
      <span className="wb-title" />
      {c.view === 'changes' ? (
        <>
          <div className="seg">
            <button
              className={c.menu?.kind === 'base' ? 'on' : undefined}
              aria-haspopup="menu"
              aria-expanded={c.menu?.kind === 'base'}
              onClick={() => c.setMenu(c.menu?.kind === 'base' ? null : { kind: 'base' })}
            >
              {c.baseChoice === 'head' ? 'vs HEAD' : 'base'} ▾
            </button>
          </div>
          <div className="seg">
            <button
              className={c.menu?.kind === 'filter' ? 'on' : undefined}
              aria-haspopup="menu"
              aria-expanded={c.menu?.kind === 'filter'}
              onClick={() => c.setMenu(c.menu?.kind === 'filter' ? null : { kind: 'filter' })}
            >
              Filter ▾
            </button>
          </div>
        </>
      ) : (
        <button
          className={'icobtn' + (c.searchOpen ? ' on' : '')}
          title="Search files (⌘⇧F)"
          aria-label="Search files"
          onClick={c.toggleSearch}
        >
          <LuSearch size={14} />
        </button>
      )}
      <button className="icobtn" onClick={c.refresh} title="Reload" aria-label="Reload">
        <LuRotateCw size={14} />
      </button>
      {fullBtn}

      {c.menu?.kind === 'base' && (
        <div
          className="bmenu fv-menu"
          role="menu"
          tabIndex={-1}
          ref={(el) => el?.focus()}
          onKeyDown={closeOnEsc}
          onMouseLeave={() => c.setMenu(null)}
        >
          {(
            [
              ['merge-base', 'vs merge-base'],
              ['head', 'vs HEAD']
            ] as [BaseChoice, string][]
          ).map(([k, label]) => (
            <button
              key={k}
              className={'bmenu-item' + (c.baseChoice === k ? ' on' : '')}
              role="menuitemradio"
              aria-checked={c.baseChoice === k}
              onClick={() => {
                c.setBaseChoice(k)
                c.setMenu(null)
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {c.menu?.kind === 'filter' && (
        <div
          className="bmenu fv-menu fv-filters"
          role="menu"
          tabIndex={-1}
          ref={(el) => el?.focus()}
          onKeyDown={closeOnEsc}
        >
          <FilterGroup
            label="Status"
            value={c.filters.status}
            options={[
              ['all', 'All'],
              ['modified', 'M'],
              ['added', 'A'],
              ['deleted', 'D'],
              ['renamed', 'R'],
              ['untracked', 'U'],
              ['conflict', '!']
            ]}
            onPick={(v) => c.setFilters({ ...c.filters, status: v as ChangeFilters['status'] })}
          />
          <FilterGroup
            label="Ownership"
            value={c.filters.owner}
            options={[
              ['all', 'All changes'],
              ['session', 'This session wrote']
            ]}
            onPick={(v) => c.setFilters({ ...c.filters, owner: v as ChangeFilters['owner'] })}
          />
          <FilterGroup
            label="Type"
            value={c.filters.type}
            options={[
              ['all', 'All'],
              ['docs', 'Docs'],
              ['code', 'Code']
            ]}
            onPick={(v) => c.setFilters({ ...c.filters, type: v as ChangeFilters['type'] })}
          />
        </div>
      )}
    </div>
  )
}

function FilterGroup({
  label,
  value,
  options,
  onPick
}: {
  label: string
  value: string
  options: [string, string][]
  onPick: (v: string) => void
}): JSX.Element {
  return (
    <div className="fv-fgroup" role="group" aria-label={label}>
      <span className="fv-flabel">{label}</span>
      <div className="ft-chips">
        {options.map(([k, text]) => (
          <button
            key={k}
            className={'ft-chip' + (value === k ? ' on' : '')}
            role="menuitemradio"
            aria-checked={value === k}
            data-chip={k}
            onClick={() => onPick(k)}
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  )
}

export interface FilesBodyProps {
  c: FilesController
  root: string | null
  rootMissing: boolean
  session: SessionInfo | null
  git: GitStatusMap
  numstat: GitNumstatMap
  base: string | null | undefined
  active: boolean
  onBody: (el: HTMLElement | null) => void
  onOpenWeb: (path: string) => void
  onSplit: (path: string, view: ArtifactView, scrollTop: number) => void
  onEdit: (path: string, created?: EditFingerprint) => void
  onZoomImage: (src: string) => void
  zoom: string | null
  onCloseZoom: () => void
}

export function FilesBody({
  c,
  root,
  rootMissing,
  session,
  git,
  numstat,
  base,
  active,
  onBody,
  onOpenWeb,
  onSplit,
  onEdit,
  onZoomImage,
  zoom,
  onCloseZoom
}: FilesBodyProps): JSX.Element {
  const contentRef = useRef<HTMLDivElement>(null)
  const [newFileDir, setNewFileDir] = useState<string | null>(null)
  const openFile = useActiveOpenFile()
  const activeTabId = useStore((s) => s.activeTabId)
  const setOpenFile = useStore((s) => s.setOpenFile)

  const fvRef = useRef<HTMLDivElement>(null)
  const [sideWidth, setSideWidth] = useState(readSideWidth)
  const [sideDragging, setSideDragging] = useState(false)
  const [fvWidth, setFvWidth] = useState<number | null>(null)
  useEffect(() => {
    const el = fvRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setFvWidth(el.getBoundingClientRect().width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [root, rootMissing])
  const shownSideWidth = fvWidth ? clampSideWidth(sideWidth, fvWidth) : sideWidth
  const endDrag = useRef<(() => void) | null>(null)
  useEffect(() => () => endDrag.current?.(), [])
  const startSideResize = useCallback((e: ReactMouseEvent): void => {
    e.preventDefault()
    const box = fvRef.current?.getBoundingClientRect()
    if (!box) return
    setSideDragging(true)
    let last: number | null = null
    const onMove = (ev: MouseEvent): void => {
      last = clampSideWidth(ev.clientX - box.left, box.width)
      setSideWidth(last)
    }
    const onUp = (): void => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      endDrag.current = null
      setSideDragging(false)
      if (last !== null) storeSideWidth(last)
    }
    endDrag.current = onUp
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [])

  useEffect(() => {
    onBody(contentRef.current)
    return () => onBody(null)
  }, [onBody, c.view, openFile?.src, root, rootMissing])

  const openPath = useCallback(
    (path: string, line?: number): void => {
      if (isWebPagePath(path)) {
        onOpenWeb(path)
        return
      }
      c.openInReadingArea(path, line)
    },
    [c, onOpenWeb]
  )

  const openContextMenu = useCallback(
    (e: ReactMouseEvent, path: string, isDir: boolean): void => {
      e.preventDefault()
      e.stopPropagation()
      c.setMenu({
        kind: 'context',
        path,
        rel: relOf(path, root),
        isDir,
        x: e.clientX,
        y: e.clientY
      })
    },
    [c, root]
  )

  if (!root || rootMissing) {
    return (
      <div className="fv fv-empty" ref={contentRef}>
        <p>{rootMissing ? 'This directory no longer exists.' : 'No workspace directory.'}</p>
      </div>
    )
  }

  const reading = c.view === 'browse' ? openFile : null

  return (
    <div className="fv" data-view={c.view} ref={fvRef}>
      {c.view === 'changes' ? (
        <ChangesView
          root={root}
          sideWidth={shownSideWidth}
          base={base}
          git={git}
          numstat={numstat}
          filters={c.filters}
          session={session}
          refreshNonce={c.refreshNonce}
          anchor={c.anchor}
          active={active}
          onOpenWeb={onOpenWeb}
          onSplit={onSplit}
          onContextMenu={openContextMenu}
          onScrollRequest={c.scrollToFile}
          streamRef={contentRef}
        />
      ) : (
        <div className="fv-browse">
          <BrowseView
            root={root}
            active={active}
            session={session}
            git={git}
            numstat={numstat}
            current={openFile?.src ?? null}
            searchOpen={c.searchOpen}
            searchFocusNonce={c.searchFocusNonce}
            onCloseSearch={c.toggleSearch}
            recents={c.recents}
            bookmarks={c.bookmarks}
            sideWidth={shownSideWidth}
            onOpen={openPath}
            onEdit={onEdit}
            newFileDir={newFileDir}
            onNewFileDone={(created) => {
              setNewFileDir(null)
              if (created) onEdit(created.path, { mtimeMs: created.mtimeMs, size: created.size })
            }}
            onContextMenu={openContextMenu}
          />
          <div className="fv-read" ref={contentRef}>
            {reading ? (
              <ReadingArea
                c={c}
                file={reading}
                root={root}
                git={git}
                numstat={numstat}
                base={base}
                onZoomImage={onZoomImage}
                zoom={zoom}
                onCloseZoom={onCloseZoom}
                onNavigate={openPath}
                onEdit={onEdit}
                onPathMenu={openContextMenu}
                onClose={() => setOpenFile(null)}
              />
            ) : (
              <div className="fv-empty">
                <p>Select a file to read it here.</p>
              </div>
            )}
          </div>
        </div>
      )}

      <div
        className={'fv-gutter' + (sideDragging ? ' active' : '')}
        style={{ left: shownSideWidth }}
        onMouseDown={startSideResize}
        title="Drag to resize the file list"
      />
      {sideDragging && <div className="drag-overlay" />}

      {c.menu?.kind === 'context' &&
        ((ctx) => (
          <FilesContextMenu
            menu={ctx}
            bookmarked={c.bookmarks.includes(ctx.path)}
            onClose={() => c.setMenu(null)}
            onOpen={() => openPath(ctx.path)}
            onEdit={() => onEdit(ctx.path)}
            onNewFile={() => setNewFileDir(ctx.path)}
            onBookmark={() => c.toggleBookmark(ctx.path)}
            sessionTabId={activeTabId}
          />
        ))(c.menu)}
    </div>
  )
}

function ReadingArea({
  c,
  file,
  root,
  git,
  numstat,
  base,
  onZoomImage,
  zoom,
  onCloseZoom,
  onNavigate,
  onEdit,
  onPathMenu,
  onClose
}: {
  c: FilesController
  file: OpenFile
  root: string
  git: GitStatusMap
  numstat: GitNumstatMap
  base: string | null | undefined
  onZoomImage: (src: string) => void
  zoom: string | null
  onCloseZoom: () => void
  onNavigate: (path: string, line?: number) => void
  onEdit: (path: string) => void
  onPathMenu: (e: ReactMouseEvent, path: string, isDir: boolean) => void
  onClose: () => void
}): JSX.Element {
  const { dir, name } = splitPath(file.src, root)
  const status = git[file.src]
  const delta = numstat[file.src]
  const caps = c.readingCaps
  const probe = useEditProbe(file.src)

  return (
    <>
      <div className="wb-bar fv-artifact-hd" onContextMenu={(e) => onPathMenu(e, file.src, false)}>
        <span className="wb-title" title={`${file.src} — click for Reveal in Finder / Copy path`}>
          <span className="fv-pathbtn" onClick={(e) => onPathMenu(e, file.src, false)}>
            {dir && <span className="dir">{dir}</span>}
            <span className="nm">{name}</span>
          </span>
        </span>
        {status && (
          <span className={'ft-gbadge git-' + status} title={status}>
            {GIT_LETTER[status]}
          </span>
        )}
        {delta && (delta.added > 0 || delta.removed > 0) && (
          <span className="ft-delta">
            {delta.added > 0 && <span className="add">+{delta.added}</span>}
            {delta.removed > 0 && <span className="del">−{delta.removed}</span>}
          </span>
        )}
        {caps.views.length > 0 && (
          <div className="seg" role="group" aria-label="View mode">
            {caps.views.map((v) => (
              <button
                key={v}
                className={v === caps.current ? 'on' : undefined}
                aria-pressed={v === caps.current}
                disabled={v === 'diff' && !caps.hasDiff}
                onClick={() => c.setReadingView(v)}
              >
                {v === 'render' ? 'Rendered' : v === 'diff' ? 'Diff' : 'Source'}
              </button>
            ))}
          </div>
        )}
        <button className="icobtn" onClick={c.reloadReading} title="Reload" aria-label="Reload">
          <LuRotateCw size={14} />
        </button>
        <button
          className="icobtn wb-edit"
          aria-label="Edit"
          title={probe.title || 'Edit'}
          disabled={!probe.can}
          onClick={() => onEdit(file.src)}
        >
          <LuPencil size={13} />
        </button>
        <button
          className={'icobtn' + (c.outlineOpen ? ' on' : '')}
          title="Outline"
          aria-label="Outline"
          disabled={!caps.hasOutline}
          onClick={() => c.setOutlineOpen(!c.outlineOpen)}
        >
          <LuAlignLeft size={14} />
        </button>
      </div>
      <div className="wb-host fv-read-host">
        <ArtifactPane
          tabId={READING_TAB_ID}
          path={file.src}
          view={c.readingView}
          wsRoot={root}
          line={file.line}
          base={base}
          changed={!!git[file.src]}
          reloadNonce={c.readingReloadNonce}
          outlineOpen={c.outlineOpen}
          onCaps={(_id, caps) => c.reportReadingCaps(caps)}
          onNavigate={(_id, path, line) => onNavigate(path, line)}
          onBody={() => {}}
          onZoomImage={onZoomImage}
          zoom={zoom}
          onCloseZoom={onCloseZoom}
          onOutlineClose={() => c.setOutlineOpen(false)}
          onClose={onClose}
        />
      </div>
    </>
  )
}

function FilesContextMenu({
  menu,
  bookmarked,
  onClose,
  onOpen,
  onEdit,
  onNewFile,
  onBookmark,
  sessionTabId
}: {
  menu: Extract<FilesMenu, { kind: 'context' }>
  bookmarked: boolean
  onClose: () => void
  onOpen: () => void
  onEdit: () => void
  onNewFile: () => void
  onBookmark: () => void
  sessionTabId: string | null
}): JSX.Element {
  const setOpenFile = useStore((s) => s.setOpenFile)
  const items: [string, () => void][] = []
  if (menu.isDir) items.push(['New File…', onNewFile])
  if (!menu.isDir) {
    items.push(['Edit', onEdit])
    items.push(['Open', onOpen])
    if (isWebPagePath(menu.path)) {
      items.push([
        'View source',
        () => {
          setOpenFile({ src: menu.path, label: basename(menu.path) })
        }
      ])
    }
  }
  items.push(['Reveal in Finder', () => window.api.fs.reveal(menu.path)])
  items.push(['Open with default app', () => window.api.preview.osOpen(menu.path)])
  items.push(['Copy path', () => window.api.browser.copyText(menu.path)])
  items.push(['Copy relative path', () => window.api.browser.copyText(menu.rel)])
  if (!menu.isDir) {
    items.push([bookmarked ? 'Remove bookmark' : 'Add bookmark', onBookmark])
    if (sessionTabId) {
      items.push([
        '@ Inject into terminal',
        () => {
          window.api.terminal.write(sessionTabId, '@' + menu.rel + ' ')
        }
      ])
    }
  }

  // ADR-0013
  return createPortal(
    <div
      className="ft-ctx"
      role="menu"
      style={{ left: menu.x, top: menu.y }}
      tabIndex={-1}
      ref={(el) => el?.focus()}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose()
      }}
      onBlur={onClose}
    >
      {items.map(([label, run]) => (
        <div
          key={label}
          className="ft-ctx-it"
          role="menuitem"
          tabIndex={-1}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            run()
            onClose()
          }}
        >
          {label}
        </div>
      ))}
    </div>,
    document.body
  )
}
