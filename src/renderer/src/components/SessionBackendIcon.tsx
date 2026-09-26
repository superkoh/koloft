import { BACKEND_LABEL } from '@shared/sessionBackend'
import { BsClaude, BsOpenai } from 'react-icons/bs'
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
  const Icon = backend === 'codex' ? BsOpenai : BsClaude
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
