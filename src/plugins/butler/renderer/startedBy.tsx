import type { JSX } from 'react'
import { IconAssist } from '@renderer/icons'
import { useStore } from '@renderer/store'
import type { MarkOf } from '@renderer/slots'

export function useStartedByButler(): MarkOf {
  const butlerName = useStore((s) => s.settings.butler.name)
  const butlerKeys = useStore((s) => s.settings.butlerSession.sessionIds)
  return (_wsPath, row) =>
    row.parentId && butlerKeys?.includes(row.parentId) ? butlerName : undefined
}

export const StartedByButler = ({ label }: { label: string }): JSX.Element => (
  <span className="session-backend-icon" title={`started by ${label}`}>
    <IconAssist size={12} />
  </span>
)
