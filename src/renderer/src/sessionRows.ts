import type { SessionBackend } from './agentUi'
import type { ParkedItem, SessionInfo, SessionStatus, TabKind, WorkspaceRows } from '@shared/types'
import { NOTES_HEIGHT_FLOOR } from '@shared/settingsOps'

/** Relative age for a cold row's menu header / tooltip (`2d ago`). */
export function relTime(mtimeMs: number, nowMs: number): string {
  const s = Math.floor(Math.max(0, nowMs - mtimeMs) / 1000)
  if (s >= 86400) return `${Math.floor(s / 86400)}d ago`
  if (s >= 3600) return `${Math.floor(s / 3600)}h ago`
  if (s >= 60) return `${Math.floor(s / 60)}m ago`
  return `${s}s ago`
}

/** A running time for the parked badge (`3h`, `12m`, `<1m`). */
function shortDur(ms: number): string {
  const m = Math.floor(ms / 60_000)
  if (m >= 60) return `${Math.floor(m / 60)}h`
  return m >= 1 ? `${m}m` : '<1m'
}

/**
 * The C2 row's parked badge (SessionInfo.parked): what the session keeps open
 * without working on it — a server, a Monitor, teammates idle between messages.
 * These never count as 'working' (product decision); the badge is how
 * the user learns they are there, and the card behind it names each so it can be
 * released. Text is the count; a teammate entry counts as many.
 */
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

/** The C2 row's state class: running rows map their run-state onto a lightbar
 *  class; a bound-but-statusless session reads as idle (logic.md §4); cold rows
 *  carry no bar at all. A pending launch outranks both — it has no session bound
 *  yet, so `running` is false while the row is anything but cold. */
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

/**
 * F7: a running row this renderer cannot open. A reload now re-adopts
 * main's live ptys as tabs, so this is the FALLBACK state — adoption suppressed
 * (test seam), failed, or a pty the inventory could not offer — plus the sub-second
 * boot window before the inventory lands (which is why the confirm that consumes
 * this verdict awaits adoptionSettled). Both links to a tab are consulted and
 * neither may be assumed fresh: the sessions stream is push-only (empty until the
 * tracker's next update), and the tabId it carries may name a tab this renderer
 * does not have — activateTab on an unknown id is a silent no-op. So reachability
 * is decided against the tabs that are actually here.
 */
export function isOrphanRow(
  row: { id: string; running: boolean },
  sessions: { sessionId: string; tabId: string; alive: boolean }[],
  tabs: { id: string; sessionId?: string; alive: boolean }[]
): boolean {
  if (!row.running) return false
  const bound = sessions.find((s) => s.sessionId === row.id && s.alive)?.tabId
  return !tabs.some((t) => t.alive && (t.id === bound || t.sessionId === row.id))
}

/** D2: the method icon earns its width only where one workspace lists both kinds of
 *  session. One icon on every row of a Claude-only workspace says nothing, and a lone
 *  icon with nothing to contrast against cannot be read at all. */
export function mixesBackends(rows: { backendId?: SessionBackend }[]): boolean {
  return new Set(rows.map((r) => r.backendId ?? 'claude')).size > 1
}

/** Constant scroll speed for the C2 marquee: the distance is whatever the title
 *  actually overflows, so the duration has to follow it — a fixed duration would
 *  crawl through a short overflow and race through a long one. */
const MARQUEE_SPEED_PX_S = 60
/** Hover lead-in before the title starts moving (design.html C2). */
const MARQUEE_START_MS = 500
/** Hold at the tail before the loop snaps back to the truncated start. */
const MARQUEE_TAIL_MS = 700
/** A 20px overflow still needs long enough to register as motion, not a twitch. */
const MARQUEE_MIN_SCROLL_MS = 600

type MarqueeFrame = { transform: string; offset: number }
type MarqueeTiming = { duration: number; delay: number; easing: string; iterations: number }

/** The C2 hover marquee, measured: scroll exactly `overflowPx` (= the title's
 *  `calc(-100% + row width)`) at a constant speed, hold 0.7s, loop. Null when the
 *  title fits — a non-overflowing title never animates. */
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

/** Which workspace the S4 welcome panel (and its ＋ New session) targets: the last
 *  one whose session was selected in this run, else the first pinned one — nothing
 *  about the selection is persisted, so a restart always lands on the array head
 *  (O2/A10). A vanished folder can't host a new session, so it never wins. */
export function welcomeTarget(
  rows: WorkspaceRows[],
  lastPath: string | null
): WorkspaceRows | null {
  const live = rows.filter((w) => !w.workspace.missing)
  return live.find((w) => w.workspace.path === lastPath) ?? live[0] ?? null
}

