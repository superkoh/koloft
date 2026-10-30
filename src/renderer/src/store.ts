import { BACKEND_LABEL, identityOf, sourceOf } from '@shared/sessionBackend'
import { hasWorkbench, ipcErrorText, isSessionKind, resumeFailureMessage } from './agentUi'
import { create } from 'zustand'
import {
  DEFAULT_SETTINGS,
  DEFAULT_TERMINAL_TITLE,
  type AccountView,
  type AdoptableTab,
  type ArtifactView,
  type AttentionEvent,
  type BaseChoice,
  type BrowserJsDialog,
  type CronState,
  type SessionWorkbenchState,
  type LoginProgress,
  type LeftoverProcess,
  type MachineState,
  type CreateTabOptions,
  type SessionInfo,
  type SessionRow,
  type TabKind,
  type Settings,
  type ReleaseNotes,
  type WhatsNew,
  type UpdateCheckResult,
  type WorkspaceRows
} from '@shared/types'
import { basename } from '@shared/preview'
import { resolveOnHost } from '@shared/remoteKey'
import { routeFor } from '@shared/browserRoute'
import type { LoginFlowState } from './components/settings/loginFlow'
import type { FilesTab } from './components/filesModel'
import type { ResumeDialogState } from './resumeFlow'
import { endEditsOf, rekeyOwner } from './editRegistry'
import { endedTabsLiveElsewhere, selectionRoot, welcomeTarget, workspaceOfRow } from './sessionRows'
import { inRoot } from './browseModel'
import { butlerSetUp, butlerTabOf, everyWorkspaceRows, isButlerTab } from './butlerRows'
import {
  activateTab as activateWbTab,
  closeTab as closeWbTab,
  cwdFallbackNotice,
  emptyTabSet,
  FILES_TAB_ID,
  KIND_TAB_CAP,
  openTab,
  persistTabs,
  restoreTabSet,
  retitleTab,
  tabLabel,
  TERM_SPAWN_FAILED_NOTICE,
  TERMINAL_CAP_NOTICE,
  type WorkbenchTabSet
} from './components/workbenchTabs'
import {
  DEFAULT_PANEL_OPEN,
  isWorkspaceWorkbenchKey,
  workspaceWorkbenchKey
} from '@shared/workbenchState'
import type { SettingsPaneId } from '@shared/paletteFeatures'

export interface Tab {
  id: string
  kind: TabKind
  title: string
  cwd: string
  sessionId?: string
  alive: boolean
  resuming?: boolean
  respawning?: true
  jobId?: string
  asleep?: true
  ghost?: string
  wakeOverdue?: true
  launch?: CreateTabOptions
  ended?: TabEnded
}

export interface TabEnded {
  note: string
  row: SessionRow
  wsPath: string
}

export interface OpenFile {
  src: string
  label: string
  line?: number
  source?: 'intercept'
  view?: ArtifactView
  unseen?: true
  openedAt?: number
}

export type UpdatePhase =
  'checking' | 'available' | 'current' | 'restart-required' | 'downloading' | 'error' | 'whats-new'

export interface UpdateState {
  open: boolean
  phase: UpdatePhase
  current?: string
  installed?: string
  latest?: string
  releases?: ReleaseNotes[]
  omittedReleases?: number
  htmlUrl?: string
  percent?: number
  restarting?: boolean
  error?: string
}

export type SettingsFocus = 'git-accounts' | 'git-token' | null

interface AppState {
  tabs: Tab[]
  activeTabId: string | null
  sessions: SessionInfo[]
  leftovers: Record<string, LeftoverProcess[]>
  attention: AttentionEvent[]
  revealRow: { tabId: string } | null
  settings: Settings
  settingsOpen: boolean
  settingsPane: SettingsPaneId | null
  settingsFocus: SettingsFocus
  welcomeActive: boolean
  onboardingStep: number
  accounts: AccountView[] | null
  signIn: { tabId: string; backToSettings: boolean } | null
  accountLogin: LoginFlowState | null
  openFiles: Record<string, OpenFile | null>
  workbenchWidth: number
  workbenchWidths: Record<string, number>
  sidebarWidth: number
  notesHeight: number
  workspaceRows: WorkspaceRows[]
  butlerWorkspace: WorkspaceRows | null
  toast: string | null
  toastReveal: string | null
  workbenchOpen: Record<string, boolean>
  workbench: Record<string, WorkbenchTabSet>
  workbenchFetched: Record<string, true>
  workbenchLoad: Record<string, { tabId: string; nonce: number }>
  agentOpen: { ownerTabId: string; tabId: string; nonce: number } | null
  filesReveal: Record<string, { nonce: number; view: FilesTab }>
  changesBase: Record<string, BaseChoice>
  workbenchFull: boolean
  overlay: { url: string; unread: boolean; open: boolean } | null
  cdpAttached: Record<string, string[]>
  followsAgentBrowser: Record<string, true>
  overlayDialog: BrowserJsDialog | null
  termFocus: { ptyId: string; n: number }
  githubBtn: boolean
  lastWsPath: string | null
  selectedWs: string | null
  update: UpdateState
  updateOffer: UpdateCheckResult | null
  setUpdateOffer: (offer: UpdateCheckResult | null) => void
  resumeDialog: ResumeDialogState | null
  resumeLaunch: { id: string; title: string } | null
  cron: CronState
  machine: MachineState | null
  closeConfirm: {
    tabId: string
    title: string
    status: 'working' | 'approval'
    unsaved?: {
      files: string[]
      discard(): void
      save(): Promise<boolean>
    }
  } | null
  unsavedPrompt: {
    files: string[]
    jobs?: number
    ended?: string
    onCancel(): void
    onDiscard(): void
    onSave(): void | Promise<void>
  } | null
  butlerTab: string | null
  assistAsked: boolean
  bindButler: boolean
  renameButler: boolean
  orphanConfirm: string | null

  addTab: (t: Tab) => void
  addTabQuiet: (t: Tab) => void
  setCron: (s: CronState) => void
  setMachine: (s: MachineState | null) => void
  adoptTabs: (tabs: AdoptableTab[], activeTabBeforeReload: string | null) => void
  removeTab: (id: string) => void
  closeTab: (id: string) => void
  landOnButler: () => void
  openButler: (fresh?: boolean) => Promise<string | null>
  setActive: (id: string) => void
  setTabTitle: (id: string, title: string) => void
  setTabAlive: (id: string, alive: boolean) => void
  keepEndedTab: (id: string, note: string) => boolean
  setTabAsleep: (id: string) => void

  activateTab: (id: string) => void
  revealTab: (id: string) => void
  restartActiveSession: () => void

