// ADR-0051
import type { ComponentType } from 'react'
import type { PluginManifest, UiPlace } from './plugin'

export type UiParts = Readonly<Record<string, ComponentType>>

export interface PlacedPart {
  id: string
  Part: ComponentType
}

export type PlacedUi = Readonly<Partial<Record<UiPlace, readonly PlacedPart[]>>>

export function placeUi(
  plugins: readonly PluginManifest[],
  partsByPlugin: Readonly<Record<string, UiParts>>
): PlacedUi {
  for (const id of Object.keys(partsByPlugin))
    if (!plugins.some((p) => p.id === id))
      throw new Error(`UI parts are given for "${id}", which is not on the list of plugins`)
  const placed: Partial<Record<UiPlace, PlacedPart[]>> = {}
  const taken = new Set<string>()
  for (const plugin of plugins) {
    const parts = partsByPlugin[plugin.id] ?? {}
    const declared = plugin.ui ?? []
    for (const id of Object.keys(parts))
      if (!declared.some((entry) => entry.id === id))
        throw new Error(`plugin ${plugin.id} registers "${id}", which its manifest does not list`)
    for (const { place, id } of declared) {
      const Part = parts[id]
      if (!Part) throw new Error(`plugin ${plugin.id} lists "${id}" but registers no part for it`)
      if (taken.has(id)) throw new Error(`"${id}" is listed twice`)
      taken.add(id)
      ;(placed[place] ??= []).push({ id, Part })
    }
  }
  return placed
}
