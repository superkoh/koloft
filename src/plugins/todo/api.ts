import { fillSlots } from '@core/prompt'
import { pluginStateOf } from '@core/switches'
import type { OldConversationNews } from '@plugins/butler/api'
import { plugin } from './plugin'
import { TODO_NOTICE } from './prompts/text'
import { TODO_METHOD } from './main/method'

export { TODO_NOTICE }

export const todoMethod = (): string => fillSlots(TODO_METHOD)

export const TODO_NEWS: OldConversationNews = {
  knownBy: 'knowsTodo',
  text: () => TODO_NOTICE,
  on: () => pluginStateOf(plugin.id).on
}
