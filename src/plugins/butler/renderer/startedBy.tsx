import type { JSX } from 'react'
import { IconAssist } from '@renderer/icons'
import { useStore } from '@renderer/store'

export function useStartedByButler(): (parentId: string | undefined) => string | undefined {
  const butlerName = useStore((s) => s.settings.butler.name)
  const butlerKeys = useStore((s) => s.settings.butlerSession.sessionIds)
  return (parentId) => (parentId && butlerKeys?.includes(parentId) ? butlerName : undefined)
}

export const StartedByButler = ({ name }: { name: string }): JSX.Element => (
  <span className="session-backend-icon" title={`started by ${name}`}>
    <IconAssist size={12} />
  </span>
)
