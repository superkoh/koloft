import { BACKEND_LABEL } from '@shared/sessionBackend'
import { BsClaude, BsMeta, BsOpenai } from 'react-icons/bs'
import { GenIcon } from 'react-icons'
import type { BackendId } from '@shared/types'
import type { IconType } from 'react-icons'

const AntigravityMark: IconType = GenIcon({
  tag: 'svg',
  attr: { viewBox: '0 0 24 24', fill: 'currentColor' },
  child: [
    {
      tag: 'path',
      attr: {
        d: 'M21.751 22.607c1.34 1.005 3.35.335 1.508-1.508C17.73 15.74 18.904 1 12.037 1 5.17 1 6.342 15.74.815 21.1c-2.01 2.009.167 2.511 1.507 1.506 5.192-3.517 4.857-9.714 9.715-9.714 4.857 0 4.522 6.197 9.714 9.715z'
      },
      child: []
    }
  ]
})

const ICON: Record<BackendId, IconType> = {
  claude: BsClaude,
  codex: BsOpenai,
  muse: BsMeta,
  agy: AntigravityMark
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
