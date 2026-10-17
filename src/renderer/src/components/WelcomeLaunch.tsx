import { useState } from 'react'
import { BACKEND_LABEL } from '@shared/sessionBackend'
import { hostOf } from '@shared/remoteKey'
import type { BackendId } from '@shared/types'
import { SessionLaunchButtons, SessionLaunchStatus, useLaunchChoice } from './SessionLaunchButtons'

export function WelcomeLaunch({
  wsPath,
  onStart
}: {
  wsPath: string
  onStart: (wsPath: string, backend: BackendId) => void
}) {
  const launch = useLaunchChoice(hostOf(wsPath))
  const choice = launch.choice()
  const [listOpen, setListOpen] = useState(false)
  return (
    <>
      <SessionLaunchButtons
        choice={choice}
        open={listOpen}
        onOpen={setListOpen}
        icon={false}
        keyHint={false}
        busy={false}
        disabled={false}
        label={(backend) =>
          `＋ ${choice.listed.length > 1 ? `New ${BACKEND_LABEL[backend]} session` : 'New session'}`
        }
        onStart={(backend) => onStart(wsPath, backend)}
      />
      <SessionLaunchStatus launch={launch} />
    </>
  )
}
