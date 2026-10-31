import { isSessionKind, type SessionBackend } from './agentUi'
import type {
  AttentionEvent,
  BackgroundItem,
  LeftoverProcess,
  SessionInfo,
  SessionRow,
  SessionStatus,
  TabKind,
  WorkspaceRows
} from '@shared/types'
import { PLACEHOLDER_SESSION_TITLE, PLAN_READY } from '@shared/types'
import { basename } from '@shared/preview'
import { NOTES_HEIGHT_FLOOR } from '@shared/settingsOps'
import { statusUnavailable } from '@shared/sessionBackend'
import { isWorkspaceWorkbenchKey, workspaceOfWorkbenchKey } from '@shared/workbenchState'
import { everyWorkspaceRows } from './butlerRows'

export { statusUnavailable }

export function relTime(mtimeMs: number, nowMs: number): string {
  const s = Math.floor(Math.max(0, nowMs - mtimeMs) / 1000)
  if (s >= 86400) return `${Math.floor(s / 86400)}d ago`
  if (s >= 3600) return `${Math.floor(s / 3600)}h ago`
  if (s >= 60) return `${Math.floor(s / 60)}m ago`
  return `${s}s ago`
}

export function shortDur(ms: number): string {
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
        : backend === 'muse'
          ? 'Stop them in the Muse session (/tasks lists them) to free the resources.'
          : backend === 'agy'
            ? 'Stop them in the Antigravity session (/tasks lists them) to free the resources.'
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
      return turnOver ? 'st-waiting st-bg-run' : 'st-working'
    case 'waiting':
      return 'st-waiting'
    case 'approval':
      return 'st-approval'
    default:
      return 'st-idle'
  }
}

export function rowActivityLine(
  shownCls: string,
  session?: Pick<SessionInfo, 'lastAction' | 'asking'>
): string | undefined {
  if (!session || !shownCls.startsWith('st-') || shownCls === 'st-pending') return undefined
  if (shownCls === 'st-approval' && session.asking) return session.asking
  const did = session.lastAction
  if (!did || shownCls === 'st-working' || did === PLAN_READY) return did
  return `Last: ${did}`
}

export function sessionsNeedYou(n: number): string {
  return n > 1 ? `${n} sessions need you` : '1 session needs you'
}

export function sessionsInside(n: number): string {
  return n > 1 ? `${n} sessions inside` : '1 session inside'
}

export const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

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

function markOn(
  e: AttentionEvent,
  tabId: string | undefined,
  sessionId: string | undefined
): boolean {
  return e.tabId === tabId || (!!sessionId && e.sessionId === sessionId)
}

export function waitingTabs(
  pending: readonly AttentionEvent[],
  tabs: readonly { id: string; sessionId?: string }[]
): string[] {
  const waiting: string[] = []
  for (const e of [...pending].sort((a, b) => a.at - b.at)) {
    const tab = tabs.find((t) => markOn(e, t.id, t.sessionId))
    if (tab && !waiting.includes(tab.id)) waiting.push(tab.id)
  }
  return waiting
}

export function nextWaitingTab(
  pending: readonly AttentionEvent[],
  activeTabId: string | null,
  tabs: readonly { id: string; sessionId?: string }[]
): string | undefined {
  const waiting = waitingTabs(pending, tabs)
  return waiting[(waiting.indexOf(activeTabId ?? '') + 1) % waiting.length]
}

export function liveTabOf(
  sessionId: string,
  sessions: readonly { sessionId: string; tabId: string; alive: boolean }[],
  tabs: readonly { id: string; sessionId?: string; alive: boolean; asleep?: true }[]
): string | undefined {
  return rowLookups(sessions, tabs, []).tabOf({ id: sessionId, running: true })
}

export function shownTitle(rowTitle: string, liveTitle: string | undefined): string {
  return liveTitle && liveTitle !== PLACEHOLDER_SESSION_TITLE ? liveTitle : rowTitle
}

export function workspaceName(ws: WorkspaceRows['workspace']): string {
  return basename(ws.remote?.path ?? ws.path)
}

export function workspacePlace(ws: WorkspaceRows['workspace']): string {
  const name = workspaceName(ws)
  return ws.remote ? `${ws.remote.host}:${name}` : name
}

export function isOrphanRow(
  row: { id: string; running: boolean },
  sessions: { sessionId: string; tabId: string; alive: boolean }[],
  tabs: { id: string; sessionId?: string; alive: boolean; asleep?: true }[]
): boolean {
  if (!row.running) return false
  const bound = sessions.find((s) => s.sessionId === row.id && s.alive)?.tabId
  return !tabs.some(
    (t) =>
      (t.alive && (t.id === bound || t.sessionId === row.id)) ||
      (t.asleep && t.sessionId === row.id)
  )
}

interface RowLookups<S> {
  running: (row: { id: string; running: boolean }) => boolean
  boundTabOf: (sessionId: string) => string | undefined
  tabOf: (row: { id: string; running: boolean; pending?: boolean }) => string | undefined
  sessionOn: (tabId: string) => S | undefined
  attentionOn: (rowId: string, tabId: string | undefined) => AttentionEvent | undefined
  hasAliveTab: (sessionId: string) => boolean
}