  setSessions: (s: SessionInfo[]) => void
  setLeftovers: (l: Record<string, LeftoverProcess[]>) => void
  setAttention: (pending: AttentionEvent[]) => void
  setSettings: (s: Settings) => void
  setSettingsOpen: (open: boolean) => void
  openSettingsPane: (pane: SettingsPaneId) => void
  setSettingsFocus: (focus: SettingsFocus) => void
  gitAccountsMachine: string | undefined
  openGitAccounts: (focus?: 'git-token', machine?: string) => void
  setWelcomeActive: (on: boolean) => void
  setOnboardingStep: (step: number) => void
  setAccounts: (accounts: AccountView[]) => void
  showSignInTab: (tabId: string) => void
  beginLogin: (reauthName?: string) => void
  setLoginProgress: (p: LoginProgress) => void
  clearLogin: () => void
  setOpenFile: (f: OpenFile | null, tabId?: string) => void
  openChanges: (tabId: string) => void
  setChangesBase: (tabId: string, base: BaseChoice) => void
  setWorkbenchWidth: (w: number) => void
  setTabWorkbenchWidth: (tabId: string, w: number) => void
  setSidebarWidth: (w: number) => void
  setNotesHeight: (h: number) => void
  setWorkspaceRows: (rows: WorkspaceRows[]) => void
  showToast: (msg: string, reveal?: string) => void
  dismissToast: () => void
  setResumeDialog: (d: ResumeDialogState | null) => void
  setResumeLaunch: (l: AppState['resumeLaunch']) => void
  setCloseConfirm: (c: AppState['closeConfirm']) => void
  setUnsavedPrompt: (p: AppState['unsavedPrompt']) => void
  setButlerTab: (tabId: string) => void
  setAssistAsked: (asked: boolean) => void
  setBindButler: (open: boolean) => void
  setRenameButler: (open: boolean) => void
  setOrphanConfirm: (rowId: string | null) => void

  ensureWorkbench: (tabId: string) => Promise<void>
  setWorkbenchState: (tabId: string, state: SessionWorkbenchState) => void
  setWorkbenchOpen: (tabId: string, open: boolean) => void
  updateWorkbenchTabs: (
    tabId: string,
    update: (prev: WorkbenchTabSet) => WorkbenchTabSet,
    after?: () => void
  ) => void
  openWorkbenchTarget: (
    tabId: string,
    opts: {
      url: string
      source: 'agent' | 'user'
      fromShim?: boolean
      sourceTabId?: string
      sourcePath?: string
    }
  ) => void
  setWorkbenchFull: (on: boolean) => void
  landOverlay: (url: string, presentation: 'now' | 'background') => void
  showOverlay: () => void
  closeOverlay: () => void
  setOverlayDialog: (d: BrowserJsDialog | null) => void
  setCdpAttached: (sessionId: string, targetIds: string[]) => void
  openCdpTab: (tabId: string, url: string) => Promise<string | null>
  followAgentBrowser: (tabId: string) => void
  setLastWsPath: (p: string) => void
  selectWorkspace: (path: string) => void
  openWorkspaceList: (path: string, what: 'issues' | 'pulls') => void

  focusPanelTerm: (ptyId: string) => void

  setGithubBtn: (on: boolean) => void
  openTerminalTab: (tabId: string) => void
  closeTerminalTab: (ptyId: string) => void
  terminalExited: (ptyId: string) => boolean
  setTermTabProcess: (ptyId: string, name: string) => void
  setTermTabCwd: (ptyId: string, cwd: string) => void

  openUpdateCheck: () => void
  openWhatsNew: (w: WhatsNew) => void
  startUpdateDownload: () => void
  setUpdate: (patch: Partial<UpdateState>) => void
}

export function tabEvictedNotice(title: string): string {
  return `Closed ${title} — ${KIND_TAB_CAP} tabs is this session's limit per kind`
}

const everBoundSession = new Set<string>()
const lastSessionId = new Map<string, string>()
const restarting = new Set<string>()
const restartedPtys = new Set<string>()
const RESTART_COOLDOWN_MS = 1000
const NO_CONVERSATION_LIVE_NOTICE = 'Nothing to restart yet — this session has no conversation.'
const NO_CONVERSATION_DEAD_NOTICE = 'Nothing to resume — this session never had a conversation.'
const RELAUNCH_REFUSED_NOTICE = 'Could not start the session again'
const GITHUB_LIST_UNREACHABLE_NOTICE = 'Could not find this workspace’s GitHub page — try again.'
const restoreLaunches = new Set<string>()
let toastTimer: ReturnType<typeof setTimeout> | null = null
const closedTermPtys = new Set<string>()
// PLATFORM§29
const adoptedNudgePending = new Set<string>()
export function consumeAdoptedNudge(id: string): boolean {
  return adoptedNudgePending.delete(id)
}
function terminalOwner(s: AppState, ptyId: string): string | undefined {
  for (const [tabId, set] of Object.entries(s.workbench)) {
    if (set.tabs.some((t) => t.kind === 'terminal' && t.id === ptyId)) return tabId
  }
  return undefined
}

function terminalsOf(s: AppState, tabId: string): string[] {
  return (s.workbench[tabId]?.tabs ?? []).filter((t) => t.kind === 'terminal').map((t) => t.id)
}

function killTerminalsOf(tabId: string): string[] {
  const ids = terminalsOf(useStore.getState(), tabId)
  for (const id of ids) {
    closedTermPtys.add(id)
    window.api.terminal.kill(id)
  }
  return ids
}

function rowOfTab(
  s: Pick<AppState, 'workspaceRows' | 'butlerWorkspace'>,
  tab: Tab
): { row: SessionRow; wsPath: string } | undefined {
  const cwd = tab.launch?.cwd ?? tab.cwd
  const wsPath = everyWorkspaceRows(s)
    .map((w) => w.workspace.path)
    .filter((p) => inRoot(cwd, p))
    .sort((a, b) => b.length - a.length)[0]
  if (!wsPath || !isSessionKind(tab.kind)) return undefined
  return {
    wsPath,
    row: {
      id: tab.id,
      title: tab.title,
      worktree: tab.launch?.worktree ?? (cwd === wsPath ? 'main' : basename(cwd)),
      cwd,
      running: false,
      invalidCwd: false,
      mtime: Date.now(),
      ...sourceOf(tab.kind, wsPath)
    }
  }
}

export function tabEverBound(tabId: string): boolean {
  return lastSessionId.has(tabId)
}

function watchedSessionLeavesForButler(s: AppState, tabId: string): boolean {
  const leaving = s.tabs.find((t) => t.id === tabId)
  return (
    s.activeTabId === tabId &&
    isSessionKind(leaving?.kind) &&
    !!(leaving?.sessionId || lastSessionId.get(tabId)) &&
    butlerSetUp({ assist: s.settings.assist, channel: s.settings.discord.channel }) &&
    !isButlerTab(s.sessions, s.butlerTab, tabId)
  )
}

function samePersistedTabs(a: WorkbenchTabSet, b: WorkbenchTabSet): boolean {
  const x = persistTabs(a)
  const y = persistTabs(b)
  if (x.length !== y.length) return false
  return x.every((t, i) => {
    const o = y[i]
    return (
      t.kind === o.kind &&
      t.title === o.title &&
      t.url === o.url &&
      t.path === o.path &&
      t.view === o.view
    )
  })
}

const workbenchFetches = new Map<string, Promise<void>>()

function movedKey<T>(m: Record<string, T>, oldId: string, newId: string): Record<string, T> {
  if (!(oldId in m)) return m
  const next = { ...m, [newId]: m[oldId] }
  delete next[oldId]
  return next
}

