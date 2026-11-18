import { fill, type PluginUi } from '@core/ui'
import { PALETTE_ROUTE, ROW_EXTRAS } from '@renderer/slots'
import { DISCORD_BIND } from '../plugin'
import { BindConductorDialog } from './BindConductorDialog'
import { useDiscordOnButlerRow } from './onButlerRow'
import { setUpDiscordWithButler } from './setUpWithButler'

const THE_BUTLERS_ROW = 'butler-row'
const SET_UP_DISCORD_ROUTE = 'discord'

export const ui: PluginUi = {
  parts: { [DISCORD_BIND]: BindConductorDialog },
  fills: [
    fill(ROW_EXTRAS, { row: THE_BUTLERS_ROW, useExtras: useDiscordOnButlerRow }),
    fill(PALETTE_ROUTE, { kind: SET_UP_DISCORD_ROUTE, run: setUpDiscordWithButler })
  ]
}
