import { type LayoutV6, type ProjectInfo, type SessionWorkbenchState } from '@shared/types'

export type WorkspaceAddDecision =
  { code: 'rejected-worktree' } | { code: 'exists'; path: string } | { code: 'added'; path: string }

export function decideWorkspaceAdd(info: ProjectInfo, existing: string[]): WorkspaceAddDecision {
  if (info.worktreeName) return { code: 'rejected-worktree' }
  if (existing.includes(info.root)) return { code: 'exists', path: info.root }
  return { code: 'added', path: info.root }
}

export interface WorktreeEntry {
  dir: string
  branch?: string
}

export function parseWorktreeEntries(text: string): WorktreeEntry[] {
  const out: WorktreeEntry[] = []
  let current: WorktreeEntry | null = null
  let bare = false
  let gone = false
  const flush = (): void => {
    if (current && !bare && !gone) out.push(current)
    current = null
    bare = false
    gone = false
  }
  for (const line of text.split('\n')) {
    if (line.startsWith('worktree ')) {
      flush()
      current = { dir: line.slice('worktree '.length) }
    } else if (line === 'bare') {
      bare = true
    } else if (line === 'prunable' || line.startsWith('prunable ')) {
      gone = true
    } else if (line.startsWith('branch ') && current) {
      current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '')
    } else if (line === '') {
      flush()
    }
  }
  flush()
  return out
}

// CC§1
export function carrySessionWorkbench(
  sessions: LayoutV6['panels'],
  prevId: string,
  nextId: string,
  source: string
): { changed: boolean; sessions: LayoutV6['panels'] } {
  if (source !== 'clear') return { changed: false, sessions }
  const prev = sessions[prevId]
  if (!prev || sessions[nextId]) return { changed: false, sessions }
  const carried = { ...prev }
  return { changed: true, sessions: { ...sessions, [nextId]: carried } }
}

export function resolveWorkbenchState(layout: LayoutV6, sessionId: string): SessionWorkbenchState {
  return layout.panels[sessionId] ?? { open: layout.workbench.defaultOpen, tabs: [] }
}

export function withWorkbenchState(
  layout: LayoutV6,
  sessionId: string,
  state: SessionWorkbenchState
): LayoutV6['panels'] {
  return { ...layout.panels, [sessionId]: state }
}

export function gcSessions(
  sessions: LayoutV6['panels'],
  liveIds: ReadonlySet<string>
): { changed: boolean; sessions: LayoutV6['panels'] } {
  const kept: LayoutV6['panels'] = {}
  let changed = false
  for (const [id, entry] of Object.entries(sessions)) {
    if (liveIds.has(id)) kept[id] = entry
    else changed = true
  }
  return { changed, sessions: changed ? kept : sessions }
}
