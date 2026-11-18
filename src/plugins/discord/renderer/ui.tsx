import { fill, type PluginUi } from '@core/ui'
import { ROW_EXTRAS } from '@renderer/slots'
import { DISCORD_BIND } from '../plugin'
import { BindConductorDialog } from './BindConductorDialog'
import { useDiscordOnButlerRow } from './onButlerRow'

const THE_BUTLERS_ROW = 'butler-row'

export const ui: PluginUi = {
  parts: { [DISCORD_BIND]: BindConductorDialog },
  fills: [fill(ROW_EXTRAS, { row: THE_BUTLERS_ROW, useExtras: useDiscordOnButlerRow })]
}
