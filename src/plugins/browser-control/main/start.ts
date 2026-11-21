import type { PluginStart } from '@core/pluginStart'
import { CdpOps, type CdpOpsDeps } from './cdpOps'
import {
  cdpEnvDir,
  guestDrivenFromAnotherMachine,
  notePageOpenedForAMachine,
  originDrivenFromAnotherMachine,
  relayAttached,
  relayClientEvicted,
  relayEndpoint,
  relayEndpointOnMachine,
  relayStripChanged,
  relayTabRebound,
  renewRelayEndpointOnMachine,
  sessionDrivingGuest,
  setRelayEnabled,
  startRelay,
  writeRelayEnv
} from './cdpRelay'
import { registerChannels } from './channels'
import { closeEachStoppingTabsEndpoint } from './sessionHooks'

export interface BrowserControlStartDeps {
  cdpOps: Omit<CdpOpsDeps, 'push'>
}

const relay = {
  cdpEnvDir,
  guestDrivenFromAnotherMachine,
  notePageOpenedForAMachine,
  originDrivenFromAnotherMachine,
  relayAttached,
  relayClientEvicted,
  relayEndpoint,
  relayEndpointOnMachine,
  relayTabRebound,
  renewRelayEndpointOnMachine,
  sessionDrivingGuest,
  setRelayEnabled,
  startRelay,
  writeRelayEnv
}

export const start: PluginStart<BrowserControlStartDeps, typeof relay & { cdpOps: CdpOps }> = (
  { moments, ipc },
  d
) => {
  const cdpOps = new CdpOps({ ...d.cdpOps, push: ipc.push })
  closeEachStoppingTabsEndpoint(moments)
  registerChannels(ipc, { cdpOps, stripChanged: relayStripChanged })
  return { ...relay, cdpOps }
}
