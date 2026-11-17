import type { SlashReplyTo } from '@plugins/sessions/main/slashCommands'
import { accentOf, CONDUCTOR_ACCENT, type Card } from './cards'

export interface ChannelPoster {
  say(channelId: string, text: string): void
  card(channelId: string, card: Card): Promise<void>
}

export const toChannel = (
  channelId: string,
  poster: () => ChannelPoster | null | undefined
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
