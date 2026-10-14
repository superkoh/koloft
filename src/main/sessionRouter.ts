import path from 'path'
import type { WorkspaceRows, WorktreeInfo } from '@shared/types'
import {
  LOCAL_MACHINE,
  parseRoute,
  routeJob,
  type RouteWorkspace,
  type SessionRoute
} from '@shared/sessionRoute'
import type { Assist } from './assist'

export interface SessionRouterDeps {
  rows(): WorkspaceRows[]
  worktrees(wsPath: string): Promise<WorktreeInfo[]>
  assist: Assist
}

export async function routeSession(
  deps: SessionRouterDeps,
  message: string,
  signal: AbortSignal
): Promise<SessionRoute | null> {
  const list: RouteWorkspace[] = await Promise.all(
    deps
      .rows()
      .filter((w) => !w.workspace.missing)
      .map(async ({ workspace: ws, rows }) => ({
        path: ws.path,
        machine: ws.remote?.host ?? LOCAL_MACHINE,
        name: path.basename(ws.remote?.path ?? ws.path),
        git: ws.isGit,
        worktrees: ws.isGit
          ? (await deps.worktrees(ws.path).catch(() => []))
              .filter((w) => !w.recoveryResourceId)
              .map((w) => w.name)
          : [],
        sessions: [...rows]
          .sort((a, b) => b.mtime - a.mtime)
          .map((r) => ({ id: r.id, title: r.title }))
      }))
  )
  if (signal.aborted) return null
  return parseRoute(await deps.assist({ ...routeJob(list, message), signal }), list)
}
