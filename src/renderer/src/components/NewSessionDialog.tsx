import { useEffect, useState } from 'react'
import type { WorkspaceRows } from '@shared/types'
import type { PickerMode } from '../workspacePicker'
import { useStore } from '../store'
import { WorkspacePicker } from './WorkspacePicker'
import { WorktreeSessionDialog } from './WorktreeSessionDialog'
import type { StartSession } from './SessionLaunchButtons'

export function NewSessionDialog({
  mode,
  initialPath,
  rows,
  onClose,
  onStart,
  launchLock
}: {
  mode: PickerMode
  initialPath?: string
  rows: WorkspaceRows[]
  onClose: () => void
  onStart: StartSession
  launchLock: { current: boolean }
}) {
  const [worktreePath, setWorktreePath] = useState(initialPath)
  const lastWsPath = useStore((s) => s.lastWsPath)
  const ws = rows.find((w) => w.workspace.path === worktreePath && !w.workspace.missing)
  const targetGone = !!worktreePath && !ws
  useEffect(() => {
    if (targetGone) onClose()
  }, [targetGone, onClose])
  if (targetGone) return null
  if (mode === 'worktree' && ws)
    return (
      <WorktreeSessionDialog ws={ws} onClose={onClose} onStart={onStart} launchLock={launchLock} />
    )
  return (
    <WorkspacePicker
      mode={mode}
      rows={rows}
      lastWsPath={lastWsPath}
      pinned={mode === 'main' ? ws : undefined}
      onClose={onClose}
      launchLock={launchLock}
      onConfirm={async (target, backend) => {
        if (mode === 'worktree') setWorktreePath(target.workspace.path)
        else await onStart({ cwd: target.workspace.path }, backend)
      }}
    />
  )
}
