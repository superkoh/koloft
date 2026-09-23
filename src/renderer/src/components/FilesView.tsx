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

/**
 * FR-38…FR-50 — the pinned `files` tab's content, in three exported pieces because the
 * tab's chrome and its body live in two different slots of the panel:
 *
 *  · `useFilesController` — every bit of the tab's runtime state. It is called BY
 *    `WorkbenchPane`, which is what lets FR-54's Esc ladder and FR-45's ⌘⇧F read and
 *    drive this surface without a callback maze: the panel can simply see whether a
 *    Files menu or the search box is open.
 *  · `FilesBar` — the kind-bar row (the Changes/Browse switch, the base picker, the
 *    filter menu, ↻).
 *  · `FilesBody` — the reading surface: Changes' stream, Browse's tree, the shared
 *    reading area and the row context menu.
 *
 * §Data Model puts the view choice, the base and the filters in RUNTIME state, so the
 * controller parks each conversation's view state and restores it on the way back (WB-C05).
 * Only two conveniences persist, both per WORKSPACE in localStorage and both inheriting
 * the retiring tree's own slots: Browse's expansion state and the Recents list.
 */

/** The reading area is one artifact hosted inside the pinned tab, so it needs an id of
 *  its own for `ArtifactPane`'s per-tab callbacks. It is never a tab id — nothing in
 *  `workbenchTabs` ever sees it. */
export const READING_TAB_ID = 'files:reading'

export interface FilesController {
  /** the CONVERSATION TAB whose Files tab this is; null when none is selected (FR-04) */
  tabId: string | null
  view: FilesTab
  setView: (v: FilesTab) => void
  baseChoice: BaseChoice
  setBaseChoice: (b: BaseChoice) => void
  filters: ChangeFilters
  setFilters: (f: ChangeFilters) => void
  /** whichever popover is open, or null. FR-54's third rung consumes it. */
  menu: FilesMenu | null
  setMenu: (m: FilesMenu | null) => void
  /** FR-45 — Browse's search row */
  searchOpen: boolean
  /** ⌘⇧F: open search (activating Browse first), or close-and-clear if already open */
  toggleSearch: () => void
  /** bumped every time ⌘⇧F asks for the focus, so a second press while the box is
   *  already focused is still observable */
  searchFocusNonce: number
  /** FR-38 — the left list asked the stream to scroll to this file. The nonce makes a
   *  second click on the same row scroll again. */
  anchor: { rel: string; nonce: number } | null
  scrollToFile: (rel: string) => void
  /** ↻ (FR-58) — re-resolve the base and re-query the whole set */
  refreshNonce: number
  refresh: () => void
  /** the reading area's view choice (FR-31's full header), reset per file */
  readingView: ArtifactView | undefined
  setReadingView: (v: ArtifactView) => void
  readingCaps: ArtifactCaps
  reportReadingCaps: (caps: ArtifactCaps) => void
  readingReloadNonce: number
  reloadReading: () => void
  outlineOpen: boolean
  setOutlineOpen: (v: boolean) => void
  /** FR-49 — per-workspace Recents, user opens only */
  recents: string[]
  bookmarks: string[]
  toggleBookmark: (path: string) => void
  /** the one way a file becomes the reading area's subject. `user` opens push Recents;
   *  an agent's `open` (FR-14) must never reach this — it writes `openFiles` directly. */
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

  /**
   * The view, base and filters are per CONVERSATION: a file opened in Browse in tab A is
   * still on screen after a trip to tab B and back. The controller is one instance for the
   * whole panel (D8), so when the conversation changes it parks the outgoing one's state
   * and takes the incoming one's out again — one never seen before starts at the defaults.
   *
   * ⇧⌘R mints a NEW pty id for the same conversation, and restart-session T12 pins that
   * the reading area stays on screen through it — so the identity is the conversation's
   * ANCHOR (`boundSessionId`'s whole chain, which a restart carries across and a switch
   * changes), and only when both the tab and the anchor moved is it a different
   * conversation. The chain, not `tab.sessionId`: only ⇧⌘R writes that field, so an
   * ordinary ⌘N session's first restart would otherwise read as a new conversation.
   */
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
    // keyed by TAB id on both sides: a restart keeps the state live (it never parks), so
    // the new pty id it mints has nothing to look up
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

  // The two persisted conveniences are per WORKSPACE, not per session (WB-P06): two
  // sessions on the same worktree share them, and a different worktree starts clean.
  useEffect(() => {
    if (!root) {
      setRecents([])
      setBookmarks([])
      return
    }
    setRecents(loadList(recentKey(root)))
    setBookmarks(loadList(bookmarksKey(root)))
  }, [root])

  // The reading area's view is per FILE: FR-30's default has to win when the subject
  // changes, or a code file opened after a markdown one would inherit "Rendered".
  const src = openFile?.src ?? null
  useEffect(() => {
    setReadingViewRaw(undefined)
    setOutlineOpen(false)
  }, [src])

