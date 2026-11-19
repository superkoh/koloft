import { pluginStateOf } from '@core/switches'
import { plugin } from '../plugin'

export const discordOn = (): boolean => pluginStateOf(plugin.id).on

export const DISCORD_TURNED_OFF = '⏹ Discord was turned off in Koloft.'

type Switches = Readonly<Record<string, boolean>>

export const withDiscordOn = (pluginsOn: Switches): Record<string, boolean> => ({
  ...pluginsOn,
  [plugin.id]: true
})

export function switchedOnOnceItHasABot(
  hasABot: boolean,
  pluginsOn: Switches
): Record<string, boolean> | null {
  return !hasABot || Object.hasOwn(pluginsOn, plugin.id) ? null : withDiscordOn(pluginsOn)
}
