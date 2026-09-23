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
import { TerminalView } from './TerminalView'
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

/** FR-24 — the global ceiling on simultaneously live guests (one renderer process each);
 *  everything past it is frozen, never closed. Main owns the number (it owns the
 *  KOLOFT_BROWSER_GUEST_LIMIT seam TEST-8 injects); the LRU that enforces it is here.
 *  Deliberately NOT `liveWebTabs()`: that expresses the same rule over ONE session's set,
 *  while the budget is global — a background session's guests spend from it too (D8). */
function guestLimit(): number {
  return window.api.browserGuestLimit
}

interface TabRuntime {
  loading: boolean
  canBack: boolean
  canForward: boolean
  fail: GuestFailure | null
  crashed: boolean
  zoom: number
  /** part of the guest's React key: bumping it throws the dead render process away and
   *  mounts a fresh guest (the crash placeholder's Reload) */
  mountToken: number
  /** where the guest is being sent before the tab's own url has caught up */
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

/** How long the D4 report keeps asking a freshly attached guest for its webContents id. */
const GUEST_ID_RETRY_MS = CDP_GUEST_ID_RETRY_MS
const GUEST_ID_RETRIES = CDP_GUEST_ID_RETRIES

/** The commands App dispatches BEFORE the panel is on screen, expanding it in the same
 *  tick so the resulting mount runs them — FR-45's ⌘⇧F, and View ▸ New Browser Tab. A
 *  first mount treats every OTHER command it finds waiting as stale (see `lastCommand`). */
const PREARMED_COMMANDS: ReadonlySet<WorkbenchCommandSignal['id']> = new Set([
  'find-files',
  'browser-new-tab'
])

const VIEW_LABEL: Record<ArtifactView, string> = {
  render: 'Rendered',
  diff: 'Diff',
  source: 'Source'
}

/** the same letters the file tree writes, so one file reads identically in both places */
function hostOf(url: string): string {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

/** a guest that has crashed or is not attached yet answers neither question */
function history(el: GuestElement | undefined): { canBack: boolean; canForward: boolean } {
  try {
    return { canBack: el?.canGoBack() ?? false, canForward: el?.canGoForward() ?? false }
  } catch {
    return { canBack: false, canForward: false }
  }
}

/** the id main addresses a guest's own webContents by, or 0 while the element cannot yet
 *  name it — the same not-attached-yet window as `history()` above (#31918) */
function guestId(el: GuestElement | undefined): number {
  try {
    return el?.getWebContentsId() ?? 0
  } catch {
    return 0
  }
}

/** the page the guest is on right now — ahead of the tab model, which only learns it on
 *  the next render (same not-attached-yet window as above) */
function guestUrl(el: GuestElement | undefined): string {
  try {
    return el?.getURL() ?? ''
  } catch {
    return ''
  }
}

/** a certificate error is the one failure that gets Chrome's shape (§05D-4/B6) instead
 *  of the standard error page: an interstitial the user can knowingly walk past */
function isCertFailure(fail: GuestFailure): boolean {
  return /^ERR_(CERT|SSL)/.test(fail.description)
}

/**
 * NFR-02 — is this refresh's map the SAME answer as the one on screen?
 *
 * Every poll tick brings a freshly deserialized object across IPC, so storing it as-is
 * changes the map's identity even when nothing about the workspace moved. `git` and
 * `numstat` are both DEPENDENCIES of the Changes stream's fetch effect, so a quiet tick
 * then re-ran the whole aggregate diff (and the untracked backfill behind it) against the
 * same baseline — the second query per refresh that NFR-02 forbids and WB-C17 counts.
 * Keeping the old object when the content matches is what makes the dependency honest;
 * a map that genuinely moved still has a new identity and still triggers the re-fetch,
 * which is the point of listing it as a dependency in the first place.
 *
 * The same shape as `mergeSections` / `setMissingDirs`: compare, then hand back `prev`.
 */
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

/** FR-31's path, split so the parent directories can be dimmed. Relative to the session's
 *  own workspace when the file lives inside it — an absolute `/Users/…` prefix is noise
 *  the reader already knows, and the 560px bar has no room for it. */
export interface WorkbenchPaneProps {
  /** the CONVERSATION TAB whose strip is on screen; null when no session tab is selected
   *  (FR-04). Issue D8: the panel follows the tab, never the claude session id it is
   *  bound to — inside this component it is spelt `ownerTab` so it cannot be confused
   *  with the panel's own tab ids. */
  tabId: string | null
  /** every conversation tab's set — a tab the user switched away from keeps its guests
   *  (D8) until the global cap, an archive or a Koloft restart takes them */
  states: Record<string, WorkbenchTabSet>
  /** the conversation tabs whose session is still running. A guest belongs to one of them
   *  (FR-25): the sets of the others stay listed and readable, their pages do not. */
  liveTabs: ReadonlySet<string>
  /** the panel is showing at all (T2 or T3) */
  visible: boolean
  /** T3 — the panel took the whole centre row (FR-05) */
  full: boolean
  /** FR-57: a user-source open to LOAD. Nothing else may load a tab — an agent tab, a
   *  restored tab and a frozen tab all wait for a click (FR-13/24, NFR-04). */
  load: { tabId: string; nonce: number } | null
  command: WorkbenchCommandSignal | null
  /** a JS dialog / basic-auth challenge main handed over, or null */
  dialog: BrowserDialog | null
  /** applied against the session's CURRENT set, not the one this render saw: a title and
   *  a url can land in the same tick from two different guests */
  onUpdate: (
    tabId: string,
    update: (prev: WorkbenchTabSet) => WorkbenchTabSet,
    after?: () => void
  ) => void
  /** FR-23 — the cap closed a tab; the caller owns the toast. Second arg is the set the
   *  victim came from, so the caller can label it via `tabLabel(set, tab)`. */
  onEvicted: (tab: WorkbenchTab, set: WorkbenchTabSet) => void
  /** ↗ — the user's own escape hatch, never taken automatically (G0) */
  onExternalOpen: (url: string) => void
  /** the user walked past a certificate warning: record the host exception, then the
   *  surface reloads (SEC-8 — the exception lives for this process only) */
  onCertProceed: (url: string) => void | Promise<void>
  onDialogAnswer: (id: string, answer: BrowserDialogAnswer) => void
  /** FR-05 — ⤢ toggles T2↔T3, exactly like ⌘⏎ */
  onToggleFull: () => void
  /** R15/R16 — bumped by App to send the caret INTO the panel (⇧⌘B expanding, ⌘⏎
   *  going full width). Where it lands is this component's call, because only it knows
   *  what kind the active tab is. */
  panelFocus: number
  /** FR-54 — the Esc ladder found none of ITS rungs open, so the layout takes the last
   *  one (T3→T2). Called only in that case. */
  onEscapeFellThrough: () => void
  /** the directory the Files tab browses: the session's own treeRoot */
  treeRoot: string | null
  /** the selected session's row — Browse's decorations read `files` (`access`) and
   *  `lastWritten` off it, and FR-40's ownership filter reads the same list (FR-47) */
  session: SessionInfo | null
  /** the active pty tab id — the Files reading area keys `openFiles` by it */
  activeTabId: string | null
  /** D5: per session, the tabs a CDP client is driving. Pinned against the guest
   *  budget, and marked in the strip so the remote control is never invisible. */
  pinned: Record<string, string[]>
  /** ⇄ D8: the CDP surface names SESSIONS, the panel is keyed by CONVERSATION
   *  TAB. App holds the sessions list, so it answers the one question that converts
   *  between them; nothing else in this component may guess at the mapping. */
  tabForSession: (sessionId: string) => string | undefined
  /** the ops main is waiting on, oldest first. Held by App rather than subscribed
   *  to here, because the first one is what MOUNTS this surface — an event delivered
   *  before that has nobody to run it. */
  cdpOps: BrowserCdpOp[]
  /** an op has been answered and can leave the queue */
  onCdpDone: (opId: string) => void
  /** §4.1c: a CDP client asked for a page (no dedup, pinned) → the new tab's id,
   *  or null when every tab the cap could take is being driven */
  onCdpCreate: (sessionId: string, url: string) => Promise<string | null>
}

/**
 * FR-01/02/03 — the Workbench: one tab strip, one kind bar, one content area, for the
 * session that is on screen. A RESIDENT SINGLETON: switching sessions swaps which set it
 * renders and nothing more, because it is the only mount point for browser guests and
 * unmounting would kill every background session's pages along the way.
 *
 * A tab is never loaded by anything but user intent (FR-13/24, NFR-04): an agent-created
 * tab, a tab restored from disk and a tab the cap froze are all the same state — a target
 * with no guest, waiting for a click.
 *
 * The browser half of this component is `BrowserPane` transformed in place, not rewritten:
 * FR-37 pins permission bar, certificate interstitial, crash placeholder, error page, JS
 * dialogs, zoom steps and page fullscreen to today's behaviour exactly, and the live/frozen
 * LRU, the guest-id retry, the drag reorder and the wheel-to-horizontal strip translation
 * all come across unchanged. What is new is the tab MODEL underneath (three kinds instead
 * of one) and the CONTENT routing above it.
 */
/** A press on a control inside a tab must neither activate the tab nor start dragging it:
 *  the tab is `draggable`, and React's stopPropagation does not reach the native drag
 *  start — only preventDefault keeps the press from becoming a drag that eats the click. */
function pressOnTabControl(e: { stopPropagation(): void; preventDefault(): void }): void {
  e.stopPropagation()
  e.preventDefault()
}

/** Every field of one answer — an identical one must not become a new object. */
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

/**
 *) — what the
 * strip's GitHub button draws, for one session directory.
 *
 * Main answers the local half (is this a github.com repository, which branch is checked
 * out) in milliseconds with `pending` set, and pushes the same answer again carrying the
 * pull-request number once the one command that reaches the network lands. `pending` IS
 * the button's dimmed look — the hook keeps no second copy of it.
 */
function useGithubInfo(root: string | null): {
  info: GithubInfo | null
  recheck: () => void
} {
  /** carries its own root, so switching sessions cannot show one repo's number over
   *  another repo's directory for the millisecond before the new answer lands */
  const [got, setGot] = useState<{ root: string; info: GithubInfo | null } | null>(null)
  const [nonce, setNonce] = useState(0)
  /** the DIRECTORY a "Check again" was asked for — a request belongs to one project, not
   *  to "whatever runs next". It names the root rather than being a bare flag because the
   *  effect below bails while the panel is collapsed (`root` null) without consuming it:
   *  as a flag it would survive that, and then be spent on whichever session the panel
   *  next opened on, popping a sentence about a repository nobody asked about. */
  const forced = useRef<string | null>(null)
  useEffect(() => {
    if (!root) return undefined
    let alive = true
    const force = forced.current === root
    if (force) forced.current = null
    const settle = (info: GithubInfo | null): void => {
      // An answer identical to the one already on screen must not become a new object.
      // This panel is not memoised and can be holding thousands of diff rows, so a re-show
      // that learns nothing has to cost no render at all.
      setGot((prev) =>
        prev && prev.root === root && sameGithub(prev.info, info) ? prev : { root, info }
      )
      // B10 — a forced look that found nothing has to say so, and has to tell "there is
      // none" apart from "could not get there". Silence reads as a dead menu item. Only
      // once the number has landed: the first answer of the pair is always still pending.
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
    forced.current = root
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
  /** R5 — the standing "put the caret in this shell" request, naming the pty it was
   *  raised for. Read from the store rather than passed down: every entrance that opens a
   *  shell (⌃`, the titlebar icon, the ＋ item, ⌘T) raises it there, so none of them needs
   *  a route through App. Only the named body is handed a live signal (see the bodies). */
  const termFocus = useStore((s) => s.termFocus)
  /** tab ids with a mounted guest, least-recently-used first (FR-24) */
  const [live, setLive] = useState<string[]>([])
  const [runtime, setRuntime] = useState<Record<string, TabRuntime>>({})
  /** bumped by a guest reaching `did-attach`, i.e. the first moment it can name its own
   *  webContents — what the extension platform is told about (D4) */
  const [attached, setAttached] = useState(0)
  const [findOpen, setFindOpen] = useState(false)
  const [findFocusTick, setFindFocusTick] = useState(0)
  const [query, setQuery] = useState('')
  const [guestFindCount, setGuestFindCount] = useState<FindCount>({ current: 0, total: 0 })
  /** B9: this run's downloads. Never restored — the list IS the run (§04). */
  const [downloads, setDownloads] = useState<DownloadList>({ items: [] })
  const [dlOpen, setDlOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  /** FR-52 + R2 — the ＋ dropdown: a web tab, a file, and a shell. */
  const [newMenuOpen, setNewMenuOpen] = useState(false)
  /** the GitHub button's right-click menu. The button itself is NOT a tab: it is
   *  outside `workbenchTabs`' model entirely, so it spends no cap, dedups nothing, drags
   *  nowhere and is never persisted. */
  const [ghMenu, setGhMenu] = useState(false)
  /** NFR-02 / WB-K08: a COLLAPSED panel spawns no git. The button only exists while the
   *  panel is showing, so asking about a repository nobody can see is pure waste — and the
   *  suite counts those spawns per workspace, which is how the first version was caught. */
  const github = useGithubInfo(visible ? treeRoot : null)
  /** B7: the one prompt on screen, and the one refusal notice. */
  const [permAsk, setPermAsk] = useState<BrowserPermissionAsk | null>(null)
  const [permRefusal, setPermRefusal] = useState<BrowserPermissionRefusal | null>(null)
  /** §07 #4: which tabs are making noise / are muted, by tab id. */
  const [audio, setAudio] = useState<Record<string, { audible: boolean; muted: boolean }>>({})
  /** B10: the tab being dragged, and where it would land. */
  const [drag, setDrag] = useState<{ id: string; over: number } | null>(null)
  /** §07 #3: a page is fullscreen — the pane fills the center row, chrome steps aside. */
  const [pageFullscreen, setPageFullscreen] = useState(false)
  /** FR-54's first rung: a blown-up image from a `file` tab. */
  const [zoom, setZoom] = useState<string | null>(null)
  /** per `file` tab: what its artifact can offer (FR-31), whether its ≡ is open (FR-32),
   *  and the ↻ counter the kind bar bumps (FR-33). */
  const [caps, setCaps] = useState<Record<string, ArtifactCaps>>({})
  const [outlineOpen, setOutlineOpen] = useState<Record<string, boolean>>({})
  const [reloadNonce, setReloadNonce] = useState<Record<string, number>>({})
  /** B-01 — which `file` tabs are in EDIT mode. A mode, not a view: it is never persisted,
   *  so a restart comes back reading. The buffer behind it lives in `editRegistry`, which
   *  outlives this component (B-30). */
  const [editing, setEditing] = useState<Record<string, boolean>>({})
  /** bumped per tab when edit mode is entered, so the textarea takes the focus exactly once */
  const [editFocus, setEditFocus] = useState<Record<string, number>>({})
  // the registry mutates in place; this is what re-renders the strip's unsaved dots and the
  // toolbar when a buffer turns dirty, saves or hits a conflict
  const [, bumpEdit] = useReducer((n: number) => n + 1, 0)
  useEffect(() => subscribeDirty(bumpEdit), [])
  /** FR-31/50 — the workspace's change set: the `file` kind bar's status letter and ±N,
   *  and the pinned tab's numeric badge. Fetched only while the panel is showing, which
   *  is FR-51's "no git process from the Workbench in T1". */
  const [git, setGit] = useState<GitStatusMap>({})
  const [numstat, setNumstat] = useState<GitNumstatMap>({})
  /** NFR-02 — the baseline, resolved ONCE per refresh and handed to every consumer. A
   *  sha for FR-39's default, the literal `'HEAD'` for its other choice, null when the
   *  root is not a repo at all. */
  /** `undefined` = not resolved yet, and that third state is load-bearing: a consumer
   *  must be able to WAIT for the baseline without confusing "not yet" with "this
   *  directory has no baseline" (a repo with no commits), where the honest answer is to
   *  fetch without one and let main take its staged+unstaged fallback. */
  const [base, setBase] = useState<string | null | undefined>(undefined)
  /** §6 — the worktree was removed under us (WB-C14). Both halves of the Files tab show
   *  a placeholder; an already-open artifact keeps its content. */
  const [rootMissing, setRootMissing] = useState(false)
  /** the recursive watch on `treeRoot` could not start (network mount, EMFILE),
   *  so no `onDirChange` will ever come: session activity refreshes the map instead. */
  const [watchDead, setWatchDead] = useState(false)

  /** FR-38…FR-49 — the pinned tab's own runtime state. It is held HERE rather than inside
   *  FilesView because two panel-level behaviours have to see it: FR-54's Esc ladder needs
   *  to know whether a Files menu is open, and FR-45's ⌘⇧F arrives as a panel command. */
  const files = useFilesController(ownerTab, treeRoot)
  /** the controller object is rebuilt every render; its members are not, so the editor's
   *  callbacks depend on THIS rather than on `files` and keep their identity */
  const refreshFiles = files.refresh

  const addressRef = useRef<HTMLInputElement>(null)
  const findInputRef = useRef<HTMLInputElement>(null)
  const els = useRef(new Map<string, GuestElement>())
  /** each mounted artifact's scroller — the DOM find backend's search root (FR-35) */
  const bodies = useRef(new Map<string, HTMLElement>())
  /** the order guests were first mounted in. Guests are rendered in THIS order, never in
   *  LRU order: moving a <webview> within the DOM re-attaches its guest, which would
   *  reload every page each time the LRU is touched. */
  const mountOrder = useRef<string[]>([])
  /** every tab that has ever had a guest — those are the ones a freeze makes translucent
   *  rather than leaving as a plain never-opened tab */
  const everLive = useRef(new Set<string>())
  /** `file` tabs whose artifact is mounted. A restored `file` tab reads nothing until it
   *  is activated (the file half of "nothing loads without user intent"); once visited it
   *  STAYS mounted, which is what preserves its scroll across tab switches. */
  const [visited, setVisited] = useState<string[]>([])

  /** the tab sets as they are NOW, for the callbacks that resolve after an await — this
   *  render's copy is already history by then */
  const statesRef = useRef(states)
  statesRef.current = states
  const set = (ownerTab && states[ownerTab]) || emptyTabSet()
  const activeTab = set.tabs.find((t) => t.id === set.activeId) ?? null
  const activeKind = activeTab?.kind ?? 'files'
  const activeRuntime = activeTab ? (runtime[activeTab.id] ?? BLANK_RUNTIME) : BLANK_RUNTIME
  const activeCaps = (activeTab && caps[activeTab.id]) || NO_CAPS
  /** B-04 — whether the ✎ on the kind bar may light up, asked about the file the active
   *  tab is showing. One probe at a time: it is the same `edit.open` the editor uses, so a
   *  disabled button and a refused edit can never disagree. */
  const editProbe = useEditProbe(activeKind === 'file' ? (activeTab?.path ?? null) : null)
  const sessionCold = !!ownerTab && !liveTabs.has(ownerTab)
  /** …the same question about any OTHER conversation tab, asked from inside a callback: a
   *  mount a client asked for is answered long after the render that received the op. */
  const liveTabsRef = useRef(liveTabs)
  liveTabsRef.current = liveTabs

  /** Every conversation tab's WEB tabs, by panel tab id, with the conversation tab that
   *  OWNS each one. Web only, and deliberately so: `files` is a system id shared by every
   *  conversation (FR-02), so a whole-set index would collide across them — and only web
   *  tabs own cross-conversation resources anyway. */
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

  /** the webContents id of a tab's guest by TAB id, 0 while it has none (the
   *  same not-attached-yet window `guestId` above already guards, #31918) */
  const guestIdOf = useCallback((id: string): number => guestId(els.current.get(id)), [])

  /** the reverse lookup: the conversation tab whose strip holds the guest with
   *  this webContents id, across every session's mounted guests (NFR-03) */
  const ownerOfGuest = useCallback((gid: number): string | undefined => {
    for (const [tabId, el] of els.current) {
      if (guestId(el) === gid) return webIndexRef.current.get(tabId)?.owner
    }
    return undefined
  }, [])

  /** D5: every tab any client is driving, flattened — the guest budget steps over
   *  these, because dropping one would pull the page out from under a running command. */
  const pinnedIds = useMemo(() => new Set(Object.values(pinned).flat()), [pinned])
  const pinnedRef = useRef(pinnedIds)
  pinnedRef.current = pinnedIds

  /**
   * S1: the tabs ON the stage — the guests that keep a real box (and so real pixels)
   * while the panel is off screen.
   *
   * A SET, not one slot. Two mounts and two captures are routinely in flight at the same
   * time — a client may attach to two tabs without waiting for the first, and a `/clear`
   * rebind announces every tab of the new session in one tick — and with a single slot
   * the second request took the stage from the first, whose guest went hidden again.
   * A hidden guest answers no capture at all (measured: `Page.captureScreenshot` on one
   * simply never returns), so the first request hung until its own timeout.
   *
   * Serialising the requests instead would have cost every one of them the whole queue
   * ahead of it — the same grace × tabs the handshake already had to be cured of — while
   * a set costs only paint, and only for guests a client is holding anyway. Order does
   * not matter: every staged guest sits behind `.wb-body`'s opaque background, so they
   * hide each other from nobody.
   */
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
  /** The stage is borrowed for as long as a client holds the page, and given back the
   *  moment it lets go — the page it was driving leaves the pinned set. Only a tab that
   *  WAS pinned is released here: a mount stages its tab before the attach that pins it,
   *  and clearing in that gap would hide the guest before it ever reaches did-attach.
   *  Left un-cleared, the last driven guest kept its full-size box painted behind the UI,
   *  and the panel root stayed un-hidden, for the rest of the window's life. */
  const prevPinned = useRef(pinnedIds)
  useEffect(() => {
    const was = prevPinned.current
    prevPinned.current = pinnedIds
    setStaged((st) => {
      const next = new Set([...st].filter((id) => !was.has(id) || pinnedIds.has(id)))
      return next.size === st.size ? st : next
    })
  }, [pinnedIds])

  /** give a tab a live guest, evicting the least-recently-used one when the global budget
   *  is full — a freeze, not a close: the tab keeps its url and title (FR-24). */
  const makeLive = useCallback((id: string): void => {
    everLive.current.add(id)
    if (!mountOrder.current.includes(id)) mountOrder.current.push(id)
    setLive((prev) => {
      const next = prev.filter((x) => x !== id && webIndexRef.current.has(x))
      next.push(id)
      const limit = guestLimit()
      // D5: a driven guest is not a candidate. With every slot pinned there is nothing
      // left to take — the list simply grows past the budget rather than breaking a
      // client's grip, which is the outcome the cap exists to avoid in the first place.
      while (next.length > limit) {
        const victim = next.find((x) => x !== id && !pinnedRef.current.has(x))
        if (!victim) break
        next.splice(next.indexOf(victim), 1)
      }
      return next
    })
  }, [])

  /**
   * The same door as `applyLive`, asked about a NAMED conversation tab rather than the one
   * the panel is showing. a client's mount belongs to the session that asked for it,
   * which need not be the session on screen — an agent in a live session opens a page
   * while the user is looking at a session that has ended, and FR-25's guard, read off the
   * panel, refused it. The tab set, the guest and the pin all hang off one conversation
   * already (D8); only this question was not.
   */
  const applyLiveIn = useCallback(
    (owner: string | null, id: string, url: string): void => {
      // FR-25: a guest hangs off a RUNNING session, and this is the one door every load
      // goes through — ⌘R and the address row's ↻, an address submitted over the "Session
      // ended" placeholder, an html file picked from ＋ or clicked in Files. Each of those
      // used to mount and load a guest BEHIND the placeholder (its permission bars painting
      // over it, its audio playing), because only `activate` carried the guard. The caller
      // still mints or retargets the tab; the page comes back with the session, on a click.
      if (owner && !liveTabsRef.current.has(owner)) return
      if (els.current.has(id)) {
        patchRuntime(id, { fail: null, crashed: false })
        // an aborted navigation (a redirect away, a Stop, a url that turns into a
        // download) rejects here; failures are reported through `did-fail-load`, which is
        // why BrowserGuest's identical call carries the same empty catch
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

  /** The tab whose address bar still owes a focus — see `newWebTab`, which arms it. */
  const [addressFocusFor, setAddressFocusFor] = useState<string | null>(null)

  /** The deferred half of `newWebTab`'s focus (see there). A layout effect rather than an
   *  effect so the caret is in place before the frame paints; keyed on the tab id so a
   *  fast second ⌘T cannot leave the first one's intent armed against the wrong tab. */
  useLayoutEffect(() => {
    if (!addressFocusFor) return
    if (activeKind !== 'web' || set.activeId !== addressFocusFor) return
    focusAddress()
    setAddressFocusFor(null)
  }, [addressFocusFor, activeKind, set.activeId, focusAddress])

  /**
   * R14/R17 — keep the caret INSIDE the panel across a change that takes away the
   * element holding it.
   *
   * Chromium fires no blur when a focused element is removed from the document, and none
   * when one is merely hidden either: the caret silently becomes `body`, or (for a guest)
   * stays with a page nobody can see. Both leave the ring and the keys disagreeing — the
   * panel still looks lit while ⌘W has quietly gone back to meaning "close the session",
   * and R6 says ⌘W on a shell may never turn into a dialog about the session behind it.
   *
   * So the caret is handed to the panel root, which is R15's own landing for a Files or
   * file tab and is where the panel's keys read the focus from anyway. Called as
   * `const restore() = keepCaret()` BEFORE the change and `restore` after: the check has
   * to happen while the old element is still the active one.
   *
   * It restores nothing when the caret was NOT in the panel — a page opened from the TUI
   * activates a tab here without the user ever having left the conversation, and pulling
   * the caret out of Claude for that would be the same bug in the other direction.
   */
  const keepCaret = useCallback((): (() => void) => {
    const had = !!rootRef.current?.contains(document.activeElement)
    return () => {
      if (had) rootRef.current?.focus()
    }
  }, [])

  const activate = useCallback(
    (id: string): void => {
      if (!ownerTab) return
      // R17's promised route out of a guest or a shell — ⌘⌥←/→ to Files, then Esc — runs
      // through here, and only works if switching brings the caret with it: the outgoing
      // body goes `visibility:hidden` with its caret still in it, so the next Esc would
      // otherwise reach no ladder at all. Only on a REAL switch: re-clicking the tab that
      // is already active must leave the caret in the page the user is typing in.
      const restore = id === set.activeId ? () => {} : keepCaret()
      onUpdate(ownerTab, (prev) => activateTab(prev, id))
      restore()
      const tab = set.tabs.find((t) => t.id === id)
      if (!tab) return
      if (tab.kind === 'file') {
        // the click IS the intent to read: a restored `file` tab has no artifact mounted
        // until here, and keeps it from then on so its scroll survives every switch
        setVisited((prev) => (prev.includes(id) ? prev : [...prev, id]))
        return
      }
      if (tab.kind !== 'web') return
      // FR-25/F6: a guest hangs off a RUNNING session. While the row is cold the tab stays
      // listed and readable, and the "Session ended" placeholder's Reload has nothing to
      // mount — the page comes back with the session, not before it. Kept here although
      // `applyLive` guards too: the `makeLive` branch below does not go through it.
      if (sessionCold) return
      // an agent tab, a restored tab and a frozen tab all come up from their stored url
      // right here (FR-13/24) — and never before
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
      // The close runs against the set `onUpdate` is holding, not the one this render saw
      // — the same box `openHere` uses, for a sharper reason here: this closure's deps
      // leave `set.tabs` out on purpose, so a ✕ on a background tab, an agent's background
      // open, a drag reorder or a title report — none of which move `activeId` — left it
      // computing FR-19's promotion from a STALE list while the authoritative `closeTab`
      // promoted from the live one. The wrong id got marked visited, and the tab actually
      // promoted came up as a kind bar over an empty body.
      const box: { before: WorkbenchTabSet | null; after: WorkbenchTabSet | null } = {
        before: null,
        after: null
      }
      // the tab being closed may be the one holding the caret (⌘W inside a guest, a shell
      // or an editor, or its own ✕) — see `keepCaret` for what is lost otherwise
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
      // FR-19 promotes a neighbour WITHOUT going through `activate`, so what a click would
      // have done for that tab has to be done here, by kind:
      const promoted =
        after.activeId !== before.activeId ? after.tabs.find((t) => t.id === after.activeId) : null
      if (promoted?.kind === 'file') {
        // a restored `file` tab can become active having never been visited — and
        // `fileTabs` mounts an artifact only for VISITED tabs, leaving the kind bar
        // showing a path over an empty body
        setVisited((prev) => (prev.includes(promoted.id) ? prev : [...prev, promoted.id]))
      } else if (promoted?.kind === 'web' && promoted.url && !sessionCold) {
        // …and a `web` tab that has never loaded (an agent's, a restored one, a frozen one)
        // comes up from its url exactly as a click or ⌘⌥→ would bring it (FR-13/24) —
        // but only while the panel is ON SCREEN. A close can reach here with the panel
        // collapsed (a page's own `window.close()`), and a promotion nobody can see must
        // leave the tab unloaded, exactly as an agent open does: a collapsed panel stays
        // silent and spends nothing (FR-14). The "Not loaded" overlay is what the user
        // finds on expanding, and its click is the load. A neighbour that IS live is only
        // touched in the LRU: reloading it would throw away the page the user was on.
        if (els.current.has(promoted.id)) makeLive(promoted.id)
        else if (visible) applyLive(promoted.id, promoted.url)
      }
      // #8: a fullscreen page that is closed never sends leave-html-full-screen, so the
      // chrome would stay hidden for the rest of the run with nothing to bring it back
      if (id === before.activeId) setPageFullscreen(false)
      setLive((prev) => prev.filter((x) => x !== id))
      unstage(id) // a closed tab has no stage to keep
      setVisited((prev) => prev.filter((x) => x !== id))
      // FR-18/19: the panel NEVER collapses from a close. `files` is pinned, so there is
      // always a tab left to fall back to — the former Browser's "last tab closes the
      // pane" rule has no counterpart here.
    },
    [ownerTab, sessionCold, visible, onUpdate, applyLive, makeLive, keepCaret, unstage]
  )

  // ---- what a CDP client's commands become on this surface ---------------------

  /** mounts a client is waiting on: tabId → "your guest has attached" */
  const pendingMounts = useRef(new Map<string, () => void>())
  /** …and the second half of a mount: "your guest has finished its first load" */
  const pendingSettles = useRef(new Map<string, () => void>())
  /** ops already run, so a re-render never runs one twice */
  const doneOps = useRef(new Set<string>())

  /** #31918 once more: a guest cannot name its own webContents for a little while after
   *  `did-attach`, so the id is POLLED. Reading it once, at attach, yields 0 — which main
   *  would then hand the relay as a live guest that does not exist. */
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

  /** mounts in flight, by tab. Two requests for one tab arrive routinely — the client's
   *  `createTarget` and the auto-attach that the new tab's own strip report triggers —
   *  and they must share ONE mount: mounting twice reloads the page under the first. */
  const inFlightMounts = useRef(new Map<string, Promise<number>>())

  /** resolves when the tab's guest next finishes loading — or after a grace period, so
   *  a page that never stops loading (a stream, a hung server) still hands over. */
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

  /** whether a mounted guest is mid-load right now; a guest that cannot say (not
   *  attached yet, gone) counts as not loading — the fresh-mount path waits regardless */
  const guestLoading = useCallback((tabId: string): boolean => {
    try {
      return els.current.get(tabId)?.isLoading() ?? false
    } catch {
      return false
    }
  }, [])

  const doMount = useCallback(
    async (opOwner: string, tabId: string, urlHint?: string): Promise<number> => {
      // `urlHint` is what makes a just-created tab mountable: the store has it, but this
      // component's props are one render behind, so the index does not know it yet.
      const url = urlHint ?? webIndexRef.current.get(tabId)?.tab.url
      if (url === undefined) throw new Error(`no tab ${tabId}`)
      // On the stage FIRST: the whole surface is hidden while the panel is off, and a
      // <webview> mounted hidden never reaches `did-attach` at all — the wait below
      // would simply time out (measured).
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
          // attaching IS loading (FR-13): the one place a tab loads without a click, and
          // it is a client asking for the page it is about to drive — for ITS session,
          // which is not always the one the panel is showing
          applyLiveIn(opOwner, tabId, url || 'about:blank')
        })
      } else {
        // the guest is already there — a second attach, or a tab the user had open. It
        // only needs its place in the budget; remounting would reload the page under a
        // client that is already driving it.
        makeLive(tabId)
      }
      // §4.2: a fresh guest boots on about:blank and only THEN loads its real url
      // (#31918's ordering guard). Handing the page to a client mid-jump gives it a
      // frame that is detached out from under it a moment later ("Frame has been
      // detached" — measured), so the mount waits for that first load to settle.
      //
      // A guest that was already here and is not loading has nothing to settle, and
      // must not be charged the grace period anyway: a client's handshake attaches
      // every open tab in turn, so that grace became grace × tabs — past the client's
      // own connect timeout on a strip of open pages (measured: 12s for three).
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
          // A mount that failed never gets pinned, so the release-on-unpin effect above
          // would never reach its stage entry: the guest (if any) would keep its box behind
          // the UI, and the panel root would stay un-hidden, for the life of the tab. A tab
          // that IS pinned (a second mount on a page a client already holds) keeps its
          // stage — that one is released the ordinary way, when the client lets go.
          if (!pinnedRef.current.has(tabId)) unstage(tabId)
          throw e
        })
        .finally(() => inFlightMounts.current.delete(tabId))
      inFlightMounts.current.set(tabId, p)
      return p
    },
    [doMount, unstage]
  )

  // §4.1b: main's half of the registry. Pushed whenever the strip or its guests change —
  // main has never had a tab identity of its own, so this report IS the relay's world.
  // Only `web` tabs travel: a `file` or `files` tab has no page for a client to drive.
  //
  // ⇄ D8: `states` is keyed by CONVERSATION TAB, the relay by claude SESSION id
  // (`relayStripChanged`). Report under the id the tab is bound to right now, or a client's
  // `Target.createTarget` answers "no target" for a tab that plainly exists. An unbound
  // tab has nothing a client could address yet, so it says nothing. `bindings` is the
  // dependency that re-sends the strip when a tab's id changes under it (/clear, /resume).
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

  /**
   * B-24 — the ✕ and ⌘W, with the one question that stands between unsaved text and
   * nothing. The dialog is App's (`unsavedPrompt`), because B-25/B-26 have to be able to
   * merge it with the questions THEY ask; the panel only says what is unsaved and what
   * each answer means here.
   *
   * "Save & close" that comes back `stale` does NOT close: the file moved under us, the
   * conflict bar is now up on that tab, and closing would be the exact loss the guard
   * exists to prevent.
   */
  const close = useCallback(
    (id: string): void => {
      if (!ownerTab || id === FILES_TAB_ID) return
      // R6/R7 — a shell closes without a question: there is no buffer to save, and
      // ⌘W on it may never turn into a dialog about the session behind it. The kill goes
      // out first (which also swallows the exit event it produces), then the tab leaves
      // the strip through the ordinary path, so FR-19's neighbour promotion is the same
      // rule here as for every other kind.
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
            // The tab stays open, and the question comes DOWN so that what happened is
            // reachable: the difference and the two ways out live on the tab behind it,
            // and the dialog has nowhere to put a sentence. So the tab comes forward, and
            // the sentence goes where the app's other one-off notices go.
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

  // (kept below `close`: the op loop calls it, and a hook that names it in its deps
  // before its declaration is a TDZ error, not a closure)
  useEffect(() => {
    if (!cdpOps.length) return
    // an op that has left the queue cannot come back, so the ledger only ever holds
    // the ones still in flight
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

      // ⇄ D8, converted ONCE per op: everything below this line works in
      // conversation-tab ids, which is what the panel is keyed by. `tabForSession` walks
      // the same `boundSessionId` chain the rest of the panel does, so a session that has
      // registered but not yet hook-bound still finds its tab.
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
        // the create goes through the store's fetch gate, so it is async now — the op
        // is answered when that settles, not in this tick
        void onCdpCreate(op.sessionId, url).then((tabId) => {
          if (!tabId) {
            // D5: every tab the cap could have taken is being driven — a standard error,
            // never a tab closed out from under another client
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
        // S1: pixels exist only for a guest that is laid out and visible. Put this one
        // on the stage and let a frame go by before saying it is ready — a capture that
        // races the paint comes back empty (or, off screen, never comes back at all).
        stage(op.targetId)
        requestAnimationFrame(() => setTimeout(() => finish({ ok: true }), 90))
      } else {
        finish({ ok: false, error: `unknown op ${op.kind}` })
      }
    }
  }, [cdpOps, mountTab, onCdpCreate, onCdpDone, close, onUpdate, ownerTab, tabForSession, stage])

  /**
   * B-01/B-03/B-06 — go into edit mode on a tab.
   *
   * `created` is `edit.create`'s own fingerprint: a file made a moment ago is empty by
   * construction, so re-reading it would only widen the window in which somebody else
   * could write it (§05 ⑥).
   *
   * A file that may be read but not changed still opens here, with its yellow band and a
   * box that refuses keystrokes — the reason is worth more in front of the file than in a
   * toast about it. One that cannot be read at all (too big, binary, not a plain file)
   * never enters: there would be nothing to show.
   */
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
      // A second Edit on a tab that is ALREADY holding unsaved text for this same file
      // just comes back to it. Re-reading would replace the buffer, which is the one
      // outcome none of the six guarded paths would have allowed either.
      const open = getEntry(sid, tabId)
      if (open && open.path === path && isTabDirty(sid, tabId)) {
        arm()
        return
      }
      void window.api.edit
        .open(path)
        .then((r) => {
          // the read is a round trip, and the tab can move underneath it: a `path:line`
          // click retargets it (and then this text belongs to the wrong file, which the
          // next save would write to the wrong path), or a second ✎ already opened it (and
          // then this would replace whatever has been typed since).
          const now = statesRef.current[sid]?.tabs.find((t) => t.id === tabId)
          if (!now || now.path !== path) return
          // unsaved text that appeared while this was in flight wins over what was read;
          // a clean leftover does not, because the file may have moved on since it was
          // last looked at
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

  /** the ✎ again: leave the mode. A buffer with unsaved text is KEPT — the tab still
   *  carries its dot and its guard — while a clean one is forgotten, so the next ✎ reads
   *  the file fresh rather than reviving a stale copy. */
  const exitEdit = useCallback(
    (tabId: string): void => {
      if (!ownerTab) return
      setEditing((prev) => ({ ...prev, [tabId]: false }))
      if (!isTabDirty(ownerTab, tabId)) endEdit(ownerTab, tabId)
    },
    [ownerTab]
  )

  // B-12/B-13 — tell the app-level menu that the surface in front of the user is an
  // editor: Find has nothing to search over a textarea, and the reload key would throw the
  // typing away. Reported, not decided here — which surface owns a key is App's call.
  useEffect(() => {
    setEditingActive(!!(visible && activeTab && editing[activeTab.id]))
  }, [visible, activeTab, editing])

  /**
   * Mint a tab in THIS session and hand back what the model made of it. The open runs
   * against the set `onUpdate` is holding, not against the one this render saw: the file
   * picker resolves after an await, and by then a guest may well have reported a title
   * into the same set — replaying this render's copy over it would drop that title.
   * `onUpdate` applies the updater at once for a fetched tab but PARKS it for one whose
   * strip main has not answered for yet, so the result is handed to `then` from
   * the updater's own completion rather than read back after the call.
   *
   * FR-23's toast is raised here for every caller: an eviction is a real close, and no
   * path that can cause one may stay silent about it.
   */
  const openHere = useCallback(
    (opts: Parameters<typeof openTab>[1], then?: (r: OpenTabResult) => void): void => {
      if (!ownerTab) return
      const box: { r: OpenTabResult | null } = { r: null }
      onUpdate(
        ownerTab,
        (prev) => {
          // B-27: unsaved work is never the eviction victim. Handed to EVERY open rather
          // than to the editor's own, because the opens that can hit the cap are mostly
          // other people's — a `path:line` click, the file picker, an agent's own open.
          box.r = openTab(prev, { ...opts, isDirty: (id) => isTabDirty(ownerTab, id) })
          return box.r.set
        },
        () => {
          const r = box.r as OpenTabResult
          if (r.evicted) onEvicted(r.evicted, r.set)
          // B-27 — every tab of this kind is holding unsaved text, so the open is dropped.
          // A NOTICE, never a dialog: an agent can walk this path, and an agent action may
          // not take the page away from the user. A refused open has no tab and answers
          // with an empty id, so no follow-up may carry `''` into its own bookkeeping.
          if (r.refused) useStore.getState().showToast('All tabs have unsaved changes')
          else then?.(r)
        }
      )
    },
    [ownerTab, onUpdate, onEvicted]
  )

  /**
   * FR-52's "New web tab": a tab with no url, so nothing is fetched until the address bar
   * sends it somewhere.
   *
   * The focus is DEFERRED rather than taken inline. `BrowserAddressBar` — which owns
   * `addressRef` — only mounts on the next render, because the kind bar is gated on
   * `activeKind === 'web'`. Focusing synchronously therefore hit a null ref whenever the
   * previously active tab was `files` or `file`, and since the panel always opens on the
   * pinned tab that was the COMMON path: ＋ ▸ New web tab (and ⌘T from `files`) landed on
   * a blank page with the focus on `<body>`. Found by BB-C32.
   */
  /** B-02/B-03/B-06 — open this file in a tab of its own and go straight into editing it. */
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

  /**
   * R2/R5's "New terminal" — the ＋ menu item and ⌘T from a shell.
   *
   * Nothing but a hand-off: the cap, the spawn, the directory, the panel and the caret all
   * belong to the store, so this entrance cannot answer any of them differently from ⌃`
   * or the titlebar icon. A cold conversation tab is refused here rather than in the
   * store, because the ＋ menu is the one entrance whose item is still clickable while the
   * session is gone (D2 — a cold panel is readable, and owns no shells).
   */
  const newTerminal = useCallback((): void => {
    if (!ownerTab || sessionCold) return
    useStore.getState().openTerminalTab(ownerTab)
  }, [ownerTab, sessionCold])

  /** FR-52's "Open file…": the picker. An .html/.htm choice routes per FR-11 into a `web`
   *  tab — a page renders only inside a guest — and a cancel is a no-op. */
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
      // SEC-13: everything outside http/https/file (javascript:, data:, koloft-file:,
      // chrome:, devtools:) is refused here rather than turned into a search
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

  /** FR-33/36 — one ↻ for both kinds: the guest reloads, an artifact re-reads in place. */
  const reload = useCallback((): void => {
    if (!activeTab) return
    // B-13/B-29 — ↻ and ⌘R mean "throw my typing away, without asking", so while a tab is
    // in edit mode they do nothing at all (the button is disabled; the menu key lands here)
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

  // FR-35 — ONE find bar for the whole panel, its backend forked by the active tab's kind:
  // DOM find over the artifact's scroller, the guest's own findInPage over a page.
  const activeId = activeTab?.id
  const getFindRoot = useCallback(
    (): HTMLElement | null => (activeId ? (bodies.current.get(activeId) ?? null) : null),
    [activeId]
  )
  const dom = useDomFind(getFindRoot)
  const domClear = dom.clear

  /** The panel root. Focusable (tabIndex -1) so any click on non-focusable chrome parks
   *  the focus inside the panel — and so a rung of FR-54's ladder that unmounts the
   *  focused element can hand the focus back rather than drop it on <body>. */
  const rootRef = useRef<HTMLDivElement>(null)

  /**
   * R15/R16 — App said "the caret belongs in the panel"; this decides where in it.
   *
   * Three landings, one per kind, because "the panel has the focus" is true for all three
   * and would hide two of them being wrong: a web tab hands the caret to its <webview>,
   * so typing goes to the page; a terminal tab hands it to the shell, through the same
   * `termFocus` bump every other shell entrance uses; Files and a file tab have no single
   * control that deserves it, so it parks on the focusable root, which is where the
   * panel's own keys (⌘W, ⌘T, ⌘⌥←/→, the Esc ladder) read it from anyway.
   *
   * The "last seen" value starts at 0, matching App's initial state, so this singleton
   * mounting — which happens on the first session that shows a panel, long before anyone
   * asked for the caret — moves nothing. Only a bump does.
   *
   * A web tab with no guest yet (never loaded, frozen by the cap, reclaimed) falls back
   * to the root rather than dropping the caret on <body>, where the panel's keys would
   * stop being the panel's.
   */
  const seenPanelFocus = useRef(0)
  useEffect(() => {
    if (panelFocus === seenPanelFocus.current) return
    seenPanelFocus.current = panelFocus
    if (activeKind === 'terminal') {
      // R15 — the shell in front of the user, named: the request has to say WHICH pty, or
      // every mounted shell would answer it (see the store's `termFocus`).
      if (set.activeId) useStore.getState().focusPanelTerm(set.activeId)
      return undefined
    }
    // Deferred a frame, the same way `TerminalView` defers its own: the gesture that
    // bumped this is usually the one UN-HIDING the panel in the same commit, and
    // `focus()` on a still-hidden element does nothing at all.
    const raf = requestAnimationFrame(() => {
      const guest = activeKind === 'web' ? guestOf(set.activeId) : undefined
      if (guest) guest.focus()
      else rootRef.current?.focus()
    })
    return () => cancelAnimationFrame(raf)
    // the landing depends on what is active WHEN THE BUMP LANDS, and nothing else may
    // re-run it — a tab switch must not yank the caret back into the panel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelFocus])

  const closeFind = useCallback((): void => {
    setFindOpen(false)
    setQuery('')
    setGuestFindCount({ current: 0, total: 0 })
    domClear()
    for (const el of els.current.values()) {
      try {
        el.stopFindInPage('clearSelection')
      } catch {
        /* guest gone */
      }
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
      } catch {
        /* guest not ready */
      }
    },
    [activeTab?.id]
  )

  const openFind = useCallback((): void => {
    // B-12 — the find bar highlights rendered text (useDomFind), which does nothing at all
    // over a textarea. A bar that opened and reported 0/0 for ever looks broken; doing
    // nothing is the honest answer, and follows this repo's own precedent for a key the
    // active surface cannot serve.
    if (activeTab && editing[activeTab.id]) return
    // R6 — ⌘F does nothing on a terminal tab. Koloft's find paints highlights over
    // rendered text; a shell's scrollback is xterm's own canvas, and a bar that could only
    // ever report 0/0 reads as broken. Same call the editor branch above makes.
    if (activeKind === 'terminal') return
    if (activeKind === 'web') {
      setFindOpen(true)
      setFindFocusTick((t) => t + 1)
      return
    }
    // FR-35 — `files` searches with DOM find like a `file` tab does; its root is whatever
    // FilesBody currently shows (the Changes stream, or Browse's reading column), which is
    // why the body reports itself under the pinned tab's own id.
    if (activeKind === 'files') {
      setFindOpen(true)
      setFindFocusTick((t) => t + 1)
      return
    }
    if (!activeCaps.canFind) return // an image has no text; pdf keeps PDFium's own find
    setFindOpen(true)
    setFindFocusTick((t) => t + 1)
  }, [activeKind, activeTab, editing, activeCaps.canFind])

  /**
   * B-15/B-16/B-17 — the save key, on the tab in front of the user.
   *
   * The refresh is only fired on a real write: the change set, the status letters and every
   * diff on screen are a poll behind otherwise, and B-17 asks for them to catch up at once.
   * A conflict and a failure paint themselves — both live on the buffer, which the editor
   * is already subscribed to.
   */
  const saveActive = useCallback((): void => {
    if (!ownerTab || !activeTab) return
    const sid = ownerTab
    const id = activeTab.id
    void saveTab(sid, id).then((r) => {
      if (r !== 'saved') return
      refreshFiles()
      // a buffer nobody is typing into any more has served its purpose; dropping it lets
      // the artifact go back to reading the file, and the next ✎ starts from disk
      if (!editing[id]) endEdit(sid, id)
    })
  }, [ownerTab, activeTab, editing, refreshFiles])

  /** FR-54 — the ladder, consumed by the first match. The panel owns three rungs; the
   *  fourth (T3→T2) is the layout's, so a miss is reported rather than guessed at. */
  const escape = useCallback((): void => {
    if (zoom) {
      setZoom(null)
      return
    }
    if (findOpen) {
      closeFind()
      // FR-54: hand the focus back to the panel root, HERE and not inside `closeFind`.
      // The find input is the focused element while the bar is open, so unmounting it
      // drops the focus onto <body> — and App arbitrates the ladder by
      // `closest('.wb-panel[data-surface]')`, so the next Esc would land nowhere and the
      // ladder would stall one rung in (WB-K05b: the second press did nothing).
      //
      // It belongs to this rung alone because `closeFind` also runs on every TAB SWITCH
      // (FR-35's one-bar-at-a-time effect below). Putting it there stole the focus from a
      // freshly minted web tab's address bar on every ⌘T — which is how BB-C32 caught it.
      rootRef.current?.focus()
      return
    }
    // FR-54's third rung is every menu the panel can have open, the Files tab's own
    // included (WB-K05c opens `base ▾` and expects the first Esc to close just that).
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
      // Same hand-back the find rung above needs, for the same reason and found the same
      // way (WB-K05c, after WB-K05b): a menu takes the focus when it opens, so unmounting
      // it drops the focus onto <body>, App's `closest('.wb-panel[data-surface]')`
      // arbitration stops routing Esc here, and the ladder stalls one rung in — the menu
      // closes and the next press does nothing. It belongs to the Esc path only: menus
      // also close on click-away and on a view switch, and stealing the focus there would
      // repeat the ⌘T regression the find rung's comment records.
      rootRef.current?.focus()
      return
    }
    // FR-54/FR-45 — Browse's SEARCH ROW is a rung too (WB-K05d). Without one, Esc in the
    // search box closed the row (the input's own handler does that) and ALSO fell through
    // to the layout, spending one press on two rungs — the very thing WB-K05c bars for
    // menus. It sits below `anyMenu` because a menu opens ON TOP of the row and takes the
    // focus with it, so the menu is what the first press should take.
    if (files.searchOpen) {
      // The row's input closes ITSELF on this same press (BrowseView's own Esc handler),
      // and `toggleSearch` is a toggle, not a close. App's listener is a document CAPTURE
      // one, so this rung runs first, and its toggle would then be flipped straight back by
      // the input's — leaving the row open. Menus survive the same race only because they
      // close idempotently (`setMenu(null)` twice is once). So close the row only on a
      // press the input will not see — the row open with the focus elsewhere in the panel,
      // e.g. after clicking a result — and otherwise just consume the press.
      const inSearchRow = !!document.activeElement?.closest?.('.ft-search')
      if (!inSearchRow) files.toggleSearch()
      // the same hand-back the two rungs above need, for the same reason (WB-K05b): the
      // input unmounts and drops the focus onto <body>, where App stops routing Esc here.
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

  // one dispatched command per nonce: App owns the arbitration (which surface holds the
  // focus) and hands the panel's own keys here.
  //
  // Seeded at MOUNT from whatever App is holding, not from 0. The signal is App state and
  // this singleton mounts on the first session that shows a panel, so a command dispatched
  // while there was no panel to run it — View ▸ Close Browser Tab picked on the welcome
  // screen — sat there and REPLAYED the moment a session was selected. The exceptions are
  // the commands App pre-arms on purpose, expanding the panel and dispatching in the same
  // tick so that THIS mount consumes them; for those the seed stays 0.
  const lastCommand = useRef(command && !PREARMED_COMMANDS.has(command.id) ? command.nonce : 0)
  useEffect(() => {
    if (!command || command.nonce === lastCommand.current) return
    lastCommand.current = command.nonce
    const el = guestOf(activeTab?.id)
    switch (command.id) {
      case 'browser-new-tab':
        // FR-52 + R6: ⌘T creates a tab of the SAME KIND as the active one — from a
        // shell, one more shell.
        if (activeKind === 'web') newWebTab()
        else if (activeKind === 'file') openFilePicker()
        else if (activeKind === 'terminal') newTerminal()
        else setNewMenuOpen(true)
        break
      case 'browser-close-tab':
        // FR-18: on `files` this is a no-op — the panel stays open, the count unchanged.
        if (activeTab) close(activeTab.id)
        break
      case 'browser-focus-address':
        // FR-36: ⌘L applies only while the active tab is `web`.
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
        // B-15/B-16 — ⌘S belongs to whatever the panel has in front of the user. A clean
        // buffer, a tab with no editor and the pinned tab all answer the same way: nothing
        // happens, no file is touched.
        saveActive()
        break
      case 'find':
        openFind()
        break
      case 'find-files':
        // FR-45 — activate the pinned tab, then toggle Browse's search. App has already
        // expanded a collapsed panel, so the only thing left that could be wrong here is
        // the tab: ⌘⇧F must reach the search box from a `web` or `file` tab too.
        if (set.activeId !== FILES_TAB_ID) activate(FILES_TAB_ID)
        files.toggleSearch()
        break
      case 'cycle-next':
      case 'cycle-prev': {
        // FR-53: strip order, wrapping at both ends; `files` is part of the cycle. The
        // model call only NAMES the target — `activate` is what commits it, so cycling
        // into a frozen tab loads it exactly like a click would.
        const next = cycleTab(set, command.id === 'cycle-next' ? 1 : -1)
        if (next.activeId !== set.activeId) activate(next.activeId)
        break
      }
      case 'escape':
        escape()
        break
      case 'browser-devtools':
        // SEC-15/D13: only ever from this user gesture — no page and no agent can ask.
        // Main opens it (detached, unfocused): the element's own openDevTools cannot be
        // told to leave the focus alone, and R7 forbids a window taking it.
        {
          const id = guestId(el)
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

  /**
   * R7/R9 — a shell can leave the strip without the panel ever being asked: `exit`
   * typed into it, and a claude dying, both take the tab off the set from the STORE. FR-19
   * still promotes a neighbour, but the preparation `closeNow` does by hand for its own
   * closes never ran for those two — so a never-visited `file` tab came up as a kind bar
   * over an empty body (only VISITED ids are mounted), a never-loaded `web` tab as a blank
   * pane, and the caret that was in the dying xterm fell to `<body>`, where the next ⌘W
   * stops meaning "close this tab" and starts meaning "close the session".
   *
   * So the promotion is prepared HERE, from the set itself, wherever it came from.
   * Idempotent by construction: `activate` no-ops on the already-active tab in the model,
   * `setVisited` dedups, and the guest branch is gated on `els.current`, so re-running it
   * for a tab the panel promoted itself costs nothing and reloads no page.
   */
  const prepared = useRef<{ owner: string; id: string } | null>(null)
  useEffect(() => {
    const seen = prepared.current
    if (!ownerTab) return
    prepared.current = { owner: ownerTab, id: set.activeId }
    // Only a move WITHIN one conversation is a promotion. Switching conversations changes
    // `set` wholesale, and re-preparing there would load every incoming session's frozen
    // and never-opened tabs — the opposite of NFR-04's "nothing loads without intent".
    if (!seen || seen.owner !== ownerTab || seen.id === set.activeId) return
    // …and only a move the tab it came FROM did not survive. That one fact separates the
    // two ways `activeId` moves: FR-19 promoting a neighbour because a tab was removed
    // (which is the case this effect exists for, and the only one where nobody prepared
    // the arrival), from the user opening or clicking a tab through the pane's own paths,
    // which prepared it on the way in. Without this the effect also ran for ＋ ▸ New web
    // tab and called `makeLive` on a tab whose url is still empty — mounting a guest over
    // nothing, which paints the error page on what should be a blank new tab (BB-C29).
    if (set.tabs.some((t) => t.id === seen.id)) return
    activate(set.activeId)
    // The caret half. `keepCaret` cannot help here — by the time this runs the xterm that
    // held it is already unmounted and Chromium has reset `activeElement` to `<body>`,
    // which is never a deliberate destination. Body right after the panel's own strip
    // moved under it means the caret came FROM here, so it goes back to the panel root.
    // A caret anywhere real — the TUI, the sidebar, another window's — is left alone.
    if (document.activeElement === document.body) rootRef.current?.focus()
  }, [set.activeId, ownerTab, activate])

  // one load per nonce: the same target routed in twice is two loads, and the tab it
  // resolved to may well be the one already on screen (dedup)
  const lastLoad = useRef(0)
  useEffect(() => {
    if (!load || load.nonce === lastLoad.current) return
    lastLoad.current = load.nonce
    activate(load.tabId)
  }, [load, activate])

  // B9: every stage of every download in this run. The list outlives the toast, which is
  // the whole point of it existing (§04).
  useEffect(() => {
    return window.api.browser.onDownloadEvent((event) => {
      setDownloads((prev) => applyDownloadEvent(prev, event))
    })
  }, [])

  // B7: a page is asking. One bar at a time — a second ask waits rather than painting over
  // the first, since two bars are two chances to answer the wrong one.
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

  /** Take down every unanswered prompt, answering it toward main. Every bar taken down
   *  here has a page waiting inside its own call: cancelling through main is what answers
   *  it — clearing only the renderer's state leaves the page frozen AND poisons the queue,
   *  so the next request for the same thing joins an entry nobody will ever answer. */
  const cancelPrompts = useCallback((): void => {
    setPermAsk((current) => {
      if (current) window.api.browser.cancelPermission(current.id)
      for (const queued of permQueue.current) window.api.browser.cancelPermission(queued.id)
      permQueue.current = []
      return null
    })
    setPermRefusal(null)
    setDlOpen(false)
    setMenuOpen(false)
    setNewMenuOpen(false)
    setGhMenu(false)
  }, [])

  // BB-C46: a session switch must not carry a half-answered prompt across. The page that
  // asked is still there and will ask again when it is looked at; a bar left over from
  // another session asks in a name this session has nothing to do with.
  useEffect(() => {
    cancelPrompts()
    // #8: leave-html-full-screen only arrives while the guest is alive. A session switch is
    // not that, so the chrome would stay hidden with no way back.
    setPageFullscreen(false)
    setZoom(null)
  }, [ownerTab, cancelPrompts])

  // FR-25 / §6 — the session went cold with the panel open. Its guests are already gone
  // (the prune below), so the prompts they raised have no one left to answer them: an
  // unanswered `confirm()` would sit over a dead page forever. The tab set and every
  // `file` tab's contents stay exactly as they are.
  useEffect(() => {
    if (!sessionCold) return
    cancelPrompts()
    setPageFullscreen(false)
    // only a dialog with no live owner left. The slot is App-wide, so the one on
    // screen may be a background session's — its guest is still alive and still waiting.
    if (dialog && !dialogHasLiveOwner(dialog, ownerOfGuest, liveTabs)) {
      onDialogAnswer(dialog.id, { ok: false })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionCold, cancelPrompts])

  // §07 #3: the page's own fullscreen. Esc leaves it — and so does the page itself, which
  // is the path a video player's own button takes (BB-M30).
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

  // Figure 2: the refusal notice is a notice, not a decision — it says its piece and goes.
  useEffect(() => {
    if (!permRefusal) return
    const timer = setTimeout(() => setPermRefusal(null), 4000)
    return () => clearTimeout(timer)
  }, [permRefusal])

  const answerPermission = useCallback((id: string, granted: boolean) => {
    window.api.browser.answerPermission(id, granted)
    setPermAsk(permQueue.current.shift() ?? null)
  }, [])

  // §07 #4: which tab is making noise. Keyed by tab id rather than by guest id, so the
  // marker follows the tab through a reorder (BB-C50) — the guest id is an implementation
  // detail that a drag must never be able to shuffle.
  useEffect(() => {
    return window.api.browser.onAudioState((state) => {
      // `guestId`, not a bare call: `els` holds a guest from its mount, and for a few ms
      // after attach the element THROWS on the question (#31918) — `?.` guards a missing
      // method, not a throw. Its 0 for "cannot say yet" matches no real guest.
      const entry = [...els.current].find(([, el]) => guestId(el) === state.guestId)
      if (!entry) return
      setAudio((prev) => ({
        ...prev,
        [entry[0]]: { audible: state.audible, muted: state.muted }
      }))
    })
  }, [])

  const toggleMute = useCallback((tabId: string) => {
    // the same #31918 window as `onAudioState` above: a guest that cannot name itself yet
    // cannot be muted yet either, and the click is dropped rather than thrown on
    const id = guestId(els.current.get(tabId))
    if (!id) return
    setAudio((prev) => {
      const next = !prev[tabId]?.muted
      window.api.browser.setMuted(id, next)
      return { ...prev, [tabId]: { audible: prev[tabId]?.audible ?? false, muted: next } }
    })
  }, [])

  // B10: drag-reorder. Gated on the drag lifecycle rather than debounced — a hand is
  // faster than any timer, and the terminal-island resize taught this the hard way.
  const dropTab = useCallback(
    (to: number) => {
      const id = drag?.id
      setDrag(null)
      if (!id || !ownerTab) return
      onUpdate(ownerTab, (prev) => {
        // The marker draws on tab `to`'s LEFT edge, so the drop means "land before this
        // tab". Removing the dragged tab first shifts everything after it down one, so a
        // forward drag has to aim one slot earlier to land where the line was drawn.
        const from = prev.tabs.findIndex((t) => t.id === id)
        const target = from >= 0 && from < to ? to - 1 : to
        return moveTab(prev, id, target)
      })
    },
    [drag, ownerTab, onUpdate]
  )

  // Pruned against the tabs that still exist, never against `live`: makeLive appends to
  // this ref inside a commit whose `live` is one render behind it, so a live-based prune
  // deletes the guest being mounted right now — every load that arrives while the surface
  // is mounting (the panel's first open, X-4).
  useEffect(() => {
    // …and the same exemption as the FR-25 prune below: a tab whose mount is in flight
    // is one render ahead of this component's view of the strip, so pruning it here
    // drops the guest before it can be rendered at all (measured: `live` kept the id,
    // the render order did not, and nothing ever mounted).
    mountOrder.current = mountOrder.current.filter(
      (id) => webIndex.has(id) || inFlightMounts.current.has(id)
    )
  }, [webIndex])

  // FR-25: a guest hangs off a RUNNING session. The moment one ends — its TUI closed, the
  // row gone cold, the session archived — its pages have no owner left and go; the tab set
  // stays in `states`, readable, and comes back on resume, waiting for a click like every
  // other unloaded tab. Downloads are unaffected: they hang on the partition (G0-3).
  useEffect(() => {
    setLive((prev) => {
      const next = prev.filter((id) => {
        const owner = webIndexRef.current.get(id)?.owner
        if (!owner || !liveTabs.has(owner)) {
          // …with one exception: a guest being mounted RIGHT NOW is not an orphan. Its
          // tab reaches this component one render after the store has it, so a session
          // update landing in that window sees a live id whose tab "does not exist" and
          // drops the guest before it can attach — the mount then waits out its whole
          // timeout (measured: every client-opened page died here).
          return inFlightMounts.current.has(id)
        }
        return true
      })
      return next.length === prev.length ? prev : next
    })
  }, [liveTabs])

  // drop the per-tab artifact bookkeeping of tabs that no longer exist anywhere. Ids are
  // minted, never reused, so a stale entry could never be re-adopted by a later tab — but
  // it would keep an evicted file's caps and outline state alive for the run.
  useEffect(() => {
    // The buffers go first, and by a different rule: measured against the buffer's OWN
    // conversation tab, and only while that tab's set is on hand. A tab whose set is not
    // in `states` yet (its first bind has not landed) must not have its work swept, and a
    // sweep by "is this panel tab id in ANY set" would do exactly that. Clean buffers go
    // too — one left behind would keep feeding the artifact its own stale copy.
    for (const t of allEditTabs()) {
      const own = states[t.ownerTabId]
      if (own && !own.tabs.some((x) => x.id === t.tabId)) endEdit(t.ownerTabId, t.tabId)
    }
    const ids = new Set<string>()
    for (const s of Object.values(states)) for (const t of s.tabs) ids.add(t.id)
    // …and what survived that sweep is a tab that still exists, whatever `states` currently
    // says: before a conversation tab's first bind its ids are in no set at all, and
    // dropping the editor would close it out from under the user even though the text is safe.
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

  // browser-extensions D4: what an extension calls the active tab is the tab this strip has
  // on screen, and only the renderer knows which that is — a tab click, a session switch
  // and a tab an extension opened itself all pass through here. 0 says the strip has no
  // live guest at all, which is a state of its own (a `file` or `files` tab is exactly
  // that). The url travels with the id: D6 has main waiting for the guest of ONE new tab,
  // and the report is the only thing that says which tab it is about. A load nonce is a dep
  // of its own — an open that dedups into the tab already on screen changes nothing else,
  // and main would wait out its timeout for a page that is right there.
  useEffect(() => {
    const el = guestOf(activeTab?.id)
    const url = activeTab?.url ?? ''
    const report = (): boolean => {
      const id = guestId(el)
      window.api.extensions.activeGuest(id, url)
      // a guest cannot name its webContents for a few frames after attach (#31918), and
      // nothing else fires once it can — so the report is retried until it can
      return id > 0 || !el
    }
    if (report()) return
    let tries = 0
    const timer = setInterval(() => {
      if (report() || ++tries >= GUEST_ID_RETRIES) clearInterval(timer)
    }, GUEST_ID_RETRY_MS)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownerTab, activeTab?.id, activeTab?.url, live, attached, load?.nonce])

  useLayoutEffect(() => {
    if (!findFocusTick) return
    findInputRef.current?.focus()
    findInputRef.current?.select()
  }, [findFocusTick])

  // FR-35: only one find bar exists at a time — switching tabs closes it and clears its
  // highlights, so a stale overlay can never sit on a surface nobody is searching.
  useEffect(() => {
    closeFind()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab?.id, ownerTab])

  // the guest reports its match count asynchronously and keeps climbing as Chromium scans,
  // so the bar reads it off the active guest's own event
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

  // FR-31/50/51 — the workspace's change set, fetched ONLY while the panel is showing.
  // The watcher is main's ref-counted one, so several sessions on the same worktree merge
  // into a single poll rather than one each (FR-58).
  //
  // NFR-02 — the BASELINE is resolved here and only here, once per refresh, and the sha it
  // yields is what every consumer is handed. `fs.diffBase` is a git process of its own, so
  // letting each of the stream's file diffs re-derive it would multiply that cost by the
  // size of the change set; WB-C17 counts the spawns to keep this honest. FR-39's other
  // choice needs no resolution at all — 'HEAD' is already a revision.
  const baseChoice = files.baseChoice
  const refreshNonce = files.refreshNonce
  // A different worktree is a different change set, and nothing below clears these on the
  // way out — so without this a session switch shows the PREVIOUS worktree's count and file
  // list until the first IPC round trip lands, and a `rootMissing` carried over from a
  // deleted worktree puts "This directory no longer exists." over a healthy one.
  //
  // Its own effect, keyed on the ROOT alone, and that is not tidiness: inside the poll
  // below it also ran on every ↻ and every baseline switch, so `base` went sha →
  // undefined → sha on each one. Changes treats a baseline change as a reason to re-query,
  // so one refresh became three aggregate diffs — which is precisely what WB-C17 counts,
  // and how this was caught.
  useEffect(() => {
    setGit({})
    setNumstat({})
    setBase(undefined)
    setRootMissing(false)
    setWatchDead(false)
  }, [treeRoot])

  // A hidden panel's change set is also dropped, not merely left alone. FR-51 stops the
  // watcher and every git process the moment the panel leaves the screen, so from then on
  // the map can only go stale — and the next thing to show it was typically a NEW session
  // on the same worktree: it starts in T1 (the bind lands with no session id, and the
  // shipped default is collapsed), so its first expand painted whatever the last visit
  // left — rows and diffs from before an hour of work — as if it were this session's
  // reading, until the catch-up fetch landed (WB-C18). Dropping the map here makes a
  // re-show start from "Reading the change set…" instead: the same first paint a root
  // change gets, and the truth rather than an answer. A visible panel keeps its map across
  // a session switch on the same worktree (WB-C15): there the watcher never stopped, so
  // the map is current.
  //
  // `base` goes with it, and that is what ChangesView keys ITS reset on — the stream
  // cannot see `visible`, but "the panel dropped its baseline" is the one signal it
  // already waits on for a root change, so one rule covers both.
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
            // §6 — "the worktree was removed under us". It rides the same refresh rather
            // than polling on its own, so a deleted root produces no retry storm: with no
            // directory there are no watcher events either.
            //
            // It has to be `dirExists` and not `listDir`: `listDir` answers `[]` for a
            // missing, an unreadable AND an empty directory, and never rejects — so the
            // obvious probe (call it, treat a rejection as "gone") silently never fires,
            // leaving this placeholder unreachable. Found by impl-browse while writing the
            // Browse view against it.
            window.api.fs.dirExists(root).then((ok) => !ok)
          ])
        })
        .then((r) => {
          if (!r || mine !== seq) return
          const [g, ns, missing] = r
          // NFR-02 (see `sameMap`): a tick that found nothing new must not hand the
          // Changes stream a new object to re-query against.
          setGit((prev) => (sameMap(prev, g, (x, y) => x === y) ? prev : g))
          setNumstat((prev) =>
            sameMap(prev, ns, (x, y) => x.added === y.added && x.removed === y.removed) ? prev : ns
          )
          setRootMissing(missing)
        })
        .catch(() => {
          if (mine !== seq) return
          // A failed refresh is NOT the news that the workspace has no changes. Blanking
          // here made a transient git failure wipe every decoration in the panel at once —
          // status letters, ±N and FR-50's badge — and, because the artifacts read
          // `changed` off this map, it also disabled §6's "keep the last good content"
          // guard one layer down, which is how it surfaced: a file being rewritten in a
          // loop made git fail, the map emptied, and the reading area's view oscillated.
          // The last good map stays until a refresh actually answers.
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

  // Throttled, not debounced, for the reason BrowseView's scratchpad timer gives: a working
  // session ticks faster than 600ms, so a debounce would show nothing until the turn ended.
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const refresh = files.refresh
  useEffect(() => {
    if (!watchDead || !visible || refreshTimer.current) return
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null
      refresh()
    }, 600)
  }, [watchDead, visible, session?.updatedAt, refresh])
  // Stop side, kept apart so an activity tick never clears the pending timer (that would
  // be the debounce again): a hidden panel or a new root drops the old root's timer.
  useEffect(
    () => () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current)
      refreshTimer.current = null
    },
    [watchDead, visible, treeRoot]
  )

  // ---- artifact callbacks: ONE stable function per concern, shared by every mounted pane
  // (a per-tab closure would be a fresh identity each render, and `onCaps` would then
  // re-report on every render of this component).
  const reportCaps = useCallback((tabId: string, next: ArtifactCaps): void => {
    setCaps((prev) => (sameCaps(prev[tabId] ?? NO_CAPS, next) ? prev : { ...prev, [tabId]: next }))
  }, [])
  const reportBody = useCallback((tabId: string, el: HTMLElement | null): void => {
    if (el) bodies.current.set(tabId, el)
    else bodies.current.delete(tabId)
  }, [])
  /** FR-35 — the Files body reports itself under the PINNED tab's id, which is what makes
   *  ⌘F on `files` search whatever that tab is currently showing without the find backend
   *  needing to know the tab has two halves. */
  const reportFilesBody = useCallback(
    (el: HTMLElement | null): void => reportBody(FILES_TAB_ID, el),
    [reportBody]
  )
  /** FR-11 — an html file clicked inside Files renders as a PAGE, in a `web` tab. The
   *  backlink is minted from the pinned tab plus the file it came from, so FR-56's
   *  "← Back to source" can both activate `files` and land the stream on that file. */
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
  /** FR-12 — ↗ New tab on a stream block: a standalone `file` tab that inherits the
   *  block's view and scroll offset. `source: 'user'` because it is a click, so the new
   *  tab takes the focus (and, per FR-15, a second ↗ on the same file re-focuses the one
   *  that already exists rather than making a duplicate). */
  const splitToFileTab = useCallback(
    (path: string, view: ArtifactView, scrollTop: number): void => {
      openHere({ kind: 'file', path, source: 'user', view, scrollTop }, (r) =>
        setVisited((prev) => (prev.includes(r.tabId) ? prev : [...prev, r.tabId]))
      )
    },
    [openHere]
  )
  /**
   * FR-32 — closing the outline hands the focus back to the ≡ that opened it.
   *
   * Without this a keyboard user is stranded: the row they just activated leaves the DOM
   * with the list, so `document.activeElement` becomes `<body>`, and Tab from there walks
   * out through the titlebar and the sidebar and STICKS on the TUI's hidden textarea
   * (xterm swallows Tab) — there is no way back into the panel at all. The retired
   * FilePane did exactly this hand-back and spelled out the hazard; the line was lost when
   * the renderer was extracted. It belongs HERE rather than in the artifact because the ≡
   * moved into the kind bar. Found by BB-N11; hits FR-32 in both its forms.
   */
  const outlineBtnRef = useRef<HTMLButtonElement>(null)
  const closeOutline = useCallback((tabId: string): void => {
    setOutlineOpen((prev) => ({ ...prev, [tabId]: false }))
    outlineBtnRef.current?.focus()
  }, [])
  const closeZoom = useCallback((): void => setZoom(null), [])
  /** FR-34 — a reference opens IN THE SAME TAB. The field surgery is the model's
   *  (`retargetTab`), like every other strip mutation: it is what pins which fields move
   *  with the path and which drop (FR-30), and the unit suite holds it to that. */
  const retarget = useCallback(
    (tabId: string, path: string, line?: number): void => {
      if (!ownerTab) return
      const sid = ownerTab
      // B-28 — a reference followed from a tab holding unsaved text opens ELSEWHERE. The
      // model owns both halves (`retargetOrOpenTab`), so which fields travel with the path
      // stays one decision; the panel only deals with what a fallback OPEN implies.
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

  // a page an agent is driving over CDP is not one the user visited
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
      // The audio marker is the GUEST's state, not the tab's: main's mute lives on the
      // webContents and dies with it, so a tab whose guest was frozen (FR-24), reclaimed
      // (FR-25) or crash-remounted comes back UNMUTED. A `muted: true` left here would
      // draw a muted speaker over a page that is audibly playing — and the click meant to
      // fix that would then mute it for real.
      setAudio((prev) => {
        if (!(tab.id in prev)) return prev
        const rest = { ...prev }
        delete rest[tab.id]
        return rest
      })
    },
    onAttached: (): void => {
      setAttached((n) => n + 1)
      // a mount a CDP client is waiting on finishes HERE — did-attach is the
      // first moment the element can name its own webContents (#31918), and that id
      // is the whole registry entry main is waiting for.
      const waiting = pendingMounts.current.get(tab.id)
      if (waiting) {
        pendingMounts.current.delete(tab.id)
        waiting()
      }
    },
    onLoading: (loading: boolean): void => {
      patchRuntime(tab.id, { loading, ...history(guestOf(tab.id)) })
      // NOT every stop ends a mount. A guest boots on about:blank and loads its
      // real url after, and when that first load throws (#31918) the boot page's own
      // stop lands before the re-issued one — handing the client a frame that is
      // detached out from under it a moment later. `stopEndsMount` holds the rule and
      // says why; a guest that cannot answer at all is treated as still on the boot page,
      // which costs the mount its grace period at worst.
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
      // a page that could not load is as finished as it is going to get, and the
      // stop that follows it leaves the guest on the boot page — which the rule above
      // (rightly) refuses. Without this the mount would sit out its whole grace period
      // for a url that already answered.
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

  /**
   * The ON-SCREEN session's visited `file` tabs — deliberately NOT every session's, which
   * is where this differs from `liveTabs` above.
   *
   * Consequence, accepted knowingly (raised by BB-C25/R1 during the e2e migration): a
   * SESSION switch unmounts every file artifact, so its scroll offset is lost and lazy
   * mermaid blocks re-render from the top. A tab switch WITHIN a session keeps them, since
   * those are only visibility-hidden.
   *
   * Why not mirror the guests: a guest costs one renderer process and is therefore capped
   * globally (FR-24), which is what makes "mount them all" affordable. A file artifact has
   * no such cap — 8 per session per FR-22, each with a Shiki pass, a markdown pipeline and
   * a `watchFile` subscription — so mounting every session's would grow unbounded with the
   * session list to buy back a scroll offset. NFR-03 scopes its survival promise to `web`
   * tabs and FR-01's "never unmounts" is about the PANEL, so nothing here is owed.
   *
   * The trade is not free, and its real cost is subtler than "one more barrier per test":
   * a case that switches sessions and then touches an artifact must wait out the remount,
   * and if it does not, it fails as a RACE rather than as an honest red. BB-C20 passed
   * repeatedly on a fast machine and only surfaced under load. So the tax is paid in
   * flakes found late, in whichever case next happens to switch sessions and touch an
   * artifact — not by the change that introduces the problem. Weigh that alongside the
   * runtime cost before treating this as settled.
   *
   * The bounded alternative, if it ever bites harder: §Data Model already calls scroll
   * position runtime state carried ON THE TAB OBJECT, so it could be saved on unmount and
   * restored on mount without keeping the DOM resident. Deferred rather than dismissed.
   */
  const fileTabs = set.tabs.filter((t) => t.kind === 'file' && visited.includes(t.id))

  /**
   * R8 — EVERY live conversation tab's shells, not just the one on screen.
   *
   * The reason this cannot follow `fileTabs` above (which is the on-screen session's
   * alone) is that main keeps no scrollback of its own: an unmounted xterm's buffer is
   * gone, so a session switch would silently empty every shell it left behind. A guest has
   * the same problem and is mounted the same way; a file artifact does not, because it can
   * always re-read the file.
   *
   * `liveTabs` is the filter, so this is the SAME rule as the guest reclaim right above —
   * a conversation tab whose claude ended owns nothing here. Its shells were already
   * killed by `markTabDead`; this is what stops a dead one from lingering in the DOM.
   */
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
      // SEC-6/FR-28: Koloft's own glyph, never the site's favicon — the strip is Koloft's own
      // renderer, so a remote <img> here is the default session fetching from that site,
      // outside the browser partition and with Koloft's identity on it.
      <LuGlobe size={12} />
    ) : (
      <LuFileText size={12} />
    )

  const fail = activeRuntime.fail
  const webOverlay =
    activeKind !== 'web' ? null : sessionCold ? (
      // §6 — the session died with the panel open. Its guests were reclaimed at once; the
      // tab keeps its url and title and comes back on the next resume (FR-25).
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
      // FR-13/24 — a url with no page behind it: an agent's tab, a restored one, one the
      // cap froze, or a neighbour a close promoted while the panel was collapsed. Without
      // this the address row showed the url over a blank body and nothing said why. The
      // button takes the SAME path a click on the tab takes (`activate` → `applyLive`,
      // with its FR-25 guard); the overlay itself never loads anything — it exists so the
      // state is legible, not so it resolves on its own. `live` rather than `els`: the
      // guest mounts in the render that adds the id to `live`, so the overlay leaves in
      // that same render instead of one attach later.
      <div className="bempty">
        <div className="bstate-t">Not loaded</div>
        <div className="bstate-sub">{hostOf(activeTab.url ?? '')}</div>
        <button onClick={() => activate(activeTab.id)}>Load</button>
      </div>
    ) : null

  /** One tab in the strip. `i` is its index in `set.tabs` and must stay that — `dropTab`
   *  moves by model position, so re-basing it at the slice below would land every
   *  drag-reorder one slot off. */
  const renderTab = (t: WorkbenchTab, i: number): JSX.Element => (
    <span
      key={t.id}
      className={
        'wb-tab' +
        (t.kind === 'files' ? ' pinned' : '') +
        (t.id === set.activeId ? ' on' : '') +
        (t.unread ? ' agent' : '') +
        /* §4.3: a page an agent is driving says so, on the tab itself. Remote
           control with no indicator is a haunted browser. */
        (t.kind === 'web' && pinnedIds.has(t.id) ? ' driven' : '') +
        (t.kind === 'web' && !live.includes(t.id) && everLive.current.has(t.id) ? ' frozen' : '') +
        (drag?.id === t.id ? ' dragging' : '') +
        (drag && drag.over === i && drag.id !== t.id ? ' dropbefore' : '')
      }
      title={t.url || t.path || undefined}
      // Layer B anchors a hint card here (`wbTabSelector`)
      data-wb-tab-id={t.id}
      onMouseDown={() => activate(t.id)}
      /* FR-21: HTML drag, not a pointer-math reimplementation — the browser owns
         the grab, the image and the cancel, and a drag that leaves the strip ends
         by itself. `files` is draggable in neither direction (moveTab refuses it
         too, so the model is guarded even if a drop gets here). */
      /* R2: a terminal is pinned to the right end the way `files` is pinned
         to the left, so it is draggable in neither direction (moveTab refuses it
         too, so the model is guarded even if a drop gets here). */
      draggable={t.kind !== 'files' && t.kind !== 'terminal'}
      onDragStart={(e) => {
        if (t.kind === 'files' || t.kind === 'terminal') return
        e.dataTransfer.effectAllowed = 'move'
        // Firefox-style requirement Chromium also honours: a drag with no payload
        // never fires dragover
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
      {/* FR-50 — the change count, on the pinned tab and nowhere else */}
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
      {/* FR-02: the pinned tab has no ✕ at all — not a disabled one */}
      {t.kind !== 'files' && (
        <span
          className="x"
          title="Close tab"
          aria-label="Close tab"
          onMouseDown={pressOnTabControl}
          onClick={() => close(t.id)}
        >
          {/* B-24 — unsaved work shows AS the ✕, and the ✕ comes back under the
              pointer (the way every editor does it). It cannot go on the tab's left
              edge: that dot already means "an agent opened this and you have not
              looked" (FR-16), and both can be true of one tab at once. */}
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

  /**
   * B3/B5/B6 — the button and its menu open an ORDINARY web tab.
   *
   * Main decides the address at the moment of the click, because the login detour (D1) is
   * read off the browser partition's cookies and only main can see those. A second click
   * on a target already open folds onto that tab through FR-15's dedup; it is reloaded
   * only when it has no guest (a restored or frozen tab), never when it is live.
   */
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

  // the store's only trace of the button, and the contextual hint's trigger. The
  // panel stays mounted when collapsed, so `visible` is what makes "there is a button" and
  // "you can see it" the same fact; a card pointing at a hidden button points at nothing.
  //
  // No cleanup on purpose, and it would be wrong to add one (two reviews have now asked):
  // React runs a cleanup before EVERY re-run, so clearing there would write false→true on
  // each dep change, and every store write re-runs the whole hint queue (`useHints`). The
  // flag cannot be left stranded `true` either — this component never unmounts (FR-01:
  // `panelMounted` in App is a one-way latch), and both ways the button can go away move a
  // dep: collapsing clears `visible`, leaving the repository clears `github.info`.
  useEffect(() => {
    useStore.getState().setGithubBtn(visible && !!github.info)
  }, [visible, github.info])

  const ghInfo = github.info
  /** B2 — a number means the pull request, no number means the repository. The tooltip is
   *  the only place the right-click menu is announced (§2.3: a caret drawn on the button
   *  would jog every tab beside it). */
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

  /** FR-05 — ⤢, the same T2↔T3 toggle ⌘⏎ is. Present in every kind's bar.
   *  The label names the action it will perform and carries its accelerator, which is the
   *  form the former `.bfocus` used and the form the suite locates by prefix. It flips
   *  with the state, so `aria-pressed` carries that state as well — a screen reader gets
   *  the toggle's position from the property rather than having to infer it from a name
   *  that changed under it. */
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
      /* Whether the panel is SHOWING is state, not focus — `focusedWorkbench` keys off
         this attribute so a collapsed panel (mounted, zero width, guests alive) can never
         answer "the panel has the focus". Which surface the KEYS go to is a separate
         question, and since D6/R14 that one IS the focus. */
      data-surface={visible ? 'workbench' : undefined}
      data-kind={activeKind}
      /* F5: the Chrome keys are arbitrated by the focus, so every part of the panel has to
         be able to hold it — the strip's tabs are spans, and a click on one would otherwise
         leave the focus on <body> and hand ⌘W to the session behind. Focusable root =
         Chromium walks up to it from whatever non-focusable chrome was clicked, while the
         address field, a guest and a shell's xterm each still win their own. */
      tabIndex={-1}
      /* S1: the stage has to lift this. The whole surface is hidden while the panel
         is off, and `visibility` INHERITS — so a guest marked visible for the stage would
         still be hidden by this root, never reach `did-attach`, and never produce a frame
         to capture. The panel itself is what hides the stage from the user (behind the
         UI, at 1% opacity), not this. */
      style={{ visibility: visible || staged.size > 0 ? undefined : 'hidden' }}
    >
      {/* ---- row 1: the tab strip (FR-02/16/21/24/26/27/28) ---- */}
      <div
        className="wb-tabs"
        /* FR-26: the strip itself is the scroller and `.wb-spill` sticks to its right edge,
           so the ＋ never scrolls out. A mouse has one wheel and it scrolls vertically;
           without this translation someone without a trackpad simply cannot reach the tabs
           past the edge (found in the manual round). Chrome's own strip does the same. */
        onWheel={(e) => {
          const strip = e.currentTarget
          if (strip.scrollWidth <= strip.clientWidth) return
          // a real horizontal gesture (trackpad) is left alone; a vertical one is turned
          if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return
          e.preventDefault()
          strip.scrollLeft += e.deltaY
        }}
      >
        {/* §7.1 — the panel's own furniture, stuck to the left edge: the pinned
            Files tab, the GitHub button, and the divider that fences both off from the
            user's own tabs. Sticky for the reason `.wb-spill` is — with a full strip
            these scrolled out of reach (which was already true of Files alone). */}
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
          {/* §4.3: and once on the surface itself, so the state is readable without
              hunting for the dotted tab (Chrome's "controlled by automated software") */}
          {session?.sessionId && (pinned[session.sessionId]?.length ?? 0) > 0 && (
            <span className="bdriven" title="A CDP client is driving tabs in this session">
              agent driving
            </span>
          )}
        </div>
      </div>

      {/* §7.3 — the GitHub button's right-click menu: three ways to open a page and
          one way to look the number up again. Every item is READ-ONLY; making a pull
          request, commenting and merging are all deliberately absent (do those on the page
          itself, or ask Claude in the session). Hung off the panel root for the same reason
          the ＋ dropdown below is. */}
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

      {/* FR-52 + R2 — the ＋ dropdown: one item per kind the panel can make. A child
          of the panel root rather than of the spill it hangs from, for the reason `.bmenu`
          is: the strip is a horizontal scroller, so anything nested inside it is clipped on
          the way down. */}
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
          {/* D2: no shell can live in a session that has ended, so the item goes with
              it rather than opening one that would be killed in the same breath. */}
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

      {/* ---- row 2: the kind bar (FR-31/36/56, plus FR-05's ⤢ in every kind) ---- */}
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
              {/* FR-56 — only while the source tab is still open; `closeTab` drops the
                  backlink when it goes, so this never dangles. Labelled rather than an
                  icon: a bare ← one control away from the history Back arrow is two left
                  arrows in one row meaning two different things. */}
              {backlink && (
                <div className="seg wb-backlink">
                  <button
                    title="Back to source"
                    onClick={() => {
                      activate(backlink)
                      // FR-56's `files` case: the pinned tab holds a whole change set, so
                      // activating it is only half the answer — the stream has to land on
                      // the file the page was rendered out of (WB-R13). A `file` tab
                      // needs none of this: it IS the one artifact.
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
                  /* the panel's outside-click closer must not count its own toggle as
                     outside, or the click that closes it is followed by the click that
                     reopens it and the button stops working */
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
        /* R19 — a shell's kind bar is its directory and nothing else: no reload, no view
           segment, no status letter. The label follows the shell's own `cd` (main's OSC 7
           reports), which is why it reads off the tab rather than off the session root. */
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
                      // an unchanged file keeps Diff in the segment, disabled: a control
                      // that comes and goes as the agent edits the file underneath is a
                      // moving target for the pointer
                      disabled={v === 'diff' && !activeCaps.hasDiff}
                      onClick={() => {
                        // B-14 — leaving the mode this way KEEPS the buffer: the chosen
                        // view then shows what is in memory, marked unsaved, rather than
                        // the older bytes still on disk.
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
                /* B-13 — re-reading the file IS "discard my changes", and it does not ask */
                disabled={editingHere}
              >
                <LuRotateCw size={14} />
              </button>
              {/* B-01 — a MODE button, deliberately not a fourth slot in the segment above:
                  Diff and Source are two angles on one thing, editing is a different thing
                  to be doing. As a button it also needs no persistence and cannot be
                  knocked out by the segment's own fallback rules. */}
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
              {/* FR-31 lists ≡ as part of the header, so it stays in the row and goes
                  disabled for an artifact with nothing to outline */}
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
        {/* NFR-03: every live guest of every session stays mounted and is hidden with
            `visibility`, never `display:none` — a <webview> in a display:none subtree is
            detached and reloads on the way back (electron#28677). */}
        {mountedWebTabs.map(({ owner, tab }) => {
          const onScreen = visible && owner === ownerTab && tab.id === set.activeId && !sessionCold
          return (
            <BrowserGuest
              key={`${tab.id}:${runtime[tab.id]?.mountToken ?? 0}`}
              url={runtime[tab.id]?.pendingUrl || tab.url || ''}
              /* S1: a page produces frames only while it is genuinely visible and
                 laid out — `visibility: hidden`, or a zero-width panel, and a capture on
                 it never answers at all. So the guest on the stage stays visible whatever
                 is on screen: off screen the whole panel is the stage (parked behind the
                 UI), and on screen the staged guest is painted behind the panel's own
                 background. Everything else follows the ordinary rule. */
              visible={onScreen || staged.has(tab.id)}
              staged={staged.has(tab.id) && !onScreen}
              {...guestHandlers(owner, tab)}
            />
          )
        })}

        {/* R8 — one shell per terminal tab of every LIVE conversation tab. What R8
            asks for is that they stay MOUNTED: main buffers no scrollback at all, so
            unmounting an xterm throws its output away for good and the tab comes back
            looking perfectly healthy and empty.
            HOW they hide is a separate question, and the answer here is the opposite of
            the guests': `display:none`, not `visibility:hidden`. A guest has no choice —
            a <webview> in a display:none subtree detaches and reloads (electron#28677) —
            but an xterm is built for it. Its renderer pauses through an IntersectionObserver
            and its fit no-ops at 0×0, both of which only engage when the box is really
            gone; left merely invisible, every shell of every live conversation keeps
            painting frames and refitting on each panel resize. The retired island hid its
            shells this way for the same reason, and `TerminalView`'s [active] effect is
            what refits and repaints one on the way back.
            `autoFocus={false}` because these mount in the background too — the caret
            arrives only on the explicit gesture that names the shell (R5). */}
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
              /* R5 — a shell takes the caret only when the request NAMES it. Handing the
                 bare counter to every body made the request answerable by any of them, so
                 a body merely becoming active again (switching back to a session whose
                 panel is on a terminal tab) re-read the stale value and stole the caret
                 from the Claude TUI the click had asked for. */
              focusSignal={termFocus.ptyId === tab.id ? termFocus.n : 0}
            />
          </div>
        ))}

        {/* One artifact per visited `file` tab of the session on screen, hidden the same
            way for the same reason: `display:none` has no layout box, so the scroll
            position the tab is supposed to keep would be reset on every switch. */}
        {fileTabs.map((t) => (
          <div
            key={t.id}
            className="wb-host"
            style={{ visibility: t.id === set.activeId ? undefined : 'hidden' }}
          >
            {ownerTab && editing[t.id] && getEntry(ownerTab, t.id) ? (
              /* B-30 — hidden with `visibility` like every other tab body, so switching
                 tabs keeps the text, the caret and the undo history: the node is never
                 unmounted and never re-created. */
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
                /* SEC-6: the blow-up's state stays here (FR-54's ladder consumes it at panel
                 level), while the `<img>` that paints it lives in the artifact layer — the
                 chrome around a guest may not render an image at all. Only the active pane
                 is handed one, so a background tab never paints a stale overlay. */
                zoom={t.id === set.activeId ? zoom : null}
                onCloseZoom={closeZoom}
                onOutlineClose={closeOutline}
                onClose={close}
                /* B-14/B-14b — a buffer with unsaved text IS this file as far as the panel is
                 concerned: Source shows it, marked, instead of the older bytes on disk, and
                 the artifact does not read the file a second time behind the editor's back. */
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

        {/* FR-38…FR-49 — the pinned tab's content. Mounted unconditionally and hidden the
            same way the artifacts are: the Changes stream's scroll position is the thing a
            `display:none` round-trip would silently reset, and FR-58 promises it survives
            an in-place update, let alone a tab switch. */}
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
            /* only the surface on screen may paint the blow-up, exactly as for a `file`
               tab — a hidden Files body must not hold a stale overlay */
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