/**
 * D2 — the workspace the window is IN right now, which is the workspace whose note
 * the Notes island shows.
 *
 * One rule covers both doors, which is the whole reason a workspace head became pickable
 * (D7). A session is picked: its workspace is the sidebar group that lists its row — and
 * a worktree session is listed under its PARENT workspace, so this lands on the parent,
 * which is where that note belongs. Nothing is picked: it is the workspace the user
 * chose by clicking its head, and failing that the one the welcome panel already points
 * at, so the island never goes blank while a workspace is on screen.
 *
 * `rowId` is the picked session's id — or, while a launch is still in flight, the
 * launching pty's tab id, the other name a sidebar row can carry. A vanished folder never
 * wins: there is no folder left to keep a note beside.
 */
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

/** D7 — the quiet line under the welcome panel's big workspace name. Picking a
 *  workspace head leaves its sessions running with none of them picked, so the panel has
 *  to say they are still there and where to go, instead of claiming nothing is running. */
export function welcomeQuietLine(running: number): string {
  if (running < 1) return 'No running session'
  if (running === 1) return '1 session running — pick one on the left'
  return `${running} sessions running — pick one on the left`
}

/**
 * The directory the current selection scopes to — the Files island's root, and the
 * cwd a new terminal opens in. A selected session owns its own root
 * (`SessionInfo.treeRoot` — the directory the session IS in, so the Claude TUI cd'ing
 * around mid-session never re-roots the scope while a real move to another checkout
 * does; the tab's launch cwd stands in until the tracker reports); with nothing
 * selected, everything scopes to the welcome panel's workspace
 * (O2). A tab with no session of its own has no scope either, and OSC 7 `cd` drift
 * stopped re-rooting anything when the free terminal retired (§9).
 */
export function selectionRoot(
  tab: { kind: TabKind; cwd: string } | undefined,
  sessionRoot: string | undefined,
  welcomePath: string | undefined
): string | null {
  if (tab?.kind === 'claude') return sessionRoot ?? tab.cwd
  return welcomePath ?? null
}

/** Width of the aux pane while its LEFT-edge gutter is dragged (the pane sits right
 *  of the TUI — decided). No automated layer exercises a drag, so a mirrored
 *  sign here survives every suite — this pins the direction and both clamps:
 *  the surface's own floor, ceiling = whatever leaves the TUI ≥360px (+20px chrome) of
 *  the space between dock and pane edge. The floor is per-surface since the Browser
 *  shares this column (session-browser D2) — see auxPaneMin. */
export function paneWidthFromDrag(
  paneRight: number,
  dockRight: number,
  clientX: number,
  floor = 320
): number {
  const ceiling = paneRight - dockRight - 380
  return Math.min(Math.max(floor, paneRight - clientX), ceiling)
}

/** The sessions island's own floor: a note may never squeeze the session list away. */
export const SESSIONS_MIN_HEIGHT = 160

/** D6 — how tall the grip between the two dock islands is. Spelt once, here: the
 *  drag's ceiling has to leave room for it, and App.tsx gives the element its height from
 *  this same number, so the two can never drift apart. */
export const DOCK_GUTTER_PX = 10

/**
 * D6 — how tall the Notes island may be in a dock this tall.
 *
 * The one ceiling rule, spelt once. It is needed twice: while the gutter is dragged, and
 * again on every render, because the height is REMEMBERED. A note dragged to 600px on a
 * big display comes back on a small window where 600px is the whole dock — and the
 * sessions island, being `flex:1`, would give way and vanish. So the saved number is a
 * wish, and this is what the dock can actually grant: the sessions island keeps its floor
 * plus the gutter itself, and the note keeps its own floor even in a window too short for
 * both (a ceiling under the floor is no ceiling at all).
 */
export function clampNotesHeight(
  saved: number,
  dockHeight: number,
  floor = NOTES_HEIGHT_FLOOR
): number {
  const ceiling = Math.max(floor, dockHeight - SESSIONS_MIN_HEIGHT - DOCK_GUTTER_PX)
  return Math.min(Math.max(floor, saved), ceiling)
}

/**
 * D6 — height of the Notes island while the gutter above it is dragged.
 *
 * The note is the BOTTOM island in the dock, so its height is the distance from the
 * cursor down to the dock's foot — pull the gutter up and the note grows. Pinned here
 * for the same reason `paneWidthFromDrag` is: no automated layer drags a gutter, so a
 * mirrored sign would survive every suite. The clamping is `clampNotesHeight`'s, so the
 * drag can never stop at a height a plain render would then refuse.
 */
export function notesHeightFromDrag(
  dockBottom: number,
  dockHeight: number,
  clientY: number,
  floor = NOTES_HEIGHT_FLOOR
): number {
  return clampNotesHeight(dockBottom - clientY, dockHeight, floor)
}
