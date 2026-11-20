import { PLUGINS } from '@plugins/list'
import { CORE_HINT_IDS } from '@shared/types'

export const HINT_IDS: readonly string[] = [
  ...CORE_HINT_IDS,
  ...PLUGINS.flatMap((plugin) => plugin.hints ?? [])
]

export function tipNumber(
  seen: readonly string[],
  on: (plugin: string) => boolean
): { n: number; of: number } {
  const uncounted = new Set(PLUGINS.filter((p) => !on(p.id)).flatMap((p) => p.hints ?? []))
  return {
    n: seen.filter((hint) => !uncounted.has(hint)).length + 1,
    of: HINT_IDS.filter((hint) => !uncounted.has(hint)).length
  }
}
