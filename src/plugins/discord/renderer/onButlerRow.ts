import type { RowExtras } from '@renderer/slots'
import { channelLabel } from '../shared/channels'
import { useStore } from '@renderer/store'
import { openBinding } from './state'

const NOT_ON_DISCORD = 'not on Discord'

export function useDiscordOnButlerRow(): RowExtras {
  const channel = useStore((s) => s.settings.discord.channel)
  const bind = (): void => openBinding(true)
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
