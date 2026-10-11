import { useEffect, useState } from 'react'
import type { WorkspaceRows } from '@shared/types'
import { typedSeed, type SessionSeed } from '../newSession'
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
  launchLock,
  seed: initialSeed
}: {
  mode: PickerMode
  initialPath?: string
  rows: WorkspaceRows[]
  onClose: () => void
  onStart: StartSession
  launchLock: { current: boolean }
  seed?: SessionSeed
}) {
  const [worktreePath, setWorktreePath] = useState(initialPath)
  const [seed, setSeed] = useState(initialSeed)
  const lastWsPath = useStore((s) => s.lastWsPath)
  const ws = rows.find((w) => w.workspace.path === worktreePath && !w.workspace.missing)
  const targetGone = !!worktreePath && !ws
  useEffect(() => {
    if (targetGone) onClose()
  }, [targetGone, onClose])
  if (targetGone) return null
  if (mode !== 'main' && ws)
    return (
      <WorktreeSessionDialog
        key={ws.workspace.path}
        ws={ws}
        onClose={onClose}
        onStart={onStart}
        launchLock={launchLock}
        seed={seed}
        onChangeWorkspace={
          seed
            ? (typed) => {
                setSeed(typedSeed(typed))
                setWorktreePath(undefined)
              }
            : undefined
        }
      />
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
        if (mode !== 'main') setWorktreePath(target.workspace.path)
        else await onStart({ cwd: target.workspace.path }, backend)
      }}
    />
  )
}