function panelStateMoved(
  s: AppState,
  oldId: string,
  newId: string
): Pick<
  AppState,
  'openFiles' | 'workbench' | 'workbenchOpen' | 'workbenchFetched' | 'changesBase'
> {
  return {
    openFiles: movedKey(s.openFiles, oldId, newId),
    workbench: movedKey(s.workbench, oldId, newId),
    workbenchOpen: movedKey(s.workbenchOpen, oldId, newId),
    workbenchFetched: movedKey(s.workbenchFetched, oldId, newId),
    changesBase: movedKey(s.changesBase, oldId, newId)
  }
}

function workbenchStateDropped(
  s: AppState,
  ids: string[]
): Pick<
  AppState,
  | 'openFiles'
  | 'changesBase'
  | 'workbench'
  | 'workbenchOpen'
  | 'workbenchFetched'
  | 'workbenchWidths'
  | 'workbenchLoad'
  | 'filesReveal'
  | 'followsAgentBrowser'
> {
  const without = <T>(m: Record<string, T>): Record<string, T> => {
    const next = { ...m }
    for (const id of ids) delete next[id]
    return next
  }
  return {
    openFiles: without(s.openFiles),
    changesBase: without(s.changesBase),
    workbench: without(s.workbench),
    workbenchOpen: without(s.workbenchOpen),
    workbenchFetched: without(s.workbenchFetched),
    workbenchWidths: without(s.workbenchWidths),
    workbenchLoad: without(s.workbenchLoad),
    filesReveal: without(s.filesReveal),
    followsAgentBrowser: without(s.followsAgentBrowser)
  }
}

function tabStateMoved(oldId: string, newId: string, sessionId?: string): void {
  const parked = workbenchParked.get(oldId)
  if (parked) {
    workbenchParked.delete(oldId)
    workbenchParked.set(newId, parked)
  }
  rekeyOwner(oldId, newId)
  window.api.tabs.moved(oldId, newId)
  everBoundSession.delete(oldId)
  lastSessionId.delete(oldId)
  if (sessionId !== undefined) lastSessionId.set(newId, sessionId)
}

function wakeInto(asleep: Tab, t: Tab, select: boolean): void {
  useStore.setState((s) => ({
    tabs: s.tabs.map((x) =>
      x.id === asleep.id ? { ...t, title: asleep.title || t.title, ghost: asleep.id } : x
    ),
    activeTabId: select || s.activeTabId === asleep.id ? t.id : s.activeTabId,
    resumeLaunch: select ? null : s.resumeLaunch,
    ...panelStateMoved(s, asleep.id, t.id)
  }))
  tabStateMoved(asleep.id, t.id, t.sessionId ?? '')
}

// CC§9
const A_WAKING_SCREEN_STILL_THIS_LONG_IS_WAITING_FOR_THE_OWNER_MS = 2000
const wakeQuietTimers = new Map<string, ReturnType<typeof setTimeout>>()

export function noteWakingOutput(tabId: string): void {
  clearTimeout(wakeQuietTimers.get(tabId))
  wakeQuietTimers.set(
    tabId,
    setTimeout(() => {
      wakeQuietTimers.delete(tabId)
      useStore.setState((s) =>
        s.tabs.some((t) => t.id === tabId && t.ghost && !t.wakeOverdue)
          ? { tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, wakeOverdue: true } : t)) }
          : s
      )
    }, A_WAKING_SCREEN_STILL_THIS_LONG_IS_WAITING_FOR_THE_OWNER_MS)
  )
}

function asleepTabFor(s: Pick<AppState, 'tabs'>, t: Tab): Tab | undefined {
  return t.sessionId
    ? s.tabs.find((x) => x.asleep && x.sessionId === t.sessionId && x.id !== t.id)
    : undefined
}

function keepUnchangedSessions(prev: SessionInfo[], pushed: SessionInfo[]): SessionInfo[] {
  const before = new Map(prev.map((x) => [x.tabId, x]))
  const next = pushed.map((x) => {
    const old = before.get(x.tabId)
    return old && JSON.stringify(old) === JSON.stringify(x) ? old : x
  })
  return next.length === prev.length && next.every((x, i) => x === prev[i]) ? prev : next
}

function tabIsWoken(s: Pick<AppState, 'sessions'>, tabId: string): boolean {
  return s.sessions.some((x) => x.tabId === tabId && !!x.sessionId && x.status !== undefined)
}

export function boundSessionId(
  s: Pick<AppState, 'sessions' | 'tabs'>,
  tabId: string
): string | undefined {
  const sess = s.sessions.find((x) => x.tabId === tabId)
  return sess?.sessionId || s.tabs.find((t) => t.id === tabId)?.sessionId || undefined
}

export function workbenchOwnerLive(s: Pick<AppState, 'sessions' | 'tabs'>, tab: Tab): boolean {
  if (!hasWorkbench(tab)) return false
  if (tab.respawning) return true
  const sess = s.sessions.find((x) => x.tabId === tab.id)
  if (sess && !sess.alive) return false
  return !!boundSessionId(s, tab.id)
}

export function tabForSession(
  s: Pick<AppState, 'sessions' | 'tabs'>,
  sessionId: string
): string | undefined {
  if (!sessionId) return undefined
  return s.tabs.find((t) => boundSessionId(s, t.id) === sessionId)?.id
}

export function welcomeWorkbenchKey(
  s: Pick<AppState, 'workspaceRows' | 'lastWsPath' | 'resumeLaunch' | 'welcomeActive'>
): string | undefined {
  if (s.resumeLaunch || s.welcomeActive) return undefined
  const ws = welcomeTarget(s.workspaceRows, s.lastWsPath)
  return ws ? workspaceWorkbenchKey(ws.workspace.path) : undefined
}

export function panelTabId(
  s: Pick<
    AppState,
    'tabs' | 'activeTabId' | 'workspaceRows' | 'lastWsPath' | 'resumeLaunch' | 'welcomeActive'
  >
): string | undefined {
  if (!s.activeTabId) return welcomeWorkbenchKey(s)
  const tab = s.tabs.find((t) => t.id === s.activeTabId)
  return hasWorkbench(tab) ? tab?.id : undefined
}

export function workbenchStoreKey(
  s: Pick<AppState, 'sessions' | 'tabs'>,
  tabId: string
): string | undefined {
  return isWorkspaceWorkbenchKey(tabId) ? tabId : boundSessionId(s, tabId)
}

export function panelIsOpen(
  s: Pick<AppState, 'workbenchOpen'>,
  tabId: string | undefined
): boolean {
  if (!tabId) return false
  return s.workbenchOpen[tabId] === true
}

const workbenchParked = new Map<string, (() => void)[]>()

function parkWorkbench(tabId: string, fn: () => void): void {
  const q = workbenchParked.get(tabId)
  if (q) q.push(fn)
  else workbenchParked.set(tabId, [fn])
}

function runParked(tabId: string): void {
  const q = workbenchParked.get(tabId)
  if (!q) return
  workbenchParked.delete(tabId)
  for (const fn of q) fn()
}

