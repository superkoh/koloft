import { fill, type PluginUi } from '@core/ui'
import { OWNER_ASKS } from '@renderer/slots'
import { useAsked, usePageAsk, useSudoOverTerminal, useTappedGuests } from './SecretAsk'
import { useWatchSecretAsks } from './state'

export const ui: PluginUi = {
  fills: [
    fill(OWNER_ASKS, {
      useWatch: useWatchSecretAsks,
      useAsked,
      useOverTerminal: useSudoOverTerminal,
      usePageAsk,
      useHeldGuests: useTappedGuests
    })
  ]
}