  /**
   * FR-57 — the store, not this controller, is where an open actually lands: a shell's
   * `open <file>`, a Browse click and the agent's intercept all call `setOpenFile`. The
   * store raises `filesReveal` for the USER ones only (an agent open carries
   * `source: 'intercept'` and raises nothing), and this consumes it:
   *
   *  · "renders in the reading area" — the reading area lives in Browse (FR-10), so a
   *    user open has to bring Browse with it. Without this the file lands in the half
   *    nobody is looking at: panel expanded, `files` active, nothing visible.
   *  · "enters Recents" — `pushRecent` is idempotent (a repeat moves the entry to the
   *    front), so the in-view path pushing first and this pushing again is harmless.
   *
   * A NONCE, not a comparison against the previous `openFile`, and that is the correctness
   * of it — the first spelling of this was a comparison and T-AUX-02b caught it. The panel
   * is not mounted until a session is BOUND (`App`'s `panelMounted` follows `panelShown`,
   * which needs the bound id), so an open during a resume's pre-bind window happens while
   * this hook does not exist. When it finally mounts, its "what did I see last" ref
   * initialises to the file that is already open, the transition is invisible, and the
   * reset above leaves the tab on Changes with the file loaded behind it. A nonce is still
   * unconsumed on that first mount. It is also what keeps a plain session SWITCH from
   * being mistaken for an open: switching to a tab that already had a file changes
   * `openFile` but raises no nonce, so the tab comes back on whichever view it was left on.
   *
   * The agent's own open is deliberately left with no consequence at all: it still becomes
   * the reading area's subject — the pre- "renders in Koloft, not the OS app" contract —
   * but it moves nothing on screen. That is not a hidden failure: the user finds it by
   * opening Browse, which is the same "expand the panel and look" route FR-14 prescribes.
   * What it must never do is yank a reader out of the Changes stream.
   */
  const filesReveal = useStore((s) => s.filesReveal)
  const revealed = useRef(0)
  useEffect(() => {
    if (!filesReveal || filesReveal.nonce === revealed.current) return
    // Only once this controller serves the tab the reveal names. A shell's `open` in a
    // background session first switches to that session, and the panel follows the
    // switch two frames later (App's `landedTab`): consumed before that, the reveal moved
    // the OLD tab's view to Browse and the landing's own reset (above) put it straight
    // back on Changes — the file arrived in the half nobody was looking at. The nonce
    // stays unconsumed until `tabId` catches up, which is what re-runs this.
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
    // Leaving Browse unmounts the search row along with `BrowseView`, and its own effect is
    // what clears the query — so a `searchOpen` left true here goes stale, and the next
    // ⌘⇧F flips that stale true to FALSE: the view switches to Browse with no search box
    // and the user has to press again.
    if (v !== 'browse') setSearchOpen(false)
  }, [])

