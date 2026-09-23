import { NewSessionDialog } from './components/NewSessionDialog'
import { SessionBackendIcon } from './components/SessionBackendIcon'
import { effectiveBackend, SESSION_BACKENDS } from '@shared/sessionBackend'
import { backendLabel, hasWorkbench, launchErrorMessage, type SessionBackend } from './agentUi'
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
import {
  LuSettings,
  LuFolderPlus,
  LuPanelRight,
  LuAppWindow,
  LuCoffee,
  LuCircleArrowUp,
  LuChevronRight
} from 'react-icons/lu'
import type {
  BrowserAuthChallenge,
  BrowserCdpOp,
  BrowserJsDialog,
  ExtensionPermissionRequest,
  SessionRow,
  WorkspaceRows
} from '@shared/types'
import {
  useStore,
  openInterceptedFile,
  boundSessionId,
  consumeRestartExit,
  conversationTabFor,
  tabForSession,
  consumeRestoreExit,
  tabEvictedNotice,
  panelTabId,
  panelIsOpen
} from './store'
import { WORKBENCH_PANE_MIN } from './auxSurface'
import {
  clampNotesHeight,
  currentWorkspace,
  DOCK_GUTTER_PX,
  mixesBackends,
  notesHeightFromDrag,
  paneWidthFromDrag,
  relTime,
  selectionRoot,
  welcomeQuietLine,
  welcomeTarget
} from './sessionRows'
import { beginLayoutDrag, endLayoutDrag } from './resizeGate'
import { closeTabIntent, unexpectedExitNotice, unexpectedExitWanted } from './closeSession'
import {
  allDirty,
  dirtyIn,
  discardAll,
  flushNotes,
  labelPaths,
  saveAll,
  subscribeDirtyTabs,
  subscribeMenuFlags
} from './unsavedGuard'
import { browserOpenTargetSession, overlayPresentation } from './browserOpenTarget'

/** S1 — the box the Browser column keeps while an agent is driving a page and the
 *  column is off screen. Fixed, because a page's own layout must not change under the
 *  agent when the user opens or closes the panel; big enough to be a real viewport. */
const STAGE_SIZE = { width: 1000, height: 700 }
import { rearmResume, releaseResume, resumeSession, RESTORE_FAILED_NOTICE } from './resumeFlow'
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
import { pickerRows, pullable, skipPicker, type PickerMode } from './workspacePicker'
import { RestoreDialog } from './components/RestoreDialog'
import { CronJobsDialog } from './components/CronJobsDialog'
import { RemoteWorkspaceDialog } from './components/RemoteWorkspaceDialog'
import { isRemoteKey } from '@shared/remoteKey'
import { WorkbenchPane } from './components/WorkbenchPane'
import type { WorkbenchCommandSignal } from './components/workbenchCommands'
import { ExtensionConfirm } from './components/ExtensionConfirm'
import { tabLabel } from './components/workbenchTabs'
import { SettingsModal } from './components/settings/SettingsModal'
import { loginClearDelay, savedClearDue } from './components/settings/loginFlow'
import { TopbarUsage } from './components/TopbarUsage'
import { WorldClock } from './components/WorldClock'
import { UpdateModal } from './components/UpdateModal'
import { Onboarding } from './components/Onboarding'
import { BrowserOverlay } from './components/BrowserOverlay'
import { Hint } from './components/Hint'
import { useHints } from './useHints'

/** How many cold rows the S4 welcome panel lists under "Recent". */
const RECENT_MAX = 3

/** D11: main would not build a launch line for what was asked (an illegal `-w` name).
 *  Nothing spawned, so the only evidence of the click is this. */
const LAUNCH_REFUSED_NOTICE = 'Could not start the session — invalid launch arguments'

/** D2: both global gestures aim at a workspace, and with none pinned there is nothing
 *  to aim at — said out loud, where ⌘N used to be a silent no-op (A2). */
const NO_WORKSPACE_NOTICE = 'No workspace yet — add one first (⇧⌘O)'
/** D10: …and ⇧⌘N needs a repo, not merely a folder. */
const NO_GIT_NOTICE = 'no git repository among your workspaces — no worktrees here'
/** The panel keys still exist on a Codex tab; a key that does nothing at all reads as
 *  broken, so it says why instead. "yet" because this one is temporary. */
const NO_CODEX_WORKBENCH_NOTICE = 'Codex sessions have no Workbench yet'

/** R9 — claude moved this session into another checkout and the panels came along.
 *  Said only for the conversation the user is looking at: for any other one the panels
 *  in front of them did not move, and saying they did would be a lie. */
function relocatedNotice(dir: string): string {
  return `Workbench followed Claude to ${basename(dir)}`
}

/**
 * R6 — the caret is inside a shell's own input layer.
 *
 * Judged by WHERE THE CARET IS, never by which KIND of tab is active, and that is the
 * whole point: a terminal tab can have the panel's find bar or its ＋ menu open over it,
 * and those have to close on Esc like anywhere else. Stepping aside for the whole kind
 * would leave them unclosable.
 */
function caretInShell(): boolean {
  return !!document.activeElement?.closest('.xterm')
}

/**
 * The Workbench panel, when it holds the focus — the other side of the ⌘T / ⌘W split.
 * `data-surface` is only on the panel while it is actually showing, so a collapsed panel
 * (still mounted, zero width, guests alive) can never be the answer.
 *
 * FR-20's blanket rests on this: with the panel unfocused every focus-scoped key keeps
 * exactly today's meaning — ⌘W closes the session, ⌘T does nothing at all. Every shell
 * lives INSIDE the panel now (R2), so there is no second focus holder to arbitrate
 * against, only the panel and everything that is not it.
 */
function focusedWorkbench(): HTMLElement | null {
  return (document.activeElement?.closest('.wb-panel[data-surface]') as HTMLElement | null) ?? null
}

/**
 * is the caret in the NOTE's text box? The keys that mean one thing inside the note
 * and another outside it (⌘S, ⌥⌘N) ask this.
 *
 * The box itself, not the island around it: clicking Fold or Copy path leaves the focus on
 * that button, and a button in the head band is not "typing in the note" — a ⌥⌘N after such
 * a click means "put me in the note", not "take me out of it".
 */
function caretInNote(): boolean {
  return !!document.activeElement?.matches('.isl-notes .ed-area')
}

/**
 * D5/R13, the one case the focus ring's CSS cannot see for itself.
 *
 * MEASURED on Electron 43 (T-FX-01's probe): a click inside a guest page makes
 * the `<webview>` element `document.activeElement` — so `closest()` above, and every key
 * that goes through it, is right — but that element matches neither `:focus` nor
 * `:focus-within`, on itself or on any ancestor. The guest lives in another process and
 * the host document simply never marks the tag as focused. Two other routes were
 * measured and rejected the same day: the element fires no `focus` event, and the guest's
 * own `webContents` fires neither `focus` nor `blur`.
 *
 * What IS observable is the departure: the element the caret leaves fires `focusout`
 * (and a return to any real element fires `focusin`). So the answer is re-read from
 * `activeElement` on every focus event, one turn later — `focusout` fires while the old
 * element is still the active one. A click into a guest from a host with NOTHING focused
 * would be missed, and self-heals on the next focus event; in the app something always
 * holds the caret, because the product puts it somewhere.
 *
 * The window's own focus is the second half, and it is what §05's "opening the Settings
 * window leaves both dark" rests on. A window losing focus stops matching `:focus-within`,
 * so the TUI's ring goes out on its own — but a guest reports no blur of any kind, so this
 * boolean would stay true and the panel would keep its ring while the user is in another
 * window entirely. That half comes from MAIN (`window.api.windowFocus`), not from
 * `document.hasFocus()`: measured on a real window in the manual round, the host document
 * answers `hasFocus() === false` the whole time a guest holds the caret, which turned the
 * ring off exactly while the user was typing into a page. Headless never showed it —
 * there `hasFocus()` is always true — so only the BrowserWindow's own focus/blur can tell
 * "the caret went into a page" from "the user left the window".
 */
let windowFocused = true
function guestHasCaret(): boolean {
  return windowFocused && document.activeElement?.tagName === 'WEBVIEW'
}

/**
 * …and the same tab, but only when its panel is one the user may ACT on — the live half
 * of `panelReady` below, for the keyboard paths that read the store directly.
 *
 * A conversation tab exists from the moment its pty does, so `panelTabId` alone would arm
 * ⇧⌘B / ⌘⏎ / ⌘⇧F during a resume's pre-bind window, where §04 keeps them greyed. The
 * icon and the keys have to agree, so both come from here.
 */
function panelActionTab(): string | undefined {
  const st = useStore.getState()
  const id = panelTabId(st)
  if (!id) return undefined
  const tab = st.tabs.find((t) => t.id === id)
  if (tab?.resuming) return undefined
  return boundSessionId(st, id) ? id : undefined
}

/**
 * …and the same tab again, narrowed once more to R5's gate for opening a SHELL in it.
 *
 * Two of the three states R5 greys are already `panelActionTab`'s: the welcome page has
 * nothing to open a shell in (D1), and a resume has not bound yet. The third is the one
 * clause added here — the session behind the tab has to be ALIVE, because a shell belongs
 * to a claude (D2). Since a claude that exits takes its tab with it, so what this
 * still guards is the narrow window where the tab is on screen and the session entry
 * already reports the process gone.
 */
function terminalActionTab(): string | undefined {
  const id = panelActionTab()
  if (!id) return undefined
  const st = useStore.getState()
  return st.sessions.some((s) => s.tabId === id && s.alive && s.sessionId) ? id : undefined
}

/** …and whether the tab those two just refused is a Codex one, which is the only kind
 *  whose Workbench is merely not built yet. */
function codexTabSelected(): boolean {
  const st = useStore.getState()
  return st.tabs.find((t) => t.id === st.activeTabId)?.kind === 'codex'
}

/**
 * FR-36 — whether there is a guest ON SCREEN for ⌘R / ⌘0± / ⌥⌘I to act on; otherwise
 * they keep their whole-window meaning (⌘R: none at all). Read live so the shortcut
 * listeners stay subscribed once.
 *
 * "On screen" is three clauses, and the active tab's kind is only the last. The panel
 * must be showing — T2 or T3, and T3 is derived from T2's own `open` flag (`panelIsOpen`
 * above, which this shares), so that one flag answers it. Checking the kind alone let a
 * panel collapsed on a `web` tab keep the keys: ⌘R reloaded — or mounted and loaded — a
 * guest nobody could see, ⌘0± zoomed the hidden page instead of the window, ⌥⌘I opened
 * DevTools for it. And the session must be live: FR-25 reclaims a cold session's guests,
 * so its `web` tab is a url with no page behind it.
 */
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

