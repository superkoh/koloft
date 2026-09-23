import type { SessionBackend } from './agentUi'
import type { ParkedItem, SessionInfo, SessionStatus, TabKind, WorkspaceRows } from '@shared/types'
import { NOTES_HEIGHT_FLOOR } from '@shared/settingsOps'

export function relTime(mtimeMs: number, nowMs: number): string {
  const s = Math.floor(Math.max(0, nowMs - mtimeMs) / 1000)
  if (s >= 86400) return `${Math.floor(s / 86400)}d ago`
  if (s >= 3600) return `${Math.floor(s / 3600)}h ago`
  if (s >= 60) return `${Math.floor(s / 60)}m ago`
  return `${s}s ago`
}

function shortDur(ms: number): string {
  const m = Math.floor(ms / 60_000)
  if (m >= 60) return `${Math.floor(m / 60)}h`
  return m >= 1 ? `${m}m` : '<1m'
}

export function parkedBadge(
  items: ParkedItem[],
  backend?: SessionBackend
): { text: string; lines: string[]; hint: string } {
  let n = 0
  const lines = items.map((p) => {
    if (p.kind === 'teammate') {
      const k = parseInt(p.label, 10) || 1
      n += k
      return `${k} teammate${k === 1 ? '' : 's'} idle`
    }
    n += 1
    if (p.kind === 'monitor') return `monitor · ${p.label}`
    return `server · ${p.label}` + (p.ageMs === undefined ? '' : ` · running ${shortDur(p.ageMs)}`)
  })
  return {
    text: `⏸ ${n}`,
    lines,
    hint:
      backend === 'codex'
        ? 'Stop these tasks in the Codex session to free the resources.'
        : 'Stop them in the session (ctrl+b lists background tasks) to free the resources.'
  }
}

export function sessionActivityBadge(
  session?: Pick<SessionInfo, 'parked' | 'background' | 'backendId' | 'observation'>
): (ReturnType<typeof parkedBadge> & { heading: string }) | null {
  if (session?.observation === 'degraded')
    return {
      text: '?',
      heading: 'Status unavailable',
      lines: ['Live status is unavailable; the session may still be running.'],
      hint: 'Check the terminal for its current state.'
    }
  const parked = session?.parked?.length ? parkedBadge(session.parked, session.backendId) : null
  const background = session?.background ?? []
  if (!background.length)
    return parked ? { ...parked, heading: `${parked.text} parked · not working` } : null
  const unknown = background.some((item) => item.state === 'unknown')
  const working = background.some((item) => item.state === 'working')
  const lines = background.map(
    (item) =>
      `${item.kind === 'agent' ? 'agent' : 'command'} · ${item.label} · ${item.state === 'unknown' ? 'state unknown' : item.state}`
  )
  return {
    text: `${working ? '↻' : unknown ? '?' : '⏸'} ${background.length}${parked ? ` ${parked.text}` : ''}`,
    heading: 'Background activity',
    lines: [...lines, ...(parked?.lines ?? [])],
    hint: unknown
      ? 'Unknown activity may still be running. Check the session before stopping it.'
      : 'Manage these tasks in the session.'
  }
}

export function rowStateClass(
  running: boolean,
  status: SessionStatus | undefined,
  pending?: boolean
): string {
  if (pending) return 'st-pending'
  if (!running) return 'cold'
  switch (status) {
    case 'working':
      return 'st-working'
    case 'waiting':
      return 'st-waiting'
    case 'approval':
      return 'st-approval'
    default:
      return 'st-idle'
  }
}

export function isOrphanRow(
  row: { id: string; running: boolean },
  sessions: { sessionId: string; tabId: string; alive: boolean }[],
  tabs: { id: string; sessionId?: string; alive: boolean }[]
): boolean {
  if (!row.running) return false
  const bound = sessions.find((s) => s.sessionId === row.id && s.alive)?.tabId
  return !tabs.some((t) => t.alive && (t.id === bound || t.sessionId === row.id))
}

export function mixesBackends(rows: { backendId?: SessionBackend }[]): boolean {
  return new Set(rows.map((r) => r.backendId ?? 'claude')).size > 1
}

const MARQUEE_SPEED_PX_S = 60
const MARQUEE_START_MS = 500
const MARQUEE_TAIL_MS = 700
const MARQUEE_MIN_SCROLL_MS = 600

type MarqueeFrame = { transform: string; offset: number }
type MarqueeTiming = { duration: number; delay: number; easing: string; iterations: number }

export function marqueeAnim(
  overflowPx: number
): { frames: MarqueeFrame[]; timing: MarqueeTiming } | null {
  if (!(overflowPx > 0)) return null
  const scrollMs = Math.max(MARQUEE_MIN_SCROLL_MS, (overflowPx / MARQUEE_SPEED_PX_S) * 1000)
  const duration = scrollMs + MARQUEE_TAIL_MS
  const end = `translateX(${-overflowPx}px)`
  return {
    frames: [
      { transform: 'translateX(0px)', offset: 0 },
      { transform: end, offset: scrollMs / duration },
      { transform: end, offset: 1 }
    ],
    timing: { duration, delay: MARQUEE_START_MS, easing: 'linear', iterations: Infinity }
  }
}

export function welcomeTarget(
  rows: WorkspaceRows[],
  lastPath: string | null
): WorkspaceRows | null {
  const live = rows.filter((w) => !w.workspace.missing)
  return live.find((w) => w.workspace.path === lastPath) ?? live[0] ?? null
}

export function currentWorkspace(
  rows: WorkspaceRows[],
  rowId: string | null,
  selectedWs: string | null,
  lastWsPath: string | null
): string | null {
  const live = rows.filter((w) => !w.workspace.missing)
  if (rowId) {
    const owner = live.find((w) => w.rows.some((r) => r.id === rowId))
    if (owner) return owner.workspace.path
  }
  if (selectedWs && live.some((w) => w.workspace.path === selectedWs)) return selectedWs
  return welcomeTarget(rows, lastWsPath)?.workspace.path ?? null
}

export function welcomeQuietLine(running: number): string {
  if (running < 1) return 'No running session'
  if (running === 1) return '1 session running — pick one on the left'
  return `${running} sessions running — pick one on the left`
}

export function selectionRoot(
  tab: { kind: TabKind; cwd: string } | undefined,
  sessionRoot: string | undefined,
  welcomePath: string | undefined
): string | null {
  if (tab?.kind === 'claude') return sessionRoot ?? tab.cwd
  return welcomePath ?? null
}

const TUI_MIN_WIDTH_PX = 360
const TUI_CHROME_PX = 20

export function paneWidthFromDrag(
  paneRight: number,
  dockRight: number,
  clientX: number,
  floor = 320
): number {
  const ceiling = paneRight - dockRight - TUI_MIN_WIDTH_PX - TUI_CHROME_PX
  return Math.min(Math.max(floor, paneRight - clientX), ceiling)
}

export const SESSIONS_MIN_HEIGHT = 160

export const DOCK_GUTTER_PX = 10

export function clampNotesHeight(
  saved: number,
  dockHeight: number,
  floor = NOTES_HEIGHT_FLOOR
): number {
  const ceiling = Math.max(floor, dockHeight - SESSIONS_MIN_HEIGHT - DOCK_GUTTER_PX)
  return Math.min(Math.max(floor, saved), ceiling)
}

export function notesHeightFromDrag(
  dockBottom: number,
  dockHeight: number,
  clientY: number,
  floor = NOTES_HEIGHT_FLOOR
): number {
  return clampNotesHeight(dockBottom - clientY, dockHeight, floor)
}
