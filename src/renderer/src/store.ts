import { hostOf } from '@shared/remoteKey'
import { identityOf } from '@shared/sessionBackend'
import { backendLabel, hasWorkbench, isSessionKind } from './agentUi'
import { create } from 'zustand'
import {
  DEFAULT_SETTINGS,
  DEFAULT_TERMINAL_TITLE,
  type AdoptableTab,
  type ArtifactView,
  type BrowserJsDialog,
  type CronState,
  type SessionWorkbenchState,
  type LoginProgress,
  type LeftoverProcess,
  type SessionInfo,
  type TabKind,
  type HostId,
  type Settings,
  type ReleaseNotes,
  type WhatsNew,
  type UpdateCheckResult,
  type WorkspaceRows
} from '@shared/types'
import { basename } from '@shared/preview'
import { canOpenExternally, routeFor } from '@shared/browserRoute'
import type { LoginFlowState } from './components/settings/loginFlow'
import type { ResumeDialogState } from './resumeFlow'
import { endEditsOf, rekeyOwner } from './editRegistry'
import { selectionRoot } from './sessionRows'
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
import { DEFAULT_PANEL_OPEN } from '@shared/workbenchState'

export interface Tab {
  id: string
  kind: TabKind
  host: HostId
  title: string
  cwd: string
  sessionId?: string
  alive: boolean
  resuming?: boolean
  jobId?: string
}

export interface OpenFile {
  src: string
  label: string
  line?: number
  source?: 'intercept'
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

interface AppState {
  tabs: Tab[]
  activeTabId: string | null
  sessions: SessionInfo[]
  leftovers: Record<string, LeftoverProcess[]>
  settings: Settings
  settingsOpen: boolean
  welcomeActive: boolean
  accountLogin: LoginFlowState | null
  openFiles: Record<string, OpenFile | null>
  workbenchWidth: number
  workbenchWidths: Record<string, number>
  sidebarWidth: number
  notesHeight: number
  workspaceRows: WorkspaceRows[]
  toast: string | null
  toastReveal: string | null
  workbenchOpen: Record<string, boolean>
  workbench: Record<string, WorkbenchTabSet>
  workbenchFetched: Record<string, true>
  workbenchLoad: { ownerTabId: string; tabId: string; nonce: number } | null
  agentOpen: { ownerTabId: string; tabId: string; nonce: number } | null
  filesReveal: { tabId: string; nonce: number } | null
  workbenchFull: boolean
  overlay: { url: string; unread: boolean; open: boolean } | null
  cdpAttached: Record<string, string[]>
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
    onCancel(): void
    onDiscard(): void
    onSave(): void | Promise<void>
  } | null

  addTab: (t: Tab) => void
  addTabQuiet: (t: Tab) => void
  setCron: (s: CronState) => void
  adoptTabs: (tabs: AdoptableTab[], activeTabBeforeReload: string | null) => void
  removeTab: (id: string) => void
  closeTab: (id: string) => void
  setActive: (id: string) => void
  setTabTitle: (id: string, title: string) => void
  setTabAlive: (id: string, alive: boolean) => void

  activateTab: (id: string) => void
  restartActiveSession: () => void

  setSessions: (s: SessionInfo[]) => void
  setLeftovers: (l: Record<string, LeftoverProcess[]>) => void
  setSettings: (s: Settings) => void
  setSettingsOpen: (open: boolean) => void
  setWelcomeActive: (on: boolean) => void
  beginLogin: (reauthName?: string) => void
  setLoginProgress: (p: LoginProgress) => void
  clearLogin: () => void
  setOpenFile: (f: OpenFile | null) => void
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
  setLastWsPath: (p: string) => void
  selectWorkspace: (path: string) => void

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

const IPC_INVOKE_ERROR_PREFIX = 'Error: '

// PLATFORM§6
function ipcErrMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  const i = msg.lastIndexOf(IPC_INVOKE_ERROR_PREFIX)
  return i >= 0 ? msg.slice(i + IPC_INVOKE_ERROR_PREFIX.length) : msg
}

