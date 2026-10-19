import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type JSX
} from 'react'
import { IconDownload, IconMore } from '../icons'
import { routeFor } from '@shared/browserRoute'
import { CDP_GUEST_ID_RETRIES, CDP_GUEST_ID_RETRY_MS } from '@shared/cdpBudget'
import { isWebPagePath } from '@shared/preview'
import { BACKEND_LABEL, backendIdOf } from '@shared/sessionBackend'
import type { ArtifactView, BrowserCdpOp, EditFingerprint, GithubTarget } from '@shared/types'
import { CommitDialog } from './CommitDialog'
import { useChangeTotals } from './FilesTabLabel'
import { BrowserActions } from './BrowserActions'
import { BrowserAddressBar } from './BrowserAddressBar'
import type { GuestElement } from './BrowserGuest'
import { stopEndsMount } from './browserMount'
import { BrowserModal, type BrowserDialog, type BrowserDialogAnswer } from './BrowserModal'
import { BrowserDownloads, useBrowserDownloads } from './BrowserDownloads'
import { BrowserPermissionBar } from './BrowserPermissionBar'
import { hasDownloads } from './downloadList'
import { NO_FOCUS_SIGNAL } from './TerminalView'
import { FilesBar, FilesBody, useFilesController } from './FilesView'
import { useGitChangeSet, useWatchlessRefresh } from './gitChangeSet'
import { relOf } from './filesModel'
import { NO_CAPS, sameCaps, type ArtifactCaps } from './ArtifactPane'
import { editRefusal, useEditProbe } from './EditPane'
import {
  allEditTabs,
  beginEdit,
  dirtyTabsOf,
  discardTab,
  endEdit,
  getEntry,
  isTabDirty,
  saveTab,
  setEditingActive,
  subscribeDirty
} from '../editRegistry'
import { historyKey, loadHistory, remember, saveHistory } from '../browserHistory'
import { workspaceOfTab } from '../sessionRows'
import { useStore } from '../store'
import {
  FILES_TAB_ID,
  activateTab,
  closeTab,
  cycleTab,
  dialogHasLiveOwner,
  emptyTabSet,
  moveTab,
  navigateTab,
  openTab,
  retargetOrOpenTab,
  retitleTab,
  setTabScrollTop,
  setTabView,
  shortAuxCwd,
  type OpenTabResult,
  type WorkbenchTab,
  type WorkbenchTabSet
} from './workbenchTabs'
import type { WorkbenchCommandSignal } from './workbenchCommands'
import { FileTabBar, FullWidthButton } from './WorkbenchBars'
import { WorkbenchFind } from './WorkbenchFind'
import { GithubMenu, useWorkbenchGithub } from './workbenchGithub'
import { NewTabMenu, PageMoreMenu } from './WorkbenchMenus'
import { WorkbenchTabStrip, type TabAudio } from './WorkbenchTabStrip'
import { FileTabHost, TerminalHost } from './WorkbenchTabHosts'
import {
  BLANK_RUNTIME,
  WebGuestHost,
  WebPageState,
  guestHistory,
  guestId,
  guestUrl,
  type GuestEvents,
  type TabRuntime
} from './WorkbenchWebGuests'
import { useBrowserPermissions } from './useBrowserPermissions'
import { useCdpOps, useStripReport } from './useCdpOps'

function globalLiveGuestLimit(): number {
  return window.api.browserGuestLimit
}

const ZOOM_STEPS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2]

const WATCHLESS_REFRESH_THROTTLE_MS = 600

const NO_TABS = emptyTabSet()

const PREARMED_COMMANDS: ReadonlySet<WorkbenchCommandSignal['id']> = new Set([
  'find-files',
  'browser-new-tab'
])

export interface WorkbenchPaneProps {
  tabId: string | null
  states: Record<string, WorkbenchTabSet>
  liveTabs: ReadonlySet<string>
  visible: boolean
  full: boolean
  command: WorkbenchCommandSignal | null
  dialog: BrowserDialog | null
  onUpdate: (
    tabId: string,
    update: (prev: WorkbenchTabSet) => WorkbenchTabSet,
    after?: () => void
  ) => void
  onEvicted: (tab: WorkbenchTab, set: WorkbenchTabSet) => void
  onExternalOpen: (url: string) => void
  onCertProceed: (url: string) => void | Promise<void>
  onDialogAnswer: (id: string, answer: BrowserDialogAnswer) => void
  onToggleFull: () => void
  panelFocus: number
  onEscapeFellThrough: () => void
  onReturnFocus: () => void
  treeRoot: string | null
  activeTabId: string | null
  pinned: Record<string, string[]>
  tabForSession: (sessionId: string) => string | undefined
  cdpOps: BrowserCdpOp[]
  onCdpDone: (opId: string) => void
  onCdpCreate: (sessionId: string, url: string) => Promise<string | null>
}

