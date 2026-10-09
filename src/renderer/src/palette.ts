import type { AttentionEvent, SessionInfo, SessionRow, WorkspaceRows } from '@shared/types'
import { remoteCopyText } from '@shared/remoteKey'
import { shortenHome } from './browseModel'
import {
  attentionOnRow,
  rowsUnder,
  sessionTree,
  shownTitle,
  tabOfRow,
  workspaceName
} from './sessionRows'

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
  disabled?: boolean
  run: () => void
}

export type PaletteItem = PaletteSession | PaletteWorkspace | PaletteAction

export interface PaletteGroup {
  title: 'Sessions' | 'Workspaces' | 'Actions'
  items: PaletteItem[]
}

export function matchesQuery(text: string, query: string): boolean {
  const hay = text.toLowerCase()
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => hay.includes(word))
}

export function paletteSessions(
  rows: WorkspaceRows[],
  sessions: readonly SessionInfo[],
  tabs: readonly { id: string; sessionId?: string; alive: boolean }[],
  attention: AttentionEvent[]
): PaletteSession[] {
  return rows.flatMap(({ workspace: ws, rows: sessionRows }) => {
    const name = workspaceName(ws)
    const place = ws.remote ? `${ws.remote.host}:${name}` : name
    return sessionTree(sessionRows)
      .flatMap((node) => [node.row, ...rowsUnder(node)])
      .map((row): PaletteSession => {
        const tabId = tabOfRow(row, sessions, tabs)
        const live = tabId ? sessions.find((s) => s.tabId === tabId) : undefined
        const title = shownTitle(row.title, live?.title)
        return {
          kind: 'session',
          key: `s:${row.id}`,
          wsPath: ws.path,
          row,
          title,
          note: `${place} · ${row.worktree}`,
          calling: !!attentionOnRow(row.id, tabId, attention),
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
  query: string
): PaletteGroup[] {
  const groups: PaletteGroup[] = [
    { title: 'Sessions', items: sessions.filter((s) => matchesQuery(s.text, query)) },
    { title: 'Workspaces', items: workspaces.filter((w) => matchesQuery(w.note, query)) },
    { title: 'Actions', items: actions.filter((a) => matchesQuery(a.label, query)) }
  ]
  return groups.filter((g) => g.items.length > 0)
}
