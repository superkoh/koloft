// ADR-0051
import type { PluginManifest } from './plugin'

export type SavedSettings = Readonly<Record<string, unknown>>

export interface SettingKey<T> {
  default: T
  clean: (raw: unknown, saved: SavedSettings, handed: readonly unknown[]) => T
  keptOnReset?: true
  writtenByMainOnly?: true
  retires?: readonly string[]
  handsTo?: Readonly<Record<string, (raw: unknown) => readonly unknown[]>>
}

export const setting = <T>(key: SettingKey<T>): SettingKey<T> => key

export type SettingKeys = Readonly<Record<string, SettingKey<unknown>>>

type ValueOf<K> = K extends SettingKey<infer T> ? T : never

type Both<U> = (U extends unknown ? (u: U) => void : never) extends (i: infer I) => void ? I : never

export type SettingValuesOf<L extends Readonly<Record<string, SettingKeys>>> = Both<
  { [P in keyof L]: { [K in keyof L[P]]: ValueOf<L[P][K]> } }[keyof L]
>

export interface RegisteredSettings {
  defaults: Readonly<Record<string, unknown>>
  clean: (saved: SavedSettings) => Record<string, unknown>
  retired: readonly string[]
  keptOnReset: readonly string[]
  writtenByMainOnly: readonly string[]
}

export function registerSettings(
  plugins: readonly PluginManifest[],
  keysByPlugin: Readonly<Record<string, SettingKeys>>
): RegisteredSettings {
  for (const id of Object.keys(keysByPlugin))
    if (!plugins.some((p) => p.id === id))
      throw new Error(`settings are given for "${id}", which is not on the list of plugins`)
  const all: [string, SettingKey<unknown>][] = []
  for (const plugin of plugins) {
    const keys = keysByPlugin[plugin.id] ?? {}
    const declared = plugin.settings?.keys ?? []
    for (const key of Object.keys(keys))
      if (!declared.includes(key))
        throw new Error(
          `plugin ${plugin.id} registers setting "${key}", which its manifest does not list`
        )
    for (const key of declared) {
      const registered = keys[key]
      if (!registered)
        throw new Error(`plugin ${plugin.id} lists setting "${key}" but registers none`)
      if (all.some(([taken]) => taken === key)) throw new Error(`setting "${key}" is listed twice`)
      all.push([key, registered])
    }
  }
  for (const [key, { handsTo }] of all)
    for (const into of Object.keys(handsTo ?? {}))
      if (!all.some(([taken]) => taken === into))
        throw new Error(`setting "${key}" hands records to "${into}", which no plugin registers`)
  const valueIn = (saved: SavedSettings, key: string, fallback: unknown): unknown =>
    Object.hasOwn(saved, key) ? saved[key] : fallback
  const keysWith = (flag: 'keptOnReset' | 'writtenByMainOnly'): string[] =>
    all.filter(([, s]) => s[flag]).map(([key]) => key)
  return {
    defaults: Object.fromEntries(all.map(([key, s]) => [key, s.default])),
    clean: (saved) =>
      Object.fromEntries(
        all.map(([key, s]) => {
          const handed = all.flatMap(
            ([from, f]) => f.handsTo?.[key]?.(valueIn(saved, from, f.default)) ?? []
          )
          return [key, s.clean(valueIn(saved, key, s.default), saved, handed)]
        })
      ),
    retired: all.flatMap(([, s]) => s.retires ?? []),
    keptOnReset: keysWith('keptOnReset'),
    writtenByMainOnly: keysWith('writtenByMainOnly')
  }
}
