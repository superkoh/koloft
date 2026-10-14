import { LOCAL_MACHINE, type SessionRoute } from '@shared/sessionRoute'
import type { SessionLaunchOptions } from './components/SessionLaunchButtons'
import {
  pendingLaunch,
  pendingWorktree,
  typedLaunch,
  type PendingStart,
  type TypedStart
} from './newSession'
import { remoteKeyFromForm } from './remoteWorkspace'

let lastAsk = 0

export function askRoute(message: string): {
  result: Promise<SessionRoute | null>
  cancel: () => void
} {
  const id = ++lastAsk
  return {
    result: window.api.assist.route(id, message).catch(() => null),
    cancel: () => window.api.assist.cancel(id)
  }
}

export async function pendingOptions(
  ws: { path: string; isGit: boolean },
  pending: PendingStart
): Promise<SessionLaunchOptions> {
  const issue = ws.path === pending.path && pending.worktree?.kind === 'issue'
  const [worktrees, items] = await Promise.all([
    ws.isGit ? window.api.workspace.worktrees(ws.path) : [],
    issue ? window.api.github.openItems(ws.path).catch(() => null) : null
  ])
  const wt = pendingWorktree(ws, pending, worktrees, Date.now())
  return pendingLaunch(
    ws.path,
    wt,
    pending,
    worktrees,
    items?.state === 'items' ? items.issues : []
  )
}

export function projectParentKey(machine: string, where: string): string | null {
  if (machine === LOCAL_MACHINE) return where
  const key = remoteKeyFromForm(machine, where)
  return key.ok ? key.key : null
}

export async function projectOptions(
  parentKey: string,
  name: string,
  typed: TypedStart
): Promise<SessionLaunchOptions> {
  const made = await window.api.workspace.createProject(parentKey, name)
  if (!made.ok) throw new Error(made.reason)
  return { cwd: made.path, ...typedLaunch(typed), trustFolder: true }
}
