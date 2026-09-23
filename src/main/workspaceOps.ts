import { type LayoutV4, type ProjectInfo, type SessionWorkbenchState } from '@shared/types'

// Pure workspace-management decisions. IO-free:
// the wiring layer feeds projectInfoFor results and jsonl scans in, so every branch
// is unit-testable (test/unit/workspaceOps.test.ts).

export type WorkspaceAddDecision =
  { code: 'rejected-worktree' } | { code: 'exists'; path: string } | { code: 'added'; path: string }

/** A1: a linked worktree of ANY repo is refused (add the repo root instead); a
 *  subdir normalizes to the repo root via projectInfoFor; re-adding is idempotent. */
export function decideWorkspaceAdd(info: ProjectInfo, existing: string[]): WorkspaceAddDecision {
  if (info.worktreeName) return { code: 'rejected-worktree' }
  if (existing.includes(info.root)) return { code: 'exists', path: info.root }
  return { code: 'added', path: info.root }
}

/** One `git worktree list --porcelain` record; `branch` is absent when the checkout
 *  is detached (C7 shows the name alone then). */
export interface WorktreeEntry {
  dir: string
  branch?: string
}

/** Checkouts from `git worktree list --porcelain`, in porcelain order (first = main
 *  checkout). A bare entry has no working tree for sessions to run in — skip. */
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
      // git marks a checkout whose directory is gone; the remote list has no local
      // dirExists filter to catch it later
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

/** §4: a TUI `/clear` re-inits the SAME pty under a new session id, so the tab's
 *  Workbench structure follows it — `sessions[prevId]`'s {open, tabs} is COPIED onto the
 *  new key. Copying is all this does: the caller pairs it with `dropOwnership(prevId)`
 *  (index.ts's clear branch), and that pair is what makes the panel a MOVE — the old
 *  id leaves the working set with its tab set (the lifecycle contract D2/D13, FR-29). Every other
 *  id change is a session SWITCH — a `/resume` target brings its own entry, or the
 *  default — and carries nothing. Non-mutating; `changed` gates the save. */
export function carrySessionWorkbench(
  sessions: LayoutV4['sessions'],
  prevId: string,
  nextId: string,
  source: string
): { changed: boolean; sessions: LayoutV4['sessions'] } {
  if (source !== 'clear') return { changed: false, sessions }
  const prev = sessions[prevId]
  if (!prev || sessions[nextId]) return { changed: false, sessions }
  // spread the whole entry, never an `{open}` literal: it also holds the session's tab
  // set, and FR-29 is explicit that /clear MOVES that set to the new id rather than
  // dropping it — a copy that took `open` alone would take the user's pages with it
  const carried = { ...prev }
  return { changed: true, sessions: { ...sessions, [nextId]: carried } }
}

/** §7: the panel state a session opens with — its own persisted entry, or (never seen
 *  before) the global `workbench.defaultOpen`. A stored entry is returned as-is:
 *  `open: false` is the user having collapsed the panel for this session, not a missing
 *  value to default. */
export function resolveWorkbenchState(layout: LayoutV4, sessionId: string): SessionWorkbenchState {
  return layout.sessions[sessionId] ?? { open: layout.workbench.defaultOpen, tabs: [] }
}

/** §6: write one session's whole panel state into the `sessions` table. The submitted
 *  state is the WHOLE truth, not a merge — `open` and the tab set are one document now,
 *  and closing the last tab has to be able to empty what is on disk (D8). Validation is
 *  the caller's (`sanitizeSessionWorkbench` at the IPC boundary), not this function's:
 *  it is the same value on both sides of the write. Non-mutating. */
export function withWorkbenchState(
  layout: LayoutV4,
  sessionId: string,
  state: SessionWorkbenchState
): LayoutV4['sessions'] {
  return { ...layout.sessions, [sessionId]: state }
}

/** §6: `sessions` keys are garbage-collected when their jsonl disappears from
 *  Claude's storage. Non-mutating; `changed` gates the save. */
export function gcSessions(
  sessions: LayoutV4['sessions'],
  liveIds: ReadonlySet<string>
): { changed: boolean; sessions: LayoutV4['sessions'] } {
  const kept: LayoutV4['sessions'] = {}
  let changed = false
  for (const [id, entry] of Object.entries(sessions)) {
    if (liveIds.has(id)) kept[id] = entry
    else changed = true
  }
  return { changed, sessions: changed ? kept : sessions }
}