  const openInReadingArea = useCallback(
    (path: string, line?: number): void => {
      const label = basename(path)
      const next: OpenFile = line === undefined ? { src: path, label } : { src: path, label, line }
      // No `source`: this path is only ever reached by a USER click, which is exactly what
      // FR-49 lets into Recents and FR-57 makes land visibly. An agent's `open` goes
      // through the store's own intercept branch and never comes here (FR-14).
      //
      // Switching to Browse and pushing Recents are deliberately NOT done here: this call
      // raises `filesReveal`, and the effect above owns both. Doing them in two places
      // would be two implementations of one rule, free to drift — and the effect's version
      // is the one that also covers the routes that never pass through this function.
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
        // newest first, as the tree did — a bookmark added now is the one being looked for
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

// ---------------------------------------------------------------------------

export interface FilesBarProps {
  c: FilesController
  /** FR-50 — the UNFILTERED change count at the current base, same number the pinned
   *  tab's badge shows. It is computed by the panel because the file-tab headers need
   *  the same poll (FR-58's one merged pipeline). */
  changedCount: number
  /** the ⤢ / ⤡ button the panel builds for every kind bar */
  fullBtn: JSX.Element
}

/**
 * The `files` kind bar (Fig 2): the view switch on the left, the base picker and the
 * filter menu on the right. Base and Filter belong to Changes (FR-39/FR-40) and are
 * replaced by Browse's search toggle when Browse is on screen — the same slot, so the
 * band's height and the ⤢ position never move between the two halves.
 */
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
          {/* FR-40 — three groups, single-select within a group, AND across groups.
              Picking a chip REPLACES the group's choice rather than adding to it, which
              is why each row is a radio group and not a set of checkboxes. */}
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

// ---------------------------------------------------------------------------

export interface FilesBodyProps {
  c: FilesController
  /** the session's worktree; null or missing puts a placeholder on screen (§6) */
  root: string | null
  rootMissing: boolean
  session: SessionInfo | null
  /** the panel's merged git pipeline (FR-58), already resolved against `base` */
  git: GitStatusMap
  numstat: GitNumstatMap
  /** the baseline: a sha / `'HEAD'`, `null` when there is none, `undefined` while the
   *  panel is still resolving it (see `ArtifactPane`'s `base`) */
  base: string | null | undefined
  /** the panel is showing AND this tab is the active one */
  active: boolean
  /** FR-35 — the panel's single find bar searches this element */
  onBody: (el: HTMLElement | null) => void
  /** FR-11 — an .html/.htm file leaves Files for a `web` tab: from a Browse row's click,
   *  or from a Changes block's `↗ New tab` (a Changes ROW click only anchors the stream) */
  onOpenWeb: (path: string) => void
  /** FR-12 — ↗ splits the artifact into a standalone `file` tab */
  onSplit: (path: string, view: ArtifactView, scrollTop: number) => void
  /** B-02/B-03/B-06 — open this file in a tab of its own, in edit mode. `created` is
   *  `edit.create`'s fingerprint for a file made a second ago, which saves the editor a
   *  second read of a file it already knows is empty (§05 ⑥). */
  onEdit: (path: string, created?: EditFingerprint) => void
  /** FR-54's first rung lives at panel level, so the blow-up is reported up */
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
  /** B-06 — the folder whose name box is open, or null. It belongs here rather than in the
   *  controller because both halves of the gesture are here: the row menu that starts it
   *  and the tree that draws it. */
  const [newFileDir, setNewFileDir] = useState<string | null>(null)
  const openFile = useActiveOpenFile()
  const activeTabId = useStore((s) => s.activeTabId)
  const setOpenFile = useStore((s) => s.setOpenFile)

  // The left column's width — one number for both halves, dragged on the grip that sits
  // over their shared border (`filesSide.ts` says why it is shared and why it is local).
  const fvRef = useRef<HTMLDivElement>(null)
  const [sideWidth, setSideWidth] = useState(readSideWidth)
  const [sideDragging, setSideDragging] = useState(false)
  // The stored width was clamped against the panel it was dragged in; the panel on screen
  // now may be narrower (a smaller window, a narrower Workbench). So the number APPLIED is
  // re-clamped against the live width — the preference itself is kept, and comes back in
  // full once the panel is wide enough again.
  const [fvWidth, setFvWidth] = useState<number | null>(null)
  useEffect(() => {
    const el = fvRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setFvWidth(el.getBoundingClientRect().width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [root, rootMissing])
  const shownSideWidth = fvWidth ? clampSideWidth(sideWidth, fvWidth) : sideWidth
  // the drag in flight, so an unmount mid-drag (session switch, panel collapse) can end it
  // instead of leaving the document listeners behind
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

  // `root`/`rootMissing` are deps because the early return below renders a DIFFERENT
  // element under this same ref. Without them the panel's find backend keeps a detached
  // node as its search root and ⌘F on the pinned tab reports 0/0 forever.
  useEffect(() => {
    onBody(contentRef.current)
    return () => onBody(null)
  }, [onBody, c.view, openFile?.src, root, rootMissing])

  /** FR-10 / FR-11 — where a BROWSE click lands: the tree, the search hits, the row menu's
   *  Open and a rendered doc's file refs all resolve here, so those four can never disagree
   *  (html leaves for a guest, everything else renders in place). It is not the only fork
   *  of that rule, though. Changes' rows never come through — a row click there is spent on
   *  the anchor scroll (`ChangesView`'s `clickRow`, and its `split` for ↗ New tab) — and
   *  the file picker forks once more in `WorkbenchPane.openFilePicker`. Three sites, one
   *  predicate (`isWebPagePath`). */
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
          /* NFR-02 — the unresolved state is handed on AS IS. Collapsing it with `?? null`
             read "still resolving" as "there is no baseline", and Changes then asked main
             for an un-based diff, which main answers by resolving a merge-base of its own:
             two baselines and two aggregates on every cold open. Changes waits instead. */
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
            /* FR-51 — `fs.listDir` spawns `git check-ignore`, so a tree that kept listing
               behind a collapsed panel would be exactly the Workbench git traffic WB-K08
               counts. Same gate the panel's own poll uses. */
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
              // B-06 — straight into the editor, with the fingerprint the create handed back
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

      {/* the grip over the left column's right edge — one strip for both halves */}
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

/**
 * FR-31's full artifact header over FR-10's reading area. Deliberately the same control
 * set, in the same order, as the `file` tab's kind bar (`WorkbenchPane`'s file branch):
 * path + git letter + ±N + [ Rendered | Diff | Source ] + ↻ + ≡. WB-B09 asserts the two
 * agree, and they only stay that way if the markup is written to match — the reading area
 * cannot reuse the kind bar itself, because the Files tab's bar is already spent on the
 * Changes/Browse switch.
 */
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
  /** FR-48's row menu (Reveal in Finder, Copy path, …), opened from the header's path */
  onPathMenu: (e: ReactMouseEvent, path: string, isDir: boolean) => void
  onClose: () => void
}): JSX.Element {
  const { dir, name } = splitPath(file.src, root)
  const status = git[file.src]
  const delta = numstat[file.src]
  const caps = c.readingCaps
  /** B-04/B-05 — the same probe the `file` tab's pencil uses, so the two bars can never
   *  disagree about the same file. */
  const probe = useEditProbe(file.src)

  return (
    <>
      <div className="wb-bar fv-artifact-hd" onContextMenu={(e) => onPathMenu(e, file.src, false)}>
        {/* the path is also the door to Reveal in Finder / Copy path — a click, not only a
            right-click, for the same reason Changes' block header does it. The click sits
            on an inner span that hugs the text: `.wb-title` is `flex: 1`, and a handler on
            it would turn the whole blank strip up to the badges into one wide button. */}
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
        {/* B-02 - the reading column is never editable in place: this PROMOTES the file to
            a tab of its own and edits it there. Same position and same look as the `file`
            tab's pencil, which is the rule the two bars are held to (WB-B09). */}
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
          /* NFR-02 — the baseline the panel resolved, not one this artifact re-derives */
          base={base}
          /* §6 — the evidence that separates "genuinely unchanged" from "read mid-write" */
          changed={!!git[file.src]}
          reloadNonce={c.readingReloadNonce}
          outlineOpen={c.outlineOpen}
          onCaps={(_id, caps) => c.reportReadingCaps(caps)}
          onNavigate={(_id, path, line) => onNavigate(path, line)}
          onBody={() => {
            /* the find root is the whole reading column, reported by FilesBody */
          }}
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

/**
 * FR-48 — the row context menu, shared by Browse's and Changes' rows so the two can never
 * drift apart. "View source" is the only conditional item: it exists for a web file,
 * whose plain click (FR-11) goes to a guest instead of the reading area.
 */
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
  // Item-for-item the retiring tree's menu, including which entries a DIRECTORY row does
  // not get: a folder has nothing to open, nothing to render and nothing to bookmark, but
  // its path is still worth copying and revealing.
  const items: [string, () => void][] = []
  // B-06 — a folder's own first item. A file row does not get it: the answer to "make one
  // next to this" is the folder above it, and putting it on both would make the menu ask
  // which of the two the user meant.
  if (menu.isDir) items.push(['New File…', onNewFile])
  if (!menu.isDir) {
    // B-03 — FIRST, ahead of Open. Reading a file costs two clicks; this is what makes
    // changing one cost two as well.
    items.push(['Edit', onEdit])
    items.push(['Open', onOpen])
    if (isWebPagePath(menu.path)) {
      items.push([
        'View source',
        () => {
          // the guest renders the page; the reading area is where its markup is legible
          setOpenFile({ src: menu.path, label: basename(menu.path) })
        }
      ])
    }
  }
  items.push(['Reveal in Finder', () => window.api.fs.reveal(menu.path)])
  // A-06 — the answer for everything the panel itself cannot open: a big file, a binary,
  // a project type this app has no viewer for. Same system hand-off the preview pane uses.
  items.push(['Open with default app', () => window.api.preview.osOpen(menu.path)])
  items.push(['Copy path', () => window.api.browser.copyText(menu.path)])
  items.push(['Copy relative path', () => window.api.browser.copyText(menu.rel)])
  if (!menu.isDir) {
    items.push([bookmarked ? 'Remove bookmark' : 'Add bookmark', onBookmark])
    if (sessionTabId) {
      items.push([
        '@ Inject into terminal',
        () => {
          // FR-48 reuses the EXISTING terminal write and adds no feed-back: the text lands
          // on the input line and the user submits it (WB-B08 asserts no auto-submit). The
          // TRAILING SPACE is part of the contract, not cosmetics — it is what lets the
          // user keep typing after the reference instead of backspacing into it.
          window.api.terminal.write(sessionTabId, '@' + menu.rel + ' ')
        }
      ])
    }
  }

  // The coordinates are viewport coordinates, so the layer has to be `position: fixed` —
  // and a fixed layer is PORTALLED to the body rather than rendered in place, because any
  // ancestor with a `transform` silently re-bases fixed positioning onto itself and traps
  // the z-index with it. The panel is full of animated surfaces; this is not a bet worth
  // taking. The skin is the retiring tree's own `.ft-ctx`, which is why FR-48's menu looks
  // identical to the one it replaces.
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
          onMouseDown={(e) =>
            e.preventDefault()
          } /* keep the focus, so onBlur means "clicked away" */
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
