import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type JSX
} from 'react'
import {
  LuAlignLeft,
  LuDownload,
  LuEllipsis,
  LuFileText,
  LuGitPullRequest,
  LuGithub,
  LuGlobe,
  LuLink,
  LuListTree,
  LuMaximize2,
  LuMinimize2,
  LuPencil,
  LuPlus,
  LuRotateCw,
  LuTerminal,
  LuVolume2,
  LuVolumeX,
  LuX
} from 'react-icons/lu'
import { routeFor } from '@shared/browserRoute'
import {
  CDP_GUEST_ID_RETRIES,
  CDP_GUEST_ID_RETRY_MS,
  CDP_MOUNT_ATTACH_MS,
  CDP_MOUNT_SETTLE_MS
} from '@shared/cdpBudget'
import { isWebPagePath } from '@shared/preview'
import type {
  ArtifactView,
  BrowserCdpOp,
  BrowserCdpOpResult,
  BrowserPermissionAsk,
  BrowserPermissionRefusal,
  EditFingerprint,
  GitFileStatus,
  GitNumstatMap,
  GitStatusMap,
  GithubInfo,
  GithubTarget,
  SessionInfo
} from '@shared/types'
import { BrowserActions } from './BrowserActions'
import { BrowserAddressBar } from './BrowserAddressBar'
import { BrowserGuest, type GuestElement, type GuestFailure } from './BrowserGuest'
import { stopEndsMount } from './browserMount'
import { BrowserModal, type BrowserDialog, type BrowserDialogAnswer } from './BrowserModal'
import { BrowserDownloads } from './BrowserDownloads'
import { BrowserPermissionBar } from './BrowserPermissionBar'
import {
  applyDownloadEvent,
  clearFinishedDownloads,
  hasDownloads,
  type DownloadList
} from './downloadList'
import { FindBar } from './FindBar'
import { NO_FOCUS_SIGNAL, TerminalView } from './TerminalView'
import { FilesBar, FilesBody, useFilesController } from './FilesView'
import { GIT_LETTER, relOf, splitPath } from './filesModel'
import { ArtifactPane, NO_CAPS, sameCaps, type ArtifactCaps } from './ArtifactPane'
import { EditPane, editRefusal, useEditProbe } from './EditPane'
import {
  allEditTabs,
  beginEdit,
  discardTab,
  endEdit,
  getEntry,
  isTabDirty,
  saveTab,
  setEditingActive,
  subscribeDirty
} from '../editRegistry'
import { loadHistory, remember, saveHistory } from '../browserHistory'
import { boundSessionId, useStore } from '../store'
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
  setTabView,
  shortAuxCwd,
  tabLabel,
  type OpenTabResult,
  type WorkbenchTab,
  type WorkbenchTabSet
} from './workbenchTabs'
import type { WorkbenchCommandSignal } from './workbenchCommands'
import { useDomFind, type FindCount } from '../useDomFind'

function globalLiveGuestLimit(): number {
  return window.api.browserGuestLimit
}

interface TabRuntime {
  loading: boolean
  canBack: boolean
  canForward: boolean
  fail: GuestFailure | null
  crashed: boolean
  zoom: number
  mountToken: number
  pendingUrl: string
}

const BLANK_RUNTIME: TabRuntime = {
  loading: false,
  canBack: false,
  canForward: false,
  fail: null,
  crashed: false,
  zoom: 1,
  mountToken: 0,
  pendingUrl: ''
}

const ZOOM_STEPS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2]

const CAPTURE_AFTER_PAINT_MS = 90
const PERMISSION_REFUSAL_NOTICE_MS = 4000
const WATCHLESS_REFRESH_THROTTLE_MS = 600

const GUEST_ID_RETRY_MS = CDP_GUEST_ID_RETRY_MS
const GUEST_ID_RETRIES = CDP_GUEST_ID_RETRIES

const PREARMED_COMMANDS: ReadonlySet<WorkbenchCommandSignal['id']> = new Set([
  'find-files',
  'browser-new-tab'
])

