import { NewSessionDialog } from './components/NewSessionDialog'
import { SessionBackendIcon } from './components/SessionBackendIcon'
import type { AgentChoice } from './agentChoice'
import type { SessionLaunchOptions } from './components/SessionLaunchButtons'
import { WelcomeLaunch } from './components/WelcomeLaunch'
import {
  backendAvailable,
  BACKEND_LABEL,
  byBackend,
  effectiveBackend,
  listedBackends,
  SESSION_BACKENDS
} from '@shared/sessionBackend'
import { hasWorkbench, isSessionKind, launchErrorMessage, type SessionBackend } from './agentUi'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type MouseEvent
} from 'react'
import { createPortal } from 'react-dom'
import { useShallow } from 'zustand/react/shallow'
import {
  IconAddProject,
  IconChevronRight,
  IconKeepAwake,
  IconNotifications,
  IconOpenedPage,
  IconSettings,
  IconSidebarLeft,
  IconSidebarRight,
  IconUpdate
} from './icons'
import type {
  BrowserAuthChallenge,
  BrowserCdpOp,
  BrowserDialogAnswer,
  BrowserJsDialog,
  ExtensionPermissionRequest,
  HostId,
  SessionRow,
  SessionSearchHit,
  WorkspaceRows
} from '@shared/types'
import { SIDEBAR_MIN } from '@shared/types'
import {
  useStore,
  openInterceptedFile,
  boundSessionId,
  workbenchOwnerLive,
  consumeRestartExit,
  keptTabsToClose,
  launchToStartAgain,
  conversationTabFor,
  tabForSession,
  consumeRestoreExit,
  tabEvictedNotice,
  panelTabId,
  panelIsOpen,
  noteWakingOutput,
  tabEverBound
} from './store'
import { WORKBENCH_PANE_MIN } from './auxSurface'
import {
  clampNotesHeight,
  currentWorkspace,
  rowIdOfTab,
  workspaceOfTab,
  DOCK_GUTTER_PX,
  liveTabOf,
  mixesBackends,
  notesHeightFromDrag,
  paneWidthFromDrag,
  PREVIEW_CARD_WIDTH_PX,
  previewCardFits,
  relTime,
  rowLookups,
  selectionRoot,
  sessionsNeedYou,
  waitingTabs,
  welcomeQuietLine,
  welcomeTarget
} from './sessionRows'
import { beginLayoutDrag, endLayoutDrag } from './resizeGate'
import { endedRowNote, unexpectedExitNotice, unexpectedExitWanted } from './closeSession'
import { lastLinesOnceWritten, writeOnScreen } from './terminalScreens'
import { requestCloseTab } from './closeFlow'
import {
  allDirty,
  askAboutLeftEdits,
  discardAll,
  flushNotes,
  labelPaths,
  saveAll,
  subscribeDirtyTabs,
  subscribeMenuFlags
} from './unsavedGuard'
import { browserOpenTargetSession, overlayPresentation } from './browserOpenTarget'

const FIXED_VIEWPORT_FOR_OFFSCREEN_DRIVEN_PAGE = { width: 1000, height: 700 }
const LAST_SCREEN_LINES_LOGGED = 20
import {
  rearmResume,
  releaseResume,
  resumeSession,
  RESTORE_FAILED_NOTICE,
  wakeTab
} from './resumeFlow'
import { openSessionRow, visitAndReveal, visitNextWaiting, visitTab } from './sessionClick'
import { adoptionIsSettled, adoptionSettled, markAdoptionSettled, preAdoptExits } from './adoption'
import { CloseSessionDialog } from './components/CloseSessionDialog'
import { UnsavedDialog } from './components/UnsavedDialog'
import { ResumeDialog } from './components/ResumeDialog'
import { basename } from '@shared/preview'
import { NOTES_TAB, notesOwner } from '@shared/cwdKey'
import { saveTab } from './editRegistry'
import { commandTarget } from '@shared/shortcutDispatch'
import { TerminalView } from './components/TerminalView'
import { repairAllWebgl, scheduleWebglRepair } from './webglRepair'
import { WorkspaceSidebar } from './components/WorkspaceSidebar'
import { NotesIsland } from './components/NotesIsland'
import { RenameButlerDialog, setUpDiscordWithButler } from './components/ButlerRow'
import { BindConductorDialog } from './components/BindConductorDialog'
import { everyWorkspaceRows, isButlerTab } from './butlerRows'
import { pickerRows, pullable, skipPicker, type PickerMode } from './workspacePicker'
import { RestoreDialog } from './components/RestoreDialog'
import { CronJobsDialog } from './components/CronJobsDialog'
import { RemoteWorkspaceDialog } from './components/RemoteWorkspaceDialog'
import { hostOf } from '@shared/remoteKey'
import { WorkbenchPane } from './components/WorkbenchPane'
import { WorkbenchPreview } from './components/WorkbenchPreview'
import type { WorkbenchCommandSignal } from './components/workbenchCommands'
import { ExtensionConfirm } from './components/ExtensionConfirm'
import { tabLabel, type WorkbenchTab, type WorkbenchTabSet } from './components/workbenchTabs'
import { SettingsModal } from './components/settings/SettingsModal'
import { loginClearDelay, savedClearDue } from './components/settings/loginFlow'
import { TopbarUsage } from './components/TopbarUsage'
import { WorldClock } from './components/WorldClock'
import { UpdateModal } from './components/UpdateModal'
import { AssistDialog } from './components/AssistDialog'
import { useAssistSetup } from './useAssistSetup'
import { useToolsChanged } from './useInstalledBackends'
import { Onboarding } from './components/Onboarding'
import { BrowserOverlay } from './components/BrowserOverlay'
import { Hint } from './components/Hint'
import { useHints } from './useHints'
import { updateSettings } from './components/settings/useSettingsUpdate'
import { CommandPalette, type PaletteRouted } from './components/CommandPalette'
import { NewProjectDialog, type ProjectSeed } from './components/NewProjectDialog'
import type { PendingStart, TypedStart } from './newSession'
import { pendingOptions, projectOptions, projectParentKey } from './aiStart'
import type { PaletteAction } from './palette'
import {
  PALETTE_FEATURES,
  type PaletteActionKey,
  type PaletteFeature
} from '@shared/paletteFeatures'
import { GLOBAL_SCOPE } from '@shared/conductors'

const RECENT_MAX = 3
const CENTER_TERMINAL_MAX_COLS = 140

const LAUNCH_REFUSED_NOTICE = 'Could not start the session — invalid launch arguments'

const NO_WORKSPACE_NOTICE = 'No workspace yet — add one first (⇧⌘O)'
const NO_GIT_NOTICE = 'no git repository among your workspaces — no worktrees here'

function relocatedNotice(dir: string): string {
  return `Workbench followed Claude to ${basename(dir)}`
}

function caretInShell(): boolean {
  return !!document.activeElement?.closest('.xterm')
}

function focusedWorkbench(): HTMLElement | null {
  return (document.activeElement?.closest('.wb-panel[data-surface]') as HTMLElement | null) ?? null
}

const NOTES_ISLAND = '.isl-notes'

function aDialogIsOpen(): boolean {
  return !!document.querySelector('.modal-backdrop, .bmodal-backdrop')
}

function caretInNote(): boolean {
  return !!document.activeElement?.matches(`${NOTES_ISLAND} .ed-area`)
}

// PLATFORM§10
let windowFocused = true
function guestHasCaret(): boolean {
  return windowFocused && document.activeElement?.tagName === 'WEBVIEW'
}

function panelActionTab(): string | undefined {
  const st = useStore.getState()
  const id = panelTabId(st)
  if (!id) return undefined
  const tab = st.tabs.find((t) => t.id === id)
  if (tab?.resuming) return undefined
  return boundSessionId(st, id) ? id : undefined
}

function terminalActionTab(): string | undefined {
  const id = panelActionTab()
  if (!id) return undefined
  const st = useStore.getState()
  return st.sessions.some((s) => s.tabId === id && s.alive && s.sessionId) ? id : undefined
}

function activeTabIsWeb(): boolean {
  const st = useStore.getState()
  const tabId = panelTabId(st)
  if (!tabId) return false
  if (!panelIsOpen(st, tabId)) return false
  if (!st.sessions.some((s) => s.tabId === tabId && s.sessionId && s.alive)) return false
  const set = st.workbench[tabId]
  if (!set) return false
  return set.tabs.find((t) => t.id === set.activeId)?.kind === 'web'
}

function ResumingMask({
  title,
  label = 'Resuming Claude session…',
  late = false
}: {
  title: string
  label?: string
  late?: boolean
}): JSX.Element {
  return (
    <div className={'empty' + (late ? ' late' : '')}>
      <div>{label}</div>
      <div className="quiet">{title}</div>
    </div>
  )
}

