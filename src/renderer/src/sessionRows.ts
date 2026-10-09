import { isSessionKind, type SessionBackend } from './agentUi'
import type {
  AttentionEvent,
  BackgroundItem,
  LeftoverProcess,
  SessionInfo,
  SessionStatus,
  TabKind,
  WorkspaceRows
} from '@shared/types'
import { PLACEHOLDER_SESSION_TITLE } from '@shared/types'
import { NOTES_HEIGHT_FLOOR } from '@shared/settingsOps'
import { statusUnavailable } from '@shared/sessionBackend'

export { statusUnavailable }

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

export function leftoverLabel(p: LeftoverProcess): string {
  return p.command.replace(/^\S*\//, '')
}

const PARKED_KINDS: ReadonlySet<BackgroundItem['kind']> = new Set(['server', 'monitor', 'teammate'])

export function parkedBadge(
  items: Pick<BackgroundItem, 'kind' | 'label' | 'ageMs'>[],
  backend?: SessionBackend,
  leftovers: LeftoverProcess[] = []
): { text: string; lines: string[]; hint: string } {
  let n = leftovers.length
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
  lines.push(...leftovers.map((p) => `left running · ${leftoverLabel(p)}`))
  return {
    text: `⏸ ${n}`,
    lines,
    hint: leftovers.length
      ? 'Programs this session started keep running on their own. Stop any you no longer need.'
      : backend === 'codex'
        ? 'Stop these tasks in the Codex session to free the resources.'
        : 'Stop them in the session (ctrl+b lists background tasks) to free the resources.'
  }
}

export function sessionActivityBadge(
  session?: Pick<SessionInfo, 'background' | 'backendId' | 'details' | 'turnOver'>,
  leftovers: LeftoverProcess[] = []
): (ReturnType<typeof parkedBadge> & { heading: string; running?: boolean }) | null {
  if (statusUnavailable(session))
    return {
      text: '?',
      heading: 'Status unavailable',
      lines: ['Live status is unavailable; the session may still be running.'],
      hint: 'Check the terminal for its current state.'
    }
  const all = session?.background ?? []
  const parkedItems = all.filter((item) => PARKED_KINDS.has(item.kind))
  const background = all.filter((item) => !PARKED_KINDS.has(item.kind))
  const parked =
    parkedItems.length || leftovers.length
      ? parkedBadge(parkedItems, session?.backendId, leftovers)
      : null
  if (!background.length)
    return parked ? { ...parked, heading: `${parked.text} parked · not working` } : null
  const unknown = background.some((item) => item.state === 'unknown')
  const working = background.some((item) => item.state === 'working')
  const lines = background.map(
    (item) =>
      `${item.kind === 'agent' ? 'agent' : 'command'} · ${item.label} · ${item.state === 'unknown' ? 'state unknown' : item.state}`
  )
  const afterTurn = working && !!session?.turnOver
  return {
    text: `${working ? '↻' : unknown ? '?' : '⏸'} ${background.length}${parked ? ` ${parked.text}` : ''}`,
    heading: afterTurn ? 'Turn done · still running' : 'Background activity',
    lines: [...lines, ...(parked?.lines ?? [])],
    hint: unknown
      ? 'Unknown activity may still be running. Check the session before stopping it.'
      : afterTurn
        ? 'This turn is over and you can type. The work above keeps going.'
        : 'Manage these tasks in the session.',
    running: working
  }
}

export function rowStateClass(
  running: boolean,
  status: SessionStatus | undefined,
  pending?: boolean,
  turnOver?: boolean
): string {
  if (pending) return 'st-pending'
  if (!running) return 'cold'
  switch (status) {
    case 'working':
      return turnOver ? 'st-waiting' : 'st-working'
    case 'waiting':
      return 'st-waiting'
    case 'approval':
      return 'st-approval'
    default:
      return 'st-idle'
  }
}

export function sessionsNeedYou(n: number): string {
  return n > 1 ? `${n} sessions need you` : '1 session needs you'
}

export function sessionsInside(n: number): string {
  return n > 1 ? `${n} sessions inside` : '1 session inside'
}

export interface RowNode<R extends { id: string; parentId?: string }> {
  row: R
  children: RowNode<R>[]
}

function leadsBackToItself<R extends { id: string; parentId?: string }>(
  row: R,
  nodes: Map<string, RowNode<R>>
): boolean {
  const seen = new Set<string>()
  for (let at = row.parentId; at !== undefined && !seen.has(at); at = nodes.get(at)?.row.parentId) {
    if (at === row.id) return true
    seen.add(at)
  }
  return false
}

export function sessionTree<R extends { id: string; parentId?: string }>(rows: R[]): RowNode<R>[] {
  const nodes = new Map(rows.map((row) => [row.id, { row, children: [] as RowNode<R>[] }]))
  const roots: RowNode<R>[] = []
  for (const node of nodes.values()) {
    const parent = node.row.parentId ? nodes.get(node.row.parentId) : undefined
    if (parent && !leadsBackToItself(node.row, nodes)) parent.children.push(node)
    else roots.push(node)
  }
  return roots
}

export function rowsUnder<R extends { id: string; parentId?: string }>(node: RowNode<R>): R[] {
  return node.children.flatMap((child) => [child.row, ...rowsUnder(child)])
}

export function attentionOnRow(
  rowId: string,
  tabId: string | undefined,
  pending: AttentionEvent[]
): AttentionEvent | undefined {
  return pending.find((e) => e.sessionId === rowId || e.tabId === tabId)
}

// CODEX§9
export function liveTabOf(
  sessionId: string,
  sessions: readonly { sessionId: string; tabId: string; alive: boolean }[],
  tabs: readonly { id: string; sessionId?: string; alive: boolean }[]
): string | undefined {
  return (
    sessions.find((s) => s.sessionId === sessionId && s.alive)?.tabId ??
    tabs.find((t) => t.alive && t.sessionId === sessionId)?.id
  )
}

export function tabOfRow(
  row: { id: string; running: boolean; pending?: boolean },
  sessions: readonly { sessionId: string; tabId: string; alive: boolean }[],
  tabs: readonly { id: string; sessionId?: string; alive: boolean }[]
): string | undefined {
  if (row.pending) return row.id
  return row.running ? liveTabOf(row.id, sessions, tabs) : undefined
}

export function shownTitle(rowTitle: string, liveTitle: string | undefined): string {
  return liveTitle && liveTitle !== PLACEHOLDER_SESSION_TITLE ? liveTitle : rowTitle
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

export function mixesBackends(rows: { backendId: SessionBackend }[]): boolean {
  return new Set(rows.map((r) => r.backendId)).size > 1
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

function workspaceOfRow(rows: WorkspaceRows[], rowId: string): string | null {
  return (
    rows.find((w) => !w.workspace.missing && w.rows.some((r) => r.id === rowId))?.workspace.path ??
    null
  )
}

export const rowIdOfTab = (sessions: readonly SessionInfo[], tabId: string): string =>
  sessions.find((s) => s.tabId === tabId)?.sessionId ?? tabId

export function workspaceOfTab(
  rows: WorkspaceRows[],
  sessions: readonly SessionInfo[],
  tabId: string
): string | null {
  return workspaceOfRow(rows, rowIdOfTab(sessions, tabId))
}

export function currentWorkspace(
  rows: WorkspaceRows[],
  rowId: string | null,
  selectedWs: string | null,
  lastWsPath: string | null
): string | null {
  const owner = rowId ? workspaceOfRow(rows, rowId) : null
  if (owner) return owner
  const live = rows.filter((w) => !w.workspace.missing)
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
  if (tab && isSessionKind(tab.kind)) return sessionRoot ?? tab.cwd
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

export const PREVIEW_CARD_WIDTH_PX = 264
const CENTER_ROW_RIGHT_PADDING_PX = 10

export function previewCardFits(centerWidth: number): boolean {
  return (
    centerWidth - CENTER_ROW_RIGHT_PADDING_PX - PREVIEW_CARD_WIDTH_PX >=
    TUI_MIN_WIDTH_PX + TUI_CHROME_PX
  )
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
