import type { WorkspaceRows } from '@shared/types'
import { basename } from '@shared/preview'
import {
  LOCAL_MACHINE,
  parseRoute,
  routeJob,
  type RouteWorkspace,
  type SessionRoute
} from '@shared/sessionRoute'

let lastAsk = 0

async function routeWorkspaces(rows: WorkspaceRows[]): Promise<RouteWorkspace[]> {
  return Promise.all(
    rows
      .filter((w) => !w.workspace.missing)
      .map(async ({ workspace: ws, rows: sessions }) => ({
        path: ws.path,
        machine: ws.remote?.host ?? LOCAL_MACHINE,
        name: basename(ws.remote?.path ?? ws.path),
        git: ws.isGit,
        worktrees: ws.isGit
          ? (await window.api.workspace.worktrees(ws.path).catch(() => [])).map((w) => w.name)
          : [],
        titles: [...sessions].sort((a, b) => b.mtime - a.mtime).map((r) => r.title)
      }))
  )
}

export function askRoute(
  rows: WorkspaceRows[],
  message: string
): { result: Promise<SessionRoute | null>; cancel: () => void } {
  const id = ++lastAsk
  let cancelled = false
  const result = routeWorkspaces(rows).then(async (list) => {
    if (cancelled) return null
    const job = routeJob(list, message)
    return parseRoute(await window.api.assist.ask(id, job.system, job.prompt), list)
  })
  return {
    result,
    cancel: () => {
      cancelled = true
      window.api.assist.cancel(id)
    }
  }
}
