import { PLUGINS } from '@plugins/list'
import { CORE_HINT_IDS } from '@shared/types'

export const HINT_IDS: readonly string[] = [
  ...CORE_HINT_IDS,
  ...PLUGINS.flatMap((plugin) => plugin.hints ?? [])
]

export function hintOn(hint: string, on: (plugin: string) => boolean): boolean {
  const owner = PLUGINS.find((plugin) => plugin.hints?.includes(hint))
  return !owner || on(owner.id)
}

export function tipNumber(
  seen: readonly string[],
  on: (plugin: string) => boolean
): { n: number; of: number } {
  const counted = new Set(HINT_IDS.filter((hint) => hintOn(hint, on)))
  return { n: seen.filter((hint) => counted.has(hint)).length + 1, of: counted.size }
}