const everBoundSession = new Set<string>()
const lastSessionId = new Map<string, string>()
const restarting = new Set<string>()
const restartedPtys = new Set<string>()
const RESTART_COOLDOWN_MS = 1000
const NO_CONVERSATION_LIVE_NOTICE = 'Nothing to restart yet — this session has no conversation.'
const NO_CONVERSATION_DEAD_NOTICE = 'Nothing to resume — this session never had a conversation.'
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

export function boundSessionId(
  s: Pick<AppState, 'sessions' | 'tabs'>,
  tabId: string
): string | undefined {
  const sess = s.sessions.find((x) => x.tabId === tabId)
  return sess?.sessionId || s.tabs.find((t) => t.id === tabId)?.sessionId || undefined
}

export function tabForSession(
  s: Pick<AppState, 'sessions' | 'tabs'>,
  sessionId: string
): string | undefined {
  if (!sessionId) return undefined
  return s.tabs.find((t) => boundSessionId(s, t.id) === sessionId)?.id
}

export function panelTabId(s: Pick<AppState, 'tabs' | 'activeTabId'>): string | undefined {
  const tab = s.tabs.find((t) => t.id === s.activeTabId)
  return hasWorkbench(tab) ? tab?.id : undefined
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

function workbenchAllowed(s: Pick<AppState, 'tabs'>, tabId: string | null): boolean {
  return hasWorkbench(s.tabs.find((t) => t.id === tabId))
}

function whenWorkbenchFetched(tabId: string, fn: () => void): void {
  const s = useStore.getState()
  if (!workbenchAllowed(s, tabId)) return
  if (s.workbenchFetched[tabId]) return fn()
  if (!boundSessionId(s, tabId)) return parkWorkbench(tabId, fn)
  void s
    .ensureWorkbench(tabId)
    .catch(() => useStore.getState().ensureWorkbench(tabId))
    .then(fn, () =>
      useStore.getState().showToast('Could not read this session’s panel state — try again.')
    )
}

function writeWorkbench(tabId: string, s: AppState): void {
  const sid = boundSessionId(s, tabId)
  if (!sid) return
  window.api.workbench.setState(sid, {
    open: s.workbenchOpen[tabId] ?? DEFAULT_PANEL_OPEN,
    tabs: persistTabs(s.workbench[tabId] ?? emptyTabSet())
  })
}

function persistWorkbench(tabId: string): void {
  whenWorkbenchFetched(tabId, () => writeWorkbench(tabId, useStore.getState()))
}

export const useStore = create<AppState>((set, get) => ({
  tabs: [],
  activeTabId: null,
  sessions: [],
  leftovers: {},
  settings: DEFAULT_SETTINGS,
  settingsOpen: false,
  welcomeActive: false,
  accountLogin: null,
  openFiles: {},
  workbenchWidth: DEFAULT_SETTINGS.workbenchWidth,
  workbenchWidths: {},
  sidebarWidth: DEFAULT_SETTINGS.sidebarWidth,
  notesHeight: DEFAULT_SETTINGS.notesHeight,
  workspaceRows: [],
  toast: null,
  toastReveal: null,
  workbenchOpen: {},
  workbench: {},
  workbenchFetched: {},
  workbenchLoad: null,
  agentOpen: null,
  filesReveal: null,
  workbenchFull: false,
  overlay: null,
  overlayDialog: null,
  cdpAttached: {},
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
  unsavedPrompt: null,

  addTab: (t) => {
    set((s) => ({ tabs: [...s.tabs, t], activeTabId: t.id, resumeLaunch: null }))
  },
  addTabQuiet: (t) =>
    set((s) => (s.tabs.some((x) => x.id === t.id) ? {} : { tabs: [...s.tabs, t] })),
  setCron: (cron) => set({ cron }),
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
        host: hostOf(a.cwd),
        title: a.title ?? (isSessionKind(a.kind) ? backendLabel(a.kind) : 'Terminal'),
        cwd: a.cwd,
        alive: true
      }
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
    for (const t of adopted) adoptedNudgePending.add(t.id)
    set((s) => ({
      tabs: [...s.tabs, ...adopted],
      activeTabId: adopted.some((t) => t.id === activeTabBeforeReload)
        ? activeTabBeforeReload
        : s.activeTabId
    }))
  },
  removeTab: (id) => {
    killTerminalsOf(id)
    endEditsOf(id)
    set((s) => {
      everBoundSession.delete(id)
      lastSessionId.delete(id)
      workbenchParked.delete(id)
      const tabs = s.tabs.filter((t) => t.id !== id)
      const openFiles = { ...s.openFiles }
      delete openFiles[id]
      let activeTabId = s.activeTabId
      if (activeTabId === id) activeTabId = tabs.length ? tabs[tabs.length - 1].id : null
      const workbench = { ...s.workbench }
      const workbenchOpen = { ...s.workbenchOpen }
      const workbenchFetched = { ...s.workbenchFetched }
      const workbenchWidths = { ...s.workbenchWidths }
      delete workbench[id]
      delete workbenchOpen[id]
      delete workbenchFetched[id]
      delete workbenchWidths[id]
      return {
        tabs,
        openFiles,
        activeTabId,
        workbench,
        workbenchOpen,
        workbenchFetched,
        workbenchWidths
      }
    })
  },
  closeTab: (id) => {
    restoreLaunches.delete(id)
    window.api.terminal.kill(id)
    get().removeTab(id)
  },
  setActive: (id) => set({ activeTabId: id }),
  setTabTitle: (id, title) =>
    set((s) => {
      const cur = s.tabs.find((t) => t.id === id)
      if (!cur || cur.title === title) return {}
      return { tabs: s.tabs.map((t) => (t.id === id ? { ...t, title } : t)) }
    }),
  setTabAlive: (id, alive) =>
    set((s) => {
      const cur = s.tabs.find((t) => t.id === id)
      if (!cur || cur.alive === alive) return {}
      return { tabs: s.tabs.map((t) => (t.id === id ? { ...t, alive } : t)) }
    }),
  activateTab: (id) => {
    if (!get().tabs.some((x) => x.id === id)) return
    set({ activeTabId: id, resumeLaunch: null })
  },

  restartActiveSession: () => {
    const { tabs, activeTabId, sessions } = get()
    const tab = tabs.find((t) => t.id === activeTabId)
    if (!tab) return
    const sess = sessions.find((s) => s.tabId === tab.id)
    const sessionId = sess?.sessionId || tab.sessionId || lastSessionId.get(tab.id)
    if (restarting.has(tab.id)) return
    const oldId = tab.id
    const liveClaude = !!sess?.alive && !!sess.sessionId
    const begin = async (resumeId: string, cwd: string, live: boolean): Promise<void> => {
      const backend = identityOf(resumeId).backendId
      restarting.add(oldId)
      // CC§2
      let hasTranscript = false
      try {
        hasTranscript = await window.api.sessions.transcriptExists(resumeId)
      } catch {
        restarting.delete(oldId)
        return
      }
      if (!hasTranscript) {
        restarting.delete(oldId)
        get().showToast(live ? NO_CONVERSATION_LIVE_NOTICE : NO_CONVERSATION_DEAD_NOTICE)
        return
      }
      if (!get().tabs.some((x) => x.id === oldId)) {
        restarting.delete(oldId)
        return
      }
      restartedPtys.add(oldId)
      get().setTabTitle(oldId, sess?.title ?? tab.title)
      window.api.terminal.kill(oldId)
      void window.api.sessions
        .resume({ sessionId: resumeId, cwd })
        .then((res) => {
          if (!res.ok) throw new Error(res.code)
          if (!get().tabs.some((x) => x.id === oldId)) {
            window.api.terminal.kill(res.id)
            return
          }
          set((s) => {
            const tabs = s.tabs.map((x) =>
              x.id === oldId
                ? {
                    ...x,
                    id: res.id,
                    kind: backend,
                    cwd: res.cwd,
                    sessionId: resumeId,
                    alive: true
                  }
                : x
            )
            const activeTabId = s.activeTabId === oldId ? res.id : s.activeTabId
            const move = <T>(m: Record<string, T>): Record<string, T> => {
              if (!(oldId in m)) return m
              const next = { ...m, [res.id]: m[oldId] }
              delete next[oldId]
              return next
            }
            return {
              tabs,
              activeTabId,
              openFiles: move(s.openFiles),
              workbench: move(s.workbench),
              workbenchOpen: move(s.workbenchOpen),
              workbenchFetched: move(s.workbenchFetched)
            }
          })
          const parked = workbenchParked.get(oldId)
          if (parked) {
            workbenchParked.delete(oldId)
            workbenchParked.set(res.id, parked)
          }
          rekeyOwner(oldId, res.id)
          everBoundSession.delete(oldId)
          lastSessionId.delete(oldId)
          lastSessionId.set(res.id, resumeId)
          restarting.add(res.id)
          setTimeout(() => restarting.delete(res.id), RESTART_COOLDOWN_MS)
        })
        .catch(() => {
          get().setTabAlive(oldId, false)
        })
        .finally(() => restarting.delete(oldId))
    }
    if (sessionId) return void begin(sessionId, sess?.treeRoot ?? tab.cwd, liveClaude)
    restarting.add(oldId)
    void window.api.sessions
      .list()
      .then((live) => {
        restarting.delete(oldId)
        const bound = live.find((s) => s.tabId === oldId && s.sessionId)
        if (!bound) return
        void begin(bound.sessionId, bound.treeRoot || tab.cwd, bound.alive)
      })
      .catch(() => restarting.delete(oldId))
  },

  setSessions: (sessions) => {
    set((s) => {
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
        if (t.resuming && liveTabs.has(t.id)) {
          changed = true
          return { ...t, resuming: undefined }
        }
        if (
          isSessionKind(t.kind) &&
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
      if (!changed) return { sessions }
      if (!activeReverted) return { sessions, tabs }
      const openFiles = { ...s.openFiles }
      if (s.activeTabId) delete openFiles[s.activeTabId]
      return { sessions, tabs, openFiles }
    })
    bindParkedWorkbench()
  },
  setLeftovers: (leftovers) => set({ leftovers }),
  setSettings: (settings) => set({ settings }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setWelcomeActive: (welcomeActive) => set({ welcomeActive }),
  beginLogin: (reauthName) => set({ accountLogin: { reauthName, progress: null } }),
  setLoginProgress: (progress) =>
    set((s) => ({ accountLogin: { ...(s.accountLogin ?? {}), progress } })),
  clearLogin: () => set({ accountLogin: null }),
  setOpenFile: (f) => {
    const s = get()
    const id = s.activeTabId
    if (!id) return
    if (f && f.source !== 'intercept') {
      get().updateWorkbenchTabs(id, (prev) => activateWbTab(prev, FILES_TAB_ID))
      if (!s.workbenchOpen[id]) get().setWorkbenchOpen(id, true)
      set((st) => ({ filesReveal: { tabId: id, nonce: (st.filesReveal?.nonce ?? 0) + 1 } }))
    }
    set((st) => ({ openFiles: { ...st.openFiles, [id]: f } }))
  },
  setWorkbenchWidth: (workbenchWidth) => set({ workbenchWidth }),
  setTabWorkbenchWidth: (tabId, w) =>
    set((s) => ({ workbenchWidth: w, workbenchWidths: { ...s.workbenchWidths, [tabId]: w } })),
  setSidebarWidth: (sidebarWidth) => set({ sidebarWidth }),
  setNotesHeight: (notesHeight) => set({ notesHeight }),
  setWorkspaceRows: (workspaceRows) =>
    set((s) => ({
      workspaceRows,
      selectedWs: workspaceRows.some((w) => w.workspace.path === s.selectedWs) ? s.selectedWs : null
    })),
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

  ensureWorkbench: (tabId) => {
    if (!workbenchAllowed(get(), tabId)) return Promise.resolve()
    if (get().workbenchFetched[tabId]) return Promise.resolve()
    const inflight = workbenchFetches.get(tabId)
    if (inflight) return inflight
    const sid = boundSessionId(get(), tabId)
    if (!sid) return Promise.resolve()
    const p = window.api.workbench
      .get(sid)
      .then((st) => {
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
      const r = openTab(base, { kind: 'web', ...opts, openedByAgent: opts.fromShim })
      set((st) => ({ workbench: { ...st.workbench, [tabId]: r.set } }))
      persistWorkbench(tabId)
      if (r.evicted) s.showToast(tabEvictedNotice(tabLabel(r.set, r.evicted)))
      if (opts.source !== 'user') {
        if (opts.fromShim)
          set((st) => ({
            agentOpen: {
              ownerTabId: tabId,
              tabId: r.tabId,
              nonce: (st.agentOpen?.nonce ?? 0) + 1
            }
          }))
        return
      }
      if (!s.workbenchOpen[tabId]) get().setWorkbenchOpen(tabId, true)
      set((st) => ({
        workbenchLoad: {
          ownerTabId: tabId,
          tabId: r.tabId,
          nonce: (st.workbenchLoad?.nonce ?? 0) + 1
        }
      }))
    }),
  setWorkbenchFull: (workbenchFull) => {
    if (workbenchFull && !workbenchAllowed(get(), get().activeTabId)) return
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
    return r.tabId
  },
  setLastWsPath: (lastWsPath) => set({ lastWsPath }),
  selectWorkspace: (path) =>
    set({ selectedWs: path, activeTabId: null, lastWsPath: path, resumeLaunch: null }),

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
          if (!s.update.open) return {}
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
          s.update.open ? { update: { ...s.update, phase: 'error', error: ipcErrMessage(e) } } : {}
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
        set((s) => ({ update: { ...s.update, phase: 'error', error: ipcErrMessage(e) } }))
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
  useStore((s) => (s.activeTabId ? (s.openFiles[s.activeTabId] ?? null) : null))

export function consumeRestartExit(ptyId: string): boolean {
  return restartedPtys.delete(ptyId)
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

export function openInterceptedFile(
  ptyId: string,
  src: string,
  source: 'agent' | 'user' = 'agent'
): void {
  const { tabs, activeTabId, activateTab } = useStore.getState()
  const tabId = conversationTabFor(ptyId)
  if (tabs.some((t) => t.id === tabId) && activeTabId !== tabId) activateTab(tabId)
  if (!useStore.getState().activeTabId) {
    window.api.preview.osOpen(src)
    return
  }
  useStore.getState().setOpenFile({
    src,
    label: basename(src),
    source: source === 'agent' ? 'intercept' : undefined
  })
}

export function previewLinkTarget(href: string, fromSrc: string): string {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href)) return href
  const base = fromSrc.slice(0, fromSrc.lastIndexOf('/'))
  const out: string[] = []
  for (const seg of `${base}/${href.split(/[?#]/)[0]}`.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') out.pop()
    else out.push(seg)
  }
  return '/' + out.join('/')
}

export function openWebPage(src: string, sourceTabId?: string, sourcePath?: string): void {
  const st = useStore.getState()
  const selected = st.tabs.find((t) => t.id === st.activeTabId)
  if (selected && isSessionKind(selected.kind) && !hasWorkbench(selected)) {
    if (canOpenExternally(src)) window.api.browser.openExternal(src)
    return
  }
  const decision = routeFor(src, 'user')
  if (decision.dest !== 'browser') return
  const tabId = hasWorkbench(selected) ? selected?.id : undefined
  if (!tabId) {
    st.landOverlay(decision.target, 'now')
    return
  }
  st.openWorkbenchTarget(tabId, { url: decision.target, source: 'user', sourceTabId, sourcePath })
}

useStore.subscribe((state, prev) => {
  if (state.activeTabId === prev.activeTabId) return
  if (state.workbenchFull) useStore.setState({ workbenchFull: false })
})

useStore.subscribe((state) => {
  if ((state.activeTabId || state.resumeLaunch) && state.selectedWs)
    useStore.setState({ selectedWs: null })
})
