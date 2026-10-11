import { LOCAL_MACHINE, type SessionRoute } from '@shared/sessionRoute'
import {
  pendingLaunch,
  typedLaunch,
  type PendingLaunch,
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
  wsPath: string,
  pending: PendingStart
): Promise<PendingLaunch> {
  const wt = wsPath === pending.path ? pending.worktree : null
  const [worktrees, items] = await Promise.all([
    wt && wt.kind !== 'main' ? window.api.workspace.worktrees(wsPath) : [],
    wt?.kind === 'issue' ? window.api.github.openItems(wsPath).catch(() => null) : null
  ])
  return pendingLaunch(wsPath, pending, worktrees, items?.state === 'items' ? items.issues : [])
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
): Promise<PendingLaunch> {
  const made = await window.api.workspace.createProject(parentKey, name)
  if (!made.ok) throw new Error(made.reason)
  return { cwd: made.path, ...typedLaunch(typed), trustFolder: true }
}
