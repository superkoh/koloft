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
  tag: string
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
  const items = rows
    .filter((w) => !w.workspace.missing)
    .map(({ workspace: ws }): PaletteWorkspace => {
      const name = workspaceName(ws)
      const note = ws.remote
        ? remoteCopyText(ws.remote.host, ws.remote.path)
        : shortenHome(ws.path, home)
      const tag = ws.remote ? `${ws.remote.host}:${name}` : name
      return { kind: 'workspace', key: `w:${ws.path}`, wsPath: ws.path, name, note, tag }
    })
  const shared = (tag: string): boolean => items.filter((w) => w.tag === tag).length > 1
  return items.map((w) => (shared(w.tag) ? { ...w, tag: w.note } : w))
}

export interface MentionTyping {
  start: number
  end: number
  typed: string
}

const startsWord = (text: string, at: number): boolean => at === 0 || /\s/.test(text[at - 1])

export function mentionTyping(text: string, caret: number): MentionTyping | null {
  const start = text.lastIndexOf('@', caret - 1)
  if (start < 0 || start >= caret || !startsWord(text, start)) return null
  const typed = text.slice(start + 1, caret)
  if (/\s/.test(typed)) return null
  const rest = text.slice(caret).search(/\s/)
  return { start, end: rest < 0 ? text.length : caret + rest, typed }
}

export function mentionCandidates(
  workspaces: PaletteWorkspace[],
  typed: string
): PaletteWorkspace[] {
  const t = typed.toLowerCase()
  return workspaces.filter((w) => w.tag.toLowerCase().includes(t))
}

export function completeMention(
  text: string,
  at: MentionTyping,
  tag: string
): { text: string; caret: number } {
  const head = `${text.slice(0, at.start)}@${tag} `
  return { text: head + text.slice(at.end).replace(/^[ \t]/, ''), caret: head.length }
}

export function pinnedWorkspace(
  text: string,
  workspaces: PaletteWorkspace[]
): { wsPath: string; prompt: string } | null {
  const longestFirst = [...workspaces].sort((a, b) => b.tag.length - a.tag.length)
  const lower = text.toLowerCase()
  for (let i = text.indexOf('@'); i >= 0; i = text.indexOf('@', i + 1)) {
    if (!startsWord(text, i)) continue
    const ws = longestFirst.find((w) => {
      const end = i + 1 + w.tag.length
      return (
        lower.startsWith(w.tag.toLowerCase(), i + 1) &&
        (end === text.length || /\s/.test(text[end]))
      )
    })
    if (ws) {
      const before = text.slice(0, i).replace(/[ \t]+$/, '')
      const after = text.slice(i + 1 + ws.tag.length).replace(/^[ \t]+/, '')
      const joined = /(^|\n)$/.test(before) || /^(\n|$)/.test(after)
      return { wsPath: ws.wsPath, prompt: (before + (joined ? '' : ' ') + after).trim() }
    }
  }
  return null
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
