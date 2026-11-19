import { pluginStateOf } from '@core/switches'
import type { OldConversationNews } from '@plugins/butler/api'
import { plugin } from './plugin'
import { TODO_NOTICE } from './prompts/text'

export { TODO_NOTICE }
export { TODO_METHOD } from './main/method'

export const TODO_NEWS: OldConversationNews = {
  knownBy: 'knowsTodo',
  text: TODO_NOTICE,
  on: () => pluginStateOf(plugin.id).on
}
