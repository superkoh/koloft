import type { MadeLater } from '@core/moment'
import type { BuildLater, PluginStart } from '@core/pluginStart'
import { AwayDigest, type AwayDigestDeps } from './awayDigest'
import { Butler, type ButlerDeps } from './butler'
import { registerChannels } from './channels'
import { OwnerAsleep, type OwnerAsleepDeps } from './ownerAsleep'
import {
  butlerFollowsEachTurn,
  butlerLetsGoOfEndedTabs,
  tellEachHelperItsRole
} from './sessionHooks'

export interface ButlerStartDeps {
  helperRole: Parameters<typeof tellEachHelperItsRole>[1]
  eachTurn: Omit<Parameters<typeof butlerFollowsEachTurn>[1], 'butler' | 'digest' | 'asleep'>
  channels: Parameters<typeof registerChannels>[1]
  asleep: OwnerAsleepDeps
}

export const start: PluginStart<
  ButlerStartDeps,
  {
    buildButler: BuildLater<ButlerDeps, Butler>
    buildDigest: BuildLater<AwayDigestDeps, AwayDigest>
    ownerAsleep: OwnerAsleep
  }
> = ({ moments, ipc }, d) => {
  let butler: Butler | null = null
  let digest: AwayDigest | null = null
  const butlerBuilt: MadeLater<Butler> = () => butler
  const digestBuilt: MadeLater<AwayDigest> = () => digest
  const ownerAsleep = new OwnerAsleep(d.asleep)
  tellEachHelperItsRole(moments, d.helperRole)
  butlerFollowsEachTurn(moments, {
    ...d.eachTurn,
    butler: butlerBuilt,
    digest: digestBuilt,
    asleep: ownerAsleep
  })
  butlerLetsGoOfEndedTabs(moments, { butler: butlerBuilt, digest: digestBuilt })
  registerChannels(ipc, d.channels)
  return {
    buildButler: (deps) => (butler = new Butler(deps)),
    buildDigest: (deps) => (digest = new AwayDigest(deps)),
    ownerAsleep
  }
}