export const WorkbenchPane = memo(function WorkbenchPane({
  tabId: ownerTab,
  states,
  liveTabs,
  visible,
  full,
  command,
  dialog,
  onUpdate,
  onEvicted,
  onExternalOpen,
  onCertProceed,
  onDialogAnswer,
  onToggleFull,
  panelFocus,
  onEscapeFellThrough,
  onReturnFocus,
  treeRoot,
  activeTabId,
  pinned,
  tabForSession,
  cdpOps,
  onCdpDone,
  onCdpCreate
}: WorkbenchPaneProps): JSX.Element {
  const session = useStore((s) => s.sessions.find((x) => x.tabId === activeTabId) ?? null)
  const termFocus = useStore((s) => s.termFocus)
  const load = useStore((s) => (ownerTab ? s.workbenchLoad[ownerTab] : undefined))
  const ownerBackend = useStore(
    (s) => backendIdOf(s.tabs.find((t) => t.id === ownerTab)?.kind) ?? 'claude'
  )
  const [live, setLive] = useState<string[]>([])
  const [runtime, setRuntime] = useState<Record<string, TabRuntime>>({})
  const [attached, setAttached] = useState(0)
  const [findOpen, setFindOpen] = useState(false)
  const [findFocusTick, setFindFocusTick] = useState(0)
  const { downloads, clearFinished } = useBrowserDownloads()
  const [dlOpen, setDlOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [newMenuOpen, setNewMenuOpen] = useState(false)
  const [ghMenu, setGhMenu] = useState(false)
  const [commitOpen, setCommitOpen] = useState(false)
  const perms = useBrowserPermissions()
  const [audio, setAudio] = useState<TabAudio>({})
  const [pageFullscreen, setPageFullscreen] = useState(false)
  const [zoom, setZoom] = useState<string | null>(null)
  const [caps, setCaps] = useState<Record<string, ArtifactCaps>>({})
  const [outlineOpen, setOutlineOpen] = useState<Record<string, boolean>>({})
  const [reloadNonce, setReloadNonce] = useState<Record<string, number>>({})
  const [editing, setEditing] = useState<Record<string, boolean>>({})
  const [editFocus, setEditFocus] = useState<Record<string, number>>({})
  const [editTick, bumpEdit] = useReducer((n: number) => n + 1, 0)
  useEffect(() => subscribeDirty(bumpEdit), [])

  const files = useFilesController(ownerTab, treeRoot)
  const refreshFiles = files.refresh
  const { git, numstat, base, rootMissing, watchDead, reread } = useGitChangeSet(
    treeRoot,
    visible,
    files.baseChoice,
    files.refreshNonce
  )
  const gh = useWorkbenchGithub(visible, treeRoot, session, onReturnFocus, reread)

  const addressRef = useRef<HTMLInputElement>(null)
  const els = useRef(new Map<string, GuestElement>())
  const bodies = useRef(new Map<string, HTMLElement>())
  // PLATFORM§9
  const mountOrder = useRef<string[]>([])
  const [everLive, setEverLive] = useState<ReadonlySet<string>>(() => new Set())
  const [visited, setVisited] = useState<string[]>([])

  const statesRef = useRef(states)
  statesRef.current = states
  const set = (ownerTab && states[ownerTab]) || NO_TABS
  const activeTab = set.tabs.find((t) => t.id === set.activeId) ?? null
  const activeKind = activeTab?.kind ?? 'files'
  const activeRuntime = activeTab ? (runtime[activeTab.id] ?? BLANK_RUNTIME) : BLANK_RUNTIME
  const activeCaps = (activeTab && caps[activeTab.id]) || NO_CAPS
  const editProbe = useEditProbe(activeKind === 'file' ? (activeTab?.path ?? null) : null)
  const sessionCold = !!ownerTab && !liveTabs.has(ownerTab)
  const liveTabsRef = useRef(liveTabs)
  liveTabsRef.current = liveTabs

  const webIndex = useMemo(() => {
    const index = new Map<string, { owner: string; tab: WorkbenchTab }>()
    for (const [owner, s] of Object.entries(states)) {
      for (const tab of s.tabs) if (tab.kind === 'web') index.set(tab.id, { owner, tab })
    }
    return index
  }, [states])
  const webIndexRef = useRef(webIndex)
  webIndexRef.current = webIndex

  const patchRuntime = useCallback((id: string, patch: Partial<TabRuntime>): void => {
    setRuntime((prev) => ({ ...prev, [id]: { ...BLANK_RUNTIME, ...prev[id], ...patch } }))
  }, [])

  const guestIdOf = useCallback((id: string): number => guestId(els.current.get(id)), [])

  const ownerOfGuest = useCallback((gid: number): string | undefined => {
    for (const [tabId, el] of els.current) {
      if (guestId(el) === gid) return webIndexRef.current.get(tabId)?.owner
    }
    return undefined
  }, [])

  const pinnedIds = useMemo(() => new Set(Object.values(pinned).flat()), [pinned])
  const pinnedRef = useRef(pinnedIds)
  pinnedRef.current = pinnedIds
  const countedUrl = useRef(new Map<string, string>())
  const panelWorkspace = useStore((s) =>
    ownerTab ? workspaceOfTab(s.workspaceRows, s.sessions, ownerTab) : null
  )

  // PLATFORM§9
  const [staged, setStaged] = useState<ReadonlySet<string>>(() => new Set())
  const stage = useCallback((id: string): void => {
    setStaged((st) => (st.has(id) ? st : new Set(st).add(id)))
  }, [])
  const unstage = useCallback((id: string): void => {
    setStaged((st) => {
      if (!st.has(id)) return st
      const next = new Set(st)
      next.delete(id)
      return next
    })
  }, [])
  const prevPinned = useRef(pinnedIds)
  useEffect(() => {
    const was = prevPinned.current
    prevPinned.current = pinnedIds
    setStaged((st) => {
      const next = new Set([...st].filter((id) => !was.has(id) || pinnedIds.has(id)))
      return next.size === st.size ? st : next
    })
  }, [pinnedIds])

  const makeLive = useCallback((id: string): void => {
    setEverLive((ever) => (ever.has(id) ? ever : new Set(ever).add(id)))
    if (!mountOrder.current.includes(id)) mountOrder.current.push(id)
    setLive((prev) => {
      const next = prev.filter((x) => x !== id && webIndexRef.current.has(x))
      next.push(id)
      const limit = globalLiveGuestLimit()
      while (next.length > limit) {
        const victim = next.find((x) => x !== id && !pinnedRef.current.has(x))
        if (!victim) break
        next.splice(next.indexOf(victim), 1)
      }
      return next
    })
  }, [])

  const applyLiveIn = useCallback(
    (owner: string | null, id: string, url: string): void => {
      if (owner && !liveTabsRef.current.has(owner)) return
      if (els.current.has(id)) {
        patchRuntime(id, { fail: null, crashed: false })
        // PLATFORM§8
        void els.current
          .get(id)
          ?.loadURL(url)
          .catch(() => {})
      } else {
        patchRuntime(id, { fail: null, crashed: false, pendingUrl: url })
        makeLive(id)
      }
    },
    [makeLive, patchRuntime]
  )

  const applyLive = useCallback(
    (id: string, url: string): void => applyLiveIn(ownerTab ?? '', id, url),
    [applyLiveIn, ownerTab]
  )

  const focusAddress = useCallback((): void => {
    addressRef.current?.focus()
    addressRef.current?.select()
  }, [])

  const [addressFocusFor, setAddressFocusFor] = useState<string | null>(null)

  useLayoutEffect(() => {
    if (!addressFocusFor) return
    if (activeKind !== 'web' || set.activeId !== addressFocusFor) return
    focusAddress()
    setAddressFocusFor(null)
  }, [addressFocusFor, activeKind, set.activeId, focusAddress])

  // PLATFORM§10
  const keepCaret = useCallback((): (() => void) => {
    const had = !!rootRef.current?.contains(document.activeElement)
    return () => {
      if (had) rootRef.current?.focus()
    }
  }, [])

  const activate = useCallback(
    (id: string): void => {
      if (!ownerTab) return
      const shown = statesRef.current[ownerTab] ?? NO_TABS
      const restore = id === shown.activeId ? () => {} : keepCaret()
      onUpdate(ownerTab, (prev) => activateTab(prev, id))
      restore()
      const tab = shown.tabs.find((t) => t.id === id)
      if (!tab) return
      if (tab.kind === 'file') {
        setVisited((prev) => (prev.includes(id) ? prev : [...prev, id]))
        return
      }
      if (tab.kind !== 'web') return
      if (sessionCold) return
      if (tab.url && !els.current.has(id)) applyLive(id, tab.url)
      else makeLive(id)
    },
    [ownerTab, sessionCold, onUpdate, applyLive, makeLive, keepCaret]
  )

  const closeNow = useCallback(
    (id: string): void => {
      if (!ownerTab || id === FILES_TAB_ID) return
      endEdit(ownerTab, id)
      setEditing((prev) => (id in prev ? { ...prev, [id]: false } : prev))
      const box: { before: WorkbenchTabSet | null; after: WorkbenchTabSet | null } = {
        before: null,
        after: null
      }
      const restore = keepCaret()
      onUpdate(ownerTab, (prev) => {
        box.before = prev
        box.after = closeTab(prev, id)
        return box.after
      })
      restore()
      const before = box.before as WorkbenchTabSet | null
      const after = box.after as WorkbenchTabSet | null
      if (!before || !after) return
      const promoted =
        after.activeId !== before.activeId ? after.tabs.find((t) => t.id === after.activeId) : null
      if (promoted?.kind === 'file') {
        setVisited((prev) => (prev.includes(promoted.id) ? prev : [...prev, promoted.id]))
      } else if (promoted?.kind === 'web' && promoted.url && !sessionCold) {
        if (els.current.has(promoted.id)) makeLive(promoted.id)
        else if (visible) applyLive(promoted.id, promoted.url)
      }
      // PLATFORM§8
      if (id === before.activeId) setPageFullscreen(false)
      setLive((prev) => prev.filter((x) => x !== id))
      unstage(id)
      setVisited((prev) => prev.filter((x) => x !== id))
    },
    [ownerTab, sessionCold, visible, onUpdate, applyLive, makeLive, keepCaret, unstage]
  )

  const close = useCallback(
    (id: string): void => {
      if (!ownerTab || id === FILES_TAB_ID) return
      if (statesRef.current[ownerTab]?.tabs.find((t) => t.id === id)?.kind === 'terminal') {
        useStore.getState().closeTerminalTab(id)
        closeNow(id)
        return
      }
      const entry = getEntry(ownerTab, id)
      if (!entry || !isTabDirty(ownerTab, id)) {
        closeNow(id)
        return
      }
      const sid = ownerTab
      const done = useStore.getState().setUnsavedPrompt
      done({
        files: [relOf(entry.path, treeRoot)],
        onCancel: () => done(null),
        onDiscard: () => {
          done(null)
          discardTab(sid, id)
          closeNow(id)
        },
        onSave: async () => {
          const r = await saveTab(sid, id)
          done(null)
          if (r === 'stale' || r === 'failed') {
            activate(id)
            useStore
              .getState()
              .showToast(
                r === 'stale'
                  ? 'Not saved — this file changed on disk. The tab shows the difference.'
                  : (getEntry(sid, id)?.error ?? 'Could not save this file.')
              )
            return
          }
          closeNow(id)
          refreshFiles()
        }
      })
    },
    [ownerTab, treeRoot, closeNow, activate, refreshFiles]
  )

  const closeIn = useCallback(
    (owner: string, id: string): void => {
      if (owner === ownerTab) close(id)
      else onUpdate(owner, (prev) => closeTab(prev, id))
    },
    [ownerTab, close, onUpdate]
  )

  useStripReport(states, live, attached, guestIdOf)
  const { waitGuestId, onAttached, settled, mounting } = useCdpOps({
    els,
    webIndexRef,
    pinnedRef,
    stage,
    unstage,
    applyLiveIn,
    makeLive,
    setLive,
    cdpOps,
    tabForSession,
    onCdpCreate,
    onCdpDone,
    closeIn
  })

  const enterEdit = useCallback(
    (tabId: string, path: string, created?: EditFingerprint): void => {
      if (!ownerTab) return
      const sid = ownerTab
      const arm = (): void => {
        setEditing((prev) => ({ ...prev, [tabId]: true }))
        setEditFocus((prev) => ({ ...prev, [tabId]: (prev[tabId] ?? 0) + 1 }))
      }
      if (created) {
        beginEdit(sid, tabId, { path, text: '', eol: 'lf', stamp: created, readOnly: null })
        arm()
        return
      }
      const open = getEntry(sid, tabId)
      if (open && open.path === path && isTabDirty(sid, tabId)) {
        arm()
        return
      }
      void window.api.edit
        .open(path)
        .then((r) => {
          const now = statesRef.current[sid]?.tabs.find((t) => t.id === tabId)
          if (!now || now.path !== path) return
          if (isTabDirty(sid, tabId)) {
            arm()
            return
          }
          beginEdit(sid, tabId, {
            path,
            text: r.text,
            eol: r.eol,
            stamp: { mtimeMs: r.mtimeMs, size: r.size },
            readOnly: r.readOnly
          })
          arm()
        })
        .catch((err: unknown) => {
          useStore.getState().showToast(editRefusal(String((err as Error)?.message ?? '')))
        })
    },
    [ownerTab]
  )

  const exitEdit = useCallback(
    (tabId: string): void => {
      if (!ownerTab) return
      setEditing((prev) => ({ ...prev, [tabId]: false }))
      if (!isTabDirty(ownerTab, tabId)) endEdit(ownerTab, tabId)
    },
    [ownerTab]
  )

  useEffect(() => {
    setEditingActive(!!(visible && activeTab && editing[activeTab.id]))
  }, [visible, activeTab, editing])

  const openHere = useCallback(
    (opts: Parameters<typeof openTab>[1], then?: (r: OpenTabResult) => void): void => {
      if (!ownerTab) return
      const box: { r: OpenTabResult | null } = { r: null }
      onUpdate(
        ownerTab,
        (prev) => {
          box.r = openTab(prev, { ...opts, isDirty: (id) => isTabDirty(ownerTab, id) })
          return box.r.set
        },
        () => {
          const r = box.r as OpenTabResult
          if (r.evicted) onEvicted(r.evicted, r.set)
          if (r.refused) useStore.getState().showToast('All tabs have unsaved changes')
          else then?.(r)
        }
      )
    },
    [ownerTab, onUpdate, onEvicted]
  )

  const openForEdit = useCallback(
    (path: string, created?: EditFingerprint): void => {
      openHere({ kind: 'file', path, source: 'user' }, (r) => {
        setVisited((prev) => (prev.includes(r.tabId) ? prev : [...prev, r.tabId]))
        enterEdit(r.tabId, path, created)
      })
    },
    [openHere, enterEdit]
  )

  const newWebTab = useCallback((): void => {
    openHere({ kind: 'web', url: '', source: 'user' }, (r) => setAddressFocusFor(r.tabId))
  }, [openHere])

  const newTerminal = useCallback((): void => {
    if (!ownerTab || sessionCold) return
    useStore.getState().openTerminalTab(ownerTab)
  }, [ownerTab, sessionCold])

  const openFilePicker = useCallback((): void => {
    void window.api.preview.openFileDialog().then((picked) => {
      if (!picked) return
      if (isWebPagePath(picked)) {
        const decision = routeFor(picked, 'user')
        if (decision.dest !== 'browser') return
        openHere({ kind: 'web', url: decision.target, source: 'user' }, (r) =>
          applyLive(r.tabId, decision.target)
        )
        return
      }
      openHere({ kind: 'file', path: picked, source: 'user' }, (r) =>
        setVisited((prev) => (prev.includes(r.tabId) ? prev : [...prev, r.tabId]))
      )
    })
  }, [openHere, applyLive])

  const submitAddress = useCallback(
    (raw: string): void => {
      if (!ownerTab) return
      const entry = raw.trim()
      const decision = routeFor(
        entry.startsWith('~/') ? window.api.home + entry.slice(1) : entry,
        'address'
      )
      if (decision.dest === 'preview') {
        openHere({ kind: 'file', path: decision.target, source: 'user' }, (r) =>
          setVisited((prev) => (prev.includes(r.tabId) ? prev : [...prev, r.tabId]))
        )
        return
      }
      if (decision.dest !== 'browser') return
      const url = decision.target
      if (!activeTab || activeTab.kind !== 'web') {
        openHere({ kind: 'web', url, source: 'user' }, (r) => applyLive(r.tabId, url))
        return
      }
      onUpdate(ownerTab, (prev) => navigateTab(prev, activeTab.id, url))
      applyLive(activeTab.id, url)
    },
    [ownerTab, activeTab, onUpdate, openHere, applyLive]
  )

  const guestOf = (id: string | undefined): GuestElement | undefined =>
    id ? els.current.get(id) : undefined

  const reload = useCallback((): void => {
    if (!activeTab) return
    if (editing[activeTab.id]) return
    if (activeTab.kind === 'file') {
      setReloadNonce((prev) => ({ ...prev, [activeTab.id]: (prev[activeTab.id] ?? 0) + 1 }))
      return
    }
    if (activeTab.kind !== 'web') return
    const el = guestOf(activeTab.id)
    if (el) el.reload()
    else if (activeTab.url) applyLive(activeTab.id, activeTab.url)
  }, [activeTab, editing, applyLive])

  const zoomTo = useCallback(
    (pick: (current: number) => number): void => {
      if (!activeTab) return
      const el = guestOf(activeTab.id)
      if (!el) return
      const next = pick(runtime[activeTab.id]?.zoom ?? 1)
      el.setZoomFactor(next)
      patchRuntime(activeTab.id, { zoom: next })
    },
    [activeTab, runtime, patchRuntime]
  )

  const rootRef = useRef<HTMLDivElement>(null)

  const seenPanelFocus = useRef(0)
  useEffect(() => {
    if (panelFocus === seenPanelFocus.current) return
    seenPanelFocus.current = panelFocus
    if (activeKind === 'terminal') {
      if (set.activeId) useStore.getState().focusPanelTerm(set.activeId)
      return undefined
    }
    const raf = requestAnimationFrame(() => {
      const guest = activeKind === 'web' ? guestOf(set.activeId) : undefined
      if (guest) guest.focus()
      else rootRef.current?.focus()
    })
    return () => cancelAnimationFrame(raf)
  }, [panelFocus])

  const closeFind = useCallback((): void => {
    setFindOpen(false)
    for (const el of els.current.values()) {
      try {
        el.stopFindInPage('clearSelection')
      } catch {}
    }
  }, [])

  const openFind = useCallback((): void => {
    if (activeTab && editing[activeTab.id]) return
    if (activeKind === 'terminal') return
    if (activeKind === 'web') {
      setFindOpen(true)
      setFindFocusTick((t) => t + 1)
      return
    }
    if (activeKind === 'files') {
      setFindOpen(true)
      setFindFocusTick((t) => t + 1)
      return
    }
    if (!activeCaps.canFind) return
    setFindOpen(true)
    setFindFocusTick((t) => t + 1)
  }, [activeKind, activeTab, editing, activeCaps.canFind])

  const saveActive = useCallback((): void => {
    if (!ownerTab || !activeTab) return
    const sid = ownerTab
    const id = activeTab.id
    void saveTab(sid, id).then((r) => {
      if (r !== 'saved') return
      refreshFiles()
      if (!editing[id]) endEdit(sid, id)
    })
  }, [ownerTab, activeTab, editing, refreshFiles])

  const escape = useCallback((): void => {
    if (zoom) {
      setZoom(null)
      return
    }
    if (findOpen) {
      closeFind()
      rootRef.current?.focus()
      return
    }
    const anyMenu =
      menuOpen ||
      dlOpen ||
      newMenuOpen ||
      ghMenu ||
      !!files.menu ||
      files.outlineOpen ||
      (!!activeTab && !!outlineOpen[activeTab.id])
    if (anyMenu) {
      setMenuOpen(false)
      setDlOpen(false)
      setNewMenuOpen(false)
      setGhMenu(false)
      files.setMenu(null)
      files.setOutlineOpen(false)
      if (activeTab) setOutlineOpen((prev) => ({ ...prev, [activeTab.id]: false }))
      rootRef.current?.focus()
      return
    }
    if (files.searchOpen) {
      const inSearchRow = !!document.activeElement?.closest?.('.ft-search')
      if (!inSearchRow) files.toggleSearch()
      rootRef.current?.focus()
      return
    }
    onEscapeFellThrough()
  }, [
    zoom,
    findOpen,
    closeFind,
    menuOpen,
    dlOpen,
    newMenuOpen,
    ghMenu,
    files,
    activeTab,
    outlineOpen,
    onEscapeFellThrough
  ])

  const lastCommand = useRef(command && !PREARMED_COMMANDS.has(command.id) ? command.nonce : 0)
  useEffect(() => {
    if (!command || command.nonce === lastCommand.current) return
    lastCommand.current = command.nonce
    const el = guestOf(activeTab?.id)
    switch (command.id) {
      case 'browser-new-tab':
        if (activeKind === 'web') newWebTab()
        else if (activeKind === 'file') openFilePicker()
        else if (activeKind === 'terminal') newTerminal()
        else setNewMenuOpen(true)
        break
      case 'browser-close-tab':
        if (activeTab) close(activeTab.id)
        break
      case 'browser-focus-address':
        if (activeKind === 'web') focusAddress()
        break
      case 'browser-reload':
        reload()
        break
      case 'browser-back':
        el?.goBack()
        break
      case 'browser-forward':
        el?.goForward()
        break
      case 'browser-zoom-in':
        zoomTo((z) => ZOOM_STEPS.find((s) => s > z + 0.001) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1])
        break
      case 'browser-zoom-out':
        zoomTo((z) => [...ZOOM_STEPS].reverse().find((s) => s < z - 0.001) ?? ZOOM_STEPS[0])
        break
      case 'browser-zoom-reset':
        zoomTo(() => 1)
        break
      case 'save':
        saveActive()
        break
      case 'find':
        openFind()
        break
      case 'find-files':
        if (set.activeId !== FILES_TAB_ID) activate(FILES_TAB_ID)
        files.toggleSearch()
        break
      case 'cycle-next':
      case 'cycle-prev': {
        const next = cycleTab(set, command.id === 'cycle-next' ? 1 : -1)
        if (next.activeId !== set.activeId) activate(next.activeId)
        break
      }
      case 'escape':
        escape()
        break
      case 'browser-devtools':
        {
          const id = guestId(el)
          // PLATFORM§8
          if (id) window.api.browser.toggleDevTools(id)
        }
        break
    }
  }, [
    command,
    activeTab,
    activeKind,
    ownerTab,
    set,
    newWebTab,
    newTerminal,
    openFilePicker,
    close,
    focusAddress,
    reload,
    zoomTo,
    openFind,
    saveActive,
    escape,
    activate,
    files,
    onUpdate
  ])

  const prepared = useRef<{ owner: string; id: string } | null>(null)
  useEffect(() => {
    const seen = prepared.current
    if (!ownerTab) return
    prepared.current = { owner: ownerTab, id: set.activeId }
    if (!seen || seen.owner !== ownerTab || seen.id === set.activeId) return
    if (set.tabs.some((t) => t.id === seen.id)) return
    activate(set.activeId)
    // PLATFORM§10
    if (document.activeElement === document.body) rootRef.current?.focus()
  }, [set.activeId, ownerTab, activate])

  const lastLoad = useRef<Record<string, number>>({})
  useEffect(() => {
    if (!load || !ownerTab || load.nonce === lastLoad.current[ownerTab]) return
    lastLoad.current[ownerTab] = load.nonce
    activate(load.tabId)
  }, [load, ownerTab, activate])

  const cancelPermissions = perms.cancelAll
  const cancelPrompts = useCallback((): void => {
    cancelPermissions()
    setDlOpen(false)
    setMenuOpen(false)
    setNewMenuOpen(false)
    setGhMenu(false)
  }, [cancelPermissions])

  const resetOwner = useRef(ownerTab)
  useEffect(() => {
    if (resetOwner.current === ownerTab) return
    resetOwner.current = ownerTab
    cancelPrompts()
    // PLATFORM§8
    setPageFullscreen(false)
    setZoom(null)
  }, [ownerTab, cancelPrompts])

  useEffect(() => {
    if (!sessionCold) return
    cancelPrompts()
    setPageFullscreen(false)
    if (dialog && !dialogHasLiveOwner(dialog, ownerOfGuest, liveTabs)) {
      onDialogAnswer(dialog.id, { ok: false })
    }
  }, [sessionCold, cancelPrompts])

  useEffect(() => {
    return window.api.browser.onFullscreen((on) => setPageFullscreen(on))
  }, [])

  useEffect(() => {
    if (!pageFullscreen) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      const el = activeTab ? els.current.get(activeTab.id) : null
      el?.executeJavaScript('document.exitFullscreen?.()').catch(() => {})
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [pageFullscreen, activeTab])

  useEffect(() => {
    return window.api.browser.onAudioState((state) => {
      const entry = [...els.current].find(([, el]) => guestId(el) === state.guestId)
      if (!entry) return
      setAudio((prev) => ({
        ...prev,
        [entry[0]]: { audible: state.audible, muted: state.muted }
      }))
    })
  }, [])

  const toggleMute = useCallback((tabId: string) => {
    const id = guestId(els.current.get(tabId))
    if (!id) return
    setAudio((prev) => {
      const next = !prev[tabId]?.muted
      window.api.browser.setMuted(id, next)
      return { ...prev, [tabId]: { audible: prev[tabId]?.audible ?? false, muted: next } }
    })
  }, [])

  const moveTabTo = useCallback(
    (id: string, to: number) => {
      if (!ownerTab) return
      onUpdate(ownerTab, (prev) => {
        const from = prev.tabs.findIndex((t) => t.id === id)
        const target = from >= 0 && from < to ? to - 1 : to
        return moveTab(prev, id, target)
      })
    },
    [ownerTab, onUpdate]
  )

  useEffect(() => {
    mountOrder.current = mountOrder.current.filter((id) => webIndex.has(id) || mounting(id))
  }, [webIndex])

  useEffect(() => {
    setLive((prev) => {
      const next = prev.filter((id) => {
        const owner = webIndexRef.current.get(id)?.owner
        if (!owner || !liveTabs.has(owner)) {
          return mounting(id)
        }
        return true
      })
      return next.length === prev.length ? prev : next
    })
  }, [liveTabs])

  useEffect(() => {
    for (const t of allEditTabs()) {
      const own = states[t.ownerTabId]
      if (own && !own.tabs.some((x) => x.id === t.tabId)) endEdit(t.ownerTabId, t.tabId)
    }
    const ids = new Set<string>()
    for (const s of Object.values(states)) for (const t of s.tabs) ids.add(t.id)
    const held = new Set(allEditTabs().map((t) => t.tabId))
    const alive = (id: string): boolean => ids.has(id) || held.has(id)
    setVisited((prev) => {
      const next = prev.filter(alive)
      return next.length === prev.length ? prev : next
    })
    const prune = <T,>(prev: Record<string, T>): Record<string, T> => {
      const keys = Object.keys(prev)
      if (keys.every((k) => ids.has(k))) return prev
      return Object.fromEntries(keys.filter((k) => ids.has(k)).map((k) => [k, prev[k]]))
    }
    const pruneEdit = <T,>(prev: Record<string, T>): Record<string, T> => {
      const keys = Object.keys(prev)
      if (keys.every(alive)) return prev
      return Object.fromEntries(keys.filter(alive).map((k) => [k, prev[k]]))
    }
    setCaps(prune)
    setOutlineOpen(prune)
    setReloadNonce(prune)
    setEditing(pruneEdit)
    setEditFocus(pruneEdit)
  }, [states])

  const openDedupedIntoShownTabNonce = load?.nonce
  useEffect(() => {
    const el = guestOf(activeTab?.id)
    const url = activeTab?.url ?? ''
    const report = (): boolean => {
      const id = guestId(el)
      window.api.extensions.activeGuest(id, url)
      // PLATFORM§8
      return id > 0 || !el
    }
    if (report()) return
    let tries = 0
    const timer = setInterval(() => {
      if (report() || ++tries >= CDP_GUEST_ID_RETRIES) clearInterval(timer)
    }, CDP_GUEST_ID_RETRY_MS)
    return () => clearInterval(timer)
  }, [ownerTab, activeTab?.id, activeTab?.url, live, attached, openDedupedIntoShownTabNonce])

  useEffect(() => {
    closeFind()
  }, [activeTab?.id, ownerTab])

  useWatchlessRefresh(
    watchDead && visible,
    session?.updatedAt,
    WATCHLESS_REFRESH_THROTTLE_MS,
    reread
  )

  const reportCaps = useCallback((tabId: string, next: ArtifactCaps): void => {
    setCaps((prev) => (sameCaps(prev[tabId] ?? NO_CAPS, next) ? prev : { ...prev, [tabId]: next }))
  }, [])
  const reportBody = useCallback((tabId: string, el: HTMLElement | null): void => {
    if (el) bodies.current.set(tabId, el)
    else bodies.current.delete(tabId)
  }, [])
  const reportFilesBody = useCallback(
    (el: HTMLElement | null): void => reportBody(FILES_TAB_ID, el),
    [reportBody]
  )
  const openWebFromFiles = useCallback(
    (path: string): void => {
      const decision = routeFor(path, 'user')
      if (decision.dest !== 'browser') return
      openHere(
        {
          kind: 'web',
          url: decision.target,
          source: 'user',
          sourceTabId: FILES_TAB_ID,
          sourcePath: path
        },
        (r) => applyLive(r.tabId, decision.target)
      )
    },
    [openHere, applyLive]
  )
  const splitToFileTab = useCallback(
    (path: string, view: ArtifactView, scrollTop: number): void => {
      openHere({ kind: 'file', path, source: 'user', view, scrollTop }, (r) =>
        setVisited((prev) => (prev.includes(r.tabId) ? prev : [...prev, r.tabId]))
      )
    },
    [openHere]
  )
  const outlineBtnRef = useRef<HTMLButtonElement>(null)
  const closeOutline = useCallback((tabId: string): void => {
    setOutlineOpen((prev) => ({ ...prev, [tabId]: false }))
    outlineBtnRef.current?.focus()
  }, [])
  const toggleOutline = useCallback((tabId: string): void => {
    setOutlineOpen((prev) => ({ ...prev, [tabId]: !prev[tabId] }))
  }, [])
  const closeZoom = useCallback((): void => setZoom(null), [])
  const keepScrollTop = useCallback(
    (tabId: string, scrollTop: number): void => {
      const owner = Object.keys(statesRef.current).find((o) =>
        statesRef.current[o].tabs.some((t) => t.id === tabId)
      )
      if (owner) onUpdate(owner, (prev) => setTabScrollTop(prev, tabId, scrollTop))
    },
    [onUpdate]
  )
  const retarget = useCallback(
    (tabId: string, path: string, line?: number): void => {
      if (!ownerTab) return
      const sid = ownerTab
      const box: { r: ReturnType<typeof retargetOrOpenTab> | null } = { r: null }
      onUpdate(sid, (prev) => {
        box.r = retargetOrOpenTab(prev, tabId, path, line, (id) => isTabDirty(sid, id))
        return box.r.set
      })
      const r = box.r as ReturnType<typeof retargetOrOpenTab> | null
      if (!r) return
      if (r.refused) {
        useStore.getState().showToast('All tabs have unsaved changes')
        return
      }
      if (r.tabId !== tabId)
        setVisited((prev) => (prev.includes(r.tabId) ? prev : [...prev, r.tabId]))
    },
    [ownerTab, onUpdate]
  )
  const setActiveView = useCallback(
    (tabId: string, view: ArtifactView): void => {
      if (ownerTab) onUpdate(ownerTab, (prev) => setTabView(prev, tabId, view))
    },
    [ownerTab, onUpdate]
  )

  const latest = useRef({ onUpdate, runtime, closeIn })
  latest.current = { onUpdate, runtime, closeIn }
  const guestEvents = useMemo<GuestEvents>(() => {
    const elOf = (tabId: string): GuestElement | undefined => els.current.get(tabId)
    const recordVisit = (owner: string, tabId: string, url: string): void => {
      if (pinnedRef.current.has(tabId)) return
      const key = historyKey(url)
      if (countedUrl.current.get(tabId) === key) return
      countedUrl.current.set(tabId, key)
      const { workspaceRows, sessions } = useStore.getState()
      const ws = workspaceOfTab(workspaceRows, sessions, owner) ?? undefined
      saveHistory(remember(loadHistory(), url, '', ws))
    }
    return {
      element: (_owner, tabId, el) => {
        if (el) {
          els.current.set(tabId, el)
          return
        }
        els.current.delete(tabId)
        countedUrl.current.delete(tabId)
        setAudio((prev) => {
          if (!(tabId in prev)) return prev
          const rest = { ...prev }
          delete rest[tabId]
          return rest
        })
      },
      attached: (owner, tabId) => {
        waitGuestId(tabId).then(
          (gid) => window.api.browser.setGuestOwner(gid, owner),
          () => {}
        )
        setAttached((n) => n + 1)
        onAttached(tabId)
      },
      loading: (_owner, tabId, loading) => {
        patchRuntime(tabId, { loading, ...guestHistory(elOf(tabId)) })
        if (loading) return
        let evidence = { guestUrl: '', targetUrl: '', isLoading: false }
        try {
          const el = elOf(tabId)
          evidence = {
            guestUrl: el?.getURL() ?? '',
            targetUrl:
              latest.current.runtime[tabId]?.pendingUrl ||
              webIndexRef.current.get(tabId)?.tab.url ||
              '',
            isLoading: el?.isLoading() ?? false
          }
        } catch {
          return
        }
        if (stopEndsMount(evidence)) settled(tabId)
      },
      navigate: (owner, tabId, url) => {
        patchRuntime(tabId, {
          pendingUrl: '',
          fail: null,
          crashed: false,
          ...guestHistory(elOf(tabId))
        })
        latest.current.onUpdate(owner, (prev) => navigateTab(prev, tabId, url))
        recordVisit(owner, tabId, url)
      },
      title: (owner, tabId, title) => {
        latest.current.onUpdate(owner, (prev) => retitleTab(prev, tabId, title))
        const url = guestUrl(elOf(tabId))
        if (url && !pinnedRef.current.has(tabId)) saveHistory(remember(loadHistory(), url, title))
      },
      fail: (_owner, tabId, fail) => {
        patchRuntime(tabId, { fail, loading: false })
        settled(tabId)
      },
      crash: (_owner, tabId) => patchRuntime(tabId, { crashed: true, loading: false }),
      close: (owner, tabId) => latest.current.closeIn(owner, tabId)
    }
  }, [patchRuntime, waitGuestId, onAttached, settled])

  const mountedWebTabs = mountOrder.current
    .filter((id) => live.includes(id))
    .map((id) => webIndex.get(id))
    .filter((hit): hit is { owner: string; tab: WorkbenchTab } => !!hit)

  // ADR-0016
  const fileTabs = set.tabs.filter((t) => t.kind === 'file' && visited.includes(t.id))

  const termTabs = useMemo(() => {
    const out: { owner: string; tab: WorkbenchTab }[] = []
    for (const [owner, st] of Object.entries(states)) {
      if (!liveTabs.has(owner)) continue
      for (const t of st.tabs) if (t.kind === 'terminal') out.push({ owner, tab: t })
    }
    return out
  }, [states, liveTabs])
  const changedCount = Object.keys(git).length
  const totals = useChangeTotals(git, numstat, treeRoot, base)
  const backlink =
    activeTab?.sourceTabId && set.tabs.some((t) => t.id === activeTab.sourceTabId)
      ? activeTab.sourceTabId
      : null
  const dirtyIds = useMemo(
    () => new Set(ownerTab ? dirtyTabsOf(ownerTab).map((d) => d.tabId) : []),
    [ownerTab, editTick]
  )

  const openGithub = useCallback(
    (what: GithubTarget): void => {
      if (!treeRoot) return
      void window.api.github.target(treeRoot, what).then((url) => {
        if (!url) return
        openHere({ kind: 'web', url, source: 'user' }, (r) => {
          if (r.created || !els.current.has(r.tabId)) applyLive(r.tabId, url)
        })
      })
    },
    [treeRoot, openHere, applyLive]
  )
  const openGithubFromButton = useCallback(
    (what: GithubTarget): void => {
      setNewMenuOpen(false)
      setGhMenu(false)
      openGithub(what)
    },
    [openGithub]
  )
  const refreshChecks = gh.refreshChecks
  const openGithubMenu = useCallback((): void => {
    setNewMenuOpen(false)
    setDlOpen(false)
    setGhMenu(true)
    refreshChecks()
  }, [refreshChecks])
  const toggleNewMenu = useCallback((): void => {
    setMenuOpen(false)
    setDlOpen(false)
    setGhMenu(false)
    setNewMenuOpen((v) => !v)
  }, [])

  const fullBtn = <FullWidthButton full={full} onToggle={onToggleFull} />
  const ghInfo = gh.info

  return (
    <div
      ref={rootRef}
      className={'wb-panel' + (full ? ' full' : '') + (pageFullscreen ? ' pagefull' : '')}
      data-surface={visible ? 'workbench' : undefined}
      data-kind={activeKind}
      tabIndex={-1}
      /* PLATFORM§9 */
      style={{ visibility: visible || staged.size > 0 ? undefined : 'hidden' }}
    >
      <WorkbenchTabStrip
        set={set}
        live={live}
        everLive={everLive}
        pinnedIds={pinnedIds}
        dirtyIds={dirtyIds}
        audio={audio}
        totals={totals}
        driving={!!session?.sessionId && (pinned[session.sessionId]?.length ?? 0) > 0}
        github={ghInfo}
        githubDot={gh.dot}
        githubLabel={gh.label}
        onGithubOpen={openGithubFromButton}
        onGithubMenu={openGithubMenu}
        onActivate={activate}
        onClose={close}
        onToggleMute={toggleMute}
        onMove={moveTabTo}
        onNewMenu={toggleNewMenu}
      />

      {ghMenu && ghInfo && (
        <GithubMenu
          gh={gh}
          info={ghInfo}
          treeRoot={treeRoot}
          onClose={() => setGhMenu(false)}
          onOpen={openGithub}
          onCommit={() => setCommitOpen(true)}
        />
      )}

      {commitOpen && treeRoot && (
        <CommitDialog
          branch={ghInfo?.branch ?? null}
          onCancel={() => setCommitOpen(false)}
          onCommit={async (message) => {
            const ok = await gh.gitStep(window.api.github.commit(treeRoot, message), 'Committed.')
            if (ok) setCommitOpen(false)
            return ok
          }}
        />
      )}

      {newMenuOpen && (
        <NewTabMenu
          canTerminal={!sessionCold}
          onClose={() => setNewMenuOpen(false)}
          onWeb={newWebTab}
          onFile={openFilePicker}
          onTerminal={newTerminal}
        />
      )}

      {activeKind === 'web' ? (
        <BrowserAddressBar
          url={activeTab?.url ?? ''}
          workspace={panelWorkspace}
          loading={activeRuntime.loading}
          canBack={activeRuntime.canBack}
          canForward={activeRuntime.canForward}
          inputRef={addressRef}
          onSubmit={submitAddress}
          onBack={() => guestOf(activeTab?.id)?.goBack()}
          onForward={() => guestOf(activeTab?.id)?.goForward()}
          onReload={reload}
          onStop={() => guestOf(activeTab?.id)?.stop()}
          onExternalOpen={() => {
            if (activeTab?.url) onExternalOpen(activeTab.url)
          }}
          actions={
            <>
              {backlink && (
                <div className="seg wb-backlink">
                  <button
                    title="Back to source"
                    onClick={() => {
                      activate(backlink)
                      const from = activeTab?.sourcePath
                      if (backlink === FILES_TAB_ID && from) {
                        files.scrollToFile(relOf(from, treeRoot))
                      }
                    }}
                  >
                    ← Back to source
                  </button>
                </div>
              )}
              <BrowserActions />
              {hasDownloads(downloads) && (
                <button
                  className="bnav"
                  data-panel-toggle="downloads"
                  aria-label="Downloads"
                  title="Downloads"
                  onClick={() => {
                    setMenuOpen(false)
                    setDlOpen((v) => !v)
                  }}
                >
                  <IconDownload size={16} />
                </button>
              )}
            </>
          }
          overflow={
            <>
              <button
                className="bnav"
                aria-label="More"
                title="More"
                onClick={() => {
                  setDlOpen(false)
                  setMenuOpen((v) => !v)
                }}
              >
                <IconMore size={16} />
              </button>
              {fullBtn}
            </>
          }
        />
      ) : activeKind === 'terminal' && activeTab ? (
        <div className="wb-bar">
          <span className="wb-title" title={activeTab.cwd ?? ''}>
            <span className="nm">{shortAuxCwd(activeTab.cwd ?? '')}</span>
          </span>
          {fullBtn}
        </div>
      ) : activeKind === 'file' && activeTab ? (
        <FileTabBar
          tabId={activeTab.id}
          path={activeTab.path ?? ''}
          treeRoot={treeRoot}
          status={git[activeTab.path ?? '']}
          added={numstat[activeTab.path ?? '']?.added ?? 0}
          removed={numstat[activeTab.path ?? '']?.removed ?? 0}
          caps={activeCaps}
          editing={!!editing[activeTab.id]}
          editProbe={editProbe}
          outlineOpen={!!outlineOpen[activeTab.id]}
          outlineBtnRef={outlineBtnRef}
          full={full}
          onToggleFull={onToggleFull}
          onView={setActiveView}
          onReload={reload}
          onEnterEdit={enterEdit}
          onExitEdit={exitEdit}
          onToggleOutline={toggleOutline}
        />
      ) : (
        <FilesBar c={files} changedCount={changedCount} full={full} onToggleFull={onToggleFull} />
      )}

      {dlOpen && (
        <BrowserDownloads
          list={downloads}
          onReveal={(path) => window.api.fs.reveal(path)}
          onCancel={(id) => window.api.browser.cancelDownload(id)}
          onRetry={(id) => window.api.browser.retryDownload(id)}
          onClear={clearFinished}
          onClose={() => setDlOpen(false)}
        />
      )}

      {menuOpen && <PageMoreMenu url={activeTab?.url} onClose={() => setMenuOpen(false)} />}

      <BrowserPermissionBar
        ask={perms.ask}
        refusal={perms.ask ? null : perms.refusal}
        onAnswer={perms.answer}
        onDismissRefusal={perms.dismissRefusal}
        onEscapeHatch={(origin) => {
          perms.dismissRefusal()
          onExternalOpen(activeTab?.url || origin)
        }}
      />

      <div className="wb-body">
        {/* PLATFORM§9 */}
        {mountedWebTabs.map(({ owner, tab }) => {
          const onScreen = visible && owner === ownerTab && tab.id === set.activeId && !sessionCold
          return (
            <WebGuestHost
              key={`${tab.id}:${runtime[tab.id]?.mountToken ?? 0}`}
              owner={owner}
              tabId={tab.id}
              url={runtime[tab.id]?.pendingUrl || tab.url || ''}
              /* PLATFORM§9 */
              visible={onScreen || staged.has(tab.id)}
              staged={staged.has(tab.id) && !onScreen}
              events={guestEvents}
            />
          )
        })}

        {/* PLATFORM§21 */}
        {termTabs.map(({ owner, tab }) => (
          <TerminalHost
            key={tab.id}
            id={tab.id}
            shown={owner === ownerTab && tab.id === set.activeId}
            focusSignal={termFocus.ptyId === tab.id ? termFocus.n : NO_FOCUS_SIGNAL}
          />
        ))}

        {ownerTab &&
          fileTabs.map((t) => {
            const unsaved = dirtyIds.has(t.id)
            const editingHere = !!editing[t.id] && !!getEntry(ownerTab, t.id)
            return (
              <FileTabHost
                key={t.id}
                ownerTab={ownerTab}
                tabId={t.id}
                path={t.path ?? ''}
                view={t.view}
                line={t.line}
                scrollTop={t.scrollTop}
                shown={t.id === set.activeId}
                editing={editingHere}
                editFocus={editFocus[t.id] ?? 0}
                editText={unsaved && !editingHere ? getEntry(ownerTab, t.id)?.text : undefined}
                editUnsaved={unsaved}
                wsRoot={treeRoot}
                base={base}
                changed={!!(t.path && git[t.path])}
                reloadNonce={reloadNonce[t.id] ?? 0}
                outlineOpen={!!outlineOpen[t.id]}
                zoom={t.id === set.activeId ? zoom : null}
                onSaved={refreshFiles}
                onCaps={reportCaps}
                onNavigate={retarget}
                onBody={reportBody}
                onZoomImage={setZoom}
                onCloseZoom={closeZoom}
                onOutlineClose={closeOutline}
                onClose={close}
                onUnmount={keepScrollTop}
              />
            )
          })}

        <div
          className="wb-host"
          style={{ visibility: activeKind === 'files' ? undefined : 'hidden' }}
        >
          <FilesBody
            c={files}
            root={treeRoot}
            rootMissing={rootMissing}
            session={session}
            git={git}
            numstat={numstat}
            base={base}
            active={visible && activeKind === 'files'}
            onBody={reportFilesBody}
            onOpenWeb={openWebFromFiles}
            onSplit={splitToFileTab}
            onEdit={openForEdit}
            onZoomImage={setZoom}
            zoom={activeKind === 'files' ? zoom : null}
            onCloseZoom={closeZoom}
            onReturnFocus={onReturnFocus}
          />
        </div>

        {activeKind === 'web' && (
          <WebPageState
            tab={activeTab}
            runtime={activeRuntime}
            sessionCold={sessionCold}
            live={!!activeTab && live.includes(activeTab.id)}
            agentLabel={BACKEND_LABEL[ownerBackend]}
            onLoad={(t) => activate(t.id)}
            onReloadCrashed={(t) =>
              patchRuntime(t.id, {
                crashed: false,
                pendingUrl: t.url ?? '',
                mountToken: (runtime[t.id]?.mountToken ?? 0) + 1
              })
            }
            onCertProceed={(t, url) => {
              void Promise.resolve(onCertProceed(url)).then(() => {
                patchRuntime(t.id, { fail: null })
                applyLive(t.id, url)
              })
            }}
            onRetry={(t, url) => applyLive(t.id, url)}
          />
        )}
      </div>

      {findOpen && (
        <WorkbenchFind
          els={els}
          bodies={bodies}
          activeId={activeTab?.id}
          web={activeKind === 'web'}
          live={live}
          focusTick={findFocusTick}
          onClose={closeFind}
        />
      )}

      {dialog && <BrowserModal dialog={dialog} onAnswer={onDialogAnswer} />}
    </div>
  )
})
