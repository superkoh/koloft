import { BACKEND_LABEL } from '@shared/sessionBackend'
import { AGENT_UIS } from '@agents/uis'
import type { BackendId } from '@shared/types'

export function SessionBackendIcon({
  backend,
  size = 12,
  decorative = false
}: {
  backend: BackendId
  size?: number
  decorative?: boolean
}) {
  const Icon = AGENT_UIS.find((ui) => ui.id === backend)!.mark
  if (decorative) return <Icon size={size} aria-hidden="true" />
  return (
    <span
      className="session-backend-icon"
      role="img"
      aria-label={BACKEND_LABEL[backend]}
      title={BACKEND_LABEL[backend]}
    >
      <Icon size={size} aria-hidden="true" />
    </span>
  )
}
