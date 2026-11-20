import {
  isPlaceholderSessionTitle,
  type SessionInfo,
  type SessionRow,
  type WorkspaceRows
} from '@shared/types'
import { parseRemoteKey, remoteCopyText } from '@shared/remoteKey'
import { basename } from '@shared/preview'
import { fail, type Parsed } from '@core/command'

export interface PinnedWorkspace {
  path: string
  missing: boolean
}

export function workspaceLabel(wsPath: string): string {
  const key = parseRemoteKey(wsPath)
  return key ? remoteCopyText(key.host, key.path) : wsPath
}

export interface PlacedRow {
  workspace: string
  shownAs: string
  row: SessionRow
  title: string
  live?: SessionInfo
}

export function placedRows(sidebar: WorkspaceRows[], sessions: SessionInfo[]): PlacedRow[] {
  return sidebar.flatMap((w) =>
    w.rows
      .filter((row) => !row.pending)
      .map((row) => {
        const live = sessions.find((s) => s.alive && s.sessionId === row.id)
        return {
          workspace: w.workspace.path,
          shownAs: w.workspace.claim?.shownAs ?? workspaceLabel(w.workspace.path),
          row,
          title: live?.title && !isPlaceholderSessionTitle(live.title) ? live.title : row.title,
          live
        }
      })
  )
}

export function resolveWorkspace(ref: string, pinned: PinnedWorkspace[]): Parsed<PinnedWorkspace> {
  const hits = pinned.filter(
    (w) => w.path === ref || workspaceLabel(w.path) === ref || basename(w.path) === ref
  )
  const labels = (ws: PinnedWorkspace[]): string =>
    ws.map((w) => `  ${workspaceLabel(w.path)}`).join('\n')
  if (hits.length === 0)
    return fail(
      `there is no workspace "${ref}" in Koloft's sidebar. Give the folder name or full path of one of these:\n${labels(pinned)}`
    )
  if (hits.length > 1)
    return fail(
      `${hits.length} workspaces are named "${ref}". Give the full path:\n${labels(hits)}`
    )
  return { ok: true, value: hits[0] }
}