// CODEX§9
export function rowLookups<S extends { sessionId: string; tabId: string; alive: boolean }>(
  sessions: readonly S[],
  tabs: readonly { id: string; sessionId?: string; alive: boolean; asleep?: true }[],
  attention: readonly AttentionEvent[]
): RowLookups<S> {
  const firstBy = <T, K>(items: readonly T[], key: (item: T) => K | undefined): Map<K, T> => {
    const m = new Map<K, T>()
    for (const item of items) {
      const k = key(item)
      if (k !== undefined && !m.has(k)) m.set(k, item)
    }
    return m
  }
  const sessionOnTab = firstBy(sessions, (s) => s.tabId)
  const liveTabOfSession = firstBy(sessions, (s) => (s.alive ? s.sessionId : undefined))
  const openTabOfSession = firstBy(tabs, (t) => (t.alive || t.asleep ? t.sessionId : undefined))
  const aliveTabSessions = new Set(tabs.filter((t) => t.alive).map((t) => t.sessionId))
  const aliveTabIds = new Set(tabs.filter((t) => t.alive).map((t) => t.id))
  const boundInAliveTab = firstBy(sessions, (s) =>
    s.alive && aliveTabIds.has(s.tabId) ? s.sessionId : undefined
  )
  const boundTabOf = (sessionId: string): string | undefined =>
    boundInAliveTab.get(sessionId)?.tabId
  return {
    running: (row) => row.running || !!boundTabOf(row.id),
    boundTabOf,
    tabOf: (row) => {
      if (row.pending) return row.id
      const bound = boundTabOf(row.id)
      if (bound || !row.running) return bound
      return liveTabOfSession.get(row.id)?.tabId ?? openTabOfSession.get(row.id)?.id
    },
    sessionOn: (tabId) => sessionOnTab.get(tabId),
    attentionOn: (rowId, tabId) => attention.find((e) => markOn(e, tabId, rowId)),
    hasAliveTab: (sessionId) => aliveTabSessions.has(sessionId)
  }
}

interface EndedTab {
  id: string
  title: string
  sessionId?: string
  ended?: { row: SessionRow; wsPath: string }
}

type Ended<T extends EndedTab> = T & { ended: NonNullable<T['ended']> }

const isEnded = <T extends EndedTab>(t: T): t is Ended<T> => !!t.ended

type LiveSession = { sessionId: string; tabId: string; alive: boolean }

const liveElsewhere = (t: EndedTab, sessions: readonly LiveSession[]): boolean =>
  !!t.sessionId && sessions.some((s) => s.alive && s.sessionId === t.sessionId && s.tabId !== t.id)

export function endedTabOf<T extends EndedTab>(
  row: { id: string },
  tabs: readonly T[],
  sessions: readonly LiveSession[]
): Ended<T> | undefined {
  const ended = tabs.find(
    (t): t is Ended<T> => isEnded(t) && (t.id === row.id || t.sessionId === row.id)
  )
  return ended && !liveElsewhere(ended, sessions) ? ended : undefined
}

export function endedTabsLiveElsewhere<T extends EndedTab>(
  tabs: readonly T[],
  sessions: readonly LiveSession[]
): Ended<T>[] {
  return tabs.filter((t): t is Ended<T> => isEnded(t) && liveElsewhere(t, sessions))
}

export function withEndedRows(all: WorkspaceRows[], tabs: readonly EndedTab[]): WorkspaceRows[] {
  const ended = tabs.filter(isEnded)
  if (!ended.length) return all
  const shown = new Set(all.flatMap((w) => w.rows.map((r) => r.id)))
  const lost = ended.filter(
    (t) => ![t.id, t.sessionId, t.ended.row.id].some((id) => id !== undefined && shown.has(id))
  )
  if (!lost.length) return all
  return all.map((w) => {
    const here = lost.filter((t) => t.ended.wsPath === w.workspace.path)
    if (!here.length) return w
    const kept = here.map(({ title, ended: { row } }): SessionRow => ({
      ...row,
      title: row.pending ? title : row.title,
      running: false,
      pending: false
    }))
    return { ...w, rows: [...kept, ...w.rows] }
  })
}

export function shownRows(s: {
  workspaceRows: WorkspaceRows[]
  butlerWorkspace: WorkspaceRows | null
  tabs: readonly EndedTab[]
}): { workspaceRows: WorkspaceRows[]; butlerWorkspace: WorkspaceRows | null } {
  const every = everyWorkspaceRows(s)
  const all = withEndedRows(every, s.tabs)
  if (all === every) return { workspaceRows: s.workspaceRows, butlerWorkspace: s.butlerWorkspace }
  return s.butlerWorkspace
    ? { workspaceRows: all.slice(0, -1), butlerWorkspace: all[all.length - 1] }
    : { workspaceRows: all, butlerWorkspace: null }
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

export function workspaceOfRow(rows: WorkspaceRows[], rowId: string): string | null {
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
  if (isWorkspaceWorkbenchKey(tabId)) return workspaceOfWorkbenchKey(tabId)
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