export default function App(): JSX.Element {
  const tabs = useStore((s) => s.tabs)
  const activeTabId = useStore((s) => s.activeTabId)
  const resumeLaunch = useStore((s) => s.resumeLaunch)
  // PLATFORM§21
  const [switchFrom, setSwitchFrom] = useState(activeTabId)
  const [switchGen, setSwitchGen] = useState(0)
  if (switchFrom !== activeTabId) {
    setSwitchFrom(activeTabId)
    setSwitchGen((g) => g + 1)
  }
  const [shown, setShown] = useState({ id: activeTabId, gen: 0 })
  const [paintedGen, setPaintedGen] = useState(0)
  const wokeInPlace = !!shown.id && tabs.some((t) => t.id === activeTabId && t.ghost === shown.id)
  useEffect(() => {
    if (shown.gen === switchGen) return
    if (shown.id === activeTabId || wokeInPlace) {
      setShown({ id: activeTabId, gen: switchGen })
      setPaintedGen(switchGen)
      return
    }
    let inner = 0
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setShown({ id: activeTabId, gen: switchGen }))
    })
    return () => {
      cancelAnimationFrame(outer)
      cancelAnimationFrame(inner)
    }
  }, [activeTabId, switchGen, shown.gen, wokeInPlace])
  const switching =
    activeTabId !== null && !wokeInPlace && (shown.gen !== switchGen || paintedGen !== switchGen)
  const workbenchWidth = useStore((s) => s.workbenchWidth)
  const workbenchWidths = useStore((s) => s.workbenchWidths)
  const workbench = useStore((s) => s.workbench)
  const workbenchOpen = useStore((s) => s.workbenchOpen)
  const workbenchFull = useStore((s) => s.workbenchFull)
  const sidebarWidth = useStore((s) => s.sidebarWidth)
  const workspaceRows = useStore((s) => s.workspaceRows)
  const toast = useStore((s) => s.toast)
  const toastReveal = useStore((s) => s.toastReveal)
  const overlay = useStore((s) => s.overlay)
  const showOverlay = useStore((s) => s.showOverlay)
  const closeOverlay = useStore((s) => s.closeOverlay)
  const cdpAttached = useStore((s) => s.cdpAttached)
  const showToast = useStore((s) => s.showToast)
  const dismissToast = useStore((s) => s.dismissToast)
  const setWorkspaceRows = useStore((s) => s.setWorkspaceRows)
  const addTab = useStore((s) => s.addTab)
  const setSessions = useStore((s) => s.setSessions)
  const setTabAlive = useStore((s) => s.setTabAlive)
  const closeTab = useStore((s) => s.closeTab)
  const setSettings = useStore((s) => s.setSettings)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const keepAwake = useStore((s) => s.settings.keepAwake)
  const setWorkbenchWidth = useStore((s) => s.setWorkbenchWidth)
  const setTabWorkbenchWidth = useStore((s) => s.setTabWorkbenchWidth)
  const setWorkbenchFull = useStore((s) => s.setWorkbenchFull)
  const updateWorkbenchTabs = useStore((s) => s.updateWorkbenchTabs)
  const setSidebarWidth = useStore((s) => s.setSidebarWidth)
  const notesHeight = useStore((s) => s.notesHeight)
  const setNotesHeight = useStore((s) => s.setNotesHeight)
  const notesFolded = useStore((s) => s.settings.notesFolded)
  const sidebarHidden = useStore((s) => s.settings.sidebarHidden)
  const waitingCount = useStore((s) => waitingTabs(s.attention, s.tabs).length)
  const selectedWs = useStore((s) => s.selectedWs)
  const [notesFocus, setNotesFocus] = useState(0)
  const [nbDragging, setNbDragging] = useState(false)
  const notesWsRef = useRef<string | null>(null)

  const newRequestId = useRef(0)
  const newSessionLocked = useRef(false)
  const [newRequest, setNewRequest] = useState<{
    id: number
    mode: PickerMode
    path?: string
    pending?: PendingStart
    chosen?: SessionBackend
  } | null>(null)
  const [newProject, setNewProject] = useState<{ id: number; seed: ProjectSeed } | null>(null)
  const [restoreWs, setRestoreWs] = useState<string | null>(null)
  const [cronWs, setCronWs] = useState<{ path: string; jobId?: string } | null>(null)
  const [addMenu, setAddMenu] = useState(false)
  const [remoteDialog, setRemoteDialog] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const closePalette = useCallback((): void => setPaletteOpen(false), [])
  const [panelCmd, setPanelCmd] = useState<WorkbenchCommandSignal | null>(null)
  const [browserDialog, setBrowserDialog] = useState<BrowserAuthChallenge | BrowserJsDialog | null>(
    null
  )
  const [extAsks, setExtAsks] = useState<ExtensionPermissionRequest[]>([])
  const dispatchPanel = useCallback((id: WorkbenchCommandSignal['id']): void => {
    setPanelCmd((prev) => ({ id, nonce: (prev?.nonce ?? 0) + 1 }))
  }, [])

  const [tuiFocus, setTuiFocus] = useState(0)
  const focusTuiFromMargin = useCallback((e: MouseEvent<HTMLDivElement>): void => {
    if (e.target !== e.currentTarget) return
    e.preventDefault()
    setTuiFocus((n) => n + 1)
  }, [])

  const returnFocus = useCallback((): void => {
    const st = useStore.getState()
    if (st.workbenchFull) st.setWorkbenchFull(false)
    if (st.activeTabId) setTuiFocus((n) => n + 1)
    else (document.querySelector('.w-empty') as HTMLElement | null)?.focus()
  }, [])

  const toggleWorkbench = useCallback((): void => {
    const st = useStore.getState()
    const tabId = panelActionTab()
    if (!tabId) return
    const open = panelIsOpen(st, tabId)
    const next = !(open || st.workbenchFull)
    if (st.workbenchFull) st.setWorkbenchFull(false)
    st.setWorkbenchOpen(tabId, next)
    if (next) setPanelFocus((n) => n + 1)
    else returnFocus()
  }, [returnFocus])

  const toggleFull = useCallback((): void => {
    const st = useStore.getState()
    const tabId = panelActionTab()
    if (!tabId) return
    if (!st.workbenchFull && !panelIsOpen(st, tabId)) return
    const nextFull = !st.workbenchFull
    st.setWorkbenchFull(nextFull)
    if (nextFull) setPanelFocus((n) => n + 1)
  }, [])
  const [rowsLoaded, setRowsLoaded] = useState(false)

  const [probed, setProbed] = useState<Record<SessionBackend, boolean> | null>(null)
  const toolsChanged = useToolsChanged()
  useEffect(() => {
    let alive = true
    void window.api.sessions.backends().then(
      (list) => {
        if (alive) setProbed(byBackend((b) => backendAvailable(list, b)))
      },
      () => {
        if (alive) setProbed(byBackend(() => false))
      }
    )
    return () => {
      alive = false
    }
  }, [toolsChanged])
  const installed = useMemo(
    () => new Set(probed ? SESSION_BACKENDS.filter((b) => probed[b]) : SESSION_BACKENDS),
    [probed]
  )
  const sessionMethods = useStore((s) => s.settings.sessionMethods)
  const listed = useMemo(
    () => listedBackends(sessionMethods, probed && ((b) => probed[b])),
    [probed, sessionMethods]
  )
  const namedMethods = useMemo((): SessionBackend[] | null => {
    const { defaultBackend } = sessionMethods
    if (listed.length < 2 || !listed.includes(defaultBackend)) return null
    return [defaultBackend, ...listed.filter((b) => b !== defaultBackend)]
  }, [listed, sessionMethods])
  const soleMethod = effectiveBackend(sessionMethods, installed)

  const startSession = useCallback(
    async (opts: SessionLaunchOptions, backend: SessionBackend): Promise<void> => {
      const launch = { kind: backend, ...opts }
      const res = await window.api.terminal.create(launch)
      if (!res.ok) throw new Error(LAUNCH_REFUSED_NOTICE)
      addTab({
        id: res.id,
        kind: backend,
        title: BACKEND_LABEL[backend],
        cwd: res.cwd,
        alive: true,
        launch: launchToStartAgain(launch, res.cwd)
      })
    },
    [addTab]
  )

  const requestNew = useCallback(
    (mode: PickerMode, path?: string, pending?: PendingStart, chosen?: SessionBackend): void => {
      if (newSessionLocked.current) return
      setRestoreWs(null)
      setNewRequest({ id: ++newRequestId.current, mode, path, pending, chosen })
    },
    []
  )
  const newWorktreeSessionIn = useCallback(
    (path: string) => requestNew('worktree', path),
    [requestNew]
  )
  const openScheduledJobs = useCallback(
    (path: string, jobId?: string) => setCronWs({ path, jobId }),
    []
  )

  const startNow = useCallback(
    (host: HostId, backend: SessionBackend, options: () => Promise<SessionLaunchOptions>): void => {
      if (newSessionLocked.current) return
      newSessionLocked.current = true
      void options()
        .then((opts) => startSession(opts, backend))
        .catch((e) => showToast(launchErrorMessage(e)))
        .finally(() => {
          newSessionLocked.current = false
        })
    },
    [showToast, startSession]
  )

  const startIn = useCallback(
    (wsPath: string, backend?: SessionBackend): void => {
      const ws = useStore.getState().workspaceRows.find((w) => w.workspace.path === wsPath)
      if (!ws) return
      if (pullable(ws)) {
        requestNew('main', wsPath, undefined, backend)
        return
      }
      startNow(hostOf(wsPath), backend ?? soleMethod, async () => ({
        cwd: wsPath
      }))
    },
    [requestNew, soleMethod, startNow]
  )

  const globalNew = useCallback(
    (mode: PickerMode): void => {
      if (!rowsLoaded) return
      const rows = useStore.getState().workspaceRows
      const visible = pickerRows(rows, mode)
      if (visible.length === 0) {
        showToast(rows.length > 0 && mode === 'worktree' ? NO_GIT_NOTICE : NO_WORKSPACE_NOTICE)
        return
      }
      if (!skipPicker(rows, mode)) {
        requestNew(mode)
        return
      }
      const only = visible[0].ws.workspace.path
      if (mode === 'main') startIn(only)
      else requestNew(mode, only)
    },
    [requestNew, rowsLoaded, showToast, startIn]
  )

  const [panelFocus, setPanelFocus] = useState(0)

  // ADR-0012
  const [guestLit, setGuestLit] = useState(false)
  useEffect(() => {
    let queued = 0
    const recheck = (): void => {
      window.clearTimeout(queued)
      queued = window.setTimeout(() => setGuestLit(guestHasCaret()), 0)
    }
    document.addEventListener('focusin', recheck, true)
    document.addEventListener('focusout', recheck, true)
    window.addEventListener('blur', recheck)
    window.addEventListener('focus', recheck)
    // PLATFORM§10
    const offWindowFocus = window.api.windowFocus.onChange((focused) => {
      windowFocused = focused
      recheck()
    })
    return () => {
      window.clearTimeout(queued)
      document.removeEventListener('focusin', recheck, true)
      document.removeEventListener('focusout', recheck, true)
      window.removeEventListener('blur', recheck)
      window.removeEventListener('focus', recheck)
      offWindowFocus()
    }
  }, [])
  // PLATFORM§10
  useEffect(() => {
    const composing = (): void => window.api.browser.reportComposing(true)
    const done = (): void => window.api.browser.reportComposing(false)
    document.addEventListener('compositionstart', composing, true)
    document.addEventListener('compositionupdate', composing, true)
    document.addEventListener('compositionend', done, true)
    return () => {
      document.removeEventListener('compositionstart', composing, true)
      document.removeEventListener('compositionupdate', composing, true)
      document.removeEventListener('compositionend', done, true)
    }
  }, [])
  useEffect(() => {
    if (!panelFocus) return undefined
    // PLATFORM§25
    const raf = requestAnimationFrame(() => setGuestLit(guestHasCaret()))
    return () => cancelAnimationFrame(raf)
  }, [panelFocus])

  const newTerminalTab = useCallback((): void => {
    const tabId = terminalActionTab()
    if (!tabId) return
    useStore.getState().openTerminalTab(tabId)
  }, [])

  useEffect(() => {
    const closeActive = (): void => {
      if (document.activeElement?.closest(NOTES_ISLAND)) return
      if (focusedWorkbench()) {
        dispatchPanel('browser-close-tab')
        return
      }
      requestCloseTab(useStore.getState().activeTabId)
    }
    const offNewSession = window.api.shortcuts.onNewSession(() => globalNew('main'))
    const offNewWorktree = window.api.shortcuts.onNewWorktreeSession(() => globalNew('worktree'))
    const offClose = window.api.shortcuts.onCloseTab(closeActive)
    const offRestart = window.api.shortcuts.onRestartSession(() =>
      useStore.getState().restartActiveSession()
    )
    const offNewTerminal = window.api.shortcuts.onNewTerminalTab(newTerminalTab)
    // PLATFORM§7
    const onKeyDown = (e: KeyboardEvent): void => {
      if (
        (e.key === 'ArrowLeft' || e.key === 'ArrowRight') &&
        e.metaKey &&
        e.altKey &&
        !e.shiftKey
      ) {
        if (!focusedWorkbench()) return
        e.preventDefault()
        dispatchPanel(e.key === 'ArrowRight' ? 'cycle-next' : 'cycle-prev')
        return
      }
      if (e.key === 'Escape') {
        if (!focusedWorkbench() || caretInShell()) return
        e.preventDefault()
        dispatchPanel('escape')
        return
      }
      if (e.key !== 't' && e.key !== 'T') return
      if (!e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
      if (!focusedWorkbench()) return
      e.preventDefault()
      dispatchPanel('browser-new-tab')
    }
    document.addEventListener('keydown', onKeyDown, true)
    // PLATFORM§6
    ;(window as unknown as { __koloftShortcutsReady?: boolean }).__koloftShortcutsReady = true
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      offNewSession()
      offNewWorktree()
      offClose()
      offRestart()
      offNewTerminal()
    }
  }, [newTerminalTab, dispatchPanel, globalNew])

  useEffect(() => {
    return window.api.shortcuts.onBrowserCommand((cmd) => {
      const target = commandTarget(cmd, !!focusedWorkbench() && activeTabIsWeb())
      if (target.to === 'app') {
        if (target.cmd === 'toggle-browser') toggleWorkbench()
        else toggleFull()
      } else if (target.to === 'browser') {
        if (target.cmd === 'browser-new-tab' || target.cmd === 'browser-close-tab') {
          const tabId = panelActionTab()
          if (!tabId) return
          const st = useStore.getState()
          if (!panelIsOpen(st, tabId)) {
            if (target.cmd === 'browser-close-tab') return
            st.setWorkbenchOpen(tabId, true)
          }
        }
        dispatchPanel(target.cmd)
      } else if (target.to === 'window') window.api.shortcuts.windowCommand(target.cmd)
    })
  }, [toggleWorkbench, toggleFull, dispatchPanel])

  // PLATFORM§7
  useEffect(() => {
    return window.api.shortcuts.onWorkbenchShortcut(dispatchPanel)
  }, [dispatchPanel])

  useEffect(() => {
    return window.api.shortcuts.onFind(() => {
      if (focusedWorkbench()) dispatchPanel('find')
    })
  }, [dispatchPanel])

  useEffect(() => {
    return window.api.app.onQuitRequested(() => {
      void flushNotes().then(() => {
        const dirty = allDirty()
        if (dirty.length === 0) {
          window.api.app.approveQuit()
          return
        }
        window.api.app.holdQuit()
        useStore.getState().setUnsavedPrompt({
          files: labelPaths(dirty),
          onCancel: () => window.api.app.declineQuit(),
          onDiscard: () => {
            discardAll(dirty)
            window.api.app.approveQuit()
          },
          onSave: async () => {
            const ok = await saveAll(dirty)
            useStore.getState().setUnsavedPrompt(null)
            if (ok) window.api.app.approveQuit()
            else window.api.app.declineQuit()
          }
        })
      })
    })
  }, [])

  useEffect(() => {
    return window.api.shortcuts.onSave(() => {
      if (caretInNote()) {
        const ws = notesWsRef.current
        if (ws) void saveTab(notesOwner(ws), NOTES_TAB)
        return
      }
      if (focusedWorkbench()) dispatchPanel('save')
    })
  }, [dispatchPanel])

  const setNotesFolded = useCallback((folded: boolean): void => {
    const st = useStore.getState()
    if (st.settings.notesFolded === folded) return
    st.setSettings({ ...st.settings, notesFolded: folded })
    void window.api.settings.set({ notesFolded: folded })
  }, [])

  const setSidebarHidden = useCallback(
    (hidden: boolean): void => {
      const st = useStore.getState()
      if (st.settings.sidebarHidden === hidden) return
      if (hidden && document.activeElement?.closest('.side')) returnFocus()
      updateSettings({ sidebarHidden: hidden })
    },
    [returnFocus]
  )
  const toggleSidebar = useCallback(
    (): void => setSidebarHidden(!useStore.getState().settings.sidebarHidden),
    [setSidebarHidden]
  )
  useEffect(() => window.api.shortcuts.onToggleSidebar(toggleSidebar), [toggleSidebar])

  useEffect(() => {
    return window.api.shortcuts.onFocusNotes(() => {
      if (!document.querySelector(NOTES_ISLAND)) return
      if (caretInNote()) {
        returnFocus()
        return
      }
      setSidebarHidden(false)
      setNotesFolded(false)
      setNotesFocus((n) => n + 1)
    })
  }, [returnFocus, setNotesFolded, setSidebarHidden])

  useEffect(() => {
    return window.api.shortcuts.onNextWaitingSession(visitNextWaiting)
  }, [])

  useEffect(() => {
    return window.api.shortcuts.onFindFiles(() => {
      const tabId = panelActionTab()
      if (!tabId) return
      const st = useStore.getState()
      if (!panelIsOpen(st, tabId)) st.setWorkbenchOpen(tabId, true)
      dispatchPanel('find-files')
    })
  }, [dispatchPanel])

  const openSearchHit = useCallback((hit: SessionSearchHit): void => {
    setPaletteOpen(false)
    const st = useStore.getState()
    const tabId = liveTabOf(hit.row.id, st.sessions, st.tabs)
    if (tabId) {
      st.activateTab(tabId)
      return
    }
    const { id, backendId, title } = hit.row
    const listed = everyWorkspaceRows(st).some((w) => w.rows.some((r) => r.id === id))
    void resumeSession({ id, backendId, title, restore: !listed })
  }, [])

  useEffect(() => {
    return window.api.browser.onOpenRequest((r) => {
      const st = useStore.getState()
      const named = { ...r, tabId: conversationTabFor(r.tabId) }
      const sess = browserOpenTargetSession(st.sessions, named, st.activeTabId)
      const fromShell = named.tabId !== r.tabId
      if (sess && (fromShell || sess.tabId !== named.tabId) && st.activeTabId !== sess.tabId) {
        st.activateTab(sess.tabId)
      }
      const landing = sess?.sessionId ? sess.tabId : undefined
      if (!landing) {
        if (r.osFallback) {
          st.landOverlay(r.url, overlayPresentation(r, st.tabs, st.sessions))
        } else window.api.extensions.openDropped(r.url)
        return
      }
      st.openWorkbenchTarget(landing, {
        url: r.url,
        source: r.source,
        fromShim: r.osFallback !== undefined
      })
    })
  }, [])

  useEffect(() => {
    return window.api.browser.onDownload((d) =>
      useStore.getState().showToast(`Downloaded ${d.name} · Reveal in Finder`, d.path)
    )
  }, [])

  useEffect(() => {
    return window.api.browser.onBlockedScheme((url) =>
      useStore.getState().showToast(`Blocked: ${url}`)
    )
  }, [])

  useEffect(() => {
    return window.api.browser.onAuthChallenge(setBrowserDialog)
  }, [])

  useEffect(() => {
    return window.api.extensions.onPermissionRequest((r) => setExtAsks((q) => [...q, r]))
  }, [])

  useEffect(() => {
    return window.api.browser.onJsDialog((d) => {
      if (d.overlay) useStore.getState().setOverlayDialog(d)
      else setBrowserDialog(d)
    })
  }, [])

  useEffect(() => {
    return window.api.browser.onCdpOp((op) => {
      setPanelMounted(true)
      setCdpOps((q) => [...q, op])
    })
  }, [])

  useEffect(() => {
    return window.api.browser.onCdpAttached((a) =>
      useStore.getState().setCdpAttached(a.sessionId, a.targetIds)
    )
  }, [])

  useEffect(() => {
    const off = window.api.browser.onOverlayOpen((o) =>
      useStore.getState().landOverlay(o.url, o.presentation)
    )
    // PLATFORM§6
    window.api.browser.overlayReady()
    return off
  }, [])

  useEffect(() => {
    if (!overlay?.open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      closeOverlay()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [overlay?.open, closeOverlay])

  // PLATFORM§20
  useEffect(() => window.api.webgl.onRepair(repairAllWebgl), [])

  useEffect(() => {
    const take = (rows: WorkspaceRows[]): void => {
      setRowsLoaded(true)
      ;(window as unknown as { __koloftRowsReady?: boolean }).__koloftRowsReady = true
      setWorkspaceRows(rows)
    }
    void window.api.workspace.rows().then(take)
    return window.api.workspace.onRows(take)
  }, [setWorkspaceRows])

  const addWorkspace = useCallback(async (): Promise<boolean> => {
    const picked = await window.api.workspace.pickFolder()
    if (!picked) return false
    const r = await window.api.workspace.add(picked)
    if (r.code === 'rejected-worktree') showToast('Pick the repo root instead')
    else if (r.code === 'not-found') showToast('That folder does not exist')
    else if (r.code === 'added') setSidebarHidden(false)
    return r.code === 'added' || r.code === 'exists'
  }, [showToast, setSidebarHidden])
  const addRemoteWorkspace = useCallback(
    async (key: string): Promise<void> => {
      setRemoteDialog(false)
      const r = await window.api.workspace.add(key)
      if (r.code === 'exists') showToast('Already added')
      else if (r.code === 'added') setSidebarHidden(false)
    },
    [showToast, setSidebarHidden]
  )
  useEffect(() => window.api.shortcuts.onAddWorkspace(() => void addWorkspace()), [addWorkspace])
  useEffect(() => {
    if (!addMenu) return undefined
    const close = (): void => setAddMenu(false)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [addMenu])
  useEffect(
    () => window.api.shortcuts.onOpenSettings(() => setSettingsOpen(true)),
    [setSettingsOpen]
  )
  useEffect(
    () =>
      window.api.shortcuts.onCommandPalette(() => {
        if (rowsLoaded && !aDialogIsOpen()) setPaletteOpen(true)
      }),
    [rowsLoaded]
  )

  useEffect(() => {
    return window.api.accounts.onLoginProgress((p) => {
      const st = useStore.getState()
      if (!st.accountLogin) return
      st.setLoginProgress(p)
      const delay = loginClearDelay(p)
      if (delay !== null) {
        setTimeout(() => {
          if (savedClearDue(useStore.getState().accountLogin, p)) {
            useStore.getState().clearLogin()
          }
        }, delay)
      }
    })
  }, [])

  useEffect(() => {
    const offCheck = window.api.shortcuts.onCheckUpdate(() => useStore.getState().openUpdateCheck())
    const offProgress = window.api.update.onProgress((p) => {
      if (useStore.getState().update.phase === 'downloading') {
        useStore.getState().setUpdate({ percent: p.percent })
      }
    })
    const offOffer = window.api.update.onOffer(useStore.getState().setUpdateOffer)
    void window.api.update.offer().then(useStore.getState().setUpdateOffer)
    return () => {
      offCheck()
      offProgress()
      offOffer()
    }
  }, [])

  useEffect(() => {
    const set = useStore.getState().setLeftovers
    void window.api.sessions.leftovers().then(set)
    return window.api.sessions.onLeftovers(set)
  }, [])

  useEffect(() => {
    const set = useStore.getState().setMachine
    void window.api.machine.now().then(set)
    return window.api.machine.onState(set)
  }, [])

  useEffect(() => {
    const off = window.api.sessions.onUpdate((sessions) => {
      setSessions(sessions)
      for (const s of sessions) {
        setTabAlive(s.tabId, s.alive)
        if (s.sessionId) releaseResume(s.sessionId)
      }
      const st = useStore.getState()
      for (const tab of keptTabsToClose(st)) {
        askAboutLeftEdits(tab)
        st.closeTab(tab.id)
      }
    })
    return off
  }, [setSessions, setTabAlive])

  useEffect(
    () =>
      window.api.sessions.onRelocated((e) => {
        const st = useStore.getState()
        if (st.activeTabId === e.tabId) st.showToast(relocatedNotice(e.dir))
      }),
    []
  )

  useEffect(() => {
    const offSpawned = window.api.terminal.onSpawned((t) => {
      if (t.sessionId) rearmResume(t.sessionId)
      useStore.getState().addTabQuiet({
        id: t.id,
        kind: t.kind,
        title: t.title,
        cwd: t.cwd,
        alive: true,
        jobId: t.jobId,
        ...(t.sessionId ? { sessionId: t.sessionId, resuming: true } : {})
      })
    })
    let pushed = false
    const offState = window.api.cron.onState((s) => {
      pushed = true
      useStore.getState().setCron(s)
    })
    const offToast = window.api.cron.onToast((text) => useStore.getState().showToast(text))
    void adoptionSettled.then(() =>
      window.api.cron
        .list()
        .then((s) => {
          if (!pushed) useStore.getState().setCron(s)
        })
        .catch(() => {})
    )
    return () => {
      offSpawned()
      offState()
      offToast()
    }
  }, [])

  useEffect(() => {
    return window.api.tabs.onKilledByMain((tabId) => {
      const st = useStore.getState()
      const tab = st.tabs.find((t) => t.id === tabId)
      if (tab) askAboutLeftEdits(tab)
      st.removeTab(tabId)
    })
  }, [])

  useEffect(() => window.api.tabs.onSlept((tabId) => useStore.getState().setTabAsleep(tabId)), [])

  useEffect(() => {
    const tab = useStore.getState().tabs.find((t) => t.id === activeTabId)
    if (tab?.asleep) void wakeTab(tab)
  }, [activeTabId])

  useEffect(() => {
    window.api.attention.activeTab(activeTabId)
  }, [activeTabId])

  useEffect(() => {
    return window.api.attention.onActivateTab(visitAndReveal)
  }, [])

  useEffect(() => {
    const set = useStore.getState().setAttention
    const off = window.api.attention.onChanged(set)
    void window.api.attention.list().then(set)
    return off
  }, [])

  useEffect(() => {
    const off = window.api.terminal.onExit((e) => {
      if (useStore.getState().tabs.some((t) => t.id === e.id && t.asleep)) return
      if (!adoptionIsSettled()) preAdoptExits.add(e.id)
      if (useStore.getState().terminalExited(e.id)) return
      if (consumeRestartExit(e.id)) return
      if (consumeRestoreExit(e.id)) useStore.getState().showToast(RESTORE_FAILED_NOTICE)
      const tab = useStore.getState().tabs.find((t) => t.id === e.id)
      if (tab?.sessionId) releaseResume(tab.sessionId)
      if (unexpectedExitWanted(tab, e)) {
        const notice = unexpectedExitNotice(e, tab.kind, tabEverBound(tab.id))
        useStore.getState().showToast(notice)
        if (useStore.getState().keepEndedTab(e.id, endedRowNote(e))) {
          void lastLinesOnceWritten(e.id, LAST_SCREEN_LINES_LOGGED).then((lines) => {
            window.api.terminal.logUnexpectedExit({ id: e.id, lines })
            writeOnScreen(e.id, `\x1b[0m\r\n[Koloft] ${notice}\r\n`)
          })
          return
        }
      }
      if (e.unexpected) window.api.terminal.logUnexpectedExit({ id: e.id, lines: [] })
      if (tab) askAboutLeftEdits(tab)
      closeTab(e.id)
    })
    return off
  }, [closeTab])

  useEffect(() => {
    return window.api.terminal.onProcessTitle((t) =>
      useStore.getState().setTermTabProcess(t.id, t.name)
    )
  }, [])

  useEffect(() => {
    return window.api.terminal.onCwd((c) => useStore.getState().setTermTabCwd(c.id, c.cwd))
  }, [])

  const adopted = useRef(false)
  useEffect(() => {
    if (adopted.current) return
    adopted.current = true
    void (async () => {
      try {
        const inv = await window.api.tabs.list()
        const tabs = inv.tabs.filter((t) => !preAdoptExits.has(t.id))
        if (!tabs.length) return
        for (const t of tabs) {
          if (t.resumeSessionId && !t.sessionId) rearmResume(t.resumeSessionId)
        }
        useStore.getState().adoptTabs(tabs, inv.activeTabBeforeReload)
        const live = await window.api.sessions.list()
        useStore.getState().setSessions(live)
        for (const s of live) {
          useStore.getState().setTabAlive(s.tabId, s.alive)
          if (s.sessionId) releaseResume(s.sessionId)
        }
      } catch {
      } finally {
        markAdoptionSettled()
      }
    })()
  }, [])

  useEffect(() => {
    window.api.settings.get().then((s) => {
      setSettings(s)
      setWorkbenchWidth(s.workbenchWidth)
      setSidebarWidth(Math.max(SIDEBAR_MIN, s.sidebarWidth))
      setNotesHeight(s.notesHeight)
    })
    const off = window.api.settings.onUpdate(setSettings)
    return off
  }, [setSettings, setWorkbenchWidth, setSidebarWidth, setNotesHeight])

  useEffect(() => {
    const { setAccounts } = useStore.getState()
    void window.api.accounts.list().then(setAccounts)
    return window.api.accounts.onUpdate(setAccounts)
  }, [])

  useEffect(() => {
    let live = true
    void window.api.update.whatsNew().then((w) => {
      if (live && w) useStore.getState().openWhatsNew(w)
    })
    return () => {
      live = false
    }
  }, [])

  useEffect(() => {
    return window.api.preview.onOpenRequest((r) =>
      openInterceptedFile(r.tabId, r.path, r.source, r.view)
    )
  }, [])

  const lastWsPath = useStore((s) => s.lastWsPath)
  const setLastWsPath = useStore((s) => s.setLastWsPath)
  const activeTabWs = useStore((s) =>
    activeTabId ? workspaceOfTab(s.workspaceRows, s.sessions, activeTabId) : null
  )
  useEffect(() => {
    if (activeTabWs) setLastWsPath(activeTabWs)
  }, [activeTabWs, setLastWsPath])
  const welcomeWs = welcomeTarget(workspaceRows, lastWsPath)
  const welcomeActive = useStore((s) => s.welcomeActive)
  const setWelcomeActive = useStore((s) => s.setWelcomeActive)
  const onboardingSeen = useStore((s) => s.settings.onboardingSeen)
  const noWorkspaces = workspaceRows.length === 0
  useEffect(() => {
    if (onboardingSeen) setWelcomeActive(false)
    else if (rowsLoaded && noWorkspaces) setWelcomeActive(true)
  }, [rowsLoaded, onboardingSeen, noWorkspaces, setWelcomeActive])
  const updateOffer = useStore((s) => s.updateOffer)
  const activeRowId = useStore((s) => (activeTabId ? rowIdOfTab(s.sessions, activeTabId) : null))
  const butlerActive = useStore(
    (s) =>
      !!activeTabId &&
      (isButlerTab(s.sessions, s.butlerTab, activeTabId) ||
        !!s.butlerWorkspace?.rows.some((r) => r.id === activeRowId))
  )
  const currentWs = currentWorkspace(workspaceRows, activeRowId, selectedWs, lastWsPath)
  const notesWs = butlerActive ? GLOBAL_SCOPE : currentWs
  notesWsRef.current = notesWs
  const [notesFocusWs, setNotesFocusWs] = useState(notesWs)
  if (notesFocusWs !== notesWs) {
    setNotesFocusWs(notesWs)
    setNotesFocus(0)
  }
  const runningWelcomeIds = useStore(
    useShallow((s) => {
      const look = rowLookups(s.sessions, s.tabs, [])
      return (welcomeWs?.rows ?? []).filter((r) => look.running(r)).map((r) => r.id)
    })
  )
  const welcomeRunning = runningWelcomeIds.length
  const recentRows = (welcomeWs?.rows ?? [])
    .filter((r) => !runningWelcomeIds.includes(r.id) && !r.pending)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, RECENT_MAX)

  const resumeRecent = useCallback((row: SessionRow): void => {
    void resumeSession({ id: row.id, backendId: row.backendId, title: row.title })
  }, [])

  const paletteRouted: PaletteRouted = (prompt, backend, route) => {
    setPaletteOpen(false)
    if (route?.kind === 'project') {
      const where = useStore.getState().settings.newProjectFolders[route.machine]
      const parentKey = where ? projectParentKey(route.machine, where) : null
      const folder = route.folder
      if (parentKey && folder) {
        startNow(hostOf(parentKey), backend, () =>
          projectOptions(parentKey, folder, { prompt, title: route.title })
        )
        return
      }
      setNewProject({
        id: ++newRequestId.current,
        seed: {
          prompt,
          title: route.title,
          machine: route.machine,
          folder: folder ?? '',
          why: route.why
        }
      })
      return
    }
    if (route?.kind === 'discord') {
      void setUpDiscordWithButler(prompt).then((error) => {
        if (error) showToast(error)
      })
      return
    }
    if (!route && !useStore.getState().settings.assist?.on) {
      showToast(
        'Koloft Assist is off, so pick the workspace yourself. Turn it on in Settings ▸ Assist.'
      )
      pickWorkspaceForTyped({ prompt, title: '' }, backend)
      return
    }
    const toButler = (title: string, about: string | null): void => {
      const at = activeTabWs ?? undefined
      const request = {
        words: prompt,
        backend,
        title: title || undefined,
        about: about ?? undefined,
        at
      }
      void window.api.conductors.fromPalette(request).then((r) => {
        if (r.ok) return visitTab(r.tabId)
        showToast(r.error)
        requestNew('main', undefined, { prompt, title, path: about, worktree: null }, backend)
      })
    }
    if (route?.kind === 'feature') {
      paletteActions()
        .find((a) => a.key === route.key)
        ?.run()
      return
    }
    if (route?.kind === 'session') {
      const row = workspaceRows
        .find((w) => w.workspace.path === route.path)
        ?.rows.find((r) => r.id === route.id)
      if (row) openSessionRow(row, route.path)
      else toButler(route.title, null)
      return
    }
    if (route?.kind === 'assist') {
      toButler(route.title, route.path)
      return
    }
    const ws =
      route?.kind === 'workspace' &&
      workspaceRows.find((w) => w.workspace.path === route.path && !w.workspace.missing)
    if (route?.kind !== 'workspace' || !ws) {
      toButler(route?.title ?? '', null)
      return
    }
    const pending: PendingStart = {
      prompt,
      title: route.title,
      path: route.path,
      worktree: route.worktree
    }
    if (pullable(ws)) {
      requestNew('main', ws.workspace.path, pending, backend)
      return
    }
    startNow(hostOf(ws.workspace.path), backend, () => pendingOptions(ws.workspace, pending))
  }

  const pickWorkspaceForTyped = (typed: TypedStart, chosen?: SessionBackend): void => {
    setNewProject(null)
    requestNew('main', undefined, { ...typed, path: null, worktree: null }, chosen)
  }

  const paletteActions = (): PaletteAction[] => {
    const hasHistory = workspaceRows.some(
      (w) => w.workspace.path === currentWs && w.workspace.hasHistory
    )
    const run: Record<PaletteActionKey, () => void> = {
      'new-session': () => globalNew('main'),
      'new-worktree-session': () => globalNew('worktree'),
      'add-workspace': () => void addWorkspace(),
      'add-remote': () => setRemoteDialog(true),
      'restart-session': () => useStore.getState().restartActiveSession(),
      'toggle-workbench': toggleWorkbench,
      'toggle-sidebar': toggleSidebar,
      'restore-session': () => setRestoreWs(currentWs),
      'scheduled-jobs': () => currentWs && setCronWs({ path: currentWs }),
      'open-settings': () => setSettingsOpen(true),
      'check-update': () => useStore.getState().openUpdateCheck()
    }
    const disabled: Partial<Record<PaletteFeature['key'], boolean>> = {
      'restore-session': !hasHistory,
      'scheduled-jobs': !currentWs
    }
    return PALETTE_FEATURES.map(({ pane, actsOnCurrent: _, ...f }) => ({
      ...f,
      kind: 'action',
      disabled: disabled[f.key],
      run: pane ? () => useStore.getState().openSettingsPane(pane) : run[f.key as PaletteActionKey]
    }))
  }

  const activeTab = tabs.find((t) => t.id === activeTabId)
  const activeSessionTitle = useStore((s) =>
    activeTab ? s.sessions.find((x) => x.tabId === activeTab.id)?.title : undefined
  )
  // ADR-0030
  const assistSetup = useAssistSetup()
  const signInTabId = useStore((s) => s.signIn?.tabId)
  const whatsNewOpen = useStore((s) => s.update.open)
  const [assistSetupLater, setAssistSetupLater] = useState(false)
  const assistAsked = useStore((s) => s.assistAsked && !s.settings.assist?.on)
  const setAssistAsked = useStore((s) => s.setAssistAsked)
  const assistDialogShown =
    assistAsked ||
    (rowsLoaded &&
      assistSetup.loaded &&
      !assistSetup.done &&
      !assistSetupLater &&
      !welcomeActive &&
      !whatsNewOpen &&
      !(signInTabId && activeTabId === signInTabId))
  const landedTab = tabs.find((t) => t.id === shown.id) ?? activeTab
  const landed = useStore(
    useShallow((s) => {
      const x = s.sessions.find((y) => y.tabId === landedTab?.id)
      return { sessionId: x?.sessionId, alive: x?.alive, treeRoot: x?.treeRoot }
    })
  )
  const panelTab = hasWorkbench(landedTab) ? landedTab?.id : undefined
  const panelWidth = (panelTab ? workbenchWidths[panelTab] : undefined) ?? workbenchWidth
  const liveTabIds = useStore(
    useShallow((s) => s.tabs.filter((t) => workbenchOwnerLive(s, t)).map((t) => t.id))
  )
  const liveTabs = useMemo(() => new Set(liveTabIds), [liveTabIds])
  const panelSid = landed.sessionId
  useEffect(() => {
    if (!panelTab) return
    void useStore.getState().ensureWorkbench(panelTab)
  }, [panelTab, panelSid])

  const panelBound = useStore((s) => !!panelTab && !!boundSessionId(s, panelTab))
  const panelReady = panelBound && !landedTab?.resuming

  const terminalReady = panelReady && !!(landed.alive && landed.sessionId)

  useEffect(() => {
    window.api.workbench.setAvailable(panelReady, terminalReady)
  }, [panelReady, terminalReady])

  useEffect(() => {
    return subscribeMenuFlags(({ editing, anyDirty }) => {
      window.api.workbench.setFindAvailable(!editing)
      window.api.workbench.setSaveAvailable(anyDirty)
    })
  }, [])

  useEffect(() => {
    return subscribeDirtyTabs((ids) => window.api.workbench.setDirtyTabs(ids))
  }, [])

  const welcomeRoot = welcomeWs?.workspace.path
  const paletteChoice: AgentChoice = {
    listed,
    lead: soleMethod,
    defaultBackend: sessionMethods.defaultBackend,
    issue: () => '',
    note: () => ''
  }
  const fileTreeRoot = selectionRoot(
    hasWorkbench(landedTab) ? landedTab : undefined,
    landed.treeRoot,
    welcomeRoot
  )

  const panelOpen = panelIsOpen({ workbenchOpen }, panelTab)
  const panelFull = panelOpen && workbenchFull
  const panelShown = panelOpen || panelFull
  // ADR-0011
  const [panelVisible, setPanelVisible] = useState({ on: panelShown, tab: panelTab })
  useEffect(() => {
    if (panelShown) {
      setPanelVisible({ on: true, tab: panelTab })
      return undefined
    }
    let inner = 0
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setPanelVisible({ on: false, tab: panelTab }))
    })
    return () => {
      cancelAnimationFrame(outer)
      cancelAnimationFrame(inner)
    }
  }, [panelShown, panelTab])
  const panelOnScreen = panelShown || (panelVisible.on && panelVisible.tab === panelTab)
  const [cdpOps, setCdpOps] = useState<BrowserCdpOp[]>([])
  const dropCdpOp = useCallback((opId: string): void => {
    setCdpOps((q) => q.filter((o) => o.opId !== opId))
  }, [])
  const onPanelTabEvicted = useCallback(
    (t: WorkbenchTab, set: WorkbenchTabSet) => showToast(tabEvictedNotice(tabLabel(set, t))),
    [showToast]
  )
  const answerBrowserDialog = useCallback(
    (id: string, answer: BrowserDialogAnswer) => {
      const auth = browserDialog?.kind === 'auth'
      setBrowserDialog(null)
      if (auth) window.api.browser.answerAuthChallenge(id, answer)
      else window.api.browser.answerJsDialog(id, answer)
    },
    [browserDialog]
  )
  const onPanelEscapeFellThrough = useCallback(() => {
    if (workbenchFull) setWorkbenchFull(false)
    else returnFocus()
  }, [workbenchFull, setWorkbenchFull, returnFocus])
  const panelTabForSession = useCallback(
    (sid: string) => tabForSession(useStore.getState(), sid),
    []
  )
  const createCdpTab = useCallback((sid: string, url: string) => {
    const st = useStore.getState()
    const owner = tabForSession(st, sid)
    return owner ? st.openCdpTab(owner, url) : Promise.resolve(null)
  }, [])
  // PLATFORM§9
  const staged =
    !panelShown && (cdpOps.length > 0 || Object.values(cdpAttached).some((ids) => ids.length > 0))

  const [panelMounted, setPanelMounted] = useState(false)
  useEffect(() => {
    if (panelShown) setPanelMounted(true)
  }, [panelShown])

  // PLATFORM§20 PLATFORM§23
  useEffect(() => {
    scheduleWebglRepair()
  }, [panelShown, panelFull])
  const [vDragging, setVDragging] = useState(false)
  const [sbDragging, setSbDragging] = useState(false)
  const dockRef = useRef<HTMLDivElement>(null)
  const sideRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  // ADR-0011
  const shownWidth = useRef(0)
  const liveWidth = useRef<number | null>(null)
  useEffect(() => {
    const el = panelRef.current
    if (!el) return undefined
    const ro = new ResizeObserver(() => {
      if (el.offsetWidth > 0 && !el.classList.contains('off')) shownWidth.current = el.offsetWidth
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [panelMounted])
  const centerRef = useRef<HTMLDivElement>(null)
  const [previewFits, setPreviewFits] = useState(false)
  useEffect(() => {
    const el = centerRef.current
    if (!el) return undefined
    const ro = new ResizeObserver(() => setPreviewFits(previewCardFits(el.offsetWidth)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const panelOpenKnown = useStore((s) => !!panelTab && !!s.workbenchFetched[panelTab])
  const previewSlot =
    !panelShown && previewFits && (panelOpenKnown || (!panelBound && !!landedTab?.alive))
  const previewShown = previewSlot && panelOpenKnown && panelReady
  const startVResize = (e: MouseEvent): void => {
    e.preventDefault()
    beginLayoutDrag()
    setVDragging(true)
    const right = panelRef.current?.getBoundingClientRect().right ?? window.innerWidth
    const dockRight = dockRef.current?.getBoundingClientRect().right ?? sidebarWidth
    const onMove = (ev: globalThis.MouseEvent): void => {
      const w = paneWidthFromDrag(right, dockRight, ev.clientX, WORKBENCH_PANE_MIN)
      liveWidth.current = w
      if (panelRef.current) panelRef.current.style.width = `${w}px`
    }
    const onUp = (): void => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      const w = liveWidth.current
      liveWidth.current = null
      if (w !== null) {
        if (panelTab) setTabWorkbenchWidth(panelTab, w)
        else setWorkbenchWidth(w)
      }
      setVDragging(false)
      endLayoutDrag()
      void window.api.settings.set({ workbenchWidth: w ?? useStore.getState().workbenchWidth })
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }
  const CENTER_ISLANDS_MIN_WIDTH = 480
  const GUTTER_AND_CANVAS_RIGHT_PADDING = 20
  const startSidebarResize = (e: MouseEvent): void => {
    e.preventDefault()
    beginLayoutDrag()
    setSbDragging(true)
    const left = dockRef.current?.getBoundingClientRect().left ?? 0
    let live = useStore.getState().sidebarWidth
    const onMove = (ev: globalThis.MouseEvent): void => {
      live = Math.min(
        Math.max(SIDEBAR_MIN, ev.clientX - left),
        window.innerWidth - left - CENTER_ISLANDS_MIN_WIDTH - GUTTER_AND_CANVAS_RIGHT_PADDING
      )
      if (sideRef.current) sideRef.current.style.width = `${live}px`
    }
    const onUp = (): void => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      setSidebarWidth(live)
      setSbDragging(false)
      endLayoutDrag()
      void window.api.settings.set({ sidebarWidth: live })
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }
  const startNotesResize = (e: MouseEvent): void => {
    e.preventDefault()
    beginLayoutDrag()
    setNbDragging(true)
    const box = dockRef.current?.getBoundingClientRect()
    const bottom = box?.bottom ?? window.innerHeight
    const room = box?.height ?? window.innerHeight
    const onMove = (ev: globalThis.MouseEvent): void => {
      setNotesHeight(notesHeightFromDrag(bottom, room, ev.clientY))
    }
    const onUp = (): void => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      setNbDragging(false)
      endLayoutDrag()
      void window.api.settings.set({ notesHeight: useStore.getState().notesHeight })
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  const [dockHeight, setDockHeight] = useState(0)
  useLayoutEffect(() => {
    const measure = (): void => setDockHeight(dockRef.current?.getBoundingClientRect().height ?? 0)
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [sidebarHidden])
  const notesRoom = dockHeight

  const [osFullscreen, setOsFullscreen] = useState(false)
  useEffect(() => {
    void window.api.windowFullscreen.get().then(setOsFullscreen)
    return window.api.windowFullscreen.onChange(setOsFullscreen)
  }, [])

  const hint = useHints()

  return (
    <div className={'app' + (sidebarHidden ? ' sb-off' : '') + (osFullscreen ? ' os-full' : '')}>
      {toast && (
        <div
          className={'toast' + (toastReveal ? ' link' : '')}
          onClick={() => {
            if (!toastReveal) return
            window.api.fs.reveal(toastReveal)
            dismissToast()
          }}
        >
          <span className="toast-msg">{toast}</span>
        </div>
      )}

      <div className="side" ref={sideRef} style={{ width: sidebarWidth }}>
        <div className="titlebar">
          {overlay && (
            <button
              className={'tb-ico' + (overlay.unread ? ' unread' : '')}
              onClick={showOverlay}
              title="Page Koloft opened for you"
              aria-label="Opened page"
            >
              <IconOpenedPage size={20} />
            </button>
          )}
          {window.api.isDev && (
            <span
              className="dev-badge"
              title="Unpackaged dev build — separate data dir (koloft-dev)"
            >
              DEV
            </span>
          )}
          <button
            className={'tb-ico' + (workspaceRows.length === 0 ? ' on' : '')}
            onClick={(e) => {
              e.stopPropagation()
              setAddMenu((v) => !v)
            }}
            title="Add workspace (⇧⌘O)"
            aria-label="Add workspace"
          >
            <IconAddProject size={20} />
          </button>
          {addMenu && (
            <div
              className="menu addws-menu"
              onMouseLeave={() => setAddMenu(false)}
              onClick={(e) => e.stopPropagation()}
            >
              <div
                className="mi"
                onClick={() => {
                  setAddMenu(false)
                  void addWorkspace()
                }}
              >
                Local folder…<span className="k">⇧⌘O</span>
              </div>
              <div
                className="mi"
                onClick={() => {
                  setAddMenu(false)
                  setRemoteDialog(true)
                }}
              >
                Remote directory…<span className="tag">alpha</span>
              </div>
            </div>
          )}
        </div>
        <div className="dock-left" ref={dockRef}>
          <WorkspaceSidebar
            onNewSession={startIn}
            namedMethods={namedMethods}
            soleMethod={soleMethod}
            onNewWorktreeSession={newWorktreeSessionIn}
            onRestoreSession={setRestoreWs}
            onScheduledJobs={openScheduledJobs}
          />
          {updateOffer && (
            <button
              className="btn-primary upd-banner"
              onClick={() => useStore.getState().openUpdateCheck()}
            >
              <IconUpdate size={15} />
              <span>
                {updateOffer.status === 'restart-required'
                  ? `Koloft ${updateOffer.installed} installed · restart`
                  : `Koloft ${updateOffer.latest} available`}
              </span>
              <IconChevronRight size={15} />
            </button>
          )}
          {notesWs && (
            <div
              className={'gutter-h' + (nbDragging ? ' active' : '') + (notesFolded ? ' idle' : '')}
              style={{ height: DOCK_GUTTER_PX }}
              onMouseDown={notesFolded ? undefined : startNotesResize}
              title={notesFolded ? undefined : 'Drag to resize notes'}
            />
          )}
          <NotesIsland
            wsPath={notesWs}
            height={dockHeight ? clampNotesHeight(notesHeight, notesRoom) : notesHeight}
            folded={notesFolded}
            focusNonce={notesFocus}
            onToggleFold={() => {
              const folding = !notesFolded
              setNotesFocus(0)
              setNotesFolded(folding)
              if (folding) returnFocus()
            }}
            onReturnFocus={returnFocus}
          />
        </div>
        <div className="side-me">
          <TopbarUsage />
          <button
            className={'tb-ico' + (keepAwake ? ' on' : '')}
            onClick={() => {
              const on = !keepAwake
              setSettings({ ...useStore.getState().settings, keepAwake: on })
              void window.api.settings.set({ keepAwake: on })
            }}
            title={keepAwake ? 'Keeping Mac awake — click to allow sleep' : 'Keep Mac awake'}
            aria-label="Keep Mac awake"
            aria-pressed={keepAwake}
          >
            <IconKeepAwake size={20} />
          </button>
          <button
            className="tb-ico"
            onClick={() => setSettingsOpen(true)}
            title="Settings"
            aria-label="Settings"
          >
            <IconSettings size={20} />
          </button>
        </div>
        <div
          className={'side-grip' + (sbDragging ? ' active' : '')}
          onMouseDown={startSidebarResize}
          title="Drag to resize sidebar"
        />
      </div>
      {/* PLATFORM§10 */}
      {(sbDragging || nbDragging || vDragging) && <div className="drag-overlay" />}
      <div className="center" ref={centerRef}>
        <div className="center-row">
          {sidebarHidden && panelFull && <div className="wb-full-drag" />}
          <div className="term-col" style={{ display: panelFull ? 'none' : undefined }}>
            <div className="center-top">
              <WorldClock />
            </div>
            <div className="island flat term-island">
              {signInTabId && activeTab?.id === signInTabId && (
                <div className="wb-bar">
                  <span className="wb-title">
                    <span className="nm">{activeTab.title}</span>
                  </span>
                  <button className="mini" onClick={() => closeTab(signInTabId)}>
                    Cancel
                  </button>
                </div>
              )}
              <div className="terminals">
                {tabs.flatMap((t) => [
                  t.ghost && (
                    <div
                      key={t.ghost}
                      className="term-wrap"
                      style={{
                        display:
                          (t.id === shown.id || t.ghost === shown.id) && !t.wakeOverdue
                            ? 'block'
                            : 'none'
                      }}
                      onMouseDown={focusTuiFromMargin}
                    >
                      <TerminalView
                        id={t.ghost}
                        active={(t.id === shown.id || t.ghost === shown.id) && !t.wakeOverdue}
                        scrollbar={false}
                        focusSignal={tuiFocus}
                        maxCols={CENTER_TERMINAL_MAX_COLS}
                      />
                    </div>
                  ),
                  <div
                    key={t.id}
                    className="term-wrap"
                    style={{
                      display: t.id === shown.id ? 'block' : 'none',
                      visibility: t.ghost && !t.wakeOverdue ? 'hidden' : undefined
                    }}
                    onMouseDown={focusTuiFromMargin}
                  >
                    <TerminalView
                      id={t.id}
                      active={t.id === shown.id && (!t.ghost || !!t.wakeOverdue)}
                      scrollbar={false}
                      maxCols={CENTER_TERMINAL_MAX_COLS}
                      onUserInput={
                        isSessionKind(t.kind)
                          ? () => window.api.sessions.noteActivity(t.id)
                          : undefined
                      }
                      focusSignal={tuiFocus}
                      onRepainted={() => {
                        if (t.id === activeTabId) setPaintedGen(switchGen)
                      }}
                      onOutput={
                        t.ghost && !t.wakeOverdue ? () => noteWakingOutput(t.id) : undefined
                      }
                    />
                    {/* CODEX§9 MUSE§10 AGY§5 */}
                    {t.resuming && (t.kind === 'claude' || t.kind === 'agy') && (
                      <ResumingMask title={t.title} />
                    )}
                  </div>
                ])}
                {switching && activeTab && (
                  <ResumingMask
                    title={activeSessionTitle ?? activeTab.title}
                    label={activeTab.resuming ? undefined : 'Loading session…'}
                    late={!activeTab.resuming}
                  />
                )}
                {resumeLaunch && <ResumingMask title={resumeLaunch.title} />}
                {!activeTab &&
                  !resumeLaunch &&
                  (welcomeActive ? (
                    <Onboarding onAddWorkspace={addWorkspace} onStartIn={startIn} />
                  ) : welcomeWs ? (
                    <div className="w-empty" tabIndex={-1}>
                      <div className="big">{basename(welcomeWs.workspace.path)}</div>
                      <div className="quiet">{welcomeQuietLine(welcomeRunning)}</div>
                      <WelcomeLaunch wsPath={welcomeWs.workspace.path} onStart={startIn} />
                      {welcomeWs.workspace.isGit && (
                        <button
                          className="mini"
                          onClick={() => requestNew('worktree', welcomeWs.workspace.path)}
                        >
                          New worktree session…
                        </button>
                      )}
                      {recentRows.length > 0 && (
                        <div className="recent-list">
                          <div className="recent-hd">Recent</div>
                          {recentRows.map((r) => (
                            <div
                              key={r.id}
                              className="recent-row"
                              title={
                                relTime(r.mtime, Date.now()) +
                                (r.invalidCwd
                                  ? ' — worktree deleted; click to rebuild and resume'
                                  : ' — click to resume')
                              }
                              onClick={() => resumeRecent(r)}
                            >
                              <div className="ws-tab-main">
                                <span className="ws-tab-title">{r.title}</span>
                              </div>
                              <div className="ws-tab-sub">
                                {mixesBackends(welcomeWs.rows) && (
                                  <SessionBackendIcon backend={r.backendId} />
                                )}
                                <span>{r.worktree}</span>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="w-empty">
                      <div className="big">No workspace yet</div>
                      <div className="quiet">Pick a folder to manage sessions in.</div>
                      <button
                        className="btn-primary"
                        style={{ marginTop: 6 }}
                        onClick={() => void addWorkspace()}
                      >
                        Choose Folder…
                      </button>
                      <div className="quiet key">⇧⌘O</div>
                      <button className="mini" onClick={() => setRemoteDialog(true)}>
                        Remote directory<span className="tag">alpha</span>…
                      </button>
                    </div>
                  ))}
              </div>
            </div>
          </div>
          {panelShown && !panelFull && (
            <div
              className={'gutter-v' + (vDragging ? ' active' : '')}
              onMouseDown={startVResize}
              title="Drag to resize"
            />
          )}
          {/* PLATFORM§9 */}
          {panelMounted && (
            <div
              className={
                'island wb-col' +
                (panelShown ? '' : ' off') +
                (panelFull ? ' full' : '') +
                (guestLit ? ' caret' : '') +
                (staged ? ' staged' : '')
              }
              ref={panelRef}
              // ADR-0011
              style={{
                ['--wb-w' as string]: `${shownWidth.current || panelWidth}px`,
                ...(panelFull
                  ? { flex: '1 1 auto' }
                  : panelShown
                    ? { width: liveWidth.current ?? panelWidth }
                    : staged
                      ? {
                          width: FIXED_VIEWPORT_FOR_OFFSCREEN_DRIVEN_PAGE.width,
                          height: FIXED_VIEWPORT_FOR_OFFSCREEN_DRIVEN_PAGE.height
                        }
                      : { width: 0 })
              }}
            >
              <WorkbenchPane
                tabId={panelTab ?? null}
                states={workbench}
                liveTabs={liveTabs}
                visible={panelOnScreen}
                full={panelFull}
                command={panelCmd}
                dialog={browserDialog}
                treeRoot={fileTreeRoot}
                activeTabId={landedTab?.id ?? null}
                onUpdate={updateWorkbenchTabs}
                onEvicted={onPanelTabEvicted}
                onExternalOpen={window.api.browser.openExternal}
                onCertProceed={window.api.browser.certProceed}
                onDialogAnswer={answerBrowserDialog}
                onToggleFull={toggleFull}
                panelFocus={panelFocus}
                onEscapeFellThrough={onPanelEscapeFellThrough}
                onReturnFocus={returnFocus}
                pinned={cdpAttached}
                tabForSession={panelTabForSession}
                cdpOps={cdpOps}
                onCdpDone={dropCdpOp}
                onCdpCreate={createCdpTab}
              />
              {switching && !staged && activeTab && (
                <ResumingMask
                  title={activeSessionTitle ?? activeTab.title}
                  label="Loading session…"
                  late
                />
              )}
            </div>
          )}
          {panelTab &&
            previewSlot &&
            (previewShown ? (
              <WorkbenchPreview
                tabId={panelTab}
                root={fileTreeRoot}
                width={PREVIEW_CARD_WIDTH_PX}
              />
            ) : (
              <div className="wb-peek-slot" style={{ width: PREVIEW_CARD_WIDTH_PX }} />
            ))}

          <div className="aux-icons">
            {(!landedTab || hasWorkbench(landedTab)) && (
              <button
                className={'aux-ico wb-toggle' + (panelShown ? ' on' : '')}
                aria-disabled={!panelReady}
                onClick={toggleWorkbench}
                title="Workbench (⇧⌘B)"
                aria-label="Workbench"
              >
                <IconSidebarRight size={18} />
              </button>
            )}
          </div>
        </div>
      </div>
      {/* PLATFORM§24 */}
      <button
        className={'aux-ico sb-toggle' + (sidebarHidden ? '' : ' on')}
        onClick={toggleSidebar}
        title="Sidebar (⌘B)"
        aria-label="Sidebar"
        aria-pressed={!sidebarHidden}
      >
        <IconSidebarLeft size={18} />
      </button>
      {waitingCount > 0 && (
        <button
          className="aux-ico waiting-bell"
          onClick={visitNextWaiting}
          title={`${sessionsNeedYou(waitingCount)} — click for the next one (⌘J)`}
          aria-label="Next waiting session"
        >
          <IconNotifications size={18} />
          <span className="ws-tab-parked ws-unread-count">{waitingCount}</span>
        </button>
      )}
      {/* ADR-0013 */}
      {createPortal(
        <>
          {paletteOpen && (
            <CommandPalette
              actions={paletteActions()}
              onClose={closePalette}
              onRouted={paletteRouted}
              onOpenHit={openSearchHit}
              choice={paletteChoice}
            />
          )}
          {newRequest && (
            <NewSessionDialog
              key={newRequest.id}
              mode={newRequest.mode}
              initialPath={newRequest.path}
              rows={workspaceRows}
              onClose={() => setNewRequest(null)}
              onStart={startSession}
              launchLock={newSessionLocked}
              pending={newRequest.pending}
              chosen={newRequest.chosen}
            />
          )}
          {newProject && (
            <NewProjectDialog
              key={newProject.id}
              seed={newProject.seed}
              launchLock={newSessionLocked}
              onClose={() => setNewProject(null)}
              onStart={startSession}
              onChangeWorkspace={pickWorkspaceForTyped}
            />
          )}
          {restoreWs && workspaceRows.some((w) => w.workspace.path === restoreWs) && (
            <RestoreDialog
              key={restoreWs}
              wsPath={restoreWs}
              onClose={() => setRestoreWs(null)}
              onRestore={(row) => {
                setRestoreWs(null)
                void resumeSession({
                  id: row.id,
                  backendId: row.backendId,
                  title: row.title,
                  restore: true
                })
              }}
            />
          )}
          {remoteDialog && (
            <RemoteWorkspaceDialog
              onAdd={(key) => void addRemoteWorkspace(key)}
              onClose={() => setRemoteDialog(false)}
            />
          )}
          {cronWs && (
            <CronJobsDialog
              key={cronWs.path}
              wsPath={cronWs.path}
              initialJobId={cronWs.jobId}
              onClose={() => setCronWs(null)}
            />
          )}
          <ResumeDialog />
          <CloseSessionDialog />
          <SettingsModal />
          <BindConductorDialog />
          <RenameButlerDialog />
          <UpdateModal />
          {assistDialogShown && (
            <AssistDialog
              setup={assistSetup}
              asked={assistAsked}
              onNotNow={() => {
                setAssistSetupLater(true)
                setAssistAsked(false)
              }}
            />
          )}
          <UnsavedDialog />
        </>,
        document.body
      )}
      {overlay?.open && <BrowserOverlay url={overlay.url} onClose={closeOverlay} />}
      {extAsks[0] && (
        <ExtensionConfirm
          key={extAsks[0].id}
          request={extAsks[0]}
          onAnswer={(id, granted) => {
            setExtAsks((q) => q.filter((r) => r.id !== id))
            window.api.extensions.answerPermissionRequest(id, granted)
          }}
        />
      )}
      {hint && <Hint {...hint} />}
    </div>
  )
}
