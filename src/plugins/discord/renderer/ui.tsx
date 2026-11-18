import { BsDiscord } from 'react-icons/bs'
import { fill, type PluginUi } from '@core/ui'
import { ROW_EXTRAS, SETTINGS_PAGE_ICON } from '@renderer/slots'
import { DISCORD_BIND, DISCORD_PAGE } from '../plugin'
import { BindConductorDialog } from './BindConductorDialog'
import { DiscordPane } from './DiscordPane'
import { useDiscordOnButlerRow } from './onButlerRow'

const THE_BUTLERS_ROW = 'butler-row'

export const ui: PluginUi = {
  parts: { [DISCORD_BIND]: BindConductorDialog, [DISCORD_PAGE]: DiscordPane },
  fills: [
    fill(ROW_EXTRAS, { row: THE_BUTLERS_ROW, useExtras: useDiscordOnButlerRow }),
    fill(SETTINGS_PAGE_ICON, { page: DISCORD_PAGE, Icon: BsDiscord })
  ]
}
