import { PLUGINS } from '@plugins/list'
import { CORE_HINT_IDS } from '@shared/types'

export const HINT_IDS: readonly string[] = [
  ...CORE_HINT_IDS,
  ...PLUGINS.flatMap((plugin) => plugin.hints ?? [])
]
