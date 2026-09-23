import type { HintId, SessionStatus } from '@shared/types'

/**
 * Layer B — which contextual hint a store change earns.
 *
 * Kept apart from the hook so the decision is a plain function of two snapshots: every
 * trigger is a TRANSITION (a file just written, a page just opened, a row just turned
 * amber, a second Claude just started working), and a transition cannot be read off one
 * snapshot.
 */
export interface HintSnapshot {
  activeTabId: string | null
  /** the panel on screen is showing the GitHub button */
  githubBtn: boolean
  agentOpen: { ownerTabId: string; tabId: string; nonce: number } | null
  sessions: {
    tabId: string
    sessionId?: string
    alive?: boolean
    status?: SessionStatus
    liveWrites?: number
  }[]
  rows: {
    workspace: { path: string }
    rows: { id: string; worktree: string; running: boolean; pending?: boolean }[]
  }[]
}

export interface HintFire {
  id: HintId
  /** CSS selector for the element the card points at, resolved at show time */
  selector: string
}

/** The one card on screen, as the hook hands it to `Hint`. */
export interface ActiveHint extends HintFire {
  /** how many tips the user has now seen — the `tip N of 4` counter */
  n: number
  onDone: () => void
  onOff: () => void
}

const WORKBENCH_TOGGLE = '.aux-ico.wb-toggle'

/** A sidebar row, by the tab it belongs to — `data-tab-id` is the one id that survives
 *  the `pending` row being replaced by the bound one. */
export function rowSelector(tabId: string): string {
  return `.ws-tab[data-tab-id="${tabId}"]`
}

/** A Workbench tab, by its own id: the `agent` (unread) class is gone the moment the tab
 *  is activated, and matches the wrong tab while it is there. */
export function wbTabSelector(tabId: string): string {
  return `.wb-tab[data-wb-tab-id="${tabId}"]`
}

/** The one anchor that moves while its card is up: expanding the panel puts the Browser
 *  tab the page landed in on screen, so the card points at it instead of at the toggle
 *  that would reveal it. */
export function selectorOf(h: HintFire, panelShown: boolean): string {
  return h.id === 'agent-web' && !panelShown ? WORKBENCH_TOGGLE : h.selector
}

/** The sidebar's own rule (WorkspaceSidebar's `tabIdFor`): a pending row's id already IS
 *  its pty tab, a running one reaches its tab through the bound session id. */
function rowTabId(s: HintSnapshot, rowId: string): string {
  return s.sessions.find((x) => x.sessionId === rowId && x.alive)?.tabId ?? rowId
}

/** Every hint the step from `prev` to `next` earns, in the order they are queued. */
export function firedHints(prev: HintSnapshot, next: HintSnapshot): HintFire[] {
  const out: HintFire[] = []

  const active = next.sessions.find((s) => s.tabId === next.activeTabId)
  // `liveWrites` counts only writes the tracker saw happen (a resume's replayed history
  // never moves it), and a short turn can end in the same push the write arrives in,
  // so the session's status says nothing here.
  if (active) {
    const before = prev.sessions.find((s) => s.tabId === next.activeTabId)
    if ((active.liveWrites ?? 0) > (before?.liveWrites ?? 0)) {
      out.push({ id: 'workbench', selector: WORKBENCH_TOGGLE })
    }
  }

  // The shim's `open <url>` built a Browser tab — the store's one trace of an agent open.
  // Only when it landed in the session ON SCREEN: the card points at that session's
  // Workbench, so anywhere else it would be pointing at the wrong thing.
  const opened = next.agentOpen
  if (opened && opened.nonce !== prev.agentOpen?.nonce && opened.ownerTabId === next.activeTabId) {
    out.push({ id: 'agent-web', selector: wbTabSelector(opened.tabId) })
  }

  // the GitHub button just appeared in the panel the user is looking at. It is a
  // small piece of chrome with a right-click menu behind it, so it earns one card saying
  // so. The store field is only ever set while the panel is SHOWING, which is the whole
  // of "the user can see it".
  if (next.githubBtn && !prev.githubBtn) {
    out.push({ id: 'github', selector: '.wb-gh' })
  }

  const amber = next.sessions.find(
    (s) =>
      s.status === 'approval' &&
      s.tabId !== next.activeTabId &&
      prev.sessions.find((p) => p.tabId === s.tabId)?.status !== 'approval'
  )
  if (amber) out.push({ id: 'approval', selector: rowSelector(amber.tabId) })

  // A second Claude starts working in a folder that already has one, by ANY path: a
  // ⌘N launch (a `pending` row), a launch whose hook bound before the first emit (a
  // `running` placeholder, never pending) and a resumed cold row (its own id all along)
  // all read the same way — this row is live now and was not a step ago. Only a row on
  // the MAIN checkout can step on another's files; a worktree row is the cure, not the
  // problem. One card per id is the queue's job, not this function's.
  for (const ws of next.rows) {
    const before = prev.rows.find((w) => w.workspace.path === ws.workspace.path)
    if (!before) continue
    const started = ws.rows.find((r) => {
      if (r.worktree !== 'main' || !(r.running || r.pending)) return false
      const was = before.rows.find((b) => b.id === r.id)
      return !was?.running && !was?.pending
    })
    if (started && before.rows.some((b) => b.id !== started.id && b.running)) {
      out.push({ id: 'worktree', selector: rowSelector(rowTabId(next, started.id)) })
      break
    }
  }

  return out
}
