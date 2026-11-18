// ADR-0051
import type { PluginManifest } from './plugin'

export type SavedSettings = Readonly<Record<string, unknown>>

type HandOver = (raw: unknown) => readonly unknown[]

export interface SettingKey<T> {
  default: T
  clean: (raw: unknown, handed: readonly unknown[]) => T
  keptOnReset?: true
  writtenByMainOnly?: true
  retires?: Readonly<Record<string, HandOver>>
  handsTo?: Readonly<Record<string, HandOver>>
}

export const setting = <T>(key: SettingKey<T>): SettingKey<T> => key

export type SettingKeys = Readonly<Record<string, SettingKey<unknown>>>

export type SettingValues<K extends SettingKeys> = {
  [P in keyof K]: K[P] extends SettingKey<infer T> ? T : never
}

interface Owned {
  plugin: PluginManifest
  key: SettingKey<unknown>
}

export function registerSettings(
  plugins: readonly PluginManifest[],
  keysByPlugin: Readonly<Record<string, SettingKeys>>
) {
  for (const id of Object.keys(keysByPlugin))
    if (!plugins.some((p) => p.id === id))
      throw new Error(`settings are given for "${id}", which is not on the list of plugins`)
  const owned = new Map<string, Owned>()
  for (const plugin of plugins) {
    const keys = keysByPlugin[plugin.id] ?? {}
    const declared = plugin.settings?.keys ?? []
    for (const name of Object.keys(keys))
      if (!declared.includes(name))
        throw new Error(
          `plugin ${plugin.id} registers setting "${name}", which its manifest does not list`
        )
    for (const name of declared) {
      const key = keys[name]
      if (!key) throw new Error(`plugin ${plugin.id} lists setting "${name}" but registers none`)
      if (owned.has(name)) throw new Error(`setting "${name}" is listed twice`)
      owned.set(name, { plugin, key })
    }
  }
  for (const [name, { plugin, key }] of owned)
    for (const into of Object.keys(key.handsTo ?? {})) {
      const owner = owned.get(into)?.plugin
      if (!owner)
        throw new Error(`setting "${name}" hands records to "${into}", which no plugin registers`)
      if (owner !== plugin && !plugin.needs.includes(owner.id))
        throw new Error(
          `setting "${name}" hands records to "${into}" of plugin ${owner.id}, which plugin ${plugin.id} does not need`
        )
    }
  const entries = [...owned].map(([name, { key }]) => [name, key] as const)
  const valueIn = (saved: SavedSettings, name: string, key: SettingKey<unknown>): unknown =>
    Object.hasOwn(saved, name) ? saved[name] : key.default
  return {
    defaults: Object.fromEntries(entries.map(([name, key]) => [name, key.default])),
    clean: (saved: SavedSettings): Record<string, unknown> => {
      const handed = new Map<string, unknown[]>(
        entries.map(([name, key]) => [
          name,
          Object.entries(key.retires ?? {}).flatMap(([old, hand]) => hand(saved[old]))
        ])
      )
      for (const [name, key] of entries)
        for (const [into, hand] of Object.entries(key.handsTo ?? {}))
          handed.get(into)!.push(...hand(valueIn(saved, name, key)))
      return Object.fromEntries(
        entries.map(([name, key]) => [
          name,
          key.clean(valueIn(saved, name, key), handed.get(name)!)
        ])
      )
    },
    retired: entries.flatMap(([, key]) => Object.keys(key.retires ?? {})),
    keptOnReset: entries.filter(([, key]) => key.keptOnReset).map(([name]) => name),
    writtenByMainOnly: entries.filter(([, key]) => key.writtenByMainOnly).map(([name]) => name)
  }
}
