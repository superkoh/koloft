import { plugin } from '../plugin'
import type { DiscordPhase } from '../shared/types'

export function switchedOnOnceItHasABot(
  phase: DiscordPhase,
  pluginsOn: Readonly<Record<string, boolean>>
): Record<string, boolean> | null {
  return phase === 'off' || Object.hasOwn(pluginsOn, plugin.id)
    ? null
    : { ...pluginsOn, [plugin.id]: true }
}
