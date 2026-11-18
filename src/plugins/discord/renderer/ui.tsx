import { BsDiscord } from 'react-icons/bs'
import { fill, type PluginUi } from '@core/ui'
import { PALETTE_ROUTE, ROW_EXTRAS, ROW_SET_UP, SETTINGS_PAGE_ICON } from '@renderer/slots'
import { DISCORD_BIND, DISCORD_PAGE } from '../plugin'
import { BindConductorDialog } from './BindConductorDialog'
import { DiscordPane } from './DiscordPane'
import { useDiscordOnButlerRow } from './onButlerRow'
import { setUpDiscordWithButler } from './setUpWithButler'

const THE_BUTLERS_ROW = 'butler-row'
const SET_UP_DISCORD_ROUTE = 'discord'

export const ui: PluginUi = {
  parts: { [DISCORD_BIND]: BindConductorDialog, [DISCORD_PAGE]: DiscordPane },
  fills: [
    fill(ROW_EXTRAS, { row: THE_BUTLERS_ROW, useExtras: useDiscordOnButlerRow }),
    fill(ROW_SET_UP, { row: THE_BUTLERS_ROW, setUp: (settings) => !!settings.discord.channel }),
    fill(SETTINGS_PAGE_ICON, { page: DISCORD_PAGE, Icon: BsDiscord }),
    fill(PALETTE_ROUTE, { kind: SET_UP_DISCORD_ROUTE, run: setUpDiscordWithButler })
  ]
}
