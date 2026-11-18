import type { ButlerRowEntry } from '@plugins/butler/api'
import { channelLabel } from '../shared/channels'
import { useStore } from '@renderer/store'

const NOT_ON_DISCORD = 'not on Discord'

export function useDiscordOnButlerRow(): { menu: ButlerRowEntry[]; where: string } {
  const channel = useStore((s) => s.settings.discord.channel)
  const setBindButler = useStore((s) => s.setBindButler)
  const bind = (): void => setBindButler(true)
  if (!channel)
    return { menu: [{ label: 'Bind Discord channel…', run: bind }], where: NOT_ON_DISCORD }
  return {
    menu: [
      { label: 'Change Discord channel…', run: bind },
      { label: 'Unbind Discord', run: () => void window.api.conductors.unbind(), danger: true }
    ],
    where: channelLabel(channel)
  }
}
