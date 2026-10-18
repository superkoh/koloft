import type {
  AttentionEvent,
  SessionInfo,
  SessionRow,
  SessionSearchHit,
  WorkspaceRows
} from '@shared/types'
import { remoteCopyText } from '@shared/remoteKey'
import { shortenHome } from './browseModel'
import { rowLookups, rowsUnder, sessionTree, shownTitle, workspaceName } from './sessionRows'

export interface PaletteSession {
  kind: 'session'
  key: string
  wsPath: string
  row: SessionRow
  title: string
  note: string
  calling: boolean
  text: string
}

export interface PaletteWorkspace {
  kind: 'workspace'
  key: string
  wsPath: string
  name: string
  note: string
}

export interface PaletteAction {
  kind: 'action'
  key: string
  label: string
  keys?: string
  words: string[]
  disabled?: boolean
  run: () => void
}

export interface PaletteHit {
  kind: 'hit'
  key: string
  hit: SessionSearchHit
}

export interface PaletteMoreHits {
  kind: 'more'
  key: string
  count: number
}

export type PaletteItem =
  PaletteSession | PaletteWorkspace | PaletteAction | PaletteHit | PaletteMoreHits

export interface PaletteGroup {
  title: 'Sessions' | 'In conversations' | 'Workspaces' | 'Actions'
  items: PaletteItem[]
}

export const CONVERSATION_HITS_SHOWN = 3

export function matchesQuery(text: string, query: string): boolean {
  const hay = text.toLowerCase()
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => hay.includes(word))
}

export function matchesAction(action: PaletteAction, query: string): boolean {
  const typed = query.toLowerCase()
  return (
    matchesQuery([action.label, ...action.words].join(' '), query) ||
    action.words.some((w) => typed.includes(w.toLowerCase()))
  )
}

function conversationItems(hits: SessionSearchHit[], shown: Set<string>): PaletteItem[] {
  const fresh = hits.filter((h) => h.snippet && !shown.has(h.row.id))
  const items: PaletteItem[] = fresh
    .slice(0, CONVERSATION_HITS_SHOWN)
    .map((hit) => ({ kind: 'hit', key: `h:${hit.row.id}`, hit }))
  if (fresh.length > CONVERSATION_HITS_SHOWN)
    items.push({ kind: 'more', key: 'more-hits', count: hits.length })
  return items
}

export function paletteSessions(
  rows: WorkspaceRows[],
  sessions: readonly SessionInfo[],
  tabs: readonly { id: string; sessionId?: string; alive: boolean }[],
  attention: AttentionEvent[]
): PaletteSession[] {
  const look = rowLookups(sessions, tabs, attention)
  return rows.flatMap(({ workspace: ws, rows: sessionRows }) => {
    const name = workspaceName(ws)
    const place = ws.remote ? `${ws.remote.host}:${name}` : name
    return sessionTree(sessionRows)
      .flatMap((node) => [node.row, ...rowsUnder(node)])
      .map((row): PaletteSession => {
        const tabId = look.tabOf(row)
        const live = tabId ? look.sessionOn(tabId) : undefined
        const title = shownTitle(row.title, live?.title)
        return {
          kind: 'session',
          key: `s:${row.id}`,
          wsPath: ws.path,
          row,
          title,
          note: `${place} · ${row.worktree}`,
          calling: !!look.attentionOn(row.id, tabId),
          text: [title, row.worktree, name, ws.remote?.host ?? ''].join(' ')
        }
      })
  })
}

export function paletteWorkspaces(rows: WorkspaceRows[], home: string): PaletteWorkspace[] {
  return rows
    .filter((w) => !w.workspace.missing)
    .map(({ workspace: ws }) => {
      const name = workspaceName(ws)
      const note = ws.remote
        ? remoteCopyText(ws.remote.host, ws.remote.path)
        : shortenHome(ws.path, home)
      return { kind: 'workspace', key: `w:${ws.path}`, wsPath: ws.path, name, note }
    })
}

export function paletteGroups(
  sessions: PaletteSession[],
  workspaces: PaletteWorkspace[],
  actions: PaletteAction[],
  query: string,
  hits: SessionSearchHit[] = []
): PaletteGroup[] {
  if (!query.trim()) return []
  const matched = sessions.filter((s) => matchesQuery(s.text, query))
  const shown = new Set(matched.map((s) => s.row.id))
  const groups: PaletteGroup[] = [
    { title: 'Sessions', items: matched },
    { title: 'In conversations', items: conversationItems(hits, shown) },
    { title: 'Workspaces', items: workspaces.filter((w) => matchesQuery(w.note, query)) },
    { title: 'Actions', items: actions.filter((a) => matchesAction(a, query)) }
  ]
  return groups.filter((g) => g.items.length > 0)
}