const VIEW_LABEL: Record<ArtifactView, string> = {
  render: 'Rendered',
  diff: 'Diff',
  source: 'Source'
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

// PLATFORM§8
function history(el: GuestElement | undefined): { canBack: boolean; canForward: boolean } {
  try {
    return { canBack: el?.canGoBack() ?? false, canForward: el?.canGoForward() ?? false }
  } catch {
    return { canBack: false, canForward: false }
  }
}

// PLATFORM§8
function guestId(el: GuestElement | undefined): number {
  try {
    return el?.getWebContentsId() ?? 0
  } catch {
    return 0
  }
}

// PLATFORM§8
function guestUrl(el: GuestElement | undefined): string {
  try {
    return el?.getURL() ?? ''
  } catch {
    return ''
  }
}

function isCertFailure(fail: GuestFailure): boolean {
  return /^ERR_(CERT|SSL)/.test(fail.description)
}

function sameMap<V>(
  a: Record<string, V>,
  b: Record<string, V>,
  eq: (x: V, y: V) => boolean
): boolean {
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  for (const k of keys) {
    if (!(k in b) || !eq(a[k], b[k])) return false
  }
  return true
}

export interface WorkbenchPaneProps {
  tabId: string | null
  states: Record<string, WorkbenchTabSet>
  liveTabs: ReadonlySet<string>
  visible: boolean
  full: boolean
  load: { tabId: string; nonce: number } | null
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
  treeRoot: string | null
  session: SessionInfo | null
  activeTabId: string | null
  pinned: Record<string, string[]>
  tabForSession: (sessionId: string) => string | undefined
  cdpOps: BrowserCdpOp[]
  onCdpDone: (opId: string) => void
  onCdpCreate: (sessionId: string, url: string) => Promise<string | null>
}

function pressOnTabControl(e: { stopPropagation(): void; preventDefault(): void }): void {
  e.stopPropagation()
  e.preventDefault()
}

function sameGithub(a: GithubInfo | null, b: GithubInfo | null): boolean {
  if (!a || !b) return a === b
  return (
    a.repoUrl === b.repoUrl &&
    a.pullsUrl === b.pullsUrl &&
    a.branch === b.branch &&
    a.pr === b.pr &&
    a.pending === b.pending &&
    a.failed === b.failed
  )
}

function useGithubInfo(root: string | null): {
  info: GithubInfo | null
  recheck: () => void
} {
  const [got, setGot] = useState<{ root: string; info: GithubInfo | null } | null>(null)
  const [nonce, setNonce] = useState(0)
  const forcedRecheckRoot = useRef<string | null>(null)
  useEffect(() => {
    if (!root) return undefined
    let alive = true
    const force = forcedRecheckRoot.current === root
    if (force) forcedRecheckRoot.current = null
    const settle = (info: GithubInfo | null): void => {
      setGot((prev) =>
        prev && prev.root === root && sameGithub(prev.info, info) ? prev : { root, info }
      )
      if (!force || !info || info.pending) return
      const st = useStore.getState()
      if (info.failed) st.showToast('Could not reach GitHub.')
      else if (info.pr === null) {
        st.showToast(`No pull request found for ${info.branch ?? 'this checkout'}.`)
      }
    }
    void window.api.github.info(root, force).then((info) => {
      if (alive) settle(info)
    })
    const off = window.api.github.onInfo((r, info) => {
      if (alive && r === root) settle(info)
    })
    return () => {
      alive = false
      off()
    }
  }, [root, nonce])
  const recheck = useCallback((): void => {
    if (!root) return
    forcedRecheckRoot.current = root
    setNonce((n) => n + 1)
  }, [root])
  return { info: got && got.root === root ? got.info : null, recheck }
}

export function WorkbenchPane({
  tabId: ownerTab,
  states,
  liveTabs,
  visible,
  full,
  load,
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
  treeRoot,
  session,
  activeTabId,
  pinned,
  tabForSession,
  cdpOps,
  onCdpDone,
  onCdpCreate
}: WorkbenchPaneProps): JSX.Element {
  const termFocus = useStore((s) => s.termFocus)
  const [live, setLive] = useState<string[]>([])
  const [runtime, setRuntime] = useState<Record<string, TabRuntime>>({})
  const [attached, setAttached] = useState(0)
  const [findOpen, setFindOpen] = useState(false)
  const [findFocusTick, setFindFocusTick] = useState(0)
  const [query, setQuery] = useState('')
  const [guestFindCount, setGuestFindCount] = useState<FindCount>({ current: 0, total: 0 })
  const [downloads, setDownloads] = useState<DownloadList>({ items: [] })
  const [dlOpen, setDlOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [newMenuOpen, setNewMenuOpen] = useState(false)
  const [ghMenu, setGhMenu] = useState(false)
  const github = useGithubInfo(visible ? treeRoot : null)
  const [permAsk, setPermAsk] = useState<BrowserPermissionAsk | null>(null)
  const [permRefusal, setPermRefusal] = useState<BrowserPermissionRefusal | null>(null)
  const [audio, setAudio] = useState<Record<string, { audible: boolean; muted: boolean }>>({})
  const [drag, setDrag] = useState<{ id: string; over: number } | null>(null)
  const [pageFullscreen, setPageFullscreen] = useState(false)
  const [zoom, setZoom] = useState<string | null>(null)
  const [caps, setCaps] = useState<Record<string, ArtifactCaps>>({})
  const [outlineOpen, setOutlineOpen] = useState<Record<string, boolean>>({})
  const [reloadNonce, setReloadNonce] = useState<Record<string, number>>({})
  const [editing, setEditing] = useState<Record<string, boolean>>({})
  const [editFocus, setEditFocus] = useState<Record<string, number>>({})
  const [, bumpEdit] = useReducer((n: number) => n + 1, 0)
  useEffect(() => subscribeDirty(bumpEdit), [])
  const [git, setGit] = useState<GitStatusMap>({})
  const [numstat, setNumstat] = useState<GitNumstatMap>({})
  const [base, setBase] = useState<string | null | undefined>(undefined)
  const [rootMissing, setRootMissing] = useState(false)
  const [watchDead, setWatchDead] = useState(false)

  const files = useFilesController(ownerTab, treeRoot)
  const refreshFiles = files.refresh

  const addressRef = useRef<HTMLInputElement>(null)
  const findInputRef = useRef<HTMLInputElement>(null)
  const els = useRef(new Map<string, GuestElement>())
  const bodies = useRef(new Map<string, HTMLElement>())
  // PLATFORM§9
  const mountOrder = useRef<string[]>([])
  const everLive = useRef(new Set<string>())
  const [visited, setVisited] = useState<string[]>([])

  const statesRef = useRef(states)
  statesRef.current = states
  const set = (ownerTab && states[ownerTab]) || emptyTabSet()
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
    everLive.current.add(id)
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
      const restore = id === set.activeId ? () => {} : keepCaret()
      onUpdate(ownerTab, (prev) => activateTab(prev, id))
      restore()
      const tab = set.tabs.find((t) => t.id === id)
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
    [ownerTab, sessionCold, set, onUpdate, applyLive, makeLive, keepCaret]
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

  const pendingMounts = useRef(new Map<string, () => void>())
  const pendingSettles = useRef(new Map<string, () => void>())
  const doneOps = useRef(new Set<string>())

  // PLATFORM§8
  const waitGuestId = useCallback(
    async (tabId: string): Promise<number> => {
      for (let i = 0; i < GUEST_ID_RETRIES; i++) {
        const id = guestIdOf(tabId)
        if (id) return id
        await new Promise((r) => setTimeout(r, GUEST_ID_RETRY_MS))
      }
      throw new Error('the page never reported its id')
    },
    [guestIdOf]
  )

  const inFlightMounts = useRef(new Map<string, Promise<number>>())

  const settled = useCallback((tabId: string): Promise<void> => {
    return new Promise<void>((resolve) => {
      const done = (): void => {
        pendingSettles.current.delete(tabId)
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(done, CDP_MOUNT_SETTLE_MS)
      pendingSettles.current.set(tabId, done)
    })
  }, [])

  const guestLoading = useCallback((tabId: string): boolean => {
    try {
      return els.current.get(tabId)?.isLoading() ?? false
    } catch {
      return false
    }
  }, [])

  const doMount = useCallback(
    async (opOwner: string, tabId: string, urlHint?: string): Promise<number> => {
      const url = urlHint ?? webIndexRef.current.get(tabId)?.tab.url
      if (url === undefined) throw new Error(`no tab ${tabId}`)
      // PLATFORM§9
      stage(tabId)
      const fresh = !els.current.has(tabId)
      if (fresh) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            pendingMounts.current.delete(tabId)
            reject(new Error('the page did not open'))
          }, CDP_MOUNT_ATTACH_MS)
          pendingMounts.current.set(tabId, () => {
            clearTimeout(timer)
            resolve()
          })
          applyLiveIn(opOwner, tabId, url || 'about:blank')
        })
      } else {
        makeLive(tabId)
      }
      // PLATFORM§8
      if (fresh || guestLoading(tabId)) await settled(tabId)
      return await waitGuestId(tabId)
    },
    [applyLiveIn, makeLive, settled, waitGuestId, guestLoading, stage]
  )

  const mountTab = useCallback(
    (opOwner: string, tabId: string, urlHint?: string): Promise<number> => {
      const already = inFlightMounts.current.get(tabId)
      if (already) return already
      const p = doMount(opOwner, tabId, urlHint)
        .catch((e: unknown) => {
          if (!pinnedRef.current.has(tabId)) unstage(tabId)
          throw e
        })
        .finally(() => inFlightMounts.current.delete(tabId))
      inFlightMounts.current.set(tabId, p)
      return p
    },
    [doMount, unstage]
  )

  const bindings = useStore((s) =>
    s.tabs.map((t) => `${t.id}=${boundSessionId(s, t.id) ?? ''}`).join(' ')
  )
  const lastReport = useRef(new Map<string, string>())
  useEffect(() => {
    const st = useStore.getState()
    for (const [owner, s] of Object.entries(states)) {
      const sid = boundSessionId(st, owner)
      if (!sid) continue
      const targets = s.tabs
        .filter((t) => t.kind === 'web')
        .map((t) => ({
          targetId: t.id,
          url: t.url ?? '',
          title: t.title,
          guestId: guestIdOf(t.id) || null
        }))
      const json = JSON.stringify(targets)
      if (lastReport.current.get(sid) === json) continue
      lastReport.current.set(sid, json)
      window.api.browser.reportStrip(sid, targets)
    }
  }, [states, live, attached, guestIdOf, bindings])

  const close = useCallback(
    (id: string): void => {
      if (!ownerTab || id === FILES_TAB_ID) return
      if (set.tabs.find((t) => t.id === id)?.kind === 'terminal') {
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
    [ownerTab, set, treeRoot, closeNow, activate, refreshFiles]
  )

  useEffect(() => {
    if (!cdpOps.length) return
    for (const id of [...doneOps.current]) {
      if (!cdpOps.some((o) => o.opId === id)) doneOps.current.delete(id)
    }
    for (const op of cdpOps) {
      if (doneOps.current.has(op.opId)) continue
      doneOps.current.add(op.opId)
      const finish = (res: Omit<BrowserCdpOpResult, 'opId'>): void => {
        window.api.browser.answerCdpOp({ opId: op.opId, ...res })
        onCdpDone(op.opId)
      }
      const fail = (e: unknown): void =>
        finish({ ok: false, error: e instanceof Error ? e.message : String(e) })

      const opOwner = tabForSession(op.sessionId)
      if (!opOwner) {
        fail(new Error(`no session ${op.sessionId}`))
        continue
      }

      if (op.kind === 'mount' && op.targetId) {
        mountTab(opOwner, op.targetId).then(
          (gid) => finish({ ok: true, targetId: op.targetId, guestId: gid }),
          fail
        )
      } else if (op.kind === 'create') {
        const url = op.url || 'about:blank'
        void onCdpCreate(op.sessionId, url).then((tabId) => {
          if (!tabId) {
            finish({ ok: false, error: 'the tab limit is full of pages an agent is driving' })
            return
          }
          mountTab(opOwner, tabId, url).then(
            (gid) => finish({ ok: true, targetId: tabId, guestId: gid }),
            fail
          )
        }, fail)
      } else if (op.kind === 'close' && op.targetId) {
        const id = op.targetId
        if (opOwner === ownerTab) close(id)
        else onUpdate(opOwner, (prev) => closeTab(prev, id))
        setLive((prev) => prev.filter((x) => x !== id))
        finish({ ok: true })
      } else if (op.kind === 'stage' && op.targetId) {
        stage(op.targetId)
        requestAnimationFrame(() => setTimeout(() => finish({ ok: true }), CAPTURE_AFTER_PAINT_MS))
      } else {
        finish({ ok: false, error: `unknown op ${op.kind}` })
      }
    }
  }, [cdpOps, mountTab, onCdpCreate, onCdpDone, close, onUpdate, ownerTab, tabForSession, stage])

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
      const decision = routeFor(raw, 'address')
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

  const activeId = activeTab?.id
  const getFindRoot = useCallback(
    (): HTMLElement | null => (activeId ? (bodies.current.get(activeId) ?? null) : null),
    [activeId]
  )
  const dom = useDomFind(getFindRoot)
  const domClear = dom.clear

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
    setQuery('')
    setGuestFindCount({ current: 0, total: 0 })
    domClear()
    for (const el of els.current.values()) {
      try {
        el.stopFindInPage('clearSelection')
      } catch {}
    }
  }, [domClear])

  const searchGuest = useCallback(
    (q: string, options?: { forward?: boolean; findNext?: boolean }): void => {
      const el = guestOf(activeTab?.id)
      if (!el) return
      try {
        if (!q) {
          el.stopFindInPage('clearSelection')
          setGuestFindCount({ current: 0, total: 0 })
          return
        }
        el.findInPage(q, options ?? { findNext: true })
      } catch {}
    },
    [activeTab?.id]
  )

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

  const lastLoad = useRef(0)
  useEffect(() => {
    if (!load || load.nonce === lastLoad.current) return
    lastLoad.current = load.nonce
    activate(load.tabId)
  }, [load, activate])

  useEffect(() => {
    return window.api.browser.onDownloadEvent((event) => {
      setDownloads((prev) => applyDownloadEvent(prev, event))
    })
  }, [])

  const permQueue = useRef<BrowserPermissionAsk[]>([])
  useEffect(() => {
    const offAsk = window.api.browser.onPermissionAsk((ask) => {
      setPermAsk((current) => {
        if (current) {
          permQueue.current.push(ask)
          return current
        }
        return ask
      })
    })
    const offRefused = window.api.browser.onPermissionRefused((r) => setPermRefusal(r))
    const offDrop = window.api.browser.onPermissionDrop((id) => {
      permQueue.current = permQueue.current.filter((a) => a.id !== id)
      setPermAsk((current) => (current?.id === id ? (permQueue.current.shift() ?? null) : current))
    })
    return () => {
      offAsk()
      offRefused()
      offDrop()
    }
  }, [])

  const cancelPrompts = useCallback((): void => {
    const releaseWaitingPage = (askId: string): void => window.api.browser.cancelPermission(askId)
    setPermAsk((current) => {
      if (current) releaseWaitingPage(current.id)
      for (const queued of permQueue.current) releaseWaitingPage(queued.id)
      permQueue.current = []
      return null
    })
    setPermRefusal(null)
    setDlOpen(false)
    setMenuOpen(false)
    setNewMenuOpen(false)
    setGhMenu(false)
  }, [])

  useEffect(() => {
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
    if (!permRefusal) return
    const timer = setTimeout(() => setPermRefusal(null), PERMISSION_REFUSAL_NOTICE_MS)
    return () => clearTimeout(timer)
  }, [permRefusal])

  const answerPermission = useCallback((id: string, granted: boolean) => {
    window.api.browser.answerPermission(id, granted)
    setPermAsk(permQueue.current.shift() ?? null)
  }, [])

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

  const dropTab = useCallback(
    (to: number) => {
      const id = drag?.id
      setDrag(null)
      if (!id || !ownerTab) return
      onUpdate(ownerTab, (prev) => {
        const from = prev.tabs.findIndex((t) => t.id === id)
        const target = from >= 0 && from < to ? to - 1 : to
        return moveTab(prev, id, target)
      })
    },
    [drag, ownerTab, onUpdate]
  )

  useEffect(() => {
    mountOrder.current = mountOrder.current.filter(
      (id) => webIndex.has(id) || inFlightMounts.current.has(id)
    )
  }, [webIndex])

  useEffect(() => {
    setLive((prev) => {
      const next = prev.filter((id) => {
        const owner = webIndexRef.current.get(id)?.owner
        if (!owner || !liveTabs.has(owner)) {
          return inFlightMounts.current.has(id)
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
      if (report() || ++tries >= GUEST_ID_RETRIES) clearInterval(timer)
    }, GUEST_ID_RETRY_MS)
    return () => clearInterval(timer)
  }, [ownerTab, activeTab?.id, activeTab?.url, live, attached, openDedupedIntoShownTabNonce])

  useLayoutEffect(() => {
    if (!findFocusTick) return
    findInputRef.current?.focus()
    findInputRef.current?.select()
  }, [findFocusTick])

  useEffect(() => {
    closeFind()
  }, [activeTab?.id, ownerTab])

  useEffect(() => {
    const el = guestOf(activeTab?.id)
    if (!findOpen || !el) return
    const onFound = (e: Event): void => {
      const r = (e as Event & { result?: { activeMatchOrdinal: number; matches: number } }).result
      if (r) setGuestFindCount({ current: r.activeMatchOrdinal, total: r.matches })
    }
    el.addEventListener('found-in-page', onFound)
    return () => el.removeEventListener('found-in-page', onFound)
  }, [findOpen, activeTab?.id, live])

  const baseChoice = files.baseChoice
  const refreshNonce = files.refreshNonce
  useEffect(() => {
    setGit({})
    setNumstat({})
    setBase(undefined)
    setRootMissing(false)
    setWatchDead(false)
  }, [treeRoot])

  useEffect(() => {
    if (visible) return
    setGit({})
    setNumstat({})
    setBase(undefined)
  }, [visible])

  useEffect(() => {
    if (!visible || !treeRoot) return
    const root = treeRoot
    let seq = 0
    const fetchGit = (): void => {
      const mine = ++seq
      const resolve: Promise<string | null> =
        baseChoice === 'head' ? Promise.resolve('HEAD') : window.api.fs.diffBase(root)
      resolve
        .catch(() => null)
        .then((b) => {
          if (mine !== seq) return undefined
          setBase(b)
          const arg = b ?? undefined
          return Promise.all([
            window.api.fs.gitStatus(root, arg),
            window.api.fs.gitNumstat(root, arg),
            window.api.fs.dirExists(root).then((ok) => !ok)
          ])
        })
        .then((r) => {
          if (!r || mine !== seq) return
          const [g, ns, missing] = r
          setGit((prev) => (sameMap(prev, g, (x, y) => x === y) ? prev : g))
          setNumstat((prev) =>
            sameMap(prev, ns, (x, y) => x.added === y.added && x.removed === y.removed) ? prev : ns
          )
          setRootMissing(missing)
        })
        .catch(() => {
          if (mine !== seq) return
        })
    }
    fetchGit()
    let watching = true
    window.api.fs.watchDir(root).then((live) => {
      if (watching) setWatchDead(!live)
    })
    const off = window.api.fs.onDirChange((changed) => {
      if (changed === root) fetchGit()
    })
    return () => {
      seq++
      watching = false
      off()
      window.api.fs.unwatchDir(root)
    }
  }, [visible, treeRoot, baseChoice, refreshNonce])

  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const refresh = files.refresh
  useEffect(() => {
    if (!watchDead || !visible || refreshTimer.current) return
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null
      refresh()
    }, WATCHLESS_REFRESH_THROTTLE_MS)
  }, [watchDead, visible, session?.updatedAt, refresh])
  useEffect(
    () => () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current)
      refreshTimer.current = null
    },
    [watchDead, visible, treeRoot]
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
  const closeZoom = useCallback((): void => setZoom(null), [])
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
      if (r.openedNew) setVisited((prev) => (prev.includes(r.tabId) ? prev : [...prev, r.tabId]))
    },
    [ownerTab, onUpdate]
  )

  const recordVisit = (tab: WorkbenchTab, url: string, title?: string): void => {
    if (!pinnedRef.current.has(tab.id)) saveHistory(remember(loadHistory(), url, title))
  }

  const guestHandlers = (owner: string, tab: WorkbenchTab) => ({
    onElement: (el: GuestElement | null): void => {
      if (el) {
        els.current.set(tab.id, el)
        return
      }
      els.current.delete(tab.id)
      setAudio((prev) => {
        if (!(tab.id in prev)) return prev
        const rest = { ...prev }
        delete rest[tab.id]
        return rest
      })
    },
    onAttached: (): void => {
      setAttached((n) => n + 1)
      const waiting = pendingMounts.current.get(tab.id)
      if (waiting) {
        pendingMounts.current.delete(tab.id)
        waiting()
      }
    },
    onLoading: (loading: boolean): void => {
      patchRuntime(tab.id, { loading, ...history(guestOf(tab.id)) })
      if (loading) return
      let evidence = { guestUrl: '', targetUrl: '', isLoading: false }
      try {
        const el = guestOf(tab.id)
        evidence = {
          guestUrl: el?.getURL() ?? '',
          targetUrl: runtime[tab.id]?.pendingUrl || tab.url || '',
          isLoading: el?.isLoading() ?? false
        }
      } catch {
        return
      }
      if (stopEndsMount(evidence)) pendingSettles.current.get(tab.id)?.()
    },
    onNavigate: (url: string): void => {
      patchRuntime(tab.id, {
        pendingUrl: '',
        fail: null,
        crashed: false,
        ...history(guestOf(tab.id))
      })
      onUpdate(owner, (prev) => navigateTab(prev, tab.id, url))
      recordVisit(tab, url)
    },
    onTitle: (title: string): void => {
      onUpdate(owner, (prev) => retitleTab(prev, tab.id, title))
      const url = guestUrl(guestOf(tab.id))
      if (url) recordVisit(tab, url, title)
    },
    onFail: (fail: GuestFailure): void => {
      patchRuntime(tab.id, { fail, loading: false })
      pendingSettles.current.get(tab.id)?.()
    },
    onCrash: (): void => patchRuntime(tab.id, { crashed: true, loading: false }),
    onClose: (): void => {
      if (owner === ownerTab) close(tab.id)
      else onUpdate(owner, (prev) => closeTab(prev, tab.id))
    }
  })

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
  const backlink =
    activeTab?.sourceTabId && set.tabs.some((t) => t.id === activeTab.sourceTabId)
      ? activeTab.sourceTabId
      : null

  const iconFor = (t: WorkbenchTab): JSX.Element =>
    t.kind === 'files' ? (
      <LuListTree size={13} />
    ) : t.kind === 'terminal' ? (
      <LuTerminal size={12} />
    ) : t.kind === 'web' ? (
      <LuGlobe size={12} />
    ) : (
      <LuFileText size={12} />
    )

  const fail = activeRuntime.fail
  const webOverlay =
    activeKind !== 'web' ? null : sessionCold ? (
      <div className="bempty">
        <div className="bstate-t">Session ended</div>
        <div className="bstate-sub">{activeTab?.url ? hostOf(activeTab.url) : ''}</div>
        <button onClick={() => activeTab && activate(activeTab.id)}>Reload</button>
      </div>
    ) : activeRuntime.crashed && activeTab ? (
      <div className="bcrash">
        <div className="bstate-t">This page crashed</div>
        <div className="bstate-sub">{hostOf(activeTab.url ?? '')}</div>
        <button
          onClick={() =>
            patchRuntime(activeTab.id, {
              crashed: false,
              pendingUrl: activeTab.url ?? '',
              mountToken: (runtime[activeTab.id]?.mountToken ?? 0) + 1
            })
          }
        >
          Reload
        </button>
      </div>
    ) : fail && isCertFailure(fail) && activeTab ? (
      <div className="bcert">
        <div className="bstate-t">Your connection is not private</div>
        <div className="bstate-sub">
          {hostOf(fail.url)} · {fail.description}
        </div>
        <button
          onClick={() => {
            void Promise.resolve(onCertProceed(fail.url)).then(() => {
              patchRuntime(activeTab.id, { fail: null })
              applyLive(activeTab.id, fail.url)
            })
          }}
        >
          Proceed anyway (unsafe)
        </button>
      </div>
    ) : fail && activeTab ? (
      <div className="berror">
        <div className="bstate-t">Can't reach {hostOf(fail.url)}</div>
        <div className="bstate-sub">{fail.description}</div>
        <button onClick={() => applyLive(activeTab.id, fail.url)}>Retry</button>
      </div>
    ) : activeTab && !activeTab.url ? (
      <div className="bempty">
        <div className="bstate-t">No page open yet</div>
        <div className="bempty-hint">Press ⌘L and enter an address (http(s) / file://)</div>
        <div className="bempty-hint">Click a link in the terminal</div>
        <div className="bempty-hint">Or let Claude open one</div>
      </div>
    ) : activeTab && !live.includes(activeTab.id) ? (
      <div className="bempty">
        <div className="bstate-t">Not loaded</div>
        <div className="bstate-sub">{hostOf(activeTab.url ?? '')}</div>
        <button onClick={() => activate(activeTab.id)}>Load</button>
      </div>
    ) : null

  const renderTab = (t: WorkbenchTab, i: number): JSX.Element => (
    <span
      key={t.id}
      className={
        'wb-tab' +
        (t.kind === 'files' ? ' pinned' : '') +
        (t.id === set.activeId ? ' on' : '') +
        (t.unread ? ' agent' : '') +
        (t.kind === 'web' && pinnedIds.has(t.id) ? ' driven' : '') +
        (t.kind === 'web' && !live.includes(t.id) && everLive.current.has(t.id) ? ' frozen' : '') +
        (drag?.id === t.id ? ' dragging' : '') +
        (drag && drag.over === i && drag.id !== t.id ? ' dropbefore' : '')
      }
      title={t.url || t.path || undefined}
      data-wb-tab-id={t.id}
      onMouseDown={() => activate(t.id)}
      draggable={t.kind !== 'files' && t.kind !== 'terminal'}
      onDragStart={(e) => {
        if (t.kind === 'files' || t.kind === 'terminal') return
        e.dataTransfer.effectAllowed = 'move'
        // PLATFORM§10
        e.dataTransfer.setData('text/plain', t.id)
        setDrag({ id: t.id, over: i })
      }}
      onDragOver={(e) => {
        if (!drag) return
        e.preventDefault()
        if (drag.over !== i) setDrag({ ...drag, over: i })
      }}
      onDrop={(e) => {
        e.preventDefault()
        dropTab(i)
      }}
      data-drop-index={i}
      onDragEnd={() => setDrag(null)}
    >
      <span className="ic">{iconFor(t)}</span>
      <span className="lb">{tabLabel(set, t)}</span>
      {t.kind === 'files' && changedCount > 0 && <span className="cnt">{changedCount}</span>}
      {(audio[t.id]?.audible || audio[t.id]?.muted) && (
        <span
          className={'btab-spk' + (audio[t.id]?.muted ? ' muted' : '')}
          title={audio[t.id]?.muted ? 'Unmute tab' : 'Mute tab'}
          aria-label={audio[t.id]?.muted ? 'Unmute tab' : 'Mute tab'}
          onMouseDown={pressOnTabControl}
          onClick={() => toggleMute(t.id)}
        >
          {audio[t.id]?.muted ? <LuVolumeX size={13} /> : <LuVolume2 size={13} />}
        </span>
      )}
      {t.kind !== 'files' && (
        <span
          className="x"
          title="Close tab"
          aria-label="Close tab"
          onMouseDown={pressOnTabControl}
          onClick={() => close(t.id)}
        >
          {ownerTab && isTabDirty(ownerTab, t.id) ? (
            <>
              <span className="dirty" title="Unsaved changes" />
              <span className="xhov">
                <LuX size={12} />
              </span>
            </>
          ) : (
            <LuX size={12} />
          )}
        </span>
      )}
    </span>
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

  // ADR-0017
  useEffect(() => {
    useStore.getState().setGithubBtn(visible && !!github.info)
  }, [visible, github.info])

  const ghInfo = github.info
  const ghLabel = ghInfo?.pr
    ? `Open pull request #${ghInfo.pr} · right-click for more`
    : 'Open this repository on GitHub · right-click for more'
  const ghButton = ghInfo ? (
    <button
      className={'wb-gh' + (ghInfo.pr ? ' has' : '') + (ghInfo.pending ? ' pending' : '')}
      aria-label={ghLabel}
      title={ghLabel}
      onClick={() => {
        setNewMenuOpen(false)
        setGhMenu(false)
        openGithub(ghInfo.pr ? 'pr' : 'repo')
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        setNewMenuOpen(false)
        setDlOpen(false)
        setGhMenu(true)
      }}
    >
      <LuGithub size={13} />
      {ghInfo.pr !== null && <span className="n">{`#${ghInfo.pr}`}</span>}
    </button>
  ) : null

  const fullBtn = (
    <button
      className="icobtn"
      aria-label={full ? 'Restore ⌘⏎' : 'Full width ⌘⏎'}
      aria-pressed={full}
      title={full ? 'Restore ⌘⏎' : 'Full width ⌘⏎'}
      onClick={onToggleFull}
    >
      {full ? <LuMinimize2 size={14} /> : <LuMaximize2 size={14} />}
    </button>
  )

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
      <div
        className="wb-tabs"
        onWheel={(e) => {
          const strip = e.currentTarget
          if (strip.scrollWidth <= strip.clientWidth) return
          if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return
          e.preventDefault()
          strip.scrollLeft += e.deltaY
        }}
      >
        <div className="wb-pin">
          {set.tabs[0] && renderTab(set.tabs[0], 0)}
          {ghButton}
          {set.tabs.length > 1 && <span className="wb-sep" />}
        </div>
        {set.tabs.slice(1).map((t, i) => renderTab(t, i + 1))}
        <div className="wb-drag" />
        <div className="wb-spill">
          <button
            className="wb-new"
            aria-label="New tab"
            title="New tab ⌘T"
            onClick={() => {
              setMenuOpen(false)
              setDlOpen(false)
              setGhMenu(false)
              setNewMenuOpen((v) => !v)
            }}
          >
            <LuPlus size={14} />
          </button>
          {session?.sessionId && (pinned[session.sessionId]?.length ?? 0) > 0 && (
            <span className="bdriven" title="A CDP client is driving tabs in this session">
              agent driving
            </span>
          )}
        </div>
      </div>

      {ghMenu && ghInfo && (
        <div
          className="menu wb-ghmenu"
          role="menu"
          onMouseLeave={() => setGhMenu(false)}
          ref={(el) => {
            el?.focus()
          }}
          tabIndex={-1}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setGhMenu(false)
          }}
        >
          <button
            className="mi"
            role="menuitem"
            onClick={() => {
              setGhMenu(false)
              openGithub('repo')
            }}
          >
            <LuGithub size={14} />
            Open repository
          </button>
          <button
            className="mi"
            role="menuitem"
            onClick={() => {
              setGhMenu(false)
              openGithub('pulls')
            }}
          >
            <LuGitPullRequest size={14} />
            Open pull requests
          </button>
          {ghInfo.pr !== null && (
            <button
              className="mi"
              role="menuitem"
              onClick={() => {
                setGhMenu(false)
                openGithub('pr')
              }}
            >
              <LuGitPullRequest size={14} />
              {`Open pull request #${ghInfo.pr}`}
            </button>
          )}
          <button
            className="mi"
            role="menuitem"
            onClick={() => {
              setGhMenu(false)
              github.recheck()
            }}
          >
            <LuRotateCw size={14} />
            Check again
          </button>
        </div>
      )}

      {newMenuOpen && (
        <div
          className="menu wb-newmenu"
          role="menu"
          onMouseLeave={() => setNewMenuOpen(false)}
          ref={(el) => {
            el?.focus()
          }}
          tabIndex={-1}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setNewMenuOpen(false)
          }}
        >
          <button
            className="mi"
            role="menuitem"
            onClick={() => {
              setNewMenuOpen(false)
              newWebTab()
            }}
          >
            <LuGlobe size={14} />
            New web tab
          </button>
          <button
            className="mi"
            role="menuitem"
            onClick={() => {
              setNewMenuOpen(false)
              openFilePicker()
            }}
          >
            <LuFileText size={14} />
            Open file…
          </button>
          {!sessionCold && (
            <button
              className="mi"
              role="menuitem"
              onClick={() => {
                setNewMenuOpen(false)
                newTerminal()
              }}
            >
              <LuTerminal size={14} />
              New terminal
            </button>
          )}
        </div>
      )}

      {activeKind === 'web' ? (
        <BrowserAddressBar
          url={activeTab?.url ?? ''}
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
                  <LuDownload size={16} />
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
                <LuEllipsis size={16} />
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
        (() => {
          const path = activeTab.path ?? ''
          const editingHere = !!editing[activeTab.id]
          const { dir, name } = splitPath(path, treeRoot)
          const status = git[path]
          const delta = numstat[path]
          return (
            <div className="wb-bar">
              <span className="wb-title" title={path}>
                {dir && <span className="dir">{dir}</span>}
                <span className="nm">{name}</span>
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
              {activeCaps.views.length > 0 && (
                <div className="seg" role="group" aria-label="View mode">
                  {activeCaps.views.map((v) => (
                    <button
                      key={v}
                      className={!editingHere && v === activeCaps.current ? 'on' : undefined}
                      aria-pressed={!editingHere && v === activeCaps.current}
                      disabled={v === 'diff' && !activeCaps.hasDiff}
                      onClick={() => {
                        if (editingHere) exitEdit(activeTab.id)
                        if (ownerTab)
                          onUpdate(ownerTab, (prev) => setTabView(prev, activeTab.id, v))
                      }}
                    >
                      {VIEW_LABEL[v]}
                    </button>
                  ))}
                </div>
              )}
              <button
                className="icobtn"
                onClick={reload}
                title={editingHere ? 'Not while you are editing' : 'Reload'}
                aria-label="Reload"
                disabled={editingHere}
              >
                <LuRotateCw size={14} />
              </button>
              <button
                className={'icobtn wb-edit' + (editingHere ? ' on' : '')}
                aria-label="Edit"
                aria-pressed={editingHere}
                title={editingHere ? 'Stop editing' : editProbe.title || 'Edit'}
                disabled={!editingHere && !editProbe.can}
                onClick={() =>
                  editingHere ? exitEdit(activeTab.id) : enterEdit(activeTab.id, path)
                }
              >
                <LuPencil size={13} />
              </button>
              <button
                ref={outlineBtnRef}
                className={'icobtn' + (outlineOpen[activeTab.id] ? ' on' : '')}
                title="Outline"
                aria-label="Outline"
                disabled={!activeCaps.hasOutline}
                onClick={() =>
                  setOutlineOpen((prev) => ({ ...prev, [activeTab.id]: !prev[activeTab.id] }))
                }
              >
                <LuAlignLeft size={14} />
              </button>
              {fullBtn}
            </div>
          )
        })()
      ) : (
        <FilesBar c={files} changedCount={changedCount} fullBtn={fullBtn} />
      )}

      {dlOpen && (
        <BrowserDownloads
          list={downloads}
          onReveal={(path) => window.api.fs.reveal(path)}
          onCancel={(id) => window.api.browser.cancelDownload(id)}
          onRetry={(id) => window.api.browser.retryDownload(id)}
          onClear={() => setDownloads((prev) => clearFinishedDownloads(prev))}
          onClose={() => setDlOpen(false)}
        />
      )}

      {menuOpen && (
        <div
          className="bmenu"
          role="menu"
          onMouseLeave={() => setMenuOpen(false)}
          ref={(el) => {
            el?.focus()
          }}
          tabIndex={-1}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setMenuOpen(false)
          }}
        >
          <button
            className="bmenu-item"
            role="menuitem"
            onClick={() => {
              if (activeTab?.url) window.api.browser.copyText(activeTab.url)
              setMenuOpen(false)
            }}
          >
            <LuLink size={14} />
            Copy current URL
          </button>
        </div>
      )}

      <BrowserPermissionBar
        ask={permAsk}
        refusal={permAsk ? null : permRefusal}
        onAnswer={answerPermission}
        onDismissRefusal={() => setPermRefusal(null)}
        onEscapeHatch={(origin) => {
          setPermRefusal(null)
          onExternalOpen(activeTab?.url || origin)
        }}
      />

      <div className="wb-body">
        {/* PLATFORM§9 */}
        {mountedWebTabs.map(({ owner, tab }) => {
          const onScreen = visible && owner === ownerTab && tab.id === set.activeId && !sessionCold
          return (
            <BrowserGuest
              key={`${tab.id}:${runtime[tab.id]?.mountToken ?? 0}`}
              url={runtime[tab.id]?.pendingUrl || tab.url || ''}
              /* PLATFORM§9 */
              visible={onScreen || staged.has(tab.id)}
              staged={staged.has(tab.id) && !onScreen}
              {...guestHandlers(owner, tab)}
            />
          )
        })}

        {/* PLATFORM§21 */}
        {termTabs.map(({ owner, tab }) => (
          <div
            key={tab.id}
            className="wb-host wb-term"
            data-pty={tab.id}
            style={{
              display: owner === ownerTab && tab.id === set.activeId ? undefined : 'none'
            }}
          >
            <TerminalView
              id={tab.id}
              active={owner === ownerTab && tab.id === set.activeId}
              autoFocus={false}
              focusSignal={termFocus.ptyId === tab.id ? termFocus.n : NO_FOCUS_SIGNAL}
            />
          </div>
        ))}

        {fileTabs.map((t) => (
          <div
            key={t.id}
            className="wb-host"
            style={{ visibility: t.id === set.activeId ? undefined : 'hidden' }}
          >
            {ownerTab && editing[t.id] && getEntry(ownerTab, t.id) ? (
              <EditPane
                ownerTab={ownerTab}
                tabId={t.id}
                focusNonce={editFocus[t.id] ?? 0}
                onSaved={refreshFiles}
              />
            ) : (
              <ArtifactPane
                tabId={t.id}
                path={t.path ?? ''}
                view={t.view}
                wsRoot={treeRoot}
                line={t.line}
                base={base}
                changed={!!(t.path && git[t.path])}
                initialScrollTop={t.scrollTop}
                reloadNonce={reloadNonce[t.id] ?? 0}
                outlineOpen={!!outlineOpen[t.id]}
                onCaps={reportCaps}
                onNavigate={retarget}
                onBody={reportBody}
                onZoomImage={setZoom}
                zoom={t.id === set.activeId ? zoom : null}
                onCloseZoom={closeZoom}
                onOutlineClose={closeOutline}
                onClose={close}
                editText={
                  ownerTab && isTabDirty(ownerTab, t.id)
                    ? getEntry(ownerTab, t.id)?.text
                    : undefined
                }
                editUnsaved={!!ownerTab && isTabDirty(ownerTab, t.id)}
              />
            )}
          </div>
        ))}

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
          />
        </div>

        {webOverlay}
      </div>

      {findOpen && (
        <FindBar
          inputRef={findInputRef}
          query={query}
          onQueryChange={(q) => {
            setQuery(q)
            if (activeKind === 'web') searchGuest(q)
            else dom.search(q)
          }}
          count={activeKind === 'web' ? guestFindCount : dom.count}
          onNext={() =>
            activeKind === 'web'
              ? searchGuest(query, { findNext: false, forward: true })
              : dom.next()
          }
          onPrev={() =>
            activeKind === 'web'
              ? searchGuest(query, { findNext: false, forward: false })
              : dom.prev()
          }
          onClose={closeFind}
        />
      )}

      {dialog && <BrowserModal dialog={dialog} onAnswer={onDialogAnswer} />}
    </div>
  )
}
