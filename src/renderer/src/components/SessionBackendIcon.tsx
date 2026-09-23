import { BsClaude, BsOpenai } from 'react-icons/bs'
import type { BackendId } from '@shared/types'
import { backendLabel } from '../agentUi'

export function SessionBackendIcon({
  backend,
  size = 12,
  decorative = false
}: {
  backend?: BackendId
  size?: number
  decorative?: boolean
}) {
  const Icon = backend === 'codex' ? BsOpenai : BsClaude
  if (decorative) return <Icon size={size} aria-hidden="true" />
  return (
    <span
      className="session-backend-icon"
      role="img"
      aria-label={backendLabel(backend)}
      title={backendLabel(backend)}
    >
      <Icon size={size} aria-hidden="true" />
    </span>
  )
}
