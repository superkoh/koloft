import { useState } from 'react'
import { BACKEND_LABEL } from '@shared/sessionBackend'
import { hostOf } from '@shared/remoteKey'
import type { BackendId } from '@shared/types'
import { InstallHint, NO_AGENT_ON_THIS_MAC } from './AssistSetup'
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
  if (launch.noAgentOnThisMac)
    return launch.answeredSinceMount ? (
      <div className="assist-setup">
        <InstallHint>{NO_AGENT_ON_THIS_MAC}</InstallHint>
      </div>
    ) : null
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