function bindParkedWorkbench(): void {
  if (!workbenchParked.size) return
  const s = useStore.getState()
  for (const tabId of [...workbenchParked.keys()]) {
    if (!s.tabs.some((t) => t.id === tabId)) {
      workbenchParked.delete(tabId)
      continue
    }
    if (!boundSessionId(s, tabId)) continue
    void s.ensureWorkbench(tabId)
  }
}

function workbenchAllowed(
  s: Pick<AppState, 'tabs' | 'workspaceRows'>,
  tabId: string | null | undefined
): boolean {
  if (isWorkspaceWorkbenchKey(tabId))
    return s.workspaceRows.some((w) => workspaceWorkbenchKey(w.workspace.path) === tabId)
  return hasWorkbench(s.tabs.find((t) => t.id === tabId))
}

function whenWorkbenchFetched(tabId: string, fn: () => void): void {
  const s = useStore.getState()
  if (!workbenchAllowed(s, tabId)) return
  if (s.workbenchFetched[tabId]) return fn()
  if (!workbenchStoreKey(s, tabId)) return parkWorkbench(tabId, fn)
  void s
    .ensureWorkbench(tabId)
    .catch(() => useStore.getState().ensureWorkbench(tabId))
    .then(fn, () =>
      useStore.getState().showToast('Could not read this session’s panel state — try again.')
    )
}

function writeWorkbench(tabId: string, s: AppState): void {
  const sid = workbenchStoreKey(s, tabId)
  if (!sid) return
  window.api.workbench.setState(sid, {
    open: s.workbenchOpen[tabId] ?? DEFAULT_PANEL_OPEN,
    tabs: persistTabs(s.workbench[tabId] ?? emptyTabSet())
  })
}

function persistWorkbench(tabId: string): void {
  whenWorkbenchFetched(tabId, () => writeWorkbench(tabId, useStore.getState()))
}

let activateOnceSpawned: string | null = null

function landInWorkbench(tabId: string, wbTabId: string): void {
  const s = useStore.getState()
  if (!s.workbenchOpen[tabId]) s.setWorkbenchOpen(tabId, true)
  useStore.setState((st) => ({
    workbenchLoad: {
      ...st.workbenchLoad,
      [tabId]: { tabId: wbTabId, nonce: (st.workbenchLoad[tabId]?.nonce ?? 0) + 1 }
    }
  }))
}

