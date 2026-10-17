import { BACKEND_LABEL } from '@shared/sessionBackend'
import { BsClaude, BsMeta, BsOpenai } from 'react-icons/bs'
import { SiGooglegemini } from 'react-icons/si'
import type { BackendId } from '@shared/types'
import type { IconType } from 'react-icons'

const ICON: Record<BackendId, IconType> = {
  claude: BsClaude,
  codex: BsOpenai,
  muse: BsMeta,
  agy: SiGooglegemini
}

export function SessionBackendIcon({
  backend,
  size = 12,
  decorative = false
}: {
  backend: BackendId
  size?: number
  decorative?: boolean
}) {
  const Icon = ICON[backend]
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