/** The loading state over the term island — names the session so a click on the wrong
 *  row is caught while it is still cheap to go back. `late` holds the words back for a
 *  beat (styles.css): a switch that lands within a frame or two must not blink a caption. */
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
  // Two-phase session switch. Displaying a hidden tab un-pauses its xterm,
  // whose first full render then runs synchronously inside the visibility callback —
  // BEFORE the browser paints. On a screen full of CJK at 2560×1440 that is 0.1–0.8s of
  // glyph rasterization on the main thread, and it used to sit between the click and the
  // first changed pixel: no highlight, no switch, then everything at once. So the click's
  // own frame paints only the row highlight and a loading mask naming the target; the
  // target's wrap is displayed two frames later (`shown`), and the mask comes down once
  // that xterm reports its first repaint (`paintedGen`). Whatever the render costs, it is
  // spent behind a mask that already answered the click. `switchGen` counts switches so a
  // return to a tab painted earlier still waits for THIS show's repaint.
  const [switchFrom, setSwitchFrom] = useState(activeTabId)
  const [switchGen, setSwitchGen] = useState(0)
  if (switchFrom !== activeTabId) {
    // adjust-state-during-render: React re-renders at once, so the mask is in the same
    // commit as the highlight — an effect would land it a frame late
    setSwitchFrom(activeTabId)
    setSwitchGen((g) => g + 1)
  }
  const [shown, setShown] = useState({ id: activeTabId, gen: 0 })
  const [paintedGen, setPaintedGen] = useState(0)
  useEffect(() => {
    if (shown.gen === switchGen) return
    if (shown.id === activeTabId) {
      // away and straight back before the first switch landed: the target never left
      // the screen, so there is nothing to display and no repaint coming to wait for
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
  }, [activeTabId, switchGen, shown.gen])
  /** A session switch is in flight: from the click until the target's xterm has painted.
   *  Both islands wear a mask for exactly this window (rendered below). */
  const switching = activeTabId !== null && (shown.gen !== switchGen || paintedGen !== switchGen)
  const sessions = useStore((s) => s.sessions)
  const workbenchWidth = useStore((s) => s.workbenchWidth)
  const workbenchWidths = useStore((s) => s.workbenchWidths)
  const workbench = useStore((s) => s.workbench)
  const workbenchOpen = useStore((s) => s.workbenchOpen)
  const workbenchFull = useStore((s) => s.workbenchFull)
  const workbenchLoad = useStore((s) => s.workbenchLoad)
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
  const selectedWs = useStore((s) => s.selectedWs)
  const [notesFocus, setNotesFocus] = useState(0)
  const [nbDragging, setNbDragging] = useState(false)
  /** The workspace whose note is on screen (`notesWs`, worked out far below), for the
   *  keyboard listeners up here — they subscribe once and must not be torn down and
   *  rebuilt on every workspace switch just to see the new value. */
  const notesWsRef = useRef<string | null>(null)

  const newRequestId = useRef(0)
  const newSessionLocked = useRef(false)
  const [newRequest, setNewRequest] = useState<{
    id: number
    mode: PickerMode
    path?: string
  } | null>(null)
  /** C9 (D9): the workspace whose Restore dialog is up — the menu item is its one door */
  const [restoreWs, setRestoreWs] = useState<string | null>(null)
  /** the workspace whose Scheduled jobs dialog is up, and the job to open it on.
   *  The menu item names no job; the sidebar's forecast row names the one it just said
   *  would run next, so the dialog opens on that card. */
  const [cronWs, setCronWs] = useState<{ path: string; jobId?: string } | null>(null)
  /** the ⊞ button's two-item menu, and the remote form it opens. */
  const [addMenu, setAddMenu] = useState(false)
  const [remoteDialog, setRemoteDialog] = useState(false)
  /** the command the panel has yet to run; re-firing the same one bumps the nonce, which
   *  is what makes a second ⌘R a second reload */
  const [panelCmd, setPanelCmd] = useState<WorkbenchCommandSignal | null>(null)
  /** the challenge main handed over for the app's own modal, or null (SEC-10) */
  const [browserDialog, setBrowserDialog] = useState<BrowserAuthChallenge | BrowserJsDialog | null>(
    null
  )
  /** what extensions are waiting to be asked (browser-extensions D7), oldest first. A
   *  queue, not one slot: two asks can be in flight at once, and a second one dropped on
   *  top of the first leaves whatever raised it stopped inside its call forever. */
  const [extAsks, setExtAsks] = useState<ExtensionPermissionRequest[]>([])
  const dispatchPanel = useCallback((id: WorkbenchCommandSignal['id']): void => {
    setPanelCmd((prev) => ({ id, nonce: (prev?.nonce ?? 0) + 1 }))
  }, [])

  /** bumped to hand the focus back to the selected session's TUI. The retired island's
   *  §03A return CHAIN went with it (there is no second island to hand focus back from);
   *  the counter stays because the panel's own Esc still ends there (R17, P3). */
  const [tuiFocus, setTuiFocus] = useState(0)

  /**
   * D5 — sending the caret back to the CENTRE, which is the picked session's
   * terminal, or the welcome panel when no session is picked (it is focusable for exactly
   * this reason). Every route that hands the caret back comes here — Esc in the note, a
   * second ⌥⌘N, ⇧⌘B collapsing the panel and the panel's own Esc — so there is ONE answer
   * to "where does the caret go", and it is declared above the first of them on purpose.
   */
  const returnFocus = useCallback((): void => {
    const st = useStore.getState()
    // In full-width Workbench (T3) the centre is `display:none`, so handing the caret to it
    // would be handing it to a box nobody can see, and the key would look dead. Coming home
    // therefore comes out of full width first — the same step the panel's own Esc takes on
    // its way back to T2.
    if (st.workbenchFull) st.setWorkbenchFull(false)
    if (st.activeTabId) setTuiFocus((n) => n + 1)
    else (document.querySelector('.w-empty') as HTMLElement | null)?.focus()
  }, [])

  /**
   * FR-06 — ⇧⌘B and the titlebar icon are the same gesture: T1→T2, T2→T1, and from T3
   * straight to T1 in ONE step rather than stopping at T2. The one-step rule is why T3
   * is cleared here as well as toggling `open`: leaving the full-width flag set would
   * make the next expand come back full-width, which no gesture asked for.
   *
   * FR-04: with no session selected there is nothing to attach a panel to, so this is a
   * no-op and the icon carries `aria-disabled`.
   */
  const toggleWorkbench = useCallback((): void => {
    const st = useStore.getState()
    const tabId = panelActionTab()
    if (!tabId) {
      if (codexTabSelected()) st.showToast(NO_CODEX_WORKBENCH_NOTICE)
      return
    }
    const open = panelIsOpen(st, tabId)
    const next = !(open || st.workbenchFull)
    if (st.workbenchFull) st.setWorkbenchFull(false)
    st.setWorkbenchOpen(tabId, next)
    // R15 — ⇧⌘B carries the caret with it, both ways. Expanding without it would
    // light the panel's ring on a panel the keyboard cannot reach; collapsing without it
    // would leave the focus on a zero-width column, i.e. nowhere the user can see.
    if (next) setPanelFocus((n) => n + 1)
    else returnFocus()
  }, [returnFocus])

  /**
   * FR-05 — ⌘⏎ (and the kind bar's ⤢) move between T2 and T3. At T1 it is a no-op: the
   * panel is collapsed, so there is nothing to give the whole row to, and expanding on
   * ⌘⏎ would make one key mean two different things depending on a state the user
   * cannot see. The menu item is disabled outright with no active session (FR-04).
   *
   * T3 is neither persisted nor per-session (FR-07), which is why this writes a global
   * flag and never touches `workbenchOpen`.
   */
  const toggleFull = useCallback((): void => {
    const st = useStore.getState()
    const tabId = panelActionTab()
    if (!tabId) return
    if (!st.workbenchFull && !panelIsOpen(st, tabId)) return
    const nextFull = !st.workbenchFull
    st.setWorkbenchFull(nextFull)
    // R16 — T3 hides the conversation outright, so a caret left there is a caret
    // lost: going full width takes it into the panel. Coming BACK to side-by-side moves
    // nothing — the panel is still on screen and still the island the user is working in.
    if (nextFull) setPanelFocus((n) => n + 1)
  }, [])
  /** §03A cold-start guard: whether the FIRST workspace:rows push has landed. Before it
   *  has, "nothing pinned" is unknown rather than true, so both global keys stay the
   *  silent no-op they are today (a toast here would be a lie about the user's setup) and
   *'s welcome holds off — the first push lands after the first paint, so deciding
   *  from an empty `workspaceRows` alone would open the welcome on every launch. */
  const [rowsLoaded, setRowsLoaded] = useState(false)

  /** Which session methods this Mac actually has, or null while the probes are out. Two
   *  independent asks: a Mac without Codex must not make Claude look missing too. */
  const [probed, setProbed] = useState<Record<SessionBackend, boolean> | null>(null)
  useEffect(() => {
    let alive = true
    void Promise.all([
      window.api.claude.probe().then(
        (r) => r.found,
        () => false
      ),
      window.api.sessions.backends().then(
        (list) => list.some((b) => b.id === 'codex' && b.available),
        () => false
      )
    ]).then(([claude, codex]) => {
      if (alive) setProbed({ claude, codex })
    })
    return () => {
      alive = false
    }
  }, [])
  /** Optimistic while the probes are out: ⌘N ⏎ never waits on a login shell, and main
   *  refuses a method it cannot run, in its own words. */
  const installed = useMemo(
    () => new Set(probed ? SESSION_BACKENDS.filter((b) => probed[b]) : SESSION_BACKENDS),
    [probed]
  )
  const sessionMethods = useStore((s) => s.settings.sessionMethods)
  /** Both methods, the default first, for the entrances that name them outright — a
   *  context-menu pair and a welcome button pair. With only one method to hand there is
   *  nothing to choose between, so those entrances say plain "New session" instead. */
  const namedMethods = useMemo((): [SessionBackend, SessionBackend] | null => {
    if (!probed) return null
    const usable = SESSION_BACKENDS.filter((b) => sessionMethods.enabled[b] && probed[b])
    if (usable.length < 2) return null
    const other = usable.find((b) => b !== sessionMethods.defaultBackend)
    return other ? [sessionMethods.defaultBackend, other] : null
  }, [probed, sessionMethods])

  const startSession = useCallback(
    async (
      opts: { cwd: string; worktree?: string; worktreeResourceId?: string },
      backend: SessionBackend
    ): Promise<void> => {
      const res = await window.api.terminal.create({ kind: backend, ...opts })
      if (!res.ok) throw new Error(LAUNCH_REFUSED_NOTICE)
      addTab({ id: res.id, kind: backend, title: backendLabel(backend), cwd: res.cwd, alive: true })
    },
    [addTab]
  )

  const requestNew = useCallback((mode: PickerMode, path?: string): void => {
    if (newSessionLocked.current) return
    setRestoreWs(null)
    setNewRequest({ id: ++newRequestId.current, mode, path })
  }, [])

  /** §03B: a per-workspace direct launch (workspace context menu, welcome primary, the
   *  head's ＋, Onboarding's Start, single-workspace ⌘N). The entrance names its own
   *  workspace, so nothing is asked — unless that workspace is behind-and-pullable, where
   *  it meets C10's gate form (D6a has no back door). `backend` is the second-method
   *  entrance naming itself; everything else takes whichever method can actually run. */
  const startIn = useCallback(
    (wsPath: string, backend?: SessionBackend): void => {
      const ws = useStore.getState().workspaceRows.find((w) => w.workspace.path === wsPath)
      if (!ws) return
      if (pullable(ws)) {
        requestNew('main', wsPath)
        return
      }
      if (newSessionLocked.current) return
      newSessionLocked.current = true
      void startSession({ cwd: wsPath }, backend ?? effectiveBackend(sessionMethods, installed))
        .catch((e) => showToast(launchErrorMessage(e)))
        .finally(() => {
          newSessionLocked.current = false
        })
    },
    [installed, requestNew, sessionMethods, showToast, startSession]
  )

  /** ⌘N / ⇧⌘N (D13): the global keys aim at no workspace of their own, so they open the
   *  picker — unless it has nothing to offer (toast) or nothing to choose (skip). */
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

  /** R15/R16 — the same idea pointing the other way: bumped to send the caret INTO
   *  the panel, where `WorkbenchPane` lands it on whatever the active tab's kind asks for
   *  (a guest, the panel root, a shell). Deliberately not `focusNonce` — the editor
   *  already owns that name one level down — and deliberately a counter rather than a
   *  boolean, because "focus the panel again" is a real gesture and a boolean cannot say
   *  it twice. The pane seeds its "last seen" value at 0, so mounting never steals the
   *  caret; only a bump does. */
  const [panelFocus, setPanelFocus] = useState(0)

  /** D5 — the ring's one JS-fed input: does a guest page hold the caret right now
   *  (`guestHasCaret` says why CSS cannot answer this). Re-read one turn after every
   *  focus event, because `focusout` fires while the OLD element is still the active
   *  one. Everything else about the ring stays pure CSS. */
  const [guestLit, setGuestLit] = useState(false)
  useEffect(() => {
    let queued = 0
    const recheck = (): void => {
      window.clearTimeout(queued)
      queued = window.setTimeout(() => setGuestLit(guestHasCaret()), 0)
    }
    document.addEventListener('focusin', recheck, true)
    document.addEventListener('focusout', recheck, true)
    // …and the window's own comings and goings, which fire no focus event on any element:
    // a guest keeping the caret while Settings opens over it is exactly the state §05 says
    // must leave both islands dark, and `guestHasCaret` can only see it from here.
    window.addEventListener('blur', recheck)
    window.addEventListener('focus', recheck)
    // …read from main, because the host document cannot tell a guest taking the caret
    // from the window losing it (`guestHasCaret` says why)
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
  // the caret was PUT in the panel rather than moved by the user, so no focus event on a
  // real element need have fired at all (⇧⌘B onto a web tab focuses the guest directly)
  useEffect(() => {
    if (!panelFocus) return undefined
    // one frame, to land after the pane's own deferred focus: React runs a child's
    // effects before its parent's, so the pane queued its rAF first and runs first
    const raf = requestAnimationFrame(() => setGuestLit(guestHasCaret()))
    return () => cancelAnimationFrame(raf)
  }, [panelFocus])

  /**
   * D3/R5 — ⌃` (View → New Terminal Tab) and the strip's ＋ ▸ New terminal are the
   * SAME gesture: open one more shell in the selected conversation tab's panel. Not a toggle
   * any more — the island's three states went with the island, and there is nothing left
   * for a second press to collapse.
   *
   * The three greyed states (nothing selected, still binding, claude gone) are gated
   * here and reported by `terminalReady` to main's menu item, so the key and the menu can
   * never disagree. Everything past that — the cap, the spawn, the panel, the caret —
   * belongs to `openTerminalTab`.
   */
  const newTerminalTab = useCallback((): void => {
    const tabId = terminalActionTab()
    if (!tabId) {
      if (codexTabSelected()) useStore.getState().showToast(NO_CODEX_WORKBENCH_NOTICE)
      return
    }
    useStore.getState().openTerminalTab(tabId)
  }, [])

  // keyboard shortcuts forwarded from the app menu (⌘N / ⌘W / ⇧⌘R). Read live state
  // from the store inside the handlers so the listeners stay subscribed once.
  useEffect(() => {
    // ⌘W (the lifecycle contract D3 + R6): inside the panel it closes the panel's active tab
    // — a shell included, killed without a word, since a shell is not a session and holds
    // nothing to save. Outside the panel it closes the active conversation tab: a pending
    // launch is still its Cancel (T-KEY-02), and a bound session now closes too — after
    // one confirmation while it is working / on a permission prompt (D3 reverses the
    // earlier ban).
    const closeActive = (): void => {
      const st = useStore.getState()
      // with the caret in the note there is nothing here to close, so ⌘W does
      // nothing. Without this it reaches past the note and closes the picked SESSION,
      // which is a big thing to lose to a key pressed while typing a shopping list.
      if (document.activeElement?.closest('.isl-notes')) return
      // FR-17/18: inside the panel ⌘W closes the ACTIVE tab — and does nothing at all on
      // the pinned `files` one, which is the panel's own no-op rather than a fall-through
      // to the session (that would close the session behind a tab the user meant to keep).
      // Unlike the former Browser, the last close never takes the panel down: `files`
      // is unclosable, so there is no "last tab" (FR-02/FR-19).
      if (focusedWorkbench()) {
        dispatchPanel('browser-close-tab')
        return
      }
      const tab = st.tabs.find((t) => t.id === st.activeTabId)
      const intent = closeTabIntent(tab, st.sessions)
      if (intent.kind === 'none') return
      // file-edit B-25 + D8: the panel's buffers hang off the CONVERSATION TAB, so the
      // tab being closed is the key — no session id to resolve, and a `/clear` in between
      // no longer hides the unsaved work behind an id nobody is asking about.
      const dirty = dirtyIn(tab!.id)
      // the close itself, once the files have been dealt with
      const close = (): void => {
        // cancelling a resume that never bound ends it: the row stays cold, so nothing
        // else would ever let go of its in-flight latch and the row would go inert
        if (tab!.sessionId) releaseResume(tab!.sessionId)
        st.closeTab(tab!.id)
      }
      if (intent.kind === 'confirm') {
        // B-25: running AND dirty is still ONE question — the D3 dialog grows a third
        // button rather than a second dialog appearing behind the first
        st.setCloseConfirm({
          tabId: tab!.id,
          title: intent.title,
          status: intent.status,
          ...(dirty.length
            ? {
                unsaved: {
                  files: labelPaths(dirty),
                  discard: () => discardAll(dirty),
                  save: () => saveAll(dirty)
                }
              }
            : {})
        })
        return
      }
      // B-25: an idle session closes without a word normally, so unsaved files are the
      // only thing left to ask about — the plain figure-3 dialog, not D3's
      if (dirty.length) {
        st.setUnsavedPrompt({
          files: labelPaths(dirty),
          onCancel: () => {},
          onDiscard: () => {
            discardAll(dirty)
            close()
          },
          onSave: async () => {
            const ok = await saveAll(dirty)
            useStore.getState().setUnsavedPrompt(null)
            // only a save that reached the disk closes the session — otherwise the tab
            // saveAll just brought forward is the one copy of that work
            if (ok) close()
          }
        })
        return
      }
      close()
    }
    // ⌘N / ⇧⌘N (D1/D8): both go through C10, which answers "which workspace" and then
    // hands the confirmed one to a direct launch (⌘N) or to C8 (⇧⌘N).
    const offNewSession = window.api.shortcuts.onNewSession(() => globalNew('main'))
    const offNewWorktree = window.api.shortcuts.onNewWorktreeSession(() => globalNew('worktree'))
    const offClose = window.api.shortcuts.onCloseTab(closeActive)
    const offRestart = window.api.shortcuts.onRestartSession(() =>
      useStore.getState().restartActiveSession()
    )
    const offNewTerminal = window.api.shortcuts.onNewTerminalTab(newTerminalTab)
    // ⌘T has no menu accelerator to forward it (menu.ts leaves the key unbound so a
    // focused shell or guest can own it), so the real keystroke is caught here — in the
    // capture phase, ahead of xterm's own key handling. ⌘⌥←/→ and Esc ride the same listener: they are
    // panel-scoped (FR-53/54) and a menu accelerator would starve a focused guest page
    // of them forever, which is the same reason ⌘1–9 was refused outright.
    const onKeyDown = (e: KeyboardEvent): void => {
      // FR-53: cycle tabs, active only while the panel holds the focus
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
      // FR-54 + R6: the Esc ladder is the panel's ONLY while the panel holds the
      // focus, and not even then if the caret is in a shell — Esc in the TUI stays
      // Claude's interrupt, and Esc in a terminal tab is the shell's (vim, a menu, a
      // prompt). Both cases must fall through WITHOUT preventDefault, or the key never
      // reaches the pty at all. The test is the caret, not the tab kind: `caretInShell`
      // says why.
      if (e.key === 'Escape') {
        if (!focusedWorkbench() || caretInShell()) return
        e.preventDefault()
        dispatchPanel('escape')
        return
      }
      if (e.key !== 't' && e.key !== 'T') return
      if (!e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
      // FR-52 + R6: ⌘T creates a tab of the same kind as the active one, a shell
      // included. FR-20 keeps the other branch exactly as it is — with the focus anywhere
      // but the panel, ⌘T does nothing at all.
      if (!focusedWorkbench()) return
      e.preventDefault()
      dispatchPanel('browser-new-tab')
    }
    document.addEventListener('keydown', onKeyDown, true)
    // e2e handshake: a menu-forwarded shortcut sent before these listeners exist is
    // silently dropped, so tests must be able to wait for attachment before sending
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

  // D9/IMPL-4: every Browser accelerator arrives on one channel, and commandTarget is
  // the whole arbitration (Q2) — the two toggles belong to the app, the rest act on the
  // guest while the Browser holds the column, and ⌥⌘I / ⌘0± fall back to the whole
  // window otherwise. ⌘R has no such fallback on purpose: over a Preview it must land
  // nowhere rather than reload the Koloft renderer and take every live xterm with it.
  useEffect(() => {
    return window.api.shortcuts.onBrowserCommand((cmd) => {
      // D6/R14 — the web keys go to the island that is LIT, and being lit means
      // holding the keyboard focus. Two clauses, both required: the panel has the caret
      // (`focusedWorkbench`) AND its active tab is a web one with a page behind it
      // (`activeTabIsWeb`: panel showing, session live, active tab `web`).
      //
      // "Is a guest on screen" was the old question and it is the wrong one: with the
      // caret in the conversation a ⌘R meant for claude reloaded a page the user was not
      // even looking at. The ring and the keys must say the same thing, so the ring's
      // rule is the keys' rule. With the conversation lit, ⌘R ⌘L ⌘[ ⌘] do nothing at all
      // and ⌘0± ⌥⌘I fall back to their whole-window meaning — same as a lit panel sitting
      // on a Files or file tab. The two TAB commands are exempt inside `commandTarget`:
      // a menu pick with the mouse is a direct order to the panel, not a focus question.
      const target = commandTarget(cmd, !!focusedWorkbench() && activeTabIsWeb())
      if (target.to === 'app') {
        // ⇧⌘B keeps its accelerator (menu.ts:183) and now toggles the whole panel;
        // ⌘⏎ keeps Focus Mode's and now toggles T2↔T3 (FR-05/06).
        if (target.cmd === 'toggle-browser') toggleWorkbench()
        else toggleFull()
      } else if (target.to === 'browser') {
        // The two TAB commands come through whatever is on screen (commandTarget's
        // note): their menu items are never disabled, and they are the only panel commands
        // that can arrive with the panel collapsed or not yet mounted — every other route
        // is gated on the panel holding the focus or on a guest showing. The signal is
        // state App holds, so an ungated dispatch was stored and REPLAYED on the panel's
        // first mount: a Close Browser Tab picked on the welcome screen closed a tab when a
        // session was later selected.
        //
        // They fork by what they do. New Browser Tab is a creation, and a pick from the
        // View menu is user intent as plainly as ⌘⇧F is (FR-45): it expands a collapsed
        // panel first and pre-arms the command for the mount, exactly as `onFindFiles`
        // does — a menu item that visibly does nothing is a broken item, and the panel
        // opening on that intent is not "automatically". Close Browser Tab is a removal,
        // and a removal that cannot be seen must not happen: with the panel collapsed it
        // is dropped, keeping FR-20's rule that off screen the panel's keys carry no panel
        // meaning. Neither has anything to act on with no session (FR-04).
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

  // FR-53: ⌘⌥←/→ carried out of a focused guest by main. It arrives already knowing the
  // focus was inside a page, i.e. inside the panel, so it needs no focus test of its own
  // — App's own capture listener never sees these events, since they happen in the
  // guest's render process and would otherwise go dead exactly while a page is focused.
  useEffect(() => {
    return window.api.shortcuts.onWorkbenchShortcut(dispatchPanel)
  }, [dispatchPanel])

  // FR-35: ⌘F reaches the panel only while the panel holds the FOCUS — with the focus in
  // the TUI it keeps its pre-panel meaning, and a shell inside the panel answers it with
  // nothing at all (R6). This is deliberately NARROWER
  // than the former FilePane, which armed find while it was merely visible: after the
  // merge the panel is visible beside the TUI most of the time, so visibility-arming
  // would open a find bar over a surface the user is not typing in. FR-20's blanket names
  // the focus as the one arbiter for every focus-scoped key, and FR-35 lists ⌘F among
  // them. The panel owns the one find bar there is, so nothing else arms this channel and
  // two bars can never coexist.
  useEffect(() => {
    return window.api.shortcuts.onFind(() => {
      if (focusedWorkbench()) dispatchPanel('find')
    })
  }, [dispatchPanel])

  // file-edit B-26: main blocked a quit to ask this. It must be answered every time —
  // silence for a few seconds and main quits regardless — so the two branches both end
  // in a reply: nothing dirty approves at once, and anything dirty HOLDS the quit while
  // the question is up. Cancel then needs no further message: the hold already put main
  // back at rest, so the app simply stays open and the next ⌘Q asks again.
  useEffect(() => {
    return window.api.app.onQuitRequested(() => {
      // N07 — the note saves itself, so quitting inside its 600 ms window must WRITE
      // it, not ask about it. One IPC write per note, and only for the ones that may save
      // themselves; a note under a conflict bar falls through to the question below.
      void flushNotes().then(() => {
        const dirty = allDirty()
        if (dirty.length === 0) {
          window.api.app.approveQuit()
          return
        }
        window.api.app.holdQuit()
        useStore.getState().setUnsavedPrompt({
          files: labelPaths(dirty),
          // every ending answers main, none of them silently: the quit may be the last
          // step of an update install or a restart, which main has to unwind rather than
          // leave armed for whenever the app next closes
          onCancel: () => window.api.app.declineQuit(),
          onDiscard: () => {
            discardAll(dirty)
            window.api.app.approveQuit()
          },
          onSave: async () => {
            const ok = await saveAll(dirty)
            // the question comes down either way — a refused save has put the offending
            // tab in front of the user, and this modal would be covering it
            useStore.getState().setUnsavedPrompt(null)
            if (ok) window.api.app.approveQuit()
            else window.api.app.declineQuit()
          }
        })
      })
    })
  }, [])

  // file-edit B-16: ⌘S follows ⌘F exactly — panel-scoped, so a ⌘S typed at the TUI stays
  // Claude's. It carries no dirty test of its own: B-15 puts that answer in the panel,
  // which owns the buffer and is the only thing that can tell a clean one from a dirty
  // one. With no panel focused this is silence, not an error.
  //
  // the note is the second place a ⌘S means something, and it is NOT in the panel:
  // it lives in the left dock, so the panel test above would answer no and the key would
  // die there, under a strip that says ⌘S and a File ▸ Save that is lit. So the caret
  // decides, and inside the note the save is made straight through the registry — the very
  // call the panel's own save ends up making.
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

  /** Fold / unfold the Notes island. Optimistic like every other settings switch: the
   *  store first so the dock moves at once, then main writes it down. */
  const setNotesFolded = useCallback((folded: boolean): void => {
    const st = useStore.getState()
    if (st.settings.notesFolded === folded) return
    st.setSettings({ ...st.settings, notesFolded: folded })
    void window.api.settings.set({ notesFolded: folded })
  }, [])

  /**
   * D5 — ⌥⌘N is a toggle for the caret: into the note, and out of it again. With
   * the note folded away it unfolds first, because a key that puts the caret somewhere
   * invisible is worse than one that does nothing. With no workspace pinned there is no
   * island on screen at all, and then the key does nothing.
   */
  useEffect(() => {
    return window.api.shortcuts.onFocusNotes(() => {
      if (!document.querySelector('.isl-notes')) return
      if (caretInNote()) {
        returnFocus()
        return
      }
      setNotesFolded(false)
      setNotesFocus((n) => n + 1)
    })
  }, [returnFocus, setNotesFolded])

  // FR-45: ⌘⇧F activates the Files tab and drops the focus into its search box, expanding
  // a collapsed panel to T2 first. A second press while search is open closes it and
  // clears the query wherever the focus sits — so unlike ⌘F this is a GLOBAL key, one of
  // the three exceptions FR-20's blanket names. No-op with no active session (FR-04).
  useEffect(() => {
    return window.api.shortcuts.onFindFiles(() => {
      const tabId = panelActionTab()
      if (!tabId) return
      const st = useStore.getState()
      if (!panelIsOpen(st, tabId)) st.setWorkbenchOpen(tabId, true)
      dispatchPanel('find-files')
    })
  }, [dispatchPanel])

  // D3: main's router sent a target to the Browser. The request carries the PTY's tab
  // id, so it is resolved to the session whose strip owns the tab — an `open` from a
  // background session builds its tab there, not in the one on screen (D1).
  useEffect(() => {
    return window.api.browser.onOpenRequest((r) => {
      const st = useStore.getState()
      // R12 first: main names the PTY, which for an `open` typed in a terminal tab
      // is the SHELL, not a conversation tab. Resolving it here is what makes the page
      // land in the session that owns the shell — the old code had no id to match, fell
      // into the fallback below and landed in whatever was on screen at the time.
      const named = { ...r, tabId: conversationTabFor(r.tabId) }
      // D3 + browser-extensions D6: the named tab's session, or (for a 'user' open —
      // extension createTab / the Web Store button, neither of which names a tab at all)
      // a live fallback, preferring the session on screen. See browserOpenTargetSession.
      const sess = browserOpenTargetSession(st.sessions, named, st.activeTabId)
      // Two reasons to bring the landing on screen, both "the user did this and must SEE
      // where it went": a fallback (the picked session isn't the one the request named),
      // and R12 (the request came from a shell, so the tab it lands in is the one that
      // owns that shell — which may well not be the one being looked at right now).
      const fromShell = named.tabId !== r.tabId
      if (sess && (fromShell || sess.tabId !== named.tabId) && st.activeTabId !== sess.tabId) {
        st.activateTab(sess.tabId)
      }
      // D8: the panel is keyed by the CONVERSATION TAB, so what the landing needs off the
      // picked session is its tab — the session id it carries only decides whether there
      // is a session at all (a tab with no claude bound has no panel to land in).
      const landing = sess?.sessionId ? sess.tabId : undefined
      if (!landing) {
        // R1: no session can take it, and an `open` Koloft intercepted must not
        // vanish — the shim already consumed the invocation. It used to leave for the
        // OS; the global overlay takes it now, shown at once when the user just typed
        // it themselves and in the background otherwise (see overlayPresentation).
        // An extension's open carries no os target and is owed the refusal instead:
        // silence would leave it sitting out the whole report timeout for nothing.
        // R2: a shell is a Workbench tab now, not a second top-level list, so the
        // conversation tabs ARE every tab there is to weigh.
        if (r.osFallback) {
          st.landOverlay(r.url, overlayPresentation(r, st.tabs, st.sessions))
        } else window.api.extensions.openDropped(r.url)
        return
      }
      // `osFallback` is set on the shim's channel alone, which is what tells an agent's
      // own `open <url>` from a guest page's ⌘-click (routed as `agent` too).
      st.openWorkbenchTarget(landing, {
        url: r.url,
        source: r.source,
        fromShim: r.osFallback !== undefined
      })
    })
  }, [])

  // §05D-2: a download was written into the download dir instead of being handed to the
  // OS. The toast is its only report, so it carries the way to the file.
  useEffect(() => {
    return window.api.browser.onDownload((d) =>
      useStore.getState().showToast(`Downloaded ${d.name} · Reveal in Finder`, d.path)
    )
  }, [])

  // SEC-4: a guest tried to leave for a scheme the OS hand-off refuses. Main dropped it;
  // silence would read as a dead link, so the drop is reported.
  useEffect(() => {
    return window.api.browser.onBlockedScheme((url) =>
      useStore.getState().showToast(`Blocked: ${url}`)
    )
  }, [])

  // SEC-10: a main-frame basic-auth challenge is answered in Koloft's own modal — never a
  // native dialog, which would say nothing about which origin is asking.
  useEffect(() => {
    return window.api.browser.onAuthChallenge(setBrowserDialog)
  }, [])

  // D7: an extension asked for a permission at runtime. Same rule as the two above —
  // Koloft's own modal, never a native dialog — and the extension is stopped until it is
  // answered, so an unanswered one is a denial rather than a third outcome.
  useEffect(() => {
    return window.api.extensions.onPermissionRequest((r) => setExtAsks((q) => [...q, r]))
  }, [])

  // §05D-11: same modal for a guest's alert/confirm/prompt. That page's JS is stopped
  // inside the call until the answer travels back, so the answer routes by kind.
  // R1: a page inside an overlay is on no session's strip, so its dialog is
  // handed to the overlay to draw — the Browser pane the modal lives in may not be
  // mounted at all, which would leave that page blocked for good.
  useEffect(() => {
    return window.api.browser.onJsDialog((d) => {
      if (d.overlay) useStore.getState().setOverlayDialog(d)
      else setBrowserDialog(d)
    })
  }, [])

  // the CDP relay's asks. The queue lives HERE rather than in the Workbench pane
  // because the first op is what mounts that pane: an event delivered to a surface that
  // does not exist yet would simply be lost, and the client would wait out its timeout.
  useEffect(() => {
    return window.api.browser.onCdpOp((op) => {
      setPanelMounted(true)
      setCdpOps((q) => [...q, op])
    })
  }, [])

  // D5: which tabs a client is driving — the strip pins them and marks them
  useEffect(() => {
    return window.api.browser.onCdpAttached((a) =>
      useStore.getState().setCdpAttached(a.sessionId, a.targetIds)
    )
  }, [])

  // R1: main routed an app-level page here — an `open` no session could take (from the
  // main side, where the owning tab is already gone), or the releases page.
  useEffect(() => {
    const off = window.api.browser.onOverlayOpen((o) =>
      useStore.getState().landOverlay(o.url, o.presentation)
    )
    // main holds pages until this is said: everything it sent before this effect ran
    // went to a renderer with no listener, which drops it without a word (D8)
    window.api.browser.overlayReady()
    return off
  }, [])

  // R1: Esc closes the overlay and nothing else — it is the topmost surface while it is
  // up, including over Settings (which stands down for it, as it does for the update
  // modal).
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

  // GPU state can be silently invalidated across sleep/unlock/display changes (no
  // webglcontextlost); main signals those moments so the glyph atlas is cleared and
  // every live WebGL tab repainted. See webglRepair.ts.
  useEffect(() => window.api.webgl.onRepair(repairAllWebgl), [])

  // C2 sidebar data: the aggregated workspace → session rows main pushes after
  // every rescan; the initial pull covers the window opening after the first push.
  useEffect(() => {
    // §03A: taking a push is also what ends the cold-start window for the global keys
    const take = (rows: WorkspaceRows[]): void => {
      setRowsLoaded(true)
      // e2e handshake (same rationale as __koloftShortcutsReady): a ⌘N sent before the
      // first rows arrival is a deliberate silent no-op — tests wait this flag out
      ;(window as unknown as { __koloftRowsReady?: boolean }).__koloftRowsReady = true
      setWorkspaceRows(rows)
    }
    void window.api.workspace.rows().then(take)
    return window.api.workspace.onRows(take)
  }, [setWorkspaceRows])

  // Add workspace (C1 ⊞ and ⇧⌘O are the same flow): native folder picker →
  // workspace:add, which normalizes subdirs to the repo root and refuses linked
  // worktrees (A1) — surfaced as an inline toast.
  const addWorkspace = useCallback(async (): Promise<boolean> => {
    const picked = await window.api.workspace.pickFolder()
    if (!picked) return false
    const r = await window.api.workspace.add(picked)
    if (r.code === 'rejected-worktree') showToast('Pick the repo root instead')
    else if (r.code === 'not-found') showToast('That folder does not exist')
    return r.code === 'added' || r.code === 'exists'
  }, [showToast])
  /** the alpha door beside it. The key is pinned as it is typed: nothing is
   *  connected until a session starts there, so the only answers are added / exists. */
  const addRemoteWorkspace = useCallback(
    async (key: string): Promise<void> => {
      setRemoteDialog(false)
      const r = await window.api.workspace.add(key)
      if (r.code === 'exists') showToast('Already added')
    },
    [showToast]
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

  // Guided-login progress (FR-06): the subscription must outlive the Settings panes —
  // a listener inside the dialog dies on pane switch and misses every phase change.
  // Terminal phases clear the store slice on their own schedule (loginFlow.ts), so a
  // login finishing while Settings is closed never leaves a stale "saved" panel behind.
  useEffect(() => {
    return window.api.accounts.onLoginProgress((p) => {
      const st = useStore.getState()
      // events for a login nobody is tracking (slice already dismissed) are dropped
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

  // "Check for Updates…" (app menu) opens the update modal + runs a check; the main
  // process streams download progress while an install runs. Store actions are stable,
  // so read them via getState and keep the listeners subscribed once.
  useEffect(() => {
    const offCheck = window.api.shortcuts.onCheckUpdate(() => useStore.getState().openUpdateCheck())
    const offProgress = window.api.update.onProgress((p) => {
      // ignore stray/late progress once the modal has left the downloading phase
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

  // session metadata stream -> store + live alive flag. The claude title is NOT
  // written into tab.title; it's derived from the session at render time, so when a
  // session ends (untracked) the tab falls back to its base "Terminal" title.
  useEffect(() => {
    const off = window.api.sessions.onUpdate((sessions) => {
      setSessions(sessions)
      for (const s of sessions) {
        setTabAlive(s.tabId, s.alive)
        // the bind is what finishes a resume — the only report a D5 restore gets, since
        // it has no sidebar row to turn running until this lands (§3.2)
        if (s.sessionId) releaseResume(s.sessionId)
      }
    })
    return off
  }, [setSessions, setTabAlive])

  // the session this tab drives moved into another git checkout; its Workbench
  // re-rooted itself off the pushed session data. Read the active tab at event time, so
  // the listener can stay subscribed once.
  useEffect(
    () =>
      window.api.sessions.onRelocated((e) => {
        const st = useStore.getState()
        if (st.activeTabId === e.tabId) st.showToast(relocatedNotice(e.dir))
      }),
    []
  )

  // scheduled jobs. Four one-way lines from main, none of which may touch what
  // the user is looking at: a job that fires adds its tab quietly (no activation, no
  // focus), a state push only re-paints the marks, a toast is a notice, and a run the
  // start deadline killed simply loses its tab.
  useEffect(() => {
    const offSpawned = window.api.terminal.onSpawned((t) =>
      useStore.getState().addTabQuiet({
        id: t.id,
        kind: t.kind,
        title: t.title,
        cwd: t.cwd,
        alive: true,
        jobId: t.jobId
      })
    )
    // a push is newer than anything the boot read can be holding, so once one has
    // landed the boot reply is stale and must not be written over it
    let pushed = false
    const offState = window.api.cron.onState((s) => {
      pushed = true
      useStore.getState().setCron(s)
    })
    const offToast = window.api.cron.onToast((text) => useStore.getState().showToast(text))
    // the pushes are the only other source, so a reload has to ask once — otherwise
    // the ⏰ marks stay missing until the next job fires (BB-E12)
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
    return window.api.tabs.onKilledByMain((tabId) => useStore.getState().removeTab(tabId))
  }, [])

  // report the tab the user is looking at — main clears its pending marker and uses
  // it to suppress events for the watched tab. Fires on activation, close (neighbor
  // becomes active), and the ⇧⌘R id swap.
  useEffect(() => {
    window.api.attention.activeTab(activeTabId)
  }, [activeTabId])

  // an OS-notification click asked to jump to a tab (main already surfaced the window);
  // activating it also clears the marker once the now-focused active tab is reported.
  useEffect(() => {
    return window.api.attention.onActivateTab((tabId) => useStore.getState().activateTab(tabId))
  }, [])

  // pty exit -> the tab goes, whatever the exit was: closeTab kills the (already-dead)
  // pty, untracks its claude session, and drops it from the store (selecting a
  // neighbour, or nothing — the welcome panel). A session that died is exactly a cold
  // one after an app restart: its row stays in the sidebar, a click resumes it, and
  // nothing of it stays on screen (T-LIFE-05). An exit with something to say — a crash,
  // a kill, a launch that died before binding ("Not logged in" exits at once) — is
  // reported in a toast, so it never vanishes without a word.
  // A session restart (⇧⌘R) also kills a pty deliberately: its exit must not touch
  // the tab, whose replacement pty is already on the way.
  useEffect(() => {
    const off = window.api.terminal.onExit((e) => {
      // an exit landing before the boot adoption applied is newer than
      // main's inventory snapshot — tombstone it so the id is never adopted
      if (!adoptionIsSettled()) preAdoptExits.add(e.id)
      // R7: a terminal tab's shell is not a conversation tab. Whether it ended on
      // its own (`exit`) or was killed by a ⌘W, everything the exit owes is done inside
      // `terminalExited` — and the session path below must not run for it, or the exit
      // would be read as a claude dying.
      if (useStore.getState().terminalExited(e.id)) return
      if (consumeRestartExit(e.id)) return
      // D5: a restore has no sidebar row to fall back to, so a pty that dies before
      // binding would otherwise vanish without a word
      if (consumeRestoreExit(e.id)) useStore.getState().showToast(RESTORE_FAILED_NOTICE)
      const tab = useStore.getState().tabs.find((t) => t.id === e.id)
      // the pty carrying a resume is gone: bound or not, that resume is over. A death
      // BEFORE the bind leaves the row cold, which is the one settle the rows push
      // cannot report (§4).
      if (tab?.sessionId) releaseResume(tab.sessionId)
      if (unexpectedExitWanted(tab, e)) {
        useStore
          .getState()
          .showToast(unexpectedExitNotice(e, tab?.kind === 'codex' ? 'codex' : 'claude'))
      }
      closeTab(e.id)
    })
    return off
  }, [closeTab])

  // R19: a terminal tab's label follows its shell's foreground process (`zsh` → `node`
  // → …). Only utility ptys report (main polls no others) — a straight relay, and the
  // store is what resolves the pty id to the conversation tab whose strip holds it.
  useEffect(() => {
    return window.api.terminal.onProcessTitle((t) =>
      useStore.getState().setTermTabProcess(t.id, t.name)
    )
  }, [])

  // R19: …and the kind bar's directory follows the shell's own OSC 7 reports, which main
  // parses. Same shape, same relay. Nothing about it is persisted (D4).
  useEffect(() => {
    return window.api.terminal.onCwd((c) => useStore.getState().setTermTabCwd(c.id, c.cwd))
  }, [])

  // D4: there is deliberately NO terminal restore here. A shell is a live process
  // and nothing about it is written down — a reload, a crash recovery and an app restart
  // all come back with no terminal tabs, and the ptys of the old document are killed.

  // re-adopt main's live ptys as tabs. A reload (dev HMR, crash recovery,
  // window reopen) drops every tab object while main keeps each pty + claude alive —
  // rebuild the strip from main's inventory instead of orphaning them. This is NOT the
  // A10/A11 restore that was rejected: nothing is persisted and nothing respawns; an
  // app restart's inventory is empty (the ptys died with main) and lands cold as ever.
  const adopted = useRef(false)
  useEffect(() => {
    if (adopted.current) return
    adopted.current = true
    void (async () => {
      try {
        const inv = await window.api.tabs.list()
        // an exit that landed while the pull was in flight outranks the snapshot
        const tabs = inv.tabs.filter((t) => !preAdoptExits.has(t.id))
        if (!tabs.length) return
        for (const t of tabs) {
          // the resume the old renderer had in flight — re-arm its dedupe latch
          if (t.resumeSessionId && !t.sessionId) rearmResume(t.resumeSessionId)
        }
        useStore.getState().adoptTabs(tabs, inv.activeTabBeforeReload)
        // the sessions stream is push-only: pull once so adopted tabs get their
        // liveness/titles now, not at the next throttled tick — same handling as
        // the onUpdate subscription above
        const live = await window.api.sessions.list()
        useStore.getState().setSessions(live)
        for (const s of live) {
          useStore.getState().setTabAlive(s.tabId, s.alive)
          if (s.sessionId) releaseResume(s.sessionId)
        }
      } catch {
        /* no inventory — the cold boot proceeds unchanged */
      } finally {
        markAdoptionSettled()
      }
    })()
  }, [])

  // load persisted settings. No tab LAYOUT is persisted or restored: sessions live in
  // Claude's own storage and an app restart lands cold (A10/A11) — the sidebar
  // re-aggregates them. (Re-adopting main's still-live ptys above is a different
  // thing: process reality, not persistence.)
  useEffect(() => {
    window.api.settings.get().then((s) => {
      setSettings(s)
      // main already seeded workbenchWidth from the wider of the two retired pane keys
      // and clamped it to the 440 floor (settings.ts), so the renderer just takes it.
      setWorkbenchWidth(s.workbenchWidth)
      setSidebarWidth(s.sidebarWidth)
      setNotesHeight(s.notesHeight)
    })
    const off = window.api.settings.onUpdate(setSettings)
    return off
  }, [setSettings, setWorkbenchWidth, setSidebarWidth, setNotesHeight])

  // C': once per version, what changed since the version this user last ran. Whether
  // there is anything to say — and what gets remembered — is main's call.
  useEffect(() => {
    let live = true
    void window.api.update.whatsNew().then((w) => {
      if (live && w) useStore.getState().openWhatsNew(w)
    })
    return () => {
      live = false
    }
  }, [])

  // `open <previewable file>` intercepted by the PATH shim → the Files tab's reading
  // area. FR-14 vs FR-57: an AGENT's open creates no tab, enters no Recents and raises
  // no signal at all while the panel is collapsed (the trade-off §7 accepted out loud);
  // a USER's open from a terminal tab's shell lands visibly — Files activated, panel
  // expanded, in the conversation tab that owns the shell (R12).
  useEffect(() => {
    return window.api.preview.onOpenRequest((r) => openInterceptedFile(r.tabId, r.path, r.source))
  }, [])

  // O2: the S4 welcome panel (and its ＋ New session) follows the workspace whose
  // session was selected last. Memory only — nothing about the selection is
  // persisted, so a restart lands on the pinned array's head (A10).
  const lastWsPath = useStore((s) => s.lastWsPath)
  const setLastWsPath = useStore((s) => s.setLastWsPath)
  useEffect(() => {
    if (!activeTabId) return
    const sid = sessions.find((s) => s.tabId === activeTabId)?.sessionId
    // a bound row is keyed by its session id, a pending one by its pty tab id
    const ws = workspaceRows.find((w) => w.rows.some((r) => r.id === (sid ?? activeTabId)))
    if (ws) setLastWsPath(ws.workspace.path)
  }, [activeTabId, sessions, workspaceRows, setLastWsPath])
  const welcomeWs = welcomeTarget(workspaceRows, lastWsPath)
  // Layer A: the first-run welcome takes the S4 slot before either panel does. The
  // latch is what the slot reads, not the pair of facts that arms it — the welcome's own
  // step 2 pins a folder, and it has to survive that. Being seen is what ends it, from
  // here rather than from the component: it also covers the launch where the settings
  // document lands after the rows do (DEFAULT_SETTINGS says "not seen" until it does).
  const welcomeActive = useStore((s) => s.welcomeActive)
  const setWelcomeActive = useStore((s) => s.setWelcomeActive)
  const onboardingSeen = useStore((s) => s.settings.onboardingSeen)
  const noWorkspaces = workspaceRows.length === 0
  useEffect(() => {
    if (onboardingSeen) setWelcomeActive(false)
    else if (rowsLoaded && noWorkspaces) setWelcomeActive(true)
  }, [rowsLoaded, onboardingSeen, noWorkspaces, setWelcomeActive])
  const updateOffer = useStore((s) => s.updateOffer)
  // D2: the workspace whose note the dock shows. A bound row is named by its claude
  // session id, a pending one by the launching pty's tab id — the same pair the O2 effect
  // above resolves a row by.
  const notesWs = currentWorkspace(
    workspaceRows,
    activeTabId ? (sessions.find((s) => s.tabId === activeTabId)?.sessionId ?? activeTabId) : null,
    selectedWs,
    lastWsPath
  )
  notesWsRef.current = notesWs
  // The focus nonce belongs to ONE workspace's note. A workspace switch remounts the
  // note's editor, and a nonce carried across would make the new pane take the caret —
  // pulling it out of the very session row the user just clicked. Adjusted during
  // render, not in an effect, so the pane never mounts holding the stale number.
  const [notesFocusWs, setNotesFocusWs] = useState(notesWs)
  if (notesFocusWs !== notesWs) {
    setNotesFocusWs(notesWs)
    setNotesFocus(0)
  }
  // D7: the panel is up whenever no session is picked, which now includes "a
  // workspace head is picked while its sessions keep running" — so the quiet line has to
  // count them rather than always saying the workspace is idle.
  const welcomeRunning = (welcomeWs?.rows ?? []).filter((r) => r.running).length
  // the sidebar orders by creation time; Recent means last touched, so it sorts its
  // own slice by mtime — the panel lists that workspace's alone (O2)
  const recentRows = (welcomeWs?.rows ?? [])
    .filter((r) => !r.running && !r.pending)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, RECENT_MAX)

  // a Recent row resumes exactly like its sidebar twin — the same decision tree (§4),
  // invalidCwd included: a gone worktree is the rebuild branch, not a dead row (D6)
  const resumeRecent = useCallback((row: SessionRow): void => {
    void resumeSession({ id: row.id, backendId: row.backendId, title: row.title })
  }, [])

  const activeTab = tabs.find((t) => t.id === activeTabId)
  const activeSession = activeTab ? sessions.find((s) => s.tabId === activeTab.id) : undefined
  // The two-phase switch's other half (see `shown` above). Everything the Workbench panel
  // is told about the selected session — which tab owns it, that tab's session, root and
  // open flag — follows `shown`, the tab whose xterm is on screen, and not `activeTabId`.
  // Fed from `activeTabId` it switched in the click's own commit: the panel's content for
  // the target (its Changes stream, files, guests, shells) was rendered and laid out
  // synchronously there, ahead of the first paint, so a heavy panel held the highlight
  // and the loading mask back for as long as that took — the switch mask existed and the
  // user never saw it. Now the click's commit changes the row highlight and the mask,
  // nothing else; the panel and the xterm land together two frames later. The fallback to
  // `activeTab` covers `shown` naming a tab that no longer exists (a close).
  const landedTab = tabs.find((t) => t.id === shown.id) ?? activeTab
  const landedSession = landedTab ? sessions.find((s) => s.tabId === landedTab.id) : undefined
  // D8: the panel belongs to the SELECTED CONVERSATION TAB, not to the claude session id
  // it is bound to — `/clear` and `/resume` hand it a different id and the panel must not
  // notice. "Unavailable" means "no session tab selected" — and a session that
  // DIED is exactly that: its pty exit closes the tab, so it can never be the selected one
  // (the `alive` question below is about background tabs' guests, not about this one).
  // a remote session gets no panel — not a greyed one, none. Cutting it off
  // here is what turns off the icon, the keys, `ensureWorkbench`, and the column itself.
  const remoteTab = !!landedTab && isRemoteKey(landedTab.cwd)
  const panelTab = hasWorkbench(landedTab) ? landedTab?.id : undefined
  const panelWidth = (panelTab ? workbenchWidths[panelTab] : undefined) ?? workbenchWidth
  // FR-25 + R8/R9: which conversation tabs may still own a guest AND a shell. Every
  // OTHER tab's pages are reclaimed at once and its shells unmounted — the one on screen
  // and the ones in the background alike. Both survive a session SWITCH (NFR-03) and
  // neither survives the session ENDING. What outlives both is the entry main persisted
  // under the claude session id, which is what a resume comes back to. Keyed by tab rather
  // than by session id so a
  // `/clear` — which only changes the id — reclaims nothing (R9).
  //
  // Walked over TABS, not over `sessions`, and that is the difference between ⇧⌘R being
  // invisible and ⇧⌘R being destructive. A restart swaps a new pty id into the slot in one
  // synchronous store step, while the sessions stream is a THROTTLED push from main: for a
  // beat the tab array holds the new id and the session array still holds the old one, so
  // a set built by mapping sessions contains an id no tab has any more and lacks the id
  // every tab-keyed body is now rendered under. Everything in this set unmounted for that
  // beat — and an unmounted xterm's scrollback is gone for good, since main keeps none, so
  // the shell came back alive and blank. R1 says a restart leaves the panel exactly as it
  // was; the tab array is the only side that moves in step with the panel's own key.
  //
  // The session entry is still consulted, for the one thing a tab cannot say: whether the
  // claude behind it has ENDED. An entry reporting `alive: false` is authoritative and the
  // tab goes; NO entry at all is not the same statement — it is the restart window, and
  // the tab's own anchor answers for it. `boundSessionId` supplies the rest of the chain,
  // including the seconds a freshly registered pty reports `sessionId: ''` before Claude
  // Code's SessionStart hook fires.
  const liveTabs = useMemo(
    () =>
      new Set(
        tabs
          .filter((t) => {
            if (!hasWorkbench(t)) return false
            const sess = sessions.find((x) => x.tabId === t.id)
            if (sess && !sess.alive) return false
            return !!boundSessionId({ sessions, tabs }, t.id)
          })
          .map((t) => t.id)
      ),
    [sessions, tabs]
  )
  // The tab's panel state lives in main (layout v3), under the claude session id the tab
  // is bound to, and it — not the renderer — resolves the default for a session it has
  // never shown a panel for. The store reads it at most ONCE per tab (`ensureWorkbench`,
  // keyed on its own `workbenchFetched` marker) — keyed neither on the strip's absence
  // nor on the open flag. A user gesture during a resume's pre-bind window sets
  // `workbenchOpen[tabId]` before this ever runs, and keying the read on that flag
  // suppressed it for the rest of the run — leaving the session's restored tabs unread in
  // memory (and, before `persistWorkbench` learned to refuse, overwritten on disk).
  // `setWorkbenchState` is what protects the gesture: it takes main's tabs only the first
  // time, and main's `open` only while the tab's own flag is still unknown — a flag a
  // gesture already set outranks the one on disk.
  //
  // The bound id is a dependency because the read needs it: a tab selected before its
  // claude binds is fetched again the moment the binding lands.
  const panelSid = landedSession?.sessionId
  useEffect(() => {
    if (!panelTab) return
    void useStore.getState().ensureWorkbench(panelTab)
  }, [panelTab, panelSid])

  /** Whether the panel's own keys and its titlebar icon do anything (FR-04). Deliberately
   *  NOT the same question as `panelTab`: a resume that has not bound yet HAS a
   *  conversation tab, and §04 keeps that state greyed exactly as it is today. A tab
   *  whose claude has ended keeps its baked anchor, so a cold session stays operable. */
  const panelReady =
    !!panelTab && !landedTab?.resuming && !!boundSessionId({ sessions, tabs }, panelTab)

  /** D1/D2/R5 — whether ⌃` and its menu item do anything. Stricter than `panelReady` by the one fact D2 adds: a shell belongs to a
   *  live claude, so a tab whose session has stopped can open none. */
  const terminalReady = panelReady && !!(landedSession?.alive && landedSession.sessionId)

  // FR-04/05 + R5: keep main's two gated View items in step with what the renderer
  // alone knows. Only the renderer knows whether a session is selected, and a native
  // accelerator cannot gate itself on renderer state — so an ungated item would be a live
  // key with no effect. Focus Mode follows the panel, New Terminal Tab the stricter
  // terminal gate, and they ride one channel so the two can never drift apart.
  useEffect(() => {
    window.api.workbench.setAvailable(panelReady, terminalReady)
  }, [panelReady, terminalReady])

  // file-edit B-12/B-15: keep main's Find and Save menu items in step with the editor,
  // the same shape as the Focus Mode flag above — a native accelerator cannot gate itself
  // on renderer state, so the renderer reports and main flips.
  useEffect(() => {
    return subscribeMenuFlags(({ editing, anyDirty }) => {
      window.api.workbench.setFindAvailable(!editing)
      window.api.workbench.setSaveAvailable(anyDirty)
    })
  }, [])

  useEffect(() => {
    return subscribeDirtyTabs((ids) => window.api.workbench.setDirtyTabs(ids))
  }, [])

  // Root for the sidebar file tree: the selected session's own directory — a worktree
  // session browses its checkout, every other session its workspace root — and the
  // welcome panel's workspace with nothing selected (O2: the Files island's top bar is
  // unconditional now).
  // a remote key is not a path on this disk — nothing that browses files may be handed one
  const welcomeRoot =
    welcomeWs && !welcomeWs.workspace.remote ? welcomeWs.workspace.path : undefined
  const fileTreeRoot = selectionRoot(
    remoteTab ? undefined : landedTab,
    landedSession?.treeRoot,
    welcomeRoot
  )

  /**
   * FR-05's three layout states, derived rather than stored — there is no T1/T2/T3 enum
   * anywhere, because two independent facts already say it: the session's own `open`
   * (persisted, per session) and the global `workbenchFull` (transient, app-wide).
   *
   * T1 = not shown · T2 = shown beside the TUI · T3 = shown instead of it. Deriving keeps
   * FR-07 free: a session switch only has to drop the global flag for the target to land
   * on its OWN T1-or-T2, with no per-session T3 to reconcile.
   */
  const panelOpen = panelIsOpen({ workbenchOpen }, panelTab)
  const panelFull = panelOpen && workbenchFull
  const panelShown = panelOpen || panelFull
  /**
   * What the panel is TOLD about being shown lags the layout by two frames, the same way
   * the target xterm lags a session click (`shown`). The rule for every click is: the
   * click's own commit does the pure UI change and nothing else, and the real work waits
   * until that frame is on screen. Here the pure UI change is the column's width (cheap —
   * the panel keeps its box either way, `--wb-w` below). The real work is the panel
   * learning it is off or on: `visibility` over its whole subtree (a style recalc of every
   * node), WorkbenchPane dropping the Changes stream (an unmount of every node). Done in
   * the click's commit, that sat between the click and the first paint — a collapse with a
   * big diff on screen took 220–310ms to show anything. Two rAFs, not one: the first
   * fires before the click's frame paints, the second after.
   *
   * Only the COLLAPSE lags. Expanding is told at once: a collapsed panel holds no stream
   * (dropped on collapse), so there is nothing heavy to recalc, and the content it goes
   * on to fetch is async anyway. Lagging it too would break every "expand and focus"
   * gesture — ⌘⇧F's search box, ⌃`'s shell, ⇧⌘B's caret all focus in the commit that
   * expands, and `focus()` inside a still-hidden subtree does nothing.
   */
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
  // The lag belongs to the tab that is COLLAPSING, so the state remembers which tab it
  // was on. A tab that just landed shut (a switch from an open panel to a session whose
  // panel is collapsed) reads shut at once: told it was still visible, the panel fetched
  // the change set and installed a watcher for a workspace whose panel is collapsed, and
  // threw both away two frames later — the spawn FR-51 (WB-K08) forbids. Found by code
  // review.
  const panelOnScreen = panelShown || (panelVisible.on && panelVisible.tab === panelTab)
  /** the relay's pending asks (mount / create / close / stage) */
  const [cdpOps, setCdpOps] = useState<BrowserCdpOp[]>([])
  const dropCdpOp = useCallback((opId: string): void => {
    setCdpOps((q) => q.filter((o) => o.opId !== opId))
  }, [])
  /** S1: while a client is driving a page and the panel is NOT on screen, the column
   *  keeps a real box behind the UI instead of collapsing to zero width — a guest with
   *  no box produces no frames, and a capture on it never answers at all.
   *
   *  It also has to be up while an op is still IN FLIGHT: a <webview> mounted into a
   *  zero-width column never reaches `did-attach` at all (measured — the mount simply
   *  timed out), so the very first page a client opens needs the box already there. */
  const staged =
    !panelShown && (cdpOps.length > 0 || Object.values(cdpAttached).some((ids) => ids.length > 0))

  // FR-01: the panel is a SINGLETON that never unmounts once mounted. Unmounting would
  // take every background session's live guests with it — the whole reason the former
  // BrowserPane was a singleton while FilePane was per-tab. It comes into existence on
  // the first session that has one, and stays.
  const [panelMounted, setPanelMounted] = useState(false)
  useEffect(() => {
    if (panelShown) setPanelMounted(true)
  }, [panelShown])

  // Panel show/collapse and T3 re-lay-out the surviving terminals without any xterm
  // mounting or disposing (hidden panes stay mounted), so the register/unregister hooks
  // inside webglRepair never see them — schedule the same debounced repair here. T3 is
  // the harsher of the two: the TUI is gone from the layout entirely and comes back
  // blank without it (NFR-05).
  useEffect(() => {
    scheduleWebglRepair()
  }, [panelShown, panelFull])
  const [vDragging, setVDragging] = useState(false)
  const [sbDragging, setSbDragging] = useState(false)
  // the splitters are flex gutters between islands now, so drag math anchors to the
  // measured left edge of the panel being resized (captured once per drag), not to a
  // window-left offset that would drift with the canvas padding / gutter widths.
  const dockRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  /** The column's width as last laid out while showing — what a collapsed panel keeps its
   *  content at (`--wb-w`). Measured rather than taken from `workbenchWidth`: in Focus
   *  Mode (T3) the column spans the row, and ⇧⌘B collapses from there in one commit, so a
   *  box sized to the side-by-side width would be a full relayout of the stream after all
   *  (code review,). A ref, not state: it is read only by the collapse render,
   *  and a measurement must never itself schedule one. */
  const shownWidth = useRef(0)
  /** the width mid-drag of the gutter, null otherwise — see `startVResize` */
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
  const SIDEBAR_MIN = 200
  // Every gutter here moves a terminal's box, so all three open the resize gate: the
  // terminals hold their pty size for the duration and settle once on release, instead
  // of billing the shell (or the Claude TUI) a SIGWINCH per intermediate size.
  const startVResize = (e: MouseEvent): void => {
    e.preventDefault()
    beginLayoutDrag()
    setVDragging(true)
    // the panel sits RIGHT of the TUI, so dragging the gutter moves its LEFT edge —
    // width/clamp math lives in paneWidthFromDrag (unit-pinned: no automated layer drags
    // a gutter, so a mirrored sign would otherwise survive every suite). FR-08: one
    // width key and one floor now, since after the merge any tab can be a `web` tab.
    const right = panelRef.current?.getBoundingClientRect().right ?? window.innerWidth
    const dockRight = dockRef.current?.getBoundingClientRect().right ?? sidebarWidth
    // While the drag lasts the width goes straight onto the column's style and NOT
    // through the store: a store write re-renders App, the panel and everything in it
    // on every mouse move, for a change that is one CSS property. Measured 2026-09-07
    // over a 6×900-line Changes stream (workbench-resize-perf.spec.ts): the re-render
    // was a third of each frame. The store gets the final width once, on release.
    // `liveWidth` is what a render that happens to land mid-drag (a poll, a session
    // event) puts on the column, so it cannot snap the width back to the stored one.
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
  // drag the gutter on the sidebar dock's right edge: width = cursor x - dock left.
  // Ceiling keeps ≥480px for the center islands, measured from the dock's real left
  // edge, minus the gutter + canvas right padding (20px of chrome — same derivation
  // as the pane clamp above) so the terminal can't be crushed.
  const startSidebarResize = (e: MouseEvent): void => {
    e.preventDefault()
    beginLayoutDrag()
    setSbDragging(true)
    const left = dockRef.current?.getBoundingClientRect().left ?? 0
    const onMove = (ev: globalThis.MouseEvent): void => {
      setSidebarWidth(
        Math.min(Math.max(SIDEBAR_MIN, ev.clientX - left), window.innerWidth - left - 500)
      )
    }
    const onUp = (): void => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      setSbDragging(false)
      endLayoutDrag()
      void window.api.settings.set({ sidebarWidth: useStore.getState().sidebarWidth })
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }
  // D6 — drag the gutter between the two dock islands. The height math and both
  // clamps live in `notesHeightFromDrag` (unit-pinned, like the pane's own drag).
  const startNotesResize = (e: MouseEvent): void => {
    e.preventDefault()
    beginLayoutDrag()
    setNbDragging(true)
    const box = dockRef.current?.getBoundingClientRect()
    const bottom = box?.bottom ?? window.innerHeight
    const dockHeight = box?.height ?? window.innerHeight
    const onMove = (ev: globalThis.MouseEvent): void => {
      setNotesHeight(notesHeightFromDrag(bottom, dockHeight, ev.clientY))
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

  /**
   * D6 — how tall the dock is right now, which is what the note's REMEMBERED height
   * has to be cut down to (`clampNotesHeight`). The note carries a fixed height while the
   * sessions island above it is `flex:1`, so a height chosen on a big display would, on a
   * smaller window, squeeze the session list down to nothing.
   *
   * Measured, not worked out: the dock's height is the window's minus the sidebar's head
   * strip and footer, and a second copy of that sum here would drift from the CSS the day
   * either of them changes. A layout effect so the first paint is already right. The
   * clamped number is never written back to settings — the window growing again must hand
   * the user back the height they chose.
   */
  const [dockHeight, setDockHeight] = useState(0)
  useLayoutEffect(() => {
    const measure = (): void => setDockHeight(dockRef.current?.getBoundingClientRect().height ?? 0)
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [])

  const hint = useHints()

  return (
    <div className="app">
      {toast && (
        <div
          className={'toast' + (toastReveal ? ' link' : '')}
          onClick={() => {
            if (!toastReveal) return
            window.api.fs.reveal(toastReveal)
            dismissToast()
          }}
        >
          {/* B9: no dismiss control. F3 added one because the card could sit there
              forever; it goes on its own again, and a 4s notice with a close button
              asks for a decision nobody needs to make. */}
          <span className="toast-msg">{toast}</span>
        </div>
      )}

      {/* The sidebar: a flat column from the top of the window to its bottom — the head
          strip (window drag + traffic lights), the dock (sessions over the note), and the
          footer (the usage capsule, keep-awake, settings). The old full-width titlebar
          retired with the flat layout. */}
      <div className="side" style={{ width: sidebarWidth }}>
        <div className="titlebar">
          {/* R1: the way back to a page Koloft took for the user. Present only while
              the overlay is holding one — there is no such thing as an empty overlay —
              and dotted while that page has not been looked at, which is the whole
              receipt for a landing that deliberately opened no surface. */}
          {overlay && (
            <button
              className={'tb-ico' + (overlay.unread ? ' unread' : '')}
              onClick={showOverlay}
              title="Page Koloft opened for you"
              aria-label="Opened page"
            >
              <LuAppWindow size={20} />
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
          {/* the ⊞ opens a two-item menu now — a local folder, or a directory
              on another machine. ⇧⌘O and the app menu's Add Workspace… still go straight
              to the folder picker: the remote form is the alpha side door, not the
              shortcut's meaning. */}
          <button
            /* S4 first run: with nothing pinned this is the only way forward, so it
               stays lit rather than waiting to be discovered on hover */
            className={'tb-ico' + (workspaceRows.length === 0 ? ' on' : '')}
            onClick={(e) => {
              e.stopPropagation()
              setAddMenu((v) => !v)
            }}
            title="Add workspace (⇧⌘O)"
            aria-label="Add workspace"
          >
            <LuFolderPlus size={20} />
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
            onNewWorktreeSession={(path) => requestNew('worktree', path)}
            onRestoreSession={setRestoreWs}
            onScheduledJobs={(path, jobId) => setCronWs({ path, jobId })}
          />
          {updateOffer && (
            <button
              className="btn-primary upd-banner"
              onClick={() => useStore.getState().openUpdateCheck()}
            >
              <LuCircleArrowUp size={15} />
              <span>
                {updateOffer.status === 'restart-required'
                  ? `Koloft ${updateOffer.installed} installed · restart`
                  : `Koloft ${updateOffer.latest} available`}
              </span>
              <LuChevronRight size={15} />
            </button>
          )}
          {/* D2 — the workspace's note, under the list of its sessions. The gap
              between the two islands is always there (without it
              a folded head band sat glued to the list); it only DRAGS while the island is
              open — a folded one is a head band with nothing to resize. */}
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
            height={dockHeight ? clampNotesHeight(notesHeight, dockHeight) : notesHeight}
            folded={notesFolded}
            focusNonce={notesFocus}
            onToggleFold={() => {
              const folding = !notesFolded
              // the stale nonce must not come back with the editor when it is unfolded
              setNotesFocus(0)
              setNotesFolded(folding)
              // folding puts the note away, so the caret goes home to the centre with it —
              // otherwise it is left on nothing and no island wears the ring (manual
              // round)
              if (folding) returnFocus()
            }}
            onReturnFocus={returnFocus}
          />
        </div>
        {/* the footer — what the titlebar's left cluster and centre capsule used to hold */}
        <div className="side-me">
          <TopbarUsage />
          {/* keepAwake: the quick switch for the caffeinate hold — lit while the Mac is
              being kept awake. Same optimistic write as the settings panes: store first,
              then main persists, spawns/kills caffeinate and echoes settings:update. */}
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
            <LuCoffee size={20} />
          </button>
          <button
            className="tb-ico"
            onClick={() => setSettingsOpen(true)}
            title="Settings"
            aria-label="Settings"
          >
            <LuSettings size={20} />
          </button>
        </div>
        {/* the sidebar's resize grip rides its right border — no gap, no pill */}
        <div
          className={'side-grip' + (sbDragging ? ' active' : '')}
          onMouseDown={startSidebarResize}
          title="Drag to resize sidebar"
        />
      </div>
      {/* transparent capture layer (position:fixed, so it lives anywhere) so a drag over
          xterm or a guest doesn't swallow mousemove — one for all three grips */}
      {(sbDragging || nbDragging || vDragging) && <div className="drag-overlay" />}
      {/* the centre is the TUI + panel row and nothing else. The global terminal
            island that used to span the bottom is retired — a shell is a panel tab now. */}
      <div className="center" ref={centerRef}>
        <div className="center-row">
          {/* C4: the TUI sits on the bare ground — no frame (the island's border and
              radius retired), under a 46px strip that carries the window drag.
              Identity and state live on the C2 sidebar row, usage/model/branch on
              ccstatusline. The TUI always sits LEFT of the aux column (Preview on the
              right — decided): nav on the left, chat in the middle, output on
              the right. `island flat` keeps the island's layout half (the column flex
              and the overflow clip the terminals rely on) and drops its frame. */}
          <div className="term-col" style={{ display: panelFull ? 'none' : undefined }}>
            <div className="center-top">
              <WorldClock />
            </div>
            <div className="island flat term-island">
              <div className="terminals">
                {tabs.map((t) => (
                  <div
                    key={t.id}
                    className="term-wrap"
                    style={{ display: t.id === shown.id ? 'block' : 'none' }}
                  >
                    <TerminalView
                      id={t.id}
                      active={t.id === shown.id}
                      scrollbar={false}
                      /* typing here restarts this session's auto-close clock */
                      onUserInput={
                        t.kind === 'claude'
                          ? () => window.api.sessions.noteActivity(t.id)
                          : undefined
                      }
                      focusSignal={tuiFocus}
                      onRepainted={() => {
                        if (t.id === activeTabId) setPaintedGen(switchGen)
                      }}
                    />
                    {/* Codex can ask for trust or login before binding; keep its TUI interactive. */}
                    {t.resuming && t.kind !== 'codex' && <ResumingMask title={t.title} />}
                  </div>
                ))}
                {/* the switch mask: up from the click until the target's xterm is on screen
                  and repainted (see `shown`). A resume target keeps the resume wording, so
                  this and the tab's own mask read as one. */}
                {switching && activeTab && (
                  <ResumingMask
                    title={activeSession?.title ?? activeTab.title}
                    label={activeTab.resuming ? undefined : 'Loading session…'}
                    late={!activeTab.resuming}
                  />
                )}
                {/* the click-time half of that same mask: up from the moment a cold row
                  is clicked until its pty lands (then the tab's own mask above carries
                  on, word for word, so the user sees ONE loading state). Rendered after
                  the tabs so it sits over whichever one was showing. */}
                {resumeLaunch && <ResumingMask title={resumeLaunch.title} />}
                {/* S4: nothing running. With no pinned folder the panel is the
                  onboarding step; otherwise it is the welcome panel for the
                  workspace ⌘N would target (O2), with that workspace's recents. */}
                {/* D7: "no session picked", not "no session open" — clicking a
                  workspace head drops the active tab and brings the panel back with the
                  running sessions untouched behind it. */}
                {!activeTab &&
                  !resumeLaunch &&
                  (welcomeActive ? (
                    <Onboarding onAddWorkspace={addWorkspace} onStartIn={startIn} />
                  ) : welcomeWs ? (
                    <div className="w-empty" tabIndex={-1}>
                      <div className="big">{basename(welcomeWs.workspace.path)}</div>
                      <div className="quiet">{welcomeQuietLine(welcomeRunning)}</div>
                      <button
                        className="btn-primary"
                        onClick={() => startIn(welcomeWs.workspace.path)}
                      >
                        ＋{' '}
                        {namedMethods
                          ? `New ${backendLabel(namedMethods[0])} session`
                          : 'New session'}
                      </button>
                      {/* the other method, named outright — only where there IS another
                        one to pick (A1) */}
                      {namedMethods && (
                        <button
                          className="mini"
                          onClick={() => startIn(welcomeWs.workspace.path, namedMethods[1])}
                        >
                          New {backendLabel(namedMethods[1])} session
                        </button>
                      )}
                      {/* D7: the panel's second creation action. Not on a non-git
                        workspace — there is nothing for it to branch (D10) */}
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
                      {/* the same alpha door as the ⊞ menu's, for a first run
                        that has no workspace to open that menu from yet */}
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
          {/* FR-01 — the panel singleton. NEVER display:none: a <webview> inside a hidden
              subtree is detached and reloads on the way back (electron#28677), which would
              cost every background session its live guests. It collapses to zero width
              instead, which is also why T1 keeps the element in the layout at all. */}
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
              // `--wb-w` is what keeps a collapse cheap: `.wb-col.off .wb-panel` (styles.css)
              // holds the panel's content at this width while the column itself is zero
              // wide. Laying the content out at width 0 instead relaid out every node in it
              // before the click's frame could paint — a Changes stream
              // of six 900-line files (150k nodes): 220–310ms of layout per collapse, the
              // "click, nothing, then it closes" stall. With the width held the same
              // collapse lays out nothing but the two columns. The width is the one the
              // column was last SHOWN at (`shownWidth`), which in T3 is the row's.
              style={{
                ['--wb-w' as string]: `${shownWidth.current || panelWidth}px`,
                ...(panelFull
                  ? { flex: '1 1 auto' }
                  : panelShown
                    ? { width: liveWidth.current ?? panelWidth }
                    : staged
                      ? { width: STAGE_SIZE.width, height: STAGE_SIZE.height }
                      : { width: 0 })
              }}
            >
              <WorkbenchPane
                tabId={panelTab ?? null}
                states={workbench}
                liveTabs={liveTabs}
                visible={panelOnScreen}
                full={panelFull}
                load={workbenchLoad?.ownerTabId === panelTab ? workbenchLoad : null}
                command={panelCmd}
                dialog={browserDialog}
                treeRoot={fileTreeRoot}
                session={landedSession ?? null}
                activeTabId={landedTab?.id ?? null}
                onUpdate={updateWorkbenchTabs}
                onEvicted={(t, set) => showToast(tabEvictedNotice(tabLabel(set, t)))}
                onExternalOpen={(url) => window.api.browser.openExternal(url)}
                onCertProceed={(url) => window.api.browser.certProceed(url)}
                onDialogAnswer={(id, answer) => {
                  const auth = browserDialog?.kind === 'auth'
                  setBrowserDialog(null)
                  if (auth) window.api.browser.answerAuthChallenge(id, answer)
                  else window.api.browser.answerJsDialog(id, answer)
                }}
                onToggleFull={toggleFull}
                panelFocus={panelFocus}
                // FR-54 + R17: none of the panel's own overlays were open, so the
                // ladder falls through to the layout. Two rungs are left, in this order —
                // T3 back to side-by-side, and then, with nothing else to undo, the caret
                // goes home to the conversation and the ladder ends there.
                //
                // What it never does is the thing people expect Esc to do: it does not
                // collapse the panel and it does not close a tab. Undoing a layout the
                // user asked for, or throwing away a tab's page, is not "escaping" — those
                // are ⇧⌘B and ⌘W, which say so out loud.
                onEscapeFellThrough={() => {
                  if (workbenchFull) setWorkbenchFull(false)
                  else returnFocus()
                }}
                pinned={cdpAttached}
                /* read at CALL time, not captured: these fire from a client's op long
                   after this render, and through `boundSessionId` so a session that has
                   registered but not yet hook-bound still resolves to its tab. */
                tabForSession={(sid) => tabForSession(useStore.getState(), sid)}
                cdpOps={cdpOps}
                onCdpDone={dropCdpOp}
                onCdpCreate={(sid, url) => {
                  // the relay names a session; the panel is keyed by conversation tab
                  const st = useStore.getState()
                  const owner = tabForSession(st, sid)
                  return owner ? st.openCdpTab(owner, url) : Promise.resolve(null)
                }}
              />
              {/* the switch mask's panel half: the panel is still the tab the user LEFT
                  until `shown` lands (see `landedTab`), so it wears the same mask as the
                  term island for the same window. Not over the stage — a client's capture
                  needs the guest's pixels, and a switch is none of its business. */}
              {switching && !staged && activeTab && (
                <ResumingMask
                  title={activeSession?.title ?? activeTab.title}
                  label="Loading session…"
                  late
                />
              )}
            </div>
          )}
          {/* FR-55: the aux cluster is ONE icon — the Eye and the Globe merged into the
              Workbench toggle, and the Terminal icon went with the island (a shell is
              a panel tab now, reached by ⌃`, View ▸ New Terminal Tab, or the strip's ＋, so
              a titlebar button for it was a second door to the same room). The glyph is the
              "collapse the side panel" one, because that is what the button does; it never
              meant "split the screen". `aria-disabled` rather than `disabled` so a click
              still lands (and does nothing) with no session to attach a panel to (FR-04).

              It floats at the centre's top-right corner: with the panel collapsed it sits
              on the ground, and an open panel rises up to that same corner so the button
              lands on the right end of the panel's own tab strip — one
              control, one spot, both directions.

              FR-51: there is deliberately NO unread dot and NO count here. A collapsed
              panel leaves ZERO signal — the `unread` class the Eye and Globe both carried
              is gone, and the consequence (files the agent opens during collapse are
              undiscoverable until you expand and read Changes) was accepted out loud. */}
          {/* a remote session has no Workbench, so the button is ABSENT rather
              than greyed — a disabled door still says "there is a room here". */}
          <div className="aux-icons">
            {!remoteTab && (!landedTab || hasWorkbench(landedTab)) && (
              <button
                className={'aux-ico wb-toggle' + (panelShown ? ' on' : '')}
                aria-disabled={!panelReady}
                onClick={toggleWorkbench}
                title="Workbench (⇧⌘B)"
                aria-label="Workbench"
              >
                <LuPanelRight size={18} />
              </button>
            )}
          </div>
        </div>
      </div>
      {newRequest && (
        <NewSessionDialog
          key={newRequest.id}
          mode={newRequest.mode}
          initialPath={newRequest.path}
          rows={workspaceRows}
          onClose={() => setNewRequest(null)}
          onStart={startSession}
          launchLock={newSessionLocked}
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
      <UpdateModal />
      {/* R1: mounted after Settings so a releases page opened from inside it stacks on
          top (z 110 over 100), and before the extension ask, which stays topmost */}
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
      {/* LAST on purpose: every `.modal-backdrop` shares one z-index, so paint order is
          DOM order, and this question can be raised on top of any of the others — the
          update modal's own Install and Restart both go through it. Rendered earlier it
          would sit UNDER the modal that triggered it, unanswerable, until the guard's
          patience ran out and quit with the edits still unsaved. */}
      <UnsavedDialog />
      {/* Layer B — the contextual hints. Portalled to the body, so where it sits in
          this tree decides nothing but who owns the state. */}
      {hint && <Hint {...hint} />}
    </div>
  )
}