export const useStore = create<AppState>((set, get) => ({
  tabs: [],
  activeTabId: null,
  sessions: [],
  leftovers: {},
  attention: [],
  revealRow: null,
  settings: DEFAULT_SETTINGS,
  settingsOpen: false,
  settingsPane: null,
  settingsFocus: null,
  gitAccountsMachine: undefined,
  welcomeActive: false,
  onboardingStep: 1,
  accounts: null,
  signIn: null,
  accountLogin: null,
  openFiles: {},
  workbenchWidth: DEFAULT_SETTINGS.workbenchWidth,
  workbenchWidths: {},
  sidebarWidth: DEFAULT_SETTINGS.sidebarWidth,
  notesHeight: DEFAULT_SETTINGS.notesHeight,
  workspaceRows: [],
  butlerWorkspace: null,
  toast: null,
  toastReveal: null,
  workbenchOpen: {},
  workbench: {},
  workbenchFetched: {},
  workbenchLoad: {},
  agentOpen: null,
  filesReveal: {},
  changesBase: {},
  workbenchFull: false,
  overlay: null,
  overlayDialog: null,
  cdpAttached: {},
  followsAgentBrowser: {},
  termFocus: { ptyId: '', n: 0 },
  githubBtn: false,
  lastWsPath: null,
  selectedWs: null,
  update: { open: false, phase: 'checking' },
  updateOffer: null,
  setUpdateOffer: (updateOffer) => set({ updateOffer }),
  resumeDialog: null,
  resumeLaunch: null,
  closeConfirm: null,
  cron: { jobs: [], live: [], folders: {}, notes: {} },
  machine: null,
  unsavedPrompt: null,
  butlerTab: null,
  assistAsked: false,
  bindButler: false,
  renameButler: false,
  orphanConfirm: null,

  addTab: (t) => {
    activateOnceSpawned = null
    const asleep = asleepTabFor(get(), t)
    if (asleep) return wakeInto(asleep, t, true)
    set((s) => ({ tabs: [...s.tabs, t], activeTabId: t.id, resumeLaunch: null }))
  },
  addTabQuiet: (t) => {
    const asleep = asleepTabFor(get(), t)
    if (asleep) return wakeInto(asleep, t, false)
    const awaited = activateOnceSpawned === t.id
    if (awaited) activateOnceSpawned = null
    set((s) =>
      s.tabs.some((x) => x.id === t.id)
        ? s
        : {
            tabs: [...s.tabs, t],
            ...(awaited && { activeTabId: t.id, resumeLaunch: null })
          }
    )
  },
  setCron: (cron) => set({ cron }),
  setMachine: (machine) => set({ machine }),
  adoptTabs: (tabs, activeTabBeforeReload) => {
    const fresh = tabs.filter((a) => !get().tabs.some((t) => t.id === a.id))
    if (!fresh.length) {
      if (activeTabBeforeReload && get().tabs.some((t) => t.id === activeTabBeforeReload)) {
        set({ activeTabId: activeTabBeforeReload })
      }
      return
    }
    const adopted: Tab[] = fresh.map((a) => {
      const t: Tab = {
        id: a.id,
        kind: a.kind,
        title: a.title ?? (isSessionKind(a.kind) ? BACKEND_LABEL[a.kind] : 'Terminal'),
        cwd: a.cwd,
        alive: true
      }
      if (a.asleep) return { ...t, alive: false, asleep: true, sessionId: a.sessionId }
      if (a.sessionId) {
        t.sessionId = a.sessionId
        everBoundSession.add(a.id)
        lastSessionId.set(a.id, a.sessionId)
      } else if (a.resumeSessionId) {
        t.sessionId = a.resumeSessionId
        t.resuming = true
      }
      return t
    })
    for (const t of adopted) if (!t.asleep) adoptedNudgePending.add(t.id)
    set((s) => ({
      tabs: [...s.tabs, ...adopted],
      activeTabId: adopted.some((t) => t.id === activeTabBeforeReload)
        ? activeTabBeforeReload
        : s.activeTabId
    }))
  },
  removeTab: (id) => {
    const toButler = watchedSessionLeavesForButler(get(), id)
    killTerminalsOf(id)
    endEditsOf(id)
    set((s) => {
      everBoundSession.delete(id)
      lastSessionId.delete(id)
      workbenchParked.delete(id)
      const tabs = s.tabs.filter((t) => t.id !== id)
      let activeTabId = s.activeTabId
      if (activeTabId === id) activeTabId = tabs.length ? tabs[tabs.length - 1].id : null
      return {
        ...(s.signIn?.tabId === id && {
          signIn: null,
          settingsOpen: s.settingsOpen || s.signIn.backToSettings
        }),
        tabs,
        activeTabId,
        ...workbenchStateDropped(s, [id])
      }
    })
    if (toButler) get().landOnButler()
  },
  closeTab: (id) => {
    restoreLaunches.delete(id)
    window.api.terminal.kill(id)
    get().removeTab(id)
  },
  landOnButler: () => {
    const live = butlerTabOf(get().sessions, get().butlerTab, get().tabs)
    if (live) return get().activateTab(live)
    const landedOn = get().activeTabId
    void window.api.conductors.open().then((r) => {
      if (!r.ok) return get().showToast(r.error)
      get().setButlerTab(r.tabId)
      if (get().activeTabId === landedOn) get().activateTab(r.tabId)
    })
  },
  openButler: async (fresh = false) => {
    const r = await (fresh ? window.api.conductors.startFresh() : window.api.conductors.open())
    if (!r.ok) return r.error
    const st = get()
    st.setButlerTab(r.tabId)
    st.activateTab(r.tabId)
    return null
  },
  setActive: (id) => set({ activeTabId: id }),
  setTabTitle: (id, title) =>
    set((s) => {
      const cur = s.tabs.find((t) => t.id === id)
      if (!cur || cur.title === title) return s
      return { tabs: s.tabs.map((t) => (t.id === id ? { ...t, title } : t)) }
    }),
  setTabAlive: (id, alive) =>
    set((s) => {
      const cur = s.tabs.find((t) => t.id === id)
      if (!cur || cur.alive === alive || cur.asleep || cur.ended) return s
      return { tabs: s.tabs.map((t) => (t.id === id ? { ...t, alive } : t)) }
    }),
  keepEndedTab: (id, note) => {
    const s = get()
    const tab = s.tabs.find((t) => t.id === id)
    const sessionId = boundSessionId(s, id) ?? lastSessionId.get(id)
    const at =
      everyWorkspaceRows(s)
        .flatMap((w) => w.rows.map((row) => ({ row, wsPath: w.workspace.path })))
        .find(({ row }) => row.id === id || row.id === sessionId) ??
      (tab && rowOfTab(s, tab))
    if (!at) return false
    set({
      tabs: s.tabs.map((t) =>
        t.id === id
          ? { ...t, alive: false, resuming: undefined, sessionId, ended: { note, ...at } }
          : t
      )
    })
    return true
  },
  setTabAsleep: (id) =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === id
          ? {
              ...t,
              alive: false,
              asleep: true,
              resuming: undefined,
              sessionId: boundSessionId(s, id) ?? lastSessionId.get(id)
            }
          : t
      )
    })),
  activateTab: (id) => {
    activateOnceSpawned = get().tabs.some((x) => x.id === id) ? null : id
    if (activateOnceSpawned) return
    set({ activeTabId: id, resumeLaunch: null })
  },
  revealTab: (id) => set({ revealRow: { tabId: id } }),

  restartActiveSession: () => {
    const { tabs, activeTabId, sessions } = get()
    const tab = tabs.find((t) => t.id === activeTabId)
    if (!tab) return
    const sess = sessions.find((s) => s.tabId === tab.id)
    const sessionId = sess?.sessionId || tab.sessionId || lastSessionId.get(tab.id)
    if (restarting.has(tab.id)) return
    const oldId = tab.id
    const liveClaude = !!sess?.alive && !!sess.sessionId
    const sayNoConversation = (live: boolean): void => {
      if (!get().tabs.some((x) => x.id === oldId)) return
      get().showToast(live ? NO_CONVERSATION_LIVE_NOTICE : NO_CONVERSATION_DEAD_NOTICE)
    }
    const swapTo = (res: { id: string; cwd: string }, patch: Partial<Tab>): void => {
      set((s) => ({
        tabs: s.tabs.map((x) =>
          x.id === oldId
            ? {
                ...x,
                ...patch,
                id: res.id,
                cwd: res.cwd,
                alive: true,
                respawning: undefined,
                ended: undefined
              }
            : x
        ),
        activeTabId: s.activeTabId === oldId ? res.id : s.activeTabId,
        ...panelStateMoved(s, oldId, res.id)
      }))
      tabStateMoved(oldId, res.id, patch.sessionId)
      restarting.add(res.id)
      setTimeout(() => restarting.delete(res.id), RESTART_COOLDOWN_MS)
    }
    const relaunch = (launch: CreateTabOptions): void => {
      restarting.add(oldId)
      window.api.terminal.kill(oldId, true)
      void window.api.terminal
        .create(launch)
        .then((res) => {
          if (!res.ok) return get().showToast(RELAUNCH_REFUSED_NOTICE)
          if (!get().tabs.some((x) => x.id === oldId)) return window.api.terminal.kill(res.id)
          swapTo(res, { sessionId: undefined })
        })
        .catch((e) => get().showToast(ipcErrorText(e)))
        .finally(() => restarting.delete(oldId))
    }
    const begin = async (resumeId: string, cwd: string, live: boolean): Promise<void> => {
      const backend = identityOf(resumeId).backendId
      restarting.add(oldId)
      // CC§2
      let hasTranscript = false
      let noAccount: string | null = null
      try {
        ;[hasTranscript, noAccount] = await Promise.all([
          window.api.sessions.transcriptExists(resumeId),
          window.api.sessions.noAccountToResume(resumeId)
        ])
      } catch {
        restarting.delete(oldId)
        return
      }
      if (!hasTranscript) {
        restarting.delete(oldId)
        if (tab.ended && tab.launch) return relaunch(tab.launch)
        sayNoConversation(live)
        return
      }
      if (!get().tabs.some((x) => x.id === oldId)) {
        restarting.delete(oldId)
        return
      }
      if (noAccount) {
        restarting.delete(oldId)
        get().showToast(noAccount)
        return
      }
      if (!tab.ended) restartedPtys.add(oldId)
      const title = sess?.title ?? tab.title
      set((s) => ({
        tabs: s.tabs.map((x) =>
          x.id === oldId ? { ...x, title, ...(live ? { respawning: true as const } : {}) } : x
        )
      }))
      window.api.terminal.kill(oldId, true)
      const failed = (why?: string): void => {
        if (why && get().tabs.some((x) => x.id === oldId)) get().showToast(why)
        set((s) => ({
          tabs: s.tabs.map((x) =>
            x.id === oldId ? { ...x, alive: false, respawning: undefined } : x
          )
        }))
      }
      void window.api.sessions
        .resume({ sessionId: resumeId, cwd })
        .then((res) => {
          if (!res.ok) {
            const main =
              res.code === 'rebuild-failed' ? workspaceOfRow(get().workspaceRows, resumeId) : null
            if (!main) return failed(resumeFailureMessage(res))
            get().setResumeDialog({
              kind: 'escape',
              target: { backendId: backend, id: resumeId, title },
              worktreeName: basename(cwd),
              cwd: main
            })
            return failed()
          }
          if (!get().tabs.some((x) => x.id === oldId)) {
            window.api.terminal.kill(res.id)
            return
          }
          swapTo(res, { kind: backend, sessionId: resumeId })
        })
        .catch(() => failed('Resume failed'))
        .finally(() => restarting.delete(oldId))
    }
    if (sessionId) return void begin(sessionId, sess?.treeRoot ?? tab.cwd, liveClaude)
    if (tab.ended && tab.launch) return relaunch(tab.launch)
    restarting.add(oldId)
    void window.api.sessions
      .list()
      .then((live) => {
        restarting.delete(oldId)
        const bound = live.find((s) => s.tabId === oldId && s.sessionId)
        if (bound) return void begin(bound.sessionId, bound.treeRoot || tab.cwd, bound.alive)
        const now = get().tabs.find((x) => x.id === oldId)
        if (now && isSessionKind(now.kind)) sayNoConversation(now.alive)
      })
      .catch(() => restarting.delete(oldId))
  },

  setSessions: (pushed) => {
    set((s) => {
      const sessions = keepUnchangedSessions(s.sessions, pushed)
      const liveTabs = new Set(sessions.map((x) => x.tabId))
      for (const id of liveTabs) everBoundSession.add(id)
      for (const x of sessions) {
        if (!x.sessionId) continue
        lastSessionId.set(x.tabId, x.sessionId)
        restoreLaunches.delete(x.tabId)
      }
      let changed = false
      let activeReverted = false
      const tabs = s.tabs.map((t) => {
        const woken = !!t.ghost && tabIsWoken({ sessions }, t.id)
        const bound = !!t.resuming && liveTabs.has(t.id)
        if (woken || bound) {
          changed = true
          return {
            ...t,
            ...(woken ? { ghost: undefined, wakeOverdue: undefined } : {}),
            ...(bound ? { resuming: undefined } : {})
          }
        }
        if (
          isSessionKind(t.kind) &&
          !t.asleep &&
          !t.ended &&
          !liveTabs.has(t.id) &&
          everBoundSession.has(t.id) &&
          !restarting.has(t.id)
        ) {
          changed = true
          if (t.id === s.activeTabId) activeReverted = true
          return { ...t, kind: 'shell' as TabKind, sessionId: undefined, title: 'Terminal' }
        }
        return t
      })
      if (!changed) return sessions === s.sessions ? s : { sessions }
      if (!activeReverted) return { sessions, tabs }
      const openFiles = { ...s.openFiles }
      if (s.activeTabId) delete openFiles[s.activeTabId]
      return { sessions, tabs, openFiles }
    })
    bindParkedWorkbench()
  },
  setLeftovers: (leftovers) => set({ leftovers }),
  setAttention: (attention) => set({ attention }),
  setSettings: (settings) => set({ settings }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen, settingsPane: null }),
  openSettingsPane: (settingsPane) => set({ settingsOpen: true, settingsPane }),
  setSettingsFocus: (settingsFocus) => set({ settingsFocus }),
  openGitAccounts: (focus, machine) =>
    set({
      settingsFocus: focus ?? 'git-accounts',
      gitAccountsMachine: machine,
      settingsOpen: true
    }),
  setWelcomeActive: (welcomeActive) => set({ welcomeActive }),
  setOnboardingStep: (onboardingStep) => set({ onboardingStep }),
  setAccounts: (accounts) => set({ accounts }),
  showSignInTab: (tabId) =>
    set((s) => ({
      signIn: { tabId, backToSettings: s.settingsOpen },
      settingsOpen: false
    })),
  beginLogin: (reauthName) => set({ accountLogin: { reauthName, progress: null } }),
  setLoginProgress: (progress) =>
    set((s) => ({ accountLogin: { ...(s.accountLogin ?? {}), progress } })),
  clearLogin: () => set({ accountLogin: null }),
  setOpenFile: (f, tabId) => {
    const s = get()
    const id = tabId ?? s.activeTabId ?? welcomeWorkbenchKey(s)
    if (!id) return
    if (f) revealFiles(id, 'browse')
    set((st) => ({ openFiles: { ...st.openFiles, [id]: f } }))
  },
  openChanges: (tabId) => revealFiles(tabId, 'changes'),
  setChangesBase: (tabId, base) =>
    set((s) =>
      s.changesBase[tabId] === base ? s : { changesBase: { ...s.changesBase, [tabId]: base } }
    ),
  setWorkbenchWidth: (workbenchWidth) => set({ workbenchWidth }),
  setTabWorkbenchWidth: (tabId, w) =>
    set((s) => ({ workbenchWidth: w, workbenchWidths: { ...s.workbenchWidths, [tabId]: w } })),
  setSidebarWidth: (sidebarWidth) => set({ sidebarWidth }),
  setNotesHeight: (notesHeight) => set({ notesHeight }),
  setWorkspaceRows: (all) => {
    const kept = new Set(all.map((w) => workspaceWorkbenchKey(w.workspace.path)))
    const s = get()
    const gone = [
      ...new Set([...Object.keys(s.workbench), ...Object.keys(s.workbenchOpen)])
    ].filter((k) => isWorkspaceWorkbenchKey(k) && !kept.has(k))
    for (const k of gone) {
      endEditsOf(k)
      workbenchParked.delete(k)
    }
    set((s) => {
      const workspaceRows = all.filter((w) => !w.workspace.butler)
      return {
        ...(gone.length > 0 && workbenchStateDropped(s, gone)),
        workspaceRows,
        butlerWorkspace: all.find((w) => w.workspace.butler) ?? null,
        selectedWs: workspaceRows.some((w) => w.workspace.path === s.selectedWs)
          ? s.selectedWs
          : null
      }
    })
  },
  showToast: (msg, reveal) => {
    if (toastTimer) clearTimeout(toastTimer)
    toastTimer = setTimeout(() => {
      toastTimer = null
      set({ toast: null, toastReveal: null })
    }, 4000)
    set({ toast: msg, toastReveal: reveal ?? null })
  },
  dismissToast: () => {
    if (toastTimer) clearTimeout(toastTimer)
    toastTimer = null
    set({ toast: null, toastReveal: null })
  },
  setResumeDialog: (resumeDialog) => set({ resumeDialog }),
  setResumeLaunch: (resumeLaunch) => set({ resumeLaunch }),
  setCloseConfirm: (closeConfirm) => set({ closeConfirm }),
  setUnsavedPrompt: (unsavedPrompt) => set({ unsavedPrompt }),
  setButlerTab: (butlerTab) => set({ butlerTab }),
  setAssistAsked: (assistAsked) => set({ assistAsked }),
  setBindButler: (bindButler) => set({ bindButler }),
  setRenameButler: (renameButler) => set({ renameButler }),
  setOrphanConfirm: (orphanConfirm) => set({ orphanConfirm }),

  ensureWorkbench: (tabId) => {
    if (!workbenchAllowed(get(), tabId)) return Promise.resolve()
    if (get().workbenchFetched[tabId]) return Promise.resolve()
    const inflight = workbenchFetches.get(tabId)
    if (inflight) return inflight
    const sid = workbenchStoreKey(get(), tabId)
    if (!sid) return Promise.resolve()
    const p = window.api.workbench
      .get(sid)
      .then((st) => {
        if (!workbenchAllowed(get(), tabId)) return
        if (st) get().setWorkbenchState(tabId, st)
        else set((s) => ({ workbenchFetched: { ...s.workbenchFetched, [tabId]: true } }))
        runParked(tabId)
      })
      .finally(() => workbenchFetches.delete(tabId))
    workbenchFetches.set(tabId, p)
    return p
  },
  setWorkbenchState: (tabId, state) =>
    set((s) => ({
      workbenchOpen:
        tabId in s.workbenchOpen ? s.workbenchOpen : { ...s.workbenchOpen, [tabId]: state.open },
      workbench:
        tabId in s.workbench ? s.workbench : { ...s.workbench, [tabId]: restoreTabSet(state.tabs) },
      workbenchFetched: { ...s.workbenchFetched, [tabId]: true }
    })),
  setWorkbenchOpen: (tabId, open) => {
    if (!workbenchAllowed(get(), tabId)) return
    set((s) => ({ workbenchOpen: { ...s.workbenchOpen, [tabId]: open } }))
    persistWorkbench(tabId)
  },
  updateWorkbenchTabs: (tabId, update, after) =>
    whenWorkbenchFetched(tabId, () => {
      const prev = get().workbench[tabId] ?? emptyTabSet()
      const next = update(prev)
      if (next !== prev) set((s) => ({ workbench: { ...s.workbench, [tabId]: next } }))
      if (!samePersistedTabs(prev, next)) persistWorkbench(tabId)
      after?.()
    }),
  openWorkbenchTarget: (tabId, opts) =>
    whenWorkbenchFetched(tabId, () => {
      const s = get()
      const base = s.workbench[tabId] ?? emptyTabSet()
      const r = openTab(base, {
        kind: 'web',
        ...opts,
        openedByAgent: opts.fromShim,
        agentOpenedAt: opts.fromShim ? Date.now() : undefined
      })
      set((st) => ({ workbench: { ...st.workbench, [tabId]: r.set } }))
      persistWorkbench(tabId)
      if (r.evicted) s.showToast(tabEvictedNotice(tabLabel(r.set, r.evicted)))
      if (opts.source !== 'user') {
        if (!opts.fromShim) return
        set((st) => ({
          agentOpen: {
            ownerTabId: tabId,
            tabId: r.tabId,
            nonce: (st.agentOpen?.nonce ?? 0) + 1
          }
        }))
      }
      landInWorkbench(tabId, r.tabId)
    }),
  setWorkbenchFull: (workbenchFull) => {
    if (workbenchFull && !workbenchAllowed(get(), panelTabId(get()))) return
    set({ workbenchFull })
  },
  landOverlay: (url, presentation) => {
    const shown = presentation === 'now' || (get().overlay?.open ?? false)
    set({ overlay: { url, unread: !shown, open: shown } })
    if (!shown) get().showToast('Page opened in the background — see the titlebar')
  },
  showOverlay: () =>
    set((s) => (s.overlay ? { overlay: { ...s.overlay, unread: false, open: true } } : {})),
  closeOverlay: () => set({ overlay: null }),
  setOverlayDialog: (overlayDialog) => set({ overlayDialog }),
  setCdpAttached: (sessionId, targetIds) =>
    set((s) => ({ cdpAttached: { ...s.cdpAttached, [sessionId]: targetIds } })),
  openCdpTab: async (tabId, url) => {
    await get().ensureWorkbench(tabId)
    const s = get()
    const sid = boundSessionId(s, tabId)
    const r = openTab(s.workbench[tabId] ?? emptyTabSet(), {
      kind: 'web',
      url,
      source: 'cdp',
      openedByAgent: true,
      pinned: new Set((sid && s.cdpAttached[sid]) || [])
    })
    if (r.refused) return null
    set((st) => ({ workbench: { ...st.workbench, [tabId]: r.set } }))
    persistWorkbench(tabId)
    if (r.evicted) s.showToast(tabEvictedNotice(tabLabel(r.set, r.evicted)))
    if (s.followsAgentBrowser[tabId]) landInWorkbench(tabId, r.tabId)
    return r.tabId
  },
  followAgentBrowser: (tabId) => {
    set((s) => ({ followsAgentBrowser: { ...s.followsAgentBrowser, [tabId]: true } }))
    get().setWorkbenchOpen(tabId, true)
  },
  setLastWsPath: (lastWsPath) => set({ lastWsPath }),
  selectWorkspace: (path) =>
    set({
      selectedWs: path,
      activeTabId: null,
      lastWsPath: path,
      resumeLaunch: null,
      workbenchFull: false
    }),
  openWorkspaceList: (path, what) => {
    get().selectWorkspace(path)
    void window.api.github
      .target(path, what)
      .then((url) => {
        if (!url) return get().showToast(GITHUB_LIST_UNREACHABLE_NOTICE)
        get().openWorkbenchTarget(workspaceWorkbenchKey(path), { url, source: 'user' })
      })
      .catch(() => get().showToast(GITHUB_LIST_UNREACHABLE_NOTICE))
  },

  focusPanelTerm: (ptyId) => set((st) => ({ termFocus: { ptyId, n: st.termFocus.n + 1 } })),
  // PLATFORM§25
  setGithubBtn: (on) => {
    if (get().githubBtn !== on) set({ githubBtn: on })
  },

  openTerminalTab: (tabId) =>
    whenWorkbenchFetched(tabId, () => {
      const st = get()
      const base = st.workbench[tabId] ?? emptyTabSet()
      if (base.tabs.filter((t) => t.kind === 'terminal').length >= KIND_TAB_CAP) {
        st.showToast(TERMINAL_CAP_NOTICE)
        return
      }
      const tab = st.tabs.find((t) => t.id === tabId)
      const cwd = selectionRoot(
        tab,
        st.sessions.find((x) => x.tabId === tabId)?.treeRoot,
        undefined
      )
      void window.api.terminal
        .create({ kind: 'shell', cwd: cwd ?? window.api.home, util: true, ownerTabId: tabId })
        .then((res) => {
          if (!res.ok) throw new Error(res.code)
          if (!get().tabs.some((t) => t.id === tabId)) {
            window.api.terminal.kill(res.id)
            return
          }
          let refused = false
          get().updateWorkbenchTabs(tabId, (prev) => {
            const r = openTab(prev, {
              kind: 'terminal',
              id: res.id,
              cwd: res.cwd,
              title: DEFAULT_TERMINAL_TITLE,
              source: 'user'
            })
            refused = !!r.refused
            return r.set
          })
          if (refused) {
            window.api.terminal.kill(res.id)
            get().showToast(TERMINAL_CAP_NOTICE)
            return
          }
          if (cwd && res.cwd !== cwd) get().showToast(cwdFallbackNotice(res.cwd))
          if (!get().workbenchOpen[tabId]) get().setWorkbenchOpen(tabId, true)
          get().focusPanelTerm(res.id)
        })
        .catch(() => get().showToast(TERM_SPAWN_FAILED_NOTICE))
    }),

  closeTerminalTab: (ptyId) => {
    closedTermPtys.add(ptyId)
    window.api.terminal.kill(ptyId)
  },

  terminalExited: (ptyId) => {
    if (closedTermPtys.delete(ptyId)) return true
    const owner = terminalOwner(get(), ptyId)
    if (!owner) return false
    get().updateWorkbenchTabs(owner, (prev) => closeWbTab(prev, ptyId))
    return true
  },

  setTermTabProcess: (ptyId, name) => {
    const s = get()
    const owner = terminalOwner(s, ptyId)
    if (!owner) return
    if (s.workbench[owner]?.tabs.find((t) => t.id === ptyId)?.title === name) return
    s.updateWorkbenchTabs(owner, (prev) => retitleTab(prev, ptyId, name))
  },

  setTermTabCwd: (ptyId, cwd) => {
    const s = get()
    const owner = terminalOwner(s, ptyId)
    if (!owner) return
    if (s.workbench[owner]?.tabs.find((t) => t.id === ptyId)?.cwd === cwd) return
    s.updateWorkbenchTabs(owner, (prev) => ({
      ...prev,
      tabs: prev.tabs.map((t) => (t.id === ptyId ? { ...t, cwd } : t))
    }))
  },

  openUpdateCheck: () => {
    if (get().update.phase === 'downloading') {
      set((s) => ({ update: { ...s.update, open: true } }))
      return
    }
    set({ update: { open: true, phase: 'checking' } })
    void window.api.update
      .check()
      .then((r) =>
        set((s) => {
          if (!s.update.open) return s
          if (r.status === 'available') {
            return {
              update: {
                ...s.update,
                phase: 'available' as const,
                current: r.current,
                installed: r.installed,
                latest: r.latest,
                releases: r.releases,
                omittedReleases: r.omittedReleases,
                htmlUrl: r.htmlUrl
              }
            }
          }
          if (r.status === 'restart-required') {
            return {
              update: {
                ...s.update,
                phase: 'restart-required' as const,
                current: r.current,
                installed: r.installed
              }
            }
          }
          return {
            update: {
              ...s.update,
              phase: 'current' as const,
              current: r.current,
              installed: r.installed
            }
          }
        })
      )
      .catch((e) =>
        set((s) =>
          s.update.open ? { update: { ...s.update, phase: 'error', error: ipcErrorText(e) } } : {}
        )
      )
  },
  openWhatsNew: (w) =>
    set({
      update: {
        open: true,
        phase: 'whats-new',
        current: w.current,
        releases: w.releases,
        omittedReleases: w.omittedReleases
      }
    }),
  startUpdateDownload: () => {
    set((s) => ({ update: { ...s.update, phase: 'downloading', percent: 0 } }))
    void window.api.update
      .download()
      .then((r) => {
        if (r) {
          set((s) => ({
            update: {
              ...s.update,
              phase: r.status === 'restart-required' ? 'restart-required' : 'current',
              current: r.current,
              installed: r.installed,
              restarting: false
            }
          }))
        }
      })
      .catch((e) =>
        set((s) => ({ update: { ...s.update, phase: 'error', error: ipcErrorText(e) } }))
      )
  },
  setUpdate: (patch) => {
    const prev = get().update
    const update = { ...prev, ...patch }
    if (prev.open && !update.open && update.phase === 'whats-new' && update.current) {
      void window.api.settings.set({ lastSeenVersion: update.current })
    }
    set({ update })
  }
}))

