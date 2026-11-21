import { LOCAL_MACHINE, type RouteWorktree, type SessionRoute } from '@shared/sessionRoute'
import type { WorkspaceRows } from '@shared/types'
import type { SessionLaunchOptions } from './components/SessionLaunchButtons'
import {
  pendingLaunch,
  pendingWorktree,
  typedLaunch,
  type PendingStart,
  type TypedStart
} from './newSession'
import { remoteKeyFromForm } from './remoteWorkspace'
import { fillsOf } from './pluginUi'
import { ISSUE_LAUNCH } from './slots'

let lastAsk = 0

export interface RouteAsk {
  result: Promise<SessionRoute | null>
  cancel: () => void
}

function cancellableAsk(ask: (id: number) => Promise<SessionRoute | null>): RouteAsk {
  const id = ++lastAsk
  return { result: ask(id).catch(() => null), cancel: () => window.api.assist.cancel(id) }
}

export const pinnedRoute = (path: string, worktree: RouteWorktree | null): SessionRoute => ({
  title: '',
  kind: 'workspace',
  path,
  worktree
})

export const askRoute = (message: string): RouteAsk =>
  cancellableAsk((id) => window.api.assist.route(id, message))

export const askPinnedRoute = (wsPath: string, message: string): RouteAsk =>
  cancellableAsk((id) =>
    window.api.assist
      .nameWorktree(id, message)
      .catch(() => null)
      .then((name) => pinnedRoute(wsPath, name ? { kind: 'new', name } : null))
  )

export async function pendingOptions(
  ws: Pick<WorkspaceRows['workspace'], 'path' | 'isGit'>,
  pending: PendingStart
): Promise<SessionLaunchOptions> {
  const named = ws.path === pending.path ? pending.worktree : null
  const [issueLaunch] = fillsOf(ISSUE_LAUNCH)
  const [worktrees, issueSeed] = await Promise.all([
    ws.isGit ? window.api.sessions.worktrees(ws.path) : [],
    named?.kind === 'issue' && issueLaunch ? issueLaunch(ws.path, named.number) : null
  ])
  const wt = pendingWorktree(named, ws.isGit, Date.now())
  return pendingLaunch(ws.path, wt, pending, worktrees, issueSeed)
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
