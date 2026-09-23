import type { HintId, SessionStatus } from '@shared/types'

export interface HintSnapshot {
  activeTabId: string | null
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
  selector: string
}

export interface ActiveHint extends HintFire {
  n: number
  onDone: () => void
  onOff: () => void
}

const WORKBENCH_TOGGLE = '.aux-ico.wb-toggle'

export function rowSelector(tabId: string): string {
  return `.ws-tab[data-tab-id="${tabId}"]`
}

export function wbTabSelector(tabId: string): string {
  return `.wb-tab[data-wb-tab-id="${tabId}"]`
}

export function selectorOf(h: HintFire, panelShown: boolean): string {
  return h.id === 'agent-web' && !panelShown ? WORKBENCH_TOGGLE : h.selector
}

function rowTabId(s: HintSnapshot, rowId: string): string {
  return s.sessions.find((x) => x.sessionId === rowId && x.alive)?.tabId ?? rowId
}

export function firedHints(prev: HintSnapshot, next: HintSnapshot): HintFire[] {
  const out: HintFire[] = []

  const active = next.sessions.find((s) => s.tabId === next.activeTabId)
  if (active) {
    const before = prev.sessions.find((s) => s.tabId === next.activeTabId)
    if ((active.liveWrites ?? 0) > (before?.liveWrites ?? 0)) {
      out.push({ id: 'workbench', selector: WORKBENCH_TOGGLE })
    }
  }

  const opened = next.agentOpen
  if (opened && opened.nonce !== prev.agentOpen?.nonce && opened.ownerTabId === next.activeTabId) {
    out.push({ id: 'agent-web', selector: wbTabSelector(opened.tabId) })
  }

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