export const useActiveOpenFile = (): OpenFile | null =>
  useStore((s) => {
    const id = s.activeTabId ?? welcomeWorkbenchKey(s)
    return id ? (s.openFiles[id] ?? null) : null
  })

export function consumeRestartExit(ptyId: string): boolean {
  return restartedPtys.delete(ptyId)
}

export function launchToStartAgain(launch: CreateTabOptions, landedIn: string): CreateTabOptions {
  const madeAWorktree =
    (launch.worktree !== undefined || launch.worktreeResourceId !== undefined) &&
    landedIn !== launch.cwd
  return madeAWorktree
    ? { ...launch, cwd: landedIn, worktree: undefined, worktreeResourceId: undefined }
    : launch
}

export function keptTabsToClose(s: Pick<AppState, 'tabs' | 'sessions'>): Tab[] {
  return endedTabsLiveElsewhere(s.tabs, s.sessions).filter((t) => !restarting.has(t.id))
}

export function conversationTabFor(ptyId: string): string {
  return terminalOwner(useStore.getState(), ptyId) ?? ptyId
}

export function markRestoreLaunch(ptyId: string): void {
  restoreLaunches.add(ptyId)
}

export function consumeRestoreExit(ptyId: string): boolean {
  return restoreLaunches.delete(ptyId)
}

