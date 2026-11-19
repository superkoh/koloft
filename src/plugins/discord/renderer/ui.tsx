import { fill, type PluginUi } from '@core/ui'
import { PALETTE_ROUTE, PLUGIN_SET_UP, ROW_EXTRAS, ROW_SET_UP } from '@renderer/slots'
import { DISCORD_BIND, DISCORD_PAGE, plugin } from '../plugin'
import { useStore } from '@renderer/store'
import { setUpWith } from '../shared/channels'
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
    fill(PLUGIN_SET_UP, {
      plugin: plugin.id,
      useLabel: () => setUpWith(useStore((s) => s.settings.butler.name)),
      run: () => setUpDiscordWithButler()
    }),
    fill(PALETTE_ROUTE, { kind: SET_UP_DISCORD_ROUTE, run: setUpDiscordWithButler })
  ]
}
