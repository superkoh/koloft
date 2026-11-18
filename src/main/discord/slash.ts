import type { SlashReplyTo } from '@plugins/sessions/api'
import { accentOf, CONDUCTOR_ACCENT } from './cards'
import type { DiscordRelay } from './relay'

export const toChannel = (
  channelId: string,
  poster: () => Pick<DiscordRelay, 'say' | 'card'> | null | undefined
): SlashReplyTo => ({
  where: 'post what it prints in Discord',
  say: (text) => poster()?.say(channelId, text),
  result: ({ target, header, body }) =>
    void poster()?.card(channelId, {
      accent: target.butler ? CONDUCTOR_ACCENT : accentOf(target.name),
      header,
      body
    })
})