function revealFiles(tabId: string, view: FilesTab): void {
  const s = useStore.getState()
  s.updateWorkbenchTabs(tabId, (prev) => activateWbTab(prev, FILES_TAB_ID))
  if (!s.workbenchOpen[tabId]) s.setWorkbenchOpen(tabId, true)
  useStore.setState((st) => ({
    filesReveal: {
      ...st.filesReveal,
      [tabId]: { view, nonce: (st.filesReveal[tabId]?.nonce ?? 0) + 1 }
    }
  }))
}

export function openInterceptedFile(
  ptyId: string,
  src: string,
  source: 'agent' | 'user' = 'agent',
  view?: ArtifactView
): void {
  const { tabs, activeTabId, setOpenFile } = useStore.getState()
  const tabId = conversationTabFor(ptyId)
  const file: OpenFile = {
    src,
    label: basename(src),
    source: source === 'agent' ? 'intercept' : undefined,
    view,
    openedAt: source === 'agent' ? Date.now() : undefined
  }
  if (isWorkspaceWorkbenchKey(tabId)) {
    setOpenFile(file, tabId)
    return
  }
  if (tabs.some((t) => t.id === tabId) && activeTabId !== tabId) {
    setOpenFile({ ...file, unseen: true }, tabId)
    return
  }
  if (!activeTabId) {
    window.api.preview.osOpen(src)
    return
  }
  setOpenFile(file)
}

export function previewLinkTarget(href: string, fromSrc: string): string {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href)) return href
  return resolveOnHost(fromSrc, href.replace(/^\/+/, ''))
}

export function openWebPage(src: string, sourceTabId?: string, sourcePath?: string): void {
  const st = useStore.getState()
  const decision = routeFor(src, 'user')
  if (decision.dest !== 'browser') return
  const tabId = panelTabId(st)
  if (!tabId) {
    st.landOverlay(decision.target, 'now')
    return
  }
  st.openWorkbenchTarget(tabId, { url: decision.target, source: 'user', sourceTabId, sourcePath })
}

useStore.subscribe((state, prev) => {
  if (state.activeTabId === prev.activeTabId) return
  if (state.workbenchFull) useStore.setState({ workbenchFull: false })
  const tabId = state.activeTabId
  const waiting = tabId ? state.openFiles[tabId] : null
  if (tabId && waiting?.unseen)
    useStore.setState((s) => ({
      openFiles: { ...s.openFiles, [tabId]: { ...waiting, unseen: undefined } }
    }))
})

useStore.subscribe((state) => {
  if ((state.activeTabId || state.resumeLaunch) && state.selectedWs)
    useStore.setState({ selectedWs: null })
})
